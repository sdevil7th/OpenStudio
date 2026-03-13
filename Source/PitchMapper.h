#pragma once

#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <cmath>

/**
 * PitchMapper — Maps detected pitch to target pitch based on key, scale,
 * retune speed, humanize, and per-note enables.
 *
 * All methods are audio-thread safe (no allocation, no locks).
 */
class PitchMapper
{
public:
    PitchMapper();

    // ---- Scale Types ----
    enum class Scale : int
    {
        Chromatic = 0,
        Major,
        NaturalMinor,
        HarmonicMinor,
        MelodicMinor,
        PentatonicMajor,
        PentatonicMinor,
        Blues,
        Dorian,
        Mixolydian,
        Lydian,
        Phrygian,
        Locrian,
        WholeTone,
        Diminished,
        Custom,
        NumScales
    };

    // ---- Parameters (all thread-safe) ----
    void setKey(int rootNote);          // 0=C, 1=C#, ..., 11=B
    void setScale(Scale scale);
    void setRetuneSpeed(float ms);      // 0=instant snap, 400=gentle
    void setHumanize(float percent);    // 0=robotic, 100=natural
    void setTranspose(int semitones);   // -24 to +24
    void setNoteEnabled(int note, bool enabled); // Per-chromatic-note toggle (0-11)
    void setFormantCorrection(bool on);
    void setFormantShift(float semitones); // -12 to +12
    void setCorrectionStrength(float strength); // 0-1, 0=no correction, 1=full

    int getKey() const { return rootNote.load(std::memory_order_relaxed); }
    Scale getScale() const { return static_cast<Scale>(currentScale.load(std::memory_order_relaxed)); }
    float getRetuneSpeed() const { return retuneSpeedMs.load(std::memory_order_relaxed); }
    float getHumanize() const { return humanizePercent.load(std::memory_order_relaxed); }
    int getTranspose() const { return transposeSemitones.load(std::memory_order_relaxed); }
    bool isNoteEnabled(int note) const { return noteEnables[note % 12].load(std::memory_order_relaxed); }
    bool getFormantCorrection() const { return formantCorrectionOn.load(std::memory_order_relaxed); }
    float getFormantShift() const { return formantShiftSemitones.load(std::memory_order_relaxed); }
    float getCorrectionStrength() const { return correctionStrength.load(std::memory_order_relaxed); }

    /**
     * Map a detected frequency to a target frequency.
     *
     * @param detectedHz  The detected fundamental frequency
     * @param confidence  Detection confidence (0-1), used to reduce correction on uncertain frames
     * @param deltaTime   Time since last call (seconds), used for retune speed smoothing
     * @return            Target frequency in Hz
     */
    float mapPitch(float detectedHz, float confidence, float deltaTime);

    /**
     * Get the target pitch for a given input, ignoring retune speed and humanize.
     * Used for display purposes (showing what the "snap" target would be).
     */
    float getSnapTarget(float detectedHz) const;

    // Reset internal smoothing state
    void reset();

    // Prepare with sample rate
    void prepare(double sampleRate);

    // Get scale intervals (for UI display of which notes are in scale)
    static std::array<bool, 12> getScaleIntervals(Scale scale);

    // Get human-readable scale name
    static const char* getScaleName(Scale scale);

private:
    std::atomic<int> rootNote { 0 };      // 0=C
    std::atomic<int> currentScale { 0 };  // Scale::Chromatic
    std::atomic<float> retuneSpeedMs { 50.0f };
    std::atomic<float> humanizePercent { 0.0f };
    std::atomic<int> transposeSemitones { 0 };
    std::atomic<float> correctionStrength { 1.0f };
    std::atomic<bool> formantCorrectionOn { false };
    std::atomic<float> formantShiftSemitones { 0.0f };

    std::array<std::atomic<bool>, 12> noteEnables;

    // Smoothing state for retune speed
    float currentOutputMidi = 0.0f;
    bool hasLastOutput = false;
    double cachedSampleRate = 44100.0;

    // Convert between Hz and MIDI note number (fractional)
    static float hzToMidi(float hz);
    static float midiToHz(float midi);

    // Find nearest enabled scale degree
    float snapToScale(float midiNote) const;

    // Scale interval definitions (semitone offsets from root)
    static const std::array<bool, 12>& getScaleNotes(Scale scale);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PitchMapper)
};
