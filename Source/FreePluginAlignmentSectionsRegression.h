#pragma once
inline juce::var checkAlignmentSections()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Long alignment capture and section consensus");
    bool capture=true,consistent=true,drift=true,polarity=true,silence=true;juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        BuiltInAlignmentCapture recorder;recorder.prepare(rate);const int count=static_cast<int>(rate*4);capture=capture&&recorder.arm(23,count,rate)&&recorder.audio[0].size()==static_cast<size_t>(count);
        const auto* storage=recorder.audio[0].data();capture=capture&&!recorder.arm(0,10,rate)&&storage==recorder.audio[0].data();
        juce::AudioBuffer<float> block(2,511);
        for(int start=0;start<count+23;){const int size=juce::jmin((start%2)?127:511,count+23-start);block.setSize(2,size,false,false,true);for(int i=0;i<size;++i){const float value=static_cast<float>((start+i)%1024)*.0001f;block.setSample(0,i,value);block.setSample(1,i,-value);}recorder.process(block,start,true);start+=size;}
        capture=capture&&recorder.state.load()==2&&storage==recorder.audio[0].data();
        for(int i=0;i<count;++i){const float expected=static_cast<float>((i+23)%1024)*.0001f;capture=capture&&recorder.audio[0][static_cast<size_t>(i)]==expected&&recorder.audio[1][static_cast<size_t>(i)]==-expected;}
        juce::Random random(51817);std::vector<float> source(static_cast<size_t>(count)),target(source.size());for(auto& value:source)value=(random.nextFloat()-.5f)*.2f;
        for(int i=0;i<count;++i)target[static_cast<size_t>(i)]=i>=37?-source[static_cast<size_t>(i-37)]:0;
        const auto accepted=estimateBuiltInAlignmentSections(source.data(),target.data(),count);consistent=consistent&&accepted.combined.accepted&&accepted.combined.invert&&std::abs(accepted.combined.lag-37)<.02;
        for(int i=count/2;i<count;++i)target[static_cast<size_t>(i)]=-source[static_cast<size_t>(i-42)];const auto shifted=estimateBuiltInAlignmentSections(source.data(),target.data(),count);drift=drift&&!shifted.combined.accepted;
        for(int i=count/2;i<count;++i)target[static_cast<size_t>(i)]=source[static_cast<size_t>(i-37)];const auto flipped=estimateBuiltInAlignmentSections(source.data(),target.data(),count);polarity=polarity&&!flipped.combined.accepted;
        for(int i=count*2/3;i<count;++i)target[static_cast<size_t>(i)]=0;const auto missing=estimateBuiltInAlignmentSections(source.data(),target.data(),count);silence=silence&&!missing.combined.accepted;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("captureSamples",count);row->setProperty("sectionSamples",accepted.window);row->setProperty("estimatedLag",accepted.combined.lag);row->setProperty("accepted",accepted.combined.accepted);row->setProperty("driftRejected",!shifted.combined.accepted);row->setProperty("polarityRejected",!flipped.combined.accepted);row->setProperty("missingSectionRejected",!missing.combined.accepted);cases.add(row);
    }
    result->setProperty("pass",capture&&consistent&&drift&&polarity&&silence);result->setProperty("preparedStorageAndExactWindow",capture);result->setProperty("sectionConsensus",consistent);result->setProperty("driftRejected",drift);result->setProperty("polarityRejected",polarity);result->setProperty("missingSectionRejected",silence);result->setProperty("cases",cases);result->setProperty("audioQuality","not_asserted");return result;
}
