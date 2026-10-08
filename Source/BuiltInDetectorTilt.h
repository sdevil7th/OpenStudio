#pragma once
#include <JuceHeader.h>
#include <array>
#include <complex>

// Original bounded +3 dB/octave detector emphasis, unity at 1 kHz.
// Ten bilinear first-order pole/zero pairs approximate s^0.5 between
// analog 8 Hz and 32 kHz. No audio-path filtering or extra host latency.
class BuiltInDetectorTilt
{
public:
    void prepare(double rate, bool enabled)
    {
        const double c = 2 * rate;
        std::complex<double> response {1, 0};
        const auto u = std::polar(1.0, -juce::MathConstants<double>::twoPi * 1000 / rate);
        for (size_t i = 0; i < coefficients.size(); ++i)
        {
            const double zero = juce::MathConstants<double>::twoPi * 8 * std::pow(4000.0, (static_cast<double>(i) + .25) / 10);
            const double pole = juce::MathConstants<double>::twoPi * 8 * std::pow(4000.0, (static_cast<double>(i) + .75) / 10);
            auto& k = coefficients[i]; k = { (c + zero) / (c + pole), (zero - c) / (c + pole), (pole - c) / (c + pole) };
            response *= (k[0] + k[1] * u) / (1.0 + k[2] * u);
        }
        normalisation = 1 / std::abs(response); blend.reset(rate, .02); reset(enabled);
    }
    void reset(bool enabled) noexcept { memory = {}; blend.setCurrentAndTargetValue(enabled ? 1.0f : 0.0f); }
    void configure(bool enabled) noexcept { blend.setTargetValue(enabled ? 1.0f : 0.0f); }
    std::array<float, 2> process(float left, float right) noexcept
    {
        const float wet = blend.getNextValue(); std::array<float, 2> result {left, right};
        for (size_t channel = 0; channel < 2; ++channel)
        {
            double sample = result[channel];
            for (size_t stage = 0; stage < coefficients.size(); ++stage)
            {
                const auto& k = coefficients[stage]; auto& state = memory[channel][stage];
                const double output = k[0] * sample + state; state = k[1] * sample - k[2] * output; sample = output;
            }
            if (wet > 0) result[channel] += wet * (static_cast<float>(sample * normalisation) - result[channel]);
        }
        return result;
    }
private:
    std::array<std::array<double, 3>, 10> coefficients {};
    std::array<std::array<double, 10>, 2> memory {};
    double normalisation = 1;
    juce::SmoothedValue<float> blend;
};
