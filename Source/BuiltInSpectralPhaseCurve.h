#pragma once
#include <JuceHeader.h>
#include <array>
#include <cmath>

// Saved in absolute Hz/degrees, independent of render sample rate and FFT size.
namespace BuiltInSpectralPhaseCurve
{
static constexpr size_t points = 48;
using Curve = std::array<float, points>;
inline double frequency(size_t point) noexcept { return 20 * std::pow(1000.0, static_cast<double>(point) / (points - 1)); }
inline double radians(const Curve& curve, double hz, double rate) noexcept
{
    if (hz <= 0 || hz >= rate * .5) return 0;
    const double at = juce::jlimit(0.0, static_cast<double>(points - 1), std::log(hz / 20) / std::log(1000.0) * (points - 1));
    const auto a = static_cast<size_t>(at), b = juce::jmin(a + 1, points - 1);
    double degrees = curve[a] + (at - static_cast<double>(a)) * (curve[b] - curve[a]);
    if (hz < 20) degrees *= hz / 20;
    const double end = juce::jmin(20000.0, rate * .45);
    if (hz > end) degrees *= (rate * .5 - hz) / (rate * .5 - end);
    return degrees * juce::MathConstants<double>::pi / 180;
}
}
