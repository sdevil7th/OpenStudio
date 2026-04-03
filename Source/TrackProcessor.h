#pragma once

#include <JuceHeader.h>
#include "AutomationList.h"
#include "BuiltInEffects.h"
#include "ARAHostController.h"
#include <map>
#include <array>

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

enum class ProcessingPrecisionMode
{
    Float32,
    Hybrid64
};

class TrackProcessor  : public juce::AudioProcessor
{
public:
    struct ARAProcessDebugInfo
    {
        uint64 callbackCounter = 0;
        bool firstCallbackAfterTransportStart = false;
        double callbackStartWallTimeMs = 0.0;
    };

    struct ScheduledMIDIEvent
    {
        double timestampSeconds = 0.0;
        juce::MidiMessage message;
    };

    struct ScheduledMIDIClip
    {
        juce::String clipId;
        double startTime = 0.0;
        double duration = 0.0;
        std::vector<ScheduledMIDIEvent> events;
    };

    struct RealtimeSendInfo
    {
        juce::String destTrackId;
        float level = 0.0f;
        float pan = 0.0f;
        bool enabled = false;
        bool preFader = false;
        bool phaseInvert = false;
    };

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
    bool isClipLatched() const { return clipLatched.load(std::memory_order_relaxed); }
    void resetClipLatch() { clipLatched.store(false, std::memory_order_relaxed); }
    
    // Recording & Monitoring (Phase 1)
    void setRecordArmed(bool armed) { if (!isRecordSafe) isRecordArmed = armed; }
    bool getRecordArmed() const { return isRecordArmed; }

    void setRecordSafe(bool safe) { isRecordSafe = safe; if (safe) isRecordArmed = false; }
    bool getRecordSafe() const { return isRecordSafe; }
    
    void setInputMonitoring(bool enabled) { isInputMonitoringEnabled.store(enabled, std::memory_order_release); }
    bool getInputMonitoring() const { return isInputMonitoringEnabled.load(std::memory_order_acquire); }
    
    void setInputChannels(int startChannel, int numChannels);
    int getInputStartChannel() const { return inputStartChannel.load(std::memory_order_acquire); }
    int getInputChannelCount() const { return inputChannelCount.load(std::memory_order_acquire); }
    
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
    std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> getInputFXSnapshot() const;
    std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> getTrackFXSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getInputFXBypassSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getTrackFXBypassSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getInputFXPrecisionOverrideSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getTrackFXPrecisionOverrideSnapshot() const;
    
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
    int getNumSends() const;
    juce::String getSendDestination(int sendIndex) const;
    float getSendLevel(int sendIndex) const;
    float getSendPan(int sendIndex) const;
    bool getSendEnabled(int sendIndex) const;
    bool getSendPreFader(int sendIndex) const;

    void setSendPhaseInvert(int sendIndex, bool invert);
    bool getSendPhaseInvert(int sendIndex) const;

    /** Fill destBuffer with this track's send contribution (called by AudioEngine) */
    void fillSendBuffer(int sendIndex, const juce::AudioBuffer<float>& preFaderBuf,
                        const juce::AudioBuffer<float>& postFaderBuf,
                        juce::AudioBuffer<float>& destBuffer, int numSamples) const;

    /** Pre-fader buffer (captured during processBlock, before volume/pan) */
    const juce::AudioBuffer<float>& getPreFaderBuffer() const { return preFaderBuffer; }
    
    // Volume & Pan
    void setVolume(float newVolume);
    void setPan(float newPan);  // -1.0 (L) to 1.0 (R)
    float getVolume() const { return trackVolumeDB.load(std::memory_order_relaxed); }  // Returns dB value
    float getPan() const { return trackPan.load(std::memory_order_relaxed); }

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
    void setTrackType(TrackType newType) { trackType.store(newType, std::memory_order_release); }
    TrackType getTrackType() const { return trackType.load(std::memory_order_acquire); }
    
    // MIDI Configuration (Phase 2)
    void setMIDIInputDevice(const juce::String& device) { midiInputDevice = device; }
    juce::String getMIDIInputDevice() const { return midiInputDevice; }
    
    void setMIDIChannel(int channel) { midiChannel = juce::jlimit(0, 16, channel); } // 0 = all, 1-16 = specific
    int getMIDIChannel() const { return midiChannel; }
    
    // Instrument plugin (Phase 2)
    void setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin, double callerSampleRate = 0.0, int callerBlockSize = 0);
    juce::AudioPluginInstance* getInstrument() const { return instrumentPlugin.get(); }

    // MIDI intake / scheduling
    bool enqueueMidiMessage(const juce::MidiMessage& message, int sampleOffset = 0);
    void setScheduledMIDIClips(std::vector<ScheduledMIDIClip> clips);
    void buildMidiBuffer(juce::MidiBuffer& destination, double blockStartTimeSeconds,
                         int numSamples, double sampleRate, bool playing);
    bool needsProcessing(double blockStartTimeSeconds, int numSamples, double sampleRate, bool playing) const;
    void queueAllNotesOff();
    std::vector<juce::String> getSidechainSourceSnapshot() const;
    std::vector<RealtimeSendInfo> getRealtimeSendSnapshot() const;
    int getMidiOverflowCount() const { return midiQueueOverflowCount.load(std::memory_order_relaxed); }
    int getLastBuiltMidiEventCount() const { return lastBuiltMidiEventCount.load(std::memory_order_relaxed); }
    int getMaxBuiltMidiEventCount() const { return maxBuiltMidiEventCount.load(std::memory_order_relaxed); }
    int getRealtimeFallbackReuseCount() const { return realtimeFallbackReuseCount.load(std::memory_order_relaxed); }

    void setProcessingPrecisionMode(ProcessingPrecisionMode mode);
    ProcessingPrecisionMode getProcessingPrecisionMode() const { return processingPrecisionMode; }
    void setInputFXPrecisionOverride(int index, bool forceFloat);
    void setTrackFXPrecisionOverride(int index, bool forceFloat);
    void setInstrumentPrecisionOverride(bool forceFloat);
    bool getInputFXPrecisionOverride(int index) const;
    bool getTrackFXPrecisionOverride(int index) const;
    bool getInstrumentPrecisionOverride() const { return instrumentForceFloatOverride.load(std::memory_order_acquire); }
    bool getInputFXBypassed(int index) const;
    bool getTrackFXBypassed(int index) const;

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

    // Phase Invert (polarity flip)
    void setPhaseInvert(bool invert) { phaseInverted.store(invert); }
    bool getPhaseInvert() const { return phaseInverted.load(); }

    // Stereo Width (M/S processing, 0-200%, 100% = normal)
    void setStereoWidth(float widthPercent) { stereoWidth.store(juce::jlimit(0.0f, 200.0f, widthPercent)); }
    float getStereoWidth() const { return stereoWidth.load(); }

    // Master Send Enable (whether this track routes to master bus)
    void setMasterSendEnabled(bool enabled) { masterSendEnabled.store(enabled); }
    bool getMasterSendEnabled() const { return masterSendEnabled.load(); }

    // Output Channel Routing (which hardware output channels this track targets)
    void setOutputChannels(int startChannel, int numChannels);
    int getOutputStartChannel() const { return outputStartChannel.load(std::memory_order_acquire); }
    int getOutputChannelCount() const { return outputChannelCount.load(std::memory_order_acquire); }

    // Media Playback Offset (milliseconds, positive = delay)
    void setPlaybackOffset(double offsetMs) { playbackOffsetMs.store(offsetMs); }
    double getPlaybackOffset() const { return playbackOffsetMs.load(); }

    // Track Channel Count (internal processing channels, informational for now)
    void setTrackChannelCount(int numChannels) { trackChannelCount = juce::jlimit(1, 8, numChannels); }
    int getTrackChannelCount() const { return trackChannelCount; }

    // Per-track MIDI Output
    void setMIDIOutputDevice(const juce::String& deviceName);
    juce::String getMIDIOutputDeviceName() const { return midiOutputDeviceName; }
    void sendMIDIToOutput(const juce::MidiBuffer& buffer);

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

    bool tryProcessBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&);

    // ARA Plugin Hosting (Phase 9)
    // Initialize ARA hosting for an FX plugin at the given index
    bool initializeARA(int fxIndex, double sampleRate, int blockSize,
                       std::function<void(bool, bool, const juce::String&)> onComplete = nullptr);
    // Check if this track has an active ARA session
    bool hasActiveARA() const { return araController != nullptr && araController->isActive(); }
    // Get the ARA controller (for adding sources, etc.)
    ARAHostController* getARAController() { return araController.get(); }
    int getARAFXIndex() const { return araFXIndex; }
    void setARAPlaybackRequestHandlers(ARAHostController::PlaybackRequestHandlers handlers);
    float getARAAnalysisProgress() const;
    bool isARAAnalysisComplete() const;
    ARAHostController::DebugSnapshot getARADebugSnapshot() const;
    void setCurrentAudioCallbackDebugInfo(const ARAProcessDebugInfo& info);
    void noteARATransportPlaybackStateChanged(const juce::String& trackId, bool playing, double positionSeconds,
                                              bool editorFocusedAtPlayStart);
    int getARALastAttemptFXIndex() const { return araLastAttemptFXIndex.load(std::memory_order_acquire); }
    bool isARALastAttemptComplete() const { return araLastAttemptComplete.load(std::memory_order_acquire); }
    bool wasARALastAttemptForARAPlugin() const { return araLastAttemptWasARAPlugin.load(std::memory_order_acquire); }
    bool didARALastAttemptSucceed() const { return araLastAttemptSucceeded.load(std::memory_order_acquire); }
    juce::String getARALastAttemptError() const;
    // Shutdown ARA (when plugin is removed or track deleted)
    void shutdownARA();

private:
    void processBlockInternal(juce::AudioBuffer<float>&, juce::MidiBuffer&);
    void publishRealtimeStateSnapshots();

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
    std::atomic<bool> clipLatched { false };
    
    // Recording state (Phase 1)
    bool isRecordArmed = false;
    bool isRecordSafe = false;  // Phase 3.3 — prevents arming
    std::atomic<bool> isInputMonitoringEnabled { false };
    std::atomic<int> inputStartChannel { 0 };    // Hardware input start (0-based)
    std::atomic<int> inputChannelCount { 2 };     // Stereo by default
    
    // Mute/Solo state (atomic: set from message thread, read from audio thread)
    std::atomic<bool> isMuted { false };
    std::atomic<bool> isSoloed { false };
    
    // FX Chains (Phase 3) — stored directly, no AudioProcessorGraph wrapper
    using ProcessorPtr = std::shared_ptr<juce::AudioProcessor>;
    using ProcessorSnapshot = std::vector<ProcessorPtr>;
    using SidechainSourceSnapshot = std::map<int, juce::String>;
    using BypassSnapshot = std::map<int, bool>;
    using PrecisionOverrideSnapshot = std::map<int, bool>;

    std::vector<ProcessorPtr> inputFXPlugins;  // Pre-recording FX
    std::vector<ProcessorPtr> trackFXPlugins;  // Playback FX
    
    // Sends (Phase 4 / Phase 11)
    struct SendConfig
    {
        juce::String destTrackId;
        float level = 0.5f;
        float pan = 0.0f;
        bool enabled = true;
        bool preFader = false;
        bool phaseInvert = false;
    };
    using SendSnapshot = std::vector<SendConfig>;
    std::vector<SendConfig> sends;
    std::map<int, bool> inputFXForceFloatOverrides;
    std::map<int, bool> trackFXForceFloatOverrides;
    std::map<int, bool> inputFXBypassedState;
    std::map<int, bool> trackFXBypassedState;
    std::atomic<bool> instrumentForceFloatOverride { false };
    
    // Pre-allocated buffer for FX processing when plugin needs more channels
    // than our 2-channel track buffer (avoids heap allocation on audio thread)
    juce::AudioBuffer<float> fxProcessBuffer;
    juce::AudioBuffer<double> fxProcessBufferDouble;

    // Sidechain Routing (Phase 4.4)
    // Maps trackFX plugin index -> source track ID that provides sidechain audio.
    // Set from the message thread, read from the audio thread.
    std::map<int, juce::String> sidechainSources;
    // Pointer to the sidechain input buffer, set by AudioEngine before processBlock.
    // Lifetime is managed by AudioEngine (points to a buffer that lives for the
    // duration of the audio callback). Null when no sidechain data is available.
    const juce::AudioBuffer<float>* sidechainInputBuffer = nullptr;

    // Mix (Phase 1)
    std::atomic<float> trackVolumeDB { 0.0f };  // -60 to +12 dB
    std::atomic<float> trackPan { 0.0f };        // -1.0 (L) to +1.0 (R)

    // Pan Law
    PanLaw panLaw { PanLaw::Linear };

    // Cached pan gains — pre-computed in setPan()/setVolume(), avoids trig on audio thread
    std::atomic<float> cachedPanL { 1.0f };
    std::atomic<float> cachedPanR { 1.0f };
    void recomputePanGains();
    
    // Track Type & MIDI (Phase 2)
    std::atomic<TrackType> trackType { TrackType::Audio };
    juce::String midiInputDevice;
    int midiChannel = 0;  // 0 = all channels, 1-16 = specific channel
    std::shared_ptr<juce::AudioPluginInstance> instrumentPlugin;
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
    std::atomic<int> pdcDelaySamples { 0 };
    std::atomic<bool> pdcDelayDirty { false };

    // DC Offset Removal
    bool dcOffsetRemoval { false };
    float dcFilterStateL { 0.0f };
    float dcFilterStateR { 0.0f };
    float dcPrevInputL { 0.0f };
    float dcPrevInputR { 0.0f };

    // Channel Strip EQ
    S13EQ channelStripEQ;
    bool channelStripEQEnabled { false };

    // Phase Invert
    std::atomic<bool> phaseInverted { false };

    // Stereo Width (0-200%, 100% = normal stereo)
    std::atomic<float> stereoWidth { 100.0f };

    // Master Send Enable
    std::atomic<bool> masterSendEnabled { true };

    // Output Channel Routing
    std::atomic<int> outputStartChannel { 0 };
    std::atomic<int> outputChannelCount { 2 };

    // Media Playback Offset (ms)
    std::atomic<double> playbackOffsetMs { 0.0 };

    // Track Channel Count (informational)
    int trackChannelCount { 2 };

    // Pre-fader buffer (captured during processBlock for pre-fader sends)
    juce::AudioBuffer<float> preFaderBuffer;

    // Per-track MIDI Output
    juce::String midiOutputDeviceName;
    std::unique_ptr<juce::MidiOutput> midiOutputDevice;
    juce::AudioBuffer<float> realtimeFallbackBuffer;
    std::atomic<int> realtimeFallbackReuseCount { 0 };

    struct PendingMIDIEvent
    {
        juce::MidiMessage message;
        int sampleOffset = 0;
    };

    static constexpr int MIDI_QUEUE_CAPACITY = 2048;
    std::array<PendingMIDIEvent, MIDI_QUEUE_CAPACITY> pendingMidiQueue {};
    std::atomic<int> midiQueueReadIndex { 0 };
    std::atomic<int> midiQueueWriteIndex { 0 };
    std::atomic<int> midiQueueOverflowCount { 0 };
    std::atomic<int> lastBuiltMidiEventCount { 0 };
    std::atomic<int> maxBuiltMidiEventCount { 0 };

    std::shared_ptr<const std::vector<ScheduledMIDIClip>> scheduledMIDIClips {
        std::make_shared<const std::vector<ScheduledMIDIClip>>()
    };
    std::shared_ptr<const ProcessorSnapshot> realtimeInputFXSnapshot {
        std::make_shared<const ProcessorSnapshot>()
    };
    std::shared_ptr<const ProcessorSnapshot> realtimeTrackFXSnapshot {
        std::make_shared<const ProcessorSnapshot>()
    };
    std::shared_ptr<const BypassSnapshot> realtimeInputFXBypassSnapshot {
        std::make_shared<const BypassSnapshot>()
    };
    std::shared_ptr<const BypassSnapshot> realtimeTrackFXBypassSnapshot {
        std::make_shared<const BypassSnapshot>()
    };
    std::shared_ptr<const PrecisionOverrideSnapshot> realtimeInputFXPrecisionOverrideSnapshot {
        std::make_shared<const PrecisionOverrideSnapshot>()
    };
    std::shared_ptr<const PrecisionOverrideSnapshot> realtimeTrackFXPrecisionOverrideSnapshot {
        std::make_shared<const PrecisionOverrideSnapshot>()
    };
    std::shared_ptr<juce::AudioProcessor> realtimeInstrumentSnapshot;
    std::shared_ptr<const SidechainSourceSnapshot> realtimeSidechainSnapshot {
        std::make_shared<const SidechainSourceSnapshot>()
    };
    std::shared_ptr<const SendSnapshot> realtimeSendSnapshot {
        std::make_shared<const SendSnapshot>()
    };
    std::array<std::array<bool, 128>, 16> activeMIDINotes {};
    ProcessingPrecisionMode processingPrecisionMode { ProcessingPrecisionMode::Float32 };

    void markActiveMIDINoteState(const juce::MidiMessage& message);
    void appendScheduledMIDIToBuffer(juce::MidiBuffer& destination, double blockStartTimeSeconds,
                                     int numSamples, double sampleRate) const;
    void appendQueuedMIDIToBuffer(juce::MidiBuffer& destination, int numSamples);
    bool hasQueuedMIDI() const;
    bool hasScheduledMIDIInBlock(double blockStartTimeSeconds, int numSamples, double sampleRate) const;

    // ARA Plugin Hosting (Phase 9)
    mutable juce::CriticalSection araStatusLock;
    std::unique_ptr<ARAHostController> araController;
    ARAHostController::PlaybackRequestHandlers araPlaybackRequestHandlers;
    int araFXIndex = -1;  // Which FX slot has ARA active (-1 = none)
    std::atomic<int> araLastAttemptFXIndex { -1 };
    std::atomic<bool> araLastAttemptComplete { false };
    std::atomic<bool> araLastAttemptWasARAPlugin { false };
    std::atomic<bool> araLastAttemptSucceeded { false };
    juce::String araLastAttemptError;
    ARAProcessDebugInfo currentARAProcessDebugInfo;
    juce::String araDebugTrackId;
    std::atomic<uint64> araPlaybackRunCounter { 0 };
    std::atomic<uint64> araLastSlowLogPlaybackRun { 0 };
    std::atomic<bool> araStructuredPlaySessionLogged { false };
    std::atomic<bool> araTransportPlayingDebugState { false };
    std::atomic<bool> araEditorFocusedAtPlaybackStart { false };

    void updateARAAttemptStatus(int fxIndex, bool completed, bool wasARAPlugin,
                                bool succeeded, const juce::String& errorMessage);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackProcessor)
};
