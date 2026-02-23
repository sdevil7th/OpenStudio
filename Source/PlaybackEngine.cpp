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
        return;  // Already loaded

    std::unique_ptr<juce::AudioFormatReader> newReader(formatManager.createReaderFor(file));
    if (newReader)
    {
        readers[filePath] = std::move(newReader);
        juce::Logger::writeToLog("PlaybackEngine: Pre-loaded reader for: " + filePath);
    }
}

juce::AudioFormatReader* PlaybackEngine::getCachedReader(const juce::File& file)
{
    // Audio-thread safe: only looks up, never creates readers
    auto it = readers.find(file.getFullPathName());
    if (it != readers.end() && it->second != nullptr)
        return it->second.get();
    return nullptr;
}

void PlaybackEngine::addClip(const juce::File& audioFile, double startTime, double duration, const juce::String& trackId,
                              double offset, double volumeDB, double fadeIn, double fadeOut)
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

        // Resample (linear interpolation) + apply gain/fades in one pass
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

            float totalGain = clipGain * fadeGain;

            // Linear interpolation + gain for each channel
            for (int ch = 0; ch < std::min(outChannels, fileChannels); ++ch)
            {
                float s0 = reusableFileBuffer.getSample(ch, idx);
                float s1 = (idx + 1 < fileSamplesToRead) ? reusableFileBuffer.getSample(ch, idx + 1) : s0;
                float sample = s0 + frac * (s1 - s0);  // lerp
                buffer.addSample(ch, i, sample * totalGain);
            }
        }
    }
}
