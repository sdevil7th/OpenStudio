# OpenStudio 0.1.09 candidate qualification

Unpublished candidate selected on 4 November 2026. No release tag, Store
submission, publication or website/update-feed change has been created for it.
The user requested certification checks and a release PR, with publication held.

## Current evidence

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
- **Blocked — macOS notarization:** the [read-only access check](https://github.com/sdevil7th/OpenStudio/actions/runs/41845529536)
  found none of the six required Apple signing/notarization values in GitHub or
  the configured Doppler project. The user confirmed credentials are unavailable.
- **Blocked — Store account inspection:** the `microsoft-store` environment
  permits only `v*` tags. It rejected the certification branch before any Store
  request. The policy has not been changed. The local installed Store app is
  0.1.8.0; it is not the proposed candidate and must not be replaced for a test.
- **Not asserted — WACK and Microsoft certification:** the Windows App
  Certification Kit is installed locally, but this session is not elevated and
  no real 0.1.09 MSIX has been qualified. Old packages and dummy executables cannot
  establish candidate certification.

Merging a PR does not currently run Store submission. The release workflow uses
release tags and contains public-release steps. Do not create a `v0.1.09` tag or
run that workflow merely to expose Store actions. A release PR can show ordinary
build/package checks; account-backed submission needs an explicitly permitted,
nonpublishing path and a verified manual publishing hold.

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
This is distinct from diagnostics already present in the application branch:
`AudioEngine::audioDeviceIOCallbackWithContext` reads the clock and updates
timing counters even when detailed tracing is disabled, and samples stage
timings every 16 callbacks. `RealtimeCallbackTrace` also allocates its fixed
queue when the engine is constructed. These existing diagnostics are not
zero-cost; their contribution to the observed deadline misses is unmeasured.

Before making a literal zero-overhead claim for all application diagnostics,
audit these operations and their consumers. Compile diagnostic-only work and
storage out of the production configuration if that is the required policy,
while retaining timing needed by actual engine scheduling. A runtime off
switch alone does not eliminate the checks. This is a review finding and a
proposed follow-up, not an implemented or measured optimization.

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
