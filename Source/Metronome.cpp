/*
  ==============================================================================

    Metronome.cpp
    Created: 27 Oct 2023 10:00:00am
    Author:  Antigravity

  ==============================================================================
*/

#include "Metronome.h"

Metronome::Metronome()
{
    formatManager.registerBasicFormats();
    generateClickSounds();
}

Metronome::~Metronome()
{
}

void Metronome::prepareToPlay(double newSampleRate, int samplesPerBlock)
{
    if (sampleRate != newSampleRate)
    {
        sampleRate = newSampleRate;
        generateClickSounds(); // Regenerate for new sample rate
    }
}

void Metronome::generateClickSounds()
{
    // Generate 20ms click
    int samples = static_cast<int>(sampleRate * 0.05); // 50ms just in case
    highClickBuffer.setSize(1, samples);
    lowClickBuffer.setSize(1, samples);
    
    highClickBuffer.clear();
    lowClickBuffer.clear();
    
    auto* highWrite = highClickBuffer.getWritePointer(0);
    auto* lowWrite = lowClickBuffer.getWritePointer(0);
    
    // High click: 1500Hz sine wave with exponential decay
    // Low click: 800Hz sine wave with exponential decay
    
    double highFreq = 1500.0;
    double lowFreq = 800.0;
    double decay = 0.002; // Decay rate
    
    for (int i = 0; i < samples; ++i)
    {
        double t = i / sampleRate;
        double envelope = std::exp(-i * decay); // Exponential decay (per sample approximation)
        // Correct decay: exp(-t * k)
        // Let's use simple linear decay for safety or standard ADSR? 
        // Simple exp decay:
        envelope = std::exp(-50.0 * t); // Decays effectively in ~100ms
        
        highWrite[i] = (float)(std::sin(2.0 * juce::MathConstants<double>::pi * highFreq * t) * envelope);
        lowWrite[i] = (float)(std::sin(2.0 * juce::MathConstants<double>::pi * lowFreq * t) * envelope);
    }
}

void Metronome::getNextAudioBlock(juce::AudioBuffer<float>& buffer, double currentSamplePosition)
{
    if (!enabled) return;

    int numSamples = buffer.getNumSamples();
    int samplesPerBeat = static_cast<int>((60.0 / bpm) * sampleRate);
    
    // Safety check
    if (samplesPerBeat <= 0) return;

    auto* leftConfig = buffer.getWritePointer(0);
    auto* rightConfig = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : nullptr;

    // Detect playback restart: if position jumped backwards (e.g., from >0 back to 0)
    // or if this is the very first call (lastSamplePosition is -1)
    bool playbackRestarted = (lastSamplePosition < 0) || (currentSamplePosition < lastSamplePosition);
    
    // If playback restarted at or near position 0, immediately trigger the first click
    if (playbackRestarted && currentSamplePosition < samplesPerBeat && !isClicking)
    {
        // Force the first beat to be triggered
        isClicking = true;
        clickSampleCounter = 0;
        // First beat is always accented (beat 0)
        if (!accentBeats.empty()) {
            isHighClick = accentBeats[0];
        } else {
            isHighClick = true;
        }
    }

    for (int i = 0; i < numSamples; ++i)
    {
        double currentPos = currentSamplePosition + i;
        
        long posInt = static_cast<long>(currentPos);
        
        // Determine if this sample is a beat start
        bool isBeatStart = (posInt % samplesPerBeat == 0) && (posInt > 0 || !playbackRestarted);
        
        if (isBeatStart && !isClicking)
        {
            // Beat detected
            int totalBeats = static_cast<int>(posInt / samplesPerBeat);
            int beatInBar = totalBeats % numerator; // 0-indexed: 0 is the first beat
            
            isClicking = true;
            clickSampleCounter = 0;
            // Use accent array to determine if this beat should be high-pitched
            if (beatInBar < (int)accentBeats.size()) {
                isHighClick = accentBeats[beatInBar];
            } else {
                // Fallback: only accent beat 0 if array doesn't cover this beat
                isHighClick = (beatInBar == 0);
            }
        }
        
        // Mix click if active
        if (isClicking)
        {
            float clickValue = 0.0f;
            const auto& sourceBuffer = isHighClick ? highClickBuffer : lowClickBuffer;
            
            if (clickSampleCounter < sourceBuffer.getNumSamples())
            {
                clickValue = sourceBuffer.getReadPointer(0)[clickSampleCounter] * volume;
                clickSampleCounter++;
            }
            else
            {
                isClicking = false; // Click finished
            }
            
            // Add to output
            leftConfig[i] += clickValue;
            if (rightConfig) rightConfig[i] += clickValue;
        }
    }
    
    // Update last position for restart detection
    lastSamplePosition = currentSamplePosition + numSamples;
}

void Metronome::setBpm(double newBpm)
{
    if (newBpm > 0)
        bpm = newBpm;
}

void Metronome::setTimeSignature(int newNumerator, int newDenominator)
{
    if (newNumerator > 0) numerator = newNumerator;
    if (newDenominator > 0) denominator = newDenominator;
}

void Metronome::setVolume(float newVolume)
{
    volume = newVolume;
}

void Metronome::setEnabled(bool shouldBeEnabled)
{
    enabled = shouldBeEnabled;
}

void Metronome::setAccentBeats(const std::vector<bool>& accents)
{
    accentBeats = accents;
    // Ensure we always have at least one element and beat 0 is always accented
    if (accentBeats.empty()) {
        accentBeats.resize(numerator, false);
    }
    if (!accentBeats.empty()) {
        accentBeats[0] = true; // Beat 1 is always accented
    }
}

bool Metronome::renderToFile(const juce::File& outputFile, double startTimeSeconds, double endTimeSeconds)
{
    // Calculate total samples
    int totalSamples = static_cast<int>((endTimeSeconds - startTimeSeconds) * sampleRate);
    if (totalSamples <= 0)
        return false;

    // Create WAV writer
    if (outputFile.existsAsFile())
        outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    auto outputStream = std::make_unique<juce::FileOutputStream>(outputFile);
    if (outputStream->failedToOpen())
        return false;

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(
            outputStream.get(),
            sampleRate,
            2,  // stereo
            16, // bit depth
            {}, // metadata
            0   // quality
        )
    );

    if (!writer)
        return false;

    outputStream.release(); // Writer takes ownership of the stream

    // Save and reset playback state for clean offline render
    int savedClickCounter = clickSampleCounter;
    bool savedIsClicking = isClicking;
    bool savedIsHighClick = isHighClick;
    double savedLastPos = lastSamplePosition;
    bool savedEnabled = enabled;

    clickSampleCounter = 0;
    isClicking = false;
    isHighClick = false;
    lastSamplePosition = -1.0;
    enabled = true; // Force enabled for rendering

    // Process in blocks
    const int blockSize = 512;
    juce::AudioBuffer<float> buffer(2, blockSize);
    double currentPos = startTimeSeconds * sampleRate;
    int samplesRemaining = totalSamples;

    while (samplesRemaining > 0)
    {
        int samplesToProcess = std::min(blockSize, samplesRemaining);
        buffer.clear();

        // Use a sub-region of the buffer if less than blockSize
        if (samplesToProcess < blockSize)
        {
            juce::AudioBuffer<float> subBuffer(buffer.getArrayOfWritePointers(), 2, samplesToProcess);
            getNextAudioBlock(subBuffer, currentPos);
            writer->writeFromAudioSampleBuffer(subBuffer, 0, samplesToProcess);
        }
        else
        {
            getNextAudioBlock(buffer, currentPos);
            writer->writeFromAudioSampleBuffer(buffer, 0, samplesToProcess);
        }

        currentPos += samplesToProcess;
        samplesRemaining -= samplesToProcess;
    }

    // Restore playback state
    clickSampleCounter = savedClickCounter;
    isClicking = savedIsClicking;
    isHighClick = savedIsHighClick;
    lastSamplePosition = savedLastPos;
    enabled = savedEnabled;

    return true;
}

// =============================================================================
// Phase 9C: Custom Click Sounds
// =============================================================================

bool Metronome::loadSoundFromFile(const juce::String& filePath, juce::AudioBuffer<float>& targetBuffer)
{
    juce::File audioFile(filePath);
    if (!audioFile.existsAsFile())
        return false;

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(audioFile));
    if (!reader)
        return false;

    // Limit click sample to 2 seconds max
    auto maxSamples = (juce::int64)(reader->sampleRate * 2.0);
    auto samplesToRead = std::min(reader->lengthInSamples, maxSamples);

    if (samplesToRead <= 0)
        return false;

    // Read into a temp buffer at the file's native sample rate
    juce::AudioBuffer<float> fileBuffer((int)reader->numChannels, (int)samplesToRead);
    reader->read(&fileBuffer, 0, (int)samplesToRead, 0, true, true);

    // Mix to mono if multi-channel
    int outSamples = (int)samplesToRead;
    // If sample rate differs, resample to match metronome's sample rate
    if (std::abs(reader->sampleRate - sampleRate) > 1.0)
    {
        double ratio = sampleRate / reader->sampleRate;
        outSamples = (int)(samplesToRead * ratio);
    }

    targetBuffer.setSize(1, outSamples);
    targetBuffer.clear();

    auto* outWrite = targetBuffer.getWritePointer(0);

    if (std::abs(reader->sampleRate - sampleRate) > 1.0)
    {
        // Simple linear interpolation resample
        double ratio = reader->sampleRate / sampleRate;
        for (int i = 0; i < outSamples; ++i)
        {
            double srcPos = i * ratio;
            int idx0 = (int)srcPos;
            int idx1 = idx0 + 1;
            double frac = srcPos - idx0;

            float val = 0.0f;
            for (int ch = 0; ch < (int)reader->numChannels; ++ch)
            {
                const float* chData = fileBuffer.getReadPointer(ch);
                float s0 = (idx0 < (int)samplesToRead) ? chData[idx0] : 0.0f;
                float s1 = (idx1 < (int)samplesToRead) ? chData[idx1] : 0.0f;
                val += (float)(s0 + (s1 - s0) * frac);
            }
            outWrite[i] = val / reader->numChannels;
        }
    }
    else
    {
        // Same sample rate — just mix to mono
        for (int i = 0; i < outSamples; ++i)
        {
            float val = 0.0f;
            for (int ch = 0; ch < (int)reader->numChannels; ++ch)
                val += fileBuffer.getReadPointer(ch)[i];
            outWrite[i] = val / reader->numChannels;
        }
    }

    return true;
}

bool Metronome::setClickSound(const juce::String& filePath)
{
    if (filePath.isEmpty())
    {
        // Reset to default
        usingCustomClick = false;
        customClickPath.clear();
        generateClickSounds(); // Regenerate defaults (only overwrites lowClickBuffer if not custom)
        return true;
    }

    juce::AudioBuffer<float> tempBuffer;
    if (loadSoundFromFile(filePath, tempBuffer))
    {
        lowClickBuffer = std::move(tempBuffer);
        usingCustomClick = true;
        customClickPath = filePath;
        return true;
    }
    return false;
}

bool Metronome::setAccentSound(const juce::String& filePath)
{
    if (filePath.isEmpty())
    {
        usingCustomAccent = false;
        customAccentPath.clear();
        generateClickSounds();
        return true;
    }

    juce::AudioBuffer<float> tempBuffer;
    if (loadSoundFromFile(filePath, tempBuffer))
    {
        highClickBuffer = std::move(tempBuffer);
        usingCustomAccent = true;
        customAccentPath = filePath;
        return true;
    }
    return false;
}

void Metronome::resetToDefaultSounds()
{
    usingCustomClick = false;
    usingCustomAccent = false;
    customClickPath.clear();
    customAccentPath.clear();
    generateClickSounds();
}
