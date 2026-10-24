#pragma once
#include <JuceHeader.h>
#include <array>
#include <vector>

// Short signed FIR readout diffusion, outside every feedback loop. The prepared
// tap positions and unit-energy coefficients are deterministic; they do not
// imply loudness matching or a measured acoustic response. Original bypass is
// exact and does not run or record this optional history.
class BuiltInReverbSparseDiffusion
{
public:
    using Pair = std::array<float, 2>;
    static constexpr size_t tapCount = 8;

    void prepare(double sampleRate)
    {
        const double rate = juce::jmax(8000.0, sampleRate);
        constexpr std::array<std::array<double, tapCount>, 2> milliseconds {{
            {{0, 1.1, 2.7, 4.9, 6.7, 8.9, 11.3, 13.9}},
            {{0, 1.3, 3.1, 4.3, 7.3, 9.7, 12.1, 14.7}}
        }};
        int capacity = 1;
        for (size_t channel = 0; channel < 2; ++channel)
            for (size_t tap = 0; tap < tapCount; ++tap)
            {
                delays[channel][tap] = juce::roundToInt(milliseconds[channel][tap] * rate * .001);
                capacity = juce::jmax(capacity, delays[channel][tap] + 1);
            }
        history.assign(static_cast<size_t>(capacity), {});
        blend.reset(rate, .05);
        processed = 0;
        reset();
    }

    void reset() noexcept
    {
        position = valid = 0;
        blend.setCurrentAndTargetValue(0);
        initialized = false;
    }

    void configure(bool refined) noexcept
    {
        const float target = refined ? 1.0f : 0.0f;
        if (initialized) blend.setTargetValue(target);
        else blend.setCurrentAndTargetValue(target);
        initialized = true;
    }

    Pair process(Pair input) noexcept
    {
        const float amount = blend.getNextValue();
        if (amount == 0)
        {
            // Drop stale readout history when a live fade reaches Original.
            position = valid = 0;
            return input;
        }
        if (history.empty()) return input;
        ++processed;
        history[static_cast<size_t>(position)] = input;
        valid = juce::jmin(valid + 1, static_cast<int>(history.size()));
        Pair output {};
        constexpr std::array<float, tapCount> coefficients {
            .35355339f, .35355339f, -.35355339f, .35355339f,
            -.35355339f, .35355339f, .35355339f, -.35355339f
        };
        const int capacity = static_cast<int>(history.size());
        for (size_t channel = 0; channel < 2; ++channel)
        {
            float diffused = 0;
            for (size_t tap = 0; tap < tapCount; ++tap)
            {
                const int delay = delays[channel][tap];
                if (delay < valid)
                    diffused += history[static_cast<size_t>((position + capacity - delay) % capacity)][channel]
                        * coefficients[tap];
            }
            output[channel] = amount == 1 ? diffused : input[channel] + amount * (diffused - input[channel]);
        }
        if (++position == capacity) position = 0;
        return output;
    }

    juce::uint64 processedFrames() const noexcept { return processed; }
    const auto& tapDelays() const noexcept { return delays; }
    int supportSamples() const noexcept { return juce::jmax(0, static_cast<int>(history.size()) - 1); }

private:
    std::vector<Pair> history;
    std::array<std::array<int, tapCount>, 2> delays {};
    juce::SmoothedValue<float> blend;
    int position = 0, valid = 0;
    juce::uint64 processed = 0;
    bool initialized = false;
};
