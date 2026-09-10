#pragma once
#include <JuceHeader.h>
#include <memory>
#include <atomic>

// Control/worker threads only. Windows children start suspended, enter an owned
// kill-on-close Job, then resume. Output reads never wait for another byte.
class OwnedChildProcess
{
public:
    OwnedChildProcess();
    ~OwnedChildProcess();
    bool start(const juce::StringArray& arguments, int streamFlags = 3);
    bool isRunning() const;
    int readProcessOutput(void* destination, int capacity);
    bool kill();
    bool waitForProcessToFinish(int timeoutMs, const std::atomic<bool>& keepRunning);
    juce::uint32 getExitCode() const;
    unsigned long getProcessId() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl;
    JUCE_DECLARE_NON_COPYABLE(OwnedChildProcess)
};
