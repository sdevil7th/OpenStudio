#pragma once

#include <JuceHeader.h>

// Track type enumeration
enum class TrackType
{
    Audio,       // Audio-only track
    MIDI,        // MIDI-only track (no instrument)
    Instrument   // MIDI track with VST instrument
};

class TrackProcessor  : public juce::AudioProcessor
{
public:
    TrackProcessor();
    ~TrackProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;

    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;
    
    // Custom methods - Metering
    float getRMSLevel() const { return currentRMS; }
    
    // Recording & Monitoring (Phase 1)
    void setRecordArmed(bool armed) { isRecordArmed = armed; }
    bool getRecordArmed() const { return isRecordArmed; }
    
    void setInputMonitoring(bool enabled) { isInputMonitoringEnabled = enabled; }
    bool getInputMonitoring() const { return isInputMonitoringEnabled; }
    
    void setInputChannels(int startChannel, int numChannels);
    int getInputStartChannel() const { return inputStartChannel; }
    int getInputChannelCount() const { return inputChannelCount; }
    
    // FX Chain Management (Phase 3)
    bool addInputFX(std::unique_ptr<juce::AudioProcessor> plugin);
    bool addTrackFX(std::unique_ptr<juce::AudioProcessor> plugin);
    void removeInputFX(int index);
    void removeTrackFX(int index);
    void bypassInputFX(int index, bool bypassed);
    void bypassTrackFX(int index, bool bypassed);
    bool reorderInputFX(int fromIndex, int toIndex);
    bool reorderTrackFX(int fromIndex, int toIndex);
    int getNumInputFX() const;
    int getNumTrackFX() const;
    juce::AudioProcessor* getInputFXProcessor(int index);
    juce::AudioProcessor* getTrackFXProcessor(int index);
    
    // Sends (Phase 4)
    void setSendLevel(int sendIndex, float level);  // 0.0 to 1.0
    void setSendPan(int sendIndex, float pan);      // -1.0 (L) to 1.0 (R)
    void setSendEnabled(int sendIndex, bool enabled);
    void setSendPreFader(int sendIndex, bool preFader);
    int getNumSends() const { return static_cast<int>(sends.size()); }
    
    // Volume & Pan
    void setVolume(float newVolume);
    void setPan(float newPan);  // -1.0 (L) to 1.0 (R)
    float getVolume() const { return trackVolumeDB; }  // Returns dB value
    float getPan() const { return trackPan; }
    
    // Mute/Solo
    void setMute(bool shouldMute);
    void setSolo(bool shouldSolo);
    bool isMute() const { return isMuted; }
    bool isSolo() const { return isSoloed; }
    bool getMute() const { return isMuted; }  // Alias for compatibility
    bool getSolo() const { return isSoloed; }  // Alias for compatibility
    
    // Track Type (Phase 2 - MIDI)
    void setTrackType(TrackType newType) { trackType = newType; }
    TrackType getTrackType() const { return trackType; }
    
    // MIDI Configuration (Phase 2)
    void setMIDIInputDevice(const juce::String& device) { midiInputDevice = device; }
    juce::String getMIDIInputDevice() const { return midiInputDevice; }
    
    void setMIDIChannel(int channel) { midiChannel = juce::jlimit(0, 16, channel); } // 0 = all, 1-16 = specific
    int getMIDIChannel() const { return midiChannel; }
    
    // Instrument plugin (Phase 2)
    void setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin);
    juce::AudioPluginInstance* getInstrument() const { return instrumentPlugin.get(); }

private:
    std::atomic<float> currentRMS { 0.0f };
    
    // Recording state (Phase 1)
    bool isRecordArmed = false;
    bool isInputMonitoringEnabled = false;
    int inputStartChannel = 0;    // Hardware input start (0-based)
    int inputChannelCount = 2;     // Stereo by default
    
    // Mute/Solo state
    bool isMuted = false;
    bool isSoloed = false;
    
    // FX Chains (Phase 3)
    std::unique_ptr<juce::AudioProcessorGraph> inputFXChain;  // Pre-recording FX
    std::unique_ptr<juce::AudioProcessorGraph> trackFXChain;  // Playback FX
    std::vector<juce::AudioProcessorGraph::Node::Ptr> inputFXNodes;
    std::vector<juce::AudioProcessorGraph::Node::Ptr> trackFXNodes;
    
    // Sends (Phase 4)
    struct SendConfig
    {
        float level = 0.0f;
        float pan = 0.0f;
        bool enabled = false;
        bool preFader = false;
        int destinationTrack = -1;
    };
    std::vector<SendConfig> sends;
    
    // Mix (Phase 1)
    float trackVolumeDB = 0.0f;  // -60 to +12 dB
    float trackPan = 0.0f;        // -1.0 (L) to +1.0 (R)
    
    // Track Type & MIDI (Phase 2)
    TrackType trackType = TrackType::Audio;
    juce::String midiInputDevice;
    int midiChannel = 0;  // 0 = all channels, 1-16 = specific channel
    std::unique_ptr<juce::AudioPluginInstance> instrumentPlugin;
    juce::MidiBuffer midiBuffer;  // For MIDI event storage

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackProcessor)
};
