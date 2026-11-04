#include "RealtimeCallbackTraceRegression.h"
#include "RealtimeCallbackTrace.h"
#include <thread>
#include <vector>

namespace
{
RealtimeCallbackTraceEvent fixture(std::uint64_t counter)
{
    RealtimeCallbackTraceEvent event;
    event.callbackCounter = counter;
    event.startSamplePosition = static_cast<std::int64_t>(counter * 8);
    event.startWallTimeMs = static_cast<double>(counter) / 6.0;
    event.measuredWallMs = 0.125;
    event.budgetMs = 8.0 / 48.0;
    event.sampleRate = 48000.0;
    event.stageMs = { 0.025, 0.05, 0.01, 0.015, 0.025 };
    event.blockSize = 8;
    event.threadId = counter + 100;
    event.threadCycleDelta = counter * 19;
    event.processorNumberStart = static_cast<std::uint32_t>(counter % 16);
    event.processorNumberEnd = event.processorNumberStart;
    event.playing = true;
    event.recording = (counter & 1) != 0;
    event.stageTimingsAvailable = true;
    event.processorIdsAvailable = true;
    event.threadCyclesRequested = true;
    event.threadCyclesValid = true;
    return event;
}
bool coherent(const RealtimeCallbackTraceEvent& event)
{
    const auto expected = fixture(event.callbackCounter);
    return event.startSamplePosition == expected.startSamplePosition
        && event.startWallTimeMs == expected.startWallTimeMs
        && event.measuredWallMs == expected.measuredWallMs && event.budgetMs == expected.budgetMs
        && event.sampleRate == expected.sampleRate && event.stageMs == expected.stageMs
        && event.blockSize == 8 && event.threadId == expected.threadId
        && event.threadCycleDelta == expected.threadCycleDelta
        && event.processorNumberStart == expected.processorNumberStart
        && event.processorNumberEnd == expected.processorNumberEnd
        && event.playing && event.recording == expected.recording && event.stageTimingsAvailable
        && event.processorIdsAvailable && event.threadCyclesRequested && event.threadCyclesValid;
}
}

void runRealtimeCallbackTraceRegression(const std::function<void(const char*, bool)>& check)
{
    RealtimeCallbackTraceQueue<8> queue;
    const bool defaultOff = !queue.getStats().enabled && !queue.tryPush(fixture(16))
        && !queue.shouldCapture(queue.getOptions(), 16, 16) && queue.getStats().published == 0;
    check("callback_trace_default_disabled_without_publication", defaultOff);
    queue.setEnabled(true, true);
    bool exact = true;
    for (std::uint64_t counter = 1; counter <= 8; ++counter) exact &= queue.tryPush(fixture(counter));
    const bool fullDrops = !queue.tryPush(fixture(9)) && queue.getStats().droppedFull == 1;
    std::array<RealtimeCallbackTraceEvent, 8> batch;
    auto count = queue.drain(batch.data(), batch.size());
    exact &= count == 8;
    for (std::size_t index = 0; index < count; ++index)
        exact &= coherent(batch[index]) && batch[index].callbackCounter == index + 1;
    check("callback_trace_full_drops_without_overwriting_unread_payloads", fullDrops && exact);

    bool wraps = true;
    for (std::uint64_t group = 1; group <= 100; ++group)
    {
        for (std::uint64_t index = 0; index < 5; ++index) wraps &= queue.tryPush(fixture(group * 16 + index));
        count = queue.drain(batch.data(), batch.size());
        wraps &= count == 5;
        for (std::size_t index = 0; index < count; ++index)
            wraps &= coherent(batch[index]) && batch[index].callbackCounter == group * 16 + index;
    }
    check("callback_trace_wraparound_preserves_sequence_and_paired_fields", wraps && queue.getStats().pending == 0);
    queue.tryPush(fixture(1234));
    queue.setEnabled(false);
    const bool disabled = !queue.tryPush(fixture(1235)) && queue.drain(batch.data(), batch.size()) == 1
        && coherent(batch[0]) && batch[0].callbackCounter == 1234 && !queue.getStats().threadCyclesRequested;
    check("callback_trace_disable_keeps_published_sample_without_reset_race", disabled);

    queue.setEnabled(true);
    std::size_t sampled = 0;
    bool rates = true;
    for (std::uint64_t counter = 1; counter <= 6000; ++counter)
        if (queue.shouldCapture(queue.getOptions(), counter, 16))
        {
            rates &= queue.tryPush(fixture(counter)) && queue.drain(batch.data(), batch.size()) == 1
                && coherent(batch[0]) && batch[0].callbackCounter == counter;
            ++sampled;
        }
    check("callback_trace_eight_sample_cadence_and_rate_payload", rates && sampled == 375
        && !queue.getStats().threadCyclesRequested && !queue.shouldCapture(queue.getOptions(), 16, 0));
    check("callback_trace_captures_unsampled_deadline_misses",
        queue.shouldPublish(queue.getOptions(), 17, 0.2, 8.0 / 48.0)
        && !queue.shouldPublish(queue.getOptions(), 17, 0.1, 8.0 / 48.0)
        && queue.shouldPublish(queue.getOptions(), 32, 0.1, 8.0 / 48.0)
        && !queue.shouldPublish(0, 17, 0.2, 8.0 / 48.0));

    RealtimeCallbackTraceQueue<64> concurrent;
    concurrent.setEnabled(true, true);
    constexpr std::uint64_t attempts = 100000;
    std::atomic<bool> finished { false };
    std::uint64_t accepted = 0, received = 0, previous = 0;
    bool publication = true;
    std::thread producer([&] {
        for (std::uint64_t counter = 1; counter <= attempts; ++counter)
            if (concurrent.tryPush(fixture(counter))) ++accepted;
        finished.store(true, std::memory_order_release);
    });
    std::array<RealtimeCallbackTraceEvent, 64> concurrentBatch;
    do
    {
        const auto receivedNow = concurrent.drain(concurrentBatch.data(), concurrentBatch.size());
        for (std::size_t index = 0; index < receivedNow; ++index)
        {
            const auto& event = concurrentBatch[index];
            publication &= coherent(event) && event.callbackCounter > previous;
            previous = event.callbackCounter; ++received;
        }
    }
    while (!finished.load(std::memory_order_acquire) || concurrent.getStats().pending != 0);
    producer.join();
    const auto stats = concurrent.getStats();
    check("callback_trace_concurrent_publication_is_coherent_and_loss_accounted",
        publication && accepted == received && received == stats.published && received == stats.consumed
        && received + stats.droppedFull == attempts && stats.pending == 0);
}
