#pragma once

#include <JuceHeader.h>
#include <vector>

#if S13_HAS_ONNXRUNTIME
#include <onnxruntime_cxx_api.h>
#endif

/**
 * RMVPEPitchDetector — Neural network pitch detection using RMVPE ONNX model.
 *
 * RMVPE (Robust Model for Vocal Pitch Estimation) is a deep learning model
 * specifically designed for vocal pitch extraction from polyphonic music.
 * It uses a U-Net + GRU architecture on log mel spectrograms.
 *
 * Model specification:
 *   Input:  log mel spectrogram [1, num_frames, 128] at 16 kHz
 *   Output: pitch probabilities [1, num_frames, 360] (20-cent bins)
 *   Hop:    160 samples (10ms at 16 kHz)
 *
 * Falls back gracefully when ONNX Runtime is not available.
 */
class RMVPEPitchDetector
{
public:
    RMVPEPitchDetector();
    ~RMVPEPitchDetector();

    /** Load ONNX model from file. Returns true on success. */
    bool loadModel (const juce::File& onnxModelPath);

    /** Check if model is loaded and ready for inference. */
    bool isModelLoaded() const { return modelLoaded; }

    /** Per-frame pitch detection result. */
    struct PitchResult
    {
        float time;       // seconds from audio start
        float frequency;  // Hz (0 if unvoiced)
        float confidence; // 0-1 (peak activation value)
    };

    /**
     * Analyze mono audio and return per-frame pitch results.
     *
     * @param monoData    Mono float samples
     * @param numSamples  Number of samples
     * @param sampleRate  Source sample rate (will be resampled to 16 kHz internally)
     * @return            Per-frame pitch results at 10ms intervals
     */
    std::vector<PitchResult> analyze (const float* monoData, int numSamples, double sampleRate);

private:
    // Audio processing constants (must match RMVPE training config)
    static constexpr int kModelSampleRate = 16000;
    static constexpr int kNFFT           = 1024;
    static constexpr int kHopLength      = 160;   // 10ms frames at 16 kHz
    static constexpr int kNMels          = 128;
    static constexpr int kPitchBins      = 360;   // 20-cent resolution
    static constexpr int kFrameAlignment = 32;    // pad to multiple of 32
    static constexpr float kFMin         = 30.0f;
    static constexpr float kFMax         = 8000.0f;
    static constexpr float kConfThreshold = 0.03f; // below this = unvoiced

    // Resample audio to 16 kHz (linear interpolation)
    std::vector<float> resampleTo16k (const float* audio, int numSamples, double sourceSampleRate);

    // Compute log mel spectrogram from 16 kHz audio
    // Returns [num_frames][128] matrix
    std::vector<std::vector<float>> computeLogMelSpectrogram (const float* audio16k, int numSamples16k);

    // Build mel filter bank matrix [kNMels x (kNFFT/2+1)]
    void buildMelFilterBank();

    // Decode 360-bin pitch output to F0 Hz with sub-bin precision
    static float decodePitchBins (const float* bins, int numBins, float& outConfidence);

    // Pre-computed mel filter bank [128][513]
    std::vector<std::vector<float>> melFilterBank;
    bool melFilterBankReady = false;

    // Pre-computed Hann window for FFT
    std::vector<float> hannWindow;

#if S13_HAS_ONNXRUNTIME
    std::unique_ptr<Ort::Env> ortEnv;
    std::unique_ptr<Ort::Session> ortSession;
    std::string modelInputName;
    std::string modelOutputName;
#endif

    bool modelLoaded = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RMVPEPitchDetector)
};
