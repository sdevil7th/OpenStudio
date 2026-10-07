#pragma once

#include <JuceHeader.h>

// Only the recording fault-injection fixtures use this scope. JUCE asserts
// when their deliberately broken stream cannot seek to its WAV header. Keep
// those two expected diagnostics visible and forward every other assertion to
// debug output. The previous logger is restored when the scope ends.
class ExpectedWavFailureLog final : private juce::Logger
{
public:
    explicit ExpectedWavFailureLog(bool injectedSeekFailure)
        : previous(juce::Logger::getCurrentLogger()), active(injectedSeekFailure)
    {
        if (active)
            juce::Logger::setCurrentLogger(this);
    }

    ~ExpectedWavFailureLog() override
    {
        if (active)
            juce::Logger::setCurrentLogger(previous);
    }

private:
    void logMessage(const juce::String& message) override
    {
        const auto line = message.trim();
        const bool expected = juce::Thread::getCurrentThreadId() == ownerThread
            && (line == "JUCE Assertion failure in juce_WavAudioFormat.cpp:1702"
                || line == "JUCE Assertion failure in juce_WavAudioFormat.cpp:1723");
        const auto forwarded = expected
            ? "diagnostic_only: injected WAV header seek failure at " + line.fromLastOccurrenceOf(" in ", false, false)
            : message;
        juce::Logger::outputDebugString(forwarded);
    }

    juce::Logger* previous;
    bool active;
    const juce::Thread::ThreadID ownerThread = juce::Thread::getCurrentThreadId();
};
