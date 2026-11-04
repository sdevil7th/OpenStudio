# OpenStudio 0.1.09 candidate qualification

Unpublished candidate selected on 4 November 2026. No release tag, Store
submission, publication or public website/update-feed change has been created for it.
The user requested certification checks and a release PR, with publication held.

## Current evidence

- **Pass — complete Windows candidate, locally:** Release and Debug were rebuilt
  with callback profiling compiled out and no C++ warnings. The current frontend
  build and all 3,136 tests passed; the native render/export matrix passed all 422
  checks. The frozen 0.1.09 Support executable passed collection, privacy, audio,
  MIDI, GUI construction and reviewed-archive checks without external Python/Node.
  The actual MSIX packed/unpacked successfully and every payload hash matched.
  Its Store version is `0.1.9.0` (MSIX requires canonical numeric components);
  the application and notes retain `0.1.09`. This unsigned package was not
  registered over the user's installed Store app or submitted to Microsoft.
- **Pass — full Windows installer and MSIX:** the [final candidate package job](https://github.com/sdevil7th/OpenStudio/actions/runs/41868876801/job/126710168849)
  built the production app, created and validated its MSIX, installed the actual
  setup executable, passed installed window-lifecycle and frozen Support checks,
  and uninstalled it. The [candidate packages](https://github.com/sdevil7th/OpenStudio/actions/runs/41868876801/artifacts/13345943940)
  include the Support display-scaling fix at `d8202953`. WACK and Microsoft's
  account-backed certification are separate checks.
- **Pass — full Linux candidate:** the [final Linux job](https://github.com/sdevil7th/OpenStudio/actions/runs/41875186464/job/126732566058)
  built the production app and Support, installed the actual DEB, checked normal
  and safe desktop launches, render/features, and the AppImage payload and
  launchers. The [candidate packages](https://github.com/sdevil7th/OpenStudio/actions/runs/41875186464/artifacts/13348345909)
  are from `8f75022a`, with the same production app/Support source as `d8202953`.
  AppImage launcher
  tests used extract-and-run mode; physical desktop/FUSE and Fedora RPM
  installation remain in the manual matrix.
- **Pass — final Windows browser checks:** all four groups at `8f75022a` passed,
  with 295 passing cases and 33 native-schema/explicit-input skips, zero failures and zero
  retries. The [run](https://github.com/sdevil7th/OpenStudio/actions/runs/41875186464)
  retains the evidence. Earlier Windows runs exposed two test-fixture problems:
  driver round trips made a
  purported sustained gesture exceed its 200 ms idle boundary, and a second
  full-screen 4K screenshot consumed the interaction deadline. Corrected focused
  cases pass without relaxing the behavior assertions. A separate run
  failed to load Vite's React refresh module with `ERR_NO_BUFFER_SPACE`; the
  Windows suite is now split across four hosts, retaining all tests and zero
  retries. Linux's earlier full browser suite passed. The final rerun found a
  test-loader failure before the transport-key assertions: Chromium discarded
  the evaluation's pending module-import promise. That fixture now uses the
  existing document-owned loading pattern from the ruler/track-copy tests,
  without changing keyboard assertions. Its focused local check passes; the
  Linux groups 1–3 at `8f75022a` passed (218 cases, 33 declared skips), including
  the system WebKitGTK check. Group 4 was cancelled after 30 minutes downloading
  Ubuntu browser dependencies, before its tests started. The remaining group
  still needs a completed run; GitHub initially refused the scoped retry while
  the cancelled run remained open. Linux now also uses four test groups for
  faster feedback, with the system WebKitGTK check retained once per run.
  Native-schema editor tests run separately after the native app build. Tests
  requiring a private project or explicit native tempo-preview input do not run
  automatically in this general browser suite.

Windows package/WACK evidence is from `d8202953`; the Linux package and latest
browser evidence above is from `8f75022a`. Between those commits only CI, a test
fixture, the WACK result checker and this qualification document changed. App,
Support and runtime dependency source is identical. Later documentation updates
do not retroactively change the packaged release notes or certify a new binary.
- **Blocked — full macOS candidate execution:** GitHub repeatedly failed to
  allocate either Mac architecture before any steps ran. The workflow now uses
  supported macOS 15 images and includes installed universal-DMG checks on both
  architectures, but these have not completed for this candidate. No alternative
  runner is configured. The user requested finishing the available Windows/Linux
  work. Native Support builds/tests subsequently passed on both Mac architectures
  in [the current run](https://github.com/sdevil7th/OpenStudio/actions/runs/41875186464),
  but these component checks do not clear the full application/DMG gate.
- **Pass — support packaging:** the [six-job qualification](https://github.com/sdevil7th/OpenStudio/actions/runs/41841385666)
  covers Windows installer/MSIX fixtures, native macOS and universal Finder/DMG
  launches on both architectures, and Linux DEB/RPM/AppImage payload checks.
  This used support version 0.0.0 and a dummy DAW where needed; it does not certify
  a full 0.1.09 application package.
- **Pass — existing application CI:** [PR #36](https://github.com/sdevil7th/OpenStudio/pull/36)
  records all 11 Verify jobs passing at `f45637be`. Its current draft status is
  intentional. As inspected on 4 November, GitHub lists no submitted PR reviews.
- **Fail — existing hardware timing gate:** the recorded Audient ASIO 48 kHz /
  8-sample test added 19 engine deadline misses and 21 host overrun counts during
  a 59.979-second steady recording interval. These are not proven physical driver
  loss or an audition result. See [the exact-artifact report](workflow-review-qualification.md).
- **Fail — fresh candidate 8-sample capacity checks:** see the measured cases
  below. Compiling out the ordinary profiler did not establish the strict target.
- **Blocked — macOS notarization:** the [read-only access check](https://github.com/sdevil7th/OpenStudio/actions/runs/41845529536)
  found none of the six required Apple signing/notarization values in GitHub or
  the configured Doppler project. The user confirmed credentials are unavailable.
- **Blocked — Store account inspection:** the `microsoft-store` environment
  permits only `v*` tags. It rejected the certification branch before any Store
  request. The policy has not been changed. The local installed Store app is
  0.1.8.0; it is not the proposed candidate and must not be replaced for a test.
- **Pass — WACK:** the [final report](https://github.com/sdevil7th/OpenStudio/actions/runs/41868876801/artifacts/13348650296)
  returned aggregate `PASS`, exit 0, on Windows Server 2025 (kit
  10.0.26100.9457), with `PARTIAL_RUN=FALSE` and all 13 required tests passing.
  The earlier required DPI-awareness warning is cleared in the rebuilt MSIX.
  Support has a PerMonitorV2 manifest, event-driven font scaling and scrollable
  content; its frozen PMv2-context and 100/150/200% font-scaling checks also pass.
  Physical mixed-DPI monitor transitions remain **not_asserted**. The tested
  package SHA-256 is
  `158012e4ea54fe0a3a32e9f970ea85abe37dfc56040f73fe173c633666f05f52`.
  This is a certification-kit pass, not Microsoft Store submission or approval.
- **Informational findings retained:** the final WACK XML marks application count
  (the independent Support entry) and blocked-executable references as optional
  failures. Microsoft's [Desktop Bridge test guidance](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-desktop-bridge-app-tests)
  distinguishes these from required tests. Process-launch references span the
  app, Support, Python/Tcl and Microsoft WebView2; this static scan does not prove
  any process was started during recording. The independent launcher remains;
  the strict aggregate WACK gate has not been weakened. S-mode compatibility and
  Microsoft's final certification remain **not_asserted**. WACK itself reports
  aggregate `PASS` with these two optional failures; every finding is retained.

Merging a PR does not currently run Store submission. The release workflow uses
release tags and contains public-release steps. Do not create a `v0.1.09` tag or
run that workflow merely to expose Store actions. A release PR can show ordinary
build/package checks; account-backed submission needs an explicitly permitted,
nonpublishing path and a verified manual publishing hold.

## Fresh Windows hardware evidence — 4 November 2026

Release executable SHA-256:
`84e529369dd7e2655f420f5130558ece85359dd92c470865889b692dcfa5719b`.
The retained local executable hash must be checked against this record before
reusing an artifact. The candidate has `callbackDiagnostics: false` in its build
policy. Support and build jobs were closed during these runs.

The explicitly launched `--nam-live-callback-probe` used the physical Audient
ASIO driver at 48 kHz, one or four NAM tracks with 4x oversampling, three seconds
of warmup and 30 seconds of measurement per case. It supplied synthetic input,
ignored physical microphone input and silenced physical outputs. This probe adds
its own measurement work only while explicitly running; it is not an audition,
a game-contention test or a repeat of the earlier 31-track UI workload.

| NAM tracks | Buffer | Mean / p99 / max callback, microseconds | Late callbacks | Capacity |
| --- | --- | --- | --- | --- |
| 1 | 8 samples | 58.0 / 113.3 / 422.5 | 227 / 180,000 | **fail** |
| 4 | 8 samples | 77.8 / 155.6 / 441.5 | 451 / 180,000 | **fail** |
| 1 | 64 samples | 194.5 / 302.1 / 455.0 | 0 / 22,500 | **pass**, this short case only |
| 4 | 64 samples | 282.3 / 500.0 / 932.8 | 0 / 22,500 | **pass**, this short case only |

The four-track / 8-sample case also recorded 3,425 worker deadline misses and
6,183 quarantined blocks across warmup plus measurement. Other cases recorded
zero worker deadline misses. Those worker figures have a different interval from
the table's measured callbacks and must not be added together. Raw recording
integrity passed in all four cases: exact frame counts, format and synthetic
input comparison within PCM tolerance. Successful raw capture does not establish
continuous monitoring through the overloaded processing chain.

Driver xrun counters were unsupported (`-1`), so physical driver loss is
**not_asserted**. Subjective quality, physical monitoring/loopback latency, game
contention and long-session continuity are **not_asserted**. These data are
**diagnostic_only** for cause attribution. There was no matched before/after
test, so no performance improvement or regression is inferred from the numbers.
Larger-buffer passes do not clear the failed 8-sample gate.

Local evidence is retained under `output/candidate-0.1.09/hardware/`, with
separate `1-tracks/result.json` and `4-tracks/result.json` reports. Those contain
local device/preset details and are not automatically uploaded or committed.

## Physical test matrix

Use copies of projects, and record the candidate file hash, app version, OS,
CPU/core count, RAM, storage type/free space, interface/driver/firmware, sample
rate, buffer size, plugin versions, monitoring route and power mode for every
run. Keep the Support tool closed during every recording/performance run.

| Setup | Minimum coverage |
| --- | --- |
| Windows | Windows 11 on the main recording PC with the actual ASIO interface; the oldest Windows version still advertised on a separate supported installation; WASAPI shared/exclusive and built-in audio where offered. |
| macOS | One Apple Silicon and one Intel Mac, using Core Audio and a physical interface. Include the oldest advertised base-app macOS separately from the newer optional AI-runtime requirement. |
| Linux | A supported distribution with its native installer, the intended PipeWire/JACK/ALSA route and a physical interface. Exercise AppImage separately on a prepared host. RPM installation on Fedora remains separate from archive extraction on Ubuntu. |
| Resource limits | Include the lowest CPU/RAM configuration you intend to support. Record actual usable logical cores; do not infer a low-core result from a fast workstation's average CPU. |

## Recording and latency

1. With Support closed, start with a clean project and a known input. Test each
   advertised sample rate and available device buffer. For the target Audient
   route, explicitly include 48 kHz / 8 samples; then test 16, 32, 64 and 128
   where the driver offers them. A larger-buffer pass does not clear the
   8-sample failure. Do not claim an unsupported device buffer.
2. At each target setting, record at least 30 minutes with the expected maximum
   armed/monitored tracks and actual FX. Include the known demanding case of
   four monitored NAM tracks with the intended oversampling. Then run a two-hour
   session at the normal supported working buffer. These durations are test
   coverage choices, not a guarantee against later failures.
3. During capture, scroll/zoom, resize/open/close the mixer and supported popouts,
   adjust parameters, save, and perform normal punch/loop operations. Check the
   start, stop and transition regions as well as the middle of each take.
4. Use a physical cable loopback at safe levels to record known pulses and a
   continuous reference signal. Measure round-trip latency and take placement
   after the run; verify there are no missing/repeated segments or unexplained
   jumps. Buffer duration alone is not measured round-trip latency. Audition
   the exact take and monitoring path; file length alone does not prove clean
   audio. An independent external recorder can capture the monitoring output.
5. Repeat the same project with the heavy game and usual recording/streaming
   applications running. Keep game settings, frame cap, DAW route and power mode
   fixed. Separately test CPU contention, RAM pressure and disk activity, changing
   one factor at a time. Stop deliberate stress if the machine becomes unstable;
   use expendable project copies.

**Pass:** the declared workload/buffer completes without audible dropouts,
unexpected silence, missing/duplicated recorded frames, recording write failure
or a reproducible latency regression. Where existing counters are available,
record before/after values and their scope; the strict target requires zero
new deadline misses. Record unsupported driver counters as **not_asserted**.
Subjective sound quality requires listening acceptance of the exact artifacts.

For a support-overhead comparison, use the same DAW executable and project with
the companion files present versus absent in disposable copies. Keep Support
closed and verify once before the run that its process is absent. Do not run a
new logger, profiler or recurring process sampler during the baseline. This
comparison isolates the companion; comparing 0.1.08 and 0.1.09 also includes all
the application changes and cannot isolate support overhead.

## Audio, MIDI and export completeness

| Test | Evidence to retain |
| --- | --- |
| Audio mix and stems | Use a small known project with a distinct signal on each track, including the last clip, trims, fades, gain/automation, mute/solo, master/track/input FX and routing. Check whole-project, time-selection, selected-source and queued exports in every advertised format/rate/channel/depth setting. Verify expected sources, boundaries and tails by independent reference and listening. |
| Cold plugin render | Restart, reopen the same saved project and compare first and subsequent renders. Include the plugins with known state/first-export differences. Do not generalize a deterministic WAV match to every plugin. |
| MIDI interchange | Record a physical keyboard/controller; include pedal, pitch bend, overlapping same-key notes and tempo/meter changes. Export the full project, a single clip and selected clips with trims/loops/gaps. Import into another DAW and check notes, channels, order, timing and end-of-file note releases. |
| Failure handling | On disposable files, test a missing source/plugin, cancellation and an unwritable destination. Errors must be visible; partial output must not be presented as complete or overwrite a good existing export. |
| Offline support | Close the DAW, then collect logs and inspect those exports. Review the report and ZIP for private paths, project/media exclusion and opt-in dumps. The tools must not silently claim every track was audible or that a later project is the original export snapshot. |

## Installed application and lifecycle

Use the exact final installer/MSIX/DMG/native package on a clean standard-user
account without developer Python/Node. Check first launch, microphone permission
allow/deny/retry, device reconnect, supported sample-rate/buffer changes, physical
MIDI reconnect, external FX discovery/loading/editors, and every popout's
open/close/reopen/quit behavior. Test different display scales and monitors.
Verify Support remains absent until explicitly opened and that its launch needs
no terminal. Test upgrade/uninstall on disposable machines while preserving
external projects. Actual Store update delivery needs two Store-delivered
versions; local registration does not prove that path.

Do not work around Gatekeeper quarantine and count that as a notarization pass.
Without Apple credentials, record normal first-download acceptance as
**not_asserted** and retain any actual rejection.

## What diagnostics can and cannot establish

The standalone support tool adds no callback hooks or background collector.
Ordinary builds now also compile out callback timing histograms, stage sampling,
arrival-gap profiling and paired trace storage. `OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS`
defaults to OFF; release packaging rejects an enabled or missing build policy.
Timing fields are absent/unavailable, never a false zero-miss pass. The callback
start clock remains because MIDI event placement and worker deadlines need it;
existing meters, transport state and recording/plugin fault handling remain.
Those engine operations are not zero-cost. The promise is no additional runtime
work from the closed support companion, not a claim that the DAW has no existing
status handling or that all workloads meet every hardware deadline.

The next timing investigation should compare the same Release configuration,
interface and 48 kHz / 8-sample setting with a minimal project versus the
retained project, then idle UI versus the recorded gestures. Keep a known
physical input/loopback reference and repeat each condition. Any extra profiler
belongs in a separate explicit diagnostic run; its results cannot qualify an
unmeasured production build. Larger-buffer controls can help attribution but
do not replace the failed eight-sample gate.

A later support bundle can preserve existing failures and examine output files.
It cannot reconstruct the exact CPU scheduling, RAM pressure, driver delay or
game activity at an unobserved glitch. Controlled repeats narrow causes; they
do not prove the historical cause. More precise attribution needs a separate,
explicit diagnostic reproduction with measurement overhead, or evidence already
provided by the OS/device. No such monitor is added to normal DAW use.

Official references: [Microsoft's WACK prerequisites and commands](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-app-certification-kit),
[manual Store publishing holds](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options),
and [Apple's notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
