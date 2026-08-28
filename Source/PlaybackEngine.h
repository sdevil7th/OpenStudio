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
#include <array>

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
        juce::String readerKey;      // Stable read-ahead stream for this logical clip
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
    void removeClipById(const juce::String& trackId, const juce::String& clipId);
    void clearAllClips();
    void clearTrackClips(const juce::String& trackId);

    // Hot-swap a clip's audio file (used after pitch correction writes a new file)
    void replaceClipAudioFile(const juce::String& clipId, const juce::File& newFile);
    void queueDeferredClipAudioFile(const juce::String& clipId, const juce::File& newFile, bool restoringOriginal = false);
    void cancelDeferredClipAudioFile(const juce::String& clipId);
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
        juce::String readerKey;
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

    struct PitchPreviewRoutingDiagnosticStatus
    {
        bool scrubPreviewActive = false;
        bool clipLivePreviewActive = false;
        bool renderedSegmentActive = false;
        bool correctedSourceActive = false;
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
    bool mayRenderPitchScrubPreview() const noexcept
    {
        return pitchScrubPreviewMayRender.load(std::memory_order_acquire);
    }
    void renderPitchScrubPreview (juce::AudioBuffer<float>& buffer, double sampleRate);
    PitchScrubPreviewStatus getPitchScrubPreviewStatus (const juce::String& clipId = {}) const;
    PitchPreviewRoutingStatus getPitchPreviewRoutingStatus (const juce::String& clipId = {}) const;
    // Lock-free aggregate route snapshot for diagnostics. Per-clip queries use
    // getPitchPreviewRoutingStatus(clipId) and retain their detailed locked path.
    PitchPreviewRoutingDiagnosticStatus getPitchPreviewRoutingDiagnosticStatus() const noexcept;

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
    int getAudioDataCacheMissCount() const { return audioDataCacheMissCount.load(std::memory_order_relaxed); }
    int getAudioDataCachedFileCount() const { return cachedReaderCount.load(std::memory_order_acquire); }
    juce::int64 getStreamingReadAheadCapacityBytes() const;
    int getStreamingReaderEvictionCount() const { return streamingReaderEvictionCount.load(std::memory_order_relaxed); }
    int getStreamingReaderBudgetOvercommitCount() const { return streamingReaderBudgetOvercommitCount.load(std::memory_order_relaxed); }
    int getFullyDecodedSourceCount() const { return fullyDecodedSourceCount.load(std::memory_order_acquire); }
    juce::int64 getFullyDecodedSourceBytes() const { return fullyDecodedSourceBytes.load(std::memory_order_acquire); }
    int getFullyDecodedSourceEvictionCount() const { return fullyDecodedSourceEvictionCount.load(std::memory_order_relaxed); }
    int getFullyDecodedSourceBudgetFallbackCount() const { return fullyDecodedSourceBudgetFallbackCount.load(std::memory_order_relaxed); }
    int getStreamingContinuityConcealmentCount() const { return streamingContinuityConcealmentCount.load(std::memory_order_relaxed); }
    juce::int64 getStreamingContinuityConcealedSampleCount() const { return streamingContinuityConcealedSampleCount.load(std::memory_order_relaxed); }
    int getStreamingContinuityRecoveryCount() const { return streamingContinuityRecoveryCount.load(std::memory_order_relaxed); }
    int getOuterLockContinuityConcealmentCount() const { return outerLockContinuityConcealmentCount.load(std::memory_order_relaxed); }
    juce::int64 getOuterLockContinuityConcealedSampleCount() const { return outerLockContinuityConcealedSampleCount.load(std::memory_order_relaxed); }
    int getOuterLockContinuityRecoveryCount() const { return outerLockContinuityRecoveryCount.load(std::memory_order_relaxed); }

    struct StreamingContinuityRegressionResult
    {
        bool passed = false;
        float concealmentEntryStep = 0.0f;
        float recoveryMaximumStep = 0.0f;
        float partitionMaximumDifference = 0.0f;
        float recoveredSample = 0.0f;
        float fadeToZeroFinalSample = 0.0f;
    };

    // Deterministic coverage of the same bounded conceal/recovery state used by
    // the callback when a large streaming source misses its read-ahead window.
    static StreamingContinuityRegressionResult
        runStreamingContinuityRegression() noexcept;

    struct OuterLockContinuityRegressionResult
    {
        bool passed = false;
        int tryLockMisses = 0;
        int concealmentEvents = 0;
        int recoveryEvents = 0;
        float concealmentEntryStep = 0.0f;
        float recoveryEntryStep = 0.0f;
        float recoveredSample = 0.0f;
    };

    // Forces the publication lock to be owned by another thread and verifies
    // that fillTrackBuffer emits bounded continuity rather than dropping the
    // complete playback contribution.
    static OuterLockContinuityRegressionResult
        runOuterLockContinuityRegression();

    // Control-thread hint used before starts/seeks. It only requests/optionally
    // waits for JUCE's background buffering thread; source decoding never runs
    // on the realtime callback.
    void requestReadAheadAtTime(double timelineTimeSeconds);

    // Thread-safe snapshot of all clips (for offline rendering)
    std::vector<ClipInfo> getClipSnapshot() const;

    // Render mode: uses Lagrange interpolation for higher quality resampling
    void setRenderMode(bool isRendering) { renderMode = isRendering; }

    // Each streaming reader holds two 32768-frame blocks and source readers are
    // capped to two channels. The normal cache target is therefore 128 MiB.
    // Readers referenced by active clips are never evicted into permanent
    // silence; an exceptional overcommit is surfaced by telemetry.
    static constexpr int MAX_CACHED_READERS = 256;
    static constexpr int STREAMING_READ_AHEAD_SAMPLES = 32768;
    static constexpr juce::int64 MAX_FULLY_DECODED_SOURCE_BYTES =
        64LL * 1024LL * 1024LL;
    static constexpr juce::int64 MAX_FULLY_DECODED_CACHE_BYTES =
        256LL * 1024LL * 1024LL;
    
private:
    static constexpr int STREAMING_RECOVERY_SAMPLES = 64;
    static constexpr float STREAMING_CONCEALMENT_DECAY = 0.9995f;

    struct FullyDecodedSource
    {
        juce::AudioBuffer<float> samples;
        double sampleRate = 0.0;
        juce::int64 lengthInSamples = 0;
        int numChannels = 0;
        juce::int64 decodedBytes = 0;
    };

    struct StreamingContinuityState
    {
        std::array<float, 2> lastOutput {};
        std::array<float, 2> concealedOutput {};
        double expectedNextTimelineTime = 0.0;
        int recoverySamplesRemaining = 0;
        int activeChannels = 0;
        bool hasOutputHistory = false;
        bool hasExpectedTimelineTime = false;
        bool concealing = false;

        void reset(int channels) noexcept;
        bool beginBlock(bool sourceReady,
                        bool timelineContiguous,
                        int channels) noexcept;
        float processSample(int channel,
                            float sourceSample,
                            bool sourceReady) noexcept;
        void advanceFrame(bool sourceReady) noexcept;
    };

    struct TrackPlaybackContinuitySlot
    {
        juce::int64 trackKey = 0;
        juce::uint64 lastUseCounter = 0;
        StreamingContinuityState continuity;
    };

    std::vector<ClipInfo> clips;
    // Declared before readers so it outlives them during reverse-order member
    // destruction. BufferingAudioReader registers itself as a time-slice client.
    juce::TimeSliceThread streamingReadAheadThread { "PlaybackEngine-ReadAhead" };
    std::map<juce::String, std::shared_ptr<juce::BufferingAudioReader>> readers;
    // One fixed-size state per streaming reader. Entries are created and
    // retired on the control thread while the existing publication lock is
    // held; the callback only performs a lookup and updates scalar state.
    std::map<juce::String, StreamingContinuityState>
        streamingContinuityStates;
    // Eligible sources are decoded completely before publication. The callback
    // reads them through raw const pointers and never changes ownership or
    // waits on a decoder/read-ahead lock.
    std::map<juce::String, std::unique_ptr<FullyDecodedSource>>
        fullyDecodedSources;
    std::map<juce::String, juce::int64>
        fullyDecodedSourceAccessTimes;
    juce::int64 fullyDecodedBytesInUse = 0;
    juce::AudioFormatManager formatManager;
    mutable juce::CriticalSection lock;

    // Clip gain envelopes: key = "trackId::clipId", value = sorted envelope points
    std::map<juce::String, std::vector<GainEnvelopePoint>> gainEnvelopes;

    // Interpolate gain from envelope at a given time (relative to clip start)
    static float interpolateGainEnvelope(const std::vector<GainEnvelopePoint>& points, double time);

    // Pre-allocated file read buffer (avoids heap alloc on audio thread)
    juce::AudioBuffer<float> reusableFileBuffer;
    // Playback is accumulated separately from sends/live input so an outer
    // publication-lock miss can conceal only the missing clip contribution.
    juce::AudioBuffer<float> reusableTrackPlaybackBuffer;
    juce::AudioBuffer<float> renderResampleScratch;
    std::vector<int> reusableChunkBoundaries;

    static constexpr size_t TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT = 128;
    std::array<TrackPlaybackContinuitySlot,
               TRACK_PLAYBACK_CONTINUITY_SLOT_COUNT>
        trackPlaybackContinuitySlots {};
    juce::uint64 trackPlaybackContinuityUseCounter = 0;
    StreamingContinuityState&
        getTrackPlaybackContinuityState(
            const juce::String& trackId) noexcept;

    // Get cached audio format reader (audio-thread safe — never creates readers)
    juce::BufferingAudioReader* getCachedReader(const juce::String& readerKey);
    const FullyDecodedSource* getFullyDecodedSource(
        const juce::String& readerKey) const noexcept;

    // Pre-load reader on message thread so it's ready for audio thread
    void preloadReader(const juce::File& file,
                       const juce::String& readerKey,
                       double initialOffsetSeconds = 0.0,
                       int maxWaitMilliseconds = 50);
    static bool primeStreamingReader(juce::BufferingAudioReader& reader,
                                     double offsetSeconds,
                                     int maxWaitMilliseconds);

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
    void evictOldReaders(const juce::String& protectedKey = {});
    bool evictFullyDecodedSourcesToFitLocked(
        juce::int64 requiredBytes,
        const juce::String& protectedKey,
        std::vector<std::unique_ptr<FullyDecodedSource>>& retiredSources);
    void refreshStreamingReaderDiagnosticsLocked() noexcept;
    void refreshFullyDecodedSourceDiagnosticsLocked() noexcept;
    void refreshPitchPreviewRoutingDiagnosticsLocked() noexcept;

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
    std::atomic<bool> pitchScrubPreviewMayRender { false };
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
    std::atomic<int> audioDataCacheMissCount { 0 };
    std::atomic<int> cachedReaderCount { 0 };
    std::atomic<juce::int64> cachedStreamingReadAheadCapacityBytes { 0 };
    std::atomic<unsigned int> pitchPreviewRoutingDiagnosticFlags { 0 };
    std::atomic<int> streamingReaderEvictionCount { 0 };
    std::atomic<int> streamingReaderBudgetOvercommitCount { 0 };
    std::atomic<int> fullyDecodedSourceCount { 0 };
    std::atomic<juce::int64> fullyDecodedSourceBytes { 0 };
    std::atomic<int> fullyDecodedSourceEvictionCount { 0 };
    std::atomic<int> fullyDecodedSourceBudgetFallbackCount { 0 };
    std::atomic<int> streamingContinuityConcealmentCount { 0 };
    std::atomic<juce::int64> streamingContinuityConcealedSampleCount { 0 };
    std::atomic<int> streamingContinuityRecoveryCount { 0 };
    std::atomic<int> outerLockContinuityConcealmentCount { 0 };
    std::atomic<juce::int64> outerLockContinuityConcealedSampleCount { 0 };
    std::atomic<int> outerLockContinuityRecoveryCount { 0 };

    static_assert(std::atomic<int>::is_always_lock_free);
    static_assert(std::atomic<juce::int64>::is_always_lock_free);
    static_assert(std::atomic<unsigned int>::is_always_lock_free);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PlaybackEngine)
};
