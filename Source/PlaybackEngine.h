#pragma once

#include <JuceHeader.h>

#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
#include "signalsmith-stretch.h"
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif

#include <memory>
#include <vector>
#include <map>
#include <limits>

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
        juce::File audioFile;           // Current audio file (may be pitch-corrected)
        juce::File originalAudioFile;  // Original file — never changed after addClip, used for re-analysis
        double originalOffset = 0.0;  // Original offset — never changed after addClip, used for re-reading original file
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
        juce::String envelopeKey;    // Pre-computed "trackId::clipId" key — avoids string alloc in audio thread
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
                 const juce::String& clipId = juce::String(), const juce::File& sourceAudioFile = juce::File(),
                 double sourceOffset = -1.0);
    void removeClip(const juce::String& trackId, const juce::String& filePath);
    void clearAllClips();
    void clearTrackClips(const juce::String& trackId);

    // Hot-swap a clip's audio file (used after pitch correction writes a new file)
    void replaceClipAudioFile(const juce::String& clipId, const juce::File& newFile);
    void queueDeferredClipAudioFile(const juce::String& clipId, const juce::File& newFile, bool restoringOriginal = false);
    bool commitDeferredClipAudioFile(const juce::String& clipId);
    int commitAllDeferredClipAudioFiles();

    // Clear the persistent pitch correction file for a clip (e.g. when user discards edits)
    void clearPitchCorrectionFile(const juce::String& clipId);

    struct RenderedPreviewSegment
    {
        juce::File audioFile;
        double startSec = 0.0;
        double endSec = 0.0;
        double fileOffsetSec = 0.0;
    };

    struct ClipPlaybackSourceStatus
    {
        bool clipFound = false;
        bool renderedSegmentActiveAtTime = false;
        bool correctedSourceActiveAtTime = false;
        juce::String sourceType = "none";
        juce::String audioFile;
        double clipTime = 0.0;
        double playbackOffset = 0.0;
    };

    bool setClipRenderedPreviewSegment(const juce::String& clipId,
                                       const juce::File& audioFile,
                                       double startSec,
                                       double endSec,
                                       double fileOffsetSec = 0.0,
                                       int generation = 0);
    void beginRenderedPreviewSegmentGeneration(const juce::String& clipId, int generation);
    void invalidateRenderedPreviewSegments(const juce::String& clipId);
    void clearClipRenderedPreviewSegments(const juce::String& clipId);
    std::map<juce::String, std::vector<RenderedPreviewSegment>> getRenderedPreviewSegmentSnapshot() const;
    ClipPlaybackSourceStatus getClipPlaybackSourceAtTime(const juce::String& trackId,
                                                         const juce::String& clipId,
                                                         double projectTimeSec) const;

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
    
    // ---- Real-time pitch preview ----

    // A correction segment: time range (relative to clip start) with a pitch ratio
    struct PitchCorrectionSegment
    {
        double startTime = 0.0;   // seconds, relative to clip start
        double endTime   = 0.0;
        float  pitchRatio = 1.0f; // 1.0 = no shift, 2.0 = octave up, etc.
    };

    struct ClipPitchPreviewData
    {
        std::vector<PitchCorrectionSegment> pitchSegments;
        float globalFormantSemitones = 0.0f;
        double previewStartSec = 0.0;
        double previewEndSec = std::numeric_limits<double>::max();
        bool allowReplacingCorrectedSource = false;
    };

    struct PitchScrubPreviewData
    {
        juce::String trackId;
        juce::String clipId;
        juce::AudioBuffer<float> loopBuffer;
        double sourceSampleRate = 0.0;
        double loopStartSec = 0.0;
        double loopEndSec = 0.0;
        float basePitchHz = 0.0f;
        float pitchRatio = 1.0f;
        bool active = false;
        double readPosition = 0.0;
        int loopCrossfadeSamples = 0;
        float gain = 1.0f;
        float currentGain = 0.0f;
        float targetGain = 1.0f;
        float repeatStability = 0.0f;
        double startRampMs = 7.5;
        double stopRampMs = 14.0;
        bool releasePending = false;
        bool firstCallbackServiced = false;
        bool firstDragAudible = false;
        float lastPeak = 0.0f;
        double lastRenderWallTimeMs = 0.0;
        int mixedCallbackCount = 0;
        juce::int64 mixedSampleCount = 0;
    };

    struct PitchScrubPreviewStatus
    {
        bool active = false;
        bool releasePending = false;
        bool audible = false;
        bool previewArmed = false;
        bool firstCallbackServiced = false;
        bool firstDragAudible = false;
        juce::String trackId;
        juce::String clipId;
        float pitchRatio = 1.0f;
        float basePitchHz = 0.0f;
        float currentGain = 0.0f;
        float targetGain = 0.0f;
        float repeatStability = 0.0f;
        float lastPeak = 0.0f;
        double loopDurationMs = 0.0;
        double lastRenderWallTimeMs = 0.0;
        int mixedCallbackCount = 0;
        juce::int64 mixedSampleCount = 0;
        juce::String renderMethod;
    };

    struct PitchPreviewRoutingStatus
    {
        bool scrubPreviewActive = false;
        bool clipLivePreviewActive = false;
        bool renderedSegmentActive = false;
        bool correctedSourceActive = false;
        juce::String monitorMode;
    };

    // Set a pitch correction map for a clip (enables real-time preview)
    void setClipPitchPreview (const juce::String& clipId,
                              const ClipPitchPreviewData& preview);

    // Clear pitch preview for a clip (disables real-time preview)
    void clearClipPitchPreview (const juce::String& clipId);
    void clearAllPitchPreviewRoutes (const juce::String& clipId);
    int clearPitchPreviewRoutesForCorrectedSources();

    // Check if a clip has an active pitch preview
    bool hasClipPitchPreview (const juce::String& clipId) const;

    void setPitchScrubPreview (const PitchScrubPreviewData& preview);
    bool updatePitchScrubPreview (const juce::String& clipId, float pitchRatio);
    void clearPitchScrubPreview (const juce::String& clipId);
    bool hasPitchScrubPreview (const juce::String& clipId) const;
    void renderPitchScrubPreview (juce::AudioBuffer<float>& buffer, double sampleRate);
    PitchScrubPreviewStatus getPitchScrubPreviewStatus (const juce::String& clipId = {}) const;
    PitchPreviewRoutingStatus getPitchPreviewRoutingStatus (const juce::String& clipId = {}) const;

    // Utility
    int getNumClips() const { return (int)clips.size(); }
    int getNumClipsForTrack(const juce::String& trackId) const;
    int getTryLockFailureCount() const { return tryLockFailureCount.load(std::memory_order_relaxed); }
    int getMissingReaderCount() const { return missingReaderCount.load(std::memory_order_relaxed); }
    int getLastOverlappingClipCount() const { return lastOverlappingClipCount.load(std::memory_order_relaxed); }
    int getLastMixedClipCount() const { return lastMixedClipCount.load(std::memory_order_relaxed); }
    float getLastTrackPlaybackPeak() const { return lastTrackPlaybackPeak.load(std::memory_order_relaxed); }
    int getFileBufferResizeCount() const { return fileBufferResizeCount.load(std::memory_order_relaxed); }
    int getPitchShiftWorkBufferResizeCount() const { return pitchShiftWorkBufferResizeCount.load(std::memory_order_relaxed); }
    int getRenderResampleScratchResizeCount() const { return renderResampleScratchResizeCount.load(std::memory_order_relaxed); }
    int getChunkBoundaryReserveCount() const { return chunkBoundaryReserveCount.load(std::memory_order_relaxed); }

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
    mutable juce::CriticalSection lock;

    // Clip gain envelopes: key = "trackId::clipId", value = sorted envelope points
    std::map<juce::String, std::vector<GainEnvelopePoint>> gainEnvelopes;

    // Interpolate gain from envelope at a given time (relative to clip start)
    static float interpolateGainEnvelope(const std::vector<GainEnvelopePoint>& points, double time);

    // Pre-allocated file read buffer (avoids heap alloc on audio thread)
    juce::AudioBuffer<float> reusableFileBuffer;
    juce::AudioBuffer<float> renderResampleScratch;
    std::vector<int> reusableChunkBoundaries;

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

    // ---- Real-time pitch preview state ----

    struct ClipPitchPreviewState
    {
        ClipPitchPreviewData previewData;
        signalsmith::stretch::SignalsmithStretch<float> stretcher;
        bool prepared = false;
        double lastPlaybackTime = -1.0; // For seeking detection
        juce::CriticalSection clipLock;  // Protects stretcher + previewData from concurrent access
    };

    // Keyed by clipId — only clips with active pitch preview have entries
    std::map<juce::String, std::unique_ptr<ClipPitchPreviewState>> clipPitchPreviews;
    PitchScrubPreviewData pitchScrubPreview;
    PitchScrubPreviewStatus pitchScrubPreviewStatus;
    signalsmith::stretch::SignalsmithStretch<float> pitchScrubStretcher;
    bool pitchScrubStretcherPrepared = false;
    juce::AudioBuffer<float> pitchScrubInputBuffer;
    juce::AudioBuffer<float> pitchScrubOutputBuffer;

    // Pre-allocated buffer for pitch-shifted audio (avoids heap alloc on audio thread)
    juce::AudioBuffer<float> pitchShiftWorkBuffer;

    // Pre-allocated channel-pointer vectors for pitch-preview Signalsmith calls.
    // Audio files are at most stereo, so size 2 covers all cases.
    std::vector<const float*> pitchPreviewInPtrs;
    std::vector<float*>       pitchPreviewOutPtrs;

    // Look up pitch ratio from correction segments at a given clip-relative time
    static float lookupPitchRatio (const std::vector<PitchCorrectionSegment>& segments, double timeInClip);

    // Persistent map of pitch-corrected file paths: clipId → corrected file.
    // Survives clearAllClips() so that syncClipsWithBackend (which re-adds clips
    // with the original file path) doesn't destroy corrections.
    // Cleared explicitly via clearPitchCorrectionFile().
    std::map<juce::String, juce::File> pitchCorrectedFiles;

    struct DeferredClipSwap
    {
        juce::File audioFile;
        bool restoringOriginal = false;
    };

    std::map<juce::String, std::vector<RenderedPreviewSegment>> renderedPreviewSegments;
    std::map<juce::String, int> renderedPreviewSegmentGenerations;
    std::map<juce::String, DeferredClipSwap> deferredClipSwaps;
    std::atomic<int> tryLockFailureCount { 0 };
    std::atomic<int> missingReaderCount { 0 };
    std::atomic<int> lastOverlappingClipCount { 0 };
    std::atomic<int> lastMixedClipCount { 0 };
    std::atomic<float> lastTrackPlaybackPeak { 0.0f };
    std::atomic<int> fileBufferResizeCount { 0 };
    std::atomic<int> pitchShiftWorkBufferResizeCount { 0 };
    std::atomic<int> renderResampleScratchResizeCount { 0 };
    std::atomic<int> chunkBoundaryReserveCount { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PlaybackEngine)
};
