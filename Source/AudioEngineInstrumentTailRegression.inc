    for (int kind = 0; kind < 3; ++kind)
    {
        const juce::String name = kind == 0 ? "OpenStudio Basic Synth" : kind == 1 ? "OpenStudio Piano" : "OpenStudio Clean Guitar";
        const auto source = addTrack("instrument-tail-" + juce::String(kind), "midi");
        bool ready = addTrackBuiltInFX(source, name, false);
        setTrackVolume(source, 0);
        ready = setBuiltInPluginParam(source, "track", 0, "releaseMs", kind == 2 ? 2000.0f : 5000.0f) && ready;
        if (kind == 0) ready = setBuiltInPluginParam(source, "track", 0, "sustain", 1) && ready;
        if (kind == 1) ready = setBuiltInPluginParam(source, "track", 0, "performanceMode", 1)
            && setBuiltInPluginParam(source, "track", 0, "releaseVelocity", 1) && ready;
        setTrackMIDIClips(source, R"json([{"id":"tail-note","startTime":0,"duration":0.25,"events":[{"type":"noteOn","timestamp":0,"note":60,"velocity":127,"channel":1},{"type":"cc","timestamp":0.02,"controller":66,"value":127,"channel":1}]}])json");
        const auto* track = trackMap[source];
        // Compare contracts at the export sample rate: float envelope depletion
        // is rate-dependent, including its conservative query bound.
        const auto tailOwner = getPublishedBuiltInProcessor(source, "track", 0);
        if (tailOwner.processor) {
            tailOwner.processor->setRateAndBufferSizeDetails(48000, 512);
            tailOwner.processor->prepareToPlay(48000, 512);
        }
        const double ordinaryTail = track->getOfflineRenderTailLengthSeconds();
        const juce::String automation = "builtin_track_0_releaseMs";
        setAutomationPoints(source, automation, R"([{"time":0,"value":1},{"time":0.25,"value":1}])");
        setAutomationMode(source, automation, "read");
        const double automatedTail = track->getOfflineRenderTailLengthSeconds();
        ready = ready && automatedTail >= ordinaryTail;
        const auto file = outputDirectory.getChildFile("instrument-host-tail-" + juce::String(kind) + ".wav");
        juce::AudioBuffer<float> audio; double rate = 0;
        ready = renderProject("stem:" + source, 0, .25, file.getFullPathName(), "wav", 48000, 32, 2, false, true, 0, false)
            && readAudioFileForParity(file, audio, rate) && ready;
        const int silenceSamples = juce::roundToInt(rate * .5);
        const double duration = rate > 0 ? audio.getNumSamples() / rate : 0;
        const float finalPeak = audio.getNumSamples() >= silenceSamples && silenceSamples > 0
            ? audio.getMagnitude(audio.getNumSamples() - silenceSamples, silenceSamples) : 1.0f;
        addCheck("instrument_host_release_tail_" + juce::String(kind), ready && duration >= .25 + automatedTail - .001
            && audio.getNumSamples() > 0 && audio.getMagnitude(0, audio.getNumSamples()) > 1e-5f && finalPeak < 1e-6f,
            "The native export planner reserves an automation-safe release, releases hold pedals at content end, and reaches independent -120 dBFS silence before the end of the exported file.", finalPeak);
        removeTrack(source);
    }

    for (int engine = 0; engine < 2; ++engine)
    {
        const auto source = addTrack("drum-tail-" + juce::String(engine), "midi");
        bool ready = addTrackBuiltInFX(source, "OpenStudio Drums", false);
        setTrackVolume(source, 0);
        ready = setBuiltInPluginParam(source, "track", 0, "articulationEngine", static_cast<float>(engine)) && ready;
        setTrackMIDIClips(source, R"json([{"id":"crash-tail","startTime":0,"duration":0.25,"events":[{"type":"noteOn","timestamp":0,"note":49,"velocity":127,"channel":10}]}])json");
        const juce::String automation = "builtin_track_0_pieceDecay6";
        setAutomationPoints(source, automation, R"([{"time":0,"value":1},{"time":0.25,"value":1}])");
        setAutomationMode(source, automation, "read");
        const double tail = trackMap[source]->getOfflineRenderTailLengthSeconds();
        const auto file = outputDirectory.getChildFile("drum-host-tail-" + juce::String(engine) + ".wav");
        juce::AudioBuffer<float> audio; double rate = 0;
        ready = renderProject("stem:" + source, 0, .25, file.getFullPathName(), "wav", 48000, 32, 2, false, true, 0, false)
            && readAudioFileForParity(file, audio, rate) && ready;
        const int endWindow = juce::roundToInt(rate * .5);
        const bool length = rate > 0 && audio.getNumSamples() >= juce::roundToInt((tail + .25) * rate) - 1;
        const float finalPeak = endWindow > 0 && audio.getNumSamples() >= endWindow ? audio.getMagnitude(audio.getNumSamples() - endWindow, endWindow) : 1;
        const float latePeak = audio.getNumSamples() > 96000 ? audio.getMagnitude(24000, 72000) : 0;
        addCheck("drum_host_release_tail_" + juce::String(engine), ready && length && tail >= 68 && finalPeak < 1e-6f && latePeak > 1e-5f,
            "Automatic native export preserves the crash after CC123, reserves the automated decay maximum, and finishes below -120 dBFS.", finalPeak);
        removeTrack(source);
    }

    for (const auto* name : {"OpenStudio EQ", "OpenStudio Preamp", "OpenStudio Saturator", "OpenStudio Chorus", "OpenStudio Pitch Correct", "OpenStudio Basic Synth", "OpenStudio Piano", "OpenStudio Clean Guitar", "OpenStudio Drums"})
    {
        const auto source = addTrack("signal-state-" + juce::String(name), "audio");
        bool ready = addTrackBuiltInFX(source, name, false);
        const auto modern = getBuiltInPluginState(source, "track", 0);
        juce::MemoryBlock bytes; ready = bytes.fromBase64Encoding(modern["fullState"].toString()) && ready;
        auto tree = juce::ValueTree::readFromData(bytes.getData(), bytes.getSize()); tree.removeProperty("signalPath", nullptr);
        juce::MemoryBlock old; { juce::MemoryOutputStream stream(old, false); tree.writeToStream(stream); }
        juce::DynamicObject::Ptr legacy = new juce::DynamicObject(); legacy->setProperty("name", name); legacy->setProperty("fullState", old.toBase64Encoding());
        const auto selected = [&] { return static_cast<int>(getBuiltInPluginState(source,"track",0)["values"]["signalPath"]); };
        ready = ready && selected() == 1 && setBuiltInPluginState(source,"track",0,juce::JSON::toString(juce::var(legacy.get()))) && selected() == 0;
        ready = setBuiltInPluginState(source,"track",0,juce::JSON::toString(modern)) && selected() == 1 && ready;
        auto numeric = modern.clone(); numeric.getDynamicObject()->removeProperty("fullState"); numeric["values"].getDynamicObject()->removeProperty("signalPath");
        ready = setBuiltInPluginState(source,"track",0,juce::JSON::toString(numeric)) && selected() == 0 && ready;
        ready = setBuiltInPluginState(source,"track",0,"{\"factoryDefault\":true}") && selected() == 1 && ready;
        addCheck("signal_path_host_recall_" + juce::String(name), ready, "Native named numeric snapshots and full-state recalls migrate old settings to Legacy; factory and current complete state select Corrected.");
        removeTrack(source);
    }
