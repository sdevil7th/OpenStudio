/*
  ==============================================================================

    Metronome.h
    Created: 27 Oct 2023 10:00:00am
    Author:  Antigravity

  ==============================================================================
*/

#pragma once

#include <JuceHeader.h>

class Metronome
{
public:
    Metronome();
    ~Metronome();

    void prepareToPlay(double sampleRate, int samplesPerBlock);
    
    // Add click to the buffer based on current transport position
    void getNextAudioBlock(juce::AudioBuffer<float>& buffer, double currentSamplePosition);

    void setBpm(double newBpm);
    void setTimeSignature(int numerator, int denominator);
    void setVolume(float newVolume);
    void setEnabled(bool shouldBeEnabled);
    void setAccentBeats(const std::vector<bool>& accents);
    bool isEnabled() const { return enabled; }

    // Custom click sounds (Phase 9C)
    bool setClickSound(const juce::String& filePath);    // Load custom WAV for regular beats
    bool setAccentSound(const juce::String& filePath);   // Load custom WAV for accented beats
    void resetToDefaultSounds();                          // Restore synthesized clicks

    // Getters for offline rendering
    const std::vector<bool>& getAccentBeats() const { return accentBeats; }
    float getVolume() const { return volume; }
    double getBpm() const { return bpm; }
    int getNumerator() const { return numerator; }
    int getDenominator() const { return denominator; }

    // Render metronome audio to a WAV file offline (for export/render track)
    bool renderToFile(const juce::File& outputFile, double startTimeSeconds, double endTimeSeconds);

private:
    double sampleRate = 44100.0;
    double bpm = 120.0;
    int numerator = 4;
    int denominator = 4;
    float volume = 0.5f;
    bool enabled = false;
    std::vector<bool> accentBeats = {true, false, false, false}; // Default 4/4 with only beat 1 accented

    // Buffers for cached click sounds
    juce::AudioBuffer<float> highClickBuffer;
    juce::AudioBuffer<float> lowClickBuffer;
    
    // Playback state
    int clickSampleCounter = 0; // Current position within the click sound
    bool isClicking = false;    // Are we currently playing a click?
    bool isHighClick = false;   // Is the current click a bar start (high pitch)?
    double lastSamplePosition = -1.0; // Track last position to detect playback restart
    
    // Internal helpers
    void generateClickSounds();
    bool loadSoundFromFile(const juce::String& filePath, juce::AudioBuffer<float>& targetBuffer);

    // Custom click sound state
    bool usingCustomClick = false;
    bool usingCustomAccent = false;
    juce::String customClickPath;
    juce::String customAccentPath;
    juce::AudioFormatManager formatManager;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Metronome)
};
