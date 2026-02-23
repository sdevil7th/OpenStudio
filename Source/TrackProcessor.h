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
    void resetRMS() { currentRMS.store (0.0f, std::memory_order_relaxed); meterPeakAccum = 0.0f; meterSampleCount = 0; }
    
    // Recording & Monitoring (Phase 1)
    void setRecordArmed(bool armed) { isRecordArmed = armed; }
    bool getRecordArmed() const { return isRecordArmed; }
    
    void setInputMonitoring(bool enabled) { isInputMonitoringEnabled = enabled; }
    bool getInputMonitoring() const { return isInputMonitoringEnabled; }
    
    void setInputChannels(int startChannel, int numChannels);
    int getInputStartChannel() const { return inputStartChannel; }
    int getInputChannelCount() const { return inputChannelCount; }
    
    // FX Chain Management (Phase 3)
    // sampleRate/blockSize: caller (AudioEngine) passes the known-correct device
    // values so the plugin is always prepared at the right rate — avoids the 44100
    // fallback that causes aliasing when getSampleRate() returns 0.
    bool addInputFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate = 0, int callerBlockSize = 0);
    bool addTrackFX(std::unique_ptr<juce::AudioProcessor> plugin, double callerSampleRate = 0, int callerBlockSize = 0);
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
    
    // Sends (Phase 4 / Phase 11)
    int addSend(const juce::String& destTrackId);
    void removeSend(int sendIndex);
    void setSendLevel(int sendIndex, float level);  // 0.0 to 1.0
    void setSendPan(int sendIndex, float pan);      // -1.0 (L) to 1.0 (R)
    void setSendEnabled(int sendIndex, bool enabled);
    void setSendPreFader(int sendIndex, bool preFader);
    int getNumSends() const { return static_cast<int>(sends.size()); }
    juce::String getSendDestination(int sendIndex) const;
    float getSendLevel(int sendIndex) const;
    float getSendPan(int sendIndex) const;
    bool getSendEnabled(int sendIndex) const;
    bool getSendPreFader(int sendIndex) const;

    /** Fill destBuffer with this track's send contribution (called by AudioEngine) */
    void fillSendBuffer(int sendIndex, const juce::AudioBuffer<float>& preFaderBuf,
                        const juce::AudioBuffer<float>& postFaderBuf,
                        juce::AudioBuffer<float>& destBuffer, int numSamples) const;
    
    // Volume & Pan
    void setVolume(float newVolume);
    void setPan(float newPan);  // -1.0 (L) to 1.0 (R)
    float getVolume() const { return trackVolumeDB; }  // Returns dB value
    float getPan() const { return trackPan; }
    
    // Mute/Solo
    void setMute(bool shouldMute);
    void setSolo(bool shouldSolo);
    bool isMute() const { return isMuted.load(); }
    bool isSolo() const { return isSoloed.load(); }
    bool getMute() const { return isMuted.load(); }  // Alias for compatibility
    bool getSolo() const { return isSoloed.load(); }  // Alias for compatibility
    
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
    // Current peak level (was named currentRMS but now holds peak — kept as-is
    // to avoid changing the public getRMSLevel() / resetRMS() API used by AudioEngine).
    std::atomic<float> currentRMS { 0.0f };

    // REAPER-style peak meter decimation: accumulate across callbacks and only
    // write to currentRMS every METER_UPDATE_SAMPLES. At 32-sample ASIO blocks
    // this reduces updates from 1378/sec to ~11/sec — matching the 10Hz metering
    // timer that reads these values, so no visual information is lost while
    // eliminating ~125× redundant per-callback work. Peak (max|sample|) instead
    // of RMS avoids the costly sqrt entirely.
    static constexpr int METER_UPDATE_SAMPLES = 4096; // ~11Hz at 44.1kHz / 32-sample blocks
    int  meterSampleCount { 0 };
    float meterPeakAccum  { 0.0f };
    
    // Recording state (Phase 1)
    bool isRecordArmed = false;
    bool isInputMonitoringEnabled = false;
    int inputStartChannel = 0;    // Hardware input start (0-based)
    int inputChannelCount = 2;     // Stereo by default
    
    // Mute/Solo state (atomic: set from message thread, read from audio thread)
    std::atomic<bool> isMuted { false };
    std::atomic<bool> isSoloed { false };
    
    // FX Chains (Phase 3) — stored directly, no AudioProcessorGraph wrapper
    std::vector<std::unique_ptr<juce::AudioProcessor>> inputFXPlugins;  // Pre-recording FX
    std::vector<std::unique_ptr<juce::AudioProcessor>> trackFXPlugins;  // Playback FX
    
    // Sends (Phase 4 / Phase 11)
    struct SendConfig
    {
        juce::String destTrackId;
        float level = 0.5f;
        float pan = 0.0f;
        bool enabled = true;
        bool preFader = false;
    };
    std::vector<SendConfig> sends;
    
    // Pre-allocated buffer for FX processing when plugin needs more channels
    // than our 2-channel track buffer (avoids heap allocation on audio thread)
    juce::AudioBuffer<float> fxProcessBuffer;

    // Mix (Phase 1)
    float trackVolumeDB = 0.0f;  // -60 to +12 dB
    float trackPan = 0.0f;        // -1.0 (L) to +1.0 (R)

    // Cached pan gains — pre-computed in setPan()/setVolume(), avoids trig on audio thread
    std::atomic<float> cachedPanL { 0.707107f };  // cos(pi/4) for center pan
    std::atomic<float> cachedPanR { 0.707107f };  // sin(pi/4) for center pan
    void recomputePanGains();
    
    // Track Type & MIDI (Phase 2)
    TrackType trackType = TrackType::Audio;
    juce::String midiInputDevice;
    int midiChannel = 0;  // 0 = all channels, 1-16 = specific channel
    std::unique_ptr<juce::AudioPluginInstance> instrumentPlugin;
    juce::MidiBuffer midiBuffer;  // For MIDI event storage

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackProcessor)
};
