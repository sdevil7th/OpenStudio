#include "BuiltInEffects.h"
#include "BuiltInEQPreparedPrograms.h"
#include "BuiltInEQRouting.h"
#include <unordered_map>
#include "OpenStudioPluginEditors.h"

//==============================================================================
// OpenStudioBuiltInEffect -- shared base class
//==============================================================================

juce::AudioProcessor::BusesProperties OpenStudioBuiltInEffect::builtInBuses(bool externalKey)
{
    auto buses = juce::AudioProcessor::BusesProperties()
        .withInput("Input", juce::AudioChannelSet::stereo(), true)
        .withOutput("Output", juce::AudioChannelSet::stereo(), true);
    return externalKey ? buses.withInput("Sidechain", juce::AudioChannelSet::stereo(), true) : buses;
}

OpenStudioBuiltInEffect::OpenStudioBuiltInEffect(bool externalKeyBus)
    : AudioProcessor(builtInBuses(externalKeyBus))
{
}

void OpenStudioBuiltInEffect::captureDetectorKey(const juce::AudioBuffer<float>& buffer) noexcept
{
    detectorKey.capture(buffer, getMainBusNumInputChannels(),
        supportsExternalKey() ? getBus(true, 1)->getNumberOfChannels() : 0,
        supportsExternalKey() && externalDetector.load() >= .5f);
}

bool OpenStudioBuiltInEffect::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    const auto& mainIn  = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();
    if (mainOut != mainIn) return false;
    return mainOut == juce::AudioChannelSet::mono()
        || mainOut == juce::AudioChannelSet::stereo();
}

void OpenStudioBuiltInEffect::setOversamplingEnabled(bool enabled)
{
    oversamplingEnabled = enabled;
}

juce::AudioProcessorEditor* OpenStudioBuiltInEffect::createEditor()
{
    return nullptr; // Derived classes override this
}

juce::AudioProcessorEditor* OpenStudioEQ::createEditor() { return new OpenStudioEQEditor(*this); }
juce::AudioProcessorEditor* OpenStudioCompressor::createEditor() { return new OpenStudioCompressorEditor(*this); }
juce::AudioProcessorEditor* OpenStudioGate::createEditor() { return new OpenStudioGateEditor(*this); }
juce::AudioProcessorEditor* OpenStudioLimiter::createEditor() { return new OpenStudioLimiterEditor(*this); }

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

void prepareRealtimeFilterLut(std::vector<OpenStudioIIRCoefficientSet>& lut,
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
        jassert(source.size() == static_cast<int>(lut[index].size()));
        for (size_t coefficient = 0; coefficient < lut[index].size(); ++coefficient)
            lut[index][coefficient] = source[static_cast<int>(coefficient)];
    }
}

const OpenStudioIIRCoefficientSet& lookupRealtimeFilterLut(
    const std::vector<OpenStudioIIRCoefficientSet>& lut,
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
                                     const OpenStudioIIRCoefficientSet& coefficients) noexcept
{
    jassert(filter.coefficients != nullptr);
    if (filter.coefficients == nullptr)
        return;

    auto& destination = filter.coefficients->coefficients;
    jassert(destination.size() == static_cast<int>(coefficients.size()));
    if (destination.size() != static_cast<int>(coefficients.size()))
        return;

    for (size_t coefficient = 0; coefficient < coefficients.size(); ++coefficient)
        destination.set(static_cast<int>(coefficient), coefficients[coefficient]);
}

void writeRealtimeFilterCoefficients(juce::dsp::IIR::Filter<float>& left,
                                     juce::dsp::IIR::Filter<float>& right,
                                     const OpenStudioIIRCoefficientSet& coefficients) noexcept
{
    writeRealtimeFilterCoefficients(left, coefficients);
    if (right.coefficients != left.coefficients)
        writeRealtimeFilterCoefficients(right, coefficients);
}

bool advanceRealtimeFilterCoefficients(
    juce::dsp::IIR::Filter<float>& filter,
    const OpenStudioIIRCoefficientSet& target,
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
    const OpenStudioIIRCoefficientSet& target,
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

constexpr OpenStudioIIRCoefficientSet kIdentityBiquad {
    1.0f, 0.0f, 0.0f, 0.0f, 0.0f
};

OpenStudioIIRCoefficientSet normaliseBiquad(
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

OpenStudioIIRCoefficientSet normaliseFirstOrderAsBiquad(
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

double getFixedBiquadMagnitude(const OpenStudioIIRCoefficientSet& coefficients,
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
//  OpenStudioEQ -- 8-band parametric EQ
//==============================================================================

OpenStudioEQ::OpenStudioEQ(bool standalone) : OpenStudioBuiltInEffect(standalone), bandCount(standalone ? maxBands : numBands)
{
    if(standalone) { matchCapture=std::make_unique<BuiltInAlignmentCapture>(); linearPhase=std::make_unique<BuiltInLinearPhaseEQ>(); spectralEQ=std::make_unique<BuiltInSpectralEQ>(); }
    for (int i = 0; i < bandCount; ++i)
    {
        bands[i].freq.store(i < numBands ? defaultFrequencies[static_cast<size_t>(i)] : 1000.0f);
        bands[i].enabled.store(i < numBands ? 1.0f : 0.0f);
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
        effectiveDynamicControls[static_cast<size_t>(i)][0].store(-24);effectiveDynamicControls[static_cast<size_t>(i)][1].store(10);effectiveDynamicControls[static_cast<size_t>(i)][2].store(150);
    }
    // First band defaults to low cut (off), last to high cut (off)
    bands[0].type.store(static_cast<float>(FilterType::LowCut));
    bands[0].freq.store(20.0f);
    bands[0].enabled.store(0.0f);
    bands[7].type.store(static_cast<float>(FilterType::HighCut));
    bands[7].freq.store(20000.0f);
    bands[7].enabled.store(0.0f);
}

#include "BuiltInEQPhase.inc"
#include "BuiltInEQDetector.inc"

int OpenStudioEQ::getNumStagesForSlope(FilterSlope slope) const
{
    switch (slope)
    {
        case FilterSlope::dB6:  return 1;
        case FilterSlope::dB12: return 1;
        case FilterSlope::dB24: return 2;
        case FilterSlope::dB48: return 4;
        case FilterSlope::dB72: return 6;
        case FilterSlope::dB96: return 8;
        default: return 1;
    }
}

void OpenStudioEQ::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    draftPreview.reset(sampleRate);
    midiBankMSB.fill(0);midiBankLSB.fill(0);midiProgramSampleOffset=0;midiProgramObservation.store(0);
    detectorKey.prepare(sampleRate, samplesPerBlock, supportsExternalKey() && externalDetector.load() >= .5f);
    if(matchCapture)matchCapture->prepare(sampleRate);
    cachedSampleRate = sampleRate;
    spectralPreScratch.setSize(2, juce::jmax(1, samplesPerBlock));
    publishedSampleRate.store(sampleRate, std::memory_order_release);
    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2u };

    juce::dsp::ProcessSpec monoSpec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 1u };
    for (int b = 0; b < bandCount; ++b)
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
            for (auto& filter : freeDetectorFilters[b][ch])
            {
                *filter.coefficients = juce::dsp::IIR::Coefficients<float>(1, 0, 0, 1, 0, 0);
                filter.prepare(monoSpec);
            }
        }
        dynamicEnvelope[static_cast<size_t>(b)] = 0.0f;
        adaptiveDetectors[static_cast<size_t>(b)].reset();adaptiveWasActive[static_cast<size_t>(b)]=false;
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
    bandScratch.setSize(2, samplesPerBlock, false, false, true);
    detectorListenScratch.setSize(2, samplesPerBlock, false, false, true);
    resetDetectorConfiguration(true);
    resetTargetWeights(true);

    const float initialPower =
        powerEnabled.load(std::memory_order_acquire) && editorBypass.load() < .5f ? 1.0f : 0.0f;
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
    for (auto& slot : *spectrumCaptureSlots)
    {
        int state=slot.state.load(std::memory_order_acquire);
        while(state!=3&&!slot.state.compare_exchange_weak(state,0,std::memory_order_acq_rel)) {}
    }
    spectrumResetEpoch.fetch_add(1, std::memory_order_release);
    preparePhaseProcessing();
    rebuildMIDIPrograms();
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

void OpenStudioEQ::resetTargetWeights(bool prepare)
{
    for(int b=0;b<bandCount;++b)
    {
        const int target=juce::jlimit(0,4,juce::roundToInt(bands[b].target.load()));
        for(size_t i=0;i<5;++i) { auto& weight=targetWeights[static_cast<size_t>(b)][i]; if(prepare) weight.reset(cachedSampleRate,.01); weight.setCurrentAndTargetValue(target==static_cast<int>(i)?1.0f:0.0f); }
    }
}

void OpenStudioEQ::reset()
{
    if(const auto* map=publishedMIDIPrograms.load(std::memory_order_acquire);map&&map->prepared)map->prepared->reset();
    midiBankMSB.fill(0);midiBankLSB.fill(0);midiProgramObservation.store(0);midiProgramSampleOffset=0;
    draftPreview.reset(publishedSampleRate.load());
    if (linearPhase) linearPhase->reset();
    if (spectralEQ) spectralEQ->reset(powerEnabled.load() && editorBypass.load() < .5f && detectorListenBand.load() < .5f && auditionBand.load() < .5f);
    detectorKey.reset(supportsExternalKey() && externalDetector.load() >= .5f);
    if(matchCapture)matchCapture->abort();
    resetTargetWeights(false);
    resetDetectorConfiguration(false);
    for (auto& peak : outputPeaks) peak.store(-100.0f, std::memory_order_relaxed);
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
        powerEnabled.load(std::memory_order_acquire) && editorBypass.load() < .5f ? 1.0f : 0.0f;
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
    for (auto& slot : *spectrumCaptureSlots)
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
    spectrumResetEpoch.fetch_add(1, std::memory_order_release);
}

void OpenStudioEQ::releaseResources()
{
    draftPreview.reset(publishedSampleRate.load());
    if (linearPhase) linearPhase->release();
    if (spectralEQ) spectralEQ->release();
    filtersPrepared = false;
    spectrumDemandSamplesRemaining.store(0, std::memory_order_release);
    spectrumCaptureSlot = -1;
    spectrumCaptureWritePos = 0;
    for (int b = 0; b < bandCount; ++b)
    {
        for (int s = 0; s < maxStagesPerBand; ++s)
            bandFilters[b][s].reset();
        for (int ch = 0; ch < 2; ++ch)
        dynamicDetectorFilters[b][ch].reset();
        dynamicEnvelope[static_cast<size_t>(b)] = 0.0f;
        adaptiveDetectors[static_cast<size_t>(b)].reset();adaptiveWasActive[static_cast<size_t>(b)]=false;
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
    dryScratch.setSize(0, 0); bandScratch.setSize(0, 0);
    activeProcessingMode = 0;
    pendingProcessingMode = 0;
    modeTransitionPending = false;
    wetPathHasState = false;
    for (auto& slot : *spectrumCaptureSlots)
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
    spectrumResetEpoch.fetch_add(1, std::memory_order_release);
}

int OpenStudioEQ::buildBandTargets(
    int b,
    bool shouldProcess,
    std::array<OpenStudioIIRCoefficientSet, maxStagesPerBand>& targets, bool includeDynamics, bool analogPrototype) const noexcept
{
    targets.fill(kIdentityBiquad);
    if (!shouldProcess)
        return 0;

    const double sr =
        publishedSampleRate.load(std::memory_order_acquire);
    if (sr <= 0.0)
        return 0;

    const float nyquist = static_cast<float>(sr * 0.5) - 1.0f;
    const auto type = supportsExternalKey() && bands[b].allPass.load() >= .5f ? FilterType::AllPass : static_cast<FilterType>(
        juce::jlimit(0, static_cast<int>(supportsExternalKey() ? FilterType::FlatTilt : FilterType::BandPass),
                     static_cast<int>(std::round(
                         bands[b].type.load(std::memory_order_relaxed)))));
    const auto slope = static_cast<FilterSlope>(
        juce::jlimit(0, static_cast<int>(FilterSlope::dB96),
                     static_cast<int>(std::round(
                         bands[b].slope.load(std::memory_order_relaxed)))));
    const float requestedFrequency = juce::jlimit(
        supportsExternalKey() ? 10.0f : 20.0f, nyquist,
        bands[b].freq.load(std::memory_order_relaxed));
    const float freq = analogPrototype ? static_cast<float>(sr / juce::MathConstants<double>::pi
        * std::atan(juce::MathConstants<double>::pi * requestedFrequency / sr)) : requestedFrequency;
    const float baseGainDB = bands[b].gain.load(std::memory_order_relaxed);
    const float dynamicDB = includeDynamics && !usesSpectralBand(b) ? dynamicGainDB[static_cast<size_t>(b)].load(std::memory_order_relaxed) : 0.0f;
    float gainDB = juce::jlimit(-30.0f, 30.0f, baseGainDB + dynamicDB);
    float q = juce::jlimit(
        0.1f, 30.0f,
        bands[b].q.load(std::memory_order_relaxed));
    if (supportsExternalKey() && type == FilterType::Bell && bands[b].gainQInteraction.load() >= .5f)
    {
        // Original reciprocal interaction: up to 60% narrower at 30 dB, and
        // 4% more gain per octave of Q above 1. No proprietary curve claim.
        const float requestedQ = q;
        q = juce::jlimit(.1f, 30.0f, q * (1 + .02f * std::abs(gainDB)));
        gainDB = juce::jlimit(-30.0f, 30.0f, gainDB * (1 + .04f * juce::jmax(0.0f, std::log2(requestedQ))));
    }
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

        case FilterType::AllPass:
            targets[0] = normaliseBiquad(ArrayCoefficients::makeAllPass(sr, freq, q));
            return 1;

        case FilterType::TiltShelf:
            targets[0] = normaliseBiquad(ArrayCoefficients::makeLowShelf(sr, freq, q, 1.0f / gainFactor));
            targets[1] = normaliseBiquad(ArrayCoefficients::makeHighShelf(sr, freq, q, gainFactor));
            return 2;

        case FilterType::FlatTilt:
        {
            // Eight distributed gentle shelves approximate a straight dB/log-Hz
            // tilt over 10 Hz-30 kHz. Normalize the requested pivot to 0 dB.
            const float perStage = juce::Decibels::decibelsToGain(gainDB * .25f);
            const auto z = std::polar(1.0, -juce::MathConstants<double>::twoPi * freq / sr);
            std::complex<double> pivot = 1;
            for (int stage = 0; stage < maxStagesPerBand; ++stage)
            {
                const float center = juce::jmin(nyquist, 10.0f * std::pow(3000.0f, (static_cast<float>(stage) + .5f) / 8));
                auto& c = targets[static_cast<size_t>(stage)];
                const double k = std::tan(juce::MathConstants<double>::pi * center / sr) * std::sqrt(perStage);
                c = {static_cast<float>((perStage + k) / (1 + k)), static_cast<float>((k - perStage) / (1 + k)), 0,
                    static_cast<float>((k - 1) / (1 + k)), 0};
                pivot *= (static_cast<double>(c[0]) + static_cast<double>(c[1]) * z + static_cast<double>(c[2]) * z * z)
                    / (1.0 + static_cast<double>(c[3]) * z + static_cast<double>(c[4]) * z * z);
            }
            const float normalization = static_cast<float>(1 / juce::jmax(1e-9, std::abs(pivot)));
            for (size_t coefficient = 0; coefficient < 3; ++coefficient) targets[0][coefficient] *= normalization;
            return maxStagesPerBand;
        }
    }

    return 0;
}

void OpenStudioEQ::updateBand(int b, int auditionIndex, bool forceImmediate)
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

void OpenStudioEQ::updateFilters(bool forceImmediate)
{
    if (!filtersPrepared)
        return;

    const int auditionIndex = juce::jlimit(
        -1, bandCount - 1,
        static_cast<int>(std::round(
            auditionBand.load(std::memory_order_relaxed))) - 1);
    const bool auditionChanged =
        auditionIndex != cachedAuditionIndex;

    for (int b = 0; b < bandCount; ++b)
    {
        auto& cached = cachedBandStates[static_cast<size_t>(b)];
        const float enabled = bands[b].enabled.load(std::memory_order_relaxed) >= 0.5f ? 1.0f : 0.0f;
        const int type = supportsExternalKey() && bands[b].allPass.load() >= .5f ? static_cast<int>(FilterType::AllPass) : static_cast<int>(bands[b].type.load(std::memory_order_relaxed));
        const float freq = bands[b].freq.load(std::memory_order_relaxed);
        const float baseGain = bands[b].gain.load(std::memory_order_relaxed);
        const float dynamicGain = usesSpectralBand(b) ? 0 : dynamicGainDB[static_cast<size_t>(b)].load(std::memory_order_relaxed);
        const float gain = juce::jlimit(-30.0f, 30.0f, baseGain + dynamicGain);
        const float q = bands[b].q.load(std::memory_order_relaxed);
        const int slope = static_cast<int>(bands[b].slope.load(std::memory_order_relaxed));
        const float gainQ = bands[b].gainQInteraction.load();

        const bool changed = forceImmediate
                          || auditionChanged
                          || !cached.valid
                          || cached.enabled != enabled
                          || cached.type != type
                          || cached.slope != slope
                          || cached.gainQ != gainQ
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
        cached.slope = slope; cached.gainQ = gainQ;
    }
    cachedAuditionIndex = auditionIndex;
    if (forceImmediate)
        filtersNeedSmoothing = false;
}

void OpenStudioEQ::updateDynamicBands(const juce::AudioBuffer<float>& buffer,
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
    const int listenBand = supportsExternalKey() ? juce::jlimit(0, bandCount, juce::roundToInt(detectorListenBand.load())) : 0;
    detectorListenScratch.clear();
    detectorListenMix.setTargetValue(listenBand > 0 ? 1.0f : 0.0f);
    for (int b = 0; b < bandCount; ++b)
    {
        const size_t bandIndex = static_cast<size_t>(b);
        const float rangeLimit=supportsExternalKey()?30.0f:24.0f;
        const float rangeDB = juce::jlimit(-rangeLimit, rangeLimit, bands[b].dynamicRange.load(std::memory_order_relaxed));
        const bool dynamicOn = !usesSpectralBand(b) && bands[b].type.load() <= 2 && bands[b].allPass.load() < .5f && bands[b].dynamicEnabled.load(std::memory_order_relaxed) >= 0.5f && std::abs(rangeDB) > 0.01f;
        const bool adaptiveThreshold=supportsExternalKey()&&bands[b].dynamicThresholdMode.load()>=.5f;
        const bool adaptiveTiming=supportsExternalKey()&&bands[b].dynamicTimingMode.load()>=.5f;
        const bool adapting=dynamicOn&&(adaptiveThreshold||adaptiveTiming);
        if(adapting&&!adaptiveWasActive[bandIndex])adaptiveDetectors[bandIndex].reset(dynamicEnvelope[bandIndex]*dynamicEnvelope[bandIndex]);
        adaptiveWasActive[bandIndex]=adapting;
        const int keySource = supportsExternalKey() ? juce::jlimit(0, 2, juce::roundToInt(bands[b].detectorSource.load())) : 0;
        auto& keyWeights = detectorSourceWeights[bandIndex];
        for (int choice = 0; choice < 3; ++choice) keyWeights[static_cast<size_t>(choice)].setTargetValue(choice == keySource ? 1.0f : 0.0f);
        auto& freeWeight = freeDetectorWeights[bandIndex];
        freeWeight.setTargetValue(supportsExternalKey() && bands[b].detectorMode.load() >= .5f ? 1.0f : 0.0f);
        auto& listenWeight = detectorListenWeights[bandIndex];
        listenWeight.setTargetValue(listenBand == b + 1 ? 1.0f : 0.0f);
        const bool listening = listenWeight.isSmoothing() || listenWeight.getCurrentValue() > 0;
        if (!dynamicOn && !listening)
        {
            for (auto& weight : keyWeights) weight.skip(numSamples);
            freeWeight.skip(numSamples); listenWeight.skip(numSamples);
            dynamicEnvelope[bandIndex] *= 0.85f;
            const float current = dynamicGainDB[bandIndex].load(std::memory_order_relaxed);
            dynamicGainDB[bandIndex].store(current * 0.85f, std::memory_order_relaxed);
            continue;
        }

        const float freq = juce::jlimit(supportsExternalKey() ? 10.0f : 20.0f, nyquist, bands[b].freq.load(std::memory_order_relaxed));
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

        const float highLimit = static_cast<float>(sr * .475);
        const float lowCut = juce::jlimit(20.0f, highLimit / 1.05f, bands[b].detectorLowCut.load());
        const float highCut = juce::jlimit(lowCut * 1.05f, highLimit, bands[b].detectorHighCut.load());
        auto& cachedCuts = cachedFreeDetectorCuts[bandIndex];
        if (cachedCuts[0] != lowCut || cachedCuts[1] != highCut)
        {
            const auto highPass = normaliseBiquad(juce::dsp::IIR::ArrayCoefficients<float>::makeHighPass(sr, lowCut));
            const auto lowPass = normaliseBiquad(juce::dsp::IIR::ArrayCoefficients<float>::makeLowPass(sr, highCut));
            for (int channel = 0; channel < 2; ++channel)
            {
                writeRealtimeFilterCoefficients(freeDetectorFilters[b][channel][0], highPass);
                writeRealtimeFilterCoefficients(freeDetectorFilters[b][channel][1], lowPass);
            }
            cachedCuts = {lowCut, highCut};
        }

        float sumSquares = 0.0f;
        const int placement=numChannels==2?juce::jlimit(0,4,juce::roundToInt(bands[b].target.load())):0;
        for (int i = 0; i < numSamples; ++i)
        {
            std::array<float,2> filtered {};
            const std::array<float,3> weights {keyWeights[0].getNextValue(),keyWeights[1].getNextValue(),keyWeights[2].getNextValue()};
            const float freeMix = freeWeight.getNextValue(), listenMix = listenWeight.getNextValue();
            const auto keySample = [&](int channel)
            {
                return weights[0] >= 1 ? detectorKey.sample(channel, i)
                    : weights[0] * detectorKey.sample(channel, i) + weights[1] * detectorKey.rawSample(false, channel, i) + weights[2] * detectorKey.rawSample(true, channel, i);
            };
            const float left = keySample(0), right = keySample(1);
            for (int ch = 0; ch < numChannels; ++ch)
            {
                const bool midSide = buffer.getNumChannels() > 1;
                const float key = midSide && activeProcessingMode == 1 ? (left + right) * .5f
                    : midSide && activeProcessingMode == 2 ? (left - right) * .5f : (ch == 0 ? left : right);
                const float bandOutput = dynamicDetectorFilters[b][ch].processSample(key);
                const float freeOutput = freeDetectorFilters[b][ch][1].processSample(freeDetectorFilters[b][ch][0].processSample(key));
                filtered[static_cast<size_t>(ch)] = freeMix <= 0 ? bandOutput : freeMix >= 1 ? freeOutput : bandOutput + (freeOutput - bandOutput) * freeMix;
            }
            if (listenMix > 0)
            {
                float listenL = filtered[0], listenR = numChannels > 1 ? filtered[1] : filtered[0];
                if (activeProcessingMode == 2 && buffer.getNumChannels() > 1) listenR = -listenL;
                else if (placement == 1) listenR = listenL;
                else if (placement == 2) listenL = listenR;
                else if (placement == 3) listenL = listenR = (filtered[0] + filtered[1]) * .5f;
                else if (placement == 4) { listenL = (filtered[0] - filtered[1]) * .5f; listenR = -listenL; }
                detectorListenScratch.addSample(0, i, listenL * listenMix);
                detectorListenScratch.addSample(1, i, listenR * listenMix);
            }
            if(placement==0) { for(int ch=0;ch<numChannels;++ch) sumSquares+=filtered[static_cast<size_t>(ch)]*filtered[static_cast<size_t>(ch)]; }
            else { const float detector=placement==1?filtered[0]:placement==2?filtered[1]:placement==3?(filtered[0]+filtered[1])*.5f:(filtered[0]-filtered[1])*.5f; sumSquares+=detector*detector; }
            if(adapting)
            {
                float power=0;
                if(placement==0){for(int ch=0;ch<numChannels;++ch)power+=filtered[static_cast<size_t>(ch)]*filtered[static_cast<size_t>(ch)];power/=static_cast<float>(numChannels);}
                else {const float key=placement==1?filtered[0]:placement==2?filtered[1]:placement==3?(filtered[0]+filtered[1])*.5f:(filtered[0]-filtered[1])*.5f;power=key*key;}
                adaptiveDetectors[bandIndex].process(power);
            }
        }
        if (!dynamicOn)
        {
            dynamicEnvelope[bandIndex] *= .85f;
            dynamicGainDB[bandIndex].store(dynamicGainDB[bandIndex].load(std::memory_order_relaxed) * .85f, std::memory_order_relaxed);
            continue;
        }
        const float blockLevel = adapting?adaptiveDetectors[bandIndex].level():std::sqrt(sumSquares / static_cast<float>(numSamples * (placement==0?numChannels:1)));
        const auto automaticTimes=adaptiveTiming?adaptiveDetectors[bandIndex].timing(freq,rangeDB):std::array<float,2>{};
        const float attackMs = adaptiveTiming?automaticTimes[0]:juce::jlimit(0.2f, 250.0f, bands[b].dynamicAttack.load(std::memory_order_relaxed));
        const float releaseMs = adaptiveTiming?automaticTimes[1]:juce::jlimit(5.0f, 2000.0f, bands[b].dynamicRelease.load(std::memory_order_relaxed));
        const float attackCoeff = std::exp(-static_cast<float>(numSamples) / (attackMs * 0.001f * static_cast<float>(sr)));
        const float releaseCoeff = std::exp(-static_cast<float>(numSamples) / (releaseMs * 0.001f * static_cast<float>(sr)));
        const float levelCoeff = blockLevel > dynamicEnvelope[bandIndex] ? attackCoeff : releaseCoeff;
        dynamicEnvelope[bandIndex] = levelCoeff * dynamicEnvelope[bandIndex] + (1.0f - levelCoeff) * blockLevel;

        const float levelDB = juce::Decibels::gainToDecibels(dynamicEnvelope[bandIndex], -100.0f);
        const float thresholdDB = adaptiveThreshold?adaptiveDetectors[bandIndex].threshold(bands[b].dynamicSensitivity.load()):juce::jlimit(-80.0f, 0.0f, bands[b].dynamicThreshold.load(std::memory_order_relaxed));
        effectiveDynamicControls[bandIndex][0].store(thresholdDB,std::memory_order_relaxed);effectiveDynamicControls[bandIndex][1].store(attackMs,std::memory_order_relaxed);effectiveDynamicControls[bandIndex][2].store(releaseMs,std::memory_order_relaxed);
        const float activity = juce::jlimit(0.0f, 1.0f, (levelDB - thresholdDB) / 18.0f);
        const float targetDynamicDB = rangeDB * activity;
        const float currentDynamicDB = dynamicGainDB[bandIndex].load(std::memory_order_relaxed);
        const float gainCoeff = std::abs(targetDynamicDB) > std::abs(currentDynamicDB) ? attackCoeff : releaseCoeff;
        const float nextDynamicDB = gainCoeff * currentDynamicDB + (1.0f - gainCoeff) * targetDynamicDB;
        dynamicGainDB[bandIndex].store(juce::jlimit(-rangeLimit, rangeLimit, nextDynamicDB), std::memory_order_relaxed);
    }
}

bool OpenStudioEQ::advanceStageCoefficients(int bandIndex,
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

void OpenStudioEQ::resetWetPathState() noexcept
{
    for (int band = 0; band < bandCount; ++band)
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
        adaptiveDetectors[static_cast<size_t>(band)].reset();adaptiveWasActive[static_cast<size_t>(band)]=false;
        dynamicGainDB[static_cast<size_t>(band)].store(
            0.0f, std::memory_order_relaxed);
        cachedBandStates[static_cast<size_t>(band)].valid = false;
    }
}

void OpenStudioEQ::advanceAutoGainEstimateProbe() noexcept
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
    const int auditionIndex = juce::jlimit(-1, bandCount - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);
    for (int b = 0; b < bandCount; ++b)
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
                != static_cast<int>(OpenStudioIIRCoefficientSet {}.size()))
                continue;

            OpenStudioIIRCoefficientSet currentCoefficients {};
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

void OpenStudioEQ::publishOutputPeaks(const juce::AudioBuffer<float>& buffer) noexcept
{
    const float releaseDb = static_cast<float>(buffer.getNumSamples() / juce::jmax(1.0, cachedSampleRate)) * 36.0f;
    for (int channel = 0; channel < 2; ++channel)
    {
        const float peak = buffer.getMagnitude(juce::jmin(channel, buffer.getNumChannels() - 1), 0, buffer.getNumSamples());
        const auto index = static_cast<size_t>(channel);
        const float db = juce::Decibels::gainToDecibels(peak, -100.0f);
        outputPeaks[index].store(juce::jmax(db, outputPeaks[index].load(std::memory_order_relaxed) - releaseDb), std::memory_order_relaxed);
    }
}

void OpenStudioEQ::captureMatchOutput(const juce::AudioBuffer<float>& buffer) noexcept
{
    if(!matchCapture||matchCapture->state.load(std::memory_order_relaxed)!=1)return;
    const auto clock=getPlayHead()?getPlayHead()->getPosition():juce::Optional<juce::AudioPlayHead::PositionInfo>();
    if(clock&&clock->getTimeInSamples())matchCapture->process(buffer,*clock->getTimeInSamples()+midiProgramSampleOffset,clock->getIsPlaying());
    else matchCapture->abort();
}

void OpenStudioEQ::processEQAudioBlock(juce::AudioBuffer<float>& fullBuffer)
{
    captureDetectorKey(fullBuffer);
    const int mainChannels = juce::jmin(getMainBusNumInputChannels(), fullBuffer.getNumChannels());
    if (mainChannels <= 0) return;
    float* mainPointers[2] = { fullBuffer.getWritePointer(0), fullBuffer.getWritePointer(juce::jmin(1, mainChannels - 1)) };
    juce::AudioBuffer<float> buffer(mainPointers, juce::jmin(2, mainChannels), fullBuffer.getNumSamples());
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    if(draftPreview.requested())draftPreview.beginBlock(numSamples,publishedSampleRate.load(),draftFingerprint(),canPreviewDraft(),isNonRealtime());
    const bool spectral = spectralEQ && frequencyProcessingRequested();
    const bool requestedSpectrum = isSpectrumCaptureRequested(numSamples);
    if (spectral && requestedSpectrum && spectralPreScratch.getNumSamples() >= numSamples)
        for (int ch = 0; ch < numChannels; ++ch) spectralPreScratch.copyFrom(ch, 0, buffer, ch, 0, numSamples);
    struct FinalOutput
    {
        OpenStudioEQ& eq; juce::AudioBuffer<float>& audio; const juce::AudioBuffer<float>& full;
        bool spectral, spectrum;
        ~FinalOutput() { if (spectral) eq.processSpectral(audio, spectrum, full); eq.captureMatchOutput(audio); }
    } finalOutput{*this, buffer, fullBuffer, spectral, requestedSpectrum};
    const bool spectrumRequested = requestedSpectrum && !spectral;
    if (usesPreparedEQ() && linearPhase)
    {
        processLinearPhase(buffer, spectrumRequested, fullBuffer);
        return;
    }
    const float requestedPower =
        (powerEnabled.load(std::memory_order_acquire) && editorBypass.load(std::memory_order_relaxed) < 0.5f)
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
        && dryScratch.getNumSamples() >= numSamples
        && bandScratch.getNumSamples() >= numSamples;
    jassert(scratchIsReady);
    if (!scratchIsReady)
    {
        publishOutputPeaks(buffer);
        // prepareToPlay() must size this buffer. Returning the unchanged dry
        // signal is safer than allocating or making a hard transition here.
        return;
    }

    if (powerIsFullyDry)
    {
        publishOutputPeaks(buffer);
        if (spectrumRequested)
            captureSpectrumBlock(buffer, buffer, fullBuffer);
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
    std::array<std::array<bool, maxStagesPerBand>, maxBands>
        stageStillSmoothing {};
    bool anyStageStillSmoothing = false;
    bool individualPlacement=false;
    for (int b = 0; b < bandCount; ++b)
    {
        const int target=juce::jlimit(0,4,juce::roundToInt(bands[b].target.load()));
        auto& weights=targetWeights[static_cast<size_t>(b)];
        for(size_t i=0;i<5;++i) weights[i].setTargetValue(target==static_cast<int>(i)?1.0f:0.0f);
        individualPlacement=individualPlacement||(target!=0&&bands[b].enabled.load()>=.5f);
        const bool routeBand=!useMidSideMode&&numChannels>=2&&(target!=0||weights[0].isSmoothing()||weights[0].getCurrentValue()<1.0f);
        if(routeBand) for(int ch=0;ch<2;++ch) bandScratch.copyFrom(ch,0,buffer,ch,0,numSamples);
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
        if(routeBand)
        {
            for(int i=0;i<numSamples;++i)
            {
                std::array<float,5> mix {};for(size_t w=0;w<5;++w) mix[w]=weights[w].getNextValue();
                const auto out=BuiltInEQRouting::mix(bandScratch.getSample(0,i),bandScratch.getSample(1,i),buffer.getSample(0,i),buffer.getSample(1,i),mix);
                buffer.setSample(0,i,out[0]);buffer.setSample(1,i,out[1]);
            }
        }
        else for(auto& weight:weights) weight.skip(numSamples);
    }

    if (filtersNeedSmoothing)
    {
        filtersNeedSmoothing = anyStageStillSmoothing;
        for (int b = 0; b < bandCount; ++b)
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
    if (autoGain.load(std::memory_order_relaxed) >= 0.5f && (!individualPlacement || useMidSideMode))
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
    if (detectorListenMix.isSmoothing() || detectorListenMix.getCurrentValue() > 0)
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float listen = detectorListenMix.getNextValue();
            for (int channel = 0; channel < numChannels; ++channel)
                buffer.setSample(channel, sample, buffer.getSample(channel, sample) * (1 - listen) + detectorListenScratch.getSample(channel, sample));
        }
    draftPreview.process(buffer);
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
        captureSpectrumBlock(dryScratch, buffer, fullBuffer);

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
    publishOutputPeaks(buffer);
}

bool OpenStudioEQ::isSpectrumCaptureRequested(
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
        (*spectrumCaptureSlots)[
            static_cast<size_t>(spectrumCaptureSlot)]
            .state.store(0, std::memory_order_release);
        spectrumCaptureSlot = -1;
        spectrumCaptureWritePos = 0;
    }
    return false;
}

int OpenStudioEQ::claimSpectrumCaptureSlot() noexcept
{
    for (const int claimableState : { 0, 2 })
    {
        for (size_t slotIndex = 0;
             slotIndex < spectrumCaptureSlots->size();
             ++slotIndex)
        {
            int expected = claimableState;
            if ((*spectrumCaptureSlots)[slotIndex].state
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

void OpenStudioEQ::captureSpectrumBlock(const juce::AudioBuffer<float>& preEQ,
    const juce::AudioBuffer<float>& postEQ, const juce::AudioBuffer<float>& fullBuffer) noexcept
{
    const int numSamples=juce::jmin(preEQ.getNumSamples(),postEQ.getNumSamples());
    if(numSamples<=0||preEQ.getNumChannels()<=0||postEQ.getNumChannels()<=0)return;
    const int mainChannels = getMainBusNumInputChannels();
    const int keyChannels = supportsExternalKey() ? juce::jlimit(0, getBus(true, 1)->getNumberOfChannels(), fullBuffer.getNumChannels() - mainChannels) : 0;
    const std::array<const float*,6> sources{preEQ.getReadPointer(0),preEQ.getReadPointer(juce::jmin(1,preEQ.getNumChannels()-1)),postEQ.getReadPointer(0),postEQ.getReadPointer(juce::jmin(1,postEQ.getNumChannels()-1)),
        keyChannels > 0 ? fullBuffer.getReadPointer(mainChannels) : nullptr,
        keyChannels > 0 ? fullBuffer.getReadPointer(mainChannels + juce::jmin(1, keyChannels - 1)) : nullptr};
    int sourceOffset=0;
    while(sourceOffset<numSamples)
    {
        if(spectrumCaptureSlot<0)
        {
            spectrumCaptureSlot=claimSpectrumCaptureSlot();spectrumCaptureWritePos=0;
            if(spectrumCaptureSlot<0)return;
            (*spectrumCaptureSlots)[static_cast<size_t>(spectrumCaptureSlot)].length=requestedSpectrumSize.load(std::memory_order_relaxed);
        }
        auto& slot=(*spectrumCaptureSlots)[static_cast<size_t>(spectrumCaptureSlot)];
        const int copyCount=juce::jmin(numSamples-sourceOffset,slot.length-spectrumCaptureWritePos);
        for(size_t ch=0;ch<sources.size();++ch)
            if(sources[ch])juce::FloatVectorOperations::copy(slot.audio[ch].data()+spectrumCaptureWritePos,sources[ch]+sourceOffset,copyCount);
            else juce::FloatVectorOperations::clear(slot.audio[ch].data()+spectrumCaptureWritePos,copyCount);
        sourceOffset+=copyCount;spectrumCaptureWritePos+=copyCount;
        if(spectrumCaptureWritePos>=slot.length){slot.generation.store(++spectrumCaptureGeneration,std::memory_order_relaxed);slot.state.store(2,std::memory_order_release);spectrumCaptureSlot=-1;spectrumCaptureWritePos=0;}
    }
}

void OpenStudioEQ::computeSpectrum(const SpectrumCaptureSlot& slot,int source,SpectrumData& output)
{
    const int size=slot.length;
    auto& transform=size==1024?fft1024:(size==4096?fft4096:(size==8192?fft8192:fft2048));
    auto& windowing=size==1024?window1024:(size==4096?window4096:(size==8192?window8192:window2048));
    for(int stage=0;stage<(supportsExternalKey()?3:2);++stage)
    {
        auto& target=stage==0?output.preEQ:(stage==1?output.postEQ:output.externalKey);
        for(int channel=0;channel<(source==2?2:1);++channel)
        {
            std::array<float,maxSpectrumSize*2> scratch{};
            const int selected=stage*2+(source==2?channel:source);
            std::copy_n(slot.audio[static_cast<size_t>(selected)].begin(),size,scratch.begin());
            for(int sample=0;sample<size;++sample)if(!std::isfinite(scratch[static_cast<size_t>(sample)]))scratch[static_cast<size_t>(sample)]=0;
            windowing.multiplyWithWindowingTable(scratch.data(),size);transform.performFrequencyOnlyForwardTransform(scratch.data());
            for(int bin=0;bin<size/2;++bin)
            {
                const float scale=(bin==0?1.0f:2.0f)/static_cast<float>(size),amplitude=scratch[static_cast<size_t>(bin)]*scale;
                if(source==2)target[static_cast<size_t>(bin)]+=amplitude*amplitude*.5f;
                else target[static_cast<size_t>(bin)]=juce::Decibels::gainToDecibels(amplitude,-100.0f);
            }
        }
        if(source==2)for(int bin=0;bin<size/2;++bin)target[static_cast<size_t>(bin)]=juce::Decibels::gainToDecibels(std::sqrt(target[static_cast<size_t>(bin)]),-100.0f);
    }
    output.fftLength=size;output.source=source;output.ready=true;
}

OpenStudioEQ::SpectrumData OpenStudioEQ::getSpectrumData(int requestedSize,int source)
{
    if(const auto prepared=preparedMIDIView())return prepared->voices[static_cast<size_t>(prepared->displayed.load())].engine->getSpectrumData(requestedSize,source);
    const std::lock_guard<std::mutex> consumerLock(spectrumConsumerMutex);
    const int size=requestedSize==0?requestedSpectrumSize.load(std::memory_order_relaxed)
        :(requestedSize==1024||requestedSize==4096||requestedSize==8192?requestedSize:fftSize);
    source=juce::jlimit(0,2,source);requestedSpectrumSize.store(size,std::memory_order_relaxed);
    const auto epoch=spectrumResetEpoch.load(std::memory_order_acquire);
    if(spectrumObservedEpoch!=epoch){spectrumObservedEpoch=epoch;spectrumReadGeneration=0;lastSpectrumOutput={};}
    if(lastSpectrumOutput.fftLength!=size||lastSpectrumOutput.source!=source){lastSpectrumOutput={};lastSpectrumOutput.fftLength=size;lastSpectrumOutput.source=source;}
    const double sampleRate=publishedSampleRate.load(std::memory_order_acquire);
    spectrumDemandSamplesRemaining.store(static_cast<int>(juce::jmax(44100.0,sampleRate)),std::memory_order_release);
    int newestSlot=-1;juce::uint64 newestGeneration=spectrumReadGeneration;
    for(size_t slotIndex=0;slotIndex<spectrumCaptureSlots->size();++slotIndex)
    {
        const auto& slot=(*spectrumCaptureSlots)[slotIndex];if(slot.state.load(std::memory_order_acquire)!=2)continue;
        const auto generation=slot.generation.load(std::memory_order_relaxed);
        if(generation>newestGeneration){newestSlot=static_cast<int>(slotIndex);newestGeneration=generation;}
    }
    if(newestSlot>=0)
    {
        auto& slot=(*spectrumCaptureSlots)[static_cast<size_t>(newestSlot)];int expected=2;
        if(slot.state.compare_exchange_strong(expected,3,std::memory_order_acq_rel,std::memory_order_acquire))
        {
            // Producer can replace an unclaimed ready frame; use owned metadata.
            spectrumReadGeneration=slot.generation.load(std::memory_order_relaxed);
            if(slot.length==size){SpectrumData next;computeSpectrum(slot,source,next);lastSpectrumOutput=next;}
            slot.state.store(0,std::memory_order_release);
        }
    }
    if(spectrumResetEpoch.load(std::memory_order_acquire)!=epoch){lastSpectrumOutput={};lastSpectrumOutput.fftLength=size;lastSpectrumOutput.source=source;}
    return lastSpectrumOutput;
}

std::vector<float> OpenStudioEQ::getMagnitudeResponse(const std::vector<float>& frequencies) const
{
    if(const auto prepared=preparedMIDIView())return prepared->voices[static_cast<size_t>(prepared->displayed.load())].engine->getMagnitudeResponse(frequencies);
    if (usesPreparedEQ() && linearPhase)
    {
        return linearPhase->response(frequencies, juce::jlimit(-12.0f, 12.0f, outputGain.load()),
            getMainBusNumInputChannels() == 1 ? 0 : juce::roundToInt(stereoMode.load()));
    }

    std::vector<float> response(frequencies.size(), 0.0f);
    bool matrixResponse=false;
    for(int b=0;b<bandCount;++b) matrixResponse=matrixResponse||(bands[b].enabled.load()>=.5f&&bands[b].target.load()>=.5f);
    if(matrixResponse&&stereoMode.load()<.5f)
    {
        using namespace BuiltInEQRouting;
        std::vector<Matrix> transfer(frequencies.size(),Matrix{1,0,0,1});
        const double rate=publishedSampleRate.load(std::memory_order_acquire);
        const int audition=juce::jlimit(-1,bandCount-1,juce::roundToInt(auditionBand.load())-1);
        for(int b=0;b<bandCount;++b)
        {
            if(audition>=0?b!=audition:bands[b].enabled.load()<.5f) continue;
            std::array<OpenStudioIIRCoefficientSet,maxStagesPerBand> coefficients {};
            const int stages=buildBandTargets(b,true,coefficients),target=juce::jlimit(0,4,juce::roundToInt(bands[b].target.load()));
            for(size_t i=0;i<frequencies.size();++i)
            {
                const auto z=std::polar(1.0,-juce::MathConstants<double>::twoPi*juce::jlimit(0.0,rate*.499,static_cast<double>(frequencies[i]))/rate);
                Complex h=1;
                for(int stage=0;stage<stages;++stage) {const auto& c=coefficients[static_cast<size_t>(stage)];h*=(static_cast<double>(c[0])+static_cast<double>(c[1])*z+static_cast<double>(c[2])*z*z)/(1.0+static_cast<double>(c[3])*z+static_cast<double>(c[4])*z*z);}
                transfer[i]=multiply(band(h,target),transfer[i]);
            }
        }
        for(size_t i=0;i<frequencies.size();++i) response[i]=static_cast<float>(juce::Decibels::gainToDecibels(energy(transfer[i]),-100.0))+juce::jlimit(-12.0f,12.0f,outputGain.load());
        return response;
    }
    const int auditionIndex = juce::jlimit(-1, bandCount - 1,
                                           static_cast<int>(std::round(auditionBand.load(std::memory_order_relaxed))) - 1);
    for (int b = 0; b < bandCount; ++b)
    {
        if (auditionIndex >= 0 && b != auditionIndex) continue;
        if (auditionIndex < 0
            && bands[b].enabled.load(
                std::memory_order_relaxed) < 0.5f)
            continue;

        std::array<OpenStudioIIRCoefficientSet,
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

std::array<float,3> OpenStudioEQ::getBandDynamicControls(int bandIndex) const
{
    const auto& controls=effectiveDynamicControls[static_cast<size_t>(juce::jlimit(0,bandCount-1,bandIndex))];
    return {controls[0].load(std::memory_order_relaxed),controls[1].load(std::memory_order_relaxed),controls[2].load(std::memory_order_relaxed)};
}

float OpenStudioEQ::getBandDynamicGainDB(int bandIndex) const
{
    if(hasPreparedMIDIPrograms()&&bandIndex>=0&&bandIndex<bandCount)return dynamicGainDB[static_cast<size_t>(bandIndex)].load();
    if (bandIndex < 0 || bandIndex >= bandCount)
        return 0.0f;
    if (usesSpectralBand(bandIndex)) return spectralEQ->gainDb[static_cast<size_t>(bandIndex)].load(std::memory_order_relaxed);
    return dynamicGainDB[static_cast<size_t>(bandIndex)].load(std::memory_order_relaxed);
}

void OpenStudioEQ::getEQStateInformationRaw(juce::MemoryBlock& destData, const std::array<float, MIDIProgramBank::valueCount>& snapshot, const std::array<float, MIDIProgramBank::configurationCount>& configuration)
{
    std::unordered_map<const std::atomic<float>*, float> captured;
    captured.reserve(snapshot.size());
    size_t field = 0;
    visitMIDIProgramParameters([&](auto& parameter, float, float) { captured.emplace(&parameter, snapshot[field++]); });
    const auto read = [&](const std::atomic<float>& parameter) { return captured.at(&parameter); };
    juce::ValueTree state("OpenStudioEQ");
    if (linearPhase) { state.setProperty("phaseMode", configuration[0], nullptr); state.setProperty("phaseQuality", configuration[1], nullptr); state.setProperty("spectralProcessing", configuration[4], nullptr); state.setProperty("linearBandDynamics", configuration[5], nullptr); state.setProperty("minimumPhaseFIR", configuration[2], nullptr); state.setProperty("analogResponse", configuration[3], nullptr); }
    if (supportsExternalKey()) { state.setProperty("externalDetector", configuration[6], nullptr); state.setProperty("detectorListenBand", read(detectorListenBand), nullptr); }
    state.setProperty("outputGain", read(outputGain), nullptr);
    state.setProperty("autoGain", read(autoGain), nullptr);
    state.setProperty("editorBypass", read(editorBypass), nullptr);
    state.setProperty("auditionBand", read(auditionBand), nullptr);
    state.setProperty("stereoMode", read(stereoMode), nullptr);
    for (int i = 0; i < bandCount; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        state.setProperty(p + "target", read(bands[i].target), nullptr);
        state.setProperty(p + "enabled", read(bands[i].enabled), nullptr);
        state.setProperty(p + "type", read(bands[i].type), nullptr);
        state.setProperty(p + "freq", read(bands[i].freq), nullptr);
        state.setProperty(p + "gain", read(bands[i].gain), nullptr);
        state.setProperty(p + "q", read(bands[i].q), nullptr);
        state.setProperty(p + "slope", read(bands[i].slope), nullptr);
        state.setProperty(p + "dynamicEnabled", read(bands[i].dynamicEnabled), nullptr);
        state.setProperty(p + "dynamicThreshold", read(bands[i].dynamicThreshold), nullptr);
        state.setProperty(p + "dynamicRange", read(bands[i].dynamicRange), nullptr);
        state.setProperty(p + "dynamicAttack", read(bands[i].dynamicAttack), nullptr);
        state.setProperty(p + "dynamicRelease", read(bands[i].dynamicRelease), nullptr);
        if (supportsExternalKey())
        {
            state.setProperty(p + "detectorSource", read(bands[i].detectorSource), nullptr);
            state.setProperty(p + "detectorMode", read(bands[i].detectorMode), nullptr);
            state.setProperty(p + "detectorLowCut", read(bands[i].detectorLowCut), nullptr);
            state.setProperty(p + "detectorHighCut", read(bands[i].detectorHighCut), nullptr);
            state.setProperty(p + "allPass", read(bands[i].allPass), nullptr);
            state.setProperty(p + "gainQInteraction", read(bands[i].gainQInteraction), nullptr);
            state.setProperty(p+"spectralEnabled", read(bands[i].spectralEnabled), nullptr);
            state.setProperty(p+"spectralDensity", read(bands[i].spectralDensity), nullptr);
            state.setProperty(p+"spectralTilt", read(bands[i].spectralTilt), nullptr);
            state.setProperty(p+"dynamicThresholdMode",read(bands[i].dynamicThresholdMode),nullptr);state.setProperty(p+"dynamicTimingMode",read(bands[i].dynamicTimingMode),nullptr);state.setProperty(p+"dynamicSensitivity",read(bands[i].dynamicSensitivity),nullptr);
            state.setProperty(p + "cutMode", read(bands[i].cutMode), nullptr);
            state.setProperty(p + "continuousSlope", read(bands[i].continuousSlope), nullptr);
        }
    }
    saveMIDIPrograms(state);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void OpenStudioEQ::setStateInformation(const void* data, int sizeInBytes)
{
    draftPreview.reset(publishedSampleRate.load());
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "OpenStudioEQ") return;
    preparedMIDILatency.store(-1);
    externalDetector.store(supportsExternalKey() && static_cast<float>(state.getProperty("externalDetector", 0.0f)) >= .5f ? 1.0f : 0.0f);
    const auto finiteProperty = [&](const juce::Identifier& id, float fallback, float low, float high)
    {
        const float value = static_cast<float>(state.getProperty(id, fallback));
        return std::isfinite(value) ? juce::jlimit(low, high, value) : fallback;
    };
    detectorListenBand.store(supportsExternalKey() ? std::round(finiteProperty("detectorListenBand", 0, 0, static_cast<float>(bandCount))) : 0);

    outputGain.store(static_cast<float>(state.getProperty("outputGain", 0.0f)));
    autoGain.store(static_cast<float>(state.getProperty("autoGain", 0.0f)));
    editorBypass.store(static_cast<float>(state.getProperty("editorBypass", 0.0f)));
    auditionBand.store(static_cast<float>(state.getProperty("auditionBand", 0.0f)));
    stereoMode.store(static_cast<float>(state.getProperty("stereoMode", 0.0f)));
    for (int i = 0; i < bandCount; ++i)
    {
        juce::String p = "band" + juce::String(i) + "_";
        bands[i].target.store(juce::jlimit(0.0f,4.0f,static_cast<float>(state.getProperty(p + "target",0.0f))));
        bands[i].enabled.store(static_cast<float>(state.getProperty(p + "enabled", i < numBands ? 1.0f : 0.0f)));
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
        bands[i].detectorSource.store(supportsExternalKey() ? std::round(finiteProperty(p + "detectorSource", 0, 0, 2)) : 0);
        bands[i].detectorMode.store(supportsExternalKey() ? std::round(finiteProperty(p + "detectorMode", 0, 0, 1)) : 0);
        bands[i].detectorLowCut.store(finiteProperty(p + "detectorLowCut", 20, 20, 19000));
        bands[i].detectorHighCut.store(finiteProperty(p + "detectorHighCut", 20000, bands[i].detectorLowCut.load() * 1.05f, 20000));
        bands[i].gainQInteraction.store(supportsExternalKey() ? finiteProperty(p + "gainQInteraction", 0, 0, 1) : 0);
        bands[i].allPass.store(supportsExternalKey() ? finiteProperty(p + "allPass", 0, 0, 1) : 0);
        bands[i].dynamicThresholdMode.store(supportsExternalKey()?std::round(finiteProperty(p+"dynamicThresholdMode",0,0,1)):0);bands[i].dynamicTimingMode.store(supportsExternalKey()?std::round(finiteProperty(p+"dynamicTimingMode",0,0,1)):0);bands[i].dynamicSensitivity.store(supportsExternalKey()?finiteProperty(p+"dynamicSensitivity",0,-12,12):0);
        bands[i].spectralEnabled.store(supportsExternalKey() ? finiteProperty(p+"spectralEnabled",0,0,1) : 0);
        bands[i].spectralDensity.store(finiteProperty(p+"spectralDensity",.75f,0,1));
        bands[i].spectralTilt.store(finiteProperty(p+"spectralTilt",1,0,1));
        bands[i].cutMode.store(supportsExternalKey() ? std::round(finiteProperty(p + "cutMode", 0, 0, 2)) : 0);
        bands[i].continuousSlope.store(finiteProperty(p + "continuousSlope", 12, 3, 96));
    }
    setSpectralConfiguration(finiteProperty("spectralProcessing",0,0,1));
    setLinearDynamicsConfiguration(finiteProperty("linearBandDynamics",0,0,1));
    setMinimumPhaseFIR(finiteProperty("minimumPhaseFIR",0,0,1));
    setAnalogResponse(finiteProperty("analogResponse",0,0,1));
    const float mode = static_cast<float>(state.getProperty("phaseMode", 0.0f));
    const float quality = static_cast<float>(state.getProperty("phaseQuality", 1.0f));
    setPhaseConfiguration(std::isfinite(mode) ? mode : 0.0f, std::isfinite(quality) ? quality : 1.0f);
    restoreMIDIPrograms(state);
    // Ordinary parameter targets are consumed by processBlock(). A phase or
    // resolution change above is a serialized host configuration transaction.
}

#include "BuiltInEQPreparedPrograms.inc"
#include "BuiltInEQMIDIPrograms.inc"

//==============================================================================
//  OpenStudioCompressor -- Multi-style compressor
//==============================================================================

OpenStudioCompressor::OpenStudioCompressor(bool standalone) : OpenStudioBuiltInEffect(standalone), standaloneProcessing(standalone)
{
    model.store(standalone ? 1.0f : 0.0f);
    for (size_t bank = 0; bank < vcaControls.size(); ++bank)
        for (auto& channel : vcaControls[bank].channels)
            for (size_t field = 0; field < channel.size(); ++field) channel[field].store(BuiltInVCACompressor::spec(field, bank == 1).initial);
    initialiseModelBanks();
}

std::array<std::atomic<float>*, 12> OpenStudioCompressor::modelControls()
{
    return { &threshold, &ratio, &attack, &release, &knee, &style, &autoMakeup, &autoRelease, &sidechainHPF, &lookaheadMs, &detectorMode, &stereoLink };
}
void OpenStudioCompressor::initialiseModelBanks()
{
    const auto controls = modelControls();
    for (auto& bank : modelBanks) for (size_t i = 0; i < controls.size(); ++i) bank[i].store(controls[i]->load());
    constexpr float defaults[7][5] { {0, 1, 10, 100, 0}, {0, 1, 10, 100, 0}, {-18, 4, .1f, 120, 3},
        {-18, 4, 10, 300, 6}, {-18, 4, 5, 100, 4}, {-18, 2, 15, 180, 6}, {-18, 4, 1, 80, 0} };
    for (size_t bank = 0; bank < modelBanks.size(); ++bank)
        for (size_t i = 0; i < 5; ++i) modelBanks[bank][i].store(defaults[bank][i]);
}
void OpenStudioCompressor::selectModel(int next)
{
    next = juce::jlimit(0, 6, next);
    const int previous = juce::jlimit(0, 6, static_cast<int>(model.load()));
    if (next == previous || !standaloneProcessing) return;
    const auto controls = modelControls();
    for (size_t i = 0; i < controls.size(); ++i)
    {
        modelBanks[static_cast<size_t>(previous)][i].store(controls[i]->load());
        controls[i]->store(modelBanks[static_cast<size_t>(next)][i].load());
    }
    model.store(static_cast<float>(next));
}

float OpenStudioCompressor::computeGain(float inputDB,
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

void OpenStudioCompressor::getStyleBallistics(float& atkMs, float& relMs) const
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

void OpenStudioCompressor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    detectorKey.prepare(sampleRate, samplesPerBlock, supportsExternalKey() && externalDetector.load() >= .5f);
    cachedSampleRate = sampleRate;
    averageMeter.prepare(sampleRate);
    if (standaloneProcessing)
    {
        preparedCharacterBlockSize = samplesPerBlock;
        originalCharacterPrepared = audioCharacter.load() >= .5f;
        if (originalCharacterPrepared)
            originalColour.prepare(sampleRate, model.load() >= 2 && model.load() <= 6 ? static_cast<BuiltInOriginalColour::Profile>(juce::roundToInt(model.load()) - 1) : BuiltInOriginalColour::Clean);
        const int colourLatency = originalCharacterPrepared ? originalColour.latencySamples() : 0;
        // Fixed latency avoids moving the audio or changing host PDC while
        // lookahead is automated. Lookahead changes the detector's tap only.
        setLatencySamples(static_cast<int>(std::ceil(sampleRate * 0.020)) + colourLatency);
        alignedDelay.setSize(4, getLatencySamples() + 2);
        alignedDelay.clear();
        alignedPosition = 0;
        opticalMemory = 0.0f;
        fetProcessor.prepare(sampleRate);
        punchExtras.prepare(sampleRate);
        fetDetectorTilt.prepare(sampleRate, fetTilt.load() >= .5f);
        fetWeight.reset(sampleRate, .02);
        fetWeight.setCurrentAndTargetValue(model.load() == 2 && fetEngine.load() >= .5f ? 1.0f : 0.0f);
        for (size_t bank = 0; bank < opticalProcessors.size(); ++bank)
        {
            opticalProcessors[bank].prepare(sampleRate, bank == 1);
            opticalWeights[bank].reset(sampleRate, .02);
            opticalWeights[bank].setCurrentAndTargetValue(model.load() == static_cast<float>(bank + 3) && opticalControls[bank].engine.load() >= .5f ? 1.0f : 0.0f);
        }
        for (size_t bank = 0; bank < vcaProcessors.size(); ++bank)
        {
            vcaProcessors[bank].prepare(sampleRate, bank == 1, originalCharacterPrepared);
            vcaWeights[bank].reset(sampleRate, .02);
            vcaWeights[bank].setCurrentAndTargetValue(model.load() == static_cast<float>(bank + 5) && vcaControls[bank].engine.load() >= .5f ? 1.0f : 0.0f);
        }
        detectorDelay.reset(sampleRate, 0.020);
        const float nonlinearInputDelay = originalCharacterPrepared ? originalColour.inputDelaySamples() - static_cast<float>(colourLatency) : 0;
        detectorDelay.setCurrentAndTargetValue(static_cast<float>(getLatencySamples()) + nonlinearInputDelay
            - juce::jlimit(0.0f, 20.0f, lookaheadMs.load()) * static_cast<float>(sampleRate) * 0.001f);
        smoothedHeadroom.reset(sampleRate, .02);
        smoothedHeadroom.setCurrentAndTargetValue(originalCharacterPrepared && model.load() >= 2 ? juce::jlimit(-12.0f, 12.0f, headroom.load()) : 0.0f);
    }
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

void OpenStudioCompressor::releaseResources()
{
    reset();
}

void OpenStudioCompressor::reset()
{
    detectorKey.reset(supportsExternalKey() && externalDetector.load() >= .5f);
    averageMeter.reset();
    alignedDelay.clear();
    alignedPosition = 0;
    opticalMemory = 0.0f;
    activeStandaloneModel = -1;
    fetProcessor.reset();
    punchExtras.reset();
    originalColour.reset();
    if (originalCharacterPrepared)
    {
        smoothedHeadroom.setCurrentAndTargetValue(model.load() >= 2 ? juce::jlimit(-12.0f, 12.0f, headroom.load()) : 0.0f);
        detectorDelay.setCurrentAndTargetValue(static_cast<float>(getLatencySamples() - originalColour.latencySamples()) + originalColour.inputDelaySamples()
            - juce::jlimit(0.0f, 20.0f, lookaheadMs.load()) * static_cast<float>(cachedSampleRate) * .001f);
    }
    fetDetectorTilt.reset(fetTilt.load() >= .5f);
    if (standaloneProcessing) fetWeight.setCurrentAndTargetValue(model.load() == 2 && fetEngine.load() >= .5f ? 1.0f : 0.0f);
    if (standaloneProcessing) for (size_t bank = 0; bank < vcaProcessors.size(); ++bank)
    {
        vcaProcessors[bank].reset();
        vcaWeights[bank].setCurrentAndTargetValue(model.load() == static_cast<float>(bank + 5) && vcaControls[bank].engine.load() >= .5f ? 1.0f : 0.0f);
    }
    if (standaloneProcessing) for (size_t bank = 0; bank < opticalProcessors.size(); ++bank)
    {
        opticalProcessors[bank].reset();
        opticalWeights[bank].setCurrentAndTargetValue(model.load() == static_cast<float>(bank + 3) && opticalControls[bank].engine.load() >= .5f ? 1.0f : 0.0f);
    }
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
void OpenStudioCompressor::refreshCharacterConfiguration()
{
    // Host must serialize this with its publication/audio callback lease and
    // recalculate graph PDC afterwards; never called from processBlock().
    if (standaloneProcessing && preparedCharacterBlockSize > 0
        && originalCharacterPrepared != (audioCharacter.load() >= .5f))
        prepareToPlay(cachedSampleRate, preparedCharacterBlockSize);
}

void OpenStudioCompressor::processBlock(juce::AudioBuffer<float>& fullBuffer, juce::MidiBuffer& midi)
{
    captureDetectorKey(fullBuffer);
    const int mainChannels = juce::jmin(getMainBusNumInputChannels(), fullBuffer.getNumChannels());
    if (mainChannels <= 0) return;
    float* mainPointers[2] = { fullBuffer.getWritePointer(0), fullBuffer.getWritePointer(juce::jmin(1, mainChannels - 1)) };
    juce::AudioBuffer<float> buffer(mainPointers, juce::jmin(2, mainChannels), fullBuffer.getNumSamples());
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    if (standaloneProcessing)
    {
        averageMeter.measure(buffer,false);
        processStandaloneBlock(buffer);
        averageMeter.measure(buffer,true);
        return;
    }

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

void OpenStudioCompressor::processStandaloneBlock(juce::AudioBuffer<float>& buffer)
{
    const int channels = juce::jmin(2, buffer.getNumChannels());
    const int count = buffer.getNumSamples();
    if (channels == 0 || count == 0 || alignedDelay.getNumSamples() == 0) return;
    const float fs = static_cast<float>(cachedSampleRate);
    const int selected = juce::jlimit(0, 6, static_cast<int>(model.load()));
    const bool useOriginalColour = originalCharacterPrepared;
    const float colourLatency = useOriginalColour ? static_cast<float>(originalColour.latencySamples()) : 0.0f;
    const float colourInputDelay = useOriginalColour ? originalColour.inputDelaySamples() : 0.0f;
    smoothedHeadroom.setTargetValue(useOriginalColour && selected >= 2 ? juce::jlimit(-12.0f, 12.0f, headroom.load()) : 0.0f);
    if (useOriginalColour) originalColour.selectProfile(selected >= 2 && selected <= 6 ? static_cast<BuiltInOriginalColour::Profile>(selected - 1) : BuiltInOriginalColour::Clean);
    if (selected != activeStandaloneModel)
    {
        // Legacy follows linear level; current models follow dB reduction.
        // Never reinterpret one detector's units as the other's.
        if (selected == 0 || activeStandaloneModel <= 0) envelopeLevel = 0.0f;
        activeStandaloneModel = selected;
        opticalMemory = 0.0f;
        if (selected == 2) { fetProcessor.reset(); fetDetectorTilt.reset(fetTilt.load() >= .5f); } // Preserve the outgoing detector through its crossfade.
    }
    const bool useFet = selected == 2 && fetEngine.load() >= .5f;
    if (useFet && fetWeight.getTargetValue() == 0 && fetWeight.getCurrentValue() == 0) { fetProcessor.reset(); fetDetectorTilt.reset(fetTilt.load() >= .5f); }
    fetWeight.setTargetValue(useFet ? 1.0f : 0.0f);
    fetDetectorTilt.configure(fetTilt.load() >= .5f);
    fetProcessor.configure({ fetInput.load(), fetOutput.load(), fetRatio.load(), fetAttack.load(), fetRelease.load(), fetRecovery.load() });
    for (size_t bank = 0; bank < opticalProcessors.size(); ++bank)
    {
        const auto& controls = opticalControls[bank];
        auto& weight = opticalWeights[bank];
        const bool active = selected == static_cast<int>(bank + 3) && controls.engine.load() >= .5f;
        if (active && weight.getCurrentValue() == 0 && weight.getTargetValue() == 0) opticalProcessors[bank].reset();
        weight.setTargetValue(active ? 1.0f : 0.0f);
        opticalProcessors[bank].configure({ controls.reduction.load(), controls.gain.load(), controls.mode.load(), controls.emphasis.load() });
    }
    for (size_t bank = 0; bank < vcaProcessors.size(); ++bank)
    {
        const auto& controls = vcaControls[bank]; auto& weight = vcaWeights[bank];
        const bool active = selected == static_cast<int>(bank + 5) && controls.engine.load() >= .5f;
        if (active && weight.getCurrentValue() == 0 && weight.getTargetValue() == 0) vcaProcessors[bank].reset();
        weight.setTargetValue(active ? 1.0f : 0.0f);
        BuiltInVCACompressor::Settings settings; settings.routing = channels == 1 ? 0 : juce::roundToInt(controls.routing.load());
        for (size_t ch = 0; ch < 2; ++ch) for (size_t field = 0; field < BuiltInVCACompressor::Count; ++field) settings.channels[ch][field] = controls.channels[ch][field].load();
        vcaProcessors[bank].configure(settings);
    }
    punchExtras.configure(selected==6&&vcaControls[1].engine.load()>=.5f,punchNoiseLeft.load(),punchNoiseRight.load(),channels==1?0:juce::roundToInt(vcaControls[1].routing.load()),juce::roundToInt(punchHum.load()),channels==1?0:juce::roundToInt(punchMonitor.load()));
    float atk = juce::jlimit(0.1f, 100.0f, attack.load());
    float rel = juce::jlimit(10.0f, 2000.0f, release.load());
    if (selected == 0) getStyleBallistics(atk, rel);
    const float attackFactor = std::exp(-1.0f / (atk * 0.001f * fs));
    const float releaseFactor = std::exp(-1.0f / (rel * 0.001f * fs));
    const bool optical = selected == 3 || selected == 4;
    const float rmsFactor = std::exp(-1.0f / ((selected == 3 ? 0.025f : 0.008f) * fs));
    const float memoryFactor = std::exp(-1.0f / (fs * (selected == 3 ? 1.2f : 0.35f)));
    const float link = juce::jlimit(0.0f, 1.0f, stereoLink.load());
    const int detector = juce::jlimit(0, 2, static_cast<int>(detectorMode.load()));
    smoothedThresholdDb.setTargetValue(juce::jlimit(-60.0f, 0.0f, threshold.load()));
    smoothedCompressionSlope.setTargetValue(compressorSlopeFromRatio(ratio.load()));
    smoothedKneeDb.setTargetValue(juce::jlimit(0.0f, 24.0f, knee.load()));
    smoothedMix.setTargetValue(juce::jlimit(0.0f, 1.0f, mix.load()));
    const float makeup = autoMakeup.load() >= 0.5f
        ? juce::jlimit(0.0f, 18.0f, -threshold.load() * compressorSlopeFromRatio(ratio.load()) * 0.5f)
        : juce::jlimit(0.0f, 36.0f, makeupGain.load());
    smoothedMakeup.setTargetValue(juce::Decibels::decibelsToGain(makeup));
    detectorDelay.setTargetValue(static_cast<float>(getLatencySamples()) - colourLatency + colourInputDelay - juce::jlimit(0.0f, 20.0f, lookaheadMs.load()) * fs * 0.001f);
    const float scFrequency = juce::jlimit(20.0f, 500.0f, sidechainHPF.load());
    if (std::abs(scFrequency - lastSCHPFFreq) > 0.1f)
    {
        lastSCHPFFreq = scFrequency;
        targetSCHPFCoefficients = lookupRealtimeFilterLut(scHPFCoefficientLut, cachedSampleRate, scFrequency, 20.0f, 500.0f);
        scHPFCoefficientsSmoothing = true;
    }
    float inPeak = 0.0f, outPeak = 0.0f, reduction = 0.0f;
    const int length = alignedDelay.getNumSamples();
    const auto read = [&](int channel, float delay)
    {
        const int whole = static_cast<int>(delay);
        const float fraction = delay - static_cast<float>(whole);
        const int p = (alignedPosition - whole + length) % length;
        return alignedDelay.getSample(channel, p) * (1.0f - fraction)
            + alignedDelay.getSample(channel, (p + length - 1) % length) * fraction;
    };
    for (int i = 0; i < count; ++i)
    {
        for (int ch = 0; ch < channels; ++ch)
        {
            const float input = buffer.getSample(ch, i);
            alignedDelay.setSample(ch, alignedPosition, std::isfinite(input) ? input : 0.0f);
            inPeak = juce::jmax(inPeak, std::abs(input));
        }
        for (int ch = 0; ch < 2; ++ch) alignedDelay.setSample(ch + 2, alignedPosition, detectorKey.sample(ch, i));
        if (scHPFCoefficientsSmoothing)
            scHPFCoefficientsSmoothing = advanceRealtimeFilterCoefficients(scHPF_L, scHPF_R, targetSCHPFCoefficients, scHPFCoefficientSmoothingProportion);
        const float tap = detectorDelay.getNextValue();
        const float headroomDb = smoothedHeadroom.getNextValue();
        const float headroomGain = useOriginalColour ? juce::Decibels::decibelsToGain(-headroomDb) : 1.0f;
        const float rawLeft = useOriginalColour ? read(2, tap) * headroomGain : read(2, tap);
        const float rawRight = useOriginalColour ? read(3, tap) * headroomGain : read(3, tap);
        const float left = scHPF_L.processSample(rawLeft);
        const float right = channels == 2 ? scHPF_R.processSample(rawRight) : left;
        const float peak = (std::abs(left) + std::abs(right)) * 0.5f * (1.0f - link)
            + juce::jmax(std::abs(left), std::abs(right)) * link;
        const float power = (left * left + right * right) * 0.5f;
        rmsEnvelopeLevel = rmsFactor * rmsEnvelopeLevel + (1.0f - rmsFactor) * power;
        const float rms = std::sqrt(juce::jmax(0.0f, rmsEnvelopeLevel));
        // Optical cells integrate energy. Bus VCA uses RMS; FET and punch VCA
        // follow peaks. Clean/legacy keep the user's explicit detector choice.
        const float level = optical || selected == 5 ? rms : selected == 2 || selected == 6 ? peak
            : detector == 1 ? rms : detector == 2 ? juce::jmax(rms, peak * 0.72f) : peak;
        const float th = smoothedThresholdDb.getNextValue();
        const float slope = smoothedCompressionSlope.getNextValue();
        const float kneeWidth = smoothedKneeDb.getNextValue();
        float inputDb = juce::Decibels::gainToDecibels(level, -100.0f);
        if (selected == 0)
        {
            const float coefficient = level > envelopeLevel ? attackFactor : releaseFactor;
            envelopeLevel = coefficient * envelopeLevel + (1.0f - coefficient) * level;
            inputDb = juce::Decibels::gainToDecibels(envelopeLevel, -100.0f);
        }
        const float targetReduction = inputDb - computeGain(inputDb, th, slope, kneeWidth);
        opticalMemory = memoryFactor * opticalMemory + (1.0f - memoryFactor) * targetReduction;
        const float programScale = optical ? 1.0f + opticalMemory * (selected == 3 ? 0.22f : 0.08f)
            : autoRelease.load() >= 0.5f ? 1.0f + envelopeLevel / 12.0f : 1.0f;
        if (selected != 0)
        {
            const float coefficient = targetReduction > envelopeLevel ? attackFactor
                : std::pow(releaseFactor, 1.0f / juce::jlimit(1.0f, 6.0f, programScale));
            envelopeLevel = coefficient * envelopeLevel + (1.0f - coefficient) * targetReduction;
        }
        float gr = selected == 0 ? targetReduction : envelopeLevel;
        const float fetBlend = fetWeight.getNextValue();
        float fetGain = 1;
        if (fetBlend > 0 || fetWeight.getTargetValue() > 0)
        {
            const auto tilted = fetDetectorTilt.process(left, right);
            const float fetPeak = (std::abs(tilted[0]) + std::abs(tilted[1])) * .5f * (1 - link)
                + juce::jmax(std::abs(tilted[0]), std::abs(tilted[1])) * link;
            fetGain = static_cast<float>(fetProcessor.process(fetPeak));
        }
        const float legacyGain = juce::Decibels::decibelsToGain(-gr) * smoothedMakeup.getNextValue();
        if (fetBlend > 0) gr += (static_cast<float>(fetProcessor.gainReduction()) - gr) * fetBlend;
        float gain = fetBlend == 0 ? legacyGain : fetBlend == 1 ? fetGain : legacyGain + (fetGain - legacyGain) * fetBlend;
        float opticalGain = 0, opticalReduction = 0, opticalWeight = 0;
        for (size_t bank = 0; bank < opticalProcessors.size(); ++bank)
        {
            const float weight = opticalWeights[bank].getNextValue();
            if (weight > 0 || opticalWeights[bank].getTargetValue() > 0)
            {
                opticalGain += weight * static_cast<float>(opticalProcessors[bank].process(rawLeft, rawRight, link));
                opticalReduction += weight * static_cast<float>(opticalProcessors[bank].gainReduction());
                opticalWeight += weight;
            }
        }
        if (opticalWeight > 0)
        {
            const float scale = juce::jmax(1.0f, opticalWeight), legacyWeight = juce::jmax(0.0f, 1 - opticalWeight);
            gain = gain * legacyWeight + opticalGain / scale;
            gr = gr * legacyWeight + opticalReduction / scale;
        }
        const float dryLeft = read(0, static_cast<float>(getLatencySamples()) - colourLatency);
        const float dryRight = channels == 2 ? read(1, static_cast<float>(getLatencySamples()) - colourLatency) : dryLeft;
        std::array<float, 2> vcaAudio {}; float vcaWeight = 0, vcaReduction = 0;
        for (size_t bank = 0; bank < vcaProcessors.size(); ++bank)
        {
            const float weight = vcaWeights[bank].getNextValue();
            if (weight > 0 || vcaWeights[bank].getTargetValue() > 0)
            {
                const auto audio = vcaProcessors[bank].process(dryLeft, dryRight, rawLeft, rawRight, headroomGain);
                for (size_t ch = 0; ch < 2; ++ch) vcaAudio[ch] += weight * audio[ch];
                vcaWeight += weight; vcaReduction += weight * static_cast<float>(vcaProcessors[bank].gainReduction());
            }
        }
        const float vcaScale = juce::jmax(1.0f, vcaWeight), priorWeight = juce::jmax(0.0f, 1 - vcaWeight);
        if (vcaWeight > 0) gr = gr * priorWeight + vcaReduction / vcaScale;
        reduction = juce::jmax(reduction, gr);
        const float wet = smoothedMix.getNextValue();
        const auto noise=punchExtras.noise();std::array<float,2> mixed {};
        std::array<float, 2> colouredAudio {};
        if (useOriginalColour)
        {
            const double inputFactor = selected == 2 && fetBlend > 0 ? fetProcessor.consumedInputGain() : 1;
            const double outputFactor = selected == 2 && fetBlend > 0 ? fetProcessor.consumedOutputGain()
                : selected >= 3 && selected <= 4 && opticalWeight > 0 ? opticalProcessors[static_cast<size_t>(selected - 3)].consumedOutputGain() : 1;
            const double reductionFactor = gain / (inputFactor * outputFactor);
            colouredAudio = originalColour.process({ dryLeft, dryRight },
                { inputFactor, inputFactor }, { reductionFactor, reductionFactor }, { outputFactor, outputFactor }, headroomGain);
        }
        for (int ch = 0; ch < channels; ++ch)
        {
            const float dry = read(ch, static_cast<float>(getLatencySamples()));
            const float shaped = useOriginalColour ? colouredAudio[static_cast<size_t>(ch)] : dry * gain;
            const float processed = vcaWeight == 0 ? shaped : shaped * priorWeight + vcaAudio[static_cast<size_t>(ch)] / vcaScale;
            mixed[static_cast<size_t>(ch)] = dry * (1.0f - wet) + boundProcessedWetSample(noise[static_cast<size_t>(ch)]==0?processed:processed+noise[static_cast<size_t>(ch)]) * wet;
        }
        const auto monitored=punchExtras.listen(mixed[0],channels==2?mixed[1]:mixed[0]);
        for(int ch=0;ch<channels;++ch){const float output=monitored[static_cast<size_t>(ch)];buffer.setSample(ch,i,output);outPeak=juce::jmax(outPeak,std::abs(output));}
        alignedPosition = (alignedPosition + 1) % length;
    }
    gainReductionDB.store(-reduction);
    inputLevelDB.store(juce::Decibels::gainToDecibels(inPeak, -100.0f));
    outputLevelDB.store(juce::Decibels::gainToDecibels(outPeak, -100.0f));
    clearNonFiniteBuiltInBuffer(buffer);
}

void OpenStudioCompressor::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("OpenStudioCompressor");
    if (supportsExternalKey()) state.setProperty("externalDetector", externalDetector.load(), nullptr);
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
    if (standaloneProcessing)
    {
        state.setProperty("model", model.load(), nullptr);
        if (audioCharacter.load() != 0) state.setProperty("audioCharacter", audioCharacter.load(), nullptr);
        if (headroom.load() != 0) state.setProperty("headroom", headroom.load(), nullptr);
        state.setProperty("meterMode",meterMode.load(),nullptr);state.setProperty("meterReference",meterReference.load(),nullptr);state.setProperty("meterChannel",meterChannel.load(),nullptr);
        state.setProperty("fetEngine", fetEngine.load(), nullptr);
        state.setProperty("fetInput", fetInput.load(), nullptr); state.setProperty("fetOutput", fetOutput.load(), nullptr);
        state.setProperty("fetTilt", fetTilt.load(), nullptr);
        state.setProperty("punchNoiseLeft",punchNoiseLeft.load(),nullptr);state.setProperty("punchNoiseRight",punchNoiseRight.load(),nullptr);state.setProperty("punchHum",punchHum.load(),nullptr);state.setProperty("punchMonitor",punchMonitor.load(),nullptr);
        state.setProperty("fetRatio", fetRatio.load(), nullptr); state.setProperty("fetAttack", fetAttack.load(), nullptr);
        state.setProperty("fetRelease", fetRelease.load(), nullptr); state.setProperty("fetRecovery", fetRecovery.load(), nullptr);
        for (size_t bank = 0; bank < opticalControls.size(); ++bank)
        {
            const juce::String prefix = bank == 0 ? "tubeOpto" : "solidOpto";
            const auto& controls = opticalControls[bank];
            state.setProperty(prefix + "Engine", controls.engine.load(), nullptr);
            state.setProperty(prefix + "Reduction", controls.reduction.load(), nullptr);
            state.setProperty(prefix + "Gain", controls.gain.load(), nullptr);
            state.setProperty(prefix + "Mode", controls.mode.load(), nullptr);
            state.setProperty(prefix + "Emphasis", controls.emphasis.load(), nullptr);
        }
        for (size_t bank = 0; bank < vcaControls.size(); ++bank)
        {
            const juce::String prefix = bank == 0 ? "busVca" : "punchVca";
            state.setProperty(prefix + "Engine", vcaControls[bank].engine.load(), nullptr);
            state.setProperty(prefix + "Routing", vcaControls[bank].routing.load(), nullptr);
            for (size_t ch = 0; ch < 2; ++ch) for (size_t field = 0; field < BuiltInVCACompressor::Count; ++field)
                if (BuiltInVCACompressor::applicable(field, bank == 1))
                    state.setProperty(prefix + juce::String(static_cast<int>(ch)) + BuiltInVCACompressor::spec(field, bank == 1).id, vcaControls[bank].channels[ch][field].load(), nullptr);
        }
        const auto controls = modelControls();
        for (size_t bank = 0; bank < modelBanks.size(); ++bank)
            for (size_t i = 0; i < controls.size(); ++i)
                state.setProperty("modelBank" + juce::String(static_cast<int>(bank)) + "_" + juce::String(static_cast<int>(i)),
                    static_cast<int>(model.load()) == static_cast<int>(bank) ? controls[i]->load() : modelBanks[bank][i].load(), nullptr);
    }
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void OpenStudioCompressor::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "OpenStudioCompressor") return;
    externalDetector.store(supportsExternalKey() && static_cast<float>(state.getProperty("externalDetector", 0.0f)) >= .5f ? 1.0f : 0.0f);

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
    model.store(juce::jlimit(0.0f, 6.0f, static_cast<float>(state.getProperty("model", 0.0f))));
    if (standaloneProcessing)
    {
        initialiseModelBanks();
        const auto restoreFet = [&state](const char* id, std::atomic<float>& target, float lo, float hi, float fallback) {
            const float value = static_cast<float>(state.getProperty(id, fallback)); target.store(std::isfinite(value) ? juce::jlimit(lo, hi, value) : fallback);
        };
        restoreFet("audioCharacter", audioCharacter, 0, 1, 0); audioCharacter.store(audioCharacter.load() >= .5f ? 1.0f : 0.0f);
        restoreFet("headroom", headroom, -12, 12, 0);
        restoreFet("meterMode",meterMode,0,2,0);meterMode.store(std::round(meterMode.load()));
        restoreFet("meterReference",meterReference,-24,-6,-18);restoreFet("meterChannel",meterChannel,0,2,0);meterChannel.store(std::round(meterChannel.load()));
        restoreFet("fetEngine", fetEngine, 0, 1, 0);
        restoreFet("punchNoiseLeft",punchNoiseLeft,0,1,0);restoreFet("punchNoiseRight",punchNoiseRight,0,1,0);restoreFet("punchHum",punchHum,0,1,0);restoreFet("punchMonitor",punchMonitor,0,3,0);punchHum.store(std::round(punchHum.load()));punchMonitor.store(std::round(punchMonitor.load()));
        restoreFet("fetInput", fetInput, -24, 36, 0); restoreFet("fetOutput", fetOutput, -36, 24, 0);
        restoreFet("fetTilt", fetTilt, 0, 1, 0); fetTilt.store(fetTilt.load() >= .5f ? 1.0f : 0.0f);
        restoreFet("fetRatio", fetRatio, 0, 10, 0); fetRatio.store(std::round(fetRatio.load()));
        restoreFet("fetAttack", fetAttack, .02f, .8f, .1f); restoreFet("fetRelease", fetRelease, 50, 1100, 120);
        restoreFet("fetRecovery", fetRecovery, 0, 1, .25f);
        for (size_t bank = 0; bank < opticalControls.size(); ++bank)
        {
            const juce::String prefix = bank == 0 ? "tubeOpto" : "solidOpto";
            auto& controls = opticalControls[bank];
            restoreFet((prefix + "Engine").toRawUTF8(), controls.engine, 0, 1, 0);
            restoreFet((prefix + "Reduction").toRawUTF8(), controls.reduction, 0, 100, 45);
            restoreFet((prefix + "Gain").toRawUTF8(), controls.gain, 0, 40, 0);
            restoreFet((prefix + "Mode").toRawUTF8(), controls.mode, 0, 1, 0);
            controls.engine.store(std::round(controls.engine.load())); controls.mode.store(std::round(controls.mode.load()));
            restoreFet((prefix + "Emphasis").toRawUTF8(), controls.emphasis, 0, 1, 0);
        }
        for (size_t bank = 0; bank < vcaControls.size(); ++bank)
        {
            const juce::String prefix = bank == 0 ? "busVca" : "punchVca"; auto& controls = vcaControls[bank];
            restoreFet((prefix + "Engine").toRawUTF8(), controls.engine, 0, 1, 0);
            restoreFet((prefix + "Routing").toRawUTF8(), controls.routing, 0, 2, 0);
            controls.engine.store(std::round(controls.engine.load())); controls.routing.store(std::round(controls.routing.load()));
            for (size_t ch = 0; ch < 2; ++ch) for (size_t field = 0; field < BuiltInVCACompressor::Count; ++field)
            {
                const auto range = BuiltInVCACompressor::spec(field, bank == 1);
                restoreFet((prefix + juce::String(static_cast<int>(ch)) + range.id).toRawUTF8(), controls.channels[ch][field], range.min, range.max, range.initial);
                if (range.toggle) controls.channels[ch][field].store(std::round(controls.channels[ch][field].load()));
            }
        }
        constexpr float minima[] { -60, 1, .01f, 10, 0, 0, 0, 0, 0, 0, 0, 0 };
        constexpr float maxima[] { 0, 20, 100, 2000, 24, 4, 1, 1, 500, 20, 2, 1 };
        for (size_t bank = 0; bank < modelBanks.size(); ++bank)
            for (size_t i = 0; i < modelBanks[bank].size(); ++i)
            {
                const float saved = static_cast<float>(state.getProperty("modelBank" + juce::String(static_cast<int>(bank)) + "_" + juce::String(static_cast<int>(i)), modelBanks[bank][i].load()));
                if (std::isfinite(saved)) modelBanks[bank][i].store(juce::jlimit(minima[i], maxima[i], saved));
            }
        refreshCharacterConfiguration();
    }
}

//==============================================================================
//  OpenStudioGate -- Noise gate with hysteresis and sidechain filter
//==============================================================================

OpenStudioGate::OpenStudioGate(bool standalone) : OpenStudioBuiltInEffect(standalone)
{
    rateIndependentDetector.store(standalone ? 1.0f : 0.0f);
    transientResponse.store(standalone ? 1.0f : 0.0f);
}

void OpenStudioGate::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    detectorKey.prepare(sampleRate, samplesPerBlock, supportsExternalKey() && externalDetector.load() >= .5f);
    cachedSampleRate = sampleRate;
    lastSidechainHPF = -1.0f;
    lastSidechainLPF = -1.0f;

    auto hpfCoeffs =
        juce::dsp::IIR::Coefficients<float>::makeHighPass(
            sampleRate,
            juce::jlimit(
                20.0f, safeFilterMaximum(sampleRate, 20.0f, 2000.0f),
                sidechainHPF.load(std::memory_order_relaxed)));
    scHPF_L.coefficients = hpfCoeffs;  scHPF_R.coefficients = hpfCoeffs;

    auto lpfCoeffs =
        juce::dsp::IIR::Coefficients<float>::makeLowPass(
            sampleRate,
            juce::jlimit(
                200.0f, safeFilterMaximum(sampleRate, 200.0f, 20000.0f),
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
    for(auto* smooth:{&expansionBlend,&listenBlend,&smoothedExpansionRatio,&smoothedExpansionKnee})smooth->reset(sampleRate,.020);
    reset();
}

void OpenStudioGate::releaseResources()
{
    reset();
}

void OpenStudioGate::reset()
{
    detectorKey.reset(supportsExternalKey() && externalDetector.load() >= .5f);
    expansionBlend.setCurrentAndTargetValue(expansionMode.load()>=.5f?1.0f:0.0f);
    listenBlend.setCurrentAndTargetValue(detectorListen.load()>=.5f?1.0f:0.0f);
    smoothedExpansionRatio.setCurrentAndTargetValue(juce::jlimit(1.0f,10.0f,expansionRatio.load()));
    smoothedExpansionKnee.setCurrentAndTargetValue(juce::jlimit(0.0f,12.0f,expansionKnee.load()));
    detectorLevelDb.store(-100);envelopeStage.store(0);
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

void OpenStudioGate::updateCoefficients(bool forceImmediate)
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

float OpenStudioGate::expansionGainDb(float relativeDb,float ratio,float knee,float minimumDb) noexcept
{
    const float slope=juce::jlimit(1.0f,10.0f,ratio)-1;float gain=0;
    knee=juce::jlimit(0.0f,12.0f,knee);
    if(relativeDb< -knee*.5f)gain=slope*relativeDb;
    else if(knee>0&&relativeDb<knee*.5f){const float distance=relativeDb-knee*.5f;gain=-slope*distance*distance/(2*knee);}
    return juce::jlimit(juce::jlimit(-80.0f,0.0f,minimumDb),0.0f,gain);
}

void OpenStudioGate::processBlock(juce::AudioBuffer<float>& fullBuffer, juce::MidiBuffer& midi)
{
    captureDetectorKey(fullBuffer);
    const int mainChannels = juce::jmin(getMainBusNumInputChannels(), fullBuffer.getNumChannels());
    if (mainChannels <= 0) return;
    float* mainPointers[2] = { fullBuffer.getWritePointer(0), fullBuffer.getWritePointer(juce::jmin(1, mainChannels - 1)) };
    juce::AudioBuffer<float> buffer(mainPointers, juce::jmin(2, mainChannels), fullBuffer.getNumSamples());
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

    // Preserve historical states/NAM; new standalone instances retain the
    // original 44.1 kHz time constants at every device sample rate.
    const bool rateIndependent = rateIndependentDetector.load() >= 0.5f;
    const float rateScale = 44100.0f / static_cast<float>(cachedSampleRate);
    // The onset option belongs to Gate. Expansion retains its calibrated
    // continuous detector law, including when a saved Gate response is Transient.
    const bool transient = supportsExternalKey() && transientResponse.load() >= .5f
        && expansionMode.load() < .5f;
    // In Transient mode Attack controls the gain envelope without a hidden
    // 45 ms peak-detector rise. RMS retains its explicit 18 ms integration.
    const float envAttack = transient ? 0.0f : rateIndependent ? std::pow(0.9995f, rateScale) : 0.9995f;
    const float envRelease = transient ? std::exp(-1.0f / (.002f * static_cast<float>(cachedSampleRate)))
        : rateIndependent ? std::pow(0.9999f, rateScale) : 0.9999f;
    const float rmsCoeff = std::exp(-1.0f / (0.018f * static_cast<float>(juce::jmax(1.0, cachedSampleRate))));
    const int detector = juce::jlimit(0, 2, static_cast<int>(std::round(detectorMode.load(std::memory_order_relaxed))));
    float peakGR = 0.0f;
    expansionBlend.setTargetValue(expansionMode.load()>=.5f?1.0f:0.0f);
    listenBlend.setTargetValue(detectorListen.load()>=.5f?1.0f:0.0f);
    smoothedExpansionRatio.setTargetValue(juce::jlimit(1.0f,10.0f,expansionRatio.load()));
    smoothedExpansionKnee.setTargetValue(juce::jlimit(0.0f,12.0f,expansionKnee.load()));
    const float thresholdDb=juce::jlimit(-80.0f,0.0f,threshold.load()),rangeDb=juce::jlimit(-80.0f,0.0f,range.load());
    int stage=0;


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

        std::array<float,2> detectorAudio{};
        float peakLevel = 0.0f;
        float rmsSum = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float s = detectorKey.sample(ch, i);
            s = (ch == 0) ? scLPF_L.processSample(scHPF_L.processSample(s))
                          : scLPF_R.processSample(scHPF_R.processSample(s));
            if(ch<2)detectorAudio[static_cast<size_t>(ch)]=s;
            peakLevel = juce::jmax(peakLevel, std::abs(s));
            rmsSum += s * s;
        }
        rmsEnvelopeLevel = rmsCoeff * rmsEnvelopeLevel
                         + (1.0f - rmsCoeff) * (rmsSum / static_cast<float>(juce::jmax(1, numChannels)));
        const float rmsLevel = std::sqrt(juce::jmax(0.0f, rmsEnvelopeLevel));
        const float inputLevel = detector == 1
            ? rmsLevel
            : (detector == 2 ? juce::jmax(rmsLevel, peakLevel * (transient ? 1.0f : 0.7f)) : peakLevel);

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

        const float expansion=expansionBlend.getNextValue(),ratio=smoothedExpansionRatio.getNextValue(),knee=smoothedExpansionKnee.getNextValue();
        if(expansion>0){const float expanded=juce::Decibels::decibelsToGain(expansionGainDb(juce::Decibels::gainToDecibels(envelopeLevel,-160.0f)-thresholdDb,ratio,knee,rangeDb));targetGain+=expansion*(expanded-targetGain);}
        stage=expansion>=.5f?5:gateOpen.load()?(envelopeLevel<closeThresholdLinear&&holdCounter>0?3:currentGain<.999f?1:2):currentGain>rangeGain+.001f?4:0;

        if (targetGain > currentGain)
            currentGain = attackCoeff * currentGain + (1.0f - attackCoeff) * targetGain;
        else
            currentGain = releaseCoeff * currentGain + (1.0f - releaseCoeff) * targetGain;

        peakGR = juce::jmin(peakGR, juce::Decibels::gainToDecibels(currentGain, -100.0f));

        const float mixWet = smoothedMix.getNextValue();
        const float mixDry = 1.0f - mixWet;
        const float listen=listenBlend.getNextValue();
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const float dry = buffer.getSample(ch, i);
            const float wet =
                boundProcessedWetSample(
                    dry * currentGain);
            buffer.setSample(
                ch,
                i,
                listen<=0 ? dry * mixDry + wet * mixWet : (dry * mixDry + wet * mixWet)*(1-listen)+detectorAudio[static_cast<size_t>(juce::jmin(ch,1))]*listen);
        }
    }
    clearNonFiniteBuiltInBuffer(buffer);
    gainReductionDB.store(peakGR);
    detectorLevelDb.store(juce::Decibels::gainToDecibels(envelopeLevel,-100.0f));envelopeStage.store(stage);
}

void OpenStudioGate::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("OpenStudioGate");
    if (supportsExternalKey()) state.setProperty("externalDetector", externalDetector.load(), nullptr);
    state.setProperty("expansionMode",expansionMode.load(),nullptr);state.setProperty("expansionRatio",expansionRatio.load(),nullptr);state.setProperty("expansionKnee",expansionKnee.load(),nullptr);state.setProperty("detectorListen",detectorListen.load(),nullptr);
    state.setProperty("rateIndependentDetector", rateIndependentDetector.load(), nullptr);
    state.setProperty("transientResponse", transientResponse.load(), nullptr);
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

void OpenStudioGate::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "OpenStudioGate") return;
    externalDetector.store(supportsExternalKey() && static_cast<float>(state.getProperty("externalDetector", 0.0f)) >= .5f ? 1.0f : 0.0f);
    const auto restore=[&](const char* id,std::atomic<float>& target,float lo,float hi,float fallback){const float value=static_cast<float>(state.getProperty(id,fallback));target.store(std::isfinite(value)?juce::jlimit(lo,hi,value):fallback);};
    restore("expansionMode",expansionMode,0,1,0);restore("expansionRatio",expansionRatio,1,10,2);restore("expansionKnee",expansionKnee,0,12,6);restore("detectorListen",detectorListen,0,1,0);
    rateIndependentDetector.store(static_cast<float>(state.getProperty("rateIndependentDetector", 0.0f)));
    restore("transientResponse", transientResponse, 0, 1, 0);

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
//  OpenStudioLimiter -- Brickwall limiter with ceiling
//==============================================================================

OpenStudioLimiter::OpenStudioLimiter(bool standalone) : standaloneProcessing(standalone)
{
    continuousGain.store(standalone ? 1.0f : 0.0f);
    truePeak.store(standalone ? 1.0f : 0.0f);
}

void OpenStudioLimiter::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    preparedBlockSize = juce::jmax(1, samplesPerBlock);
    processingSampleRate = sampleRate; oversamplingFactor = 1;
    int resamplerLatency = 0;
    if (standaloneProcessing)
    {
        const int stages = juce::jlimit(0,5,juce::roundToInt(oversampleQuality.load()));
        qualityOversampler.reset();
        if (stages > 0)
        {
            qualityOversampler = std::make_unique<juce::dsp::Oversampling<float>>(2);
            qualityOversampler->clearOversamplingStages();
            for (int stage = 0; stage < stages; ++stage)
                qualityOversampler->addOversamplingStage(juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
                    .1f * (stage == 0 ? .5f : 1.0f), -90.0f,
                    .12f * (stage == 0 ? .5f : 1.0f), -90.0f);
            qualityOversampler->setUsingIntegerLatency(true);
            qualityOversampler->initProcessing(static_cast<size_t>(preparedBlockSize));
            oversamplingFactor = static_cast<int>(qualityOversampler->getOversamplingFactor());
            resamplerLatency = juce::roundToInt(qualityOversampler->getLatencyInSamples());
        }
        processingSampleRate = sampleRate * oversamplingFactor;
        processingLatency = static_cast<int>(std::ceil(sampleRate * .020)) * oversamplingFactor;
    }
    if (standaloneProcessing)
    {
        outputMeter.prepare(sampleRate, samplesPerBlock);
        unityBlend.reset(processingSampleRate, .020);
        unityBlend.setCurrentAndTargetValue(unityAudition.load() >= .5f ? 1.0f : 0.0f);
        setLatencySamples(processingLatency / oversamplingFactor + resamplerLatency + (qualityOversampler ? BuiltInLimiterOutputGuard::latency : 0));
        outputGuard.prepare(sampleRate, ceiling.load());
        const auto window = static_cast<size_t>(processingLatency + BuiltInPeakReconstruction::taps + 1);
        reconstructionPeaks.resize(window);
        reconstructionTimes.resize(window);
        responseEnvelope.prepare(processingSampleRate,window);
        detectorDelay.reset(processingSampleRate, 0.020);
        detectorDelay.setCurrentAndTargetValue(static_cast<float>(processingLatency)
            - juce::jlimit(0.0f, 20.0f, lookaheadMs.load()) * static_cast<float>(processingSampleRate) * 0.001f);
    }
    cachedSampleRate = sampleRate;
    juce::dsp::ProcessSpec spec { sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2u };

    limiter.prepare(spec);
    limiter.setThreshold(threshold.load());
    limiter.setRelease(juce::jmax(10.0f, releaseMs.load()));

    smoothedThresholdGain.reset(processingSampleRate, 0.02);
    smoothedThresholdGain.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -20.0f, 0.0f,
                threshold.load(std::memory_order_relaxed))));
    smoothedCeiling.reset(processingSampleRate, 0.02);
    smoothedCeiling.setCurrentAndTargetValue(
        juce::Decibels::decibelsToGain(
            juce::jlimit(
                -3.0f, 0.0f,
                ceiling.load(std::memory_order_relaxed))));
    smoothedLookaheadMorph.reset(sampleRate, 0.02);
    smoothedLookaheadMorph.setCurrentAndTargetValue(0.0f);

    const int maxLookaheadSamples = (standaloneProcessing ? processingLatency : static_cast<int>(std::ceil(sampleRate * .02))) + preparedBlockSize * oversamplingFactor + 8;
    lookaheadBuffer.setSize(2, juce::jmax(16, maxLookaheadSamples), false, false, true);

    if (!standaloneProcessing)
    {
        oversampler = std::make_unique<juce::dsp::Oversampling<float>>(
            2, 2, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, false);
        oversampler->initProcessing(static_cast<size_t>(preparedBlockSize));
    }
    qualityPrepared = true;
    reset();
}

bool OpenStudioLimiter::setQualityConfiguration(float quality)
{
    if (!standaloneProcessing || !std::isfinite(quality)) return false;
    const float next = static_cast<float>(juce::jlimit(0,5,juce::roundToInt(quality)));
    if (next == oversampleQuality.load()) return true;
    oversampleQuality.store(next);
    // The host serializes this non-automatable configuration and updates PDC.
    if (qualityPrepared) prepareToPlay(cachedSampleRate, preparedBlockSize);
    return true;
}

void OpenStudioLimiter::releaseResources()
{
    reset(); qualityPrepared = false;
}

void OpenStudioLimiter::reset()
{
    if (qualityOversampler) qualityOversampler->reset();
    outputGuard.reset(ceiling.load());
    unityBlend.setCurrentAndTargetValue(unityAudition.load() >= .5f ? 1.0f : 0.0f);
    if (standaloneProcessing) outputMeter.reset();
    responseEnvelope.reset();
    peakHoldSamples = 0;
    peakReconstruction.reset();
    reconstructionGain = 1.0f;
    reconstructionHead = reconstructionCount = 0;
    reconstructionClock = 0;
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

void OpenStudioLimiter::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused(midi);
    juce::ScopedNoDenormals noDenormals;
    if (standaloneProcessing)
    {
        if (qualityOversampler) processQualityBlock(buffer);
        else { processStandaloneBlock(buffer); outputMeter.process(buffer); }
        return;
    }

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

void OpenStudioLimiter::processStandaloneBlock(juce::AudioBuffer<float>& buffer)
{
    const int channels = juce::jmin(2, buffer.getNumChannels());
    const int length = lookaheadBuffer.getNumSamples();
    if (length == 0 || channels == 0) return;
    const float fs = static_cast<float>(processingSampleRate);
    const float ahead = juce::jlimit(0.0f, 20.0f, lookaheadMs.load()) * fs * 0.001f;
    detectorDelay.setTargetValue(static_cast<float>(processingLatency) - ahead);
    smoothedThresholdGain.setTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(-20.0f, 0.0f, threshold.load())));
    smoothedCeiling.setTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(-3.0f, 0.0f, ceiling.load())));
    const float release = std::exp(-1.0f / (juce::jlimit(10.0f, 500.0f, releaseMs.load()) * fs * 0.001f));
    responseEnvelope.configure(juce::roundToInt(limitingStyle.load()), releaseMs.load(), slowAttackMs.load(), automaticRelease.load()>=.5f, transientLink.load(), releaseLink.load());
    unityBlend.setTargetValue(unityAudition.load() >= .5f ? 1.0f : 0.0f);
    float minimumGain = 1.0f;
    for (int i = 0; i < buffer.getNumSamples(); ++i)
    {
        for (int ch = 0; ch < channels; ++ch)
        {
            const float sample = buffer.getSample(ch, i);
            lookaheadBuffer.setSample(ch, lookaheadWriteIndex, std::isfinite(sample) ? sample : 0.0f);
        }
        const auto channelPeaks = oversamplingFactor > 1
            ? std::array<float,2>{std::abs(lookaheadBuffer.getSample(0,lookaheadWriteIndex)),std::abs(lookaheadBuffer.getSample(channels-1,lookaheadWriteIndex))}
            : peakReconstruction.pushChannels(lookaheadBuffer.getSample(0,lookaheadWriteIndex),lookaheadBuffer.getSample(channels-1,lookaheadWriteIndex));
        const float reconstructedPeak=juce::jmax(channelPeaks[0],channelPeaks[1]);
        const float delay = detectorDelay.getNextValue();
        const int whole = static_cast<int>(delay);
        const float fraction = delay - static_cast<float>(whole);
        const int detectorIndex = (lookaheadWriteIndex - whole + length) % length;
        const int audioIndex = (lookaheadWriteIndex - processingLatency + length) % length;
        float peak = 0.0f, outputPeak = 0.0f;
        std::array<float,2> detectorPeaks{};
        for (int ch = 0; ch < channels; ++ch)
        {
            const float detectorSample = lookaheadBuffer.getSample(ch, detectorIndex) * (1.0f - fraction)
                + lookaheadBuffer.getSample(ch, (detectorIndex + length - 1) % length) * fraction;
            detectorPeaks[static_cast<size_t>(ch)]=std::abs(detectorSample);
            peak = juce::jmax(peak, std::abs(detectorSample));
            outputPeak = juce::jmax(outputPeak, std::abs(lookaheadBuffer.getSample(ch, audioIndex)));
        }
        const float ceilingGain = smoothedCeiling.getNextValue();
        const float thresholdGain = juce::jmin(ceilingGain, smoothedThresholdGain.getNextValue());
        const float requested = juce::jmin(1.0f, thresholdGain / juce::jmax(1.0e-9f, peak));
        if (requested <= gainEnvelope)
        {
            gainEnvelope = requested;
            peakHoldSamples = static_cast<int>(std::ceil(static_cast<float>(processingLatency) - delay));
        }
        else if (peakHoldSamples > 0) --peakHoldSamples;
        else gainEnvelope = release * gainEnvelope + (1.0f - release) * requested;
        const float drive = continuousGain.load() >= 0.5f || gainEnvelope < 0.9999f ? ceilingGain / juce::jmax(1.0e-9f, thresholdGain) : 1.0f;
        // Independent reconstructed-peak safety envelope spans the fixed latency
        // plus the FIR support. Keeping gain through the entire peak prevents a
        // one-sample detector hit from releasing before the delayed audio arrives.
        // 0.5 dB reserve covers phase sampling and gain-modulation reconstruction.
        // Monotonic queue: every peak remains protective until its complete
        // reconstruction support has passed the output, even behind a larger
        // preceding peak. A simple retriggered hold cannot provide this.
        const size_t capacity = reconstructionPeaks.size();
        while (reconstructionCount > 0 && reconstructionTimes[reconstructionHead] + capacity - 1 <= reconstructionClock)
        {
            reconstructionHead = (reconstructionHead + 1) % capacity;
            --reconstructionCount;
        }
        while (reconstructionCount > 0 && reconstructionPeaks[(reconstructionHead + reconstructionCount - 1) % capacity] <= reconstructedPeak)
            --reconstructionCount;
        const size_t tail = (reconstructionHead + reconstructionCount) % capacity;
        reconstructionPeaks[tail] = reconstructedPeak;
        reconstructionTimes[tail] = reconstructionClock++;
        ++reconstructionCount;
        const float safetyTarget = juce::jmin(1.0f, thresholdGain * 0.9440609f
            / juce::jmax(1.0e-9f, reconstructionPeaks[reconstructionHead]));
        if (safetyTarget <= reconstructionGain) reconstructionGain = safetyTarget;
        else reconstructionGain = release * reconstructionGain + (1.0f - release) * safetyTarget;
        const float protectedGain = truePeak.load() >= 0.5f ? juce::jmin(gainEnvelope, reconstructionGain) : gainEnvelope;
        const float gain = juce::jmin(protectedGain, ceilingGain / juce::jmax(1.0e-9f, outputPeak * drive));
        if(channels==1)detectorPeaks[1]=detectorPeaks[0];
        const auto responseGains=responseEnvelope.process(detectorPeaks,channelPeaks,thresholdGain,static_cast<int>(std::ceil(static_cast<float>(processingLatency)-delay)),truePeak.load()>=.5f);
        const float blend=responseEnvelope.nextBlend();
        const float responseDrive=continuousGain.load()>=.5f?ceilingGain/juce::jmax(1.0e-9f,thresholdGain):1.0f;
        const float audition = unityBlend.getNextValue();
        for (int ch = 0; ch < channels; ++ch)
        {
            const float sample=lookaheadBuffer.getSample(ch,audioIndex);
            const float responseGain=juce::jmin(responseGains[static_cast<size_t>(ch)],ceilingGain/juce::jmax(1.0e-9f,std::abs(sample)*responseDrive));
            const float oldOutput=sample*gain*(drive+audition*(1.0f-drive));
            const float responseOutput=sample*responseGain*(responseDrive+audition*(1.0f-responseDrive));
            buffer.setSample(ch,i,blend==0?oldOutput:juce::jlimit(-ceilingGain,ceilingGain,oldOutput+blend*(responseOutput-oldOutput)));
            minimumGain=juce::jmin(minimumGain,gain+blend*(responseGain-gain));
        }
        lookaheadWriteIndex = (lookaheadWriteIndex + 1) % length;
    }
    gainReductionDB.store(juce::Decibels::gainToDecibels(minimumGain, -100.0f));
}

void OpenStudioLimiter::processQualityBlock(juce::AudioBuffer<float>& buffer)
{
    const int channels = juce::jmin(2,buffer.getNumChannels());
    if (channels <= 0 || preparedBlockSize <= 0) return;
    float minimumDb = 0;
    for (int start = 0; start < buffer.getNumSamples(); start += preparedBlockSize)
    {
        const int count = juce::jmin(preparedBlockSize,buffer.getNumSamples()-start);
        float* pointers[2] {buffer.getWritePointer(0,start),buffer.getWritePointer(channels>1?1:0,start)};
        juce::AudioBuffer<float> segment(pointers,channels,count);
        for (int channel=0;channel<channels;++channel) for (int sample=0;sample<count;++sample)
            if (!std::isfinite(segment.getSample(channel,sample))) segment.setSample(channel,sample,0);
        juce::dsp::AudioBlock<float> block(segment);
        auto highRate = qualityOversampler->processSamplesUp(block);
        float* highPointers[2] {highRate.getChannelPointer(0),highRate.getChannelPointer(channels>1?1:0)};
        juce::AudioBuffer<float> highBuffer(highPointers,channels,static_cast<int>(highRate.getNumSamples()));
        processStandaloneBlock(highBuffer);
        qualityOversampler->processSamplesDown(block);
        const float guard = outputGuard.process(segment,ceiling.load(),truePeak.load()>=.5f);
        minimumDb = juce::jmin(minimumDb,gainReductionDB.load()+juce::Decibels::gainToDecibels(guard,-100.0f));
        outputMeter.process(segment);
    }
    gainReductionDB.store(minimumDb);
}

void OpenStudioLimiter::getStateInformation(juce::MemoryBlock& destData)
{
    juce::ValueTree state("OpenStudioLimiter");
    if (standaloneProcessing)
    {
        state.setProperty("oversampleQuality",oversampleQuality.load(),nullptr);
        state.setProperty("linkedEdits",linkedEdits.load(),nullptr);
        state.setProperty("unityAudition",unityAudition.load(),nullptr);
        state.setProperty("limitingStyle",limitingStyle.load(),nullptr);
        state.setProperty("slowAttack",slowAttackMs.load(),nullptr);
        state.setProperty("automaticRelease",automaticRelease.load(),nullptr);
        state.setProperty("transientLink",transientLink.load(),nullptr);
        state.setProperty("releaseLink",releaseLink.load(),nullptr);
        state.setProperty("continuousGain", continuousGain.load(), nullptr);
        state.setProperty("truePeak", truePeak.load(), nullptr);
    }
    state.setProperty("threshold", threshold.load(), nullptr);
    state.setProperty("release", releaseMs.load(), nullptr);
    state.setProperty("ceiling", ceiling.load(), nullptr);
    state.setProperty("lookahead", lookaheadMs.load(), nullptr);
    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void OpenStudioLimiter::setStateInformation(const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, static_cast<size_t>(sizeInBytes));
    if (!state.isValid() || state.getType().toString() != "OpenStudioLimiter") return;
    const auto read = [&state] (const char* id, float fallback, float minimum, float maximum)
    {
        const float value = static_cast<float>(state.getProperty(id, fallback));
        return std::isfinite(value) ? juce::jlimit(minimum, maximum, value) : fallback;
    };
    linkedEdits.store(read("linkedEdits",0,0,1));unityAudition.store(read("unityAudition",0,0,1));
    limitingStyle.store(read("limitingStyle",0,0,7));slowAttackMs.store(read("slowAttack",20,1,200));
    automaticRelease.store(read("automaticRelease",0,0,1));transientLink.store(read("transientLink",1,0,1));releaseLink.store(read("releaseLink",1,0,1));
    continuousGain.store(read("continuousGain", 0, 0, 1));
    truePeak.store(read("truePeak", 0, 0, 1));
    threshold.store(read("threshold", -1, -20, 0));
    releaseMs.store(read("release", 100, 10, 500));
    ceiling.store(read("ceiling", 0, -3, 0));
    lookaheadMs.store(read("lookahead", 5, 0, 20));
    if (standaloneProcessing) setQualityConfiguration(read("oversampleQuality",0,0,5));
}

#include "BuiltInEQDraft.inc"
