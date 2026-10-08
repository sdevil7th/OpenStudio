#pragma once
#include <JuceHeader.h>
#include "BuiltInOriginalColour.h"

// Original RMS VCA responses and independent L/R or M/S histories.
// No claim of measured analogue circuitry or hardware time-constant matching.
class BuiltInVCACompressor
{
public:
    enum Field : size_t { Input, Threshold, Ratio, Infinity, Output, Attack, Release, AutoRelease, HighPass, Count };
    struct Spec { const char* id; const char* label; float min, max, initial; const char* unit; bool toggle; };
    static Spec spec(size_t field, bool punch)
    {
        switch (field)
        {
            case Input: return { "Input", "Input", punch ? -20.0f : -18.0f, punch ? 20.0f : 18.0f, 0, "dB", false };
            case Threshold: return { "Threshold", "Threshold", punch ? -60.0f : -50.0f, punch ? -9.0f : -10.0f, -18, "dB", false };
            case Ratio: return { "Ratio", "Ratio", punch ? 1.0f : 1.5f, 100, punch ? 4.0f : 2.0f, ":1", false };
            case Infinity: return { "Infinity", "Infinity ratio", 0, 1, 0, "", true };
            case Output: return { "Output", "Output", punch ? -20.0f : 0.0f, punch ? 20.0f : 40.0f, 0, "dB", false };
            case Attack: return { "Attack", "Attack", .3f, 50, 15, "ms", false };
            case Release: return { "Release", "Release", 100, 4000, 180, "ms", false };
            case AutoRelease: return { "AutoRelease", "Auto Release", 0, 1, 0, "", true };
            default: return { "HighPass", "SC 90 Hz", 0, 1, 0, "", true };
        }
    }
    static bool applicable(size_t field, bool punch) noexcept { return !punch || field < Attack || field == HighPass; }
    using Channel = std::array<float, Count>;
    struct Settings { std::array<Channel, 2> channels {}; int routing = 0; };
    static Settings defaults(bool punch)
    {
        Settings settings;
        for (auto& channel : settings.channels) for (size_t i = 0; i < Count; ++i) channel[i] = spec(i, punch).initial;
        return settings;
    }
    void prepare(double sampleRate, bool punchModel, bool originalStages = false)
    {
        rate = sampleRate; punch = punchModel;
        for (auto& mode : lanes) for (auto& lane : mode) lane.prepare(rate, punch);
        for (auto& weight : weights) weight.reset(rate, .02);
        colourEnabled = originalStages;
        if (colourEnabled) for (auto& stage : colour) stage.prepare(rate, punch ? BuiltInOriginalColour::PunchVCA : BuiltInOriginalColour::BusVCA);
        reset();
    }
    void reset() noexcept
    {
        for (auto& mode : lanes) for (auto& lane : mode) lane.reset();
        for (auto& stage : colour) stage.reset();
        initialized = false; reduction = 0;
    }
    void configure(const Settings& settings)
    {
        const int routing = juce::jlimit(0, 2, settings.routing);
        for (size_t mode = 0; mode < 3; ++mode)
        {
            const float target = mode == static_cast<size_t>(routing) ? 1.0f : 0.0f;
            if (initialized) weights[mode].setTargetValue(target); else weights[mode].setCurrentAndTargetValue(target);
            for (size_t ch = 0; ch < 2; ++ch) lanes[mode][ch].configure(settings.channels[mode == 0 ? 0 : ch]);
        }
        initialized = true;
    }
    std::array<float, 2> process(float left, float right, float detectorLeft, float detectorRight, double headroomGain = 1) noexcept
    {
        constexpr double invSqrt2 = .7071067811865475244;
        std::array<double, 2> output {}; reduction = 0; double weightSum = 0;
        for (size_t mode = 0; mode < 3; ++mode)
        {
            const double weight = weights[mode].getNextValue(); weightSum += weight;
            const std::array<double, 2> audio = mode == 2 ? std::array<double, 2> { (left + right) * invSqrt2, (left - right) * invSqrt2 } : std::array<double, 2> { left, right };
            const std::array<double, 2> detector = mode == 2 ? std::array<double, 2> { (detectorLeft + detectorRight) * invSqrt2, (detectorLeft - detectorRight) * invSqrt2 } : std::array<double, 2> { detectorLeft, detectorRight };
            std::array<double, 2> wet {};
            std::array<double, 2> inputGains {}, reductionGains {}, outputGains {};
            double modeReduction = 0;
            for (size_t ch = 0; ch < 2; ++ch)
            {
                auto& lane = lanes[mode][ch];
                const double gain = lane.process(mode == 0 ? detector[0] : detector[ch], mode == 0 ? detector[1] : detector[ch]);
                wet[ch] = audio[ch] * gain; modeReduction = juce::jmax(modeReduction, lane.reduction);
                if (colourEnabled) { inputGains[ch] = lane.lastInput; outputGains[ch] = lane.lastOutput; reductionGains[ch] = gain / (lane.lastInput * lane.lastOutput); }
            }
            if (colourEnabled)
            {
                const auto coloured = colour[mode].process(audio, inputGains, reductionGains, outputGains, headroomGain);
                wet = { coloured[0], coloured[1] };
            }
            if (mode == 2) wet = { (wet[0] + wet[1]) * invSqrt2, (wet[0] - wet[1]) * invSqrt2 };
            for (size_t ch = 0; ch < 2; ++ch) output[ch] += wet[ch] * weight;
            reduction += modeReduction * weight;
        }
        const double scale = juce::jmax(1.0e-12, weightSum); reduction /= scale;
        return { static_cast<float>(output[0] / scale), static_cast<float>(output[1] / scale) };
    }
    double gainReduction() const noexcept { return reduction; }
private:
    struct Lane
    {
        double rate = 48000, power = 0, reduction = 0, memory = 0, rmsCoefficient = 0, memoryCoefficient = 0, hpCoefficient = 0;
        double attackCoefficient = 0, releaseCoefficient = 0;
        double lastInput = 1, lastOutput = 1;
        std::array<double, 2> low {};
        bool punch = false, initialized = false, automatic = false;
        juce::SmoothedValue<double> input, output, threshold, slope, highPass;
        void prepare(double fs, bool isPunch)
        {
            rate = fs; punch = isPunch; rmsCoefficient = std::exp(-1 / (rate * (punch ? .001 : .002)));
            memoryCoefficient = std::exp(-1 / (rate * .3)); hpCoefficient = std::exp(-juce::MathConstants<double>::twoPi * 90 / rate);
            for (auto* smoother : { &input, &output, &threshold, &slope, &highPass }) smoother->reset(rate, .02);
            reset();
        }
        void reset() noexcept { power = reduction = memory = 0; low.fill(0); initialized = false; }
        void configure(const Channel& values)
        {
            const auto value = [&](size_t field) { const auto range = spec(field, punch); return std::isfinite(values[field]) ? juce::jlimit(range.min, range.max, values[field]) : range.initial; };
            const auto set = [this](auto& smoother, double target) { if (initialized) smoother.setTargetValue(target); else smoother.setCurrentAndTargetValue(target); };
            set(input, juce::Decibels::decibelsToGain(static_cast<double>(value(Input))));
            set(output, juce::Decibels::decibelsToGain(static_cast<double>(value(Output))));
            set(threshold, value(Threshold)); set(slope, value(Infinity) >= .5f ? 1 : 1 - 1.0 / value(Ratio));
            set(highPass, value(HighPass) >= .5f ? 1 : 0);
            automatic = value(AutoRelease) >= .5f;
            attackCoefficient = std::exp(-1 / (rate * value(Attack) * .001));
            releaseCoefficient = std::exp(-1 / (rate * value(Release) * .001)); initialized = true;
        }
        double process(double detectorLeft, double detectorRight) noexcept
        {
            const double in = input.getNextValue(), out = output.getNextValue(), hp = highPass.getNextValue();
            lastInput = in; lastOutput = out;
            const auto filter = [&](double sample, size_t ch) {
                const double x = (std::isfinite(sample) ? juce::jlimit(-1.0e6, 1.0e6, sample) : 0) * in;
                low[ch] = hpCoefficient * low[ch] + (1 - hpCoefficient) * x;
                return x - hp * low[ch];
            };
            const double l = filter(detectorLeft, 0), r = filter(detectorRight, 1);
            power = rmsCoefficient * power + (1-rmsCoefficient) * juce::jmax(l*l, r*r);
            const double over = juce::Decibels::gainToDecibels(std::sqrt(power), -160.0) - threshold.getNextValue();
            const double target = slope.getNextValue() * (punch ? juce::jmax(0.0, over) : over <= -3 ? 0 : over >= 3 ? over : (over+3)*(over+3)/12);
            memory = memoryCoefficient * memory + (1-memoryCoefficient) * target;
            const double history = juce::jlimit(0.0, 1.0, memory / 24);
            const double coefficient = target > reduction
                ? (punch ? std::exp(-1 / (rate * (.0005 + .0045 / (1 + std::abs(target-reduction))))) : attackCoefficient)
                : (punch || automatic ? std::exp(-1 / (rate * (punch ? .06 + .44*history : .08 + 1.92*history))) : releaseCoefficient);
            reduction = coefficient * reduction + (1-coefficient) * target;
            return in * out * juce::Decibels::decibelsToGain(-reduction);
        }
    };
    double rate = 48000, reduction = 0;
    bool punch = false, initialized = false;
    std::array<std::array<Lane, 2>, 3> lanes;
    std::array<juce::SmoothedValue<float>, 3> weights;
    bool colourEnabled = false;
    std::array<BuiltInOversampledColour, 3> colour;
};
