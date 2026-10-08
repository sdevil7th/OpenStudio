#pragma once

#if defined(_MSC_VER)
 #pragma warning(push)
 #pragma warning(disable: 4244 4267 4305 4456)
#endif
#include "signalsmith-stretch.h"
#if defined(_MSC_VER)
 #pragma warning(pop)
#endif

// Stereo spectral pitch voice for the standalone shimmer feedback loop.
// A fixed 64-sample streaming adapter makes results independent of host block
// boundaries. All FFT/storage preparation happens outside the audio callback.
// Its latency is internal to the reverb loop, not added to the dry signal.
class BuiltInReverbPitchVoice
{
public:
    void prepare(double sampleRate)
    {
        stretch.presetDefault(2, static_cast<float>(sampleRate));
        stretch.setTransposeFactor(1.0f);
        reset();
    }
    void reset()
    {
        stretch.reset();
        for (auto& channel : input) channel.fill(0);
        for (auto& channel : output) channel.fill(0);
        position = 0;
    }
    std::array<float, 2> process(float left, float right, float ratio)
    {
        const auto slot = static_cast<size_t>(position);
        const std::array<float, 2> result { output[0][slot], output[1][slot] };
        input[0][slot] = left; input[1][slot] = right;
        if (++position == chunkSize)
        {
            position = 0;
            stretch.setTransposeFactor(juce::jlimit(.25f, 4.0f, ratio));
            const float* in[] { input[0].data(), input[1].data() };
            float* out[] { output[0].data(), output[1].data() };
            stretch.process(in, chunkSize, out, chunkSize);
        }
        return result;
    }
private:
    static constexpr int chunkSize = 64;
    signalsmith::stretch::SignalsmithStretch<float> stretch { 0 };
    std::array<std::array<float, chunkSize>, 2> input {}, output {};
    int position = 0;
};
