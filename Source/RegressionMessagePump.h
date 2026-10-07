#pragma once

#include <JuceHeader.h>

// Headless native regressions run synchronously on the message thread. Drain
// their normal processor notifications between checks, as the live app would,
// instead of filling JUCE's bounded Linux wake-up socket during long matrices.
namespace OpenStudioRegression
{
inline thread_local bool messagePumpEnabled = false;
inline thread_local juce::uint32 lastMessagePumpMs = 0;
}

class ScopedHeadlessRegressionMessages
{
public:
    explicit ScopedHeadlessRegressionMessages(bool enabled)
        : previous(OpenStudioRegression::messagePumpEnabled)
    {
        OpenStudioRegression::messagePumpEnabled = enabled;
    }

    ~ScopedHeadlessRegressionMessages()
    {
        OpenStudioRegression::messagePumpEnabled = previous;
    }

private:
    bool previous;
};

inline void pumpRegressionMessages()
{
    if (! OpenStudioRegression::messagePumpEnabled)
        return;
    const auto now = juce::Time::getMillisecondCounter();
    if (now - OpenStudioRegression::lastMessagePumpMs < 25)
        return;
    if (auto* manager = juce::MessageManager::getInstanceWithoutCreating();
        manager != nullptr && manager->isThisTheMessageThread())
    {
        OpenStudioRegression::lastMessagePumpMs = now;
        manager->runDispatchLoopUntil(1);
    }
}
