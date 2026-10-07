#pragma once

inline juce::var checkReverbSpillover()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Prepared family wet-tail spillover");
    bool tailPass=true,finite=true,dryPass=true,recall=true;double partitionError=0;juce::Array<juce::var> cases;
    const auto render=[](int type,double rate,int blockSize,bool spillover,bool dryOnly)
    {
        auto reverb=std::make_unique<OpenStudioReverb>(true);reverb->selectAlgorithm(type);reverb->tailSpillover.store(spillover?1.0f:0.0f);
        reverb->wetLevel.store(dryOnly?0.0f:1.0f);reverb->dryLevel.store(dryOnly?1.0f:0.0f);reverb->decayTime.store(2);reverb->damping.store(0);reverb->preDelay.store(0);reverb->earlyLevel.store(0);
        reverb->springControls[0].store(1);reverb->plateModulation.store(0);for(auto& value:reverb->studioModulation)value.store(0);for(auto& value:reverb->vintageModulation)value.store(0);for(auto& value:reverb->vintageColour)value.store(2);
        reverb->prepareToPlay(rate,blockSize);const int change=juce::roundToInt(rate*.2),length=juce::roundToInt(rate*1.2);
        juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;juce::uint32 random=123;double outgoingTail=0;
        for(int start=0;start<length;)
        {
            if(start==change){outgoingTail=reverb->getTailLengthSeconds();reverb->selectAlgorithm(type==6?0:6);}
            int count=juce::jmin(blockSize,length-start);if(start<change)count=juce::jmin(count,change-start);block.setSize(2,count,false,false,true);block.clear();
            for(int i=0;i<count;++i){random=random*1664525u+1013904223u;const float noise=(static_cast<float>(random>>8)/8388608.0f-1)*.1f;if(dryOnly||start+i<change){block.setSample(0,i,noise);block.setSample(1,i,-noise*.7f);}}
            reverb->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;
        }
        return std::make_pair(std::move(output),std::array<double,2>{reverb->getTailLengthSeconds(),outgoingTail});
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int type:{0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20})
    {
        if(rate!=48000&&type!=1&&type!=2&&type!=10&&type!=4&&type!=5&&type!=6&&type!=7&&type!=12&&type!=15&&type!=18)continue;
        const auto off=render(type,rate,127,false,false),on=render(type,rate,127,true,false);
        double offEnergy=0,onEnergy=0;for(int ch=0;ch<2;++ch)for(int i=juce::roundToInt(rate*.26);i<on.first.getNumSamples();++i){const double a=off.first.getSample(ch,i),b=on.first.getSample(ch,i);offEnergy+=a*a;onEnergy+=b*b;finite=finite&&std::isfinite(b)&&std::abs(b)<=4;}
        tailPass=tailPass&&onEnergy>1e-7&&offEnergy<1e-12&&on.second[0]+.003>=juce::jmax(off.second[0],on.second[1]-1.0);
        if(rate==48000&&(type==1||type>=12||type==4||type==5||type==6||type==7)){const auto alternate=render(type,rate,512,true,false);for(int ch=0;ch<2;++ch)for(int i=0;i<on.first.getNumSamples();++i)partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(on.first.getSample(ch,i)-alternate.first.getSample(ch,i))));}
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("type",type);row->setProperty("crossfadeTailEnergy",offEnergy);row->setProperty("spilloverTailEnergy",onEnergy);row->setProperty("reportedTailSeconds",on.second[0]);row->setProperty("selectedTailSeconds",off.second[0]);row->setProperty("outgoingInitialTailSeconds",on.second[1]);cases.add(row);
    }
    for(int type:{1,2,10,4,5,6,7,12,15,16,17,18,19,20})
    {
        const auto a=render(type,48000,127,false,true),b=render(type,48000,127,true,true);
        for(int ch=0;ch<2;++ch)for(int i=0;i<a.first.getNumSamples();++i)dryPass=dryPass&&a.first.getSample(ch,i)==b.first.getSample(ch,i);
    }
    const auto creative=[](int type,bool changeInactiveSettings,bool held)
    {
        BuiltInAdditionalReverbs space;constexpr int length=57600,change=9600;space.prepare(48000,type);
        BuiltInAdditionalReverbs::Settings saved {2,.4f,.2f,.5f,80,40,17000,.5f,.8f};saved.pitchA=7;saved.pitchB=-5;saved.voiceMix=.3f;saved.shimmerRoute=2;saved.nonlinearFeedback=.25f;saved.lateLevel=.3f;saved.hold=held;
        juce::AudioBuffer<float> audio(2,length);juce::uint32 random=731;
        for(int sample=0;sample<length;++sample)
        {
            if(sample%127==0||sample==change)
            {
                auto settings=saved;if(sample>=change&&changeInactiveSettings){settings.decay=.1f;settings.width=0;settings.damping=1;settings.preDelay=400;settings.highCut=1000;settings.shimmer=0;settings.pitchA=-24;settings.shape=7;settings.lateLevel=0;settings.nonlinearFeedback=0;}
                space.configure(sample<change?type:-1,settings,true);
            }
            random=random*1664525u+1013904223u;const float noise=(static_cast<float>(random>>8)/8388608.0f-1)*.05f;
            const auto output=space.process(noise,-noise*.7f);audio.setSample(0,sample,output[0]);audio.setSample(1,sample,output[1]);
        }
        return audio;
    };
    bool creativeSettings=true;double creativeEnergy=0;
    for(int type:{4,5,6})for(bool held:{false,true})
    {
        if(held&&type!=5)continue;
        const auto a=creative(type,false,held),b=creative(type,true,held);
        double energy=0;for(int ch=0;ch<2;++ch)for(int i=12480;i<a.getNumSamples();++i){creativeSettings=creativeSettings&&a.getSample(ch,i)==b.getSample(ch,i);energy+=static_cast<double>(a.getSample(ch,i))*a.getSample(ch,i);}
        creativeSettings=creativeSettings&&energy>1e-7;creativeEnergy+=energy;
    }
    // The bounded retirement clock must expire, cancel and never resurrect.
    BuiltInReverbRetirement<1> retirement;retirement.prepare(1000,0);retirement.configure(0,true,true,.12);retirement.configure(0,false,true,0);
    bool retirementPass=retirement.retiringTailSeconds()==.12;
    for(int i=0;i<70;++i)retirementPass=retirementPass&&retirement.next(0)==1;
    for(int i=0;i<50;++i)retirement.next(0);
    retirementPass=retirementPass&&retirement.next(0)==0&&retirement.retiringTailSeconds()==0;
    retirement.configure(0,true,true,1);for(int i=0;i<50;++i)retirement.next(0);retirement.configure(0,false,true,0);retirement.configure(0,false,false,0);for(int i=0;i<50;++i)retirement.next(0);retirement.configure(0,false,true,0);
    retirementPass=retirementPass&&retirement.next(0)==0;
    retirement.prepare(1000,0);retirement.configure(0,true,true,1);retirement.configure(0,false,true,0);std::array<juce::SmoothedValue<float>,1> silent;silent[0].setCurrentAndTargetValue(0);retirement.reset(silent);
    retirementPass=retirementPass&&retirement.next(0)==0&&retirement.retiringTailSeconds()==0;
    auto original=std::make_unique<OpenStudioReverb>(true),restored=std::make_unique<OpenStudioReverb>(true);
    const bool setter=setFreePluginParamForRegression(*original,"tailSpillover",1);juce::MemoryBlock state,again;original->getStateInformation(state);restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));restored->getStateInformation(again);recall=state==again&&restored->tailSpillover.load()==1;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());tree.removeProperty("tailSpillover",nullptr);juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);tree.writeToStream(stream);restored->setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));recall=recall&&restored->tailSpillover.load()==0;
    const auto schema=describeFreePluginForRegression(*original);const bool appended=schema["parameters"].size()>=515&&schema["parameters"][514]["id"].toString()=="tailSpillover";
    result->setProperty("pass",tailPass&&finite&&dryPass&&creativeSettings&&retirementPass&&recall&&setter&&appended&&partitionError<1e-7);result->setProperty("audibleTailAndHostEstimate",tailPass);result->setProperty("dryParity",dryPass);result->setProperty("creativeSettingsIsolation",creativeSettings);result->setProperty("creativeRetainedEnergy",creativeEnergy);result->setProperty("boundedRetirementResetAndNoResurrection",retirementPass);result->setProperty("finite",finite);result->setProperty("partitionError",partitionError);result->setProperty("stateLegacyDefaults",recall);result->setProperty("setter",setter);result->setProperty("appendedDescriptor",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
