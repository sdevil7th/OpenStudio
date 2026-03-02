#pragma once

#include <JuceHeader.h>
#include <memory>
#include <vector>
#include <map>

/**
 * PlaybackEngine manages audio clip playback for the DAW.
 * Handles reading audio files, scheduling clips based on timeline position,
 * and mixing multiple clips playing simultaneously.
 */
class PlaybackEngine
{
public:
    PlaybackEngine();
    ~PlaybackEngine();
    
    // Gain envelope point (time relative to clip start, gain in linear 0-2 range)
    struct GainEnvelopePoint
    {
        double time;   // seconds relative to clip start
        float gain;    // linear gain (0.0 = silence, 1.0 = unity, 2.0 = +6dB)
    };

    // Clip information structure
    struct ClipInfo
    {
        juce::File audioFile;
        double startTime;      // When clip starts on timeline (seconds)
        double duration;       // Clip duration (seconds)
        double offset;         // Offset into audio file (for trimming, seconds)
        double volumeDB;       // Per-clip gain (-60 to +12 dB)
        double fadeIn;         // Fade in length (seconds)
        double fadeOut;        // Fade out length (seconds)
        int fadeInCurve;       // Fade in curve type: 0=linear, 1=equal_power, 2=s_curve, 3=log, 4=exp
        int fadeOutCurve;      // Fade out curve type: 0=linear, 1=equal_power, 2=s_curve, 3=log, 4=exp
        juce::String trackId;        // Which track this clip belongs to
        juce::String clipId;         // Unique clip ID for envelope lookup
        bool isActive;         // Whether clip is currently loaded

        ClipInfo(const juce::File& file, double start, double dur, const juce::String& track, double off = 0.0,
                 double volDB = 0.0, double fIn = 0.0, double fOut = 0.0, int fInCurve = 0, int fOutCurve = 0)
            : audioFile(file), startTime(start), duration(dur), offset(off),
              volumeDB(volDB), fadeIn(fIn), fadeOut(fOut), fadeInCurve(fInCurve), fadeOutCurve(fOutCurve),
              trackId(track), isActive(true) {}
    };
    
    // Clip management
    void addClip(const juce::File& audioFile, double startTime, double duration, const juce::String& trackId,
                 double offset = 0.0, double volumeDB = 0.0, double fadeIn = 0.0, double fadeOut = 0.0,
                 const juce::String& clipId = juce::String());
    void removeClip(const juce::String& trackId, const juce::String& filePath);
    void clearAllClips();
    void clearTrackClips(const juce::String& trackId);

    // Clip gain envelope management
    void setClipGainEnvelope(const juce::String& trackId, const juce::String& clipId,
                             const std::vector<GainEnvelopePoint>& points);
    
    // Called from audio callback to fill track buffer with playback audio
    // Called from audio callback to fill track buffer with playback audio
    void fillTrackBuffer(const juce::String& trackId,
                        juce::AudioBuffer<float>& buffer,
                        double currentTime,
                        int numSamples,
                        double sampleRate);
    
    // Utility
    int getNumClips() const { return (int)clips.size(); }
    int getNumClipsForTrack(const juce::String& trackId) const;

    // Thread-safe snapshot of all clips (for offline rendering)
    std::vector<ClipInfo> getClipSnapshot() const;

    // Render mode: uses Lagrange interpolation for higher quality resampling
    void setRenderMode(bool isRendering) { renderMode = isRendering; }

    // Max cached readers before eviction
    static constexpr int MAX_CACHED_READERS = 256;
    
private:
    std::vector<ClipInfo> clips;
    std::map<juce::String, std::unique_ptr<juce::AudioFormatReader>> readers;
    juce::AudioFormatManager formatManager;
    juce::CriticalSection lock;

    // Clip gain envelopes: key = "trackId::clipId", value = sorted envelope points
    std::map<juce::String, std::vector<GainEnvelopePoint>> gainEnvelopes;

    // Interpolate gain from envelope at a given time (relative to clip start)
    static float interpolateGainEnvelope(const std::vector<GainEnvelopePoint>& points, double time);

    // Pre-allocated file read buffer (avoids heap alloc on audio thread)
    juce::AudioBuffer<float> reusableFileBuffer;

    // Get cached audio format reader (audio-thread safe — never creates readers)
    juce::AudioFormatReader* getCachedReader(const juce::File& file);

    // Pre-load reader on message thread so it's ready for audio thread
    void preloadReader(const juce::File& file);

    // Legacy: get or create reader (only called from message thread now)
    juce::AudioFormatReader* getReader(const juce::File& file);

    // Apply a fade curve to a normalized t value (0.0 to 1.0)
    // curveType: 0=linear, 1=equal_power, 2=s_curve, 3=log, 4=exp
    static float applyFadeCurve(float t, int curveType);

    // High-quality resampling (Lagrange interpolation) for render mode
    bool renderMode = false;
    juce::LagrangeInterpolator lagrangeInterpolatorL;
    juce::LagrangeInterpolator lagrangeInterpolatorR;

    // Reader access times for LRU eviction
    std::map<juce::String, juce::int64> readerAccessTimes;

    // Evict oldest readers when cache exceeds limit
    void evictOldReaders();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PlaybackEngine)
};
