#pragma once
#include <JuceHeader.h>

#if S13_HAS_ONNXRUNTIME
#include <onnxruntime_cxx_api.h>
#endif

/**
 * PolyPitchDetector — Polyphonic pitch detection via Spotify's Basic-Pitch ONNX model.
 *
 * Model I/O (Basic-Pitch NMP):
 *   Input:  [1, N_frames, N_harmonics, 1] float32 — Constant-Q harmonic stacking of audio at 22050 Hz
 *   Output 1 (contour): [1, T, 264] — pitch salience map (time x frequency bins, ~1/3 semitone)
 *   Output 2 (note):    [1, T, 88]  — note activation probabilities for 88 piano keys (A0-C8, MIDI 21-108)
 *   Output 3 (onset):   [1, T, 88]  — onset activation probabilities
 *
 * Post-processing: threshold activations, extract contiguous note regions,
 * merge short gaps, filter by minimum duration, assign confidence/velocity.
 */
class PolyPitchDetector
{
public:
    PolyPitchDetector();
    ~PolyPitchDetector();

    // Load model lazily (call before first analysis)
    bool loadModel (const juce::File& onnxModelPath);
    bool isModelLoaded() const { return modelLoaded; }

    struct PolyNote
    {
        juce::String id;
        float startTime  = 0.0f;   // seconds
        float endTime    = 0.0f;   // seconds
        int   midiPitch  = 60;     // MIDI note 21-108
        float confidence = 0.0f;   // 0-1 (mean note activation)
        float velocity   = 0.0f;   // 0-1 (peak activation → maps to MIDI velocity)
    };

    struct PolyAnalysisResult
    {
        juce::String clipId;
        double sampleRate = 22050.0;
        int hopSize       = 256;   // samples at 22050 Hz (~11.6ms)

        // Raw model outputs (kept for visualization — pitch salience heatmap)
        std::vector<std::vector<float>> pitchSalience;  // [T][264]
        std::vector<std::vector<float>> noteActivation;  // [T][88]

        // Post-processed notes
        std::vector<PolyNote> notes;
    };

    // Run polyphonic analysis (call on message thread, NOT audio thread)
    PolyAnalysisResult analyze (const float* monoAudio, int numSamples,
                                double sourceSampleRate, const juce::String& clipId);

    // Convert analysis result to juce::var for bridge serialization
    static juce::var resultToJSON (const PolyAnalysisResult& result);

    // Tuning parameters
    void setOnsetThreshold (float t)      { onsetThreshold = t; }
    void setNoteThreshold (float t)       { noteThreshold = t; }
    void setMinNoteDurationMs (float ms)  { minNoteDurationMs = ms; }
    void setMergeGapMs (float ms)         { mergeGapMs = ms; }

private:
    bool modelLoaded = false;

    float onsetThreshold    = 0.3f;   // Lowered from 0.5 — vocals have gradual onsets
    float noteThreshold     = 0.15f;  // Lowered from 0.3 — polyphonic material has lower per-note energy
    float minNoteDurationMs = 50.0f;
    float mergeGapMs        = 80.0f;  // Raised from 50ms — merge short gaps (common in vocals)

    // Resample input to 22050 Hz (Basic-Pitch expected sample rate)
    std::vector<float> resampleTo22050 (const float* audio, int numSamples,
                                        double sourceSampleRate);

    // Post-process raw model outputs into discrete notes
    std::vector<PolyNote> extractNotes (const std::vector<std::vector<float>>& noteActivation,
                                        const std::vector<std::vector<float>>& onsetActivation,
                                        int hopSize, double sampleRate);

#if S13_HAS_ONNXRUNTIME
    std::unique_ptr<Ort::Env> ortEnv;
    std::unique_ptr<Ort::Session> ortSession;
    Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu (OrtArenaAllocator, OrtMemTypeDefault);
#endif

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PolyPitchDetector)
};
