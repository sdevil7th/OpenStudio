#pragma once
#include <JuceHeader.h>
#include <complex>

class BuiltInGraphicEQ
{
public:
    static constexpr size_t bandCount = 31;
    inline static constexpr std::array<double, bandCount> frequencies { 20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000 };
    using Coefficients = std::array<double, 5>;
    struct Settings { std::array<float, bandCount> gains {}; float mode = 0, target = 0, highPass = 20, lowPass = 20000, highPassEnabled = 0, lowPassEnabled = 0; };
    static Coefficients peak(double rate, double frequency, double gain, double q)
    {
        const double w = juce::MathConstants<double>::twoPi * juce::jmin(frequency, rate * .45) / rate;
        const double a = std::pow(10.0, gain / 40), alpha = std::sin(w) / (2*q), a0 = 1 + alpha/a;
        return { (1+alpha*a)/a0, -2*std::cos(w)/a0, (1-alpha*a)/a0, -2*std::cos(w)/a0, (1-alpha/a)/a0 };
    }
    static Coefficients cut(double rate, double frequency, bool highPass, bool enabled)
    {
        if (!enabled) return { 1,0,0,0,0 };
        const double w = juce::MathConstants<double>::twoPi * juce::jlimit(10.0, rate * .45, frequency) / rate;
        const double c = std::cos(w), alpha = std::sin(w) / std::sqrt(2.0), a0 = 1+alpha;
        const double b = highPass ? (1+c)*.5 : (1-c)*.5;
        return { b/a0, (highPass ? -2 : 2)*b/a0, b/a0, -2*c/a0, (1-alpha)/a0 };
    }
    static double magnitude(const Coefficients& c, double rate, double frequency)
    {
        const auto z = std::polar(1.0, -juce::MathConstants<double>::twoPi * frequency / rate);
        return std::abs((c[0]+c[1]*z+c[2]*z*z)/(1.0+c[3]*z+c[4]*z*z));
    }
    static double q() noexcept { return 1 / (std::pow(2.0, 1.0/6)-std::pow(2.0, -1.0/6)); }
    void prepare(double sampleRate)
    {
        rate = sampleRate; mode.reset(rate, .01);
        for (auto& weight : targetWeights) weight.reset(rate, .01);
        for (auto& gain : gains) gain.reset(rate, .01);
        coefficientStep = 1 - std::exp(-1 / (rate * .01)); reset();
    }
    void reset() noexcept { states = {}; cutStates = {}; initialized = false; counter = 0; lastGain.fill(1000); }
    void configure(const Settings& settings)
    {
        const auto set = [this](auto& smoother, float target) { if (initialized) smoother.setTargetValue(target); else smoother.setCurrentAndTargetValue(target); };
        set(mode, settings.mode >= .5f ? 1.0f : 0.0f);
        const int target = juce::jlimit(0, 4, juce::roundToInt(settings.target));
        for (size_t i = 0; i < 5; ++i) set(targetWeights[i], target == static_cast<int>(i) ? 1.0f : 0.0f);
        for (size_t i = 0; i < bandCount; ++i) set(gains[i], juce::jlimit(-12.0f, 12.0f, settings.gains[i]));
        cutTargets = { cut(rate, settings.highPass, true, settings.highPassEnabled >= .5f), cut(rate, settings.lowPass, false, settings.lowPassEnabled >= .5f) };
        if (!initialized) cuts = cutTargets;
        initialized = true;
    }
    std::array<float, 2> process(float left, float right, float legacyLeft, float legacyRight) noexcept
    {
        const float blend = mode.getNextValue();
        // Consume gains even while the new bank is dormant; no callback allocation.
        for (size_t i = 0; i < bandCount; ++i)
        {
            const float gain = gains[i].getNextValue();
            if (counter % 16 == 0 && gain != lastGain[i]) { coefficients[i] = peak(rate, frequencies[i], gain, q()); lastGain[i] = gain; }
        }
        ++counter;
        for (size_t filter = 0; filter < 2; ++filter) for (size_t i = 0; i < 5; ++i)
        {
            const double delta = cutTargets[filter][i] - cuts[filter][i];
            cuts[filter][i] = std::abs(delta) < 1e-12 ? cutTargets[filter][i] : cuts[filter][i] + delta * coefficientStep;
        }
        const std::array<double, 2> dry { left, right };
        std::array<double, 2> filtered { legacyLeft, legacyRight };
        for (size_t ch = 0; ch < 2; ++ch)
        {
            // A shared linear filter commutes with the M/S matrix, so only two
            // filter histories are needed for all five channel targets.
            double third = dry[ch];
            for (size_t i = 0; i < bandCount; ++i) third = filterSample(third, coefficients[i], states[ch][i]);
            if (blend > 0) filtered[ch] = blend == 1 ? third : filtered[ch] + (third-filtered[ch])*blend;
            for (size_t i = 0; i < 2; ++i) filtered[ch] = filterSample(filtered[ch], cuts[i], cutStates[ch][i]);
        }
        std::array<double, 2> output {}; double weightSum = 0;
        for (size_t i = 0; i < 5; ++i)
        {
            const double weight = targetWeights[i].getNextValue(); weightSum += weight;
            std::array<double, 2> signal = filtered;
            if (i == 1) signal[1] = dry[1];
            if (i == 2) signal[0] = dry[0];
            if (i == 3) signal = { (filtered[0]+filtered[1]+dry[0]-dry[1])*.5, (filtered[0]+filtered[1]-dry[0]+dry[1])*.5 };
            if (i == 4) signal = { (dry[0]+dry[1]+filtered[0]-filtered[1])*.5, (dry[0]+dry[1]-filtered[0]+filtered[1])*.5 };
            for (size_t ch = 0; ch < 2; ++ch) output[ch] += signal[ch]*weight;
        }
        const double scale = juce::jmax(1e-12, weightSum);
        return { static_cast<float>(output[0]/scale), static_cast<float>(output[1]/scale) };
    }
private:
    static double filterSample(double input, const Coefficients& c, std::array<double, 2>& z) noexcept
    {
        const double output = c[0]*input+z[0]; z[0]=c[1]*input-c[3]*output+z[1]; z[1]=c[2]*input-c[4]*output; return output;
    }
    double rate = 48000, coefficientStep = 1;
    bool initialized = false;
    unsigned int counter = 0;
    juce::SmoothedValue<float> mode;
    std::array<juce::SmoothedValue<float>, 5> targetWeights;
    std::array<juce::SmoothedValue<float>, bandCount> gains;
    std::array<float, bandCount> lastGain {};
    std::array<Coefficients, bandCount> coefficients {};
    std::array<Coefficients, 2> cuts {}, cutTargets {};
    std::array<std::array<std::array<double, 2>, bandCount>, 2> states {};
    std::array<std::array<std::array<double, 2>, 2>, 2> cutStates {};
};
