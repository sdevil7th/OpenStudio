/*
    NAMPolyOctaver: stereo multirate ERB phase-scaling octave generator.

    The constant-ERB complex-filter layout, octave phase-scaling equations,
    6:1 multirate topology, FIR coefficients, and fast square-root method are
    adapted from:

      terrarium-poly-octave
      Copyright (c) 2024 Steven Schulteis
      https://github.com/schult/terrarium-poly-octave

    That implementation follows the ERB-PS2 method described by Etienne
    Thuillier in "Real-Time Polyphonic Octave Doubling for the Guitar"
    (Aalto University, 2016). OpenStudio's implementation adds stereo state,
    sample-rate-aware ERB coefficients, arbitrary host-block partitioning,
    finite recovery, atomic parameters, and deterministic test access. It
    does not depend on the Daisy, Q, or GCEM libraries used by the firmware.

    MIT License

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the "Software"),
    to deal in the Software without restriction, including without limitation
    the rights to use, copy, modify, merge, publish, distribute, sublicense,
    and/or sell copies of the Software, and to permit persons to whom the
    Software is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
    DEALINGS IN THE SOFTWARE.
*/

#include "NAMPolyOctaver.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace
{
constexpr float nominalDecimatorPassbandHz = 1800.0f;
constexpr float nominalInterpolatorStopbandHz = 4400.0f;

float sanitiseLevel(float value, float fallback) noexcept
{
    if (! std::isfinite(value))
        return fallback;
    return juce::jlimit(0.0f, 1.25f, value);
}

float maximumAbsoluteDifference(const std::vector<float>& left,
                                const std::vector<float>& right) noexcept
{
    const std::size_t count = juce::jmin(left.size(), right.size());
    float maximum = left.size() == right.size()
        ? 0.0f
        : std::numeric_limits<float>::infinity();
    for (std::size_t index = 0; index < count; ++index)
        maximum = juce::jmax(maximum, std::abs(left[index] - right[index]));
    return maximum;
}

float maximumAbsoluteValue(const std::vector<float>& values) noexcept
{
    float maximum = 0.0f;
    for (const float value : values)
        maximum = juce::jmax(maximum, std::abs(value));
    return maximum;
}

double vectorRms(const std::vector<float>& values,
                 std::size_t begin) noexcept
{
    if (begin >= values.size())
        return 0.0;
    double sumSquares = 0.0;
    for (std::size_t index = begin; index < values.size(); ++index)
    {
        const double value = static_cast<double>(values[index]);
        sumSquares += value * value;
    }
    return std::sqrt(sumSquares
        / static_cast<double>(values.size() - begin));
}

double toneMagnitude(const std::vector<float>& values,
                     std::size_t begin,
                     double sampleRate,
                     double frequency) noexcept
{
    if (begin >= values.size()
        || frequency <= 0.0
        || frequency >= sampleRate * 0.5)
    {
        return 0.0;
    }

    double real = 0.0;
    double imaginary = 0.0;
    const double angularFrequency = 2.0 * juce::MathConstants<double>::pi
        * frequency / sampleRate;
    for (std::size_t index = begin; index < values.size(); ++index)
    {
        const double phase = angularFrequency
            * static_cast<double>(index - begin);
        const double value = static_cast<double>(values[index]);
        real += value * std::cos(phase);
        imaginary -= value * std::sin(phase);
    }
    return 2.0 * std::sqrt(real * real + imaginary * imaginary)
        / static_cast<double>(values.size() - begin);
}

float ratioToDecibels(double numerator, double denominator) noexcept
{
    constexpr double floor = 1.0e-15;
    return static_cast<float>(20.0 * std::log10(
        juce::jmax(floor, numerator) / juce::jmax(floor, denominator)));
}
}

NAMPolyOctaver::NAMPolyOctaver() noexcept
{
    smoothedDirectLevel.setCurrentAndTargetValue(1.0f);
    smoothedOctaveDownLevel.setCurrentAndTargetValue(0.0f);
    smoothedOctaveUpLevel.setCurrentAndTargetValue(0.0f);
    for (auto& profile : smoothedBassProfile)
        profile.setCurrentAndTargetValue(0.0f);
}

float NAMPolyOctaver::DecimatorState::stageOne() const noexcept
{
    return
        0.000066177472224418f * (fullRate.atAge(11) + fullRate.atAge(31))
        + 0.0009613901552378511f * (fullRate.atAge(12) + fullRate.atAge(30))
        + 0.003835090815380887f * (fullRate.atAge(13) + fullRate.atAge(29))
        + 0.010496532623165526f * (fullRate.atAge(14) + fullRate.atAge(28))
        + 0.02272703591356282f * (fullRate.atAge(15) + fullRate.atAge(27))
        + 0.041464390530886956f * (fullRate.atAge(16) + fullRate.atAge(26))
        + 0.06591039391505207f * (fullRate.atAge(17) + fullRate.atAge(25))
        + 0.09309984953947406f * (fullRate.atAge(18) + fullRate.atAge(24))
        + 0.11829177835273737f * (fullRate.atAge(19) + fullRate.atAge(23))
        + 0.13620590247679107f * (fullRate.atAge(20) + fullRate.atAge(22))
        + 0.14270010010002276f * fullRate.atAge(21);
}

float NAMPolyOctaver::DecimatorState::stageTwo() const noexcept
{
    return
        -0.00299995f * (oneThirdRate.atAge(1) + oneThirdRate.atAge(15))
        + 0.01858487f * (oneThirdRate.atAge(3) + oneThirdRate.atAge(13))
        - 0.06984829f * (oneThirdRate.atAge(5) + oneThirdRate.atAge(11))
        + 0.30421664f * (oneThirdRate.atAge(7) + oneThirdRate.atAge(9))
        + 0.5f * oneThirdRate.atAge(8);
}

float NAMPolyOctaver::DecimatorState::process(
    const std::array<float, resampleFactor>& input) noexcept
{
    fullRate.push(input[0]);
    fullRate.push(input[1]);
    fullRate.push(input[2]);
    oneThirdRate.push(stageOne());

    fullRate.push(input[3]);
    fullRate.push(input[4]);
    fullRate.push(input[5]);
    oneThirdRate.push(stageOne());

    return stageTwo();
}

void NAMPolyOctaver::DecimatorState::reset() noexcept
{
    fullRate.clear();
    oneThirdRate.clear();
}

float NAMPolyOctaver::InterpolatorState::stageOneEven() const noexcept
{
    return
        -0.0028536199247471473f
            * (reducedRate.atAge(7) + reducedRate.atAge(31))
        - 0.040326725115203695f
            * (reducedRate.atAge(8) + reducedRate.atAge(30))
        - 0.036134596458820015f
            * (reducedRate.atAge(9) + reducedRate.atAge(29))
        + 0.033522051189265496f
            * (reducedRate.atAge(10) + reducedRate.atAge(28))
        - 0.031442224275585025f
            * (reducedRate.atAge(11) + reducedRate.atAge(27))
        + 0.03258337681750486f
            * (reducedRate.atAge(12) + reducedRate.atAge(26))
        - 0.03538414864961937f
            * (reducedRate.atAge(13) + reducedRate.atAge(25))
        + 0.038811868988079715f
            * (reducedRate.atAge(14) + reducedRate.atAge(24))
        - 0.042204493894155204f
            * (reducedRate.atAge(15) + reducedRate.atAge(23))
        + 0.045128824129776035f
            * (reducedRate.atAge(16) + reducedRate.atAge(22))
        - 0.04736995557907843f
            * (reducedRate.atAge(17) + reducedRate.atAge(21))
        + 0.048831901671617876f
            * (reducedRate.atAge(18) + reducedRate.atAge(20))
        + 0.9507771467941135f * reducedRate.atAge(19);
}

float NAMPolyOctaver::InterpolatorState::stageOneOdd() const noexcept
{
    return
        -0.015961858776449508f
            * (reducedRate.atAge(7) + reducedRate.atAge(30))
        - 0.056128740058266235f
            * (reducedRate.atAge(8) + reducedRate.atAge(29))
        + 0.011026026040094625f
            * (reducedRate.atAge(9) + reducedRate.atAge(28))
        + 0.003198795994721635f
            * (reducedRate.atAge(10) + reducedRate.atAge(27))
        - 0.01108582057161854f
            * (reducedRate.atAge(11) + reducedRate.atAge(26))
        + 0.01951384497860086f
            * (reducedRate.atAge(12) + reducedRate.atAge(25))
        - 0.030860282826182514f
            * (reducedRate.atAge(13) + reducedRate.atAge(24))
        + 0.04707993944078406f
            * (reducedRate.atAge(14) + reducedRate.atAge(23))
        - 0.07155908583004919f
            * (reducedRate.atAge(15) + reducedRate.atAge(22))
        + 0.1129220770668398f
            * (reducedRate.atAge(16) + reducedRate.atAge(21))
        - 0.2033122562119347f
            * (reducedRate.atAge(17) + reducedRate.atAge(20))
        + 0.6336728217960803f
            * (reducedRate.atAge(18) + reducedRate.atAge(19));
}

float NAMPolyOctaver::InterpolatorState::stageTwoPhaseZero() const noexcept
{
    return
        0.00036440608905813593f * oneThirdRate.atAge(5)
        + 0.0005821260464558225f * oneThirdRate.atAge(6)
        - 0.043244023722481956f * oneThirdRate.atAge(7)
        - 0.10310036386076359f * oneThirdRate.atAge(8)
        + 0.13604229993913602f * oneThirdRate.atAge(9)
        + 0.5503466630244301f * oneThirdRate.atAge(10)
        + 0.4407091552750118f * oneThirdRate.atAge(11)
        + 0.009420000864297772f * oneThirdRate.atAge(12)
        - 0.09801301258361905f * oneThirdRate.atAge(13)
        - 0.019627176246818184f * oneThirdRate.atAge(14)
        + 0.001762424830497545f * oneThirdRate.atAge(15);
}

float NAMPolyOctaver::InterpolatorState::stageTwoPhaseOne() const noexcept
{
    return
        0.001112114188613258f
            * (oneThirdRate.atAge(5) + oneThirdRate.atAge(15))
        - 0.005449383064836152f
            * (oneThirdRate.atAge(6) + oneThirdRate.atAge(14))
        - 0.07276547446584428f
            * (oneThirdRate.atAge(7) + oneThirdRate.atAge(13))
        - 0.0709695783332148f
            * (oneThirdRate.atAge(8) + oneThirdRate.atAge(12))
        + 0.2904591843823435f
            * (oneThirdRate.atAge(9) + oneThirdRate.atAge(11))
        + 0.590541634315722f * oneThirdRate.atAge(10);
}

float NAMPolyOctaver::InterpolatorState::stageTwoPhaseTwo() const noexcept
{
    return
        0.001762424830497545f * oneThirdRate.atAge(5)
        - 0.019627176246818184f * oneThirdRate.atAge(6)
        - 0.09801301258361905f * oneThirdRate.atAge(7)
        + 0.009420000864297772f * oneThirdRate.atAge(8)
        + 0.4407091552750118f * oneThirdRate.atAge(9)
        + 0.5503466630244301f * oneThirdRate.atAge(10)
        + 0.13604229993913602f * oneThirdRate.atAge(11)
        - 0.10310036386076359f * oneThirdRate.atAge(12)
        - 0.043244023722481956f * oneThirdRate.atAge(13)
        + 0.0005821260464558225f * oneThirdRate.atAge(14)
        + 0.00036440608905813593f * oneThirdRate.atAge(15);
}

void NAMPolyOctaver::InterpolatorState::process(
    float input,
    std::array<float, resampleFactor>& output) noexcept
{
    reducedRate.push(input);

    oneThirdRate.push(stageOneEven());
    output[0] = stageTwoPhaseZero();
    output[1] = stageTwoPhaseOne();
    output[2] = stageTwoPhaseTwo();

    oneThirdRate.push(stageOneOdd());
    output[3] = stageTwoPhaseZero();
    output[4] = stageTwoPhaseOne();
    output[5] = stageTwoPhaseTwo();
}

void NAMPolyOctaver::InterpolatorState::reset() noexcept
{
    reducedRate.clear();
    oneThirdRate.clear();
}

void NAMPolyOctaver::ChannelRateState::reset() noexcept
{
    decimator.reset();
    downInterpolator.reset();
    upInterpolator.reset();
    pendingInput.fill(0.0f);
    pendingDownOutput.fill(0.0f);
    pendingUpOutput.fill(0.0f);
    phase = 0;
    downInterpolatorActive = false;
    upInterpolatorActive = false;
    octaveDownDcInput = 0.0f;
    octaveDownDcOutput = 0.0f;
}

float NAMPolyOctaver::bandCentreHz(int erbIndex) noexcept
{
    return 480.0f * std::pow(2.0f, 0.027f * static_cast<float>(erbIndex))
        - 420.0f;
}

float NAMPolyOctaver::bandBandwidthHz(int erbIndex) noexcept
{
    const float previous = bandCentreHz(erbIndex - 1);
    const float current = bandCentreHz(erbIndex);
    const float next = bandCentreHz(erbIndex + 1);
    const float lowerSpacing = juce::jmax(0.001f, current - previous);
    const float upperSpacing = juce::jmax(0.001f, next - current);
    return 2.0f * lowerSpacing * upperSpacing
        / (lowerSpacing + upperSpacing);
}

float NAMPolyOctaver::fastInverseSqrt(float value) noexcept
{
    static_assert(std::numeric_limits<float>::is_iec559,
                  "Fast inverse square root requires IEEE-754 float");
    if (! std::isfinite(value) || value <= phaseEnergyFloor)
        return 0.0f;

    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    bits = 0x5F1FFFF9U - (bits >> 1U);
    float estimate = 0.0f;
    std::memcpy(&estimate, &bits, sizeof(estimate));
    return estimate * (0.703952253f
        * (2.38924456f - value * estimate * estimate));
}

float NAMPolyOctaver::fastSqrt(float value) noexcept
{
    return value > phaseEnergyFloor
        ? value * fastInverseSqrt(value)
        : 0.0f;
}

NAMPolyOctaver::ComplexValue NAMPolyOctaver::multiply(
    ComplexValue left,
    ComplexValue right) noexcept
{
    return {
        left.real * right.real - left.imag * right.imag,
        left.real * right.imag + left.imag * right.real
    };
}

void NAMPolyOctaver::prepare(double sampleRate, int maximumBlockSize) noexcept
{
    prepared.store(false, std::memory_order_release);

    const double safeSampleRate = sampleRate > 1000.0
        ? sampleRate
        : 44100.0;
    diagnosticSampleRate.store(
        static_cast<float>(safeSampleRate), std::memory_order_relaxed);
    diagnosticMaximumBlockSize.store(
        juce::jmax(1, maximumBlockSize), std::memory_order_relaxed);

    designFilterBank(safeSampleRate);
    octaveDownHighPassCoefficient = std::exp(
        -juce::MathConstants<float>::twoPi * 18.0f
        / static_cast<float>(safeSampleRate));

    smoothedDirectLevel.reset(safeSampleRate, levelRampSeconds);
    smoothedOctaveDownLevel.reset(safeSampleRate, levelRampSeconds);
    smoothedOctaveUpLevel.reset(safeSampleRate, levelRampSeconds);
    for (auto& profile : smoothedBassProfile)
    {
        profile.reset(
            safeSampleRate / static_cast<double>(resampleFactor),
            levelRampSeconds);
        profile.setCurrentAndTargetValue(
            requestedInstrumentProfile.load(
                std::memory_order_relaxed) == 1
                ? 1.0f
                : 0.0f);
    }
    smoothedDirectLevel.setCurrentAndTargetValue(
        requestedDirectLevel.load(std::memory_order_relaxed));
    smoothedOctaveDownLevel.setCurrentAndTargetValue(
        requestedOctaveDownLevel.load(std::memory_order_relaxed));
    smoothedOctaveUpLevel.setCurrentAndTargetValue(
        requestedOctaveUpLevel.load(std::memory_order_relaxed));

    resetDspState();
    resetDiagnostics();
    prepared.store(true, std::memory_order_release);
}

void NAMPolyOctaver::designFilterBank(double sampleRate) noexcept
{
    bands.fill(BandCoefficients {});
    activeBandCount = 0;
    octaveUpBandCount = 0;

    const double reducedSampleRate = juce::jmax(
        1000.0, sampleRate / static_cast<double>(resampleFactor));
    const double pi = juce::MathConstants<double>::pi;
    const double squareRootTwo = std::sqrt(2.0);

    for (int band = 0; band < maximumBands; ++band)
    {
        // Array indices 0..3 are the Bass-only B0/E1 extension. Indices
        // 4..83 retain the original Guitar ERB indices 0..79 exactly.
        const int erbIndex = band - bassExtendedBandCount;
        const float centre = bandCentreHz(erbIndex);
        if (! std::isfinite(centre)
            || centre <= 0.0f
            || centre >= static_cast<float>(reducedSampleRate * 0.46))
        {
            break;
        }

        const float bandwidth = juce::jmax(
            1.0f, bandBandwidthHz(erbIndex));
        const double angularBandwidth =
            pi * static_cast<double>(bandwidth) / reducedSampleRate;
        const double cosineBandwidth = std::cos(angularBandwidth);
        const double sineBandwidth = std::sin(angularBandwidth);
        const double denominator =
            1.0 + squareRootTwo * sineBandwidth * 0.5;
        const double prototypeGain =
            (1.0 - cosineBandwidth) / (2.0 * denominator);
        const double centreRadians =
            2.0 * pi * static_cast<double>(centre) / reducedSampleRate;
        const double centreCosine = std::cos(centreRadians);
        const double centreSine = std::sin(centreRadians);
        const double doubleCentreCosine = std::cos(2.0 * centreRadians);
        const double doubleCentreSine = std::sin(2.0 * centreRadians);
        const double c1Scale = -2.0 * cosineBandwidth / denominator;
        const double c2Scale =
            (1.0 - squareRootTwo * sineBandwidth * 0.5) / denominator;

        auto& coefficients = bands[static_cast<std::size_t>(band)];
        coefficients.centreHz = centre;
        coefficients.bandwidthHz = bandwidth;
        coefficients.d0 = static_cast<float>(prototypeGain);
        coefficients.d1 = {
            static_cast<float>(2.0 * prototypeGain * centreCosine),
            static_cast<float>(2.0 * prototypeGain * centreSine)
        };
        coefficients.d2 = {
            static_cast<float>(prototypeGain * doubleCentreCosine),
            static_cast<float>(prototypeGain * doubleCentreSine)
        };
        coefficients.c1 = {
            static_cast<float>(c1Scale * centreCosine),
            static_cast<float>(c1Scale * centreSine)
        };
        coefficients.c2 = {
            static_cast<float>(c2Scale * doubleCentreCosine),
            static_cast<float>(c2Scale * doubleCentreSine)
        };

        ++activeBandCount;
        ++octaveUpBandCount;
    }

    const float hostRateScale = static_cast<float>(sampleRate / 48000.0);
    const bool bassProfile = requestedInstrumentProfile.load(
        std::memory_order_relaxed) == 1;
    diagnosticActiveBandCount.store(
        juce::jmin(80, activeBandCount),
        std::memory_order_relaxed);
    diagnosticOctaveUpBandCount.store(
        juce::jmin(80, octaveUpBandCount),
        std::memory_order_relaxed);
    diagnosticLowestBandCentreHz.store(
        activeBandCount > 0
            ? bands[static_cast<std::size_t>(
                  bassProfile ? 0 : bassExtendedBandCount)].centreHz
            : 0.0f,
        std::memory_order_relaxed);
    diagnosticHighestBandCentreHz.store(
        activeBandCount > 0
            ? bands[static_cast<std::size_t>(juce::jmin(
                  activeBandCount - 1,
                  bassProfile ? 79 : 83))].centreHz
            : 0.0f,
        std::memory_order_relaxed);
    diagnosticWetAntiAliasCutoffHz.store(
        nominalDecimatorPassbandHz * hostRateScale,
        std::memory_order_relaxed);
}

void NAMPolyOctaver::resetDspState() noexcept
{
    for (auto& channel : channelStates)
        for (auto& state : channel)
            state = BandChannelState {};
    for (auto& state : channelRateStates)
        state.reset();
    dspStateIsReset = true;
}

void NAMPolyOctaver::reset() noexcept
{
    resetDspState();

    const double sampleRate = juce::jmax(
        1.0,
        static_cast<double>(
            diagnosticSampleRate.load(std::memory_order_relaxed)));
    smoothedDirectLevel.reset(sampleRate, levelRampSeconds);
    smoothedOctaveDownLevel.reset(sampleRate, levelRampSeconds);
    smoothedOctaveUpLevel.reset(sampleRate, levelRampSeconds);
    for (auto& profile : smoothedBassProfile)
    {
        profile.reset(
            sampleRate / static_cast<double>(resampleFactor),
            levelRampSeconds);
        profile.setCurrentAndTargetValue(
            requestedInstrumentProfile.load(
                std::memory_order_relaxed) == 1
                ? 1.0f
                : 0.0f);
    }
    smoothedDirectLevel.setCurrentAndTargetValue(
        requestedDirectLevel.load(std::memory_order_relaxed));
    smoothedOctaveDownLevel.setCurrentAndTargetValue(
        requestedOctaveDownLevel.load(std::memory_order_relaxed));
    smoothedOctaveUpLevel.setCurrentAndTargetValue(
        requestedOctaveUpLevel.load(std::memory_order_relaxed));
    resetDiagnostics();
}

void NAMPolyOctaver::setLevels(float directLevel,
                               float octaveDownLevel,
                               float octaveUpLevel) noexcept
{
    requestedDirectLevel.store(
        sanitiseLevel(directLevel, 1.0f), std::memory_order_relaxed);
    requestedOctaveDownLevel.store(
        sanitiseLevel(octaveDownLevel, 0.0f), std::memory_order_relaxed);
    requestedOctaveUpLevel.store(
        sanitiseLevel(octaveUpLevel, 0.0f), std::memory_order_relaxed);
}

void NAMPolyOctaver::setInstrumentProfile(int profile) noexcept
{
    const int safeProfile = profile == 1 ? 1 : 0;
    requestedInstrumentProfile.store(
        safeProfile,
        std::memory_order_relaxed);
    if (prepared.load(std::memory_order_acquire)
        && activeBandCount > bassExtendedBandCount)
    {
        diagnosticLowestBandCentreHz.store(
            bands[static_cast<std::size_t>(
                safeProfile == 1 ? 0 : bassExtendedBandCount)].centreHz,
            std::memory_order_relaxed);
        diagnosticHighestBandCentreHz.store(
            bands[static_cast<std::size_t>(juce::jmin(
                activeBandCount - 1,
                safeProfile == 1 ? 79 : 83))].centreHz,
            std::memory_order_relaxed);
    }
}

void NAMPolyOctaver::synchroniseLevelTargets() noexcept
{
    const float direct = requestedDirectLevel.load(std::memory_order_relaxed);
    const float down = requestedOctaveDownLevel.load(std::memory_order_relaxed);
    const float up = requestedOctaveUpLevel.load(std::memory_order_relaxed);
    if (smoothedDirectLevel.getTargetValue() != direct)
        smoothedDirectLevel.setTargetValue(direct);
    if (smoothedOctaveDownLevel.getTargetValue() != down)
        smoothedOctaveDownLevel.setTargetValue(down);
    if (smoothedOctaveUpLevel.getTargetValue() != up)
        smoothedOctaveUpLevel.setTargetValue(up);
}

void NAMPolyOctaver::synchroniseProfileTargets() noexcept
{
    const float target = requestedInstrumentProfile.load(
        std::memory_order_relaxed) == 1
        ? 1.0f
        : 0.0f;
    for (auto& profile : smoothedBassProfile)
    {
        if (profile.getTargetValue() != target)
            profile.setTargetValue(target);
    }
}

bool NAMPolyOctaver::wetPathIsExactlySilent() const noexcept
{
    return ! smoothedOctaveDownLevel.isSmoothing()
        && ! smoothedOctaveUpLevel.isSmoothing()
        && smoothedOctaveDownLevel.getCurrentValue() == 0.0f
        && smoothedOctaveDownLevel.getTargetValue() == 0.0f
        && smoothedOctaveUpLevel.getCurrentValue() == 0.0f
        && smoothedOctaveUpLevel.getTargetValue() == 0.0f;
}

bool NAMPolyOctaver::directPathIsExactlyUnity() const noexcept
{
    return ! smoothedDirectLevel.isSmoothing()
        && smoothedDirectLevel.getCurrentValue() == 1.0f
        && smoothedDirectLevel.getTargetValue() == 1.0f;
}

bool NAMPolyOctaver::allPathsAreExactlySilent() const noexcept
{
    return wetPathIsExactlySilent()
        && ! smoothedDirectLevel.isSmoothing()
        && smoothedDirectLevel.getCurrentValue() == 0.0f
        && smoothedDirectLevel.getTargetValue() == 0.0f;
}

NAMPolyOctaver::VoiceFrame NAMPolyOctaver::processReducedRateSample(
    int channel,
    float input,
    bool generateOctaveDown,
    bool generateOctaveUp,
    std::uint64_t& nonFiniteCount) noexcept
{
    VoiceFrame voices;
    if (channel < 0 || channel >= maximumChannels || activeBandCount <= 0)
        return voices;

    if (! std::isfinite(input))
    {
        input = 0.0f;
        ++nonFiniteCount;
    }

    auto& states = channelStates[static_cast<std::size_t>(channel)];
    const float bassBlend = smoothedBassProfile[
        static_cast<std::size_t>(channel)].getNextValue();
    for (int band = 0; band < activeBandCount; ++band)
    {
        const float profileBandGain = band < bassExtendedBandCount
            ? bassBlend
            : (band >= 80 ? 1.0f - bassBlend : 1.0f);
        const auto& coefficients = bands[static_cast<std::size_t>(band)];
        auto& state = states[static_cast<std::size_t>(band)];

        const ComplexValue previousBandOutput = state.previousBandOutput;
        const ComplexValue bandOutput {
            state.state2.real + coefficients.d0 * input,
            state.state2.imag
        };
        const ComplexValue c1Output = multiply(coefficients.c1, bandOutput);
        const ComplexValue c2Output = multiply(coefficients.c2, bandOutput);
        const ComplexValue nextState2 {
            state.state1.real + coefficients.d1.real * input - c1Output.real,
            state.state1.imag + coefficients.d1.imag * input - c1Output.imag
        };
        const ComplexValue nextState1 {
            coefficients.d2.real * input - c2Output.real,
            coefficients.d2.imag * input - c2Output.imag
        };

        if (! std::isfinite(bandOutput.real)
            || ! std::isfinite(bandOutput.imag)
            || ! std::isfinite(nextState1.real)
            || ! std::isfinite(nextState1.imag)
            || ! std::isfinite(nextState2.real)
            || ! std::isfinite(nextState2.imag))
        {
            state = BandChannelState {};
            ++nonFiniteCount;
            continue;
        }

        state.state1 = nextState1;
        state.state2 = nextState2;
        state.previousBandOutput = bandOutput;

        if (bandOutput.real < 0.0f
            && std::signbit(bandOutput.imag)
                != std::signbit(previousBandOutput.imag))
        {
            state.octaveDownSign = -state.octaveDownSign;
        }

        const float real = bandOutput.real;
        const float imag = bandOutput.imag;
        const float energy = real * real + imag * imag;
        if (! std::isfinite(energy))
        {
            state = BandChannelState {};
            ++nonFiniteCount;
            continue;
        }
        if (energy <= phaseEnergyFloor)
            continue;

        const float inverseMagnitude = fastInverseSqrt(energy);

        if (generateOctaveUp)
        {
            voices.octaveUp += profileBandGain
                * (real * real - imag * imag) * inverseMagnitude;
        }

        if (generateOctaveDown)
        {
            const float halfNormalisedReal = juce::jlimit(
                -0.5f, 0.5f, 0.5f * real * inverseMagnitude);
            const float rootReal = fastSqrt(
                juce::jmax(0.0f, 0.5f + halfNormalisedReal));
            const float rootImag = (imag < 0.0f ? -1.0f : 1.0f)
                * fastSqrt(
                    juce::jmax(0.0f, 0.5f - halfNormalisedReal));
            voices.octaveDown += profileBandGain * state.octaveDownSign
                * (real * rootReal + imag * rootImag);
        }
    }

    if (! std::isfinite(voices.octaveDown)
        || ! std::isfinite(voices.octaveUp))
    {
        voices = {};
        for (auto& state : states)
            state = BandChannelState {};
        ++nonFiniteCount;
    }
    return voices;
}

NAMPolyOctaver::VoiceFrame NAMPolyOctaver::processVoiceSample(
    int channel,
    float input,
    bool generateOctaveDown,
    bool generateOctaveUp,
    std::uint64_t& nonFiniteCount) noexcept
{
    VoiceFrame output;
    if (channel < 0 || channel >= maximumChannels)
        return output;

    auto& rateState = channelRateStates[static_cast<std::size_t>(channel)];
    if (! std::isfinite(input))
    {
        input = 0.0f;
        ++nonFiniteCount;
    }

    const auto phaseIndex = static_cast<std::size_t>(rateState.phase);
    if (generateOctaveDown)
    {
        const float rawOctaveDown =
            rateState.pendingDownOutput[phaseIndex];
        output.octaveDown = rawOctaveDown
            - rateState.octaveDownDcInput
            + octaveDownHighPassCoefficient
                * rateState.octaveDownDcOutput;
        rateState.octaveDownDcInput = rawOctaveDown;
        rateState.octaveDownDcOutput = std::isfinite(output.octaveDown)
            ? output.octaveDown
            : 0.0f;
    }
    else
    {
        rateState.octaveDownDcInput = 0.0f;
        rateState.octaveDownDcOutput = 0.0f;
    }
    output.octaveUp = generateOctaveUp
        ? rateState.pendingUpOutput[phaseIndex]
        : 0.0f;
    rateState.pendingInput[phaseIndex] = input;

    ++rateState.phase;
    if (rateState.phase >= resampleFactor)
    {
        const float reducedInput =
            rateState.decimator.process(rateState.pendingInput);
        if (! std::isfinite(reducedInput))
        {
            rateState.reset();
            auto& states = channelStates[static_cast<std::size_t>(channel)];
            for (auto& state : states)
                state = BandChannelState {};
            ++nonFiniteCount;
        }
        else
        {
            const VoiceFrame reducedVoices = processReducedRateSample(
                channel,
                reducedInput,
                generateOctaveDown,
                generateOctaveUp,
                nonFiniteCount);

            if (generateOctaveDown)
            {
                rateState.downInterpolator.process(
                    reducedVoices.octaveDown,
                    rateState.pendingDownOutput);
                rateState.downInterpolatorActive = true;
            }
            else
            {
                if (rateState.downInterpolatorActive)
                    rateState.downInterpolator.reset();
                rateState.pendingDownOutput.fill(0.0f);
                rateState.downInterpolatorActive = false;
            }

            if (generateOctaveUp)
            {
                rateState.upInterpolator.process(
                    reducedVoices.octaveUp,
                    rateState.pendingUpOutput);
                rateState.upInterpolatorActive = true;
            }
            else
            {
                if (rateState.upInterpolatorActive)
                    rateState.upInterpolator.reset();
                rateState.pendingUpOutput.fill(0.0f);
                rateState.upInterpolatorActive = false;
            }
            rateState.phase = 0;
        }
    }

    if (! std::isfinite(output.octaveDown)
        || ! std::isfinite(output.octaveUp))
    {
        output = {};
        rateState.reset();
        auto& states = channelStates[static_cast<std::size_t>(channel)];
        for (auto& state : states)
            state = BandChannelState {};
        ++nonFiniteCount;
    }

    dspStateIsReset = false;
    return output;
}

void NAMPolyOctaver::processBlock(juce::AudioBuffer<float>& buffer) noexcept
{
    juce::ScopedNoDenormals noDenormals;

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0)
        return;

    if (! prepared.load(std::memory_order_acquire))
        return;

    synchroniseLevelTargets();
    synchroniseProfileTargets();

    if (wetPathIsExactlySilent() && directPathIsExactlyUnity())
    {
        if (! dspStateIsReset)
            resetDspState();
        diagnosticProcessedBlocks.fetch_add(1, std::memory_order_relaxed);
        diagnosticProcessedSamples.fetch_add(
            static_cast<std::uint64_t>(numSamples),
            std::memory_order_relaxed);
        diagnosticFastPathBlocks.fetch_add(1, std::memory_order_relaxed);
        diagnosticLastBlockDownPeak.store(0.0f, std::memory_order_relaxed);
        diagnosticLastBlockUpPeak.store(0.0f, std::memory_order_relaxed);
        return;
    }

    if (allPathsAreExactlySilent())
    {
        if (! dspStateIsReset)
            resetDspState();
        buffer.clear();
        diagnosticProcessedBlocks.fetch_add(1, std::memory_order_relaxed);
        diagnosticProcessedSamples.fetch_add(
            static_cast<std::uint64_t>(numSamples),
            std::memory_order_relaxed);
        diagnosticFastPathBlocks.fetch_add(1, std::memory_order_relaxed);
        diagnosticLastBlockDownPeak.store(0.0f, std::memory_order_relaxed);
        diagnosticLastBlockUpPeak.store(0.0f, std::memory_order_relaxed);
        return;
    }

    if (wetPathIsExactlySilent())
    {
        if (! dspStateIsReset)
            resetDspState();
        for (int sample = 0; sample < numSamples; ++sample)
        {
            const float directLevel = smoothedDirectLevel.getNextValue();
            for (int channel = 0; channel < numChannels; ++channel)
                buffer.getWritePointer(channel)[sample] *= directLevel;
        }
        diagnosticProcessedBlocks.fetch_add(1, std::memory_order_relaxed);
        diagnosticProcessedSamples.fetch_add(
            static_cast<std::uint64_t>(numSamples),
            std::memory_order_relaxed);
        diagnosticFastPathBlocks.fetch_add(1, std::memory_order_relaxed);
        diagnosticLastBlockDownPeak.store(0.0f, std::memory_order_relaxed);
        diagnosticLastBlockUpPeak.store(0.0f, std::memory_order_relaxed);
        return;
    }

    const int processedChannels = juce::jmin(numChannels, maximumChannels);
    const bool generateOctaveDown =
        smoothedOctaveDownLevel.isSmoothing()
        || smoothedOctaveDownLevel.getCurrentValue() != 0.0f
        || smoothedOctaveDownLevel.getTargetValue() != 0.0f;
    const bool generateOctaveUp =
        smoothedOctaveUpLevel.isSmoothing()
        || smoothedOctaveUpLevel.getCurrentValue() != 0.0f
        || smoothedOctaveUpLevel.getTargetValue() != 0.0f;
    std::array<float*, maximumChannels> channelData {};
    for (int channel = 0; channel < processedChannels; ++channel)
        channelData[static_cast<std::size_t>(channel)] =
            buffer.getWritePointer(channel);

    std::uint64_t nonFiniteCount = 0;
    float downPeak = 0.0f;
    float upPeak = 0.0f;
    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float directLevel = smoothedDirectLevel.getNextValue();
        const float downLevel = smoothedOctaveDownLevel.getNextValue();
        const float upLevel = smoothedOctaveUpLevel.getNextValue();

        for (int channel = 0; channel < processedChannels; ++channel)
        {
            auto* const samples = channelData[static_cast<std::size_t>(channel)];
            float direct = samples[sample];
            if (! std::isfinite(direct))
            {
                direct = 0.0f;
                ++nonFiniteCount;
            }
            const VoiceFrame voices = processVoiceSample(
                channel,
                direct,
                generateOctaveDown,
                generateOctaveUp,
                nonFiniteCount);
            downPeak = juce::jmax(downPeak, std::abs(voices.octaveDown));
            upPeak = juce::jmax(upPeak, std::abs(voices.octaveUp));
            const float mixed = direct * directLevel
                + voices.octaveDown * downLevel
                + voices.octaveUp * upLevel;
            if (std::isfinite(mixed))
                samples[sample] = mixed;
            else
            {
                samples[sample] = 0.0f;
                ++nonFiniteCount;
            }
        }

        for (int channel = processedChannels; channel < numChannels; ++channel)
            buffer.getWritePointer(channel)[sample] *= directLevel;
    }

    diagnosticProcessedBlocks.fetch_add(1, std::memory_order_relaxed);
    diagnosticProcessedSamples.fetch_add(
        static_cast<std::uint64_t>(numSamples),
        std::memory_order_relaxed);
    diagnosticNonFiniteRecoveries.fetch_add(
        nonFiniteCount, std::memory_order_relaxed);
    diagnosticLastBlockDownPeak.store(downPeak, std::memory_order_relaxed);
    diagnosticLastBlockUpPeak.store(upPeak, std::memory_order_relaxed);
}

void NAMPolyOctaver::processVoicesForTesting(
    const float* const* inputs,
    float* const* octaveDownOutputs,
    float* const* octaveUpOutputs,
    int numChannels,
    int numSamples) noexcept
{
    juce::ScopedNoDenormals noDenormals;

    synchroniseProfileTargets();

    if (! prepared.load(std::memory_order_acquire)
        || inputs == nullptr
        || octaveDownOutputs == nullptr
        || octaveUpOutputs == nullptr
        || numSamples <= 0)
    {
        return;
    }

    const int processedChannels = juce::jlimit(
        0, maximumChannels, numChannels);
    std::uint64_t nonFiniteCount = 0;
    float downPeak = 0.0f;
    float upPeak = 0.0f;
    for (int channel = 0; channel < processedChannels; ++channel)
    {
        if (inputs[channel] == nullptr
            || octaveDownOutputs[channel] == nullptr
            || octaveUpOutputs[channel] == nullptr)
        {
            ++nonFiniteCount;
            continue;
        }

        for (int sample = 0; sample < numSamples; ++sample)
        {
            const VoiceFrame voices = processVoiceSample(
                channel,
                inputs[channel][sample],
                true,
                true,
                nonFiniteCount);
            octaveDownOutputs[channel][sample] = voices.octaveDown;
            octaveUpOutputs[channel][sample] = voices.octaveUp;
            downPeak = juce::jmax(downPeak, std::abs(voices.octaveDown));
            upPeak = juce::jmax(upPeak, std::abs(voices.octaveUp));
        }
    }

    diagnosticProcessedBlocks.fetch_add(1, std::memory_order_relaxed);
    diagnosticProcessedSamples.fetch_add(
        static_cast<std::uint64_t>(numSamples),
        std::memory_order_relaxed);
    diagnosticNonFiniteRecoveries.fetch_add(
        nonFiniteCount, std::memory_order_relaxed);
    diagnosticLastBlockDownPeak.store(downPeak, std::memory_order_relaxed);
    diagnosticLastBlockUpPeak.store(upPeak, std::memory_order_relaxed);
}

NAMPolyOctaver::Diagnostics NAMPolyOctaver::getDiagnostics() const noexcept
{
    Diagnostics result;
    result.sampleRate = static_cast<double>(
        diagnosticSampleRate.load(std::memory_order_relaxed));
    result.processingSampleRate = result.sampleRate
        / static_cast<double>(resampleFactor);
    result.preparedMaximumBlockSize =
        diagnosticMaximumBlockSize.load(std::memory_order_relaxed);
    result.activeBandCount =
        diagnosticActiveBandCount.load(std::memory_order_relaxed);
    result.octaveUpBandCount =
        diagnosticOctaveUpBandCount.load(std::memory_order_relaxed);
    result.instrumentProfile = requestedInstrumentProfile.load(
        std::memory_order_relaxed) == 1 ? 1 : 0;
    result.multirateFactor = resampleFactor;
    result.lowestBandCentreHz =
        diagnosticLowestBandCentreHz.load(std::memory_order_relaxed);
    result.highestBandCentreHz =
        diagnosticHighestBandCentreHz.load(std::memory_order_relaxed);
    result.maximumGeneratedUpFrequencyHz =
        2.0f * result.highestBandCentreHz;
    result.octaveUpPassbandHz = result.maximumGeneratedUpFrequencyHz;
    result.octaveUpStopbandHz = juce::jmin(
        static_cast<float>(result.sampleRate * 0.5),
        nominalInterpolatorStopbandHz
            * static_cast<float>(result.sampleRate / 48000.0));
    result.wetAntiAliasCutoffHz =
        diagnosticWetAntiAliasCutoffHz.load(std::memory_order_relaxed);
    result.wetAntiAliasOrder = wetAntiAliasOrder;
    result.reportedLatencySamples = getLatencySamples();
    result.processedBlocks =
        diagnosticProcessedBlocks.load(std::memory_order_relaxed);
    result.processedSamples =
        diagnosticProcessedSamples.load(std::memory_order_relaxed);
    result.fastPathBlocks =
        diagnosticFastPathBlocks.load(std::memory_order_relaxed);
    result.nonFiniteRecoveries =
        diagnosticNonFiniteRecoveries.load(std::memory_order_relaxed);
    result.lastBlockDownPeak =
        diagnosticLastBlockDownPeak.load(std::memory_order_relaxed);
    result.lastBlockUpPeak =
        diagnosticLastBlockUpPeak.load(std::memory_order_relaxed);
    return result;
}

void NAMPolyOctaver::resetDiagnostics() noexcept
{
    diagnosticProcessedBlocks.store(0, std::memory_order_relaxed);
    diagnosticProcessedSamples.store(0, std::memory_order_relaxed);
    diagnosticFastPathBlocks.store(0, std::memory_order_relaxed);
    diagnosticNonFiniteRecoveries.store(0, std::memory_order_relaxed);
    diagnosticLastBlockDownPeak.store(0.0f, std::memory_order_relaxed);
    diagnosticLastBlockUpPeak.store(0.0f, std::memory_order_relaxed);
}

NAMPolyOctaver::SelfTestResult NAMPolyOctaver::runDeterministicSelfTest(
    double sampleRate)
{
    SelfTestResult result;
    const double safeSampleRate = sampleRate > 1000.0
        ? sampleRate
        : 48000.0;
    constexpr double twoPi = 2.0 * juce::MathConstants<double>::pi;

    {
        constexpr int sampleCount = 257;
        juce::AudioBuffer<float> buffer(maximumChannels, sampleCount);
        juce::AudioBuffer<float> reference(maximumChannels, sampleCount);
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            auto* const samples = buffer.getWritePointer(channel);
            for (int sample = 0; sample < sampleCount; ++sample)
            {
                const double time = static_cast<double>(sample)
                    / safeSampleRate;
                samples[sample] = static_cast<float>(
                    0.17 * std::sin(twoPi * (110.0 + 63.0 * channel) * time)
                    + 0.04 * std::sin(
                        twoPi * (701.0 + 296.0 * channel) * time + 0.2));
            }
        }
        reference.makeCopyOf(buffer);
        NAMPolyOctaver bypass;
        bypass.prepare(safeSampleRate, sampleCount);
        bypass.processBlock(buffer);
        result.exactBypassPassed = true;
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            result.exactBypassPassed = result.exactBypassPassed
                && std::memcmp(
                    buffer.getReadPointer(channel),
                    reference.getReadPointer(channel),
                    static_cast<std::size_t>(sampleCount) * sizeof(float)) == 0;
        }

        NAMPolyOctaver silence;
        silence.setLevels(0.0f, 0.0f, 0.0f);
        silence.prepare(safeSampleRate, sampleCount);
        silence.processBlock(reference);
        result.exactSilencePassed = true;
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            const auto* const samples = reference.getReadPointer(channel);
            for (int sample = 0; sample < sampleCount; ++sample)
                result.exactSilencePassed = result.exactSilencePassed
                    && samples[sample] == 0.0f;
        }
    }

    const int streamSampleCount = juce::jmax(
        8192, static_cast<int>(std::ceil(safeSampleRate * 0.4)) + 5);
    std::vector<float> inputLeft(
        static_cast<std::size_t>(streamSampleCount));
    std::vector<float> inputRight(
        static_cast<std::size_t>(streamSampleCount));
    for (int sample = 0; sample < streamSampleCount; ++sample)
    {
        const double time = static_cast<double>(sample) / safeSampleRate;
        inputLeft[static_cast<std::size_t>(sample)] = static_cast<float>(
            0.16 * std::sin(twoPi * 110.0 * time)
            + 0.07 * std::sin(twoPi * 713.0 * time + 0.31));
        inputRight[static_cast<std::size_t>(sample)] = static_cast<float>(
            0.14 * std::sin(twoPi * 173.0 * time + 0.17)
            + 0.05 * std::sin(twoPi * 997.0 * time + 0.83));
    }

    auto renderWholeStream = [&inputLeft,
                              &inputRight,
                              streamSampleCount](
        NAMPolyOctaver& processor,
        std::array<std::vector<float>, maximumChannels>& down,
        std::array<std::vector<float>, maximumChannels>& up)
    {
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            down[static_cast<std::size_t>(channel)].assign(
                static_cast<std::size_t>(streamSampleCount), 0.0f);
            up[static_cast<std::size_t>(channel)].assign(
                static_cast<std::size_t>(streamSampleCount), 0.0f);
        }
        const float* inputChannels[] { inputLeft.data(), inputRight.data() };
        float* downChannels[] { down[0].data(), down[1].data() };
        float* upChannels[] { up[0].data(), up[1].data() };
        processor.processVoicesForTesting(
            inputChannels,
            downChannels,
            upChannels,
            maximumChannels,
            streamSampleCount);
    };

    std::array<std::vector<float>, maximumChannels> resetDownA;
    std::array<std::vector<float>, maximumChannels> resetUpA;
    std::array<std::vector<float>, maximumChannels> resetDownB;
    std::array<std::vector<float>, maximumChannels> resetUpB;
    NAMPolyOctaver resetProcessor;
    resetProcessor.prepare(safeSampleRate, 257);
    renderWholeStream(resetProcessor, resetDownA, resetUpA);
    resetProcessor.reset();
    renderWholeStream(resetProcessor, resetDownB, resetUpB);
    result.maximumResetDifference = 0.0f;
    for (int channel = 0; channel < maximumChannels; ++channel)
    {
        const auto channelIndex = static_cast<std::size_t>(channel);
        result.maximumResetDifference = juce::jmax(
            result.maximumResetDifference,
            maximumAbsoluteDifference(
                resetDownA[channelIndex], resetDownB[channelIndex]));
        result.maximumResetDifference = juce::jmax(
            result.maximumResetDifference,
            maximumAbsoluteDifference(
                resetUpA[channelIndex], resetUpB[channelIndex]));
    }
    result.resetDeterminismPassed = result.maximumResetDifference == 0.0f;

    NAMPolyOctaver partitionProcessor;
    partitionProcessor.prepare(safeSampleRate, 257);
    std::array<std::vector<float>, maximumChannels> partitionDown;
    std::array<std::vector<float>, maximumChannels> partitionUp;
    for (int channel = 0; channel < maximumChannels; ++channel)
    {
        partitionDown[static_cast<std::size_t>(channel)].assign(
            static_cast<std::size_t>(streamSampleCount), 0.0f);
        partitionUp[static_cast<std::size_t>(channel)].assign(
            static_cast<std::size_t>(streamSampleCount), 0.0f);
    }
    constexpr std::array<int, 11> partitionPattern {
        1, 5, 7, 8, 13, 2, 31, 64, 3, 127, 11
    };
    int offset = 0;
    std::size_t partitionIndex = 0;
    while (offset < streamSampleCount)
    {
        const int count = juce::jmin(
            partitionPattern[partitionIndex % partitionPattern.size()],
            streamSampleCount - offset);
        const float* inputChannels[] {
            inputLeft.data() + offset,
            inputRight.data() + offset
        };
        float* downChannels[] {
            partitionDown[0].data() + offset,
            partitionDown[1].data() + offset
        };
        float* upChannels[] {
            partitionUp[0].data() + offset,
            partitionUp[1].data() + offset
        };
        partitionProcessor.processVoicesForTesting(
            inputChannels,
            downChannels,
            upChannels,
            maximumChannels,
            count);
        offset += count;
        ++partitionIndex;
    }
    result.maximumPartitionDifference = 0.0f;
    for (int channel = 0; channel < maximumChannels; ++channel)
    {
        const auto channelIndex = static_cast<std::size_t>(channel);
        result.maximumPartitionDifference = juce::jmax(
            result.maximumPartitionDifference,
            maximumAbsoluteDifference(
                resetDownA[channelIndex], partitionDown[channelIndex]));
        result.maximumPartitionDifference = juce::jmax(
            result.maximumPartitionDifference,
            maximumAbsoluteDifference(
                resetUpA[channelIndex], partitionUp[channelIndex]));
    }
    result.partitionInvariantPassed =
        result.maximumPartitionDifference == 0.0f;

    {
        NAMPolyOctaver stereoProcessor;
        stereoProcessor.prepare(safeSampleRate, 257);
        std::vector<float> silent(
            static_cast<std::size_t>(streamSampleCount), 0.0f);
        std::array<std::vector<float>, maximumChannels> down;
        std::array<std::vector<float>, maximumChannels> up;
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            down[static_cast<std::size_t>(channel)].assign(
                static_cast<std::size_t>(streamSampleCount), 0.0f);
            up[static_cast<std::size_t>(channel)].assign(
                static_cast<std::size_t>(streamSampleCount), 0.0f);
        }
        const float* inputChannels[] { inputLeft.data(), silent.data() };
        float* downChannels[] { down[0].data(), down[1].data() };
        float* upChannels[] { up[0].data(), up[1].data() };
        stereoProcessor.processVoicesForTesting(
            inputChannels,
            downChannels,
            upChannels,
            maximumChannels,
            streamSampleCount);
        result.maximumSilentChannelLeak = juce::jmax(
            maximumAbsoluteValue(down[1]), maximumAbsoluteValue(up[1]));
        result.stereoIsolationPassed = result.maximumSilentChannelLeak == 0.0f;

        stereoProcessor.reset();
        const float* identicalInputs[] { inputLeft.data(), inputLeft.data() };
        stereoProcessor.processVoicesForTesting(
            identicalInputs,
            downChannels,
            upChannels,
            maximumChannels,
            streamSampleCount);
        result.maximumIdenticalStereoDifference = juce::jmax(
            maximumAbsoluteDifference(down[0], down[1]),
            maximumAbsoluteDifference(up[0], up[1]));
        result.identicalStereoParityPassed =
            result.maximumIdenticalStereoDifference == 0.0f;
    }

    {
        NAMPolyOctaver finiteProcessor;
        finiteProcessor.prepare(safeSampleRate, 257);
        std::vector<float> contaminatedLeft = inputLeft;
        std::vector<float> contaminatedRight = inputRight;
        contaminatedLeft[contaminatedLeft.size() / 3]
            = std::numeric_limits<float>::quiet_NaN();
        contaminatedRight[contaminatedRight.size() / 2]
            = std::numeric_limits<float>::infinity();
        std::array<std::vector<float>, maximumChannels> down;
        std::array<std::vector<float>, maximumChannels> up;
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            down[static_cast<std::size_t>(channel)].assign(
                static_cast<std::size_t>(streamSampleCount), 0.0f);
            up[static_cast<std::size_t>(channel)].assign(
                static_cast<std::size_t>(streamSampleCount), 0.0f);
        }
        const float* inputChannels[] {
            contaminatedLeft.data(), contaminatedRight.data()
        };
        float* downChannels[] { down[0].data(), down[1].data() };
        float* upChannels[] { up[0].data(), up[1].data() };
        finiteProcessor.processVoicesForTesting(
            inputChannels,
            downChannels,
            upChannels,
            maximumChannels,
            streamSampleCount);
        bool outputsAreFinite = true;
        for (int channel = 0; channel < maximumChannels; ++channel)
        {
            for (const float value : down[static_cast<std::size_t>(channel)])
                outputsAreFinite = outputsAreFinite && std::isfinite(value);
            for (const float value : up[static_cast<std::size_t>(channel)])
                outputsAreFinite = outputsAreFinite && std::isfinite(value);
        }
        result.nonFiniteRecoveries =
            finiteProcessor.getDiagnostics().nonFiniteRecoveries;
        const std::size_t tailBegin = static_cast<std::size_t>(
            streamSampleCount * 3 / 4);
        const double tailRms = vectorRms(down[0], tailBegin)
            + vectorRms(up[0], tailBegin)
            + vectorRms(down[1], tailBegin)
            + vectorRms(up[1], tailBegin);
        result.finiteRecoveryPassed = outputsAreFinite
            && result.nonFiniteRecoveries >= 2
            && tailRms > 1.0e-4;
    }

    const int toneSampleCount = juce::jmax(
        4096, static_cast<int>(std::ceil(safeSampleRate * 1.5)));
    const std::size_t toneAnalysisBegin = static_cast<std::size_t>(
        juce::jlimit(0, toneSampleCount - 1,
                     static_cast<int>(std::ceil(safeSampleRate * 0.5))));
    auto renderTone = [safeSampleRate, toneSampleCount, twoPi](
        double frequency,
        std::vector<float>& down,
        std::vector<float>& up,
        int instrumentProfile = 0)
    {
        std::vector<float> input(static_cast<std::size_t>(toneSampleCount));
        down.assign(static_cast<std::size_t>(toneSampleCount), 0.0f);
        up.assign(static_cast<std::size_t>(toneSampleCount), 0.0f);
        for (int sample = 0; sample < toneSampleCount; ++sample)
        {
            input[static_cast<std::size_t>(sample)] = static_cast<float>(
                0.2 * std::sin(twoPi * frequency
                    * static_cast<double>(sample) / safeSampleRate));
        }
        NAMPolyOctaver processor;
        processor.setInstrumentProfile(instrumentProfile);
        processor.prepare(safeSampleRate, 257);
        const float* inputChannels[] { input.data() };
        float* downChannels[] { down.data() };
        float* upChannels[] { up.data() };
        processor.processVoicesForTesting(
            inputChannels, downChannels, upChannels, 1, toneSampleCount);
    };

    result.minimumTargetDominanceDb =
        std::numeric_limits<float>::infinity();
    bool allTargetsPresent = true;
    double validStopbandReferenceRms = 0.0;
    for (const double frequency : { 110.0, 220.0, 440.0, 880.0 })
    {
        std::vector<float> down;
        std::vector<float> up;
        renderTone(frequency, down, up);
        const double downTarget = toneMagnitude(
            down, toneAnalysisBegin, safeSampleRate, frequency * 0.5);
        const double downResidual = toneMagnitude(
            down, toneAnalysisBegin, safeSampleRate, frequency);
        const double upTarget = toneMagnitude(
            up, toneAnalysisBegin, safeSampleRate, frequency * 2.0);
        const double upResidual = toneMagnitude(
            up, toneAnalysisBegin, safeSampleRate, frequency);
        const float downDominance = ratioToDecibels(
            downTarget, downResidual);
        const float upDominance = ratioToDecibels(upTarget, upResidual);
        result.minimumTargetDominanceDb = juce::jmin(
            result.minimumTargetDominanceDb,
            juce::jmin(downDominance, upDominance));
        allTargetsPresent = allTargetsPresent
            && downTarget > 0.02
            && upTarget > 0.02;
        if (frequency == 880.0)
            validStopbandReferenceRms = vectorRms(up, toneAnalysisBegin);
    }
    result.targetFrequencyPassed = allTargetsPresent
        && result.minimumTargetDominanceDb >= 30.0f;

    result.minimumBassLowNoteDominanceDb =
        std::numeric_limits<float>::infinity();
    bool allBassLowNotesPresent = true;
    for (const double frequency : { 30.8677, 41.2034 })
    {
        std::vector<float> down;
        std::vector<float> up;
        renderTone(frequency, down, up, 1);
        const double downTarget = toneMagnitude(
            down, toneAnalysisBegin, safeSampleRate, frequency * 0.5);
        const double downResidual = toneMagnitude(
            down, toneAnalysisBegin, safeSampleRate, frequency);
        const double upTarget = toneMagnitude(
            up, toneAnalysisBegin, safeSampleRate, frequency * 2.0);
        const double upResidual = toneMagnitude(
            up, toneAnalysisBegin, safeSampleRate, frequency);
        result.minimumBassLowNoteDominanceDb = juce::jmin(
            result.minimumBassLowNoteDominanceDb,
            juce::jmin(
                ratioToDecibels(downTarget, downResidual),
                ratioToDecibels(upTarget, upResidual)));
        allBassLowNotesPresent = allBassLowNotesPresent
            && downTarget > 0.006
            && upTarget > 0.006;
    }
    result.bassLowNotePassed = allBassLowNotesPresent
        && result.minimumBassLowNoteDominanceDb >= 24.0f;

    // Live Guitar->Bass->Guitar publication is exercised at hostile eight-
    // sample and uneven callback boundaries. All 84 ERB states keep advancing
    // regardless of profile, so the only difference is the 20 ms band-gain
    // ramp and callback partitioning remains sample-identical.
    const int switchSampleCount = juce::jmax(
        8192, static_cast<int>(safeSampleRate * 0.75));
    std::vector<float> switchInput(
        static_cast<std::size_t>(switchSampleCount));
    for (int sample = 0; sample < switchSampleCount; ++sample)
    {
        switchInput[static_cast<std::size_t>(sample)] = static_cast<float>(
            0.18 * std::sin(twoPi * 41.2034
                * static_cast<double>(sample) / safeSampleRate));
    }
    const int bassAt = switchSampleCount / 3;
    const int guitarAt = switchSampleCount * 2 / 3;
    auto renderProfileSwitch = [&] (
        const std::vector<int>& partitions,
        std::vector<float>& output)
    {
        output.assign(
            static_cast<std::size_t>(switchSampleCount), 0.0f);
        NAMPolyOctaver processor;
        processor.setLevels(0.0f, 0.72f, 0.45f);
        processor.prepare(safeSampleRate, 257);
        int offset = 0;
        std::size_t partitionIndex = 0;
        while (offset < switchSampleCount)
        {
            int count = partitions[partitionIndex % partitions.size()];
            count = juce::jmin(count, switchSampleCount - offset);
            if (offset < bassAt && offset + count > bassAt)
                count = bassAt - offset;
            if (offset < guitarAt && offset + count > guitarAt)
                count = guitarAt - offset;
            if (offset == bassAt)
                processor.setInstrumentProfile(1);
            else if (offset == guitarAt)
                processor.setInstrumentProfile(0);
            const float* inputChannels[] {
                switchInput.data() + offset
            };
            std::vector<float> down(static_cast<std::size_t>(count));
            std::vector<float> up(static_cast<std::size_t>(count));
            float* downChannels[] { down.data() };
            float* upChannels[] { up.data() };
            processor.processVoicesForTesting(
                inputChannels, downChannels, upChannels, 1, count);
            for (int sample = 0; sample < count; ++sample)
            {
                output[static_cast<std::size_t>(offset + sample)] =
                    down[static_cast<std::size_t>(sample)] * 0.72f
                    + up[static_cast<std::size_t>(sample)] * 0.45f;
            }
            offset += count;
            ++partitionIndex;
        }
    };
    std::vector<float> eightSampleSwitch;
    std::vector<float> unevenSwitch;
    renderProfileSwitch({ 8 }, eightSampleSwitch);
    renderProfileSwitch(
        { 1, 7, 3, 8, 2, 5, 8, 4 }, unevenSwitch);
    result.maximumProfileSwitchPartitionDifference =
        maximumAbsoluteDifference(eightSampleSwitch, unevenSwitch);
    result.maximumProfileSwitchDelta = 0.0f;
    bool switchOutputFinite = true;
    for (std::size_t index = 1; index < eightSampleSwitch.size(); ++index)
    {
        switchOutputFinite = switchOutputFinite
            && std::isfinite(eightSampleSwitch[index]);
        result.maximumProfileSwitchDelta = juce::jmax(
            result.maximumProfileSwitchDelta,
            std::abs(eightSampleSwitch[index]
                - eightSampleSwitch[index - 1]));
    }
    result.liveProfileSwitchPartitionPassed =
        result.maximumProfileSwitchPartitionDifference == 0.0f;
    result.liveProfileSwitchPassed = switchOutputFinite
        && result.maximumProfileSwitchDelta < 0.20f;

    {
        std::vector<float> rejectedDown;
        std::vector<float> rejectedUp;
        renderTone(safeSampleRate * 0.31, rejectedDown, rejectedUp);
        const double rejectedRms = vectorRms(
            rejectedUp, toneAnalysisBegin);
        result.stopbandRejectionDb = ratioToDecibels(
            rejectedRms, validStopbandReferenceRms);
        result.stopbandRejectionPassed =
            validStopbandReferenceRms > 1.0e-4
            && result.stopbandRejectionDb <= -70.0f;
    }

    result.passed = result.exactBypassPassed
        && result.exactSilencePassed
        && result.resetDeterminismPassed
        && result.partitionInvariantPassed
        && result.stereoIsolationPassed
        && result.identicalStereoParityPassed
        && result.finiteRecoveryPassed
        && result.targetFrequencyPassed
        && result.bassLowNotePassed
        && result.liveProfileSwitchPassed
        && result.liveProfileSwitchPartitionPassed
        && result.stopbandRejectionPassed;
    return result;
}
