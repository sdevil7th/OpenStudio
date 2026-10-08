#pragma once
#include "BuiltInDrumArticulations.h"
#include "BuiltInSpringReverb.h"
#include "BuiltInSaturationColour.h"
#include "BuiltInVoiceAllocation.h"
#include "BuiltInSynthModulation.h"
#include "BuiltInSynthCCMacros.h"
#include "BuiltInMIDIChannelMix.h"
#include "BuiltInSynthMatrix.h"
#include "BuiltInSynthOscillators.h"
#include "BuiltInSynthMPE.h"
#include "BuiltInPluckedLoop.h"
#include "BuiltInCoupledBody.h"
#include "BuiltInReverbWorkflow.h"
#include "BuiltInPeakHold.h"
#include "BuiltInReverbPeakMeter.h"
#include "BuiltInDelayDiffusion.h"
#include "BuiltInInstrumentPerformance.h"
#include "BuiltInGuitarPerformance.h"

#include <JuceHeader.h>
#include "BuiltInEffects.h"
#include "NAMCabPresentation.h"
#include "NAMPolyOctaver.h"
#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif
#include <array>
#include <atomic>
#include <cmath>
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
// OpenStudioDelay -- Stereo delay with tempo sync, ping-pong, feedback processing
// ============================================================================
class OpenStudioDelay : public juce::AudioProcessor
{
public:
    explicit OpenStudioDelay(float maximumSupportedDelaySeconds = 24.1f, bool standalone = false);
    ~OpenStudioDelay() override = default;
    float getMaximumSupportedDelaySeconds() const noexcept { return maximumDelaySeconds; }
    // Callback-published telemetry; zero means no processed block yet.
    std::atomic<float> effectiveDelayMsL {0}, effectiveDelayMsR {0}, editorTempoBpm {0};
    std::atomic<int> editorTempoSource {0}; // 0 fallback, 1 current host, 2 retained host

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
    std::atomic<float> delayMode    { 0.0f };   // 0=Digital, 1=Tape, 2=Analog, 3=Multi, 4=Dual
    std::atomic<float> ducking      { 0.0f };   // 0-1 input ducking amount
    // Runtime character values supplied by the NAM Rack's six-control macro.
    // They deliberately are not serialized as independent parameters: the
    // visible controls and Instrument Profile remain the only source of truth.
    // A negative wow depth retains the standalone Delay's historical
    // mode/saturation-derived Tape wow after old standalone state is restored.
    std::atomic<float> wowDepthMs       { -1.0f };
    std::atomic<float> wowRateHz        { 0.37f };
    std::atomic<float> flutterDepthMs   { 0.0f };
    std::atomic<float> flutterRateHz    { 6.4f };
    std::atomic<float> duckAttackMs     { 8.0f };
    std::atomic<float> duckReleaseMs    { 180.0f };
    std::atomic<float> duckMaxReduction { 0.82f };
    // Runtime-only sidechain calibration. A value of one preserves the
    // standalone Delay contract; embedded clients may raise it so a normal
    // instrument-level signal can duck repeats without touching unity dry.
    std::atomic<float> duckDetectorGain { 1.0f };
    std::atomic<float> topologyControl  { 0.18f };
    std::atomic<float> multiFeedback    { 0.2112f };
    std::atomic<float> dualTimeRatio    { 0.59f };
    std::atomic<float> dualFeedback     { 0.185152f };
    std::atomic<float> dualLowPassHz    { 8260.0f };
    std::atomic<float> dualHighPassHz   { 85.7f };
    std::atomic<float> dualSaturation   { 0.234f };
    std::atomic<float> dualModDepthMs   { 0.255f };
    std::atomic<float> dualModRateHz    { 0.235f };
    // Runtime-only rack controls. They are intentionally not serialized:
    // inputSend=0 lets an existing tail drain without recording new input,
    // while unityDry=1 keeps bypass sample-transparent during spillover.
    // directGainOverride carries the NAM Rack's explicit equal-power dry law;
    // a negative value preserves the standalone Delay's historical 1-Mix law.
    std::atomic<float> inputSend         { 1.0f };
    std::atomic<float> unityDry          { 0.0f };
    std::atomic<float> directGainOverride { -1.0f };

    const bool standaloneControls;
    std::atomic<float> customMotion {0}, standaloneWowDepth {.45f};
    std::atomic<float> diffusionAmount {0}, diffusionSpanMs {40};
    struct StandaloneControl { const char* id; const char* label; float minimum,maximum,initial; const char* unit; std::atomic<float> OpenStudioDelay::* member; };
    static constexpr std::array<StandaloneControl,19> standaloneParameters {{
        {"topologyControl","Topology",0,1,.18f,"",&OpenStudioDelay::topologyControl},
        {"multiFeedback","Head feedback",0,.95f,.2112f,"",&OpenStudioDelay::multiFeedback},
        {"dualTimeRatio","B time ratio",.5f,1,.59f,"x",&OpenStudioDelay::dualTimeRatio},
        {"dualFeedback","B feedback",0,.95f,.185152f,"",&OpenStudioDelay::dualFeedback},
        {"dualLowPassHz","B low pass",200,20000,8260,"Hz",&OpenStudioDelay::dualLowPassHz},
        {"dualHighPassHz","B high pass",20,2000,85.7f,"Hz",&OpenStudioDelay::dualHighPassHz},
        {"dualSaturation","B saturation",0,1,.234f,"",&OpenStudioDelay::dualSaturation},
        {"dualModDepthMs","B motion",0,4,.255f,"ms",&OpenStudioDelay::dualModDepthMs},
        {"dualModRateHz","B motion rate",.01f,4,.235f,"Hz",&OpenStudioDelay::dualModRateHz},
        {"customMotion","Custom wow",0,1,0,"",&OpenStudioDelay::customMotion},
        {"wowDepthMs","Wow depth",0,4,.45f,"ms",&OpenStudioDelay::standaloneWowDepth},
        {"wowRateHz","Wow rate",.01f,4,.37f,"Hz",&OpenStudioDelay::wowRateHz},
        {"flutterDepthMs","Flutter depth",0,1,0,"ms",&OpenStudioDelay::flutterDepthMs},
        {"flutterRateHz","Flutter rate",1,16,6.4f,"Hz",&OpenStudioDelay::flutterRateHz},
        {"duckAttackMs","Duck attack",1,100,8,"ms",&OpenStudioDelay::duckAttackMs},
        {"duckReleaseMs","Duck release",20,2000,180,"ms",&OpenStudioDelay::duckReleaseMs},
        {"duckMaxReduction","Duck limit",0,.95f,.82f,"",&OpenStudioDelay::duckMaxReduction},
        {"diffusionAmount","Diffusion",0,1,0,"",&OpenStudioDelay::diffusionAmount},
        {"diffusionSpanMs","Diffusion span",5,200,40,"ms",&OpenStudioDelay::diffusionSpanMs}
    }};
    bool setStandaloneControl(const juce::String& id,float value) noexcept;

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override;

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

    bool isOpenStudioBuiltIn() const { return true; }
    void resetTailState() noexcept;
    void resetRackRuntimeMixState(float send, bool preserveUnityDry) noexcept;
    // The host tempo is only legal to query during processBlock(). The outer
    // NAM Rack therefore publishes its callback-local BPM to this embedded
    // processor instead of forwarding/storing a host playhead pointer.
    void publishTempoBpmFromAudioCallback(double bpm) noexcept;
    void setExtendedModesEnabled(bool enabled) noexcept
    {
        extendedModesEnabled = enabled;
    }

private:
    // Native objective regressions inspect callback-owned transition state
    // without exposing it as a production parameter or public API.
    friend class AudioEngine;
    friend class NAMDelayRegression;
    float maximumDelaySeconds = 24.1f;
    BuiltInDelayDiffusion wetDiffusion;
    int maxDelaySamples = 2;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineL { 1 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineR { 1 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear>
        secondaryDelayLineL { 1 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear>
        secondaryDelayLineR { 1 };

    juce::dsp::IIR::Filter<float> feedbackLPF_L, feedbackLPF_R;
    juce::dsp::IIR::Filter<float> feedbackHPF_L, feedbackHPF_R;

    float feedbackSampleL = 0.0f;
    float feedbackSampleR = 0.0f;
    float secondaryFeedbackSampleL = 0.0f;
    float secondaryFeedbackSampleR = 0.0f;
    float secondaryHighPassLowStateL = 0.0f;
    float secondaryHighPassLowStateR = 0.0f;
    float secondaryLowPassStateL = 0.0f;
    float secondaryLowPassStateR = 0.0f;
    float smoothedDelaySamplesL = 0.0f;
    float smoothedDelaySamplesR = 0.0f;
    float delayMorphTargetSamplesL = 0.0f;
    float delayMorphTargetSamplesR = 0.0f;
    float pendingDelaySamplesL = 0.0f;
    float pendingDelaySamplesR = 0.0f;
    float requestedDelaySamplesL = 0.0f;
    float requestedDelaySamplesR = 0.0f;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedDelayTimeMorph;
    bool delayTimeMorphActive = false;
    bool delayTimeChangePending = false;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDryGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedFeedback;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCrossFeed;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedSaturation;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedWidth;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDucking;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedInputSend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedTapeMode;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAnalogMode;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMultiMode;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualMode;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedPingPong;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedWowDepthMs;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedWowRateHz;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedFlutterDepthMs;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedFlutterRateHz;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDuckAttackCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDuckReleaseCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDuckMaximumReduction;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedTopologyControl;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMultiFeedback;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualTimeRatio;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualFeedback;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualLowPassCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualHighPassCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualSaturation;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualModDepthMs;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDualModRateHz;
    float sendReleaseStateL = 0.0f;
    float sendReleaseStateR = 0.0f;
    float duckEnvelope = 0.0f;
    float modulationPhase = 0.0f;
    float flutterPhase = 0.0f;
    float secondaryModulationPhase = 0.0f;
    int validHistorySamples = 0;
    int secondaryValidHistorySamples = 0;
    bool extendedModesEnabled = false;

    double cachedSampleRate = 44100.0;
    float lastLPFFreq = 20000.0f;
    float lastHPFFreq = 20.0f;
    std::vector<OpenStudioIIRCoefficientSet> feedbackLPFCoefficientLut;
    std::vector<OpenStudioIIRCoefficientSet> feedbackHPFCoefficientLut;
    juce::dsp::IIR::Filter<float>
        alternateFeedbackLPF_L, alternateFeedbackLPF_R;
    juce::dsp::IIR::Filter<float>
        alternateFeedbackHPF_L, alternateFeedbackHPF_R;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedFeedbackFilterMorph;
    OpenStudioIIRCoefficientSet pendingFeedbackLPFCoefficients {};
    OpenStudioIIRCoefficientSet pendingFeedbackHPFCoefficients {};
    bool feedbackFiltersUseAlternate = false;
    bool feedbackFilterMorphActive = false;
    bool feedbackFilterChangePending = false;
    // The host may query getTailLengthSeconds() from a non-audio thread.
    // Publish one self-contained conservative bound instead of exposing the
    // callback-owned smoothers/read-head state to a data race.
    std::atomic<float> publishedLiveTailSeconds { 0.0f };
    // Zero means that no callback has published a valid host tempo yet.
    // Lifecycle code uses 120 BPM for provisional read-head setup; public
    // tail reporting uses the conservative 10 BPM bound until this is known.
    std::atomic<float> publishedTempoBpm { 0.0f };

    float resolveRequestedWowDepthMs() const noexcept;
    static float syncNoteToMs(float noteIndex, double bpm);
    void publishLiveTailBoundFromAudioState(int processedSamples) noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioDelay)
};


// ============================================================================
// OpenStudioOctaveShimmerShifter -- low-cost dual-grain pitch shifter (+12 default)
// ============================================================================
class OpenStudioOctaveShimmerShifter
{
public:
    void prepare(double sampleRate,
                 float grainDurationSeconds = 0.075f,
                 float initialPhase = 0.0f,
                 float pitchRatio = 2.0f);
    void reset() noexcept;
    float processSample(float input) noexcept;

private:
    std::vector<float> delayBuffer;
    int writeIndex = 0;
    int validHistorySamples = 0;
    int grainWindowSamples = 1;
    float historyAvailabilityFadeSamples = 1.0f;
    float minimumDelaySamples = 1.0f;
    float grainPhase = 0.0f;
    float resetGrainPhase = 0.0f;
    float grainPhaseIncrement = 0.0f;
    float highPassState = 0.0f;
    float lowPassState = 0.0f;
    float highPassCoefficient = 1.0f;
    float lowPassCoefficient = 1.0f;

    float readFractionalDelay(float delaySamples) const noexcept;
};


// ============================================================================
// OpenStudioReverb -- Multi-algorithm reverb
// ============================================================================
#include "BuiltInAdditionalReverbs.h"
#include "BuiltInConvolution.h"
#include "BuiltInConvolutionMotion.h"
#include "BuiltInConvolutionExtension.h"
#include "BuiltInPlateReverb.h"
#include "BuiltInModalPlate.h"
#include "BuiltInPlateColour.h"
#include "BuiltInStudioReverb.h"
#include "BuiltInVintageReverb.h"
#include "BuiltInDriftingReverb.h"
#include "BuiltInClearReverb.h"
#include "BuiltInRetroReverb.h"
#include "BuiltInSpatialReverb.h"
#include "BuiltInEchoRoom.h"
#include "BuiltInAmbientReverb.h"

class OpenStudioReverb : public juce::AudioProcessor
{
public:
    explicit OpenStudioReverb(bool standalone = false);
    ~OpenStudioReverb() override = default;

    // Algorithm selector
    enum class Algorithm : int { Room = 0, Hall, Plate, Chamber, Spring, Shimmer, Nonlinear, Convolution };

    // Parameters
    std::atomic<float> algorithm  { 0.0f };    // Algorithm as float
    const bool standaloneBanking;
    BuiltInPeakHold peakHold;
    BuiltInReverbPeakMeter reconstructedPeakMeter;
    std::atomic<float> reconstructedPeaks {0};
    std::array<std::atomic<float>,2> inputPeaksDb {{-100.0f,-100.0f}}, outputPeaksDb {{-100.0f,-100.0f}};
    BuiltInConvolution convolutionSpace;
    static constexpr int legacyBankControlCount = 10;
    static constexpr int bankControlCount = 14;
    static constexpr std::array<float, bankControlCount> bankMinima { 0, 0, 0, 0, 20, 1000, 0, .1f, 0, 0, -24, -24, 0, 0 };
    static constexpr std::array<float, bankControlCount> bankMaxima { 1, 1, 500, 1, 500, 20000, 1, 20, 1, 1, 24, 24, 1, 7 };
    static constexpr std::array<float, bankControlCount> bankDefaults { .5f, .5f, 0, .5f, 20, 20000, .5f, 2, 0, .5f, 12, 7, 0, 0 };
    static constexpr int originalTypeCount = 8; // Frozen descriptor prefix.
    static constexpr int preVintageTypeCount = 10; // Frozen timing-control descriptor prefix.
    static constexpr int preSpatialTypeCount = 12;
    static constexpr int preEchoTypeCount = 15;
    static constexpr int preAmbientTypeCount = 17;
    static constexpr int preDriftingTypeCount = 21; // Frozen expanded selector and descriptor prefix.
    static constexpr int preClearTypeCount = 24; // Frozen Drifting descriptor prefix.
    static constexpr int preRetroTypeCount = 27; // Frozen Clear/material descriptor prefix.
    static constexpr int standaloneTypeCount = 41;
    static float bankDefault(int bank, int control) noexcept;
    std::array<std::array<std::atomic<float>, bankControlCount>, standaloneTypeCount> typeBanks {};
    std::atomic<float> sendMode { 0.0f }, mixLock { 0.0f }, insertWet { 0.33f }, insertDry { 0.7f };
    std::array<std::atomic<float>*, bankControlCount> bankControls();
    void selectAlgorithm(int index);
    void selectSendMode(bool send);
    float getBankValue(int bank, int control);
    void setBankValue(int bank, int control, float value);
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
    std::atomic<float> shimmerAmount { 0.0f }; // 0-1, +12 semitone reinjection
    // Appended standalone controls. Defaults preserve the original single
    // octave voice and rising Nonlinear response when restoring older states.
    std::atomic<float> shimmerPitchA { 12.0f }, shimmerPitchB { 7.0f }, shimmerVoiceMix { 0.0f };
    std::atomic<float> nonlinearShape { 0.0f };
    std::atomic<float> nonlinearModulation {0}, nonlinearRate {.7f};
    std::atomic<float> springHold {0}, magneticHold {0}, nonlinearHold {0}, positionedHold {0};
    std::atomic<float> tailSpillover {0};
    std::atomic<float> irModDepth {0}, irModRate {.3f};
    std::array<std::atomic<float>,6> irExtensionControls{{0,2,2,2,250,4000}};
    std::atomic<double> retiringReverbTailSeconds {0};
    double getSelectedTailLengthSeconds() const;
    std::atomic<float> shimmerHold {0}; // opt-in; old creative Freeze state was inactive
    std::array<std::atomic<float>, standaloneTypeCount> holdInputModes {};
    size_t holdSlot() const noexcept { return static_cast<size_t>(juce::jlimit(0, standaloneTypeCount - 1, juce::roundToInt(algorithm.load()))); }
    bool holdAcceptsInput() const noexcept { return holdInputModes[holdSlot()].load() >= .5f; }
    static constexpr std::array<const char*, 5> creativeIds { "shimmerRouting", "nonlinearFeedback", "nonlinearLateDecay", "nonlinearLateLevel", "nonlinearDiffusion" };
    static constexpr std::array<float, 5> creativeMin { 0, 0, .1f, 0, 0 }, creativeMax { 2, .95f, 20, 1, 1 }, creativeDefaults { 0, 0, 2, 0, 0 };
    std::array<std::atomic<float>, 5> creativeControls { 0, 0, 2, 0, 0 };
    // Independent Room/Hall/Chamber compatibility and tone memories.
    std::array<std::atomic<float>,5> studioEngines {};
    std::atomic<float> roomCharacter{0};
    static constexpr std::array<const char*,3> studioToneIds {"studioDecayFilter","studioDecayCutoff","studioOutputCutOff"};
    static constexpr std::array<float,3> studioToneMin {0,200,0},studioToneMax {2,20000,1},studioToneDefaults {0,8000,0};
    std::array<std::array<std::atomic<float>,3>,5> studioToneControls {};
    static constexpr std::array<const char*,3> plateToneIds {"plateDecayFilter","plateDecayCutoff","plateOutputCutOff"};
    std::array<std::atomic<float>,3> plateToneControls {};
    std::array<std::atomic<float>,5> studioModulation { .15f, .3f, .1f, .2f, .05f };
    std::array<std::atomic<float>,5> studioBassRatio { 1.0f, 1.0f, 1.0f, 1.0f, 1.0f };
    static constexpr std::array<const char*,7> driftingIds {"driftDrive", "driftWow", "driftFlutter", "driftRate", "driftEmphasis", "driftBassRatio", "driftBassFrequency"};
    static constexpr std::array<float,7> driftingMin {0,0,0,.05f,0,.25f,100}, driftingMax {24,1,1,2,1,4,10000}, driftingDefaults {6,.2f,.1f,.3f,.5f,1,500};
    std::array<std::array<std::atomic<float>,7>,3> driftingControls {};
    bool isDriftingSpace() const noexcept { return algorithm.load() >= 21 && algorithm.load() <= 23; }
    size_t driftingSlot() const noexcept { return static_cast<size_t>(juce::jlimit(0,2,juce::roundToInt(algorithm.load())-21)); }
    static constexpr std::array<const char*,6> clearIds {"clearInputDiffusion","clearOnset","clearDepth","clearRate","clearBassRatio","clearBassFrequency"};
    static constexpr std::array<float,6> clearMin {0,0,0,.05f,.25f,100}, clearMax {1,300,1,2,4,10000}, clearDefaults {.65f,40,.25f,.3f,1,500};
    std::array<std::array<std::atomic<float>,6>,3> clearControls {};
    bool isClearSpace() const noexcept {return algorithm.load()>=24&&algorithm.load()<=26;}
    size_t clearSlot() const noexcept {return static_cast<size_t>(juce::jlimit(0,2,juce::roundToInt(algorithm.load())-24));}
    std::array<std::array<std::atomic<float>,BuiltInRetroReverb::controlCount>,BuiltInRetroReverb::count> retroControls {};
    bool isRetroSpace() const noexcept {return algorithm.load()>=27&&algorithm.load()<=40;}
    size_t retroSlot() const noexcept {return static_cast<size_t>(juce::jlimit(0,13,juce::roundToInt(algorithm.load())-27));}
    std::array<std::atomic<float>,2> vintageConversion { 0, 0 }, vintageTankRate { 0, 0 };
    std::array<std::atomic<float>,2> vintageBuildUp { 0, 0 }, vintageInputDiffusion { .5f, .5f };
    std::array<std::atomic<float>,2> vintageBassRatio { 1, 1 }, vintageBassFrequency { 500, 500 };
    std::array<std::atomic<float>,2> vintageColour { 0, 0 }, vintageModulation { .35f, .35f }, vintageRate { .3f, .3f };
    static constexpr std::array<const char*,8> spatialIds{"spatialDelay","spatialFeedback","spatialSync","spatialDivision","spatialDensity","spatialModulation","spatialRate","spatialAmount"};
    static constexpr std::array<float,8> spatialMin{0,0,0,0,0,0,.05f,0},spatialMax{2000,1,1,14,1,1,20,1},spatialDefaults{80,.2f,0,8,1,.25f,.4f,1};
    std::array<std::array<std::atomic<float>,8>,3> spatialControls{};
    std::array<std::atomic<float>,3> spatialLowShelf{0,0,0};
    std::array<std::atomic<float>,3> spatialDelayCapacity{0,0,0};
    bool setSpatialDelayCapacity(size_t index,float value);
    float spatialCapacityMs() const noexcept{return BuiltInSpatialReverb::capacitySeconds(spatialDelayCapacity[spatialSlot()].load())*1000;}
    static constexpr std::array<const char*,8> echoRoomIds{"headTime","headCount","headSpacing","headFeedback","headMotion","roomShape","sourceX","sourceY"};
    static constexpr std::array<float,8> echoRoomMin{200,0,0,0,0,0,0,0},echoRoomMax{1500,2,1,.98f,1,2,1,1},echoRoomDefaults{600,1,0,.35f,.1f,0,.5f,.5f};
    std::array<std::array<std::atomic<float>,8>,2> echoRoomControls{};
    static constexpr std::array<const char*,11> ambientIds{"ambRise","ambSwellMode","ambLength","ambFeedback","ambDepth","ambRate","ambVowel","ambResonance","ambCloudDecay","ambHold","ambBass"};
    static constexpr std::array<float,11> ambientMin{.01f,0,.02f,0,0,.05f,0,0,1,0,.5f},ambientMax{5,1,2,.95f,1,2,6,2,50,2,2},ambientDefaults{.5f,0,.8f,.3f,.3f,.2f,0,1,10,0,1};
    std::array<std::array<std::atomic<float>,11>,4> ambientControls{};
    static constexpr std::array<const char*,7> springIds{"springEngine","springCount","springDwell","springDispersion","springTension","springBass","springMotion"};
    static constexpr std::array<float,7> springMin{0,0,0,0,0,-10,0},springMax{1,2,3,1,1,10,1},springDefaults{0,1,0,.6f,.5f,0,.2f};
    std::array<std::atomic<float>,7> springControls{};

    bool isAmbientSpace()const noexcept{return algorithm.load()>=17&&algorithm.load()<=20;}
    size_t ambientSlot()const noexcept{return static_cast<size_t>(juce::jlimit(0,3,juce::roundToInt(algorithm.load())-17));}
    bool isEchoRoom()const noexcept{return algorithm.load()>=15&&algorithm.load()<=16;}
    size_t echoRoomSlot()const noexcept{return algorithm.load()>=16?1:0;}
    bool isSpatialSpace()const noexcept{return algorithm.load()>=12&&algorithm.load()<=14;}
    size_t spatialSlot()const noexcept{return static_cast<size_t>(juce::jlimit(0,2,juce::roundToInt(algorithm.load())-12));}
    float requestedSpatialDelay()const noexcept{const auto& p=spatialControls[spatialSlot()];return p[2].load()>=.5f?BuiltInSpatialReverb::delayMilliseconds(workflowTempo.load(),p[3].load()):p[0].load();}
    size_t vintageSlot() const noexcept { return algorithm.load() == 11 ? 1 : 0; }
    bool isVintageSpace() const noexcept { return algorithm.load() == 10 || algorithm.load() == 11; }
    size_t studioSlot() const noexcept { const int type = static_cast<int>(algorithm.load()); return type == 8 ? 3 : (type == 9 ? 4 : (type == 1 ? 1 : (type == 3 ? 2 : 0))); }
    int studioTopology() const noexcept { return algorithm.load()==0 && roomCharacter.load()>=.5f ? 5 : static_cast<int>(studioSlot()); }
    bool isStudioSpace() const noexcept { const float value = algorithm.load(); return value == 0 || value == 1 || value == 3 || value == 8 || value == 9; }
    std::atomic<float> predelayCapacity {0};
    bool setPredelayCapacity(float value);
    float predelayCapacityMs() const noexcept { return BuiltInReverbWorkflow::capacitySeconds(predelayCapacity.load()) * 1000; }
    std::atomic<float> predelaySync {0}, predelayDivision {4}, wetDuckDepth {0}, wetDuckThreshold {-24}, wetDuckRelease {250};
    std::atomic<float> workflowTempo {120}, workflowReduction {0}, workflowSampleRate {44100};
    float enginePredelay() const noexcept { return standaloneBanking && predelaySync.load() >= .5f ? 0.0f : preDelay.load(); }
    float effectivePredelay() const noexcept { if(isSpatialSpace())return juce::jmin(spatialCapacityMs(),requestedSpatialDelay());return standaloneBanking && predelaySync.load() >= .5f
        ? juce::jmin(predelayCapacityMs(), BuiltInReverbWorkflow::milliseconds(workflowTempo.load(),predelayDivision.load())) : preDelay.load(); }
    std::atomic<float> plateEngine { 0.0f }, plateCharacter { 1.0f }, plateModulation { .25f };
    std::array<std::atomic<float>,BuiltInModalPlate::controlCount> modalControls {};
    std::array<std::atomic<float>,BuiltInModalPlate::materialCount> modalMaterialControls {};
    BuiltInModalPlate::Material modalMaterialSettings() const noexcept;
    bool setModalMaterialControl(size_t index,float value);
    bool setModalControl(size_t index,float value);
    std::array<float,BuiltInModalPlate::controlCount> modalSettings() const noexcept;
    static constexpr std::array<const char*,10> plateColourIds{"plateDrive","plateInputCut","plateChorus","plateChorusPosition","plateChorusAmount","plateEQOn","plateLowFrequency","plateLowGain","plateHighFrequency","plateHighGain"};
    static constexpr std::array<float,10> plateColourMin{0,20,0,0,0,0,20,-24,200,-24},plateColourMax{36,700,1,1,1,1,2000,24,20000,24},plateColourDefaults{0,20,0,0,.5f,0,20,0,20000,0};
    std::array<std::atomic<float>,10> plateColourControls;

    std::atomic<float> shimmerVoiceEngine { 0.0f }; // 0 legacy octave, 1 spectral dual voice
    std::atomic<float> ducking       { 0.12f }; // 0-1 wet ducking
    std::atomic<float> bassDecay     { 0.70f }; // 0-1 low-band RT ratio
    std::atomic<float> movement      { 0.35f }; // 0-1 late-field modulation
    std::atomic<float> earlyLate     { 0.42f }; // 0=early, 1=late
    std::atomic<float> shimmerRegen  { 0.55f }; // 0-1 shifted feedback
    // Standalone OpenStudioReverb retains its historical engine selector for existing
    // standalone projects. The embedded NAM Rack always pins this processor to
    // its single current V5 engine and never forwards a restored legacy value.
    std::atomic<float> engineVersion { 1.0f };
    // Runtime-only NAM Rack V5 topology selector. Standalone Reverb state does
    // not persist this field: 0 is the V4-compatible Studio topology, followed
    // by Plate, Hall, and Room. The Rack owns its canonical serialization.
    std::atomic<float> rackVoice { 0.0f };
    // Runtime-only rack send. Zero drains the existing reverb without feeding
    // live input into the early reflections, pre-delay, or late tank.
    std::atomic<float> inputSend   { 1.0f };
    // Runtime-only NAM Rack PAD topology blend. Standalone Reverb state does
    // not persist this field; the containing Rack owns the public toggle.
    std::atomic<float> rackPadMode { 0.0f };

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { resetTailState(); }

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
    static double calculateTailLengthSecondsV2(int algorithmIndex,
                                               float roomSizeValue,
                                               float wetLevelValue,
                                               float earlyLevelValue,
                                               bool freezeEnabled,
                                               float preDelayMs,
                                               float decaySeconds,
                                               double sampleRate,
                                               float shimmerAmountValue,
                                               float shimmerRegenValue);
    static double calculateTailLengthSecondsV3(float wetLevelValue,
                                               float preDelayMs,
                                               float decaySeconds,
                                               double sampleRate,
                                               float shimmerAmountValue,
                                               float padModeValue = 0.0f);
    bool isTailSilent() const noexcept
    {
        return v3TailSilent;
    }
    bool hasActivePadTail() const noexcept
    {
        return rackPadMode.load(std::memory_order_relaxed) >= 0.5f
            || v3PublishedPadTailActive.load(
                   std::memory_order_relaxed);
    }
    std::uint64_t getEmergencyBoundHitCount() const noexcept
    {
        return emergencyBoundHitCount.load(std::memory_order_relaxed);
    }
    std::uint64_t getV2EmergencyBoundHitCount() const noexcept
    {
        return v2EmergencyBoundHitCount.load(std::memory_order_relaxed);
    }
    std::uint64_t getV3NonFiniteStateHitCount() const noexcept
    {
        return v3NonFiniteStateHitCount.load(std::memory_order_relaxed);
    }
    std::uint64_t getV3FilterNonFiniteHitCount() const noexcept
    {
        return v3FilterNonFiniteHitCount.load(std::memory_order_relaxed);
    }
    std::uint64_t getV3FiniteRunawayRecoveryCount() const noexcept
    {
        return v3FiniteRunawayRecoveryCount.load(
            std::memory_order_relaxed);
    }
    float getMaximumV3RawTankWritePeak() const noexcept
    {
        return maximumV3RawTankWritePeak.load(
            std::memory_order_relaxed);
    }
    float getLastV3PadReturnPeak() const noexcept
    {
        return lastV3PadReturnPeak.load(
            std::memory_order_relaxed);
    }
    float getLastV3PadReturnRms() const noexcept
    {
        return lastV3PadReturnRms.load(
            std::memory_order_relaxed);
    }
    float getMaximumV3RawWetOutputPeak() const noexcept
    {
        return maximumV3RawWetOutputPeak.load(
            std::memory_order_relaxed);
    }
    void resetEmergencyBoundHitCount() noexcept
    {
        emergencyBoundHitCount.store(0, std::memory_order_relaxed);
        v2EmergencyBoundHitCount.store(0, std::memory_order_relaxed);
        v3NonFiniteStateHitCount.store(0, std::memory_order_relaxed);
        v3FilterNonFiniteHitCount.store(0, std::memory_order_relaxed);
        v3FiniteRunawayRecoveryCount.store(
            0, std::memory_order_relaxed);
        maximumV3RawTankWritePeak.store(
            0.0f, std::memory_order_relaxed);
        maximumV3RawWetOutputPeak.store(
            0.0f, std::memory_order_relaxed);
    }
    float getMaximumRawInputSendPeak() const noexcept
    {
        return maximumRawInputSendPeak.load(std::memory_order_relaxed);
    }
    void resetInputDiagnostics() noexcept
    {
        maximumRawInputSendPeak.store(0.0f, std::memory_order_relaxed);
    }
    std::uint64_t getV2InputCoefficientUpdateCount() const noexcept
    {
        return v2InputCoefficientUpdateCount.load(
            std::memory_order_relaxed);
    }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}



    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    void restoreStateTree(const juce::ValueTree& tree, bool restoreConvolution);
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isOpenStudioBuiltIn() const { return true; }
    void resetTailState() noexcept;

private:
    BuiltInAdditionalReverbs additionalSpaces;
    BuiltInPlateReverb plateSpace;
    BuiltInModalPlate modalPlate;
    BuiltInPlateColour plateColour;
    BuiltInSpringReverb springSpace;
    BuiltInStudioReverb studioSpace;
    BuiltInVintageReverb vintageSpace;
    BuiltInDriftingReverb driftingSpace;
    BuiltInClearReverb clearSpace;
    std::unique_ptr<BuiltInRetroReverb> retroSpace;
    BuiltInSpatialReverb spatialSpace;
    BuiltInEchoRoom echoRoom;
    BuiltInAmbientReverb ambientSpace;
    juce::AudioBuffer<float> additionalDry, convolutionWet;
    juce::SmoothedValue<float> convolutionWeight;
    BuiltInReverbRetirement<1> convolutionRetirement;
    std::array<float,12> convolutionOuterSettings {0,20,20000,1,0,.3f};
    BuiltInConvolutionMotion convolutionMotion, convolutionCrossMotion;
    BuiltInConvolutionExtension convolutionExtension, convolutionCrossExtension;
    BuiltInReverbWorkflow workflow, convolutionCrossWorkflow;
    void processSelectedEngine(juce::AudioBuffer<float>&, juce::MidiBuffer&);
    static constexpr int lateLineCount = 8;
    static constexpr int v2LateLineCount = 16;
    static constexpr int v2DiffusionStageCount = 4;
    static constexpr int v2DiffusionLineCount =
        v2DiffusionStageCount * 2;

    // Pre-delay
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> preDelayLineL { 48000 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> preDelayLineR { 48000 };

    // Tone filters on wet signal
    juce::dsp::IIR::Filter<float> wetLowCutL, wetLowCutR;
    juce::dsp::IIR::Filter<float> wetHighCutL, wetHighCutR;
    float lastLowCut = 20.0f;
    float lastHighCut = 20000.0f;
    std::vector<OpenStudioIIRCoefficientSet> lowCutCoefficientLut;
    std::vector<OpenStudioIIRCoefficientSet> highCutCoefficientLut;

    juce::AudioBuffer<float> dryBuffer;
    juce::AudioBuffer<float> earlyReflectionBuffer;
    juce::AudioBuffer<float> earlyOutputBuffer;
    int earlyReflectionWriteIndex = 0;
    juce::AudioBuffer<float> lateTankBuffer;
    int lateTankWriteIndex = 0;
    std::array<float, lateLineCount> lateDampingState {};
    std::array<float, lateLineCount> lateModPhase {};
    OpenStudioOctaveShimmerShifter shimmerShifter;
    std::array<OpenStudioOctaveShimmerShifter, 2> v2ShimmerShifters;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedShimmerAmount;
    int validEarlyHistorySamples = 0;
    int validPreDelayHistorySamples = 0;
    int validLateHistorySamples = 0;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedWetLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDryLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedEarlyLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedInputSend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedV2Width;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedV2Ducking;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedV2Movement;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedV2EarlyLate;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedV2Diffusion;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedV2ShimmerRegen;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedV5AlternativeVoiceBlend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedV3PadMode;

    // Reverb V2: exact per-line rings packed into one allocation, a
    // sign-permuted fast-Hadamard FDN, and short stereo vector diffusers.
    std::vector<float> v2LatePool;
    std::array<int, v2LateLineCount> v2LateOffsets {};
    std::array<int, v2LateLineCount> v2LateCapacities {};
    std::array<int, v2LateLineCount> v2LateWriteIndices {};
    std::array<int, v2LateLineCount> v2LateDelaySamples {};
    std::array<float, v2LateLineCount> v2LowBandState {};
    std::array<float, v2LateLineCount> v2BelowHighBandState {};
    std::array<float, v2LateLineCount> v2LowBandGain {};
    std::array<float, v2LateLineCount> v2MidBandGain {};
    std::array<float, v2LateLineCount> v2HighBandGain {};
    std::array<float, v2LateLineCount> v2TargetLowBandGain {};
    std::array<float, v2LateLineCount> v2TargetMidBandGain {};
    std::array<float, v2LateLineCount> v2TargetHighBandGain {};
    float v2CachedDecaySeconds = -1.0f;
    float v2CachedBassRatio = -1.0f;
    float v2CachedHighRatio = -1.0f;
    bool v2CachedFreeze = false;
    bool v2DecayTargetsValid = false;
    std::array<float, v2LateLineCount> v2ModPhase {};
    std::vector<float> v2DiffusionPool;
    std::array<int, v2DiffusionLineCount> v2DiffusionOffsets {};
    std::array<int, v2DiffusionLineCount> v2DiffusionCapacities {};
    std::array<int, v2DiffusionLineCount> v2DiffusionWriteIndices {};
    std::array<float, 2> v2ShimmerPreLowPassState {};
    float v2InputLowPassStateL = 0.0f;
    float v2InputLowPassStateR = 0.0f;
    float v2SideLowPassState = 0.0f;
    float v2DuckEnvelope = 0.0f;
    float v2InputLowPassCoefficient = 1.0f;
    float v2CachedInputLowCutHz = -1.0f;
    float v2GainSmoothingCoefficient = 1.0f;
    float v2LowBandCoefficient = 1.0f;
    float v2BelowHighBandCoefficient = 1.0f;
    float v2BassSideCoefficient = 1.0f;
    float v2ShimmerPreLowPassCoefficient = 1.0f;
    float v2DuckAttackCoefficient = 1.0f;
    float v2DuckReleaseCoefficient = 0.0f;
    int v2ValidLateHistorySamples = 0;
    std::atomic<std::uint64_t> emergencyBoundHitCount { 0 };
    std::atomic<std::uint64_t> v2EmergencyBoundHitCount { 0 };
    std::atomic<std::uint64_t> v3NonFiniteStateHitCount { 0 };
    std::atomic<std::uint64_t> v3FilterNonFiniteHitCount { 0 };
    std::atomic<std::uint64_t>
        v3FiniteRunawayRecoveryCount { 0 };
    std::atomic<float> maximumV3RawTankWritePeak { 0.0f };
    std::atomic<float> maximumV3RawWetOutputPeak { 0.0f };
    std::atomic<float> maximumRawInputSendPeak { 0.0f };
    // Last-block PAD-only return, measured before the rack wet/dry law. These
    // read-only diagnostics distinguish a live control/publication problem
    // from a correctly running PAD branch that is merely masked by the dry rig.
    std::atomic<float> lastV3PadReturnPeak { 0.0f };
    std::atomic<float> lastV3PadReturnRms { 0.0f };
    std::atomic<std::uint64_t>
        v2InputCoefficientUpdateCount { 0 };

    // NAM Rack Reverb V3/V4: one true-stereo eight-line FDN. V3 retains the
    // original compact plate lengths exactly. V4 adds the architectural early
    // field, multiple output taps/diffusion, and a larger guitar-focused tank,
    // with a bounded dual-read crossfade only while its size is changing.
    static constexpr int v3DiffusionStageCount = 4;
    static constexpr int v3DiffusionLineCount =
        v3DiffusionStageCount * 2;
    std::vector<float> v3DiffusionPool;
    std::array<int, v3DiffusionLineCount> v3DiffusionOffsets {};
    std::array<int, v3DiffusionLineCount> v3DiffusionCapacities {};
    std::array<int, v3DiffusionLineCount> v3DiffusionWriteIndices {};
    std::array<int, lateLineCount> v3LateDelaySamples {};
    std::array<int, lateLineCount> v4ActiveLateDelaySamples {};
    std::array<int, lateLineCount> v4MorphTargetLateDelaySamples {};
    std::array<int, lateLineCount> v4PendingLateDelaySamples {};
    std::array<float, lateLineCount> v3LowBandState {};
    std::array<float, lateLineCount> v3LowBandFeedback {};
    std::array<float, lateLineCount> v3MidBandFeedback {};
    std::array<float, lateLineCount> v3TargetLowBandFeedback {};
    std::array<float, lateLineCount> v3TargetMidBandFeedback {};
    std::array<float, 4> v3ModPhase {};
    std::array<float, 2> v3ShimmerInputHighPassState {};
    std::array<float, 2> v3ShimmerInputLowPassState {};
    float v3InputSideLowPassState = 0.0f;
    float v3PadDuckEnvelope = 0.0f;
    float v3FeedbackSmoothingCoefficient = 1.0f;
    float v3BassSplitCoefficient = 1.0f;
    float v3SideBassCoefficient = 1.0f;
    float v3ShimmerInputHighPassCoefficient = 1.0f;
    float v3ShimmerInputLowPassCoefficient = 1.0f;
    float v3CachedDecaySeconds = -1.0f;
    float v4CachedFeedbackSizeScale = -1.0f;
    float v5CachedLowDecayRatio = -1.0f;
    float v3CachedLowCutHz = -1.0f;
    float v3CachedHighCutHz = -1.0f;
    float v3CachedTone = -1.0f;
    std::array<int, v3DiffusionLineCount>
        v3ValidDiffusionHistorySamples {};
    int v3TailSilentSamples = 0;
    bool v3TailSilent = false;
    float v3ActivePreDelaySamples = 0.0f;
    float v3MorphTargetPreDelaySamples = 0.0f;
    float v3PendingPreDelaySamples = 0.0f;
    float v3RequestedPreDelaySamples = -1.0f;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedV3PreDelayMorph;
    bool v3PreDelayMorphActive = false;
    bool v3PreDelayChangePending = false;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedV3LoopDampingCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedV4TankSizeMorph;
    float v4ActiveTankSizeScale = 1.0f;
    float v4MorphTargetTankSizeScale = 1.0f;
    float v4PendingTankSizeScale = 1.0f;
    float v4RequestedTankSizeScale = -1.0f;
    bool v4TankSizeMorphActive = false;
    bool v4TankSizeChangePending = false;
    // V4 uses the existing early-reflection ring plus a tiny output-only
    // diffusion bank. Both are history guarded, so reset and tail sleep can
    // invalidate them without sweeping delay memory on the audio thread.
    static constexpr int v4OutputDiffusionStageCount = 2;
    static constexpr int v4OutputDiffusionLineCount =
        v4OutputDiffusionStageCount * 2;
    std::vector<float> v4OutputDiffusionPool;
    std::array<int, v4OutputDiffusionLineCount>
        v4OutputDiffusionOffsets {};
    std::array<int, v4OutputDiffusionLineCount>
        v4OutputDiffusionCapacities {};
    std::array<int, v4OutputDiffusionLineCount>
        v4OutputDiffusionWriteIndices {};
    std::array<int, v4OutputDiffusionLineCount>
        v4ValidOutputDiffusionHistorySamples {};
    bool v4WasProcessing = false;
    bool v3ShimmerWasActive = false;
    // PAD is a dedicated additive late-wet branch. A source-following 24-band
    // envelope bank softens the attack of the already-diffuse reverb field,
    // then four subtly detuned +12 voices enter a modulated orthogonal FDN.
    // A quiet FDN projection is recirculated through those shifters, producing
    // a much quieter +24 generation without exposing a glassy harmony voice.
    static constexpr int v3PadVoiceCount = 4;
    static constexpr int v3PadTankLineCount = 4;
    static constexpr int v3PadSmearBandCount = 24;
    static constexpr int v3PadSmearCrossoverCount =
        v3PadSmearBandCount - 1;
    std::array<OpenStudioOctaveShimmerShifter, v3PadVoiceCount>
        v3PadShifters;
    std::vector<float> v3PadTankPool;
    std::array<int, v3PadTankLineCount> v3PadTankOffsets {};
    std::array<int, v3PadTankLineCount> v3PadTankCapacities {};
    std::array<int, v3PadTankLineCount> v3PadTankDelaySamples {};
    std::array<int, v3PadTankLineCount> v3PadTankWriteIndices {};
    std::array<int, v3PadTankLineCount>
        v3PadTankValidHistorySamples {};
    std::array<float, v3PadTankLineCount> v3PadTankDampingState {};
    std::array<float, v3PadTankLineCount> v3PadTankFeedbackGain {};
    std::array<float, v3PadTankLineCount>
        v3PadTankTargetFeedbackGain {};
    std::array<float, 2> v3PadInputHighPassState {};
    std::array<float, 2> v3PadInputLowPassState {};
    std::array<float, 2> v3PadOutputHighPassState {};
    std::array<float, 2> v3PadOutputLowPassState {};
    std::array<float, 2> v3PadOutputBassState {};
    std::array<std::array<float, v3PadSmearCrossoverCount>, 2>
        v3PadSmearSplitState {};
    std::array<std::array<float, v3PadSmearCrossoverCount>, 2>
        v3PadWhisperSplitState {};
    std::array<float, 2> v3PadWhisperHighPassState {};
    std::array<std::array<float, 2>, 2>
        v3PadWhisperLowPassState {};
    std::array<std::array<float, v3PadSmearBandCount>, 2>
        v3PadSmearEnvelope {};
    std::array<std::uint32_t, 2> v3PadWhisperNoiseState {
        0x6d2b79f5u, 0xa511e9b3u
    };
    std::array<float, v3PadSmearCrossoverCount>
        v3PadSmearCrossoverCoefficient {};
    std::array<float, v3PadSmearBandCount>
        v3PadSmearAttackCoefficient {};
    std::array<float, v3PadSmearBandCount>
        v3PadSmearReleaseCoefficient {};
    std::array<float, v3PadSmearBandCount>
        v3PadSmearBandWeight {};
    std::array<float, v3PadVoiceCount> v3PadVoiceModPhase {};
    std::array<float, v3PadTankLineCount> v3PadTankModPhase {};
    float v3PadInputHighPassCoefficient = 1.0f;
    float v3PadInputLowPassCoefficient = 1.0f;
    float v3PadTankDampingCoefficient = 1.0f;
    float v3PadFeedbackSmoothingCoefficient = 1.0f;
    float v3PadOutputHighPassCoefficient = 1.0f;
    float v3PadOutputLowPassCoefficient = 1.0f;
    float v3PadOutputBassCoefficient = 1.0f;
    float v3PadWhisperHighPassCoefficient = 1.0f;
    float v3PadWhisperLowPassCoefficient = 1.0f;
    float v3PadWhisperExtremeEnvelope = 0.0f;
    float v3PadWhisperExtremeAttackCoefficient = 1.0f;
    float v3PadWhisperExtremeReleaseCoefficient = 1.0f;
    float v3PadWhisperDensityGain = 1.0f;
    float v3PadWhisperSuppressionCoefficient = 1.0f;
    float v3PadWhisperRecoveryCoefficient = 1.0f;
    float v3PadDensityPersistenceEnvelope = 0.0f;
    float v3PadDensityPersistenceAttackCoefficient = 1.0f;
    float v3PadDensityPersistenceReleaseCoefficient = 1.0f;
    int v3PadSourceActivityHoldSamples = 0;
    int v3PadSourceActivityHoldDurationSamples = 1;
    float v3PadBloomEnvelope = 0.0f;
    float v3PadBloomAttackCoefficient = 1.0f;
    float v3PadBloomReleaseCoefficient = 1.0f;
    int v3PadDrainSamplesRemaining = 0;
    int v3PadMaximumDrainSamples = 0;
    float v3PadCachedDecaySeconds = -1.0f;
    bool v3PadWasActive = false;
    std::atomic<bool> v3PublishedPadTailActive { false };
    // V3 morphs between two wet-only tone-filter banks. The inactive bank is
    // reset and retargeted before a short crossfade, so cutoff automation never
    // rewrites a live biquad's coefficients or touches the exact dry branch.
    juce::dsp::IIR::Filter<float>
        v3WetLowCutAlternateL, v3WetLowCutAlternateR;
    juce::dsp::IIR::Filter<float>
        v3WetHighCutAlternateL, v3WetHighCutAlternateR;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedV3WetFilterMorph;
    OpenStudioIIRCoefficientSet v3PendingLowCutCoefficients {};
    OpenStudioIIRCoefficientSet v3PendingHighCutCoefficients {};
    bool v3WetFilterUsesAlternate = false;
    bool v3WetFilterMorphActive = false;
    bool v3WetFilterChangePending = false;

    void processLegacyBlock(juce::AudioBuffer<float>&,
                            juce::MidiBuffer&);
    void processV2Block(juce::AudioBuffer<float>&,
                        juce::MidiBuffer&);
    void processV3Block(juce::AudioBuffer<float>&,
                        juce::MidiBuffer&);
    void calculateV4TankDelaySamples(
        float sizeScale,
        std::array<int, lateLineCount>& destination) const noexcept;
    void invalidateV3PadState() noexcept;
    double cachedSampleRate = 44100.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioReverb)
};


// ============================================================================
// OpenStudioChorus -- Modulation suite: Chorus / Flanger / Phaser
// ============================================================================
class OpenStudioChorus : public juce::AudioProcessor
{
public:
    OpenStudioChorus();
    ~OpenStudioChorus() override = default;

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
    std::atomic<float> syncDivision { 7.0f };
    std::atomic<float> effectiveRateHz { 1.0f };
    std::atomic<double> hostTempoBpm { 120.0 };
    static constexpr std::array<double, 10> cycleBeats { .25, 1.0/3.0, .5, .75, 2.0/3.0, 1, 2, 4, 8, 16 };
    float resolveLFORate() noexcept;
    std::atomic<float> tempoSync { 0.0f };   // 0 = off, 1 = on
    std::atomic<float> characterMode { 0.0f }; // 0=Clean, 1=Ensemble
    std::atomic<float> randomBlend { 0.0f };  // 0=smooth LFO, 1=sample-and-hold
    // Runtime-only slew for the random modulation component. The NAM Rack's
    // Auto Speed control uses this without changing the displayed LFO rate.
    std::atomic<float> randomSlewMs { 12.0f };
    std::atomic<float> mixLaw { 1.0f };       // 0=legacy linear, 1=equal-power
    // Runtime-only parallel-mix option for the NAM Rack Bass profile. Wet
    // gain retains the selected mix law while the direct fundamental remains
    // at unity. Standalone Chorus and Guitar Rack behavior stay unchanged.
    std::atomic<float> unityDry { 0.0f };
    // Runtime-only rack send. Zero lets the wet path fade on bypass without
    // recording new live input into the modulation state.
    std::atomic<float> inputSend { 1.0f };

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { resetTailState(); }

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

    bool isOpenStudioBuiltIn() const { return true; }
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
    float sampleHoldSlewCoefficient = 1.0f;
    float lastRandomSlewMs = -1.0f;
    float feedbackState[2] = {};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedUnityDry;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedRate;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedDepth;
    float activeDelayDepth = 0.0f;
    float delayDepthMorphTarget = 0.0f;
    float pendingDelayDepth = 0.0f;
    float requestedDelayDepth = 0.0f;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedDelayDepthMorph;
    bool delayDepthMorphActive = false;
    bool delayDepthChangePending = false;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedFeedback;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedSpread;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedVoiceCount;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedRandomBlend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedInputSend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedTopologyGain;
    int activeModeIndex = static_cast<int>(Mode::Chorus);
    int activeLFOShapeIndex = static_cast<int>(LFOShape::Sine);
    int activeCharacterIndex = 0;
    // 0=steady, 1=fading to dry, 2=fading the selected topology back in.
    int topologyTransitionStage = 0;
    float sendReleaseState[2] = {};
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
    std::vector<OpenStudioIIRCoefficientSet> lowCutCoefficientLut;
    std::vector<OpenStudioIIRCoefficientSet> highCutCoefficientLut;
    juce::dsp::IIR::Filter<float>
        alternateWetLowCutL, alternateWetLowCutR;
    juce::dsp::IIR::Filter<float>
        alternateWetHighCutL, alternateWetHighCutR;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedWetFilterMorph;
    OpenStudioIIRCoefficientSet pendingLowCutCoefficients {};
    OpenStudioIIRCoefficientSet pendingHighCutCoefficients {};
    bool wetFiltersUseAlternate = false;
    bool wetFilterMorphActive = false;
    bool wetFilterChangePending = false;

    double cachedSampleRate = 44100.0;

    float getLFOValue(float phase, LFOShape shape, int voice) const;
    float readDelayTap(int channel, float delaySamples) const noexcept;
    void advanceLFO(int voice, float phaseIncrement) noexcept;
    float nextSampleAndHoldValue() noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioChorus)
};


// ============================================================================
// OpenStudioSaturator -- Multi-type saturation / distortion
// ============================================================================
class OpenStudioSaturator : public juce::AudioProcessor
{
public:
    explicit OpenStudioSaturator(bool useLowLatencyOversampling = false);
    ~OpenStudioSaturator() override = default;

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

    std::atomic<float> colourEngine {0}, inputTrim {0}, boostDrive {0}, driveCompensation {1}, colourTone {0}, cornerBump {0}, colourDynamics {1}, steepCut {0};
    std::atomic<float> inputLevelDb {-100}, outputLevelDb {-100}, drivenLevelDb {-100};

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { releaseResources(); }

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

    bool isOpenStudioBuiltIn() const { return true; }

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
    void setZeroInputInvariantEnabled(bool enabled) noexcept
    {
        zeroInputInvariantEnabled = enabled;
    }
    bool isZeroInputInvariantEnabled() const noexcept
    {
        return zeroInputInvariantEnabled;
    }
    void setAutomaticDriveCompensationEnabled(bool enabled) noexcept
    {
        automaticDriveCompensationEnabled = enabled;
    }
    void setFilterSmoothingSeconds(double seconds) noexcept
    {
        filterSmoothingSeconds = juce::jlimit(
            0.005, 0.250, seconds);
    }
    // Audio-thread-safe bounded reset used only after an embedded pedal has
    // completed its outer fade to exact dry. It deliberately does not clear
    // oversampling/delay buffers or rebuild coefficients.
    void resetRealtimeStateForEmbeddedBypass() noexcept;

private:
    BuiltInSaturationColour colour;
    int activeColourEngine=0;
    void publishColourMeters(const juce::AudioBuffer<float>&);
    static constexpr int maximumOversamplingLatencySamples = 512;
    juce::dsp::IIR::Filter<float> toneFilterL, toneFilterR;
    juce::dsp::IIR::Filter<float> lowCutFilterL, lowCutFilterR;
    double cachedSampleRate = 44100.0;
    int cachedBlockSize = 0;
    float lastToneFreq = 20000.0f;
    float lastLowCutFreq = 20.0f;
    std::vector<OpenStudioIIRCoefficientSet> toneCoefficientLut;
    std::vector<OpenStudioIIRCoefficientSet> lowCutCoefficientLut;
    OpenStudioIIRCoefficientSet targetToneCoefficients {};
    OpenStudioIIRCoefficientSet targetLowCutCoefficients {};
    bool toneCoefficientsSmoothing = false;
    bool lowCutCoefficientsSmoothing = false;
    bool lowCutBeforeSaturation = false;
    bool useLowLatencyOversampling = false;
    // Embedded NAM Rack pedals opt into a centred nonlinear transfer so a
    // silent channel cannot acquire a DC bias and be mistaken for a live side
    // by a following mono NAM. Standalone Saturator presets retain their
    // existing transfer for compatibility.
    bool zeroInputInvariantEnabled = false;
    // Standalone Saturator and restored NAM Rack V1/V2 instances retain the
    // historical -0.42 dB-per-dB blanket compensation. NAM Rack V3 disables
    // it and applies a measured topology-specific law after each embedded
    // pedal, where the user-facing Level control is also applied.
    bool automaticDriveCompensationEnabled = true;
    double filterSmoothingSeconds = 0.025;

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
    std::array<juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>, 2>
        smoothedAsymmetry;
    float lastDriveDbTarget = -1.0f;
    float lastMixTarget = -1.0f;
    float lastOutputDbTarget = 999.0f;
    std::array<juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>, 2>
        smoothedDiodeMode;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedTopologyGain;
    int activeSaturationType = static_cast<int>(SatType::Tape);
    // 0=steady, 1=fading to dry, 2=fading the selected topology back in.
    int topologyTransitionStage = 0;
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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioSaturator)
};

// ============================================================================
// OpenStudioNAMRack -- Native Neural Amp Modeler rack with OpenStudio wrapper controls
// ============================================================================
class OpenStudioNAMRack : public juce::AudioProcessor
{
public:
    static constexpr int currentNAMEffectsDspVersion = 20;
    static constexpr int currentCabEngineVersion = 3;
    // A development build briefly serialized this marker without changing the
    // portable preset schema. Treat it as V12 at every restore boundary.
    static constexpr int developmentNAMEffectsDspVersionAlias = 13;
    static constexpr int developmentNAMEffectsDspVersionAliasSourceVersion = 12;
    static constexpr int graphicEqFiltersIntroducedNAMEffectsDspVersion = 14;
    static constexpr int preEqIntroducedNAMEffectsDspVersion = 16;
    static constexpr int eightBandPreEqIntroducedNAMEffectsDspVersion = 19;
    static constexpr int currentReverbEngineVersion = 5;
    static constexpr int reverbVoiceIntroducedNAMEffectsDspVersion = 9;
    static constexpr int delayV10IntroducedNAMEffectsDspVersion = 10;
    enum InstrumentProfile : int
    {
        guitarInstrumentProfile = 0,
        bassInstrumentProfile = 1
    };
    enum ReverbVoice : int
    {
        studioReverbVoice = 0,
        plateReverbVoice = 1,
        hallReverbVoice = 2,
        roomReverbVoice = 3
    };

    enum DelayMode : int
    {
        digitalDelayMode = 0,
        tapeDelayMode = 1,
        analogDelayMode = 2,
        multiDelayMode = 3,
        dualDelayMode = 4
    };

    enum PrecisionDriveVoice : int
    {
        precisionDrivePrecisionVoice = 0,
        screamerDriveVoice = 1
    };

    struct DelaySyncSelection
    {
        int leftNoteIndex = 2;
        int rightNoteIndex = 3;
    };

    // The physical Delay remains a six-knob pedal. Every filter, modulation,
    // ducking and stereo value below is deterministically derived from those
    // controls plus Instrument Profile; none is a second saved parameter.
    struct DelayMacroState
    {
        int mode = tapeDelayMode;
        DelaySyncSelection sync {};
        float timeMsL = 360.0f;
        float timeMsR = 424.8f;
        float mix = 0.22f;
        float dryGain = 0.78f;
        float feedbackGain = 0.21681f;
        float crossFeed = 0.1488f;
        float lowPassHz = 10366.0f;
        float highPassHz = 85.7f;
        float saturation = 0.2264f;
        float stereoWidth = 1.096f;
        float wowDepthMs = 0.61f;
        float wowRateHz = 0.2794f;
        float flutterDepthMs = 0.0896f;
        float flutterRateHz = 5.696f;
        float duckAmount = 0.12f;
        float duckAttackMs = 7.08f;
        float duckReleaseMs = 333.64f;
        float duckMaxReduction = 0.82f;
        std::array<float, 4> multiTapRatios {
            1.0f, 0.7756f, 0.5956f, 0.4174f
        };
        std::array<float, 4> multiTapWeights {
            0.42f, 0.25f, 0.20f, 0.13f
        };
        float multiFeedbackGain = 0.2112f;
        float dualTimeRatio = 0.59f;
        float dualFeedbackGain = 0.185152f;
        float dualLowPassHz = 8260.0f;
        float dualHighPassHz = 85.7f;
        float dualSaturation = 0.234f;
        float dualModDepthMs = 0.255f;
        float dualModRateHz = 0.235f;
        float topologyControl = 0.18f;
        bool pingPong = true;
        bool tempoSync = false;
    };

    static int sanitizeDelayMode(float value) noexcept;
    static DelaySyncSelection resolveDelaySyncSelection(
        float modulation,
        bool pingPong) noexcept;
    static DelayMacroState resolveDelayMacroState(
        float timeMs,
        float feedback,
        float mix,
        float modulation,
        float ducker,
        float mode,
        float pingPong,
        float tempoSync,
        int instrumentProfile) noexcept;

    // The six faceplate controls remain the source of truth. Reverb V5 derives
    // every hidden OpenStudioReverb parameter from those values, the selected voice,
    // and the instrument profile in one deterministic mapping shared by
    // prepare, live processing, state tests, and future offline paths.
    struct ReverbMacroState
    {
        int voice = studioReverbVoice;
        int algorithmIndex = static_cast<int>(OpenStudioReverb::Algorithm::Plate);
        float roomSize = 0.55f;
        float damping = 0.5f;
        float wetGain = 0.0f;
        float dryGain = 1.0f;
        float width = 0.88f;
        float preDelayMs = 18.0f;
        float diffusion = 0.82f;
        float lowCutHz = 120.0f;
        float highCutHz = 9504.0f;
        float earlyGain = 0.0f;
        float decaySeconds = 2.2f;
        float shimmerAmount = 0.0f;
        float ducking = 0.0f;
        float bassDecay = 0.82f;
        float movement = 0.25f;
        float earlyLate = 0.55f;
        float shimmerRegen = 0.55f;
        float padMode = 0.0f;
    };

    static int sanitizeReverbVoice(float value) noexcept;
    static ReverbMacroState resolveReverbMacroState(
        float voice,
        float mix,
        float decaySeconds,
        float tone,
        float preDelayMs,
        float lowCutHz,
        float shimmer,
        int instrumentProfile,
        float padMode = 0.0f) noexcept;

    OpenStudioNAMRack();
    ~OpenStudioNAMRack() override = default;

    std::atomic<float> inputTrimDb { 0.0f };
    // One current, profile-aware component implementation. The selector never
    // rewrites stored knob values: 0=Guitar (default), 1=Bass. Frequency-
    // sensitive stages derive their effective voicing from this atomic while
    // neutral stages retain identical processing in both profiles.
    std::atomic<float> instrumentProfile {
        static_cast<float>(guitarInstrumentProfile) };
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
    std::atomic<float> compressorAttackMs { 21.9f };
    std::atomic<float> compressorReleaseMs { 149.1f };
    std::atomic<float> compressorToneDb { 0.0f };
    // Horizon-style two-position Intensity switch: 0=8:1, 1=16:1.
    std::atomic<float> compressorIntensity { 0.0f };
    // 0=Off, 1=80 Hz, 2=240 Hz. Off maps to the detector's explicit zero-Hz
    // bypass sentinel; it is not approximated by a low-but-active filter.
    std::atomic<float> compressorSidechainHPF { 1.0f };
    std::atomic<float> compressorMix { 0.65f };
    std::atomic<float> compressorVolumeDb { 0.0f };
    std::atomic<float> compressorComp { 0.35f };
    std::atomic<float> octaverEnabled { 0.0f };
    std::atomic<float> octaverDownMix { 0.32f };
    std::atomic<float> octaverUpMix { 0.18f };
    std::atomic<float> octaverDirectMix { 1.0f };
    // PRE EQ: a clean, independently bypassable stereo equalizer placed after
    // the Octaver and before the native Drive/Distortion island. V19 replaces
    // the original seven octave bands with this guitar-focused eight-band set.
    std::atomic<float> preEqEnabled { 0.0f };
    std::atomic<float> preEq120Db { 0.0f };
    std::atomic<float> preEq250Db { 0.0f };
    std::atomic<float> preEq500Db { 0.0f };
    std::atomic<float> preEq1kDb { 0.0f };
    std::atomic<float> preEq2k5Db { 0.0f };
    std::atomic<float> preEq5kDb { 0.0f };
    std::atomic<float> preEq8kDb { 0.0f };
    std::atomic<float> preEq12kDb { 0.0f };
    // HPF: 0=Off, otherwise 35..180 Hz. LPF: 24000=Off, otherwise
    // 3000..20000 Hz. Hidden values retain the last active endpoints so an
    // OFF transition can keep its biquad warm and re-enter without stale state.
    std::atomic<float> preEqHPFHz { 0.0f };
    std::atomic<float> preEqLPFHz { 24000.0f };
    std::atomic<float> preEqHPFLastActiveHz { 80.0f };
    std::atomic<float> preEqLPFLastActiveHz { 12000.0f };
    std::atomic<float> precisionDriveEnabled { 0.0f };
    // V15 voice selector: 0 keeps the exact established Precision circuit;
    // 1 selects the separate Maxon OD808 feedback-diode circuit.
    std::atomic<float> precisionDriveVoice { 0.0f };
    std::atomic<float> precisionDriveVolumeDb { 9.0f };
    std::atomic<float> precisionDriveBright { 0.55f };
    std::atomic<float> precisionDriveAttack { 0.50f };
    std::atomic<float> precisionDriveGate { 0.0f };
    std::atomic<float> precisionDriveDrive { 0.35f };
    // Legacy project-state field. Distortion is now its own dedicated
    // high-gain pedal and Precision Drive always uses its current feedback circuit.
    std::atomic<float> precisionDriveMode { 0.0f };
    std::atomic<float> chaosEnabled { 0.0f };
    // Current high-gain voicings: 0=Heavy, 1=Extreme, 2=Crunch.
    std::atomic<float> chaosMode { 0.0f };
    // Pre-distortion low-frequency contour: 0=Tight, 1=Thick.
    std::atomic<float> chaosWeight { 0.50f };
    std::atomic<float> chaosDrive { 0.62f };
    std::atomic<float> chaosTone { 0.55f };
    std::atomic<float> chaosMix { 1.0f };
    std::atomic<float> chaosLevelDb { 0.0f };
    // Input-keyed, post-circuit attenuation for the high-gain Distortion.
    // Zero is an exact bypass; the current default suppresses ordinary
    // interface/pickup idle noise without changing the open clipping curve.
    std::atomic<float> chaosGate { 0.22f };
    std::atomic<float> pedalMix { 1.0f };
    // Normalized NeuralAmpModeler Slim selections are resource configuration,
    // not realtime parameters. Fresh captures start on the model author's
    // highest-fidelity graph. Explicit preset/project Economy selections are
    // still restored verbatim.
    std::atomic<float> pedalModelSize { 1.0f };
    std::atomic<float> ampModelSize { 1.0f };
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
    // Graphic-EQ edge filters use explicit detent sentinels so their default
    // state is a sample-exact bypass instead of an inaudible approximation.
    // HPF: 0=Off, otherwise 20..500 Hz. LPF: 24000=Off, otherwise
    // 3000..20000 Hz; the higher sentinel gives the clockwise UI detent its
    // own stable serialized value without asking the DSP to approach Nyquist.
    std::atomic<float> eqHPFHz { 0.0f };
    std::atomic<float> eqLPFHz { 24000.0f };
    // Hidden recall values preserve the user's last active cutoff while the
    // visible controls sit in their endpoint OFF detents.
    std::atomic<float> eqHPFLastActiveHz { 80.0f };
    std::atomic<float> eqLPFLastActiveHz { 12000.0f };
    std::atomic<float> eqLevelDb { 0.0f };
    std::atomic<bool> cabRequestedEnabled { false };
    std::atomic<float> cabEnabled { 0.0f };
    std::atomic<float> cabLevelDb { 0.0f };
    // Retired Cab V1/V2 filter fields remain only so old state can migrate its
    // cutoff intent into Graphic EQ. Cab V3 never processes these values.
    std::atomic<float> cabHPFEnabled { 0.0f };
    std::atomic<float> cabLPFEnabled { 0.0f };
    std::atomic<float> cabHPFHz { 30.0f };
    std::atomic<float> cabLPFHz { 16000.0f };
    // 0 = dual mono (one IR response applied independently), 1 = stereo IR.
    std::atomic<float> cabIRStereo { 0.0f };
    // Bass-only latency-aligned DI mixed after the processed rack path.
    std::atomic<float> cabDirectMix { 0.0f };
    std::atomic<float> cabPhaseInvert { 0.0f };
    // Post-cabinet presentation field. Room and Doubler have explicit power
    // state so their audible settings survive bypass.
    std::atomic<float> cabRoomEnabled { 0.0f };
    std::atomic<float> cabRoomAmount { 0.22f };
    std::atomic<float> cabRoomWidth { 0.65f };
    std::atomic<float> cabDoublerEnabled { 0.0f };
    std::atomic<float> cabDoublerMix { 0.12f };
    std::atomic<float> cabDoublerSpread { 0.65f };
    std::atomic<float> cabDoublerDelayMs { 4.5f };
    std::atomic<float> cabPan { 0.0f };
    std::atomic<float> eqEnabled { 0.0f };
    std::atomic<float> chorusMix { 0.30f };
    std::atomic<float> chorusRateHz { 0.75f };
    std::atomic<float> chorusDepth { 0.32f };
    std::atomic<float> chorusCharacter { 1.0f }; // 0=Clean, 1=Ensemble
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
    // Dedicated synth-pad shimmer topology. It remains armed while Reverb is
    // bypassed and is applied when Reverb next receives input.
    std::atomic<float> reverbPad { 0.0f };
    // V5 voice selector: 0=Studio (the exact V4 sound), 1=Plate, 2=Hall,
    // 3=Room. This is a topology choice, not a historical DSP version.
    std::atomic<float> reverbVoice { 0.0f };
    // Retained only to deserialize old state. V5 derives these hidden values
    // from Voice, the six visible controls, and Instrument Profile.
    std::atomic<float> reverbCharacter { 1.0f };
    std::atomic<float> reverbWidth { 0.88f };
    std::atomic<float> reverbDucking { 0.0f };
    std::atomic<float> reverbBassDecay { 0.82f };
    std::atomic<float> reverbMovement { 0.25f };
    std::atomic<float> reverbEarlyLate { 0.55f };
    std::atomic<float> reverbDiffusion { 0.82f };
    std::atomic<float> reverbShimmerRegen { 0.55f };
    std::atomic<float> reverbFreeze { 0.0f };
    // Internal serialization identity. Restored state always canonicalizes to
    // the one reverb engine shipped by this unreleased product.
    // Test-visible migration identity only; process/prepare always overwrite
    // this with the current value before it can affect audio.
    std::atomic<float> reverbEngineVersion {
        static_cast<float>(currentReverbEngineVersion) };
    std::atomic<float> reverbEnabled { 0.0f };
    std::atomic<float> outputTrimDb { 0.0f };
    std::atomic<float> auditionSource { 0.0f };
    std::atomic<float> inputLevelDb { -90.0f };
    std::atomic<float> outputLevelDb { -90.0f };
    // Independent channel peaks back the adaptive input meter and the
    // always-stereo output meter. Keep the linked values above for mixed-
    // version frontends and callers that only need the loudest channel.
    std::atomic<float> inputLeftLevelDb { -90.0f };
    std::atomic<float> inputRightLevelDb { -90.0f };
    std::atomic<float> outputLeftLevelDb { -90.0f };
    std::atomic<float> outputRightLevelDb { -90.0f };

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
        tailAutomationDelay = 1u << 1,
        tailAutomationReverb = 1u << 2,
        // Reserved so serialized/compiled mask bits for later modules do not
        // shift. Retired Freeze automation is never accepted or interpreted.
        tailAutomationReservedReverbFreeze = 1u << 3,
        tailAutomationModulator = 1u << 4,
        tailAutomationCab = 1u << 5
    };
    double getAutomatedTailLengthSeconds(std::uint32_t moduleMask) const;
    double getMaximumAutomatedTailLengthSeconds() const;
    std::uint64_t getReverbTailCacheMissCount() const noexcept
    {
        return reverbTailCacheMissCount.load(
            std::memory_order_relaxed);
    }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    void getTonePresetStateInformation(juce::MemoryBlock& destData);
    static bool migratePresetStateToCurrent(
        juce::MemoryBlock& stateData,
        bool& wasMigrated);
    static juce::String getTonePresetAmpModelPath(
        const void* data,
        int sizeInBytes);
    static int getTonePresetInstrumentProfile(
        const void* data,
        int sizeInBytes);
    static bool migrateUiStateToCurrent(
        juce::var& uiState,
        int sourceEffectsVersion = 0);
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

    bool isOpenStudioBuiltIn() const { return true; }
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
    juce::String getPedalMetadataName() const;
    juce::String getAmpMetadataName() const;
    juce::String getPedalMetadataGearMake() const;
    juce::String getAmpMetadataGearMake() const;
    juce::String getPedalMetadataGearModel() const;
    juce::String getAmpMetadataGearModel() const;
    juce::String getPedalDeclaredCaptureType() const;
    juce::String getAmpDeclaredCaptureType() const;
    bool ampModelIncludesCab() const;
    bool hasSlimmableNAMModel() const;
    juce::var getNAMModelSizeState(bool pedalSlot) const;
    juce::var getPedalCalibrationState() const;
    juce::var getAmpCalibrationState() const;
    void setCabRequestedEnabled(bool enabled) noexcept;
    bool isCabRequestedEnabled() const noexcept;
    uint64_t getModelSnapshotLockMissCount() const noexcept;
    void resetModelSnapshotLockMissCount() noexcept;
    bool hasAuditionSourceActive() const noexcept;
    float getCompressorGainReductionDb() const noexcept;
    int getInstrumentProfile() const noexcept
    {
        const float profile = instrumentProfile.load(
            std::memory_order_relaxed);
        if (! std::isfinite(profile)
            || profile < 0.0f
            || profile > 1.0f)
            return guitarInstrumentProfile;
        return profile >= 0.5f
            ? bassInstrumentProfile
            : guitarInstrumentProfile;
    }
    bool isBassInstrumentProfile() const noexcept
    {
        return getInstrumentProfile() == bassInstrumentProfile;
    }
    // The host publishes the configured hardware route width before prepare
    // and every Rack callback. This is an atomic NAM-topology hint only: it
    // never rewrites buffer channels or changes the processor bus layout and
    // is safe to update from the realtime thread.
    void setRoutedInputChannelCount(int numChannels) noexcept
    {
        routedInputChannelCount.store(
            juce::jlimit(0, 64, numChannels),
            std::memory_order_release);
    }
    int getRoutedInputChannelCount() const noexcept
    {
        return routedInputChannelCount.load(
            std::memory_order_acquire);
    }
    void setEmbeddedDriveOversamplingFactor(int factor) noexcept;
    int getEmbeddedDriveOversamplingFactor() const noexcept;
    int getNAMEffectsDspVersion() const noexcept
    {
        return currentNAMEffectsDspVersion;
    }
    void useCurrentNAMEffectsDspVersion() noexcept
    {
        namEffectsDspVersion.store(
            currentNAMEffectsDspVersion,
            std::memory_order_relaxed);
    }
    juce::var getDiagnosticState() const;
    bool loadCabIR(const juce::String& path);
    void clearCabIR(bool deferActivePublication = false);
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
                                    std::shared_ptr<void>* retainedPublicationLease = nullptr,
                                    bool pedalModelSizeSpecified = false,
                                    float requestedPedalModelSize = 0.0f,
                                    bool ampModelSizeSpecified = false,
                                    float requestedAmpModelSize = 0.0f);
    void setUiStateJSON(const juce::String& json);
    juce::String getUiStateJSON() const;

private:
    friend class AudioEngine;
    friend class NAMDelayRegression;

    // Even stable biquad targets can produce large state transients when
    // retargeted in place. Install complete targets in a second, preallocated
    // filter and crossfade its output; do not reuse the old target's state.
    struct StableStereoBiquad
    {
        void prepare(const juce::dsp::ProcessSpec& spec,
                     double transitionSeconds);
        void setImmediate(const std::array<float, 5>& coefficients);
        void requestTarget(const std::array<float, 5>& coefficients) noexcept;
        void beginBlock();
        void processFrame(float& left,
                          float& right,
                          bool hasRight,
                          bool& recovered) noexcept;
        void endBlock() noexcept;
        void settleRequested();
        void resetState() noexcept;
        bool hasTransitionOrPending() const noexcept;

    private:
        struct StereoBank
        {
            juce::dsp::IIR::Filter<float> left;
            juce::dsp::IIR::Filter<float> right;
        };

        static void install(StereoBank& bank,
                            const std::array<float, 5>& coefficients);
        static float processSafely(juce::dsp::IIR::Filter<float>& filter,
                                   float input,
                                   bool& recovered) noexcept;

        std::array<StereoBank, 2> banks;
        std::array<float, 5> requestedCoefficients {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f
        };
        std::array<float, 5> activeCoefficients {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f
        };
        std::array<float, 5> transitionCoefficients {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f
        };
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
            transitionMix;
        double sampleRate = 44100.0;
        double transitionSeconds = 0.025;
        int activeBank = 0;
        int transitionBank = 1;
        bool targetPending = false;
        bool transitionActive = false;
    };

    // The requested profile is published lock-free by the UI. Audio processing
    // must nevertheless use one coherent Guitar/Bass decision for an entire
    // callback, otherwise a concurrent selector write could make adjacent
    // stages process the same block with different voicings. Direct private-
    // stage regression probes fall back to the live value unless they
    // explicitly establish the same callback scope.
    int getInstrumentProfileForCurrentBlock() const noexcept
    {
        return instrumentProfileBlockLatched
            ? activeInstrumentProfile
            : getInstrumentProfile();
    }
    bool isBassInstrumentProfileForCurrentBlock() const noexcept
    {
        return getInstrumentProfileForCurrentBlock()
            == bassInstrumentProfile;
    }
    void latchInstrumentProfileForBlock() noexcept
    {
        activeInstrumentProfile = getInstrumentProfile();
        instrumentProfileBlockLatched = true;
        diagnosticLastBlockInstrumentProfile.store(
            activeInstrumentProfile, std::memory_order_relaxed);
    }
    void releaseInstrumentProfileForBlock() noexcept
    {
        instrumentProfileBlockLatched = false;
    }

    // Headless regressions can attach preallocated buffers while the processor
    // is stopped, then capture exact internal stage outputs without changing
    // any production gain, routing, or DSP state. The pointer is always null
    // in hosted use; capture copies are bounded and allocation-free.
    enum class OfflineStageCapturePoint : size_t
    {
        preDriveInput = 0,
        postEmbeddedDrive,
        postAmp,
        postCab,
        finalRack,
        count
    };
    struct OfflineStageCaptureTarget
    {
        std::array<
            juce::AudioBuffer<float>*,
            static_cast<size_t>(OfflineStageCapturePoint::count)>
            destinations {};
        int writePosition = 0;
        int maximumSamples = 0;
    };
    OfflineStageCaptureTarget* offlineStageCaptureTarget = nullptr;
    void captureOfflineStage(
        OfflineStageCapturePoint point,
        const juce::AudioBuffer<float>& buffer) noexcept;

    static constexpr int namResamplerKernelTaps = 48;
    static constexpr int namResamplerKernelPhases = 512;
    static constexpr int namResamplerHistorySize = 128;
    static constexpr int namResamplerDryDelayCapacity = 128;

    struct NAMResamplerKernel
    {
        double inputRate = 44100.0;
        double outputRate = 44100.0;
        double sourceStep = 1.0;
        std::uint64_t sourceStepWhole = 1;
        std::uint64_t sourceStepRemainder = 0;
        std::uint64_t sourceStepDenominator = 1;
        double inverseSourceStepDenominator = 1.0;
        bool usesExactIntegerRatePhase = true;
        std::array<float, static_cast<size_t>(namResamplerKernelTaps * namResamplerKernelPhases)> coefficients {};

        void prepare(double newInputRate, double newOutputRate) noexcept;
    };

    struct NAMResamplerState
    {
        std::array<float, static_cast<size_t>(namResamplerHistorySize)> history {};
        int writeIndex = 0;
        std::int64_t totalInputSamples = 0;
        std::int64_t totalOutputSamples = 0;
        std::int64_t nextSourceWhole = 0;
        std::uint64_t nextSourceRemainder = 0;

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
        // Standard NAM captures expose one input and one output. True-stereo
        // Rack mode must never clock that stateful graph twice, so a 1x1
        // capture owns a separately constructed/prepared lane inside the same
        // atomically published model owner. Native stereo models leave this
        // null and run their 2x2 graph once.
        std::unique_ptr<LoadedNAMModel> dualMonoLane;
        // A secondary graph is an optional capability for standard 1x1 NAM
        // captures. If its off-thread preparation fails, retain the primary
        // graph so legacy single-NAM routing can still load and report why
        // true-stereo routing is unavailable for this owner.
        juce::String dualMonoPreparationWarning;
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
        juce::String metadataName;
        juce::String metadataGearMake;
        juce::String metadataGearModel;
        std::atomic<bool> includesCab { false };
        bool hasInputLevelDbu = false;
        bool hasOutputLevelDbu = false;
        double inputLevelDbu = 0.0;
        double outputLevelDbu = 0.0;
        bool isSlimmable = false;
        float activeSlimmableSize = 1.0f;
        std::vector<double> slimmableSizeBreakpoints;
        // Some NAM Slim implementations stage a replacement graph and only
        // install it from process(). Finalise that hand-off on the model
        // preparation thread before this owner can be published.
        bool slimmableSelectionNeedsActivation = false;
        float currentInputCalibrationGain = 1.0f;
        float currentOutputCalibrationGain = 1.0f;
        bool calibrationInitialised = false;
        // Model-core telemetry only. Non-finite samples are removed here
        // before they can poison later DSP state, but finite dynamics are
        // protected exactly once at the final rack output.
        std::array<float, 2> previousRawOutput {};
        std::array<bool, 2> hasPreviousRawOutput {};
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

    struct NAMOutputSafetyGuardResult
    {
        std::uint64_t guardedSampleFrameCount = 0;
        std::uint64_t invalidSampleFrameCount = 0;
        float maximumRawPeak = 0.0f;
        float maximumRawDelta = 0.0f;
    };

    enum class AmpModelHandoffPhase : std::uint8_t
    {
        steady,
        fadeOut,
        prime,
        fadeIn
    };

    struct LoadedCabIR;

    struct AmpModelHandoffState
    {
        std::atomic<LoadedNAMModel*> requestedModel { nullptr };
        std::atomic<LoadedNAMModel*> requestedPedalModel { nullptr };
        std::atomic<LoadedCabIR*> requestedCabIR { nullptr };
        std::atomic<bool> publishesResourceTransaction { false };
        std::atomic<std::uint64_t> requestGeneration { 0 };
        std::uint64_t consumedRequestGeneration = 0;
        AmpModelHandoffPhase phase = AmpModelHandoffPhase::steady;
        float currentGain = 1.0f;
        float phaseStartGain = 1.0f;
        int phaseSamplePosition = 0;
        int phaseSampleCount = 1;
        int primeSamplesRemaining = 0;
        bool phaseCompletesAfterBlock = false;
    };

    enum class InputRoutingHandoffPhase : std::uint8_t
    {
        steady,
        fadeOut,
        prime,
        fadeIn
    };

    struct InputRoutingHandoffState
    {
        int pendingMode = 0;
        InputRoutingHandoffPhase phase =
            InputRoutingHandoffPhase::steady;
        float currentGain = 1.0f;
        float phaseStartGain = 1.0f;
        int phaseSamplePosition = 0;
        int phaseSampleCount = 1;
        int primeSamplesRemaining = 0;
        bool phaseCompletesAfterBlock = false;
    };

    struct ModelHostConfigurationSnapshot
    {
        double sampleRate = 44100.0;
        int blockSize = 512;
        int bufferCapacity = 512;
        std::uint64_t generation = 0;
    };

    // A final-rack emergency bound, not a gate or a dynamics envelope.
    // Every finite sample at or below the knee is returned bit-for-bit, so
    // clean sustains and ordinary high-gain attacks cannot pump or recover.
    // A preset or model transition must never send an above-full-scale blast
    // to the device. This guard is bit-transparent below -0.45 dBFS and only
    // contains the final rack output as it approaches 0 dBFS.
    static constexpr float namOutputSafetyKnee = 0.95f;
    static constexpr float namOutputSafetyCeiling = 1.0f;
    // Finite numerical runaway is not made healthy merely by squeezing it
    // against a full-scale ceiling. Keep this threshold orders of magnitude
    // above any intentional control boost: ordinary over-level audio belongs
    // to the memoryless ceiling above and must never become a timed mute.
    static constexpr float namOutputEmergencyTripPeak = 4096.0f;
    static constexpr float namOutputEmergencyTripDelta = 8192.0f;
    static constexpr double namOutputEmergencyHoldSeconds = 0.25;
    static constexpr double namOutputEmergencyRecoverySeconds = 0.05;

    struct LoadedCabIR
    {
        bool hasStereoResponse = true;
        // Keep the direct 256-sample head zero-latency, but partition the long
        // tail much more coarsely. Uniform partitioning at a 16-sample ASIO
        // block otherwise walks roughly one IR partition per 48 samples on
        // every callback (hundreds for an ordinary cabinet IR).
        juce::dsp::Convolution stereoConvolution {
            juce::dsp::Convolution::NonUniform { 256 }
        };
        juce::dsp::Convolution dualMonoConvolution {
            juce::dsp::Convolution::NonUniform { 256 }
        };
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
    std::atomic<std::uint64_t> modelResourcePublicationGeneration { 0 };
    ActiveNAMModelPointer fallbackPedalModel { nullptr };
    ActiveNAMModelPointer fallbackAmpModel { nullptr };
    ActiveCabIRPointer fallbackCabIR { nullptr };
    ActiveNAMModelPointer diagnosticLastBlockPedalModel { nullptr };
    ActiveNAMModelPointer diagnosticLastBlockAmpModel { nullptr };
    ActiveCabIRPointer diagnosticLastBlockCabIR { nullptr };
    AmpModelHandoffState ampModelHandoff;
    InputRoutingHandoffState inputRoutingHandoff;
    NAMModelReaderCounter modelReaders { 0 };
    // Every swapped owner survives at least until a later writer observes no
    // callbacks in the grace period. NAM graph destruction therefore remains
    // off the audio thread and cannot race a raw-pointer reader.
    std::vector<std::shared_ptr<LoadedNAMModel>> retiredModels;
    juce::String pedalModelPath;
    juce::String ampModelPath;
    mutable juce::CriticalSection modelSwapLock;
    mutable std::atomic<uint64_t> modelSnapshotLockMissCount { 0 };
    std::atomic<double> modelHostSampleRate { 44100.0 };
    std::atomic<int> modelHostBlockSize { 512 };
    std::atomic<int> modelHostBufferCapacity { 512 };
    std::atomic<std::uint64_t> modelHostConfigurationGeneration { 0 };
    // Serialises the short final host-generation check/publication hand-off
    // with prepareToPlay(). It is never acquired by processBlock(): realtime
    // readers continue to use the lock-free raw publications and grace period.
    mutable juce::CriticalSection modelHostPublicationLock;
    std::atomic<std::uint64_t> cabPublicationAttemptCount { 0 };
    std::atomic<std::uint64_t> cabPublicationStaleGenerationRejectCount { 0 };
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
    juce::AudioBuffer<float> cabStereoBuffer;
    juce::AudioBuffer<float> cabStereoTransitionBuffer;
    // Dual-NAM lanes are evaluated sequentially because the Rack shares its
    // prepared NAM scratch. Keep their host output and latency-matched dry
    // blocks separate until both stateful graphs have completed successfully;
    // this makes a runtime failure an atomic pair-wide dry fallback instead of
    // exposing one wet lane beside one dry lane for a callback.
    juce::AudioBuffer<float> dualNAMStagingBuffer;
    juce::AudioBuffer<float> dualNAMDelayedDryBuffer;
    juce::AudioBuffer<float> ampBypassBuffer;
    juce::AudioBuffer<float> cabDirectBuffer;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        cabDirectDelay { 2048 };
    int cabDirectDelaySamples = -1;
    juce::AudioBuffer<float> liveTransitionBuffer;
    // The detector runs on the calibrated rack input, but its linked gain is
    // consumed after the Pedal/Amp nonlinear stages. This preallocated lane
    // lets the gate suppress model/pedal self-noise without changing the
    // signal that excites either nonlinear processor.
    juce::AudioBuffer<float> globalGateGainBuffer;
    juce::AudioBuffer<float> preEqDryBuffer;
    juce::AudioBuffer<float> graphicEqDryBuffer;
    juce::AudioBuffer<float> postCabDryBuffer;
    std::vector<float*> namInputPtrs;
    std::vector<float*> namOutputPtrs;

    StableStereoBiquad lowShelfFilter;
    StableStereoBiquad midPeakFilter;
    StableStereoBiquad highShelfFilter;
    StableStereoBiquad presenceShelfFilter;
    std::array<StableStereoBiquad, 8> preEqFilters;
    juce::dsp::StateVariableTPTFilter<float> preEqHPF;
    juce::dsp::StateVariableTPTFilter<float> preEqLPF;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative>
        smoothedPreEqHPFCutoff;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative>
        smoothedPreEqLPFCutoff;
    std::array<StableStereoBiquad, 9> graphicEqFilters;
    juce::dsp::StateVariableTPTFilter<float> graphicEqHPF;
    juce::dsp::StateVariableTPTFilter<float> graphicEqLPF;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative>
        smoothedGraphicEqHPFCutoff;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative>
        smoothedGraphicEqLPFCutoff;
    OpenStudioCompressor rackCompressor;
    std::array<float, 2> compressorToneLowState {};
    float compressorToneLowpassCoefficient = 0.0f;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedCompressorToneLowGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedCompressorToneHighGain;
    NAMPolyOctaver rackPolyOctaver;
    OpenStudioSaturator rackChaos { true };
    static constexpr int maximumEmbeddedDriveLatencySamples = 512;
    // Drain the shared IIR oversampler incrementally after the complete
    // native-drive island reaches dry. This is deliberately spread across
    // ordinary callbacks: juce::dsp::Oversampling::reset() clears its full
    // prepared-capacity buffers and is not appropriate for an 8-sample
    // audio callback.
    static constexpr int embeddedDriveOversamplerDrainLengthSamples = 512;
    std::atomic<int> requestedEmbeddedDriveOversamplingFactor { 4 };
    std::atomic<int> activeEmbeddedDriveOversamplingFactor { 4 };
    std::unique_ptr<juce::dsp::Oversampling<float>>
        embeddedDriveOversampler;
    juce::AudioBuffer<float> embeddedDriveSharedDryBuffer;
    juce::AudioBuffer<float> embeddedDriveOperatingGainBuffer;
    // Both native-pedal gates are keyed from the untouched calibrated island
    // input. Their independent preallocated envelopes are consumed after the
    // corresponding complete circuit so closing a gate cannot change its
    // clipping curve or mix audio between the linked stereo channels.
    juce::AudioBuffer<float> precisionDriveGateGainBuffer;
    juce::AudioBuffer<float> chaosGateGainBuffer;
    juce::AudioBuffer<float> chaosPreDiodeBuffer;
    std::array<
        std::array<
            float,
            static_cast<size_t>(
                maximumEmbeddedDriveLatencySamples + 1)>,
        2>
        embeddedDriveSharedDryRing {};
    int embeddedDriveSharedDryWriteIndex = 0;
    int embeddedDriveOversamplingLatencySamples = 0;
    int embeddedDriveOversamplerDrainSamplesRemaining = 0;
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
        smoothedPrecisionDriveGateThresholdGain;
    // Voice changes morph linearly over 20 ms at the shared island's active
    // sample rate. Both circuit histories remain channel-local and warm while
    // the pedal is active, so automation never switches into a stale filter.
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDriveVoice;
    // Current Precision Drive topology. A frequency-selective feedback split
    // leaves the low band close to unity while applying the Drive gain to the
    // Attack-selected upper band before one asymmetric nonlinear cell. The
    // Rack's selected shared 2x/4x/8x island owns all resampling; these per-channel
    // states and parameter smoothers are fixed-size and realtime-safe.
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDriveBandGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDriveAttackCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDriveBrightCoefficient;
    // Bass keeps the Attack-selected low band substantially clean after the
    // nonlinear cell. The profile crossfade is smoothed so Guitar/Bass
    // changes cannot hard-switch the low-frequency waveform.
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPrecisionDriveBassLowPreservation;
    std::array<float, 2> precisionDriveAttackLowState {};
    std::array<float, 2> precisionDriveBassWetLowState {};
    std::array<float, 2> precisionDriveBrightLowState {};
    std::array<float, 2> precisionDriveDcInputState {};
    std::array<float, 2> precisionDriveDcOutputState {};
    // Separate Maxon OD808-family signal path. Body/Tight varies the canonical
    // 4.7 k / 47 nF feedback leg around its stock centre value, Bright drives
    // the complete second-order 808 Tone network, and the clipping op-amp is a
    // trapezoidally integrated dynamic feedback-diode circuit. No state is
    // shared with the V14 Precision circuit.
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerDriveResistanceOhms;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerFeedbackLegCapacitanceFarads;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerToneB0;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerToneB1;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerToneB2;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerToneA1;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedScreamerToneA2;
    std::array<float, 2> screamerInputHighPass1InputState {};
    std::array<float, 2> screamerInputHighPass1OutputState {};
    std::array<float, 2> screamerInputHighPass2InputState {};
    std::array<float, 2> screamerInputHighPass2OutputState {};
    std::array<float, 2> screamerPreviousClipInputState {};
    std::array<float, 2> screamerFeedbackLegHighPassState {};
    std::array<float, 2> screamerFeedbackVoltageState {};
    std::array<float, 2> screamerOpAmpOutputState {};
    std::array<float, 2> screamerToneState1 {};
    std::array<float, 2> screamerToneState2 {};
    std::array<float, 2> screamerOutputHighPassInputState {};
    std::array<float, 2> screamerOutputHighPassOutputState {};
    bool screamerCircuitWasActive = false;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosLevelGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosWetMix;
    // The current fixed-cost multi-cell distortion network lives inside the Rack's
    // selected shared island. All memory is per-channel and preallocated.
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPreGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosDensity;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosClippingSymmetry;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPreLowCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosFirmBlend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosCompressionBlend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosDiodeBlend;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosMakeupGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosWeightCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosInterstageLowCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPresenceCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPresenceAmount;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosBodyLowCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosBodyHighCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosBodyAmount;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosAttackLowCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosAttackHighCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosAttackAmount;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosHarshLowCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosHarshHighCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosHarshAmount;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosPostLowCoefficient;
    // Bass profile restores a bounded share of the clean sub-110 Hz band
    // after the nonlinear cells. The profile blend is smoothed independently
    // so Guitar/Bass changes cannot step the generated waveform.
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedChaosLowPreservation;
    // The Distortion topology can have a deliberately large compound
    // near-zero slope. This channel-linked, asymmetric smoother drives a C2
    // post-topology normalizer inside the shared oversampled island. It is
    // derived entirely from existing controls and therefore has no state or
    // automation surface of its own.
    float chaosSmallSignalScale = 1.0f;
    float chaosSmallSignalScaleTarget = 1.0f;
    float chaosSmallSignalRequestedScale = 1.0f;
    float chaosSmallSignalScaleAttackCoefficient = 1.0f;
    float chaosSmallSignalScaleReleaseCoefficient = 1.0f;
    int chaosSmallSignalReleaseHoldSamples = 0;
    int chaosSmallSignalReleaseHoldDurationSamples = 1;
    int chaosSmallSignalLastMode = 0;
    float chaosSmallSignalLastDrive = 0.62f;
    float chaosSmallSignalLastTone = 0.55f;
    float chaosSmallSignalLastWeight = 0.50f;
    int chaosSmallSignalLastProfile = guitarInstrumentProfile;
    bool chaosSmallSignalControlInitialized = false;
    // One callback-owned Mode/Drive snapshot feeds both the normalizer target
    // and topology resolver, preventing independently loaded UI atomics from
    // pairing a stale ceiling with a new high-gain voice for one block.
    float chaosBlockMode = 0.0f;
    float chaosBlockDrive = 0.62f;
    float chaosBlockTone = 0.55f;
    float chaosBlockWeight = 0.50f;
    int chaosBlockProfile = guitarInstrumentProfile;
    bool chaosRealtimeStateNeedsReset = false;
    bool chaosTopologyNeedsBypassSync = true;
    std::array<float, 2> chaosPreLowState {};
    std::array<float, 2> chaosWeightLowState {};
    std::array<float, 2> chaosCell1LowState {};
    std::array<float, 2> chaosCell2LowState {};
    std::array<float, 2> chaosPrimaryADAAInputState {};
    std::array<float, 2> chaosFirmADAAInputState {};
    std::array<float, 2> chaosCompressionADAAInputState {};
    std::array<bool, 2> chaosPrimaryADAAStatePrimed {};
    std::array<bool, 2> chaosFirmADAAStatePrimed {};
    std::array<bool, 2> chaosCompressionADAAStatePrimed {};
    std::array<float, 2> chaosPresenceLowState {};
    std::array<float, 2> chaosBodyLowState {};
    std::array<float, 2> chaosBodyHighState {};
    std::array<float, 2> chaosAttackLowState {};
    std::array<float, 2> chaosAttackHighState {};
    std::array<float, 2> chaosHarshLowState {};
    std::array<float, 2> chaosHarshHighState {};
    std::array<float, 2> chaosPostLowState {};
    std::array<float, 2> chaosBassDryLowState {};
    std::array<float, 2> chaosBassWetLowState {};
    std::array<float, 2> chaosDcInputState {};
    std::array<float, 2> chaosDcOutputState {};
    float chaosGateDetectorEnvelope = 0.0f;
    float chaosGateGain = 0.0f;
    int chaosGateHoldSamplesRemaining = 0;
    bool chaosGateOpen = false;
    bool chaosGateEnvelopeActiveForBlock = false;
    bool embeddedDriveIslandWasActive = false;
    bool embeddedDriveIslandTransitionOwnsFade = false;
    // +1 rising from settled bypass, -1 falling from settled wet, 0 none.
    int embeddedDriveIslandOwnedFadeDirection = 0;
    bool embeddedDriveIslandOwnedPrecisionWet = false;
    bool embeddedDriveIslandOwnedChaosWet = false;
    float embeddedDriveIslandOwnedChaosMix = 1.0f;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedEmbeddedDriveIslandPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedEmbeddedDriveOperatingGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedCompressorStageGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPreEqPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPreEqHPFPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPreEqLPFPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedGraphicEqPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedGraphicEqHPFPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedGraphicEqLPFPower;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedGraphicEqLevelGain;
    OpenStudioChorus rackChorus;
    NAMCabPresentation rackCabPresentation;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedModulatorAutoRandom;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedModulatorPedalMode;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedModulatorModeBlend;
    OpenStudioDelay rackDelay;
    OpenStudioReverb rackReverb;
    struct ReverbTailCache
    {
        bool valid = false;
        double sampleRate = 0.0;
        float engineVersion = 0.0f;
        int voiceIndex = studioReverbVoice;
        int algorithmIndex = 0;
        float roomSize = 0.0f;
        float wetLevel = 0.0f;
        float earlyLevel = 0.0f;
        bool freeze = false;
        float preDelayMs = 0.0f;
        float decaySeconds = 0.0f;
        float shimmerAmount = 0.0f;
        float shimmerRegen = 0.0f;
        float padMode = 0.0f;
        std::int64_t samples = 0;
    };
    ReverbTailCache reverbTailCache;
    std::atomic<std::uint64_t>
        reverbTailCacheMissCount { 0 };
    float cachedReverbMixForGains = -1.0f;
    float cachedReverbWetGain = 0.0f;
    float cachedReverbDryGain = 1.0f;
    bool cachedReverbUsesV3MixLaw = false;
    bool cachedReverbUsesV4WetLaw = false;
    bool compressorWasActive = false;
    int compressorBypassDrainSamples = 0;
    bool octaverWasActive = false;
    bool precisionDriveWasActive = false;
    bool chaosWasActive = false;
    bool cabWasActive = false;
    bool modulationWasActive = false;
    int modulationBypassDrainSamples = 0;
    bool delayWasActive = false;
    bool reverbWasActive = false;
    std::int64_t delayTailSamplesRemaining = 0;
    // Audio callback publication for host/offline tail queries. The mutable
    // sample countdown itself remains callback-owned.
    std::atomic<float> publishedDelayTailSeconds { 0.0f };
    std::int64_t reverbTailSamplesRemaining = 0;
    float delayTailMix = 0.0f;
    DelayMacroState delayTailMacro;
    bool delayTailMacroValid = false;
    float reverbTailWet = 0.0f;
    float reverbTailEarly = 0.0f;
    float precisionDriveGateEnvelope = 0.0f;
    float precisionDriveGateGain = 1.0f;
    int precisionDriveGateHoldSamplesRemaining = 0;
    bool precisionDriveGateOpen = true;
    bool precisionDriveGateEnvelopeActiveForBlock = false;
    std::array<float, 2> ampVoiceLowState {};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedInputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedInputMonoMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAuditionSourceMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedOutputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedPedalMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpPowerMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpInputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpOutputGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpVoiceLowCoefficient;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpVoiceLowMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedAmpVoiceHighMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabLevelGain;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabPolarity;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabStereoMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabDirectMix;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedCabPan;
    int inputMeterHoldSamplesRemaining = 0;
    int outputMeterHoldSamplesRemaining = 0;
    std::array<int, 2> inputChannelMeterHoldSamplesRemaining {};
    std::array<int, 2> outputChannelMeterHoldSamplesRemaining {};
    using PostCabOrderPublication = std::atomic<std::uint32_t>;
    static_assert(
        PostCabOrderPublication::is_always_lock_free,
        "Realtime post-cab order publication must be lock-free");
    // Four two-bit module IDs in serial-processing order: EQ, Mod, Delay,
    // Reverb. UI publication is coherent; the callback never observes a torn
    // permutation while a drag/drop update is being written.
    static constexpr std::uint32_t defaultPostCabOrderPacked = 0xE4u;
    PostCabOrderPublication requestedPostCabOrderPacked {
        defaultPostCabOrderPacked
    };
    std::uint32_t activePostCabOrderPacked =
        defaultPostCabOrderPacked;
    std::uint32_t pendingPostCabOrderPacked =
        defaultPostCabOrderPacked;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedPostCabProcessedMix;
    // 0=steady, 1=fading the active order to dry, 2=fading the newly committed
    // order back in. Only the audio callback mutates this transition state.
    int postCabOrderTransitionStage = 0;
    double cachedSampleRate = 44100.0;
    int cachedBlockSize = 512;
    int realtimeBufferCapacity = 512;
    // Audio-thread publication only. Public tail queries consume this atomic
    // and never access the host playhead outside processBlock().
    std::atomic<float> publishedTempoBpm { 0.0f };
    // Audio-thread snapshot so Pedal, Amp, transition, and bypass paths cannot
    // observe different routing modes within one callback.
    int activeInputRoutingMode = 0;
    int activeInstrumentProfile = guitarInstrumentProfile;
    bool instrumentProfileBlockLatched = false;
    // TrackProcessor publishes the physical/routed source width before each
    // process call. Standalone probes default to stereo capability so their
    // existing direct OpenStudioNAMRack contract remains deterministic.
    std::atomic<int> routedInputChannelCount { 2 };
    float lastBassDb = 999.0f;
    float lastMidDb = 999.0f;
    float lastTrebleDb = 999.0f;
    float lastPresenceDb = 999.0f;
    int lastToneInstrumentProfile = -1;
    std::array<float, 8> lastPreEqDb {};
    int lastPreEqInstrumentProfile = -1;
    float lastPreEqHPFHz = -1.0f;
    float lastPreEqLPFHz = -1.0f;
    std::array<float, 9> lastGraphicEqDb {};
    int lastGraphicEqInstrumentProfile = -1;
    float lastGraphicEqHPFHz = -1.0f;
    float lastGraphicEqLPFHz = -1.0f;
    std::array<float, 5> lowShelfTarget {};
    std::array<float, 5> midPeakTarget {};
    std::array<float, 5> highShelfTarget {};
    std::array<float, 5> presenceShelfTarget {};
    std::array<std::array<float, 5>, 8> preEqTargets {};
    std::array<std::array<float, 5>, 9> graphicEqTargets {};
    static constexpr int filterGainTableSize = 241;
    std::array<
        std::array<std::vector<std::array<float, 5>>, 4>,
        2> toneFilterTables;
    std::array<
        std::array<std::vector<std::array<float, 5>>, 8>,
        2> preEqFilterTables;
    std::array<
        std::array<std::vector<std::array<float, 5>>, 9>,
        2> graphicEqFilterTables;
    bool filterTargetTablesPrepared = false;
    bool rackFilterCoefficientsInitialised = false;
    bool preEqHPFWasProcessing = false;
    bool preEqLPFWasProcessing = false;
    bool graphicEqHPFWasProcessing = false;
    bool graphicEqLPFWasProcessing = false;
    float gateEnvelope = 0.0f;
    float gateGain = 1.0f;
    float cachedGateThresholdDb = -101.0f;
    float cachedGateReleaseMs = -1.0f;
    double cachedGateSampleRate = 0.0;
    float cachedGateThresholdLinear = 0.0f;
    float cachedGateReleaseCoefficient = 0.0f;
    uint64_t auditionSourceSample = 0;
    std::atomic<int> diagnosticPreparedBlockSize { 512 };
    std::atomic<int> diagnosticBufferCapacity { 512 };
    std::atomic<int> diagnosticLastBlockSize { 0 };
    std::atomic<int> diagnosticLastBlockInstrumentProfile {
        guitarInstrumentProfile };
    std::atomic<int> diagnosticMaxBlockSize { 0 };
    std::atomic<uint64_t> diagnosticProcessedBlockCount { 0 };
    std::atomic<int> diagnosticLastDspFrames { 0 };
    std::atomic<int> diagnosticLastPedalDspFrames { 0 };
    std::atomic<int> diagnosticLastAmpDspFrames { 0 };
    std::atomic<int> diagnosticMaxDspFrames { 0 };
    std::atomic<float> diagnosticPreparedSampleRate { 44100.0f };
    std::atomic<float> diagnosticLastModelSampleRate { 0.0f };
    std::atomic<float> diagnosticLastInputPeakDb { -90.0f };
    std::atomic<float> diagnosticLastRawInputPeakDb { -90.0f };
    std::atomic<std::uint64_t> diagnosticInputNonFiniteSampleCount { 0 };
    std::atomic<float> diagnosticLastOutputPeakDb { -90.0f };
    std::atomic<float> diagnosticLastOutputPeakLinear { 0.0f };
    std::atomic<float> diagnosticMaximumOutputPeakLinear { 0.0f };
    std::atomic<float> diagnosticPedalNAMMaximumRawOutputPeakLinear { 0.0f };
    std::atomic<float> diagnosticAmpNAMMaximumRawOutputPeakLinear { 0.0f };
    std::atomic<float> diagnosticPedalNAMMaximumRawOutputDeltaLinear { 0.0f };
    std::atomic<float> diagnosticAmpNAMMaximumRawOutputDeltaLinear { 0.0f };
    std::atomic<std::uint64_t> diagnosticAmpToneFilterRecoveryCount { 0 };
    std::atomic<std::uint64_t> diagnosticPreEqFilterRecoveryCount { 0 };
    std::atomic<std::uint64_t> diagnosticGraphicEqFilterRecoveryCount { 0 };
    std::array<float, 2> previousRackRawOutput {};
    std::array<bool, 2> hasPreviousRackRawOutput {};
    bool rackOutputEmergencyMuteActive = false;
    int rackOutputEmergencyHoldSamplesRemaining = 0;
    float rackOutputEmergencyRecoveryGain = 1.0f;
    std::atomic<float> diagnosticRackMaximumRawOutputPeakLinear { 0.0f };
    std::atomic<float> diagnosticRackMaximumRawOutputDeltaLinear { 0.0f };
    std::atomic<std::uint64_t> diagnosticRackOutputSafetyGuardHitCount { 0 };
    std::atomic<bool> diagnosticRackOutputEmergencyMuteActive { false };
    std::atomic<std::uint64_t> diagnosticRackOutputEmergencyMuteTripCount { 0 };
    std::atomic<float> diagnosticRackOutputEmergencyLastTripPeakLinear { 0.0f };
    std::atomic<float> diagnosticRackOutputEmergencyLastTripDeltaLinear { 0.0f };
    std::atomic<bool> diagnosticLastAuditionSourceActive { false };
    std::atomic<bool> diagnosticLastAuditionSourceRendered { false };
    std::atomic<bool> diagnosticLastResampled { false };
    std::atomic<int> diagnosticAudioThreadResizeAvoidedCount { 0 };
    std::atomic<int> diagnosticEmbeddedDriveHighRateCapacity { 0 };
    std::atomic<double> diagnosticEmbeddedDriveLastProcessMs { 0.0 };
    std::atomic<double> diagnosticEmbeddedDriveMaximumProcessMs { 0.0 };
    std::atomic<float> diagnosticDistortionInputPeakLinear { 0.0f };
    std::atomic<float> diagnosticDistortionInputRmsLinear { 0.0f };
    std::atomic<float> diagnosticDistortionOutputPeakLinear { 0.0f };
    std::atomic<float> diagnosticDistortionOutputRmsLinear { 0.0f };
    std::atomic<float> diagnosticPedalInputPeakLinear { 0.0f };
    std::atomic<float> diagnosticPedalInputRmsLinear { 0.0f };
    std::atomic<float> diagnosticAmpInputPeakLinear { 0.0f };
    std::atomic<float> diagnosticAmpInputRmsLinear { 0.0f };
    std::atomic<float> diagnosticPostCabPeakLinear { 0.0f };
    std::atomic<float> diagnosticPostCabRmsLinear { 0.0f };
    std::atomic<bool> diagnosticLastCabRoomInputSourceAvailable { false };
    std::atomic<float> diagnosticFinalRackPeakLinear { 0.0f };
    std::atomic<float> diagnosticFinalRackRmsLinear { 0.0f };
    std::atomic<int> diagnosticOversizeBypassCount { 0 };
    std::atomic<int> diagnosticModelProcessFailCount { 0 };
    std::atomic<int> diagnosticObservedTightBlockSize { 0 };
    std::atomic<int> diagnosticRealtimeSafetyBypassCount { 0 };
    std::atomic<bool> diagnosticRealtimeDSPBlocked { false };
    std::atomic<int> diagnosticActiveInputRoutingMode { 0 };
    std::atomic<int> diagnosticInputRoutingTransitionPhase { 0 };
    // Internal serialization identity. State from development builds is
    // migrated on restore instead of selecting an obsolete pedal circuit.
    // Test-visible migration identity only; process/prepare always overwrite
    // this with the current value before it can affect audio.
    std::atomic<int> namEffectsDspVersion { currentNAMEffectsDspVersion };

    void reclaimRetiredModelsFromEarlierPublication();
    void reclaimRetiredCabIRsFromEarlierPublication();
    void updateReportedLatency();
    bool readStableModelHostConfiguration(
        ModelHostConfigurationSnapshot& snapshot) const noexcept;
    void resetAmpModelHandoffForCurrentOwner() noexcept;
    void resetInputRoutingHandoff() noexcept;
    void beginInputRoutingHandoffBlock(
        float* handoffGainEnvelope,
        int numSamples,
        bool hasActiveNAMModel,
        bool stereoRoutingCapable) noexcept;
    void finishInputRoutingHandoffBlock(
        int processedBlockSamples) noexcept;
    LoadedNAMModel* beginAmpModelHandoffBlock(
        float* handoffGainEnvelope,
        int numSamples,
        LoadedNAMModel* coherentActiveModel) noexcept;
    void finishAmpModelHandoffBlock(int processedBlockSamples) noexcept;
    static void resetModelStreamingState(LoadedNAMModel& model,
                                         double hostSampleRate,
                                         double modelSampleRate,
                                         int hostBufferCapacity);
    static void processModelDryDelay(juce::AudioBuffer<float>& buffer,
                                     LoadedNAMModel& model,
                                     int numSamplesToProcess) noexcept;
    static void processAmpBypassDryDelay(juce::AudioBuffer<float>& buffer,
                                         LoadedNAMModel& model,
                                         int numSamplesToProcess) noexcept;
    void processAmpBypassDryDelayForRouting(
        juce::AudioBuffer<float>& buffer,
        LoadedNAMModel& model,
        int numSamplesToProcess) noexcept;
    std::shared_ptr<LoadedNAMModel> prepareModel(const juce::String& path,
                                                 juce::String& error,
                                                 const juce::String& declaredCaptureType,
                                                 float requestedModelSize);
    bool prepareModelForHostConfiguration(LoadedNAMModel& model,
                                          double hostSampleRate,
                                          int hostBufferCapacity,
                                          juce::String& error);
    std::shared_ptr<LoadedCabIR> prepareCabIR(const juce::File& irFile,
                                             double durationSeconds,
                                             double hostSampleRate,
                                             int hostBlockSize,
                                             juce::String& error);
    bool publishPreparedCabIR(std::shared_ptr<LoadedCabIR> prepared,
                              bool deferActivePublication = false);
    bool commitPreparedModel(std::shared_ptr<LoadedNAMModel> loaded,
                             bool pedalSlot,
                             bool applyDirectLoadPolicy,
                             bool reclaimEarlierPublication = true,
                             juce::String* error = nullptr,
                             bool deferActivePublication = false);
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
                        bool pedalSlot,
                        int serialMonoDryChannel = -1);
    void processNAMModelCore(juce::AudioBuffer<float>& buffer,
                             LoadedNAMModel* model,
                             const float* mixEnvelope,
                             bool pedalSlot,
                             int serialMonoDryChannel);
    void processNAMModelLaneCore(juce::AudioBuffer<float>& buffer,
                                 LoadedNAMModel* model,
                                 const float* mixEnvelope,
                                 bool pedalSlot,
                                 int serialMonoDryChannel,
                                 float* delayedDryCapture = nullptr);
    static NAMOutputSafetyGuardResult applyNAMOutputSafetyGuard(
        juce::AudioBuffer<float>& modelOutput,
        int modelOutputChannels,
        int numSamplesToProcess,
        std::array<float, 2>& previousRawOutput,
        std::array<bool, 2>& hasPreviousRawOutput) noexcept;
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
    void updatePreEQFiltersIfNeeded();
    void updateGraphicEQFiltersIfNeeded();
    void resetCompressorToneStage(bool active) noexcept;
    void processCompressorToneStage(
        juce::AudioBuffer<float>& buffer,
        bool active) noexcept;
    void processCompressorStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processDualOctaverStage(juce::AudioBuffer<float>& buffer);
    void processPreEQ(juce::AudioBuffer<float>& buffer);
    void processEmbeddedDriveIsland(
        juce::AudioBuffer<float>& buffer,
        juce::MidiBuffer& midi);
    void completeEmbeddedDriveOwnedFadeToBypass() noexcept;
    void drainEmbeddedDriveOversamplerState(
        int numChannels,
        int maximumHostSamples) noexcept;
    void resetScreamerCircuitState() noexcept;
    void resetPrecisionDriveGateState(bool bypassed) noexcept;
    void preparePrecisionDriveGateGainEnvelope(
        const juce::AudioBuffer<float>& cleanIslandInput,
        bool precisionDriveMayProduceOutput) noexcept;
    void resetChaosGateState(bool bypassed) noexcept;
    void prepareChaosGateGainEnvelope(
        const juce::AudioBuffer<float>& cleanIslandInput,
        bool distortionMayProduceOutput) noexcept;
    static constexpr float chaosSmallSignalNormalizerAnchor = 0.25f;
    static constexpr float chaosSmallSignalGainCeilingDb = 32.0f;
    static float resolveChaosSmallSignalScale(
        float modeValue,
        float driveAmount) noexcept;
    static float applyChaosSmallSignalNormalizer(
        float input,
        float scale) noexcept;
    void prepareChaosSmallSignalNormalizer(
        double embeddedSampleRate) noexcept;
    void setChaosSmallSignalNormalizerTarget(
        float modeValue,
        float driveAmount,
        float toneAmount,
        float weightAmount,
        int instrumentProfileValue,
        bool immediate) noexcept;
    float getNextChaosSmallSignalScale() noexcept;
    void skipChaosSmallSignalNormalizer(int numSamples) noexcept;
    void synchroniseChaosTopologyWhileBypassed() noexcept;
    void processPrecisionDriveStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processChaosStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
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
    std::int64_t getCachedReverbTailSamples(
        float engineVersion,
        int voiceIndex,
        int algorithmIndex,
        float roomSize,
        float wetLevel,
        float earlyLevel,
        bool freeze,
        float preDelayMs,
        float decaySeconds,
        float shimmerAmount,
        float shimmerRegen,
        float padMode) noexcept;
    void processReverbStage(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void processPostFX(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioNAMRack)
};

// ============================================================================
// OpenStudioBasicSynthInstrument -- Built-in polyphonic subtractive synth
// ============================================================================
class OpenStudioBasicSynthInstrument : public juce::AudioProcessor
{
public:
    BuiltInInstrumentPerformance performanceTelemetry;
    OpenStudioBasicSynthInstrument();
    ~OpenStudioBasicSynthInstrument() override = default;

    std::atomic<float> attackMs { 8.0f };
    std::atomic<float> decayMs { 250.0f }, sustain { .75f }, oscillatorBlend { .5f };
    std::atomic<float> releaseMs { 180.0f };
    std::atomic<float> brightness { 0.62f };
    std::atomic<float> detuneCents { 7.0f };
    std::atomic<float> subLevel { 0.18f };
    std::atomic<float> noiseLevel { 0.015f };
    std::atomic<float> outputGain { -15.0f };

    std::atomic<float> filterMode { 0 }, filterCutoff { 4000 }, filterQ { .707f }, filterKeyTrack { 0 }, filterEnvelope { 0 };
    std::atomic<float> lfoDestination { 0 }, lfoRate { 1 }, lfoDepth { 0 }, lfoShape { 0 };
    std::atomic<float> filterEnvelopeSource { 0 }, filterAttackMs { 10 }, filterDecayMs { 300 }, filterSustain { .25f }, filterReleaseMs { 250 }, filterVelocity { 0 };
    std::atomic<float> lfoMode{0},wheelMode{0};
    std::atomic<float> oscillatorAShape{0},oscillatorBShape{1};
    std::atomic<float> matrix1Source{0},matrix1Target{0},matrix1Amount{0};
    std::atomic<float> matrix2Source{0},matrix2Target{0},matrix2Amount{0};
    std::atomic<float> matrix3Source{0},matrix3Target{0},matrix3Amount{0};
    std::atomic<float> matrix4Source{0},matrix4Target{0},matrix4Amount{0};
    std::atomic<float> matrix5Source{0},matrix5Target{0},matrix5Amount{0};
    std::atomic<float> matrix6Source{0},matrix6Target{0},matrix6Amount{0};
    std::atomic<float> matrix7Source{0},matrix7Target{0},matrix7Amount{0};
    std::atomic<float> matrix8Source{0},matrix8Target{0},matrix8Amount{0};
    std::atomic<float> macro1{0},macro2{0},macro3{0},macro4{0};
    std::atomic<float> macro1CC{0},macro2CC{0},macro3CC{0},macro4CC{0};
    std::atomic<float> macro1Channel{0},macro2Channel{0},macro3Channel{0},macro4Channel{0};
    BuiltInSynthCCMacros ccMacros;
    void configureCCMacros() noexcept;

    struct ModulationControl { const char* id; const char* label; const char* unit; float minimum, maximum, initial; std::atomic<float> OpenStudioBasicSynthInstrument::* member; };
    std::atomic<float> mpeEnabled { 0 }, mpeLowerMembers { 15 }, mpeUpperMembers { 0 };
    std::atomic<float> mpeLowerBend { 48 }, mpeLowerMasterBend { 2 }, mpeUpperBend { 48 }, mpeUpperMasterBend { 2 };
    static constexpr std::array<ModulationControl, 54> modulationControls {{
        { "filterMode", "Filter", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::filterMode },
        { "filterCutoff", "Cutoff", "Hz", 20, 20000, 4000, &OpenStudioBasicSynthInstrument::filterCutoff },
        { "filterQ", "Resonance", "Q", .5f, 12, .707f, &OpenStudioBasicSynthInstrument::filterQ },
        { "filterKeyTrack", "Key track", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::filterKeyTrack },
        { "filterEnvelope", "Envelope", "oct", -4, 4, 0, &OpenStudioBasicSynthInstrument::filterEnvelope },
        { "lfoDestination", "Destination", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::lfoDestination },
        { "lfoRate", "LFO rate", "Hz", .05f, 20, 1, &OpenStudioBasicSynthInstrument::lfoRate },
        { "lfoDepth", "LFO depth", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::lfoDepth },
        { "lfoShape", "LFO shape", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::lfoShape },
        { "filterEnvelopeSource", "Envelope source", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::filterEnvelopeSource },
        { "filterAttackMs", "Filter attack", "ms", .1f, 5000, 10, &OpenStudioBasicSynthInstrument::filterAttackMs },
        { "filterDecayMs", "Filter decay", "ms", 1, 5000, 300, &OpenStudioBasicSynthInstrument::filterDecayMs },
        { "filterSustain", "Filter sustain", "", 0, 1, .25f, &OpenStudioBasicSynthInstrument::filterSustain },
        { "filterReleaseMs", "Filter release", "ms", 1, 10000, 250, &OpenStudioBasicSynthInstrument::filterReleaseMs },
        { "filterVelocity", "Velocity depth", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::filterVelocity },
        { "lfoMode", "LFO phase", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::lfoMode },
        { "wheelMode", "Wheel behavior", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::wheelMode },
        { "matrix1Source", "Route 1 Source", "", 0, 8, 0, &OpenStudioBasicSynthInstrument::matrix1Source },
        { "matrix1Target", "Route 1 Destination", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::matrix1Target },
        { "matrix1Amount", "Route 1 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix1Amount },
        { "matrix2Source", "Route 2 Source", "", 0, 8, 0, &OpenStudioBasicSynthInstrument::matrix2Source },
        { "matrix2Target", "Route 2 Destination", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::matrix2Target },
        { "matrix2Amount", "Route 2 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix2Amount },
        { "matrix3Source", "Route 3 Source", "", 0, 8, 0, &OpenStudioBasicSynthInstrument::matrix3Source },
        { "matrix3Target", "Route 3 Destination", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::matrix3Target },
        { "matrix3Amount", "Route 3 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix3Amount },
        { "mpeEnabled", "MIDI expression", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::mpeEnabled },
        { "mpeLowerMembers", "Lower members", "", 0, 15, 15, &OpenStudioBasicSynthInstrument::mpeLowerMembers },
        { "mpeUpperMembers", "Upper members", "", 0, 15, 0, &OpenStudioBasicSynthInstrument::mpeUpperMembers },
        { "mpeLowerBend", "Lower note bend", "st", 0, 96, 48, &OpenStudioBasicSynthInstrument::mpeLowerBend },
        { "mpeLowerMasterBend", "Lower master bend", "st", 0, 96, 2, &OpenStudioBasicSynthInstrument::mpeLowerMasterBend },
        { "mpeUpperBend", "Upper note bend", "st", 0, 96, 48, &OpenStudioBasicSynthInstrument::mpeUpperBend },
        { "mpeUpperMasterBend", "Upper master bend", "st", 0, 96, 2, &OpenStudioBasicSynthInstrument::mpeUpperMasterBend },
        { "oscillatorAShape", "Oscillator A", "", 0, 3, 0, &OpenStudioBasicSynthInstrument::oscillatorAShape },
        { "oscillatorBShape", "Oscillator B", "", 0, 3, 1, &OpenStudioBasicSynthInstrument::oscillatorBShape },
        { "matrix4Source", "Route 4 Source", "", 0, 12, 0, &OpenStudioBasicSynthInstrument::matrix4Source },
        { "matrix4Target", "Route 4 Destination", "", 0, 7, 0, &OpenStudioBasicSynthInstrument::matrix4Target },
        { "matrix4Amount", "Route 4 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix4Amount },
        { "matrix5Source", "Route 5 Source", "", 0, 12, 0, &OpenStudioBasicSynthInstrument::matrix5Source },
        { "matrix5Target", "Route 5 Destination", "", 0, 7, 0, &OpenStudioBasicSynthInstrument::matrix5Target },
        { "matrix5Amount", "Route 5 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix5Amount },
        { "matrix6Source", "Route 6 Source", "", 0, 12, 0, &OpenStudioBasicSynthInstrument::matrix6Source },
        { "matrix6Target", "Route 6 Destination", "", 0, 7, 0, &OpenStudioBasicSynthInstrument::matrix6Target },
        { "matrix6Amount", "Route 6 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix6Amount },
        { "matrix7Source", "Route 7 Source", "", 0, 12, 0, &OpenStudioBasicSynthInstrument::matrix7Source },
        { "matrix7Target", "Route 7 Destination", "", 0, 7, 0, &OpenStudioBasicSynthInstrument::matrix7Target },
        { "matrix7Amount", "Route 7 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix7Amount },
        { "matrix8Source", "Route 8 Source", "", 0, 12, 0, &OpenStudioBasicSynthInstrument::matrix8Source },
        { "matrix8Target", "Route 8 Destination", "", 0, 7, 0, &OpenStudioBasicSynthInstrument::matrix8Target },
        { "matrix8Amount", "Route 8 Amount", "", -1, 1, 0, &OpenStudioBasicSynthInstrument::matrix8Amount },
        { "macro1", "Macro 1", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::macro1 },
        { "macro2", "Macro 2", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::macro2 },
        { "macro3", "Macro 3", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::macro3 },
        { "macro4", "Macro 4", "", 0, 1, 0, &OpenStudioBasicSynthInstrument::macro4 }
    }};
    std::array<float, 9> modulationValues() const noexcept;
    std::array<float, 11> matrixValues() const noexcept;
    std::array<float, 19> extendedMatrixValues() const noexcept;
    static constexpr std::array<ModulationControl,8> macroMappings {{
        {"macro1CC","Macro 1 controller","",0,120,0,&OpenStudioBasicSynthInstrument::macro1CC},
        {"macro1Channel","Macro 1 channel","",0,16,0,&OpenStudioBasicSynthInstrument::macro1Channel},
        {"macro2CC","Macro 2 controller","",0,120,0,&OpenStudioBasicSynthInstrument::macro2CC},
        {"macro2Channel","Macro 2 channel","",0,16,0,&OpenStudioBasicSynthInstrument::macro2Channel},
        {"macro3CC","Macro 3 controller","",0,120,0,&OpenStudioBasicSynthInstrument::macro3CC},
        {"macro3Channel","Macro 3 channel","",0,16,0,&OpenStudioBasicSynthInstrument::macro3Channel},
        {"macro4CC","Macro 4 controller","",0,120,0,&OpenStudioBasicSynthInstrument::macro4CC},
        {"macro4Channel","Macro 4 channel","",0,16,0,&OpenStudioBasicSynthInstrument::macro4Channel}
    }};
    BuiltInSynthMPE::Configuration mpeValues() const noexcept;
    bool setModulationControl(const juce::String& id, float value);

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { clearVoices(); }

    const juce::String getName() const override { return "OpenStudio Basic Synth"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    // Finite decay after note-off and pedal release, not held-note duration.
    double getTailLengthSeconds() const override;
    double getMaximumTailLengthSeconds() const noexcept;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isOpenStudioBuiltIn() const { return true; }
    bool isOpenStudioBuiltInInstrument() const { return true; }

private:
    std::atomic<double> tailSampleRate {192000.0};
    float releaseModulationBound() const noexcept;
    BuiltInSynthModulation modulation;
    BuiltInSynthMatrix matrix;
    std::array<std::array<BuiltInSynthMatrix::Destinations,16>,16> previousRoutes {};
    std::array<std::array<float,16>,16> sharedLfoOffset {};
    BuiltInSynthOscillators oscillators;
    BuiltInSynthMPE mpe;
    BuiltInSynthModulation::Voice globalModulationVoice;
    static_assert(BuiltInVoiceAllocation::voicesPerChannel==16);
    juce::SmoothedValue<float> filterEnvelopeBlend;
    std::array<std::array<BuiltInSynthEnvelope, 128>, 16> filterEnvelopes {};
    std::array<std::array<BuiltInSynthModulation::Voice, 128>, 16> modulationVoices {};
    BuiltInVoiceAllocation voicePool;
    BuiltInMIDIChannelMix channelMix;
    std::array<std::array<bool, 128>, 16> decaying {};
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

    void clearVoices(bool resetMPE = true);
    void handleMidi(const juce::MidiMessage& message);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioBasicSynthInstrument)
};

// ============================================================================
// OpenStudioPianoInstrument -- Built-in MIDI piano instrument
// ============================================================================
class OpenStudioPianoInstrument : public juce::AudioProcessor
{
public:
    BuiltInInstrumentPerformance performanceTelemetry;
    OpenStudioPianoInstrument();
    ~OpenStudioPianoInstrument() override = default;

    std::atomic<float> tone { 0.58f };
    std::atomic<float> body { 0.72f };
    std::atomic<float> hammer { 0.42f };
    std::atomic<float> releaseMs { 950.0f };
    std::atomic<float> outputGain { -15.0f };
    std::atomic<float> resonance { 0.38f };
    std::atomic<float> stereoWidth { 0.62f };
    std::atomic<float> model { 0.0f }; // 0=Studio Grand, 1=Bright Upright, 2=Soft Felt

    std::atomic<float> performanceMode { 0 }, velocityCurve { 0 }, strikeColour { .7f }, releaseVelocity { .5f }, damperCurve { 2 }, softPedalDepth { .6f };
    struct PerformanceControl { const char* id; const char* label; float minimum, maximum, initial; std::atomic<float> OpenStudioPianoInstrument::* member; };
    static constexpr std::array<PerformanceControl, 6> performanceControls {{
        { "performanceMode", "Performance", 0, 1, 0, &OpenStudioPianoInstrument::performanceMode },
        { "velocityCurve", "Velocity curve", -1, 1, 0, &OpenStudioPianoInstrument::velocityCurve },
        { "strikeColour", "Strike colour", 0, 1, .7f, &OpenStudioPianoInstrument::strikeColour },
        { "releaseVelocity", "Release velocity", 0, 1, .5f, &OpenStudioPianoInstrument::releaseVelocity },
        { "damperCurve", "Damper curve", 1, 4, 2, &OpenStudioPianoInstrument::damperCurve },
        { "softPedalDepth", "Soft pedal", 0, 1, .6f, &OpenStudioPianoInstrument::softPedalDepth }
    }};
    std::atomic<float> coupledBody{0}, bodyCoupling{.35f}, bodyDecay{2};
    static constexpr std::array<PerformanceControl,3> coupledBodyControls {{
        {"coupledBody","Coupled body",0,1,0,&OpenStudioPianoInstrument::coupledBody},
        {"bodyCoupling","String coupling",0,1,.35f,&OpenStudioPianoInstrument::bodyCoupling},
        {"bodyDecay","Body decay",.2f,8,2,&OpenStudioPianoInstrument::bodyDecay},
    }};
    bool setPerformanceControl(const juce::String& id, float value);

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { clearVoices(); }

    const juce::String getName() const override { return "OpenStudio Piano"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override;
    double getMaximumTailLengthSeconds() const noexcept;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isOpenStudioBuiltIn() const { return true; }
    bool isOpenStudioBuiltInInstrument() const { return true; }

private:
    std::atomic<double> tailSampleRate {192000.0};
    BuiltInCoupledBody coupledNetwork;
    juce::SmoothedValue<float> coupledAmount;
    std::array<std::array<bool, 128>, 16> expressiveVoice {}, sostenutoVoice {};
    std::array<std::array<float, 128>, 16> strikeGain {}, strikeTime {}, releaseSpeed {};
    std::array<std::array<double, 128>, 16> naturalDecay {};
    std::array<bool, 16> sostenutoPedal {};
    std::array<juce::SmoothedValue<float>, 16> continuousPedal, continuousSoft;
    juce::SmoothedValue<float> smoothedDamperCurve, smoothedSoftDepth;
    BuiltInVoiceAllocation voicePool;
    BuiltInMIDIChannelMix channelMix;
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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioPianoInstrument)
};

// ============================================================================
// OpenStudioCleanGuitarInstrument -- Built-in clean electric guitar instrument
// ============================================================================
class OpenStudioCleanGuitarInstrument : public juce::AudioProcessor
{
public:
    BuiltInInstrumentPerformance performanceTelemetry;
    BuiltInGuitarPerformance guitarPerformance;
    OpenStudioCleanGuitarInstrument();
    ~OpenStudioCleanGuitarInstrument() override = default;

    std::atomic<float> model { 0.0f };      // 0=T-style DI, 1=S-style DI, 2=Clean US Combo, 3=JC-style Chorus Clean
    std::atomic<float> tone { 0.68f };
    std::atomic<float> body { 0.46f };
    std::atomic<float> pickNoise { 0.32f };
    std::atomic<float> releaseMs { 210.0f };
    std::atomic<float> chorus { 0.0f };
    std::atomic<float> stringMode { 1.0f }; // 0=auto, 1=MIDI ch 1-6 strings, 2=MIDI ch 2-7 strings
    std::atomic<float> bendRangeSemitones { 2.0f };
    std::atomic<float> outputGain { -14.0f };

    std::atomic<float> stringEngine { 0 }, stringDecay { 3 }, stringDamping { .35f }, pickPosition { .2f }, pickHardness { .5f }, pickupPosition { .15f }, palmMute { 0 };
    std::atomic<float> chorusMix { 0 }, chorusRate { .8f }, chorusDepth { 2.5f };
    struct StringControl { const char* id; const char* label; const char* unit; float minimum, maximum, initial; std::atomic<float> OpenStudioCleanGuitarInstrument::* member; };
    static constexpr std::array<StringControl, 10> stringControls {{
        { "stringEngine", "Engine", "", 0, 1, 0, &OpenStudioCleanGuitarInstrument::stringEngine },
        { "stringDecay", "Nominal decay", "s", .2f, 8, 3, &OpenStudioCleanGuitarInstrument::stringDecay },
        { "stringDamping", "String damping", "", 0, 1, .35f, &OpenStudioCleanGuitarInstrument::stringDamping },
        { "pickPosition", "Pick position", "", .05f, .5f, .2f, &OpenStudioCleanGuitarInstrument::pickPosition },
        { "pickHardness", "Pick hardness", "", 0, 1, .5f, &OpenStudioCleanGuitarInstrument::pickHardness },
        { "pickupPosition", "Pickup position", "", .05f, .5f, .15f, &OpenStudioCleanGuitarInstrument::pickupPosition },
        { "palmMute", "Palm mute", "", 0, 1, 0, &OpenStudioCleanGuitarInstrument::palmMute },
        { "chorusMix", "Chorus mix", "", 0, 1, 0, &OpenStudioCleanGuitarInstrument::chorusMix },
        { "chorusRate", "Chorus rate", "Hz", .05f, 5, .8f, &OpenStudioCleanGuitarInstrument::chorusRate },
        { "chorusDepth", "Chorus depth", "ms", 0, 6, 2.5f, &OpenStudioCleanGuitarInstrument::chorusDepth }
    }};
    std::atomic<float> articulation{0},articulationKeys{0},slideTime{90},harmonicNode{2};
    static constexpr std::array<StringControl,4> articulationControls {{
        {"articulation","Articulation","",0,8,0,&OpenStudioCleanGuitarInstrument::articulation},
        {"articulationKeys","Keyswitches","",0,1,0,&OpenStudioCleanGuitarInstrument::articulationKeys},
        {"slideTime","Slide time","ms",5,500,90,&OpenStudioCleanGuitarInstrument::slideTime},
        {"harmonicNode","Harmonic node","",2,6,2,&OpenStudioCleanGuitarInstrument::harmonicNode}
    }};
    std::atomic<float> coupledBody{0}, bodyCoupling{.35f}, bodyDecay{2};
    static constexpr std::array<StringControl,3> coupledBodyControls {{
        {"coupledBody","Coupled body","",0,1,0,&OpenStudioCleanGuitarInstrument::coupledBody},
        {"bodyCoupling","String coupling","",0,1,.35f,&OpenStudioCleanGuitarInstrument::bodyCoupling},
        {"bodyDecay","Body decay","s",.2f,8,2,&OpenStudioCleanGuitarInstrument::bodyDecay},
    }};
    bool setStringControl(const juce::String& id, float value);
    BuiltInPluckedLoop::Parameters loopParameters() const noexcept;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { clearVoices(); }

    const juce::String getName() const override { return "OpenStudio Clean Guitar"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override;
    double getMaximumTailLengthSeconds() const noexcept;

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isOpenStudioBuiltIn() const { return true; }
    bool isOpenStudioBuiltInInstrument() const { return true; }

private:
    std::atomic<double> tailSampleRate {192000.0};
    BuiltInCoupledBody coupledNetwork;
    juce::SmoothedValue<float> coupledAmount;
    BuiltInPluckedLoop pluckedLoop;
    std::array<int,16> liveArticulation {};
    std::array<std::array<int,16>,16> voiceArticulation {};
    std::array<std::array<float,16>,16> articulationMute {};
    std::array<std::array<bool,16>,16> slideOutStarted {};
    std::array<std::array<juce::SmoothedValue<float>,16>,16> articulationPitch;
    void beginSlideOut(size_t channel,size_t slot) noexcept;
    BuiltInGuitarChorus delayChorus;
    std::array<std::array<bool, 128>, 16> loopVoice {};
    std::array<juce::SmoothedValue<float>, 5> loopSmoothers;
    BuiltInVoiceAllocation voicePool;
    BuiltInMIDIChannelMix channelMix;
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
    void publishGuitarPerformance() noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioCleanGuitarInstrument)
};

// ============================================================================
// OpenStudioDrumInstrument -- Built-in MIDI drum instrument with GM/e-drum mapping
// ============================================================================
class OpenStudioDrumInstrument : public juce::AudioProcessor
{
public:
    BuiltInInstrumentPerformance performanceTelemetry;
    OpenStudioDrumInstrument();
    ~OpenStudioDrumInstrument() override = default;

    std::array<std::atomic<float>, 8> pieceGain {}; // dB: kick, snare, closed/open hats, low/high toms, crash, ride
    std::array<std::atomic<float>, 8> pieceTuning {}, piecePan {};
    std::array<std::atomic<float>, 8> pieceDecay {};
    std::array<std::atomic<float>, 8> pieceOutput {}; // 0=main; 1..8=exclusive stereo output pairs.
    std::atomic<float> articulationEngine {0}, customMapEnabled {0};
    std::array<std::atomic<float>,128> noteMap {};
    std::atomic<juce::uint32> observedNoteEvent {0};
    BuiltInDrumArticulations::Voice articulationForInput(int note) const noexcept;
    static int pieceForNote(int note);
    int mappedNote(int note) const { return mapIncomingNote(note); }
    juce::var describeMapping() const;
    std::atomic<float> kit { 0.0f };       // 0=Studio, 1=Rock, 2=Electronic
    std::atomic<float> tuning { 0.0f };    // semitones
    std::atomic<float> ambience { 0.18f };
    std::atomic<float> outputGain { -10.0f };
    std::atomic<float> hihatTightness { 0.65f };
    std::atomic<float> mapPreset { 0.0f }; // 0=GM, 1=Roland TD
    std::atomic<float> punch { 0.55f };
    std::atomic<float> stereoWidth { 0.7f };
    std::atomic<float> velocityCurve { 0.0f }; // Legacy exponent: -1=1.65, 0=1.135, +1=.62

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void releaseResources() override;
    void reset() override { clearVoices(); }

    const juce::String getName() const override { return "OpenStudio Drums"; }
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { float maximum=1;for(const auto& value:pieceDecay)maximum=juce::jmax(maximum,value.load());return articulationEngine.load()>=.5f||maximum>1?14.0*maximum:2.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    bool isOpenStudioBuiltIn() const { return true; }
    bool isOpenStudioBuiltInInstrument() const { return true; }

private:
    std::array<juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative>, 8> pieceTuneSmoothers;
    std::array<juce::SmoothedValue<float>, 8> piecePanSmoothers;
    std::array<juce::SmoothedValue<float>, 8> pieceDecaySmoothers;
    std::array<std::array<BuiltInDrumArticulations::Voice,128>,16> voiceArticulations {};
    std::array<std::array<std::array<float,4>,128>,16> partialPhases {};
    std::array<std::array<int,128>,16> inputKeys {};
    BuiltInVoiceAllocation voicePool;
    BuiltInMIDIChannelMix channelMix;
    std::array<std::array<float, 128>, 16> chokeGain {};
    std::array<std::array<bool, 128>, 16> choking {};
    std::array<std::array<bool, 128>, 16> active {};
    std::array<std::array<float, 128>, 16> phase {};
    std::array<std::array<float, 128>, 16> velocity {};
    std::array<std::array<int, 128>, 16> ageSamples {};
    std::array<float, 16> hihatPedal {};
    double cachedSampleRate = 44100.0;

    void clearVoices();
    void handleMidi(const juce::MidiMessage& message);
    int mapIncomingNote(int note) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OpenStudioDrumInstrument)
};
