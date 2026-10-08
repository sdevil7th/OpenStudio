#pragma once
#include "BuiltInAllPassFit.h"
#include "BuiltInLinearPhaseEQ.h"

struct BuiltInSpectralPhaseFit
{
    BuiltInSpectralPhaseCurve::Curve curve {};
    bool applied = false;
    double before = 0, after = 0, maximumRippleDB = 0;
    juce::String reason = "Time-only recommendation";
};

// Original worker-only regularized cross-spectrum fit. The first half trains;
// the second half independently qualifies the actual windowed FIR response.
inline BuiltInSpectralPhaseFit fitBuiltInSpectralPhase(const std::array<const float*,2>& reference,
    const std::array<const float*,2>& target, int channels, int count, double rate,
    const BuiltInAlignmentEstimate& timing, const std::function<bool()>& keepRunning = {})
{
    using namespace BuiltInAllPassFitting;
    BuiltInSpectralPhaseFit result;
    if (!timing.accepted) { result.reason = "Time estimate was not accepted"; return result; }
    std::vector<Evidence> sets;
    for (int ch = 0; ch < channels; ++ch)
    {
        auto measured = evidence(reference[static_cast<size_t>(ch)], target[static_cast<size_t>(ch)], count, rate, timing);
        if (!measured.supported) { result.reason = "Insufficient broadband coherent evidence"; return result; }
        sets.push_back(std::move(measured));
    }
    if (sets.empty()) return result;
    std::vector<Bin> training;
    for (const auto& set : sets) for (const auto& bin : set.halves[0]) training.push_back(bin);
    std::sort(training.begin(), training.end(), [](const auto& a, const auto& b) { return a.omega < b.omega; });
    std::vector<Bin> merged;
    for (size_t i = 0; i < training.size();)
    {
        const double omega = training[i].omega; std::complex<double> sum {}; double weight = 0;
        do { sum += std::polar(training[i].weight, training[i].phase); weight += training[i++].weight; }
        while (i < training.size() && training[i].omega == omega);
        double phase = std::arg(sum);
        if (!merged.empty()) phase = merged.back().phase + std::remainder(phase - merged.back().phase, juce::MathConstants<double>::twoPi);
        merged.push_back({omega, phase, weight});
    }
    for (size_t point = 0; point < result.curve.size(); ++point)
    {
        const double hz = BuiltInSpectralPhaseCurve::frequency(point);
        const double omega = juce::MathConstants<double>::twoPi * hz / rate;
        double sum = 0, total = 0;
        for (const auto& bin : merged)
        {
            const double distance = std::log2(omega / bin.omega) / .22;
            const double weight = bin.weight * std::exp(-.5 * distance * distance);
            sum += bin.phase * weight; total += weight;
        }
        const double phase = total > 1e-12 ? sum / total : omega < merged.front().omega ? merged.front().phase : merged.back().phase;
        result.curve[point] = static_cast<float>(juce::jlimit(-1440.0, 1440.0, -phase * 180 / juce::MathConstants<double>::pi));
    }
    if (keepRunning && !keepRunning()) { result.reason = "Spectral phase fit canceled"; return result; }
    // Qualify the finite FIR, including its truncation ripple, not just the ideal
    // curve. These buffers and FFTs are constructed only on this analysis worker.
    BuiltInLinearPhaseEQ processor; BuiltInLinearPhaseEQ::Snapshot snapshot;
    snapshot.spectralPhase = true; snapshot.quality = 1; snapshot.phaseCurves = {result.curve, result.curve};
    processor.prepare(rate, snapshot, true);
    constexpr int size = 16384;
    std::vector<std::complex<float>> impulse(size), response(size);
    for (int i = 0; i < size; ++i) impulse[static_cast<size_t>(i)] = processor.process(i == 0 ? 1.0f : 0, 0)[0];
    juce::dsp::FFT fft(14); fft.perform(impulse.data(), response.data(), false);
    bool stable = true; double beforeSum = 0, afterSum = 0;
    for (const auto& set : sets) for (const auto& half : set.halves)
    {
        double before = 0, after = 0;
        for (const auto& bin : half)
        {
            const auto at = static_cast<size_t>(juce::jlimit(1, size/2-1, juce::roundToInt(bin.omega * size / juce::MathConstants<double>::twoPi)));
            const double omega = juce::MathConstants<double>::twoPi * static_cast<double>(at) / size;
            const auto h = static_cast<std::complex<double>>(response[at]) * std::polar(1.0, omega * BuiltInLinearPhaseEQ::latency(1));
            result.maximumRippleDB = juce::jmax(result.maximumRippleDB, std::abs(juce::Decibels::gainToDecibels(std::abs(h), -120.0)));
            before += bin.weight * std::cos(bin.phase);
            after += bin.weight * std::cos(bin.phase + std::arg(h));
        }
        beforeSum += before; afterSum += after;
        stable = stable && after > .85 && after > before + .015 && (1-after) < (1-before)*.75;
    }
    result.before = beforeSum / static_cast<double>(sets.size()*2);
    result.after = afterSum / static_cast<double>(sets.size()*2);
    result.applied = stable && result.maximumRippleDB < 1.0;
    result.reason = result.applied ? "Saved FIR improves independent capture sections" : "No stable spectral improvement within the FIR ripple limit";
    if (!result.applied) result.curve.fill(0);
    return result;
}
