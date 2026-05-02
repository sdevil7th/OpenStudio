`pitch_regression_fixture.osproj` is the tracked one-track fixture for the app-path pitch regression harness.

Stable IDs:
- `trackId`: `pitch-regression-track-1`
- `clipId`: `pitch-regression-clip-1`

The fixture clip intentionally starts with an empty `filePath`. The regression driver replaces it at runtime with the source WAV from the job file before syncing clips to the backend and opening the pitch editor.

Example runner flow:

```powershell
tools\run-pitch-headless-regression.ps1 `
  -SourceAudioPath "d:\test projects\pitchTestOrg.wav" `
  -NotesJsonPath "tests\fixtures\pitch-regression\example_plus4_notes.json" `
  -TargetShiftSemitones 4.00 `
  -WindowStart 0.90 `
  -WindowEnd 1.55 `
  -Label "pitchTest_plus4"
```

`example_plus4_notes.json` is only a schema/example starting point. Replace the note timing and pitch values with the real target edit for the clip family you are testing.

`example_minus4_notes.json` is the matching downward-shift example for the same note window, so the regression harness can compare against `-4 st` references without reusing the `+4 st` note payload by mistake.

`example_plus4_two_adjacent_word_fragments.json` is the adjacent-fragment regression fixture: both notes share one `wordGroupId` and should render as one note-HQ edit island with no internal bridge or doubled voice.

`example_pitchTest_plus4_notes.json` and `example_pitchTest_minus4_notes.json` are clip-family-specific fixtures for the later edited note in the `pitchTestOrg` references. Those references do not use the same note timing as `pitchOrg`, so they should not reuse the older `0.90s -> 1.55s` fixture.

Renderer selection:

- The tracked deterministic harness allows `default` and `pitch_only_vocal_source_filter_hq`.
- Historical UI/bakeoff helpers are local diagnostics only and are not part of the tracked PR gate.

Harness notes:

- The tracked PR gate is deterministic only: exact requested relative shift, output sanity, renderer branch recording, pitch-only formant curve disabled, and corrected-source route state.
- Spectral, null, residual, and double-voice scripts are local diagnostics only. They must not be used as proof that subjective artifact/timbre issues are resolved.
- Subjective audition remains the pass/fail source for start artifacts, doubled voice, robotic tone, naturalness, formant shift, and timbre.
- Debug layer dumps can be enabled with `OPENSTUDIO_VSF_LAYER_DUMP_ENABLE=1`; dumps include dry input, source/filter core, residual/noise layer, wet envelope, optional local hybrid diagnostics, and final output.
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
  - current production note-HQ pitch-only defaults to `pitch_only_vocal_source_filter_hq`; retired renderer branches are not part of the tracked fixture contract.
  - upward edits should report direction `upward` and the selected renderer branch.
  - downward edits should report direction `downward`; `downshiftFormantGuardUsed=true` is still expected on canonical VSF downshift runs.
  - downward primary renders should report `spectralEnvelopeCorrectionUsed=true`, because voiced-core envelope transfer is now part of the production downshift timbre guard.
  - production note-HQ pitch-only renders use the native VSF path; historical benchmark engines are not part of this fixture contract.
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
