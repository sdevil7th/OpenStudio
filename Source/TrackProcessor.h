#pragma once

#include <JuceHeader.h>
#include "AutomationList.h"
#include "BuiltInEffects.h"
#include <map>

// Track type enumeration
enum class TrackType
{
    Audio,       // Audio-only track
    MIDI,        // MIDI-only track (no instrument)
    Instrument   // MIDI track with VST instrument
};

// Pan law options
enum class PanLaw
{
    ConstantPower,  // -3dB at center (cos/sin)
    Minus4_5dB,     // Blend between constant power and linear
    Minus6dB,       // Linear pan law (-6dB at center)
    Linear          // 0dB at center (no center attenuation)
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
    void setRecordArmed(bool armed) { if (!isRecordSafe) isRecordArmed = armed; }
    bool getRecordArmed() const { return isRecordArmed; }

    void setRecordSafe(bool safe) { isRecordSafe = safe; if (safe) isRecordArmed = false; }
    bool getRecordSafe() const { return isRecordSafe; }
    
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
    
    // Sidechain Routing (Phase 4.4)
    void setSidechainSource(int pluginIndex, const juce::String& sourceTrackId);
    void clearSidechainSource(int pluginIndex);
    juce::String getSidechainSource(int pluginIndex) const;
    void setSidechainBuffer(const juce::AudioBuffer<float>* buffer);
    bool hasAnySidechainSources() const;

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

    // Pan Law
    void setPanLaw(PanLaw law) { panLaw = law; recomputePanGains(); }
    PanLaw getPanLaw() const { return panLaw; }
    
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

    // Plugin Delay Compensation (PDC)
    int getChainLatency() const;
    void setPDCDelay(int delaySamples);
    int getPDCDelay() const { return pdcDelaySamples; }

    // DC Offset Removal
    void setDCOffsetRemoval(bool enabled) { dcOffsetRemoval = enabled; }
    bool getDCOffsetRemoval() const { return dcOffsetRemoval; }

    // Channel Strip EQ — always-available inline parametric EQ (not a plugin slot)
    void setChannelStripEQEnabled(bool enabled) { channelStripEQEnabled = enabled; }
    bool getChannelStripEQEnabled() const { return channelStripEQEnabled; }
    S13EQ* getChannelStripEQ() { return &channelStripEQ; }
    void setChannelStripEQParam(int paramIndex, float value);
    float getChannelStripEQParam(int paramIndex) const;

    // Automation (Phase 1.1)
    // Each track has automation for volume and pan. Plugin param automation
    // uses the paramId "plugin-{index}-param-{paramIndex}" key in AudioEngine's
    // per-track automation map — TrackProcessor only handles volume + pan.
    AutomationList& getVolumeAutomation() { return volumeAutomation; }
    AutomationList& getPanAutomation() { return panAutomation; }
    const AutomationList& getVolumeAutomation() const { return volumeAutomation; }
    const AutomationList& getPanAutomation() const { return panAutomation; }

    // Set the current timeline position for this block (called by AudioEngine
    // before processBlock so automation knows where it is on the timeline).
    void setCurrentBlockPosition(double samplePosition, double sRate)
    {
        blockStartSample = samplePosition;
        blockSampleRate = sRate;
    }

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
    bool isRecordSafe = false;  // Phase 3.3 — prevents arming
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

    // Sidechain Routing (Phase 4.4)
    // Maps trackFX plugin index -> source track ID that provides sidechain audio.
    // Set from the message thread, read from the audio thread.
    std::map<int, juce::String> sidechainSources;
    // Pointer to the sidechain input buffer, set by AudioEngine before processBlock.
    // Lifetime is managed by AudioEngine (points to a buffer that lives for the
    // duration of the audio callback). Null when no sidechain data is available.
    const juce::AudioBuffer<float>* sidechainInputBuffer = nullptr;

    // Mix (Phase 1)
    float trackVolumeDB = 0.0f;  // -60 to +12 dB
    float trackPan = 0.0f;        // -1.0 (L) to +1.0 (R)

    // Pan Law
    PanLaw panLaw { PanLaw::ConstantPower };

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

    // Automation (Phase 1.1)
    AutomationList volumeAutomation;
    AutomationList panAutomation;
    double blockStartSample { 0.0 };  // Set by AudioEngine before processBlock
    double blockSampleRate { 44100.0 };

    // Pre-allocated buffer for per-sample automation gain (avoids alloc on audio thread)
    juce::AudioBuffer<float> automationGainBuffer;

    // Plugin Delay Compensation (PDC)
    juce::dsp::DelayLine<float> pdcDelayLine { 96000 };  // max 2 seconds at 48kHz
    int pdcDelaySamples { 0 };

    // DC Offset Removal
    bool dcOffsetRemoval { false };
    float dcFilterStateL { 0.0f };
    float dcFilterStateR { 0.0f };
    float dcPrevInputL { 0.0f };
    float dcPrevInputR { 0.0f };

    // Channel Strip EQ
    S13EQ channelStripEQ;
    bool channelStripEQEnabled { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackProcessor)
};
