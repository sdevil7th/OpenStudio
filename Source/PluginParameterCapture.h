#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <memory>
#include <vector>

// Parameter callbacks may run on the audio thread. Only publish atomics here;
// the message thread drains them into the project's automation writer.
class PluginParameterCapture
{
public:
    struct State
    {
        std::atomic<float> value { 0.0f };
        std::atomic<bool> touching { false }, gesture { false };
        std::atomic<unsigned> pending { 0 };
    };

    explicit PluginParameterCapture(std::shared_ptr<juce::AudioProcessor> ownerIn)
        : owner(std::move(ownerIn))
    {
        for (auto* parameter : owner->getParameters())
            listeners.push_back(std::make_unique<Listener>(*parameter));
    }

    std::shared_ptr<State> stateFor(int index) const
    {
        return juce::isPositiveAndBelow(index, static_cast<int>(listeners.size()))
            ? listeners[static_cast<size_t>(index)]->state : nullptr;
    }

    void discard()
    {
        for (const auto& listener : listeners)
        {
            listener->state->pending.store(0);
            listener->state->touching.store(false);
            listener->state->gesture.store(false);
        }
    }

    void drain(const juce::String& trackId, bool input, int slot, juce::Array<juce::var>& events)
    {
        const auto now = juce::Time::getMillisecondCounter();
        for (size_t i = 0; i < listeners.size(); ++i)
        {
            auto& listener = *listeners[i];
            auto& state = *listener.state;
            const auto flags = state.pending.exchange(0, std::memory_order_acq_rel);
            const auto emit = [&] (const char* phase) {
                auto* event = new juce::DynamicObject();
                event->setProperty("trackId", trackId);
                event->setProperty("param", listener.parameter.isAutomatable()
                    ? (slot < 0 ? juce::String("plugin_instrument_0_")
                        : "plugin_" + juce::String(input ? "input_" : "track_") + juce::String(slot) + "_")
                        + juce::String(static_cast<int>(i)) : juce::String());
                event->setProperty("phase", phase);
                event->setProperty("value", state.value.load(std::memory_order_acquire));
                event->setProperty("name", owner->getName() + ": " + listener.parameter.getName(128));
                events.add(juce::var(event));
            };
            if (flags & 1u) emit("begin");
            if (flags & 2u) { listener.lastChange = now; emit("value"); }
            // Plugins without gesture callbacks get a short touch timeout.
            if (!state.gesture.load() && ((flags & 4u) || (state.touching.load()
                && now - listener.lastChange >= 180)))
            {
                state.touching.store(false);
                emit("end");
            }
        }
    }

private:
    struct Listener : juce::AudioProcessorParameter::Listener
    {
        explicit Listener(juce::AudioProcessorParameter& parameterIn) : parameter(parameterIn)
        {
            state->value.store(parameter.getValue());
            parameter.addListener(this);
        }
        ~Listener() override { parameter.removeListener(this); }
        void parameterValueChanged(int, float value) override
        {
            if (!std::isfinite(value) || !parameter.isAutomatable()
                || (static_cast<int>(parameter.getCategory()) >> 16) == 2) return;
            state->value.store(juce::jlimit(0.0f, 1.0f, value), std::memory_order_release);
            state->touching.store(true);
            state->pending.fetch_or(2u, std::memory_order_release);
        }
        void parameterGestureChanged(int, bool starting) override
        {
            state->gesture.store(starting);
            if (starting) { state->value.store(parameter.getValue()); state->touching.store(true); }
            state->pending.fetch_or(starting ? 1u : 4u, std::memory_order_release);
        }
        juce::AudioProcessorParameter& parameter;
        std::shared_ptr<State> state = std::make_shared<State>();
        juce::uint32 lastChange = 0;
    };
    std::shared_ptr<juce::AudioProcessor> owner;
    std::vector<std::unique_ptr<Listener>> listeners;
};
