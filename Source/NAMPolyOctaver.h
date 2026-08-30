#pragma once

#include <JuceHeader.h>

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

/**
 * Stereo, fixed-ratio polyphonic octave generator for the NAM Rack.
 *
 * The DSP follows Steven Schulteis' MIT-licensed terrarium-poly-octave
 * implementation of Etienne Thuillier's ERB-PS2 method: a 6:1 multirate
 * front end, 80 complex ERB bands, and polyphase reconstruction.  This host
 * implementation keeps independent fixed state for two channels and carries
 * the six-sample resampling phase across arbitrary callback partitions.
 *
 * prepare(), reset(), and parameter writes follow the normal AudioProcessor
 * lifecycle. processBlock() performs no allocation, locking, logging, file
 * I/O, coefficient design, or dynamic container growth.
 */
class NAMPolyOctaver final
{
public:
    static constexpr int maximumChannels = 2;
    // Four sub-guitar ERB bands extend the same filter bank to 25.3 Hz for
    // five-string bass B0. Guitar keeps the original 60 Hz first band and is
    // therefore the bit-compatible default voicing.
    static constexpr int bassExtendedBandCount = 4;
    static constexpr int maximumBands = 84;
    static constexpr int resampleFactor = 6;

    struct VoiceFrame
    {
        float octaveDown = 0.0f;
        float octaveUp = 0.0f;
    };

    struct Diagnostics
    {
        double sampleRate = 0.0;
        double processingSampleRate = 0.0;
        int preparedMaximumBlockSize = 0;
        int activeBandCount = 0;
        int octaveUpBandCount = 0;
        int instrumentProfile = 0;
        int multirateFactor = 0;
        float lowestBandCentreHz = 0.0f;
        float highestBandCentreHz = 0.0f;
        float octaveUpPassbandHz = 0.0f;
        float octaveUpStopbandHz = 0.0f;
        float wetAntiAliasCutoffHz = 0.0f;
        int wetAntiAliasOrder = 0;
        float maximumGeneratedUpFrequencyHz = 0.0f;
        int reportedLatencySamples = 0;
        std::uint64_t processedBlocks = 0;
        std::uint64_t processedSamples = 0;
        std::uint64_t fastPathBlocks = 0;
        std::uint64_t nonFiniteRecoveries = 0;
        float lastBlockDownPeak = 0.0f;
        float lastBlockUpPeak = 0.0f;
    };

    struct SelfTestResult
    {
        bool passed = false;
        bool exactBypassPassed = false;
        bool exactSilencePassed = false;
        bool resetDeterminismPassed = false;
        bool partitionInvariantPassed = false;
        bool stereoIsolationPassed = false;
        bool identicalStereoParityPassed = false;
        bool finiteRecoveryPassed = false;
        bool targetFrequencyPassed = false;
        bool bassLowNotePassed = false;
        bool liveProfileSwitchPassed = false;
        bool liveProfileSwitchPartitionPassed = false;
        bool stopbandRejectionPassed = false;
        float maximumResetDifference = 0.0f;
        float maximumPartitionDifference = 0.0f;
        float maximumSilentChannelLeak = 0.0f;
        float maximumIdenticalStereoDifference = 0.0f;
        float minimumTargetDominanceDb = 0.0f;
        float minimumBassLowNoteDominanceDb = 0.0f;
        float maximumProfileSwitchDelta = 0.0f;
        float maximumProfileSwitchPartitionDifference = 0.0f;
        float stopbandRejectionDb = 0.0f;
        std::uint64_t nonFiniteRecoveries = 0;
    };

    NAMPolyOctaver() noexcept;

    /** Designs the sample-rate-dependent ERB bank and resets all history. */
    void prepare(double sampleRate, int maximumBlockSize) noexcept;

    /** Clears all phase/filter/resampling history deterministically. */
    void reset() noexcept;

    /**
     * Sets independent linear gains. Values are clamped to [0, 1.25] and
     * consumed through lock-free atomics at the next audio callback. A
     * 20-millisecond sample-domain ramp is applied by processBlock().
     */
    void setLevels(float directLevel,
                   float octaveDownLevel,
                   float octaveUpLevel) noexcept;

    /** Selects 0=Guitar (60 Hz first ERB band) or 1=Bass (25.3 Hz). */
    void setInstrumentProfile(int profile) noexcept;

    /** In-place production mixer: Direct + Octave Down + Octave Up. */
    void processBlock(juce::AudioBuffer<float>& buffer) noexcept;

    /**
     * Allocation-free raw-voice hook for deterministic headless tests.
     *
     * The input and output arrays must each contain numChannels valid channel
     * pointers. numChannels is clamped to the supported mono/stereo range.
     * This advances the exact production filter/resampling state but does not
     * apply the Direct/Down/Up level smoothers.
     */
    void processVoicesForTesting(const float* const* inputs,
                                 float* const* octaveDownOutputs,
                                 float* const* octaveUpOutputs,
                                 int numChannels,
                                 int numSamples) noexcept;

    [[nodiscard]] Diagnostics getDiagnostics() const noexcept;
    void resetDiagnostics() noexcept;

    /**
     * Runs allocation-using deterministic validation on the calling thread.
     * This is a headless QA hook and must never be called from the audio
     * callback. Subjective octave tone/voicing is deliberately not asserted.
     */
    [[nodiscard]] static SelfTestResult runDeterministicSelfTest(
        double sampleRate = 48000.0);

    [[nodiscard]] bool isPrepared() const noexcept
    {
        return prepared.load(std::memory_order_acquire);
    }

    /** The wet path is causal; its FIR/chunk delay is deliberately not PDC. */
    [[nodiscard]] static constexpr int getLatencySamples() noexcept { return 0; }

private:
    struct ComplexValue
    {
        float real = 0.0f;
        float imag = 0.0f;
    };

    struct BandCoefficients
    {
        float centreHz = 0.0f;
        float bandwidthHz = 0.0f;
        float d0 = 0.0f;
        ComplexValue d1;
        ComplexValue d2;
        ComplexValue c1;
        ComplexValue c2;
    };

    struct BandChannelState
    {
        ComplexValue state1;
        ComplexValue state2;
        ComplexValue previousBandOutput;
        float octaveDownSign = 1.0f;
    };

    template <std::size_t size>
    struct FixedRing
    {
        static_assert(size > 0 && (size & (size - 1)) == 0,
                      "FixedRing size must be a power of two");

        void push(float value) noexcept
        {
            position = (position - 1U) & (size - 1U);
            samples[position] = value;
        }

        [[nodiscard]] float atAge(std::size_t age) const noexcept
        {
            return samples[(position + age) & (size - 1U)];
        }

        void clear() noexcept
        {
            samples.fill(0.0f);
            position = 0;
        }

        std::array<float, size> samples {};
        std::size_t position = 0;
    };

    struct DecimatorState
    {
        float process(const std::array<float, resampleFactor>& input) noexcept;
        void reset() noexcept;

        [[nodiscard]] float stageOne() const noexcept;
        [[nodiscard]] float stageTwo() const noexcept;

        FixedRing<32> fullRate;
        FixedRing<16> oneThirdRate;
    };

    struct InterpolatorState
    {
        void process(float input,
                     std::array<float, resampleFactor>& output) noexcept;
        void reset() noexcept;

        [[nodiscard]] float stageOneEven() const noexcept;
        [[nodiscard]] float stageOneOdd() const noexcept;
        [[nodiscard]] float stageTwoPhaseZero() const noexcept;
        [[nodiscard]] float stageTwoPhaseOne() const noexcept;
        [[nodiscard]] float stageTwoPhaseTwo() const noexcept;

        FixedRing<32> reducedRate;
        FixedRing<16> oneThirdRate;
    };

    struct ChannelRateState
    {
        DecimatorState decimator;
        InterpolatorState downInterpolator;
        InterpolatorState upInterpolator;
        std::array<float, resampleFactor> pendingInput {};
        std::array<float, resampleFactor> pendingDownOutput {};
        std::array<float, resampleFactor> pendingUpOutput {};
        int phase = 0;
        bool downInterpolatorActive = false;
        bool upInterpolatorActive = false;
        float octaveDownDcInput = 0.0f;
        float octaveDownDcOutput = 0.0f;

        void reset() noexcept;
    };

    static constexpr float levelRampSeconds = 0.020f;
    static constexpr float phaseEnergyFloor = 1.0e-20f;
    static constexpr int wetAntiAliasOrder = 34;

    static float bandCentreHz(int erbIndex) noexcept;
    static float bandBandwidthHz(int erbIndex) noexcept;
    static float fastInverseSqrt(float value) noexcept;
    static float fastSqrt(float value) noexcept;
    static ComplexValue multiply(ComplexValue left,
                                 ComplexValue right) noexcept;

    void designFilterBank(double sampleRate) noexcept;
    void resetDspState() noexcept;
    void synchroniseLevelTargets() noexcept;
    void synchroniseProfileTargets() noexcept;
    VoiceFrame processVoiceSample(int channel,
                                  float input,
                                  bool generateOctaveDown,
                                  bool generateOctaveUp,
                                  std::uint64_t& nonFiniteCount) noexcept;
    VoiceFrame processReducedRateSample(int channel,
                                        float input,
                                        bool generateOctaveDown,
                                        bool generateOctaveUp,
                                        std::uint64_t& nonFiniteCount) noexcept;

    [[nodiscard]] bool wetPathIsExactlySilent() const noexcept;
    [[nodiscard]] bool directPathIsExactlyUnity() const noexcept;
    [[nodiscard]] bool allPathsAreExactlySilent() const noexcept;

    std::array<BandCoefficients, maximumBands> bands {};
    std::array<std::array<BandChannelState, maximumBands>, maximumChannels>
        channelStates {};
    std::array<ChannelRateState, maximumChannels> channelRateStates {};
    int activeBandCount = 0;
    int octaveUpBandCount = 0;
    bool dspStateIsReset = true;

    std::atomic<float> requestedDirectLevel { 1.0f };
    std::atomic<float> requestedOctaveDownLevel { 0.0f };
    std::atomic<float> requestedOctaveUpLevel { 0.0f };
    std::atomic<int> requestedInstrumentProfile { 0 };
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedDirectLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedOctaveDownLevel;
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>
        smoothedOctaveUpLevel;
    std::array<
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>,
        maximumChannels> smoothedBassProfile;

    std::atomic<bool> prepared { false };
    std::atomic<float> diagnosticSampleRate { 0.0f };
    std::atomic<int> diagnosticMaximumBlockSize { 0 };
    std::atomic<int> diagnosticActiveBandCount { 0 };
    std::atomic<int> diagnosticOctaveUpBandCount { 0 };
    float octaveDownHighPassCoefficient = 0.0f;
    std::atomic<float> diagnosticLowestBandCentreHz { 0.0f };
    std::atomic<float> diagnosticHighestBandCentreHz { 0.0f };
    std::atomic<float> diagnosticWetAntiAliasCutoffHz { 0.0f };
    std::atomic<std::uint64_t> diagnosticProcessedBlocks { 0 };
    std::atomic<std::uint64_t> diagnosticProcessedSamples { 0 };
    std::atomic<std::uint64_t> diagnosticFastPathBlocks { 0 };
    std::atomic<std::uint64_t> diagnosticNonFiniteRecoveries { 0 };
    std::atomic<float> diagnosticLastBlockDownPeak { 0.0f };
    std::atomic<float> diagnosticLastBlockUpPeak { 0.0f };

    static_assert(std::atomic<float>::is_always_lock_free,
                  "NAMPolyOctaver requires lock-free float atomics");
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
                  "NAMPolyOctaver requires lock-free diagnostic counters");

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(NAMPolyOctaver)
};
