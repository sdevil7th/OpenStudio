#pragma once
inline juce::var checkLongReverbPredelay()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Extended shared tempo predelay");
    bool time=true,dry=true,reset=true,recall=true,tail=true,automation=true;juce::Array<juce::var> cases;
    for(const auto& configuration:std::array<std::pair<double,int>,4>{{{44100,0},{48000,1},{96000,2},{192000,2}}})
    {
        const double rate=configuration.first;const int capacity=configuration.second;
        BuiltInReverbWorkflow workflow;workflow.prepare(rate,static_cast<float>(capacity));
        const float requested=BuiltInReverbWorkflow::milliseconds(10,18);
        const int delay=juce::roundToInt(rate*BuiltInReverbWorkflow::capacitySeconds(static_cast<float>(capacity)));
        workflow.configure(true,requested,0,-24,250);
        bool exact=true;int first=-1;
        for(int i=0;i<delay+3;++i)
        {
            const auto output=workflow.process(i==0?.25f:0,i==0?-.125f:0,0);
            if(first<0&&output[0]!=0)first=i;
            exact=exact&&output[0]==(i==delay?.25f:0)&&output[1]==(i==delay?-.125f:0);
        }
        time=time&&exact&&first==delay;
        workflow.reset();workflow.configure(true,requested,0,-24,250);
        for(int i=0;i<1000;++i)reset=reset&&workflow.process(0,0,0)==std::array<float,2>{};
        workflow.reset();workflow.configure(false,requested,0,-24,250);
        for(int i=0;i<1000;++i){const float value=static_cast<float>(i)*.0001f;dry=dry&&workflow.process(value,-value,0)==std::array<float,2>{value,-value};}
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("capacitySeconds",BuiltInReverbWorkflow::capacitySeconds(static_cast<float>(capacity)));row->setProperty("requestedMs",requested);row->setProperty("actualImpulseSample",first);row->setProperty("exact",exact);cases.add(row);
    }
    const bool divisions=BuiltInReverbWorkflow::milliseconds(120,14)==2000&&BuiltInReverbWorkflow::milliseconds(10,18)==96000&&BuiltInReverbWorkflow::milliseconds(300,18)==3200;
    auto original=std::make_unique<OpenStudioReverb>(true),copy=std::make_unique<OpenStudioReverb>(true);
    const bool setters=setFreePluginParamForRegression(*original,"predelayDivisionExtended",18)&&setFreePluginParamForRegression(*original,"predelayCapacity",2)&&setFreePluginParamForRegression(*original,"predelaySync",1);
    original->workflowTempo.store(10);original->prepareToPlay(48000,127);const double longTail=original->getTailLengthSeconds();
    const auto schema=describeFreePluginForRegression(*original);const bool appended=schema["parameters"].size()>=617&&schema["parameters"][615]["id"].toString()=="predelayDivisionExtended"&&schema["parameters"][616]["id"].toString()=="predelayCapacity"&&!static_cast<bool>(schema["parameters"][616]["automatable"]);
    juce::MemoryBlock saved,again;original->getStateInformation(saved);copy->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));copy->getStateInformation(again);
    recall=saved==again&&copy->predelayCapacity.load()==2&&copy->predelayDivision.load()==18;
    original->setPredelayCapacity(0);tail=std::abs(longTail-original->getTailLengthSeconds()-90)<1e-6&&original->effectivePredelay()==6000;
    for(int i=0;i<=8;++i)automation=automation&&setFreePluginNormalizedForRegression(*original,"predelayDivision",static_cast<float>(i)/8)&&original->predelayDivision.load()==i;
    for(int i=0;i<=18;++i)automation=automation&&setFreePluginNormalizedForRegression(*original,"predelayDivisionExtended",static_cast<float>(i)/18)&&original->predelayDivision.load()==i;
    auto tree=juce::ValueTree::readFromData(saved.getData(),saved.getSize());tree.removeProperty("predelayCapacity",nullptr);tree.setProperty("predelayDivision",4,nullptr);
    juce::MemoryBlock old;juce::MemoryOutputStream stream(old,false);tree.writeToStream(stream);copy->setStateInformation(old.getData(),static_cast<int>(old.getSize()));recall=recall&&copy->predelayCapacity.load()==0&&copy->predelayDivision.load()==4;
    result->setProperty("pass",time&&dry&&reset&&recall&&tail&&automation&&divisions&&setters&&appended);result->setProperty("exactPreparedCapacityDelay",time);result->setProperty("dryParity",dry);result->setProperty("resetSilence",reset);result->setProperty("stateLegacyDefaults",recall);result->setProperty("longTailReporting",tail);result->setProperty("originalAutomationRange",automation);result->setProperty("explicitBeatDivisions",divisions);result->setProperty("setters",setters);result->setProperty("appendedDescriptors",appended);result->setProperty("cases",cases);result->setProperty("schema",schema);result->setProperty("audioQuality","not_asserted");return result;
}
