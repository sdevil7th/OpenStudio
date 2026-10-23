#pragma once

#include <juce_core/juce_core.h>
#include <array>
#include <atomic>
#include <cstddef>
#include <memory>
#include <vector>

// A same-block executor, not an audio graph. The caller owns every job/context
// until isIdle() returns true, including after a missed deadline. Control-side
// prepare/drain/stop must be serialised against runBatch by the host.
class RealtimeTrackExecutor final
{
public:
    enum class State : unsigned char { idle, ready, running, done, cancelled };
    struct Job
    {
        void* context = nullptr;
        void (*run)(void*) noexcept = nullptr;
        std::atomic<State> state { State::idle };
    };
    struct Stats
    {
        std::uint64_t batches = 0, completedBatches = 0, deadlineMisses = 0;
        std::uint64_t completedLateBatches = 0, hardDeadlineMisses = 0;
        std::uint64_t rejectedBatches = 0, callbackJobs = 0, workerJobs = 0;
        std::uint64_t cancelledJobs = 0, workerWakeups = 0;
        std::uint64_t workerSpinBatches = 0, workerEventSignals = 0;
        int workers = 0, mmcssRegisteredWorkers = 0, mmcssPriorityWorkers = 0;
        int workerSpinMicroseconds = 0;
        int claimCursor = 0, publishedJobCount = 0;
    };

    static constexpr int maximumWorkerCount = 127;
    static constexpr int maximumJobCount = 4096;
    static constexpr int maximumWorkerSpinMicroseconds = 2000;
    static constexpr int maximumLateCompletionMicroseconds = 2000;
    RealtimeTrackExecutor();
    ~RealtimeTrackExecutor();
    RealtimeTrackExecutor(const RealtimeTrackExecutor&) = delete;
    RealtimeTrackExecutor& operator=(const RealtimeTrackExecutor&) = delete;

    static int recommendedWorkerCount() noexcept;
    bool prepare(int workerCount = -1); // Control thread; zero selects serial execution.
    void drain();                    // Control thread; host must stop dispatch first.
    void stop();                     // Control thread; drains, then joins workers.
    int getWorkerCount() const noexcept;
    // Opt-in bounded polling between active batches. Zero retains event sleep.
    // Configure on the control thread; this setting survives prepare/stop.
    bool setWorkerSpinMicroseconds(int microseconds) noexcept;
    int getWorkerSpinMicroseconds() const noexcept;

    // cutoffTicks is an absolute juce::Time::getHighResolutionTicks() deadline,
    // with the caller's output/reduction reserve already subtracted. The wait
    // is bounded, but a claimed run() must itself finish: native DSP cannot be
    // preempted safely, including the job performed by the callback thread.
    // Optional recovery may continue up to hardCutoffTicks (at most 2ms beyond
    // nominal). Zero uses cutoffTicks. Late completion still returns false and
    // records a nominal deadline miss; this never increases promised capacity.
    bool runBatch(Job* jobs, int count, juce::int64 cutoffTicks,
                  juce::int64 hardCutoffTicks = 0) noexcept;
    // Nonblocking acknowledgement. True also proves no worker is still
    // searching this batch or touching its job/context after run() returned.
    bool isIdle() noexcept;
    Stats snapshotStats() const noexcept;
    juce::var getDiagnosticState() const; // Allocates; control/UI thread only.

private:
    class Worker;
    void processPublishedBatch(int workerIndex) noexcept;
    bool executeNext(Job* jobs, bool worker) noexcept;
    void cancelUnclaimed(Job* jobs, int count) noexcept;

    std::vector<std::unique_ptr<Worker>> workers;
    std::atomic<int> configuredWorkers { 0 };
    std::atomic<bool> accepting { false };
    // Separate independently written groups by at least a common cache line,
    // without imposing over-alignment/padding requirements on AudioEngine.
    // This is an optimisation only; ordering does not rely on line size.
    std::atomic<Job*> publishedJobs { nullptr };
    std::atomic<std::uint64_t> publishedGeneration { 0 };
    std::atomic<int> publishedActiveWorkers { 0 };
    std::atomic<int> workerSpinMicroseconds { 0 };
    std::atomic<int> publishedCount { 0 };
    std::atomic<juce::int64> deadline { 0 };
    std::array<std::byte, 64> publicationPadding {};
    std::atomic<int> nextJob { 0 };
    std::array<std::byte, 64> claimPadding {};
    std::atomic<int> remainingJobs { 0 };
    std::array<std::byte, 64> completionPadding {};
    // Low bit admits worker readers; each active reader contributes two.
    // Closing admission makes retirement acknowledgement stable until publish.
    std::atomic<unsigned> workerReaderGate { 0 };
    std::array<std::byte, 64> readerPadding {};
    std::atomic<std::uint64_t> batches { 0 }, completedBatches { 0 }, deadlineMisses { 0 };
    std::atomic<std::uint64_t> completedLateBatches { 0 }, hardDeadlineMisses { 0 };
    std::atomic<std::uint64_t> rejectedBatches { 0 }, callbackJobs { 0 }, workerJobs { 0 };
    std::atomic<std::uint64_t> cancelledJobs { 0 }, workerWakeups { 0 };
    std::atomic<std::uint64_t> workerSpinBatches { 0 }, workerEventSignals { 0 };
    std::atomic<int> mmcssRegisteredWorkers { 0 }, mmcssPriorityWorkers { 0 };
};
