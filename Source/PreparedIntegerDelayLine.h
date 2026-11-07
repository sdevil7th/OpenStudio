#pragma once
#include <JuceHeader.h>
#include <array>
#include <cmath>

// Prepared PDC history with conditional cursor wrapping. PDC requests integral
// delays; retain JUCE Linear's arithmetic and peek/advance API so the existing
// transition law and warm history remain bit-identical to the reference.
class PreparedIntegerDelayLine final
{
public:
    explicit PreparedIntegerDelayLine(int maximumDelay = 96000)
        : totalSize(juce::jmax(4, maximumDelay + 2)) {}

    void prepare(const juce::dsp::ProcessSpec& spec)
    {
        jassert(spec.numChannels > 0 && spec.numChannels <= 2);
        samples.setSize(static_cast<int>(spec.numChannels), totalSize, false, false, true);
        reset();
    }
    void reset()
    {
        writePosition.fill(0); readPosition.fill(0); samples.clear();
    }
    int getMaximumDelayInSamples() const noexcept { return totalSize - 2; }
    void setDelay(float requested) noexcept
    {
        delay = juce::jlimit(0.0f, static_cast<float>(getMaximumDelayInSamples()), requested);
        delayInteger = static_cast<int>(std::floor(delay));
        delayFraction = delay - static_cast<float>(delayInteger);
    }
    float getDelay() const noexcept { return delay; }
    // Stable taps can process a whole channel with one buffer lookup. Keep
    // writing zero-delay history and the exact Linear arithmetic: a later
    // compensation change must see the same warm history as sample processing.
    void processChannel(int channel, float* audio, int count) noexcept
    {
        jassert(channel >= 0 && channel < samples.getNumChannels() && count >= 0);
        auto* const history = samples.getWritePointer(channel);
        const auto index = static_cast<size_t>(channel);
        int write = writePosition[index], read = readPosition[index];
        for (int sample = 0; sample < count; ++sample)
        {
            history[write] = audio[sample];
            write = decrement(write);
            int first = read + delayInteger, second = first + 1;
            if (second >= totalSize)
            {
                if (first >= totalSize) first -= totalSize;
                second -= totalSize;
            }
            const float firstValue = history[first], secondValue = history[second];
            audio[sample] = firstValue + delayFraction * (secondValue - firstValue);
            read = decrement(read);
        }
        writePosition[index] = write;
        readPosition[index] = read;
    }
    void pushSample(int channel, float sample) noexcept
    {
        const auto index = static_cast<size_t>(channel);
        samples.setSample(channel, writePosition[index], sample);
        writePosition[index] = decrement(writePosition[index]);
    }
    float popSample(int channel, float requestedDelay = -1.0f, bool advance = true) noexcept
    {
        if (requestedDelay >= 0.0f) setDelay(requestedDelay);
        const auto channelIndex = static_cast<size_t>(channel);
        int first = readPosition[channelIndex] + delayInteger;
        int second = first + 1;
        if (second >= totalSize)
        {
            if (first >= totalSize) first -= totalSize;
            second -= totalSize;
        }
        const float firstValue = samples.getSample(channel, first);
        const float secondValue = samples.getSample(channel, second);
        // Preserve signed-zero and overflow behaviour of JUCE Linear even
        // when delayFraction is zero; returning firstValue alone differs.
        const float result = firstValue + delayFraction * (secondValue - firstValue);
        if (advance) readPosition[channelIndex] = decrement(readPosition[channelIndex]);
        return result;
    }

private:
    int decrement(int position) const noexcept { return position == 0 ? totalSize - 1 : position - 1; }
    juce::AudioBuffer<float> samples;
    std::array<int, 2> writePosition {}, readPosition {};
    int totalSize = 4, delayInteger = 0;
    float delay = 0.0f, delayFraction = 0.0f;
};
