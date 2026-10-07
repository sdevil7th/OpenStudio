#pragma once
#include <JuceHeader.h>
#include <atomic>

// Message-thread registry owns tickets before queuing work. Cancellation and
// heartbeat never wait behind the capture worker or the alignment operation.
struct BuiltInWorkerJob
{
    std::atomic<bool> cancelled{false}, complete{false};
    std::atomic<double> heartbeat{juce::Time::getMillisecondCounterHiRes()}, progress{0};
    std::atomic<int> stage{0}; // queued, prepare/capture, render/analyze, finished
    void touch() noexcept { heartbeat.store(juce::Time::getMillisecondCounterHiRes()); }
    void cancel() noexcept { cancelled.store(true); }
    bool keepRunning() const noexcept
    {
        return !cancelled.load() && juce::Time::getMillisecondCounterHiRes()-heartbeat.load()<6000;
    }
    juce::var status() const
    {
        auto* value=new juce::DynamicObject();value->setProperty("success",true);
        value->setProperty("progress",progress.load());value->setProperty("stage",stage.load());
        value->setProperty("cancelled",cancelled.load());value->setProperty("complete",complete.load());return value;
    }
};
