#pragma once
#include <JuceHeader.h>

// The transport owns Store package handles. All callbacks run on the message
// thread; cancel invalidates pending callbacks, including queued progress.
class StoreUpdateTransport
{
public:
    struct Result
    {
        enum Kind { available, current, downloaded, installed, cancelled, error } kind = error;
        juce::String message;
    };
    using Done = std::function<void(Result)>;
    using Progress = std::function<void(double)>;
    virtual ~StoreUpdateTransport() = default;
    virtual void check(Done) = 0;
    virtual void transfer(bool install, Progress, Done) = 0;
    virtual void cancel() = 0;
};

// Shared update UX, with Store-owned delivery. Never opens an EXE installer.
class StoreUpdater
{
public:
    using Callback = std::function<void(const juce::var&)>;
    explicit StoreUpdater(Callback status,
                          std::unique_ptr<StoreUpdateTransport> transport = {});
    ~StoreUpdater();
    void check(bool manual, Callback = {});
    void download(Callback = {});
    void install(Callback = {});
    void cancel();
    void shutdown();
private:
    struct State;
    std::shared_ptr<State> state;
};
