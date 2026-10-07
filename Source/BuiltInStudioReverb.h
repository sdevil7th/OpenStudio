#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include <array>
#include <vector>

// Original standalone studio spaces. Orthogonal feedback and delay-proportional
// attenuation follow the FDN lossless-prototype method (Schlecht/Habets 2016;
// DAFx 2023 paper 32). These are not measured venues or D-Verb emulations.
class BuiltInStudioReverb
{
public:
    struct Settings
    {
        float decay = 2, size = .5f, damping = .5f, diffusion = .5f;
        float preDelay = 0, lowCut = 20, highCut = 20000, early = .5f;
        float width = 1, modulation = .15f, bassRatio = 1;
        bool freeze = false, infiniteInput = false;
        int decayFilter=0; float decayCutoff=8000; bool outputCutOff=false;
    };
private:
    struct Delay
    {
        std::vector<float> data;
        int position = 0, valid = 0;
        void prepare(int length) { data.assign(static_cast<size_t>(length + 4), 0.0f); reset(); }
        // Drain completion runs on the callback. Invalidate history instead of
        // clearing sample-rate-sized buffers; new writes make taps valid again.
        void reset() noexcept { position = 0; valid = 0; }
        float read(float samples) const noexcept
        {
            const int whole = static_cast<int>(samples), size = static_cast<int>(data.size());
            const float fraction = samples - static_cast<float>(whole);
            const int a = (position + size - whole) % size, b = (a + size - 1) % size;
            const float first = whole <= valid ? data[static_cast<size_t>(a)] : 0.0f;
            const float second = whole + 1 <= valid ? data[static_cast<size_t>(b)] : 0.0f;
            return first + fraction * (second - first);
        }
        void write(float sample) noexcept
        {
            data[static_cast<size_t>(position)] = sample;
            valid = juce::jmin(valid + 1, static_cast<int>(data.size()));
            if (++position == static_cast<int>(data.size())) position = 0;
        }
        float through(float sample, float samples) noexcept
        {
            data[static_cast<size_t>(position)] = sample;
            const float result = read(samples);
            valid = juce::jmin(valid + 1, static_cast<int>(data.size()));
            if (++position == static_cast<int>(data.size())) position = 0;
            return result;
        }
    };
    struct Engine
    {
        std::array<Delay, 16> lines;
        std::array<std::array<Delay, 4>, 2> diffusers;
        std::array<Delay, 2> pre, early;
        std::array<juce::SmoothedValue<float>, 16> length, gain, bassGain;
        std::array<juce::SmoothedValue<float>, 4> diffuserGain;
        juce::SmoothedValue<float> preSamples, inputGain, scatter, dampPole, lowPole, highPole, earlyGain, width, depth, size;
        std::array<float, 16> base {}, bassState {}, dampState {};
        std::array<float, 2> lowState {}, highState {};
        std::array<int, 4> diffuserLength {};
        Settings settings;
        float rate = 48000, bassPole = 0;
        double phase = 0;
        int kind = 0, count = 8, stages = 1, drain = 0;
        bool initialized = false;
        void prepare(double sampleRate, int type)
        {
            rate = static_cast<float>(sampleRate); kind = type;
            count = kind == 1 || kind == 3 ? 16 : 8;
            stages = kind == 5 ? 2 : kind == 0 || kind == 4 ? 1 : (kind == 2 ? 3 : 4);
            constexpr std::array<std::array<float, 16>, 6> milliseconds {{
                {{7.1f,11.3f,13.7f,17.9f,19.3f,23.9f,29.3f,31.1f}},
                {{29.9f,37.1f,41.3f,43.9f,47.3f,53.9f,59.3f,61.7f,67.1f,71.9f,79.3f,83.9f,89.3f,97.1f,101.3f,107.9f}},
                {{13.1f,17.3f,23.3f,31.1f,37.7f,43.3f,53.3f,59.9f}},
                {{43.7f,59.3f,67.1f,79.7f,89.3f,101.9f,113.3f,127.7f,139.1f,149.9f,163.7f,179.3f,191.9f,199.7f,211.1f,223.9f}},
                {{2.3f,3.7f,5.3f,7.1f,8.9f,11.3f,13.7f,17.3f}},
                {{3.7f,5.3f,7.9f,9.7f,11.9f,13.3f,17.3f,19.1f}}
            }};
            for (int i = 0; i < count; ++i)
            {
                const auto slot = static_cast<size_t>(i);
                base[slot] = milliseconds[static_cast<size_t>(kind)][slot] * .001f * rate;
                lines[slot].prepare(static_cast<int>(base[slot] * 1.6f + rate * .002f));
                length[slot].reset(sampleRate, .1); gain[slot].reset(sampleRate, .05); bassGain[slot].reset(sampleRate, .05);
            }
            constexpr std::array<float, 4> diffuserMs {1.3f,3.1f,5.3f,7.9f};
            for (size_t i = 0; i < 4; ++i)
            {
                const float diffuserScale = kind == 5 ? .65f : kind == 3 ? 2.7f : (kind == 4 ? .5f : 1.0f);
                diffuserLength[i] = juce::jmax(1,juce::roundToInt(diffuserMs[i] * diffuserScale * .001f * rate));
                for (auto& channel : diffusers) channel[i].prepare(diffuserLength[i]);
                diffuserGain[i].reset(sampleRate,.05);
            }
            for (auto& line : pre) line.prepare(static_cast<int>(rate*.501f));
            for (auto& line : early) line.prepare(static_cast<int>(rate*.6f));
            for (auto* smoother : { &preSamples,&inputGain,&scatter,&dampPole,&lowPole,&highPole,&earlyGain,&width,&depth,&size }) smoother->reset(sampleRate,.05);
            bassPole = std::exp(-juce::MathConstants<float>::twoPi * 250.0f / rate);
            reset();
        }
        void reset()
        {
            for (auto& line : lines) line.reset();
            for (auto& channel : diffusers) for (auto& line : channel) line.reset();
            for (auto& line : pre) line.reset();
            for (auto& line : early) line.reset();
            bassState.fill(0); dampState.fill(0); lowState.fill(0); highState.fill(0);
            initialized = false; drain = 0; phase = 0;
        }
        void configure(const Settings& values, bool active)
        {
            if (active) settings = values;
            const bool hold = active && settings.freeze;
            const auto set = [this](auto& smoother, float target)
            {
                if (initialized) smoother.setTargetValue(target); else smoother.setCurrentAndTargetValue(target);
            };
            const float scale = .5f + settings.size;
            for (int i = 0; i < count; ++i)
            {
                const auto slot = static_cast<size_t>(i);
                // Integer settled lengths avoid interpolation loss in an unmodulated tank.
                const float samples = static_cast<float>(juce::jmax(1,juce::roundToInt(base[slot]*scale)));
                set(length[slot], samples);
                set(gain[slot], hold ? 1 : std::pow(.001f,samples/(rate*settings.decay)));
                set(bassGain[slot], hold ? 1 : std::pow(.001f,samples/(rate*settings.decay*settings.bassRatio)));
            }
            for (size_t i = 0; i < 4; ++i) set(diffuserGain[i],std::pow(.001f,static_cast<float>(diffuserLength[i])/(rate*settings.decay)));
            set(preSamples,settings.preDelay*.001f*rate); set(inputGain,active && (!hold || settings.infiniteInput) ? 1.0f : 0.0f);
            set(scatter,settings.diffusion*.72f);
            const float cutoff = kind == 5 ? 20000 * std::pow(1.0f/16.0f,settings.damping) : 18000 * std::pow(1.0f/36.0f,settings.damping);
            set(dampPole,hold||settings.decayFilter==1 ? 0 : settings.decayFilter==2
                ? std::exp(-juce::MathConstants<float>::twoPi*juce::jmin(rate*.45f,settings.decayCutoff)/rate)
                : settings.damping*std::exp(-juce::MathConstants<float>::twoPi*cutoff/rate));
            set(lowPole,std::exp(-juce::MathConstants<float>::twoPi*settings.lowCut/rate));
            set(highPole,settings.outputCutOff?0:std::exp(-juce::MathConstants<float>::twoPi*juce::jmin(rate*.45f,settings.highCut)/rate));
            set(earlyGain,settings.early); set(width,settings.width); set(depth,hold ? 0 : settings.modulation*rate*.00035f);
            set(size,scale); initialized = true;
        }
        // Each topology is orthogonal. No convex matrix blending (which would
        // introduce unintended decay) and no random allocation in the callback.
        void mix(std::array<float,16>& values) const noexcept
        {
            if (kind == 0)
            {
                float sum = 0; for (int i = 0; i < count; ++i) sum += values[static_cast<size_t>(i)];
                for (int i = 0; i < count; ++i) values[static_cast<size_t>(i)] -= sum*.25f;
            }
            else if (kind == 5)
            {
                // Compact room: eight-line Hadamard scattering differs from the
                // original room's Householder matrix, not just its delay scale.
                for(int step=1;step<8;step*=2)for(int group=0;group<8;group+=step*2)for(int j=0;j<step;++j)
                {
                    const auto a=static_cast<size_t>(group+j),b=static_cast<size_t>(group+j+step);
                    const float x=values[a],y=values[b];values[a]=x+y;values[b]=x-y;
                }
                for(int i=0;i<8;++i)values[static_cast<size_t>(i)]*=.35355339f;
            }
            else if (kind == 1)
            {
                for (int step = 1; step < 16; step *= 2) for (int group = 0; group < 16; group += step*2) for (int j = 0; j < step; ++j)
                {
                    const auto a = static_cast<size_t>(group+j), b = static_cast<size_t>(group+j+step);
                    const float x = values[a], y = values[b]; values[a] = x+y; values[b] = x-y;
                }
                for (auto& value : values) value *= .25f;
            }
            else
            {
                // Church uses four unequal rotations across sixteen long lines;
                // Ambience uses shallow rotations for a sparse short late field.
                constexpr std::array<float,4> cosine {.85252452f,.71091354f,.60582016f,.80802751f};
                constexpr std::array<float,4> sine {.52268723f,.70327942f,.79560162f,.58914476f};
                int stage = 0;
                for (int step = 1; step < count; step *= 2, ++stage) for (int group = 0; group < count; group += step*2) for (int j = 0; j < step; ++j)
                {
                    const auto a = static_cast<size_t>(group+j), b = static_cast<size_t>(group+j+step), k = static_cast<size_t>(stage);
                    const float c = kind == 4 ? .98006658f : cosine[k], s = kind == 4 ? .19866933f : sine[k];
                    const float x = values[a], y = values[b]; values[a] = c*x-s*y; values[b] = s*x+c*y;
                }
            }
        }
        std::array<float,2> process(float left, float right, bool active)
        {
            if (active) drain = static_cast<int>(rate*(settings.decay*juce::jmax(1.0f,settings.bassRatio)*2+2));
            else if (drain == 0) return {};
            else if (--drain == 0) { reset(); return {}; }
            const float send = inputGain.getNextValue(), predelay = preSamples.getNextValue(), scale = size.getNextValue();
            std::array<float,2> input {pre[0].through(left*send,predelay)*send,pre[1].through(right*send,predelay)*send};
            for (size_t ch = 0; ch < 2; ++ch) early[ch].write(input[ch]);
            constexpr std::array<std::array<float,8>,6> earlyMs {{
                {{3.1f,5.7f,8.3f,12.7f,17.1f,21.7f,26.9f,32.3f}},
                {{19.3f,27.1f,38.3f,49.7f,63.1f,79.7f,97.3f,119.3f}},
                {{5.3f,9.7f,16.1f,19.9f,28.3f,36.7f,48.1f,67.3f}},
                {{31.7f,47.3f,67.1f,89.9f,119.3f,157.1f,199.7f,257.3f}},
                {{1.7f,2.9f,4.7f,6.1f,8.3f,11.9f,16.1f,23.3f}},
                {{2.1f,3.7f,5.3f,7.9f,11.3f,13.7f,17.1f,20.3f}}
            }};
            std::array<float,2> output {};
            const float earlyLevel = earlyGain.getNextValue()*send;
            for (int tap = 0; tap < 8; ++tap)
            {
                const float time = earlyMs[static_cast<size_t>(kind)][static_cast<size_t>(tap)] * .001f * rate * scale;
                const float amplitude = earlyLevel*(kind == 4 ? .28f : .14f)*std::exp(-.21f*static_cast<float>(tap));
                output[0] += early[static_cast<size_t>(tap%2)].read(time+1)*amplitude;
                output[1] += early[static_cast<size_t>((tap+1)%2)].read(time*1.113f+1)*amplitude*(tap%3==0 ? -.8f : 1.0f);
            }
            const float coefficient = scatter.getNextValue();
            for (int stage = 0; stage < stages; ++stage)
            {
                const auto slot = static_cast<size_t>(stage); const float loss = diffuserGain[slot].getNextValue();
                for (size_t ch = 0; ch < 2; ++ch)
                {
                    auto& line = diffusers[ch][slot]; const float delayed = line.read(static_cast<float>(diffuserLength[slot]))*loss;
                    const float state = input[ch]+coefficient*delayed; line.write(state); input[ch] = delayed-coefficient*state;
                }
            }
            std::array<float,16> taps {};
            const float modulation = depth.getNextValue(), damping = dampPole.getNextValue();
            const float normalization = count == 16 ? .25f : .35355339f;
            const float lateLevel = kind == 5 ? .45f : kind == 4 ? .14f : .55f;
            for (int i = 0; i < count; ++i)
            {
                const auto slot = static_cast<size_t>(i);
                const float excursion = modulation*static_cast<float>(std::sin(phase*(1.0+.07*i)+i*.93));
                const float value = lines[slot].read(length[slot].getNextValue()+excursion);
                output[0] += value*normalization*(i%2==0 ? lateLevel : -lateLevel);
                output[1] += value*normalization*(i%4<2 ? lateLevel : -lateLevel);
                bassState[slot] = value+bassPole*(bassState[slot]-value);
                const float midGain = gain[slot].getNextValue(), lowGain = bassGain[slot].getNextValue();
                const float filtered = value*midGain + bassState[slot]*(lowGain-midGain);
                dampState[slot] = filtered+damping*(dampState[slot]-filtered); taps[slot] = dampState[slot];
            }
            mix(taps);
            for (int i = 0; i < count; ++i)
            {
                const float sample = taps[static_cast<size_t>(i)] + input[static_cast<size_t>(i%2)]*normalization*.4f*(i%3==0 ? -1.0f : 1.0f);
                lines[static_cast<size_t>(i)].write(settings.freeze && settings.infiniteInput ? juce::jlimit(-8.0f,8.0f,sample) : sample);
            }
            phase += juce::MathConstants<double>::twoPi*.23/static_cast<double>(rate);
            // Very long-period reset outside any audible session avoids unbounded phase.
            if (phase > juce::MathConstants<double>::twoPi*1000000) phase = 0;
            const float high = highPole.getNextValue(), low = lowPole.getNextValue();
            for (size_t ch = 0; ch < 2; ++ch)
            {
                lowState[ch] = output[ch]+low*(lowState[ch]-output[ch]);
                const float value = output[ch]-lowState[ch];
                highState[ch] = value+high*(highState[ch]-value); output[ch] = highState[ch];
            }
            const float mid = (output[0]+output[1])*.5f, side = (output[0]-output[1])*.5f*width.getNextValue();
            return {mid+side,mid-side};
        }
    };
    std::array<Engine,6> engines;
    std::array<juce::SmoothedValue<float>,6> weights;
    BuiltInReverbSpillover<6> spillWeights;
    bool spillover = false;
    bool prepared = false;
public:
    void prepare(double rate, int selected)
    {
        for (size_t i = 0; i < engines.size(); ++i)
        {
            engines[i].prepare(rate,static_cast<int>(i)); weights[i].reset(rate,.05);
            weights[i].setCurrentAndTargetValue(selected==static_cast<int>(i) ? 1.0f : 0.0f);
        }
        spillWeights.prepare(rate,selected);
        prepared = true;
    }
    void reset() { for (auto& engine : engines) engine.reset(); spillWeights.reset(weights); }
    void configure(int selected, Settings settings, bool retainTails = false)
    {
        spillover = retainTails;
        const auto safe = [](float value,float lo,float hi,float fallback) { return std::isfinite(value) ? juce::jlimit(lo,hi,value) : fallback; };
        settings.decay=safe(settings.decay,.1f,20,2); settings.size=safe(settings.size,0,1,.5f);
        settings.damping=safe(settings.damping,0,1,.5f); settings.diffusion=safe(settings.diffusion,0,1,.5f);
        settings.preDelay=safe(settings.preDelay,0,500,0); settings.lowCut=safe(settings.lowCut,20,500,20);
        settings.highCut=safe(settings.highCut,1000,20000,20000); settings.early=safe(settings.early,0,1,.5f);
        settings.width=safe(settings.width,0,1,1); settings.modulation=safe(settings.modulation,0,1,.15f);
        settings.bassRatio=safe(settings.bassRatio,.5f,2,1);
        settings.decayFilter=juce::jlimit(0,2,settings.decayFilter);settings.decayCutoff=safe(settings.decayCutoff,200,20000,8000);
        for (size_t i = 0; i < engines.size(); ++i)
        {
            const bool active=selected==static_cast<int>(i); weights[i].setTargetValue(active ? 1.0f : 0.0f);
            if (active || engines[i].drain>0) engines[i].configure(settings,active);
            spillWeights.configure(i,active,spillover,engines[i].drain>0);
        }
    }
    double retiringTailSeconds() const noexcept
    {
        double seconds=0;
        for(size_t i=0;i<engines.size();++i)if(spillWeights.audibleRetiring(i))seconds=juce::jmax(seconds,static_cast<double>(engines[i].drain)/engines[i].rate);
        return seconds;
    }
    std::array<float,3> process(float left,float right)
    {
        if (!prepared) return {};
        const auto safe=[](float value) { return std::isfinite(value) ? juce::jlimit(-16.0f,16.0f,value) : 0.0f; };
        std::array<float,3> output {};
        for (size_t i = 0; i < engines.size(); ++i)
        {
            const auto wet=engines[i].process(safe(left),safe(right),weights[i].getTargetValue()>0);
            const float weight=weights[i].getNextValue(),wetWeight=spillWeights.next(i); output[0]+=wet[0]*wetWeight; output[1]+=wet[1]*wetWeight; output[2]+=weight;
        }
        return output;
    }
};
