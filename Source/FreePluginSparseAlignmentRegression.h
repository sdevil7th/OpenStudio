#pragma once
#include "BuiltInAlignmentJob.h"

inline juce::var checkSparseAlignment()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Bounded sparse alignment spans and cancellation");
    bool exact=true,bounded=true,consensus=true,progress=true,discontinuity=true,cancel=true;
    juce::Array<juce::var> cases;
    const auto signal=[](juce::int64 sample){auto value=static_cast<juce::uint32>(sample);value^=value>>16;value*=0x7feb352dU;value^=value>>15;value*=0x846ca68bU;value^=value>>16;return (static_cast<float>(value&65535)/65535.0f-.5f)*.2f;};
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const int seconds=rate==44100?30:rate==48000?60:120;
        const auto span=static_cast<juce::int64>(rate*seconds);
        const int window=juce::jlimit(4096,BuiltInAlignmentCapture::capacity,juce::roundToInt(rate*.5));
        BuiltInAlignmentCapture a,b;a.prepare(rate);b.prepare(rate);
        // A preceding contiguous capture must not retain its larger allocation.
        bounded=bounded&&a.arm(0,static_cast<int>(rate*4),rate);a.abort();
        exact=exact&&a.armSparse(23,span,window,rate)&&b.armSparse(23,span,window,rate);
        bounded=bounded&&a.size()==window*3&&a.audio[0].capacity()<=static_cast<size_t>(window*3);
        const auto* storage=a.audio[0].data();juce::AudioBuffer<float> source(2,511),target(2,511);double previous=0;
        for(juce::int64 position=0;position<span+23;)
        {
            const int count=static_cast<int>(juce::jmin<juce::int64>((position%2)?127:511,span+23-position));
            source.setSize(2,count,false,false,true);target.setSize(2,count,false,false,true);
            for(int i=0;i<count;++i){const float value=signal(position+i),delayed=-signal(position+i-37);source.setSample(0,i,value);source.setSample(1,i,-value);target.setSample(0,i,delayed);target.setSample(1,i,-delayed);}
            a.process(source,position,true);b.process(target,position,true);const double next=a.progress();progress=progress&&next>=previous&&next<=1;previous=next;position+=count;
        }
        exact=exact&&a.state.load()==2&&b.state.load()==2&&storage==a.audio[0].data();progress=progress&&a.progress()==1;
        const std::array<juce::int64,3> starts{23,23+(span-window)/2,23+span-window};
        for(int section=0;section<3;++section)for(int i=0;i<window;++i)
            exact=exact&&a.audio[0][static_cast<size_t>(section*window+i)]==signal(starts[static_cast<size_t>(section)]+i);
        const auto estimated=estimateBuiltInAlignmentSections(a.audio[0].data(),b.audio[0].data(),a.size());
        consensus=consensus&&estimated.combined.accepted&&estimated.combined.invert&&std::abs(estimated.combined.lag-37)<.02;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("spanSeconds",seconds);row->setProperty("retainedSamplesPerChannel",a.size());row->setProperty("storageBytes",static_cast<juce::int64>(a.audio[0].capacity()*8));row->setProperty("lag",estimated.combined.lag);row->setProperty("accepted",estimated.combined.accepted);cases.add(row);
    }
    BuiltInAlignmentCapture recorder;recorder.prepare(48000);juce::AudioBuffer<float> block(2,512);block.clear();
    discontinuity=discontinuity&&recorder.armSparse(0,48000*30,4096,48000);
    for(int i=0;i<8192;i+=512)recorder.process(block,i,true);
    recorder.process(block,8704,true);discontinuity=discontinuity&&recorder.state.load()==-1;
    discontinuity=discontinuity&&recorder.armSparse(0,48000*30,4096,48000);recorder.process(block,0,true);recorder.process(block,0,true);discontinuity=discontinuity&&recorder.state.load()==-1;
    cancel=cancel&&recorder.armSparse(0,48000*30,4096,48000);recorder.process(block,0,true);recorder.abort();cancel=cancel&&recorder.state.load()==-1;
    cancel=cancel&&recorder.armSparse(0,48000*30,4096,48000);recorder.process(block,0,false);cancel=cancel&&recorder.state.load()==-1;
    cancel=cancel&&recorder.armSparse(0,48000*30,4096,48000);recorder.prepare(96000);cancel=cancel&&recorder.state.load()==-1&&!recorder.armSparse(0,48000*30,4096,48000);
    BuiltInAlignmentJob ticket;cancel=cancel&&ticket.keepRunning();ticket.heartbeat.store(juce::Time::getMillisecondCounterHiRes()-6001);cancel=cancel&&!ticket.keepRunning();ticket.touch();cancel=cancel&&ticket.keepRunning();ticket.cancel();ticket.touch();cancel=cancel&&!ticket.keepRunning();
    result->setProperty("pass",exact&&bounded&&consensus&&progress&&discontinuity&&cancel);result->setProperty("exactSparseWindows",exact);result->setProperty("boundedAllocation",bounded);result->setProperty("threeWindowConsensus",consensus);result->setProperty("progress",progress);result->setProperty("gapAndSeekRejected",discontinuity);result->setProperty("cancelStopRateAndHeartbeat",cancel);result->setProperty("cases",cases);result->setProperty("audioQuality","not_asserted");return result;
}
