#pragma once
#include "BuiltInEQRouting.h"
#include <JuceHeader.h>
#include <array>
#include <complex>
#include <vector>

// Worker-only causal FIR design. Ordinary bands retain their complex IIR
// transfer; fractional cuts use real-cepstrum minimum-phase reconstruction.
// The finite -120 dB design floor and tail truncation are explicit limits.
struct BuiltInMinimumEQDesign
{
    using Complex = std::complex<float>;
    static constexpr int analogDelay = 256;
    template <typename Snapshot>
    static std::array<std::vector<Complex>, 4> build(const Snapshot& snapshot, double rate, int size)
    {
        std::array<std::vector<Complex>, 4> transfer;
        for (auto& path : transfer) path.resize(static_cast<size_t>(size));
        std::fill(transfer[0].begin(), transfer[0].end(), Complex{1, 0});
        std::fill(transfer[3].begin(), transfer[3].end(), Complex{1, 0});
        juce::dsp::FFT fft(juce::roundToInt(std::log2(size)));
        std::vector<Complex> band(static_cast<size_t>(size)), cepstrum(static_cast<size_t>(size));
        for (int b = 0; b < snapshot.bands; ++b)
        {
            const auto index = static_cast<size_t>(b);
            if (snapshot.stages[index] == 0 && snapshot.cutModes[index] == 0) continue;
            const bool cut = snapshot.cutModes[index] != 0;
            for (int bin = 0; bin <= size / 2; ++bin)
            {
                const double frequency = static_cast<double>(bin) * rate / size;
                std::complex<double> h{1, 0};
                if (cut)
                {
                    const double cutoff = juce::jlimit(10.0, rate * .475, static_cast<double>(snapshot.cutFrequencies[index]));
                    double magnitude = 1;
                    if (snapshot.cutModes[index] == 2)
                    {
                        const double low = juce::jlimit(0.0, 1.0, .5 + (cutoff - frequency) * size / rate);
                        magnitude = snapshot.highPass[index] ? 1 - low : low;
                    }
                    else if (bin == 0) magnitude = snapshot.highPass[index] ? 0 : 1;
                    else if (bin == size / 2) magnitude = snapshot.highPass[index] ? 1 : 0;
                    else
                    {
                        const double ratio = snapshot.analogResponse ? frequency / cutoff
                            : std::tan(juce::MathConstants<double>::pi * frequency / rate) / std::tan(juce::MathConstants<double>::pi * cutoff / rate);
                        const double exponent = juce::jlimit(3.0, 96.0, static_cast<double>(snapshot.cutSlopes[index])) / 3
                            * std::log(snapshot.highPass[index] ? 1 / ratio : ratio);
                        magnitude = exponent > 80 ? std::exp(-.5 * exponent)
                            : exponent < -80 ? 1 : std::exp(-.5 * std::log1p(std::exp(exponent)));
                    }
                    h = std::log(juce::jmax(1e-6, magnitude));
                }
                else
                {
                    const auto z = std::polar(1.0, snapshot.analogResponse ? -2 * std::atan(juce::MathConstants<double>::pi * frequency / rate)
                        : -juce::MathConstants<double>::twoPi * bin / size);
                    for (int stage = 0; stage < snapshot.stages[index]; ++stage)
                    {
                        const auto& c = snapshot.coefficients[index][static_cast<size_t>(stage)];
                        const auto denominator = 1.0 + static_cast<double>(c[3]) * z + static_cast<double>(c[4]) * z * z;
                        if (std::abs(denominator) > 1e-18)
                            h *= (static_cast<double>(c[0]) + static_cast<double>(c[1]) * z + static_cast<double>(c[2]) * z * z) / denominator;
                    }
                }
                band[static_cast<size_t>(bin)] = static_cast<Complex>(h);
                if (bin > 0 && bin < size / 2) band[static_cast<size_t>(size - bin)] = std::conj(static_cast<Complex>(h));
            }
            if (cut)
            {
                fft.perform(band.data(), cepstrum.data(), true);
                for (int i = 1; i < size / 2; ++i) cepstrum[static_cast<size_t>(i)] *= 2;
                for (int i = size / 2 + 1; i < size; ++i) cepstrum[static_cast<size_t>(i)] = {};
                fft.perform(cepstrum.data(), band.data(), false);
                for (auto& value : band) value = std::exp(value);
            }
            const int target = snapshot.stereoMode == 1 ? 3 : snapshot.stereoMode == 2 ? 4 : snapshot.targets[index];
            for (int bin = 0; bin < size; ++bin)
            {
                BuiltInEQRouting::Matrix matrix;
                for (size_t path = 0; path < 4; ++path) matrix[path] = transfer[path][static_cast<size_t>(bin)];
                matrix = BuiltInEQRouting::multiply(BuiltInEQRouting::band(static_cast<std::complex<double>>(band[static_cast<size_t>(bin)]), target), matrix);
                for (size_t path = 0; path < 4; ++path) transfer[path][static_cast<size_t>(bin)] = static_cast<Complex>(matrix[path]);
            }
        }
        if (snapshot.draftStages > 0)
            for (int bin = 0; bin <= size / 2; ++bin)
            {
                const double frequency = static_cast<double>(bin) * rate / size;
                const auto z = std::polar(1.0, snapshot.analogResponse ? -2 * std::atan(juce::MathConstants<double>::pi * frequency / rate)
                    : -juce::MathConstants<double>::twoPi * bin / size);
                std::complex<double> h{1, 0};
                for (int stage = 0; stage < snapshot.draftStages; ++stage)
                {
                    const auto& c = snapshot.draftCoefficients[static_cast<size_t>(stage)];
                    const auto denominator = 1.0 + static_cast<double>(c[3]) * z + static_cast<double>(c[4]) * z * z;
                    if (std::abs(denominator) > 1e-18) h *= (static_cast<double>(c[0]) + static_cast<double>(c[1]) * z + static_cast<double>(c[2]) * z * z) / denominator;
                }
                for (auto& path : transfer)
                {
                    path[static_cast<size_t>(bin)] *= static_cast<Complex>(h);
                    if (bin > 0 && bin < size / 2) path[static_cast<size_t>(size - bin)] = std::conj(path[static_cast<size_t>(bin)]);
                }
            }
        if (snapshot.analogResponse)
            for (int bin = 0; bin < size; ++bin)
                for (auto& path : transfer)
                    path[static_cast<size_t>(bin)] *= std::polar(1.0f, static_cast<float>(-juce::MathConstants<double>::twoPi * bin * analogDelay / size));
        // A real FIR has real DC/Nyquist values. The analogue target's Nyquist
        // imaginary part is not realizable; qualify the interior audio band.
        for (auto& path : transfer) { path[0] = {path[0].real(), 0}; path[static_cast<size_t>(size / 2)] = {path[static_cast<size_t>(size / 2)].real(), 0}; }
        return transfer;
    }
};
