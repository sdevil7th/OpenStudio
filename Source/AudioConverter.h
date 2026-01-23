#pragma once

#include <JuceHeader.h>

/**
 * AudioConverter handles audio format conversion for clips
 * when moving between tracks with different configurations.
 */
class AudioConverter
{
public:
    AudioConverter() = default;
    ~AudioConverter() = default;
    
    /**
     * Convert audio file to match target track configuration.
     * Creates a new temporary file with converted audio.
     * 
     * @param sourceFile Original audio file
     * @param targetChannels Target number of channels (1=mono, 2=stereo)
     * @param targetSampleRate Target sample rate
     * @return Path to converted file, or empty string on failure
     */
    static juce::String convertClipToTrackConfig(
        const juce::File& sourceFile,
        int targetChannels,
        double targetSampleRate
    );
    
    /**
     * Check if conversion is needed between source and target configs.
     */
    static bool needsConversion(
        const juce::File& sourceFile,
        int targetChannels,
        double targetSampleRate
    );
    
private:
    /**
     * Convert mono to stereo by duplicating channel.
     */
    static void monoToStereo(
        const juce::AudioBuffer<float>& source,
        juce::AudioBuffer<float>& dest
    );
    
    /**
     * Convert stereo to mono by averaging channels.
     */
    static void stereoToMono(
        const juce::AudioBuffer<float>& source,
        juce::AudioBuffer<float>& dest
    );
    
    /**
     * Resample audio to different sample rate.
     */
    static void resample(
        const juce::AudioBuffer<float>& source,
        juce::AudioBuffer<float>& dest,
        double sourceSampleRate,
        double targetSampleRate
    );
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioConverter)
};
