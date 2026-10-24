#pragma once
#include <array>
#include <cmath>
// A 48 kHz reference one-pole mapped once in prepare, with bounded interpolation.
struct BuiltInRatePole
{
    std::array<float, 2049> table {};
    bool reference = true;
    void prepare(double rate) noexcept
    {
        reference = rate == 48000.0;
        for (size_t i = 0; i < table.size(); ++i)
            table[i] = static_cast<float>(1 - std::pow(1 - static_cast<double>(i) / 2048, 48000.0 / rate));
    }
    float map(float value) const noexcept
    {
        if (!(value > 0)) return 0;
        if (value >= 1) return 1;
        if (reference) return value;
        const float position = value * 2048;
        const auto index = static_cast<size_t>(position);
        return table[index] + (table[index + 1] - table[index]) * (position - static_cast<float>(index));
    }
};
inline float builtInFractionalPhase(float& phase, float increment) noexcept
{
    const float result = phase;
    phase += increment;
    phase -= std::floor(phase);
    return result;
}
