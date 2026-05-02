# Pitch Editor Engine V2 Implementation Guide

Status note on 2026-04-17:

- the engine-v2 implementation work is complete enough for comparison, but it is no longer the recommended active recovery path
- root-cause research, ML benchmark, and engine-v3 feasibility are now recorded in:
  - [pitch_root_cause_research_20260417.md](c:/Users/srvds/Documents/Codes/Studio13-v3/docs/pitch_root_cause_research_20260417.md)
- current repo truth:
  - `pitch_only_adaptive_selector` remains the kept working baseline
  - local ML restoration is blocked because no materially stronger note-local restorer is available in this environment
  - the first `engine-v3` feasibility probe returned `stop`

## Goal
Move the pitch editor to a 2-tier workflow:

- `Tier 1`: instant drag monitoring while the user is moving a note
- `Tier 2`: debounced HQ note/island render that becomes the authoritative playback result for the changed region

This program is built on top of the current repo truth:

- kept live branch: `pitch_only_adaptive_selector`
- active experimental path: `pitch_only_engine_v2_program`
- note-change stutter and formant drift are still unresolved
- code must stay in place for user audition before cleanup

## Locked Product Behavior
- Use `2` tiers, not 1 or 3
- Drag monitoring starts immediately while the note is moving
- HQ note render starts after roughly `300 ms` of inactivity
- Transport playback does not use preview-quality audio for committed edits
- Changed regions wait for HQ-ready cache audio before the new edit becomes authoritative
- Experimental code is not removed until after user listening validation

## Implemented Foundation
### Current v1 infrastructure
- Added `note_hq` as a first-class pitch correction render mode
- Auto-apply now targets note-local HQ renders instead of staged playhead segments
- Drag lifecycle now starts and stops interactive pitch monitoring explicitly
- Playback region replacement keeps the last valid rendered region until a newer overlapping HQ region is ready
- Regression harness accepts `note_hq` render jobs
- Added a dedicated RAM scrub-preview path:
  - backend entrypoints:
    - `startPitchScrubPreview`
    - `updatePitchScrubPreview`
    - `stopPitchScrubPreview`
  - native playback mixes a RAM loop monitor voice directly from `PlaybackEngine`
  - scrub loops are extracted from the stable interior of the selected note, not the onset
  - stereo clips are supported by deriving loop bounds from mono analysis and extracting matching multichannel audio
- Added the first real `engine-v2` audio implementation on top of the scaffold:
  - Signalsmith-based voiced-core renderer in the transition window
  - cepstral envelope restoration on voiced-support frames
  - spectral-flatness-driven transient/unvoiced bypass mask
  - residual carry reinjection from shared own-engine analysis
  - transition compositor that mixes:
    - original transient shell
    - voiced core
    - adaptive-selector base
    - residual carry

### Current limitations
- The scrub voice is now benchmarked through a dedicated stopped-transport scrub harness, but it still needs real user audition in the editor UI
- `engine-v2` sound work is now implemented, but the first full audible pass regresses both primary `+4` truth clips badly
- The current `engine-v2` transition compositor is still too broad and is dragging the stable note body off target
- The audible product issues remain unresolved:
  - stutter on note change
  - formant/timbre drift on note change

## Architecture
### Tier 1: drag monitoring
- Start on note drag begin for pitch-affecting gestures
- Use note-local pitch preview derived from the selected note window
- Clear immediately on drag end
- This tier is intentionally fast and temporary

### Tier 2: HQ note cache
- Trigger after debounce
- Render only the changed note/island region plus transition shoulders
- Store the result as a playback override region
- Replace overlapping cached regions atomically when a newer HQ render finishes

### Transport behavior
- While a new HQ note render is pending, transport keeps using the last valid audio for that region
- Once the new HQ note render completes, playback swaps to the new override region
- No preview-quality renderer is used for committed transport playback

## Next Engine-V2 Audio Steps
1. Tighten `engine-v2` engagement to the transition core instead of the wider note window
2. Lower wet exposure so adaptive-selector remains the dominant carrier outside the transition nucleus
3. Keep cepstral envelope restoration only where voiced support is strong and stable
4. Keep transient/unvoiced bypass mandatory at the transition edges
5. Rebalance residual carry so it restores breathiness without shifting core pitch/body
6. Re-run the truth cases against:
   - `CTRL-SHIP`
   - `CTRL-R6`
   - `pitch_only_adaptive_selector`
   - current `pitch_only_engine_v2_program`

## Current Benchmark Snapshot
### Dedicated scrub preview
- Implemented and build-clean
- Native/backend path is active
- Dedicated scrub regression now passes with the natural-segment path on stopped transport:
  - run: `20260416_200227_pitchOrg_scrub_preview_r8`
  - result:
    - `scrubPreviewAudible=true`
    - `scrubPreviewFirstDragAudible=true`
    - start latency `26.9 ms`
    - stop latency `26.8 ms`
    - loop duration `240.0 ms`
    - base pitch `365.17 Hz`
    - repeat stability `0.4699`
    - last peak `0.1123`
- The render-quality harness still does not score drag feel, so scrub regression remains a separate check
- Multi-scenario scrub suite now exists:
  - runner: `tools/run-ui-pitch-scrub-suite.ps1`
  - richer runs:
    - `20260416_231821_pitchOrg_scrub_suite_richer_r1`
    - `20260416_234516_pitchTest_scrub_suite_richer_r1`
  - current measured state:
    - first drag audible: `true`
    - repeated-drag suite case audible: `true`
    - after-transport-cycle suite case audible: `true`
    - true multi-note fixtures now exist:
      - `tests/fixtures/pitch-regression/example_pitchOrg_scrub_multinote.json`
      - `tests/fixtures/pitch-regression/example_pitchTest_scrub_multinote.json`
    - multi-note scrub run: `20260416_235640_pitchTest_scrub_suite_multinote_r3`
    - selection-change is now exercised end-to-end on the multi-note scrub fixture
- Important honesty note:
  - scrub preview is now structurally present and richer-benchmarked across the current canonical local scrub scenarios
  - `H1` is complete for the current canonical local fixture corpus
    - the suite does not yet score perceived “breaking/tearing” quality directly
    - the user-facing sound still needs listening validation in the editor

### Boundary / transient / formant harnesses
- Boundary suite exists and runs:
  - runner: `tools/run-ui-pitch-boundary-suite.ps1`
- Manifest-driven regression suite runner now exists:
  - `tools/run-ui-pitch-regression-suite.ps1`
- Transient and formant wrappers now exist on top of it:
  - `tools/run-ui-pitch-transient-suite.ps1`
  - `tools/run-ui-pitch-formant-suite.ps1`
- Richer manifests added:
  - `tests/fixtures/pitch-regression/suites/transient_richer_suite.json`
  - `tests/fixtures/pitch-regression/suites/formant_richer_suite.json`
- Richer benchmark runs:
  - transient: `20260416_231844_transient_suite_richer_r1`
  - formant: `20260416_233426_formant_suite_richer_r1`
- Important honesty note:
  - `H3` and `H4` are now complete for the current canonical local fixture corpus
  - they still do not represent a broad real-world vocal corpus, but they are no longer smoke-only placeholders

## Remaining Iterations
- Mandatory iterations still remaining: `0`
- Conditional phase-locking iterations still remaining: `+2`
- Why `0` remains:
  - `S1-S3` are effectively in
  - `H2` boundary harness is in
  - `H1`, `H3`, and `H4` now have richer canonical-suite coverage and are treated as closed for the current local fixture corpus
  - the adaptive-carrier tuning track is closed for now at its current best profile
  - `A7` is complete and flat
  - the engine-v2 challenger is now frozen after the narrowed `r8` close-out pass
  - there is no remaining mandatory harness close-out work in the current local fixture corpus

## What We Learned After Close-Out
- engine-v2 did not fail because of missing plumbing anymore
- it failed because the remaining error is centered on:
  - transition ownership and boundary timing drift
  - mixed transient and first-voiced-cycle handling
  - formant preservation that is too weak and too local for hard transitions
- those findings came from the bounded root-cause pass on 2026-04-17, not from another speculative renderer loop
- that means this document should now be read as implementation history and available scaffolding, not as the primary next-step plan

### `engine-v2` first audible implementation
- `pitchOrg +4`
  - branch: `pitch_only_engine_v2_program`
  - run: `20260416_124252_pitchOrg_plus4_note_hq_engine_v2_program_impl_r2`
  - result:
    - note mel `9.653`
    - env `1.782`
    - note/body/core cents `-18.72 / -18.72 / -37.23`
    - entry mel `10.430`
    - exit mel `11.219`
    - onset artifact `3.23`
    - `spectralEnvelopeCorrectionUsed=true`
    - `engineV2Used=true`
- `pitchTestOrg +4`
  - branch: `pitch_only_engine_v2_program`
  - run: `20260416_124622_pitchTestOrg_plus4_note_hq_engine_v2_program_impl_r3`
  - result:
    - note mel `11.303`
    - env `1.425`
    - note/body/core cents `-17.94 / -17.94 / -36.45`
    - entry mel `8.389`
    - exit mel `10.274`
    - onset artifact `0.85`
    - `spectralEnvelopeCorrectionUsed=true`
    - `engineV2Used=true`
- Verdict:
  - infrastructure is real and benchmarkable
  - first audible pass is not keepable
  - code remains in place for user test and further tuning

### Latest tuning snapshot
- `B1-B3` engine-v2 challenger close-out
  - runs:
    - `20260416_230357_enginev2_narrow_pitchOrg_plus4_r8`
    - `20260416_230555_enginev2_narrow_pitchTest_plus4_r8`
  - result:
    - `pitchOrg +4`
      - note mel `6.608`
      - env `1.009`
      - entry `7.620`
      - exit `7.112`
      - onset artifact `1.390`
      - formant drift `0.395`
    - `pitchTestOrg +4`
      - note mel `3.143`
      - env `0.498`
      - entry `7.017`
      - exit `1.887`
      - onset artifact `4.000`
      - formant drift `0.062`
  - verdict:
    - the narrowed/drier engine-v2 pass still loses clearly to the adaptive correction carrier on the hard clip
    - easy-clip onset improves, but entry timbre still worsens
    - hard-clip entry and onset remain much worse than the adaptive carrier
    - freeze the challenger and stop spending main budget here

- `A7` STFT correction-layer sweep
  - runs:
    - `20260416_224905_adaptive_stft_tune_r10_1024o8`
    - `20260416_224905_adaptive_stft_tune_r10_2048o8`
    - `20260416_224905_adaptive_stft_tune_r10_2048o4`
  - result:
    - all three profiles were effectively identical on both smoke cases
    - `pitchOrg +4` stayed at about:
      - note mel `6.525`
      - env `1.022`
      - entry `6.885`
      - exit `7.112`
      - onset artifact `2.257`
      - formant drift `0.374`
    - `pitchTestOrg +4` stayed at about:
      - note mel `2.828`
      - env `0.469`
      - entry `1.703`
      - exit `1.887`
      - onset artifact `1.688`
      - formant drift `0.050`
  - verdict:
    - STFT size / hop is not the dominant lever in the current adaptive correction layer
    - `A7` should be treated as complete and flat

- `pitchOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_223535_adaptive_residual_tune_r9_dry`
  - result:
    - note mel `6.525`
    - env `1.022`
    - entry mel `6.885`
    - exit mel `7.112`
    - onset artifact `2.257`
    - boundary timing error `8.417 ms`
    - formant body harmonic drift `0.374`
    - `spectralEnvelopeCorrectionUsed=true`
- `pitchTestOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_223535_adaptive_residual_tune_r9_dry`
  - result:
    - note mel `2.828`
    - env `0.469`
    - entry mel `1.703`
    - exit mel `1.887`
    - onset artifact `1.688`
    - boundary timing error `2.229 ms`
    - formant body harmonic drift `0.050`
    - `spectralEnvelopeCorrectionUsed=true`
- Verdict on the current best adaptive-carrier correction pass:
  - `r9 dry` is the current best adaptive correction profile
  - `A5` cepstral strength/lifter sweeps were effectively flat on the smoke suite
  - `A6` residual carry sweep favored the driest profile, so the default correction path now keeps residual reinjection off
  - it is still not fully keepable:
    - `pitchOrg +4` onset artifact remains materially worse than plain adaptive
    - `pitchTestOrg +4` onset and exit remain somewhat worse than plain adaptive even though the gap is much smaller
  - the next tuning priority should now be:
    - `A7` STFT correction-layer sweep
    - then challenger close-out `B1-B4`

- `pitchOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_213810_adaptive_boundary_tune_r7_onsetcleanup`
  - result:
    - note mel `6.526`
    - env `1.023`
    - entry mel `6.890`
    - exit mel `7.112`
    - onset artifact `2.261`
    - boundary timing error `8.396 ms`
    - formant body harmonic drift `0.374`
    - `spectralEnvelopeCorrectionUsed=true`
- `pitchTestOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_213810_adaptive_boundary_tune_r7_onsetcleanup`
  - result:
    - note mel `2.828`
    - env `0.470`
    - entry mel `1.707`
    - exit mel `1.887`
    - onset artifact `1.714`
    - boundary timing error `2.250 ms`
    - formant body harmonic drift `0.050`
    - `spectralEnvelopeCorrectionUsed=true`
- Verdict on the current best adaptive-carrier correction pass:
  - `r7` is the best adaptive correction profile so far
  - it meaningfully improves the hard clip:
    - note mel is now close to the plain adaptive baseline
    - exit damage is far lower than earlier correction passes
  - it is still not fully keepable:
    - `pitchOrg +4` onset artifact remains materially worse than plain adaptive
    - `pitchTestOrg +4` onset artifact and exit are still worse than plain adaptive even though they are much closer now
  - the next tuning priority should now be:
    - `A5` cepstral lifter retune with richer formant fixtures
    - `A6` residual carry rebalance
    - then decide whether one more adaptive boundary cleanup pass is justified before more engine-v2 work

- `pitchOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_212441_adaptive_boundary_tune_r5_compromise`
  - result:
    - note mel `6.533`
    - env `1.039`
    - entry mel `7.462`
    - exit mel `7.044`
    - onset artifact `2.261`
    - boundary timing error `8.396 ms`
    - formant body harmonic drift `0.373`
    - `spectralEnvelopeCorrectionUsed=true`
- `pitchTestOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_212441_adaptive_boundary_tune_r5_compromise`
  - result:
    - note mel `2.935`
    - env `0.487`
    - entry mel `1.833`
    - exit mel `3.665`
    - onset artifact `1.748`
    - boundary timing error `2.250 ms`
    - formant body harmonic drift `0.040`
    - `spectralEnvelopeCorrectionUsed=true`
- Verdict on the current best adaptive-carrier correction pass:
  - `r5` is the best adaptive correction profile so far
  - it is still not keepable:
    - `pitchOrg +4` note-start artifact is still materially worse than the plain adaptive baseline
    - `pitchTestOrg +4` exit quality is improved but still much worse than baseline
  - the next tuning priority should now be:
    - `A4` entry timing compensation
    - `A5` cepstral lifter retune
    - then a narrower `A3` crossfade-law cleanup if the start remains rough in listening

- `pitchOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_211448_adaptive_boundary_tune_r3`
  - result:
    - note mel `6.537`
    - env `1.040`
    - entry mel `7.435`
    - exit mel `7.028`
    - onset artifact `2.383`
    - boundary timing error `8.396 ms`
    - formant body harmonic drift `0.373`
    - `spectralEnvelopeCorrectionUsed=true`
- `pitchTestOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_211448_adaptive_boundary_tune_r3`
  - result:
    - note mel `2.960`
    - env `0.493`
    - entry mel `1.876`
    - exit mel `4.067`
    - onset artifact `1.540`
    - boundary timing error `2.250 ms`
    - formant body harmonic drift `0.039`
    - `spectralEnvelopeCorrectionUsed=true`
- Verdict on the second adaptive-carrier correction pass:
  - this pass is better than `r2`, especially on `pitchTestOrg +4`
  - it is still not keepable:
    - `pitchOrg +4` onset artifact remains materially worse than the pre-correction adaptive baseline
    - `pitchTestOrg +4` exit quality and boundary timing are still much worse than baseline even after the improvement
  - the next tuning priority remains:
    - `A3` transient handoff crossfade sweep
    - `A4` entry timing compensation
    - `A5` cepstral lifter retune

- `pitchOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_210838_adaptive_boundary_tune_r2`
  - result:
    - note mel `6.548`
    - env `1.044`
    - entry mel `7.383`
    - exit mel `7.007`
    - onset artifact `3.259`
    - boundary timing error `8.417 ms`
    - formant body harmonic drift `0.372`
    - `spectralEnvelopeCorrectionUsed=true`
- `pitchTestOrg +4`
  - branch: `pitch_only_adaptive_selector`
  - run: `20260416_210838_adaptive_boundary_tune_r2`
  - result:
    - note mel `3.029`
    - env `0.511`
    - entry mel `1.993`
    - exit mel `5.269`
    - onset artifact `0.824`
    - boundary timing error `5.458 ms`
    - formant body harmonic drift `0.038`
    - `spectralEnvelopeCorrectionUsed=true`
- Verdict on the first adaptive-carrier correction pass:
  - this was a real engaged run, not a stale-binary repeat
  - it is still not keepable:
    - `pitchOrg +4` improved note/body similarity slightly, but onset artifact got much worse
    - `pitchTestOrg +4` improved onset/formant proxy, but exit quality and boundary timing got much worse
  - the current tuning priority should move to:
    - `A3` transient handoff crossfade sweep
    - `A4` entry timing compensation
    - `A5` cepstral lifter retune

- `pitchOrg +4`
  - branch: `pitch_only_engine_v2_program`
  - run: `20260416_152736_pitchOrg_plus4_note_hq_engine_v2_tune_r7`
  - result:
    - note mel `7.314`
    - env `1.347`
    - entry mel `7.396`
    - exit mel `7.027`
    - onset artifact `1.388`
    - boundary timing error `0.792 ms`
    - formant body harmonic drift `0.415`
- `pitchTestOrg +4`
  - branch: `pitch_only_engine_v2_program`
  - run: `20260416_152736_pitchTestOrg_plus4_note_hq_engine_v2_tune_r7`
  - result:
    - note mel `3.540`
    - env `0.521`
    - entry mel `7.513`
    - exit mel `1.632`
    - onset artifact `4.013`
    - onset delay `1.479 ms`
    - formant body harmonic drift `0.069`
- Comparison baseline:
  - adaptive still wins the hard case clearly:
    - `pitchOrg +4`: note mel `7.085`, entry mel `7.078`, onset artifact `1.803`
    - `pitchTestOrg +4`: note mel `2.810`, entry mel `1.530`, onset artifact `0.705`

## Validation Rules
- Keep comparing on:
  - `pitchOrg.wav -> pitchOrg+4s.wav`
  - `pitchTestOrg.wav -> pitchTestOrg+4s.wav`
- Run guard cases only after a real `+4` win
- Track:
  - note mel
  - note env RMSE
  - note/body/core cents
  - entry and exit mel/env
  - onset artifact
  - harmonic-envelope drift
  - render latency for note-local HQ jobs

## Cleanup Rule
- Mark new paths as `Active Test` or `User Pending`
- Do not remove experimental code until:
  - benchmark failure is recorded
  - and the user has listened to it or explicitly approved cleanup
