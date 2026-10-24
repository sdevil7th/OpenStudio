#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <cmath>

namespace BuiltInFilterTail
{
// A conservative modal decay allowance (180 dB, doubled for polynomial factors
// from repeated poles). This is an export bound, not an acoustic RT60 estimate.
inline double pole(double radius, double rate) noexcept
{
    if (!(radius > 0)) return 0;
    if (!std::isfinite(radius) || radius >= 1) return 120;
    return 2 * std::log(1.0e-9) / (std::log(radius) * juce::jmax(1.0, rate));
}
template<class Coefficients>
double biquad(const Coefficients& c, double rate) noexcept
{
    if (c[0] == 1 && c[1] == c[3] && c[2] == c[4]) return 0;
    const double a1 = c[3], a2 = c[4], discriminant = a1 * a1 - 4 * a2;
    const double radius = discriminant < 0 ? std::sqrt(std::abs(a2))
        : .5 * juce::jmax(std::abs(-a1 + std::sqrt(discriminant)), std::abs(-a1 - std::sqrt(discriminant)));
    return pole(radius, rate);
}
inline double retain(std::atomic<double>& previous, double requested) noexcept
{
    double value = previous.load(std::memory_order_relaxed);
    while (value < requested && !previous.compare_exchange_weak(value, requested, std::memory_order_relaxed)) {}
    return juce::jmax(value, requested);
}
}
