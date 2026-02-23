#pragma once

#include <JuceHeader.h>
#include "TrackProcessor.h"
#include "AudioRecorder.h"
#include "PlaybackEngine.h"
#include "PluginManager.h"
#include "PluginWindowManager.h"
#include "MIDIManager.h"
#include "Metronome.h"
#include "PeakCache.h"
#include "AudioAnalyzer.h"
#include <vector>
#include <memory>
// ... (skip lines) ...

class AudioEngine  : public juce::AudioIODeviceCallback
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

    // Called on the message thread when a peak cache file finishes generating.
    // Set by MainComponent to emit a JS "peaksReady" event.
    std::function<void(const juce::String& filePath)> onPeaksReady;
    
    // Playback clip management - ID-based
    void addPlaybackClip(const juce::String& trackId, const juce::String& filePath, double startTime, double duration);
    void removePlaybackClip(const juce::String& trackId, const juce::String& filePath);
    void clearPlaybackClips();
    void clearTrackPlaybackClips(const juce::String& trackId);
    
    // FX Management (Phase 3) - ID-based
    void scanForPlugins();
    juce::var getAvailablePlugins();
    bool addTrackInputFX(const juce::String& trackId, const juce::String& pluginPath);
    bool addTrackFX(const juce::String& trackId, const juce::String& pluginPath);
    
    // Plugin Editor Windows (Phase 3) - ID-based
    void openPluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX);
    void closePluginEditor(const juce::String& trackId, int fxIndex, bool isInputFX);
    
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
    void removeTrackInputFX(const juce::String& trackId, int fxIndex);
    void removeTrackFX(const juce::String& trackId, int fxIndex);
    void bypassTrackInputFX(const juce::String& trackId, int fxIndex, bool bypassed);
    void bypassTrackFX(const juce::String& trackId, int fxIndex, bool bypassed);
    bool reorderTrackInputFX(const juce::String& trackId, int fromIndex, int toIndex);
    bool reorderTrackFX(const juce::String& trackId, int fromIndex, int toIndex);
    
    // Master \u0026 Monitoring (Phase 4)
    bool addMasterFX(const juce::String& pluginPath);
    bool addMonitoringFX(const juce::String& pluginPath);
    void setMasterVolume(float volume);
    float getMasterVolume() const { return masterVolume; }
    void setMasterPan(float pan);
    float getMasterPan() const { return masterPan; }
    
    // Metering (Phase 4)
    juce::var getMeterLevels(); // Returns array of track RMS levels
    float getMasterLevel() const; // Returns master output level
    
    // Plugin State Serialization (F2 - Project Save/Load)
    juce::String getPluginState(const juce::String& trackId, int fxIndex, bool isInputFX);
    bool setPluginState(const juce::String& trackId, int fxIndex, bool isInputFX, const juce::String& base64State);
    juce::String getMasterPluginState(int fxIndex);
    bool setMasterPluginState(int fxIndex, const juce::String& base64State);
    
    // Waveform Visualization
    juce::var getWaveformPeaks(const juce::String& filePath, int samplesPerPixel, int numPixels);
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

    // Send/Bus Routing (Phase 11)
    int addTrackSend(const juce::String& sourceTrackId, const juce::String& destTrackId);
    void removeTrackSend(const juce::String& sourceTrackId, int sendIndex);
    void setTrackSendLevel(const juce::String& sourceTrackId, int sendIndex, float level);
    void setTrackSendPan(const juce::String& sourceTrackId, int sendIndex, float pan);
    void setTrackSendEnabled(const juce::String& sourceTrackId, int sendIndex, bool enabled);
    void setTrackSendPreFader(const juce::String& sourceTrackId, int sendIndex, bool preFader);
    juce::var getTrackSends(const juce::String& trackId);

    // Audio Analysis (Phase 9)
    AudioAnalyzer& getAudioAnalyzer() { return audioAnalyzer; }

private:
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
    PlaybackEngine playbackEngine;
    PeakCache peakCache;
    std::atomic<bool> isPlaying { false };
    std::atomic<bool> isRecordMode { false };
    std::atomic<bool> isRendering { false };  // Blocks audio callback during offline render
    bool isLooping = false;
    double currentSamplePosition = 0.0;
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;  // Device buffer size for re-preparing plugins after render
    double tempo = 120.0;  // BPM
    int timeSigNumerator = 4;
    int timeSigDenominator = 4;
    Metronome metronome;

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

    // Audio Analysis (Phase 9)
    AudioAnalyzer audioAnalyzer;

    // Pre-allocated buffers — avoids heap allocs on the audio thread
    juce::AudioBuffer<float> reusableTrackBuffer;
    juce::AudioBuffer<float> reusableMasterBuffer;

    // Cached solo state — avoids scanning all tracks every callback
    std::atomic<bool> cachedAnySoloed { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
