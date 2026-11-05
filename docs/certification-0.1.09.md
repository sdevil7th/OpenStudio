# OpenStudio 0.1.09 candidate qualification

Unpublished candidate selected on 4 November 2026. No release tag, Store
submission, publication or public website/update-feed change has been created for it.
The user requested certification checks and a release PR, with publication held.

## Current evidence

The follow-ups "Mac export/window qualification" and "Neutral EQ precision"
below record the latest source changes and artifact-specific results. PR #36 retains
final-head CI links; earlier results remain tied to their listed artifacts.

**Merge acceptance decision — 5 November 2026:** the user explicitly accepted the
strict 8-sample contention failure as a non-blocking known limitation for PR #36
and requested that optimization work on that target stop. Its measured result
remains **fail**; no threshold, recording-integrity assertion, or timing result is
changed. This is a merge-scope decision, not evidence that further optimization is
impossible, that eight samples is glitch-free, or that larger buffers qualify that
workload. Complete the current Linux checks before making the PR ready. Support
must remain manual-only; publication and Store/notarization remain separate gates.
Earlier statements tying draft status to the 8-sample result are historical and
superseded by this acceptance decision.

Further offline collection, symbol matching and diagnostic-removal changes after
`93d03c15` change the native binary and Support payload. The older installer,
WACK and Linux package results below do **not** certify these new artifacts.
The local verification recorded under "Offline support follow-up" applies to
the new source. No release, Store submission or website deployment was performed.

The 5 November local investigation below changes native NAM preparation and the
explicit diagnostic probe. Final Windows/Linux package checks and WACK passed
at `b6aba8ae`, including the warning-only follow-up to the functional NAM fix.
Each result applies to its listed artifact. The remaining Linux browser check
passed; the strict 8-sample hardware gate still fails. An automatic Mac run also
exposed three geometry-check failures after successful frontend startup.
At that earlier qualification, PR #36 remained a draft with no submitted formal review approval. Subsequent
qualification/release-note edits through `93d03c15` did not change that tested application source.

- **Pass — Linux qualification after the NAM preparation/insertion fix:**
  [job 126802823878](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/job/126802823878)
  at `bba16515` completed the native build, realtime safety fixtures, actual DEB
  installation, normal/safe startup, render/features, AppImage payload checks
  and packaged main/detached-window lifecycle. The retained
  [qualification report](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/artifacts/13356283313)
  and [candidate packages](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/artifacts/13356358288)
  belong to that exact commit. AppImage still uses extract-and-run; physical
  FUSE/interface and Fedora installation are not asserted.
- **Pass — browser checks on that native revision:** all four Windows and all
  four Linux groups in [run 41895223774](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774)
  passed, each platform totaling 295 cases and 33 declared skips. The 3,136
  frontend unit tests also passed. No behavior gate or retry policy changed.
- **Compiler-warning follow-up:** inspection of the successful Linux log found
  one `-Wmissing-field-initializers` warning in preview-segment publication.
  `b6aba8ae` explicitly value-initializes the existing source binding, whose
  defaults remain generation zero and null pointers. It changes no playback
  behavior. Its [completed Linux job](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/job/126818406535)
  has no C++ compiler warnings and repeats the native safety, DEB installation,
  AppImage and packaged-window checks successfully. Its
  [qualification report](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/artifacts/13358612965)
  and [packages](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/artifacts/13359177604)
  retain the exact follow-up evidence. Packaging-tool and Node deprecation
  notices remain in the log; this is specifically a C++ compiler-warning result.
  Local Release and Debug rebuilt without C++ warnings, and all 422 render/export
  checks passed again. The local follow-up Release SHA-256 is
  `d8ea6942a99ddff57ea2ab1c056cc6b57511482d05e096a6cd45b671c3cd7f99`;
  it was not used for the physical timing runs below.
- **Pass — final Windows packages at `b6aba8ae`:**
  [job 126818406515](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/job/126818406515)
  repeated the native, protected-startup, installer/MSIX, installed-app/Support
  and uninstall checks successfully, with no C++ compiler warnings. All 422
  render/export checks passed. CI's NAM run passed 205 objective checks, retaining
  18 diagnostic-only and nine not-asserted items; the additional local-library
  model check is not asserted on the hosted runner, whereas it passed locally.
  The [final Windows packages](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/artifacts/13360003582)
  belong to this exact revision.
- **Pass — final WACK at `b6aba8ae`:**
  [job 126843251747](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/job/126843251747)
  and [report 13361266415](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/artifacts/13361266415)
  record aggregate `PASS`, exit 0, all 13 required tests passing, no required
  issues and `published: false`. The tested MSIX SHA-256 is
  `5a31875dd078ce0f22672bb39ddbb1328a82c67ec38718b9009301282b4d2f01`.
  Both optional findings remain: application count and blocked-executable
  references. This is a certification-kit pass, not Microsoft Store approval
  or S-mode qualification. No test gate was weakened.
- **Pass — Windows packages after the NAM preparation/insertion fix:**
  [job 126802824305](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/job/126802824305)
  at `bba16515` completed the warning-free native build, safety/NAM/render
  regressions, native-schema FX editor tests, protected normal/safe WebView
  startup, actual installer/MSIX construction, installed window/Support checks
  and uninstall. The [packages](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/artifacts/13357514971)
  are unpublished qualification artifacts.
- **Pass — WACK for that functional fix:**
  [job 126824894671](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/job/126824894671)
  and its [retained report](https://github.com/sdevil7th/OpenStudio/actions/runs/41895223774/artifacts/13359366796)
  returned aggregate `PASS`, exit 0, with all 13 required tests passing and
  `published: false`. The MSIX SHA-256 is
  `bb91233deaf1c2ccae87b3ee822a789ae0d572e65b21d07ca27757c000ebc258`.
  Application-count and blocked-executable optional findings remain. This is
  not Store approval and does not certify a later rebuilt MSIX.
- **Fail — newly available Apple Silicon window check:** the automatic
  `b6aba8ae` [Mac job](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/job/126826803610)
  got a runner and built the universal app. Its
  [lifecycle report](https://github.com/sdevil7th/OpenStudio/actions/runs/41899667263/artifacts/13360536593)
  fails `main_move_resize`, `main_bounds_stable` and
  `plugin_restore_preferred_geometry`. Main, mixer, pitch, MIDI and plugin
  documents all reached frontend readiness, and teardown/no-hardware checks
  passed. This narrows the failure to geometry assertions; it does not establish
  whether the cause is application behavior or the hosted display constraints.
  Full DMG construction/installed qualification was skipped after the failure.
  The compiler also reports five distinct unnecessary lambda captures in
  `NAMFuzzRegression.h`, `AudioEngine.cpp`, `FreePluginReverbBalance.h` and
  `FreePluginRegression.cpp` (repeated for both universal slices). The Windows/
  Linux warning-free results do not imply a warning-free Mac build. Universal
  Support component launch tests passed on both Mac architectures. No manual
  rerun or new Mac workaround was attempted; notarization remains blocked on
  credentials. The earlier runner-allocation blocker below is historical, not
  the explanation for this executed failure.

## Earlier package evidence and remaining platform limits

The following records retain previous artifacts and their limitations; use the
commit-specific results above for the subsequent NAM correction.

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
  **Final Linux browser check: pass.** All four groups at `b80d47c4` completed
  in [run 41882180129](https://github.com/sdevil7th/OpenStudio/actions/runs/41882180129):
  54 + 88 + 76 + 77 = 295 passing cases, 33 declared skips, zero failures and
  zero retries. The system WebKitGTK check also passed. The previously outstanding
  [group 4](https://github.com/sdevil7th/OpenStudio/actions/runs/41882180129/job/126757203827)
  completed at 18:16 UTC, retaining its
  [test artifact](https://github.com/sdevil7th/OpenStudio/actions/runs/41882180129/artifacts/13351596111).
  The earlier dependency-download stall and Actions outage did not run those
  assertions; this subsequent completed run clears that software verification
  item. No behavior assertions or retry policy were relaxed.
  Native-schema editor tests run separately after the native app build. Tests
  requiring a private project or explicit native tempo-preview input do not run
  automatically in this general browser suite.

Windows package/WACK evidence is from `d8202953`; the Linux package and latest
Windows browser evidence above is from `8f75022a`; final Linux browser evidence
is from the documentation-only `b80d47c4`. Between those commits only CI, a test
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

## Game-contention investigation — 4 November, 18:00–18:18 UTC

The user explicitly requested leaving Dota 2 running. These are contention
diagnostics on the Ryzen 9 7900X / Audient ASIO host, with Balanced power mode,
48 kHz / 8 samples, synthetic input and silent physical outputs. Support was
closed. No game setting, power mode, affinity or buffer requirement was changed.
There is no matched game-closed baseline and no claim that the game caused each
miss. The four loaded tracks alternate the same guitar/bass presets with 4x
oversampling. Each case requests three seconds of warmup and 30 measured seconds.

| Condition | Measured callbacks | Mean / p99 / max, microseconds | Outer deadline misses | Result |
| --- | --- | --- | --- | --- |
| Loaded NAM, normal workers | 180,000 | 107.8 / 222.0 / 488.5 | 7,667 | **fail** |
| Loaded NAM, workers disabled | 145,080 | 284.4 / 554.0 / 1,202.1 | 145,080 | Incomplete measurement; every observed callback exceeded budget |
| Loaded NAM, explicit 200 µs worker spin experiment | 180,000 | 110.5 / 193.4 / 399.3 | 3,073 | **fail**; extra CPU use, not adopted |
| Four host-bypassed tracks, normal workers, cycle queries enabled | 180,000 | 12.3 / 34.5 / 431.0 | 5 | **fail**, control only |
| One host-bypassed track, no workers, cycle queries disabled | 180,000 | 1.95 / 10.4 / 161.6 | 0 | **pass**, this minimal control only |

The loaded normal-worker case also had 35,178 worker deadline misses, 41,237
quarantined blocks and 135 cancelled jobs over warmup plus measurement. The spin
experiment still had 11,674 worker misses, 16,687 quarantined blocks and four
cancelled jobs. Worker counts cover a different interval and are not added to
outer callback counts. All five raw-recording comparisons passed; this does not
qualify the processed monitoring path. The incomplete serial run is not counted
as a processing-integrity pass.

The first three cases use Release SHA-256
`84e529369dd7e2655f420f5130558ece85359dd92c470865889b692dcfa5719b`.
The controls use `4224e2d78c1153541e95610205577b493d2ae79888d6da7d1ec6b07264fc72d3`,
which adds only explicit diagnostic-probe options, not a production audio fix.
`--probe-bypass-fx` verifies host bypass and labels the report as a control;
`--probe-thread-cycles` adds raw Windows thread cycles and processor endpoints.
Both are off by default and only used inside `--nam-live-callback-probe`.
The probe-only source change builds in Windows Release and Debug with zero
C++ warnings; the packaged frontend in Debug matches `frontend/dist`. It does
not extend the earlier installer/WACK result to this new executable hash.
Cycle-query cost is included in reported callback duration. Two of the five
late four-track control callbacks changed processor between their endpoints.
That demonstrates migration, not the duration or cause of the delay; cycles
are not converted to CPU time and are not proof of a particular driver fault.

An offline stage-isolation diagnostic also completed with processing/parity
checks passing. Disabling whole FX stages changes the workload and sound, so
those timings do not justify silently bypassing FX or establish a production
optimization. No worker-spin, extra-buffer, hidden-delay or dropped-work
acceptance change was promoted. The minimal control pass does not clear either
the loaded NAM failure or the earlier 31-track UI/recording gate. **PR #36 remains
a draft: the eight-sample failure has not been resolved.** Physical driver xruns
are unsupported; monitoring continuity, loopback latency and audition remain
**not_asserted**. Results under `output/eight-sample-investigation/` remain local.

## Approved scheduling trace and NAM preparation — 5 November 2026 (IST)

The user approved an explicit 75-second Windows scheduling trace with Dota 2
running. Two captures were saved, without changing power mode, game settings,
drivers or affinity. Both stopped automatically. The first exposed a diagnostic
CSV writer that repeatedly scanned its accumulated string and timed out after
recording. The probe now writes its report through a pre-sized stream, after the
callback has been removed. The repeat completed normally. Absolute clock ticks
and the explicitly requested thread ID permit correlation with Windows ETW;
these additions exist only in the manually launched headless probe. Support and
ordinary callback profiling remained off.

The usable repeat started at 18:44:12 UTC on 4 November and saved at 18:46:09
UTC, including trace stop/rundown. It has zero lost events, matching retained
executable/PDB files, and 62,802 unique retained callback intervals with complete
scheduling coverage. Of 7,768 retained misses, 508 overlap more than 10 µs of
ordinary DPC/ISR activity on the callback's executing CPU; five include more
than 10 µs off-CPU. The maximum unioned interrupt overlap is 294.4 µs, exceeding
the 166.7 µs buffer budget. Graphics modules `dxgkrnl.sys` and `nvlddmkm.sys`
appear in these overlaps. Threaded DPCs are excluded from interrupt subtraction,
and nested interrupts are unioned rather than double-counted.

This does not attribute every miss to a driver: 7,384 retained misses still
exceed budget after subtracting observed interrupt/off-CPU intervals. The
retained set combines uniform samples with the first 4,096 misses; it is not
all 14,923 measured misses. Residual wall time includes app processing, worker
waits, diagnostic queries, tracing and unobserved costs, not exclusive app CPU
time. All trace findings are **diagnostic_only**, not a normal-use capacity pass
or proof of a past unobserved glitch. Microsoft's [CPU analysis guidance](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/cpu-analysis)
and [threaded-DPC distinction](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/introduction-to-threaded-dpcs)
describe the scheduling interpretation.

The same saved capture also contains 2,322 disk-backed hard-fault events across
the machine (one event's process owner was unresolved). Of the 21 attributed to
OpenStudio within the retained callback span, two occurred on the audio thread
during the same 416.5 µs late callback. Their elapsed intervals are 159.1 and
111.8 µs; they overlap time already accounted for by scheduling and must not be
added to off-CPU duration. The backing file was not resolved. This is evidence
of paging during that reproduction, **not** proof of insufficient RAM or an
explanation for every miss. Faults can include first access to mapped code/data;
Microsoft's [hard-fault counter guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/how-to-determine-the-appropriate-page-file-size-for-64-bit-versions-of-windows#memorypagesec-and-other-hard-page-fault-counters)
explicitly distinguishes them from a low-memory condition.
This analysis reads the existing capture only; no new collector was started.

Matching stack samples repeatedly identified NAM cabinet FFT work. Each track
Rack was prepared for 512 samples while receiving eight. TrackProcessor now
prepares native NAM input/track FX for the actual host block capacity, preserving
the existing minimum-512 compatibility reserve for other processors. Selection
uses the native type, not its display name, and runs only during preparation.
This reduces repeated convolution work without buffering additional audio or
changing the zero-latency cabinet algorithm. Master/bus preparation is unchanged.
No worker-spin, work-dropping policy, extra recording monitor or Support hook was
added.

The focused regression checks insertion, device/render-size re-preparation and
precision changes at 8/16/64/512/1,024 samples. It also compares 110,592 cabinet
samples, including mono/stereo IRs, dual-mono selection, source-rate conversion,
impulses, signal and tails. Maximum PCM difference is `1.490116119384766e-08`
against a `2e-5` tolerance, with zero reported convolution latency. This is
**pass** for those deterministic invariants; subjective sound is **not_asserted**.
Windows Release and Debug builds completed without C++ compiler warnings, and
the focused realtime safety regression passed in both configurations. The full
NAM matrix passed 206 objective checks (18 diagnostic-only and eight not-asserted
items retained); the render/export matrix passed all 422 checks. Debug's copied
frontend is current. These local passes do not extend the earlier installer or
WACK result to the modified executable.

The final call-path review also corrected the app's built-in insertion entry
point: it must pass the actual device capacity into TrackProcessor rather than
the generic creation reserve. Two engine-level fixtures verify inserting NAM
into both chains after a simulated device has already started at 8 or 64 samples,
without requiring a device restart. They pass in Release and Debug. The full
NAM and 422-check render/export matrices were repeated and passed after this
correction; both configurations rebuilt without C++ compiler warnings.

Four subsequent physical-interface runs used four loaded NAM tracks, normal
workers, 4x oversampling, Audient ASIO / 48 kHz / 8 samples, three seconds of
warmup and 30 measured seconds. ETW and optional thread-cycle queries were off;
the explicit probe still measured each callback. Dota 2 remained running.

| Run order | Preparation | Mean / p99 / max, µs | Measured misses / 180,000 | Worker misses, warmup + measurement |
| --- | --- | --- | --- | --- |
| 1 | Actual host block | 87.3 / 201.8 / 386.7 | 3,958 | 6,299 |
| 2 | Saved previous 512-block build | 116.6 / 237.6 / 406.1 | 8,948 | 36,173 |
| 3 | Actual host block, repeat | 85.5 / 197.9 / 343.2 | 3,955 | 6,183 |
| 4 | Final app-insertion correction | 82.6 / 190.8 / 408.7 | 3,658 | 7,360 |

All four passed raw synthetic-recording checks and failed engine/worker
capacity. Worker counts cover a different interval and must not be added to
the measured outer misses. These runs support the direction of improvement
under this test setup, not a universal percentage claim: game activity was not
a controlled replay. They do not repeat or clear the earlier 31-track UI test.
Unsupported physical driver xruns, processed-monitor continuity, loopback
latency and audition remain **not_asserted**. **The zero-miss 8-sample gate fails.**

Previous build / trace executable SHA-256:
`663b9d97ac4d3a5f277b2c0f46315750a2fa0ca78e97c9b539fdb1ecb3870249`.
Updated Release executable SHA-256 for runs 1 and 3:
`bc404150f7494ae493a4ca3c7075bc93debc51c9fed99430a404e362a234b21a`.
Final insertion-corrected Release executable SHA-256 for run 4:
`77306c0434c3e050974d5c99c259b40656ded55a2d3379b850ce2100eef5bbe9`.
Local traces, matching binaries, analysis and reports remain under
`output/eight-sample-investigation/`; private machine traces are not committed
or uploaded. Trace artifacts are evidence of this explicit diagnostic session,
not a background telemetry facility.

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


## Offline support follow-up — 5 November 2026

This is local, unpublished development verification. The release executable SHA-256
is `4d6161e54da1638406acead9e32103f72766ac4f80af525e08f67bffbb04d163`;
its debug identity is `pdb:44C93176-1CDA-4CA2-A53F-26FB29CE1FCB:101`.
Build metadata records the pre-commit working tree after `93d03c15`, including its
dirty-state flag; it does not pretend that these bytes came from that older commit.
The matching helper identity is `pdb:C645676D-7ED4-40C8-8EC5-30CE705D7A5F:11`.

- **Pass:** Windows CMake Debug and Release builds, zero compiler warnings.
  Current frontend assets are copied to both; no pre-running Vite server is needed.
- **Pass:** final Release runtime safety: 388 native contracts and all crash,
  dedicated-thread fallback, dump-write failure, explicit hang, hang-then-crash,
  recovery and bounded-final-Quit fixtures. The idle-reporter fixture confirms
  that an old heartbeat does not arm normal-use hang collection.
  Local evidence: `output/review/runtime-Release-20261105-093549-111955/qualification.json`.
- **Pass:** final Release render/export suite: 423 objective checks, zero failures,
  including disabled callback instrumentation and unevaluated ARA log arguments.
  Local evidence: `output/support-improvements-render-final/20261105_093549_render-export-regression/render_export_regression_result.json`.
- **Pass:** 50 support/policy checks; nine native Unix/package cases are skipped
  on this Windows host. Separate release-tool checks passed (35 run, three skipped).
  Cases include invalid/truncated PE/PDB/Mach-O/ELF/dump metadata, wrong symbols,
  changed runtime JavaScript, XML entities, privacy filtering, review and no-overwrite.
- **Pass:** frozen Support tests with external Python/Node absent from PATH,
  including GUI construction, MIDI/audio inspection, plugin settings and native
  identity parsing. Production policy validation and all 1,052 Support inventory
  files validate. No Support autostart registration or DAW launch hook was added.
- **Pass:** Windows executable/PDB and frontend archives. All 68 JavaScript chunk
  hashes match emitted files; maps are absent from runtime `dist`. Original source
  locations were resolved in 60 application chunks (the others are vendor chunks).
  Frontend build completes; its CSS source-map warning is not a CSS-map qualification.
- **Diagnostic only:** Support can match exact native IDs in incident evidence;
  this does not identify crash cause or assert complete third-party symbols.
  Dump memory is excluded unless explicitly selected. Ordinary app use no longer
  polls UI heartbeats, flushes fault counters periodically or emits ARA callback logs.
  Existing crash capture and failure protection remain, and final-Quit monitoring
  arms only when quitting (or in an explicit diagnostic build/self-test).
- **Not asserted:** new full macOS/Linux app builds, native dSYM/ELF extraction on
  those hosts, installer/Store recertification, notarization, physical recording,
  subjective audio quality or resolution of the earlier strict 8-sample failure.
  Synthetic cross-platform identity fixtures pass here; native compiler fixtures
  are wired into the existing support qualification workflow for those platforms.

Symbol archives are separate from installers and Store inputs. Release CI will
retain them as separate Actions artifacts; the workflow was not invoked here.
Automatic timed dumps of running-session UI hangs are deliberately disabled in
ordinary builds. No claim of zero total DAW cost or historical CPU/RAM attribution
is made from the offline reports.

## Mac export/window qualification — 5 November 2026

Windows certification completed at `dd92c765` before this follow-up. The
[WACK job](https://github.com/sdevil7th/OpenStudio/actions/runs/41968313366/job/127064166209)
passed overall, exit 0, with all 13 required tests and no required findings.
The [retained report](https://github.com/sdevil7th/OpenStudio/actions/runs/41968313366/artifacts/13389764270)
identifies MSIX SHA-256
`b32b78294ca5473e52a7cbe42f75d6c71481362a5c6c2a11903c802bdf059e46`.
Application-count and blocked-executable findings remain optional; no WACK gate
was weakened. `published: false`; this does not establish Store approval.

The Mac Intel job passed callback/ARA contracts but failed six OGG cases. Its
FFmpeg 9.0.1 configuration lacks `libvorbis`. The export path now uses JUCE's
bundled Vorbis encoder with the existing quality 0–10 mapping. Final SRC keeps
the existing FFmpeg WAV conversion. Encoding is bounded and cancellable, checks
file-write/finalisation status and decoded stream length, and stays inside the
existing atomic export transaction. Tests cover cancellation, missing input,
refusal to append over an existing staging destination, mono/stereo, quality,
sample-rate changes and Unicode paths. This changes only explicit offline export.

The Apple Silicon runner has a 1024x768 display with only 1024x681 usable points.
The failing main/preferred-plugin geometry requests did not reserve native title
bar space. The explicit lifecycle harness now fits those expected client bounds
to the usable native-frame area before requesting them. Exact requested-result
and delayed stability assertions remain, with an additional restored-plugin
stability check. Requested/expected/actual rectangles and usable display/native
frame geometry are retained only in the explicit harness report. Normal window
startup gains no diagnostic timer or collector. Five redundant-capture warnings
are addressed using explicit initialised captures accepted by MSVC and Clang.

Local Windows Release validation of this source follow-up: **pass**, zero C++
compiler warnings and all 426 render/export checks passing, including the new
native Vorbis contracts. Desktop-qualification/release-note tools: 43 tests,
31 passed and 12 platform-specific skips. The updated development website guides
passed TypeScript checking; they were not deployed. Local native evidence was
built from the dirty source tree before committing this follow-up, not a clean
`dd92c765` binary. New Mac/Windows/Linux artifacts require their own CI results;
PR #36 records those results rather than relabelling older artifacts.

Support remains manual-only. No callback diagnostics or ARA logging was enabled.
The accepted 8-sample failure remains **fail, non-blocking**; no new hardware
measurement was made. Listening quality, physical devices, Apple notarization,
Gatekeeper acceptance and Store approval remain **not_asserted**. Nothing was
published, submitted or merged.


## Neutral EQ precision — 5 November 2026

At `f92fc430`, the [Intel Mac native job](https://github.com/sdevil7th/OpenStudio/actions/runs/41982480859/job/127097795850)
passed without C++ compiler warnings, including all seven OGG cases, native
Vorbis failure/cancellation contracts, window lifecycle and spectral export.
Apple Silicon passed 88 window checks and installed-DMG/Support/signature checks,
but its newly reached spectral-export assertion failed. Windows native/installer
qualification and [WACK](https://github.com/sdevil7th/OpenStudio/actions/runs/41982480859/job/127106661326)
passed; the [certification report](https://github.com/sdevil7th/OpenStudio/actions/runs/41982480859/artifacts/13396536108)
is retained. Linux package qualification passed. These results are tied to those
artifacts; they do not assert that a later binary has passed.

`191d91c2` replaced the window harness's deprecated Linux frame-size API with the
current optional API. `85d7717c` retained the exact Mac candidate even when later
export tests fail and expanded the explicit spectral test's evidence. The
[Apple Silicon report](https://github.com/sdevil7th/OpenStudio/actions/runs/41986658088/artifacts/13398186415)
then identified the sole failing condition: neutral error
`2.447515726089478e-6` exceeded the unchanged `2e-6` limit. PDC and output lengths
passed, route error was `1.862645149230957e-9`, and active correction was
`0.03571418300271`. The current Linux build passed without C++ warnings. One
Windows browser test in that run failed before app startup because Chromium
could not fetch React (`ERR_NO_BUFFER_SPACE`); its trace identifies a runner
network-resource failure, not a batch-converter assertion failure.

The neutral-EQ correction recognizes exactly equal numerator/denominator
polynomials during coefficient construction and uses exact identity coefficients.
This avoids exciting cancelled recursive poles through fused-math rounding.
Non-unity coefficient construction and the existing spectral error thresholds
are unchanged. A new export regression requires exact PCM equality with a
neutral default EQ. Local Release builds have zero C++ warnings; all 427 export
checks and six focused EQ suites (spectral, phase, minimum FIR, shapes, adaptive
dynamics and draft processing modes) pass. New Mac/Windows/Linux artifacts must
pass their own CI; final results are recorded on PR #36.

Support remains inactive until explicitly opened. No recording-time diagnostics
were added. Physical device behavior and subjective audio quality remain
**not_asserted**; the accepted 8-sample hardware result remains **fail,
non-blocking**. No Store submission, notarization, release or publication occurred.
