#pragma once

inline juce::var checkFreePluginAutomationRanges()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Original normalized enum contracts and expanded selector aliases");
    bool oldRanges=true,expanded=true,recall=true,embedded=true;juce::Array<juce::var> schemas;
    auto eq=std::make_unique<OpenStudioEQ>(true);auto reverb=std::make_unique<OpenStudioReverb>(true);auto delay=std::make_unique<OpenStudioDelay>(24.1f,true);
    for(int value=0;value<=3;++value)oldRanges=oldRanges&&setFreePluginNormalizedForRegression(*eq,"band0.slope",static_cast<float>(value)/3)&&eq->bands[0].slope.load()==value;
    for(int value=0;value<=8;++value)oldRanges=oldRanges&&setFreePluginNormalizedForRegression(*eq,"auditionBand",static_cast<float>(value)/8)&&eq->auditionBand.load()==value;
    for(int value=0;value<=3;++value)oldRanges=oldRanges&&setFreePluginNormalizedForRegression(*reverb,"algorithm",static_cast<float>(value)/3)&&reverb->algorithm.load()==value;
    for(int value=0;value<=2;++value)oldRanges=oldRanges&&setFreePluginNormalizedForRegression(*delay,"delayMode",static_cast<float>(value)/2)&&delay->delayMode.load()==value;
    for(int value=0;value<=5;++value)expanded=expanded&&setFreePluginNormalizedForRegression(*eq,"band0.slopeMode",static_cast<float>(value)/5)&&eq->bands[0].slope.load()==value;
    for(int value=0;value<=24;++value)expanded=expanded&&setFreePluginNormalizedForRegression(*eq,"bandAudition",static_cast<float>(value)/24)&&eq->auditionBand.load()==value;
    for(int value=0;value<=20;++value)expanded=expanded&&setFreePluginNormalizedForRegression(*reverb,"reverbType",static_cast<float>(value)/20)&&reverb->algorithm.load()==value;
    for(int value=0;value<=4;++value)expanded=expanded&&setFreePluginNormalizedForRegression(*delay,"delayType",static_cast<float>(value)/4)&&delay->delayMode.load()==value;
    bool dynamicRange=true;
    for(const float normalized:{0.0f,.25f,.5f,.75f,1.0f})
    {
        dynamicRange=dynamicRange&&setFreePluginNormalizedForRegression(*eq,"band0.dynamicRange",normalized)&&eq->bands[0].dynamicRange.load()==-24+48*normalized;
        dynamicRange=dynamicRange&&setFreePluginNormalizedForRegression(*eq,"band23.dynamicRangeExtended",normalized)&&eq->bands[23].dynamicRange.load()==-30+60*normalized;
    }
    const auto roundTrip=[&](auto& original,auto& copy)
    {
        juce::MemoryBlock state,again;original->getStateInformation(state);copy->setStateInformation(state.getData(),static_cast<int>(state.getSize()));copy->getStateInformation(again);return state==again;
    };
    auto eqCopy=std::make_unique<OpenStudioEQ>(true);auto reverbCopy=std::make_unique<OpenStudioReverb>(true);auto delayCopy=std::make_unique<OpenStudioDelay>(24.1f,true);
    recall=roundTrip(eq,eqCopy)&&roundTrip(reverb,reverbCopy)&&roundTrip(delay,delayCopy)&&eqCopy->bands[23].dynamicRange.load()==30&&eqCopy->bands[0].slope.load()==5&&eqCopy->auditionBand.load()==24&&reverbCopy->algorithm.load()==20&&delayCopy->delayMode.load()==4;
    auto channelEQ=std::make_unique<OpenStudioEQ>();auto embeddedDelay=std::make_unique<OpenStudioDelay>();auto embeddedReverb=std::make_unique<OpenStudioReverb>();
    embedded=!setFreePluginNormalizedForRegression(*channelEQ,"band0.dynamicRangeExtended",1)&&!setFreePluginNormalizedForRegression(*channelEQ,"band0.slopeMode",1)&&!setFreePluginNormalizedForRegression(*embeddedDelay,"delayType",1)&&!setFreePluginNormalizedForRegression(*embeddedReverb,"reverbType",1);
    const auto eqSchema=describeFreePluginForRegression(*eq);
    const auto revSchema=describeFreePluginForRegression(*reverb);
    const auto delaySchema=describeFreePluginForRegression(*delay);
    const auto idAt=[](const juce::var& schema,int index)
    {
        const auto* parameters=schema["parameters"].getArray();
        return parameters!=nullptr&&juce::isPositiveAndBelow(index,parameters->size())?(*parameters)[index]["id"].toString():juce::String();
    };
    const bool indices=idAt(eqSchema,546)=="band0.dynamicRangeExtended"&&idAt(eqSchema,569)=="band23.dynamicRangeExtended"&&idAt(eqSchema,465)=="band0.slopeMode"&&idAt(eqSchema,473)=="bandAudition"&&idAt(revSchema,515)=="reverbType"&&idAt(delaySchema,32)=="delayType";
    schemas.add(eqSchema);schemas.add(revSchema);schemas.add(delaySchema);
    result->setProperty("pass",oldRanges&&expanded&&recall&&embedded&&indices&&dynamicRange);result->setProperty("dynamicRangeAutomation",dynamicRange);result->setProperty("allOriginalEnumValues",oldRanges);result->setProperty("allExpandedEnumValues",expanded);result->setProperty("unchangedNativeStateRoundTrip",recall);result->setProperty("embeddedAliasesAbsent",embedded);result->setProperty("appendedIndices",indices);result->setProperty("schemas",schemas);result->setProperty("audioQuality","not_asserted");return result;
}
