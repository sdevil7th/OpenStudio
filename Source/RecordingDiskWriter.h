#pragma once

#include <JuceHeader.h>
#include <memory>

// One audio producer, one disk consumer. Storage and client registration are
// prepared on the control thread; write() never wakes or locks the disk thread.
// The producer must be unpublished before control-thread destruction begins.
class RecordingDiskWriter final : private juce::TimeSliceClient
{
public:
    RecordingDiskWriter(std::unique_ptr<juce::AudioFormatWriter> destination,
                        juce::TimeSliceThread& thread,
                        int fifoSamples,
                        int flushInterval);
    ~RecordingDiskWriter() override;

    bool write(const float* const* channels, int numSamples) noexcept;

private:
    int useTimeSlice() override;
    bool drainOneBatch(); // Disk thread, or control thread after client removal.

    juce::AbstractFifo fifo;
    juce::AudioBuffer<float> buffer;
    juce::TimeSliceThread& backgroundThread;
    std::unique_ptr<juce::AudioFormatWriter> writer;
    const int flushIntervalSamples;
    juce::int64 samplesSinceFlush = 0;
    static constexpr int emptyPollMilliseconds = 5;

    friend struct RecordingDiskWriterRegressionAccess;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RecordingDiskWriter)
};
