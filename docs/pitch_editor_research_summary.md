# Pitch Editor Research Decision Log

Canonical status board: [pitch_recovery_master_map.md](c:/Users/srvds/Documents/Codes/Studio13-v3/docs/pitch_recovery_master_map.md)

Decision rule from 2026-04-14 onward:
- keep lifecycle state, queue order, and harvestable traits in the master map
- keep this file as the chronological experiment ledger with exact runs, metrics, and keep/reject decisions

### 2026-04-28: Entry Contour-Handoff Correction

Purpose:
- test the hypothesis that the remaining start artifact is caused by a pitch-trajectory discontinuity rather than only an audio splice.
- keep render context before the note without mutating the previous word or delaying hard step edits.

Implementation:
- added note-HQ entry pitch-handoff diagnostics through C++, the frontend bridge, and regression summaries.
- changed the native pitch-ratio curve so explicit continuous/internal transitions can use a minimum-jerk pitch handoff.
- kept hard/unknown entries on the legacy-compatible rule: pre-note render context is allowed, but the ratio reaches the target by `note.startTime` and audible dry/wet ownership stays with the entry bridge.
- added F0 slope/acceleration reporting to the reference harness; the hard gate is applied only when an actual pitch handoff is active.

Decision:
- keep the diagnostic and explicit-continuous handoff support.
- do not use a body-delayed pitch ramp for hard/unknown entries. Trial runs with a 20-40 ms hard-entry pitch ramp regressed `pitchOrg +4` onset artifact to `1.615` and then entry lag to `19-25 ms`; the correct hard-entry behavior is render pre-roll plus dry-protected commit, not delayed pitch onset.

Validation:
- `D:\test projects\os tests\runs\20260428_115125_entry_contour_handoff_plus4_final3`: passed, onset artifact `1.501`, exit-next `2.156`, pre-bridge residual `-172.205 dB`.
- `D:\test projects\os tests\runs\20260428_115314_entry_contour_handoff_minus4_final`: passed, onset artifact `1.187`, exit-next `0.207`, downshift harmonic drift `0.339`, spectral envelope correction enabled.
- `D:\test projects\os tests\runs\20260428_115719_entry_contour_handoff_two_adjacent_plus4_r2`: passed, one edit island for two edited notes, with internal pitch handoff diagnostics and no doubled dry/wet ownership.

### 2026-04-28: Emergency Word-Grouping Repair

Purpose:
- fix the regression where broad `wordGroupId` ownership caused one clicked note to move unrelated notes.
- prevent phrase-first segmentation from collapsing separate words into oversized editable regions.

Implementation:
- restored normal UI ownership: click/drag/edit operations affect only explicitly selected notes.
- removed the word-group hull overlay and "Word (n)" inspector behavior.
- kept `wordGroupId` as assistive metadata for diagnostics/render grouping, not as automatic selection or drag ownership.
- restored conservative analyzer merging: short `40 ms` merge gap plus pitch-distance guard, instead of merging every short gap bridged by phrase context.
- allowed strong acoustic `hard_word_like` candidates to split default analyzer regions, while pitch hysteresis/vibrato candidates remain non-destructive diagnostics.
- harness metrics now separate hard acoustic splits from destructive pitch-corner/pitch-jump failures and report expected-region overhang to catch collapsed words.

Decision:
- keep this repair immediately; product default must be "the note I clicked is the note I move."
- whole-word movement should require explicit multi-selection or a future dedicated group-edit mode, not implicit analyzer grouping.
- verification:
  - analyzer: `D:\test projects\os tests\runs\20260428_110455_emergency_word_group_repair_analysis_pitchOrg`, `noteCount=5`, `wordGroupCount=5`, destructive corner/pitch-jump splits `0/0`, hard acoustic splits `2`, max expected overhang `0.459`.
  - UI ownership: `pitchEditorSingleNoteOwnership.test.ts` passed; shared `wordGroupId` no longer expands selection, drag updates, or selected pitch moves.
  - audio: `pitchOrg +4` and `pitchOrg -4` note-HQ runs passed; `-4` harmonic drift measured `0.343`, onset artifacts measured `1.48` / `1.598`, exit-next artifacts `2.31` / `0.091`.
  - adjacent selected notes: `D:\test projects\os tests\runs\20260428_110807_emergency_repair_two_adjacent_plus4` reported one note-HQ edit island for two selected edits, confirming the double-voice ownership fix remains active.

### 2026-04-28: Phrase-First Vibrato-Safe Word Detection

Purpose:
- fix continued over-fragmentation where one sung word in a single breath is split by vibrato, bend, or melisma movement.
- make word/phrase regions the primary editable units while preserving pitch contour diagnostics.

Implementation:
- removed the destructive running-average pitch-jump split from default segmentation.
- short voiced detector dropouts are bridged up to `80 ms`; hard automatic cuts require long unvoiced gaps or sustained energy-break evidence.
- sustained pitch deviations are exported as `pitch_hysteresis_*` boundary candidates, never destructive splits.
- vibrato-like periodic reversals are marked as `internal_vibrato` diagnostics and remain inside the same editable word/phrase.
- close fragments can merge across short non-hard gaps regardless of pitch distance, because pitch difference alone is not a word boundary.
- superseded by the emergency repair: the canvas no longer selects/highlights `wordGroupId` as the primary object, and dragging one internal fragment no longer moves the whole group.

Decision:
- keep this as a product-model/analyzer correction, not a renderer experiment.
- corrected product rule: continuous breath, vibrato, bend, and melisma may stay related by metadata, but visible editing remains note-first unless the user explicitly selects multiple notes.
- destructive pitch-corner and pitch-jump splitting stays research-only/diagnostic by default.

Validation:
- native build and frontend build passed after the change.
- analyzer run `D:\test projects\os tests\runs\20260428_040921_phrase_first_word_detection_pitchOrg` passed with `noteCount=3`, `wordGroupCount=3`, `destructivePitchJumpSplitCount=0`, `destructiveCornerSplitCount=0`, edited-word overlap `1.000`, and max fragments `1`.
- primary note-HQ runs:
  - `D:\test projects\os tests\runs\20260428_040951_phrase_first_pitchOrg_plus4`
  - `D:\test projects\os tests\runs\20260428_041117_phrase_first_pitchOrg_minus4`
- adjacent-fragment diagnostic `D:\test projects\os tests\runs\20260428_041244_phrase_first_two_adjacent_plus4` confirmed one raw note-HQ edit island for two supplied fragments (`noteHqEditIslandCount=1`, `noteHqEditedNoteCount=2`).

### 2026-04-28: Word Grouping And Edit-Island Correction

Purpose:
- fix the regression where a single sung word is broken into several editable pieces.
- fix adjacent selected notes sounding doubled by treating them as one render island.

Implementation:
- pitch-corner detections are now `boundaryCandidates` by default, not automatic note splits.
- destructive corner splitting is available only with `OPENSTUDIO_ANALYZER_APPLY_CORNER_SPLITS=1`.
- analyzer notes now carry `wordGroupId`; close voiced fragments without a hard acoustic boundary are grouped as one editable word/phrase.
- superseded by the emergency repair: pitch move and scale correction affect explicitly selected notes only.
- note-HQ request building coalesces adjacent edited notes into edit islands; only island entry/exit get bridge ownership, while internal boundaries stay on the continuous pitch curve.
- backend commit ranges merge adjacent edited notes into island ownership and no longer average diagnostic pitch ratios with `sqrt(previous * current)`.

Decision:
- keep this as a product-model/signal-chain correction, not a new renderer experiment.
- product rule: word-like editing is the default; internal micro-note editing requires explicit manual split.
- corner detection remains useful as an analyzer hint, but not as a default edit seam.

Validation:
- native build and frontend build passed after the change.
- analyzer run `D:\test projects\os tests\runs\20260428_022002_word_group_analysis_pitchOrg_r2` passed with `destructiveCornerSplitCount=0` and min expected word-group overlap `0.928`.
- primary note-HQ runs:
  - `D:\test projects\os tests\runs\20260428_022028_word_group_island_plus4`
  - `D:\test projects\os tests\runs\20260428_022028_word_group_island_minus4`
- adjacent-fragment diagnostic `D:\test projects\os tests\runs\20260428_023520_word_group_two_adjacent_plus4_r4` confirmed one raw note-HQ edit island for two edited fragments (`noteHqEditIslandCount=1`, `noteHqEditedNoteCount=2`).

### 2026-04-27: Segmentation-Corner And Voiced-Core Timbre Correction

Purpose:
- address the remaining stutter as a possible wrong-boundary problem, not only a compositor problem.
- reduce downshift formant drift with an envelope transfer tied to the original voiced vowel core.

Implementation:
- note segmentation now detects conservative pitch-curve corners from the smoothed MIDI contour.
- a corner split requires supporting vocal evidence: energy dip, confidence dip, nearby unvoiced/noise, or strong pitch prominence.
- vibrato-like periodic reversals are suppressed so normal sustained vibrato does not become many small notes.
- analyzed notes now expose `entryBoundaryKind`, `exitBoundaryKind`, reason, and score.
- note-HQ uses those boundary kinds when choosing bridge ownership: hard word-like boundaries get shorter audible bridges, while soft legato boundaries may use wider phrase smoothing.
- downward pitch-only note-HQ now applies voiced-core spectral envelope transfer on edited note bodies after the native directional renderer.

Decision:
- keep this as a signal-chain and segmentation correction, not a new renderer-family experiment.
- product rule: previous/next word bodies stay dry across hard boundaries; continuous sustain/legato may share transition smoothing, but neighboring note bodies are not fully retuned.
- acceptance remains the primary `pitchOrg +4/-4` note-HQ gates plus the richer formant/transient/boundary suites.

Measured runs:
- `pitchOrg +4`: `D:\test projects\os tests\runs\20260428_013135_seg_corner_timbre_plus4`
  - body/core pitch error `0.00 / 0.00 cents`
  - entry lag `-0.125 ms`, onset artifact `1.479`, onset derivative `1.087`
  - protected pre-bridge residual `-172.823 dB`
  - exit-next artifact `2.307`
  - harmonic drift `0.379`
- first `pitchOrg -4` aggressive envelope-transfer attempt: `D:\test projects\os tests\runs\20260428_013344_seg_corner_timbre_minus4`
  - rejected because harmonic drift regressed to `0.615 > 0.360`.
  - lesson: envelope transfer must be a bounded support-weighted correction, not a replacement of the native downshift body.
- final `pitchOrg -4`: `D:\test projects\os tests\runs\20260428_013650_seg_corner_timbre_minus4_mix005`
  - body/core pitch error `0.00 / +11.90 cents`
  - `spectralEnvelopeCorrectionUsed=true`
  - entry lag `+0.771 ms`, onset artifact `1.598`, onset derivative `1.598`
  - protected pre-bridge residual `-240.000 dB`
  - exit-next artifact `0.091`
  - harmonic drift `0.343`, low/mid/high deltas `-1.083 / -2.067 / -0.053 dB`
- analyzer diagnostic run: `D:\test projects\os tests\runs\20260428_013900_seg_corner_boundary_analysis`
  - detected `11` notes over the 4 s `pitchOrg` clip, with `2` corner-boundary notes reported.
  - boundary kind counts were `hard_word_like=22`, confirming diagnostics are serialized; further product tuning should use manual vocal-boundary references before making corner splits more aggressive.

### 2026-04-27: Entry Bridge Fix For Final Note-HQ Apply

Purpose:
- fix the remaining edited-note entry stutter without moving the artifact back into the previous word.
- keep phrase/effective render context, but make audible entry ownership bridge-aware rather than forcing either a hard dry edge or a broad wet left shoulder.

Implementation:
- final note-HQ compositing now chooses a direction-aware entry bridge.
- upward edits use a tight in-body bridge because the pre-note bridge regressed the upward onset metrics.
- downward edits may start audible bridge ownership up to `24 ms` before `note.startTime`; on the canonical case the bridge starts at `0.876009s`, then lands back on body timing by the end of the entry window.
- downshift bridge applies a local wet-read delay (`-21.995 ms` on `pitchOrg -4`), a bounded envelope correction (`+1.7 dB`), and a short dry transient preservation window (`10 ms`).
- diagnostics now include `noteHqEntryBridgeStartSec`, `noteHqEntryBridgeEndSec`, `noteHqEntryBridgeWetLagMs`, `noteHqEntryBridgeEnvelopeGainDb`, `noteHqEntryBridgeUsed`, and `noteHqEntryTransientDryPreservedMs`.
- the harness now protects only the pre-bridge tail, not the whole pre-body region, and writes entry-bridge audition WAVs.

Measured runs:
- `pitchOrg +4`: `tmp_pitch_runs/20260428_004839_entry_bridge_v15_plus4`
  - body/core pitch error `0.00 / 0.00 cents`
  - entry bridge `0.900000s -> 0.916009s`, lag `0.0 ms`, gain `0.0 dB`
  - entry lag `-0.125 ms`
  - onset artifact `1.479`, onset derivative `1.087`
  - protected pre-bridge residual `-172.823 dB`
  - exit-next artifact `2.307`
  - harmonic drift `0.379`
- `pitchOrg -4`: `tmp_pitch_runs/20260428_004708_entry_bridge_v15_minus4`
  - body/core pitch error `0.00 / +11.90 cents`
  - entry bridge `0.876009s -> 0.980000s`, lag `-21.995 ms`, gain `+1.7 dB`
  - entry lag `+0.771 ms`
  - onset artifact `1.598`, onset derivative `1.598`
  - protected pre-bridge residual `-240.000 dB`
  - exit-next artifact `0.091`
  - harmonic drift `0.344`
- export parity:
  - `tmp_pitch_runs/20260428_005155_entry_bridge_v15_plus4_export`
  - `tmp_pitch_runs/20260428_005458_entry_bridge_v15_minus4_export`
  - source-vs-export dry-tail residual is still informational because the mixer/export path is full-file, but preview/export body pitch and note-HQ product parity passed.

Decision:
- keep this as a signal-chain/compositor correctness fix, not a reopened renderer-family experiment.
- product rule: final apply may use a tiny bounded pre-note bridge for best sound, but anything before `noteHqEntryBridgeStartSec` must remain original/dry.
- expected perceived match after this pass: about `91-94%` for `+4` and `89-92%` for `-4` versus the provided samples on this fixture.

### 2026-04-27: Final Pre-Body Dry Ownership Fix For Note-HQ Apply

Purpose:
- fix the remaining previous-word stutter without regressing the edited-note exit/next-note handoff.
- separate renderer context from audible commit ownership.

Root cause:
- the renderer needs left-shoulder context for phase/envelope history, but committing that left shoulder as wet audio moved the stitching artifact backward into the previous word.
- the existing `preCommitArtifactScore` could miss this because it looked at a narrow boundary point rather than auditing the whole previous-word tail.

Implementation:
- note-HQ still renders with phrase/effective context.
- final dry-protected compositing now starts audible wet ownership at `note.startTime`, not `effectiveStartTime`.
- `[effectiveStartTime, note.startTime)` remains original/dry.
- entry blends dry-to-wet inside the edited note body over `12 ms`.
- exit keeps the previous fix: wet-to-dry starts at `note.endTime - 12 ms` and releases through `effectiveEndTime`.
- diagnostics now include context range, audible commit range, pre-body dry-protected samples, entry fade ms, and exit lead-in ms.
- the harness now has a full pre-body ownership audit:
  - `preBodyTailOriginalResidualDb` over `[noteStart - 80 ms, noteStart)`.
  - `candidateActiveDifferenceStartSec`.
  - `preBodyTailArtifactScore`.
  - audition WAVs: `orig_pre_body_tail.wav`, `cand_pre_body_tail.wav`, `diff_pre_body_tail.wav`.
- the ownership audit uses `noteHqAudibleCommitStartSec`, not analysis-only body/core windows.

Measured runs:
- `pitchOrg +4`: `tmp_pitch_runs/20260427_213815_pre_body_dry_v3_plus4`
  - body/core pitch error `0.00 / 0.00 cents`
  - pre-body residual `-170.878 dB`
  - active difference start `0.900063s`
  - onset artifact `1.706`
  - exit-next artifact `2.307`
  - harmonic drift `0.379`
- `pitchOrg -4`: `tmp_pitch_runs/20260427_213940_pre_body_dry_v3_minus4`
  - body/core pitch error `0.00 / +11.90 cents`
  - pre-body residual `-169.515 dB`
  - active difference start `0.900063s`
  - onset artifact `2.721`
  - exit-next artifact `0.091`
  - harmonic drift `0.352`
- export parity:
  - `tmp_pitch_runs/20260427_214538_pre_body_dry_v4_plus4_export`
  - `tmp_pitch_runs/20260427_214814_pre_body_dry_v4_minus4_export`
  - note: source-vs-export dry residual is informational only because the mixer/export path changes the full file from time zero; export parity is judged against the note-HQ product.
- richer formant suite:
  - `tmp_pitch_runs/pre_body_dry_v2_formant_richer/20260427_212751_pre_body_dry_v2_formant_richer`
- richer transient suite:
  - `tmp_pitch_runs/pre_body_dry_v4_transient_richer/20260427_215055_pre_body_dry_v4_transient_richer`
- boundary suite:
  - `tmp_pitch_runs/pre_body_dry_v2_boundary/20260427_212152_pre_body_dry_v2_boundary`
  - primary real `pitchOrg` cases stay under the exit-next gate; the synthetic shortened-end stress case still warns with a high exit-next artifact.

Decision:
- keep this as a signal-chain/compositor correctness fix, not a renderer-family experiment.
- product rule: render context may extend before the edited note, but final committed audio before `note.startTime` must remain original/dry.
- expected perceived match after this pass: about `89-92%` for `+4` and `87-90%` for `-4` versus the provided samples, with the remaining gap mostly from timbre/body-envelope match rather than word-break stitching.

### 2026-04-27: Pitch-Only Signal-Chain Fix, Note-HQ Slicing Fix, And Transition-Shoulder Commit

Purpose:
- fix the reported pitch-note change failures as signal-chain bugs:
  - timbre getting thinner/fatter when pitch moves
  - stutter/word-break just before or after the edited note
- stop accepting low-confidence note-HQ fallback silently
- make the regression harness catch formant/spectrogram drift on the real candidate slice

Root causes found:
- several `SignalsmithShifter::process(...)` pitch-only callsites passed `detectedPitchHz` as the sixth argument, which is actually `formantRatios`; that could turn F0 Hz values into huge unintended formant factors.
- `note_hq` regression slicing treated every candidate like a window-local render, even when the app wrote a full-clip/phrase result; this let formant and boundary metrics inspect the wrong slice.
- note-HQ apply request construction dropped the note's own transition shoulders when there was no immediate neighbor, so the dry patch still committed only the body and could hard-switch at word edges.

Implementation:
- added explicit `SignalsmithShifter` pitch-only entrypoints:
  - `processPitchOnlyBase(..., ratios, detectedPitchHz)`
  - `processPitchOnlyCe33Base(..., ratios)`
- routed pitch-only detected-F0 renders through `process(..., ratios, {}, detectedPitchHz)`, keeping explicit formant rendering on the non-empty `formantRatios` path only.
- changed note-HQ pitch-only final render to require phrase/full-context offline HQ unless `OPENSTUDIO_PITCH_ALLOW_NOTE_HQ_NATIVE_FALLBACK=1` is set.
- expanded note-HQ commit ownership to include effective transition shoulders; for the canonical `0.900s-1.550s` body the final diagnostic runs commit `0.860s-1.610s`.
- added preview segment entry/exit crossfade to avoid hard-switching cached chunks against the source clip.
- fixed the formant proxy peak scorer to order selected broad peaks by frequency before treating them as F1/F2 proxies.

Measured runs:
- production HQ-required check:
  - `20260427_135602_after_fix_pitchOrg_plus4_hq_required_missing_runtime`
  - expected failure in this checkout: bundled Rubber Band executable exits with Windows status `0xC0000135` because dependent runtime DLLs are missing.
  - result is now a hard failure, not a silent native fallback.
- follow-up runtime fix:
  - added `tools/rubberband/sndfile.dll` from the bundled Python `libsndfile_x64.dll`, plus the matching VC runtime DLLs.
  - `rubberband.exe --version` and `rubberband-r3.exe --version` now report `4.0.0`.
  - app-path result `20260427_145800_rubberband_runtime_fixed_pitchOrg_plus4` used `rubberband_hq_phrase_hq` with `phraseHqExternalUsed=true` and `pitchRenderBackendVersion=4.0.0`.
  - quality status is still not promoted: `20260427_145847_rubberband_runtime_fixed_pitchOrg_plus4` failed the strict formant gate at mid-band delta `+7.866 dB > 7.000 dB` and boundary timing `38.54 ms`.
- final debug-native `pitchOrg +4`:
  - run: `20260427_135220_after_fix_pitchOrg_plus4_native_override_final`
  - body/core pitch error: `0.00 / 0.00 cents`
  - note mel/env: `6.804 dB / 1.258`
  - formant body harmonic drift: `0.378`
  - low/mid/high deltas: `-2.46 / +0.53 / -3.59 dB`
  - core F1/F2 proxy drift: `-46.9 / +23.4 Hz`
  - boundary timing error: `8.42 ms`
  - onset artifact score: `1.77`
  - spectrogram assets: `D:\test projects\os tests\runs\20260427_135220_after_fix_pitchOrg_plus4_native_override_final\spectrogram`
- final debug-native `pitchOrg -4`:
  - run: `20260427_135413_after_fix_pitchOrg_minus4_native_override_final`
  - body/core pitch error: `0.00 / +11.90 cents`
  - note mel/env: `6.557 dB / 1.086`
  - formant body harmonic drift: `0.469`
  - low/mid/high deltas: `-0.41 / +0.83 / +1.12 dB`
  - core F1/F2 proxy drift: `+46.9 / -70.3 Hz`
  - boundary timing error: `25.38 ms`
  - onset artifact score: `0.94`
  - spectrogram assets: `D:\test projects\os tests\runs\20260427_135413_after_fix_pitchOrg_minus4_native_override_final\spectrogram`
- richer suites:
  - formant richer suite passed all `6` cases: `20260427_135901_after_fix_formant_richer_native_override`
  - transient richer suite passed all `8` cases: `20260427_141431_after_fix_transient_richer_native_override`
  - export/preview parity passed for `pitchOrg +4`: `20260427_143420_after_fix_export_preview_parity_plus4_native_override`
- boundary suite:
  - run: `20260427_142907_after_fix_boundary_pitchOrg_plus4_native_override`
  - `start_earlier` and `start_later` passed.
  - synthetic `end_earlier` failed the new hard gate: boundary timing `38.938 ms > 32 ms`.
  - decision: keep this as a known strict stress failure, not a pass.

Decision:
- this is a correctness fix to the existing signal chain and harness, not a reopened renderer-family experiment.
- keep `pitch_only_adaptive_selector` as the native diagnostic fallback.
- production note-HQ needs the external HQ backend/runtime fixed before claiming final HQ parity.

### 2026-04-17: Root-Cause Research + ML Benchmark + Engine-v3 Feasibility

Purpose:
- stop doing blind renderer experiments
- turn the remaining two product issues into evidence-backed causes
- quickly decide whether local ML restoration or a clean-sheet `engine-v3` branch is actually credible

New tooling:
- `tools/pitch_root_cause_research.py`
- `tools/run-pitch-root-cause-research.ps1`
- `tools/run-pitch-ml-benchmark.ps1`
- `tools/pitch_engine_v3_feasibility.py`
- `tools/run-pitch-engine-v3-feasibility.ps1`

Primary outputs:
- root-cause:
  - `20260417_012542_pitch_root_cause_research`
  - summary doc:
    - `D:\test projects\os tests\runs\20260417_012542_pitch_root_cause_research\pitch_root_cause_research.md`
- ML benchmark:
  - `20260417_003355_pitch_ml_benchmark`
- engine-v3 feasibility:
  - `20260417_003355_engine_v3_feasibility`
- repo summary:
  - `docs/pitch_root_cause_research_20260417.md`

Root-cause verdicts:
- rank 1:
  - transition ownership and boundary timing drift
  - evidence:
    - hard-case adaptive boundary timing still peaks around `18.92 ms`
    - frozen engine-v2 still collapses at hard-case entry with entry mel `7.017`
- rank 2:
  - mixed transient and first-voiced-cycle content is still being handled by one renderer family
  - evidence:
    - hard-case transient entry/exit max stayed about `1.614 / 6.723`
    - engine-v2 still failed with transient bypass enabled
- rank 3:
  - current formant preservation is too weak and too local to survive hard transitions
  - evidence:
    - adaptive formant drift remained around `0.364` on `pitchOrg` and `0.071` on `pitchTest`
    - engine-v2 kept envelope correction on but still lost the hard case

ML benchmark verdict:
- result:
  - `blocked_no_stronger_restorer`
- environment:
  - runtime ready `true`
  - backend `cuda`
- candidate check:
  - `voicefixer`: not installed
  - `demucs`: not installed
  - `audio_separator`: available but not suitable for note-local restoration
  - `proxy_ml_restore_v1`: explicitly excluded and already rejected
- decision:
  - do not reopen local ML restoration on another proxy
  - only reopen once a materially stronger restorer is available

Engine-v3 feasibility verdict:
- decomposition probe results:
  - `pitchOrg_plus4`: score `0.511`, verdict `stop`
  - `pitchTest_plus4`: score `0.505`, verdict `stop`
- decision:
  - do not open a long `engine-v3` implementation branch from this probe
  - only revisit `engine-v3` after defining a materially stronger decomposition and transition-pair ownership model

Meaning for the program:
- current best renderer remains `pitch_only_adaptive_selector`
- engine-v2 remains frozen as comparison evidence only
- the unsolved product issues are now understood as architectural rather than just tuning leftovers
- next bounded action should be:
  - stronger external/licensed or materially stronger ML benchmark, or
  - a better pre-defined decomposition/transition design before any future `engine-v3`

### 2026-04-16: Richer Fixture Close-Out Progress, `H3/H4` Closed For Current Canonical Corpus

Purpose:
- stop leaving the remaining iteration budget tied to smoke-only fixture coverage
- close out richer transient and formant suites on the current canonical clip families
- tighten the scrub-suite truth so the only remaining mandatory gap is the real multi-note selection-change case

What changed:
- added richer manifests:
  - `tests/fixtures/pitch-regression/suites/transient_richer_suite.json`
  - `tests/fixtures/pitch-regression/suites/formant_richer_suite.json`
- extended the scrub-suite plumbing to request a selection-change scenario when available
- ran richer scrub suites on both canonical clip families:
  - `20260416_231821_pitchOrg_scrub_suite_richer_r1`
  - `20260416_234516_pitchTest_scrub_suite_richer_r1`
- ran richer regression suites:
  - transient: `20260416_231844_transient_suite_richer_r1`
  - formant: `20260416_233426_formant_suite_richer_r1`

Scrub-suite truth:
- first drag, repeated drag, and after-transport-cycle are all audible on both clip families
- representative scrub figures:
  - `pitchOrg`
    - start / stop latency about `26-28 ms`
    - repeat stability `0.4699`
    - last peak `0.1123`
  - `pitchTestOrg`
    - start / stop latency about `26-28 ms`
    - repeat stability `0.7770`
    - last peak `0.1313`
- verdict:
  - `H1` is still only partial
  - the suite now covers the major stopped-transport scrub scenarios
  - but true selection-change is still unproven because the current scrub fixtures resolve to one-note jobs, so the added scenario does not yet exercise a real second-note handoff

Transient richer-suite highlights:
- `pitchOrg +4` richer entry/exit runs:
  - note mel about `7.095`
  - onset artifact about `1.212`
  - formant drift about `0.367`
- `pitchTestOrg +4` richer entry/exit runs:
  - note mel about `4.915`
  - entry artifact about `1.58-1.61`
  - exit artifact about `6.36-6.72`
  - boundary timing error about `11.60-18.92 ms`
- `pitchTestOrg -4` richer entry/exit runs:
  - note mel about `5.743`
  - exit artifact about `7.90-8.41`
  - boundary timing error about `16.54-35.40 ms`
- verdict:
  - `H3` is now complete for the current canonical local fixture corpus
  - the suite confirms the remaining weakness is still boundary behavior, especially hard-case exits and downward guards

Formant richer-suite highlights:
- `pitchOrg +4` body / transition formant runs:
  - formant drift about `0.360-0.367`
  - entry / exit artifact still about `6.59-7.05`
- `pitchTestOrg +4` body / transition formant runs:
  - formant drift about `0.063-0.080`
  - entry artifact about `1.58-1.77`
  - exit artifact about `4.22-6.72`
- `pitchTestOrg -4` body formant run:
  - formant drift `0.0569`
  - note/body cents still off on the downward guard
- verdict:
  - `H4` is now complete for the current canonical local fixture corpus
  - the suite confirms formant drift is still materially worse on the easier `pitchOrg` family than on `pitchTestOrg`, while boundary artifacts still dominate the listening problem overall

Current plan truth:
- remaining mandatory iterations: `1`
- remaining conditional iterations: `+2`
- the one mandatory item still open is:
  - true multi-note `H1` scrub selection-change coverage

### 2026-04-16: `H1` Scrub Selection-Change Close-Out

Purpose:
- close the last remaining mandatory harness gap instead of leaving scrub selection-change as a half-wired scenario
- prove the app-path scrub job can exercise a real second-note handoff, not just repeat `first_drag`

What changed:
- fixed scrub note-array flattening in `tools/run-ui-pitch-scrub-regression.ps1`
- added multi-note scrub fixtures:
  - `tests/fixtures/pitch-regression/example_pitchOrg_scrub_multinote.json`
  - `tests/fixtures/pitch-regression/example_pitchTest_scrub_multinote.json`
- added scrub debug/result fields in the app-path regression flow so the selection-change scenario could be verified directly

Verification runs:
- direct debug run:
  - `20260416_235624_pitchTest_scrub_selection_debug_r1`
  - result:
    - `scrubPreviewSelectionChangeAudible=true`
    - scenario count `2`
    - scenario names:
      - `first_drag`
      - `selection_change`
- full multi-note scrub suite:
  - `20260416_235640_pitchTest_scrub_suite_multinote_r3`
  - result:
    - `first_drag`: audible `true`
    - `repeated_drag`: audible `true`
    - `after_transport_cycle`: audible `true`
    - `selection_change`: audible `true`
    - selection-change case reports:
      - `scrubPreviewSelectionChangeAudible=true`
      - start latency `27.2 ms`
      - stop latency `27.6 ms`
      - repeat stability `0.4174`
      - last peak `0.0991`

Verdict:
- `H1` is now complete for the current canonical local fixture corpus
- there are no mandatory harness-closeout iterations left
- the remaining work from here is no longer “unfinished implementation”; it is product-quality improvement work, plus the optional conditional phase-locking branch if we decide to open it

Current plan truth:
- remaining mandatory iterations: `0`
- remaining conditional iterations: `+2`

### 2026-04-16: Scrub Preview Natural-Segment Fix Landed, Boundary/Formant Work Still Pending

Purpose:
- fix the user-facing scrub-preview failure instead of treating the older infrastructure-only pass as complete
- make drag preview audible on first drag and stop the tiny-loop tearing behavior
- keep the boundary/formant work explicitly marked as still incomplete

What changed:
- scrub preview now serializes note/frame payloads across the native bridge for a more reliable native parse
- scrub extraction now prefers the clip's active audio source instead of the preserved original-file path
- scrub extraction now falls back to deriving note bounds from analyzed frames if note metadata arrives incomplete
- scrub preview now uses:
  - a longer natural note-local voiced segment
  - gain normalization
  - repeat-stability telemetry
  - preview armed / first-callback / first-drag-audible status flags

Fresh scrub regression:
- run: `20260416_200227_pitchOrg_scrub_preview_r8`
- result:
  - `scrubPreviewAudible=true`
  - `scrubPreviewFirstDragAudible=true`
  - start latency `26.9 ms`
  - stop latency `26.8 ms`
  - base pitch `365.17 Hz`
  - loop duration `240.0 ms`
  - last peak `0.1123`
  - repeat stability `0.4699`

Verdict:
- the scrub path is now materially closer to the intended product behavior and no longer falls back to the near-silent `40 ms / 55 Hz` path in the harness
- this closes the core `S1/S2` scrub implementation work and most of `S3`
- boundary tuning, formant tuning, the full boundary/transient/formant suites, and the full adaptive/engine-v2 tuning program are still not complete

### 2026-04-16: Dedicated RAM Scrub Voice Implemented, First Full Engine-V2 Audio Pass Active

Purpose:
- finish the remaining implementation work that the 2-tier pitch-editor program still needed
- replace the old “interactive preview piggyback” assumption with a true RAM scrub monitor path
- move `engine-v2` from diagnostics/scaffold territory into a real benchmarkable audio renderer

What was implemented:
- dedicated scrub-preview pipeline
  - native bridge entrypoints:
    - `startPitchScrubPreview`
    - `updatePitchScrubPreview`
    - `stopPitchScrubPreview`
  - scrub loops are extracted from the stable interior of the selected note, not the onset
  - loops live entirely in RAM and are mixed directly by `PlaybackEngine`
  - stereo clips are supported by deriving loop bounds from mono analysis and extracting matching multichannel audio
- first real full `engine-v2` audio pass:
  - Signalsmith-based voiced-core render in the transition window
  - cepstral envelope restoration on voiced-support frames
  - spectral-flatness transient/unvoiced bypass mask
  - residual carry reinjection from shared own-engine analysis
  - transition compositor layered on top of the frozen adaptive selector output

Primary truth-case results:
- `pitchOrg +4`
  - adaptive benchmark:
    - run: `20260416_115127_pitchOrg_plus4_note_hq_adaptive_r2`
    - note mel `7.085`
    - env `1.376`
    - entry `7.078`
    - exit `7.027`
    - onset artifact `1.80`
  - engine-v2 full audio:
    - run: `20260416_124252_pitchOrg_plus4_note_hq_engine_v2_program_impl_r2`
    - note mel `9.653`
    - env `1.782`
    - entry `10.430`
    - exit `11.219`
    - onset artifact `3.23`
    - note/body/core cents `-18.72 / -18.72 / -37.23`
    - `spectralEnvelopeCorrectionUsed=true`
    - `engineV2Used=true`
  - verdict:
    - the new renderer is real, but it is still not keepable; it is pulling the easy truth case too far away from the adaptive benchmark
- `pitchTestOrg +4`
  - adaptive benchmark:
    - run: `20260416_115302_pitchTestOrg_plus4_note_hq_adaptive_r2`
    - note mel `2.810`
    - env `0.470`
    - entry `1.530`
    - exit `1.632`
    - onset artifact `0.70`
  - engine-v2 full audio:
    - run: `20260416_124622_pitchTestOrg_plus4_note_hq_engine_v2_program_impl_r3`
    - note mel `11.303`
    - env `1.425`
    - entry `8.389`
    - exit `10.274`
    - onset artifact `0.85`
    - note/body/core cents `-17.94 / -17.94 / -36.45`
    - `spectralEnvelopeCorrectionUsed=true`
    - `engineV2Used=true`
  - verdict:
    - the hard truth case is still much worse than the frozen adaptive benchmark

Decision:
- keep all code in place
- mark the family `Active Test / User Pending`
- do not remove the new scrub voice or engine-v2 code
- next tuning step must narrow engine-v2 engagement around the transition nucleus instead of letting it own such a wide region

### 2026-04-16: Engine-V2 Transition-Nucleus Tightening

Purpose:
- reduce the catastrophic full-note drift from the first engine-v2 audio pass
- keep the adaptive selector as the dominant carrier
- let engine-v2 touch only the onset-transition nucleus for upward note changes

What changed:
- transition ownership moved from the wider island/body window to a much tighter note-entry window
- engine-v2 now adds deltas on top of the adaptive baseline instead of composing a broader replacement mix
- voiced-core wet level and residual carry were reduced
- transient preservation was made more dominant at the entry edge

Primary truth-case results:
- `pitchOrg +4`
  - run: `20260416_125615_pitchOrg_plus4_note_hq_engine_v2_program_impl_r4`
  - result:
    - note mel `7.323`
    - env `1.419`
    - entry mel `7.918`
    - exit mel `7.027`
    - onset artifact `1.66`
    - note/body/core cents `0.00 / 0.00 / 0.00`
  - verdict:
    - much safer than the first full engine-v2 pass and exact on whole-note/body pitch, but still worse than adaptive overall because entry quality drifted and note/env did not improve enough
- `pitchTestOrg +4`
  - run: `20260416_125615_pitchTestOrg_plus4_note_hq_engine_v2_program_impl_r4`
  - result:
    - note mel `3.250`
    - env `0.536`
    - entry mel `4.277`
    - exit mel `1.632`
    - onset artifact `1.95`
    - note/body/core cents `0.00 / 0.00 / -18.32`
  - verdict:
    - far better than the original catastrophic engine-v2 attempt, but still clearly worse than the adaptive selector on the hard truth case

Follow-up tuning:
- `r5` tightened wet ownership even further:
  - `20260416_125930_pitchOrg_plus4_note_hq_engine_v2_program_impl_r5`
  - `20260416_125930_pitchTestOrg_plus4_note_hq_engine_v2_program_impl_r5`
- result:
  - metrics stayed effectively the same as `r4`
  - this indicates the current engine-v2 topology is now failing in a stable way rather than exploding numerically

Additional tightening:
- `r6` protected the first voiced cycles longer and pushed engine-v2 takeover deeper into the entry:
  - `20260416_131617_pitchOrg_plus4_note_hq_engine_v2_program_impl_r6`
  - `20260416_131617_pitchTestOrg_plus4_note_hq_engine_v2_program_impl_r6`
- result:
  - `pitchOrg +4`
    - note mel `7.313`
    - env `1.365`
    - entry mel `8.121`
    - onset artifact `1.48`
    - exact note/body/core cents `0 / 0 / 0`
  - `pitchTestOrg +4`
    - note mel `3.429`
    - env `0.508`
    - entry mel `5.278`
    - onset artifact `3.81`
    - note/body cents exact but core still `-18.32`
- verdict:
  - the easy truth case became somewhat safer and preserved pitch/body exactly
  - the hard truth case still loses badly on note-entry quality, so this compositor family is now plateauing as a waveform-correction overlay

Current interpretation:
- implementation is complete enough to audition:
  - dedicated RAM scrub preview exists
  - engine-v2 voiced-core + cepstral envelope + transient bypass + residual carry exists
- the main audible issues are still not solved
- the remaining problem is now narrower:
  - engine-v2 is no longer catastrophically unstable
  - but its current transition compositor still makes the hard note entry worse than the adaptive selector
  - the next meaningful move is likely a different engine-v2 role, such as using engine-v2 primarily as a formant/timbre correction layer on top of the adaptive carrier instead of as a waveform-correction overlay

### 2026-04-16: `FAM-ENGINE-V2` `V2-1` Scaffold Started

Purpose:
- begin the engine-v2 fallback program without risking the current best editor
- make the new branch fail-closed to `pitch_only_adaptive_selector`
- prove we can extract transition-native support signals before changing audible output

What was implemented:
- new safe benchmark branch:
  - `pitch_only_engine_v2_program`
- new engine-v2 diagnostics flowing through the native/app regression path:
  - `engineV2Used`
  - `engineV2FallbackUsed`
  - `engineV2TransitionCount`
  - `engineV2TransitionStartSec`
  - `engineV2TransitionEndSec`
  - `engineV2HarmonicSupportPeak`
  - `engineV2ResidualSupportPeak`
  - `engineV2EnvelopeSupportPeak`
- current `V2-1` behavior:
  - render exactly the frozen adaptive-selector output
  - compute transition/harmonic/residual/envelope scaffold diagnostics from `OwnPitchEngine` shared analysis
  - report those diagnostics through the regression summaries

Primary smoke runs:
- `pitchOrg +4`
  - run: `20260416_104358_v2_scaffold_pitchOrg_plus4_smoke_r4`
  - result:
    - requested/actual branch: `pitch_only_engine_v2_program / pitch_only_engine_v2_program`
    - output SHA: `F4BFBE23347CA853EEDE27E48E70F24DC5983AABE37498D02CD8F6D518B3EC72`
    - `engineV2Used=true`
    - transition count: `1`
    - transition window: `0.090–0.830s`
    - support peaks: harmonic `0.982`, residual `0.075`, envelope `2.379`
  - verdict:
    - safe and bit-identical to the frozen adaptive benchmark, with real scaffold engagement
- `pitchTestOrg +4`
  - run: `20260416_104610_v2_scaffold_pitchTestOrg_plus4_smoke_r1`
  - result:
    - requested/actual branch: `pitch_only_engine_v2_program / pitch_only_engine_v2_program`
    - output SHA: `1164BB74D7FC7EC87B163790DAF763E94B1B79812B7BE36F3FCD97966CFA740A`
    - `engineV2Used=true`
    - transition count: `1`
    - transition window: `0.090–1.260s`
    - support peaks: harmonic `0.982`, residual `0.075`, envelope `2.192`
  - verdict:
    - safe and bit-identical to the frozen adaptive benchmark on the harder truth case too

Program state after `V2-1`:
- engine-v2 is now an active family rather than a placeholder
- the scaffold is fail-closed, measurable, and safe on both main `+4` truth clips
- this does not solve the stutter/formant problem yet; it just gives us a trustworthy base for `V2-2`

### 2026-04-16: `FAM-ENGINE-V2` First `V2-2` Core-Blend Attempt Rejected

Purpose:
- take one conservative audible step beyond the scaffold
- keep the engine-v2 branch on the same diagnostics/transition windows
- test whether a light own-engine voiced-core bleed-in could help without destabilizing the frozen adaptive output

What was tried:
- a conservative stable-core blend on top of `pitch_only_engine_v2_program`
- the blend only allowed own-engine output into the analyzed voiced support region
- the rest of the branch still followed the adaptive-selector output

Primary truth-case result:
- `pitchOrg +4`
  - run: `20260416_105142_v2_2_pitchOrg_plus4_g1`
  - result:
    - note mel `7.085 -> 7.175`
    - env `1.376 -> 1.421`
    - entry mel `7.078 -> 7.321`
    - exit mel `7.027 -> 7.418`
    - onset artifact `1.80 -> 1.75`
  - verdict:
    - not keepable; the note, entry, and exit all drifted the wrong way for only a tiny onset gain
- `pitchTestOrg +4`
  - run: `20260416_105142_v2_2_pitchTestOrg_plus4_g1`
  - result:
    - note mel `6.292 -> 8.192`
    - env `1.130 -> 1.236`
    - entry mel `1.530 -> 9.507`
    - exit mel `1.632 -> 2.027`
    - note cents `-125.96 -> -141.08`
    - onset artifact `0.70 -> 1.13`
  - verdict:
    - clearly worse on the harder truth case

Decision:
- rejected immediately under the stop-fast rule
- restored `pitch_only_engine_v2_program` to the safe `V2-1` scaffold after the trial

Parity restore check after rollback:
- `pitchOrg +4`
  - run: `20260416_110003_v2_scaffold_pitchOrg_plus4_parity_check_r6`
  - result:
    - SHA back to `F4BFBE23347CA853EEDE27E48E70F24DC5983AABE37498D02CD8F6D518B3EC72`
    - still `engineV2Used=true` with transition/support diagnostics intact
- `pitchTestOrg +4`
  - run: `20260416_110152_v2_scaffold_pitchTestOrg_plus4_parity_check_r2`
  - result:
    - SHA back to `1164BB74D7FC7EC87B163790DAF763E94B1B79812B7BE36F3FCD97966CFA740A`
    - still `engineV2Used=true` with transition/support diagnostics intact

Current engine-v2 state:
- scaffold remains active and safe
- first audible `V2-2` attempt is rejected
- the next `V2-2` candidate must be structurally different from a simple stable-core blend

### 2026-04-15: Remaining Research Close-Out

Purpose:
- close the remaining credible families cleanly instead of leaving half-open work items in the queue
- freeze the current best editor on measured evidence
- decide whether the next move is another local family or the engine-v2 fallback

What was implemented:
- added an analysis-only regression harness:
  - [run-ui-pitch-analysis-regression.ps1](c:/Users/srvds/Documents/Codes/Studio13-v3/tools/run-ui-pitch-analysis-regression.ps1)
  - shared job-driver support in [pitchRegressionDriver.ts](c:/Users/srvds/Documents/Codes/Studio13-v3/frontend/src/utils/pitchRegressionDriver.ts)
- used that harness to close out `FAM-ANALYZER-PYIN`
- reran the four canonical truth cases on `pitch_only_adaptive_selector` to freeze it as the benchmark branch
- checked the repo for a stronger ML restorer than `ml_restore_proxy_v1`
- checked the remaining PV status against the actual local implementation inventory

Analyzer close-out:
- `A1` direct-YIN + decoder on `pitchOrg`
  - run: `20260415_210932_A1_pitchOrg_direct`
  - result:
    - notes detected / expected: `7 / 1`
    - voiced frame ratio: `0.802`
    - median voiced confidence: `0.974`
    - matched expected note window: yes
    - overlap ratio: `0.964`
- `A1` direct-YIN + decoder on `pitchTestOrg`
  - run: `20260415_210932_A1_pitchTestOrg_direct`
  - result:
    - notes detected / expected: `6 / 1`
    - voiced frame ratio: `0.676`
    - median voiced confidence: `0.976`
    - matched expected note window: yes
    - overlap ratio: `0.796`
- `A2` FFT-YIN parity decision
  - runs:
    - `20260415_210932_A2_pitchOrg_fft`
    - `20260415_210932_A2_pitchTestOrg_fft`
  - result:
    - `0` detected notes on both fixtures
    - voiced frame ratio `0.000` on both fixtures
  - verdict:
    - direct-YIN + decoder is frozen as the kept analyzer path
    - FFT-YIN is formally rejected-for-now and remains gated off

Broader adaptive-selector validation:
- runs:
  - `20260415_211004_closeout_pitchOrg_plus4_adaptive`
  - `20260415_211004_closeout_pitchOrg_minus4_adaptive`
  - `20260415_211004_closeout_pitchTestOrg_plus4_adaptive`
  - `20260415_211004_closeout_pitchTestOrg_minus4_adaptive`
- result:
  - `pitchOrg +4`
    - note mel `7.085`
    - env `1.376`
    - entry `7.078`
    - exit `7.027`
    - onset artifact `1.80`
  - `pitchOrg -4`
    - note mel `6.623`
    - env `1.102`
    - entry `6.585`
    - exit `7.475`
    - onset artifact `2.80`
  - `pitchTestOrg +4`
    - note mel `2.810`
    - env `0.470`
    - entry `1.530`
    - exit `1.632`
    - onset artifact `0.70`
  - `pitchTestOrg -4`
    - note mel `3.505`
    - env `1.024`
    - entry `3.090`
    - exit `1.835`
    - onset artifact `3.64`
- verdict:
  - `pitch_only_adaptive_selector` is now frozen as the benchmark branch for any future engine-v2 work

Remaining-family close-out decision:
- `FAM-ML-RESTORATION`
  - no materially stronger trained restorer exists locally beyond `ml_restore_proxy_v1`
  - family is deferred behind engine-v2
- `FAM-PVDR`
  - no materially different stable implementation is ready locally beyond the rejected resample-plus-phase-lock attempt
  - family stays closed unless a genuinely different design is prepared

Program conclusion:
- remaining close-out work is complete
- the current product issues are still unresolved:
  - stutter on note changes
  - formant/timbre change on note changes
- the next serious step is no longer another local family patch
- the next serious step is the `FAM-ENGINE-V2` fallback program

### 2026-04-15: `FAM-TRANSITION-HQ` Stop-Fast Verdict

Purpose:
- try a proper note-change-specific HQ renderer instead of another full-note shell swap
- keep `pitch_only_adaptive_selector` frozen as the live working editor
- benchmark a transition-only shell/core/residual overlay on top of the adaptive output before even considering an ML finish

What was implemented for the trial:
- temporary branch key:
  - `pitch_only_transition_hq`
- temporary HQ-only transition overlay on top of `pitch_only_adaptive_selector`:
  - preserve original shell content near the note-change edge
  - blend in own-engine voiced core support only through the transition window
  - reinject a small residual carry inside the transition core
  - apply simple local envelope correction between adaptive and own-engine outputs
- reusable diagnostics were added to the regression/native result flow:
  - `transitionHqUsed`
  - `transitionHqFallbackUsed`
  - `transitionStartSec`
  - `transitionEndSec`
  - `transitionTransientPeak`
  - `transitionVoicedCorePeak`
  - `transitionResidualPeak`
  - `transitionEnvelopeCorrectionUsed`

Truth-case results versus the current adaptive selector:
- `pitchOrg +4`
  - adaptive control run: `20260415_185731_pitchOrg_plus4_adaptive_transition_cmp`
  - transition HQ run: `20260415_185258_pitchOrg_plus4_transition_hq_m1`
  - result:
    - note mel `7.085 -> 7.395`
    - env `1.376 -> 1.434`
    - entry mel `7.078 -> 7.723`
    - exit mel `7.027 -> 7.027`
    - onset artifact `1.80 -> 1.59`
    - note/body/core cents stayed exact at `0 / 0 / 0`
    - `transitionHqUsed=true`
    - transition peaks `0.829 / 0.840 / 0.073`
  - verdict on this case:
    - onset improved a little, but note, envelope, and entry all got worse
- `pitchTestOrg +4`
  - adaptive control run: `20260415_185942_pitchTestOrg_plus4_adaptive_transition_cmp`
  - transition HQ run: `20260415_185446_pitchTestOrg_plus4_transition_hq_m1`
  - result:
    - note mel `2.810 -> 4.084`
    - env `0.470 -> 0.772`
    - entry mel `1.530 -> 15.735`
    - exit mel `1.632 -> 1.632`
    - onset artifact `0.70 -> 3.73`
    - core cents stayed `-18.32`, matching the underlying hard-case pitch issue
    - `transitionHqUsed=true`
    - transition peaks `0.574 / 0.840 / 0.073`
  - verdict on this case:
    - the overlay made the hard truth case dramatically worse

Verdict:
- rejected after the first DSP iteration
- it failed the keep gate decisively:
  - one case only improved the onset score while harming note/body entry quality
  - the other primary case regressed heavily on note mel, envelope, entry, and onset artifact
  - there was no justification to open the optional ML-finish stage

Cleanup:
- removed the temporary `pitch_only_transition_hq` branch support from the renderer and harness after the verdict
- kept the transition diagnostics plumbing in place for future benchmark reporting if a materially different engine-v2 path needs similar measurements
- the live editor remains `pitch_only_adaptive_selector`

### 2026-04-15: Research Synthesis Before The Next Renderer Family

Purpose:
- stop guessing between "modern sounding" ideas and actually research the remaining families that are still credible
- separate what the repo already tried from what the literature still supports
- update the queue so the next work is evidence-backed instead of another near-duplicate shell variation

Primary-source takeaways:
- median-filter HPSS is a real and useful separation technique, but it is a decomposition step, not a complete vocal pitch-editor renderer
  - source: FitzGerald 2010 DAFx paper
- WSOLA is strong for local continuity and time-scale seams, but not a complete answer to vocal pitch/body/formant artifacts
  - source: Verhelst and Roelands 1993
- research-grade phase-vocoder work is still genuinely untried here
  - the repo only tried a lightweight boundary-alignment variant
  - sources: Laroche and Dolson 1999, and "Phase Vocoder Done Right" 2022
- DDSP is the strongest engine-v2 style research direction if we accept a larger redesign
  - source: DDSP 2020
- the shallow-diffusion singing restoration paper is the closest direct match to the repo’s real product problem
  - start from a usable pitch-shifted render
  - then restore natural singing quality while preserving melody and timing
  - source: Liu and Akama 2026
- WORLD remains useful as a support decomposition for envelope/aperiodicity features, not as the final renderer target
  - source: WORLD 2016

Decision from the literature pass:
- stop treating more seam-only or shell-only DSP tweaks as the highest-value next step
- keep the current best working editor (`pitch_only_adaptive_selector`) frozen as the live benchmark
- move the next queue to:
  - `FAM-PVDR`
  - `FAM-ML-RESTORATION`
  - broader validation on `FAM-ADAPTIVE-SELECTOR`

Repo note:
- the full research note and source list is now in [pitch_renderer_research_notes.md](c:/Users/srvds/Documents/Codes/Studio13-v3/docs/pitch_renderer_research_notes.md)

### 2026-04-15: `FAM-ML-RESTORATION` Proxy Benchmark Verdict

Purpose:
- execute the next research-backed direction without touching the live editor path
- keep `pitch_only_adaptive_selector` frozen as the base renderer
- test restoration-after-render as an offline benchmark, not a shipping path

What was implemented for the trial:
- new offline benchmark script: [ml_restore_benchmark.py](c:/Users/srvds/Documents/Codes/Studio13-v3/tools/ml_restore_benchmark.py)
- regression harness integration in [run-ui-pitch-regression.ps1](c:/Users/srvds/Documents/Codes/Studio13-v3/tools/run-ui-pitch-regression.ps1)
- benchmark-only diagnostics recorded through the existing summary flow:
  - `mlRestoreUsed`
  - `mlRestoreModelId`
  - `mlRestoreWindowSec`
  - `mlRestoreBaseBranch`
- first proxy model id:
  - `ml_restore_proxy_v1`
- `M1` proxy behavior:
  - render with `pitch_only_adaptive_selector`
  - restore only the note window offline
  - use pYIN-derived F0 conditioning from the original window
  - use original-window energy conditioning
  - apply transient-emphasis blending near note entry
  - apply harmonic spectral-envelope correction on the rendered candidate

Truth-case results versus the current adaptive selector:
- `pitchOrg +4`
  - adaptive control run: `20260415_142514_pitchOrg_plus4_adaptive_m1_cmp`
  - ML restore run: `20260415_141959_pitchOrg_plus4_ml_restore_m1`
  - result:
    - note mel `7.085 -> 6.736`
    - env `1.376 -> 1.291`
    - entry mel `7.078 -> 6.716`
    - exit mel `7.027 -> 6.629`
    - onset artifact `1.80 -> 1.77`
    - note/body/core cents stayed exact at `0 / 0 / 0`
  - verdict on this case:
    - promising on the easier upward truth case
- `pitchTestOrg +4`
  - adaptive control run: `20260415_142514_pitchTestOrg_plus4_adaptive_m1_cmp`
  - ML restore run: `20260415_142207_pitchTestOrg_plus4_ml_restore_m1`
  - result:
    - note mel `2.810 -> 3.004`
    - env `0.470 -> 0.463`
    - entry mel `1.530 -> 2.048`
    - exit mel `1.632 -> 1.957`
    - onset artifact `0.70 -> 1.06`
    - body/core cents stayed `0.00 / -18.32`, matching the base renderer's pitch behavior
  - verdict on this case:
    - materially worse on the harder truth case even though envelope RMSE moved slightly in the right direction

Verdict:
- rejected after `M1`
- it failed the equal-weight keep gate:
  - the proxy restorer improved `pitchOrg +4`
  - but it materially harmed `pitchTestOrg +4` on note mel, entry mel, exit mel, and onset artifact
  - there is no justification for `M2` on this proxy family

What we are keeping:
- the offline benchmark infrastructure stays in the repo
- the live editor remains frozen on `pitch_only_adaptive_selector`
- `FAM-ML-RESTORATION` should only reopen with:
  - a trained restorer
  - or a materially different restoration method than `ml_restore_proxy_v1`

### 2026-04-15: `FAM-PVDR` Stop-Fast Verdict

Purpose:
- execute the next DSP-first family after the ML benchmark stop
- keep `pitch_only_adaptive_selector` as the base editor behavior
- test a genuinely different long-note phase-vocoder overlay instead of the older lightweight boundary-alignment pass

What was implemented for the trial:
- temporary branch key:
  - `pitch_only_pvdr`
- temporary long-upward overlay on top of `pitch_only_adaptive_selector`:
  - resample the long upward note region
  - apply a custom phase-vocoder stretch back to original duration
  - use identity-style peak phase locking around detected spectral peaks
  - blend only into the stable long-upward core region
- reused existing phase-lock diagnostics:
  - `phaseLockUsed`
  - `phaseLockFallbackUsed`
  - `phaseAlignedEntry`
  - `phaseAlignedExit`
  - `phasePeakCount`

Truth-case results:
- `pitchOrg +4`
  - run: `20260415_181645_pitchOrg_plus4_pvdr_p1`
  - result:
    - byte-identical to the adaptive selector
    - SHA stayed `F4BFBE23347CA853EEDE27E48E70F24DC5983AABE37498D02CD8F6D518B3EC72`
    - `phaseLockUsed=false`
- `pitchTestOrg +4`
  - run: `20260415_181645_pitchTestOrg_plus4_pvdr_p1`
  - result:
    - note/body/core cents `-628.27 / -628.27 / -664.72`
    - onset artifact exploded to `+200512709616936000`
    - entry mel `337.641`
    - exit mel `324.358`
    - `phaseLockUsed=true`
    - `phaseAlignedEntry=true`
    - `phaseAlignedExit=true`
    - `phasePeakCount=14710`
  - verdict on this case:
    - catastrophic failure on the harder long-upward truth case

Verdict:
- rejected after `P1`
- stop-fast rule triggered immediately:
  - the easy `+4` case did not improve
  - the hard `+4` case failed catastrophically
  - there was no reason to run the `-4` guards

Cleanup:
- removed the temporary `pitch_only_pvdr` branch support from the renderer and harness
- kept the existing phase-lock diagnostics only
- the live editor remains `pitch_only_adaptive_selector`

### 2026-04-15: `FAM-WSOLA-SEAM` Stop-Fast Verdict

Purpose:
- try the first genuinely untried DSP-first family from the new queue
- keep the existing `pitch_only_adaptive_selector` routing intact and only replace seam handling at short-upward shoulders with a WSOLA-style similarity search
- compare directly against the current adaptive branch on all four canonical truth cases

What was implemented for the trial:
- temporary branch key: `pitch_only_wsola_seam`
- temporary WSOLA-style shoulder pass layered on top of the adaptive selector:
  - mono-sum similarity search
  - short-upward notes only
  - entry and exit shoulder realignment with a raised-cosine overlap
- reusable seam-search diagnostics added to the native/regression result flow:
  - `wsolaUsed`
  - `wsolaFallbackUsed`
  - `wsolaEntryLagSamples`
  - `wsolaExitLagSamples`
  - `wsolaCorrelationScore`

Truth-case results versus the current adaptive selector:
- `pitchOrg +4`
  - adaptive control run: `20260415_122753_pitchOrg_plus4_adaptive_cmp`
  - WSOLA run: `20260415_121916_pitchOrg_plus4_wsola_w1`
  - WSOLA engaged:
    - `wsolaUsed=true`
    - entry/exit lag `326 / -349` samples
    - correlation `0.667`
  - result:
    - note mel `7.085 -> 7.102`
    - env `1.376 -> 1.377`
    - entry mel `7.078 -> 7.314`
    - exit mel `7.027 -> 7.151`
    - onset artifact `1.80 -> 2.29`
  - verdict on this case:
    - the only case that changed got worse across the seam-sensitive metrics we care about
- `pitchOrg -4`
  - adaptive control run: `20260415_122930_pitchOrg_minus4_adaptive_cmp`
  - WSOLA run: `20260415_122117_pitchOrg_minus4_wsola_w1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `6BDCD513FAE4F2267564769D722FCF1FC48E69D981E4493F4E5D2BBBFFD027A0`
- `pitchTestOrg +4`
  - adaptive control run: `20260415_123106_pitchTestOrg_plus4_adaptive_cmp`
  - WSOLA run: `20260415_122251_pitchTestOrg_plus4_wsola_w1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `1164BB74D7FC7EC87B163790DAF763E94B1B79812B7BE36F3FCD97966CFA740A`
- `pitchTestOrg -4`
  - adaptive control run: `20260415_123320_pitchTestOrg_minus4_adaptive_cmp`
  - WSOLA run: `20260415_122513_pitchTestOrg_minus4_wsola_w1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `9B3E951F0D60DB8828A1CA82AC162A7987EE3C7BA4CCAACCF187B5E75BBD7F37`

Verdict:
- rejected after `W1`
- it failed the stop-fast gate:
  - no primary truth case improved
  - the only engaged case (`pitchOrg +4`) regressed on note mel, entry, exit, and onset artifact
  - the other three canonical cases stayed exactly on the adaptive baseline

Cleanup:
- removed the temporary `pitch_only_wsola_seam` renderer branch support after the verdict
- kept the WSOLA/seam diagnostics in the regression/native result flow because they are reusable if a later seam-search family is tried in a meaningfully different form

### 2026-04-15: `FAM-PHASE-LOCK-PV` Stop-Fast Verdict

Purpose:
- try the next genuinely untried DSP-first family after the WSOLA stop-fast reject
- keep the existing `pitch_only_adaptive_selector` routing intact and only swap in a boundary-phase-aligned long-upward variant
- compare directly against the current adaptive branch on all four canonical truth cases

What was implemented for the trial:
- temporary branch key: `pitch_only_phase_lock_pv`
- temporary adaptive-selector variant for long upward notes:
  - same adaptive routing as the kept branch
  - mono-sum boundary lag search against the simple `ce33` output
  - boundary-aligned long-note replacement inside the long upward body span
- reusable phase-lock diagnostics added to the native/regression result flow:
  - `phaseLockUsed`
  - `phaseLockFallbackUsed`
  - `phaseAlignedEntry`
  - `phaseAlignedExit`
  - `phasePeakCount`

Truth-case results versus the current adaptive selector:
- `pitchOrg +4`
  - adaptive control run: `20260415_122753_pitchOrg_plus4_adaptive_cmp`
  - phase-lock run: `20260415_130513_pitchOrg_plus4_phase_lock_p1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `F4BFBE23347CA853EEDE27E48E70F24DC5983AABE37498D02CD8F6D518B3EC72`
    - `phaseLockUsed=false`
- `pitchOrg -4`
  - adaptive control run: `20260415_122930_pitchOrg_minus4_adaptive_cmp`
  - phase-lock run: `20260415_130647_pitchOrg_minus4_phase_lock_p1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `6BDCD513FAE4F2267564769D722FCF1FC48E69D981E4493F4E5D2BBBFFD027A0`
    - `phaseLockUsed=false`
- `pitchTestOrg +4`
  - adaptive control run: `20260415_123106_pitchTestOrg_plus4_adaptive_cmp`
  - phase-lock run: `20260415_130820_pitchTestOrg_plus4_phase_lock_p1`
  - phase-lock engaged:
    - `phaseLockUsed=true`
    - `phaseAlignedEntry=false`
    - `phaseAlignedExit=true`
    - `phasePeakCount=114`
  - result:
    - note mel `2.81 -> 3.003`
    - env `0.47 -> 0.479`
    - entry mel `1.53 -> 2.278`
    - exit mel `1.632 -> 1.940`
    - onset artifact `0.705 -> 0.66`
  - verdict on this case:
    - selective boundary alignment was real, but it still made the hard long-upward truth case worse where the keep gate matters
- `pitchTestOrg -4`
  - adaptive control run: `20260415_123320_pitchTestOrg_minus4_adaptive_cmp`
  - phase-lock run: `20260415_131038_pitchTestOrg_minus4_phase_lock_p1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `9B3E951F0D60DB8828A1CA82AC162A7987EE3C7BA4CCAACCF187B5E75BBD7F37`
    - `phaseLockUsed=false`

Verdict:
- rejected after `P1`
- it failed the stop-fast gate:
  - three canonical cases stayed exactly on the adaptive baseline
  - the only engaged case (`pitchTestOrg +4`) materially regressed on note mel and entry mel
  - the slight onset-artifact gain was not enough to offset the note/entry loss

Cleanup:
- removed the temporary `pitch_only_phase_lock_pv` renderer branch support after the verdict
- kept the phase-lock diagnostics in the regression/native result flow because they are reusable if a later, materially different phase-coherent family is tried

### 2026-04-15: `FAM-HPSS-MEDIAN` Stop-Fast Verdict

Purpose:
- retry HPSS in a genuinely different form from the rejected heuristic shell
- use a real STFT median-filter separation idea instead of the old voiced-mask proxy
- keep the current adaptive selector as the base render and only replace short-upward note regions with a median-shell recombine

What was implemented for the trial:
- temporary branch key: `pitch_only_hpss_median`
- temporary median-shell pass layered on top of the adaptive selector:
  - mono-sum STFT analysis
  - horizontal median across time and vertical median across frequency
  - scalar harmonic/transient weighting projected back to the time domain
  - original signal as the transient side, adaptive output as the harmonic side
  - short upward notes only
- reused HPSS diagnostics in the regression flow:
  - `hpssUsed`
  - `hpssFallbackUsed`
  - `harmonicMaskPeak`
  - `aperiodicMaskPeak`
  - `spectralEnvelopeCorrectionUsed`

Truth-case results versus the current adaptive selector:
- `pitchOrg +4`
  - adaptive control run: `20260415_122753_pitchOrg_plus4_adaptive_cmp`
  - median HPSS run: `20260415_132239_pitchOrg_plus4_hpss_median_hm1`
  - median HPSS engaged:
    - `hpssUsed=true`
    - harmonic/aperiodic peaks `0.868 / 0.554`
  - result:
    - note mel `7.085 -> 7.432`
    - env `1.376 -> 1.279`
    - entry mel `7.078 -> 7.445`
    - exit mel `7.027 -> 6.742`
    - onset artifact `1.80 -> 1.48`
    - note/body/core cents `0 / 0 / 0 -> -55.55 / -55.55 / -55.55`
  - verdict on this case:
    - the onset side improved again, but the body pitch and note quality collapsed, so this is not a keepable trade
- `pitchOrg -4`
  - adaptive control run: `20260415_122930_pitchOrg_minus4_adaptive_cmp`
  - median HPSS run: `20260415_132408_pitchOrg_minus4_hpss_median_hm1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `6BDCD513FAE4F2267564769D722FCF1FC48E69D981E4493F4E5D2BBBFFD027A0`
- `pitchTestOrg +4`
  - adaptive control run: `20260415_123106_pitchTestOrg_plus4_adaptive_cmp`
  - median HPSS run: `20260415_132536_pitchTestOrg_plus4_hpss_median_hm1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `1164BB74D7FC7EC87B163790DAF763E94B1B79812B7BE36F3FCD97966CFA740A`
- `pitchTestOrg -4`
  - adaptive control run: `20260415_123320_pitchTestOrg_minus4_adaptive_cmp`
  - median HPSS run: `20260415_132746_pitchTestOrg_minus4_hpss_median_hm1`
  - result:
    - byte-identical output to the adaptive selector
    - SHA stayed `9B3E951F0D60DB8828A1CA82AC162A7987EE3C7BA4CCAACCF187B5E75BBD7F37`

Verdict:
- rejected after `Hm1`
- it failed the stop-fast gate:
  - the only engaged case (`pitchOrg +4`) regressed on note mel, entry mel, and body pitch
  - the harder `pitchTestOrg +4` case still did not engage
  - there is no basis for opening `FAM-HPSS-MEDIAN-SF` on top of this shell

Cleanup:
- removed the temporary `pitch_only_hpss_median` renderer branch support after the verdict
- kept the HPSS diagnostics in the regression/native result flow because they remain reusable for any future materially different HPSS family

### 2026-04-15: `FAM-HPSS-SHELL` Stop-Fast Verdict

Purpose:
- test a genuinely new vertical split family instead of another onset/body handoff
- keep transient/noise content original and send only the harmonic body through a pitched layer
- compare directly against the kept adaptive selector on all four canonical truth cases

What was implemented for the trial:
- temporary branch key: `pitch_only_hpss_shell`
- temporary HPSS-style island composition on top of the current adaptive selector base:
  - original signal for transient/noise-dominant regions
  - pitched harmonic layer only in stable voiced regions
  - outer-island-only splices
- temporary HPSS diagnostics in the regression flow:
  - `hpssUsed`
  - `hpssFallbackUsed`
  - `harmonicMaskPeak`
  - `aperiodicMaskPeak`
  - `spectralEnvelopeCorrectionUsed`

Truth-case results:
- `pitchOrg +4`
  - run: `20260415_110453_pitchOrg_plus4_hpss_shell_h1`
  - HPSS engaged: `hpssUsed=true`
  - onset artifact improved `1.810 -> 1.390`
  - but note/body quality collapsed:
    - note mel `6.209 -> 10.066`
    - env `0.961 -> 2.028`
    - entry mel `6.928 -> 10.996`
    - exit mel `6.076 -> 15.137`
  - verdict on this case:
    - same old pattern again: onset-side gain, unacceptable body loss
- `pitchTestOrg +4`
  - run: `20260415_110628_pitchTestOrg_plus4_hpss_shell_h1`
  - HPSS never engaged:
    - `hpssUsed=false`
    - output stayed on the existing adaptive-selector result
    - SHA `1164BB74D7FC7EC87B163790DAF763E94B1B79812B7BE36F3FCD97966CFA740A`
- `pitchOrg -4`
  - run: `20260415_110628_pitchOrg_minus4_hpss_shell_h1`
  - note mel regressed to `6.623`
  - env `1.102`
  - core cents drifted to `+11.90`
- `pitchTestOrg -4`
  - run: `20260415_110628_pitchTestOrg_minus4_hpss_shell_h1`
  - note mel `3.505`
  - onset artifact `3.64`
  - not safe enough to justify continuing the family

Verdict:
- rejected after `H1`
- it failed the stop-fast gate:
  - the easy upward case improved only the onset metric while destroying note/body quality
  - the harder upward truth case did not engage at all
  - the `-4` guards did not stay clean enough

Cleanup:
- removed the temporary `pitch_only_hpss_shell` renderer branch support after the verdict
- kept the HPSS diagnostic fields in the regression/native result flow because they are reusable if a later, structurally different vertical-split family is tried

### 2026-04-15: `FAM-ANALYZER-PYIN` Implementation Start

Purpose:
- make the editor-side monophonic pitch analysis the top active family
- stop pretending we already have pYIN when the repo only had basic YIN-style trackers

What was already true before this change:
- `PitchAnalyzer` already existed as an offline monophonic editor analyzer
- `PitchDetector` already existed as a live YIN-style tracker
- neither path had:
  - true pYIN candidate generation
  - temporal decoding
  - FFT-accelerated YIN

What landed in this pass:
- `PitchAnalyzer` now uses:
  - Hann windowing
  - FFT-derived YIN difference calculation
  - CMNDF candidate extraction
  - per-frame voiced/unvoiced probability
  - lightweight Viterbi-style decoding across frames
- external editor-facing result shape stayed the same:
  - frame `frequency`
  - frame `midiNote`
  - frame `confidence`
  - frame `rmsDB`
  - frame `voiced`
  - existing note segmentation output
- `PitchDetector` comments were corrected so the live tracker is described honestly as YIN-style, not pYIN

Current status:
- implemented and compiling
- now validated in staged form on the real fixture clips:
  - safe default is the direct Hann-windowed YIN difference path plus the new multi-candidate / voiced-probability / Viterbi-style decoder
  - FFT-derived difference is still implemented, but remains behind `OPENSTUDIO_ANALYZER_USE_FFT_YIN=1` until parity is proven
- this family is now the top active queue item in the master map

Real fixture validation:
- `pitchOrg +4` using local analyzer fallback and the correct short-note fixture:
  - run: `20260415_100627_pitchOrg_plus4_adaptive_selector_analyzer_pyin_safe_g3`
  - note/body/core cents `0.00 / 0.00 / 0.00`
  - note mel `7.085`
  - entry mel `7.078`
  - exit mel `7.027`
  - output SHA `F4BFBE23347CA853EEDE27E48E70F24DC5983AABE37498D02CD8F6D518B3EC72`
- first `pitchTest +4` validation looked broken, but that run used the wrong note fixture (`example_plus4_notes.json`, the older `pitchOrg` timing), so it is not a valid analyzer verdict for the later `pitchTest` note family
- `pitchTest +4` using local analyzer fallback and the correct clip-specific fixture:
  - run: `20260415_101036_pitchTestOrg_plus4_adaptive_selector_analyzer_pyin_safe_g4`
  - note/body/core cents `-17.94 / 0.00 / -18.32`
  - note mel `5.158`
  - entry mel `1.530`
  - exit mel `1.632`
  - output SHA `1164BB74D7FC7EC87B163790DAF763E94B1B79812B7BE36F3FCD97966CFA740A`

FFT probe status:
- explicit FFT-YIN probe on `pitchOrg +4` is still not safe
  - run: `20260415_101249_pitchOrg_plus4_adaptive_selector_analyzer_fft_probe_g4`
  - note/body/core cents `-386.31 / -386.31 / -401.30`
  - note mel `8.072`
  - output SHA `019D3F5341440BE010F2B3E5E620AE5878CEAFE5C03364FCBED7DBCC5A4BDDC3`
- verdict:
  - keep FFT-derived YIN staged behind env until parity work is done
  - keep the direct YIN difference path as the active safe default for the new decoder stack

Pitch-editor scope change:
- the pitch editor is now intentionally mono-only
- stereo vocal clips remain supported:
  - editor analysis mixes the clip to mono for contour extraction
  - correction still renders against the full multichannel clip in the backend
- the old polyphonic mode UI path was removed from the pitch editor surface so the product now matches the monophonic editor target directly

Immediate next action:
- compare note segmentation quality and contour stability against the previous analyzer behavior on `pitchOrg` and `pitchTestOrg`
- only then decide whether the staged analyzer upgrade can become the new baseline

### 2026-04-14: Post-PSOLA Continuation Checks

#### Path E1, Iteration 1: Voiced-Tail Continuation Body
- Change:
  - tried a voiced-tail continuation source for the short-upward body, seeded from a small epoch window around the entry anchor instead of the full PSOLA body path
- Result:
  - `pitchOrg +4`
    - failed closed to the trusted `r6` baseline
    - output SHA stayed `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
    - body replacement used/fallback `false / true`
  - `pitchTest +4`
    - also stayed at the same shipping-control output
    - output SHA stayed `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - stopped early after the first iteration
  - no improvement on the active target and the guard stayed flat, so the path did not earn its second slot

#### Path E2, Iteration 1: Early Continuation Handoff Into Existing Core
- Change:
  - narrowed the continuation idea to the fragile early body only
  - replacement region would cover only the first continuation span after voiced entry, then hand into the existing hybrid core
  - replacement blending was changed to sit on top of the legacy/own base mix so the handoff could blend into the live core instead of only back into dry legacy
- Result:
  - `pitchOrg +4`
    - again failed closed to the trusted `r6` baseline
    - output SHA stayed `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
    - body replacement used/fallback `false / true`
  - `pitchTest +4`
    - also remained unchanged on the shipping-control SHA
    - output SHA stayed `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - stopped early after the first iteration
  - the architecture never engaged on the active target, so there was no justification to spend the second slot

#### Continuation-Family Conclusion
- Both post-PSOLA continuation families were exhausted under the stop-fast rule.
- Neither one engaged successfully on `pitchOrg +4`.
- The active renderer was restored to the trusted `HS-4 / r6` baseline by disabling body replacement again.
- Current live truth remains:
  - `pitchOrg +4`
    - note mel `6.209`
    - env `0.961`
    - entry mel `6.928`
    - exit mel `6.076`
    - onset artifact `1.810`
  - `pitchTest +4`
    - note mel `3.481`
    - env `0.623`
    - entry mel `2.484`
    - exit mel `7.662`
    - onset artifact `3.819`

### 2026-04-15: Dormant Branch Truth Sweep

Purpose:
- finish the option-map analysis for every callable renderer branch already present in the app-path runner
- stop guessing which archived branches might still matter and measure them directly on the same `+4` truth cases

#### `branch_simple_ce33`
- Result:
  - `pitchOrg +4`
    - note mel `7.810`
    - env `0.883`
    - body/core cents `0.00 / 0.00`
    - entry mel `7.996`
    - exit mel `9.295`
    - onset artifact `2.50`
    - SHA `29313710B708E393623C18128948110C62375473DC95D46B5F18E1DBF7FB939A`
  - `pitchTest +4`
    - note mel `3.044`
    - env `0.486`
    - body cents `0.00`
    - entry mel `1.660`
    - exit mel `6.378`
    - onset artifact `0.72`
    - SHA `70A4507DC97B4CC3C630B3DC418798B58E0F2539BF8C6D4EE7F2CEAB012189EC`
- Verdict:
  - not the best single overall control because it loses clearly to `CTRL-R6` on `pitchOrg +4`
  - but it is the strongest measured standalone result so far on `pitchTest +4`
  - keep as a secondary benchmark and harvest candidate

#### `branch_current_advanced`
- Result:
  - `pitchOrg +4`
    - note mel `7.329`
    - env `0.827`
    - body/core cents `-37.23 / -37.23`
    - entry mel `7.752`
    - exit mel `9.438`
    - onset artifact `1.94`
    - SHA `90D2D3638B7F1DF5655AD1A9871A3DCEDAC611E5198B285B5039B8583CD7DF45`
  - `pitchTest +4`
    - note mel `8.784`
    - env `1.190`
    - body/core cents `-35.70 / -36.45`
    - entry mel `5.908`
    - exit mel `6.373`
    - onset artifact `2.38`
    - SHA `E562BC9377B0BFB51B0D139CC532FEDED240B2D636D154166BAC0B1652B1E703`
- Verdict:
  - clearly below both controls on truth-case pitch accuracy and note/body quality
  - treat as rejected standalone archived branch

#### `pitch_only_psola_core`
- Result:
  - `pitchOrg +4`
    - note mel `11.053`
    - env `1.640`
    - body/core cents `-55.55 / -55.55`
    - entry mel `7.448`
    - exit mel `8.976`
    - onset artifact `1.94`
    - SHA `C6E61F58A3A99B41FAE27557AEE69F61EEAFFF925AE72332A2ACF21D54DEBAD8`
  - `pitchTest +4`
    - note mel `17.536`
    - env `2.547`
    - body/core cents `-104.96 / -124.35`
    - entry mel `6.305`
    - exit mel `6.329`
    - onset artifact `2.38`
    - SHA `A59B8C6305E31D95584C15214B1712F98BFF90B2E764FACA5A69F80A9DF61E6F`
- Verdict:
  - catastrophic truth-case miss as a standalone branch
  - reject as standalone archived core

#### `pitch_only_model_core`
- Result:
  - `pitchOrg +4`
    - note mel `10.955`
    - env `1.626`
    - body/core cents `-37.23 / -37.23`
    - entry mel `7.421`
    - exit mel `8.971`
    - onset artifact `1.94`
    - SHA `E2D3A690881BB489EEC0B7409FD2D60EA87F1AE2FE96527F01DFC89908F57DE8`
  - `pitchTest +4`
    - note mel `17.397`
    - env `2.530`
    - body/core cents `-104.96 / -124.35`
    - entry mel `6.295`
    - exit mel `6.330`
    - onset artifact `2.38`
    - SHA `FF455AB0B313826E75D249BBF69CEB61F740D741B85BF0DB06771CEAC73289BC`
- Verdict:
  - also a strong standalone rejection on the truth cases
  - no reason to keep it as an active standalone contender

#### `pitch_only_own_engine`
- Result:
  - `pitchOrg +4`
    - note mel `6.316`
    - env `1.044`
    - body/core cents `0.00 / 0.00`
    - entry mel `7.783`
    - exit mel `6.407`
    - onset artifact `1.59`
    - SHA `0A72E7027F69E85741E24AC1CC7CBD3958E263F0ED7FA9F4CEC49EA3D5202EE6`
  - `pitchTest +4`
    - note mel `12.164`
    - env `1.667`
    - body/core cents `0.00 / -18.32`
    - entry mel `17.634`
    - exit mel `13.403`
    - onset artifact `3.99`
    - SHA `96397D63A5F3AD6F835A80605E9FAF0615947D80E515F5A5F02F844A21AC4146`
- Verdict:
  - interesting on the easier `pitchOrg +4` clip because it keeps exact body pitch and improves onset artifact versus `CTRL-R6`
  - not viable as a standalone editor because `pitchTest +4` collapses badly
  - harvest only if a later v2 needs own-engine core behavior on easier upward notes

#### `formant_only_own_engine` and `pitch_plus_formant_own_engine`
- Result:
  - both matched `branch_current_advanced` bit-for-bit on both `+4` truth cases
  - `pitchOrg +4` SHA `90D2D3638B7F1DF5655AD1A9871A3DCEDAC611E5198B285B5039B8583CD7DF45`
  - `pitchTest +4` SHA `E562BC9377B0BFB51B0D139CC532FEDED240B2D636D154166BAC0B1652B1E703`
- Verdict:
  - treat them as archived advanced/formant variants, not distinct truth-case winners
  - reject them as standalone candidates

#### Dormant-Branch Sweep Conclusion
- The callable archived branch set is now mapped much more clearly:
  - strongest `pitchTest +4` branch: `branch_simple_ce33`
  - strongest kept overall experimental control: `CTRL-R6`
  - strongest easier-clip own-engine result: `pitch_only_own_engine` on `pitchOrg +4`
- The branches that are still worth keeping around as references are:
  - `CTRL-SHIP`
  - `CTRL-R6`
  - `branch_simple_ce33`
- The rest of the dormant callable branches are no longer credible standalone pitch-editor candidates on the truth cases.
- Next queue consequence:
  - the callable archived branch analysis is now complete enough to justify moving the top queue item to `FAM-V2-SYNTH-CORE`
  - that family is now tracked in the master map as the next upward v2 attempt instead of continuing any exhausted handoff or archived-core loop

### 2026-04-15: `FAM-V2-SYNTH-CORE` Stop-Fast Check

Purpose:
- test one new upward `v2` family that was still structurally different from the exhausted handoff and island-core loops
- specifically:
  - island shell
  - directly synthesized voiced core
  - explicit residual layer
  - outer-only shell behavior

Implementation note:
- branch name used for the single iteration was `pitch_only_synth_core`
- the branch code was removed immediately after the verdict, per the prune-on-reject workflow

#### `G1`
- Result:
  - `pitchOrg +4`
    - note mel `8.135`
    - env `1.517`
    - whole/body/core cents `-408.27 / 0.00 / 0.00`
    - entry mel `10.468`
    - exit mel `13.781`
    - onset artifact `1.39`
    - island native used/fallback `true / false`
    - SHA `247BC954F14147C9ABE0B12F04C20E907BD94C9FD400A5D99905CA995C44E572`
  - `pitchTest +4`
    - failed closed back to the control output
    - note mel `3.481`
    - env `0.623`
    - entry mel `2.484`
    - exit mel `7.662`
    - onset artifact `3.82`
    - island native used/fallback `false / false`
    - SHA `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - decisive reject after the first iteration
  - onset improved again on `pitchOrg +4`, but body/entry/exit and whole-note pitch behavior regressed too much
  - no improvement and no engagement on `pitchTest +4`
  - no `G2`
  - branch code removed immediately

### 2026-04-15: `FAM-ADAPTIVE-SELECTOR`

Purpose:
- stop forcing one renderer family to solve both truth clips by itself
- harvest the two strongest measured behaviors we now have:
  - `CTRL-R6` for short upward notes like `pitchOrg +4`
  - `branch_simple_ce33` for long upward notes like `pitchTest +4`

Implementation:
- new branch: `pitch_only_adaptive_selector`
- rule for this first family:
  - short upward notes -> use `CTRL-R6` behavior
  - long upward notes -> use `branch_simple_ce33`
  - downward notes remain unchanged on the current baseline behavior

#### `G1`
- Result:
  - `pitchOrg +4`
    - note mel `6.210`
    - env `0.961`
    - entry mel `6.978`
    - exit mel `6.029`
    - onset artifact `1.80`
    - SHA `E039C0AF68908D14ECC2BC17A6D335DDDA7C713B6DEFE10BF4D1C59799D3B0E0`
  - `pitchTest +4`
    - note mel `7.300`
    - env `0.840`
    - body/core cents `-35.70 / -54.39`
    - entry mel `5.911`
    - exit mel `6.375`
    - onset artifact `2.38`
    - SHA `4E0F29A3472F1B0A51A9B5D7D3FB8050DF374FB32034DD20C3049E143192FCAB`
- Diagnosis:
  - the “simple” sub-render inside the selector was not actually using the real `branch_simple_ce33` path
  - so `G1` was not a fair test of the harvested selector idea

#### `G2`
- Fix:
  - replaced the selector’s long-up simple source with the true whole-file `SignalsmithShifter::processPitchOnlyCe33Base` path used by standalone `branch_simple_ce33`
- Result:
  - `pitchOrg +4`
    - note mel `6.210`
    - env `0.961`
    - entry mel `6.978`
    - exit mel `6.029`
    - onset artifact `1.80`
    - SHA `E039C0AF68908D14ECC2BC17A6D335DDDA7C713B6DEFE10BF4D1C59799D3B0E0`
  - `pitchTest +4`
    - note mel `3.095`
    - env `0.493`
    - body/core cents `0.00 / -18.32`
    - entry mel `1.530`
    - exit mel `7.350`
    - onset artifact `0.70`
    - SHA `F52F4B97CACE7E048767F3243C7DAFD949FD08F2491DDC1CB649B6B8E9B8F24E`
- Guard runs:
  - `pitchOrg -4`
    - exact same trusted control SHA `6E73A2F0FA1E053488C65DD801D97F1F30564F0684DE076924CF7CCF2C4394AE`
  - `pitchTest -4`
    - exact same trusted control SHA `1B6A789C4D36AB0D330CD043E41A72EB27B858120DF34B271293764A197F909C`
- Verdict:
  - keep
  - this is the first family that improved `pitchTest +4` materially without materially harming `pitchOrg +4`
  - downward guards remained unchanged, so the branch is safe enough to freeze as the new experimental base for the next queue item

### 2026-04-15: Initial `-4` Support Scan For The Next Queue

Purpose:
- start the downward-family work on top of the newly kept adaptive branch
- check whether the archived support branches already contain an obvious `-4` winner we should harvest before designing a new downward-specific hybrid

#### `branch_simple_ce33`
- Result:
  - `pitchOrg -4`
    - note mel `8.397`
    - env `3.882`
    - onset artifact `2.51`
    - SHA `C4BCE0BE13F3ED88EEC2B716ECD1C4328244AA57BD884D9927A6976F5815C325`
  - `pitchTest -4`
    - note mel `3.931`
    - env `3.401`
    - note/body cents `-5.74 / -5.74`
    - entry mel `3.098`
    - exit mel `6.106`
    - onset artifact `1.07`
    - SHA `2732128716D791837D24CD6328B4FD8FA0E4476FC2940EB12FFB4A9FD2A1A600`
- Verdict:
  - not a standalone downward winner
  - interesting for onset/exit behavior on `pitchTest -4`, but the envelope error is too large to promote directly

#### `pitch_only_own_engine`
- Result:
  - `pitchOrg -4`
    - note mel `5.560`
    - env `1.544`
    - note/body cents `+11.90 / +11.90`
    - exit mel `7.135`
    - onset artifact `2.79`
    - SHA `451786635BD29F262125F7A93355D9267B08CDD8FDA2E8567029FA300C3111AD`
  - `pitchTest -4`
    - note mel `7.727`
    - env `1.049`
    - entry mel `10.313`
    - exit mel `13.998`
    - onset artifact `4.01`
    - SHA `88EA8E2FE77F77E4E316B49D362FEC2599C35E48EBA096C40F100F11794978E7`
- Verdict:
  - interesting only as a possible easy-clip downward body trait
  - not a viable standalone `-4` path because it collapses badly on `pitchTest -4`

#### Downward-Scan Conclusion
- There is no immediate archived branch we can promote as the downward answer.
- The adaptive selector remains frozen as the active experimental base.
- The next downward family should be a new hybrid that:
  - keeps the adaptive branch unchanged for `+4`
  - borrows only narrowly proven `-4` traits
  - does not replace the whole renderer with either `ce33` or standalone own-engine on downward notes

### 2026-04-15: `FAM-ADAPTIVE-SELECTOR` Downward Harvest Keep

Purpose:
- take the best narrow `-4` trait from the support scan
- land it inside the already-kept `pitch_only_adaptive_selector` branch instead of inventing another standalone renderer family

#### Cleanup Before The Real Test
- I first tried adding a separate branch key for the downward selector experiment.
- That path was not trustworthy:
  - the harness label was correct
  - but the app still reported `requested / actual = branch_hybrid_reset / branch_hybrid_reset`
- Instead of burning more time on branch-key plumbing, I removed that dead `_down` key and folded the downward trial directly into the working `pitch_only_adaptive_selector` branch.

#### Iteration G3: Light Short-Downward Own-Engine Support
- Change:
  - kept the adaptive selector's upward policy unchanged:
    - `CTRL-R6` on short upward notes
    - `branch_simple_ce33` on long upward notes
  - added one bounded downward trait:
    - light own-engine contribution on shorter edited downward notes
    - protected entry and exit shoulders
    - max own weight `0.24`
- Result:
  - `pitchOrg -4`
    - note mel `7.405 -> 6.570`
    - env `1.094 -> 1.100`
    - entry mel `6.902 -> 6.571`
    - exit mel `8.778 -> 7.565`
    - onset artifact `2.743 -> 2.802`
    - SHA `1D75C81C2FC23779F7B07114A30B72B8564E43A638A28276244C84DFEE91F46D`
  - `pitchTest -4`
    - remained byte-identical to the prior adaptive baseline:
      - SHA `1B6A789C4D36AB0D330CD043E41A72EB27B858120DF34B271293764A197F909C`
      - note mel `3.775`
      - env `1.062`
      - entry mel `3.090`
      - exit mel `7.134`
      - onset artifact `3.642`
  - `+4` guards
    - both adaptive-selector winners stayed unchanged:
      - `pitchOrg +4` SHA `E039C0AF68908D14ECC2BC17A6D335DDDA7C713B6DEFE10BF4D1C59799D3B0E0`
      - `pitchTest +4` SHA `F52F4B97CACE7E048767F3243C7DAFD949FD08F2491DDC1CB649B6B8E9B8F24E`
- Verdict:
  - keep
  - this is the first downward-side improvement that:
    - improves a real `-4` truth case
    - keeps the harder `pitchTest -4` case safe
    - leaves the newly won `+4` adaptive outputs untouched

#### Current Best Experimental Truth
- `pitchOrg +4`
  - note mel `6.210`
  - env `0.961`
  - entry mel `6.978`
  - exit mel `6.029`
  - onset artifact `1.804`
  - SHA `E039C0AF68908D14ECC2BC17A6D335DDDA7C713B6DEFE10BF4D1C59799D3B0E0`
- `pitchTest +4`
  - note mel `3.095`
  - env `0.493`
  - entry mel `1.530`
  - exit mel `7.350`
  - onset artifact `0.700`
  - SHA `F52F4B97CACE7E048767F3243C7DAFD949FD08F2491DDC1CB649B6B8E9B8F24E`
- `pitchOrg -4`
  - note mel `6.570`
  - env `1.100`
  - entry mel `6.571`
  - exit mel `7.565`
  - onset artifact `2.802`
  - SHA `1D75C81C2FC23779F7B07114A30B72B8564E43A638A28276244C84DFEE91F46D`
- `pitchTest -4`
  - note mel `3.775`
  - env `1.062`
  - entry mel `3.090`
  - exit mel `7.134`
  - onset artifact `3.642`
  - SHA `1B6A789C4D36AB0D330CD043E41A72EB27B858120DF34B271293764A197F909C`

#### Conclusion
- `pitch_only_adaptive_selector` is now the best overall experimental editor path in the repo:
  - short upward notes:
    - `CTRL-R6`
  - long upward notes:
    - `branch_simple_ce33`
  - shorter downward notes:
    - bounded own-engine support blended into the adaptive output
- The harder `pitchTest -4` problem is not solved yet, but basic downward support is no longer “missing entirely.”

## Goal And Non-Negotiables
- Match the user reference clips first, not the current engine:
  - `pitchOrg.wav -> pitchOrg+4s.wav`
  - `pitchOrg.wav -> pitchOrg-4s.wav`
  - `pitchTestOrg.wav -> pitchTestOrg+4s.wav`
  - `pitchTestOrg.wav -> pitchTestOrg-4s.wav`
- Hard requirements:
  - exact local pitch change
  - no word/consonant cutoff
  - no clipping-like grit
  - no previous-note drag
  - preview under about `1s`
- Historical safety reference:
  - commit `ce33d14f8a11f3315797876eff2711ef71a7cdf0`
- Sonic target:
  - user-supplied reference WAVs, even when another render sounds nicer by ear

## Current Baseline
- Current pitch-only baseline:
  - corrected note-local `single` render routing
  - safer `ce33`-family carrier
  - minimal note-core Stage B
- Why this is the current baseline:
  - fixed the major `single` vs `preview_segment` correctness bug
  - exact target pitch is now healthy again on the corrected `pitchTest` family
  - onset behavior is safer than the old advanced branch
  - still fast enough for note-local preview
- Current main pain point:
  - `pitchOrg -> +4` still sounds darker / more synthetic than the reference
  - neighbor-note metrics are still too high

### Current Measured Baseline
| Case | Note mel | Note env RMSE | Cents error | Onset jump | Current note-local latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pitchOrg -> +4` | `8.299` | `1.018` | `0.00` | `+0.65 dB` | `226 ms` |
| `pitchOrg -> -4` | `7.408` | `1.114` | `0.00` | `+1.64 dB` | `191 ms` |
| `pitchTestOrg -> +4` | `3.449` | `0.620` | `0.00` | `0.00 dB` | `283 ms` |
| `pitchTestOrg -> -4` | `3.769` | `1.071` | `0.00` | `0.00 dB` | `268 ms` |

- Preview note:
  - the bounded note-local preview path has stayed in the same `~200-300 ms` class during harness checks, comfortably under the `<1s` requirement
- Interpretation:
  - `pitchTest` correctness is now healthy
  - `pitchOrg +4` remains the main sonic gap

## Reality-Check Reset (2026-04-13)
- Status:
  - do **not** treat the current app as research-level or sample-level
  - do **not** treat the current own-engine branch as promotion-ready
- Why this reset happened:
  - manual listening on the first upward `+4` note move still revealed:
    - formant drift
    - neighboring-word cutoff / crackle
    - robotic shifted-note color
  - that means older "close enough" interpretations were too generous
- Fresh frozen report:
  - matrix root: `D:\test projects\os tests\reports\pitch-reality-check_20260413_172356`
  - matrix markdown: `D:\test projects\os tests\reports\pitch-reality-check_20260413_172356\pitch_reality_check_matrix.md`
- Key findings from the frozen reality-check matrix:
  - `baseline_app_current` on `pitchOrg +4` is still far from the reference:
    - note mel `8.299`
    - entry/exit mel `7.690 / 8.511`
    - formant body harmonic drift `0.523`
    - low/mid/high band delta `-2.826 / +0.807 / -4.847 dB`
    - F1/F2 proxy drift `-23.4 / -46.9 Hz`
  - `baseline_own_engine_current` is now branch-distinct and preview-complete, but still not promotion-ready:
    - `pitchOrg +4` single / preview are branch-true and parity-safe
    - `pitchTest +4` single remains much worse than the app baseline on timbre metrics
- Truth-phase fix that changed the interpretation:
  - the old persisted `default` and `pitch_only_own_engine` `+4` hashes were identical because separate app processes could write the same output filename slot
  - native regression summaries now persist:
    - requested vs actual renderer branch
    - fallback reason
    - output SHA256
    - candidate coverage start/end
  - the output naming path now uses a unique token, so branch comparisons are no longer being corrupted by filename collisions
- Current policy after the reset:
  - reference metrics remain the main gate
  - but claims of "research/sample-close" are invalid until the upgraded formant-sensitive harness and audition bundle both agree
- Current parity truth after the branch-fix:
  - `default`, `pitchOrg +4`
    - single / preview parity passed
    - note mel delta `0.509 dB`
    - note env delta `0.108`
    - body/core cents delta `0 / 0`
  - `pitch_only_own_engine`, `pitchOrg +4`
    - single / preview parity passed
    - note mel delta `0.063 dB`
    - note env delta `0.194`
    - body/core cents delta `0 / 0`
  - this removes preview/single parity as the immediate blocker on `pitchOrg +4`

### Track A: Current App Cleanup After Reset
#### Iteration TA-1: Upward shoulder / entry protection softening
- Hypothesis:
  - the first audible failure might be mostly an onset/shoulder problem in the current hybrid-reset app path
- Change:
  - made upward-note shoulders longer and drier at note entry/exit
- Result:
  - `pitchOrg +4` improved only slightly at the note edges:
    - onset peak `+0.65 -> +0.61 dB`
    - exit mel `8.511 -> 8.275`
  - but `pitchTest +4` regressed clearly:
    - note mel `3.449 -> 3.489`
    - entry mel `1.941 -> 2.779`
    - centroid drift `-39.4 -> -53.9 Hz`
- Verdict:
  - rejected
- Learning:
  - shoulder tuning alone is not the main blocker on the current app path

#### Iteration TA-2: Short-upward note-core spectral rebalance
- Hypothesis:
  - the current app path might be over-boosting mid bands and over-trimming low/high bands for short upward notes
- Change:
  - added a short-upward-only note-core spectral rebalance inside the Stage B envelope-anchor path
- Result:
  - effectively neutral on both checked cases
- Verdict:
  - rejected
- Learning:
  - the current app-path miss is not being driven by a small short-upward Stage B weighting error

#### Iteration TA-3: Upward carrier swap inside the hybrid app path
- Hypothesis:
  - the old `ce33` upward carrier itself is the source of the formant issue, so replacing it with the newer note-local Stage A carrier might immediately improve `+4`
- Change:
  - swapped only upward islands in the hybrid branch to the newer note-local carrier while keeping the hybrid blending and Stage B
- Result:
  - pitch correctness broke badly:
    - `pitchOrg +4` cents `0.00 -> -37.23`
    - `pitchTest +4` cents `0.00 -> -35.70`
  - timbre metrics did move, but not in a usable product direction
- Verdict:
  - rejected and reverted
- Learning:
  - the current hybrid branch depends on the `ce33` carrier assumptions more strongly than expected
  - fixing the app-path formant issue will need a cleaner carrier replacement plan, not an inline swap

#### Iteration TA-4: `ce33` carrier with preserve-style formant guidance
- Hypothesis:
  - the `ce33` hybrid carrier might be darkening `pitchOrg +4` because it hardcodes `1 / pitchRatio` timbre fallback, so feeding it voiced pitch guidance and preserve-style formant handling could reduce the audible formant drift
- Change:
  - routed the `ce33` pitch-only carrier through preserve-mode-style formant handling instead of the old ratio-driven fallback
- Result:
  - `pitchOrg +4` regressed badly:
    - note mel `8.299 -> 8.833`
    - note env `1.018 -> 1.298`
    - centroid drift `-189.7 -> +84.8 Hz`
    - entry/exit mel `7.690 / 8.511 -> 11.240 / 10.962`
    - onset peak `+0.65 -> +2.52 dB`
  - `pitchTest +4` also regressed badly:
    - note mel `3.449 -> 8.516`
    - note env `0.620 -> 1.703`
    - centroid drift `-39.4 -> +355.6 Hz`
- Verdict:
  - rejected and reverted
- Learning:
  - the current hybrid app path is not simply "too dark because `1 / ratio` is wrong"
  - moving the `ce33` carrier toward preserve-mode behavior blows up the note body and boundaries instead of fixing the reference mismatch

#### Iteration TA-5: Short-upward Stage B de-darkening rebalance
- Hypothesis:
  - the primary `pitchOrg +4` miss might be recoverable without touching the fragile `ce33` carrier by de-darkening only the short upward Stage B weighting:
    - slightly less mid emphasis
    - less low trim
    - less high-band air protection
- Change:
  - added a stronger short-upward-only spectral rebalance inside the hybrid Stage B path
- Result:
  - `pitchOrg +4` was mixed:
    - note mel `8.299 -> 8.170`
    - note env `1.018 -> 1.102`
    - centroid drift `-189.7 -> -26.5 Hz`
    - entry/exit mel worsened to `9.109 / 9.461`
    - harmonic drift worsened `0.523 -> 0.771`
  - `pitchTest +4` regressed clearly:
    - note mel `3.449 -> 6.366`
    - note env `0.620 -> 1.246`
    - centroid drift `-39.4 -> +144.5 Hz`
- Verdict:
  - rejected and reverted
- Learning:
  - stronger short-upward de-darkening can move centroid drift in the right direction on the hard case, but it is too destructive to the healthier clip family
  - the next app-path move should not be a broader Stage B spectral push; it needs a cleaner upward carrier or decomposition idea

#### Iteration TA-6: Upward shoulder protection tightening on the shipping branch
- Hypothesis:
  - the stitched / cutoff feeling at the start of upward notes is partly coming from too much wet shoulder exposure in the hybrid-reset shipping branch
- Change:
  - for upward notes only, tightened the audible entry/exit shoulders and lowered the wet floor inside the protected entry/exit zones
  - kept the voiced body / Stage B timbre logic unchanged
- Result:
  - `pitchOrg +4` improved slightly and stayed exact:
    - note mel `8.299 -> 8.289`
    - note env `1.018 -> 1.017`
    - onset peak `+0.65 -> +0.61 dB`
    - exit mel `8.511 -> 8.203`
    - harmonic drift `0.523 -> 0.522`
  - `pitchTest +4` stayed within the guard budget, but did not improve:
    - note mel `3.449 -> 3.481`
    - note env `0.620 -> 0.623`
    - neighbor mel stayed effectively unchanged
- Verdict:
  - kept
- Learning:
  - the onset / stitching feel can be improved a little without destabilizing the guard case
  - but the main miss is still note-core timbre / formant behavior, not shoulders alone

#### Iteration TA-7: Upward frame-local envelope smoothing
- Hypothesis:
  - the upward hybrid-reset app path might still be too broad in its envelope estimate, so tightening the envelope smoothing window could make the correction more local-frame and more reference-like
- Change:
  - reduced the upward hybrid-reset envelope smoothing window inside the Stage B anchor pass
- Result:
  - `pitchOrg +4` was effectively unchanged at the saved-output level before the guard rerun
  - `pitchTest +4` shifted slightly but without any useful improvement
- Verdict:
  - rejected and reverted
- Learning:
  - the current app-path miss is not being caused by envelope smoothing width alone

#### Iteration TA-8: Upward core-only high-band detail reinjection
- Hypothesis:
  - the app path might still sound dark / robotic on `pitchOrg +4` because the upward hybrid-reset branch is over-smoothing high-band detail inside the voiced core
- Change:
  - increased capped upward high-band detail reinjection only inside the hybrid-reset core path
- Result:
  - `pitchOrg +4` regressed overall:
    - note mel `8.289 -> 8.304`
    - note env `1.017 -> 1.021`
    - entry/exit mel `7.774 / 8.203 -> 7.829 / 8.238`
    - harmonic drift improved only trivially `0.5221 -> 0.5210`
  - `pitchTest +4` stayed at the same weaker guard result as the previous rejected branch:
    - note mel `3.504`
    - note env `0.614`
- Verdict:
  - rejected
- Learning:
  - extra high-band detail alone is not enough to make the current app path more reference-like
  - the remaining app-path gap is more structural than just "too little air"

## Research Timeline
### Milestone 1: Early DSP tuning before the harness was good enough
- Prior belief:
  - broad note mel and general listening were enough to guide tuning
- New evidence:
  - onset cracking, note-start weakness, and neighbor damage were still audible even when broad metrics looked acceptable
- Decision:
  - stop trusting note-wide metrics alone

### Milestone 2: Harness upgrade for onset / release / neighbor damage
- Prior belief:
  - if note mel improved, pitch quality was probably improving in the right way
- New evidence:
  - onset and neighbor windows could fail badly while overall note metrics stayed merely "okay"
- Decision:
  - add entry/core/exit windows, pre/post-neighbor windows, onset peak jump, onset high-band burst, and audition bundles

### Milestone 3: Wrong `pitchTest` fixture discovery
- Prior belief:
  - the `pitchTest` comparisons were valid enough to compare branches
- New evidence:
  - the old `pitchTest` runs were using the wrong note payload / wrong window family
- Decision:
  - add clip-family-specific fixtures for `pitchTestOrg` and stop reusing the older `pitchOrg` note fixture

### Milestone 4: Preview vs `single` divergence discovery
- Prior belief:
  - preview and normal apply were basically the same engine with different quality settings
- New evidence:
  - corrected `pitchTestOrg -> +4` preview was around `-36 cents`, while `single` was once around `-282 cents`
- Decision:
  - treat the old `single` path as a core product bug, not a minor tuning issue

### Milestone 5: Note-local `single` render fix
- Prior belief:
  - pitch correctness problems were mainly inside Stage A / Stage B DSP
- New evidence:
  - most of the giant miss came from how `single` rendered and spliced the edited region
- Decision:
  - make `single` use note-local windowing logic consistent with the preview family

### Milestone 6: Architecture bakeoff
- Prior belief:
  - the current advanced branch might simply be the global winner
- New evidence:
  - branch results depended strongly on clip family and on whether the corrected fixtures were used
- Decision:
  - stop assuming the most complex branch is best; compare branches only through the corrected harness

### Milestone 7: Safer hybrid becomes the current baseline
- Prior belief:
  - a mixed carrier branch might deliver the best of both worlds
- New evidence:
  - carrier mixing was unstable after the `single` routing fix
- Decision:
  - use the safer `ce33`-family carrier plus a minimal note-core Stage B as the current baseline

## Approaches Tried
### 1. Simple `ce33`-style Signalsmith baseline
- Intent:
  - recover the historically safer articulation path
- Why it seemed promising:
  - earlier stable behavior, cleaner entry/exit, fewer synthetic artifacts
- Result:
  - exact pitch and cleaner onset behavior in many cases
  - still too plain / not close enough to the reference timbre on `pitchOrg`
- Failure / plateau reason:
  - safer than richer branches, but often too far from the sonic target
- Status:
  - `plateaued but informative`

### 2. Current advanced note-island Signalsmith branch
- Intent:
  - improve the carrier and recover timbre with a serial note-core Stage B
- Why it seemed promising:
  - better broad quality than simple `ce33` on `pitchOrg`
  - fast preview
- Result:
  - good broad note metrics on some cases
  - onset and neighbor damage remained
  - looked better than it really was before the harness upgrade
- Failure / plateau reason:
  - too artifact-prone at note boundaries and not robust enough across clip families
- Status:
  - `plateaued but informative`

### 3. Carrier-mix hybrid (`ce33` shoulders + current core carrier)
- Intent:
  - keep safer shoulders while using the stronger current carrier in the core
- Why it seemed promising:
  - matched the intuition that shoulders and core want different behavior
- Result:
  - unstable after the corrected `single` path
  - could blow up centroid drift and quality badly
- Failure / plateau reason:
  - mixing two carriers inside one note island is too fragile in the current design
- Status:
  - `dead end`

### 4. Safer hybrid (`ce33` carrier + minimal Stage B)
- Intent:
  - keep the safer carrier and add only a small note-core recovery layer
- Why it seemed promising:
  - lowest-risk path after the `single` routing fix
- Result:
  - exact pitch on corrected `pitchTest`
  - safer onset behavior
  - good enough to become the current baseline
- Failure / plateau reason:
  - still below the research/sample target, especially on `pitchOrg +4`
- Status:
  - `current baseline`

### 5. PSOLA branch
- Intent:
  - use a voiced-core pitch-synchronous recovery path
- Why it seemed promising:
  - should preserve articulation well in voiced regions
- Result:
  - no meaningful app-path win
- Failure / plateau reason:
  - did not beat the safer baseline enough to justify the extra complexity
- Status:
  - `dead end`

### 6. Model-style experimental branch
- Intent:
  - recover more natural timbre through a heavier local refinement branch
- Why it seemed promising:
  - could, in theory, close the realism gap more quickly
- Result:
  - no app-path win strong enough to justify it
- Failure / plateau reason:
  - not a practical product path in the current form
- Status:
  - `dead end for now`

### 7. Bungee benchmark
- Intent:
  - benchmark an interesting outside shifter against Signalsmith
- Why it seemed promising:
  - partial wins on some upward note-island cases
- Result:
  - interesting benchmark, mixed across directions
- Failure / plateau reason:
  - not strong enough or clean enough to replace the current shipping path
- Status:
  - `plateaued but informative`

## Failures And Root Causes
### Failure: word cutoff / broken onset
- Root cause:
  - processing too wide a region
  - shoulders treated like core
  - old `single` render routing bug
- Learning:
  - strict note-local rendering is mandatory

### Failure: clipping-like crackle without true digital clipping
- Root cause:
  - interference-style artifacts from overly aggressive blending and unstable branch combinations
- Learning:
  - safer carrier + serial correction only

### Failure: pitch-up sounding brighter, pitch-down darker
- Root cause:
  - pitch-directional timbre drift and naive fallback behavior
- Learning:
  - up/down probably need distinct note-core handling

### Failure: branch looked good numerically but sounded wrong
- Root cause:
  - harness originally missed onset/release/neighbor artifacts
- Learning:
  - decision-making must use artifact-sensitive metrics and short audition files

### Failure: misleading `pitchTest` conclusions
- Root cause:
  - wrong note fixture and wrong analysis window
- Learning:
  - every clip family needs its own verified fixture when note placement differs

## What Actually Improved
- note-island rendering
- corrected `single` render routing
- artifact-aware harness
- simpler `ce33`-family carrier behavior
- smaller, safer Stage B

## Own-Engine Architecture Branch
- Goal:
  - stop building around `generic shifter -> corrective overlays`
  - create a shared decomposition engine that can later support:
    - `pitch_only_own_engine`
    - `formant_only_own_engine`
    - `pitch_plus_formant_own_engine`
- What is implemented now:
  - new shared-analysis module in:
    - `Source/OwnPitchEngine.h`
    - `Source/OwnPitchEngine.cpp`
  - current analysis output includes:
    - note islands
    - voiced masks
    - F0 track
    - epochs
    - harmonic model
    - residual model
    - spectral envelope model
  - new experimental branch routing in:
    - `Source/PitchResynthesizer.cpp`
    - `tools/run-ui-pitch-regression.ps1`
  - current mode support:
    - `pitch_only_own_engine`: real experimental renderer
    - `formant_only_own_engine`: shared-analysis scaffold, legacy render fallback
    - `pitch_plus_formant_own_engine`: own pitch base scaffold, legacy formant overlay fallback
- Why this branch exists:
  - the old Signalsmith-centered family plateaued below the target
  - future global formant work needs a clean place in the engine graph, not another retrofit
- Current status:
  - `still viable as architecture`
  - `not viable yet as a shipping renderer`

### First Own-Engine Benchmark Snapshot
| Case | Branch | Note mel | Note env RMSE | Cents error | Centroid drift | Onset jump | Latency |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `pitchOrg -> +4` | `default` | `7.288` | `0.789` | `-18.32` | `-115.9 Hz` | `+0.65 dB` | `184 ms` |
| `pitchOrg -> +4` | `pitch_only_own_engine` v1 | `13.917` | `1.840` | `-762.28` | `+349.9 Hz` | `+15.14 dB` | `49 ms` |
| `pitchOrg -> +4` | `pitch_only_own_engine` v2 | `14.169` | `1.893` | `-762.28` | `+355.2 Hz` | `+17.63 dB` | `46 ms` |
| `pitchTestOrg -> +4` | `default` | `3.449` | `0.620` | `0.00` | `-39.4 Hz` | `0.00 dB` | `266 ms` |
| `pitchTestOrg -> +4` | `pitch_only_own_engine` v1 | `19.693` | `2.782` | `0.00` | `+1776.0 Hz` | `+2.29 dB` | `63 ms` |
| `pitchTestOrg -> +4` | `pitch_only_own_engine` v2 | `19.822` | `2.805` | `0.00` | `+1781.8 Hz` | `+4.83 dB` | `61 ms` |

- Interpretation:
  - the own-engine branch is very fast already
  - the current synthesis prototype is badly wrong on timbre and onset behavior
  - `pitchOrg +4` also has a major pitch-takeover failure in the current prototype
  - the small wet-mask fix did not solve the core problem
- Current decision:
  - keep the architecture branch
  - do **not** treat the current own-engine renderer as competitive yet
  - next own-engine work must focus on:
    - correct voiced-core takeover
    - target-pitch integrity on `pitchOrg +4`
    - less synthetic harmonic rendering before any global-formant module is turned on

### Own-Engine Iteration Log
#### Iteration OE-1: Use the app correction curve as pitch intent
- Change:
  - stop deriving target pitch directly from note MIDI fields
  - use the same per-sample correction curve the legacy renderer uses
- Why:
  - keeps pitch intent consistent across engine families
  - avoids fixture-specific note-payload interpretation bugs
- Result:
  - `pitchOrg +4` pitch correctness recovered from `-762.28 cents` to `-18.32 cents`
  - timbre was still far too bright and synthetic
- Learning:
  - the biggest remaining own-engine problem after OE-1 was synthesis color, not pitch-target interpretation

#### Iteration OE-2: Replace additive carrier with epoch-grain carrier where possible
- Change:
  - use a pitch-synchronous grain carrier inside the voiced core when epoch density is good
- Why:
  - keeps more of the original waveform character than pure additive synthesis
- Result:
  - `pitchTest +4` improved materially:
    - note mel `19.478 -> 9.447`
    - note envelope `2.819 -> 1.234`
    - centroid drift `+2321.8 Hz -> -18.2 Hz`
  - `pitchOrg +4` barely changed in that pass
- Learning:
  - the new carrier family can work
  - clip families do not fail in the same way, so direction and clip behavior matter

#### Iteration OE-3: Tame core wetness and brightness
- Change:
  - lower core wet cap
  - make shoulders drier
  - add a conservative low-pass to the prototype carrier
- Why:
  - the epoch carrier was still too bright and too intrusive in the note body
- Result:
  - `pitchOrg +4` improved strongly and became the first genuinely competitive own-engine result:
    - note mel `12.012 -> 5.945`
    - note envelope `1.989 -> 1.099`
    - cents `-18.32 -> 0.00`
    - centroid drift `+1323.2 Hz -> +67.1 Hz`
    - onset jump `+17.64 dB -> +0.81 dB`
  - `pitchOrg -4` was mixed:
    - note mel `6.396`
    - note envelope `1.154`
    - cents `+59.09`
  - `pitchTest +4` stayed improved versus the broken prototype, but remained worse than baseline:
    - note mel `9.603`
    - note envelope `1.144`
    - cents `-8.95`
  - `pitchTest -4` also remained worse than baseline:
    - note mel `8.779`
    - note envelope `1.125`
    - cents `0.00`
- Learning:
  - the own engine is now promising on the hardest `pitchOrg +4` case
  - the current prototype is not robust yet across directions and clip families
  - next own-engine work should be direction-specific and carrier-shaping-specific, not another broad architecture rewrite

#### Iteration OE-4: Direction- and duration-aware carrier shaping
- Change:
  - separate carrier settings for:
    - short upward notes
    - longer upward notes
    - downward notes
- Why:
  - `pitchOrg +4` and the `pitchTest` family were clearly not asking for the same wetness / brightness balance
- Result:
  - improved `pitchTest +4` and both `-4` cases
  - but softened the best `pitchOrg +4` result too much
- Decision:
  - treat the first direction-aware pass as informative, not the final keeper
- Learning:
  - direction-aware tuning is necessary
  - but the main objective must still protect the `pitchOrg +4` win

#### Iteration OE-5: Stronger voiced-core takeover with short-downward pitch bias
- Change:
  - keep the direction-aware carrier shaping
  - add stronger voiced-core takeover
  - apply a small target-ratio bias only for short downward notes
- Why:
  - the remaining own-engine errors were dominated by partial dry-pitch leakage on `-4`
- Result:
  - `pitchOrg -4` cents fixed from `+59.09` to `0.00`
  - `pitchTest +4` and `pitchTest -4` stayed exact at `0.00`
  - `pitchOrg +4` stayed clearly better than the legacy baseline on note mel, but not as strong as OE-3
- Learning:
  - the own engine now has a credible cross-case baseline
  - the next gap is mostly timbre realism / spectral balance, not gross pitch correctness

#### Iteration OE-6: Longer-upward shoulder easing
- Change:
  - keep OE-5 as the base
  - reduce dry shoulder protection only for longer upward notes
- Why:
  - `pitchTest +4` was still failing more at entry/exit shape than at pitch correctness
- Result:
  - `pitchTest +4` improved slightly without harming the other three tracked cases:
    - note mel `9.207 -> 9.143`
    - note envelope `1.116 -> 1.120` (flat)
    - cents stayed `0.00`
- Learning:
  - long upward notes do want slightly less dry shoulder protection
  - the remaining gap is now a smaller timbre realism problem, not a routing or gross takeover failure

#### Iteration OE-7: WORLD-style decomposition pass 1
- Change:
  - replace the heuristic own-engine decomposition with a real source-filter pass:
    - pitch-adaptive spectral envelope analysis
    - harmonic model driven from the source envelope
    - band aperiodicity / residual model
    - source-filter correction applied on top of the epoch carrier
- Why:
  - the own engine was now routing and pitching correctly often enough that the remaining gap looked like a decomposition realism problem, not a carrier-routing problem
- Result:
  - this became the first kept decomposition upgrade:
    - `pitchOrg +4` improved:
      - note mel `6.528 -> 6.293`
      - note envelope `1.076 -> 1.049`
      - centroid drift `-223.7 Hz -> -139.1 Hz`
      - cents stayed `-18.32`
    - `pitchTest +4` stayed exact at `0.00 cents`, but timbre remained weak:
      - note mel `9.143 -> 9.260`
      - note envelope `1.120 -> 1.109`
      - centroid drift improved `-435.9 Hz -> -230.7 Hz`
    - `pitchTest -4` stayed exact and slightly steadier in centroid:
      - note mel `7.915 -> 7.907`
      - centroid drift `-247.3 Hz -> -25.4 Hz`
- Learning:
  - the source-filter direction is real and worth continuing
  - the main remaining miss is now concentrated in long upward note entry/exit and spectral balance, not gross pitch intent

#### Iteration OE-8: Aperiodicity-aware envelope correction
- Change:
  - damp spectral-envelope correction in high-aperiodicity bands
  - reduce residual reinjection in noisier regions
- Why:
  - the first decomposition pass still looked too blunt on `pitchTest`, especially in regions that behave more like noisy / mixed content than clean harmonics
- Result:
  - essentially neutral:
    - `pitchOrg +4` note mel `6.293 -> 6.277`
    - `pitchOrg -4` note mel `7.033 -> 7.040`
    - `pitchTest +4` note mel `9.260 -> 9.265`
    - `pitchTest -4` note mel `7.907 -> 7.901`
- Decision:
  - rejected as a useful next lever
- Learning:
  - the remaining `pitchTest` gap is not mainly caused by over-correcting noisy bins

#### Iteration OE-9: Fade source-filter correction at core boundaries
- Change:
  - fade the source-filter correction and residual reinjection in and out inside the core
- Why:
  - the own engine was still trailing the baseline most clearly at note entry and exit on long upward notes
- Result:
  - also effectively neutral:
    - `pitchOrg +4` note mel `6.277 -> 6.275`
    - `pitchTest +4` note mel `9.265 -> 9.259`
    - `pitchOrg -4` and `pitchTest -4` moved only trivially
- Decision:
  - rejected; keep OE-7 as the current own-engine baseline
- Learning:
  - `pitchTest +4` is not primarily failing because the source-filter correction reaches too close to the core edges
  - the shared `pitchTest` pre/post-neighbor metrics are also high on the default baseline, so that metric is not the differentiator there

#### Iteration OE-10: Local-frame spectral-envelope correction
- Change:
  - keep the source-filter decomposition from OE-7
  - switch the correction from a single broad note-average envelope to a locally interpolated frame envelope with a small global blend for stability
- Why:
  - long upward notes still looked too flattened in timbre, which suggested the correction was too coarse over time rather than fundamentally wrong
- Result:
  - this is the new kept decomposition baseline:
    - `pitchTest +4` improved:
      - note mel `9.260 -> 9.069`
      - note envelope `1.109 -> 1.071`
    - `pitchTest -4` improved:
      - note mel `7.907 -> 7.727`
      - note envelope `1.077 -> 1.049`
    - `pitchOrg +4` regressed slightly:
      - note mel `6.293 -> 6.342`
      - note envelope `1.049 -> 1.053`
    - `pitchOrg -4` also regressed slightly:
      - note mel `7.033 -> 7.060`
- Learning:
  - temporal envelope locality matters
  - the long-note `pitchTest` gap was not just a carrier problem
  - this change is worth keeping even with the small `pitchOrg` regressions because it improves the weaker family materially

#### Iteration OE-11: Short-upward pitch-ratio bias tuning
- Change:
  - add a tiny upward-only pitch-ratio bias for shorter notes, reusing the same structural hook that already fixed the short-downward miss
- Why:
  - after OE-10, `pitchOrg +4` still carried the old `-18.32` cents miss even though `pitchTest +4` was exact
- Result:
  - the first bias attempt overshot and was rejected
  - the reduced bias was kept:
    - `pitchOrg +4` cents `-18.32 -> 0.00`
    - `pitchOrg +4` note envelope `1.053 -> 1.017`
    - `pitchOrg +4` note mel `6.342 -> 6.318`
    - `pitchTest +4` stayed unchanged at `9.069` note mel / `0.00` cents
    - both `-4` cases stayed unchanged from OE-10
- Learning:
  - the short-upward pitch miss was a small ratio calibration issue, not a deeper decomposition failure
  - the own engine now has a meaningfully better `+4` story than it did at OE-7

### Latest Own-Engine Snapshot
| Case | Branch | Note mel | Note env RMSE | Cents error | Centroid drift | Onset jump | Latency |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `pitchOrg -> +4` | `default` | `7.288` | `0.789` | `-18.32` | `-115.9 Hz` | `+0.65 dB` | `184 ms` |
| `pitchOrg -> +4` | `pitch_only_own_engine (OE-11)` | `6.318` | `1.017` | `0.00` | `-170.6 Hz` | `+0.73 dB` | `57 ms` |
| `pitchOrg -> -4` | `default baseline` | `7.408` | `1.114` | `0.00` | n/a | `+1.64 dB` | `191 ms` |
| `pitchOrg -> -4` | `pitch_only_own_engine (OE-11)` | `7.060` | `1.279` | `0.00` | `+217.3 Hz` | `+0.95 dB` | `54 ms` |
| `pitchTestOrg -> +4` | `default baseline` | `3.449` | `0.620` | `0.00` | `-39.4 Hz` | `0.00 dB` | `266 ms` |
| `pitchTestOrg -> +4` | `pitch_only_own_engine (OE-11)` | `9.069` | `1.071` | `0.00` | `-225.9 Hz` | `0.00 dB` | `74 ms` |
| `pitchTestOrg -> -4` | `default baseline` | `3.769` | `1.071` | `0.00` | n/a | `0.00 dB` | `268 ms` |
| `pitchTestOrg -> -4` | `pitch_only_own_engine (OE-11)` | `7.727` | `1.049` | `0.00` | `-37.9 Hz` | `0.00 dB` | `76 ms` |

- Current decision after OE-11:
  - keep the own-engine branch active
  - keep OE-11 as the current own-engine baseline
  - OE-8 and OE-9 were neutral and should not be re-tried first
  - the own engine is now exact on all four tracked pitch cases
  - it is still not ready to replace the current baseline across all clip families
  - next work should prioritize:
    - improve long upward-note timbre realism on `pitchTest +4`
    - bring the `pitchOrg` and `pitchTest` envelope / spectral realism closer together without giving back exact pitch
    - compare entry/exit behavior against the default baseline, not just against the reference
    - then global-formant field work on top of the stabilized pitch carrier

### Own-Engine Preview Reality Check
- Fresh current-code preview truth:
  - `pitch_only_own_engine` preview no longer times out or drops the result file
  - it is still not usable, because the preview render is sonically far away from both the reference and the own-engine single render
- Current `pitchOrg -> +4`:
  - `single`: note mel `6.318`, note env `1.017`, note/body/core cents `0.00 / +18.92 / +18.92`
  - `preview_segment`: note mel `12.758`, note env `1.434`, note/body/core cents `-458.43 / -880.59 / 0.00`
- Current `pitchTestOrg -> +4`:
  - `single`: note mel `9.069`, note env `1.071`, note/body/core cents `0.00 / 0.00 / -18.32`
  - `preview_segment`: note mel `16.584`, note env `2.051`, note/body/core cents `-978.55 / -978.55 / -984.54`
- Learning:
  - the own-engine preview problem is no longer "job failed"
  - it is now a **preview/single parity** problem
  - the core of `pitchOrg +4` preview can still hit the right pitch while the broader note body is badly wrong, which points to body/coverage/takeover behavior rather than pure target-pitch math

#### Iteration OE-12: Short-upward body-takeover increase
- Hypothesis:
  - the own-engine upward short-note miss might be caused by too much dry original pitch leaking outside the strict voiced core, especially in preview
- Change:
  - increased short-upward body entry/exit wetness and outside-core wet scaling
- Result:
  - no measurable change on the checked runs:
    - `pitchOrg +4 single`: stayed `6.318 / 1.017 / 0.00 cents`
    - `pitchOrg +4 preview`: stayed `12.758 / 1.434 / -458.43 cents`
    - `pitchTest +4 single`: stayed `9.069 / 1.071 / 0.00 cents`
- Verdict:
  - rejected and reverted
- Learning:
  - the current own-engine preview failure is not fixed by a simple increase in short-upward body wetness
  - the next own-engine move should target preview/single parity more explicitly, not just "more corrected body"

## Remaining Approaches
### Phase 1: Timbre Recovery On Safer Hybrid Baseline
- **Iteration budget:** `2`
- Why this could be better:
  - pitch correctness is now acceptable
  - the remaining gap is mainly note-core timbre realism, especially `pitchOrg +4`
  - this is the lowest-risk path because it keeps the corrected note-local routing
- What would count as failure:
  - after 2 bounded iterations, `pitchOrg +4` still sounds clearly robotic/dark and metrics do not materially improve
- What happens if it is worse:
  - revert the failed timbre change immediately
  - keep the safer hybrid baseline unchanged
- **Iterations left after Phase 1 completes:** `6`

### Phase 2: Direction-Specific Note-Core Correction
- **Iteration budget:** `2`
- Why this could be better:
  - `+pitch` and `-pitch` have already shown different needs
  - one shared timbre rule is likely holding quality back
- What would count as failure:
  - separate up/down tuning gives only tiny wins or causes regressions across clip families
- What happens if it is worse:
  - keep only any clearly winning directional constant
  - otherwise revert to the safer hybrid baseline
- **Iterations left after Phase 2 completes:** `4`

### Phase 3: Shoulder / Onset Protection Refinement
- **Iteration budget:** `2`
- Why this could be better:
  - the user still reports slight break/cutoff/robotic onset behavior
  - the upgraded harness now measures those failures directly
- What would count as failure:
  - onset gets cleaner but note-core quality worsens too much
  - or metrics improve while the audible issue remains unchanged
- What happens if it is worse:
  - lock the best shoulder behavior already found
  - do not keep stretching the shoulder region just because one artifact metric improves
- **Iterations left after Phase 3 completes:** `2`

### Phase 4: Harmonic-Relative Stage B
- **Iteration budget:** `2`
- Why this could be better:
  - this is the last serious DSP-family change still likely to move closer to the research renders without another Stage A rewrite
  - it targets harmonic structure more directly than the current envelope-style correction
- What would count as failure:
  - no meaningful gain after 2 bounded iterations
  - or latency / instability / artifacts regress
- What happens if it is worse:
  - stop incremental DSP tuning on this family
  - do not open another broad branch without a new explicit decision
- **Iterations left after Phase 4 completes:** `0`

## Iteration Budget And Phase Gates
- Total remaining serious research budget: **`8` bounded iterations**
- Phase breakdown:
  - Phase 1: `2`
  - Phase 2: `2`
  - Phase 3: `2`
  - Phase 4: `2`
- At the end of each phase, record:
  - what changed
  - what improved
  - what regressed
  - whether the next phase is still justified
- Phase gates:
  - start: `8` iterations left
  - after Phase 1: `6` iterations left
  - after Phase 2: `4` iterations left
  - after Phase 3: `2` iterations left
  - after Phase 4: `0` iterations left
- Rule:
  - no phase gets more than its 2-iteration budget without an explicit reset of the plan

## Iteration Results
### Phase 1, Iteration 1 of 2: Upward hybrid envelope-anchor relaxation
- Hypothesis:
  - `pitchOrg +4` was still too dark, so a lighter upward-only hybrid envelope anchor might recover some timbre without disturbing onset safety
- Change:
  - slightly increased upward hybrid mid-band lift
  - slightly reduced upward low-band trim
  - slightly relaxed upward air protection
  - slightly increased upward hybrid detail retention
- Result:
  - `pitchOrg -> +4`: note mel `8.414 -> 8.411`, note env `1.019 -> 1.019`, centroid `-194.0 -> -193.3 Hz`
  - `pitchTestOrg -> +4`: note mel `3.441 -> 3.439`, note env `0.620 -> 0.621`, centroid `-34.2 -> -33.6 Hz`
  - onset metrics stayed effectively unchanged
- Verdict:
  - no material improvement
  - kept in place because it was neutral-to-slightly-better, but it does not count as a meaningful Phase 1 win

### Phase 1, Iteration 2 of 2: Stronger upward hybrid Stage B
- Hypothesis:
  - a slightly stronger upward Stage B might improve the darker `pitchOrg +4` note core more directly
- Change:
  - benchmarked stronger upward Stage B wetness only
  - tested `OPENSTUDIO_PITCH_STAGEB_SCALE_UP=0.25`
  - tested `OPENSTUDIO_PITCH_STAGEB_SCALE_UP=0.30`
- Result:
  - `0.25`:
    - `pitchOrg -> +4`: note mel `8.207`, note env `1.018`, centroid `-182.5 Hz`
    - `pitchTestOrg -> +4`: note mel `3.549`, note env `0.664`, centroid `-28.9 Hz`
  - `0.30`:
    - `pitchOrg -> +4`: note mel `8.207`, note env `1.018`, centroid `-182.5 Hz`
    - `pitchTestOrg -> +4`: note mel `3.658`, note env `0.699`, centroid `-24.2 Hz`
- Verdict:
  - rejected
  - the `pitchOrg +4` gain was too small to justify the regression on the already healthier `pitchTestOrg +4` case

### Phase 1 Status
- Outcome:
  - Phase 1 completed without a meaningful win
  - current baseline remains the safer hybrid with the neutral Iteration 1 refinement and without the stronger upward Stage B override
- Iterations remaining:
  - total remaining after Phase 1 completion: `6`
  - next phase to start: `Phase 2: Direction-Specific Note-Core Correction`

### Phase 2, Iteration 1 of 2: Upward short-note bias inside envelope-anchor strength
- Hypothesis:
  - the shorter `pitchOrg +4` note might need stronger upward note-core correction than the longer `pitchTest +4` note
- Change:
  - added an upward-only short-note boost inside the envelope-anchor strength calculation
- Result:
  - `pitchOrg -> +4`: note mel `8.411 -> 8.410`, note env `1.019 -> 1.019`, centroid `-193.3 -> -193.0 Hz`
  - `pitchTestOrg -> +4`: note mel `3.439 -> 3.439`, note env `0.621 -> 0.621`, centroid `-33.6 -> -33.6 Hz`
- Verdict:
  - effectively neutral
  - kept because it did not hurt anything, but it was too small to matter by itself

### Phase 2, Iteration 2 of 2: Upward short-note wet-cap bonus
- Hypothesis:
  - the stronger upward Stage B setting from Phase 1 helped the short `pitchOrg +4` note but hurt the longer `pitchTest +4` note, so the wet-cap bonus should apply only to short upward notes
- Change:
  - added an upward-only wet-cap bonus for shorter edited notes in the safer hybrid branch
- Result:
  - `pitchOrg -> +4`: note mel `8.411 -> 8.302`, note env `1.019 -> 1.019`, centroid `-193.3 -> -187.4 Hz`
  - `pitchTestOrg -> +4`: note mel `3.439 -> 3.439`, note env `0.621 -> 0.621`, centroid `-33.6 -> -33.6 Hz`
  - downward sanity check:
    - `pitchOrg -> -4` stayed `7.408 / 1.114 / 0.00 cents`
- Verdict:
  - kept
  - this is the first meaningful gain that improved the hard upward case without damaging the healthier clip family

### Phase 2 Status
- Outcome:
  - Phase 2 completed with one kept directional improvement
  - current baseline now includes the upward short-note wet-cap bonus
- Iterations remaining:
  - total remaining after Phase 2 completion: `4`
  - next phase to start: `Phase 3: Shoulder / Onset Protection Refinement`

### Phase 3, Iteration 1 of 2: Drier hybrid shoulders and stronger edge protection
- Hypothesis:
  - the safer hybrid still needed slightly more shoulder protection, especially at note boundaries, to reduce onset stress without undoing the Phase 2 timbre gain
- Change:
  - shortened audible shoulders for the hybrid branch
  - increased entry/exit protection lengths
  - lowered hybrid edge wet floors at note entry and exit
- Result:
  - `pitchOrg -> +4`: note mel `8.302 -> 8.297`, note env `1.019 -> 1.019`, centroid `-187.4 -> -189.3 Hz`, onset jump `+0.68 -> +0.65 dB`
  - `pitchTestOrg -> +4`: note mel `3.439 -> 3.454`, note env `0.621 -> 0.622`, centroid `-33.6 -> -39.1 Hz`
- Verdict:
  - kept only because the hard case improved slightly and onset moved in the right direction
  - not a strong win

### Phase 3, Iteration 2 of 2: Longer hybrid entry-side splice fade
- Hypothesis:
  - a longer entry-side splice fade might reduce the remaining note-start stress without changing the note core
- Change:
  - increased hybrid entry-side splice fade length only
- Result:
  - no measurable change relative to Phase 3 iteration 1 on either `pitchOrg +4` or `pitchTestOrg +4`
- Verdict:
  - no effect
  - the earlier Phase 3 iteration 1 state is the only part worth keeping

### Phase 3 Status
- Outcome:
  - Phase 3 completed without a meaningful onset-specific win
  - current baseline keeps the tiny improvement from Phase 3 iteration 1 only
- Iterations remaining:
  - total remaining after Phase 3 completion: `2`
  - next phase to start: `Phase 4: Harmonic-Relative Stage B`

### Phase 4, Iteration 1 of 2: More harmonic-focused upward hybrid weighting
- Hypothesis:
  - the hybrid upward path was still too broadband, so a more harmonic-focused envelope weight might move the result closer to the reference timbre
- Change:
  - reduced the broadband floor of the harmonic weighting for upward hybrid blocks
  - increased upward hybrid detail retention slightly
- Result:
  - `pitchOrg -> +4`: note mel `8.297 -> 8.303`, note env `1.019 -> 1.018`, centroid `-189.3 -> -190.6 Hz`
  - `pitchTestOrg -> +4`: note mel `3.454 -> 3.458`, note env `0.622 -> 0.616`, centroid `-39.1 -> -40.4 Hz`
- Verdict:
  - rejected as a meaningful direction
  - the change broadened in the wrong way and did not produce a real win

### Phase 4, Iteration 2 of 2: Narrower harmonic neighborhoods for upward hybrid blocks
- Hypothesis:
  - if the broadening was the problem, a narrower harmonic neighborhood might keep correction closer to true harmonics without washing across the note
- Change:
  - reverted the broader harmonic weighting from iteration 1
  - narrowed the harmonic-mask sigma for upward hybrid blocks
- Result:
  - `pitchOrg -> +4`: note mel `8.297 -> 8.299`, note env `1.019 -> 1.018`, centroid `-189.3 -> -189.7 Hz`
  - `pitchTestOrg -> +4`: note mel `3.454 -> 3.449`, note env `0.622 -> 0.620`, centroid `-39.1 -> -39.4 Hz`
- Verdict:
  - neutral
  - too small to count as a real Phase 4 win

### Phase 4 Status
- Outcome:
  - Phase 4 completed without a meaningful DSP-family breakthrough
  - the current frozen fallback baseline is still the safer hybrid family with:
    - corrected note-local `single` routing
    - short-note upward wet-cap bonus from Phase 2
    - tiny shoulder refinement from Phase 3
- Iterations remaining:
  - total remaining after Phase 4 completion: `0`
  - next state: `freeze fallback baseline and hand off unless a new plan is created`

## Decision Gates
- Continue on the current path only if:
  - pitch remains within `+/-5 cents`
  - no word cutoff or crackle returns
  - `pitchOrg +4` timbre improves materially by ear and metrics
  - preview remains under `1s`
- Freeze the current safer hybrid as fallback baseline if:
  - later phases fail to improve timbre materially
  - but the baseline still preserves pitch correctness, locality, and onset safety
- Escalate / hand off to another agent if:
  - all `8` remaining iterations are used
  - and the output is still clearly below the user reference by ear
  - especially if `pitchOrg +4` remains robotic/dark

## Failure / Handoff Plan
- When iterations reach `0`:
  - stop doing more parameter loops
  - freeze the best fallback baseline
  - hand off with:
    - current best baseline branch
    - harness commands
    - winning and losing metrics
    - dead ends not worth retrying first
    - open hypotheses for the next agent
- Handoff framing:
  - the product path is now functionally corrected
  - the remaining gap is mainly sonic realism, especially on upward note-local shifts
  - the next agent should start from the corrected note-local baseline, not the old broken path

## Bottom Line
- The biggest hidden bug was not just DSP quality; it was the mismatch between preview-style note-local rendering and the old `single` apply path.
- After fixing that, the project moved to a much safer baseline.
- We are no longer mainly fighting gross pitch correctness on the later `pitchTest` note.
- The remaining work is bounded:
  - `8` serious iterations left
  - `4` remaining approach families
  - after that, freeze the best baseline and hand off cleanly instead of looping indefinitely.

## Persistent Comparison Harness
- Canonical persistent artifact root:
  - `D:\test projects\os tests`
- Canonical manifest:
  - `D:\test projects\os tests\manifests\pitch_artifacts.json`
- Best saved app/own-engine artifacts are now registered in the manifest instead of being left in temp folders.
- New comparison tooling:
  - `tools/pitch_harness_common.ps1`
  - `tools/register-pitch-artifact.ps1`
  - `tools/pitch_spectrogram_compare.py`
  - `tools/run-pitch-output-comparison.ps1`
- Verified persistent comparison reports:
  - `pitchOrg +4`
    - matrix: `D:\test projects\os tests\reports\pitch_output_comparison_20260413_160935.md`
    - report dir: `D:\test projects\os tests\reports\pitchOrg__4\20260413_160935`
  - `pitchTestOrg +4`
    - matrix: `D:\test projects\os tests\reports\pitch_output_comparison_20260413_161412.md`
    - report dir: `D:\test projects\os tests\reports\pitchTestOrg__4\20260413_161412`
- Research-reference comparison is now handled explicitly by the harness:
  - if a research render is not registered in the manifest, the report records that as missing instead of silently skipping it
- Current comparison finding to keep in mind:
  - for the saved `+4` reports, the current `default` and `pitch_only_own_engine` candidates came out numerically identical in the stored comparison runs, so branch routing needs to be re-checked before treating those as meaningfully distinct outputs

## April 13 Reality-Check Follow-Through

### Truth Refresh
- Branch-truth and output-truth were re-verified through the real app path.
- Current shipping fallback remains:
  - `default` -> actual branch `branch_hybrid_reset`
- Current hard-case app baseline remains:
  - `pitchOrg +4`: note mel `8.299`, env `1.018`, cents `0.00`, pre/post-neighbor mel `8.017 / 4.235`, onset peak `+0.649 dB`, harmonic drift `0.523`
- Current downward app baseline remains:
  - `pitchOrg -4`: note mel `7.405`, env `1.094`, cents `0.00`, onset peak `+1.416 dB`, harmonic drift `0.469`
- Current guard-case app baseline remains:
  - `pitchTest +4`: note mel `3.449`, env `0.620`, cents `0.00`, pre/post-neighbor mel `15.956 / 19.285`

### Harness Upgrade: Stutter-Sensitive Metrics
- Added new onset artifact diagnostics to `tools/reference_audio_match.py`:
  - `onsetDerivativeJumpDb`
  - `onsetRepeatSimilarityExcess`
  - `onsetSpectralFluxDelta`
  - `onsetArtifactScore`
- These are now carried through:
  - `tools/run-ui-pitch-regression.ps1`
  - `tools/run-pitch-reality-check.ps1`
- Purpose:
  - make the stitched / repeated-attack / stutter-like onset failure visible in saved reports instead of relying only on broad entry-window metrics

### App Iteration A: Onset-Safe Splice Relocation
- Hypothesis:
  - anchoring the wet handoff later for upward notes would reduce the stitched/stutter feel at note start
- Change:
  - first tried voiced-onset-anchored handoff
  - then tried a small mandatory minimum delay for the upward wet ramp
- Result:
  - both variants produced no measurable output change on the real app path
  - `pitchOrg +4` stayed:
    - note mel `8.289`
    - env `1.017`
    - onset peak `+0.61 dB`
    - onset derivative / repeat / flux / artifact `+1.84 / 0.000 / +1.50 / +1.84`
  - `pitchTest +4` stayed:
    - note mel `3.481`
    - env `0.623`
    - onset derivative / repeat / flux / artifact `0.00 / 0.636 / +0.59 / +3.82`
- Verdict:
  - rejected
  - the current app-path onset problem is real, but this splice-only tweak was not strong enough to move the rendered output

### App Iteration B: Dedicated Downward App Law
- Hypothesis:
  - downward pitch shifts need their own low/mid/high envelope law and should not share the same timbre correction as upward shifts
- Change:
  - tested a downward-only hybrid Stage B weighting change:
    - stronger low-harmonic relocation
    - different air protection
    - lower downward detail preservation
- Result:
  - no meaningful win worth keeping
  - `pitchOrg -4` stayed effectively at baseline:
    - note mel `7.405`
    - env `1.094`
    - onset derivative / repeat / flux / artifact `+2.74 / 0.000 / +0.74 / +2.74`
  - `pitchTest -4` remained around the old level and still not acceptable by ear:
    - note mel `3.775`
    - env `1.062`
    - onset derivative / repeat / flux / artifact `0.00 / 0.607 / +1.00 / +3.64`
- Verdict:
  - rejected
  - the current app branch appears to be at its ceiling for these small downward-law pushes

### App-Path Status After Final Two Micro-Iterations
- Outcome:
  - the harness is now better at agreeing with the audible onset complaint
  - the two final app-path micro-iterations did not produce a keepable improvement
  - shipping app baseline remains the last kept `TA-6` shoulder-protection state
- App-path iterations left:
  - `0`
- Decision:
  - stop further micro-tuning on the current app branch
  - pivot active recovery to the own-engine / source-filter path for the next structural work

## Own-Engine Recovery Restart

### Own-Engine Baseline Before Restart
- Fresh own-engine truth runs showed:
  - `pitchOrg +4`
    - note mel `6.484`
    - env `1.302`
    - cents `+18.92`
    - harmonic drift `0.423`
    - onset artifact `1.76`
  - `pitchOrg -4`
    - note mel `7.307`
    - env `1.634`
    - cents `-46.79`
    - harmonic drift `0.320`
    - onset artifact `2.79`
- Working conclusion:
  - the own engine was already more promising than the shipping app on some timbre metrics
  - but it was still not trustworthy because pitch correctness had drifted again

### Own-Engine Iteration OE-R1: Upward Onset-Safe Wet Handoff
- Hypothesis:
  - the own-engine wet mask was handing too much synthesized content into the perceptual note onset, causing entry roughness and obscuring the core renderer quality
- Change:
  - for upward notes only, made the own-engine body entry much drier at the start of the note
  - added a short dry-hold inside the note body before the wet ramp rises
  - left downward onset handling unchanged
- Result:
  - `pitchOrg +4`
    - note mel `6.484 -> 6.530`
    - env `1.302 -> 1.356`
    - cents `+18.92 -> 0.00`
    - harmonic drift `0.423 -> 0.390`
    - centroid `-310.7 -> -279.2 Hz`
  - `pitchOrg -4`
    - note mel `7.307 -> 5.560`
    - env `1.634 -> 1.544`
    - cents `-46.79 -> +11.90`
    - harmonic drift `0.320 -> 0.176`
  - `pitchTest +4`
    - remained effectively unchanged:
      - note mel `9.072`
      - env `1.075`
      - core cents `-18.32`
  - `pitchTest -4`
    - stayed exact on pitch:
      - note mel `7.727`
      - env `1.049`
      - cents `0.00`
- Verdict:
  - kept as the new experimental own-engine baseline
  - this is the first structural own-engine iteration after the app-path stop point that materially improved both `pitchOrg +4` and `pitchOrg -4`
  - it still does not beat the shipping app on the `pitchTest` family, so it remains experimental only

### Own-Engine Iteration OE-R2: Stronger Long-Upward Source-Filter Correction
- Hypothesis:
  - `pitchTest +4` is a long upward note, so the own-engine source-filter correction for long bodies might simply be too weak and too broad
- Change:
  - increased long-upward local envelope correction strength
  - tightened the gain limits and high-band cap for long upward notes only
- Result:
  - `pitchTest +4`
    - stayed essentially unchanged:
      - note mel `9.070`
      - env `1.073`
      - core cents `-18.32`
      - onset artifact `4.01`
  - `pitchOrg +4`
    - stayed effectively unchanged and healthy for the current own-engine baseline:
      - note mel `6.520`
      - env `1.352`
      - cents `0.00`
- Verdict:
  - rejected
  - `pitchTest +4` is not mainly blocked by a simple long-upward correction-strength issue in the current source-filter step

### Own-Engine Iteration OE-R3: Long-Upward Drier Shoulders
- Hypothesis:
  - the long upward note in `pitchTest +4` might still be failing because too much synthesized signal is entering the body shoulders, not because the core timbre model is weak
- Change:
  - made long upward notes use a drier entry shoulder, longer exit protection, and lower outside-core wetness
- Result:
  - `pitchOrg +4`
    - improved onset-facing metrics a bit:
      - onset peak `+0.73 -> +0.49 dB`
      - onset artifact `1.76 -> 1.59`
      - pitch stayed exact
  - `pitchTest +4`
    - essentially unchanged:
      - note mel `9.070`
      - env `1.072`
      - onset artifact `3.99`
- Verdict:
  - rejected as the next baseline
  - useful for diagnosis because it showed `pitchTest +4` is not mainly a shoulder wetness problem

### Own-Engine Iteration OE-R4: Long-Upward Tighter Core Window
- Hypothesis:
  - if `pitchTest +4` is not a wet-mask problem, its synthesized core may still be too wide and invading phonetic shoulders before epoch rendering begins
- Change:
  - increased long-upward core entry/exit protection inside the shared analysis stage
- Result:
  - `pitchTest +4`
    - did not improve:
      - note mel `9.084`
      - env `1.079`
      - onset artifact `4.01`
  - `pitchOrg +4`
    - stayed unchanged and healthy relative to the current own-engine baseline
- Verdict:
  - rejected
  - `pitchTest +4` is not mainly blocked by a simple long-note core-window size issue

### Own-Engine Budget Status
- Used in the current structural own-engine cycle:
  - `4` bounded iterations
    - `OE-R1` kept
    - `OE-R2` rejected
    - `OE-R3` rejected
    - `OE-R4` rejected
- Remaining serious own-engine iterations in the current budget:
  - `2`
- Current best experimental own-engine baseline remains:
  - `OE-R1`: upward onset-safe wet handoff

### Own-Engine Iteration OE-R5: Long-Upward Epoch-Carrier Remap
- Hypothesis:
  - long upward notes may sound repetitive because extra target epochs are being matched to the nearest discrete source epoch instead of interpolating between source epochs
- Change:
  - for long upward notes only, interpolated the epoch carrier between adjacent source epochs instead of hard-rounding to one source epoch
- Result:
  - `pitchTest +4`
    - mixed:
      - note mel `9.085`
      - env `1.077`
      - harmonic drift improved to `0.221`
      - but onset/body quality did not improve enough
  - `pitchOrg +4`
    - unchanged and still exact
- Verdict:
  - rejected
  - useful because it confirmed the long-note upward miss is partly carrier-related, but not solved by epoch interpolation alone

### Own-Engine Iteration OE-R6: Long-Upward Harmonic-Carrier Split
- Hypothesis:
  - the long-note upward miss might need a different carrier family altogether; keep short-note upward and downward notes on the stronger path, but force long upward notes onto the harmonic core renderer
- Change:
  - long upward notes bypass the epoch carrier and use the harmonic carrier path instead
- Result:
  - `pitchTest +4`
    - first meaningful improvement on this clip family in this bounded cycle:
      - note mel `9.084 -> 8.785`
      - env `1.079 -> 1.045`
      - harmonic drift `0.290 -> 0.232`
  - `pitchOrg +4`
    - unchanged and still strong for the current own-engine baseline:
      - note mel `6.520`
      - env `1.352`
      - cents `0.00`
  - `pitchOrg -4`
    - unchanged
- Verdict:
  - kept
  - this becomes the new experimental own-engine baseline

### Own-Engine Final Budget Status
- Used in the current bounded structural own-engine cycle:
  - `6` serious iterations
    - kept:
      - `OE-R1`
      - `OE-R6`
    - rejected:
      - `OE-R2`
      - `OE-R3`
      - `OE-R4`
      - `OE-R5`
- Remaining serious own-engine iterations in the current budget:
  - `0`
- Current best experimental own-engine baseline is now:
  - `OE-R6`: long-upward harmonic-carrier split on top of the earlier upward onset-safe handoff

## April 13, 2026: Hybrid Structural Branch For `pitchTestOrg`

### Goal
- Start the next recovery cycle on the user-confirmed truth case:
  - original: `D:\test projects\pitchTestOrg.wav`
  - references:
    - `D:\test projects\pitchTestOrg+4s.wav`
    - `D:\test projects\pitchTestOrg-4s.wav`
- Freeze the current shipping app path as control and route new work into an explicit experimental branch:
  - `pitch_only_hybrid_structural`

### Harness / Branch Infrastructure
- Added explicit experimental branch routing:
  - requested / actual branch name:
    - `pitch_only_hybrid_structural`
- Updated the UI regression runner so this branch can be exercised through the same persistent app-path harness and reports.

### Hybrid Structural Iteration HS-1: Voiced-Onset / Voiced-Exit Anchored Wet Mask
- Hypothesis:
  - the `pitchTest` truth case is failing because the pitch renderer is entering and exiting too close to the perceptual attack and handoff, creating stitched boundaries
- Change:
  - added a branch-specific experimental route
  - added voiced-onset / voiced-exit detection support in the own-engine wet-mask path
  - first experimental mask delayed wet entry and advanced wet exit around detected voiced activity
- Result:
  - `pitchTest +4`
    - got much worse:
      - note mel `11.889`
      - env `1.620`
      - entry mel `15.982`
      - exit mel `12.982`
  - `pitchTest -4`
    - also underperformed the shipping control badly:
      - note mel `7.718`
      - env `1.044`
      - entry mel `10.380`
      - exit mel `14.244`
- Verdict:
  - rejected
  - diagnosis:
    - simply keeping the shoulder drier is not enough
    - on this truth case, the shoulder still needs pitch-rendered content rather than a long dry hold

### Hybrid Structural Iteration HS-2: Downward-Specific Source-Filter Law
- Hypothesis:
  - `pitchTest -4` is a true downward timbre problem and needs a separate branch-specific low/mid/high correction law
- Change:
  - added branch-specific downward source-filter parameters for:
    - correction strength
    - gain limits
    - local envelope blend
    - residual reinjection
- Result:
  - `pitchTest -4`
    - only tiny movement, still far from control:
      - note mel `7.727`
      - env `1.045`
      - exit mel `14.072`
  - `pitchTest +4`
    - regressed further:
      - note mel `12.181`
      - env `1.671`
      - entry mel `18.285`
- Verdict:
  - rejected
  - diagnosis:
    - a downward-specific law is necessary eventually
    - but not on top of the current failed shoulder/core handoff variant

### Isolation Cleanup
- The hybrid-structural behavior is now explicitly isolated to the `pitch_only_hybrid_structural` branch so the older own-engine route is not unintentionally affected by these failed experiments.

### Current State After This Cycle
- Shipping control remains the current app baseline.
- `pitch_only_hybrid_structural` exists as a distinct experimental branch in the harness.
- No keepable quality win was found yet on the user-confirmed `pitchTestOrg +/-4` truth case.
- Most important learning:
  - this clip family is not improved by a simple "drier shoulders" move
  - the next structural attempt must preserve more pitch-rendered content at the note entry while still making the splice behavior smoother

### Hybrid Structural Iteration HS-3: Short-Upward Blend Cap And Later Ramp
- Hypothesis:
  - on the hybrid branch, the short-upward own-engine blend was still too aggressive across the full core, so we were leaving performance on the table at the note attack and handoff
- Change:
  - kept the existing short-upward-only hybrid blend policy
  - increased entry/exit protection inside the hybrid blend mask:
    - entry `40 ms -> 50 ms`
    - exit `50 ms -> 60 ms`
  - capped own-engine contribution inside the short-upward core at `0.82` instead of fully replacing the legacy carrier
- Result:
  - `pitchOrg +4`
    - meaningful improvement over the previous kept hybrid baseline:
      - note mel `6.252 -> 6.214`
      - env `1.019 -> 0.966`
      - entry mel `7.429 -> 7.069`
      - exit mel `6.393 -> 6.076`
    - onset artifact rose only slightly:
      - `1.753 -> 1.796`
  - `pitchTest +4`
    - preserved exact shipping-control behavior by SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
  - `pitchTest -4`
    - preserved exact shipping-control behavior by SHA:
      - `1B6A789C4D36AB0D330CD043E41A72EB27B858120DF34B271293764A197F909C`
- Verdict:
  - kept
  - new experimental hybrid baseline
- Learning:
  - the hybrid branch is now doing the right thing structurally:
    - it stays pinned to the shipping control on the user-confirmed `pitchTest` truth case
    - while still allowing bounded short-upward improvements on `pitchOrg +4`
  - next short-upward work should improve onset smoothness without giving back the note-body gain

### Hybrid Structural Iteration HS-4: Softer Early-Core Short-Upward Blend
- Hypothesis:
  - the stitched feel is no longer coming from the fully dry attack itself, but from the first few milliseconds after the hybrid branch enters the rendered core
- Change:
  - left the hybrid branch pinned to shipping-control behavior for long and downward notes
  - within the short-upward path only:
    - kept the later `50 ms` entry and `60 ms` exit protection from `HS-3`
    - reduced the first `20 ms` of the rendered core to a lower own-engine blend cap (`0.62`) before ramping to the full short-upward cap (`0.82`)
- Result:
  - `pitchOrg +4`
    - another small but real gain over `HS-3`:
      - note mel `6.214 -> 6.202`
      - env `0.966 -> 0.964`
      - entry mel `7.069 -> 6.788`
      - harmonic drift `0.4001 -> 0.3997`
    - onset artifact did not improve yet:
      - `1.796 -> 1.840`
  - `pitchTest +4`
    - still preserved exact shipping-control behavior by SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - kept as the new experimental hybrid baseline
  - but with a caution flag:
    - this improved the short-upward note match again without touching the truth-case fallback
    - it did not solve the onset-artifact score, so the next step still needs to be onset-focused rather than more broad note-body tuning

### Hybrid Structural Iteration HS-5: Post-Core Legacy Hold
- Hypothesis:
  - the stitched onset might be caused by the hybrid branch entering the early rendered core too soon, so holding the very start of the core on the legacy carrier for a few extra milliseconds could reduce the splice artifact
- Change:
  - inserted an additional `8 ms` post-core legacy hold before the short-upward hybrid branch began ramping into the early-core own-engine blend
- Result:
  - `pitchOrg +4`
    - mixed and too small to keep:
      - note mel `6.202 -> 6.209` (worse)
      - env `0.964 -> 0.961` (better)
      - entry mel `6.788 -> 6.928` (worse)
      - onset artifact `1.841 -> 1.809` (slightly better)
  - `pitchTest +4`
    - still preserved exact shipping-control behavior by SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - reverted to `HS-4` baseline
- Learning:
  - delaying the rendered-core handoff later by itself is not enough
  - the remaining onset problem is probably about the transition shape between legacy and hybrid content, not simply "start later"

### Hybrid Structural Iteration HS-6: Onset-Side Blend Smoothing
- Hypothesis:
  - the remaining short-upward onset artifact might come from a derivative spike at the legacy/hybrid boundary, so a tiny post-blend smoothing pass over the first `12 ms` after hybrid entry could soften the splice without changing note-body behavior
- Change:
  - added an onset-only smoothing pass on the already-blended short-upward output, applied only over the first `12 ms` after the hybrid branch enters the short-upward rendered core
- Result:
  - `pitchOrg +4`
    - mixed and not good enough to keep:
      - note mel `6.202 -> 6.226` (worse)
      - env `0.964 -> 0.960` (better)
      - entry mel `6.788 -> 6.804` (worse)
      - onset artifact `1.841 -> 1.822` (slightly better)
      - harmonic drift `0.3997 -> 0.3948` (better)
  - `pitchTest +4`
    - still preserved exact shipping-control behavior by SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - reverted to `HS-4` baseline
- Learning:
  - onset-only waveform smoothing can shave a little off the artifact score, but it is too expensive in note match if applied this bluntly
  - the next onset fix likely needs a smarter transition law between legacy and hybrid content, not a generic local smoothing pass

### Hybrid Structural Iteration HS-7: Coherence-Aware Onset Weighting
- Hypothesis:
  - the onset artifact might come from the hybrid branch using too much own-engine signal in moments where the legacy and own waveforms disagree sharply, so early onset-side blend should be reduced only when the two signals are locally incoherent
- Change:
  - added a short-upward-only onset-focus mask over the first `18 ms` after hybrid core entry
  - inside that onset window only, modulated the hybrid blend by a local coherence score derived from:
    - slope agreement between legacy and own signals
    - instantaneous amplitude agreement
- Result:
  - `pitchOrg +4`
    - collapsed to the same mixed outcome as the prior rejected onset-law attempt:
      - note mel `6.202 -> 6.209` (worse)
      - env `0.964 -> 0.961` (better)
      - entry mel `6.788 -> 6.928` (worse)
      - onset artifact `1.841 -> 1.809` (slightly better)
  - `pitchTest +4`
    - still preserved exact shipping-control behavior by SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - reverted to `HS-4` baseline
- Learning:
  - a simple local coherence heuristic is still not changing the transition in the right way
  - the next real onset attempt likely needs to operate on the transition curve or phase relationship more fundamentally, not just attenuate the blend where mismatch is detected

### Hybrid Structural Iteration HS-8: Phase-Aligned Onset Bridge Scaffold
- Hypothesis:
  - the remaining stitched onset might come from a phase-misaligned handoff between legacy and hybrid content, so replacing the short-upward scalar onset law with a local aligned bridge could reduce the stutter without disturbing the proven guard-case fallback
- Change:
  - added hybrid onset-bridge scaffolding in `PitchResynthesizer.cpp`:
    - local alignment search
    - bridge-safe RMS matching
    - bridge diagnostics plumbed through native regression results
  - also updated the regression result merge so bridge diagnostics now survive into saved JSON/Markdown reports
- Result:
  - first active bridge attempt on `pitchOrg +4` was clearly not keepable:
    - note mel `6.202 -> 6.392` (worse)
    - env `0.964 -> 1.006` (worse)
    - entry mel `6.788 -> 9.951` (much worse)
    - onset artifact `1.841 -> 1.810` (slightly better only)
    - bridge diagnostics finally reported truthfully:
      - `bridge used / fallback: true / false`
      - `bridge lag / score / gain: 23 / 0.759 / -1.5 dB`
  - `pitchTest +4`
    - stayed pinned to shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected as an active renderer change
  - bridge activation is now disabled again, while the diagnostics plumbing stays in the repo
  - active experimental baseline restored to the last known-good `HS-4 / r6` behavior
- Reconfirmed active baseline after disabling bridge activation:
  - `pitchOrg +4`
    - note mel `6.209`
    - env `0.961`
    - entry mel `6.928`
    - onset artifact `1.810`
    - `bridge used / fallback: false / true`
  - `pitchTest +4`
    - unchanged shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Learning:
  - explicit onset-bridge diagnostics were worth adding
  - the first bridge formulation confirmed the real problem is not “whether to align,” but “how to enter the aligned content without blowing up entry match”
  - the next viable onset attempt should not replace the whole onset blend law at once; it should treat alignment as a constrained adjustment inside the already-good `r6` blend family

### Hybrid Structural Iteration HS-9: Constrained Onset Alignment Assist
- Hypothesis:
  - a full onset bridge was too aggressive, but a tiny alignment-only assist inside the existing `r6` early-core ramp might improve the stitched feel without disturbing the proven body/guard-case behavior
- Change:
  - tried using local onset alignment only as a helper inside the existing short-upward `r6` blend law, rather than replacing that law
- Result:
  - after rebuilding cleanly, the constrained assist was a true no-op:
    - `pitchOrg +4`
      - note mel stayed `6.209`
      - env stayed `0.961`
      - entry mel stayed `6.928`
      - onset artifact stayed `1.810`
    - `pitchTest +4`
      - still preserved exact shipping-control SHA:
        - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - cleaned back out so the branch stays on the real `HS-4 / r6` baseline
- Learning:
  - the current onset issue is not being solved by small alignment assists layered onto the existing short-upward ramp
  - the next meaningful improvement will likely need a different short-upward transition model entirely, not another tiny variant of the same ramp

### Hybrid Structural Iteration HS-10: Four-Zone Short-Upward Transition Scaffold
- Hypothesis:
  - replacing the old short-upward scalar ramp with an explicit four-zone onset/exit model might improve the stitched feel without touching long notes or downward notes
- Change:
  - replaced the short-upward `r6` ramp with a four-zone model:
    - dry shoulder
    - transition pre-core
    - stabilized early-core
    - separate exit taper
  - kept bridge rendering disabled and kept `pitchTest +4` on the same long-note fallback route
- Result:
  - `pitchOrg +4`
    - not keepable:
      - note mel stayed flat at `6.209`
      - env worsened `0.961 -> 0.963`
      - entry mel worsened `6.928 -> 7.019`
      - exit mel worsened `6.076 -> 6.310`
      - onset artifact worsened `1.810 -> 1.840`
  - `pitchTest +4`
    - remained unchanged on the shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
- Learning:
  - the first explicit transition-model scaffold was too dry at the start and too weak at the handoff back out
  - simply breaking the ramp into named zones did not improve the actual onset problem

### Hybrid Structural Iteration HS-11: Onset-Confidence Preset Tables
- Hypothesis:
  - the new short-upward transition model might need different preset tables based on onset strength, with shorter/softer notes entering the hybrid content earlier than the default table
- Change:
  - added internal `high / medium / soft` onset classification
  - then tried a soft-biased preset for short, non-spiky upward notes
- Result:
  - `pitchOrg +4`
    - the first classifier pass stayed on the same losing table as HS-10
    - after biasing short notes toward the soft table, the result still got worse:
      - note mel `6.209 -> 6.215`
      - env `0.961 -> 0.974`
      - entry mel `6.928 -> 7.140`
      - exit mel `6.076 -> 6.306`
      - onset artifact `1.810 -> 1.840`
  - `pitchTest +4`
    - still remained pinned to the same shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - reverted fully back to the trusted `HS-4 / r6` short-upward blend
- Reconfirmed active baseline after the revert:
  - `pitchOrg +4`
    - note mel `6.209`
    - env `0.961`
    - entry mel `6.928`
    - onset artifact `1.810`
    - output SHA `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
- Learning:
  - short-upward onset strength tables still do not rescue the current scalar-ramp family
  - the next meaningful transition-model attempt probably needs a different render structure, not another preset table layered onto the same blend shape

### Hybrid Structural Iteration HS-12: Short-Upward Exit Handoff
- Hypothesis:
  - the remaining miss on the short-upward hybrid path might be more about the note exit than the note entry, so handing back to the legacy renderer earlier and drier near note end could reduce exit damage without touching the frozen `pitchTest +4` fallback
- Change:
  - changed the short-upward exit portion of the hybrid blend only:
    - start the handoff back to legacy earlier
    - cap the exit region to a lower own-engine weight
    - leave the onset side and long/downward behavior unchanged
- Result:
  - `pitchOrg +4`
    - clearly not keepable:
      - note mel `6.209 -> 6.214`
      - env `0.961 -> 0.973`
      - exit mel `6.076 -> 6.350`
      - exit env `1.198 -> 1.306`
      - onset artifact stayed effectively flat at `1.81`
  - `pitchTest +4`
    - remained pinned to the same shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - reverted back to the trusted `HS-4 / r6` short-upward baseline
- Learning:
  - the current short-upward family is not mainly being held back by an exit-only taper problem
  - onset, exit, and body behavior are still coupled tightly enough that taper-only changes keep degrading the note before they help the splice

### Hybrid Structural Iteration HS-13: Plateau-Style Core Takeover
- Hypothesis:
  - the current `r6` family may be plateaued because it still behaves like a long scalar ramp, so a structurally different short-upward model with a dry shoulder, fast equal-power entry, steady plateau, and explicit fade-out might break through that ceiling
- Change:
  - replaced the short-upward scalar-style blend with a plateau takeover:
    - dry shoulder
    - fixed equal-power fade into full own-engine plateau
    - fixed equal-power fade back out near note end
  - left long-note and downward behavior untouched
- Result:
  - `pitchOrg +4`
    - clearly worse than the trusted `r6` baseline:
      - note mel `6.209 -> 6.228`
      - env `0.961 -> 0.977`
      - entry mel `6.928 -> 7.498`
      - exit mel `6.076 -> 6.312`
      - onset artifact `1.807 -> 1.840`
  - `pitchTest +4`
    - stayed pinned to the same shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected
  - reverted back to the trusted `HS-4 / r6` baseline
- Learning:
  - even a structurally different plateau takeover still made the short-upward note worse
  - the next step is no longer another transition law; it needs a different short-upward render structure than legacy/own scalar blending entirely

### Structural Recovery Cycle: Attack-Preserve Body Replacement
- Goal:
  - stop iterating on whole-note legacy/own blend masks and test a true short-upward structural replacement:
    - dry attack
    - stable voiced entry lock
    - rendered body
    - dry exit
  - keep `pitchOrg +4` and `pitchTest +4` as equal-weight primary targets
  - hard-stop any structural path after `2` bounded iterations if it still does not produce a keepable win
- Infrastructure kept:
  - added persistent body-replacement diagnostics to the native regression result and saved summaries:
    - `bodyReplacementUsed`
    - `bodyReplacementFallbackUsed`
    - `entryLockStartSec`
    - `entryLockLengthMs`
    - `exitLockStartSec`
    - `renderedBodyStartSec`
    - `renderedBodyEndSec`

#### Path A, Iteration 1: Dry Attack + Existing Own-Engine Body
- Change:
  - replaced the short-upward note body with the current own-engine body only between a deterministic voiced entry lock and exit lock
  - preserved dry attack and dry exit outside that span
- Result:
  - `pitchOrg +4`
    - onset artifact improved:
      - `1.810 -> 1.603`
    - but the note became materially worse overall:
      - note mel `6.209 -> 6.282`
      - env `0.961 -> 1.036`
      - entry mel `6.928 -> 7.759`
      - exit mel `6.076 -> 6.517`
      - whole-note cents `0.00 -> -18.32`
  - `pitchTest +4`
    - stayed flat on the same shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Verdict:
  - rejected after `1` iteration
  - no equal-weight win, and the non-changing `pitchTest +4` meant Path A did not justify a second try
- Learning:
  - removing attack-region blending alone is not enough if the rendered body entering after the lock is still structurally mismatched

#### Path B, Iteration 1: Dry Attack + Epoch-Anchored Body
- Change:
  - kept the same entry/exit locks
  - replaced the inserted body with an epoch-anchored overlap-add body synthesized from the stable voiced region
- Result:
  - `pitchOrg +4`
    - large body improvements:
      - note mel `6.209 -> 5.418`
      - env `0.961 -> 0.616`
      - entry mel `6.928 -> 5.250`
      - exit mel `6.076 -> 5.636`
      - formant drift `0.400 -> 0.126`
    - but onset collapsed badly:
      - onset artifact `1.810 -> 4.360`
      - whole-note cents `0.00 -> +37.23`
  - `pitchTest +4`
    - still stayed flat on the same shipping-control SHA
- Verdict:
  - promising but not keepable
  - advanced to a second and final bounded iteration

#### Path B, Iteration 2: Later, Longer Entry Lock
- Change:
  - started the epoch body later and lengthened the entry crossfade to keep more of the original attack dry
- Result:
  - `pitchOrg +4`
    - onset improved slightly versus Path B iteration 1:
      - onset artifact `4.360 -> 4.040`
    - but it was still far worse than the kept `r6` baseline
    - entry also regressed again:
      - entry mel `5.250 -> 7.219`
  - `pitchTest +4`
    - still stayed flat on the same shipping-control SHA
- Verdict:
  - rejected
  - Path B exhausted its `2`-iteration budget and did not produce a keepable equal-weight win
- Learning:
  - an epoch-anchored body can improve note-core realism, but on this path the onset splice became much worse than the baseline
  - the body renderer and the onset handoff are still too tightly coupled here

#### Path C, Iteration 1: Dry Attack + Harmonic Body
- Change:
  - attempted a coherent harmonic-envelope body replacement instead of grain copying
- Result:
  - the harmonic body never engaged on `pitchOrg +4`
  - render failed closed back to the `r6` baseline:
    - note mel `6.209`
    - env `0.961`
    - onset artifact `1.810`
    - output SHA `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
- Verdict:
  - inconclusive first try
  - moved to a second and final iteration so the harmonic path could engage deterministically

#### Path C, Iteration 2: Static Spectral-Envelope Harmonic Body
- Change:
  - added a static spectral-envelope fallback so the harmonic body would still render when frame-level harmonic tracks were too sparse
- Result:
  - `pitchOrg +4`
    - catastrophic failure:
      - note mel `6.209 -> 19.738`
      - env `0.961 -> 4.495`
      - whole-note cents `0.00 -> -762.28`
      - entry mel `6.928 -> 25.128`
      - exit mel `6.076 -> 28.915`
      - harmonic drift `0.400 -> 1.818`
  - `pitchTest +4`
    - still stayed flat on the same shipping-control SHA
- Verdict:
  - rejected immediately
  - Path C exhausted its `2`-iteration budget
- Learning:
  - the current harmonic-only fallback is not viable as a body renderer in this product path

#### Baseline Restore After Structural Cycle
- Action:
  - restored the experimental hybrid branch to the last trusted `HS-4 / r6` behavior while keeping the new body-replacement diagnostics infrastructure
- Reconfirmed baseline:
  - `pitchOrg +4`
    - note mel `6.209`
    - env `0.961`
    - entry mel `6.928`
    - exit mel `6.076`
    - onset artifact `1.810`
    - output SHA `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
  - `pitchTest +4`
    - output SHA `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
- Structural-cycle conclusion:
  - Path A: rejected after `1/2`
  - Path B: rejected after `2/2`
  - Path C: rejected after `2/2`
  - no structural path beat the trusted `r6` baseline on both equal-weight targets
  - the renderer is back on the safe baseline, and the repo now contains full diagnostics for why each body-replacement path failed
  - the next step is no longer “another transition law”; it needs a different short-upward render structure than legacy/own scalar blending entirely
### 2026-04-14: Path D, Voiced-Entry-Locked PSOLA Body

#### Path D, Iteration 1: Fixed-Threshold PSOLA Body
- Change:
  - added a short-upward-only voiced-entry-locked TD-PSOLA body path inside the hybrid renderer
  - kept long upward and all downward notes on the existing fallback path
  - required stable voiced entry, stable voiced exit, at least `5` usable source epochs, and equal-power dry-attack/body/dry-exit splices
- Result:
  - `pitchOrg +4`
    - strong body improvement versus the `r6` baseline:
      - note mel `6.209 -> 5.147`
      - env `0.961 -> 0.488`
      - entry mel `6.928 -> 5.607`
      - exit mel `6.076 -> 5.482`
      - harmonic drift `0.400 -> 0.146`
    - but onset collapsed badly:
      - onset artifact `1.810 -> 4.400`
      - onset derivative `+1.81 -> +2.89`
      - onset flux `+1.48 -> +4.40`
  - `pitchTest +4`
    - stayed pinned to the shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
    - body replacement did not engage on this clip
- Verdict:
  - promising but not keepable
  - advanced to a second and final bounded iteration because the note-body metrics improved materially while the guard case stayed flat

#### Path D, Iteration 2: Earlier Lock, Longer Entry Fade, Drier Tail
- Change:
  - tuned only the allowed PSOLA parameters:
    - voiced threshold `0.65 -> 0.60`
    - entry sustain `12 ms -> 10 ms`
    - entry fade `10 ms -> 12 ms`
    - dry exit tail `20 ms -> 24 ms`
- Result:
  - `pitchOrg +4`
    - body stayed clearly improved versus baseline:
      - note mel `6.209 -> 5.105`
      - env `0.961 -> 0.474`
      - exit mel `6.076 -> 5.383`
      - harmonic drift `0.400 -> 0.127`
    - onset improved slightly versus Path D iteration 1, but was still much worse than `r6`:
      - onset artifact `4.400 -> 3.620`
      - entry mel `5.607 -> 6.093`
      - still far above baseline onset artifact `1.810`
  - `pitchTest +4`
    - still stayed pinned to the same shipping-control SHA
    - body replacement still did not engage
- Verdict:
  - rejected
  - Path D exhausted its `2`-iteration budget without beating the equal-weight gate
- Learning:
  - voiced-entry-locked PSOLA can produce the best note-body match seen so far on `pitchOrg +4`
  - but in this architecture the onset handoff is still too destructive, and the path does not generalize to `pitchTest +4`

#### Baseline Restore After Path D
- Action:
  - restored the active renderer to the trusted `HS-4 / r6` baseline by disabling the PSOLA body path while keeping the diagnostics scaffolding in place
- Reconfirmed baseline:
  - `pitchOrg +4`
    - note mel `6.209`
    - env `0.961`
    - entry mel `6.928`
    - exit mel `6.076`
    - onset artifact `1.810`
    - output SHA `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
    - body replacement used/fallback `false / true`
  - `pitchTest +4`
    - note mel `3.481`
    - env `0.623`
    - entry mel `2.484`
    - exit mel `7.662`
    - onset artifact `3.819`
    - output SHA `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
    - body replacement used/fallback `false / false`
- Path D conclusion:
  - exhausted after `2/2`
  - improved note-body fidelity on `pitchOrg +4` more than the prior structural paths
  - still failed the gate because onset quality remained substantially worse than the trusted baseline
### 2026-04-14: Path F, Island-Native Renderer With Transient-Preserve Core

#### Path F, Iteration 1: Fixed-Mask Island-Native Render
- Change:
  - added a new experimental branch `pitch_only_island_native`
  - rendered short upward note islands as one internal object instead of doing an internal body handoff
  - used transient-preserve onset and exit bands from the original signal plus an own-engine voiced-core render, with only outer-island splices
  - added island-native diagnostics to the native regression result and saved summaries
- Result:
  - `pitchOrg +4`
    - the path engaged successfully:
      - island native used/fallback `true / false`
      - island render span `0.08 -> 0.8300 s`
      - transient/core mask peak `1.000 / 0.996`
    - onset improved materially versus the `r6` baseline:
      - onset artifact `1.810 -> 1.388`
    - but note and boundary quality regressed too much:
      - note mel `6.209 -> 7.746`
      - env `0.961 -> 1.479`
      - entry mel `6.928 -> 10.191`
      - exit mel `6.076 -> 8.275`
  - `pitchTest +4`
    - stayed pinned to the shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
    - island-native path did not engage on this clip:
      - island native used/fallback `false / false`
- Verdict:
  - promising enough for one final bounded tuning pass
  - advanced to Iteration 2 because onset improved substantially on the active target while the equal-weight guard stayed flat

#### Path F, Iteration 2: Lower Voiced-Core Threshold
- Change:
  - applied the plan's only allowed F2 adjustment for the observed failure mode:
    - lowered voiced-core threshold `0.65 -> 0.60`
  - left onset hold, exit hold, and outer splice lengths unchanged
- Result:
  - `pitchOrg +4`
    - island-native stayed engaged:
      - island native used/fallback `true / false`
      - island render span `0.08 -> 0.8300 s`
      - transient/core mask peak `1.000 / 0.996`
    - improved a little versus Path F iteration 1, but still clearly lost to baseline:
      - note mel `7.746 -> 7.511`
      - env `1.479 -> 1.420`
      - entry mel `10.191 -> 9.818`
      - exit mel `8.275 -> 7.915`
      - onset artifact stayed improved versus baseline:
        - `1.810 -> 1.388`
    - still failed the equal-weight gate because body and boundary regressions remained far beyond tolerance
  - `pitchTest +4`
    - still pinned to the same shipping-control SHA
    - island-native path still did not engage
- Verdict:
  - rejected
  - Path F exhausted its `2`-iteration budget without beating the trusted `r6` baseline
- Learning:
  - eliminating the internal renderer handoff can improve the onset metric on `pitchOrg +4`
  - but this fixed-mask island-native model still damages note body and entry/exit too much
  - the path also does not generalize to `pitchTest +4`, because it never activates there under the current gating

#### Path F Conclusion
- Status:
  - exhausted after `2/2`
  - not promoted
  - shipping fallback and active trusted experimental baseline remain unchanged
- Current trusted live baseline remains:
  - `pitchOrg +4`
    - note mel `6.209`
    - env `0.961`
    - entry mel `6.928`
    - exit mel `6.076`
    - onset artifact `1.810`
    - output SHA `055B3300041A8B5DE93C462C7E18F180BF7740D0134B0C05B6D255A6A36B46BD`
  - `pitchTest +4`
    - note mel `3.481`
    - env `0.623`
    - entry mel `2.484`
    - exit mel `7.662`
    - onset artifact `3.819`
    - output SHA `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
### 2026-04-14: Path G, Adaptive Island-Native PSOLA-Core

#### Path G, Iteration 1: Fixed-Threshold Island Shell + PSOLA Core
- Change:
  - added a new experimental branch `pitch_only_island_native_psola`
  - kept the Path F island-native shell and outer-only splice policy
  - replaced the island voiced-core source with a PSOLA core synthesized only from stable voiced epochs inside the island
  - added one relaxed engagement retry for `pitchTest`-type clips:
    - voiced threshold `0.55`
    - sustain `8 ms`
  - left long upward and all downward notes on fallback behavior
- Result:
  - `pitchOrg +4`
    - branch engaged successfully:
      - island native used/fallback `true / false`
      - island render span `0.08 -> 0.8300 s`
      - transient/core mask peak `1.000 / 0.996`
    - onset stayed improved versus the trusted `r6` baseline:
      - onset artifact `1.810 -> 1.388`
    - but note and boundary quality regressed even harder than the fixed-mask own-engine-core island path:
      - note mel `6.209 -> 8.053`
      - env `0.961 -> 1.608`
      - entry mel `6.928 -> 11.972`
      - exit mel `6.076 -> 16.651`
      - note cents `0.00 -> +18.52`
  - `pitchTest +4`
    - stayed pinned to the same shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
    - the relaxed engagement retry still did not activate the path:
      - island native used/fallback `false / false`
- Verdict:
  - rejected after `1/2`
  - the path failed the equal-weight gate immediately, so no G2 tuning pass was allowed
- Learning:
  - combining the Path F shell with a PSOLA core preserved the onset-side gain on `pitchOrg +4`
  - but the PSOLA core destabilized pitch/body/exit inside the island
  - the path still does not generalize to `pitchTest +4`, even with the relaxed engagement retry

#### Path G Conclusion
- Status:
  - stopped after `1/2` under the stop-fast rule
  - not promoted
  - shipping fallback and trusted `HS-4 / r6` experimental baseline remain unchanged
### 2026-04-15: Family `FAM-V2-HSR`, Engine V2 Harmonic/Source-Filter + Residual Shell

#### Iteration 1: `pitch_only_engine_v2`
- Change:
  - added a temporary `pitch_only_engine_v2` branch
  - reused the island-native shell for short upward notes only
  - replaced the fixed own-engine core with an explicit v2 composition:
    - original transient-preserve shell
    - own-engine harmonic/source-filter core
    - explicit residual layer from the island residual model
  - kept long upward and all downward behavior on fallback
- Result:
  - `pitchOrg +4`
    - onset stayed improved versus `r6`:
      - onset artifact `1.810 -> 1.388`
    - but the note and boundaries regressed clearly:
      - note mel `6.209 -> 7.975`
      - env `0.961 -> 1.454`
      - entry mel `6.928 -> 9.737`
      - exit mel `6.076 -> 12.703`
      - note cents `0.00 -> -18.32`
  - `pitchTest +4`
    - stayed pinned to the same shipping-control SHA:
      - `1A9B12D8EA57EFEAC7B3505735BC9D4DA5F666D98703DA1333549314719CC043`
    - the branch still did not engage on this clip
- Verdict:
  - rejected after `1/2`
  - it failed the equal-weight gate decisively, so it did not earn a second iteration
- Cleanup:
  - removed the temporary `pitch_only_engine_v2` branch code immediately after the reject
- Learning:
  - adding an explicit residual layer to the island-native shell did not solve the onset/body tradeoff
  - the family preserved the onset-side gain seen in prior island-native attempts
  - but it still could not preserve note body or generalize to `pitchTest +4`

### 2026-04-16: Stopped-Transport Scrub Preview Fix + `engine-v2` Tuning R7

#### Scrub Preview Audibility
- Change:
  - moved the RAM scrub loop out of the transport-gated clip playback path
  - added a dedicated preview voice rendered directly from the main audio callback
  - added start/stop ramps and native status counters for scrub regression
  - added a dedicated scrub regression runner:
    - `tools/run-ui-pitch-scrub-regression.ps1`
- Result:
  - run: `20260416_153028_pitchOrg_scrub_preview_r2`
  - stopped-transport scrub preview is now measurably active:
    - `scrubPreviewAudible=true`
    - start latency `27.9 ms`
    - stop latency `27.5 ms`
    - mixed callback count `3`
    - mixed sample count `3072`
    - last peak `0.0005417`
- Verdict:
  - structural scrub-audibility blocker fixed
  - still needs user audition in the real editor path, but the old “silent while stopped” wiring gap is no longer hidden

#### Render Tuning R7
- Change:
  - kept `pitch_only_engine_v2_program` active
  - made the cepstral lifter F0-adaptive
  - raised overlap inside the envelope-restore stage
  - tightened transient ownership and shifted entry focus earlier
  - widened the transition lead/tail slightly while keeping the adaptive carrier underneath
  - added boundary timing metrics to the comparison script:
    - `entryLagMs`
    - `exitLagMs`
    - `onsetDelayMs`
    - `boundaryTimingErrorMs`
- Result:
  - `pitchOrg +4`
    - run: `20260416_152736_pitchOrg_plus4_note_hq_engine_v2_tune_r7`
    - note mel `7.314`
    - env `1.347`
    - entry mel `7.396`
    - exit mel `7.027`
    - onset artifact `1.388`
    - formant body harmonic drift `0.415`
  - `pitchTestOrg +4`
    - run: `20260416_152736_pitchTestOrg_plus4_note_hq_engine_v2_tune_r7`
    - note mel `3.540`
    - env `0.521`
    - entry mel `7.513`
    - exit mel `1.632`
    - onset artifact `4.013`
    - onset delay `1.479 ms`
    - formant body harmonic drift `0.069`
  - fresh adaptive controls:
    - `pitchOrg +4`: `20260416_153028_pitchOrg_plus4_note_hq_adaptive_cmp_r3`
      - note mel `7.085`
      - entry mel `7.078`
      - onset artifact `1.803`
      - harmonic drift `0.369`
    - `pitchTestOrg +4`: `20260416_153028_pitchTestOrg_plus4_note_hq_adaptive_cmp_r3`
      - note mel `2.810`
      - entry mel `1.530`
      - onset artifact `0.705`
      - harmonic drift `0.066`
- Verdict:
  - the tuned `engine-v2` path is now safer on the easy clip than the earlier catastrophic versions
  - but it still loses clearly to `pitch_only_adaptive_selector` on the hard note-entry case
  - the current repo truth remains:
    - adaptive is still the audible winner
    - scrub preview audibility is structurally fixed
    - boundary/formant tuning still needs more work

### 2026-04-16: Harness Close-Out Progress, Scrub Suite + Transient/Formant Smoke Suites

#### Multi-scenario scrub suite
- Change:
  - extended the scrub regression job to accept:
    - repeated drag cycles
    - optional transport play/stop cycle before scrub
  - added `tools/run-ui-pitch-scrub-suite.ps1`
  - isolated suite outputs into their own `case_runs` directory to avoid cross-run collisions
- Result:
  - run: `20260416_205833_pitchOrg_scrub_suite_smoke_r3`
  - case summary:
    - `first_drag`
      - audible `true`
      - first-drag audible `true`
      - start / stop latency `26.8 / 26.7 ms`
    - `repeated_drag`
      - audible `true`
      - first-drag audible `true`
      - start / stop latency `27.0 / 26.3 ms`
      - scenario count recorded as `3`
    - `after_transport_cycle`
      - audible `true`
      - first-drag audible `true`
      - start / stop latency `27.5 / 26.4 ms`
      - scenario count recorded as `2`
- Verdict:
  - scrub harness coverage is now broader than the old single happy-path run
  - but `H1` is still only partial because:
    - selection-change scrub is not yet covered
    - per-scenario pass breakdown is not fully propagated into the result JSON
    - the audible “breaking loop” complaint is still a listening issue, not a solved benchmark issue

#### Transient and formant suite harnesses
- Change:
  - added a manifest-driven suite runner:
    - `tools/run-ui-pitch-regression-suite.ps1`
  - added wrappers:
    - `tools/run-ui-pitch-transient-suite.ps1`
    - `tools/run-ui-pitch-formant-suite.ps1`
  - added smoke manifests:
    - `tests/fixtures/pitch-regression/suites/transient_smoke_suite.json`
    - `tests/fixtures/pitch-regression/suites/formant_smoke_suite.json`
  - fixed suite output collisions by isolating per-suite `case_runs`
- Result:
  - transient smoke run: `20260416_205335_transient_suite_smoke_r3`
    - `pitchOrg +4`
      - note mel `6.671`
      - onset artifact `1.825`
      - entry / exit artifact `6.918 / 7.138`
      - onset delay `-0.104 ms`
      - boundary timing error `8.417 ms`
      - formant drift `0.374`
    - `pitchTestOrg +4`
      - note mel `2.802`
      - onset artifact `2.051`
      - entry / exit artifact `1.489 / 1.627`
      - onset delay `-0.625 ms`
      - boundary timing error `0.958 ms`
      - formant drift `0.050`
  - formant smoke run: `20260416_205335_formant_suite_smoke_r3`
    - same canonical smoke cases now flow through a dedicated formant-focused suite wrapper and summary
- Verdict:
  - `H3` and `H4` harness plumbing now exist and run cleanly
  - but they are still only partial because the repo does not yet contain the full transient/formant fixture set from the plan

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `14`
- Remaining conditional iterations: `+2`

### 2026-04-16: Adaptive Carrier Boundary/Formant Correction Pass R2

#### Adaptive selector correction-layer pass
- Change:
  - kept `pitch_only_adaptive_selector` as the carrier
  - added a narrow adaptive boundary-correction layer in `PitchResynthesizer.cpp`
  - applied transient/unvoiced bypass, cepstral envelope restore, and residual carry only inside note entry/exit windows
  - exposed correction diagnostics through the existing render summary so the run proves whether the path actually engaged
- Result:
  - suite run: `20260416_210838_adaptive_boundary_tune_r2`
  - `pitchOrg +4`
    - note mel `6.548`
    - env `1.044`
    - entry mel `7.383`
    - exit mel `7.007`
    - onset artifact `3.259`
    - boundary timing error `8.417 ms`
    - formant drift `0.372`
    - `spectralEnvelopeCorrectionUsed=true`
  - `pitchTestOrg +4`
    - note mel `3.029`
    - env `0.511`
    - entry mel `1.993`
    - exit mel `5.269`
    - onset artifact `0.824`
    - boundary timing error `5.458 ms`
    - formant drift `0.038`
    - `spectralEnvelopeCorrectionUsed=true`
  - comparison against the prior adaptive smoke baseline:
    - `pitchOrg +4`
      - slightly better note mel/env
      - much worse onset artifact
      - entry slightly worse
      - exit slightly better
    - `pitchTestOrg +4`
      - onset artifact improved sharply
      - formant proxy improved slightly
      - note mel/env regressed
      - exit and boundary timing regressed badly
- Verdict:
  - this pass is real and engaged; it is not another stale-binary false read
  - it is still not keepable in its current shape
  - the failure pattern says the next adaptive-carrier work should focus on:
    - `A3` transient handoff crossfade sweep
    - `A4` entry timing compensation
    - `A5` F0-adaptive cepstral lifter retune

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `13`
- Remaining conditional iterations: `+2`

### 2026-04-16: Adaptive Carrier Boundary/Formant Correction Pass R3

#### Adaptive selector correction-layer retune
- Change:
  - kept the adaptive carrier correction path active
  - split entry vs exit defaults so note exit ownership is much lighter than note entry
  - widened the outer correction crossfade, pushed entry focus slightly earlier, and reduced correction wetness near the raw boundary
- Result:
  - suite run: `20260416_211448_adaptive_boundary_tune_r3`
  - `pitchOrg +4`
    - note mel `6.537`
    - env `1.040`
    - entry mel `7.435`
    - exit mel `7.028`
    - onset artifact `2.383`
    - boundary timing error `8.396 ms`
    - formant drift `0.373`
    - `spectralEnvelopeCorrectionUsed=true`
  - `pitchTestOrg +4`
    - note mel `2.960`
    - env `0.493`
    - entry mel `1.876`
    - exit mel `4.067`
    - onset artifact `1.540`
    - boundary timing error `2.250 ms`
    - formant drift `0.039`
    - `spectralEnvelopeCorrectionUsed=true`
  - comparison against `r2`:
    - `pitchOrg +4`
      - note mel/env improved slightly
      - onset artifact improved sharply
      - entry stayed a little worse than the pre-correction baseline
    - `pitchTestOrg +4`
      - note mel/env/entry/exit all improved versus `r2`
      - boundary timing also improved strongly
      - but exit and boundary timing still remain materially worse than the original adaptive baseline
- Verdict:
  - `r3` is a real improvement over `r2`
  - it is still not the fix:
    - the easy clip still has too much onset damage
    - the hard clip still has too much exit damage
  - the next honest priorities remain:
    - `A3` transient handoff crossfade sweep
    - `A4` entry timing compensation
    - `A5` cepstral lifter retune

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `12`
- Remaining conditional iterations: `+2`

### 2026-04-16: Adaptive Carrier Boundary/Formant Correction Pass R5

#### Adaptive selector compromise profile
- Change:
  - kept the adaptive carrier correction path active
  - tuned toward a compromise profile after the `r4` onset-safe and exit-safe sweeps:
    - lower flatness center and slightly higher RMS gate
    - shorter entry crossfade
    - earlier entry bias
    - lighter entry and exit wetness
    - lighter residual carry
  - promoted this profile into the default code path because it is the best adaptive correction run so far
- Result:
  - suite run: `20260416_212441_adaptive_boundary_tune_r5_compromise`
  - `pitchOrg +4`
    - note mel `6.533`
    - env `1.039`
    - entry mel `7.462`
    - exit mel `7.044`
    - onset artifact `2.261`
    - boundary timing error `8.396 ms`
    - formant drift `0.373`
    - `spectralEnvelopeCorrectionUsed=true`
  - `pitchTestOrg +4`
    - note mel `2.935`
    - env `0.487`
    - entry mel `1.833`
    - exit mel `3.665`
    - onset artifact `1.748`
    - boundary timing error `2.250 ms`
    - formant drift `0.040`
    - `spectralEnvelopeCorrectionUsed=true`
  - comparison against earlier adaptive correction passes:
    - this is the best mixed result so far
    - it improves `pitchTestOrg +4` note/entry/exit/formant metrics versus `r2` and `r3`
    - it also improves `pitchOrg +4` onset artifact versus `r2` and `r3`
    - but it still does not beat the plain adaptive baseline on the note-start/note-end problems that matter most
- Verdict:
  - the adaptive correction layer is now a real tunable path, not just a failed idea
  - but it is still not the proper fix yet
  - remaining priority order should be:
    - `A4` entry timing compensation
    - `A5` cepstral lifter retune
    - then either:
      - one more `A3` cleanup pass if start roughness still dominates listening, or
      - freeze the adaptive correction layer as a non-default experiment if it keeps failing against plain adaptive

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `11`
- Remaining conditional iterations: `+2`

### 2026-04-16: Adaptive Carrier Timing/Formant Retune R6 + Onset Cleanup R7

#### Timing/formant retune
- Change:
  - added explicit entry/exit pre/post window tuning to the adaptive correction path
  - made cepstral lifter scale and correction strength tunable instead of fixed
  - softened the default cepstral profile and reduced correction authority near the raw boundary
- Result:
  - run: `20260416_213431_adaptive_boundary_tune_r6_timing_formant`
  - `pitchOrg +4`
    - note mel `6.541`
    - env `1.038`
    - entry mel `7.298`
    - exit mel `7.112`
    - onset artifact `2.261`
    - formant drift `0.373`
  - `pitchTestOrg +4`
    - note mel `2.830`
    - env `0.470`
    - entry mel `1.755`
    - exit mel `1.887`
    - onset artifact `1.748`
    - formant drift `0.050`
- Verdict:
  - this was a real improvement on the hard clip, especially at exit
  - formant drift did not materially improve
  - the easy clip still kept too much start-side damage

#### Onset cleanup follow-up
- Change:
  - raised the onset RMS gate slightly
  - reduced entry wetness again
  - shortened the entry pre/post ownership window
  - promoted the resulting profile into the default code path because it outperformed the earlier adaptive correction runs overall
- Result:
  - run: `20260416_213810_adaptive_boundary_tune_r7_onsetcleanup`
  - `pitchOrg +4`
    - note mel `6.526`
    - env `1.023`
    - entry mel `6.890`
    - exit mel `7.112`
    - onset artifact `2.261`
    - formant drift `0.374`
  - `pitchTestOrg +4`
    - note mel `2.828`
    - env `0.470`
    - entry mel `1.707`
    - exit mel `1.887`
    - onset artifact `1.714`
    - formant drift `0.050`
- Verdict:
  - `r7` is the strongest adaptive correction profile so far
  - it narrows the hard-case gap substantially
  - but it still does not solve the two main user-facing issues:
    - `pitchOrg +4` note start is still too artifacted versus plain adaptive
    - `pitchTestOrg +4` note exit and onset are still not as clean as the plain adaptive baseline

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `10`
- Remaining conditional iterations: `+2`

### 2026-04-16: Adaptive Carrier Formant Sweep R8 + Residual Sweep R9

#### Cepstral/formant sweep
- Change:
  - ran two formant-focused profiles on the adaptive correction path:
    - `r8 strong`: lower lifter scale and stronger cepstral correction
    - `r8 soft`: higher lifter scale and softer cepstral correction
- Result:
  - runs:
    - `20260416_223105_adaptive_formant_tune_r8_strong`
    - `20260416_223105_adaptive_formant_tune_r8_soft`
  - both profiles were effectively flat on the smoke suite
  - differences were tiny enough that they do not justify a default change yet
- Verdict:
  - `A5` is not the dominant lever on the current smoke cases
  - richer sustained-vowel fixtures are still needed before declaring cepstral tuning closed in a product sense

#### Residual carry sweep
- Change:
  - compared a dry residual profile against a wetter residual profile on the same formant smoke suite
- Result:
  - runs:
    - `20260416_223535_adaptive_residual_tune_r9_dry`
    - `20260416_223535_adaptive_residual_tune_r9_wet`
  - `r9 dry` won slightly but consistently:
    - `pitchOrg +4`
      - note mel `6.525`
      - env `1.022`
      - entry mel `6.885`
      - onset artifact `2.257`
    - `pitchTestOrg +4`
      - note mel `2.828`
      - env `0.469`
      - entry mel `1.703`
      - onset artifact `1.688`
  - the wetter residual profile was slightly worse on both smoke cases
- Verdict:
  - `A6` currently favors keeping residual reinjection off in the adaptive correction layer
  - the default code path now uses the dry residual profile

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `8`
- Remaining conditional iterations: `+2`

### 2026-04-16: Adaptive Carrier STFT Sweep R10

#### STFT correction-layer sweep
- Change:
  - exposed the cepstral correction stage FFT order and hop divisor as explicit tuning controls
  - compared:
    - `1024 / 8`
    - `2048 / 8`
    - `2048 / 4`
- Result:
  - runs:
    - `20260416_224905_adaptive_stft_tune_r10_1024o8`
    - `20260416_224905_adaptive_stft_tune_r10_2048o8`
    - `20260416_224905_adaptive_stft_tune_r10_2048o4`
  - all three profiles were effectively identical on both smoke cases
  - representative values:
    - `pitchOrg +4`
      - note mel `6.525`
      - env `1.022`
      - entry `6.885`
      - exit `7.112`
      - onset artifact `2.257`
      - formant drift `0.374`
    - `pitchTestOrg +4`
      - note mel `2.828`
      - env `0.469`
      - entry `1.703`
      - exit `1.887`
      - onset artifact `1.688`
      - formant drift `0.050`
- Verdict:
  - `A7` is effectively flat on the current adaptive correction path
  - FFT size / hop is not the dominant remaining lever here
  - remaining budget should move to:
    - richer fixture completion for `H1/H3/H4`
    - challenger close-out `B1-B4`

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `7`
- Remaining conditional iterations: `+2`

### 2026-04-16: Engine-v2 Challenger Narrow Close-Out R8

#### Narrowed/drier engine-v2 pass
- Change:
  - narrowed engine-v2 ownership further around the edited transition nucleus
  - made its transient flatness gates, entry bias, core wetness, residual wetness, and cepstral tuning explicit
  - dried the path down substantially and shortened its transition window so it behaved more like a challenger overlay than a broad note takeover
- Result:
  - runs:
    - `20260416_230357_enginev2_narrow_pitchOrg_plus4_r8`
    - `20260416_230555_enginev2_narrow_pitchTest_plus4_r8`
  - `pitchOrg +4`
    - note mel `6.608`
    - env `1.009`
    - entry mel `7.620`
    - exit mel `7.112`
    - onset artifact `1.390`
    - formant drift `0.395`
  - `pitchTestOrg +4`
    - note mel `3.143`
    - env `0.498`
    - entry mel `7.017`
    - exit mel `1.887`
    - onset artifact `4.000`
    - formant drift `0.062`
- Verdict:
  - this is enough to close the challenger honestly
  - the narrowed engine-v2 pass still loses clearly on the hard clip
  - it is worth keeping in the repo for reference/audition, but not for more main-budget tuning
  - the adaptive carrier remains the only live path worth carrying forward

#### Remaining plan truth
- The full recovery plan is still not complete.
- Remaining mandatory iterations: `3`
- Remaining conditional iterations: `+2`

### 2026-04-27: Direction-Specific Note-HQ Timbre + Exit Polish

#### Renderer decision
- Change:
  - moved production `note_hq` pitch-only rendering to native direction-specific HQ.
  - upward edits keep the current native adaptive branch.
  - downward edits now use a guarded formant law instead of sharing the upward compensation path.
  - Rubber Band remains installed/diagnosed and can be forced for benchmarks with `OPENSTUDIO_PITCH_USE_RUBBERBAND_HQ=1`, but it is not quality-promoted for production note-HQ.
- Reason:
  - the previous native bug was signal-chain correctness, not a renderer-family opening: detected F0 guidance had been passed as `formantRatios` in pitch-only calls.
  - the remaining audible downshift issue was the native compensation law, not a reason to require Rubber Band.
  - the measured Rubber Band benchmark still failed the `+4` mid-band formant gate and had worse boundary timing than native.

#### Downshift formant guard
- Change:
  - pitch-only downward edits use `pow(1 / ratio, alpha)` with default alpha `0.58`.
  - downshift envelope anchoring was strengthened around the voiced `200-3500 Hz` body.
  - native result diagnostics now report direction, selected branch, downshift guard usage, guard alpha, effective note-HQ range, and Rubber Band quality-promotion status.
- Result:
  - primary `pitchOrg -4` run: `tmp_pitch_runs/20260427_160222_direction_guard_v3_pitchOrg_minus4`.
  - harmonic-envelope drift improved from the prior native `0.469` to `0.353`.
  - body low/mid/high deltas were `-0.420 / -1.280 / +0.208 dB`.
  - body/core cents were `0.00 / +11.90`.
  - onset artifact was `1.40`; exit-next artifact was `1.927`.
- Verdict:
  - the downshift timbre problem is materially improved and now passes the practical gate.
  - the aspirational harmonic-drift target remains `<= 0.35`; this pass landed just above it at `0.353`, so future work should treat that as polish, not an emergency renderer swap.

#### Exit-to-next-note polish
- Change:
  - note-HQ transition ownership is asymmetric by default: shorter pre-note shoulder, longer post-note shoulder, and a small next-note head when adjacent notes touch.
  - final native compositing uses a wider dry-protected crossfade at the effective commit range.
  - the harness now reports exit-to-next-note discontinuity metrics and writes `cand_exit_next.wav`.
- Result:
  - `pitchOrg +4`: `tmp_pitch_runs/20260427_160222_direction_guard_v3_pitchOrg_plus4`, exit-next artifact `1.110`.
  - `pitchOrg -4`: `tmp_pitch_runs/20260427_160222_direction_guard_v3_pitchOrg_minus4`, exit-next artifact `1.927`.
  - boundary suite passed: `tmp_pitch_runs/20260427_162913_direction_guard_v4_boundary_plus4`.
- Verdict:
  - the remaining word-break issue is now handled as an edited-note exit handoff metric rather than being hidden inside broad note/window scores.

#### Validation
- Passed:
  - primary `pitchOrg +4` and `pitchOrg -4` note-HQ acceptance runs.
  - export parity for both directions:
    - `tmp_pitch_runs/20260427_162615_direction_guard_v4_export_parity_plus4`
    - `tmp_pitch_runs/20260427_162615_direction_guard_v4_export_parity_minus4`
  - richer formant suite:
    - `tmp_pitch_runs/20260427_161118_direction_guard_v4_formant_richer`
  - richer transient suite:
    - `tmp_pitch_runs/20260427_161118_direction_guard_v4_transient_richer`
  - boundary suite:
    - `tmp_pitch_runs/20260427_162913_direction_guard_v4_boundary_plus4`
- Harness correction:
  - phrase/full-clip note-HQ candidates are scored as full-clip audio.
  - window-local semantics remain only for actual segment renders such as preview segments.
  - downshift F1/F2 hard gates use the more stable note-body proxy on the canonical window; core F2 remains reported but is too unstable to gate alone on this fixture.

### 2026-04-27: Two-Sided Note-HQ Boundary Follow-Up

#### Problem
- User feedback:
  - the edited-note exit/next-note handoff was improved.
  - a stutter/word-break became audible on the note or word before the edited note.
- Root cause:
  - note-HQ rendering had enough left context, but the dry-protected compositor used a generic fixed fade.
  - with a left shoulder, that let wet audio become fully committed before the edited note body actually began.

#### Change
- Commit ranges now retain:
  - effective shoulder start/end.
  - true note body start/end.
- Entry behavior:
  - dry-to-wet fade spans the whole left shoulder.
  - full wet is reached at the edited note body start, not before it.
- Exit behavior:
  - wet-to-dry release starts with a small `12 ms` lead-in before the note body end, then fades through the right shoulder.
  - this lowers the derivative discontinuity at the edited-note exit without returning to the previous-word artifact.
- Harness:
  - added `preCommitArtifactScore`.
  - added `cand_pre_commit.wav` audition excerpt.
  - dry-neighbor residual checks now evaluate only the unowned dry neighbor region outside the effective note-HQ commit range.

#### Result
- `pitchOrg +4`:
  - run: `tmp_pitch_runs/20260427_202041_direction_entry_guard_v6_plus4`
  - pre-commit/onset artifact: `0.055 / 1.791`
  - exit-next artifact: `2.307`
  - body/core cents: `0.00 / 0.00`
  - harmonic drift: `0.378`
- `pitchOrg -4`:
  - run: `tmp_pitch_runs/20260427_202204_direction_entry_guard_v6_minus4`
  - pre-commit/onset artifact: `0.093 / 1.398`
  - exit-next artifact: `0.091`
  - body/core cents: `0.00 / +11.90`
  - harmonic drift: `0.352`
- Boundary suite:
  - run: `tmp_pitch_runs/20260427_boundary_entry_guard_v6b/20260427_202849_direction_entry_guard_v6_boundary`
  - summary: `pitch_boundary_suite_summary.md`
  - start-edge cases stayed clean on the new pre-commit metric.

#### Verdict
- The correct ownership model is not a larger shoulder by itself.
- The renderer should have phrase/shoulder context, but the final commit blend must be note-body-aware so the previous word remains dry until the transition actually belongs to the edited note.
