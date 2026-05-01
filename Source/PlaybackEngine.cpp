#include "PlaybackEngine.h"
#include <algorithm>
#include <cmath>

namespace
{
#if JUCE_DEBUG
constexpr bool kAudioPlaybackDebugLogs = true;
#else
constexpr bool kAudioPlaybackDebugLogs = false;
#endif

static void logAudioPlayback(const juce::String& message)
{
    if (kAudioPlaybackDebugLogs)
        juce::Logger::writeToLog("[audio.playback] " + message);
}

static float peakForBuffer(const juce::AudioBuffer<float>& buffer, int numSamples)
{
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto range = juce::FloatVectorOperations::findMinAndMax(buffer.getReadPointer(ch), numSamples);
        peak = juce::jmax(peak, juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd())));
    }
    return peak;
}

static float getPitchOnlyPreviewTonalityLimitHz (bool downwardShift)
{
    const auto specificName = downwardShift
        ? "OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_DOWN"
        : "OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_UP";
    const auto specificValue = juce::SystemStats::getEnvironmentVariable (specificName, {}).trim();
    if (specificValue.isNotEmpty())
        return juce::jlimit (0.0f, 20000.0f, specificValue.getFloatValue());

    const auto value = juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ", {}).trim();
    if (value.isEmpty())
        return downwardShift ? 2600.0f : 1050.0f;

    return juce::jlimit (0.0f, 20000.0f, value.getFloatValue());
}

static float sampleLoopBufferLocal (const juce::AudioBuffer<float>& buffer,
                                    int channel,
                                    double position,
                                    int crossfadeSamples)
{
    const int numChannels = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    if (numChannels <= 0 || numSamples <= 1)
        return 0.0f;

    const int safeChannel = juce::jlimit (0, numChannels - 1, channel);
    auto wrapPosition = std::fmod (position, static_cast<double> (numSamples));
    if (wrapPosition < 0.0)
        wrapPosition += static_cast<double> (numSamples);

    const auto sampleAt = [&buffer, safeChannel, numSamples] (double pos)
    {
        auto wrapped = std::fmod (pos, static_cast<double> (numSamples));
        if (wrapped < 0.0)
            wrapped += static_cast<double> (numSamples);
        const int index0 = juce::jlimit (0, numSamples - 1, static_cast<int> (std::floor (wrapped)));
        const int index1 = (index0 + 1) % numSamples;
        const float frac = static_cast<float> (wrapped - static_cast<double> (index0));
        const float s0 = buffer.getSample (safeChannel, index0);
        const float s1 = buffer.getSample (safeChannel, index1);
        return s0 + (s1 - s0) * frac;
    };

    float value = sampleAt (wrapPosition);
    const int safeCrossfade = juce::jlimit (0, numSamples / 3, crossfadeSamples);
    if (safeCrossfade <= 1)
        return value;

    const double crossfadeStart = static_cast<double> (numSamples - safeCrossfade);
    if (wrapPosition >= crossfadeStart)
    {
        const float blend = static_cast<float> ((wrapPosition - crossfadeStart)
            / static_cast<double> (safeCrossfade));
        const float wrappedValue = sampleAt (wrapPosition - static_cast<double> (numSamples));
        value = value * (1.0f - blend) + wrappedValue * blend;
    }

    return value;
}
}

float PlaybackEngine::applyFadeCurve(float t, int curveType)
{
    // t is normalized 0.0 to 1.0
    switch (curveType) {
        case 1: return std::sqrt(t);                                          // equal power
        case 2: return 3.0f * t * t - 2.0f * t * t * t;                      // S-curve (smoothstep)
        case 3: return std::log10(1.0f + 9.0f * t);                           // logarithmic
        case 4: return (std::exp(3.0f * t) - 1.0f) / (std::exp(3.0f) - 1.0f); // exponential
        default: return t;                                                     // linear (0 or unknown)
    }
}

PlaybackEngine::PlaybackEngine()
{
    formatManager.registerBasicFormats();

    // Pre-allocate pitch-preview channel-pointer vectors (max stereo = 2 channels).
    // Avoids heap allocation inside fillTrackBuffer for every pitch-previewed clip.
    pitchPreviewInPtrs.resize (2);
    pitchPreviewOutPtrs.resize (2);
}

PlaybackEngine::~PlaybackEngine()
{
    juce::ScopedLock sl(lock);
    readers.clear();
    clips.clear();
}

void PlaybackEngine::preloadReader(const juce::File& file)
{
    // Called from message thread — creates reader so audio thread never does disk I/O
    juce::String filePath = file.getFullPathName();
    auto it = readers.find(filePath);
    if (it != readers.end() && it->second != nullptr)
    {
        readerAccessTimes[filePath] = juce::Time::currentTimeMillis();
        return;  // Already loaded
    }

    std::unique_ptr<juce::AudioFormatReader> newReader(formatManager.createReaderFor(file));
    if (newReader)
    {
        readers[filePath] = std::move(newReader);
        readerAccessTimes[filePath] = juce::Time::currentTimeMillis();
        evictOldReaders();
        juce::Logger::writeToLog("PlaybackEngine: Pre-loaded reader for: " + filePath);
    }
}

juce::AudioFormatReader* PlaybackEngine::getCachedReader(const juce::File& file)
{
    // Audio-thread safe: only looks up, never creates readers
    auto it = readers.find(file.getFullPathName());
    if (it != readers.end() && it->second != nullptr)
    {
        readerAccessTimes[file.getFullPathName()] = juce::Time::currentTimeMillis();
        return it->second.get();
    }
    return nullptr;
}

void PlaybackEngine::evictOldReaders()
{
    if ((int)readers.size() <= MAX_CACHED_READERS)
        return;

    // Evict the oldest 25% by access time
    int numToEvict = (int)readers.size() / 4;
    if (numToEvict < 1) numToEvict = 1;

    // Collect entries sorted by access time (oldest first)
    std::vector<std::pair<juce::int64, juce::String>> entries;
    for (const auto& [path, accessTime] : readerAccessTimes)
        entries.push_back({ accessTime, path });

    std::sort(entries.begin(), entries.end());

    for (int i = 0; i < numToEvict && i < (int)entries.size(); ++i)
    {
        const auto& path = entries[i].second;
        readers.erase(path);
        readerAccessTimes.erase(path);
    }

    juce::Logger::writeToLog("PlaybackEngine: Evicted " + juce::String(numToEvict) + " old readers");
}

float PlaybackEngine::interpolateGainEnvelope(const std::vector<GainEnvelopePoint>& points, double time)
{
    if (points.empty())
        return 1.0f;

    // Before first point
    if (time <= points.front().time)
        return points.front().gain;

    // After last point
    if (time >= points.back().time)
        return points.back().gain;

    // Find surrounding points and interpolate linearly
    for (size_t i = 0; i + 1 < points.size(); ++i)
    {
        if (time >= points[i].time && time < points[i + 1].time)
        {
            double t = (time - points[i].time) / (points[i + 1].time - points[i].time);
            return points[i].gain + static_cast<float>(t) * (points[i + 1].gain - points[i].gain);
        }
    }

    return 1.0f;
}

void PlaybackEngine::setClipGainEnvelope(const juce::String& trackId, const juce::String& clipId,
                                          const std::vector<GainEnvelopePoint>& points)
{
    juce::ScopedLock sl(lock);
    juce::String key = trackId + "::" + clipId;
    if (points.empty())
        gainEnvelopes.erase(key);
    else
        gainEnvelopes[key] = points;
}

void PlaybackEngine::addClip(const juce::File& audioFile, double startTime, double duration, const juce::String& trackId,
                              double offset, double volumeDB, double fadeIn, double fadeOut, const juce::String& clipId,
                              const juce::File& sourceAudioFile, double sourceOffset)
{
    juce::ScopedLock sl(lock);

    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine: Cannot add clip - file does not exist: " + audioFile.getFullPathName());
        return;
    }

    juce::File effectiveFile = audioFile;
    double effectiveOffset = offset;
    const bool hasActivePitchPreview = clipId.isNotEmpty() && clipPitchPreviews.find(clipId) != clipPitchPreviews.end();

    // If a live pitch preview is active, always base playback on the original source.
    // syncClipsWithBackend re-adds clips on every play, and the store's filePath may still
    // point at an older corrected render. Reusing that here would make the live preview
    // process already-corrected audio again, compounding pitch/formant on every play cycle.
    if (hasActivePitchPreview && sourceAudioFile.existsAsFile())
    {
        effectiveFile = sourceAudioFile;
        effectiveOffset = sourceOffset >= 0.0 ? sourceOffset : offset;
        juce::Logger::writeToLog("PlaybackEngine: Using original source for live preview clip " + clipId
                                  + " -> " + effectiveFile.getFullPathName());
    }
    else
    {
        // Check if this clip has a pitch-corrected file from a previous session.
        // syncClipsWithBackend always re-adds clips with the original filePath from
        // the frontend store, but the corrected file should be used for playback.
        auto correctedIt = pitchCorrectedFiles.find(clipId);
        if (correctedIt != pitchCorrectedFiles.end() && correctedIt->second.existsAsFile())
        {
            effectiveFile = correctedIt->second;
            effectiveOffset = 0.0; // Corrected files always start at sample 0
            juce::Logger::writeToLog("PlaybackEngine: Using corrected file for clip " + clipId
                                      + " -> " + effectiveFile.getFullPathName());
        }
    }

    // Pre-load the reader on the message thread so audio thread never does disk I/O
    preloadReader(effectiveFile);
    if (clipId.isNotEmpty())
    {
        auto segmentIt = renderedPreviewSegments.find (clipId);
        if (segmentIt != renderedPreviewSegments.end())
        {
            for (const auto& segment : segmentIt->second)
            {
                if (segment.audioFile.existsAsFile())
                    preloadReader (segment.audioFile);
            }
        }
    }

    ClipInfo clip(effectiveFile, startTime, duration, trackId, effectiveOffset, volumeDB, fadeIn, fadeOut);
    clip.clipId = clipId;
    clip.envelopeKey = trackId + "::" + clipId;  // Pre-compute to avoid string alloc on audio thread
    clip.originalAudioFile = sourceAudioFile.existsAsFile() ? sourceAudioFile : audioFile;
    clip.originalOffset = sourceOffset >= 0.0 ? sourceOffset : offset;
    clips.push_back(clip);

    juce::Logger::writeToLog("PlaybackEngine: Added clip - Track " + trackId +
                           ", Start: " + juce::String(startTime) +
                           "s, Duration: " + juce::String(duration) +
                           "s, Offset: " + juce::String(offset) +
                           "s, Volume: " + juce::String(volumeDB) + "dB");
    logAudioPlayback("addClip track=" + trackId
        + " clipId=" + clipId
        + " file=" + effectiveFile.getFullPathName()
        + " originalFile=" + clip.originalAudioFile.getFullPathName()
        + " start=" + juce::String(startTime, 3)
        + " duration=" + juce::String(duration, 3)
        + " offset=" + juce::String(effectiveOffset, 3)
        + " totalClips=" + juce::String(static_cast<int>(clips.size())));
}

void PlaybackEngine::removeClip(const juce::String& trackId, const juce::String& filePath)
{
    juce::ScopedLock sl(lock);
    
    clips.erase(
        std::remove_if(clips.begin(), clips.end(),
            [&trackId, &filePath](const ClipInfo& clip) {
                return clip.trackId == trackId && 
                       clip.audioFile.getFullPathName() == filePath;
            }),
        clips.end()
    );
    
    juce::Logger::writeToLog("PlaybackEngine: Removed clip from track " + trackId);
}

void PlaybackEngine::replaceClipAudioFile(const juce::String& clipId, const juce::File& newFile)
{
    if (!newFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine::replaceClipAudioFile: file does not exist: " + newFile.getFullPathName());
        return;
    }

    juce::ScopedLock sl(lock);
    for (auto& clip : clips)
    {
        if (clip.clipId == clipId)
        {
            // Evict old reader so the audio thread stops reading the old file
            readers.erase(clip.audioFile.getFullPathName());
            readerAccessTimes.erase(clip.audioFile.getFullPathName());
            // Swap in the new file. Corrected files start at sample 0, but restoring
            // the original file should also restore the original trim offset.
            const bool restoringOriginal = (newFile == clip.originalAudioFile);
            clip.audioFile = newFile;
            clip.offset = restoringOriginal ? clip.originalOffset : 0.0;
            // Pre-load new reader while we still hold the lock (same pattern as addClip)
            preloadReader(newFile);
            // Clear any active pitch preview — the corrected audio is now baked
            // into the file, so the real-time PitchShifter must not double-shift.
            clipPitchPreviews.erase(clipId);
            if (pitchScrubPreview.clipId == clipId)
            {
                pitchScrubPreview = {};
                pitchScrubPreviewStatus = {};
                pitchScrubStretcherPrepared = false;
            }
            renderedPreviewSegments.erase(clipId);
            auto& renderedGeneration = renderedPreviewSegmentGenerations[clipId];
            ++renderedGeneration;
            if (renderedGeneration <= 0)
                renderedGeneration = 1;
            deferredClipSwaps.erase(clipId);
            // Remember the corrected file so it survives clearAllClips + re-add cycles.
            if (restoringOriginal)
                pitchCorrectedFiles.erase(clipId);
            else
                pitchCorrectedFiles[clipId] = newFile;
            juce::Logger::writeToLog("PlaybackEngine: Replaced audio file for clip " + clipId +
                                     " -> " + newFile.getFullPathName());
            return;
        }
    }
    juce::Logger::writeToLog("PlaybackEngine::replaceClipAudioFile: clip not found: " + clipId);
}

void PlaybackEngine::queueDeferredClipAudioFile(const juce::String& clipId, const juce::File& newFile, bool restoringOriginal)
{
    if (!newFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine::queueDeferredClipAudioFile: file does not exist: " + newFile.getFullPathName());
        return;
    }

    juce::ScopedLock sl(lock);
    deferredClipSwaps[clipId] = { newFile, restoringOriginal };
    juce::Logger::writeToLog("PlaybackEngine: Deferred audio file swap for clip " + clipId
        + " -> " + newFile.getFullPathName());
}

bool PlaybackEngine::commitDeferredClipAudioFile(const juce::String& clipId)
{
    juce::File fileToCommit;
    {
        juce::ScopedLock sl(lock);
        auto it = deferredClipSwaps.find(clipId);
        if (it == deferredClipSwaps.end())
            return false;
        fileToCommit = it->second.audioFile;
    }

    replaceClipAudioFile(clipId, fileToCommit);
    return true;
}

int PlaybackEngine::commitAllDeferredClipAudioFiles()
{
    std::vector<juce::String> clipIds;
    {
        juce::ScopedLock sl(lock);
        for (const auto& [clipId, _swap] : deferredClipSwaps)
            clipIds.push_back(clipId);
    }

    int committed = 0;
    for (const auto& clipId : clipIds)
        if (commitDeferredClipAudioFile(clipId))
            ++committed;
    return committed;
}

bool PlaybackEngine::setClipRenderedPreviewSegment(const juce::String& clipId,
                                                   const juce::File& audioFile,
                                                   double startSec,
                                                   double endSec,
                                                   double fileOffsetSec,
                                                   int generation)
{
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine::setClipRenderedPreviewSegment: file does not exist: " + audioFile.getFullPathName());
        return false;
    }

    juce::ScopedLock sl(lock);
    if (pitchCorrectedFiles.find(clipId) != pitchCorrectedFiles.end())
    {
        juce::Logger::writeToLog("PlaybackEngine: Rejected rendered preview segment for corrected-source clip " + clipId);
        return false;
    }

    if (generation > 0)
    {
        const auto genIt = renderedPreviewSegmentGenerations.find(clipId);
        const int currentGeneration = genIt != renderedPreviewSegmentGenerations.end() ? genIt->second : 0;
        if (currentGeneration != generation)
        {
            juce::Logger::writeToLog("PlaybackEngine: Rejected stale rendered preview segment for clip " + clipId
                + " generation=" + juce::String(generation)
                + " current=" + juce::String(currentGeneration));
            return false;
        }
    }

    preloadReader(audioFile);
    auto& segments = renderedPreviewSegments[clipId];
    segments.erase(std::remove_if(segments.begin(), segments.end(),
        [startSec, endSec](const RenderedPreviewSegment& segment)
        {
            const bool sameWindow = std::abs(segment.startSec - startSec) < 0.001
                && std::abs(segment.endSec - endSec) < 0.001;
            const bool overlaps = !(segment.endSec <= startSec || segment.startSec >= endSec);
            return sameWindow || overlaps;
        }),
        segments.end());
    segments.push_back({ audioFile, startSec, endSec, fileOffsetSec });
    std::sort(segments.begin(), segments.end(), [] (const RenderedPreviewSegment& a, const RenderedPreviewSegment& b) {
        return a.startSec < b.startSec;
    });
    juce::Logger::writeToLog("PlaybackEngine: Set rendered preview segment for clip " + clipId
        + " [" + juce::String(startSec, 3) + ", " + juce::String(endSec, 3) + "]"
        + " fileOffset=" + juce::String(fileOffsetSec, 3)
        + " generation=" + juce::String(generation)
        + " -> " + audioFile.getFullPathName());
    return true;
}

void PlaybackEngine::beginRenderedPreviewSegmentGeneration(const juce::String& clipId, int generation)
{
    juce::ScopedLock sl(lock);
    renderedPreviewSegments.erase(clipId);
    renderedPreviewSegmentGenerations[clipId] = generation;
    juce::Logger::writeToLog("PlaybackEngine: Began rendered preview generation for clip " + clipId
        + " generation=" + juce::String(generation));
}

void PlaybackEngine::invalidateRenderedPreviewSegments(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;
    juce::Logger::writeToLog("PlaybackEngine: Invalidated rendered preview segments for clip " + clipId
        + " generation=" + juce::String(generation));
}

void PlaybackEngine::clearClipRenderedPreviewSegments(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;
    juce::Logger::writeToLog("PlaybackEngine: Cleared rendered preview segments for clip " + clipId
        + " generation=" + juce::String(generation));
}

void PlaybackEngine::clearAllPitchPreviewRoutes(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    const bool clearAll = clipId.isEmpty();
    if (clearAll)
    {
        clipPitchPreviews.clear();
        renderedPreviewSegments.clear();
        for (auto& [id, generation] : renderedPreviewSegmentGenerations)
        {
            juce::ignoreUnused(id);
            ++generation;
            if (generation <= 0)
                generation = 1;
        }
        pitchScrubPreview = {};
        pitchScrubPreviewStatus = {};
        pitchScrubStretcherPrepared = false;
        juce::Logger::writeToLog("PlaybackEngine: Hard-cleared all pitch preview routes");
        return;
    }

    clipPitchPreviews.erase(clipId);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;

    if (pitchScrubPreview.clipId == clipId)
    {
        pitchScrubPreview = {};
        pitchScrubPreviewStatus = {};
        pitchScrubStretcherPrepared = false;
    }

    juce::Logger::writeToLog("PlaybackEngine: Hard-cleared pitch preview routes for clip " + clipId
        + " generation=" + juce::String(generation));
}

int PlaybackEngine::clearPitchPreviewRoutesForCorrectedSources()
{
    juce::ScopedLock sl(lock);
    int cleared = 0;
    for (const auto& [clipId, file] : pitchCorrectedFiles)
    {
        juce::ignoreUnused(file);
        const bool hadLive = clipPitchPreviews.erase(clipId) > 0;
        const bool hadRendered = renderedPreviewSegments.erase(clipId) > 0;
        bool hadScrub = false;
        if (pitchScrubPreview.clipId == clipId)
        {
            pitchScrubPreview = {};
            pitchScrubPreviewStatus = {};
            pitchScrubStretcherPrepared = false;
            hadScrub = true;
        }

        if (hadLive || hadRendered || hadScrub)
        {
            auto& generation = renderedPreviewSegmentGenerations[clipId];
            ++generation;
            if (generation <= 0)
                generation = 1;
            ++cleared;
        }
    }

    if (cleared > 0)
        juce::Logger::writeToLog("PlaybackEngine: Hard-cleared pitch preview routes for "
            + juce::String(cleared) + " corrected-source clip(s)");
    return cleared;
}

std::map<juce::String, std::vector<PlaybackEngine::RenderedPreviewSegment>> PlaybackEngine::getRenderedPreviewSegmentSnapshot() const
{
    juce::ScopedLock sl(lock);
    return renderedPreviewSegments;
}

PlaybackEngine::ClipPlaybackSourceStatus PlaybackEngine::getClipPlaybackSourceAtTime(const juce::String& trackId,
                                                                                      const juce::String& clipId,
                                                                                      double projectTimeSec) const
{
    juce::ScopedLock sl(lock);
    ClipPlaybackSourceStatus status;
    for (const auto& clip : clips)
    {
        if (clip.trackId != trackId || clip.clipId != clipId || !clip.isActive)
            continue;

        const double clipEndTime = clip.startTime + clip.duration;
        if (projectTimeSec < clip.startTime || projectTimeSec >= clipEndTime)
            continue;

        status.clipFound = true;
        status.clipTime = projectTimeSec - clip.startTime;
        status.audioFile = clip.audioFile.getFullPathName();
        status.playbackOffset = clip.offset + status.clipTime;
        status.sourceType = "original";

        auto segmentIt = renderedPreviewSegments.find(clipId);
        if (segmentIt != renderedPreviewSegments.end())
        {
            for (const auto& segment : segmentIt->second)
            {
                if (status.clipTime >= segment.startSec && status.clipTime < segment.endSec)
                {
                    status.renderedSegmentActiveAtTime = true;
                    status.sourceType = "rendered_segment";
                    status.audioFile = segment.audioFile.getFullPathName();
                    status.playbackOffset = segment.fileOffsetSec + (status.clipTime - segment.startSec);
                    return status;
                }
            }
        }

        auto correctedIt = pitchCorrectedFiles.find(clipId);
        if (correctedIt != pitchCorrectedFiles.end()
            && correctedIt->second.existsAsFile()
            && clip.audioFile == correctedIt->second)
        {
            status.correctedSourceActiveAtTime = true;
            status.sourceType = "corrected_source";
            status.audioFile = correctedIt->second.getFullPathName();
        }

        return status;
    }

    return status;
}

void PlaybackEngine::clearPitchCorrectionFile(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    pitchCorrectedFiles.erase(clipId);
    clipPitchPreviews.erase(clipId);
    renderedPreviewSegments.erase(clipId);
    auto& generation = renderedPreviewSegmentGenerations[clipId];
    ++generation;
    if (generation <= 0)
        generation = 1;
    if (pitchScrubPreview.clipId == clipId)
    {
        pitchScrubPreview = {};
        pitchScrubPreviewStatus = {};
        pitchScrubStretcherPrepared = false;
    }
    deferredClipSwaps.erase(clipId);
    juce::Logger::writeToLog("PlaybackEngine: Cleared pitch correction file for clip " + clipId);
}

void PlaybackEngine::clearAllClips()
{
    juce::ScopedLock sl(lock);
    const int previousClipCount = static_cast<int>(clips.size());
    const int preservedPreviewCount = static_cast<int>(clipPitchPreviews.size());
    const int preservedCorrectedCount = static_cast<int>(pitchCorrectedFiles.size());
    clips.clear();
    readers.clear();
    readerAccessTimes.clear();
    // NOTE: clipPitchPreviews is NOT cleared here — it must survive sync cycles.
    // syncClipsWithBackend calls clearAllClips + re-adds clips, and the preview
    // must persist so the user continues hearing edited notes across play cycles.
    // Preview is cleared explicitly by: replaceClipAudioFile (WORLD done),
    // clearClipPitchPreview (editor close), or clearPitchCorrectionFile.
    lagrangeInterpolatorL.reset();
    lagrangeInterpolatorR.reset();
    juce::Logger::writeToLog("PlaybackEngine: Cleared all clips (pitch previews preserved: "
                              + juce::String(static_cast<int>(clipPitchPreviews.size())) + ")");
    logAudioPlayback("clearAllClips previousClipCount=" + juce::String(previousClipCount)
        + " preservedPreviews=" + juce::String(preservedPreviewCount)
        + " preservedCorrectedFiles=" + juce::String(preservedCorrectedCount));
}

void PlaybackEngine::clearTrackClips(const juce::String& trackId)
{
    juce::ScopedLock sl(lock);

    clips.erase(
        std::remove_if(clips.begin(), clips.end(),
            [&trackId](const ClipInfo& clip) {
                return clip.trackId == trackId;
            }),
        clips.end()
    );

    lagrangeInterpolatorL.reset();
    lagrangeInterpolatorR.reset();

    juce::Logger::writeToLog("PlaybackEngine: Cleared clips for track " + trackId);
}

int PlaybackEngine::getNumClipsForTrack(const juce::String& trackId) const
{
    int count = 0;
    for (const auto& clip : clips)
    {
        if (clip.trackId == trackId)
            count++;
    }
    return count;
}

std::vector<PlaybackEngine::ClipInfo> PlaybackEngine::getClipSnapshot() const
{
    juce::ScopedLock sl(lock);
    return clips;
}

juce::AudioFormatReader* PlaybackEngine::getReader(const juce::File& file)
{
    juce::String filePath = file.getFullPathName();
    
    // Check if reader already exists
    auto it = readers.find(filePath);
    if (it != readers.end() && it->second != nullptr)
        return it->second.get();
    
    // Create new reader
    std::unique_ptr<juce::AudioFormatReader> newReader(formatManager.createReaderFor(file));
    if (newReader == nullptr)
    {
        juce::Logger::writeToLog("PlaybackEngine: Failed to create reader for: " + filePath);
        return nullptr;
    }
    
    auto* readerPtr = newReader.get();
    readers[filePath] = std::move(newReader);
    
    juce::Logger::writeToLog("PlaybackEngine: Created reader for: " + filePath);
    return readerPtr;
}

// ---- Pitch preview methods ----

void PlaybackEngine::setClipPitchPreview (const juce::String& clipId,
                                           const ClipPitchPreviewData& preview)
{
    juce::ScopedLock sl (lock);

    // If the clip currently has a pitch-corrected file baked in, revert to the
    // original audio so the real-time preview applies to the UNCORRECTED audio.
    // Without this, the preview would double-shift: the corrected file already
    // has the old pitch shift baked in, and the preview would add the new ratio
    // on top — always increasing pitch regardless of direction.
    auto corrIt = pitchCorrectedFiles.find (clipId);
    if (corrIt != pitchCorrectedFiles.end() && ! preview.allowReplacingCorrectedSource)
    {
        juce::Logger::writeToLog ("PlaybackEngine: Rejected pitch preview for corrected-source clip " + clipId
            + " because the request did not opt into a new interactive preview generation");
        return;
    }

    for (auto& clip : clips)
    {
        if (clip.clipId == clipId && clip.originalAudioFile.existsAsFile())
        {
            const bool usingOriginalAlready = (clip.audioFile == clip.originalAudioFile)
                && std::abs (clip.offset - clip.originalOffset) < 0.0005;
            if (! usingOriginalAlready)
            {
                readers.erase (clip.audioFile.getFullPathName());
                readerAccessTimes.erase (clip.audioFile.getFullPathName());
                clip.audioFile = clip.originalAudioFile;
                clip.offset = clip.originalOffset;
                preloadReader (clip.audioFile);
                juce::Logger::writeToLog ("PlaybackEngine: Reverted clip " + clipId
                    + " to original file for preview");
            }
            break;
        }
    }
    if (corrIt != pitchCorrectedFiles.end())
        pitchCorrectedFiles.erase (corrIt);

    auto it = clipPitchPreviews.find (clipId);
    if (it != clipPitchPreviews.end())
    {
        juce::ScopedLock clipSl (it->second->clipLock);
        it->second->previewData = preview;
        // Do NOT reset prepared/lastPlaybackTime here — the stretcher must stay
        // coherent across rolling 250ms preview refreshes. Resetting it causes
        // the stretcher to emit latency-fill (wrong audio) for ~100ms at every
        // refresh cycle, producing periodic crackle and word-beginning cutoffs.
        // Seek detection (|clipTime - lastPlaybackTime| > 0.1s) in fillTrackBuffer
        // handles genuine playhead jumps without needing a reset here.
    }
    else
    {
        auto state = std::make_unique<ClipPitchPreviewState>();
        state->previewData = preview;
        clipPitchPreviews[clipId] = std::move (state);
    }

    juce::Logger::writeToLog ("PlaybackEngine: Set preview for clip " + clipId
                               + " pitchSegments=" + juce::String ((int) preview.pitchSegments.size())
                               + " globalFormantSt=" + juce::String (preview.globalFormantSemitones, 3)
                               + " liveFormantSuppressed=" + juce::String (std::abs (preview.globalFormantSemitones) > 0.01f ? "yes" : "no")
                               + " window=[" + juce::String (preview.previewStartSec, 3)
                               + "," + juce::String (preview.previewEndSec, 3) + "]");
}

void PlaybackEngine::clearClipPitchPreview (const juce::String& clipId)
{
    juce::ScopedLock sl (lock);
    clipPitchPreviews.erase (clipId);
    juce::Logger::writeToLog ("PlaybackEngine: Cleared pitch preview for clip " + clipId);
}

bool PlaybackEngine::hasClipPitchPreview (const juce::String& clipId) const
{
    return clipPitchPreviews.find (clipId) != clipPitchPreviews.end();
}

void PlaybackEngine::setPitchScrubPreview (const PitchScrubPreviewData& preview)
{
    juce::ScopedLock sl (lock);
    pitchScrubPreview = preview;
    pitchScrubPreview.active = preview.loopBuffer.getNumSamples() > 8
        && preview.loopBuffer.getNumChannels() > 0
        && preview.pitchRatio > 0.0f;
    pitchScrubPreview.readPosition = 0.0;
    pitchScrubPreview.currentGain = 0.0f;
    pitchScrubPreview.targetGain = juce::jlimit (0.0f, 2.0f, preview.gain);
    pitchScrubPreview.releasePending = false;
    pitchScrubPreview.lastPeak = 0.0f;
    pitchScrubPreview.lastRenderWallTimeMs = 0.0;
    pitchScrubPreview.mixedCallbackCount = 0;
    pitchScrubPreview.mixedSampleCount = 0;
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";
    pitchScrubStretcherPrepared = false;
    pitchScrubPreview.loopCrossfadeSamples = juce::jlimit (8,
        std::max (8, preview.loopBuffer.getNumSamples() / 3),
        preview.loopCrossfadeSamples > 0
            ? preview.loopCrossfadeSamples
            : std::max (16, preview.loopBuffer.getNumSamples() / 8));

    pitchScrubPreviewStatus = {};
    pitchScrubPreviewStatus.active = pitchScrubPreview.active;
    pitchScrubPreviewStatus.previewArmed = pitchScrubPreview.active;
    pitchScrubPreviewStatus.trackId = pitchScrubPreview.trackId;
    pitchScrubPreviewStatus.clipId = pitchScrubPreview.clipId;
    pitchScrubPreviewStatus.pitchRatio = pitchScrubPreview.pitchRatio;
    pitchScrubPreviewStatus.basePitchHz = pitchScrubPreview.basePitchHz;
    pitchScrubPreviewStatus.currentGain = pitchScrubPreview.currentGain;
    pitchScrubPreviewStatus.targetGain = pitchScrubPreview.targetGain;
    pitchScrubPreviewStatus.repeatStability = pitchScrubPreview.repeatStability;
    pitchScrubPreviewStatus.loopDurationMs = 1000.0 * std::max (0.0, pitchScrubPreview.loopEndSec - pitchScrubPreview.loopStartSec);
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";

    const int preloadSamples = juce::jmax (512, preview.loopBuffer.getNumSamples());
    pitchScrubInputBuffer.setSize (juce::jmax (1, preview.loopBuffer.getNumChannels()), preloadSamples, false, true, true);
    pitchScrubOutputBuffer.setSize (juce::jmax (1, preview.loopBuffer.getNumChannels()), preloadSamples, false, true, true);

    logAudioPlayback ("setPitchScrubPreview clip=" + preview.clipId
        + " track=" + preview.trackId
        + " samples=" + juce::String (preview.loopBuffer.getNumSamples())
        + " channels=" + juce::String (preview.loopBuffer.getNumChannels())
        + " pitchRatio=" + juce::String (preview.pitchRatio, 3)
        + " basePitchHz=" + juce::String (preview.basePitchHz, 2)
        + " active=" + juce::String (pitchScrubPreview.active ? "true" : "false"));
}

bool PlaybackEngine::updatePitchScrubPreview (const juce::String& clipId, float pitchRatio)
{
    juce::ScopedLock sl (lock);
    if ((! pitchScrubPreview.active && ! pitchScrubPreview.releasePending) || pitchScrubPreview.clipId != clipId)
        return false;

    pitchScrubPreview.pitchRatio = juce::jlimit (0.25f, 4.0f, pitchRatio);
    pitchScrubPreviewStatus.pitchRatio = pitchScrubPreview.pitchRatio;
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";
    return true;
}

void PlaybackEngine::clearPitchScrubPreview (const juce::String& clipId)
{
    juce::ScopedLock sl (lock);
    if (pitchScrubPreview.clipId == clipId && (pitchScrubPreview.active || pitchScrubPreview.releasePending))
    {
        pitchScrubPreview.releasePending = true;
        pitchScrubPreview.targetGain = 0.0f;
        pitchScrubPreviewStatus.releasePending = true;
        logAudioPlayback ("clearPitchScrubPreview clip=" + clipId);
    }
}

bool PlaybackEngine::hasPitchScrubPreview (const juce::String& clipId) const
{
    const juce::ScopedLock sl (lock);
    return (pitchScrubPreview.active || pitchScrubPreview.releasePending) && pitchScrubPreview.clipId == clipId;
}

#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
void PlaybackEngine::renderPitchScrubPreview (juce::AudioBuffer<float>& buffer, double sampleRate)
{
    const juce::ScopedTryLock sl (lock);
    if (! sl.isLocked())
        return;

    if ((! pitchScrubPreview.active && ! pitchScrubPreview.releasePending)
        || pitchScrubPreview.loopBuffer.getNumSamples() <= 8
        || pitchScrubPreview.loopBuffer.getNumChannels() <= 0
        || sampleRate <= 0.0)
        return;

    const auto playbackRatio = (pitchScrubPreview.sourceSampleRate > 0.0)
        ? (pitchScrubPreview.sourceSampleRate / sampleRate)
        : 1.0;
    const double readIncrement = playbackRatio;
    const int loopChannels = pitchScrubPreview.loopBuffer.getNumChannels();
    const int outputChannels = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    if (pitchScrubInputBuffer.getNumChannels() < loopChannels
        || pitchScrubInputBuffer.getNumSamples() < numSamples)
    {
        pitchScrubInputBuffer.setSize (loopChannels, numSamples, false, true, true);
    }
    if (pitchScrubOutputBuffer.getNumChannels() < loopChannels
        || pitchScrubOutputBuffer.getNumSamples() < numSamples)
    {
        pitchScrubOutputBuffer.setSize (loopChannels, numSamples, false, true, true);
    }
    pitchScrubInputBuffer.clear (0, numSamples);
    pitchScrubOutputBuffer.clear (0, numSamples);

    const float startStep = pitchScrubPreview.targetGain
        / static_cast<float> (std::max (1, static_cast<int> (std::round (sampleRate * pitchScrubPreview.startRampMs * 0.001))));
    const float stopStep = std::max (pitchScrubPreview.gain, 0.001f)
        / static_cast<float> (std::max (1, static_cast<int> (std::round (sampleRate * pitchScrubPreview.stopRampMs * 0.001))));

    for (int i = 0; i < numSamples; ++i)
    {
        for (int ch = 0; ch < loopChannels; ++ch)
        {
            pitchScrubInputBuffer.setSample (ch, i, sampleLoopBufferLocal (pitchScrubPreview.loopBuffer,
                                                                           ch,
                                                                           pitchScrubPreview.readPosition,
                                                                           pitchScrubPreview.loopCrossfadeSamples));
        }

        pitchScrubPreview.readPosition += readIncrement;
        const double loopLength = static_cast<double> (pitchScrubPreview.loopBuffer.getNumSamples());
        if (loopLength > 0.0 && pitchScrubPreview.readPosition >= loopLength)
            pitchScrubPreview.readPosition = std::fmod (pitchScrubPreview.readPosition, loopLength);
    }

    if (! pitchScrubStretcherPrepared)
    {
        pitchScrubStretcher.presetCheaper (loopChannels, static_cast<float> (sampleRate));
        pitchScrubStretcherPrepared = true;
    }

    const float pitchRatio = juce::jlimit (0.25f, 4.0f, pitchScrubPreview.pitchRatio);
    const float tonalityLimitNorm = static_cast<float> (
        sampleRate > 0.0
            ? getPitchOnlyPreviewTonalityLimitHz (pitchRatio < 1.0f) / sampleRate
            : 0.0);
    pitchScrubStretcher.setTransposeFactor (pitchRatio, tonalityLimitNorm);
    pitchScrubStretcher.setFormantFactor (1.0f, true);

    if (static_cast<int> (pitchPreviewInPtrs.size()) < loopChannels)
    {
        pitchPreviewInPtrs.resize (static_cast<size_t> (loopChannels));
        pitchPreviewOutPtrs.resize (static_cast<size_t> (loopChannels));
    }
    for (int ch = 0; ch < loopChannels; ++ch)
    {
        pitchPreviewInPtrs[static_cast<size_t> (ch)] = pitchScrubInputBuffer.getReadPointer (ch);
        pitchPreviewOutPtrs[static_cast<size_t> (ch)] = pitchScrubOutputBuffer.getWritePointer (ch);
    }
    pitchScrubStretcher.process (pitchPreviewInPtrs, numSamples, pitchPreviewOutPtrs, numSamples);

    float peak = 0.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        if (pitchScrubPreview.releasePending)
            pitchScrubPreview.currentGain = std::max (0.0f, pitchScrubPreview.currentGain - stopStep);
        else
            pitchScrubPreview.currentGain = std::min (pitchScrubPreview.targetGain, pitchScrubPreview.currentGain + startStep);

        for (int ch = 0; ch < outputChannels; ++ch)
        {
            const int loopChannel = juce::jmin (ch, loopChannels - 1);
            const float sample = pitchScrubOutputBuffer.getSample (loopChannel, i) * pitchScrubPreview.currentGain;
            buffer.addSample (ch, i, sample);
            peak = juce::jmax (peak, std::abs (sample));
        }
    }

    pitchScrubPreview.lastPeak = peak;
    pitchScrubPreview.lastRenderWallTimeMs = juce::Time::getMillisecondCounterHiRes();
    pitchScrubPreview.mixedCallbackCount += 1;
    pitchScrubPreview.mixedSampleCount += numSamples;
    pitchScrubPreview.firstCallbackServiced = true;

    pitchScrubPreviewStatus.active = pitchScrubPreview.active;
    pitchScrubPreviewStatus.releasePending = pitchScrubPreview.releasePending;
    pitchScrubPreviewStatus.audible = pitchScrubPreview.currentGain > 0.0001f && peak > 1.0e-4f;
    pitchScrubPreview.firstDragAudible = pitchScrubPreview.firstDragAudible || pitchScrubPreviewStatus.audible;
    pitchScrubPreviewStatus.previewArmed = pitchScrubPreview.active || pitchScrubPreview.releasePending;
    pitchScrubPreviewStatus.firstCallbackServiced = pitchScrubPreview.firstCallbackServiced;
    pitchScrubPreviewStatus.firstDragAudible = pitchScrubPreview.firstDragAudible;
    pitchScrubPreviewStatus.trackId = pitchScrubPreview.trackId;
    pitchScrubPreviewStatus.clipId = pitchScrubPreview.clipId;
    pitchScrubPreviewStatus.pitchRatio = pitchScrubPreview.pitchRatio;
    pitchScrubPreviewStatus.basePitchHz = pitchScrubPreview.basePitchHz;
    pitchScrubPreviewStatus.currentGain = pitchScrubPreview.currentGain;
    pitchScrubPreviewStatus.targetGain = pitchScrubPreview.targetGain;
    pitchScrubPreviewStatus.repeatStability = pitchScrubPreview.repeatStability;
    pitchScrubPreviewStatus.lastPeak = peak;
    pitchScrubPreviewStatus.loopDurationMs = 1000.0 * std::max (0.0, pitchScrubPreview.loopEndSec - pitchScrubPreview.loopStartSec);
    pitchScrubPreviewStatus.lastRenderWallTimeMs = pitchScrubPreview.lastRenderWallTimeMs;
    pitchScrubPreviewStatus.mixedCallbackCount = pitchScrubPreview.mixedCallbackCount;
    pitchScrubPreviewStatus.mixedSampleCount = pitchScrubPreview.mixedSampleCount;
    pitchScrubPreviewStatus.renderMethod = "formant_preserving_stretch";

    if (pitchScrubPreview.releasePending && pitchScrubPreview.currentGain <= 1.0e-5f)
    {
        pitchScrubPreview.active = false;
        pitchScrubPreview.releasePending = false;
        pitchScrubPreview.currentGain = 0.0f;
        pitchScrubPreview.targetGain = 0.0f;
        pitchScrubPreviewStatus.active = false;
        pitchScrubPreviewStatus.releasePending = false;
        pitchScrubPreviewStatus.previewArmed = false;
        pitchScrubStretcherPrepared = false;
    }
}
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif

PlaybackEngine::PitchScrubPreviewStatus PlaybackEngine::getPitchScrubPreviewStatus (const juce::String& clipId) const
{
    const juce::ScopedLock sl (lock);
    if (clipId.isNotEmpty() && pitchScrubPreviewStatus.clipId != clipId)
        return {};
    return pitchScrubPreviewStatus;
}

PlaybackEngine::PitchPreviewRoutingStatus PlaybackEngine::getPitchPreviewRoutingStatus (const juce::String& clipId) const
{
    const juce::ScopedLock sl (lock);
    PitchPreviewRoutingStatus status;
    const bool queryAll = clipId.isEmpty();
    status.scrubPreviewActive = (pitchScrubPreview.active || pitchScrubPreview.releasePending)
        && (queryAll || pitchScrubPreview.clipId == clipId);
    status.clipLivePreviewActive = queryAll
        ? ! clipPitchPreviews.empty()
        : clipPitchPreviews.find (clipId) != clipPitchPreviews.end();
    status.renderedSegmentActive = queryAll
        ? ! renderedPreviewSegments.empty()
        : renderedPreviewSegments.find (clipId) != renderedPreviewSegments.end();
    status.correctedSourceActive = queryAll
        ? ! pitchCorrectedFiles.empty()
        : pitchCorrectedFiles.find (clipId) != pitchCorrectedFiles.end();

    if (status.renderedSegmentActive)
        status.monitorMode = "rendered_segment";
    else if (status.scrubPreviewActive)
        status.monitorMode = "scrub";
    else if (status.clipLivePreviewActive)
        status.monitorMode = "clip_live_preview";
    else if (status.correctedSourceActive)
        status.monitorMode = "corrected_source";
    else
        status.monitorMode = "none";

    return status;
}

float PlaybackEngine::lookupPitchRatio (const std::vector<PitchCorrectionSegment>& segments, double timeInClip)
{
    // Binary search could be used for large segment lists, but linear is fine for typical note counts
    for (const auto& seg : segments)
    {
        if (timeInClip >= seg.startTime && timeInClip < seg.endTime)
            return seg.pitchRatio;
    }
    return 1.0f; // No correction at this time position
}

#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456 4702)
#endif
void PlaybackEngine::fillTrackBuffer(const juce::String& trackId,
                                     juce::AudioBuffer<float>& buffer,
                                     double currentTime,
                                     int numSamples,
                                     double sampleRate)
{
    // Use TryLock to avoid blocking the audio thread (REAPER-style).
    // If the lock is held (message thread adding/removing clips), we return silence.
    // This is extremely rare and inaudible — same pattern as AudioRecorder::writeBlock.
    const juce::ScopedTryLock sl(lock);
    if (!sl.isLocked())
    {
        const int tryLockMiss = tryLockFailureCount.fetch_add(1, std::memory_order_relaxed) + 1;
        if ((tryLockMiss % 20) == 1)
            logAudioPlayback("fillTrackBuffer lock miss track=" + trackId
                + " currentTime=" + juce::String(currentTime, 3)
                + " count=" + juce::String(tryLockMiss));
        buffer.clear();
        return;
    }

    buffer.clear();
    int overlappingClipCount = 0;
    int mixedClipCount = 0;
    static std::atomic<int> fillTrackBufferCallCounter { 0 };
    const int fillCall = fillTrackBufferCallCounter.fetch_add(1, std::memory_order_relaxed) + 1;
    const bool shouldLogDetailed = (fillCall % 50) == 1;

    double windowEnd = currentTime + (numSamples / sampleRate);

    // Find and mix all clips that should be playing at current time
    for (const auto& clip : clips)
    {
        if (clip.trackId != trackId || !clip.isActive)
            continue;

        double clipEndTime = clip.startTime + clip.duration;

        // Check if clip overlaps with current time window
        if (currentTime >= clipEndTime || windowEnd <= clip.startTime)
            continue;  // Clip not active in this window
        ++overlappingClipCount;

        {
        const int clipOutputStart = juce::jlimit (0, numSamples,
            static_cast<int> (std::ceil ((clip.startTime - currentTime) * sampleRate - 1.0e-9)));
        const int clipOutputEnd = juce::jlimit (clipOutputStart, numSamples,
            static_cast<int> (std::ceil ((clipEndTime - currentTime) * sampleRate - 1.0e-9)));
        if (clipOutputEnd <= clipOutputStart)
            continue;

        const std::vector<RenderedPreviewSegment>* renderedSegmentsForClip = nullptr;
        if (clip.clipId.isNotEmpty())
        {
            auto segmentIt = renderedPreviewSegments.find (clip.clipId);
            if (segmentIt != renderedPreviewSegments.end() && ! segmentIt->second.empty())
                renderedSegmentsForClip = &segmentIt->second;
        }

        auto& chunkBoundaries = reusableChunkBoundaries;
        chunkBoundaries.clear();
        const auto requiredBoundaryCapacity = renderedSegmentsForClip != nullptr ? renderedSegmentsForClip->size() * 2 + 2 : 2;
        if (chunkBoundaries.capacity() < requiredBoundaryCapacity)
        {
            chunkBoundaries.reserve (requiredBoundaryCapacity);
            chunkBoundaryReserveCount.fetch_add (1, std::memory_order_relaxed);
        }
        chunkBoundaries.push_back (clipOutputStart);
        chunkBoundaries.push_back (clipOutputEnd);
        if (renderedSegmentsForClip != nullptr)
        {
            for (const auto& segment : *renderedSegmentsForClip)
            {
                const int segmentStart = juce::jlimit (clipOutputStart, clipOutputEnd,
                    static_cast<int> (std::ceil ((clip.startTime + segment.startSec - currentTime) * sampleRate - 1.0e-9)));
                const int segmentEnd = juce::jlimit (clipOutputStart, clipOutputEnd,
                    static_cast<int> (std::ceil ((clip.startTime + segment.endSec - currentTime) * sampleRate - 1.0e-9)));
                if (segmentStart > clipOutputStart && segmentStart < clipOutputEnd)
                    chunkBoundaries.push_back (segmentStart);
                if (segmentEnd > clipOutputStart && segmentEnd < clipOutputEnd)
                    chunkBoundaries.push_back (segmentEnd);
            }
        }
        std::sort (chunkBoundaries.begin(), chunkBoundaries.end());
        chunkBoundaries.erase (std::unique (chunkBoundaries.begin(), chunkBoundaries.end()), chunkBoundaries.end());

        const float clipGain = juce::Decibels::decibelsToGain (static_cast<float> (clip.volumeDB));
        const std::vector<GainEnvelopePoint>* envPoints = nullptr;
        if (clip.clipId.isNotEmpty())
        {
            auto envIt = gainEnvelopes.find (clip.envelopeKey);
            if (envIt != gainEnvelopes.end() && ! envIt->second.empty())
                envPoints = &envIt->second;
        }

        auto mixChunk = [&] (int outputStart, int requestedOutputSamples,
                            const juce::File& playbackFile, double playbackOffset,
                            bool usingRenderedPreviewSegment, bool usingCorrectedSource)
        {
            if (requestedOutputSamples <= 0)
                return false;

            auto* reader = getCachedReader (playbackFile);
            if (reader == nullptr)
            {
                const int missingReaders = missingReaderCount.fetch_add (1, std::memory_order_relaxed) + 1;
                logAudioPlayback ("fillTrackBuffer missingReader track=" + trackId
                    + " clipId=" + clip.clipId
                    + " file=" + playbackFile.getFullPathName()
                    + " currentTime=" + juce::String (currentTime, 3)
                    + " missingReaderCount=" + juce::String (missingReaders));
                return false;
            }

            const double fileSampleRate = reader->sampleRate;
            const double ratio = fileSampleRate / sampleRate;
            double exactFileStart = juce::jmax (0.0, playbackOffset) * fileSampleRate;
            const double roundedFileStart = std::round (exactFileStart);
            if (std::abs (exactFileStart - roundedFileStart) < 1.0e-6)
                exactFileStart = roundedFileStart;

            const juce::int64 fileStartSample = static_cast<juce::int64> (std::floor (exactFileStart));
            const double fileStartFraction = exactFileStart - static_cast<double> (fileStartSample);
            int outputSamples = requestedOutputSamples;
            int fileSamplesToRead = static_cast<int> (std::ceil (fileStartFraction + outputSamples * ratio)) + 2;
            const juce::int64 fileSamplesAvailable = reader->lengthInSamples - fileStartSample;
            if (fileSamplesAvailable <= 0)
                return false;
            if (fileSamplesAvailable < fileSamplesToRead)
            {
                fileSamplesToRead = static_cast<int> (fileSamplesAvailable);
                outputSamples = static_cast<int> ((fileSamplesToRead - 1) / ratio);
            }
            if (outputSamples <= 0 || fileSamplesToRead <= 0)
                return false;

            const int readerChannels = static_cast<int> (reader->numChannels);
            if (reusableFileBuffer.getNumChannels() < readerChannels
                || reusableFileBuffer.getNumSamples() < fileSamplesToRead)
            {
                reusableFileBuffer.setSize (juce::jmax (readerChannels, reusableFileBuffer.getNumChannels()),
                                            juce::jmax (fileSamplesToRead, reusableFileBuffer.getNumSamples()));
                fileBufferResizeCount.fetch_add (1, std::memory_order_relaxed);
            }
            reusableFileBuffer.clear (0, fileSamplesToRead);
            reader->read (&reusableFileBuffer, 0, fileSamplesToRead, fileStartSample, true, true);

            const bool allowLivePitchPreviewForChunk = ! usingRenderedPreviewSegment && ! usingCorrectedSource;
            const double chunkClipStart = currentTime + (static_cast<double> (outputStart) / sampleRate) - clip.startTime;

            if (clip.clipId.isNotEmpty())
            {
                auto previewIt = clipPitchPreviews.find (clip.clipId);
                if (previewIt != clipPitchPreviews.end() && previewIt->second != nullptr)
                {
                    juce::ScopedLock clipSl (previewIt->second->clipLock);
                    auto& preview = *previewIt->second;
                    const auto& previewData = preview.previewData;
                    const double blockMidTime = chunkClipStart + (outputSamples * 0.5 / sampleRate);
                    const bool withinPreviewWindow = blockMidTime >= previewData.previewStartSec
                        && blockMidTime <= previewData.previewEndSec;
                    const float pitchRatio = lookupPitchRatio (previewData.pitchSegments, blockMidTime);
                    const bool pitchPreviewActive = allowLivePitchPreviewForChunk
                        && withinPreviewWindow
                        && std::abs (pitchRatio - 1.0f) > 0.001f;

                    if (! pitchPreviewActive)
                    {
                        preview.lastPlaybackTime = -1.0;
                    }
                    else
                    {
                        if (! preview.prepared)
                        {
                            preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                            preview.prepared = true;
                        }
                        if (preview.lastPlaybackTime < 0.0
                            || std::abs (chunkClipStart - preview.lastPlaybackTime) > 0.1)
                        {
                            preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                        }
                        preview.lastPlaybackTime = chunkClipStart + (outputSamples / sampleRate);

                        const float tonalityLimitNorm = static_cast<float> (
                            fileSampleRate > 0.0
                                ? getPitchOnlyPreviewTonalityLimitHz (pitchRatio < 1.0f) / fileSampleRate
                                : 0.0);
                        preview.stretcher.setTransposeFactor (pitchRatio, tonalityLimitNorm);
                        preview.stretcher.setFormantFactor (1.0f, true);

                        if (pitchShiftWorkBuffer.getNumSamples() < fileSamplesToRead)
                        {
                            pitchShiftWorkBuffer.setSize (readerChannels, fileSamplesToRead);
                            pitchShiftWorkBufferResizeCount.fetch_add (1, std::memory_order_relaxed);
                        }
                        for (int ch = 0; ch < readerChannels; ++ch)
                        {
                            pitchPreviewInPtrs[static_cast<size_t> (ch)] = reusableFileBuffer.getReadPointer (ch);
                            pitchPreviewOutPtrs[static_cast<size_t> (ch)] = pitchShiftWorkBuffer.getWritePointer (ch);
                        }
                        preview.stretcher.process (pitchPreviewInPtrs, fileSamplesToRead, pitchPreviewOutPtrs, fileSamplesToRead);
                        for (int ch = 0; ch < readerChannels; ++ch)
                            reusableFileBuffer.copyFrom (ch, 0, pitchShiftWorkBuffer, ch, 0, fileSamplesToRead);
                    }
                }
            }

            const int outChannels = buffer.getNumChannels();
            const int channelsToProcess = std::min (outChannels, readerChannels);
            if (renderMode && ratio != 1.0)
            {
                if (renderResampleScratch.getNumChannels() < channelsToProcess
                    || renderResampleScratch.getNumSamples() < outputSamples)
                {
                    renderResampleScratch.setSize (juce::jmax (channelsToProcess, renderResampleScratch.getNumChannels()),
                                                   juce::jmax (outputSamples, renderResampleScratch.getNumSamples()));
                    renderResampleScratchResizeCount.fetch_add (1, std::memory_order_relaxed);
                }
                for (int ch = 0; ch < channelsToProcess; ++ch)
                {
                    auto& interpolator = (ch == 0) ? lagrangeInterpolatorL : lagrangeInterpolatorR;
                    interpolator.reset();
                    auto* resampledData = renderResampleScratch.getWritePointer (ch);
                    interpolator.process (ratio, reusableFileBuffer.getReadPointer (ch),
                                          resampledData, outputSamples);
                    for (int i = 0; i < outputSamples; ++i)
                    {
                        const double sampleTimeInClip = chunkClipStart + (i / sampleRate);
                        float fadeGain = 1.0f;
                        if (clip.fadeIn > 0.0 && sampleTimeInClip < clip.fadeIn)
                            fadeGain *= applyFadeCurve (static_cast<float> (sampleTimeInClip / clip.fadeIn), clip.fadeInCurve);
                        const double timeFromEnd = clip.duration - sampleTimeInClip;
                        if (clip.fadeOut > 0.0 && timeFromEnd < clip.fadeOut)
                            fadeGain *= applyFadeCurve (static_cast<float> (timeFromEnd / clip.fadeOut), clip.fadeOutCurve);
                        const float envGain = envPoints ? interpolateGainEnvelope (*envPoints, sampleTimeInClip) : 1.0f;
                        buffer.addSample (ch, outputStart + i,
                                          resampledData[i] * clipGain * fadeGain * envGain);
                    }
                }
            }
            else
            {
                for (int i = 0; i < outputSamples; ++i)
                {
                    const double filePos = fileStartFraction + i * ratio;
                    const int idx = static_cast<int> (filePos);
                    const float frac = static_cast<float> (filePos - idx);
                    const double sampleTimeInClip = chunkClipStart + (i / sampleRate);
                    float fadeGain = 1.0f;
                    if (clip.fadeIn > 0.0 && sampleTimeInClip < clip.fadeIn)
                        fadeGain *= applyFadeCurve (static_cast<float> (sampleTimeInClip / clip.fadeIn), clip.fadeInCurve);
                    const double timeFromEnd = clip.duration - sampleTimeInClip;
                    if (clip.fadeOut > 0.0 && timeFromEnd < clip.fadeOut)
                        fadeGain *= applyFadeCurve (static_cast<float> (timeFromEnd / clip.fadeOut), clip.fadeOutCurve);
                    const float envGain = envPoints ? interpolateGainEnvelope (*envPoints, sampleTimeInClip) : 1.0f;
                    const float totalGain = clipGain * fadeGain * envGain;

                    for (int ch = 0; ch < channelsToProcess; ++ch)
                    {
                        const float s0 = reusableFileBuffer.getSample (ch, idx);
                        const float s1 = (idx + 1 < fileSamplesToRead) ? reusableFileBuffer.getSample (ch, idx + 1) : s0;
                        buffer.addSample (ch, outputStart + i, (s0 + frac * (s1 - s0)) * totalGain);
                    }
                }
            }

            if (shouldLogDetailed)
            {
                logAudioPlayback ("fillTrackBuffer chunk track=" + trackId
                    + " clipId=" + clip.clipId
                    + " out=[" + juce::String (outputStart) + "," + juce::String (outputStart + outputSamples) + "]"
                    + " clipStart=" + juce::String (chunkClipStart, 4)
                    + " sourceType=" + juce::String (usingRenderedPreviewSegment ? "rendered_segment"
                        : (usingCorrectedSource ? "corrected_source" : "original"))
                    + " fileOffset=" + juce::String (playbackOffset, 4));
            }
            return true;
        };

        bool mixedAnyChunk = false;
        for (size_t boundaryIndex = 0; boundaryIndex + 1 < chunkBoundaries.size(); ++boundaryIndex)
        {
            const int chunkStart = chunkBoundaries[boundaryIndex];
            const int chunkEnd = chunkBoundaries[boundaryIndex + 1];
            if (chunkEnd <= chunkStart)
                continue;

            const double chunkClipMid = currentTime
                + ((static_cast<double> (chunkStart + chunkEnd) * 0.5) / sampleRate)
                - clip.startTime;
            const RenderedPreviewSegment* activeSegment = nullptr;
            if (renderedSegmentsForClip != nullptr)
            {
                for (const auto& segment : *renderedSegmentsForClip)
                {
                    if (chunkClipMid >= segment.startSec && chunkClipMid < segment.endSec)
                    {
                        activeSegment = &segment;
                        break;
                    }
                }
            }

            const double chunkClipStart = currentTime + (static_cast<double> (chunkStart) / sampleRate) - clip.startTime;
            juce::File playbackFile = clip.audioFile;
            double playbackOffset = clip.offset + chunkClipStart;
            bool usingRenderedPreviewSegment = false;
            bool usingCorrectedSource = false;

            if (activeSegment != nullptr)
            {
                playbackFile = activeSegment->audioFile;
                playbackOffset = activeSegment->fileOffsetSec + (chunkClipStart - activeSegment->startSec);
                usingRenderedPreviewSegment = true;
            }
            else if (clip.clipId.isNotEmpty())
            {
                auto correctedIt = pitchCorrectedFiles.find (clip.clipId);
                usingCorrectedSource = correctedIt != pitchCorrectedFiles.end()
                    && correctedIt->second.existsAsFile()
                    && playbackFile == correctedIt->second;
            }

            mixedAnyChunk = mixChunk (chunkStart, chunkEnd - chunkStart, playbackFile, playbackOffset,
                                      usingRenderedPreviewSegment, usingCorrectedSource)
                || mixedAnyChunk;
        }
        if (mixedAnyChunk)
            ++mixedClipCount;
        }
        continue;

        // Calculate read position within clip
        double offsetInClip = currentTime - clip.startTime;
        if (offsetInClip < 0)
        {
            // Clip starts partway through this buffer
            offsetInClip = 0;
        }

        // Get cached reader — never does disk I/O (readers pre-loaded in addClip)
        juce::File playbackFile = clip.audioFile;
        double playbackOffset = clip.offset + offsetInClip;
        bool usingRenderedPreviewSegment = false;
        if (clip.clipId.isNotEmpty())
        {
            auto segmentIt = renderedPreviewSegments.find(clip.clipId);
            if (segmentIt != renderedPreviewSegments.end())
            {
                const double blockDurationSec = numSamples / sampleRate;
                for (const auto& segment : segmentIt->second)
                {
                    if (offsetInClip >= segment.startSec - 0.0005
                        && offsetInClip < segment.endSec + 0.0005
                        && (offsetInClip + blockDurationSec) > segment.startSec)
                    {
                        playbackFile = segment.audioFile;
                        usingRenderedPreviewSegment = true;
                        // Segment override files can either be local-zero window renders
                        // or full-clip renders carrying only a covered region. fileOffsetSec
                        // maps the clip-relative playhead back into the override file.
                        playbackOffset = juce::jmax(0.0, offsetInClip - segment.startSec + segment.fileOffsetSec);
                        break;
                    }
                }
            }
        }
        bool usingCorrectedSource = false;
        if (!usingRenderedPreviewSegment && clip.clipId.isNotEmpty())
        {
            auto correctedIt = pitchCorrectedFiles.find(clip.clipId);
            if (correctedIt != pitchCorrectedFiles.end()
                && correctedIt->second.existsAsFile()
                && playbackFile == correctedIt->second)
            {
                usingCorrectedSource = true;
            }
        }
        const bool allowLivePitchPreviewForBlock = !usingRenderedPreviewSegment && !usingCorrectedSource;
        if (shouldLogDetailed)
        {
            logAudioPlayback("fillTrackBuffer overlap track=" + trackId
                + " clipId=" + clip.clipId
                + " window=[" + juce::String(currentTime, 3) + "," + juce::String(windowEnd, 3) + "]"
                + " playbackFile=" + playbackFile.getFullPathName()
                + " playbackOffset=" + juce::String(playbackOffset, 3)
                + " sourceType=" + juce::String(usingRenderedPreviewSegment ? "preview_segment"
                    : (usingCorrectedSource ? "corrected" : "original"))
                + " livePitchAllowed=" + juce::String(allowLivePitchPreviewForBlock ? "yes" : "no"));
        }

        auto* reader = getCachedReader(playbackFile);
        if (reader == nullptr)
        {
            const int missingReaders = missingReaderCount.fetch_add(1, std::memory_order_relaxed) + 1;
            logAudioPlayback("fillTrackBuffer missingReader track=" + trackId
                + " clipId=" + clip.clipId
                + " file=" + playbackFile.getFullPathName()
                + " currentTime=" + juce::String(currentTime, 3)
                + " missingReaderCount=" + juce::String(missingReaders));
            continue;
        }

        // Sample rate conversion ratio (file rate vs device rate)
        double fileSampleRate = reader->sampleRate;
        double ratio = fileSampleRate / sampleRate;  // e.g. 48000/44100 = 1.0884

        // Calculate file sample position using the FILE's sample rate
        juce::int64 fileStartSample = (juce::int64)(playbackOffset * fileSampleRate);

        // How many output samples we can produce for this clip
        int outputSamples = numSamples;

        // How many file samples we need to read (+2 for linear interpolation safety)
        int fileSamplesToRead = (int)(outputSamples * ratio) + 2;

        // Adjust if we're near the end of the file
        juce::int64 fileSamplesAvailable = reader->lengthInSamples - fileStartSample;
        if (fileSamplesAvailable <= 0)
            continue;
        if (fileSamplesAvailable < fileSamplesToRead)
        {
            fileSamplesToRead = (int)fileSamplesAvailable;
            // Reduce output samples accordingly
            outputSamples = (int)((fileSamplesToRead - 1) / ratio);
        }

        if (outputSamples <= 0 || fileSamplesToRead <= 0)
            continue;
        ++mixedClipCount;
        if (shouldLogDetailed)
        {
            logAudioPlayback("fillTrackBuffer readReady track=" + trackId
                + " clipId=" + clip.clipId
                + " fileStartSample=" + juce::String(fileStartSample)
                + " outputSamples=" + juce::String(outputSamples)
                + " fileSamplesToRead=" + juce::String(fileSamplesToRead));
        }

        // Use pre-allocated buffer (resize only if needed — rare fallback)
        int readerChannels = static_cast<int>(reader->numChannels);
        if (reusableFileBuffer.getNumChannels() < readerChannels ||
            reusableFileBuffer.getNumSamples() < fileSamplesToRead)
        {
            reusableFileBuffer.setSize(juce::jmax(readerChannels, reusableFileBuffer.getNumChannels()),
                                       juce::jmax(fileSamplesToRead, reusableFileBuffer.getNumSamples()));
        }
        reusableFileBuffer.clear(0, fileSamplesToRead);

        reader->read(&reusableFileBuffer, 0, fileSamplesToRead, fileStartSample, true, true);

        // ---- Real-time pitch preview: apply PitchShifter if active ----
        if (clip.clipId.isNotEmpty())
        {
            auto previewIt = clipPitchPreviews.find (clip.clipId);
            if (previewIt != clipPitchPreviews.end() && previewIt->second != nullptr)
            {
                juce::ScopedLock clipSl (previewIt->second->clipLock);
                auto& preview = *previewIt->second;
                const auto& previewData = preview.previewData;
                const double clipTime = offsetInClip;
                const double blockMidTime = offsetInClip + (fileSamplesToRead * 0.5 / fileSampleRate);
                const bool withinPreviewWindow = blockMidTime >= previewData.previewStartSec
                    && blockMidTime <= previewData.previewEndSec;
                const float pitchRatio = lookupPitchRatio (previewData.pitchSegments, blockMidTime);
                const bool pitchPreviewActive = allowLivePitchPreviewForBlock
                    && withinPreviewWindow
                    && std::abs (pitchRatio - 1.0f) > 0.001f;

                if (! pitchPreviewActive)
                {
                    preview.lastPlaybackTime = -1.0;
                }
                else
                {
                    // Prepare stretcher on first use (or after reset)
                    if (! preview.prepared)
                    {
                        preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                        preview.prepared = true;
                    }

                    // Re-entering the preview window after a gap (lastPlaybackTime == -1):
                    // Reset the stretcher so its internal phases align with the current
                    // audio position. Without this, stale phases from a prior streaming
                    // position cause phase artifacts that sound "faster" or mis-timed at
                    // note boundaries. The ~30ms of latency fill that follows the reset is
                    // brief and far less jarring than the phase-misalignment artifact.
                    if (preview.lastPlaybackTime < 0.0)
                    {
                        preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                    }
                    // Detect seeking: if playback time jumped, reinitialize
                    else if (std::abs (clipTime - preview.lastPlaybackTime) > 0.1)
                    {
                        preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                    }
                    preview.lastPlaybackTime = clipTime + (fileSamplesToRead / fileSampleRate);

                    const float tonalityLimitNorm = static_cast<float> (
                        fileSampleRate > 0.0
                            ? getPitchOnlyPreviewTonalityLimitHz (pitchRatio < 1.0f) / fileSampleRate
                            : 0.0);
                    preview.stretcher.setTransposeFactor (pitchRatio, tonalityLimitNorm);
                    // Keep the legacy live fallback in the same timbre family as the
                    // note-local renderer: preserve formants directly instead of using
                    // pitch-ratio compensation, which brightens upward edits and darkens
                    // downward edits by construction.
                    preview.stretcher.setFormantFactor (1.0f, true);

                    // Ensure pitch shift work buffer is large enough
                    if (pitchShiftWorkBuffer.getNumSamples() < fileSamplesToRead)
                        pitchShiftWorkBuffer.setSize (readerChannels, fileSamplesToRead);

                    // Use pre-allocated pointer vectors — avoids heap alloc per clip per callback.
                    // readerChannels is always 1 or 2; pitchPreviewInPtrs/OutPtrs are sized to 2.
                    for (int ch = 0; ch < readerChannels; ++ch)
                    {
                        pitchPreviewInPtrs[static_cast<size_t> (ch)]  = reusableFileBuffer.getReadPointer (ch);
                        pitchPreviewOutPtrs[static_cast<size_t> (ch)] = pitchShiftWorkBuffer.getWritePointer (ch);
                    }

                    preview.stretcher.process (pitchPreviewInPtrs, fileSamplesToRead, pitchPreviewOutPtrs, fileSamplesToRead);

                    for (int ch = 0; ch < readerChannels; ++ch)
                        reusableFileBuffer.copyFrom (ch, 0, pitchShiftWorkBuffer, ch, 0, fileSamplesToRead);
                }
            }
        }

        // Apply per-clip gain (convert dB to linear)
        float clipGain = juce::Decibels::decibelsToGain(static_cast<float>(clip.volumeDB));
        int fileChannels = readerChannels;
        int outChannels = buffer.getNumChannels();

        // Look up gain envelope for this clip
        const std::vector<GainEnvelopePoint>* envPoints = nullptr;
        if (clip.clipId.isNotEmpty())
        {
            auto envIt = gainEnvelopes.find(clip.envelopeKey);
            if (envIt != gainEnvelopes.end() && !envIt->second.empty())
                envPoints = &envIt->second;
        }

        // Render mode with sample rate conversion: use Lagrange interpolation
        if (renderMode && ratio != 1.0)
        {
            // Use a temporary buffer for Lagrange-resampled output per channel
            // Process each channel independently
            int channelsToProcess = std::min(outChannels, fileChannels);
            for (int ch = 0; ch < channelsToProcess; ++ch)
            {
                auto& interpolator = (ch == 0) ? lagrangeInterpolatorL : lagrangeInterpolatorR;
                const float* inputData = reusableFileBuffer.getReadPointer(ch);

                // Create a temporary output buffer for this channel
                // We write directly into the output by accumulating sample by sample
                // Use a small stack buffer for the resampled data
                std::vector<float> resampledData(static_cast<size_t>(outputSamples));
                interpolator.process(ratio, inputData, resampledData.data(), outputSamples);

                // Apply fades, gain envelope, and clip gain, then mix into output buffer
                for (int i = 0; i < outputSamples; ++i)
                {
                    float fadeGain = 1.0f;
                    double sampleTimeInClip = offsetInClip + (i / sampleRate);

                    if (clip.fadeIn > 0.0 && sampleTimeInClip < clip.fadeIn)
                    {
                        float t = static_cast<float>(sampleTimeInClip / clip.fadeIn);
                        fadeGain *= applyFadeCurve(t, clip.fadeInCurve);
                    }

                    double timeFromEnd = clip.duration - sampleTimeInClip;
                    if (clip.fadeOut > 0.0 && timeFromEnd < clip.fadeOut)
                    {
                        float t = static_cast<float>(timeFromEnd / clip.fadeOut);
                        fadeGain *= applyFadeCurve(t, clip.fadeOutCurve);
                    }

                    float envGain = envPoints ? interpolateGainEnvelope(*envPoints, sampleTimeInClip) : 1.0f;

                    buffer.addSample(ch, i, resampledData[static_cast<size_t>(i)] * clipGain * fadeGain * envGain);
                }
            }
        }
        else
        {
        // Real-time path: Resample (linear interpolation) + apply gain/fades in one pass
        for (int i = 0; i < outputSamples; ++i)
        {
            // Fractional position in the file buffer for this output sample
            double filePos = i * ratio;
            int idx = (int)filePos;
            float frac = (float)(filePos - idx);

            // Fade calculation (with curve support)
            float fadeGain = 1.0f;
            double sampleTimeInClip = offsetInClip + (i / sampleRate);

            if (clip.fadeIn > 0.0 && sampleTimeInClip < clip.fadeIn)
            {
                float t = static_cast<float>(sampleTimeInClip / clip.fadeIn);
                fadeGain *= applyFadeCurve(t, clip.fadeInCurve);
            }

            double timeFromEnd = clip.duration - sampleTimeInClip;
            if (clip.fadeOut > 0.0 && timeFromEnd < clip.fadeOut)
            {
                float t = static_cast<float>(timeFromEnd / clip.fadeOut);
                fadeGain *= applyFadeCurve(t, clip.fadeOutCurve);
            }

            float envGain = envPoints ? interpolateGainEnvelope(*envPoints, sampleTimeInClip) : 1.0f;
            float totalGain = clipGain * fadeGain * envGain;

            // Linear interpolation + gain for each channel
            for (int ch = 0; ch < std::min(outChannels, fileChannels); ++ch)
            {
                float s0 = reusableFileBuffer.getSample(ch, idx);
                float s1 = (idx + 1 < fileSamplesToRead) ? reusableFileBuffer.getSample(ch, idx + 1) : s0;
                float sample = s0 + frac * (s1 - s0);  // lerp
                buffer.addSample(ch, i, sample * totalGain);
            }
        }
        } // end real-time path
    }

    const float playbackPeak = peakForBuffer(buffer, numSamples);
    lastOverlappingClipCount.store(overlappingClipCount, std::memory_order_relaxed);
    lastMixedClipCount.store(mixedClipCount, std::memory_order_relaxed);
    lastTrackPlaybackPeak.store(playbackPeak, std::memory_order_relaxed);
    if (shouldLogDetailed || (overlappingClipCount > 0 && mixedClipCount == 0))
    {
        logAudioPlayback("fillTrackBuffer summary track=" + trackId
            + " overlapping=" + juce::String(overlappingClipCount)
            + " mixed=" + juce::String(mixedClipCount)
            + " peak=" + juce::String(playbackPeak, 4)
            + (overlappingClipCount == 0 ? " noOverlappingClips" : "")
            + (overlappingClipCount > 0 && mixedClipCount == 0 ? " WARNING_noMixedClips" : ""));
    }
}
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif
