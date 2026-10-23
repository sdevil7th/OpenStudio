#pragma once

// Deterministic readout/state checks. Neither these identities nor their RMS
// diagnostics assert that a listener prefers the additional broadband bed.
inline juce::var checkReverbVoiceOptions()
{
    using namespace ReverbReturnRegression;
    juce::Array<juce::var> rows;
    bool overall=true, heapMeasured=false;
    int allocations=0,frees=0;
    const auto add=[&](const char* kind,bool pass,double maximum=0){auto* row=new juce::DynamicObject();row->setProperty("kind",kind);row->setProperty("pass",pass);row->setProperty("maxError",maximum);rows.add(juce::var(row));overall=pass&&overall;};
    auto original=std::make_unique<OpenStudioReverb>(true);
    auto restored=std::make_unique<OpenStudioReverb>(true);
    auto embedded=std::make_unique<OpenStudioReverb>(false);
    bool state=original->ambBody.load()==0&&original->shimmerScheduling.load()==0;
    state=setFreePluginParamForRegression(*original,"ambBody",.5f)&&setFreePluginParamForRegression(*original,"shimmerScheduling",1)&&state;
    juce::MemoryBlock saved,repeated;original->getStateInformation(saved);restored->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));restored->getStateInformation(repeated);
    state=saved==repeated&&restored->ambBody.load()==.5f&&restored->shimmerScheduling.load()==1&&state;
    const auto parameters=describeFreePluginForRegression(*original)["parameters"];
    state=parameters.size()==1090&&parameters[1087]["id"].toString()=="shimmerScheduling"&&parameters[1088]["id"].toString()=="ambBody"&&state;
    for(const bool invalid:{false,true})
    {
        auto tree=juce::ValueTree::readFromData(saved.getData(),saved.getSize());
        for(const char* id:{"ambBody","shimmerScheduling"})if(invalid)tree.setProperty(id,std::numeric_limits<double>::quiet_NaN(),nullptr);else tree.removeProperty(id,nullptr);
        const auto old=bytes(tree);restored->setStateInformation(old.getData(),static_cast<int>(old.getSize()));
        state=restored->ambBody.load()==0&&restored->shimmerScheduling.load()==0&&state;
    }
    state=setFreePluginNormalizedForRegression(*restored,"ambBody",1)&&restored->ambBody.load()==1&&state;
    state=!setFreePluginParamForRegression(*embedded,"ambBody",1)&&!setFreePluginParamForRegression(*embedded,"shimmerScheduling",1)&&state;
    add("append_state_old_and_invalid_migration",state);

    const auto render=[&](int type,double rate,int channels,float bodyAmount,float wet,bool live,bool irregular)
    {
        auto processor=std::make_unique<OpenStudioReverb>(true);auto layout=processor->getBusesLayout();
        const auto channelSet=channels==1?juce::AudioChannelSet::mono():juce::AudioChannelSet::stereo();layout.inputBuses.set(0,channelSet);layout.outputBuses.set(0,channelSet);
        Capture capture;capture.prepared=processor->setBusesLayout(layout);processor->selectAlgorithm(type);
        processor->ambBody.store(bodyAmount);processor->wetLevel.store(wet);processor->dryLevel.store(.7f);processor->prepareToPlay(rate,256);
        const int samples=static_cast<int>(rate*1.25);capture.audio.setSize(channels,samples);juce::AudioBuffer<float> block(juce::jmax(2,channels),1021);juce::MidiBuffer midi;
        const std::array<int,5> partitions{1,17,63,257,1021};int start=0,index=0;
        const std::array<int,2> events{static_cast<int>(rate*.3),static_cast<int>(rate*.8)};
        while(start<samples)
        {
            if (live && start == events[0])
                processor->ambBody.store(1);
            if (live && start == events[1])
                processor->ambBody.store(0);
            int count=juce::jmin(irregular?partitions[static_cast<size_t>(index++%5)]:256,samples-start);
            if(live)for(const int event:events)if(event>start)count=juce::jmin(count,event-start);
            block.setSize(juce::jmax(2,channels),count,false,false,true);block.clear();
            for(int ch=0;ch<channels;++ch)for(int sample=0;sample<count;++sample){const double t=(start+sample)/rate;const float value=t<.6?.002f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*145*t)+.4*std::sin(juce::MathConstants<double>::twoPi*800*t))*(ch==0?1.0f:.8f):0;block.setSample(ch,sample,value);}
#if JUCE_WINDOWS && JUCE_DEBUG
            ReverbCompatibilityHeapProbe::allocations=ReverbCompatibilityHeapProbe::frees=0;ReverbCompatibilityHeapProbe::previous=_CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);ReverbCompatibilityHeapProbe::active=true;
#endif
            processor->processBlock(block,midi);
#if JUCE_WINDOWS && JUCE_DEBUG
            ReverbCompatibilityHeapProbe::active=false;_CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);allocations+=ReverbCompatibilityHeapProbe::allocations;frees+=ReverbCompatibilityHeapProbe::frees;heapMeasured=true;
#endif
            for(int ch=0;ch<channels;++ch){capture.audio.copyFrom(ch,start,block,ch,0,count);for(int sample=0;sample<count;++sample){const double value=block.getSample(ch,sample);capture.finite=std::isfinite(value)&&capture.finite;capture.peak=juce::jmax(capture.peak,std::abs(value));}}
            start+=count;
        }
        processor->releaseResources();return capture;
    };
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})for(const int channels:{1,2})
    {
        const auto zero=render(20,rate,channels,0,1,false,true),half=render(20,rate,channels,.5f,1,false,true),full=render(20,rate,channels,1,1,false,true);
        double linearError=0;
        for(int ch=0;ch<channels;++ch)for(int sample=0;sample<zero.audio.getNumSamples();++sample)linearError=juce::jmax(linearError,std::abs(2.0*half.audio.getSample(ch,sample)-zero.audio.getSample(ch,sample)-full.audio.getSample(ch,sample)));
        add("vowel_feedforward_body_linearity",zero.prepared&&half.prepared&&full.prepared&&zero.finite&&half.finite&&full.finite&&linearError<2e-7,linearError);
        const double bodyInfluence=error(zero.audio,full.audio);
        add("vowel_body_has_nonzero_influence",bodyInfluence>1e-7,bodyInfluence);
        const auto dry0=render(20,rate,channels,0,0,false,true),dry1=render(20,rate,channels,1,0,false,true);
        const double dryError=error(dry0.audio,dry1.audio);add("vowel_dry_exact_parity",dryError==0,dryError);
        const auto regular=render(20,rate,channels,0,1,true,false),irregular=render(20,rate,channels,0,1,true,true);
        const double partition=error(regular.audio,irregular.audio);add("live_body_ramp_partition_parity",regular.finite&&irregular.finite&&partition<2e-7,partition);
    }
    for(int type=0;type<OpenStudioReverb::standaloneTypeCount;++type)if(type!=20)
    {
        const auto zero=render(type,48000,2,0,1,false,false),full=render(type,48000,2,1,1,false,false);const double difference=error(zero.audio,full.audio);
        add("non_vowel_body_exact_bypass",zero.finite&&full.finite&&difference==0,difference);
    }
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Standalone append-only pitch scheduling and Vowel body controls");result->setProperty("cases",juce::var(rows));result->setProperty("callbackHeapMeasured",heapMeasured);result->setProperty("callbackAllocations",allocations);result->setProperty("callbackFrees",frees);result->setProperty("pass",overall&&allocations==0&&frees==0);result->setProperty("audioQuality","not_asserted");result->setProperty("perceivedDominance","not_asserted");return juce::var(result);
}
