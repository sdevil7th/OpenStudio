#include "RecordingDiskWriter.h"

RecordingDiskWriter::RecordingDiskWriter(std::unique_ptr<juce::AudioFormatWriter> destination,
                                         juce::TimeSliceThread& thread,
                                         int fifoSamples,
                                         int flushInterval)
    : fifo(fifoSamples),
      buffer(static_cast<int>(destination->getNumChannels()), fifoSamples),
      backgroundThread(thread), writer(std::move(destination)),
      flushIntervalSamples(juce::jmax(0, flushInterval))
{
    jassert(fifoSamples >= 2);
    buffer.clear();
    backgroundThread.addTimeSliceClient(this); // Control thread only.
}

RecordingDiskWriter::~RecordingDiskWriter()
{
    // removeTimeSliceClient waits for an in-flight consumer to finish. The
    // recorder has already unpublished the producer under its writer lock.
    backgroundThread.removeTimeSliceClient(this);
    while (drainOneBatch()) {}
    writer->flush();
}

bool RecordingDiskWriter::write(const float* const* channels, int numSamples) noexcept
{
    if (numSamples <= 0) return true;
    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo.prepareToWrite(numSamples, start1, size1, start2, size2);
    if (size1 + size2 < numSamples) return false; // Reject the whole block.
    for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
    {
        buffer.copyFrom(channel, start1, channels[channel], size1);
        if (size2 > 0)
            buffer.copyFrom(channel, start2, channels[channel] + size1, size2);
    }
    fifo.finishedWrite(numSamples);
    return true;
}

int RecordingDiskWriter::useTimeSlice()
{
    drainOneBatch();
    // Polling only changes when PCM reaches disk; input monitoring and preview
    // publication do not wait for this consumer. No audio-thread notification.
    return fifo.getNumReady() > 0 ? 0 : emptyPollMilliseconds;
}

bool RecordingDiskWriter::drainOneBatch()
{
    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo.prepareToRead(juce::jmax(1, fifo.getTotalSize() / 4), start1, size1, start2, size2);
    if (size1 + size2 == 0) return false;

    // CheckedRecordingWriter records background failures and acknowledged PCM.
    // Retire attempted ranges even after a disk fault, so stop always terminates.
    if (size1 > 0) writer->writeFromAudioSampleBuffer(buffer, start1, size1);
    if (size2 > 0) writer->writeFromAudioSampleBuffer(buffer, start2, size2);
    fifo.finishedRead(size1 + size2);
    samplesSinceFlush += size1 + size2;
    if (flushIntervalSamples > 0 && samplesSinceFlush >= flushIntervalSamples)
    {
        samplesSinceFlush %= flushIntervalSamples;
        writer->flush();
    }
    return true;
}
