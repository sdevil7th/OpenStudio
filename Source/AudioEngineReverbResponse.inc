#include "BuiltInReverbResponse.h"

juce::var AudioEngine::reverbResponse(const juce::var& request,const std::function<bool()>& keepRunning,
                                    const std::function<void(int,double)>& progress)
{
    const auto fail=[](const juce::String& reason){auto* r=new juce::DynamicObject();r->setProperty("success",false);r->setProperty("error",reason);return juce::var(r);};
    const juce::ScopedTryLock operation(reverbResponseOperationLock);
    if(!operation.isLocked())return fail("Another reverb response is being rendered");
    if(keepRunning&&!keepRunning())return fail("Response cancelled");
    const auto address=request["address"],identity=address["instanceId"];
    if(identity.toString().isEmpty())return fail("Reopen an identified reverb instance");
    const auto track=address["trackId"].toString(),chain=address["chain"].toString();
    const int index=resolveBuiltInPluginRoute(track,chain,static_cast<int>(address["fxIndex"]),identity.toString());
    if(index<0)return fail("The reverb instance was removed");
    const auto owner=getPublishedBuiltInProcessor(track,chain,index);
    auto* source=dynamic_cast<OpenStudioReverb*>(owner.processor.get());
    if(!source||!source->standaloneBanking)return fail("Response view requires a standalone reverb");
    const double rate=source->workflowSampleRate.load();const float responseTempo=source->workflowTempo.load();
    juce::MemoryBlock state;source->getStateInformation(state);
    auto result=renderBuiltInReverbResponse(state,rate,responseTempo,static_cast<double>(request["seconds"]),
        static_cast<int>(request["input"]),keepRunning,progress);
    if(!static_cast<bool>(result["success"]))return result;
    if(keepRunning&&!keepRunning())return fail("Response cancelled");
    const int currentIndex=resolveBuiltInPluginRoute(track,chain,index,identity.toString());
    if(currentIndex<0||getPublishedBuiltInProcessor(track,chain,currentIndex).processor!=owner.processor)
        return fail("The reverb instance changed; render again");
    juce::MemoryBlock after;source->getStateInformation(after);
    if(state!=after||source->workflowSampleRate.load()!=rate||source->workflowTempo.load()!=responseTempo)
        return fail("Reverb settings, tempo or sample rate changed; render again");
    return result;
}
