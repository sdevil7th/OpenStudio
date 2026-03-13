#pragma once

#include <JuceHeader.h>
#include "PartialTracker.h"
#include <vector>
#include <map>

/**
 * SinusoidalModel — Sinusoidal analysis and harmonic grouping.
 *
 * Groups tracked partials (from PartialTracker) into harmonic sets.
 * Kept for note visualization in the pitch editor (blob display, pitch contour).
 * Synthesis has been replaced by SignalsmithShifter.
 */
class SinusoidalModel
{
public:
    SinusoidalModel();

    struct HarmonicGroup
    {
        int noteId = 0;
        float fundamentalFreq = 0.0f;          // Estimated f0 in Hz
        float midiPitch = 0.0f;                 // MIDI note number (fractional)
        int startFrame = 0;
        int endFrame = 0;
        std::vector<int> partialIds;            // IDs of partials belonging to this group
        float avgMagnitude = 0.0f;              // Average magnitude of all partials
    };

    struct ProcessResult
    {
        std::vector<float> audio;               // Placeholder (no resynthesis)
        std::vector<HarmonicGroup> notes;       // Detected note objects
        int numSamples = 0;
        double sampleRate = 0.0;
    };

    // Full analysis + grouping pipeline
    ProcessResult analyze (const float* audio, int numSamples, double sampleRate);

    // Formant track: per-frame formant frequencies (F1-F4)
    struct FormantFrame
    {
        float f1 = 0.0f, f2 = 0.0f, f3 = 0.0f, f4 = 0.0f;       // Hz
        float bw1 = 0.0f, bw2 = 0.0f, bw3 = 0.0f, bw4 = 0.0f;   // Bandwidth Hz
    };

    /**
     * Extract formant tracks (F1-F4) from LPC analysis of stored STFT frames.
     * Returns one FormantFrame per analysis frame.
     */
    std::vector<FormantFrame> extractFormantTracks (
        const PartialTracker::AnalysisResult& analysis, double sampleRate) const;

    // Get the last analysis result
    const PartialTracker::AnalysisResult& getLastAnalysis() const { return lastAnalysis_; }
    const std::vector<HarmonicGroup>& getLastGroups() const { return lastGroups_; }

    // Configuration
    void setMaxHarmonics (int max) { maxHarmonics_ = max; }
    void setGroupingTolerance (float cents) { groupingTolerance_ = cents; }
    void setMinNoteDuration (int frames) { minNoteDuration_ = frames; }

private:
    PartialTracker tracker_;
    PartialTracker::AnalysisResult lastAnalysis_;
    std::vector<HarmonicGroup> lastGroups_;

    int maxHarmonics_ = 30;
    float groupingTolerance_ = 50.0f;  // cents tolerance for harmonic matching
    int minNoteDuration_ = 5;          // minimum frames for a note

    int nextNoteId_ = 0;

    // Group partials into harmonic sets
    std::vector<HarmonicGroup> groupPartials (const PartialTracker::AnalysisResult& analysis);

    // LPC spectral envelope estimation (order 14)
    static std::vector<float> estimateLPCEnvelope (
        const std::vector<float>& magnitudes, int numBins,
        double sampleRate, int lpcOrder = 14);

    // Convert Hz to MIDI note number
    static float hzToMidi (float hz);

    // Check if freq is a harmonic of f0 (within tolerance in cents)
    static bool isHarmonic (float freq, float f0, int maxHarmonic, float toleranceCents, int& harmonicNum);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SinusoidalModel)
};
