#include "PlaybackEngine.h"

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

void PlaybackEngine::addClip(const juce::File& audioFile, double startTime, double duration, const juce::String& trackId, 
                              double offset, double volumeDB, double fadeIn, double fadeOut)
{
    juce::ScopedLock sl(lock);
    
    if (!audioFile.existsAsFile())
    {
        juce::Logger::writeToLog("PlaybackEngine: Cannot add clip - file does not exist: " + audioFile.getFullPathName());
        return;
    }
    
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
    juce::ScopedLock sl(lock);
    
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
        
        // Get reader for this clip
        auto* reader = getReader(clip.audioFile);
        if (reader == nullptr)
            continue;
        
        // Calculate sample positions - add clip offset for trimmed playback
        juce::int64 startSample = (juce::int64)((offsetInClip + clip.offset) * sampleRate);
        int samplesToRead = numSamples;
        
        // Adjust if we're near the end of the clip
        juce::int64 samplesAvailable = reader->lengthInSamples - startSample;
        if (samplesAvailable < samplesToRead)
            samplesToRead = (int)samplesAvailable;
        
        if (samplesToRead <= 0)
            continue;
        
        // Create temporary buffer for reading
        juce::AudioBuffer<float> tempBuffer(reader->numChannels, samplesToRead);
        
        // Read audio data
        reader->read(&tempBuffer, 0, samplesToRead, startSample, true, true);
        
        // Apply per-clip gain (convert dB to linear)
        float clipGain = juce::Decibels::decibelsToGain(static_cast<float>(clip.volumeDB));
        
        // Apply fade in/out
        for (int i = 0; i < samplesToRead; ++i)
        {
            float fadeGain = 1.0f;
            double sampleTimeInClip = offsetInClip + (i / sampleRate);
            
            // Fade in
            if (clip.fadeIn > 0.0 && sampleTimeInClip < clip.fadeIn)
            {
                fadeGain *= static_cast<float>(sampleTimeInClip / clip.fadeIn);
            }
            
            // Fade out
            double timeFromEnd = clip.duration - sampleTimeInClip;
            if (clip.fadeOut > 0.0 && timeFromEnd < clip.fadeOut)
            {
                fadeGain *= static_cast<float>(timeFromEnd / clip.fadeOut);
            }
            
            // Apply combined gain
            float totalGain = clipGain * fadeGain;
            for (int ch = 0; ch < tempBuffer.getNumChannels(); ++ch)
            {
                tempBuffer.setSample(ch, i, tempBuffer.getSample(ch, i) * totalGain);
            }
        }
        
        // Mix into output buffer
        for (int ch = 0; ch < std::min(buffer.getNumChannels(), tempBuffer.getNumChannels()); ++ch)
        {
            buffer.addFrom(ch, 0, tempBuffer, ch, 0, samplesToRead);
        }
    }
}
