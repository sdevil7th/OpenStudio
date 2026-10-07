#pragma once
#include "BuiltInPeakReconstruction.h"
#include "BuiltInPeakHold.h"
#include <JuceHeader.h>

// Optional telemetry only: finite 8-phase reconstruction, not a protection stage
// or a certified true-peak meter. All histories are fixed storage.
class BuiltInReverbPeakMeter
{
public:
    void reset() noexcept
    {
        input.reset(); output.reset(); hold.reset(); active = false;
        for (auto& value : current) value.store(-100.0f, std::memory_order_relaxed);
    }
    void requestReset() noexcept { hold.requestReset(); }
    bool resetPending() const noexcept { return hold.resetPending(); }
    void beginBlock(bool enabled) noexcept
    {
        const bool clear = enabled != active || hold.resetPending();
        if (clear) { input.reset(); output.reset(); hold.reset(); for (auto& value : current) value.store(-100.0f, std::memory_order_relaxed); }
        active = enabled;
    }
    void process(const juce::AudioBuffer<float>& buffer, bool isOutput) noexcept
    {
        if (!active || buffer.getNumChannels() == 0) return;
        auto& detector = isOutput ? output : input;
        std::array<float, 2> maximum{};
        const auto* left = buffer.getReadPointer(0);
        const auto* right = buffer.getReadPointer(juce::jmin(1, buffer.getNumChannels() - 1));
        for (int i = 0; i < buffer.getNumSamples(); ++i)
        {
            const auto peaks = detector.pushChannels(std::isfinite(left[i]) ? left[i] : 0.0f, std::isfinite(right[i]) ? right[i] : 0.0f);
            for (size_t channel = 0; channel < 2; ++channel) maximum[channel] = juce::jmax(maximum[channel], peaks[channel]);
        }
        for (size_t channel = 0; channel < 2; ++channel)
        {
            const float db = juce::Decibels::gainToDecibels(maximum[channel], -100.0f);
            current[(isOutput ? 2U : 0U) + channel].store(db, std::memory_order_relaxed);
            hold.add(isOutput, channel, db);
        }
    }
    float read(bool isOutput, size_t channel, bool held) const noexcept
    { return held ? hold.read(isOutput, channel) : current[(isOutput ? 2U : 0U) + channel].load(std::memory_order_relaxed); }
private:
    BuiltInPeakReconstruction input, output;
    BuiltInPeakHold hold;
    std::array<std::atomic<float>, 4> current{{-100, -100, -100, -100}};
    bool active = false;
};
