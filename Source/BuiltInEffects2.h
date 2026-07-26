#pragma once

#include <JuceHeader.h>
#include "BuiltInEffects.h"
#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif
#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace nam
{
class DSP;
}

class AudioEngine;

// ============================================================================
// S13Delay -- Stereo delay with tempo sync, ping-pong, feedback processing
// ============================================================================
class S13Delay : public juce::AudioProcessor
{
public:
    explicit S13Delay(float maximumSupportedDelaySeconds = 24.1f);
    ~S13Delay() override = default;
    float getMaximumSupportedDelaySeconds() const noexcept { return maximumDelaySeconds; }

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
    std::atomic<float> ducking      { 0.0f };   // 0-1 input ducking amount
    // Runtime-only rack controls. They are intentionally not serialized:
    // inputSend=0 lets an existing tail drain without recording new input,
    // while unityDry=1 keeps bypass sample-transparent during spillover.
    std::atomic<float> inputSend     { 1.0f };
    std::atomic<float> unityDry      { 0.0f };

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
    double getTailLengthSeconds() const override;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}



    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }
    void resetTailState() noexcept;

private:
    float maximumDelaySeconds = 24.1f;
    int maxDelaySamples = 2;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineL { 1 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineR { 1 };

    juce::dsp::IIR::Filter<float> feedbackLPF_L, feedbackLPF_R;
    juce::dsp::IIR::Filter<float> feedbackHPF_L, feedbackHPF_R;

    float feedbackSampleL = 0.0f;
    float feedbackSampleR = 0.0f;
    float smoothedDelaySamplesL = 0.0f;
    float smoothedDelaySamplesR = 0.0f;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDryGain;
    float duckEnvelope = 0.0f;
    float modulationPhase = 0.0f;
    int validHistorySamples = 0;

    double cachedSampleRate = 44100.0;
    float lastLPFFreq = 20000.0f;
    float lastHPFFreq = 20.0f;
    std::vector<S13IIRCoefficientSet> feedbackLPFCoefficientLut;
    std::vector<S13IIRCoefficientSet> feedbackHPFCoefficientLut;

    static float syncNoteToMs(float noteIndex, double bpm);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Delay)
};


// ============================================================================
// S13OctaveShimmerShifter -- low-cost dual-grain +12 semitone shifter
// ============================================================================
class S13OctaveShimmerShifter
{
public:
    void prepare(double sampleRate);
    void reset() noexcept;
    float processSample(float input) noexcept;

private:
    std::vector<float> delayBuffer;
    int writeIndex = 0;
    int validHistorySamples = 0;
    int grainWindowSamples = 1;
    float minimumDelaySamples = 1.0f;
    float grainPhase = 0.0f;
    float grainPhaseIncrement = 0.0f;
    float highPassState = 0.0f;
    float lowPassState = 0.0f;
    float highPassCoefficient = 1.0f;
    float lowPassCoefficient = 1.0f;

    float readFractionalDelay(float delaySamples) const noexcept;
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
    enum class Algorithm : int { Room = 0, Hall, Plate, Chamber };

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
    // Internal until the native pitch, stability, zero-equivalence, latency,
    // and CPU gates pass. The NAM rack does not expose this parameter yet.
    std::atomic<float> shimmerAmount { 0.0f }; // 0-1, +12 semitone reinjection
    // Runtime-only rack send. Zero drains the existing reverb without feeding
    // live input into the early reflections, pre-delay, or late tank.
    std::atomic<float> inputSend   { 1.0f };

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
    double getTailLengthSeconds() const override;

    // Shared by the standalone processor and the NAM rack so offline export and
    // freeze use the same conservative -60 dB tail estimate as the actual FDN.
    static double calculateTailLengthSeconds(int algorithmIndex,
                                             float roomSizeValue,
                                             float wetLevelValue,
                                             float earlyLevelValue,
                                             bool freezeEnabled,
                                             float preDelayMs,
                                             float decaySeconds,
                                             double sampleRate);

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}



    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }
    void resetTailState() noexcept;

private:
    juce::dsp::Reverb reverb;
    static constexpr int lateLineCount = 8;

    // Pre-delay
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> preDelayLineL { 48000 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> preDelayLineR { 48000 };

    // Tone filters on wet signal
    juce::dsp::IIR::Filter<float> wetLowCutL, wetLowCutR;
    juce::dsp::IIR::Filter<float> wetHighCutL, wetHighCutR;
    float lastLowCut = 20.0f;
    float lastHighCut = 20000.0f;
    std::vector<S13IIRCoefficientSet> lowCutCoefficientLut;
    std::vector<S13IIRCoefficientSet> highCutCoefficientLut;

    juce::AudioBuffer<float> dryBuffer;
    juce::AudioBuffer<float> earlyReflectionBuffer;
    juce::AudioBuffer<float> earlyOutputBuffer;
    int earlyReflectionWriteIndex = 0;
    juce::AudioBuffer<float> lateTankBuffer;
    int lateTankWriteIndex = 0;
    std::array<float, lateLineCount> lateDampingState {};
    std::array<float, lateLineCount> lateModPhase {};
    S13OctaveShimmerShifter shimmerShifter;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedShimmerAmount;
    int validEarlyHistorySamples = 0;
    int validPreDelayHistorySamples = 0;
    int validLateHistorySamples = 0;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedWetLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDryLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedEarlyLevel;
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
    std::atomic<float> characterMode { 0.0f }; // 0=Clean, 1=Ensemble, 2=BBD
    std::atomic<float> randomBlend { 0.0f };  // 0=smooth LFO, 1=sample-and-hold
    std::atomic<float> mixLaw { 1.0f };       // 0=legacy linear, 1=equal-power
    // Runtime-only rack send. Zero lets the wet path fade on bypass without
    // recording new live input into the modulation state.
    std::atomic<float> inputSend { 1.0f };

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
    double getTailLengthSeconds() const override;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}



    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }
    void resetTailState() noexcept;

private:
    static constexpr int maxVoices = 6;
    static constexpr int maxChorusDelaySamples = 8192;
    static constexpr int chorusDelayBufferSize =
        maxChorusDelaySamples + 4;

    std::array<std::vector<float>, 2> delayBuffers;
    int delayWritePosition = 0;
    float lfoPhase[maxVoices] = {};
    std::array<float, maxVoices> sampleHoldValue {};
    std::array<float, maxVoices> sampleHoldTarget {};
    std::uint32_t sampleHoldRandomState = 0x8f6a2c1du;
    std::uint64_t characterNoiseSample = 0;
    float sampleHoldSlewCoefficient = 1.0f;
    float feedbackState[2] = {};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    int validDelayHistorySamples = 0;

    // Phaser all-pass filters (up to 12 stages per channel)
    static constexpr int maxPhaserStages = 12;
    juce::dsp::IIR::Filter<float> allpassL[maxPhaserStages];
    juce::dsp::IIR::Filter<float> allpassR[maxPhaserStages];
    std::array<float, maxPhaserStages> phaserStateL {};
    std::array<float, maxPhaserStages> phaserStateR {};
    juce::dsp::IIR::Filter<float> wetLowCutL, wetLowCutR;
    juce::dsp::IIR::Filter<float> wetHighCutL, wetHighCutR;
    float lastLowCut = 20.0f;
    float lastHighCut = 20000.0f;
    std::vector<S13IIRCoefficientSet> lowCutCoefficientLut;
    std::vector<S13IIRCoefficientSet> highCutCoefficientLut;

    double cachedSampleRate = 44100.0;

    float getLFOValue(float phase, LFOShape shape, int voice) const;
    float readDelayTap(int channel, float delaySamples) const noexcept;
    void advanceLFO(int voice, float phaseIncrement) noexcept;
    float nextSampleAndHoldValue() noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Chorus)
};


// ============================================================================
// S13Saturator -- Multi-type saturation / distortion
// ============================================================================
class S13Saturator : public juce::AudioProcessor
{
public:
    explicit S13Saturator(bool useLowLatencyOversampling = false);
    ~S13Saturator() override = default;

    enum class SatType : int
    {
        Tape = 0,
        Tube,
        Transistor,
        Clip,
        Crush,
        Console,
        Transformer,
        Foldback,
        DiodeClipper
    };

    // Parameters
    std::atomic<float> satType    { 0.0f };     // SatType as float
    std::atomic<float> drive      { 6.0f };     // 0-30 dB
    std::atomic<float> mix        { 1.0f };     // 0-1
    std::atomic<float> toneFreq   { 20000.0f }; // 200-20000 Hz post-sat LPF
    std::atomic<float> lowCutFreq { 20.0f };    // 20-1000 Hz post-sat HPF
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

    void setOversamplingEnabled(bool enabled);
    bool isOversamplingEnabled() const
    {
        return oversamplingEnabled.load(std::memory_order_relaxed);
    }
    void setOversamplingMode(float mode);
    int getActiveOversamplingMode() const noexcept
    {
        return activeOversamplingMode.load(std::memory_order_relaxed);
    }
    int getOversamplingLatencySamples() const noexcept
    {
        return activeOversamplingLatencySamples.load(
            std::memory_order_relaxed);
    }
    void setLowCutBeforeSaturation(bool enabled) noexcept
    {
        lowCutBeforeSaturation = enabled;
    }

private:
    static constexpr int maximumOversamplingLatencySamples = 512;
    juce::dsp::IIR::Filter<float> toneFilterL, toneFilterR;
    juce::dsp::IIR::Filter<float> lowCutFilterL, lowCutFilterR;
    double cachedSampleRate = 44100.0;
    int cachedBlockSize = 0;
    float lastToneFreq = 20000.0f;
    float lastLowCutFreq = 20.0f;
    std::vector<S13IIRCoefficientSet> toneCoefficientLut;
    std::vector<S13IIRCoefficientSet> lowCutCoefficientLut;
    bool lowCutBeforeSaturation = false;
    bool useLowLatencyOversampling = false;

    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler2x;
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler4x;
    std::atomic<bool> oversamplingEnabled { true };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        oversamplingDryDelay { maximumOversamplingLatencySamples };
    juce::AudioBuffer<float> oversamplingDryBuffer;
    std::atomic<int> activeOversamplingMode { 0 };
    std::atomic<int> activeOversamplingLatencySamples { 0 };
    bool oversamplingPrepared = false;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDriveGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedOutputGain;
    float lastDriveDbTarget = -1.0f;
    float lastMixTarget = -1.0f;
    float lastOutputDbTarget = 999.0f;
    std::array<juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>, 2>
        smoothedDiodeMode;
    std::array<float, 2> diodeCapacitorState {};
    float diodeCapacitorConductance = 0.0f;

    int getRequestedOversamplingMode() const noexcept;
    void updateOversamplingConfiguration(bool resetProcessingState);

    // Saturation functions per type
    float processSample(
        float input,
        float driveLinear,
        SatType type,
        float asym,
        int channel);
    void lookupDiodeCurve(
        float exponent,
        float& sinhValue,
        float& coshValue) const noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13Saturator)
};

// ============================================================================
// S13NAMRack -- Native Neural Amp Modeler rack with OpenStudio wrapper controls
// ============================================================================
class S13NAMRack : public juce::AudioProcessor
{
public:
    S13NAMRack();
    ~S13NAMRack() override = default;

    std::atomic<float> inputTrimDb { 0.0f };
    std::atomic<float> inputMode { 0.0f };
    // Retained only to deserialize old rack snapshots safely. Live NAM
    // transpose is retired and this value is always forced to zero.
    std::atomic<float> transposeSemitones { 0.0f };
    std::atomic<float> calibrationReferenceDbu { 12.0f };
    std::atomic<float> pedalCalibrationMode { 1.0f };
    std::atomic<float> pedalOverrideInputLevelDbu { 12.0f };
    std::atomic<float> pedalOverrideOutputLevelDbu { 12.0f };
    std::atomic<float> ampCalibrationMode { 1.0f };
    std::atomic<float> ampOverrideInputLevelDbu { 12.0f };
    std::atomic<float> ampOverrideOutputLevelDbu { 12.0f };
    std::atomic<float> gateThresholdDb { -80.0f };
    std::atomic<float> gateReleaseMs { 80.0f };
    std::atomic<float> compressorEnabled { 0.0f };
    std::atomic<float> compressorDetail { 0.55f };
    std::atomic<float> compressorMix { 0.65f };
    std::atomic<float> compressorVolumeDb { 0.0f };
    std::atomic<float> compressorComp { 0.35f };
    std::atomic<float> tapeEchoEnabled { 0.0f };
    std::atomic<float> tapeEchoMix { 0.28f };
    std::atomic<float> tapeEchoTimeMs { 360.0f };
    std::atomic<float> tapeEchoFeedback { 0.28f };
    std::atomic<float> tapeEchoMod { 0.18f };
    std::atomic<float> tapeEchoTone { 0.58f };
    std::atomic<float> octaverEnabled { 0.0f };
    std::atomic<float> octaverDownMix { 0.32f };
    std::atomic<float> octaverUpMix { 0.18f };
    std::atomic<float> octaverDirectMix { 1.0f };
    std::atomic<float> precisionDriveEnabled { 0.0f };
    std::atomic<float> precisionDriveVolumeDb { 0.0f };
    std::atomic<float> precisionDriveBright { 0.55f };
    std::atomic<float> precisionDriveAttack { 0.50f };
    std::atomic<float> precisionDriveGate { 0.0f };
    std::atomic<float> precisionDriveDrive { 0.35f };
    // Legacy project-state field. Distortion is now its own dedicated
    // high-gain pedal and Precision Drive always uses its transistor circuit.
    std::atomic<float> precisionDriveMode { 0.0f };
    std::atomic<float> chaosEnabled { 0.0f };
    // Legacy state field only. The product exposes one fixed high-gain
    // Distortion circuit and always pins this to zero.
    std::atomic<float> chaosMode { 0.0f };
    std::atomic<float> chaosDrive { 0.62f };
    std::atomic<float> chaosTone { 0.55f };
    std::atomic<float> chaosMix { 1.0f };
    std::atomic<float> chaosLevelDb { 0.0f };
    std::atomic<float> laserEnabled { 0.0f };
    std::atomic<float> laserMode { 0.0f };
    std::atomic<float> laserMix { 0.35f };
    std::atomic<float> laserSpeedHz { 1.2f };
    std::atomic<float> laserSensitivity { 0.45f };
    std::atomic<float> laserEnvelopeMode { 0.0f };
    std::atomic<float> laserTrigger { 0.0f };
    std::atomic<float> pedalMix { 1.0f };
    std::atomic<float> ampEnabled { 1.0f };
    std::atomic<float> ampGainDb { 0.0f };
    std::atomic<float> ampBoost { 0.0f };
    std::atomic<float> ampVoice { 0.0f };
    std::atomic<float> ampMix { 1.0f };
    std::atomic<float> ampOutputDb { 0.0f };
    std::atomic<float> bassDb { 0.0f };
    std::atomic<float> midDb { 0.0f };
    std::atomic<float> trebleDb { 0.0f };
    std::atomic<float> presenceDb { 0.0f };
    std::atomic<float> eq65Db { 0.0f };
    std::atomic<float> eq125Db { 0.0f };
    std::atomic<float> eq250Db { 0.0f };
    std::atomic<float> eq500Db { 0.0f };
    std::atomic<float> eq1kDb { 0.0f };
    std::atomic<float> eq2kDb { 0.0f };
    std::atomic<float> eq4kDb { 0.0f };
    std::atomic<float> eq8kDb { 0.0f };
    std::atomic<float> eq16kDb { 0.0f };
    std::atomic<bool> cabRequestedEnabled { false };
    std::atomic<float> cabEnabled { 0.0f };
    std::atomic<float> cabLevelDb { 0.0f };
    std::atomic<float> cabHPFHz { 80.0f };
    std::atomic<float> cabLPFHz { 8500.0f };
    std::atomic<float> cabPhaseInvert { 0.0f };
    std::atomic<float> cabMicPosition { 0.5f };
    std::atomic<float> cabMicDistance { 0.0f };
    std::atomic<float> cabMicBlend { 0.5f };
    std::atomic<float> cabRoomSend { 0.0f };
    std::atomic<float> cabPan { 0.0f };
    std::atomic<float> eqEnabled { 0.0f };
    std::atomic<float> chorusMix { 0.30f };
    std::atomic<float> chorusRateHz { 0.75f };
    std::atomic<float> chorusDepth { 0.32f };
    std::atomic<float> chorusCharacter { 1.0f }; // 0=Clean, 1=Ensemble, 2=BBD
    std::atomic<float> modulatorMode { 0.0f };
    std::atomic<float> modulatorFeedback { 0.10f };
    std::atomic<float> modulatorAutoRandom { 0.0f };
    std::atomic<float> modulatorAutoSpeed { 0.35f };
    std::atomic<float> modulatorEnabled { 0.0f };
    std::atomic<float> modulatorPedalMode { 1.0f };
    std::atomic<float> modulatorPedalPosition { 0.5f };
    std::atomic<float> delayMix { 0.22f };
    std::atomic<float> delayTimeMs { 360.0f };
    std::atomic<float> delayFeedback { 0.22f };
    std::atomic<float> delayMod { 0.18f };
    std::atomic<float> delayDucker { 0.12f };
    std::atomic<float> delayMode { 1.0f };
    std::atomic<float> delayPingPong { 1.0f };
    std::atomic<float> delayTempoSync { 0.0f };
    std::atomic<float> delayEnabled { 0.0f };
    std::atomic<float> reverbMix { 0.28f };
    std::atomic<float> reverbDecaySec { 2.2f };
    std::atomic<float> reverbTone { 0.62f };
    std::atomic<float> reverbPreDelayMs { 18.0f };
    std::atomic<float> reverbLowCutHz { 120.0f };
    std::atomic<float> reverbShimmer { 0.0f };
    std::atomic<float> reverbEnabled { 0.0f };
    std::atomic<float> outputTrimDb { 0.0f };
    std::atomic<float> auditionSource { 0.0f };
    std::atomic<float> inputLevelDb { -90.0f };
    std::atomic<float> outputLevelDb { -90.0f };

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override;

    const juce::String getName() const override { return "OpenStudio NAM Rack"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override;
    enum TailAutomationModule : std::uint32_t
    {
        tailAutomationNone = 0,
        tailAutomationTapeEcho = 1u << 0,
        tailAutomationDelay = 1u << 1,
        tailAutomationReverb = 1u << 2,
        tailAutomationModulator = 1u << 4,
        tailAutomationCab = 1u << 5
    };
    double getAutomatedTailLengthSeconds(std::uint32_t moduleMask) const;
    double getMaximumAutomatedTailLengthSeconds() const;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    void getTonePresetStateInformation(juce::MemoryBlock& destData);
    bool restoreTonePresetStateInformation(
        const void* data,
        int sizeInBytes,
        const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {});
    bool restoreProjectStateInformation(
        const void* data,
        int sizeInBytes,
        const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {},
        std::shared_ptr<void>* retainedPublicationLease = nullptr);
    bool restoreRenderPassStateInformation(const void* data, int sizeInBytes);
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }
    void resetTailState() noexcept;

    void setTransposeSemitones(float legacySemitones) noexcept;

    bool loadPedalModel(const juce::String& path);
    bool loadAmpModel(const juce::String& path);
    void clearPedalModel();
    void clearAmpModel();
    juce::String getPedalModelPath() const;
    juce::String getAmpModelPath() const;
    juce::String getLastLoadError() const;
    bool hasPedalModel() const;
    bool hasAmpModel() const;
    juce::String getPedalCaptureType() const;
    juce::String getAmpCaptureType() const;
    juce::String getPedalMetadataCaptureType() const;
    juce::String getAmpMetadataCaptureType() const;
    juce::String getPedalDeclaredCaptureType() const;
    juce::String getAmpDeclaredCaptureType() const;
    bool ampModelIncludesCab() const;
    juce::var getPedalCalibrationState() const;
    juce::var getAmpCalibrationState() const;
    void setCabRequestedEnabled(bool enabled) noexcept;
    bool isCabRequestedEnabled() const noexcept;
    uint64_t getModelSnapshotLockMissCount() const noexcept;
    void resetModelSnapshotLockMissCount() noexcept;
    bool hasAuditionSourceActive() const noexcept;
    juce::var getDiagnosticState() const;
    bool loadCabIR(const juce::String& path);
    void clearCabIR();
    juce::String getCabIRPath() const;
    bool hasCabIR() const;
    bool restoreModelResourceState(bool pedalPathSpecified,
                                   const juce::String& pedalPath,
                                   bool ampPathSpecified,
                                   const juce::String& ampPath,
                                   bool cabPathSpecified,
                                   const juce::String& cabPath,
                                   bool applySessionCabAutoBypass = false,
                                   bool allowMissingResources = false,
                                   bool pedalDeclaredCaptureTypeSpecified = false,
                                   const juce::String& pedalDeclaredCaptureType = {},
                                   bool ampDeclaredCaptureTypeSpecified = false,
                                   const juce::String& ampDeclaredCaptureType = {},
                                   const std::function<void()>& publishAdditionalState = {},
                                   const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {},
                                   std::shared_ptr<void>* retainedPublicationLease = nullptr);
    void setUiStateJSON(const juce::String& json);
    juce::String getUiStateJSON() const;

private:
    friend class AudioEngine;

    static constexpr int namResamplerKernelTaps = 48;
    static constexpr int namResamplerKernelPhases = 512;
    static constexpr int namResamplerHistorySize = 128;
    static constexpr int namResamplerDryDelayCapacity = 128;

    struct NAMResamplerKernel
    {
        double inputRate = 44100.0;
        double outputRate = 44100.0;
        double sourceStep = 1.0;
        std::array<float, static_cast<size_t>(namResamplerKernelTaps * namResamplerKernelPhases)> coefficients {};

        void prepare(double newInputRate, double newOutputRate) noexcept;
    };

    struct NAMResamplerState
    {
        std::array<float, static_cast<size_t>(namResamplerHistorySize)> history {};
        int writeIndex = 0;
        std::int64_t totalInputSamples = 0;
        double nextSourcePosition = 0.0;

        void reset() noexcept;
        int process(const float* input,
                    int numInputSamples,
                    float* output,
                    int outputCapacity,
                    const NAMResamplerKernel& kernel) noexcept;

    private:
        float sampleAt(std::int64_t absoluteIndex) const noexcept;
        float interpolate(double sourcePosition, const NAMResamplerKernel& kernel) const noexcept;
    };

    struct LoadedNAMModel
    {
        std::unique_ptr<nam::DSP> dsp;
        juce::String path;
        double expectedSampleRate = -1.0;
        double preparedHostSampleRate = 44100.0;
        int preparedHostBufferCapacity = 512;
        int inputChannels = 1;
        int outputChannels = 1;
        // File metadata is authoritative whenever it identifies a supported
        // capture type. Catalog/installed metadata is retained separately and
        // is only an effective fallback for older models whose metadata is
        // absent or unknown.
        juce::String captureType { "unknown" };
        juce::String declaredCaptureType { "unknown" };
        bool includesCab = false;
        bool hasInputLevelDbu = false;
        bool hasOutputLevelDbu = false;
        double inputLevelDbu = 0.0;
        double outputLevelDbu = 0.0;
        float currentInputCalibrationGain = 1.0f;
        float currentOutputCalibrationGain = 1.0f;
        std::atomic<bool> processFaulted { false };
        NAMResamplerKernel inputResamplerKernel;
        NAMResamplerKernel outputResamplerKernel;
        std::array<NAMResamplerState, 2> inputResamplers;
        std::array<NAMResamplerState, 2> outputResamplers;
        std::array<std::vector<float>, 2> resampledHostFifo;
        int resampledHostFifoCapacity = 0;
        int resampledHostFifoRead = 0;
        int resampledHostFifoSize = 0;
        std::array<std::array<float, static_cast<size_t>(namResamplerDryDelayCapacity)>, 2> resampledDryDelay {};
        int resampledDryDelaySamples = 0;
        int resampledDryDelayWrite = 0;
        // Amp power crossfades need an uncoloured bypass reference with the
        // same fixed resampler latency as the model path. Keep an independent
        // delay cursor so producing that reference never advances the NAM
        // core's dry-delay state twice.
        std::array<std::array<float, static_cast<size_t>(namResamplerDryDelayCapacity)>, 2> ampBypassDryDelay {};
        int ampBypassDryDelayWrite = 0;
        LoadedNAMModel* transitionFrom = nullptr;
        int transitionSamplesTotal = 0;
        std::atomic<int> transitionSamplesRemaining { 0 };

        juce::String effectiveCaptureType() const
        {
            return captureType != "unknown" ? captureType : declaredCaptureType;
        }
    };

    struct LoadedCabIR
    {
        juce::dsp::Convolution convolution;
        juce::String path;
        double durationSeconds = 0.0;
        double preparedHostSampleRate = 0.0;
        int preparedHostBlockSize = 0;
        int preparedIRSize = 0;
        LoadedCabIR* transitionFrom = nullptr;
        int transitionSamplesTotal = 0;
        std::atomic<int> transitionSamplesRemaining { 0 };
    };

    using ActiveNAMModelPointer = std::atomic<LoadedNAMModel*>;
    using ActiveCabIRPointer = std::atomic<LoadedCabIR*>;
    using NAMModelReaderCounter = std::atomic<std::uint32_t>;
    static_assert(ActiveNAMModelPointer::is_always_lock_free,
                  "Realtime NAM model pointers must be lock-free");
    static_assert(ActiveCabIRPointer::is_always_lock_free,
                  "Realtime cabinet IR pointers must be lock-free");
    static_assert(NAMModelReaderCounter::is_always_lock_free,
                  "Realtime NAM model reader accounting must be lock-free");

    // The shared owners are accessed only while holding modelSwapLock. The
    // audio callback reads the matching raw publications while modelReaders
    // holds a grace period open for the entire callback.
    std::shared_ptr<LoadedNAMModel> pedalModel;
    std::shared_ptr<LoadedNAMModel> ampModel;
    juce::String pedalDeclaredCaptureType { "unknown" };
    juce::String ampDeclaredCaptureType { "unknown" };
    ActiveNAMModelPointer activePedalModel { nullptr };
    ActiveNAMModelPointer activeAmpModel { nullptr };
    std::atomic<bool> activeAmpModelIncludesCab { false };
    NAMModelReaderCounter modelReaders { 0 };
    // Every swapped owner survives at least until a later writer observes no
    // callbacks in the grace period. NAM graph destruction therefore remains
    // off the audio thread and cannot race a raw-pointer reader.
    std::vector<std::shared_ptr<LoadedNAMModel>> retiredModels;
    juce::String pedalModelPath;
    juce::String ampModelPath;
    mutable juce::CriticalSection modelSwapLock;
    mutable std::atomic<uint64_t> modelSnapshotLockMissCount { 0 };
    mutable juce::CriticalSection cabIRLock;
    std::shared_ptr<LoadedCabIR> cabIR;
    ActiveCabIRPointer activeCabIR { nullptr };
    std::vector<std::shared_ptr<LoadedCabIR>> retiredCabIRs;
    juce::String cabIRPath;
    std::atomic<bool> cabIRLoaded { false };
    std::atomic<double> cabIRDurationSeconds { 0.0 };
    juce::String lastLoadError;
    mutable juce::CriticalSection uiStateLock;
    juce::String uiStateJSON;

    juce::AudioBuffer<float> workBuffer;
    juce::AudioBuffer<float> namInputBuffer;
    juce::AudioBuffer<float> namOutputBuffer;
    juce::AudioBuffer<float> namResampledInputBuffer;
    juce::AudioBuffer<float> namResampledOutputBuffer;
    juce::AudioBuffer<float> namTransitionBuffer;
    juce::AudioBuffer<float> ampBypassBuffer;
    juce::AudioBuffer<float> liveTransitionBuffer;
    std::vector<float*> namInputPtrs;
    std::vector<float*> namOutputPtrs;

    juce::dsp::IIR::Filter<float> lowShelfL, lowShelfR;
    juce::dsp::IIR::Filter<float> midPeakL, midPeakR;
    juce::dsp::IIR::Filter<float> highShelfL, highShelfR;
    juce::dsp::IIR::Filter<float> presenceShelfL, presenceShelfR;
    std::array<juce::dsp::IIR::Filter<float>, 9> graphicEqL;
    std::array<juce::dsp::IIR::Filter<float>, 9> graphicEqR;
    juce::dsp::IIR::Filter<float> cabHPFL, cabHPFR;
    juce::dsp::IIR::Filter<float> cabLPFL, cabLPFR;
    S13Compressor rackCompressor;
    S13Delay rackTapeEcho;
    S13Saturator rackPrecisionDrive { true };
    S13Saturator rackChaos { true };
    static constexpr int maximumEmbeddedDriveLatencySamples = 512;
    std::unique_ptr<juce::dsp::Oversampling<float>>
        embeddedDriveOversampler2x;
    juce::AudioBuffer<float> embeddedDriveSharedDryBuffer;
    std::array<
        std::array<
            float,
            static_cast<size_t>(
                maximumEmbeddedDriveLatencySamples + 1)>,
        2>
        embeddedDriveSharedDryRing {};
    int embeddedDriveSharedDryWriteIndex = 0;
    int embeddedDriveOversamplingLatencySamples = 0;
    juce::AudioBuffer<float> precisionDriveBypassBuffer;
    juce::AudioBuffer<float> chaosBypassBuffer;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        precisionDriveBypassDelay { maximumEmbeddedDriveLatencySamples };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        chaosBypassDelay { maximumEmbeddedDriveLatencySamples };
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDrivePower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDriveVolumeGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosLevelGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedEmbeddedDriveIslandPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedOctaverDownMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedOctaverUpMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedOctaverDirectMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedLaserMix;
    S13Chorus rackChorus;
    S13Delay rackDelay;
    S13Reverb rackReverb;
    bool compressorWasActive = false;
    bool tapeEchoWasActive = false;
    bool octaverWasActive = false;
    bool precisionDriveWasActive = false;
    bool chaosWasActive = false;
    bool laserWasActive = false;
    bool cabWasActive = false;
    bool modulationWasActive = false;
    int modulationBypassDrainSamples = 0;
    bool delayWasActive = false;
    bool reverbWasActive = false;
    std::int64_t tapeEchoTailSamplesRemaining = 0;
    std::int64_t delayTailSamplesRemaining = 0;
    std::int64_t reverbTailSamplesRemaining = 0;
    float tapeEchoTailMix = 0.0f;
    float delayTailMix = 0.0f;
    float reverbTailWet = 0.0f;
    float reverbTailEarly = 0.0f;
    float octaverDetectorDcState = 0.0f;
    float octaverDetectorLowpass1 = 0.0f;
    float octaverDetectorLowpass2 = 0.0f;
    float octaverDetectorEnvelope = 0.0f;
    float octaverDetectorGateGain = 0.0f;
    float octaverSharedSubPolarity = 1.0f;
    int octaverDetectorChannel = 0;
    bool octaverDetectorArmed = false;
    bool octaverDetectorGateOpen = false;
    std::array<float, 2> octaverSubSmooth {};
    std::array<float, 2> octaverUpHpState {};
    float precisionDriveGateEnvelope = 0.0f;
    float precisionDriveGateGain = 1.0f;
    std::array<float, 2> ampVoiceLowState {};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedInputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedOutputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedPedalMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpPowerMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpInputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpOutputGain;
    std::array<float, 2> cabMicLowState {};
    std::array<float, 2> cabRoomState {};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabLevelGain;
    float laserPhase = 0.0f;
    float laserControlPhase = 0.0f;
    float laserEnvelope = 0.0f;
    std::array<float, 2> laserFilterState {};
    std::array<float, 2> laserRectifierDcState {};
    int inputMeterHoldSamplesRemaining = 0;
    int outputMeterHoldSamplesRemaining = 0;
    std::atomic<int> postCabOrder0 { 0 };
    std::atomic<int> postCabOrder1 { 1 };
    std::atomic<int> postCabOrder2 { 2 };
    std::atomic<int> postCabOrder3 { 3 };
    double cachedSampleRate = 44100.0;
    int cachedBlockSize = 512;
    int realtimeBufferCapacity = 512;
    float lastBassDb = 999.0f;
    float lastMidDb = 999.0f;
    float lastTrebleDb = 999.0f;
    float lastPresenceDb = 999.0f;
    std::array<float, 9> lastGraphicEqDb {};
    float lastCabHPFHz = -1.0f;
    float lastCabLPFHz = -1.0f;
    std::array<float, 5> lowShelfTarget {};
    std::array<float, 5> midPeakTarget {};
    std::array<float, 5> highShelfTarget {};
    std::array<float, 5> presenceShelfTarget {};
    std::array<std::array<float, 5>, 9> graphicEqTargets {};
    std::array<float, 5> cabHPFTarget {};
    std::array<float, 5> cabLPFTarget {};
    static constexpr int filterGainTableSize = 241;
    static constexpr int cabHPFTableSize = 481;
    static constexpr int cabLPFTableSize = 1901;
    std::array<std::vector<std::array<float, 5>>, 4> toneFilterTables;
    std::array<std::vector<std::array<float, 5>>, 9> graphicEqFilterTables;
    std::vector<std::array<float, 5>> cabHPFFilterTable;
    std::vector<std::array<float, 5>> cabLPFFilterTable;
    bool filterTargetTablesPrepared = false;
    bool rackFilterCoefficientsInitialised = false;
    bool graphicEqCoefficientsSmoothing = false;
    bool cabFilterCoefficientsSmoothing = false;
    float gateEnvelope = 0.0f;
    float gateGain = 1.0f;
    uint64_t auditionSourceSample = 0;
    std::atomic<int> diagnosticPreparedBlockSize { 512 };
    std::atomic<int> diagnosticBufferCapacity { 512 };
    std::atomic<int> diagnosticLastBlockSize { 0 };
    std::atomic<int> diagnosticMaxBlockSize { 0 };
    std::atomic<uint64_t> diagnosticProcessedBlockCount { 0 };
    std::atomic<int> diagnosticLastDspFrames { 0 };
    std::atomic<int> diagnosticMaxDspFrames { 0 };
    std::atomic<float> diagnosticPreparedSampleRate { 44100.0f };
    std::atomic<float> diagnosticLastModelSampleRate { 0.0f };
    std::atomic<float> diagnosticLastInputPeakDb { -90.0f };
    std::atomic<float> diagnosticLastRawInputPeakDb { -90.0f };
    std::atomic<float> diagnosticLastOutputPeakDb { -90.0f };
    std::atomic<bool> diagnosticLastAuditionSourceActive { false };
    std::atomic<bool> diagnosticLastAuditionSourceRendered { false };
    std::atomic<bool> diagnosticLastResampled { false };
    std::atomic<int> diagnosticAudioThreadResizeAvoidedCount { 0 };
    std::atomic<int> diagnosticOversizeBypassCount { 0 };
    std::atomic<int> diagnosticModelProcessFailCount { 0 };
    std::atomic<int> diagnosticObservedTightBlockSize { 0 };
    std::atomic<int> diagnosticRealtimeSafetyBypassCount { 0 };
    std::atomic<bool> diagnosticRealtimeDSPBlocked { false };
    // Version 1 preserves the pre-V2 Drive output law and Chorus linear mix
    // for restored projects. New racks start on version 2.
    std::atomic<int> namEffectsDspVersion { 2 };

    void reclaimRetiredModelsFromEarlierPublication();
    void reclaimRetiredCabIRsFromEarlierPublication();
    void updateReportedLatency();
    static void resetModelStreamingState(LoadedNAMModel& model,
                                         double hostSampleRate,
                                         double modelSampleRate,
                                         int hostBufferCapacity);
    static void processModelDryDelay(juce::AudioBuffer<float>& buffer,
                                     LoadedNAMModel& model) noexcept;
    static void processAmpBypassDryDelay(juce::AudioBuffer<float>& buffer,
                                         LoadedNAMModel& model) noexcept;
    std::shared_ptr<LoadedNAMModel> prepareModel(const juce::String& path,
                                                 juce::String& error,
                                                 const juce::String& declaredCaptureType = {});
    bool prepareModelForHostConfiguration(LoadedNAMModel& model,
                                          double hostSampleRate,
                                          int hostBufferCapacity,
                                          juce::String& error);
    std::shared_ptr<LoadedCabIR> prepareCabIR(const juce::File& irFile,
                                             double durationSeconds,
                                             double hostSampleRate,
                                             int hostBlockSize,
                                             juce::String& error);
    bool publishPreparedCabIR(std::shared_ptr<LoadedCabIR> prepared);
    bool commitPreparedModel(std::shared_ptr<LoadedNAMModel> loaded,
                             bool pedalSlot,
                             bool applyDirectLoadPolicy,
                             bool reclaimEarlierPublication = true,
                             juce::String* error = nullptr);
    bool loadModelIntoSlot(const juce::String& path, bool pedalSlot);
    bool restoreStateInformationInternal(const void* data,
                                         int sizeInBytes,
                                         bool restoreHardwareCalibration,
                                         bool allowMissingResources,
                                         bool restoreResources = true,
                                         const std::function<std::shared_ptr<void>()>& publicationLeaseFactory = {},
                                         std::shared_ptr<void>* retainedPublicationLease = nullptr);
    void processNAMSlot(juce::AudioBuffer<float>& buffer,
                        LoadedNAMModel* model,
                        const float* mixEnvelope,
                        bool pedalSlot);
    void processNAMModelCore(juce::AudioBuffer<float>& buffer,
                             LoadedNAMModel* model,
                             const float* mixEnvelope,
                             bool pedalSlot);
    static void mixNAMOutputForHost(juce::AudioBuffer<float>& hostBuffer,
                                    const juce::AudioBuffer<float>& delayedDry,
                                    const juce::AudioBuffer<float>& modelOutput,
                                    int modelOutputChannels,
                                    float mixStart,
                                    float mixEnd = -1.0f) noexcept;
    static void mixNAMOutputForHostEnvelope(
        juce::AudioBuffer<float>& hostBuffer,
        const juce::AudioBuffer<float>& delayedDry,
        const juce::AudioBuffer<float>& modelOutput,
        int modelOutputChannels,
        const float* mixEnvelope) noexcept;
    static void crossfadeProcessedWithDry(juce::AudioBuffer<float>& processed,
                                          const juce::AudioBuffer<float>& dry,
                                          float mixStart,
                                          float mixEnd) noexcept;
    static void crossfadeProcessedWithDryEnvelope(
        juce::AudioBuffer<float>& processed,
        const juce::AudioBuffer<float>& dry,
        const float* mixEnvelope) noexcept;
    static void applySmoothedGain(
        juce::AudioBuffer<float>& buffer,
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>& gain) noexcept;
    juce::var getCalibrationState(bool pedalSlot) const;
    bool renderAuditionSourceIfNeeded(juce::AudioBuffer<float>& buffer, float inputPeak);
    void syncEmbeddedProcessorParameters() noexcept;
    void prepareFilterTargetTables();
    void updateToneFiltersIfNeeded();
    void updateGraphicEQFiltersIfNeeded();
    void updateCabFiltersIfNeeded();
    void resetOctaverState() noexcept;
    void processCompressorStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processTapeEchoStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processDualOctaverStage(juce::AudioBuffer<float>& buffer);
    void processEmbeddedDriveIsland(
        juce::AudioBuffer<float>& buffer,
        juce::MidiBuffer& midi);
    void processPrecisionDriveStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processChaosStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void resetLaserState() noexcept;
    void processLaserStage(juce::AudioBuffer<float>& buffer);
    void resetCabMicState() noexcept;
    void processCabStage(juce::AudioBuffer<float>& buffer, LoadedCabIR* cabForBlock);
    void resetPostCabOrder() noexcept;
    void updatePostCabOrderFromUiState(const juce::var& uiState);
    void resetAmpFaceplateState() noexcept;
    void processAmpFaceplateInputStage(juce::AudioBuffer<float>& buffer);
    void processAmpFaceplateOutputStage(juce::AudioBuffer<float>& buffer);
    void processAmpToneStack(juce::AudioBuffer<float>& buffer);
    void processGraphicEQ(juce::AudioBuffer<float>& buffer);
    void processModulationStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processDelayStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processReverbStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processPostFX(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13NAMRack)
};

// ============================================================================
// S13BasicSynthInstrument -- Built-in polyphonic subtractive synth
// ============================================================================
class S13BasicSynthInstrument : public juce::AudioProcessor
{
public:
    S13BasicSynthInstrument();
    ~S13BasicSynthInstrument() override = default;

    std::atomic<float> attackMs { 8.0f };
    std::atomic<float> releaseMs { 180.0f };
    std::atomic<float> brightness { 0.62f };
    std::atomic<float> detuneCents { 7.0f };
    std::atomic<float> subLevel { 0.18f };
    std::atomic<float> noiseLevel { 0.015f };
    std::atomic<float> outputGain { -15.0f };

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Basic Synth"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
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
    bool isS13BuiltInInstrument() const { return true; }

private:
    std::array<std::array<bool, 128>, 16> active {};
    std::array<std::array<bool, 128>, 16> releasing {};
    std::array<std::array<float, 128>, 16> phaseA {};
    std::array<std::array<float, 128>, 16> phaseB {};
    std::array<std::array<float, 128>, 16> phaseSub {};
    std::array<std::array<float, 128>, 16> velocity {};
    std::array<std::array<float, 128>, 16> envelope {};
    std::array<std::array<float, 128>, 16> filterState {};
    std::array<std::array<int, 128>, 16> ageSamples {};
    std::array<float, 16> pitchBendSemitones {};
    std::array<float, 16> modWheel {};
    double cachedSampleRate = 44100.0;

    void clearVoices();
    void handleMidi(const juce::MidiMessage& message);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13BasicSynthInstrument)
};

// ============================================================================
// S13PianoInstrument -- Built-in MIDI piano instrument
// ============================================================================
class S13PianoInstrument : public juce::AudioProcessor
{
public:
    S13PianoInstrument();
    ~S13PianoInstrument() override = default;

    std::atomic<float> tone { 0.58f };
    std::atomic<float> body { 0.72f };
    std::atomic<float> hammer { 0.42f };
    std::atomic<float> releaseMs { 950.0f };
    std::atomic<float> outputGain { -15.0f };
    std::atomic<float> resonance { 0.38f };
    std::atomic<float> stereoWidth { 0.62f };
    std::atomic<float> model { 0.0f }; // 0=Studio Grand, 1=Bright Upright, 2=Soft Felt

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Piano"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 4.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }
    bool isS13BuiltInInstrument() const { return true; }

private:
    std::array<std::array<bool, 128>, 16> active {};
    std::array<std::array<bool, 128>, 16> releasing {};
    std::array<std::array<bool, 128>, 16> sustained {};
    std::array<std::array<float, 128>, 16> phase {};
    std::array<std::array<float, 128>, 16> velocity {};
    std::array<std::array<float, 128>, 16> envelope {};
    std::array<std::array<int, 128>, 16> ageSamples {};
    std::array<bool, 16> sustainPedal {};
    double cachedSampleRate = 44100.0;

    void clearVoices();
    void handleMidi(const juce::MidiMessage& message);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13PianoInstrument)
};

// ============================================================================
// S13CleanGuitarInstrument -- Built-in clean electric guitar instrument
// ============================================================================
class S13CleanGuitarInstrument : public juce::AudioProcessor
{
public:
    S13CleanGuitarInstrument();
    ~S13CleanGuitarInstrument() override = default;

    std::atomic<float> model { 0.0f };      // 0=T-style DI, 1=S-style DI, 2=Clean US Combo, 3=JC-style Chorus Clean
    std::atomic<float> tone { 0.68f };
    std::atomic<float> body { 0.46f };
    std::atomic<float> pickNoise { 0.32f };
    std::atomic<float> releaseMs { 210.0f };
    std::atomic<float> chorus { 0.0f };
    std::atomic<float> stringMode { 1.0f }; // 0=auto, 1=MIDI ch 1-6 strings, 2=MIDI ch 2-7 strings
    std::atomic<float> bendRangeSemitones { 2.0f };
    std::atomic<float> outputGain { -14.0f };

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Clean Guitar"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 1.5; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isS13BuiltIn() const { return true; }
    bool isS13BuiltInInstrument() const { return true; }

private:
    std::array<std::array<bool, 128>, 16> active {};
    std::array<std::array<bool, 128>, 16> releasing {};
    std::array<std::array<float, 128>, 16> phase {};
    std::array<std::array<float, 128>, 16> velocity {};
    std::array<std::array<float, 128>, 16> envelope {};
    std::array<std::array<float, 128>, 16> pluckFilter {};
    std::array<std::array<int, 128>, 16> ageSamples {};
    std::array<std::array<int, 128>, 16> voiceString {};
    std::array<float, 16> pitchBendSemitones {};
    std::array<float, 16> modWheel {};
    std::array<int, 6> stringNote {};
    std::array<int, 6> stringChannel {};
    double cachedSampleRate = 44100.0;
    float chorusPhase = 0.0f;

    void clearVoices();
    void handleMidi(const juce::MidiMessage& message);
    int chooseStringForNote(int note, int midiChannel) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13CleanGuitarInstrument)
};

// ============================================================================
// S13DrumInstrument -- Built-in MIDI drum instrument with GM/e-drum mapping
// ============================================================================
class S13DrumInstrument : public juce::AudioProcessor
{
public:
    S13DrumInstrument();
    ~S13DrumInstrument() override = default;

    std::atomic<float> kit { 0.0f };       // 0=Studio, 1=Rock, 2=Electronic
    std::atomic<float> tuning { 0.0f };    // semitones
    std::atomic<float> ambience { 0.18f };
    std::atomic<float> outputGain { -10.0f };
    std::atomic<float> hihatTightness { 0.65f };
    std::atomic<float> mapPreset { 0.0f }; // 0=GM, 1=Roland TD
    std::atomic<float> punch { 0.55f };
    std::atomic<float> stereoWidth { 0.7f };
    std::atomic<float> velocityCurve { 0.0f }; // -1=soft, 0=linear, 1=hard

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;

    const juce::String getName() const override { return "OpenStudio Drums"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
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
    bool isS13BuiltInInstrument() const { return true; }

private:
    std::array<std::array<bool, 128>, 16> active {};
    std::array<std::array<float, 128>, 16> phase {};
    std::array<std::array<float, 128>, 16> velocity {};
    std::array<std::array<int, 128>, 16> ageSamples {};
    std::array<float, 16> hihatPedal {};
    double cachedSampleRate = 44100.0;

    void clearVoices();
    void handleMidi(const juce::MidiMessage& message);
    int mapIncomingNote(int note) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13DrumInstrument)
};
