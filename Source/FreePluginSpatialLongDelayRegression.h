#pragma once
inline juce::var checkSpatialLongDelay()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Prepared per-space long feedback delay");
    bool capacity=true,timing=true,reset=true,feedback=true;juce::Array<juce::var> cases;
    // Buffer allocation is qualified at every host rate; a complete 96-second
    // causal trace uses 8 kHz to avoid repeatedly spending minutes on silence.
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto engine=std::make_unique<BuiltInSpatialReverb>();engine->prepare(rate,0,{0,1,2});
        capacity=capacity&&engine->preparedCapacity(0)==6&&engine->preparedCapacity(1)==24&&engine->preparedCapacity(2)==96;
        engine->setCapacity(1,0);capacity=capacity&&engine->preparedCapacity(0)==6&&engine->preparedCapacity(1)==6&&engine->preparedCapacity(2)==96;
    }
    for(const int slot:{0,1,2})
    {
        constexpr double rate=8000;auto engine=std::make_unique<BuiltInSpatialReverb>();engine->prepare(rate,slot,{2,2,2});
        BuiltInSpatialReverb::Settings settings;settings.delayMs=96000;settings.feedback=0;settings.amount=0;settings.modulation=0;engine->configure(slot,settings);
        const int delay=static_cast<int>(rate*96);int first=-1;bool exact=true;
        for(int i=0;i<delay+4;++i){const auto out=engine->process(i==0?.25f:0,i==0?-.125f:0);if(first<0&&out[0]!=0)first=i;exact=exact&&out[0]==(i==delay?.25f:0)&&out[1]==(i==delay?-.125f:0);}
        timing=timing&&exact&&first==delay;
        engine->reset();engine->configure(slot,settings);for(int i=0;i<1000;++i){const auto out=engine->process(0,0);reset=reset&&out[0]==0&&out[1]==0;}
        auto* row=new juce::DynamicObject();row->setProperty("mode",slot);row->setProperty("sampleRate",rate);row->setProperty("impulseSample",first);row->setProperty("exact",exact);cases.add(row);
    }
    // Room/hall feedback surrounds the input delay, so a second repeat follows
    // the first by the actual (formerly capped) interval.
    auto engine=std::make_unique<BuiltInSpatialReverb>();engine->prepare(8000,0,{1,0,0});BuiltInSpatialReverb::Settings settings;settings.delayMs=7000;settings.feedback=.5f;settings.amount=0;settings.modulation=0;engine->configure(0,settings);
    for(int i=0;i<=112000;++i){const auto out=engine->process(i==0?.25f:0,0);if(i==56000)feedback=feedback&&out[0]==.25f;if(i==112000)feedback=feedback&&out[0]==.125f;}
    auto source=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(12);
    bool setters=setFreePluginParamForRegression(*source,"spatialDelayCapacity",2)&&setFreePluginParamForRegression(*source,"spatial1.delayCapacity",1)&&setFreePluginParamForRegression(*source,"spatialSync",1)&&setFreePluginParamForRegression(*source,"spatialDivision",14);
    source->workflowTempo.store(10);source->prepareToPlay(48000,127);const bool uncapped=source->effectivePredelay()==96000;
    juce::MemoryBlock saved,again;source->getStateInformation(saved);copy->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));copy->getStateInformation(again);
    bool recall=saved==again&&copy->spatialDelayCapacity[0].load()==2&&copy->spatialDelayCapacity[1].load()==1&&copy->spatialDelayCapacity[2].load()==0;
    source->selectAlgorithm(13);setters=setters&&source->spatialCapacityMs()==24000;source->selectAlgorithm(12);setters=setters&&source->spatialCapacityMs()==96000;
    const auto schema=describeFreePluginForRegression(*source);bool appended=schema["parameters"].size()>=633&&schema["parameters"][629]["id"].toString()=="spatialDelayCapacity";
    for(int i=629;i<633;++i)appended=appended&&!static_cast<bool>(schema["parameters"][i]["automatable"]);
    auto tree=juce::ValueTree::readFromData(saved.getData(),saved.getSize());for(int i=0;i<3;++i)tree.removeProperty("spatialDelayCapacity"+juce::String(i),nullptr);juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));copy->workflowTempo.store(10);recall=recall&&copy->effectivePredelay()==6000;
    result->setProperty("pass",capacity&&timing&&reset&&feedback&&setters&&recall&&uncapped&&appended);result->setProperty("fourRateIndependentPreparedBuffers",capacity);result->setProperty("longImpulseTiming8kHz",timing);result->setProperty("resetSilence",reset);result->setProperty("longInputFeedbackRepeats",feedback);result->setProperty("perTypeSetters",setters);result->setProperty("stateLegacyDefaults",recall);result->setProperty("slowTempoUncapped",uncapped);result->setProperty("appendedNonAutomatableDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
