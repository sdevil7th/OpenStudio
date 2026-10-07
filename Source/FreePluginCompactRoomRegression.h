#pragma once
inline juce::var checkCompactStudioRoom()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Second prepared Room character");
    bool finite=true,distinct=true,earlier=true,retained=true,dry=true;double partition=0;juce::Array<juce::var> cases;
    const auto render=[](double rate,int blockSize,int character,bool switchAway=false,bool alterInactive=false)
    {
        BuiltInStudioReverb space;space.prepare(rate,character);BuiltInStudioReverb::Settings settings;settings.decay=.8f;settings.modulation=0;settings.diffusion=.6f;settings.damping=.3f;
        const int length=juce::roundToInt(rate*.6),change=juce::roundToInt(rate*.12);juce::AudioBuffer<float> output(2,length);
        for(int start=0;start<length;)
        {
            int count=juce::jmin(blockSize,length-start);if(start<change)count=juce::jmin(count,change-start);
            const bool retiring=switchAway&&start>=change;auto current=settings;if(retiring&&alterInactive){current.decay=12;current.size=.1f;current.damping=1;current.width=0;}
            space.configure(retiring?0:character,current,switchAway);
            for(int i=0;i<count;++i){const float input=start+i==0?.4f:0;const auto value=space.process(input,input*.7f);output.setSample(0,start+i,value[0]);output.setSample(1,start+i,value[1]);}start+=count;
        }return output;
    };
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto original=render(rate,127,0),compact=render(rate,127,5),other=render(rate,511,5),spill=render(rate,127,5,true),changed=render(rate,127,5,true,true);
        int originalOnset=-1,compactOnset=-1;double difference=0,spillEnergy=0;
        for(int i=0;i<compact.getNumSamples();++i)
        {
            if(originalOnset<0&&std::abs(original.getSample(0,i))>1e-7f)originalOnset=i;
            if(compactOnset<0&&std::abs(compact.getSample(0,i))>1e-7f)compactOnset=i;
            for(int ch=0;ch<2;++ch){const double value=compact.getSample(ch,i);finite=finite&&std::isfinite(value)&&std::abs(value)<4;partition=juce::jmax(partition,std::abs(value-other.getSample(ch,i)));difference+=std::abs(value-original.getSample(ch,i));if(i>rate*.2){retained=retained&&spill.getSample(ch,i)==changed.getSample(ch,i);spillEnergy+=std::pow(spill.getSample(ch,i),2);}}
        }
        distinct=distinct&&difference>.1;earlier=earlier&&compactOnset>=0&&compactOnset<originalOnset;retained=retained&&spillEnergy>1e-8;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("originalOnsetMs",1000*originalOnset/rate);row->setProperty("compactOnsetMs",1000*compactOnset/rate);row->setProperty("absoluteDifference",difference);row->setProperty("retainedTailEnergy",spillEnergy);cases.add(row);
    }
    // New topology obeys both input policies without unbounded state.
    bool holds=true;for(bool infinite:{false,true})
    {
        BuiltInStudioReverb space;space.prepare(48000,5);BuiltInStudioReverb::Settings settings;settings.freeze=true;settings.infiniteInput=infinite;settings.modulation=0;settings.early=0;space.configure(5,settings);
        double energy=0;for(int i=0;i<48000;++i){const auto value=space.process(.08f,-.05f);for(int ch=0;ch<2;++ch){holds=holds&&std::isfinite(value[static_cast<size_t>(ch)])&&std::abs(value[static_cast<size_t>(ch)])<64;energy+=std::pow(value[static_cast<size_t>(ch)],2);}}holds=holds&&(infinite?energy>1e-5:energy==0);
    }
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(0);source->studioEngines[0].store(1);source->wetLevel.store(0);source->dryLevel.store(1);
    const bool setter=setFreePluginParamForRegression(*source,"roomCharacter",1);source->prepareToPlay(48000,127);juce::AudioBuffer<float> audio(2,127);juce::MidiBuffer midi;for(int i=0;i<127;++i){audio.setSample(0,i,.1f);audio.setSample(1,i,-.07f);}source->processBlock(audio,midi);for(int i=0;i<127;++i)dry=dry&&audio.getSample(0,i)==.1f&&audio.getSample(1,i)==-.07f;
    juce::MemoryBlock state,again;source->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);bool recall=state==again&&copy->roomCharacter.load()==1&&copy->studioTopology()==5;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());tree.removeProperty("roomCharacter",nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->roomCharacter.load()==0&&copy->studioTopology()==0;
    const auto schema=describeFreePluginForRegression(*source);const bool appended=schema["parameters"].size()>=528&&schema["parameters"][527]["id"].toString()=="roomCharacter";
    result->setProperty("pass",finite&&distinct&&earlier&&retained&&dry&&holds&&setter&&recall&&appended&&partition==0);result->setProperty("finite",finite);result->setProperty("distinctImpulse",distinct);result->setProperty("earlierReflections",earlier);result->setProperty("retainedSettingsAndTail",retained);result->setProperty("dryExact",dry);result->setProperty("freezeInfiniteInputPolicies",holds);result->setProperty("partitionError",partition);result->setProperty("setter",setter);result->setProperty("stateLegacyDefault",recall);result->setProperty("appendedDescriptor",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("referenceDecayBrightness","not_asserted");result->setProperty("audioQuality","not_asserted");return result;
}
