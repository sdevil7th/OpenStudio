#include "AudioEngine.h"

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

    // Now open the audio device and register the callback. This is done last so
    // that all members above are valid when audioDeviceAboutToStart() fires.
    loadDeviceSettings();
    deviceManager.addAudioCallback (this);

    juce::Logger::writeToLog("AudioEngine: MIDI Manager initialized");
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

        // Metronome Init
        metronome.prepareToPlay(device->getCurrentSampleRate(), device->getCurrentBufferSizeSamples());
        metronome.setBpm(tempo);
        metronome.setTimeSignature(timeSigNumerator, timeSigDenominator);
                                           
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

    // Mix Metronome (if enabled and transport is running)
    if (isPlaying || isRecordMode)
    {
        juce::AudioBuffer<float> outputBuffer(const_cast<float**>(outputChannelData), numOutputChannels, numSamples);
        metronome.getNextAudioBlock(outputBuffer, currentSamplePosition);
    }

    // Use cached solo state (updated when solo changes, avoids scanning every callback)
    bool anySoloed = cachedAnySoloed.load();

    // Process each track
    for (size_t i = 0; i < trackOrder.size(); ++i)
    {
        const auto& trackId = trackOrder[i];
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
        
        // PLAYBACK MODE: Read from clips if transport is playing
        if (isPlaying)
        {
            // Fill buffer with playback audio from clips
            // Fill buffer with playback audio from clips
            playbackEngine.fillTrackBuffer(
                trackId,
                trackBuffer,
                currentSamplePosition / currentSampleRate,
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
                }
            }

            audioRecorder.writeBlock(trackId, trackBuffer, numSamples);
        }
        
        // Process through track (applies volume, pan, FX)
        juce::MidiBuffer midiMessages;
        track->processBlock(trackBuffer, midiMessages);
        
        // Mix track output to device outputs
        // Tracks output stereo, so mix channels 0->0, 1->1
        for (int ch = 0; ch < std::min(trackBuffer.getNumChannels(), numOutputChannels); ++ch)
        {
            juce::FloatVectorOperations::add(
                outputChannelData[ch],
                trackBuffer.getReadPointer(ch),
                numSamples
            );
        }
        
        // Recording already done above (before FX) - this section removed
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
    
    // ========== Apply Master Pan ==========
    // Uses pre-computed gains (updated in setMasterPan) — no trig on audio thread
    if (numOutputChannels >= 2)
    {
        const float leftGain  = cachedMasterPanL.load(std::memory_order_relaxed);
        const float rightGain = cachedMasterPanR.load(std::memory_order_relaxed);

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
    
    // ========== Apply Master Volume ==========
    // Apply master volume to all output channels
    for (int ch = 0; ch < numOutputChannels; ++ch)
    {
        juce::FloatVectorOperations::multiply(
            outputChannelData[ch],
            masterVolume,
            numSamples
        );
    }

    // ========== Advance transport position ==========
    // IMPORTANT: This is intentionally AFTER all processing (metronome, playback,
    // recording) so they use the position corresponding to the samples being
    // output in this callback.  Previously this was at the top of the callback,
    // causing a systematic one-buffer-length delay.
    if (isPlaying)
    {
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
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());
    
    auto it = trackMap.find(trackId);
    if (it == trackMap.end()) return false;
    
    auto* track = it->second;
    
    // Find unit in graph to remove
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
    
    // Set the instrument on the track
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
        
        // If recording and armed, log the MIDI event
        // TODO: Store in thread-safe recording buffer for actual MIDI clip creation
        if (isPlaying && isRecordMode && track->getRecordArmed())
        {
            double timestamp = currentSamplePosition / currentSampleRate;
            juce::Logger::writeToLog("MIDI Recorded: " + message.getDescription() + 
                                   " at time: " + juce::String(timestamp, 3) + 
                                   " on device: " + deviceName);
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
        
        for (auto const& [trackId, track] : trackMap)
        {
            if (!track) continue;
            
            bool isArmed = track->getRecordArmed();
            
            if (isArmed)
            {
                logToDisk("Track " + trackId + " IS ARMED. Starting record...");
                
                // Generate filename: Track_ID_Take_timestamp.wav
                auto timestamp = juce::Time::getCurrentTime().toMilliseconds();
                auto filename = "Track_" + trackId + "_Take_" + juce::String(timestamp) + ".wav";
                auto outputFile = projectAudioFolder.getChildFile(filename);
                
                // Use the sample rate that was set in audioDeviceAboutToStart
                // (currentSampleRate is updated when device starts and should match device's actual rate)
                logToDisk("Recording at sample rate: " + juce::String(currentSampleRate) + " Hz");
                
                int numChannels = track->getInputChannelCount();
                bool started = audioRecorder.startRecording(trackId, outputFile, currentSampleRate, numChannels);

                if (started) {
                    // Defer start-time capture to the audio thread to avoid race
                    // conditions — the message thread's view of currentSamplePosition
                    // may be stale by the time the audio callback processes the first
                    // buffer.  The audio thread sets the correct start time (with
                    // input latency compensation) on the first write.
                    pendingRecordStartCapture.store(true, std::memory_order_release);
                }
                
                logToDisk("Start Recording Track " + trackId + " -> " + (started ? "SUCCESS" : "FAIL to " + outputFile.getFullPathName()));
            }
        }
    }
    else
    {
        // Stop all recordings and collect clip info
        logToDisk("Record mode OFF - stopping recordings");
        lastCompletedClips = audioRecorder.stopAllRecordings(currentSampleRate);
        logToDisk("Recordings stopped. Completed " + juce::String(lastCompletedClips.size()) + " clips.");

        // Generate peak caches for recorded files in background (REAPER-style).
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
        
        pluginList.add(juce::var(pluginObj));
    }
    
    juce::Logger::writeToLog("AudioEngine: Returning " + juce::String(pluginList.size()) + " plugins");
    return pluginList;
}

bool AudioEngine::addTrackInputFX(const juce::String& trackId, const juce::String& pluginPath)
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
        openPluginEditor(trackId, fxIndex, true);
        juce::Logger::writeToLog("AudioEngine: Added input FX and opened editor");
    }
    return success;
}

bool AudioEngine::addTrackFX(const juce::String& trackId, const juce::String& pluginPath)
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
        openPluginEditor(trackId, fxIndex, false);
        juce::Logger::writeToLog("AudioEngine: Added track FX and opened editor");
    }
    return success;
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
            windowTitle = "Track " + juce::String(displayIndex) + " - Input FX " + juce::String(fxIndex + 1);
        }
    }
    else
    {
        if (fxIndex >= 0 && fxIndex < track->getNumTrackFX())
        {
            processor = track->getTrackFXProcessor(fxIndex);
            windowTitle = "Track " + juce::String(displayIndex) + " - Track FX " + juce::String(fxIndex + 1);
        }
    }
    
    if (processor)
    {
        pluginWindowManager.openEditor(processor, windowTitle);
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
            // Include plugin file path for save/restore
            if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(processor))
            {
                auto desc = pluginInstance->getPluginDescription();
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
            // Include plugin file path for save/restore
            if (auto* pluginInstance = dynamic_cast<juce::AudioPluginInstance*>(processor))
            {
                auto desc = pluginInstance->getPluginDescription();
                fxInfo->setProperty("pluginPath", desc.fileOrIdentifier);
            }
            fxList.add(juce::var(fxInfo.get()));
        }
    }

    return fxList;
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
    // TODO: Implement monitoring FX chain when needed
    juce::Logger::writeToLog("addMonitoringFX called with: " + pluginPath);
    
    // Load the plugin with actual device rate
    double sr = currentSampleRate > 0 ? currentSampleRate : 44100.0;
    int bs = currentBlockSize > 0 ? currentBlockSize : 512;
    auto plugin = pluginManager.loadPluginFromFile(pluginPath, sr, bs);
    if (!plugin)
    {
        juce::Logger::writeToLog("Failed to load plugin for monitoring FX");
        return false;
    }
    
    juce::Logger::writeToLog("Monitoring FX plugin loaded successfully (not yet connected to chain)");
    return true;
}

std::vector<AudioRecorder::CompletedRecording> AudioEngine::getLastCompletedClips()
{
    auto clips = lastCompletedClips;
    lastCompletedClips.clear();  // Clear after reading
    return clips;
}

//==============================================================================
// Playback Clip Management

// Playback Clip Management

void AudioEngine::addPlaybackClip(const juce::String& trackId, const juce::String& filePath, double startTime, double duration)
{
    juce::File audioFile(filePath);
    // Assuming PlaybackEngine updated to take String ID
    // For now, if PlaybackEngine uses int, we might need a map or conversion.
    // BUT we must adhere to interface. 
    // Let's assume we will update PlaybackEngine too.
    playbackEngine.addClip(audioFile, startTime, duration, trackId);
    juce::Logger::writeToLog("AudioEngine: Added playback clip to track " + trackId);
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



juce::var AudioEngine::getWaveformPeaks(const juce::String& filePath, int samplesPerPixel, int numPixels)
{
    // REAPER-inspired: read from pre-computed peak cache (.s13peaks) instead of audio file.
    // If cache doesn't exist, generate it synchronously (first-time cost, then instant).
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("getWaveformPeaks: File not found: " + filePath);
        return juce::Array<juce::var>();
    }

    // Generate peak cache if it doesn't exist (first time only)
    if (!peakCache.hasCachedPeaks(audioFile))
    {
        juce::Logger::writeToLog("getWaveformPeaks: Generating peak cache for: " + audioFile.getFileName());
        peakCache.generateSync(audioFile);
    }

    // Read from peak cache (instant — memory-cached mipmap lookup)
    return peakCache.getPeaks(audioFile, samplesPerPixel, numPixels);
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
        result.add(obj);
    }
    return result;
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
    // For V1, always render at the device sample rate (= rate audio was recorded at).
    // Sample rate conversion is not yet implemented, so ignore renderSampleRate.
    double actualSampleRate = currentSampleRate;
    if (actualSampleRate <= 0) actualSampleRate = 44100.0;
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32) bitDepth = 24;
    if (numChannels < 1 || numChannels > 2) numChannels = 2;

    // Determine if we need post-processing (lossy encoding or sample rate conversion)
    juce::String formatLower = format.toLowerCase();
    bool isLossyFormat = (formatLower == "mp3" || formatLower == "ogg");
    bool needsSampleRateConversion = (renderSampleRate > 0 && renderSampleRate != actualSampleRate);
    bool needsFFmpegPostProcess = isLossyFormat || needsSampleRateConversion;

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
              (needsSampleRateConversion ? " (will convert to " + juce::String(renderSampleRate) + " via ffmpeg)" : " (device rate)"));
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
    const int blockSize = 512;

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

    // ========== 9. FFmpeg post-processing (lossy encoding / sample rate conversion) ==========
    if (needsFFmpegPostProcess)
    {
        logToDisk("renderProject: Starting FFmpeg post-processing...");
        double targetSR = needsSampleRateConversion ? renderSampleRate : 0;
        bool ffmpegOk = convertWithFFmpeg(renderFile, outputFile, formatLower, targetSR, codecQuality);

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
