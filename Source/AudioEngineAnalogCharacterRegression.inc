    {
        const auto track = addTrack("editor-original-character", "audio");
        bool pass = true, stageRecall = true;
        juce::StringArray stageFailures;
        const auto addMonitorFixture = [&](const juce::String& name)
        {
            // The public monitoring catalog currently exposes NAM only. Use
            // the same native stage publication for this configuration test.
            auto spec = desiredMonitoringStageSpec;
            syncStageSpecStateFromActive(spec, std::atomic_load(&realtimeMonitoringFXSnapshot));
            auto effect = createBuiltInEffect(name);
            if (!effect) return false;
            DesiredFXStageSlot slot; slot.slotId = nextMonitoringStageSlotId++;
            slot.name = name; slot.type = "builtin"; slot.pluginPath = name; slot.pluginFormat = "Built-in";
            slot.serializedState = serialiseProcessorStateToBase64(effect.get());
            spec.slots.push_back(std::move(slot));
            return publishMonitoringStageSpec(spec);
        };
        for (const auto& chain : juce::StringArray{"track", "input", "master", "monitor"})
        {
            const bool isStage = chain == "master" || chain == "monitor";
            const int first = chain == "master" ? getMasterFX().size() : chain == "monitor" ? getMonitoringFX().size() : 0;
            const bool mounted = chain == "master"
                ? addMasterBuiltInFX("OpenStudio Compressor") && addMasterBuiltInFX("OpenStudio Preamp")
                : chain == "monitor" ? addMonitorFixture("OpenStudio Compressor") && addMonitorFixture("OpenStudio Preamp")
                : addTrackBuiltInFX(track,"OpenStudio Compressor",chain=="input")
                    && addTrackBuiltInFX(track,"OpenStudio Preamp",chain=="input");
            pass = mounted && pass;
            for (int offset = 0; offset < 2; ++offset)
            {
                const int index = first + offset;
                const auto owner = getPublishedBuiltInProcessor(track,chain,index);
                if (!owner.processor) { pass = false; continue; }
                const auto stageIsAligned = [&]()
                {
                    if (!isStage) return true;
                    const auto active = std::atomic_load(chain == "monitor" ? &realtimeMonitoringFXSnapshot : &realtimeMasterFXSnapshot);
                    if (!active) return false;
                    for (const auto& slot : active->slots)
                    {
                        if (slot.processor != owner.processor || !slot.bypassDelay) continue;
                        // The engine's audio callback owns the active ring and
                        // write cursor. Exercise the same dry-delay utility on
                        // private storage instead of racing that callback.
                        StageFXBypassDelayStorage delay;
                        delay.processor = owner.processor.get();
                        delay.ring.setSize(slot.bypassDelay->ring.getNumChannels(), slot.bypassDelay->ring.getNumSamples());
                        delay.publishedLatency.store(slot.bypassDelay->publishedLatency.load());
                        const int latency = owner.processor->getLatencySamples();
                        const int published = delay.publishedLatency.load();
                        juce::AudioBuffer<float> input(2, juce::jmax(latency, published) + 17), dry(2, input.getNumSamples());
                        input.clear(); dry.clear(); input.setSample(0, 0, 1); input.setSample(1, 0, -.5f);
                        delay.ring.clear(); delay.writePosition = 0; delay.latencyInitialised = false;
                        const bool prepared = prepareStageLatencyAlignedDry(input, dry, delay, *owner.processor, input.getNumSamples(), true, true);
                        bool aligned = published == latency && prepared;
                        int mismatch = -1;
                        for (int i = 0; i < dry.getNumSamples(); ++i)
                        {
                            if (mismatch < 0 && (dry.getSample(0, i) != (i == latency ? 1.0f : 0.0f)
                                || dry.getSample(1, i) != (i == latency ? -.5f : 0.0f))) mismatch = i;
                            aligned = aligned && dry.getSample(0, i) == (i == latency ? 1.0f : 0.0f)
                                && dry.getSample(1, i) == (i == latency ? -.5f : 0.0f);
                        }
                        const auto& spec = chain == "monitor" ? desiredMonitoringStageSpec : desiredMasterStageSpec;
                        for (const auto& desired : spec.slots)
                            if (desired.slotId == slot.slotId)
                            {
                                const bool stateMatches = desired.serializedState == serialiseProcessorStateToBase64(owner.processor.get());
                                if (!aligned || !stateMatches)
                                    stageFailures.add(chain + " " + juce::String(offset) + ": latency=" + juce::String(latency)
                                        + " published=" + juce::String(published) + " impulse=" + juce::String(static_cast<int>(aligned))
                                        + " desiredState=" + juce::String(static_cast<int>(stateMatches))
                                        + " prepared=" + juce::String(static_cast<int>(prepared))
                                        + " mismatch=" + juce::String(mismatch)
                                        + " dry=" + juce::String(mismatch < 0 ? 0.0f : dry.getSample(0, mismatch), 9)
                                        + " ring=" + juce::String(delay.ring.getNumSamples()));
                                return aligned && stateMatches;
                            }
                    }
                    return false;
                };
                const auto legacy = getBuiltInPluginState(track,chain,index);
                const int initialLatency = owner.processor->getLatencySamples();
                pass = setBuiltInPluginParam(track,chain,index,"audioCharacter",1)
                    && setBuiltInPluginParam(track,chain,index,"headroom",6) && pass;
                if (offset == 1) pass = setBuiltInPluginParam(track,chain,index,"outputDrive",9) && pass;
                const int originalLatency = owner.processor->getLatencySamples();
                const auto original = getBuiltInPluginState(track,chain,index);
                stageRecall = stageIsAligned() && stageRecall;
                OpenStudioBuiltInAutomationDescriptor descriptor;
                pass = !getOpenStudioBuiltInAutomationDescriptor(owner.processor.get(),"audioCharacter",descriptor)
                    && getOpenStudioBuiltInAutomationDescriptor(owner.processor.get(),"headroom",descriptor)
                    && originalLatency > initialLatency && pass;
                pass = setBuiltInPluginState(track,chain,index,juce::JSON::toString(legacy))
                    && owner.processor->getLatencySamples() == initialLatency
                    && getBuiltInPluginState(track,chain,index)["fullState"].toString() == legacy["fullState"].toString() && pass;
                stageRecall = stageIsAligned() && stageRecall;
                pass = setBuiltInPluginState(track,chain,index,juce::JSON::toString(original))
                    && owner.processor->getLatencySamples() == originalLatency
                    && getBuiltInPluginState(track,chain,index)["fullState"].toString() == original["fullState"].toString() && pass;
                stageRecall = stageIsAligned() && stageRecall;
                pass = setBuiltInPluginState(track,chain,index,R"json({"factoryDefault":true})json")
                    && owner.processor->getLatencySamples() == initialLatency && pass;
                stageRecall = stageIsAligned() && stageRecall;
            }
            if (chain == "master") { removeMasterFX(first + 1); removeMasterFX(first); }
            if (chain == "monitor") { removeMonitoringFX(first + 1); removeMonitoringFX(first); }
        }
        addCheck("original_character_host_configuration_state",pass,
            "Opt-in compressor/preamp stages preserve Legacy and Original full-state recall across track/input/master/monitor, report configuration latency, reject character automation and retain scalar headroom automation.");
        addCheck("original_character_stage_bypass_recall_latency",stageRecall,
            "Master and monitoring stage dry impulses match reported latency and desired state bytes after scalar, full-state Legacy/Original, and factory recalls. Monitoring uses a direct native stage fixture. " + stageFailures.joinIntoString("; "));
        removeTrack(track);
    }
