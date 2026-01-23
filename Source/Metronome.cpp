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
