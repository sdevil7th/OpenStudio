#pragma once
#include <juce_core/juce_core.h>

namespace AIRuntimeMaintenance
{
juce::File dataRoot();
juce::File requestFile(const juce::File& root);
juce::Result requestOnNextLaunch(const juce::File& root, bool compiler);

// Held for the entire lifetime of a DAW or maintenance session. Acquisition
// is nonblocking and happens before opening audio devices or starting repair.
class SessionLease final
{
public:
    enum class Mode { workstation, maintenance };
    SessionLease() = default;
    SessionLease(SessionLease&&) noexcept;
    ~SessionLease();
    juce::Result acquire(const juce::File& root, Mode);
    bool isHeld() const noexcept { return handle != -1; }
    bool isMaintenance() const noexcept { return isHeld() && exclusive; }
    // Duplicate onto the installer's otherwise empty stdin. An orphaned worker
    // retains the OS lock until it exits, including after an abrupt host exit.
    std::intptr_t workerInput() const noexcept { return isMaintenance() ? handle : -1; }
private:
    std::intptr_t handle = -1;
    bool exclusive = false;
    JUCE_DECLARE_NON_COPYABLE(SessionLease)
};
}
