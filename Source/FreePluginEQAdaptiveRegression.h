#pragma once

inline juce::var checkEQAdaptiveDynamics()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","EQ adaptive threshold and automatic timing");
    bool adaptation=true,finite=true,scaling=true,recall=true,manual=true;juce::Array<juce::var> cases;
    struct Measurement {float settled=0,peak=0,threshold=0,attack=0,release=0;bool finite=true;};
    const auto render=[](double rate,float scale,bool externalMissing,bool automatic)
    {
        auto eq=std::make_unique<OpenStudioEQ>(true);for(auto& band:eq->bands)band.enabled.store(0);
        auto& band=eq->bands[1];band.enabled.store(1);band.freq.store(1000);band.q.store(2);band.dynamicEnabled.store(1);band.dynamicRange.store(-12);band.dynamicThresholdMode.store(automatic?1.0f:0.0f);band.dynamicTimingMode.store(automatic?1.0f:0.0f);band.dynamicSensitivity.store(0);band.detectorSource.store(externalMissing?2.0f:1.0f);
        eq->prepareToPlay(rate,127);juce::AudioBuffer<float> block(2,127);juce::MidiBuffer midi;Measurement measurement;
        const int length=juce::roundToInt(rate*2.8),burst=juce::roundToInt(rate*2),endBurst=juce::roundToInt(rate*2.1);
        for(int start=0;start<length;)
        {
            int count=juce::jmin(127,length-start);if(start<burst)count=juce::jmin(count,burst-start);else if(start<endBurst)count=juce::jmin(count,endBurst-start);block.setSize(2,count,false,false,true);
            for(int i=0;i<count;++i){const float amplitude=(start+i>=burst&&start+i<endBurst?.3f:.03f)*scale;const float sample=amplitude*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*1000*(start+i)/rate));block.setSample(0,i,sample);block.setSample(1,i,sample);}
            eq->processBlock(block,midi);for(int ch=0;ch<2;++ch)for(int i=0;i<count;++i)measurement.finite=measurement.finite&&std::isfinite(block.getSample(ch,i))&&std::abs(block.getSample(ch,i))<1;
            const auto controls=eq->getBandDynamicControls(1);if(start+count==burst){measurement.settled=eq->getBandDynamicGainDB(1);measurement.threshold=controls[0];measurement.attack=controls[1];measurement.release=controls[2];}
            if(start>=burst&&start<endBurst)measurement.peak=juce::jmin(measurement.peak,eq->getBandDynamicGainDB(1));
            start+=count;
        }
        return measurement;
    };
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        const auto normal=render(rate,1,false,true),quiet=render(rate,.25f,false,true),missing=render(rate,1,true,true);
        adaptation=adaptation&&std::abs(normal.settled)<.15f&&normal.peak<-3&&missing.peak==0&&missing.settled==0;
        scaling=scaling&&std::abs(normal.peak-quiet.peak)<.02f&&std::abs(normal.threshold-quiet.threshold-12.0412f)<.02f;
        finite=finite&&normal.finite&&quiet.finite&&missing.finite;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("steadyGainDb",normal.settled);row->setProperty("burstGainDb",normal.peak);row->setProperty("scaledBurstGainDb",quiet.peak);row->setProperty("thresholdDb",normal.threshold);row->setProperty("scaledThresholdDb",quiet.threshold);row->setProperty("attackMs",normal.attack);row->setProperty("releaseMs",normal.release);row->setProperty("missingKeyGainDb",missing.peak);cases.add(row);
    }
    const auto fixed=render(48000,1,false,false);manual=fixed.attack==10&&fixed.release==150&&fixed.threshold==-24;
    BuiltInEQAdaptiveDynamics detector;detector.prepare(48000);for(int i=0;i<48000;++i)detector.process(.01f);const auto low=detector.timing(100,-12),high=detector.timing(5000,-12);const bool timing=low[0]>high[0]*10&&low[1]>high[1];const bool sensitivity=detector.threshold(6)<detector.threshold(0)&&detector.threshold(-6)>detector.threshold(0);
    auto original=std::make_unique<OpenStudioEQ>(true),copy=std::make_unique<OpenStudioEQ>(true);const bool setters=setFreePluginParamForRegression(*original,"band23.dynamicThresholdMode",1)&&setFreePluginParamForRegression(*original,"band23.dynamicTimingMode",1)&&setFreePluginParamForRegression(*original,"band23.dynamicSensitivity",4);
    juce::MemoryBlock state,again;original->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);recall=state==again&&copy->bands[23].dynamicSensitivity.load()==4;
    auto tree=juce::ValueTree::readFromData(state.getData(),state.getSize());for(int band=0;band<24;++band)for(const auto* field:{"dynamicThresholdMode","dynamicTimingMode","dynamicSensitivity"})tree.removeProperty("band"+juce::String(band)+"_"+field,nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));for(const auto& band:copy->bands)recall=recall&&band.dynamicThresholdMode.load()==0&&band.dynamicTimingMode.load()==0&&band.dynamicSensitivity.load()==0;
    auto embedded=std::make_unique<OpenStudioEQ>();const bool isolated=!setFreePluginParamForRegression(*embedded,"band0.dynamicThresholdMode",1);
    const auto schema=describeFreePluginForRegression(*original);const bool descriptors=schema["parameters"].size()>=546&&schema["parameters"][474]["id"].toString()=="band0.dynamicThresholdMode"&&schema["parameters"][545]["id"].toString()=="band23.dynamicSensitivity";
    bool extendedRange=true;juce::Array<juce::var> rangeCases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})for(const float range:{-30.0f,30.0f})
    {
        auto processor=std::make_unique<OpenStudioEQ>(true);for(auto& band:processor->bands)band.enabled.store(0);
        auto& band=processor->bands[1];band.enabled.store(1);band.freq.store(1000);band.dynamicEnabled.store(1);band.dynamicRange.store(range);band.dynamicThreshold.store(-80);band.dynamicAttack.store(.2f);
        processor->prepareToPlay(rate,127);juce::AudioBuffer<float> block(2,127);juce::MidiBuffer midi;bool valid=true;
        for(int start=0;start<static_cast<int>(rate*.25);start+=127){for(int i=0;i<127;++i){const float sample=.01f*static_cast<float>(std::sin(juce::MathConstants<double>::twoPi*1000*(start+i)/rate));block.setSample(0,i,sample);block.setSample(1,i,sample);}processor->processBlock(block,midi);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)valid=valid&&std::isfinite(block.getSample(ch,i));}
        const float actual=processor->getBandDynamicGainDB(1);extendedRange=extendedRange&&valid&&std::abs(actual-range)<.01f;
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("requestedDb",range);row->setProperty("dynamicDb",actual);row->setProperty("finite",valid);rangeCases.add(row);
    }
    result->setProperty("expandedRange",extendedRange);result->setProperty("rangeCases",rangeCases);
    result->setProperty("pass",extendedRange&&adaptation&&finite&&scaling&&recall&&manual&&timing&&sensitivity&&setters&&isolated&&descriptors);result->setProperty("steadyTransientAndMissingKey",adaptation);result->setProperty("levelScaling",scaling);result->setProperty("finite",finite);result->setProperty("manualControlsRetained",manual);result->setProperty("frequencyTimingAndSensitivity",timing&&sensitivity);result->setProperty("stateLegacyDefaults",recall);result->setProperty("setters",setters);result->setProperty("embeddedIsolation",isolated);result->setProperty("appendedDescriptors",descriptors);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
