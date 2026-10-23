#pragma once

#include <JuceHeader.h>
#include <array>
#include <memory>
#include <map>
#include <functional>
#include "RecordingWriterSafety.h"

// Handles recording audio to disk for individual tracks.
// Uses JUCE's ThreadedWriter to move disk I/O off the audio thread,
// preventing crackling and buffer underruns.
class AudioRecorder
{
public:
    explicit AudioRecorder(const juce::File& recoveryRoot = RecoveryJournal::defaultRoot());
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
    juce::var takeWriteFailures(); // Control thread; one notification per failed take.

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

    // Control-thread maintenance is independent of preview visibility/polling.
    void maintainRecordingPreviews();
    static constexpr int recordingPeakStride = 256;
    static constexpr int maximumRecordingPeakPixels = 8192;
    static constexpr size_t maximumRecordingPeakEntriesPerRequest = 262144;

    // Get waveform peaks for a recording currently in progress
    // Returns a bounded prefix of complete published pixels at the requested
    // resolution. Readers retain preview storage across stop and rollover.
    juce::var getRecordingPeaks(const juce::String& trackId,
                                int samplesPerPixel,
                                int numPixels,
                                juce::int64 startSample = 0);

private:
    struct RecordingPreview
    {
        RecordingPreview(double rate, int channels);
        const double sampleRate;
        const int numChannels;
        const size_t peakChunkEntries;
        std::atomic<bool> active { true };
        static constexpr int PEAK_MAX_CHANNELS = 2;
        static constexpr int PEAK_CHUNK_SECONDS = 120;
        static constexpr size_t PEAK_MAX_CHUNKS = 120; // Four hours of preview.
        std::array<std::unique_ptr<float[]>, PEAK_MAX_CHUNKS> peakChunks;
        std::array<std::atomic<float*>, PEAK_MAX_CHUNKS> peakChunkPtrs {};
        std::atomic<size_t> peakAllocatedChunks { 0 };
        // Absolute completed-bucket index, including unavailable preview gaps.
        // Each published bucket is immutable; readers acquire this size first.
        std::atomic<size_t> peakTableSize { 0 };
        juce::CriticalSection growthLock; // Preview/control threads only.
    };
    static void growRecordingPreview(const std::shared_ptr<RecordingPreview>& preview);

    struct ActiveRecording
    {
        juce::String trackId;
        std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> threadedWriter;
        std::shared_ptr<RecordingWriteStatus> writeStatus;
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

        std::shared_ptr<RecordingPreview> preview;

        // Accumulator — audio thread only (never touched from message thread)
        float accumMin[RecordingPreview::PEAK_MAX_CHANNELS] { 0.0f, 0.0f };
        float accumMax[RecordingPreview::PEAK_MAX_CHANNELS] { 0.0f, 0.0f };
        int   accumCount = 0;
    };

    std::map<juce::String, ActiveRecording> activeRecordings;
    // Neither preview nor status polling ever acquires writerLock. Shared
    // preview ownership keeps immutable published buckets alive for readers.
    std::map<juce::String, std::shared_ptr<RecordingPreview>> recordingPreviews;
    juce::CriticalSection previewRegistryLock;
    juce::CriticalSection statusLock;
    juce::CriticalSection controlLock; // Serializes start/stop/rollover publication.
    std::vector<std::shared_ptr<RecordingWriteStatus>> pendingWriteStatuses;
    bool startRecordingInternal(const juce::String& trackId,
                                const juce::File& file,
                                double sampleRate,
                                int numChannels,
                                double initialStartTime,
                                CompletedRecording* replacedTake);
    juce::WavAudioFormat wavFormat;
    RecoveryJournal recoveryJournal;
    mutable juce::CriticalSection writerLock;  // Protects activeRecordings map structure

    // Background thread for disk I/O (shared by all recordings)
    juce::TimeSliceThread writerThread { "AudioRecorder-DiskIO" };
    std::atomic<int> writeLockMissCount { 0 };
    std::atomic<int> writerBufferOverflowCount { 0 };

    friend void runRecordingRecoveryRegression(const juce::File&,
        const std::function<void(const char*, bool)>&);
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioRecorder)
};
