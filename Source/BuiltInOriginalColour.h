#pragma once
#include <JuceHeader.h>

// Explicit original digital stages. The profiles below are design constants,
// not fitted transformer, tube, transistor or commercial plug-in models.
class BuiltInOriginalColour
{
public:
    enum Profile { Preamp, FET, TubeOpto, SolidOpto, BusVCA, PunchVCA, Clean };
    void prepare(double sampleRate, Profile selected) noexcept
    {
        rate = sampleRate; selectProfile(selected);
        memoryCoefficient = std::exp(-1.0 / (sampleRate * .035));
        dcCoefficient = std::exp(-juce::MathConstants<double>::twoPi * 5.0 / sampleRate);
        reset();
    }
    void reset() noexcept { low = memory = dcInput = dcOutput = 0; }
    // Unit tangent at zero and zero output for zero input, including asymmetry.
    static double curve(double value, Profile kind, double bias = 0) noexcept
    {
        value = juce::jlimit(-1.0e6, 1.0e6, value);
        if (kind == SolidOpto || kind == PunchVCA)
        {
            const double scale = kind == SolidOpto ? .7 : .45;
            return value / std::sqrt(1 + scale * value * value);
        }
        if (kind == TubeOpto)
        {
            const double b = .9 * bias;
            return (std::atan(.9 * value + b) - std::atan(b)) * (1 + b * b) / .9;
        }
        const double scale = kind == BusVCA ? .32 : kind == Preamp ? 1.1 : .8;
        const double b = std::tanh(bias);
        return (std::tanh(scale * value + bias) - b) / (scale * (1 - b * b));
    }
    double input(double value, double amount = 1) noexcept
    {
        low = lowCoefficient * low + (1 - lowCoefficient) * value;
        memory = memoryCoefficient * memory + (1 - memoryCoefficient) * std::abs(value);
        if (profile == Clean) return value;
        const double flux = value + amount * .18 * (curve(low * 1.7, SolidOpto) / 1.7 - low);
        const double bias = profile == TubeOpto ? .16 : profile == Preamp ? .10 : profile == FET ? .035 : 0;
        const double shaped = curve(flux, profile, bias * (1 + .15 * juce::jmin(2.0, memory)));
        return value + amount * (shaped - value);
    }
    double output(double value, double amount = 1) noexcept
    {
        const double bias = profile == TubeOpto ? -.09 : profile == Preamp ? .04 : 0;
        const double shaped = profile == Clean ? value : curve(value, profile, bias);
        const double coloured = value + amount * (shaped - value);
        const double filtered = coloured - dcInput + dcCoefficient * dcOutput;
        dcInput = coloured; dcOutput = filtered;
        return amount == 0 || profile == Clean ? value : value + amount * (filtered - value);
    }
    void selectProfile(Profile selected) noexcept
    {
        profile = selected;
        lowCoefficient = std::exp(-juce::MathConstants<double>::twoPi * (profile == TubeOpto ? 95.0 : profile == FET ? 70.0 : 55.0) / rate);
    }
private:
    Profile profile = Preamp;
    double rate = 48000, lowCoefficient = 0, memoryCoefficient = 0, dcCoefficient = 0;
    double low = 0, memory = 0, dcInput = 0, dcOutput = 0;
};

// Prepared stereo 16x FIR wrapper. Equal up/down designs make the nonlinear
// point's input group delay known exactly. One base sample is processed per
// call so arbitrary host block partitions and detector timing stay identical.
class BuiltInOversampledColour
{
public:
    static constexpr int oversamplingStages = 4;
    static constexpr int oversamplingFactor = 1 << oversamplingStages;
    static void addOversamplingStages(juce::dsp::Oversampling<float>& resampler)
    {
        resampler.clearOversamplingStages();
        for (int stage = 0; stage < oversamplingStages; ++stage)
            resampler.addOversamplingStage(juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
                stage == 0 ? .06f : .12f, stage == 0 ? -100.0f : -90.0f,
                stage == 0 ? .06f : .12f, stage == 0 ? -100.0f : -90.0f);
    }
    void prepare(double sampleRate, BuiltInOriginalColour::Profile profile)
    {
        oversampling = std::make_unique<juce::dsp::Oversampling<float>>(2);
        addOversamplingStages(*oversampling);
        oversampling->initProcessing(1);
        inputDelay = oversampling->getLatencyInSamples() * .5f;
        oversampling->setUsingIntegerLatency(true);
        latency = juce::roundToInt(oversampling->getLatencyInSamples());
        for (auto& channel : channels) channel.prepare(sampleRate * oversamplingFactor, profile);
        activeProfile = profile;
        profileBlend.reset(sampleRate * oversamplingFactor, .02);
        reset();
    }
    void reset() noexcept { if (oversampling) oversampling->reset(); for (auto& channel : channels) channel.reset(); previousChannels = channels; profileBlend.setCurrentAndTargetValue(1); }
    void selectProfile(BuiltInOriginalColour::Profile profile) noexcept
    {
        if (profile == activeProfile) return;
        previousChannels = channels;
        for (auto& channel : channels) channel.selectProfile(profile);
        activeProfile = profile; profileBlend.setCurrentAndTargetValue(0); profileBlend.setTargetValue(1);
    }
    int latencySamples() const noexcept { return latency; }
    float inputDelaySamples() const noexcept { return inputDelay; }
    std::array<float, 2> process(std::array<double, 2> audio, std::array<double, 2> inputGain,
        std::array<double, 2> reductionGain, std::array<double, 2> outputGain, double headroomGain = 1) noexcept
    {
        if (!oversampling) return {};
        std::array<float, 2> samples { static_cast<float>(audio[0]), static_cast<float>(audio[1]) };
        float* pointers[] { &samples[0], &samples[1] };
        juce::dsp::AudioBlock<float> block(pointers, 2, 1);
        auto up = oversampling->processSamplesUp(block);
        for (size_t i = 0; i < up.getNumSamples(); ++i)
        {
            const double blend = profileBlend.getNextValue();
            for (size_t ch = 0; ch < 2; ++ch)
            {
                const double driven = up.getSample(static_cast<int>(ch), static_cast<int>(i)) * inputGain[ch] * headroomGain;
                const double amplified = channels[ch].input(driven) * reductionGain[ch] * outputGain[ch];
                double result = channels[ch].output(amplified);
                if (blend < 1)
                {
                    const double previous = previousChannels[ch].output(previousChannels[ch].input(driven) * reductionGain[ch] * outputGain[ch]);
                    result = previous + blend * (result - previous);
                }
                result /= headroomGain;
                up.setSample(static_cast<int>(ch), static_cast<int>(i), std::isfinite(result) ? static_cast<float>(result) : 0.0f);
            }
        }
        oversampling->processSamplesDown(block);
        return samples;
    }
private:
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampling;
    std::array<BuiltInOriginalColour, 2> channels;
    std::array<BuiltInOriginalColour, 2> previousChannels;
    BuiltInOriginalColour::Profile activeProfile = BuiltInOriginalColour::Clean;
    juce::SmoothedValue<double> profileBlend;
    int latency = 0;
    float inputDelay = 0;
};
