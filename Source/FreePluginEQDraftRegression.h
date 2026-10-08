#pragma once

inline juce::var checkEQDraftPreview()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Uncommitted static EQ proposal audition");
    bool parity=true,unchanged=true,cleanup=true,guards=true;double maximumError=0;juce::Array<juce::var> cases;
    const auto proposal=[](int type)
    {
        juce::Array<juce::var> entries;auto* band=new juce::DynamicObject();band->setProperty("type",type);band->setProperty("frequency",1000);band->setProperty("gain",6);band->setProperty("q",.8);band->setProperty("slope",3);entries.add(band);return juce::var(entries);
    };
    const auto neutral=[](OpenStudioEQ& eq){for(auto& band:eq.bands)band.enabled.store(0);eq.autoGain.store(0);};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})for(int type:{0,1,2,3,4})
    {
        auto source=std::make_unique<OpenStudioEQ>(true),committed=std::make_unique<OpenStudioEQ>(true);
        neutral(*source);neutral(*committed);auto& b=committed->bands[0];b.enabled.store(1);b.type.store(static_cast<float>(type));b.freq.store(1000);b.gain.store(6);b.q.store(.8f);b.slope.store(3);
        source->prepareToPlay(rate,127);committed->prepareToPlay(rate,127);
        juce::MemoryBlock before,after;source->getStateInformation(before);
        const auto started=source->startDraftPreview("draft",proposal(type),before.toBase64Encoding());guards=guards&&static_cast<bool>(started["success"]);
        juce::AudioBuffer<float> a(2,127),bAudio(2,127);juce::MidiBuffer midi;
        double error=0,difference=0;const int samples=juce::roundToInt(rate*.25);
        for(int pos=0;pos<samples;pos+=127)
        {
            for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)
            {const float sample=static_cast<float>(.02*std::sin((pos+i)*2*juce::MathConstants<double>::pi*(ch?1300:700)/rate));a.setSample(ch,i,sample);bAudio.setSample(ch,i,sample);}
            source->processBlock(a,midi);committed->processBlock(bAudio,midi);
            if(pos>rate*.15)for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)error=juce::jmax(error,std::abs(static_cast<double>(a.getSample(ch,i)-bAudio.getSample(ch,i))));
        }
        maximumError=juce::jmax(maximumError,error);parity=parity&&error<2e-5;
        source->getStateInformation(after);unchanged=unchanged&&before==after&&source->getLatencySamples()==0;
        source->draftPreview.command("draft",true);
        for(int block=0;block<juce::roundToInt(rate*.1/127)+2;++block){a.clear();source->processBlock(a,midi);}
        a.clear();a.setSample(0,0,.1f);source->processBlock(a,midi);difference=std::abs(a.getSample(0,0)-.1);
        cleanup=cleanup&&difference<1e-7&&!source->draftPreview.requested();
        auto* item=new juce::DynamicObject();item->setProperty("sampleRate",rate);item->setProperty("shape",type);item->setProperty("maximumSettledError",error);cases.add(item);
    }
    auto source=std::make_unique<OpenStudioEQ>(true);neutral(*source);source->prepareToPlay(48000,512);
    juce::MemoryBlock state;source->getStateInformation(state);const auto baseline=state.toBase64Encoding();
    guards=guards&&!static_cast<bool>(source->startDraftPreview("bad",proposal(0),"stale")["success"]);
    source->bands[2].enabled.store(1);source->bands[2].dynamicEnabled.store(1);
    guards=guards&&source->canPreviewDraft();source->bands[2].enabled.store(0);source->bands[2].dynamicEnabled.store(0);
    source->getStateInformation(state);
    guards=guards&&static_cast<bool>(source->startDraftPreview("change",proposal(0),state.toBase64Encoding())["success"]);
    juce::AudioBuffer<float> audio(2,512);audio.clear();juce::MidiBuffer midi;source->processBlock(audio,midi);
    source->outputGain.store(1);for(int block=0;block<8;++block)source->processBlock(audio,midi);
    const bool changed=!source->draftPreview.requested()&&!static_cast<bool>(source->draftPreview.command("change",false)["active"]);
    source->outputGain.store(0);source->getStateInformation(state);source->startDraftPreview("offline",proposal(0),state.toBase64Encoding());
    source->setNonRealtime(true);audio.clear();source->processBlock(audio,midi);const bool offline=!source->draftPreview.requested();source->setNonRealtime(false);
    source->startDraftPreview("lease",proposal(0),state.toBase64Encoding());
    for(int block=0;block<580;++block){audio.clear();source->processBlock(audio,midi);}
    const bool expired=!source->draftPreview.requested()&&static_cast<int>(source->draftPreview.command("lease",false)["reason"])==3;
    BuiltInEQDraftPreview publication;publication.reset(48000);std::atomic<bool> done{false};
    std::thread writer([&]{for(int i=0;i<150;++i){BuiltInEQDraftPreview::Plan plan;plan.rate=48000;plan.fingerprint=123;plan.stages=1;plan.coefficients[0]={.8f,0,0,0,0};const auto id=juce::String(i);publication.start(id,plan);publication.command(id,false);publication.command(id,true,i%2==0);}done.store(true);});
    bool publicationFinite=true;int blocks=0;
    while(!done.load()||blocks<1000){for(int ch=0;ch<2;++ch)for(int i=0;i<512;++i)audio.setSample(ch,i,.1f);publication.beginBlock(512,48000,123,true,false);publication.process(audio);for(int ch=0;ch<2;++ch)for(int i=0;i<512;++i)publicationFinite=publicationFinite&&std::isfinite(audio.getSample(ch,i))&&std::abs(audio.getSample(ch,i))<=.100001f;++blocks;}
    writer.join();
    result->setProperty("cases",cases);result->setProperty("maximumSettledError",maximumError);result->setProperty("committedParity",parity);
    result->setProperty("stateAndLatencyUnchanged",unchanged);result->setProperty("stopRestoresDry",cleanup);result->setProperty("guards",guards);
    result->setProperty("settingChangeCancels",changed);result->setProperty("offlineCancels",offline);result->setProperty("leaseExpires",expired);
    result->setProperty("boundedConcurrentPublication",publicationFinite);
    result->setProperty("pass",parity&&unchanged&&cleanup&&guards&&changed&&offline&&expired&&publicationFinite);return result;
}

inline juce::var checkEQDraftUpdates()
{
    auto* result=new juce::DynamicObject();bool guards=true,neutral=true,finite=true;double settled=0;juce::Array<juce::var> cases;
    const auto proposal=[](double frequency,double gain,double q){auto* band=new juce::DynamicObject();band->setProperty("frequency",frequency);band->setProperty("gain",gain);band->setProperty("q",q);return juce::var(juce::Array<juce::var>{juce::var(band)});};
    for(double rate:{44100.0,48000.0,96000.0,192000.0})
    {
        auto preview=std::make_unique<OpenStudioEQ>(true),committed=std::make_unique<OpenStudioEQ>(true);
        for(auto* eq:{preview.get(),committed.get()}){for(auto& band:eq->bands)band.enabled.store(0);eq->prepareToPlay(rate,127);}
        committed->bands[0].enabled.store(1);committed->bands[0].type.store(0);committed->bands[0].freq.store(3000);committed->bands[0].gain.store(-9);committed->bands[0].q.store(2);
        juce::MemoryBlock before,after;preview->getStateInformation(before);const auto baseline=before.toBase64Encoding();
        guards=guards&&static_cast<bool>(preview->startDraftPreview("grab",proposal(1000,6,1),baseline)["success"]);
        juce::AudioBuffer<float> a(2,127),b(2,127);juce::MidiBuffer midi;bool updated=false;double error=0;
        for(int pos=0;pos<rate*.4;pos+=127)
        {
            if(!updated&&pos>rate*.12)
            {
                guards=guards&&!static_cast<bool>(preview->startDraftPreview("wrong",proposal(800,-6,.7),baseline,true)["success"]);
                for(int update=0;update<5;++update)guards=guards&&static_cast<bool>(preview->startDraftPreview("grab",proposal(2000+250*update,-5-update,2),baseline,true)["success"]);
                updated=true;
            }
            for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i){const auto v=static_cast<float>(.01*std::sin((pos+i)*(ch?1700:3200)*juce::MathConstants<double>::twoPi/rate));a.setSample(ch,i,v);b.setSample(ch,i,v);}
            preview->processBlock(a,midi);committed->processBlock(b,midi);
            for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i){finite=finite&&std::isfinite(a.getSample(ch,i))&&std::abs(a.getSample(ch,i))<.1f;if(pos>rate*.25)error=juce::jmax(error,std::abs(static_cast<double>(a.getSample(ch,i)-b.getSample(ch,i))));}
        }
        settled=juce::jmax(settled,error);preview->getStateInformation(after);neutral=neutral&&before==after&&preview->getLatencySamples()==0;
        preview->draftPreview.command("grab",true,true);a.clear();a.setSample(0,0,.1f);preview->processBlock(a,midi);guards=guards&&!preview->draftPreview.requested()&&std::abs(a.getSample(0,0)-.1f)<1e-7;
        guards=guards&&!static_cast<bool>(preview->startDraftPreview("grab",proposal(1000,6,1),baseline,true)["success"]);
        auto* row=new juce::DynamicObject();row->setProperty("sampleRate",rate);row->setProperty("settledCommittedError",error);cases.add(row);
    }
    BuiltInEQDraftPreview stage;stage.reset(48000);BuiltInEQDraftPreview::Plan plan;plan.rate=48000;plan.fingerprint=42;plan.stages=1;plan.coefficients[0]={.5f,0,0,0,0};
    stage.start("transition",plan);juce::AudioBuffer<float> audio(2,2400);for(int ch=0;ch<2;++ch)for(int i=0;i<2400;++i)audio.setSample(ch,i,1);
    stage.beginBlock(2400,48000,42,true,false);stage.process(audio);plan.coefficients[0][0]=1.5f;stage.start("transition",plan,true);
    double crossfadeError=0;int position=0;
    for(int block=0;block<12;++block){audio.setSize(2,127,false,false,true);for(int ch=0;ch<2;++ch)for(int i=0;i<127;++i)audio.setSample(ch,i,1);stage.beginBlock(127,48000,42,true,false);stage.process(audio);for(int i=0;i<127;++i){const double expected=.5+juce::jmin(1.0,static_cast<double>(++position)/960);crossfadeError=juce::jmax(crossfadeError,std::abs(audio.getSample(0,i)-expected));}}
    result->setProperty("plugin","Continuous uncommitted EQ draft updates");result->setProperty("cases",cases);result->setProperty("settledCommittedError",settled);result->setProperty("crossfadeError",crossfadeError);result->setProperty("stateAndLatencyNeutral",neutral);result->setProperty("finite",finite);result->setProperty("sessionCoalescingAndImmediateStop",guards);
    result->setProperty("pass",guards&&neutral&&finite&&settled<2e-5&&crossfadeError<2e-5);return result;
}
