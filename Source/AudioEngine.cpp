#include "AudioEngine.h"

// Helper for file logging
static void logToDisk(const juce::String& msg)
{
    // Use standard documents folder
    auto f = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
             .getChildFile("Studio13").getChildFile("debug_log.txt");
    f.appendText(juce::Time::getCurrentTime().toString(true, true) + ": " + msg + "\n");
}

AudioEngine::AudioEngine()
{
    // Initialize Audio Device Manager
    // In a real app, we'd load settings from an XML or JSON file.
    // For now, request default devices.
    deviceManager.initialiseWithDefaultDevices (2, 2); // 2 inputs, 2 outputs
    deviceManager.addAudioCallback (this);

    // Initialize Graph
    mainProcessorGraph = std::make_unique<juce::AudioProcessorGraph>();
    
    // Initialize Master & Monitoring FX Chains (Phase 5)
    masterFXChain = std::make_unique<juce::AudioProcessorGraph>();
    monitoringFXChain = std::make_unique<juce::AudioProcessorGraph>();
    
    // Initialize MIDI Manager (Phase 2)
    midiManager = std::make_unique<MIDIManager>();
    
    // Set up MIDI message callback to route to tracks
    midiManager->setMessageCallback([this](const juce::String& deviceName, int channel, const juce::MidiMessage& message) {
        handleMIDIMessage(deviceName, channel, message);
    });
    
    juce::Logger::writeToLog("AudioEngine: MIDI Manager initialized");
}

AudioEngine::~AudioEngine()
{
    deviceManager.removeAudioCallback (this);
}

void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    logToDisk("AudioEngine: Device About To Start");
    if (mainProcessorGraph)
    {
        // ... (keep existing config logic)
        mainProcessorGraph->setPlayConfigDetails (device->getActiveInputChannels().countNumberOfSetBits(),
                                                  device->getActiveOutputChannels().countNumberOfSetBits(),
                                                  device->getCurrentSampleRate(),
                                                  device->getCurrentBufferSizeSamples());
        mainProcessorGraph->prepareToPlay (device->getCurrentSampleRate(),
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
    // Clear outputs first
    for (int i = 0; i < numOutputChannels; ++i)
        juce::FloatVectorOperations::clear (outputChannelData[i], numSamples);

    // Update transport position if playing
    
    if (isPlaying)
    {
        currentSamplePosition += numSamples;
    }

    // Mix Metronome (if enabled and transport is running)
    // Note: Metronome handles its own 'enabled' check
    if (isPlaying || isRecordMode) 
    {
        // Wrap output pointers in an AudioBuffer
        // The const_cast is necessary because audioDeviceIOCallbackWithContext provides const pointers 
        // to the array of pointers, but the data itself is mutable in non-const context usually, 
        // OR we should have outputChannelData as non-const?
        // Method signature: float* const* outputChannelData.
        // This means the array of pointers is const, but the float* (pointers to data) are NOT const?
        // Wait: float* const* -> "pointer to const pointer to float". 
        // NO. "float* const*" is "pointer to const pointer". 
        // The data pointed to by "float*" is mutable.
        // "const float* const*" is "pointer to const pointer to const float".
        // Signature line 103: float* const* outputChannelData.
        // So float* is mutable. The pointer to it is const (array structure fixed).
        
        juce::AudioBuffer<float> outputBuffer(const_cast<float**>(outputChannelData), numOutputChannels, numSamples);
        metronome.getNextAudioBlock(outputBuffer, currentSamplePosition);
    }

    // Process each track for input monitoring
    
    for (size_t i = 0; i < trackOrder.size(); ++i)
    {
        const auto& trackId = trackOrder[i];
        if (trackMap.find(trackId) == trackMap.end()) continue;
        
        auto* track = trackMap[trackId];
        if (!track)
            continue;

        // Only monitor if armed and not muted
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
            continue;
        
        // Create temporary buffer for track processing
        // ALWAYS use 2 channels (stereo) for proper pan support, regardless of input config
        juce::AudioBuffer<float> trackBuffer (2, numSamples);
        trackBuffer.clear(); // CRITICAL: Clear buffer to prevent noise from uninitialized memory
        
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
        juce::AudioBuffer<float> masterBuffer(numOutputChannels, numSamples);
        
        // Copy current mixed output to master buffer
        for (int ch = 0; ch < numOutputChannels; ++ch)
            masterBuffer.copyFrom(ch, 0, outputChannelData[ch], numSamples);
        
        // Process through each FX plugin in sequence
        juce::MidiBuffer dummyMidi;
        for (auto& node : masterFXNodes)
        {
            if (node && node->getProcessor())
                node->getProcessor()->processBlock(masterBuffer, dummyMidi);
        }
        
        // Copy processed audio back to output
        for (int ch = 0; ch < numOutputChannels; ++ch)
            juce::FloatVectorOperations::copy(outputChannelData[ch], masterBuffer.getReadPointer(ch), numSamples);
    }
    
    // ========== Apply Master Pan ==========
    // Apply master pan using constant power law
    if (numOutputChannels >= 2)
    {
        const float pi = juce::MathConstants<float>::pi;
        float panAngle = (masterPan + 1.0f) * pi / 4.0f;
        float leftGain = std::cos(panAngle);
        float rightGain = std::sin(panAngle);
        
        juce::FloatVectorOperations::multiply(outputChannelData[0], leftGain, numSamples);
        juce::FloatVectorOperations::multiply(outputChannelData[1], rightGain, numSamples);
    }
    
    // ========== Calculate Master Output Metering ==========
    // Measure RMS of final output AFTER FX and pan (so meters show final processed levels)
    float masterRMSLeft = 0.0f;
    float masterRMSRight = 0.0f;
    
    if (numOutputChannels >= 1)
    {
        // Calculate RMS for left channel
        float sumSquares = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            float sample = outputChannelData[0][i];
            sumSquares += sample * sample;
        }
        masterRMSLeft = std::sqrt(sumSquares / numSamples);
    }
    
    if (numOutputChannels >= 2)
    {
        // Calculate RMS for right channel
        float sumSquares = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            float sample = outputChannelData[1][i];
            sumSquares += sample * sample;
        }
        masterRMSRight = std::sqrt(sumSquares / numSamples);
    }
    
    // Store master levels (use max of L/R for metering display)
    masterOutputLevel = std::max(masterRMSLeft, masterRMSRight);
    
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
}

juce::String AudioEngine::addTrack()
{
    logToDisk("AudioEngine: Adding Track...");

    if (! mainProcessorGraph)
        return "";
        
    // In a real app, use a proper lock
    const juce::ScopedLock sl (mainProcessorGraph->getCallbackLock());

    auto newTrack = std::make_unique<TrackProcessor>();
    auto* rawTrackPtr = newTrack.get(); // Keep raw pointer for metering (owned by graph)
    
    auto trackNode = mainProcessorGraph->addNode (std::move (newTrack));
    
    if (trackNode)
    {
        juce::String trackId = juce::Uuid().toString();
        
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
    // This ensures meter levels work correctly even after reordering
    juce::DynamicObject* meterObj = new juce::DynamicObject();

    for (const auto& trackId : trackOrder)
    {
        if (trackMap.find(trackId) != trackMap.end())
        {
            auto* track = trackMap[trackId];
            if (track)
                meterObj->setProperty(juce::Identifier(trackId), track->getRMSLevel());
        }
    }
    
    return meterObj;
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
    
    // Load the VST instrument using PluginManager
    auto plugin = pluginManager.loadPluginFromFile(vstPath);  // Changed from loadPlugin
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
    // For now, return max of all track levels
    float maxLevel = 0.0f;
    for (auto const& [id, track] : trackMap)
    {
        if (track)
            maxLevel = std::max(maxLevel, track->getRMSLevel());
    }
    return maxLevel * masterVolume;
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
                
                bool started = audioRecorder.startRecording(trackId, outputFile, currentSampleRate, 2); // Stereo for now
                
                if (started) {
                    // Set the recording start time to current transport position
                    audioRecorder.setRecordingStartTime(trackId, getTransportPosition());
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
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            auto plugin = pluginManager.loadPluginFromFile(pluginPath);
            if (plugin)
            {
                bool success = track->addInputFX(std::move(plugin));
                if (success)
                {
                    // Automatically open the editor for the newly added plugin
                    int fxIndex = track->getNumInputFX() - 1;
                    openPluginEditor(trackId, fxIndex, true);
                    juce::Logger::writeToLog("AudioEngine: Added input FX and opened editor");
                }
                return success;
            }
        }
    }
    return false;
}

bool AudioEngine::addTrackFX(const juce::String& trackId, const juce::String& pluginPath)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            auto plugin = pluginManager.loadPluginFromFile(pluginPath);
            if (plugin)
            {
                bool success = track->addTrackFX(std::move(plugin));
                if (success)
                {
                    // Automatically open the editor for the newly added plugin
                    int fxIndex = track->getNumTrackFX() - 1;
                    openPluginEditor(trackId, fxIndex, false);
                    juce::Logger::writeToLog("AudioEngine: Added track FX and opened editor");
                }
                return success;
            }
        }
    }
    return false;
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
            fxList.add(juce::var(fxInfo.get()));
        }
    }
    
    return fxList;
}

void AudioEngine::removeTrackInputFX(const juce::String& trackId, int fxIndex)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->removeInputFX(fxIndex);
            juce::Logger::writeToLog("AudioEngine: Removed input FX " + juce::String(fxIndex) + " from track " + trackId);
        }
    }
}

void AudioEngine::removeTrackFX(const juce::String& trackId, int fxIndex)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->removeTrackFX(fxIndex);
            juce::Logger::writeToLog("AudioEngine: Removed track FX " + juce::String(fxIndex) + " from track " + trackId);
        }
    }
}

void AudioEngine::bypassTrackInputFX(const juce::String& trackId, int fxIndex, bool bypassed)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->bypassInputFX(fxIndex, bypassed);
            juce::Logger::writeToLog("AudioEngine: " + juce::String(bypassed ? "Bypassed" : "Unbypassed") + 
                                   " input FX " + juce::String(fxIndex) + " on track " + trackId);
        }
    }
}

void AudioEngine::bypassTrackFX(const juce::String& trackId, int fxIndex, bool bypassed)
{
    if (trackMap.find(trackId) != trackMap.end())
    {
        auto* track = trackMap[trackId];
        if (track)
        {
            track->bypassTrackFX(fxIndex, bypassed);
            juce::Logger::writeToLog("AudioEngine: " + juce::String(bypassed ? "Bypassed" : "Unbypassed") + 
                                   " track FX " + juce::String(fxIndex) + " on track " + trackId);
        }
    }
}

bool AudioEngine::reorderTrackInputFX(const juce::String& trackId, int fromIndex, int toIndex)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;
    
    auto* track = trackMap[trackId];
    if (track)
    {
        bool success = track->reorderInputFX(fromIndex, toIndex);
        if (success)
        {
            juce::Logger::writeToLog("AudioEngine: Reordered input FX on track " + trackId +
                                   " from " + juce::String(fromIndex) + " to " + juce::String(toIndex));
        }
        return success;
    }
    return false;
}

bool AudioEngine::reorderTrackFX(const juce::String& trackId, int fromIndex, int toIndex)
{
    if (trackMap.find(trackId) == trackMap.end())
        return false;
    
    auto* track = trackMap[trackId];
    if (track)
    {
        bool success = track->reorderTrackFX(fromIndex, toIndex);
        if (success)
        {
            juce::Logger::writeToLog("AudioEngine: Reordered track FX on track " + trackId +
                                   " from " + juce::String(fromIndex) + " to " + juce::String(toIndex));
        }
        return success;
    }
    return false;
}

//==============================================================================
// Master FX Management

bool AudioEngine::addMasterFX(const juce::String& pluginPath)
{
    juce::Logger::writeToLog("AudioEngine: addMasterFX called with: " + pluginPath);
    
    // Load the plugin
    auto plugin = pluginManager.loadPluginFromFile(pluginPath);
    if (!plugin)
    {
        juce::Logger::writeToLog("AudioEngine: Failed to load plugin for master FX");
        return false;
    }
    
    // Prepare the plugin with current audio settings
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device)
    {
        plugin->prepareToPlay(device->getCurrentSampleRate(), device->getCurrentBufferSizeSamples());
    }
    else
    {
        plugin->prepareToPlay(44100.0, 512); // Fallback defaults
    }
    
    // Add to master FX chain graph
    auto node = masterFXChain->addNode(std::move(plugin));
    if (node != nullptr)
    {
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
}

bool AudioEngine::addMonitoringFX(const juce::String& pluginPath)
{
    // TODO: Implement monitoring FX chain when needed
    juce::Logger::writeToLog("addMonitoringFX called with: " + pluginPath);
    
    // Load the plugin  
    auto plugin = pluginManager.loadPluginFromFile(pluginPath);
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
    juce::Array<juce::var> peakData;
    
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("getWaveformPeaks: File not found: " + filePath);
        return peakData;
    }
    
    // Create audio format manager and register formats
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    
    // Create reader for the audio file
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (!reader)
    {
        juce::Logger::writeToLog("getWaveformPeaks: Could not create reader for: " + filePath);
        return peakData;
    }
    
    // Read samples and compute peaks
    const int numChannels = static_cast<int>(reader->numChannels);
    const juce::int64 totalSamples = reader->lengthInSamples;
    
    // Create buffer for reading samples
    juce::AudioBuffer<float> buffer(numChannels, samplesPerPixel);
    
    for (int pixel = 0; pixel < numPixels; ++pixel)
    {
        juce::int64 startSample = static_cast<juce::int64>(pixel) * samplesPerPixel;
        
        if (startSample >= totalSamples)
            break;
        
        // Calculate how many samples to read
        int samplesToRead = std::min(samplesPerPixel, static_cast<int>(totalSamples - startSample));
        
        buffer.clear();
        reader->read(&buffer, 0, samplesToRead, startSample, true, true);
        
        // Calculate min/max for each channel separately
        juce::DynamicObject::Ptr peakObj = new juce::DynamicObject();
        juce::Array<juce::var> channels;
        
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float minVal = 0.0f;
            float maxVal = 0.0f;
            
            const float* channelData = buffer.getReadPointer(ch);
            for (int s = 0; s < samplesToRead; ++s)
            {
                float sample = channelData[s];
                if (sample < minVal) minVal = sample;
                if (sample > maxVal) maxVal = sample;
            }
            
            juce::DynamicObject::Ptr channelPeak = new juce::DynamicObject();
            channelPeak->setProperty("min", minVal);
            channelPeak->setProperty("max", maxVal);
            channels.add(juce::var(channelPeak.get()));
        }
        
        peakObj->setProperty("channels", channels);
        peakData.add(juce::var(peakObj.get()));
    }
    
    return peakData;
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
