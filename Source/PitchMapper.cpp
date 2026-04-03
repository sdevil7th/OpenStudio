#include "PitchMapper.h"
#include <cmath>
#include <algorithm>

// Scale interval definitions: true = note is in scale, indexed 0-11 from root
// clang-format off
static const std::array<bool, 12> scaleChromatic       = { true, true, true, true, true, true, true, true, true, true, true, true };
static const std::array<bool, 12> scaleMajor            = { true, false, true, false, true, true, false, true, false, true, false, true };
static const std::array<bool, 12> scaleNaturalMinor     = { true, false, true, true, false, true, false, true, true, false, true, false };
static const std::array<bool, 12> scaleHarmonicMinor    = { true, false, true, true, false, true, false, true, true, false, false, true };
static const std::array<bool, 12> scaleMelodicMinor     = { true, false, true, true, false, true, false, true, false, true, false, true };
static const std::array<bool, 12> scalePentMajor        = { true, false, true, false, true, false, false, true, false, true, false, false };
static const std::array<bool, 12> scalePentMinor        = { true, false, false, true, false, true, false, true, false, false, true, false };
static const std::array<bool, 12> scaleBlues            = { true, false, false, true, false, true, true, true, false, false, true, false };
static const std::array<bool, 12> scaleDorian           = { true, false, true, true, false, true, false, true, false, true, true, false };
static const std::array<bool, 12> scaleMixolydian       = { true, false, true, false, true, true, false, true, false, true, true, false };
static const std::array<bool, 12> scaleLydian           = { true, false, true, false, true, false, true, true, false, true, false, true };
static const std::array<bool, 12> scalePhrygian         = { true, true, false, true, false, true, false, true, true, false, true, false };
static const std::array<bool, 12> scaleLocrian          = { true, true, false, true, false, true, true, false, true, false, true, false };
static const std::array<bool, 12> scaleWholeTone        = { true, false, true, false, true, false, true, false, true, false, true, false };
static const std::array<bool, 12> scaleDiminished       = { true, false, true, true, false, true, true, false, true, true, false, true };
// clang-format on

PitchMapper::PitchMapper()
{
    for (auto& ne : noteEnables)
        ne.store(true, std::memory_order_relaxed);
}

void PitchMapper::prepare(double sr)
{
    cachedSampleRate = sr;
    reset();
}

void PitchMapper::reset()
{
    currentOutputMidi = 0.0f;
    hasLastOutput = false;
}

void PitchMapper::setKey(int note) { rootNote.store(note % 12, std::memory_order_relaxed); }
void PitchMapper::setScale(Scale scale) { currentScale.store(static_cast<int>(scale), std::memory_order_relaxed); }
void PitchMapper::setRetuneSpeed(float ms) { retuneSpeedMs.store(juce::jlimit(0.0f, 400.0f, ms), std::memory_order_relaxed); }
void PitchMapper::setHumanize(float pct) { humanizePercent.store(juce::jlimit(0.0f, 100.0f, pct), std::memory_order_relaxed); }
void PitchMapper::setTranspose(int st) { transposeSemitones.store(juce::jlimit(-24, 24, st), std::memory_order_relaxed); }
void PitchMapper::setCorrectionStrength(float s) { correctionStrength.store(juce::jlimit(0.0f, 1.0f, s), std::memory_order_relaxed); }
void PitchMapper::setFormantCorrection(bool on) { formantCorrectionOn.store(on, std::memory_order_relaxed); }
void PitchMapper::setFormantShift(float st) { formantShiftSemitones.store(juce::jlimit(-12.0f, 12.0f, st), std::memory_order_relaxed); }

void PitchMapper::setNoteEnabled(int note, bool enabled)
{
    noteEnables[note % 12].store(enabled, std::memory_order_relaxed);
}

float PitchMapper::hzToMidi(float hz)
{
    if (hz <= 0.0f) return 0.0f;
    return 69.0f + 12.0f * std::log2(hz / 440.0f);
}

float PitchMapper::midiToHz(float midi)
{
    return 440.0f * std::pow(2.0f, (midi - 69.0f) / 12.0f);
}

float PitchMapper::snapToScale(float midiNote) const
{
    int root = rootNote.load(std::memory_order_relaxed);
    auto scale = static_cast<Scale>(currentScale.load(std::memory_order_relaxed));
    const auto& scaleNotes = getScaleNotes(scale);

    // Round to nearest semitone, then find closest enabled scale degree
    int nearest = static_cast<int>(std::round(midiNote));
    float bestDistance = 100.0f;
    int bestNote = nearest;

    // Search within ±6 semitones (covers worst case)
    for (int offset = -6; offset <= 6; ++offset)
    {
        int candidate = nearest + offset;
        int degree = ((candidate - root) % 12 + 12) % 12;

        // Check both scale membership AND per-note enable
        if (scaleNotes[static_cast<size_t>(degree)]
            && noteEnables[static_cast<size_t>(degree)].load(std::memory_order_relaxed))
        {
            float dist = std::abs(midiNote - static_cast<float>(candidate));
            if (dist < bestDistance)
            {
                bestDistance = dist;
                bestNote = candidate;
            }
        }
    }

    return static_cast<float>(bestNote);
}

float PitchMapper::getSnapTarget(float detectedHz) const
{
    if (detectedHz <= 0.0f) return 0.0f;

    float midiNote = hzToMidi(detectedHz);
    float target = snapToScale(midiNote);
    target += static_cast<float>(transposeSemitones.load(std::memory_order_relaxed));

    return midiToHz(target);
}

float PitchMapper::mapPitch(float detectedHz, float conf, float deltaTime)
{
    if (detectedHz <= 0.0f || conf < 0.05f)
    {
        // No valid pitch detected — hold last output
        return hasLastOutput ? midiToHz(currentOutputMidi) : detectedHz;
    }

    float inputMidi = hzToMidi(detectedHz);

    // 1. Snap to scale
    float targetMidi = snapToScale(inputMidi);

    // 2. Apply transpose
    targetMidi += static_cast<float>(transposeSemitones.load(std::memory_order_relaxed));

    // 3. Apply correction strength (blend between input and snapped target)
    float strength = correctionStrength.load(std::memory_order_relaxed);
    targetMidi = inputMidi + (targetMidi - inputMidi) * strength;

    // 4. Apply humanize (let some original pitch deviation pass through)
    float humanize = humanizePercent.load(std::memory_order_relaxed) / 100.0f;
    if (humanize > 0.0f)
    {
        float deviation = inputMidi - targetMidi;
        targetMidi += deviation * humanize;
    }

    // 5. Apply retune speed (smooth transition to target)
    float speedMs = retuneSpeedMs.load(std::memory_order_relaxed);

    if (!hasLastOutput)
    {
        currentOutputMidi = targetMidi;
        hasLastOutput = true;
    }
    else if (speedMs <= 0.5f)
    {
        // Instant correction
        currentOutputMidi = targetMidi;
    }
    else
    {
        // Exponential smoothing toward target
        // Time constant: ~63% of the way there in speedMs milliseconds
        float tau = speedMs / 1000.0f; // convert to seconds
        float alpha = 1.0f - std::exp(-deltaTime / tau);
        alpha = juce::jlimit(0.0f, 1.0f, alpha);
        currentOutputMidi += (targetMidi - currentOutputMidi) * alpha;
    }

    // 6. Scale confidence: reduce correction on uncertain frames
    if (conf < 0.5f)
    {
        float blend = conf / 0.5f; // 0 at conf=0, 1 at conf>=0.5
        currentOutputMidi = inputMidi + (currentOutputMidi - inputMidi) * blend;
    }

    return midiToHz(currentOutputMidi);
}

const std::array<bool, 12>& PitchMapper::getScaleNotes(Scale scale)
{
    switch (scale)
    {
        case Scale::Chromatic:       return scaleChromatic;
        case Scale::Major:           return scaleMajor;
        case Scale::NaturalMinor:    return scaleNaturalMinor;
        case Scale::HarmonicMinor:   return scaleHarmonicMinor;
        case Scale::MelodicMinor:    return scaleMelodicMinor;
        case Scale::PentatonicMajor: return scalePentMajor;
        case Scale::PentatonicMinor: return scalePentMinor;
        case Scale::Blues:           return scaleBlues;
        case Scale::Dorian:          return scaleDorian;
        case Scale::Mixolydian:      return scaleMixolydian;
        case Scale::Lydian:          return scaleLydian;
        case Scale::Phrygian:        return scalePhrygian;
        case Scale::Locrian:         return scaleLocrian;
        case Scale::WholeTone:       return scaleWholeTone;
        case Scale::Diminished:      return scaleDiminished;
        case Scale::Custom:          return scaleChromatic; // Custom uses noteEnables directly
        default:                     return scaleChromatic;
    }
}

std::array<bool, 12> PitchMapper::getScaleIntervals(Scale scale)
{
    return getScaleNotes(scale);
}

const char* PitchMapper::getScaleName(Scale scale)
{
    switch (scale)
    {
        case Scale::Chromatic:       return "Chromatic";
        case Scale::Major:           return "Major";
        case Scale::NaturalMinor:    return "Natural Minor";
        case Scale::HarmonicMinor:   return "Harmonic Minor";
        case Scale::MelodicMinor:    return "Melodic Minor";
        case Scale::PentatonicMajor: return "Pentatonic Major";
        case Scale::PentatonicMinor: return "Pentatonic Minor";
        case Scale::Blues:           return "Blues";
        case Scale::Dorian:          return "Dorian";
        case Scale::Mixolydian:      return "Mixolydian";
        case Scale::Lydian:          return "Lydian";
        case Scale::Phrygian:        return "Phrygian";
        case Scale::Locrian:         return "Locrian";
        case Scale::WholeTone:       return "Whole Tone";
        case Scale::Diminished:      return "Diminished";
        case Scale::Custom:          return "Custom";
        default:                     return "Unknown";
    }
}
