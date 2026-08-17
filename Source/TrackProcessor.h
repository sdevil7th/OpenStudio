#pragma once

#include <JuceHeader.h>
#include "AutomationList.h"
#include "BuiltInParameterSupport.h"
#include "BuiltInEffects.h"
#include "ARAHostController.h"
#include <map>
#include <array>
#include <limits>
#include <optional>

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

class TrackMIDIOutputDispatcher;

class TrackProcessor  : public juce::AudioProcessor,
                        private juce::Timer
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
        float leftGain = 0.0f;
        float rightGain = 0.0f;
        bool enabled = false;
        bool preFader = false;
        bool phaseInvert = false;
    };

    struct AutomationTarget
    {
        enum class Kind
        {
            Volume,
            Pan,
            Width,
            PreFXVolume,
            PreFXPan,
            PreFXWidth,
            TrimVolume,
            Mute,
            PluginParameter,
            MIDIVelocityScale,
            MIDIPitchBend,
            MIDIChannelPressure,
            MIDICC
        };

        Kind kind = Kind::Volume;
        AutomationList* list = nullptr;
        bool isInputFX = false;
        int fxIndex = -1;
        int paramIndex = -1;
        juce::String builtInParamId;
        int midiCC = -1;
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
    double getOfflineRenderTailLengthSeconds() const;

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
    void setRecordArmed(bool armed)
    {
        if (! isRecordSafe.load(std::memory_order_acquire))
            isRecordArmed.store(armed, std::memory_order_release);
    }
    bool getRecordArmed() const
    {
        return isRecordArmed.load(std::memory_order_acquire);
    }

    void setRecordSafe(bool safe)
    {
        isRecordSafe.store(safe, std::memory_order_release);
        if (safe)
            isRecordArmed.store(false, std::memory_order_release);
    }
    bool getRecordSafe() const
    {
        return isRecordSafe.load(std::memory_order_acquire);
    }
    
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
    const juce::AudioProcessor* getInputFXProcessor(int index) const;
    juce::AudioProcessor* getTrackFXProcessor(int index);
    const juce::AudioProcessor* getTrackFXProcessor(int index) const;
    std::shared_ptr<juce::AudioProcessor> getInputFXProcessorShared(int index) const;
    std::shared_ptr<juce::AudioProcessor> getTrackFXProcessorShared(int index) const;
    std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> getInputFXSnapshot() const;
    std::shared_ptr<const std::vector<std::shared_ptr<juce::AudioProcessor>>> getTrackFXSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getInputFXBypassSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getTrackFXBypassSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getInputFXPrecisionOverrideSnapshot() const;
    std::shared_ptr<const std::map<int, bool>> getTrackFXPrecisionOverrideSnapshot() const;
    // Called from the control thread when hosted latency may have changed.
    // Publishes resized immutable delay storage without touching callback-owned
    // ring positions.
    void refreshHostBypassDelayStorage();
    
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
    void setPanLaw(PanLaw law)
    {
        panLaw.store(law, std::memory_order_release);
        recomputePanGains();
    }
    PanLaw getPanLaw() const
    {
        return panLaw.load(std::memory_order_acquire);
    }
    
    // Mute/Solo
    void setMute(bool shouldMute);
    void setSolo(bool shouldSolo);
    bool isMute() const { return isMuted.load(); }
    bool isSolo() const { return isSoloed.load(); }
    bool getMute() const { return isMuted.load(); }  // Alias for compatibility
    bool getSolo() const { return isSoloed.load(); }  // Alias for compatibility
    
    // Track Type (Phase 2 - MIDI)
    void setTrackType(TrackType newType)
    {
        trackType.store(newType, std::memory_order_release);
        fallbackInstrumentResetRequested.store(true, std::memory_order_release);
    }
    TrackType getTrackType() const { return trackType.load(std::memory_order_acquire); }
    
    // MIDI Configuration (Phase 2)
    void setMIDIInputDevice(const juce::String& device) { midiInputDevice = device; }
    juce::String getMIDIInputDevice() const { return midiInputDevice; }
    
    void setMIDIChannel(int channel)
    {
        midiChannel.store(
            juce::jlimit(0, 16, channel),
            std::memory_order_release);
    } // 0 = all, 1-16 = specific
    int getMIDIChannel() const
    {
        return midiChannel.load(std::memory_order_acquire);
    }
    
    // Instrument plugin (Phase 2)
    void setInstrument(std::unique_ptr<juce::AudioPluginInstance> plugin, double callerSampleRate = 0.0, int callerBlockSize = 0);
    void clearInstrument();
    juce::AudioPluginInstance* getInstrument() const { return instrumentPlugin.get(); }
    std::shared_ptr<juce::AudioPluginInstance> getInstrumentShared() const { return instrumentPlugin; }
    bool isUsingFallbackInstrument() const;
    bool loadFallbackSamplerSample(const juce::String& filePath, int rootNote);
    void clearFallbackSamplerSample();
    bool hasFallbackSamplerSample() const;
    juce::String getFallbackSamplerSamplePath() const;
    float getFallbackInstrumentParam(const juce::String& paramId) const;
    bool setFallbackInstrumentParam(const juce::String& paramId, float value);
    struct MIDINoteActivity
    {
        int note = 0;
        int channel = 1;
        int velocity = 0;
        bool active = false;
        juce::uint32 ageMs = 0;
    };
    std::vector<MIDINoteActivity> getRecentMIDINoteActivity(juce::uint32 maxAgeMs) const;

    // MIDI intake / scheduling
    bool enqueueMidiMessage(const juce::MidiMessage& message, int sampleOffset = 0);
    void setScheduledMIDIClips(std::vector<ScheduledMIDIClip> clips);
    void buildMidiBuffer(juce::MidiBuffer& destination, double blockTimeSeconds,
                         int numSamples, double sampleRate, bool playing);
    bool needsProcessing(double blockTimeSeconds, int numSamples, double sampleRate, bool playing) const;
    void queueAllNotesOff(bool requestChase = true);
    void requestMIDIChase() { scheduledMIDIChaseRequested.store(true, std::memory_order_release); }
    std::vector<juce::String> getSidechainSourceSnapshot() const;
    std::vector<RealtimeSendInfo> getRealtimeSendSnapshot() const;
    int getMidiOverflowCount() const { return midiQueueOverflowCount.load(std::memory_order_relaxed); }
    int getLastBuiltMidiEventCount() const { return lastBuiltMidiEventCount.load(std::memory_order_relaxed); }
    int getMaxBuiltMidiEventCount() const { return maxBuiltMidiEventCount.load(std::memory_order_relaxed); }
    std::vector<ScheduledMIDIClip> getScheduledMIDIClipSnapshot() const;
    int getScheduledMIDIClipCount() const;
    int getScheduledMIDIEventCount() const;
    int getRealtimeFallbackReuseCount() const { return realtimeFallbackReuseCount.load(std::memory_order_relaxed); }
    int getPluginBusySkipCount() const { return pluginBusySkipCount.load(std::memory_order_relaxed); }

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
    void resetPDCDelayState();
    void resetOfflineRenderState();
    void invalidatePluginAutomationCache() noexcept;

    // DC Offset Removal
    void setDCOffsetRemoval(bool enabled)
    {
        dcOffsetRemoval.store(enabled, std::memory_order_release);
    }
    bool getDCOffsetRemoval() const
    {
        return dcOffsetRemoval.load(std::memory_order_acquire);
    }

    // Channel Strip EQ — always-available inline parametric EQ (not a plugin slot)
    void setChannelStripEQEnabled(bool enabled)
    {
        channelStripEQEnabled.store(enabled, std::memory_order_release);
        channelStripEQ.setPowerEnabled(enabled);
    }
    bool getChannelStripEQEnabled() const
    {
        return channelStripEQEnabled.load(std::memory_order_acquire);
    }
    S13EQ* getChannelStripEQ() { return &channelStripEQ; }
    void setChannelStripEQParam(int paramIndex, float value);
    float getChannelStripEQParam(int paramIndex) const;

    // Stable bridge indices used by the six-control Channel Strip EQ surface.
    // These are deliberately independent of AudioProcessor's parameter list so
    // the inline strip cannot silently become a no-op when S13EQ is hosted
    // directly rather than as a plug-in instance.
    static constexpr int channelStripEQBandCount = 6;
    static constexpr int channelStripEQValuesPerBand = 4;

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
    juce::String getMIDIOutputDeviceName() const;
    bool hasMIDIOutputDevice() const noexcept;
    void sendMIDIToOutput(const juce::MidiBuffer& buffer, double sampleRate, bool resetMessagesOnly = false);

    // Automation
    AutomationList& getVolumeAutomation() { return volumeAutomation; }
    AutomationList& getPanAutomation() { return panAutomation; }
    AutomationList& getWidthAutomation() { return widthAutomation; }
    AutomationList& getPreFXVolumeAutomation() { return preFXVolumeAutomation; }
    AutomationList& getPreFXPanAutomation() { return preFXPanAutomation; }
    AutomationList& getPreFXWidthAutomation() { return preFXWidthAutomation; }
    AutomationList& getTrimVolumeAutomation() { return trimVolumeAutomation; }
    AutomationList& getMuteAutomation() { return muteAutomation; }
    AutomationList& getMIDIVelocityScaleAutomation() { return midiVelocityScaleAutomation; }
    AutomationList& getMIDIPitchBendAutomation() { return midiPitchBendAutomation; }
    AutomationList& getMIDIChannelPressureAutomation() { return midiChannelPressureAutomation; }
    const AutomationList& getVolumeAutomation() const { return volumeAutomation; }
    const AutomationList& getPanAutomation() const { return panAutomation; }
    const AutomationList& getWidthAutomation() const { return widthAutomation; }
    const AutomationList& getPreFXVolumeAutomation() const { return preFXVolumeAutomation; }
    const AutomationList& getPreFXPanAutomation() const { return preFXPanAutomation; }
    const AutomationList& getPreFXWidthAutomation() const { return preFXWidthAutomation; }
    const AutomationList& getTrimVolumeAutomation() const { return trimVolumeAutomation; }
    const AutomationList& getMuteAutomation() const { return muteAutomation; }
    const AutomationList& getMIDIVelocityScaleAutomation() const { return midiVelocityScaleAutomation; }
    const AutomationList& getMIDIPitchBendAutomation() const { return midiPitchBendAutomation; }
    const AutomationList& getMIDIChannelPressureAutomation() const { return midiChannelPressureAutomation; }
    bool hasPluginAutomation() const;
    bool hasMIDIAutomation() const;
    std::optional<AutomationTarget> resolveAutomationTarget(const juce::String& parameterId, bool createIfNeeded);
    float getAutomationDefaultValue(const AutomationTarget& target) const;
    void resetAutomationTouchState();

    // Set the current timeline position for this block (called by AudioEngine
    // before processBlock so automation knows where it is on the timeline).
    void setCurrentBlockPosition(double timeSeconds)
    {
        blockStartTimeSeconds = timeSeconds;
    }
    void setIgnoreStaticMuteForProcessing(bool ignore) { ignoreStaticMuteDuringProcessing.store(ignore, std::memory_order_relaxed); }
    void setForceAutomationReadForProcessing(bool forceRead) { forceAutomationReadDuringProcessing.store(forceRead, std::memory_order_relaxed); }

    bool tryProcessBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&);

    // ARA Plugin Hosting (Phase 9)
    // Initialize ARA hosting for an FX plugin at the given index
    bool initializeARA(int fxIndex, double sampleRate, int blockSize,
                       std::function<void(bool, bool, const juce::String&)> onComplete = nullptr);
    // Check if this track has an active ARA session
    bool hasActiveARA() const
    {
        return araFXIndexForRealtime.load(
                   std::memory_order_acquire)
            >= 0;
    }
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
    // Native deterministic regressions exercise the realtime tail-service
    // state machine, including its control-thread timer handoff.
    friend class AudioEngine;
    friend class NAMDelayRegression;

    struct FallbackSamplerSample;

    struct PluginAutomationRoute
    {
        juce::String parameterId;
        bool isInputFX = false;
        int fxIndex = -1;
        int paramIndex = -1;
        juce::String builtInParamId;
        float builtInMinimum = 0.0f;
        float builtInMaximum = 1.0f;
        bool builtInDiscrete = false;
        OpenStudioBuiltInParameterCurve builtInCurve =
            OpenStudioBuiltInParameterCurve::linear;
        std::shared_ptr<AutomationList> automation = std::make_shared<AutomationList>();
        std::atomic<float> lastAppliedValue { std::numeric_limits<float>::quiet_NaN() };
    };

    using PluginAutomationRouteSnapshot = std::vector<std::shared_ptr<PluginAutomationRoute>>;

    struct MIDICCAutomationRoute
    {
        juce::String parameterId;
        int controller = -1;
        std::shared_ptr<AutomationList> automation = std::make_shared<AutomationList>();
    };

    using MIDICCAutomationRouteSnapshot = std::vector<std::shared_ptr<MIDICCAutomationRoute>>;

    struct PluginAutomationParameterRef
    {
        bool isInputFX = false;
        int fxIndex = -1;
        int paramIndex = -1;
        juce::String builtInParamId;
    };

    void processBlockInternal(juce::AudioBuffer<float>&, juce::MidiBuffer&);
    void timerCallback() override;
    void refreshRealtimeFXTailBudgetOnControlThread();
    void resetExpiredRealtimeFXTailOnControlThread();
    void publishRealtimeStateSnapshots();
    void reclaimRetiredRealtimeGraphSnapshots();
    void reclaimRetiredRealtimeAuxOwners();
    void publishFallbackSamplerSample(
        std::shared_ptr<const FallbackSamplerSample> sample);
    void publishScheduledMIDIClips(
        std::shared_ptr<const std::vector<ScheduledMIDIClip>> snapshot);
    void reclaimRetiredScheduledMIDISnapshots();
    void resetFXContinuityStates() noexcept;
    void publishPluginAutomationRoutes(
        std::shared_ptr<const PluginAutomationRouteSnapshot> snapshot);
    void publishMIDICCAutomationRoutes(
        std::shared_ptr<const MIDICCAutomationRouteSnapshot> snapshot);
    std::shared_ptr<PluginAutomationRoute> getOrCreatePluginAutomationRoute(const juce::String& parameterId);
    std::shared_ptr<PluginAutomationRoute> findPluginAutomationRoute(const juce::String& parameterId) const;
    std::optional<PluginAutomationParameterRef> parsePluginAutomationParameterId(const juce::String& parameterId) const;
    void applyPluginAutomationForProcessor(
        juce::AudioProcessor* proc,
        bool isInputFX,
        int fxIndex,
        double blockTimeSeconds,
        const PluginAutomationRouteSnapshot* routes);
    std::shared_ptr<MIDICCAutomationRoute> getOrCreateMIDICCAutomationRoute(const juce::String& parameterId);
    std::shared_ptr<MIDICCAutomationRoute> findMIDICCAutomationRoute(const juce::String& parameterId) const;
    static std::optional<int> parseMIDICCAutomationParameterId(const juce::String& parameterId);
    void applyMIDIAutomationToBuffer(
        juce::MidiBuffer& destination,
        double blockTimeSeconds,
        int numSamples,
        double sampleRate,
        const MIDICCAutomationRouteSnapshot* ccRoutes);
    bool shouldApplyAutomation(const AutomationList& automation) const;

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
    std::atomic<bool> isRecordArmed { false };
    std::atomic<bool> isRecordSafe { false };  // Phase 3.3 — prevents arming
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
    static constexpr size_t maxRealtimeFXContinuitySlots = 64;
    static constexpr int hostBypassDryChannels = 2;

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
    struct FXBypassDelayStorage
    {
        const juce::AudioProcessor* processor = nullptr;
        juce::AudioBuffer<float> ring;
        // AudioProcessor::getLatencySamples() reads JUCE's non-atomic latency
        // member. Publish the control-thread value explicitly so a NAM model
        // load cannot race this realtime dry-history path.
        std::atomic<int> publishedLatency { 0 };
        int writePosition = 0;
        int currentLatency = 0;
        int targetLatency = 0;
        int latencyRampRemaining = 0;
        int latencyRampLength = 0;
        bool latencyInitialised = false;
    };
    using FXBypassDelayStoragePtr =
        std::shared_ptr<FXBypassDelayStorage>;
    struct RealtimeGraphSnapshot
    {
        uint64 generation = 0;
        ProcessorSnapshot inputFX;
        ProcessorSnapshot trackFX;
        BypassSnapshot inputFXBypass;
        BypassSnapshot trackFXBypass;
        PrecisionOverrideSnapshot inputFXPrecisionOverrides;
        PrecisionOverrideSnapshot trackFXPrecisionOverrides;
        ProcessorPtr instrument;
        SidechainSourceSnapshot sidechainSources;
        SendSnapshot sends;
        std::array<FXBypassDelayStoragePtr,
                   maxRealtimeFXContinuitySlots>
            inputFXBypassDelay;
        std::array<FXBypassDelayStoragePtr,
                   maxRealtimeFXContinuitySlots>
            trackFXBypassDelay;
    };
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
    struct FXContinuityState
    {
        const juce::AudioProcessor* processor = nullptr;
        uint64 graphGeneration = 0;
        std::array<float, 2> lastOutput { 0.0f, 0.0f };
        bool valid = false;
        bool skippedLastBlock = false;
        float hostBypassWetMix = 1.0f;
        bool targetBypassed = false;
        std::array<float, 2> endpointCorrection {
            0.0f, 0.0f
        };
        std::array<float, 2> endpointCorrectionStep {
            0.0f, 0.0f
        };
        int endpointCorrectionSamplesRemaining = 0;
    };
    std::array<FXContinuityState, maxRealtimeFXContinuitySlots>
        inputFXContinuity {};
    std::array<FXContinuityState, maxRealtimeFXContinuitySlots>
        trackFXContinuity {};
    FXContinuityState instrumentContinuity;
    // Every loaded slot feeds its latency-aligned dry history continuously so
    // an eventual bypass transition starts from valid delayed audio. This
    // buffer is separate from fxProcessBuffer because expanded/sidechain
    // processing overwrites that buffer before the dry/wet crossfade.
    juce::AudioBuffer<float> fxBypassDryBuffer;
    float fxBypassRampStep = 1.0f / 882.0f;
    int fxContinuityRampSamples = 353;

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
    std::atomic<PanLaw> panLaw { PanLaw::Linear };

    // Cached pan gains — pre-computed in setPan()/setVolume(), avoids trig on audio thread
    std::atomic<float> cachedPanL { 1.0f };
    std::atomic<float> cachedPanR { 1.0f };
    void recomputePanGains();
    
    // Track Type & MIDI (Phase 2)
    std::atomic<TrackType> trackType { TrackType::Audio };
    juce::String midiInputDevice;
    std::atomic<int> midiChannel { 0 };  // 0 = all channels, 1-16 = specific channel
    std::shared_ptr<juce::AudioPluginInstance> instrumentPlugin;
    juce::MidiBuffer midiBuffer;  // For MIDI event storage

    // Automation
    AutomationList volumeAutomation;
    AutomationList panAutomation;
    AutomationList widthAutomation;
    AutomationList preFXVolumeAutomation;
    AutomationList preFXPanAutomation;
    AutomationList preFXWidthAutomation;
    AutomationList trimVolumeAutomation;
    AutomationList muteAutomation;
    AutomationList midiVelocityScaleAutomation;
    AutomationList midiPitchBendAutomation;
    AutomationList midiChannelPressureAutomation;
    double blockStartTimeSeconds { 0.0 };
    std::atomic<bool> ignoreStaticMuteDuringProcessing { false };
    std::atomic<bool> forceAutomationReadDuringProcessing { false };

    // Pre-allocated buffer for per-sample automation gain (avoids alloc on audio thread)
    juce::AudioBuffer<float> automationGainBuffer;
    juce::CriticalSection pluginAutomationRouteLock;
    std::shared_ptr<const PluginAutomationRouteSnapshot> pluginAutomationSnapshot;
    std::atomic<const PluginAutomationRouteSnapshot*>
        pluginAutomationSnapshotForAudio { nullptr };
    // These flags are published after their corresponding immutable snapshot.
    // Empty tracks can therefore avoid MSVC's process-wide atomic<shared_ptr>
    // lock in the callback; an observed true flag guarantees a visible snapshot.
    std::atomic<bool> hasPublishedPluginAutomationRoutes { false };
    juce::CriticalSection midiAutomationRouteLock;
    std::shared_ptr<const MIDICCAutomationRouteSnapshot> midiCCAutomationSnapshot;
    std::atomic<const MIDICCAutomationRouteSnapshot*>
        midiCCAutomationSnapshotForAudio { nullptr };
    std::atomic<bool> hasPublishedMIDICCAutomationRoutes { false };
    // Automation routes and the fallback sampler are immutable publications.
    // A single callback-reader epoch lets their realtime paths load raw
    // pointers without entering MSVC's process-wide atomic<shared_ptr> lock.
    mutable std::atomic<std::uint32_t>
        realtimeAuxAudioReaders { 0 };
    juce::CriticalSection realtimeAuxPublicationLock;
    juce::CriticalSection realtimeAuxRetirementLock;
    std::vector<std::shared_ptr<const void>>
        retiredRealtimeAuxOwners;

    // Plugin Delay Compensation (PDC)
    juce::dsp::DelayLine<float> pdcDelayLine { 96000 };  // max 2 seconds at 48kHz
    std::atomic<int> pdcDelaySamples { 0 };
    std::atomic<bool> pdcDelayDirty { false };
    int pdcCurrentDelaySamples = 0;
    int pdcTargetDelaySamples = 0;
    int pdcPendingDelaySamples = 0;
    int pdcTransitionSamplesRemaining = 0;
    int pdcTransitionSamplesTotal = 1;

    // DC Offset Removal
    std::atomic<bool> dcOffsetRemoval { false };
    float dcFilterStateL { 0.0f };
    float dcFilterStateR { 0.0f };
    float dcPrevInputL { 0.0f };
    float dcPrevInputR { 0.0f };

    // Channel Strip EQ
    S13EQ channelStripEQ;
    std::atomic<bool> channelStripEQEnabled { false };

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
    // The dispatcher object itself is immutable for the TrackProcessor
    // lifetime. The callback only writes to its pre-allocated SPSC queue;
    // device ownership and operating-system MIDI calls stay on control/sender
    // threads.
    std::unique_ptr<TrackMIDIOutputDispatcher> midiOutputDispatcher;
    juce::AudioBuffer<float> realtimeFallbackBuffer;
    std::atomic<int> realtimeFallbackReuseCount { 0 };
    std::atomic<int> pluginBusySkipCount { 0 };

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
    std::atomic<bool> scheduledMIDIChaseRequested { true };
    // Control threads publish only a request. The callback owns
    // activeMIDINotes and emits the actual reset messages in-order.
    std::atomic<bool> allNotesOffRequested { false };

    std::shared_ptr<const std::vector<ScheduledMIDIClip>> scheduledMIDIClips {
        std::make_shared<const std::vector<ScheduledMIDIClip>>()
    };
    std::atomic<const std::vector<ScheduledMIDIClip>*>
        scheduledMIDIClipsForAudio { nullptr };
    std::atomic<bool> hasScheduledMIDIClipsForAudio { false };
    mutable std::atomic<std::uint32_t>
        scheduledMIDIAudioReaders { 0 };
    juce::CriticalSection scheduledMIDIPublicationLock;
    juce::CriticalSection scheduledMIDIRetirementLock;
    std::vector<std::shared_ptr<const std::vector<ScheduledMIDIClip>>>
        retiredScheduledMIDISnapshots;
    // One immutable publication replaces nine independent atomic<shared_ptr>
    // loads on every track callback. On MSVC those free-function atomics share
    // a process-wide spin lock, so consolidating them materially reduces
    // contention at 16/32-sample buffers.
    std::shared_ptr<const RealtimeGraphSnapshot> realtimeGraphSnapshot {
        std::make_shared<const RealtimeGraphSnapshot>()
    };
    std::atomic<const RealtimeGraphSnapshot*>
        realtimeGraphSnapshotForAudio { nullptr };
    mutable std::atomic<std::uint32_t>
        realtimeGraphAudioReaders { 0 };
    juce::CriticalSection realtimeGraphPublicationLock;
    juce::CriticalSection realtimeGraphRetirementLock;
    std::vector<std::shared_ptr<const RealtimeGraphSnapshot>>
        retiredRealtimeGraphSnapshots;
    std::atomic<uint64> realtimeGraphGeneration { 0 };
    // Audio tracks that lose their live/playback input still need bounded
    // zero-input processing so delays and reverbs drain instead of freezing in
    // memory. The callback owns the integer countdowns below; only the small
    // publication/request fields are shared with the control-thread timer.
    std::atomic<bool> realtimeFXTailActive { false };
    std::atomic<bool> realtimeFXTailResetPending { false };
    std::atomic<uint64> realtimeFXTailActivityGeneration { 0 };
    std::atomic<uint64> realtimeFXTailResetGeneration { 0 };
    std::atomic<int> realtimeFXTailSampleRateHz { 44100 };
    std::atomic<int> realtimeFXTailBudgetSamples { 1367100 }; // 31 s at 44.1 kHz until prepared
    std::atomic<int> realtimeFXTailMinimumDrainSamples { 1323000 }; // 30 s at 44.1 kHz
    int realtimeFXTailHardSamplesRemaining = 0;
    int realtimeFXTailMinimumSamplesRemaining = 0;
    int realtimeFXTailQuietSamples = 0;
    int realtimeFXTailLastPublishedBudgetSamples = 0;
    bool realtimeFXPreviousBlockHadInput = false;
    std::array<std::array<bool, 128>, 16> activeMIDINotes {};
    std::array<std::array<bool, 128>, 16> fallbackInstrumentNoteActive {};
    std::array<std::array<bool, 128>, 16> fallbackInstrumentNoteReleasing {};
    std::array<std::array<float, 128>, 16> fallbackInstrumentPhase {};
    std::array<std::array<float, 128>, 16> fallbackInstrumentPhaseB {};
    std::array<std::array<float, 128>, 16> fallbackInstrumentSubPhase {};
    std::array<std::array<float, 128>, 16> fallbackInstrumentFilterState {};
    std::array<std::array<float, 128>, 16> fallbackInstrumentVelocity {};
    std::array<std::array<float, 128>, 16> fallbackInstrumentEnvelope {};
    std::array<std::array<double, 128>, 16> fallbackSamplerPosition {};
    std::array<std::array<double, 128>, 16> fallbackSamplerIncrement {};
    std::array<float, 16> fallbackInstrumentPitchBend {};
    std::array<float, 16> fallbackInstrumentModulation {};
    std::array<float, 16> fallbackInstrumentModPhase {};
    std::atomic<float> fallbackSynthAttackMs { 8.0f };
    std::atomic<float> fallbackSynthReleaseMs { 180.0f };
    std::atomic<float> fallbackSynthBrightness { 0.62f };
    std::atomic<float> fallbackSynthDetuneCents { 7.0f };
    std::atomic<float> fallbackSynthSubLevel { 0.18f };
    std::atomic<float> fallbackSynthNoiseLevel { 0.015f };
    std::atomic<float> fallbackSynthOutputGainDb { -15.0f };
    std::atomic<float> fallbackInstrumentMode { 0.0f }; // 0=synth, 1=piano, 2=drums
    std::atomic<float> fallbackPianoTone { 0.58f };
    std::atomic<float> fallbackPianoBody { 0.72f };
    std::atomic<float> fallbackDrumKit { 0.0f }; // 0=studio, 1=rock, 2=electronic
    std::atomic<float> fallbackDrumTuning { 0.0f };
    std::atomic<float> fallbackDrumAmbience { 0.18f };
    std::array<std::array<int, 128>, 16> fallbackInstrumentVoiceAgeSamples {};
    std::array<std::array<std::atomic<bool>, 128>, 16> midiNoteCurrentlyActive {};
    std::array<std::array<std::atomic<juce::uint32>, 128>, 16> midiNoteLastOnMs {};
    std::array<std::array<std::atomic<juce::uint32>, 128>, 16> midiNoteLastOffMs {};
    std::array<std::array<std::atomic<int>, 128>, 16> midiNoteLastVelocity {};
    std::atomic<bool> fallbackInstrumentResetRequested { true };
    struct FallbackSamplerSample
    {
        juce::AudioBuffer<float> samples;
        double sourceSampleRate = 44100.0;
        int rootNote = 60;
        juce::String filePath;
    };
    std::shared_ptr<const FallbackSamplerSample> fallbackSamplerSample;
    std::atomic<const FallbackSamplerSample*>
        fallbackSamplerSampleForAudio { nullptr };
    ProcessingPrecisionMode processingPrecisionMode { ProcessingPrecisionMode::Float32 };

    void markActiveMIDINoteState(const juce::MidiMessage& message);
    void clearFallbackInstrumentState();
    bool hasActiveFallbackInstrumentVoices() const;
    void handleFallbackInstrumentMidi(const juce::MidiMessage& message, double sampleRate);
    void renderFallbackInstrument(juce::AudioBuffer<float>& buffer,
                                  const juce::MidiBuffer& midiMessages,
                                  int numSamples,
                                  double sampleRate);
    void appendScheduledMIDIChaseToBuffer(
        juce::MidiBuffer& destination,
        const std::vector<ScheduledMIDIClip>* clips,
        double blockTimeSeconds,
        double sampleRate) const;
    void appendScheduledMIDIToBuffer(
        juce::MidiBuffer& destination,
        const std::vector<ScheduledMIDIClip>* clips,
        double blockTimeSeconds,
        int numSamples,
        double sampleRate) const;
    void appendQueuedMIDIToBuffer(juce::MidiBuffer& destination, int numSamples);
    bool hasQueuedMIDI() const;
    bool hasScheduledMIDIClips() const;
    bool hasScheduledMIDIInBlock(
        double blockTimeSeconds,
        int numSamples,
        double sampleRate,
        const std::vector<ScheduledMIDIClip>* clips) const;

    // ARA Plugin Hosting (Phase 9)
    mutable juce::CriticalSection araStatusLock;
    std::unique_ptr<ARAHostController> araController;
    ARAHostController::PlaybackRequestHandlers araPlaybackRequestHandlers;
    int araFXIndex = -1;  // Which FX slot has ARA active (-1 = none)
    // The callback must not inspect the control-owned unique_ptr merely to
    // discover that ARA is absent. Publish the active slot only after ARA
    // initialization completes, and withdraw it before a quiesced shutdown.
    std::atomic<int> araFXIndexForRealtime { -1 };
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
