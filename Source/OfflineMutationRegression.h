#pragma once
#include "MessageMutationQueue.h"
#include "OwnedBackgroundTasks.h"
#include <atomic>

inline juce::var checkOfflineMutationDispatch()
{
    juce::CriticalSection mutationLock;
    MessageMutationQueue mutations;
    MessageThreadLifetime view;
    OwnedBackgroundTasks workers;
    juce::WaitableEvent acquired;
    std::atomic<bool> hostedOnMessageThread { false }, finished { false }, exceptionForwarded { false };
    workers.addJob([&] {
        const juce::ScopedLock guard(mutationLock);
        acquired.signal();
        runOfflineHostedControl([&] {
            hostedOnMessageThread.store(juce::MessageManager::getInstance()->isThisTheMessageThread());
        });
        try { runOfflineHostedControl([] { throw std::runtime_error("fixture"); }); }
        catch (const std::runtime_error&) { exceptionForwarded.store(true); }
        finished.store(true);
    });
    const bool locked = acquired.wait(2000);
    std::vector<int> sequence;
    mutations.enqueue(mutationLock, view.token(), [&] { sequence.push_back(1); });
    mutations.enqueue(mutationLock, view.token(), [&] { sequence.push_back(2); });
    const bool deferred = locked && sequence.empty() && !finished.load();
    // This joins a worker waiting for hosted control without running arbitrary
    // message-loop events. The old blocking join deadlocked here.
    workers.shutdown();
    mutations.dispatchReady();
    const bool ordered = sequence == std::vector<int> { 1, 2 };
    view.invalidate();
    mutations.enqueue(mutationLock, view.token(), [&] { sequence.push_back(3); });
    const bool retired = sequence.size() == 2;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Offline/UI mutation and shutdown dispatch");
    result->setProperty("pass", deferred && ordered && retired && finished.load()
        && hostedOnMessageThread.load() && exceptionForwarded.load());
    result->setProperty("nonblockingMutation", deferred);
    result->setProperty("fifoOrder", ordered);
    result->setProperty("retiredViewSkipped", retired);
    result->setProperty("shutdownCompleted", finished.load());
    result->setProperty("hostedOnMessageThread", hostedOnMessageThread.load());
    result->setProperty("exceptionForwarded", exceptionForwarded.load());
    return juce::var(result);
}
