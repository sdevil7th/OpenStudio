#pragma once

#include <array>
#include <algorithm>
#include <cmath>
#include <cstddef>

// Original linear secondary string/body network, not a physical hammer solver.
// Unit complex rotations and pairwise orthogonal coupling cannot add energy;
// all unforced losses are diagonal contractions. Each MIDI channel owns history.
class BuiltInCoupledBody
{
public:
    static constexpr size_t maximumModes = 96, bodyModes = 8;
    void prepare(double sampleRate, bool pianoModel) noexcept
    {
        rate = std::max(8000.0, sampleRate); piano = pianoModel;
        stringCount = piano ? 88u : 24u; modeCount = stringCount + bodyModes;
        constexpr std::array<int, 6> openStrings {40,45,50,55,59,64};
        constexpr std::array<double, bodyModes> pianoBody {83,127,193,271,389,563,809,1171};
        constexpr std::array<double, bodyModes> guitarBody {97,151,223,337,487,701,1019,1453};
        for (size_t i = 0; i < modeCount; ++i)
        {
            double frequency;
            if (i < stringCount)
                frequency = piano ? 440.0 * std::exp2((static_cast<double>(i) + 21 - 69) / 12)
                    : 440.0 * std::exp2((openStrings[i / 4] - 69) / 12.0) * static_cast<double>(1 + i % 4);
            else frequency = (piano ? pianoBody : guitarBody)[i - stringCount];
            const double angle = 6.283185307179586 * std::min(frequency, rate * .45) / rate;
            cosine[i] = std::cos(angle); sine[i] = std::sin(angle);
        }
        closedPole = std::exp(-6.907755278982137 / (.06 * rate));
        configure(.35f, 2); reset();
    }
    void configure(float coupling, float decay) noexcept
    {
        const double angle = std::clamp(static_cast<double>(coupling), 0.0, 1.0) * 90.0 / rate;
        couplingCos = std::cos(angle); couplingSin = std::sin(angle);
        openPole = std::exp(-6.907755278982137 / (std::clamp(static_cast<double>(decay), .2, 8.0) * rate));
        drive = std::sqrt(1 - openPole * openPole) * .12;
    }
    void reset() noexcept { for (size_t ch = 0; ch < channels.size(); ++ch) resetChannel(ch); }
    void resetChannel(size_t ch) noexcept { channels[ch] = {}; }
    void setOpenKeys(size_t ch, const std::array<bool, 128>& keys) noexcept
    {
        if (piano) for (size_t i = 0; i < stringCount; ++i) channels[ch].open[i] = keys[i + 21];
    }
    float process(size_t ch, float input, float pedal = 1) noexcept
    {
        auto& state = channels[ch];
        if (input != 0) state.awake = true;
        if (!state.awake) return 0;
        const double damped = closedPole + (openPole - closedPole) * std::clamp(static_cast<double>(pedal), 0.0, 1.0);
        for (size_t i = 0; i < modeCount; ++i)
        {
            const double pole = piano && i < stringCount && !state.open[i] ? damped : openPole;
            const double real = (state.real[i] * cosine[i] - state.imag[i] * sine[i]) * pole;
            state.imag[i] = (state.real[i] * sine[i] + state.imag[i] * cosine[i]) * pole;
            state.real[i] = real;
        }
        for (size_t i = 0; i < stringCount; ++i)
        {
            const size_t b = stringCount + i % bodyModes;
            const double real = couplingCos * state.real[i] - couplingSin * state.real[b];
            state.real[b] = couplingSin * state.real[i] + couplingCos * state.real[b]; state.real[i] = real;
            const double imag = couplingCos * state.imag[i] - couplingSin * state.imag[b];
            state.imag[b] = couplingSin * state.imag[i] + couplingCos * state.imag[b]; state.imag[i] = imag;
        }
        double output = 0;
        for (size_t i = 0; i < bodyModes; ++i)
        {
            const double sign = i % 2 == 0 ? 1.0 : -1.0;
            state.real[stringCount + i] += static_cast<double>(input) * drive * sign;
            output += state.real[stringCount + i] * sign;
        }
        if (++state.frames % 256 == 0 && input == 0 && energy(ch) < 1e-20)
        { state.real.fill(0); state.imag.fill(0); state.awake = false; }
        return static_cast<float>(output * .3535533905932738);
    }
    double energy(size_t ch) const noexcept
    {
        double sum = 0; const auto& state = channels[ch];
        for (size_t i = 0; i < modeCount; ++i) sum += state.real[i] * state.real[i] + state.imag[i] * state.imag[i];
        return sum;
    }
    double stringEnergy(size_t ch) const noexcept
    {
        double sum = 0; const auto& state = channels[ch];
        for (size_t i = 0; i < stringCount; ++i) sum += state.real[i] * state.real[i] + state.imag[i] * state.imag[i];
        return sum;
    }
private:
    struct Channel
    {
        std::array<double, maximumModes> real {}, imag {};
        std::array<bool, 88> open {};
        unsigned frames = 0; bool awake = false;
    };
    std::array<Channel, 16> channels {};
    std::array<double, maximumModes> cosine {}, sine {};
    double rate = 44100, openPole = .999, closedPole = .99, couplingCos = 1, couplingSin = 0, drive = 0;
    size_t stringCount = 88, modeCount = 96; bool piano = true;
};
