# Runtime safety and recovery

This guide records the runtime contracts, supported limits and repeatable checks.
Implementation history belongs in Git; generated logs, dumps, screenshots and
performance reports belong in ignored `output/` folders. Open product work lives
in [the roadmap](roadmap.md). Passing deterministic checks does not qualify
subjective audio quality, arbitrary plugins or every device configuration.

## Audio processing and processor faults

- Callbacks use prepared storage and bounded work. Do not add blocking locks,
  file reads, reader construction or heap allocation. Reject unprepared,
  oversized and unsupported buffers before copying or processing them. Validate
  sidechain source lengths and offsets against the complete declared bus layout.
- Host-detected processing exceptions, non-finite output and buffer violations
  latch a fault by processor identity. Reordering retains it. Track effects use
  the existing latency-aligned dry fallback; failed instruments are silenced.
  Master/monitor failures use their existing continuity path. This does not
  guarantee an inaudible transition or contain arbitrary memory corruption.
- Retry is explicit: bypass/re-enable or reload the processor. Device preparation
  also resets the latch. Never retry a faulty processor every callback. Fault
  notifications identify the track, chain, slot and reason; NAM's internal safety
  counters remain separate from outer host faults.
- Finite-value checks have a cost proportional to samples, channels and stages.
  Timing under Debug or ASan does not measure production capacity. Immutable
  graph snapshots retain processor owners while readers remain active; resource
  release must still quiesce device/MIDI callbacks.
- Validate waveform-cache headers, source identity and allocation footprints
  before loading them. Keep generation cancellable. The `.ospeaks` format has
  one canonical path; invalid or stale caches are regenerated.

## Project, recording and AI recovery

Explicit Save preserves the previous on-disk project in a recovery generation
before publishing the replacement through a checked temporary write. A failed
write must preserve the original and leave edits dirty. Save completion checks
project identity and edit/command revisions, so edits made during an asynchronous
save are not incorrectly marked clean. Project-file workers are owned and joined.

Previous explicit-save versions live beside the project as
`name.osproj.recovery-N.osproj`. Optional periodic snapshots live under the user's
application-data `OpenStudio/Recovery/<session>/<document>` directory, including
untitled work. The version preference is bounded to 1..20. Auto-backup remains
**off by default**; periodic snapshots do not replace the main file or clear the
dirty flag. Without a snapshot before an interruption, there is nothing to restore.

Startup discovery excludes live sessions. **File > Check Interrupted Session
Recovery** repeats discovery. Restore opens an unsaved copy; plugin bypass is an
explicit troubleshooting option. Dismissal acknowledges a reminder while retaining
the source files. Clean-close and save markers retire applicable project snapshot
reminders; retained files are not automatically pruned across sessions.

Recording and AI work journals are independent of optional project snapshots:

- Recording repair writes a unique new PCM file and preserves the original. It
  can recover only complete samples that reached disk, including samples beyond
  a stale WAV header. Report known drops/incomplete tails; never invent lost input.
  Importing recovered audio and its optional new track is one undoable operation.
- AI recovery restarts a saved request/seed or resumes import of completed audio.
  It is not a GPU-step checkpoint. Source workflows verify the original project
  and source identity; missing or changed sources block restart. A completed audio
  artifact may still be imported explicitly.
- Adding recovered or generated audio to the session is not a durable save.
  Keep its journal discoverable until a successful **explicit project save**
  contains that clip's `recoveryJobId`, or the user explicitly dismisses it.
  Failed saves, unrelated documents, undo before save and periodic snapshots do
  not retire that reminder. A later job-status update must not undo a saved marker.
- AI job ownership outlives form/header mounts. Track deletion or project/source
  changes cancel the owned request. A cancel before the start reply waits for its
  request ID; it must never cancel another job. Check identity again after media
  preparation before inserting clips. Bound progress retries; never retry imports
  automatically. Persist the completed artifact before its undoable insertion.

## Workers, shutdown and crash evidence

Background workers have owned lifetimes, completion tokens and cooperative
cancellation. Tokens reject callbacks to retired objects but do not replace joins.
Stop producers and drain workers while their dependencies still exist. Never kill
an in-process thread and resume using potentially corrupted shared state.

Encoding/video subprocesses are owned as process trees: Windows Job Objects and
POSIX process groups. Output reads and per-poll draining are bounded so a silent
or noisy child cannot prevent timeout/cancellation. POSIX keeps the group leader
waitable until teardown, preventing reuse of its process-group identity before
owned descendants are terminated. These paths require native qualification on
each supported platform.

The external Windows crash reporter is a hidden helper copied beside the app.
It retains parent/report handles, captures failures and publishes dumps only after
successful writes. Failure preserves prior evidence and reports the OS error.
The diagnostic ring is bounded and control-thread flushes are rate-limited;
normal audio callbacks must not stream logs to disk. Nothing is uploaded automatically.

The external shutdown deadline applies only after committed final quit, after
unsaved-change decisions. It may terminate the already-quitting process after
60 seconds. It must not terminate ordinary running sessions or unsaved-change
prompts. Without the reporter, safe joins can remain unbounded for uncooperative
native work. OS termination, power loss or storage failure can also prevent reports.

Diagnostics use `AppPaths::diagnostics()`: `~/Library/Logs/OpenStudio` on macOS and
JUCE's resolved Documents/OpenStudio directory elsewhere. Preserve crash/hang
breadcrumbs, current/previous/pending dumps and matching binary symbols before
rebuilding. Dumps can contain private paths and process memory. Use
`tools/archive-runtime-symbols.ps1 -Configuration Debug` (or Release/ASan) to
retain matching EXE/PDB hashes under ignored `output/symbols`.

## Opt-in plugin isolation

**Separate process (crash protection)** in the plugin browser is a Windows,
same-user crash boundary, not a security sandbox. The preference must be saved
before Add and applies on the next load, including project reopen. Existing
instances and built-ins remain in-process. Failed isolated loads do not silently
fall back to in-process hosting.

The first isolated host supports fixed bus layouts, up to 32 active audio channels,
8192 parameters, 128 MIDI events/2048 payload bytes per quantum, and 64 MiB opaque
state. It adds two transport quanta to latency, reported through PDC. ARA and live
bus-layout changes are unsupported. Plugin memory/CPU is additional to shared
transport storage; isolation is not a parallel-track scheduler or a capacity promise.

Crashed, hung or invalid workers quarantine locally. Explicit **Restart worker**
restores the last acknowledged opaque state, not arbitrary unsaved editor changes.
There is no automatic restart loop. State capture must apply pending generic
parameter revisions under the worker's processor mutex even while playback/device
processing is stopped. Native editors retain vendor controls; generic controls
expose normalized parameter values. Offline export must retain latency alignment.

## Platform behavior and preserved product decisions

- Microphone authorization is app-owned and asynchronous on macOS. Startup stays
  output-only until authorized, including before restoration of saved input masks.
  Request input access for an explicit hardware Record/Monitor action. Denial must
  leave playback, editing, MIDI-only recording and offline rendering usable.
  Preserve saved input preferences and cancel deferred completions safely.
- Internal plugin settings initialize lazily in macOS Application Support. Existing
  OpenStudio inventory, blacklist, search paths, scan marker and hosting policy are
  validated, copied and read back before atomic publication; originals remain.
  Do not redirect audio recordings, user Effects/Scripts or the entire Documents
  tree. The deliberate retired-format compatibility policy is documented in
  [product naming](USER_MANUAL.md#file-formats-and-upgrade-compatibility).
- Main and detached WebViews must reach frontend `boot-ready`. Retain the shared
  browser option factory, watchdog, writable per-user data and delayed/retired
  teardown. A startup self-test or Debug launch does not qualify installed Release.
  MIDI docking/focus follows explicit commands and the main window's authority.
- Open panels share available height and scroll when compact; do not automatically
  collapse them. Preserve working two-finger scrolling while qualifying pinch and
  modified gestures. Buffer choices must reflect the active device's reported sizes.
- NAM Connect belongs beside connection status in the right-hand library results
  panel and does not block the rack. Authentication is per OS user/computer across
  windows, restarts and compatible upgrades; another computer authorizes separately.
  Keep stale searches from replacing current results. See [NAM Rack](nam-rack.md).
- The user chose zero-cost distribution work. Preserve the unsigned macOS route
  alongside optional signing/notarization; do not make paid enrollment a prerequisite.
  Signing, quarantine diagnostics and actual first-launch qualification are distinct.
  Windows installation must detect and verify prerequisites and retain useful errors.
  Follow the [release runbook](release-runbook.md) and [smoke checklist](release-smoke-checklist.md).
- The reported Mac crash used the Mixer Monitor FX picker on an M4 MacBook Pro with
  32 GB RAM, likely release v0.1.01. The plugin may have been AmpliTube or NAM Rack;
  its identity, exact OS/build and root cause remain unverified. Original logs were
  unavailable. Do not attribute the crash to NAM or repeat requests for those logs.

## Repeatable qualification

Run checks against the exact configuration being reviewed. Generated results must
remain local artifacts; a previous run does not qualify a changed executable.

| Check | Entry point | What it establishes |
| --- | --- | --- |
| Frontend contracts and packaging | `cd frontend`, then `npm test`, `npx tsc --noEmit`, `npm run build` | State/bridge contracts, types and packaged assets |
| Runtime and crash recovery | `tools/run-runtime-safety-regression.ps1 -Configuration Debug` | Buffer, lifetime, durability and injected process-failure contracts |
| Isolated processing | `tools/run-isolated-plugin-regression.ps1 -Configuration Debug` | Transport, state, fault, restart and proxy allocation contracts; editors require explicit opt-in |
| NAM Rack | `tools/run-nam-rack-headless-regression.ps1` | Deterministic state/routing/DSP invariants; separate diagnostic and subjective results |
| Browser field fixture | `tools/field-test-browser-regression.js` through Playwright CLI | Layout, dialog, gesture and mocked library flows; not native OS/provider behavior |
| Release entry gates | `python -m unittest discover -s tests` | Notes, signing/submission and packaging validation with disposable fixtures |
| Capacity diagnostic | `tools/run-runtime-capacity-diagnostic.ps1` | Signal invariants and timing measurements, not a supported maximum track count |

Use `-SkipBuild` only when the selected binary is current. Run ASan and Release
separately where supported; ASan is not a race detector. Report deterministic
contracts as `pass`/`fail`, timing and uncalibrated audio metrics as `diagnostic_only`,
and unperformed hardware/provider/subjective checks as `not_asserted`. The small
EQ/compressor capacity fixture excludes real file/recording, routing/master FX,
NAM, third-party processing and UI load. Its Debug runs have missed deadlines;
passing Release samples do not establish a universal 100-track capacity.

Native/lab qualification still needs physical ASIO/WASAPI/Core Audio lifecycle,
real vendor editors/licensing, macOS TCC grant/deny/relaunch, provider/Keychain
restart/refresh, downloaded DMG/Finder launch and clean-VM installer/upgrade flows.
Use disposable projects and expendable storage for full/slow/unplugged recording
checks, never the user's only take or normal drive. For sustained capacity, add
real readers/writers, NAM/vendor FX and routing progressively; retain deadline
counts, working-set growth, project/plugin versions and binary identity over an
hour at each supported buffer. Subjective sound quality requires audition of the
exact artifact/live path. See [testing](testing.md) for the broader checklist.

Before a manual Windows handoff, rebuild `frontend/dist`, then complete
`cmake --build build --config Debug` to refresh copied `webui`. Stop task-owned
servers and harness browsers and verify port 5183 is free. The normal launch
`python build.py dev --run` starts what it needs; no pre-running server is required.

## Metronome practice contract


1. Use one integrated Enable (metronome icon) and Play/Stop Click control in
   the main bar and Metronome Settings. Enable is highlighted when either the
   playback preference or click-only mode is on; disabling it stops both.
   Enabling from fully off sets the usual Play/Record preference without
   starting transport or click-only. Keep the existing metronome shortcut;
   no new shortcut or global key action.
2. Click-only is an independent, session-only latch. While stopped, it sounds
   the click and preserves live input monitoring, but does not start clips,
   recording, automation, MIDI transport or playhead movement. Start on beat one.
3. Play or Record makes the same click generator follow the project position,
   tempo and meter. Never run a second overlapping metronome. Click-only keeps
   the click audible even if the ordinary transport-click preference is off.
4. Pause/Stop returns an active click-only latch to its independent clock,
   continuing from the last rendered beat phase. Press its button again to stop
   that latch. If transport is running and its ordinary click is enabled, that
   ordinary click continues. Explain this distinction in the modal/tooltips.
5. Closing the modal does not stop practice. New/open project, application
   restart and engine/device shutdown clear practice; it must not auto-resume
   from saved project or recovery data. Offline export never includes practice
   unless the existing explicit metronome-export setting calls for a click.
6. Handle rapid toggles, native bridge failure, disabled/missing audio device,
   stopped seeks, play/record handovers, loop wraps, tempo/meter/volume changes,
   custom sound replacement, mono/stereo output and arbitrary callback lengths.

### Enable-control clarification (2026-09-06)

The original "Transport click" label was confusing, and the icon could appear
off while click-only was running. It now reads "Enable" with the metronome icon
and reflects either active mode. The Enable toggle and click-only requests
share an ordered mutation queue; Disable stops practice before clearing the
ordinary preference. Native failures retain the last confirmed state, including
an in-flight start followed by a failed stop. No DSP changes were needed.

Verification: 2,232 frontend tests pass, including nine additional enable/disable,
failure and queue-ordering cases. Twelve real-browser mock-bridge checks pass
for both button locations and modal geometry at 1280/640/360 pixels. Updated
screenshot: `output/playwright/metronome-enable-modal.png`. This does not change
the outstanding live-ASIO qualification below.
