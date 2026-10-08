// Control-side binding pins parameter routes with the published processor.
// Instance UUID plus plugin fingerprint survives reorder/undo/project restore,
// while rejecting an envelope restored against a different plugin.
void AudioEngine::bindStageAutomation(ActiveFXStageSlot& slot, bool monitoring)
{
    const juce::ScopedLock bindingGuard(stageAutomationBindingLock);
    const auto fingerprint = juce::MD5((slot.type + "|" + slot.pluginPath + "|" + slot.pluginFormat).toUTF8()).toHexString();
    registerBuiltInInstanceIdentity(slot.processor, juce::Uuid(juce::MD5((slot.automationKey + fingerprint).toUTF8()).toHexString()).toString());
    const bool modern = !slot.processor->getParameters().isEmpty();
    slot.automationPrefix = juce::String(modern ? "plugin_" : "builtin_")
        + (monitoring ? "monitor_" : "master_") + slot.automationKey + "_" + fingerprint + ":";
    slot.parameterCapture = std::make_shared<PluginParameterCapture>(slot.processor, pluginAutomationClock);
    const auto add = [&] (int index, const juce::String& param, OpenStudioBuiltInAutomationDescriptor descriptor,
                          float value, bool discrete) {
        auto route = std::make_shared<StageAutomationRoute>();
        route->id = slot.automationPrefix + (param.isEmpty() ? juce::String(index) : param);
        route->index = index; route->builtInParam = param; route->descriptor = descriptor;
        getOpenStudioCLAPParameterReferenceGeneration(slot.processor.get(), index, route->referenceGeneration);
        if (juce::isPositiveAndBelow(index, slot.processor->getParameters().size()))
            route->parameterMeaning = pluginParameterMeaning(slot.processor.get(), index);
        if (juce::isPositiveAndBelow(index, slot.processor->getParameters().size()))
            if (const auto* named = dynamic_cast<juce::AudioProcessorParameterWithID*>(slot.processor->getParameters()[index]))
                route->editorParam = named->paramID;
        auto& list = stageAutomationLists[route->id];
        if (!list) { list = std::make_shared<AutomationList>(); list->setDefaultValue(value); }
        list->setInterpolation(discrete ? AutomationInterpolation::Discrete : AutomationInterpolation::Linear);
        route->list = list;
        route->editorState = slot.parameterCapture->stateFor(index);
        slot.automationRoutes.push_back(std::move(route));
    };
    if (modern)
    {
        const auto& parameters = slot.processor->getParameters();
        for (int index = 0; index < parameters.size(); ++index)
        {
            auto* parameter = parameters[index];
            if (!parameter || !parameter->isAutomatable() || (static_cast<int>(parameter->getCategory()) >> 16) == 2) continue;
            const auto name = parameter->getName(128).toLowerCase();
            if (name.startsWith("midi cc") || name.startsWith("cc #") || name.contains("midi cc ") || name.contains("midi ch")) continue;
            add(index, {}, {}, parameter->getValue(), parameter->isDiscrete());
        }
    }
    else
    {
        const auto schema = describeBuiltInProcessor(slot.processor.get(), monitoring ? "monitor" : "master", 0);
        if (const auto* parameters = schema["parameters"].getArray())
            for (const auto& parameter : *parameters)
            {
                OpenStudioBuiltInAutomationDescriptor descriptor;
                const auto id = parameter["id"].toString();
                if (!isOpenStudioBuiltInParameterEligible(slot.processor.get(), id, parameter.getDynamicObject())) continue;
                descriptor.minimum = static_cast<float>(static_cast<double>(parameter["min"]));
                descriptor.maximum = static_cast<float>(static_cast<double>(parameter["max"]));
                descriptor.currentValue = static_cast<float>(static_cast<double>(parameter["value"]));
                descriptor.discrete = parameter["type"].toString() == "enum" || parameter["type"].toString() == "toggle";
                descriptor.curve = getOpenStudioBuiltInParameterCurve(slot.processor.get(), id);
                if (std::isfinite(descriptor.minimum) && std::isfinite(descriptor.maximum) && descriptor.maximum > descriptor.minimum)
                    add(-1, id, descriptor, openStudioBuiltInValueToNormalized(descriptor, descriptor.currentValue), descriptor.discrete);
            }
    }
}

AutomationList* AudioEngine::resolveMasterAutomation(const juce::String& id) const
{
    if (id == "trim_volume") return const_cast<AutomationList*>(&masterTrimVolumeAutomation);
    if (id == "volume") return const_cast<AutomationList*>(&masterVolumeAutomation);
    if (id == "pan") return const_cast<AutomationList*>(&masterPanAutomation);
    const auto stage = std::atomic_load(id.startsWith("builtin_monitor_") || id.startsWith("plugin_monitor_")
        ? &realtimeMonitoringFXSnapshot : &realtimeMasterFXSnapshot);
    if (stage) for (const auto& slot : stage->slots) for (const auto& route : slot.automationRoutes)
        if (route->id == id) return route->list.get();
    return nullptr;
}

juce::String AudioEngine::getAutomationValueText(const juce::String& trackId, const juce::String& id, float value)
{
    if (!std::isfinite(value)) return {};
    const juce::ScopedTryLock graphGuard(mainProcessorGraph->getCallbackLock());
    if (!graphGuard.isLocked()) return {};
    const auto text = [value] (juce::AudioProcessor* processor, int index) -> juce::String {
        if (!processor || !juce::isPositiveAndBelow(index, processor->getParameters().size())) return {};
        const juce::ScopedTryLock guard(processor->getCallbackLock());
        if (!guard.isLocked()) return {};
        auto* param = processor->getParameters()[index];
        auto result = param->getText(juce::jlimit(0.0f, 1.0f, value), 128);
        const auto unit = param->getLabel();
        if (unit.isNotEmpty() && !result.containsIgnoreCase(unit)) result += " " + unit;
        return result;
    };
    if (trackId == "master")
    {
        for (const auto& stage : { std::atomic_load(&realtimeMasterFXSnapshot), std::atomic_load(&realtimeMonitoringFXSnapshot) })
            if (stage) for (const auto& slot : stage->slots) for (const auto& route : slot.automationRoutes)
                if (route->id == id && route->builtInParam.isEmpty()) return text(slot.processor.get(), route->index);
    }
    else if (const auto found = trackMap.find(trackId); found != trackMap.end() && found->second)
    {
        auto* track = found->second;
        if (const auto target = track->resolveAutomationTarget(id, false); target && target->kind == TrackProcessor::AutomationTarget::Kind::PluginParameter && target->builtInParamId.isEmpty())
            return text(target->fxIndex < 0 ? track->getInstrument() : target->isInputFX ? track->getInputFXProcessor(target->fxIndex)
                : track->getTrackFXProcessor(target->fxIndex), target->paramIndex);
    }
    return {};
}

float AudioEngine::stageAutomationDefault(const juce::String& id) const
{
    const auto stage = std::atomic_load(id.startsWith("builtin_monitor_") || id.startsWith("plugin_monitor_")
        ? &realtimeMonitoringFXSnapshot : &realtimeMasterFXSnapshot);
    if (stage) for (const auto& slot : stage->slots) for (const auto& route : slot.automationRoutes)
        if (route->id == id)
        {
            if (route->builtInParam.isEmpty()) return slot.processor->getParameters()[route->index]->getValue();
            OpenStudioBuiltInAutomationDescriptor descriptor;
            if (getOpenStudioBuiltInAutomationDescriptor(slot.processor.get(), route->builtInParam, descriptor))
                return openStudioBuiltInValueToNormalized(descriptor, descriptor.currentValue);
        }
    return 0.0f;
}

void AudioEngine::applyStageAutomation(const ActiveFXStageSlot& slot, double timeSeconds, int numSamples, double sampleRate)
{
    if (slot.safety->failure.load() != ProcessorSafety::Failure::none) return;
    const bool forceRead = isRendering.load(std::memory_order_relaxed);
    const juce::ScopedTryLock guard(slot.processor->getCallbackLock());
    if (!guard.isLocked()) return;
    try
    {
        for (const auto& route : slot.automationRoutes)
        {
            if (route->editorState) route->editorState->hostAutomating.store(false, std::memory_order_release);
            if (route->builtInParam.isEmpty())
            {
                if (!juce::isPositiveAndBelow(route->index, slot.processor->getParameters().size())) continue;
                uint64_t generation = 0;
                if (getOpenStudioCLAPParameterReferenceGeneration(slot.processor.get(), route->index, generation)
                    && generation != route->referenceGeneration)
                { route->list->setMode(AutomationMode::Off); route->list->clearPreview(); continue; }
            }
            const auto& list = *route->list;
            if (list.hasWrittenValue() && route->editorState && route->editorState->touching.load()
                && route->editorState->captureEpoch.load() == pluginAutomationClock->epoch.load())
                route->list->setWrittenValue(route->editorState->value.load());
            const auto mode = list.getMode();
            const bool editorWriting = !forceRead && route->editorState && route->editorState->touching.load()
                && (mode == AutomationMode::Touch || mode == AutomationMode::Latch);
            if (!(forceRead ? list.shouldPlaybackForRead() : list.shouldPlayback()) || !list.hasPlaybackData() || (editorWriting && !list.hasPreview()))
            { route->lastApplied.store(std::numeric_limits<float>::quiet_NaN()); continue; }
            if (route->builtInParam.isEmpty() && deliverPluginAutomationPoints(slot.processor->getParameters()[route->index], list,
                timeSeconds, sampleRate, slot.bypassed ? 0 : numSamples, route->editorState)) continue;
            const float value = juce::jlimit(0.0f, 1.0f, list.eval(timeSeconds));
            if (!std::isfinite(value)) continue;
            if (route->builtInParam.isNotEmpty())
            {
                if (route->lastApplied.load() == value) continue;
                auto raw = openStudioBuiltInNormalizedToValue(route->descriptor, value);
                if (route->descriptor.discrete) raw = std::round(raw);
                if (!setOpenStudioBuiltInParameterValue(slot.processor.get(), route->builtInParam, raw)) continue;
            }
            else
            {
                auto* parameter = slot.processor->getParameters()[route->index];
                if (!parameter->isAutomatable()) continue;
                if (route->lastApplied.load() == value && std::abs(parameter->getValue() - value) < 1.0e-6f) continue;
                parameter->setValue(value);
            }
            route->lastApplied.store(value);
        }
    }
    catch (...) { slot.safety->markFailure(ProcessorSafety::Failure::exception); }
}

juce::var AudioEngine::getFXStageState(const juce::String& chain)
{
    if (!clearAutomationPreviews()) return {};
    if (chain != "master" && chain != "monitor") return {};
    auto spec = chain == "monitor" ? desiredMonitoringStageSpec : desiredMasterStageSpec;
    syncStageSpecStateFromActive(spec, std::atomic_load(chain == "monitor" ? &realtimeMonitoringFXSnapshot : &realtimeMasterFXSnapshot));
    juce::Array<juce::var> slots;
    for (const auto& slot : spec.slots)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty("automationKey", slot.automationKey);
        item->setProperty("name", slot.name); item->setProperty("type", slot.type);
        item->setProperty("pluginPath", slot.pluginPath); item->setProperty("pluginFormat", slot.pluginFormat);
        item->setProperty("state", slot.serializedState); item->setProperty("bypassed", slot.bypassed);
        item->setProperty("forceFloat", slot.forceFloat);
        slots.add(juce::var(item));
    }
    return juce::var(slots);
}

bool AudioEngine::setFXStageState(const juce::String& chain, const juce::String& json)
{
    if (chain != "master" && chain != "monitor") return false;
    const auto parsed = juce::JSON::parse(json);
    const auto* slots = parsed.getArray();
    if (!slots || slots->size() > static_cast<int>(maxRealtimeStageContinuitySlots)) return false;
    DesiredFXStageSpec spec;
    juce::StringArray keys;
    for (const auto& item : *slots)
    {
        if (!item.isObject()) return false;
        DesiredFXStageSlot slot;
        slot.automationKey = item["automationKey"].toString();
        if (juce::Uuid(slot.automationKey).isNull() || keys.contains(slot.automationKey)) return false;
        keys.add(slot.automationKey);
        slot.slotId = chain == "monitor" ? nextMonitoringStageSlotId++ : nextMasterStageSlotId++;
        slot.name = item["name"].toString(); slot.type = item["type"].toString();
        slot.pluginPath = item["pluginPath"].toString(); slot.pluginFormat = item["pluginFormat"].toString();
        if (slot.pluginPath.isEmpty() || (slot.type != "builtin" && slot.type != "jsfx" && slot.type != "plugin"
            && slot.type != "vst3" && slot.type != "clap" && slot.type != "lv2" && slot.type != "au")) return false;
        slot.serializedState = item["state"].toString(); slot.bypassed = static_cast<bool>(item["bypassed"]);
        slot.forceFloat = static_cast<bool>(item["forceFloat"]);
        spec.slots.push_back(std::move(slot));
    }
    return chain == "monitor" ? publishMonitoringStageSpec(spec) : publishMasterStageSpec(spec);
}

void AudioEngine::invalidateStageAutomationAfterRecall(juce::AudioProcessor* processor)
{
    for (const auto& stage : { std::atomic_load(&realtimeMasterFXSnapshot), std::atomic_load(&realtimeMonitoringFXSnapshot) })
        if (stage)
            for (const auto& slot : stage->slots)
                if (slot.processor.get() == processor)
                {
                    for (const auto& route : slot.automationRoutes)
                        route->lastApplied.store(std::numeric_limits<float>::quiet_NaN());
                    if (slot.parameterCapture) slot.parameterCapture->discard();
                }
}

juce::var AudioEngine::runFXStageAutomationRegression()
{
    juce::Array<juce::var> checks;
    const auto check = [&] (const char* name, bool pass) {
        auto* item = new juce::DynamicObject(); item->setProperty("name", name); item->setProperty("pass", pass); checks.add(juce::var(item));
    };
    // Exercise the same public mutation/readback endpoints as the WebView,
    // including the immutable processor lists acquired by audio callbacks.
    const auto orderTrackId = addTrack("fx-order-regression", "audio");
    for (const bool input : { false, true })
    {
        const bool inserted = addTrackBuiltInFX(orderTrackId, "OpenStudio Gain Phase", input)
            && addTrackBuiltInFX(orderTrackId, "OpenStudio Delay", input);
        auto* const orderTrack = trackMap.count(orderTrackId) ? trackMap.at(orderTrackId) : nullptr;
        const auto snapshot = [&] {
            return orderTrack == nullptr ? std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>>()
                : input ? orderTrack->getInputFXSnapshot() : orderTrack->getTrackFXSnapshot();
        };
        const auto reorder = [&] (int from, int to) {
            return input ? reorderTrackInputFX(orderTrackId, from, to) : reorderTrackFX(orderTrackId, from, to);
        };
        const auto beforeOrder = snapshot();
        const bool moved = inserted && reorder(0, 1);
        const auto afterOrder = snapshot();
        const auto readback = input ? getTrackInputFX(orderTrackId) : getTrackFX(orderTrackId);
        const bool published = moved && beforeOrder && afterOrder
            && beforeOrder->size() == 2 && afterOrder->size() == 2
            && afterOrder->at(0) == beforeOrder->at(1)
            && afterOrder->at(1) == beforeOrder->at(0)
            && readback.size() == 2
            && readback[0]["name"].toString() == afterOrder->at(0)->getName()
            && readback[1]["name"].toString() == afterOrder->at(1)->getName();
        check(input ? "input_reorder_publishes_processor_order" : "track_reorder_publishes_processor_order", published);
        check(input ? "input_reorder_preserves_old_snapshot" : "track_reorder_preserves_old_snapshot",
            published && beforeOrder->at(0)->getName() == "OpenStudio Gain Phase"
                && beforeOrder->at(1)->getName() == "OpenStudio Delay");
        const bool reversed = moved && reorder(1, 0);
        const auto restoredOrder = snapshot();
        check(input ? "input_reorder_inverse_restores_processors" : "track_reorder_inverse_restores_processors",
            reversed && beforeOrder && restoredOrder && *beforeOrder == *restoredOrder);
        check(input ? "input_reorder_rejects_invalid_indices" : "track_reorder_rejects_invalid_indices",
            !reorder(-1, 0) && !reorder(0, 2) && snapshot() == restoredOrder);
    }
    removeTrack(orderTrackId);
    check("insert", addMasterBuiltInFX("OpenStudio Gain Phase") && addMasterBuiltInFX("OpenStudio Delay"));
    const auto params = getPluginParameters("master", 0, false);
    juce::String id;
    if (const auto* list = params.getArray()) for (const auto& param : *list)
        if (param["name"].toString() == "Gain") id = param["automationId"].toString();
    check("eligible_target", (id.startsWith("builtin_master_") || id.startsWith("plugin_master_")) && resolveMasterAutomation(id));
    setAutomationPoints("master", id, "[{\"time\":0,\"value\":0.25},{\"time\":1,\"value\":0.75}]");
    setAutomationMode("master", id, "read");
    const auto apply = [&] (double time, int index) {
        const auto stage = std::atomic_load(&realtimeMasterFXSnapshot);
        if (stage && juce::isPositiveAndBelow(index, static_cast<int>(stage->slots.size()))) applyStageAutomation(stage->slots[static_cast<size_t>(index)], time);
        return stageAutomationDefault(id);
    };
    check("read", std::abs(apply(0.0, 0) - 0.25f) < 1.0e-5f && std::abs(apply(1.0, 0) - 0.75f) < 1.0e-5f);
    const auto before = getFXStageState("master");
    const auto manualState = getMasterPluginState(0);
    apply(0.0, 0);
    check("recall_reclaims_constant_read", setMasterPluginState(0, manualState) && std::abs(apply(0.0, 0) - 0.25f) < 1.0e-5f);
    const auto beforeMasterOrder = std::atomic_load(&realtimeMasterFXSnapshot);
    check("reorder", reorderMasterFX(0, 1) && std::abs(apply(0.0, 1) - 0.25f) < 1.0e-5f);
    const auto afterMasterOrder = std::atomic_load(&realtimeMasterFXSnapshot);
    check("master_reorder_publishes_slot_order", beforeMasterOrder && afterMasterOrder
        && beforeMasterOrder->slots.size() == 2 && afterMasterOrder->slots.size() == 2
        && afterMasterOrder->slots[0].slotId == beforeMasterOrder->slots[1].slotId
        && afterMasterOrder->slots[1].slotId == beforeMasterOrder->slots[0].slotId
        && afterMasterOrder->slots[0].name == "OpenStudio Delay"
        && afterMasterOrder->slots[1].name == "OpenStudio Gain Phase");
    check("remove_inert", removeMasterFX(1) && resolveMasterAutomation(id) == nullptr);
    check("restore_identity", setFXStageState("master", juce::JSON::toString(before)) && std::abs(apply(1.0, 0) - 0.75f) < 1.0e-5f);
    beginTouchAutomation("master", id); setAutomationMode("master", id, "touch"); beginTouchAutomation("master", id);
    check("touch_holds", std::abs(apply(0.0, 0) - 0.75f) < 1.0e-5f);
    isRendering.store(true);
    check("render_forces_read", std::abs(apply(0.0, 0) - 0.25f) < 1.0e-5f);
    isRendering.store(false); endTouchAutomation("master", id);
    auto wrongPlugin = juce::JSON::parse(juce::JSON::toString(before));
    wrongPlugin.getArray()->getReference(0).getDynamicObject()->setProperty("name", "OpenStudio Reverb");
    wrongPlugin.getArray()->getReference(0).getDynamicObject()->setProperty("pluginPath", "OpenStudio Reverb");
    wrongPlugin.getArray()->getReference(0).getDynamicObject()->setProperty("state", "");
    check("fingerprint_rejects_wrong_plugin", setFXStageState("master", juce::JSON::toString(wrongPlugin)) && resolveMasterAutomation(id) == nullptr);
    setAutomationPoints("master", id, "[]");
    check("inactive_route_cleared_before_rebinding", setFXStageState("master", juce::JSON::toString(before))
        && resolveMasterAutomation(id) && !resolveMasterAutomation(id)->hasPlaybackData());
    setAutomationPoints("master", id, "[{\"time\":0,\"value\":0.25},{\"time\":1,\"value\":0.75}]");
    check("monitor_restore", setFXStageState("monitor", juce::JSON::toString(before)));
    const auto monitoring = getPluginParameters("monitor", 0, false);
    juce::String monitorId;
    if (const auto* list = monitoring.getArray()) for (const auto& param : *list)
        if (param["name"].toString() == "Gain") monitorId = param["automationId"].toString();
    setAutomationPoints("master", monitorId, "[{\"time\":0,\"value\":0.4}]"); setAutomationMode("master", monitorId, "read");
    const auto monitorStage = std::atomic_load(&realtimeMonitoringFXSnapshot);
    if (monitorStage && !monitorStage->slots.empty()) applyStageAutomation(monitorStage->slots[0], 0.0);
    check("monitor_read", (monitorId.startsWith("builtin_monitor_") || monitorId.startsWith("plugin_monitor_")) && std::abs(stageAutomationDefault(monitorId) - 0.4f) < 1.0e-5f);
    check("invalid_snapshot_unchanged", !setFXStageState("monitor", "[{}]") && resolveMasterAutomation(monitorId));
    bool pass = true; for (const auto& item : checks) pass = pass && static_cast<bool>(item["pass"]);
    auto* result = new juce::DynamicObject(); result->setProperty("name", "stage_automation"); result->setProperty("pass", pass); result->setProperty("checks", checks);
    return juce::var(result);
}

juce::var AudioEngine::runAutomationTrimRegression()
{
    getDeviceManager().closeAudioDevice();
    constexpr double rate = 48000.0;
    constexpr int samples = 64;
    currentSampleRate = rate;
    reusableMasterAutomationBuffer.setSize(3, samples);
    reusableMasterBufferDouble.setSize(4, samples);
    masterVolumeAutomation.setMode(AutomationMode::Read);
    masterVolumeAutomation.setPoints({ { 0, -12.0f }, { 63.0 / rate, -6.0f } });
    masterPanAutomation.setMode(AutomationMode::Off);
    masterTrimVolumeAutomation.setMode(AutomationMode::Read);
    masterTrimVolumeAutomation.setPoints({ { 0, 0.0f }, { 63.0 / rate, -6.0f } });
    setMasterPan(0.0f); setMasterMute(false);
    bool masterRead = true, manual = true, mute = true, mono = true, trackRead = true;
    juce::AudioBuffer<float> buffer(4, samples);
    const auto fill = [&] { for (int channel = 0; channel < 4; ++channel) { juce::FloatVectorOperations::fill(buffer.getWritePointer(channel), 1.0f, samples); juce::FloatVectorOperations::fill(reusableMasterBufferDouble.getWritePointer(channel), 1.0, samples); } };
    const auto panLeft = cachedMasterPanL.load(), panRight = cachedMasterPanR.load();
    for (const bool useDouble : { false, true })
    {
        fill(); applyMasterGainPanMono(buffer.getArrayOfWritePointers(), 4, samples, 0.0, useDouble);
        for (int sample = 0; sample < samples; ++sample) for (int channel = 0; channel < 4; ++channel)
        {
            const auto value = useDouble ? reusableMasterBufferDouble.getSample(channel, sample) : buffer.getSample(channel, sample);
            const auto expected = juce::Decibels::decibelsToGain(-12.0) * (channel == 0 ? panLeft : channel == 1 ? panRight : 1.0f);
            masterRead = masterRead && std::abs(value - expected) < 1.0e-6;
        }
        setMasterMute(true); fill(); applyMasterGainPanMono(buffer.getArrayOfWritePointers(), 4, samples, 0.0, useDouble);
        mute = mute && (useDouble ? reusableMasterBufferDouble.getMagnitude(0, samples) : buffer.getMagnitude(0, samples)) == 0.0;
        setMasterMute(false);
    }
    masterTrimVolumeAutomation.setMode(AutomationMode::Off); masterVolumeAutomation.setMode(AutomationMode::Off);
    setMasterVolume(1.0f); setAutomationTrimValue("master", -6.0f);
    fill(); applyMasterGainPanMono(buffer.getArrayOfWritePointers(), 4, samples, 0.0, false);
    manual = std::abs(buffer.getSample(2, 0) - juce::Decibels::decibelsToGain(-6.0f)) < 1.0e-6;
    setMasterPan(-1.0f); fill(); applyMasterGainPanMono(buffer.getArrayOfWritePointers(), 1, samples, 0.0, false);
    mono = std::abs(buffer.getSample(0, 0) - juce::Decibels::decibelsToGain(-6.0f)) < 1.0e-6;
    TrackProcessor reference, shifted;
    for (auto* track : { &reference, &shifted })
    {
        track->prepareToPlay(rate, samples); track->setForceAutomationReadForProcessing(true);
        track->getVolumeAutomation().setMode(AutomationMode::Read);
        track->getVolumeAutomation().setPoints({ { 0, -12.0f }, { 63.0 / rate, -6.0f } });
    }
    shifted.getTrimVolumeAutomation().setMode(AutomationMode::Read);
    shifted.getTrimVolumeAutomation().setPoints({ { 0, 0.0f }, { 63.0 / rate, -6.0f } });
    juce::AudioBuffer<float> base(4, samples), offset(4, samples); juce::MidiBuffer midi;
    for (int channel = 0; channel < 4; ++channel) { juce::FloatVectorOperations::fill(base.getWritePointer(channel), 1.0f, samples); juce::FloatVectorOperations::fill(offset.getWritePointer(channel), 1.0f, samples); }
    reference.processBlock(base, midi); shifted.processBlock(offset, midi);
    for (int sample = 0; sample < samples; ++sample) for (int channel = 0; channel < 4; ++channel)
    {
        const auto expected = base.getSample(channel, sample) * juce::Decibels::decibelsToGain(-6.0f * sample / 63.0f);
        trackRead = trackRead && std::abs(offset.getSample(channel, sample) - expected) < 1.0e-6;
    }
    const bool preserved = reference.getVolumeAutomation().eval(63.0 / rate) == shifted.getVolumeAutomation().eval(63.0 / rate);
    auto* result = new juce::DynamicObject(); result->setProperty("name", "automation_trim");
    result->setProperty("pass", masterRead && manual && mute && mono && trackRead && preserved);
    result->setProperty("masterPerSampleFloatAndDouble", masterRead); result->setProperty("masterMuteOverridesRead", mute);
    result->setProperty("manualTrim", manual); result->setProperty("monoOutputIgnoresPan", mono);
    result->setProperty("trackPerSampleAllChannels", trackRead); result->setProperty("baseCurvePreserved", preserved);
    result->setProperty("audioQuality", "not_asserted"); return juce::var(result);
}
