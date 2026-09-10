#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <functional>

// One physical MIDI source, one message-thread consumer. Controller commands
// mutate UI-owned routing/state; they must not execute on the driver thread.
// Instrument/note monitoring does NOT use this message-thread queue.
class ControlSurfaceMidiInbox final : private juce::AsyncUpdater
{
public:
    explicit ControlSurfaceMidiInbox(std::function<void(const juce::MidiMessage&)> receiver)
        : receive(std::move(receiver)) {}
    ~ControlSurfaceMidiInbox() override { cancelPendingUpdate(); }
    bool push(const juce::MidiMessage& message)
    {
        const auto size = message.getRawDataSize();
        if (size < 1 || size > 3) return false; // No SysEx commands are consumed here.
        const auto write = writeIndex.load(std::memory_order_relaxed);
        const auto next = (write + 1) % capacity;
        if (next == readIndex.load(std::memory_order_acquire)) return false;
        auto& packet = packets[write];
        packet.size = size;
        std::memcpy(packet.bytes.data(), message.getRawData(), static_cast<size_t>(size));
        writeIndex.store(next, std::memory_order_release);
        triggerAsyncUpdate(); // MIDI driver thread, never the audio callback.
        return true;
    }
    // Call on the message thread only, after stopping/joining the MIDI source.
    void clear()
    {
        cancelPendingUpdate();
        readIndex.store(writeIndex.load(std::memory_order_acquire), std::memory_order_release);
    }
    void dispatchPending() { handleUpdateNowIfNeeded(); }
private:
    void handleAsyncUpdate() override
    {
        auto read = readIndex.load(std::memory_order_relaxed);
        const auto end = writeIndex.load(std::memory_order_acquire);
        while (read != end)
        {
            const auto packet = packets[read];
            read = (read + 1) % capacity;
            readIndex.store(read, std::memory_order_release);
            receive(juce::MidiMessage(packet.bytes.data(), packet.size, 0.0));
        }
        if (read != writeIndex.load(std::memory_order_acquire)) triggerAsyncUpdate();
    }
    static constexpr size_t capacity = 256;
    struct Packet { std::array<juce::uint8, 3> bytes {}; int size = 0; };
    std::array<Packet, capacity> packets {};
    std::atomic<size_t> readIndex { 0 }, writeIndex { 0 };
    std::function<void(const juce::MidiMessage&)> receive;
};
