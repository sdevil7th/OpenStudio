#pragma once
#include <JuceHeader.h>

// Original optical-style dynamics: two release reservoirs and exposure memory.
// This is a digital response model, not a measured T4 or amplifier emulation.
class BuiltInOpticalCompressor
{
public:
    struct Settings { float reduction = 45, gain = 0, mode = 0, emphasis = 0; };
    void prepare(double sampleRate, bool solidState)
    {
        rate = sampleRate; solid = solidState;
        for (auto* smoother : { &threshold, &outputGain, &slope, &lowGain, &enabled }) smoother->reset(rate, .02);
        detectorCoefficient = coefficient(solid ? .0004 : .003);
        attackCoefficient = coefficient(solid ? .0015 : .010);
        fastRelease = coefficient(.045);
        slowCharge = coefficient(solid ? .04 : .15);
        exposureCharge = coefficient(.4); exposureRelease = coefficient(solid ? 2 : 5);
        shelfCoefficient = std::exp(-juce::MathConstants<double>::twoPi * 1000 / rate);
        reset();
    }
    void reset() noexcept
    {
        fast = slow = exposure = power = effectiveReduction = 0;
        low.fill(0); initialized = false;
    }
    void configure(Settings settings)
    {
        const auto safe = [](float value, float lo, float hi, float fallback) { return std::isfinite(value) ? juce::jlimit(lo, hi, value) : fallback; };
        const auto set = [this](auto& smoother, double value) { if (initialized) smoother.setTargetValue(value); else smoother.setCurrentAndTargetValue(value); };
        const double amount = safe(settings.reduction, 0, 100, 45);
        set(threshold, -.4 * amount); set(enabled, amount == 0 ? 0 : 1);
        set(outputGain, juce::Decibels::decibelsToGain(static_cast<double>(safe(settings.gain, 0, 40, 0))));
        set(slope, safe(settings.mode, 0, 1, 0) >= .5f ? 1 : 2.0 / 3);
        set(lowGain, juce::Decibels::decibelsToGain(-18.0 * safe(settings.emphasis, 0, 1, 0)));
        initialized = true;
    }
    double process(float left, float right, float stereoLink) noexcept
    {
        const double bass = lowGain.getNextValue();
        const auto detector = [&](float input, size_t channel) {
            const double value = std::isfinite(input) ? juce::jlimit(-1.0e6, 1.0e6, static_cast<double>(input)) : 0;
            low[channel] = shelfCoefficient * low[channel] + (1 - shelfCoefficient) * value;
            return value - (1 - bass) * low[channel];
        };
        const double l = detector(left, 0), r = detector(right, 1);
        const double link = std::isfinite(stereoLink) ? juce::jlimit(0.0, 1.0, static_cast<double>(stereoLink)) : 1;
        // Square each channel before linking: antiphase stereo cannot cancel detection.
        const double linkedPower = (l*l + r*r) * .5 * (1-link) + juce::jmax(l*l, r*r) * link;
        power = detectorCoefficient * power + (1-detectorCoefficient) * linkedPower;
        const double over = juce::Decibels::gainToDecibels(std::sqrt(power), -160.0) - threshold.getNextValue();
        const double width = solid ? 4 : 6;
        const double target = slope.getNextValue() * (over <= -width*.5 ? 0 : over >= width*.5 ? over : (over+width*.5)*(over+width*.5)/(2*width));
        const double charge = target > exposure ? exposureCharge : exposureRelease;
        exposure = charge * exposure + (1-charge) * target;
        const double fastCoefficient = target > fast ? attackCoefficient : fastRelease;
        fast = fastCoefficient * fast + (1-fastCoefficient) * target;
        const double slowTime = (solid ? .18 : .35) + (solid ? 1.32 : 2.65) * juce::jlimit(0.0, 1.0, exposure / 18);
        const double slowCoefficient = target > slow ? slowCharge : coefficient(slowTime);
        slow = slowCoefficient * slow + (1-slowCoefficient) * target;
        effectiveReduction = (.65 * fast + .35 * slow) * enabled.getNextValue();
        lastOutput = outputGain.getNextValue();
        return lastOutput * juce::Decibels::decibelsToGain(-effectiveReduction);
    }
    double gainReduction() const noexcept { return effectiveReduction; }
    double consumedOutputGain() const noexcept { return lastOutput; }
private:
    double lastOutput = 1;
    double coefficient(double seconds) const noexcept { return std::exp(-1 / (rate * seconds)); }
    double rate = 48000, fast = 0, slow = 0, exposure = 0, power = 0, effectiveReduction = 0;
    double detectorCoefficient = 0, attackCoefficient = 0, fastRelease = 0, slowCharge = 0;
    double exposureCharge = 0, exposureRelease = 0, shelfCoefficient = 0;
    std::array<double, 2> low {};
    bool solid = false, initialized = false;
    juce::SmoothedValue<double> threshold, outputGain, slope, lowGain, enabled;
};
