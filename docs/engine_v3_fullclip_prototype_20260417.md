# Engine-V3 Full-Clip Prototype Status (2026-04-17)

## What Landed
- Added new renderer branches:
  - `engine_v3_fullclip`
  - `engine_v3_fullclip_lpc`
  - `engine_v3_fullclip_lpc_transient`
- Added engine-v3 diagnostics plumbing through native + frontend regression results.
- Added continuous full-clip HQ output path for engine-v3 in `AudioEngine`.
- Added first LPC spectral envelope transfer helper in `LpcEnvelopeTransfer`.
- Hardened the current Signalsmith pitch-only path for better baseline formant configuration:
  - `setFormantBase(avgDetectedHz)` per block
  - inverse-ratio formant factor by default

## Important Bug Fixed During Bring-Up
- The first engine-v3 full-clip implementation created a corrected full buffer and then overwrote it with the original `clipBuffer` before writing the output file.
- This made the branch look active in diagnostics while exporting source-identical audio.
- That overwrite bug is now fixed.

## Current Truth
- `engine_v3_fullclip` now produces a real full-clip processed output.
- `engine_v3_fullclip_lpc` no longer collapses into NaN/silence after stability hardening, but it is still not keepable.
- The current engine-v3 prototype does **not** yet beat `pitch_only_adaptive_selector` on the canonical `pitchOrg +4` truth case.

## First Canonical Results
### Plain continuous carrier
- Run:
  - `D:\test projects\os tests\runs\20260417_035915_engine_v3_pitchOrg_plus4_fullclip_plain_r2fresh`
- Summary:
  - `engine_v3_fullclip`
  - sane audio output
  - note mel `9.963`
  - note envelope `1.229`
  - entry mel `7.867`
  - exit mel `9.306`
  - onset artifact `2.43`
- Verdict:
  - proves the continuous full-clip carrier path is live
  - still substantially worse than the kept adaptive baseline on the target problem

### LPC formant pass
- Run:
  - `D:\test projects\os tests\runs\20260417_035915_engine_v3_pitchOrg_plus4_fullclip_lpc_r3fresh`
- Summary:
  - `engine_v3_fullclip_lpc`
  - numerically stable after guard fixes
  - still extremely poor perceptual/regression quality
  - note mel `48.943`
  - note envelope `6.362`
  - entry mel `49.398`
  - exit mel `48.759`
- Verdict:
  - current LPC transfer implementation is not viable yet
  - it remains prototype-only and must not be promoted

## What This Means
- The structural continuity change is now real and benchmarkable.
- The first formant-transfer implementation is still wrong for the target vocal edit quality.
- Engine-v3 remains a prototype branch, not a product-ready replacement.

## Boundary-Zone Follow-Up
- Added a true boundary-zone blend on top of the continuous carrier:
  - original shell at the boundary
  - own-engine first-voiced-cycles patch
  - continuous carrier for the stable body
- Canonical runs:
  - `D:\test projects\os tests\runs\20260417_040833_engine_v3_pitchOrg_plus4_fullclip_plain_r3boundary`
  - `D:\test projects\os tests\runs\20260417_040833_engine_v3_pitchTest_plus4_fullclip_plain_r1boundary`
- Diagnostics confirm the boundary slice is engaging:
  - `firstVoicedCyclesEntryUsed=true`
  - `firstVoicedCyclesExitUsed=true`
  - `v3ContinuousRenderUsed=true`
- Verdict:
  - this is the first real boundary-zone ownership prototype
  - it still does not clear the quality gate on the canonical `+4` cases

## Safer Formant/Body Harvest Follow-Up
- Added a low-wet own-engine body-color harvest inside the edited note body only.
- Canonical runs:
  - `D:\test projects\os tests\runs\20260417_101035_engine_v3_pitchOrg_plus4_fullclip_plain_r4bodyharvest`
  - `D:\test projects\os tests\runs\20260417_101035_engine_v3_pitchTest_plus4_fullclip_r2bodyharvest`
- Verdict:
  - this bounded formant/body-color attempt did not materially move the canonical truth metrics
  - it is not the missing win

## Immediate Next Work
1. Keep `pitch_only_adaptive_selector` as the shipping baseline.
2. Treat `engine_v3_fullclip` as the active engine-v3 prototype.
3. Keep `engine_v3_fullclip_lpc` and `_transient` as experimental-only until they beat the baseline on:
   - `pitchOrg +4`
   - `pitchTestOrg +4`
   - `pitchOrg -4`
   - `pitchTestOrg -4`
4. Next engine-v3 DSP work should focus on:
   - first-voiced-cycles boundary ownership
   - safer formant transfer
   - immediate-neighbor-only smoothing validation
