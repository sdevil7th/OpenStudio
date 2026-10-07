# PR 26 Linux integration qualification

This report records the October 7, 2026 integration of the existing workstation
effects/automation PR and the previously uncommitted Linux support. It describes
source and test evidence, not a published release or a claim that every device,
plugin or audible behavior has been qualified.

## Preserved work and integration

- Original checkout: `develop` at `9b8f219d52faebe0c26699a9ac2848523ad01575`.
- Original PR head: `bfd656f09b55f5d5adb294f1ac63ca165ae73a3e`.
- Preserved Linux stash: `1263784a351f22b52185073b8b2ffe695bd2d17d`, retained
  together with branch `backup/linux-before-pr26-20261007` and local binary patch
  and untracked-file archive under `output/merge-pr26/`.
- Integration commit: `ca097b33b909e8e5f9f84d0e96d8e405625d0fa0`, pushed to the
  existing `fix/workstation-review-readiness` branch. Subsequent qualification
  corrections are listed in the final source record below.

Nineteen conflicted files were reconciled against both implementations. Audio
settings retain the PR's discovery/pending Apply/OK and rollback semantics.
Project restoration keeps Linux metadata, source channels, complete atomic sends,
automation, asynchronous FX ownership and recovery. CLAP retains generation-aware
automation/state and per-instance GUI/timer lifecycle. Linux uses the actual
`/proc/self/exe` resource root and keeps the shipped AppImage filename contract.
Release-note and pinned-dependency gates remain enabled.

## Qualification status

Linux installation and AI qualification below are pinned to production source
`348ad87`. The macOS keyboard policy correction preserves application code and
all assertions. Subsequent compiler-warning cleanup and canceled credential-worker
repair rebuild/requalify Debug; final hosted outcomes are linked from the PR.

| Area | Result and exact scope |
| --- | --- |
| Frontend production build | **pass**: dependency notices, TypeScript and Vite. Existing Vite chunk-size and dynamic-import warnings remain. |
| Frontend unit tests | **pass**: final hosted Linux/Windows runs on `348ad87` have 2,832 tests in 237 files. Earlier local 2,831-test and 86 focused runs overlap and are not additive. |
| Browser flows | **pass**: one complete final run, 272/272: Chromium 136/136 and WebKit 136/136, with zero retries, skips or flaky cases. All 819 tracked frontend inputs remained identical to `348ad87` throughout. Earlier failures and their fixture corrections are retained separately. |
| System WebKitGTK | **pass**: 44 control, layout and focus checks in the actual host WebKitGTK. These use the browser mock bridge. |
| Python tooling | **pass**: 211 tests with no skips, including actual PowerShell filesystem fixtures on Linux and five fail-closed LV2 dependency-patch tests. |
| Native windows | **pass on the final Debug binary**: 74/74 normal and 65/65 Safe Mode main/detached lifecycle checks, including each role's frontend `boot-ready`. Safe Mode checks recovery UI rather than normal pitch editing. |
| Render/export | **pass on the final Debug and installed Release binaries**: 239 objective checks covering current source selection, queue planning, formats, rates and safety, with clean shutdown diagnostics. |
| Engine/runtime | **pass on the final Debug and installed Release binaries**: 40 engine suites and 294 Debug / 293 Release runtime checks, including eleven new stem-file readiness checks. The difference is a Debug-only assertion-observer check. Strict shutdown diagnostics pass after the MIDI ownership correction. |
| Built-in effects | **pass**: all 170 complete groups in the optimized rerun and again in the final installed DEB, including LV2 identity coverage; zero logged assertion/leak diagnostics. Exact Release hashes are recorded below; Release assertions are compiled out. |
| Focused channel/rate safety | **pass**: 36 final Debug Saturator, Gate and NAM rows, including nested mono Chaos processing. |
| CLAP protocol fixture | **pass**: 13 protocol/timer flags, including actual message-loop timer dispatch and stale-generation rejection. |
| Clean Guitar | **pass**: five objective checks; the sixth check is **not_asserted**. Audible quality remains **not_asserted**. |
| Updater and installer | **pass**: 22 updater checks and 17 helper checks. The helper's secure-path self-test ran in a private owned directory outside a root-mapped user namespace. |
| Ubuntu 22.04 baseline | **pass on the recorded candidate**: actual prerequisite installation, GCC 11 Release build with external system Python AI fallback disabled, and glibc 2.35 ABI gate. |
| Native packages | **pass**: final DEB26→27 upgrade, removal/reinstall and actual FUSE AppImage normal/Safe/full qualification. All 302 recorded user files survive removal/reinstall byte-for-byte; reinstalled native lifecycle passes. Earlier14→26 upgrade remains separately recorded. |
| AI runtime/workers | **pass** for fresh CPU runtime/stem-model installation, real transfer cancellation/retry, repeat setup, inference and the additional workflows below. Fresh GPU overlays/ACE model downloads are **not_asserted**. |
| Native AI UI | **pass** for earlier ten-second ROCm generation, six-stem import, undo/redo, completed-job recovery and native seven-track save/open/resave; final current-source 30-second native ROCm generation/import also passes with automatic child library paths. |
| Development entry point | **pass**: actual `python3 build.py dev --run` built frontend/Debug, started Vite itself, loaded the development URL and reached native main `boot-ready`. Closing the window stopped its ten owned app/server/helper processes; port 5183 was free afterwards. The host has no `python` alias; no host alias or package was installed. |
| Hosted CI | On `348ad87`, Linux DEB/AppImage, Windows Release87/87 plus readonly-install preflight, macOS14ARM74/74, macOS15Intel74/74 and Windows/Ubuntu unit2832/browser194 jobs pass. The macOS15 browser job passed192/194 with two Tab-policy failures; its CI-only correction is described below. All ten other Verify jobs and all three updater-safety jobs pass; this is not an overall success claim for that original run. |

## Defects found during integration testing

The native tests caught real negotiated-channel preparation faults: Saturator's
oversamplers/dry delay and NAM's embedded processing islands used stereo
preparation while processing mono. Preparation now follows negotiated channels,
including the nested Chaos processor. Gate's initial low-pass cutoff now obeys
the existing Nyquist ceiling at low device rates.

Render alignment fixtures now use a deterministic rate and paced injection.
Production rejects capture windows smaller than 4,096 samples before arming, with
an actionable longer-window choice. The pitch bypass fixture now tests delayed
dry parity against its reported latency rather than assuming zero latency. This
does not change pitch DSP or establish pitch quality.

Linux plugin discovery originally treated LV2 bundle paths as catalog identities,
then discarded the descriptions whose stable identities were plugin URIs. The
scanner now enumerates URIs from metadata before isolated native probes. The new
regression covers multiple plugins per bundle, case-sensitive URI identities,
bounded metadata reads and catalog matching/removal. Real external-plugin results
retain 64 types: 14 VST3, 14 CLAP and all 36 MDA LV2 URIs, with zero scan failures
after excluding two ProM modules requiring absent vendor `libprojectM.so.2`.
The pinned JUCE LV2 metadata reader also implicitly converted HTTP URIs to files;
a minimal absolute-path guard now preserves URI lookup without that assertion.
The patch refuses missing, changed, duplicated or mixed dependency contexts.
Actual MDA Delay LV2 and DPF 3BandEQ CLAP each pass 34 processing/state/editor
checks without assertions/leaks. DPF 1.7 VST3 fails shutdown qualification despite
passing those objective checks, including without an editor. Upstream COM
reference ownership is a diagnostic inference, not a repaired vendor artifact.

The final NAM rack has 210 checks: 188 **pass**, 15 **diagnostic_only** and
7 **not_asserted**, with its objective gate passing and no Debug assertion/leak
diagnostics. Audible quality and uncalibrated performance comparisons remain
outside the objective gate.

The final Ubuntu 22.04 installed host additionally scans all 36 MDA LV2 plugins.
The original processing/state/editor matrix has 1,140 checks: 1,134 pass and
six RePsycho nonzero-output rows return finite silence. Thirty-five plugins pass
all their generic-default checks. RePsycho's default wet-only sampler requires a stereo sum above
0.2511886; the fixture peaks at 0.1 and correctly produces silence. The original
failure remains retained. With a documented `Thresh=0.1` parameter profile, its
six finite/nonzero audio rows and all state/editor checks pass. Only a private
TTL default copy is mounted for that process; the vendor `.so` and installed
OpenStudio ELF are unchanged. This does not claim every default preset passed.
The host's earlier selected MDA package is 1.2.10; the Ubuntu guest uses 1.2.6.

The real AI probe accepted empty checkpoint files as installed. Probe/setup now
require regular nonempty checkpoint and configuration files, including native
initial/refreshed status; refreshed status cannot override a negative probe with
a filesystem-only fallback. They retry empty cached model/config files atomically,
reject empty/truncated responses and preserve directory collisions with an
actionable error. This does not authenticate arbitrary nonempty cached weights;
the published model list does not supply trusted content hashes.

Debug assertion observations remain enabled. Long headless DSP matrices dispatch
messages only between completed fixture blocks, under a headless-only scope.
Timing reports explicitly retain wall time and measured dispatch time; performance
and audio characteristics remain **diagnostic_only**. Deliberately injected WAV
header seek failures are narrowly labeled **diagnostic_only** by exact location
and owning thread. Other assertions/leaks continue to fail qualification.

The Safe Mode harness formerly awaited normal pitch-analysis/edit callbacks even
though Safe Mode deliberately mounts recovery UI. Its separate recovery branch
now checks actual pitch-window boot/reopen/close and keeps all normal-mode editing
checks. A CLAP stress fixture similarly confused queue-owned global tickets with
producer-local ordinals; it now checks both independently without changing the
production queue or its loss, duplicate and ordering gates.

The full Debug engine run also exposed four leaked MIDI event objects. GDB
tracked all four to unsupported/meta messages in `importMIDIFile`: allocation
preceded the filter and `continue` discarded the unowned pointer. A local
reference-counted owner now releases ignored events and transfers supported
events to the existing array. This is a production ownership correction, not a
suppressed leak report. Allocation stacks remain under `leak-probes/`.

Linux development cleanup no longer globally kills processes named OpenStudio.
The launcher gives its app/server their own groups and cleans only those groups,
including children whose parent exited. Actual unrelated-instance and stubborn
child tests cover this behavior.

## AI evidence and limits

A fresh published Linux CPU runtime 0.0.14 was downloaded, verified and extracted
into an isolated directory: 629,730,575 bytes, SHA256
`9261faee0ac3886d45e09fc38961becc9ada9c8dfe87b982535c095d11680bd6`.
Its relocatable interpreter, `pip check`, probe and stem feature verification
passed. Selecting generation on the unaccelerated CPU base correctly reports
incomplete acceleration. The approved ROCm runtime also passed `pip check`, probe
and both feature verifications.

Production setup downloaded a fresh public 699,412,152-byte BS-RoFormer checkpoint
and 4,653-byte configuration into an initially empty directory, with no cache
copies. Canceling a real transfer after 1 MiB promoted no final model; retry
succeeded and removed the partial file. Repeating setup transferred no files and
preserved exact hashes. Probe, `pip check` and fresh-runtime six-stem inference
passed; all outputs were finite stereo 44.1 kHz, 132,300 frames. This tests real
worker cancellation/retry, not the native GUI Cancel button.

After the native readiness correction, thirteen real worker checks passed
against the CPU and ROCm runtimes. Missing/empty YAML stays unavailable even
when `runtimeReady=true`; healthy setup transfers no files; each missing/empty
YAML repair downloads exactly one 4,653-byte configuration and reaches ready.
Healthy checkpoint and original runtime/model hashes remain unchanged.

Actual CPU inference produced six finite stereo 44.1 kHz, three-second stems from
a source with spaces/Unicode. Five stems were silent for the synthetic fixture;
this verifies execution/file shape, not separation quality. Five direct ACE
workflows—Variation, Inpaint Selection, Continue Clip, Text to Music and Lyrics &
Style—produced finite stereo 48 kHz outputs with exact requested durations and
unchanged source hashes. These reused the already approved complete ACE cache;
fresh ACE model or GPU overlay downloads are **not_asserted**.

The real JUCE/WebKitGTK UI reported Radeon 8060S readiness and imported a ten-second
ACE generation. Undo/redo passed. Six-stem separation imported all six tracks,
muted the source, and restored the correct mute/track state through undo/redo.
Completed AI recovery imported audio. Native Save/Open/resave preserved all seven
tracks and every project field except the save timestamp. That project used
recovered audio plus stems; it does not establish original AI-track type/parameter
roundtrip. The retained native startup log explicitly records the generation
denoising phase with `backend=rocm`, its managed runtime and successful worker
exit; the backend claim does not rely only on the readiness display.

A final current-source Release run also generates/imports a finite 30-second
stereo 48 kHz file (1,440,000 frames). Its native parent has no `/opt/rocm` library
path, while the actual managed worker receives `/opt/rocm/lib` plus the unchanged
inherited paths. Native startup records denoising `backend=rocm`. This directly
qualifies the automatic child environment; the earlier native run pre-supplied
the SDK path and remains separately scoped. Approved runtimes/models stay read-only.

No listener approved these exact artifacts. Pitch, formants, naturalness,
separation quality and generated musical quality are **not_asserted**, with
unapproved numerical audio comparisons **diagnostic_only**.

## All currently open GitHub issues

| Issue | Assessment |
| --- | --- |
| [#7: Windows 10 WebView2 unavailable](https://github.com/sdevil7th/OpenStudio/issues/7) | Writable per-user WebView2 options are shared by availability probing and browser creation. The earlier fix and PR's inherited-runtime cleanup are present. The original Windows 10 reporter reproduction remains **not_asserted**; a Linux test cannot confirm it. |
| [#23: Arch AppImage missing assets](https://github.com/sdevil7th/OpenStudio/issues/23) | The concrete outer-AppImage resource-path fault is addressed by `/proc/self/exe`; misleading `argv[0]` and valid-looking inherited `APPDIR` are tested. Native packages declare dependencies. The exact reported Arch environment remains **not_asserted**. AppImages still require host GTK/WebKit/FFmpeg. |
| [#24: AI installation WinError 5](https://github.com/sdevil7th/OpenStudio/issues/24) | The attachment shows DirectML fallback replacing an already loaded ONNX DLL. The PR prepares/verifies a separate runtime and atomically activates it, preserving the old runtime on failure. Deterministic repair tests pass; actual Windows CUDA-to-DirectML installation remains **not_asserted**. |
| [#25: menu action restores maximized window](https://github.com/sdevil7th/OpenStudio/issues/25) | Portal menu events no longer reach a parent titlebar drag handler; dragging belongs to the empty titlebar sibling. Browser regression verifies one-click Preferences/media and zero unintended drag calls. The exact Preferences/media action while the native Windows window is maximized remains **not_asserted**. |

All four issues remain open. No issue comments, closures or reporter confirmation
were fabricated.

Windows 11 hosted Release lifecycle on both `ca097b3` and `12fa3c3` passes 87/87, including actual
boot and generic maximize/restore. This supports the writable-install and window
contracts, but neither reproduces the Windows 10 reporter's machine nor exercises
Preferences/media import specifically while maximized. Those exact issue
reproductions remain **not_asserted**.

The first Windows browser timeout had a blank root and
`net::ERR_NO_BUFFER_SPACE` after an immediate reload interrupted Vite's module
graph. The automation fixture now clears storage before first navigation; twelve
focused repetitions across Chromium/WebKit pass. The old macOS 14 browser job
failed before navigation on Playwright's `PushAPIEnabled` protocol setting.
[Playwright 1.59 removed macOS 14 WebKit support](https://playwright.dev/docs/release-notes#version-159),
while this checkout locks Playwright 1.62.1. Only the browser job moves to macOS 15;
native macOS 14 coverage remains. An older Intel native run had three initial MIDI
readiness/geometry failures and a successful later reopen. It remains retained
as a failed run; JSON alone does not identify its cause. The `12fa3c3` and `348ad87` Intel runs
pass all 74 checks, including the initial MIDI sequence. Native window-lifecycle `--report` startup logs are
now retained next to their reports for subsequent diagnosis.

The subsequent macOS 15 browser run passes 192/194 cases and fails two immediate
focus-containment checks after exhausting native text/select fields. Its trace
contains Headless UI focus-guard buttons without explicit `tabindex`; their
redirection is synchronous. This matches the macOS WebKit button-skipping policy
reported in [Playwright issue 41808](https://github.com/microsoft/playwright/issues/41808)
and [Apple's documented keyboard behavior](https://help.apple.com/safari/mac/8.0/en.lproj/cpsh003.html).
The workflow now sets only `org.webkit.Playwright AppleKeyboardUIMode=2`, proves
four forward/reverse ordinary-button transitions before app tests, and removes
only that key afterward. All 45 modal Tab/Shift-Tab assertions, background-edit
protection and Escape checks remain. No production component, timeout, retry or
fixture assertion changes. The four-transition local Linux probe verifies script
execution; only the hosted macOS preflight/modal run can confirm the Apple policy.
On `3b5e333`, the actual hosted macOS preflight passes all four transitions, followed
by all 194 configured browser cases, including both unchanged modal flows.
Windows and Ubuntu also pass all 194 configured cases and 2,832 unit tests;
Ubuntu's actual system WebKitGTK checks pass 44/44. These hosted browser runs use
mock bridges and cover 136 Chromium plus 58 selected WebKit cases; they are
distinct from the complete local Linux 272-case Chromium/WPE WebKit run.
The browser-scoped all-controls macOS preference is explicit; the default
button-skipping preference remains outside that keyboard-navigation assertion.

## Compiler warnings and canceled credential workers

The final macOS ARM build-log audit found 17 unique first-party AppleClang
warnings despite passing native lifecycle: unnecessary scalar lambda captures,
an unused platform-specific capture, unused constants and two dead editor buffers.
The cleanup removes only redundant compile-time scalar captures and unused
storage. The Windows callback retains its required `this` capture; ONNX-only
constants remain available when that backend is enabled. Four focused compiler
checks pass, including PolyPitchDetector with ONNX both enabled and disabled.
No DSP, automation, project schema or preset changes.
The Windows log audit additionally found nine MSVC shadowing warnings: eight
inner report paths shadowed the startup report path, and a CLAP extension pointer
shadowed JUCE's timer storage. Two identifier-only renames preserve every use.

Pinned WDL/SWELL still uses legacy AppKit APIs and stb's internal writer uses
`sprintf`. AppleClang deprecation exceptions apply only to those vendor source
files in the `lice` target. One WDL drag-mask diagnostic is scoped to
`swell-dlg.mm`; the pinned JUCE VST3 ignored-expression exception applies only to
its vendor aggregates. The WDL key mapper's variable-length array exception is
limited to `swell-kb.mm`, using the compatible parent
[Clang diagnostic group](https://clang.llvm.org/docs/DiagnosticsReference.html#wvla-extension).
First-party warning checks remain enabled. Actual hosted
compiler logs determine the final macOS warning outcome; no successful CI exit
alone is treated as proof of zero warnings.

The fresh Debug run passed 74 lifecycle, 239 render, 294 runtime and all 40 engine
suites, but failed its strict gate with 174 message-queue overflow assertions
(duplicated across startup/main logs).
Both original logs and the failing binary are retained. Two focused GDB traces
identify the actual chain: a retired mixer's `MainComponent` destructor drains its
canceled NAM/TONE3000 pool while an auth-status job blocks on the global credential
mutex. Another still-live window's worker holds that mutex during a slow Secret
Service lookup. The lookup itself is asynchronous and polls cancellation; the
blocking lock wait cannot observe the closing window's cancellation. The UI
thread stalls and JUCE's timer messages overflow the bounded queue.

The repair makes credential single/dual mutex and process-lock waits observe
cancellation while retaining the complete protected read/revalidate/write
transaction. Worker pools remain owned and drained; no destructor pumps the UI,
no worker is detached, and no queue assertion or capacity gate is weakened.
Deterministic contention tests and the original unavailable-service native
lifecycle determine acceptance; this failure is not waived because functional
checks or hosted Release builds passed.

The repaired Debug binary passes the original unavailable-service normal run:
74 lifecycle, 239 render/export, 294 runtime checks and all 40 engine suites,
with zero unexpected assertions/leaks. Its nested NAM catalog regression has
21 passing checks, including all five new cancellation/serialization/real-child
process-contention checks. Safe Mode separately passes all 65 lifecycle checks
and three startup/path checks with clean diagnostics under the same environment.
The real status-job pool drains while its live peer
still holds the actual credential mutex; no OS credential read or epoch change
is needed for that acceptance.

## Evidence, isolation and remaining coverage

Local retained evidence lives under `output/merge-pr26/`: frontend/Python/build
logs, `system-webkitgtk/`, `native-debug-verified/` (earlier failed diagnostics),
`native-debug-final-348ad87/`, `native-debug-safe-348ad87/`,
`native-debug-warning-cleanup-normal/`, `native-debug-warning-cleanup-safe/`,
`native-debug-warning-cleanup-final-normal/`,
`native-debug-warning-cleanup-final-safe/`, `warning-queue-gdb/`,
`warning-queue-gdb-deep/`, `warning-queue-reproducer/`,
`ubuntu22-final-installed-normal/`, `ubuntu22-final-installed-safe/`,
`ubuntu22-final-installed-free-plugins/`, `ubuntu22-final-appimage-normal/`,
`ubuntu22-final-appimage-safe/`, `native-ai-autoenv/`,
`native-extended-complete/`, `native-extended-release-final/`,
`native-clap-queue-final/`, `native-plugins-verified/`, `ai/fresh-stem-install/`,
`ai/native-readiness-cpu/`, `ai/native-readiness-rocm/`, `native-ai/`, guest
build/package reports and hosted failure logs. Initial failures remain available.
The final source/artifact record below distinguishes these candidates.

Tests use task-owned config/cache/data/Documents and displays, with explicit
device bindings. Some initial launches did not bind Documents before discovering literal
`~/Documents` consumers; a plugin catalog was rewritten there. The observed
load/save logs contained zero catalog entries; no pre-launch snapshot exists.
Those launches are not described as fully profile-isolated. Subsequent launches bind Documents explicitly. Task-local D-Bus
was needed to show GTK file choosers on the independent test display. Host OS
packages were not installed; prerequisite installation occurred in a disposable
Ubuntu 22.04 guest.

The host is Ubuntu 26.04, kernel 7.0.0-34-generic, Ryzen AI MAX+ 395 with Radeon 8060S
and shared GPU memory. The verified CPU runtime uses Torch `2.5.1+cpu`; the
reused accelerated runtime uses `2.9.1+rocm7.2.0.git7e1940d4`. These facts describe
the test environment rather than qualification of other hardware.

The source/UI inventory's 180 features and 378 entries are membership records,
not 378 passed tests. Hardware microphone/MIDI/monitoring, suspend/reconnect,
mixed DPI, long sessions, every third-party plugin, exact Arch, native Windows
reporter reproduction, NVIDIA INT8 and gated MiniMax/Stable Audio downloads remain
**not_asserted**. RPM construction remains gated to a real Fedora host, which was
not part of this final Ubuntu candidate run. Previous vendor Nekobi/AmpliTube and played-guitar Punch/AutoJoin
findings remain outside a claim of resolution.

## Final source and artifact record

The production installation/AI evidence is pinned to [348ad87](https://github.com/sdevil7th/OpenStudio/commit/348ad87174612537693beb55a7e38d4f900c40ca),
after integration `ca097b3` and qualification corrections `12fa3c3`/`364e7f9`.
The full optimized 170-group effects run uses SHA256
`1574ab966204b907bc1ab708ad3f5eeeb8f2f69f3286bf543b2d3b1bdd5b7d0f`;
its components predate the MIDI-event ownership and stem-readiness corrections,
which do not change effects processing. The qualified `348ad87` Debug SHA256 is
`5406beeb17ab4e5f6169bc53be1db01f34ff8e305c8e33d6e776539015f3751f`;
final Ubuntu 22.04 Release SHA256 is
`3bc85a2681f76be7ab42333fd6630c2dc747c81df9b981ac86fa0b7a2e46bfb5`.
The host final Debug build has zero warnings, all 147 frontend files match the
packaged `webui`, and the copied AI probe matches the source. Normal lifecycle
74/74, render/export 239/239, runtime 294/294, all 40 engine suites and Safe Mode
65/65 pass on this Debug hash, with zero unexpected assertions/leaks. The installed
Release hash independently passes normal 74/74, Safe Mode lifecycle, render
239/239, runtime 293/293, all 40 engine suites and all 170 effects groups with
clean diagnostics. The updated AI probe matches SHA256
`82a96b96a22ce7eddbe1d67c704278a88e84daaa8d756da5d48c0db4b630523f`
in source, Debug, guest Release, installed DEB and the host optimized bundle.
A stale probe in the host test bundle was detected and refreshed before final
native AI validation; installed package contents were already current.
Final DEB SHA256 is
`6467028fd123827a1911d06fc41fcab0937e7078d9a86d23acfa4dfdb8b77a53`;
actual AppImage SHA256 is
`7f7d1f596f5b668a4778365e85df51119ca65147a16329256d27d09c79dc371d`.
Packaging adjusts the AppImage internal ELF runtime paths, so that internal ELF
hash differs from the pre-packaging executable; the actual FUSE launcher was
qualified independently. DEB removal/reinstall preserves all 302 recorded user
files and restores the exact final executable and probe. All task browsers,
servers, displays and the guest VM are stopped; ports 5183/5184/22240/5990 are
free. Native/browser hosted results, including the macOS keyboard-policy preflight,
are linked from [PR 26](https://github.com/sdevil7th/OpenStudio/pull/26). The
final branch includes the keyboard-policy correction, compiler-warning cleanup
and cancellation-aware credential-lock repair. The latter changes window teardown
behavior; the installation/AI artifact pins above describe their prior production
source rather than this later repair. The rebuilt Debug SHA256 is
`c874a06fec66ce3fadbdfebf536b5f6919537bb4ce1f60b95d3c630c92d6e9e3`.
It builds with zero warnings/errors, all 147 packaged frontend files match, and
the copied AI probe retains the recorded source hash. Fresh normal/Safe Mode
Debug qualification passes normal 74/74, Safe Mode 65/65, render/export
239/239, runtime 294/294 and all 40 engine suites, with zero unexpected
assertions/leaks. All five new credential checks pass within the 21-check NAM
catalog fixture. Final hosted native results are retained separately and linked
from the PR description.
