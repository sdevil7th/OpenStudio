/*
  ==============================================================================

    AudioAnalyzer.h
    Audio analysis utilities: reverse, transient detection, LUFS measurement

  ==============================================================================
*/

#pragma once

#include <JuceHeader.h>
#include <vector>

class AudioAnalyzer
{
public:
    AudioAnalyzer();
    ~AudioAnalyzer();

    // ===== Reverse Audio (Phase 9A) =====
    // Reverses an audio file and writes to a new file.
    // Returns the path to the reversed file, or empty string on failure.
    juce::String reverseAudioFile(const juce::String& filePath);

    // ===== Transient Detection (Phase 9B) =====
    // Detects transients in an audio file using energy-based onset detection.
    // Returns a list of transient times in seconds.
    // sensitivity: 0.1 (more transients) to 1.0 (fewer transients)
    // minGapMs: minimum gap between transients in milliseconds
    std::vector<double> detectTransients(const juce::String& filePath,
                                         double sensitivity,
                                         double minGapMs);

    // ===== LUFS Measurement (Phase 9D) =====
    struct LUFSResult {
        double integrated;   // Integrated LUFS (whole file/selection)
        double shortTerm;    // Short-term LUFS (last 3s window)
        double momentary;    // Momentary LUFS (last 400ms window)
        double truePeak;     // True peak in dB
        double range;        // Loudness range (LRA)
    };

    // Measures LUFS for a given audio file and time range.
    // If startTime/endTime are both 0, measures the entire file.
    LUFSResult measureLUFS(const juce::String& filePath,
                           double startTime = 0.0,
                           double endTime = 0.0);

    // ===== Strip Silence / Detect Silent Regions (Phase 3.12) =====
    struct SoundRegion {
        juce::int64 startSample;
        juce::int64 endSample;
    };

    // Scans audio file for non-silent regions.
    // thresholdDb: amplitude threshold (e.g., -48)
    // minSilenceMs: minimum silence gap to split on
    // minSoundMs: minimum sound region to keep
    // preAttackMs: include audio before detected transient
    // postReleaseMs: include audio after sound ends
    // Returns list of non-silent regions as sample ranges.
    std::vector<SoundRegion> detectSilentRegions(const juce::String& filePath,
                                                  double thresholdDb,
                                                  double minSilenceMs,
                                                  double minSoundMs,
                                                  double preAttackMs,
                                                  double postReleaseMs);

private:
    juce::AudioFormatManager formatManager;

    // K-weighting filter coefficients for LUFS measurement
    // Stage 1: High-shelf boost (+3.999 dB at high frequencies)
    // Stage 2: High-pass filter (removes sub-bass)
    struct KWeightFilter {
        double b0, b1, b2, a1, a2;
        double x1 = 0, x2 = 0, y1 = 0, y2 = 0;

        void reset() { x1 = x2 = y1 = y2 = 0; }

        double process(double x) {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x;
            y2 = y1; y1 = y;
            return y;
        }
    };

    static KWeightFilter createHighShelf(double sampleRate);
    static KWeightFilter createHighPass(double sampleRate);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioAnalyzer)
};
