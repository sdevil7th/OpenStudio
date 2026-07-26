#include "MixerWindowManager.h"
#include "MainComponent.h"

namespace
{
juce::Rectangle<int> sanitiseWindowBounds(const juce::Rectangle<int>& requested,
                                          const juce::Rectangle<int>& defaultBounds,
                                          int minWidth,
                                          int minHeight)
{
    auto bounds = requested;
    if (bounds.getWidth() <= 0 || bounds.getHeight() <= 0)
        bounds = defaultBounds;

    bounds.setWidth(juce::jmax(minWidth, bounds.getWidth()));
    bounds.setHeight(juce::jmax(minHeight, bounds.getHeight()));

    if (auto* display = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay())
    {
        const auto area = display->userArea;
        if (bounds.getWidth() > area.getWidth())
            bounds.setWidth(area.getWidth());
        if (bounds.getHeight() > area.getHeight())
            bounds.setHeight(area.getHeight());
        if (! area.contains(bounds))
            bounds = bounds.withPosition(area.getX() + 40, area.getY() + 40);
    }

    return bounds;
}

juce::String describeBounds(const juce::Rectangle<int>& bounds)
{
    return juce::String(bounds.getX()) + "," + juce::String(bounds.getY())
        + " " + juce::String(bounds.getWidth()) + "x" + juce::String(bounds.getHeight());
}
}

class MixerWindowManager::MixerWindow : public juce::DocumentWindow
{
public:
    MixerWindow(MixerWindowManager& ownerIn, std::unique_ptr<MainComponent> content)
        : juce::DocumentWindow(ownerIn.windowTitle,
                               juce::Colours::black,
                               juce::DocumentWindow::allButtons),
          owner(ownerIn)
    {
        setUsingNativeTitleBar(true);
        setResizable(true, true);
        setResizeLimits(owner.minWidth, owner.minHeight, 10000, 10000);
        setContentOwned(content.release(), true);
    }

    void closeButtonPressed() override
    {
        owner.close();
    }

    MainComponent* getHostedComponent() const
    {
        return dynamic_cast<MainComponent*>(getContentComponent());
    }

private:
    MixerWindowManager& owner;
};

int MixerWindowManager::globalCloseDepth = 0;
int MixerWindowManager::globalCreateDepth = 0;
juce::Array<MixerWindowManager*> MixerWindowManager::managersWithPendingRequests;

MixerWindowManager::MixerWindowManager(ComponentFactory componentFactoryIn,
                                       ClosedCallback closedCallbackIn,
                                       juce::String windowTitleIn,
                                       juce::Rectangle<int> defaultBoundsIn,
                                       int minWidthIn,
                                       int minHeightIn)
    : componentFactory(std::move(componentFactoryIn)),
      closedCallback(std::move(closedCallbackIn)),
      windowTitle(std::move(windowTitleIn)),
      defaultBounds(defaultBoundsIn),
      minWidth(minWidthIn),
      minHeight(minHeightIn)
{
}

MixerWindowManager::~MixerWindowManager()
{
    stopTimer();
    managersWithPendingRequests.removeFirstMatchingValue(this);
    pendingRequest = {};

    if (mixerWindow != nullptr)
    {
        juce::Logger::writeToLog("Secondary window destroyed during manager shutdown: "
                                 + windowTitle + " state=" + getStateDescription());
        if (auto* hosted = mixerWindow->getHostedComponent())
            hosted->prepareForSecondaryWindowClose();
        mixerWindow->setVisible(false);
        mixerWindow = nullptr;
    }

    if (closingWindow != nullptr)
    {
        juce::Logger::writeToLog("Secondary closing window destroyed during manager shutdown: "
                                 + windowTitle + " state=" + getStateDescription());
        if (auto* hosted = closingWindow->getHostedComponent())
            hosted->prepareForSecondaryWindowClose();
        closingWindow->setVisible(false);
        closingWindow = nullptr;
    }

    releaseGlobalCloseSlot();
    state = WindowState::idle;
}

bool MixerWindowManager::open(const juce::Rectangle<int>& bounds)
{
    if (! ensureMessageThread("open"))
        return false;

    const auto targetBounds = sanitiseWindowBounds(bounds, defaultBounds, minWidth, minHeight);

    if (state == WindowState::closing
        || state == WindowState::retired
        || (mixerWindow == nullptr && isGlobalLifecycleBusy()))
    {
        queuePendingRequest(PendingRequest::Type::open, targetBounds);
        return true;
    }

    if (mixerWindow != nullptr)
    {
        mixerWindow->setBounds(targetBounds);
        mixerWindow->setVisible(true);
        mixerWindow->toFront(true);
        setState(WindowState::visible, "open existing bounds=" + describeBounds(targetBounds));
        scheduleStartupNudge();
        return true;
    }

    setState(WindowState::creating, "open requested bounds=" + describeBounds(targetBounds));
    return createWindow(targetBounds, true);
}

bool MixerWindowManager::prewarm(const juce::Rectangle<int>& bounds)
{
    if (! ensureMessageThread("prewarm"))
        return false;

    const auto targetBounds = sanitiseWindowBounds(bounds, defaultBounds, minWidth, minHeight);

    if (state == WindowState::closing
        || state == WindowState::retired
        || (mixerWindow == nullptr && isGlobalLifecycleBusy()))
    {
        queuePendingRequest(PendingRequest::Type::prewarm, targetBounds);
        return true;
    }

    if (mixerWindow != nullptr)
    {
        mixerWindow->setBounds(targetBounds);
        mixerWindow->setVisible(false);
        setState(WindowState::readyHidden, "prewarm existing bounds=" + describeBounds(targetBounds));
        return true;
    }

    setState(WindowState::creating, "prewarm requested bounds=" + describeBounds(targetBounds));
    return createWindow(targetBounds, false);
}

bool MixerWindowManager::close()
{
    if (! ensureMessageThread("close"))
        return false;

    if (state == WindowState::closing || state == WindowState::retired)
    {
        juce::Logger::writeToLog("Secondary window close ignored because close is already in progress: "
                                 + windowTitle + " state=" + getStateDescription());
        return true;
    }

    if (mixerWindow == nullptr)
    {
        if (pendingRequest.type != PendingRequest::Type::none)
        {
            juce::Logger::writeToLog("Secondary window close cancelled pending request before creation: "
                                     + windowTitle + " state=" + getStateDescription());
            pendingRequest = {};
            managersWithPendingRequests.removeFirstMatchingValue(this);
            return true;
        }

        juce::Logger::writeToLog("Secondary window close ignored because no active window exists: "
                                 + windowTitle + " state=" + getStateDescription());
        return state == WindowState::idle;
    }

    juce::Logger::writeToLog("Secondary window close requested: " + windowTitle
                             + " state=" + getStateDescription());

    if (auto* hosted = mixerWindow->getHostedComponent())
    {
        if (! hosted->hasFrontendStartupReachedTerminalState())
        {
            closePendingUntilStartupSettles = true;
            closeStartedMs = juce::Time::currentTimeMillis();
            setState(WindowState::closing,
                     "close pending until frontend startup settles startupState=" + hosted->getFrontendStartupStateDescription());

            if (! countedGlobalClose)
            {
                countedGlobalClose = true;
                ++globalCloseDepth;
                juce::Logger::writeToLog("Secondary window global close depth: "
                                         + juce::String(globalCloseDepth)
                                         + " after pending close " + windowTitle);
            }

            startTimer(closeReadinessPollMs);
            return true;
        }
    }

    beginClose(true);
    return true;
}

bool MixerWindowManager::focus()
{
    if (! ensureMessageThread("focus"))
        return false;

    if (state == WindowState::closing || state == WindowState::retired)
    {
        queuePendingRequest(PendingRequest::Type::focus);
        return true;
    }

    if (mixerWindow == nullptr
        && (isGlobalLifecycleBusy() || pendingRequest.type != PendingRequest::Type::none))
    {
        queuePendingRequest(PendingRequest::Type::focus);
        return true;
    }

    if (mixerWindow == nullptr)
    {
        juce::Logger::writeToLog("Secondary window focus ignored because no active window exists: "
                                 + windowTitle + " state=" + getStateDescription());
        return false;
    }

    mixerWindow->setVisible(true);
    mixerWindow->toFront(true);
    setState(WindowState::visible, "focus");
    scheduleStartupNudge();
    return true;
}

bool MixerWindowManager::hide()
{
    if (! ensureMessageThread("hide"))
        return false;

    if (state == WindowState::closing || state == WindowState::retired)
        return true;

    if (state == WindowState::readyHidden)
        return true;

    if (mixerWindow == nullptr)
    {
        if (pendingRequest.type != PendingRequest::Type::none)
        {
            juce::Logger::writeToLog("Secondary window hide cancelled pending request before creation: "
                                     + windowTitle + " state=" + getStateDescription());
            pendingRequest = {};
            managersWithPendingRequests.removeFirstMatchingValue(this);
            return true;
        }

        juce::Logger::writeToLog("Secondary window hide ignored because no active window exists: "
                                 + windowTitle + " state=" + getStateDescription());
        return state == WindowState::idle;
    }

    const auto bounds = mixerWindow->getBounds();
    mixerWindow->setVisible(false);
    setState(WindowState::readyHidden, "hide bounds=" + describeBounds(bounds));

    if (closedCallback)
        closedCallback(bounds);

    return true;
}

bool MixerWindowManager::isOpen() const
{
    return mixerWindow != nullptr && mixerWindow->isVisible() && state == WindowState::visible;
}

juce::String MixerWindowManager::getStateDescription() const
{
    return stateToString(state);
}

const char* MixerWindowManager::stateToString(WindowState stateIn) noexcept
{
    switch (stateIn)
    {
        case WindowState::idle: return "idle";
        case WindowState::creating: return "creating";
        case WindowState::readyHidden: return "readyHidden";
        case WindowState::visible: return "visible";
        case WindowState::closing: return "closing";
        case WindowState::retired: return "retired";
    }

    return "unknown";
}

bool MixerWindowManager::isGlobalCloseInProgress() noexcept
{
    return globalCloseDepth > 0;
}

bool MixerWindowManager::isGlobalCreateInProgress() noexcept
{
    return globalCreateDepth > 0;
}

bool MixerWindowManager::isGlobalLifecycleBusy() noexcept
{
    return isGlobalCloseInProgress() || isGlobalCreateInProgress();
}

void MixerWindowManager::addPendingManager(MixerWindowManager& manager)
{
    if (! managersWithPendingRequests.contains(&manager))
        managersWithPendingRequests.add(&manager);
}

void MixerWindowManager::drainGlobalPendingRequests()
{
    if (isGlobalLifecycleBusy() || managersWithPendingRequests.isEmpty())
        return;

    while (! isGlobalLifecycleBusy() && ! managersWithPendingRequests.isEmpty())
    {
        auto* manager = managersWithPendingRequests.getFirst();
        managersWithPendingRequests.remove(0);

        if (manager != nullptr)
            manager->runPendingRequest();
    }
}

void MixerWindowManager::beginGlobalCreateSlot(const juce::String& title)
{
    ++globalCreateDepth;
    juce::Logger::writeToLog("Secondary window global create depth: "
                             + juce::String(globalCreateDepth)
                             + " after creating " + title);

    juce::Timer::callAfterDelay(createSettleDelayMs, [title]()
    {
        releaseGlobalCreateSlot(title);
    });
}

void MixerWindowManager::releaseGlobalCreateSlot(const juce::String& title)
{
    globalCreateDepth = juce::jmax(0, globalCreateDepth - 1);
    juce::Logger::writeToLog("Secondary window global create depth: "
                             + juce::String(globalCreateDepth)
                             + " after settling " + title);
    drainGlobalPendingRequests();
}

bool MixerWindowManager::ensureMessageThread(const char* action) const
{
    if (juce::MessageManager::getInstance()->isThisTheMessageThread())
        return true;

    juce::Logger::writeToLog("Secondary window " + juce::String(action)
                             + " rejected off message thread: " + windowTitle);
    jassertfalse;
    return false;
}

bool MixerWindowManager::createWindow(const juce::Rectangle<int>& targetBounds, bool visible)
{
    if (! componentFactory)
    {
        setState(WindowState::idle, "component factory missing");
        return false;
    }

    beginGlobalCreateSlot(windowTitle);
    auto content = componentFactory();
    if (content == nullptr)
    {
        releaseGlobalCreateSlot(windowTitle);
        setState(WindowState::idle, "component factory returned null");
        return false;
    }

    mixerWindow = std::make_unique<MixerWindow>(*this, std::move(content));
    mixerWindow->setBounds(targetBounds);
    mixerWindow->setVisible(visible);

    if (visible)
        mixerWindow->toFront(true);

    setState(visible ? WindowState::visible : WindowState::readyHidden,
             juce::String(visible ? "created visible bounds=" : "created hidden bounds=") + describeBounds(targetBounds));

    if (visible)
        scheduleStartupNudge();

    return true;
}

void MixerWindowManager::scheduleStartupNudge()
{
    if (mixerWindow == nullptr)
        return;

    juce::Component::SafePointer<juce::DocumentWindow> safeWindow(mixerWindow.get());
    juce::Timer::callAfterDelay(startupNudgeDelayMs, [safeWindow]()
    {
        if (safeWindow != nullptr)
        {
            const auto boundsNow = safeWindow->getBounds();
            safeWindow->setBounds(boundsNow.withWidth(boundsNow.getWidth() + 1));
            safeWindow->setBounds(boundsNow);
        }
    });
}

void MixerWindowManager::beginClose(bool notifyClosed)
{
    if (mixerWindow == nullptr)
        return;

    const auto bounds = mixerWindow->getBounds();
    setState(WindowState::closing, "close begin bounds=" + describeBounds(bounds));

    if (! countedGlobalClose)
    {
        countedGlobalClose = true;
        ++globalCloseDepth;
        juce::Logger::writeToLog("Secondary window global close depth: "
                                 + juce::String(globalCloseDepth)
                                 + " after closing " + windowTitle);
    }

    if (closeStartedMs == 0)
        closeStartedMs = juce::Time::currentTimeMillis();

    // WebView2 construction in JUCE keeps raw pointers in a static creation queue.
    // A normal user close must therefore keep the secondary WebView alive and reusable
    // instead of destroying it while another WebView may still be starting up.
    mixerWindow->setVisible(false);
    setState(WindowState::readyHidden, "close hidden for reuse bounds=" + describeBounds(bounds));

    if (notifyClosed && closedCallback)
        closedCallback(bounds);

    closeStartedMs = 0;
    closePendingUntilStartupSettles = false;
    stopTimer();
    releaseGlobalCloseSlot();
    drainGlobalPendingRequests();
}

void MixerWindowManager::finishClose()
{
    if (closingWindow != nullptr)
    {
        if (auto* hosted = closingWindow->getHostedComponent())
        {
            const auto elapsedMs = juce::Time::currentTimeMillis() - closeStartedMs;
            if (! hosted->hasFrontendStartupReachedTerminalState() && elapsedMs < closeStartupMaxWaitMs)
            {
                juce::Logger::writeToLog("Secondary retired window destruction delayed until frontend startup settles: "
                                         + windowTitle
                                         + " startupState=" + hosted->getFrontendStartupStateDescription()
                                         + " elapsedMs=" + juce::String(elapsedMs));
                startTimer(closeReadinessPollMs);
                return;
            }

            hosted->prepareForSecondaryWindowClose();
        }

        juce::Logger::writeToLog("Secondary retired window destroyed: " + windowTitle);
        closingWindow->setVisible(false);
        closingWindow = nullptr;
    }

    closeStartedMs = 0;
    stopTimer();
    setState(WindowState::idle, "close complete");
    releaseGlobalCloseSlot();
    drainGlobalPendingRequests();
}

void MixerWindowManager::releaseGlobalCloseSlot()
{
    if (! countedGlobalClose)
        return;

    countedGlobalClose = false;
    globalCloseDepth = juce::jmax(0, globalCloseDepth - 1);
    juce::Logger::writeToLog("Secondary window global close depth: "
                             + juce::String(globalCloseDepth)
                             + " after destroying " + windowTitle);
}

void MixerWindowManager::setState(WindowState nextState, const juce::String& reason)
{
    if (state == nextState && reason.isEmpty())
        return;

    juce::Logger::writeToLog("Secondary window state: " + windowTitle
                             + " " + juce::String(stateToString(state))
                             + " -> " + juce::String(stateToString(nextState))
                             + (reason.isNotEmpty() ? " (" + reason + ")" : juce::String()));
    state = nextState;
}

void MixerWindowManager::queuePendingRequest(PendingRequest::Type type, const juce::Rectangle<int>& bounds)
{
    if (type == PendingRequest::Type::focus)
    {
        if (pendingRequest.type == PendingRequest::Type::prewarm)
        {
            pendingRequest.type = PendingRequest::Type::open;
            addPendingManager(*this);
            juce::Logger::writeToLog("Secondary window pending prewarm upgraded to open: " + windowTitle
                                     + (pendingRequest.bounds.isEmpty() ? juce::String() : " bounds=" + describeBounds(pendingRequest.bounds)));
            return;
        }

        if (pendingRequest.type == PendingRequest::Type::open)
        {
            addPendingManager(*this);
            return;
        }
    }

    pendingRequest.type = type;
    pendingRequest.bounds = bounds;
    addPendingManager(*this);

    juce::String typeName = "none";
    if (type == PendingRequest::Type::open)
        typeName = "open";
    else if (type == PendingRequest::Type::prewarm)
        typeName = "prewarm";
    else if (type == PendingRequest::Type::focus)
        typeName = "focus";

    juce::Logger::writeToLog("Secondary window request queued: " + windowTitle
                             + " request=" + typeName
                             + " state=" + getStateDescription()
                             + (bounds.isEmpty() ? juce::String() : " bounds=" + describeBounds(bounds)));
}

void MixerWindowManager::runPendingRequest()
{
    const auto pending = pendingRequest;
    pendingRequest = {};

    if (pending.type == PendingRequest::Type::none)
        return;

    juce::Logger::writeToLog("Secondary window running queued request: " + windowTitle
                             + " state=" + getStateDescription());

    if (pending.type == PendingRequest::Type::open)
        open(pending.bounds);
    else if (pending.type == PendingRequest::Type::prewarm)
        prewarm(pending.bounds);
    else if (pending.type == PendingRequest::Type::focus)
        focus();
}

void MixerWindowManager::timerCallback()
{
    if (closePendingUntilStartupSettles)
    {
        if (mixerWindow == nullptr)
        {
            closePendingUntilStartupSettles = false;
            finishClose();
            return;
        }

        const auto elapsedMs = juce::Time::currentTimeMillis() - closeStartedMs;
        if (auto* hosted = mixerWindow->getHostedComponent())
        {
            if (! hosted->hasFrontendStartupReachedTerminalState() && elapsedMs < closeStartupMaxWaitMs)
            {
                juce::Logger::writeToLog("Secondary window close waiting for frontend startup to settle: "
                                         + windowTitle
                                         + " startupState=" + hosted->getFrontendStartupStateDescription()
                                         + " elapsedMs=" + juce::String(elapsedMs));
                startTimer(closeReadinessPollMs);
                return;
            }
        }

        juce::Logger::writeToLog("Secondary window pending close now entering teardown: " + windowTitle
                                 + " elapsedMs=" + juce::String(elapsedMs));
        closePendingUntilStartupSettles = false;
        beginClose(true);
        return;
    }

    finishClose();
}
