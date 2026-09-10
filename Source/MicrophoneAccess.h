#pragma once
#include <juce_core/juce_core.h>
#include <functional>

namespace MicrophoneAccess
{
enum class Status { notDetermined, authorized, denied, restricted };

#if JUCE_MAC
Status status();
// Completes on the message thread. Concurrent callers share one OS request.
void request(std::function<void(bool)> completion);
#else
inline Status status() { return Status::authorized; }
inline void request(std::function<void(bool)> completion) { completion(true); }
#endif

inline juce::String statusName()
{
    switch (status())
    {
        case Status::notDetermined: return "notDetermined";
        case Status::authorized: return "authorized";
        case Status::denied: return "denied";
        case Status::restricted: return "restricted";
    }
    return "restricted";
}
}
