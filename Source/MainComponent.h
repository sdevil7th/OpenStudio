#include "ToneSearchRequest.h"
#pragma once
#include "ProjectFileStore.h"
#include "RecoveryJournal.h"
#include "OwnedBackgroundTasks.h"
#include "MessageMutationQueue.h"
#include "BuiltInAlignmentJob.h"

#include <JuceHeader.h>
#include "AudioEngine.h"
#include "AppUpdater.h"
#include <functional>
#include <atomic>
#include <map>
#include <set>
#include <utility>
#include <vector>

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
        midiEditor,
        pitchEditor,
        pluginEditor
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
        std::function<juce::var(const juce::String&, const juce::var&, WindowRole, const juce::String&)> pitchEditorSession;
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
        std::function<bool(const juce::String&, const juce::var&)> openPluginEditorWindow;
        std::function<juce::var(const juce::String&)> getPluginEditorWindowState;
        std::function<bool(const juce::String&, const juce::String&)> closePluginEditorWindow;
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
    void requestEmbeddedBrowserFocus();
    void prepareForSecondaryWindowClose();
    bool hasFrontendStartupSucceeded() const;
    bool hasFrontendStartupReachedTerminalState() const;
    juce::String getFrontendStartupStateDescription() const;
    int getFrontendDocumentRequestCount() const noexcept;

    static void broadcastEventToAll(const juce::String& eventId, const juce::var& payload = {});
    static void broadcastEventToRole(WindowRole role, const juce::String& eventId, const juce::var& payload = {});
    static juce::var getBrowserInstanceCounts();
    static juce::var buildStartupSelfTestReport();
    static bool writeStartupSelfTestReport(const juce::File& reportFile);
    static juce::var runNAMCatalogNativeRegression();
    static int runNAMLibraryManifestWriterRegressionChild(
        const juce::File& manifestFile,
        const juce::String& writerId,
        const juce::File& readyFile,
        const juce::File& startFile);

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
    void pollWindowsPrerequisiteRepair();
    juce::var buildStartupDiagnostics() const;
    void initializePitchRegressionJob(const juce::String& pitchRegressionJobPathIn);
    bool completePitchRegressionJob(const juce::var& result);
    static std::string makeNAMModelMutationKey(const juce::String& trackId,
                                               const juce::String& chainType,
                                               int fxIndex,
                                               const juce::String& slot);
    juce::uint64 beginNAMModelMutationRequest(const juce::String& trackId,
                                              const juce::String& chainType,
                                              int fxIndex,
                                              const juce::String& slot);
    juce::uint64 beginNAMModelMutationRequests(
        const juce::String& trackId,
        const juce::String& chainType,
        int fxIndex,
        const juce::StringArray& slots,
        std::vector<std::pair<juce::String, juce::uint64>>& requests);
    void invalidateNAMModelMutationRequests(const juce::String& trackId,
                                            const juce::String& chainType,
                                            int fxIndex,
                                            const juce::StringArray& slots);
    bool isNAMModelMutationRequestCurrent(const juce::String& trackId,
                                          const juce::String& chainType,
                                          int fxIndex,
                                          const juce::String& slot,
                                          juce::uint64 generation);
    std::shared_ptr<void> acquireNAMModelMutationPublicationLease(
        const juce::String& trackId,
        const juce::String& chainType,
        int fxIndex,
        const std::vector<std::pair<juce::String, juce::uint64>>& requests,
        juce::uint64 topologyGeneration);
    juce::var discardNAMPreviewIfUnused(juce::var recordPayload,
                                        juce::var rackAddressPayload);
    std::map<juce::String, std::shared_ptr<ToneSearchRequest>> toneSearchRequests;
    void runTone3000NativeTask(
        std::function<juce::var()> task,
        juce::WebBrowserComponent::NativeFunctionCompletion completion);
#if JUCE_WINDOWS
    void installExternalMediaDropTarget();
    bool isWaveformPreviewRequestCancelled(const juce::String& requestId) const;
#endif

    //==============================================================================
    // Your private member variables go here...
    AudioEngine& audioEngine;
    // Main-thread request ordering prevents queued transport echoes from undoing
    // a frontend seek/start/stop before its native operation has completed.
    juce::String transportRequestToken;
    juce::uint64 transportRequestSequence = 0;
    struct AutomationEditorFlush;
    static std::shared_ptr<AutomationEditorFlush> pendingAutomationEditorFlush;
    static void finishAutomationEditorFlush(const std::shared_ptr<AutomationEditorFlush>& request,
                                           bool timedOut = false, bool cancelled = false);
    void flushEditorsAfterTransportStop(const juce::String& token, juce::uint64 sequence,
                                       bool wasRolling, double stoppedPosition,
                                       juce::WebBrowserComponent::NativeFunctionCompletion completion);
    void acknowledgeAutomationEditorFlush(const juce::String& token, bool success);
    void publishBuiltInParameterEdit(juce::var event);
    void cancelAutomationEditorFlush();
    AppUpdater& appUpdater;
    StartupMode startupMode = StartupMode::normal;
    WindowRole windowRole = WindowRole::main;
    juce::String windowInstanceId;
    WindowCallbacks windowCallbacks;
    juce::File webuiDir;
    std::atomic<int> frontendDocumentRequestCount { 0 };
    juce::Array<juce::var> deferredNativeFunctionNames;
    MessageMutationQueue messageMutations;
    juce::WebBrowserComponent::NativeFunction deferNativeMutation(const juce::String&, juce::WebBrowserComponent::NativeFunction);
    juce::WebBrowserComponent webView;
    bool embeddedBrowserFocusRequestPending = false;
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
    juce::ThreadPool polyAnalysisBridgePool { 1 };
    juce::var lastPitchAnalysisResult;  // Cached result for fetch-after-event pattern
    juce::CriticalSection pitchResultLock;

    // Background thread for pitch correction (1 slot — serialises apply calls)
    juce::ThreadPool previewSegmentPool { 2 };
    juce::ThreadPool noteRenderPool { 1 };
    juce::ThreadPool fullClipHQPool { 1 };
    juce::ThreadPool mediaPreviewPool { 2 };
    OwnedBackgroundTasks mediaOperations;
    OwnedBackgroundTasks aiPreflightOperations;
    // File jobs must finish before the WebView and completion owner disappear.
    juce::ThreadPool projectFilePool { 1 };
    juce::String projectReadToken, projectReadJSON;
    ProjectFileStore::RecoverySession projectRecovery;
    RecoveryJournal workRecovery;
    juce::ThreadPool clipPeakAnalysisPool {
        1,
        juce::Thread::osDefaultStackSize,
        juce::Thread::Priority::low
    };
    juce::ThreadPool pluginScanPool {
        1,
        juce::Thread::osDefaultStackSize,
        juce::Thread::Priority::low
    };
    std::atomic<bool> tone3000NativeCompletionsEnabled { true };
    std::shared_ptr<std::atomic<bool>> tone3000TaskCancellation {
        std::make_shared<std::atomic<bool>>(false)
    };
    juce::ThreadPool tone3000BridgePool {
        4,
        juce::Thread::osDefaultStackSize,
        juce::Thread::Priority::low
    };
    std::atomic<bool> pluginScanRunning { false };
    // Keeps this window's jobs alive and sequenced. A process-wide gate in
    // MainComponent.cpp serialises NAM mutations across every editor window.
    // Model/IR parsing and prewarming can be CPU- and memory-intensive. Keep
    // this single mutation worker below the audio callback's scheduling class
    // so a model load cannot steal a 16-sample deadline.
    // Accessed only on the message thread; worker tickets contain atomics.
    std::map<juce::String,std::shared_ptr<BuiltInIRPreparation>> irPreparationJobs;
    std::map<juce::String,std::shared_ptr<BuiltInAlignmentJob>> alignmentJobs;
    std::map<juce::String,std::shared_ptr<BuiltInWorkerJob>> reverbResponseJobs;
    struct EQDraftJob { std::shared_ptr<BuiltInWorkerJob> ticket; juce::var request; };
    std::map<juce::String,EQDraftJob> eqDraftJobs;
    juce::ThreadPool reverbResponsePool { 1, juce::Thread::osDefaultStackSize, juce::Thread::Priority::low };
    // Waiting for playback must not block ordinary plugin state edits/imports.
    juce::ThreadPool alignmentCapturePool { 1, juce::Thread::osDefaultStackSize, juce::Thread::Priority::low };
    juce::ThreadPool builtInStateMutationPool {
        1,
        juce::Thread::osDefaultStackSize,
        juce::Thread::Priority::low
    };
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
    uint64_t lastProcessorFaultGeneration = 0;
    bool pendingRecordingDeviceInterruption = false;
    bool attemptedPackagedFrontendFallbackAfterLocalTimeout = false;
    bool secondaryWindowClosing = false;
    StartupRepairAction startupRepairAction = StartupRepairAction::none;
#if JUCE_WINDOWS
    bool prerequisiteRepairInProgress = false;
    std::unique_ptr<juce::ChildProcess> webView2RepairProcess;
    std::unique_ptr<juce::ChildProcess> vcRedistRepairProcess;
#endif
    juce::String lastAiToolsStatusDigest;
    double lastAiToolsStatusEmitMs = 0.0;
    double lastAiToolsStatusPollMs = 0.0;
    bool lastAiToolsInstallInProgress = false;
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
