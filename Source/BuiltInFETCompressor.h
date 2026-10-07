#pragma once
#include <JuceHeader.h>

// Original input-driven FET-style dynamics law, not a circuit emulation.
// Returns wet gain; the host owns detector filtering, delay and parallel mix.
class BuiltInFETCompressor
{
public:
    struct Settings { float input = 0, output = 0, ratio = 0, attack = .1f, release = 120, recovery = .25f; };
    void prepare(double sampleRate)
    {
        rate = sampleRate;
        for (auto* smoother : { &inputGain, &outputGain, &slope, &knee, &threshold, &memoryAmount, &compressionEnabled }) smoother->reset(rate, .02);
        memoryCoefficient = std::exp(-1.0 / (rate * .3)); reset();
    }
    void reset() noexcept { reduction = 0; effectiveReduction = 0; memory = 0; initialized = false; }
    void configure(Settings settings)
    {
        const auto safe = [](float value, float lo, float hi, float fallback) { return std::isfinite(value) ? juce::jlimit(lo, hi, value) : fallback; };
        const auto set = [this](auto& smoother, double value) { if (initialized) smoother.setTargetValue(value); else smoother.setCurrentAndTargetValue(value); };
        const int mode = juce::roundToInt(safe(settings.ratio, 0, 10, 0));
        // Appended adjacent-button profiles are original laws, not measured circuits.
        constexpr double ratios[] { 4, 8, 12, 20, 16, 1, 6, 10, 16, 8, 40.0/3 };
        constexpr double knees[] {3,3,3,3,12,3,5,6,7,8,9};
        constexpr double thresholds[] {-18,-18,-18,-18,-21,-18,-18.5,-19,-19.5,-20,-20.5};
        constexpr double biases[] {0,0,0,0,.15,0,.04,.06,.08,.10,.12};
        constexpr double lags[] {0,0,0,0,.5,0,.1,.18,.25,.32,.4};
        biasAmount=biases[mode];attackLag=lags[mode];
        allButtons = mode == 4;
        set(inputGain, juce::Decibels::decibelsToGain(static_cast<double>(safe(settings.input, -24, 36, 0))));
        set(outputGain, juce::Decibels::decibelsToGain(static_cast<double>(safe(settings.output, -36, 24, 0))));
        set(slope, 1 - 1 / ratios[mode]); set(knee, knees[mode]); set(threshold, thresholds[mode]);
        set(compressionEnabled, mode == 5 ? 0 : 1);
        set(memoryAmount, safe(settings.recovery, 0, 1, .25f));
        attackCoefficient = std::exp(-1.0 / (rate * .001 * safe(settings.attack, .02f, .8f, .1f)));
        releaseCoefficient = std::exp(-1.0 / (rate * .001 * safe(settings.release, 50, 1100, 120)));
        initialized = true;
    }
    double process(float detectorLevel) noexcept
    {
        const double input = inputGain.getNextValue(), output = outputGain.getNextValue();
        lastInput = input; lastOutput = output;
        const double amount = memoryAmount.getNextValue(), compressionSlope = slope.getNextValue(), width = knee.getNextValue();
        const double thresholdDb = threshold.getNextValue() + (biasAmount > 0 ? juce::jmin(3.0, memory * biasAmount) : 0);
        const double finiteLevel = std::isfinite(detectorLevel) ? juce::jlimit(0.0, 1.0e6, static_cast<double>(detectorLevel)) : 0;
        const double over = juce::Decibels::gainToDecibels(finiteLevel * input, -160.0) - thresholdDb;
        const double target = compressionSlope * (over <= -width * .5 ? 0 : over >= width * .5 ? over : std::pow(over + width * .5, 2) / (2 * width));
        memory = memoryCoefficient * memory + (1 - memoryCoefficient) * target;
        const double attackScale = allButtons ? 1.5 + juce::jmin(1.0, memory * .02) : attackLag > 0 ? 1 + attackLag + juce::jmin(1.0, memory * attackLag * .04) : 1;
        const double releaseScale = 1 + juce::jmin(4.0, memory * (allButtons ? .04 + .08 * amount : attackLag > 0 ? attackLag * .08 + (.06 + attackLag * .04) * amount : amount / 12));
        const double coefficient = target > reduction ? (attackLag > 0 ? std::pow(attackCoefficient, 1 / attackScale) : attackCoefficient)
            : (releaseScale == 1 ? releaseCoefficient : std::pow(releaseCoefficient, 1 / releaseScale));
        reduction = coefficient * reduction + (1 - coefficient) * target;
        effectiveReduction = reduction * compressionEnabled.getNextValue();
        return input * output * juce::Decibels::decibelsToGain(-effectiveReduction);
    }
    double gainReduction() const noexcept { return effectiveReduction; }
    double consumedInputGain() const noexcept { return lastInput; }
    double consumedOutputGain() const noexcept { return lastOutput; }
private:
    double lastInput = 1, lastOutput = 1;
    double rate = 48000, reduction = 0, effectiveReduction = 0, memory = 0, memoryCoefficient = 0, attackCoefficient = 0, releaseCoefficient = 0;
    double biasAmount = 0, attackLag = 0;
    bool initialized = false, allButtons = false;
    juce::SmoothedValue<double> inputGain, outputGain, slope, knee, threshold, memoryAmount, compressionEnabled;
};
