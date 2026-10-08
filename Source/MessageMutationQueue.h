#pragma once
#include <JuceHeader.h>
#include "MessageThreadLifetime.h"
#include <deque>

// Message-thread mutations wait in FIFO order without blocking the message
// pump needed by hosted-plugin setup during an offline transaction.
class MessageMutationQueue : private juce::Timer
{
public:
    void enqueue(juce::CriticalSection& lock, MessageThreadLifetime::Token alive,
                 std::function<void()> work)
    {
        jassert(juce::MessageManager::getInstance()->isThisTheMessageThread());
        requests.push_back({ &lock, std::move(alive), std::move(work) });
        drain();
    }

    void cancel()
    {
        stopTimer();
        requests.clear();
    }

    void dispatchReady() { drain(); }

private:
    struct Request
    {
        juce::CriticalSection* lock;
        MessageThreadLifetime::Token alive;
        std::function<void()> work;
    };
    std::deque<Request> requests;
    bool draining = false;

    void timerCallback() override { drain(); }
    void drain()
    {
        if (draining) return;
        const juce::ScopedValueSetter<bool> guard(draining, true);
        while (!requests.empty())
        {
            if (!MessageThreadLifetime::accepts(requests.front().alive))
            {
                requests.pop_front();
                continue;
            }
            const juce::ScopedTryLock lock(*requests.front().lock);
            if (!lock.isLocked()) { startTimer(10); return; }
            auto request = std::move(requests.front());
            requests.pop_front();
            request.work();
        }
        stopTimer();
    }
};
