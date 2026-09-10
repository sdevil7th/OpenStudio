#include "IsolatedPlugin.h"
#include "IsolatedPluginProtocol.h"
#include "ProcessorSafety.h"
#include "TrackProcessor.h"
#include <functional>
#include <chrono>
#if JUCE_WINDOWS
#include <windows.h>
#include <psapi.h>
#if defined(_DEBUG)
#include <crtdbg.h>
namespace
{
thread_local bool checkingAllocation = false;
thread_local int callbackAllocations = 0;
int allocationHook(int type, void*, size_t, int, long, const unsigned char*, int)
{ if (checkingAllocation && (type == _HOOK_ALLOC || type == _HOOK_REALLOC)) ++callbackAllocations; return TRUE; }
}
#endif
#endif

int runIsolatedPluginRegression(const juce::File& directory, bool exerciseEditors)
{
    if (!directory.createDirectory() || directory.getChildFile("result.json").exists()) return 2;
    juce::Array<juce::var> checks;
    bool passed = true;
    const auto check = [&](const char* name, bool success, const juce::String& detail = {}) {
        auto item = std::make_unique<juce::DynamicObject>();
        item->setProperty("name", name); item->setProperty("pass", success); item->setProperty("detail", detail);
        checks.add(juce::var(item.release())); passed &= success;
    };
    juce::PluginDescription description;
    description.name = "Isolation regression probe"; description.pluginFormatName = "OpenStudioIsolationProbe";
    description.fileOrIdentifier = "openstudio-isolation-regression"; description.numInputChannels = description.numOutputChannels = 2;
    juce::String error;
    auto plugin = IsolatedPlugin::create(description, 48000, 512, error);
    check("real_owned_worker_created", plugin != nullptr && plugin->processId() != 0, error);
    if (plugin)
    {
        plugin->setNonRealtime(true); plugin->prepareToPlay(48000, 512);
        juce::AudioBuffer<float> buffer(2, 512);
        juce::MidiBuffer midi; midi.ensureSize(32768);
        std::vector<float> rendered;
        std::vector<int> midiPositions;
        int position = 0;
        for (const int size : { 31, 127, 354, 128, 384, 255, 257, 512, 512 })
        {
            juce::AudioBuffer<float> view(buffer.getArrayOfWritePointers(), 2, size);
            view.clear(); midi.clear();
            if (position == 0) { view.setSample(0, 0, 0.5f); midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(100)), 7); }
            plugin->processBlock(view, midi);
            for (int i = 0; i < size; ++i) rendered.push_back(view.getSample(0, i));
            for (const auto event : midi) midiPositions.push_back(position + event.samplePosition);
            position += size;
        }
        int nonzero = 0;
        for (size_t i = 0; i < rendered.size(); ++i) if (rendered[i] != 0) ++nonzero;
        check("variable_blocks_exact_pipeline_latency", plugin->isHealthy() && nonzero == 1 && rendered[1024] == 0.5f
            && plugin->getLatencySamples() == 1024);
        check("midi_sample_offsets_preserved", midiPositions == std::vector<int>{ 1031 });
        const float gain = 0.25f;
        plugin->setStateInformation(&gain, sizeof(gain));
        juce::MemoryBlock state; plugin->getStateInformation(state);
        check("opaque_state_round_trip", state.getSize() == sizeof(gain) && memcmp(state.getData(), &gain, sizeof(gain)) == 0);
        for (const bool released : { false, true })
        {
            if (released) plugin->releaseResources();
            const float pendingGain = released ? 0.375f : 0.625f;
            plugin->getParameters()[0]->setValue(pendingGain);
            state.reset(); plugin->getStateInformation(state);
            const bool saved = state.getSize() == sizeof(pendingGain)
                && memcmp(state.getData(), &pendingGain, sizeof(pendingGain)) == 0;
            plugin->setStateInformation(&gain, sizeof(gain));
            if (saved) plugin->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            check(released ? "parameter_save_restore_without_device" : "parameter_save_restore_without_audio_packet",
                saved && plugin->getParameters()[0]->getValue() == pendingGain && plugin->isHealthy());
        }
        plugin->prepareToPlay(48000, 512);
        bool parametersPass = plugin->getParameters().size() == 1 && plugin->getHostedParameter(0)->getParameterID() == "gain";
        for (int iteration = 0; iteration < 40; ++iteration)
        {
            plugin->getParameters()[0]->setValue(static_cast<float>(iteration % 10) / 10.0f);
            for (int ch = 0; ch < 2; ++ch) juce::FloatVectorOperations::fill(buffer.getWritePointer(ch), 0.125f, 512);
            midi.clear(); plugin->processBlock(buffer, midi);
            parametersPass &= plugin->isHealthy() && ProcessorSafety::isFinite(buffer) && buffer.getMagnitude(0, 512) <= 0.125f;
        }
        check("rapid_parameter_changes_bounded_finite", parametersPass);
        plugin->getParameters()[0]->setValue(1);
        plugin->reset();
        bool resetPass = true;
        for (int i = 0; i < 5; ++i)
        {
            buffer.clear(); midi.clear(); plugin->processBlock(buffer, midi);
            resetPass &= buffer.getMagnitude(0, 512) == 0 && midi.isEmpty() && plugin->isHealthy();
        }
        check("reset_does_not_replay_pipeline_tail", resetPass);
        plugin->setStateInformation(&gain, sizeof(gain)); // Acknowledge state to preserve after failures.
        juce::AudioBuffer<float> oversized(2, 513); oversized.clear();
        plugin->processBlock(oversized, midi);
        check("oversized_block_locally_quarantined", !plugin->isHealthy() && oversized.getMagnitude(0, 513) == 0);
        check("explicit_restart_preserves_parameter_identity", plugin->restart() && plugin->getHostedParameter(0)->getParameterID() == "gain");
        state.reset(); plugin->getStateInformation(state);
        check("restart_restores_last_acknowledged_state", state.getSize() == sizeof(gain) && memcmp(state.getData(), &gain, sizeof(gain)) == 0);

        auto survivor = IsolatedPlugin::create(description, 48000, 512, error);
        if (survivor) { survivor->setNonRealtime(true); survivor->prepareToPlay(48000, 512); }
        const auto survivorPid = survivor ? survivor->processId() : 0;
        for (int mode : { 1, 2, 3 })
        {
            const bool armed = plugin->setTestFailure(mode);
            const auto started = juce::Time::getMillisecondCounterHiRes();
            for (int i = 0; i < 12 && plugin->isHealthy(); ++i)
            { buffer.clear(); midi.clear(); plugin->processBlock(buffer, midi); }
            const auto elapsed = juce::Time::getMillisecondCounterHiRes() - started;
            check(mode == 1 ? "child_nan_quarantined" : mode == 2 ? "child_access_violation_contained" : "child_dsp_hang_bounded",
                armed && !plugin->isHealthy() && ProcessorSafety::isFinite(buffer) && elapsed < 3500);
            bool survived = survivor != nullptr;
            for (int i = 0; i < 4 && survivor; ++i)
            { buffer.clear(); midi.clear(); survivor->processBlock(buffer, midi); survived &= survivor->isHealthy(); }
            check("independent_worker_survives_fault", survived && survivor->processId() == survivorPid);
            check("explicit_retry_after_dsp_fault", plugin->restart());
        }
        for (int mode : { 4, 5, 6 })
        {
            const bool armed = plugin->setTestFailure(mode);
            const auto started = juce::Time::getMillisecondCounterHiRes();
            if (mode == 6) plugin->openRemoteEditor(); else plugin->getStateInformation(state);
            check(mode == 4 ? "child_state_crash_contained" : mode == 5 ? "child_state_hang_bounded" : "child_editor_crash_contained",
                armed && !plugin->isHealthy() && juce::Time::getMillisecondCounterHiRes() - started < 12000);
            check("explicit_retry_after_control_fault", plugin->restart());
        }
        bool ratePass = true;
        for (const double rate : { 44100.0, 48000.0, 96000.0 })
        {
            plugin->prepareToPlay(rate, 256);
            juce::AudioBuffer<float> view(buffer.getArrayOfWritePointers(), 2, 256);
            for (int i = 0; i < 5; ++i) { view.clear(); midi.clear(); plugin->processBlock(view, midi); }
            ratePass &= plugin->isHealthy() && plugin->transportLatencySamples() == 512;
        }
        check("device_rate_and_block_reprepare", ratePass);
        plugin->setNonRealtime(false); plugin->prepareToPlay(48000, 512);
        bool realtimePass = true;
        double maxCallbackMs = 0;
#if JUCE_WINDOWS && defined(_DEBUG)
        const auto previousHook = _CrtSetAllocHook(allocationHook);
        callbackAllocations = 0;
#endif
        for (int i = 0; i < 160; ++i)
        {
            const int size = i % 2 ? 127 : 129;
            juce::AudioBuffer<float> view(buffer.getArrayOfWritePointers(), 2, size);
            for (int ch = 0; ch < 2; ++ch) juce::FloatVectorOperations::fill(view.getWritePointer(ch), 0.125f, size);
            midi.clear();
#if JUCE_WINDOWS && defined(_DEBUG)
            checkingAllocation = true;
#endif
            const auto started = juce::Time::getMillisecondCounterHiRes();
            plugin->processBlock(view, midi);
            const auto elapsed = juce::Time::getMillisecondCounterHiRes() - started;
#if JUCE_WINDOWS && defined(_DEBUG)
            checkingAllocation = false;
#endif
            maxCallbackMs = juce::jmax(maxCallbackMs, elapsed);
            realtimePass &= plugin->isHealthy() && ProcessorSafety::isFinite(view);
            juce::Thread::sleep(3); // Pace only the device-free fixture, never production RT.
        }
#if JUCE_WINDOWS && defined(_DEBUG)
        _CrtSetAllocHook(previousHook);
        check("proxy_realtime_callback_performs_no_crt_allocations", callbackAllocations == 0, juce::String(callbackAllocations));
#endif
        check("paced_realtime_variable_callbacks_survive", realtimePass);
        auto diagnostic = std::make_unique<juce::DynamicObject>();
        diagnostic->setProperty("status", "diagnostic_only"); diagnostic->setProperty("maximumCallbackMs", maxCallbackMs);
        diagnostic->setProperty("sharedBytesPerInstance", static_cast<juce::int64>(sizeof(IsolatedPluginProtocol::Shared)));
#if JUCE_WINDOWS
        const auto process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, plugin->processId());
        PROCESS_MEMORY_COUNTERS_EX memory {}; memory.cb = sizeof(memory);
        if (process && K32GetProcessMemoryInfo(process, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)))
            diagnostic->setProperty("workerPrivateBytes", static_cast<juce::int64>(memory.PrivateUsage));
        if (process) CloseHandle(process);
#endif
        directory.getChildFile("resource-diagnostic.json").replaceWithText(juce::JSON::toString(juce::var(diagnostic.release())));

        if (exerciseEditors)
        {
            // Explicit visible fixture only; ordinary isolation tests stay headless.
#if JUCE_WINDOWS
            const auto previousForeground = GetForegroundWindow();
#endif
            struct HostWindow final : juce::DocumentWindow {
                HostWindow() : DocumentWindow("OpenStudio isolation focus fixture", juce::Colours::darkgrey, allButtons)
                { setUsingNativeTitleBar(true); setContentOwned(new juce::Component(), true); centreWithSize(320, 180); }
                void closeButtonPressed() override { setVisible(false); }
            } host;
            host.setVisible(true); host.toFront(true);
            bool focusPass = true, closePass = true;
            juce::String editorDetail;
            for (int cycle = 0; cycle < 3; ++cycle)
            {
                const bool opened = plugin->openRemoteEditor();
                focusPass &= opened;
                juce::MessageManager::getInstance()->runDispatchLoopUntil(100);
                editorDetail += "cycle=" + juce::String(cycle) + " openAck=" + juce::String(static_cast<int>(opened))
                    + " visible=" + juce::String(static_cast<int>(plugin->remoteEditorIsOpen())) + " focus=" + juce::String(static_cast<int>(plugin->remoteEditorHasFocus()));
                focusPass &= plugin->remoteEditorIsOpen() && plugin->remoteEditorHasFocus();
                host.toFront(true);
                juce::MessageManager::getInstance()->runDispatchLoopUntil(100);
                focusPass &= !plugin->remoteEditorHasFocus();
                plugin->closeRemoteEditor();
                editorDetail += " afterCloseVisible=" + juce::String(static_cast<int>(plugin->remoteEditorIsOpen())) + " " + plugin->failureDescription() + "; ";
                closePass &= !plugin->remoteEditorIsOpen() && plugin->isHealthy();
            }
            check("native_editor_focus_follows_foreground_window", focusPass, editorDetail);
            check("native_editor_repeated_open_close_keeps_worker_alive", closePass, editorDetail);
            host.setVisible(false);
#if JUCE_WINDOWS
            if (previousForeground && IsWindow(previousForeground)) SetForegroundWindow(previousForeground);
#endif
        }
        auto* hosted = plugin.get();
        plugin->setNonRealtime(true);
        TrackProcessor track;
        track.prepareToPlay(48000, 512);
        const bool mounted = track.addTrackFX(std::move(plugin), 48000, 512);
        const auto hostImpulse = [&] {
            track.resetOfflineRenderState();
            std::vector<float> output;
            for (int i = 0; i < 5; ++i) {
                buffer.clear(); midi.clear();
                if (i == 0) buffer.setSample(0, 0, 0.125f);
                track.processBlock(buffer, midi);
                for (int sample = 0; sample < 512; ++sample) output.push_back(buffer.getSample(0, sample));
            }
            int peakIndex = -1;
            for (size_t i = 0; i < output.size(); ++i) if (std::abs(output[i]) > 0.001f) {
                if (peakIndex != -1) return -2;
                peakIndex = static_cast<int>(i);
            }
            return peakIndex;
        };
        check("track_host_reports_and_renders_isolated_latency", mounted && track.getChainLatency() == 1024 && hostImpulse() == 1024);
        track.bypassTrackFX(0, true);
        check("track_host_bypass_retains_latency_alignment", track.getChainLatency() == 1024 && hostImpulse() == 1024);
        track.bypassTrackFX(0, false);
        hosted->setTestFailure(1);
        for (int i = 0; i < 6; ++i) { buffer.clear(); midi.clear(); track.processBlock(buffer, midi); }
        check("track_host_explicit_restart_clears_remote_fault_latch", !hosted->isHealthy() && hosted->restart() && hostImpulse() == 1024);
        track.removeTrackFX(0);
        check("track_host_removal_clears_isolated_latency", track.getNumTrackFX() == 0 && track.getChainLatency() == 0);
    }
    auto result = std::make_unique<juce::DynamicObject>();
    result->setProperty("passed", passed); result->setProperty("checks", checks);
    result->setProperty("subjectiveAudio", "not_asserted"); result->setProperty("thirdPartyCompatibility", "not_asserted");
    return directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(juce::var(result.release()))) && passed ? 0 : 1;
}

int runIsolatedPluginCompatibility(const juce::File& catalog, const juce::String& name, const juce::File& directory)
{
    if (!directory.createDirectory() || directory.getChildFile("result.json").exists() || catalog.getSize() > 8 * 1024 * 1024) return 2;
    const auto xml = juce::XmlDocument::parse(catalog);
    if (!xml) return 2;
    juce::PluginDescription description;
    bool found = false;
    for (auto* child : xml->getChildIterator())
        if (child->getStringAttribute("name") == name) { found = description.loadFromXml(*child); break; }
    if (!found) return 2;
    juce::String error;
    auto plugin = IsolatedPlugin::create(description, 48000, 512, error);
    bool pass = plugin != nullptr;
    auto result = std::make_unique<juce::DynamicObject>();
    result->setProperty("plugin", name); result->setProperty("version", description.version); result->setProperty("error", error);
    if (plugin)
    {
        juce::MemoryBlock state; plugin->getStateInformation(state);
        result->setProperty("stateBytes", static_cast<int>(state.getSize()));
        pass &= plugin->isHealthy() && state.getSize() > 0;
        for (const double rate : { 44100.0, 48000.0, 96000.0 })
        {
            plugin->setNonRealtime(true); plugin->prepareToPlay(rate, 512);
            juce::AudioBuffer<float> buffer(juce::jmax(2, plugin->getTotalNumInputChannels(), plugin->getTotalNumOutputChannels()), 512);
            juce::MidiBuffer midi; midi.ensureSize(32768);
            for (int i = 0; i < 20; ++i)
            {
                for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
                    for (int s = 0; s < 512; ++s) buffer.setSample(ch, s, 0.05f * std::sin(static_cast<float>(i * 512 + s) * 0.05f));
                if (!plugin->getParameters().isEmpty()) plugin->getParameters()[0]->setValue(static_cast<float>(i % 10) / 10);
                midi.clear(); plugin->processBlock(buffer, midi);
                pass &= plugin->isHealthy() && ProcessorSafety::isFinite(buffer);
            }
            plugin->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            pass &= plugin->isHealthy();
        }
#if JUCE_WINDOWS
        HMODULE modules[2048]; DWORD bytes = 0;
        bool loadedInParent = false;
        if (!K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &bytes) || bytes > sizeof(modules)) pass = false;
        else for (DWORD i = 0; i < bytes / sizeof(HMODULE); ++i)
        {
            wchar_t path[32768] {};
            if (GetModuleFileNameW(modules[i], path, 32768)
                && juce::String(path).equalsIgnoreCase(description.fileOrIdentifier)) loadedInParent = true;
        }
        result->setProperty("pluginModuleLoadedInParent", loadedInParent); pass &= !loadedInParent;
#endif
    }
    result->setProperty("passed", pass); result->setProperty("subjectiveAudio", "not_asserted");
    result->setProperty("editor", "not_asserted");
    directory.getChildFile("result.json").replaceWithText(juce::JSON::toString(juce::var(result.release())));
    return pass ? 0 : 1;
}
