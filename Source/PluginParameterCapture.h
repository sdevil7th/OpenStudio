#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <memory>
#include <vector>
#include "PluginAutomationEventQueue.h"
#include "PluginParameterIdentity.h"
#include "IsolatedPlugin.h"

// Parameter callbacks publish bounded, ordered events. The message thread
// resolves names and addresses and drains them into the project's writer.
class PluginParameterCapture : private juce::AudioProcessorListener
{
public:
    struct State
    {
        std::atomic<float> value { 0.0f };
        std::atomic<bool> touching { false }, gesture { false };
        std::atomic<bool> capturedWhileRolling { false };
        std::atomic<uint64_t> captureEpoch { 0 };
        std::atomic<unsigned> pending { 0 };
        std::atomic<bool> hostAutomating { false };
        std::atomic<uint64_t> deliveryDropped { 0 };
    };

    explicit PluginParameterCapture(std::shared_ptr<juce::AudioProcessor> ownerIn,
                                    std::shared_ptr<PluginAutomationClock> clockIn = {})
        : owner(std::move(ownerIn)), clock(std::move(clockIn))
    {
        for (auto* parameter : owner->getParameters())
            listeners.push_back(std::make_unique<Listener>(*this, *parameter));
        owner->addListener(this);
    }
    ~PluginParameterCapture() override { owner->removeListener(this); }

    std::shared_ptr<State> stateFor(int index) const
    {
        return juce::isPositiveAndBelow(index, static_cast<int>(listeners.size()))
            ? listeners[static_cast<size_t>(index)]->state : nullptr;
    }

    void discard()
    {
        PluginAutomationCapturedEvent ignored;
        while (queue.pop(ignored)) {}
        dropped.store(0);
        for (const auto& listener : listeners)
        {
            listener->state->pending.store(0);
            listener->state->touching.store(false);
            listener->state->gesture.store(false);
        }
    }

    bool drain(const juce::String& trackId, bool input, int slot, juce::Array<juce::var>& events,
               const juce::String& stagePrefix = {}, bool finishing = false)
    {
        flushOpenStudioIsolatedParameterEdits(owner.get());
        dropped.fetch_add(takeOpenStudioIsolatedParameterEditDrops(owner.get()));
        const auto clearedReferences = takeOpenStudioCLAPParameterClears(owner.get());
        const bool metadataChanged = metadataPending.exchange(false, std::memory_order_acq_rel)
            || listeners.size() != static_cast<size_t>(owner->getParameters().size()) || !clearedReferences.isEmpty();
        if (metadataChanged)
        {
            // CLAP retains retired objects and appends new stable IDs. Attach new
            // listeners on the message thread; cached editor states stay alive.
            const auto& parameters = owner->getParameters();
            listeners.resize(static_cast<size_t>(parameters.size()));
            for (size_t index = 0; index < listeners.size(); ++index)
                if (!listeners[index] || listeners[index]->parameter != parameters[static_cast<int>(index)])
                    listeners[index] = std::make_unique<Listener>(*this, *parameters[static_cast<int>(index)]);
            for (size_t index = 0; index < listeners.size(); ++index)
                listeners[index]->metadata = pluginParameterCaptureMetadata(owner.get(), static_cast<int>(index));
            // Parameter callbacks queued before a topology/meaning transition must
            // not be interpreted using the new parameter's metadata.
            PluginAutomationCapturedEvent stale; while (queue.pop(stale)) {}
            auto* event = new juce::DynamicObject();
            event->setProperty("trackId", trackId);
            event->setProperty("phase", "metadata");
            event->setProperty("param", "");
            event->setProperty("chain", stagePrefix.startsWith("plugin_monitor_") ? "monitor"
                : stagePrefix.isNotEmpty() ? "master" : slot < 0 ? "instrument" : input ? "input" : "track");
            event->setProperty("index", slot);
            event->setProperty("automationPrefix", stagePrefix);
            events.add(juce::var(event));
        }
        const auto now = juce::Time::getMillisecondCounter();
        const auto emit = [&] (size_t index, const char* phase, float value, const PluginAutomationCapturedEvent* captured = nullptr) {
            auto& listener = *listeners[index];
            auto* event = new juce::DynamicObject();
            event->setProperty("trackId", trackId);
            event->setProperty("param", (std::strcmp(phase, "references-cleared") == 0 || (listener.parameter && listener.parameter->isAutomatable()))
                ? (stagePrefix.isNotEmpty() ? stagePrefix : slot < 0 ? juce::String("plugin_instrument_0_")
                    : "plugin_" + juce::String(input ? "input_" : "track_") + juce::String(slot) + "_")
                    + juce::String(static_cast<int>(index)) : juce::String());
            event->setProperty("phase", phase);
            event->setProperty("value", value);
            event->setProperty("metadata", listener.metadata);
            if (captured) event->setProperty("initialValue", captured->initialValue);
            event->setProperty("name", owner->getName() + ": " + (listener.parameter ? listener.parameter->getName(128) : juce::String()));
            if (captured && captured->timed)
            {
                event->setProperty("capturedTime", captured->time);
                event->setProperty("transportEpoch", static_cast<juce::int64>(captured->epoch));
                event->setProperty("captureSequence", static_cast<juce::int64>(captured->sequence));
                event->setProperty("capturedWhileRolling", captured->rolling);
                event->setProperty("timing", captured->timing == 2 ? "sample" : captured->timing == 1 ? "block" : "estimated");
            }
            else if (clock)
            {

                const bool rolling = clock->rolling.load(std::memory_order_acquire);
                event->setProperty("capturedTime", clock->estimatedPosition(juce::Time::getHighResolutionTicks(), rolling));
                event->setProperty("capturedWhileRolling", rolling);
                event->setProperty("timing", "estimated");
            }
            events.add(juce::var(event));
        };
        for (const auto& cleared : clearedReferences)
        {
            const int index = static_cast<int>(cleared["index"]);
            if (!juce::isPositiveAndBelow(index, static_cast<int>(listeners.size()))) continue;
            auto& listener = *listeners[static_cast<size_t>(index)];
            listener.state->pending.store(0);
            listener.state->touching.store(false);
            listener.state->gesture.store(false);
            emit(static_cast<size_t>(index), "references-cleared", listener.state->value.load());
            if (auto* event = events.getLast().getDynamicObject()) {
                event->setProperty("clearFlags", cleared["flags"]); event->setProperty("fxIndex", slot); event->setProperty("paramIndex", index);
                event->setProperty("chain", stagePrefix.startsWith("plugin_monitor_") ? "monitor"
                    : stagePrefix.isNotEmpty() ? "master" : slot < 0 ? "instrument" : input ? "input" : "track");
            }
        }
        PluginAutomationCapturedEvent captured;
        while (queue.pop(captured))
        {
            if (!juce::isPositiveAndBelow(captured.parameter, static_cast<int>(listeners.size()))) continue;
            if (clock && captured.epoch != clock->epoch.load(std::memory_order_acquire)) continue;
            if (captured.listenerGeneration != listeners[static_cast<size_t>(captured.parameter)]->generation) continue;
            auto& listener = *listeners[static_cast<size_t>(captured.parameter)];
            if (captured.phase == 2u) listener.lastChange = now;
            if (captured.phase == 4u) listener.state->touching.store(false);
            emit(static_cast<size_t>(captured.parameter), captured.phase == 1u ? "begin" : captured.phase == 2u ? "value" : "end", captured.value, &captured);
        }
        if (const auto lost = dropped.exchange(0, std::memory_order_acq_rel); lost != 0)
        {
            auto* event = new juce::DynamicObject();
            event->setProperty("trackId", trackId); event->setProperty("phase", "overflow");
            event->setProperty("droppedEvents", static_cast<juce::int64>(lost));
            events.add(juce::var(event));
        }
        for (size_t i = 0; i < listeners.size(); ++i)
        {
            auto& listener = *listeners[i];
            auto& state = *listener.state;
            if (const auto lost = state.deliveryDropped.exchange(0); lost != 0)
            {
                auto* event = new juce::DynamicObject(); event->setProperty("trackId", trackId);
                event->setProperty("phase", "playback-overflow"); event->setProperty("droppedEvents", static_cast<juce::int64>(lost));
                events.add(juce::var(event));
            }
            const auto flags = state.pending.exchange(0, std::memory_order_acq_rel);
            const auto latest = state.value.load(std::memory_order_acquire);
            if (finishing && clock && state.touching.exchange(false) && state.capturedWhileRolling.load()
                && state.captureEpoch.load() == clock->epoch.load(std::memory_order_acquire))
            {
                PluginAutomationCapturedEvent final;
                final.timed = true; final.rolling = true; final.time = clock->capturePosition();
                final.epoch = clock->epoch.load(std::memory_order_acquire);
                emit(i, "end", latest, &final);
            }
            if (flags & 1u) emit(i, "begin", latest);
            if (flags & 2u) { listener.lastChange = now; emit(i, "value", latest); }
            // Plugins without gesture callbacks get a short touch timeout.
            if (!state.gesture.load() && ((flags & 4u) || (state.touching.load()
                && now - listener.lastChange >= 180)))
            {
                state.touching.store(false);
                emit(i, "end", latest);
            }
        }
        return metadataChanged;
    }

private:
    bool publishWithFallback(int parameter, unsigned phase, float value, float initialValue, uint64_t generation) noexcept
    {
        PluginAutomationCapturedEvent event;
        event.parameter = parameter; event.phase = phase; event.value = value; event.initialValue = initialValue; event.listenerGeneration = generation;
        event.ticks = juce::Time::getHighResolutionTicks();
        event.epoch = clock ? clock->epoch.load(std::memory_order_acquire) : 0;
        event.rolling = clock && clock->rolling.load(std::memory_order_acquire);
        event.timed = clock != nullptr;
        const auto context = pluginAutomationProcessingContext;
        if (context.processing)
        {
            event.timed = event.timed || context.external || context.epoch != 0;
            if (context.epoch != 0) { event.epoch = context.epoch; event.rolling = context.rolling; }
            event.time = context.position + static_cast<double>(juce::jmax(0, context.offset)) / juce::jmax(1.0, context.sampleRate);
            event.timing = context.offset >= 0 ? 2 : context.timing;
        }
        else if (clock)
        {
            event.time = clock->estimatedPosition(event.ticks, event.rolling);
        }
        if (queue.push(event)) return true;
        dropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override {}
    void audioProcessorChanged(juce::AudioProcessor*, const juce::AudioProcessorListener::ChangeDetails& details) override
    {
        if (details.parameterInfoChanged) metadataPending.store(true, std::memory_order_release);
    }
    struct Listener : juce::AudioProcessorParameter::Listener
    {
        explicit Listener(PluginParameterCapture& captureIn, juce::AudioProcessorParameter& parameterIn) : capture(captureIn), parameter(&parameterIn), generation(++capture.nextListenerGeneration)
        {
            state->value.store(parameter->getValue());
            metadata = pluginParameterCaptureMetadata(capture.owner.get(), parameter->getParameterIndex());
            parameter->addListener(this);
        }
        ~Listener() override { if (parameter) parameter->removeListener(this); }
        void parameterBeingDeleted() override
        {
            parameter = nullptr; state->touching.store(false); state->gesture.store(false); state->pending.store(0);
            capture.metadataPending.store(true, std::memory_order_release);
        }
        void parameterValueChangedAtSampleOffset(int index, float value, int offset) override
        { const ScopedPluginAutomationSampleOffset sample(offset); parameterValueChanged(index, value); }
        void parameterValueChanged(int, float value) override
        {
            if (!parameter || !std::isfinite(value) || !parameter->isAutomatable()
                || (pluginAutomationProcessingContext.processing && !pluginAutomationProcessingContext.external && state->hostAutomating.load())
                || (static_cast<int>(parameter->getCategory()) >> 16) == 2) return;
            const auto previous = state->value.exchange(juce::jlimit(0.0f, 1.0f, value), std::memory_order_acq_rel);
            state->touching.store(true);
            storeCaptureClock();
            if (!capture.publishWithFallback(parameter->getParameterIndex(), 2u, state->value.load(std::memory_order_acquire), previous, generation)) state->pending.fetch_or(2u, std::memory_order_release);
        }
        void parameterGestureChanged(int, bool starting) override
        {
            if (!parameter) return;
            state->gesture.store(starting);
            if (starting) { state->value.store(parameter->getValue()); state->touching.store(true); storeCaptureClock(); }
            if (!capture.publishWithFallback(parameter->getParameterIndex(), starting ? 1u : 4u, state->value.load(std::memory_order_acquire), state->value.load(std::memory_order_acquire), generation))
                state->pending.fetch_or(starting ? 1u : 4u, std::memory_order_release);
        }
        void storeCaptureClock() noexcept
        {
            const auto context = pluginAutomationProcessingContext;
            const bool contextual = context.processing && context.epoch != 0;
            state->capturedWhileRolling.store(contextual ? context.rolling : capture.clock && capture.clock->rolling.load(std::memory_order_acquire));
            state->captureEpoch.store(contextual ? context.epoch : capture.clock ? capture.clock->epoch.load(std::memory_order_acquire) : 0);
        }
        PluginParameterCapture& capture;
        juce::AudioProcessorParameter* parameter;
        const uint64_t generation;
        juce::var metadata;
        std::shared_ptr<State> state = std::make_shared<State>();
        juce::uint32 lastChange = 0;
    };
    std::shared_ptr<juce::AudioProcessor> owner;
    std::shared_ptr<PluginAutomationClock> clock;
    PluginAutomationEventQueue queue;
    std::atomic<uint64_t> dropped { 0 };
    std::vector<std::unique_ptr<Listener>> listeners;
    std::atomic<bool> metadataPending { false };
    uint64_t nextListenerGeneration = 0;
};
