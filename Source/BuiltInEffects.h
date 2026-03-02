#pragma once

#include <JuceHeader.h>

//==============================================================================
/**
 * Base class for all Studio13 built-in effects.
 *
 * Provides AudioProcessor boilerplate shared by S13EQ, S13Compressor, S13Gate,
 * and S13Limiter. Each subclass only needs to implement getName(),
 * prepareToPlay(), processBlock(), and optionally releaseResources().
 */
class S13BuiltInEffect : public juce::AudioProcessor
{
public:
    S13BuiltInEffect();
    ~S13BuiltInEffect() override = default;

    // Identify as built-in (not VST3, not JSFX)
    bool isS13BuiltIn() const { return true; }

    // ---- AudioProcessor boilerplate (same for all built-ins) ----
    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int index) override { juce::ignoreUnused(index); }
    const juce::String getProgramName(int index) override { juce::ignoreUnused(index); return {}; }
    void changeProgramName(int index, const juce::String& newName) override { juce::ignoreUnused(index, newName); }

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    // Oversampling control (Phase 20.12)
    void setOversamplingEnabled(bool enabled);
    bool isOversamplingEnabled() const { return oversamplingEnabled; }

protected:
    // 2x oversampling processor — initialized in derived prepareToPlay()
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    bool oversamplingEnabled = false;

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13BuiltInEffect)
};

//==============================================================================
/**
 * S13EQ — 4-band parametric EQ with HPF and LPF.
 *
 * Signal chain: HPF -> Band1 -> Band2 -> Band3 -> Band4 -> LPF
 *
 * Uses juce::dsp::ProcessorDuplicator<IIR::Filter, IIR::Coefficients> for
 * automatic stereo duplication of mono IIR filters.
 */
class S13EQ : public S13BuiltInEffect
{
public:
    S13EQ();
    ~S13EQ() override = default;

    const juce::String getName() const override { return "S13 EQ"; }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // ---- Parameters ----
    // HPF
    std::atomic<float> hpfFreq { 20.0f };     // 20-500 Hz

    // LPF
    std::atomic<float> lpfFreq { 20000.0f };   // 2000-20000 Hz

    // 4 parametric bands
    struct BandParams
    {
        std::atomic<float> freq { 1000.0f };   // Hz
        std::atomic<float> gain { 0.0f };      // dB (-24 to +24)
        std::atomic<float> q { 1.0f };         // 0.1 to 10.0
    };
    BandParams bands[4];

private:
    using StereoIIR = juce::dsp::ProcessorDuplicator<juce::dsp::IIR::Filter<float>,
                                                      juce::dsp::IIR::Coefficients<float>>;

    StereoIIR hpf;
    StereoIIR lpf;
    StereoIIR band1, band2, band3, band4;

    double cachedSampleRate = 44100.0;

    void updateFilters();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13EQ)
};

//==============================================================================
/**
 * S13Compressor — Feed-forward compressor with knee and makeup gain.
 *
 * Uses juce::dsp::Compressor for the core compression, with additional
 * soft-knee and makeup gain applied manually.
 */
class S13Compressor : public S13BuiltInEffect
{
public:
    S13Compressor();
    ~S13Compressor() override = default;

    const juce::String getName() const override { return "S13 Compressor"; }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // ---- Parameters ----
    std::atomic<float> threshold { 0.0f };     // -60 to 0 dB
    std::atomic<float> ratio { 1.0f };         // 1:1 to 20:1
    std::atomic<float> attack { 10.0f };       // 0.1 to 100 ms
    std::atomic<float> release { 100.0f };     // 10 to 1000 ms
    std::atomic<float> knee { 0.0f };          // 0 to 20 dB
    std::atomic<float> makeupGain { 0.0f };    // 0 to 30 dB

private:
    juce::dsp::Compressor<float> compressor;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMakeup;
    double cachedSampleRate = 44100.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Compressor)
};

//==============================================================================
/**
 * S13Gate — Noise gate with hold and range.
 *
 * Custom implementation using an envelope follower with ballistics filtering,
 * since juce::dsp::NoiseGate lacks hold and range parameters.
 *
 * Stereo-linked detection: uses the louder channel's level to control
 * gain reduction on both channels, preserving the stereo image.
 */
class S13Gate : public S13BuiltInEffect
{
public:
    S13Gate();
    ~S13Gate() override = default;

    const juce::String getName() const override { return "S13 Gate"; }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // ---- Parameters ----
    std::atomic<float> threshold { -40.0f };   // -80 to 0 dB
    std::atomic<float> attackMs { 1.0f };      // 0.01 to 50 ms
    std::atomic<float> holdMs { 50.0f };       // 0 to 500 ms
    std::atomic<float> releaseMs { 50.0f };    // 5 to 500 ms
    std::atomic<float> range { -80.0f };       // -80 to 0 dB (floor gain when gate is closed)

private:
    // Envelope state (stereo-linked, so one value)
    float envelopeLevel = 0.0f;
    int holdCounter = 0;
    float currentGain = 0.0f;  // 0 = fully closed, 1 = fully open

    // Cached coefficients
    float attackCoeff = 0.0f;
    float releaseCoeff = 0.0f;
    int holdSamples = 0;
    float thresholdLinear = 0.0f;
    float rangeGain = 0.0f;

    double cachedSampleRate = 44100.0;

    void updateCoefficients();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Gate)
};

//==============================================================================
/**
 * S13Limiter — Brickwall limiter with ceiling control.
 *
 * Uses juce::dsp::Limiter for the core limiting with an additional ceiling
 * parameter that scales the output to ensure no sample exceeds the ceiling level.
 */
class S13Limiter : public S13BuiltInEffect
{
public:
    S13Limiter();
    ~S13Limiter() override = default;

    const juce::String getName() const override { return "S13 Limiter"; }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // ---- Parameters ----
    std::atomic<float> threshold { -1.0f };    // -20 to 0 dB
    std::atomic<float> releaseMs { 100.0f };   // 10 to 500 ms
    std::atomic<float> ceiling { 0.0f };       // -3 to 0 dB

private:
    juce::dsp::Limiter<float> limiter;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCeiling;
    double cachedSampleRate = 44100.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Limiter)
};
