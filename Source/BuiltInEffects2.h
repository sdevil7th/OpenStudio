#pragma once

#include <JuceHeader.h>
#include <atomic>

// ============================================================================
// S13Delay — Stereo delay with tempo sync, ping-pong mode, and feedback LPF
// ============================================================================
class S13Delay : public juce::AudioProcessor
{
public:
    S13Delay();
    ~S13Delay() override = default;

    // Parameters (atomic — set from message thread, read from audio thread)
    std::atomic<float> delayTimeL { 250.0f };   // 1–2000 ms
    std::atomic<float> delayTimeR { 250.0f };   // 1–2000 ms
    std::atomic<float> feedback   { 0.4f };     // 0–0.95
    std::atomic<float> mix        { 0.5f };     // 0–1
    std::atomic<float> pingPong   { 0.0f };     // 0 = off, 1 = on
    std::atomic<float> tempoSync  { 0.0f };     // 0 = off, 1 = on
    std::atomic<float> syncNoteL  { 0.0f };     // index into note table
    std::atomic<float> syncNoteR  { 0.0f };     // index into note table
    std::atomic<float> lpfFreq    { 20000.0f }; // 200–20000 Hz feedback LPF

    // Sync note values:
    //   0 = 1/4, 1 = 1/8, 2 = 1/16,
    //   3 = 1/4 dotted, 4 = 1/8 dotted, 5 = 1/16 dotted,
    //   6 = 1/4 triplet, 7 = 1/8 triplet, 8 = 1/16 triplet

    // ---- AudioProcessor overrides ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "S13 Delay"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 2.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }

private:
    static constexpr int maxDelaySamples = 192001; // ~2 seconds at 96kHz + margin
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineL { maxDelaySamples };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineR { maxDelaySamples };

    // Feedback LPF — one per channel
    juce::dsp::IIR::Filter<float> feedbackLPF_L;
    juce::dsp::IIR::Filter<float> feedbackLPF_R;

    // State for feedback loop
    float feedbackSampleL = 0.0f;
    float feedbackSampleR = 0.0f;

    double cachedSampleRate = 44100.0;
    float lastLPFFreq = 20000.0f;

    // Convert sync note index to milliseconds at given BPM
    static float syncNoteToMs(float noteIndex, double bpm);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Delay)
};


// ============================================================================
// S13Reverb — Algorithmic reverb using juce::dsp::Reverb
// ============================================================================
class S13Reverb : public juce::AudioProcessor
{
public:
    S13Reverb();
    ~S13Reverb() override = default;

    // Parameters
    std::atomic<float> roomSize   { 0.5f };   // 0–1
    std::atomic<float> damping    { 0.5f };   // 0–1
    std::atomic<float> wetLevel   { 0.33f };  // 0–1
    std::atomic<float> dryLevel   { 0.7f };   // 0–1
    std::atomic<float> width      { 1.0f };   // 0–1
    std::atomic<float> freezeMode { 0.0f };   // 0 = off, 1 = on

    // ---- AudioProcessor overrides ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "S13 Reverb"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 3.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }

private:
    juce::dsp::Reverb reverb;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Reverb)
};


// ============================================================================
// S13Chorus — Stereo chorus with LFO-modulated delay lines
// ============================================================================
class S13Chorus : public juce::AudioProcessor
{
public:
    S13Chorus();
    ~S13Chorus() override = default;

    // Parameters
    std::atomic<float> rate     { 1.0f };   // 0.1–10 Hz LFO rate
    std::atomic<float> depth    { 0.5f };   // 0–1
    std::atomic<float> fbAmount { 0.0f };   // -1 to 1 (feedback)
    std::atomic<float> mix      { 0.5f };   // 0–1
    std::atomic<float> voices   { 2.0f };   // 1–4

    // ---- AudioProcessor overrides ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "S13 Chorus"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }

private:
    static constexpr int maxVoices = 4;
    static constexpr int maxChorusDelaySamples = 4096; // ~85ms at 48kHz — plenty

    // One delay line per voice per channel
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLines[2][maxVoices];

    // LFO phase per voice (0–2pi)
    float lfoPhase[maxVoices] = {};

    // Feedback state per channel
    float feedbackState[2] = {};

    double cachedSampleRate = 44100.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Chorus)
};


// ============================================================================
// S13Saturator — Soft clipping / tape saturation
// ============================================================================
class S13Saturator : public juce::AudioProcessor
{
public:
    S13Saturator();
    ~S13Saturator() override = default;

    // Parameters
    std::atomic<float> drive      { 6.0f };     // 0–30 dB
    std::atomic<float> mix        { 1.0f };     // 0–1
    std::atomic<float> toneFreq   { 20000.0f }; // 200–20000 Hz post-saturation LPF
    std::atomic<float> outputGain { 0.0f };     // -12 to 0 dB

    // ---- AudioProcessor overrides ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "S13 Saturator"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }

    // Oversampling control (Phase 20.12)
    void setOversamplingEnabled(bool enabled) { oversamplingEnabled = enabled; }
    bool isOversamplingEnabled() const { return oversamplingEnabled; }

private:
    // Post-saturation tone filter (one per channel)
    juce::dsp::IIR::Filter<float> toneFilterL;
    juce::dsp::IIR::Filter<float> toneFilterR;

    double cachedSampleRate = 44100.0;
    float lastToneFreq = 20000.0f;

    // 2x oversampling processor (Phase 20.12)
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    bool oversamplingEnabled = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Saturator)
};
