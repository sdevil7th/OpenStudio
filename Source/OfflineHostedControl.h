#pragma once
#include <JuceHeader.h>
#include <deque>
#include <future>
#include <type_traits>
#include <stdexcept>

// Teardown drains only hosted-control work while joining workers, without
// dispatching arbitrary UI events into components that are being destroyed.
class OfflineHostedControls
{
public:
    static OfflineHostedControls& instance()
    {
        static OfflineHostedControls controls;
        return controls;
    }

    void enqueue(std::function<void()> work)
    {
        const juce::ScopedLock guard(lock);
        pending.push_back(std::move(work));
        if (!juce::MessageManager::callAsync([] { instance().drain(); }))
        {
            pending.pop_back();
            throw std::runtime_error("Hosted plugin control could not reach the message thread");
        }
    }

    void drain()
    {
        jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
        std::deque<std::function<void()>> tasks;
        {
            const juce::ScopedLock guard(lock);
            tasks.swap(pending);
        }
        for (auto& task : tasks) task();
    }

private:
    juce::CriticalSection lock;
    std::deque<std::function<void()>> pending;
};

// Never call from the audio thread. Message-thread mutations must use the
// nonblocking mutation queue while an offline transaction owns their lock.
template<typename Function>
auto runOfflineHostedControl(Function&& function) -> std::invoke_result_t<Function>
{
    if (juce::MessageManager::getInstance()->isThisTheMessageThread()) return function();
    using Result = std::invoke_result_t<Function>;
    auto task = std::make_shared<std::packaged_task<Result()>>(std::forward<Function>(function));
    auto future = task->get_future();
    OfflineHostedControls::instance().enqueue([task] { (*task)(); });
    return future.get();
}
