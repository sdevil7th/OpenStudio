#pragma once

#include <JuceHeader.h>
#include <array>
#include <memory>
#include <map>

// Handles recording audio to disk for individual tracks.
// Uses JUCE's ThreadedWriter to move disk I/O off the audio thread,
// preventing crackling and buffer underruns.
class AudioRecorder
{
public:
    AudioRecorder();
    ~AudioRecorder();

    // Start recording for a specific track
    bool startRecording(const juce::String& trackId, const juce::File& file, double sampleRate, int numChannels = 2);

    // Stop recording for a track
    void stopRecording(const juce::String& trackId);

    // Write audio data for a track (audio-thread safe, non-blocking)
    void writeBlock(const juce::String& trackId,
                    const juce::AudioBuffer<float>& buffer,
                    int numSamples,
                    double compensatedBlockStartTimeSeconds = -1.0);

    // Check if a track is currently recording (audio-thread safe)
    bool isRecording(const juce::String& trackId) const;

    // Set the start time for a recording (in seconds)
    void setRecordingStartTime(const juce::String& trackId, double timeInSeconds);
    int getWriteLockMissCount() const { return writeLockMissCount.load(std::memory_order_relaxed); }
    int getWriterBufferOverflowCount() const { return writerBufferOverflowCount.load(std::memory_order_relaxed); }

    // Stop all active recordings and return info about completed clips
    struct CompletedRecording {
        juce::String trackId;
        juce::File file;
        double startTime = 0.0;  // When recording started (in seconds)
        double duration = 0.0;   // Duration in seconds
    };
    bool rolloverRecording(const juce::String& trackId,
                           const juce::File& nextFile,
                           double sampleRate,
                           int numChannels,
                           double nextStartTime,
                           CompletedRecording& completedPreviousTake);
    std::vector<CompletedRecording> stopAllRecordings(double currentSampleRate);

    // Get waveform peaks for a recording currently in progress
    // Returns peaks calculated from buffered samples at the requested resolution
    juce::var getRecordingPeaks(const juce::String& trackId,
                                int samplesPerPixel,
                                int numPixels,
                                juce::int64 startSample = 0);

private:
    struct ActiveRecording
    {
        juce::String trackId;
        std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> threadedWriter;
        juce::File outputFile;
        std::atomic<bool> isActive { false };
        double startTime = 0.0;      // Recording start time in seconds
        std::atomic<juce::int64> samplesWritten { 0 };  // Total samples written
        int numChannels = 2;  // Number of channels being recorded
        double sampleRate = 44100.0;
        bool captureStartOnFirstWrite = true;
        bool hasStartTimeFallback = false;
#if OPENSTUDIO_AUDIO_RECORD_DEBUG
        int debugLoggedBlocks = 0;
#endif

        // Incremental peak table for live waveform display.
        //
        // Instead of storing raw interleaved samples (~46 MB/track for 120 s),
        // the audio thread accumulates min/max over PEAK_STRIDE samples and
        // appends one entry when the stride is complete.  getRecordingPeaks()
        // then reads O(pixels) entries instead of O(total samples).
        //
        // Memory: 120 s × 44100 / 256 ≈ 20 700 entries × 2 ch × 2 values × 4 B ≈ 660 KB/track.
        // SPSC: audio thread writes (atomic size), message thread reads lock-free.
        static constexpr int PEAK_STRIDE = 256;  // Samples per peak entry
        static constexpr int PEAK_MAX_CHANNELS = 2;
        static constexpr int PEAK_CHUNK_SECONDS = 120;
        static constexpr size_t PEAK_MAX_CHUNKS = 120; // Four hours of live preview
        std::array<std::unique_ptr<float[]>, PEAK_MAX_CHUNKS> peakChunks;
        std::array<std::atomic<float*>, PEAK_MAX_CHUNKS> peakChunkPtrs {};
        std::atomic<size_t> peakAllocatedChunks { 0 };
        size_t peakChunkEntries = 0;
        std::unique_ptr<float[]> peakTable;      // [min_ch0, max_ch0, min_ch1, max_ch1] × N
        std::atomic<size_t>      peakTableSize { 0 };  // Completed entries (atomic)
        size_t                   peakTableCapacity = 0;

        // Accumulator — audio thread only (never touched from message thread)
        float accumMin[PEAK_MAX_CHANNELS] { 0.0f, 0.0f };
        float accumMax[PEAK_MAX_CHANNELS] { 0.0f, 0.0f };
        int   accumCount = 0;
    };

    std::map<juce::String, ActiveRecording> activeRecordings;
    bool startRecordingInternal(const juce::String& trackId,
                                const juce::File& file,
                                double sampleRate,
                                int numChannels,
                                double initialStartTime,
                                CompletedRecording* replacedTake);
    juce::WavAudioFormat wavFormat;
    mutable juce::CriticalSection writerLock;  // Protects activeRecordings map structure

    // Background thread for disk I/O (shared by all recordings)
    juce::TimeSliceThread writerThread { "AudioRecorder-DiskIO" };
    std::atomic<int> writeLockMissCount { 0 };
    std::atomic<int> writerBufferOverflowCount { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioRecorder)
};
