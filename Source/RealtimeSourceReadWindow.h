#pragma once
#include <JuceHeader.h>
#include <atomic>

// Amortize tiny callbacks' buffered-reader locking without delaying playback.
// Construct on the control thread before publishing the associated reader.
class RealtimeSourceReadWindow final
{
public:
    struct Counters {
        std::atomic<juce::uint64> hits { 0 }, reads { 0 }, fallbacks { 0 };
    };
    static constexpr int capacity = 512;
    explicit RealtimeSourceReadWindow(int channels, Counters* aggregate = nullptr)
        : samples(channels, capacity), counters(aggregate != nullptr ? aggregate : &ownCounters) {}

    bool read(juce::AudioFormatReader& reader, juce::AudioBuffer<float>& destination,
              int count, juce::int64 start)
    {
        const int channels = static_cast<int>(reader.numChannels);
        if (count > 0 && count <= capacity && start >= 0
            && channels == samples.getNumChannels()
            && destination.getNumChannels() >= channels)
        {
            if (start >= cachedStart && cachedSamples >= count
                && start - cachedStart <= cachedSamples - count)
            {
                counters->hits.fetch_add(1, std::memory_order_relaxed);
                copy(destination, channels, count, static_cast<int>(start - cachedStart));
                return true;
            }
            const int ahead = static_cast<int>(juce::jlimit<juce::int64>(0, capacity, reader.lengthInSamples - start));
            if (ahead >= count)
            {
                counters->reads.fetch_add(1, std::memory_order_relaxed);
                if (reader.read(&samples, 0, ahead, start, true, true))
                {
                    cachedStart = start; cachedSamples = ahead;
                    copy(destination, channels, count, 0);
                    return true;
                }
                cachedSamples = 0;
            }
        }
        // A missing lookahead frame must never conceal audible frames which
        // are already available. Preserve the exact original read contract.
        counters->fallbacks.fetch_add(1, std::memory_order_relaxed);
        return reader.read(&destination, 0, count, start, true, true);
    }

    juce::uint64 getHits() const { return counters->hits.load(std::memory_order_relaxed); }
    juce::uint64 getReads() const { return counters->reads.load(std::memory_order_relaxed); }
    juce::uint64 getFallbacks() const { return counters->fallbacks.load(std::memory_order_relaxed); }

private:
    void copy(juce::AudioBuffer<float>& destination, int channels, int count, int offset) const
    {
        for (int channel = 0; channel < channels; ++channel)
            destination.copyFrom(channel, 0, samples, channel, offset, count);
    }
    juce::AudioBuffer<float> samples;
    juce::int64 cachedStart = -1;
    int cachedSamples = 0;
    Counters ownCounters;
    Counters* counters;
};
