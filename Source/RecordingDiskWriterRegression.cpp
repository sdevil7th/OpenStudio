#include "RecordingDiskWriterRegression.h"
#include "RecordingDiskWriter.h"
#include "RecordingWriterSafety.h"
#include <vector>

struct RecordingDiskWriterRegressionAccess
{
    static int service(RecordingDiskWriter& writer) { return writer.useTimeSlice(); }
    static int pending(const RecordingDiskWriter& writer) { return writer.fifo.getNumReady(); }
};

namespace
{
struct ObservedPCM
{
    explicit ObservedPCM(int channels) : samples(static_cast<size_t>(channels)) {}
    std::vector<std::vector<float>> samples;
    int writeCalls = 0, flushCalls = 0, failWriteCall = 0;
    bool failFlush = false;
};

class ObservedWriter final : public juce::AudioFormatWriter
{
public:
    explicit ObservedWriter(std::shared_ptr<ObservedPCM> state)
        : AudioFormatWriter(nullptr, "FIFO regression PCM", 48000,
              static_cast<unsigned int>(state->samples.size()), 32), pcm(std::move(state))
    { usesFloatingPointData = true; }
    bool write(const int** channels, int samples) override
    {
        ++pcm->writeCalls;
        if (pcm->writeCalls == pcm->failWriteCall) return false;
        for (size_t channel = 0; channel < pcm->samples.size(); ++channel)
        {
            const auto* values = reinterpret_cast<const float*>(channels[channel]);
            pcm->samples[channel].insert(pcm->samples[channel].end(), values, values + samples);
        }
        return true;
    }
    bool flush() override { ++pcm->flushCalls; return !pcm->failFlush; }
private:
    std::shared_ptr<ObservedPCM> pcm;
};

float sampleValue(int channel, int sample)
{
    // Exactly representable, channel-distinct PCM, repeated far beyond FIFO wrap.
    return static_cast<float>((sample % 1024) + 1) / (channel == 0 ? 2048.0f : -4096.0f);
}

void fill(juce::AudioBuffer<float>& block, int firstSample)
{
    for (int channel = 0; channel < block.getNumChannels(); ++channel)
        for (int sample = 0; sample < block.getNumSamples(); ++sample)
            block.setSample(channel, sample, sampleValue(channel, firstSample + sample));
}

bool exact(const ObservedPCM& pcm, int samples)
{
    for (size_t channel = 0; channel < pcm.samples.size(); ++channel)
    {
        if (pcm.samples[channel].size() != static_cast<size_t>(samples)) return false;
        for (int sample = 0; sample < samples; ++sample)
            if (pcm.samples[channel][static_cast<size_t>(sample)]
                != sampleValue(static_cast<int>(channel), sample)) return false;
    }
    return true;
}

void drain(RecordingDiskWriter& writer)
{
    while (RecordingDiskWriterRegressionAccess::pending(writer) > 0)
        RecordingDiskWriterRegressionAccess::service(writer);
}
}

void runRecordingDiskWriterRegression(const std::function<void(const char*, bool)>& check)
{
    // Stopped worker permits deterministic interleavings without timing claims.
    juce::TimeSliceThread idleThread("RecordingFIFO-Deterministic");
    for (const int channels : { 1, 2 })
    {
        auto pcm = std::make_shared<ObservedPCM>(channels);
        bool accepted = true;
        {
            RecordingDiskWriter writer(std::make_unique<ObservedWriter>(pcm), idleThread, 65536, 240000);
            juce::AudioBuffer<float> block(channels, 8);
            accepted &= idleThread.getNumClients() == 1;
            for (int sample = 0; sample < 128; sample += 8)
            {
                fill(block, sample);
                accepted &= writer.write(block.getArrayOfReadPointers(), 8);
            }
        }
        check(channels == 1 ? "recording_fifo_eight_frame_mono_exact" : "recording_fifo_eight_frame_stereo_exact",
              accepted && exact(*pcm, 128) && idleThread.getNumClients() == 0 && pcm->flushCalls > 0);
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(2);
        bool invariant = true;
        {
            RecordingDiskWriter writer(std::make_unique<ObservedWriter>(pcm), idleThread, 33, 0);
            juce::AudioBuffer<float> block(2, 8);
            for (int sample = 0; sample < 24; sample += 8)
            { fill(block, sample); invariant &= writer.write(block.getArrayOfReadPointers(), 8); }
            RecordingDiskWriterRegressionAccess::service(writer); // Free exactly eight frames.
            for (int sample = 24; sample < 40; sample += 8)
            { fill(block, sample); invariant &= writer.write(block.getArrayOfReadPointers(), 8); }
            invariant &= RecordingDiskWriterRegressionAccess::pending(writer) == 32;
            fill(block, 40);
            invariant &= !writer.write(block.getArrayOfReadPointers(), 8)
                && RecordingDiskWriterRegressionAccess::pending(writer) == 32;
            drain(writer);
        }
        check("recording_fifo_wrap_and_full_reject_whole_block", invariant && exact(*pcm, 40));
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(2);
        bool invariant = true;
        {
            RecordingDiskWriter writer(std::make_unique<ObservedWriter>(pcm), idleThread, 65536, 240000);
            juce::AudioBuffer<float> block(2, 8);
            for (int sample = 0; sample < 65528; sample += 8)
            { fill(block, sample); invariant &= writer.write(block.getArrayOfReadPointers(), 8); }
            invariant &= pcm->writeCalls == 0 && RecordingDiskWriterRegressionAccess::pending(writer) == 65528;
            invariant &= !writer.write(block.getArrayOfReadPointers(), 8);
            drain(writer);
        }
        check("recording_fifo_delayed_consumer_preserves_all_accepted_frames", invariant && exact(*pcm, 65528));
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(2);
        bool accepted = true;
        {
            RecordingDiskWriter writer(std::make_unique<ObservedWriter>(pcm), idleThread, 33, 0);
            juce::AudioBuffer<float> block(2, 8);
            fill(block, 0); accepted &= writer.write(block.getArrayOfReadPointers(), 8);
            RecordingDiskWriterRegressionAccess::service(writer);
            fill(block, 8); accepted &= writer.write(block.getArrayOfReadPointers(), 8);
            fill(block, 16); accepted &= writer.write(block.getArrayOfReadPointers(), 3);
            // Destruction must drain both a complete callback and the exact tail.
        }
        check("recording_fifo_stop_drains_exact_partial_tail", accepted && exact(*pcm, 19));
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(1);
        pcm->failWriteCall = 2;
        auto status = std::make_shared<RecordingWriteStatus>();
        juce::MemoryOutputStream checkedStream;
        bool accepted = true;
        {
            auto checked = std::make_unique<CheckedRecordingWriter>(std::make_unique<ObservedWriter>(pcm), status, &checkedStream);
            RecordingDiskWriter writer(std::move(checked), idleThread, 33, 0);
            juce::AudioBuffer<float> block(1, 8);
            for (int sample = 0; sample < 24; sample += 8)
            { fill(block, sample); accepted &= writer.write(block.getArrayOfReadPointers(), 8); }
        }
        check("recording_fifo_failure_reports_only_acknowledged_frames", accepted && exact(*pcm, 8)
            && status->writtenSamples.load() == 8 && status->finished.load()
            && status->fault.load() == RecordingWriteStatus::writeFailed);
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(1);
        auto status = std::make_shared<RecordingWriteStatus>();
        juce::MemoryOutputStream checkedStream;
        bool invariant = true;
        {
            auto checked = std::make_unique<CheckedRecordingWriter>(std::make_unique<ObservedWriter>(pcm), status, &checkedStream);
            RecordingDiskWriter writer(std::move(checked), idleThread, 33, 16);
            juce::AudioBuffer<float> block(1, 8);
            fill(block, 0); invariant &= writer.write(block.getArrayOfReadPointers(), 8);
            invariant &= RecordingDiskWriterRegressionAccess::service(writer) == 5 && pcm->flushCalls == 0;
            fill(block, 8); invariant &= writer.write(block.getArrayOfReadPointers(), 8);
            pcm->failFlush = true;
            RecordingDiskWriterRegressionAccess::service(writer);
            invariant &= pcm->flushCalls == 1 && status->fault.load() == RecordingWriteStatus::flushFailed;
        }
        check("recording_fifo_periodic_flush_failure_and_empty_poll", invariant && exact(*pcm, 16)
            && status->writtenSamples.load() == 16 && status->finished.load());
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(2);
        juce::TimeSliceThread worker("RecordingFIFO-Publication");
        bool accepted = worker.startThread(juce::Thread::Priority::normal);
        {
            RecordingDiskWriter writer(std::make_unique<ObservedWriter>(pcm), worker, 65536, 240000);
            juce::AudioBuffer<float> block(2, 8);
            for (int sample = 0; sample < 40000; sample += 8)
            { fill(block, sample); accepted &= writer.write(block.getArrayOfReadPointers(), 8); }
        }
        worker.stopThread(-1);
        check("recording_fifo_concurrent_worker_publication_exact", accepted && exact(*pcm, 40000)
            && worker.getNumClients() == 0);
    }
    {
        auto pcm = std::make_shared<ObservedPCM>(1);
        bool invariant = true;
        {
            RecordingDiskWriter writer(std::make_unique<ObservedWriter>(pcm), idleThread, 33, 48000 * 5);
            juce::AudioBuffer<float> block(1, 8);
            for (int sample = 0; sample < 48000 * 5; sample += 8)
            {
                fill(block, sample);
                invariant &= writer.write(block.getArrayOfReadPointers(), 8);
                RecordingDiskWriterRegressionAccess::service(writer);
                invariant &= pcm->flushCalls == (sample == 48000 * 5 - 8 ? 1 : 0);
            }
        }
        check("recording_fifo_five_second_flush_at_48000", invariant && exact(*pcm, 48000 * 5));
    }
}
