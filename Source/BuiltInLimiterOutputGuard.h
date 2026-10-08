#pragma once
#include <JuceHeader.h>
#include "BuiltInPeakReconstruction.h"

// Native-rate protection after FIR downsampling. Its delay is explicit in host
// PDC even with True Peak off. Storage and queue work are bounded per sample.
class BuiltInLimiterOutputGuard final
{
public:
    static constexpr int latency = 64;
    void prepare(double rate, float ceiling)
    {
        release = static_cast<float>(std::exp(-1 / (rate * .05)));
        ceilingGain.reset(rate, .02); reset(ceiling);
    }
    void reset(float ceiling) noexcept
    {
        for (auto& channel : history) channel.fill(0);
        reconstruction.reset(); position = head = count = 0; clock = 0; gain = 1;
        ceilingGain.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(-3.0f, 0.0f, ceiling)));
    }
    float process(juce::AudioBuffer<float>& audio, float ceiling, bool truePeak) noexcept
    {
        ceilingGain.setTargetValue(juce::Decibels::decibelsToGain(juce::jlimit(-3.0f, 0.0f, ceiling)));
        float minimum = 1;
        for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            const float left = safe(audio.getSample(0, i)), right = safe(audio.getSample(audio.getNumChannels() > 1 ? 1 : 0, i));
            history[0][position] = left; history[1][position] = right;
            const float reconstructed = reconstruction.push(left, right);
            const float peak = truePeak ? juce::jmax(reconstructed, std::abs(left), std::abs(right)) : juce::jmax(std::abs(left), std::abs(right));
            while (count > 0 && times[head] + capacity - 1 <= clock) { head = (head + 1) % capacity; --count; }
            while (count > 0 && peaks[(head + count - 1) % capacity] <= peak) --count;
            const size_t tail = (head + count) % capacity; peaks[tail] = peak; times[tail] = clock++; ++count;
            const float ceilingValue = ceilingGain.getNextValue();
            const float requested = juce::jmin(1.0f, ceilingValue * (truePeak ? .9440609f : 1.0f) / juce::jmax(1e-9f, peaks[head]));
            gain = requested <= gain ? requested : release * gain + (1 - release) * requested;
            const size_t read = (position + 1) % (latency + 1);
            for (int channel = 0; channel < audio.getNumChannels(); ++channel)
                audio.setSample(channel, i, juce::jlimit(-ceilingValue, ceilingValue, history[static_cast<size_t>(channel)][read] * gain));
            position = read; minimum = juce::jmin(minimum, gain);
        }
        return minimum;
    }
private:
    static float safe(float value) noexcept { return std::isfinite(value) ? value : 0; }
    static constexpr size_t capacity = latency + BuiltInPeakReconstruction::taps + 1;
    std::array<std::array<float, latency + 1>, 2> history {};
    std::array<float, capacity> peaks {};
    std::array<juce::uint64, capacity> times {};
    BuiltInPeakReconstruction reconstruction;
    juce::SmoothedValue<float> ceilingGain;
    size_t position = 0, head = 0, count = 0;
    juce::uint64 clock = 0;
    float gain = 1, release = 0;
};
