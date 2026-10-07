#pragma once
#include <JuceHeader.h>

// Prepared storage for a detector-only source crossfade. The main audio path
// never contains the auxiliary input; absent/disconnected keys are silence.
class BuiltInExternalKey
{
public:
    void prepare(double rate, int blockSize, bool external)
    {
        audio.setSize(6, juce::jmax(1, blockSize));
        blend.reset(rate, .01);
        reset(external);
    }
    void reset(bool external) noexcept
    {
        audio.clear();
        blend.setCurrentAndTargetValue(external ? 1.0f : 0.0f);
        validSamples = 0;
    }
    void capture(const juce::AudioBuffer<float>& source, int mainChannels,
                 int keyChannels, bool external) noexcept
    {
        blend.setTargetValue(external ? 1.0f : 0.0f);
        validSamples = juce::jmin(source.getNumSamples(), audio.getNumSamples());
        const int availableMain = juce::jmin(mainChannels, source.getNumChannels());
        const int availableKey = juce::jlimit(0, keyChannels, source.getNumChannels() - availableMain);
        for (int sample = 0; sample < validSamples; ++sample)
        {
            const float wet = blend.getNextValue();
            for (int channel = 0; channel < 2; ++channel)
            {
                const float input = availableMain > 0 ? source.getSample(juce::jmin(channel, availableMain - 1), sample) : 0.0f;
                const float key = availableKey > 0 ? source.getSample(mainChannels + juce::jmin(channel, availableKey - 1), sample) : 0.0f;
                const float safeKey = std::isfinite(key) ? key : 0.0f;
                audio.setSample(channel + 2, sample, input);
                audio.setSample(channel + 4, sample, safeKey);
                audio.setSample(channel, sample, wet <= 0 ? input : wet >= 1 ? safeKey : input + (safeKey - input) * wet);
            }
        }
    }
    float sample(int channel, int index) const noexcept
    {
        return index < validSamples ? audio.getSample(juce::jlimit(0, 1, channel), index) : 0.0f;
    }
    float rawSample(bool external, int channel, int index) const noexcept
    {
        return index < validSamples ? audio.getSample((external ? 4 : 2) + juce::jlimit(0, 1, channel), index) : 0.0f;
    }
private:
    juce::AudioBuffer<float> audio;
    juce::SmoothedValue<float> blend;
    int validSamples = 0;
};
