#pragma once
#include <JuceHeader.h>
#include <mutex>

class ToneSearchRequest
{
public:
    explicit ToneSearchRequest(juce::String requestId) : id(std::move(requestId)) {}
    const juce::String id;
    std::atomic<bool> cancelled { false };
    void attach(const std::shared_ptr<juce::WebInputStream>& next)
    {
        const std::lock_guard<std::mutex> lock(mutex);
        stream = next;
        if (cancelled.load()) next->cancel();
    }
    void cancel()
    {
        cancelled.store(true);
        std::shared_ptr<juce::WebInputStream> active;
        { const std::lock_guard<std::mutex> lock(mutex); active = stream; }
        if (active) active->cancel();
    }
private:
    std::mutex mutex;
    std::shared_ptr<juce::WebInputStream> stream;
};
