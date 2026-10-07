#include "BuiltInAlignmentGroups.h"
#include "BuiltInContinuousAlignment.h"
// Included by AudioEngine.cpp after builtInInstanceIdentity. Control/worker only.
static juce::var describeAlignmentRoute(TrackProcessor& track, const juce::AudioProcessor* selected)
{
    auto* result=new juce::DynamicObject();juce::Array<juce::var> chains,sends;
    bool lastTrack=false,enabledSend=false,afterSelected=false,selectedInTrack=false;int downstreamLatency=0;
    for(bool input:{true,false})
    {
        const auto processors=input?track.getInputFXSnapshot():track.getTrackFXSnapshot();
        const auto bypass=input?track.getInputFXBypassSnapshot():track.getTrackFXBypassSnapshot();
        if(!processors)continue;
        if(!input&&!processors->empty())lastTrack=processors->back().get()==selected;
        for(size_t index=0;index<processors->size();++index)
        {
            const auto& processor=(*processors)[index];
            if(!input){if(afterSelected)downstreamLatency+=processor->getLatencySamples();if(processor.get()==selected){afterSelected=true;selectedInTrack=true;}}
            auto* item=new juce::DynamicObject();
            item->setProperty("input",input);item->setProperty("instance",builtInInstanceIdentity(processor));
            item->setProperty("bypass",bypass&&bypass->count(static_cast<int>(index))?bypass->at(static_cast<int>(index)):false);
            // The selected utility's own FIR latency changes as part of Apply.
            item->setProperty("latency",processor.get()==selected?0:processor->getLatencySamples());chains.add(item);
        }
    }
    for(const auto& send:track.getRealtimeSendSnapshot())
    {
        enabledSend=enabledSend||send.enabled;auto* item=new juce::DynamicObject();
        item->setProperty("sourceChannel",send.sourceChannel);item->setProperty("destination",send.destTrackId);item->setProperty("enabled",send.enabled);
        item->setProperty("level",send.level);item->setProperty("pan",send.pan);item->setProperty("pre",send.preFader);item->setProperty("invert",send.phaseInvert);sends.add(item);
    }
    result->setProperty("chains",chains);result->setProperty("sends",sends);
    result->setProperty("master",track.getMasterSendEnabled());result->setProperty("outputStart",track.getOutputStartChannel());result->setProperty("outputCount",track.getOutputChannelCount());
    result->setProperty("inputStart",track.getInputStartChannel());result->setProperty("inputCount",track.getInputChannelCount());result->setProperty("monitor",track.getInputMonitoring());
    result->setProperty("invert",track.getPhaseInvert());result->setProperty("offset",track.getPlaybackOffset());
    result->setProperty("downstreamLatency",downstreamLatency);
    result->setProperty("fixedMaster",selectedInTrack&&track.getMasterSendEnabled()&&!enabledSend);
    result->setProperty("directMaster",lastTrack&&track.getMasterSendEnabled()&&!enabledSend);
    return result;
}
juce::var AudioEngine::gainPhaseAlignment(const juce::String& action,const juce::var& request,
                                         const std::function<bool()>& keepRunning,
                                         const std::function<void(int,double)>& reportProgress)
{
    const auto fail=[](const juce::String& reason){auto* result=new juce::DynamicObject();result->setProperty("success",false);result->setProperty("error",reason);return juce::var(result);};
    const auto addressFor=[](const juce::String& track,const juce::String& chain,int index,const juce::String& identity)
    {
        auto* address=new juce::DynamicObject();address->setProperty("trackId",track);address->setProperty("chain",chain);address->setProperty("fxIndex",index);address->setProperty("instanceId",identity);return juce::var(address);
    };
    if(action=="list")
    {
        juce::Array<juce::var> candidates;
        const auto tracks=std::atomic_load(&realtimeTrackSnapshot);
        if(tracks)for(const auto& track:tracks->tracks)if(track.processor)
            for(const bool input:{false,true})
            {
                const auto processors=input?track.processor->getInputFXSnapshot():track.processor->getTrackFXSnapshot();
                if(!processors)continue;
                for(size_t index=0;index<processors->size();++index)
                    if(const auto* utility=dynamic_cast<OpenStudioUtilityEffect*>((*processors)[index].get());utility&&utility->kind==OpenStudioUtilityEffect::Kind::GainPhase)
                        candidates.add(addressFor(track.id,input?"input":"track",static_cast<int>(index),builtInInstanceIdentity((*processors)[index])));
            }
        auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("candidates",candidates);return result;
    }
    const juce::ScopedTryLock operation(alignmentOperationLock);
    if(!operation.isLocked())return fail("Another alignment operation is active");
    if(keepRunning&&!keepRunning())return fail("Alignment canceled");
    if(action!="capture"&&action!="apply")return fail("Unknown alignment operation");
    const auto* entries=request["entries"].getArray();
    if(!entries||entries->size()<(action=="capture"?2:1)||entries->size()>8)return fail("Select two to eight existing Gain Phase instances");
    struct Member { juce::var address,values,request;PublishedBuiltInProcessorOwner owner;OpenStudioUtilityEffect* utility=nullptr;juce::String route;size_t captureIndex=0;int fixedLatency=0,capturedPDC=0;bool outputInvert=false; };
    std::vector<Member> members;juce::StringArray identities;
    const auto valuesFor=[](OpenStudioUtilityEffect& utility)
    {
        auto* values=new juce::DynamicObject();for(size_t i=0;i<utility.controls.size();++i)values->setProperty(utility.controls[i].id,utility.values[i].load());return juce::var(values);
    };
    const auto entryFor=[](const juce::var& address,const juce::var& values)
    {
        auto* entry=new juce::DynamicObject();entry->setProperty("address",address);entry->setProperty("values",values);return juce::var(entry);
    };
    for(const auto& entry:*entries)
    {
        const auto address=entry["address"];const auto identity=address["instanceId"].toString();const auto track=address["trackId"].toString(),chain=address["chain"].toString();
        if(identity.isEmpty()||identities.contains(identity)||track.isEmpty()||(chain!="track"&&chain!="input"))return fail("Alignment needs distinct, identified track instances");
        const int index=resolveBuiltInPluginRoute(track,chain,static_cast<int>(address["fxIndex"]),identity);
        if(index<0)return fail("An alignment instance was removed");
        auto owner=getPublishedBuiltInProcessor(track,chain,index);auto* utility=dynamic_cast<OpenStudioUtilityEffect*>(owner.processor.get());
        if(!utility||utility->kind!=OpenStudioUtilityEffect::Kind::GainPhase||!utility->alignmentCapture)return fail("A selected processor is not Gain Phase");
        identities.add(identity);members.push_back({addressFor(track,chain,index,identity),valuesFor(*utility),entry,std::move(owner),utility});
        auto& member=members.back();member.captureIndex=members.size()-1;member.capturedPDC=member.owner.track?member.owner.track->getPDCDelay():0;
        if(!member.owner.track)return fail("Alignment track was removed");
        const auto route=describeAlignmentRoute(*member.owner.track,utility);member.route=juce::JSON::toString(route,true);
        const auto routing=entry.getProperty("routePolicy",request.getProperty("routePolicy","inputs")).toString();
        if(routing!="inputs"&&routing!="direct-master"&&routing!="fixed-master")return fail("Unknown alignment routing policy");
        if(routing=="direct-master"||routing=="fixed-master")
        {
            if(!static_cast<bool>(route[routing=="fixed-master"?"fixedMaster":"directMaster"]))return fail("Master alignment requires a track-FX Gain Phase, master output enabled and no sends; Direct master also requires Gain Phase last");
            if(routing=="fixed-master"){member.fixedLatency=static_cast<int>(route["downstreamLatency"])+utility->getLatencySamples();member.outputInvert=member.owner.track->getPhaseInvert();}
            const auto* first=members.front().owner.track;
            if(member.owner.track->getOutputStartChannel()!=first->getOutputStartChannel()||member.owner.track->getOutputChannelCount()!=first->getOutputChannelCount())return fail("Direct-master members need matching hardware output ranges");
        }
        if(entry.hasProperty("expectedPDC")&&static_cast<int>(entry["expectedPDC"])!=member.capturedPDC)return fail("Host delay compensation changed; analyze again");
        if(entry.hasProperty("expectedRoute")&&entry["expectedRoute"].toString()!=member.route)return fail("Routing, FX order, bypass or latency changed; analyze again");
    }
    if(action=="apply")
    {
        // Validate every target and value before changing any processor. The short
        // publication lock prevents audio from seeing a partially applied group.
        const juce::ScopedLock publication(mainProcessorGraph->getCallbackLock());
        for(auto& member:members)
        {
            const auto& address=member.address;
            if(getPublishedBuiltInProcessor(address["trackId"].toString(),address["chain"].toString(),static_cast<int>(address["fxIndex"])).processor!=member.owner.processor)
                return fail("The FX chain changed; analyze again");
            if(member.request.hasProperty("expectedSampleRate")&&static_cast<double>(member.request["expectedSampleRate"])!=currentSampleRate)return fail("Sample rate changed since capture; analyze again");
            member.values=valuesFor(*member.utility);
            const auto* values=member.request["values"].getDynamicObject();
            if(!values||values->getProperties().size()!=static_cast<int>(member.utility->controls.size()))return fail("Incomplete alignment state");
            const auto* expected=member.request["expected"].getDynamicObject();
            for(const auto& control:member.utility->controls)
            {
                const auto value=values->getProperty(control.id);const double number=static_cast<double>(value);
                if(!(value.isDouble()||value.isInt()||value.isInt64())||!std::isfinite(number)||number<control.min||number>control.max)return fail("Invalid alignment parameter: "+juce::String(control.id));
                if(expected&&(!expected->hasProperty(control.id)||std::abs(static_cast<double>(expected->getProperty(control.id))-static_cast<double>(member.values[control.id]))>1e-6))
                    return fail("Alignment controls changed since capture; analyze again");
            }
        }
        juce::Array<juce::var> before,after;
        for(auto& member:members)
        {
            auto previous=entryFor(member.address,member.values);previous.getDynamicObject()->setProperty("expectedRoute",member.route);previous.getDynamicObject()->setProperty("routePolicy",member.request.getProperty("routePolicy","inputs"));before.add(previous);
            for(const auto& control:member.utility->controls)member.utility->setControl(control.id,static_cast<float>(member.request["values"][control.id]),true);
            member.utility->refreshSpectralConfiguration(true);
            if(member.owner.track)member.owner.track->invalidatePluginAutomationCache();
            auto next=entryFor(member.address,valuesFor(*member.utility));next.getDynamicObject()->setProperty("expectedRoute",member.route);next.getDynamicObject()->setProperty("routePolicy",member.request.getProperty("routePolicy","inputs"));after.add(next);
        }
        recalculatePDC();
        auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("before",before);result->setProperty("after",after);return result;
    }
    const auto policy=request.getProperty("channelPolicy","independent").toString();
    if(policy!="independent"&&policy!="linked")return fail("Unknown alignment channel policy");
    const bool linked=policy=="linked";
    const bool discoverGroups=static_cast<bool>(request.getProperty("discoverGroups",false));
    const bool spectralPhase=!discoverGroups&&static_cast<bool>(request.getProperty("spectralPhase",false));
    const bool fitPhase=!discoverGroups&&!spectralPhase&&static_cast<bool>(request.getProperty("fitPhase",false));
    if(!isPlaying.load()||isRendering.load()||isLooping.load())return fail("Play an uninterrupted section with looping off before analyzing");
    const double rate=currentSampleRate;
    if(rate<8000||rate>192000)return fail("Alignment supports 8-192 kHz playback");
    const bool projectSpan=static_cast<bool>(request.getProperty("projectSpan",false));
    const bool weakSignal=projectSpan&&static_cast<bool>(request.getProperty("weakSignal",false));
    const auto start=currentSamplePosition.load()+static_cast<juce::int64>(rate*.15)+juce::jmax(1,currentBlockSize)*2;
    const double projectEnd=static_cast<double>(request.getProperty("projectEndSeconds",0));
    const double requestedSeconds=projectSpan?projectEnd-static_cast<double>(start)/rate-.05:static_cast<double>(request.getProperty("captureSeconds",.5));
    if(projectSpan&&(!std::isfinite(requestedSeconds)||requestedSeconds<8||requestedSeconds>1800))return fail("Project-span capture needs 8 seconds to 30 minutes remaining; play from the desired start");
    if(!projectSpan&&requestedSeconds!=.5&&requestedSeconds!=2&&requestedSeconds!=4&&requestedSeconds!=30&&requestedSeconds!=60&&requestedSeconds!=120)return fail("Choose a 0.5, 2, 4, 30, 60 or 120 second capture");
    const bool continuous=projectSpan;
    const bool sparse=requestedSeconds>4&&!continuous;
    if((sparse||continuous)&&(fitPhase||spectralPhase))return fail("Long-span captures support timing/polarity only; use a short capture for phase fitting");
    const bool multipleSections=requestedSeconds>.5;
    // Leave room for the worker's 4096-sample overlap inside one 32768-sample
    // analysis window, avoiding an unnecessary doubling of the padded FFT.
    const int window=juce::jlimit(4096,continuous?28672:BuiltInAlignmentCapture::capacity,juce::roundToInt(rate*.5));
    const auto span=static_cast<juce::int64>(std::llround(rate*requestedSeconds));
    const int length=projectSpan?window*16:sparse?window*3:juce::jmin(multipleSections?BuiltInAlignmentCapture::maximumCapture:BuiltInAlignmentCapture::capacity,juce::roundToInt(rate*requestedSeconds));
    struct Abort { std::vector<Member>& members;~Abort(){for(auto& member:members)member.utility->alignmentCapture->abort();} } abort{members};
    for(auto& member:members)if(!(continuous?member.utility->alignmentCapture->armContinuous(start,span,window,rate):sparse?member.utility->alignmentCapture->armSparse(start,span,window,rate):member.utility->alignmentCapture->arm(start,length,rate)))return fail("An alignment capture is busy or the sample rate changed");
    BuiltInContinuousAlignment stream(members.size());std::vector<BuiltInAlignmentCapture*> captures;
    for(auto& member:members)captures.push_back(member.utility->alignmentCapture.get());
    const auto deadline=juce::Time::getMillisecondCounterHiRes()+juce::jmax(5000.0,requestedSeconds*1000+2000);
    double nextRouteCheck=0;
    for(;;)
    {
        bool complete=true;
        for(const auto& member:members){const int state=member.utility->alignmentCapture->state.load(std::memory_order_acquire);if(state<0)return fail("Playback stopped, sought or changed during capture");complete=complete&&state==2;}
        if(continuous&&!stream.consume(captures,weakSignal,keepRunning))return fail("Continuous analysis canceled or capture chunks disagree");
        if(continuous&&complete){bool drained=true;for(const auto* capture:captures)drained=drained&&capture->continuousDrained();complete=drained&&stream.covered==span;}
        if(reportProgress){double progress=1;for(const auto& member:members)progress=juce::jmin(progress,member.utility->alignmentCapture->progress());reportProgress(1,progress);}
        if(keepRunning&&!keepRunning())return fail("Alignment capture canceled");
        if(!isPlaying.load()||isLooping.load()||isRendering.load()||currentSampleRate!=rate)return fail("Playback stopped, looped or changed during capture");
        if(complete||juce::Time::getMillisecondCounterHiRes()>=nextRouteCheck)
        {
            for(const auto& member:members)if(member.capturedPDC!=member.owner.track->getPDCDelay()||member.route!=juce::JSON::toString(describeAlignmentRoute(*member.owner.track,member.utility),true))return fail("Routing, FX order, bypass or latency changed during capture");
            nextRouteCheck=juce::Time::getMillisecondCounterHiRes()+500;
        }
        if(complete)break;
        if(juce::Time::getMillisecondCounterHiRes()>deadline)return fail("Capture timed out; ensure all selected processors receive playback audio");
        juce::Thread::sleep(5);
    }
    if(reportProgress)reportProgress(2,1);
    const auto continuousMatrix=stream.matrix(linked);
    const auto makeProposal=[&](std::vector<Member>& groupMembers) -> juce::var
    {
    std::vector<std::array<BuiltInAlignmentEstimate,2>> estimates(groupMembers.size());
    std::vector<std::array<BuiltInAllPassFit,2>> phaseFits(groupMembers.size());
    std::vector<std::array<BuiltInSpectralPhaseFit,2>> spectralFits(groupMembers.size());
    std::vector<std::array<BuiltInAlignmentSections,2>> sectionEstimates(groupMembers.size());
    std::vector<std::array<BuiltInAlignmentSpan,2>> spanEstimates(groupMembers.size());
    std::array<double,2> latest{};bool accepted=true;
    for(size_t index=1;index<groupMembers.size();++index)
    {
        for(size_t ch=0;ch<2;++ch)
        {
            if(keepRunning&&!keepRunning())return fail("Alignment analysis canceled");
            const auto* reference=groupMembers[0].utility->alignmentCapture->audio[ch].data();const auto* target=groupMembers[index].utility->alignmentCapture->audio[ch].data();
            if(continuous){estimates[index][ch]=continuousMatrix[groupMembers[0].captureIndex][groupMembers[index].captureIndex][ch];}
            else if(projectSpan){spanEstimates[index][ch]=estimateBuiltInAlignmentSpan(reference,target,length,weakSignal);estimates[index][ch]=spanEstimates[index][ch].combined;}
            else if(multipleSections){sectionEstimates[index][ch]=estimateBuiltInAlignmentSections(reference,target,length);estimates[index][ch]=sectionEstimates[index][ch].combined;}
            else estimates[index][ch]=estimateBuiltInAlignment(reference,target,length);
        }
        for(auto& estimate:estimates[index]){estimate.lag+=groupMembers[index].fixedLatency-groupMembers[0].fixedLatency;estimate.invert=estimate.invert!=(groupMembers[index].outputInvert!=groupMembers[0].outputInvert);}
        if(linked){const auto common=linkBuiltInAlignment(estimates[index]);estimates[index]={common,common};}
        if(fitPhase||spectralPhase)
        {
            if(keepRunning&&!keepRunning())return fail("Phase fit canceled");
            const auto& a=groupMembers[0].utility->alignmentCapture->audio;const auto& b=groupMembers[index].utility->alignmentCapture->audio;
            if(linked)
            {
                std::array<const float*,2> referenceAudio{},targetAudio{};int channels=0;
                for(size_t ch=0;ch<2;++ch){double energyA=0,energyB=0;for(int i=0;i<length;++i){energyA+=a[ch][static_cast<size_t>(i)]*a[ch][static_cast<size_t>(i)];energyB+=b[ch][static_cast<size_t>(i)]*b[ch][static_cast<size_t>(i)];}if(energyA/length>=1e-8&&energyB/length>=1e-8){referenceAudio[static_cast<size_t>(channels)]=a[ch].data();targetAudio[static_cast<size_t>(channels++)]=b[ch].data();}}
                if(channels>0)
                {
                    if(spectralPhase){const auto fit=fitBuiltInSpectralPhase(referenceAudio,targetAudio,channels,length,rate,estimates[index][0],keepRunning);spectralFits[index]={fit,fit};}
                    else {const auto fit=fitBuiltInAllPass(referenceAudio,targetAudio,channels,length,rate,estimates[index][0],keepRunning);phaseFits[index]={fit,fit};}
                }
            }
            else for(size_t ch=0;ch<2;++ch)
            {
                if(spectralPhase)spectralFits[index][ch]=fitBuiltInSpectralPhase({a[ch].data(),nullptr},{b[ch].data(),nullptr},1,length,rate,estimates[index][ch],keepRunning);
                else phaseFits[index][ch]=fitBuiltInAllPass({a[ch].data(),nullptr},{b[ch].data(),nullptr},1,length,rate,estimates[index][ch],keepRunning);
            }
        }
        for(size_t ch=0;ch<2;++ch){const auto& fit=phaseFits[index][ch];latest[ch]=juce::jmax(latest[ch],fit.applied?fit.lag:estimates[index][ch].lag);accepted=accepted&&estimates[index][ch].accepted;}
    }
    if(keepRunning&&!keepRunning())return fail("Alignment analysis canceled");
    if(currentSampleRate!=rate)return fail("Sample rate changed; analyze again");
    juce::Array<juce::var> results;
    for(size_t index=0;index<groupMembers.size();++index)
    {
        const auto& member=groupMembers[index];juce::Array<juce::var> channels;
        auto values=member.values.clone();auto* proposed=values.getDynamicObject();
        proposed->setProperty("spectralPhaseEnabled",spectralPhase?1:0);proposed->setProperty("spectralPhaseAmount",1);
        proposed->setProperty("bypass",0);proposed->setProperty("phaseEnabledL",0);proposed->setProperty("phaseEnabledR",0);
        for(size_t ch=0;ch<2;++ch)
        {
            const auto& estimate=estimates[index][ch];const auto& fit=phaseFits[index][ch];const double effectiveLag=fit.applied?fit.lag:estimate.lag;const bool invert=fit.applied?fit.invert:estimate.invert;const double delay=latest[ch]-effectiveLag;
            const bool valid=(index==0||estimate.accepted)&&delay>=0&&delay<=2048.999;
            accepted=accepted&&valid;
            const auto suffix=ch==0?"L":"R";
            // Fine controls end at .999 samples. Round to their supported 0.001
            // representation so 36.999998 becomes 37+0, not an invalid fraction.
            const double represented=std::round(juce::jlimit(0.0,2048.999,delay)*1000.0)/1000.0;
            proposed->setProperty("delay"+juce::String(suffix),std::floor(represented));
            proposed->setProperty("fine"+juce::String(suffix),juce::jlimit(0.0,static_cast<double>(.999f),represented-std::floor(represented)));
            proposed->setProperty("polarity"+juce::String(suffix),invert?1:0);
            if(fit.applied){proposed->setProperty("phaseEnabled"+juce::String(suffix),1);proposed->setProperty("phaseFrequency"+juce::String(suffix),fit.frequency);proposed->setProperty("phaseStages"+juce::String(suffix),fit.stages-1);}
            const auto& spectralFit=spectralFits[index][ch];
            for(size_t point=0;point<BuiltInSpectralPhaseCurve::points;++point)
                proposed->setProperty("spectralPhase"+juce::String(suffix)+juce::String(static_cast<int>(point)),spectralPhase?spectralFit.curve[point]:0);
            auto* item=new juce::DynamicObject();
            if(spectralPhase){item->setProperty("spectralApplied",spectralFit.applied);item->setProperty("phaseApplied",spectralFit.applied);item->setProperty("phaseAgreementBefore",spectralFit.before);item->setProperty("phaseAgreementAfter",spectralFit.after);item->setProperty("phaseReason",index==0?"Analysis reference; unity curve":spectralFit.reason);item->setProperty("spectralRippleDB",spectralFit.maximumRippleDB);}
            item->setProperty("lag",effectiveLag);item->setProperty("delay",delay);item->setProperty("invert",invert);item->setProperty("correlation",index==0?1.0:estimate.correlation);item->setProperty("peakRatio",estimate.peakRatio);item->setProperty("phaseResidual",estimate.phaseResidual);item->setProperty("accepted",valid);item->setProperty("reason",delay>2048.999?"Group delay spread exceeds the available range":index==0?"Analysis reference":estimate.reason);if(continuous&&index>0){const auto a=juce::jmin(groupMembers[0].captureIndex,member.captureIndex),b=juce::jmax(groupMembers[0].captureIndex,member.captureIndex);const auto& evidence=stream.evidence[a][b][ch];item->setProperty("measurableWindows",evidence.measurable);item->setProperty("qualifiedWindows",evidence.qualified);}else if(multipleSections&&index>0){juce::Array<juce::var> sections;const auto appendSection=[&](const auto& section){auto* row=new juce::DynamicObject();row->setProperty("lag",section.lag);row->setProperty("invert",section.invert);row->setProperty("correlation",section.correlation);row->setProperty("accepted",section.accepted);row->setProperty("reason",section.reason);sections.add(row);};if(projectSpan){for(const auto& section:spanEstimates[index][ch].sections)appendSection(section);item->setProperty("measurableWindows",spanEstimates[index][ch].measurable);item->setProperty("qualifiedWindows",spanEstimates[index][ch].qualified);}else for(const auto& section:sectionEstimates[index][ch].sections)appendSection(section);item->setProperty("sections",sections);}if(fitPhase){item->setProperty("phaseApplied",fit.applied);item->setProperty("phaseFrequency",fit.frequency);item->setProperty("phaseStages",fit.stages);item->setProperty("phaseAgreementBefore",fit.before);item->setProperty("phaseAgreementAfter",fit.after);item->setProperty("phaseReason",index==0?"Analysis reference":fit.reason);}channels.add(item);
        }
        auto item=entryFor(member.address,values);item.getDynamicObject()->setProperty("expectedPDC",member.capturedPDC);item.getDynamicObject()->setProperty("expected",member.values);item.getDynamicObject()->setProperty("expectedSampleRate",rate);item.getDynamicObject()->setProperty("expectedRoute",member.route);item.getDynamicObject()->setProperty("routePolicy",request.getProperty("routePolicy","inputs"));item.getDynamicObject()->setProperty("channels",channels);results.add(item);
    }
    auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("accepted",accepted);result->setProperty("entries",results);result->setProperty("sampleRate",rate);result->setProperty("samples",continuous?span:length);result->setProperty("continuous",continuous);result->setProperty("coveredSamples",continuous?stream.covered:length);result->setProperty("captureSeconds",(sparse||continuous)?requestedSeconds:static_cast<double>(length)/rate);result->setProperty("sampledSeconds",static_cast<double>(continuous?stream.covered:length)/rate);result->setProperty("continuous",continuous);result->setProperty("sparse",sparse);result->setProperty("sectionCount",continuous?stream.windows:projectSpan?16:multipleSections?3:1);result->setProperty("projectSpan",projectSpan);result->setProperty("weakSignal",weakSignal);result->setProperty("routePolicy",request.getProperty("routePolicy","inputs"));result->setProperty("channelPolicy",policy);result->setProperty("fitPhase",fitPhase);result->setProperty("spectralPhase",spectralPhase);result->setProperty("startSample",start);result->setProperty("scope",spectralPhase?"Input at each Gain Phase; saved 48-point FIR curve, independent section qualification; downstream FX and arbitrary whole-song grouping excluded":fitPhase?"Input at each Gain Phase; bounded all-pass fit, downstream FX/PDC and arbitrary spectral correction excluded":request["routePolicy"].toString()=="fixed-master"?"Contiguous input evidence with reported downstream track-FX latency and existing host PDC accounted for; no downstream phase-response inference":"Input at each Gain Phase; downstream FX/PDC and spectral phase correction excluded");return result;
    };
    if(!discoverGroups)return makeProposal(members);
    std::vector<std::array<const float*,2>> audio;
    for(const auto& member:members)audio.push_back({member.utility->alignmentCapture->audio[0].data(),member.utility->alignmentCapture->audio[1].data()});
    BuiltInAlignmentGroups::Matrix matrix=continuousMatrix;
    if(!continuous&&!BuiltInAlignmentGroups::measure(audio,length,multipleSections,linked,matrix,keepRunning,
        [&](double progress){if(reportProgress)reportProgress(2,progress);},projectSpan,weakSignal))return fail("Group discovery canceled");
    const auto found=BuiltInAlignmentGroups::find(matrix,members.size());
    juce::Array<juce::var> groups,unmatched;
    for(const auto& indices:found.groups)
    {
        if(keepRunning&&!keepRunning())return fail("Group discovery canceled");
        std::vector<Member> selectedMembers;for(const auto index:indices)selectedMembers.push_back(members[index]);
        const auto proposal=makeProposal(selectedMembers);
        if(!static_cast<bool>(proposal["success"]))return proposal;
        if(static_cast<bool>(proposal["accepted"]))groups.add(proposal);
        else for(const auto index:indices)unmatched.add(members[index].address);
    }
    for(const auto index:found.unmatched)unmatched.add(members[index].address);
    auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("groups",groups);result->setProperty("unmatched",unmatched);
    result->setProperty("discovery",true);result->setProperty("captureSeconds",(sparse||continuous)?requestedSeconds:static_cast<double>(length)/rate);
    result->setProperty("sampledSeconds",static_cast<double>(continuous?stream.covered:length)/rate);result->setProperty("continuous",continuous);result->setProperty("sparse",sparse);result->setProperty("sectionCount",continuous?stream.windows:projectSpan?16:multipleSections?3:1);result->setProperty("projectSpan",projectSpan);result->setProperty("weakSignal",weakSignal);result->setProperty("routePolicy",request.getProperty("routePolicy","inputs"));
    result->setProperty("scope","Audio-derived complete-link proposals; every measured pair and timing/polarity cycle must agree. Continuous mode includes the entire selected span; acoustic interpretation and nonlinear downstream phase response are not inferred.");return result;
}
