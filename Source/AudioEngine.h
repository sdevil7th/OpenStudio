#pragma once

#include <JuceHeader.h>
#include "TrackProcessor.h"
#include "AudioRecorder.h"
#include "MIDIRecorder.h"
#include "PlaybackEngine.h"
#include "PluginManager.h"
#include "PluginWindowManager.h"
#include "MIDIManager.h"
#include "Metronome.h"
#include "PeakCache.h"
#include "AudioAnalyzer.h"
#include "TunerPitchTracker.h"
#include "ScriptEngine.h"
#include "ControlSurfaceManager.h"
#include "TimecodeSync.h"
#include "VideoReader.h"
#include "DDPExporter.h"
#include "TriggerEngine.h"
#include "SessionInterchange.h"
#include <optional>
#include "PolyPitchDetector.h"
#include "PolyResynthesizer.h"
#include "StemSeparator.h"
#include "AITrackEngine.h"
#include <vector>
#include <memory>
#include <functional>
// ... (skip lines) ...

class AudioEngine  : public juce::AudioIODeviceCallback,
                     public juce::AudioPlayHead,
                     public ControlSurfaceCallback,
                     public juce::Timer
{
    static constexpr int maxRealtimeTracks = 64;
    struct RealtimeTrackEntry;
    struct ActiveFXStage;

public:
    AudioEngine();
    ~AudioEngine() override;

    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;

    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void audioDeviceError (const juce::String& errorMessage) override;

    // Audio callback helpers (extracted for readability and testability)
    void updateMasterMetering (float* const* outputChannelData, int numOutputChannels, int numSamples);
    void updatePhaseCorrelation (const float* const* outputChannelData, int numOutputChannels, int numSamples);
    static void buildSidechainProcessingOrder (const std::vector<RealtimeTrackEntry>& rtTracks,
                                               int processedOrder[], int& orderCount, int maxTracks);
    void processMasterFXChain (const ActiveFXStage* rtMasterFX,
                               float* const* outputChannelData, int numOutputChannels,
                               int numSamples, bool useHybrid64Summing);
    void processMonitoringFXChain (const ActiveFXStage* rtMonitoringFX,
                                   float* const* outputChannelData, int numOutputChannels,
                                   int numSamples, bool hybrid64PostChainActive);
    void applyMasterGainPanMono (float* const* outputChannelData, int numOutputChannels,
                                 int numSamples, double currentTimeSeconds,
                                 bool hybrid64PostChainActive);

    juce::AudioDeviceManager& getDeviceManager() { return deviceManager; }

    // Messaging
    juce::String addTrack(const juce::String& explicitId = juce::String(),
                          const juce::String& initialType = juce::String());  // Returns track ID, optional explicit ID/type for restore
    bool removeTrack(const juce::String& trackId);
    bool reorderTrack(const juce::String& trackId, int newPosition);
    int getTrackIndex(const juce::String& trackId) const;  // For lookups

    // Metering
    juce::var getMeteringData();

    // Device Management
    juce::var getAudioDeviceSetup();
    juce::var openAudioDeviceControlPanel();
    void setAudioDeviceSetup(
        const juce::String& type,
        const juce::String& input,
        const juce::String& output,
        double sampleRate,
        int bufferSize,
        std::function<void(bool, const juce::String&)> completion = {});
    int getNAMRackOversamplingFactor() const noexcept;
    bool setNAMRackOversamplingFactor(int factor);
    
    // Track control (Phase 1) - ID-based
    void setTrackRecordArm(const juce::String& trackId, bool armed);
    void setTrackInputMonitoring(const juce::String& trackId, bool enabled);
    void setTrackInputChannels(const juce::String& trackId, int startChannel, int numChannels);
    bool setNAMTunerActive(const juce::String& trackId,
                           bool active,
                           const juce::String& subscriberId);
    
    // Volume/Pan/Mute/Solo (Phase 1) - ID-based
    void setTrackVolume(const juce::String& trackId, float volumeDB);
    void setTrackPan(const juce::String& trackId, float pan);
    void setTrackMute(const juce::String& trackId, bool muted);
    void setTrackSolo(const juce::String& trackId, bool soloed);
    
    // Transport control (Phase 2)
    void setTransportPlaying(bool playing);
    void setTransportRecording(bool recording);
    bool isTransportPlaying() const { return isPlaying; }
    bool isTransportRecording() const { return isRecordMode; }
    void setLoopMode(bool loop)
    {
        isLooping.store(loop, std::memory_order_release);
    }
    bool getLoopMode() const
    {
        return isLooping.load(std::memory_order_acquire);
    }
    double getTransportPosition() const
    {
        return currentSampleRate > 0.0
            ? static_cast<double>(
                currentSamplePosition.load(
                    std::memory_order_acquire))
                / currentSampleRate
            : 0.0;
    }
    void setTransportPosition(double seconds);
    bool hasAnyActiveARA() const;
    void setTempo(double bpm);
    double getTempo() const { return tempo; }

    // Punch In/Out (Phase 3.1)
    void setPunchRange(double startTime, double endTime, bool enabled);
    bool getPunchEnabled() const { return punchEnabled.load(); }

    // Loop Recording (Phase 3.2) — rollover is handled by message-thread transport seeks

    // Record-Safe (Phase 3.3)
    void setTrackRecordSafe(const juce::String& trackId, bool safe);
    bool getTrackRecordSafe(const juce::String& trackId) const;

    // Metronome (Phase 3)
    void setMetronomeEnabled(bool enabled);
    void setMetronomeVolume(float volume);
    void setMetronomeAccentBeats(const std::vector<bool>& accents);
    bool isMetronomeEnabled() const;
    void setTimeSignature(int numerator, int denominator);
    void getTimeSignature(int& numerator, int& denominator) const;

    // Render metronome clicks to a WAV file for a given time range
    juce::String renderMetronomeToFile(double startTime, double endTime);

    // Custom metronome sounds (Phase 9C)
    bool setMetronomeClickSound(const juce::String& filePath);
    bool setMetronomeAccentSound(const juce::String& filePath);
    void resetMetronomeSounds();

    // Get clips that were completed in the last recording session
    std::vector<AudioRecorder::CompletedRecording> getLastCompletedClips();

    // Get MIDI clips that were completed in the last recording session
    std::vector<MIDIRecorder::CompletedMIDIRecording> getLastCompletedMIDIClips();
    juce::var getActiveRecordingMIDIPreviews(const juce::var& requests);

    // Called on the message thread when a peak cache file finishes generating.
    // Set by MainComponent to emit a JS "peaksReady" event.
    std::function<void(const juce::String& filePath)> onPeaksReady;
    
    // Access to PlaybackEngine (for pitch preview, etc.)
    PlaybackEngine& getPlaybackEngine() { return playbackEngine; }

    // Playback clip management - ID-based
    void addPlaybackClip(const juce::String& trackId, const juce::String& filePath, double startTime, double duration,
                         double offset = 0.0, double volumeDB = 0.0, double fadeIn = 0.0, double fadeOut = 0.0,
                         const juce::String& clipId = juce::String(),
                         const juce::String& pitchCorrectionSourceFilePath = juce::String(),
                         double pitchCorrectionSourceOffset = -1.0);
    /** Batch-add multiple clips from a JSON array. Each element: {trackId, filePath, startTime, duration, offset, volumeDB, fadeIn, fadeOut, clipId, pitchCorrectionSourceFilePath?, pitchCorrectionSourceOffset?}. */
    void addPlaybackClipsBatch(const juce::String& clipsJSON);
    void removePlaybackClip(const juce::String& trackId, const juce::String& filePath);
    void removePlaybackClipById(const juce::String& trackId, const juce::String& clipId);
    void clearPlaybackClips();
    void clearTrackPlaybackClips(const juce::String& trackId);
    
    // FX Management (Phase 3) - ID-based
    juce::var scanForPlugins(bool forceRescan = false);
    juce::var getPluginScanConfiguration() const;
    bool addPluginScanPath(const juce::String& path);
    bool removePluginScanPath(const juce::String& path);
    bool retryBlacklistedPlugin(const juce::String& path);
    juce::var getAvailablePlugins();
    bool addTrackInputFX(const juce::String& trackId, const juce::String& pluginPath, bool openEditor = true);
    bool addTrackFX(const juce::String& trackId, const juce::String& pluginPath, bool openEditor = true);

    // Built-in Effects (Phase 4.3)
    bool addTrackBuiltInFX(const juce::String& trackId, const juce::String& effectName, bool isInputFX = false);
    bool addMasterBuiltInFX(const juce::String& effectName);
    juce::var getAvailableBuiltInFX();

    // S13FX (JSFX) Management
    bool addTrackS13FX(const juce::String& trackId, const juce::String& scriptPath, bool isInputFX = false);
    bool addMasterS13FX(const juce::String& scriptPath);
    juce::var getS13FXSliders(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool setS13FXSlider(const juce::String& trackId, int fxIndex, bool isInputFX, int sliderIndex, double value);
    bool reloadS13FX(const juce::String& trackId, int fxIndex, bool isInputFX);
    juce::var getAvailableS13FX();
    
    // Built-in FX Preset System
    juce::var getBuiltInFXPresets(const juce::String& pluginName);
    bool saveBuiltInFXPreset(const juce::String& trackId, const juce::String& chainType, int fxIndex,
                             const juce::String& presetName, bool isFactory = false);
    bool loadBuiltInFXPreset(const juce::String& trackId, const juce::String& chainType, int fxIndex,
                             const juce::String& presetName,
                             const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    juce::String getBuiltInFXPresetData(const juce::String& pluginName,
                                        const juce::String& presetName);
    bool saveBuiltInFXPresetData(const juce::String& pluginName,
                                 const juce::String& presetName,
                                 const juce::String& base64Data);
    bool copyBuiltInFXPreset(const juce::String& pluginName,
                             const juce::String& sourcePresetName,
                             const juce::String& targetPresetName);
    bool deleteBuiltInFXPreset(const juce::String& pluginName, const juce::String& presetName);

    // Plugin Editor Windows (Phase 3) - ID-based
    void openPluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX);
    void openInstrumentEditor(const juce::String& trackId);
    void closePluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX);
    void closeAllPluginWindows();
    void setPluginWindowOwnerComponent(juce::Component* component);
    void setPluginWindowShortcutForwardCallback(PluginWindowManager::ShortcutForwardCallback callback);
    
    // MIDI Device Management (Phase 2)
    juce::var getMIDIInputDevices();
    juce::var getMIDIOutputDevices();
    bool openMIDIDevice(const juce::String& deviceName);
    void closeMIDIDevice(const juce::String& deviceName);
    juce::var getOpenMIDIDevices();
    
    // Track Type Management (Phase 2) - ID-based
    void setTrackType(const juce::String& trackId, const juce::String& type); // 'audio', 'midi', 'instrument'
    void setTrackMIDIInput(const juce::String& trackId, const juce::String& deviceName, int channel);
    void setTrackMIDIClips(const juce::String& trackId, const juce::String& clipsJSON);
    bool sendMidiNote(const juce::String& trackId, int note, int velocity, bool isNoteOn);
    juce::var getTrackMIDINoteActivity(const juce::String& trackId, int maxAgeMs = 1200) const;
    bool panicMIDI();
    bool loadInstrument(const juce::String& trackId, const juce::String& vstPath);
    bool removeInstrument(const juce::String& trackId);
    bool setTrackSamplerSample(const juce::String& trackId, const juce::String& samplePath, int rootNote);
    bool clearTrackSamplerSample(const juce::String& trackId);
    juce::String getInstrumentState(const juce::String& trackId);
    bool setInstrumentState(const juce::String& trackId, const juce::String& base64State);
    void setProcessingPrecision(const juce::String& precisionMode);
    juce::String getProcessingPrecision() const;
    bool setTrackPluginPrecisionOverride(const juce::String& trackId, int fxIndex, bool isInputFX, const juce::String& mode);
    bool setInstrumentPrecisionOverride(const juce::String& trackId, const juce::String& mode);
    bool setMasterFXPrecisionOverride(int fxIndex, const juce::String& mode);
    bool setMonitoringFXPrecisionOverride(int fxIndex, const juce::String& mode);
    juce::var runReleaseGuardrails();
    juce::var runAutomatedRegressionSuite();
    juce::var runCleanGuitarPitchBendRegression();
    juce::var runNAMRackRegression();
    juce::var runNAMRackDIRegression(const juce::File& inputFile,
                                     const juce::File& outputDirectory,
                                     const juce::File& modelFile = juce::File());
    
    // Get loaded plugins info - ID-based
    juce::var getTrackInputFX(const juce::String& trackId);
    juce::var getTrackFX(const juce::String& trackId);
    juce::var getPluginParameters(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool setPluginParameter(const juce::String& trackId, int fxIndex, bool isInputFX, int paramIndex, float value);
    juce::var getBuiltInPluginSchema(const juce::String& trackId, const juce::String& chainType, int fxIndex);
    juce::var getNAMRackDiagnostics(const juce::String& trackId,
                                    const juce::String& chainType,
                                    int fxIndex);
    juce::var getBuiltInPluginState(const juce::String& trackId, const juce::String& chainType, int fxIndex);
    bool setBuiltInPluginParam(const juce::String& trackId, const juce::String& chainType, int fxIndex,
                               const juce::String& paramId, float value);
    bool setBuiltInPluginState(const juce::String& trackId, const juce::String& chainType, int fxIndex,
                               const juce::String& stateJSON,
                               const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    bool removeTrackInputFX(const juce::String& trackId, int fxIndex);
    bool removeTrackFX(const juce::String& trackId, int fxIndex);
    void bypassTrackInputFX(const juce::String& trackId, int fxIndex, bool bypassed);
    void bypassTrackFX(const juce::String& trackId, int fxIndex, bool bypassed);
    bool reorderTrackInputFX(const juce::String& trackId, int fromIndex, int toIndex);
    bool reorderTrackFX(const juce::String& trackId, int fromIndex, int toIndex);
    
    // Master \u0026 Monitoring (Phase 4)
    bool addMasterFX(const juce::String& pluginPath);
    juce::var getMasterFX();
    bool removeMasterFX(int fxIndex);
    bool reorderMasterFX(int fromIndex, int toIndex);
    void openMasterFXEditor(int fxIndex);
    void bypassMasterFX(int fxIndex, bool bypassed);
    bool addMonitoringFX(const juce::String& pluginPath);
    juce::var getMonitoringFX();
    void removeMonitoringFX(int fxIndex);
    void openMonitoringFXEditor(int fxIndex);
    void bypassMonitoringFX(int fxIndex, bool bypassed);
    void setMasterVolume(float volume);
    float getMasterVolume() const
    {
        return masterVolume.load(std::memory_order_relaxed);
    }
    void setMasterPan(float pan);
    float getMasterPan() const
    {
        return masterPan.load(std::memory_order_acquire);
    }
    void setMasterMono(bool mono) { masterMono.store(mono); }
    bool getMasterMono() const { return masterMono.load(); }

    // Metering (Phase 4)
    juce::var getMeterLevels(); // Returns array of track RMS levels
    juce::var getMIDIInputLevels(); // Returns raw MIDI input velocity/activity by track ID
    juce::var getMeterClipStates();
    float getMasterLevel() const; // Returns master output level
    bool getMasterClipLatched() const;
    void resetMeterClip(const juce::String& trackId);
    juce::var getAudioDebugSnapshot() const;
    // Compact atomics-only status for always-visible rack/tuner UI. The full
    // debug snapshot remains an explicit diagnostic operation.
    juce::var getRealtimeAudioTelemetry() const;
    
    // Plugin State Serialization (F2 - Project Save/Load)
    juce::String getPluginState(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool setPluginState(
        const juce::String& trackId,
        int fxIndex,
        bool isInputFX,
        const juce::String& base64State,
        const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    juce::String getMasterPluginState(int fxIndex);
    bool isMasterNAMRackPlugin(int fxIndex);
    bool setMasterPluginState(
        int fxIndex,
        const juce::String& base64State,
        const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    
    // Waveform Visualization
    juce::var getWaveformPeaks(const juce::String& filePath, int samplesPerPixel, int startSample, int numPixels);
    double getAudioPeakAmplitude(const juce::String& filePath,
                                 double offsetSeconds,
                                 double durationSeconds) const;
    bool refreshWaveformPeaks(const juce::String& filePath);
    juce::var getRecordingPeaks(const juce::String& trackId,
                                int samplesPerPixel,
                                int numPixels,
                                juce::int64 startSample = 0);

    // Offline Render/Export
    bool renderProject(const juce::String& source, double startTime, double endTime,
                       const juce::String& filePath, const juce::String& format,
                       double renderSampleRate, int bitDepth, int numChannels,
                       bool normalize, bool addTail, double tailLengthMs,
                       bool includeMetronome = false);
    juce::var capturePitchAuditionPlayback(const juce::String& trackId,
                                           const juce::String& clipId,
                                           double startTime,
                                           double duration,
                                           const juce::String& filePath,
                                           double sampleRate = 44100.0,
                                           bool offlineRenderMode = true);
    juce::var capturePitchBakedContext(const juce::String& sourceFile,
                                       double startSec,
                                       double durationSec,
                                       const juce::String& filePath);
    juce::var comparePitchDebugAudioFiles(const juce::String& referenceFile,
                                          const juce::String& candidateFile,
                                          double captureStartClipSec,
                                          double noteStartClipSec,
                                          double noteEndClipSec);

    // Render with dither/noise shaping (Phase 9E)
    bool renderProjectWithDither(const juce::String& source, double startTime, double endTime,
                                 const juce::String& filePath, const juce::String& format,
                                 double renderSampleRate, int bitDepth, int numChannels,
                                 bool normalize, bool addTail, double tailLengthMs,
                                 const juce::String& ditherType,
                                 bool includeMetronome = false);

    // Plugin Delay Compensation (PDC)
    void recalculatePDC();

    // Pan Law
    void setPanLaw(const juce::String& law);
    juce::String getPanLaw() const;

    // DC Offset per track
    void setTrackDCOffset(const juce::String& trackId, bool enabled);
    bool getTrackDCOffset(const juce::String& trackId) const;

    // Sidechain Routing (Phase 4.4)
    void setSidechainSource(const juce::String& destTrackId, int pluginIndex, const juce::String& sourceTrackId);
    void clearSidechainSource(const juce::String& destTrackId, int pluginIndex);
    juce::String getSidechainSource(const juce::String& destTrackId, int pluginIndex);

    // Send/Bus Routing (Phase 11)
    int addTrackSend(const juce::String& sourceTrackId, const juce::String& destTrackId);
    void removeTrackSend(const juce::String& sourceTrackId, int sendIndex);
    void setTrackSendLevel(const juce::String& sourceTrackId, int sendIndex, float level);
    void setTrackSendPan(const juce::String& sourceTrackId, int sendIndex, float pan);
    void setTrackSendEnabled(const juce::String& sourceTrackId, int sendIndex, bool enabled);
    void setTrackSendPreFader(const juce::String& sourceTrackId, int sendIndex, bool preFader);
    void setTrackSendPhaseInvert(const juce::String& sourceTrackId, int sendIndex, bool invert);
    juce::var getTrackSends(const juce::String& trackId);

    // Track Routing Features
    void setTrackPhaseInvert(const juce::String& trackId, bool invert);
    bool getTrackPhaseInvert(const juce::String& trackId) const;
    void setTrackStereoWidth(const juce::String& trackId, float widthPercent);
    float getTrackStereoWidth(const juce::String& trackId) const;
    void setTrackMasterSendEnabled(const juce::String& trackId, bool enabled);
    bool getTrackMasterSendEnabled(const juce::String& trackId) const;
    void setTrackOutputChannels(const juce::String& trackId, int startChannel, int numChannels);
    void setTrackPlaybackOffset(const juce::String& trackId, double offsetMs);
    double getTrackPlaybackOffset(const juce::String& trackId) const;
    void setTrackChannelCount(const juce::String& trackId, int numChannels);
    int getTrackChannelCount(const juce::String& trackId) const;
    void setTrackMIDIOutput(const juce::String& trackId, const juce::String& deviceName);
    juce::String getTrackMIDIOutput(const juce::String& trackId) const;
    juce::var getTrackRoutingInfo(const juce::String& trackId);

    // Lua Scripting (S13Script)
    juce::var runScript(const juce::String& scriptPath);
    juce::var runScriptCode(const juce::String& luaCode);
    juce::String getScriptDirectory();
    juce::var listScripts();

    // Timer callback for deferred Lua script execution
    void timerCallback() override;

    // Automation (Phase 1.1)
    // Set all automation points for a track parameter (bulk sync from frontend)
    void setAutomationPoints(const juce::String& trackId, const juce::String& parameterId,
                             const juce::String& pointsJSON);
    void replaceAutomationPointsInRange(const juce::String& trackId, const juce::String& parameterId,
                                        double startTimeSeconds, double endTimeSeconds,
                                        const juce::String& pointsJSON);
    // Set automation mode for a track parameter
    void setAutomationMode(const juce::String& trackId, const juce::String& parameterId,
                           const juce::String& modeStr);
    // Get automation mode
    juce::String getAutomationMode(const juce::String& trackId, const juce::String& parameterId);
    // Clear automation for a track parameter
    void clearAutomation(const juce::String& trackId, const juce::String& parameterId);
    // Touch begin/end (for touch/latch recording modes)
    void beginTouchAutomation(const juce::String& trackId, const juce::String& parameterId);
    void endTouchAutomation(const juce::String& trackId, const juce::String& parameterId);

    // Tempo Map (Phase 1.2)
    // Set all tempo markers from frontend (JSON array of {time, tempo})
    void setTempoMarkers(const juce::String& markersJSON);
    // Get the effective BPM at a given time in seconds (step-wise lookup)
    double getTempoAtTime(double timeSeconds) const;
    // Clear all tempo markers (revert to single global tempo)
    void clearTempoMarkers();

    // Strip Silence (Phase 3.12)
    juce::var detectSilentRegions(const juce::String& filePath, double thresholdDb,
                                  double minSilenceMs, double minSoundMs,
                                  double preAttackMs, double postReleaseMs);

    // Freeze Track (Phase 3.13)
    juce::var freezeTrack(const juce::String& trackId);
    bool unfreezeTrack(const juce::String& trackId);

    // Audio Analysis (Phase 9)
    AudioAnalyzer& getAudioAnalyzer() { return audioAnalyzer; }

    // Control Surface Support (Phase 3.10)
    ControlSurfaceManager& getControlSurfaceManager() { return controlSurfaceManager; }

    // Timecode/Sync (Phase 3.9)
    TimecodeSyncManager& getTimecodeSyncManager() { return timecodeSyncManager; }

    // Video Integration (Phase 3.8)
    VideoReader& getVideoReader() { return videoReader; }

    // DDP Export (Phase 3.15)
    DDPExporter& getDDPExporter() { return ddpExporter; }

    // Clip Launch / Trigger (Phase 4.1)
    TriggerEngine& getTriggerEngine() { return triggerEngine; }

    // Session Interchange (Phase 3.14)
    SessionInterchange& getSessionInterchange() { return sessionInterchange; }

    // Clip Gain Envelope (Phase 18.10)
    void setClipGainEnvelope(const juce::String& trackId, const juce::String& clipId,
                             const juce::String& pointsJSON);

    // MIDI Learn (Phase 19.7)
    struct MIDILearnMapping
    {
        int ccNumber = -1;
        juce::String trackId;
        juce::String chainType { "track" };
        int pluginIndex = -1;
        int paramIndex = -1;
        juce::String builtInParamId;
    };
    void startMIDILearnForPlugin(const juce::String& trackId, int pluginIndex, int paramIndex, bool isInputFX = false);
    void startMIDILearnForBuiltIn(const juce::String& trackId, const juce::String& chainType,
                                  int fxIndex, const juce::String& paramId);
    void stopMIDILearnMode();
    void clearMIDILearnMapping(int ccNumber);
    juce::var getMIDILearnMappings();
    bool setMIDILearnMappings(const juce::var& mappings);

    // MIDI Import/Export (Phase 19.9)
    juce::var importMIDIFile(const juce::String& filePath);
    bool exportProjectMIDI(const juce::String& outputPath, const juce::var& midiTracks, double bpm = 120.0);
    bool exportMIDIFile(const juce::String& trackId, const juce::String& clipId,
                        const juce::String& eventsJSON, const juce::String& outputPath, double clipTempo);

    // Plugin Presets (Phase 19.14)
    bool isNAMRackPlugin(const juce::String& trackId, int fxIndex, bool isInputFX);
    juce::var getPluginPresets(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool loadPluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                          const juce::String& presetPath,
                          const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    bool savePluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                          const juce::String& presetPath, const juce::String& presetName);

    // A/B Comparison (Phase 19.16)
    bool storePluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                            const juce::String& slot);
    bool loadPluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                           const juce::String& slot,
                           const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    juce::String getPluginActiveSlot(const juce::String& trackId, int fxIndex, bool isInputFX);

    // Session Archive (Phase 20.5)
    bool archiveSession(const juce::String& projectJsonPath, const juce::String& outputZipPath);
    bool unarchiveSession(const juce::String& zipPath, const juce::String& outputDir);

    // Phase Correlation Meter (Phase 20.10)
    float getPhaseCorrelation() const { return phaseCorrelationValue.load(std::memory_order_relaxed); }

    // Retired master Spectrum Analyzer compatibility endpoint. The frontend
    // does not consume this stream; keeping the endpoint avoids breaking older
    // clients without running a periodic FFT on the realtime thread.
    juce::var getSpectrumData();

    // MIDI diagnostics / plugin capabilities
    juce::var getMidiDiagnostics() const;
    juce::var getPluginCapabilities(const juce::String& pluginPath);
    juce::var getPluginCompatibilityMatrix();
    juce::var runEngineBenchmarks();

    // Built-in FX Oversampling (Phase 20.12)
    bool setBuiltInFXOversampling(const juce::String& trackId, int fxIndex, bool isInputFX, bool enabled);

    // Channel Strip EQ (Phase 19.18)
    void setChannelStripEQEnabled(const juce::String& trackId, bool enabled);
    bool getChannelStripEQEnabled(const juce::String& trackId) const;
    void setChannelStripEQParam(const juce::String& trackId, int paramIndex, float value);
    float getChannelStripEQParam(const juce::String& trackId, int paramIndex);

    // Pitch Corrector bridge methods (auto mode)
    juce::var getPitchCorrectorData(const juce::String& trackId, int fxIndex);
    void setPitchCorrectorParam(const juce::String& trackId, int fxIndex, const juce::String& param, float value);
    juce::var getPitchHistory(const juce::String& trackId, int fxIndex, int numFrames);

    // Pitch Corrector bridge methods (graphical mode)
    juce::var analyzePitchContour(const juce::String& trackId, const juce::String& clipId,
                                  std::function<bool()> shouldCancel = {});
    juce::var analyzePitchContourDirect(const juce::String& filePath, double offset, double duration,
                                        const juce::String& clipId,
                                        std::function<bool()> shouldCancel = {});
    juce::var applyPitchCorrection(const juce::String& trackId, const juce::String& clipId,
                                   const juce::var& notesJson, const juce::var& framesJson = juce::var(),
                                   float globalFormantSemitones = 0.0f,
                                    std::optional<double> windowStartSec = std::nullopt,
                                    std::optional<double> windowEndSec = std::nullopt,
                                    const juce::String& renderMode = "single",
                                    std::function<bool()> shouldCancel = {},
                                    double jobStartDelayMs = 0.0,
                                    int previewRenderGenerationToken = 0,
                                    std::function<bool(const std::function<void()>&)> guardedCommit = {});
    juce::var previewPitchCorrection(const juce::String& trackId, const juce::String& clipId, const juce::var& notesJson);
    juce::var startPitchScrubPreview(const juce::String& trackId, const juce::String& clipId,
                                     const juce::var& noteJson, const juce::var& framesJson = juce::var());
    bool updatePitchScrubPreview(const juce::String& clipId, float pitchRatio);
    bool stopPitchScrubPreview(const juce::String& clipId);
    juce::var getPitchScrubPreviewStatus(const juce::String& clipId = {});
    juce::var getPitchPreviewRoutingStatus(const juce::String& clipId = {});

    // Polyphonic pitch detection (Phase 6)
    juce::var analyzePolyphonic(const juce::String& trackId, const juce::String& clipId);
    juce::var extractMidiFromAudio(const juce::String& trackId, const juce::String& clipId);
    bool isPolyphonicDetectionAvailable() const;

    // Polyphonic pitch editing (Phase 7)
    juce::var applyPolyPitchCorrection(const juce::String& trackId, const juce::String& clipId, const juce::var& editedNotesJson);
    juce::var soloPolyNote(const juce::String& trackId, const juce::String& clipId, const juce::String& noteId);

    // Source separation (Phase 8 + Phase 10)
    juce::var separateStems(const juce::String& trackId, const juce::String& clipId);
    bool isStemSeparationAvailable() const;
    juce::var getAiToolsStatus();
    juce::var refreshAiToolsStatus();
    juce::var installAiTools(bool userConfirmedDownload);
    juce::var installAiTools(const juce::String& optionsJSON);
    juce::var resetAiTools();
    juce::var separateStemsAsync(const juce::String& trackId, const juce::String& clipId, const juce::String& optionsJSON);
    juce::var getStemSeparationProgress();
    void cancelStemSeparation();
    void cancelAiToolsInstall();
    juce::var startAIGeneration(const juce::String& trackId,
                                const juce::String& modelId,
                                const juce::String& workflowId,
                                const juce::String& paramsJSON);
    juce::var getAIGenerationProgress();
    void cancelAIGeneration();

    // ARA Plugin Hosting (Phase 9)
    juce::var initializeARAForTrack(const juce::String& trackId, int fxIndex);
    juce::var addARAClip(const juce::String& trackId, const juce::String& clipId);
    juce::var removeARAClip(const juce::String& trackId, const juce::String& clipId);
    juce::var getARAStatusForTrack(const juce::String& trackId) const;
    juce::var shutdownARAForTrack(const juce::String& trackId);
    bool isARAActiveForTrack(const juce::String& trackId) const;

    // ControlSurfaceCallback overrides
    void onControlSurfaceTrackVolume(const juce::String& trackId, float value01) override;
    void onControlSurfaceTrackPan(const juce::String& trackId, float valueMinus1To1) override;
    void onControlSurfaceTrackMute(const juce::String& trackId, bool muted) override;
    void onControlSurfaceTrackSolo(const juce::String& trackId, bool soloed) override;
    void onControlSurfaceTrackRecordArm(const juce::String& trackId, bool armed) override;
    void onControlSurfaceTransportPlay() override;
    void onControlSurfaceTransportStop() override;
    void onControlSurfaceTransportRecord() override;
    void onControlSurfaceMasterVolume(float value01) override;
    float getTrackVolume01(const juce::String& trackId) const override;
    float getTrackPan(const juce::String& trackId) const override;
    bool getTrackMuted(const juce::String& trackId) const override;
    bool getTrackSoloed(const juce::String& trackId) const override;
    std::vector<juce::String> getTrackIds() const override;

    // AudioPlayHead — provides tempo/position to hosted VST3 plugins
    juce::Optional<juce::AudioPlayHead::PositionInfo> getPosition() const override;

private:
    struct RealtimeResolvedSend
    {
        TrackProcessor::RealtimeSendInfo config;
        std::shared_ptr<juce::AudioBuffer<float>> destinationBuffer;
    };

    struct RealtimeTrackEntry
    {
        juce::String id;
        juce::AudioProcessorGraph::Node::Ptr node;
        TrackProcessor* processor = nullptr;
        std::shared_ptr<juce::AudioBuffer<float>> sidechainOutputBuffer;
        std::shared_ptr<juce::AudioBuffer<float>> sendAccumBuffer;
        std::vector<juce::String> sidechainSourceIds;
        std::vector<std::shared_ptr<juce::AudioBuffer<float>>>
            sidechainSourceBuffers;
        std::vector<RealtimeResolvedSend> sends;
        bool hasIncomingSends = false;
    };

    struct DesiredFXStageSlot
    {
        int slotId = 0;
        juce::String name;
        juce::String type;
        juce::String pluginPath;
        juce::String pluginFormat;
        juce::String serializedState;
        bool bypassed = false;
        bool forceFloat = false;
    };

    struct DesiredFXStageSpec
    {
        std::vector<DesiredFXStageSlot> slots;
    };

    struct StageFXBypassDelayStorage
    {
        const juce::AudioProcessor* processor = nullptr;
        juce::AudioBuffer<double> ring;
        // Published by the control thread after state/model changes. JUCE's
        // AudioProcessor latency member itself is not atomic.
        std::atomic<int> publishedLatency { 0 };
        int writePosition = 0;
        int currentLatency = 0;
        int targetLatency = 0;
        int latencyRampRemaining = 0;
        int latencyRampLength = 0;
        bool latencyInitialised = false;
    };

    struct ActiveFXStageSlot
    {
        int slotId = 0;
        juce::String name;
        juce::String type;
        juce::String pluginPath;
        juce::String pluginFormat;
        bool bypassed = false;
        bool forceFloat = false;
        bool supportsDouble = false;
        std::shared_ptr<juce::AudioProcessor> processor;
        std::shared_ptr<StageFXBypassDelayStorage>
            bypassDelay;
    };

    struct ActiveFXStage
    {
        uint64 generation = 0;
        double sampleRate = 0.0;
        int preparedBlockSize = 0;
        ProcessingPrecisionMode precisionMode = ProcessingPrecisionMode::Float32;
        std::vector<ActiveFXStageSlot> slots;
    };
    static constexpr size_t maxRealtimeStageContinuitySlots = 64;
    static constexpr size_t maxRealtimeStageContinuityChannels = 128;
    struct StageFXContinuityState
    {
        const juce::AudioProcessor* processor = nullptr;
        int slotId = 0;
        uint64 stageGeneration = 0;
        std::array<double, maxRealtimeStageContinuityChannels>
            lastOutput {};
        int validChannels = 0;
        bool skippedLastBlock = false;
        float hostBypassWetMix = 1.0f;
        bool targetBypassed = false;
        std::array<double,
                   maxRealtimeStageContinuityChannels>
            endpointCorrection {};
        std::array<double,
                   maxRealtimeStageContinuityChannels>
            endpointCorrectionStep {};
        int endpointCorrectionSamplesRemaining = 0;
    };

    template <typename SampleType>
    static bool scheduleStageFXContinuityCorrection(
        juce::AudioBuffer<SampleType>& buffer,
        StageFXContinuityState& continuity,
        int rampSamples) noexcept;
    template <typename SampleType>
    static void applyStageFXContinuityCorrection(
        juce::AudioBuffer<SampleType>& buffer,
        StageFXContinuityState& continuity) noexcept;
    template <typename SampleType>
    static void rememberStageFXContinuity(
        const juce::AudioBuffer<SampleType>& buffer,
        StageFXContinuityState& continuity) noexcept;
    template <typename SampleType>
    bool prepareStageLatencyAlignedDry(
        const juce::AudioBuffer<SampleType>& source,
        juce::AudioBuffer<SampleType>& dry,
        StageFXBypassDelayStorage& storage,
        const juce::AudioProcessor& processor,
        int numSamples,
        bool writeDryOutput,
        bool advanceHistory) noexcept;
    template <typename SampleType>
    void applyStageHostBypassCrossfade(
        juce::AudioBuffer<SampleType>& wet,
        const juce::AudioBuffer<SampleType>& dry,
        int numSamples,
        StageFXContinuityState& continuity,
        bool bypassed) noexcept;

    struct RealtimeTrackSnapshot
    {
        std::vector<RealtimeTrackEntry> tracks;
        std::array<int, maxRealtimeTracks> processingOrder {};
        int processingOrderCount = 0;
    };
    struct PublishedBuiltInProcessorOwner
    {
        std::shared_ptr<juce::AudioProcessor> processor;
        std::shared_ptr<const RealtimeTrackSnapshot> trackSnapshot;
        TrackProcessor* track = nullptr;
    };
    using RealtimeRoutingBufferMap =
        std::map<juce::String,
                 std::shared_ptr<juce::AudioBuffer<float>>>;

    juce::MidiBuffer buildTrackMidiBlock(const juce::String& trackId, double blockStartTimeSeconds,
                                         int numSamples, double sampleRate, bool playing);
    void queueAllNotesOffForTrack(TrackProcessor& track, bool requestChase = true);
    void queueAllNotesOffForAllTracks(bool requestChase = true);
    void rolloverLoopRecordings(double newTakeStartSeconds);
    void applyProcessingPrecisionToTrack(TrackProcessor& track);
    static void resolveRealtimeRoutingBuffers(
        std::vector<RealtimeTrackEntry>& trackSnapshot,
        const RealtimeRoutingBufferMap& sidechainBuffers,
        const RealtimeRoutingBufferMap& sendBuffers);
    PublishedBuiltInProcessorOwner getPublishedBuiltInProcessor(
        const juce::String& trackId,
        const juce::String& chainType,
        int fxIndex) const;
    void publishRealtimeTrackSnapshot(
        std::shared_ptr<const RealtimeTrackSnapshot> snapshot);
    void publishRealtimeMasterSnapshot(
        std::shared_ptr<const ActiveFXStage> snapshot);
    void publishRealtimeMonitoringSnapshot(
        std::shared_ptr<const ActiveFXStage> snapshot);
    void retireRealtimeSnapshotOwner(
        std::shared_ptr<const void> owner);
    void reclaimRetiredRealtimeSnapshotOwners();
    void rebuildRealtimeProcessingSnapshots();
    std::unique_ptr<juce::AudioProcessor> createProcessorForStageSlot(const DesiredFXStageSlot& slot,
                                                                      double sampleRate,
                                                                      int preparedBlockSize,
                                                                      ProcessingPrecisionMode precisionMode,
                                                                      juce::String& errorMessage);
    std::shared_ptr<ActiveFXStage> buildActiveFXStage(const DesiredFXStageSpec& spec,
                                                      double sampleRate,
                                                      int preparedBlockSize,
                                                      ProcessingPrecisionMode precisionMode,
                                                      bool monitoringStage,
                                                      juce::String& errorMessage);
    bool publishMasterStageSpec(const DesiredFXStageSpec& spec);
    bool publishMonitoringStageSpec(const DesiredFXStageSpec& spec);
    void syncStageSpecStateFromActive(DesiredFXStageSpec& spec, const std::shared_ptr<const ActiveFXStage>& activeStage);
    void rebindStageEditors(const std::shared_ptr<const ActiveFXStage>& oldStage,
                            const std::shared_ptr<const ActiveFXStage>& newStage,
                            bool monitoringStage);
    juce::String serialiseProcessorStateToBase64(juce::AudioProcessor* processor) const;
    bool applyBase64StateToProcessor(juce::AudioProcessor* processor, const juce::String& base64State) const;
    ActiveFXStageSlot* findActiveStageSlot(std::shared_ptr<ActiveFXStage>& stage, int slotId);
    const ActiveFXStageSlot* findActiveStageSlot(const std::shared_ptr<const ActiveFXStage>& stage, int slotId) const;
    const DesiredFXStageSlot* findDesiredStageSlot(const DesiredFXStageSpec& spec, int index) const;
    DesiredFXStageSlot* findDesiredStageSlot(DesiredFXStageSpec& spec, int index);
    // Set this AudioEngine as the AudioPlayHead on all plugins in a track
    void propagatePlayHead(TrackProcessor* track);
    // FFmpeg helpers for lossy encoding and sample rate conversion
    juce::File findFFmpegExe() const;
    bool convertWithFFmpeg(const juce::File& inputFile, const juce::File& outputFile,
                           const juce::String& format, double targetSampleRate, int quality,
                           int bitDepth, int numChannels) const;
    // Device settings persistence
    void saveDeviceSettings();
    void loadDeviceSettings();
    void loadDeviceSettingsWithChannelCounts(int inputChannels, int outputChannels);
    void applyRoutedDeviceChannelPolicy(
        juce::AudioDeviceManager::AudioDeviceSetup& setup,
        int minimumInputChannels,
        int minimumOutputChannels) const;
    void refreshRoutedDeviceChannels();
    juce::var buildAudioDeviceSetupSnapshot(
        juce::AudioIODevice* device);
    void refreshAudioDeviceSetupSnapshot(
        juce::AudioIODevice* device);
    bool isMicrophonePermissionGrantedForInput() const;
    void requestMicrophonePermissionIfNeeded(std::function<void(bool)> completion);
    bool applyAudioDeviceSetup(
        const juce::String& type,
        const juce::String& input,
        const juce::String& output,
        double sampleRate,
        int bufferSize,
        juce::String& errorMessage);
    juce::File getDeviceSettingsFile() const;
    void resetAudioCallbackWindowTelemetry() noexcept;
    void recordAudioCallbackTiming(double callbackProcessMs,
                                   double callbackEndWallTimeMs,
                                   double expectedBlockMs,
                                   uint64 callbackCounter,
                                   bool callbackStartedWhileRecording) noexcept;
    void recordAudioCallbackStageTiming(
        const std::array<double, 5>& stageProcessMs,
        double callbackEndWallTimeMs) noexcept;
#if JUCE_WINDOWS
    void registerWindowsAudioCallbackMMCSS() noexcept;
#endif
    void removeNAMTunerSubscribersForTrack(
        const juce::String& trackId);
    void refreshNAMTunerRoute();
    // MIDI message routing (Phase 2)
    void handleMIDIMessage(const juce::String& deviceName, int channel, const juce::MidiMessage& message);
    
    juce::AudioDeviceManager deviceManager;
    mutable juce::CriticalSection audioDeviceSetupSnapshotLock;
    juce::var audioDeviceSetupSnapshot;
    std::unique_ptr<juce::AudioProcessorGraph> mainProcessorGraph;
    
    juce::AudioProcessorGraph::Node::Ptr audioInputNode;
    juce::AudioProcessorGraph::Node::Ptr audioOutputNode;
    
    // Track storage - ID-based system
    std::map<juce::String, TrackProcessor*> trackMap;  // ID -> Track
    std::map<juce::String, juce::AudioProcessorGraph::Node::Ptr> trackNodeMap;  // ID -> graph node
    std::vector<juce::String> trackOrder;  // Ordered list of track IDs for display/processing
    // Control-side shared owners remain available to editor/state code, but the
    // realtime callback never uses atomic<shared_ptr>. MSVC implements those
    // free-function atomics with one process-wide spin lock, which can priority-
    // invert a 16-sample ASIO callback behind a pre-empted UI diagnostics poll.
    // One reader epoch protects all three raw publications for a complete
    // callback; replaced owners are reclaimed only after that epoch drains.
    std::shared_ptr<const RealtimeTrackSnapshot> realtimeTrackSnapshot;
    std::atomic<const RealtimeTrackSnapshot*>
        realtimeTrackSnapshotForAudio { nullptr };
    std::atomic<const ActiveFXStage*>
        realtimeMasterFXSnapshotForAudio { nullptr };
    std::atomic<const ActiveFXStage*>
        realtimeMonitoringFXSnapshotForAudio { nullptr };
    std::atomic<std::uint32_t> realtimeSnapshotAudioReaders { 0 };
    juce::CriticalSection realtimeSnapshotRetirementLock;
    std::vector<std::shared_ptr<const void>>
        retiredRealtimeSnapshotOwners;
    std::atomic<bool>
        realtimeSnapshotsPublishedBeforeCallbackRegistration {
            false
        };
    
    // Audio Recorder (Phase 2)
    AudioRecorder audioRecorder;
    MIDIRecorder midiRecorder;
    std::vector<MIDIRecorder::CompletedMIDIRecording> lastCompletedMIDIClips;
    PlaybackEngine playbackEngine;
    PeakCache peakCache;
    std::atomic<bool> isPlaying { false };
    std::atomic<bool> isRecordMode { false };
    std::atomic<bool> isRendering { false };  // Blocks audio callback during offline render
    juce::CriticalSection offlineRenderTransactionLock;
    std::atomic<bool> isLooping { false };
    // The callback advances this integral sample cursor. Control-thread seeks
    // publish atomically and the callback uses one stable value per block, so a
    // seek cannot tear a double or be overwritten by an in-flight callback.
    std::atomic<juce::int64> currentSamplePosition { 0 };
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;  // Device buffer size for re-preparing plugins after render
    std::atomic<int> namRackOversamplingFactor { 4 };
    int inputLatencySamples = 0;  // Device input latency for recording compensation
    std::atomic<double> lastAudioBlockWallTimeMs { 0.0 };
    std::atomic<double> lastAudioBlockDurationMs { 0.0 };
    std::atomic<double> lastAudioCallbackProcessMs { 0.0 };
    std::atomic<double> maxAudioCallbackProcessMs { 0.0 };
    std::atomic<uint64> audioCallbackCounter { 0 };
    std::atomic<uint64> audioCallbackDeadlineMissCount { 0 };
    std::atomic<uint64> lifetimeAudioCallbackDeadlineMissCount { 0 };
    std::atomic<uint64> lastAudioCallbackDeadlineMissCounter { 0 };
    std::atomic<double> lastAudioCallbackDeadlineMissProcessMs { 0.0 };
    std::atomic<bool> lastAudioCallbackDeadlineMissWhileRecording { false };
    std::atomic<uint64> oversizedAudioCallbackCount { 0 };
    std::atomic<double> previousAudioCallbackArrivalWallTimeMs { 0.0 };
    std::atomic<uint64> audioCallbackArrivalGapCount { 0 };
    std::atomic<uint64> lastAudioCallbackArrivalGapCounter { 0 };
    std::atomic<double> lastAudioCallbackArrivalGapMs { 0.0 };
    std::atomic<double> maxAudioCallbackArrivalGapMs { 0.0 };
    std::atomic<uint64> audioDeviceStartCount { 0 };
    std::atomic<uint64> audioDeviceStopCount { 0 };
    std::atomic<uint64> audioDeviceErrorCount { 0 };
    std::atomic<double> lastAudioDeviceStartWallTimeMs { 0.0 };
    std::atomic<double> lastAudioDeviceStopWallTimeMs { 0.0 };
    std::atomic<double> lastAudioDeviceErrorWallTimeMs { 0.0 };
    static constexpr int audioCallbackWindowSeconds = 10;
    static constexpr int audioCallbackHistogramBins = 1024;
    static constexpr double audioCallbackHistogramBinWidthMs = 0.005;
    static constexpr int audioCallbackHistogramCellCount =
        audioCallbackWindowSeconds * audioCallbackHistogramBins;
    static constexpr int audioCallbackStageCount = 5;
    static constexpr uint64 audioCallbackStageSampleInterval = 16;
    enum AudioCallbackStageIndex
    {
        audioCallbackStagePlayback = 0,
        audioCallbackStageTracksFX,
        audioCallbackStageMasterMonitoring,
        audioCallbackStageMeteringSync,
        audioCallbackStageOverhead
    };
    struct AudioCallbackStageWindow
    {
        std::array<std::atomic<uint64>, audioCallbackHistogramCellCount>
            durationHistogram {};
        std::array<std::atomic<uint64>, audioCallbackWindowSeconds>
            maxNanoseconds {};
    };
    // Each cell packs a wall-clock second epoch in the high 32 bits and a
    // count/value in the low 32 bits. The callback is the sole writer; message
    // thread diagnostics can therefore read an exact, lock-free rolling set of
    // one-second buckets without clearing memory on the realtime thread.
    std::array<std::atomic<uint64>, audioCallbackHistogramCellCount>
        audioCallbackDurationHistogram {};
    std::array<std::atomic<uint64>, audioCallbackWindowSeconds>
        audioCallbackWindowMissCounts {};
    std::array<std::atomic<uint64>, audioCallbackWindowSeconds>
        audioCallbackWindowMaxNanoseconds {};
    std::array<AudioCallbackStageWindow, audioCallbackStageCount>
        audioCallbackStageWindows {};
    std::atomic<double> firstAudioCallbackTelemetryWallTimeMs { 0.0 };
    std::atomic<bool> windowsAudioCallbackMMCSSRequested { false };
    std::atomic<bool> windowsAudioCallbackMMCSSActive { false };
    std::atomic<bool> windowsAudioCallbackMMCSSPriorityApplied { false };
    std::atomic<uint32_t> windowsAudioCallbackMMCSSTaskIndex { 0 };
    std::atomic<uint32_t> windowsAudioCallbackMMCSSError { 0 };
    std::atomic<uint32_t> windowsAudioCallbackThreadId { 0 };
    std::atomic<uint32_t> windowsAudioCallbackMMCSSGeneration { 1 };
    std::atomic<uint64> audioCallbackScopedNoDenormalsCount { 0 };
    std::atomic<int> audioCallbackTrackBufferResizeCount { 0 };
    std::atomic<int> audioCallbackPitchScrubBufferResizeCount { 0 };
    std::atomic<int> audioCallbackSidechainBufferResizeCount { 0 };
    TunerPitchTracker tunerPitchTracker;
    std::atomic<bool> namTunerActive { false };
    std::atomic<bool> tunerAudioDeviceRunning { false };
    // Generation, start channel, and channel count are published as one value
    // so the audio callback can never observe a route assembled from two
    // different UI-thread updates.
    std::atomic<std::uint64_t> tunerInputRoute {
        0x00000000ffff0000ULL
    };
    juce::String tunerSourceTrackId;
    std::map<juce::String, juce::String> tunerSubscribers;
    std::vector<juce::String> tunerSubscriberOrder;
    std::atomic<bool> firstCallbackAfterTransportStartPending { false };
    double tempo = 120.0;  // Message/offline-thread BPM state.
    std::atomic<double> realtimeTempo { 120.0 };
    // Hosted processors query the playhead from the audio callback while the
    // message thread may edit the signature. Publish each scalar atomically so
    // getPosition() never participates in a C++ data race.
    std::atomic<int> timeSigNumerator { 4 };
    std::atomic<int> timeSigDenominator { 4 };
    Metronome metronome;

    // Punch In/Out (Phase 3.1)
    std::atomic<bool> punchEnabled { false };
    std::atomic<double> punchStartTime { 0.0 };  // seconds
    std::atomic<double> punchEndTime { 0.0 };     // seconds

    // Loop Recording (Phase 3.2)
    int loopTakeCounter = 0;

    // Tempo map — sorted list of {timeSeconds, bpm} markers. The normal
    // no-marker callback path avoids its lock entirely.
    struct TempoMarker { double timeSeconds; double bpm; };
    std::vector<TempoMarker> tempoMarkers;
    mutable juce::CriticalSection tempoMapLock;
    std::atomic<bool> hasTempoMarkers { false };

    // Dither mode for render (0=off, 1=TPDF, 2=noise-shaped). Set by renderProjectWithDither.
    std::atomic<int> pendingDitherMode_ { 0 };

    juce::File projectAudioFolder;
    std::vector<AudioRecorder::CompletedRecording> lastCompletedClips;  // Clips from last recording session
    
    // Plugin Management (Phase 3)
    PluginManager pluginManager;
    PluginWindowManager pluginWindowManager;
    
    // MIDI Management (Phase 2)
    std::unique_ptr<MIDIManager> midiManager;
    std::atomic<int> midiLateEventCount { 0 };
    std::atomic<int> midiMaxEventsPerBlock { 0 };
    std::atomic<int> midiLastComputedSampleOffset { 0 };
    std::atomic<int> midiLastInputFanoutCount { 0 };
    std::atomic<int> midiMaxInputFanoutCount { 0 };
    std::atomic<int> midiMappedParameterUpdateCount { 0 };
    ProcessingPrecisionMode processingPrecisionMode { ProcessingPrecisionMode::Float32 };
    
    // Master FX (Phase 5)
    DesiredFXStageSpec desiredMasterStageSpec;
    DesiredFXStageSpec desiredMonitoringStageSpec;
    std::shared_ptr<const ActiveFXStage> realtimeMasterFXSnapshot;
    std::shared_ptr<const ActiveFXStage> realtimeMonitoringFXSnapshot;
    int nextMasterStageSlotId = 1;
    int nextMonitoringStageSlotId = 1;
    std::atomic<uint64> masterStageGeneration { 0 };
    std::atomic<uint64> monitoringStageGeneration { 0 };
    std::atomic<int> masterStageBuildFailureCount { 0 };
    std::atomic<int> monitoringStageBuildFailureCount { 0 };
    std::atomic<double> masterStageLastBuildMs { 0.0 };
    std::atomic<double> monitoringStageLastBuildMs { 0.0 };
    std::atomic<float> masterVolume { 1.0f };
    std::atomic<float> masterPan { 0.0f };
    std::atomic<float> masterOutputLevel { 0.0f }; // Peak level of master output
    std::atomic<float> lastPostTrackPlaybackPeak { 0.0f };
    std::atomic<float> lastPostMonitoringInputPeak { 0.0f };
    std::atomic<float> lastPostMasterFXPeak { 0.0f };
    std::atomic<float> lastPostMonitoringFXPeak { 0.0f };
    std::atomic<float> lastFinalOutputPeak { 0.0f };
    // Exact per-callback device-output evidence. Non-finite values are replaced
    // with silence at the final boundary; finite audio is never limited/gated.
    static constexpr size_t maxTrackedDeviceOutputChannels = 64;
    std::array<float, maxTrackedDeviceOutputChannels>
        previousDeviceOutputSamples {};
    std::atomic<uint64> deviceOutputNonFiniteSampleCount { 0 };
    std::atomic<uint64> deviceOutputDiscontinuityCandidateCount { 0 };
    std::atomic<uint64> lastDeviceOutputDiscontinuityCallback { 0 };
    std::atomic<float> lastDeviceOutputDiscontinuityPeak { 0.0f };
    std::atomic<float> lastDeviceOutputDiscontinuityDelta { 0.0f };
    std::atomic<uint64> lastDeviceOutputDiscontinuityDeadlineMissCount { 0 };
    std::atomic<int> lastActiveOutputChannels { 0 };
    std::atomic<int> lastCallbackInputChannels { 0 };
    std::atomic<int> lastCallbackOutputChannels { 0 };
    std::atomic<int> lastReturnedRecordingClipCount { 0 };
    std::atomic<uint64> lastAudioCallbackCounter { 0 };

    // REAPER-style master peak meter decimation — matches the 10Hz metering timer.
    // At 32-sample ASIO blocks (1378 callbacks/sec), updating every 4096 samples
    // gives ~11 updates/sec — one fresh value per timer tick with no wasted work.
    static constexpr int MASTER_METER_UPDATE_SAMPLES = 4096;
    int   masterMeterSampleCount { 0 };
    float masterMeterPeakAccum   { 0.0f };
    std::atomic<bool> masterClipLatched { false };

    // Cached master pan gains — recalculated only when pan changes (avoids
    // cos/sin every audio callback, ~94 trig calls/sec at 48kHz/512)
    std::atomic<float> cachedMasterPanL { 1.0f };
    std::atomic<float> cachedMasterPanR { 1.0f };

    // Master automation (volume/pan curves)
    AutomationList masterVolumeAutomation;
    AutomationList masterPanAutomation;

    // Master mono downmix
    std::atomic<bool> masterMono { false };

    // Lua Scripting
    ScriptEngine scriptEngine;

    // Audio Analysis (Phase 9)
    AudioAnalyzer audioAnalyzer;

    // Control Surface Support (Phase 3.10)
    ControlSurfaceManager controlSurfaceManager;

    // Timecode/Sync (Phase 3.9)
    TimecodeSyncManager timecodeSyncManager;

    // Video Integration (Phase 3.8)
    VideoReader videoReader;

    // DDP Export (Phase 3.15)
    DDPExporter ddpExporter;

    // Clip Launch / Trigger (Phase 4.1)
    TriggerEngine triggerEngine;

    // Session Interchange (Phase 3.14)
    SessionInterchange sessionInterchange;

    // Pre-allocated buffers — avoids heap allocs on the audio thread
    juce::AudioBuffer<float> reusableTrackBuffer;
    juce::AudioBuffer<float> reusableMasterBuffer;
    juce::AudioBuffer<double> reusableMasterBufferDouble;
    juce::AudioBuffer<float> reusableStageFXDryBuffer;
    juce::AudioBuffer<double> reusableStageFXDryBufferDouble;
    juce::AudioBuffer<float> reusablePitchScrubBuffer;
    juce::MidiBuffer reusableRealtimeMidiBuffer;
    float stageFXBypassRampStep = 1.0f / 882.0f;
    int stageFXContinuityRampSamples = 353;
    std::array<StageFXContinuityState,
               maxRealtimeStageContinuitySlots>
        masterFXContinuity {};
    std::array<StageFXContinuityState,
               maxRealtimeStageContinuitySlots>
        monitoringFXContinuity {};
    // Counts successful endpoint bridge applications. An isolated busy skip
    // can contribute once on fallback entry and once on the recovery block.
    std::atomic<int> masterFXFallbackReuseCount { 0 };
    std::atomic<int> monitoringFXFallbackReuseCount { 0 };
    std::atomic<int> masterFXBusySkipCount { 0 };
    std::atomic<int> monitoringFXBusySkipCount { 0 };

    // Sidechain routing (Phase 4.4)
    // Stores per-track output buffers after processing, so downstream tracks
    // can use them as sidechain input.  Key = trackId.  Buffers are pre-allocated
    // in audioDeviceAboutToStart and reused every callback.
    std::map<juce::String, std::shared_ptr<juce::AudioBuffer<float>>> sidechainOutputBuffers;

    // Send accumulation buffers — each track has a buffer where incoming sends are mixed.
    // Pre-allocated in audioDeviceAboutToStart and reused every callback.
    std::map<juce::String, std::shared_ptr<juce::AudioBuffer<float>>> sendAccumBuffers;

    // Current pan law (applied to all tracks)
    std::atomic<PanLaw> currentPanLaw { PanLaw::Linear };

    // Cached solo state — avoids scanning all tracks every callback
    std::atomic<bool> cachedAnySoloed { false };

    // MIDI Learn (Phase 19.7)
    std::atomic<bool> midiLearnActive { false };
    juce::String midiLearnTrackId;
    int midiLearnPluginIndex = -1;
    int midiLearnParamIndex = -1;
    juce::String midiLearnChainType { "track" };
    juce::String midiLearnBuiltInParamId;
    std::vector<MIDILearnMapping> midiLearnMappings;
    juce::CriticalSection midiLearnLock;

    // A/B Comparison (Phase 19.16)
    struct StoredPluginABState
    {
        juce::String base64State;
        std::weak_ptr<juce::AudioProcessor> processorIdentity;
        juce::String trackId;
        bool isInputFX = false;
    };
    struct ActivePluginABSlot
    {
        juce::String slot;
        std::weak_ptr<juce::AudioProcessor> processorIdentity;
        juce::String trackId;
        bool isInputFX = false;
    };
    // Index-based lookup remains convenient, but every value is bound to the
    // exact processor owner so reorder/remove/reinsert cannot misapply state.
    void invalidatePluginABStatesForTrack(const juce::String& trackId);
    void invalidatePluginABStatesForTrackChain(const juce::String& trackId, bool isInputFX);
    mutable juce::CriticalSection pluginABStateLock;
    std::map<juce::String, StoredPluginABState> pluginABStates;
    std::map<juce::String, ActivePluginABSlot> pluginActiveSlots;

    // Phase Correlation Meter (Phase 20.10)
    std::atomic<float> phaseCorrelationValue { 1.0f };  // -1 to +1
    // Running accumulators for phase correlation (updated on audio thread)
    double phaseCorr_sumLR { 0.0 };
    double phaseCorr_sumLL { 0.0 };
    double phaseCorr_sumRR { 0.0 };
    int phaseCorrSampleCount { 0 };
    static constexpr int PHASE_CORR_UPDATE_SAMPLES = 4096;

    // Compatibility counters retained for debug-schema stability after the
    // unused master FFT was removed from the callback.
    std::atomic<uint64> spectrumFftPublishCount { 0 };
    std::atomic<uint64> spectrumFftLockMissCount { 0 };

    // Polyphonic Pitch Detection (Phase 6) — lazy-loaded
    PolyPitchDetector polyPitchDetector;
    bool polyModelLoadAttempted = false;
    juce::CriticalSection polyAnalysisLock;

    // Polyphonic Pitch Editing (Phase 7)
    PolyResynthesizer polyResynthesizer;
    // Cache last analysis result per clip for reuse in editing
    std::map<juce::String, PolyPitchDetector::PolyAnalysisResult> polyAnalysisCache;

    // Source Separation (Phase 8 + Phase 10) — Python subprocess
    StemSeparator stemSeparator;
    AITrackEngine aiTrackEngine;

    // Stem file cache: hash(filePath+offset+duration) -> stem files (name -> path)
    std::map<juce::String, juce::StringPairArray> stemFileCache;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
