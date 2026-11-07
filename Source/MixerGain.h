#pragma once
#include <JuceHeader.h>

namespace MixerGain
{
// The UI persists a finite floor for project compatibility and displays it as
// -infinity. Apply the same silence contract to static, automated and offline gain.
constexpr float silenceDb = -60.0f;
inline float fromDecibels(float value) noexcept
{
    return juce::Decibels::decibelsToGain(value, silenceDb);
}
}
