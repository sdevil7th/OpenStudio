#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include <array>
#include <vector>

// Standalone algorithmic plate, derived from Dattorro (JAES 45/9, 1997),
// Fig. 1 and Table 2. Original implementation; not an EMT circuit/plate model.
// Delay losses use z^-N -> r^N z^-N, r=10^(-3/(Fs*T60)), including
// diffuser delays. This moves lossless network poles radially instead of
// estimating decay from only the four long tank delays.
class BuiltInPlateReverb
{
public:
    struct Settings
    {
        float decay = 2, damping = .5f, diffusion = .5f, preDelay = 0;
        float lowCut = 20, highCut = 20000, width = 1, modulation = .25f;
        bool freeze = false, infiniteInput = false;
        int decayFilter = 0; // Legacy damping, Off, or low-pass.
        float decayCutoff = 8000;
        bool outputCutOff = false;
    };

private:
    struct Line
    {
        std::vector<float> data;
        int position = 0, length = 1, valid = 0;
        juce::SmoothedValue<float> loss;
        void prepare(float samples, double rate)
        {
            length = juce::jmax(1, juce::roundToInt(samples));
            data.assign(static_cast<size_t>(length + static_cast<int>(rate * .002) + 4), 0.0f);
            reset();
            loss.reset(rate, .05); loss.setCurrentAndTargetValue(1);
        }
        // Also used when a tail finishes on the audio thread.
        void reset() noexcept { position = 0; valid = 0; }
        float read(float delay) const noexcept
        {
            const int whole = static_cast<int>(delay);
            const float fraction = delay - static_cast<float>(whole);
            const int size = static_cast<int>(data.size());
            const int first = (position + size - whole) % size;
            const int second = (first + size - 1) % size;
            const float a = whole <= valid ? data[static_cast<size_t>(first)] : 0.0f;
            const float b = whole + 1 <= valid ? data[static_cast<size_t>(second)] : 0.0f;
            return a + fraction * (b - a);
        }
        void write(float input) noexcept
        {
            data[static_cast<size_t>(position)] = input;
            valid = juce::jmin(valid + 1, static_cast<int>(data.size()));
            if (++position == static_cast<int>(data.size())) position = 0;
        }
        float delay(float input) noexcept
        {
            const float output = read(static_cast<float>(length)) * loss.getNextValue();
            write(input); return output;
        }
        float allpass(float input, float coefficient, float excursion = 0) noexcept
        {
            const float delayed = read(static_cast<float>(length) + excursion) * loss.getNextValue();
            const float state = input + coefficient * delayed;
            write(state); return delayed - coefficient * state;
        }
    };
    struct Tank
    {
        std::array<Line, 4> input;
        std::array<Line, 8> loop;
        Line predelay;
        std::array<float, 2> feedback {}, damp {}, hp {}, lp {};
        // Table 2 output taps: delay line index, delay at 29761 Hz, sign.
        struct Tap { int line, delay; float sign; juce::SmoothedValue<float> loss; };
        std::array<std::array<Tap, 7>, 2> taps {{
            {{{5,266,1}, {5,2974,1}, {6,1913,-1}, {7,1996,1}, {1,1990,-1}, {2,187,-1}, {3,1066,-1}}},
            {{{1,353,1}, {1,3627,1}, {2,1228,-1}, {3,2673,1}, {5,2111,-1}, {6,335,-1}, {7,121,-1}}}
        }};
        juce::SmoothedValue<float> diffusion, dampingPole, highPole, lowPole, width, modulation, send, preSamples;
        float rate = 48000, scale = 1, singleSampleLoss = 1;
        double phase = 0;
        bool initialized = false;
        int drain = 0;
        Settings settings;

        void prepare(double sampleRate, float characterScale)
        {
            rate = static_cast<float>(sampleRate); scale = rate / 29761.0f * characterScale;
            const std::array<int, 4> inputLengths {142,107,379,277};
            const std::array<int, 8> loopLengths {672,4453,1800,3720,908,4217,2656,3163};
            for (size_t i = 0; i < input.size(); ++i) input[i].prepare(static_cast<float>(inputLengths[i]) * scale, sampleRate);
            for (size_t i = 0; i < loop.size(); ++i) loop[i].prepare(static_cast<float>(loopLengths[i]) * scale, sampleRate);
            predelay.prepare(rate * .501f, sampleRate);
            // Recreate original taps on each prepare (never rescale an already scaled tap).
            const Tank defaults;
            taps = defaults.taps;
            for (auto& channel : taps) for (auto& tap : channel)
            {
                tap.delay = juce::jmax(1, juce::roundToInt(static_cast<float>(tap.delay) * scale));
                tap.loss.reset(sampleRate, .05);
            }
            for (auto* smoother : { &diffusion, &dampingPole, &highPole, &lowPole, &width, &modulation, &send, &preSamples })
                smoother->reset(sampleRate, .05);
            reset();
        }
        void reset()
        {
            for (auto& line : input) line.reset();
            for (auto& line : loop) line.reset();
            predelay.reset(); feedback.fill(0); damp.fill(0); hp.fill(0); lp.fill(0);
            phase = 0; drain = 0; initialized = false;
        }
        void configure(Settings next, bool active)
        {
            if (active) settings = next;
            const bool hold = active && settings.freeze;
            const auto set = [this](auto& smoother, float target)
            {
                if (!initialized) smoother.setCurrentAndTargetValue(target);
                else smoother.setTargetValue(target);
            };
            const float exponent = hold ? 0 : -3.0f / (rate * settings.decay);
            for (auto& line : input) set(line.loss, std::pow(10.0f, exponent * static_cast<float>(line.length)));
            for (auto& line : loop) set(line.loss, std::pow(10.0f, exponent * static_cast<float>(line.length)));
            singleSampleLoss = std::pow(10.0f, exponent);
            for (auto& channel : taps) for (auto& tap : channel) set(tap.loss, std::pow(10.0f, exponent * static_cast<float>(tap.delay)));
            set(diffusion, settings.diffusion);
            // Zero damping bypasses the in-loop low-pass exactly, at every rate.
            const float cutoff = 18000.0f * std::pow(1.0f / 36.0f, settings.damping);
            set(dampingPole, hold || settings.decayFilter == 1 ? 0 : settings.decayFilter == 2
                ? std::exp(-juce::MathConstants<float>::twoPi * juce::jmin(rate * .45f, settings.decayCutoff) / rate)
                : settings.damping * std::exp(-juce::MathConstants<float>::twoPi * cutoff / rate));
            set(lowPole, std::exp(-juce::MathConstants<float>::twoPi * settings.lowCut / rate));
            set(highPole, settings.outputCutOff ? 0 : std::exp(-juce::MathConstants<float>::twoPi * juce::jmin(rate * .45f, settings.highCut) / rate));
            set(width, settings.width);
            set(modulation, hold ? 0 : settings.modulation * rate * .00045f);
            set(send, active && (!hold || settings.infiniteInput) ? 1.0f : 0.0f);
            set(preSamples, settings.preDelay * .001f * rate);
            initialized = true;
        }
        std::array<float, 2> process(float mono, bool active)
        {
            if (active) drain = static_cast<int>(rate * (settings.decay * 2 + 2));
            else if (drain == 0) return {};
            else if (--drain == 0) { reset(); return {}; }
            const float inputGain = send.getNextValue();
            // Write before read permits an exact zero-sample predelay.
            predelay.data[static_cast<size_t>(predelay.position)] = mono * inputGain;
            float signal = predelay.read(preSamples.getNextValue());
            predelay.valid = juce::jmin(predelay.valid + 1, static_cast<int>(predelay.data.size()));
            if (++predelay.position == static_cast<int>(predelay.data.size())) predelay.position = 0;
            const float diff = diffusion.getNextValue();
            for (size_t i = 0; i < input.size(); ++i) signal = input[i].allpass(signal, (i < 2 ? .75f : .625f) * diff);
            const float depth = modulation.getNextValue();
            const float pole = dampingPole.getNextValue();
            const float hpPole = lowPole.getNextValue(), lpPole = highPole.getNextValue();
            for (size_t ch = 0; ch < 2; ++ch)
            {
                const size_t offset = ch * 4;
                const float excursion = depth * static_cast<float>(std::sin(phase + static_cast<double>(ch) * juce::MathConstants<double>::halfPi));
                const float excitation = signal * .3f + feedback[ch] * singleSampleLoss;
                float value = loop[offset].allpass(settings.freeze && settings.infiniteInput ? juce::jlimit(-8.0f, 8.0f, excitation) : excitation, -.7f, excursion);
                value = loop[offset + 1].delay(value);
                damp[ch] = value + pole * (damp[ch] - value);
                value = loop[offset + 2].allpass(damp[ch], .5f);
                // Store both branches before updating cross feedback below.
                feedback[ch] = loop[offset + 3].delay(value);
            }
            std::swap(feedback[0], feedback[1]);
            phase += juce::MathConstants<double>::twoPi * .37 / static_cast<double>(rate);
            if (phase >= juce::MathConstants<double>::twoPi) phase -= juce::MathConstants<double>::twoPi;
            std::array<float, 2> output {};
            for (size_t ch = 0; ch < 2; ++ch)
            {
                float value = 0;
                for (auto& tap : taps[ch]) value += loop[static_cast<size_t>(tap.line)].read(static_cast<float>(tap.delay + 1)) * tap.sign * tap.loss.getNextValue() * .6f;
                hp[ch] = value + hpPole * (hp[ch] - value);
                value -= hp[ch];
                lp[ch] = value + lpPole * (lp[ch] - value);
                output[ch] = lp[ch];
            }
            const float mid = (output[0] + output[1]) * .5f;
            const float side = (output[0] - output[1]) * .5f * width.getNextValue();
            return { mid + side, mid - side };
        }
    };
    std::array<Tank, 3> tanks;
    std::array<juce::SmoothedValue<float>, 3> weights;
    BuiltInReverbSpillover<3> spillWeights;
    bool spillover = false;
    bool prepared = false;

public:
    void prepare(double sampleRate, int selected)
    {
        constexpr std::array<float, 3> scales {.8f, 1.0f, 1.23f};
        for (size_t i = 0; i < tanks.size(); ++i)
        {
            tanks[i].prepare(sampleRate, scales[i]);
            weights[i].reset(sampleRate, .05);
            weights[i].setCurrentAndTargetValue(selected == static_cast<int>(i) ? 1.0f : 0.0f);
        }
        spillWeights.prepare(sampleRate,selected);
        prepared = true;
    }
    void reset() { for (auto& tank : tanks) tank.reset(); spillWeights.reset(weights); }
    void configure(int selected, Settings settings, bool retainTails = false)
    {
        spillover = retainTails;
        const auto safe = [](float value, float minimum, float maximum, float fallback)
        { return std::isfinite(value) ? juce::jlimit(minimum, maximum, value) : fallback; };
        settings.decay = safe(settings.decay, .1f, 20, 2);
        settings.damping = safe(settings.damping, 0, 1, .5f);
        settings.diffusion = safe(settings.diffusion, 0, 1, .5f);
        settings.preDelay = safe(settings.preDelay, 0, 500, 0);
        settings.lowCut = safe(settings.lowCut, 20, 500, 20);
        settings.highCut = safe(settings.highCut, 1000, 20000, 20000);
        settings.width = safe(settings.width, 0, 1, 1);
        settings.modulation = safe(settings.modulation, 0, 1, .25f);
        settings.decayFilter = juce::jlimit(0, 2, settings.decayFilter);
        settings.decayCutoff = safe(settings.decayCutoff, 200, 20000, 8000);
        for (size_t i = 0; i < tanks.size(); ++i)
        {
            const bool active = selected == static_cast<int>(i);
            weights[i].setTargetValue(active ? 1.0f : 0.0f);
            if (active || tanks[i].drain > 0) tanks[i].configure(settings, active);
            spillWeights.configure(i,active,spillover,tanks[i].drain>0);
        }
    }
    double retiringTailSeconds() const noexcept
    {
        double seconds=0;
        for(size_t i=0;i<tanks.size();++i)if(spillWeights.audibleRetiring(i))seconds=juce::jmax(seconds,static_cast<double>(tanks[i].drain)/tanks[i].rate);
        return seconds;
    }
    std::array<float, 3> process(float left, float right)
    {
        if (!prepared) return {};
        const auto safe = [](float value) { return std::isfinite(value) ? juce::jlimit(-16.0f, 16.0f, value) : 0.0f; };
        const float mono = (safe(left) + safe(right)) * .5f;
        std::array<float, 3> output {};
        for (size_t i = 0; i < tanks.size(); ++i)
        {
            const auto wet = tanks[i].process(mono, weights[i].getTargetValue() > 0);
            const float weight = weights[i].getNextValue(),wetWeight=spillWeights.next(i);
            output[0] += wet[0] * wetWeight; output[1] += wet[1] * wetWeight; output[2] += weight;
        }
        return output;
    }
};
