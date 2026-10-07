#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <vector>

// Original post-delay wet diffuser. The main repeat timing and feedback are
// unchanged; Span controls the total all-pass delay after that repeat.
class BuiltInDelayDiffusion
{
public:
    void prepare(double sampleRate, float amount, float spanMs)
    {
        rate = juce::jmax(1.0, sampleRate);
        for (auto& channel : stages) for (auto& stage : channel)
            stage.ring.assign(static_cast<size_t>(std::ceil(rate * .076)) + 4, 0.0f);
        blend.reset(rate, .025); span.reset(rate, .08);
        reset(amount, spanMs);
    }
    void reset(float amount, float spanMs) noexcept
    {
        clearHistory(); blend.setCurrentAndTargetValue(bounded(amount, 0, 1, 0));
        span.setCurrentAndTargetValue(bounded(spanMs, 5, 200, 40)); publishTail();
    }
    void configure(float amount, float spanMs) noexcept
    {
        blend.setTargetValue(bounded(amount, 0, 1, 0));
        span.setTargetValue(bounded(spanMs, 5, 200, 40)); publishTail();
    }
    void process(float& left, float& right) noexcept
    {
        const float amount = blend.getNextValue();
        const float length = span.getNextValue();
        if (amount == 0 && !blend.isSmoothing())
        {
            if (running) clearHistory();
            return;
        }
        running = true;
        constexpr float weights[2][4] {{.137f,.193f,.293f,.377f}, {.149f,.211f,.277f,.363f}};
        float values[2] {left, right};
        for (size_t ch = 0; ch < 2; ++ch)
            for (size_t index = 0; index < 4; ++index)
                values[ch] = stages[ch][index].process(values[ch], static_cast<float>(rate * .001) * length * weights[ch][index]);
        left += amount * (values[0] - left); right += amount * (values[1] - right);
    }
    double tailSeconds() const noexcept { return tail.load(std::memory_order_relaxed); }
private:
    struct Stage
    {
        std::vector<float> ring; int write = 0, valid = 0;
        float process(float input, float delay) noexcept
        {
            if (ring.empty()) return input;
            const int size = static_cast<int>(ring.size());
            const float boundedDelay = juce::jlimit(1.0f, static_cast<float>(size - 2), delay);
            const int distance = static_cast<int>(boundedDelay); const float fraction = boundedDelay - static_cast<float>(distance);
            const auto read = [&](int age) noexcept { return age <= valid ? ring[static_cast<size_t>((write - age + size) % size)] : 0.0f; };
            const float delayed = read(distance) * (1 - fraction) + read(distance + 1) * fraction;
            constexpr float coefficient = .72f;
            const float output = delayed - coefficient * input;
            ring[static_cast<size_t>(write)] = input + coefficient * output;
            write = (write + 1) % size; valid = juce::jmin(valid + 1, size - 1);
            return output;
        }
    };
    static float bounded(float value, float low, float high, float fallback) noexcept
    { return std::isfinite(value) ? juce::jlimit(low, high, value) : fallback; }
    void clearHistory() noexcept
    { for (auto& channel : stages) for (auto& stage : channel) stage.write = stage.valid = 0; running = false; }
    void publishTail() noexcept
    { tail.store(blend.getCurrentValue() > 0 || blend.getTargetValue() > 0 ? .06 * juce::jmax(span.getCurrentValue(), span.getTargetValue()) : 0.0, std::memory_order_relaxed); }
    std::array<std::array<Stage, 4>, 2> stages;
    juce::SmoothedValue<float> blend, span;
    std::atomic<double> tail {0}; double rate = 48000; bool running = false;
};
