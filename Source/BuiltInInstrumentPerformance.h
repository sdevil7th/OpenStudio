#pragma once
#include <JuceHeader.h>
#include <array>
#include <atomic>

// Received key/pedal state, distinct from a synth's sounding/releasing voices.
// The callback only touches fixed atomic storage; JSON is built by UI readers.
class BuiltInInstrumentPerformance
{
public:
    BuiltInInstrumentPerformance() noexcept { reset(); }
    void reset() noexcept
    {
        for (auto& value : keys) value.store(0, std::memory_order_relaxed);
        for (auto& value : sustain) value.store(0, std::memory_order_relaxed);
        for (auto& value : sostenuto) value.store(0, std::memory_order_relaxed);
        for (auto& value : soft) value.store(0, std::memory_order_relaxed);
    }
    void observe(const juce::MidiMessage& message) noexcept
    {
        if (message.getChannel() < 1 || message.getChannel() > 16) return;
        const auto channel = static_cast<size_t>(message.getChannel() - 1);
        if (message.isNoteOn()) keys[channel * 128 + static_cast<size_t>(message.getNoteNumber())].store(message.getVelocity(), std::memory_order_relaxed);
        else if (message.isNoteOff()) keys[channel * 128 + static_cast<size_t>(message.getNoteNumber())].store(0, std::memory_order_relaxed);
        else if (message.isAllNotesOff() || message.isAllSoundOff())
            for (size_t key = 0; key < 128; ++key) keys[channel * 128 + key].store(0, std::memory_order_relaxed);
        else if (message.isController())
        {
            const auto value = static_cast<juce::uint8>(message.getControllerValue());
            switch (message.getControllerNumber())
            {
                case 64: sustain[channel].store(value, std::memory_order_relaxed); break;
                case 66: sostenuto[channel].store(value, std::memory_order_relaxed); break;
                case 67: soft[channel].store(value, std::memory_order_relaxed); break;
                case 121:
                    sustain[channel].store(0, std::memory_order_relaxed);
                    sostenuto[channel].store(0, std::memory_order_relaxed);
                    soft[channel].store(0, std::memory_order_relaxed);
                    break;
                default: break;
            }
        }
    }
    juce::var visualization() const
    {
        auto* result = new juce::DynamicObject();
        juce::Array<juce::var> notes, sustainValues, sostenutoValues, softValues;
        for (size_t channel = 0; channel < 16; ++channel)
        {
            for (size_t key = 0; key < 128; ++key)
                if (const auto velocity = keys[channel * 128 + key].load(std::memory_order_relaxed); velocity > 0)
                {
                    auto* note = new juce::DynamicObject();
                    note->setProperty("channel", static_cast<int>(channel) + 1);
                    note->setProperty("note", static_cast<int>(key));
                    note->setProperty("velocity", static_cast<double>(velocity) / 127.0);
                    note->setProperty("held", true); notes.add(note);
                }
            sustainValues.add(static_cast<double>(sustain[channel].load(std::memory_order_relaxed)) / 127.0);
            sostenutoValues.add(static_cast<double>(sostenuto[channel].load(std::memory_order_relaxed)) / 127.0);
            softValues.add(static_cast<double>(soft[channel].load(std::memory_order_relaxed)) / 127.0);
        }
        result->setProperty("notes", notes);
        result->setProperty("sustain", sustainValues); result->setProperty("sostenuto", sostenutoValues); result->setProperty("soft", softValues);
        result->setProperty("scope", "received-keys-and-pedals");
        return result;
    }
private:
    std::array<std::atomic<juce::uint8>, 16 * 128> keys;
    std::array<std::atomic<juce::uint8>, 16> sustain, sostenuto, soft;
};
