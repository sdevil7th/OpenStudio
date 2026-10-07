#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>

struct PluginAutomationClock
{
    std::atomic<double> position { 0.0 }, sampleRate { 44100.0 };
    std::atomic<juce::int64> ticks { 0 };
    std::atomic<bool> rolling { false };
    std::atomic<uint64_t> epoch { 1 };
    const std::atomic<juce::int64>* positionSource = nullptr; // Bound once, before audio starts.
    double capturePosition() const noexcept {
        return positionSource ? static_cast<double>(positionSource->load(std::memory_order_acquire)) / juce::jmax(1.0, sampleRate.load(std::memory_order_acquire))
            : position.load(std::memory_order_acquire);
    }
    double estimatedPosition(juce::int64 capturedTicks, bool playing) const noexcept {
        // position is the callback's block start, while positionSource normally
        // points to its end. Adding elapsed time to the end double-counts a block.
        for (int attempt = 0; attempt < 2; ++attempt) {
            const auto timestamp = ticks.load(std::memory_order_acquire);
            const auto start = position.load(std::memory_order_relaxed);
            if (timestamp != ticks.load(std::memory_order_acquire)) continue;
            const auto elapsed = static_cast<double>(capturedTicks - timestamp) / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
            return start + (playing ? juce::jlimit(0.0, .25, elapsed) : 0.0);
        }
        return capturePosition();
    }
    void update(double time, double rate, bool playing) noexcept
    {
        position.store(time, std::memory_order_relaxed);
        sampleRate.store(rate, std::memory_order_relaxed);
        rolling.store(playing, std::memory_order_relaxed);
        ticks.store(juce::Time::getHighResolutionTicks(), std::memory_order_release);
    }
};

struct PluginAutomationProcessingContext
{
    double position = 0.0, sampleRate = 44100.0;
    int offset = -1;
    bool processing = false;
    uint64_t epoch = 0;
    bool rolling = false;
    bool external = false;
    int timing = 1;
};
inline thread_local PluginAutomationProcessingContext pluginAutomationProcessingContext;
class ScopedPluginAutomationProcessing
{
public:
    ScopedPluginAutomationProcessing(double position, double rate, uint64_t epoch = 0, bool rolling = true) noexcept
        : previous(pluginAutomationProcessingContext)
    { pluginAutomationProcessingContext = { position, rate, -1, true, epoch ? epoch : previous.epoch, epoch || !previous.processing ? rolling : previous.rolling }; }
    ~ScopedPluginAutomationProcessing() { pluginAutomationProcessingContext = previous; }
private:
    PluginAutomationProcessingContext previous;
};
class ScopedPluginAutomationSampleOffset
{
public:
    explicit ScopedPluginAutomationSampleOffset(int offset) noexcept
        : previous(pluginAutomationProcessingContext.offset)
    { pluginAutomationProcessingContext.offset = offset; }
    ~ScopedPluginAutomationSampleOffset() { pluginAutomationProcessingContext.offset = previous; }
private:
    int previous;
};

struct PluginAutomationCapturedEvent
{
    int parameter = -1;
    unsigned phase = 0;
    float value = 0.0f, initialValue = 0.0f;
    double time = 0.0;
    juce::int64 ticks = 0;
    uint64_t epoch = 0, sequence = 0, listenerGeneration = 0;
    bool rolling = false, timed = false;
    // 0: estimated editor time, 1: processing block, 2: SDK sample offset.
    int timing = 0;
};

// Ordered events from an isolated worker already carry their capture time.
// Forwarding them on the message thread must not timestamp them a second time
// or mistake a GUI edit for an audio-thread Read echo.
class ScopedPluginAutomationExternalCapture
{
public:
    explicit ScopedPluginAutomationExternalCapture(const PluginAutomationCapturedEvent& event) noexcept
        : previous(pluginAutomationProcessingContext)
    { pluginAutomationProcessingContext = { event.time, 44100.0, -1, event.timed, event.epoch, event.rolling, true, event.timing }; }
    ~ScopedPluginAutomationExternalCapture() { pluginAutomationProcessingContext = previous; }
private:
    PluginAutomationProcessingContext previous;
};

// Bounded MPSC queue: callbacks may come from the audio or editor thread, and
// the message thread is the sole consumer. No allocation, lock or unbounded
// retry on a producer. Overflow is counted and recovered explicitly by capture.
class PluginAutomationEventQueue
{
public:
    static constexpr size_t capacity = 1024;
    PluginAutomationEventQueue() noexcept
    {
        for (size_t index = 0; index < capacity; ++index) cells[index].sequence.store(index);
    }
    bool push(PluginAutomationCapturedEvent event) noexcept
    {
        auto position = writePosition.load(std::memory_order_relaxed);
        for (int attempt = 0; attempt < 8; ++attempt)
        {
            auto& cell = cells[position % capacity];
            const auto sequence = cell.sequence.load(std::memory_order_acquire);
            const auto difference = static_cast<intptr_t>(sequence) - static_cast<intptr_t>(position);
            if (difference < 0) return false;
            if (difference == 0 && writePosition.compare_exchange_weak(position, position + 1, std::memory_order_relaxed))
            {
                event.sequence = static_cast<uint64_t>(position + 1);
                cell.event = event;
                cell.sequence.store(position + 1, std::memory_order_release);
                return true;
            }
            position = writePosition.load(std::memory_order_relaxed);
        }
        return false;
    }
    bool pop(PluginAutomationCapturedEvent& event) noexcept
    {
        auto& cell = cells[readPosition % capacity];
        if (cell.sequence.load(std::memory_order_acquire) != readPosition + 1) return false;
        event = cell.event;
        cell.sequence.store(readPosition + capacity, std::memory_order_release);
        ++readPosition;
        return true;
    }
private:
    struct Cell { std::atomic<size_t> sequence { 0 }; PluginAutomationCapturedEvent event; };
    std::array<Cell, capacity> cells;
    std::atomic<size_t> writePosition { 0 };
    size_t readPosition = 0;
};
