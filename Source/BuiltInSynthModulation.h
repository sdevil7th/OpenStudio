#pragma once
#include <JuceHeader.h>
#include <array>
#include <cmath>

// Original voice modulation routing and Simper's linear trapezoidal SVF.
// Coefficient tables are prepared off the callback; all voice storage is fixed.
class BuiltInSynthModulation
{
public:
    struct Voice { double integrator1 = 0, integrator2 = 0; float phase = 0; };
    struct Frame
    {
        std::array<float, 4> filter {}, destination {}, shape {};
        float logCutoff = 0, q = .707f, keyTrack = 0, envelope = 0, rate = 1, depth = 0;
    };
    void prepare(double rate, const std::array<float, 9>& values)
    {
        sampleRate = juce::jmax(8000.0, rate);
        lowLog = std::log2(10.0); highLog = std::log2(juce::jmin(20000.0, sampleRate * .45));
        for (size_t i = 0; i < tangent.size(); ++i)
            tangent[i] = std::tan(juce::MathConstants<double>::pi
                * std::exp2(lowLog + (highLog - lowLog) * static_cast<double>(i) / 1024.0) / sampleRate);
        for (auto& smoother : continuous) smoother.reset(sampleRate, .02);
        for (auto* group : { &filter, &destination, &shape })
            for (auto& smoother : *group) smoother.reset(sampleRate, .02);
        setTargets(values, true);
    }
    // Mode, cutoff, Q, key tracking, envelope octaves, destination, rate, depth, shape.
    void setTargets(const std::array<float, 9>& v, bool initialize = false)
    {
        const auto set = [initialize](auto& smoother, float target)
        { if (initialize) smoother.setCurrentAndTargetValue(target); else smoother.setTargetValue(target); };
        for (size_t i = 0; i < 4; ++i)
        {
            set(filter[i], static_cast<int>(i) == juce::roundToInt(v[0]) ? 1.0f : 0.0f);
            set(destination[i], static_cast<int>(i) == juce::roundToInt(v[5]) ? 1.0f : 0.0f);
            set(shape[i], static_cast<int>(i) == juce::roundToInt(v[8]) ? 1.0f : 0.0f);
        }
        const std::array<float, 6> targets { std::log2(v[1]), v[2], v[3], v[4], v[6], v[7] };
        for (size_t i = 0; i < targets.size(); ++i) set(continuous[i], targets[i]);
    }
    Frame next() noexcept
    {
        Frame f;
        for (size_t i = 0; i < 4; ++i)
        { f.filter[i] = filter[i].getNextValue(); f.destination[i] = destination[i].getNextValue(); f.shape[i] = shape[i].getNextValue(); }
        f.logCutoff = continuous[0].getNextValue(); f.q = continuous[1].getNextValue();
        f.keyTrack = continuous[2].getNextValue(); f.envelope = continuous[3].getNextValue();
        f.rate = continuous[4].getNextValue(); f.depth = continuous[5].getNextValue();
        return f;
    }
    float lfo(Voice& voice, const Frame& f) const noexcept
    {
        const float p = voice.phase;
        const float value = std::sin(juce::MathConstants<float>::twoPi * p) * f.shape[0]
            + (1.0f - 4.0f * std::abs(p - .5f)) * f.shape[1]
            + (2.0f * p - 1.0f) * f.shape[2] + (p < .5f ? 1.0f : -1.0f) * f.shape[3];
        voice.phase += f.rate / static_cast<float>(sampleRate);
        if (voice.phase >= 1) voice.phase -= 1;
        return value;
    }
    float process(Voice& voice, const Frame& f, float input, float legacy, int note, float envelopeValue, float modulation, float matrixOctaves=0) const noexcept
    {
        if (f.filter[0] >= 1.0f) return legacy;
        const double logFrequency = static_cast<double>(f.logCutoff) + f.keyTrack * static_cast<float>(note - 60) / 12.0
            + f.envelope * envelopeValue + 4.0 * modulation * f.depth * f.destination[1] + matrixOctaves;
        const double position = juce::jlimit(0.0, 1024.0, (logFrequency - lowLog) * 1024.0 / (highLog - lowLog));
        const auto index = static_cast<size_t>(juce::jmin(1023, static_cast<int>(position)));
        const double g = tangent[index] + (tangent[index + 1] - tangent[index]) * (position - static_cast<double>(index));
        const double k = 1.0 / f.q, a1 = 1.0 / (1.0 + g * (g + k)), a2 = g * a1, a3 = g * a2;
        const double v3 = input - voice.integrator2;
        const double v1 = a1 * voice.integrator1 + a2 * v3;
        const double v2 = voice.integrator2 + a2 * voice.integrator1 + a3 * v3;
        voice.integrator1 = 2 * v1 - voice.integrator1; voice.integrator2 = 2 * v2 - voice.integrator2;
        const double output = legacy * f.filter[0] + v2 * f.filter[1]
            + (input - k * v1 - v2) * f.filter[2] + k * v1 * f.filter[3];
        if (!std::isfinite(output)) { voice.integrator1 = voice.integrator2 = 0; return 0; }
        return static_cast<float>(output);
    }
private:
    double sampleRate = 44100, lowLog = 0, highLog = 0;
    std::array<double, 1025> tangent {};
    std::array<juce::SmoothedValue<float>, 6> continuous;
    std::array<juce::SmoothedValue<float>, 4> filter, destination, shape;
};

// Independent note-latched filter ADSR. Integer stage lengths avoid cumulative
// timing drift; note-off releases from the current value in the requested time.
class BuiltInSynthEnvelope
{
public:
    void start(double sampleRate, float attackMs, float decayMs, float sustain,
               float releaseMs, float velocity, float velocityDepth) noexcept
    {
        const auto samples = [sampleRate](float ms) { return juce::jmax(1, juce::roundToInt(sampleRate * ms * .001)); };
        attackCount = samples(juce::jlimit(.1f, 5000.0f, attackMs));
        decayCount = samples(juce::jlimit(1.0f, 5000.0f, decayMs));
        releaseCount = samples(juce::jlimit(1.0f, 10000.0f, releaseMs));
        sustainLevel = juce::jlimit(0.0f, 1.0f, sustain);
        velocityGain = 1.0f - juce::jlimit(0.0f, 1.0f, velocityDepth) * (1.0f - juce::jlimit(0.0f, 1.0f, velocity));
        stage = 1; position = 0; level = 0; releaseStart = 0;
    }
    float next(bool released, float attackOffset=0, float decayOffset=0, float sustainOffset=0, float releaseOffset=0) noexcept
    {
        const float currentSustain=sustainOffset==0?sustainLevel:juce::jlimit(0.0f,1.0f,sustainLevel+sustainOffset);
        if (released && stage > 0 && stage < 4) { stage = 4; position = 0; releaseStart = level; }
        if (stage == 1)
        {
            position+=attackOffset==0?1.0:std::exp2(-4.0*attackOffset);level = static_cast<float>(position) / static_cast<float>(attackCount);
            if (position >= attackCount) { level = 1; stage = 2; position = 0; }
        }
        else if (stage == 2)
        {
            position+=decayOffset==0?1.0:std::exp2(-4.0*decayOffset);level = 1.0f + (currentSustain - 1.0f) * static_cast<float>(position) / static_cast<float>(decayCount);
            if (position >= decayCount) { level = currentSustain; stage = 3; position = 0; }
        }
        else if (stage == 3) level=currentSustain;
        else if (stage == 4)
        {
            position+=releaseOffset==0?1.0:std::exp2(-4.0*releaseOffset);level = releaseStart * (1.0f - static_cast<float>(position) / static_cast<float>(releaseCount));
            if (position >= releaseCount) { level = 0; stage = 0; position = 0; }
        }
        return level * velocityGain;
    }
private:
    int stage = 0, attackCount = 1, decayCount = 1, releaseCount = 1;
    double position=0;
    float level = 0, sustainLevel = 0, releaseStart = 0, velocityGain = 1;
};
