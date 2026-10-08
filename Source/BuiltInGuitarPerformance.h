#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>

// Block-end voice allocation, not an audio level or a received-key display.
// Fixed atomic storage keeps publication allocation-free and non-blocking.
class BuiltInGuitarPerformance
{
public:
    static constexpr size_t channels = 16, slots = 16;
    BuiltInGuitarPerformance() noexcept
    {
        for (auto& value : voices) value.store(0, std::memory_order_relaxed);
        for (auto& value : next) value.store(0, std::memory_order_relaxed);
    }
    void begin() noexcept { sequence.fetch_add(1, std::memory_order_acq_rel); }
    void setNext(size_t channel, int articulation, int source) noexcept
    {
        next[channel].store(static_cast<juce::uint32>(articulation | (source << 4)), std::memory_order_relaxed);
    }
    void setVoice(size_t channel, size_t slot, bool active, int note, int stringIndex,
                  int articulation, bool held, bool sustained, bool releasing,
                  bool plucked, bool assigned) noexcept
    {
        const auto value = !active || stringIndex < 0 ? 0u : static_cast<juce::uint32>(
            (note + 1) | (stringIndex << 8) | (articulation << 11)
            | (held ? 1 << 15 : 0) | (sustained ? 1 << 16 : 0)
            | (releasing ? 1 << 17 : 0) | (plucked ? 1 << 18 : 0) | (assigned ? 1 << 19 : 0));
        voices[channel * slots + slot].store(value, std::memory_order_relaxed);
    }
    void end() noexcept { sequence.fetch_add(1, std::memory_order_release); }
    juce::var visualization() const
    {
        std::array<juce::uint32, channels * slots> voiceValues {};
        std::array<juce::uint32, channels> nextValues {};
        bool coherent = false;
        for (int attempt = 0; attempt < 3 && !coherent; ++attempt)
        {
            const auto before = sequence.load(std::memory_order_acquire);
            if ((before & 1u) != 0) continue;
            for (size_t i = 0; i < voices.size(); ++i) voiceValues[i] = voices[i].load(std::memory_order_relaxed);
            for (size_t i = 0; i < next.size(); ++i) nextValues[i] = next[i].load(std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_acquire);
            coherent = before == sequence.load(std::memory_order_relaxed);
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("available", coherent);
        result->setProperty("scope", "block-end-voice-allocation");
        juce::Array<juce::var> voiceRows, nextRows;
        if (coherent) for (size_t channel = 0; channel < channels; ++channel)
        {
            const auto target = nextValues[channel];
            auto* nextRow = new juce::DynamicObject();
            nextRow->setProperty("channel", static_cast<int>(channel) + 1);
            nextRow->setProperty("articulation", static_cast<int>(target & 15u));
            nextRow->setProperty("source", (target >> 4) == 2 ? "keyswitch" : (target >> 4) == 1 ? "panel" : "legacy");
            nextRows.add(nextRow);
            for (size_t slot = 0; slot < slots; ++slot)
            {
                const auto value = voiceValues[channel * slots + slot];
                if (value == 0) continue;
                auto* voice = new juce::DynamicObject();
                voice->setProperty("channel", static_cast<int>(channel) + 1);
                voice->setProperty("slot", static_cast<int>(slot));
                voice->setProperty("note", static_cast<int>(value & 255u) - 1);
                voice->setProperty("stringIndex", static_cast<int>((value >> 8) & 7u));
                voice->setProperty("articulation", static_cast<int>((value >> 11) & 15u));
                voice->setProperty("held", (value & (1u << 15)) != 0);
                voice->setProperty("sustained", (value & (1u << 16)) != 0);
                voice->setProperty("releasing", (value & (1u << 17)) != 0);
                voice->setProperty("plucked", (value & (1u << 18)) != 0);
                voice->setProperty("assigned", (value & (1u << 19)) != 0);
                voiceRows.add(voice);
            }
        }
        result->setProperty("voices", voiceRows);
        result->setProperty("nextArticulations", nextRows);
        return result;
    }
private:
    static_assert(std::atomic<juce::uint32>::is_always_lock_free);
    std::atomic<juce::uint32> sequence {0};
    std::array<std::atomic<juce::uint32>, channels * slots> voices;
    std::array<std::atomic<juce::uint32>, channels> next;
};
