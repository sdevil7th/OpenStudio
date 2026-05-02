# Pitch Recovery Master Map

## Current Controls
- 2026-05-02 Vienna VSF audition pivot:
  - user audition rejected the adaptive family for the start/pre-start artifact on the Vienna clip; VSF HQ hybrids-disabled was the only tested family that did not have that start artifact.
  - `vienna_vsf_residual_less_055_plus4_full` and `vienna_vsf_residual_less_055_minus4_full` are the current best audition baselines, with residual scale `0.55`; the remaining target is +4 edited-note body clashing/distortion, while -4 nasal tone is regression context.
  - body/dry blend variants are rejected because they sounded like two voices singing the edited pitch; do not continue with reduced core wet or dry/body blend candidates for this issue.
  - current repair direction is VSF epoch-carrier only: optional upward source-epoch interpolation plus upward grain-radius scaling, with diagnostics reporting residual scale, epoch interpolation use, and effective grain scale.
  - iterative fine-tuning round 1 is staged in `tmp_pitch_runs\vienna_vsf_iter_20260502_041147`: exact relative `+4.00`, VSF HQ, hybrids disabled, residual scale `0.55`, core wet `1.0`, and candidate WAVs for baseline `grain065`, interpolation strengths `0.75/0.50`, grain radius `0.60/0.70` at interpolation `0.75`, and `-1.5 dB` upward body presence trim variants. All deterministic harness gates passed, but clashing/distortion, doubled voice, formant/timbre, naturalness, and start artifact remain `not_asserted` until user audition.
  - user audition currently ranks `vienna_vsf_iter_grain070_interp075_plus4_full` as the best +4 candidate so far; this is best-by-audition, not a fixed/completed claim.
  - local diagnostic-only helper `local_tools\pitch\pitch_residual_hotspot_report.py` reported residual hotspots by time slice and broad band against the batch-local `grain065` baseline; these residual/hotspot metrics are not quality claims and the helper is not tracked.
  - downshift nasal iteration is staged in `tmp_pitch_runs\vienna_vsf_minus4_iter_20260502_044712`: exact relative `-4.00`, VSF HQ, hybrids disabled, residual scale `0.55`, core wet `1.0`, no grain/epoch tuning, and candidate WAVs for baseline, `-1.5 dB` nasal trims at `900/1100/1300 Hz`, plus `1100 Hz` nasal trim with `+1.0 dB` body compensation at `430 Hz`. All deterministic harness gates passed, and EQ variants are not byte-identical to baseline. User audition currently ranks `vienna_vsf_iter_minus4_nasal1100_full` as the best -4 candidate so far; nasal tone, distortion, doubled voice, formant/timbre, naturalness, and start artifact remain audition-gated and not a fixed/completed claim.
  - default VSF tuning now follows the current user-picked paths: upward shifts enable source-epoch interpolation by default with interpolation strength `0.75` and upward grain radius scale `0.70`; downward shifts apply `-1.5 dB` body nasal trim at `1100 Hz` by default. Env overrides remain available for diagnostics.
- 2026-04-29 doubled-core recovery:
  - app audition still reported an artificial doubled vocal even after mono spectrogram gates passed, so the current default is treated as audition-not-done until the stable edited-note core clears a dedicated double-voice QA pass.
  - historical state at that point: product/default note-HQ pitch-only selection was restored to `pitch_only_adaptive_selector` with `legacy_natural` recovery; this is superseded by the 2026-05-02 Vienna VSF audition pivot above.
  - likely cause addressed first: the vocal source/filter output was being blended with the adaptive-selector core on long notes by default. That core hybrid is now opt-in via `OPENSTUDIO_VSF_CORE_HYBRID_ENABLE=1` or the legacy diagnostic override `OPENSTUDIO_VSF_CORE_HYBRID_DISABLE=0`.
  - `tools\pitch_double_voice_analyze.py` is now part of reference-backed pitch-only `note_hq` runs and gates original-F0 leakage, secondary pitch excess, stereo correlation drift, mid/side drift, comb/notch excess, and dry-correlation excess.
  - mid/side drift uses an audible-side floor, so nearly mono side residue is reported as raw drift without falsely failing the doubled-core gate.
  - layer dumps for diagnosis are available via `-DumpPitchLayers` / `OPENSTUDIO_VSF_LAYER_DUMP_ENABLE=1`; they write dry input, source/filter core, residual/noise, wet envelope, adaptive hybrid output when engaged, and final output.
  - lesson: doubled-core artifacts are phase/stereo/layering failures, so mono mel and formant proxies cannot be the final naturalness proof.
- 2026-04-29 spectrogram-first QA correction:
  - completion claims for reference-backed pitch-only `note_hq` renders now require a final spectrogram/mel/waveform-envelope report for both upshift and downshift; if the spectrogram done gate fails, the work is explicitly "not done" and the next failing region is named.
  - the failure baseline is `D:\test projects\os tests\runs\20260429_074056_vocal_source_filter_pitchTest_plus4_transient_smoke`: `cand_phrase.wav` vs `ref_phrase.wav` measured about `12.15 dB` whole-phrase mel MAE, phrase short-RMS envelope correlation `0.177`, phrase high-band delta about `+5.25 dB`, core high-band delta about `+6.23 dB`, entry RMS about `+7.6 dB`, exit RMS about `-5.45 dB`, onset peak jump about `+28.8 dB`, onset high-band burst about `+12.9 dB`, and candidate/reference lag about `54 ms`.
  - lesson: pitch cents, branch diagnostics, and proxy formant gates can pass while the rendered vocal is still unusable. Spectrogram/mel/waveform-envelope checks and human audition now veto completion.
  - next repair order is entry/gating burst first, residual/noise smear second, voiced-core naturalness third, and timing/ownership audit fourth. Do not widen dry-protected neighbor commits just to match references that changed wider phrase audio.
- 2026-04-29 source/filter artifact repair status:
  - current code adds PSOLA overlap-weight normalization, longer dry entry ownership, delayed entry-only gain/EQ shaping, duration-specific long-note RMS trim, and bounded long-note adaptive hybrids for entry/core/exit in the `pitch_only_vocal_source_filter_hq` renderer.
  - latest canonical `pitchOrg` reports remain close inside the edited note after the long-note-only hybrid change: `20260429_122136_spectrogram_gate_pitchOrg_plus4_after_exit_hybrid_diag` measured core/entry/exit mel `4.68/7.41/5.71 dB`, and `20260429_122322_spectrogram_gate_pitchOrg_minus4_after_exit_hybrid_diag` measured `4.35/6.14/5.61 dB`.
  - latest harder `pitchTestOrg` reports have the note-owned spectrogram regions inside the current gates: `20260429_123450_spectrogram_gate_pitchTest_plus4_core_hybrid_diag` measured core/entry/exit mel `6.84/4.29/6.17 dB`, and `20260429_123742_spectrogram_gate_pitchTest_minus4_core_hybrid_diag` measured `6.47/4.27/7.74 dB`.
  - these runs are still not a final completion claim until app audition is clean. The remaining phrase-wide envelope failure is non-actionable on these references because original-vs-reference pre/post-neighbor mismatch is about `15/19 dB`; the harness now reports that mismatch and skips the phrase-envelope done gate in that case. Positive onset bursts remain hard failures, but quieter-than-reference onset deltas are reported as target mismatch rather than burst artifacts.
  - next concrete fix if audition still sounds wrong: inspect the long-note `cand_core.wav` and `cand_exit.wav` spectrograms manually against `ref_core.wav`/`ref_exit.wav`, then tune only the core hybrid amount or replace the adaptive core support. Do not widen dry-protected neighbor commits just to improve phrase correlation.
- 2026-04-29 default vocal source/filter hard-gate follow-up:
  - short upward entries now use a shorter `24 ms` dry shell and a near-neutral short-up entry mid cut (`OPENSTUDIO_VSF_SHORT_UP_ENTRY_MID_CUT_DB`, default `-3 dB`) to remove the residual onset-flux failure without affecting downshift or long-note policies.
  - the four default-branch hard checks now pass pitch-quality and spectrogram gates with `actualRendererBranch=pitch_only_vocal_source_filter_hq`:
    - `20260429_132647_spectrogram_gate_pitchOrg_plus4_short_entry_eq3_hard_check`: core/entry/exit mel `4.09/5.37/5.70 dB`.
    - `20260429_132935_spectrogram_gate_pitchOrg_minus4_after_short_entry_eq3_hard_check`: `4.35/6.14/5.61 dB`.
    - `20260429_132935_spectrogram_gate_pitchTest_plus4_after_short_entry_eq3_hard_check`: `6.84/4.29/6.17 dB`.
    - `20260429_132935_spectrogram_gate_pitchTest_minus4_after_short_entry_eq3_hard_check`: `6.47/4.27/7.74 dB`.
  - final status remains audition-gated: these metrics say the renderer is no longer the obvious ghost/robot failure from the spectrogram baseline, but app listening still wins over the proxy gates.
- 2026-04-28 Signalsmith pitch-only formant-contract correction:
  - pitch-only vocal note edits now call `setFormantFactor(1.0f, true)` in the Signalsmith carrier, matching live preview and the real-time corrector.
  - active adaptive-selector pitch-only carriers pass detected F0 through `setFormantBase(...)` when available, and the offline transpose map uses the same stage-A tonality-limit controls as live preview.
  - explicit formant edits pass their requested ratio directly with `compensatePitch=true`; pitch ratio is not folded into the formant factor.
  - downshift-specific timbre support remains a bounded adaptive-selector blend/envelope-transfer concern (`OPENSTUDIO_PITCH_DOWNSHIFT_OWN_BLEND` defaults to `0.42`), not inverse-ratio carrier compensation.
- 2026-04-28 entry contour-handoff correction:
  - the start artifact was reclassified as a pitch-trajectory/ownership mismatch: the renderer needs pre-note ratio context, but final audible ownership must still be controlled by the entry bridge.
  - measured tuning showed that hard/unknown `pitchOrg` entries must keep render pre-roll and reach the target by `note.startTime`; adding an audible body ramp there regressed entry lag and onset gates.
  - entry pitch handoff is therefore enabled only for explicit continuous/internal transitions (`soft_legato`, `internal_bend`, `internal_vibrato`, or adjacent edited notes inside the same island). Hard/unknown entries keep dry-protected audio ownership and render-context pre-roll without delaying the shifted body.
  - diagnostics now include `noteHqEntryPitchHandoffUsed`, handoff start/end, pre/body milliseconds, slope-jump, and acceleration-limit status; the frontend bridge and regression summaries preserve those fields.
  - the harness now reports entry F0 slope/acceleration metrics. The hard gate applies only when a real pitch handoff is used; canonical hard/unknown step edits still report the metric as diagnostic because the reference itself behaves like a step edit.
  - verification:
    - `D:\test projects\os tests\runs\20260428_115125_entry_contour_handoff_plus4_final3`: `pitchOrg +4` passed; onset artifact `1.501`, onset derivative `1.05`, exit-next `2.156`, body/core pitch `0.00/0.00 cents`, harmonic drift `0.382`.
    - `D:\test projects\os tests\runs\20260428_115314_entry_contour_handoff_minus4_final`: `pitchOrg -4` passed; onset artifact `1.187`, onset derivative `0.92`, exit-next `0.207`, downshift harmonic drift `0.339`, low/mid/high `-0.911/-2.011/-0.202 dB`.
    - `D:\test projects\os tests\runs\20260428_115719_entry_contour_handoff_two_adjacent_plus4_r2`: adjacent selected notes still render as one edit island (`noteHqEditIslandCount=1`, `noteHqEditedNoteCount=2`) and report the internal pitch handoff instead of a second dry/wet bridge.
- 2026-04-28 emergency word-grouping repair:
  - product default is restored to single-note ownership: clicking or dragging one note selects and edits only that note.
  - `wordGroupId` remains metadata for diagnostics and controlled render-island decisions, but it no longer automatically expands visible selection or pitch-drag edits.
  - the large word-group hull overlay and multi-note "Word" inspector display were removed because broad/incorrect grouping made unrelated notes appear and move together.
  - analyzer merging is conservative again: automatic merges use a short `40 ms` gap plus an about `1 st` pitch-distance guard, rather than swallowing nearby material solely because it is within the dropout bridge.
  - strong acoustic `hard_word_like` boundary candidates may split default analyzer regions; pure pitch hysteresis, pitch corner, and `internal_vibrato` candidates remain non-destructive diagnostics.
  - harness diagnostics now treat hard acoustic splits separately from destructive pitch-corner/pitch-jump failures and add expected-region overhang checks to catch collapsed words.
  - verification:
    - analyzer run `D:\test projects\os tests\runs\20260428_110455_emergency_word_group_repair_analysis_pitchOrg`: `noteCount=5`, `wordGroupCount=5`, `destructiveCornerSplitCount=0`, `destructivePitchJumpSplitCount=0`, hard acoustic splits `2`, max fragments `1`, max overhang `0.459`.
    - UI ownership test `pitchEditorSingleNoteOwnership.test.ts`: click/select, drag update, and selected pitch move all affect only explicit note IDs even when notes share `wordGroupId`.
    - primary note-HQ runs `D:\test projects\os tests\runs\20260428_110516_emergency_repair_pitchOrg_plus4` and `D:\test projects\os tests\runs\20260428_110641_emergency_repair_pitchOrg_minus4` passed the current gates; measured onset artifacts were `1.48` and `1.598`, exit-next artifacts `2.31` and `0.091`, downshift harmonic drift `0.343`.
    - adjacent selected-note run `D:\test projects\os tests\runs\20260428_110807_emergency_repair_two_adjacent_plus4` reported `noteHqEditIslandCount=1` and `noteHqEditedNoteCount=2`; it is kept as the double-voice safety check, with exit-next artifact still a polish risk on that stress fixture.
- 2026-04-28 phrase-first vibrato-safe word detection:
  - the older running-average pitch-jump split is no longer allowed to destructively cut editable notes; sustained pitch movement now becomes `boundaryCandidates` with `pitch_hysteresis_*` reasons.
  - analyzer segmentation is phrase-first: short voiced detector dropouts up to `80 ms` are bridged, while automatic note cuts are reserved for hard acoustic evidence such as long unvoiced gaps or sustained energy breaks.
  - vibrato-like periodic reversals are reported as `internal_vibrato` diagnostics and remain non-destructive by default.
  - close fragments are merged across short non-hard gaps without blocking on pitch distance alone, so melisma/bend/vibrato movement does not create separate editable words.
  - superseded by the emergency repair above: `wordGroupId` is assistive metadata, not default UI ownership.
  - harness diagnostics now also report `pitchDeviationCandidateCount`, `destructivePitchJumpSplitCount`, and `vibratoSuppressedCandidateCount`; destructive pitch-jump splits must be `0` by default.
  - verification:
    - analyzer run `D:\test projects\os tests\runs\20260428_040921_phrase_first_word_detection_pitchOrg`: `noteCount=3`, `wordGroupCount=3`, `destructivePitchJumpSplitCount=0`, `destructiveCornerSplitCount=0`, edited-word overlap `1.000`, max fragments `1`.
    - primary note-HQ runs `D:\test projects\os tests\runs\20260428_040951_phrase_first_pitchOrg_plus4` and `D:\test projects\os tests\runs\20260428_041117_phrase_first_pitchOrg_minus4` kept the prior pitch, onset, exit, and downshift formant gates.
    - adjacent-fragment diagnostic `D:\test projects\os tests\runs\20260428_041244_phrase_first_two_adjacent_plus4` reported `noteHqEditIslandCount=1` and `noteHqEditedNoteCount=2`, confirming one ownership island for two supplied fragments.
  - lesson: demoting pitch-corner splits was not enough because the older pitch-deviation splitter could still fragment continuous sung words before word grouping ran.
- 2026-04-28 word-group + edit-island correction:
  - pitch-curve corners are now exported as boundary candidates instead of destructive note splits by default; `OPENSTUDIO_ANALYZER_APPLY_CORNER_SPLITS=1` is research-only.
  - analyzer output now includes `wordGroupId`, so close voiced fragments without a hard acoustic break remain one editable word/phrase group.
  - superseded by the emergency repair above: normal pitch moves affect only explicitly selected notes.
  - final note-HQ builds commit ownership per edit island, not per note, so adjacent moved notes get one outer entry bridge and one outer exit bridge instead of internal dry/wet handoffs.
  - merged commit ranges no longer average pitch ratios with `sqrt(previous * current)`; variable-ratio islands keep ownership separate from the actual per-sample pitch curve.
  - harness diagnostics now report boundary candidates, destructive corner split count, word-group overlap, edit-island count, and edited-note count.
  - verification:
    - analyzer run `D:\test projects\os tests\runs\20260428_022002_word_group_analysis_pitchOrg_r2`: `noteCount=10`, `wordGroupCount=4`, `cornerCandidateCount=2`, `destructiveCornerSplitCount=0`, min expected word-group overlap `0.928`.
    - primary note-HQ runs `D:\test projects\os tests\runs\20260428_022028_word_group_island_plus4` and `D:\test projects\os tests\runs\20260428_022028_word_group_island_minus4` kept the prior +4/-4 pitch, onset, exit, and downshift formant gates.
    - adjacent-fragment diagnostic `D:\test projects\os tests\runs\20260428_023520_word_group_two_adjacent_plus4_r4` reported `noteHqEditIslandCount=1` and `noteHqEditedNoteCount=2` in the raw result, confirming one ownership island for two moved fragments.
  - lesson: more segmentation can improve seam metrics while making vocal editing worse; editable note boundaries, vocal word groups, and render islands must stay separate.
- 2026-04-27 segmentation + timbre-stability update:
  - note segmentation now has conservative pitch-corner boundary detection: sharp smoothed-F0 direction reversals can split a note only when supported by energy, confidence, nearby unvoiced/noise, or strong pitch-prominence evidence.
  - detected note boundaries now carry `entryBoundaryKind` / `exitBoundaryKind` diagnostics (`hard_word_like`, `soft_legato`, `internal_bend`, or `unknown`) plus reason and score.
  - note-HQ commit policy is boundary-kind aware: hard word-like entries get a tighter audible bridge, while soft legato/sustain entries may keep the wider phrase bridge needed for continuous vocal gestures.
  - downshift pitch-only renders now apply voiced-core spectral envelope transfer on edited note bodies after the native directional render; this makes formant stability depend on the original vowel envelope rather than only on ratio compensation.
  - the failed lesson is recorded: smoothing the wrong detected note boundary can move the stitch artifact around without fixing it, so analysis boundaries, vocal boundaries, and render ownership are now treated separately.
  - primary verification:
    - `D:\test projects\os tests\runs\20260428_013135_seg_corner_timbre_plus4`: body/core `0.00 / 0.00 cents`, onset artifact `1.479`, onset derivative `1.087`, exit-next `2.307`, harmonic drift `0.379`.
    - `D:\test projects\os tests\runs\20260428_013650_seg_corner_timbre_minus4_mix005`: body/core `0.00 / +11.90 cents`, `spectralEnvelopeCorrectionUsed=true`, onset artifact `1.598`, onset derivative `1.598`, exit-next `0.091`, harmonic drift `0.343`, low/mid/high `-1.083 / -2.067 / -0.053 dB`.
    - rejected aggressive envelope-transfer run `D:\test projects\os tests\runs\20260428_013344_seg_corner_timbre_minus4` regressed harmonic drift to `0.615`, so the kept pass uses a small voiced-support-weighted transfer mix.
    - analyzer diagnostic run `D:\test projects\os tests\runs\20260428_013900_seg_corner_boundary_analysis` serialized boundary diagnostics and reported `2` corner-boundary notes; use manual vocal-boundary references before increasing split aggressiveness.
- 2026-04-27 signal-chain correctness update:
  - native pitch-only renders no longer pass detected F0 curves through the `formantRatios` argument by accident; pitch-only entrypoints now route `ratios + detectedPitchHz` separately and keep `formantCurveUsed=false`.
  - note-HQ compare semantics are corrected: preview segments are window-local, but phrase/full-clip note-HQ candidates are scored as full-clip audio.
  - note-HQ apply now renders with phrase/transition context but dry-protected final compositing keeps audio before the edited note start dry; `pitchOrg` renders with context around `0.604s-1.683s`, effective ownership `0.860s-1.610s`, and audible commit `0.900s-1.610s` for a `0.900s-1.550s` note body.
  - follow-up direction-specific decision: production note-HQ pitch-only defaults to native directional HQ; Rubber Band/offline HQ remains benchmark-only unless explicitly requested.
  - follow-up runtime fix: `tools/rubberband/sndfile.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll` are now bundled so Rubber Band starts and reports version `4.0.0`; `20260427_145800_rubberband_runtime_fixed_pitchOrg_plus4` confirms `phraseHqExternalUsed=true`.
  - external Rubber Band HQ is still benchmark-gated, not quality-promoted: `20260427_145847_rubberband_runtime_fixed_pitchOrg_plus4` failed strict formant/boundary gates (`midBandDeltaDb=+7.866`, boundary `38.54 ms`).
  - final diagnostic native-fallback runs:
    - `20260427_135220_after_fix_pitchOrg_plus4_native_override_final`: body/core pitch `0.00/0.00 cents`, formant body drift `0.378`, low/mid/high `-2.46/+0.53/-3.59 dB`, core F1/F2 drift `-46.9/+23.4 Hz`, boundary `8.42 ms`.
    - `20260427_135413_after_fix_pitchOrg_minus4_native_override_final`: body/core pitch `0.00/+11.90 cents`, formant body drift `0.469`, low/mid/high `-0.41/+0.83/+1.12 dB`, core F1/F2 drift `+46.9/-70.3 Hz`, boundary `25.38 ms`.
  - richer formant suite passed under explicit native fallback: `20260427_135901_after_fix_formant_richer_native_override`.
  - richer transient suite passed under explicit native fallback: `20260427_141431_after_fix_transient_richer_native_override`.
  - boundary-variant suite is not fully green under the new strict gate: `20260427_142907_after_fix_boundary_pitchOrg_plus4_native_override` passed `start_earlier` and `start_later`, then failed synthetic `end_earlier` at boundary timing `38.938 ms > 32 ms`.
- Shipping fallback: `branch_hybrid_reset`
- Trusted experimental control: `pitch_only_hybrid_structural` (`HS-4 / r6`)
- Active best experimental branch: `pitch_only_adaptive_selector` with harvested long-upward and short-downward support
- Analyzer close-out state: direct-YIN + decoder is the frozen kept path; FFT-YIN stays rejected-for-now behind `OPENSTUDIO_ANALYZER_USE_FFT_YIN=1`
- Scrub preview state: natural-segment scrub preview is now active and benchmarked via `20260416_200227_pitchOrg_scrub_preview_r8` (`scrubPreviewAudible=true`, `scrubPreviewFirstDragAudible=true`, loop duration `240 ms`, base pitch `365 Hz`, last peak `0.112`); repeat-stability tuning is still open
- Root-cause research state:
  - completed in `20260417_012542_pitch_root_cause_research`
  - ranked causes:
    - transition ownership and boundary timing drift
    - mixed transient and first-voiced-cycle handling inside one renderer family
    - formant preservation that is too weak and too local for hard transitions
  - repo summary:
    - [pitch_root_cause_research_20260417.md](c:/Users/srvds/Documents/Codes/Studio13-v3/docs/pitch_root_cause_research_20260417.md)
- ML benchmark state:
  - completed in `20260417_003355_pitch_ml_benchmark`
  - verdict: `blocked_no_stronger_restorer`
  - local environment has no materially stronger note-local restorer ready now
- Engine-v3 feasibility state:
  - completed in `20260417_003355_engine_v3_feasibility`
  - `V3-1` decomposition probe verdict: `stop`
  - do not open a longer engine-v3 implementation branch from the current decomposition probe
- Harness close-out state:
  - `H2` boundary suite is implemented
  - `H1` scrub suite is still partial, but it now has richer multi-scenario runs on both canonical clip families:
    - `20260416_231821_pitchOrg_scrub_suite_richer_r1`
    - `20260416_234516_pitchTest_scrub_suite_richer_r1`
    - true multi-note scrub fixtures now exist:
      - `tests/fixtures/pitch-regression/example_pitchOrg_scrub_multinote.json`
      - `tests/fixtures/pitch-regression/example_pitchTest_scrub_multinote.json`
    - multi-note scrub suite run:
      - `20260416_235640_pitchTest_scrub_suite_multinote_r3`
    - first drag, repeated drag, after-transport-cycle, and selection-change are now all exercised end-to-end
  - `H1` scrub suite is now complete for the current canonical local fixture corpus
  - `H3` transient suite is now complete for the current canonical fixture corpus with richer up/down boundary-focused coverage:
    - `20260416_231844_transient_suite_richer_r1`
  - `H4` formant suite is now complete for the current canonical fixture corpus with richer body/transition coverage:
    - `20260416_233426_formant_suite_richer_r1`
  - first adaptive-carrier boundary/formant correction pass is now benchmarked:
    - latest run: `20260416_224905_adaptive_stft_tune_r10_*`
    - `spectralEnvelopeCorrectionUsed=true` on both `+4` truth clips
    - result: best adaptive correction profile so far, still mixed and not keepable yet
  - `A7` STFT sweep is now closed as effectively flat (`1024/8`, `2048/8`, `2048/4` all matched within noise)
  - engine-v2 challenger close-out:
    - run: `20260416_230357_enginev2_narrow_pitchOrg_plus4_r8`
    - run: `20260416_230555_enginev2_narrow_pitchTest_plus4_r8`
    - verdict: freeze challenger; still loses clearly on the hard clip
  - remaining mandatory iterations from the previous close-out program: `0`
  - remaining conditional iterations from the previous close-out program: `+2`
- Current renderer research reference: [pitch_renderer_research_notes.md](c:/Users/srvds/Documents/Codes/Studio13-v3/docs/pitch_renderer_research_notes.md)
- Pitch editor scope: monophonic only, with stereo vocal clips supported by analyzing a mono sum while preserving multichannel render output
- Canonical truth cases:
  - `pitchOrg.wav -> pitchOrg+4s.wav`
  - `pitchOrg.wav -> pitchOrg-4s.wav`
  - `pitchTestOrg.wav -> pitchTestOrg+4s.wav`
  - `pitchTestOrg.wav -> pitchTestOrg-4s.wav`
- Workflow rules:
  - Track every family here first.
  - Test one active family at a time.
  - Compare every run against `CTRL-SHIP` and `CTRL-R6`.
  - Maximum `2` serious iterations per family.
  - If a family is rejected, remove renderer-specific code quickly and record the rejection in the chronological log.

## 2026-04-27 Production Note-HQ Directional Update
- Classification: signal-chain correctness correction, not a reopened renderer-family experiment.
- Product decision:
  - `note_hq` pitch-only production rendering now defaults to native direction-specific HQ.
  - Upward edits keep the existing native adaptive path.
  - Superseded carrier detail: downward edits used a gentler formant guard for a period, but pitch-only Signalsmith now uses neutral formant preservation and leaves downshift timbre support to bounded post-render correction.
  - Rubber Band remains available for diagnostics and benchmark runs, but it is not quality-promoted for production `note_hq` unless `OPENSTUDIO_PITCH_USE_RUBBERBAND_HQ=1`.
- Downshift timbre fix:
  - native pitch-only downshifts now keep the Signalsmith carrier formant-neutral with `setFormantFactor(1.0f, true)`.
  - active pitch-only carriers keep detected F0 as `setFormantBase(...)` guidance and use the live-preview stage-A tonality limit before applying neutral formant compensation.
  - the adaptive selector's bounded own-engine downshift blend now defaults to `0.42`; envelope matching remains the secondary bounded body-color support focused on the voiced `200-3500 Hz` body while protecting transient and air bands.
- Boundary polish:
  - note-HQ ownership is now asymmetric around edited notes, with a wider post-note shoulder and a small next-note head when adjacent notes touch.
  - final compositing uses a wider dry-protected crossfade at the effective commit range instead of cutting at the note body boundary.
  - the regression harness now reports an explicit exit-to-next-note artifact score.
- 2026-04-27 two-sided boundary correction:
  - the first exit-focused fix exposed an audible pre-note/previous-word handoff because the dry-protected compositor could become fully wet before the edited note body started.
  - commit ranges now carry both the effective shoulder and the true note body start/end.
  - final audible compositing now starts at the edited note body start, never at the left effective shoulder by default.
  - `[effectiveStartTime, note.startTime)` is copied from the original/dry audio exactly; the dry-to-wet entry fade happens inside the first `12 ms` of the edited note body.
  - release compositing starts a small `12 ms` lead-in before the note body end, then fades through the right shoulder, reducing the derivative jump at the edited-note exit.
  - the failed lesson is recorded: widening left shoulder ownership can move the stutter backward into the previous word, so render context and audible commit ownership must stay separate.
  - the harness now reports `preBodyTailOriginalResidualDb`, `candidateActiveDifferenceStartSec`, `preBodyTailArtifactScore`, and writes `orig_pre_body_tail.wav`, `cand_pre_body_tail.wav`, and `diff_pre_body_tail.wav`.
- Primary measured results:
  - `pitchOrg +4`: run `tmp_pitch_runs/20260427_160222_direction_guard_v3_pitchOrg_plus4`; body/core cents `0.00 / 0.00`, harmonic drift `0.378`, band deltas `-2.464 / +0.531 / -3.590 dB`, F1/F2 proxy drift `-46.875 / +23.438 Hz`, onset artifact `1.79`, exit-next artifact `1.110`.
  - `pitchOrg -4`: run `tmp_pitch_runs/20260427_160222_direction_guard_v3_pitchOrg_minus4`; body/core cents `0.00 / +11.90`, harmonic drift improved from the prior native `0.469` to `0.353`, band deltas `-0.420 / -1.280 / +0.208 dB`, onset artifact `1.40`, exit-next artifact `1.927`.
  - two-sided boundary follow-up `pitchOrg +4`: run `tmp_pitch_runs/20260427_202041_direction_entry_guard_v6_plus4`; pre-commit/onset artifacts `0.055 / 1.791`, exit-next artifact `2.307`, body/core cents `0.00 / 0.00`.
  - two-sided boundary follow-up `pitchOrg -4`: run `tmp_pitch_runs/20260427_202204_direction_entry_guard_v6_minus4`; pre-commit/onset artifacts `0.093 / 1.398`, exit-next artifact `0.091`, harmonic drift `0.352`, body/core cents `0.00 / +11.90`.
  - final pre-body dry ownership `pitchOrg +4`: run `tmp_pitch_runs/20260427_213815_pre_body_dry_v3_plus4`; body/core cents `0.00 / 0.00`, pre-body residual `-170.878 dB`, active difference start `0.900063s`, onset artifact `1.706`, exit-next artifact `2.307`, harmonic drift `0.379`.
  - final pre-body dry ownership `pitchOrg -4`: run `tmp_pitch_runs/20260427_213940_pre_body_dry_v3_minus4`; body/core cents `0.00 / +11.90`, pre-body residual `-169.515 dB`, active difference start `0.900063s`, onset artifact `2.721`, exit-next artifact `0.091`, harmonic drift `0.352`.
  - entry-bridge follow-up:
    - product rule is now bridge-aware: render context may extend before the edited note, and final apply may use a bounded entry bridge, but audio before `noteHqEntryBridgeStartSec` must remain original/dry.
    - upward edits use a tight in-body bridge (`0.900s -> 0.916s` on `pitchOrg +4`) because the pre-note bridge regressed the upward onset audit.
    - downward edits use a bounded pre-note bridge (`0.876s -> 0.980s` on `pitchOrg -4`) with a `-22.0 ms` wet-read offset, `+1.7 dB` entry envelope correction, and `10 ms` dry transient preservation.
    - the corrected lesson is recorded: fully dry pre-note ownership prevented previous-word mutation, but could leave a phase/envelope discontinuity exactly at the edited-note entry.
    - final `pitchOrg +4` run `tmp_pitch_runs/20260428_004839_entry_bridge_v15_plus4`: body/core cents `0.00 / 0.00`, entry lag `-0.125 ms`, onset artifact `1.479`, onset derivative `1.087`, protected pre-bridge residual `-172.823 dB`, exit-next artifact `2.307`, harmonic drift `0.379`.
    - final `pitchOrg -4` run `tmp_pitch_runs/20260428_004708_entry_bridge_v15_minus4`: body/core cents `0.00 / +11.90`, entry lag `+0.771 ms`, onset artifact `1.598`, onset derivative `1.598`, protected pre-bridge residual `-240.000 dB`, exit-next artifact `0.091`, harmonic drift `0.344`.
    - export parity passed in `tmp_pitch_runs/20260428_005155_entry_bridge_v15_plus4_export` and `tmp_pitch_runs/20260428_005458_entry_bridge_v15_minus4_export`; the source-vs-export dry residual remains informational because the mixer/export path changes the full file from time zero.
  - Export parity passed for both directions in `tmp_pitch_runs/20260427_214538_pre_body_dry_v4_plus4_export` and `tmp_pitch_runs/20260427_214814_pre_body_dry_v4_minus4_export`; the source-vs-export dry residual readout is informational only because the mixer/export path changes the full file from time zero.
  - Richer formant suite passed in `tmp_pitch_runs/pre_body_dry_v2_formant_richer/20260427_212751_pre_body_dry_v2_formant_richer`.
  - Richer transient suite passed in `tmp_pitch_runs/pre_body_dry_v4_transient_richer/20260427_215055_pre_body_dry_v4_transient_richer`.
  - Boundary suite completed in `tmp_pitch_runs/pre_body_dry_v2_boundary/20260427_212152_pre_body_dry_v2_boundary`; the primary real `pitchOrg` cases stay under the exit-next gate, while the synthetic shortened-end stress case still shows a high exit-next artifact and remains a stress warning.
- Rubber Band benchmark status:
  - runtime availability diagnostics stay in place.
  - pitch maps now use `effectiveStart/effectiveEnd` transition shoulders for benchmark ramps.
  - current benchmark evidence is not production-promotable because the earlier `+4` run failed the mid-band formant gate and had worse boundary timing than native.

## Approach Status Table
| Family ID | Approach | Class | Status | Last Result | Best Observed Gain | Main Failure | Can Harvest | Code State | Next Action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `CTRL-SHIP` | Shipping fallback `branch_hybrid_reset` | Control | `Kept Control` | Shipping-safe app path; still current fallback baseline | Safest all-around fallback, exact pitch on truth cases | Still far from samples on onset, exit, neighbors | Yes | `Active branch` | Keep frozen as shipping control |
| `CTRL-R6` | `pitch_only_hybrid_structural` / `HS-4 / r6` | Control | `Kept Control` | Trusted experimental baseline; best kept short-upward branch | `pitchOrg +4` note mel `6.209`, env `0.961`, entry `6.928`, exit `6.076`, onset artifact `1.810` | Does not improve `pitchTest +4`; stutter still present | Yes | `Active branch` | Keep frozen as experimental control |
| `FAM-ANALYZER-PYIN` | Native editor-first analyzer upgrade: staged direct-YIN baseline plus FFT-YIN probe, multi-candidate extraction, voiced/unvoiced probabilities, and Viterbi-style decoding in `PitchAnalyzer` | Analysis upgrade | `Promising` | 2026-04-15 close-out: direct Hann-windowed YIN + decoder matched the target note window on both analysis fixtures (`pitchOrg`: `7` detected / `1` expected, overlap ratio `0.964`; `pitchTestOrg`: `6` detected / `1` expected, overlap ratio `0.796`) with high median voiced confidence (`0.974` / `0.976`), while FFT-YIN produced `0` detected notes and `0.000` voiced-frame ratio on both clips when forced on | First native editor-side path that adds pYIN-like candidate generation and temporal decoding without new dependencies, while keeping the editor contract stable and the direct path usable on real clips | Direct path still oversplits full-clip note segmentation on the current fixtures, and FFT-derived difference computation is still not parity-safe enough to promote | Yes | `Active branch` | Freeze the direct-YIN + decoder path as the kept analyzer implementation, keep FFT-YIN gated off, and treat any future analyzer work as segmentation polish rather than an open parity question |
| `FAM-SCALAR` | Scalar blend/ramp/timing/smoothing/coherence/bridge family | Exhausted tweak family | `Rejected` | Multiple rejected HS iterations; no keep beyond `HS-4 / r6` | Safer short-upward early-core blend in `HS-4` | Could not fix onset/body tradeoff; all later variants plateaued | Yes | `Disabled` | Do not revisit without a new structural reason |
| `FAM-BODY-A` | Dry attack + existing own-engine body | Body replacement | `Rejected` | Path A iteration 1 | Onset artifact improved on `pitchOrg +4` | Note mel/env and entry worsened; no equal-weight win | No | `Disabled` | Keep rejected |
| `FAM-BODY-B` | Dry attack + epoch-copy body | Body replacement | `Rejected` | Path B exhausted after 2 iterations | Strong note-body gain on `pitchOrg +4` | Onset collapsed badly; not keepable | Yes | `Disabled` | Harvest only if a future v2 needs epoch-copy body evidence |
| `FAM-BODY-C` | Dry attack + harmonic-only body | Body replacement | `Rejected` | Path C exhausted after 2 iterations | None; C1 failed closed | C2 collapsed pitch/body badly | No | `Disabled` | Keep rejected |
| `FAM-BODY-D` | Dry attack + PSOLA body | Body replacement | `Rejected` | Path D exhausted after 2 iterations | Best body realism on `pitchOrg +4`: note mel `5.105`, env `0.474`, harmonic drift `0.127` | Onset artifact stayed far worse than `r6`; did not generalize to `pitchTest +4` | Yes | `Disabled` | Harvest PSOLA body realism only, not the handoff architecture |
| `FAM-CONT-E1` | Voiced-tail continuation body | Continuation | `Rejected` | Failed closed on first iteration | None | Never engaged on active target | No | `Disabled` | Keep rejected |
| `FAM-CONT-E2` | Early continuation handoff into existing core | Continuation | `Rejected` | Failed closed on first iteration | None | Never engaged on active target | No | `Disabled` | Keep rejected |
| `FAM-ISLAND-F` | Fixed-mask island-native with own-engine core | Island-native | `Rejected` | Path F exhausted after 2 iterations | Onset artifact improved to `1.388` on `pitchOrg +4` | Body, entry, and exit regressed too much; never engaged on `pitchTest +4` | Yes | `Disabled` | Harvest onset-side gain only |
| `FAM-ISLAND-G` | Island-native + PSOLA core | Island-native | `Rejected` | Path G stopped after 1 iteration | Preserved Path F onset-side gain | Pitch/body/exit destabilized badly; still no `pitchTest +4` engagement | No | `Disabled` | Keep rejected |
| `FAM-CE33-SIMPLE` | Legacy simple `ce33` path (`branch_simple_ce33`) | Archived baseline | `Promising` | Truth sweep 2026-04-15; `pitchOrg +4` note mel `7.810`, env `0.883`, entry `7.996`, exit `9.295`, onset artifact `2.50`; `pitchTest +4` note mel `3.044`, env `0.486`, entry `1.660`, exit `6.378`, onset artifact `0.72` | Best measured `pitchTest +4` single-case result so far | Still behind `CTRL-R6` on `pitchOrg +4`; not a single best overall control | Yes | `Active branch` | Keep as a secondary benchmark and harvest candidate, not as the main control |
| `FAM-ADAPTIVE-SELECTOR` | Harvested hybrid selector: `CTRL-R6` for short upward notes, `branch_simple_ce33` for long upward notes, light own-engine support on short downward notes | Hybrid kept path | `Kept Control` | 2026-04-15 broader validation sweep: `pitchOrg +4` note mel `7.085`, env `1.376`, entry `7.078`, exit `7.027`, onset artifact `1.80`; `pitchOrg -4` note mel `6.623`, env `1.102`, entry `6.585`, exit `7.475`, onset artifact `2.80`; `pitchTestOrg +4` note mel `2.810`, env `0.470`, entry `1.530`, exit `1.632`, onset artifact `0.70`; `pitchTestOrg -4` note mel `3.505`, env `1.024`, entry `3.090`, exit `1.835`, onset artifact `3.64` | First branch to beat `CTRL-R6` on `pitchTest +4`, keep the easier `+4` case competitive, and carry a useful harvested `pitchOrg -4` improvement without destabilizing the truth set | Still does not fully solve stutter/formant note-change quality, and `pitchTestOrg -4` remains only acceptable rather than a clear win | Yes | `Active branch` | Freeze as the benchmark branch for the rest of the research close-out and any engine-v2 comparisons |
| `FAM-ADVANCED` | Advanced legacy branch (`branch_current_advanced`) | Archived baseline | `Rejected` | Truth sweep 2026-04-15; `pitchOrg +4` note mel `7.329`, env `0.827`, cents `-36.45`; `pitchTest +4` note mel `8.784`, env `1.190`, cents `-35.70` | None beyond historical reference value | Misses pitch on both truth cases and loses clearly to both controls | No | `Active branch` | Do not use standalone; prune after tracker-based cleanup reaches archived branches |
| `FAM-CORE-PSOLA` | Standalone PSOLA core (`pitch_only_psola_core`) | Archived core | `Rejected` | Truth sweep 2026-04-15; `pitchOrg +4` note mel `11.053`, env `1.640`, body cents `-55.55`; `pitchTest +4` note mel `17.536`, env `2.547`, body cents `-104.96` | None as a standalone truth-case path | Severe pitch/body drift on both truth cases | No | `Active branch` | Do not use standalone; prune after tracker-based cleanup reaches archived cores |
| `FAM-CORE-MODEL` | Standalone model core (`pitch_only_model_core`) | Archived core | `Rejected` | Truth sweep 2026-04-15; `pitchOrg +4` note mel `10.955`, env `1.626`, body cents `-37.23`; `pitchTest +4` note mel `17.397`, env `2.530`, body cents `-104.96` | None as a standalone truth-case path | Severe truth-case loss with large body drift and poor envelope match | No | `Active branch` | Do not use standalone; prune after tracker-based cleanup reaches archived cores |
| `FAM-OWN-PITCH` | Standalone own-engine pitch path (`pitch_only_own_engine`) | Archived core | `Rejected` | Truth sweep 2026-04-15; `pitchOrg +4` note mel `6.316`, env `1.044`, entry `7.783`, exit `6.407`, onset artifact `1.59`; `pitchTest +4` note mel `12.164`, env `1.667`, entry `17.634`, exit `13.403`, onset artifact `3.99` | Decent exact-pitch `pitchOrg +4` body with a better onset artifact than `CTRL-R6` | Collapses badly on `pitchTest +4`; not a viable standalone editor | Yes | `Active branch` | Harvest only if a future v2 needs own-engine core behavior on easy upward clips |
| `FAM-FORMANT-ONLY` | Own-engine formant-only path (`formant_only_own_engine`) | Archived formant path | `Rejected` | Truth sweep 2026-04-15 matched `FAM-ADVANCED` bit-for-bit on both `+4` truth cases | None distinct from `FAM-ADVANCED` | Not a competitive truth-case path and appears equivalent to the advanced branch on current tests | No | `Active branch` | Treat as an archived alias-like formant path; prune with `FAM-ADVANCED` |
| `FAM-PITCH-PLUS-FORMANT` | Own-engine pitch-plus-formant path (`pitch_plus_formant_own_engine`) | Archived formant path | `Rejected` | Truth sweep 2026-04-15 matched `FAM-ADVANCED` bit-for-bit on both `+4` truth cases | None distinct from `FAM-ADVANCED` | Not a competitive truth-case path and appears equivalent to the advanced branch on current tests | No | `Active branch` | Treat as an archived alias-like formant path; prune with `FAM-ADVANCED` |
| `FAM-BASELINE-SAFE` | `baseline_safe` runner option | Alias / cleanup item | `Superseded` | Code inspection 2026-04-15: runner validate-set contains it, renderer parser does not map it to a distinct branch | None; not a distinct renderer family | Appears to be an alias/config leftover rather than a real option | No | `Not started` | Treat as non-distinct; clean up the option when touching runner dispatch next |
| `FAM-V2-SYNTH-CORE` | Island shell + directly synthesized voiced core + explicit residual layer | Major revamp | `Rejected` | `G1` on 2026-04-15; `pitchOrg +4` onset artifact `1.810 -> 1.39` but note mel `6.209 -> 8.135`, env `0.961 -> 1.517`, entry `6.928 -> 10.468`, exit `6.076 -> 13.781`, whole-note cents `-408.27`; `pitchTest +4` failed closed to control SHA | Preserved the familiar onset-side gain pattern on `pitchOrg +4` | Body, entry, exit, and pitch stability regressed too much; no reason to spend `G2` | No | `Removed` | Do not continue this family; escalate to a deeper redesign definition |
| `FAM-V2-HSR` | Transient layer + harmonic/source-filter core + residual layer | Major revamp | `Rejected` | `pitch_only_engine_v2` G1 on 2026-04-15; `pitchOrg +4` onset artifact `1.810 -> 1.388` but note mel `6.209 -> 7.975`, env `0.961 -> 1.454`, entry `6.928 -> 9.737`, exit `6.076 -> 12.703`; `pitchTest +4` unchanged and still did not engage | Onset-side gain on `pitchOrg +4` matched island-native family | Body/exit regressed too much and the family still did not generalize to `pitchTest +4` | No | `Removed` | Do not continue this family; move to a deeper redesign definition |
| `FAM-HPSS-SHELL` | HPSS-style vertical split: original transient/noise shell plus pitched harmonic layer | Major revamp | `Rejected` | `H1` on 2026-04-15; `pitchOrg +4` engaged and improved onset artifact `1.810 -> 1.390`, but note mel worsened `6.209 -> 10.066`, env `0.961 -> 2.028`, entry `6.928 -> 10.996`, exit `6.076 -> 15.137`; `pitchTest +4` failed closed with `hpssUsed=false`; `-4` guards also lost versus the adaptive control | Another confirmation that vertical transient preservation can reduce the onset score on the easy upward clip | Harmonic body collapsed badly on `pitchOrg +4`, did not engage on `pitchTest +4`, and did not stay safe on the `-4` guards | No | `Removed` | Stop the family at `H1`; do not open `H2/H3` on this shell |
| `FAM-HPSS-SF` | HPSS shell plus source-filter harmonic core | Major revamp | `Researched` | Not started because `FAM-HPSS-SHELL` failed the stop-fast gate immediately | Plausible path for vertical split plus timbre preservation if a stronger shell ever wins | Blocked by the failed shell; current planned version should not be opened on top of a losing `H1` | Yes | `Not started` | Only revisit if a structurally different HPSS shell is defined later |
| `FAM-HPSS-SF-APER` | HPSS shell plus source-filter core plus explicit aperiodic layer | Major revamp | `Researched` | Not started because `FAM-HPSS-SHELL` failed the stop-fast gate immediately | Keeps the full transient/harmonic/aperiodic decomposition idea on the map | Blocked by the failed shell; should not be layered onto the rejected `H1` foundation | Yes | `Not started` | Only revisit if a later HPSS shell earns continuation |
| `FAM-WSOLA-SEAM` | WSOLA-style shoulder similarity search on top of the adaptive selector | Major revamp | `Rejected` | `W1` on 2026-04-15; only `pitchOrg +4` changed, and it got worse versus the current adaptive branch: note mel `7.085 -> 7.102`, env `1.376 -> 1.377`, entry `7.078 -> 7.314`, exit `7.027 -> 7.151`, onset artifact `1.80 -> 2.29`; `pitchOrg -4`, `pitchTestOrg +4`, and `pitchTestOrg -4` stayed byte-identical to the adaptive branch | Proved the repo can run seam-search diagnostics through the existing truth harness | No truth-case win, and the only engaged case regressed on onset, entry, exit, and note mel | No | `Removed` | Do not revisit this shoulder-only WSOLA implementation; move to phase-coherent DSP families |
| `FAM-PHASE-LOCK-PV` | Phase-vocoder body path with harmonic peak locking and boundary phase alignment | Major revamp | `Rejected` | `P1` on 2026-04-15; `pitchOrg +4`, `pitchOrg -4`, and `pitchTestOrg -4` stayed byte-identical to `FAM-ADAPTIVE-SELECTOR`; `pitchTestOrg +4` was the only engaged case with `phaseLockUsed=true`, `phaseAlignedExit=true`, `phasePeakCount=114`, but it regressed on note mel `2.81 -> 3.003`, entry mel `1.53 -> 2.278`, and exit mel `1.632 -> 1.940` while only slightly improving onset artifact `0.705 -> 0.66` | Proved this lighter boundary-phase-alignment variant can engage selectively on the harder long-upward case without destabilizing the other truth cases | No equal-weight win: the only engaged case materially worsened note and entry metrics, so it did not earn a tuned `P2` | No | `Removed` | Do not revisit this boundary-alignment-only phase-lock pass; move to `FAM-HPSS-MEDIAN` |
| `FAM-HPSS-MEDIAN` | True median-filter HPSS shell with harmonic/transient recombine | Major revamp | `Rejected` | `Hm1` on 2026-04-15; only `pitchOrg +4` changed, with `hpssUsed=true`, harmonic/aperiodic peaks `0.868 / 0.554`, but note mel worsened `7.085 -> 7.432`, entry mel `7.078 -> 7.445`, and note/body/core cents collapsed to `-55.55`; `pitchOrg -4`, `pitchTestOrg +4`, and `pitchTestOrg -4` stayed byte-identical to `FAM-ADAPTIVE-SELECTOR` | Proved the repo can run a real median-filter HPSS shell through the truth harness instead of just the earlier heuristic mask shell | Still did not generalize to `pitchTest +4`, and the only engaged case regressed on body pitch and note/entry quality | No | `Removed` | Do not revisit this scalar median-shell implementation; keep only the diagnostics and stop list entry |
| `FAM-HPSS-MEDIAN-SF` | Median HPSS shell plus harmonic spectral-envelope preservation | Major revamp | `Researched` | Not started because `FAM-HPSS-MEDIAN` failed the stop-fast gate at `Hm1` | Puts true HPSS and explicit harmonic timbre preservation together in one family | Gated behind a promising `FAM-HPSS-MEDIAN` shell result; should not open on a losing shell | Yes | `Not started` | Leave blocked unless a materially stronger median HPSS shell is defined later |
| `FAM-PVDR` | Research-grade phase-coherent phase-vocoder family with proper phase locking or phase-gradient integration | Major revamp | `Rejected` | `P1` on 2026-04-15 benchmarked a long-upward resample-plus-phase-lock PVDR overlay on top of `pitch_only_adaptive_selector`; `pitchOrg +4` stayed byte-identical, but `pitchTestOrg +4` catastrophically failed with note/body/core cents `-628.27 / -628.27 / -664.72`, onset artifact exploding to `+200512709616936000`, and `phaseLockUsed=true`, `phasePeakCount=14710` | Proved the repo can route a genuinely different PV-style long-note benchmark through the truth harness without touching the live branch | The first real PVDR attempt was numerically unstable and failed the stop-fast gate decisively on the harder truth case, and there is no materially different stable PV implementation ready locally right now | No | `Removed` | Keep the broader PV family closed unless a genuinely different phase-gradient or otherwise more stable implementation is ready to benchmark |
| `FAM-TRANSITION-HQ` | HQ-only transition-native note-change overlay on top of `pitch_only_adaptive_selector` | Major revamp | `Rejected` | `M1` on 2026-04-15 benchmarked `pitch_only_transition_hq`; it engaged on both `+4` truth cases with transition diagnostics, but `pitchOrg +4` regressed from note mel `7.085 -> 7.395`, env `1.376 -> 1.434`, entry `7.078 -> 7.723`, onset artifact `1.80 -> 1.59`, while `pitchTestOrg +4` regressed much harder from note mel `2.810 -> 4.084`, env `0.470 -> 0.772`, entry `1.530 -> 15.735`, onset artifact `0.70 -> 3.73`, and core cents stayed off at `-18.32` | Proved the repo can benchmark a transition-focused HQ overlay with explicit shell/core/residual diagnostics on stereo-safe mono analysis | The overlay harmed both primary truth cases, especially `pitchTestOrg +4`, so it did not earn a second DSP iteration or the optional ML finish | No | `Removed` | Stop this family at `M1`; the next escalation is not another local overlay but a materially larger engine redesign if we revisit note-change rendering |
| `FAM-ML-RESTORATION` | Offline-only post-render restoration/refinement benchmark | Research only | `Blocked` | `M1` on 2026-04-15 benchmarked `ml_restore_proxy_v1` on top of `pitch_only_adaptive_selector`; it helped the easier clip but materially harmed `pitchTestOrg +4`. Follow-up environment benchmark on 2026-04-17 returned `blocked_no_stronger_restorer`: `voicefixer` and `demucs` are not installed, `audio_separator` is not suitable for note-local restoration, and the proxy path is explicitly excluded. | First offline benchmark infrastructure that can score a restoration pass on top of the kept renderer without touching the live editor path | No materially stronger local note-local restorer is available right now, so reopening the family locally would just repeat the rejected proxy path | Yes | `Disabled` | Keep the benchmark harness and diagnostics, but only reopen this family once a genuinely stronger local or external/licensed restorer is available |
| `FAM-ENGINE-V2` | Full note-transition-aware engine redesign with explicit harmonic core, residual/noise path, formant envelope, and transition compositor | Full redesign fallback | `Frozen Reference` | `V2-1` scaffold remains parity-safe on both primary `+4` truth clips with branch `pitch_only_engine_v2_program`, and the branch contains the full transition-native audio pass: dedicated RAM scrub preview, Signalsmith-based voiced-core render, cepstral envelope restoration, spectral-flatness transient bypass, residual carry, and transition composition. Latest narrowed runs on 2026-04-16 still lose to the adaptive selector, and the 2026-04-17 root-cause pass confirmed the branch is evidence only, not the recommended active path. | The branch now has the full implementation scaffolding we actually need: note-local HQ infrastructure, dedicated scrub monitoring, transition-native diagnostics, and a benchmarkable engine-v2 sound path that no longer fails numerically | The current waveform-correction overlay shape plateaued: it can be made safer on the easy clip, but the hard truth-case entry still loses badly versus the adaptive selector | Yes | `Active branch` | Keep the code for comparison and audition, but do not continue this branch as the main recovery path without a materially stronger decomposition/transition model |
| `FAM-ENGINE-V3` | Clean-sheet transition-pair renderer with explicit transient shell, voiced core, residual path, and built-in formant handling | Long-term redesign | `Blocked` | 2026-04-17 feasibility probe `20260417_003355_engine_v3_feasibility` scored only `0.511` on `pitchOrg_plus4` and `0.505` on `pitchTest_plus4`, both with verdict `stop` at `V3-1` decomposition stage | Keeps a true clean-sheet DSP option on the map instead of another local overlay family | Current decomposition probe is not strong enough to justify immediate build-out and risks repeating engine-v2 if opened blindly | Yes | `Not started` | Only reopen after defining a materially stronger decomposition and transition-pair ownership design; do not continue from the current probe |
| `FAM-V2-HSR-DOWN` | Separate downward law on top of the active experimental branch | Major revamp | `Harvested` | Support scan plus adaptive integration on 2026-04-15: `branch_simple_ce33` was not a clean `-4` winner; `pitch_only_own_engine` improved easy downward body metrics; harvested light own-engine support into `FAM-ADAPTIVE-SELECTOR`, improving `pitchOrg -4` note mel `7.405 -> 6.570`, entry `6.902 -> 6.571`, exit `8.778 -> 7.565` while `pitchTest -4` stayed on the same SHA | Demonstrated that a small own-engine contribution helps easier short downward notes without harming the hard guard case | Harvested result still does not materially improve the harder `pitchTest -4` truth case | Yes | `Active branch` | Treat the first downward trait as harvested; only start a deeper standalone downward family if later validation shows `pitchTest -4` still needs a dedicated win |
| `FAM-V2-LONG` | Separate long-note policy on top of v2 | Major revamp | `Researched` | Not implemented yet | Lets short-note and long-note solutions diverge cleanly | Blocked until a new short-upward v2 family actually wins | Yes | `Not started` | Blocked pending a new upward v2 control |
| `FAM-NEURAL-FINAL` | Final-only restoration benchmark | Research only | `Researched` | Not implemented yet | Possible late-stage restoration after DSP render | Too early; should not be next coding task | Yes | `Not started` | Queue only if DSP v2 plateaus |
| `FAM-SIGNALSMITH-CARRIER` | Signalsmith as carrier/fallback inside a larger v2 engine | Support architecture | `Researched` | Current repo history already proves Signalsmith-family strength | Strong stability and fallback behavior | Current Signalsmith-centered handoff family is plateaued | Yes | `Active branch` | Reuse as a support role inside v2, not as more local patching |
| `FAM-WORLD-FEATURES-V2` | WORLD-style decomposition features only for envelope / aperiodicity support | Support architecture | `Researched` | Not implemented as a distinct branch; kept as an internal-analysis option only | Useful support direction for future envelope and residual estimation | Pure WORLD rendering is still out of scope and non-competitive here | Yes | `Not started` | Use only as support features inside a future renderer, never as a standalone path |
| `FAM-DECOMP-FEATURES` | WORLD-style decomposition ideas as internal features only | Support architecture | `Researched` | Research direction only; no pure WORLD retry | Useful for F0/envelope/residual decomposition signals | Pure WORLD render path is not competitive for this product | Yes | `Not started` | Use only as internal analysis support if helpful in v2 |

## Harvestable Traits
| Trait ID | Trait | Source Family | Evidence | Adopted? | Target Architecture |
| --- | --- | --- | --- | --- | --- |
| `TR-HS4-EARLYCORE` | Softer early-core short-upward blend | `CTRL-R6` | Best kept short-upward compromise in current branch | Yes | `CTRL-R6` control |
| `TR-D-BODY` | PSOLA body realism in stable voiced core | `FAM-BODY-D` | `pitchOrg +4` note mel `6.209 -> 5.105`, env `0.961 -> 0.474`, harmonic drift `0.400 -> 0.127` | No | `FAM-V2-HSR` |
| `TR-F-ONSET` | Island-native onset improvement with outer-only splices | `FAM-ISLAND-F` | `pitchOrg +4` onset artifact `1.810 -> 1.388` | No | `FAM-V2-HSR` |
| `TR-SIGNALSMITH-STABILITY` | Stable fallback/carrier behavior | `CTRL-SHIP`, `FAM-SIGNALSMITH-CARRIER` | Shipping path remains safest exact-pitch fallback across truth cases | Yes | Shipping fallback and future v2 fallback role |
| `TR-DECOMP-SUPPORT` | Internal decomposition as analysis features, not renderer | `FAM-DECOMP-FEATURES` | Useful structural separation for F0 / envelope / residual planning | No | `FAM-V2-HSR` |
| `TR-CE33-PITCHTEST` | Strong `pitchTest +4` truth-case behavior from simple `ce33` | `FAM-CE33-SIMPLE` | `pitchTest +4` note mel `3.044`, env `0.486`, entry `1.660`, exit `6.378`, onset artifact `0.72` | No | Future hybrid / v2 benchmark role |
| `TR-OWN-PITCH-EASY-UP` | Own-engine exact-pitch short-upward behavior on easier clips | `FAM-OWN-PITCH` | `pitchOrg +4` note mel `6.316`, onset artifact `1.59`, exact body/core pitch | No | Future v2 core selection / fallback study |
| `TR-ADAPTIVE-LONGUP` | Long-upward selector rule: keep `CTRL-R6` on short upward notes and use `ce33` on long upward notes | `FAM-ADAPTIVE-SELECTOR` | `pitchTest +4` improved from `3.481 / 0.623 / 2.484 / 7.662 / 3.819` to `3.095 / 0.493 / 1.530 / 7.350 / 0.70` while `pitchOrg +4` stayed effectively flat | Yes | `FAM-ADAPTIVE-SELECTOR` |
| `TR-ADAPTIVE-DOWN-SHORT` | Light own-engine support on shorter downward notes inside the adaptive selector | `FAM-V2-HSR-DOWN` | `pitchOrg -4` improved from note mel `7.405` to `6.570`, entry `6.902` to `6.571`, exit `8.778` to `7.565`, while `pitchTest -4` stayed byte-identical and both `+4` truth cases stayed on their kept adaptive outputs | Yes | `FAM-ADAPTIVE-SELECTOR` |
| `TR-OWN-DOWN-EASY` | Own-engine note-body gain on easier downward clips | `FAM-OWN-PITCH` | `pitchOrg -4` note mel `7.405 -> 5.560` with exact core pitch, but no generalization to `pitchTest -4` | No | Future downward-specific hybrid study |
| `TR-PHASE-LOCK-COHERENCE` | Peak-locked phase coherence around harmonic bodies | `FAM-PHASE-LOCK-PV` | `P1` only showed a selective `pitchTestOrg +4` engagement, but the resulting note/entry regression was not worth harvesting as a kept trait | No | Future phase-coherent DSP family only if a materially different implementation is defined |
| `TR-HPSS-MEDIAN-TRANSIENT` | Median-filter transient preservation without body invasion | `FAM-HPSS-MEDIAN` | `Hm1` engaged on `pitchOrg +4`, but the shell still dragged the note body off pitch (`-55.55` cents) and worsened note/entry mel, so there is no keepable transient-preserve trait yet | No | Future HPSS median family only if a materially different shell is defined |
| `TR-SF-HARMONIC-ENVELOPE` | Harmonic-only spectral-envelope preservation on top of a stronger shell | `FAM-HPSS-MEDIAN-SF` | Pending family implementation | No | Future HPSS median + source-filter family |
| `TR-ML-RESTORE` | Offline restoration of residual pitch-shift artifacts | `FAM-ML-RESTORATION` | `M1` proxy benchmark proved the harness can improve the easier `pitchOrg +4` case, but it materially harmed `pitchTestOrg +4`, so there is no keepable restore trait yet | No | Future offline restoration benchmark |
| `TR-TRANSITION-HQ` | Transition-focused shell/core/residual overlay | `FAM-TRANSITION-HQ` | `M1` engaged cleanly and exposed useful diagnostics, but it worsened both `+4` truth cases and produced no keepable transition trait | No | Future engine-v2 work only if a materially different transition model is defined |

## Active Queue
1. Stronger ML / external benchmark only
   - keep the offline benchmark harness and diagnostics
   - do not reopen local ML restoration on another proxy or tuning-only pass
   - only continue once a materially stronger restorer or outside/licensed benchmark path is available
2. `FAM-ENGINE-V2`
   - keep the branch frozen as comparison evidence and for user audition only
   - do not spend main tuning budget here unless a materially stronger decomposition/transition model is defined first
3. `FAM-ENGINE-V3` only after a stronger decomposition design exists
   - do not continue from the current `V3-1` probe
   - require a materially stronger transient/core/residual decomposition and transition-pair ownership design first
4. `FAM-PVDR` reopen only if a materially different stable implementation is ready
   - do not reuse the rejected resample-plus-phase-lock overlay
   - only reopen with a more stable phase-gradient or otherwise fundamentally different phase-coherent implementation
5. External benchmark decision
   - trained ML restoration program
   - or outside/licensed renderer benchmark

## Stop List
- Do not revisit `FAM-SCALAR` without a new structural reason.
- Do not revisit `FAM-BODY-A`, `FAM-BODY-B`, `FAM-BODY-C`, or `FAM-BODY-D` as standalone handoff architectures.
- Do not revisit `FAM-CONT-E1` or `FAM-CONT-E2`.
- Do not revisit `FAM-ISLAND-F` or `FAM-ISLAND-G` as-is.
- Do not revisit `FAM-V2-HSR` as implemented on 2026-04-15; that residual-layer shell has been tested and removed.
- Do not revisit `FAM-V2-SYNTH-CORE` as implemented on 2026-04-15; that directly synthesized island-core pass has been tested and removed.
- Do not revisit `FAM-HPSS-SHELL` as implemented on 2026-04-15; it improved the easy-note onset score but collapsed note/body quality and never generalized to `pitchTest +4`.
- Do not revisit `FAM-WSOLA-SEAM` as implemented on 2026-04-15; the only engaged case (`pitchOrg +4`) got worse, and the other canonical truth cases stayed identical to `FAM-ADAPTIVE-SELECTOR`.
- Do not revisit `FAM-PHASE-LOCK-PV` as implemented on 2026-04-15; the only engaged case (`pitchTestOrg +4`) still lost on note mel and entry despite selective boundary alignment.
- Do not revisit `FAM-HPSS-MEDIAN` as implemented on 2026-04-15; it finally used a real median-filter shell, but the only engaged case (`pitchOrg +4`) still regressed on body pitch, note mel, and entry.
- Do not revisit `FAM-PVDR` as implemented on 2026-04-15; the first resample-plus-phase-lock overlay failed catastrophically on `pitchTestOrg +4`.
- Do not revisit `FAM-TRANSITION-HQ` as implemented on 2026-04-15; the transition overlay engaged on both `+4` truth cases but worsened both, especially `pitchTestOrg +4`.
- Do not revisit `FAM-ADVANCED`, `FAM-FORMANT-ONLY`, or `FAM-PITCH-PLUS-FORMANT` as standalone truth-case candidates.
- Do not revisit `FAM-CORE-PSOLA`, `FAM-CORE-MODEL`, or `FAM-OWN-PITCH` as standalone editors; harvest only explicitly proven traits.
- Do not retry pure WORLD end-to-end rendering.
- Do not spend more tuning cycles on local Stage B / blend-shape patching in the current Signalsmith-centered handoff family.
- Do not keep rejected renderer families alive just because one trait was useful; harvest the trait and remove the dead path.
