#include "RealtimeSourceReadWindowRegression.h"
#include "RealtimeSourceReadWindow.h"
#include <cmath>

namespace {
class FixtureReader final : public juce::AudioFormatReader
{
public:
    FixtureReader(int channels, double rate) : AudioFormatReader(nullptr, "Read-window fixture")
    { numChannels = static_cast<unsigned int>(channels); sampleRate = rate; lengthInSamples = 10003; bitsPerSample = 32; usesFloatingPointData = true; }
    static float value(int channel, juce::int64 sample) { return static_cast<float>((sample % 127) - 63) / 128.0f * (channel == 0 ? 1.0f : -0.5f); }
    bool readSamples(int* const* destinations, int channels, int offset, juce::int64 start, int count) override
    {
        ++calls;
        if (count <= 32) ++shortReads;
        if (failAll || (onlyShortReads && count > 32)) return false;
        for (int channel = 0; channel < channels; ++channel)
            if (destinations[channel] != nullptr)
                for (int index = 0; index < count; ++index)
                    reinterpret_cast<float*>(destinations[channel])[offset + index] = value(channel, start + index);
        return true;
    }
    int calls = 0, shortReads = 0;
    bool onlyShortReads = false, failAll = false;
};
bool matches(const juce::AudioBuffer<float>& data, int count, juce::int64 start)
{
    for (int channel = 0; channel < data.getNumChannels(); ++channel)
        for (int index = 0; index < count; ++index)
            if (data.getSample(channel, index) != FixtureReader::value(channel, start + index)) return false;
    return true;
}
}

void runRealtimeSourceReadWindowRegression(const std::function<void(const char*, bool)>& check)
{
    bool exact = true, bounded = true;
    for (const int channels : { 1, 2 }) for (const double rate : { 44100.0, 48000.0 })
    {
        FixtureReader reader(channels, rate);
        RealtimeSourceReadWindow window(channels);
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
        RealtimeSourceReadWindow::Counters counts;
        window.collectInto(counts);
#endif
        juce::AudioBuffer<float> block(channels, 1024);
        for (int position = 0; position < 9600; position += 8)
            exact &= window.read(reader, block, 12, position) && matches(block, 12, position);
        // Count at the fixture reader: ordinary builds incur no bookkeeping.
        bounded &= reader.calls > 0 && reader.calls < 25 && reader.shortReads == 0;
#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
        bounded &= counts.hits.load() == static_cast<juce::uint64>(1200 - reader.calls)
            && counts.reads.load() == static_cast<juce::uint64>(reader.calls) && counts.fallbacks.load() == 0;
#endif
        for (const auto position : { 8300, 2, 701, 9900, 10001, 17 })
        {
            const int count = juce::jmin(12, static_cast<int>(reader.lengthInSamples) - position);
            exact &= window.read(reader, block, count, position) && matches(block, count, position);
        }
        exact &= window.read(reader, block, 1024, 1024) && matches(block, 1024, 1024);
    }
    check("stream_window_bit_exact_channel_rate_seek_eof_and_large_blocks", exact);
    check("stream_window_amortizes_eight_frame_reader_acquisitions", bounded);
    FixtureReader shortReader(2, 48000); shortReader.onlyShortReads = true;
    RealtimeSourceReadWindow shortWindow(2); juce::AudioBuffer<float> block(2, 32);
    check("stream_window_missing_lookahead_retains_ready_audible_frames",
        shortWindow.read(shortReader, block, 12, 113) && matches(block, 12, 113)
        && shortReader.calls == 2 && shortReader.shortReads == 1);
    shortReader.failAll = true;
    check("stream_window_preserves_real_read_failure", !shortWindow.read(shortReader, block, 12, 777));
    FixtureReader replacement(2, 48000);
    RealtimeSourceReadWindow replacementWindow(2);
    check("stream_window_replacement_starts_with_empty_identity_cache",
        replacementWindow.read(replacement, block, 12, 99) && matches(block, 12, 99)
        && replacement.calls == 1 && replacement.shortReads == 0);
}
