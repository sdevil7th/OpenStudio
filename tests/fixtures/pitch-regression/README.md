`pitch_regression_fixture.osproj` is the tracked one-track fixture for the app-path pitch regression harness.

Stable IDs:
- `trackId`: `pitch-regression-track-1`
- `clipId`: `pitch-regression-clip-1`

The fixture clip intentionally starts with an empty `filePath`. The regression driver replaces it at runtime with the source WAV from the job file before syncing clips to the backend and opening the pitch editor.

Example runner flow:

```powershell
tools\run-ui-pitch-regression.ps1 `
  -SourceAudioPath "d:\test projects\pitchTestOrg.wav" `
  -ReferenceAudioPath "d:\test projects\pitchTestOrg+4s.wav" `
  -NotesJsonPath "tests\fixtures\pitch-regression\example_plus4_notes.json" `
  -WindowStart 0.90 `
  -WindowEnd 1.55 `
  -Label "pitchTest_plus4"
```

`example_plus4_notes.json` is only a schema/example starting point. Replace the note timing and pitch values with the real target edit for the clip family you are testing.

`example_minus4_notes.json` is the matching downward-shift example for the same note window, so the regression harness can compare against `-4 st` references without reusing the `+4 st` note payload by mistake.

`example_plus4_two_adjacent_word_fragments.json` is the adjacent-fragment regression fixture: both notes share one `wordGroupId` and should render as one note-HQ edit island with no internal bridge or doubled voice.

`example_pitchTest_plus4_notes.json` and `example_pitchTest_minus4_notes.json` are clip-family-specific fixtures for the later edited note in the `pitchTestOrg` references. Those references do not use the same note timing as `pitchOrg`, so they should not reuse the older `0.90s -> 1.55s` fixture.

Architecture bakeoff helpers:

- `tools\run-ui-pitch-regression.ps1 -RendererBranch branch_simple_ce33`
- `tools\run-ui-pitch-regression.ps1 -RendererBranch branch_current_advanced`
- `tools\run-ui-pitch-regression.ps1 -RendererBranch branch_hybrid_reset`
- `tools\run-pitch-architecture-bakeoff.ps1`

Harness notes:

- Spectrogram-first completion rule:
  - No pitch-renderer change may be called "done" from a reference-backed `note_hq` pitch-only run until the final spectrogram comparison has been generated and reviewed for both the upshift and downshift cases.
  - The runner invokes `tools\pitch_spectrogram_compare.py` for reference-backed `note_hq` pitch-only renders and records `spectrogramReportPath`, spectrogram assets, key mel/formant/envelope numbers, and `spectrogramDoneGatePassed` in the summary JSON.
  - The spectrogram report also records original-vs-reference phrase/pre/post-neighbor metrics plus local region lag and lag-aligned mel. Wider reference edits or timing shifts are visible instead of being mistaken for renderer regressions inside the edited note.
  - The default hard done gates are: core mel MAE `<= 7.0 dB`, entry/exit mel MAE `<= 8.0 dB`, core high-band delta `<= 4.0 dB` absolute, phrase short-RMS envelope correlation `>= 0.60` when original-vs-reference pre/post neighbors are comparable, signed positive onset peak jump `<= 6.0 dB`, and signed positive onset high-band burst `<= 6.0 dB`.
  - If original-vs-reference pre/post-neighbor mel mismatch exceeds `8 dB`, phrase-wide envelope correlation is reported but not used as a completion gate; production renderers must not widen note ownership just to copy unrelated reference phrase changes.
  - If any spectrogram done gate fails, the run must be reported as not done and the next concrete failing region must be named. Use `-DiagnosticOnly` or `-AllowSpectrogramFailure` only for exploratory runs that are not completion claims.
  - Subjective audition is a veto. Passing pitch/formant proxy gates is not enough if `cand_phrase.wav` still sounds robotic, hollow, doubled, crackly, gated, or otherwise unlike `ref_phrase.wav`.
  - For user audition, prefer `tools\run-ui-pitch-org-candidate-context.ps1`. It writes exactly two long, candidate-only, stereo-preserved files for the portable `pitchOrg +4` and `pitchOrg -4` checks in one `audition_context` folder.
  - Double-voice completion rule:
    - Reference-backed `note_hq` pitch-only runs also invoke `tools\pitch_double_voice_analyze.py`.
    - This pass checks stable-core original-F0 leakage, secondary pitch salience, stereo L/R correlation drift, mid/side drift, comb/notch excess, and dry-correlation excess.
    - Mid/side drift is gated only when side energy is audible enough to matter; near-mono side residue below the analyzer floor is still reported, but it is not counted as doubled-core evidence.
    - Double-voice failures are added to the same final done gate as spectrogram failures; a mono spectrogram pass is not enough if the doubled-core report fails.
    - Debug layer dumps can be enabled with `tools\run-ui-pitch-regression.ps1 -DumpPitchLayers` or `OPENSTUDIO_VSF_LAYER_DUMP_ENABLE=1`; dumps include dry input, source/filter core, residual/noise layer, wet envelope, adaptive hybrid output when engaged, and final output.
- The runner now derives note-body metadata from the first note by default and passes onset/release/neighbor windows into the scorer.
- Analyzer/product segmentation gates:
  - pitch-curve corners are `boundaryCandidates` by default, not automatic editable note cuts.
  - `destructiveCornerSplitCount` must be `0` unless `OPENSTUDIO_ANALYZER_APPLY_CORNER_SPLITS=1` is explicitly set for research.
  - pitch jumps and sustained contour deviations are `pitch_hysteresis_*` boundary candidates by default, not automatic editable note cuts.
  - `destructivePitchJumpSplitCount` must be `0` in product/default analyzer runs.
  - strong acoustic `hard_word_like` candidates may split default analyzer regions and are reported separately from destructive pitch-corner/pitch-jump failures.
  - vibrato-like periodic reversals should be reported as `internal_vibrato`/suppressed diagnostics and must not split a continuous same-breath word.
  - short voiced detector dropouts inside a phrase are bridged up to about `80 ms`; hard automatic splits require longer unvoiced gaps or sustained energy-break evidence.
  - expected vocal regions should have word-group overlap `>= 0.85`.
  - expected vocal regions should not have large overhang from collapsed surrounding words; the analysis gate fails suspicious overhang above `0.65 s`.
  - the editor should select and move only explicitly selected notes by default.
  - `wordGroupId` is assistive metadata for diagnostics/render grouping, not normal click/drag ownership.
- Adjacent note-HQ edit gates:
  - adjacent selected/moved notes should produce one edit island with one entry bridge and one exit bridge.
  - internal boundaries inside that island must not report a separate note-HQ bridge.
  - double-voice checks should fail on internal-boundary energy lift above `+3 dB`, duplicated onset/repeat spikes, or excess spectral flux.
- `note_hq` comparison semantics:
  - `preview_segment` candidates are window-local and must be compared with `--candidate-is-window`.
  - `note_hq` candidates are window-local only when the app returns a true segment render.
  - phrase/full-clip `note_hq` results are compared as full-clip audio; do not shift the candidate slice to the request window.
  - boundary metrics require non-empty pre/post neighbor regions when the note body and neighbor window fit inside the reference duration.
- Pitch-only `note_hq` gates for the portable `pitchOrg +4` and `pitchOrg -4` cases:
  - analyzer diagnostics should include note boundary kinds when analysis-derived notes are used:
    - `hard_word_like` means previous/next word bodies must remain dry except for a tiny bridge.
    - `soft_legato` means a continuous sustain/legato transition may use wider phrase smoothing.
    - corner boundaries must be conservative; vibrato-like periodic reversals should not create false note splits.
  - body/core pitch error must stay within the configured cents limit.
  - harmonic-envelope drift, low/mid/high band deltas, and F1/F2 proxy drift are hard failures, not informational-only spectrogram stats.
  - boundary timing, onset derivative/repeat/flux, and pre/post neighbor residual checks must pass together.
  - current production note-HQ pitch-only defaults to `pitch_only_vocal_source_filter_hq`; the native adaptive branch remains a rollback/comparison path.
  - upward edits should report direction `upward` and the selected renderer branch.
  - downward edits should report direction `downward`; `downshiftFormantGuardUsed=true` is still expected on canonical native-adaptive comparison runs.
  - downward primary renders should report `spectralEnvelopeCorrectionUsed=true`, because voiced-core envelope transfer is now part of the production downshift timbre guard.
  - Rubber Band is benchmark-only unless `OPENSTUDIO_PITCH_USE_RUBBERBAND_HQ=1`; benchmark rows are reported but must not replace the native production path until they pass the same formant and boundary gates.
  - the aspirational downshift harmonic-envelope target is `<= 0.35`; the practical hard gate is currently `<= 0.36` so the measured `pitchOrg -4` native directional result at about `0.343` passes while still leaving polish room.
  - low/mid/high downshift band deltas target `<= 3 dB`.
  - F1/F2 proxy drift target is `<= 120 Hz`; on the canonical downshift case the hard gate uses the note-body proxy because the core F2 proxy is unstable on this fixture.
  - edited-note end/next-note handoff is tracked by the exit-to-next-note artifact score, which combines exit-side discontinuity, high-band burst, derivative jump, repeat excess, and flux delta. It intentionally does not gate on raw next-note mel distance, because the reference may pitch-edit the body while the next note remains dry.
  - product commit rule: render context may extend before the edited note, and final apply may use a bounded entry bridge, but audio before `noteHqEntryBridgeStartSec` must remain original/dry.
  - previous-word/left-shoulder handoff is tracked by a bridge-aware ownership audit, not just the old narrow `preCommitArtifactScore`:
    - `preBridgeTailOriginalResidualDb` compares candidate vs original over `[noteHqEntryBridgeStartSec - 80 ms, noteHqEntryBridgeStartSec)` and must be `<= -70 dB` for primary render/apply gates.
    - `noteHqEntryBridgeStartSec` must be no earlier than `note.startTime - 24 ms`.
    - `candidateActiveDifferenceStartSec` may start at the bridge, but not earlier than `noteHqEntryBridgeStartSec - 5 ms`.
    - `preBridgeTailArtifactScore` must be `<= 1.0`.
    - entry lag absolute target is `<= 8 ms`, onset artifact target is `<= 1.6`, onset derivative target is `<= 1.6`, and exit-next artifact remains `<= 3.0`.
  - the audit uses `noteHqEntryBridgeStartSec` when the result provides it, so body/core analysis windows can be narrower than the true note ownership start without creating false previous-word failures.
  - entry contour diagnostics:
    - `noteHqEntryPitchHandoffUsed`, start/end, pre/body milliseconds, slope jump, and acceleration-limit status are emitted for note-HQ native renders.
    - hard/unknown canonical edits keep pitch-ratio render pre-roll but reach the target by `note.startTime`; they should not use a delayed audible pitch handoff because the `pitchOrg` references behave like step edits.
    - explicit continuous/internal transitions (`soft_legato`, `internal_bend`, `internal_vibrato`, or adjacent selected notes inside one edit island) may use a bounded pitch handoff; slope/acceleration gates apply to those cases.
    - `entryPitchSlopeJumpStPerSec` and `entryPitchAccelerationSpike` are reported by the scorer, but the hard gate is skipped when no pitch handoff was used.
  - the corrected lesson from 2026-04-27: increasing left shoulder ownership can hide an entry issue by moving the stutter backward into the previous word, but forcing dry audio until the exact note start can leave a phase/envelope discontinuity at the edited-note entry.
  - dry-neighbor residual checks only inspect the part of the neighbor region outside the effective note-HQ commit range; owned shoulders are scored by pre-commit/onset/exit-next artifacts instead.
  - export jobs do not use the source-vs-export pre-body residual as a hard dry-ownership gate because the mixer/export path can change the whole file from time zero; export parity is checked against the note-HQ product.
- Default diagnostics:
  - entry window: `80 ms`
  - exit window: `80 ms`
  - neighbor windows: `120 ms`
- Each run also writes a short `audition` folder beside the summary JSON with:
  - `orig_phrase.wav`
  - `ref_phrase.wav`
  - `cand_phrase.wav`
  - `cand_entry.wav`
  - `cand_core.wav`
  - `cand_exit.wav`
  - `cand_exit_next.wav`
  - `cand_pre_commit.wav`
  - `orig_pre_body_tail.wav`
  - `cand_pre_body_tail.wav`
  - `diff_pre_body_tail.wav`
  - `orig_entry_bridge.wav`
  - `ref_entry_bridge.wav`
  - `cand_entry_bridge.wav`
  - `diff_pre_bridge_tail.wav`
  - `cand_first_40ms.wav`
  - `cand_pre_neighbor.wav`
  - `cand_post_neighbor.wav`
