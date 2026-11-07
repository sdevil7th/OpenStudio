#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <type_traits>

// Optional diagnostics only. Plain payloads are safe because an unread slot is
// owned by the consumer: the producer drops on full and never overwrites it.
struct RealtimeCallbackTraceEvent
{
    std::uint64_t callbackCounter = 0;
    std::int64_t startSamplePosition = 0;
    std::int64_t startQpcTicks = 0, endQpcTicks = 0;
    double startWallTimeMs = 0.0, measuredWallMs = 0.0, budgetMs = 0.0;
    double sampleRate = 0.0;
    std::array<double, 5> stageMs {};
    std::uint64_t threadId = 0, threadCycleDelta = 0;
    std::uint32_t processorGroupStart = 0, processorNumberStart = 0;
    std::uint32_t processorGroupEnd = 0, processorNumberEnd = 0;
    int blockSize = 0;
    bool playing = false, recording = false, stageTimingsAvailable = false;
    bool processorIdsAvailable = false, threadCyclesRequested = false, threadCyclesValid = false;
};
static_assert(std::is_trivially_copyable_v<RealtimeCallbackTraceEvent>);

struct RealtimeCallbackTraceStats
{
    std::uint64_t published = 0, consumed = 0, droppedFull = 0, pending = 0;
    bool enabled = false, threadCyclesRequested = false;
};

template <std::size_t Capacity>
class RealtimeCallbackTraceQueue final
{
public:
    static_assert(Capacity > 1 && (Capacity & (Capacity - 1)) == 0);
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
    static_assert(std::atomic<std::uint32_t>::is_always_lock_free);
    static constexpr std::size_t capacity = Capacity;
    static constexpr std::uint64_t sampleInterval = 16;
    enum : std::uint32_t { enabledFlag = 1, threadCyclesFlag = 2 };

    // AudioEngine construction is a control-thread operation. Keep the fixed
    // storage off callers' stacks and retain it until all callbacks have stopped.
    RealtimeCallbackTraceQueue() : slots(std::make_unique<std::array<RealtimeCallbackTraceEvent, Capacity>>()) {}

    // Control thread only; never resets indices or reclaims callback storage.
    void setEnabled(bool enabled, bool cycles = false) noexcept
    {
        options.store(enabled ? enabledFlag | (cycles ? threadCyclesFlag : 0u) : 0u,
                      std::memory_order_release);
    }
    std::uint32_t getOptions() const noexcept { return options.load(std::memory_order_acquire); }
    static bool shouldCapture(std::uint32_t selectedOptions, std::uint64_t callback,
                              std::uint64_t captureInterval) noexcept
    {
        return (selectedOptions & enabledFlag) != 0 && captureInterval != 0
            && callback % captureInterval == 0;
    }
    static bool shouldPublish(std::uint32_t selectedOptions, std::uint64_t callback,
                              double wallMs, double budgetMs) noexcept
    {
        return (selectedOptions & enabledFlag) != 0
            && (shouldCapture(selectedOptions, callback, sampleInterval) || (budgetMs > 0.0 && wallMs > budgetMs));
    }

    // Single producer: the audio callback. No allocation, waiting, file work or
    // retry loop. Release publication follows the complete payload assignment.
    bool tryPush(const RealtimeCallbackTraceEvent& event) noexcept
    {
        if ((getOptions() & enabledFlag) == 0) return false;
        const auto write = writeIndex.load(std::memory_order_relaxed);
        const auto read = readIndex.load(std::memory_order_acquire);
        if (write - read >= Capacity)
        {
            droppedFull.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        (*slots)[static_cast<std::size_t>(write & static_cast<std::uint64_t>(Capacity - 1))] = event;
        writeIndex.store(write + 1, std::memory_order_release);
        return true;
    }

    // Single consumer: RealtimeQualificationReporter on the message thread.
    // Other diagnostic/bridge readers must not call this function.
    std::size_t drain(RealtimeCallbackTraceEvent* destination, std::size_t maximum) noexcept
    {
        if (destination == nullptr || maximum == 0) return 0;
        const auto read = readIndex.load(std::memory_order_relaxed);
        const auto write = writeIndex.load(std::memory_order_acquire);
        const auto count = static_cast<std::size_t>(std::min<std::uint64_t>(
            static_cast<std::uint64_t>(maximum), write - read));
        for (std::size_t index = 0; index < count; ++index)
            destination[index] = (*slots)[static_cast<std::size_t>(
                (read + index) & static_cast<std::uint64_t>(Capacity - 1))];
        // Producer may reuse these slots only after the consumer finished all
        // reads. This ownership transfer avoids seqlocks over non-atomic data.
        readIndex.store(read + count, std::memory_order_release);
        return count;
    }

    RealtimeCallbackTraceStats getStats() const noexcept
    {
        const auto selectedOptions = getOptions();
        const auto consumed = readIndex.load(std::memory_order_acquire);
        const auto published = writeIndex.load(std::memory_order_acquire);
        return { published, consumed, droppedFull.load(std::memory_order_relaxed),
                 published >= consumed ? published - consumed : 0,
                 (selectedOptions & enabledFlag) != 0, (selectedOptions & threadCyclesFlag) != 0 };
    }

private:
    std::unique_ptr<std::array<RealtimeCallbackTraceEvent, Capacity>> slots;
    std::atomic<std::uint64_t> writeIndex { 0 };
    std::atomic<std::uint64_t> readIndex { 0 };
    std::atomic<std::uint64_t> droppedFull { 0 };
    std::atomic<std::uint32_t> options { 0 };
};

using RealtimeCallbackTrace = RealtimeCallbackTraceQueue<4096>;
