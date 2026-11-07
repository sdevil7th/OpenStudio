#pragma once
#include <JuceHeader.h>

// Process ownership only. Model-specific byte admission remains in the shared
// Python planner. Never call from the realtime audio callback.
class AIResourceCoordinator
{
public:
    enum class Owner { none, generation, separation, installation, maintenance };
    using Token = juce::uint64;

    Token begin(Owner owner)
    {
        const juce::ScopedLock guard(lock);
        if (owner == Owner::none || active != Owner::none) return 0;
        active = owner;
        if (owner == Owner::generation) warmGeneration = false;
        token = ++serial;
        return token;
    }

    bool finish(Token completed, bool generationStillWarm = false)
    {
        const juce::ScopedLock guard(lock);
        if (completed == 0 || completed != token || active == Owner::none) return false;
        if (active == Owner::generation) warmGeneration = generationStillWarm;
        active = Owner::none;
        token = 0;
        return true;
    }

    void confirmIdleGenerationReleased()
    {
        const juce::ScopedLock guard(lock);
        // Call only after the engine has acknowledged retirement. A heartbeat
        // or a request to stop is not evidence that memory has been released.
        warmGeneration = false;
    }

    void observe(Token current, const juce::var& details)
    {
        const juce::ScopedLock guard(lock);
        if (current != 0 && current == token) lastDetails = details;
    }

    juce::var snapshot() const
    {
        const juce::ScopedLock guard(lock);
        auto result = std::make_unique<juce::DynamicObject>();
        const auto name = active == Owner::generation ? "generation" : active == Owner::separation ? "separation"
            : active == Owner::installation ? "installation" : active == Owner::maintenance ? "releasing-idle-memory" : "idle";
        result->setProperty("owner", name);
        result->setProperty("jobToken", static_cast<juce::int64>(token));
        result->setProperty("generationWorkerWarm", warmGeneration);
        result->setProperty("lastMeasurements", lastDetails);
        return juce::var(result.release());
    }

private:
    mutable juce::CriticalSection lock;
    Owner active = Owner::none;
    Token serial = 0, token = 0;
    bool warmGeneration = false;
    juce::var lastDetails;
};
