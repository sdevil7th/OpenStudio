#pragma once
#include <JuceHeader.h>
#include <array>
#include <vector>
#include <cmath>

// Original bounded Karplus-Strong extension. Nominal decay precedes the
// additional losses of fractional interpolation and the damping FIR.
class BuiltInPluckedLoop
{
public:
    static constexpr size_t voiceCount = 16 * 16;
    struct Parameters { float decay = 3, damping = .35f, pick = .2f, hardness = .5f, pickup = .15f, mute = 0, body = .46f; int harmonic=1; };
    void prepare(double rate)
    {
        sampleRate = juce::jmax(8000.0, rate); capacity = static_cast<int>(std::ceil(sampleRate / 20)) + 8;
        storage.assign(voiceCount * static_cast<size_t>(capacity), 0);
        for(size_t i=0;i<voiceCount;++i)storageSlots[i]=i;
        lengthSmoothing = static_cast<float>(1 - std::exp(-1 / (sampleRate * .003)));
        bodyCoefficients[0] = juce::dsp::IIR::ArrayCoefficients<float>::makeBandPass(sampleRate, 180, 2.5f);
        bodyCoefficients[1] = juce::dsp::IIR::ArrayCoefficients<float>::makeBandPass(sampleRate, 420, 2.0f);
        for (auto& coefficients : bodyCoefficients)
        { const float inverse = 1 / coefficients[3]; for (auto& value : coefficients) value *= inverse; }
        reset();
    }
    void reset() noexcept { for (auto& voice : voices) voice = {}; }
    void start(size_t index, int note, float velocity, const Parameters& p) noexcept
    {
        auto& voice = voices[index]; voice = {};
        const double frequency = juce::jlimit(20.0, sampleRate / 3, juce::MidiMessage::getMidiNoteInHertz(note));
        voice.delay = static_cast<float>(sampleRate / frequency - 1);
        voice.burst = juce::jmax(3, juce::roundToInt(sampleRate / frequency));
        voice.pickDelay = juce::jmax(1, juce::roundToInt(voice.burst * p.pick));
        voice.excitationCoefficient = .06f + .9f * p.hardness * (.3f + .7f * velocity);
        voice.seed = static_cast<juce::uint32>(note + 1) * 2654435761u;
        voice.harmonic=juce::jlimit(1,6,p.harmonic);
    }
    bool transfer(size_t destination,size_t source) noexcept
    {
        if(destination==source||destination>=voiceCount||source>=voiceCount||voices[source].history==0)return false;
        std::swap(storageSlots[destination],storageSlots[source]);voices[destination]=voices[source];voices[source]={};return true;
    }
    float process(size_t index, float frequency, const Parameters& p) noexcept
    {
        auto& voice = voices[index];
        frequency = juce::jlimit(20.0f, static_cast<float>(sampleRate / 3), frequency);
        const float target = static_cast<float>(sampleRate / frequency - 1);
        voice.delay += (target - voice.delay) * lengthSmoothing;
        if (voice.frequency != frequency || voice.decay != p.decay || voice.mute != p.mute)
        {
            voice.frequency = frequency; voice.decay = p.decay; voice.mute = p.mute;
            voice.loss = static_cast<float>(std::exp(-6.907755278982137 / (frequency * juce::jmax(.03f, p.decay * (1 - .97f * p.mute)))));
        }
        float delayed = read(index, voice, voice.delay);
        if(voice.harmonic>1){for(int partial=1;partial<voice.harmonic;++partial)delayed+=read(index,voice,voice.delay*static_cast<float>(partial)/static_cast<float>(voice.harmonic));delayed/=static_cast<float>(voice.harmonic);}
        const float b = .25f * p.damping;
        const float filtered = b * delayed + (1 - 2 * b) * voice.previous1 + b * voice.previous2;
        voice.previous2 = voice.previous1; voice.previous1 = delayed;
        const auto noise = [&voice](int age) noexcept
        {
            if (age < 0 || age >= voice.burst) return 0.0f;
            juce::uint32 bits = voice.seed + static_cast<juce::uint32>(age) * 747796405u;
            bits = (bits ^ (bits >> 16)) * 2246822519u; bits ^= bits >> 13;
            return static_cast<float>(bits & 0xffffu) / 32768.0f - 1.0f;
        };
        const float excitation = (noise(voice.age) - noise(voice.age - voice.pickDelay)) * .35f;
        voice.excitation += voice.excitationCoefficient * (excitation - voice.excitation);
        const float written = voice.excitation + voice.loss * filtered;
        const float pickup = written - read(index, voice, juce::jmax(1.0f, (voice.delay + 1) * p.pickup));
        storage[storageSlots[index] * static_cast<size_t>(capacity) + static_cast<size_t>(voice.write)] = std::isfinite(written) ? written : 0;
        voice.write = (voice.write + 1) % capacity; voice.history = juce::jmin(capacity - 1, voice.history + 1);
        if (voice.age < voice.burst + voice.pickDelay + 1) ++voice.age;
        double body = 0;
        for (size_t band = 0; band < 2; ++band)
        {
            const auto& c = bodyCoefficients[band]; auto& state = voice.body[band];
            const double value = c[0] * pickup + state[0];
            state[0] = c[1] * pickup - c[4] * value + state[1]; state[1] = c[2] * pickup - c[5] * value;
            body += value;
        }
        const double output = pickup * (1 - .15f * p.body) + body * p.body * .6;
        if (!std::isfinite(output)) { voice = {}; return 0; }
        return static_cast<float>(output);
    }
private:
    struct Voice
    {
        int write = 0, history = 0, age = 0, burst = 3, pickDelay = 1, harmonic=1;
        juce::uint32 seed = 1;
        float delay = 2, frequency = 0, decay = 0, mute = -1, loss = 0, previous1 = 0, previous2 = 0;
        float excitation = 0, excitationCoefficient = .5f;
        std::array<std::array<double, 2>, 2> body {};
    };
    float read(size_t index, const Voice& voice, float delay) const noexcept
    {
        if (std::ceil(delay) > voice.history) return 0;
        float position = static_cast<float>(voice.write) - delay;
        if (position < 0) position += static_cast<float>(capacity);
        const int first = static_cast<int>(position), second = (first + 1) % capacity;
        const auto offset = storageSlots[index] * static_cast<size_t>(capacity);
        const float a = storage[offset + static_cast<size_t>(first)], b = storage[offset + static_cast<size_t>(second)];
        return a + (b - a) * (position - static_cast<float>(first));
    }
    double sampleRate = 44100;
    int capacity = 1;
    float lengthSmoothing = 1;
    std::vector<float> storage;
    std::array<size_t,voiceCount> storageSlots {};
    std::array<Voice, voiceCount> voices;
    std::array<std::array<float, 6>, 2> bodyCoefficients {};
};

class BuiltInGuitarChorus
{
public:
    void prepare(double sampleRate, float amount, float rate, float depth)
    {
        sr = sampleRate; size = static_cast<int>(std::ceil(sr * .04)) + 4;
        for (auto& line : lines) line.assign(static_cast<size_t>(size), 0);
        mix.reset(sr, .02); speed.reset(sr, .02); excursion.reset(sr, .02);
        mix.setCurrentAndTargetValue(amount); speed.setCurrentAndTargetValue(rate); excursion.setCurrentAndTargetValue(depth);
        reset();
    }
    void reset() noexcept { position = history = 0; phase = 0; }
    void process(juce::AudioBuffer<float>& audio, float amount, float rate, float depth) noexcept
    {
        mix.setTargetValue(amount); speed.setTargetValue(rate); excursion.setTargetValue(depth);
        for (int i = 0; i < audio.getNumSamples(); ++i)
        {
            const float blend = mix.getNextValue(), motion = excursion.getNextValue();
            const float left = audio.getSample(0, i), right = audio.getNumChannels() > 1 ? audio.getSample(1, i) : left;
            std::array<float, 2> wet {};
            for (size_t ch = 0; ch < 2; ++ch)
            {
                lines[ch][static_cast<size_t>(position)] = ch == 0 ? left : right;
                const float delay = static_cast<float>(sr * .001) * (12 + motion * std::sin(phase + static_cast<float>(ch) * juce::MathConstants<float>::halfPi));
                if (std::ceil(delay) <= history)
                {
                    float read = static_cast<float>(position) - delay; if (read < 0) read += static_cast<float>(size);
                    const int first = static_cast<int>(read), second = (first + 1) % size;
                    wet[ch] = lines[ch][static_cast<size_t>(first)] + (lines[ch][static_cast<size_t>(second)] - lines[ch][static_cast<size_t>(first)]) * (read - static_cast<float>(first));
                }
            }
            position = (position + 1) % size; history = juce::jmin(size - 1, history + 1);
            phase += static_cast<float>(juce::MathConstants<double>::twoPi / sr) * speed.getNextValue();
            if (phase >= juce::MathConstants<float>::twoPi) phase -= juce::MathConstants<float>::twoPi;
            if (blend > 0)
            {
                if (audio.getNumChannels() == 1) audio.setSample(0, i, left * (1-blend) + (wet[0]+wet[1]) * .5f * blend);
                else { audio.setSample(0, i, left * (1-blend) + wet[0] * blend); audio.setSample(1, i, right * (1-blend) + wet[1] * blend); }
            }
        }
    }
private:
    double sr = 44100;
    int size = 1, position = 0, history = 0;
    float phase = 0;
    std::array<std::vector<float>, 2> lines;
    juce::SmoothedValue<float> mix, speed, excursion;
};
