#pragma once

inline juce::var checkReverbHoldPolicies()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Prepared reverb Freeze / Infinite input policies");
    bool freezeRejects=true,infiniteAdds=true,sustain=true,release=true,finite=true,recall=true,descriptors=true;
    double partitionError=0;juce::Array<juce::var> cases;
    const auto render=[](int type,double rate,int blockSize,bool infinite,bool extra)
    {
        auto reverb=std::make_unique<OpenStudioReverb>(true);reverb->selectAlgorithm(type);reverb->wetLevel.store(1);reverb->dryLevel.store(0);
        reverb->decayTime.store(.15f);reverb->damping.store(0);reverb->earlyLevel.store(0);reverb->preDelay.store(0);
        reverb->holdInputModes[static_cast<size_t>(type)].store(infinite?1.0f:0.0f);reverb->plateModulation.store(0);
        for(auto& value:reverb->studioModulation)value.store(0);
        for(auto& bank:reverb->spatialControls){bank[0].store(0);bank[1].store(0);bank[5].store(0);}
        reverb->prepareToPlay(rate,blockSize);
        const int startHold=juce::roundToInt(rate*.15),extraStart=juce::roundToInt(rate*.4),extraEnd=juce::roundToInt(rate*.5),releaseHold=juce::roundToInt(rate*1.2),length=juce::roundToInt(rate*2);
        juce::AudioBuffer<float> output(2,length),block(2,blockSize);juce::MidiBuffer midi;juce::uint32 random=123;
        for(int start=0;start<length;)
        {
            if(start==startHold){if(type==5)reverb->shimmerHold.store(1);else reverb->freezeMode.store(1);}
            if(start==releaseHold){reverb->shimmerHold.store(0);reverb->freezeMode.store(0);}
            int count=juce::jmin(blockSize,length-start);for(int event:{startHold,extraStart,extraEnd,releaseHold})if(start<event)count=juce::jmin(count,event-start);
            block.setSize(2,count,false,false,true);block.clear();
            for(int i=0;i<count;++i)
            {
                random=random*1664525u+1013904223u;const float noise=(static_cast<float>(random>>8)/8388608.0f-1)*.1f;
                const bool feed=start+i<juce::roundToInt(rate*.1)||(extra&&start+i>=extraStart&&start+i<extraEnd);
                if(feed){block.setSample(0,i,noise);block.setSample(1,i,-noise*.7f);}
            }
            reverb->processBlock(block,midi);for(int ch=0;ch<2;++ch)output.copyFrom(ch,start,block,ch,0,count);start+=count;
        }
        return output;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int type:{0,1,2,3,5,8,9,12,13})
    {
        if(rate!=48000&&type!=1&&type!=2&&type!=5&&type!=12)continue;
        const auto frozen=render(type,rate,127,false,false),rejected=render(type,rate,127,false,true),added=render(type,rate,127,true,true);
        double rejectError=0,addedDifference=0,heldEnergy=0,releasedEnergy=0;
        for(int ch=0;ch<2;++ch)for(int i=0;i<frozen.getNumSamples();++i)
        {
            const double a=frozen.getSample(ch,i),b=rejected.getSample(ch,i),c=added.getSample(ch,i);
            finite=finite&&std::isfinite(a)&&std::isfinite(b)&&std::isfinite(c)&&std::abs(c)<=4;
            rejectError=juce::jmax(rejectError,std::abs(a-b));if(i>rate*.6&&i<rate*1.1){addedDifference+=(a-c)*(a-c);heldEnergy+=a*a;}
            if(i>rate*1.5)releasedEnergy+=a*a;
        }
        freezeRejects=freezeRejects&&rejectError<1e-7;infiniteAdds=infiniteAdds&&addedDifference>1e-6;sustain=sustain&&heldEnergy>1e-10;release=release&&releasedEnergy<heldEnergy*.05;
        if(rate==48000&&type==5){const auto partitioned=render(type,rate,512,true,true);for(int ch=0;ch<2;++ch)for(int i=0;i<added.getNumSamples();++i)partitionError=juce::jmax(partitionError,std::abs(static_cast<double>(added.getSample(ch,i)-partitioned.getSample(ch,i))));}
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("type",type);row->setProperty("rejectedInputError",rejectError);row->setProperty("addedInputDifferenceEnergy",addedDifference);row->setProperty("heldEnergy",heldEnergy);row->setProperty("releasedEnergy",releasedEnergy);cases.add(row);
    }
    auto original=std::make_unique<OpenStudioReverb>(true),restored=std::make_unique<OpenStudioReverb>(true);original->selectAlgorithm(5);
    bool setters=setFreePluginParamForRegression(*original,"shimmerHold",1)&&setFreePluginParamForRegression(*original,"holdInputMode",1);
    original->selectAlgorithm(1);setters=setters&&setFreePluginParamForRegression(*original,"holdInputMode",1);original->selectAlgorithm(5);
    juce::MemoryBlock state,again;original->getStateInformation(state);restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));restored->getStateInformation(again);
    recall=state==again&&restored->holdInputModes[1].load()==1&&restored->holdInputModes[5].load()==1&&restored->holdInputModes[2].load()==0&&restored->shimmerHold.load()==1&&restored->getTailLengthSeconds()==120;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());tree.removeProperty("shimmerHold",nullptr);for(int i=0;i<21;++i)tree.removeProperty("holdInput"+juce::String(i),nullptr);
    juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);tree.writeToStream(stream);restored->setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));recall=recall&&restored->shimmerHold.load()==0;
    for(const auto& value:restored->holdInputModes)recall=recall&&value.load()==0;
    const auto schema=describeFreePluginForRegression(*original);const auto& params=schema["parameters"];descriptors=params.size()>=514&&params[491]["id"].toString()=="holdInputMode"&&params[492]["id"].toString()=="shimmerHold";
    result->setProperty("pass",freezeRejects&&infiniteAdds&&sustain&&release&&finite&&recall&&setters&&descriptors&&partitionError<1e-7);
    result->setProperty("freezeRejectsNewExcitation",freezeRejects);result->setProperty("infiniteAddsNewExcitation",infiniteAdds);result->setProperty("heldTailRetained",sustain);result->setProperty("releaseRestoresDecay",release);result->setProperty("finite",finite);result->setProperty("stateLegacyAndTypeMemories",recall);result->setProperty("setters",setters);result->setProperty("appendedDescriptors",descriptors);result->setProperty("partitionError",partitionError);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
