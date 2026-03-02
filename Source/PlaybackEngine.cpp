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

    // Pre-load the reader on the message thread so audio thread never does disk I/O
    preloadReader(audioFile);

    ClipInfo clip(audioFile, startTime, duration, trackId, offset, volumeDB, fadeIn, fadeOut);
    clip.clipId = clipId;
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

void PlaybackEngine::clearAllClips()
{
    juce::ScopedLock sl(lock);
    clips.clear();
    readers.clear();
    readerAccessTimes.clear();
    lagrangeInterpolatorL.reset();
    lagrangeInterpolatorR.reset();
    juce::Logger::writeToLog("PlaybackEngine: Cleared all clips");
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
