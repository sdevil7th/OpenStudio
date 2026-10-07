juce::var AudioEngine::eqDraftAudition(const juce::String& action,const juce::var& request,const std::function<bool()>& keepRunning)
{
    const auto fail=[](const juce::String& reason){auto* r=new juce::DynamicObject();r->setProperty("success",false);r->setProperty("error",reason);return juce::var(r);};
    const auto address=request["address"];const auto identity=address["instanceId"].toString(),session=request["session"].toString();
    if(identity.isEmpty()||session.isEmpty())return fail("Reopen an identified EQ instance");
    const auto track=address["trackId"].toString(),chain=address["chain"].toString();
    const int index=resolveBuiltInPluginRoute(track,chain,static_cast<int>(address["fxIndex"]),identity);
    if(index<0)return fail("The EQ instance was removed");
    const auto owner=getPublishedBuiltInProcessor(track,chain,index);auto* eq=dynamic_cast<OpenStudioEQ*>(owner.processor.get());
    if(!eq)return fail("Proposal audition requires an EQ instance");
    if(action=="status"||action=="stop")return eq->commandDraftPreview(session,action=="stop",static_cast<bool>(request["immediate"]));
    if(action!="start"&&action!="update")return fail("Unknown EQ audition operation");
    if(keepRunning&&!keepRunning())return fail("EQ audition cancelled");
    if(isRendering.load())return fail("Finish offline rendering before auditioning a proposal");
    auto result=eq->startDraftPreview(session,request["bands"],request["expectedState"].toString(),action=="update");
    if(keepRunning&&!keepRunning()){eq->commandDraftPreview(session,true);return fail("EQ audition cancelled");}
    return result;
}
