#pragma once

#include <algorithm>
#include <cmath>
#include <limits>

// Tail planning only: keep the instruments' existing float envelope and saved
// sound unchanged. Repeated float subtraction is not exact at long releases /
// high rates, so nominal milliseconds alone can underestimate the last sample.
namespace BuiltInInstrumentTail
{
inline double linearRelease(double sampleRate, float releaseMs, float speed = 1) noexcept
{
    const float rate = static_cast<float>(std::max(1.0, sampleRate));
    const float step = (1.0f / std::max(1.0f, rate * releaseMs * .001f)) * speed;
    if (!std::isfinite(step) || step <= 0)
        return std::numeric_limits<double>::infinity();

    double samples = 1;
    // All envelope values start at or below one. Within each binary exponent
    // interval, subtraction has the same spacing. Check both mantissa parities
    // to cover round-to-even ties; allow two extra samples at every boundary.
    for (float upper = 1; upper > step; upper *= .5f)
    {
        const float odd = std::nextafter(upper, 0.0f);
        const float even = std::nextafter(odd, 0.0f);
        const double decrement = std::min(static_cast<double>(odd) - (odd - step),
                                         static_cast<double>(even) - (even - step));
        if (decrement <= 0)
            return std::numeric_limits<double>::infinity();
        samples += std::ceil(static_cast<double>(upper) * .5 / decrement) + 2;
    }
    return samples / sampleRate;
}

inline float positive(float value, float fallback) noexcept
{
    return std::isfinite(value) && value > 0 ? value : fallback;
}

// The passive body network's slowest pole loses 60 dB per bodyDecay seconds.
// Three decay periods after the final excitation leave 180 dB of attenuation;
// this also covers its internal summing headroom. This is an audible tail
// estimate, not a promise that every double-precision resonator is exactly zero.
inline double body(float amount, float decay) noexcept
{
    const double duration = std::isfinite(decay) ? static_cast<double>(decay) : 2.0;
    return amount > 0 ? 3.0 * std::clamp(duration, .2, 8.0) : 0.0;
}
}
