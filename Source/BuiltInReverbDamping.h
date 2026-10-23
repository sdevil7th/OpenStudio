#pragma once
#include <cmath>

// Preserve the 48 kHz pole's time constant. Call during configure, never in a
// sample loop. This does not claim identical high-frequency digital responses
// near Nyquist or compensate losses elsewhere in a reverb network.
namespace BuiltInReverbDamping
{
inline float pole(float referencePole, double sampleRate) noexcept
{
    if (referencePole <= 0) return 0; // Exact explicit bypass.
    if (sampleRate == 48000.0) return referencePole;
    return static_cast<float>(std::pow(static_cast<double>(referencePole), 48000.0 / sampleRate));
}
inline float alpha(float referenceAlpha, double sampleRate) noexcept
{
    return sampleRate == 48000.0 ? referenceAlpha : 1.0f - pole(1.0f - referenceAlpha, sampleRate);
}
inline float legacyTone(float damping, float cutoff, double sampleRate, bool corrected) noexcept
{
    constexpr float twoPi = 6.2831853071795864769f;
    if (!corrected) return damping * std::exp(-twoPi * cutoff / static_cast<float>(sampleRate));
    return pole(damping * std::exp(-twoPi * cutoff / 48000.0f), sampleRate);
}
}
