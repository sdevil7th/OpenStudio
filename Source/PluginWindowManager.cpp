#include "PluginWindowManager.h"
#include "ARADebug.h"

#if JUCE_WINDOWS
 #include <windows.h>
#endif

namespace
{
void logPluginWindowDebug(const juce::String& msg)
{
    logARADebugLine(msg);
}

juce::String scopeToString(PluginWindowManager::PluginEditorTarget::Scope scope)
{
    switch (scope)
    {
        case PluginWindowManager::PluginEditorTarget::Scope::TrackInputFX: return "track_input_fx";
        case PluginWindowManager::PluginEditorTarget::Scope::TrackFX: return "track_fx";
        case PluginWindowManager::PluginEditorTarget::Scope::Instrument: return "instrument";
        case PluginWindowManager::PluginEditorTarget::Scope::MasterFX: return "master_fx";
        case PluginWindowManager::PluginEditorTarget::Scope::MonitoringFX: return "monitoring_fx";
    }

    return "track_fx";
}

std::optional<PluginWindowManager::PluginEditorTarget::Scope> stringToScope(const juce::String& scope)
{
    if (scope == "track_input_fx") return PluginWindowManager::PluginEditorTarget::Scope::TrackInputFX;
    if (scope == "track_fx") return PluginWindowManager::PluginEditorTarget::Scope::TrackFX;
    if (scope == "instrument") return PluginWindowManager::PluginEditorTarget::Scope::Instrument;
    if (scope == "master_fx") return PluginWindowManager::PluginEditorTarget::Scope::MasterFX;
    if (scope == "monitoring_fx") return PluginWindowManager::PluginEditorTarget::Scope::MonitoringFX;
    return std::nullopt;
}

juce::String normaliseKeyForDom(const juce::KeyPress& key)
{
    const auto keyCode = key.getKeyCode();
    const auto modifiers = key.getModifiers();

    if ((keyCode >= 'A' && keyCode <= 'Z') || (keyCode >= 'a' && keyCode <= 'z'))
    {
        const juce::juce_wchar upper = static_cast<juce::juce_wchar>(juce::CharacterFunctions::toUpperCase(keyCode));
        return juce::String::charToString(modifiers.isShiftDown() ? upper
                                                                  : juce::CharacterFunctions::toLowerCase(upper));
    }

    if (keyCode >= '0' && keyCode <= '9')
        return juce::String::charToString(static_cast<juce::juce_wchar>(keyCode));

    if (keyCode == juce::KeyPress::spaceKey) return " ";
    if (keyCode == juce::KeyPress::returnKey) return "Enter";
    if (keyCode == juce::KeyPress::escapeKey) return "Escape";
    if (keyCode == juce::KeyPress::deleteKey || keyCode == juce::KeyPress::backspaceKey) return "Delete";
    if (keyCode == juce::KeyPress::leftKey) return "ArrowLeft";
    if (keyCode == juce::KeyPress::rightKey) return "ArrowRight";
    if (keyCode == juce::KeyPress::upKey) return "ArrowUp";
    if (keyCode == juce::KeyPress::downKey) return "ArrowDown";
    if (keyCode == juce::KeyPress::insertKey) return "Insert";
    if (keyCode == juce::KeyPress::F1Key) return "F1";
    if (keyCode == juce::KeyPress::F2Key) return "F2";
    if (keyCode == ',') return ",";

    if (const auto textChar = key.getTextCharacter(); textChar != 0)
        return juce::String::charToString(textChar);

    return {};
}

juce::String normaliseCodeForDom(const juce::KeyPress& key)
{
    const auto keyCode = key.getKeyCode();

    if ((keyCode >= 'A' && keyCode <= 'Z') || (keyCode >= 'a' && keyCode <= 'z'))
    {
        const juce::juce_wchar upper = static_cast<juce::juce_wchar>(juce::CharacterFunctions::toUpperCase(keyCode));
        return "Key" + juce::String::charToString(upper);
    }

    if (keyCode >= '0' && keyCode <= '9')
        return "Digit" + juce::String::charToString(static_cast<juce::juce_wchar>(keyCode));

    if (keyCode == juce::KeyPress::spaceKey) return "Space";
    if (keyCode == juce::KeyPress::returnKey) return "Enter";
    if (keyCode == juce::KeyPress::escapeKey) return "Escape";
    if (keyCode == juce::KeyPress::deleteKey || keyCode == juce::KeyPress::backspaceKey) return "Delete";
    if (keyCode == juce::KeyPress::leftKey) return "ArrowLeft";
    if (keyCode == juce::KeyPress::rightKey) return "ArrowRight";
    if (keyCode == juce::KeyPress::upKey) return "ArrowUp";
    if (keyCode == juce::KeyPress::downKey) return "ArrowDown";
    if (keyCode == juce::KeyPress::insertKey) return "Insert";
    if (keyCode == juce::KeyPress::F1Key) return "F1";
    if (keyCode == juce::KeyPress::F2Key) return "F2";
    if (keyCode == ',') return "Comma";

    return {};
}

juce::var keyPressToVar(const juce::KeyPress& key)
{
    auto* obj = new juce::DynamicObject();
    const auto modifiers = key.getModifiers();

    obj->setProperty("key", normaliseKeyForDom(key));
    obj->setProperty("code", normaliseCodeForDom(key));
    obj->setProperty("ctrlKey", modifiers.isCtrlDown() || modifiers.isCommandDown());
    obj->setProperty("shiftKey", modifiers.isShiftDown());
    obj->setProperty("altKey", modifiers.isAltDown());
    obj->setProperty("metaKey", modifiers.isCommandDown() && !modifiers.isCtrlDown());
    obj->setProperty("repeat", false);
    obj->setProperty("source", "pluginWindow");
    return juce::var(obj);
}

bool shouldLogForwardedShortcut(const juce::KeyPress& key)
{
    const auto keyCode = key.getKeyCode();
    const auto modifiers = key.getModifiers();
    const bool ctrlOrCommand = modifiers.isCtrlDown() || modifiers.isCommandDown();
    return keyCode == juce::KeyPress::spaceKey
        || (ctrlOrCommand && (keyCode == 'z' || keyCode == 'Z'));
}
}

juce::String PluginWindowManager::PluginEditorTarget::getStableKey() const
{
    return scopeToString(scope) + "|" + trackId + "|" + juce::String(fxIndex);
}

juce::var PluginWindowManager::PluginEditorTarget::toVar() const
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("scope", scopeToString(scope));
    obj->setProperty("trackId", trackId);
    obj->setProperty("fxIndex", fxIndex);
    return juce::var(obj);
}

std::optional<PluginWindowManager::PluginEditorTarget> PluginWindowManager::PluginEditorTarget::fromVar(const juce::var& value)
{
    if (!value.isObject())
        return std::nullopt;

    auto* obj = value.getDynamicObject();
    if (obj == nullptr)
        return std::nullopt;

    auto scope = stringToScope(obj->getProperty("scope").toString());
    if (!scope.has_value())
        return std::nullopt;

    PluginEditorTarget target;
    target.scope = *scope;
    target.trackId = obj->getProperty("trackId").toString();
    target.fxIndex = static_cast<int>(obj->getProperty("fxIndex"));
    return target;
}

//==============================================================================
// PluginWindow implementation

PluginWindowManager::PluginWindow::PluginWindow(PluginWindowManager& ownerIn,
                                                juce::AudioProcessor& proc,
                                                const juce::String& title,
                                                const PluginEditorTarget& targetIn)
    : DocumentWindow(title,
                     juce::Colours::darkgrey,
                     DocumentWindow::allButtons),
      owner(ownerIn),
      processor(proc),
      target(targetIn)
{
    setUsingNativeTitleBar(true);
    setResizable(true, false);

    if (auto* editor = processor.createEditor())
    {
        setContentOwned(editor, true);

        int w = juce::jmax(editor->getWidth(), 200);
        int h = juce::jmax(editor->getHeight(), 150);
        setSize(w, h);
        owner.positionWindow(*this);
        setVisible(true);
        toFront(true);
        owner.logWindowEvent(target, "editor_opened", "title=" + title);
    }
}

PluginWindowManager::PluginWindow::~PluginWindow()
{
    clearContentComponent();
}

void PluginWindowManager::PluginWindow::closeButtonPressed()
{
    owner.logWindowEvent(target, "editor_close_requested");
    setVisible(false);
}

bool PluginWindowManager::PluginWindow::keyPressed(const juce::KeyPress& key)
{
    if (DocumentWindow::keyPressed(key))
    {
        if (shouldLogForwardedShortcut(key))
            owner.logWindowEvent(target, "plugin_consumed_key",
                                 "key=" + normaliseKeyForDom(key) + " code=" + normaliseCodeForDom(key));
        return true;
    }

    // Suppress JUCE's spacebar forwarding — the Win32 keyboard hook already
    // forwarded it. Without this, spacebar would be handled twice.
    if (key.getKeyCode() == juce::KeyPress::spaceKey)
        return true;

    return owner.handlePluginWindowKeyPress(key);
}

void PluginWindowManager::PluginWindow::activeWindowStatusChanged()
{
    DocumentWindow::activeWindowStatusChanged();
    if (isActiveWindow())
        owner.focusedEditorTarget = target;
    else if (owner.focusedEditorTarget.has_value()
             && owner.focusedEditorTarget->getStableKey() == target.getStableKey())
        owner.focusedEditorTarget.reset();

    owner.logWindowEvent(target, isActiveWindow() ? "editor_focused" : "editor_unfocused");
}

//==============================================================================
// PluginWindowManager implementation

PluginWindowManager::PluginWindowManager()
{
    startTimerHz(30);
#if JUCE_WINDOWS
    installKeyboardHook();
#endif
}

PluginWindowManager::~PluginWindowManager()
{
#if JUCE_WINDOWS
    removeKeyboardHook();
#endif
    stopTimer();
    closeAllEditorsSync();
}

void PluginWindowManager::setMainWindowComponent(juce::Component* component)
{
    mainWindowComponent = component;
}

void PluginWindowManager::setShortcutForwardCallback(ShortcutForwardCallback callback)
{
    shortcutForwardCallback = std::move(callback);
}

void PluginWindowManager::openEditor(juce::AudioProcessor* processor, const juce::String& windowTitle,
                                     const PluginEditorTarget& target)
{
    if (processor == nullptr)
        return;

    auto it = activeWindows.find(processor);
    if (it != activeWindows.end())
    {
        if (it->second != nullptr)
        {
            it->second->setVisible(true);
            positionWindow(*it->second);
            it->second->toFront(true);
            logWindowEvent(target, "editor_reopened_to_front");
        }
        return;
    }

    if (!processor->hasEditor())
        return;

    auto window = std::make_unique<PluginWindow>(*this, *processor, windowTitle, target);
    if (window->getContentComponent() == nullptr)
        return;

    activeWindows[processor] = std::move(window);
}

void PluginWindowManager::closeEditor(juce::AudioProcessor* processor)
{
    if (processor == nullptr)
        return;

    auto it = activeWindows.find(processor);
    if (it != activeWindows.end())
    {
        juce::String name = processor->getName();
        if (focusedEditorTarget.has_value()
            && focusedEditorTarget->getStableKey() == it->second->target.getStableKey())
            focusedEditorTarget.reset();
        logWindowEvent(it->second->target, "editor_closed");
        activeWindows.erase(it);
        juce::Logger::writeToLog("PluginWindowManager: Closed window for " + name);
    }
}

void PluginWindowManager::closeEditorSync(juce::AudioProcessor* processor)
{
    if (processor == nullptr)
        return;

    auto it = activeWindows.find(processor);
    if (it != activeWindows.end())
    {
        juce::Logger::writeToLog("PluginWindowManager: Closing editor synchronously for: " + processor->getName());
        if (focusedEditorTarget.has_value()
            && focusedEditorTarget->getStableKey() == it->second->target.getStableKey())
            focusedEditorTarget.reset();
        logWindowEvent(it->second->target, "editor_closed_sync");
        activeWindows.erase(it);
    }
}

void PluginWindowManager::closeEditorsForTrack(const std::vector<juce::AudioProcessor*>& processors)
{
    for (auto* proc : processors)
    {
        if (proc == nullptr)
            continue;

        auto it = activeWindows.find(proc);
        if (it != activeWindows.end())
        {
            juce::Logger::writeToLog("PluginWindowManager: Closing editor for track processor: " + proc->getName());
            if (focusedEditorTarget.has_value()
                && focusedEditorTarget->getStableKey() == it->second->target.getStableKey())
                focusedEditorTarget.reset();
            logWindowEvent(it->second->target, "editor_closed_for_track");
            activeWindows.erase(it);
        }
    }
}

void PluginWindowManager::closeAllEditors()
{
    juce::MessageManager::callAsync([this]()
    {
        focusedEditorTarget.reset();
        activeWindows.clear();
        juce::Logger::writeToLog("PluginWindowManager: Closed all plugin windows");
    });
}

void PluginWindowManager::closeAllEditorsSync()
{
    focusedEditorTarget.reset();
    activeWindows.clear();
    juce::Logger::writeToLog("PluginWindowManager: Closed all plugin windows (sync)");
}

bool PluginWindowManager::isEditorOpen(juce::AudioProcessor* processor) const
{
    return activeWindows.find(processor) != activeWindows.end();
}

std::optional<PluginWindowManager::PluginEditorTarget> PluginWindowManager::getFocusedEditorTarget() const
{
    return focusedEditorTarget;
}

bool PluginWindowManager::handlePluginWindowKeyPress(const juce::KeyPress& key) const
{
    if (!shortcutForwardCallback)
        return false;

    if (shouldSuppressDuplicateForward(key))
        return true;

    const auto payload = keyPressToVar(key);
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr)
        return false;

    if (obj->getProperty("key").toString().isEmpty()
        && obj->getProperty("code").toString().isEmpty())
    {
        return false;
    }

    if (shouldLogForwardedShortcut(key))
        logPluginWindowDebug("PluginWindowManager: forwarding shortcut key="
            + obj->getProperty("key").toString()
            + " code=" + obj->getProperty("code").toString());

    shortcutForwardCallback(payload);
    return true;
}

bool PluginWindowManager::shouldSuppressDuplicateForward(const juce::KeyPress& key) const
{
    const auto modifiers = key.getModifiers();
    const juce::String signature = juce::String(key.getKeyCode())
        + "|" + juce::String(modifiers.isCtrlDown() || modifiers.isCommandDown() ? 1 : 0)
        + "|" + juce::String(modifiers.isShiftDown() ? 1 : 0)
        + "|" + juce::String(modifiers.isAltDown() ? 1 : 0)
        + "|" + juce::String(modifiers.isCommandDown() ? 1 : 0);

    const double nowMs = juce::Time::getMillisecondCounterHiRes();
    constexpr double duplicateWindowMs = 60.0;

    if (signature == lastForwardedShortcutSignature
        && (nowMs - lastForwardedShortcutTimestampMs) <= duplicateWindowMs)
    {
        if (shouldLogForwardedShortcut(key))
            logPluginWindowDebug("PluginWindowManager: suppressed duplicate shortcut key="
                + normaliseKeyForDom(key) + " code=" + normaliseCodeForDom(key));
        return true;
    }

    lastForwardedShortcutSignature = signature;
    lastForwardedShortcutTimestampMs = nowMs;
    return false;
}

void PluginWindowManager::positionWindow(PluginWindow& window) const
{
    auto bounds = window.getBounds();
    auto displayArea = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay()->userArea;

    if (mainWindowComponent != nullptr)
    {
        const auto ownerBounds = mainWindowComponent->getTopLevelComponent() != nullptr
            ? mainWindowComponent->getTopLevelComponent()->getScreenBounds()
            : mainWindowComponent->getScreenBounds();

        if (auto* display = juce::Desktop::getInstance().getDisplays().getDisplayForRect(ownerBounds))
            displayArea = display->userArea;
    }

    bounds.setSize(juce::jmin(bounds.getWidth(), displayArea.getWidth() - 16),
                   juce::jmin(bounds.getHeight(), displayArea.getHeight() - 16));
    bounds.setCentre(displayArea.getCentre());
    bounds = bounds.constrainedWithin(displayArea.reduced(8));
    window.setBounds(bounds);

}

void PluginWindowManager::timerCallback()
{
    for (auto it = activeWindows.begin(); it != activeWindows.end();)
    {
        auto& window = *it->second;
        const bool isVisible = window.isVisible();

        if (!isVisible)
        {
            if (focusedEditorTarget.has_value()
                && focusedEditorTarget->getStableKey() == window.target.getStableKey())
                focusedEditorTarget.reset();
            logWindowEvent(window.target, "editor_closed_after_hidden");
            it = activeWindows.erase(it);
            continue;
        }
        ++it;
    }
}

void PluginWindowManager::logWindowEvent(const PluginEditorTarget& target, const juce::String& event,
                                         const juce::String& extra) const
{
    juce::String line = "PluginWindow event: event=" + event
        + " scope=" + scopeToString(target.scope)
        + " trackId=" + (target.trackId.isNotEmpty() ? target.trackId : juce::String("<none>"))
        + " fxIndex=" + juce::String(target.fxIndex);
    if (extra.isNotEmpty())
        line += " " + extra;
    logPluginWindowDebug(line);
}

//==============================================================================
// Win32 keyboard hook — intercepts transport keys (spacebar) before they reach
// plugin native HWNDs that may consume them after ARA edits.
#if JUCE_WINDOWS

PluginWindowManager* PluginWindowManager::hookInstance = nullptr;

static LRESULT CALLBACK pluginWindowKeyboardHookProc (int nCode, WPARAM wParam, LPARAM lParam)
{
    auto* inst = PluginWindowManager::hookInstance;
    if (nCode >= 0 && inst != nullptr)
    {
        // Only intercept key-down events (bit 31 of lParam = 0 means key down)
        const bool isKeyDown = (lParam & (1 << 31)) == 0;

        if (isKeyDown && inst->isPluginWindowFocused())
        {
            const int vk = static_cast<int> (wParam);

            // Intercept spacebar and forward to host transport.
            // The plugin doesn't handle spacebar itself — the host must
            // control transport. PluginWindow::keyPressed also suppresses
            // spacebar to prevent double-handling via JUCE's event path.
            if (vk == VK_SPACE)
            {
                juce::KeyPress key (juce::KeyPress::spaceKey,
                                    juce::ModifierKeys::currentModifiers, 0);

                logPluginWindowDebug ("PluginWindowManager: hook intercepted VK_SPACE — forwarding to host");

                if (inst->handlePluginWindowKeyPress (key))
                    return 1;  // Consume — host handles transport
            }
        }
    }

    return CallNextHookEx (nullptr, nCode, wParam, lParam);
}

void PluginWindowManager::installKeyboardHook()
{
    hookInstance = this;
    keyboardHook = static_cast<void*> (
        SetWindowsHookExW (WH_KEYBOARD, pluginWindowKeyboardHookProc,
                           nullptr, GetCurrentThreadId()));
    if (keyboardHook != nullptr)
        logPluginWindowDebug ("PluginWindowManager: Win32 keyboard hook installed");
}

void PluginWindowManager::removeKeyboardHook()
{
    if (keyboardHook != nullptr)
    {
        UnhookWindowsHookEx (static_cast<HHOOK> (keyboardHook));
        keyboardHook = nullptr;
        logPluginWindowDebug ("PluginWindowManager: Win32 keyboard hook removed");
    }
    hookInstance = nullptr;
}

bool PluginWindowManager::isPluginWindowFocused() const
{
    HWND focusedHwnd = GetFocus();
    if (focusedHwnd == nullptr)
        return false;

    for (const auto& [proc, window] : activeWindows)
    {
        if (window == nullptr || ! window->isVisible())
            continue;

        if (auto* peer = window->getPeer())
        {
            auto windowHwnd = static_cast<HWND> (peer->getNativeHandle());
            if (focusedHwnd == windowHwnd || IsChild (windowHwnd, focusedHwnd))
                return true;
        }
    }

    return false;
}

#endif // JUCE_WINDOWS
