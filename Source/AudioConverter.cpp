#include "AudioConverter.h"

juce::String AudioConverter::convertClipToTrackConfig(
    const juce::File& sourceFile,
    int targetChannels,
    double targetSampleRate)
{
    if (!sourceFile.existsAsFile())
    {
        juce::Logger::writeToLog("AudioConverter: Source file does not exist");
        return {};
    }
    
    // Read source file
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sourceFile));
    if (reader == nullptr)
    {
        juce::Logger::writeToLog("AudioConverter: Failed to create reader for source file");
        return {};
    }
    
    int sourceChannels = static_cast<int>(reader->numChannels);
    double sourceSampleRate = reader->sampleRate;
    
    // Check if conversion is needed
    if (sourceChannels == targetChannels && sourceSampleRate == targetSampleRate)
    {
        juce::Logger::writeToLog("AudioConverter: No conversion needed");
        return sourceFile.getFullPathName();
    }
    
    juce::Logger::writeToLog("AudioConverter: Converting from " + 
                           juce::String(sourceChannels) + "ch@" + juce::String(sourceSampleRate) + "Hz to " +
                           juce::String(targetChannels) + "ch@" + juce::String(targetSampleRate) + "Hz");
    
    // Read entire source file
    juce::AudioBuffer<float> sourceBuffer(sourceChannels, static_cast<int>(reader->lengthInSamples));
    reader->read(&sourceBuffer, 0, static_cast<int>(reader->lengthInSamples), 0, true, true);
    
    // Perform channel conversion if needed
    juce::AudioBuffer<float> channelConverted;
    if (sourceChannels != targetChannels)
    {
        channelConverted.setSize(targetChannels, sourceBuffer.getNumSamples());
        
        if (sourceChannels == 1 && targetChannels == 2)
        {
            monoToStereo(sourceBuffer, channelConverted);
        }
        else if (sourceChannels == 2 && targetChannels == 1)
        {
            stereoToMono(sourceBuffer, channelConverted);
        }
        else
        {
            // For other channel configs, just copy what we can
            for (int ch = 0; ch < juce::jmin(sourceChannels, targetChannels); ++ch)
            {
                channelConverted.copyFrom(ch, 0, sourceBuffer, ch, 0, sourceBuffer.getNumSamples());
            }
        }
    }
    else
    {
        channelConverted = sourceBuffer;
    }
    
    // Perform sample rate conversion if needed
    juce::AudioBuffer<float> finalBuffer;
    if (sourceSampleRate != targetSampleRate)
    {
        double ratio = targetSampleRate / sourceSampleRate;
        int newLength = static_cast<int>(channelConverted.getNumSamples() * ratio);
        finalBuffer.setSize(targetChannels, newLength);
        resample(channelConverted, finalBuffer, sourceSampleRate, targetSampleRate);
    }
    else
    {
        finalBuffer = channelConverted;
    }
    
    // Create temporary output file
    juce::File tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory);
    juce::File outputFile = tempDir.getChildFile("converted_" + juce::Uuid().toString() + ".wav");
    
    // Write converted audio
    std::unique_ptr<juce::FileOutputStream> outputStream(outputFile.createOutputStream());
    if (outputStream == nullptr)
    {
        juce::Logger::writeToLog("AudioConverter: Failed to create output stream");
        return {};
    }
    
    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(outputStream.get(), targetSampleRate, targetChannels, 16, {}, 0)
    );
    
    if (writer == nullptr)
    {
        juce::Logger::writeToLog("AudioConverter: Failed to create writer");
        return {};
    }
    
    outputStream.release(); // Writer takes ownership
    
    writer->writeFromAudioSampleBuffer(finalBuffer, 0, finalBuffer.getNumSamples());
    writer->flush();
    
    juce::Logger::writeToLog("AudioConverter: Conversion complete: " + outputFile.getFullPathName());
    return outputFile.getFullPathName();
}

bool AudioConverter::needsConversion(
    const juce::File& sourceFile,
    int targetChannels,
    double targetSampleRate)
{
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sourceFile));
    if (reader == nullptr)
        return false;
    
    return reader->numChannels != targetChannels || reader->sampleRate != targetSampleRate;
}

void AudioConverter::monoToStereo(
    const juce::AudioBuffer<float>& source,
    juce::AudioBuffer<float>& dest)
{
    // Duplicate mono channel to both stereo channels
    dest.copyFrom(0, 0, source, 0, 0, source.getNumSamples());
    dest.copyFrom(1, 0, source, 0, 0, source.getNumSamples());
}

void AudioConverter::stereoToMono(
    const juce::AudioBuffer<float>& source,
    juce::AudioBuffer<float>& dest)
{
    // Average both channels
    for (int i = 0; i < source.getNumSamples(); ++i)
    {
        float avg = (source.getSample(0, i) + source.getSample(1, i)) * 0.5f;
        dest.setSample(0, i, avg);
    }
}

void AudioConverter::resample(
    const juce::AudioBuffer<float>& source,
    juce::AudioBuffer<float>& dest,
    double sourceSampleRate,
    double targetSampleRate)
{
    // Simple linear interpolation resampling
    double ratio = sourceSampleRate / targetSampleRate;
    int sourceLength = source.getNumSamples();
    int destLength = dest.getNumSamples();
    
    for (int ch = 0; ch < dest.getNumChannels(); ++ch)
    {
        for (int i = 0; i < destLength; ++i)
        {
            double sourcePos = i * ratio;
            int index0 = static_cast<int>(sourcePos);
            int index1 = juce::jmin(index0 + 1, sourceLength - 1);
            float frac = static_cast<float>(sourcePos - index0);
            
            float sample0 = source.getSample(ch, index0);
            float sample1 = source.getSample(ch, index1);
            float interpolated = sample0 + frac * (sample1 - sample0);
            
            dest.setSample(ch, i, interpolated);
        }
    }
}
