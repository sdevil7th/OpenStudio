#pragma once

#include <JuceHeader.h>
#include "PolyPitchDetector.h"
#include <vector>

/**
 * PolyResynthesizer — Polyphonic pitch correction stub.
 *
 * The old SMS-based polyphonic resynthesis has been removed.
 * This stub provides the API surface that AudioEngine uses so it compiles.
 * Polyphonic pitch correction will be re-implemented with Signalsmith Stretch
 * as a future improvement (per pitch_corrector_feat_plan.md).
 */
class PolyResynthesizer
{
public:
    struct EditedNote
    {
        juce::String id;
        float originalPitch    = 0.0f;   // MIDI
        float correctedPitch   = 0.0f;   // MIDI
        float formantShift     = 0.0f;   // semitones
        float gain             = 0.0f;   // dB
    };

    /**
     * Process polyphonic pitch correction.
     * Currently a stub — returns an empty vector (no modification).
     */
    std::vector<float> process (
        const float* /*audio*/,
        int          /*numSamples*/,
        double       /*sampleRate*/,
        const std::vector<PolyPitchDetector::PolyNote>& /*detectedNotes*/,
        const std::vector<EditedNote>& /*edits*/)
    {
        return {}; // Not yet implemented — returns empty to signal failure
    }

    /** Solo a single polyphonic note (stub — returns empty). */
    std::vector<float> soloNote (
        const float* /*audio*/,
        int          /*numSamples*/,
        double       /*sampleRate*/,
        const std::vector<PolyPitchDetector::PolyNote>& /*detectedNotes*/,
        const juce::String& /*noteId*/)
    {
        return {};
    }

    /** Encode result as JSON for the JS bridge. */
    static juce::var resultToJSON (const juce::String& outputPath, bool success)
    {
        juce::DynamicObject* obj = new juce::DynamicObject();
        obj->setProperty ("success",    success);
        obj->setProperty ("outputPath", outputPath);
        return juce::var (obj);
    }
};
