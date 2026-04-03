# Studio13 Pitch Correction Engine — Signalsmith Stretch Integration Plan

## Goal

Replace the broken custom SMS synthesis engine with **Signalsmith Stretch** — a free
(MIT), header-only, production-quality phase vocoder that handles stereo natively, supports
per-block varying pitch ratios, and has built-in formant compensation.

The **note detection and graphical editor** (blobs, contour display, note segmentation) are
kept as-is using `PitchAnalyzer` (YIN) and `PartialTracker` / `SinusoidalModel::analyze()`.
Only the **synthesis** (actual audio pitch shifting) is replaced.

---

## Architecture After This Change

```
Input Audio (stereo or mono)
        │
        ▼
buildCorrectionCurve()          ← per-sample pitch ratio from note edits
buildFormantCurve()             ← per-sample formant ratio (independent shift)
        │
        ▼
SignalsmithShifter::process()   ← replaces ALL of: SMS resynthesis, WORLD vocoder,
  │  presetDefault(ch, sr)         phase vocoder, mono mix + SGT stereo path
  │  process in intervalSamples blocks
  │  setTransposeFactor(avgRatio) per block
  │  setFormantFactor(1/avgRatio) per block (keeps formants in place)
  │  handles stereo natively — NO mono mix needed
        │
        ▼
Output Audio (same channel count as input)
```

---

## What Is Removed

| File | Why Removed |
|------|-------------|
| `Source/FormantPreserver.h/.cpp` | WORLD vocoder — mono-only, speech-oriented, replaced |
| `Source/PitchShifter.h/.cpp` | Phase vocoder — basic, no formant preservation, replaced |
| `Source/SpectralPitchShifter.h/.cpp` | Old spectral pitch shifting, not used |
| `Source/SpectralProcessor.h/.cpp` | STFT utils only used by SpectralPitchShifter |
| `Source/PolyResynthesizer.h/.cpp` | Polyphonic SMS resynthesis, replaced |
| `Source/HarmonicMaskGenerator.h/.cpp` | Wiener masks for poly, replaced |
| SMS synthesis from `SinusoidalModel` | `resynthesizeWithRatios`, `additiveSynthOLA`, `extractSpectralResidual`, `synthesizeStochasticResidual`, `extractTransientLayer`, `classifyVoiceQuality`, `warpEnvelope`, `computeAmplitudeEnvelope`, `resynthesize` |
| SMS cache from `PitchResynthesizer` | `cachedAnalysis_`, `cachedGroups_`, `cachedCorrectedMono_`, `cachedRatios_`, `findChangedRange()` |

## What Is Kept

| File | Why Kept |
|------|----------|
| `Source/PitchAnalyzer.h/.cpp` | YIN pitch detection — drives the graphical editor note blobs |
| `Source/PitchDetector.h/.cpp` | Low-level YIN algorithm |
| `Source/PitchMapper.h/.cpp` | Scale/key snapping for real-time corrector |
| `Source/PartialTracker.h/.cpp` | STFT + partial tracking — kept for future SMS analysis improvements |
| `Source/SinusoidalModel.h/.cpp` | `analyze()` + `groupPartials()` — kept for future note visualization |
| `Source/S13PitchCorrector.h/.cpp` | Real-time inline pitch corrector (auto-tune style FX) |
| `Source/PolyPitchDetector.h/.cpp` | Basic-Pitch ONNX model — polyphonic note detection |
| `Source/PitchResynthesizer.h/.cpp` | Refactored: keeps `buildCorrectionCurve()`, uses Signalsmith |
| `Source/ARAHostController.h/.cpp` | ARA plugin hosting — unrelated to pitch |
| `Source/StemSeparator.h/.cpp` | AI stem separation — unrelated to pitch |

---

## New File

### `thirdparty/signalsmith/signalsmith-stretch.h`
- Single header from https://github.com/Signalsmith-Audio/signalsmith-stretch
- MIT license
- Provides `signalsmith::stretch::SignalsmithStretch<float>`

### `Source/SignalsmithShifter.h`
```
SignalsmithShifter::process(
    input,          // const float* const* — one pointer per channel
    numChannels,
    numSamples,
    sampleRate,
    ratios,         // per-sample pitch ratio (1.0 = no shift)
    formantRatios   // per-sample formant ratio (empty = auto-preserve)
) -> vector<vector<float>>   // one vector per channel, exactly numSamples long
```
Internally:
- Creates `SignalsmithStretch<float>`, calls `presetDefault(numChannels, sampleRate)`
- Processes in `intervalSamples()`-sized blocks
- Per block: averages ratio, calls `setTransposeFactor()` + `setFormantFactor()`, calls `process()`
- Feeds silence to flush latency, trims output to exact `numSamples`

---

## Quality Characteristics

| Aspect | Before (broken SMS) | After (Signalsmith) |
|--------|---------------------|---------------------|
| Stereo | Crashes | Native stereo, no mono mix |
| Amplitude | Distorted (10× inflation) | Preserved |
| Formants | Broken LPC path | Built-in compensation |
| Sibilants | Smeared by STFT | Good (Signalsmith preserves transients) |
| Artifacts | Heavy (phase vocoder + additive resynth combined) | Clean |
| Large shifts | Crashes or distorts | Handles well |

---

## Implementation Steps

1. Add `signalsmith-stretch.h` to `thirdparty/signalsmith/`
2. Create `Source/SignalsmithShifter.h` (wrapper class)
3. Refactor `Source/PitchResynthesizer.cpp` — replace SMS block with `SignalsmithShifter::process()`
4. Remove synthesis methods from `Source/SinusoidalModel.cpp/.h`
5. Delete `FormantPreserver`, `PitchShifter`, `SpectralPitchShifter`, `SpectralProcessor`, `PolyResynthesizer`, `HarmonicMaskGenerator`
6. Update `CMakeLists.txt` — add `thirdparty/signalsmith` to include path, remove deleted files, remove `world_static` dependency
7. Build, fix errors

---

## Future Improvements (Post-Integration)

Once the pitch corrector works cleanly with Signalsmith, the next quality improvements are:

### Near term
- **Per-note formant control**: The `buildFormantCurve()` already builds a per-sample formant
  ratio. Wire it to `setFormantFactor()` per block for independent formant shifting per note.
- **Transition crossfades**: At note boundaries (voiced→unvoiced), blend ratio smoothly over
  ~10ms already handled by `buildCorrectionCurve()`.

### Medium term
- **Incremental re-correction**: Signalsmith is fast enough to re-process the full window
  on each edit (~50ms for a 5s window). No incremental patching needed.
- **SMS analysis for pitch display**: `PartialTracker` + `SinusoidalModel::analyze()` can be
  used to display richer note information (harmonic content, detected partials) in the pitch
  editor UI beyond what YIN gives.

### Long term
- **Back to SMS synthesis**: Once a stable reference output exists from Signalsmith, we can
  incrementally improve the SMS synthesis layer and A/B test against Signalsmith until SMS
  surpasses it. At that point, SMS becomes the default and Signalsmith becomes the fallback.
