#pragma once

#include <JuceHeader.h>
#include "PitchDetector.h"
#include "PitchMapper.h"
#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
#include "signalsmith-stretch.h"
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif
#include <atomic>
#include <vector>

/**
 * OpenStudioPitchCorrector — Built-in pitch correction effect.
 *
 * Automatic mode: Real-time pitch detection → scale mapping → pitch shifting.
 * Graphical mode: Offline analysis with note-level editing (Phase 2).
 *
 * Comparable to Melodyne/VariAudio/Auto-Tune for monophonic audio.
 */
class OpenStudioPitchCorrector : public juce::AudioProcessor
{
public:
    OpenStudioPitchCorrector();
    ~OpenStudioPitchCorrector() override = default;

    // ---- AudioProcessor overrides ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    void releaseResources() override;
    void reset() override;

    const juce::String getName() const override { return "OpenStudio Pitch Correct"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isOpenStudioBuiltIn() const { return true; }

    // ---- Sub-component access (for bridge/UI) ----
    PitchDetector& getDetector() { return detector; }
    PitchMapper& getMapper() { return mapper; }

    // ---- Real-time data for UI ----

    struct PitchData
    {
        float detectedHz = 0.0f;
        float correctedHz = 0.0f;
        float confidence = 0.0f;
        float centsDeviation = 0.0f;
        juce::String noteName;
    };

    PitchData getCurrentPitchData() const;

    // Pitch history for scrolling display
    struct PitchHistoryFrame
    {
        float detectedMidi = 0.0f;   // MIDI note (fractional)
        float correctedMidi = 0.0f;  // MIDI note (fractional)
        float confidence = 0.0f;
    };
    std::vector<PitchHistoryFrame> getPitchHistory(int numFrames) const;

    // ---- Parameters (thread-safe) ----

    // Bypass pitch correction (pass-through)
    std::atomic<float> bypass { 0.0f }; // 0=active, 1=bypassed

    // Mix (dry/wet)
    std::atomic<float> mix { 1.0f }; // 0=dry, 1=100% corrected

    // Detection parameters
    std::atomic<float> detectionSource { 0.0f }; // 0=Left, 1=Right, 2=Mid; mono uses its only input
    std::atomic<float> sensitivity { 0.15f }; // YIN threshold (lower = more sensitive)
    std::atomic<float> minFreqParam { 80.0f };
    std::atomic<float> maxFreqParam { 1000.0f };

    // MIDI output
    std::atomic<float> midiOutputEnabled { 0.0f }; // 0=off, 1=on
    std::atomic<float> midiOutputChannel { 1.0f };  // 1-16

private:
    PitchDetector detector;
    PitchMapper mapper;
    signalsmith::stretch::SignalsmithStretch<float> stretcher;

    double cachedSampleRate = 44100.0;
    std::atomic<float> lastDetectedHz { 0.0f };
    std::atomic<float> lastCorrectedHz { 0.0f };

    // Pre-allocated buffers/vectors for processBlock — sized in prepareToPlay,
    // reused every callback to avoid heap allocation on the audio thread.
    juce::AudioBuffer<float>  dryBuffer;       // dry copy for wet/mix blend
    juce::AudioBuffer<float> dryDelay;
    juce::AudioBuffer<float> detectionBuffer;
    int activeDetectionSource = 0;
    int dryDelayPosition = 0;
    juce::SmoothedValue<float> wetMix;
    std::vector<const float*> inPtrs;          // Signalsmith input channel pointers
    std::vector<float*>       outPtrs;         // Signalsmith output channel pointers
    juce::AudioBuffer<float>  stretchOutputBuf; // Signalsmith output staging buffer

    // Ring slots can be overwritten while the UI copies them. Atomic fields
    // avoid a data race; an even, unchanged generation identifies one frame.
    // The reader skips a busy slot rather than making the audio thread wait.
    static constexpr int maxPitchHistory = 512;
    struct PublishedPitchFrame
    {
        std::atomic<unsigned int> generation { 0 };
        std::atomic<float> detectedMidi { 0.0f };
        std::atomic<float> correctedMidi { 0.0f };
        std::atomic<float> confidence { 0.0f };
    };
    std::array<PublishedPitchFrame, maxPitchHistory> pitchHistory;
    std::atomic<int> pitchHistoryWritePos { 0 };

    // MIDI output state
    int currentMidiNote = -1;       // Currently sounding note (-1 = none)
    int currentMidiChannel = 1;
    bool midiResetPending = false;
    int currentMidiVelocity = 0;
    float midiNoteHoldTime = 0.0f;  // Time current note has been held
    static constexpr float midiMinHoldTime = 0.03f; // Min note duration (30ms)

    // Helpers
    static juce::String midiToNoteName(float midiNote);
    static float hzToMidi(float hz);
    static float midiToHz(float midi);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioPitchCorrector)
};
