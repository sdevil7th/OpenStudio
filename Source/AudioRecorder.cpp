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
