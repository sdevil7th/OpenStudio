#pragma once
#include <JuceHeader.h>

/**
 * StemSeparator — Source separation via Python subprocess (BS-RoFormer).
 *
 * Splits audio into up to 6 stems:
 *   - Vocals, Drums, Bass, Guitar, Piano, Other
 *
 * Uses the `audio-separator` Python package with BS-RoFormer SW model
 * for state-of-the-art quality. Runs inference in a child process,
 * communicating progress via JSON lines on stdout.
 *
 * No compile-time dependencies (ONNX Runtime not required).
 * Requires Python + audio-separator to be installed at runtime.
 */
class StemSeparator
{
public:
    StemSeparator();
    ~StemSeparator();

    struct AiToolsStatus
    {
        juce::String state { "idle" };
        float progress = 0.0f;
        bool available = false;
        bool installerAvailable = false;
        bool pythonDetected = false;
        bool scriptAvailable = false;
        bool runtimeInstalled = false;
        bool modelInstalled = false;
        bool installInProgress = false;
        bool requiresExternalPython = false;
        juce::String message;
        juce::String error;
        juce::String errorCode;
        juce::String detailLogPath;
        juce::String helpUrl;
        juce::String installSource { "bundledRuntime" };
        juce::String buildRuntimeMode { "unbundled-dev" };
    };

    /** Check if Python environment and audio-separator are available. */
    bool isAvailable() const;

    /** Return a detailed AI tools status object for the UI. */
    juce::var getAiToolsStatus();

    /** Schedule a background AI tools status refresh and return the current cached status. */
    juce::var refreshAiToolsStatus();

    /** Start installing the optional AI tools into the user's app-data directory. */
    juce::var installAiTools();

    /** Cancel a running AI tools installation. */
    void cancelAiToolsInstall();

    /** All supported stem names. */
    static juce::StringArray getAllStemNames()
    {
        return { "Vocals", "Drums", "Bass", "Guitar", "Piano", "Other" };
    }

    struct SeparationProgress
    {
        juce::String state;  // "loading", "analyzing", "writing", "done", "error"
        float progress = 0.0f;
        juce::StringPairArray stemFiles;  // stem name -> file path (populated on "done")
        juce::String error;
    };

    /**
     * Start separation in a child process (non-blocking after launch).
     * Call pollProgress() to check status.
     *
     * @param inputFile     Audio file to separate
     * @param outputDir     Directory to write stem WAV files
     * @param stemNames     Which stems to extract (e.g., {"Vocals", "Drums", "Bass"})
     * @param useGPU        Use CUDA GPU acceleration
     * @param modelName     Model checkpoint filename (default: BS-Roformer-SW.ckpt)
     * @return true if process launched successfully
     */
    bool startSeparation (const juce::File& inputFile,
                          const juce::File& outputDir,
                          const juce::StringArray& stemNames,
                          bool useGPU = false,
                          const juce::String& modelName = "BS-Roformer-SW.ckpt");

    /** Poll the child process for progress. Returns current state. */
    SeparationProgress pollProgress();

    /** Cancel the running separation (kills child process). */
    void cancel();

    /** Is a separation currently running? */
    bool isRunning() const;

    /** Serialize stem file results to juce::var for the bridge. */
    static juce::var resultToJSON (const juce::StringPairArray& stemFiles, bool success,
                                   const juce::String& errorMsg = {});

private:
    /** Get the OpenStudio app-data root directory. */
    juce::File getUserDataRoot() const;

    /** Get the preferred stem-runtime root directory under user app-data. */
    juce::File getUserRuntimeRoot() const;

    /** Get the preferred models directory under user app-data. */
    juce::File getUserModelsDir() const;

    /** Find the prepared user-runtime Python executable. */
    juce::File findPython() const;

    /** Find a user-managed Python interpreter suitable for bootstrapping installs. */
    juce::File findSystemPython() const;

    /** Find the bundled AI runtime seed directory if present. */
    juce::File findBundledRuntimeRoot() const;

    /** Return true when this build is expected to ship a seeded AI runtime. */
    bool isBundledRuntimeBuild() const;

    /** Resolve a Python executable from a runtime root. */
    juce::File findPythonInRuntimeRoot (const juce::File& runtimeRoot) const;

    /** Find the stem_separator.py script. */
    juce::File findScript() const;

    /** Find the AI tools installer helper script. */
    juce::File findInstallerScript() const;

    /** Find the models directory. */
    juce::File findModelsDir() const;

    /** Find the install log file used by the AI tools bootstrapper. */
    juce::File getAiToolsInstallLogFile() const;

    /** Return true if the given Python can import audio_separator. */
    bool canImportAudioSeparator (const juce::File& python) const;

    /** Return true if the preferred stem model is available. */
    bool hasRequiredModel (const juce::File& modelsDir) const;

    /** Poll a running AI tools install and refresh the cached status. */
    void pollInstallProgress();

    /** Build the current AI tools status object using already-resolved values. */
    AiToolsStatus buildAiToolsStatus (const juce::File& systemPython,
                                      const juce::File& bundledRuntimeRoot,
                                      const juce::File& script,
                                      const juce::File& installerScript,
                                      bool runtimeInstalled,
                                      bool modelInstalled) const;

    /** Build an initial lightweight snapshot without expensive runtime probing. */
    AiToolsStatus buildInitialAiToolsStatus() const;

    /** Schedule a background refresh if one is not already running. */
    void scheduleStatusRefresh();

    /** Update the cached AI tools status under lock. */
    void updateCachedAiToolsStatus (const std::function<void (AiToolsStatus&)>& updater);

    /** Return the cached AI tools status with install progress folded in. */
    AiToolsStatus getCachedAiToolsStatusSnapshot() const;

    /** Parse a JSON line from the child process stdout. */
    SeparationProgress parseJsonLine (const juce::String& line) const;

    /** Parse a JSON line from the installer child process stdout. */
    AiToolsStatus parseInstallJsonLine (const juce::String& line) const;

    /** Serialize AI tools status to juce::var for the native bridge. */
    static juce::var aiToolsStatusToVar (const AiToolsStatus& status);

    std::unique_ptr<juce::ChildProcess> childProcess;
    std::unique_ptr<juce::ChildProcess> installProcess;
    juce::String outputBuffer;  // Accumulated stdout from child
    juce::String installOutputBuffer;
    SeparationProgress lastProgress;
    mutable AiToolsStatus lastAiToolsStatus;
    mutable juce::CriticalSection aiToolsStatusLock;
    mutable bool statusRefreshInFlight = false;
    mutable bool initialStatusPrepared = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (StemSeparator)
};
