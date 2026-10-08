#pragma once
#include <JuceHeader.h>
#include <array>
#include <vector>

// Independent late network for the standalone Nonlinear generator. Storage and
// filter coefficients are prepared/configured outside the sample loop.
class BuiltInNonlinearTail
{
    struct Delay
    {
        std::vector<float> samples;
        size_t position = 0, valid = 0, delayLength = 0;
        void prepare(size_t length, size_t modulationCapacity = 0) { delayLength = length; samples.assign(length + modulationCapacity, 0); reset(); }
        void reset() noexcept { position = 0; valid = 0; }
        float read() const noexcept { return valid >= delayLength ? samples[(position + samples.size() - delayLength) % samples.size()] : 0; }
        float modulated(float offset) const noexcept
        {
            const float delay = juce::jlimit(1.0f, static_cast<float>(samples.size() - 1), static_cast<float>(delayLength) + offset);
            const auto whole = static_cast<size_t>(delay);
            const float fraction = delay - static_cast<float>(whole);
            const auto index = (position + samples.size() - whole) % samples.size();
            const float a = valid >= whole ? samples[index] : 0;
            const float b = valid >= whole + 1 ? samples[(index + samples.size() - 1) % samples.size()] : 0;
            return a + fraction * (b - a);
        }
        void write(float sample) noexcept
        {
            samples[position] = sample;
            position = (position + 1) % samples.size();
            valid = juce::jmin(valid + 1, samples.size());
        }
    };
public:
    void prepare(double sampleRate)
    {
        rate = static_cast<float>(sampleRate);
        constexpr std::array<float, 8> seconds { .0299f, .0371f, .0437f, .0539f, .0593f, .0677f, .0791f, .0899f };
        for (size_t i = 0; i < tank.size(); ++i)
        {
            tank[i].prepare(static_cast<size_t>(rate * seconds[i]) + 1, static_cast<size_t>(std::ceil(rate * .002f)) + 2);
            const float angle = juce::MathConstants<float>::twoPi * static_cast<float>(i) / 8.0f;
            phaseRotations[i] = { std::cos(angle), std::sin(angle) };
        }
        constexpr std::array<float, 4> smear { .0031f, .0043f, .0067f, .0089f };
        for (size_t channel = 0; channel < diffusers.size(); ++channel)
            for (size_t stage = 0; stage < smear.size(); ++stage)
                diffusers[channel][stage].prepare(static_cast<size_t>(rate * (smear[stage] + static_cast<float>(channel) * .0003f)) + 1);
        for (auto& gain : feedback) gain.reset(rate, .05);
        holdWeight.reset(rate,.05);
        reset();
    }
    void reset() noexcept
    {
        resetLate();
        for (auto& channel : diffusers) for (auto& line : channel) line.reset();
    }
    void resetLate() noexcept
    {
        for (auto& line : tank) line.reset();
        damping.fill(0); initialized = false;holdWeight.setCurrentAndTargetValue(0);
    }
    void configure(float decay, float tone, bool hold=false) noexcept
    {
        const float seconds = juce::jlimit(.1f, 20.0f, decay);
        for (size_t i = 0; i < tank.size(); ++i)
        {
            const float gain = hold?1.0f:std::pow(.001f, static_cast<float>(tank[i].delayLength) / (rate * seconds));
            if (initialized) feedback[i].setTargetValue(gain); else feedback[i].setCurrentAndTargetValue(gain);
        }
        dampingCoefficient = juce::jlimit(.03f, .95f, .95f - tone * .9f);
        if(initialized)holdWeight.setTargetValue(hold?1.0f:0.0f);else holdWeight.setCurrentAndTargetValue(hold?1.0f:0.0f);
        initialized = true;
    }
    std::array<float, 2> diffuse(std::array<float, 2> input, float amount) noexcept
    {
        auto result = input;
        for (size_t channel = 0; channel < 2; ++channel)
        {
            float sample = input[channel];
            for (auto& line : diffusers[channel])
            {
                const float output = line.read() - .55f * sample;
                line.write(sample + .55f * output);
                sample = output;
            }
            if (amount > 0) result[channel] += (sample - input[channel]) * amount;
        }
        return result;
    }
    std::array<float, 2> process(const std::array<float, 2>& input, float depthSamples = 0, float phaseSine = 0, float phaseCosine = 1) noexcept
    {
        const float held=holdWeight.getNextValue(),tone=dampingCoefficient+(1-dampingCoefficient)*held;
        std::array<float, 8> taps {};
        float sum = 0;
        for (size_t i = 0; i < tank.size(); ++i)
        {
            taps[i] = depthSamples > 0 ? tank[i].modulated(depthSamples * (phaseSine * phaseRotations[i][0] + phaseCosine * phaseRotations[i][1])) : tank[i].read();
            sum += taps[i];
        }
        std::array<float, 2> wet {};
        for (size_t i = 0; i < tank.size(); ++i)
        {
            const float reflection = taps[i] - .25f * sum;
            damping[i] += tone * (reflection - damping[i]);
            const float next=input[i % 2] * .22f + damping[i] * feedback[i].getNextValue();
            tank[i].write(held>0?juce::jlimit(-4.0f,4.0f,next):next);
            wet[i % 2] += taps[i] * (i < 4 ? .35f : -.35f);
        }
        return wet;
    }
private:
    float rate = 48000, dampingCoefficient = .5f;
    bool initialized = false;
    juce::SmoothedValue<float> holdWeight;
    std::array<Delay, 8> tank;
    std::array<std::array<Delay, 4>, 2> diffusers;
    std::array<float, 8> damping {};
    std::array<std::array<float, 2>, 8> phaseRotations {};
    std::array<juce::SmoothedValue<float>, 8> feedback;
};
