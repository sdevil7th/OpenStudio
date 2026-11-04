# Workflow review implementation and qualification

4 November 2026; development branch `test-run-1-bugfixes`, based on `e8f9a65a`.
This report covers the staff-review follow-up and final checks of the accumulated
issue remediation. It is not release qualification. Earlier hardware and receiving-DAW
results remain in [the coverage matrix](issue-coverage-matrix.md).

## Implemented

- Joining MIDI clips preserves overlapping same-key note pairs, mute state,
  release velocity and expression. Optional pair identity survives old/new project
  validation, editing, copying and visible trim/loop materialization without a
  schema bump. Metadata edits cannot change an adjacent joined note.
- Real Ctrl+click selection is covered at clip bodies and resize edges. The edge
  path could collapse selection; it now toggles once. Right-click retains selected
  clips. Join shows count, actual shortcut and a disabled reason. The user's exact
  earlier missing-menu session was not captured, so its cause is not asserted.
- **Export Selected MIDI Clips (N)...** and the action catalog share one typed
  export operation. It snapshots content/tempo before the dialog, writes one file
  with source tracks and relative gaps, and leaves the arrangement untouched.
  **Export This MIDI Clip...** is the explicit single-clip alternative.
- The mixer grip shares its existing header row. Pointer resizing does not take
  permanent focus/context; drop, Escape, cancel and blur release ownership.
  Intentional Tab/keyboard resizing remains available.
- Shared fader-floor conversion makes `-inf` exact silence in static, automation
  and offline paths. Project-rate import publication revalidates the target rate;
  the source replacement transaction is checked TypeScript. All conversion jobs
  have accessible names and cancellation, including beyond the first three.
- Tempo work has native request IDs, cooperative cancellation and a dedicated
  queue bounded to one active and one pending request. Closing/changing targets
  retires obsolete work. Waveform requests use their separate service.
- Timeline feedback identifies the blue time range, copying and slipping; range
  actions expose clear, select-clips and loop. Persistent MIDI labels say
  **Source offset**. Slip feedback ends on release. Ordinary tooltip/viewport
  styling uses Tailwind; component CSS retains runtime geometry.

## Verification

Evidence below is local under ignored `output/`; recordings, source media and
trace files are not part of the PR.

| Check | Result and scope |
|---|---|
| Frontend | **pass:** 3,131 tests in 268 files; production and e2e TypeScript; dependency notices and Vite build. `output/staff-review-nov04/implementation-unit-tests-complete.log` |
| Workflow browser | **pass:** 24 menu/export/mixer/tempo/rate-copy cases, followed by five final MIDI/range/slip cases after the final feedback fix. Actual pointer and keyboard events; native boundaries mocked. `implementation-browser-tests-2.log`, `implementation-midi-browser-final-2.log` |
| Supplied-project browser | **pass:** 23 source-backed project, recording-preview, packed-waveform and source-geometry cases. `implementation-project-browser.log` |
| Additional feature browser | **pass:** five crossfade/device-availability/prepared-recording cases and one real native preview-payload decode/click-mix case. `implementation-feature-browser-final.log`, `implementation-native-preview-browser.log` |
| Native regression | **pass:** 421 objective checks, including exact fader-floor silence at 8 and 512 frames and bounded/cancelled analysis work. No audio device opened. `native/20261104_111627_workflow-fixes/render_export_regression_result.json` |
| Native recording writer | **pass:** 30 seconds of actual project PCM, 180,000 eight-frame writes, 648 concurrent peak queries, 10 checks, no FIFO overflow/write failure or lost frames; output matches source within PCM16 quantization. Device-free; timing is diagnostic only. `paced-eight/result.json` |
| Supplied-project render/MIDI | **pass:** 74 native checks, five full-song renders, repeatable 48/44.1 kHz WAVs, valid MP3, MIDI event readback. `project-renders/project_qualification_result.json` |
| Independent render comparison | **pass:** 19,721,766 frames / 4,213 windows; maximum absolute source-mix error 8.943e-8, no missing audio windows. Exact sound-quality acceptance remains **not_asserted**. `project-renders/source-reference.json` |
| Native tempo cancellation | **pass:** ten Analyze/Cancel cycles on a retained source in the supplied project; every cancelled completion and concurrent peak request returned. Peak service 0.7–2.2 ms in this small sample is **diagnostic_only**. `native-tempo-cancel.json` |
| Build/runtime | **pass:** Windows Debug and Release CMake builds; current packaged assets copied. Release main WebView reached the usable project UI and completed recording/save/reopen. This does not qualify every detached-window or platform path. |

## Fresh native eight-sample run

The original project was copied, never saved over. Its SHA256 remains
`c4c8140df666a15d52a56d065d1b6390b0136bae9dfdce35822323018d68ee81`.
Actual device: Audient USB Audio ASIO Driver, 48 kHz, **8 samples** before and after.

- **pass:** 75.037333 seconds / 3,601,792 mono frames saved at position zero;
  42 existing clips preserved, one added take, all 31 tracks and 43 clip IDs
  retained after a genuine native save/reopen. Captured PCM is finite and nonzero;
  the physical source was not identified during this run.
- **pass, functional:** 32 trusted wheel events, eight each plain/Control/Shift/Alt;
  every event changed its intended scroll/zoom/height control while recording
  remained active. No device interruption, nonfinite output, playback lock failure
  or continuity-concealment increment in the measured recording interval.
- **fail, strict timing:** during the 59.979-second steady recording interval,
  host overrun counts increased **21** and engine deadline misses **19**. These
  counters are not proof of physical driver packet loss or audible glitches;
  driver-only xrun telemetry is unsupported on this route.
- **diagnostic_only:** browser event creation-to-listener p95 **47.9 ms**, maximum
  **50.2 ms**. Listener-to-next-main-canvas draw p95 **1.3 ms**. This observer adds
  overhead and does not measure physical input-to-display presentation. Fast canvas
  work does not negate the earlier event-delivery delay. Record/stop completion
  was **267.4/77.3 ms**, not electrical latency.
- **not_asserted:** source continuity against a known reference, electrical or
  metronome alignment, subjective listening and a guarantee of smooth presentation.

Evidence: `output/shared-project-qualification/nov04-workflow-final-eight/workflow-summary.json`
and `output/staff-review-nov04/native-reopen.json`. The prior user-confirmed music
capture remains separate evidence; this run does not replace its audition boundary.

## Remaining engineering and acceptance work

Strict zero-miss eight-sample operation and complete input-to-presentation latency
remain open. Controlled callback/scheduler attribution is needed for the deadline
outliers, and a browser/native presentation trace is needed to attribute the
event-delivery delay. Continuous music alone does not resolve either attribution
gap. Do not raise the buffer or suppress counters to qualify this work.

The measured minified bundle still has a 1,329,584-byte entry chunk (325,899 gzip)
and a 1,040,784-byte FX panel chunk (299,780 gzip). Static consumers make several
dynamic imports ineffective. No warning threshold was raised. Changing shared
store/action boundaries is a separate load-time project, not an evidenced cure
for wheel latency. New native review tests are in their own translation unit;
splitting all historical harnesses into a separate target and adding an unoptimized
diagnostic configuration are deferred build changes, not requirements for these
correctness fixes. The existing optimized Debug behavior is preserved.

Physical Explorer drops, sustained physical MIDI performance, electrical alignment,
subjective audio acceptance and lossless receiving-DAW normalization retain their
individual limits in the coverage matrix. This branch should remain a draft PR
while the strict timing acceptance gate is unresolved.

## November 4 CI follow-up

The first completed Verify run on `06417cc4` passed Windows native qualification,
Python tooling and all three AI policy jobs, but failed six jobs. The three input
profile jobs encountered obsolete `.sticky canvas` selectors; macOS also sent
Windows Control modifiers in the new MIDI and recording-zoom tests. Linux and
both macOS native jobs failed the exact tiny-block parity gate because newly
allocated pre-fader storage was uninitialized before its first capture.

Preparation now clears the pre-fader buffer outside the audio callback. The
existing parity gate retains exact comparisons and adds first-mismatch details
and a poisoned-storage reprepare check. Browser tests address the ruler through
its existing semantic attribute and use the shared platform modifier helper.
The time-selection label also uses a readable `to` separator.

Local verification in `output/ci-nov04/`: **pass** for all 25 targeted editor,
MIDI and recording-zoom browser cases, e2e TypeScript, frontend build, Debug and
Release CMake builds (no native compiler warnings), the complete realtime safety
report including 1,920 tiny-block comparisons and preparation/reprepare clearing,
and all 421 native render/export checks. An initial browser attempt lost its
evaluation context during development-server startup; the complete subsequent
25-case run passed. Remote Windows/Linux/macOS qualification is tracked in the
PR checks and must not be inferred from these local results. These fixes do not
change the strict eight-sample hardware timing and listening limits above.
