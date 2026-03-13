#pragma once

#include <JuceHeader.h>
#include <array>
#include <mutex>

//==============================================================================
/**
 * Base class for all Studio13 built-in effects.
 */
class S13BuiltInEffect : public juce::AudioProcessor
{
public:
    S13BuiltInEffect();
    ~S13BuiltInEffect() override = default;

    bool isS13BuiltIn() const { return true; }

    // ---- AudioProcessor boilerplate ----
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;

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

    void setOversamplingEnabled(bool enabled);
    bool isOversamplingEnabled() const { return oversamplingEnabled; }

    // Gain reduction metering (for compressor, gate, limiter)
    float getGainReductionDB() const { return gainReductionDB.load(); }

protected:
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    bool oversamplingEnabled = false;
    std::atomic<float> gainReductionDB { 0.0f };

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13BuiltInEffect)
};

//==============================================================================
/**
 * S13EQ -- 8-band parametric EQ with selectable filter types per band.
 *
 * Each band: Bell, Low Shelf, High Shelf, Low Cut, High Cut, Notch, Band Pass.
 * Slopes for cut/shelf: 6, 12, 24, 48 dB/oct.
 * Includes FFT spectrum analyzer data output.
 */
class S13EQ : public S13BuiltInEffect
{
public:
    S13EQ();
    ~S13EQ() override = default;

    const juce::String getName() const override { return "S13 EQ"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // Filter types
    enum class FilterType : int
    {
        Bell = 0, LowShelf, HighShelf, LowCut, HighCut, Notch, BandPass
    };

    // Slope options for cut/shelf filters
    enum class FilterSlope : int
    {
        dB6 = 0, dB12, dB24, dB48
    };

    static constexpr int numBands = 8;

    struct BandParams
    {
        std::atomic<float> enabled { 1.0f };    // 0 = bypassed, 1 = active
        std::atomic<float> type { 0.0f };       // FilterType as float
        std::atomic<float> freq { 1000.0f };    // Hz (20-20000)
        std::atomic<float> gain { 0.0f };       // dB (-30 to +30)
        std::atomic<float> q { 1.0f };          // 0.1 to 30.0
        std::atomic<float> slope { 1.0f };      // FilterSlope as float (for cut/shelf)
    };
    std::array<BandParams, numBands> bands;

    std::atomic<float> outputGain { 0.0f };    // dB (-12 to +12)
    std::atomic<float> autoGain { 0.0f };      // 0 = off, 1 = on

    // Spectrum analyzer data
    static constexpr int fftOrder = 11;        // 2048-point FFT
    static constexpr int fftSize = 1 << fftOrder;

    struct SpectrumData
    {
        std::array<float, fftSize / 2> preEQ {};
        std::array<float, fftSize / 2> postEQ {};
        bool ready = false;
    };
    SpectrumData getSpectrumData() const;

    // Get magnitude response at given frequencies (for drawing the EQ curve)
    std::vector<float> getMagnitudeResponse(const std::vector<float>& frequencies) const;

private:
    static constexpr int maxStagesPerBand = 4; // for 48 dB/oct cascaded biquads
    using StereoIIR = juce::dsp::ProcessorDuplicator<juce::dsp::IIR::Filter<float>,
                                                      juce::dsp::IIR::Coefficients<float>>;

    StereoIIR bandFilters[numBands][maxStagesPerBand];
    int activeStages[numBands] = {};

    double cachedSampleRate = 44100.0;

    void updateFilters();
    void updateBand(int bandIndex);
    int getNumStagesForSlope(FilterSlope slope) const;

    // FFT for spectrum analyzer
    juce::dsp::FFT fft { fftOrder };
    juce::dsp::WindowingFunction<float> window { fftSize, juce::dsp::WindowingFunction<float>::hann };

    std::array<float, fftSize> preEQBuffer {};
    std::array<float, fftSize> postEQBuffer {};
    int fftWritePos = 0;

    mutable std::mutex spectrumMutex;
    SpectrumData spectrumOutput;
    int fftBlockCounter = 0;
    static constexpr int fftUpdateInterval = 4;

    void computeSpectrum(const std::array<float, fftSize>& input, std::array<float, fftSize / 2>& output);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13EQ)
};

//==============================================================================
/**
 * S13Compressor -- Multi-style feed-forward compressor.
 *
 * Styles: Clean, Punch, Opto, FET, VCA.
 * Includes dry/wet for parallel compression, sidechain HPF, lookahead,
 * and real-time gain reduction output.
 */
class S13Compressor : public S13BuiltInEffect
{
public:
    S13Compressor();
    ~S13Compressor() override = default;

    const juce::String getName() const override { return "S13 Compressor"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    enum class Style : int { Clean = 0, Punch, Opto, FET, VCA };

    std::atomic<float> threshold { 0.0f };     // -60 to 0 dB
    std::atomic<float> ratio { 1.0f };         // 1:1 to 20:1
    std::atomic<float> attack { 10.0f };       // 0.1 to 100 ms
    std::atomic<float> release { 100.0f };     // 10 to 2000 ms
    std::atomic<float> knee { 0.0f };          // 0 to 24 dB
    std::atomic<float> makeupGain { 0.0f };    // 0 to 36 dB
    std::atomic<float> mix { 1.0f };           // 0-1 (parallel compression)
    std::atomic<float> style { 0.0f };         // Style as float
    std::atomic<float> autoMakeup { 0.0f };    // 0 = off, 1 = on
    std::atomic<float> autoRelease { 0.0f };   // 0 = off, 1 = on
    std::atomic<float> sidechainHPF { 20.0f }; // 20-500 Hz
    std::atomic<float> lookaheadMs { 0.0f };   // 0-20 ms

    // Metering
    float getCurrentGainReduction() const { return gainReductionDB.load(); }
    float getInputLevel() const { return inputLevelDB.load(); }
    float getOutputLevel() const { return outputLevelDB.load(); }

private:
    float envelopeLevel = 0.0f;
    float currentGainLin = 1.0f;

    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMakeup;
    double cachedSampleRate = 44100.0;

    juce::dsp::IIR::Filter<float> scHPF_L;
    juce::dsp::IIR::Filter<float> scHPF_R;
    float lastSCHPFFreq = 20.0f;

    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> lookaheadDelayL { 2048 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> lookaheadDelayR { 2048 };

    std::atomic<float> inputLevelDB { -100.0f };
    std::atomic<float> outputLevelDB { -100.0f };

    float computeGain(float inputDB) const;
    void getStyleBallistics(float& atkMs, float& relMs) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Compressor)
};

//==============================================================================
/**
 * S13Gate -- Noise gate with hold, range, hysteresis, sidechain filter.
 */
class S13Gate : public S13BuiltInEffect
{
public:
    S13Gate();
    ~S13Gate() override = default;

    const juce::String getName() const override { return "S13 Gate"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    std::atomic<float> threshold { -40.0f };   // -80 to 0 dB
    std::atomic<float> attackMs { 1.0f };      // 0.01 to 50 ms
    std::atomic<float> holdMs { 50.0f };       // 0 to 500 ms
    std::atomic<float> releaseMs { 50.0f };    // 5 to 2000 ms
    std::atomic<float> range { -80.0f };       // -80 to 0 dB
    std::atomic<float> hysteresis { 0.0f };    // 0 to 20 dB
    std::atomic<float> sidechainHPF { 20.0f }; // 20-2000 Hz
    std::atomic<float> sidechainLPF { 20000.0f }; // 200-20000 Hz
    std::atomic<float> mix { 1.0f };           // 0-1

    bool isGateOpen() const { return gateOpen.load(); }

private:
    float envelopeLevel = 0.0f;
    int holdCounter = 0;
    float currentGain = 0.0f;
    std::atomic<bool> gateOpen { false };

    float attackCoeff = 0.0f;
    float releaseCoeff = 0.0f;
    int holdSamples = 0;
    float thresholdLinear = 0.0f;
    float closeThresholdLinear = 0.0f;
    float rangeGain = 0.0f;

    juce::dsp::IIR::Filter<float> scHPF_L, scHPF_R;
    juce::dsp::IIR::Filter<float> scLPF_L, scLPF_R;

    double cachedSampleRate = 44100.0;

    void updateCoefficients();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Gate)
};

//==============================================================================
/**
 * S13Limiter -- Brickwall limiter with ceiling and lookahead.
 */
class S13Limiter : public S13BuiltInEffect
{
public:
    S13Limiter();
    ~S13Limiter() override = default;

    const juce::String getName() const override { return "S13 Limiter"; }
    juce::AudioProcessorEditor* createEditor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    std::atomic<float> threshold { -1.0f };    // -20 to 0 dB
    std::atomic<float> releaseMs { 100.0f };   // 10 to 500 ms
    std::atomic<float> ceiling { 0.0f };       // -3 to 0 dB
    std::atomic<float> lookaheadMs { 5.0f };   // 0 to 20 ms

private:
    juce::dsp::Limiter<float> limiter;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCeiling;
    double cachedSampleRate = 44100.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Limiter)
};
