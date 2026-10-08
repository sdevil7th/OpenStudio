#pragma once
#include <JuceHeader.h>
#include "BuiltInReverbSpillover.h"
#include <array>
#include <vector>

// Three original networks with irregular delay motion and nonlinear feedback.
// They are not reconstructions of a proprietary reverb or tape circuit.
class BuiltInDriftingReverb final
{
public:
    struct Settings
    {
        float decay = 2, size = .5f, damping = .5f, diffusion = .5f;
        float preDelay = 0, lowCut = 20, highCut = 20000, width = 1;
        float drive = 6, wow = .2f, flutter = .1f, rate = .3f, emphasis = .5f;
        float bassRatio = 1, bassFrequency = 500;
        bool hold = false, holdInput = false;
    };
private:
    struct Delay
    {
        std::vector<float> data;
        int position = 0, valid = 0;
        void prepare(int length) { data.assign(static_cast<size_t>(length + 4), 0.0f); reset(); }
        void reset() noexcept { position = valid = 0; }
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
            data[static_cast<size_t>(position)] = std::isfinite(value) ? juce::jlimit(-8.0f, 8.0f, value) : 0;
            valid = juce::jmin(valid + 1, static_cast<int>(data.size()));
            if (++position == static_cast<int>(data.size())) position = 0;
        }
        float allpass(float input, float length, float coefficient) noexcept
        {
            const float delayed = read(length), output = delayed - coefficient * input;
            write(input + coefficient * output); return output;
        }
    };
    struct Line
    {
        Delay delay;
        juce::SmoothedValue<float> length, loss, bassLoss;
        float base = 0, dampingState = 0, bassState = 0, preState = 0, postState = 0;
        double phase = 0, flutterPhase = 0;
        float randomFrom = 0, randomTo = 0;
        juce::uint32 seed = 1;
        float random() noexcept { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return static_cast<float>(seed & 0xffffffu) / 8388607.5f - 1; }
        void reset(int index) noexcept
        {
            delay.reset(); dampingState = bassState = preState = postState = 0;
            phase = static_cast<double>(index) / 17; flutterPhase = static_cast<double>(index) / 23;
            seed = 15731u + static_cast<juce::uint32>(index) * 789221u; randomFrom = random(); randomTo = random();
        }
    };
    struct Engine
    {
        std::array<Line, 16> lines;
        std::array<Delay, 2> predelay;
        std::array<std::array<Delay, 4>, 2> diffusers;
        std::array<float, 2> lowState {}, highState {};
        juce::SmoothedValue<float> drive, wow, flutter, motionRate, emphasis, dampingPole, bassPole, lowPole, highPole;
        juce::SmoothedValue<float> diffusion, preSamples, width, hold, excitation;
        Settings settings;
        int mode = 0, count = 16, diffuserCount = 4;
        double rate = 48000;
        float normalise = .25f, tapePole = 0;
        bool initialized = false;
        juce::int64 drain = 0;
        juce::uint64 frames = 0;
        void prepare(double sampleRate, int topology)
        {
            rate = sampleRate; mode = topology; count = mode == 1 ? 8 : 16; diffuserCount = mode == 1 ? 2 : mode == 2 ? 3 : 4;
            normalise = 1 / std::sqrt(static_cast<float>(count));
            tapePole = std::exp(-juce::MathConstants<float>::twoPi * 1800 / static_cast<float>(rate));
            constexpr std::array<float, 16> times { .0713f, .0839f, .0977f, .1091f, .1277f, .1399f, .1511f, .1679f,
                .0781f, .0913f, .1039f, .1193f, .1319f, .1471f, .1597f, .1811f };
            for (int i = 0; i < count; ++i)
            {
                auto& line = lines[static_cast<size_t>(i)];
                line.base = times[static_cast<size_t>(i)] * (mode == 1 ? .31f : mode == 2 ? .63f : 1.0f);
                line.delay.prepare(static_cast<int>(rate * (line.base * 1.5f + .01f)));
                for (auto* value : {&line.length, &line.loss, &line.bassLoss}) value->reset(rate, .1);
            }
            for (auto& line : predelay) line.prepare(static_cast<int>(rate * .501));
            for (auto& channel : diffusers) for (auto& line : channel) line.prepare(static_cast<int>(rate * .021));
            for (auto* value : {&drive, &wow, &flutter, &motionRate, &emphasis, &dampingPole, &bassPole, &lowPole, &highPole,
                &diffusion, &preSamples, &width, &hold, &excitation}) value->reset(rate, .05);
            reset(); frames = 0;
        }
        void reset() noexcept
        {
            for (int i = 0; i < count; ++i) lines[static_cast<size_t>(i)].reset(i);
            for (auto& line : predelay) line.reset();
            for (auto& channel : diffusers) for (auto& line : channel) line.reset();
            lowState.fill(0); highState.fill(0); initialized = false; drain = 0;
        }
        double tail() const noexcept { return juce::jmin(120.0, settings.decay * juce::jmax(1.0f, settings.bassRatio) * 2.0 + 2.0 + settings.preDelay * .001); }
        void configure(const Settings& next, bool active) noexcept
        {
            if (active) settings = next;
            const auto set = [this](auto& value, float target) { if (initialized) value.setTargetValue(target); else value.setCurrentAndTargetValue(target); };
            const float sampleRate = static_cast<float>(rate), scale = .5f + settings.size;
            for (int i = 0; i < count; ++i)
            {
                auto& line = lines[static_cast<size_t>(i)]; const float length = line.base * scale * sampleRate;
                set(line.length, length); set(line.loss, std::pow(.001f, length / (sampleRate * settings.decay)));
                set(line.bassLoss, std::pow(.001f, length / (sampleRate * settings.decay * settings.bassRatio)));
            }
            set(drive, juce::Decibels::decibelsToGain(settings.drive)); set(wow, settings.wow * sampleRate * .0015f);
            set(flutter, settings.flutter * sampleRate * .00012f); set(motionRate, settings.rate); set(emphasis, settings.emphasis * 2);
            const auto pole = [sampleRate](float frequency) { return std::exp(-juce::MathConstants<float>::twoPi * juce::jmin(frequency, sampleRate * .45f) / sampleRate); };
            set(dampingPole, pole(18000 * std::pow(1.0f / 36, settings.damping)));
            set(bassPole, pole(settings.bassFrequency)); set(lowPole, pole(settings.lowCut)); set(highPole, pole(settings.highCut));
            set(diffusion, settings.diffusion * .72f); set(preSamples, settings.preDelay * sampleRate * .001f + 1); set(width, settings.width);
            // Retiring holds decay using their saved settings, never freeze forever.
            set(hold, active && settings.hold ? 1.0f : 0.0f);
            set(excitation, active && (!settings.hold || settings.holdInput) ? 1.0f : 0.0f);
            initialized = true;
        }
        std::array<float, 2> process(float left, float right, bool active) noexcept
        {
            if (active) drain = static_cast<juce::int64>(rate * tail());
            else if (drain == 0) return {};
            else if (--drain == 0) { reset(); return {}; }
            ++frames;
            const float gain = drive.getNextValue(), slowDepth = wow.getNextValue(), fastDepth = flutter.getNextValue();
            const float speed = motionRate.getNextValue(), colour = emphasis.getNextValue(), damp = dampingPole.getNextValue(), bass = bassPole.getNextValue();
            const float diff = diffusion.getNextValue(), pre = preSamples.getNextValue(), held = hold.getNextValue(), feed = excitation.getNextValue();
            std::array<float, 2> input {active ? left * feed : 0, active ? right * feed : 0};
            for (size_t ch = 0; ch < 2; ++ch)
            {
                predelay[ch].write(input[ch]); input[ch] = predelay[ch].read(pre);
                for (int i = 0; i < diffuserCount; ++i)
                    input[ch] = diffusers[ch][static_cast<size_t>(i)].allpass(input[ch], static_cast<float>(rate) * (.0023f + .0031f * static_cast<float>(i) + .0007f * static_cast<float>(ch)), diff);
            }
            std::array<float, 16> feedback {};
            std::array<float, 2> output {};
            for (int i = 0; i < count; ++i)
            {
                const auto index = static_cast<size_t>(i); auto& line = lines[index];
                const float phase = static_cast<float>(line.phase), blend = phase * phase * (3 - 2 * phase);
                const float irregular = line.randomFrom + (line.randomTo - line.randomFrom) * blend;
                const float motion = slowDepth * irregular + fastDepth * static_cast<float>(std::sin(line.flutterPhase * juce::MathConstants<double>::twoPi));
                line.phase += speed * (1 + static_cast<float>(i) * .073f) / rate;
                line.flutterPhase += (3 + speed * 13) * (1 + static_cast<float>(i) * .037f) / rate;
                if (line.phase >= 1) { line.phase -= 1; line.randomFrom = line.randomTo; line.randomTo = line.random(); }
                if (line.flutterPhase >= 1) line.flutterPhase -= 1;
                const float raw = line.delay.read(line.length.getNextValue() + motion * (1 - held));
                line.dampingState = raw + damp * (line.dampingState - raw);
                const float filtered = raw * held + line.dampingState * (1 - held);
                line.bassState = filtered + bass * (line.bassState - filtered);
                const float highLoss = line.loss.getNextValue(), lowLoss = line.bassLoss.getNextValue();
                const float loss = highLoss * filtered + (lowLoss - highLoss) * line.bassState;
                const float decayed = loss * (1 - held) + filtered * held;
                // Matched one-pole emphasis/de-emphasis surrounds a bounded
                // saturation. Drive=0 is the exact linear feedback path.
                line.preState = decayed + tapePole * (line.preState - decayed);
                const float boosted = decayed + colour * (decayed - line.preState);
                const float saturated = gain <= 1.000001f ? boosted : std::tanh(boosted * gain) / gain;
                const float restored = (saturated + colour * tapePole * line.postState) / (1 + colour * tapePole);
                line.postState = restored + tapePole * (line.postState - restored);
                feedback[index] = held * filtered + (1 - held) * (gain <= 1.000001f ? decayed : restored);
                output[0] += raw * ((i & 1) == 0 ? normalise : -normalise);
                output[1] += raw * ((i & 2) == 0 ? normalise : -normalise);
            }
            if (mode == 2)
            {
                float sum = 0; for (int i = 0; i < count; ++i) sum += feedback[static_cast<size_t>(i)];
                for (int i = 0; i < count; ++i) feedback[static_cast<size_t>(i)] -= sum * (2.0f / static_cast<float>(count));
            }
            else
            {
                for (int span = 1; span < count; span *= 2)
                    for (int start = 0; start < count; start += span * 2)
                        for (int i = 0; i < span; ++i)
                        {
                            const auto a = static_cast<size_t>(start + i), b = static_cast<size_t>(start + i + span);
                            const float x = feedback[a], y = feedback[b]; feedback[a] = x + y; feedback[b] = x - y;
                        }
                for (int i = 0; i < count; ++i) feedback[static_cast<size_t>(i)] *= normalise;
            }
            for (int i = 0; i < count; ++i)
            {
                const float excitationValue = (input[0] + ((i & 1) == 0 ? input[1] : -input[1])) * normalise * .25f;
                lines[static_cast<size_t>(i)].delay.write(feedback[static_cast<size_t>(i)] + excitationValue);
            }
            const float low = lowPole.getNextValue(), high = highPole.getNextValue();
            for (size_t ch = 0; ch < 2; ++ch)
            {
                lowState[ch] = output[ch] + low * (lowState[ch] - output[ch]);
                const float value = output[ch] - lowState[ch]; highState[ch] = value + high * (highState[ch] - value); output[ch] = highState[ch];
            }
            const float mid = (output[0] + output[1]) * .5f, side = (output[0] - output[1]) * .5f * width.getNextValue();
            return {mid + side, mid - side};
        }
    };
    std::array<Engine, 3> engines;
    std::array<juce::SmoothedValue<float>, 3> weights;
    BuiltInReverbSpillover<3> spillWeights;
    bool prepared = false;
public:
    void prepare(double rate, int selected)
    {
        for (size_t i = 0; i < engines.size(); ++i)
        {
            engines[i].prepare(rate, static_cast<int>(i)); weights[i].reset(rate, .05);
            weights[i].setCurrentAndTargetValue(selected == static_cast<int>(i) ? 1.0f : 0.0f);
        }
        spillWeights.prepare(rate, selected); prepared = true;
    }
    void reset() noexcept { for (auto& engine : engines) engine.reset(); spillWeights.reset(weights); }
    void configure(int selected, Settings settings, bool spillover) noexcept
    {
        const auto safe = [](float value, float low, float high, float fallback) { return std::isfinite(value) ? juce::jlimit(low, high, value) : fallback; };
        settings.decay = safe(settings.decay, .1f, 20, 2); settings.size = safe(settings.size, 0, 1, .5f);
        settings.damping = safe(settings.damping, 0, 1, .5f); settings.diffusion = safe(settings.diffusion, 0, 1, .5f);
        settings.preDelay = safe(settings.preDelay, 0, 500, 0); settings.lowCut = safe(settings.lowCut, 20, 500, 20);
        settings.highCut = safe(settings.highCut, 1000, 20000, 20000); settings.width = safe(settings.width, 0, 1, 1);
        settings.drive = safe(settings.drive, 0, 24, 6); settings.wow = safe(settings.wow, 0, 1, .2f);
        settings.flutter = safe(settings.flutter, 0, 1, .1f); settings.rate = safe(settings.rate, .05f, 2, .3f);
        settings.emphasis = safe(settings.emphasis, 0, 1, .5f); settings.bassRatio = safe(settings.bassRatio, .25f, 4, 1);
        settings.bassFrequency = safe(settings.bassFrequency, 100, 10000, 500);
        for (size_t i = 0; i < engines.size(); ++i)
        {
            const bool active = selected == static_cast<int>(i); weights[i].setTargetValue(active ? 1.0f : 0.0f);
            if (active || engines[i].drain > 0) engines[i].configure(settings, active);
            spillWeights.configure(i, active, spillover, engines[i].drain > 0);
        }
    }
    std::array<float, 3> process(float left, float right) noexcept
    {
        if (!prepared) return {};
        std::array<float, 3> output {};
        for (size_t i = 0; i < engines.size(); ++i)
        {
            const auto wet = engines[i].process(left, right, weights[i].getTargetValue() > 0);
            const float weight = weights[i].getNextValue(), wetWeight = spillWeights.next(i);
            output[0] += wet[0] * wetWeight; output[1] += wet[1] * wetWeight; output[2] += weight;
        }
        return output;
    }
    double retiringTailSeconds() const noexcept
    {
        double seconds = 0;
        for (size_t i = 0; i < engines.size(); ++i) if (spillWeights.audibleRetiring(i)) seconds = juce::jmax(seconds, static_cast<double>(engines[i].drain) / engines[i].rate);
        return seconds;
    }
    juce::uint64 processingFrames(size_t slot) const noexcept { return engines[slot].frames; }
};
