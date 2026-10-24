#pragma once
#include "RealtimeTrackExecutor.h"
#include <array>
#include <thread>

// Explicit offline executor contracts. No audio device, app graph, settings,
// model files or physical input/output are involved.
inline juce::var runRealtimeTrackExecutorRegression()
{
    juce::Array<juce::var> checks;
    bool passed = true;
    const auto check = [&] (const char* name, bool success, const char* detail)
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("name", name);
        result->setProperty("pass", success);
        result->setProperty("detail", detail);
        checks.add(result);
        passed = passed && success;
    };
    const auto cutoffAfter = [] (double seconds)
    {
        return juce::Time::getHighResolutionTicks()
            + static_cast<juce::int64>(seconds * static_cast<double>(juce::Time::getHighResolutionTicksPerSecond()));
    };
    struct CountContext
    {
        std::atomic<int> calls { 0 }, active { 0 };
        std::atomic<bool> overlap { false };
        std::uint64_t output = 0;
        static void process(void* pointer) noexcept
        {
            auto& context = *static_cast<CountContext*>(pointer);
            if (context.active.fetch_add(1) != 0) context.overlap.store(true);
            std::uint64_t value = 17;
            for (int index = 0; index < 400; ++index) value = value * 1664525u + 1013904223u;
            context.output = value;
            context.calls.fetch_add(1);
            context.active.fetch_sub(1);
        }
    };
    constexpr int maximumJobs = 31;
    std::array<CountContext, maximumJobs> contexts;
    std::array<RealtimeTrackExecutor::Job, maximumJobs> jobs;
    bool exactlyOnce = true, outputPublished = true, idleAfterReturn = true;
    juce::Array<juce::var> configurations;
    for (const int spinMicroseconds : { 0, 1000 })
    for (const int workerCount : { 0, 1, 3 })
    {
        RealtimeTrackExecutor executor;
        const bool prepared = executor.setWorkerSpinMicroseconds(spinMicroseconds)
            && executor.prepare(workerCount);
        exactlyOnce = exactlyOnce && prepared && executor.getWorkerCount() == workerCount;
        if (!prepared) continue;
        for (const int count : { 1, 2, 4, 16, maximumJobs })
            for (int repeat = 0; repeat < 16; ++repeat)
            {
                // Exercise both consecutive publications and the transition
                // back to event sleep after bounded polling has expired.
                if (repeat == 8) juce::Thread::sleep(5);
                for (int index = 0; index < count; ++index)
                {
                    contexts[static_cast<size_t>(index)].calls.store(0);
                    contexts[static_cast<size_t>(index)].output = 0;
                    jobs[static_cast<size_t>(index)].context = &contexts[static_cast<size_t>(index)];
                    jobs[static_cast<size_t>(index)].run = CountContext::process;
                }
                const bool completed = executor.runBatch(jobs.data(), count, cutoffAfter(1));
                executor.drain();
                exactlyOnce = exactlyOnce && completed;
                idleAfterReturn = idleAfterReturn && executor.isIdle();
                for (int index = 0; index < count; ++index)
                {
                    const auto& context = contexts[static_cast<size_t>(index)];
                    exactlyOnce = exactlyOnce && context.calls.load() == 1
                        && context.active.load() == 0 && !context.overlap.load()
                        && jobs[static_cast<size_t>(index)].state.load() == RealtimeTrackExecutor::State::done;
                    outputPublished = outputPublished && context.output != 0
                        && context.output == contexts[0].output;
                }
            }
        configurations.add(executor.getDiagnosticState());
        executor.stop();
        idleAfterReturn = idleAfterReturn && executor.isIdle() && executor.getWorkerCount() == 0;
    }
    check("exactly_once_serial_parallel", exactlyOnce, "0/1/3 workers with event-only and 1000us bounded polling; 1/2/4/16/31 jobs across 16 batch reuses including sleep/wake transitions; no duplicate invocation.");
    check("output_and_completion_publication", outputPublished && idleAfterReturn, "Successful batches publish complete output and return ownership only after worker readers drain.");

    RealtimeTrackExecutor serial;
    const bool spinConfiguration = serial.getWorkerSpinMicroseconds() == 0
        && !serial.setWorkerSpinMicroseconds(-1)
        && !serial.setWorkerSpinMicroseconds(RealtimeTrackExecutor::maximumWorkerSpinMicroseconds + 1)
        && serial.setWorkerSpinMicroseconds(RealtimeTrackExecutor::maximumWorkerSpinMicroseconds)
        && serial.getWorkerSpinMicroseconds() == RealtimeTrackExecutor::maximumWorkerSpinMicroseconds
        && serial.setWorkerSpinMicroseconds(0);
    check("bounded_poll_configuration", spinConfiguration,
        "Event sleep is the default; only 0..2000us bounded active polling is accepted.");
    bool prepared = serial.prepare(0);
    std::array<RealtimeTrackExecutor::Job, 4> cancelled;
    CountContext cancelledContext;
    for (auto& job : cancelled) { job.context = &cancelledContext; job.run = CountContext::process; }
    const bool timeout = !serial.runBatch(cancelled.data(), static_cast<int>(cancelled.size()), cutoffAfter(-1));
    bool allCancelled = true;
    for (const auto& job : cancelled) allCancelled = allCancelled && job.state.load() == RealtimeTrackExecutor::State::cancelled;
    check("expired_batch_never_runs", prepared && timeout && allCancelled && serial.isIdle() && cancelledContext.calls.load() == 0,
        "An already-expired batch cancels every unclaimed job without invoking a processor.");
    RealtimeTrackExecutor::Job invalid;
    const bool invalidRejected = !serial.runBatch(&invalid, 1, cutoffAfter(1))
        && invalid.state.load() == RealtimeTrackExecutor::State::idle
        && !serial.runBatch(&invalid, RealtimeTrackExecutor::maximumJobCount + 1, cutoffAfter(1));
    check("invalid_and_empty_batches", invalidRejected && serial.runBatch(nullptr, 0, cutoffAfter(1)) && serial.isIdle(),
        "Invalid job functions are rejected before publication; empty batches are valid no-ops.");

    RealtimeTrackExecutor graceExecutor;
    const bool gracePrepared = graceExecutor.prepare(0);
    CountContext graceContext;
    RealtimeTrackExecutor::Job graceJob;
    graceJob.context = &graceContext;
    graceJob.run = CountContext::process;
    const auto nominalCutoff = juce::Time::getHighResolutionTicks() - 1;
    const auto graceTicks = juce::Time::getHighResolutionTicksPerSecond()
        * RealtimeTrackExecutor::maximumLateCompletionMicroseconds / 1000000;
    const bool graceReportedLate = !graceExecutor.runBatch(&graceJob, 1, nominalCutoff, nominalCutoff + graceTicks);
    const auto graceStats = graceExecutor.snapshotStats();
    check("bounded_late_completion_is_still_a_miss", gracePrepared && graceReportedLate
        && graceContext.calls.load() == 1 && graceJob.state.load() == RealtimeTrackExecutor::State::done
        && graceExecutor.isIdle() && graceStats.deadlineMisses == 1 && graceStats.completedLateBatches == 1
        && graceStats.completedBatches == 0 && graceStats.hardDeadlineMisses == 0 && graceStats.cancelledJobs == 0,
        "Explicit bounded recovery can finish an already-late job, while return value and nominal deadline diagnostics still report failure.");
    const auto validNominal = cutoffAfter(1);
    const bool invalidGraceRejected = !graceExecutor.runBatch(&graceJob, 1, validNominal, validNominal - 1)
        && !graceExecutor.runBatch(&graceJob, 1, validNominal, validNominal + graceTicks + 1)
        && graceExecutor.snapshotStats().batches == 1 && graceContext.calls.load() == 1;
    check("late_completion_limit_rejects_invalid_cutoffs", invalidGraceRejected,
        "A hard cutoff before nominal or more than 2000us after nominal is rejected before publishing jobs.");

    struct LateContext
    {
        std::thread::id callbackThread;
        std::atomic<bool> entered { false }, release { false };
        std::atomic<int> workerGuards { 0 }, workerGuardDestructions { 0 }, calls { 0 };
        juce::int64 coordinationLimit = 0;
        static void process(void* pointer) noexcept
        {
            auto& context = *static_cast<LateContext*>(pointer);
            context.calls.fetch_add(1);
            if (std::this_thread::get_id() == context.callbackThread)
            {
                // Fault fixture only: let the persistent helper claim its job
                // before the callback finishes all remaining cheap jobs.
                while (!context.entered.load() && juce::Time::getHighResolutionTicks() < context.coordinationLimit)
                    std::this_thread::yield();
                return;
            }
            struct Guard
            {
                LateContext& context;
                explicit Guard(LateContext& c) : context(c) { context.workerGuards.fetch_add(1); }
                ~Guard() { context.workerGuardDestructions.fetch_add(1); context.workerGuards.fetch_sub(1); }
            } guard(context);
            context.entered.store(true);
            while (!context.release.load()) juce::Thread::sleep(1);
        }
    };
    bool lateOwnershipPassed = true, drainPassed = true, exhaustedQueuePassed = true, hardCutoffPassed = true;
    juce::Array<juce::var> lateWorkerStats;
    for (const int spinMicroseconds : { 0, 1000 })
    for (const int recoveryMicroseconds : { 0, 1000 })
    {
    LateContext late;
    RealtimeTrackExecutor delayed;
    prepared = delayed.setWorkerSpinMicroseconds(spinMicroseconds) && delayed.prepare(1);
    late.callbackThread = std::this_thread::get_id();
    late.coordinationLimit = cutoffAfter(.25);
    std::array<RealtimeTrackExecutor::Job, 4> delayedJobs;
    for (auto& job : delayedJobs) { job.context = &late; job.run = LateContext::process; }
    const auto delayedNominal = cutoffAfter(.05);
    const auto delayedHardCutoff = recoveryMicroseconds == 0 ? 0 : delayedNominal
        + juce::Time::getHighResolutionTicksPerSecond() * recoveryMicroseconds / 1000000;
    const bool delayedMiss = !delayed.runBatch(delayedJobs.data(), static_cast<int>(delayedJobs.size()),
        delayedNominal, delayedHardCutoff);
    const auto delayedStats = delayed.snapshotStats();
    hardCutoffPassed = hardCutoffPassed && delayedStats.deadlineMisses == 1
        && delayedStats.hardDeadlineMisses == 1 && delayedStats.completedLateBatches == 0;
    exhaustedQueuePassed = exhaustedQueuePassed
        && delayedStats.claimCursor <= static_cast<int>(delayedJobs.size()) + delayed.getWorkerCount();
    RealtimeTrackExecutor::Job rejected;
    CountContext rejectedContext;
    rejected.context = &rejectedContext; rejected.run = CountContext::process;
    const bool busyRejected = late.entered.load() && !delayed.isIdle()
        && !delayed.runBatch(&rejected, 1, cutoffAfter(1))
        && rejected.state.load() == RealtimeTrackExecutor::State::idle && rejectedContext.calls.load() == 0;
    const bool runningGuardRetained = late.workerGuards.load() == 1 && late.workerGuardDestructions.load() == 0;
    std::atomic<bool> drainFinished { false };
    std::thread drainer([&] { delayed.drain(); drainFinished.store(true); });
    juce::Thread::sleep(5);
    const bool drainWaited = !drainFinished.load();
    late.release.store(true);
    drainer.join();
    const bool terminalCompletion = delayed.isIdle() && late.workerGuards.load() == 0
        && late.workerGuardDestructions.load() == 1 && drainFinished.load();
    const bool reusable = delayed.runBatch(&rejected, 1, cutoffAfter(1)) && rejectedContext.calls.load() == 1 && delayed.isIdle();
    lateOwnershipPassed = lateOwnershipPassed && prepared && delayedMiss && busyRejected && runningGuardRetained;
    drainPassed = drainPassed && drainWaited && terminalCompletion && reusable;
    lateWorkerStats.add(delayed.getDiagnosticState());
    }
    check("late_worker_retains_ownership", lateOwnershipPassed,
        "In both wake modes, a claimed late job cannot be cancelled or have its storage reused by a new batch.");
    check("control_drain_waits_for_guard_destruction", drainPassed,
        "In both wake modes, control-side drain waits for late worker/guard completion before the next batch becomes legal.");
    check("exhausted_queue_stops_claiming", exhaustedQueuePassed,
        "Waiting for a deliberately late job does not keep advancing the exhausted claim cursor; at most one racing claim per helper is allowed.");
    check("hard_cutoff_does_not_wait_for_blocked_worker", hardCutoffPassed && lateOwnershipPassed,
        "Default and explicit recovery cutoffs return while the fault-injected worker remains blocked, retain ownership and record both nominal and hard misses.");
    const auto expectedRecommended = juce::jlimit(0, RealtimeTrackExecutor::maximumWorkerCount,
        juce::SystemStats::getNumPhysicalCpus() - 1);
    check("physical_core_scaling", RealtimeTrackExecutor::recommendedWorkerCount() == expectedRecommended,
        "Default helper count equals physical cores minus one; no CPU affinity is asserted. Explicit zero and three-worker configurations are independently covered.");
    auto* result = new juce::DynamicObject();
    result->setProperty("pass", passed);
    result->setProperty("success", passed);
    result->setProperty("overallPass", passed);
    result->setProperty("checks", checks);
    result->setProperty("configurations", configurations);
    result->setProperty("lateWorkerStats", lateWorkerStats);
    result->setProperty("recommendedWorkers", expectedRecommended);
    result->setProperty("scope", "Offline executor ownership/ordering contracts only; native audio capacity and audible quality are not asserted.");
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
