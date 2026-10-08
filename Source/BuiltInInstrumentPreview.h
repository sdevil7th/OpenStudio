#pragma once
#include "BuiltInEffects2.h"

// Audition owns separate processor voices. It never enters track MIDI queues,
// recording, or offline export. Four fixed leases permit independent editors.
class BuiltInInstrumentPreview
{
public:
    bool send(const juce::String& session, const std::shared_ptr<juce::AudioProcessor>& source,
              int note, bool on, double rate,
              const std::function<std::unique_ptr<juce::AudioProcessor>()>& create,
              const std::function<std::function<void()>(juce::AudioProcessor&)>& bind = {})
    {
        const juce::ScopedLock lock(controlLock);
        for (auto& slot : slots)
            if (slot.session == session && slot.state.load() > 0)
            {
                if (note == -1 || slot.source.lock() != source || slot.rate != rate) { for (auto& value : slot.notes) value.store(0); slot.stop.store(true); return true; }
                if (on && note >= 0) slot.stop.store(false);
                slot.heartbeat.store(juce::Time::getMillisecondCounter());
                if (note >= 0 && note < 128) slot.notes[static_cast<size_t>(note)].store(on ? 100 : 0);
                return true;
            }
        if (!on || note < 0) return true;
        if (!source || !std::isfinite(rate) || rate <= 0) return false;
        for (auto& slot : slots)
        {
            int idle = 0;
            if (!slot.state.compare_exchange_strong(idle, -1)) continue;
            slot.processor = create();
            if (!slot.processor) { slot.state.store(0); return false; }
            juce::MemoryBlock state;
            { const juce::ScopedLock guard(source->getCallbackLock()); source->getStateInformation(state); }
            slot.processor->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
            // Isolated audition always reaches the preview stereo output, even
            // when the project routes a drum piece exclusively to an auxiliary bus.
            if(auto* drums=dynamic_cast<OpenStudioDrumInstrument*>(slot.processor.get()))
                for(auto& output:drums->pieceOutput)output.store(0);
            slot.processor->setRateAndBufferSizeDetails(rate, 256);
            slot.processor->prepareToPlay(rate, 256);
            slot.synchronize = bind ? bind(*slot.processor) : std::function<void()>();
            slot.audio.setSize(2, 256); slot.midi.ensureSize(4096);
            for (auto& value : slot.notes) value.store(0);
            slot.playing.fill(0); slot.channel = 1; slot.notes[static_cast<size_t>(note)].store(100);
            slot.session = session; slot.source = source; slot.rate = rate; slot.stop.store(false);
            slot.heartbeat.store(juce::Time::getMillisecondCounter()); slot.gain = 0; slot.quietSamples = 0;
            slot.state.store(1);
            return true;
        }
        return false;
    }
    void render(float* const* output, int channels, int count, double rate)
    {
        for (auto& slot : slots)
        {
            int ready = 1;
            if (!slot.state.compare_exchange_strong(ready, 2)) continue;
            bool stop = slot.stop.load() || slot.source.expired() || slot.rate != rate
                || static_cast<juce::uint32>(juce::Time::getMillisecondCounter() - slot.heartbeat.load()) > 5000;
            if (!stop && slot.synchronize) slot.synchronize();
            bool held = false;
            for (int start = 0; start < count; start += 256)
            {
                const int length = juce::jmin(256, count - start);
                slot.audio.clear(); slot.midi.clear();
                int previewChannel = 1;
                if (const auto* synth = dynamic_cast<const OpenStudioBasicSynthInstrument*>(slot.processor.get()))
                    if (synth->mpeEnabled.load() >= .5f)
                        previewChannel = synth->mpeLowerMembers.load() > 0 ? 2 : synth->mpeUpperMembers.load() > 0 ? 15 : 1;
                if (previewChannel != slot.channel)
                {
                    slot.midi.addEvent(juce::MidiMessage::allSoundOff(slot.channel), 0);
                    slot.playing.fill(0); slot.channel = previewChannel;
                }
                for (size_t note = 0; note < 128; ++note)
                {
                    const int velocity = stop ? 0 : slot.notes[note].load();
                    held = held || velocity != 0;
                    if (velocity != slot.playing[note])
                    {
                        slot.midi.addEvent(velocity ? juce::MidiMessage::noteOn(slot.channel, static_cast<int>(note), static_cast<juce::uint8>(velocity))
                                                  : juce::MidiMessage::noteOff(slot.channel, static_cast<int>(note)), 0);
                        slot.playing[note] = velocity;
                    }
                }
                float* pointers[] = { slot.audio.getWritePointer(0), slot.audio.getWritePointer(1) };
                juce::AudioBuffer<float> segment(pointers, 2, length);
                slot.processor->processBlock(segment, slot.midi);
                for (int i = 0; i < length; ++i)
                {
                    slot.gain = juce::jlimit(0.0f, 1.0f, slot.gain + (stop ? -1.0f : 1.0f) / static_cast<float>(rate * .01));
                    for (int ch = 0; ch < juce::jmin(2, channels); ++ch)
                        output[ch][start + i] += slot.audio.getSample(ch, i) * slot.gain;
                }
            }
            slot.quietSamples = held ? 0 : slot.quietSamples + count;
            // Bound tails and recover crashed/closed editors even without a
            // final browser message. Retirement/destruction stays off callback.
            if (slot.quietSamples > rate * 2) { slot.stop.store(true); stop = true; }
            slot.state.store(stop && slot.gain == 0 ? 0 : 1);
        }
    }
    void stopAll() { for (auto& slot : slots) slot.stop.store(true); }
private:
    struct Slot
    {
        std::atomic<int> state { 0 }; // free / published / audio-owned / preparing
        std::atomic<bool> stop { false };
        std::array<std::atomic<int>, 128> notes {};
        std::array<int, 128> playing {};
        std::atomic<juce::uint32> heartbeat { 0 };
        std::unique_ptr<juce::AudioProcessor> processor;
        std::function<void()> synchronize;
        std::weak_ptr<juce::AudioProcessor> source;
        juce::String session;
        juce::AudioBuffer<float> audio;
        juce::MidiBuffer midi;
        double rate = 48000;
        float gain = 0;
        int quietSamples = 0;
        int channel = 1;
    };
    juce::CriticalSection controlLock;
    std::array<Slot, 4> slots;
};
