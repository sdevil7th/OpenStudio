// Included by AudioEngine.cpp so the fixture can inspect the host's private
// ownership and scratch-capacity invariants without adding production APIs.
#include "AudioDeviceConfigurationRegression.h"

juce::var AudioEngine::runParallelTrackRegression()
{
    class FixtureDevice final : public juce::AudioIODevice
    {
    public:
        FixtureDevice() : AudioIODevice("Parallel track fixture", "Offline fixture") {}
        juce::StringArray getOutputChannelNames() override { return { "Left", "Right" }; }
        juce::StringArray getInputChannelNames() override
        {
            juce::StringArray names;
            for (int channel = 0; channel < 12; ++channel) names.add("Input " + juce::String(channel + 1));
            return names;
        }
        juce::Array<double> getAvailableSampleRates() override { return { 48000.0 }; }
        juce::Array<int> getAvailableBufferSizes() override { return { 512 }; }
        int getDefaultBufferSize() override { return 512; }
        juce::String open(const juce::BigInteger&, const juce::BigInteger&, double, int) override
        { return "Offline fixture cannot open hardware"; }
        void close() override {}
        bool isOpen() override { return false; }
        void start(juce::AudioIODeviceCallback*) override {}
        void stop() override {}
        bool isPlaying() override { return false; }
        juce::String getLastError() override { return {}; }
        int getCurrentBufferSizeSamples() override { return 512; }
        double getCurrentSampleRate() override { return 48000.0; }
        int getCurrentBitDepth() override { return 32; }
        juce::BigInteger getActiveOutputChannels() const override { return juce::BigInteger(3); }
        juce::BigInteger getActiveInputChannels() const override { return juce::BigInteger(4095); }
        int getOutputLatencyInSamples() override { return 0; }
        int getInputLatencyInSamples() override { return 0; }
    } device;

    juce::Array<juce::var> checks, configurations;
    bool passed = true;
    const auto check = [&](const juce::String& name, bool success, const char* detail,
                           const juce::var& diagnostics = juce::var())
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("name", name);
        result->setProperty("pass", success);
        result->setProperty("detail", detail);
        if (!diagnostics.isVoid()) result->setProperty("diagnostics", diagnostics);
        checks.add(result);
        passed = passed && success;
    };
    {
        // Use the real query and response serialization with a simulated driver.
        // An equal cloned current object must not detach later draft edits from
        // the returned response, and discovery must never apply those edits.
        auto engine = std::make_unique<AudioEngine>(DeviceStartup::offline);
        const juce::String oversamplingTrack = "settings-probe-oversampling";
        bool probeFactorValid = engine->addTrack(oversamplingTrack, "audio") == oversamplingTrack
            && engine->addTrackBuiltInFX(oversamplingTrack, "OpenStudio NAM Rack", false);
        for (const int factor : { 2, 8, 4 })
            probeFactorValid = engine->setProbeNAMRackOversamplingFactor(oversamplingTrack, factor) && probeFactorValid;
        for (const int factor : { 0, 1, 3, 16 })
            probeFactorValid = !engine->setProbeNAMRackOversamplingFactor(oversamplingTrack, factor) && probeFactorValid;
        const auto probeState = engine->getNAMRackDiagnostics(oversamplingTrack, "track", 0);
        check("audio_probe_oversampling_validation", probeFactorValid
                && static_cast<int>(probeState.getProperty("embeddedDriveRequestedOversamplingFactor", 0)) == 4
                && engine->getNAMRackOversamplingFactor() == 4,
            "Offline per-rack requests accept 2/4/8, reject unsupported factors and leave the global preference unchanged.");
        auto& manager = engine->deviceManager;
        juce::Array<juce::AudioIODeviceType*> originalTypes;
        for (auto* type : manager.getAvailableDeviceTypes()) originalTypes.add(type);
        for (auto* type : originalTypes) manager.removeAudioDeviceType(type);
        const juce::String fixtureType = "Settings query fixture";
        manager.addAudioDeviceType(std::make_unique<AudioDeviceConfigurationRegression::Type>(
            fixtureType, false, AudioDeviceConfigurationRegression::OpenMode::normal, false));
        juce::AudioDeviceManager::AudioDeviceSetup initial;
        initial.inputDeviceName = initial.outputDeviceName = "Interface";
        initial.sampleRate = 44100.0;
        initial.bufferSize = 8;
        const auto openError = AudioDeviceConfiguration::apply(manager, fixtureType, initial,
            false, true, [](auto& setup) {
                setup.inputChannels.setRange(0, 2, true);
                setup.outputChannels.setRange(0, 2, true);
                setup.useDefaultInputChannels = setup.useDefaultOutputChannels = false;
            });
        auto* const opened = manager.getCurrentAudioDevice();
        const bool ready = openError.isEmpty() && opened != nullptr;
        check("audio_settings_query_fixture", ready,
            "Only a simulated coupled driver opens at 44100 Hz / 8 samples; physical device types are removed.");
        check("audio_probe_oversampling_rejects_open_device", ready
                && !engine->setProbeNAMRackOversamplingFactor(oversamplingTrack, 8),
            "A per-rack diagnostic oversampling request is refused while any device is open.");
        if (ready)
        {
            engine->refreshAudioDeviceSetupSnapshot(opened);
            const auto applied = engine->getAudioDeviceSetup();
            const auto query = [&](double rate, int block) {
                auto request = applied.getProperty("current", {}).clone();
                request.getDynamicObject()->setProperty("sampleRate", rate);
                request.getDynamicObject()->setProperty("bufferSize", block);
                return juce::JSON::parse(juce::JSON::toString(engine->queryAudioDeviceSetup(request)));
            };
            for (const int block : { 16, 32, 64, 128 })
            {
                const auto response = query(44100.0, block);
                const auto current = response.getProperty("current", {});
                check("audio_settings_query_buffer_" + juce::String(block),
                    response.getProperty("error", {}).toString().isEmpty()
                        && static_cast<int>(current.getProperty("bufferSize", 0)) == block
                        && static_cast<double>(current.getProperty("sampleRate", 0)) == 44100.0,
                    "The serialized native response retains the requested supported buffer before Apply.", response);
            }
            const auto rateResponse = query(48000.0, 8);
            check("audio_settings_query_sample_rate",
                rateResponse.getProperty("error", {}).toString().isEmpty()
                    && static_cast<double>(rateResponse.getProperty("current", {}).getProperty("sampleRate", 0)) == 48000.0
                    && static_cast<int>(rateResponse.getProperty("current", {}).getProperty("bufferSize", 0)) == 8,
                "A same-device sample-rate draft is also published after resolution.", rateResponse);
            const auto afterQueries = engine->getAudioDeviceSetup();
            check("audio_settings_query_preserves_applied_setup",
                afterQueries.getProperty("current", {}) == applied.getProperty("current", {})
                    && manager.getCurrentAudioDevice() == opened
                    && opened->getCurrentBufferSizeSamples() == 8 && opened->getCurrentSampleRate() == 44100.0
                    && engine->hardwareCallbackRegistrationCount.load() == 0,
                "Draft discovery leaves the cached applied setup and simulated running device unchanged.");

            auto unavailable = applied.clone();
            unavailable.getDynamicObject()->setProperty("bufferSizes", juce::Array<juce::var>());
            {
                const juce::ScopedLock lock(engine->audioDeviceSetupSnapshotLock);
                engine->audioDeviceSetupSnapshot = std::move(unavailable);
            }
            const auto failedResponse = query(48000.0, 64);
            check("audio_settings_failed_query_publishes_resolved_draft",
                failedResponse.getProperty("error", {}).toString().isNotEmpty()
                    && failedResponse.getProperty("capabilityStatus", {}).toString() == "unavailable"
                    && static_cast<double>(failedResponse.getProperty("current", {}).getProperty("sampleRate", 0)) == 48000.0
                    && static_cast<int>(failedResponse.getProperty("current", {}).getProperty("bufferSize", -1)) == 0
                    && opened->getCurrentBufferSizeSamples() == 8 && opened->getCurrentSampleRate() == 44100.0,
                "A failed capability query serializes its final draft and leaves the active device untouched.", failedResponse);
        }
    }
    const auto trackId = [](int index) { return "parallel-fixture-" + juce::String(index); };
    const auto createEngine = [&](int trackCount, int workerCount)
    {
        auto engine = std::make_unique<AudioEngine>(DeviceStartup::offline);
        engine->requestedRealtimeWorkers = workerCount;
        engine->audioDeviceAboutToStart(&device);
        bool ready = engine->realtimeTrackExecutor.getWorkerCount() == workerCount;
        for (int index = 0; index < trackCount; ++index)
        {
            const auto id = trackId(index);
            const bool added = engine->addTrack(id, "audio") == id
                && engine->addTrackBuiltInFX(id, "OpenStudio NAM Rack", false);
            ready = added && ready;
            if (!added) continue;
            engine->setTrackInputChannels(id, index, 1);
            engine->setTrackRecordArm(id, true);
            engine->setTrackInputMonitoring(id, true);
            engine->setTrackVolume(id, -18.0f);
            auto* rack = dynamic_cast<OpenStudioNAMRack*>(engine->trackMap.at(id)->getTrackFXProcessor(0));
            ready = rack != nullptr && ready;
            if (rack != nullptr)
            {
                // Exercise stateful native processing without loading any user
                // model, IR or preset. This is not model-capacity evidence.
                rack->ampEnabled.store(0.0f);
                rack->cabEnabled.store(0.0f);
                rack->precisionDriveEnabled.store(1.0f);
                rack->precisionDriveVolumeDb.store(0.0f);
                rack->precisionDriveDrive.store(0.2f + 0.025f * static_cast<float>(index));
            }
        }
        check("fixture_" + juce::String(trackCount) + "_tracks_" + juce::String(workerCount) + "_workers",
              ready && engine->getDeviceManager().getCurrentAudioDevice() == nullptr,
              "Real host callback and native NAM processors; the fake device cannot open hardware.");
        return engine;
    };
    constexpr int capacity = 512;
    constexpr float poison = 0.9375f;
    juce::AudioBuffer<float> input(12, capacity), serialOutput(2, capacity), parallelOutput(2, capacity);
    const auto fillInput = [&](int blockIndex)
    {
        for (int channel = 0; channel < input.getNumChannels(); ++channel)
            for (int sample = 0; sample < capacity; ++sample)
                input.setSample(channel, sample, static_cast<float>(0.1 * std::sin(
                    0.017 * (sample + blockIndex * capacity) + 0.29 * channel)));
    };
    const auto callback = [&](AudioEngine& engine, juce::AudioBuffer<float>& output, int samples)
    {
        for (int channel = 0; channel < output.getNumChannels(); ++channel)
            juce::FloatVectorOperations::fill(output.getWritePointer(channel), poison, capacity);
        engine.audioDeviceIOCallbackWithContext(input.getArrayOfReadPointers(), input.getNumChannels(),
            output.getArrayOfWritePointers(), output.getNumChannels(), samples, {});
        // Control-side inspection must never race a job which missed its
        // deadline. Production quarantine is checked by the executor tests.
        engine.drainRealtimeTrackExecution();
    };
    const auto exactOutput = [&](int samples)
    {
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < samples; ++sample)
                if (!std::isfinite(serialOutput.getSample(channel, sample))
                    || serialOutput.getSample(channel, sample) != parallelOutput.getSample(channel, sample)) return false;
        return true;
    };

    for (const int trackCount : { 4, 12 })
    {
        auto serial = createEngine(trackCount, 0);
        auto parallel = createEngine(trackCount, trackCount - 1);
        bool exact = true, stateChanges = true, finite = true, suffixPreserved = true;
        float peak = 0.0f;
        for (int block = 0; block < 40; ++block)
        {
            for (auto* engine : { serial.get(), parallel.get() })
            {
                if (block == 4)
                {
                    engine->setTrackVolume(trackId(0), -12.0f);
                    engine->setTrackPan(trackId(1), -0.35f);
                    engine->setTrackInputChannels(trackId(2), 0, 1);
                }
                if (block == 8)
                {
                    engine->setTrackMute(trackId(1), true);
                    engine->setTrackSolo(trackId(0), true);
                }
                if (block == 12)
                {
                    engine->setTrackMute(trackId(1), false);
                    engine->setTrackSolo(trackId(0), false);
                    engine->setTrackMasterSendEnabled(trackId(trackCount - 1), false);
                    engine->setTrackOutputChannels(trackId(1), 1, 1);
                }
                if (block == 16)
                {
                    engine->setTrackMasterSendEnabled(trackId(trackCount - 1), true);
                    engine->setTrackOutputChannels(trackId(1), 0, 2);
                    engine->setTrackInputChannels(trackId(0), 0, 2);
                }
                if (block == 20)
                {
                    auto* rack = dynamic_cast<OpenStudioNAMRack*>(engine->trackMap.at(trackId(0))->getTrackFXProcessor(0));
                    stateChanges = rack != nullptr && stateChanges;
                    if (rack != nullptr) rack->precisionDriveDrive.store(0.73f);
                }
                if (block == 24) engine->trackMap.at(trackId(1))->bypassTrackFX(0, true);
                if (block == 28) engine->trackMap.at(trackId(1))->bypassTrackFX(0, false);
                if (block == 32) stateChanges = engine->reorderTrack(trackId(0), trackCount - 1) && stateChanges;
                if (block == 36) stateChanges = engine->removeTrack(trackId(trackCount - 1)) && stateChanges;
            }
            fillInput(block);
            callback(*serial, serialOutput, capacity);
            callback(*parallel, parallelOutput, capacity);
            exact = exactOutput(capacity) && exact;
            peak = juce::jmax(peak, parallelOutput.getMagnitude(0, capacity));
        }
        const auto parityStats = parallel->realtimeTrackExecutor.snapshotStats();
        check("serial_parallel_exact_" + juce::String(trackCount), exact && stateChanges && peak > 0.000001f
            && parityStats.batches == 40 && parityStats.completedBatches == 40
            && parityStats.workerJobs > 0 && parityStats.cancelledJobs == 0
            && parallel->parallelTrackRejectedJobs.load() == 0,
            "Forty 512-frame blocks: mono/stereo input, volume/pan, mute/solo, output route, master send, live Drive, bypass, reorder and removal preserve exact serial output.");

        // Small callbacks exercise allocation capacity and buffer bounds. They
        // deliberately retain their real deadline; do not turn a scheduler
        // timing result on this test runner into an audio-quality assertion.
        const auto* snapshot = parallel->realtimeTrackSnapshotForAudio.load();
        std::vector<const float*> scratchBases;
        for (const auto& entry : snapshot->tracks) scratchBases.push_back(entry.work->buffer.getReadPointer(0));
        bool allocationStable = true;
        for (int repeat = 0; repeat < 8; ++repeat)
            for (const int length : { 1, 8, 16, 7, 31, 128, 512 })
            {
                fillInput(40 + repeat);
                callback(*parallel, parallelOutput, length);
                for (int channel = 0; channel < 2; ++channel)
                    for (int sample = 0; sample < capacity; ++sample)
                    {
                        const float value = parallelOutput.getSample(channel, sample);
                        finite = std::isfinite(value) && finite;
                        if (sample >= length) suffixPreserved = value == poison && suffixPreserved;
                    }
                for (size_t index = 0; index < snapshot->tracks.size(); ++index)
                    allocationStable = snapshot->tracks[index].work->buffer.getReadPointer(0) == scratchBases[index]
                        && allocationStable;
            }
        check("variable_callback_bounds_" + juce::String(trackCount), finite && suffixPreserved && allocationStable
            && parallel->audioCallbackTrackBufferResizeCount.load() == 0 && parallel->oversizedAudioCallbackCount.load() == 0,
            "1/7/8/16/31/128/512 active samples remain finite, preserve the output suffix and retain every preallocated track-audio base address; this is not a general heap-allocation assertion.");

        // Connected/non-NAM tracks stay serial while any remaining isolated
        // NAM pair retains its worker batch.
        const auto mixedBlock = [&](int expectedIndependent)
        {
            const auto before = parallel->realtimeTrackExecutor.snapshotStats().batches;
            fillInput(100);
            callback(*parallel, parallelOutput, capacity);
            return parallel->realtimeTrackExecutor.snapshotStats().batches == before + (expectedIndependent > 1 ? 1u : 0u)
                && ProcessorSafety::isFinite(parallelOutput);
        };
        const bool effectAdded = parallel->addTrackBuiltInFX(trackId(0), "OpenStudio EQ", false);
        const bool pluginFallback = effectAdded && mixedBlock(trackCount - 2);
        const bool effectRemoved = effectAdded && parallel->removeTrackFX(trackId(0), 1);
        const int send = parallel->addTrackSend(trackId(0), trackId(1));
        const bool sendFallback = send >= 0 && mixedBlock(trackCount - 3);
        if (send >= 0) parallel->removeTrackSend(trackId(0), send);
        const bool sidechainAdded = parallel->setSidechainSource(trackId(1), 0, trackId(0));
        const bool sidechainFallback = sidechainAdded && mixedBlock(trackCount - 3);
        if (sidechainAdded) parallel->clearSidechainSource(trackId(1), 0);
        check("mixed_graph_native_subset_" + juce::String(trackCount), pluginFallback && effectRemoved
            && sendFallback && sidechainFallback,
            "Non-NAM and connected tracks retain serial processing; two or more remaining isolated NAM tracks still dispatch as a batch.");

        // Real lifecycle methods drain the executor before buffer reprepare.
        parallel->audioDeviceStopped();
        const bool stopped = parallel->pendingParallelSnapshot == nullptr && parallel->realtimeTrackExecutor.isIdle()
            && parallel->realtimeTrackExecutor.getWorkerCount() == 0;
        parallel->audioDeviceAboutToStart(&device);
        const auto beforeRestart = parallel->realtimeTrackExecutor.snapshotStats().completedBatches;
        fillInput(101);
        callback(*parallel, parallelOutput, capacity);
        check("device_restart_" + juce::String(trackCount), stopped
            && parallel->realtimeTrackExecutor.getWorkerCount() == trackCount - 1
            && parallel->realtimeTrackExecutor.snapshotStats().completedBatches == beforeRestart + 1
            && ProcessorSafety::isFinite(parallelOutput) && parallel->pendingParallelSnapshot == nullptr,
            "Device stop drains and joins helpers; reprepare rebuilds scratch and resumes the eligible graph.");
        configurations.add(parallel->getRealtimeTrackExecutionDiagnostics());
        serial->audioDeviceStopped();
        parallel->audioDeviceStopped();
    }

    // Routing doubles deliberately avoid NAM DSP: the oracle below is plain
    // input + send + external key arithmetic, independent of the refactored
    // host callback. Real NAM DSP parity is covered by the cases above.
    struct PartialContext
    {
        std::atomic<int> workerLane { -1 }, callbackLane { -1 };
        std::atomic<bool> release { false };
        juce::int64 coordinationDeadline = 0;
    };
    class FixtureNAM final : public OpenStudioNAMRack
    {
    public:
        FixtureNAM(int index, PartialContext* partial = nullptr)
            : lane(index), callbackThread(std::this_thread::get_id()), coordination(partial) {}
        void prepareToPlay(double rate, int size) override
        { setRateAndBufferSizeDetails(rate, size); setLatencySamples(0); }
        void releaseResources() override {}
        void reset() override {}
        double getTailLengthSeconds() const override { return 0.0; }
        void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
        {
            juce::ignoreUnused(midi);
            const bool onCallback = std::this_thread::get_id() == callbackThread;
            (onCallback ? callbackCalls : workerCalls).fetch_add(1);
            if (coordination == nullptr) return;
            if (onCallback)
            {
                coordination->callbackLane.store(lane);
                while (coordination->workerLane.load() < 0
                    && juce::Time::getHighResolutionTicks() < coordination->coordinationDeadline)
                    std::this_thread::yield();
            }
            else
            {
                coordination->workerLane.store(lane);
                while (!coordination->release.load()) juce::Thread::sleep(1);
            }
            const float value = lane == 0 ? 0.125f : 0.25f;
            for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
                juce::FloatVectorOperations::fill(buffer.getWritePointer(channel), value, buffer.getNumSamples());
        }
        std::atomic<int> callbackCalls { 0 }, workerCalls { 0 };
    private:
        const int lane;
        const std::thread::id callbackThread;
        PartialContext* const coordination;
    };
    class FixtureKey final : public OpenStudioEQ
    {
    public:
        FixtureKey() : OpenStudioEQ(true), callbackThread(std::this_thread::get_id()) {}
        void prepareToPlay(double rate, int size) override
        { setRateAndBufferSizeDetails(rate, size); setLatencySamples(0); }
        void releaseResources() override {}
        void reset() override {}
        void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
        {
            juce::ignoreUnused(midi);
            callbackOnly = callbackOnly && std::this_thread::get_id() == callbackThread;
            validKey = validKey && buffer.getNumChannels() >= 4;
            if (buffer.getNumChannels() < 4) return;
            for (int channel = 0; channel < 2; ++channel)
                for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
                    buffer.setSample(channel, sample, buffer.getSample(channel, sample)
                        + 0.25f * buffer.getSample(channel + 2, sample));
        }
        bool callbackOnly = true, validKey = true;
    private:
        const std::thread::id callbackThread;
    };
    const auto configureUnityTrack = [](TrackProcessor& track)
    {
        track.setVolume(0.0f);
        track.setPanLaw(PanLaw::Linear);
        track.setPan(0.0f);
        track.setDCOffsetRemoval(false);
        track.setChannelStripEQEnabled(false);
        track.setRecordArmed(true);
        track.setInputMonitoring(true);
    };
    for (const auto precision : { ProcessingPrecisionMode::Float32, ProcessingPrecisionMode::Hybrid64 })
    {
        std::array<std::unique_ptr<AudioEngine>, 2> engines;
        std::array<std::array<FixtureNAM*, 4>, 2> native {};
        std::array<FixtureKey*, 2> key {};
        bool ready = true, exact = true, expected = true, subset = true;
        juce::Array<juce::var> scenarioDiagnostics;
        for (size_t index = 0; index < engines.size(); ++index)
        {
            auto& engine = engines[index];
            engine = std::make_unique<AudioEngine>(DeviceStartup::offline);
            engine->processingPrecisionMode = precision;
            engine->requestedRealtimeWorkers = index == 0 ? 0 : 3;
            engine->audioDeviceAboutToStart(&device);
            engine->setPanLaw("linear");
            engine->setMasterVolume(1.0f);
            for (int lane = 0; lane < 4; ++lane)
            {
                const auto id = trackId(lane);
                ready = engine->addTrack(id, "audio") == id && ready;
                auto* track = engine->trackMap.at(id);
                configureUnityTrack(*track);
                engine->setTrackInputChannels(id, lane, 1);
                if (lane == 1)
                {
                    auto effect = std::make_unique<FixtureKey>();
                    key[index] = effect.get();
                    ready = track->addTrackFX(std::move(effect), 48000.0, capacity) && ready;
                }
                else
                {
                    auto effect = std::make_unique<FixtureNAM>(lane);
                    native[index][static_cast<size_t>(lane)] = effect.get();
                    ready = track->addTrackFX(std::move(effect), 48000.0, capacity) && ready;
                }
            }
            engine->setTrackMasterSendEnabled(trackId(0), false);
            const int send = engine->addTrackSend(trackId(0), trackId(1));
            ready = send == 0 && ready;
            engine->setTrackSendLevel(trackId(0), send, 0.5f);
        }
        // Send only, key only, both, then a one-channel hardware output route;
        // repeat all routes while playing as well as while stopped.
        for (int scenario = 0; scenario < 8; ++scenario)
        {
            const int routeScenario = scenario % 4;
            const bool sendEnabled = routeScenario != 1;
            const bool keyEnabled = routeScenario != 0;
            for (auto& engine : engines)
            {
                engine->isPlaying.store(scenario >= 4);
                engine->setTrackSendEnabled(trackId(0), 0, sendEnabled);
                ready = engine->setSidechainSource(trackId(1), 0, keyEnabled ? trackId(0) : juce::String()) && ready;
                engine->setTrackOutputChannels(trackId(1), routeScenario == 3 ? 1 : 0, routeScenario == 3 ? 1 : 2);
            }
            for (int sample = 0; sample < capacity; ++sample)
            {
                input.setSample(0, sample, static_cast<float>(sample % 17 - 8) * 0.013f);
                input.setSample(1, sample, static_cast<float>(sample % 11 - 5) * 0.041f);
                input.setSample(2, sample, static_cast<float>(sample % 13 - 6) * 0.017f);
                input.setSample(3, sample, static_cast<float>(sample % 7 - 3) * 0.031f);
            }
            const auto batchesBefore = engines[1]->realtimeTrackExecutor.snapshotStats().batches;
            callback(*engines[0], serialOutput, capacity);
            callback(*engines[1], parallelOutput, capacity);
            exact = exactOutput(capacity) && exact;
            subset = engines[1]->realtimeTrackExecutor.snapshotStats().batches == batchesBefore + 1 && subset;
            auto* scenarioResult = new juce::DynamicObject();
            scenarioResult->setProperty("scenario", scenario);
            scenarioResult->setProperty("serialParallelExact", exactOutput(capacity));
            scenarioResult->setProperty("batchesAdded", static_cast<juce::int64>(engines[1]->realtimeTrackExecutor.snapshotStats().batches - batchesBefore));
            double maximumError = 0.0;
            for (int channel = 0; channel < 2; ++channel)
                for (int sample = 0; sample < capacity; ++sample)
                {
                    // In the one-channel output case the destination's left
                    // sample is routed to device right; the right sample is omitted.
                    const int sendChannel = routeScenario == 3 ? 0 : channel;
                    const float sendPan = sendChannel == 0
                        ? std::cos(juce::MathConstants<float>::pi / 4.0f)
                        : std::sin(juce::MathConstants<float>::pi / 4.0f);
                    float destination = sendEnabled ? input.getSample(0, sample) * (sendPan * 0.5f) : 0.0f;
                    destination += input.getSample(1, sample);
                    if (keyEnabled) destination += 0.25f * input.getSample(0, sample);
                    if (routeScenario == 3 && channel == 0) destination = 0.0f;
                    float sum = destination;
                    if (precision == ProcessingPrecisionMode::Float32)
                    {
                        sum += input.getSample(2, sample);
                        sum += input.getSample(3, sample);
                    }
                    else
                        sum = static_cast<float>(static_cast<double>(destination)
                            + static_cast<double>(input.getSample(2, sample)) + static_cast<double>(input.getSample(3, sample)));
                    const float actual = parallelOutput.getSample(channel, sample);
                    const double error = std::abs(static_cast<double>(actual) - sum);
                    maximumError = juce::jmax(maximumError, error);
                    if (error > 0.0000002 && !scenarioResult->hasProperty("firstMismatchSample"))
                    {
                        scenarioResult->setProperty("firstMismatchChannel", channel);
                        scenarioResult->setProperty("firstMismatchSample", sample);
                        scenarioResult->setProperty("expected", sum);
                        scenarioResult->setProperty("actual", actual);
                    }
                    expected = error <= 0.0000002 && expected;
                }
            scenarioResult->setProperty("maximumError", maximumError);
            scenarioDiagnostics.add(scenarioResult);
        }
        for (size_t index = 0; index < engines.size(); ++index)
        {
            subset = native[index][0]->workerCalls.load() == 0 && native[index][0]->callbackCalls.load() == 8
                && key[index]->callbackOnly && key[index]->validKey && subset;
            engines[index]->audioDeviceStopped();
        }
        auto* diagnostics = new juce::DynamicObject();
        diagnostics->setProperty("ready", ready);
        diagnostics->setProperty("exact", exact);
        diagnostics->setProperty("expected", expected);
        diagnostics->setProperty("subset", subset);
        diagnostics->setProperty("scenarios", scenarioDiagnostics);
        check(precision == ProcessingPrecisionMode::Float32 ? "mixed_routing_float32" : "mixed_routing_hybrid64",
            ready && exact && expected && subset,
            "While stopped and playing, send-only/key-only/combined routes and one-channel output match explicit per-sample arithmetic within 2e-7 and serial output exactly. Connected NAM and the key effect execute only on callback; the isolated NAM pair still dispatches in the mixed graph.", diagnostics);
    }

    {
        PartialContext partial;
        auto engine = std::make_unique<AudioEngine>(DeviceStartup::offline);
        engine->requestedRealtimeWorkers = 1;
        engine->audioDeviceAboutToStart(&device);
        engine->setPanLaw("linear");
        engine->setMasterVolume(1.0f);
        bool ready = true;
        for (int lane = 0; lane < 2; ++lane)
        {
            const auto id = trackId(lane);
            ready = engine->addTrack(id, "audio") == id && ready;
            auto* track = engine->trackMap.at(id);
            configureUnityTrack(*track);
            engine->setTrackInputChannels(id, lane, 1);
            ready = track->addTrackFX(std::make_unique<FixtureNAM>(lane, &partial), 48000.0, capacity) && ready;
        }
        partial.coordinationDeadline = juce::Time::getHighResolutionTicks()
            + juce::Time::getHighResolutionTicksPerSecond() / 4;
        fillInput(0);
        engine->audioDeviceIOCallbackWithContext(input.getArrayOfReadPointers(), input.getNumChannels(),
            parallelOutput.getArrayOfWritePointers(), 2, capacity, {});
        const int completeLane = partial.callbackLane.load();
        bool partialPass = ready && completeLane >= 0 && partial.workerLane.load() >= 0
            && completeLane != partial.workerLane.load() && engine->pendingParallelSnapshot != nullptr;
        const float completeValue = completeLane == 0 ? 0.125f : 0.25f;
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < capacity; ++sample)
                partialPass = parallelOutput.getSample(channel, sample) == completeValue && partialPass;
        // Release only after inspecting the partial mix. A later callback may
        // not replay the late lane's old block as fresh output.
        partial.release.store(true);
        engine->drainRealtimeTrackExecution();
        engine->setTrackRecordArm(trackId(0), false);
        engine->setTrackRecordArm(trackId(1), false);
        engine->setTrackInputMonitoring(trackId(0), false);
        engine->setTrackInputMonitoring(trackId(1), false);
        engine->setTrackMute(trackId(0), true);
        engine->setTrackMute(trackId(1), true);
        callback(*engine, parallelOutput, capacity);
        partialPass = parallelOutput.getMagnitude(0, capacity) == 0.0f
            && engine->pendingParallelSnapshot == nullptr && partialPass;
        check("partial_completed_lane_is_reduced_once", partialPass,
            "A real host callback mixes the exact completed-lane signal while another native-type fixture remains Running. After drain and mute, no late output is replayed in the following callback.");
        engine->audioDeviceStopped();
    }

    // Raw recording is taken before the track job, including when another
    // armed track is soloed. Compare decoded PCM rather than WAV metadata.
    const auto recordingDirectory = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile("OpenStudio-parallel-recording-" + juce::Uuid().toString());
    bool recordingPass = recordingDirectory.createDirectory().wasOk();
    {
        auto serial = createEngine(4, 0);
        auto parallel = createEngine(4, 3);
        constexpr int recordingBlocks = 8;
        for (auto* engine : { serial.get(), parallel.get() })
        {
            const auto prefix = engine == serial.get() ? "serial-" : "parallel-";
            for (int index = 0; index < 4; ++index)
                recordingPass = engine->audioRecorder.startRecording(trackId(index),
                    recordingDirectory.getChildFile(prefix + juce::String(index) + ".wav"), 48000.0, 1) && recordingPass;
            engine->setTrackSolo(trackId(0), true);
            engine->isRecordMode.store(true);
            engine->isPlaying.store(true);
        }
        for (int block = 0; block < recordingBlocks; ++block)
        {
            fillInput(block);
            callback(*serial, serialOutput, capacity);
            callback(*parallel, parallelOutput, capacity);
        }
        for (auto* engine : { serial.get(), parallel.get() })
        {
            engine->isPlaying.store(false);
            engine->isRecordMode.store(false);
            const auto completed = engine->audioRecorder.stopAllRecordings(48000.0);
            recordingPass = completed.size() == 4 && engine->audioRecorder.getWriteLockMissCount() == 0
                && engine->audioRecorder.getWriterBufferOverflowCount() == 0 && recordingPass;
        }
        juce::WavAudioFormat format;
        for (int index = 0; index < 4; ++index)
        {
            const auto read = [&](const char* prefix)
            {
                auto stream = recordingDirectory.getChildFile(prefix + juce::String(index) + ".wav").createInputStream();
                if (stream == nullptr) return std::unique_ptr<juce::AudioFormatReader>();
                return std::unique_ptr<juce::AudioFormatReader>(format.createReaderFor(
                    stream.release(), true));
            };
            auto serialReader = read("serial-");
            auto parallelReader = read("parallel-");
            const int frames = recordingBlocks * capacity;
            const bool readersValid = serialReader != nullptr && parallelReader != nullptr
                && serialReader->lengthInSamples == frames && parallelReader->lengthInSamples == frames
                && serialReader->numChannels == 1 && parallelReader->numChannels == 1;
            recordingPass = readersValid && recordingPass;
            if (!readersValid) continue;
            juce::AudioBuffer<float> serialTake(1, frames), parallelTake(1, frames);
            recordingPass = serialReader->read(&serialTake, 0, frames, 0, true, false)
                && parallelReader->read(&parallelTake, 0, frames, 0, true, false) && recordingPass;
            for (int frame = 0; frame < frames; ++frame)
            {
                const float expected = static_cast<float>(0.1 * std::sin(0.017 * frame + 0.29 * index));
                recordingPass = serialTake.getSample(0, frame) == parallelTake.getSample(0, frame)
                    && std::abs(parallelTake.getSample(0, frame) - expected) <= 2.0f / 32768.0f && recordingPass;
            }
        }
        serial->audioDeviceStopped();
        parallel->audioDeviceStopped();
    }
    bool controlDrainPass = true;
    for (const int variant : { 0, 1, 2 })
    {
        const bool mixedGraph = variant > 0;
        const bool addIncomingWhilePending = variant == 2;
        bool quarantinePass = true;
        auto* quarantineDiagnostics = new juce::DynamicObject();
        juce::var quarantineDiagnosticValue(quarantineDiagnostics);
        double maximumOutputError = 0.0, maximumRecordingError = 0.0;
        bool ownedScratchIntact = true;
        const int trackCount = mixedGraph ? 6 : 4;
        const juce::String filePrefix = addIncomingWhilePending ? "new-send-quarantine-"
            : mixedGraph ? "mixed-quarantine-" : "quarantine-";
        auto engine = createEngine(trackCount, 1);
        std::array<FixtureNAM*, 2> serialFixtures {};
        int sourceDelay = 0, destinationDelay = 0;
        const auto fixtureSample = [](int channel, int frame)
        {
            return frame < 0 ? 0.0f : static_cast<float>(0.1 * std::sin(0.017 * frame + 0.29 * channel));
        };
        if (mixedGraph)
        {
            engine->setPanLaw("linear");
            engine->setMasterVolume(1.0f);
            for (int lane = 4; lane < trackCount; ++lane)
            {
                auto* track = engine->trackMap.at(trackId(lane));
                configureUnityTrack(*track);
                quarantinePass = engine->removeTrackFX(trackId(lane), 0) && quarantinePass;
                auto effect = std::make_unique<FixtureNAM>(lane);
                serialFixtures[static_cast<size_t>(lane - 4)] = effect.get();
                quarantinePass = track->addTrackFX(std::move(effect), 48000.0, capacity) && quarantinePass;
            }
            engine->setTrackMasterSendEnabled(trackId(4), false);
            const int send = engine->addTrackSend(trackId(4), trackId(5));
            quarantinePass = send >= 0 && quarantinePass;
            if (send >= 0) engine->setTrackSendLevel(trackId(4), send, 0.5f);
            // The retained real NAM processors report their real latency.
            // Preserve the resulting compensation on the routing doubles,
            // but start its history at the configured delay rather than an
            // unrelated live 0 -> delay transition. The oracle below includes
            // both zero-padded delay lines and the recorder's pre-FX position.
            sourceDelay = engine->trackMap.at(trackId(4))->getPDCDelay();
            destinationDelay = engine->trackMap.at(trackId(5))->getPDCDelay();
            engine->trackMap.at(trackId(4))->resetPDCDelayState();
            engine->trackMap.at(trackId(5))->resetPDCDelayState();
        }
        const auto* snapshot = engine->realtimeTrackSnapshotForAudio.load();
        auto* heldTrack = engine->trackMap.at(trackId(0));
        auto* heldRack = dynamic_cast<OpenStudioNAMRack*>(heldTrack->getTrackFXProcessor(0));
        const auto processedBefore = heldRack != nullptr
            ? static_cast<juce::int64>(heldRack->getDiagnosticState().getProperty("processedBlockCount", -1)) : -1;
        quarantinePass = heldRack != nullptr && processedBefore >= 0 && quarantinePass;
        for (size_t index = 0; index < snapshot->tracks.size(); ++index)
        {
            const auto& entry = snapshot->tracks[index];
            entry.work->jobIndex = index < 4 ? static_cast<int>(index) : -1;
            if (index < 4)
                for (int channel = 0; channel < entry.work->buffer.getNumChannels(); ++channel)
                    juce::FloatVectorOperations::fill(entry.work->buffer.getWritePointer(channel), poison, capacity);
        }
        for (int index = 0; index < trackCount; ++index)
            quarantinePass = engine->audioRecorder.startRecording(trackId(index),
                recordingDirectory.getChildFile(filePrefix + juce::String(index) + ".wav"), 48000.0, 1) && quarantinePass;
        engine->isRecordMode.store(true);
        engine->isPlaying.store(true);
        quarantineDiagnostics->setProperty("setupPass", quarantinePass);
        if (mixedGraph)
        {
            quarantineDiagnostics->setProperty("sourcePDCDelay", engine->trackMap.at(trackId(4))->getPDCDelay());
            quarantineDiagnostics->setProperty("destinationPDCDelay", engine->trackMap.at(trackId(5))->getPDCDelay());
        }

        struct HeldJob
        {
            TrackProcessor* track = nullptr;
            std::thread::id callbackThread;
            std::atomic<bool> entered { false }, release { false };
            juce::int64 coordinationDeadline = 0;
            static void run(void* pointer) noexcept
            {
                auto& job = *static_cast<HeldJob*>(pointer);
                if (std::this_thread::get_id() == job.callbackThread)
                {
                    while (!job.entered.load() && juce::Time::getHighResolutionTicks() < job.coordinationDeadline)
                        std::this_thread::yield();
                    return;
                }
                // Fault fixture only: retain exactly the ownership lease an
                // in-flight native job holds, without concurrently editing DSP.
                const juce::ScopedLock lock(job.track->getCallbackLock());
                job.entered.store(true);
                while (!job.release.load()) juce::Thread::sleep(1);
            }
        } held;
        held.track = heldTrack;
        held.callbackThread = std::this_thread::get_id();
        held.coordinationDeadline = juce::Time::getHighResolutionTicks()
            + juce::Time::getHighResolutionTicksPerSecond() / 4;
        std::array<RealtimeTrackExecutor::Job, 4> jobs;
        for (auto& job : jobs) { job.context = &held; job.run = HeldJob::run; }
        engine->realtimeSnapshotAudioReaders.fetch_add(1, std::memory_order_seq_cst);
        engine->pendingParallelSnapshot = snapshot;
        const bool missed = !engine->realtimeTrackExecutor.runBatch(jobs.data(), static_cast<int>(jobs.size()),
            juce::Time::getHighResolutionTicks() + juce::Time::getHighResolutionTicksPerSecond() / 20);
        quarantinePass = held.entered.load() && missed && !engine->realtimeTrackExecutor.isIdle() && quarantinePass;
        quarantineDiagnostics->setProperty("heldJobWitness", held.entered.load() && missed && !engine->realtimeTrackExecutor.isIdle());
        if (addIncomingWhilePending)
        {
            const int send = engine->addTrackSend(trackId(4), trackId(1));
            quarantinePass = send >= 0 && quarantinePass;
            if (send >= 0) engine->setTrackSendLevel(trackId(4), send, 0.25f);
            quarantinePass = engine->realtimeTrackSnapshotForAudio.load() != snapshot && quarantinePass;
        }
        const auto quarantinedBefore = engine->parallelQuarantinedBlocks.load();
        const auto batchesBefore = engine->realtimeTrackExecutor.snapshotStats().batches;
        constexpr int quarantinedCallbacks = 3;
        for (int block = 0; block < quarantinedCallbacks; ++block)
        {
            fillInput(block);
            // Do not use callback(): its control drain intentionally waits for
            // workers, whereas this fixture needs the live quarantine branch.
            engine->audioDeviceIOCallbackWithContext(input.getArrayOfReadPointers(), input.getNumChannels(),
                parallelOutput.getArrayOfWritePointers(), 2, capacity, {});
            quarantinePass = ProcessorSafety::isFinite(parallelOutput) && quarantinePass;
            for (int channel = 0; channel < 2; ++channel)
                for (int sample = 0; sample < capacity; ++sample)
                {
                    const float sendPan = channel == 0 ? std::cos(juce::MathConstants<float>::pi / 4.0f)
                                                       : std::sin(juce::MathConstants<float>::pi / 4.0f);
                    const int frame = block * capacity + sample;
                    const float expected = mixedGraph
                        ? fixtureSample(4, frame - sourceDelay - destinationDelay) * (sendPan * 0.5f)
                            + fixtureSample(5, frame - destinationDelay)
                        : 0.0f;
                    const float actual = parallelOutput.getSample(channel, sample);
                    const double error = std::abs(static_cast<double>(actual) - expected);
                    maximumOutputError = juce::jmax(maximumOutputError, error);
                    if (error > 0.0000002 && !quarantineDiagnostics->hasProperty("firstOutputMismatchSample"))
                    {
                        quarantineDiagnostics->setProperty("firstOutputMismatchBlock", block);
                        quarantineDiagnostics->setProperty("firstOutputMismatchChannel", channel);
                        quarantineDiagnostics->setProperty("firstOutputMismatchSample", sample);
                        quarantineDiagnostics->setProperty("outputExpected", expected);
                        quarantineDiagnostics->setProperty("outputActual", actual);
                    }
                    quarantinePass = error <= 0.0000002
                        && quarantinePass;
                }
            for (size_t index = 0; index < 4; ++index)
            {
                const auto& entry = snapshot->tracks[index];
                for (int channel = 0; channel < entry.work->buffer.getNumChannels(); ++channel)
                    for (int sample = 0; sample < capacity; ++sample)
                        ownedScratchIntact = entry.work->buffer.getSample(channel, sample) == poison && ownedScratchIntact;
            }
        }
        quarantinePass = engine->parallelQuarantinedBlocks.load() == quarantinedBefore + quarantinedCallbacks
            && engine->realtimeTrackExecutor.snapshotStats().batches == batchesBefore
            && heldRack != nullptr
            && static_cast<juce::int64>(heldRack->getDiagnosticState().getProperty("processedBlockCount", -1)) == processedBefore
            && ownedScratchIntact && quarantinePass;
        quarantineDiagnostics->setProperty("ownedScratchIntact", ownedScratchIntact);
        quarantineDiagnostics->setProperty("maximumOutputError", maximumOutputError);
        quarantineDiagnostics->setProperty("newBatches", static_cast<juce::int64>(engine->realtimeTrackExecutor.snapshotStats().batches - batchesBefore));
        if (mixedGraph)
            for (const auto* fixture : serialFixtures)
                quarantinePass = fixture != nullptr && fixture->callbackCalls.load() == quarantinedCallbacks
                    && fixture->workerCalls.load() == 0 && quarantinePass;

        std::atomic<bool> stopEntered { false }, stopFinished { false };
        std::thread stopper([&]
        {
            stopEntered.store(true);
            engine->audioDeviceStopped();
            stopFinished.store(true);
        });
        while (!stopEntered.load()) std::this_thread::yield();
        juce::Thread::sleep(5);
        controlDrainPass = !stopFinished.load() && controlDrainPass;
        held.release.store(true);
        stopper.join();
        controlDrainPass = stopFinished.load() && engine->pendingParallelSnapshot == nullptr
            && engine->realtimeSnapshotAudioReaders.load() == 0 && engine->realtimeTrackExecutor.isIdle()
            && engine->realtimeTrackExecutor.getWorkerCount() == 0 && controlDrainPass;
        engine->isRecordMode.store(false);
        engine->isPlaying.store(false);
        const auto completed = engine->audioRecorder.stopAllRecordings(48000.0);
        quarantinePass = completed.size() == static_cast<size_t>(trackCount) && engine->audioRecorder.getWriteLockMissCount() == 0
            && engine->audioRecorder.getWriterBufferOverflowCount() == 0 && quarantinePass;
        quarantineDiagnostics->setProperty("completedRecordings", static_cast<int>(completed.size()));
        quarantineDiagnostics->setProperty("passBeforeReadingRecordings", quarantinePass);
        juce::WavAudioFormat format;
        for (int index = 0; index < trackCount; ++index)
        {
            auto stream = recordingDirectory.getChildFile(filePrefix + juce::String(index) + ".wav").createInputStream();
            std::unique_ptr<juce::AudioFormatReader> reader(stream != nullptr ? format.createReaderFor(stream.release(), true) : nullptr);
            const int frames = quarantinedCallbacks * capacity;
            const bool valid = reader != nullptr && reader->numChannels == 1 && reader->lengthInSamples == frames;
            quarantinePass = valid && quarantinePass;
            if (!valid) continue;
            juce::AudioBuffer<float> take(1, frames);
            quarantinePass = reader->read(&take, 0, frames, 0, true, false) && quarantinePass;
            for (int frame = 0; frame < frames; ++frame)
            {
                float expected = fixtureSample(index, frame);
                if (mixedGraph && index == 5)
                    expected += fixtureSample(4, frame - sourceDelay)
                        * (std::cos(juce::MathConstants<float>::pi / 4.0f) * 0.5f);
                if (addIncomingWhilePending && index == 1)
                    expected += fixtureSample(4, frame - sourceDelay)
                        * (std::cos(juce::MathConstants<float>::pi / 4.0f) * 0.25f);
                const float actual = take.getSample(0, frame);
                const double error = std::abs(static_cast<double>(actual) - expected);
                maximumRecordingError = juce::jmax(maximumRecordingError, error);
                if (error > 2.0 / 32768.0 && !quarantineDiagnostics->hasProperty("firstRecordingMismatchFrame"))
                {
                    quarantineDiagnostics->setProperty("firstRecordingMismatchTrack", index);
                    quarantineDiagnostics->setProperty("firstRecordingMismatchFrame", frame);
                    quarantineDiagnostics->setProperty("recordingExpected", expected);
                    quarantineDiagnostics->setProperty("recordingActual", actual);
                }
                quarantinePass = error <= 2.0 / 32768.0 && quarantinePass;
            }
        }
        quarantineDiagnostics->setProperty("maximumRecordingError", maximumRecordingError);
        check(addIncomingWhilePending ? "pending_worker_new_incoming_send_recording"
                : mixedGraph ? "pending_worker_mixed_send_recording" : "pending_worker_quarantine_preserves_raw_recording", quarantinePass,
            addIncomingWhilePending
                ? "A new snapshot adds an unowned source send into an old queued processor. Identity quarantine retains all old owned scratch while that raw take includes the current incoming send; unrelated send monitoring/recording follows an explicit zero-padded PDC delay oracle without new dispatch."
                : mixedGraph
                ? "Four retained native owners remain untouched while an unrelated source/send/destination graph processes on callback. Three blocks match an explicit zero-padded PDC delay oracle for monitoring and raw send-destination PCM, and no new worker batch is dispatched."
                : "A deliberately held helper retains a track lock and snapshot pin across three real host callbacks; monitoring is silent, DSP counters/scratch remain untouched and all four raw recordings preserve exact frame counts and 16-bit input parity.", quarantineDiagnosticValue);
    }
    check("device_stop_waits_for_pending_worker", controlDrainPass,
        "The real audioDeviceStopped control path cannot finish while the helper owns its track; after release it drains, joins workers and retires the snapshot reader pin.");
    const bool temporaryFilesRemoved = recordingDirectory.deleteRecursively();
    check("raw_recording_serial_parallel", recordingPass,
        "Four armed mono sources retain identical decoded 16-bit PCM and exact frame counts before Drive/pan/solo.");
    check("temporary_recordings_cleaned", temporaryFilesRemoved,
        "The unique temporary fixture directory is removed after readers, writers, worker jobs and engines close.");
    auto* result = new juce::DynamicObject();
    result->setProperty("pass", passed);
    result->setProperty("success", passed);
    result->setProperty("checks", checks);
    result->setProperty("configurations", configurations);
    result->setProperty("scope", "Offline full-host routing, exact 512-frame output, raw recording, scratch bounds and lifecycle contracts. No model/IR resources or physical audio device are opened.");
    result->setProperty("tinyBufferCapacity", "diagnostic_only");
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
