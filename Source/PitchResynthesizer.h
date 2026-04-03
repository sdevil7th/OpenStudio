#pragma once

#include <JuceHeader.h>
#include "PitchAnalyzer.h"
#include <vector>
#include <functional>

/**
 * PitchResynthesizer — Offline pitch correction from graphical edits.
 *
 * Takes original audio + edited notes, produces corrected audio.
 * Uses Signalsmith Stretch for pitch shifting — handles mono and stereo
 * natively, with formant preservation and clean phase handling.
 *
 * Non-destructive: original audio is never modified.
 */
class PitchResynthesizer
{
public:
    enum class PitchEngine
    {
        Signalsmith,    // Signalsmith Stretch — default, high quality, stereo-native
        WorldVocoder,   // WORLD fallback (mono only, kept for compatibility)
        PhaseVocoder    // Basic phase vocoder fallback
    };

    enum class RenderQuality
    {
        PreviewFast,
        FinalHQ
    };

    PitchResynthesizer();

    /**
     * Apply pitch corrections to multi-channel audio.
     * All engines handle stereo natively (no mono mix fallback).
     */
    std::vector<std::vector<float>> processMultiChannel (
        const float* const* input,
        int numChannels,
        int numSamples,
        double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        PitchEngine engine = PitchEngine::Signalsmith,
        float globalFormantSemitones = 0.0f,
        RenderQuality renderQuality = RenderQuality::FinalHQ,
        std::function<bool()> shouldCancel = {});

    /**
     * Build a per-sample pitch shift ratio curve from the note edits.
     * Public so AudioEngine can inspect it for debugging.
     */
    std::vector<float> buildCorrectionCurve (
        int numSamples, double sampleRate,
        const std::vector<PitchAnalyzer::PitchFrame>& frames,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        int hopSize);

    /**
     * Build a per-sample formant shift ratio curve from the note edits.
     * Returns empty vector if no notes have formant shifts (skip formant processing).
     */
    static std::vector<float> buildFormantCurve (
        int numSamples, double sampleRate,
        const std::vector<PitchAnalyzer::PitchNote>& notes,
        float globalFormantSemitones = 0.0f);

    /** No-op — kept for API compatibility with AudioEngine. */
    void clearCache() {}

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PitchResynthesizer)
};
