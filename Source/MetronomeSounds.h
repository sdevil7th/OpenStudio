#pragma once

#include <JuceHeader.h>

// Preparation runs on the control thread. The callback only reads finished mono buffers.
namespace MetronomeSounds
{
inline constexpr double preparedRate = 48000.0;
inline constexpr double peakTimeSeconds = 0.001;
inline constexpr double maximumClickSeconds = 0.100;

inline juce::AudioBuffer<float> resample(const juce::AudioBuffer<float>& input,
                                        double sourceRate, double targetRate)
{
    const int count = juce::jmax(1, juce::roundToInt(input.getNumSamples() * targetRate / sourceRate));
    juce::AudioBuffer<float> output(1, count);
    if (sourceRate == targetRate) return input;
    // Windowed sinc with a downsampling low-pass; no causal filter latency is added.
    const double cutoff = juce::jmin(1.0, targetRate / sourceRate) * 0.95;
    constexpr int radius = 32;
    for (int sample = 0; sample < count; ++sample)
    {
        const double position = sample * sourceRate / targetRate;
        const int centre = static_cast<int>(position);
        double value = 0.0, weightSum = 0.0;
        for (int tap = centre - radius; tap <= centre + radius; ++tap)
        {
            const double distance = position - tap;
            if (std::abs(distance) >= radius) continue;
            const double angle = juce::MathConstants<double>::pi * distance * cutoff;
            const double sinc = std::abs(angle) < 1.0e-12 ? 1.0 : std::sin(angle) / angle;
            const double weight = cutoff * sinc
                * (0.5 + 0.5 * std::cos(juce::MathConstants<double>::pi * distance / radius));
            weightSum += weight;
            if (tap >= 0 && tap < input.getNumSamples()) value += weight * input.getSample(0, tap);
        }
        output.setSample(0, sample, static_cast<float>(weightSum != 0.0 ? value / weightSum : 0.0));
    }
    // Interpolation may overshoot even when the prepared source is bounded.
    const float peak = output.getMagnitude(0, count);
    if (peak > 0.8f) output.applyGain(0.8f / peak);
    return output;
}

struct PreparedClick
{
    juce::AudioBuffer<float> audio;
    juce::String error;
    double removedLeadMs = 0.0;
    int selectedChannel = 0;
    bool shortened = false;
};

inline PreparedClick prepare(const juce::AudioBuffer<float>& input, double rate)
{
    PreparedClick result;
    if (!std::isfinite(rate) || rate < 8000.0 || rate > 384000.0
        || input.getNumChannels() < 1 || input.getNumChannels() > 8 || input.getNumSamples() < 8)
    {
        result.error = "Choose a short audio sample with 1-8 channels and a sample rate from 8 to 384 kHz.";
        return result;
    }
    juce::AudioBuffer<float> mono(1, input.getNumSamples());
    double bestEnergy = -1.0;
    // Select the strongest channel rather than cancelling opposite-polarity stereo,
    // or mixing a delayed stereo reflection into the timing reference.
    for (int channel = 0; channel < input.getNumChannels(); ++channel)
    {
        const auto* samples = input.getReadPointer(channel);
        double mean = 0.0;
        int clippedRun = 0;
        for (int sample = 0; sample < input.getNumSamples(); ++sample)
        {
            if (!std::isfinite(samples[sample]) || std::abs(samples[sample]) > 4.0f)
            {
                result.error = "This sample contains invalid or excessive audio levels. Export a clean sample first.";
                return result;
            }
            mean += samples[sample];
            clippedRun = std::abs(samples[sample]) >= 0.999f ? clippedRun + 1 : 0;
            if (clippedRun > rate * 0.0005)
            {
                result.error = "This sample appears clipped. Export a clean click at a lower level first.";
                return result;
            }
        }
        mean /= input.getNumSamples();
        double energy = 0.0;
        for (int sample = 0; sample < input.getNumSamples(); ++sample)
            energy += juce::square(samples[sample] - mean);
        if (energy > bestEnergy)
        {
            bestEnergy = energy;
            result.selectedChannel = channel;
            for (int sample = 0; sample < input.getNumSamples(); ++sample)
                mono.setSample(0, sample, static_cast<float>(samples[sample] - mean));
        }
    }
    const auto* samples = mono.getReadPointer(0);
    const float globalPeak = mono.getMagnitude(0, mono.getNumSamples());
    if (globalPeak < 0.001f)
    {
        result.error = "This sample is silent or too quiet. Choose a clear single click.";
        return result;
    }
    int onset = 0;
    const float threshold = globalPeak * 0.08f;
    while (onset < mono.getNumSamples() && std::abs(samples[onset]) < threshold) ++onset;
    const int searchEnd = juce::jmin(mono.getNumSamples(), onset + juce::roundToInt(rate * 0.030));
    int peak = onset;
    for (int sample = onset; sample < searchEnd; ++sample)
        if (std::abs(samples[sample]) > std::abs(samples[peak])) peak = sample;
    const float attackPeak = std::abs(samples[peak]);
    if (peak - onset > rate * 0.020 || attackPeak < globalPeak * 0.65f)
    {
        result.error = "This sound has a slow or unclear attack. Choose a short, percussive single click.";
        return result;
    }
    // A second strong transient after a quiet gap would create a misleading extra beat.
    int quietSamples = 0;
    bool afterGap = false;
    const int gap = juce::jmax(1, juce::roundToInt(rate * 0.012));
    for (int sample = peak + 1; sample < mono.getNumSamples(); ++sample)
    {
        const float level = std::abs(samples[sample]);
        if (level < attackPeak * 0.08f)
        {
            ++quietSamples;
            afterGap = afterGap || quietSamples >= gap;
        }
        else if (level > attackPeak * 0.35f && afterGap)
        {
            result.error = "This sample contains multiple hits. Trim it to one click before choosing it.";
            return result;
        }
        else if (level >= attackPeak * 0.08f) quietSamples = 0;
    }
    const int beforePeak = juce::roundToInt(rate * peakTimeSeconds);
    const int firstSample = peak - beforePeak;
    const int count = juce::jmin(juce::roundToInt(rate * maximumClickSeconds), mono.getNumSamples() - firstSample);
    juce::AudioBuffer<float> trimmed(1, count);
    for (int sample = 0; sample < count; ++sample)
    {
        const int source = firstSample + sample;
        trimmed.setSample(0, sample, source >= 0 ? samples[source] : 0.0f);
    }
    result.removedLeadMs = juce::jmax(0.0, firstSample * 1000.0 / rate);
    result.shortened = mono.getNumSamples() - juce::jmax(0, firstSample) > count;
    result.audio = resample(trimmed, rate, preparedRate);
    // Resampling can move a discrete peak slightly; align again at the canonical
    // rate so imported Regular and Accent have the same timing landmark.
    int preparedAttackPeak = 0;
    const int attackWindow = juce::jmin(result.audio.getNumSamples(), juce::roundToInt(preparedRate * 0.004));
    for (int sample = 1; sample < attackWindow; ++sample)
        if (std::abs(result.audio.getSample(0, sample)) > std::abs(result.audio.getSample(0, preparedAttackPeak))) preparedAttackPeak = sample;
    const int shift = preparedAttackPeak - juce::roundToInt(preparedRate * peakTimeSeconds);
    if (shift != 0)
    {
        juce::AudioBuffer<float> aligned(1, result.audio.getNumSamples());
        aligned.clear();
        for (int sample = 0; sample < aligned.getNumSamples(); ++sample)
            if (sample + shift >= 0 && sample + shift < result.audio.getNumSamples())
                aligned.setSample(0, sample, result.audio.getSample(0, sample + shift));
        result.audio = std::move(aligned);
    }
    auto* output = result.audio.getWritePointer(0);
    const int length = result.audio.getNumSamples();
    const int fadeIn = juce::roundToInt(preparedRate * 0.0001);
    const int fadeOut = juce::jmin(length / 2, juce::roundToInt(preparedRate * 0.005));
    for (int sample = 0; sample < length; ++sample)
        output[sample] *= juce::jmin(1.0f, static_cast<float>(sample) / fadeIn)
            * juce::jmin(1.0f, static_cast<float>(length - 1 - sample) / juce::jmax(1, fadeOut));
    const float preparedPeak = result.audio.getMagnitude(0, length);
    if (preparedPeak < 0.0001f)
    {
        result.audio.setSize(0, 0);
        result.error = "The click is too short to prepare safely. Choose a longer single hit.";
        return result;
    }
    result.audio.applyGain(0.8f / preparedPeak);
    return result;
}

inline bool isBuiltIn(const juce::String& selection)
{
    return selection.isEmpty() || selection == "builtin:woodblock"
        || selection == "builtin:cowbell" || selection == "builtin:mechanical";
}

inline juce::AudioBuffer<float> synthesiseCowbell(bool accent, double rate)
{
    const int count = juce::jmax(1, juce::roundToInt(rate * maximumClickSeconds));
    juce::AudioBuffer<float> struck(1, count);
    struck.clear();

    // An 808-style voice, shortened for a metronome, not an acoustic cowbell.
    // The stock equal-input filter in Werner/Abel/Smith, "More Cowbell" (AES
    // 9207, Fig. 1 / Eq. 15) reduces to a resonant high-pass and one low-pass.
    // Its poles give 864.326 Hz / Q 4.74578 and a 7188.668 Hz low-pass.
    // Discretise those analog poles directly, including at low device rates.
    const double k = 2.0 * rate;
    const double omega = juce::MathConstants<double>::twoPi * 864.3256761323507;
    const double damping = omega / 4.745780307074436;
    const double denominator = k * k + damping * k + omega * omega;
    const double b0 = k * k / denominator;
    const double b1 = -2.0 * b0;
    const double a1 = 2.0 * (omega * omega - k * k) / denominator;
    const double a2 = (k * k - damping * k + omega * omega) / denominator;
    constexpr double lowPassPole = 45167.73103402;
    const double lowPassGain = lowPassPole / (k + lowPassPole);
    const double lowPassFeedback = (k - lowPassPole) / (k + lowPassPole);
    double delay1 = 0.0, delay2 = 0.0, previousInput = 0.0, previousOutput = 0.0;

    const auto squareWave = [rate] (double frequency, double time)
    {
        double value = 0.0;
        // Add only harmonics below Nyquist instead of aliasing hard clipping.
        const double limit = juce::jmin(20000.0, rate * 0.45);
        for (int harmonic = 1; harmonic * frequency < limit; harmonic += 2)
            value += std::sin(juce::MathConstants<double>::twoPi * harmonic * frequency * time) / harmonic;
        return value * (4.0 / juce::MathConstants<double>::pi);
    };
    for (int sample = 0; sample < count; ++sample)
    {
        const double t = sample / rate;
        // Approximate the fast strike plus slower body of the two-stage decay.
        const double envelope = (1.0 - std::exp(-t / 0.00015))
            * (0.7 * std::exp(-t / 0.007) + 0.3 * std::exp(-t / 0.045));
        const double input = (squareWave(540.0, t) + squareWave(800.0, t)) * envelope;
        const double highPassed = b0 * input + delay1;
        delay1 = b1 * input - a1 * highPassed + delay2;
        delay2 = b0 * input - a2 * highPassed;
        const double filtered = lowPassGain * (highPassed + previousInput) + lowPassFeedback * previousOutput;
        previousInput = highPassed;
        previousOutput = filtered;
        struck.setSample(0, sample, static_cast<float>(filtered));
    }

    // Give both strikes the same 1ms attack landmark used for custom clicks.
    int peak = 0;
    for (int sample = 1; sample < count; ++sample)
        if (std::abs(struck.getSample(0, sample)) > std::abs(struck.getSample(0, peak))) peak = sample;
    const int shift = peak - juce::roundToInt(rate * peakTimeSeconds);
    juce::AudioBuffer<float> result(1, count);
    result.clear();
    for (int sample = 0; sample < count; ++sample)
    {
        const int source = sample + shift;
        if (source < 0 || source >= count) continue;
        const double fade = juce::jmin(1.0, sample / juce::jmax(1.0, rate * 0.00015))
            * juce::jmin(1.0, (count - 1 - sample) / juce::jmax(1.0, rate * 0.005));
        result.setSample(0, sample, static_cast<float>(struck.getSample(0, source) * fade));
    }
    // Accent is a stronger strike of the same bell, not a 30% transposition.
    result.applyGain((accent ? 0.8f : 0.64f) / juce::jmax(0.0001f, result.getMagnitude(0, count)));
    return result;
}

inline juce::AudioBuffer<float> synthesise(const juce::String& selection, bool accent, double rate)
{
    if (selection == "builtin:cowbell") return synthesiseCowbell(accent, rate);
    const int count = juce::jmax(1, juce::roundToInt(rate * 0.080));
    juce::AudioBuffer<float> result(1, count);
    for (int sample = 0; sample < count; ++sample)
    {
        const double t = sample / rate;
        const double pitch = accent ? 1.3 : 1.0;
        double value = 0.0;
        if (selection == "builtin:woodblock")
            value = (std::sin(juce::MathConstants<double>::twoPi * 720.0 * pitch * t)
                + 0.45 * std::sin(juce::MathConstants<double>::twoPi * 1830.0 * pitch * t)) * std::exp(-100.0 * t);
        else
            value = (std::sin(juce::MathConstants<double>::twoPi * 2300.0 * pitch * t)
                + 0.6 * std::sin(juce::MathConstants<double>::twoPi * 3511.0 * pitch * t)) * std::exp(-450.0 * t);
        const double fade = juce::jmin(1.0, static_cast<double>(count - 1 - sample) / juce::jmax(1.0, rate * 0.005));
        result.setSample(0, sample, static_cast<float>(value * fade));
    }
    result.applyGain(0.8f / juce::jmax(0.0001f, result.getMagnitude(0, count)));
    return result;
}
}
