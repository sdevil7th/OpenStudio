#pragma once

#include <JuceHeader.h>
#include "AudioEngine.h"
#include "AppUpdater.h"
#include <set>

//==============================================================================
/*
    This component lives inside our window, and this is where you should put all
    your controls and content.
*/
class MainComponent  : public juce::Component,
                       public juce::Timer
{
public:
    enum class StartupMode
    {
        normal,
        safe
    };

    enum class WindowRole
    {
        main,
        mixer,
        midiEditor
    };

    enum class FrontendStartupState
    {
        idle,
        navigationStarted,
        bootStarted,
        ready,
        failed,
        timedOut
    };

    enum class StartupRepairAction
    {
        none,
        installation,
        dependencies
    };

    struct WindowCallbacks
    {
        std::function<void()> requestAppClose;
        std::function<bool(const juce::var&)> openMixerWindow;
        std::function<bool()> closeMixerWindow;
        std::function<juce::var()> getMixerWindowState;
        std::function<void(const juce::var&)> publishMixerUISnapshot;
        std::function<juce::var()> getMixerUISnapshot;
        std::function<bool(const juce::String&, const juce::var&)> openMidiEditorWindow;
        std::function<bool(const juce::String&, const juce::var&)> prewarmMidiEditorWindow;
        std::function<bool(const juce::String&)> focusMidiEditorWindow;
        std::function<bool(const juce::String&, const juce::String&)> closeMidiEditorWindow;
        std::function<juce::var(const juce::String&)> getMidiEditorWindowState;
        std::function<void(const juce::String&, const juce::var&)> publishMidiEditorUISnapshot;
        std::function<juce::var(const juce::String&)> getMidiEditorUISnapshot;
    };

    //==============================================================================
    MainComponent(AudioEngine& audioEngineIn,
                  AppUpdater& appUpdaterIn,
                  StartupMode startupModeIn,
                  WindowRole roleIn,
                  WindowCallbacks callbacksIn = {},
                  const juce::String& pitchRegressionJobPathIn = {},
                  const juce::String& windowInstanceIdIn = {});
    ~MainComponent() override;

    //==============================================================================
    void paint (juce::Graphics&) override;
    void resized() override;

    void timerCallback() override;
    void requestFrontendAppClose();

    static void broadcastEventToAll(const juce::String& eventId, const juce::var& payload = {});
    static void broadcastEventToRole(WindowRole role, const juce::String& eventId, const juce::var& payload = {});
    static juce::var buildStartupSelfTestReport();
    static bool writeStartupSelfTestReport(const juce::File& reportFile);

#if JUCE_WINDOWS
    void emitExternalMediaDropTargetEvent(const juce::String& eventId, const juce::var& payload);
    void bringMainWindowToFrontForExternalMediaDrag();
#endif

private:
    juce::Rectangle<int> getDesktopWorkAreaForCurrentWindow() const;
    bool isWindowPseudoMaximized() const;
    bool toggleDesktopPseudoMaximize();
    void restoreDesktopWindow(const juce::Rectangle<int>& targetBounds);
    void startDesktopWindowDrag();
    void emitFrontendEvent(const juce::String& eventId, const juce::var& payload = {});
    bool isMainWindow() const;
    bool loadPackagedFrontend();
    bool tryFallbackToPackagedFrontendAfterLocalTimeout();
    void beginFrontendStartupWatchdog(const juce::String& targetUrl);
    void showStartupOverlay(const juce::String& title, const juce::String& detail);
    void hideStartupOverlay();
    void markFrontendStartupReady(const juce::String& detail);
    void markFrontendStartupFailed(const juce::String& detail);
    void showStartupFallback(const juce::String& title, const juce::String& detail, bool allowRepair = false);
    void hideStartupFallbackActions();
    void updateStartupFallbackActions();
    void openStartupLogFolder();
    void relaunchApplication(StartupMode targetMode);
    void repairInstalledApplication();
    void repairWindowsPrerequisites();
    juce::var buildStartupDiagnostics() const;
    void initializePitchRegressionJob(const juce::String& pitchRegressionJobPathIn);
    bool completePitchRegressionJob(const juce::var& result);
#if JUCE_WINDOWS
    void installExternalMediaDropTarget();
    bool isWaveformPreviewRequestCancelled(const juce::String& requestId) const;
#endif

    //==============================================================================
    // Your private member variables go here...
    AudioEngine& audioEngine;
    AppUpdater& appUpdater;
    StartupMode startupMode = StartupMode::normal;
    WindowRole windowRole = WindowRole::main;
    juce::String windowInstanceId;
    WindowCallbacks windowCallbacks;
    juce::File webuiDir;
    juce::WebBrowserComponent webView;
    juce::Label startupStatusMessage;
    juce::Label fallbackMessage;
    juce::TextButton startupRetryButton { "Retry" };
    juce::TextButton startupOpenLogButton { "Open Log Folder" };
    juce::TextButton startupSafeModeButton { "Launch Safe Mode" };
    juce::TextButton startupRepairButton { "Repair" };
    std::unique_ptr<juce::FileChooser> fileChooser;  // For async file dialogs
    juce::Rectangle<int> windowRestoreBounds;
    bool windowPseudoMaximized = false;

    // Async pitch analysis state
    std::atomic<bool> pitchAnalysisRunning { false };
    std::atomic<bool> pitchNoteHqPriorityActive { false };
    std::atomic<int> pitchAnalysisGeneration { 0 };
    std::atomic<int> pitchNoteHqPriorityGeneration { 0 };
    juce::ThreadPool pitchAnalysisPool { 1 };
    juce::var lastPitchAnalysisResult;  // Cached result for fetch-after-event pattern
    juce::CriticalSection pitchResultLock;

    // Background thread for pitch correction (1 slot — serialises apply calls)
    juce::ThreadPool previewSegmentPool { 2 };
    juce::ThreadPool noteRenderPool { 1 };
    juce::ThreadPool fullClipHQPool { 1 };
    juce::ThreadPool mediaPreviewPool { 2 };
    juce::CriticalSection pitchCorrectionJobLock;
    juce::String activePreviewRequestGroup;
    juce::String activeNoteRenderRequestGroup;
    juce::String activeFullClipRequestGroup;
    std::atomic<int> previewRenderGeneration { 0 };
    std::atomic<int> noteRenderGeneration { 0 };
    std::atomic<int> fullClipRenderGeneration { 0 };
    FrontendStartupState frontendStartupState = FrontendStartupState::idle;
    juce::String frontendStartupTargetUrl;
    juce::String frontendStartupDetail;
    juce::uint32 frontendStartupNavigationTicks = 0;
    bool startupFallbackVisible = false;
    bool startupWatchdogActive = false;
    bool attemptedPackagedFrontendFallbackAfterLocalTimeout = false;
    StartupRepairAction startupRepairAction = StartupRepairAction::none;
    juce::String lastAiToolsStatusDigest;
    double lastAiToolsStatusEmitMs = 0.0;
    juce::File pitchRegressionJobFile;
    juce::var pitchRegressionJob;
    bool pitchRegressionJobConsumed = false;
    bool pitchRegressionJobCompleted = false;
    juce::CriticalSection pitchRegressionNativeResultLock;
    juce::var lastPitchRegressionNativeResult;
#if JUCE_WINDOWS
    class ExternalMediaDropTarget;
    std::unique_ptr<ExternalMediaDropTarget> externalMediaDropTarget;
    mutable juce::CriticalSection waveformPreviewRequestLock;
    std::set<juce::String> cancelledWaveformPreviewRequests;
#endif

    static juce::CriticalSection instanceListLock;
    static juce::Array<MainComponent*> activeInstances;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
