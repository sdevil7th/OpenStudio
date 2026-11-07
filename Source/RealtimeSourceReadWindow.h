#pragma once
#include "RealtimeDiagnosticsConfig.h"
#include <JuceHeader.h>
#include <atomic>

// Amortize tiny callbacks' buffered-reader locking without delaying playback.
// Construct on the control thread before publishing the associated reader.
class RealtimeSourceReadWindow final
{
public:
    static constexpr int capacity = 512;
    explicit RealtimeSourceReadWindow(int channels) : samples(channels, capacity) {}
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
    struct Counters {
        std::atomic<juce::uint64> hits { 0 }, reads { 0 }, fallbacks { 0 };
    };
    void collectInto(Counters& aggregate) { counters = &aggregate; } // Before reader publication.
#endif

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
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
                counters->hits.fetch_add(1, std::memory_order_relaxed);
#endif
                copy(destination, channels, count, static_cast<int>(start - cachedStart));
                return true;
            }
            const int ahead = static_cast<int>(juce::jlimit<juce::int64>(0, capacity, reader.lengthInSamples - start));
            if (ahead >= count)
            {
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
                counters->reads.fetch_add(1, std::memory_order_relaxed);
#endif
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
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
        counters->fallbacks.fetch_add(1, std::memory_order_relaxed);
#endif
        return reader.read(&destination, 0, count, start, true, true);
    }

private:
    void copy(juce::AudioBuffer<float>& destination, int channels, int count, int offset) const
    {
        for (int channel = 0; channel < channels; ++channel)
            destination.copyFrom(channel, 0, samples, channel, offset, count);
    }
    juce::AudioBuffer<float> samples;
    juce::int64 cachedStart = -1;
    int cachedSamples = 0;
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
    Counters ownCounters;
    Counters* counters = &ownCounters;
#endif
};
