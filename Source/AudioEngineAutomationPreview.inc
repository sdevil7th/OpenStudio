// Temporary audition values are separate from stored points and manual faders.
// Owners pin the old list safely if a track/FX disappears before cancellation.
std::optional<AudioEngine::AutomationPreviewState> AudioEngine::resolveAutomationPreview(const juce::String& trackId, const juce::String& parameterId)
{
    const juce::ScopedLock graphGuard(mainProcessorGraph->getCallbackLock());
    if (parameterId.startsWith("midi_")) return std::nullopt;
    AutomationPreviewState state; state.trackId = trackId; state.parameterId = parameterId;
    if (trackId == "master")
    {
        state.list = resolveMasterAutomation(parameterId);
        if (!state.list) return std::nullopt;
        if (parameterId == "volume") state.originalValue = juce::Decibels::gainToDecibels(getMasterVolume(), -60.0f);
        else if (parameterId == "pan") state.originalValue = getMasterPan();
        else if (parameterId == "trim_volume") state.originalValue = getAutomationTrimValue("master");
        else
        {
            state.stageOwner = std::atomic_load(parameterId.startsWith("builtin_monitor_") || parameterId.startsWith("plugin_monitor_") ? &realtimeMonitoringFXSnapshot : &realtimeMasterFXSnapshot);
            bool found = false;
            if (state.stageOwner) for (const auto& slot : state.stageOwner->slots) for (const auto& route : slot.automationRoutes) if (route->id == parameterId)
            {
                if (route->builtInParam.isEmpty() && !juce::isPositiveAndBelow(route->index, slot.processor->getParameters().size())) return std::nullopt;
                state.listOwner = route->list; state.originalValue = stageAutomationDefault(parameterId);
                state.meaning = route->builtInParam.isEmpty() ? pluginParameterMeaning(slot.processor.get(), route->index) : route->builtInParam;
                if (route->builtInParam.isEmpty()) getOpenStudioCLAPParameterReferenceGeneration(slot.processor.get(), route->index, state.referenceGeneration);
                found = true;
            }
            if (!found) return std::nullopt;
        }
    }
    else
    {
        const auto found = trackMap.find(trackId); if (found == trackMap.end() || !found->second) return std::nullopt;
        state.trackOwner = found->second;
        const auto node = trackNodeMap.find(trackId); if (node == trackNodeMap.end()) return std::nullopt;
        state.nodeOwner = node->second;
        const auto target = state.trackOwner->resolveAutomationTarget(parameterId, true);
        if (!target || !target->list) return std::nullopt;
        state.list = target->list; state.originalValue = state.trackOwner->getAutomationDefaultValue(*target);
        if (target->sendAutomation)
        {
            const auto destination = juce::URL::removeEscapeChars(parameterId.substring(5, parameterId.lastIndexOfChar('_')));
            const auto send = state.trackOwner->sendAutomationStates.find(destination);
            if (send == state.trackOwner->sendAutomationStates.end()) return std::nullopt;
            state.auxiliaryOwner = send->second;
        }
        if (target->kind == TrackProcessor::AutomationTarget::Kind::PluginParameter)
        {
            const auto route = state.trackOwner->findPluginAutomationRoute(parameterId); if (!route) return std::nullopt;
            state.listOwner = route->automation;
            state.processorOwner = target->fxIndex < 0 ? state.trackOwner->getInstrumentShared() : target->isInputFX ? state.trackOwner->getInputFXProcessorShared(target->fxIndex) : state.trackOwner->getTrackFXProcessorShared(target->fxIndex);
            auto* processor = state.processorOwner.get();
            if (!processor) return std::nullopt;
            state.meaning = target->builtInParamId.isNotEmpty() ? target->builtInParamId : pluginParameterMeaning(processor, target->paramIndex);
            if (target->builtInParamId.isEmpty()) getOpenStudioCLAPParameterReferenceGeneration(processor, target->paramIndex, state.referenceGeneration);
            if (state.meaning.isEmpty()) return std::nullopt;
        }
    }
    return state;
}

bool AudioEngine::applyAutomationPreviewManualValue(const AutomationPreviewState& state, float value)
{
    const auto set = [value](juce::AudioProcessor* processor, int index, const juce::String& builtIn) {
        if (!processor) return false;
        const juce::ScopedLock guard(processor->getCallbackLock());
        if (builtIn.isNotEmpty())
        {
            OpenStudioBuiltInAutomationDescriptor descriptor;
            return getOpenStudioBuiltInAutomationDescriptor(processor, builtIn, descriptor)
                && setOpenStudioBuiltInParameterValue(processor, builtIn, openStudioBuiltInNormalizedToValue(descriptor, juce::jlimit(0.0f, 1.0f, value)));
        }
        if (!juce::isPositiveAndBelow(index, processor->getParameters().size())) return false;
        auto* parameter = processor->getParameters()[index]; if (!parameter || !parameter->isAutomatable()) return false;
        parameter->setValue(juce::jlimit(0.0f, 1.0f, value)); return true;
    };
    if (state.stageOwner)
    {
        for (const auto& slot : state.stageOwner->slots) for (const auto& route : slot.automationRoutes) if (route->id == state.parameterId)
        { route->lastApplied.store(std::numeric_limits<float>::quiet_NaN()); return set(slot.processor.get(), route->index, route->builtInParam); }
        return false;
    }
    if (!state.trackOwner) return true; // Master faders are evaluated without changing their manual values.
    const auto target = state.trackOwner->resolveAutomationTarget(state.parameterId, false); if (!target) return false;
    if (target->kind == TrackProcessor::AutomationTarget::Kind::FallbackParameter)
    {
        const auto& control = fallbackAutomationControls[static_cast<size_t>(target->fallbackIndex)];
        auto raw = control.minimum + juce::jlimit(0.0f, 1.0f, value) * (control.maximum - control.minimum);
        if (control.discrete) raw = std::round(raw);
        return state.trackOwner->setFallbackInstrumentParam(control.id, raw);
    }
    if (target->kind != TrackProcessor::AutomationTarget::Kind::PluginParameter) return true;
    if (const auto route = state.trackOwner->findPluginAutomationRoute(state.parameterId)) route->lastAppliedValue.store(std::numeric_limits<float>::quiet_NaN());
    return set(state.processorOwner.get(), target->paramIndex, target->builtInParamId);
}

juce::var AudioEngine::getAutomationCurrentValue(const juce::String& trackId, const juce::String& parameterId)
{
    const juce::ScopedLock guard(automationPreviewLock);
    const auto state = resolveAutomationPreview(trackId, parameterId); if (!state) return {};
    const auto value = state->list->shouldPlayback() && state->list->hasPlaybackData() ? state->list->eval(getTransportPosition()) : state->originalValue;
    return std::isfinite(value) ? juce::var(value) : juce::var();
}

bool AudioEngine::setAutomationPreview(const juce::String& trackId, const juce::String& parameterId, float value, const juce::String& expectedMeaning, int64_t expectedReferenceGeneration)
{
    const juce::ScopedLock guard(automationPreviewLock);
    if (isRendering.load(std::memory_order_acquire)) return false;
    if (!std::isfinite(value)) return false;
    const auto target = resolveAutomationPreview(trackId, parameterId); if (!target || (expectedMeaning.isNotEmpty() && target->meaning != expectedMeaning)) return false;
    if (expectedReferenceGeneration >= 0 && target->referenceGeneration != static_cast<uint64_t>(expectedReferenceGeneration)) return false;
    const auto key = trackId + "\n" + parameterId;
    auto found = automationPreviews.find(key);
    const auto mode = target->list->getMode();
    if ((mode == AutomationMode::Write || mode == AutomationMode::Touch || mode == AutomationMode::Latch)
        && (found == automationPreviews.end() || !found->second.writing)) return false;
    if (found == automationPreviews.end())
    {
        if (automationPreviews.size() >= 128) return false;
        found = automationPreviews.emplace(key, *target).first;
        found->second.originalMode = mode;
    }
    else if (found->second.list != target->list || found->second.meaning != target->meaning || found->second.referenceGeneration != target->referenceGeneration) return false;
    if (!applyAutomationPreviewManualValue(*target, value)) return false;
    if (found->second.writing) target->list->setWrittenValue(value);
    else target->list->setPreviewValue(value);
    automationPreviewGeneration.fetch_add(1);
    automationPreviewCleared.store(0);
    if (target->trackOwner)
    {
        if (const auto route = target->trackOwner->resolveAutomationTarget(parameterId, false); route && route->sendAutomation && !route->sendAutomation->bound.exchange(true)) rebuildRealtimeProcessingSnapshots();
    }
    return true;
}

bool AudioEngine::clearAutomationPreviews()
{
    const juce::ScopedLock guard(automationPreviewLock);
    const bool hadPreviews = !automationPreviews.empty();
    bool restored = true;
    for (auto iterator = automationPreviews.begin(); iterator != automationPreviews.end();)
    {
        auto& saved = iterator->second; saved.list->clearPreview();
        if (saved.writing) { saved.list->clearWrittenValue(); saved.list->setMode(saved.originalMode); }
        const auto target = resolveAutomationPreview(saved.trackId, saved.parameterId);
        if (!target || target->list != saved.list || target->meaning != saved.meaning || target->referenceGeneration != saved.referenceGeneration)
        { iterator = automationPreviews.erase(iterator); continue; }
        const auto value = saved.list->shouldPlayback() && saved.list->hasPlaybackData() ? saved.list->eval(getTransportPosition()) : saved.originalValue;
        if (applyAutomationPreviewManualValue(*target, value)) iterator = automationPreviews.erase(iterator);
        else { restored = false; ++iterator; }
    }
    if (hadPreviews && automationPreviews.empty()) automationPreviewCleared.store(automationPreviewGeneration.fetch_add(1) + 1);
    return restored;
}

juce::var AudioEngine::punchAutomationPreviews(const juce::String& trackId, juce::uint64 expectedGeneration)
{
    const juce::ScopedLock guard(automationPreviewLock);
    if (!isPlaying.load() || isRecordMode.load() || isRendering.load() || expectedGeneration != automationPreviewGeneration.load()) return {};
    std::vector<AutomationPreviewState*> targets;
    for (auto& entry : automationPreviews) {
        auto& saved=entry.second;
        if (saved.trackId != trackId || saved.writing) return {};
        const auto current=resolveAutomationPreview(trackId,saved.parameterId);
        if (!current || current->list != saved.list || current->meaning != saved.meaning || current->referenceGeneration != saved.referenceGeneration) return {};
        targets.push_back(&saved);
    }
    if (targets.empty() || targets.size() > 64) return {};
    const auto time=getTransportPosition();
    for (auto* saved : targets) {
        const auto value=saved->list->eval(time);
        // Publish the held writer value before removing Preview: callbacks can
        // see the audition or the writer, with no intervening Read value.
        saved->list->setMode(AutomationMode::Latch);
        saved->list->beginTouch();
        saved->list->setWrittenValue(value);
        saved->list->clearPreview();
        saved->writing=true;
    }
    auto* result=new juce::DynamicObject();result->setProperty("time",time);return juce::var(result);
}

bool AudioEngine::setAutomationWriteHold(const juce::String& trackId, const juce::String& parameterId, float value, double startTime, const juce::String& meaning, int64_t referenceGeneration)
{
    const juce::ScopedLock guard(automationPreviewLock);
    if(isRendering.load() || !std::isfinite(value) || !std::isfinite(startTime) || startTime < 0.0)return false;
    const auto target=resolveAutomationPreview(trackId,parameterId);
    if(!target || (meaning.isNotEmpty() && target->meaning != meaning) || (referenceGeneration >= 0 && target->referenceGeneration != static_cast<uint64_t>(referenceGeneration)))return false;
    const auto key=trackId+"\n"+parameterId;
    auto found=automationPreviews.find(key);
    if(found == automationPreviews.end()) {
        if(automationPreviews.size() >= 128)return false;
        found=automationPreviews.emplace(key,*target).first;found->second.originalMode=target->list->getMode();found->second.writing=true;
    } else if(!found->second.writing || found->second.list != target->list || found->second.meaning != target->meaning
        || found->second.referenceGeneration != target->referenceGeneration)return false;
    target->list->setMode(AutomationMode::Latch);target->list->beginTouch();target->list->setWrittenValue(value,startTime);
    return true;
}

bool AudioEngine::clearAutomationWriteHold(const juce::String& trackId, const juce::String& parameterId)
{
    const juce::ScopedLock guard(automationPreviewLock);
    const auto found=automationPreviews.find(trackId+"\n"+parameterId);
    if(found != automationPreviews.end() && found->second.writing) {
        auto saved=found->second;saved.list->resetTouchAndLatch();saved.list->setMode(saved.originalMode);
        const auto current=resolveAutomationPreview(trackId,parameterId);
        if(current && current->list == saved.list && current->meaning == saved.meaning && current->referenceGeneration == saved.referenceGeneration) {
            const auto value=saved.list->shouldPlayback() && saved.list->hasPlaybackData() ? saved.list->eval(getTransportPosition()) : saved.originalValue;
            if(!applyAutomationPreviewManualValue(*current,value))return false;
        }
        automationPreviews.erase(found);return true;
    }
    const auto target=resolveAutomationPreview(trackId,parameterId);
    if(!target)return true;
    target->list->resetTouchAndLatch();return true;
}
