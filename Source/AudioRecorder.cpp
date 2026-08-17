#include "AudioRecorder.h"

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

AudioRecorder::AudioRecorder()
{
    // Start the background I/O thread for ThreadedWriter
    writerThread.startThread(juce::Thread::Priority::normal);
}

AudioRecorder::~AudioRecorder()
{
    stopAllRecordings(44100.0);
    writerThread.stopThread(2000);
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
    OPENSTUDIO_LOG_AUDIO_RECORD("startRecording track=" + trackId
        + " file=" + file.getFullPathName()
        + " sampleRate=" + juce::String(sampleRate, 2)
        + " channels=" + juce::String(numChannels));
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> previousWriter;
    // Construct the replacement completely before unpublishing any current
    // take. During loop preparation the callback can continue writing the old
    // writer, so file creation cannot open a no-writer gap.

    // Create parent directory if needed
    auto parentDir = file.getParentDirectory();
    if (!parentDir.exists())
    {
        parentDir.createDirectory();
    }

    // Create WAV file writer
    auto* fileOutputStream = new juce::FileOutputStream(file);
    if (!fileOutputStream->openedOk())
    {
        delete fileOutputStream;
        juce::Logger::writeToLog("AudioRecorder: Failed to create output file: " + file.getFullPathName());
        return false;
    }

    // Create WAV writer (16-bit PCM)
    juce::AudioFormatWriter* rawWriter =
        wavFormat.createWriterFor(fileOutputStream, sampleRate, (unsigned int)numChannels, 16, {}, 0);

    if (!rawWriter)
    {
        delete fileOutputStream;
        juce::Logger::writeToLog("AudioRecorder: Failed to create WAV writer");
        return false;
    }

    // Wrap in ThreadedWriter - moves disk I/O to background thread
    auto threadedWriter = std::make_unique<juce::AudioFormatWriter::ThreadedWriter>(
        rawWriter, writerThread, 65536);

    // Pre-allocate incremental peak table for ~120 seconds of recording.
    // Entry layout: [min_ch0, max_ch0, min_ch1, max_ch1] per PEAK_STRIDE samples.
    // At 44.1kHz/256 stride: ~20 700 entries × 2 ch × 2 values × 4 B ≈ 660 KB/track.
    // Zero-init so getRecordingPeaks can safely read unwritten entries as 0.
    const size_t maxEntries = static_cast<size_t>(
        sampleRate * ActiveRecording::PEAK_CHUNK_SECONDS / ActiveRecording::PEAK_STRIDE) + 2;
    const int    entryFloats = std::min(numChannels, ActiveRecording::PEAK_MAX_CHANNELS) * 2;
    auto peakBuf = std::unique_ptr<float[]>(new float[maxEntries * static_cast<size_t>(entryFloats)]());

    // Brief lock: insert into map
    {
        const juce::ScopedLock sl(writerLock);
        auto previous = activeRecordings.find(trackId);
        if (previous != activeRecordings.end())
        {
            previous->second.isActive = false;
            if (replacedTake != nullptr && previous->second.threadedWriter)
            {
                replacedTake->trackId = trackId;
                replacedTake->file = previous->second.outputFile;
                replacedTake->startTime = previous->second.startTime;
                replacedTake->duration = previous->second.samplesWritten.load(std::memory_order_relaxed)
                    / juce::jmax(1.0, previous->second.sampleRate);
            }
            previousWriter = std::move(previous->second.threadedWriter);
            activeRecordings.erase(previous);
        }

        ActiveRecording& state = activeRecordings[trackId];
        state.trackId = trackId;
        state.threadedWriter = std::move(threadedWriter);
        state.outputFile = file;
        state.isActive = true;
        state.startTime = initialStartTime;
        state.samplesWritten = 0;
        state.numChannels = numChannels;
        state.sampleRate = sampleRate;
        state.captureStartOnFirstWrite = true;
        state.hasStartTimeFallback = replacedTake != nullptr;
        for (size_t chunk = 0; chunk < ActiveRecording::PEAK_MAX_CHUNKS; ++chunk)
            state.peakChunkPtrs[chunk].store(nullptr, std::memory_order_relaxed);
        state.peakChunks[0] = std::move(peakBuf);
        state.peakChunkPtrs[0].store(state.peakChunks[0].get(), std::memory_order_release);
        state.peakAllocatedChunks.store(1, std::memory_order_release);
        state.peakChunkEntries = maxEntries;
        state.peakTableSize.store(0, std::memory_order_relaxed);
        state.accumMin[0] = state.accumMin[1] = 0.0f;
        state.accumMax[0] = state.accumMax[1] = 0.0f;
        state.accumCount = 0;
    }
    previousWriter.reset();

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
    if (state.peakAllocatedChunks.load(std::memory_order_acquire) > 0)
    {
        const int chCount = std::min(state.numChannels, ActiveRecording::PEAK_MAX_CHANNELS);
        const float* chPtrs[ActiveRecording::PEAK_MAX_CHANNELS] = { nullptr, nullptr };
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

            if (++state.accumCount >= ActiveRecording::PEAK_STRIDE)
            {
                const size_t idx = state.peakTableSize.load(std::memory_order_relaxed);
                const size_t chunkIndex = state.peakChunkEntries > 0
                    ? idx / state.peakChunkEntries
                    : ActiveRecording::PEAK_MAX_CHUNKS;
                if (chunkIndex < state.peakAllocatedChunks.load(std::memory_order_acquire))
                {
                    if (float* chunk = state.peakChunkPtrs[chunkIndex].load(std::memory_order_acquire))
                    {
                        const size_t entryIndex = idx % state.peakChunkEntries;
                        float* entry = chunk + entryIndex * static_cast<size_t>(chCount * 2);
                        for (int ch = 0; ch < chCount; ++ch)
                        {
                            entry[ch * 2]     = state.accumMin[ch];
                            entry[ch * 2 + 1] = state.accumMax[ch];
                        }
                        state.peakTableSize.store(idx + 1, std::memory_order_release);
                    }
                }
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
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writerToFlush;
    juce::File outputFile;
    {
        const juce::ScopedLock sl(writerLock);
        auto it = activeRecordings.find(trackId);
        if (it == activeRecordings.end())
            return;

        it->second.isActive = false;
        writerToFlush = std::move(it->second.threadedWriter);
        outputFile = it->second.outputFile;
        activeRecordings.erase(it);
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
    const juce::ScopedLock lock(writerLock);
    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        it->second.startTime = startTime;
        it->second.hasStartTimeFallback = true;
    }
}

std::vector<AudioRecorder::CompletedRecording> AudioRecorder::stopAllRecordings(double currentSampleRate)
{
    juce::ignoreUnused(currentSampleRate);
    std::map<juce::String, ActiveRecording> recordingsToFinalize;
    {
        const juce::ScopedLock lock(writerLock);
        for (auto& [trackId, state] : activeRecordings)
        {
            juce::ignoreUnused(trackId);
            state.isActive = false;
        }
        recordingsToFinalize.swap(activeRecordings);
    }

    std::vector<std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter>> finalizedWriters;
    std::vector<CompletedRecording> finalizedClips;
    finalizedWriters.reserve(recordingsToFinalize.size());
    finalizedClips.reserve(recordingsToFinalize.size());

    for (auto& [trackId, state] : recordingsToFinalize)
    {
        if (! state.threadedWriter)
            continue;

        CompletedRecording clip;
        clip.trackId = trackId;
        clip.file = state.outputFile;
        clip.startTime = state.startTime;
        clip.duration = state.samplesWritten.load(std::memory_order_relaxed)
            / juce::jmax(1.0, state.sampleRate);
        finalizedClips.push_back(clip);
        OPENSTUDIO_LOG_AUDIO_RECORD("stopAllRecordings pending track=" + trackId
            + " file=" + state.outputFile.getFullPathName()
            + " startTime=" + juce::String(state.startTime, 3)
            + " samplesWritten=" + juce::String(static_cast<juce::int64>(state.samplesWritten.load()))
            + " duration=" + juce::String(clip.duration, 3)
            + (clip.duration <= 0.0 ? " WARNING_zero_duration" : ""));
        finalizedWriters.push_back(std::move(state.threadedWriter));
    }

    finalizedWriters.clear();
    juce::Logger::writeToLog("AudioRecorder: Stopped all recordings. Completed "
                             + juce::String(finalizedClips.size()) + " clips.");
    OPENSTUDIO_LOG_AUDIO_RECORD("stopAllRecordings completed clipCount="
        + juce::String(static_cast<int>(finalizedClips.size())));
    return finalizedClips;

}

juce::var AudioRecorder::getRecordingPeaks(const juce::String& trackId,
                                           int samplesPerPixel,
                                           int numPixels,
                                           juce::int64 startSample)
{
    // Flat array format: [numChannels, min_ch0_px0, max_ch0_px0, min_ch1_px0, max_ch1_px0, ...]
    juce::Array<juce::var> peakData;

    size_t growFromChunk = ActiveRecording::PEAK_MAX_CHUNKS;
    size_t growChunkEntries = 0;
    int growEntryFloats = 0;
    {
        const juce::ScopedLock sl(writerLock);
        auto it = activeRecordings.find(trackId);
        if (it == activeRecordings.end() || !it->second.isActive.load())
            return peakData;

        const auto& state = it->second;
        const size_t allocatedChunks = state.peakAllocatedChunks.load(std::memory_order_acquire);
        const size_t allocatedEntries = allocatedChunks * state.peakChunkEntries;
        const size_t completedEntries = juce::jmin(
            state.peakTableSize.load(std::memory_order_acquire), allocatedEntries);
        const size_t entriesRemaining = allocatedEntries - completedEntries;
        const size_t growThreshold = static_cast<size_t>(
            state.sampleRate * 30.0 / ActiveRecording::PEAK_STRIDE);
        if (entriesRemaining <= growThreshold
            && allocatedChunks < ActiveRecording::PEAK_MAX_CHUNKS)
        {
            growFromChunk = allocatedChunks;
            growChunkEntries = state.peakChunkEntries;
            growEntryFloats = std::min(
                state.numChannels, ActiveRecording::PEAK_MAX_CHANNELS) * 2;
        }
    }

    std::unique_ptr<float[]> nextChunk;
    if (growFromChunk < ActiveRecording::PEAK_MAX_CHUNKS
        && growChunkEntries > 0
        && growEntryFloats > 0)
    {
        nextChunk = std::unique_ptr<float[]>(
            new float[growChunkEntries * static_cast<size_t>(growEntryFloats)]());
    }

    // Brief lock only to publish growth and snapshot the recording entry.
    int numChannels = 0;
    size_t tableSize = 0;
    size_t chunkEntries = 0;
    std::array<const float*, ActiveRecording::PEAK_MAX_CHUNKS> chunkPtrs {};

    {
        const juce::ScopedLock sl(writerLock);
        auto it = activeRecordings.find(trackId);
        if (it == activeRecordings.end() || !it->second.isActive.load())
            return peakData;

        auto& state = it->second;
        const size_t allocatedChunks = state.peakAllocatedChunks.load(std::memory_order_acquire);
        if (nextChunk && allocatedChunks == growFromChunk)
        {
            state.peakChunks[growFromChunk] = std::move(nextChunk);
            state.peakChunkPtrs[growFromChunk].store(
                state.peakChunks[growFromChunk].get(), std::memory_order_release);
            state.peakAllocatedChunks.store(growFromChunk + 1, std::memory_order_release);
        }

        numChannels = std::min(state.numChannels, ActiveRecording::PEAK_MAX_CHANNELS);
        tableSize = state.peakTableSize.load(std::memory_order_acquire);
        chunkEntries = state.peakChunkEntries;
        const size_t publishedChunks = state.peakAllocatedChunks.load(std::memory_order_acquire);
        for (size_t chunk = 0; chunk < publishedChunks; ++chunk)
            chunkPtrs[chunk] = state.peakChunkPtrs[chunk].load(std::memory_order_acquire);
    }
    // Lock released — read is lock-free (stable pointer, atomic size).
    // getRecordingPeaks() and stopAllRecordings() both run on the message thread
    // so they are never concurrent — no use-after-free risk.

    startSample = juce::jmax<juce::int64>(0, startSample);
    if (numChannels == 0 || chunkEntries == 0 || tableSize == 0
        || samplesPerPixel <= 0 || numPixels <= 0)
        return peakData;

    // Each table entry covers PEAK_STRIDE samples.
    // Use floating-point sample positions to correctly map pixels to peak entries,
    // avoiding integer division truncation that caused waveform stretching.
    // Previously, entriesPerPixel = samplesPerPixel / stride (integer division)
    // would truncate e.g. 441/256 = 1 instead of 1.72, causing each pixel to read
    // only one entry and covering just 58% of the actual recording at 100 pps.
    const int stride = ActiveRecording::PEAK_STRIDE;

    // Calculate how many complete pixels the peak table data can cover
    const double totalSamplesCovered = static_cast<double>(tableSize) * stride;
    const double availableSamples = juce::jmax(
        0.0, totalSamplesCovered - static_cast<double>(startSample));
    const int maxPixelsFromData = static_cast<int>(availableSamples / samplesPerPixel);
    const int actualPeaks = std::min(numPixels, maxPixelsFromData);

    if (actualPeaks <= 0)
        return peakData;

    peakData.ensureStorageAllocated(1 + actualPeaks * numChannels * 2);
    peakData.add(juce::var(numChannels));

    for (int pixel = 0; pixel < actualPeaks; ++pixel)
    {
        // Map pixel range to sample range, then to peak table entry range
        const double pixelStartSample = static_cast<double>(startSample)
            + pixel * static_cast<double>(samplesPerPixel);
        const double pixelEndSample = pixelStartSample + samplesPerPixel;
        const size_t firstEntry = static_cast<size_t>(pixelStartSample / stride);
        const size_t lastEntry = std::min(static_cast<size_t>(pixelEndSample / stride) + 1,
                                          tableSize);

        for (int ch = 0; ch < numChannels; ++ch)
        {
            float minVal = 0.0f, maxVal = 0.0f;
            for (size_t e = firstEntry; e < lastEntry; ++e)
            {
                const size_t chunkIndex = e / chunkEntries;
                const size_t entryIndex = e % chunkEntries;
                if (chunkIndex >= chunkPtrs.size() || chunkPtrs[chunkIndex] == nullptr)
                    continue;
                const float* entry = chunkPtrs[chunkIndex]
                    + entryIndex * static_cast<size_t>(numChannels * 2);
                const float eMin = entry[ch * 2];
                const float eMax = entry[ch * 2 + 1];
                if (eMin < minVal) minVal = eMin;
                if (eMax > maxVal) maxVal = eMax;
            }
            peakData.add(juce::var(minVal));
            peakData.add(juce::var(maxVal));
        }
    }

    return peakData;
}

#undef OPENSTUDIO_LOG_AUDIO_RECORD
