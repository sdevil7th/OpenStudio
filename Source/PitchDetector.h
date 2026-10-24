#pragma once

#include <JuceHeader.h>
#include <vector>
#include <atomic>
#include <array>

/**
 * PitchDetector — YIN-style real-time fundamental frequency estimation.
 *
 * Operates on mono audio frames. This is a lightweight YIN-style detector
 * used for live tracking and UI feedback. It does not yet implement the
 * offline pYIN-style candidate generation and temporal decoding used by the
 * pitch-editor analysis path.
 *
 * Thread-safe: analyzeFrame() is called from audio thread,
 * results read from UI thread via atomics.
 */
class PitchDetector
{
public:
    PitchDetector();

    // Configuration only: call before prepare, never from an audio callback.
    void setRateNormalized(bool enabled) noexcept { rateNormalized = enabled; }
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
    bool rateNormalized = false;
    int decimation = 1, decimationPosition = 0, antiAliasPosition = 0;
    std::vector<float> antiAliasCoefficients, antiAliasHistory;

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

    // YIN internals
    std::vector<float> yinBuffer;
    float runYIN(const float* frame, int size);
    float finishYIN(int tauMin, int tauMax, float minimum, float maximum);
    void advanceYIN() noexcept;
    int pendingTau = 0, pendingTauMin = 0, pendingTauMax = 0;
    float pendingSum = 0, pendingMinimum = 40, pendingMaximum = 1000, pendingRmsDB = -100;
    float parabolicInterpolation(int tauEstimate) const;

    // Results
    std::atomic<float> detectedFreq { 0.0f };
    std::atomic<float> confidence { 0.0f };

    // History ring buffer for UI
    static constexpr int maxHistory = 512;
    struct PublishedFrame
    {
        std::atomic<unsigned int> generation { 0 };
        std::atomic<float> frequency { 0 }, confidence { 0 }, rmsDB { -100 };
    };
    std::array<PublishedFrame, maxHistory> history;
    std::atomic<int> historyWritePos { 0 };
    std::array<float, frameSize> analysisFrame {};
    void publishFrame(float frequency, float frameConfidence, float rmsDB) noexcept;
    void clearHistory() noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PitchDetector)
};
