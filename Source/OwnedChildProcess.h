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
    // Overrides apply only to this child; secrets need not enter argv or the parent environment.
    bool start(const juce::StringArray& arguments, int streamFlags = 3,
               const juce::StringPairArray& environmentOverrides = {}, std::intptr_t inputHandle = -1);
    bool isRunning() const;
    int readProcessOutput(void* destination, int capacity);
    bool kill();
    // A stop request is not a retirement acknowledgement. Control threads may
    // wait boundedly before reusing a worker's memory budget or scratch files.
    bool terminateAndWait(int timeoutMs = 2000);
    bool retirementConfirmed() const;
    bool waitForProcessToFinish(int timeoutMs, const std::atomic<bool>& keepRunning);
    juce::uint32 getExitCode() const;
    unsigned long getProcessId() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl;
    JUCE_DECLARE_NON_COPYABLE(OwnedChildProcess)
};
