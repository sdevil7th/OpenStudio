#include "NAMCabPresentation.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace
{
constexpr std::array<float, 8> roomTapMilliseconds {
    3.1f, 5.7f, 8.9f, 12.7f,
    17.3f, 22.9f, 28.7f, 36.1f
};

constexpr std::array<float, 8> roomCrossDeltaMilliseconds {
    0.7f, 1.3f, 0.9f, 1.7f,
    1.1f, 2.1f, 1.5f, 2.7f
};

constexpr std::array<float, 8> roomDirectTapGainL {
    0.46f, -0.34f, 0.28f, -0.23f,
    0.19f, -0.15f, 0.12f, -0.09f
};

constexpr std::array<float, 8> roomCrossTapGainL {
    0.17f, 0.14f, -0.13f, 0.11f,
    -0.10f, 0.085f, -0.071f, 0.058f
};

// A real room does not present mirrored image-source paths to the two ears.
// These fixed sub-millisecond offsets and modest gain/polarity differences
// create a stable stereo field from a mono close cabinet without an LFO or a
// random result on recall. The unchanged close signal remains the centre
// anchor; only the parallel wet field is asymmetric.
constexpr std::array<float, 8> roomRightDirectDeltaMilliseconds {
    0.43f, -0.29f, 0.61f, -0.37f,
    0.83f, -0.47f, 1.07f, -0.59f
};

constexpr std::array<float, 8> roomRightCrossExtraMilliseconds {
    0.31f, -0.21f, 0.47f, -0.33f,
    0.69f, -0.41f, 0.91f, -0.55f
};

constexpr std::array<float, 8> roomDirectTapGainR {
    0.43f, -0.31f, 0.255f, -0.205f,
    -0.175f, -0.137f, 0.108f, 0.076f
};

constexpr std::array<float, 8> roomCrossTapGainR {
    -0.155f, 0.128f, -0.118f, 0.102f,
    -0.091f, -0.078f, -0.065f, 0.051f
};

// Mutually incommensurate short delays make a compact four-line Householder
// FDN dense quickly without modulation. The feedback range below gives an
// approximate 180..650 ms RT60 around the mean line length.
constexpr std::array<float, 4> lateRoomDelayMilliseconds {
    29.7f, 34.9f, 41.3f, 47.9f
};

constexpr float butterworthQ = 0.7071067811865475f;
// 2^(6 cents / 1200) - 1. Kept as a literal so the realtime drift segment
// setup never evaluates pow().
constexpr float maximumDoublerDelaySlope = 0.0034717485f;
constexpr float selfTestTolerance = 2.0e-6f;
// Product references motivate a centred low-frequency presentation, but no
// ITU recommendation mandates a numerical crossover target. These explicit
// engineering thresholds are therefore reported rather than presented as a
// psychoacoustic standard.
constexpr float lowFrequencySideToMidLimitDb = -18.0f;
constexpr float highFrequencySideRmsMinimum = 1.0e-4f;
// This is a deterministic post-arrival automation residual, not an audible
// quality threshold. The audible linear wet laws intentionally produce more
// signal during a 20 ms move than the retired squared laws; -74 dBFS remains
// a conservative ceiling for a one-sample residual step.
constexpr float automationDezipperErrorLimit = 2.0e-4f;
constexpr float automationOutputPeakLimit = 4.0f;

float maximumAbsoluteDifference(const juce::AudioBuffer<float>& first,
                                const juce::AudioBuffer<float>& second) noexcept
{
    const int channels = juce::jmin(first.getNumChannels(), second.getNumChannels());
    const int samples = juce::jmin(first.getNumSamples(), second.getNumSamples());
    float maximumDifference = 0.0f;
    for (int channel = 0; channel < channels; ++channel)
    {
        const auto* const firstSamples = first.getReadPointer(channel);
        const auto* const secondSamples = second.getReadPointer(channel);
        for (int sample = 0; sample < samples; ++sample)
        {
            maximumDifference = juce::jmax(
                maximumDifference,
                std::abs(firstSamples[sample] - secondSamples[sample]));
        }
    }
    return maximumDifference;
}

void fillDeterministicTestSignal(juce::AudioBuffer<float>& buffer) noexcept
{
    std::uint32_t randomState = 0x4d595df4u;
    const int channels = buffer.getNumChannels();
    const int samples = buffer.getNumSamples();
    for (int sample = 0; sample < samples; ++sample)
    {
        randomState ^= randomState << 13u;
        randomState ^= randomState >> 17u;
        randomState ^= randomState << 5u;
        const float noise = static_cast<float>(randomState & 0x00ffffffu)
            * (2.0f / 16777215.0f) - 1.0f;
        const float phase = static_cast<float>(sample)
            * (2.0f * juce::MathConstants<float>::pi * 113.0f / 48000.0f);
        const float value = std::sin(phase) * 0.24f + noise * 0.035f;
        for (int channel = 0; channel < channels; ++channel)
            buffer.setSample(channel, sample, value);
    }
}

void processInPartitions(NAMCabPresentation& processor,
                         juce::AudioBuffer<float>& buffer,
                         int partitionSize) noexcept
{
    const int safePartitionSize = juce::jmax(1, partitionSize);
    int offset = 0;
    while (offset < buffer.getNumSamples())
    {
        const int blockSamples = juce::jmin(
            safePartitionSize,
            buffer.getNumSamples() - offset);
        std::array<float*, 2> channelPointers {
            buffer.getWritePointer(0, offset),
            buffer.getNumChannels() >= 2
                ? buffer.getWritePointer(1, offset)
                : nullptr
        };
        juce::AudioBuffer<float> block(
            channelPointers.data(),
            buffer.getNumChannels(),
            blockSamples);
        processor.process(block);
        offset += blockSamples;
    }
}
}

void NAMCabPresentation::Biquad::configureLowPass(double sampleRate,
                                                  float frequencyHz,
                                                  float q) noexcept
{
    const float safeSampleRate = static_cast<float>(juce::jmax(1.0, sampleRate));
    const float safeFrequency = juce::jlimit(5.0f, safeSampleRate * 0.45f, frequencyHz);
    const float safeQ = juce::jmax(0.05f, q);
    const float omega = 2.0f * juce::MathConstants<float>::pi
        * safeFrequency / safeSampleRate;
    const float cosine = std::cos(omega);
    const float sine = std::sin(omega);
    const float alpha = sine / (2.0f * safeQ);
    const float inverseA0 = 1.0f / (1.0f + alpha);

    b0 = (1.0f - cosine) * 0.5f * inverseA0;
    b1 = (1.0f - cosine) * inverseA0;
    b2 = b0;
    a1 = -2.0f * cosine * inverseA0;
    a2 = (1.0f - alpha) * inverseA0;
}

void NAMCabPresentation::Biquad::configureHighPass(double sampleRate,
                                                   float frequencyHz,
                                                   float q) noexcept
{
    const float safeSampleRate = static_cast<float>(juce::jmax(1.0, sampleRate));
    const float safeFrequency = juce::jlimit(5.0f, safeSampleRate * 0.45f, frequencyHz);
    const float safeQ = juce::jmax(0.05f, q);
    const float omega = 2.0f * juce::MathConstants<float>::pi
        * safeFrequency / safeSampleRate;
    const float cosine = std::cos(omega);
    const float sine = std::sin(omega);
    const float alpha = sine / (2.0f * safeQ);
    const float inverseA0 = 1.0f / (1.0f + alpha);

    b0 = (1.0f + cosine) * 0.5f * inverseA0;
    b1 = -(1.0f + cosine) * inverseA0;
    b2 = b0;
    a1 = -2.0f * cosine * inverseA0;
    a2 = (1.0f - alpha) * inverseA0;
}

void NAMCabPresentation::Biquad::reset() noexcept
{
    z1 = 0.0f;
    z2 = 0.0f;
}

float NAMCabPresentation::Biquad::processSample(float sample) noexcept
{
    if (! std::isfinite(sample)
        || ! std::isfinite(z1)
        || ! std::isfinite(z2))
    {
        reset();
        return 0.0f;
    }
    const float output = b0 * sample + z1;
    const float nextZ1 = b1 * sample - a1 * output + z2;
    const float nextZ2 = b2 * sample - a2 * output;
    if (! std::isfinite(output)
        || ! std::isfinite(nextZ1)
        || ! std::isfinite(nextZ2))
    {
        reset();
        return 0.0f;
    }
    z1 = nextZ1;
    z2 = nextZ2;
    return output;
}

float NAMCabPresentation::clampUnit(float value) noexcept
{
    return std::isfinite(value) ? juce::jlimit(0.0f, 1.0f, value) : 0.0f;
}

float NAMCabPresentation::nextRandomSigned(std::uint32_t& state) noexcept
{
    if (state == 0u)
        state = 0x6d2b79f5u;
    state ^= state << 13u;
    state ^= state >> 17u;
    state ^= state << 5u;
    return static_cast<float>(state & 0x00ffffffu)
        * (2.0f / 16777215.0f) - 1.0f;
}

float NAMCabPresentation::smootherStep(float value) noexcept
{
    const float x = juce::jlimit(0.0f, 1.0f, value);
    return x * x * x * (x * (x * 6.0f - 15.0f) + 10.0f);
}

float NAMCabPresentation::raisedCosine(float value) noexcept
{
    const float x = juce::jlimit(0.0f, 1.0f, value);
    return 0.5f - 0.5f * std::cos(juce::MathConstants<float>::pi * x);
}

float NAMCabPresentation::mapRoomGain(float amount) noexcept
{
    // Linear amplitude mapping keeps the useful lower half of the control
    // audible. The former squared law attenuated the factory 0.22 setting by
    // more than 31 dB before the field's own normalisation.
    return 0.85f * clampUnit(amount);
}

float NAMCabPresentation::mapDoublerGain(float amount) noexcept
{
    // The doubler is a parallel voice against a unity direct signal. A linear
    // law gives the default 0.12 setting an audible but still subordinate
    // contribution while retaining headroom at the top of the control.
    return 0.90f * clampUnit(amount);
}

float NAMCabPresentation::clampDoublerDelayMs(float delayMs) noexcept
{
    return std::isfinite(delayMs) ? juce::jlimit(3.0f, 20.0f, delayMs) : 4.5f;
}

void NAMCabPresentation::prepare(double sampleRate, int maximumBlockSize)
{
    prepared = false;
    currentSampleRate = std::isfinite(sampleRate)
        ? juce::jmax(8000.0, sampleRate)
        : 48000.0;
    preparedMaximumBlockSize = juce::jmax(1, maximumBlockSize);

    const int roomRingSamples = juce::jmax(
        16,
        static_cast<int>(std::ceil(currentSampleRate * 0.064)) + 8);
    roomRingL.assign(static_cast<std::size_t>(roomRingSamples), 0.0f);
    roomRingR.assign(static_cast<std::size_t>(roomRingSamples), 0.0f);

    for (std::size_t line = 0; line < lateRoomLineCount; ++line)
    {
        const int lineSamples = juce::jmax(
            8,
            juce::roundToInt(
                lateRoomDelayMilliseconds[line]
                * 0.001f
                * static_cast<float>(currentSampleRate)));
        lateRoomRings[line].assign(
            static_cast<std::size_t>(lineSamples),
            0.0f);
    }

    const int doublerRingSamples = juce::jmax(
        16,
        static_cast<int>(std::ceil(currentSampleRate * 0.050)) + 8);
    doublerRingL.assign(static_cast<std::size_t>(doublerRingSamples), 0.0f);
    doublerRingR.assign(static_cast<std::size_t>(doublerRingSamples), 0.0f);

    for (std::size_t tap = 0; tap < roomTapCount; ++tap)
    {
        roomDirectTapSamplesL[tap] = juce::jlimit(
            1,
            roomRingSamples - 4,
            juce::roundToInt(
                roomTapMilliseconds[tap]
                * 0.001f
                * static_cast<float>(currentSampleRate)));
        roomDirectTapSamplesR[tap] = juce::jlimit(
            1,
            roomRingSamples - 4,
            juce::roundToInt(
                (roomTapMilliseconds[tap]
                 + roomRightDirectDeltaMilliseconds[tap])
                * 0.001f
                * static_cast<float>(currentSampleRate)));
        roomCrossTapSamplesL[tap] = juce::jlimit(
            1,
            roomRingSamples - 4,
            juce::roundToInt(
                (roomTapMilliseconds[tap] + roomCrossDeltaMilliseconds[tap])
                * 0.001f
                * static_cast<float>(currentSampleRate)));
        roomCrossTapSamplesR[tap] = juce::jlimit(
            1,
            roomRingSamples - 4,
            juce::roundToInt(
                (roomTapMilliseconds[tap]
                 + roomCrossDeltaMilliseconds[tap]
                 + roomRightCrossExtraMilliseconds[tap])
                * 0.001f
                * static_cast<float>(currentSampleRate)));
    }

    smoothingCoefficient = 1.0f - std::exp(
        -1.0f
        / static_cast<float>(
            currentSampleRate * static_cast<double>(parameterSmoothingSeconds)));
    fastEnvelopeRelease = std::exp(
        -1.0f / static_cast<float>(currentSampleRate * 0.008));
    slowEnvelopeCoefficient = 1.0f - std::exp(
        -1.0f / static_cast<float>(currentSampleRate * 0.080));
    transientDuckReleaseCoefficient = 1.0f - std::exp(
        -1.0f / static_cast<float>(currentSampleRate * 0.060));
    lateRoomDampingCoefficient = 1.0f - std::exp(
        -2.0f * juce::MathConstants<float>::pi * 5600.0f
        / static_cast<float>(currentSampleRate));
    delayMorphLength = juce::jmax(
        1,
        juce::roundToInt(
            static_cast<float>(currentSampleRate)
            * delayMorphSeconds));

    configureFilters();
    prepared = true;
    reset();
    resetDiagnostics();
}

void NAMCabPresentation::configureFilters() noexcept
{
    roomWetHighPassL.configureHighPass(currentSampleRate, 120.0f, butterworthQ);
    roomWetHighPassR.configureHighPass(currentSampleRate, 120.0f, butterworthQ);
    roomWetLowPassL.configureLowPass(currentSampleRate, 8500.0f, butterworthQ);
    roomWetLowPassR.configureLowPass(currentSampleRate, 8500.0f, butterworthQ);
    for (auto& filter : roomSideHighPass)
        filter.configureHighPass(currentSampleRate, 170.0f, butterworthQ);

    doublerWetHighPassL.configureHighPass(currentSampleRate, 140.0f, butterworthQ);
    doublerWetHighPassR.configureHighPass(currentSampleRate, 140.0f, butterworthQ);
    doublerWetLowPassL.configureLowPass(currentSampleRate, 9000.0f, butterworthQ);
    doublerWetLowPassR.configureLowPass(currentSampleRate, 9000.0f, butterworthQ);
    for (auto& filter : doublerSideHighPass)
        filter.configureHighPass(currentSampleRate, 170.0f, butterworthQ);
}

void NAMCabPresentation::resetRoomRuntimeState(bool clearStorage) noexcept
{
    if (clearStorage)
    {
        std::fill(roomRingL.begin(), roomRingL.end(), 0.0f);
        std::fill(roomRingR.begin(), roomRingR.end(), 0.0f);
        for (auto& ring : lateRoomRings)
            std::fill(ring.begin(), ring.end(), 0.0f);
    }
    roomWriteIndex = 0;
    validRoomHistorySamples = 0;
    lateRoomWriteIndices.fill(0);
    lateRoomValidSamples.fill(0);
    lateRoomDampingStates.fill(0.0f);
    roomWetHighPassL.reset();
    roomWetHighPassR.reset();
    roomWetLowPassL.reset();
    roomWetLowPassR.reset();
    for (auto& filter : roomSideHighPass)
        filter.reset();
    roomDormant = true;
}

void NAMCabPresentation::resetDoublerRuntimeState(bool clearStorage) noexcept
{
    if (clearStorage)
    {
        std::fill(doublerRingL.begin(), doublerRingL.end(), 0.0f);
        std::fill(doublerRingR.begin(), doublerRingR.end(), 0.0f);
    }
    doublerWriteIndex = 0;
    validDoublerHistorySamples = 0;
    doublerWetHighPassL.reset();
    doublerWetHighPassR.reset();
    doublerWetLowPassL.reset();
    doublerWetLowPassR.reset();
    for (auto& filter : doublerSideHighPass)
        filter.reset();
    doublerDriftL = {};
    doublerDriftR = {};
    doublerDriftL.randomState = 0x9e3779b9u;
    doublerDriftR.randomState = 0x7f4a7c15u;
    transientFastEnvelope = 0.0f;
    transientSlowEnvelope = 0.0f;
    roomTransientDuck = 1.0f;
    doublerTransientDuck = 1.0f;
    requestedDelaySpread = clampUnit(
        targetDoublerSpread.load(std::memory_order_relaxed));
    activeDelaySpread = requestedDelaySpread;
    morphTargetDelaySpread = requestedDelaySpread;
    requestedDoublerDelayMs = clampDoublerDelayMs(
        targetDoublerDelayMs.load(std::memory_order_relaxed));
    activeDoublerDelayMs = requestedDoublerDelayMs;
    morphTargetDoublerDelayMs = requestedDoublerDelayMs;
    delayMorphPosition = 0;
    delayMorphActive = false;
    doublerDormant = true;
}

void NAMCabPresentation::invalidateRoomHistory() noexcept
{
    resetRoomRuntimeState(false);
}

void NAMCabPresentation::invalidateDoublerHistory() noexcept
{
    resetDoublerRuntimeState(false);
}

void NAMCabPresentation::reset() noexcept
{
    const float roomAmount = clampUnit(
        targetRoomAmount.load(std::memory_order_relaxed));
    const float doublerAmount = clampUnit(
        targetDoublerMix.load(std::memory_order_relaxed));
    currentRoomGain = mapRoomGain(roomAmount);
    currentRoomWidth = clampUnit(
        targetRoomWidth.load(std::memory_order_relaxed));
    currentLateRoomFeedback = 0.23f + 0.43f * roomAmount;
    currentDoublerGain = mapDoublerGain(doublerAmount);
    currentDoublerSpread = clampUnit(
        targetDoublerSpread.load(std::memory_order_relaxed));
    resetRoomRuntimeState(true);
    resetDoublerRuntimeState(true);
}

void NAMCabPresentation::setParameters(const Parameters& newParameters) noexcept
{
    setRoomAmount(newParameters.roomAmount);
    setRoomWidth(newParameters.roomWidth);
    setRoomInputSendEnabled(newParameters.roomInputSendEnabled);
    setDoublerMix(newParameters.doublerMix);
    setDoublerSpread(newParameters.doublerSpread);
    setDoublerDelayMs(newParameters.doublerDelayMs);
}

NAMCabPresentation::Parameters NAMCabPresentation::getParameters() const noexcept
{
    Parameters result;
    result.roomAmount = targetRoomAmount.load(std::memory_order_relaxed);
    result.roomWidth = targetRoomWidth.load(std::memory_order_relaxed);
    result.roomInputSendEnabled =
        targetRoomInputSendEnabled.load(std::memory_order_relaxed);
    result.doublerMix = targetDoublerMix.load(std::memory_order_relaxed);
    result.doublerSpread = targetDoublerSpread.load(std::memory_order_relaxed);
    result.doublerDelayMs =
        targetDoublerDelayMs.load(std::memory_order_relaxed);
    return result;
}

void NAMCabPresentation::setRoomAmount(float amount) noexcept
{
    targetRoomAmount.store(clampUnit(amount), std::memory_order_relaxed);
}

void NAMCabPresentation::setRoomWidth(float width) noexcept
{
    targetRoomWidth.store(clampUnit(width), std::memory_order_relaxed);
}

void NAMCabPresentation::setRoomInputSendEnabled(bool enabled) noexcept
{
    targetRoomInputSendEnabled.store(enabled, std::memory_order_relaxed);
}

void NAMCabPresentation::setDoublerMix(float mix) noexcept
{
    targetDoublerMix.store(clampUnit(mix), std::memory_order_relaxed);
}

void NAMCabPresentation::setDoublerSpread(float spread) noexcept
{
    targetDoublerSpread.store(clampUnit(spread), std::memory_order_relaxed);
}

void NAMCabPresentation::setDoublerDelayMs(float delayMs) noexcept
{
    targetDoublerDelayMs.store(
        clampDoublerDelayMs(delayMs),
        std::memory_order_relaxed);
}

float NAMCabPresentation::readRoomSample(const std::vector<float>& ring,
                                         int delaySamples) const noexcept
{
    if (ring.empty()
        || delaySamples <= 0
        || delaySamples > validRoomHistorySamples)
    {
        return 0.0f;
    }

    int readIndex = roomWriteIndex - delaySamples;
    if (readIndex < 0)
        readIndex += static_cast<int>(ring.size());
    return ring[static_cast<std::size_t>(readIndex)];
}

float NAMCabPresentation::readDoublerSample(const std::vector<float>& ring,
                                            float delaySamples) const noexcept
{
    if (ring.empty() || ! std::isfinite(delaySamples))
        return 0.0f;

    const float safeDelay = juce::jlimit(
        3.0f,
        static_cast<float>(ring.size() - 4u),
        delaySamples);
    if (static_cast<int>(std::ceil(safeDelay)) + 2
        > validDoublerHistorySamples)
    {
        return 0.0f;
    }

    float readPosition = static_cast<float>(doublerWriteIndex) - safeDelay;
    if (readPosition < 0.0f)
        readPosition += static_cast<float>(ring.size());
    const int centreIndex = static_cast<int>(std::floor(readPosition));
    const float fraction = readPosition - static_cast<float>(centreIndex);
    const int ringSize = static_cast<int>(ring.size());
    const auto sampleAt = [&ring, ringSize] (int index) noexcept
    {
        while (index < 0)
            index += ringSize;
        while (index >= ringSize)
            index -= ringSize;
        return ring[static_cast<std::size_t>(index)];
    };

    const float y0 = sampleAt(centreIndex - 1);
    const float y1 = sampleAt(centreIndex);
    const float y2 = sampleAt(centreIndex + 1);
    const float y3 = sampleAt(centreIndex + 2);
    const float fractionSquared = fraction * fraction;
    const float fractionCubed = fractionSquared * fraction;
    return 0.5f
        * (2.0f * y1
           + (-y0 + y2) * fraction
           + (2.0f * y0 - 5.0f * y1 + 4.0f * y2 - y3) * fractionSquared
           + (-y0 + 3.0f * y1 - 3.0f * y2 + y3) * fractionCubed);
}

void NAMCabPresentation::advanceDoublerDrift(DoublerDriftState& state,
                                              float spread) noexcept
{
    if (state.segmentLength <= 0
        || state.segmentPosition >= state.segmentLength)
    {
        state.offsetStartSamples = state.currentOffsetSamples;
        state.levelStart = state.currentLevel;
        const float depthMilliseconds = 0.08f + 0.30f * clampUnit(spread);
        state.offsetTargetSamples = nextRandomSigned(state.randomState)
            * depthMilliseconds
            * 0.001f
            * static_cast<float>(currentSampleRate);
        const float targetLevelDb = nextRandomSigned(state.randomState) * 0.6f;
        state.levelTarget = juce::Decibels::decibelsToGain(targetLevelDb);

        const float randomDuration = 0.18f
            + (nextRandomSigned(state.randomState) * 0.5f + 0.5f) * 0.42f;
        int durationSamples = juce::jmax(
            1,
            juce::roundToInt(
                randomDuration
                * static_cast<float>(currentSampleRate)));
        const float offsetChange = std::abs(
            state.offsetTargetSamples - state.offsetStartSamples);
        const int slopeLimitedSamples = juce::jmax(
            1,
            static_cast<int>(std::ceil(
                1.875f * offsetChange
                / maximumDoublerDelaySlope)));
        durationSamples = juce::jmax(durationSamples, slopeLimitedSamples);
        state.segmentLength = durationSamples;
        state.segmentPosition = 0;
    }

    const float progress = static_cast<float>(state.segmentPosition + 1)
        / static_cast<float>(juce::jmax(1, state.segmentLength));
    const float shapedProgress = smootherStep(progress);
    state.currentOffsetSamples = state.offsetStartSamples
        + (state.offsetTargetSamples - state.offsetStartSamples) * shapedProgress;
    state.currentLevel = state.levelStart
        + (state.levelTarget - state.levelStart) * shapedProgress;
    ++state.segmentPosition;
}

void NAMCabPresentation::startDoublerDelayMorph(float requestedDelayMsValue,
                                                float requestedSpreadValue) noexcept
{
    const float safeDelayMs = clampDoublerDelayMs(requestedDelayMsValue);
    const float safeSpread = clampUnit(requestedSpreadValue);
    if (std::abs(safeDelayMs - activeDoublerDelayMs) <= 1.0e-4f
        && std::abs(safeSpread - activeDelaySpread) <= 1.0e-5f)
    {
        activeDoublerDelayMs = safeDelayMs;
        morphTargetDoublerDelayMs = safeDelayMs;
        activeDelaySpread = safeSpread;
        morphTargetDelaySpread = safeSpread;
        delayMorphActive = false;
        delayMorphPosition = 0;
        return;
    }

    morphTargetDoublerDelayMs = safeDelayMs;
    morphTargetDelaySpread = safeSpread;
    delayMorphPosition = 0;
    delayMorphActive = true;
}

void NAMCabPresentation::processLateRoom(float inputL,
                                         float inputR,
                                         float& outputL,
                                         float& outputR) noexcept
{
    std::array<float, lateRoomLineCount> delayed {};
    for (std::size_t line = 0; line < lateRoomLineCount; ++line)
    {
        auto& ring = lateRoomRings[line];
        if (ring.empty())
            continue;

        const int writeIndex = lateRoomWriteIndices[line];
        const float rawDelayed = lateRoomValidSamples[line]
                >= static_cast<int>(ring.size())
            ? ring[static_cast<std::size_t>(writeIndex)]
            : 0.0f;
        float damped = lateRoomDampingStates[line]
            + (rawDelayed - lateRoomDampingStates[line])
                * lateRoomDampingCoefficient;
        if (! std::isfinite(damped))
            damped = 0.0f;
        lateRoomDampingStates[line] = damped;
        delayed[line] = damped;
    }

    // 2/N Householder feedback is orthogonal before damping. It distributes
    // every arrival to all four unequal lines without growing field energy.
    const float householderSum = 0.5f
        * (delayed[0] + delayed[1] + delayed[2] + delayed[3]);
    const std::array<float, lateRoomLineCount> injection {
        inputL,
        inputR,
        -inputL,
        -inputR
    };
    for (std::size_t line = 0; line < lateRoomLineCount; ++line)
    {
        auto& ring = lateRoomRings[line];
        if (ring.empty())
            continue;

        float writeValue = injection[line] * lateRoomInputGain
            + (householderSum - delayed[line]) * currentLateRoomFeedback;
        if (! std::isfinite(writeValue))
            writeValue = 0.0f;
        ring[static_cast<std::size_t>(lateRoomWriteIndices[line])] = writeValue;
        ++lateRoomWriteIndices[line];
        if (lateRoomWriteIndices[line] >= static_cast<int>(ring.size()))
            lateRoomWriteIndices[line] = 0;
        lateRoomValidSamples[line] = juce::jmin(
            static_cast<int>(ring.size()),
            lateRoomValidSamples[line] + 1);
    }

    outputL = (delayed[0] + delayed[1] - delayed[2] - delayed[3])
        * 0.5f
        * lateRoomOutputGain;
    outputR = (delayed[0] - delayed[1] + delayed[2] - delayed[3])
        * 0.5f
        * lateRoomOutputGain;
    if (! std::isfinite(outputL))
        outputL = 0.0f;
    if (! std::isfinite(outputR))
        outputR = 0.0f;
}

void NAMCabPresentation::process(juce::AudioBuffer<float>& buffer) noexcept
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (! prepared || numSamples <= 0 || numChannels <= 0)
        return;

    diagnosticProcessedBlocks.fetch_add(1u, std::memory_order_relaxed);
    diagnosticProcessedSamples.fetch_add(
        static_cast<std::uint32_t>(numSamples),
        std::memory_order_relaxed);
    if (numSamples > preparedMaximumBlockSize)
        diagnosticOversizedBlocks.fetch_add(1u, std::memory_order_relaxed);

    const float roomAmount = clampUnit(
        targetRoomAmount.load(std::memory_order_relaxed));
    const float roomGainTarget = mapRoomGain(roomAmount);
    const float roomWidthTarget = clampUnit(
        targetRoomWidth.load(std::memory_order_relaxed));
    const bool roomInputSendEnabled =
        targetRoomInputSendEnabled.load(std::memory_order_relaxed);
    const float lateRoomFeedbackTarget = 0.23f + 0.43f * roomAmount;
    const float doublerAmount = clampUnit(
        targetDoublerMix.load(std::memory_order_relaxed));
    const float doublerGainTarget = mapDoublerGain(doublerAmount);
    const float doublerSpreadTarget = clampUnit(
        targetDoublerSpread.load(std::memory_order_relaxed));
    const float doublerDelayMsTarget = clampDoublerDelayMs(
        targetDoublerDelayMs.load(std::memory_order_relaxed));
    requestedDelaySpread = doublerSpreadTarget;
    requestedDoublerDelayMs = doublerDelayMsTarget;

    constexpr float dormantThreshold = 1.0e-8f;
    if (roomGainTarget <= 0.0f
        && doublerGainTarget <= 0.0f
        && currentRoomGain <= dormantThreshold
        && currentDoublerGain <= dormantThreshold)
    {
        currentRoomGain = 0.0f;
        currentDoublerGain = 0.0f;
        currentRoomWidth = roomWidthTarget;
        currentDoublerSpread = doublerSpreadTarget;
        if (! roomDormant)
            invalidateRoomHistory();
        if (! doublerDormant)
            invalidateDoublerHistory();
        activeDelaySpread = doublerSpreadTarget;
        morphTargetDelaySpread = doublerSpreadTarget;
        requestedDelaySpread = doublerSpreadTarget;
        activeDoublerDelayMs = doublerDelayMsTarget;
        morphTargetDoublerDelayMs = doublerDelayMsTarget;
        requestedDoublerDelayMs = doublerDelayMsTarget;
        delayMorphActive = false;
        transientFastEnvelope = 0.0f;
        transientSlowEnvelope = 0.0f;
        roomTransientDuck = 1.0f;
        doublerTransientDuck = 1.0f;
        float dryPeak = 0.0f;
        std::uint32_t nonFiniteInputSamples = 0u;
        const int channelsToSanitize = juce::jmin(2, numChannels);
        for (int channel = 0; channel < channelsToSanitize; ++channel)
        {
            auto* const samples = buffer.getWritePointer(channel);
            for (int sample = 0; sample < numSamples; ++sample)
            {
                if (! std::isfinite(samples[sample]))
                {
                    samples[sample] = 0.0f;
                    ++nonFiniteInputSamples;
                }
                dryPeak = juce::jmax(dryPeak, std::abs(samples[sample]));
            }
        }
        diagnosticNonFiniteInputSamples.fetch_add(
            nonFiniteInputSamples,
            std::memory_order_relaxed);
        diagnosticZeroEffectBlocks.fetch_add(1u, std::memory_order_relaxed);
        diagnosticLastDryPeak.store(dryPeak, std::memory_order_relaxed);
        diagnosticLastGeneratedMidPeak.store(0.0f, std::memory_order_relaxed);
        diagnosticLastGeneratedSidePeak.store(0.0f, std::memory_order_relaxed);
        return;
    }

    const bool roomShouldRun = roomGainTarget > 0.0f
        || currentRoomGain > dormantThreshold;
    const bool doublerShouldRun = doublerGainTarget > 0.0f
        || currentDoublerGain > dormantThreshold;
    if (roomShouldRun && roomDormant)
    {
        invalidateRoomHistory();
        roomDormant = false;
    }
    if (doublerShouldRun && doublerDormant)
    {
        invalidateDoublerHistory();
        doublerDormant = false;
        activeDelaySpread = doublerSpreadTarget;
        morphTargetDelaySpread = doublerSpreadTarget;
        requestedDelaySpread = doublerSpreadTarget;
        activeDoublerDelayMs = doublerDelayMsTarget;
        morphTargetDoublerDelayMs = doublerDelayMsTarget;
        requestedDoublerDelayMs = doublerDelayMsTarget;
    }

    float dryPeak = 0.0f;
    float generatedMidPeak = 0.0f;
    float generatedSidePeak = 0.0f;
    std::uint32_t nonFiniteInputSamples = 0u;
    std::uint32_t nonFiniteWetSamples = 0u;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        currentRoomGain += (roomGainTarget - currentRoomGain)
            * smoothingCoefficient;
        currentRoomWidth += (roomWidthTarget - currentRoomWidth)
            * smoothingCoefficient;
        currentLateRoomFeedback +=
            (lateRoomFeedbackTarget - currentLateRoomFeedback)
            * smoothingCoefficient;
        currentDoublerGain += (doublerGainTarget - currentDoublerGain)
            * smoothingCoefficient;
        currentDoublerSpread += (doublerSpreadTarget - currentDoublerSpread)
            * smoothingCoefficient;
        if (roomGainTarget <= 0.0f && currentRoomGain < dormantThreshold)
            currentRoomGain = 0.0f;
        if (doublerGainTarget <= 0.0f && currentDoublerGain < dormantThreshold)
            currentDoublerGain = 0.0f;

        const float rawDryL = buffer.getSample(0, sample);
        const float rawDryR = numChannels >= 2
            ? buffer.getSample(1, sample)
            : rawDryL;
        const bool directLIsFinite = std::isfinite(rawDryL);
        const bool directRIsFinite = std::isfinite(rawDryR);
        const float dryL = directLIsFinite ? rawDryL : 0.0f;
        const float dryR = directRIsFinite ? rawDryR : 0.0f;
        if (! directLIsFinite)
            ++nonFiniteInputSamples;
        if (numChannels >= 2 && ! directRIsFinite)
            ++nonFiniteInputSamples;
        dryPeak = juce::jmax(
            dryPeak,
            juce::jmax(std::abs(dryL), std::abs(dryR)));

        if (! std::isfinite(transientFastEnvelope)
            || ! std::isfinite(transientSlowEnvelope)
            || ! std::isfinite(roomTransientDuck)
            || ! std::isfinite(doublerTransientDuck))
        {
            transientFastEnvelope = 0.0f;
            transientSlowEnvelope = 0.0f;
            roomTransientDuck = 1.0f;
            doublerTransientDuck = 1.0f;
            ++nonFiniteWetSamples;
        }
        if (roomShouldRun || doublerShouldRun)
        {
            // A disabled room send must not let unrelated raw input duck a
            // draining tail. The doubler continues to use the direct source.
            const float detectorInput = roomInputSendEnabled || doublerShouldRun
                ? juce::jmax(std::abs(dryL), std::abs(dryR))
                : 0.0f;
            transientFastEnvelope = juce::jmax(
                detectorInput,
                transientFastEnvelope * fastEnvelopeRelease);
            transientSlowEnvelope += (detectorInput - transientSlowEnvelope)
                * slowEnvelopeCoefficient;
            const float novelty = juce::jlimit(
                0.0f,
                1.0f,
                (transientFastEnvelope - transientSlowEnvelope)
                    / (transientFastEnvelope + 1.0e-9f));
            constexpr float roomMinimumDuck = 0.70794576f;
            const float roomDuckTarget = 1.0f
                - (1.0f - roomMinimumDuck) * novelty;
            const float doublerDuckTarget = 1.0f - 0.5f * novelty;
            if (roomDuckTarget < roomTransientDuck)
                roomTransientDuck = roomDuckTarget;
            else
                roomTransientDuck += (roomDuckTarget - roomTransientDuck)
                    * transientDuckReleaseCoefficient;
            if (doublerDuckTarget < doublerTransientDuck)
                doublerTransientDuck = doublerDuckTarget;
            else
                doublerTransientDuck += (doublerDuckTarget - doublerTransientDuck)
                    * transientDuckReleaseCoefficient;
        }

        float roomMidContribution = 0.0f;
        float roomSideContribution = 0.0f;
        if (roomShouldRun && ! roomRingL.empty())
        {
            const float roomInputL = roomInputSendEnabled ? dryL : 0.0f;
            const float roomInputR = roomInputSendEnabled ? dryR : 0.0f;
            roomRingL[static_cast<std::size_t>(roomWriteIndex)] =
                roomInputL * roomTransientDuck;
            roomRingR[static_cast<std::size_t>(roomWriteIndex)] =
                roomInputR * roomTransientDuck;
            float earlyL = 0.0f;
            float earlyR = 0.0f;
            for (std::size_t tap = 0; tap < roomTapCount; ++tap)
            {
                earlyL += readRoomSample(roomRingL, roomDirectTapSamplesL[tap])
                    * roomDirectTapGainL[tap];
                earlyR += readRoomSample(roomRingR, roomDirectTapSamplesR[tap])
                    * roomDirectTapGainR[tap];
                earlyL += readRoomSample(roomRingR, roomCrossTapSamplesL[tap])
                    * roomCrossTapGainL[tap];
                earlyR += readRoomSample(roomRingL, roomCrossTapSamplesR[tap])
                    * roomCrossTapGainR[tap];
            }
            earlyL = roomWetLowPassL.processSample(
                roomWetHighPassL.processSample(earlyL * roomFieldNormalisation));
            earlyR = roomWetLowPassR.processSample(
                roomWetHighPassR.processSample(earlyR * roomFieldNormalisation));
            float lateL = 0.0f;
            float lateR = 0.0f;
            processLateRoom(earlyL, earlyR, lateL, lateR);
            const float roomFieldL = earlyL + lateL;
            const float roomFieldR = earlyR + lateR;
            float roomMid = (roomFieldL + roomFieldR) * 0.5f;
            float roomSide = (roomFieldL - roomFieldR) * 0.5f;
            roomSide = roomSideHighPass[0].processSample(roomSide);
            roomSide = roomSideHighPass[1].processSample(roomSide);

            const float width = currentRoomWidth * 1.35f;
            const float widthCompensation = width > 1.0f
                ? std::sqrt(2.0f / (1.0f + width * width))
                : 1.0f;
            roomMidContribution = roomMid
                * currentRoomGain
                * roomMidScale
                * widthCompensation;
            roomSideContribution = roomSide
                * currentRoomGain
                * width
                * widthCompensation;

            ++roomWriteIndex;
            if (roomWriteIndex >= static_cast<int>(roomRingL.size()))
                roomWriteIndex = 0;
            validRoomHistorySamples = juce::jmin(
                static_cast<int>(roomRingL.size()) - 1,
                validRoomHistorySamples + 1);
        }

        float doublerMidContribution = 0.0f;
        float doublerSideContribution = 0.0f;
        if (doublerShouldRun && ! doublerRingL.empty())
        {
            doublerRingL[static_cast<std::size_t>(doublerWriteIndex)] =
                dryL * doublerTransientDuck;
            doublerRingR[static_cast<std::size_t>(doublerWriteIndex)] =
                dryR * doublerTransientDuck;

            advanceDoublerDrift(doublerDriftL, currentDoublerSpread);
            advanceDoublerDrift(doublerDriftR, currentDoublerSpread);
            if (! delayMorphActive
                && (std::abs(
                        requestedDoublerDelayMs - activeDoublerDelayMs)
                        > 1.0e-4f
                    || std::abs(requestedDelaySpread - activeDelaySpread)
                        > 1.0e-5f))
            {
                startDoublerDelayMorph(
                    requestedDoublerDelayMs,
                    requestedDelaySpread);
            }

            const auto voiceDelaySamples = [this] (float delayMs,
                                                    float spreadValue,
                                                    bool leftVoice,
                                                    float driftSamples) noexcept
            {
                const float separationMs = 3.0f * clampUnit(spreadValue);
                const float voiceDelayMs = clampDoublerDelayMs(
                    delayMs + separationMs * (leftVoice ? -0.4f : 0.6f));
                const float minimumSamples = static_cast<float>(currentSampleRate)
                    * 0.003f;
                const float maximumSamples = static_cast<float>(currentSampleRate)
                    * 0.020f;
                return juce::jlimit(
                    minimumSamples,
                    maximumSamples,
                    voiceDelayMs * 0.001f
                        * static_cast<float>(currentSampleRate)
                        + driftSamples);
            };

            float voiceL = 0.0f;
            float voiceR = 0.0f;
            if (delayMorphActive)
            {
                const float morphProgress = static_cast<float>(delayMorphPosition + 1)
                    / static_cast<float>(juce::jmax(1, delayMorphLength));
                const float morphWeight = raisedCosine(morphProgress);
                const float oldVoiceL = readDoublerSample(
                    doublerRingL,
                    voiceDelaySamples(
                        activeDoublerDelayMs,
                        activeDelaySpread,
                        true,
                        doublerDriftL.currentOffsetSamples));
                const float newVoiceL = readDoublerSample(
                    doublerRingL,
                    voiceDelaySamples(
                        morphTargetDoublerDelayMs,
                        morphTargetDelaySpread,
                        true,
                        doublerDriftL.currentOffsetSamples));
                const float oldVoiceR = readDoublerSample(
                    doublerRingR,
                    voiceDelaySamples(
                        activeDoublerDelayMs,
                        activeDelaySpread,
                        false,
                        doublerDriftR.currentOffsetSamples));
                const float newVoiceR = readDoublerSample(
                    doublerRingR,
                    voiceDelaySamples(
                        morphTargetDoublerDelayMs,
                        morphTargetDelaySpread,
                        false,
                        doublerDriftR.currentOffsetSamples));
                voiceL = oldVoiceL + (newVoiceL - oldVoiceL) * morphWeight;
                voiceR = oldVoiceR + (newVoiceR - oldVoiceR) * morphWeight;
                ++delayMorphPosition;
                if (delayMorphPosition >= delayMorphLength)
                {
                    activeDoublerDelayMs = morphTargetDoublerDelayMs;
                    activeDelaySpread = morphTargetDelaySpread;
                    delayMorphPosition = 0;
                    delayMorphActive = false;
                }
            }
            else
            {
                voiceL = readDoublerSample(
                    doublerRingL,
                    voiceDelaySamples(
                        activeDoublerDelayMs,
                        activeDelaySpread,
                        true,
                        doublerDriftL.currentOffsetSamples));
                voiceR = readDoublerSample(
                    doublerRingR,
                    voiceDelaySamples(
                        activeDoublerDelayMs,
                        activeDelaySpread,
                        false,
                        doublerDriftR.currentOffsetSamples));
            }
            voiceL *= doublerDriftL.currentLevel;
            voiceR *= doublerDriftR.currentLevel;
            voiceL = doublerWetLowPassL.processSample(
                doublerWetHighPassL.processSample(voiceL));
            voiceR = doublerWetLowPassR.processSample(
                doublerWetHighPassR.processSample(voiceR));
            const float voiceMid = (voiceL + voiceR) * 0.5f;
            float voiceSide = (voiceL - voiceR) * 0.5f;
            voiceSide = doublerSideHighPass[0].processSample(voiceSide);
            voiceSide = doublerSideHighPass[1].processSample(voiceSide);
            doublerMidContribution = voiceMid
                * currentDoublerGain
                * doublerMidScale;
            doublerSideContribution = voiceSide
                * currentDoublerGain
                * currentDoublerSpread;

            ++doublerWriteIndex;
            if (doublerWriteIndex >= static_cast<int>(doublerRingL.size()))
                doublerWriteIndex = 0;
            validDoublerHistorySamples = juce::jmin(
                static_cast<int>(doublerRingL.size()) - 1,
                validDoublerHistorySamples + 1);
        }

        float generatedMid = roomMidContribution + doublerMidContribution;
        float generatedSide = roomSideContribution + doublerSideContribution;
        if (! std::isfinite(generatedMid))
        {
            generatedMid = 0.0f;
            ++nonFiniteWetSamples;
        }
        if (! std::isfinite(generatedSide))
        {
            generatedSide = 0.0f;
            ++nonFiniteWetSamples;
        }
        generatedMidPeak = juce::jmax(generatedMidPeak, std::abs(generatedMid));
        generatedSidePeak = juce::jmax(generatedSidePeak, std::abs(generatedSide));

        if (numChannels >= 2)
        {
            float outputL = directLIsFinite
                ? dryL + generatedMid + generatedSide
                : 0.0f;
            float outputR = directRIsFinite
                ? dryR + generatedMid - generatedSide
                : 0.0f;
            if (! std::isfinite(outputL))
            {
                outputL = 0.0f;
                ++nonFiniteWetSamples;
            }
            if (! std::isfinite(outputR))
            {
                outputR = 0.0f;
                ++nonFiniteWetSamples;
            }
            buffer.setSample(
                0,
                sample,
                outputL);
            buffer.setSample(
                1,
                sample,
                outputR);
        }
        else
        {
            // A side field has no valid mono destination. Discarding it here
            // makes mono processing identical to a post-process L/R fold.
            float output = directLIsFinite ? dryL + generatedMid : 0.0f;
            if (! std::isfinite(output))
            {
                output = 0.0f;
                ++nonFiniteWetSamples;
            }
            buffer.setSample(0, sample, output);
        }
    }

    if (roomGainTarget <= 0.0f && currentRoomGain <= dormantThreshold)
        invalidateRoomHistory();
    if (doublerGainTarget <= 0.0f && currentDoublerGain <= dormantThreshold)
        invalidateDoublerHistory();

    diagnosticNonFiniteInputSamples.fetch_add(
        nonFiniteInputSamples,
        std::memory_order_relaxed);
    diagnosticNonFiniteWetSamples.fetch_add(
        nonFiniteWetSamples,
        std::memory_order_relaxed);
    diagnosticLastDryPeak.store(dryPeak, std::memory_order_relaxed);
    diagnosticLastGeneratedMidPeak.store(generatedMidPeak, std::memory_order_relaxed);
    diagnosticLastGeneratedSidePeak.store(generatedSidePeak, std::memory_order_relaxed);
}

NAMCabPresentation::DiagnosticSnapshot NAMCabPresentation::getDiagnostics() const noexcept
{
    DiagnosticSnapshot result;
    result.processedBlocks = diagnosticProcessedBlocks.load(std::memory_order_relaxed);
    result.processedSamples = diagnosticProcessedSamples.load(std::memory_order_relaxed);
    result.zeroEffectFastPathBlocks = diagnosticZeroEffectBlocks.load(std::memory_order_relaxed);
    result.oversizedBlocks = diagnosticOversizedBlocks.load(std::memory_order_relaxed);
    result.nonFiniteInputSamples = diagnosticNonFiniteInputSamples.load(std::memory_order_relaxed);
    result.nonFiniteWetSamples = diagnosticNonFiniteWetSamples.load(std::memory_order_relaxed);
    result.lastDryPeak = diagnosticLastDryPeak.load(std::memory_order_relaxed);
    result.lastGeneratedMidPeak = diagnosticLastGeneratedMidPeak.load(std::memory_order_relaxed);
    result.lastGeneratedSidePeak = diagnosticLastGeneratedSidePeak.load(std::memory_order_relaxed);
    return result;
}

void NAMCabPresentation::resetDiagnostics() noexcept
{
    diagnosticProcessedBlocks.store(0u, std::memory_order_relaxed);
    diagnosticProcessedSamples.store(0u, std::memory_order_relaxed);
    diagnosticZeroEffectBlocks.store(0u, std::memory_order_relaxed);
    diagnosticOversizedBlocks.store(0u, std::memory_order_relaxed);
    diagnosticNonFiniteInputSamples.store(0u, std::memory_order_relaxed);
    diagnosticNonFiniteWetSamples.store(0u, std::memory_order_relaxed);
    diagnosticLastDryPeak.store(0.0f, std::memory_order_relaxed);
    diagnosticLastGeneratedMidPeak.store(0.0f, std::memory_order_relaxed);
    diagnosticLastGeneratedSidePeak.store(0.0f, std::memory_order_relaxed);
}

NAMCabPresentation::SelfTestResult NAMCabPresentation::runDeterministicSelfTest()
{
    constexpr int sampleRate = 48000;
    constexpr int testSamples = 8192;
    SelfTestResult result;
    result.lowFrequencySideToMidLimitDb = lowFrequencySideToMidLimitDb;
    result.highFrequencySideRmsMinimum = highFrequencySideRmsMinimum;
    result.automationOutputPeakLimit = automationOutputPeakLimit;
    result.automationDezipperErrorLimit = automationDezipperErrorLimit;

    juce::AudioBuffer<float> unityInput(2, testSamples);
    fillDeterministicTestSignal(unityInput);
    juce::AudioBuffer<float> unityOutput;
    unityOutput.makeCopyOf(unityInput);
    NAMCabPresentation unityProcessor;
    unityProcessor.prepare(sampleRate, 64);
    processInPartitions(unityProcessor, unityOutput, 8);
    result.zeroEffectMaximumError = maximumAbsoluteDifference(unityInput, unityOutput);
    result.zeroEffectUnity = result.zeroEffectMaximumError == 0.0f;

    NAMCabPresentation delayControlProcessor;
    const bool defaultDelayValid =
        delayControlProcessor.getParameters().doublerDelayMs == 4.5f;
    delayControlProcessor.setDoublerDelayMs(-100.0f);
    const bool minimumDelayValid =
        delayControlProcessor.getParameters().doublerDelayMs == 3.0f;
    delayControlProcessor.setDoublerDelayMs(100.0f);
    const bool maximumDelayValid =
        delayControlProcessor.getParameters().doublerDelayMs == 20.0f;
    delayControlProcessor.setDoublerDelayMs(
        std::numeric_limits<float>::quiet_NaN());
    const bool malformedDelayValid =
        delayControlProcessor.getParameters().doublerDelayMs == 4.5f;
    result.doublerDelayControlValid = defaultDelayValid
        && minimumDelayValid
        && maximumDelayValid
        && malformedDelayValid;

    Parameters activeParameters;
    activeParameters.roomAmount = 0.65f;
    activeParameters.roomWidth = 0.82f;
    activeParameters.doublerMix = 0.72f;
    activeParameters.doublerSpread = 0.78f;
    activeParameters.doublerDelayMs = 4.5f;

    juce::AudioBuffer<float> firstPass;
    firstPass.makeCopyOf(unityInput);
    NAMCabPresentation deterministicProcessor;
    deterministicProcessor.setParameters(activeParameters);
    deterministicProcessor.prepare(sampleRate, 64);
    processInPartitions(deterministicProcessor, firstPass, 64);
    deterministicProcessor.reset();
    juce::AudioBuffer<float> secondPass;
    secondPass.makeCopyOf(unityInput);
    processInPartitions(deterministicProcessor, secondPass, 64);
    result.deterministicResetMaximumError = maximumAbsoluteDifference(firstPass, secondPass);
    result.deterministicReset = result.deterministicResetMaximumError <= selfTestTolerance;

    NAMCabPresentation partitionProcessor;
    partitionProcessor.setParameters(activeParameters);
    partitionProcessor.prepare(sampleRate, testSamples);
    juce::AudioBuffer<float> singleBlock;
    singleBlock.makeCopyOf(unityInput);
    partitionProcessor.process(singleBlock);
    partitionProcessor.reset();
    juce::AudioBuffer<float> partitioned;
    partitioned.makeCopyOf(unityInput);
    processInPartitions(partitionProcessor, partitioned, 13);
    result.blockPartitionMaximumError = maximumAbsoluteDifference(singleBlock, partitioned);
    result.blockPartitionInvariant = result.blockPartitionMaximumError <= selfTestTolerance;

    NAMCabPresentation stereoProcessor;
    NAMCabPresentation monoProcessor;
    stereoProcessor.setParameters(activeParameters);
    monoProcessor.setParameters(activeParameters);
    stereoProcessor.prepare(sampleRate, 64);
    monoProcessor.prepare(sampleRate, 64);
    juce::AudioBuffer<float> stereoSignal;
    stereoSignal.makeCopyOf(unityInput);
    juce::AudioBuffer<float> monoSignal(1, testSamples);
    monoSignal.copyFrom(0, 0, unityInput, 0, 0, testSamples);
    processInPartitions(stereoProcessor, stereoSignal, 8);
    processInPartitions(monoProcessor, monoSignal, 8);
    float monoFoldError = 0.0f;
    for (int sample = 0; sample < testSamples; ++sample)
    {
        const float folded = (stereoSignal.getSample(0, sample)
                              + stereoSignal.getSample(1, sample)) * 0.5f;
        monoFoldError = juce::jmax(
            monoFoldError,
            std::abs(folded - monoSignal.getSample(0, sample)));
    }
    result.monoFoldMaximumError = monoFoldError;
    result.algebraicSideCancellation = monoFoldError <= selfTestTolerance;

    Parameters roomOnly;
    roomOnly.roomAmount = 1.0f;
    roomOnly.roomWidth = 0.65f;
    roomOnly.doublerMix = 0.0f;
    roomOnly.doublerSpread = 0.65f;
    NAMCabPresentation stereoRoomProcessor;
    NAMCabPresentation monoRoomProcessor;
    stereoRoomProcessor.setParameters(roomOnly);
    monoRoomProcessor.setParameters(roomOnly);
    stereoRoomProcessor.prepare(sampleRate, 64);
    monoRoomProcessor.prepare(sampleRate, 64);
    juce::AudioBuffer<float> stereoRoomSignal;
    stereoRoomSignal.makeCopyOf(unityInput);
    juce::AudioBuffer<float> monoRoomSignal(1, testSamples);
    monoRoomSignal.copyFrom(0, 0, unityInput, 0, 0, testSamples);
    processInPartitions(stereoRoomProcessor, stereoRoomSignal, 8);
    processInPartitions(monoRoomProcessor, monoRoomSignal, 8);
    float monoRoomSidePeak = 0.0f;
    float monoRoomFoldError = 0.0f;
    for (int sample = 0; sample < testSamples; ++sample)
    {
        const float roomLeft = stereoRoomSignal.getSample(0, sample);
        const float roomRight = stereoRoomSignal.getSample(1, sample);
        monoRoomSidePeak = juce::jmax(
            monoRoomSidePeak,
            std::abs((roomLeft - roomRight) * 0.5f));
        const float folded = (roomLeft + roomRight) * 0.5f;
        monoRoomFoldError = juce::jmax(
            monoRoomFoldError,
            std::abs(folded - monoRoomSignal.getSample(0, sample)));
    }
    result.monoRoomGeneratedSidePeak = monoRoomSidePeak;
    result.monoRoomFoldMaximumError = monoRoomFoldError;
    result.monoRoomCreatesStereo = monoRoomSidePeak >= 1.0e-4f;
    result.monoRoomFoldContractValid = monoRoomFoldError <= selfTestTolerance;

    NAMCabPresentation roomProcessor;
    roomProcessor.setParameters(roomOnly);
    roomProcessor.prepare(sampleRate, 64);
    constexpr int impulseSamples = 12000;
    juce::AudioBuffer<float> impulse(2, impulseSamples);
    impulse.clear();
    impulse.setSample(0, 0, 1.0f);
    impulse.setSample(1, 0, 1.0f);
    processInPartitions(roomProcessor, impulse, 8);
    result.expectedRoomFirstArrivalSample = juce::roundToInt(3.1f * 0.001f * sampleRate);
    for (int sample = 1; sample < impulseSamples; ++sample)
    {
        const float wetL = impulse.getSample(0, sample);
        const float wetR = impulse.getSample(1, sample);
        if (std::abs(wetL) > 1.0e-8f || std::abs(wetR) > 1.0e-8f)
        {
            result.observedRoomFirstArrivalSample = sample;
            break;
        }
    }
    result.roomFirstArrivalValid =
        result.observedRoomFirstArrivalSample == result.expectedRoomFirstArrivalSample;

    float preArrivalError = 0.0f;
    for (int sample = 0;
         sample < result.expectedRoomFirstArrivalSample;
         ++sample)
    {
        const float expected = sample == 0 ? 1.0f : 0.0f;
        preArrivalError = juce::jmax(
            preArrivalError,
            std::abs(impulse.getSample(0, sample) - expected));
        preArrivalError = juce::jmax(
            preArrivalError,
            std::abs(impulse.getSample(1, sample) - expected));
    }
    result.preArrivalDirectMaximumError = preArrivalError;
    result.preArrivalDirectExact = preArrivalError == 0.0f;

    constexpr int lateRoomMeasurementStart = sampleRate * 3 / 20;
    constexpr int lateRoomMeasurementEnd = sampleRate / 5;
    double lateRoomEnergy = 0.0;
    int lateRoomMeasurementSamples = 0;
    for (int sample = lateRoomMeasurementStart;
         sample < lateRoomMeasurementEnd;
         ++sample)
    {
        const double left = static_cast<double>(impulse.getSample(0, sample));
        const double right = static_cast<double>(impulse.getSample(1, sample));
        lateRoomEnergy += left * left + right * right;
        lateRoomMeasurementSamples += 2;
    }
    result.lateRoom150msRms = lateRoomMeasurementSamples > 0
        ? static_cast<float>(std::sqrt(
            lateRoomEnergy / static_cast<double>(lateRoomMeasurementSamples)))
        : 0.0f;
    result.lateRoomFieldValid = result.lateRoom150msRms >= 1.0e-7f;

    Parameters gatedRoom = roomOnly;
    gatedRoom.roomInputSendEnabled = false;
    NAMCabPresentation gatedNewInputProcessor;
    gatedNewInputProcessor.setParameters(gatedRoom);
    gatedNewInputProcessor.prepare(sampleRate, 64);
    juce::AudioBuffer<float> gatedNewInputReference;
    gatedNewInputReference.makeCopyOf(unityInput);
    juce::AudioBuffer<float> gatedNewInputOutput;
    gatedNewInputOutput.makeCopyOf(unityInput);
    processInPartitions(gatedNewInputProcessor, gatedNewInputOutput, 8);
    result.gatedRoomNewInputMaximumError = maximumAbsoluteDifference(
        gatedNewInputReference,
        gatedNewInputOutput);

    NAMCabPresentation gatedTailProcessor;
    gatedTailProcessor.setParameters(roomOnly);
    gatedTailProcessor.prepare(sampleRate, 64);
    juce::AudioBuffer<float> gatedTailExcitation(2, sampleRate / 8);
    gatedTailExcitation.clear();
    gatedTailExcitation.setSample(0, 0, 1.0f);
    gatedTailExcitation.setSample(1, 0, 1.0f);
    processInPartitions(gatedTailProcessor, gatedTailExcitation, 8);
    gatedTailProcessor.setRoomInputSendEnabled(false);
    juce::AudioBuffer<float> gatedTailDrain(2, sampleRate / 4);
    gatedTailDrain.clear();
    processInPartitions(gatedTailProcessor, gatedTailDrain, 8);
    float gatedTailPeak = 0.0f;
    for (int channel = 0; channel < 2; ++channel)
    {
        for (int sample = 0; sample < gatedTailDrain.getNumSamples(); ++sample)
        {
            gatedTailPeak = juce::jmax(
                gatedTailPeak,
                std::abs(gatedTailDrain.getSample(channel, sample)));
        }
    }
    result.gatedRoomTailPeak = gatedTailPeak;
    result.roomInputSendGateValid =
        result.gatedRoomNewInputMaximumError == 0.0f
        && result.gatedRoomTailPeak >= 1.0e-7f;
    bool multiRateTimingValid = true;
    constexpr std::array<int, 3> roomTimingSampleRates { 44100, 48000, 96000 };
    for (const int timingSampleRate : roomTimingSampleRates)
    {
        NAMCabPresentation timingProcessor;
        timingProcessor.setParameters(roomOnly);
        timingProcessor.prepare(timingSampleRate, 64);
        const int timingSamples = timingSampleRate / 10;
        juce::AudioBuffer<float> timingImpulse(2, timingSamples);
        timingImpulse.clear();
        timingImpulse.setSample(0, 0, 1.0f);
        timingImpulse.setSample(1, 0, 1.0f);
        processInPartitions(timingProcessor, timingImpulse, 8);
        const int expectedFirstArrival = juce::roundToInt(
            3.1f * 0.001f * static_cast<float>(timingSampleRate));
        int observedFirstArrival = -1;
        float timingDirectError = 0.0f;
        for (int sample = 0; sample < timingSamples; ++sample)
        {
            const float expected = sample == 0 ? 1.0f : 0.0f;
            if (sample < expectedFirstArrival)
            {
                timingDirectError = juce::jmax(
                    timingDirectError,
                    std::abs(timingImpulse.getSample(0, sample) - expected));
                timingDirectError = juce::jmax(
                    timingDirectError,
                    std::abs(timingImpulse.getSample(1, sample) - expected));
            }
            if (sample > 0
                && observedFirstArrival < 0
                && (std::abs(timingImpulse.getSample(0, sample)) > 1.0e-8f
                    || std::abs(timingImpulse.getSample(1, sample)) > 1.0e-8f))
            {
                observedFirstArrival = sample;
            }
        }
        multiRateTimingValid = multiRateTimingValid
            && timingDirectError == 0.0f
            && observedFirstArrival == expectedFirstArrival;
    }
    result.multiRateRoomTimingValid = multiRateTimingValid;

    struct ToneFieldMeasurement
    {
        float wetMidRms = 0.0f;
        float sideRms = 0.0f;
    };
    const auto measureRoomTone = [&roomOnly] (float frequencyHz,
                                               int toneSampleRate)
    {
        const int toneSamples = juce::jmax(4096, toneSampleRate / 2);
        Parameters wideRoom = roomOnly;
        wideRoom.roomWidth = 1.0f;
        NAMCabPresentation toneProcessor;
        toneProcessor.setParameters(wideRoom);
        toneProcessor.prepare(toneSampleRate, 64);
        juce::AudioBuffer<float> tone(2, toneSamples);
        for (int sample = 0; sample < toneSamples; ++sample)
        {
            const float phase = static_cast<float>(sample)
                * (2.0f * juce::MathConstants<float>::pi
                   * frequencyHz / static_cast<float>(toneSampleRate));
            const float value = std::sin(phase) * 0.25f;
            tone.setSample(0, sample, value);
            tone.setSample(1, sample, value);
        }
        processInPartitions(toneProcessor, tone, 8);
        double midEnergy = 0.0;
        double sideEnergy = 0.0;
        const int measurementStart = toneSamples / 2;
        for (int sample = measurementStart; sample < toneSamples; ++sample)
        {
            const double left = static_cast<double>(tone.getSample(0, sample));
            const double right = static_cast<double>(tone.getSample(1, sample));
            const double phase = static_cast<double>(sample)
                * (2.0 * juce::MathConstants<double>::pi
                   * static_cast<double>(frequencyHz)
                   / static_cast<double>(toneSampleRate));
            const double dry = std::sin(phase) * 0.25;
            const double wetMid = (left + right) * 0.5 - dry;
            const double side = (left - right) * 0.5;
            midEnergy += wetMid * wetMid;
            sideEnergy += side * side;
        }
        const double inverseCount = 1.0
            / static_cast<double>(toneSamples - measurementStart);
        ToneFieldMeasurement measurement;
        measurement.wetMidRms = static_cast<float>(
            std::sqrt(midEnergy * inverseCount));
        measurement.sideRms = static_cast<float>(
            std::sqrt(sideEnergy * inverseCount));
        return measurement;
    };

    constexpr std::array<int, 3> testSampleRates { 44100, 48000, 96000 };
    float worstLowFrequencyRatioDb = -160.0f;
    float minimumHighFrequencySideRms = std::numeric_limits<float>::max();
    for (const int testSampleRate : testSampleRates)
    {
        const auto lowTone = measureRoomTone(80.0f, testSampleRate);
        const auto highTone = measureRoomTone(1000.0f, testSampleRate);
        const float lowRatioDb = lowTone.sideRms > 0.0f
            ? 20.0f * std::log10(
                lowTone.sideRms
                / juce::jmax(1.0e-12f, lowTone.wetMidRms))
            : -160.0f;
        worstLowFrequencyRatioDb = juce::jmax(
            worstLowFrequencyRatioDb,
            lowRatioDb);
        minimumHighFrequencySideRms = juce::jmin(
            minimumHighFrequencySideRms,
            highTone.sideRms);
    }
    result.room80HzSideToMidDb = worstLowFrequencyRatioDb;
    result.room1kHzSideRms = minimumHighFrequencySideRms;
    result.lowFrequencyRoomFieldCentred =
        result.room80HzSideToMidDb <= lowFrequencySideToMidLimitDb;
    result.highFrequencyRoomSidePresent =
        result.room1kHzSideRms >= highFrequencySideRmsMinimum;

    Parameters automationPrefill;
    automationPrefill.roomAmount = 1.0f;
    automationPrefill.roomWidth = 0.0f;
    automationPrefill.doublerMix = 1.0f;
    automationPrefill.doublerSpread = 0.0f;
    NAMCabPresentation automationProcessor;
    NAMCabPresentation automationReferenceProcessor;
    automationProcessor.setParameters(automationPrefill);
    automationReferenceProcessor.setParameters(automationPrefill);
    automationProcessor.prepare(sampleRate, 64);
    automationReferenceProcessor.prepare(sampleRate, 64);
    constexpr int preAutomationSamples = 4096;
    constexpr int automationOffSamples = 2400;
    constexpr int automatedSamples = 8192;
    juce::AudioBuffer<float> preAutomation(2, preAutomationSamples);
    for (int sample = 0; sample < preAutomationSamples; ++sample)
    {
        const float phase = static_cast<float>(sample)
            * (2.0f * juce::MathConstants<float>::pi * 311.0f
               / static_cast<float>(sampleRate));
        const float value = std::sin(phase) * 0.25f;
        preAutomation.setSample(0, sample, value);
        preAutomation.setSample(1, sample, value);
    }
    juce::AudioBuffer<float> preAutomationReference;
    preAutomationReference.makeCopyOf(preAutomation);
    processInPartitions(automationProcessor, preAutomation, 8);
    processInPartitions(automationReferenceProcessor, preAutomationReference, 8);

    Parameters automationZero;
    automationZero.roomAmount = 0.0f;
    automationZero.roomWidth = 0.0f;
    automationZero.doublerMix = 0.0f;
    automationZero.doublerSpread = 0.0f;
    automationProcessor.setParameters(automationZero);
    automationReferenceProcessor.setParameters(automationZero);
    juce::AudioBuffer<float> automationOff(2, automationOffSamples);
    for (int sample = 0; sample < automationOffSamples; ++sample)
    {
        const int absoluteSample = preAutomationSamples + sample;
        const float phase = static_cast<float>(absoluteSample)
            * (2.0f * juce::MathConstants<float>::pi * 311.0f
               / static_cast<float>(sampleRate));
        const float value = std::sin(phase) * 0.25f;
        automationOff.setSample(0, sample, value);
        automationOff.setSample(1, sample, value);
    }
    juce::AudioBuffer<float> automationOffReference;
    automationOffReference.makeCopyOf(automationOff);
    processInPartitions(automationProcessor, automationOff, 8);
    processInPartitions(automationReferenceProcessor, automationOffReference, 8);
    const float previousAutomatedOutput = automationOff.getSample(
        0, automationOffSamples - 1);
    const float previousReferenceOutput = automationOffReference.getSample(
        0, automationOffSamples - 1);

    juce::AudioBuffer<float> automationDry(2, automatedSamples);
    for (int sample = 0; sample < automatedSamples; ++sample)
    {
        const int absoluteSample = preAutomationSamples
            + automationOffSamples
            + sample;
        const float phase = static_cast<float>(absoluteSample)
            * (2.0f * juce::MathConstants<float>::pi * 311.0f
               / static_cast<float>(sampleRate));
        const float value = std::sin(phase) * 0.25f;
        automationDry.setSample(0, sample, value);
        automationDry.setSample(1, sample, value);
    }
    juce::AudioBuffer<float> automatedOutput;
    automatedOutput.makeCopyOf(automationDry);
    juce::AudioBuffer<float> automationReferenceOutput;
    automationReferenceOutput.makeCopyOf(automationDry);
    Parameters automationMaximum;
    automationMaximum.roomAmount = 1.0f;
    automationMaximum.roomWidth = 1.0f;
    automationMaximum.doublerMix = 1.0f;
    automationMaximum.doublerSpread = 1.0f;
    automationProcessor.setParameters(automationMaximum);
    processInPartitions(automationProcessor, automatedOutput, 8);
    processInPartitions(
        automationReferenceProcessor,
        automationReferenceOutput,
        8);

    bool automationFinite = true;
    float automationPeak = 0.0f;
    for (int channel = 0; channel < automatedOutput.getNumChannels(); ++channel)
    {
        for (int sample = 0; sample < automatedOutput.getNumSamples(); ++sample)
        {
            const float value = automatedOutput.getSample(channel, sample);
            if (! std::isfinite(value))
                automationFinite = false;
            else
                automationPeak = juce::jmax(automationPeak, std::abs(value));
        }
    }
    float previousAutomationDifference = previousAutomatedOutput
        - previousReferenceOutput;
    float first32DezipperError = 0.0f;
    for (int sample = 0; sample < 32; ++sample)
    {
        const float automationDifference = automatedOutput.getSample(0, sample)
            - automationReferenceOutput.getSample(0, sample);
        first32DezipperError = juce::jmax(
            first32DezipperError,
            std::abs(automationDifference - previousAutomationDifference));
        previousAutomationDifference = automationDifference;
    }
    const int postMorphStart = juce::jmin(
        automatedSamples - 1,
        juce::jmax(
            juce::roundToInt(delayMorphSeconds * sampleRate),
            juce::roundToInt(0.020f * sampleRate))
            + 256);
    double postMorphDifferenceEnergy = 0.0;
    int postMorphDifferenceSamples = 0;
    for (int sample = postMorphStart; sample < automatedSamples; ++sample)
    {
        for (int channel = 0; channel < 2; ++channel)
        {
            const double difference = static_cast<double>(
                automatedOutput.getSample(channel, sample)
                - automationReferenceOutput.getSample(channel, sample));
            postMorphDifferenceEnergy += difference * difference;
            ++postMorphDifferenceSamples;
        }
    }
    const float postMorphDifferenceRms = postMorphDifferenceSamples > 0
        ? static_cast<float>(std::sqrt(
            postMorphDifferenceEnergy
            / static_cast<double>(postMorphDifferenceSamples)))
        : 0.0f;
    result.automationMaximumOutputPeak = automationPeak;
    result.automationFirst32DezipperError = first32DezipperError;
    result.automationPostMorphDifferenceRms = postMorphDifferenceRms;
    result.automationFiniteAndBounded = automationFinite
        && automationPeak <= automationOutputPeakLimit;
    result.automationDezippered =
        first32DezipperError <= automationDezipperErrorLimit;
    result.automationPostArrivalExercised =
        postMorphDifferenceRms >= 1.0e-4f;

    NAMCabPresentation transientProcessor;
    transientProcessor.setParameters(automationMaximum);
    transientProcessor.prepare(sampleRate, 64);
    juce::AudioBuffer<float> transientImpulse(2, 1);
    transientImpulse.setSample(0, 0, 1.0f);
    transientImpulse.setSample(1, 0, 1.0f);
    transientProcessor.process(transientImpulse);
    result.roomTransientMinimumGain = transientProcessor.roomTransientDuck;
    result.doublerTransientMinimumGain = transientProcessor.doublerTransientDuck;
    juce::AudioBuffer<float> transientRecovery(2, sampleRate / 2);
    transientRecovery.clear();
    processInPartitions(transientProcessor, transientRecovery, 64);
    result.roomTransientRecoveredGain = transientProcessor.roomTransientDuck;
    result.doublerTransientRecoveredGain = transientProcessor.doublerTransientDuck;
    result.transientProtectionValid =
        result.roomTransientMinimumGain >= 0.69f
        && result.roomTransientMinimumGain <= 0.73f
        && result.doublerTransientMinimumGain >= 0.48f
        && result.doublerTransientMinimumGain <= 0.52f
        && result.roomTransientRecoveredGain >= 0.99f
        && result.doublerTransientRecoveredGain >= 0.99f;

    NAMCabPresentation nonFiniteProcessor;
    nonFiniteProcessor.setParameters(automationMaximum);
    nonFiniteProcessor.prepare(sampleRate, 64);
    juce::AudioBuffer<float> nonFiniteWarmup(2, 64);
    fillDeterministicTestSignal(nonFiniteWarmup);
    nonFiniteProcessor.process(nonFiniteWarmup);
    nonFiniteProcessor.roomWetHighPassL.z1 =
        std::numeric_limits<float>::quiet_NaN();
    nonFiniteProcessor.roomSideHighPass[0].z2 =
        std::numeric_limits<float>::infinity();
    nonFiniteProcessor.doublerWetLowPassR.z1 =
        -std::numeric_limits<float>::infinity();
    nonFiniteProcessor.transientFastEnvelope =
        std::numeric_limits<float>::quiet_NaN();
    nonFiniteProcessor.roomTransientDuck =
        std::numeric_limits<float>::infinity();
    juce::AudioBuffer<float> nonFiniteSignal(2, 4096);
    fillDeterministicTestSignal(nonFiniteSignal);
    nonFiniteSignal.setSample(
        0, 200, std::numeric_limits<float>::quiet_NaN());
    nonFiniteSignal.setSample(
        1, 400, std::numeric_limits<float>::infinity());
    nonFiniteSignal.setSample(
        0, 600, -std::numeric_limits<float>::infinity());
    nonFiniteSignal.setSample(
        1, 600, std::numeric_limits<float>::quiet_NaN());
    processInPartitions(nonFiniteProcessor, nonFiniteSignal, 8);
    bool allRecoveredOutputFinite = true;
    for (int channel = 0; channel < 2; ++channel)
    {
        for (int sample = 0; sample < nonFiniteSignal.getNumSamples(); ++sample)
        {
            if (! std::isfinite(nonFiniteSignal.getSample(channel, sample)))
                allRecoveredOutputFinite = false;
        }
    }
    const auto nonFiniteDiagnostics = nonFiniteProcessor.getDiagnostics();
    const bool invalidDirectSamplesCleared =
        nonFiniteSignal.getSample(0, 200) == 0.0f
        && nonFiniteSignal.getSample(1, 400) == 0.0f
        && nonFiniteSignal.getSample(0, 600) == 0.0f
        && nonFiniteSignal.getSample(1, 600) == 0.0f;
    result.nonFiniteRecoveryValid = allRecoveredOutputFinite
        && invalidDirectSamplesCleared
        && nonFiniteDiagnostics.nonFiniteInputSamples == 4u
        && nonFiniteDiagnostics.nonFiniteWetSamples >= 1u;

    NAMCabPresentation tailProcessor;
    tailProcessor.setParameters(automationMaximum);
    tailProcessor.prepare(sampleRate, 64);
    constexpr int tailTestSamples = sampleRate * 2;
    juce::AudioBuffer<float> tailSignal(2, tailTestSamples);
    tailSignal.clear();
    tailSignal.setSample(0, 0, 1.0f);
    tailSignal.setSample(1, 0, 1.0f);
    processInPartitions(tailProcessor, tailSignal, 8);
    float tailEndPeak = 0.0f;
    const int tailMeasurementStart = tailTestSamples - sampleRate / 10;
    for (int channel = 0; channel < 2; ++channel)
    {
        for (int sample = tailMeasurementStart;
             sample < tailTestSamples;
             ++sample)
        {
            tailEndPeak = juce::jmax(
                tailEndPeak,
                std::abs(tailSignal.getSample(channel, sample)));
        }
    }
    result.tailEndPeak = tailEndPeak;
    result.tailDecayValid = tailEndPeak <= 1.0e-6f;

    result.passed = result.zeroEffectUnity
        && result.deterministicReset
        && result.blockPartitionInvariant
        && result.algebraicSideCancellation
        && result.monoRoomCreatesStereo
        && result.monoRoomFoldContractValid
        && result.roomFirstArrivalValid
        && result.lowFrequencyRoomFieldCentred
        && result.highFrequencyRoomSidePresent
        && result.preArrivalDirectExact
        && result.automationFiniteAndBounded
        && result.automationDezippered
        && result.automationPostArrivalExercised
        && result.multiRateRoomTimingValid
        && result.transientProtectionValid
        && result.nonFiniteRecoveryValid
        && result.tailDecayValid
        && result.roomInputSendGateValid
        && result.lateRoomFieldValid
        && result.doublerDelayControlValid;
    return result;
}

NAMCabPresentation::BenchmarkResult NAMCabPresentation::runBenchmark(
    BenchmarkMode mode,
    double sampleRate,
    int blockSize,
    int measuredBlocks)
{
    BenchmarkResult result;
    result.mode = mode;
    result.sampleRate = std::isfinite(sampleRate)
        ? juce::jmax(8000.0, sampleRate)
        : 48000.0;
    result.blockSize = juce::jlimit(1, 8192, blockSize);
    result.measuredBlocks = juce::jmax(1000, measuredBlocks);

    Parameters benchmarkParameters;
    benchmarkParameters.roomAmount = 1.0f;
    benchmarkParameters.roomWidth = 0.80f;
    benchmarkParameters.doublerMix = mode == BenchmarkMode::roomAndDoubler
        ? 1.0f
        : 0.0f;
    benchmarkParameters.doublerSpread = mode == BenchmarkMode::roomAndDoubler
        ? 1.0f
        : 0.65f;

    NAMCabPresentation processor;
    processor.setParameters(benchmarkParameters);
    processor.prepare(result.sampleRate, result.blockSize);

    juce::AudioBuffer<float> dry(2, result.blockSize);
    juce::AudioBuffer<float> processed(2, result.blockSize);
    std::uint32_t randomState = 0x243f6a88u;
    for (int sample = 0; sample < result.blockSize; ++sample)
    {
        randomState ^= randomState << 13u;
        randomState ^= randomState >> 17u;
        randomState ^= randomState << 5u;
        const float noise = static_cast<float>(randomState & 0x00ffffffu)
            * (2.0f / 16777215.0f) - 1.0f;
        const float value = noise * 0.22f;
        dry.setSample(0, sample, value);
        dry.setSample(1, sample, value);
    }

    const auto restoreDry = [&dry, &processed] () noexcept
    {
        processed.copyFrom(0, 0, dry, 0, 0, dry.getNumSamples());
        processed.copyFrom(1, 0, dry, 1, 0, dry.getNumSamples());
    };

    constexpr int warmupBlocks = 4096;
    for (int block = 0; block < warmupBlocks; ++block)
    {
        restoreDry();
        processor.process(processed);
    }

    std::vector<double> callbackMicroseconds(
        static_cast<std::size_t>(result.measuredBlocks),
        0.0);
    float processedChecksum = 0.0f;
    double elapsedMicroseconds = 0.0;
    result.callbackDeadlineMicroseconds =
        static_cast<double>(result.blockSize) / result.sampleRate * 1000000.0;
    for (int block = 0; block < result.measuredBlocks; ++block)
    {
        restoreDry();
        const juce::int64 callbackStart = juce::Time::getHighResolutionTicks();
        processor.process(processed);
        const juce::int64 callbackTicks = juce::Time::getHighResolutionTicks()
            - callbackStart;
        const double callbackTimeMicroseconds =
            juce::Time::highResolutionTicksToSeconds(callbackTicks)
            * 1000000.0;
        callbackMicroseconds[static_cast<std::size_t>(block)] =
            callbackTimeMicroseconds;
        elapsedMicroseconds += callbackTimeMicroseconds;
        if (callbackTimeMicroseconds > result.callbackDeadlineMicroseconds)
            ++result.deadlineMisses;
        processedChecksum += processed.getSample(0, block % result.blockSize)
            * 1.0e-9f;
    }
    std::sort(callbackMicroseconds.begin(), callbackMicroseconds.end());
    const auto percentile = [&callbackMicroseconds] (double proportion)
    {
        const auto count = callbackMicroseconds.size();
        const auto index = static_cast<std::size_t>(juce::jlimit(
            0.0,
            static_cast<double>(count - 1u),
            std::ceil(proportion * static_cast<double>(count)) - 1.0));
        return callbackMicroseconds[index];
    };

    result.netElapsedMilliseconds = elapsedMicroseconds * 0.001;
    result.averageMicrosecondsPerBlock = elapsedMicroseconds
        / static_cast<double>(result.measuredBlocks);
    result.p99Microseconds = percentile(0.99);
    result.p999Microseconds = percentile(0.999);
    result.maximumMicroseconds = callbackMicroseconds.back();
    result.realtimeDeadlineFraction = result.averageMicrosecondsPerBlock
        / juce::jmax(1.0e-12, result.callbackDeadlineMicroseconds);
    result.outputChecksum = processedChecksum;
    result.generatedSidePeak = processor.getDiagnostics().lastGeneratedSidePeak;
    // Percentiles characterize this component's repeatable processing cost.
    // A userspace wall-clock maximum (and its derived miss count) can include
    // an unrelated Windows scheduler pre-emption, so those values stay in the
    // report as diagnostics rather than making a deterministic DSP gate flaky.
    result.deadlineCriteriaPassed =
        result.averageMicrosecondsPerBlock
            <= result.callbackDeadlineMicroseconds * 0.25
        && result.p99Microseconds
            <= result.callbackDeadlineMicroseconds * 0.50
        && result.p999Microseconds
            <= result.callbackDeadlineMicroseconds * 0.75;
    result.valid = std::isfinite(result.averageMicrosecondsPerBlock)
        && result.averageMicrosecondsPerBlock >= 0.0
        && result.generatedSidePeak > 1.0e-6f
        && result.deadlineCriteriaPassed;
    return result;
}

NAMCabPresentation::BenchmarkResult NAMCabPresentation::runRoomOnlyBenchmark(
    double sampleRate,
    int blockSize,
    int measuredBlocks)
{
    return runBenchmark(
        BenchmarkMode::roomOnly,
        sampleRate,
        blockSize,
        measuredBlocks);
}

NAMCabPresentation::BenchmarkResult NAMCabPresentation::runRoomAndDoublerBenchmark(
    double sampleRate,
    int blockSize,
    int measuredBlocks)
{
    return runBenchmark(
        BenchmarkMode::roomAndDoubler,
        sampleRate,
        blockSize,
        measuredBlocks);
}
