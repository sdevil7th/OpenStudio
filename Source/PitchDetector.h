#pragma once

#include <JuceHeader.h>
#include <vector>
#include <atomic>

/**
 * PitchDetector — pYIN-based fundamental frequency estimation.
 *
 * Operates on mono audio frames. Uses the probabilistic YIN (pYIN) algorithm
 * for better accuracy with octave errors and noisy signals.
 *
 * Thread-safe: analyzeFrame() is called from audio thread,
 * results read from UI thread via atomics.
 */
class PitchDetector
{
public:
    PitchDetector();

    void prepare(double sampleRate, int maxBlockSize);

    // Feed audio samples; call this every processBlock.
    // After enough samples accumulate, runs detection and updates results.
    void processSamples(const float* samples, int numSamples);

    // Latest detection results (thread-safe reads)
    float getDetectedFrequency() const { return detectedFreq.load(std::memory_order_relaxed); }
    float getConfidence() const { return confidence.load(std::memory_order_relaxed); }

    // Parameters
    void setMinFrequency(float hz) { minFreq = hz; }
    void setMaxFrequency(float hz) { maxFreq = hz; }
    void setSensitivity(float s) { sensitivityThreshold = juce::jlimit(0.01f, 1.0f, s); }

    // Get pitch history (for UI display). Returns up to maxFrames recent entries.
    struct PitchFrame
    {
        float frequency;    // Hz (0 if unvoiced)
        float confidence;   // 0-1
        float rmsDB;        // dB
    };
    std::vector<PitchFrame> getRecentFrames(int maxFrames) const;

    void reset();

private:
    double sampleRate = 44100.0;

    // Ring buffer for accumulating input samples
    std::vector<float> inputBuffer;
    int writePos = 0;
    int samplesAccumulated = 0;

    // Analysis parameters
    static constexpr int frameSize = 2048;
    static constexpr int hopSize = 512;
    float minFreq = 80.0f;
    float maxFreq = 1000.0f;
    float sensitivityThreshold = 0.15f; // YIN threshold

    // pYIN internals
    std::vector<float> yinBuffer;
    float runYIN(const float* frame, int size);
    float parabolicInterpolation(int tauEstimate) const;

    // Results
    std::atomic<float> detectedFreq { 0.0f };
    std::atomic<float> confidence { 0.0f };

    // History ring buffer for UI
    static constexpr int maxHistory = 512;
    std::vector<PitchFrame> history;
    int historyWritePos = 0;
    mutable std::mutex historyMutex;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PitchDetector)
};
