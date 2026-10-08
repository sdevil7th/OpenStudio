#pragma once
#include <JuceHeader.h>

// Original digital approximation of a stepped three-band tone section.
// No allocation or coefficient-object reference counting on the callback.
class BuiltInPreampTone
{
public:
    struct Settings { float enabled = 0, lowFrequency = 3, lowGain = 0, midFrequency = 3, midGain = 0, highGain = 0, highPass = 0; };
    static constexpr std::array<double, 5> lowFrequencies { 0, 35, 60, 110, 220 };
    static constexpr std::array<double, 7> midFrequencies { 0, 360, 700, 1600, 3200, 4800, 7200 };
    static constexpr std::array<double, 5> highPassFrequencies { 0, 50, 80, 160, 300 };
    void prepare(double sampleRate)
    {
        rate = sampleRate;
        for (auto& stage : coefficients) for (auto& value : stage) value.reset(rate, .01);
        enabled.reset(rate, .01); reset();
    }
    void reset() noexcept { state = {}; initialized = false; }
    void configure(Settings settings)
    {
        const auto index = [](float value, int maximum) { return std::isfinite(value) ? juce::jlimit(0, maximum, juce::roundToInt(value)) : 0; };
        const auto gain = [](float value, float maximum) { return std::isfinite(value) ? juce::Decibels::decibelsToGain(static_cast<double>(juce::jlimit(-maximum, maximum, value))) : 1.0; };
        const auto frequency = [this](double value) { return juce::jmin(rate * .45, value); };
        const auto set = [this](size_t stage, const std::array<double, 6>& values) {
            for (size_t i = 0; i < 5; ++i)
            {
                const double value = values[i < 3 ? i : i + 1] / values[3];
                if (initialized) coefficients[stage][i].setTargetValue(value); else coefficients[stage][i].setCurrentAndTargetValue(value);
            }
        };
        constexpr std::array<double, 6> identity { 1, 0, 0, 1, 0, 0 };
        using Coefficients = juce::dsp::IIR::ArrayCoefficients<double>;
        const int low = index(settings.lowFrequency, 4), mid = index(settings.midFrequency, 6), hp = index(settings.highPass, 4);
        set(0, low == 0 ? identity : Coefficients::makeLowShelf(rate, frequency(lowFrequencies[static_cast<size_t>(low)]), .7071067811865476, gain(settings.lowGain, 16)));
        set(1, mid == 0 ? identity : Coefficients::makePeakFilter(rate, frequency(midFrequencies[static_cast<size_t>(mid)]), 1.0, gain(settings.midGain, 18)));
        set(2, Coefficients::makeHighShelf(rate, frequency(12000), .7071067811865476, gain(settings.highGain, 16)));
        if (hp == 0) { set(3, identity); set(4, identity); }
        else
        {
            const double cutoff = frequency(highPassFrequencies[static_cast<size_t>(hp)]);
            const auto first = Coefficients::makeFirstOrderHighPass(rate, cutoff);
            set(3, { first[0], first[1], 0, first[2], first[3], 0 });
            set(4, Coefficients::makeHighPass(rate, cutoff, 1.0));
        }
        const float target = settings.enabled >= .5f ? 1.0f : 0.0f;
        if (initialized) enabled.setTargetValue(target); else enabled.setCurrentAndTargetValue(target);
        initialized = true;
    }
    std::array<float, 2> process(float left, float right) noexcept
    {
        const std::array<float, 2> input { left, right }; std::array<float, 2> output = input;
        for (size_t stage = 0; stage < coefficients.size(); ++stage)
        {
            std::array<double, 5> c {};
            for (size_t i = 0; i < c.size(); ++i) c[i] = coefficients[stage][i].getNextValue();
            for (size_t ch = 0; ch < 2; ++ch)
            {
                auto& memory = state[ch][stage]; const double value = output[ch];
                const double filtered = c[0] * value + memory[0];
                memory[0] = c[1] * value - c[3] * filtered + memory[1]; memory[1] = c[2] * value - c[4] * filtered;
                output[ch] = static_cast<float>(filtered);
            }
        }
        const float mix = enabled.getNextValue();
        if (mix == 0) return input; // Bit-exact old preamp path, including signed zero.
        for (size_t ch = 0; ch < 2; ++ch) output[ch] = input[ch] + mix * (output[ch] - input[ch]);
        return output;
    }
private:
    double rate = 192000;
    bool initialized = false;
    juce::SmoothedValue<float> enabled;
    std::array<std::array<juce::SmoothedValue<double>, 5>, 5> coefficients;
    std::array<std::array<std::array<double, 2>, 5>, 2> state {};
};
