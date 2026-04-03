#pragma once

#include <JuceHeader.h>
#include <vector>
#include <string>

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
        std::vector<float> pitchDrift; // per-frame deviation from note center
    };

    struct AnalysisResult
    {
        juce::String clipId;
        double sampleRate;
        int hopSize;
        std::vector<PitchFrame> frames;
        std::vector<PitchNote> notes;
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
                               double sampleRate, const juce::String& clipId);

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

    // YIN on a single frame
    float analyzeFrame(const float* frame, int frameSize, double sampleRate,
                       float& outConfidence);

    // Note segmentation from frame data
    std::vector<PitchNote> segmentNotes(const std::vector<PitchFrame>& frames,
                                        int hopSize, double sampleRate);

    // YIN buffer (reused across frames)
    std::vector<float> yinBuffer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PitchAnalyzer)
};
