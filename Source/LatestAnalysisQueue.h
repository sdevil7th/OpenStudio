#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <utility>

// Message/worker threads only. One running request and one replaceable pending
// request bound both CPU work and retained source data during rapid Analyze/Cancel.
class LatestAnalysisQueue final : private juce::Thread
{
public:
    using Work = std::function<juce::var(const std::atomic<bool>&)>;
    using Completion = std::function<void(juce::var)>;
    LatestAnalysisQueue() : juce::Thread("Clip tempo analysis") { startThread(juce::Thread::Priority::low); }
    ~LatestAnalysisQueue() override { shutdown(); }

    static juce::var cancelledResult()
    {
        auto* result = new juce::DynamicObject();
        result->setProperty("cancelled", true);
        result->setProperty("error", "Tempo analysis cancelled.");
        result->setProperty("source", "audio");
        result->setProperty("confidence", 0.0);
        result->setProperty("candidates", juce::Array<juce::var>());
        return juce::var(result);
    }

    void submit(juce::String id, Work work, Completion completion)
    {
        auto request = std::make_shared<Request>(std::move(id), std::move(work), std::move(completion));
        std::shared_ptr<Request> retired;
        {
            const std::lock_guard<std::mutex> lock(mutex);
            if (stopping) retired = request;
            else
            {
                if (active) active->cancelled.store(true);
                retired = std::exchange(pending, request);
            }
        }
        if (retired) retired->completion(cancelledResult());
        notify();
    }

    void cancel(const juce::String& id)
    {
        const std::lock_guard<std::mutex> lock(mutex);
        for (const auto& request : { active, pending })
            if (request && request->id == id) request->cancelled.store(true);
        notify();
    }

    void shutdown()
    {
        {
            const std::lock_guard<std::mutex> lock(mutex);
            stopping = true;
            if (active) active->cancelled.store(true);
            if (pending) pending->cancelled.store(true);
        }
        notify();
        // Never force-terminate inside a decoder or allocator. Work cooperates.
        stopThread(-1);
    }

private:
    struct Request
    {
        Request(juce::String key, Work task, Completion done)
            : id(std::move(key)), work(std::move(task)), completion(std::move(done)) {}
        juce::String id;
        Work work;
        Completion completion;
        std::atomic<bool> cancelled { false };
    };
    std::mutex mutex;
    std::shared_ptr<Request> active, pending;
    bool stopping = false;

    void run() override
    {
        for (;;)
        {
            std::shared_ptr<Request> request;
            {
                const std::lock_guard<std::mutex> lock(mutex);
                request = std::exchange(pending, {});
                active = request;
                if (!request && stopping) return;
            }
            if (!request) { wait(-1); continue; }
            auto result = request->cancelled.load() ? cancelledResult() : request->work(request->cancelled);
            if (request->cancelled.load()) result = cancelledResult();
            {
                const std::lock_guard<std::mutex> lock(mutex);
                active.reset();
            }
            request->completion(std::move(result));
        }
    }
};
