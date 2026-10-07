#pragma once

inline juce::var checkProjectSpanAlignment()
{
    auto* result=new juce::DynamicObject();bool capture=true,weak=true,strong=true,rejections=true,bounded=true;
    double maximumLagError=0;juce::Array<juce::var> cases;
    const auto signal=[](juce::int64 sample){auto value=static_cast<juce::uint32>(sample);value^=value>>16;value*=0x7feb352dU;value^=value>>15;value*=0x846ca68bU;value^=value>>16;return (static_cast<float>(value&65535)/65535.0f-.5f)*.2f;};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const int window=juce::jlimit(4096,BuiltInAlignmentCapture::capacity,juce::roundToInt(rate*.5));const auto span=static_cast<juce::int64>(rate*9);
        BuiltInAlignmentCapture a,b;a.prepare(rate);b.prepare(rate);capture=capture&&a.armSpan(19,span,window,rate)&&b.armSpan(19,span,window,rate);
        const auto* storage=a.audio[0].data();juce::AudioBuffer<float> source(2,511),target(2,511);
        for(juce::int64 position=0;position<span+19;)
        {
            const int count=static_cast<int>(juce::jmin<juce::int64>(position%2?127:511,span+19-position));source.setSize(2,count,false,false,true);target.setSize(2,count,false,false,true);
            for(int i=0;i<count;++i){const float value=signal(position+i),shared=-signal(position+i-37)*.25f+signal(position+i+9876543);for(int ch=0;ch<2;++ch){source.setSample(ch,i,value);target.setSample(ch,i,shared);}}
            a.process(source,position,true);b.process(target,position,true);position+=count;
        }
        capture=capture&&a.state.load()==2&&b.state.load()==2&&a.progress()==1&&storage==a.audio[0].data();
        bounded=bounded&&a.size()==window*16&&a.audio[0].capacity()<=static_cast<size_t>(window*16);
        for(int section=0;section<16;++section)for(int i=0;i<window;++i)capture=capture&&a.audio[0][static_cast<size_t>(section*window+i)]==signal(19+(span-window)*section/15+i);
        const auto estimated=estimateBuiltInAlignmentSpan(a.audio[0].data(),b.audio[0].data(),a.size(),true);
        const auto strict=estimateBuiltInAlignmentSpan(a.audio[0].data(),b.audio[0].data(),a.size(),false);
        weak=weak&&estimated.combined.accepted&&estimated.combined.invert&&estimated.qualified==16&&!strict.combined.accepted;
        maximumLagError=juce::jmax(maximumLagError,std::abs(estimated.combined.lag-37));
        std::vector<float> reference=a.audio[0],changed(reference.size());
        for(int section=0;section<16;++section)for(int i=0;i<window;++i)changed[static_cast<size_t>(section*window+i)]=-signal(19+(span-window)*section/15+i-37);
        strong=strong&&estimateBuiltInAlignmentSpan(reference.data(),changed.data(),a.size(),false).combined.accepted;
        std::fill(reference.begin(),reference.begin()+window*4,0.0f);std::fill(changed.begin(),changed.begin()+window*4,0.0f);
        const auto silent=estimateBuiltInAlignmentSpan(reference.data(),changed.data(),a.size(),false);strong=strong&&silent.combined.accepted&&silent.measurable==12;
        for(int i=0;i<window;++i)changed[static_cast<size_t>(15*window+i)]=-signal(19+(span-window)+i-42);
        rejections=rejections&&!estimateBuiltInAlignmentSpan(reference.data(),changed.data(),a.size(),true).combined.accepted;
        for(size_t i=0;i<reference.size();++i){reference[i]=signal(static_cast<juce::int64>(i));changed[i]=signal(static_cast<juce::int64>(i)+654321);}
        rejections=rejections&&!estimateBuiltInAlignmentSpan(reference.data(),changed.data(),a.size(),true).combined.accepted;
        for(size_t i=0;i<reference.size();++i){reference[i]=static_cast<float>(.1*std::sin(static_cast<double>(i)*.1));changed[i]=reference[i];}
        rejections=rejections&&!estimateBuiltInAlignmentSpan(reference.data(),changed.data(),a.size(),true).combined.accepted;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("lag",estimated.combined.lag);row->setProperty("minimumCorrelation",estimated.combined.correlation);row->setProperty("qualifiedWindows",estimated.qualified);row->setProperty("retainedBytes",static_cast<juce::int64>(a.audio[0].capacity()*8));cases.add(row);
    }
    BuiltInAlignmentCapture longSpan;longSpan.prepare(192000);bounded=bounded&&longSpan.armSpan(0,static_cast<juce::int64>(192000)*1800,65536,192000)&&longSpan.audio[0].capacity()*8<=8*1024*1024;longSpan.abort();
    result->setProperty("plugin","Project-span windows and repeated weak shared-signal timing");result->setProperty("cases",cases);result->setProperty("captureExactAndStableStorage",capture);result->setProperty("boundedThrough30Minutes",bounded);result->setProperty("weakSharedSignalConsensus",weak);result->setProperty("strongAndSilentWindowPolicy",strong);result->setProperty("driftUnrelatedPeriodicRejected",rejections);result->setProperty("maximumLagError",maximumLagError);result->setProperty("acousticGroupingCorrectness","not_asserted");result->setProperty("pass",capture&&bounded&&weak&&strong&&rejections&&maximumLagError<.1);return result;
}
