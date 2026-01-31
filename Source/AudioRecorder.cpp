#include "AudioRecorder.h"

AudioRecorder::AudioRecorder()
{
}

AudioRecorder::~AudioRecorder()
{
    stopAllRecordings(44100.0);  // Use default sample rate for cleanup
}

bool AudioRecorder::startRecording(const juce::String& trackId, const juce::File& file, double sampleRate, int numChannels)
{
    const juce::ScopedLock sl (writerLock);
    
    // Stop existing recording if any
    if (activeRecordings.find(trackId) != activeRecordings.end())
    {
        // If a recording with this trackId already exists, stop it first.
        // The provided snippet had a syntactically incorrect check and return.
        // The original logic was to stop and restart, so we'll keep that.
        stopRecording(trackId);
    }
    
    // Create parent directory if needed
    auto parentDir = file.getParentDirectory();
    if (!parentDir.exists())
    {
        parentDir.createDirectory();
    }
    
    // Create WAV file writer
    auto* fileOutputStream = new juce::FileOutputStream(file);
    if (!fileOutputStream->openedOk())
    {
        delete fileOutputStream;
        juce::Logger::writeToLog("AudioRecorder: Failed to create output file: " + file.getFullPathName());
        return false;
    }
    
    // Create WAV writer (16-bit PCM)
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(fileOutputStream, sampleRate, (unsigned int)numChannels, 16, {}, 0));
    
    if (!writer)
    {
        delete fileOutputStream;
        juce::Logger::writeToLog("AudioRecorder: Failed to create WAV writer");
        return false;
    }
    
    // Store recording state
    ActiveRecording& state = activeRecordings[trackId];
    state.trackId = trackId;
    state.writer = std::move(writer);
    state.outputFile = file;
    state.isActive = true;
    state.startTime = 0.0;  // Will be set by AudioEngine
    state.samplesWritten = 0;
    state.numChannels = numChannels;
    state.sampleBuffer.clear();
    state.sampleBuffer.reserve(static_cast<size_t>(sampleRate * numChannels * 60)); // Reserve ~60 seconds
    
    juce::Logger::writeToLog("AudioRecorder: Started recording track " + trackId + 
                           " to " + file.getFullPathName());
    return true;
}

void AudioRecorder::writeBlock(const juce::String& trackId, const juce::AudioBuffer<float>& buffer, int numSamples)
{
    const juce::ScopedLock sl (writerLock);

    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end() && it->second.isActive && it->second.writer)
    {
        it->second.writer->writeFromAudioSampleBuffer(buffer, 0, numSamples);
        it->second.samplesWritten += numSamples;

        // Store samples in buffer for live waveform display (interleaved format)
        auto& state = it->second;
        const int numChannels = state.numChannels;
        const size_t prevSize = state.sampleBuffer.size();
        state.sampleBuffer.resize(prevSize + static_cast<size_t>(numSamples * numChannels));

        for (int s = 0; s < numSamples; ++s)
        {
            for (int ch = 0; ch < numChannels; ++ch)
            {
                const int bufferChannel = std::min(ch, buffer.getNumChannels() - 1);
                state.sampleBuffer[prevSize + static_cast<size_t>(s * numChannels + ch)] =
                    buffer.getSample(bufferChannel, s);
            }
        }
    }
}

void AudioRecorder::stopRecording(const juce::String& trackId)
{
    const juce::ScopedLock sl (writerLock);
    
    auto it = activeRecordings.find(trackId); // Changed to use trackId
    if (it != activeRecordings.end())
    {
        if (it->second.writer)
        {
            it->second.writer->flush();
            it->second.writer.reset();
        }
        
        juce::Logger::writeToLog("AudioRecorder: Stopped recording track " + trackId + // Changed trackIndex to trackId
                               " (" + it->second.outputFile.getFullPathName() + ")");
        activeRecordings.erase(it);
    }
}



bool AudioRecorder::isRecording(const juce::String& trackId) const
{
    auto it = activeRecordings.find(trackId);
    return it != activeRecordings.end() && it->second.isActive;
}

void AudioRecorder::setRecordingStartTime(const juce::String& trackId, double startTime)
{
    juce::ScopedLock lock(writerLock);
    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        it->second.startTime = startTime;
    }
}

std::vector<AudioRecorder::CompletedRecording> AudioRecorder::stopAllRecordings(double currentSampleRate)
{
    juce::ScopedLock lock(writerLock);
    
    std::vector<CompletedRecording> completedClips;
    
    for (auto& [trackId, state] : activeRecordings)
    {
        if (state.writer)
        {
            state.writer->flush();
            
            // Calculate duration from samples written
            double duration = state.samplesWritten / currentSampleRate;
            
            // Store clip info
            CompletedRecording clip;
            clip.trackId = trackId; // Changed trackIndex to trackId
            clip.file = state.outputFile;
            clip.startTime = state.startTime;
            clip.duration = duration;
            completedClips.push_back(clip);
            
            state.writer.reset();
        }
    }
    
    activeRecordings.clear();
    juce::Logger::writeToLog("AudioRecorder: Stopped all recordings. Completed " +
                           juce::String(completedClips.size()) + " clips.");

    return completedClips;
}

juce::var AudioRecorder::getRecordingPeaks(const juce::String& trackId, int samplesPerPixel, int numPixels)
{
    juce::Array<juce::var> peakData;

    const juce::ScopedLock sl(writerLock);

    auto it = activeRecordings.find(trackId);
    if (it == activeRecordings.end() || !it->second.isActive)
    {
        // No recording in progress for this track
        return peakData;
    }

    const auto& state = it->second;
    const int numChannels = state.numChannels;
    const size_t totalSamples = state.sampleBuffer.size() / static_cast<size_t>(numChannels);

    if (totalSamples == 0 || numChannels == 0 || samplesPerPixel <= 0 || numPixels <= 0)
    {
        return peakData;
    }

    // Calculate peaks for each pixel
    for (int pixel = 0; pixel < numPixels; ++pixel)
    {
        const juce::int64 startSample = static_cast<juce::int64>(pixel) * samplesPerPixel;

        if (startSample >= static_cast<juce::int64>(totalSamples))
            break;

        const int samplesToRead = std::min(samplesPerPixel,
            static_cast<int>(totalSamples - static_cast<size_t>(startSample)));

        // Create peak object with channels array
        juce::DynamicObject::Ptr peakObj = new juce::DynamicObject();
        juce::Array<juce::var> channels;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            float minVal = 0.0f;
            float maxVal = 0.0f;

            for (int s = 0; s < samplesToRead; ++s)
            {
                const size_t bufferIndex = (static_cast<size_t>(startSample) + static_cast<size_t>(s))
                                           * static_cast<size_t>(numChannels) + static_cast<size_t>(ch);
                const float sample = state.sampleBuffer[bufferIndex];
                if (sample < minVal) minVal = sample;
                if (sample > maxVal) maxVal = sample;
            }

            juce::DynamicObject::Ptr channelPeak = new juce::DynamicObject();
            channelPeak->setProperty("min", minVal);
            channelPeak->setProperty("max", maxVal);
            channels.add(juce::var(channelPeak.get()));
        }

        peakObj->setProperty("channels", channels);
        peakData.add(juce::var(peakObj.get()));
    }

    return peakData;
}
