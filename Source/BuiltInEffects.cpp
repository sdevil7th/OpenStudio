#include "BuiltInEffects.h"
#include "S13PluginEditors.h"

//==============================================================================
// S13BuiltInEffect -- shared base class
//==============================================================================

S13BuiltInEffect::S13BuiltInEffect()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

bool S13BuiltInEffect::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainIn  = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();
    if (mainOut != mainIn) return false;
    return mainOut == juce::AudioChannelSet::mono()
        || mainOut == juce::AudioChannelSet::stereo();
}

void S13BuiltInEffect::setOversamplingEnabled(bool enabled)
{
    oversamplingEnabled = enabled;
}

juce::AudioProcessorEditor* S13BuiltInEffect::createEditor()
{
    return nullptr; // Derived classes override this
}

juce::AudioProcessorEditor* S13EQ::createEditor() { return new S13EQEditor(*this); }
juce::AudioProcessorEditor* S13Compressor::createEditor() { return new S13CompressorEditor(*this); }
juce::AudioProcessorEditor* S13Gate::createEditor() { return new S13GateEditor(*this); }
juce::AudioProcessorEditor* S13Limiter::createEditor() { return new S13LimiterEditor(*this); }

static void sanitizeBuiltInBuffer(juce::AudioBuffer<float>& buffer, float limit)
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto* samples = buffer.getWritePointer(ch);
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            const float value = samples[sample];
            samples[sample] = std::isfinite(value) ? juce::jlimit(-limit, limit, value) : 0.0f;
        }
    }
}

static void clearNonFiniteBuiltInBuffer(juce::AudioBuffer<float>& buffer) noexcept
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto* samples = buffer.getWritePointer(ch);
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            if (! std::isfinite(samples[sample]))
                samples[sample] = 0.0f;
        }
    }
}

static float boundProcessedWetSample(float value,
                                     float limit = 2.5f) noexcept
{
    return std::isfinite(value)
        ? juce::jlimit(-limit, limit, value)
        : 0.0f;
}

namespace
{
constexpr size_t kRealtimeFilterLutSize = 513;

float safeFilterMaximum(double sampleRate, float nominalMinimum, float nominalMaximum)
{
    return juce::jmax(nominalMinimum,
                      juce::jmin(nominalMaximum,
                                 static_cast<float>(sampleRate * 0.475)));
}

void prepareRealtimeFilterLut(std::vector<S13IIRCoefficientSet>& lut,
                              double sampleRate,
                              float nominalMinimum,
                              float nominalMaximum,
                              bool highPass)
{
    const float safeMinimum = juce::jmax(1.0f, nominalMinimum);
    const float safeMaximum = safeFilterMaximum(sampleRate, safeMinimum, nominalMaximum);
    const double logMinimum = std::log(static_cast<double>(safeMinimum));
    const double logRange = std::log(static_cast<double>(safeMaximum)) - logMinimum;
    lut.resize(kRealtimeFilterLutSize);

    for (size_t index = 0; index < lut.size(); ++index)
    {
        const double proportion = static_cast<double>(index)
            / static_cast<double>(lut.size() - 1);
        const float frequency = static_cast<float>(std::exp(logMinimum + proportion * logRange));
        const auto coefficients = highPass
            ? juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, frequency)
            : juce::dsp::IIR::Coefficients<float>::makeLowPass(sampleRate, frequency);
        const auto& source = coefficients->coefficients;
        jassert(source.size() == lut[index].size());
        for (size_t coefficient = 0; coefficient < lut[index].size(); ++coefficient)
            lut[index][coefficient] = source[static_cast<int>(coefficient)];
    }
}

const S13IIRCoefficientSet& lookupRealtimeFilterLut(
    const std::vector<S13IIRCoefficientSet>& lut,
    double sampleRate,
    float frequency,
    float nominalMinimum,
    float nominalMaximum) noexcept
{
    jassert(! lut.empty());
    const float safeMinimum = juce::jmax(1.0f, nominalMinimum);
    const float safeMaximum = safeFilterMaximum(sampleRate, safeMinimum, nominalMaximum);
    const double logMinimum = std::log(static_cast<double>(safeMinimum));
    const double logRange = std::log(static_cast<double>(safeMaximum)) - logMinimum;
    const double position = logRange > 0.0
        ? (std::log(static_cast<double>(juce::jlimit(safeMinimum, safeMaximum, frequency))) - logMinimum)
            / logRange
        : 0.0;
    const auto index = static_cast<size_t>(juce::jlimit(
        0,
        static_cast<int>(lut.size() - 1),
        static_cast<int>(std::lround(position * static_cast<double>(lut.size() - 1)))));
    return lut[index];
}

void writeRealtimeFilterCoefficients(juce::dsp::IIR::Filter<float>& filter,
                                     const S13IIRCoefficientSet& coefficients) noexcept
{
    jassert(filter.coefficients != nullptr);
    if (filter.coefficients == nullptr)
        return;

    auto& destination = filter.coefficients->coefficients;
    jassert(destination.size() == coefficients.size());
    if (destination.size() != coefficients.size())
        return;

    for (size_t coefficient = 0; coefficient < coefficients.size(); ++coefficient)
        destination.set(static_cast<int>(coefficient), coefficients[coefficient]);
}

void writeRealtimeFilterCoefficients(juce::dsp::IIR::Filter<float>& left,
                                     juce::dsp::IIR::Filter<float>& right,
                                     const S13IIRCoefficientSet& coefficients) noexcept
{
    writeRealtimeFilterCoefficients(left, coefficients);
    if (right.coefficients != left.coefficients)
        writeRealtimeFilterCoefficients(right, coefficients);
}

bool advanceRealtimeFilterCoefficients(
    juce::dsp::IIR::Filter<float>& filter,
    const S13IIRCoefficientSet& target,
    float smoothingProportion) noexcept
{
    if (filter.coefficients == nullptr)
        return false;

    auto& coefficients = filter.coefficients->coefficients;
    jassert(coefficients.size() == static_cast<int>(target.size()));
    if (coefficients.size() != static_cast<int>(target.size()))
        return false;

    constexpr float settleThreshold = 1.0e-6f;
    bool stillSmoothing = false;
    for (size_t index = 0; index < target.size(); ++index)
    {
        const int coefficientIndex = static_cast<int>(index);
        const float current = coefficients[coefficientIndex];
        const float difference = target[index] - current;
        if (std::abs(difference) <= settleThreshold)
        {
            coefficients.set(coefficientIndex, target[index]);
            continue;
        }

        const float next = current + difference * smoothingProportion;
        const bool settled =
            std::abs(target[index] - next) <= settleThreshold;
        coefficients.set(
            coefficientIndex,
            settled ? target[index] : next);
        stillSmoothing = stillSmoothing || ! settled;
    }
    return stillSmoothing;
}

bool advanceRealtimeFilterCoefficients(
    juce::dsp::IIR::Filter<float>& left,
    juce::dsp::IIR::Filter<float>& right,
    const S13IIRCoefficientSet& target,
    float smoothingProportion) noexcept
{
    const bool leftSmoothing =
        advanceRealtimeFilterCoefficients(
            left, target, smoothingProportion);
    if (right.coefficients == left.coefficients)
        return leftSmoothing;

    return advanceRealtimeFilterCoefficients(
               right, target, smoothingProportion)
        || leftSmoothing;
}

constexpr S13IIRCoefficientSet kIdentityBiquad {
    1.0f, 0.0f, 0.0f, 0.0f, 0.0f
};

S13IIRCoefficientSet normaliseBiquad(
    const std::array<float, 6>& coefficients) noexcept
{
    const float inverseA0 = std::abs(coefficients[3]) > 1.0e-12f
        ? 1.0f / coefficients[3]
        : 0.0f;
    return {
        coefficients[0] * inverseA0,
        coefficients[1] * inverseA0,
        coefficients[2] * inverseA0,
        coefficients[4] * inverseA0,
        coefficients[5] * inverseA0
    };
}

S13IIRCoefficientSet normaliseFirstOrderAsBiquad(
    const std::array<float, 4>& coefficients) noexcept
{
    const float inverseA0 = std::abs(coefficients[2]) > 1.0e-12f
        ? 1.0f / coefficients[2]
        : 0.0f;
    return {
        coefficients[0] * inverseA0,
        coefficients[1] * inverseA0,
        0.0f,
        coefficients[3] * inverseA0,
        0.0f
    };
}

double getFixedBiquadMagnitude(const S13IIRCoefficientSet& coefficients,
                              double frequency,
                              double sampleRate) noexcept
{
    if (sampleRate <= 0.0)
        return 1.0;

    const double angle = -juce::MathConstants<double>::twoPi
        * juce::jlimit(0.0, sampleRate * 0.499, frequency)
        / sampleRate;
    const std::complex<double> z1(std::cos(angle), std::sin(angle));
    const auto z2 = z1 * z1;
    const std::complex<double> numerator =
        static_cast<double>(coefficients[0])
        + static_cast<double>(coefficients[1]) * z1
        + static_cast<double>(coefficients[2]) * z2;
    const std::complex<double> denominator =
        1.0
        + static_cast<double>(coefficients[3]) * z1
        + static_cast<double>(coefficients[4]) * z2;
    const double denominatorMagnitude = std::abs(denominator);
    return denominatorMagnitude > 1.0e-15
        ? std::abs(numerator) / denominatorMagnitude
        : 1.0;
}
}

//==============================================================================
//  S13EQ -- 8-band parametric EQ
//==============================================================================

S13EQ::S13EQ()
{
    const float defaultFreqs[numBands] = { 30.0f, 100.0f, 250.0f, 500.0f, 1000.0f, 2500.0f, 6000.0f, 12000.0f };
    for (int i = 0; i < numBands; ++i)
    {
        bands[i].freq.store(defaultFreqs[i]);
        bands[i].enabled.store(1.0f);
        bands[i].type.store(static_cast<float>(FilterType::Bell));
        bands[i].gain.store(0.0f);
        bands[i].q.store(1.0f);
        bands[i].slope.store(static_cast<float>(FilterSlope::dB12));
        bands[i].dynamicEnabled.store(0.0f);
        bands[i].dynamicThreshold.store(-24.0f);
        bands[i].dynamicRange.store(0.0f);
        bands[i].dynamicAttack.store(10.0f);
        bands[i].dynamicRelease.store(150.0f);
        dynamicEnvelope[static_cast<size_t>(i)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(i)].store(0.0f);
    }
    // First band defaults to low cut (off), last to high cut (off)
    bands[0].type.store(static_cast<float>(FilterType::LowCut));
    bands[0].freq.store(20.0f);
    bands[0].enabled.store(0.0f);
    bands[numBands - 1].type.store(static_cast<float>(FilterType::HighCut));
    bands[numBands - 1].freq.store(20000.0f);
    bands[numBands - 1].enabled.store(0.0f);
}

int S13EQ::getNumStagesForSlope(FilterSlope slope) const
{
    switch (slope)
    {
        case FilterSlope::dB6:  return 1;
        case FilterSlope::dB12: return 1;
        case FilterSlope::dB24: return 2;
        case FilterSlope::dB48: return 4;
        default: return 1;
    }
}

void S13EQ::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    publishedSampleRate.store(sampleRate, std::memory_order_release);
    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2u };

    juce::dsp::ProcessSpec monoSpec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 1u };
    for (int b = 0; b < numBands; ++b)
    {
        for (int s = 0; s < maxStagesPerBand; ++s)
        {
            // Keep every runtime state at biquad order so coefficient morphing
            // never resizes JUCE's coefficient vector on the callback.
            *bandFilters[b][s].state =
                juce::dsp::IIR::Coefficients<float>(
                    1.0f, 0.0f, 0.0f,
                    1.0f, 0.0f, 0.0f);
            bandFilters[b][s].prepare(spec);
            targetBandCoefficients[static_cast<size_t>(b)]
                                  [static_cast<size_t>(s)] =
                kIdentityBiquad;
        }
        for (int ch = 0; ch < 2; ++ch)
        {
            *dynamicDetectorFilters[b][ch].coefficients =
                juce::dsp::IIR::Coefficients<float>(
                    1.0f, 0.0f, 0.0f,
                    1.0f, 0.0f, 0.0f);
            dynamicDetectorFilters[b][ch].prepare(monoSpec);
        }
        dynamicEnvelope[static_cast<size_t>(b)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(b)].store(0.0f, std::memory_order_relaxed);
        cachedBandStates[static_cast<size_t>(b)].valid = false;
        cachedDynamicDetectorStates[static_cast<size_t>(b)].valid = false;
        activeStages[b] = 0;
        targetStages[b] = 0;
    }

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
    msScratch.setSize(1, samplesPerBlock, false, false, true);
    msScratch.clear();
    dryScratch.setSize(2, samplesPerBlock, false, false, true);
    dryScratch.clear();

    const float initialPower =
        powerEnabled.load(std::memory_order_acquire) ? 1.0f : 0.0f;
    smoothedPowerMix.reset(sampleRate, 0.015);
    smoothedPowerMix.setCurrentAndTargetValue(initialPower);
    smoothedModeMix.reset(sampleRate, 0.005);
    smoothedModeMix.setCurrentAndTargetValue(1.0f);
    smoothedOutputGain.reset(sampleRate, 0.020);
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(-18.0f, 18.0f,
                         outputGain.load(std::memory_order_relaxed))));
    activeProcessingMode = juce::jlimit(
        0, 2,
        static_cast<int>(std::round(
            stereoMode.load(std::memory_order_relaxed))));
    pendingProcessingMode = activeProcessingMode;
    modeTransitionPending = false;
    wetPathHasState = initialPower > 0.0f;

    // Coefficient interpolation is a click-prevention bound, not a second
    // dynamics envelope. A fixed 20 ms morph made fast dynamic-EQ attack
    // settings meaningless. Three milliseconds keeps topology moves click-safe
    // at very small host blocks while remaining short relative to the detector
    // ballistics exposed by the channel-strip surface.
    coefficientMorphProportion = 1.0f - std::exp(
        -static_cast<float>(coefficientMorphChunkSize)
        / static_cast<float>(juce::jmax(1.0, sampleRate) * 0.003));
    cachedAuditionIndex = -2;
    filtersPrepared = true;
    filtersNeedSmoothing = false;
    updateFilters(true);
    smoothedAutoGainDB = 0.0f;
    cachedAutoGainTargetDB = 0.0f;
    autoGainProbeWeightedSum = 0.0f;
    autoGainProbeWeightTotal = 0.0f;
    autoGainProbeIndex = 0;
    autoGainProbeSamplesUntilAdvance = 0;

    spectrumDemandSamplesRemaining.store(0, std::memory_order_release);
    spectrumCaptureSlot = -1;
    spectrumCaptureWritePos = 0;
    spectrumCaptureGeneration = 0;
    for (auto& slot : spectrumCaptureSlots)
    {
        slot.generation.store(0, std::memory_order_relaxed);
        slot.state.store(0, std::memory_order_release);
    }
}

static float butterworthCascadeStageQ(int stageIndex,
                                      int stageCount) noexcept
{
    // For an even-order Butterworth response (order = 2 * stageCount), each
    // biquad needs its own conjugate-pole Q. Repeating Q=0.707 sections makes
    // 24/48 dB cuts droop at the labelled cutoff and is not a Butterworth
    // cascade. Order the sections from low to high Q for stable headroom.
    const int safeStageCount = juce::jmax(1, stageCount);
    const int safeStageIndex = juce::jlimit(
        0, safeStageCount - 1, stageIndex);
    const float angle =
        juce::MathConstants<float>::pi
        * static_cast<float>(2 * safeStageIndex + 1)
        / static_cast<float>(4 * safeStageCount);
    return 1.0f / (2.0f * std::cos(angle));
}

void S13EQ::reset()
{
    resetWetPathState();
    if (oversampler)
        oversampler->reset();
    msScratch.clear();
    dryScratch.clear();
    smoothedAutoGainDB = 0.0f;
    cachedAutoGainTargetDB = 0.0f;
    autoGainProbeWeightedSum = 0.0f;
    autoGainProbeWeightTotal = 0.0f;
    autoGainProbeIndex = 0;
    autoGainProbeSamplesUntilAdvance = 0;
    gainReductionDB.store(0.0f, std::memory_order_relaxed);

    const float currentPower =
        powerEnabled.load(std::memory_order_acquire) ? 1.0f : 0.0f;
    smoothedPowerMix.setCurrentAndTargetValue(currentPower);
    smoothedModeMix.setCurrentAndTargetValue(1.0f);
    smoothedOutputGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(-18.0f, 18.0f,
                         outputGain.load(std::memory_order_relaxed))));
    activeProcessingMode = juce::jlimit(
        0, 2,
        static_cast<int>(std::round(
            stereoMode.load(std::memory_order_relaxed))));
    pendingProcessingMode = activeProcessingMode;
    modeTransitionPending = false;
    wetPathHasState = currentPower > 0.0f;

    spectrumDemandSamplesRemaining.store(0, std::memory_order_release);
    spectrumCaptureSlot = -1;
    spectrumCaptureWritePos = 0;
    for (auto& slot : spectrumCaptureSlots)
    {
        int expected = 1;
        if (!slot.state.compare_exchange_strong(
                expected, 0,
                std::memory_order_acq_rel,
                std::memory_order_acquire))
        {
            expected = 2;
            slot.state.compare_exchange_strong(
                expected, 0,
                std::memory_order_acq_rel,
                std::memory_order_acquire);
        }
    }
}

void S13EQ::releaseResources()
{
    filtersPrepared = false;
    spectrumDemandSamplesRemaining.store(0, std::memory_order_release);
    spectrumCaptureSlot = -1;
    spectrumCaptureWritePos = 0;
    for (int b = 0; b < numBands; ++b)
    {
        for (int s = 0; s < maxStagesPerBand; ++s)
            bandFilters[b][s].reset();
        for (int ch = 0; ch < 2; ++ch)
        dynamicDetectorFilters[b][ch].reset();
        dynamicEnvelope[static_cast<size_t>(b)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(b)].store(0.0f, std::memory_order_relaxed);
        cachedBandStates[static_cast<size_t>(b)].valid = false;
        cachedDynamicDetectorStates[static_cast<size_t>(b)].valid = false;
        activeStages[b] = 0;
        targetStages[b] = 0;
    }
    cachedAuditionIndex = -2;
    filtersNeedSmoothing = false;
    smoothedAutoGainDB = 0.0f;
    cachedAutoGainTargetDB = 0.0f;
    autoGainProbeWeightedSum = 0.0f;
    autoGainProbeWeightTotal = 0.0f;
    autoGainProbeIndex = 0;
    autoGainProbeSamplesUntilAdvance = 0;
    msScratch.setSize(0, 0);
    dryScratch.setSize(0, 0);
    activeProcessingMode = 0;
    pendingProcessingMode = 0;
    modeTransitionPending = false;
    wetPathHasState = false;
    for (auto& slot : spectrumCaptureSlots)
    {
        int expected = 1;
        if (!slot.state.compare_exchange_strong(
                expected, 0,
                std::memory_order_acq_rel,
                std::memory_order_acquire))
        {
            expected = 2;
            slot.state.compare_exchange_strong(
                expected, 0,
                std::memory_order_acq_rel,
                std::memory_order_acquire);
        }
    }
}

int S13EQ::buildBandTargets(
    int b,
    bool shouldProcess,
    std::array<S13IIRCoefficientSet, maxStagesPerBand>& targets) const noexcept
{
    targets.fill(kIdentityBiquad);
    if (!shouldProcess)
        return 0;

    const double sr =
        publishedSampleRate.load(std::memory_order_acquire);
    if (sr <= 0.0)
        return 0;

    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;
    const auto type = static_cast<FilterType>(
        juce::jlimit(0, static_cast<int>(FilterType::BandPass),
                     static_cast<int>(std::round(
                         bands[b].type.load(std::memory_order_relaxed)))));
    const auto slope = static_cast<FilterSlope>(
        juce::jlimit(0, static_cast<int>(FilterSlope::dB48),
                     static_cast<int>(std::round(
                         bands[b].slope.load(std::memory_order_relaxed)))));
    const float freq = juce::jlimit(
        20.0f, nyquist,
        bands[b].freq.load(std::memory_order_relaxed));
    const float baseGainDB = bands[b].gain.load(std::memory_order_relaxed);
    const float dynamicDB = dynamicGainDB[static_cast<size_t>(b)].load(std::memory_order_relaxed);
    const float gainDB = juce::jlimit(-30.0f, 30.0f, baseGainDB + dynamicDB);
    const float q = juce::jlimit(
        0.1f, 30.0f,
        bands[b].q.load(std::memory_order_relaxed));
    const float gainFactor = juce::Decibels::decibelsToGain(gainDB);
    using ArrayCoefficients =
        juce::dsp::IIR::ArrayCoefficients<float>;

    switch (type)
    {
        case FilterType::Bell:
            targets[0] = normaliseBiquad(
                ArrayCoefficients::makePeakFilter(
                    sr, freq, q, gainFactor));
            return 1;

        case FilterType::LowShelf:
        {
            const int numStages = getNumStagesForSlope(slope);
            const float perStageGain = std::pow(
                gainFactor,
                1.0f / static_cast<float>(juce::jmax(1, numStages)));
            // A single Q=0.5 section is the gentle 6 dB/oct option. The
            // remaining choices retain the user's shelf-Q and cascade
            // gain-distributed sections, so 24/48 dB selections no longer
            // produce the exact same curve as 12 dB.
            const float stageQ = slope == FilterSlope::dB6
                ? 0.5f
                : q;
            for (int s = 0; s < numStages; ++s)
            {
                targets[static_cast<size_t>(s)] = normaliseBiquad(
                    ArrayCoefficients::makeLowShelf(
                        sr, freq, stageQ, perStageGain));
            }
            return numStages;
        }

        case FilterType::HighShelf:
        {
            const int numStages = getNumStagesForSlope(slope);
            const float perStageGain = std::pow(
                gainFactor,
                1.0f / static_cast<float>(juce::jmax(1, numStages)));
            const float stageQ = slope == FilterSlope::dB6
                ? 0.5f
                : q;
            for (int s = 0; s < numStages; ++s)
            {
                targets[static_cast<size_t>(s)] = normaliseBiquad(
                    ArrayCoefficients::makeHighShelf(
                        sr, freq, stageQ, perStageGain));
            }
            return numStages;
        }

        case FilterType::LowCut:
        {
            const int numStages = getNumStagesForSlope(slope);
            if (slope == FilterSlope::dB6)
            {
                targets[0] = normaliseFirstOrderAsBiquad(
                    ArrayCoefficients::makeFirstOrderHighPass(
                        sr, freq));
            }
            else
            {
                for (int s = 0; s < numStages; ++s)
                {
                    targets[static_cast<size_t>(s)] = normaliseBiquad(
                        ArrayCoefficients::makeHighPass(
                            sr,
                            freq,
                            butterworthCascadeStageQ(s, numStages)));
                }
            }
            return numStages;
        }

        case FilterType::HighCut:
        {
            const int numStages = getNumStagesForSlope(slope);
            if (slope == FilterSlope::dB6)
            {
                targets[0] = normaliseFirstOrderAsBiquad(
                    ArrayCoefficients::makeFirstOrderLowPass(
                        sr, freq));
            }
            else
            {
                for (int s = 0; s < numStages; ++s)
                {
                    targets[static_cast<size_t>(s)] = normaliseBiquad(
                        ArrayCoefficients::makeLowPass(
                            sr,
                            freq,
                            butterworthCascadeStageQ(s, numStages)));
                }
            }
            return numStages;
        }

        case FilterType::Notch:
            targets[0] = normaliseBiquad(
                ArrayCoefficients::makeNotch(sr, freq, q));
            return 1;

        case FilterType::BandPass:
            targets[0] = normaliseBiquad(
                ArrayCoefficients::makeBandPass(sr, freq, q));
            return 1;
    }

    return 0;
}

void S13EQ::updateBand(int b, int auditionIndex, bool forceImmediate)
{
    const bool shouldProcess = auditionIndex >= 0
        ? b == auditionIndex
        : bands[b].enabled.load(std::memory_order_relaxed) >= 0.5f;
    auto& targets =
        targetBandCoefficients[static_cast<size_t>(b)];
    targetStages[b] = buildBandTargets(b, shouldProcess, targets);
    activeStages[b] = juce::jmax(
        activeStages[b], targetStages[b]);

    if (!forceImmediate)
    {
        filtersNeedSmoothing = true;
        return;
    }

    for (int stage = 0; stage < maxStagesPerBand; ++stage)
    {
        const auto& target =
            targets[static_cast<size_t>(stage)];
        auto& coefficientVector =
            bandFilters[b][stage].state->coefficients;
        jassert(coefficientVector.size()
                == static_cast<int>(target.size()));
        for (size_t coefficient = 0;
             coefficient < target.size();
             ++coefficient)
        {
            coefficientVector.set(
                static_cast<int>(coefficient),
                target[coefficient]);
        }
        bandFilters[b][stage].reset();
    }
    activeStages[b] = targetStages[b];
}

void S13EQ::updateFilters(bool forceImmediate)
{
    if (!filtersPrepared)
        return;

    const int auditionIndex = juce::jlimit(
        -1, numBands - 1,
        static_cast<int>(std::round(
            auditionBand.load(std::memory_order_relaxed))) - 1);
    const bool auditionChanged =
        auditionIndex != cachedAuditionIndex;

    for (int b = 0; b < numBands; ++b)
    {
        auto& cached = cachedBandStates[static_cast<size_t>(b)];
        const float enabled = bands[b].enabled.load(std::memory_order_relaxed) >= 0.5f ? 1.0f : 0.0f;
        const int type = static_cast<int>(bands[b].type.load(std::memory_order_relaxed));
        const float freq = bands[b].freq.load(std::memory_order_relaxed);
        const float baseGain = bands[b].gain.load(std::memory_order_relaxed);
        const float dynamicGain = dynamicGainDB[static_cast<size_t>(b)].load(std::memory_order_relaxed);
        const float gain = juce::jlimit(-30.0f, 30.0f, baseGain + dynamicGain);
        const float q = bands[b].q.load(std::memory_order_relaxed);
        const int slope = static_cast<int>(bands[b].slope.load(std::memory_order_relaxed));

        const bool changed = forceImmediate
                          || auditionChanged
                          || !cached.valid
                          || cached.enabled != enabled
                          || cached.type != type
                          || cached.slope != slope
                          || std::abs(cached.freq - freq) > 0.01f
                          || std::abs(cached.gain - gain) > 0.02f
                          || std::abs(cached.q - q) > 0.001f;
        if (!changed)
            continue;

        updateBand(b, auditionIndex, forceImmediate);
        cached.valid = true;
        cached.enabled = enabled;
        cached.type = type;
        cached.freq = freq;
        cached.gain = gain;
        cached.q = q;
        cached.slope = slope;
    }
    cachedAuditionIndex = auditionIndex;
    if (forceImmediate)
        filtersNeedSmoothing = false;
}

void S13EQ::updateDynamicBands(const juce::AudioBuffer<float>& buffer,
                               int detectorChannels)
{
    const int numSamples = buffer.getNumSamples();
    const int numChannels = juce::jlimit(
        0,
        juce::jmin(2, buffer.getNumChannels()),
        detectorChannels);
    const double sr = cachedSampleRate > 0.0 ? cachedSampleRate : 44100.0;

    if (numSamples <= 0 || numChannels <= 0)
        return;

    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;
    for (int b = 0; b < numBands; ++b)
    {
        const size_t bandIndex = static_cast<size_t>(b);
        const float rangeDB = juce::jlimit(-24.0f, 24.0f, bands[b].dynamicRange.load(std::memory_order_relaxed));
        const bool dynamicOn = bands[b].dynamicEnabled.load(std::memory_order_relaxed) >= 0.5f && std::abs(rangeDB) > 0.01f;
        if (!dynamicOn)
        {
            dynamicEnvelope[bandIndex] *= 0.85f;
            const float current = dynamicGainDB[bandIndex].load(std::memory_order_relaxed);
            dynamicGainDB[bandIndex].store(current * 0.85f, std::memory_order_relaxed);
            continue;
        }

        const float freq = juce::jlimit(20.0f, nyquist, bands[b].freq.load(std::memory_order_relaxed));
        const float q = juce::jlimit(0.1f, 30.0f, bands[b].q.load(std::memory_order_relaxed));
        auto& detectorCache = cachedDynamicDetectorStates[bandIndex];
        const bool detectorChanged = !detectorCache.valid
                                  || std::abs(detectorCache.freq - freq) > 0.01f
                                  || std::abs(detectorCache.q - q) > 0.001f;
        if (detectorChanged)
        {
            const auto detectorCoefficients = normaliseBiquad(
                juce::dsp::IIR::ArrayCoefficients<float>::makeBandPass(
                    sr, freq, q));
            for (int ch = 0; ch < 2; ++ch)
            {
                writeRealtimeFilterCoefficients(
                    dynamicDetectorFilters[b][ch],
                    detectorCoefficients);
            }
            detectorCache.valid = true;
            detectorCache.freq = freq;
            detectorCache.q = q;
        }

        float sumSquares = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            for (int ch = 0; ch < numChannels; ++ch)
            {
                const float filtered = dynamicDetectorFilters[b][ch].processSample(buffer.getSample(ch, i));
                sumSquares += filtered * filtered;
            }
        }

        const float blockLevel = std::sqrt(sumSquares / static_cast<float>(numSamples * numChannels));
        const float attackMs = juce::jlimit(0.2f, 250.0f, bands[b].dynamicAttack.load(std::memory_order_relaxed));
        const float releaseMs = juce::jlimit(5.0f, 2000.0f, bands[b].dynamicRelease.load(std::memory_order_relaxed));
        const float attackCoeff = std::exp(-static_cast<float>(numSamples) / (attackMs * 0.001f * static_cast<float>(sr)));
        const float releaseCoeff = std::exp(-static_cast<float>(numSamples) / (releaseMs * 0.001f * static_cast<float>(sr)));
        const float levelCoeff = blockLevel > dynamicEnvelope[bandIndex] ? attackCoeff : releaseCoeff;
        dynamicEnvelope[bandIndex] = levelCoeff * dynamicEnvelope[bandIndex] + (1.0f - levelCoeff) * blockLevel;

        const float levelDB = juce::Decibels::gainToDecibels(dynamicEnvelope[bandIndex], -100.0f);
        const float thresholdDB = juce::jlimit(-80.0f, 0.0f, bands[b].dynamicThreshold.load(std::memory_order_relaxed));
        const float activity = juce::jlimit(0.0f, 1.0f, (levelDB - thresholdDB) / 18.0f);
        const float targetDynamicDB = rangeDB * activity;
        const float currentDynamicDB = dynamicGainDB[bandIndex].load(std::memory_order_relaxed);
        const float gainCoeff = std::abs(targetDynamicDB) > std::abs(currentDynamicDB) ? attackCoeff : releaseCoeff;
        const float nextDynamicDB = gainCoeff * currentDynamicDB + (1.0f - gainCoeff) * targetDynamicDB;
        dynamicGainDB[bandIndex].store(juce::jlimit(-24.0f, 24.0f, nextDynamicDB), std::memory_order_relaxed);
    }
}

bool S13EQ::advanceStageCoefficients(int bandIndex,
                                     int stageIndex) noexcept
{
    auto& coefficientVector =
        bandFilters[bandIndex][stageIndex].state->coefficients;
    const auto& target =
        targetBandCoefficients[static_cast<size_t>(bandIndex)]
                              [static_cast<size_t>(stageIndex)];
    jassert(coefficientVector.size()
            == static_cast<int>(target.size()));
    if (coefficientVector.size()
        != static_cast<int>(target.size()))
        return false;

    constexpr float settleThreshold = 1.0e-6f;
    bool stillSmoothing = false;
    for (size_t coefficient = 0;
         coefficient < target.size();
         ++coefficient)
    {
        const int coefficientIndex =
            static_cast<int>(coefficient);
        const float current =
            coefficientVector[coefficientIndex];
        const float difference =
            target[coefficient] - current;
        if (std::abs(difference) <= settleThreshold)
        {
            coefficientVector.set(
                coefficientIndex,
                target[coefficient]);
            continue;
        }

        const float next = current
            + difference * coefficientMorphProportion;
        coefficientVector.set(
            coefficientIndex,
            std::abs(target[coefficient] - next)
                    <= settleThreshold
                ? target[coefficient]
                : next);
        stillSmoothing = stillSmoothing
            || std::abs(target[coefficient] - next)
                > settleThreshold;
    }
    return stillSmoothing;
}

void S13EQ::resetWetPathState() noexcept
{
    for (int band = 0; band < numBands; ++band)
    {
        for (int stage = 0;
             stage < maxStagesPerBand;
             ++stage)
        {
            bandFilters[band][stage].reset();
        }
        for (int channel = 0; channel < 2; ++channel)
            dynamicDetectorFilters[band][channel].reset();
        dynamicEnvelope[static_cast<size_t>(band)] = 0.0f;
        dynamicGainDB[static_cast<size_t>(band)].store(
            0.0f, std::memory_order_relaxed);
        cachedBandStates[static_cast<size_t>(band)].valid = false;
    }
}

void S13EQ::advanceAutoGainEstimateProbe() noexcept
{
    static constexpr int probeCount = 16;
    static constexpr std::array<double, probeCount> probeFrequencies {
        31.5, 45.0, 63.0, 90.0, 125.0, 180.0, 250.0, 355.0,
        500.0, 710.0, 1000.0, 1400.0, 2000.0, 4000.0, 8000.0, 16000.0
    };

    const int probeIndex =
        juce::jlimit(
            0,
            probeCount - 1,
            autoGainProbeIndex);
    const double probeFrequency =
        probeFrequencies[static_cast<size_t>(probeIndex)];
    float responseDB = 0.0f;
    const int auditionIndex = juce::jlimit(-1, numBands - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);
    for (int b = 0; b < numBands; ++b)
    {
        if (auditionIndex >= 0 && b != auditionIndex)
            continue;
        if (auditionIndex < 0 && bands[b].enabled.load(std::memory_order_relaxed) < 0.5f)
            continue;

        for (int stage = 0; stage < activeStages[b]; ++stage)
        {
            const auto& coefficientVector =
                bandFilters[b][stage].state->coefficients;
            if (coefficientVector.size()
                != static_cast<int>(S13IIRCoefficientSet {}.size()))
                continue;

            S13IIRCoefficientSet currentCoefficients {};
            for (size_t coefficient = 0;
                 coefficient < currentCoefficients.size();
                 ++coefficient)
            {
                currentCoefficients[coefficient] =
                    coefficientVector[
                        static_cast<int>(coefficient)];
            }
            const float magnitude = static_cast<float>(
                getFixedBiquadMagnitude(
                    currentCoefficients,
                    probeFrequency,
                    cachedSampleRate));
            responseDB +=
                juce::Decibels::gainToDecibels(
                    magnitude, -48.0f);
        }
    }

    const float frequency =
        static_cast<float>(probeFrequency);
    const float presenceWeight =
        frequency >= 125.0f && frequency <= 8000.0f
            ? 1.0f
            : 0.45f;
    autoGainProbeWeightedSum +=
        responseDB * presenceWeight;
    autoGainProbeWeightTotal += presenceWeight;
    ++autoGainProbeIndex;

    if (autoGainProbeIndex >= probeCount)
    {
        cachedAutoGainTargetDB =
            autoGainProbeWeightTotal > 0.0f
                ? juce::jlimit(
                      -9.0f,
                      9.0f,
                      -autoGainProbeWeightedSum
                          / autoGainProbeWeightTotal)
                : 0.0f;
        autoGainProbeWeightedSum = 0.0f;
        autoGainProbeWeightTotal = 0.0f;
        autoGainProbeIndex = 0;
    }
}

void S13EQ::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    const bool spectrumRequested =
        isSpectrumCaptureRequested(numSamples);
    const float requestedPower =
        powerEnabled.load(std::memory_order_acquire)
            ? 1.0f
            : 0.0f;
    smoothedPowerMix.setTargetValue(requestedPower);

    const int requestedMode = juce::jlimit(
        0, 2,
        static_cast<int>(std::round(
            stereoMode.load(std::memory_order_relaxed))));
    const bool powerIsFullyDry =
        requestedPower <= 0.0f
        && !smoothedPowerMix.isSmoothing()
        && smoothedPowerMix.getCurrentValue() <= 1.0e-6f;
    if (requestedMode != pendingProcessingMode)
    {
        pendingProcessingMode = requestedMode;
        if (powerIsFullyDry)
        {
            activeProcessingMode = requestedMode;
            modeTransitionPending = false;
            smoothedModeMix.setCurrentAndTargetValue(1.0f);
            if (wetPathHasState)
            {
                resetWetPathState();
                wetPathHasState = false;
            }
        }
        else
        {
            modeTransitionPending = true;
            smoothedModeMix.setTargetValue(0.0f);
        }
    }

    const bool scratchIsReady =
        dryScratch.getNumChannels() >= numChannels
        && dryScratch.getNumSamples() >= numSamples;
    jassert(scratchIsReady);
    if (!scratchIsReady)
    {
        // prepareToPlay() must size this buffer. Returning the unchanged dry
        // signal is safer than allocating or making a hard transition here.
        return;
    }

    if (powerIsFullyDry)
    {
        if (spectrumRequested)
            captureSpectrumBlock(buffer, buffer);
        return;
    }

    const bool needsDryCopy =
        spectrumRequested
        || smoothedPowerMix.isSmoothing()
        || smoothedPowerMix.getCurrentValue() < 1.0f - 1.0e-6f
        || smoothedModeMix.isSmoothing()
        || smoothedModeMix.getCurrentValue() < 1.0f - 1.0e-6f;
    if (needsDryCopy)
    {
        for (int channel = 0; channel < numChannels; ++channel)
        {
            dryScratch.copyFrom(
                channel, 0,
                buffer, channel, 0,
                numSamples);
        }
    }

    const bool useMidSideMode = activeProcessingMode > 0
                             && numChannels >= 2
                             && msScratch.getNumSamples() >= numSamples;

    if (useMidSideMode)
    {
        auto* left = buffer.getWritePointer(0);
        auto* right = buffer.getWritePointer(1);
        auto* scratch = msScratch.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            const float mid = (left[i] + right[i]) * 0.5f;
            const float side = (left[i] - right[i]) * 0.5f;
            if (activeProcessingMode == 1)
            {
                left[i] = mid;
                scratch[i] = side;
            }
            else
            {
                left[i] = side;
                scratch[i] = mid;
            }
        }
    }

    wetPathHasState = true;
    // Dynamic bands must listen to the same signal that their filters process.
    // In Mid/Side mode channel 0 now contains the selected component, while
    // channel 1 still contains the original right channel until reconstruction;
    // detecting both would let Mid energy trigger a Side band (and vice versa).
    updateDynamicBands(buffer, useMidSideMode ? 1 : numChannels);
    updateFilters();

    // Process each enabled band
    juce::dsp::AudioBlock<float> block(buffer);
    auto processingBlock = useMidSideMode ? block.getSingleChannelBlock(0) : block;
    std::array<std::array<bool, maxStagesPerBand>, numBands>
        stageStillSmoothing {};
    bool anyStageStillSmoothing = false;
    for (int b = 0; b < numBands; ++b)
    {
        for (int s = 0; s < activeStages[b]; ++s)
        {
            bool thisStageStillSmoothing = false;
            for (int offset = 0;
                 offset < numSamples;
                 offset += coefficientMorphChunkSize)
            {
                const int chunkSize = juce::jmin(
                    coefficientMorphChunkSize,
                    numSamples - offset);
                if (filtersNeedSmoothing)
                {
                    thisStageStillSmoothing =
                        advanceStageCoefficients(b, s)
                        || thisStageStillSmoothing;
                }

                auto chunk = processingBlock.getSubBlock(
                    static_cast<size_t>(offset),
                    static_cast<size_t>(chunkSize));
                juce::dsp::ProcessContextReplacing<float>
                    context(chunk);
                bandFilters[b][s].process(context);
            }
            stageStillSmoothing[static_cast<size_t>(b)]
                               [static_cast<size_t>(s)] =
                thisStageStillSmoothing;
            anyStageStillSmoothing =
                anyStageStillSmoothing
                || thisStageStillSmoothing;
        }
    }

    if (filtersNeedSmoothing)
    {
        filtersNeedSmoothing = anyStageStillSmoothing;
        for (int b = 0; b < numBands; ++b)
        {
            while (activeStages[b] > targetStages[b])
            {
                const int trailingStage =
                    activeStages[b] - 1;
                if (stageStillSmoothing[
                        static_cast<size_t>(b)]
                        [static_cast<size_t>(trailingStage)])
                    break;
                bandFilters[b][trailingStage].reset();
                --activeStages[b];
            }
        }
    }

    // Output gain
    float outGainDB = juce::jlimit(
        -12.0f, 12.0f,
        outputGain.load(std::memory_order_relaxed));
    if (autoGain.load(std::memory_order_relaxed) >= 0.5f)
    {
        // Magnitude probing is control-rate analysis, not audio-rate DSP. At a
        // 16-sample callback the old implementation could run the complete
        // multi-band/multi-frequency estimate roughly 3,000 times per second.
        // Advance at most one frequency probe in a callback, distributing a
        // 50 Hz estimate over 16 bounded slices instead of creating a periodic
        // CPU burst that can consume a tiny ASIO deadline.
        autoGainProbeSamplesUntilAdvance -= numSamples;
        if (autoGainProbeSamplesUntilAdvance <= 0)
        {
            advanceAutoGainEstimateProbe();
            autoGainProbeSamplesUntilAdvance =
                juce::jmax(
                    1,
                    juce::roundToInt(
                        juce::jmax(1.0, cachedSampleRate)
                        / (50.0 * 16.0)));
        }
        const float autoGainSmoothingAmount =
            juce::jlimit(
                0.0f,
                1.0f,
                static_cast<float>(numSamples)
                    / static_cast<float>(
                        juce::jmax(
                            1.0,
                            cachedSampleRate * 0.080)));
        smoothedAutoGainDB +=
            (cachedAutoGainTargetDB - smoothedAutoGainDB)
            * autoGainSmoothingAmount;
        outGainDB += smoothedAutoGainDB;
    }
    else
    {
        cachedAutoGainTargetDB = 0.0f;
        autoGainProbeWeightedSum = 0.0f;
        autoGainProbeWeightTotal = 0.0f;
        autoGainProbeIndex = 0;
        autoGainProbeSamplesUntilAdvance = 0;
        const float autoGainReleaseAmount =
            juce::jlimit(
                0.0f,
                1.0f,
                static_cast<float>(numSamples)
                    / static_cast<float>(
                        juce::jmax(
                            1.0,
                            cachedSampleRate * 0.080)));
        smoothedAutoGainDB +=
            (0.0f - smoothedAutoGainDB)
            * autoGainReleaseAmount;
        outGainDB += smoothedAutoGainDB;
    }
    outGainDB = juce::jlimit(-18.0f, 18.0f, outGainDB);
    smoothedOutputGain.setTargetValue(
        juce::Decibels::decibelsToGain(outGainDB));
    if (smoothedOutputGain.isSmoothing()
        || std::abs(
            smoothedOutputGain.getCurrentValue() - 1.0f)
            > 1.0e-6f)
    {
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float gain =
                smoothedOutputGain.getNextValue();
            const int channelsToApply =
                useMidSideMode ? 1 : numChannels;
            for (int channel = 0;
                 channel < channelsToApply;
                 ++channel)
            {
                buffer.getWritePointer(channel)[sample] *= gain;
            }
        }
    }

    if (useMidSideMode)
    {
        auto* left = buffer.getWritePointer(0);
        auto* right = buffer.getWritePointer(1);
        auto* scratch = msScratch.getWritePointer(0);
        for (int i = 0; i < numSamples; ++i)
        {
            const float target = left[i];
            const float stored = scratch[i];
            const float mid =
                activeProcessingMode == 1
                    ? target
                    : stored;
            const float side =
                activeProcessingMode == 1
                    ? stored
                    : target;
            left[i] = mid + side;
            right[i] = mid - side;
        }
    }
    sanitizeBuiltInBuffer(buffer, 2.5f);

    if (needsDryCopy)
    {
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float wetMix =
                smoothedPowerMix.getNextValue()
                * smoothedModeMix.getNextValue();
            const float dryMix = 1.0f - wetMix;
            for (int channel = 0;
                 channel < numChannels;
                 ++channel)
            {
                auto* wet =
                    buffer.getWritePointer(channel);
                const auto* dry =
                    dryScratch.getReadPointer(channel);
                wet[sample] =
                    dry[sample] * dryMix
                    + wet[sample] * wetMix;
            }
        }
    }

    if (spectrumRequested)
        captureSpectrumBlock(dryScratch, buffer);

    const bool powerReachedDry =
        requestedPower <= 0.0f
        && !smoothedPowerMix.isSmoothing()
        && smoothedPowerMix.getCurrentValue() <= 1.0e-6f;
    if (powerReachedDry)
    {
        if (modeTransitionPending)
        {
            activeProcessingMode = pendingProcessingMode;
            modeTransitionPending = false;
            smoothedModeMix.setCurrentAndTargetValue(1.0f);
        }
        if (wetPathHasState)
        {
            resetWetPathState();
            wetPathHasState = false;
        }
    }
    else if (modeTransitionPending
             && !smoothedModeMix.isSmoothing()
             && smoothedModeMix.getCurrentValue() <= 1.0e-6f)
    {
        resetWetPathState();
        activeProcessingMode = pendingProcessingMode;
        modeTransitionPending = false;
        smoothedModeMix.setTargetValue(1.0f);
    }
}

bool S13EQ::isSpectrumCaptureRequested(
    int numSamples) noexcept
{
    int remaining =
        spectrumDemandSamplesRemaining.load(
            std::memory_order_acquire);
    while (remaining > 0)
    {
        const int next = juce::jmax(
            0, remaining - numSamples);
        if (spectrumDemandSamplesRemaining
                .compare_exchange_weak(
                    remaining, next,
                    std::memory_order_acq_rel,
                    std::memory_order_acquire))
            return true;
    }

    if (spectrumCaptureSlot >= 0)
    {
        spectrumCaptureSlots[
            static_cast<size_t>(spectrumCaptureSlot)]
            .state.store(0, std::memory_order_release);
        spectrumCaptureSlot = -1;
        spectrumCaptureWritePos = 0;
    }
    return false;
}

int S13EQ::claimSpectrumCaptureSlot() noexcept
{
    for (const int claimableState : { 0, 2 })
    {
        for (size_t slotIndex = 0;
             slotIndex < spectrumCaptureSlots.size();
             ++slotIndex)
        {
            int expected = claimableState;
            if (spectrumCaptureSlots[slotIndex].state
                    .compare_exchange_strong(
                        expected, 1,
                        std::memory_order_acq_rel,
                        std::memory_order_acquire))
            {
                return static_cast<int>(slotIndex);
            }
        }
    }
    return -1;
}

void S13EQ::captureSpectrumBlock(
    const juce::AudioBuffer<float>& preEQ,
    const juce::AudioBuffer<float>& postEQ) noexcept
{
    const int numSamples = juce::jmin(
        preEQ.getNumSamples(),
        postEQ.getNumSamples());
    if (numSamples <= 0
        || preEQ.getNumChannels() <= 0
        || postEQ.getNumChannels() <= 0)
        return;

    const auto* preSamples = preEQ.getReadPointer(0);
    const auto* postSamples = postEQ.getReadPointer(0);
    int sourceOffset = 0;
    while (sourceOffset < numSamples)
    {
        if (spectrumCaptureSlot < 0)
        {
            spectrumCaptureSlot =
                claimSpectrumCaptureSlot();
            spectrumCaptureWritePos = 0;
            if (spectrumCaptureSlot < 0)
                return;
        }

        auto& slot = spectrumCaptureSlots[
            static_cast<size_t>(spectrumCaptureSlot)];
        const int copyCount = juce::jmin(
            numSamples - sourceOffset,
            fftSize - spectrumCaptureWritePos);
        juce::FloatVectorOperations::copy(
            slot.preEQ.data()
                + spectrumCaptureWritePos,
            preSamples + sourceOffset,
            copyCount);
        juce::FloatVectorOperations::copy(
            slot.postEQ.data()
                + spectrumCaptureWritePos,
            postSamples + sourceOffset,
            copyCount);
        sourceOffset += copyCount;
        spectrumCaptureWritePos += copyCount;

        if (spectrumCaptureWritePos >= fftSize)
        {
            slot.generation.store(
                ++spectrumCaptureGeneration,
                std::memory_order_relaxed);
            slot.state.store(
                2, std::memory_order_release);
            spectrumCaptureSlot = -1;
            spectrumCaptureWritePos = 0;
        }
    }
}

void S13EQ::computeSpectrum(const std::array<float, fftSize>& input, std::array<float, fftSize / 2>& output)
{
    std::array<float, fftSize * 2> fftData {};
    for (int i = 0; i < fftSize; ++i)
        fftData[static_cast<size_t>(i)] = input[static_cast<size_t>(i)];
    window.multiplyWithWindowingTable(fftData.data(), fftSize);
    fft.performFrequencyOnlyForwardTransform(fftData.data());
    for (int i = 0; i < fftSize / 2; ++i)
    {
        float mag = fftData[static_cast<size_t>(i)] / static_cast<float>(fftSize);
        output[static_cast<size_t>(i)] = juce::Decibels::gainToDecibels(mag, -100.0f);
    }
}

S13EQ::SpectrumData S13EQ::getSpectrumData()
{
    const double sampleRate =
        publishedSampleRate.load(std::memory_order_acquire);
    const int demandSamples = juce::jlimit(
        1,
        std::numeric_limits<int>::max(),
        static_cast<int>(std::round(
            juce::jmax(44100.0, sampleRate) * 1.0)));
    spectrumDemandSamplesRemaining.store(
        demandSamples, std::memory_order_release);

    const std::lock_guard<std::mutex> consumerLock(
        spectrumConsumerMutex);
    int newestSlot = -1;
    juce::uint64 newestGeneration = 0;
    for (size_t slotIndex = 0;
         slotIndex < spectrumCaptureSlots.size();
         ++slotIndex)
    {
        const auto& slot =
            spectrumCaptureSlots[slotIndex];
        if (slot.state.load(std::memory_order_acquire)
            != 2)
            continue;
        const auto generation =
            slot.generation.load(std::memory_order_relaxed);
        if (newestSlot < 0
            || generation > newestGeneration)
        {
            newestSlot = static_cast<int>(slotIndex);
            newestGeneration = generation;
        }
    }

    if (newestSlot >= 0)
    {
        auto& slot = spectrumCaptureSlots[
            static_cast<size_t>(newestSlot)];
        int expected = 2;
        if (slot.state.compare_exchange_strong(
                expected, 3,
                std::memory_order_acq_rel,
                std::memory_order_acquire))
        {
            SpectrumData newOutput;
            computeSpectrum(slot.preEQ, newOutput.preEQ);
            computeSpectrum(slot.postEQ, newOutput.postEQ);
            newOutput.ready = true;
            slot.state.store(0, std::memory_order_release);
            lastSpectrumOutput = newOutput;
        }
    }
    return lastSpectrumOutput;
}

std::vector<float> S13EQ::getMagnitudeResponse(const std::vector<float>& frequencies) const
{
    std::vector<float> response(frequencies.size(), 0.0f);
    const int auditionIndex = juce::jlimit(-1, numBands - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);
    for (int b = 0; b < numBands; ++b)
    {
        if (auditionIndex >= 0 && b != auditionIndex) continue;
        if (auditionIndex < 0
            && bands[b].enabled.load(
                std::memory_order_relaxed) < 0.5f)
            continue;

        std::array<S13IIRCoefficientSet,
                   maxStagesPerBand> targets {};
        const int stages =
            buildBandTargets(b, true, targets);
        const double sampleRate =
            publishedSampleRate.load(
                std::memory_order_acquire);
        for (int s = 0; s < stages; ++s)
        {
            for (size_t i = 0; i < frequencies.size(); ++i)
            {
                response[i] +=
                    juce::Decibels::gainToDecibels(
                        static_cast<float>(
                            getFixedBiquadMagnitude(
                                targets[
                                    static_cast<size_t>(s)],
                                frequencies[i],
                                sampleRate)),
                        -100.0f);
            }
        }
    }
    const float outGainDB = juce::jlimit(
        -12.0f, 12.0f,
        outputGain.load(std::memory_order_relaxed));
    for (auto& r : response) r += outGainDB;
    return response;
}

float S13EQ::getBandDynamicGainDB(int bandIndex) const
{
    if (bandIndex < 0 || bandIndex >= numBands)
        return 0.0f;
    return dynamicGainDB[static_cast<size_t>(bandIndex)].load(std::memory_order_relaxed);
}

void S13EQ::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13EQ");
    state.setProperty("outputGain", outputGain.load(), nullptr);
    state.setProperty("autoGain", autoGain.load(), nullptr);
    state.setProperty("auditionBand", auditionBand.load(), nullptr);
    state.setProperty("stereoMode", stereoMode.load(), nullptr);
    for (int i = 0; i < numBands; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        state.setProperty(p + "enabled", bands[i].enabled.load(), nullptr);
        state.setProperty(p + "type", bands[i].type.load(), nullptr);
        state.setProperty(p + "freq", bands[i].freq.load(), nullptr);
        state.setProperty(p + "gain", bands[i].gain.load(), nullptr);
        state.setProperty(p + "q", bands[i].q.load(), nullptr);
        state.setProperty(p + "slope", bands[i].slope.load(), nullptr);
        state.setProperty(p + "dynamicEnabled", bands[i].dynamicEnabled.load(), nullptr);
        state.setProperty(p + "dynamicThreshold", bands[i].dynamicThreshold.load(), nullptr);
        state.setProperty(p + "dynamicRange", bands[i].dynamicRange.load(), nullptr);
        state.setProperty(p + "dynamicAttack", bands[i].dynamicAttack.load(), nullptr);
        state.setProperty(p + "dynamicRelease", bands[i].dynamicRelease.load(), nullptr);
    }
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13EQ::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13EQ") return;

    outputGain.store(static_cast<float>(state.getProperty("outputGain", 0.0f)));
    autoGain.store(static_cast<float>(state.getProperty("autoGain", 0.0f)));
    auditionBand.store(static_cast<float>(state.getProperty("auditionBand", 0.0f)));
    stereoMode.store(static_cast<float>(state.getProperty("stereoMode", 0.0f)));
    for (int i = 0; i < numBands; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        bands[i].enabled.store(static_cast<float>(state.getProperty(p + "enabled", 1.0f)));
        bands[i].type.store(static_cast<float>(state.getProperty(p + "type", 0.0f)));
        bands[i].freq.store(static_cast<float>(state.getProperty(p + "freq", 1000.0f)));
        bands[i].gain.store(static_cast<float>(state.getProperty(p + "gain", 0.0f)));
        bands[i].q.store(static_cast<float>(state.getProperty(p + "q", 1.0f)));
        bands[i].slope.store(static_cast<float>(state.getProperty(p + "slope", 1.0f)));
        bands[i].dynamicEnabled.store(static_cast<float>(state.getProperty(p + "dynamicEnabled", 0.0f)));
        bands[i].dynamicThreshold.store(static_cast<float>(state.getProperty(p + "dynamicThreshold", -24.0f)));
        bands[i].dynamicRange.store(static_cast<float>(state.getProperty(p + "dynamicRange", 0.0f)));
        bands[i].dynamicAttack.store(static_cast<float>(state.getProperty(p + "dynamicAttack", 10.0f)));
        bands[i].dynamicRelease.store(static_cast<float>(state.getProperty(p + "dynamicRelease", 150.0f)));
    }
    // Parameter atomics are consumed and coefficient targets are rebuilt by
    // processBlock(). Do not mutate callback-owned caches/filter state here.
}

//==============================================================================
//  S13Compressor -- Multi-style compressor
//==============================================================================

S13Compressor::S13Compressor() {}

float S13Compressor::computeGain(float inputDB,
                                 float thresholdDB,
                                 float compressionSlope,
                                 float kneeDB) noexcept
{
    if (kneeDB > 0.0001f)
    {
        const float halfKnee = kneeDB * 0.5f;
        if (inputDB < thresholdDB - halfKnee)
            return inputDB;
        if (inputDB > thresholdDB + halfKnee)
            return inputDB
                - compressionSlope * (inputDB - thresholdDB);

        const float x = inputDB - thresholdDB + halfKnee;
        return inputDB
            - compressionSlope * x * x / (2.0f * kneeDB);
    }

    if (inputDB <= thresholdDB)
        return inputDB;
    return inputDB
        - compressionSlope * (inputDB - thresholdDB);
}

static float compressorSlopeFromRatio(float ratio) noexcept
{
    const float clampedRatio =
        juce::jlimit(1.0f, 20.0f, ratio);
    return 1.0f - 1.0f / clampedRatio;
}

static void initialiseCompressorSmoother(
    juce::SmoothedValue<
        float,
        juce::ValueSmoothingTypes::Linear>& smoother,
    double sampleRate,
    float value) noexcept
{
    constexpr double smoothingSeconds = 0.020;
    smoother.reset(sampleRate, smoothingSeconds);
    smoother.setCurrentAndTargetValue(value);
}

static void resetCompressorSmoother(
    juce::SmoothedValue<
        float,
        juce::ValueSmoothingTypes::Linear>& smoother,
    float value) noexcept
{
    smoother.setCurrentAndTargetValue(value);
}

static float sanitiseCompressorSidechainHPF(float frequency) noexcept
{
    if (! std::isfinite(frequency))
        return 20.0f;

    return frequency;
}

void S13Compressor::getStyleBallistics(float& atkMs, float& relMs) const
{
    const auto styleVal = static_cast<Style>(static_cast<int>(style.load()));
    float baseAtk = juce::jlimit(0.1f, 100.0f, attack.load());
    float baseRel = juce::jlimit(10.0f, 2000.0f, release.load());

    switch (styleVal)
    {
        case Style::Clean:  atkMs = baseAtk; relMs = baseRel; break;
        case Style::Punch:  atkMs = juce::jmax(baseAtk, 5.0f) * 1.5f; relMs = baseRel * 0.7f; break;
        case Style::Opto:   atkMs = juce::jmax(baseAtk, 10.0f) * 2.0f; relMs = juce::jmax(baseRel, 200.0f) * 2.0f; break;
        case Style::FET:    atkMs = juce::jmin(baseAtk, 1.0f); relMs = juce::jlimit(50.0f, 500.0f, baseRel); break;
        case Style::VCA:    atkMs = baseAtk; relMs = juce::jlimit(30.0f, 300.0f, baseRel); break;
    }
}

void S13Compressor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    envelopeLevel = 0.0f;
    rmsEnvelopeLevel = 0.0f;
    currentGainLin = 1.0f;

    initialiseCompressorSmoother(
        smoothedMakeup,
        sampleRate,
        juce::Decibels::decibelsToGain(
            makeupGain.load(std::memory_order_relaxed)));
    initialiseCompressorSmoother(
        smoothedMix,
        sampleRate,
        juce::jlimit(
            0.0f, 1.0f,
            mix.load(std::memory_order_relaxed)));
    initialiseCompressorSmoother(
        smoothedThresholdDb,
        sampleRate,
        juce::jlimit(
            -60.0f, 0.0f,
            threshold.load(std::memory_order_relaxed)));
    initialiseCompressorSmoother(
        smoothedCompressionSlope,
        sampleRate,
        compressorSlopeFromRatio(
            ratio.load(std::memory_order_relaxed)));
    initialiseCompressorSmoother(
        smoothedKneeDb,
        sampleRate,
        juce::jlimit(
            0.0f, 24.0f,
            knee.load(std::memory_order_relaxed)));

    const float requestedSCHPF =
        sanitiseCompressorSidechainHPF(
            sidechainHPF.load(std::memory_order_relaxed));
    const bool sidechainHPFEnabled = requestedSCHPF > 0.0f;
    lastSCHPFFreq = juce::jlimit(20.0f, 500.0f, requestedSCHPF);
    auto hpfCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, lastSCHPFFreq);
    scHPF_L.coefficients = hpfCoeffs;
    scHPF_R.coefficients = hpfCoeffs;
    prepareRealtimeFilterLut(scHPFCoefficientLut, sampleRate, 20.0f, 500.0f, true);
    targetSCHPFCoefficients =
        lookupRealtimeFilterLut(
            scHPFCoefficientLut,
            sampleRate,
            lastSCHPFFreq,
            20.0f,
            500.0f);
    writeRealtimeFilterCoefficients(
        scHPF_L,
        scHPF_R,
        targetSCHPFCoefficients);
    scHPFCoefficientSmoothingProportion =
        1.0f
        - std::exp(
            -1.0f
            / static_cast<float>(
                juce::jmax(1.0, sampleRate * 0.020)));
    scHPFCoefficientsSmoothing = false;
    scHPF_L.reset();
    scHPF_R.reset();
    smoothedSidechainHPFWet.reset(sampleRate, 0.005);
    smoothedSidechainHPFWet.setCurrentAndTargetValue(
        sidechainHPFEnabled ? 1.0f : 0.0f);

    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 1 };
    lookaheadDelayL.prepare(spec);
    lookaheadDelayR.prepare(spec);
    lookaheadDelayL.reset();
    lookaheadDelayR.reset();
    smoothedLookaheadMorph.reset(sampleRate, 0.020);
    smoothedLookaheadMorph.setCurrentAndTargetValue(0.0f);
    activeLookaheadSamples =
        juce::jlimit(
            0.0f,
            static_cast<float>(
                lookaheadDelayL.getMaximumDelayInSamples()),
            juce::jlimit(
                0.0f,
                20.0f,
                lookaheadMs.load(std::memory_order_relaxed))
                * 0.001f
                * static_cast<float>(sampleRate));
    targetLookaheadSamples = activeLookaheadSamples;
    pendingLookaheadSamples = activeLookaheadSamples;
    lookaheadMorphActive = false;

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
}

void S13Compressor::releaseResources()
{
    reset();
}

void S13Compressor::reset()
{
    envelopeLevel = 0.0f;
    rmsEnvelopeLevel = 0.0f;
    currentGainLin = 1.0f;
    resetCompressorSmoother(
        smoothedMakeup,
        juce::Decibels::decibelsToGain(
            makeupGain.load(std::memory_order_relaxed)));
    resetCompressorSmoother(
        smoothedMix,
        juce::jlimit(
            0.0f, 1.0f,
            mix.load(std::memory_order_relaxed)));
    resetCompressorSmoother(
        smoothedThresholdDb,
        juce::jlimit(
            -60.0f, 0.0f,
            threshold.load(std::memory_order_relaxed)));
    resetCompressorSmoother(
        smoothedCompressionSlope,
        compressorSlopeFromRatio(
            ratio.load(std::memory_order_relaxed)));
    resetCompressorSmoother(
        smoothedKneeDb,
        juce::jlimit(
            0.0f, 24.0f,
            knee.load(std::memory_order_relaxed)));
    const float requestedSCHPF =
        sanitiseCompressorSidechainHPF(
            sidechainHPF.load(std::memory_order_relaxed));
    const bool sidechainHPFEnabled = requestedSCHPF > 0.0f;
    lastSCHPFFreq = juce::jlimit(
        20.0f, 500.0f,
        requestedSCHPF);
    if (! scHPFCoefficientLut.empty())
    {
        targetSCHPFCoefficients =
            lookupRealtimeFilterLut(
                scHPFCoefficientLut,
                cachedSampleRate,
                lastSCHPFFreq,
                20.0f,
                500.0f);
        writeRealtimeFilterCoefficients(
            scHPF_L,
            scHPF_R,
            targetSCHPFCoefficients);
    }
    scHPFCoefficientsSmoothing = false;
    scHPF_L.reset();
    scHPF_R.reset();
    smoothedSidechainHPFWet.setCurrentAndTargetValue(
        sidechainHPFEnabled ? 1.0f : 0.0f);
    lookaheadDelayL.reset();
    lookaheadDelayR.reset();
    activeLookaheadSamples =
        juce::jlimit(
            0.0f,
            static_cast<float>(
                lookaheadDelayL.getMaximumDelayInSamples()),
            juce::jlimit(
                0.0f,
                20.0f,
                lookaheadMs.load(std::memory_order_relaxed))
                * 0.001f
                * static_cast<float>(
                    juce::jmax(1.0, cachedSampleRate)));
    targetLookaheadSamples = activeLookaheadSamples;
    pendingLookaheadSamples = activeLookaheadSamples;
    lookaheadMorphActive = false;
    smoothedLookaheadMorph.setCurrentAndTargetValue(0.0f);
    if (oversampler)
        oversampler->reset();
    gainReductionDB.store(0.0f, std::memory_order_relaxed);
    inputLevelDB.store(-100.0f, std::memory_order_relaxed);
    outputLevelDB.store(-100.0f, std::memory_order_relaxed);
}

void S13Compressor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 1 || numSamples == 0) return;

    // Keep the filter warm even while bypassed, then dezipper detector-path
    // changes by crossfading between the dry and high-passed signals.
    const float requestedSCHPF =
        sanitiseCompressorSidechainHPF(
            sidechainHPF.load(std::memory_order_relaxed));
    const bool sidechainHPFEnabled = requestedSCHPF > 0.0f;
    const float scFreq = juce::jlimit(20.0f, 500.0f, requestedSCHPF);
    if (sidechainHPFEnabled
        && std::abs(scFreq - lastSCHPFFreq) > 1.0f)
    {
        lastSCHPFFreq = scFreq;
        if (! scHPFCoefficientLut.empty())
        {
            targetSCHPFCoefficients =
                lookupRealtimeFilterLut(
                    scHPFCoefficientLut,
                    cachedSampleRate,
                    scFreq,
                    20.0f,
                    500.0f);
            scHPFCoefficientsSmoothing = true;
        }
    }
    smoothedSidechainHPFWet.setTargetValue(
        sidechainHPFEnabled ? 1.0f : 0.0f);

    float atkMs, relMs;
    getStyleBallistics(atkMs, relMs);
    const float srf = static_cast<float>(cachedSampleRate);
    const float attackCoeff = std::exp(-1.0f / (atkMs * 0.001f * srf));
    const float releaseScale = autoRelease.load(std::memory_order_relaxed) >= 0.5f
        ? juce::jlimit(0.65f, 3.5f, 1.0f + std::abs(gainReductionDB.load(std::memory_order_relaxed)) / 12.0f)
        : 1.0f;
    const float releaseCoeff = std::exp(-1.0f / (relMs * releaseScale * 0.001f * srf));
    const float rmsCoeff = std::exp(-1.0f / (0.025f * srf));
    const int detector = juce::jlimit(0, 2, static_cast<int>(std::round(detectorMode.load(std::memory_order_relaxed))));
    const float link = juce::jlimit(0.0f, 1.0f, stereoLink.load(std::memory_order_relaxed));

    smoothedMix.setTargetValue(
        juce::jlimit(
            0.0f, 1.0f,
            mix.load(std::memory_order_relaxed)));
    smoothedThresholdDb.setTargetValue(
        juce::jlimit(
            -60.0f, 0.0f,
            threshold.load(std::memory_order_relaxed)));
    smoothedCompressionSlope.setTargetValue(
        compressorSlopeFromRatio(
            ratio.load(std::memory_order_relaxed)));
    smoothedKneeDb.setTargetValue(
        juce::jlimit(
            0.0f, 24.0f,
            knee.load(std::memory_order_relaxed)));

    pendingLookaheadSamples =
        juce::jlimit(
            0.0f,
            static_cast<float>(
                lookaheadDelayL.getMaximumDelayInSamples()),
            juce::jlimit(
                0.0f,
                20.0f,
                lookaheadMs.load(std::memory_order_relaxed))
                * 0.001f
                * srf);
    if (! lookaheadMorphActive
        && std::abs(
               pendingLookaheadSamples
               - activeLookaheadSamples)
            > 0.01f)
    {
        targetLookaheadSamples =
            pendingLookaheadSamples;
        smoothedLookaheadMorph
            .setCurrentAndTargetValue(0.0f);
        smoothedLookaheadMorph.setTargetValue(1.0f);
        lookaheadMorphActive = true;
    }

    float inputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        inputPeak = juce::jmax(inputPeak, buffer.getMagnitude(ch, 0, numSamples));
    inputLevelDB.store(juce::Decibels::gainToDecibels(inputPeak, -100.0f));

    float peakGR = 0.0f;
    auto* dataL = buffer.getWritePointer(0);
    auto* dataR = (numChannels >= 2) ? buffer.getWritePointer(1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        if (scHPFCoefficientsSmoothing)
        {
            scHPFCoefficientsSmoothing =
                advanceRealtimeFilterCoefficients(
                    scHPF_L,
                    scHPF_R,
                    targetSCHPFCoefficients,
                    scHPFCoefficientSmoothingProportion);
        }

        const float dryL = dataL[i];
        const float dryR = dataR ? dataR[i] : dryL;

        const float filteredSCL = scHPF_L.processSample(dryL);
        const float filteredSCR = dataR
            ? scHPF_R.processSample(dryR)
            : filteredSCL;
        const float sidechainHPFWet =
            smoothedSidechainHPFWet.getNextValue();
        const float scL =
            dryL + (filteredSCL - dryL) * sidechainHPFWet;
        const float scR = dataR
            ? dryR + (filteredSCR - dryR) * sidechainHPFWet
            : scL;
        const float linkedPeak = juce::jmax(std::abs(scL), std::abs(scR));
        const float averagePeak = (std::abs(scL) + std::abs(scR)) * 0.5f;
        const float peakLevel = averagePeak + (linkedPeak - averagePeak) * link;
        const float rmsInput = dataR ? (scL * scL + scR * scR) * 0.5f : scL * scL;
        rmsEnvelopeLevel = rmsCoeff * rmsEnvelopeLevel + (1.0f - rmsCoeff) * rmsInput;
        const float rmsLevel = std::sqrt(juce::jmax(0.0f, rmsEnvelopeLevel));
        const float scLevel = detector == 1
            ? rmsLevel
            : (detector == 2 ? juce::jmax(rmsLevel, peakLevel * 0.72f) : peakLevel);

        if (scLevel > envelopeLevel)
            envelopeLevel = attackCoeff * envelopeLevel + (1.0f - attackCoeff) * scLevel;
        else
            envelopeLevel = releaseCoeff * envelopeLevel + (1.0f - releaseCoeff) * scLevel;

        const float thresholdForSample =
            smoothedThresholdDb.getNextValue();
        const float compressionSlopeForSample =
            smoothedCompressionSlope.getNextValue();
        const float kneeForSample =
            smoothedKneeDb.getNextValue();
        float envDB = juce::Decibels::gainToDecibels(envelopeLevel, -100.0f);
        float targetDB = computeGain(
            envDB,
            thresholdForSample,
            compressionSlopeForSample,
            kneeForSample);
        float gr = targetDB - envDB;
        float gainLin = juce::Decibels::decibelsToGain(gr);
        peakGR = juce::jmin(peakGR, gr);

        // JUCE's DelayLine expects the current input to be pushed before it is
        // popped. Popping first makes a zero-sample delay wrap around the whole
        // ring buffer, which turned the NAM rack's parallel compressor into an
        // unintended ~46 ms echo at 44.1 kHz.
        lookaheadDelayL.pushSample(0, dryL);
        if (dataR) lookaheadDelayR.pushSample(0, dryR);
        const float activeDelayedL =
            lookaheadDelayL.popSample(
                0,
                activeLookaheadSamples,
                ! lookaheadMorphActive);
        float delayedL = activeDelayedL;
        float delayedR = 0.0f;
        if (lookaheadMorphActive)
        {
            const float morph =
                smoothedLookaheadMorph.getNextValue();
            const float targetDelayedL =
                lookaheadDelayL.popSample(
                    0,
                    targetLookaheadSamples,
                    true);
            delayedL =
                activeDelayedL
                + (targetDelayedL - activeDelayedL)
                    * morph;
            if (dataR)
            {
                const float activeDelayedR =
                    lookaheadDelayR.popSample(
                        0,
                        activeLookaheadSamples,
                        false);
                const float targetDelayedR =
                    lookaheadDelayR.popSample(
                        0,
                        targetLookaheadSamples,
                        true);
                delayedR =
                    activeDelayedR
                    + (targetDelayedR - activeDelayedR)
                        * morph;
            }
        }
        else if (dataR)
        {
            delayedR =
                lookaheadDelayR.popSample(
                    0,
                    activeLookaheadSamples,
                    true);
        }
        else
        {
            delayedR = delayedL;
        }

        const float mkLin = smoothedMakeup.getNextValue();
        const float mixWet = smoothedMix.getNextValue();
        const float mixDry = 1.0f - mixWet;
        const float wetL =
            boundProcessedWetSample(
                delayedL * gainLin * mkLin);
        const float wetR =
            boundProcessedWetSample(
                delayedR * gainLin * mkLin);

        dataL[i] = dryL * mixDry + wetL * mixWet;
        if (dataR) dataR[i] = dryR * mixDry + wetR * mixWet;
    }
    if (lookaheadMorphActive
        && ! smoothedLookaheadMorph.isSmoothing())
    {
        activeLookaheadSamples =
            targetLookaheadSamples;
        lookaheadMorphActive = false;
        smoothedLookaheadMorph
            .setCurrentAndTargetValue(0.0f);
    }

    const float targetMakeupDB = autoMakeup.load(std::memory_order_relaxed) >= 0.5f
        ? juce::jlimit(0.0f, 18.0f, std::abs(peakGR) * 0.5f)
        : juce::jlimit(0.0f, 36.0f, makeupGain.load(std::memory_order_relaxed));
    smoothedMakeup.setTargetValue(juce::Decibels::decibelsToGain(targetMakeupDB));
    gainReductionDB.store(peakGR);
    clearNonFiniteBuiltInBuffer(buffer);

    float outputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        outputPeak = juce::jmax(outputPeak, buffer.getMagnitude(ch, 0, numSamples));
    outputLevelDB.store(juce::Decibels::gainToDecibels(outputPeak, -100.0f));
}

void S13Compressor::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Compressor");
    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("ratio", ratio.load(), nullptr);
    state.setProperty("attack", attack.load(), nullptr);
    state.setProperty("release", release.load(), nullptr);
    state.setProperty("knee", knee.load(), nullptr);
    state.setProperty("makeupGain", makeupGain.load(), nullptr);
    state.setProperty("mix", mix.load(), nullptr);
    state.setProperty("style", style.load(), nullptr);
    state.setProperty("autoMakeup", autoMakeup.load(), nullptr);
    state.setProperty("autoRelease", autoRelease.load(), nullptr);
    state.setProperty("sidechainHPF", sidechainHPF.load(), nullptr);
    state.setProperty("lookahead", lookaheadMs.load(), nullptr);
    state.setProperty("detectorMode", detectorMode.load(), nullptr);
    state.setProperty("stereoLink", stereoLink.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Compressor::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Compressor") return;

    threshold.store(static_cast<float>(state.getProperty("threshold", 0.0f)));
    ratio.store(static_cast<float>(state.getProperty("ratio", 1.0f)));
    attack.store(static_cast<float>(state.getProperty("attack", 10.0f)));
    release.store(static_cast<float>(state.getProperty("release", 100.0f)));
    knee.store(static_cast<float>(state.getProperty("knee", 0.0f)));
    makeupGain.store(static_cast<float>(state.getProperty("makeupGain", 0.0f)));
    mix.store(static_cast<float>(state.getProperty("mix", 1.0f)));
    style.store(static_cast<float>(state.getProperty("style", 0.0f)));
    autoMakeup.store(static_cast<float>(state.getProperty("autoMakeup", 0.0f)));
    autoRelease.store(static_cast<float>(state.getProperty("autoRelease", 0.0f)));
    sidechainHPF.store(static_cast<float>(state.getProperty("sidechainHPF", 20.0f)));
    lookaheadMs.store(static_cast<float>(state.getProperty("lookahead", 0.0f)));
    detectorMode.store(static_cast<float>(state.getProperty("detectorMode", 0.0f)));
    stereoLink.store(static_cast<float>(state.getProperty("stereoLink", 1.0f)));
}

//==============================================================================
//  S13Gate -- Noise gate with hysteresis and sidechain filter
//==============================================================================

S13Gate::S13Gate() {}

void S13Gate::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    lastSidechainHPF = -1.0f;
    lastSidechainLPF = -1.0f;

    auto hpfCoeffs =
        juce::dsp::IIR::Coefficients<float>::makeHighPass(
            sampleRate,
            juce::jlimit(
                20.0f, 2000.0f,
                sidechainHPF.load(std::memory_order_relaxed)));
    scHPF_L.coefficients = hpfCoeffs;  scHPF_R.coefficients = hpfCoeffs;

    auto lpfCoeffs =
        juce::dsp::IIR::Coefficients<float>::makeLowPass(
            sampleRate,
            juce::jlimit(
                200.0f, 20000.0f,
                sidechainLPF.load(std::memory_order_relaxed)));
    scLPF_L.coefficients = lpfCoeffs;  scLPF_R.coefficients = lpfCoeffs;
    prepareRealtimeFilterLut(
        scHPFCoefficientLut,
        sampleRate,
        20.0f,
        2000.0f,
        true);
    prepareRealtimeFilterLut(
        scLPFCoefficientLut,
        sampleRate,
        200.0f,
        20000.0f,
        false);
    sidechainCoefficientSmoothingProportion =
        1.0f
        - std::exp(
            -1.0f
            / static_cast<float>(
                juce::jmax(1.0, sampleRate * 0.020)));
    smoothedMix.reset(sampleRate, 0.020);
    smoothedMix.setCurrentAndTargetValue(
        juce::jlimit(
            0.0f, 1.0f,
            mix.load(std::memory_order_relaxed)));

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 1, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
    reset();
}

void S13Gate::releaseResources()
{
    reset();
}

void S13Gate::reset()
{
    envelopeLevel = 0.0f;
    rmsEnvelopeLevel = 0.0f;
    holdCounter = 0;
    currentGain = 0.0f;
    gateOpen.store(false, std::memory_order_relaxed);
    updateCoefficients(true);
    scHPF_L.reset();
    scHPF_R.reset();
    scLPF_L.reset();
    scLPF_R.reset();
    smoothedMix.setCurrentAndTargetValue(
        juce::jlimit(
            0.0f, 1.0f,
            mix.load(std::memory_order_relaxed)));
    if (oversampler)
        oversampler->reset();
    gainReductionDB.store(0.0f, std::memory_order_relaxed);
}

void S13Gate::updateCoefficients(bool forceImmediate)
{
    const double sr = cachedSampleRate;
    if (sr <= 0.0) return;
    const float srf = static_cast<float>(sr);

    attackCoeff  = std::exp(-1.0f / (juce::jlimit(0.01f, 50.0f, attackMs.load()) * 0.001f * srf));
    releaseCoeff = std::exp(-1.0f / (juce::jlimit(5.0f, 2000.0f, releaseMs.load()) * 0.001f * srf));
    holdSamples  = static_cast<int>(juce::jlimit(0.0f, 500.0f, holdMs.load()) * 0.001f * srf);

    float threshDB = juce::jlimit(-80.0f, 0.0f, threshold.load());
    thresholdLinear = juce::Decibels::decibelsToGain(threshDB);
    closeThresholdLinear = juce::Decibels::decibelsToGain(threshDB - juce::jlimit(0.0f, 20.0f, hysteresis.load()));
    rangeGain = juce::Decibels::decibelsToGain(juce::jlimit(-80.0f, 0.0f, range.load()));

    float hpfFreq = juce::jlimit(20.0f, 2000.0f, sidechainHPF.load());
    if (forceImmediate
        || lastSidechainHPF < 0.0f
        || std::abs(hpfFreq - lastSidechainHPF) > 1.0f)
    {
        lastSidechainHPF = hpfFreq;
        if (! scHPFCoefficientLut.empty())
        {
            targetHPFCoefficients =
                lookupRealtimeFilterLut(
                    scHPFCoefficientLut,
                    sr,
                    hpfFreq,
                    20.0f,
                    2000.0f);
            if (forceImmediate)
            {
                writeRealtimeFilterCoefficients(
                    scHPF_L,
                    scHPF_R,
                    targetHPFCoefficients);
                hpfCoefficientsSmoothing = false;
            }
            else
            {
                hpfCoefficientsSmoothing = true;
            }
        }
    }

    float lpfFreq = juce::jlimit(200.0f, 20000.0f, sidechainLPF.load());
    if (forceImmediate
        || lastSidechainLPF < 0.0f
        || std::abs(lpfFreq - lastSidechainLPF) > 8.0f)
    {
        lastSidechainLPF = lpfFreq;
        if (! scLPFCoefficientLut.empty())
        {
            targetLPFCoefficients =
                lookupRealtimeFilterLut(
                    scLPFCoefficientLut,
                    sr,
                    lpfFreq,
                    200.0f,
                    20000.0f);
            if (forceImmediate)
            {
                writeRealtimeFilterCoefficients(
                    scLPF_L,
                    scLPF_R,
                    targetLPFCoefficients);
                lpfCoefficientsSmoothing = false;
            }
            else
            {
                lpfCoefficientsSmoothing = true;
            }
        }
    }
}

void S13Gate::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    updateCoefficients(false);

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;
    smoothedMix.setTargetValue(
        juce::jlimit(
            0.0f, 1.0f,
            mix.load(std::memory_order_relaxed)));

    const float envAttack  = 0.9995f;
    const float envRelease = 0.9999f;
    const float rmsCoeff = std::exp(-1.0f / (0.018f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const int detector = juce::jlimit(0, 2, static_cast<int>(std::round(detectorMode.load(std::memory_order_relaxed))));
    float peakGR = 0.0f;

    for (int i = 0; i < numSamples; ++i)
    {
        if (hpfCoefficientsSmoothing)
        {
            hpfCoefficientsSmoothing =
                advanceRealtimeFilterCoefficients(
                    scHPF_L,
                    scHPF_R,
                    targetHPFCoefficients,
                    sidechainCoefficientSmoothingProportion);
        }
        if (lpfCoefficientsSmoothing)
        {
            lpfCoefficientsSmoothing =
                advanceRealtimeFilterCoefficients(
                    scLPF_L,
                    scLPF_R,
                    targetLPFCoefficients,
                    sidechainCoefficientSmoothingProportion);
        }

        float peakLevel = 0.0f;
        float rmsSum = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float s = buffer.getSample(ch, i);
            s = (ch == 0) ? scLPF_L.processSample(scHPF_L.processSample(s))
                          : scLPF_R.processSample(scHPF_R.processSample(s));
            peakLevel = juce::jmax(peakLevel, std::abs(s));
            rmsSum += s * s;
        }
        rmsEnvelopeLevel = rmsCoeff * rmsEnvelopeLevel
                         + (1.0f - rmsCoeff) * (rmsSum / static_cast<float>(juce::jmax(1, numChannels)));
        const float rmsLevel = std::sqrt(juce::jmax(0.0f, rmsEnvelopeLevel));
        const float inputLevel = detector == 1
            ? rmsLevel
            : (detector == 2 ? juce::jmax(rmsLevel, peakLevel * 0.7f) : peakLevel);

        if (inputLevel > envelopeLevel)
            envelopeLevel = envAttack * envelopeLevel + (1.0f - envAttack) * inputLevel;
        else
            envelopeLevel = envRelease * envelopeLevel + (1.0f - envRelease) * inputLevel;

        float targetGain;
        if (gateOpen.load())
        {
            if (envelopeLevel >= closeThresholdLinear) { targetGain = 1.0f; holdCounter = holdSamples; }
            else if (holdCounter > 0) { targetGain = 1.0f; --holdCounter; }
            else { targetGain = rangeGain; gateOpen.store(false); }
        }
        else
        {
            if (envelopeLevel >= thresholdLinear) { targetGain = 1.0f; holdCounter = holdSamples; gateOpen.store(true); }
            else targetGain = rangeGain;
        }

        if (targetGain > currentGain)
            currentGain = attackCoeff * currentGain + (1.0f - attackCoeff) * targetGain;
        else
            currentGain = releaseCoeff * currentGain + (1.0f - releaseCoeff) * targetGain;

        peakGR = juce::jmin(peakGR, juce::Decibels::gainToDecibels(currentGain, -100.0f));

        const float mixWet = smoothedMix.getNextValue();
        const float mixDry = 1.0f - mixWet;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const float dry = buffer.getSample(ch, i);
            const float wet =
                boundProcessedWetSample(
                    dry * currentGain);
            buffer.setSample(
                ch,
                i,
                dry * mixDry + wet * mixWet);
        }
    }
    clearNonFiniteBuiltInBuffer(buffer);
    gainReductionDB.store(peakGR);
}

void S13Gate::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Gate");
    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("attack", attackMs.load(), nullptr);
    state.setProperty("hold", holdMs.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("range", range.load(), nullptr);
    state.setProperty("hysteresis", hysteresis.load(), nullptr);
    state.setProperty("sidechainHPF", sidechainHPF.load(), nullptr);
    state.setProperty("sidechainLPF", sidechainLPF.load(), nullptr);
    state.setProperty("mix", mix.load(), nullptr);
    state.setProperty("detectorMode", detectorMode.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Gate::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Gate") return;

    threshold.store(static_cast<float>(state.getProperty("threshold", -40.0f)));
    attackMs.store(static_cast<float>(state.getProperty("attack", 1.0f)));
    holdMs.store(static_cast<float>(state.getProperty("hold", 50.0f)));
    releaseMs.store(static_cast<float>(state.getProperty("release", 50.0f)));
    range.store(static_cast<float>(state.getProperty("range", -80.0f)));
    hysteresis.store(static_cast<float>(state.getProperty("hysteresis", 0.0f)));
    sidechainHPF.store(static_cast<float>(state.getProperty("sidechainHPF", 20.0f)));
    sidechainLPF.store(static_cast<float>(state.getProperty("sidechainLPF", 20000.0f)));
    mix.store(static_cast<float>(state.getProperty("mix", 1.0f)));
    detectorMode.store(static_cast<float>(state.getProperty("detectorMode", 0.0f)));
    // Runtime coefficients are owned by processBlock(). Publishing atomics
    // here avoids racing a live callback while a project state is restored.
}

//==============================================================================
//  S13Limiter -- Brickwall limiter with ceiling
//==============================================================================

S13Limiter::S13Limiter() {}

void S13Limiter::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2u };

    limiter.prepare(spec);
    limiter.setThreshold(threshold.load());
    limiter.setRelease(juce::jmax(10.0f, releaseMs.load()));

    smoothedThresholdGain.reset(sampleRate, 0.02);
    smoothedThresholdGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -20.0f, 0.0f,
                threshold.load(std::memory_order_relaxed))));
    smoothedCeiling.reset(sampleRate, 0.02);
    smoothedCeiling.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -3.0f, 0.0f,
                ceiling.load(std::memory_order_relaxed))));
    smoothedLookaheadMorph.reset(sampleRate, 0.02);
    smoothedLookaheadMorph.setCurrentAndTargetValue(0.0f);

    const int maxLookaheadSamples = static_cast<int>(std::ceil(sampleRate * 0.02)) + juce::jmax(samplesPerBlock, 1) + 8;
    lookaheadBuffer.setSize(2, juce::jmax(16, maxLookaheadSamples), false, false, true);

    oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
        2, 2, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
    oversampler->initProcessing(static_cast<size_t>(samplesPerBlock));
    reset();
}

void S13Limiter::releaseResources()
{
    reset();
}

void S13Limiter::reset()
{
    limiter.reset();
    lookaheadBuffer.clear();
    lookaheadWriteIndex = 0;
    const int ringSize = lookaheadBuffer.getNumSamples();
    const int maximumDelay =
        ringSize > 1 ? ringSize - 1 : 0;
    activeLookaheadSamples =
        juce::jlimit(
            0,
            maximumDelay,
            static_cast<int>(
                std::round(
                    juce::jlimit(
                        0.0f, 20.0f,
                        lookaheadMs.load(
                            std::memory_order_relaxed))
                    * 0.001f
                    * static_cast<float>(
                        juce::jmax(
                            1.0,
                            cachedSampleRate)))));
    targetLookaheadSamples = activeLookaheadSamples;
    pendingLookaheadSamples = activeLookaheadSamples;
    lookaheadMorphActive = false;
    smoothedLookaheadMorph.setCurrentAndTargetValue(0.0f);
    smoothedThresholdGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -20.0f, 0.0f,
                threshold.load(std::memory_order_relaxed))));
    smoothedCeiling.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -3.0f, 0.0f,
                ceiling.load(std::memory_order_relaxed))));
    gainEnvelope = 1.0f;
    previousDetectorSample.fill(0.0f);
    if (oversampler)
        oversampler->reset();
    gainReductionDB.store(0.0f, std::memory_order_relaxed);
}

void S13Limiter::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    float inputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        inputPeak = juce::jmax(inputPeak, buffer.getMagnitude(ch, 0, numSamples));

    const float targetThresholdGain =
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -20.0f, 0.0f,
                threshold.load(std::memory_order_relaxed)));
    const float targetCeiling =
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -3.0f, 0.0f,
                ceiling.load(std::memory_order_relaxed)));
    smoothedThresholdGain.setTargetValue(
        targetThresholdGain);
    smoothedCeiling.setTargetValue(targetCeiling);

    float truePeakScale = 1.0f;
    if (oversampler != nullptr)
    {
        const juce::dsp::AudioBlock<const float>
            inputBlock(buffer);
        const auto blockToScan =
            inputBlock.getSubBlock(
                0,
                static_cast<size_t>(numSamples));
        auto oversampledBlock = oversampler->processSamplesUp(blockToScan);
        float oversampledPeak = 0.0f;
        for (size_t ch = 0; ch < oversampledBlock.getNumChannels(); ++ch)
        {
            auto* channelData = oversampledBlock.getChannelPointer(ch);
            for (size_t sample = 0; sample < oversampledBlock.getNumSamples(); ++sample)
                oversampledPeak = juce::jmax(oversampledPeak, std::abs(channelData[sample]));
        }
        // This oversampler is detector-only. Downsampling its internal buffer
        // cannot affect the already-measured peak or the next upsampling
        // state, so omitting the unused down path preserves detection while
        // removing roughly half of the former true-peak filter work.
        if (inputPeak > 1.0e-6f && oversampledPeak > inputPeak)
            truePeakScale = juce::jlimit(1.0f, 3.0f, oversampledPeak / inputPeak);
    }

    const float srf = static_cast<float>(juce::jmax(1.0, cachedSampleRate));
    const float releaseCoeff = std::exp(-1.0f / (juce::jlimit(10.0f, 500.0f, releaseMs.load(std::memory_order_relaxed)) * 0.001f * srf));
    const int ringSize = lookaheadBuffer.getNumSamples();
    pendingLookaheadSamples =
        juce::jlimit(
            0,
            ringSize > 1 ? ringSize - 1 : 0,
            static_cast<int>(
                std::round(
                    juce::jlimit(
                        0.0f, 20.0f,
                        lookaheadMs.load(
                            std::memory_order_relaxed))
                    * 0.001f * srf)));
    if (! lookaheadMorphActive
        && pendingLookaheadSamples
            != activeLookaheadSamples)
    {
        targetLookaheadSamples =
            pendingLookaheadSamples;
        smoothedLookaheadMorph
            .setCurrentAndTargetValue(0.0f);
        smoothedLookaheadMorph.setTargetValue(1.0f);
        lookaheadMorphActive = true;
    }

    float peakGain = 1.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        float detectorPeak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const float sample = buffer.getSample(ch, i);
            const int detectorChannel = juce::jmin(ch, static_cast<int>(previousDetectorSample.size()) - 1);
            const float previous = previousDetectorSample[static_cast<size_t>(detectorChannel)];
            const float midpointEstimate = std::abs((sample + previous) * 0.5f) + std::abs(sample - previous) * 0.25f;
            detectorPeak = juce::jmax(detectorPeak, std::abs(sample), midpointEstimate);
            previousDetectorSample[static_cast<size_t>(detectorChannel)] = sample;
        }
        detectorPeak *= truePeakScale;

        const float thresholdForSample =
            smoothedThresholdGain.getNextValue();
        const float ceilingForSample =
            smoothedCeiling.getNextValue();
        const float limitGainForSample =
            juce::jmin(
                thresholdForSample,
                ceilingForSample);
        const float targetGain =
            detectorPeak > limitGainForSample
                    && detectorPeak > 1.0e-8f
            ? juce::jlimit(
                  0.0f,
                  1.0f,
                  limitGainForSample / detectorPeak)
            : 1.0f;

        if (targetGain < gainEnvelope)
            gainEnvelope = targetGain;
        else
            gainEnvelope = releaseCoeff * gainEnvelope + (1.0f - releaseCoeff) * targetGain;
        peakGain = juce::jmin(peakGain, gainEnvelope);

        for (int ch = 0; ch < numChannels; ++ch)
            lookaheadBuffer.setSample(ch, lookaheadWriteIndex, buffer.getSample(ch, i));

        int activeReadIndex =
            lookaheadWriteIndex
            - activeLookaheadSamples;
        if (activeReadIndex < 0)
            activeReadIndex += ringSize;
        int targetReadIndex =
            lookaheadWriteIndex
            - targetLookaheadSamples;
        if (targetReadIndex < 0)
            targetReadIndex += ringSize;
        const float lookaheadMorph =
            lookaheadMorphActive
                ? smoothedLookaheadMorph.getNextValue()
                : 0.0f;
        const float ceilingScale = gainEnvelope < 0.9999f
            ? ceilingForSample
                / juce::jmax(
                    1.0e-6f,
                    limitGainForSample)
            : 1.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const float activeTap =
                lookaheadBuffer.getSample(
                    ch,
                    activeReadIndex);
            const float delayed =
                lookaheadMorphActive
                    ? activeTap
                        + (lookaheadBuffer.getSample(
                               ch,
                               targetReadIndex)
                           - activeTap)
                            * lookaheadMorph
                    : activeTap;
            float limited =
                delayed
                * gainEnvelope
                * ceilingScale;
            const float absLimited = std::abs(limited);
            const float kneeStart = ceilingForSample * 0.98f;
            if (absLimited > kneeStart)
            {
                const float sign = limited >= 0.0f ? 1.0f : -1.0f;
                const float kneeWidth = juce::jmax(ceilingForSample - kneeStart, 1.0e-6f);
                const float x = juce::jmax(0.0f, (absLimited - kneeStart) / kneeWidth);
                const float curved = kneeStart + kneeWidth * (1.0f - 1.0f / (1.0f + x));
                limited = sign * juce::jmin(ceilingForSample, curved);
            }
            buffer.setSample(ch, i, limited);
        }

        lookaheadWriteIndex = (lookaheadWriteIndex + 1) % ringSize;
    }
    if (lookaheadMorphActive
        && ! smoothedLookaheadMorph.isSmoothing())
    {
        activeLookaheadSamples =
            targetLookaheadSamples;
        lookaheadMorphActive = false;
        smoothedLookaheadMorph
            .setCurrentAndTargetValue(0.0f);
    }

    // GR metering
    sanitizeBuiltInBuffer(buffer, 1.25f);
    float outputPeak = 0.0f;
    for (int ch = 0; ch < numChannels; ++ch)
        outputPeak = juce::jmax(outputPeak, buffer.getMagnitude(ch, 0, numSamples));
    float inDB = juce::Decibels::gainToDecibels(inputPeak, -100.0f);
    float outDB = juce::Decibels::gainToDecibels(outputPeak, -100.0f);
    gainReductionDB.store(juce::jmin(outDB - inDB, juce::Decibels::gainToDecibels(peakGain, -100.0f)));
}

void S13Limiter::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("S13Limiter");
    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("ceiling", ceiling.load(), nullptr);
    state.setProperty("lookahead", lookaheadMs.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void S13Limiter::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "S13Limiter") return;

    threshold.store(static_cast<float>(state.getProperty("threshold", -1.0f)));
    releaseMs.store(static_cast<float>(state.getProperty("release", 100.0f)));
    ceiling.store(static_cast<float>(state.getProperty("ceiling", 0.0f)));
    lookaheadMs.store(static_cast<float>(state.getProperty("lookahead", 5.0f)));
}
