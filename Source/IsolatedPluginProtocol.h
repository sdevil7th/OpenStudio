#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <array>
#include <type_traits>
#include <cmath>
#include "PluginAutomationEventQueue.h"

// Same-executable, same-user crash containment, NOT a security sandbox. No
// pointers cross the process boundary. The parent never trusts worker geometry.
namespace IsolatedPluginProtocol
{
constexpr uint32_t magic = 0x4f534950, version = 3;
constexpr int slots = 4, channels = 32, frames = 8192, parameters = 8192;
constexpr int midiEvents = 128, midiBytes = 2048, metadataBytes = 2 * 1024 * 1024;
constexpr int maxStateBytes = 64 * 1024 * 1024;
enum Command : uint32_t { idle, initialise, prepare, release, getState, setState, showEditor, hideEditor, program, stop, testFailure, testParameterGesture, getParameterPresentation };
enum Fault : uint32_t { healthy, childExited, deadline, invalidPacket, invalidAudio, controlFailure, incompatible };
struct MidiEvent { uint32_t sample, offset, size; };
struct MidiPacket
{
    uint32_t count = 0, bytes = 0;
    std::array<MidiEvent, midiEvents> events {};
    std::array<uint8_t, midiBytes> data {};
    void clear() noexcept { count = bytes = 0; }
    bool add(const uint8_t* source, int size, int sample) noexcept
    {
        if (size <= 0 || sample < 0 || count >= midiEvents || size > midiBytes
            || bytes > midiBytes - static_cast<uint32_t>(size)) return false;
        events[count++] = { static_cast<uint32_t>(sample), bytes, static_cast<uint32_t>(size) };
        memcpy(data.data() + bytes, source, static_cast<size_t>(size));
        bytes += static_cast<uint32_t>(size);
        return true;
    }
    bool valid(int block) const noexcept
    {
        if (count > midiEvents || bytes > midiBytes) return false;
        uint32_t previous = 0;
        for (uint32_t i = 0; i < count; ++i)
        {
            const auto& event = events[i];
            if (event.sample >= static_cast<uint32_t>(block) || (i && event.sample < previous)
                || event.size == 0 || event.offset > bytes || event.size > bytes - event.offset) return false;
            previous = event.sample;
        }
        return true;
    }
};
struct Parameter
{
    std::atomic<float> desired { 0 }, actual { 0 };
    std::atomic<uint32_t> revision { 0 }, acknowledged { 0 };
    std::atomic<uint32_t> editorEvents { 0 };
    std::atomic<float> editorValue { 0 };
};
struct ParameterPoint { uint32_t index = 0, sample = 0; float value = 0; };
struct ParameterPacket
{
    static constexpr uint32_t capacity = 8192;
    uint32_t count = 0;
    std::array<ParameterPoint, capacity> points {};
    void clear() noexcept { count = 0; }
    bool add(uint32_t index, uint32_t sample, float value) noexcept
    {
        if (count >= capacity || index >= parameters || !std::isfinite(value) || value < 0 || value > 1) return false;
        points[count++] = { index, sample, value }; return true;
    }
    bool valid(uint32_t block, uint32_t parameterCount) const noexcept
    {
        if (count > capacity || parameterCount > parameters) return false;
        for (uint32_t i = 0; i < count; ++i)
            if (points[i].index >= parameterCount || points[i].sample >= block || !std::isfinite(points[i].value)
                || points[i].value < 0 || points[i].value > 1) return false;
        return true;
    }
};
struct CaptureClock
{
    std::atomic<double> position { 0 }, rate { 44100 };
    std::atomic<juce::int64> ticks { 0 };
    std::atomic<uint64_t> epoch { 0 };
    std::atomic<bool> rolling { false };
    void update(const PluginAutomationProcessingContext& context) noexcept
    {
        position.store(context.position); rate.store(context.sampleRate); epoch.store(context.epoch);
        rolling.store(context.rolling); ticks.store(juce::Time::getHighResolutionTicks(), std::memory_order_release);
    }
    double estimate(juce::int64 now) const noexcept
    {
        const auto capturedTicks = ticks.load(std::memory_order_acquire);
        return position.load() + (rolling.load() && capturedTicks > 0
            ? juce::jmax(0.0, static_cast<double>(now - capturedTicks) / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond())) : 0);
    }
};
struct UnhandledKey { int code = 0, modifiers = 0; uint32_t character = 0, focusGeneration = 0; uint64_t ticks = 0; bool repeat = false; };
struct Slot
{
    // 0 free (parent owns), 1 input ready, 2 processing, 3 output ready.
    std::atomic<uint32_t> state { 0 };
    uint64_t sequence = 0;
    uint32_t generation = 0;
    bool hasPosition = false;
    juce::AudioPlayHead::PositionInfo position;
    MidiPacket midi;
    ParameterPacket automation;
    PluginAutomationProcessingContext automationContext;
    float audio[channels][frames] {};
};
struct Shared
{
    uint32_t magicValue = magic, protocolVersion = version;
    std::atomic<uint32_t> request { 0 }, response { 0 }, command { idle }, success { 0 }, fault { healthy };
    std::atomic<uint32_t> editorVisible { 0 }, editorFocused { 0 }, resetRequested { 0 }, parameterChanges { 0 };
    std::atomic<uint32_t> parameterPresentationRevision { 0 };
    std::atomic<int> latency { 0 }, currentProgram { 0 };
    std::atomic<uint64_t> completedBlocks { 0 };
    std::atomic<uint32_t> keyWrite { 0 }, keyRead { 0 };
    std::atomic<uint32_t> focusGeneration { 0 };
    UnhandledKey keys[16];
    // Serialized control request/response, never modified by the parent callback.
    double rate = 44100;
    uint32_t quantum = 512, generation = 0, commandArgument = 0, nonRealtime = 0, parameterCount = 0;
    uint32_t textBytes = 0;
    char text[metadataBytes] {};
    Parameter params[parameters];
    CaptureClock captureClock;
    PluginAutomationEventQueue editorQueue;
    std::atomic<uint64_t> editorDropped { 0 };
    Slot packets[slots];
};
static_assert(std::atomic<uint32_t>::is_always_lock_free && std::atomic<uint64_t>::is_always_lock_free
    && std::atomic<float>::is_always_lock_free);
static_assert(std::is_trivially_copyable_v<juce::AudioPlayHead::PositionInfo>);
}
