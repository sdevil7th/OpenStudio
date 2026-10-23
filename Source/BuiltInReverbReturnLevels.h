#pragma once
#include <JuceHeader.h>
#include <array>

// Declared, bounded readout trims for the standalone default voices. These are
// fixed design choices, not runtime loudness matching or feedback gains. Native
// multi-material measurements qualify levels; perceived balance needs audition.
namespace BuiltInReverbReturnLevels
{
inline constexpr std::array<float, 41> decibels {
    14.5f,17.5f,12.5f,15.5f,10,15,30,12,16.5f,9.5f,15,18.5f,10,16.5f,0,
    26.5f,8,26,23.5f,24,21.5f,17.5f,14.5f,17.5f,24,12,19,19.5f,20,9.5f,
    18,22.5f,10,19.5f,16.5f,19.5f,5,17.5f,13,15,18
};
inline constexpr std::array<float, 41> linear {
    5.308844442f,7.498942093f,4.216965034f,5.956621435f,3.162277660f,
    5.623413252f,31.622776602f,3.981071706f,6.683439176f,2.985382619f,
    5.623413252f,8.413951416f,3.162277660f,6.683439176f,1.0f,
    21.134890398f,2.511886432f,19.952623150f,14.962356561f,15.848931925f,
    11.885022274f,7.498942093f,5.308844442f,7.498942093f,15.848931925f,
    3.981071706f,8.912509381f,9.440608763f,10.0f,2.985382619f,
    7.943282347f,13.335214322f,3.162277660f,9.440608763f,6.683439176f,
    9.440608763f,1.778279410f,7.498942093f,4.466835922f,5.623413252f,
    7.943282347f
};
inline float gain(int type, float blend) noexcept
{
    if (blend == 0 || !std::isfinite(blend) || type < 0 || type >= static_cast<int>(linear.size()))
        return 1;
    const float target = linear[static_cast<size_t>(type)];
    if (target == 1) return 1;
    if (blend >= 1) return target;
    return blend > 0 ? 1 + blend * (target - 1) : 1;
}
inline float weighted(float weight, int type, float blend) noexcept
{
    const float amount = gain(type, blend);
    return amount == 1 ? weight : weight * amount; // Original is an exact bypass.
}
}
