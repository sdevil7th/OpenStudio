bool OpenStudioEQ::canPreviewDraft() const noexcept
{
    if(!supportsExternalKey()||!isPowerEnabled()||editorBypass.load()>=.5f
        ||stereoMode.load()>=.5f||autoGain.load()>=.5f
        ||auditionBand.load()>=.5f||detectorListenBand.load()>=.5f||isNonRealtime())return false;
    return true;
}

uint64_t OpenStudioEQ::draftFingerprint() const noexcept
{
    uint64_t hash=1469598103934665603ull;
    const auto add=[&](float value){uint32_t bits=0;std::memcpy(&bits,&value,sizeof(bits));hash=(hash^bits)*1099511628211ull;};
    for(const auto* value:{&outputGain,&editorBypass,&autoGain,&auditionBand,&stereoMode,&phaseMode,&phaseQuality,
        &spectralProcessing,&linearBandDynamics,&minimumPhaseFIR,&analogResponse,&detectorListenBand,&externalDetector})add(value->load());
    add(isPowerEnabled()?1.0f:0.0f);
    for(int i=0;i<bandCount;++i)
    {
        const auto& b=bands[i];
        for(const auto* value:{&b.target,&b.enabled,&b.type,&b.freq,&b.gain,&b.q,&b.slope,&b.dynamicEnabled,
            &b.dynamicThreshold,&b.dynamicRange,&b.dynamicAttack,&b.dynamicRelease,&b.detectorSource,&b.detectorMode,
            &b.detectorLowCut,&b.detectorHighCut,&b.allPass,&b.dynamicThresholdMode,&b.dynamicTimingMode,&b.dynamicSensitivity,
            &b.spectralEnabled,&b.spectralDensity,&b.spectralTilt,&b.gainQInteraction,&b.cutMode,&b.continuousSlope})add(value->load());
    }
    return hash;
}

juce::var OpenStudioEQ::commandDraftPreview(const juce::String& session,bool stop,bool immediate)
{
    if(const auto prepared=preparedMIDIView())
    {
        const int index=prepared->previewVoice.load();
        if(index>=0)return prepared->voices[static_cast<size_t>(index)].engine->draftPreview.command(session,stop,immediate);
    }
    return draftPreview.command(session,stop,immediate);
}

juce::var OpenStudioEQ::startDraftPreview(const juce::String& session,const juce::var& proposal,const juce::String& expectedState,bool update)
{
    const auto fail=[](const juce::String& reason){auto* r=new juce::DynamicObject();r->setProperty("success",false);r->setProperty("error",reason);return juce::var(r);};
    if(const auto prepared=preparedMIDIView())
    {
        juce::MemoryBlock parentState;getStateInformation(parentState);
        if(expectedState.isEmpty()||parentState.toBase64Encoding()!=expectedState)return fail("EQ settings changed; fit again");
        const auto fingerprint=draftFingerprint();const int index=prepared->displayed.load();auto& voice=*prepared->voices[static_cast<size_t>(index)].engine;
        std::array<float,MIDIProgramBank::valueCount> values{};size_t field=0;
        visitMIDIProgramParameters([&](auto& parameter,float,float){values[field++]=parameter.load();});field=0;
        voice.visitMIDIProgramParameters([&](auto& parameter,float,float){parameter.store(values[field++]);});
        voice.setPowerEnabled(isPowerEnabled());juce::MemoryBlock childState;voice.getStateInformation(childState);
        auto result=voice.startDraftPreview(session,proposal,childState.toBase64Encoding(),update);
        if(fingerprint!=draftFingerprint()||preparedMIDIView()!=prepared){voice.draftPreview.command(session,true);return fail("EQ changed while preparing audition");}
        if(static_cast<bool>(result["success"]))prepared->previewVoice.store(index);
        return result;
    }
    if(!canPreviewDraft())return fail("Audition needs an active Stereo EQ with Auto gain and Listen off");
    const auto* entries=proposal.getArray();if(!entries||entries->isEmpty()||entries->size()>8)return fail("Audition needs one to eight proposed filters");
    const double rate=publishedSampleRate.load();if(rate<8000||rate>192000)return fail("The EQ sample rate is unavailable");
    const auto fingerprint=draftFingerprint();
    juce::MemoryBlock before;getStateInformation(before);
    if(expectedState.isEmpty()||before.toBase64Encoding()!=expectedState)return fail("EQ settings changed; fit again");
    auto copy=std::make_unique<OpenStudioEQ>(true);copy->publishedSampleRate.store(rate);
    BuiltInEQDraftPreview::Plan plan;plan.rate=rate;plan.fingerprint=fingerprint;
    for(const auto& entry:*entries)
    {
        const float frequency=static_cast<float>(entry["frequency"]),gain=static_cast<float>(entry["gain"]),q=static_cast<float>(entry["q"]);
        const float type=entry.hasProperty("type")?static_cast<float>(entry["type"]):0, slope=entry.hasProperty("slope")?static_cast<float>(entry["slope"]):1;
        if(!std::isfinite(frequency)||frequency<10||frequency>30000||!std::isfinite(gain)||std::abs(gain)>24
            ||!std::isfinite(q)||q<.1f||q>30||!std::isfinite(type)||type<0||type>4||type!=std::floor(type)
            ||!std::isfinite(slope)||slope<0||slope>3||slope!=std::floor(slope))return fail("Proposed filters are outside audition bounds");
        auto& b=copy->bands[0];b.enabled.store(1);b.type.store(type);b.freq.store(frequency);b.gain.store(gain);b.q.store(q);b.slope.store(slope);
        std::array<OpenStudioIIRCoefficientSet,maxStagesPerBand> coefficients;
        const int count=copy->buildBandTargets(0,true,coefficients,false,phaseMode.load()<.5f&&minimumPhaseFIR.load()>=.5f&&analogResponse.load()>=.5f);
        if(plan.stages+count>64)return fail("Too many audition filter stages");
        for(int stage=0;stage<count;++stage)plan.coefficients[static_cast<size_t>(plan.stages++)]=coefficients[static_cast<size_t>(stage)];
    }
    if(fingerprint!=draftFingerprint()||rate!=publishedSampleRate.load()||!canPreviewDraft())return fail("EQ changed while preparing audition");
    return draftPreview.start(session,plan,update);
}
