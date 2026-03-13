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

    /** Check if Python environment and audio-separator are available. */
    bool isAvailable() const;

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
    /** Find the Python executable (bundled or system). */
    juce::File findPython() const;

    /** Find the stem_separator.py script. */
    juce::File findScript() const;

    /** Find the models directory. */
    juce::File findModelsDir() const;

    /** Parse a JSON line from the child process stdout. */
    SeparationProgress parseJsonLine (const juce::String& line) const;

    std::unique_ptr<juce::ChildProcess> childProcess;
    juce::String outputBuffer;  // Accumulated stdout from child
    SeparationProgress lastProgress;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (StemSeparator)
};
