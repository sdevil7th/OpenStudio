#pragma once

// Long native captures are diagnostics. Only deterministic invariants are gates.
inline juce::var checkReverbCorrectionResponses()
{
    const auto directory=juce::File::getCurrentWorkingDirectory().getChildFile("output/reverb-correction/long-responses");
    bool passed=directory.createDirectory().wasOk();
    juce::Array<juce::var> rows;
    const auto render=[&](int type,double rate,int mode,int route,float amount,float decay,const juce::String& kind,bool transitions=false)
    {
        auto processor=std::make_unique<OpenStudioReverb>(true);
        juce::MemoryBlock state;
        const auto& profile=OpenStudioReverbFactoryPresets::profiles[static_cast<size_t>(type)];
        const bool built=OpenStudioReverbFactoryPresets::buildState(profile.name,state);
        processor->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
        processor->reverbControlMode.store(static_cast<float>(mode));
        processor->outputTrimDb.store(0);processor->wetLevel.store(1);processor->dryLevel.store(0);
        processor->decayTime.store(decay);processor->damping.store(kind.startsWith("profile-")?.59f:.5f);
        processor->creativeControls[0].store(static_cast<float>(route));processor->shimmerAmount.store(amount);
        processor->tailSpillover.store(transitions?1.0f:0.0f);
        if(kind=="original-readout")processor->reverbCharacterMode.store(0);
        if(kind=="refined-readout")processor->reverbCharacterMode.store(1);
        processor->prepareToPlay(rate,128);
        const int length=static_cast<int>(rate*20),channels=juce::jmax(2,processor->getTotalNumOutputChannels());
        juce::AudioBuffer<float> output(2,length),block(channels,128);juce::MidiBuffer midi;
        for(int start=0;start<static_cast<int>(rate*.1);start+=128){block.clear();processor->processBlock(block,midi);}
        bool finite=true;double energy=0,maximumCallback=0;int allocations=0,frees=0;
        const auto started=juce::Time::getMillisecondCounterHiRes();
        for(int start=0;start<length;start+=128)
        {
            const int count=juce::jmin(128,length-start);block.setSize(channels,count,false,false,true);block.clear();
            if(start==0){block.setSample(0,0,.125f);block.setSample(1,0,.09375f);}
            if(transitions)
            {
                const double seconds=start/rate;
                processor->damping.store(seconds>=4&&seconds<8?.9f:.2f);
                const float hold=seconds>=2&&seconds<4?1.0f:0.0f;
                processor->shimmerHold.store(hold);processor->nonlinearHold.store(hold);processor->freezeMode.store(hold);
                if(type==5)processor->creativeControls[0].store(seconds<6?0.0f:seconds<10?2.0f:1.0f);
                if(seconds>=12&&processor->algorithm.load()==static_cast<float>(type))processor->selectAlgorithm(9);
            }
#if JUCE_WINDOWS && JUCE_DEBUG
            ReverbCompatibilityHeapProbe::allocations=ReverbCompatibilityHeapProbe::frees=0;
            ReverbCompatibilityHeapProbe::previous=_CrtSetAllocHook(ReverbCompatibilityHeapProbe::hook);
            ReverbCompatibilityHeapProbe::active=true;
#endif
            const auto callback=juce::Time::getMillisecondCounterHiRes();processor->processBlock(block,midi);
            maximumCallback=juce::jmax(maximumCallback,juce::Time::getMillisecondCounterHiRes()-callback);
#if JUCE_WINDOWS && JUCE_DEBUG
            ReverbCompatibilityHeapProbe::active=false;_CrtSetAllocHook(ReverbCompatibilityHeapProbe::previous);
            allocations+=ReverbCompatibilityHeapProbe::allocations;frees+=ReverbCompatibilityHeapProbe::frees;
#endif
            for(int ch=0;ch<2;++ch){output.copyFrom(ch,start,block,ch,0,count);for(int i=0;i<count;++i){const float value=block.getSample(ch,i);finite=std::isfinite(value)&&finite;energy+=value*value;}}
        }
        const double wall=juce::Time::getMillisecondCounterHiRes()-started;
        const auto filename=kind+"-t"+juce::String(type)+"-r"+juce::String(static_cast<int>(rate))+"-m"+juce::String(mode)+"-route"+juce::String(route)+"-a"+juce::String(amount,2)+"-d"+juce::String(decay,1)+".wav";
        const bool rowPass=built&&finite&&energy>0&&allocations==0&&frees==0&&writeProbeWave(directory.getChildFile(filename),output,rate);
        auto* row=new juce::DynamicObject();row->setProperty("file",filename);row->setProperty("kind",kind);row->setProperty("type",type);row->setProperty("rate",rate);row->setProperty("mode",mode);row->setProperty("route",route);row->setProperty("amount",amount);row->setProperty("decay",decay);
        row->setProperty("peak",output.getMagnitude(0,length));row->setProperty("energy",energy);row->setProperty("wallMsDiagnostic",wall);row->setProperty("maxCallbackMsDiagnostic",maximumCallback);row->setProperty("allocations",allocations);row->setProperty("frees",frees);row->setProperty("pass",rowPass);
        rows.add(row);passed=rowPass&&passed;
        directory.getParentDirectory().getChildFile("long-progress.json").replaceWithText(juce::String(rows.size()));
    };
    const bool transitionsOnly=juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_REVERB_QA_TRANSITIONS_ONLY","0")=="1";
    if(!transitionsOnly)for(int type:{0,1,2,5,6,24,25,26})for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int mode:{0,1})
        render(type,rate,mode,1,.56f,6,"rate");
    if(!transitionsOnly)for(int route:{0,1,2})for(float amount:{0.0f,.56f,1.0f})for(float decay:{2.0f,11.5f})
        render(5,48000,1,route,amount,decay,"shimmer");
    for(int type:{0,2,5,6,24})render(type,48000,1,0,.56f,6,"transition",true);
    if(!transitionsOnly)for(int type:{2,19})for(const auto* kind:{"original-readout","refined-readout"})render(type,48000,1,1,.56f,6,kind);
    if(!transitionsOnly)for(double rate:{44100.0,48000.0}){render(5,rate,0,0,.56f,11.5f,"profile-before");render(5,rate,1,1,.56f,11.5f,"profile-after");}
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Standalone Reverb long correction diagnostics");result->setProperty("cases",rows);result->setProperty("caseCount",rows.size());result->setProperty("pass",passed);

#if JUCE_WINDOWS && JUCE_DEBUG
    result->setProperty("heapMeasured",true);
#else
    result->setProperty("heapMeasured",false);
#endif
    result->setProperty("audioQuality","not_asserted");result->setProperty("decaySpectrumTiming","diagnostic_only");return juce::var(result);
}
