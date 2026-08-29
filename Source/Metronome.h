/*
  ==============================================================================

    Metronome.h
    Created: 27 Oct 2023 10:00:00am
    Author:  Antigravity

  ==============================================================================
*/

#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

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
    bool isEnabled() const
    {
        return enabled.load(std::memory_order_acquire);
    }

    // Custom click sounds (Phase 9C)
    bool setClickSound(const juce::String& filePath);    // Load custom WAV for regular beats
    bool setAccentSound(const juce::String& filePath);   // Load custom WAV for accented beats
    void resetToDefaultSounds();                          // Restore synthesized clicks

    // Getters for offline rendering
    std::vector<bool> getAccentBeats() const;
    float getVolume() const
    {
        return volume.load(std::memory_order_relaxed);
    }
    double getBpm() const
    {
        return bpm.load(std::memory_order_relaxed);
    }
    int getNumerator() const;
    int getDenominator() const;

    // Render metronome audio to a WAV file offline (for export/render track)
    bool renderToFile(const juce::File& outputFile, double startTimeSeconds, double endTimeSeconds);

private:
    struct ClickData
    {
        std::vector<bool> accentBeats {
            true, false, false, false
        };
        juce::AudioBuffer<float> highClickBuffer;
        juce::AudioBuffer<float> lowClickBuffer;
        bool usingCustomClick = false;
        bool usingCustomAccent = false;
        juce::String customClickPath;
        juce::String customAccentPath;
    };

    static constexpr std::uint64_t defaultTimeSignature =
        (static_cast<std::uint64_t>(4) << 32)
        | static_cast<std::uint64_t>(4);

    std::atomic<double> sampleRate { 44100.0 };
    std::atomic<double> bpm { 120.0 };
    std::atomic<std::uint64_t> packedTimeSignature {
        defaultTimeSignature
    };
    std::atomic<float> volume { 0.5f };
    std::atomic<bool> enabled { false };

    // Playback state
    int clickSampleCounter = 0; // Current position within the click sound
    bool isClicking = false;    // Are we currently playing a click?
    bool isHighClick = false;   // Is the current click a bar start (high pitch)?
    double lastSamplePosition = -1.0; // Track last position to detect playback restart
    
    // Internal helpers
    static std::uint64_t packTimeSignature(
        int numerator, int denominator) noexcept;
    static int unpackNumerator(
        std::uint64_t timeSignature) noexcept;
    static int unpackDenominator(
        std::uint64_t timeSignature) noexcept;
    static void generateDefaultClickSounds(
        double targetSampleRate,
        juce::AudioBuffer<float>& highClick,
        juce::AudioBuffer<float>& lowClick);
    std::shared_ptr<ClickData> createDefaultClickData(
        double targetSampleRate) const;
    std::shared_ptr<const ClickData>
        getClickDataSnapshot() const;
    void publishClickData(
        std::shared_ptr<const ClickData> nextData);
    bool loadSoundFromFile(
        const juce::String& filePath,
        double targetSampleRate,
        juce::AudioBuffer<float>& targetBuffer);

    // Control-side writes are serialised independently from publication.
    // The audio thread never acquires either lock.
    mutable juce::CriticalSection clickDataPublicationLock;
    juce::CriticalSection clickDataMutationLock;
    std::shared_ptr<const ClickData> clickDataOwner;
    std::atomic<const ClickData*> clickDataForAudio {
        nullptr
    };
    std::atomic<std::uint32_t> clickDataAudioReaders { 0 };
    std::vector<std::shared_ptr<const ClickData>>
        retiredClickDataOwners;

    juce::AudioFormatManager formatManager;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Metronome)
};
