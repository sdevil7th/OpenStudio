#pragma once
#include "BuiltInReverbResponse.h"

inline juce::var checkRenderedReverbResponse()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Isolated rendered reverb response");
    bool finite=true,repeat=true,unchanged=true,cancel=true,progress=true,routing=true;
    juce::Array<juce::var> cases;
    for(const double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto source=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(24);
        source->wetLevel.store(.27f);source->dryLevel.store(.82f);source->prepareToPlay(rate,512);
        juce::MemoryBlock before;source->getStateInformation(before);
        double last=0;int steps=0;
        auto a=renderBuiltInReverbResponse(before,rate,93,2,0,{},[&](int stage,double value){progress=progress&&value>=last&&stage>=1&&stage<=2;last=value;++steps;});
        auto b=renderBuiltInReverbResponse(before,rate,93,2,0);
        repeat=repeat&&juce::JSON::toString(a)==juce::JSON::toString(b);
        const auto* peaks=a["peak"].getArray();const auto* rms=a["rms"].getArray();
        bool valid=static_cast<bool>(a["success"])&&static_cast<bool>(a["nonzero"])&&peaks&&rms&&peaks->size()==2&&rms->size()==2;
        if(valid)for(int ch=0;ch<2;++ch)
        {
            const auto* p=(*peaks)[ch].getArray();const auto* r=(*rms)[ch].getArray();valid=valid&&p&&r&&p->size()==640&&r->size()==640;
            if(p&&r)for(int i=0;i<juce::jmin(p->size(),r->size());++i)
                valid=valid&&std::isfinite(static_cast<double>((*p)[i]))&&static_cast<double>((*r)[i])>=0&&static_cast<double>((*r)[i])<=static_cast<double>((*p)[i])+1e-12;
        }
        finite=finite&&valid;progress=progress&&last==1&&steps>2;
        juce::MemoryBlock after;source->getStateInformation(after);unchanged=unchanged&&before==after;
        auto* item=new juce::DynamicObject();item->setProperty("sampleRate",rate);item->setProperty("pass",valid);item->setProperty("maximum",a["maximum"]);cases.add(item);
    }
    auto source=std::make_unique<OpenStudioReverb>(true);source->selectAlgorithm(25);source->prepareToPlay(48000,512);
    juce::MemoryBlock state;source->getStateInformation(state);
    const auto left=renderBuiltInReverbResponse(state,48000,120,2,0),right=renderBuiltInReverbResponse(state,48000,120,2,1);
    routing=static_cast<bool>(left["success"])&&static_cast<bool>(right["success"])&&juce::JSON::toString(left["peak"])!=juce::JSON::toString(right["peak"]);
    int calls=0;const auto cancelled=renderBuiltInReverbResponse(state,48000,120,10,2,[&]{return ++calls<12;});
    cancel=!static_cast<bool>(cancelled["success"])&&cancelled["error"].toString().contains("cancelled")&&calls==12;
    const auto invalid=renderBuiltInReverbResponse(state,48000,120,120,2);
    source->predelaySync.store(1);source->predelayDivision.store(18);source->predelayCapacity.store(2);source->getStateInformation(state);
    const auto silent=renderBuiltInReverbResponse(state,48000,10,2,2);
    const bool longWait=static_cast<bool>(silent["success"])&&!static_cast<bool>(silent["nonzero"])&&static_cast<double>(silent["predelayMs"])==96000&&static_cast<bool>(silent["tailBeyondWindow"]);
    result->setProperty("cases",cases);result->setProperty("finiteBins",finite);result->setProperty("deterministic",repeat);
    result->setProperty("sourceStateUnchanged",unchanged);result->setProperty("cancellation",cancel);result->setProperty("progress",progress);
    result->setProperty("stereoInputRouting",routing);result->setProperty("longPredelaySilentWindow",longWait);
    result->setProperty("pass",finite&&repeat&&unchanged&&cancel&&progress&&routing&&longWait&&!static_cast<bool>(invalid["success"]));
    result->setProperty("claimLevel","diagnostic_only response; deterministic invariants asserted, acoustic RT60/listening not asserted");return result;
}
