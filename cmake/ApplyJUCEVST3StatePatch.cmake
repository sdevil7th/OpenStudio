# Keep the pinned JUCE parameter cache and the VST3 component state synchronized
# when saving a stopped/bypassed plugin. A controller write is only delivered to
# the DSP by process(); flushing the UI dispatcher alone loses the last edits.
set(OPENSTUDIO_VST3_STATE_SOURCE
    "${JUCE_SOURCE_DIR}/modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h")
file(READ "${OPENSTUDIO_VST3_STATE_SOURCE}" OPENSTUDIO_VST3_STATE_CONTENT)
set(OPENSTUDIO_VST3_STATE_BEFORE [=[        parameterDispatcher.flush();

        XmlElement state ("VST3PluginState");]=])
set(OPENSTUDIO_VST3_STATE_AFTER [=[        parameterDispatcher.flush();

        // OpenStudio: drain pending host/editor changes before the component
        // snapshot, even when no audio block is scheduled. VST3 explicitly
        // supports a zero-sample, zero-bus parameter-only process call.
        {
            const SpinLock::ScopedLockType processLock (processMutex);
            inputParameterChanges->clear();
            cachedParamValues.ifSet ([&] (Steinberg::int32 index, float value)
            {
                inputParameterChanges->set (cachedParamValues.getParamID (index), value, 0);
            });

            if (processor != nullptr && inputParameterChanges->getParameterCount() > 0)
            {
                Vst::ProcessData data {};
                data.processMode = isNonRealtime() ? Vst::kOffline : Vst::kRealtime;
                data.symbolicSampleSize = isUsingDoublePrecision() ? Vst::kSample64 : Vst::kSample32;
                data.inputParameterChanges = inputParameterChanges.get();
                processor->process (data);
            }
            inputParameterChanges->clear();
        }

        XmlElement state ("VST3PluginState");]=])
string(FIND "${OPENSTUDIO_VST3_STATE_CONTENT}" "${OPENSTUDIO_VST3_STATE_AFTER}" OPENSTUDIO_VST3_STATE_PATCHED_AT)
if(OPENSTUDIO_VST3_STATE_PATCHED_AT GREATER_EQUAL 0)
    message(STATUS "JUCE VST3 state parameter flush patch is already applied")
else()
    string(FIND "${OPENSTUDIO_VST3_STATE_CONTENT}" "${OPENSTUDIO_VST3_STATE_BEFORE}" OPENSTUDIO_VST3_STATE_ORIGINAL_AT)
    if(OPENSTUDIO_VST3_STATE_ORIGINAL_AT LESS 0)
        message(FATAL_ERROR "Pinned JUCE VST3 state context changed; refusing an unverified dependency rewrite")
    endif()
    string(REPLACE "${OPENSTUDIO_VST3_STATE_BEFORE}" "${OPENSTUDIO_VST3_STATE_AFTER}"
        OPENSTUDIO_VST3_STATE_CONTENT "${OPENSTUDIO_VST3_STATE_CONTENT}")
    file(WRITE "${OPENSTUDIO_VST3_STATE_SOURCE}" "${OPENSTUDIO_VST3_STATE_CONTENT}")
    message(STATUS "Applied JUCE VST3 state parameter flush patch")
endif()

# Some vendor components do not retain a parameter-only flush. Preserve the
# host's normalized values by stable VST3 ParamID alongside the opaque vendor
# chunks. Older JUCE states remain readable; unrelated XML children are optional.
function(openstudio_patch_vst3_state before after)
    string(FIND "${OPENSTUDIO_VST3_STATE_CONTENT}" "${after}" patched_at)
    if(patched_at GREATER_EQUAL 0)
        return()
    endif()
    string(FIND "${OPENSTUDIO_VST3_STATE_CONTENT}" "${before}" original_at)
    if(original_at LESS 0)
        message(FATAL_ERROR "Pinned JUCE VST3 parameter snapshot context changed")
    endif()
    string(REPLACE "${before}" "${after}" patched "${OPENSTUDIO_VST3_STATE_CONTENT}")
    set(OPENSTUDIO_VST3_STATE_CONTENT "${patched}" PARENT_SCOPE)
endfunction()

string(FIND "${OPENSTUDIO_VST3_STATE_CONTENT}" "// OpenStudio state snapshot v2:" OPENSTUDIO_VST3_STATE_V2_AT)
if(OPENSTUDIO_VST3_STATE_V2_AT LESS 0)
openstudio_patch_vst3_state([=[        appendStateFrom (state, editController, "IEditController");

        AudioProcessor::copyXmlToBinary (state, destData);]=]
[=[        appendStateFrom (state, editController, "IEditController");

        auto* values = state.createNewChildElement ("OpenStudioHostParameters");
        for (auto* parameter : getParameters())
        {
            auto* vst3Parameter = static_cast<VST3Parameter*> (parameter);
            if (! parameter->isAutomatable()) continue;
            auto* value = values->createNewChildElement ("Parameter");
            value->setAttribute ("id", String ((int64) vst3Parameter->getParamID()));
            value->setAttribute ("value", (double) parameter->getValue());
        }

        AudioProcessor::copyXmlToBinary (state, destData);]=])

openstudio_patch_vst3_state([=[                if (controllerStream != nullptr)
                    editController->setState (controllerStream.get());
            }
        }
    }

    void setComponentStateAndResetParameters]=]
[=[                if (controllerStream != nullptr)
                    editController->setState (controllerStream.get());
            }

            if (auto* values = head->getChildByName ("OpenStudioHostParameters"))
                for (auto* value : values->getChildIterator())
                {
                    const auto id = value->getStringAttribute ("id").getLargeIntValue();
                    const auto normalized = value->getDoubleAttribute ("value", -1.0);
                    if (id < 0 || id > (int64) std::numeric_limits<Vst::ParamID>::max()
                        || ! std::isfinite (normalized) || normalized < 0.0 || normalized > 1.0)
                        continue;
                    if (auto* parameter = getParameterForID ((Vst::ParamID) id))
                        if (parameter->isAutomatable()) parameter->setValue ((float) normalized);
                }
        }
    }

    void setComponentStateAndResetParameters]=])
endif()

# Vendor getState callbacks can reset the controller/cache. Capture normalized
# host values before calling into the vendor, preserve them in the optional
# snapshot, and restore the live controls without a second vendor state query.
openstudio_patch_vst3_state([=[        parameterDispatcher.flush();

        // OpenStudio: drain pending host/editor changes]=]
[=[        // OpenStudio state snapshot v2: preserve host values across vendor callbacks.
        std::vector<std::pair<Vst::ParamID, float>> savedHostValues;
        savedHostValues.reserve ((size_t) getParameters().size());
        for (auto* parameter : getParameters())
            if (parameter->isAutomatable())
                savedHostValues.emplace_back (static_cast<VST3Parameter*> (parameter)->getParamID(), parameter->getValue());

        parameterDispatcher.flush();

        // OpenStudio: drain pending host/editor changes]=])

openstudio_patch_vst3_state([=[        auto* values = state.createNewChildElement ("OpenStudioHostParameters");
        for (auto* parameter : getParameters())
        {
            auto* vst3Parameter = static_cast<VST3Parameter*> (parameter);
            if (! parameter->isAutomatable()) continue;
            auto* value = values->createNewChildElement ("Parameter");
            value->setAttribute ("id", String ((int64) vst3Parameter->getParamID()));
            value->setAttribute ("value", (double) parameter->getValue());
        }

        AudioProcessor::copyXmlToBinary (state, destData);]=]
[=[        auto* values = state.createNewChildElement ("OpenStudioHostParameters");
        for (const auto& saved : savedHostValues)
        {
            auto* parameter = getParameterForID (saved.first);
            if (parameter == nullptr || ! parameter->isAutomatable()) continue;
            auto* value = values->createNewChildElement ("Parameter");
            value->setAttribute ("id", String ((int64) saved.first));
            value->setAttribute ("value", (double) saved.second);
            if (! exactlyEqual (parameter->getValue(), saved.second)) parameter->setValue (saved.second);
        }
        // Synchronize the controller before a queued parameter rescan can read it.
        parameterDispatcher.flush();

        AudioProcessor::copyXmlToBinary (state, destData);]=])

openstudio_patch_vst3_state([=[                    if (auto* parameter = getParameterForID ((Vst::ParamID) id))
                        if (parameter->isAutomatable()) parameter->setValue ((float) normalized);
                }
        }
    }

    void setComponentStateAndResetParameters]=]
[=[                    if (auto* parameter = getParameterForID ((Vst::ParamID) id))
                        if (parameter->isAutomatable()) parameter->setValue ((float) normalized);
                }
            // OpenStudio state restore v2: publish restored values to the controller now.
            parameterDispatcher.flush();
        }
    }

    void setComponentStateAndResetParameters]=])
# Offline/realtime and precision transitions still require setupProcessing when
# rate and block size are unchanged. The pinned early return ignored both.
openstudio_patch_vst3_state([=[              && getBlockSize() == estimatedSamplesPerBlock)
            return;]=]
[=[              && getBlockSize() == estimatedSamplesPerBlock
              && preparedProcessMode == (isNonRealtime() ? Vst::kOffline : Vst::kRealtime)
              && preparedSampleSize == (isUsingDoublePrecision() ? Vst::kSample64 : Vst::kSample32))
            return;]=])
# Upgrade the earlier working-tree mode cache, then apply the same final
# context to pristine pinned source. Both paths remain exactly idempotent.
set(OPENSTUDIO_VST3_LEGACY_MODE_SETUP [=[        warnOnFailure (processor->setupProcessing (setup));
        preparedProcessMode = setup.processMode;
        preparedSampleSize = setup.symbolicSampleSize;

        holder->initialise();]=])
set(OPENSTUDIO_VST3_ACCEPTED_MODE_SETUP [=[        const auto setupResult = processor->setupProcessing (setup);
        warnOnFailure (setupResult);
        // Cache only an accepted setup; a rejected request must be retried.
        preparedProcessMode = setupResult == Steinberg::kResultOk ? setup.processMode : -1;
        preparedSampleSize = setupResult == Steinberg::kResultOk ? setup.symbolicSampleSize : -1;

        holder->initialise();]=])
string(FIND "${OPENSTUDIO_VST3_STATE_CONTENT}" "${OPENSTUDIO_VST3_LEGACY_MODE_SETUP}" OPENSTUDIO_VST3_LEGACY_MODE_AT)
if(OPENSTUDIO_VST3_LEGACY_MODE_AT GREATER_EQUAL 0)
    string(REPLACE "${OPENSTUDIO_VST3_LEGACY_MODE_SETUP}" "${OPENSTUDIO_VST3_ACCEPTED_MODE_SETUP}" OPENSTUDIO_VST3_STATE_CONTENT "${OPENSTUDIO_VST3_STATE_CONTENT}")
    file(WRITE "${OPENSTUDIO_VST3_STATE_SOURCE}" "${OPENSTUDIO_VST3_STATE_CONTENT}")
endif()
openstudio_patch_vst3_state([=[        warnOnFailure (processor->setupProcessing (setup));

        holder->initialise();]=] "${OPENSTUDIO_VST3_ACCEPTED_MODE_SETUP}")
openstudio_patch_vst3_state([=[    bool isControllerInitialised = false, isActive = false, lastProcessBlockCallWasBypass = false;]=]
[=[    bool isControllerInitialised = false, isActive = false, lastProcessBlockCallWasBypass = false;
    int preparedProcessMode = -1, preparedSampleSize = -1;]=])
openstudio_patch_vst3_state([=[    void prepareToPlay (double newSampleRate, int estimatedSamplesPerBlock) override]=]
[=[    // Internal regression observation of the setup actually submitted to the SDK.
    int openStudioPreparedProcessMode() const noexcept { return isActive ? preparedProcessMode : -1; }
    int openStudioPreparedSampleSize() const noexcept { return isActive ? preparedSampleSize : -1; }

    void prepareToPlay (double newSampleRate, int estimatedSamplesPerBlock) override]=])
openstudio_patch_vst3_state([=[JUCE_END_NO_SANITIZE

} // namespace juce]=]
[=[#if !defined(JUCE_AUDIO_PROCESSORS_H_INCLUDED)
int openStudioVST3PreparedProcessMode (AudioProcessor& processor)
{
    auto* plugin = dynamic_cast<VST3PluginInstanceHeadless*> (&processor);
    return plugin != nullptr ? plugin->openStudioPreparedProcessMode() : -1;
}
int openStudioVST3PreparedSampleSize (AudioProcessor& processor)
{
    auto* plugin = dynamic_cast<VST3PluginInstanceHeadless*> (&processor);
    return plugin != nullptr ? plugin->openStudioPreparedSampleSize() : -1;
}
#endif

JUCE_END_NO_SANITIZE

} // namespace juce]=])
file(READ "${OPENSTUDIO_VST3_STATE_SOURCE}" OPENSTUDIO_VST3_STATE_ON_DISK)
if(NOT OPENSTUDIO_VST3_STATE_ON_DISK STREQUAL OPENSTUDIO_VST3_STATE_CONTENT)
    file(WRITE "${OPENSTUDIO_VST3_STATE_SOURCE}" "${OPENSTUDIO_VST3_STATE_CONTENT}")
endif()
