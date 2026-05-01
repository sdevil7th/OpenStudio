#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <memory>
#include <string>
#include <thread>

struct AIGenerationProgress
{
    juce::String state { "idle" };
    float progress = 0.0f;
    juce::String phase;
    juce::String message;
    juce::String backend { "unknown" };
    juce::String outputFile;
    juce::String error;
    double elapsedMs = 0.0;
    double heartbeatTs = 0.0;
    double phaseProgress = -1.0;
    double etaMs = -1.0;
    juce::String runMode;
    juce::String runtimeProfile;
    juce::String lmModel;
    juce::String statusNote;
    juce::String failureKind;
    juce::String sessionMode;
    int workerExitCode = 0;
    juce::String lastStdoutLine;
    juce::String lastStderrLine;
    juce::String attemptMode;
    int attemptIndex = 0;
    int protocolVersion = 0;
    juce::String scriptVersion;
    juce::String requestId;
    juce::String priorFailure;
    double lastProgressAgeMs = -1.0;
    juce::String tracePath;
    juce::String failureDetail;
    juce::String lmBackend;
    juce::String lmStage;
};

class AITrackEngine
{
public:
    AITrackEngine() = default;
    ~AITrackEngine();

    bool startGeneration(const juce::String& workflowId,
                         const juce::String& paramsJson,
                         const juce::File& outputDir);

    AIGenerationProgress pollProgress();
    void cancel();
    bool isRunning() const;

private:
    juce::File getUserDataRoot() const;
    juce::File getUserRuntimeRoot() const;
    juce::File getMusicGenerationCheckpointRoot() const;
    juce::File findPython() const;
    juce::File findScript() const;
    void cleanupLegacyWorkerProcesses(const juce::File& python, const juce::File& script) const;
    bool ensureWorkerAvailable(const juce::File& python, const juce::File& script);
    bool sendGenerateRequest(const juce::String& workflowId,
                             const juce::String& paramsJson,
                             const juce::File& outputFile);
    void launchGenerationTask(const juce::File& python,
                              const juce::File& script,
                              const juce::String& workflowId,
                              const juce::String& paramsJson,
                              const juce::File& outputFile);
    bool waitForWorkerReady(int timeoutMs);
    void stopWorkerSession(bool clearProgress, bool userCancelled, bool keepGenerationActive);
    void joinGenerationThread();
    void stopWorker(bool clearProgress, bool userCancelled);
    void readerLoop();
    void parseOutputLine(const juce::String& line);
    void handleWorkerExit();
    juce::String appendProcessDetailsLocked(const juce::String& message) const;
    void setProgressErrorLocked(const juce::String& phase,
                                const juce::String& message,
                                const juce::String& failureKind);
    void resetProcessStateLocked();

    std::unique_ptr<juce::ChildProcess> workerProcess_;
    std::thread readerThread_;
    std::thread generationThread_;
    std::atomic<bool> readerShouldExit_ { false };
    mutable juce::CriticalSection lock_;
    AIGenerationProgress currentProgress_;
    std::string processOutputBuffer_;
    juce::String lastProcessOutputLine_;
    juce::String lastStdoutLine_;
    juce::String lastStderrLine_;
    juce::File currentOutputFile_;
    juce::String currentRequestId_;
    juce::String expectedScriptVersion_;
    juce::String workerScriptVersion_;
    juce::String workerScriptPath_;
    bool generationActive_ = false;
    bool expectedProcessExit_ = false;
    bool cancelRequested_ = false;
    bool sawStructuredOutput_ = false;
    bool loggedFirstStructuredOutput_ = false;
    bool loggedFirstOutputByte_ = false;
    bool loggedFirstOutputLine_ = false;
    bool workerReady_ = false;
    bool workerProtocolRejected_ = false;
    int workerPort_ = 0;
    int workerExitCode_ = 0;
    int workerProtocolVersion_ = 0;
    int workerPid_ = 0;
    juce::int64 generationStartedAtMs_ = 0;
    juce::int64 lastHeartbeatAtMs_ = 0;
    juce::int64 workerLaunchAtMs_ = 0;
    juce::int64 firstOutputByteAtMs_ = 0;
    juce::int64 firstOutputLineAtMs_ = 0;
};
