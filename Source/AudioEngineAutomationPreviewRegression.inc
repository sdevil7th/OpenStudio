juce::var AudioEngine::runAutomationPreviewRegression()
{
    getDeviceManager().closeAudioDevice();
    const auto id = addTrack("preview-regression", "audio");
    auto* track = trackMap[id]; track->prepareToPlay(48000.0, 64);
    juce::Array<juce::var> checks;
    const auto check = [&](const char* name, bool value) { auto* item = new juce::DynamicObject(); item->setProperty("name", name); item->setProperty("pass", value); checks.add(juce::var(item)); };
    juce::AudioBuffer<float> before(2, 64), after(2, 64); juce::MidiBuffer midi;
    const auto fill = [](auto& buffer) { for (int channel = 0; channel < buffer.getNumChannels(); ++channel) juce::FloatVectorOperations::fill(buffer.getWritePointer(channel), 1.0f, buffer.getNumSamples()); };
    fill(before); track->processBlock(before, midi);
    check("empty_off_lane_can_audition", setAutomationPreview(id, "volume", -6.0f) && track->getVolumeAutomation().getNumPoints() == 0);
    fill(after); track->processBlock(after, midi);
    bool audible = true;
    for (int channel = 0; channel < 2; ++channel) for (int sample = 0; sample < 64; ++sample) audible = audible && std::abs(after.getSample(channel, sample) - before.getSample(channel, sample) * juce::Decibels::decibelsToGain(-6.0f)) < 1.0e-6;
    check("audible_without_changing_manual_fader", audible && track->getVolume() == 0.0f);
    check("cancel_empty_lane", clearAutomationPreviews() && !track->getVolumeAutomation().hasPlaybackData());
    check("plugin_insert", addTrackBuiltInFX(id, "OpenStudio Gain Phase", false));
    const auto parameters = getPluginParameters(id, 0, false);
    juce::String parameterId, meaning;
    if (const auto* values = parameters.getArray()) for (const auto& parameter : *values) if (parameter["name"].toString() == "Gain")
    {
        parameterId = parameter["automationId"].toString();
        if (parameterId.isEmpty()) parameterId = static_cast<bool>(parameter["builtIn"])
            ? "builtin_track_0_" + juce::URL::addEscapeChars(parameter["paramId"].toString(), true)
            : "plugin_track_0_" + parameter["index"].toString();
        meaning = parameter["meaningSignature"].toString();
    }
    const auto target = track->resolveAutomationTarget(parameterId, true);
    bool restoredOff = false, restoredRead = false, snapshot = false;
    if (target)
    {
        const auto original = track->getAutomationDefaultValue(*target);
        const bool started = setAutomationPreview(id, parameterId, .8f, meaning);
        restoredOff = started && std::abs(track->getAutomationDefaultValue(*target) - .8f) < 1.0e-6 && clearAutomationPreviews()
            && std::abs(track->getAutomationDefaultValue(*target) - original) < 1.0e-6;
        target->list->setPoints({ { 0, .3f }, { 1, .7f } }); target->list->setMode(AutomationMode::Read); setTransportPosition(0.0);
        restoredRead = setAutomationPreview(id, parameterId, .9f, meaning) && clearAutomationPreviews()
            && std::abs(track->getAutomationDefaultValue(*target) - .3f) < 1.0e-6 && target->list->getNumPoints() == 2;
        const auto originalState = getPluginState(id, 0, false);
        snapshot = setAutomationPreview(id, parameterId, .9f, meaning) && getPluginState(id, 0, false) == originalState && automationPreviews.empty();
        target->list->setMode(AutomationMode::Touch);
        check("write_modes_reject_preview", !setAutomationPreview(id, parameterId, .6f, meaning)); target->list->setMode(AutomationMode::Read);
        check("wrong_meaning_rejected", !setAutomationPreview(id, parameterId, .6f, "wrong parameter meaning"));
    }
    check("off_restores_original_plugin_value", restoredOff); check("read_restores_underlying_curve", restoredRead);
    check("state_snapshot_cancels_and_excludes_preview", snapshot);
    // Simulate Read winning the race after an accepted edit, before its event
    // is built. Capture must retain the UI request on every built-in route.
    for (const auto& chain : { juce::String("track"), juce::String("input"), juce::String("master"), juce::String("monitor") })
    {
        const bool inserted = chain == "track" || (chain == "input" ? addTrackBuiltInFX(id, "OpenStudio Gain Phase", true)
            : chain == "master" ? addMasterBuiltInFX("OpenStudio Gain Phase") : addMonitoringFX("OpenStudio Gain Phase"));
        const bool readWon = inserted && setBuiltInPluginParam(id, chain, 0, "gain", 0.0f);
        const auto captured = builtInParameterEdit(id, chain, 0, "gain", "value", -12.0f);
        check(("accepted_builtin_value_survives_read_race_" + chain).toRawUTF8(), readWon
            && captured["param"].toString().isNotEmpty() && std::abs(static_cast<float>(captured["value"]) - 4.0f / 7.0f) < 1.0e-6f);
    }
    if (target)
    {
        target->list->setWrittenValue(.8f);
        const auto captured = builtInParameterEdit(id, "track", 0, "gain", "value", -9.0f);
        check("builtin_native_edit_updates_punch_held_value", std::abs(target->list->eval(2.0) - static_cast<float>(captured["value"])) < 1.0e-6f);
        target->list->clearWrittenValue();
    }
    {
        const auto previousMappings = midiLearnMappings;
        midiLearnMappings = { {74, id, "track", 0, -1, "gain"}, {75, id, "track", 1, 3, {}}, {76, id, "input", 1, 3, {}} };
        auto* object = new juce::DynamicObject(); object->setProperty("trackId", id); object->setProperty("param", "plugin_track_1_3");
        object->setProperty("chain", "track"); object->setProperty("fxIndex", 1); object->setProperty("paramIndex", 3);
        object->setProperty("clearFlags", CLAP_PARAM_CLEAR_AUTOMATIONS);
        const juce::var clear(object);
        handlePluginParameterReferenceClear(clear);
        check("clear_automation_preserves_midi_references", midiLearnMappings.size() == 3);
        const float initial = target ? track->getAutomationDefaultValue(*target) : 0;
        handleMIDIMessage("fixture", 1, juce::MidiMessage::controllerEvent(1, 74, 127));
        object->setProperty("clearFlags", CLAP_PARAM_CLEAR_ALL);
        handlePluginParameterReferenceClear(clear);
        juce::MessageManager::getInstance()->runDispatchLoopUntil(20);
        check("clear_all_removes_only_matching_midi_references", midiLearnMappings.size() == 2
            && std::none_of(midiLearnMappings.begin(), midiLearnMappings.end(), [](const auto& mapping) { return mapping.ccNumber == 75; }));
        check("queued_midi_updates_cannot_reintroduce_cleared_references", target && track->getAutomationDefaultValue(*target) == initial);
        midiLearnMappings = previousMappings; midiLearnEpoch.fetch_add(1);
    }
    check("midi_preview_scope_is_explicit", !setAutomationPreview(id, "midi_cc_7", 50.0f));
    {
        auto& volume=track->getVolumeAutomation();volume.setPoints({{0,-12},{4,-12}});volume.setMode(AutomationMode::Read);
        isPlaying.store(true);isRecordMode.store(false);setTransportPosition(2.0);
        const bool audition=setAutomationPreview(id,"volume",-6.0f);
        const auto punched=punchAutomationPreviews(id,getAutomationPreviewGeneration());
        check("punch_requires_current_preview_generation", punchAutomationPreviews(id,getAutomationPreviewGeneration()+1).isVoid());
        check("punch_moves_preview_to_latched_writer_without_changing_points", audition && !punched.isVoid() && volume.hasWrittenValue()
            && !volume.hasPreview() && volume.getMode() == AutomationMode::Latch && volume.getNumPoints() == 2 && volume.eval(2.0) == -6.0f);
        track->setVolume(-3.0f);check("punch_fader_updates_held_writer",volume.eval(2.0) == -3.0f);
        check("punch_cancel_restores_read",clearAutomationPreviews() && !volume.hasWrittenValue() && volume.eval(2.0) == -12.0f && volume.getMode() == AutomationMode::Read);
        check("join_scheduled_hold",setAutomationWriteHold(id,"volume",-6.0f,3.0,{},-1) && volume.eval(2.999) == -12.0f && volume.eval(3.0) == -6.0f);
        std::array<float,64> values {};volume.evalBlock(3.0-5.0/48000.0,48000.0,64,values.data());
        bool crossing=true;
        for(size_t sample=0;sample<values.size();++sample)crossing=crossing && values[sample] == (sample<5 ? -12.0f : -6.0f);
        check("join_crosses_inside_audio_block",crossing);
        struct Sink { std::array<float,64> values {};std::array<int,64> offsets {};int count=0; } sink;
        const auto emit=[](void* context,int offset,float value) {
            auto& queue=*static_cast<Sink*>(context);if(queue.count>=64)return false;
            queue.values[static_cast<size_t>(queue.count)]=value;queue.offsets[static_cast<size_t>(queue.count++)]=offset;return true;
        };
        const int rejected=volume.deliverSampleAccuratePoints(3.0-5.0/48000.0,48000.0,64,true,&sink,emit);
        bool queueCrossing=rejected==0 && sink.count>=2;
        for(int sample=0;sample<64;++sample) {
            int segment=0;while(segment<sink.count-2 && sink.offsets[static_cast<size_t>(segment+1)]<=sample)++segment;
            const int left=sink.offsets[static_cast<size_t>(segment)],right=sink.offsets[static_cast<size_t>(segment+1)];
            const float fraction=static_cast<float>(sample-left)/static_cast<float>(juce::jmax(1,right-left));
            const float value=sink.values[static_cast<size_t>(segment)]+fraction*(sink.values[static_cast<size_t>(segment+1)]-sink.values[static_cast<size_t>(segment)]);
            queueCrossing=queueCrossing && std::abs(value-values[static_cast<size_t>(sample)])<1.0e-6f;
        }
        check("join_crosses_inside_sdk_queue",queueCrossing);
        sink.count=0;
        const int largeRejected=volume.deliverSampleAccuratePoints(3.0-100.0/48000.0,48000.0,2048,true,&sink,emit);
        check("join_linear_queue_bounded_large_buffer",largeRejected==0 && sink.count==4 && sink.offsets[1]==99 && sink.offsets[2]==100
            && sink.values[1]==-12 && sink.values[2]==-6 && sink.count*128<8192);
        check("join_clear_restores_read_curve",clearAutomationWriteHold(id,"volume") && !volume.hasWrittenValue() && volume.eval(3.0) == -12.0f);
        isPlaying.store(false);volume.setMode(AutomationMode::Off);volume.clear();track->setVolume(0.0f);setTransportPosition(0);
    }
    {
        const auto previousMappings = midiLearnMappings;
        const bool inserted = addTrackBuiltInFX(id, "OpenStudio Gain Phase", false)
            && addTrackBuiltInFX(id, "OpenStudio Gain Phase", false);
        midiLearnMappings = { {71, id, "track", 0, -1, "gain"}, {72, id, "track", 1, -1, "gain"},
            {73, id, "track", 2, -1, "gain"}, {74, id, "input", 1, -1, "gain"} };
        startMIDILearnForBuiltIn(id, "track", 1, "gain");
        const auto oldEpoch = midiLearnEpoch.load();
        const bool moved = inserted && reorderTrackFX(id, 0, 2);
        check("midi_learn_follows_fx_reorder_and_pending_learn", moved && midiLearnMappings[0].pluginIndex == 2
            && midiLearnMappings[1].pluginIndex == 0 && midiLearnMappings[2].pluginIndex == 1 && midiLearnMappings[3].pluginIndex == 1
            && midiLearnPluginIndex == 0 && midiLearnEpoch.load() > oldEpoch);
        const bool restored = moved && reorderTrackFX(id, 2, 0);
        check("midi_learn_inverse_reorder_restores_references", restored && midiLearnMappings[0].pluginIndex == 0
            && midiLearnMappings[1].pluginIndex == 1 && midiLearnMappings[2].pluginIndex == 2 && midiLearnPluginIndex == 1);
        const bool removed = restored && removeTrackFX(id, 1);
        check("removed_fx_midi_learn_is_retired_and_later_indices_shift", removed && midiLearnMappings.size() == 3
            && midiLearnMappings[0].pluginIndex == 0 && midiLearnMappings[1].ccNumber == 73 && midiLearnMappings[1].pluginIndex == 1
            && midiLearnMappings[2].chainType == "input" && midiLearnMappings[2].pluginIndex == 1 && !midiLearnActive.load());
        midiLearnMappings = previousMappings; midiLearnEpoch.fetch_add(1);
    }
    TrackProcessor::SendConfig send; send.destTrackId = "preview-bus"; send.level = 1.0f; send.enabled = true;
    track->replaceSends({send});
    const bool sendStarted = setAutomationPreview(id, "send_preview-bus_level", .25f);
    juce::AudioBuffer<float> source(2, 64), destination(2, 64); fill(source); destination.clear();
    const auto sends = track->getRealtimeSendSnapshot();
    if (!sends.empty()) track->mixAutomatedSend(sends[0], source, destination, 64, 0.0, 48000.0);
    check("send_preview_binds_and_sounds", sendStarted && !sends.empty() && sends[0].hasAutomationBinding() && std::abs(destination.getSample(0, 0) - .25f * std::sqrt(.5f)) < 1.0e-6);
    clearAutomationPreviews();
    const bool manualSendTrim=setAutomationTrimValue(id,-6.0f,"send_preview-bus_trim");
    const auto sendReadback=getTrackSends(id);
    check("manual_send_trim_readback",manualSendTrim && sendReadback.getArray() != nullptr && sendReadback.getArray()->size()==1
        && std::abs(static_cast<double>(sendReadback.getArray()->getReference(0)["trimDB"])+6.0)<1.0e-6);
    destination.clear();
    if(!sends.empty())track->mixAutomatedSend(sends[0],source,destination,64,0,48000);
    check("manual_send_trim_sounds",manualSendTrim && std::abs(destination.getSample(0,0)-std::sqrt(.5f)*juce::Decibels::decibelsToGain(-6.0f))<1.0e-6);
    const auto trimTarget=track->resolveAutomationTarget("send_preview-bus_trim",true);
    if(trimTarget) {trimTarget->list->setPoints({{0,-6},{.0005,-12}});trimTarget->list->setInterpolation(AutomationInterpolation::Discrete);trimTarget->list->setMode(AutomationMode::Read);}
    destination.clear();if(!sends.empty())track->mixAutomatedSend(sends[0],source,destination,64,0,48000);
    check("send_trim_has_sample_timing",trimTarget && std::abs(destination.getSample(0,23)-std::sqrt(.5f)*juce::Decibels::decibelsToGain(-6.0f))<1.0e-6
        && std::abs(destination.getSample(0,24)-std::sqrt(.5f)*juce::Decibels::decibelsToGain(-12.0f))<1.0e-6);
    track->replaceSends({}); check("deleted_send_cancels_safely", clearAutomationPreviews());
    const bool pending = setAutomationPreview(id, "volume", -3.0f);
    removeTrack(id); check("deleted_track_list_lifetime", pending && clearAutomationPreviews());
    bool pass = true; for (const auto& item : checks) pass = pass && static_cast<bool>(item["pass"]);
    auto* result = new juce::DynamicObject(); result->setProperty("name", "automation_preview"); result->setProperty("pass", pass); result->setProperty("checks", checks); result->setProperty("audioQuality", "not_asserted"); return juce::var(result);
}
