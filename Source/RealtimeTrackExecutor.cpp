#include "RealtimeTrackExecutor.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <limits>
#if JUCE_WINDOWS
 #include <windows.h>
 #include <avrt.h>
#endif

namespace
{
void relaxExecutorPoll() noexcept
{
   #if JUCE_INTEL && JUCE_WINDOWS
    YieldProcessor();
   #elif JUCE_INTEL
    __builtin_ia32_pause();
   #else
    std::atomic_signal_fence(std::memory_order_seq_cst);
   #endif
}
}

class RealtimeTrackExecutor::Worker final : public juce::Thread
{
public:
    Worker(RealtimeTrackExecutor& executor, int index)
        : juce::Thread("Track audio worker " + juce::String(index)), owner(executor), workerIndex(index) {}

    void run() override
    {
       #if JUCE_WINDOWS
        DWORD taskIndex = 0;
        const HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
        const bool prioritySet = mmcss != nullptr && AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_HIGH) != FALSE;
        if (mmcss != nullptr) owner.mmcssRegisteredWorkers.fetch_add(1, std::memory_order_relaxed);
        if (prioritySet) owner.mmcssPriorityWorkers.fetch_add(1, std::memory_order_relaxed);
       #endif
        juce::ScopedNoDenormals noDenormals;
        auto observedGeneration = owner.publishedGeneration.load(std::memory_order_seq_cst);
        juce::int64 spinUntil = 0;
        bool wokeFromEvent = false;
        awake.store(true, std::memory_order_seq_cst);
        started.signal();
        while (! threadShouldExit())
        {
            const auto generation = owner.publishedGeneration.load(std::memory_order_seq_cst);
            if (generation != observedGeneration)
            {
                observedGeneration = generation;
                if (workerIndex >= owner.publishedActiveWorkers.load(std::memory_order_relaxed))
                {
                    // A smaller next batch must put surplus helpers back to
                    // sleep, not keep every previously active core polling.
                    spinUntil = 0;
                    continue;
                }
                if (!wokeFromEvent) owner.workerSpinBatches.fetch_add(1, std::memory_order_relaxed);
                wokeFromEvent = false;
                owner.processPublishedBatch(workerIndex);
                const int spinMicroseconds = owner.getWorkerSpinMicroseconds();
                spinUntil = spinMicroseconds > 0
                    ? juce::Time::getHighResolutionTicks()
                        + static_cast<juce::int64>(spinMicroseconds)
                            * juce::Time::getHighResolutionTicksPerSecond() / 1000000
                    : 0;
                continue;
            }
            if (spinUntil != 0 && juce::Time::getHighResolutionTicks() < spinUntil)
            {
                relaxExecutorPoll();
                continue;
            }
            // Pair the sleep announcement with a generation recheck. The
            // dispatcher either observes sleeping and signals, or this check
            // observes publication before waiting. Sequential consistency
            // prevents the store/load pair on each thread missing both changes.
            awake.store(false, std::memory_order_seq_cst);
            if (owner.publishedGeneration.load(std::memory_order_seq_cst) != observedGeneration)
            {
                awake.store(true, std::memory_order_seq_cst);
                continue;
            }
            wake.wait();
            awake.store(true, std::memory_order_seq_cst);
            if (threadShouldExit()) break;
            owner.workerWakeups.fetch_add(1, std::memory_order_relaxed);
            wokeFromEvent = true;
            spinUntil = 0;
        }
        awake.store(false, std::memory_order_seq_cst);
       #if JUCE_WINDOWS
        if (prioritySet) owner.mmcssPriorityWorkers.fetch_sub(1, std::memory_order_relaxed);
        if (mmcss != nullptr)
        {
            owner.mmcssRegisteredWorkers.fetch_sub(1, std::memory_order_relaxed);
            AvRevertMmThreadCharacteristics(mmcss);
        }
       #endif
    }

    bool wakeIfSleeping() noexcept
    {
        if (awake.load(std::memory_order_seq_cst)) return false;
        wake.signal();
        return true;
    }

    juce::WaitableEvent wake, started;
private:
    RealtimeTrackExecutor& owner;
    const int workerIndex;
    std::atomic<bool> awake { false };
};

RealtimeTrackExecutor::RealtimeTrackExecutor()
{
    juce::ignoreUnused(publicationPadding, claimPadding, completionPadding, readerPadding);
}
RealtimeTrackExecutor::~RealtimeTrackExecutor() { stop(); }

int RealtimeTrackExecutor::recommendedWorkerCount() noexcept
{
    return juce::jlimit(0, maximumWorkerCount, juce::SystemStats::getNumPhysicalCpus() - 1);
}

bool RealtimeTrackExecutor::prepare(int count)
{
    stop();
    if (count < 0) count = recommendedWorkerCount();
    if (count > maximumWorkerCount) return false;
    workers.reserve(static_cast<size_t>(count));
    for (int index = 0; index < count; ++index)
    {
        auto worker = std::make_unique<Worker>(*this, index);
        if (!worker->startThread(juce::Thread::Priority::highest))
        {
            stop();
            return false;
        }
        workers.push_back(std::move(worker));
        if (!workers.back()->started.wait(5000))
        {
            stop();
            return false;
        }
    }
    configuredWorkers.store(count, std::memory_order_release);
    accepting.store(true, std::memory_order_release);
    return true;
}

void RealtimeTrackExecutor::drain()
{
    while (!isIdle()) juce::Thread::sleep(1);
}

void RealtimeTrackExecutor::stop()
{
    accepting.store(false, std::memory_order_release);
    drain();
    for (auto& worker : workers)
    {
        worker->signalThreadShouldExit();
        worker->wake.signal();
    }
    // Never force-kill a processor-owning worker. The host's jobs must be
    // bounded; any fault-injection latch must be released before destruction.
    for (auto& worker : workers) worker->waitForThreadToExit(-1);
    workers.clear();
    configuredWorkers.store(0, std::memory_order_release);
}

int RealtimeTrackExecutor::getWorkerCount() const noexcept
{
    return configuredWorkers.load(std::memory_order_acquire);
}

bool RealtimeTrackExecutor::setWorkerSpinMicroseconds(int microseconds) noexcept
{
    if (microseconds < 0 || microseconds > maximumWorkerSpinMicroseconds) return false;
    workerSpinMicroseconds.store(microseconds, std::memory_order_release);
    return true;
}

int RealtimeTrackExecutor::getWorkerSpinMicroseconds() const noexcept
{
    return workerSpinMicroseconds.load(std::memory_order_acquire);
}

bool RealtimeTrackExecutor::isIdle() noexcept
{
    if (remainingJobs.load(std::memory_order_acquire) != 0) return false;
    // Close admission before withdrawal. A worker delayed before entry cannot
    // create a fresh empty reader epoch after retirement was acknowledged.
    workerReaderGate.fetch_and(~1u, std::memory_order_acq_rel);
    publishedJobs.store(nullptr, std::memory_order_release);
    return workerReaderGate.load(std::memory_order_acquire) == 0;
}

bool RealtimeTrackExecutor::executeNext(Job* jobs, bool worker) noexcept
{
    const int count = publishedCount.load(std::memory_order_relaxed);
    // Once the queue is exhausted, collection must only read completion.
    // Repeated fetch_add here used to contend with finishing workers for the
    // entire remaining deadline while no further job could possibly run.
    if (nextJob.load(std::memory_order_relaxed) >= count) return false;
    if (juce::Time::getHighResolutionTicks() >= deadline.load(std::memory_order_relaxed)) return false;
    const int index = nextJob.fetch_add(1, std::memory_order_relaxed);
    // A concurrent claimant can consume the last job after the fast check.
    if (index >= count) return false;
    auto& job = jobs[index];
    auto expected = State::ready;
    if (!job.state.compare_exchange_strong(expected, State::running, std::memory_order_acq_rel)) return true;
    job.run(job.context);
    // run() has returned, so all job-scoped guards/destructors have completed.
    // No subsequent code dereferences context or invokes the processor.
    job.state.store(State::done, std::memory_order_release);
    (worker ? workerJobs : callbackJobs).fetch_add(1, std::memory_order_relaxed);
    remainingJobs.fetch_sub(1, std::memory_order_release);
    return true;
}

void RealtimeTrackExecutor::processPublishedBatch(int workerIndex) noexcept
{
    auto gate = workerReaderGate.load(std::memory_order_acquire);
    do
    {
        if ((gate & 1u) == 0) return;
    }
    while (!workerReaderGate.compare_exchange_weak(gate, gate + 2u,
        std::memory_order_acquire, std::memory_order_relaxed));
    // A worker may have been descheduled before entering the gate, across
    // retirement and a newer publication. Recheck this batch's helper limit
    // while pinned, so surplus helpers cannot claim a smaller batch's jobs.
    if (workerIndex < publishedActiveWorkers.load(std::memory_order_relaxed))
        if (auto* jobs = publishedJobs.load(std::memory_order_acquire))
            while (executeNext(jobs, true)) {}
    // This is terminal with respect to batch storage, including Ready scans.
    workerReaderGate.fetch_sub(2u, std::memory_order_release);
}

void RealtimeTrackExecutor::cancelUnclaimed(Job* jobs, int count) noexcept
{
    for (int index = 0; index < count; ++index)
    {
        auto expected = State::ready;
        if (jobs[index].state.compare_exchange_strong(expected, State::cancelled, std::memory_order_acq_rel))
        {
            cancelledJobs.fetch_add(1, std::memory_order_relaxed);
            remainingJobs.fetch_sub(1, std::memory_order_release);
        }
    }
}

bool RealtimeTrackExecutor::runBatch(Job* jobs, int count, juce::int64 cutoffTicks,
                                    juce::int64 hardCutoffTicks) noexcept
{
    if (hardCutoffTicks == 0) hardCutoffTicks = cutoffTicks;
    const auto maximumGraceTicks = juce::Time::getHighResolutionTicksPerSecond()
        * maximumLateCompletionMicroseconds / 1000000;
    const auto maximumTick = (std::numeric_limits<juce::int64>::max)();
    const auto maximumHardCutoff = cutoffTicks > maximumTick - maximumGraceTicks
        ? maximumTick : cutoffTicks + maximumGraceTicks;
    if (!accepting.load(std::memory_order_acquire) || !isIdle()
        || count < 0 || count > maximumJobCount || (count > 0 && jobs == nullptr)
        || hardCutoffTicks < cutoffTicks || hardCutoffTicks > maximumHardCutoff)
    {
        rejectedBatches.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    for (int index = 0; index < count; ++index)
        if (jobs[index].run == nullptr)
        {
            rejectedBatches.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
    if (count == 0) return true;
    for (int index = 0; index < count; ++index) jobs[index].state.store(State::ready, std::memory_order_relaxed);
    publishedCount.store(count, std::memory_order_relaxed);
    nextJob.store(0, std::memory_order_relaxed);
    deadline.store(hardCutoffTicks, std::memory_order_relaxed);
    const int wakeCount = juce::jmin(getWorkerCount(), count - 1);
    publishedActiveWorkers.store(wakeCount, std::memory_order_relaxed);
    remainingJobs.store(count, std::memory_order_release);
    publishedJobs.store(jobs, std::memory_order_release);
    workerReaderGate.store(1u, std::memory_order_release);
    publishedGeneration.fetch_add(1, std::memory_order_seq_cst);
    batches.fetch_add(1, std::memory_order_relaxed);
    for (int index = 0; index < wakeCount; ++index)
        if (workers[static_cast<size_t>(index)]->wakeIfSleeping())
            workerEventSignals.fetch_add(1, std::memory_order_relaxed);
    juce::ScopedNoDenormals noDenormals;
    bool nominalMissRecorded = false;
    const auto recordNominalMiss = [&] (juce::int64 time) noexcept
    {
        if (!nominalMissRecorded && time >= cutoffTicks)
        {
            nominalMissRecorded = true;
            deadlineMisses.fetch_add(1, std::memory_order_relaxed);
        }
    };
    for (;;)
    {
        const auto now = juce::Time::getHighResolutionTicks();
        recordNominalMiss(now);
        if (now >= hardCutoffTicks) break;
        if (remainingJobs.load(std::memory_order_acquire) == 0 && isIdle())
        {
            const auto completedAt = juce::Time::getHighResolutionTicks();
            recordNominalMiss(completedAt);
            if (completedAt < hardCutoffTicks)
            {
                (nominalMissRecorded ? completedLateBatches : completedBatches)
                    .fetch_add(1, std::memory_order_relaxed);
                return !nominalMissRecorded;
            }
            break;
        }
        if (!executeNext(jobs, false)) relaxExecutorPoll();
    }
    cancelUnclaimed(jobs, count);
    hardDeadlineMisses.fetch_add(1, std::memory_order_relaxed);
    // Withdraw completed batches now, but never imply ownership of running jobs.
    (void) isIdle();
    return false;
}

RealtimeTrackExecutor::Stats RealtimeTrackExecutor::snapshotStats() const noexcept
{
    Stats result;
    result.batches = batches.load(std::memory_order_relaxed);
    result.completedBatches = completedBatches.load(std::memory_order_relaxed);
    result.deadlineMisses = deadlineMisses.load(std::memory_order_relaxed);
    result.completedLateBatches = completedLateBatches.load(std::memory_order_relaxed);
    result.hardDeadlineMisses = hardDeadlineMisses.load(std::memory_order_relaxed);
    result.rejectedBatches = rejectedBatches.load(std::memory_order_relaxed);
    result.callbackJobs = callbackJobs.load(std::memory_order_relaxed);
    result.workerJobs = workerJobs.load(std::memory_order_relaxed);
    result.cancelledJobs = cancelledJobs.load(std::memory_order_relaxed);
    result.workerWakeups = workerWakeups.load(std::memory_order_relaxed);
    result.workerSpinBatches = workerSpinBatches.load(std::memory_order_relaxed);
    result.workerEventSignals = workerEventSignals.load(std::memory_order_relaxed);
    result.workerSpinMicroseconds = getWorkerSpinMicroseconds();
    result.claimCursor = nextJob.load(std::memory_order_relaxed);
    result.publishedJobCount = publishedCount.load(std::memory_order_relaxed);
    result.workers = getWorkerCount();
    result.mmcssRegisteredWorkers = mmcssRegisteredWorkers.load(std::memory_order_relaxed);
    result.mmcssPriorityWorkers = mmcssPriorityWorkers.load(std::memory_order_relaxed);
    return result;
}

juce::var RealtimeTrackExecutor::getDiagnosticState() const
{
    const auto stats = snapshotStats();
    auto* result = new juce::DynamicObject();
    result->setProperty("workers", stats.workers);
    result->setProperty("mmcssRegisteredWorkers", stats.mmcssRegisteredWorkers);
    result->setProperty("mmcssPriorityWorkers", stats.mmcssPriorityWorkers);
    result->setProperty("batches", static_cast<juce::int64>(stats.batches));
    result->setProperty("completedBatches", static_cast<juce::int64>(stats.completedBatches));
    result->setProperty("deadlineMisses", static_cast<juce::int64>(stats.deadlineMisses));
    result->setProperty("completedLateBatches", static_cast<juce::int64>(stats.completedLateBatches));
    result->setProperty("hardDeadlineMisses", static_cast<juce::int64>(stats.hardDeadlineMisses));
    result->setProperty("rejectedBatches", static_cast<juce::int64>(stats.rejectedBatches));
    result->setProperty("callbackJobs", static_cast<juce::int64>(stats.callbackJobs));
    result->setProperty("workerJobs", static_cast<juce::int64>(stats.workerJobs));
    result->setProperty("cancelledJobs", static_cast<juce::int64>(stats.cancelledJobs));
    result->setProperty("workerWakeups", static_cast<juce::int64>(stats.workerWakeups));
    result->setProperty("workerSpinBatches", static_cast<juce::int64>(stats.workerSpinBatches));
    result->setProperty("workerEventSignals", static_cast<juce::int64>(stats.workerEventSignals));
    result->setProperty("workerSpinMicroseconds", stats.workerSpinMicroseconds);
    result->setProperty("claimCursor", stats.claimCursor);
    result->setProperty("publishedJobCount", stats.publishedJobCount);
    result->setProperty("wakeStrategy", stats.workerSpinMicroseconds > 0
        ? "bounded-active-poll-then-event" : "persistent-auto-reset-event");
    return result;
}
