#pragma once

#include <JuceHeader.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>

/**
 * Real-time-safe input pitch tracker used by the NAM Rack tuner.
 *
 * The audio callback only selects one input channel and copies it into a
 * preallocated SPSC FIFO.  Downsampling, pitch detection, temporal tracking,
 * and display averaging all run on the worker thread.
 */
class TunerPitchTracker final : private juce::Thread
{
public:
    enum class State : std::uint8_t
    {
        idle = 0,
        acquiring,
        tracking,
        holding
    };

    struct Snapshot
    {
        bool enabled = false;
        bool signalPresent = false;
        bool pitchLocked = false;
        State state = State::idle;

        float instantaneousFrequencyHz = 0.0f;
        float averageFrequencyHz = 0.0f;
        float instantaneousCents = 0.0f;
        float averageCents = 0.0f;
        float varianceCents = 0.0f;
        float confidence = 0.0f;
        float inputLevelDb = -120.0f;

        int midiNote = -1;
        int selectedChannel = -1;

        std::uint64_t pitchUpdateCounter = 0;
        std::uint64_t analysisFrameCounter = 0;
        std::uint32_t droppedFifoSamples = 0;
        double ageMs = 0.0;
    };

    TunerPitchTracker();
    ~TunerPitchTracker() override;

    void prepare(double sourceSampleRate, int maximumBlockSize);
    void setEnabled(bool shouldBeEnabled) noexcept;
    [[nodiscard]] bool isEnabled() const noexcept;
    [[nodiscard]] std::uint32_t
        resetForRouteChange() noexcept;
    [[nodiscard]] std::uint32_t
        getGenerationToken() const noexcept;

    /**
     * Audio-thread producer entry point.  This method does not allocate, lock,
     * wait, log, or perform pitch analysis.
     */
    void pushAudio(const float* const* channels,
                   int numChannels,
                   int numSamples,
                   std::uint32_t expectedGeneration = 0) noexcept;
    void pushSilence(
        int numSamples,
        std::uint32_t expectedGeneration = 0) noexcept;

    [[nodiscard]] Snapshot getSnapshot() const noexcept;

    /**
     * Deterministic synchronous mode for native regression probes.  It drives
     * the same downsampler, detector, state machine, and averaging code as the
     * worker without sleeping or depending on wall-clock time.
     */
    void prepareForTesting(double sourceSampleRate);
    void processAudioForTesting(const float* const* channels,
                                int numChannels,
                                int numSamples) noexcept;
    void processMonoForTesting(const float* samples,
                               int numSamples) noexcept;

private:
    class AnalysisCore;

    static constexpr std::uint32_t fifoCapacity = 1u << 18;
    static constexpr std::uint32_t fifoMask = fifoCapacity - 1u;
    static constexpr int workerScratchCapacity = 4096;

    struct FifoSample
    {
        float value = 0.0f;
        std::uint32_t generation = 0;
    };

    struct PublishedState
    {
        std::atomic<std::uint32_t> sequence { 0 };
        std::atomic<std::uint32_t> generation { 0 };
        std::atomic<int> state {
            static_cast<int>(State::idle)
        };
        std::atomic<bool> signalPresent { false };
        std::atomic<bool> pitchLocked { false };
        std::atomic<float> instantaneousFrequencyHz { 0.0f };
        std::atomic<float> averageFrequencyHz { 0.0f };
        std::atomic<float> instantaneousCents { 0.0f };
        std::atomic<float> averageCents { 0.0f };
        std::atomic<float> varianceCents { 0.0f };
        std::atomic<float> confidence { 0.0f };
        std::atomic<float> inputLevelDb { -120.0f };
        std::atomic<int> midiNote { -1 };
        std::atomic<int> selectedChannel { -1 };
        std::atomic<std::uint64_t> pitchUpdateCounter { 0 };
        std::atomic<std::uint64_t> analysisFrameCounter { 0 };
        std::atomic<std::uint32_t> droppedFifoSamples { 0 };
        std::atomic<double> ageMs { 0.0 };
    };

    void run() override;
    void stopWorker() noexcept;
    void publishSnapshot(const Snapshot& snapshot,
                         std::uint32_t generation) noexcept;
    void resetProducerSelection() noexcept;
    int chooseStrongestChannel(const float* const* channels,
                               int numChannels,
                               int numSamples) noexcept;
    void writeToFifo(const float* source,
                     int numSamples,
                     std::uint32_t generation) noexcept;

    std::unique_ptr<std::array<FifoSample, fifoCapacity>> fifo;
    std::array<float, workerScratchCapacity> workerScratch {};
    std::atomic<std::uint32_t> fifoReadCounter { 0 };
    std::atomic<std::uint32_t> fifoWriteCounter { 0 };
    std::atomic<std::uint32_t> droppedFifoSamples { 0 };
    std::atomic<bool> producerOverflowed { false };
    std::atomic<std::uint32_t> routeGeneration { 1 };
    std::atomic<bool> enabled { false };
    std::atomic<bool> testingMode { false };
    std::atomic<int> selectedChannel { -1 };

    int producerSelectedChannel = -1;
    std::uint32_t producerGeneration = 0;
    double preparedSampleRate = 48000.0;
    int preparedMaximumBlockSize = 512;
    std::uint32_t maximumQueuedSamples = 12000;

    std::unique_ptr<AnalysisCore> analysisCore;
    PublishedState published;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TunerPitchTracker)
};
