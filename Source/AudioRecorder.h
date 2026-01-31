#pragma once

#include <JuceHeader.h>
#include <memory>
#include <map>

// Handles recording audio to disk for individual tracks
class AudioRecorder
{
public:
    AudioRecorder();
    ~AudioRecorder();
    
    // Start recording for a specific track
    bool startRecording(const juce::String& trackId, const juce::File& file, double sampleRate, int numChannels = 2);
    
    // Stop recording for a track
    void stopRecording(const juce::String& trackId);
    
    // Write audio data for a track
    void writeBlock(const juce::String& trackId, const juce::AudioBuffer<float>& buffer, int numSamples);
    
    // Check if a track is currently recording
    bool isRecording(const juce::String& trackId) const;
    
    // Set the start time for a recording (in seconds)
    void setRecordingStartTime(const juce::String& trackId, double timeInSeconds);
    
    // Stop all active recordings and return info about completed clips
    struct CompletedRecording {
        juce::String trackId; // Changed from index to ID
        juce::File file;
        double startTime;  // When recording started (in seconds)
        double duration;   // Duration in seconds
    };
    std::vector<CompletedRecording> stopAllRecordings(double currentSampleRate);

    // Get waveform peaks for a recording currently in progress
    // Returns peaks calculated from buffered samples at the requested resolution
    juce::var getRecordingPeaks(const juce::String& trackId, int samplesPerPixel, int numPixels);

private:
    struct ActiveRecording
    {
        juce::String trackId; // Changed from index to ID
        std::unique_ptr<juce::AudioFormatWriter> writer;
        juce::File outputFile;
        bool isActive = false;
        double startTime = 0.0;      // Recording start time in seconds
        juce::int64 samplesWritten = 0;  // Total samples written
        int numChannels = 2;  // Number of channels being recorded
        std::vector<float> sampleBuffer;  // Interleaved samples for live waveform display
    };
    
    std::map<juce::String, ActiveRecording> activeRecordings;
    juce::WavAudioFormat wavFormat;
    juce::CriticalSection writerLock;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioRecorder)
};
