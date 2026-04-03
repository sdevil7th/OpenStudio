#pragma once

#include <JuceHeader.h>
#include <memory>
#include <map>
#include <optional>

// Manages plugin editor windows
// Opens native VST3 GUIs for plugins like Amplitube, Guitar Rig, Kontakt, etc.
class PluginWindowManager : public juce::Timer
{
public:
    struct PluginEditorTarget
    {
        enum class Scope
        {
            TrackInputFX,
            TrackFX,
            Instrument,
            MasterFX,
            MonitoringFX
        };

        Scope scope = Scope::TrackFX;
        juce::String trackId;
        int fxIndex = -1;

        juce::String getStableKey() const;
        juce::var toVar() const;
        static std::optional<PluginEditorTarget> fromVar(const juce::var& value);
    };

    using ShortcutForwardCallback = std::function<void(const juce::var&)>;

    PluginWindowManager();
    ~PluginWindowManager() override;
    
    // Open plugin editor for a specific processor
    void openEditor(juce::AudioProcessor* processor, const juce::String& windowTitle,
                    const PluginEditorTarget& target);
    
    // Close editor for a specific processor (async, safe from any thread)
    void closeEditor(juce::AudioProcessor* processor);

    // Close editor for a specific processor synchronously (must be called from message thread)
    void closeEditorSync(juce::AudioProcessor* processor);

    // Close all editors for processors owned by a track (synchronous, must be called from message thread)
    void closeEditorsForTrack(const std::vector<juce::AudioProcessor*>& processors);

    // Close all plugin windows (async)
    void closeAllEditors();

    // Close all plugin windows synchronously (must be called from message thread)
    void closeAllEditorsSync();
    
    // Check if editor is open
    bool isEditorOpen(juce::AudioProcessor* processor) const;
    std::optional<PluginEditorTarget> getFocusedEditorTarget() const;

    void setMainWindowComponent(juce::Component* component);
    void setShortcutForwardCallback(ShortcutForwardCallback callback);

    // Timer callback to update plugin windows
    void timerCallback() override;

#if JUCE_WINDOWS
    // Public so the Win32 keyboard hook callback (free function) can access these.
    static PluginWindowManager* hookInstance;
    bool isPluginWindowFocused() const;
    bool handlePluginWindowKeyPress(const juce::KeyPress& key) const;
#endif

private:
    struct PluginWindow : public juce::DocumentWindow
    {
        PluginWindow(PluginWindowManager& ownerIn, juce::AudioProcessor& proc,
                     const juce::String& title, const PluginEditorTarget& targetIn);
        ~PluginWindow() override;
        
        void closeButtonPressed() override;
        bool keyPressed(const juce::KeyPress& key) override;
        void activeWindowStatusChanged() override;
        
        PluginWindowManager& owner;
        juce::AudioProcessor& processor;
        PluginEditorTarget target;
    };

#if ! JUCE_WINDOWS
    bool handlePluginWindowKeyPress(const juce::KeyPress& key) const;
#endif
    void positionWindow(PluginWindow& window) const;
    void logWindowEvent(const PluginEditorTarget& target, const juce::String& event, const juce::String& extra = {}) const;
    bool shouldSuppressDuplicateForward(const juce::KeyPress& key) const;
    
    std::map<juce::AudioProcessor*, std::unique_ptr<PluginWindow>> activeWindows;
    juce::Component* mainWindowComponent = nullptr;
    ShortcutForwardCallback shortcutForwardCallback;
    std::optional<PluginEditorTarget> focusedEditorTarget;
    mutable juce::String lastForwardedShortcutSignature;
    mutable double lastForwardedShortcutTimestampMs = 0.0;

#if JUCE_WINDOWS
    // Win32 thread-local keyboard hook to intercept transport keys (spacebar)
    // before they reach plugin native HWNDs that may consume them.
    // Uses void* to avoid pulling <windows.h> into this header.
    void* keyboardHook = nullptr;  // HHOOK
    void installKeyboardHook();
    void removeKeyboardHook();
#endif

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginWindowManager)
};
