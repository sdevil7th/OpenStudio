#include "TrackProcessor.h"

TrackProcessor::TrackProcessor()
     : AudioProcessor (BusesProperties()
                       .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    // Initialize FX chains (Phase 3)
    inputFXChain = std::make_unique<juce::AudioProcessorGraph>();
    trackFXChain = std::make_unique<juce::AudioProcessorGraph>();
}

TrackProcessor::~TrackProcessor()
{
}

const juce::String TrackProcessor::getName() const
{
    return "Track Processor";
}

bool TrackProcessor::acceptsMidi() const
{
    return trackType == TrackType::MIDI || trackType == TrackType::Instrument;
}

bool TrackProcessor::producesMidi() const
{
    return false;
}

bool TrackProcessor::isMidiEffect() const
{
    return false;
}

double TrackProcessor::getTailLengthSeconds() const
{
    return 0.0;
}

int TrackProcessor::getNumPrograms()
{
    return 1;
}

int TrackProcessor::getCurrentProgram()
{
    return 0;
}

void TrackProcessor::setCurrentProgram (int index)
{
}

const juce::String TrackProcessor::getProgramName (int index)
{
    return {};
}

void TrackProcessor::setVolume(float newVolume)
{
    trackVolumeDB = juce::jlimit(-60.0f, 6.0f, newVolume); // Assuming trackVolumeDB is the member
}

void TrackProcessor::setPan(float newPan)
{
    trackPan = juce::jlimit(-1.0f, 1.0f, newPan);
}

void TrackProcessor::setMute(bool shouldMute)
{
    isMuted = shouldMute;
}

void TrackProcessor::setSolo(bool shouldSolo)
{
    isSoloed = shouldSolo;
}

void TrackProcessor::changeProgramName (int index, const juce::String& newName)
{
}

void TrackProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
}

void TrackProcessor::releaseResources()
{
}

bool TrackProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    return true; // Simplified
}

void TrackProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    juce::ScopedNoDenormals noDenormals;
    auto totalNumInputChannels  = getTotalNumInputChannels();
    auto totalNumOutputChannels = getTotalNumOutputChannels();

    // Clear any extra output channels
    for (auto i = totalNumInputChannels; i < totalNumOutputChannels; ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    // Apply mute first - if muted, silence and return
    if (isMuted)
    {
        buffer.clear();
        currentRMS = 0.0f;
        return;
    }


    // Process through input FX chain (for recording monitoring with FX)
    // Manually process each plugin in sequence instead of using the graph
    for (auto& node : inputFXNodes)
    {
        if (node && node->getProcessor())
        {
            node->getProcessor()->processBlock(buffer, midiMessages);
        }
    }
    
    // Process through track FX chain (for playback/mixing)
    // Manually process each plugin in sequence instead of using the graph
    for (auto& node : trackFXNodes)
    {
        if (node && node->getProcessor())
        {
            node->getProcessor()->processBlock(buffer, midiMessages);
        }
    }

    // Apply volume (convert dB to linear gain)
    float volumeGain = juce::Decibels::decibelsToGain(trackVolumeDB);
    
    // Apply pan using constant power law
    // Pan range: -1.0 (hard left) to +1.0 (hard right)
    const float pi = juce::MathConstants<float>::pi;
    float panAngle = (trackPan + 1.0f) * pi / 4.0f;
    float leftGain = std::cos(panAngle) * volumeGain;
    float rightGain = std::sin(panAngle) * volumeGain;
    
    // Apply gains to channels
    if (totalNumInputChannels >= 1 && totalNumOutputChannels >= 1)
    {
        buffer.applyGain(0, 0, buffer.getNumSamples(), leftGain);
    }
    if (totalNumInputChannels >= 2 && totalNumOutputChannels >= 2)
    {
        buffer.applyGain(1, 0, buffer.getNumSamples(), rightGain);
    }
    else if (totalNumInputChannels == 1 && totalNumOutputChannels >= 2)
    {
        // Mono to stereo - duplicate channel 0 to channel 1, then apply separate gains
        buffer.copyFrom(1, 0, buffer, 0, 0, buffer.getNumSamples());
        // Now apply the correct gains: left channel already has leftGain, right needs rightGain
        buffer.applyGain(1, 0, buffer.getNumSamples(), rightGain / leftGain); // Adjust right channel
    }

    // Calculate RMS for metering
    float rms = 0.0f;
    for (int channel = 0; channel < std::min(totalNumInputChannels, totalNumOutputChannels); ++channel)
    {
        rms += buffer.getRMSLevel(channel, 0, buffer.getNumSamples());
    }
    if (totalNumInputChannels > 0)
        currentRMS = rms / (float)std::min(totalNumInputChannels, totalNumOutputChannels);
}

bool TrackProcessor::hasEditor() const
{
    return false;
}

juce::AudioProcessorEditor* TrackProcessor::createEditor()
{
    return nullptr;
}

void TrackProcessor::getStateInformation (juce::MemoryBlock& destData)
{
}

void TrackProcessor::setStateInformation (const void* data, int sizeInBytes)
{
}

void TrackProcessor::setInputChannels(int startChannel, int numChannels)
{
    inputStartChannel = startChannel;
    inputChannelCount = numChannels;
    juce::Logger::writeToLog("TrackProcessor: Input channels set to " + 
                           juce::String(startChannel) + "-" + 
                           juce::String(startChannel + numChannels - 1));
}

//==============================================================================
// FX Chain Management (Phase 3)

bool TrackProcessor::addInputFX(std::unique_ptr<juce::AudioProcessor> plugin)
{
    if (!plugin || !inputFXChain)
        return false;
    
    // Prepare the plugin
    plugin->prepareToPlay(getSampleRate(), getBlockSize());
        
    auto node = inputFXChain->addNode(std::move(plugin));
    if (node != nullptr)
    {
        inputFXNodes.push_back(node);
        juce::Logger::writeToLog("TrackProcessor: Added Input FX plugin");
        return true;
    }
    return false;
}

bool TrackProcessor::addTrackFX(std::unique_ptr<juce::AudioProcessor> plugin)
{
    if (!plugin || !trackFXChain)
        return false;
    
    // Prepare the plugin
    plugin->prepareToPlay(getSampleRate(), getBlockSize());
        
    auto node = trackFXChain->addNode(std::move(plugin));
    if (node != nullptr)
    {
        trackFXNodes.push_back(node);
        juce::Logger::writeToLog("TrackProcessor: Added Track FX plugin");
        return true;
    }
    return false;
}

void TrackProcessor::removeInputFX(int index)
{
    if (index >= 0 && index < inputFXNodes.size())
    {
        inputFXChain->removeNode(inputFXNodes[index].get());
        inputFXNodes.erase(inputFXNodes.begin() + index);
        juce::Logger::writeToLog("TrackProcessor: Removed Input FX at index " + juce::String(index));
    }
}

void TrackProcessor::removeTrackFX(int index)
{
    if (index >= 0 && index < trackFXNodes.size())
    {
        trackFXChain->removeNode(trackFXNodes[index].get());
        trackFXNodes.erase(trackFXNodes.begin() + index);
        juce::Logger::writeToLog("TrackProcessor: Removed Track FX at index " + juce::String(index));
    }
}

void TrackProcessor::bypassInputFX(int index, bool bypassed)
{
    if (index >= 0 && index < inputFXNodes.size())
    {
        if (auto* processor = inputFXNodes[index]->getProcessor())
            processor->suspendProcessing(bypassed);
    }
}

void TrackProcessor::bypassTrackFX(int index, bool bypassed)
{
    if (index >= 0 && index < trackFXNodes.size())
    {
        if (auto* processor = trackFXNodes[index]->getProcessor())
            processor->suspendProcessing(bypassed);
    }
}

int TrackProcessor::getNumInputFX() const
{
    return (int)inputFXNodes.size();
}

int TrackProcessor::getNumTrackFX() const
{
    return (int)trackFXNodes.size();
}

juce::AudioProcessor* TrackProcessor::getInputFXProcessor(int index)
{
    if (index >= 0 && index < inputFXNodes.size())
    {
        if (auto* node = inputFXNodes[index].get())
            return node->getProcessor();
    }
    return nullptr;
}

juce::AudioProcessor* TrackProcessor::getTrackFXProcessor(int index)
{
    if (index >= 0 && index < trackFXNodes.size())
    {
        if (auto* node = trackFXNodes[index].get())
            return node->getProcessor();
    }
    return nullptr;
}

bool TrackProcessor::reorderInputFX(int fromIndex, int toIndex)
{
    if (fromIndex < 0 || fromIndex >= inputFXNodes.size() ||
        toIndex < 0 || toIndex >= inputFXNodes.size() ||
        fromIndex == toIndex)
        return false;
    
    // Move element from fromIndex to toIndex
    auto node = inputFXNodes[fromIndex];
    inputFXNodes.erase(inputFXNodes.begin() + fromIndex);
    inputFXNodes.insert(inputFXNodes.begin() + toIndex, node);
    
    juce::Logger::writeToLog("TrackProcessor: Reordered input FX from " + 
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

bool TrackProcessor::reorderTrackFX(int fromIndex, int toIndex)
{
    if (fromIndex < 0 || fromIndex >= trackFXNodes.size() ||
        toIndex < 0 || toIndex >= trackFXNodes.size() ||
        fromIndex == toIndex)
        return false;
    
    // Move element from fromIndex to toIndex
    auto node = trackFXNodes[fromIndex];
    trackFXNodes.erase(trackFXNodes.begin() + fromIndex);
    trackFXNodes.insert(trackFXNodes.begin() + toIndex, node);
    
    juce::Logger::writeToLog("TrackProcessor: Reordered track FX from " + 
                           juce::String(fromIndex) + " to " + juce::String(toIndex));
    return true;
}

//==============================================================================
// Send Management (Phase 4)

void TrackProcessor::setSendLevel(int sendIndex, float level)
{
    if (sendIndex >= 0 && sendIndex < sends.size())
    {
        sends[sendIndex].level = juce::jlimit(0.0f, 1.0f, level);
        juce::Logger::writeToLog("TrackProcessor: Send " + juce::String(sendIndex) + " level: " + juce::String(level));
    }
}

void TrackProcessor::setSendPan(int sendIndex, float pan)
{
    if (sendIndex >= 0 && sendIndex < sends.size())
    {
        sends[sendIndex].pan = juce::jlimit(-1.0f, 1.0f, pan);
    }
}

void TrackProcessor::setSendEnabled(int sendIndex, bool enabled)
{
    if (sendIndex >= 0 && sendIndex < sends.size())
    {
        sends[sendIndex].enabled = enabled;
        juce::Logger::writeToLog("TrackProcessor: Send " + juce::String(sendIndex) + " " + (enabled ? "enabled" : "disabled"));
    }
}

void TrackProcessor::setSendPreFader(int sendIndex, bool preFader)
{
    if (sendIndex >= 0 && sendIndex < sends.size())
    {
        sends[sendIndex].preFader = preFader;
        juce::Logger::writeToLog("TrackProcessor: Send " + juce::String(sendIndex) + " " + (preFader ? "pre-fader" : "post-fader"));
    }
}

//==============================================================================
// MIDI & Instrument (Phase 2)

void TrackProcessor::setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin)
{
    if (plugin)
    {
        plugin->prepareToPlay(getSampleRate(), getBlockSize());
        instrumentPlugin = std::move(plugin);
        juce::Logger::writeToLog("TrackProcessor: Instrument plugin loaded");
    }
}
