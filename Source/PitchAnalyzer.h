#pragma once

#include <JuceHeader.h>
#include <vector>
#include <string>
#include <memory>
#include <functional>

/**
 * PitchAnalyzer — Offline pitch contour analysis for graphical editing.
 *
 * Analyzes an entire audio clip and produces:
 *   1. Frame-level pitch data (frequency + confidence per hop)
 *   2. Note segmentation (grouping frames into discrete notes)
 *
 * Runs on the message thread (not audio thread). Results are serialized
 * as JSON for the frontend via bridge.
 */
class PitchAnalyzer
{
public:
    PitchAnalyzer();

    // Per-frame analysis result
    struct PitchFrame
    {
        float time;         // seconds from clip start
        float frequency;    // Hz (0 if unvoiced)
        float midiNote;     // fractional MIDI note (0 if unvoiced)
        float confidence;   // 0-1
        float rmsDB;        // dB level
        bool voiced = true; // true = pitched vocal, false = sibilant/breath/silence
    };

    // Segmented note
    struct PitchNote
    {
        juce::String id;            // unique ID
        float startTime;            // seconds
        float endTime;              // seconds
        float effectiveStartTime;   // seconds, includes rendered pitch shoulder
        float effectiveEndTime;     // seconds, includes rendered pitch shoulder
        float detectedPitch;        // average MIDI note (fractional)
        float correctedPitch;       // target (initially = detected, user edits)
        float driftCorrectionAmount; // 0 = original, 1 = straight
        float vibratoDepth;         // multiplier: 0 = remove, 1 = original
        float vibratoRate;          // 0 = original rate
        float transitionIn;         // ms
        float transitionOut;        // ms
        float formantShift;         // semitones
        float gain;                 // dB adjustment
        bool voiced = true;         // true = pitched vocal, false = unvoiced segment
        juce::String wordGroupId;   // stable editable word/phrase group
        juce::String entryBoundaryKind; // unknown | hard_word_like | soft_legato | internal_bend | internal_vibrato
        juce::String exitBoundaryKind;  // unknown | hard_word_like | soft_legato | internal_bend | internal_vibrato
        juce::String entryBoundaryReason;
        juce::String exitBoundaryReason;
        float entryBoundaryScore = 0.0f;
        float exitBoundaryScore = 0.0f;
        std::vector<float> pitchDrift; // per-frame deviation from note center
    };

    struct PitchBoundaryCandidate
    {
        juce::String id;
        juce::String sourceNoteId;
        float time = 0.0f;
        juce::String kind = "unknown"; // hard_word_like | soft_legato | internal_bend | internal_vibrato
        juce::String reason;
        float score = 0.0f;
        bool destructiveSplitAllowed = false;
    };

    struct AnalysisResult
    {
        juce::String clipId;
        double sampleRate;
        int hopSize;
        std::vector<PitchFrame> frames;
        std::vector<PitchNote> notes;
        std::vector<PitchBoundaryCandidate> boundaryCandidates;
    };

    /**
     * Analyze a clip's audio data.
     *
     * @param audioData   Mono float samples
     * @param numSamples  Number of samples
     * @param sampleRate  Sample rate of the audio
     * @param clipId      Identifier for this clip
     * @return            Full analysis result with frames and notes
     */
    AnalysisResult analyzeClip(const float* audioData, int numSamples,
                               double sampleRate, const juce::String& clipId,
                               std::function<bool()> shouldCancel = {});

    // Analysis parameters
    void setMinFrequency(float hz) { minFreq = hz; }
    void setMaxFrequency(float hz) { maxFreq = hz; }
    void setSensitivity(float s) { sensitivity = s; }

    // Serialize result to JSON for frontend
    static juce::var resultToJSON(const AnalysisResult& result);

    // Deserialize edited notes from frontend JSON
    static std::vector<PitchNote> notesFromJSON(const juce::var& json);

    // Deserialize analysis frames from frontend JSON (flat arrays: times, midi, confidence, rms, voiced)
    static std::vector<PitchFrame> framesFromJSON(const juce::var& json);

private:
    float minFreq = 80.0f;
    float maxFreq = 1000.0f;
    float sensitivity = 0.15f;

    static constexpr int analysisFrameSize = 2048;
    static constexpr int analysisFftOrder = 12; // 4096-point FFT for 2048-sample frames
    static constexpr int analysisFftSize = 1 << analysisFftOrder;

    // YIN on a single frame
    float analyzeFrame(const float* frame, int frameSize, double sampleRate,
                       float& outConfidence);

    // Note segmentation from frame data
    std::vector<PitchNote> segmentNotes(const std::vector<PitchFrame>& frames,
                                        int hopSize, double sampleRate,
                                        std::vector<PitchBoundaryCandidate>* boundaryCandidates = nullptr);

    // YIN buffer (reused across frames)
    std::vector<float> yinBuffer;
    std::vector<float> analysisWindow;
    std::vector<float> differenceBuffer;
    std::vector<float> directDifferenceBuffer;
    std::vector<float> cmndfBuffer;
    std::vector<float> autocorrelationBuffer;
    std::vector<float> prefixEnergyBuffer;
    std::vector<float> windowedFrameBuffer;
    std::vector<juce::dsp::Complex<float>> fftBuffer;
    std::unique_ptr<juce::dsp::FFT> fft;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PitchAnalyzer)
};
