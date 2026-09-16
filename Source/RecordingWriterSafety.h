#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <memory>
#include "RecoveryJournal.h"

struct RecordingWriteStatus
{
    enum Fault { none = 0, writeFailed = 1, flushFailed = 2, seekFailed = 3 };
    std::atomic<int> fault { none };
    std::atomic<juce::int64> writtenSamples { 0 };
    std::atomic<bool> finished { false };
    bool reported = false; // Recorder control thread, under its publication lock.
    juce::String trackId;
    juce::File file;
    juce::File journalFile;
    juce::var journalMetadata; // Immutable after writer publication.
    std::atomic<double> journalStartTime { 0.0 };
    std::atomic<juce::int64> droppedSamples { 0 };
    std::atomic<bool> journalFailureReported { false };
    void persistRecovery(bool finalized = false)
    {
        if (journalFile == juce::File()) return;
        auto metadata = journalMetadata.clone();
        auto* object = metadata.getDynamicObject();
        if (object == nullptr) return;
        object->setProperty("startTime", journalStartTime.load(std::memory_order_relaxed));
        object->setProperty("writtenSamples", writtenSamples.load(std::memory_order_relaxed));
        object->setProperty("droppedSamples", droppedSamples.load(std::memory_order_relaxed));
        object->setProperty("writeFault", fault.load(std::memory_order_relaxed));
        object->setProperty("status", finalized ? "finalized" : "recording");
        object->setProperty("updatedAt", juce::Time::currentTimeMillis());
        if (!RecoveryJournal::write(journalFile, metadata) && !journalFailureReported.exchange(true))
            juce::Logger::writeToLog("Recording recovery journal update failed: " + file.getFullPathName());
    }
    void fail(Fault reason) noexcept
    {
        int expected = none;
        fault.compare_exchange_strong(expected, reason, std::memory_order_relaxed);
    }
};

// Disk/control thread only. Observe even header writes from the WAV destructor:
// JUCE's ThreadedWriter intentionally does not return background writer errors.
class CheckedRecordingStream final : public juce::OutputStream
{
public:
    CheckedRecordingStream(std::unique_ptr<juce::OutputStream> stream,
                           std::shared_ptr<RecordingWriteStatus> state)
        : destination(std::move(stream)), status(std::move(state)),
          fileStream(dynamic_cast<juce::FileOutputStream*>(destination.get())) {}
    ~CheckedRecordingStream() override { flush(); }
    bool write(const void* data, size_t bytes) override
    {
        const bool ok = destination->write(data, bytes);
        if (!ok || fileFailed()) status->fail(RecordingWriteStatus::writeFailed);
        return ok && !fileFailed();
    }
    void flush() override
    {
        destination->flush();
        if (fileFailed()) status->fail(RecordingWriteStatus::flushFailed);
    }
    juce::int64 getPosition() override { return destination->getPosition(); }
    bool setPosition(juce::int64 position) override
    {
        const bool ok = destination->setPosition(position);
        if (!ok || fileFailed()) status->fail(RecordingWriteStatus::seekFailed);
        return ok && !fileFailed();
    }
private:
    bool fileFailed() const { return fileStream != nullptr && fileStream->getStatus().failed(); }
    std::unique_ptr<juce::OutputStream> destination;
    std::shared_ptr<RecordingWriteStatus> status;
    juce::FileOutputStream* fileStream;
};

class CheckedRecordingWriter final : public juce::AudioFormatWriter
{
public:
    CheckedRecordingWriter(std::unique_ptr<juce::AudioFormatWriter> writer,
                           std::shared_ptr<RecordingWriteStatus> state,
                           juce::OutputStream* stream)
        : AudioFormatWriter(nullptr, writer->getFormatName(), writer->getSampleRate(),
              static_cast<unsigned int>(writer->getNumChannels()), static_cast<unsigned int>(writer->getBitsPerSample())),
          destination(std::move(writer)), status(std::move(state)), checkedStream(stream)
    { usesFloatingPointData = destination->isFloatingPoint(); }
    ~CheckedRecordingWriter() override
    {
        flush();
        destination.reset(); // Final header writes are also observed by the stream.
        // A failed final header update leaves recoverable PCM behind a stale
        // length. Only a fault-free close makes that length authoritative.
        status->persistRecovery(status->fault.load(std::memory_order_relaxed) == RecordingWriteStatus::none);
        status->finished.store(true, std::memory_order_release);
    }
    bool write(const int** data, int samples) override
    {
        if (status->fault.load(std::memory_order_relaxed) != RecordingWriteStatus::none) return false;
        const bool ok = destination->write(data, samples);
        if (!ok) status->fail(RecordingWriteStatus::writeFailed);
        if (!ok || status->fault.load(std::memory_order_relaxed) != RecordingWriteStatus::none) return false;
        status->writtenSamples.fetch_add(samples, std::memory_order_relaxed);
        return true;
    }
    bool flush() override
    {
        const bool ok = destination->flush();
        checkedStream->flush();
        if (!ok) status->fail(RecordingWriteStatus::flushFailed);
        status->persistRecovery();
        return ok && status->fault.load(std::memory_order_relaxed) == RecordingWriteStatus::none;
    }
private:
    std::unique_ptr<juce::AudioFormatWriter> destination;
    std::shared_ptr<RecordingWriteStatus> status;
    juce::OutputStream* checkedStream; // Owned by destination, never used after reset.
};
