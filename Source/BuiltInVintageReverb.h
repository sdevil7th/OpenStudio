#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include "BuiltInVintageConverter.h"
#include <array>
#include <vector>

// Original nested-allpass stereo spaces, not commercial algorithm emulations.
// Random motion crossfades stationary read taps; Hall uses moving chorus taps.
class BuiltInVintageReverb
{
public:
    struct Settings
    {
        float decay = 2, size = .5f, damping = .5f, diffusion = .5f;
        float preDelay = 0, lowCut = 20, highCut = 20000, width = 1;
        float colour = 0, modulation = .35f, speed = .3f;
        float bassRatio = 1, bassFrequency = 500, conversion = 0;
        float buildUp = 0, inputDiffusion = .5f, tankRate = 0;
    };
    struct DecayShelf
    {
        double state = 0;
        float process(float input, float highGain, float lowGain, float coefficient) noexcept
        {
            const double v = (static_cast<double>(input) - state) * coefficient;
            const double low = v + state; state = low + v;
            return lowGain == highGain ? input * highGain
                : static_cast<float>(input * highGain + (lowGain - highGain) * low);
        }
    };
private:
    struct Delay
    {
        std::vector<float> data;
        int position = 0, valid = 0;
        void prepare(int length) { data.assign(static_cast<size_t>(length + 4), 0); reset(); }
        void reset() noexcept { position = 0; valid = 0; }
        float read(float samples) const noexcept
        {
            samples = juce::jlimit(1.0f, static_cast<float>(data.size() - 2), samples);
            const int whole = static_cast<int>(samples), length = static_cast<int>(data.size());
            const int a = (position + length - whole) % length, b = (a + length - 1) % length;
            const float x = whole <= valid ? data[static_cast<size_t>(a)] : 0;
            const float y = whole + 1 <= valid ? data[static_cast<size_t>(b)] : 0;
            return x + (samples - static_cast<float>(whole)) * (y - x);
        }
        void write(float value) noexcept
        {
            data[static_cast<size_t>(position)] = value;
            valid = juce::jmin(valid + 1, static_cast<int>(data.size()));
            if (++position == static_cast<int>(data.size())) position = 0;
        }
    };
    struct Section
    {
        Delay outer, inner;
        float outerMs = 0, innerMs = 0;
        juce::SmoothedValue<float> length, innerLength, loss, innerLoss, bassLoss, innerBassLoss;
        DecayShelf outerShelf, innerShelf;
        double phase = 0;
        float from = 0, to = 0;
        juce::uint32 seed = 1;
        float random() noexcept
        {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
            return static_cast<float>(seed & 0xffffffu) / 8388607.5f - 1;
        }
        void reset() noexcept { outer.reset(); inner.reset(); outerShelf = {}; innerShelf = {}; phase = 0; seed = static_cast<juce::uint32>(outerMs * 1000) + 1; from = random(); to = random(); }
        float process(float input, float coefficient, float depth, float speed, float resolution, float rate, bool randomized, float bassCoefficient) noexcept
        {
            const float samples = length.getNextValue();
            const auto tap = [&](float offset) {
                float time = samples + offset;
                if (resolution > 0) time = std::round(time * resolution) / resolution;
                return outer.read(time);
            };
            float delayed;
            if (randomized)
            {
                // Convex smoothstep fade: fixed taps during each cycle, no
                // moving read head and no equal-power gain rise in feedback.
                const float t = static_cast<float>(phase), blend = t * t * (3 - 2 * t);
                delayed = tap(from * depth) * (1 - blend) + tap(to * depth) * blend;
            }
            else delayed = tap(depth * static_cast<float>(std::sin(phase * juce::MathConstants<double>::twoPi)));
            phase += static_cast<double>(speed / rate);
            if (phase >= 1) { phase -= 1; from = to; to = random(); }
            delayed = outerShelf.process(delayed, loss.getNextValue(), bassLoss.getNextValue(), bassCoefficient);
            const float nested = innerShelf.process(inner.read(innerLength.getNextValue()), innerLoss.getNextValue(), innerBassLoss.getNextValue(), bassCoefficient);
            const float innerOutput = nested - .5f * coefficient * delayed;
            inner.write(delayed + .5f * coefficient * innerOutput);
            const float output = innerOutput - coefficient * input;
            outer.write(input + coefficient * output);
            return output;
        }
    };
    struct Engine
    {
        std::array<std::array<Section, 3>, 2> sections;
        std::array<Delay, 2> loop, pre;
        std::array<std::array<Delay, 4>, 2> inputDiffusers;
        juce::SmoothedValue<float> buildUpSamples, inputDiffusion, buildUpMix;
        std::array<juce::SmoothedValue<float>, 2> loopLength, loopLoss, loopBassLoss;
        std::array<DecayShelf, 2> loopShelf;
        juce::SmoothedValue<float> bassCoefficient;
        float lastBassFrequency = -1, targetBassCoefficient = 0;
        juce::SmoothedValue<float> diffusion, depth, speed, preSamples, damping, lowPole, highPole, width, colour;
        std::array<float, 2> dampState {}, lowState {}, highState {};
        Settings settings;
        BuiltInVintageConverter converter;
        double rate = 48000;
        juce::int64 drain = 0;
        juce::uint64 frames = 0;
        bool initialized = false, randomized = false;
        void prepare(double sampleRate, bool randomMode)
        {
            rate = sampleRate; randomized = randomMode;converter.prepare(rate);
            constexpr std::array<float, 6> outerTimes { 17.3f, 31.1f, 43.7f, 19.7f, 37.1f, 47.9f };
            constexpr std::array<float, 6> innerTimes { 3.1f, 5.3f, 7.9f, 4.3f, 6.7f, 11.3f };
            for (size_t ch = 0; ch < 2; ++ch)
            {
                loop[ch].prepare(static_cast<int>(rate * .15)); pre[ch].prepare(static_cast<int>(rate * .501));
                for (auto& line : inputDiffusers[ch]) line.prepare(static_cast<int>(rate * .121));
                loopLength[ch].reset(rate, .1); loopLoss[ch].reset(rate, .05); loopBassLoss[ch].reset(rate, .05);
                for (size_t i = 0; i < 3; ++i)
                {
                    auto& section = sections[ch][i];
                    section.outerMs = outerTimes[ch * 3 + i] * (randomized ? 1.43f : 1.0f);
                    section.innerMs = innerTimes[ch * 3 + i] * (randomized ? 1.67f : 1.0f);
                    section.outer.prepare(static_cast<int>(rate * (section.outerMs * .0015 + .006)));
                    section.inner.prepare(static_cast<int>(rate * section.innerMs * .0015));
                    for (auto* value : { &section.length, &section.innerLength, &section.loss, &section.innerLoss, &section.bassLoss, &section.innerBassLoss }) value->reset(rate, .1);
                }
            }
            for (auto* value : { &diffusion, &depth, &speed, &preSamples, &damping, &lowPole, &highPole, &width, &colour, &bassCoefficient }) value->reset(rate, .05);
            buildUpSamples.reset(rate, .1); inputDiffusion.reset(rate, .05); buildUpMix.reset(rate, .05);
            reset(); frames = 0;
        }
        void reset() noexcept
        {
            for (auto& channel : sections) for (auto& section : channel) section.reset();
            for (auto& line : loop) line.reset();
            for (auto& line : pre) line.reset();
            for (auto& channel : inputDiffusers) for (auto& line : channel) line.reset();
            converter.reset();
            dampState.fill(0); lowState.fill(0); highState.fill(0); loopShelf.fill({}); drain = 0; initialized = false; lastBassFrequency = -1;
        }
        void configure(const Settings& next, bool active)
        {
            if (active) settings = next;
            converter.configure(settings.conversion>=.5f,juce::roundToInt(settings.colour));
            const auto set = [this](auto& target, float value) { if (initialized) target.setTargetValue(value); else target.setCurrentAndTargetValue(value); };
            const float sampleRate = static_cast<float>(rate), scale = .5f + settings.size;
            const auto loss = [&](float length) { return std::pow(.001f, length / (sampleRate * settings.decay)); };
            const auto bassLoss = [&](float length) { return settings.bassRatio == 1 ? loss(length) : std::pow(.001f, length / (sampleRate * settings.decay * settings.bassRatio)); };
            if (lastBassFrequency != settings.bassFrequency)
            {
                lastBassFrequency = settings.bassFrequency;
                const double g = std::tan(juce::MathConstants<double>::pi * juce::jmin(rate * .45, static_cast<double>(lastBassFrequency)) / rate);
                targetBassCoefficient = static_cast<float>(g / (1 + g));
            }
            set(bassCoefficient, targetBassCoefficient);
            set(buildUpSamples, settings.buildUp * .001f * sampleRate);
            set(inputDiffusion, settings.inputDiffusion * .75f);
            set(buildUpMix, settings.buildUp > 0 ? 1.0f : 0.0f);
            for (size_t ch = 0; ch < 2; ++ch)
            {
                const float length = std::round(sampleRate * (ch == 0 ? .053f : .071f) * scale);
                set(loopLength[ch], length); set(loopLoss[ch], loss(length)); set(loopBassLoss[ch], bassLoss(length));
                for (auto& section : sections[ch])
                {
                    const float outerLength = std::round(sampleRate * section.outerMs * .001f * scale);
                    const float innerLength = std::round(sampleRate * section.innerMs * .001f * scale);
                    set(section.length, outerLength); set(section.innerLength, innerLength);
                    set(section.loss, loss(outerLength)); set(section.innerLoss, loss(innerLength));
                    set(section.bassLoss, bassLoss(outerLength)); set(section.innerBassLoss, bassLoss(innerLength));
                }
            }
            set(diffusion, .1f + .6f * settings.diffusion); set(depth, settings.modulation * sampleRate * .0015f);
            set(speed, settings.speed); set(preSamples, settings.preDelay * .001f * sampleRate);
            set(damping, settings.damping * std::exp(-juce::MathConstants<float>::twoPi * (18000 * std::pow(1.0f / 36, settings.damping)) / sampleRate));
            set(lowPole, std::exp(-juce::MathConstants<float>::twoPi * settings.lowCut / sampleRate));
            const float bandwidth = settings.colour < .5f ? 8000.0f : (settings.colour < 1.5f ? 16000.0f : 20000.0f);
            set(highPole, std::exp(-juce::MathConstants<float>::twoPi * juce::jmin(sampleRate * .45f, juce::jmin(settings.highCut, bandwidth)) / sampleRate));
            set(width, settings.width); set(colour, settings.colour); initialized = true;
        }
        std::array<float, 2> process(float left, float right, bool active)
        {
            if (active) drain = static_cast<juce::int64>(rate * (settings.decay * juce::jmax(1.0f, settings.bassRatio) * 2 + 2 + settings.buildUp * .03f));
            else if (drain == 0) return {};
            else if (--drain == 0) { reset(); return {}; }
            ++frames;
            const float tone = colour.getNextValue(), motion = depth.getNextValue(), motionRate = speed.getNextValue();
            const float resolution = settings.colour < .5f ? 8.0f : (settings.colour < 1.5f ? 64.0f : 0.0f);
            const float coefficient = diffusion.getNextValue(), predelay = preSamples.getNextValue(), damp = damping.getNextValue();
            const float bass = bassCoefficient.getNextValue();
            const float spread = buildUpSamples.getNextValue(), inputCoefficient = inputDiffusion.getNextValue(), spreadMix = buildUpMix.getNextValue();
            constexpr std::array<std::array<float, 4>, 2> spreadRatios {{ { .127f, .193f, .283f, .397f }, { .149f, .211f, .271f, .369f } }};
            std::array<float, 2> input { active ? left : 0, active ? right : 0 }, output {};
            for (size_t ch = 0; ch < 2; ++ch)
            {
                pre[ch].write(input[ch]); input[ch] = pre[ch].read(predelay + 1);
                // Keep the zero-build-up path bit-identical. Histories reset
                // while fully bypassed, so enabling cannot revive old input.
                if (spreadMix > 0)
                {
                    float diffused = input[ch];
                    for (size_t section = 0; section < 4; ++section)
                    {
                        auto& line = inputDiffusers[ch][section];
                        const float delayed = line.read(juce::jmax(1.0f, spread * spreadRatios[ch][section]));
                        const float outputValue = delayed - inputCoefficient * diffused;
                        line.write(diffused + inputCoefficient * outputValue); diffused = outputValue;
                    }
                    input[ch] += spreadMix * (diffused - input[ch]);
                }
                else for (auto& line : inputDiffusers[ch]) line.reset();
                output[ch] = loopShelf[ch].process(loop[ch].read(loopLength[ch].getNextValue()), loopLoss[ch].getNextValue(), loopBassLoss[ch].getNextValue(), bass);
                dampState[ch] = output[ch] + damp * (dampState[ch] - output[ch]);
            }
            for (size_t ch = 0; ch < 2; ++ch)
            {
                float signal = input[ch] * .3f + dampState[1 - ch] * (ch == 0 ? -1.0f : 1.0f);
                for (size_t i = 0; i < 3; ++i)
                    signal = sections[ch][i].process(signal, coefficient, motion,
                        motionRate * (1 + static_cast<float>(i + ch * 3) * .137f), resolution, static_cast<float>(rate), randomized, bass);
                loop[ch].write(signal);
            }
            const float low = lowPole.getNextValue(), high = highPole.getNextValue();
            const auto rawOutput=output;std::array<float,2> coloured{};
            for (size_t ch = 0; ch < 2; ++ch)
            {
                // Quantize outside feedback to avoid converter limit cycles.
                // Companding follows instantaneous amplitude; zero stays zero.
                const auto quantized = [](float value, float steps) {
                    const float compressed = value / (1 + std::abs(value));
                    const float rounded = std::round(compressed * steps) / steps;
                    return rounded / juce::jmax(.01f, 1 - std::abs(rounded));
                };
                const float coarse = quantized(output[ch], 2048), fine = quantized(output[ch], 32768);
                coloured[ch] = tone < 1 ? coarse + tone * (fine - coarse) : fine + (tone - 1) * (output[ch] - fine);
            }
            coloured=converter.process(rawOutput,coloured);
            for(size_t ch=0;ch<2;++ch)
            {
                const float value=coloured[ch];
                lowState[ch] = value + low * (lowState[ch] - value);
                const float cut = value - lowState[ch]; highState[ch] = cut + high * (highState[ch] - cut); output[ch] = highState[ch];
            }
            const float mid = (output[0] + output[1]) * .5f, side = (output[0] - output[1]) * .5f * width.getNextValue();
            return { mid + side, mid - side };
        }
    };
    // Each rate owns its tank, smoothing and converter history. Configuration
    // only selects prepared storage; the callback never resizes a delay line.
    struct RateEngine
    {
        std::array<Engine,3> banks;
        std::array<BuiltInVintageConverter::Bank,2> converters;
        std::array<juce::SmoothedValue<float>,3> weights;
        BuiltInReverbSpillover<3> spill;
        double rate = 48000;
        juce::int64 drain = 0;
        juce::uint64 frames = 0;
        int selected = 0;
        bool initialized = false, active = false;
        std::array<bool,3> processing{};
        void prepare(double sampleRate, bool randomized)
        {
            rate = sampleRate;
            banks[0].prepare(rate,randomized);
            for(size_t i=0;i<2;++i)
            {
                const double internalRate=juce::jmin(rate,i==0?24000.0:48000.0);
                banks[i+1].prepare(internalRate,randomized);
                converters[i].prepare(rate,internalRate,16);
            }
            for(size_t i=0;i<3;++i){weights[i].reset(rate,.05);weights[i].setCurrentAndTargetValue(i==0?1.0f:0.0f);}
            selected=0;spill.prepare(rate,0);reset();frames=0;
        }
        void reset() noexcept
        {
            for(auto& bank:banks)bank.reset();
            for(auto& converter:converters)converter.reset();
            spill.reset(weights);drain=0;initialized=false;active=false;processing.fill(false);
        }
        void configure(const Settings& next, bool enabled, bool retainTails)
        {
            active=enabled;
            if(active)selected=juce::jlimit(0,2,juce::roundToInt(next.tankRate));
            if(!initialized)
            {
                for(size_t i=0;i<3;++i)weights[i].setCurrentAndTargetValue(static_cast<int>(i)==selected?1.0f:0.0f);
                spill.reset(weights);initialized=true;
            }
            for(size_t i=0;i<3;++i)
            {
                const bool chosen=static_cast<int>(i)==selected;
                weights[i].setTargetValue(chosen?1.0f:0.0f);
                if((active&&chosen)||banks[i].drain>0)banks[i].configure(next,active&&chosen);
                spill.configure(i,chosen,retainTails,banks[i].drain>0);
            }
        }
        std::array<float,2> process(float left,float right,bool enabled) noexcept
        {
            std::array<float,2> output{};drain=0;frames=0;
            for(size_t i=0;i<3;++i)
            {
                const bool running=enabled&&active&&static_cast<int>(i)==selected;
                std::array<float,2> wet{};
                if(running||banks[i].drain>0)
                {
                    if(!processing[i] && i>0)converters[i-1].reset();
                    processing[i]=true;
                    if(i==0)wet=banks[i].process(left,right,running);
                    else wet=converters[i-1].processThrough({left,right},[&](const auto& sampled) noexcept {return banks[i].process(sampled[0],sampled[1],running);});
                }
                else processing[i]=false;
                const float weight=spill.next(i);weights[i].getNextValue();
                for(size_t ch=0;ch<2;++ch)output[ch]+=wet[ch]*weight;
                drain=juce::jmax(drain,static_cast<juce::int64>(std::ceil(static_cast<double>(banks[i].drain)*rate/banks[i].rate)));
                frames+=banks[i].frames;
            }
            return output;
        }
    };
    std::array<std::unique_ptr<RateEngine>, 2> engines;
    std::array<juce::SmoothedValue<float>, 2> weights;
    BuiltInReverbSpillover<2> spillWeights;
    bool spillover = false;
    bool prepared = false;
public:
    void prepare(double rate, int selected)
    {
        for (size_t i = 0; i < engines.size(); ++i)
        {
            if (!engines[i]) engines[i] = std::make_unique<RateEngine>();
            engines[i]->prepare(rate, i == 1); weights[i].reset(rate, .05);
            weights[i].setCurrentAndTargetValue(selected == static_cast<int>(i) ? 1.0f : 0.0f);
        }
        spillWeights.prepare(rate,selected);
        prepared = true;
    }
    void reset() { for (auto& engine : engines) if (engine) engine->reset(); spillWeights.reset(weights); }
    void configure(int selected, Settings settings, bool retainTails = false)
    {
        if (!prepared) return;
        spillover = retainTails;
        const auto safe = [](float value, float lo, float hi, float fallback) { return std::isfinite(value) ? juce::jlimit(lo, hi, value) : fallback; };
        settings.decay = safe(settings.decay, .1f, 20, 2); settings.size = safe(settings.size, 0, 1, .5f);
        settings.damping = safe(settings.damping, 0, 1, .5f); settings.diffusion = safe(settings.diffusion, 0, 1, .5f);
        settings.preDelay = safe(settings.preDelay, 0, 500, 0); settings.lowCut = safe(settings.lowCut, 20, 500, 20);
        settings.highCut = safe(settings.highCut, 1000, 20000, 20000); settings.width = safe(settings.width, 0, 1, 1);
        settings.colour = std::round(safe(settings.colour, 0, 2, 0)); settings.modulation = safe(settings.modulation, 0, 1, .35f);
        settings.speed = safe(settings.speed, .05f, 2, .3f);
        settings.conversion=std::round(safe(settings.conversion,0,1,0));
        settings.tankRate=std::round(safe(settings.tankRate,0,2,0));
        settings.buildUp = safe(settings.buildUp, 0, 300, 0); settings.inputDiffusion = safe(settings.inputDiffusion, 0, 1, .5f);
        settings.bassRatio = safe(settings.bassRatio, .25f, 4, 1); settings.bassFrequency = safe(settings.bassFrequency, 100, 10000, 500);
        for (size_t i = 0; i < engines.size(); ++i)
        {
            const bool active = selected == static_cast<int>(i); weights[i].setTargetValue(active ? 1.0f : 0.0f);
            if (active || engines[i]->drain > 0) engines[i]->configure(settings, active, retainTails);
            spillWeights.configure(i,active,spillover,engines[i]->drain>0);
        }
    }
    juce::uint64 processingFrames(size_t slot) const noexcept { return engines[slot] ? engines[slot]->frames : 0; }
    juce::uint64 processingFrames(size_t slot,size_t bank) const noexcept { return engines[slot] ? engines[slot]->banks[bank].frames : 0; }
    double processingRate(size_t slot,size_t bank) const noexcept { return engines[slot] ? engines[slot]->banks[bank].rate : 0; }
    double retiringTailSeconds() const noexcept
    {
        double seconds=0;
        for(size_t i=0;i<engines.size();++i)if(engines[i] && spillWeights.audibleRetiring(i))seconds=juce::jmax(seconds,static_cast<double>(engines[i]->drain)/engines[i]->rate);
        return seconds;
    }
    std::array<float, 3> process(float left, float right)
    {
        if (!prepared) return {};
        const auto safe = [](float value) { return std::isfinite(value) ? juce::jlimit(-16.0f, 16.0f, value) : 0.0f; };
        std::array<float, 3> output {};
        for (size_t i = 0; i < engines.size(); ++i)
        {
            const auto wet = engines[i]->process(safe(left), safe(right), weights[i].getTargetValue() > 0);
            const float weight = weights[i].getNextValue(),wetWeight=spillWeights.next(i); output[0] += wet[0] * wetWeight; output[1] += wet[1] * wetWeight; output[2] += weight;
        }
        return output;
    }
};
