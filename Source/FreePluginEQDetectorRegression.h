#pragma once

inline juce::var checkEQBandDetectors()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "EQ per-band detector routing and Free trigger");
    bool isolation = true, freeTrigger = true, audition = true, bypass = true, recall = true, descriptors = true;
    juce::Array<juce::var> cases;
    for (double rate : {44100.0,48000.0,96000.0,192000.0})
    {
        auto eq = std::make_unique<OpenStudioEQ>(true);
        for (auto& band : eq->bands) band.enabled.store(0);
        for (int b : {1,2,3})
        {
            auto& band = eq->bands[b]; band.enabled.store(1); band.freq.store(1000); band.q.store(10);
            band.dynamicEnabled.store(1); band.dynamicRange.store(-12); band.dynamicThreshold.store(-30);
            band.dynamicAttack.store(1); band.dynamicRelease.store(20);
        }
        eq->bands[1].detectorSource.store(1); eq->bands[2].detectorSource.store(2);
        eq->bands[2].detectorLowCut.store(200); eq->bands[2].detectorHighCut.store(2000);
        juce::MidiBuffer midi;
        const auto render = [&](bool key, float mainGain, float keyGain)
        {
            double energy = 0; int measured = 0; const int length = juce::roundToInt(rate * .35);
            for (int offset=0; offset<length; offset+=127)
            {
                const int count=juce::jmin(127,length-offset);juce::AudioBuffer<float> audio(key?4:2,count);
                for(int i=0;i<count;++i)
                {
                    const float tone=static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*1000*(offset+i)/rate));
                    audio.setSample(0,i,mainGain*tone);audio.setSample(1,i,mainGain*tone);
                    if(key){audio.setSample(2,i,keyGain*tone);audio.setSample(3,i,keyGain*tone);}
                }
                eq->processBlock(audio,midi);
                if(offset>length/2)for(int i=0;i<count;++i){const double sample=audio.getSample(0,i);energy+=sample*sample;++measured;}
            }
            return std::sqrt(energy/juce::jmax(1,measured));
        };
        eq->prepareToPlay(rate,127);render(true,.001f,.5f);
        isolation=isolation&&std::abs(eq->getBandDynamicGainDB(1))<.001f&&eq->getBandDynamicGainDB(2)<-11.5f&&std::abs(eq->getBandDynamicGainDB(3))<.001f;
        eq->externalDetector.store(1);eq->prepareToPlay(rate,127);render(true,.001f,.5f);
        isolation=isolation&&std::abs(eq->getBandDynamicGainDB(1))<.001f&&eq->getBandDynamicGainDB(2)<-11.5f&&eq->getBandDynamicGainDB(3)<-11.5f;
        eq->bands[2].freq.store(4000);eq->prepareToPlay(rate,127);render(true,.001f,.5f);
        const float narrow=eq->getBandDynamicGainDB(2);
        eq->bands[2].detectorMode.store(1);eq->prepareToPlay(rate,127);render(true,.001f,.5f);
        const float independent=eq->getBandDynamicGainDB(2);
        freeTrigger=freeTrigger&&std::abs(narrow)<.01f&&independent<-11.5f;
        for(auto& band:eq->bands)band.dynamicEnabled.store(0);
        eq->detectorListenBand.store(3);eq->prepareToPlay(rate,127);
        const double keyListen=render(true,0,.2f);
        audition=audition&&keyListen>.12&&keyListen<.15;
        eq->prepareToPlay(rate,127);const double noKey=render(false,.2f,0);audition=audition&&noKey==0;
        eq->editorBypass.store(1);eq->prepareToPlay(rate,127);const double bypassRMS=render(true,.1f,.8f);
        bypass=bypass&&std::abs(bypassRMS-.1/std::sqrt(2.0))<.0001;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("bandTriggerDb",narrow);row->setProperty("freeTriggerDb",independent);
        row->setProperty("keyListenRMS",keyListen);row->setProperty("missingKeyRMS",noKey);row->setProperty("bypassRMS",bypassRMS);cases.add(row);
    }
    auto original=std::make_unique<OpenStudioEQ>(true),restored=std::make_unique<OpenStudioEQ>(true);
    original->bands[23].detectorSource.store(2);original->bands[23].detectorMode.store(1);
    original->bands[23].detectorLowCut.store(350);original->bands[23].detectorHighCut.store(4500);original->detectorListenBand.store(24);
    juce::MemoryBlock bytes,again;original->getStateInformation(bytes);restored->setStateInformation(bytes.getData(),static_cast<int>(bytes.getSize()));restored->getStateInformation(again);recall=bytes==again;
    auto tree=juce::ValueTree::readFromData(bytes.getData(),bytes.getSize());tree.removeProperty("detectorListenBand",nullptr);
    for(int band=0;band<24;++band)for(const auto* name:{"detectorSource","detectorMode","detectorLowCut","detectorHighCut"})tree.removeProperty("band"+juce::String(band)+"_"+name,nullptr);
    juce::MemoryBlock legacy;juce::MemoryOutputStream stream(legacy,false);tree.writeToStream(stream);restored->setStateInformation(legacy.getData(),static_cast<int>(legacy.getSize()));
    recall=recall&&restored->detectorListenBand.load()==0;
    for(const auto& band:restored->bands)recall=recall&&band.detectorSource.load()==0&&band.detectorMode.load()==0&&band.detectorLowCut.load()==20&&band.detectorHighCut.load()==20000;
    const auto schema=describeFreePluginForRegression(*original);const auto& parameters=schema["parameters"];
    descriptors=parameters.size()>=393&&parameters[296]["id"].toString()=="band0.detectorSource"&&parameters[392]["id"].toString()=="detectorListenBand";
    result->setProperty("pass",isolation&&freeTrigger&&audition&&bypass&&recall&&descriptors);result->setProperty("sourceOverridesAndGlobalDefault",isolation);
    result->setProperty("independentTriggerRange",freeTrigger);result->setProperty("keyAuditionAndMissingSilence",audition);result->setProperty("bypassMainAudio",bypass);
    result->setProperty("stateAndLegacyMigration",recall);result->setProperty("appendedDescriptors",descriptors);result->setProperty("cases",cases);result->setProperty("schema",schema);
    result->setProperty("audioQuality","not_asserted");return result;
}
