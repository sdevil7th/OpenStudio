#include "PlaybackEngine.h"
#include <cmath>

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
                              double offset, double volumeDB, double fadeIn, double fadeOut, const juce::String& clipId)
{
    juce::ScopedLock sl(lock);

    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine: Cannot add clip - file does not exist: " + audioFile.getFullPathName());
        return;
    }

    // Check if this clip has a pitch-corrected file from a previous session.
    // syncClipsWithBackend always re-adds clips with the original filePath from
    // the frontend store, but the corrected file should be used for playback.
    juce::File effectiveFile = audioFile;
    double effectiveOffset = offset;
    auto correctedIt = pitchCorrectedFiles.find(clipId);
    if (correctedIt != pitchCorrectedFiles.end() && correctedIt->second.existsAsFile())
    {
        effectiveFile = correctedIt->second;
        effectiveOffset = 0.0; // Corrected files always start at sample 0
        juce::Logger::writeToLog("PlaybackEngine: Using corrected file for clip " + clipId
                                  + " -> " + effectiveFile.getFullPathName());
    }

    // Pre-load the reader on the message thread so audio thread never does disk I/O
    preloadReader(effectiveFile);

    ClipInfo clip(effectiveFile, startTime, duration, trackId, effectiveOffset, volumeDB, fadeIn, fadeOut);
    clip.clipId = clipId;
    clip.originalAudioFile = audioFile;  // Snapshot of original — never overwritten by replaceClipAudioFile
    clip.originalOffset = offset;        // Snapshot of original offset — never changed by replaceClipAudioFile
    clips.push_back(clip);

    juce::Logger::writeToLog("PlaybackEngine: Added clip - Track " + trackId +
                           ", Start: " + juce::String(startTime) +
                           "s, Duration: " + juce::String(duration) +
                           "s, Offset: " + juce::String(offset) +
                           "s, Volume: " + juce::String(volumeDB) + "dB");
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
            // Swap in the new file. The output file always starts at position 0
            // (applyPitchCorrection writes from the clip's original offset onwards),
            // so reset offset to 0 — otherwise the playback engine would seek past
            // end of the new (shorter) file and produce silence or garbage.
            clip.audioFile = newFile;
            clip.offset = 0.0;
            // Pre-load new reader while we still hold the lock (same pattern as addClip)
            preloadReader(newFile);
            // Clear any active pitch preview — the corrected audio is now baked
            // into the file, so the real-time PitchShifter must not double-shift.
            clipPitchPreviews.erase(clipId);
            // Remember the corrected file so it survives clearAllClips + re-add cycles
            // (syncClipsWithBackend re-adds clips with original filePath from frontend store).
            pitchCorrectedFiles[clipId] = newFile;
            juce::Logger::writeToLog("PlaybackEngine: Replaced audio file for clip " + clipId +
                                     " -> " + newFile.getFullPathName());
            return;
        }
    }
    juce::Logger::writeToLog("PlaybackEngine::replaceClipAudioFile: clip not found: " + clipId);
}

void PlaybackEngine::clearPitchCorrectionFile(const juce::String& clipId)
{
    juce::ScopedLock sl(lock);
    pitchCorrectedFiles.erase(clipId);
    juce::Logger::writeToLog("PlaybackEngine: Cleared pitch correction file for clip " + clipId);
}

void PlaybackEngine::clearAllClips()
{
    juce::ScopedLock sl(lock);
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
                                           const std::vector<PitchCorrectionSegment>& segments)
{
    juce::ScopedLock sl (lock);

    // If the clip currently has a pitch-corrected file baked in, revert to the
    // original audio so the real-time preview applies to the UNCORRECTED audio.
    // Without this, the preview would double-shift: the corrected file already
    // has the old pitch shift baked in, and the preview would add the new ratio
    // on top — always increasing pitch regardless of direction.
    auto corrIt = pitchCorrectedFiles.find (clipId);
    if (corrIt != pitchCorrectedFiles.end())
    {
        for (auto& clip : clips)
        {
            if (clip.clipId == clipId && clip.originalAudioFile.existsAsFile())
            {
                readers.erase (clip.audioFile.getFullPathName());
                readerAccessTimes.erase (clip.audioFile.getFullPathName());
                clip.audioFile = clip.originalAudioFile;
                clip.offset = clip.originalOffset;
                preloadReader (clip.audioFile);
                juce::Logger::writeToLog ("PlaybackEngine: Reverted clip " + clipId
                    + " to original file for preview (was: " + corrIt->second.getFullPathName() + ")");
                break;
            }
        }
        pitchCorrectedFiles.erase (corrIt);
    }

    auto it = clipPitchPreviews.find (clipId);
    if (it != clipPitchPreviews.end())
    {
        it->second->segments = segments;
        // Re-initialize stretcher when segments change to avoid stale state
        it->second->prepared = false;
        it->second->lastPlaybackTime = -1.0;
    }
    else
    {
        auto state = std::make_unique<ClipPitchPreviewState>();
        state->segments = segments;
        clipPitchPreviews[clipId] = std::move (state);
    }

    juce::Logger::writeToLog ("PlaybackEngine: Set pitch preview for clip " + clipId +
                               " (" + juce::String ((int) segments.size()) + " segments)");
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
        buffer.clear();
        return;
    }

    buffer.clear();

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

        // Calculate read position within clip
        double offsetInClip = currentTime - clip.startTime;
        if (offsetInClip < 0)
        {
            // Clip starts partway through this buffer
            offsetInClip = 0;
        }

        // Get cached reader — never does disk I/O (readers pre-loaded in addClip)
        auto* reader = getCachedReader(clip.audioFile);
        if (reader == nullptr)
            continue;

        // Sample rate conversion ratio (file rate vs device rate)
        double fileSampleRate = reader->sampleRate;
        double ratio = fileSampleRate / sampleRate;  // e.g. 48000/44100 = 1.0884

        // Calculate file sample position using the FILE's sample rate
        juce::int64 fileStartSample = (juce::int64)((offsetInClip + clip.offset) * fileSampleRate);

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
                auto& preview = *previewIt->second;

                // Prepare stretcher on first use (or after reset)
                if (! preview.prepared)
                {
                    preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                    preview.prepared = true;
                }

                // Detect seeking: if playback time jumped, reinitialize
                double clipTime = offsetInClip;
                if (preview.lastPlaybackTime >= 0.0 &&
                    std::abs (clipTime - preview.lastPlaybackTime) > 0.1)
                {
                    preview.stretcher.presetCheaper (readerChannels, static_cast<float> (fileSampleRate));
                }
                preview.lastPlaybackTime = clipTime + (fileSamplesToRead / fileSampleRate);

                // Determine the dominant pitch ratio for this block
                double blockMidTime = offsetInClip + (fileSamplesToRead * 0.5 / fileSampleRate);
                float pitchRatio = lookupPitchRatio (preview.segments, blockMidTime);

                // Only process if ratio != 1.0 (avoid unnecessary processing)
                if (std::abs (pitchRatio - 1.0f) > 0.001f)
                {
                    preview.stretcher.setTransposeFactor (pitchRatio);
                    preview.stretcher.setFormantFactor (1.0f / pitchRatio);

                    // Ensure pitch shift work buffer is large enough
                    if (pitchShiftWorkBuffer.getNumSamples() < fileSamplesToRead)
                        pitchShiftWorkBuffer.setSize (readerChannels, fileSamplesToRead);

                    std::vector<const float*> inPtrs  (static_cast<size_t> (readerChannels));
                    std::vector<float*>       outPtrs (static_cast<size_t> (readerChannels));
                    for (int ch = 0; ch < readerChannels; ++ch)
                    {
                        inPtrs[static_cast<size_t> (ch)]  = reusableFileBuffer.getReadPointer (ch);
                        outPtrs[static_cast<size_t> (ch)] = pitchShiftWorkBuffer.getWritePointer (ch);
                    }

                    preview.stretcher.process (inPtrs, fileSamplesToRead, outPtrs, fileSamplesToRead);

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
            juce::String envKey = clip.trackId + "::" + clip.clipId;
            auto envIt = gainEnvelopes.find(envKey);
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
}
