#include "AudioEngine.h"
#include "S13FXProcessor.h"
#include "BuiltInEffects.h"
#include "BuiltInEffects2.h"
#include "S13PitchCorrector.h"
#include "PitchAnalyzer.h"
#include "PitchResynthesizer.h"

// Debug logging — always active for FX diagnostics
static void logToDisk(const juce::String& msg)
{
    auto f = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
             .getChildFile("Studio13").getChildFile("debug_log.txt");
    f.appendText(juce::Time::getCurrentTime().toString(true, true) + ": " + msg + "\n");
}

AudioEngine::AudioEngine()
{
    // Initialize graphs and managers BEFORE opening the audio device.
    // addAudioCallback() (below) triggers audioDeviceAboutToStart() synchronously
    // on an already-running device. audioDeviceAboutToStart() checks
    // `if (mainProcessorGraph)` before doing any setup, so the graph must exist
    // by the time addAudioCallback() is called — otherwise the null check
    // short-circuits and reusableTrackBuffer/metronome/IO nodes are never set up.
    mainProcessorGraph = std::make_unique<juce::AudioProcessorGraph>();
    masterFXChain = std::make_unique<juce::AudioProcessorGraph>();
    monitoringFXChain = std::make_unique<juce::AudioProcessorGraph>();

    // Initialize MIDI Manager (Phase 2)
    midiManager = std::make_unique<MIDIManager>();
    midiManager->setMessageCallback([this](const juce::String& deviceName, int channel, const juce::MidiMessage& message) {
        handleMIDIMessage(deviceName, channel, message);
    });

    // Initialize Control Surface Manager (Phase 3.10)
    controlSurfaceManager.setCallback(this);

    // Now open the audio device and register the callback. This is done last so
    // that all members above are valid when audioDeviceAboutToStart() fires.
    loadDeviceSettings();
    deviceManager.addAudioCallback (this);

    // Initialize Lua scripting engine (runs on message thread only)
    scriptEngine.registerAPI(*this);

    juce::Logger::writeToLog("AudioEngine: MIDI Manager initialized");
    juce::Logger::writeToLog("AudioEngine: Lua ScriptEngine initialized");
}

AudioEngine::~AudioEngine()
{
    deviceManager.removeAudioCallback (this);
}

juce::File AudioEngine::getDeviceSettingsFile() const
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
             .getChildFile("Studio13")
             .getChildFile("audio_device_settings.xml");
}

void AudioEngine::saveDeviceSettings()
{
    auto xml = deviceManager.createStateXml();
    if (xml)
    {
        auto settingsFile = getDeviceSettingsFile();
        settingsFile.getParentDirectory().createDirectory();
        xml->writeTo(settingsFile);
        juce::Logger::writeToLog("AudioEngine: Device settings saved to " + settingsFile.getFullPathName());
    }
}

void AudioEngine::loadDeviceSettings()
{
    auto settingsFile = getDeviceSettingsFile();
    if (settingsFile.existsAsFile())
    {
        auto xml = juce::XmlDocument::parse(settingsFile);
        if (xml)
        {
            auto error = deviceManager.initialise(2, 2, xml.get(), true);
            if (error.isEmpty())
            {
                juce::Logger::writeToLog("AudioEngine: Restored device settings from " + settingsFile.getFullPathName());
                return;
            }
            juce::Logger::writeToLog("AudioEngine: Failed to restore settings: " + error + " - using defaults");
        }
    }

    // No saved settings or failed to load - use defaults
    deviceManager.initialiseWithDefaultDevices(2, 2);
}

void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    logToDisk("AudioEngine: Device About To Start");
    if (device == nullptr)
    {
        juce::Logger::writeToLog("AudioEngine ERROR: audioDeviceAboutToStart called with nullptr device!");
        return;
    }
    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = device->getCurrentBufferSizeSamples();
    inputLatencySamples = device->getInputLatencyInSamples();
    logToDisk("Input latency: " + juce::String(inputLatencySamples) + " samples ("
              + juce::String(inputLatencySamples / currentSampleRate * 1000.0, 1) + " ms)");
    if (mainProcessorGraph)
    {
        // ... (keep existing config logic)
        mainProcessorGraph->setPlayConfigDetails (device->getActiveInputChannels().countNumberOfSetBits(),
                                                  device->getActiveOutputChannels().countNumberOfSetBits(),
                                                  device->getCurrentSampleRate(),
                                                  device->getCurrentBufferSizeSamples());
        mainProcessorGraph->prepareToPlay (device->getCurrentSampleRate(),
                                           device->getCurrentBufferSizeSamples());

        // Pre-allocate reusable buffers (avoids malloc on audio thread)
        reusableTrackBuffer.setSize (2, device->getCurrentBufferSizeSamples());
        reusableMasterBuffer.setSize (device->getActiveOutputChannels().countNumberOfSetBits(),
                                      device->getCurrentBufferSizeSamples());

        // Pre-allocate sidechain output buffers for all existing tracks
        for (const auto& id : trackOrder)
            sidechainOutputBuffers[id].setSize(2, device->getCurrentBufferSizeSamples());

        // Pre-allocate send accumulation buffers for all existing tracks
        for (const auto& id : trackOrder)
            sendAccumBuffers[id].setSize(2, device->getCurrentBufferSizeSamples());

        // Metronome Init
        metronome.prepareToPlay(device->getCurrentSampleRate(), device->getCurrentBufferSizeSamples());
        metronome.setBpm(tempo);
        metronome.setTimeSignature(timeSigNumerator, timeSigDenominator);
                                           
        // Propagate this AudioEngine as the AudioPlayHead to all existing plugins
        // so they receive tempo/position during processBlock.
        for (const auto& id : trackOrder)
        {
            auto it = trackMap.find (id);
            if (it != trackMap.end())
                propagatePlayHead (it->second);
        }
        for (auto& node : masterFXNodes)
            if (node && node->getProcessor())
                node->getProcessor()->setPlayHead (this);
        for (auto& node : monitoringFXNodes)
            if (node && node->getProcessor())
                node->getProcessor()->setPlayHead (this);

        // mainProcessorGraph->clear(); // COMMENTED OUT TO DEBUG - This wipes tracks!

        // Add IO Nodes only if missing
        if (!audioInputNode) {
            logToDisk("Adding IO Nodes...");
            audioInputNode = mainProcessorGraph->addNode (std::make_unique<juce::AudioProcessorGraph::AudioGraphIOProcessor> (juce::AudioProcessorGraph::AudioGraphIOProcessor::audioInputNode));
            audioOutputNode = mainProcessorGraph->addNode (std::make_unique<juce::AudioProcessorGraph::AudioGraphIOProcessor> (juce::AudioProcessorGraph::AudioGraphIOProcessor::audioOutputNode));
            
            // Connect any existing tracks that were added before device init
            if (audioOutputNode) {
                logToDisk("Connecting existing tracks to output...");
                int connectedCount = 0;
                
                for (auto* node : mainProcessorGraph->getNodes()) {
                    // Skip IO nodes
                    if (node == audioInputNode.get() || node == audioOutputNode.get())
                        continue;
                    
                    // Check if this is a TrackProcessor
                    if (dynamic_cast<TrackProcessor*>(node->getProcessor())) {
                        // Connect stereo channels
                        mainProcessorGraph->addConnection ({ { node->nodeID, 0 }, { audioOutputNode->nodeID, 0 } });
                        mainProcessorGraph->addConnection ({ { node->nodeID, 1 }, { audioOutputNode->nodeID, 1 } });
                        connectedCount++;
                    }
                }
                
                logToDisk("Connected " + juce::String(connectedCount) + " existing tracks.");
            }
        }
    }
}

void AudioEngine::audioDeviceStopped()
{
    logToDisk("AudioEngine: Device Stopped");
    if (mainProcessorGraph)
    {
        mainProcessorGraph->releaseResources();
        // mainProcessorGraph->clear(); // Prevent wiping tracks on stop
        // audioInputNode = nullptr;
        // audioOutputNode = nullptr;
    }
}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                                    int numInputChannels,
                                                    float* const* outputChannelData,
                                                    int numOutputChannels,
                                                    int numSamples,
                                                    const juce::AudioIODeviceCallbackContext& context)
{
    juce::ignoreUnused(context);
    // Clear outputs first
    for (int i = 0; i < numOutputChannels; ++i)
        juce::FloatVectorOperations::clear (outputChannelData[i], numSamples);

    // During offline rendering, skip ALL processing to avoid sharing FX plugin
    // instances between the audio callback and the render thread
    if (isRendering.load())
        return;

    // Acquire the callback lock to safely access trackOrder, trackMap, masterFXNodes.
    // Use TryLock so we never block the audio thread - if the lock is held
    // (e.g. during addTrack/removeTrack), we skip this buffer (~5ms silence).
    // This prevents crackling from data races when the graph is being modified.
    const juce::ScopedTryLock sl(mainProcessorGraph->getCallbackLock());
    if (!sl.isLocked())
        return;  // Graph is being modified, output silence for this block

    // NOTE: currentSamplePosition is advanced AFTER all processing (metronome,
    // playback, recording) so that everything in this callback uses the correct
    // position for the samples being output right now.  The increment is at the
    // very end of the callback (search "Advance transport position").

    // Update metronome BPM from tempo map at current position
    {
        double currentBpm = getTempoAtTime(currentSamplePosition / currentSampleRate);
        metronome.setBpm(currentBpm);
    }

    // Mix Metronome (if enabled and transport is running)
    if (isPlaying || isRecordMode)
    {
        juce::AudioBuffer<float> outputBuffer(const_cast<float**>(outputChannelData), numOutputChannels, numSamples);
        metronome.getNextAudioBlock(outputBuffer, currentSamplePosition);
    }

    // Use cached solo state (updated when solo changes, avoids scanning every callback)
    bool anySoloed = cachedAnySoloed.load();

    // ========== Determine sidechain-aware processing order ==========
    // Build a topological ordering so that sidechain source tracks are processed
    // before destination tracks.  For small track counts (<32) a simple multi-pass
    // algorithm is efficient and avoids any heap allocation on the audio thread.
    //
    // processedOrder: indices into trackOrder in the order they should be processed.
    // We use a fixed-size stack array (max 64 tracks) to avoid heap allocation.
    constexpr int MAX_TRACKS = 64;
    int processedOrder[MAX_TRACKS];
    bool trackProcessed[MAX_TRACKS];
    int numTracks = juce::jmin((int)trackOrder.size(), MAX_TRACKS);
    int orderCount = 0;

    for (int t = 0; t < numTracks; ++t)
        trackProcessed[t] = false;

    // Check if any track has sidechain routing (fast path: skip sorting if none)
    bool anySidechainRouting = false;
    for (int t = 0; t < numTracks && !anySidechainRouting; ++t)
    {
        auto tIt = trackMap.find(trackOrder[static_cast<size_t>(t)]);
        if (tIt != trackMap.end() && tIt->second && tIt->second->hasAnySidechainSources())
            anySidechainRouting = true;
    }

    if (anySidechainRouting)
    {
        // Simple iterative topological sort: in each pass, add tracks whose
        // sidechain sources have already been processed.
        int maxPasses = numTracks + 1;
        for (int pass = 0; pass < maxPasses && orderCount < numTracks; ++pass)
        {
            for (int t = 0; t < numTracks; ++t)
            {
                if (trackProcessed[t]) continue;

                auto tIt = trackMap.find(trackOrder[static_cast<size_t>(t)]);
                if (tIt == trackMap.end() || !tIt->second)
                {
                    trackProcessed[t] = true;
                    processedOrder[orderCount++] = t;
                    continue;
                }

                // Check if all sidechain source tracks are already processed
                bool depsReady = true;
                auto* trk = tIt->second;
                for (int fx = 0; fx < trk->getNumTrackFX() && depsReady; ++fx)
                {
                    auto srcId = trk->getSidechainSource(fx);
                    if (srcId.isEmpty()) continue;

                    // Find source track index in trackOrder
                    bool srcFound = false;
                    for (int s = 0; s < numTracks; ++s)
                    {
                        if (trackOrder[static_cast<size_t>(s)] == srcId)
                        {
                            if (!trackProcessed[s])
                                depsReady = false;
                            srcFound = true;
                            break;
                        }
                    }
                    juce::ignoreUnused(srcFound);
                    // If source not found in trackOrder, treat dep as ready (missing track)
                }

                if (depsReady)
                {
                    trackProcessed[t] = true;
                    processedOrder[orderCount++] = t;
                }
            }
        }

        // Any remaining tracks (circular deps) — add them at the end
        for (int t = 0; t < numTracks; ++t)
        {
            if (!trackProcessed[t])
                processedOrder[orderCount++] = t;
        }
    }
    else
    {
        // No sidechain routing — use original order (no sorting overhead)
        for (int t = 0; t < numTracks; ++t)
            processedOrder[t] = t;
        orderCount = numTracks;
    }

    // Process each track in sidechain-aware order
    for (int orderIdx = 0; orderIdx < orderCount; ++orderIdx)
    {
        int trackIdx = processedOrder[orderIdx];
        const auto& trackId = trackOrder[static_cast<size_t>(trackIdx)];
        auto trackIt = trackMap.find(trackId);  // Single lookup, reuse iterator
        if (trackIt == trackMap.end()) continue;

        auto* track = trackIt->second;
        if (!track)
            continue;

        // Solo logic: if any track is soloed, skip non-soloed tracks entirely
        // (recording still works because record-armed tracks should also be soloed,
        //  and in practice users don't solo-off a track they're actively recording)
        if (anySoloed && !track->getSolo())
        {
            track->resetRMS();
            continue;
        }

        // Monitor hardware input when track is armed and not muted
        bool shouldMonitor = track->getRecordArmed() && !track->getMute();

        // Get track's input configuration
        int startChan = track->getInputStartChannel();
        int numChans = track->getInputChannelCount();

        if (shouldMonitor)
        {
            // Safety check
            if (startChan < 0 || startChan >= numInputChannels)
                continue;
        }

        // Skip this track if it's not playing clips and not monitoring
        // This prevents unarmed tracks from passing through input audio
        if (!isPlaying && !shouldMonitor)
        {
            track->resetRMS();  // Clear meter so it drops to zero when idle
            continue;
        }

        // Non-owning view of the pre-allocated buffer — avoids heap alloc on audio thread.
        // ALWAYS 2 channels (stereo) for proper pan support.
        //
        // IMPORTANT: getWritePointer() is used (not getArrayOfWritePointers()) because
        // it sets isClear=false on reusableTrackBuffer as a side effect. Without this,
        // JUCE 8's isClear optimisation makes clear() a no-op when a previous iteration
        // left isClear=true, and makes applyGain/getRMSLevel skip processing (they also
        // guard on isClear), causing stale signal to accumulate across track iterations.
        //
        // Emergency guard: if the pre-allocated buffer is somehow undersized (shouldn't
        // happen on ASIO but guards against unusual driver behaviour), resize it here.
        // This heap-allocates only in that exceptional case.
        if (reusableTrackBuffer.getNumSamples() < numSamples || reusableTrackBuffer.getNumChannels() < 2)
            reusableTrackBuffer.setSize (2, numSamples, false, true);

        float* trackChans[2] = { reusableTrackBuffer.getWritePointer (0),
                                  reusableTrackBuffer.getWritePointer (1) };
        juce::AudioBuffer<float> trackBuffer (trackChans, 2, numSamples);
        trackBuffer.clear();

        // ========== MIX IN ACCUMULATED SENDS from other tracks ==========
        {
            auto accumIt = sendAccumBuffers.find(trackId);
            if (accumIt != sendAccumBuffers.end())
            {
                auto& accumBuf = accumIt->second;
                if (accumBuf.getNumSamples() >= numSamples)
                {
                    for (int ch = 0; ch < juce::jmin(2, accumBuf.getNumChannels()); ++ch)
                        juce::FloatVectorOperations::add(
                            trackBuffer.getWritePointer(ch),
                            accumBuf.getReadPointer(ch),
                            numSamples);
                }
                accumBuf.clear();
            }
        }

        // PLAYBACK MODE: Read from clips if transport is playing
        if (isPlaying)
        {
            // Apply per-track playback offset (ms → seconds)
            double trackOffsetSec = track->getPlaybackOffset() / 1000.0;
            double adjustedTime = (currentSamplePosition / currentSampleRate) - trackOffsetSec;

            // Fill buffer with playback audio from clips
            playbackEngine.fillTrackBuffer(
                trackId,
                trackBuffer,
                adjustedTime,
                numSamples,
                currentSampleRate
            );
        }

        // MONITORING/RECORDING MODE: Mix in input audio if monitoring
        if (shouldMonitor)
        {
            // Copy hardware inputs to track buffer (mix with playback if both active)
            // If input is mono, copy to both L/R channels for proper pan support
            for (int ch = 0; ch < numChans && (startChan + ch) < numInputChannels; ++ch)
            {
                if (isPlaying)
                {
                    // Mix input with playback (overdub mode)
                    juce::FloatVectorOperations::add(
                        trackBuffer.getWritePointer(ch),
                        inputChannelData[startChan + ch],
                        numSamples
                    );
                }
                else
                {
                    // Just copy input (monitoring only)
                    trackBuffer.copyFrom(ch, 0, inputChannelData[startChan + ch], numSamples);
                }
            }

            // If input is mono but trackBuffer is stereo, duplicate to right channel
            if (numChans == 1 && trackBuffer.getNumChannels() >= 2)
            {
                trackBuffer.copyFrom(1, 0, trackBuffer, 0, 0, numSamples);
            }
        }

        // ========== RECORD RAW AUDIO (BEFORE FX) ==========
        // Write to recorder if transport is playing AND in record mode
        // This captures the raw input BEFORE any FX processing
        if (isPlaying && isRecordMode && audioRecorder.isRecording(trackId))
        {
            // Capture recording start time on the audio thread (race-free).
            // The message thread sets pendingRecordStartCapture; we read it once
            // here and stamp every active recording with the current position
            // minus input latency.
            if (pendingRecordStartCapture.exchange(false, std::memory_order_acq_rel))
            {
                double latencyComp = inputLatencySamples / currentSampleRate;
                double startPos = (currentSamplePosition / currentSampleRate) - latencyComp;
                if (startPos < 0.0) startPos = 0.0;
                // Set for all active recordings (they all started at the same point)
                for (auto const& [recId, recTrack] : trackMap)
                {
                    juce::ignoreUnused(recTrack);
                    if (audioRecorder.isRecording(recId))
                        audioRecorder.setRecordingStartTime(recId, startPos);
                    if (midiRecorder.isRecording(recId))
                        midiRecorder.setRecordingStartTime(recId, startPos);
                }
            }

            // Punch recording: only write audio within punch range
            bool shouldWrite = true;
            if (punchEnabled.load(std::memory_order_acquire))
            {
                double posSeconds = currentSamplePosition / currentSampleRate;
                double punchStart = punchStartTime.load(std::memory_order_relaxed);
                double punchEnd = punchEndTime.load(std::memory_order_relaxed);
                shouldWrite = (posSeconds >= punchStart && posSeconds < punchEnd);
            }

            if (shouldWrite)
                audioRecorder.writeBlock(trackId, trackBuffer, numSamples);
        }

        // Tell the track where we are on the timeline so automation can evaluate
        track->setCurrentBlockPosition(currentSamplePosition, currentSampleRate);

        // ========== SIDECHAIN: provide source track's output to this track ==========
        // If this track has any sidechain-routed FX plugins, find the first sidechain
        // source track and point the track's sidechainInputBuffer to its stored output.
        if (track->hasAnySidechainSources())
        {
            // Find the first sidechain source track ID (all SC FX on this track
            // share the same sidechain input buffer for simplicity — the source is
            // determined by the first configured sidechain FX)
            const juce::AudioBuffer<float>* scBuffer = nullptr;
            for (int fx = 0; fx < track->getNumTrackFX(); ++fx)
            {
                auto srcId = track->getSidechainSource(fx);
                if (srcId.isNotEmpty())
                {
                    auto scIt = sidechainOutputBuffers.find(srcId);
                    if (scIt != sidechainOutputBuffers.end())
                    {
                        scBuffer = &scIt->second;
                        break;
                    }
                }
            }
            track->setSidechainBuffer(scBuffer);
        }
        else
        {
            track->setSidechainBuffer(nullptr);
        }

        // Process through track (applies volume, pan, FX, automation)
        juce::MidiBuffer midiMessages;
        track->processBlock(trackBuffer, midiMessages);

        // ========== SIDECHAIN: store this track's output for downstream tracks ==========
        // Copy the processed output into the pre-allocated sidechain buffer so that
        // tracks processed later can use it as sidechain input.
        {
            auto scOutIt = sidechainOutputBuffers.find(trackId);
            if (scOutIt != sidechainOutputBuffers.end())
            {
                auto& scOut = scOutIt->second;
                // Guard: ensure buffer is large enough (shouldn't need resize normally)
                if (scOut.getNumSamples() < numSamples)
                    scOut.setSize(2, numSamples, false, false, true);

                for (int ch = 0; ch < juce::jmin(2, trackBuffer.getNumChannels()); ++ch)
                    scOut.copyFrom(ch, 0, trackBuffer, ch, 0, numSamples);
            }
        }

        // ========== SEND MIXING: fill destination track send accum buffers ==========
        if (track->getNumSends() > 0)
        {
            for (int si = 0; si < track->getNumSends(); ++si)
            {
                if (!track->getSendEnabled(si)) continue;
                if (track->getSendLevel(si) <= 0.0f) continue;

                auto destId = track->getSendDestination(si);
                auto sendDestIt = sendAccumBuffers.find(destId);
                if (sendDestIt != sendAccumBuffers.end())
                {
                    auto& destBuf = sendDestIt->second;
                    if (destBuf.getNumSamples() >= numSamples)
                    {
                        track->fillSendBuffer(si, track->getPreFaderBuffer(), trackBuffer,
                                              destBuf, numSamples);
                    }
                }
            }
        }

        // ========== MIDI OUTPUT: route MIDI to hardware output ==========
        if (!midiMessages.isEmpty() && track->getMIDIOutputDeviceName().isNotEmpty())
            track->sendMIDIToOutput(midiMessages);

        // Mix track output to device outputs (only if master send is enabled)
        if (track->getMasterSendEnabled())
        {
            int outStart = track->getOutputStartChannel();
            int outCount = track->getOutputChannelCount();
            for (int ch = 0; ch < std::min(trackBuffer.getNumChannels(), outCount); ++ch)
            {
                int destCh = outStart + ch;
                if (destCh < numOutputChannels)
                {
                    juce::FloatVectorOperations::add(
                        outputChannelData[destCh],
                        trackBuffer.getReadPointer(ch),
                        numSamples
                    );
                }
            }
        }
    }   
    
    // ========== Process Master FX Chain ==========
    // Process master FX if any plugins are loaded
    if (!masterFXNodes.empty())
    {
        // Non-owning view of the pre-allocated master buffer — avoids heap alloc on audio thread.
        // masterChans ensures we never ask for more channels than were pre-allocated.
        const int masterChans = juce::jmin (numOutputChannels, reusableMasterBuffer.getNumChannels());
        juce::AudioBuffer<float> masterBuffer (reusableMasterBuffer.getArrayOfWritePointers(), masterChans, numSamples);

        // Copy current mixed output to master buffer
        for (int ch = 0; ch < masterChans; ++ch)
            masterBuffer.copyFrom (ch, 0, outputChannelData[ch], numSamples);

        // Process through each FX plugin in sequence
        juce::MidiBuffer dummyMidi;
        for (auto& node : masterFXNodes)
        {
            if (node && node->getProcessor())
                node->getProcessor()->processBlock (masterBuffer, dummyMidi);
        }

        // Copy processed audio back to output
        for (int ch = 0; ch < masterChans; ++ch)
            juce::FloatVectorOperations::copy (outputChannelData[ch], masterBuffer.getReadPointer (ch), numSamples);
    }
    
    // ========== Process Monitoring FX Chain (real-time only, not in render) ==========
    if (!monitoringFXNodes.empty() && !isRendering.load())
    {
        const int monChans = juce::jmin(numOutputChannels, reusableMasterBuffer.getNumChannels());
        juce::AudioBuffer<float> monBuffer(reusableMasterBuffer.getArrayOfWritePointers(), monChans, numSamples);

        for (int ch = 0; ch < monChans; ++ch)
            monBuffer.copyFrom(ch, 0, outputChannelData[ch], numSamples);

        juce::MidiBuffer dummyMidi;
        for (auto& node : monitoringFXNodes)
        {
            if (node && node->getProcessor())
                node->getProcessor()->processBlock(monBuffer, dummyMidi);
        }

        for (int ch = 0; ch < monChans; ++ch)
            juce::FloatVectorOperations::copy(outputChannelData[ch], monBuffer.getReadPointer(ch), numSamples);
    }

    // ========== Apply Master Pan (with automation) ==========
    if (numOutputChannels >= 2)
    {
        float leftGain  = cachedMasterPanL.load(std::memory_order_relaxed);
        float rightGain = cachedMasterPanR.load(std::memory_order_relaxed);

        if (masterPanAutomation.shouldPlayback())
        {
            float autoPan = masterPanAutomation.eval(currentSamplePosition); // -1 to +1
            float panAngle = (autoPan + 1.0f) * 0.5f * juce::MathConstants<float>::halfPi;
            leftGain  = std::cos(panAngle);
            rightGain = std::sin(panAngle);
        }

        juce::FloatVectorOperations::multiply(outputChannelData[0], leftGain, numSamples);
        juce::FloatVectorOperations::multiply(outputChannelData[1], rightGain, numSamples);
    }
    
    // ========== Calculate Master Output Metering ==========
    // REAPER-style: use findMinAndMax (SIMD, no sqrt) instead of manual RMS loops.
    // Visuals only need ~30Hz; we accumulate across callbacks and write to
    // masterOutputLevel once per MASTER_METER_UPDATE_SAMPLES block.
    {
        float peakL = 0.0f, peakR = 0.0f;
        if (numOutputChannels >= 1)
        {
            auto r = juce::FloatVectorOperations::findMinAndMax (outputChannelData[0], numSamples);
            peakL = juce::jmax (-r.getStart(), r.getEnd());
        }
        if (numOutputChannels >= 2)
        {
            auto r = juce::FloatVectorOperations::findMinAndMax (outputChannelData[1], numSamples);
            peakR = juce::jmax (-r.getStart(), r.getEnd());
        }

        masterMeterPeakAccum   = juce::jmax (masterMeterPeakAccum, juce::jmax (peakL, peakR));
        masterMeterSampleCount += numSamples;
        if (masterMeterSampleCount >= MASTER_METER_UPDATE_SAMPLES)
        {
            masterOutputLevel.store (masterMeterPeakAccum, std::memory_order_relaxed);
            masterMeterPeakAccum   = 0.0f;
            masterMeterSampleCount = 0;
        }
    }
    
    // ========== Apply Master Volume (with automation) ==========
    {
        float effectiveMasterVol = masterVolume;
        if (masterVolumeAutomation.shouldPlayback())
        {
            float autoDb = masterVolumeAutomation.eval(currentSamplePosition);
            effectiveMasterVol = (autoDb <= -60.0f) ? 0.0f : std::pow(10.0f, autoDb / 20.0f);
        }
        for (int ch = 0; ch < numOutputChannels; ++ch)
        {
            juce::FloatVectorOperations::multiply(
                outputChannelData[ch],
                effectiveMasterVol,
                numSamples
            );
        }
    }

    // ========== Master Mono Downmix ==========
    if (masterMono.load(std::memory_order_relaxed) && numOutputChannels >= 2)
    {
        for (int i = 0; i < numSamples; ++i)
        {
            float mono = (outputChannelData[0][i] + outputChannelData[1][i]) * 0.5f;
            outputChannelData[0][i] = mono;
            outputChannelData[1][i] = mono;
        }
    }

    // ========== Phase Correlation Meter (Phase 20.10) ==========
    if (numOutputChannels >= 2)
    {
        for (int i = 0; i < numSamples; ++i)
        {
            double l = static_cast<double>(outputChannelData[0][i]);
            double r = static_cast<double>(outputChannelData[1][i]);
            phaseCorr_sumLR += l * r;
            phaseCorr_sumLL += l * l;
            phaseCorr_sumRR += r * r;
        }
        phaseCorrSampleCount += numSamples;

        if (phaseCorrSampleCount >= PHASE_CORR_UPDATE_SAMPLES)
        {
            double denom = std::sqrt(phaseCorr_sumLL * phaseCorr_sumRR);
            float corr = (denom > 1e-20) ? static_cast<float>(phaseCorr_sumLR / denom) : 0.0f;
            corr = juce::jlimit(-1.0f, 1.0f, corr);
            phaseCorrelationValue.store(corr, std::memory_order_relaxed);

            phaseCorr_sumLR = 0.0;
            phaseCorr_sumLL = 0.0;
            phaseCorr_sumRR = 0.0;
            phaseCorrSampleCount = 0;
        }
    }

    // ========== Spectrum Analyzer (Phase 20.11) ==========
    // Feed mono-summed output into FFT ring buffer
    {
        for (int i = 0; i < numSamples; ++i)
        {
            float monoSample = 0.0f;
            for (int ch = 0; ch < numOutputChannels; ++ch)
                monoSample += outputChannelData[ch][i];
            if (numOutputChannels > 1)
                monoSample /= static_cast<float>(numOutputChannels);

            spectrumInputBuffer[spectrumWritePos] = monoSample;
            spectrumWritePos++;

            if (spectrumWritePos >= FFT_SIZE)
            {
                spectrumWritePos = 0;

                // Copy input, apply window, perform FFT
                float fftData[FFT_SIZE * 2] = {};
                std::memcpy(fftData, spectrumInputBuffer, sizeof(float) * static_cast<size_t>(FFT_SIZE));
                spectrumWindow.multiplyWithWindowingTable(fftData, static_cast<size_t>(FFT_SIZE));
                spectrumFFT.performFrequencyOnlyForwardTransform(fftData);

                // Store magnitude spectrum (thread-safe)
                {
                    const juce::ScopedLock specLock(spectrumLock);
                    std::memcpy(spectrumOutputBuffer, fftData, sizeof(float) * static_cast<size_t>(FFT_SIZE));
                    spectrumReady = true;
                }
            }
        }
    }

    // ========== Timecode / Sync Output (Phase 3.9) ==========
    timecodeSyncManager.processBlock(numSamples, currentSampleRate, tempo,
                                      currentSamplePosition / currentSampleRate,
                                      isPlaying.load());

    // ========== Clip Launch / Trigger Engine (Phase 4.1) ==========
    {
        double currentBeat = (currentSamplePosition / currentSampleRate) * (tempo / 60.0);
        triggerEngine.processBlock(numSamples, currentSampleRate, tempo, currentBeat);
    }

    // ========== Advance transport position ==========
    // IMPORTANT: This is intentionally AFTER all processing (metronome, playback,
    // recording) so they use the position corresponding to the samples being
    // output in this callback.  Previously this was at the top of the callback,
    // causing a systematic one-buffer-length delay.
    if (isPlaying)
    {
        // Loop recording detection (Phase 3.2): if position jumped backward
        // (frontend wrapped the loop), finalize current takes and start new ones.
        // setTransportPosition() may have been called from the message thread
        // between callbacks, causing currentSamplePosition to jump backward.
        if (isRecordMode && isLooping && currentSamplePosition < prevSamplePosition - numSamples)
        {
            // Position jumped backward — loop wrap detected
            loopTakeCounter++;

            // Finalize current audio recordings and start new takes
            auto completedTakes = audioRecorder.stopAllRecordings(currentSampleRate);
            for (auto& take : completedTakes)
                lastCompletedClips.push_back(std::move(take));

            // Finalize MIDI recordings
            auto completedMIDITakes = midiRecorder.stopAllRecordings(projectAudioFolder, tempo);
            for (auto& take : completedMIDITakes)
                lastCompletedMIDIClips.push_back(std::move(take));

            // Start new recordings for next loop pass
            for (auto const& [tId, tTrack] : trackMap)
            {
                if (!tTrack || !tTrack->getRecordArmed()) continue;

                auto trackType = tTrack->getTrackType();
                if (trackType == TrackType::MIDI || trackType == TrackType::Instrument)
                {
                    midiRecorder.startRecording(tId, currentSampleRate);
                    midiRecorder.setRecordingStartTime(tId, currentSamplePosition / currentSampleRate);
                }
                else
                {
                    auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
                    auto filename = "Track_" + tId + "_Take_" + juce::String(timestamp) +
                                    "_L" + juce::String(loopTakeCounter) + ".wav";
                    auto outputFile = projectAudioFolder.getChildFile(filename);
                    audioRecorder.startRecording(tId, outputFile, currentSampleRate, tTrack->getInputChannelCount());
                    audioRecorder.setRecordingStartTime(tId, currentSamplePosition / currentSampleRate);
                }
            }
        }

        prevSamplePosition = currentSamplePosition;
        currentSamplePosition += numSamples;
    }
}

juce::String AudioEngine::addTrack(const juce::String& explicitId)
{
    logToDisk("AudioEngine: Adding Track...");

    if (! mainProcessorGraph)
        return "";
        
    // In a real app, use a proper lock
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());

    // Guard: if an explicit ID is provided and already exists, return it without
    // creating a duplicate.  Duplicate IDs in trackOrder cause the same
    // TrackProcessor to be iterated (and its FX plugins called) twice per audio
    // callback, producing severe distortion from the second processing pass.
    if (explicitId.isNotEmpty() && trackMap.count(explicitId) > 0)
    {
        logToDisk("WARNING: addTrack called with already-existing ID " + explicitId + " — ignoring duplicate.");
        return explicitId;
    }

    auto newTrack = std::make_unique<TrackProcessor>();
    auto* rawTrackPtr = newTrack.get(); // Keep raw pointer for metering (owned by graph)

    // Prepare the TrackProcessor with the current device parameters before handing
    // it to the graph. AudioProcessorGraph::addNode() does NOT call prepareToPlay()
    // on newly-added nodes when the graph is already running, so we must do it here.
    // Use jmax(currentBlockSize, 512) as the block-size hint — same rationale as
    // for FX plugins (ASIO can use blocks as small as 32; preparing at that size
    // forces plugins to resize convolution/FFT for tiny blocks → crackling).
    if (currentSampleRate > 0 && currentBlockSize > 0)
        rawTrackPtr->prepareToPlay (currentSampleRate, juce::jmax (currentBlockSize, 512));

    auto trackNode = mainProcessorGraph->addNode (std::move (newTrack));

    if (trackNode)
    {
        juce::String trackId = explicitId.isNotEmpty() ? explicitId : juce::Uuid().toString();

        trackMap[trackId] = rawTrackPtr;
        trackOrder.push_back(trackId);

        // Pre-allocate sidechain output buffer for this track (avoids heap alloc on audio thread)
        int scBlockSize = juce::jmax(currentBlockSize, 512);
        sidechainOutputBuffers[trackId].setSize(2, scBlockSize);

        // Pre-allocate send accumulation buffer for this track
        sendAccumBuffers[trackId].setSize(2, scBlockSize);

        logToDisk("Track added. ID: " + trackId + " Total: " + juce::String((int)trackOrder.size()));

        if (audioOutputNode)
        {
             mainProcessorGraph->addConnection ({ { trackNode->nodeID, 0 }, { audioOutputNode->nodeID, 0 } });
             mainProcessorGraph->addConnection ({ { trackNode->nodeID, 1 }, { audioOutputNode->nodeID, 1 } });
             logToDisk("Connected track to output.");
        }
        else
        {
             logToDisk("WARNING: audioOutputNode is null. Track not connected.");
        }
        return trackId;
    }
    else
    {
        logToDisk("ERROR: Failed to add track node to graph.");
        return "";
    }
}

bool AudioEngine::removeTrack(const juce::String& trackId)
{
    // --- Phase 1: Close all plugin editor windows for this track BEFORE
    //     acquiring the callback lock.  Window destruction must happen on
    //     the message thread and must complete before the TrackProcessor
    //     (and its owned plugins) are deleted by removeNode().
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end()) return false;

        auto* track = it->second;
        if (track)
        {
            std::vector<juce::AudioProcessor*> processors;
            for (int i = 0; i < track->getNumInputFX(); ++i)
                if (auto* p = track->getInputFXProcessor(i))
                    processors.push_back(p);
            for (int i = 0; i < track->getNumTrackFX(); ++i)
                if (auto* p = track->getTrackFXProcessor(i))
                    processors.push_back(p);
            if (auto* inst = track->getInstrument())
                processors.push_back(inst);

            if (!processors.empty())
                pluginWindowManager.closeEditorsForTrack(processors);
        }
    }

    // --- Phase 2: Acquire lock and remove the track from the graph.
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());

    auto it = trackMap.find(trackId);
    if (it == trackMap.end()) return false;

    auto* track = it->second;

    // Find node in graph to remove
    juce::AudioProcessorGraph::NodeID nodeID;
    bool found = false;
    for (auto& node : mainProcessorGraph->getNodes()) {
        if (node->getProcessor() == track) {
            nodeID = node->nodeID;
            found = true;
            break;
        }
    }

    if (found) {
        mainProcessorGraph->removeNode(nodeID);
    }

    trackMap.erase(it);
    trackOrder.erase(std::remove(trackOrder.begin(), trackOrder.end(), trackId), trackOrder.end());
    sidechainOutputBuffers.erase(trackId);
    sendAccumBuffers.erase(trackId);

    return true;
}

bool AudioEngine::reorderTrack(const juce::String& trackId, int newPosition)
{
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());
    
    auto it = std::find(trackOrder.begin(), trackOrder.end(), trackId);
    if (it == trackOrder.end()) return false;
    
    // Clamp new position
    if (newPosition < 0) newPosition = 0;
    if (newPosition >= (int)trackOrder.size()) newPosition = (int)trackOrder.size() - 1;
    
    if (std::distance(trackOrder.begin(), it) == newPosition) return true;
    
    trackOrder.erase(it);
    trackOrder.insert(trackOrder.begin() + newPosition, trackId);
    
    return true;
}

int AudioEngine::getTrackIndex(const juce::String& trackId) const
{
    auto it = std::find(trackOrder.begin(), trackOrder.end(), trackId);
    if (it != trackOrder.end())
        return (int)std::distance(trackOrder.begin(), it);
    return -1;
}

juce::var AudioEngine::getMeterLevels()
{
    // Return an object with track IDs as keys for robust matching
    juce::DynamicObject::Ptr meterObj (new juce::DynamicObject());

    for (const auto& trackId : trackOrder)
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
            meterObj->setProperty(juce::Identifier(trackId), it->second->getRMSLevel());
    }

    return juce::var (meterObj.get());
}

juce::var AudioEngine::getMeteringData()
{
    // Return an array with one entry per track (used by ScriptEngine for track count etc.)
    juce::Array<juce::var> result;
    for (const auto& trackId : trackOrder)
    {
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            juce::DynamicObject::Ptr obj (new juce::DynamicObject());
            obj->setProperty("id", trackId);
            obj->setProperty("rms", it->second->getRMSLevel());
            result.add(juce::var(obj.get()));
        }
    }
    return juce::var(result);
}

//==============================================================================
// MIDI Device Management (Phase 2)

juce::var AudioEngine::getMIDIInputDevices()
{
    if (!midiManager)
        return juce::var();
    
    auto devices = midiManager->getAvailableDevices();
    juce::var result;
    juce::Array<juce::var> deviceArray;
    
    for (const auto& device : devices)
    {
        deviceArray.add(device);
    }
    
    result = deviceArray;
    return result;
}

bool AudioEngine::openMIDIDevice(const juce::String& deviceName)
{
    if (!midiManager)
        return false;
    
    bool success = midiManager->openDevice(deviceName);
    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Opened MIDI device: " + deviceName);
    }
    return success;
}

void AudioEngine::closeMIDIDevice(const juce::String& deviceName)
{
    if (midiManager)
    {
        midiManager->closeDevice(deviceName);
        juce::Logger::writeToLog("AudioEngine: Closed MIDI device: " + deviceName);
    }
}

juce::var AudioEngine::getOpenMIDIDevices()
{
    if (!midiManager)
        return juce::var();
    
    auto devices = midiManager->getOpenDevices();
    juce::var result;
    juce::Array<juce::var> deviceArray;
    
    for (const auto& device : devices)
    {
        deviceArray.add(device);
    }
    
    result = deviceArray;
    return result;
}

//==============================================================================
// Track Type Management (Phase 2)

void AudioEngine::setTrackType(const juce::String& trackId, const juce::String& type)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    TrackType trackType = TrackType::Audio;
    
    if (type == "midi")
        trackType = TrackType::MIDI;
    else if (type == "instrument")
        trackType = TrackType::Instrument;
    
    trackMap[trackId]->setTrackType(trackType);
    juce::Logger::writeToLog("AudioEngine: Track " + trackId + " type set to: " + type);
}

void AudioEngine::setTrackMIDIInput(const juce::String& trackId, const juce::String& deviceName, int channel)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    trackMap[trackId]->setMIDIInputDevice(deviceName);
    trackMap[trackId]->setMIDIChannel(channel);
    
    juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                           " MIDI input: " + deviceName + 
                           " channel: " + juce::String(channel));
}

bool AudioEngine::loadInstrument(const juce::String& trackId, const juce::String& vstPath)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;
    
    // Load the VST instrument using PluginManager with actual device rate
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(vstPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load instrument: " + vstPath);
        return false;
    }
    
    // Cast to AudioPluginInstance
    auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(plugin.get());
    if (!pluginInstance)
    {
        juce::Logger::writeToLog("AudioEngine: Plugin is not an AudioPluginInstance: " + vstPath);
        return false;
    }
    
    // Create a unique_ptr with the correct type
    std::unique_ptr<juce::AudioPluginInstance> instrumentPtr(pluginInstance);
    plugin.release(); // Release ownership from the AudioProcessor unique_ptr

    // Provide tempo/position info to the instrument plugin
    instrumentPtr->setPlayHead (this);

    // Set the instrument on the track
    trackMap[trackId]->setInstrument(std::move(instrumentPtr));
    trackMap[trackId]->setTrackType(TrackType::Instrument);
    
    juce::Logger::writeToLog("AudioEngine: Loaded instrument on track " + trackId + ": " + vstPath);
    return true;
}

//==============================================================================
// MIDI Message Routing (Phase 2)

void AudioEngine::handleMIDIMessage(const juce::String& deviceName, int channel, const juce::MidiMessage& message)
{
    // MIDI Learn: if active and we receive a CC, create a mapping
    if (midiLearnActive.load() && message.isController())
    {
        const juce::ScopedLock sl(midiLearnLock);
        int ccNum = message.getControllerNumber();

        // Remove existing mapping for this CC
        midiLearnMappings.erase(
            std::remove_if(midiLearnMappings.begin(), midiLearnMappings.end(),
                            [ccNum](const MIDILearnMapping& m) { return m.ccNumber == ccNum; }),
            midiLearnMappings.end());

        MIDILearnMapping mapping;
        mapping.ccNumber = ccNum;
        mapping.trackId = midiLearnTrackId;
        mapping.pluginIndex = midiLearnPluginIndex;
        mapping.paramIndex = midiLearnParamIndex;
        midiLearnMappings.push_back(mapping);

        midiLearnActive.store(false);
        juce::Logger::writeToLog("MIDI Learn: Mapped CC " + juce::String(ccNum) +
                                 " -> track=" + mapping.trackId +
                                 " plugin=" + juce::String(mapping.pluginIndex) +
                                 " param=" + juce::String(mapping.paramIndex));
    }

    // Apply MIDI CC mappings: route incoming CC values to mapped plugin parameters
    if (message.isController())
    {
        const juce::ScopedLock sl(midiLearnLock);
        int ccNum = message.getControllerNumber();
        float normalizedValue = message.getControllerValue() / 127.0f;

        for (const auto& mapping : midiLearnMappings)
        {
            if (mapping.ccNumber == ccNum)
            {
                auto it = trackMap.find(mapping.trackId);
                if (it != trackMap.end() && it->second)
                {
                    auto* processor = it->second->getTrackFXProcessor(mapping.pluginIndex);
                    if (processor)
                    {
                        const auto& params = processor->getParameters();
                        if (params.size() > mapping.paramIndex)
                            params[mapping.paramIndex]->setValueNotifyingHost(normalizedValue);
                    }
                }
            }
        }
    }

    // Route MIDI to appropriate tracks
    for (auto const& [id, track] : trackMap)
    {
        if (!track) continue;
        
        // Check if track accepts MIDI
        if (track->getTrackType() != TrackType::MIDI && track->getTrackType() != TrackType::Instrument)
            continue;
        
        // Check if track is listening to this device
        if (track->getMIDIInputDevice() != deviceName)
            continue;
        
        // Check channel filtering (0 = all channels, 1-16 = specific channel)
        int trackChannel = track->getMIDIChannel();
        if (trackChannel != 0 && trackChannel != channel)
            continue;
        
        // Real-time monitoring: send MIDI to instrument for playback
        if (track->getInputMonitoring() && track->getTrackType() == TrackType::Instrument)
        {
            auto* instrument = track->getInstrument();
            if (instrument)
            {
                // Create MIDI buffer with this message
                juce::MidiBuffer midiBuffer;
                midiBuffer.addEvent(message, 0);
                
                // Note: In a production system, this would need to be processed
                // in the audio callback thread with proper synchronization
                juce::Logger::writeToLog("MIDI Monitor: " + message.getDescription() + 
                                       " routed to instrument on device: " + deviceName);
            }
        }
        
        // Record MIDI event if armed and in record mode
        if (isPlaying && isRecordMode && track->getRecordArmed())
        {
            double timestamp = currentSamplePosition / currentSampleRate;
            midiRecorder.recordEvent(id, timestamp, message);
        }
    }
}

float AudioEngine::getMasterLevel() const
{
    // Use the actual measured output level (computed in the audio callback after FX and pan)
    return masterOutputLevel.load();
}




juce::var AudioEngine::getAudioDeviceSetup()
{
    juce::Logger::writeToLog("AudioEngine: getAudioDeviceSetup() called");
    
    juce::DynamicObject* data = new juce::DynamicObject();

    // 1. Current Setup
    auto* currentSetup = new juce::DynamicObject();
    auto currentDeviceType = deviceManager.getCurrentAudioDeviceType();
    
    juce::Logger::writeToLog("AudioEngine: Current device type: " + currentDeviceType);
    
    // Handle case where no device is open yet
    auto* device = deviceManager.getCurrentAudioDevice();
    
    currentSetup->setProperty("audioDeviceType", currentDeviceType);
    if (device)
    {
        juce::Logger::writeToLog("AudioEngine: Current device: " + device->getName());
        currentSetup->setProperty("inputDevice", device->getName());
        currentSetup->setProperty("outputDevice", device->getName()); // Basic assumption for now
        currentSetup->setProperty("sampleRate", device->getCurrentSampleRate());
        currentSetup->setProperty("bufferSize", device->getCurrentBufferSizeSamples());
        
        // Get ALL channel names from the device (not just active)
        juce::StringArray inputNames = device->getInputChannelNames();
        juce::StringArray outputNames = device->getOutputChannelNames();
        
        // Total available channels (this is what matters for routing selection)
        int numTotalInputs = inputNames.size();
        int numTotalOutputs = outputNames.size();
        
        juce::Logger::writeToLog("AudioEngine: Device has " + juce::String(numTotalInputs) + " total input channels");
        
        currentSetup->setProperty("numInputChannels", numTotalInputs);
        currentSetup->setProperty("numOutputChannels", numTotalOutputs);
        
        // Build input channel names array (ALL channels)
        juce::Array<juce::var> inputChannelNamesArray;
        for (int i = 0; i < inputNames.size(); ++i)
        {
            inputChannelNamesArray.add(inputNames[i]);
            juce::Logger::writeToLog("AudioEngine: Input channel " + juce::String(i) + ": " + inputNames[i]);
        }
        currentSetup->setProperty("inputChannelNames", inputChannelNamesArray);
        
        // Build output channel names array (ALL channels)
        juce::Array<juce::var> outputChannelNamesArray;
        for (int i = 0; i < outputNames.size(); ++i)
        {
            outputChannelNamesArray.add(outputNames[i]);
        }
        currentSetup->setProperty("outputChannelNames", outputChannelNamesArray);
        
        // Also provide active channel info separately (can be used for metering, etc)
        currentSetup->setProperty("numActiveInputChannels", device->getActiveInputChannels().countNumberOfSetBits());
        currentSetup->setProperty("numActiveOutputChannels", device->getActiveOutputChannels().countNumberOfSetBits());
    }
    else
    {
        juce::Logger::writeToLog("AudioEngine: WARNING - No audio device currently active!");
        // Provide defaults
        currentSetup->setProperty("inputDevice", "");
        currentSetup->setProperty("outputDevice", "");
        currentSetup->setProperty("sampleRate", 44100.0);
        currentSetup->setProperty("bufferSize", 512);
        currentSetup->setProperty("numInputChannels", 2);
        currentSetup->setProperty("numOutputChannels", 2);
        currentSetup->setProperty("inputChannelNames", juce::Array<juce::var>());
        currentSetup->setProperty("outputChannelNames", juce::Array<juce::var>());
    }
    
    data->setProperty("current", currentSetup);

    // 2. Available Device Types
    juce::Array<juce::var> types;
    for (auto& type : deviceManager.getAvailableDeviceTypes())
    {
        auto typeName = type->getTypeName();
        types.add(typeName);
        juce::Logger::writeToLog("AudioEngine: Available type: " + typeName);
    }
    data->setProperty("availableTypes", types);
    
    // 3. Available Devices for Current Type
    juce::Array<juce::var> inputList;
    juce::Array<juce::var> outputList;
    
    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
    {
        juce::Logger::writeToLog("AudioEngine: Enumerating devices for type: " + type->getTypeName());
        
        for (auto& name : type->getDeviceNames(true)) // Inputs
        {
            inputList.add(name);
            juce::Logger::writeToLog("AudioEngine: Input device: " + name);
        }
        
        for (auto& name : type->getDeviceNames(false)) // Outputs
        {
            outputList.add(name);
            juce::Logger::writeToLog("AudioEngine: Output device: " + name);
        }
    }
    data->setProperty("inputs", inputList);
    data->setProperty("outputs", outputList);
    
    
    // 4. Sample Rates & 5. Buffer Sizes
    juce::Array<juce::var> rates;
    juce::Array<juce::var> buffers;
    
    if (device)
    {
        // Device is open - get its actual capabilities
        for (auto sr : device->getAvailableSampleRates())
            rates.add(sr);
        for (auto bs : device->getAvailableBufferSizes())
            buffers.add(bs);
        juce::Logger::writeToLog("AudioEngine: Got " + juce::String(rates.size()) + " sample rates from open device");
    }
    else
    {
        // No device open - provide common professional audio defaults
        // These work with most ASIO/WASAPI devices
        juce::Logger::writeToLog("AudioEngine: No device open, using default capabilities");
        
        rates.add(44100.0);
        rates.add(48000.0);
        rates.add(88200.0);
        rates.add(96000.0);
        rates.add(176400.0);
        rates.add(192000.0);
        
        buffers.add(32);
        buffers.add(64);
        buffers.add(128);
        buffers.add(256);
        buffers.add(512);
        buffers.add(1024);
        buffers.add(2048);
    }
    
    data->setProperty("sampleRates", rates);
    data->setProperty("bufferSizes", buffers);

    juce::Logger::writeToLog("AudioEngine: getAudioDeviceSetup() returning data");
    return data;
}

void AudioEngine::setAudioDeviceSetup(const juce::String& type, const juce::String& input, const juce::String& output, double sampleRate, int bufferSize)
{
    juce::Logger::writeToLog("AudioEngine: Setting Audio Device...");
    
    // 1. Change Type if needed
    if (deviceManager.getCurrentAudioDeviceType() != type)
    {
        deviceManager.setCurrentAudioDeviceType(type, true);
    }
    
    // 2. Setup Config
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager.getAudioDeviceSetup(setup);
    
    setup.inputDeviceName = input;
    setup.outputDeviceName = output;
    setup.sampleRate = sampleRate;
    setup.bufferSize = bufferSize;
    
    // Apply (treat errors softly by logging)
    auto error = deviceManager.setAudioDeviceSetup(setup, true);
    if (error.isNotEmpty())
        juce::Logger::writeToLog("AudioEngine: Error setting device: " + error);
    else
        saveDeviceSettings();
}

//==============================================================================
// Track Control (Phase 1)

void AudioEngine::setTrackRecordArm(const juce::String& trackId, bool armed)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setRecordArmed(armed);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " record arm: " + (armed ? "ON" : "OFF"));
        }
    }
}

void AudioEngine::setTrackInputMonitoring(const juce::String& trackId, bool enabled)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setInputMonitoring(enabled);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " monitoring: " + (enabled ? "ON" : "OFF"));
        }
    }
}

void AudioEngine::setTrackInputChannels(const juce::String& trackId, int startChannel, int numChannels)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setInputChannels(startChannel, numChannels);
        }
    }
}

//==============================================================================
// Volume/Pan/Mute/Solo (Phase 1)

void AudioEngine::setTrackVolume(const juce::String& trackId, float volumeDB)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setVolume(volumeDB);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " volume: " + juce::String(volumeDB) + " dB");
        }
    }
}

void AudioEngine::setTrackPan(const juce::String& trackId, float pan)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setPan(pan);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " pan: " + juce::String(pan));
        }
    }
}

void AudioEngine::setTrackMute(const juce::String& trackId, bool muted)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setMute(muted);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId + 
                                   " mute: " + (muted ? "ON" : "OFF"));
        }
    }
}

void AudioEngine::setTrackSolo(const juce::String& trackId, bool soloed)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->setSolo(soloed);
            juce::Logger::writeToLog("AudioEngine: Track " + trackId +
                                   " solo: " + (soloed ? "ON" : "OFF"));

            // Update cached solo state so audio thread doesn't need to scan
            bool anyNowSoloed = false;
            for (const auto& pair : trackMap)
                if (pair.second && pair.second->getSolo()) { anyNowSoloed = true; break; }
            cachedAnySoloed.store(anyNowSoloed);
        }
    }
}

//==============================================================================
// Punch In/Out (Phase 3.1)

void AudioEngine::setPunchRange(double startTime, double endTime, bool enabled)
{
    punchStartTime.store(startTime, std::memory_order_relaxed);
    punchEndTime.store(endTime, std::memory_order_relaxed);
    punchEnabled.store(enabled, std::memory_order_release);
    juce::Logger::writeToLog("AudioEngine: Punch range " + juce::String(enabled ? "enabled" : "disabled") +
                             " [" + juce::String(startTime, 3) + "s - " + juce::String(endTime, 3) + "s]");
}

//==============================================================================
// Record-Safe (Phase 3.3)

void AudioEngine::setTrackRecordSafe(const juce::String& trackId, bool safe)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setRecordSafe(safe);
        juce::Logger::writeToLog("AudioEngine: Track " + trackId + " record-safe: " + (safe ? "ON" : "OFF"));
    }
}

bool AudioEngine::getTrackRecordSafe(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getRecordSafe();
    return false;
}

//==============================================================================
// Transport Control (Phase 2)

void AudioEngine::setTransportPlaying(bool playing)
{
    logToDisk("setTransportPlaying(" + juce::String(playing ? "true" : "false") + ") called. Current: " + juce::String(isPlaying ? "true" : "false"));
    
    if (isPlaying == playing)
        return; // No change
        
    isPlaying = playing;
    
    if (playing)
    {
        // Update sample rate from device
        auto* device = deviceManager.getCurrentAudioDevice();
        if (device)
            currentSampleRate = device->getCurrentSampleRate();
            
        logToDisk("Transport PLAY. SampleRate: " + juce::String(currentSampleRate) + 
                 " Position: " + juce::String(currentSamplePosition / currentSampleRate) + "s");
    }
    else
    {
        logToDisk("Transport STOP at position: " + juce::String(currentSamplePosition / currentSampleRate) + "s");
        // Don't reset position here - let the stop() action control that
    }
}

void AudioEngine::setTransportRecording(bool recording)
{
    logToDisk("setTransportRecording(" + juce::String(recording ? "true" : "false") + ") called. Current: " + juce::String(isRecordMode ? "true" : "false"));
    
    if (isRecordMode == recording)
        return; // No change
        
    isRecordMode = recording;

    if (recording)
    {
        loopTakeCounter = 0;  // Reset loop take counter for new recording session
        prevSamplePosition = currentSamplePosition;  // Initialize prev position tracking

        // Use standard documents folder (resolves to OneDrive if configured)
        auto docsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
        projectAudioFolder = docsDir.getChildFile("Studio13").getChildFile("Audio");
        
        logToDisk("Target Audio Folder: " + projectAudioFolder.getFullPathName());
        
        if (!projectAudioFolder.exists())
        {
            bool created = projectAudioFolder.createDirectory();
            logToDisk("Folder created status: " + juce::String(created ? "SUCCESS" : "FAIL"));
        }
        
        // Start recording for each armed track
        logToDisk("Checking " + juce::String((int)trackMap.size()) + " tracks for arming...");

        bool anyAudioStarted = false;
        for (auto const& [trackId, track] : trackMap)
        {
            if (!track) continue;

            bool isArmed = track->getRecordArmed();

            if (isArmed)
            {
                auto trackType = track->getTrackType();

                if (trackType == TrackType::MIDI || trackType == TrackType::Instrument)
                {
                    // MIDI recording — in-memory accumulation
                    logToDisk("Track " + trackId + " IS ARMED (MIDI). Starting MIDI record...");
                    midiRecorder.startRecording(trackId, currentSampleRate);
                    anyAudioStarted = true;  // Reuse flag for pending start capture
                }
                else
                {
                    // Audio recording — disk I/O via ThreadedWriter
                    logToDisk("Track " + trackId + " IS ARMED. Starting record...");

                    auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
                    auto filename = "Track_" + trackId + "_Take_" + juce::String(timestamp) + ".wav";
                    auto outputFile = projectAudioFolder.getChildFile(filename);

                    logToDisk("Recording at sample rate: " + juce::String(currentSampleRate) + " Hz");

                    int numChannels = track->getInputChannelCount();
                    bool started = audioRecorder.startRecording(trackId, outputFile, currentSampleRate, numChannels);

                    if (started)
                        anyAudioStarted = true;

                    logToDisk("Start Recording Track " + trackId + " -> " + (started ? "SUCCESS" : "FAIL to " + outputFile.getFullPathName()));
                }
            }
        }

        if (anyAudioStarted)
        {
            // Defer start-time capture to the audio thread to avoid race
            // conditions — the message thread's view of currentSamplePosition
            // may be stale by the time the audio callback processes the first
            // buffer.  The audio thread sets the correct start time (with
            // input latency compensation) on the first write.
            pendingRecordStartCapture.store(true, std::memory_order_release);
        }
    }
    else
    {
        // Stop all recordings and collect clip info
        logToDisk("Record mode OFF - stopping recordings");
        lastCompletedClips = audioRecorder.stopAllRecordings(currentSampleRate);
        logToDisk("Recordings stopped. Completed " + juce::String(lastCompletedClips.size()) + " audio clips.");

        // Stop MIDI recordings
        lastCompletedMIDIClips = midiRecorder.stopAllRecordings(projectAudioFolder, tempo);
        logToDisk("MIDI recordings stopped. Completed " + juce::String(lastCompletedMIDIClips.size()) + " MIDI clips.");

        // Generate peak caches for recorded audio files in background (REAPER-style).
        // The onComplete callback fires on the message thread; MainComponent uses
        // it to emit a "peaksReady" JS event so the Timeline refreshes waveforms.
        for (const auto& clip : lastCompletedClips)
        {
            juce::String filePath = clip.file.getFullPathName();
            peakCache.generateAsync(clip.file, [this, filePath]()
            {
                if (onPeaksReady)
                    onPeaksReady(filePath);
            });
        }
    }
}


//==============================================================================
// FX Management (Phase 3)

void AudioEngine::scanForPlugins()
{
    juce::Logger::writeToLog("AudioEngine: Scanning for plugins...");
    pluginManager.scanForPlugins();
}

juce::var AudioEngine::getAvailablePlugins()
{
    auto plugins = pluginManager.getAvailablePlugins();

    juce::Array<juce::var> pluginList;
    for (const auto& plugin : plugins)
    {
        auto* pluginObj = new juce::DynamicObject();
        pluginObj->setProperty("name", plugin.name);
        pluginObj->setProperty("manufacturer", plugin.manufacturerName);
        pluginObj->setProperty("category", plugin.category);
        pluginObj->setProperty("fileOrIdentifier", plugin.fileOrIdentifier);
        pluginObj->setProperty("isInstrument", plugin.isInstrument);

        // VST3 Snapshot lookup: check bundle for Contents/Resources/Snapshots/*.png
        juce::File pluginPath(plugin.fileOrIdentifier);
        if (pluginPath.isDirectory() && pluginPath.getFileExtension() == ".vst3")
        {
            juce::File snapshotsDir = pluginPath.getChildFile("Contents")
                                                .getChildFile("Resources")
                                                .getChildFile("Snapshots");
            if (snapshotsDir.isDirectory())
            {
                juce::Array<juce::File> pngFiles;
                snapshotsDir.findChildFiles(pngFiles, juce::File::findFiles, false, "*.png");
                if (pngFiles.size() > 0)
                {
                    juce::MemoryBlock imageData;
                    if (pngFiles[0].loadFileAsData(imageData))
                    {
                        juce::String base64 = juce::Base64::toBase64(imageData.getData(),
                                                                      imageData.getSize());
                        pluginObj->setProperty("snapshot",
                            juce::String("data:image/png;base64,") + base64);
                    }
                }
            }
        }

        pluginList.add(juce::var(pluginObj));
    }

    juce::Logger::writeToLog("AudioEngine: Returning " + juce::String(pluginList.size()) + " plugins");
    return pluginList;
}

bool AudioEngine::addTrackInputFX(const juce::String& trackId, const juce::String& pluginPath, bool openEditor)
{
    // Load plugin BEFORE acquiring the lock (can take hundreds of ms).
    // Use actual device sample rate so the plugin initialises at the correct rate.
    // IMPORTANT: Use at least 512 for the max-block-size hint — ASIO buffers can be
    // as small as 32 samples, but prepareToPlay(sr, 32) forces plugins like Amplitube
    // to resize their internal DSP (FFT/convolution/cab sim) for tiny blocks, producing
    // crackling and distortion.  The plugin can still process 32-sample blocks fine when
    // prepared with a larger maximumExpectedSamplesPerBlock.
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = juce::jmax(currentBlockSize > 0 ? currentBlockSize : 512, 512);
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
        return false;

    // Provide tempo/position info to the plugin
    plugin->setPlayHead (this);

    bool success = false;
    int fxIndex = -1;
    {
        // Hold the callback lock while modifying the FX node vectors
        // (audio thread iterates these in processBlock)
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            success = it->second->addInputFX(std::move(plugin), sr, bs);
            if (success)
                fxIndex = it->second->getNumInputFX() - 1;
        }
    }

    if (success && fxIndex >= 0)
    {
        if (openEditor)
            openPluginEditor(trackId, fxIndex, true);
        juce::Logger::writeToLog("AudioEngine: Added input FX" + juce::String(openEditor ? " and opened editor" : ""));
        recalculatePDC();
    }
    return success;
}

bool AudioEngine::addTrackFX(const juce::String& trackId, const juce::String& pluginPath, bool openEditor)
{
    // Load plugin BEFORE acquiring the lock (can take hundreds of ms).
    // Use actual device sample rate so the plugin initialises at the correct rate.
    // IMPORTANT: Clamp max-block-size to at least 512 — same rationale as addTrackInputFX.
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = juce::jmax(currentBlockSize > 0 ? currentBlockSize : 512, 512);

    logToDisk("AudioEngine::addTrackFX DIAGNOSTIC");
    logToDisk("  currentSampleRate=" + juce::String(currentSampleRate) +
              " currentBlockSize=" + juce::String(currentBlockSize));
    logToDisk("  creating plugin at sr=" + juce::String(sr) + " bs=" + juce::String(bs));

    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
        return false;

    logToDisk("  plugin created: " + plugin->getName() +
              " inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
              " outCh=" + juce::String(plugin->getTotalNumOutputChannels()) +
              " pluginSr=" + juce::String(plugin->getSampleRate()) +
              " pluginBs=" + juce::String(plugin->getBlockSize()));

    // Provide tempo/position info to the plugin
    plugin->setPlayHead (this);

    bool success = false;
    int fxIndex = -1;
    {
        // Hold the callback lock while modifying the FX node vectors
        // (audio thread iterates these in processBlock)
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            success = it->second->addTrackFX(std::move(plugin), sr, bs);
            if (success)
                fxIndex = it->second->getNumTrackFX() - 1;
        }
    }

    if (success && fxIndex >= 0)
    {
        if (openEditor)
            openPluginEditor(trackId, fxIndex, false);
        juce::Logger::writeToLog("AudioEngine: Added track FX" + juce::String(openEditor ? " and opened editor" : ""));
        recalculatePDC();
    }
    return success;
}

//==============================================================================
// Built-in Effects (Phase 4.3)

static std::unique_ptr<juce::AudioProcessor> createBuiltInEffect(const juce::String& name)
{
    if (name == "S13 EQ")         return std::make_unique<S13EQ>();
    if (name == "S13 Compressor") return std::make_unique<S13Compressor>();
    if (name == "S13 Gate")       return std::make_unique<S13Gate>();
    if (name == "S13 Limiter")    return std::make_unique<S13Limiter>();
    if (name == "S13 Delay")      return std::make_unique<S13Delay>();
    if (name == "S13 Reverb")     return std::make_unique<S13Reverb>();
    if (name == "S13 Chorus")     return std::make_unique<S13Chorus>();
    if (name == "S13 Saturator")  return std::make_unique<S13Saturator>();
    if (name == "S13 Pitch Correct") return std::make_unique<S13PitchCorrector>();
    return nullptr;
}

bool AudioEngine::addTrackBuiltInFX(const juce::String& trackId, const juce::String& effectName, bool isInputFX)
{
    auto plugin = createBuiltInEffect(effectName);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Unknown built-in effect: " + effectName);
        return false;
    }

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = juce::jmax(currentBlockSize > 0 ? currentBlockSize : 512, 512);
    plugin->setPlayHead(this);
    plugin->prepareToPlay(sr, bs);

    bool success = false;
    int fxIndex = -1;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            if (isInputFX)
            {
                success = it->second->addInputFX(std::move(plugin), sr, bs);
                if (success)
                    fxIndex = it->second->getNumInputFX() - 1;
            }
            else
            {
                success = it->second->addTrackFX(std::move(plugin), sr, bs);
                if (success)
                    fxIndex = it->second->getNumTrackFX() - 1;
            }
        }
    }

    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Added built-in FX '" + effectName + "' to track " + trackId);
        recalculatePDC();
    }
    return success;
}

bool AudioEngine::addMasterBuiltInFX(const juce::String& effectName)
{
    auto plugin = createBuiltInEffect(effectName);
    if (!plugin)
        return false;

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = juce::jmax(currentBlockSize > 0 ? currentBlockSize : 512, 512);
    plugin->setPlayHead(this);
    plugin->prepareToPlay(sr, bs);

    if (!masterFXChain)
        return false;

    auto node = masterFXChain->addNode(std::move(plugin));
    if (!node)
        return false;

    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        masterFXNodes.push_back(node);
    }

    juce::Logger::writeToLog("AudioEngine: Added built-in master FX '" + effectName + "'");
    return true;
}

juce::var AudioEngine::getAvailableBuiltInFX()
{
    juce::Array<juce::var> list;
    const char* names[] = { "S13 EQ", "S13 Compressor", "S13 Gate", "S13 Limiter",
                            "S13 Delay", "S13 Reverb", "S13 Chorus", "S13 Saturator",
                            "S13 Pitch Correct" };
    for (auto& n : names)
    {
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty("name", juce::String(n));
        obj->setProperty("category", "Built-in");
        list.add(juce::var(obj.get()));
    }
    return juce::var(list);
}

//==============================================================================
// S13FX (JSFX) Management

bool AudioEngine::addTrackS13FX(const juce::String& trackId, const juce::String& scriptPath, bool isInputFX)
{
    // Create S13FXProcessor and load script BEFORE acquiring the lock
    auto s13fx = std::make_unique<S13FXProcessor>();
    if (!s13fx->loadScript(scriptPath))
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load S13FX script: " + scriptPath);
        return false;
    }

    // Provide tempo/position info
    s13fx->setPlayHead(this);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = juce::jmax(currentBlockSize > 0 ? currentBlockSize : 512, 512);

    bool success = false;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto it = trackMap.find(trackId);
        if (it != trackMap.end() && it->second)
        {
            if (isInputFX)
                success = it->second->addInputFX(std::move(s13fx), sr, bs);
            else
                success = it->second->addTrackFX(std::move(s13fx), sr, bs);
        }
    }

    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Added S13FX to " + juce::String(isInputFX ? "input" : "track") + " chain: " + scriptPath);
        recalculatePDC();
    }

    return success;
}

bool AudioEngine::addMasterS13FX(const juce::String& scriptPath)
{
    auto s13fx = std::make_unique<S13FXProcessor>();
    if (!s13fx->loadScript(scriptPath))
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load S13FX for master: " + scriptPath);
        return false;
    }

    s13fx->setPlayHead(this);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = juce::jmax(currentBlockSize > 0 ? currentBlockSize : 512, 512);

    s13fx->prepareToPlay(sr, bs);

    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        auto node = masterFXChain->addNode(std::move(s13fx));
        if (node)
        {
            masterFXNodes.push_back(node);
            juce::Logger::writeToLog("AudioEngine: Added S13FX to master chain: " + scriptPath);
            return true;
        }
    }

    return false;
}

juce::var AudioEngine::getS13FXSliders(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::Array<juce::var> sliderList;

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return sliderList;

    auto* track = it->second;
    juce::AudioProcessor* proc = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return sliderList;

    auto* s13fx = dynamic_cast<S13FXProcessor*>(proc);
    if (!s13fx)
        return sliderList;

    auto sliders = s13fx->getSliders();
    for (const auto& s : sliders)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("index", static_cast<int>(s.index));
        obj->setProperty("name", s.name);
        obj->setProperty("min", s.min);
        obj->setProperty("max", s.max);
        obj->setProperty("def", s.def);
        obj->setProperty("inc", s.inc);
        obj->setProperty("value", s.value);
        obj->setProperty("isEnum", s.isEnum);

        if (s.isEnum)
        {
            juce::Array<juce::var> names;
            for (const auto& n : s.enumNames)
                names.add(n);
            obj->setProperty("enumNames", names);
        }

        sliderList.add(juce::var(obj));
    }

    return sliderList;
}

bool AudioEngine::setS13FXSlider(const juce::String& trackId, int fxIndex, bool isInputFX, int sliderIndex, double value)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    auto* track = it->second;
    juce::AudioProcessor* proc = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return false;

    auto* s13fx = dynamic_cast<S13FXProcessor*>(proc);
    if (!s13fx)
        return false;

    return s13fx->setSliderValue(static_cast<uint32_t>(sliderIndex), value);
}

bool AudioEngine::reloadS13FX(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    auto* track = it->second;
    juce::AudioProcessor* proc = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return false;

    auto* s13fx = dynamic_cast<S13FXProcessor*>(proc);
    if (!s13fx)
        return false;

    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    return s13fx->reloadScript();
}

juce::var AudioEngine::getAvailableS13FX()
{
    pluginManager.scanForS13FX();

    juce::Array<juce::var> list;
    for (const auto& info : pluginManager.getAvailableS13FX())
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("name", info.name);
        obj->setProperty("filePath", info.filePath);
        obj->setProperty("author", info.author);
        obj->setProperty("isStock", info.isStock);
        obj->setProperty("type", "s13fx");

        juce::Array<juce::var> tags;
        for (const auto& tag : info.tags)
            tags.add(tag);
        obj->setProperty("tags", tags);

        list.add(juce::var(obj));
    }

    return list;
}

//==============================================================================
// Lua Scripting (S13Script)

juce::var AudioEngine::runScript(const juce::String& scriptPath)
{
    auto* result = new juce::DynamicObject();
    bool success = scriptEngine.loadAndRun(scriptPath);
    result->setProperty("success", success);
    result->setProperty("output", scriptEngine.getLastOutput());
    if (!success)
        result->setProperty("error", scriptEngine.getLastError());

    // Start defer timer if script registered a deferred callback
    if (scriptEngine.hasDeferredCallback() && !isTimerRunning())
        startTimerHz(30);

    return juce::var(result);
}

juce::var AudioEngine::runScriptCode(const juce::String& luaCode)
{
    auto* result = new juce::DynamicObject();
    bool success = scriptEngine.executeString(luaCode);
    result->setProperty("success", success);
    result->setProperty("output", scriptEngine.getLastOutput());
    if (!success)
        result->setProperty("error", scriptEngine.getLastError());

    // Start defer timer if script registered a deferred callback
    if (scriptEngine.hasDeferredCallback() && !isTimerRunning())
        startTimerHz(30);

    return juce::var(result);
}

void AudioEngine::timerCallback()
{
    if (!scriptEngine.runDeferredCallback())
    {
        // No more deferred callbacks — stop the timer
        stopTimer();
    }
}

juce::String AudioEngine::getScriptDirectory()
{
    return ScriptEngine::getUserScriptsDirectory().getFullPathName();
}

juce::var AudioEngine::listScripts()
{
    auto scripts = scriptEngine.listAvailableScripts();
    juce::Array<juce::var> list;

    for (const auto& info : scripts)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("name", info.name);
        obj->setProperty("filePath", info.filePath);
        obj->setProperty("description", info.description);
        obj->setProperty("isStock", info.isStock);
        list.add(juce::var(obj));
    }

    return list;
}

//==============================================================================
// Plugin Editor Windows (Phase 3)

void AudioEngine::openPluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    auto* track = trackMap[trackId];
    if (!track)
        return;
    
    juce::AudioProcessor* processor = nullptr;
    juce::String windowTitle;
    
    // Calculate display index (1-based)
    int displayIndex = getTrackIndex(trackId) + 1;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
        {
            processor = track->getInputFXProcessor(fxIndex);
            windowTitle = "Track " + juce::String(displayIndex) + " - " + processor->getName();
        }
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
        {
            processor = track->getTrackFXProcessor(fxIndex);
            windowTitle = "Track " + juce::String(displayIndex) + " - " + processor->getName();
        }
    }

    if (processor)
    {
        // Defer window creation to next message-loop cycle — creating a native
        // DocumentWindow from inside a WebView2 NativeFunction callback can cause
        // re-entrancy crashes with the Windows message pump.
        auto* proc = processor;
        auto title = windowTitle;
        juce::MessageManager::callAsync([this, proc, title]()
        {
            pluginWindowManager.openEditor(proc, title);
        });
    }
    else
    {
        juce::Logger::writeToLog("AudioEngine::openPluginEditor - No processor found for track " + trackId
                                 + " fxIndex=" + juce::String(fxIndex) + " isInputFX=" + juce::String(isInputFX ? "true" : "false"));
    }
}

void AudioEngine::openInstrumentEditor(const juce::String& trackId)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;

    auto* track = trackMap[trackId];
    if (!track)
        return;

    auto* instrument = track->getInstrument();
    if (instrument)
    {
        int displayIndex = getTrackIndex(trackId) + 1;
        juce::String windowTitle = "Track " + juce::String(displayIndex) + " - " + instrument->getName();
        auto* proc = instrument;
        auto title = windowTitle;
        juce::MessageManager::callAsync([this, proc, title]()
        {
            pluginWindowManager.openEditor(proc, title);
        });
    }
}

void AudioEngine::closePluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    if (trackMap.find(trackId) == trackMap.end())
        return;
    
    auto* track = trackMap[trackId];
    if (!track)
        return;
    
    juce::AudioProcessor* processor = nullptr;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }
    
    if (processor)
    {
        pluginWindowManager.closeEditor(processor);
        juce::Logger::writeToLog("AudioEngine: Closed plugin editor");
    }
}

void AudioEngine::closeAllPluginWindows()
{
    pluginWindowManager.closeAllEditorsSync();
}

//==============================================================================
// Built-in FX Preset System

static juce::File getPresetsDir(const juce::String& pluginName)
{
    auto appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
    return appDir.getChildFile("presets").getChildFile(pluginName.replace(" ", "_"));
}

juce::var AudioEngine::getBuiltInFXPresets(const juce::String& pluginName)
{
    juce::Array<juce::var> presetList;

    auto dir = getPresetsDir(pluginName);
    if (!dir.exists())
        return presetList;

    auto files = dir.findChildFiles(juce::File::findFiles, false, "*.s13preset");
    files.sort();

    for (auto& file : files)
    {
        juce::DynamicObject::Ptr preset = new juce::DynamicObject();
        preset->setProperty("name", file.getFileNameWithoutExtension());
        preset->setProperty("path", file.getFullPathName());
        presetList.add(juce::var(preset.get()));
    }

    return presetList;
}

bool AudioEngine::saveBuiltInFXPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                       const juce::String& presetName, bool isFactory)
{
    juce::ignoreUnused(isFactory);

    // Find the processor
    if (trackMap.find(trackId) == trackMap.end())
        return false;

    auto* track = trackMap[trackId];
    if (!track)
        return false;

    juce::AudioProcessor* processor = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!processor)
        return false;

    // Get state information
    juce::MemoryBlock stateData;
    processor->getStateInformation(stateData);

    // Save to file
    auto dir = getPresetsDir(processor->getName());
    dir.createDirectory();

    auto file = dir.getChildFile(presetName + ".s13preset");
    return file.replaceWithData(stateData.getData(), stateData.getSize());
}

bool AudioEngine::loadBuiltInFXPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                       const juce::String& presetName)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;

    auto* track = trackMap[trackId];
    if (!track)
        return false;

    juce::AudioProcessor* processor = isInputFX
        ? track->getInputFXProcessor(fxIndex)
        : track->getTrackFXProcessor(fxIndex);

    if (!processor)
        return false;

    auto dir = getPresetsDir(processor->getName());
    auto file = dir.getChildFile(presetName + ".s13preset");

    if (!file.existsAsFile())
        return false;

    juce::MemoryBlock stateData;
    if (!file.loadFileAsData(stateData))
        return false;

    processor->setStateInformation(stateData.getData(), static_cast<int>(stateData.getSize()));
    return true;
}

bool AudioEngine::deleteBuiltInFXPreset(const juce::String& pluginName, const juce::String& presetName)
{
    auto dir = getPresetsDir(pluginName);
    auto file = dir.getChildFile(presetName + ".s13preset");

    if (file.existsAsFile())
        return file.deleteFile();

    return false;
}

//==============================================================================
// Get loaded plugins info

juce::var AudioEngine::getTrackInputFX(const juce::String& trackId)
{
    juce::Array<juce::var> fxList;

    if (trackMap.find(trackId) == trackMap.end())
        return fxList;

    auto* track = trackMap[trackId];
    if (!track)
        return fxList;

    int numFX = track->getNumInputFX();
    for (int i = 0; i < numFX; ++i)
    {
        auto* processor = track->getInputFXProcessor(i);
        if (processor)
        {
            juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
            fxInfo->setProperty("index", i);
            fxInfo->setProperty("name", processor->getName());

            // Check type: built-in > S13FX > VST3
            if (dynamic_cast<S13BuiltInEffect*>(processor)
                || dynamic_cast<S13Delay*>(processor)
                || dynamic_cast<S13Reverb*>(processor)
                || dynamic_cast<S13Chorus*>(processor)
                || dynamic_cast<S13Saturator*>(processor)
                || dynamic_cast<S13PitchCorrector*>(processor))
            {
                fxInfo->setProperty("type", "builtin");
            }
            else if (auto* s13fx = dynamic_cast<S13FXProcessor*>(processor))
            {
                fxInfo->setProperty("type", "s13fx");
                fxInfo->setProperty("pluginPath", s13fx->getScriptPath());
            }
            else if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(processor))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("type", desc.pluginFormatName == "CLAP" ? "clap" : "vst3");
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }

    return fxList;
}

juce::var AudioEngine::getTrackFX(const juce::String& trackId)
{
    juce::Array<juce::var> fxList;

    if (trackMap.find(trackId) == trackMap.end())
        return fxList;

    auto* track = trackMap[trackId];
    if (!track)
        return fxList;

    int numFX = track->getNumTrackFX();
    for (int i = 0; i < numFX; ++i)
    {
        auto* processor = track->getTrackFXProcessor(i);
        if (processor)
        {
            juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
            fxInfo->setProperty("index", i);
            fxInfo->setProperty("name", processor->getName());

            // Check type: built-in > S13FX > VST3
            if (dynamic_cast<S13BuiltInEffect*>(processor)
                || dynamic_cast<S13Delay*>(processor)
                || dynamic_cast<S13Reverb*>(processor)
                || dynamic_cast<S13Chorus*>(processor)
                || dynamic_cast<S13Saturator*>(processor)
                || dynamic_cast<S13PitchCorrector*>(processor))
            {
                fxInfo->setProperty("type", "builtin");
            }
            else if (auto* s13fx = dynamic_cast<S13FXProcessor*>(processor))
            {
                fxInfo->setProperty("type", "s13fx");
                fxInfo->setProperty("pluginPath", s13fx->getScriptPath());
            }
            else if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(processor))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("type", desc.pluginFormatName == "CLAP" ? "clap" : "vst3");
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }

    return fxList;
}

juce::var AudioEngine::getPluginParameters(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::Array<juce::var> paramList;

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return paramList;

    auto* track = it->second;
    juce::AudioProcessor* processor = nullptr;

    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }

    if (!processor)
        return paramList;

    // Use the modern JUCE parameter API — skip internal MIDI CC parameters
    // (plugins like Amplitube expose CC 0-127 x 16 channels = 2048 internal params)
    const auto& params = processor->getParameters();
    for (int i = 0; i < params.size(); ++i)
    {
        auto* param = params[i];
        auto name = param->getName(128);

        // Filter out MIDI CC / internal mapping parameters (Reaper hides these too)
        auto nameLower = name.toLowerCase();
        if (nameLower.startsWith("midi cc") || nameLower.startsWith("cc #")
            || nameLower.contains("midi cc ") || nameLower.contains("midi ch"))
            continue;

        juce::DynamicObject::Ptr paramInfo = new juce::DynamicObject();
        paramInfo->setProperty("index", i);
        paramInfo->setProperty("name", name);
        paramInfo->setProperty("value", param->getValue());
        paramInfo->setProperty("text", param->getCurrentValueAsText());
        paramList.add(juce::var(paramInfo.get()));
    }

    return paramList;
}

void AudioEngine::removeTrackInputFX(const juce::String& trackId, int fxIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->removeInputFX(fxIndex);
        juce::Logger::writeToLog("AudioEngine: Removed input FX " + juce::String(fxIndex) + " from track " + trackId);
    }
    recalculatePDC();
}

void AudioEngine::removeTrackFX(const juce::String& trackId, int fxIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->removeTrackFX(fxIndex);
        juce::Logger::writeToLog("AudioEngine: Removed track FX " + juce::String(fxIndex) + " from track " + trackId);
    }
    recalculatePDC();
}

void AudioEngine::bypassTrackInputFX(const juce::String& trackId, int fxIndex, bool bypassed)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->bypassInputFX(fxIndex, bypassed);
        juce::Logger::writeToLog("AudioEngine: " + juce::String(bypassed ? "Bypassed" : "Unbypassed") +
                               " input FX " + juce::String(fxIndex) + " on track " + trackId);
    }
    recalculatePDC();
}

void AudioEngine::bypassTrackFX(const juce::String& trackId, int fxIndex, bool bypassed)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->bypassTrackFX(fxIndex, bypassed);
        juce::Logger::writeToLog("AudioEngine: " + juce::String(bypassed ? "Bypassed" : "Unbypassed") +
                               " track FX " + juce::String(fxIndex) + " on track " + trackId);
    }
    recalculatePDC();
}

bool AudioEngine::reorderTrackInputFX(const juce::String& trackId, int fromIndex, int toIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    bool success = it->second->reorderInputFX(fromIndex, toIndex);
    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Reordered input FX on track " + trackId +
                               " from " + juce::String(fromIndex) + " to " + juce::String(toIndex));
    }
    return success;
}

bool AudioEngine::reorderTrackFX(const juce::String& trackId, int fromIndex, int toIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    bool success = it->second->reorderTrackFX(fromIndex, toIndex);
    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Reordered track FX on track " + trackId +
                               " from " + juce::String(fromIndex) + " to " + juce::String(toIndex));
    }
    return success;
}

//==============================================================================
// Master FX Management

bool AudioEngine::addMasterFX(const juce::String& pluginPath)
{
    juce::Logger::writeToLog("AudioEngine: addMasterFX called with: " + pluginPath);
    
    // Load the plugin with actual device sample rate & block size
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load plugin for master FX");
        return false;
    }

    // Provide tempo/position info to the plugin
    plugin->setPlayHead (this);

    // Plugin was already created at the correct rate by loadPluginFromFile,
    // but re-prepare in case the device has changed since then.
    // Clamp max-block-size to at least 512 (same rationale as track FX).
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device)
    {
        plugin->prepareToPlay(device->getCurrentSampleRate(),
                              juce::jmax(device->getCurrentBufferSizeSamples(), 512));
    }

    // Add to master FX chain graph
    auto node = masterFXChain->addNode(std::move(plugin));
    if (node != nullptr)
    {
        // Acquire callback lock to safely modify masterFXNodes
        // (audio callback reads this vector under the same lock)
        const juce::ScopedLock lockSl(mainProcessorGraph->getCallbackLock());
        masterFXNodes.push_back(node);
        juce::Logger::writeToLog("AudioEngine: Added plugin to master FX chain (total: " + juce::String((int)masterFXNodes.size()) + ")");
        return true;
    }
    
    juce::Logger::writeToLog("AudioEngine: Failed to add node to master FX chain");
    return false;
}

juce::var AudioEngine::getMasterFX()
{
    juce::Array<juce::var> fxList;
    for (int i = 0; i < static_cast<int>(masterFXNodes.size()); ++i)
    {
        auto& node = masterFXNodes[i];
        if (node && node->getProcessor())
        {
            juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
            auto* proc = node->getProcessor();
            fxInfo->setProperty("index", i);
            fxInfo->setProperty("name", proc->getName());
            // Detect type
            if (dynamic_cast<S13BuiltInEffect*>(proc)
                || dynamic_cast<S13Delay*>(proc)
                || dynamic_cast<S13Reverb*>(proc)
                || dynamic_cast<S13Chorus*>(proc)
                || dynamic_cast<S13Saturator*>(proc)
                || dynamic_cast<S13PitchCorrector*>(proc))
            {
                fxInfo->setProperty("type", "builtin");
            }
            else if (auto* s13fx = dynamic_cast<S13FXProcessor*>(proc))
            {
                fxInfo->setProperty("type", "s13fx");
                fxInfo->setProperty("pluginPath", s13fx->getScriptPath());
            }
            else if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(proc))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("type", desc.pluginFormatName == "CLAP" ? "clap" : "vst3");
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }
    return fxList;
}

void AudioEngine::removeMasterFX(int fxIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    if (fxIndex >= 0 && fxIndex < static_cast<int>(masterFXNodes.size()))
    {
        auto node = masterFXNodes[fxIndex];
        masterFXNodes.erase(masterFXNodes.begin() + fxIndex);
        if (node)
            masterFXChain->removeNode(node.get());
        juce::Logger::writeToLog("AudioEngine: Removed master FX " + juce::String(fxIndex));
    }
}

void AudioEngine::openMasterFXEditor(int fxIndex)
{
    if (fxIndex >= 0 && fxIndex < static_cast<int>(masterFXNodes.size()))
    {
        auto& node = masterFXNodes[fxIndex];
        if (node && node->getProcessor())
        {
            auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(node->getProcessor());
            if (pluginInstance)
            {
                auto* proc = pluginInstance;
                auto title = pluginInstance->getName();
                juce::MessageManager::callAsync([this, proc, title]()
                {
                    pluginWindowManager.openEditor(proc, title);
                });
            }
        }
    }
}

void AudioEngine::setMasterVolume(float volume)
{
    masterVolume = juce::jlimit(0.0f, 1.0f, volume);
    juce::Logger::writeToLog("Master volume set to: " + juce::String(volume));
}

void AudioEngine::setMasterPan(float pan)
{
    masterPan = juce::jlimit(-1.0f, 1.0f, pan);

    // Pre-compute pan gains so the audio callback uses cheap loads instead of trig
    const float angle = (masterPan + 1.0f) * juce::MathConstants<float>::pi / 4.0f;
    cachedMasterPanL.store(std::cos(angle), std::memory_order_relaxed);
    cachedMasterPanR.store(std::sin(angle), std::memory_order_relaxed);
}

bool AudioEngine::addMonitoringFX(const juce::String& pluginPath)
{
    juce::Logger::writeToLog("AudioEngine: addMonitoringFX called with: " + pluginPath);

    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load plugin for monitoring FX");
        return false;
    }

    plugin->setPlayHead(this);

    auto* device = deviceManager.getCurrentAudioDevice();
    if (device)
    {
        plugin->prepareToPlay(device->getCurrentSampleRate(),
                              juce::jmax(device->getCurrentBufferSizeSamples(), 512));
    }

    auto node = monitoringFXChain->addNode(std::move(plugin));
    if (node != nullptr)
    {
        const juce::ScopedLock lockSl(mainProcessorGraph->getCallbackLock());
        monitoringFXNodes.push_back(node);
        juce::Logger::writeToLog("AudioEngine: Added plugin to monitoring FX chain (total: " +
                                 juce::String((int)monitoringFXNodes.size()) + ")");
        return true;
    }

    juce::Logger::writeToLog("AudioEngine: Failed to add node to monitoring FX chain");
    return false;
}

juce::var AudioEngine::getMonitoringFX()
{
    juce::Array<juce::var> fxList;
    for (int i = 0; i < static_cast<int>(monitoringFXNodes.size()); ++i)
    {
        auto& node = monitoringFXNodes[i];
        if (node && node->getProcessor())
        {
            juce::DynamicObject::Ptr fxInfo = new juce::DynamicObject();
            fxInfo->setProperty("index", i);
            fxInfo->setProperty("name", node->getProcessor()->getName());
            fxInfo->setProperty("bypassed", node->isBypassed());
            if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(node->getProcessor()))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }
    return fxList;
}

void AudioEngine::removeMonitoringFX(int fxIndex)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    if (fxIndex >= 0 && fxIndex < static_cast<int>(monitoringFXNodes.size()))
    {
        auto node = monitoringFXNodes[fxIndex];
        monitoringFXNodes.erase(monitoringFXNodes.begin() + fxIndex);
        if (node)
            monitoringFXChain->removeNode(node.get());
        juce::Logger::writeToLog("AudioEngine: Removed monitoring FX " + juce::String(fxIndex));
    }
}

void AudioEngine::openMonitoringFXEditor(int fxIndex)
{
    if (fxIndex >= 0 && fxIndex < static_cast<int>(monitoringFXNodes.size()))
    {
        auto& node = monitoringFXNodes[fxIndex];
        if (node && node->getProcessor())
        {
            auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(node->getProcessor());
            if (pluginInstance)
                pluginWindowManager.openEditor(pluginInstance, pluginInstance->getName());
        }
    }
}

void AudioEngine::bypassMonitoringFX(int fxIndex, bool bypassed)
{
    const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
    if (fxIndex >= 0 && fxIndex < static_cast<int>(monitoringFXNodes.size()))
    {
        auto& node = monitoringFXNodes[fxIndex];
        if (node)
        {
            node->setBypassed(bypassed);
            juce::Logger::writeToLog("AudioEngine: Monitoring FX " + juce::String(fxIndex) +
                                     (bypassed ? " bypassed" : " enabled"));
        }
    }
}

std::vector<AudioRecorder::CompletedRecording> AudioEngine::getLastCompletedClips()
{
    auto clips = lastCompletedClips;
    lastCompletedClips.clear();  // Clear after reading
    return clips;
}

std::vector<MIDIRecorder::CompletedMIDIRecording> AudioEngine::getLastCompletedMIDIClips()
{
    auto clips = std::move(lastCompletedMIDIClips);
    lastCompletedMIDIClips.clear();
    return clips;
}

//==============================================================================
// Playback Clip Management

// Playback Clip Management

void AudioEngine::addPlaybackClip(const juce::String& trackId, const juce::String& filePath, double startTime, double duration,
                                   double offset, double volumeDB, double fadeIn, double fadeOut, const juce::String& clipId)
{
    juce::File audioFile(filePath);
    playbackEngine.addClip(audioFile, startTime, duration, trackId, offset, volumeDB, fadeIn, fadeOut, clipId);
    juce::Logger::writeToLog("AudioEngine: Added playback clip to track " + trackId +
                           " (offset=" + juce::String(offset) + "s, vol=" + juce::String(volumeDB) + "dB)");
}

void AudioEngine::addPlaybackClipsBatch(const juce::String& clipsJSON)
{
    auto parsed = juce::JSON::parse (clipsJSON);
    if (auto* arr = parsed.getArray())
    {
        for (const auto& item : *arr)
        {
            juce::String trackId = item["trackId"].toString();
            juce::String fp      = item["filePath"].toString();
            juce::String cId     = item.hasProperty ("clipId") ? item["clipId"].toString() : juce::String();
            double startTime     = static_cast<double> (item["startTime"]);
            double dur           = static_cast<double> (item["duration"]);
            double off           = item.hasProperty ("offset")   ? static_cast<double> (item["offset"])   : 0.0;
            double vol           = item.hasProperty ("volumeDB") ? static_cast<double> (item["volumeDB"]) : 0.0;
            double fi            = item.hasProperty ("fadeIn")   ? static_cast<double> (item["fadeIn"])    : 0.0;
            double fo            = item.hasProperty ("fadeOut")  ? static_cast<double> (item["fadeOut"])   : 0.0;

            juce::File audioFile (fp);
            playbackEngine.addClip (audioFile, startTime, dur, trackId, off, vol, fi, fo, cId);
        }
        juce::Logger::writeToLog ("AudioEngine: Batch-added " + juce::String (arr->size()) + " playback clips");
    }
}

void AudioEngine::removePlaybackClip(const juce::String& trackId, const juce::String& filePath)
{
    playbackEngine.removeClip(trackId, filePath);
    juce::Logger::writeToLog("AudioEngine: Removed playback clip from track " + trackId);
}

void AudioEngine::clearPlaybackClips()
{
    playbackEngine.clearAllClips();
    juce::Logger::writeToLog("AudioEngine: Cleared all playback clips");
}

void AudioEngine::clearTrackPlaybackClips(const juce::String& trackId)
{
    playbackEngine.clearTrackClips(trackId);
    juce::Logger::writeToLog("AudioEngine: Cleared clips for track " + trackId);
}



juce::var AudioEngine::getWaveformPeaks(const juce::String& filePath, int samplesPerPixel, int startSample, int numPixels)
{
    // REAPER-inspired: read from pre-computed peak cache (.s13peaks) instead of audio file.
    // If cache doesn't exist, kick off async generation and return empty.
    // Frontend will re-request on next render after cache is ready.
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("getWaveformPeaks: File not found: " + filePath);
        return juce::Array<juce::var>();
    }

    // Generate peak cache if it doesn't exist — async to avoid blocking the UI thread.
    // Returns empty array now; emits peaksReady event when generation completes so
    // the frontend Timeline can re-fetch waveform data.
    if (!peakCache.hasCachedPeaks(audioFile))
    {
        juce::Logger::writeToLog("getWaveformPeaks: Generating peak cache (async) for: " + audioFile.getFileName());
        peakCache.generateAsync(audioFile, [this, filePath]() {
            juce::Logger::writeToLog("getWaveformPeaks: Peak cache ready for: " + filePath);
            if (onPeaksReady)
                onPeaksReady(filePath);
        });
        return juce::Array<juce::var>();
    }

    // Read from peak cache (instant — memory-cached mipmap lookup)
    return peakCache.getPeaks(audioFile, samplesPerPixel, startSample, numPixels);
}

juce::var AudioEngine::getRecordingPeaks(const juce::String& trackId, int samplesPerPixel, int numPixels)
{
    return audioRecorder.getRecordingPeaks(trackId, samplesPerPixel, numPixels);
}

//==============================================================================
// Metronome & Transport Control (Phase 3)

void AudioEngine::setTempo(double bpm)
{
    tempo = bpm;
    metronome.setBpm(bpm);
}

void AudioEngine::setMetronomeEnabled(bool enabled)
{
    metronome.setEnabled(enabled);
}

void AudioEngine::setMetronomeVolume(float volume)
{
    metronome.setVolume(volume);
}

bool AudioEngine::isMetronomeEnabled() const
{
    return metronome.isEnabled();
}

void AudioEngine::setMetronomeAccentBeats(const std::vector<bool>& accents)
{
    metronome.setAccentBeats(accents);
}

void AudioEngine::setTimeSignature(int numerator, int denominator)
{
    timeSigNumerator = numerator;
    timeSigDenominator = denominator;
    metronome.setTimeSignature(numerator, denominator);
}

void AudioEngine::getTimeSignature(int& numerator, int& denominator) const
{
    numerator = timeSigNumerator;
    denominator = timeSigDenominator;
}

//==============================================================================
// AudioPlayHead — provides tempo/position info to hosted VST3 plugins

juce::Optional<juce::AudioPlayHead::PositionInfo> AudioEngine::getPosition() const
{
    PositionInfo info;

    double timeInSeconds = (currentSampleRate > 0)
                           ? currentSamplePosition / currentSampleRate
                           : 0.0;

    // Use tempo map if available, otherwise fall back to global BPM
    double currentBpm = getTempoAtTime(timeInSeconds);
    info.setBpm (currentBpm);

    juce::AudioPlayHead::TimeSignature timeSig;
    timeSig.numerator   = timeSigNumerator;
    timeSig.denominator = timeSigDenominator;
    info.setTimeSignature (timeSig);
    info.setIsPlaying (isPlaying.load());
    info.setIsRecording (isRecordMode.load());
    info.setIsLooping (isLooping);

    info.setTimeInSamples (static_cast<juce::int64> (currentSamplePosition));
    info.setTimeInSeconds (timeInSeconds);

    // PPQ = position in quarter notes = seconds * (BPM / 60)
    // NOTE: With a tempo map, PPQ should integrate over tempo changes.
    // For now, use instantaneous BPM (acceptable for step-wise tempo map).
    double ppqPosition = timeInSeconds * (currentBpm / 60.0);
    info.setPpqPosition (ppqPosition);

    // Bar start in PPQ: quarter notes per bar depends on time signature
    double quarterNotesPerBar = timeSigNumerator * (4.0 / timeSigDenominator);
    if (quarterNotesPerBar > 0.0)
        info.setPpqPositionOfLastBarStart (std::floor (ppqPosition / quarterNotesPerBar) * quarterNotesPerBar);

    return info;
}

void AudioEngine::propagatePlayHead (TrackProcessor* track)
{
    if (!track) return;

    for (int i = 0; i < track->getNumInputFX(); ++i)
        if (auto* proc = track->getInputFXProcessor (i))
            proc->setPlayHead (this);

    for (int i = 0; i < track->getNumTrackFX(); ++i)
        if (auto* proc = track->getTrackFXProcessor (i))
            proc->setPlayHead (this);

    if (auto* inst = track->getInstrument())
        inst->setPlayHead (this);
}

// Custom metronome sounds (Phase 9C)
bool AudioEngine::setMetronomeClickSound(const juce::String& filePath)
{
    return metronome.setClickSound(filePath);
}

bool AudioEngine::setMetronomeAccentSound(const juce::String& filePath)
{
    return metronome.setAccentSound(filePath);
}

void AudioEngine::resetMetronomeSounds()
{
    metronome.resetToDefaultSounds();
}

//==============================================================================
// Plugin Delay Compensation (PDC)

void AudioEngine::recalculatePDC()
{
    // Find maximum chain latency across all tracks
    int maxLatency = 0;
    for (const auto& id : trackOrder)
    {
        auto it = trackMap.find(id);
        if (it != trackMap.end() && it->second)
        {
            int lat = it->second->getChainLatency();
            if (lat > maxLatency)
                maxLatency = lat;
        }
    }

    // Set PDC delay for each track: maxLatency - trackLatency
    for (const auto& id : trackOrder)
    {
        auto it = trackMap.find(id);
        if (it != trackMap.end() && it->second)
        {
            int trackLat = it->second->getChainLatency();
            int delay = maxLatency - trackLat;
            it->second->setPDCDelay(delay);
        }
    }

    juce::Logger::writeToLog("AudioEngine: PDC recalculated - maxLatency=" + juce::String(maxLatency) + " samples");
}

//==============================================================================
// Pan Law

void AudioEngine::setPanLaw(const juce::String& law)
{
    PanLaw newLaw = PanLaw::ConstantPower;
    if (law == "constant_power" || law == "minus3dB")
        newLaw = PanLaw::ConstantPower;
    else if (law == "minus4_5dB")
        newLaw = PanLaw::Minus4_5dB;
    else if (law == "minus6dB")
        newLaw = PanLaw::Minus6dB;
    else if (law == "linear")
        newLaw = PanLaw::Linear;

    currentPanLaw = newLaw;

    // Apply to all tracks
    for (const auto& id : trackOrder)
    {
        auto it = trackMap.find(id);
        if (it != trackMap.end() && it->second)
            it->second->setPanLaw(newLaw);
    }

    juce::Logger::writeToLog("AudioEngine: Pan law set to " + law);
}

juce::String AudioEngine::getPanLaw() const
{
    switch (currentPanLaw)
    {
        case PanLaw::ConstantPower: return "constant_power";
        case PanLaw::Minus4_5dB:    return "minus4_5dB";
        case PanLaw::Minus6dB:      return "minus6dB";
        case PanLaw::Linear:        return "linear";
        default:                    return "constant_power";
    }
}

//==============================================================================
// DC Offset per track

void AudioEngine::setTrackDCOffset(const juce::String& trackId, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setDCOffsetRemoval(enabled);
        juce::Logger::writeToLog("AudioEngine: DC offset removal " +
                                 juce::String(enabled ? "enabled" : "disabled") +
                                 " on track " + trackId);
    }
}

//==============================================================================
// Sidechain Routing (Phase 4.4)

void AudioEngine::setSidechainSource(const juce::String& destTrackId, int pluginIndex, const juce::String& sourceTrackId)
{
    auto it = trackMap.find(destTrackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setSidechainSource(pluginIndex, sourceTrackId);
        juce::Logger::writeToLog("AudioEngine: Set sidechain for track " + destTrackId +
                                 " FX[" + juce::String(pluginIndex) + "] = " + sourceTrackId);
    }
}

void AudioEngine::clearSidechainSource(const juce::String& destTrackId, int pluginIndex)
{
    auto it = trackMap.find(destTrackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->clearSidechainSource(pluginIndex);
        juce::Logger::writeToLog("AudioEngine: Cleared sidechain for track " + destTrackId +
                                 " FX[" + juce::String(pluginIndex) + "]");
    }
}

juce::String AudioEngine::getSidechainSource(const juce::String& destTrackId, int pluginIndex)
{
    auto it = trackMap.find(destTrackId);
    if (it != trackMap.end() && it->second)
        return it->second->getSidechainSource(pluginIndex);
    return {};
}

//==============================================================================
// Send/Bus Routing (Phase 11)

int AudioEngine::addTrackSend(const juce::String& sourceTrackId, const juce::String& destTrackId)
{
    if (trackMap.find(sourceTrackId) == trackMap.end()) return -1;
    return trackMap[sourceTrackId]->addSend(destTrackId);
}

void AudioEngine::removeTrackSend(const juce::String& sourceTrackId, int sendIndex)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
        trackMap[sourceTrackId]->removeSend(sendIndex);
}

void AudioEngine::setTrackSendLevel(const juce::String& sourceTrackId, int sendIndex, float level)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
        trackMap[sourceTrackId]->setSendLevel(sendIndex, level);
}

void AudioEngine::setTrackSendPan(const juce::String& sourceTrackId, int sendIndex, float pan)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
        trackMap[sourceTrackId]->setSendPan(sendIndex, pan);
}

void AudioEngine::setTrackSendEnabled(const juce::String& sourceTrackId, int sendIndex, bool enabled)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
        trackMap[sourceTrackId]->setSendEnabled(sendIndex, enabled);
}

void AudioEngine::setTrackSendPreFader(const juce::String& sourceTrackId, int sendIndex, bool preFader)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
        trackMap[sourceTrackId]->setSendPreFader(sendIndex, preFader);
}

void AudioEngine::setTrackSendPhaseInvert(const juce::String& sourceTrackId, int sendIndex, bool invert)
{
    if (trackMap.find(sourceTrackId) != trackMap.end())
        trackMap[sourceTrackId]->setSendPhaseInvert(sendIndex, invert);
}

juce::var AudioEngine::getTrackSends(const juce::String& trackId)
{
    juce::Array<juce::var> result;
    if (trackMap.find(trackId) == trackMap.end()) return result;

    auto* track = trackMap[trackId];
    for (int i = 0; i < track->getNumSends(); ++i)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("destTrackId", track->getSendDestination(i));
        obj->setProperty("level", track->getSendLevel(i));
        obj->setProperty("pan", track->getSendPan(i));
        obj->setProperty("enabled", track->getSendEnabled(i));
        obj->setProperty("preFader", track->getSendPreFader(i));
        obj->setProperty("phaseInvert", track->getSendPhaseInvert(i));
        result.add(obj);
    }
    return result;
}

//==============================================================================
// Track Routing Features

void AudioEngine::setTrackPhaseInvert(const juce::String& trackId, bool invert)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setPhaseInvert(invert);
}

bool AudioEngine::getTrackPhaseInvert(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getPhaseInvert() : false;
}

void AudioEngine::setTrackStereoWidth(const juce::String& trackId, float widthPercent)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setStereoWidth(widthPercent);
}

float AudioEngine::getTrackStereoWidth(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getStereoWidth() : 100.0f;
}

void AudioEngine::setTrackMasterSendEnabled(const juce::String& trackId, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setMasterSendEnabled(enabled);
}

bool AudioEngine::getTrackMasterSendEnabled(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getMasterSendEnabled() : true;
}

void AudioEngine::setTrackOutputChannels(const juce::String& trackId, int startChannel, int numChannels)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setOutputChannels(startChannel, numChannels);
}

void AudioEngine::setTrackPlaybackOffset(const juce::String& trackId, double offsetMs)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setPlaybackOffset(offsetMs);
}

double AudioEngine::getTrackPlaybackOffset(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getPlaybackOffset() : 0.0;
}

void AudioEngine::setTrackChannelCount(const juce::String& trackId, int numChannels)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setTrackChannelCount(numChannels);
}

int AudioEngine::getTrackChannelCount(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getTrackChannelCount() : 2;
}

void AudioEngine::setTrackMIDIOutput(const juce::String& trackId, const juce::String& deviceName)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end()) it->second->setMIDIOutputDevice(deviceName);
}

juce::String AudioEngine::getTrackMIDIOutput(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    return it != trackMap.end() ? it->second->getMIDIOutputDeviceName() : juce::String();
}

juce::var AudioEngine::getTrackRoutingInfo(const juce::String& trackId)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end()) return juce::var();

    auto* track = it->second;
    auto* obj = new juce::DynamicObject();

    obj->setProperty("phaseInverted", track->getPhaseInvert());
    obj->setProperty("stereoWidth", track->getStereoWidth());
    obj->setProperty("masterSendEnabled", track->getMasterSendEnabled());
    obj->setProperty("outputStartChannel", track->getOutputStartChannel());
    obj->setProperty("outputChannelCount", track->getOutputChannelCount());
    obj->setProperty("playbackOffsetMs", track->getPlaybackOffset());
    obj->setProperty("trackChannelCount", track->getTrackChannelCount());
    obj->setProperty("midiOutputDevice", track->getMIDIOutputDeviceName());

    return juce::var(obj);
}

juce::String AudioEngine::renderMetronomeToFile(double startTime, double endTime)
{
    // Create output file in Studio13/Audio directory
    auto docsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    auto audioFolder = docsDir.getChildFile("Studio13").getChildFile("Audio");

    if (!audioFolder.exists())
        audioFolder.createDirectory();

    auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
    auto filename = "Metronome_" + juce::String(timestamp) + ".wav";
    auto outputFile = audioFolder.getChildFile(filename);

    // Create a dedicated Metronome instance for offline rendering
    // (to avoid interfering with the real-time metronome)
    Metronome renderMetronome;
    renderMetronome.prepareToPlay(currentSampleRate, 512);
    renderMetronome.setBpm(tempo);
    renderMetronome.setTimeSignature(timeSigNumerator, timeSigDenominator);
    renderMetronome.setVolume(metronome.getVolume());
    renderMetronome.setAccentBeats(metronome.getAccentBeats());

    bool success = renderMetronome.renderToFile(outputFile, startTime, endTime);

    if (success)
    {
        juce::Logger::writeToLog("AudioEngine: Rendered metronome to: " + outputFile.getFullPathName());
        return outputFile.getFullPathName();
    }

    juce::Logger::writeToLog("AudioEngine: Failed to render metronome");
    return {};
}

//==============================================================================
// Plugin State Serialization (F2 - Project Save/Load)

juce::String AudioEngine::getPluginState(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    if (trackMap.find(trackId) == trackMap.end())
        return {};
    
    auto* track = trackMap[trackId];
    if (!track)
        return {};
    
    juce::AudioProcessor* processor = nullptr;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }
    
    if (!processor)
        return {};
    
    // Get plugin state as memory block
    juce::MemoryBlock stateData;
    processor->getStateInformation(stateData);
    
    // Convert to Base64 string
    return stateData.toBase64Encoding();
}

bool AudioEngine::setPluginState(const juce::String& trackId, int fxIndex, bool isInputFX, const juce::String& base64State)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;
    
    auto* track = trackMap[trackId];
    if (!track)
        return false;
    
    juce::AudioProcessor* processor = nullptr;
    
    if (isInputFX)
    {
        if (fxIndex >= 0 && fxIndex < track->getNumInputFX())
            processor = track->getInputFXProcessor(fxIndex);
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
            processor = track->getTrackFXProcessor(fxIndex);
    }
    
    if (!processor)
        return false;
    
    // Decode Base64 to memory block
    juce::MemoryBlock stateData;
    if (!stateData.fromBase64Encoding(base64State))
        return false;
    
    // Set plugin state
    processor->setStateInformation(stateData.getData(), static_cast<int>(stateData.getSize()));
    
    juce::Logger::writeToLog("AudioEngine: Restored plugin state for track " + trackId + 
                             " FX " + juce::String(fxIndex) + " (isInput: " + (isInputFX ? "true" : "false") + ")");
    return true;
}

juce::String AudioEngine::getMasterPluginState(int fxIndex)
{
    if (fxIndex < 0 || fxIndex >= static_cast<int>(masterFXNodes.size()))
        return {};
    
    auto& node = masterFXNodes[fxIndex];
    if (!node || !node->getProcessor())
        return {};
    
    juce::MemoryBlock stateData;
    node->getProcessor()->getStateInformation(stateData);
    
    return stateData.toBase64Encoding();
}

bool AudioEngine::setMasterPluginState(int fxIndex, const juce::String& base64State)
{
    if (fxIndex < 0 || fxIndex >= static_cast<int>(masterFXNodes.size()))
        return false;

    auto& node = masterFXNodes[fxIndex];
    if (!node || !node->getProcessor())
        return false;

    juce::MemoryBlock stateData;
    if (!stateData.fromBase64Encoding(base64State))
        return false;

    node->getProcessor()->setStateInformation(stateData.getData(), static_cast<int>(stateData.getSize()));

    juce::Logger::writeToLog("AudioEngine: Restored master plugin state for FX " + juce::String(fxIndex));
    return true;
}

//==============================================================================
// FFmpeg Helpers

juce::File AudioEngine::findFFmpegExe() const
{
    // Search for ffmpeg.exe in common locations relative to the executable
    auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();

    // 1. Same directory as executable
    auto ffmpeg = exeDir.getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 2. tools/ subdirectory
    ffmpeg = exeDir.getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 3. ../tools/ (one level up)
    ffmpeg = exeDir.getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 4. ../../tools/ (two levels up, for build/Studio13_artefacts/Release/)
    ffmpeg = exeDir.getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    // 5. ../../../tools/ (three levels up, for deeper build paths)
    ffmpeg = exeDir.getParentDirectory().getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
    if (ffmpeg.existsAsFile()) return ffmpeg;

    return juce::File(); // Not found
}

bool AudioEngine::convertWithFFmpeg(const juce::File& inputFile, const juce::File& outputFile,
                                     const juce::String& format, double targetSampleRate, int quality) const
{
    auto ffmpeg = findFFmpegExe();
    if (!ffmpeg.existsAsFile())
    {
        logToDisk("convertWithFFmpeg: FAIL - ffmpeg.exe not found");
        return false;
    }

    // Build ffmpeg command
    juce::StringArray args;
    args.add(ffmpeg.getFullPathName());
    args.add("-y");                                // Overwrite output
    args.add("-i");
    args.add(inputFile.getFullPathName());         // Input file

    // Sample rate conversion (if target differs from source)
    if (targetSampleRate > 0)
    {
        args.add("-ar");
        args.add(juce::String((int)targetSampleRate));
    }

    juce::String formatLower = format.toLowerCase();

    if (formatLower == "mp3")
    {
        args.add("-codec:a");
        args.add("libmp3lame");
        // quality = bitrate in kbps (128, 192, 256, 320)
        int bitrate = (quality > 0) ? quality : 320;
        args.add("-b:a");
        args.add(juce::String(bitrate) + "k");
    }
    else if (formatLower == "ogg")
    {
        args.add("-codec:a");
        args.add("libvorbis");
        // quality = vorbis quality level (0-10, default 6)
        int q = (quality > 0) ? quality : 6;
        args.add("-q:a");
        args.add(juce::String(q));
    }
    else
    {
        // WAV/AIFF/FLAC sample rate conversion only — keep format as-is
        // ffmpeg auto-detects output format from extension
    }

    args.add(outputFile.getFullPathName());        // Output file

    logToDisk("convertWithFFmpeg: Running: " + args.joinIntoString(" "));

    // Run ffmpeg as child process
    juce::ChildProcess process;
    if (!process.start(args))
    {
        logToDisk("convertWithFFmpeg: FAIL - could not start ffmpeg process");
        return false;
    }

    // Wait for completion (up to 5 minutes for large files)
    if (!process.waitForProcessToFinish(300000))
    {
        logToDisk("convertWithFFmpeg: FAIL - ffmpeg timed out after 5 minutes");
        process.kill();
        return false;
    }

    int exitCode = process.getExitCode();
    if (exitCode != 0)
    {
        juce::String errOutput = process.readAllProcessOutput();
        logToDisk("convertWithFFmpeg: FAIL - ffmpeg exit code " + juce::String(exitCode) + " output: " + errOutput);
        return false;
    }

    if (!outputFile.existsAsFile())
    {
        logToDisk("convertWithFFmpeg: FAIL - output file not created");
        return false;
    }

    logToDisk("convertWithFFmpeg: SUCCESS - " + outputFile.getFullPathName() +
              " (" + juce::String(outputFile.getSize() / 1024) + " KB)");
    return true;
}

//==============================================================================
// Offline Render/Export

bool AudioEngine::renderProject(const juce::String& source, double startTime, double endTime,
                                const juce::String& filePath, const juce::String& format,
                                double renderSampleRate, int bitDepth, int numChannels,
                                bool normalize, bool addTail, double tailLengthMs)
{
    logToDisk("renderProject: START - file=" + filePath + " format=" + format +
              " range=" + juce::String(startTime) + "-" + juce::String(endTime) +
              " sr=" + juce::String(renderSampleRate) + " bits=" + juce::String(bitDepth) +
              " ch=" + juce::String(numChannels) +
              " normalize=" + juce::String(normalize ? "true" : "false") +
              " addTail=" + juce::String(addTail ? "true" : "false") +
              " tailMs=" + juce::String(tailLengthMs));

    // ========== 1. Validate inputs ==========
    if (endTime <= startTime)
    {
        logToDisk("renderProject: FAIL - endTime (" + juce::String(endTime) +
                  ") <= startTime (" + juce::String(startTime) + ")");
        return false;
    }
    // Use requested sample rate for render if provided, otherwise fall back to device rate.
    // PlaybackEngine::fillTrackBuffer() handles per-file SR conversion automatically,
    // so rendering at a different rate than the device is fully supported.
    double actualSampleRate = (renderSampleRate > 0) ? renderSampleRate : currentSampleRate;
    if (actualSampleRate <= 0) actualSampleRate = 44100.0;
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32) bitDepth = 24;
    if (numChannels < 1 || numChannels > 2) numChannels = 2;

    // Determine if we need post-processing (lossy encoding only — SR conversion
    // is now handled natively by rendering at the target rate)
    juce::String formatLower = format.toLowerCase();
    bool isLossyFormat = (formatLower == "mp3" || formatLower == "ogg");
    bool needsFFmpegPostProcess = isLossyFormat;

    // For lossy formats, bitDepth holds codec quality:
    //   MP3: bitrate in kbps (128, 192, 256, 320)
    //   OGG: quality level (1-10)
    int codecQuality = isLossyFormat ? bitDepth : 0;
    if (isLossyFormat) bitDepth = 24; // Render intermediate WAV at 24-bit

    // Parse stem track filter from source (e.g., "stem:trackId123")
    juce::String stemTrackId;
    bool isStemRender = source.startsWith("stem:");
    if (isStemRender)
        stemTrackId = source.substring(5); // After "stem:"

    logToDisk("renderProject: Using actualSampleRate=" + juce::String(actualSampleRate) +
              (actualSampleRate != currentSampleRate ? " (differs from device rate " + juce::String(currentSampleRate) + ")" : " (device rate)"));
    if (isLossyFormat)
        logToDisk("renderProject: Lossy format=" + formatLower + " codecQuality=" + juce::String(codecQuality));
    if (isStemRender)
        logToDisk("renderProject: Stem render for trackId=" + stemTrackId);

    // ========== 2. Stop real-time playback and block audio callback ==========
    bool wasPlaying = isPlaying.load();
    bool wasRecording = isRecordMode.load();
    if (wasPlaying) isPlaying = false;
    if (wasRecording) isRecordMode = false;
    isRendering = true;  // Block audio callback from processing FX plugins
    juce::Thread::sleep(100); // Let audio callback finish current block

    // ========== 3. Snapshot clip data ==========
    auto clipSnapshot = playbackEngine.getClipSnapshot();
    logToDisk("renderProject: Clip snapshot has " + juce::String((int)clipSnapshot.size()) + " clips");

    if (clipSnapshot.empty())
    {
        logToDisk("renderProject: WARNING - No clips in playback engine! Render will be silent.");
    }

    // Log each clip for debugging
    for (size_t i = 0; i < clipSnapshot.size(); ++i)
    {
        const auto& clip = clipSnapshot[i];
        logToDisk("  Clip " + juce::String((int)i) + ": track=" + clip.trackId +
                  " file=" + clip.audioFile.getFileName() +
                  " start=" + juce::String(clip.startTime) +
                  " dur=" + juce::String(clip.duration) +
                  " offset=" + juce::String(clip.offset) +
                  " active=" + juce::String(clip.isActive ? "true" : "false"));
    }

    // ========== 4. Snapshot track params ==========
    struct TrackSnapshot {
        juce::String id;
        float volumeDB;
        float pan;
        bool muted;
        bool soloed;
    };
    std::vector<TrackSnapshot> trackSnapshots;
    bool anySoloed = false;
    {
        const juce::ScopedLock sl(mainProcessorGraph->getCallbackLock());
        for (const auto& trackId : trackOrder)
        {
            auto it = trackMap.find(trackId);
            if (it == trackMap.end() || !it->second) continue;
            auto* track = it->second;
            TrackSnapshot snap;
            snap.id = trackId;
            snap.volumeDB = track->getVolume();
            snap.pan = track->getPan();
            snap.muted = track->getMute();
            snap.soloed = track->getSolo();
            if (snap.soloed) anySoloed = true;
            trackSnapshots.push_back(snap);
            logToDisk("  Track " + trackId + ": vol=" + juce::String(snap.volumeDB) +
                      "dB pan=" + juce::String(snap.pan) +
                      " mute=" + juce::String(snap.muted ? "true" : "false") +
                      " solo=" + juce::String(snap.soloed ? "true" : "false"));
        }
    }

    logToDisk("renderProject: " + juce::String((int)trackSnapshots.size()) + " tracks, anySoloed=" + juce::String(anySoloed ? "true" : "false"));

    // ========== 5. Create format writer ==========
    // For lossy formats (mp3/ogg) or sample rate conversion, render to temp WAV first
    juce::File outputFile(filePath);
    juce::File renderFile = outputFile; // File we actually write to (may be temp WAV)

    if (needsFFmpegPostProcess)
    {
        // Create temp WAV file next to the output
        renderFile = outputFile.getParentDirectory().getChildFile(
            outputFile.getFileNameWithoutExtension() + "_temp_render.wav");
    }

    std::unique_ptr<juce::AudioFormat> audioFormat;
    juce::String renderFormatLower = needsFFmpegPostProcess ? "wav" : formatLower;

    if (renderFormatLower == "wav")
        audioFormat = std::make_unique<juce::WavAudioFormat>();
    else if (renderFormatLower == "aiff" || renderFormatLower == "aif")
        audioFormat = std::make_unique<juce::AiffAudioFormat>();
    else if (renderFormatLower == "flac")
    {
        audioFormat = std::make_unique<juce::FlacAudioFormat>();
        if (bitDepth > 24) bitDepth = 24; // FLAC max 24-bit
    }
    else
    {
        logToDisk("renderProject: FAIL - unsupported format: " + format);
        isRendering = false;
        return false;
    }

    renderFile.getParentDirectory().createDirectory();
    if (renderFile.existsAsFile())
        renderFile.deleteFile();
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    auto fileStream = std::make_unique<juce::FileOutputStream>(renderFile);
    if (fileStream->failedToOpen())
    {
        logToDisk("renderProject: FAIL - could not open output file: " + renderFile.getFullPathName());
        isRendering = false;
        return false;
    }

    // Determine writer channels (always render in stereo internally, downmix to mono if needed)
    int writerChannels = numChannels;

    std::unique_ptr<juce::AudioFormatWriter> writer(
        audioFormat->createWriterFor(fileStream.get(),
                                     actualSampleRate,
                                     writerChannels,
                                     bitDepth,
                                     {}, // metadata
                                     0)); // quality
    if (!writer)
    {
        logToDisk("renderProject: FAIL - could not create writer (sr=" +
                  juce::String(actualSampleRate) + " bits=" + juce::String(bitDepth) +
                  " ch=" + juce::String(writerChannels) + ")");
        isRendering = false;
        return false;
    }
    fileStream.release(); // Writer owns the stream now

    // ========== 6. Calculate total samples ==========
    double tailSeconds = addTail ? (tailLengthMs / 1000.0) : 0.0;
    double totalDuration = (endTime - startTime) + tailSeconds;
    juce::int64 totalSamples = (juce::int64)(totalDuration * actualSampleRate);
    const int blockSize = 2048;  // Larger block size for faster offline rendering

    logToDisk("renderProject: totalDuration=" + juce::String(totalDuration) +
              "s totalSamples=" + juce::String(totalSamples) +
              " blockSize=" + juce::String(blockSize));

    // ========== 6b. Save plugin state & prepare plugins for offline rendering ==========
    // Plugins were prepared for the device's buffer size (e.g. 128/256). The render
    // uses 512-sample blocks. We must re-prepare all FX plugins with the render block
    // size, otherwise plugins like Amplitube overflow internal buffers → noise/crash.
    // We also reset() to clear stale state from real-time playback.

    // Collect all FX processors that will be used during render
    struct PluginStateBackup {
        juce::AudioProcessor* processor;
        juce::MemoryBlock savedState;
    };
    std::vector<PluginStateBackup> pluginBackups;

    // Lambda to save state, prepare, and reset a processor for render
    auto prepareProcessorForRender = [&](juce::AudioProcessor* proc) {
        if (!proc) return;
        // Save current state
        PluginStateBackup backup;
        backup.processor = proc;
        proc->getStateInformation(backup.savedState);
        pluginBackups.push_back(std::move(backup));
        // Re-prepare for render block size
        proc->prepareToPlay(actualSampleRate, blockSize);
        proc->reset();
    };

    // Prepare track FX plugins
    for (const auto& snap : trackSnapshots)
    {
        auto it = trackMap.find(snap.id);
        if (it == trackMap.end() || !it->second) continue;
        auto* track = it->second;
        for (int fx = 0; fx < track->getNumInputFX(); ++fx)
            prepareProcessorForRender(track->getInputFXProcessor(fx));
        for (int fx = 0; fx < track->getNumTrackFX(); ++fx)
            prepareProcessorForRender(track->getTrackFXProcessor(fx));
    }

    // Prepare master FX plugins
    for (auto& node : masterFXNodes)
    {
        if (node && node->getProcessor())
            prepareProcessorForRender(node->getProcessor());
    }

    logToDisk("renderProject: Saved & prepared " + juce::String((int)pluginBackups.size()) + " FX plugins for render");

    // ========== 7 & 8. Render loop (with optional 2-pass normalization) ==========
    int numPasses = normalize ? 2 : 1;
    float normGain = 1.0f;
    float peakLevel = 0.0f;

    // Dither state (0 = off, 1 = TPDF, 2 = noise-shaped)
    int ditherMode = pendingDitherMode_.load();
    pendingDitherMode_ = 0; // Reset for next render call
    juce::Random ditherRng;
    float ditherErrorState[2] = { 0.0f, 0.0f }; // Per-channel error feedback for noise shaping

    // Check if metronome was enabled for render
    bool renderMetronomeAudio = metronome.isEnabled();

    for (int pass = 0; pass < numPasses; ++pass)
    {
        logToDisk("renderProject: Pass " + juce::String(pass + 1) + " of " + juce::String(numPasses));

        // Reset all FX plugins at the start of each pass so they begin from a clean state.
        // This is critical for 2-pass normalization: pass 2 must produce identical output
        // to pass 1, which requires identical initial plugin state.
        for (auto& backup : pluginBackups)
        {
            if (backup.processor)
            {
                backup.processor->setStateInformation(backup.savedState.getData(),
                                                       (int)backup.savedState.getSize());
                backup.processor->reset();
            }
        }

        // Create fresh offline playback engine for each pass (deterministic reads)
        PlaybackEngine passPlayback;
        passPlayback.setRenderMode(true);  // Use Lagrange interpolation for high-quality resampling
        for (const auto& clip : clipSnapshot)
        {
            passPlayback.addClip(clip.audioFile, clip.startTime, clip.duration,
                                 clip.trackId, clip.offset, clip.volumeDB,
                                 clip.fadeIn, clip.fadeOut);
        }

        // Create fresh metronome for each pass
        Metronome renderMet;
        if (renderMetronomeAudio)
        {
            renderMet.prepareToPlay(actualSampleRate, blockSize);
            renderMet.setBpm(tempo);
            renderMet.setTimeSignature(timeSigNumerator, timeSigDenominator);
            renderMet.setVolume(metronome.getVolume());
            renderMet.setAccentBeats(metronome.getAccentBeats());
            renderMet.setEnabled(true);
        }

        if (pass == 1)
        {
            // Second pass: calculate normalization gain
            if (peakLevel > 0.0f)
                normGain = 1.0f / peakLevel;
            else
                normGain = 1.0f;
            logToDisk("renderProject: Normalize gain = " + juce::String(normGain) +
                      " (peak was " + juce::String(peakLevel) + ")");
        }

        juce::int64 samplesRemaining = totalSamples;
        double currentTimeSeconds = startTime;
        double samplePositionForMetronome = startTime * actualSampleRate;
        float passPeak = 0.0f; // Track peak for this pass

        while (samplesRemaining > 0)
        {
            int samplesThisBlock = (int)std::min((juce::int64)blockSize, samplesRemaining);

            // Master buffer (always stereo internally)
            juce::AudioBuffer<float> masterBuffer(2, samplesThisBlock);
            masterBuffer.clear();

            // Add metronome if enabled
            if (renderMetronomeAudio)
            {
                renderMet.getNextAudioBlock(masterBuffer, samplePositionForMetronome);
            }

            // Process each track
            for (const auto& snap : trackSnapshots)
            {
                // Stem rendering: only process the specified track
                if (isStemRender && snap.id != stemTrackId) continue;

                // Skip muted tracks (unless stem render — always render the target track)
                if (!isStemRender && snap.muted) continue;
                // If any track is soloed, skip non-soloed tracks (unless stem render)
                if (!isStemRender && anySoloed && !snap.soloed) continue;

                // Fill track buffer from clips
                juce::AudioBuffer<float> trackBuffer(2, samplesThisBlock);
                trackBuffer.clear();
                passPlayback.fillTrackBuffer(snap.id, trackBuffer, currentTimeSeconds,
                                             samplesThisBlock, actualSampleRate);

                // Process track FX chain BEFORE volume/pan (matches real-time signal flow)
                // Channel-safe: expand buffer if plugin needs more channels than our stereo buffer
                {
                    auto it = trackMap.find(snap.id);
                    if (it != trackMap.end() && it->second)
                    {
                        auto* track = it->second;
                        int numInputFX = track->getNumInputFX();
                        int numTrackFX = track->getNumTrackFX();
                        if (numInputFX > 0 || numTrackFX > 0)
                        {
                            juce::MidiBuffer midiMessages;
                            auto safeRenderFX = [&](juce::AudioProcessor* proc) {
                                int pluginCh = juce::jmax(proc->getTotalNumInputChannels(),
                                                          proc->getTotalNumOutputChannels());
                                if (pluginCh <= trackBuffer.getNumChannels())
                                {
                                    proc->processBlock(trackBuffer, midiMessages);
                                }
                                else
                                {
                                    // Expand buffer for this plugin (render thread — allocation OK)
                                    juce::AudioBuffer<float> expanded(pluginCh, samplesThisBlock);
                                    expanded.clear();
                                    for (int ch = 0; ch < trackBuffer.getNumChannels(); ++ch)
                                        expanded.copyFrom(ch, 0, trackBuffer, ch, 0, samplesThisBlock);
                                    proc->processBlock(expanded, midiMessages);
                                    for (int ch = 0; ch < trackBuffer.getNumChannels(); ++ch)
                                        trackBuffer.copyFrom(ch, 0, expanded, ch, 0, samplesThisBlock);
                                }
                            };
                            for (int fx = 0; fx < numInputFX; ++fx)
                            {
                                auto* proc = track->getInputFXProcessor(fx);
                                if (proc) safeRenderFX(proc);
                            }
                            for (int fx = 0; fx < numTrackFX; ++fx)
                            {
                                auto* proc = track->getTrackFXProcessor(fx);
                                if (proc) safeRenderFX(proc);
                            }
                        }
                    }
                }

                // Apply per-track volume/pan AFTER FX (matches real-time signal flow)
                float volumeGain = juce::Decibels::decibelsToGain(snap.volumeDB);
                const float pi = juce::MathConstants<float>::pi;
                float panAngle = (snap.pan + 1.0f) * pi / 4.0f;
                float leftGain = std::cos(panAngle) * volumeGain;
                float rightGain = std::sin(panAngle) * volumeGain;

                juce::FloatVectorOperations::multiply(trackBuffer.getWritePointer(0), leftGain, samplesThisBlock);
                juce::FloatVectorOperations::multiply(trackBuffer.getWritePointer(1), rightGain, samplesThisBlock);

                // Mix into master buffer
                for (int ch = 0; ch < 2; ++ch)
                {
                    masterBuffer.addFrom(ch, 0, trackBuffer, ch, 0, samplesThisBlock);
                }
            }

            // Process master FX chain (channel-safe, render thread — allocation OK)
            // Skip master FX for stem renders (export raw track output)
            if (!isStemRender && !masterFXNodes.empty())
            {
                juce::MidiBuffer dummyMidi;
                for (auto& node : masterFXNodes)
                {
                    if (node && node->getProcessor())
                    {
                        auto* proc = node->getProcessor();
                        int pluginCh = juce::jmax(proc->getTotalNumInputChannels(),
                                                   proc->getTotalNumOutputChannels());
                        if (pluginCh <= masterBuffer.getNumChannels())
                        {
                            proc->processBlock(masterBuffer, dummyMidi);
                        }
                        else
                        {
                            juce::AudioBuffer<float> expanded(pluginCh, samplesThisBlock);
                            expanded.clear();
                            for (int ch = 0; ch < masterBuffer.getNumChannels(); ++ch)
                                expanded.copyFrom(ch, 0, masterBuffer, ch, 0, samplesThisBlock);
                            proc->processBlock(expanded, dummyMidi);
                            for (int ch = 0; ch < masterBuffer.getNumChannels(); ++ch)
                                masterBuffer.copyFrom(ch, 0, expanded, ch, 0, samplesThisBlock);
                        }
                    }
                }
            }

            // Apply master pan (constant power law) — skip for stem renders
            if (!isStemRender)
            {
                const float pi = juce::MathConstants<float>::pi;
                float panAngle = (masterPan + 1.0f) * pi / 4.0f;
                float leftGain = std::cos(panAngle);
                float rightGain = std::sin(panAngle);

                juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(0), leftGain, samplesThisBlock);
                juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(1), rightGain, samplesThisBlock);
            }

            // Apply master volume — skip for stem renders
            if (!isStemRender)
            {
                for (int ch = 0; ch < 2; ++ch)
                {
                    juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(ch), masterVolume, samplesThisBlock);
                }
            }

            // Apply normalization gain (pass 2 only)
            if (pass == 1 && normGain != 1.0f)
            {
                for (int ch = 0; ch < 2; ++ch)
                {
                    juce::FloatVectorOperations::multiply(masterBuffer.getWritePointer(ch), normGain, samplesThisBlock);
                }
            }

            // Measure peak level
            for (int ch = 0; ch < 2; ++ch)
            {
                auto range = masterBuffer.findMinMax(ch, 0, samplesThisBlock);
                float chPeak = std::max(std::abs(range.getStart()), std::abs(range.getEnd()));
                if (chPeak > passPeak) passPeak = chPeak;
            }

            if (pass == 0 && normalize)
            {
                // Pass 1: accumulate peak for normalization
                if (passPeak > peakLevel) peakLevel = passPeak;
            }

            // Write to file (final pass only)
            bool isFinalPass = (pass == numPasses - 1);
            if (isFinalPass)
            {
                // Apply dither if requested (before bit-depth truncation by the writer)
                if (ditherMode > 0 && bitDepth < 32)
                {
                    // ditherMode 1 = TPDF, 2 = noise-shaped (first-order high-pass)
                    float ditherAmp = 1.0f / static_cast<float>(1 << (bitDepth - 1)); // 1 LSB
                    for (int ch = 0; ch < masterBuffer.getNumChannels(); ++ch)
                    {
                        float* data = masterBuffer.getWritePointer(ch);
                        for (int s = 0; s < samplesThisBlock; ++s)
                        {
                            // TPDF: two uniform randoms → triangular PDF
                            float r1 = (ditherRng.nextFloat() * 2.0f - 1.0f) * ditherAmp;
                            float r2 = (ditherRng.nextFloat() * 2.0f - 1.0f) * ditherAmp;
                            float noise = r1 + r2;

                            if (ditherMode == 2)
                            {
                                // First-order noise shaping: subtract previous quantization error
                                float shaped = noise - ditherErrorState[ch];
                                float original = data[s];
                                data[s] = original + shaped;
                                // Quantize to calculate error for next sample
                                float scale = static_cast<float>(1 << (bitDepth - 1));
                                float quantized = std::round(data[s] * scale) / scale;
                                ditherErrorState[ch] = quantized - original;
                            }
                            else
                            {
                                data[s] += noise;
                            }
                        }
                    }
                }

                if (numChannels == 1)
                {
                    // Mono downmix: average L+R
                    juce::AudioBuffer<float> monoBuffer(1, samplesThisBlock);
                    monoBuffer.clear();
                    monoBuffer.addFrom(0, 0, masterBuffer, 0, 0, samplesThisBlock, 0.5f);
                    monoBuffer.addFrom(0, 0, masterBuffer, 1, 0, samplesThisBlock, 0.5f);
                    writer->writeFromAudioSampleBuffer(monoBuffer, 0, samplesThisBlock);
                }
                else
                {
                    writer->writeFromAudioSampleBuffer(masterBuffer, 0, samplesThisBlock);
                }
            }

            currentTimeSeconds += (double)samplesThisBlock / actualSampleRate;
            samplePositionForMetronome += samplesThisBlock;
            samplesRemaining -= samplesThisBlock;
        }

        logToDisk("renderProject: Pass " + juce::String(pass + 1) + " complete. Peak level: " + juce::String(passPeak));
    }

    // Flush and close
    writer.reset();

    // ========== 9. FFmpeg post-processing (lossy encoding only) ==========
    if (needsFFmpegPostProcess)
    {
        logToDisk("renderProject: Starting FFmpeg post-processing (lossy encoding)...");
        // SR conversion is already handled natively — no need to pass targetSR here
        bool ffmpegOk = convertWithFFmpeg(renderFile, outputFile, formatLower, 0, codecQuality);

        // Clean up temp file
        renderFile.deleteFile();

        if (!ffmpegOk)
        {
            logToDisk("renderProject: FAIL - FFmpeg post-processing failed");
            // Restore plugins before returning (clamp max-block to at least 512)
            for (auto& backup : pluginBackups)
            {
                if (backup.processor)
                {
                    backup.processor->prepareToPlay(currentSampleRate, juce::jmax(currentBlockSize, 512));
                    backup.processor->setStateInformation(backup.savedState.getData(),
                                                           (int)backup.savedState.getSize());
                    backup.processor->reset();
                }
            }
            isRendering = false;
            return false;
        }
    }

    // ========== 10. Restore plugin state for real-time playback ==========
    // Re-prepare all FX plugins for the device's buffer size and restore their
    // saved state so real-time playback continues as if render never happened.
    // Clamp max-block to at least 512 (same rationale as track FX preparation).
    for (auto& backup : pluginBackups)
    {
        if (backup.processor)
        {
            backup.processor->prepareToPlay(currentSampleRate, juce::jmax(currentBlockSize, 512));
            backup.processor->setStateInformation(backup.savedState.getData(),
                                                   (int)backup.savedState.getSize());
            backup.processor->reset();
        }
    }
    logToDisk("renderProject: Restored " + juce::String((int)pluginBackups.size()) + " FX plugins for real-time");

    // Re-enable audio callback
    isRendering = false;

    logToDisk("renderProject: SUCCESS - " + outputFile.getFullPathName() +
              " (" + juce::String(outputFile.getSize() / 1024) + " KB)");

    return true;
}

bool AudioEngine::renderProjectWithDither(const juce::String& source, double startTime, double endTime,
                                          const juce::String& filePath, const juce::String& format,
                                          double renderSampleRate, int bitDepth, int numChannels,
                                          bool normalize, bool addTail, double tailLengthMs,
                                          const juce::String& ditherType)
{
    // Map dither type string to mode: "tpdf" → 1, "shaped" → 2, else → 0
    if (ditherType == "tpdf")
        pendingDitherMode_ = 1;
    else if (ditherType == "shaped")
        pendingDitherMode_ = 2;
    else
        pendingDitherMode_ = 0;

    return renderProject(source, startTime, endTime, filePath, format,
                         renderSampleRate, bitDepth, numChannels,
                         normalize, addTail, tailLengthMs);
}

//==============================================================================
// Automation (Phase 1.1)

static AutomationList* getAutomationListForParam(TrackProcessor* track, const juce::String& parameterId)
{
    if (parameterId == "volume")
        return &track->getVolumeAutomation();
    if (parameterId == "pan")
        return &track->getPanAutomation();
    // Future: plugin parameter automation would go here
    return nullptr;
}

static AutomationMode parseAutomationMode(const juce::String& modeStr)
{
    if (modeStr == "read")  return AutomationMode::Read;
    if (modeStr == "write") return AutomationMode::Write;
    if (modeStr == "touch") return AutomationMode::Touch;
    if (modeStr == "latch") return AutomationMode::Latch;
    return AutomationMode::Off;
}

static juce::String automationModeToString(AutomationMode mode)
{
    switch (mode)
    {
        case AutomationMode::Read:  return "read";
        case AutomationMode::Write: return "write";
        case AutomationMode::Touch: return "touch";
        case AutomationMode::Latch: return "latch";
        case AutomationMode::Off:
        default:                    return "off";
    }
}

void AudioEngine::setAutomationPoints(const juce::String& trackId, const juce::String& parameterId,
                                       const juce::String& pointsJSON)
{
    // Master automation special case
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
        if (!list) return;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second)
            return;
        list = getAutomationListForParam(it->second, parameterId);
        if (!list)
            return;
    }

    // Parse JSON array of { time: <seconds>, value: <float> }
    auto parsed = juce::JSON::parse(pointsJSON);
    if (!parsed.isArray())
        return;

    auto* arr = parsed.getArray();
    std::vector<AutomationPoint> points;
    points.reserve(static_cast<size_t>(arr->size()));

    for (const auto& item : *arr)
    {
        double timeSec = item.getProperty("time", 0.0);
        float value = static_cast<float>(static_cast<double>(item.getProperty("value", 0.0)));
        // Convert seconds to samples for the audio thread
        double timeSamples = timeSec * currentSampleRate;
        points.push_back({ timeSamples, value });
    }

    list->setPoints(std::move(points));

    juce::Logger::writeToLog("AudioEngine: Set " + juce::String(static_cast<int>(points.size())) +
                             " automation points for track " + trackId + " param " + parameterId);
}

void AudioEngine::setAutomationMode(const juce::String& trackId, const juce::String& parameterId,
                                     const juce::String& modeStr)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
        if (!list) return;

        auto mode = parseAutomationMode(modeStr);
        list->setMode(mode);

        if (mode != AutomationMode::Off)
        {
            if (parameterId == "volume")
                list->setDefaultValue(masterVolume);
            else if (parameterId == "pan")
                list->setDefaultValue(masterPan);
        }
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second)
            return;

        list = getAutomationListForParam(it->second, parameterId);
        if (!list)
            return;

        auto mode = parseAutomationMode(modeStr);
        list->setMode(mode);

        if (mode != AutomationMode::Off)
        {
            if (parameterId == "volume")
                list->setDefaultValue(it->second->getVolume());
            else if (parameterId == "pan")
                list->setDefaultValue(it->second->getPan());
        }
    }

    juce::Logger::writeToLog("AudioEngine: Set automation mode for track " + trackId +
                             " param " + parameterId + " = " + modeStr);
}

juce::String AudioEngine::getAutomationMode(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second)
            return "off";
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (!list)
        return "off";

    return automationModeToString(list->getMode());
}

void AudioEngine::clearAutomation(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second) return;
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (list)
        list->clear();
}

void AudioEngine::beginTouchAutomation(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second) return;
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (list)
        list->beginTouch();
}

void AudioEngine::endTouchAutomation(const juce::String& trackId, const juce::String& parameterId)
{
    AutomationList* list = nullptr;
    if (trackId == "master")
    {
        if (parameterId == "volume") list = &masterVolumeAutomation;
        else if (parameterId == "pan") list = &masterPanAutomation;
    }
    else
    {
        auto it = trackMap.find(trackId);
        if (it == trackMap.end() || !it->second) return;
        list = getAutomationListForParam(it->second, parameterId);
    }
    if (list)
        list->endTouch();
}

//==============================================================================
// Tempo Map (Phase 1.2)

void AudioEngine::setTempoMarkers(const juce::String& markersJSON)
{
    auto parsed = juce::JSON::parse(markersJSON);
    if (!parsed.isArray())
        return;

    std::vector<TempoMarker> newMarkers;
    auto* arr = parsed.getArray();
    for (const auto& item : *arr)
    {
        if (auto* obj = item.getDynamicObject())
        {
            double t = obj->getProperty("time");
            double b = obj->getProperty("tempo");
            if (b > 0.0)
                newMarkers.push_back({ t, b });
        }
    }

    // Sort by time
    std::sort(newMarkers.begin(), newMarkers.end(),
              [](const TempoMarker& a, const TempoMarker& b) { return a.timeSeconds < b.timeSeconds; });

    {
        const juce::ScopedLock sl(tempoMapLock);
        tempoMarkers = std::move(newMarkers);
    }
}

double AudioEngine::getTempoAtTime(double timeSeconds) const
{
    const juce::ScopedTryLock stl(tempoMapLock);
    if (!stl.isLocked() || tempoMarkers.empty())
        return tempo;  // Fallback to global BPM

    // Binary search for the last marker at or before timeSeconds
    // std::upper_bound gives first marker AFTER timeSeconds, so decrement by 1
    auto it = std::upper_bound(tempoMarkers.begin(), tempoMarkers.end(), timeSeconds,
                               [](double t, const TempoMarker& m) { return t < m.timeSeconds; });

    if (it == tempoMarkers.begin())
        return tempo;  // Before first marker — use global BPM

    --it;
    return it->bpm;
}

void AudioEngine::clearTempoMarkers()
{
    const juce::ScopedLock sl(tempoMapLock);
    tempoMarkers.clear();
}

//==============================================================================
// Control Surface Callbacks (Phase 3.10)

void AudioEngine::onControlSurfaceTrackVolume(const juce::String& trackId, float value01)
{
    // Convert 0..1 to dB: -60 to +6 dB range
    float db = (value01 <= 0.0f) ? -60.0f : (value01 * 66.0f - 60.0f);
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setVolume(db);
}

void AudioEngine::onControlSurfaceTrackPan(const juce::String& trackId, float valueMinus1To1)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setPan(valueMinus1To1);
}

void AudioEngine::onControlSurfaceTrackMute(const juce::String& trackId, bool muted)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setMute(muted);
}

void AudioEngine::onControlSurfaceTrackSolo(const juce::String& trackId, bool soloed)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        it->second->setSolo(soloed);
        // Recalculate cachedAnySoloed
        bool anySoloed = false;
        for (const auto& pair : trackMap)
            if (pair.second && pair.second->getSolo()) anySoloed = true;
        cachedAnySoloed = anySoloed;
    }
}

void AudioEngine::onControlSurfaceTrackRecordArm(const juce::String& trackId, bool armed)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setRecordArmed(armed);
}

void AudioEngine::onControlSurfaceTransportPlay()
{
    isPlaying = true;
}

void AudioEngine::onControlSurfaceTransportStop()
{
    isPlaying = false;
}

void AudioEngine::onControlSurfaceTransportRecord()
{
    isRecordMode = !isRecordMode.load();
}

void AudioEngine::onControlSurfaceMasterVolume(float value01)
{
    float db = (value01 <= 0.0f) ? -60.0f : (value01 * 66.0f - 60.0f);
    masterVolume = juce::Decibels::decibelsToGain(db);
}

float AudioEngine::getTrackVolume01(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
    {
        float db = it->second->getVolume();
        return (db + 60.0f) / 66.0f; // Map -60..+6 to 0..1
    }
    return 0.0f;
}

float AudioEngine::getTrackPan(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getPan();
    return 0.0f;
}

bool AudioEngine::getTrackMuted(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getMute();
    return false;
}

bool AudioEngine::getTrackSoloed(const juce::String& trackId) const
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getSolo();
    return false;
}

std::vector<juce::String> AudioEngine::getTrackIds() const
{
    return trackOrder;
}

//==============================================================================
// Phase 3.12: Strip Silence
//==============================================================================

juce::var AudioEngine::detectSilentRegions(const juce::String& filePath, double thresholdDb,
                                            double minSilenceMs, double minSoundMs,
                                            double preAttackMs, double postReleaseMs)
{
    auto regions = audioAnalyzer.detectSilentRegions(filePath, thresholdDb,
                                                      minSilenceMs, minSoundMs,
                                                      preAttackMs, postReleaseMs);

    // Get sample rate for time conversion
    std::unique_ptr<juce::AudioFormatReader> reader(
        juce::AudioFormatManager().createReaderFor(juce::File(filePath)));

    // Need a fresh format manager for this
    juce::AudioFormatManager fmgr;
    fmgr.registerBasicFormats();
    reader.reset(fmgr.createReaderFor(juce::File(filePath)));

    double sr = reader ? reader->sampleRate : 44100.0;

    juce::Array<juce::var> result;
    for (const auto& r : regions)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("startTime", r.startSample / sr);
        obj->setProperty("endTime", r.endSample / sr);
        obj->setProperty("startSample", (juce::int64)r.startSample);
        obj->setProperty("endSample", (juce::int64)r.endSample);
        result.add(juce::var(obj));
    }
    return juce::var(result);
}

//==============================================================================
// Phase 3.13: Freeze Track
//==============================================================================

juce::var AudioEngine::freezeTrack(const juce::String& trackId)
{
    auto* resultObj = new juce::DynamicObject();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Track not found");
        return juce::var(resultObj);
    }

    TrackProcessor* track = it->second;

    // Use the playback engine's clips for this track to determine the range
    double startTime = 0.0;
    double endTime = 0.0;
    auto allClips = playbackEngine.getClipSnapshot();
    std::vector<PlaybackEngine::ClipInfo> clipList;
    for (const auto& c : allClips)
        if (c.trackId == trackId)
            clipList.push_back(c);
    if (clipList.empty())
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "No clips on track");
        return juce::var(resultObj);
    }

    // Find the time range of all clips on this track
    startTime = std::numeric_limits<double>::max();
    endTime = 0.0;
    for (const auto& clip : clipList)
    {
        startTime = std::min(startTime, clip.startTime);
        endTime = std::max(endTime, clip.startTime + clip.duration);
    }

    // Add tail for FX (reverb, delay)
    double tailMs = 2000.0; // 2 seconds of tail
    endTime += tailMs / 1000.0;

    // Create freeze file in project audio folder
    juce::File freezeDir = projectAudioFolder.isDirectory()
        ? projectAudioFolder
        : juce::File::getSpecialLocation(juce::File::tempDirectory);
    freezeDir.createDirectory();

    juce::String freezeFileName = "freeze_" + trackId + "_" + juce::String(juce::Time::currentTimeMillis()) + ".wav";
    juce::File freezeFile = freezeDir.getChildFile(freezeFileName);

    // Render this single track offline
    double renderRate = currentSampleRate;
    int renderBlockSize = 512;
    juce::int64 totalSamples = (juce::int64)((endTime - startTime) * renderRate);

    if (totalSamples <= 0)
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Empty render range");
        return juce::var(resultObj);
    }

    // Prepare the track's FX for offline rendering
    track->prepareToPlay(renderRate, renderBlockSize);

    // Create output file
    juce::WavAudioFormat wavFormat;
    auto outputStream = std::make_unique<juce::FileOutputStream>(freezeFile);
    if (outputStream->failedToOpen())
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Failed to create freeze file");
        return juce::var(resultObj);
    }

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(outputStream.get(), renderRate, 2, 24, {}, 0));
    if (!writer)
    {
        resultObj->setProperty("success", false);
        resultObj->setProperty("error", "Failed to create WAV writer");
        return juce::var(resultObj);
    }
    outputStream.release(); // writer owns it now

    // Render loop
    juce::AudioBuffer<float> renderBuffer(2, renderBlockSize);
    juce::AudioBuffer<float> trackBuffer(2, renderBlockSize);
    juce::MidiBuffer midiDummy;

    juce::int64 samplesRendered = 0;
    double samplePos = startTime * renderRate;

    while (samplesRendered < totalSamples)
    {
        int blockSamples = (int)std::min((juce::int64)renderBlockSize, totalSamples - samplesRendered);
        renderBuffer.clear();
        trackBuffer.clear();

        // Fill track buffer from playback engine
        playbackEngine.fillTrackBuffer(trackId, trackBuffer, samplePos / renderRate, blockSamples, renderRate);

        // Process through FX chain
        track->setCurrentBlockPosition(samplePos, renderRate);
        juce::AudioBuffer<float> fxBuffer(trackBuffer.getArrayOfWritePointers(), 2, blockSamples);
        track->processBlock(fxBuffer, midiDummy);

        // Write to output
        writer->writeFromAudioSampleBuffer(fxBuffer, 0, blockSamples);

        samplePos += blockSamples;
        samplesRendered += blockSamples;
    }

    writer.reset(); // Flush

    // Re-prepare track for live playback
    track->prepareToPlay(currentSampleRate, currentBlockSize);

    double duration = endTime - startTime;

    resultObj->setProperty("success", true);
    resultObj->setProperty("filePath", freezeFile.getFullPathName());
    resultObj->setProperty("duration", duration);
    resultObj->setProperty("sampleRate", renderRate);
    resultObj->setProperty("startTime", startTime);

    juce::Logger::writeToLog("FreezeTrack: " + trackId + " -> " + freezeFile.getFullPathName() +
                             " (" + juce::String(duration, 2) + "s)");
    return juce::var(resultObj);
}

bool AudioEngine::unfreezeTrack(const juce::String& trackId)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second)
        return false;

    // Re-prepare track FX for live playback (in case they were in frozen bypass state)
    it->second->prepareToPlay(currentSampleRate, currentBlockSize);

    juce::Logger::writeToLog("UnfreezeTrack: " + trackId);
    return true;
}

// =============================================================================
// Phase 18.10: Clip Gain Envelope
// =============================================================================

void AudioEngine::setClipGainEnvelope(const juce::String& trackId, const juce::String& clipId,
                                       const juce::String& pointsJSON)
{
    // Parse JSON array of {time, gain} points
    auto parsed = juce::JSON::parse(pointsJSON);
    std::vector<PlaybackEngine::GainEnvelopePoint> points;

    if (auto* arr = parsed.getArray())
    {
        for (const auto& item : *arr)
        {
            if (auto* obj = item.getDynamicObject())
            {
                PlaybackEngine::GainEnvelopePoint pt;
                pt.time = static_cast<double>(obj->getProperty("time"));
                pt.gain = static_cast<float>(static_cast<double>(obj->getProperty("gain")));
                points.push_back(pt);
            }
        }
    }

    // Sort by time
    std::sort(points.begin(), points.end(),
              [](const PlaybackEngine::GainEnvelopePoint& a, const PlaybackEngine::GainEnvelopePoint& b) {
                  return a.time < b.time;
              });

    playbackEngine.setClipGainEnvelope(trackId, clipId, points);
    juce::Logger::writeToLog("setClipGainEnvelope: track=" + trackId + " clip=" + clipId +
                             " points=" + juce::String(static_cast<int>(points.size())));
}

// =============================================================================
// Phase 19.7: MIDI Learn
// =============================================================================

void AudioEngine::startMIDILearnForPlugin(const juce::String& trackId, int pluginIndex, int paramIndex)
{
    const juce::ScopedLock sl(midiLearnLock);
    midiLearnTrackId = trackId;
    midiLearnPluginIndex = pluginIndex;
    midiLearnParamIndex = paramIndex;
    midiLearnActive.store(true);
    juce::Logger::writeToLog("MIDI Learn: Started for track=" + trackId +
                             " plugin=" + juce::String(pluginIndex) +
                             " param=" + juce::String(paramIndex));
}

void AudioEngine::stopMIDILearnMode()
{
    midiLearnActive.store(false);
    juce::Logger::writeToLog("MIDI Learn: Stopped");
}

void AudioEngine::clearMIDILearnMapping(int ccNumber)
{
    const juce::ScopedLock sl(midiLearnLock);
    midiLearnMappings.erase(
        std::remove_if(midiLearnMappings.begin(), midiLearnMappings.end(),
                        [ccNumber](const MIDILearnMapping& m) { return m.ccNumber == ccNumber; }),
        midiLearnMappings.end());
    juce::Logger::writeToLog("MIDI Learn: Cleared mapping for CC " + juce::String(ccNumber));
}

juce::var AudioEngine::getMIDILearnMappings()
{
    const juce::ScopedLock sl(midiLearnLock);
    juce::Array<juce::var> result;

    for (const auto& m : midiLearnMappings)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("ccNumber", m.ccNumber);
        obj->setProperty("trackId", m.trackId);
        obj->setProperty("pluginIndex", m.pluginIndex);
        obj->setProperty("paramIndex", m.paramIndex);
        result.add(juce::var(obj));
    }

    return juce::var(result);
}

// =============================================================================
// Phase 19.9: MIDI Import/Export
// =============================================================================

juce::var AudioEngine::importMIDIFile(const juce::String& filePath)
{
    juce::File file(filePath);
    if (!file.existsAsFile())
        return juce::var();

    juce::FileInputStream stream(file);
    if (stream.failedToOpen())
        return juce::var();

    juce::MidiFile midiFile;
    if (!midiFile.readFrom(stream))
        return juce::var();

    // Convert to tick-based time, then convert to seconds
    midiFile.convertTimestampTicksToSeconds();

    auto* result = new juce::DynamicObject();
    result->setProperty("numTracks", midiFile.getNumTracks());
    result->setProperty("ticksPerQuarterNote", midiFile.getTimeFormat());

    juce::Array<juce::var> tracksArray;

    for (int t = 0; t < midiFile.getNumTracks(); ++t)
    {
        const auto* midiTrack = midiFile.getTrack(t);
        if (!midiTrack) continue;

        auto* trackObj = new juce::DynamicObject();
        juce::Array<juce::var> eventsArray;

        for (int i = 0; i < midiTrack->getNumEvents(); ++i)
        {
            const auto* holder = midiTrack->getEventPointer(i);
            const auto& msg = holder->message;

            auto* evtObj = new juce::DynamicObject();
            evtObj->setProperty("timestamp", msg.getTimeStamp());

            if (msg.isNoteOn())
            {
                evtObj->setProperty("type", "noteOn");
                evtObj->setProperty("note", msg.getNoteNumber());
                evtObj->setProperty("velocity", msg.getVelocity());
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isNoteOff())
            {
                evtObj->setProperty("type", "noteOff");
                evtObj->setProperty("note", msg.getNoteNumber());
                evtObj->setProperty("velocity", 0);
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isController())
            {
                evtObj->setProperty("type", "cc");
                evtObj->setProperty("controller", msg.getControllerNumber());
                evtObj->setProperty("value", msg.getControllerValue());
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isPitchWheel())
            {
                evtObj->setProperty("type", "pitchBend");
                evtObj->setProperty("value", msg.getPitchWheelValue());
                evtObj->setProperty("channel", msg.getChannel());
            }
            else if (msg.isTempoMetaEvent())
            {
                evtObj->setProperty("type", "tempo");
                evtObj->setProperty("bpm", 60000000.0 / msg.getTempoSecondsPerQuarterNote() / 1000000.0);
            }
            else
            {
                continue;
            }

            eventsArray.add(juce::var(evtObj));
        }

        trackObj->setProperty("events", eventsArray);
        tracksArray.add(juce::var(trackObj));
    }

    result->setProperty("tracks", tracksArray);
    juce::Logger::writeToLog("importMIDIFile: " + filePath + " - " +
                             juce::String(midiFile.getNumTracks()) + " tracks");
    return juce::var(result);
}

bool AudioEngine::exportMIDIFile(const juce::String& trackId, const juce::String& clipId,
                                  const juce::String& eventsJSON, const juce::String& outputPath,
                                  double clipTempo)
{
    juce::ignoreUnused(trackId, clipId);

    if (clipTempo <= 0.0) clipTempo = 120.0;

    juce::MidiFile midiFile;
    midiFile.setTicksPerQuarterNote(480);

    juce::MidiMessageSequence sequence;

    // Add tempo event
    sequence.addEvent(juce::MidiMessage::tempoMetaEvent(
        static_cast<int>(60000000.0 / clipTempo)), 0.0);

    // Parse events JSON
    auto parsed = juce::JSON::parse(eventsJSON);
    if (auto* arr = parsed.getArray())
    {
        for (const auto& item : *arr)
        {
            auto* obj = item.getDynamicObject();
            if (!obj) continue;

            juce::String eventType = obj->getProperty("type").toString();
            double timestamp = static_cast<double>(obj->getProperty("timestamp"));
            // Convert seconds to ticks: ticks = seconds * (BPM / 60) * ticksPerQN
            double ticks = timestamp * (clipTempo / 60.0) * 480.0;

            if (eventType == "noteOn")
            {
                int note = static_cast<int>(obj->getProperty("note"));
                int velocity = static_cast<int>(obj->getProperty("velocity"));
                int channel = obj->hasProperty("channel") ? static_cast<int>(obj->getProperty("channel")) : 1;
                sequence.addEvent(juce::MidiMessage::noteOn(channel, note, static_cast<juce::uint8>(velocity)), ticks);
            }
            else if (eventType == "noteOff")
            {
                int note = static_cast<int>(obj->getProperty("note"));
                int channel = obj->hasProperty("channel") ? static_cast<int>(obj->getProperty("channel")) : 1;
                sequence.addEvent(juce::MidiMessage::noteOff(channel, note), ticks);
            }
            else if (eventType == "cc")
            {
                int controller = static_cast<int>(obj->getProperty("controller"));
                int value = static_cast<int>(obj->getProperty("value"));
                int channel = obj->hasProperty("channel") ? static_cast<int>(obj->getProperty("channel")) : 1;
                sequence.addEvent(juce::MidiMessage::controllerEvent(channel, controller, value), ticks);
            }
        }
    }

    sequence.updateMatchedPairs();
    midiFile.addTrack(sequence);

    juce::File outFile(outputPath);
    outFile.deleteFile();
    std::unique_ptr<juce::FileOutputStream> outputStream(outFile.createOutputStream());
    if (!outputStream)
        return false;

    bool success = midiFile.writeTo(*outputStream);
    juce::Logger::writeToLog("exportMIDIFile: " + outputPath + " success=" + juce::String(success ? "true" : "false"));
    return success;
}

// =============================================================================
// Phase 19.14: Plugin Presets
// =============================================================================

juce::var AudioEngine::getPluginPresets(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::ignoreUnused(trackId, fxIndex, isInputFX);

    // List preset files from the presets directory
    juce::File presetsDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                                .getChildFile("Studio13").getChildFile("Presets");

    juce::Array<juce::var> result;
    if (presetsDir.isDirectory())
    {
        auto files = presetsDir.findChildFiles(juce::File::findFiles, true, "*.s13preset");
        for (const auto& file : files)
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("name", file.getFileNameWithoutExtension());
            obj->setProperty("path", file.getFullPathName());
            result.add(juce::var(obj));
        }
    }

    return juce::var(result);
}

bool AudioEngine::loadPluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                    const juce::String& presetPath)
{
    juce::File presetFile(presetPath);
    if (!presetFile.existsAsFile())
        return false;

    auto xml = juce::XmlDocument::parse(presetFile);
    if (!xml)
        return false;

    juce::String base64State = xml->getStringAttribute("state");
    if (base64State.isEmpty())
        return false;

    return setPluginState(trackId, fxIndex, isInputFX, base64State);
}

bool AudioEngine::savePluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                                    const juce::String& presetPath, const juce::String& presetName)
{
    juce::String base64State = getPluginState(trackId, fxIndex, isInputFX);
    if (base64State.isEmpty())
        return false;

    // Create XML structure
    juce::XmlElement xml("S13Preset");
    xml.setAttribute("name", presetName);
    xml.setAttribute("state", base64State);
    xml.setAttribute("version", "1.0");

    juce::File outFile(presetPath);
    outFile.getParentDirectory().createDirectory();

    bool success = xml.writeTo(outFile);
    juce::Logger::writeToLog("savePluginPreset: " + presetPath + " success=" + juce::String(success ? "true" : "false"));
    return success;
}

// =============================================================================
// Phase 19.16: A/B Comparison
// =============================================================================

bool AudioEngine::storePluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                                      const juce::String& slot)
{
    juce::String base64State = getPluginState(trackId, fxIndex, isInputFX);
    if (base64State.isEmpty())
        return false;

    juce::String key = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0) + ":" + slot;
    pluginABStates[key] = base64State;

    juce::String slotKey = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0);
    pluginActiveSlots[slotKey] = slot;

    juce::Logger::writeToLog("storePluginABState: " + key);
    return true;
}

bool AudioEngine::loadPluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                                     const juce::String& slot)
{
    juce::String key = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0) + ":" + slot;
    auto it = pluginABStates.find(key);
    if (it == pluginABStates.end())
        return false;

    bool ok = setPluginState(trackId, fxIndex, isInputFX, it->second);
    if (ok)
    {
        juce::String slotKey = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0);
        pluginActiveSlots[slotKey] = slot;
    }

    juce::Logger::writeToLog("loadPluginABState: " + key + " ok=" + juce::String(ok ? "true" : "false"));
    return ok;
}

juce::String AudioEngine::getPluginActiveSlot(const juce::String& trackId, int fxIndex, bool isInputFX)
{
    juce::String slotKey = trackId + ":" + juce::String(fxIndex) + ":" + juce::String(isInputFX ? 1 : 0);
    auto it = pluginActiveSlots.find(slotKey);
    return (it != pluginActiveSlots.end()) ? it->second : juce::String("A");
}

// =============================================================================
// Phase 20.5: Session Archive
// =============================================================================

bool AudioEngine::archiveSession(const juce::String& projectJsonPath, const juce::String& outputZipPath)
{
    juce::File projectFile(projectJsonPath);
    if (!projectFile.existsAsFile())
        return false;

    juce::File zipFile(outputZipPath);
    zipFile.deleteFile();

    auto outputStream = std::make_unique<juce::FileOutputStream>(zipFile);
    if (outputStream->failedToOpen())
        return false;

    juce::ZipFile::Builder builder;

    // Add the project JSON file
    builder.addFile(projectFile, 9, projectFile.getFileName());

    // Parse project JSON to find referenced media files
    juce::String jsonContent = projectFile.loadFileAsString();
    auto projectData = juce::JSON::parse(jsonContent);

    // Collect all file paths from clip data
    std::set<juce::String> mediaFiles;
    if (auto* tracksArr = projectData.getProperty("tracks", juce::var()).getArray())
    {
        for (const auto& trackVar : *tracksArr)
        {
            if (auto* clipsArr = trackVar.getProperty("clips", juce::var()).getArray())
            {
                for (const auto& clipVar : *clipsArr)
                {
                    juce::String fp = clipVar.getProperty("filePath", "").toString();
                    if (fp.isNotEmpty())
                        mediaFiles.insert(fp);
                }
            }
        }
    }

    // Add media files to archive
    juce::File projectDir = projectFile.getParentDirectory();
    for (const auto& mediaPath : mediaFiles)
    {
        juce::File mediaFile(mediaPath);
        if (mediaFile.existsAsFile())
        {
            // Store relative to project directory if possible
            juce::String relativePath = mediaFile.getRelativePathFrom(projectDir);
            builder.addFile(mediaFile, 9, "media/" + relativePath);
        }
    }

    bool success = builder.writeToStream(*outputStream, nullptr);
    outputStream.reset();

    juce::Logger::writeToLog("archiveSession: " + outputZipPath +
                             " success=" + juce::String(success ? "true" : "false") +
                             " files=" + juce::String(static_cast<int>(mediaFiles.size()) + 1));
    return success;
}

bool AudioEngine::unarchiveSession(const juce::String& zipPath, const juce::String& outputDir)
{
    juce::File zipFile(zipPath);
    if (!zipFile.existsAsFile())
        return false;

    juce::File outDir(outputDir);
    outDir.createDirectory();

    juce::ZipFile zip(zipFile);
    if (zip.getNumEntries() == 0)
        return false;

    auto result = zip.uncompressTo(outDir);
    bool success = (result.wasOk());

    juce::Logger::writeToLog("unarchiveSession: " + zipPath + " -> " + outputDir +
                             " entries=" + juce::String(zip.getNumEntries()) +
                             " success=" + juce::String(success ? "true" : "false"));
    return success;
}

// =============================================================================
// Phase 20.11: Spectrum Analyzer
// =============================================================================

juce::var AudioEngine::getSpectrumData()
{
    const juce::ScopedLock sl(spectrumLock);

    juce::Array<juce::var> result;
    if (!spectrumReady)
        return juce::var(result);

    // Return first half of FFT (positive frequencies only): FFT_SIZE/2 + 1 bins
    int numBins = FFT_SIZE / 2 + 1;
    for (int i = 0; i < numBins; ++i)
        result.add(static_cast<double>(spectrumOutputBuffer[i]));

    return juce::var(result);
}

// =============================================================================
// Phase 20.12: Built-in FX Oversampling
// =============================================================================

bool AudioEngine::setBuiltInFXOversampling(const juce::String& trackId, int fxIndex, bool isInputFX, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end())
        return false;

    auto* track = it->second;
    juce::AudioProcessor* proc = nullptr;

    if (isInputFX)
        proc = track->getInputFXProcessor(fxIndex);
    else
        proc = track->getTrackFXProcessor(fxIndex);

    if (!proc)
        return false;

    // Check if it's a built-in effect that inherits from S13BuiltInEffect
    if (auto* builtIn = dynamic_cast<S13BuiltInEffect*>(proc))
    {
        builtIn->setOversamplingEnabled(enabled);
        juce::Logger::writeToLog("setBuiltInFXOversampling: " + trackId + " fx=" + juce::String(fxIndex)
                                 + " isInput=" + juce::String(isInputFX ? "true" : "false")
                                 + " enabled=" + juce::String(enabled ? "true" : "false"));
        return true;
    }

    // Check if it's an S13Saturator (doesn't inherit from S13BuiltInEffect)
    if (auto* saturator = dynamic_cast<S13Saturator*>(proc))
    {
        saturator->setOversamplingEnabled(enabled);
        juce::Logger::writeToLog("setBuiltInFXOversampling (Saturator): " + trackId + " fx=" + juce::String(fxIndex)
                                 + " enabled=" + juce::String(enabled ? "true" : "false"));
        return true;
    }

    return false;
}

// ========== Channel Strip EQ (Phase 19.18) ==========

void AudioEngine::setChannelStripEQEnabled(const juce::String& trackId, bool enabled)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setChannelStripEQEnabled(enabled);
}

void AudioEngine::setChannelStripEQParam(const juce::String& trackId, int paramIndex, float value)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        it->second->setChannelStripEQParam(paramIndex, value);
}

float AudioEngine::getChannelStripEQParam(const juce::String& trackId, int paramIndex)
{
    auto it = trackMap.find(trackId);
    if (it != trackMap.end() && it->second)
        return it->second->getChannelStripEQParam(paramIndex);
    return 0.0f;
}

// ============================================================================
// Pitch Corrector bridge methods
// ============================================================================

// (findPitchCorrector defined inline in methods below using trackMap)

juce::var AudioEngine::getPitchCorrectorData(const juce::String& trackId, int fxIndex)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second) return juce::var();
    juce::AudioProcessor* proc = (fxIndex >= 0 && fxIndex < it->second->getNumTrackFX())
                                  ? it->second->getTrackFXProcessor(fxIndex) : nullptr;
    auto* pc = dynamic_cast<S13PitchCorrector*>(proc);
    if (!pc) return juce::var();

    auto data = pc->getCurrentPitchData();
    auto& mapper = pc->getMapper();

    juce::DynamicObject::Ptr obj = new juce::DynamicObject();
    obj->setProperty("detectedPitch", static_cast<double>(data.detectedHz));
    obj->setProperty("correctedPitch", static_cast<double>(data.correctedHz));
    obj->setProperty("confidence", static_cast<double>(data.confidence));
    obj->setProperty("centsDeviation", static_cast<double>(data.centsDeviation));
    obj->setProperty("noteName", data.noteName);

    // Include current parameter values for UI sync
    obj->setProperty("key", mapper.getKey());
    obj->setProperty("scale", static_cast<int>(mapper.getScale()));
    obj->setProperty("retuneSpeed", static_cast<double>(mapper.getRetuneSpeed()));
    obj->setProperty("humanize", static_cast<double>(mapper.getHumanize()));
    obj->setProperty("transpose", mapper.getTranspose());
    obj->setProperty("correctionStrength", static_cast<double>(mapper.getCorrectionStrength()));
    obj->setProperty("formantCorrection", mapper.getFormantCorrection());
    obj->setProperty("formantShift", static_cast<double>(mapper.getFormantShift()));
    obj->setProperty("mix", static_cast<double>(pc->mix.load()));
    obj->setProperty("midiOutput", pc->midiOutputEnabled.load() > 0.5f);
    obj->setProperty("midiChannel", static_cast<int>(pc->midiOutputChannel.load()));

    // Note enables
    juce::Array<juce::var> noteEnables;
    for (int i = 0; i < 12; ++i)
        noteEnables.add(mapper.isNoteEnabled(i));
    obj->setProperty("noteEnables", noteEnables);

    return juce::var(obj.get());
}

void AudioEngine::setPitchCorrectorParam(const juce::String& trackId, int fxIndex,
                                          const juce::String& param, float value)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second) return;
    juce::AudioProcessor* proc = (fxIndex >= 0 && fxIndex < it->second->getNumTrackFX())
                                  ? it->second->getTrackFXProcessor(fxIndex) : nullptr;
    auto* pc = dynamic_cast<S13PitchCorrector*>(proc);
    if (!pc) return;

    auto& mapper = pc->getMapper();

    if (param == "key")              mapper.setKey(static_cast<int>(value));
    else if (param == "scale")       mapper.setScale(static_cast<PitchMapper::Scale>(static_cast<int>(value)));
    else if (param == "retuneSpeed") mapper.setRetuneSpeed(value);
    else if (param == "humanize")    mapper.setHumanize(value);
    else if (param == "transpose")   mapper.setTranspose(static_cast<int>(value));
    else if (param == "correctionStrength") mapper.setCorrectionStrength(value);
    else if (param == "formantCorrection")  mapper.setFormantCorrection(value > 0.5f);
    else if (param == "formantShift")       mapper.setFormantShift(value);
    else if (param == "mix")         pc->mix.store(juce::jlimit(0.0f, 1.0f, value));
    else if (param == "bypass")      pc->bypass.store(value > 0.5f ? 1.0f : 0.0f);
    else if (param == "sensitivity") pc->sensitivity.store(value);
    else if (param == "midiOutput")  pc->midiOutputEnabled.store(value > 0.5f ? 1.0f : 0.0f);
    else if (param == "midiChannel") pc->midiOutputChannel.store(juce::jlimit(1.0f, 16.0f, value));
    else if (param.startsWith("noteEnable_"))
    {
        int noteIdx = param.substring(11).getIntValue();
        mapper.setNoteEnabled(noteIdx, value > 0.5f);
    }
}

juce::var AudioEngine::getPitchHistory(const juce::String& trackId, int fxIndex, int numFrames)
{
    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second) return juce::Array<juce::var>();
    juce::AudioProcessor* proc = (fxIndex >= 0 && fxIndex < it->second->getNumTrackFX())
                                  ? it->second->getTrackFXProcessor(fxIndex) : nullptr;
    auto* pc = dynamic_cast<S13PitchCorrector*>(proc);
    if (!pc) return juce::Array<juce::var>();

    auto frames = pc->getPitchHistory(numFrames);

    juce::Array<juce::var> result;
    for (const auto& f : frames)
    {
        juce::DynamicObject::Ptr frame = new juce::DynamicObject();
        frame->setProperty("detected", static_cast<double>(f.detectedMidi));
        frame->setProperty("corrected", static_cast<double>(f.correctedMidi));
        frame->setProperty("confidence", static_cast<double>(f.confidence));
        result.add(juce::var(frame.get()));
    }
    return result;
}

// ============================================================================
// Pitch Corrector — Graphical Mode bridge methods
// ============================================================================

juce::var AudioEngine::analyzePitchContour(const juce::String& trackId, const juce::String& clipId)
{
    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;

    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }

    if (!foundClip || !foundClip->audioFile.existsAsFile())
        return juce::var();

    // Read audio file
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (!reader) return juce::var();

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return juce::var();

    // Read and mix to mono
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    // Run analysis
    PitchAnalyzer analyzer;
    auto result = analyzer.analyzeClip(mono.getReadPointer(0), numSamples,
                                        reader->sampleRate, clipId);

    return PitchAnalyzer::resultToJSON(result);
}

juce::var AudioEngine::analyzePitchContourDirect(const juce::String& filePath, double offset, double duration, const juce::String& clipId)
{
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("analyzePitchContourDirect: File not found: " + filePath);
        return juce::var();
    }

    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(audioFile));
    if (!reader) return juce::var();

    int startSample = static_cast<int>(offset * reader->sampleRate);
    int numSamples = static_cast<int>(duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return juce::var();

    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    PitchAnalyzer analyzer;
    auto result = analyzer.analyzeClip(mono.getReadPointer(0), numSamples,
                                        reader->sampleRate, clipId);

    return PitchAnalyzer::resultToJSON(result);
}

juce::var AudioEngine::applyPitchCorrection(const juce::String& trackId, const juce::String& clipId,
                                              const juce::var& notesJson, const juce::var& framesJson)
{
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }
    if (!foundClip)
    {
        juce::Logger::writeToLog("applyPitchCorrection: clip not found in playback engine for clipId=" + clipId);
        return false;
    }

    // Always read from the ORIGINAL audio file so successive edits don't compound.
    // originalAudioFile is set once in addClip and never changed by replaceClipAudioFile.
    juce::File sourceFile = foundClip->originalAudioFile.existsAsFile()
                          ? foundClip->originalAudioFile
                          : foundClip->audioFile;

    if (!sourceFile.existsAsFile())
    {
        juce::Logger::writeToLog("applyPitchCorrection: source file not found: " + sourceFile.getFullPathName());
        return false;
    }

    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(sourceFile));
    if (!reader) return false;

    // Use originalOffset (not offset) when reading from the original file.
    // After replaceClipAudioFile, offset is reset to 0 (for the corrected file),
    // but originalOffset preserves where the clip data starts in the original file.
    double effectiveOffset = (sourceFile == foundClip->originalAudioFile)
        ? foundClip->originalOffset
        : foundClip->offset;
    int clipStartSample = static_cast<int>(effectiveOffset * reader->sampleRate);
    int clipNumSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    clipNumSamples = std::min(clipNumSamples, static_cast<int>(reader->lengthInSamples) - clipStartSample);
    if (clipNumSamples <= 0) return false;

    const double sr = reader->sampleRate;
    const double clipDuration = static_cast<double>(clipNumSamples) / sr;

    // Parse notes first so we can limit processing to only the edited region.
    auto editedNotes = PitchAnalyzer::notesFromJSON(notesJson);

    // Find the time range covered by ACTUALLY EDITED notes only (correctedPitch != detectedPitch).
    // WORLD vocoder is NOT transparent at ratio=1.0 — it degrades audio quality even when
    // no pitch change is requested.  By limiting the window to edited notes only, we avoid
    // resynthesizing the entire clip through WORLD when only one note was changed.
    const float editThreshold = 0.01f; // semitones
    double notesStartSec = clipDuration;
    double notesEndSec   = 0.0;
    bool anyEdited = false;
    for (const auto& n : editedNotes)
    {
        if (std::abs(n.correctedPitch - n.detectedPitch) > editThreshold
            || std::abs(n.gain) > 0.01f
            || std::abs(n.formantShift) > 0.01f
            || n.driftCorrectionAmount > 0.01f
            || std::abs(n.vibratoDepth - 1.0f) > 0.01f)
        {
            notesStartSec = std::min(notesStartSec, static_cast<double>(n.startTime));
            notesEndSec   = std::max(notesEndSec,   static_cast<double>(n.endTime));
            anyEdited = true;
        }
    }

    // If no notes were actually edited, restore the original audio file
    // (in case a previous correction was applied and the user moved notes back).
    if (!anyEdited)
    {
        juce::Logger::writeToLog("applyPitchCorrection: no notes actually edited, restoring original");
        if (foundClip->originalAudioFile.existsAsFile()
            && foundClip->audioFile != foundClip->originalAudioFile)
        {
            playbackEngine.replaceClipAudioFile(clipId, foundClip->originalAudioFile);
        }
        juce::DynamicObject::Ptr resultObj = new juce::DynamicObject();
        resultObj->setProperty("outputFile", foundClip->originalAudioFile.getFullPathName());
        resultObj->setProperty("success", true);
        resultObj->setProperty("restored", true);
        return juce::var(resultObj.get());
    }

    {
        int editedCount = 0;
        for (const auto& n : editedNotes)
            if (std::abs(n.correctedPitch - n.detectedPitch) > editThreshold) ++editedCount;
        juce::Logger::writeToLog(juce::String("applyPitchCorrection: ") + juce::String(editedCount)
            + " of " + juce::String(static_cast<int>(editedNotes.size()))
            + " notes edited, processing full clip (" + juce::String(clipNumSamples) + " samples)");
    }

    const int numChannels = static_cast<int>(reader->numChannels);

    // Read the FULL clip (all channels) — we will stitch the corrected window back in-place.
    juce::AudioBuffer<float> clipBuffer(numChannels, clipNumSamples);
    reader->read(&clipBuffer, 0, clipNumSamples, static_cast<juce::int64>(clipStartSample), true, true);

    // Use frontend analysis frames if provided (eliminates re-analysis mismatch).
    // Fall back to local analysis only if frames weren't sent.
    PitchAnalyzer::AnalysisResult analysis;
    analysis.clipId = clipId;
    analysis.sampleRate = sr;

    if (framesJson.getDynamicObject() != nullptr)
    {
        analysis.frames = PitchAnalyzer::framesFromJSON(framesJson);
        // Frontend frames use clip-relative times. Adjust to window-relative below.
        // The hopSize isn't critical here — estimate from frame spacing.
        if (analysis.frames.size() >= 2)
            analysis.hopSize = static_cast<int>((analysis.frames[1].time - analysis.frames[0].time) * sr);
        else
            analysis.hopSize = 512;
        juce::Logger::writeToLog("applyPitchCorrection: using " + juce::String(static_cast<int>(analysis.frames.size()))
            + " frontend frames (no re-analysis)");
    }
    else
    {
        // Fallback: create mono mix and re-analyze (legacy path)
        juce::AudioBuffer<float> monoBuffer(1, clipNumSamples);
        monoBuffer.clear();
        for (int ch = 0; ch < numChannels; ++ch)
            monoBuffer.addFrom(0, 0, clipBuffer, ch, 0, clipNumSamples, 1.0f / static_cast<float>(numChannels));

        PitchAnalyzer analyzer;
        analysis = analyzer.analyzeClip(monoBuffer.getReadPointer(0),
                                        clipNumSamples, sr, clipId);
        juce::Logger::writeToLog("applyPitchCorrection: no frontend frames, re-analyzed locally");
    }

    // Process only the EDITED WINDOW (with 1s padding each side), not the full clip.
    // Full-clip SMS on a 214s clip takes ~40s; the edited window is typically 1-3s.
    // We splice the corrected window back into the full clip with a cosine crossfade.
    {
        // Build window bounds around the edited region.
        const double kPaddingSec = 1.0;
        double windowStartSec = std::max (0.0, notesStartSec - kPaddingSec);
        double windowEndSec   = std::min (clipDuration, notesEndSec + kPaddingSec);
        int windowStartSample = static_cast<int> (windowStartSec * sr);
        int windowNumSamples  = std::min (clipNumSamples - windowStartSample,
                                          static_cast<int> ((windowEndSec - windowStartSec) * sr));

        juce::Logger::writeToLog ("applyPitchCorrection: window ["
            + juce::String (windowStartSec, 3) + "s - " + juce::String (windowEndSec, 3) + "s], "
            + juce::String (windowNumSamples) + " samples (clip=" + juce::String (clipNumSamples) + ")");

        if (windowNumSamples > 256)
        {
            // Extract the window into its own buffer.
            juce::AudioBuffer<float> windowBuffer (numChannels, windowNumSamples);
            for (int ch = 0; ch < numChannels; ++ch)
                windowBuffer.copyFrom (ch, 0, clipBuffer, ch, windowStartSample, windowNumSamples);

            // Filter analysis frames to the window and shift their times to window-relative.
            PitchAnalyzer::AnalysisResult windowAnalysis = analysis;
            windowAnalysis.frames.clear();
            for (const auto& f : analysis.frames)
            {
                double ft = static_cast<double> (f.time);
                if (ft >= windowStartSec - 0.5 && ft <= windowEndSec + 0.5)
                {
                    auto wf = f;
                    wf.time = static_cast<float> (ft - windowStartSec);
                    windowAnalysis.frames.push_back (wf);
                }
            }

            // Shift note times to window-relative.
            auto windowNotes = editedNotes;
            for (auto& n : windowNotes)
            {
                n.startTime = static_cast<float> (static_cast<double> (n.startTime) - windowStartSec);
                n.endTime   = static_cast<float> (static_cast<double> (n.endTime)   - windowStartSec);
            }

            PitchResynthesizer resynth;
            std::vector<const float*> channelPtrs (static_cast<size_t> (numChannels));
            for (int ch = 0; ch < numChannels; ++ch)
                channelPtrs[static_cast<size_t> (ch)] = windowBuffer.getReadPointer (ch);

            auto correctedWindow = resynth.processMultiChannel (
                channelPtrs.data(), numChannels, windowNumSamples, sr,
                windowAnalysis.frames, windowNotes,
                PitchResynthesizer::PitchEngine::Signalsmith);

            juce::Logger::writeToLog ("applyPitchCorrection: processMultiChannel returned "
                + juce::String (correctedWindow.empty() ? 0 : static_cast<int> (correctedWindow[0].size()))
                + " samples (window=" + juce::String (windowNumSamples) + ")");

            // RMS comparison: log input vs output amplitude to diagnose any scaling issues
            if (!correctedWindow.empty() && windowNumSamples > 0)
            {
                float inputRMS = 0.0f, outputRMS = 0.0f, outputPeak = 0.0f;
                int ch0Samples = std::min (windowNumSamples, static_cast<int> (correctedWindow[0].size()));
                for (int i = 0; i < windowNumSamples; ++i)
                    inputRMS += windowBuffer.getSample (0, i) * windowBuffer.getSample (0, i);
                for (int i = 0; i < ch0Samples; ++i)
                {
                    float s = correctedWindow[0][static_cast<size_t> (i)];
                    outputRMS += s * s;
                    outputPeak = std::max (outputPeak, std::abs (s));
                }
                inputRMS  = std::sqrt (inputRMS  / static_cast<float> (windowNumSamples));
                outputRMS = std::sqrt (outputRMS / static_cast<float> (ch0Samples));
                juce::Logger::writeToLog ("applyPitchCorrection: window RMS in="
                    + juce::String (inputRMS, 4) + " out=" + juce::String (outputRMS, 4)
                    + " outPeak=" + juce::String (outputPeak, 4)
                    + " ratio=" + juce::String (inputRMS > 1e-8f ? outputRMS / inputRMS : 0.0f, 3));
            }

            // Blend corrected window into full clip buffer with cosine crossfade at splice points.
            // The fade is applied WITHIN the window so we never need the pre-window original samples.
            const int xfadeLen = std::min (512, windowNumSamples / 4);
            for (int ch = 0; ch < numChannels; ++ch)
            {
                if (static_cast<size_t> (ch) >= correctedWindow.size()) continue;
                const auto& corrected = correctedWindow[static_cast<size_t> (ch)];
                int copyLen = std::min (windowNumSamples, static_cast<int> (corrected.size()));
                for (int i = 0; i < copyLen; ++i)
                {
                    float blend = 1.0f;
                    // Fade from original to corrected at window entry.
                    if (i < xfadeLen && windowStartSample > 0)
                        blend = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                                                           * static_cast<float> (i) / static_cast<float> (xfadeLen)));
                    // Fade from corrected back to original at window exit.
                    int distFromEnd = copyLen - 1 - i;
                    if (distFromEnd < xfadeLen && (windowStartSample + copyLen) < clipNumSamples)
                    {
                        float fo = 0.5f * (1.0f - std::cos (juce::MathConstants<float>::pi
                                                              * static_cast<float> (distFromEnd) / static_cast<float> (xfadeLen)));
                        blend = std::min (blend, fo);
                    }
                    float orig = clipBuffer.getSample (ch, windowStartSample + i);
                    float corr = corrected[static_cast<size_t> (i)];
                    clipBuffer.setSample (ch, windowStartSample + i, orig * (1.0f - blend) + corr * blend);
                }
            }
        }
    }

    // Write the FULL clip (with corrected window stitched in) to a unique output file.
    // Using a fixed name caused the playback engine's reader to read from a file being
    // truncated by a concurrent job — producing garbled audio.
    // A monotonic counter ensures each job writes to a different file slot.
    static std::atomic<int> s_pitchCorrSeq { 0 };
    int seq = s_pitchCorrSeq.fetch_add(1) & 0x1F; // 32 rotating slots
    juce::File outputFile = sourceFile.getSiblingFile(
        sourceFile.getFileNameWithoutExtension() + "_pc" + juce::String(seq) + ".wav");

    // Delete the old file first to prevent stale data if the write partially fails.
    // Without this, createOutputStream may fail to fully overwrite on some OS/filesystem combos.
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> fileStream(outputFile.createOutputStream());
    if (!fileStream) return false;

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileStream.get(), reader->sampleRate,
                                   static_cast<unsigned int>(numChannels), 32, {}, 0));
    if (!writer) return false;
    fileStream.release(); // writer takes ownership

    writer->writeFromAudioSampleBuffer(clipBuffer, 0, clipNumSamples);
    writer.reset();

    // Hot-swap the clip in the playback engine so the next playback uses the corrected audio
    playbackEngine.replaceClipAudioFile(clipId, outputFile);

    juce::DynamicObject::Ptr resultObj = new juce::DynamicObject();
    resultObj->setProperty("outputFile", outputFile.getFullPathName());
    resultObj->setProperty("success", true);
    return juce::var(resultObj.get());
}

juce::var AudioEngine::previewPitchCorrection(const juce::String& trackId, const juce::String& clipId,
                                                const juce::var& notesJson)
{
    return applyPitchCorrection(trackId, clipId, notesJson);
}

// =============================================================================
// Phase 6: Polyphonic Pitch Detection
// =============================================================================

bool AudioEngine::isPolyphonicDetectionAvailable() const
{
#if S13_HAS_ONNXRUNTIME
    return true;
#else
    return false;
#endif
}

juce::var AudioEngine::analyzePolyphonic(const juce::String& trackId, const juce::String& clipId)
{
    // Lazy-load the ONNX model on first use
    if (! polyModelLoadAttempted)
    {
        polyModelLoadAttempted = true;
        auto exeDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
        auto modelFile = exeDir.getChildFile("models").getChildFile("basic_pitch_nmp.onnx");
        if (! modelFile.existsAsFile())
        {
            juce::Logger::writeToLog("analyzePolyphonic: Model not found at " + modelFile.getFullPathName());
            // Try alternative location
            modelFile = exeDir.getChildFile("basic_pitch_nmp.onnx");
        }
        polyPitchDetector.loadModel(modelFile);
    }

    if (! polyPitchDetector.isModelLoaded())
    {
        auto errObj = std::make_unique<juce::DynamicObject>();
        errObj->setProperty("error", "Polyphonic model not loaded. Place basic_pitch_nmp.onnx in the models/ directory.");
        errObj->setProperty("clipId", clipId);
        errObj->setProperty("notes", juce::Array<juce::var>());
        return juce::var(errObj.release());
    }

    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }

    if (! foundClip || ! foundClip->audioFile.existsAsFile())
        return juce::var();

    // Read audio file
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (! reader) return juce::var();

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return juce::var();

    // Read and mix to mono
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    // Run polyphonic analysis
    auto result = polyPitchDetector.analyze(mono.getReadPointer(0), numSamples,
                                             reader->sampleRate, clipId);

    // Cache result for reuse in polyphonic editing
    polyAnalysisCache[clipId] = result;

    return PolyPitchDetector::resultToJSON(result);
}

juce::var AudioEngine::extractMidiFromAudio(const juce::String& trackId, const juce::String& clipId)
{
    // First run polyphonic analysis
    auto analysisJson = analyzePolyphonic(trackId, clipId);
    if (! analysisJson.isObject())
        return juce::var();

    // Return the analysis result — the frontend will create the MIDI track/clip
    // from the note data (since track creation is a frontend-managed operation)
    return analysisJson;
}

// =============================================================================
// Phase 7: Polyphonic Pitch Editing
// =============================================================================

juce::var AudioEngine::applyPolyPitchCorrection(const juce::String& trackId,
                                                  const juce::String& clipId,
                                                  const juce::var& editedNotesJson)
{
    // Check if we have a cached analysis for this clip
    auto cacheIt = polyAnalysisCache.find(clipId);
    if (cacheIt == polyAnalysisCache.end())
    {
        // Need to run analysis first
        analyzePolyphonic(trackId, clipId);
        cacheIt = polyAnalysisCache.find(clipId);
        if (cacheIt == polyAnalysisCache.end())
            return PolyResynthesizer::resultToJSON("", false);
    }

    const auto& analysisResult = cacheIt->second;

    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }
    if (!foundClip || !foundClip->audioFile.existsAsFile())
        return PolyResynthesizer::resultToJSON("", false);

    // Read audio
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (!reader) return PolyResynthesizer::resultToJSON("", false);

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return PolyResynthesizer::resultToJSON("", false);

    // Read and mix to mono
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    // Parse edited notes from JSON
    std::vector<PolyResynthesizer::EditedNote> editedNotes;
    if (auto* arr = editedNotesJson.getArray())
    {
        for (const auto& noteVar : *arr)
        {
            PolyResynthesizer::EditedNote edit;
            edit.id = noteVar.getProperty("id", "").toString();
            edit.originalPitch = static_cast<float>(static_cast<double>(noteVar.getProperty("originalPitch", 0.0)));
            edit.correctedPitch = static_cast<float>(static_cast<double>(noteVar.getProperty("correctedPitch", 0.0)));
            edit.formantShift = static_cast<float>(static_cast<double>(noteVar.getProperty("formantShift", 0.0)));
            edit.gain = static_cast<float>(static_cast<double>(noteVar.getProperty("gain", 0.0)));
            editedNotes.push_back(edit);
        }
    }

    // Run polyphonic resynthesis
    auto corrected = polyResynthesizer.process(
        mono.getReadPointer(0), numSamples, reader->sampleRate,
        analysisResult.notes, editedNotes);

    if (corrected.empty())
        return PolyResynthesizer::resultToJSON("", false);

    // Write corrected audio to a new file
    juce::File outputFile = foundClip->audioFile.getSiblingFile(
        foundClip->audioFile.getFileNameWithoutExtension() + "_polycorrected.wav");

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> fileStream(outputFile.createOutputStream());
    if (!fileStream) return PolyResynthesizer::resultToJSON("", false);

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileStream.get(), reader->sampleRate, 1, 32, {}, 0));
    if (!writer) return PolyResynthesizer::resultToJSON("", false);
    fileStream.release(); // writer takes ownership

    juce::AudioBuffer<float> outBuffer(1, numSamples);
    outBuffer.copyFrom(0, 0, corrected.data(), numSamples);
    writer->writeFromAudioSampleBuffer(outBuffer, 0, numSamples);
    writer.reset();

    return PolyResynthesizer::resultToJSON(outputFile.getFullPathName(), true);
}

juce::var AudioEngine::soloPolyNote(const juce::String& trackId,
                                     const juce::String& clipId,
                                     const juce::String& noteId)
{
    // Check cache
    auto cacheIt = polyAnalysisCache.find(clipId);
    if (cacheIt == polyAnalysisCache.end())
    {
        analyzePolyphonic(trackId, clipId);
        cacheIt = polyAnalysisCache.find(clipId);
        if (cacheIt == polyAnalysisCache.end())
            return PolyResynthesizer::resultToJSON("", false);
    }

    const auto& analysisResult = cacheIt->second;

    // Find clip audio
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }
    if (!foundClip || !foundClip->audioFile.existsAsFile())
        return PolyResynthesizer::resultToJSON("", false);

    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(foundClip->audioFile));
    if (!reader) return PolyResynthesizer::resultToJSON("", false);

    int startSample = static_cast<int>(foundClip->offset * reader->sampleRate);
    int numSamples = static_cast<int>(foundClip->duration * reader->sampleRate);
    numSamples = std::min(numSamples, static_cast<int>(reader->lengthInSamples) - startSample);
    if (numSamples <= 0) return PolyResynthesizer::resultToJSON("", false);

    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), numSamples);
    reader->read(&buffer, 0, numSamples, static_cast<juce::int64>(startSample), true, true);

    juce::AudioBuffer<float> mono(1, numSamples);
    mono.clear();
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        mono.addFrom(0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float>(buffer.getNumChannels()));

    auto soloAudio = polyResynthesizer.soloNote(
        mono.getReadPointer(0), numSamples, reader->sampleRate,
        analysisResult.notes, noteId);

    if (soloAudio.empty())
        return PolyResynthesizer::resultToJSON("", false);

    // Write solo audio to temp file
    juce::File outputFile = foundClip->audioFile.getSiblingFile(
        foundClip->audioFile.getFileNameWithoutExtension() + "_solo_" + noteId.substring(0, 8) + ".wav");

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> fileStream(outputFile.createOutputStream());
    if (!fileStream) return PolyResynthesizer::resultToJSON("", false);

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileStream.get(), reader->sampleRate, 1, 32, {}, 0));
    if (!writer) return PolyResynthesizer::resultToJSON("", false);
    fileStream.release();

    juce::AudioBuffer<float> outBuffer(1, numSamples);
    outBuffer.copyFrom(0, 0, soloAudio.data(), numSamples);
    writer->writeFromAudioSampleBuffer(outBuffer, 0, numSamples);
    writer.reset();

    return PolyResynthesizer::resultToJSON(outputFile.getFullPathName(), true);
}

// =============================================================================
// Phase 8: Source Separation
// =============================================================================

bool AudioEngine::isStemSeparationAvailable() const
{
    return stemSeparator.isAvailable();
}

juce::var AudioEngine::separateStems(const juce::String& trackId, const juce::String& clipId)
{
    juce::ignoreUnused (trackId, clipId);
    // Synchronous separation removed — use separateStemsAsync() instead
    return StemSeparator::resultToJSON ({}, false, "Use async separation.");
}

// =============================================================================
// Phase 10: Async Stem Separation + Progress
// =============================================================================

juce::var AudioEngine::separateStemsAsync(const juce::String& trackId, const juce::String& clipId,
                                           const juce::String& optionsJSON)
{
    juce::ignoreUnused (clipId);
    auto result = std::make_unique<juce::DynamicObject>();

    // If already running, ignore
    if (stemSeparator.isRunning())
    {
        result->setProperty("started", false);
        result->setProperty("error", "Separation already in progress.");
        return juce::var(result.release());
    }

    // Parse options
    auto options = juce::JSON::parse(optionsJSON);
    juce::StringArray requestedStems;
    if (auto* stemsArray = options.getProperty("stems", {}).getArray())
        for (const auto& s : *stemsArray)
            requestedStems.add(s.toString());

    if (requestedStems.isEmpty())
        requestedStems = StemSeparator::getAllStemNames();

    bool useGPU = options.getProperty("gpu", false);

    // Find audio file — prefer filePath from options (frontend knows the clip's file),
    // fall back to searching PlaybackEngine clips by trackId
    juce::File audioFile;
    juce::String filePathFromOptions = options.getProperty("filePath", "").toString();

    if (filePathFromOptions.isNotEmpty())
    {
        audioFile = juce::File(filePathFromOptions);
    }
    else
    {
        // Legacy fallback: search PlaybackEngine clips
        auto clips = playbackEngine.getClipSnapshot();
        for (const auto& clip : clips)
        {
            if (clip.trackId == trackId)
            {
                audioFile = clip.audioFile;
                break;
            }
        }
    }

    if (! audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("StemSeparator: Audio file not found: " + audioFile.getFullPathName());
        result->setProperty("started", false);
        result->setProperty("error", "Audio file not found: " + audioFile.getFullPathName());
        return juce::var(result.release());
    }

    // Cache check
    juce::String cacheKey = audioFile.getFullPathName();
    auto cacheIt = stemFileCache.find(cacheKey);
    if (cacheIt != stemFileCache.end())
    {
        bool allExist = true;
        for (const auto& key : cacheIt->second.getAllKeys())
            if (! juce::File(cacheIt->second[key]).existsAsFile()) { allExist = false; break; }

        if (allExist)
        {
            // Already separated — no need to re-run
            juce::Logger::writeToLog("StemSeparator: Using cached stems.");
            result->setProperty("started", false);
            result->setProperty("cached", true);
            return juce::var(result.release());
        }
        stemFileCache.erase(cacheIt);
    }

    // Create output directory alongside the audio file
    auto outputDir = audioFile.getParentDirectory()
        .getChildFile(audioFile.getFileNameWithoutExtension() + "_stems");

    // Start Python subprocess
    if (! stemSeparator.startSeparation(audioFile, outputDir, requestedStems, useGPU))
    {
        juce::Logger::writeToLog("StemSeparator: Failed to start separation.");
        result->setProperty("started", false);
        result->setProperty("error", "Failed to start Python process. Check that Python and audio-separator are installed.");
        return juce::var(result.release());
    }

    result->setProperty("started", true);
    return juce::var(result.release());
}

juce::var AudioEngine::getStemSeparationProgress()
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto progress = stemSeparator.pollProgress();

    obj->setProperty("state", progress.state);
    obj->setProperty("progress", static_cast<double>(progress.progress));

    if (progress.state == "done" && progress.stemFiles.size() > 0)
    {
        juce::Array<juce::var> stems;
        for (const auto& key : progress.stemFiles.getAllKeys())
        {
            auto stemObj = std::make_unique<juce::DynamicObject>();
            stemObj->setProperty("name", key);
            stemObj->setProperty("filePath", progress.stemFiles[key]);
            stems.add(juce::var(stemObj.release()));
        }
        obj->setProperty("stemFiles", stems);

        // Generate peak caches for stem files
        for (const auto& key : progress.stemFiles.getAllKeys())
        {
            juce::File stemFile(progress.stemFiles[key]);
            if (stemFile.existsAsFile())
            {
                peakCache.generateAsync(stemFile, [stemFile]() {
                    juce::Logger::writeToLog("PeakCache: Generated peaks for stem " + stemFile.getFileName());
                });
            }
        }
    }

    if (progress.state == "error")
        obj->setProperty("error", progress.error);

    return juce::var(obj.release());
}

void AudioEngine::cancelStemSeparation()
{
    stemSeparator.cancel();
}

// =============================================================================
// Phase 9: ARA Plugin Hosting
// =============================================================================

juce::var AudioEngine::initializeARAForTrack(const juce::String& trackId, int fxIndex)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end())
    {
        obj->setProperty("success", false);
        obj->setProperty("error", "Track not found: " + trackId);
        return juce::var(obj.release());
    }

    auto* track = it->second;
    bool success = track->initializeARA(fxIndex, currentSampleRate, currentBlockSize);

    obj->setProperty("success", success);
    if (!success)
        obj->setProperty("error", "Failed to initialize ARA. Plugin may not support ARA.");

    return juce::var(obj.release());
}

juce::var AudioEngine::addARAClip(const juce::String& trackId, const juce::String& clipId)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second->hasActiveARA())
    {
        obj->setProperty("success", false);
        obj->setProperty("error", "Track not found or ARA not active.");
        return juce::var(obj.release());
    }

    // Find the clip's audio file
    auto clips = playbackEngine.getClipSnapshot();
    const PlaybackEngine::ClipInfo* foundClip = nullptr;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId && clip.clipId == clipId)
        {
            foundClip = &clip;
            break;
        }
    }

    if (!foundClip || !foundClip->audioFile.existsAsFile())
    {
        obj->setProperty("success", false);
        obj->setProperty("error", "Clip audio file not found.");
        return juce::var(obj.release());
    }

    auto* ara = it->second->getARAController();
    auto sourceId = ara->addAudioSource(foundClip->audioFile, clipId,
                                         foundClip->startTime, foundClip->duration,
                                         foundClip->offset);

    obj->setProperty("success", sourceId.isNotEmpty());
    if (sourceId.isEmpty())
        obj->setProperty("error", "Failed to add audio source to ARA document. Only WAV files are supported.");

    return juce::var(obj.release());
}

juce::var AudioEngine::removeARAClip(const juce::String& trackId, const juce::String& clipId)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end() || !it->second->hasActiveARA())
    {
        obj->setProperty("success", false);
        return juce::var(obj.release());
    }

    it->second->getARAController()->removeAudioSource(clipId);
    obj->setProperty("success", true);
    return juce::var(obj.release());
}

juce::var AudioEngine::getARAPlugins()
{
    auto araDescs = pluginManager.getARAPlugins();
    juce::Array<juce::var> plugins;

    for (const auto& desc : araDescs)
    {
        auto plugObj = std::make_unique<juce::DynamicObject>();
        plugObj->setProperty("name", desc.name);
        plugObj->setProperty("manufacturer", desc.manufacturerName);
        plugObj->setProperty("pluginId", desc.createIdentifierString());
        plugObj->setProperty("category", desc.category);
        plugins.add(juce::var(plugObj.release()));
    }

    return plugins;
}

juce::var AudioEngine::shutdownARAForTrack(const juce::String& trackId)
{
    auto obj = std::make_unique<juce::DynamicObject>();

    auto it = trackMap.find(trackId);
    if (it == trackMap.end())
    {
        obj->setProperty("success", false);
        return juce::var(obj.release());
    }

    it->second->shutdownARA();
    obj->setProperty("success", true);
    return juce::var(obj.release());
}
