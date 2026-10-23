# Audio and Runtime QA

## 0.1.06 candidate review (October 23, 2026)

The release candidate remains **not approved for publication**. Its reviewed
changes are described in [0.1.06 notes](releases/0.1.06.md); those notes distinguish
the proposed application candidate from the Store-only review baseline and the
published installer.
The following closes code-review findings, not the remaining hardware and
platform acceptance gates:

- NAM metadata/portable and Pitch presets use a bounded, strict JSON document
  writer with checked temporary writes and atomic replacement. Project-only
  validation and recovery remain separate. POSIX publication uses same-directory
  rename with no copy fallback; the permission-failure fixture must run as an
  unprivileged user. Windows execution does not qualify that POSIX branch.
- Pitch custom presets and A/B capture the processing mode and every exposed
  control. Legacy imports retain root-relative masks; factory tonal templates
  preserve the current mode. Recall uses one guarded native transaction and
  verifies target identity. File failures and stale dialog completions are
  covered separately.
- NAM's output-protection message distinguishes recent reductions from history,
  wraps at compact/4K sizes and retains emergency-fault priority. A reported
  final-output zero is authoritative; older model-stage counters receive
  Input/Level guidance instead. Untouched instrument number fields retain full
  precision and do not create Undo entries.
- Windows CI exports editor schemas from its current Release executable and
  runs the free-suite browser qualification. Explicitly requested missing
  schemas fail instead of skipping. Windows and macOS run the native file/runtime
  contracts on their Release executables; Linux's feature qualification already
  runs those contracts. These workflow definitions still require an actual CI run.

The macOS conversion fixtures require system FFmpeg on `PATH`; CI installs it
when absent and prints its version before building. This is a test prerequisite,
not bundled-runtime qualification. Native reports include an explicit FFmpeg
availability check and conversion failure diagnostics. The Windows free-suite
launcher uses the first npm application on `PATH` and propagates its native exit
code; `tests.test_free_suite_ui_regression` covers multiple installations,
failure propagation and environment restoration. Input fixtures choose the
primary modifier from the browser's platform identity (Command on macOS), while
asserting shortcut ownership separately for top-row and numpad keys.
Linux native CI prefers the hosted image's official Ubuntu HTTPS archive
fallbacks after observed Azure-mirror download stalls. Its dependency step has
a 15-minute backstop and still fails on installation errors; the developer
prerequisite script does not change the machine's mirror configuration.
Conversion deadline qualification keeps a real FFmpeg child, checks that a
timed-out operation preserves the destination and removes its staging file,
and resets each negative fixture independently. The deadline is checked after
process exit and immediately before publication as well as during polling.

Before the SSH Linux qualification below, the local candidate passed 2,989
frontend unit tests, 70 selected Chromium
browser cases, 185 free-plugin regression groups, 264 render/export checks,
and 369 Release / 370 Debug runtime checks. A deliberately missing native
schema failed the browser qualification, as required. The free-plugin run preceded
the final file-writer-only rebuild; its DSP sources were unchanged. Objective
signal/state results are **pass**, timing measurements are **diagnostic_only**,
and subjective audio quality is **not_asserted**. Full frontend units, focused
browser qualification, types and build evidence live under
`output/review/release-0106*`; this ignored evidence is not a published release.
Production and browser-test TypeScript checks pass. Both 0.1.06 native builds
compiled without C++ warnings; all 146 packaged frontend files match the final
production bundle. Vite still reports its large-chunk and ineffective-dynamic-
import advisories. That checkpoint's evidence index is
`output/review/release-0106/qualification-summary.json`.

Fresh silent Audient probes used the exact 0.1.06 Release executable SHA-256
`9f5ae9ca1a2488a3d4a0644c47797eb8b6433918719aed4f0c9dd228133faaf0`,
four recording/monitored tracks alternating Bestest clean with Distortion and
the recovered Bass Clean preset, 4x oversampling, automatic workers, three
seconds warmup and ten seconds measurement. No polling or recovery grace was
enabled. Both cases **fail capacity**:

| Rate / buffer | Mean / p99 / max callback (us) | Callback misses | Worker misses / quarantines |
| --- | --- | --- | --- |
| 48 kHz / 16 | 107.8 / 234.4 / 429.2 | 18 / 30,000 measured | 64 / 29 |
| 44.1 kHz / 16 | 114.0 / 248.0 / 553.8 | 35 / 27,563 measured | 83 / 50 |

Worker counters include warmup and are not additive with callback misses.
All eight recorded WAVs pass exact frame counts and PCM parity within two
16-bit LSBs, with zero write failures. Driver/settings restoration passes;
driver xrun readback is unsupported (`-1`). Physical input, audible continuity
and 30-minute stability are **not_asserted**. See
`output/review/release-0106/cpu-short-summary.json` and the earlier multicore
qualification below; a lower average with skipped work is not acceptance.

The next performance step is an opt-in, preallocated per-job trace of dispatch,
start and completion, read only after device removal and executor drain. It
must distinguish callback/helper jobs and cancelled or unfinished work, preserve
default scheduling and report overflow without dropping DSP. Compare timing-off
and timing-on runs: timestamps perturb the measurement, and processing wall time
still includes preemption. Investigate wake/queue delay versus rack execution
before choosing a scheduler or DSP change. Only a clean short run warrants the
required sustained four-track qualification; do not hide the failures with a
larger implicit buffer or lower oversampling.

The local Windows RC command passed the version, runtime-bundle and prerequisite
self-test gates but stopped at installer construction because Inno Setup is
unavailable. Installed normal/safe startup, upgrade/Repair on the affected
Windows 10 installation, current macOS packaging, exact-artifact audition,
signing and final source/tag CI remain release gates. The sibling website has
a new development article, `blogs/2026-10-23-tuning-openstudio-free-effects.md`;
its build/lint and all 239 website tests passed. It was uncommitted at that checkpoint,
and public update feeds still describe the released version.

The final build-tree Release passes all four automated window lifecycle cases
under the current standard-user Windows account: normal and safe mode, each
with clean and invalid inherited runtime paths. Each normal case passes 99
checks and each safe case 90, with packaged frontend readiness and zero hardware
device starts/callbacks. Exact binary/frontend hashes and owned-process cleanup
are retained in the adjacent `windows-*.qualification.json` reports. These are
build-tree checks: the installed artifact, protected Program Files location,
Windows 10 Repair, visual inspection and physical audio remain unasserted.

### SSH Linux qualification of the working tree

The October 23 run transferred a file-hashed source snapshot to an isolated
directory on the connected Ubuntu 26.04 machine. It did not push an unfinished
branch or change the existing remote checkout. Ubuntu 22.04 baseline builds and
installation tests use a disposable VM overlay; the physical host's installed
OpenStudio is not upgraded. Source manifests, amendments, executable hashes and
logs live under `output/review/release-0106/linux-20261023` and the remote
`/home/sayak/dev_work/openstudio-qa-evidence/0.1.06-20261023` directory.

Fresh Linux dependency installation exposed missing optional WASM lockfile
entries; the repair preserves existing dependency versions and integrity hashes.
The production frontend build, both TypeScript checks, all 2,989 unit tests and
70 Chromium interaction/geometry cases pass on Linux. A document-owned module
bootstrap fixes a garbage-collected test-fixture promise without changing app
behavior. System WebKitGTK 2.52.6 passes 44 real-input control checks against the
production frontend and mock bridge. Separately bundled Playwright WebKit cannot
launch because its `libavif.so.16` dependency is absent; none of that runner's app
assertions executed. System WebKit coverage is independent, not a relabelled
Playwright pass.

Both native Release builds compile with zero warnings: GCC 11 on Ubuntu 22.04
and GCC 15 on Ubuntu 26.04. Portability fixes retain the DSP calculations and
executor storage layout. Narrow suppressions cover reviewed false positives in
pinned YSFX vendor files only. Linux compilation also exposed an actual ARA
host-handle conversion reading eight bytes from a four-byte value. Handles now
use a pointer-width integer, unsupported content is rejected, and event reads
validate their bounds. All seven new ARA contracts pass on both Linux builds and
Windows Debug/Release; commercial ARA plugin integration is not asserted by
these contracts.

The full free-suite run exposed a Windows-specific golden-file assumption:
procedurally generated default convolution IRs use `expf`, whose final float
rounding differs across math libraries. All 1,030 properties in the compared
preset match except that IR; 89 of 115,200 samples differ, by at most
4.66e-10. The portable regression preserves exact historical serialization of
all other properties, validates the complete historical IR recipe within two
float ULPs, and checks malformed/corrupt negative controls. Original Windows
full-state hashes and same-platform byte-exact round trips remain enforced.
This is a test portability correction, not a DSP or preset-format change.

Package staging now writes desktop entries with LF line endings, including
source snapshots taken from Windows. Updater checks also exposed newly created
directories inheriting group-write permission under `umask 0002`, then failing
the installer's existing trust checks. New staging directories use private
creation modes; existing insecure ancestors and symlinks remain rejected and
are not silently chmodded. Native DEB updates continue to use the package
manager, rather than the automatic AppImage replacement path.

Each Linux native build passes resource lookup in three launch conditions,
85 main/detached window and objective pitch checks, 264 render/export checks,
360 runtime-safety checks and all 40 engine-feature suites. These use actual
WebKitGTK in Xvfb and unprivileged test accounts. POSIX atomic-publication denial
is asserted, and the qualification tool now fails closed on missing, malformed,
failed or unasserted permission evidence. No JUCE assertion/leak diagnostics were
reported. Xvfb does not qualify the physical desktop, native Wayland, audio
hardware, long sessions or subjective sound.

The final Ubuntu 22.04 DEB upgrades the disposable VM from 0.1.04-14 to
0.1.06-1. Installed normal startup passes the full native checks above; safe
startup passes 76 lifecycle checks. Actual frontend boot succeeds through the
`/usr/bin/OpenStudio` symlink from an unrelated directory with stale `APPDIR`
and `APPIMAGE`. Removal and reinstall pass, preserving the test project, media
and preset byte-for-byte at every stage. This VM already has runtime dependencies;
it is not a fresh-OS installation test. The same extracted DEB payload passes
the full native checks on Ubuntu 26.04, without replacing the host installation.
Both Ubuntu environments pass all 185 free-plugin groups. The final baseline
ABI gate passes glibc 2.35, and both native builds pass 31 updater and 27 installer
contracts, including the permissive-umask regression without an external workaround.

The unpublished DEB is `OpenStudio-0.1.06-1-ubuntu-22.04-amd64.deb`, SHA-256
`39d20e5ecfb37d03a53a2426bb8a828afc62ceff7b652f5f63b0fbc889a563b8`;
its executable is `549ed9e61762a6b6140d72eaa9158a19f664b0c8043d943ff50b111874fdd3c3`.
The separately compiled Ubuntu 26.04 executable is
`f7ccec013fa7add1e99b559a0a7d74f770338f76345678994265d855f42b2423`.
Final schema export is byte-identical to the schema used by the editor tests.
The retained source manifest records all amendments to the initial snapshot.
Qualification preceded the candidate commit; subsequent documentation cleanup
and PR preparation leave the qualified non-documentation source unchanged.

After these changes, Windows Debug and Release rebuilds have zero warnings,
377 and 376 runtime checks pass respectively, and all 146 packaged frontend
files match the production bundle. Release parallel processing passes 12
executor checks, 36 engine checks and 96 parity blocks; CLAP automation passes
all 13 component gates. This offline verification does not supersede the
retained failing 16-sample hardware measurements above.

### Open GitHub issue scenarios

All four open issue bodies and their comments were re-read on October 23.
Scenario evidence is indexed in
`output/review/release-0106/linux-20261023/github-issue-scenarios.json`.
No issue was closed or represented as universally resolved by these checks.

- [#25](https://github.com/sdevil7th/OpenStudio/issues/25): the actual Windows
  Release stays maximized with identical native bounds when one click opens
  Options > Preferences and when one click opens Insert > Media File's native
  chooser; cancelling also preserves maximization. The physical display is
  3840x2160 at 150%. A separate 1920x1200 CSS-pixel browser regression passes,
  but uses a mock bridge and does not substitute for that exact physical monitor.
- [#24](https://github.com/sdevil7th/OpenStudio/issues/24): the attached log
  already used LocalAppData. Its failure was an in-process CUDA import followed
  by a CPU/DirectML fallback modifying a loaded ONNX DLL in the same runtime.
  An actual Windows loaded-DLL fixture reproduces WinError 5 and verifies the
  candidate-clone and atomic activation helpers can update a separate runtime
  while the old DLL stays loaded. Nine mechanism checks, 21 focused Windows
  installer tests, 17 Linux tests and five Linux filesystem checks pass. Pip,
  CUDA/DirectML installation and real GPU separation are not exercised by that
  mechanism fixture. The report's WAV-to-stems flow and Edge download-warning
  follow-up remain separate acceptance work.
- [#7](https://github.com/sdevil7th/OpenStudio/issues/7): the final Windows 11
  Release passes normal/safe startup with an injected invalid WebView2 runtime
  override (100/90 checks, all ten frontend documents ready once, no audio
  device starts). Installed Windows 10 22H2 startup after Repair Dependencies
  remains untested. Linux WebKit success cannot close a WebView2 failure.
- [#23](https://github.com/sdevil7th/OpenStudio/issues/23): installed DEB tests
  exercise the original resource-location mechanism. A finished AppImage also
  reaches main/detached frontend readiness on Ubuntu 22.04 under Xvfb/Openbox;
  this uses extract-and-run, not a FUSE mount. Its SHA-256 is
  `be9bcd3ac67e1f2ca1a23b8e51a468d7d639432df76f20cf92a95b4e735ac030`.
  Packaging uses the same baseline build and pinned linuxdeploy, with only
  CRLF-to-LF normalization of the copied shell script/desktop entry recorded
  in the input manifest. The literal Arch/fish environment and unidentified
  newer build mentioned on October 21 remain unverified.

The Linux scheduler needs separate measurement: the current helper's JUCE
`Priority::highest` request maps to ordinary `SCHED_OTHER` on Linux, unlike the
explicit Windows MMCSS path. Record the effective callback and worker policies
for the active backend before changing them. A platform-supported real-time
startup path needs permission-aware fallback and diagnostics; assigning maximum
FIFO priority indiscriminately is not an accepted solution. Combine that audit
with the dispatch/start/finish trace above to separate scheduler delay from DSP
cost. Linux VM timing is **diagnostic_only**, not evidence of 16-sample capacity.

## Octaver Fuzz checks

Run the headless interaction suite after building Debug:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-nam-fuzz-review.ps1 -SkipBuild
```

Without `-SkipBuild`, the wrapper builds Debug first. `-GuitarInput` and
`-BassInput` accept explicit local recordings; otherwise it uses verified local
guitar fixtures or labelled synthetic fallbacks. `-OutputRoot` changes the
default ignored `output/nam-fuzz-review` directory. The runner restores its
process environment. In the October 18 development implementation, the focused
Fuzz and two-Rack CPU branches construct an explicitly offline AudioEngine and
assert no opened device, device starts or registered audio callbacks. This
does not describe the older unfocused NAM headless branch, which can restore a
saved audio device. A hidden window alone never proves device-free execution.

`OPENSTUDIO_NAM_FUZZ_ONLY=1` selects focused contracts; heavy interaction sweeps
and WAV exports additionally require `OPENSTUDIO_NAM_FUZZ_AUDIT_DIR`. Ordinary
regressions do not export listening files. Native checks cover exact bypass,
full-clean parity, silence/recovery, stereo independence, reset/partition parity,
Bass gate transitions, route execution, and native/portable/Compare/bridge recall
at 44.1/48/96 kHz. Octave metadata is compared with an independent float32 ramp
timeline; requesting metadata must leave audio unchanged. Formula rounding
residuals are diagnostic, not permission to change that coefficient law.

The retained October 15, 2026 refinement evidence is
`output/nam-fuzz-refinement/final/20261015_142950_fuzz-interaction/nam_rack_regression_result.json`
and `final/fuzz-5f3ff60f/manifest.json` under the same refinement root.
Structural/recall contracts and the 144-case boundary sweep passed. The complete
NAM regression subsequently reported 196 `pass`, 18 `diagnostic_only`,
8 `not_asserted` and no `fail` checks. These are dated runs, not certification
of later edits.

October 15 diagnostic limits included pre-Amp peaks above unity in 52/144 extreme
corners (maximum about 3.89), bright 10 kHz partial-blend cancellation up to
12.5 dB relative to incoherent fundamental power, and source-dependent voice
levels. They do not establish a full-rack output failure or an audible defect.
Pedal-only DI lacks amp/cab processing; bass is synthetic unless its source
manifest identifies a supplied recording. Chord clarity, tone, alias audibility
and tail preference remain `not_asserted` until exact-artifact audition.

`tools/prepare_nam_fuzz_refinement.py --after <manifest.json> --output <new-directory>`
pairs current exports with the archived baseline without output normalization.
Dry/octave-only files must remain byte-identical. Clean50 legacy files are
labelled reconstructions from native wet/octave endpoints under the original
linear law, rather than independent old-build renders. Override `--baseline`
when using another retained archive. Production DSP never reads these inputs.

For the full-rig matrix, pass both explicit existing local resources:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-nam-fuzz-review.ps1 -SkipBuild -OutputRoot output/nam-fuzz-stack/baseline -AmpModel '<amp-only.nam>' -CabIR '<cabinet.wav>'
```

The `fullChainListening` manifest array contains all eight Fuzz/Drive/Distortion
on/off combinations, two control sets and every enabled Fuzz voice: 32 WAVs per
material at 48 kHz / 512 samples. Octave is active throughout, with
Direct/Down/Up `1/0.32/0.18` for conservative controls and `1.25/1/1` for stress.
The complete native Rack processes the explicit NAM amp and cabinet IR;
compressor, captured pedal, PRE/post EQ, room/doubler and time effects are
bypassed. The rig-only mask therefore retains Octave, amp and cabinet. Full
native state, resource hashes/capture metadata and input provenance accompany
each row. Existing arranged CC0 guitar notes are not a continuous performed
riff; synthetic Bass remains labelled, including when it passes through a
guitar amp fixture. Successfully loaded files do not certify their authorship,
recording chain, calibration or suitability for every instrument.

Absent resource arguments produce `not_asserted` coverage; supplying one or an
invalid resource fails. Amp+cab captures are rejected for this separate-IR
matrix. Exported IEEE float32 audio retains native levels and the production
Rack's own safety processing, with no added normalization, limiter or gain
matching. Repeat with the same source/resources under an `after` output root,
then pass both manifests to `prepare_nam_fuzz_refinement.py --baseline ...
--after ... --output output/nam-fuzz-stack/comparison`. It requires matching
coverage, complete Rack controls and resource/input identity, and byte-identical
fuzz-off chains. Exact baseline Clean50 exports are copied; the older endpoint
reconstruction is used only when that baseline file is absent. A default
+12 dBu capture after a calibration-only change retains the old operating gain,
but is not an independently rendered old-build full-chain archive.
For the bounded Guitar/Vintage interstage-coupling candidate, add
`--expect-vintage-only`: Bass and every Sustain/Gated export must also remain
byte-identical. Capture this candidate's baseline after calibration qualification
and before the voicing change; do not substitute the older pedal-only archive.

Calibration checks cover equivalent physical inputs at +6/+12/+18/+24 dBu
interface references, Guitar/Bass, all three voices and Clean 0/0.5/1, at
44.1/48/96 kHz. Common physical-domain output has an explicit `1e-5` absolute
sample tolerance; callback partitioning and full-clean digital passthrough are
exact. Live calibration changes and malformed-value fallback must stay finite
and partition invariant. These are functional contracts, not tone approval.
The unchanged-controls cache also has a reprepare contract: after warming at
44.1 kHz, prepare the same processor at 44.1/48/96/44.1 kHz without changing any
control, including +18 dBu calibration, and require exact fresh-processor output
for all three voices in Guitar/Bass. Its 24 cases include differing callback
partitions, protecting rate-dependent coefficient invalidation and reset state.

The final October 18 **Debug** focused report is
`output/nam-fuzz-stack/final/20261018_032034_fuzz-interaction/nam_rack_regression_result.json`:
16 `pass`, 5 `diagnostic_only`, 1 `not_asserted`, no failures. Calibration,
unchanged-control reprepare, recall and all 96 full-chain integrity cases passed,
with no opened device, device starts or audio callbacks. Exports and exact
input/resource provenance are in `final/fuzz-dfa8ee23/manifest.json` under the
stack root: 33 pedal-stage and 96 full-chain native float WAVs. All 129 are
byte-identical to the corresponding exports listed in the earlier candidate's
`after/fuzz-2bc8505e/manifest.json`,
despite the additional resampler-indexing and inactive-Delay optimizations.
That candidate report remains at
`after/20261018_024158_fuzz-interaction/nam_rack_regression_result.json` under
the same root. Guitar/Vintage's coupling contribution ramps over 25 ms on
instrument-profile changes. These signal passes do not approve tone, establish
a live-device crackle fix or qualify two-Rack CPU timing.

The exact comparison in `output/nam-fuzz-stack/final-comparison/comparison.json`
passed all 129 pairs with `--expect-vintage-only`: 107 WAVs are byte-identical
and 22 Guitar/Vintage WAVs differ. All Bass, Sustain/Gated, dry/octave-only and
fuzz-off full-chain exports retain byte parity, with matching controls, input
samples and amp/IR hashes. The files retain native float32 levels; there is no
output loudness matching or normalization. This is a scoped change/compatibility
pass against `offline-baseline/fuzz-20ee0b76/manifest.json`; preferred tone and
physical-device playback remain `not_asserted`. The prior candidate comparison
is retained at `output/nam-fuzz-stack/comparison/comparison.json`.

The strengthened full-chain contract additionally requires exact loaded/enabled
amp/IR readback, positive NAM DSP frames on the first or final callback, an
active external-cab snapshot witness, expected processed block count/capacity,
finite nonzero output and no model failure, resize/oversize bypass, snapshot
fallback, realtime safety bypass, filter recovery or emergency mute. The Cab
witness establishes active resource availability with the prepared buffers;
it is not a separate convolution-call counter. Each row records these integrity
checks. Ordinary output-guard hits remain `diagnostic_only` and preserve native
levels. The final run recorded zero such hits and a maximum sample peak of
`0.297531843185425`; these are diagnostic observations for the exact fixtures,
not a universal headroom or audible-quality guarantee.

Two-instance timing is a separate opt-in headless diagnostic. After a coordinated
native build, set `OPENSTUDIO_NAM_TWO_RACK_CPU_ONLY=1` and optionally
`OPENSTUDIO_NAM_TWO_RACK_CPU_BLOCKS` (128-16384, default 1024), then invoke
`OpenStudio.exe --nam-rack-regression-headless <absolute-report-path>`.
It covers two independent serial complete Racks at 44.1/48 kHz, 8/16/32/64/128
samples, mono/stereo, and amp/cab, complete, and complete-with-fuzz configurations
(60 cases). Record build configuration, exact model hashes, callback percentiles
and deadline misses. Optional `OPENSTUDIO_NAM_BENCHMARK_AMP_MODEL` and
`OPENSTUDIO_NAM_BENCHMARK_PEDAL_MODEL` select explicit local captures; `_2`
variants select the second Rack's captures. The default bundled A1/A2 examples
are diagnostic fixtures. These timings exclude physical ASIO/device scheduling,
GUI and host contention: `diagnostic_only`, with subjective sound quality and
real two-track monitoring `not_asserted` until tested. These commands describe
coverage; they are not a claim that the current checkout has passed it.

Before the CPU matrix, the current implementation gates two output-preservation
contracts: `nam_resampler_contiguous_history_reference_parity` compares the
optimized contiguous-ring lookup with the frozen prior per-tap reference,
including ordered double accumulation, integer/fractional rates, startup/wrap,
partitions, resets, nonfinite input and capacity failures;
`nam_inactive_delay_macro_bypass_contract` checks exact disabled dry output,
off-edited engagement against a fresh processor and normal tail draining.
Failure stops the timing matrix. The earlier timing reports below predate
these additional gates.

For only these cheap contracts, set both `OPENSTUDIO_NAM_TWO_RACK_CPU_ONLY=1`
and `OPENSTUDIO_NAM_TWO_RACK_CPU_CONTRACTS_ONLY=1`, then use the same headless
command or `tools/run-nam-rack-headless-regression.ps1 -SkipBuild -OutputRoot
<absolute-ignored-output-root>`. The contracts-only flag by itself does not
select focused offline startup; it requires CPU_ONLY. No model, timing matrix,
physical device or app window is required by this focused route. Clear the
contracts-only flag to run the full matrix with both gates first.

The October 18 **Debug optimization-contracts** report is
`output/nam-two-rack/final/20261018_032018_optimization-contracts/nam_rack_regression_result.json`.
The frozen-reference resampler comparison passed bit-exact output, canary,
history/cursor and phase parity: 8 rate pairs, 4 callback partitions and 2 reset
passes, totalling 75,264 calls and 418,696 compared samples, including malformed
input and capacity-failure cases. All 6 inactive-Delay lifecycle cases passed.
The report records no opened device, starts or audio callbacks. These are
deterministic `pass` contracts, not timing, hardware or tone qualification.
The same development validation's 344-check native Debug runtime suite passed
under `output/review/runtime-Debug-20261018-032025-491e3c`; CrashTests were
intentionally skipped. This does not establish Release behavior or actual ASIO
recovery on the user's device.
Settings validation also passed 18 browser cases, strict E2E types, 9 focused
unit tests and the frontend build. Restart recovery and explicitly disabled
endpoints were verified with mock drivers; physical ASIO behavior remains
`not_asserted`.

The final October 18 **Debug CPU** report is
`output/nam-two-rack/final/20261018_032356_two-rack-1024-final/nam_rack_regression_result.json`,
with executable identity in sibling `executable-evidence.json`. All 60 integrity
cases and both optimization contracts passed; `audioDeviceOpened=false`,
`audioDeviceStartCount=0` and `audioCallbackCount=0` establish no hardware opens.
The 73.624-second run retained these `diagnostic_only` callback measurements;
each cell gives mean / p99 microseconds / misses among 1024 callbacks:

| Rate / buffer | Two-Rack fixture | Mono | Stereo |
| --- | --- | --- | --- |
| 44.1 kHz / 8 | Amp/cab | 107.8 / 183.3 / 13 | 132.1 / 208.1 / 35 |
| 44.1 kHz / 8 | Complete | 251.7 / 480.5 / 1024 | 332.3 / 411.1 / 1024 |
| 44.1 kHz / 8 | Complete + Fuzz | 243.6 / 343.9 / 1024 | 332.1 / 425.6 / 1024 |
| 48 kHz / 8 | Amp/cab | 106.4 / 175.2 / 49 | 125.4 / 199.3 / 35 |

Complete stereo, with and without Fuzz, missed every deadline at every tested
buffer from 8 through 128 samples. Amp/cab stereo was miss-free from 32 samples
upward in this run. Individual output peak `0.998689` and coherent two-Rack sum
`1.997379` are diagnostic level observations; no emergency mute occurred. The
matrix excludes the host/master graph, actual ASIO scheduling, the user's exact
models/settings and Release performance. Substantial nonstationary variation
across the matched captures supports no broad speedup or regression claim.
These deadline failures remain despite passing signal-integrity gates; live
crackle, physical-device stability and tone remain `not_asserted`.

Earlier matched evidence is retained at
`output/nam-two-rack/baseline/20261018_023137_two-rack-1024-baseline/nam_rack_regression_result.json`
and `output/nam-two-rack/after/20261018_024429_two-rack-1024-after/nam_rack_regression_result.json`,
with their executable evidence. Their case identities/model hashes match the
final run; the baseline's 43/62 amp/cab misses at 44.1 kHz / 8 and the earlier
after-run's 11/35 demonstrate why noisy single runs cannot establish an overall
performance improvement.

### Swollen Pickle reference fuzz review, October 23, 2026

This is working-tree evidence against base app commit
`e1cf8024bcc293f6b3ac2ad49caadf84c20193f8`, not a shipped release or a
commercial-pedal match. Lasting control/routing guidance belongs in
[NAM Rack](nam-rack.md#full-rig-fuzz-qualification-october-18-2026) and the
[manual](USER_MANUAL.md); generated reports, screenshots and WAVs stay under
ignored `output/review/fuzz-20261023/` and
`output/review/nam-fuzz-clean-20261023/`.

The reference is the manufacturer's Swollen Pickle MkIIS/MkIII control
manuals, not an inferred circuit clone. Sustain/Filter/Scoop/Crunch and the
internal Voice/Clip controls describe a broad family of sounds; a noise figure
measured in A-weighted analog dBV cannot be compared directly with our
unweighted digital dBFS fixture. The official instructional video was located,
but playback was unavailable and no listening comparison to it is asserted.

**Gain change:** Vintage and Sustain now use `1.5 + 73.5 * drive^4`
excitation rather than `5 + 70 * drive^2`. This reduces small-signal gain at
moderate settings while preserving the 75x maximum. Gated keeps its original
law. No automatic gain matching, extra output trim, new gate, filter,
oversampling island, added latency or state-version change was introduced.
Lower gain also changes sustain and harmonic balance; it is not free noise
reduction. Clean remains the raw input blended before pedal Level and the
later Drive/Distortion stages, now exposed as an on-pedal knob with exact
entry, reset, keyboard adjustment and Undo. Its percentage and Voice both
use black readouts.

The optional `OPENSTUDIO_NAM_FUZZ_SIGNAL_AUDIT=1` branch adds 270
standalone noise/note cases, 90 low-level sine cases and 64 pedal-cascade
cases. Set `OPENSTUDIO_NAM_FUZZ_ONLY=1` and run
`tools/run-nam-rack-headless-regression.ps1 -SkipBuild -AppPath <exact-binary>`
with an isolated output root. The newer gate/partition checks separately
exercise all eight Fuzz/Drive/Distortion masks; they must not turn a failing
whole-chain comparison into a passing Gate claim. All branches remain offline.

| Observation | Interpretation |
| --- | --- |
| Guitar, Drive/Tone 0.5, seeded input noise -72 dBFS RMS: Vintage output -42.90 to -54.24 dBFS; Sustain -45.13 to -56.48 | `diagnostic_only`: about 11.35 dB less amplified noise for this fixture, not a guaranteed hardware noise floor. |
| Synthetic early-note RMS changed by -0.26 to -0.46 dB; late decay by about -7.3 to -7.7 dB | `diagnostic_only`: the gain curve affects compression and quiet decay. No claim of unchanged sustain. |
| Fresh digital silence is exactly zero; post-note silence decays below -198 dBFS | `pass` for the bounded finite/silence contract. Does not exclude pickup/interface noise. |
| Guitar, all three gain pedals, gates disabled: Vintage noise -6.85 to -11.21 dBFS; Sustain -7.65 to -13.06 | `diagnostic_only`: cascaded gain can still produce substantial hiss. The input Gate must be set above the actual idle signal and auditioned for release behavior. |
| 129 paired recorded-guitar/synthetic-bass WAVs for the gain-curve-only iteration | `pass`: 87 files byte-identical, including bypass, Gated and maximum-Drive cases; 42 moderate Vintage/Sustain files changed. This does not certify later Distortion changes or preferred tone. |

**Stacking exposed two independent numerical defects in Distortion.** Its
float antiderivative quotients could turn a one-ULP input change into roughly
0.0018/0.0012 output jumps. Stable interval evaluation now agrees with an
independent integration oracle within 8.88e-8 in 3,578 cases, including bias
changes, constant/zero input, branch boundaries, knees and adjacent floats.

A second defect was the Saturator/Distortion 20 Hz high-pass at the oversampled
rate. At 48 kHz x 8, the actual float coefficients gave `1 + a1 + a2 = 0`;
tiny upsampler partition differences of about 1.96e-8 became 0.028 through
that isolated filter. Double coefficient/state processing kept the difference
near 1.95e-8. The correction preserves the cutoff, order and intended response;
there is no extra filter or latency. It also changes standalone Saturator
low-cut numerics, including the archived signal path, so old output is not
promised byte-identical even though stored controls and recall are unchanged.

The complete production chain then passed the unchanged 1e-5 partition
requirement: maximum difference 1.30e-6 across 32 gain-mask/profile/voice routes,
and 7.16e-7 in the seven localization controls covering standalone Fuzz plus
both internal-Fuzz and identical pre-rendered-Fuzz routes at 2x/4x/8x. Native
oversampling readback was checked. The initial failing captures are retained;
tolerances were not widened. All 64 explicit global-Gate cases also passed.
These are numerical/functional `pass` results; preferred tone and audibility
remain `not_asserted`. The temporary filter trace is replaced by lasting
production-path regression coverage.

The recorded guitar source is the retained CC0 FreePats fixture; bass is
explicitly synthetic. Full-chain captures use the explicitly supplied local
NAM amp and cabinet IR, whose identities/hashes are in each manifest. Their
third-party licensing was not independently certified; these resources and
the rendered pack are not added to the website or app distribution. No WAV
normalization was used. The final 129-WAV pack has 51 files byte-identical to
the original baseline. Comparing the intermediate gain-curve build with the
final precision correction, all 33 direct Fuzz files remain identical and
exactly 48 full-rig files change: all and only the Distortion-enabled masks.
No final file contains a sample above unity. `audition.html` at the evidence
root presents eight before/current pairs with exact settings; all 16 media
resources loaded in Chromium. This verifies the preview, not an audition.
Pedal-only and full-rig captures are separate, and
metrics do not substitute for audition of those exact artifacts.

The broader uncommitted-tree review additionally repaired a Reverb response
capture race (flush pending parameter writes before rendering), wide Reverb
footer overlap, stale ASIO acceptance feedback, the default native-suite
preview-result aggregate, and desktop qualification process cleanup. The UI
coverage inventory now includes Find, and its generator sorts portable source
names consistently across Windows/Linux instead of producing reorder-only
diffs. The Debug realtime optimization list now includes PitchDetector/PitchMapper.
Windows/macOS/Linux CI definitions now invoke the realtime executor contract;
local execution on Windows does not establish the other platforms.

Final frontend qualification passed 2,948 tests across 249 files, focused
NAM unit checks and 58 Chromium cases across seven interaction/editor suites.
The NAM pedal was checked at 640/900/1280/1920/3840 CSS-pixel widths, including
focus, exact entry, reset/Undo and overflow; these are browser fixtures, not
physical mixed-DPI/native-window tests. Python tooling ran 357 tests: 333 passed and 24 platform-specific tests were
skipped. Product naming and UI-inventory checks passed. The default Release
free-suite run passed all 185 checks and offline render/export passed all 264 checks, then
passed again after the Distortion/Saturator precision correction, including
Saturator parallel/dry/partition/reset/recall and transition coverage. Subjective sound remains `not_asserted`.

Final CMake Debug and Release builds completed without compiler warnings.
Each final focused NAM run passed 33 check groups (three diagnostic-only and
two explicitly unasserted groups are separate), including the new nine-case
production low-cut oracle and 2x/4x/8x stack smoke. The low-cut independent
reference error stayed below 7.88e-12; one-ULP input sensitivity stayed below
6.64e-9. All 146 packaged frontend files match `frontend/dist` in both builds.

The final isolated Release CPU comparison covers 28 one-rack cases, three
shuffled repeats each: Guitar/Bass, three Distortion modes, 16/64 frames and
4x/8x, plus four Fuzz/Drive/Distortion stacks. Median-of-three average callback
costs were 4.1-15.2% lower than the frozen curve-only build (median 7.7%).
All 84 final rows had zero observed deadline misses in this short capture;
12 earlier rows contained misses. These are `diagnostic_only` machine-specific
measurements with loaded but bypassed amp/cab models, not four-track host or
physical-driver qualification. Eight Debug processing-thread heap probes,
including warmup, recorded zero allocations and frees. Exact manifests,
resource hashes, frame counts and comparisons are retained in
`cpu-final-comparison.json`, `cpu-final/` and `heap-final/` under the evidence
root. Do not extrapolate a device-safe buffer setting from these stage tests.

The sibling website adds the dated article *Tuning OpenStudio's free effects:
gain, space and the audio deadline*, with reference links and measured limits.
Its build, strict TypeScript and lint passed; focused article/image/SEO tests
passed 11/11 and header/navigation geometry passed 8/8. The full website run
initially passed 233/235, with allocation/browser-launch failures in two OG
image tests; the focused retry passed 5/5 without a code workaround. Actual
article views at 320/1440 px and DPR1/2 passed overflow/image/link checks.
A confirmed narrow-header overlap and inline-Markdown image-discovery gap were
also corrected. No publication was performed.

Release qualification is still open: exact-artifact user listening, sustained
physical-interface recording, the required four-track/16-sample capacity
target, other OS/driver combinations, and the affected Windows 10 Repair
scenario are not cleared by these tests. No candidate version was chosen and
no release-notes, packaging or publication gate was bypassed. The website
article describes development work explicitly; it does not advertise these
changes as released.

### NAM audit, October 22, 2026

This is the **pre-change baseline**, not current-source qualification. The
[maintenance contract](nam-rack.md#cpu-and-pedal-interaction-contract) owns
implementation semantics; the following section records the subsequent repairs.
Retained evidence root: `output/review/nam-rack-audit-20261022/`.

| Baseline | Finding and retained evidence |
| --- | --- |
| Two-Rack CPU | Three Release and one Debug run, 1,024 callbacks per case on Ryzen 9 7900 X. All 60 integrity cases and optimization contracts passed per run, with no hardware opened. Capacity failed in 43/44/41 Release cases and 51 Debug cases. See `cpu-release-summary.json`, `cpu-release-provenance.json`, `cpu-debug-provenance.json` and their four timestamped reports. |
| Complete chains | At 44.1 kHz/8 samples, complete mono means were 210.0–214.4 us without Fuzz and 209.6–214.9 us with it, against 181.4 us; both missed all 1,024 deadlines. Complete stereo also missed every 8–64-sample deadline at both rates, and nearly/all deadlines at 128. Bundled heavy fixtures, fixed ordering and signal-dependent work prevent attributing a Fuzz speedup or the user's constant crackle. Coherent summed peak 1.997379 is a separate headroom diagnostic. |
| Fuzz structural/audio exports | `fuzz-release-summary.json` and `fuzz-release/fuzz-44690b14/manifest.json`:16 passes,5 diagnostics,1 unasserted;33 pedal exports,96 full-chain renders and 144 boundary cases. Full-chain peak 0.297531843 with zero guard hits. The Fender Twin/Mesa V 30 fixture fixes Octave on/Clean 0, omits Crunch and surrounding effects, and uses arranged guitar/synthetic bass. Boundary pre-Amp peaks exceed unity in 52/144 cases (max 3.891745); voice RMS spread 14.283710 dB is diagnostic, not tone approval. |
| Octaver retirement | The isolated actual-source probe's `octaver-probe/results.json`, source/executable hashes and execution record retain 41 failed exact partition comparisons out of 73. Both wet voices 12/24 (max 0.168061169), Down 14/24 (0.012105137), Up 14/24 (0.008062690), overlapping profile 1/1 (0.001221936). Pre-reentry audio and metadata stayed exact. At 48 kHz, fade at 4096 plus 959 ramp samples and 19 fully-off samples first differs at 5074: callback-dependent retirement state, not a ramp-law failure. This does not explain crackle with Octave disabled. |
| Actual saved presets | `preset-audit.json` retains Bestest and both bass alternatives plus five model/IR hashes. All saved states have Octave/Fuzz off; Bestest already enables Drive. Models are 48 kHz, while saved device state was 44.1 kHz/8/2 x and the user reported 4 x. Neither saved settings nor labels establish historical live state. One version 2 Bass-labelled payload canonically restores Guitar; never infer a migration override from its name. No preset was modified during the audit. |

Measured executable SHA-256:
Release `cd32fe8ed3ef9329fbd8c8ad21b5da7935ca235efbdfa486da3116c0df0bc52e`;
Debug `503d2c81c0a27d218b0d9a2d9031f158c34fcdf1b8059b797c4690f6c57b5a71`.
Exact runs are `20261022_190141_cpu-release-1`,
`20261022_190248_cpu-release-2`, `20261022_190355_cpu-release-3` and
`20261022_191331_cpu-debug`, each containing
`nam_rack_regression_result.json`. Full Fuzz results are in
`fuzz-release/20261022_190854_fuzz-interaction/nam_rack_regression_result.json`.
These wall-time measurements exclude the live host/device/UI; timing is
`diagnostic_only`, measured capacity is `fail`, and audible severity is
`not_asserted`.

### NAM implementation qualification, October 22, 2026

The follow-up work uses `output/review/nam-implementation-20261022/` for
native evidence and `output/review/nam-rack-implementation-20261022/ui/` for
browser screenshots/results. These are local ignored artifacts, not shipped
fixtures or proof of release qualification. The audit above records the
pre-change baseline; its failures are not silently replaced by newer passes.

The initial candidate passes the resampler, inactive-delay and new
Drive/Distortion coefficient-cache reference contracts. The cache comparison
uses 48 combinations of instrument profile, channel routing, oversampling and
sequential reprepare rates; control automation, retired internal OD808,
bypass/edit/reactivation and reset are included. Cached and forcibly recomputed
processing must produce exactly equal samples, while coefficient-design counts
decrease. This proves transparent output for those cases, not a CPU percentage.
All **129 default Fuzz WAVs** (33 pedal and 96 amp/cab renders) match the frozen
pre-change executable byte for byte: `default-fuzz-parity.json`.

Final Release and Debug builds completed with zero compiler warnings. Identities
are in `final-native-provenance.json`. The strengthened cache reference has
actual mono/stereo buses and 12 combined lifecycle events plus 19 isolated edits
per row. All 48 rows pass in both configurations. Permanent Octaver tests pass
3,024 retirement, 168 profile and 216 Octaver-to-Fuzz comparisons, all exactly;
72 frozen unaffected old-code comparisons remain exact. Native profile-copy
regressions pass all 14 filesystem/migration checks without changing user presets.

The extended interaction manifest is
`fuzz-extended-release/fuzz-482c538b/manifest.json`: **531/531** full-chain
integrity cases pass, with zero ordinary output-guard hits and maximum native
sample peak `0.459602177`. There are 384 topology, 36 Clean, 27 calibration,
63 octave-presence and 21 gate cases, distributed equally over arranged guitar
low notes, arranged guitar chords and synthetic B0 bass decay. The original
144 boundary cases and 33 pedal exports also pass. Actual native float WAVs,
input/resource hashes and recall state are retained. The source is not the
user's original performance; all sound preference claims remain `not_asserted`.

That combined run intentionally remains recorded as failed because the first
alias measurement engaged the final output guard in 48/144 primary cases.
There was no nonfinite output, emergency mute or processing fallback. A corrected
measurement uses fixed **-18 dB post-chain trim**, leaving input/interstage drive
unchanged and still requiring zero guard hits. The separate final Release and
Debug alias reports pass all measurement contracts: 144 primary cases,
36 factor cases, 18 reference comparisons and 36 exact PDC-aligned inactive
factor comparisons per build. Linear commutation, deliberate nonlinear failure,
known fractional delay and gain-error controls pass. Residual magnitudes and
consecutive-period differences remain `diagnostic_only`; no sound-quality
threshold was invented to turn this into a tone pass.

All **600** repeated CPU/stress runs below pass processing integrity. Every
aggregate capacity result is **fail** because at least one included run misses
an offline deadline. Counts exclude warmup and use full measured callbacks.
The detailed aggregates are `cpu-evidence-summary.json` and the associated
exact-preset, isolated-stage and long/stress analysis files.

| Matrix | Runs | Measured callbacks | Deadline misses |
| --- | ---: | ---: | ---: |
| Exact presets, Debug | 156 | 187,794 | 271 |
| Exact presets, Release | 156 | 187,794 | 150 |
| Isolated stage settings, Release | 192 | 281,280 | 71 |
| Sustained exact presets, Release | 24 | 111,642 | 132 |
| Sustained exact presets, Debug | 24 | 111,642 | 119 |
| Bounded one/two/four-Rack stress, Release | 48 | 45,128 | 30,588 |

Short exact/stage cases use 0.25 s warmup and 0.5 s measurement; sustained cases
use 10 s excitation then 2 s measurement; stress uses 0.25 s each. Exact-preset
and stage cases have three shuffled repeats; stress has two. Debug/Release
outputs match across all **528 channel hashes** for matched short and sustained
exact-preset runs. All preset/model/IR identities are consistent. Fuzz is off in
these exact saved-preset cases, so they do not demonstrate Fuzz-caused crackle.

For the sustained two-track fixtures at 44.1 kHz / 4x, Debug plus Release have
zero misses in 16,548 callbacks at 64 samples and 8,280 at 128. Eight samples
misses 164/132,300 callbacks and sixteen misses 87/66,156. Start a full-app
audition at **128 samples**: the worst measured 64-sample load reached 98.2%
in Release, leaving little margin for excluded host/device/UI work; 128's
worst loads were 44.4% Release and 53.1% Debug. This is a test starting point,
not a universal hardware guarantee. Stress at 192 kHz and four stereo Racks
overloads even 512 samples in the retained eight-times-Drive cases.

These offline misses do not identify the cause of the reported constant
crackling. The timing loop runs on the headless control thread, without the
live ASIO callback's MMCSS registration, and measures wall time including
preemption. The sustained Release eight-sample pairs average approximately
60.2 and 38.1 microseconds against a 181.4-microsecond block budget; isolated
maxima exceed the budget despite substantially lower typical costs. Scheduling
interference and host work must be measured in the actual callback before
attributing those spikes to NAM or changing its sound. The earlier silent
8-to-16 buffer transaction tests establish setting acceptance only, not loaded
two-track stability.

The opt-in `--nam-live-callback-probe` tests those missing host/device layers:

```powershell
build/OpenStudio_artefacts/Debug/OpenStudio.exe --nam-live-callback-probe Audient --guitar-preset "<Bestest preset path>" --bass-preset "<bass preset path>" --output-dir "<new evidence directory>"
```

Run with other audio clients closed and supply each recovered bass preset in a
separate invocation. It opens the selected ASIO interface at 44.1 kHz/4x with
8/16/128-sample buffers, each with 10 seconds warmup and 10 seconds measurement.
Physical input pointers are ignored; precomputed independent mono sources feed
the complete AudioEngine callback, and physical outputs remain silent. The
probe verifies enabled stages, both input routes and NAM execution, faults and
MMCSS, then restores the observed inactive-driver rate/buffer and verifies the
saved settings are unchanged. It never saves the supplied presets.

Per-buffer CSV files preserve sampled callback timing order; all callbacks
contribute to counts, extrema and histogram percentiles. `engineCapacityStatus`
covers the complete engine invocation, including its telemetry tail and worker
completion, but excludes the probe and surrounding JUCE/ASIO wrapper. `deviceCapacityStatus`
reports driver xruns separately; unsupported readback remains `not_asserted`.
Arrival intervals are `diagnostic_only` because driver batching can affect
them. The process has no WebView, and silent synthetic signals cannot certify
live instrument tone or absence of audible crackling. Report success covers
processing integrity and restoration, not a universal capacity guarantee.

Retained pre-multicore live Debug results are in
`output/review/nam-live-callback-20261022/`, under `bass-clean-debug2` and
`bass-driven-debug`. Each invocation passes all 17 configuration, processing
and restoration checks. Unlike the earlier offline matrix, these measurements
run on the real Audient callback with MMCSS active and include both armed
TrackProcessors and the complete AudioEngine invocation.

| Buffer | Bestest + Bass Clean deadline misses | Bestest + Bass Driven deadline misses |
| --- | ---: | ---: |
| 8 | 2,795 / 55,125 | 322 / 55,125 |
| 16 | 429 / 27,562 | 125 / 27,562 |
| 128 | 0 / 3,445 | 0 / 3,445 |

The worst 128-sample engine durations use 53.7% and 62.7% of the block budget.
Both racks execute with their requested mono routes, loaded amps and 4x drive
oversampling; fault/bypass/lock/resize counters remain zero. Eight- and
sixteen-sample engine capacity is **fail** for these runs; 128 is **pass within
this bounded scope**. Audient returns -1 for driver xruns, so device capacity
is **not_asserted**. JUCE's separate manager count includes host overruns and
must not be described as an Audient dropout counter.

Synthetic master peaks reach +3.23 dBFS with Bass Clean and +1.63 dBFS with
Bass Driven, even though physical outputs are muted. This is separate summed
headroom evidence: use post-FX track/master gain to keep actual output below
full scale; a larger buffer cannot correct excess output level. Live instrument
clipping and subjective audio remain **not_asserted**. The initial probe built
CSV text before collecting rolling stage telemetry, allowing its eight-sample
window to expire; raw timing traces and cumulative counters remain valid. The
probe now captures snapshots before report generation. Available 16/128
samples identify the broad track/FX/routing stage as dominant, without
isolating an individual effect or proving a scheduling cause.

The Release repeats (`bass-clean-release`, `bass-driven-release`) also pass
all 17 integrity/restoration checks each. For the same measured callback
counts, Bass Clean records 1,415/160/0 deadline misses at 8/16/128 samples;
Bass Driven records 47/79/0. Their maximum 128-sample engine loads are 47.4%
and 30.6%. Across both builds and presets, 128 samples has zero misses in
13,780 measured callbacks; this remains bounded evidence with no visible UI
or physical instrument signal. Release improves typical processing cost but
does not qualify 8/16 samples. Corrected Release snapshots retain the
eight-sample stage window and again identify track/FX/routing as dominant.

The preview correction passes `instrument-preview`, `ir-audition` and
`preview-callback-bounds` in Debug and Release. These cover lease publication,
preparation, release/stop and reopening; exact compact-buffer scrub parity;
poisoned scratch/output suffixes; zero/over-capacity bounds; and actual offline
AudioEngine callbacks at 5/8/16/127/512 samples against a fake 512-sample device.
CPU savings from this small correction and audible improvement are not asserted.
Both native builds complete without compiler warnings. `hardware-tested-native.json`
records tested executable hashes; the final Debug refresh additionally includes
the reporting-order correction, which does not change production DSP.

At 44.1 kHz / 8 samples / 4x, independent median stage differences suggest
Fuzz adds approximately 0.95-1.41 microseconds, Octaver 3.4-3.9, Drive 1.5-2.1,
Distortion 9.6-10.6 and the bass Reverb/PAD texture about 8.75. These are
`diagnostic_only` differences between separately repeated runs, not sampled
CPU profiles. The stage baseline still processes the loaded Amp while its
power is off: the Rack keeps neural history warm before the power blend.
Consequently Amp-on minus that baseline does **not** measure model cost.
Room/Doubler fixtures include Cab and must be compared against Cab alone.
Suspending neural/Fuzz voices, sharing stereo histories or decimating safety
checks is deferred until a defined re-entry contract and measured benefit exist.

Long synthetic renders reach unattenuated two-track sums of 1.291 (+2.22 dBFS)
with Bass Clean and 1.190 (+1.51 dBFS) with Bass Driven. Bestest and Bass Driven
also engage the per-Rack ordinary output guard in some cases; no emergency mute
occurs. These pre-mixer sums are a separate headroom diagnostic, not proof of
master/device clipping or the reported crackle. Check actual track/master
levels during audition; no preset gain was silently normalized.

The four initial and 24 extended Debug CRT heap scenarios observe zero
allocations/frees inside processing, including warmup, irregular callbacks,
Fuzz voices/Clean, one/two/four Racks and mono/stereo stress. Eight malformed
CPU manifests are rejected before any scenario processing. These bounded tests
do not prove absence of every allocator, blocking operation or possible runtime
transition.

Use the existing focused runner for opt-in complete preset scenarios:

```powershell
tools/run-nam-rack-headless-regression.ps1 -SkipBuild -AppPath <exe> `
  -CpuScenarios <manifest.json> -OutputRoot <new-review-root>
```

The manifest has `schemaVersion: 1`, `warmupSeconds`, `measurementSeconds`,
`repeats`, and `cases`. Each case names an `id`, `sampleRate`, `bufferPattern`,
`oversamplingFactor`, `routedInputChannels` and one to four `racks`; each Rack
specifies an absolute `presetPath`, synthetic `input` (`guitar`, `bass` or
`silence`) and optional numeric parameter `overrides`. Optional
`probeCallbackHeap: true` instruments Debug CRT allocation/free activity on
the processing thread; it does not cover every allocator or other threads.
`exportDirectory` writes unnormalized float WAVs to a new directory. Presets
are migrated in memory; original files and active app state are not changed.
Resource hashes, canonical state, readback and actual NAM execution are retained.

Cases use fixed audio duration, full measured callbacks and deterministic
shuffled repeats. `success`/`objectiveGateStatus` describe processing integrity;
`capacityStatus` separately fails if any measured callback misses its offline
deadline. Add `-RequireCapacity` when that is the intended gate. Means,
p99/p99.9/max, deadline fractions and misses are diagnostic timings excluding
device scheduling, the host graph, editors and the master chain.

The focused Fuzz runner accepts `OPENSTUDIO_NAM_FUZZ_EXTENDED=1` to extend
full-chain topology/context coverage, and `OPENSTUDIO_NAM_FUZZ_ALIAS=1` for
aligned Fuzz/Drive/Distortion complex-residual measurements. The latter's
linear, deliberately nonlinear and fractional-delay controls qualify the
measurement; residual magnitudes remain `diagnostic_only`, including filter,
ADAA and envelope differences. Neither flag establishes an audible tone pass.

With other audio clients closed, the explicit hardware diagnostic is:

```powershell
OpenStudio.exe --audio-buffer-probe Audient --output-dir <new-directory>
```

It now requests 8, 16, 64, then 8 samples through the app's device transaction, checks
actual callback sizes, restores the initially observed rate/preferred buffer,
and verifies saved settings bytes are unchanged. Physical input pointers are
never read or recorded; output samples are cleared. This tests device-setting
acceptance, not two-track NAM capacity, guitar quality or audible crackling.

The earlier October 22 Release hardware run used the original 8/16/8 sequence
and passed all ten checks on **Audient USB Audio ASIO
Driver at 44.1 kHz**: 4,145 callbacks at 8 samples, 2,067 at 16 and 4,195 at 8;
each step's minimum and maximum callback size matched its request. The original
44.1 kHz / 8-sample configuration was restored and saved settings remained
byte-identical (`asio-buffer-transaction/result.json`). Driver xrun reporting
returned `-1` (unavailable), so this is not an underrun-count assertion. A
concurrent offline render was running; no other audio client or project was
opened. The browser Settings tests independently cover preserved draft choices,
late/stale responses, rejection, coercion feedback and keeping OK open when the
accepted buffer/rate differs. Those earlier tests did not exercise the returned
native discovery JSON and did not establish the cause of the reset to 8.
The October 22 Debug executable independently passed the same ten hardware checks
with restored driver/settings state (`asio-buffer-transaction-debug/result.json`).
Neither run processes NAM on the physical callback or records input audio.

The October 23 follow-up identified a same-device discovery publication bug:
the linked JUCE 9 `NamedValueSet::set` ignores an object replacement when its
contents compare equal. The query assigned an equal clone before changing its
rate/buffer, so the returned object's `current` could remain at 8 while the local
draft and log said 64. The correction publishes the fully resolved draft at the
end, including failure paths. Regression coverage calls the real engine query
and inspects its returned JSON for 16/32/64/128-sample edits, sample-rate changes,
and discovery failure, while verifying that the active snapshot remains intact.
The frontend mocks had constructed the desired draft directly, so their passing
dropdown tests could not catch this native serialization boundary.

The same follow-up adds explicit **Active audio** and **Pending** values to
Settings. The 32 focused frontend tests, 10 existing Chromium Settings scenarios,
and frontend build pass; Vite still reports its existing large-chunk/dynamic-import
warnings. A separate Edge browser fixture verifies visible 64 pending while
Active audio remains 8, Apply changing Active audio to 64, and Cancel discarding
128 so reopening still shows 64 (`output/playwright/audio-buffer-active64.png`).
This is a browser fixture, not a complete desktop WebView/driver integration run.
Debug and Release builds pass `--realtime-track-self-test`: 12 executor checks,
graph eligibility, and 36 full-engine checks, including ten new query-publication
and probe checks: eight query/publication checks and two probe-oversampling
guards. A reproducer linked to the exact JUCE core confirms returned 8/local 64
before final publication and returned 64 afterward.

The extended silent Audient transaction passes all 11 checks at 44.1 kHz: 4,132
callbacks at 8 samples, 2,064 at 16, 516 at 64 and 4,140 at 8, with exact minimum
and maximum callback sizes at each step. It restores 44.1 kHz/8 and leaves saved
settings byte-identical. Driver xrun reporting remains unavailable (`-1`), and
NAM capacity/audio quality are `not_asserted`. Evidence is retained under
`output/review/audio-buffer-20261023/`, including `contracts-debug.json`,
`contracts-release.json` and `silent-buffer-change/result.json`.

The subsequent loaded two-track follow-up is summarized in
`output/review/audio-buffer-20261023/hardware-summary.json`, with individual
reports under `debug-2-clean-8x`, `debug-2-driven-8x`, `release-2-clean-8x` and
`release-2-driven-8x`. Both builds completed without compiler warnings. Debug
SHA-256 is `7dfc79de58477cc9b5641d905ac85e8d77f53f82087689c9701390bd112e1392`;
Release is `978d41f9f9a97d59b08abaef0e293145b0c374b901636b27377a7cb1529e3f19`.
Each case runs Bestest clean with guitar Distortion engaged plus one of the two
recovered bass presets, at 44.1 kHz with requested and active **8x** Drive
oversampling verified. Both tracks are armed, monitored and recorded. Automatic
helpers are enabled, with polling and recovery grace both zero. Warmup is three
seconds, followed by ten measured seconds per case. Fuzz and Octave remain off
as saved in these presets; this is not an all-pedals-engaged qualification.

| Build / bass preset | Buffer | Mean / p99 / max engine time, us | Outer misses | Worker misses / quarantined blocks / cancelled jobs | Engine capacity |
| --- | ---: | ---: | ---: | ---: | --- |
| Debug / clean | 8 | 112.4 / 219.0 / 454.3 | 1,610 | 5,769 / 6,178 / 6 | `fail` |
| Debug / clean | 16 | 180.3 / 352.9 / 633.6 | 172 | 546 / 214 / 0 | `fail` |
| Debug / clean | 64 | 430.5 / 697.3 / 943.9 | 0 | 0 / 0 / 0 | `pass` |
| Debug / driven | 8 | 90.1 / 155.2 / 444.2 | 228 | 462 / 73 / 20 | `fail` |
| Debug / driven | 16 | 134.5 / 211.2 / 521.7 | 12 | 17 / 0 / 0 | `fail` |
| Debug / driven | 64 | 399.5 / 640.6 / 880.2 | 0 | 0 / 0 / 0 | `pass` |
| Release / clean | 16 | 110.1 / 218.3 / 407.6 | 2 | 10 / 9 / 0 | `fail` |
| Release / clean | 64 | 320.0 / 583.9 / 861.7 | 0 | 0 / 0 / 0 | `pass` |
| Release / driven | 16 | 104.3 / 184.2 / 467.4 | 38 | 43 / 0 / 0 | `fail` |
| Release / driven | 64 | 292.4 / 453.5 / 643.1 | 0 | 0 / 0 / 0 | `pass` |

The nominal budgets are 181.4, 362.8 and 1,451.2 us for 8, 16 and 64 samples.
Outer timing covers 55,125, 27,563 and 6,890 measured callbacks respectively;
worker counters use per-case deltas across warmup and measurement. Rejected jobs
and batches are zero throughout. All four 64-sample cases pass both outer and
worker capacity, including zero quarantine/cancellation. All six smaller-buffer
cases fail. Quarantined callbacks can skip DSP, so their low mean is not a
throughput improvement. These bounded two-track results do not replace the
historical four-/twelve-track 4x failures below or qualify eight-sample use.

All ten cases pass processing integrity. All four runs restore the observed
driver configuration and saved settings. All **20 raw mono WAVs** pass exact
frame count/rate and every-sample parity within two 16-bit PCM LSBs; there are no
recording write failures. The real Audient ASIO callback processes independent
synthetic inputs; physical inputs are ignored and physical outputs are cleared.
Timing includes the full engine callback but excludes the probe, surrounding
JUCE/ASIO wrapper and WebView. Driver xruns remain unavailable, so device-path
capacity is `not_asserted`. The unchanged preset gains sum above full scale in
every case (64-sample peaks approximately 1.182 for clean bass and 1.350 for
driven bass); this is `diagnostic_only` headroom evidence, separate from timing.
A larger buffer cannot correct excess output gain. Thirty-minute endurance,
visible-app/control interaction, physical guitar/bass routing, round-trip
latency and audible crackle/tone acceptance remain `not_asserted`.

Frontend evidence records 82 focused unit passes, 20 Settings scenarios across
Chromium/WebKit and seven NAM workflow/geometry browser scenarios, with compact
through 4K/DPR2 screenshots. A subsequent exact-entry clamp/rounding correction
passes all seven tests in its focused unit file; that small follow-up did not
rerun the browser matrix. Production/E2E TypeScript and `npm run build` pass.
Vite retains large-chunk and ineffective-dynamic-import warnings; these are not
reported as a warning-free frontend build. Debug's copied `webui` assets are
current and no Codex-owned server is required or left listening on 5183.

### Multicore NAM live qualification, October 23, 2026

The development executor now runs eligible independent NAM tracks concurrently
within the current device block. Automatic mode uses physical cores minus one
helpers, with the callback participating; neither the engine nor the scheduler
has a four-track cap. The current per-track eligibility rule, serial fallback,
raw recording and late-work ownership contract are defined in the
[NAM guide](nam-rack.md#four-track-live-monitoring-acceptance-target).
This implementation is **not yet a pass** for four recording/monitored Racks
at 16 samples, and it does not close the user's eight-sample crackling report.

Run the deterministic device-free gate against each build before hardware
timing. This combines executor ownership/cancellation, actual NAM graph
eligibility, and full-engine serial/parallel routing, recording, scratch-bound
and lifecycle checks. It opens no physical audio device or app window:

```powershell
build/OpenStudio_artefacts/Debug/OpenStudio.exe --realtime-track-self-test "<new evidence directory>/debug-contracts.json"
build/OpenStudio_artefacts/Release/OpenStudio.exe --realtime-track-self-test "<new evidence directory>/release-contracts.json"
```

The pending-worker fixtures hold an actual batch across callbacks. All queued
NAM owners, including completed lanes, must remain untouched until retirement;
unowned tracks must continue serially without dispatching another batch. The
six-track case adds an unrelated source/send/destination pair and checks its
monitoring sum and recorded pre-FX send mixture while the four NAM lanes retain
their raw recordings. This protects unrelated routing; a newly connected route
from a quarantined source cannot recover that source's unavailable signal.
Conversely, a newly published incoming send into a quarantined destination is
preserved in that destination's raw recording through the callback-owned
current send accumulator, without accessing its pending DSP buffers.

The qualified Release and final Debug builds completed with zero compiler warnings. Both
`output/review/multicore-20261022/contracts-release-qualified.json` and
`contracts-debug-final.json` report **pass** for all 12 executor checks, the
graph-eligibility suite and all 26 full-engine checks. Coverage includes stopped/playing send, sidechain and
output-route arithmetic in Float32/Hybrid64, retained-owner-only quarantine,
unrelated and newly added incoming-send recording, raw input continuity and
stop/lifecycle ownership. The corrected recording oracle explicitly accounts
for the real six-sample PDC delay rather than weakening sample tolerances.
This also verifies the functional fix for stopped live hardware input
overwriting an incoming-send mixture. Actual-device capacity remains separate.
The current Release and Debug render/export regressions each pass all **264**
checks with zero failures, including the explicit zero-device offline launch
contract. Their reports are
`20261023_005343_final-release-routing/render_export_regression_result.json`
and `20261023_010303_final-debug-routing/render_export_regression_result.json`
under the same evidence directory. Export correctness does not qualify the live deadline.
The final Debug runtime-safety run also passes all **344** checks with zero
failures (`runtime-safety-final/result.json` under that evidence directory).

These deterministic contracts do not certify real-device deadlines. For a
short, controlled live comparison, close other audio clients and stop builds,
browser capture and CPU-heavy tests. Keep each run in a new output directory:

```powershell
# Serial baseline: four independent inputs, two copies of each supplied preset.
build/OpenStudio_artefacts/Debug/OpenStudio.exe --nam-live-callback-probe Audient --guitar-preset "<Bestest preset path>" --bass-preset "<bass preset path>" --output-dir "<new serial evidence directory>" --probe-tracks 4 --probe-rate 44100 --probe-buffers 16 --probe-workers 0 --probe-warmup-seconds 3 --probe-seconds 10

# Same workload with automatic helpers and event-based wakeups.
build/OpenStudio_artefacts/Debug/OpenStudio.exe --nam-live-callback-probe Audient --guitar-preset "<Bestest preset path>" --bass-preset "<bass preset path>" --output-dir "<new parallel evidence directory>" --probe-tracks 4 --probe-rate 44100 --probe-buffers 16 --probe-workers -1 --probe-warmup-seconds 3 --probe-seconds 10

# Explicit recording check; writes synthetic raw inputs into this evidence directory.
build/OpenStudio_artefacts/Debug/OpenStudio.exe --nam-live-callback-probe Audient --guitar-preset "<Bestest preset path>" --bass-preset "<bass preset path>" --output-dir "<new recording evidence directory>" --probe-tracks 4 --probe-rate 48000 --probe-buffers 16 --probe-workers -1 --probe-recording --probe-warmup-seconds 3 --probe-seconds 10
```

Repeat with the other recovered bass preset and the Release executable. The
probe alternates independent guitar/bass processor states on separate
synthetic mono channels, even when the physical interface has only two inputs.
Physical input pointers are never read and physical outputs remain silent.
Guitar Distortion is enabled; all other requested stage enables, model/IR
identities, the requested oversampling, input peaks and executed NAM frames are checked.
It restores the inactive driver's observed rate/preferred buffer and verifies
saved settings are byte-identical. It never saves source presets.

`--probe-tracks` accepts 1-64 for the harness; this is a probe bound, not a DAW
track limit. `--probe-rate` accepts 44100, 48000, 88200, 96000, 176400 or 192000;
the driver must actually accept the request. `--probe-buffers` accepts a comma
list, `--probe-workers 0` selects serial and `-1` selects automatic helpers.
`--probe-oversampling` accepts 2, 4 or 8 and defaults to 4. This applies to the
native Precision Drive and Distortion stages; it does not change NAM model or
Fuzz quality. Record the selected factor with every workload comparison. The
historical final matrices below used 4x throughout.
`--probe-worker-spin-us 500` is an opt-in comparison of bounded active polling;
zero is the default event-based policy. The allowed polling range is 0-2000
microseconds, and its CPU/power cost must be assessed separately.
`--probe-worker-grace-us` separately permits 0-2000 microseconds of diagnostic
recovery waiting after the nominal worker collection deadline. Its default,
including in the normal app, is zero. This can help distinguish immediate
cancellation/quarantine from slightly late completion; a nominal deadline miss
still increments the failure counter and fails capacity even if the worker
finishes within the grace. It adds no audio buffering and cannot turn a late
16-sample callback into a pass. Record the requested grace with every result.
Measurement duration is 1-1800 seconds, with 0-60 seconds warmup. Use 1/2/4/8/12 tracks as
targeted scaling points, not a full Cartesian sweep before the failing
four-track case is understood.

For recording, every resulting mono WAV must have the exact processed frame
count and rate, nonzero input, and sample parity with its independent synthetic
source within two PCM least-significant bits (2e-6 for floating-point files).
Warmup and measurement are both recorded. A valid raw file does not prove that
software monitoring avoided dropped work. For longer runs, timing memory is
bounded: all callbacks contribute to counts/histograms, while CSV holds at most
65,536 uniform samples plus the first 4,096 deadline misses. Histogram
percentiles are upper-bin bounds, not sorted exact percentiles.

Interpret the report fields separately:

- `processingIntegrity` gates requested state, nonzero finite execution,
  callback safety and requested recording checks. Top-level `success` and a
  zero exit code describe integrity/restoration, **not capacity**.
- `callbackDurationCapacityStatus` checks the measured outer engine duration.
  `workerCapacityStatus` checks per-case deltas across warmup and measurement
  for missed deadlines, cancelled/rejected jobs, rejected batches and quarantine.
  `engineCapacityStatus` fails for either kind of overload; returning early by
  dropping work cannot pass. Worker snapshots are captured before device stop,
  preserving actual helper/MMCSS and executed-job witnesses.
- `deviceCapacityStatus` is separate driver xrun readback. Audient's unsupported
  `-1` remains `not_asserted`; JUCE's manager count also includes host overruns.
  Arrival intervals and synthetic summed clipping remain `diagnostic_only`.
- The proxy times the full engine callback, including its telemetry tail, but
  excludes proxy preparation/inspection, JUCE/ASIO wrapper work and a WebView.
  Actual instrument routing, audible quality and full-app stability remain
  `not_asserted` until tested directly.

**Qualified Release measurements:**
`output/review/multicore-20261022/release-final-matrix-summary.json` summarizes
nine invocations and ten buffer cases on the inspected Ryzen 9 7900X/Audient
system. Every result identifies the same executable SHA-256,
`b100fdc94bd9868752750083dfe909dfafd2b2ce64ff2d41b318ac420de1ec1d`.
All configuration, processing-integrity, requested recording and
driver/settings-restoration checks **pass**. All ten strict engine-capacity
cases **fail**. Driver xrun readback is unsupported (`-1`) in every case and
remains **not_asserted**.

Each case uses 4x Drive oversampling and three seconds warmup. Non-recording
cases measure ten seconds; recording cases measure fifteen seconds. Bestest
with Distortion enabled alternates with Bass Clean unless Driven is named.
Automatic mode starts 11 MMCSS helpers; four-track batches use at most three,
while twelve-track batches can use all eleven. The default event-based policy
and zero recovery grace apply except in the two explicit diagnostic comparisons
below. Sixteen samples provide 333.3 us at 48 kHz or 362.8 us at 44.1 kHz;
eight samples at 44.1 kHz provide 181.4 us.

| Workload | Mean / p99 / max engine time (us) | Outer misses / measured callbacks | Worker misses / quarantined blocks |
| --- | --- | --- | --- |
| 4 tracks, 48 kHz / 16, serial | 338.2 / 550.8 / 1,006.3 | 6,106 / 30,000 | 0 / 0 |
| 4 tracks, 48 kHz / 16, automatic | 169.6 / 291.7 / 377.2 | 12 / 30,000 | 171 / 106 |
| 12 tracks, 48 kHz / 16, automatic | 186.6 / 313.8 / 483.9 | 28 / 30,000 | 387 / 355 |
| 12 tracks, 48 kHz / 16, 5 helpers | 227.1 / 424.5 / 659.3 | 2,656 / 30,000 | 11,264 / 11,736 |
| 4 recording tracks, Clean, 44.1 kHz / 16 | 189.1 / 311.8 / 418.3 | 11 / 41,344 | 93 / 52 |
| 4 recording tracks, Clean, 48 kHz / 16 | 168.8 / 289.1 / 456.3 | 25 / 45,000 | 206 / 125 |
| 4 recording tracks, Clean, 44.1 kHz / 8 | 123.6 / 171.5 / 413.8 | 503 / 82,687 | 5,807 / 6,010 |
| 4 recording tracks, Driven, 48 kHz / 16 | 129.1 / 204.4 / 386.5 | 4 / 45,000 | 12 / 4 |

Outer counts cover measurement only; worker/quarantine counts are per-case
deltas across warmup and measurement. These overlapping counters are not
additive. Callback averages include overload containment, so lower timings
cannot be interpreted as equivalent complete-work throughput when lanes were
skipped. The five-helper twelve-track case additionally cancelled 87 jobs;
the eight-sample recording case cancelled two. Scaling beyond four tracks is
demonstrated, but neither a lower helper count nor a low p99 met capacity.

The optional four-track/48 kHz/16-sample polling comparison
(`release-4-48000-spin500`) averages 160.0 us, with 13 outer misses, 92 worker
misses and 59 quarantined blocks. The 1,000 us recovery-grace comparison
(`release-4-48000-grace1000`) completes all 173 late batches without quarantine,
but records 99 outer misses and still fails its nominal worker deadline gate.
Neither experiment qualifies 16 samples or changes the app defaults: polling
and recovery grace remain off.

All four recording cases produce four valid files each: **16 mono PCM files
pass** exact frame-count/rate checks and full raw-input parity within two
16-bit LSBs. The 44.1 kHz/16 and /8 cases contain 793,808 and 793,800 frames per
file respectively; both 48 kHz cases contain 864,000. These include warmup.
No write failures are reported, despite monitoring capacity failures. Synthetic
master peaks exceed full scale in every case; summed headroom still needs
separate gain adjustment and is not evidence of physical output clipping,
because the probe keeps the device output silent.

**Final Debug measurements:**
`output/review/multicore-20261022/debug-final-matrix-summary.json` covers five
invocations and six buffer cases using executable SHA-256
`c69bf47111c1517ed140c6be47519da300a56d8dbf566e549fcdf6426bf4209b`.
Every case records all its armed tracks, uses 4x Drive oversampling, and passes
configuration, processing-integrity, recording and restoration checks. All six
strict engine-capacity cases **fail**; driver xrun readback remains
**not_asserted**. These are the Debug path used by `python build.py dev --run`,
without the visible UI or physical instrument signals.

| Recording workload | Mean / p99 / max engine time (us) | Outer misses / measured callbacks | Worker misses / quarantined blocks |
| --- | --- | --- | --- |
| 4 tracks, Clean, 48 kHz / 16, serial | 481.1 / 756.5 / 1,161.7 | 30,000 / 30,000 | 0 / 0 |
| 4 tracks, Clean, 48 kHz / 16, automatic | 205.9 / 324.2 / 554.5 | 147 / 45,000 | 1,081 / 728 |
| 4 tracks, Clean, 44.1 kHz / 16, automatic | 215.2 / 352.9 / 572.9 | 83 / 41,344 | 600 / 492 |
| 4 tracks, Clean, 48 kHz / 8, automatic | 84.5 / 209.0 / 386.5 | 11,288 / 90,000 | 45,338 / 54,767 |
| 12 tracks, Clean, 48 kHz / 16, automatic | 250.7 / 368.5 / 702.9 | 714 / 30,000 | 3,097 / 1,976 |
| 4 tracks, Driven, 48 kHz / 16, automatic | 192.5 / 286.5 / 435.9 | 10 / 45,000 | 120 / 84 |

All Debug runs use three seconds warmup and the default event-based policy
with zero recovery grace. The serial and twelve-track cases measure ten
seconds; the other cases measure fifteen. Worker columns again use **per-case
deltas**, including warmup, rather than lifetime totals carried over from a
previous buffer. In particular, the Debug eight-sample row is 45,338 worker
misses and 54,767 quarantined blocks; the corresponding Release 44.1 kHz row
above is 5,807 and 6,010. The Debug eight-sample mean of 84.5 us reflects
extensive skipped DSP during quarantine, not a successful speedup or usable
monitoring result; its 48 kHz device period is only 166.7 us.

All **32 Debug recording files pass**, with zero reported write failures and
full 16-bit PCM parity within two LSBs. Serial and twelve-track files contain
624,000 frames each; 44.1 kHz files contain 793,808; the other 48 kHz files
contain 864,000. Together with the Release cases, **48 files** pass recording
checks while monitoring capacity still fails. These bounded 13/18-second
recordings, including warmup, do not replace the required sustained test.

Earlier Debug experiments remain historical evidence: initial four-track
44.1 kHz means were 441.7 us serial and approximately 207 us parallel; the
earlier 48 kHz polling run averaged 191.6 us but still missed deadlines.
Those binaries predate the qualified mixed-graph/send-recording fixes and must
not be relabelled as current Release or mixed-graph capacity results.

The required follow-up is zero callback and worker failures, intact recording,
and controlled latency for at least 30 minutes per required four-track/16-sample
configuration in Debug and Release, followed by visible-app, physical-input
and exact-artifact listening checks. Treat eight samples separately. A low
average or p99 cannot waive a missed deadline; clipping needs gain correction
independently of scheduling. The NAM/Settings warnings now surface recent
executor failures even if the outer callback meter is low. Focused frontend
coverage is `audioPerformanceAdvisory.test.ts` plus `audioDeadlineStatus.test.ts`;
all 22 focused cases pass, keeping device xruns, callback overruns and worker
failures distinct. These UI-state tests do not assert real audio capacity.

A future, unimplemented diagnostic could choose one logical processor per
physical core using Microsoft's
[topology query](https://learn.microsoft.com/en-us/windows/desktop/api/sysinfoapi/nf-sysinfoapi-getlogicalprocessorinformationex)
and apply optional worker-only
[ideal-processor hints](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setthreadidealprocessorex),
with unchanged affinity and callback placement. These are advisory preferences,
not reserved cores or proof of SMT separation; first repeat the current
four-track benchmark before introducing another scheduling variable.

## Input and NAM frontend checks

Focused unit suites include `singleKeyTransportShortcuts`, `pianoRollNoteDrag`,
`timelineRulerDrag`, `timelineGroupCopy`, `trackCopyPlanning`,
`atomicShortcutMutations` and `namOctaverFuzz`, alongside shortcut/profile,
preset/Compare and gesture tests. Cover held/repeated Record, text-entry
protection, absolute-zero seek, effective scopes/overrides, exact MIDI axis
constraints, selected-group offsets, atomic Undo/Redo and old-state fuzz-off
defaults. Browser coverage must exercise the real App's
`.workspace-sticky-ruler`; the optional internal Timeline ruler is a different
surface and cannot establish the visible ruler's behavior.

Browser checks use trusted pointer/keyboard events with production components
and store, checking ruler directions/axis locking/cancellation, audio/MIDI copy
previews, track-copy placement, pedal geometry, focus and accessible controls.
Native bridge I/O in browser fixtures is mocked; those results are not audio or
embedded-WebView boot evidence. From `frontend`, run:

```powershell
npm run test:e2e:types
npm run test:e2e -- timeline-controls.spec.ts editor-gesture-regressions.spec.ts
```

The Playwright configuration starts its own Vite server. These migrated suites
use typed helpers in `frontend/e2e/support/`; no standalone browser script or
pre-running server is needed. Public behavior and profile-dependent ruler actions are described in
[input profiles](input-profiles.md#mouse-and-wheel-safety).

Recording zoom coverage is in `recordingWaveformPreview.test.ts` and
`e2e/recording-zoom.spec.ts`. The browser fixture seeds two takes at 556 seconds,
holds the serial preview response, and exercises the visible ruler in both
vertical directions, horizontal range selection, scrolling, automatic-follow
preferences and Stop. Stationary held drags must retain their anchor until
mouseup, pointer cancellation or loss of window focus. Separate synthetic
same-task wheel checks verify zoom-then-pan ordering on the ruler and timeline.
It checks one outstanding peak request, bounded visible
windows, sample-aligned cached waveforms at the current zoom, atomic cursor
anchoring and rejection of stale completions after Stop. Run from `frontend`:

```powershell
npm run test:e2e -- recording-zoom.spec.ts timeline-controls.spec.ts input-profile-wheel.spec.ts
```

The headless runtime safety suite also checks simultaneous preview/status
polling and two-track PCM recording at 8-, 16- and 64-sample blocks. These cases
verify exact file lengths/content, zero polling-induced writer-lock misses,
completed peak boundaries, bounded requests, delayed preview growth and safe
Stop/rollover ownership. Preview maintenance must continue when the timeline is
hidden or polling is suspended. Run with
`tools/run-runtime-safety-regression.ps1 -Configuration Debug -SkipCrashTests`.
These are deterministic `pass`/`fail` contracts, not callback deadline or ASIO
capacity measurements. The original live Audient recording/zoom freeze and
audible continuity remain `not_asserted` until a hardware retest; fixture timing
is `diagnostic_only`. Start/stop writer publication still uses the existing
audio-thread try-lock and is outside the zero-polling-contention guarantee.

## Click-only metronome shortcut

`frontend/src/__tests__/metronomeShortcut.test.ts` checks the dedicated
**Ctrl+Shift+Space** binding in all 19 keyboard profiles on Windows, Linux and
fallback platforms, and **Cmd+Shift+Space** on macOS. It covers exact modifiers,
repeat suppression, project-loading/pending gates, custom overrides/unbinding,
composition ownership and detached-window routing. Executing the action must
leave transport, recording, tracks and metronome Enable unchanged.

With a disposable app Vite browser session, run `playwright-cli run-code
--filename tools/check-metronome-hotkey.js`. The actual App dispatcher and
controls receive trusted keyboard input. Native acceptance is mocked: check
button/hotkey parity, settings open/closed, all profiles, focus, repeat,
remapping, unbinding, pending requests, failure feedback and Command Palette
discovery. These are `pass` UI contracts, not hardware/platform qualification.
Native metronome contracts remain covered by the separate headless suite below;
timing measurements are `diagnostic_only`, and listening quality is `not_asserted`.

## Metronome sounds

The metronome-only native suite uses `OPENSTUDIO_METRONOME_FIXTURES_ONLY=1`
with `OpenStudio.exe --automated-regression-headless --report <path>`. It opens
no audio device or app window. Alongside clock and practice checks, it covers
custom attack alignment at 8/44.1/48/96/192 kHz, anti-phase stereo, DC, silence,
clipping, invalid samples, slow attacks, multiple hits, distinct built-in sounds,
stable prepared-copy recall, source deletion and device-rate changes. Generated
prepared fixtures use the local app-data MetronomeSounds cache.

The real browser modal check is `playwright-cli run-code --filename
tools/check-metronome-sounds.js` after opening the Vite dev page. Native file I/O
is mocked; the actual store, modal and controls verify collapsed defaults,
keyboard expansion, selections, upload cancellation/rejection, cached-copy paths,
and geometry at 390/760/1440 px. Screenshots are saved under `output/playwright`.
Audio timbre, subjective timing and device latency still require audition.

For the cowbell comparison, run `tools/run-metronome-regression.ps1 -SkipBuild
-AuditionDirectory <absolute-output-folder>`. This exports `cowbell-before.wav`,
`cowbell-revised.wav`, and `cowbell-before-then-revised.wav` at 24-bit/48 kHz.
Each version plays two 4/4 bars at 120 BPM; the combined file separates them by
one second. The revised WAV uses actual native callback output. The previous
approximation exists only in the audition fixture. The suite checks bounded
audio, 1 ms attack alignment, same-pitch accent gain and small-buffer parity;
`cowbellTimbre` remains `not_asserted` until the user auditions that artifact.

OpenStudio separates deterministic engineering evidence from listening
judgment. Every result must be reported as:

- `pass` — a deterministic requirement succeeded.
- `fail` — a deterministic requirement failed.
- `diagnostic_only` — useful measurement that is not a release guarantee.
- `not_asserted` — requires a person to audition or inspect the exact build.

## Fast release checks

For metronome small-buffer and click-only clock regressions, run
`tools/run-metronome-regression.ps1 -Configuration Debug -SkipBuild` (and repeat
with `Release` after its build). This dedicated fixture runs before audio-device
creation, produces JSON under `output/review/metronome-*`, and never opens an app
window. Timing measurements are `diagnostic_only`; the user's live two-plugin
ASIO crackling remains `not_asserted`. Behavior and remaining live qualification
are documented in [runtime-hardening.md#metronome-practice-contract](runtime-hardening.md#metronome-practice-contract).

From `frontend/`:

```bash
npm test
npx tsc --noEmit
npm run build
npm run test:e2e
```

For the clip click/drag regression, start `npm run dev` in `frontend/`, then
run these commands from the repository root (requires Node/npm and Chromium):

```powershell
npx --yes --package @playwright/cli playwright-cli -s=clip-pointer open http://127.0.0.1:5183
npx --yes --package @playwright/cli playwright-cli -s=clip-pointer run-code --filename tools/check-timeline-clip-pointer.js
npx --yes --package @playwright/cli playwright-cli -s=clip-pointer close
```

The real Timeline/store fixture checks off-grid audio and MIDI clicks, pointer
jitter, edge clicks, modifier selection, double-clicks, snap modes, moves,
copies, trims, multi-selection, undo/redo, ruler coordinates, outside release,
and cancellation. Backend calls are mocked; audio-device recording and native
WebView behavior require separate app qualification. Stop the dev server after
the check.

For playhead zoom regressions, use the same CLI workflow with
`tools/check-playhead-zoom.js` as the `--filename`. Its real Playhead/React/Konva
fixture checks stopped pointer-anchored zoom up to 1000 pixels per second,
zoom-only visibility changes, viewport edges, resizing, seeks, and transport
updates with follow scrolling. It asserts both Konva geometry/visibility and
the painted canvas pixels, and saves a screenshot under `output/playwright/`.

From the repository root:

```powershell
cmake --build build --config Debug
powershell -ExecutionPolicy Bypass -File tools/run-clean-guitar-headless-regression.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File tools/run-nam-rack-di-headless-regression.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File tools/run-nam-rack-headless-regression.ps1 -SkipBuild
```

The full NAM Rack matrix defaults to a 360-second timeout. It currently takes
about three minutes in a Debug build; use `-TimeoutSeconds` only when a slower
CI runner needs additional margin, not to conceal a hung regression.

Before a release:

```powershell
cmake --build build --config Release
python build.py prod --version 0.1.02
```

The three PowerShell regressions are intentionally headless. They must not open
an OpenStudio window. `tools/nam-rack-visual-harness.mjs` is retained for
targeted browser/layout capture; generated screenshots and reports are ignored.

## Runtime safety and recovery

Detached pitch checks are documented in
[desktop and recording acceptance](#desktop-and-recording-acceptance).
`frontend/e2e/detached-pitch.spec.ts` runs the main owner and detached proxy in
separate pages, including history, docking, canvas/UUID fallbacks and isolation
of a secondary UI failure. Native lifecycle checks additionally require actual
analysis, relative pitch editing, rendered-file publication and Undo with the
main window minimized. Browser mocks do not qualify a native platform backend.

For focused synthetic recording interruption/file-finalization checks, set
`OPENSTUDIO_RECORDING_FIXTURES_ONLY=1` when launching the current executable with
`--automated-regression-headless --report <absolute-json-path>`. Remove that
variable before requesting the broad regression suite. Physical microphone
capture uses `tools/evaluate-recording-qualification.py` with before/after
telemetry and the original PCM WAV; synthetic tests cannot establish microphone
routing, clock drift or listening quality.

`tools/run-runtime-safety-regression.ps1` runs isolated contract, interrupted
recovery, owned-worker, recording-write fault, crash and hang fixtures. Use
`-Configuration Debug`, `Release` or `ASan`; `-SkipBuild` requires a current
binary. It checks child exit codes as well as reports, and never intentionally
crashes an existing app or fills/disconnects the user's disk. ASan is a dedicated
test configuration, not a production performance setting.

Run `tools/run-runtime-capacity-diagnostic.ps1 -Configuration Release` after
other build/test workloads stop. Its isolated 100-track EQ/compressor timings are
`diagnostic_only`, not full recording/mixing certification. Native WebView
readiness and close/reopen behavior use `tools/run-window-lifecycle-smoke.ps1`
  with the desired `-AppPath`; unlike the contract fixtures, it opens test windows.
  It also verifies that successful input/track/master/monitor FX removals close
  their detached built-in editors, failed removals keep them open, shifted slots
  cannot retain stale editors, unrelated editors remain open, and track deletion
  cancels a queued editor reopen.

Frontend recovery/AI behavior lives in `frontend/e2e/runtime-recovery-ui.spec.ts`,
`work-recovery-ui.spec.ts`, `plugin-isolation-ui.spec.ts` and
`ai-workflow-ui.spec.ts`, using explicit mocked bridge boundaries. Native
isolation transport, state, crash/hang, track-host bypass/PDC and retry tests use
`tools/run-isolated-plugin-regression.ps1 -Configuration Debug` (also Release/ASan).
The default is headless. `-ExerciseEditors` explicitly opts into visible native
windows and requires an idle desktop: concurrent clicks/typing invalidate its
foreground-switch assumptions. That focus check was deferred by the user.
`tools/run-render-export-headless-regression.ps1` also checks cancellation and
isolated pass-through render alignment. Neither fake plugins nor mock AI workers
qualify arbitrary third-party plugins or real model generation quality.
Pass `-ExternalPlugin '<catalog identifier or plugin path>'` to explicitly include
an installed vendor's Monitor/Master insertion, chain rebuild and track/input-FX
identity/state round trips. This stays headless and does not open vendor editors
or establish subjective sound quality; the default suite loads no real vendor.
Current evidence and remaining manual/lab gates are in
[Runtime safety and recovery](runtime-hardening.md).

## Frontend visual and interaction QA

Every resizable frontend surface must be checked at its supported compact,
normal, and large widths; at compact and normal heights; and at representative
HiDPI/Windows display scaling. The release gate is behavioral and geometric:

- no horizontal page overflow, accidental host gutter, clipped control, or
  overlapping visual/hit target;
- labels wrap or truncate deliberately, focus remains visible, and accessible
  names and pointer/keyboard targets remain intact;
- browser geometry and screenshot checks cover the rendered result, while
  interaction tests cover scrolling, focus, keyboard use, and control travel;
- `npx tsc --noEmit`, the frontend tests, the Vite production build, and the
  packaged Debug WebView assets all use the same current source.

Exact CSS text is not a visual oracle. Tests may enforce global architecture
rules such as the absence of runtime styles and `!important`, but layout
acceptance must inspect the real rendered surface.

## Audio signal-chain triage

Pitch, playback, and render artifacts must be localized before DSP tuning.

- Live: route resolution -> `PlaybackEngine` read/mix -> `TrackProcessor` ->
  sends/sidechain -> master/monitor FX -> gain/pan/mono -> meters -> device.
- Render: render `PlaybackEngine` snapshot -> `TrackProcessor` -> master FX and
  gain -> writer.

Set `OPENSTUDIO_AUDIO_CHAIN_DEBUG=1` to write a debug packet beside a render,
or set `OPENSTUDIO_AUDIO_CHAIN_DEBUG_DIR` to choose the directory. The packet
contains `render_chain_report.json`, `playback_output.wav`,
`track_post_processing.wav`, `master_pre_fx.wav`, `master_post_fx.wav`, and
`writer_input.wav`. `OPENSTUDIO_AUDIO_CHAIN_DEBUG_MAX_SEC` bounds capture time
and defaults to 12 seconds.

Find the first dirty stage: source/routing/read conversion when playback is
already dirty; processor state, bypass, default EQ/gain, and denormals when the
track/master stage first changes; alignment, format conversion, dither, block,
and tail handling when only writer input/output is dirty; callback deadlines,
resizes, lock misses, IPC/timer pressure, and preview cleanup when only live
playback is dirty. A clean render rules out WebView IPC and live-device
underruns as the render artifact's cause. Do not close a noise issue until the
first dirty stage is identified, deterministic checks pass, and the exact
artifact is auditioned.

## Reference-comparison capture protocol

Use the same 10-15 second dry DI for both systems, including sustained chords,
single notes, palm-muted transients, decay, and silence. Record the exact preset
and controls, sample rate, buffer, input peak, output loudness, and mono/stereo
route. Capture wet-only output where possible and loudness-match with LUFS/RMS
before judging tone. Test a real `L = guitar, R = silence` route separately
from duplicated stereo input so lane faults cannot hide.

Reference files are QA oracles only and production must never read or depend on
them. Change one audible issue per iteration. Spectral and level measurements
remain `diagnostic_only`; perceived similarity and transition quality remain
`not_asserted` until a person approves the exact artifacts.

## What automation may prove

- A1/A2 fixture loading and invalid-model rejection.
- Finite, bounded processing and expected relative pitch requests.
- Prepared model/IR swaps and stale-request rejection.
- Sample-rate conversion and callback-partition invariance.
- Fixed reported latency and dry-path alignment.
- Project, preset, A/B, order, calibration, and automation identity round trips.
- Preview Use/Cancel rollback.
- Multi-capture pack collapse/hydration, exact child identity (including
  URL-only/model-ID-zero cases), selection without publication, preview
  supersession, Use, replace, bypass, and unload state transitions.
- Missing-asset recovery and durable download identity.
- TONE3000 session-state transitions with deterministic mocks.
- Output-file creation and explicit render-route state.

CPU percentages, spectra, formant estimates, and fixture-specific deadline
measurements are `diagnostic_only`.

## Guitar/Bass instrument-profile release matrix

The automated gate must cover all of the following before merging:

1. Missing, legacy, out-of-range, NaN, and infinite profile state canonicalizes
   to Guitar; a valid Bass value survives project, user-preset, import/export,
   and Compare A/B round trips. The instrument selector is intentionally not a
   user-automatable parameter; separate DSP stress tests exercise live profile
   switches across callback boundaries.
2. Switching Guitar -> Bass -> Guitar does not change any stored visible value,
   model/capture path, cabinet IR path, calibration value, or explicit cutoff.
3. EQ Boost centres/labels, Octaver tracking, both nonlinear pedals, Amp wrapper
   and tone stack, Graphic EQ low band, modulation direct path, Delay repeat
   filtering, and non-legacy Reverb low decay exercise their intended profile
   mapping with finite bounded output.
4. The live switch is deterministic across fixed and uneven callback partitions,
   remains bounded at the exact transition samples, and latches one coherent
   profile for a complete audio callback during concurrent UI publication.
   Octaver coverage spans 44.1, 48, and 96 kHz.
5. Catalog and installed-library views filter only explicitly incompatible
   metadata, keep untagged/shared captures, and pin an already-active opposite-
   tagged capture without unloading or replacing it.
6. Changing away from an instrument-specific factory template clears only the
   stale template identity/baseline. Shared templates and user presets retain
   their normal dirty-state behavior.

The final musician audition uses clean Guitar and five-string Bass DI fixtures.
For each instrument, enable one stage at a time, then the complete chain; toggle
the profile during sustained notes, palm mutes, silence, modulation, Delay and
Reverb tails; load/change/remove, bypass/re-enable, and replace captures and IRs;
save and recall multiple presets; restart the app; and repeat at small and normal
device buffers. Record
the rack output while switching and inspect/listen for clicks, dropouts, stale
audio, DC steps, unexpected repeat/tail resurrection, and noise-floor changes.
Those listening outcomes remain `not_asserted` until a person approves the exact
release artifact.

## What automation may not prove

The following remain `not_asserted` until the user auditions the exact artifact:

- naturalness, realism, commercial-product sonic parity, or "better tone";
- pick response, palm-muted tightness, chord separation, sustain, or noise feel;
- click-free perception during power/model/cabinet changes;
- tuner feel on a real decaying guitar;
- chorus width, mono compatibility, delay feel, reverb density, or shimmer
  musicality;
- absence of real-device crackle across interfaces and drivers.

## TONE3000 first-user acceptance

`tools/tone-library-layout-browser-regression.js`, also run by
`frontend/e2e/ui-audit-regressions.spec.ts`, checks compact capture feedback after
keyboard collapse and after collapse/request completion in the same browser
task. Native `<details>` owns its open state; asynchronous capture feedback must
reveal the panel without a deferred toggle event hiding it again. The same
fixture retains responsive geometry, keyboard access and same-pack reopening
checks. Its catalog and account responses are mocked.

Run this with a clean OS user or after removing only OpenStudio's saved
TONE3000 session:

1. Install the release candidate and open the NAM Rack.
2. Select Connect TONE3000.
3. Confirm the default browser opens the official TONE3000 page.
4. Create a new account or sign in as a first-time OpenStudio user.
5. Confirm the browser success page returns control to the app without copying
   a token or entering developer settings.
6. Search separately for A1 and A2; confirm combined results are bounded,
   paginated, attributed, and responsive to rate limits.
7. Open a tone pack that declares multiple captures. Confirm the pack appears
   once, its count is correct, and **View Captures** exposes every hydrated
   child with its architecture and RAW/CAB-embedded topology.
8. Select child A and confirm selection alone leaves the current audible model
   unchanged. Audition A, switch directly to audition child B, then Stop and
   confirm the complete pre-preview baseline returns.
9. Audition child A again and choose **Use**. Confirm the nameplate, exact child
   identity, source attribution, amp/cab topology, and saved metadata all refer
   to A rather than the pack sentinel or first child by accident.
10. Reopen the picker and Use child B to replace A. If B embeds a cabinet,
    confirm the external Cab is bypassed without deleting its prior IR; return
    to an amp-only child and confirm the normal Cab workflow resumes.
11. Bypass and re-enable the Amp slot without losing B, then Unload and confirm
    the slot is empty. Reload B, save the project/tone, restart OpenStudio, and
    confirm the exact child and enabled state restore.
12. Start another preview and Cancel it; confirm the restored state includes
    capture, Cab, power, and mix values. Repeat while a prior request is still
    preparing and confirm a stale completion cannot overwrite the newer choice.
13. Install one permitted cabinet IR and confirm it becomes audible only where
    the selected capture needs an external cabinet.
14. Force or wait for token refresh and repeat a search/download.
15. Delete one downloaded child asset, reopen the project, and verify Locate,
    Replace, Bypass, and supported Re-download recovery without disabling the
    rest of the rack.

The deterministic frontend/unit suite separately covers pack-sentinel/model-ID-zero
and URL-only child identities when the live catalog does not expose such a
record during the acceptance run.

Record the app version, OS, account state, model/IR IDs, result for each step,
and screenshots of any failure. Do not include tokens or the publishable key in
the report.

## Manual audio matrix

Use clean Guitar and five-string Bass DIs, the user's normal interface, and at
least one A1 and one A2 capture:

- 44.1, 48, and 96 kHz where the device supports them;
- 32, 64, 128, 256, and 512-sample buffers where stable;
- mono and stereo track paths;
- amp-only capture plus IR and full-rig capture with external Cab bypassed;
- each native pedal alone and representative combinations;
- selection-only, audition/stop, audition-to-audition, Use, model replacement,
  cabinet, preset, A/B, bypass/re-enable, unload, and missing-asset transitions;
- live playback and offline render of the same phrase.

Report objective invariants separately from the user's listening verdict.

## Optional AI-generation acceptance

When ACE-Step or Stable Audio generation changes, manually exercise ACE prompt
and lyrics generation plus variation, inpaint, and continuation; then exercise
Stable Audio setup/license acknowledgement, prompt generation, variation,
inpaint, and continuation with a valid local snapshot. Generated WAVs must
import at the intended positions, play, persist through save/reopen, and undo
as one user action. A missing optional model/runtime must not block base-app
startup.

## Menus, FX feedback and input integration

The repeatable real-component browser checks are
`tools/fx-menu-browser-regression.js`, `tools/field-test-browser-regression.js`
and `tools/input-profile-browser-regression.js`. Use disposable browser sessions.
Check nested template menus, multi-clip Copy/Delete/Undo, keyboard submenu access,
small-window bounds, loading feedback and stale asynchronous completions. A
source inventory of menu handlers does not prove every native command works.

Media Pool, LUFS, Phase Correlation and Free Item Positioning menu entries remain
unavailable until their implementations exist. Monitor FX picker dismissal must
work outside the picker, on blur, with Close Dialog, with the close button and
with a second + click; late insertion must not steal focus after dismissal.

For metronome practice, use `tools/run-metronome-regression.ps1`. Check fractional
BPM, meter changes, 8..512 and irregular blocks, gain ramps, rapid restart and
transport takeover. Practice alone must leave the playhead and recording state
unchanged. Timing is diagnostic only: passing generator tests does not prove that
an arbitrary low-buffer ASIO session or third-party plugin chain is crackle-free.
See [the runtime contract](runtime-hardening.md#metronome-practice-contract).


## Free-plugin processing and editor checks

The [plugin maintenance guide](free-plugins.md) records supported behavior, compatibility rules, reference sources and open calibration work. Build the current frontend and Debug binary before running:

```powershell
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1
# A focused group does not count as a full-suite run:
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName original-colour
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName guitar-performance
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName automation-registry
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName mute-point-timing
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName send-automation
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName fallback-automation
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName jsfx-automation
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName clap-automation
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -CaseName stage-automation
```

For installed-vendor coverage, set `OPENSTUDIO_FX_REGRESSION_PLUGIN` to an absolute
VST3 path, run the focused `vendor-automation` case, then remove the variable.
The current AmpliTube 5 check covers its exposed slots, not assignments for every
internal amp/pedal control.

`tools/fx-chain-drag-browser-regression.js` and
`tools/free-plugin-automation-browser-regression.js` run through playwright-cli
`run-code --filename` on a disposable Vite browser session. The latter requires
the `editor-schemas` export saved as
`output/review/fx-automation/native-editor-schemas-current.json`, temporarily served
on port 5191. The editor runner also checks all dedicated editor hosts at 640, 820, 1040 and
1440 pixels for horizontal overflow and visible keyboard focus.
Both use fixture bridge data with production components/store;
they are not DSP evidence. `tools/native-plugin-automation-browser-regression.js`
instead runs on an open built-in editor in the task-owned native WebView2 CDP
session, with the main page's `nativeAutomationQA` binding to its actual
`useDAWStore` and `nativeBridge`. Use a project copy, disarm recording and mute live
output. It asserts held/released Touch and normalized points, not sound quality.
See [automation and plugin state](automation-host-review.md#qualification-limits)
for current contracts and unresolved native qualification. Frontend tests must
delay bridge responses across project replacement, newer transport requests and
concurrent send gestures. Include rejected routing, lane restoration and Undo/Redo
in `sendAutomation`, `pluginOutputRouting`, `stageFXAutomation` and
`transportUpdateOrdering`; a passing UI fixture does not clear a native audio
failure.

The runner opens neither an app window nor an audio device. `Source/FreePluginRegression.cpp` registers the current cases; do not keep an obsolete group count as an execution contract. Missing legacy fixtures fail closed. The source-owned `.state` files under `tests/fixtures/free-plugins/legacy/` are compatibility inputs, not disposable generated artifacts.

### Standalone Reverb qualification

The [maintenance guide](free-plugins.md#standalone-reverb-state-and-processing)
owns implementation and compatibility decisions; the manual owns controls.
The native runner is headless. Use Debug for callback heap instrumentation and
optimized Release for long captures/timing. A selected group is not a full-suite
run, and finite output is not a sound-quality verdict.

| Cases | Contract or diagnostic scope |
| --- | --- |
| `reverb-output`, `reverb-retirement`, `reverb-factory` | Final gain, bounded tank suspension, complete factory state/response and historical preset identity. Host/export tests additionally cover portable state, disk-preset priority, recall, Mix Lock and mutation guards. |
| `reverb-corrected-controls`, `reverb-return-level`, `reverb-return-ir-crossfade` | All 41 dedicated Wet/Dry ramps, interrupted edits, auxiliary IR outputs, Spatial extremes, append-only compatibility, all fixed wet gains and independent 50 ms kernel-fade reference. Debug measures callback allocations/frees. |
| `reverb-compatibility-sleep`, `reverb-settled-taps`, `reverb-sparse-diffusion`, `reverb-refinement-state` | Masked-engine suspension, Original/Refined reads, feedforward diffusion, four rates, irregular blocks, live changes and old-state migration. |
| `reverb-voice-options`, `reverb-shimmer-scheduling`, `reverb-shimmer-performance` | Old/invalid scheduling/body defaults, Vowel linearity, prior-adapter/reset parity, warmup/cancellation, stale-return exclusion and combined route/pitch/engine/Hold automation. |
| `reverb-extended`, `reverb-extended-heap` | Opt-in maximum finite tails and long Hold/release streams; separate bounded Debug heap probe. The long Release matrix can take about an hour. |
| `reverb-extended-nonlinear-tail`, `reverb-extended-hold-headroom` | Opt-in eight-envelope finite-tail bounds and explicit Infinite/Freeze/Return/Output headroom diagnostics; internal saturation is not instrumented. |
| `reverb-shimmer-instances`, `reverb-instances` | Release-only callback timing diagnostics. Finite output and deadline misses are reported separately; neither proves device dropout behavior. |

For Shimmer timing, task-local `OPENSTUDIO_SHIMMER_BENCH_RATE` and
`OPENSTUDIO_SHIMMER_BENCH_BLOCK` select rate/buffer;
`OPENSTUDIO_SHIMMER_BENCH_SPREAD_ONLY=1` selects 18 steady Spread cases without
transition/preparation profiling. Each Release case records 2,048 observations
after warmup. Set variables only in the child test process and stop other builds,
renders, browser tests and benchmarks before capture. Aggregate a retained
four-rate/two-buffer matrix with `python tools/analyze_shimmer_performance.py`.

#### Reproducible response and listening exports

Generated reports/audio belong under ignored `output/`; reference audio is
never a production dependency. Local recorded fixtures, the user's saved guitar
project and historical before-renders are optional QA prerequisites, not assets
available in a clean checkout. Do not silently substitute another source.

```powershell
# Original-return impulse responses; use reverb-audit-calibrated for new trims.
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -AppPath build/OpenStudio_artefacts/Release/OpenStudio.exe -CaseName reverb-audit -ReportPath output/reverb-audit/all-modes-release.json
python tools/analyze_reverb_audit.py --report output/reverb-audit/all-modes-release.json --output-dir output/reverb-audit/analysis
python tools/analyze_reverb_audit.py --self-test

# Long band-decay and control/route response diagnostics.
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -AppPath build/OpenStudio_artefacts/Release/OpenStudio.exe -CaseName reverb-correction-responses -ReportPath output/reverb-correction/long-responses.json
python tools/analyze_reverb_corrections.py --report output/reverb-correction/long-responses.json

# Native mixed levels on three generated materials.
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -AppPath build/OpenStudio_artefacts/Release/OpenStudio.exe -CaseName reverb-balance -ReportPath output/reverb-balance/native-release.json
python tools/prepare_reverb_balance.py --result output/reverb-balance/native-release.json --output output/reverb-balance

# All authored voices on three generated and four local recorded materials.
python tools/prepare_reverb_recorded_fixtures.py
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -AppPath build/OpenStudio_artefacts/Release/OpenStudio.exe -CaseName reverb-voiced-balance -ReportPath output/reverb-voiced-balance/native-release.json
python tools/prepare_reverb_voiced_balance.py --result output/reverb-voiced-balance/native-release.json --output output/reverb-voiced-balance

# Existing local single-track project through its saved NAM chain and Reverb.
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -AppPath build/OpenStudio_artefacts/Release/OpenStudio.exe -CaseName reverb-shared-guitar-project -ReportPath output/reverb-shared-guitar-project/native-release.json
python tools/prepare_reverb_shared_guitar_project.py --report output/reverb-shared-guitar-project/native-release.json --output output/reverb-shared-guitar-project

# Explicitly RMS-matched wet-only character comparison, separate from mix levels.
powershell -NoProfile -File tools/run-free-plugin-headless-regression.ps1 -AppPath build/OpenStudio_artefacts/Release/OpenStudio.exe -CaseName reverb-listening -ReportPath output/reverb-listening/export.json
python tools/prepare_reverb_listening.py --report output/reverb-listening/export.json
```

Open each generated `index.html` for comparison. Balance players preserve native
WAV bytes/levels and exclusive playback. The voiced pack has **287 combinations
and 1,722 mixed WAVs**: 41 voices × seven materials × six variants (Wet0,
Original-return100 and Calibrated25/50/75/100), plus source files. Recorded guitar
phrases are arrangements of CC0 DI notes; the short bundled JUCE singing sample
has unverified performer/capture-chain and binary-recording credits and remains
local QA only. Neither establishes broad vocal or live-performance suitability.
The common 0.5 input gain and fixture-preparation gains are explicit provenance,
not output matching. Ten-second captures can truncate long tails.

The shared-project case requires `test projects/test guitar 1.osproj` and its
referenced recording/NAM model, with the audited single-track routing. Actual
PlaybackEngine/TrackProcessor process saved mono input routing and complete NAM
state; Reverb consumes the same cached native signal before final upstream
latency compensation. NAM's own reverb must be disabled. Source gain is one,
the two-bar quiet lead-in stays, and the fixed ten-second listening tail may
truncate long decays. This does not test the complete AudioEngine/device graph.
The player derives project/source hashes and timing from the native report and
source-timeline capture, without requiring a pre-existing provenance sidecar. It applies one labelled
monitor trim across current/optional `--before-pack` comparisons; WAVs are unchanged.
Wet residuals subtract each voice's own Wet-zero capture because Plate colour
and Positioned room's direct path can remain active there.

`OPENSTUDIO_REVERB_QA_OUTPUT` overrides the shared-project/voiced capture root;
`OPENSTUDIO_REVERB_QA_PROFILE_OUTPUT=1` retains authored Output trims instead
of diagnostic Output0. Shared-project `OPENSTUDIO_REVERB_QA_TYPE` selects a
single-type pilot (the full comparison requires all 41). Set these only in the
child process. `OPENSTUDIO_REVERB_QA_TRANSITIONS_ONLY=1` limits the long-response
matrix to five Hold/release/route/Spillover cases. Leave it unset for all 95.

Analysis requires NumPy/SoundFile, with SciPy for bandwise decay and guitar
spectra. `analyze_reverb_audit.py` provides independently checked energy,
arrival, band and pairwise descriptors. `analyze_reverb_corrections.py` fits
Schroeder -5..-25 dB energy decay after causal octave-band filtering;
`analyze_reverb_shared_guitar.py` and `analyze_reverb_voiced_balance.py` add
source-specific descriptors. Short capture quantiles are not RT60. Nonduplicate
hashes, RMS ratios, spectral distances and waveform correlations are
`diagnostic_only`, never perceived-distinctness or audibility gates.
The wet-only character player deliberately uses shared peak-safe whole-file
RMS targets per material; it cannot establish native mix balance or equal
perceived loudness.

### Other free-plugin signal qualification

The [Signal path contract](free-plugins.md#corrected-signal-paths) covers the
15 standalone non-Reverb processors. Use `audit-other-baseline`,
`dynamics-audit`, `audit-eq-phase-pitch`, `instrument-audit` and
`audit-modulation` for matrix/behavioral coverage; `audit-other-heap` requires
Windows Debug and instruments first-use and alternate-filter morph callbacks.
The `signal-repairs` group aggregates the six deterministic repair gates and is
included in the ordinary native suite. Windows Release CI also explicitly runs
`signal-repairs`, `reverb-shimmer-scheduling` and `reverb-voice-options`.
Individual repair gates are `signal-compatibility`, `signal-poles-midi`,
`signal-pitch-range`, `signal-transitions`, `signal-drum-release` and
`signal-pitch-fft-parity`. Inspect behavioral rows rather than treating capture
success as a sound-quality pass. `signal-pitch-performance` is a Release timing
diagnostic with explicit overrun counts.

The native host/export suite additionally checks old numeric snapshots,
full-state/factory recall for all nine Signal path processors and terminal drum
CC123 with automated maximum decay. Preserve frozen Legacy compatibility
fixtures; old failures under `output/free-plugin-repairs/audit-before` are
historical evidence, not the current expected verdict.

Opt-in `audit-shared-guitar` reuses the previously audited NAM-only source;
it does not capture a fresh AudioEngine/device route. Set child-process
`OPENSTUDIO_SIGNAL_AUDIT_OUTPUT` for another capture root and
`OPENSTUDIO_SIGNAL_AUDIT_LEGACY=1` for Legacy comparisons.
`analyze_free_plugin_audit.py --root <checkout> --directory <capture-root>
--baseline-report <shared-guitar-native-report.json>` checks provenance
and reports active-window guitar/modulation diagnostics. Its baseline defaults
to `<checkout>/output/reverb-shared-guitar-project/native-release.json`.
`analyze_free_plugin_repairs.py --root <repair-pack>` qualifies complete archived Legacy parity,
intended Piano/Guitar partial frequencies, velocity ordering, partitioning and
state/audio recall. Its optional `--baseline`, `--legacy`, `--corrected` and
`--output` arguments override individual paths; the default repair-pack root is
`output/free-plugin-repairs`. These analyzers require the declared source/archive packs;
missing coverage must fail rather than silently disappear.

### Design 03 production integration, 22 October 2026

The dedicated editors for all sixteen non-NAM processors, including Reverb's
Convolution view, now use the implemented Design 03 layouts. Shared Find opens
the owning control or workflow without changing processing modes; inactive
results explain applicability. Exact entry, fine adjustment, reset, Escape,
paired native gestures, complete-state A/B and Undo remain on the production
bridge/history path. Compact pages and wide overviews share parameter identity.
The manual and maintenance guide retain the feature map and operating contract.

The local, offline screenshot gallery is
`output/review/fx-design03-production/index.html`. Its 172 captures comprise
seventeen views at nine viewport/DPR profiles plus Chorus at 940x520 and Delay
at 1040x620, plus seventeen extra captures at 624x440 to conservatively allow
for native window chrome. Profiles cover 640x480, 1040x680, 1366x768, 1920x1080,
2560x1440 and 3840x2160, plus 4K equivalents at 125%, 150% and 200% scaling.
These are browser client dimensions; native window bounds include title bars
and frames. Contact sheets and representative full captures were visually
reviewed. All 153 matrix rows have zero measured horizontal-control or
knob-envelope violations. The extra 624x440 set also has no horizontal-control
overflow; dense sections remain scrollable. Detailed pages may scroll; this is not a claim that
every state fits vertically, nor evidence of OS-level or mixed-monitor DPI.

| Final integration check | Result and scope |
| --- | --- |
| Frontend production build and types | `pass`: `npm run build` and `npm run test:e2e:types`. Dependency notices cover 38 production packages. Vite still reports large chunks and ineffective dynamic imports of already statically imported modules; these are retained packaging/performance follow-ups, not TypeScript errors. |
| Frontend regression suite | `pass`: 2,929 tests in 248 files. The dependency refresh is limited to Vite 8.1.6 and Vitest 4.1.12, with Node types for the browser harness; `npm audit` reports zero vulnerabilities. |
| Production editor browser tests | `pass`: all 23 tests in the three `free-suite-*` specs. They exercise responsive geometry, parameter/history gestures, A/B copy, inactive-value retention, Find including portalled controls, precision tools and instrument navigation. Final edge cases cover disabling captured drags/focused drafts and preserving untouched numeric precision or external updates. The bridge records calls and does not process audio. |
| Reverb page navigation | `pass`: 292 page visits across all 41 machines at 640x480, with no page errors, horizontal-control overflow or parameter writes caused by navigation. This is page/layout coverage, not a full parameter-interaction or audio sweep. |
| Qualification tooling | `pass`: 37 Python tests and 57 subtests; one platform-specific test skipped. The run covers desktop/Linux qualification, Reverb QA tooling and NAM fuzz refinement tooling. |
| Final Debug and Release builds | `pass`: both CMake builds completed with zero compiler warnings. All 146 files in `frontend/dist` match both copied `webui` trees byte for byte; all 437 inspected native source files predate both binaries. |
| Final Release Reverb headroom | `pass`: all 16 bounded continuing-input fixtures, zero final guard hits and exact callback-partition parity. Indefinite accumulation and audible behavior remain `not_asserted`. |
| Final packaged Release lifecycle | `pass`: 99 checks, with all ten frontend documents reaching boot-ready and the Pitch-inclusive geometry contract passing. This normal-mode Windows 11 run proves explicit offline startup, no opened device, zero starts/callbacks and owned-process cleanup. It does not repeat the affected Windows 10 Repair scenario. |

Final Release SHA-256:
`cd32fe8ed3ef9329fbd8c8ad21b5da7935ca235efbdfa486da3116c0df0bc52e`.
The shared packaged frontend index hash is
`253f2fe44251f42316cdb5e7bd6b1ae5b5b2759ba7cff50f46848aee11b188a3`.
Final native provenance, headroom and lifecycle reports are under
`output/review/fx-design03-final-native-20261022/`. The fresh native editor
schemas match those used by the browser captures exactly. Earlier CPU,
184-check native-suite and 264-check export results retain the distinct measured
binary hashes in the implementation subsections below; do not relabel them as
measurements of this final build.

**Remaining acceptance:** multi-instance Shimmer and the most demanding Pitch
profiles still fail their strict zero-overrun targets, as quantified below.
Their timing improvements are `diagnostic_only`; hardware dropout behavior,
ASIO 8/16-frame use, commercial equivalence and subjective sound quality remain
`not_asserted`. Real MIDI/analysis/IR jobs are not established by mocked editor
tests. Windows 10 repair, native Linux/macOS and actual mixed-DPI behavior retain
their separate acceptance gates. Build warnings, these measured failures and
the unrun gates remain visible rather than being counted as completed work.

### Design 03 browser proposal, 22 October 2026

The superseded interactive proposal and its exact feature/geometry results remain
under ignored `output/fx-design-review/studio-v3/` (`index.html`,
`gallery.html` and adjacent scripts/results). It covered 136 default captures,
2,505 native descriptors,49 IR fields,174 workflows and 2,378 pure Reverb layout
scenarios. Its simulated controls, zero measured default overflow and fixture
interactions are **not production, native-audio or visual-approval evidence**.
Use the production integration results above and the
[maintenance gates](free-plugins.md#editor-maintenance-and-qualification)
for current editor changes; do not maintain a second prototype parameter state.

### Design 03 pre-implementation free-suite audit, 22 October 2026

This **historical baseline** is retained under
`output/review/fx-design03-dsp-20261022/`: `provenance.json`,
`qualification-summary.json`, `focused-runs.json`, `benchmark-runs.json`
and 143 rows in `timings.csv`. Release SHA-256:
`001ac638e789a2193526604e03b556449f43edf770b660d1655c6a7c2b6fa8fd`;
Debug: `bd45b6cad0503cf3941900a6870c3d92ad7a7096034151cf6fc67a2452133022`.
Subsequent [Reverb](#design-03-reverb-implementation-qualification-22-october-2026)
and [Pitch/Synth](#design-03-pitchsynth-implementation-qualification-22-october-2026)
results supersede only their named contracts, not every device or listening gate.

The baseline passed 181 ordinary native groups, focused dynamics/EQ/phase/Pitch,
24 Chorus tails, eight instrument variants and state/audio partition checks.
Debug measured zero callback CRT allocations/frees in 30 non-Reverb and 208
prepared Reverb cases; other allocators, setters and untested transitions were
excluded. Shimmer passed 103 scheduling,40 parity and 73 voice-option cases.
Exact assertion counts and captured WAVs remain in the indexed reports.

| Baseline capacity/headroom finding | Recorded result; later results are separate |
| --- | --- |
| Continuing-input calibrated Nonlinear Infinite,48 kHz stereo | **Headroom fail:** reaches the +/-4 final guard at 3.677229 s with 1,239,250 guarded sample positions. Freeze and Output-30 dB avoid that final guard; internal saturation/indefinite stability were not asserted. Later 16 bounded headroom fixtures pass. |
| Factory profiles and heavy-mode session | All 32 active/idle factory and 21 heavy profiles had zero observed misses. The eight-processor 48 kHz/128 session p 95/max were 587.4/904.6 us versus 2,666.7 us. This does not qualify all machines or maximum polyphony. |
| Corrected Pitch, four instances,192 kHz | **59/2/1 misses** at 32/64/128 frames; max 248.2/378.5/1,054.3 us against 166.7/333.3/666.7 us. Other tested Corrected profiles had zero; Legacy separately recorded 2,909 misses. |
| Shimmer 48 kHz/128,1/4/8 copies | Spread **0/0/39 misses**, Original **0/753/1,092**. Spread-eight worst p 95/max 2,143.3/3,770.8 us exceeds the 2,666.7 us budget. |
| Spread 192 kHz/64,1/4/8 copies | **0/5,089/10,970 misses**; worst p 95/max 170.5/262.4,853.3/1,249.5 and 1,544.6/2,380.2 us against 333.3 us. |
| Original↔Spread,192 kHz/128,one copy | **7/8 misses**, maxima 7,380.7/7,358.1 us against 666.7 us. Lower steady Spread cost does not qualify switching. |

Timing used quiet warmed in-process runs on Ryzen 9 7900 X, not hardware callbacks.
`overallPass` covered finite/state contracts; any deadline miss still fails the
workload's strict capacity target. Two old stress labels overstated coverage:
“Room to Shimmer” actually chose Spring (4), and 32 single-channel note-ons used
only 16 Synth slots. The corrected tests select Shimmer (5) and assert 32 rendering
voices across two channels; old rows cannot serve as those benchmarks.
Articulated Drums also intentionally ignores Legacy Kit/Tightness controls;
the editor now explains that while preserving their saved values.

The baseline render entry opened hardware before its test branch, so host/export
was deliberately not run. The corrected explicit-offline entry subsequently
passed 264 checks with zero device/start/callback witnesses. No baseline claim
covers ASIO 8/16, other CPUs/platforms, exhaustive controls or subjective sound.

**Effect-law coverage beyond finite extrema remains a maintenance gate:**

| Family | Meaningful checks retained | Still not established |
| --- | --- | --- |
| EQ/GEQ | Response/slopes, stereo/M-S, phase latency, dynamics/spectral/bank routes, amplitude homogeneity | Wider frequency/Q/gain/automation grids and audible ringing/usefulness |
| Gain Phase | Known delay/allpass/FIR offsets, confidence and declared tails | Real multitrack coherence and audible improvement |
| Compressor/Gate | Clean RMS curves, ratios 1/2/5 at four rates, knee/range/timing, detector listen and partition behavior | Full timing interactions, transient/chatter audition, commercial equivalence |
| Limiter | Independent reconstructed peaks, four rates/styles/oversampling, linking/release and synthetic loudness gates | Broadband/transient breadth, standards vectors and distortion/pumping audition |
| Preamp/Saturator | Unity/bypass, stepped response, headroom/DC/stereo, antiphase/topology transitions | Drive/bias maps, broadband alias/IMD and level-matched listening |
| Reverb/Convolution | IR matrix/state, timing/control/Hold/spillover and retained long responses | Every voice/control interaction, calibrated decay, indefinite accumulation and universal headroom |
| Delay/Chorus | Multi/Dual tap timing, tempo/voices/modes, phaser/ensemble and tails | Continuous feedback/motion/filter maps and audible parameter influence |
| Pitch Correct | Scale/Custom mapping, synthetic detection/response, sustained timing and latency | Voiced/unvoiced transitions, sibilance, attacks and naturalness on approved sources |
| Instruments | Oscillator/MIDI/articulation/pedal/choke, partials, velocity, state/partition and actual Synth 32-voice tests | Wider register/velocity/control grids, all maximum-polyphony envelopes and realism audition |

Reference behavior stays in [the maintenance guide](free-plugins.md#research-sources-and-decisions).
The manufacturer-linked [Pro-G tutorial](https://www.youtube.com/watch?v=ZtV3s6i-p4Y),
[Pro-L 2 tutorial](https://www.youtube.com/watch?v=oMJeWXtJODc) and
[BigSky Infinite/Freeze demonstration](https://www.youtube.com/watch?v=Qv9QWoHCFhQ)
provide audition context; only available descriptions and manufacturer documents
were inspected, not video audio/transcripts. Infinite must admit new excitation,
unlike Freeze: muting new input to avoid overload changes the function.

Reproduce with `tools/run-free-plugin-headless-regression.ps1`, selecting the
indexed case/report pair; omit `-CaseName` for the default suite. Timing groups
are `performance`, `performance-stress`, `signal-pitch-performance` and
`reverb-shimmer-instances`, using the documented child-only rate/block/Spread
variables and no competing builds/browser work. `OPENSTUDIO_SIGNAL_AUDIT_OUTPUT`
controls focused WAV exports. Scalar extrema tests never certify the entire
continuous parameter space or an audible commercial reference match.

### Design 03 Reverb implementation qualification, 22 October 2026

The subsequent implementation adds linked smooth write/readout budgets only to
continuing-input Infinite in Nonlinear, dispersive Spring and Rising. Freeze
and finite modes bypass those budgets. Shimmer retains the same spectral
window/hop and return delay: Spread divides each 64-sample group into eight-sample
work quanta while preserving its original ratio and silence decision; inactive
bank clearing is incremental before priming, warmup and crossfade. Clear skips
coefficient rebuilds when its sanitized settings and active state are unchanged.
No parameter IDs, serialized fields or declared latency changed.

Focused Windows Debug evidence is retained under
`output/review/fx-design03-reverb-implementation-20261022/`.
The second Debug executable SHA-256 is
`8a38059e527846023c0a863332c6bd3ce95d4f591fa66c43a0d0e5dd5da97611`.
Release SHA-256 is
`71b4cb485b4afbed4e891f7994abcd54e6b5ce2041fe7b12c1d4fd5213099a56`.

| Deterministic contract | Result |
| --- | --- |
| Shimmer signal/lifecycle | `pass`: 44 cases at 44.1/48/96/192 kHz, including exact previous-adapter parity after long silence, exact Original/Spread populated-history reset parity and interrupted route wakeup. Measured callback CRT allocations/frees: zero. |
| Shimmer scheduling | `pass`: 107 state, four-rate mono/stereo, partition, reset, interrupted-transition and dry-unity cases; zero measured callback CRT allocations/frees. |
| Hold input policy | `pass`: 25 cases including Nonlinear at four rates; Infinite accepts new input, Freeze rejects it, and finite release and stored identity remain intact. |
| Bounded Reverb heap/partition | `pass`: 208 prepared family/core/rate/channel Hold/release cases; exact zero partition error and zero callback CRT allocations/frees. Long hold stability is not asserted by this short probe. |
| Clear configuration cache | `pass`: response/partition tests plus unchanged-setting, change, retirement, reactivation and reset invalidation checks in the first Debug build. |
| Continuing-input Infinite headroom | `pass` in Release: all 16 x 73-second regular/irregular Spring/Nonlinear/Rising fixtures, including live Return changes. Zero final safety-clamp hits, measured reservoir writes below their guards, exact partition/state parity, and finite release. Previously failing calibrated Nonlinear Infinite now peaks at 0.75552; worst fixture peak is 0.97177 during a live Nonlinear Return change. Other internal states and indefinite accumulation remain `not_asserted`. |

The initial eight-sample adapter failed the long-silence parity oracle; its
retained `shimmer-parity-debug.json` is a rejected intermediate result. The
corrected grouped adapter passes with exact zero error in
`shimmer-parity-debug-v2.json`. No tolerance was relaxed. Later timing-harness
changes extend live-switch observations through the actual reset, prime, warmup
and fade plus a settled margin and assert the final target bank is settled;
they do not change production DSP. Subsequent source edits format the new budget
helper without changing arithmetic or processing order, remove unread telemetry,
and update Pitch editor window geometry. The hashes above identify the actual
measured binaries, not the final working-tree executable after those edits.
Hardware dropouts and audible quality remain `not_asserted`.

Fresh Release timings ran serially on the same Ryzen 9 7900X with browser
capture/test processes and dev servers stopped. Each steady row has 2,048
observations; there are six routing/input rows per mode and instance count.
The CPU values are `diagnostic_only`; zero-overrun verdicts apply only to these
measured workloads, not hardware-device safety.

| Workload | Current measured result |
| --- | --- |
| Spread, 48 kHz / 128 frames, 1 / 4 / 8 synchronized copies | Deadline misses **0 / 0 / 11**. Worst p95: 219 / 926 / 1,866 us; worst max: 547 / 1,418 / 3,110 us; budget 2,667 us. Eight-copy zero-overrun target remains `fail`; prior run had 39 misses, p95/max 2,143/3,771 us. |
| Original, 48 kHz / 128 frames, 1 / 4 / 8 copies | Misses **0 / 728 / 1,092**. The compatibility path retains its monolithic FFT work; four/eight-copy zero-overrun targets remain `fail`. |
| Spread, 192 kHz / 64 frames, 1 / 4 / 8 copies | Misses **0 / 5,497 / 11,824**. Worst p95: 149 / 703 / 1,446 us; max: 305 / 1,082 / 2,154 us; budget 333 us. Four/eight-copy targets remain `fail`: worst average cost is 436/916 us, already above budget. Reduced burst concentration does not reduce total work enough and increases the number of over-budget callbacks versus the previous run. |
| Complete live switches, one copy, 48 kHz / 128 frames | `pass` for the observed zero-overrun target in both directions; maxima 1,221/1,570 us versus 2,667 us. All eight rate/instance/direction transition rows reach the asserted settled target bank. |
| Complete live switches, one copy, 192 kHz / 128 frames | **`fail`**: eight misses in each direction; Original-to-Spread max 5,323 us and reverse max 6,853 us against 667 us. Both directions necessarily process the preserved Original bank during some phases. Eight-copy transitions also exceed budget. These longer observation windows supersede the incomplete earlier 230 ms window. |

The bounded clear removes whole-history clearing from one callback; exact
signal parity and finite warmup/fade are established. This does **not** establish
high-rate live-switch deadline safety or make an over-capacity serial session
fit its deadline. Further reductions require profiling the preserved spectral
work and an explicit compatibility/latency decision before changing Original;
do not silently reduce its window, hop, quality or saved-state identity.
Full rows, preparation diagnostics and executable provenance remain in
`shimmer-48000-128-release.json`, `shimmer-192000-64-release.json`,
`benchmark-runs.json`, and `release-provenance.json` in the same ignored folder.

Reproduce focused correctness with
`tools/run-free-plugin-headless-regression.ps1 -CaseName <case> -ReportPath <json>`:
`clear-reverb`, `reverb-shimmer-performance`, `reverb-shimmer-scheduling`,
`reverb-hold`, `reverb-extended-heap`, and `reverb-extended-hold-headroom`.
The last profile observes 16 x 73-second regular/irregular headroom fixtures,
including continuing excitation and live Original-to-Calibrated Return changes;
run it in Release for practical turnaround. Timing remains `diagnostic_only`;
use the existing `reverb-shimmer-instances` profile and child-only rate/block/
Spread variables, with builds and other native/browser workloads paused.

### Design 03 Pitch/Synth implementation qualification, 22 October 2026

The measured local Release evidence uses executable SHA-256
`71b4cb485b4afbed4e891f7994abcd54e6b5ce2041fe7b12c1d4fd5213099a56`
on an AMD Ryzen 9 7900X. Reports and binary provenance are retained under
`output/review/fx-implementation-20261022/pitch/`. Builds, browser sessions and
other test processes were stopped during the two timing profiles. This is the
measured binary identified above, not a hash of subsequent final-build changes.
Native correctness/export work ran separately afterward; neither is physical-device
qualification.

Pitch now mirrors its FIR history to avoid inner-loop wrap work, shares input
loads across adjacent YIN lags without changing either accumulation order,
caches unchanged mapper/formant calculations, and splits oversized direct
callbacks into prepared-capacity views. MIDI offsets, latency and bypass
ramps remain intact. Bypass deliberately keeps analysis and Stretch active so
reactivation retains the existing wet history; bypass CPU suspension is not
implemented. Synth caches note frequencies and unchanged bend, pan and envelope
coefficients while retaining per-sample MIDI/MPE smoothing and automation.

| Evidence | Result and scope |
| --- | --- |
| Detector and mapper arithmetic | `pass`: 12 rate/range detector cases compare against the retained scalar FIR/YIN oracle, with exact zero error at original publication positions and varied callback partitions. Mapper cache transitions also have exact zero error. |
| Pitch direct callback contracts | `pass`: eight Legacy/Corrected, 48/192 kHz, mono/stereo cases. Oversized/prepared output and MIDI offsets agree exactly; bypass emits exact delayed dry after its ramp, resumed wet agrees with the continuously active reference, latency is stable, extra channels clear and unprepared calls return silence. Debug callback probes measured zero allocations/frees. |
| Shared Signalsmith consumer | `pass`: current Release `signal-pitch-fft-parity` after the grouped-silence Reverb repair, plus pitch range, bounded-lag and sustained-Humanize cases. |
| Synth automation and MPE | `pass`: 16 Legacy/Corrected, 48/96 kHz, MIDI/MPE partition cases, with 32 actual rendering voices across two channels. Bend, pan, controller reset, note release and modulated envelope edits agree exactly at matching event positions. Existing destination regressions also pass. |
| Pre-cache Synth audio | `pass`: all 12 persisted default/sine WAVs, including four rates and low/high notes, have identical sample bytes to the earlier audit captures. `synth-wave-parity.json` records both hashes for every file. This is an arithmetic regression check, not a listening judgment. |
| Explicit offline render/export | `pass`: 264 native checks. `hardwareBefore` and `hardwareAfter` both record offline startup, no device, zero starts, callbacks and callback registrations. The headless runner rejects missing/nonzero evidence; ordinary hardware startup is unchanged. |
| Default native free-plugin suite | `pass`: all 184 checks on the same Release binary, including the new Pitch/Synth groups, legacy/state compatibility and the existing effect/instrument/host contracts. This suite does not establish listening quality or a device-safe CPU envelope. |

Quiet warmed callback timing remains `diagnostic_only`; a missed deadline is
`fail` for the tested workload, regardless of the harness's separate finite
output gate. Each Pitch row has 2,048 observations, while each Synth row has
1,024:

| Workload | Median / p99 / maximum, microseconds | Deadline, microseconds | Misses |
| --- | ---: | ---: | ---: |
| Corrected Pitch, four instances, 192 kHz / 32 | 18.3 / 169.2 / 226.3 | 166.7 | **25** |
| Corrected Pitch, four instances, 192 kHz / 64 | 49.1 / 233.8 / 289.6 | 333.3 | 0 |
| Corrected Pitch, four instances, 192 kHz / 128 | 110.4 / 301.1 / 374.1 | 666.7 | 0 |
| Synth, 32 voices on two channels, 48 kHz / 128 | 311.2 / 331.8 / 444.1 | 2,666.7 | 0 |
| Synth, 32 voices on two channels, 96 kHz / 64 | 151.8 / 163.4 / 185.5 | 666.7 | 0 |

All tested Corrected Pitch one-instance rows and four-instance 48/96 kHz rows
had zero misses in this run. The previous four-instance 192 kHz audit recorded
59/2/1 misses; the new 25/0/0 result does not establish a device-safe envelope.
Legacy remains selectable and separately misses deadlines. The stress fixture
now verifies actual voice counts; its earlier single-channel 32-note label
only exercised 16 Synth slots and is not a comparable 32-voice benchmark.
The corrected Room-to-Shimmer fixture selects Shimmer (5), rather than Spring
(4), and reports eight misses at 96 kHz/64. Do not retain the old mislabeled
case as evidence that this switch is safe.

Reproduce with `tools/run-free-plugin-headless-regression.ps1`, supplying the
explicit Release `-AppPath`, `-CaseName` and a separate `-ReportPath`. Focused
groups are `pitch-detector-parity`, `pitch-realtime-contracts`,
`synth-cached-work`, `pitch-cost-parity`, `signal-pitch-range`,
`signal-pitch-fft-parity`, `humanize-sustained` and `synth-destinations`.
Use `signal-pitch-performance` and `performance-stress` only with competing
workloads stopped. `instrument-audit` writes captures below the child process's
`OPENSTUDIO_SIGNAL_AUDIT_OUTPUT` root. Run
`tools/run-render-export-headless-regression.ps1 -Configuration Release -SkipBuild`
against the same verified binary for offline host integration. Audio quality,
ASIO crackling/dropouts and the user's exact interface settings remain
`not_asserted` until those paths and artifacts are auditioned.

### Retained audio qualification and limits

The following is **dated local evidence**, retained from October 11–12, 2026,
not a claim that the current working tree was benchmarked again. Timing is
`diagnostic_only`; measured deadline violations are `fail` for their tested
workload. Listening, physical-device/dropout behavior, other platforms and
exhaustive malformed-state/automation combinations remain `not_asserted`.

| Evidence | Result and scope |
| --- | --- |
| Corrected Reverb, October 12 | `pass`: 95 long/control responses, exact 48 kHz Legacy/Corrected static parity for eight types, 252 host/render checks and 287 six-variant material combinations. Reference guitar mixes retained about 3 dB sample-peak headroom with authored trims. Quieter material breadth does not qualify arbitrary-input headroom. |
| Shimmer scheduling, October 12 | `pass`: 40 focused voice/lifecycle cases, 103 Release / 107 Debug scheduling cases, zero measured Debug callback allocations/frees and all 41 archived Legacy impulse hashes. `fail`: strict byte equality of four Spread wet guitar files; Wet100 maximum sample difference 0.0000119805, relative RMS difference -110.87 dB (`diagnostic_only`, audibility `not_asserted`). |
| Infinite Hold, October 11 | Finite output, partition/state and release passed. **12 continuing-input Infinite rows reached the ±4 final clamp** (eight Nonlinear, one Spring, three Rising-space); none of 41 finite-tail rows did. The focused 48 kHz stereo Calibrated/Infinite maximum-Nonlinear case first clamped at 3.6772 s with Wet100/Dry0/Output0. Output -30 dB avoided that final clamp in this fixture; internal saturation was uninstrumented. This is not indefinitely unclipped Hold qualification. |
| Pitch Correct, October 12 | 2,048 warmed callbacks/profile. Tested 48 kHz one/four-instance profiles at 32/64/128 frames had zero misses. **96 kHz/32, four instances: 5 misses. 192 kHz/32 or64, one instance: one each; four instances: 57/10.** Both instance counts at 192 kHz/128 had zero in that run. The strict zero-overrun criterion fails for the listed workloads. |

The Hold source repeated every second at about 0.12 peak. Maximum Nonlinear
used 2 s Duration, 0.95 ordinary Feedback, 20 s Late decay and full Late level;
Infinite circulates at unity while admitting new excitation. Calibrated
Nonlinear adds 30 dB at wet readout, outside feedback. Reducing Output can
avoid the final clamp without proving that internal history stayed unsaturated.
The 41-voice corrected guitar comparison likewise does not establish universal
wet dominance: at Wet100/Dry70, 29 voices had wet RMS at least dry RMS and 12
did not. Those source-specific ratios are diagnostic, not perceived loudness.

The archived October 12 Shimmer performance capture used optimized Release on an AMD Ryzen 9
7900X with 2,048 observations per steady case and no concurrent builds/renders/
browsers. Its **144 Spread cases** cover Tank/Input/Both, 1/4/8 instances,
identical/different inputs, four rates and 64/128 frames; **49 cases contain
deadline misses**. The table aggregates three routes and both inputs
(**12,288 observations per cell**):

| Rate / frames | One instance misses | Four instances misses | Eight instances misses |
| --- | ---: | ---: | ---: |
| 44.1 kHz / 64 | 0 | 0 | 0 |
| 44.1 kHz / 128 | 0 | 0 | 6 |
| 48 kHz / 64 | 0 | 0 | 27 |
| 48 kHz / 128 | 0 | 0 | 8 |
| 96 kHz / 64 | 0 | 54 | 4,207 |
| 96 kHz / 128 | 0 | 2 | 4,149 |
| 192 kHz / 64 | 10 | 5,043 | 11,081 |
| 192 kHz / 128 | 2 | 4,497 | 12,271 |

All single-instance Tank/Input rows had zero observed misses; the single-instance
192 kHz misses were Both. At 48 kHz/128 with eight identical-input instances,
Input had zero misses while Both had four (budget 2.667 ms). At **192 kHz/128,
one instance**, live Original↔Spread switches still recorded **7/8 misses**,
with maxima **5.077/6.984 ms** against a **0.667 ms** budget. These final results
supersede the earlier correction benchmark's Input-eight-instance 31 misses;
do not present the old row as current. Hardware scheduling and isolated DSP
outliers were not separated, and no device-safe envelope is asserted.

Retained evidence roots are `output/reverb-correction`,
`output/reverb-shimmer-performance` (`timing-summary.json`,
`instances-release-v1.json` and `guitar-comparison.json`),
`output/reverb-completion` (`reverb-extended-release.json` and
`reverb-hold-headroom-release-final.json`) and `output/free-plugin-repairs`
(`final-signal-pitch-performance.json`, `waveform-qualification.json` and
`host-export`). These ignored artifacts may be unavailable to another checkout.
An audible issue needs exact-artifact audition; metrics alone do not close it.

Cover factory/legacy/non-default state, block/rate/channel variation, finite extremes, phase/latency/dry-wet and bypass, independent final-output reconstruction, IR portability/failure, hold/tail retirement, MIDI ordering/repeated notes/pedals/chase, voice allocation, instrument release bounds and realtime cost/allocation diagnostics. Scalar tests alone do not establish project, native-host or offline behavior.

For actual host/export integration, run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-render-export-headless-regression.ps1`. This includes complete send publication, auxiliary outputs, processor preparation/PDC, full-state/factory/preset recall and actual exported release tails. Use the native lifecycle harness for real WebView boot/geometry/teardown. Browser fixtures separately establish layout, focus, gestures and callback pairing; mocked data is not audio evidence. Run the NAM headless suite after shared processor changes.

The opt-in native `-CaseName ten-hour-listening` retains its historical command name and produces deterministic source/settings/WAV artifacts. `python tools/create-free-suite-listening-preview.py --help` documents the local preview builder. Preview gain changes are recorded; original files remain unchanged. Listen to those exact artifacts before making a subjective claim. Fixtures and finite alias/peak tests do not prove commercial emulation, complete BS.1770/EBU conformance or arbitrary-input behavior.

Keep generated JSON, WAV, screenshots, hashes and failed/intermediate runs under ignored `output/`. Store lasting contracts in the maintenance guide and executable tests. The 3 October development baseline passed 2,480 frontend tests, 168 native groups and 233 host checks; current source still requires appropriately scoped checks after changes.

## Desktop and recording acceptance

Build packaged assets before native UI qualification. `tools/run-window-lifecycle-smoke.ps1` forces the packaged frontend; a running Vite must not influence the result. Use `-AppPath` for the exact Debug, Release or installed executable being tested. On an idle interactive Windows desktop, explicitly opt into physical mouse input and repeated pitch windows:

```powershell
$env:OPENSTUDIO_WINDOW_INPUT = '1'
$env:OPENSTUDIO_WINDOW_CYCLES = '50'
./tools/run-window-lifecycle-smoke.ps1 -AppPath build/OpenStudio_artefacts/Debug/OpenStudio.exe -ReportPath "$PWD/output/review/windows.json" -TimeoutSeconds 600
Remove-Item Env:OPENSTUDIO_WINDOW_INPUT
Remove-Item Env:OPENSTUDIO_WINDOW_CYCLES
```

Record physical rectangles and DPI; verify title-bar movement, resize, minimize/restore, native close/reopen, main-window inactivity, target/project replacement and owner-loss checkpoint recovery. Repeat actual 100/125/150/200% scaling and monitor moves. A CSS viewport or direct native bounds setter does not prove OS gestures or mixed-DPI behavior. The 29 September build-tree Windows Release run passed 50 pitch reopen cycles; it did not qualify an installed artifact or other platforms. Later source changes require new relevant evidence.

Release gates install/test the Windows EXE, exercise the mounted macOS DMG and launch the Linux AppImage under Xvfb/Openbox. On Linux, runtime assets resolve beside the running ELF through `/proc/self/exe`, including AppImage launches; inherited `APPDIR` cannot redirect resource lookup. Xvfb/Openbox qualifies X11/XWayland, not native Wayland. Pipeline definitions alone are not executed platform results.

For Windows issue [#7](https://github.com/sdevil7th/OpenStudio/issues/7), detected WebView2/VC++ versions and a successful prerequisite self-test are insufficient: the original Windows 10 report already detected both runtimes. Qualify the current installed **Release** executable from a non-elevated process, with no dev server, in normal and safe modes, and repeat with an unusable inherited fixed-runtime folder. Run this only after building/installing an executable that supports the offline lifecycle flag:

```powershell
$exe = 'C:\Program Files\OpenStudio\OpenStudio.exe'
foreach ($mode in @('normal', 'safe')) {
    foreach ($stale in @($false, $true)) {
        $variant = if ($stale) { 'stale-runtime' } else { 'clean' }
        ./tools/run-window-lifecycle-smoke.ps1 -AppPath $exe -StartupMode $mode `
            -StaleRuntimeOverride:$stale -RequireStandardUser `
            -ReportPath "$PWD/output/review/windows-$mode-$variant.json"
    }
}
```

The wrapper refuses older binaries before launch and requires `--window-lifecycle-offline`: saved audio-device settings and hardware callback registration are skipped only for this explicit harness mode. The native report must prove no current audio device, zero device starts and zero callbacks; ordinary app startup is unchanged. Safe mode requires the recovery frontend in every detached browser role, including pitch, without claiming normal pitch editing. Normal mode retains the pitch edit/undo gates. Both require one ready document per main/detached browser through close/reopen cycles, packaged assets, and a configured/per-process WebView2 data path outside the install directory, including rejection of the install directory itself. Windows launches are suspended until assigned to an owned Job Object; cleanup terminates remaining owned descendants and requires the job to empty within five seconds, even after the app has exited. Cleanup failure makes qualification fail. Fixtures exercise both a surviving child after parent exit and a running parent, while preserving an unrelated process.

Stale-runtime injection changes only the child process environment and tests a **nonexistent inherited fixed-runtime folder**; parent values are restored after launch. It does not cover a corrupt or wrong-architecture runtime, asynchronous environment initialization failure, or the exact Windows 10 Repair report. No installer or runtime repair is run.

Keep each native report, adjacent startup log and `.qualification.json` together. The latter records executable path/hash/version, host OS, standard-user status and the injected path; it does not claim visual inspection, real audio qualification or Windows 10 coverage. Validate an existing artifact without launching an app with `-ValidateOnly -ReportPath <report> -StartupMode normal|safe`. Windows CI runs the four cases from its already staged non-writable bundle and runs cleanup/validation fixtures; an elevated CI identity with denied bundle writes does not substitute for a Windows 10/11 standard-user installed run. Missing, malformed, nonzero hardware or incomplete detached-window evidence must fail closed. The reported Windows 10 22H2/build 19045 environment and endpoint-policy/Controlled Folder Access behavior remain separate real-machine checks; a build-26300 Debug pass cannot close them.

To close the original report, test the installed candidate in Program Files on Windows 10 22H2/build 19045 using the same affected user and WebView profile: reproduce recovery, choose **Repair Dependencies**, restart, and repeat the normal/safe main-and-detached readiness matrix. Retain the exact installed executable hash plus startup and repair logs from before and after repair. A fresh-profile success is diagnostic and does not close a failure that persists in the original profile.

On 22 October, local build-26300 qualification passed all four Debug readiness cases, then repeated Debug normal/clean with the corrected Job Object launcher. A fresh local Release build passed all four cases with that final launcher from a staged, non-writable bundle under a non-elevated token: 99 checks in each normal case and 90 in each safe case, with 10 ready frontend documents per case and zero hardware device starts/callbacks. The write-denial probe passed and the original bundle ACL was restored afterward. The Release executable SHA-256 was `001ac638e789a2193526604e03b556449f43edf770b660d1655c6a7c2b6fa8fd`; this was a local qualification build, without replacing or launching the installed Program Files artifact. Debug and Release builds produced no compiler warnings. Both used the frontend built at `2026-10-22T05:42:38Z`, whose packaged index matched `frontend/dist` (`f1ca2a24e6a094b394fa5e9c373e75bd583e9aa5846a584a72bf95f8204b97fd`). All 15 qualification fixtures and the focused Release `dynamics-audit` passed, including its 64 active-unity headroom cases; audio quality remains `not_asserted`. Exact reports, binary/frontend hashes and cleanup evidence are indexed by `output/review/windows-startup-20261022/qualification-summary.json`; the incomplete earlier attempt is excluded. These results qualify the tested mechanisms on this host, not the exact Windows 10 Repair scenario.

For each physical recording configuration, start with 60 seconds then a 30-minute sustained capture. Exercise the actual interface (including supported ASIO small buffers), WASAPI USB/webcam input/output pairs, Core Audio permission/aggregate configurations and Linux's shipped audio backend. Save `getAudioDebugSnapshot()` immediately before and after the take plus the original PCM WAV:

```text
python tools/evaluate-recording-qualification.py --before before.json --after after.json --audio take.wav --seconds 60 --report qualification.json
```

The evaluator rejects missing/reset/unsupported counters as proof of a clean take. Record requested/accepted rate/channels/buffer, frames, drops, lock misses, disk errors, xruns when supported, and device events. Test privacy denial/regrant, unplug/reconnect, sleep/wake, endpoint changes and competing exclusive clients. Device loss must finalize the take once without silent input substitution.

Use a known loopback/acoustic source and periodic markers to measure drift; establish tolerances from the measurement setup first. Equal nominal input/output rates and a wall-clock timer are insufficient. Prefer OS-supported synchronization; a Windows adaptive FIFO/resampler would be separate implementation work. Physical microphone identity, clock drift and listening remain separate from synthetic recorder tests. Investigate route/render state first if live playback and exported audio disagree.
