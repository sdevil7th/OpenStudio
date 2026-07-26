#pragma once

#include <JuceHeader.h>
#include <functional>
#include <memory>

class MainComponent;

class MixerWindowManager : private juce::Timer
{
public:
    using ComponentFactory = std::function<std::unique_ptr<MainComponent>()>;
    using ClosedCallback = std::function<void(const juce::Rectangle<int>&)>;

    MixerWindowManager(ComponentFactory componentFactoryIn,
                       ClosedCallback closedCallbackIn,
                       juce::String windowTitleIn = "Mixer",
                       juce::Rectangle<int> defaultBoundsIn = { 120, 120, 1280, 540 },
                       int minWidthIn = 900,
                       int minHeightIn = 380);
    ~MixerWindowManager();

    bool open(const juce::Rectangle<int>& bounds);
    bool prewarm(const juce::Rectangle<int>& bounds);
    bool focus();
    bool hide();
    bool close();
    bool isOpen() const;
    juce::String getStateDescription() const;

private:
    class MixerWindow;

    enum class WindowState
    {
        idle,
        creating,
        readyHidden,
        visible,
        closing,
        retired
    };

    struct PendingRequest
    {
        enum class Type
        {
            none,
            open,
            prewarm,
            focus
        };

        Type type = Type::none;
        juce::Rectangle<int> bounds;
    };

    static const char* stateToString(WindowState state) noexcept;
    static bool isGlobalCloseInProgress() noexcept;
    static bool isGlobalCreateInProgress() noexcept;
    static bool isGlobalLifecycleBusy() noexcept;
    static void addPendingManager(MixerWindowManager& manager);
    static void drainGlobalPendingRequests();
    static void beginGlobalCreateSlot(const juce::String& title);
    static void releaseGlobalCreateSlot(const juce::String& title);
    bool ensureMessageThread(const char* action) const;
    bool createWindow(const juce::Rectangle<int>& targetBounds, bool visible);
    void scheduleStartupNudge();
    void beginClose(bool notifyClosed);
    void finishClose();
    void releaseGlobalCloseSlot();
    void setState(WindowState nextState, const juce::String& reason = {});
    void queuePendingRequest(PendingRequest::Type type, const juce::Rectangle<int>& bounds = {});
    void runPendingRequest();
    void timerCallback() override;

    ComponentFactory componentFactory;
    ClosedCallback closedCallback;
    juce::String windowTitle;
    juce::Rectangle<int> defaultBounds;
    int minWidth = 900;
    int minHeight = 380;
    WindowState state = WindowState::idle;
    PendingRequest pendingRequest;
    std::unique_ptr<MixerWindow> mixerWindow;
    std::unique_ptr<MixerWindow> closingWindow;
    bool countedGlobalClose = false;
    bool closePendingUntilStartupSettles = false;
    juce::int64 closeStartedMs = 0;

    static constexpr int closeDestroyDelayMs = 1500;
    static constexpr int closeReadinessPollMs = 250;
    static constexpr int closeStartupMaxWaitMs = 8000;
    static constexpr int createSettleDelayMs = 1200;
    static constexpr int startupNudgeDelayMs = 600;
    static int globalCloseDepth;
    static int globalCreateDepth;
    static juce::Array<MixerWindowManager*> managersWithPendingRequests;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MixerWindowManager)
};
