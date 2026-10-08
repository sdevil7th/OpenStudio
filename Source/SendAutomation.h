#pragma once

#include "AutomationList.h"
#include <array>
#include <cmath>

// Owned on the control thread and pinned by immutable routing snapshots.
// Destination IDs, rather than list positions, identify send envelopes.
struct SendAutomationState
{
    AutomationList level, pan, mute, trim;
    std::atomic<float> trimDB { 0.0f };
    std::atomic<bool> bound { false };

    SendAutomationState()
    {
        mute.setInterpolation(AutomationInterpolation::Discrete);
    }
};

inline const std::array<float, 2049> sendPanTable = []
{
    std::array<float, 2049> table {};
    for (size_t i = 0; i < table.size(); ++i)
        table[i] = std::sin(static_cast<float>(i) * juce::MathConstants<float>::halfPi / 2048.0f);
    return table;
}();

inline float sendPanGain(float normalized) noexcept
{
    const auto position = juce::jlimit(0.0f, 1.0f, normalized) * 2048.0f;
    const auto index = juce::jmin(2047, static_cast<int>(position));
    return sendPanTable[static_cast<size_t>(index)]
        + (sendPanTable[static_cast<size_t>(index + 1)] - sendPanTable[static_cast<size_t>(index)])
            * (position - static_cast<float>(index));
}
