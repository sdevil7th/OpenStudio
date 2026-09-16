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
file(READ "${OPENSTUDIO_VST3_STATE_SOURCE}" OPENSTUDIO_VST3_STATE_ON_DISK)
if(NOT OPENSTUDIO_VST3_STATE_ON_DISK STREQUAL OPENSTUDIO_VST3_STATE_CONTENT)
    file(WRITE "${OPENSTUDIO_VST3_STATE_SOURCE}" "${OPENSTUDIO_VST3_STATE_CONTENT}")
endif()
