#pragma once
#include <JuceHeader.h>
#include "MessageThreadLifetime.h"

// Message-thread-owned, non-realtime work. Invalidate queued UI completions
// first, then join running work while its captured dependencies still exist.
class OwnedBackgroundTasks
{
public:
    ~OwnedBackgroundTasks() { shutdown(); }
    MessageThreadLifetime::Token token() const { return lifetime.token(); }
    void addJob(std::function<void()> work)
    {
        if (!MessageThreadLifetime::accepts(token())) return;
        pool.addJob([alive = token(), work = std::move(work)] {
            if (MessageThreadLifetime::accepts(alive)) work();
        });
    }
    template <typename Completion>
    std::shared_ptr<Completion> guardCompletion(Completion completion) const
    {
        return std::make_shared<Completion>([alive = token(), completion = std::move(completion)](auto result) {
            // Called only on the message thread, the same thread as shutdown.
            if (MessageThreadLifetime::accepts(alive)) completion(std::move(result));
        });
    }
    void cancelPending() { lifetime.invalidate(); }
    void shutdown()
    {
        cancelPending();
        pool.removeAllJobs(true, -1);
    }
private:
    MessageThreadLifetime lifetime;
    juce::ThreadPool pool { 1, juce::Thread::osDefaultStackSize, juce::Thread::Priority::low };
};
