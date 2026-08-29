#pragma once

#include <JuceHeader.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <vector>

/**
 * Allocation-free post-cabinet presentation field for the NAM Rack.
 *
 * The processor adds two parallel, wet-only components to an unchanged close
 * cabinet signal:
 *   - a true-stereo 2x2 early-reflection field feeding a short late room; and
 *   - a deterministic, transient-protected two-voice doubler.
 *
 * prepare() and reset() are message-thread operations. process() performs no
 * allocation, locking, logging, I/O, coefficient construction, or container
 * resizing. Parameter targets are lock-free atomics and all audible changes
 * are smoothed or delay-head crossfaded in the sample domain.
 */
class NAMCabPresentation final
{
public:
    struct Parameters
    {
        float roomAmount = 0.0f;       // 0..1; zero is exact bypass
        float roomWidth = 0.65f;       // 0..1; maps to 0..135% wet side
        float doublerMix = 0.0f;       // 0..1; zero is exact bypass
        float doublerSpread = 0.65f;   // 0..1
        bool roomInputSendEnabled = true; // false drains the existing room tail
        float doublerDelayMs = 4.5f;   // 3..20 ms; independent of Spread
    };

    struct DiagnosticSnapshot
    {
        std::uint32_t processedBlocks = 0;
        std::uint32_t processedSamples = 0;
        std::uint32_t zeroEffectFastPathBlocks = 0;
        std::uint32_t oversizedBlocks = 0;
        std::uint32_t nonFiniteInputSamples = 0;
        std::uint32_t nonFiniteWetSamples = 0;
        float lastDryPeak = 0.0f;
        float lastGeneratedMidPeak = 0.0f;
        float lastGeneratedSidePeak = 0.0f;
    };

    /**
     * Synchronous, allocation-permitted deterministic regression data for
     * harnesses. It deliberately does not assert spaciousness, naturalness,
     * product-reference similarity, or any other subjective audio quality.
     */
    struct SelfTestResult
    {
        bool passed = false;
        bool zeroEffectUnity = false;
        bool deterministicReset = false;
        bool blockPartitionInvariant = false;
        bool algebraicSideCancellation = false;
        bool monoRoomCreatesStereo = false;
        bool monoRoomFoldContractValid = false;
        bool roomFirstArrivalValid = false;
        bool lowFrequencyRoomFieldCentred = false;
        bool highFrequencyRoomSidePresent = false;
        bool preArrivalDirectExact = false;
        bool automationFiniteAndBounded = false;
        bool automationDezippered = false;
        bool automationPostArrivalExercised = false;
        bool multiRateRoomTimingValid = false;
        bool transientProtectionValid = false;
        bool nonFiniteRecoveryValid = false;
        bool tailDecayValid = false;
        bool roomInputSendGateValid = false;
        bool lateRoomFieldValid = false;
        bool doublerDelayControlValid = false;
        float zeroEffectMaximumError = 0.0f;
        float deterministicResetMaximumError = 0.0f;
        float blockPartitionMaximumError = 0.0f;
        float monoFoldMaximumError = 0.0f;
        float monoRoomGeneratedSidePeak = 0.0f;
        float monoRoomFoldMaximumError = 0.0f;
        float room80HzSideToMidDb = 0.0f;
        float room1kHzSideRms = 0.0f;
        float preArrivalDirectMaximumError = 0.0f;
        float automationMaximumOutputPeak = 0.0f;
        float automationFirst32DezipperError = 0.0f;
        float automationPostMorphDifferenceRms = 0.0f;
        float roomTransientMinimumGain = 1.0f;
        float doublerTransientMinimumGain = 1.0f;
        float roomTransientRecoveredGain = 1.0f;
        float doublerTransientRecoveredGain = 1.0f;
        float tailEndPeak = 0.0f;
        float gatedRoomTailPeak = 0.0f;
        float gatedRoomNewInputMaximumError = 0.0f;
        float lateRoom150msRms = 0.0f;
        float lowFrequencySideToMidLimitDb = -18.0f;
        float highFrequencySideRmsMinimum = 1.0e-4f;
        float automationOutputPeakLimit = 4.0f;
        float automationDezipperErrorLimit = 5.0e-6f;
        int expectedRoomFirstArrivalSample = 0;
        int observedRoomFirstArrivalSample = -1;
    };

    enum class BenchmarkMode : std::uint8_t
    {
        roomOnly = 0,
        roomAndDoubler
    };

    struct BenchmarkResult
    {
        bool valid = false;
        BenchmarkMode mode = BenchmarkMode::roomOnly;
        double sampleRate = 0.0;
        int blockSize = 0;
        int measuredBlocks = 0;
        double netElapsedMilliseconds = 0.0;
        double averageMicrosecondsPerBlock = 0.0;
        double p99Microseconds = 0.0;
        double p999Microseconds = 0.0;
        double maximumMicroseconds = 0.0;
        double callbackDeadlineMicroseconds = 0.0;
        double realtimeDeadlineFraction = 0.0;
        std::uint32_t deadlineMisses = 0;
        bool deadlineCriteriaPassed = false;
        float outputChecksum = 0.0f;
        float generatedSidePeak = 0.0f;
    };

    NAMCabPresentation() = default;
    ~NAMCabPresentation() = default;

    void prepare(double sampleRate, int maximumBlockSize);
    void reset() noexcept;

    void setParameters(const Parameters& newParameters) noexcept;
    [[nodiscard]] Parameters getParameters() const noexcept;

    void setRoomAmount(float amount) noexcept;
    void setRoomWidth(float width) noexcept;
    void setRoomInputSendEnabled(bool enabled) noexcept;
    void setDoublerMix(float mix) noexcept;
    void setDoublerSpread(float spread) noexcept;
    void setDoublerDelayMs(float delayMs) noexcept;

    /**
     * Adds the presentation field in place while preserving the direct signal
     * at unity. Stereo side contributions are applied as +S/-S, so they cancel
     * algebraically when L/R are folded to mono. Channels above the first two
     * are deliberately left unchanged.
     */
    void process(juce::AudioBuffer<float>& buffer) noexcept;

    [[nodiscard]] bool isPrepared() const noexcept { return prepared; }
    [[nodiscard]] int getLatencySamples() const noexcept { return 0; }
    [[nodiscard]] double getMaximumTailSeconds() const noexcept { return 0.80; }

    [[nodiscard]] DiagnosticSnapshot getDiagnostics() const noexcept;
    void resetDiagnostics() noexcept;

    [[nodiscard]] static SelfTestResult runDeterministicSelfTest();
    [[nodiscard]] static BenchmarkResult runBenchmark(
        BenchmarkMode mode,
        double sampleRate = 48000.0,
        int blockSize = 8,
        int measuredBlocks = 200000);
    [[nodiscard]] static BenchmarkResult runRoomOnlyBenchmark(
        double sampleRate = 48000.0,
        int blockSize = 8,
        int measuredBlocks = 200000);
    [[nodiscard]] static BenchmarkResult runRoomAndDoublerBenchmark(
        double sampleRate = 48000.0,
        int blockSize = 8,
        int measuredBlocks = 200000);

private:
    struct Biquad
    {
        float b0 = 1.0f;
        float b1 = 0.0f;
        float b2 = 0.0f;
        float a1 = 0.0f;
        float a2 = 0.0f;
        float z1 = 0.0f;
        float z2 = 0.0f;

        void configureLowPass(double sampleRate, float frequencyHz, float q) noexcept;
        void configureHighPass(double sampleRate, float frequencyHz, float q) noexcept;
        void reset() noexcept;
        [[nodiscard]] float processSample(float sample) noexcept;
    };

    struct DoublerDriftState
    {
        std::uint32_t randomState = 1;
        float offsetStartSamples = 0.0f;
        float offsetTargetSamples = 0.0f;
        float currentOffsetSamples = 0.0f;
        float levelStart = 1.0f;
        float levelTarget = 1.0f;
        float currentLevel = 1.0f;
        int segmentPosition = 0;
        int segmentLength = 0;
    };

    static constexpr std::size_t roomTapCount = 8;
    static constexpr std::size_t lateRoomLineCount = 4;
    static constexpr float parameterSmoothingSeconds = 0.020f;
    static constexpr float delayMorphSeconds = 0.030f;
    static constexpr float roomFieldNormalisation = 0.42f;
    static constexpr float roomMidScale = 0.62f;
    static constexpr float lateRoomInputGain = 0.32f;
    static constexpr float lateRoomOutputGain = 0.58f;
    static constexpr float doublerMidScale = 0.55f;

    static float clampUnit(float value) noexcept;
    static float nextRandomSigned(std::uint32_t& state) noexcept;
    static float smootherStep(float value) noexcept;
    static float raisedCosine(float value) noexcept;
    static float mapRoomGain(float amount) noexcept;
    static float mapDoublerGain(float amount) noexcept;
    static float clampDoublerDelayMs(float delayMs) noexcept;

    void configureFilters() noexcept;
    void resetRoomRuntimeState(bool clearStorage) noexcept;
    void resetDoublerRuntimeState(bool clearStorage) noexcept;
    void invalidateRoomHistory() noexcept;
    void invalidateDoublerHistory() noexcept;

    [[nodiscard]] float readRoomSample(const std::vector<float>& ring,
                                       int delaySamples) const noexcept;
    [[nodiscard]] float readDoublerSample(const std::vector<float>& ring,
                                          float delaySamples) const noexcept;
    void advanceDoublerDrift(DoublerDriftState& state,
                             float spread) noexcept;
    void startDoublerDelayMorph(float requestedDelayMs,
                                float requestedSpread) noexcept;
    void processLateRoom(float inputL,
                         float inputR,
                         float& outputL,
                         float& outputR) noexcept;

    double currentSampleRate = 48000.0;
    int preparedMaximumBlockSize = 0;
    bool prepared = false;

    std::atomic<float> targetRoomAmount { 0.0f };
    std::atomic<float> targetRoomWidth { 0.65f };
    std::atomic<bool> targetRoomInputSendEnabled { true };
    std::atomic<float> targetDoublerMix { 0.0f };
    std::atomic<float> targetDoublerSpread { 0.65f };
    std::atomic<float> targetDoublerDelayMs { 4.5f };

    float currentRoomGain = 0.0f;
    float currentRoomWidth = 0.65f;
    float currentDoublerGain = 0.0f;
    float currentDoublerSpread = 0.65f;
    float smoothingCoefficient = 1.0f;

    std::vector<float> roomRingL;
    std::vector<float> roomRingR;
    int roomWriteIndex = 0;
    int validRoomHistorySamples = 0;
    bool roomDormant = true;
    std::array<int, roomTapCount> roomDirectTapSamplesL {};
    std::array<int, roomTapCount> roomDirectTapSamplesR {};
    std::array<int, roomTapCount> roomCrossTapSamplesL {};
    std::array<int, roomTapCount> roomCrossTapSamplesR {};
    std::array<std::vector<float>, lateRoomLineCount> lateRoomRings;
    std::array<int, lateRoomLineCount> lateRoomWriteIndices {};
    std::array<int, lateRoomLineCount> lateRoomValidSamples {};
    std::array<float, lateRoomLineCount> lateRoomDampingStates {};
    float lateRoomDampingCoefficient = 1.0f;
    float currentLateRoomFeedback = 0.25f;

    Biquad roomWetHighPassL;
    Biquad roomWetHighPassR;
    Biquad roomWetLowPassL;
    Biquad roomWetLowPassR;
    std::array<Biquad, 2> roomSideHighPass;

    std::vector<float> doublerRingL;
    std::vector<float> doublerRingR;
    int doublerWriteIndex = 0;
    int validDoublerHistorySamples = 0;
    bool doublerDormant = true;
    DoublerDriftState doublerDriftL;
    DoublerDriftState doublerDriftR;
    Biquad doublerWetHighPassL;
    Biquad doublerWetHighPassR;
    Biquad doublerWetLowPassL;
    Biquad doublerWetLowPassR;
    std::array<Biquad, 2> doublerSideHighPass;
    float transientFastEnvelope = 0.0f;
    float transientSlowEnvelope = 0.0f;
    float roomTransientDuck = 1.0f;
    float doublerTransientDuck = 1.0f;
    float fastEnvelopeRelease = 0.0f;
    float slowEnvelopeCoefficient = 0.0f;
    float transientDuckReleaseCoefficient = 0.0f;

    float activeDelaySpread = 0.65f;
    float morphTargetDelaySpread = 0.65f;
    float requestedDelaySpread = 0.65f;
    float activeDoublerDelayMs = 4.5f;
    float morphTargetDoublerDelayMs = 4.5f;
    float requestedDoublerDelayMs = 4.5f;
    int delayMorphPosition = 0;
    int delayMorphLength = 1;
    bool delayMorphActive = false;

    std::atomic<std::uint32_t> diagnosticProcessedBlocks { 0 };
    std::atomic<std::uint32_t> diagnosticProcessedSamples { 0 };
    std::atomic<std::uint32_t> diagnosticZeroEffectBlocks { 0 };
    std::atomic<std::uint32_t> diagnosticOversizedBlocks { 0 };
    std::atomic<std::uint32_t> diagnosticNonFiniteInputSamples { 0 };
    std::atomic<std::uint32_t> diagnosticNonFiniteWetSamples { 0 };
    std::atomic<float> diagnosticLastDryPeak { 0.0f };
    std::atomic<float> diagnosticLastGeneratedMidPeak { 0.0f };
    std::atomic<float> diagnosticLastGeneratedSidePeak { 0.0f };

    static_assert(std::atomic<float>::is_always_lock_free,
                  "NAM Cab Presentation parameter and metric floats must be lock-free");
    static_assert(std::atomic<bool>::is_always_lock_free,
                  "NAM Cab Presentation switches must be lock-free");
    static_assert(std::atomic<std::uint32_t>::is_always_lock_free,
                  "NAM Cab Presentation counters must be lock-free");

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(NAMCabPresentation)
};
