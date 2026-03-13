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
#include "ScriptEngine.h"
#include "ControlSurfaceManager.h"
#include "TimecodeSync.h"
#include "VideoReader.h"
#include "DDPExporter.h"
#include "TriggerEngine.h"
#include "SessionInterchange.h"
#include "PolyPitchDetector.h"
#include "PolyResynthesizer.h"
#include "StemSeparator.h"
#include <vector>
#include <memory>
// ... (skip lines) ...

class AudioEngine  : public juce::AudioIODeviceCallback,
                     public juce::AudioPlayHead,
                     public ControlSurfaceCallback,
                     public juce::Timer
{
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

    juce::AudioDeviceManager& getDeviceManager() { return deviceManager; }

    // Messaging
    juce::String addTrack(const juce::String& explicitId = juce::String());  // Returns track ID, optional explicit ID for restore
    bool removeTrack(const juce::String& trackId);
    bool reorderTrack(const juce::String& trackId, int newPosition);
    int getTrackIndex(const juce::String& trackId) const;  // For lookups

    // Metering
    juce::var getMeteringData();

    // Device Management
    juce::var getAudioDeviceSetup();
    void setAudioDeviceSetup(const juce::String& type, const juce::String& input, const juce::String& output, double sampleRate, int bufferSize);
    
    // Track control (Phase 1) - ID-based
    void setTrackRecordArm(const juce::String& trackId, bool armed);
    void setTrackInputMonitoring(const juce::String& trackId, bool enabled);
    void setTrackInputChannels(const juce::String& trackId, int startChannel, int numChannels);
    
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
    void setLoopMode(bool loop) { isLooping = loop; }
    bool getLoopMode() const { return isLooping; }
    double getTransportPosition() const { return currentSamplePosition / currentSampleRate; }
    void setTransportPosition(double seconds) { currentSamplePosition = seconds * currentSampleRate; }
    void setTempo(double bpm);
    double getTempo() const { return tempo; }

    // Punch In/Out (Phase 3.1)
    void setPunchRange(double startTime, double endTime, bool enabled);
    bool getPunchEnabled() const { return punchEnabled.load(); }

    // Loop Recording (Phase 3.2) — handled via loop wrap detection in audio callback

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

    // Called on the message thread when a peak cache file finishes generating.
    // Set by MainComponent to emit a JS "peaksReady" event.
    std::function<void(const juce::String& filePath)> onPeaksReady;
    
    // Access to PlaybackEngine (for pitch preview, etc.)
    PlaybackEngine& getPlaybackEngine() { return playbackEngine; }

    // Playback clip management - ID-based
    void addPlaybackClip(const juce::String& trackId, const juce::String& filePath, double startTime, double duration,
                         double offset = 0.0, double volumeDB = 0.0, double fadeIn = 0.0, double fadeOut = 0.0,
                         const juce::String& clipId = juce::String());
    /** Batch-add multiple clips from a JSON array. Each element: {trackId, filePath, startTime, duration, offset, volumeDB, fadeIn, fadeOut, clipId}. */
    void addPlaybackClipsBatch(const juce::String& clipsJSON);
    void removePlaybackClip(const juce::String& trackId, const juce::String& filePath);
    void clearPlaybackClips();
    void clearTrackPlaybackClips(const juce::String& trackId);
    
    // FX Management (Phase 3) - ID-based
    void scanForPlugins();
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
    bool saveBuiltInFXPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                             const juce::String& presetName, bool isFactory = false);
    bool loadBuiltInFXPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                             const juce::String& presetName);
    bool deleteBuiltInFXPreset(const juce::String& pluginName, const juce::String& presetName);

    // Plugin Editor Windows (Phase 3) - ID-based
    void openPluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX);
    void openInstrumentEditor(const juce::String& trackId);
    void closePluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX);
    void closeAllPluginWindows();
    
    // MIDI Device Management (Phase 2)
    juce::var getMIDIInputDevices();
    bool openMIDIDevice(const juce::String& deviceName);
    void closeMIDIDevice(const juce::String& deviceName);
    juce::var getOpenMIDIDevices();
    
    // Track Type Management (Phase 2) - ID-based
    void setTrackType(const juce::String& trackId, const juce::String& type); // 'audio', 'midi', 'instrument'
    void setTrackMIDIInput(const juce::String& trackId, const juce::String& deviceName, int channel);
    bool loadInstrument(const juce::String& trackId, const juce::String& vstPath);
    
    // Get loaded plugins info - ID-based
    juce::var getTrackInputFX(const juce::String& trackId);
    juce::var getTrackFX(const juce::String& trackId);
    juce::var getPluginParameters(const juce::String& trackId, int fxIndex, bool isInputFX);
    void removeTrackInputFX(const juce::String& trackId, int fxIndex);
    void removeTrackFX(const juce::String& trackId, int fxIndex);
    void bypassTrackInputFX(const juce::String& trackId, int fxIndex, bool bypassed);
    void bypassTrackFX(const juce::String& trackId, int fxIndex, bool bypassed);
    bool reorderTrackInputFX(const juce::String& trackId, int fromIndex, int toIndex);
    bool reorderTrackFX(const juce::String& trackId, int fromIndex, int toIndex);
    
    // Master \u0026 Monitoring (Phase 4)
    bool addMasterFX(const juce::String& pluginPath);
    juce::var getMasterFX();
    void removeMasterFX(int fxIndex);
    void openMasterFXEditor(int fxIndex);
    bool addMonitoringFX(const juce::String& pluginPath);
    juce::var getMonitoringFX();
    void removeMonitoringFX(int fxIndex);
    void openMonitoringFXEditor(int fxIndex);
    void bypassMonitoringFX(int fxIndex, bool bypassed);
    void setMasterVolume(float volume);
    float getMasterVolume() const { return masterVolume; }
    void setMasterPan(float pan);
    float getMasterPan() const { return masterPan; }
    void setMasterMono(bool mono) { masterMono.store(mono); }
    bool getMasterMono() const { return masterMono.load(); }

    // Metering (Phase 4)
    juce::var getMeterLevels(); // Returns array of track RMS levels
    float getMasterLevel() const; // Returns master output level
    
    // Plugin State Serialization (F2 - Project Save/Load)
    juce::String getPluginState(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool setPluginState(const juce::String& trackId, int fxIndex, bool isInputFX, const juce::String& base64State);
    juce::String getMasterPluginState(int fxIndex);
    bool setMasterPluginState(int fxIndex, const juce::String& base64State);
    
    // Waveform Visualization
    juce::var getWaveformPeaks(const juce::String& filePath, int samplesPerPixel, int startSample, int numPixels);
    juce::var getRecordingPeaks(const juce::String& trackId, int samplesPerPixel, int numPixels);

    // Offline Render/Export
    bool renderProject(const juce::String& source, double startTime, double endTime,
                       const juce::String& filePath, const juce::String& format,
                       double renderSampleRate, int bitDepth, int numChannels,
                       bool normalize, bool addTail, double tailLengthMs);

    // Render with dither/noise shaping (Phase 9E)
    bool renderProjectWithDither(const juce::String& source, double startTime, double endTime,
                                 const juce::String& filePath, const juce::String& format,
                                 double renderSampleRate, int bitDepth, int numChannels,
                                 bool normalize, bool addTail, double tailLengthMs,
                                 const juce::String& ditherType);

    // Plugin Delay Compensation (PDC)
    void recalculatePDC();

    // Pan Law
    void setPanLaw(const juce::String& law);
    juce::String getPanLaw() const;

    // DC Offset per track
    void setTrackDCOffset(const juce::String& trackId, bool enabled);

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
        int ccNumber;
        juce::String trackId;
        int pluginIndex;
        int paramIndex;
    };
    void startMIDILearnForPlugin(const juce::String& trackId, int pluginIndex, int paramIndex);
    void stopMIDILearnMode();
    void clearMIDILearnMapping(int ccNumber);
    juce::var getMIDILearnMappings();

    // MIDI Import/Export (Phase 19.9)
    juce::var importMIDIFile(const juce::String& filePath);
    bool exportMIDIFile(const juce::String& trackId, const juce::String& clipId,
                        const juce::String& eventsJSON, const juce::String& outputPath, double clipTempo);

    // Plugin Presets (Phase 19.14)
    juce::var getPluginPresets(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool loadPluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                          const juce::String& presetPath);
    bool savePluginPreset(const juce::String& trackId, int fxIndex, bool isInputFX,
                          const juce::String& presetPath, const juce::String& presetName);

    // A/B Comparison (Phase 19.16)
    bool storePluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                            const juce::String& slot);
    bool loadPluginABState(const juce::String& trackId, int fxIndex, bool isInputFX,
                           const juce::String& slot);
    juce::String getPluginActiveSlot(const juce::String& trackId, int fxIndex, bool isInputFX);

    // Session Archive (Phase 20.5)
    bool archiveSession(const juce::String& projectJsonPath, const juce::String& outputZipPath);
    bool unarchiveSession(const juce::String& zipPath, const juce::String& outputDir);

    // Phase Correlation Meter (Phase 20.10)
    float getPhaseCorrelation() const { return phaseCorrelationValue.load(std::memory_order_relaxed); }

    // Spectrum Analyzer (Phase 20.11)
    juce::var getSpectrumData();

    // Built-in FX Oversampling (Phase 20.12)
    bool setBuiltInFXOversampling(const juce::String& trackId, int fxIndex, bool isInputFX, bool enabled);

    // Channel Strip EQ (Phase 19.18)
    void setChannelStripEQEnabled(const juce::String& trackId, bool enabled);
    void setChannelStripEQParam(const juce::String& trackId, int paramIndex, float value);
    float getChannelStripEQParam(const juce::String& trackId, int paramIndex);

    // Pitch Corrector bridge methods (auto mode)
    juce::var getPitchCorrectorData(const juce::String& trackId, int fxIndex);
    void setPitchCorrectorParam(const juce::String& trackId, int fxIndex, const juce::String& param, float value);
    juce::var getPitchHistory(const juce::String& trackId, int fxIndex, int numFrames);

    // Pitch Corrector bridge methods (graphical mode)
    juce::var analyzePitchContour(const juce::String& trackId, const juce::String& clipId);
    juce::var analyzePitchContourDirect(const juce::String& filePath, double offset, double duration, const juce::String& clipId);
    juce::var applyPitchCorrection(const juce::String& trackId, const juce::String& clipId, const juce::var& notesJson, const juce::var& framesJson = juce::var());
    juce::var previewPitchCorrection(const juce::String& trackId, const juce::String& clipId, const juce::var& notesJson);

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
    juce::var separateStemsAsync(const juce::String& trackId, const juce::String& clipId, const juce::String& optionsJSON);
    juce::var getStemSeparationProgress();
    void cancelStemSeparation();

    // ARA Plugin Hosting (Phase 9)
    juce::var initializeARAForTrack(const juce::String& trackId, int fxIndex);
    juce::var addARAClip(const juce::String& trackId, const juce::String& clipId);
    juce::var removeARAClip(const juce::String& trackId, const juce::String& clipId);
    juce::var getARAPlugins();
    juce::var shutdownARAForTrack(const juce::String& trackId);

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
    // Set this AudioEngine as the AudioPlayHead on all plugins in a track
    void propagatePlayHead(TrackProcessor* track);
    // FFmpeg helpers for lossy encoding and sample rate conversion
    juce::File findFFmpegExe() const;
    bool convertWithFFmpeg(const juce::File& inputFile, const juce::File& outputFile,
                           const juce::String& format, double targetSampleRate, int quality) const;
    // Device settings persistence
    void saveDeviceSettings();
    void loadDeviceSettings();
    juce::File getDeviceSettingsFile() const;

    // MIDI message routing (Phase 2)
    void handleMIDIMessage(const juce::String& deviceName, int channel, const juce::MidiMessage& message);
    
    juce::AudioDeviceManager deviceManager;
    std::unique_ptr<juce::AudioProcessorGraph> mainProcessorGraph;
    
    juce::AudioProcessorGraph::Node::Ptr audioInputNode;
    juce::AudioProcessorGraph::Node::Ptr audioOutputNode;
    
    // Track storage - ID-based system
    std::map<juce::String, TrackProcessor*> trackMap;  // ID -> Track
    std::vector<juce::String> trackOrder;  // Ordered list of track IDs for display/processing
    
    // Audio Recorder (Phase 2)
    AudioRecorder audioRecorder;
    MIDIRecorder midiRecorder;
    std::vector<MIDIRecorder::CompletedMIDIRecording> lastCompletedMIDIClips;
    PlaybackEngine playbackEngine;
    PeakCache peakCache;
    std::atomic<bool> isPlaying { false };
    std::atomic<bool> isRecordMode { false };
    std::atomic<bool> isRendering { false };  // Blocks audio callback during offline render
    bool isLooping = false;
    double currentSamplePosition = 0.0;
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;  // Device buffer size for re-preparing plugins after render
    int inputLatencySamples = 0;  // Device input latency for recording compensation
    std::atomic<bool> pendingRecordStartCapture { false };  // Audio thread captures start time
    double tempo = 120.0;  // BPM (global default / fallback)
    int timeSigNumerator = 4;
    int timeSigDenominator = 4;
    Metronome metronome;

    // Punch In/Out (Phase 3.1)
    std::atomic<bool> punchEnabled { false };
    std::atomic<double> punchStartTime { 0.0 };  // seconds
    std::atomic<double> punchEndTime { 0.0 };     // seconds

    // Loop Recording (Phase 3.2)
    double prevSamplePosition = 0.0;  // For detecting loop wraps (position jumps backward)
    int loopTakeCounter = 0;

    // Tempo map — sorted list of {timeSeconds, bpm} markers.
    // Accessed on the audio thread via getTempoAtTime(), guarded by ScopedTryLock.
    struct TempoMarker { double timeSeconds; double bpm; };
    std::vector<TempoMarker> tempoMarkers;
    mutable juce::CriticalSection tempoMapLock;

    // Dither mode for render (0=off, 1=TPDF, 2=noise-shaped). Set by renderProjectWithDither.
    std::atomic<int> pendingDitherMode_ { 0 };

    juce::File projectAudioFolder;
    std::vector<AudioRecorder::CompletedRecording> lastCompletedClips;  // Clips from last recording session
    
    // Plugin Management (Phase 3)
    PluginManager pluginManager;
    PluginWindowManager pluginWindowManager;
    
    // MIDI Management (Phase 2)
    std::unique_ptr<MIDIManager> midiManager;
    
    // Master FX (Phase 5)
    std::unique_ptr<juce::AudioProcessorGraph> masterFXChain;
    std::unique_ptr<juce::AudioProcessorGraph> monitoringFXChain;  // Output-only, not in bounce
    std::vector<juce::AudioProcessorGraph::Node::Ptr> masterFXNodes;
    std::vector<juce::AudioProcessorGraph::Node::Ptr> monitoringFXNodes;
    float masterVolume = 1.0f;
    float masterPan = 0.0f;
    std::atomic<float> masterOutputLevel { 0.0f }; // Peak level of master output

    // REAPER-style master peak meter decimation — matches the 10Hz metering timer.
    // At 32-sample ASIO blocks (1378 callbacks/sec), updating every 4096 samples
    // gives ~11 updates/sec — one fresh value per timer tick with no wasted work.
    static constexpr int MASTER_METER_UPDATE_SAMPLES = 4096;
    int   masterMeterSampleCount { 0 };
    float masterMeterPeakAccum   { 0.0f };

    // Cached master pan gains — recalculated only when pan changes (avoids
    // cos/sin every audio callback, ~94 trig calls/sec at 48kHz/512)
    std::atomic<float> cachedMasterPanL { 0.707107f };  // cos(pi/4)
    std::atomic<float> cachedMasterPanR { 0.707107f };  // sin(pi/4)

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

    // Sidechain routing (Phase 4.4)
    // Stores per-track output buffers after processing, so downstream tracks
    // can use them as sidechain input.  Key = trackId.  Buffers are pre-allocated
    // in audioDeviceAboutToStart and reused every callback.
    std::map<juce::String, juce::AudioBuffer<float>> sidechainOutputBuffers;

    // Send accumulation buffers — each track has a buffer where incoming sends are mixed.
    // Pre-allocated in audioDeviceAboutToStart and reused every callback.
    std::map<juce::String, juce::AudioBuffer<float>> sendAccumBuffers;

    // Current pan law (applied to all tracks)
    PanLaw currentPanLaw { PanLaw::ConstantPower };

    // Cached solo state — avoids scanning all tracks every callback
    std::atomic<bool> cachedAnySoloed { false };

    // MIDI Learn (Phase 19.7)
    std::atomic<bool> midiLearnActive { false };
    juce::String midiLearnTrackId;
    int midiLearnPluginIndex = -1;
    int midiLearnParamIndex = -1;
    std::vector<MIDILearnMapping> midiLearnMappings;
    juce::CriticalSection midiLearnLock;

    // A/B Comparison (Phase 19.16)
    // Key: "trackId:fxIndex:isInputFX:slot" -> base64 plugin state
    std::map<juce::String, juce::String> pluginABStates;
    // Key: "trackId:fxIndex:isInputFX" -> "A" or "B"
    std::map<juce::String, juce::String> pluginActiveSlots;

    // Phase Correlation Meter (Phase 20.10)
    std::atomic<float> phaseCorrelationValue { 1.0f };  // -1 to +1
    // Running accumulators for phase correlation (updated on audio thread)
    double phaseCorr_sumLR { 0.0 };
    double phaseCorr_sumLL { 0.0 };
    double phaseCorr_sumRR { 0.0 };
    int phaseCorrSampleCount { 0 };
    static constexpr int PHASE_CORR_UPDATE_SAMPLES = 4096;

    // Spectrum Analyzer (Phase 20.11)
    static constexpr int FFT_ORDER = 11;  // 2^11 = 2048
    static constexpr int FFT_SIZE = 1 << FFT_ORDER;
    juce::dsp::FFT spectrumFFT { FFT_ORDER };
    juce::dsp::WindowingFunction<float> spectrumWindow { static_cast<size_t>(FFT_SIZE), juce::dsp::WindowingFunction<float>::hann };
    float spectrumInputBuffer[FFT_SIZE * 2] = {};  // ring buffer for FFT input
    float spectrumOutputBuffer[FFT_SIZE] = {};      // magnitude spectrum
    int spectrumWritePos { 0 };
    bool spectrumReady { false };
    juce::CriticalSection spectrumLock;

    // Polyphonic Pitch Detection (Phase 6) — lazy-loaded
    PolyPitchDetector polyPitchDetector;
    bool polyModelLoadAttempted = false;

    // Polyphonic Pitch Editing (Phase 7)
    PolyResynthesizer polyResynthesizer;
    // Cache last analysis result per clip for reuse in editing
    std::map<juce::String, PolyPitchDetector::PolyAnalysisResult> polyAnalysisCache;

    // Source Separation (Phase 8 + Phase 10) — Python subprocess
    StemSeparator stemSeparator;

    // Stem file cache: hash(filePath+offset+duration) -> stem files (name -> path)
    std::map<juce::String, juce::StringPairArray> stemFileCache;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
