#pragma once

#include <JuceHeader.h>
#include <array>
#include <cmath>
#include <cstdint>

// The final integer PCM stage. All arithmetic is in destination LSBs; the
// writer receives left-aligned integers and must not quantize floating input again.
class ExportQuantizer
{
public:
    // Stable IDs: off, TPDF, first-order shaping, RPDF, second-order shaping.
    explicit ExportQuantizer(int bits, int mode, std::uint64_t seed = 0x7e57d17e5319ULL)
        : bitCount(juce::jlimit(16, 24, bits)), selectedMode(mode)
    {
        for (size_t ch = 0; ch < states.size(); ++ch)
            states[ch].random = seed ^ (ch == 0 ? 0x243f6a8885a308d3ULL : 0x13198a2e03707344ULL);
    }

    int process(double input, int channel) noexcept
    {
        auto& state = states[static_cast<size_t>(juce::jlimit(0, 1, channel))];
        const double scale = static_cast<double>(std::uint64_t{1} << (bitCount - 1));
        if (!std::isfinite(input)) { state.first = state.second = 0.0; input = 0.0; }
        const double correction = selectedMode == 2 ? -state.first
            : selectedMode == 4 ? -2.0 * state.first + state.second : 0.0;
        const double unquantized = juce::jlimit(-2.0, 2.0, input) * scale + correction;
        double noise = 0.0;
        if (selectedMode != 0)
        {
            const double firstDraw = uniform(state);
            noise = selectedMode == 3 ? firstDraw - 0.5 : firstDraw - uniform(state);
        }
        const double rounded = std::round(unquantized + noise);
        const double quantized = juce::jlimit(-scale, scale - 1.0, rounded);
        state.second = state.first;
        state.first = quantized - unquantized;
        if (quantized != rounded) state.first = state.second = 0.0;
        // Multiplication avoids undefined behaviour from left-shifting negatives.
        return static_cast<int>(static_cast<std::int64_t>(quantized)
            * (std::int64_t{1} << (32 - bitCount)));
    }

    bool write(juce::AudioFormatWriter& writer, const juce::AudioBuffer<float>& audio,
               int offset, int count)
    {
        if (writer.isFloatingPoint() || audio.getNumChannels() > 2) return false;
        while (count > 0)
        {
            const int length = juce::jmin(count, blockSize);
            for (int ch = 0; ch < audio.getNumChannels(); ++ch)
                for (int i = 0; i < length; ++i)
                    pcm[static_cast<size_t>(ch)][static_cast<size_t>(i)] = process(audio.getSample(ch, offset + i), ch);
            const int* pointers[] = { pcm[0].data(), audio.getNumChannels() > 1 ? pcm[1].data() : nullptr, nullptr };
            if (!writer.write(pointers, length)) return false;
            offset += length; count -= length;
        }
        return true;
    }

private:
    struct State { std::uint64_t random = 1; double first = 0.0, second = 0.0; };
    static double uniform(State& state) noexcept
    {
        // SplitMix64, independent channel streams; host block size cannot alter the sequence.
        auto value = (state.random += 0x9e3779b97f4a7c15ULL);
        value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
        value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
        value ^= value >> 31;
        return static_cast<double>(value >> 11) * 0x1.0p-53;
    }
    static constexpr int blockSize = 4096;
    int bitCount, selectedMode;
    std::array<State, 2> states;
    std::array<std::array<int, blockSize>, 2> pcm {};
};
