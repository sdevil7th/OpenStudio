#pragma once

#include <JuceHeader.h>
#include <atomic>

// ============================================================================
// S13Delay -- Stereo delay with tempo sync, ping-pong, feedback processing
// ============================================================================
class S13Delay : public juce::AudioProcessor
{
public:
    S13Delay();
    ~S13Delay() override = default;

    // Parameters
    std::atomic<float> delayTimeL { 250.0f };   // 1-2000 ms
    std::atomic<float> delayTimeR { 250.0f };   // 1-2000 ms
    std::atomic<float> feedback   { 0.4f };     // 0-0.95
    std::atomic<float> crossFeed  { 0.0f };     // 0-0.95 (cross-channel feedback)
    std::atomic<float> mix        { 0.5f };     // 0-1
    std::atomic<float> pingPong   { 0.0f };     // 0 = off, 1 = on
    std::atomic<float> tempoSync  { 0.0f };     // 0 = off, 1 = on
    std::atomic<float> syncNoteL  { 0.0f };     // index into note table
    std::atomic<float> syncNoteR  { 0.0f };     // index into note table
    std::atomic<float> lpfFreq    { 20000.0f }; // 200-20000 Hz feedback LPF
    std::atomic<float> hpfFreq    { 20.0f };    // 20-2000 Hz feedback HPF
    std::atomic<float> fbSaturation { 0.0f };   // 0-1 feedback saturation amount
    std::atomic<float> stereoWidth  { 1.0f };   // 0-2 stereo width
    std::atomic<float> delayMode    { 0.0f };   // 0=Digital, 1=Tape, 2=Analog

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Delay"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 2.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}



    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }

private:
    static constexpr int maxDelaySamples = 192001;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineL { maxDelaySamples };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineR { maxDelaySamples };

    juce::dsp::IIR::Filter<float> feedbackLPF_L, feedbackLPF_R;
    juce::dsp::IIR::Filter<float> feedbackHPF_L, feedbackHPF_R;

    float feedbackSampleL = 0.0f;
    float feedbackSampleR = 0.0f;

    double cachedSampleRate = 44100.0;
    float lastLPFFreq = 20000.0f;
    float lastHPFFreq = 20.0f;

    static float syncNoteToMs(float noteIndex, double bpm);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Delay)
};


// ============================================================================
// S13Reverb -- Multi-algorithm reverb
// ============================================================================
class S13Reverb : public juce::AudioProcessor
{
public:
    S13Reverb();
    ~S13Reverb() override = default;

    // Algorithm selector
    enum class Algorithm : int { Room = 0, Hall, Plate, Chamber, Shimmer };

    // Parameters
    std::atomic<float> algorithm  { 0.0f };    // Algorithm as float
    std::atomic<float> roomSize   { 0.5f };    // 0-1
    std::atomic<float> damping    { 0.5f };    // 0-1
    std::atomic<float> wetLevel   { 0.33f };   // 0-1
    std::atomic<float> dryLevel   { 0.7f };    // 0-1
    std::atomic<float> width      { 1.0f };    // 0-1
    std::atomic<float> freezeMode { 0.0f };    // 0 = off, 1 = on
    std::atomic<float> preDelay   { 0.0f };    // 0-500 ms
    std::atomic<float> diffusion  { 0.5f };    // 0-1
    std::atomic<float> lowCut     { 20.0f };   // 20-500 Hz
    std::atomic<float> highCut    { 20000.0f }; // 1000-20000 Hz
    std::atomic<float> earlyLevel { 0.5f };    // 0-1 early reflections level
    std::atomic<float> decayTime  { 2.0f };    // 0.1-20 seconds

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Reverb"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 3.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}



    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }

private:
    juce::dsp::Reverb reverb;

    // Pre-delay
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> preDelayLineL { 48000 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> preDelayLineR { 48000 };

    // Tone filters on wet signal
    juce::dsp::IIR::Filter<float> wetLowCutL, wetLowCutR;
    juce::dsp::IIR::Filter<float> wetHighCutL, wetHighCutR;

    double cachedSampleRate = 44100.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Reverb)
};


// ============================================================================
// S13Chorus -- Modulation suite: Chorus / Flanger / Phaser
// ============================================================================
class S13Chorus : public juce::AudioProcessor
{
public:
    S13Chorus();
    ~S13Chorus() override = default;

    enum class Mode : int { Chorus = 0, Flanger, Phaser };
    enum class LFOShape : int { Sine = 0, Triangle, Square, SampleAndHold };

    // Parameters
    std::atomic<float> mode     { 0.0f };    // Mode as float
    std::atomic<float> rate     { 1.0f };    // 0.01-20 Hz LFO rate
    std::atomic<float> depth    { 0.5f };    // 0-1
    std::atomic<float> fbAmount { 0.0f };    // -1 to 1 (feedback)
    std::atomic<float> mix      { 0.5f };    // 0-1
    std::atomic<float> voices   { 2.0f };    // 1-6
    std::atomic<float> lfoShape { 0.0f };    // LFOShape as float
    std::atomic<float> spread   { 0.5f };    // 0-1 stereo spread
    std::atomic<float> highCut  { 20000.0f }; // 200-20000 Hz wet signal
    std::atomic<float> lowCut   { 20.0f };    // 20-2000 Hz wet signal
    std::atomic<float> tempoSync { 0.0f };   // 0 = off, 1 = on

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Chorus"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
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

    bool isS13BuiltIn() const { return true; }

private:
    static constexpr int maxVoices = 6;
    static constexpr int maxChorusDelaySamples = 8192;

    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLines[2][maxVoices];
    float lfoPhase[maxVoices] = {};
    float feedbackState[2] = {};

    // Phaser all-pass filters (up to 12 stages per channel)
    static constexpr int maxPhaserStages = 12;
    juce::dsp::IIR::Filter<float> allpassL[maxPhaserStages];
    juce::dsp::IIR::Filter<float> allpassR[maxPhaserStages];

    double cachedSampleRate = 44100.0;

    float getLFOValue(float phase, LFOShape shape) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Chorus)
};


// ============================================================================
// S13Saturator -- Multi-type saturation / distortion
// ============================================================================
class S13Saturator : public juce::AudioProcessor
{
public:
    S13Saturator();
    ~S13Saturator() override = default;

    enum class SatType : int { Tape = 0, Tube, Transistor, Clip, Crush };

    // Parameters
    std::atomic<float> satType    { 0.0f };     // SatType as float
    std::atomic<float> drive      { 6.0f };     // 0-30 dB
    std::atomic<float> mix        { 1.0f };     // 0-1
    std::atomic<float> toneFreq   { 20000.0f }; // 200-20000 Hz post-sat LPF
    std::atomic<float> outputGain { 0.0f };     // -12 to 0 dB
    std::atomic<float> asymmetry  { 0.0f };     // -1 to 1 (asymmetric clipping)
    std::atomic<float> oversampleMode { 1.0f }; // 0=off, 1=2x, 2=4x

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Saturator"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
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

    bool isS13BuiltIn() const { return true; }

    void setOversamplingEnabled(bool enabled) { oversamplingEnabled = enabled; }
    bool isOversamplingEnabled() const { return oversamplingEnabled; }

private:
    juce::dsp::IIR::Filter<float> toneFilterL, toneFilterR;
    double cachedSampleRate = 44100.0;
    float lastToneFreq = 20000.0f;

    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    bool oversamplingEnabled = false;

    // Saturation functions per type
    float processSample(float input, float driveLinear, SatType type, float asym) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Saturator)
};
