#pragma once

#include <JuceHeader.h>
#include <cmath>
#include <complex>
#include <limits>
#include <vector>

// Calling-thread QA math shared by the native Drive and opt-in Fuzz probes.
// This is never called by the audio renderer. It removes only reported integer
// latency and a bounded fractional delay; it does not fit output gain or EQ.
class NAMNonlinearAliasAnalysis final
{
public:
    static constexpr int decimatorTapCount = 513;
    static constexpr int decimatorHalfLength = decimatorTapCount / 2;
    static constexpr double analysisPeriodSeconds = 0.010;

    explicit NAMNonlinearAliasAnalysis(int referenceRateFactor = 4)
        : rateFactor(juce::jmax(1, referenceRateFactor)),
          decimatorCoefficients(static_cast<size_t>(decimatorTapCount), 0.0)
    {
        const double normalizedCutoff = 0.45 / static_cast<double>(rateFactor);
        double coefficientSum = 0.0;
        for (int tap = 0; tap < decimatorTapCount; ++tap)
        {
            const int offset = tap - decimatorHalfLength;
            const double sincArgument =
                2.0 * normalizedCutoff * static_cast<double>(offset);
            const double sinc = offset == 0
                ? 1.0
                : std::sin(juce::MathConstants<double>::pi * sincArgument)
                    / (juce::MathConstants<double>::pi * sincArgument);
            const double phase = static_cast<double>(tap)
                / static_cast<double>(decimatorTapCount - 1);
            const double window = 0.35875
                - 0.48829 * std::cos(juce::MathConstants<double>::twoPi * phase)
                + 0.14128 * std::cos(2.0 * juce::MathConstants<double>::twoPi * phase)
                - 0.01168 * std::cos(3.0 * juce::MathConstants<double>::twoPi * phase);
            const double coefficient = 2.0 * normalizedCutoff * sinc * window;
            decimatorCoefficients[static_cast<size_t>(tap)] = coefficient;
            coefficientSum += coefficient;
        }
        for (auto& coefficient : decimatorCoefficients)
            coefficient /= coefficientSum;
    }

    std::vector<float> decimate(const std::vector<float>& highRate) const
    {
        std::vector<float> result;
        if (highRate.size() <= decimatorCoefficients.size())
            return result;
        const int lastCentre = static_cast<int>(highRate.size())
            - decimatorHalfLength - 1;
        const int outputCount = 1
            + (lastCentre - decimatorHalfLength) / rateFactor;
        result.reserve(static_cast<size_t>(juce::jmax(0, outputCount)));
        for (int centre = decimatorHalfLength;
             centre <= lastCentre; centre += rateFactor)
        {
            double sum = 0.0;
            const int first = centre - decimatorHalfLength;
            for (int tap = 0; tap < static_cast<int>(decimatorCoefficients.size()); ++tap)
                sum += decimatorCoefficients[static_cast<size_t>(tap)]
                    * static_cast<double>(highRate[static_cast<size_t>(first + tap)]);
            result.push_back(static_cast<float>(sum));
        }
        return result;
    }

    struct AlignedResidual
    {
        double unoccupiedRatio = 1.0;
        double occupiedRatio = 1.0;
        double fractionalAdvance = 0.0;
        int integerAdvance = 0;
        int unoccupiedBins = 0;
        int occupiedBins = 0;
        bool finite = false;
    };

    static AlignedResidual measureAlignedResidual(
        const std::vector<float>& device, const std::vector<float>& reference,
        double sampleRate, double expectedAdvance, int occupiedStride)
    {
        AlignedResidual result;
        const int available = juce::jmin(
            static_cast<int>(device.size()), static_cast<int>(reference.size()));
        const int periodSamples = juce::jmax(32,
            static_cast<int>(std::round(sampleRate * analysisPeriodSeconds)));
        result.integerAdvance = static_cast<int>(std::round(expectedAdvance));
        const int margin = std::abs(result.integerAdvance) + 8;
        const int referenceStart = available - margin - periodSamples;
        const int deviceStart = referenceStart + result.integerAdvance;
        if (referenceStart < 0 || deviceStart < 0
            || referenceStart + periodSamples > available
            || deviceStart + periodSamples > available)
            return result;

        std::vector<float> devicePeriod(static_cast<size_t>(periodSamples));
        std::vector<float> referencePeriod(static_cast<size_t>(periodSamples));
        for (int sample = 0; sample < periodSamples; ++sample)
        {
            devicePeriod[static_cast<size_t>(sample)] =
                device[static_cast<size_t>(deviceStart + sample)];
            referencePeriod[static_cast<size_t>(sample)] =
                reference[static_cast<size_t>(referenceStart + sample)];
        }
        const auto deviceSpectrum = makeSpectrum(devicePeriod);
        const auto referenceSpectrum = makeSpectrum(referencePeriod);
        double maximumReferenceMagnitude = 0.0;
        for (size_t bin = 1; bin < referenceSpectrum.size(); ++bin)
        {
            if (static_cast<int>(bin) % occupiedStride != 0)
                continue;
            maximumReferenceMagnitude = juce::jmax(
                maximumReferenceMagnitude, std::abs(referenceSpectrum[bin]));
        }
        const double occupiedFloor = juce::jmax(
            1.0e-14, maximumReferenceMagnitude * 1.0e-5);

        double bestError = std::numeric_limits<double>::max();
        for (int stepIndex = -128; stepIndex <= 128; ++stepIndex)
        {
            const double fractional = static_cast<double>(stepIndex) / 256.0;
            double error = 0.0;
            int bins = 0;
            for (size_t bin = 1; bin < referenceSpectrum.size(); ++bin)
            {
                const double frequency = static_cast<double>(bin)
                    * sampleRate / static_cast<double>(periodSamples);
                if (frequency < 20.0 || frequency > sampleRate * 0.45
                    || static_cast<int>(bin) % occupiedStride != 0
                    || std::abs(referenceSpectrum[bin]) < occupiedFloor)
                    continue;
                const double phase = juce::MathConstants<double>::twoPi
                    * static_cast<double>(bin) * fractional
                    / static_cast<double>(periodSamples);
                const std::complex<double> rotated = deviceSpectrum[bin]
                    * std::complex<double>(std::cos(phase), std::sin(phase));
                error += std::norm(rotated - referenceSpectrum[bin]);
                ++bins;
            }
            if (bins > 0 && error < bestError)
            {
                bestError = error;
                result.fractionalAdvance = fractional;
            }
        }

        double referencePower = 0.0;
        double occupiedResidualPower = 0.0;
        double unoccupiedResidualPower = 0.0;
        for (size_t bin = 1; bin < referenceSpectrum.size(); ++bin)
        {
            const double frequency = static_cast<double>(bin)
                * sampleRate / static_cast<double>(periodSamples);
            if (frequency < 20.0 || frequency > sampleRate * 0.45)
                continue;
            const double phase = juce::MathConstants<double>::twoPi
                * static_cast<double>(bin) * result.fractionalAdvance
                / static_cast<double>(periodSamples);
            const std::complex<double> rotated = deviceSpectrum[bin]
                * std::complex<double>(std::cos(phase), std::sin(phase));
            const double residual = std::norm(rotated - referenceSpectrum[bin]);
            const bool analyticallyOccupied = static_cast<int>(bin) % occupiedStride == 0;
            if (analyticallyOccupied)
            {
                referencePower += std::norm(referenceSpectrum[bin]);
                occupiedResidualPower += residual;
                ++result.occupiedBins;
            }
            else
            {
                unoccupiedResidualPower += residual;
                ++result.unoccupiedBins;
            }
        }
        result.unoccupiedRatio = std::sqrt(unoccupiedResidualPower
            / juce::jmax(1.0e-30, referencePower));
        result.occupiedRatio = std::sqrt(occupiedResidualPower
            / juce::jmax(1.0e-30, referencePower));
        result.finite = result.unoccupiedBins > 0 && result.occupiedBins > 0
            && std::isfinite(result.unoccupiedRatio)
            && std::isfinite(result.occupiedRatio)
            && std::isfinite(result.fractionalAdvance);
        return result;
    }

private:
    static std::vector<std::complex<double>> makeSpectrum(const std::vector<float>& period)
    {
        const int count = static_cast<int>(period.size());
        std::vector<std::complex<double>> spectrum(static_cast<size_t>(count / 2 + 1));
        for (int bin = 0; bin <= count / 2; ++bin)
        {
            const double angle = -juce::MathConstants<double>::twoPi
                * static_cast<double>(bin) / static_cast<double>(count);
            const std::complex<double> step(std::cos(angle), std::sin(angle));
            std::complex<double> oscillator(1.0, 0.0);
            std::complex<double> sum(0.0, 0.0);
            for (const float sample : period)
            {
                sum += static_cast<double>(sample) * oscillator;
                oscillator *= step;
            }
            spectrum[static_cast<size_t>(bin)] = sum;
        }
        return spectrum;
    }

    const int rateFactor;
    std::vector<double> decimatorCoefficients;
};
