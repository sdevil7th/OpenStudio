#include "AudioRecorder.h"

namespace
{
#if JUCE_DEBUG
constexpr bool kAudioRecordDebugLogs = true;
#else
constexpr bool kAudioRecordDebugLogs = false;
#endif

static void logAudioRecord(const juce::String& message)
{
    if (kAudioRecordDebugLogs)
        juce::Logger::writeToLog("[audio.record] " + message);
}

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
    logAudioRecord("startRecording track=" + trackId
        + " file=" + file.getFullPathName()
        + " sampleRate=" + juce::String(sampleRate, 2)
        + " channels=" + juce::String(numChannels));
    // Stop any existing recording for this track (brief lock)
    {
        const juce::ScopedLock sl(writerLock);
        if (activeRecordings.find(trackId) != activeRecordings.end())
        {
            auto it = activeRecordings.find(trackId);
            it->second.isActive = false;
            it->second.threadedWriter.reset();
            activeRecordings.erase(it);
        }
    }
    // Lock released — all heavy I/O below happens WITHOUT holding writerLock,
    // so the audio thread's TryLock won't fail during setup.

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
    const size_t maxEntries = static_cast<size_t>(sampleRate * 120.0 / ActiveRecording::PEAK_STRIDE) + 2;
    const int    entryFloats = std::min(numChannels, ActiveRecording::PEAK_MAX_CHANNELS) * 2;
    auto peakBuf = std::unique_ptr<float[]>(new float[maxEntries * static_cast<size_t>(entryFloats)]());

    // Brief lock: insert into map
    {
        const juce::ScopedLock sl(writerLock);
        ActiveRecording& state = activeRecordings[trackId];
        state.trackId = trackId;
        state.threadedWriter = std::move(threadedWriter);
        state.outputFile = file;
        state.isActive = true;
        state.startTime = 0.0;
        state.samplesWritten = 0;
        state.numChannels = numChannels;
        state.sampleRate = sampleRate;
        state.peakTable         = std::move(peakBuf);
        state.peakTableCapacity = maxEntries;
        state.peakTableSize.store(0, std::memory_order_relaxed);
        state.accumMin[0] = state.accumMin[1] = 0.0f;
        state.accumMax[0] = state.accumMax[1] = 0.0f;
        state.accumCount = 0;
    }

    juce::Logger::writeToLog("AudioRecorder: Started recording track " + trackId +
                           " to " + file.getFullPathName());
    logAudioRecord("startRecording success track=" + trackId
        + " file=" + file.getFullPathName());
    return true;
}

void AudioRecorder::writeBlock(const juce::String& trackId, const juce::AudioBuffer<float>& buffer, int numSamples)
{
    // Use TryLock to avoid blocking the audio thread
    // If the lock is held (during start/stop recording), we skip this block
    // This is extremely rare and inaudible
    const juce::ScopedTryLock sl(writerLock);
    if (!sl.isLocked())
    {
        static std::atomic<int> globalLockMissLogCounter { 0 };
        const int lockMiss = ++globalLockMissLogCounter;
        if ((lockMiss % 20) == 1)
            logAudioRecord("writeBlock lock miss track=" + trackId + " count=" + juce::String(lockMiss));
        return;
    }

    auto it = activeRecordings.find(trackId);
    if (it == activeRecordings.end() || !it->second.isActive.load() || !it->second.threadedWriter)
        return;

    auto& state = it->second;
    const float inputPeak = peakFromBuffer(buffer, numSamples);

    // ThreadedWriter::write() is audio-thread safe (lock-free ring buffer internally)
    // It copies data immediately, so buffer pointers don't need to remain valid
    state.threadedWriter->write(buffer.getArrayOfReadPointers(), numSamples);
    state.samplesWritten.fetch_add(numSamples);
    if (state.debugLoggedBlocks < 5)
    {
        ++state.debugLoggedBlocks;
        logAudioRecord("writeBlock track=" + trackId
            + " numSamples=" + juce::String(numSamples)
            + " inputPeak=" + juce::String(inputPeak, 4)
            + " cumulativeSamples=" + juce::String(static_cast<juce::int64>(state.samplesWritten.load())));
    }

    // Incremental peak accumulation for live waveform display.
    // Cheaper than the old interleaved-copy path: only min/max comparisons,
    // no index arithmetic, and the peak table is ~100× smaller than sampleBuffer.
    // The audio thread is the sole writer; message thread reads via atomic size.
    if (state.peakTable)
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
                if (idx < state.peakTableCapacity)
                {
                    float* entry = state.peakTable.get() + idx * static_cast<size_t>(chCount * 2);
                    for (int ch = 0; ch < chCount; ++ch)
                    {
                        entry[ch * 2]     = state.accumMin[ch];
                        entry[ch * 2 + 1] = state.accumMax[ch];
                    }
                    state.peakTableSize.store(idx + 1, std::memory_order_release);
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
    const juce::ScopedLock sl(writerLock);

    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        // Mark inactive first so audio thread stops writing
        it->second.isActive = false;

        // ThreadedWriter destructor flushes remaining data
        it->second.threadedWriter.reset();

        juce::Logger::writeToLog("AudioRecorder: Stopped recording track " + trackId +
                               " (" + it->second.outputFile.getFullPathName() + ")");
        activeRecordings.erase(it);
    }
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
    juce::ScopedLock lock(writerLock);
    auto it = activeRecordings.find(trackId);
    if (it != activeRecordings.end())
    {
        it->second.startTime = startTime;
    }
}

std::vector<AudioRecorder::CompletedRecording> AudioRecorder::stopAllRecordings(double currentSampleRate)
{
    // Phase 1 (under lock): mark all recordings inactive and collect their writers.
    // Keeping this section minimal means the audio thread's ScopedTryLock unblocks
    // as soon as we leave Phase 1, even while writers are still flushing below.
    std::vector<std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter>> writersToFlush;
    std::vector<CompletedRecording> completedClips;

    {
        const juce::ScopedLock lock(writerLock);

        for (auto& [trackId, state] : activeRecordings)
        {
            state.isActive = false;  // Audio thread stops calling writeBlock

            if (state.threadedWriter)
            {
                CompletedRecording clip;
                clip.trackId   = trackId;
                clip.file      = state.outputFile;
                clip.startTime = state.startTime;
                clip.duration  = state.samplesWritten.load() / currentSampleRate;
                completedClips.push_back(clip);
                logAudioRecord("stopAllRecordings pending track=" + trackId
                    + " file=" + state.outputFile.getFullPathName()
                    + " startTime=" + juce::String(state.startTime, 3)
                    + " samplesWritten=" + juce::String(static_cast<juce::int64>(state.samplesWritten.load()))
                    + " duration=" + juce::String(clip.duration, 3)
                    + (clip.duration <= 0.0 ? " WARNING_zero_duration" : ""));

                writersToFlush.push_back(std::move(state.threadedWriter));
            }
        }

        activeRecordings.clear();
    }
    // Lock RELEASED — audio thread's TryLock now succeeds immediately

    // Phase 2 (outside lock): destroy the writers, which flushes remaining data
    // to disk via the background writerThread.  This may block briefly but does
    // not contend with the audio thread.
    writersToFlush.clear();

    juce::Logger::writeToLog("AudioRecorder: Stopped all recordings. Completed " +
                             juce::String(completedClips.size()) + " clips.");
    logAudioRecord("stopAllRecordings completed clipCount=" + juce::String(static_cast<int>(completedClips.size())));

    return completedClips;
}

juce::var AudioRecorder::getRecordingPeaks(const juce::String& trackId, int samplesPerPixel, int numPixels)
{
    // Flat array format: [numChannels, min_ch0_px0, max_ch0_px0, min_ch1_px0, max_ch1_px0, ...]
    juce::Array<juce::var> peakData;

    // Brief lock only to look up the recording entry
    int numChannels = 0;
    const float* tablePtr = nullptr;
    size_t tableSize = 0;

    {
        const juce::ScopedLock sl(writerLock);
        auto it = activeRecordings.find(trackId);
        if (it == activeRecordings.end() || !it->second.isActive.load())
            return peakData;

        numChannels = std::min(it->second.numChannels, ActiveRecording::PEAK_MAX_CHANNELS);
        tablePtr    = it->second.peakTable.get();
        tableSize   = it->second.peakTableSize.load(std::memory_order_acquire);
    }
    // Lock released — read is lock-free (stable pointer, atomic size).
    // getRecordingPeaks() and stopAllRecordings() both run on the message thread
    // so they are never concurrent — no use-after-free risk.

    if (numChannels == 0 || !tablePtr || tableSize == 0 || samplesPerPixel <= 0 || numPixels <= 0)
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
    const int maxPixelsFromData = static_cast<int>(totalSamplesCovered / samplesPerPixel);
    const int actualPeaks = std::min(numPixels, maxPixelsFromData);

    if (actualPeaks <= 0)
        return peakData;

    peakData.ensureStorageAllocated(1 + actualPeaks * numChannels * 2);
    peakData.add(juce::var(numChannels));

    for (int pixel = 0; pixel < actualPeaks; ++pixel)
    {
        // Map pixel range to sample range, then to peak table entry range
        const double pixelStartSample = pixel * static_cast<double>(samplesPerPixel);
        const double pixelEndSample = pixelStartSample + samplesPerPixel;
        const size_t firstEntry = static_cast<size_t>(pixelStartSample / stride);
        const size_t lastEntry = std::min(static_cast<size_t>(pixelEndSample / stride) + 1,
                                          tableSize);

        for (int ch = 0; ch < numChannels; ++ch)
        {
            float minVal = 0.0f, maxVal = 0.0f;
            for (size_t e = firstEntry; e < lastEntry; ++e)
            {
                const float* entry = tablePtr + e * static_cast<size_t>(numChannels * 2);
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
