# Rubber Band Library Integration Plan

## Goal
Replace WORLD vocoder with Rubber Band Library for higher-quality pitch correction in the graphical pitch editor.

## Steps

### Step 1: Add Rubber Band to CMakeLists.txt
- [x] FetchContent from GitHub
- [x] Build as static lib from `single/RubberBandSingle.cpp` (avoids Meson dependency)
- [x] Define `USE_KISSFFT` + `NOMINMAX` (built-in FFT, no external deps, no Windows macro conflicts)
- [x] Link `rubberband_static` to Studio13_v2
- [x] Suppress warnings for rubberband target

### Step 2: Create RubberBandShifter wrapper
- [x] New files: `Source/RubberBandShifter.h` and `.cpp`
- [x] Multi-channel API (native stereo support)
- [x] Per-block varying pitch ratios via `setPitchScale()` between `process()` calls
- [x] Options: OptionProcessOffline, OptionPitchHighQuality, OptionFormantPreserved, OptionChannelsTogether
- [x] Study phase for best quality, then block-by-block processing
- [x] Trim/pad output to match input length exactly

### Step 3: Integrate into PitchResynthesizer
- [x] Add `PitchEngine` enum: PhaseVocoder, WorldVocoder, RubberBand
- [x] Add `processMultiChannel()` with Rubber Band code path alongside WORLD
- [x] Downsample per-sample ratios to per-block ratios (block size 256)
- [x] Default to Rubber Band engine

### Step 4: Modify AudioEngine::applyPitchCorrection() for native stereo
- [x] Pass all channels to RubberBandShifter via `processMultiChannel()` (not mono-only)
- [x] Remove mono-duplication workaround
- [x] Stitch multi-channel result back with crossfades

### Step 5: Register new source files in CMakeLists.txt
- [x] Add `Source/RubberBandShifter.cpp` to target_sources
- [x] Add Rubber Band include directory to Studio13_v2

### Step 6 (Future): Replace real-time PitchShifter preview
- [ ] Replace PitchShifter with RubberBandLiveShifter in PlaybackEngine
- [ ] Replace PitchShifter in S13PitchCorrector

## Files Modified
| File | Change |
|------|--------|
| CMakeLists.txt | FetchContent + static lib + link + include dir |
| Source/RubberBandShifter.h (new) | Wrapper class |
| Source/RubberBandShifter.cpp (new) | Implementation with study + process phases |
| Source/PitchResynthesizer.h | Added PitchEngine enum + processMultiChannel() |
| Source/PitchResynthesizer.cpp | Added processMultiChannel() with RubberBand/WORLD/PhaseVocoder paths |
| Source/AudioEngine.cpp | Native stereo via processMultiChannel() in applyPitchCorrection |

## Notes
- Keep WORLD as fallback (don't delete FormantPreserver)
- Rubber Band is GPL v2+ (commercial license needed for proprietary distribution)
- Study phase adds processing time but produces better transient handling
- Block size 256 for ratio granularity (matches YIN hop size)
- NOMINMAX required on Windows to prevent std::numeric_limits conflicts
