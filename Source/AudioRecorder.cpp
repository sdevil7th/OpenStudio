#include "AudioRecorder.h"
#include "CrashDiagnostics.h"

#include <algorithm>

namespace
{
#ifndef OPENSTUDIO_AUDIO_RECORD_DEBUG
 #define OPENSTUDIO_AUDIO_RECORD_DEBUG 0
#endif

#if OPENSTUDIO_AUDIO_RECORD_DEBUG
static void logAudioRecord(const juce::String& message)
{
    juce::Logger::writeToLog("[audio.record] " + message);
}
 #define OPENSTUDIO_LOG_AUDIO_RECORD(message) logAudioRecord(message)

static float peakFromBuffer(const juce::AudioBuffer<float>& buffer, int numSamples)
{
    float peak = 0.0f;
    const int channels = buffer.getNumChannels();
    for (int ch = 0; ch < channels; ++ch)
    {
        auto range = juce::FloatVectorOperations::findMinAndMax(buffer.getReadPointer(ch), numSamples);
        peak = juce::jmax(peak, juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd())));
    }
    return peak;
}
#else
 #define OPENSTUDIO_LOG_AUDIO_RECORD(message) do { } while (false)
#endif
}

AudioRecorder::RecordingPreview::RecordingPreview(double rate, int channels)
    : sampleRate(rate),
      numChannels(std::min(channels, PEAK_MAX_CHANNELS)),
      peakChunkEntries(static_cast<size_t>(rate * PEAK_CHUNK_SECONDS / recordingPeakStride) + 2)
{
    peakChunks[0] = std::make_unique<float[]>(peakChunkEntries * static_cast<size_t>(numChannels * 2));
    peakChunkPtrs[0].store(peakChunks[0].get(), std::memory_order_release);
    peakAllocatedChunks.store(1, std::memory_order_release);
}

void AudioRecorder::growRecordingPreview(const std::shared_ptr<RecordingPreview>& preview)
{
    if (!preview->active.load(std::memory_order_acquire)) return;
    const juce::ScopedLock lock(preview->growthLock);
    const size_t chunks = preview->peakAllocatedChunks.load(std::memory_order_acquire);
    const size_t capacity = chunks * preview->peakChunkEntries;
    const size_t completed = std::min(preview->peakTableSize.load(std::memory_order_acquire), capacity);
    const size_t reserve = static_cast<size_t>(preview->sampleRate * 30.0 / recordingPeakStride);
    if (chunks >= RecordingPreview::PEAK_MAX_CHUNKS || capacity - completed > reserve) return;

    // At most one 120-second chunk per maintenance pass, outside writerLock.
    // A retained owner and this preview-only lock also support concurrent reads.
    auto chunk = std::make_unique<float[]>(preview->peakChunkEntries * static_cast<size_t>(preview->numChannels * 2));
    preview->peakChunks[chunks] = std::move(chunk);
    preview->peakChunkPtrs[chunks].store(preview->peakChunks[chunks].get(), std::memory_order_release);
    preview->peakAllocatedChunks.store(chunks + 1, std::memory_order_release);
}

void AudioRecorder::maintainRecordingPreviews()
{
    std::vector<std::shared_ptr<RecordingPreview>> previews;
    {
        const juce::ScopedLock lock(previewRegistryLock);
        previews.reserve(recordingPreviews.size());
        for (const auto& item : recordingPreviews) previews.push_back(item.second);
    }
    for (const auto& preview : previews) growRecordingPreview(preview);
}

AudioRecorder::AudioRecorder(const juce::File& recoveryRoot) : recoveryJournal(recoveryRoot)
{
    // Start the background I/O thread for ThreadedWriter
    writerThread.startThread(juce::Thread::Priority::normal);
}

AudioRecorder::~AudioRecorder()
{
    stopAllRecordings(44100.0);
    writerThread.stopThread(-1); // All clients drained above; never forcibly kill an allocator/disk thread.
    recoveryJournal.markClean();
}

bool AudioRecorder::startRecording(const juce::String& trackId, const juce::File& file, double sampleRate, int numChannels)
{
    return startRecordingInternal(trackId, file, sampleRate, numChannels, 0.0, nullptr);
}

bool AudioRecorder::rolloverRecording(const juce::String& trackId,
                                      const juce::File& nextFile,
                                      double sampleRate,
                                      int numChannels,
                                      double nextStartTime,
                                      CompletedRecording& completedPreviousTake)
{
    completedPreviousTake = {};
    return startRecordingInternal(trackId,
                                  nextFile,
                                  sampleRate,
                                  numChannels,
                                  nextStartTime,
                                  &completedPreviousTake);
}

bool AudioRecorder::startRecordingInternal(const juce::String& trackId,
                                           const juce::File& file,
                                           double sampleRate,
                                           int numChannels,
                                           double initialStartTime,
                                           CompletedRecording* replacedTake)
{
    const juce::ScopedLock control(controlLock);
    // Reject before opening a file or touching an existing take. A corrupt
    // device/configuration report must not become an enormous peak allocation.
    if (trackId.isEmpty() || !std::isfinite(sampleRate)
        || sampleRate < 8000.0 || sampleRate > 384000.0
        || numChannels < 1 || numChannels > 64
        || !std::isfinite(initialStartTime))
        return false;
    OPENSTUDIO_LOG_AUDIO_RECORD("startRecording track=" + trackId
        + " file=" + file.getFullPathName()
        + " sampleRate=" + juce::String(sampleRate, 2)
        + " channels=" + juce::String(numChannels));
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> previousWriter;
    std::shared_ptr<RecordingWriteStatus> previousWriteStatus;
    double previousSampleRate = sampleRate;
    // Construct the replacement completely before unpublishing any current
    // take. During loop preparation the callback can continue writing the old
    // writer, so file creation cannot open a no-writer gap.

    // Create parent directory if needed
    auto parentDir = file.getParentDirectory();
    if (!parentDir.exists())
    {
        parentDir.createDirectory();
    }

    // Recording destinations are unique takes, never append to or overwrite an
    // existing user's file when a caller accidentally reuses a path.
    if (file.exists()) return false;
    // Create WAV file writer
    std::unique_ptr<juce::OutputStream> fileOutputStream = std::make_unique<juce::FileOutputStream>(file);
    if (static_cast<juce::FileOutputStream&>(*fileOutputStream).failedToOpen())
    {
        juce::Logger::writeToLog("AudioRecorder: Failed to create output file: " + file.getFullPathName());
        return false;
    }

    auto writeStatus = std::make_shared<RecordingWriteStatus>();
    writeStatus->trackId = trackId;
    writeStatus->file = file;
    fileOutputStream = std::make_unique<CheckedRecordingStream>(std::move(fileOutputStream), writeStatus);
    auto* checkedStream = fileOutputStream.get();
    // Create WAV writer (16-bit PCM)
    auto writer = wavFormat.createWriterFor(
        fileOutputStream,
        juce::AudioFormatWriterOptions()
            .withSampleRate(sampleRate)
            .withNumChannels(numChannels)
            .withBitsPerSample(16));

    if (!writer || writeStatus->fault.load() != RecordingWriteStatus::none)
    {
        juce::Logger::writeToLog("AudioRecorder: Failed to create WAV writer");
        return false;
    }

    auto journal = std::make_unique<juce::DynamicObject>();
    journal->setProperty("path", file.getFullPathName());
    journal->setProperty("trackId", trackId);
    journal->setProperty("sampleRate", sampleRate);
    journal->setProperty("channels", numChannels);
    journal->setProperty("bitDepth", 16);
    journal->setProperty("startTime", initialStartTime);
    journal->setProperty("status", "recording");
    journal->setProperty("writeFault", 0);
    journal->setProperty("createdAt", juce::Time::currentTimeMillis());
    journal->setProperty("kind", "recording");
    journal->setProperty("version", 1);
    auto metadata = juce::var(journal.release());
    const auto journalId = recoveryJournal.create("recording", metadata);
    if (journalId.isEmpty())
    {
        juce::Logger::writeToLog("AudioRecorder: Could not create the take recovery journal; recording was not started");
        return false;
    }
    metadata.getDynamicObject()->setProperty("id", journalId);
    writeStatus->journalMetadata = metadata;
    writeStatus->journalFile = recoveryJournal.entryFile(journalId);
    writeStatus->journalStartTime = initialStartTime;
    // Ensure a parseable zero-length header exists before accepting live input.
    if (!writer->flush()) return false;
    checkedStream->flush();
    if (writeStatus->fault.load() != RecordingWriteStatus::none) return false;

    // Wrap in ThreadedWriter - moves disk I/O to background thread
    auto checkedWriter = std::make_unique<CheckedRecordingWriter>(std::move(writer), writeStatus, checkedStream);
    auto threadedWriter = std::make_unique<juce::AudioFormatWriter::ThreadedWriter>(
        checkedWriter.release(), writerThread, 65536);
    // Periodic header publication and checked flush, exclusively on disk thread.
    threadedWriter->setFlushInterval(static_cast<int>(sampleRate * 5.0));

    auto preview = std::make_shared<RecordingPreview>(sampleRate, numChannels);

    // Brief lock: insert into map
    {
        const juce::ScopedLock sl(writerLock);
        auto previous = activeRecordings.find(trackId);
        if (previous != activeRecordings.end())
        {
            previous->second.isActive = false;
            previous->second.preview->active.store(false, std::memory_order_release);
            if (replacedTake != nullptr && previous->second.threadedWriter)
            {
                replacedTake->trackId = trackId;
                replacedTake->file = previous->second.outputFile;
                replacedTake->startTime = previous->second.startTime;
                replacedTake->duration = previous->second.samplesWritten.load(std::memory_order_relaxed)
                    / juce::jmax(1.0, previous->second.sampleRate);
            }
            previousWriter = std::move(previous->second.threadedWriter);
            previousWriteStatus = previous->second.writeStatus;
            previousSampleRate = previous->second.sampleRate;
            activeRecordings.erase(previous);
        }

        ActiveRecording& state = activeRecordings[trackId];
        state.trackId = trackId;
        state.threadedWriter = std::move(threadedWriter);
        state.writeStatus = writeStatus;
        state.outputFile = file;
        state.isActive = true;
        state.startTime = initialStartTime;
        state.samplesWritten = 0;
        state.numChannels = numChannels;
        state.sampleRate = sampleRate;
        state.captureStartOnFirstWrite = true;
        state.hasStartTimeFallback = replacedTake != nullptr;
        state.preview = preview;
        state.accumMin[0] = state.accumMin[1] = 0.0f;
        state.accumMax[0] = state.accumMax[1] = 0.0f;
        state.accumCount = 0;
    }
    {
        const juce::ScopedLock lock(previewRegistryLock);
        recordingPreviews[trackId] = std::move(preview);
    }
    {
        const juce::ScopedLock lock(statusLock);
        pendingWriteStatuses.push_back(writeStatus);
    }
    previousWriter.reset();
    if (replacedTake != nullptr && previousWriteStatus)
        replacedTake->duration = previousWriteStatus->writtenSamples.load() / juce::jmax(1.0, previousSampleRate);

    juce::Logger::writeToLog("AudioRecorder: Started recording track " + trackId +
                           " to " + file.getFullPathName());
    OPENSTUDIO_LOG_AUDIO_RECORD("startRecording success track=" + trackId
        + " file=" + file.getFullPathName());
    return true;
}

void AudioRecorder::writeBlock(const juce::String& trackId,
                               const juce::AudioBuffer<float>& buffer,
                               int numSamples,
                               double compensatedBlockStartTimeSeconds)
{
    // Use TryLock to avoid blocking the audio thread
    // If control publication holds the lock, the file loses this block. Keep
    // the window short and expose a counter rather than hiding the gap.
    const juce::ScopedTryLock sl(writerLock);
    if (!sl.isLocked())
    {
        writeLockMissCount.fetch_add(1, std::memory_order_relaxed);
        OpenStudioCrashDiagnostics::recordRealtimeFault(OpenStudioCrashDiagnostics::RealtimeFault::recordingLockMiss);
#if OPENSTUDIO_AUDIO_RECORD_DEBUG
        static std::atomic<int> globalLockMissLogCounter { 0 };
        const int lockMiss = ++globalLockMissLogCounter;
        if ((lockMiss % 20) == 1)
            OPENSTUDIO_LOG_AUDIO_RECORD("writeBlock lock miss track=" + trackId + " count=" + juce::String(lockMiss));
#endif
        return;
    }

    auto it = activeRecordings.find(trackId);
    if (it == activeRecordings.end() || !it->second.isActive.load() || !it->second.threadedWriter)
        return;

    auto& state = it->second;
    if (state.writeStatus->fault.load(std::memory_order_relaxed) != RecordingWriteStatus::none)
        return; // Quarantine this take; monitoring and other writers continue.
    if (numSamples < 0 || numSamples > buffer.getNumSamples()
        || buffer.getNumChannels() < state.numChannels)
    {
        OpenStudioCrashDiagnostics::recordRealtimeFault(
            OpenStudioCrashDiagnostics::RealtimeFault::recordingBufferContract);
        return;
    }
    if (numSamples == 0)
        return;
    const double captureToleranceSeconds = juce::jmax(
        0.25,
        4.0 * static_cast<double>(numSamples) / juce::jmax(1.0, state.sampleRate));
    const bool plausibleFirstBlock = !state.hasStartTimeFallback
        || std::abs(compensatedBlockStartTimeSeconds - state.startTime)
            <= captureToleranceSeconds;
    if (state.captureStartOnFirstWrite
        && std::isfinite(compensatedBlockStartTimeSeconds)
        && compensatedBlockStartTimeSeconds >= 0.0
        && plausibleFirstBlock)
    {
        state.startTime = compensatedBlockStartTimeSeconds;
        state.writeStatus->journalStartTime.store(state.startTime, std::memory_order_relaxed);
        state.captureStartOnFirstWrite = false;
    }
#if OPENSTUDIO_AUDIO_RECORD_DEBUG
    const float inputPeak = peakFromBuffer(buffer, numSamples);
#endif

    // ThreadedWriter::write() is audio-thread safe (lock-free ring buffer internally)
    // It copies data immediately, so buffer pointers don't need to remain valid
    if (!state.threadedWriter->write(buffer.getArrayOfReadPointers(), numSamples))
    {
        writerBufferOverflowCount.fetch_add(1, std::memory_order_relaxed);
        state.writeStatus->droppedSamples.fetch_add(numSamples, std::memory_order_relaxed);
        OpenStudioCrashDiagnostics::recordRealtimeFault(OpenStudioCrashDiagnostics::RealtimeFault::recordingOverflow);
        return;
    }
    state.samplesWritten.fetch_add(numSamples, std::memory_order_relaxed);
#if OPENSTUDIO_AUDIO_RECORD_DEBUG
    if (state.debugLoggedBlocks < 5)
    {
        ++state.debugLoggedBlocks;
        OPENSTUDIO_LOG_AUDIO_RECORD("writeBlock track=" + trackId
            + " numSamples=" + juce::String(numSamples)
            + " inputPeak=" + juce::String(inputPeak, 4)
            + " cumulativeSamples=" + juce::String(static_cast<juce::int64>(state.samplesWritten.load())));
    }
#endif

    // Incremental peak accumulation for live waveform display.
    // Cheaper than the old interleaved-copy path: only min/max comparisons,
    // no index arithmetic, and the peak table is ~100× smaller than sampleBuffer.
    // The audio thread is the sole writer; message thread reads via atomic size.
    auto& preview = *state.preview;
    if (preview.peakAllocatedChunks.load(std::memory_order_acquire) > 0)
    {
        const int chCount = std::min(state.numChannels, RecordingPreview::PEAK_MAX_CHANNELS);
        const float* chPtrs[RecordingPreview::PEAK_MAX_CHANNELS] = { nullptr, nullptr };
        chPtrs[0] = buffer.getReadPointer(0);
        if (chCount > 1)
            chPtrs[1] = buffer.getReadPointer(std::min(1, buffer.getNumChannels() - 1));

        for (int s = 0; s < numSamples; ++s)
        {
            for (int ch = 0; ch < chCount; ++ch)
            {
                const float v = chPtrs[ch][s];
                if (v < state.accumMin[ch]) state.accumMin[ch] = v;
                if (v > state.accumMax[ch]) state.accumMax[ch] = v;
            }

            if (++state.accumCount >= recordingPeakStride)
            {
                const size_t idx = preview.peakTableSize.load(std::memory_order_relaxed);
                const size_t chunkIndex = preview.peakChunkEntries > 0
                    ? idx / preview.peakChunkEntries
                    : RecordingPreview::PEAK_MAX_CHUNKS;
                if (chunkIndex < preview.peakAllocatedChunks.load(std::memory_order_acquire))
                {
                    if (float* chunk = preview.peakChunkPtrs[chunkIndex].load(std::memory_order_acquire))
                    {
                        const size_t entryIndex = idx % preview.peakChunkEntries;
                        float* entry = chunk + entryIndex * static_cast<size_t>(chCount * 2);
                        for (int ch = 0; ch < chCount; ++ch)
                        {
                            entry[ch * 2]     = state.accumMin[ch];
                            entry[ch * 2 + 1] = state.accumMax[ch];
                        }
                    }
                }
                // Keep time aligned if control maintenance is temporarily late.
                // Missing preview storage is a gap, never compressed audio time.
                if (idx < preview.peakChunkEntries * RecordingPreview::PEAK_MAX_CHUNKS)
                    preview.peakTableSize.store(idx + 1, std::memory_order_release);
                state.accumMin[0] = state.accumMin[1] = 0.0f;
                state.accumMax[0] = state.accumMax[1] = 0.0f;
                state.accumCount = 0;
            }
        }
    }
    // If peak table is full, waveform display stops updating but recording continues
}

void AudioRecorder::stopRecording(const juce::String& trackId)
{
    const juce::ScopedLock control(controlLock);
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writerToFlush;
    juce::File outputFile;
    {
        const juce::ScopedLock sl(writerLock);
        auto it = activeRecordings.find(trackId);
        if (it == activeRecordings.end())
            return;

        it->second.isActive = false;
        it->second.preview->active.store(false, std::memory_order_release);
        writerToFlush = std::move(it->second.threadedWriter);
        outputFile = it->second.outputFile;
        activeRecordings.erase(it);
    }

    {
        const juce::ScopedLock lock(previewRegistryLock);
        recordingPreviews.erase(trackId);
    }
    writerToFlush.reset();
    juce::Logger::writeToLog("AudioRecorder: Stopped recording track " + trackId
                           + " (" + outputFile.getFullPathName() + ")");
}

bool AudioRecorder::isRecording(const juce::String& trackId) const
{
    // Use TryLock to avoid blocking the audio thread
    const juce::ScopedTryLock sl(writerLock);
    if (!sl.isLocked())
        return false;  // Can't check right now, assume not recording

    auto it = activeRecordings.find(trackId);
    return it != activeRecordings.end() && it->second.isActive.load();
}

void AudioRecorder::setRecordingStartTime(const juce::String& trackId, double startTime)
{
    if (!std::isfinite(startTime) || startTime < 0) return;
    std::shared_ptr<RecordingWriteStatus> status;
    {
        const juce::ScopedLock lock(writerLock);
        auto it = activeRecordings.find(trackId);
        if (it != activeRecordings.end())
        {
            it->second.startTime = startTime;
            it->second.hasStartTimeFallback = true;
            status = it->second.writeStatus;
            status->journalStartTime = startTime;
        }
    }
    if (status) status->persistRecovery(); // Never perform journal IO under writerLock.
}

std::vector<AudioRecorder::CompletedRecording> AudioRecorder::stopAllRecordings(double currentSampleRate)
{
    juce::ignoreUnused(currentSampleRate);
    const juce::ScopedLock control(controlLock);
    std::map<juce::String, ActiveRecording> recordingsToFinalize;
    {
        const juce::ScopedLock lock(writerLock);
        for (auto& [trackId, state] : activeRecordings)
        {
            juce::ignoreUnused(trackId);
            state.isActive = false;
            state.preview->active.store(false, std::memory_order_release);
        }
        recordingsToFinalize.swap(activeRecordings);
    }

    {
        const juce::ScopedLock lock(previewRegistryLock);
        recordingPreviews.clear();
    }

    std::vector<CompletedRecording> finalizedClips;
    finalizedClips.reserve(recordingsToFinalize.size());

    for (auto& [trackId, state] : recordingsToFinalize)
    {
        if (! state.threadedWriter)
            continue;

        // Drain outside the publication lock, then use acknowledged writes,
        // not the number accepted into the FIFO, for the published clip length.
        state.threadedWriter.reset();

        CompletedRecording clip;
        clip.trackId = trackId;
        clip.file = state.outputFile;
        clip.startTime = state.startTime;
        clip.duration = state.writeStatus->writtenSamples.load(std::memory_order_relaxed)
            / juce::jmax(1.0, state.sampleRate);
        finalizedClips.push_back(clip);
        OPENSTUDIO_LOG_AUDIO_RECORD("stopAllRecordings pending track=" + trackId
            + " file=" + state.outputFile.getFullPathName()
            + " startTime=" + juce::String(state.startTime, 3)
            + " samplesWritten=" + juce::String(static_cast<juce::int64>(state.samplesWritten.load()))
            + " duration=" + juce::String(clip.duration, 3)
            + (clip.duration <= 0.0 ? " WARNING_zero_duration" : ""));
    }

    juce::Logger::writeToLog("AudioRecorder: Stopped all recordings. Completed "
                             + juce::String(finalizedClips.size()) + " clips.");
    OPENSTUDIO_LOG_AUDIO_RECORD("stopAllRecordings completed clipCount="
        + juce::String(static_cast<int>(finalizedClips.size())));
    return finalizedClips;

}

juce::var AudioRecorder::takeWriteFailures()
{
    juce::Array<juce::var> failures;
    const juce::ScopedLock lock(statusLock);
    for (const auto& state : pendingWriteStatuses)
    {
        const auto fault = state->fault.load(std::memory_order_acquire);
        if (fault == RecordingWriteStatus::none || state->reported) continue;
        state->reported = true;
        auto item = std::make_unique<juce::DynamicObject>();
        item->setProperty("trackId", state->trackId);
        item->setProperty("path", state->file.getFullPathName());
        item->setProperty("reason", fault);
        failures.add(juce::var(item.release()));
    }
    pendingWriteStatuses.erase(std::remove_if(pendingWriteStatuses.begin(), pendingWriteStatuses.end(), [](const auto& state) {
        return state->finished.load(std::memory_order_acquire)
            && (state->reported || state->fault.load() == RecordingWriteStatus::none);
    }), pendingWriteStatuses.end());
    return failures;
}

juce::var AudioRecorder::getRecordingPeaks(const juce::String& trackId,
                                           int samplesPerPixel,
                                           int numPixels,
                                           juce::int64 startSample)
{
    // Preserve the requested sample scale, including old sub-stride callers.
    // Bound both bridge payload and aggregation work; callers may append the
    // returned prefix. New viewport clients use multiples of the 256-sample stride.
    juce::Array<juce::var> peakData;
    if (samplesPerPixel <= 0 || numPixels <= 0) return peakData;
    startSample = std::max<juce::int64>(0, startSample);
    std::shared_ptr<RecordingPreview> preview;
    {
        const juce::ScopedLock lock(previewRegistryLock);
        const auto found = recordingPreviews.find(trackId);
        if (found == recordingPreviews.end()) return peakData;
        preview = found->second;
    }
    if (!preview->active.load(std::memory_order_acquire)) return peakData;

    // No writerLock, no disk I/O and no growth allocation on this query path.
    // Published entries are immutable. The retained owner makes stop/rollover
    // safe even when a non-message-thread caller is still reading this take.
    const size_t completed = preview->peakTableSize.load(std::memory_order_acquire);
    const size_t chunks = preview->peakAllocatedChunks.load(std::memory_order_acquire);
    const size_t tableSize = std::min(completed, chunks * preview->peakChunkEntries);
    const auto coveredSamples = static_cast<juce::int64>(tableSize) * recordingPeakStride;
    if (startSample >= coveredSamples) return peakData;
    const auto completePixels = (coveredSamples - startSample) / samplesPerPixel;
    const auto entriesPerPixel = (static_cast<juce::int64>(samplesPerPixel) + recordingPeakStride - 1)
        / recordingPeakStride + ((startSample % recordingPeakStride != 0 || samplesPerPixel % recordingPeakStride != 0) ? 1 : 0);
    const auto workLimitedPixels = static_cast<juce::int64>(maximumRecordingPeakEntriesPerRequest) / entriesPerPixel;
    const int actualPeaks = static_cast<int>(std::min({ completePixels, workLimitedPixels,
        static_cast<juce::int64>(numPixels), static_cast<juce::int64>(maximumRecordingPeakPixels) }));
    if (actualPeaks <= 0) return peakData;

    const int numChannels = preview->numChannels;
    peakData.ensureStorageAllocated(1 + actualPeaks * numChannels * 2);
    peakData.add(numChannels);
    for (int pixel = 0; pixel < actualPeaks; ++pixel)
    {
        const auto pixelStart = startSample + static_cast<juce::int64>(pixel) * samplesPerPixel;
        const auto pixelEnd = pixelStart + samplesPerPixel;
        const size_t firstEntry = static_cast<size_t>(pixelStart / recordingPeakStride);
        // Exclusive end: an exactly aligned pixel must not read the next bucket.
        const size_t lastEntry = static_cast<size_t>((pixelEnd + recordingPeakStride - 1) / recordingPeakStride);
        for (int channel = 0; channel < numChannels; ++channel)
        {
            float minimum = 0.0f, maximum = 0.0f;
            for (size_t entry = firstEntry; entry < lastEntry; ++entry)
            {
                const size_t chunkIndex = entry / preview->peakChunkEntries;
                const auto* chunk = preview->peakChunkPtrs[chunkIndex].load(std::memory_order_acquire);
                if (chunk == nullptr) continue;
                const auto* values = chunk + (entry % preview->peakChunkEntries) * static_cast<size_t>(numChannels * 2);
                minimum = std::min(minimum, values[channel * 2]);
                maximum = std::max(maximum, values[channel * 2 + 1]);
            }
            peakData.add(minimum); peakData.add(maximum);
        }
    }
    return peakData;
}

#undef OPENSTUDIO_LOG_AUDIO_RECORD
