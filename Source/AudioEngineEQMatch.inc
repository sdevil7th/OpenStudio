#include "BuiltInEQMatch.h"

juce::var AudioEngine::eqMatch(const juce::String& action,const juce::var& request,const std::function<bool()>& keepRunning)
{
    const juce::ScopedLock operation(eqMatchOperationLock);
    const auto fail=[](const juce::String& reason){auto* result=new juce::DynamicObject();result->setProperty("success",false);result->setProperty("error",reason);return juce::var(result);};
    if(action=="list")
    {
        juce::Array<juce::var> candidates;
        const auto append=[&](const juce::String& track,const juce::String& chain,const auto& processors)
        {
            if(!processors)return;
            for(size_t index=0;index<processors->size();++index)
                if(const auto* eq=dynamic_cast<OpenStudioEQ*>((*processors)[index].get());eq&&eq->matchCapture)
                {
                    auto* address=new juce::DynamicObject();address->setProperty("trackId",track);address->setProperty("chain",chain);address->setProperty("fxIndex",static_cast<int>(index));address->setProperty("instanceId",builtInInstanceIdentity((*processors)[index]));candidates.add(address);
                }
        };
        const auto tracks=std::atomic_load(&realtimeTrackSnapshot);
        if(tracks)for(const auto& track:tracks->tracks)if(track.processor){append(track.id,"track",track.processor->getTrackFXSnapshot());append(track.id,"input",track.processor->getInputFXSnapshot());}
        // Master is resolved through the same published-owner API, without
        // reading the mutable control-side FX vector on this worker.
        for(int index=0;index<1024;++index)
        {
            const auto owner=getPublishedBuiltInProcessor({},"master",index);if(!owner.processor)break;
            if(const auto* eq=dynamic_cast<OpenStudioEQ*>(owner.processor.get());eq&&eq->matchCapture){auto* address=new juce::DynamicObject();address->setProperty("trackId","");address->setProperty("chain","master");address->setProperty("fxIndex",index);address->setProperty("instanceId",builtInInstanceIdentity(owner.processor));candidates.add(address);}
        }
        auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("candidates",candidates);return result;
    }
    if(action=="file")
    {
        const auto path=request["path"].toString();
        const auto offsetValue=request["startSeconds"];
        const double offset=offsetValue.isVoid()?0.0:static_cast<double>(offsetValue);
        if(path.isEmpty()||!juce::File::isAbsolutePath(path))return fail("Select an audio reference file");
        if((!offsetValue.isVoid()&&!offsetValue.isDouble()&&!offsetValue.isInt())||!std::isfinite(offset)||offset<0)
            return fail("Reference start must be a finite, non-negative time");
        const juce::File file(path);
        if(!file.hasFileExtension("wav;aif;aiff;flac"))return fail("Choose a WAV, AIFF or FLAC reference");
        juce::AudioFormatManager formats;formats.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
        if(!reader||reader->numChannels<1||reader->numChannels>2||!std::isfinite(reader->sampleRate)
            ||reader->sampleRate<8000||reader->sampleRate>192000)return fail("Reference must be readable mono/stereo audio at 8-192 kHz");
        const double rate=reader->sampleRate;
        if(offset>=reader->lengthInSamples/rate)return fail("Reference start is beyond the file");
        const auto first=static_cast<juce::int64>(offset*rate);
        const auto length=juce::jmin<juce::int64>(reader->lengthInSamples-first,static_cast<juce::int64>(rate*4));
        if(length<BuiltInEQMatch::fftSize)return fail("Reference section is shorter than one analysis window");
        auto capture=std::make_unique<BuiltInAlignmentCapture>();capture->prepare(rate);
        BuiltInEQMatch::Learner learner;
        juce::AudioBuffer<float> chunk(2,BuiltInAlignmentCapture::capacity);
        juce::int64 position=0;
        while(position+BuiltInEQMatch::fftSize<=length)
        {
            if(keepRunning&&!keepRunning())return fail("Reference learning cancelled");
            const int count=static_cast<int>(juce::jmin<juce::int64>(BuiltInAlignmentCapture::capacity,length-position));
            chunk.setSize(2,count,false,false,true);
            if(!reader->read(&chunk,0,count,first+position,true,true))return fail("Could not read the reference section");
            if(reader->numChannels==1)chunk.copyFrom(1,0,chunk,0,0,count);
            if(!capture->arm(0,count,rate))return fail("Could not prepare reference analysis");
            capture->process(chunk,0,true);learner.add(*capture);
            // Advance by complete half-overlap hops so chunk boundaries never
            // omit or double-count a window, including a partial final chunk.
            position+=((count-BuiltInEQMatch::fftSize)/(BuiltInEQMatch::fftSize/2)+1)*(BuiltInEQMatch::fftSize/2);
        }
        const auto spectrum=learner.spectrum(rate),hz=BuiltInEQMatch::frequencies(rate);
        juce::Array<juce::var> db,frequencies;
        for(size_t i=0;i<hz.size();++i){db.add(spectrum[i]);frequencies.add(hz[i]);}
        auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("spectrum",db);
        result->setProperty("frequencies",frequencies);result->setProperty("sampleRate",rate);result->setProperty("seconds",length/rate);
        result->setProperty("windows",learner.windows);result->setProperty("sourceName",file.getFileName());result->setProperty("startSeconds",first/rate);
        return result;
    }
    if(action=="fit"||action=="sketch")
    {
        const double rate=static_cast<double>(request["sampleRate"]);
        if(!std::isfinite(rate)||rate<8000||rate>192000)return fail("Invalid matching sample rate");
        const bool mixedShapes=action=="sketch"&&static_cast<bool>(request.getProperty("mixedShapes",false));
        BuiltInEQMatch::Curve current{},reference{};
        for(const bool referenceSide:{false,true})
        {
            if(action=="sketch"&&!referenceSide)continue;
            const auto* data=request[action=="sketch"?"target":referenceSide?"reference":"current"].getArray();if(!data||data->size()!=BuiltInEQMatch::points)return fail("Invalid spectrum or sketch length");
            auto& target=referenceSide?reference:current;
            for(int i=0;i<data->size();++i){const auto value=data->getReference(i);const double number=static_cast<double>(value);if(!(value.isDouble()||value.isInt())||!std::isfinite(number)||number<(action=="sketch"?(mixedShapes?-48:-12):-120)||number>(action=="sketch"?(mixedShapes?24:12):80))return fail("Invalid spectrum value");target[static_cast<size_t>(i)]=number;}
        }
        const auto fitted=BuiltInEQMatch::fit(current,reference,rate,static_cast<int>(request["bands"]),action!="sketch",mixedShapes,static_cast<bool>(request.getProperty("analogResponse",false)));
        auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("accepted",fitted.accepted);result->setProperty("reason",fitted.reason);result->setProperty("beforeError",fitted.before);result->setProperty("afterError",fitted.after);result->setProperty("removedLevel",fitted.removedLevel);result->setProperty("validPoints",fitted.validPoints);
        juce::Array<juce::var> bands,target,curve;
        for(const auto& band:fitted.bands){auto* item=new juce::DynamicObject();item->setProperty("frequency",band.frequency);item->setProperty("gain",band.gain);item->setProperty("q",band.q);item->setProperty("type",band.type);item->setProperty("slope",band.slope);bands.add(item);}
        for(size_t i=0;i<fitted.target.size();++i){target.add(fitted.target[i]);curve.add(fitted.curve[i]);}
        result->setProperty("mixedShapes",mixedShapes);result->setProperty("bands",bands);result->setProperty("target",target);result->setProperty("curve",curve);result->setProperty("sampleRate",rate);return result;
    }
    if(action!="capture")return fail("Unknown EQ Match operation");
    if(!isPlaying.load()||isRendering.load()||isLooping.load())return fail("Play a continuous section with looping off before learning");
    const auto address=request["address"];const auto identity=address["instanceId"].toString(),track=address["trackId"].toString(),chain=address["chain"].toString();
    if(identity.isEmpty()||(chain!="track"&&chain!="input"&&chain!="master"))return fail("Reopen an identified standalone EQ instance");
    const int index=resolveBuiltInPluginRoute(track,chain,static_cast<int>(address["fxIndex"]),identity);if(index<0)return fail("The EQ instance was removed");
    auto owner=getPublishedBuiltInProcessor(track,chain,index);auto* eq=dynamic_cast<OpenStudioEQ*>(owner.processor.get());
    if(!eq||!eq->matchCapture)return fail("Spectrum learning requires a standalone EQ");
    const double rate=currentSampleRate;if(rate<8000||rate>192000)return fail("EQ Match supports 8-192 kHz playback");
    const auto before=getBuiltInPluginState(track,chain,index)["values"];
    const auto fingerprint=juce::JSON::toString(before);
    BuiltInEQMatch::Learner learner;int captured=0;
    const int length=juce::jmin(BuiltInAlignmentCapture::capacity,juce::jmax(BuiltInEQMatch::fftSize,juce::roundToInt(rate*.5)));
    struct Abort{BuiltInAlignmentCapture& capture;~Abort(){capture.abort();}} abort{*eq->matchCapture};
    while(captured<static_cast<int>(rate*4))
    {
        const auto start=currentSamplePosition.load()+juce::jmax(1,currentBlockSize)*3;
        if(!eq->matchCapture->arm(start,length,rate))return fail("EQ capture is busy or sample rate changed");
        const auto deadline=juce::Time::getMillisecondCounterHiRes()+4000;
        for(;;)
        {
            const int state=eq->matchCapture->state.load(std::memory_order_acquire);
            if(state==2)break;
            if(state<0||!isPlaying.load()||isLooping.load())return fail("Playback stopped, sought or changed during learning");
            if((keepRunning&&!keepRunning())||juce::Time::getMillisecondCounterHiRes()>deadline)return fail("EQ learning timed out; ensure the instance receives playback audio");
            juce::Thread::sleep(5);
        }
        learner.add(*eq->matchCapture);captured+=length;
    }
    const int currentIndex=resolveBuiltInPluginRoute(track,chain,index,identity);
    if(currentIndex<0||fingerprint!=juce::JSON::toString(getBuiltInPluginState(track,chain,currentIndex)["values"]))return fail("EQ settings changed during learning; learn again");
    const auto spectrum=learner.spectrum(rate),hz=BuiltInEQMatch::frequencies(rate);juce::Array<juce::var> db,frequencies;
    for(size_t i=0;i<hz.size();++i){db.add(spectrum[i]);frequencies.add(hz[i]);}
    auto* result=new juce::DynamicObject();result->setProperty("success",true);result->setProperty("spectrum",db);result->setProperty("frequencies",frequencies);result->setProperty("sampleRate",rate);result->setProperty("seconds",captured/rate);result->setProperty("windows",learner.windows);result->setProperty("values",before);return result;
}
