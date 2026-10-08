# Linux installation and feature qualification

Latest AI follow-up: [installed AI audit on Ubuntu 22.04/24.04/26.04](ai-ubuntu-qualification-2026-10-01.md).
Revision 11 passes in-app stem installation/inference; Basic Pitch fails and full
generation qualification remains blocked. This supersedes earlier AI status below.

Latest follow-up: [revision 7 native verification](linux-native-followup-2026-10-01.md)
passes Ubuntu QA upgrade, installed save/reopen and MIDI interactions. The Debug
harness ownership leak is corrected and diagnostic failures now fail qualification.
Live Audient DAW signal verification and native Windows/macOS remain open.


Status (2026-10-01, latest checkpoint): revision 6 DEB adds the Linux mixer-control
correction; revision 5 remains the last four-distribution DEB/RPM qualification.
Both use the Ubuntu 22.04 native build. Installed checks run in real Ubuntu 22.04,
Debian 13, Fedora 44 and Mint 22.3 live VMs. Fedora/Mint graphical installation and
Ubuntu/Debian graphical removal/reinstallation have passed in the environments
described below. Full stock-desktop coverage, real-source listening, remaining
plugin findings, public delivery and Snap remain open. The physical host still
has 0.1.04-5. Later dated checkpoints supersede older
candidate filenames and blockers retained here as investigation history.

## Agreed scope

- Stage 1: downloadable installers and installed-application verification for
  Ubuntu, Debian, Linux Mint, and Fedora on x86-64.
- Use `.deb` packages for Ubuntu/Debian/Mint and `.rpm` packages for Fedora.
  Qualify each supported distribution/version; one distribution's pass does not
  qualify another.
- Customer flow: browser download → double-click → graphical installer → normal
  administrator authentication → launch from the application menu.
- Owner-approved exception: where DEBs open in Archive Manager, document the
  one-time Open With Software Install / Set as default step before promising
  subsequent double-click installation. A desktop package installer must exist.
- No terminal commands, `chmod`, manually installed development dependencies, or
  pre-running development servers in the customer flow.
- Installation may download declared dependencies. The installed base application
  must launch offline. Large AI runtimes/models remain optional downloads.
- Stage 2: Ubuntu App Center / Snap Store packaging, qualification, and publication.
  Flathub is outside this agreed delivery scope.
- Preserve user projects, recordings, presets, and existing AppImage update
  contracts. A native package must not use the AppImage self-replacement path.

## Baseline evidence (2026-09-30)

Audited downloaded `OpenStudio-0.1.03-linux-x86_64.AppImage` on Ubuntu 26.04 LTS,
kernel 7.0.0-34-generic, Wayland. SHA-256 matched the published asset:
`e03e3f1765f44535243edd7a6d89ea878a9134d3e137772f97cfce21ab0399e1`.

1. The download was not executable (`0664`). A temporary executable copy entered
   the app successfully; missing FUSE 2 was **not** a demonstrated blocker.
2. AppImage startup self-test failed with `packaged-frontend-missing`: asset lookup
   used the directory containing the outer AppImage. Assets existed inside the
   payload, and the extracted executable passed the prerequisite self-test.
3. Extracted safe-mode desktop startup timed out without `boot-ready`. The loader
   requested unversioned GTK/WebKit `.so` names absent on this runtime-only host.
4. A separate probe combining bundled libraries with host WebKit failed with
   `undefined symbol: g_variant_builder_init_static`. This establishes a library
   compatibility failure, not a complete causal explanation of GUI startup.
5. The executable requires `GLIBC_2.38`, contradicting the website's Ubuntu 22.04
   minimum (stock Ubuntu 22.04 has glibc 2.35).
6. Linux release automation validates extracted assets without requiring the
   finished AppImage to reach frontend readiness on a clean desktop.
7. `ffmpeg`, `secret-tool`, and a JACK client library were absent on this machine.
   CMake, Ninja, pkg-config, and VM/container tooling were also unavailable.
8. Audient iD14 MkII uses `snd-usb-audio`; ALSA/PipeWire enumerate it. Two-second
   simultaneous silent playback/discarded capture passed at 44.1/48 kHz using
   6 playback/12 capture channels. Audible routing, latency, sustained stability,
   and application recording remain `not_asserted`.

Temporary investigation evidence was retained under
`/tmp/openstudio-linux-audit-k_a2yupl/`; temporary files are not durable release
evidence. Archive future qualification results with the exact artifact hash.

## Work packages and acceptance gates

### 1. Runtime paths and embedded browser

- [x] Introduce a shared Linux running-executable/runtime location that resolves
  the payload, including AppImage and native package layouts; keep the outer
  AppImage identity separately for update transactions.
- [x] Audit resource lookup and helper-process spawning consumers, not just the
  main frontend entry point.
- [x] Load versioned GTK/WebKit runtime libraries without development symlinks;
  retain the pinned JUCE version and fail-closed dependency patch checks.
- [x] Use a coherent system GTK/WebKit/GLib/JavaScriptCore dependency set; avoid
  mixing an old bundled browser dependency subset with a newer host browser.
- [ ] Improve dependency diagnostics and regression coverage. Prerequisite
  success must not claim actual UI readiness.
- [ ] Normal/safe startup and every browser-backed window reach `boot-ready`.

### 2. Native Linux packages

- [x] Add `.deb` packaging with explicit runtime dependencies, app files,
  desktop/icon integration, project MIME registration, and version metadata.
- [x] Add `.rpm` packaging and equivalent Fedora integration/dependencies.
- [ ] Validate generated dependencies and dynamically loaded dependencies on the
  target distribution; never ship development packages to satisfy runtime names.
- [x] Install the distro FFmpeg/Secret Service helper dependencies for advertised
  workflows; keep optional AI setup separate and actionable.
- [ ] Preserve system audio configuration and existing PipeWire/JACK providers.
- [ ] Retain and qualify AppImage separately if it remains a published download.
- [x] Keep release-note validation mandatory before production packaging.

### 3. Package-aware updates and user data

- [x] Native-package update UI uses the appropriate package path, never writes
  package-managed files through the AppImage updater.
- [ ] Test upgrade, reinstall, uninstall, interrupted update, and project/preset
  preservation; maintain existing AppImage metadata compatibility.
- [ ] Test project double-click and filenames/locations containing spaces and
  non-ASCII characters; validate independent per-user state.

### 4. Clean-desktop installation qualification

- [ ] Pin supported versions/desktop variants and build baselines before claiming
  support. Initial candidates: Ubuntu 24.04/26.04, a supported Debian stable,
  current supported Mint, and a supported Fedora release. Verify exact versions
  and dependency availability; these are candidates, not qualification claims.
- [ ] Prepare clean desktop VMs with no developer dependencies and a standard user.
- [ ] Browser download → original file association → double-click installation
  with automatic dependency resolution → menu launch → reboot/relaunch.
- [ ] Verify network failure/interrupted install diagnostics and offline base-app
  startup; do not silently substitute CLI installation for the graphical gate.
- [ ] Test applicable Wayland/X11 sessions and representative display scaling.
- [ ] Record distro, desktop/software-center version, artifact hash, logs,
  screenshots, and actual `boot-ready`; repeat on this physical Ubuntu machine.

### 4a. Publisher identity, provenance and installer warnings

Added explicitly after the user's successful installation and warning report.
Store publication was already planned; local-installer publisher/trust acceptance
was not previously explicit and is now tracked separately.

Observed: Ubuntu App Center (`snap-store` revision 1419, version
`0+git.d2bdf905`) installed OpenStudio 0.1.04. The package database confirms
`install ok installed` and `Maintainer: OpenStudio <contact@openstudio.org.in>`.
The user reports that the app opened, with “Unknown publisher” and wording like
“could be unsafe” during installation. No named malware detection was reported.
The exact displayed warning text has not been captured.

The matching upstream implementation explains both labels:

- [Local package title](https://github.com/ubuntu/app-center/blob/d2bdf905/packages/app_center/lib/widgets/app_title.dart):
  `fromLocalDeb` does not populate the publisher; the widget then uses the unknown
  publisher label. Adding a Maintainer field or AppStream metadata alone cannot
  repair that local-file display in this App Center implementation.
- [Local package warning](https://github.com/ubuntu/app-center/blob/d2bdf905/packages/app_center/lib/deb/local_deb_page.dart):
  the local-package page always supplies the third-party warning and installation
  confirmation. It is a source/trust caution, not the result of a malware scan.

- [ ] Capture the exact warnings on supported desktop/software-center versions;
  distinguish local-source warnings, permissions and an actual threat detection.
- [x] Package and validate AppStream identity, developer/support links, desktop
  launcher association and license metadata. The local validator passes (one
  informational content-rating notice); this does not remove Ubuntu's warning.
- [ ] Add published release/catalog metadata and verify identity displays in each
  supported target software center.
- [ ] Establish production release signing-key ownership, protection and rotation;
  publish verifiable signed artifact hashes/provenance and the public verification
  information through the official release/download channels. A plain checksum
  does not authenticate the publisher by itself.
- [ ] Evaluate signed APT repository delivery and signed Fedora RPM/repository
  delivery for authenticated updates. Document initial trust setup, scoped keys,
  key rotation and package-manager UI behavior. This is delivery planning, not
  authorization to register accounts, publish a repository or install trust keys.
  [Ubuntu's verification model](https://documentation.ubuntu.com/security/software-integrity/archive-verification/)
  authenticates repository metadata and its package hashes; a local `.deb`
  installation does not gain that trust merely by containing a detached signature.
- [ ] Keep the direct-download double-click installer supported, with an accurate
  explanation of any OS-owned local-package caution. Do not promise universally
  warning-free local `.deb` installation or disable security checks to achieve it.
- [ ] Qualify the planned Snap Store installation with the real publisher account,
  listing and permissions. Seek Verified Publisher status only if eligible under
  [Canonical's policy](https://forum.snapcraft.io/t/verified-accounts/34002).
  Publication, verification and confinement review are separate outcomes; neither
  a badge nor a signature establishes absence of malware. A store installation
  avoids the local-`.deb` screen, but other permission warnings may remain.

Acceptance: users can identify the official publisher and supported delivery
channel; artifacts/updates have a documented verification path; each remaining
OS warning is understood and accurately documented. Warning-free local files
are not an acceptance promise the app can enforce.

### 4b. AppImage catalog rejection: published 0.1.03

Verified on 2026-09-30 against [catalog PR #9453 and the bot report](https://github.com/AppImage/appimage.github.io/pull/9453#issuecomment-5904726185).
The failed artifact is the public `OpenStudio-0.1.03-linux-x86_64.AppImage`,
not the locally qualified Ubuntu 26.04 native package. The
[catalog workflow at the tested commit](https://github.com/AppImage/appimage.github.io/blob/42fa154f971e1509320c2289c5b9b0c34b3ea8c3/.github/workflows/test.yml)
uses Ubuntu 22.04. Both our v0.1.03 release workflow and current release workflow
use Ubuntu 24.04 for `build-linux`; local qualification used Ubuntu 26.04.
None of those newer-host passes establishes catalog/Ubuntu 22.04 compatibility.

| Evidence | Interpretation |
| --- | --- |
| `GLIBC_2.38` missing from libc/libm | The loader cannot satisfy the executable's C-runtime requirements on the test host. |
| `GLIBCXX_3.4.32` missing from libstdc++ | The executable also requires a newer C++ runtime than the test environment provides. |
| `ALSA_1.2.10` missing from libasound | There is a separate ALSA library ABI mismatch; solving glibc alone is insufficient. This does not establish an Audient-specific driver failure. |
| Bundled JavaScriptCore, ICU, GLib, systemd, mount and SELinux libraries also require newer glibc symbols | The compatibility audit must include every bundled ELF dependency, not only OpenStudio. |
| Filename contains `linux` | Catalog naming warning, separate from the loader failure. Removing it was a proposed catalog fix; the current release retains `OpenStudio-<version>-linux-x86_64.AppImage` to preserve the published download contract. A renamed catalog artifact remains unqualified. |
| Catalog also applied `not-upstream` | The PR body cites the README phrase “community package,” which described the unsigned macOS v1 package. This appears to be a discovery heuristic false positive, not evidence of a third-party Linux binary. |

The observed failure occurs in the dynamic loader before application startup;
it does not prove an audio-engine crash. The AppImage catalog is a separate
publication path from Ubuntu App Center/Snap Store. Using the host C library is
not by itself a malware indication or a diagnosis of all portability problems;
its required ABI must match the supported baseline. Follow
[AppImage's build-baseline and dependency guidance](https://docs.appimage.org/reference/best-practices.html).

- [x] Build the application, helper executables and required native dependencies
  against an explicit older baseline compatible with the catalog's Ubuntu 22.04
  environment. Qualify toolchain/runtime requirements together; changing only the
  CI runner label or repacking the existing binary is not sufficient evidence.
- [x] Add a fail-closed ABI/dependency gate over the extracted final artifact:
  compare every ELF object's required `GLIBC`, `GLIBCXX`, `CXXABI`, `ALSA` and other
  versioned symbols with the declared target providers, and reject missing
  libraries. Include ONNX and other prebuilt dependencies. Do not treat a single
  maximum-glibc check as complete compatibility verification.
- [ ] Resolve the AppImage browser-runtime strategy on the clean baseline. Our
  local fix avoids mixing bundled browser libraries with host WebKit, but the
  resulting AppImage still requires the host GTK/WebKit stack. Unlike the native
  package, it cannot declare APT/RPM dependencies to provision that stack. Qualify
  a coherent baseline-built bundled stack or explicitly supported prerequisites;
  do not claim self-contained/catalog compatibility from the current host-only
  approach. Never substitute random libc/libstdc++/ALSA copies as a repair.
- [ ] Run the actual finished AppImage in an environment matching the catalog
  (Ubuntu 22.04, including its Firejail/desktop test path), plus the supported
  distribution matrix. Require main/detached `boot-ready`, audio and export checks;
  prerequisite-only success is insufficient. Retain hashes and loader logs.
- [x] Coordinate the future AppImage filename change across packaging, release
  upload/download paths, checksum/signature generation, updater metadata, tests,
  website and catalog discovery. Preserve already-published assets and old-client
  update contracts; do not simply rename the existing 0.1.03 download.
- [x] Clarify the README's macOS wording locally by removing “community” from that
  sentence; its unsigned-package warning remains. This is not yet published.
- [ ] After a corrected public artifact passes baseline qualification, request
  `/retest` on PR #9453 and explain the upstream-authorship wording to maintainers.
  No GitHub comment, retest, label change or publication was sent in this audit.

These expand the already-open build-baseline/AppImage qualification gates with
specific C++/ALSA/dependency checks and naming/authorship follow-up. The successful
local `.deb` remains a distribution-specific candidate, not a repair of the
public AppImage or proof of catalog acceptance.

### 5. Installed Release feature matrix

Inventory the mounted UI, action registry, manual, and native implementations.
Every advertised supported Linux workflow needs a test and evidence. Identify
existing incomplete features rather than treating inventory entries as proof.

| Area | Required coverage | Status |
|---|---|---|
| Transport/audio | Device/channel setup, play/stop/seek/loop, metronome, recording/monitoring/punch, sample-rate conversion | not_asserted |
| Editing | Import/waveforms, drag/drop, selection, move/trim/split, fades, takes, clipboard, snapping, undo/redo | not_asserted |
| Projects/recovery | Save/reopen, FX/media persistence, missing media, templates, autosave/recovery | not_asserted |
| Mixer/routing | Sends/buses/sidechains, input/track/master/monitor FX, meters, automation modes and persistence | not_asserted |
| MIDI | Devices, recording, piano roll, instruments, routing, sustain/note-off, no stuck notes | not_asserted |
| Plugins/scripts | Representative native VST3/CLAP/LV2, scan/load/editor lifecycle/state, JSFX and Lua | bounded native pass; Nekobi VST3 restore fail; full UI not_asserted |
| NAM/pitch | Models/IRs, presets, preview rollback, persistence, pitch edits, route/render invariants | not_asserted |
| Export | Formats/rates/depths, selected sources/stems, normalize/dither/tails, queue/cancel, file integrity | 35 native checks pass; full GUI queue not_asserted |
| Optional AI | Setup/retry/cancel, real supported model jobs, eligibility, import/play/save/undo; CPU/GPU separately | CPU helper jobs pass; installed GUI/GPU/quality not_asserted |
| Desktop UI | Menus/shortcuts/focus, scaling/resizing, dialogs, detached-window close/reopen | 42 native lifecycle checks pass; full interaction/scaling not_asserted |
| Updates | Correct package selection, integrity, upgrade/recovery | not_asserted |

- [ ] Run frontend unit/build/e2e tests; explicitly distinguish mocked Chromium
  coverage from installed native WebKit/bridge behavior.
- [x] Adapt Windows-specific harness paths/process options for Linux and reuse
  existing deterministic native regressions.
- [x] Run installed Release feature checks and persist machine-readable results.
- [x] Use representative real Linux plugins; synthetic fixtures do not qualify
  arbitrary vendor plugins or their editors.

### 6. Physical Audient and AI qualification

- [ ] Record/play real inputs in OpenStudio and confirm headphones/monitor routing.
- [ ] Exercise supported rates/buffers, ALSA and supported PipeWire/JACK paths,
  contention, reconnect, suspend/resume, and sustained sessions.
- [ ] Compare recording/playback/export routes; investigate route failures before
  changing DSP. Collect dropout/latency diagnostics and user listening verdicts.
- [ ] Qualify AMD acceleration separately with supported real model workloads;
  hardware enumeration does not establish inference support or quality.
- [ ] Keep subjective tone/pitch/noise/naturalness `not_asserted` until the user
  auditions and accepts the exact output. Work one audible issue per iteration.

### 6a. Audient iD14 MKII input investigation (2026-09-30)

User reports inability to use the interface, mainly its inputs. Current read-only
inspection distinguishes working OS enumeration from the failing app setup:

- **pass (enumeration):** USB `2708:0008`, ALSA card `iD14`, driver
  `snd_usb_audio`. `/proc/asound/card1/stream0` advertises 12 capture / 6 playback
  channels at 44.1, 48, 88.2 and 96 kHz, `S32_LE` carrying 24-bit samples.
- **pass (enumeration):** PipeWire exposes Audient capture and Mic/Line Input 1/2
  through the installed UCM split-PCM profile. The analog inputs correspond to
  hardware channels 0/1 (DAW labels 1/2), not the desktop surround labels in the
  raw USB channel map. This is not proof of a live microphone signal.
- **fail (app configuration):** the installed app log contains
  `AudioEngine: Error setting device: no channels`. Saved audio configuration
  specifies `deviceType="JACK"` with empty input/output names.
- **confirmed source-contract mismatch:** `SettingsModal.handleApplyTypeChange`
  sends empty device names with comments expecting defaults. The native
  `applyAudioDeviceSetup` copies those names and requests zero channels for each
  empty name. Failed changes also skip the frontend's device-list refresh.
  JUCE's ALSA backend emits `no channels` when neither direction opens.
  This is a strong lead matching the observed failure; a controlled installed-app
  reproduction is still required to establish the complete causal chain.
- **environment gap:** JACK2 client library is installed, but `pipewire-jack` and
  `pw-jack` are absent and no JACK server process was found. PipeWire running does
  not automatically make a client using JACK2's library connect to PipeWire.
  Our native package accepts the JACK2 client library as a dependency, so it must
  diagnose server/compatibility availability separately from library presence.

External evidence and applicability:

| Path | Evidence | Consequence for OpenStudio |
| --- | --- | --- |
| Direct ALSA in a DAW | [Ardour Audio/MIDI setup](https://manual.ardour.org/sessions-tracks/sessions/audiomidi-setup/) supports ALSA with separate input/output device selection. A [first-hand REAPER/Ubuntu Studio report](https://www.reddit.com/r/linuxaudio/comments/urfirs/audient_id14_with_ubuntu_studio/) records successful iD14 capture/playback with ALSA, but does not specify MKI vs MKII. | Test the actual Audient as both input and output and route analog 1/2 to mono audio tracks. Do not equate the family report with MKII certification. |
| PipeWire through JACK | [PipeWire's pw-jack documentation](https://docs.pipewire.org/page_man_pw-jack_1.html) explains selecting its JACK-compatible library. Its [Pro Audio documentation](https://docs.pipewire.org/page_man_pipewire-props_7.html) describes exposing/probing multichannel devices. | Qualify the compatibility library, audio profile and actual port connections; a JACK dropdown alone is insufficient. |
| MKII community experience | [First-hand iD14 MKII reports](https://www.reddit.com/r/linuxaudio/comments/1bdmopm/audient_id14_mk2_with_linux/) describe successful operation and Pro Audio improvements, alongside channel-balance and reconnect problems. | Treat reports as diagnostics to reproduce, not universal compatibility or instructions to force full output volume. |
| Linux input mapping | [Upstream ALSA UCM profile](https://github.com/alsa-project/alsa-ucm-conf/blob/master/ucm2/USB-Audio/Audient/Audient-iD14-HiFi-0008.conf) models the 12-channel capture stream and splits its first two channels into mono inputs. [Audient's MKII loopback instructions](https://support.audient.com/hc/en-us/articles/360055049331-ID14-Loop-back-Setup) identify inputs 11/12 as loopback. | Preserve full hardware-stream constraints while selecting analog input channels; do not mistake loopback for a microphone input. |
| Vendor mixer controls | [MixiD](https://github.com/TheOnlyJoey/MixiD) is an unofficial control-panel implementation with MKII support and incomplete readback/metering; its implementation can detach/re-attach the kernel driver. | Evaluate separately only if vendor routing controls are needed. It is not a prerequisite for fixing the app's empty-device configuration. |

Prioritized work:

- [x] Regress audio-system changes and fix default-device selection semantics;
  retain explicit disabled-input behavior, refresh enumeration after a failed
  switch, surface the native error and restore a usable last configuration.
  Native simulated-driver and browser tests pass; installed UI qualification
  remains under the physical-device gate.
- [ ] Detect unavailable JACK server/PipeWire compatibility and explain recovery;
  qualify a supported PipeWire/JACK setup without replacing the user's audio stack
  silently. Direct ALSA remains an independent path to test.
- [ ] Compare OpenStudio against Ardour or REAPER on this exact host/interface:
  same source, input, gain, rate and buffer, one DAW at a time. Start with a
  conservative 48 kHz / 256-sample test, then measure lower buffers. Record the
  settings and outcome; this comparison has not yet been run.
- [ ] Capture real analog input 1 and 2 separately and together; verify meters,
  mono/stereo assignment, arm/record, monitoring, saved-file playback and export.
  Separate DAW software monitoring from Audient hardware direct-monitor mixing.
- [ ] Check device contention, all supported rates, USB reconnect/suspend, channel
  map persistence and long sessions. Qualify ADAT/loopback separately if advertised.

Evidence snapshot: `output/linux-qualification/audient-research/` (device lists,
PipeWire device/status, USB formats and saved app device configuration). This
research did not record private audio or change audio profiles, drivers, firmware
or system packages. Physical signal and subjective audio quality remain
`not_asserted`.

### 7. Release automation and public documentation

- [ ] Install final native packages and launch the final AppImage in appropriate
  CI environments; require actual frontend readiness, not just extracted files.
- [ ] Gate release on deterministic tests plus clean-desktop and physical-machine
  evidence. Missing mandatory evidence blocks qualification.
- [ ] Update this manual, release checklist, and separate website repository:
  primary `.deb`/`.rpm` choices, tested versions, installation and support docs.
- [ ] Review the exact release range, write/validate release notes before building
  production artifacts, and verify published hashes/redirects/update metadata.

### 8. Ubuntu App Center / Snap Store (after Stage 1)

- [ ] Register the publisher/name, create Snap packaging and listing metadata.
- [ ] Qualify confinement, recording/audio-device access, external plugins/media,
  optional AI, credential storage, updates, and desktop/window integration.
- [ ] Complete interface/confinement reviews where required and repeat installed
  feature tests before store publication.

## Reporting and completion

Use `pass`, `fail`, `diagnostic_only`, and `not_asserted`. Include exact source,
package checksum, environment, test method, and limitations. A clean build,
mocked browser test, extracted-payload self-test, or short ALSA stream is not full
installation/application qualification. No release claims until required gates
pass. Do not claim subjective audio quality from metrics.

Implementation must preserve existing undo/redo, realtime safety, persistent
state contracts, and non-Linux behavior. Before a source-build manual handoff,
build `frontend/dist`, complete the CMake Debug build/copy, stop test servers,
and ensure `python build.py dev --run` needs no pre-running server.

## Implementation log

- 2026-09-30: saved the agreed plan and initial audit evidence; implementation
  started with runtime discovery, browser loading, and package foundations.


### Implementation checkpoint: 2026-09-30

- Saved candidate release notes in `docs/releases/0.1.04.md`, reviewed the exact
  `v0.1.03..9b8f219d52faebe0c26699a9ac2848523ad01575` diff, and explicitly
  separated that committed Store-automation work from uncommitted Linux changes.
  Validation passed before the local Release build. Nothing was published.
- Implemented shared Linux runtime location via `/proc/self/exe`, applied the
  fail-closed patch to pinned JUCE 9.0.1 runtime SONAME loading, added Linux startup
  diagnostics, and removed mixed browser-library bundling from AppImage packaging.
- Added native package construction and dependencies, desktop/MIME integration,
  package-channel markers and manual native-package updates. RPM implementation
  exists but has not been built or installed on Fedora. Native updates deliberately
  do not download the AppImage advertised by the existing public update feed.
- Enabled Linux MP3 decoding after native render checks showed exported MP3 files
  could not be read back. Debug render results: **35 pass**, **1 not_asserted**
  (Windows-only isolated-plugin render). No subjective-quality claim.
- Frontend build and **2,318 unit tests passed**. The native update dialog passed
  a Chromium check at 1280/640-pixel widths, including accessible controls, bounds
  and keyboard focus. Four native-package fixture tests passed; fixtures alone
  do not qualify the actual app package.
- CMake Debug and Release builds completed. **Zero-warning build gate remains
  open**: GCC 15 reports first-party unused/signedness warnings and dependency
  diagnostics. Debug native window readiness passed all 44 checks, but its console
  also emitted high-shelf frequency assertions (`juce_IIRFilter.cpp:240`). Those
  assertions need a separate sample-rate/initialization investigation; window
  readiness is not proof of DSP correctness.
- Local outputs: `dist/linux/OpenStudio-0.1.04-ubuntu-26.04-amd64.deb` and
  `dist/linux/OpenStudio-0.1.04-linux-x86_64.AppImage`. The native package's generated
  dependency floor is `libc6 >= 2.43`; **do not distribute this build as compatible
  with Ubuntu 24.04, Debian or Mint**. Build those candidates on their qualified
  baselines. `apt-get -s install` accepts the Ubuntu package here with only the new
  `openstudio` package added. This simulation did not install the application.
- CI now constructs and installs an Ubuntu native package, runs packaged native
  window/render checks, and exercises the final AppImage launcher. These workflow
  edits have not run on GitHub yet and do not replace clean-desktop qualification.
- Evidence is under `output/linux-qualification/`; full build logs remain in
  `/tmp/openstudio-final-debug-build.log` and `/tmp/openstudio-release-build.log`.
  The checkout manual describes native installers as development candidates.
  The sibling website repository is unavailable in this workspace, so published
  download choices and compatibility claims have not been changed.
- Graphical `.deb` handling here points to `snap-store_snap-store.desktop`.
  Actual standard-user installation, authentication, menu launch, upgrade/removal,
  clean-desktop distro coverage and physical Audient recording/listening remain
  unqualified. The updated prerequisite script also installs `python-is-python3`;
  this host currently has `python3` but no `python` command.


### Release-payload results and next fixes

Tests below use the actual files extracted from the generated `.deb`, **not an
installed system package**. Retain the failures alongside subsequent results.

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Startup asset discovery, including AppImage-style `argv[0]` | pass | `native-release/qualification.json` |
| Native Release main and detached windows on idle desktop | pass, 42 checks | `native-release-idle/window-lifecycle.json` |
| Main-window readiness while running the heavy engine suite concurrently | fail | `native-release/window-lifecycle.json`; only main readiness failed; idle rerun does not erase this |
| Offline render/export | pass, 35 checks | `native-release/render-export.json`; isolation remains not_asserted |
| Runtime safety/recovery fixtures | pass, 219 checks | `native-features/runtime/result.json`; hardware/listening not asserted |
| General native engine suite | fail, 35/39 suites passed | `native-features/engine.json` |
| Plugin scan | pass with zero installed candidates | `native-features/plugin-scan.json`; does not qualify vendor plugins |
| Package dependency resolution | pass on this prepared host | `deb-install-simulation.txt`; no installation occurred |

Prioritize these findings before claiming feature verification:

1. Investigate `built_in_eq_shelf_slope_fixture`: high-shelf response stayed near
   0 dB instead of approaching the requested +8 dB. Compare probe band semantics,
   sample rate and production coefficients before changing DSP.
2. Trace `instrument_fallback_synth_fixture`, `instrument_basic_sampler_fixture`
   and `saved_project_midi_reload_playback_fixture`: MIDI events were built and
   instrument/sample state was present, but measured output peaks were zero.
   Distinguish harness preparation/routing from actual user playback; do not claim
   a production root cause until reproduced through the installed app.
3. Diagnose main-window startup under concurrent work. Preserve boot-ready and
   watchdog evidence; do not simply increase timeouts to turn this result green.
4. Investigate the Debug high-shelf assertions and clear the compiler-warning gate.
5. Complete administrator-authenticated graphical installation and project MIME
   launch on this host, then clean-desktop install/upgrade/removal on each chosen
   distribution baseline. Repeat feature checks through the installed launcher.

The revised AppImage initially failed to find ONNX after linuxdeploy rewrote its
RUNPATH. Packaging now also supplies the pinned private ONNX runtime in `usr/lib`
and runs the finished AppImage's prerequisite self-test before reporting success.
The original failed artifact result remains in `appimage-release/`; later results
must refer to the corrected artifact and its own checksum.

Corrected final AppImage: startup, alternative argv[0] and all 42
Release window checks passed on this host (`appimage-release-fixed/`).
This used the actual AppImage launcher, not only an extracted binary.
Artifact hashes are recorded in `output/linux-qualification/artifact-sha256.txt`.
A copy of the Ubuntu 26.04 candidate `.deb` is in `~/Downloads/` for the
graphical installation test. No system installation or publication occurred.


### User-installed checkpoint

The user subsequently confirmed that the Ubuntu 26.04 `.deb` installed and the
app opened. Read-only inspection confirms `openstudio` 0.1.04 is installed. Mark
this physical-host installation/opening **pass (user-reported)**; do not extend it
to clean-desktop installation, all features, reboot, upgrade/removal, project MIME
launch, or the other distributions. Prior statements that no installation had
occurred describe the earlier packaging checkpoint. Public publication remains
unperformed. Publisher/trust warnings are tracked explicitly in work package 4a.

Next sequence: fix audio-system/device selection and qualify Audient analog capture;
then reproduce/fix EQ and MIDI failures through the installed app;
investigate loaded-startup reliability and assertions; finish the installed
feature/device matrix; qualify package lifecycle and clean distro baselines;
complete production trust/download/CI gates; then qualify and publish the Snap.
Signing/provenance design can proceed alongside application verification.


### Continuation checkpoint: audio switching, sampler and package identity

Changes remain uncommitted/unpublished. The installed 0.1.04 process has not been
replaced or stopped by this continuation.

- **pass:** device changes explicitly distinguish default devices from disabled
  devices. Invalid requests and missing JACK ports are rejected before changing
  the current device. Failed opens roll back, including identical device names
  across different backends; the frontend refreshes the actual configuration and
  reports the native error. A device-less snapshot now reports zero channels.
- **pass:** directly prepared TrackProcessors publish rate/block metadata. This
  corrects the reproduced zero-output sampler path, where getSampleRate() had
  remained zero and playback advanced through the sample incorrectly. MIDI
  fixtures now obey the track's prepared block size, and engine reports include
  the device rate/block context.
- **pass:** the next Debug engine run passed 39/39 suites. An unchanged Release
  baseline and the preceding Debug run both reproduced only the sampler failure
  (38/39), so the earlier EQ/fallback/reload failures must not be described as
  proven production fixes. Retain those initial failures and qualify device
  contexts/installed behavior. Results: `audio-fix-engine-debug2.json` and
  `audio-fix-engine-release-baseline.json` in `output/linux-qualification/`.
- **pass:** 2,318 frontend tests; the browser settings switch/error recovery test;
  235 Debug runtime/safety checks, including 12 device transaction checks and two
  direct-track preparation checks; native packaging fixture tests.
- **pass, limited hardware scope:** the opt-in `--audio-device-probe` harness used
  the app's JUCE device transaction and AudioRecorder writer for ten seconds each
  at 44.1/48 kHz, 512 samples. The direct Audient ALSA route opened with 12 capture
  and 6 playback channels; callbacks and readable two-channel WAVs passed with
  zero reported xruns. It used silent outputs and did not load/save user audio
  settings. Evidence: `audient-direct-capture/result.json` and the WAV files.
- **diagnostic_only:** captured peaks were about 0.00009 and 0.00107. No known
  physical test source has been identified; source routing, the full track graph,
  monitoring quality, round-trip latency and sustained stability are not asserted.
- **pass:** native packages now include AppStream metadata and a package revision.
  Revision 1 sorts above the already-installed unrevisioned 0.1.04, enabling an
  actual package upgrade without pretending this is a new public app release.
- **open:** removed the observed first-party unused/signedness compiler warnings;
  upstream JUCE/Signalsmith/YSFX warnings remain. NAM tone lookup frequencies are
  bounded below Nyquist, but the added 8-kHz diagnostic exposes other NAM/effect
  edge-filter assertions. Its finite-output check is not proof those assertions
  are resolved. Debug fault-injection WAV assertions and headless message-queue
  assertions are also retained in logs, not waived as clean execution.
- **implemented, remote run pending:** CI now includes sequential native runtime
  and engine feature qualification and AppStream validation. The local runner's
  new `--features` switch uses fresh output directories to retain failure evidence.

Next installed gate: upgrade to the rebuilt native package, test the actual audio
settings UI, record a known source on analog inputs 1/2, and audition monitoring
and saved/exported audio. Continue clean-desktop Ubuntu/Debian/Mint/Fedora testing,
external plugins/AI, sustained/reconnect/suspend testing, and provenance/signing.
Snap remains after those installer/feature gates. No VM/container manager or
Snapcraft is currently available here; the separate website checkout is absent.


Final package checkpoint for this continuation:

- Candidate: `OpenStudio-0.1.04-1-ubuntu-26.04-amd64.deb`, copied to Downloads;
  package database still contains 0.1.04 until the user completes the upgrade.
- **pass:** the new extracted Release package payload passed 42/42 window checks,
  35 render/export checks, 234 runtime checks and all 39 engine suites. Windows-only
  plugin isolation remains one explicit `not_asserted` render check. Device context
  for the engine fixtures is recorded in its JSON; this is not all live-device
  contexts or every user-facing feature.
- **pass:** APT simulation selects an upgrade from 0.1.04 to 0.1.04-1, with no
  additional package installations/removals. The real graphical upgrade, reboot
  and project-preservation checks remain pending.
- **pass:** current frontend assets were built and copied into Debug and Release;
  Debug CMake build completed. No Codex-started Vite/harness process remains and
  port 5183 is clear; no pre-running frontend server is required. This host still
  has `python3` without a `python` command; the revised prerequisite script includes
  `python-is-python3`, but has not been rerun with administrator authentication.
- Evidence: `audio-fix-native-release/qualification.json`, its individual reports,
  `audio-fix-deb-upgrade-simulation.txt`, `audio-fix-build-evidence/`, and
  `audio-fix-artifact.json`. These qualify the extracted payload, not an upgrade
  into `/usr/lib/openstudio` or other distributions. The older local AppImage
  predates these audio changes and is not the handoff artifact.


### Continuation checkpoint: ABI gates, revision 2 and longer device capture

All changes remain local and unpublished. Evidence below does not replace the
clean-desktop or real-source acceptance gates above.

- **pass:** corrected out-of-Nyquist filter preparation in NAM's embedded delay,
  chorus and reverb, the standalone saturator, and NAM edge-filter cutoff changes.
  Saved parameter values remain unchanged. The Debug regression exercises 8,
  22.05, 44.1 and 48 kHz plus cutoff smoothing and explicitly rejects assertions.
- **pass:** input/track FX setup preserves the actual bus count of MIDI-only
  plugins. Previously it proposed one input/output bus to a zero-bus plugin and
  triggered a JUCE assertion. Both paths now have regression coverage.
- **pass:** the bounded five-value tuner median implementation removes its GCC
  array-bounds diagnostic. The final incremental Debug and Release compilations
  emitted no warnings. This is not a clean rebuild of all vendor dependencies;
  previously recorded dependency warnings remain unresolved.
- **pass:** 237 Debug runtime checks. Remaining Debug WAV assertions occur in the
  deliberately injected seek/write-failure tests; filter and bus assertions no
  longer occur. No subjective audio-quality conclusion is drawn.
- **pass:** revision 2's extracted Release payload passed 42 normal window checks,
  236 runtime checks, all 39 engine suites and 35 render/export checks. The
  Windows-only isolation render check remains `not_asserted`. Safe-mode startup passed another 42 window checks. A separate 42-check
  lifecycle run also passed while the engine suite was active. This does not prove
  the root cause of the original intermittent startup/EQ failures is resolved.
- **pass, bounded scope:** two minutes each of direct Audient ALSA capture at
  44.1/48 kHz, 512 samples, zero reported xruns. The WAV frame counts exactly match
  callback frames (5,292,544 / 5,761,024). Peaks stayed below 0.001, so physical
  source identity, monitoring/listening, latency and full track routing remain
  `not_asserted`. Ten-second captures at 128 samples also passed at both rates with zero reported
  xruns. This is bounded I/O testing, not long-session or round-trip latency
  qualification.
- **pass, discovery only:** the actual Ubuntu `mda-lv2` 1.2.10-2build2 package was
  downloaded and extracted into the evidence directory. OpenStudio discovered
  MDA Delay as a stereo LV2 effect. The DISTRHO 3BandEQ, MVerb and Nekobi plugins also passed discovery in both
  CLAP and VST3 formats (six additional probes). None were installed into the
  user's plugin directories; processing/editor/state recall remain open.
- **pass:** nine native-package/ELF regression tests, release-note validation and
  tests, updater-manifest tests, shell syntax, and actionlint on both workflows.
  The new ELF gate tests real missing providers and incompatible symbol versions,
  records every object's hash/requirements/loader output, and rejects empty audits.
  It passes the revision 2 payload on this host and rejects the earlier newer-host
  payload against the glibc 2.35 ceiling. It does not inspect arbitrary dlopen
  plugins or prove Ubuntu 22.04 execution from an Ubuntu 26.04 run.
- **implemented, remote run pending:** Linux verification/release jobs now build
  on Ubuntu 22.04; require native package installation and window/render/runtime/
  engine checks; enforce the glibc 2.35 baseline; and test the finished AppImage.
  Normal/safe native-window modes are separate gates. New AppImages omit `linux`
  in their filename; upload paths, checksums and appcast/manifest generation were
  updated together. Existing release assets/repair scripts and stable AppImage
  contracts are retained. Packaging discovers only a fresh isolated output.
- **implemented, production verification pending:** pinned GitHub build provenance
  attestation for Linux installers, plus native `.deb` assets and checksums in the
  release workflow. This is not RPM/APT signing, Snap publisher verification, or
  removal of Ubuntu's local-file warning. No attestation was published locally.
- **pass, local website only:** recovered the separate `OpenStudioWebsite`
  repository as `../openstudio-website`, corrected unsupported Ubuntu 22.04 and
  warning-free AppImage claims, and identified native packages as unreleased.
  Build and lint passed. The full website run passed 197 tests and failed one
  after generated artwork was restored during validation; rebuilding consistent
  artwork and rerunning that test plus relevant release/SEO checks passed all 7.
  The website's older Playwright build required its Ubuntu 24.04 browser override
  on this Ubuntu 26.04 host. No website changes were deployed.
- **qualification limitation:** WebKit data/cache now use separate XDG directories
  per test and existing output directories are rejected to preserve evidence.
  Pinned JUCE 9.0.1 reads `~/.config/user-dirs.dirs` for application config and
  ignores `XDG_CONFIG_HOME`; configuration, plugin-list state and system audio are
  still shared. Do not call these clean-user or clean-desktop runs. The initial
  report's config-isolation metadata was corrected after this source/runtime check.

Candidate: `~/Downloads/OpenStudio-0.1.04-2-ubuntu-26.04-amd64.deb`, SHA-256
`b1266bc299f903405d9f699b6bf6f648d218c8329d5470419fcffd9f0ff2caf4`.
APT simulation upgrades the installed 0.1.04 to 0.1.04-2 without adding/removing
other packages. The actual graphical upgrade and installed-feature tests remain
pending administrator authentication. Revision 2 supersedes the earlier -1
handoff; it is still only a local Ubuntu 26.04 candidate.

Evidence: `output/linux-qualification/remaining-native-release/`,
`remaining-loaded-startup/`, `remaining-safe-startup/`, `remaining-runtime-debug2/`,
`audient-sustained-120s/`, `external-plugins/`, `remaining-native-abi.json`,
`current-payload-baseline-abi.json`, and `remaining-upgrade-simulation.txt`.
The complete feature matrix is not certified by these deterministic checks.

Remaining dependencies on the machine/owner:

1. Complete the revision 2 graphical upgrade, provide a known physical input on
   Audient analog input 1/2, and audition recording/monitoring/export. Schedule
   unplug/reconnect and suspend/resume while work is saved; these were not forced.
2. Provide clean desktop test hosts or administrator-configured VM/container
   tooling. This host has no such manager and a rootless `unshare` attempt fails
   with `Operation not permitted`. Debian/Mint/Fedora and Ubuntu 22.04 desktop
   installation, upgrades/removal, Firejail and older-baseline builds remain open.
3. Identify production Linux signing ownership and the Snap publisher account.
   Snapcraft is absent, and no Snap confinement/package/store qualification has
   occurred. Preserve Stage 2 ordering after installer/features qualification.
4. Qualify external plugin processing/editors and real optional AI workloads.
   The app's managed `stem-runtime`, `diffusers-audio-runtime` and model directories
   are absent; unrelated user model caches are not an installed-app runtime pass.
5. Review/commit changes, run the revised CI, finish the mandatory release gates,
   publish qualified artifacts/website metadata, and only then request catalog
   retesting. No push, tag, release, store submission or external comment occurred.

Final handoff checks: frontend build and CMake Debug build/copy completed; Debug,
Release and `frontend/dist` contain the same frontend entry file. No task-owned
Vite, test browser, native harness or port-5183 server remains. No pre-running
server is required for the development command once the documented Python
prerequisite is installed. The current handoff uses the downloaded `.deb`.


### 2026-09-30 continuation: baseline build, real plugins and AI

This checkpoint supersedes the earlier statement that clean virtual machines
cannot run here. `/dev/kvm` is accessible through the user ACL. Locally extracted
QEMU now boots an isolated Ubuntu 22.04 VM without host administrator changes;
Debian 13 and Fedora 44 desktops are being prepared. These are real guest kernels,
not PRoot. Desktop qualification is pending until results below say otherwise.

- **pass:** separate Ubuntu 22.04 build and installed ELF audits meet glibc 2.35.
  Exact application SHA-256:
  `c10a8b20752144092930e35070601e507030dddf7c45e480656f9087e1d5e42b`.
  On the physical Ubuntu 26.04 host this binary passes 42 window checks, 35 render
  checks, 236 runtime checks and all 39 engine suites. Subjective audio quality is
  `not_asserted`. Evidence: `jammy-binary-host26/` below the qualification root.
- **candidate:** `dist/linux-jammy/OpenStudio-0.1.04-3-ubuntu-22.04-amd64.deb`.
  Target-library dependency metadata is produced inside Ubuntu 22.04; host archive
  assembly does not recompute dependencies. New `--stage-only` support retains
  that metadata. Failed archive creation preserves an existing installer.
  PRoot command-line install, reinstall, removal and reinstall preserve project,
  audio and preset sentinels. This does not certify graphical installation or
  upgrades from a released version. Evidence: `ubuntu2204/package-lifecycle.json`.
- **pass, bounded:** the corrected-name AppImage built from that older binary
  passes its ELF gate, startup, 42 window and 35 render checks on Ubuntu 26.04.
  It still requires the host GTK/WebKit stack and is not a self-contained clean
  desktop installer. Catalog acceptance and Firejail remain unverified.
  Evidence: `jammy-appimage-host26/`. No public artifact was replaced.
- **fail, unresolved:** PRoot's older userspace NAM suite fails its exact-silence
  invariant (right-channel residual about 1.53e-10). The same binary passes on the
  physical host. An unsuccessful DSP experiment was fully reverted; no assertion
  was relaxed. A real Ubuntu 22.04 VM will distinguish PRoot from a real OS issue.
  Evidence: `ubuntu2204/nam-detail.json`; all other NAM conditions passed.
- **implemented and tested:** CLAP parameter events now reach the plugin; state
  recall refreshes wrapper parameters; stepped values respect plugin metadata;
  plugin editor timers and per-instance host callbacks are available. Startup
  logger ownership is corrected. Real 3BandEQ, MVerb and Nekobi CLAP processing,
  state and two editor cycles pass with no final assertions/leaks. VST3 3BandEQ,
  VST3 MVerb and LV2 MDA Delay pass bounded processing/state/editor checks.
  This is six combinations, not universal plugin compatibility.
- **fail, unresolved:** Nekobi VST3 becomes silent after state restore in five
  rate/block combinations while its CLAP build passes. Repeated attempts stopped;
  the user has no independent known-good VST3 instrument. VST3 headless teardown
  also reports host-context/reference diagnostics. Do not mark these closed.
  Evidence: `external-plugins/processing-debug-final/` and
  `external-plugins/clap-final-cleanup/`.
- **pass, bounded AI execution:** the verified published CPU runtime produces six
  finite stems from a synthetic three-second input. Its Python 3.10 interpreter
  cannot run current music generation. The runtime workflow now defaults to
  Python 3.11.15 and fails closed on incompatible interpreters; the published
  runtime has not yet been rebuilt/replaced.
- **pass, bounded AI execution:** an isolated official Python 3.11.15 runtime,
  exact Linux requirements and the already cached pinned ACE-Step model complete
  CPU text-to-audio, variation, inpainting and continuation. Output format,
  duration, finite samples and unchanged source files pass. Installed-app bridge,
  GUI import/undo, GPU and subjective quality remain `not_asserted`.
  Evidence: `ai-managed/result.json`, `ai-python311/workflows/result.json`.
- **pass:** six native-package, five ABI and three AI dependency regressions,
  workflow lint and release-note validation. Debug build and asset copy completed
  after removing the unsuccessful DSP change. Clean full-build dependency
  warnings remain open; incremental warning-free builds do not close them.

The user's machine still reports installed package 0.1.04. They have no live
Audient source connected, so physical input identity, monitoring/listening and
round-trip latency remain `not_asserted`. No administrator password, existing
projects, physical audio device attachment or host package state was changed.
No push, tag, release, store submission, website deployment or catalog comment
was performed. Signing ownership and Snap publisher identity remain required
before production publication. All evidence paths above are under
`output/linux-qualification/` and are local, not published artifacts.


VM desktop checkpoint: Fedora 44 RPM 0.1.04-3 was built inside the Fedora guest
from the Ubuntu 22.04 application payload. GNOME Software's local RPM handler
installed it after a normal graphical administrator-password prompt. Its
“Potentially Unsafe — Provided by a third party” warning remains visible.
Evidence: `fedora44-vm/installer-before.png`, `installer-authentication.png`,
`rpm-build.log`. This cloud-image GNOME VM is not a stock Workstation ISO install.
The RPM is retained in `dist/linux/`; installed feature checks are in progress.

Ubuntu 22.04 and Debian 13 cloud kernels lacked DRM drivers; standard distro
kernels were added only inside the guests. Fedora needed the PackageKit backend
added to the cloud desktop. These are test-environment prerequisites, not app
installer fixes. Ubuntu's default GDebi handler opened the DEB but exited on
Install with “Refusing to render service to dead parents.” GNOME Software also
stalled in the initial SSH-launched attempt. The Ubuntu package was subsequently
installed with apt for independent feature/NAM investigation. Graphical Ubuntu
installation remains unqualified; do not relabel the apt result as a GUI pass.


### Real-VM investigation and corrections

- Fedora 44 installed revision 3 passes native windows, render/export and runtime
  checks. Its first engine failure was a missing NAM **test fixture**, not a model
  processing failure. Supplying the pinned NAM Core example models gives 39/39
  engine suites. `fedora44-vm/installed-with-fixtures/qualification.json` records
  the exact model hashes; `installed-qualification/` retains the initial failure.
- The runner now accepts `--nam-fixtures`; it copies those QA models into the
  evidence tree and runs the engine there. Production inference does not consult
  those files. Linux release/verify CI now passes its fetched dependency path
  explicitly instead of relying on the source checkout being the current folder.
- Debian 13's installed revision 3 passes native windows and runtime checks.
  With NAM fixtures supplied, only the EQ shelf fixture fails: its 14 kHz probe
  was invalid against the virtual ALSA default's 8 kHz sample rate. The isolated
  EQ fixture now prepares at 48 kHz, with unchanged response assertions. This is
  a test correction, not a claim of a DSP fix at untested rates.
- Ubuntu 22.04 real KVM reproduces the exact-silence NAM failure, ruling out PRoot
  as the sole cause. A standalone reproducer identifies the Precision clipping
  cell's constant-folded bias subtraction: the older runtime `tanhf` differs by
  one ULP (raw residual 1.86264514923e-9), while the same binary returns zero on
  Ubuntu 26.04. The zero-input branch preserves analytic zero and continues the
  existing attack/bright/DC filter state; it does not silence tails or relax the
  exact-zero assertion. Verification of this correction is in progress.
- Revision 4 upgrades revision 3 with apt inside Ubuntu 22.04. Its native window,
  runtime and EQ checks pass; the pre-correction NAM check still fails. Revision 5
  carries the targeted Precision correction and must be qualified separately.
- Mint 22.3's official ISO checksum and signing fingerprint were verified. The
  stock Cinnamon live session opens the DEB in its default Captain handler.
  Launching the file manager through SSH caused authorization simulations to
  cancel; launching it from the desktop's keyboard shortcut reaches the normal
  dependency-confirmation and installation UI. No desktop policy was bypassed.
  Live-session results do not qualify installed-system reboot/upgrade persistence.


### Final revision 5 deterministic results (2026-09-30)

Candidate DEB: `~/Downloads/OpenStudio-0.1.04-5-ubuntu-22.04-amd64.deb`, SHA-256
`2c3421be5c16d90f8f44631d02622b59624bd67e8d23f58027945e390a86ed7e`.
The application ELF is
`6d3691a5c4e707edb6291b3bfbb1938eaa8a4b739574455e64a907422dfc1092`.
The matching Fedora 44 RPM is under `dist/linux/`. These are local, unsigned
qualification candidates; no stable release asset or website metadata changed.

| Environment | Installed revision 5 native checks | Window checks | Installer/lifecycle evidence |
|---|---|---|---|
| Ubuntu 22.04 KVM + GNOME | pass: startup, 236 runtime, 35 render, 39 engine | pass: 42 after reboot | apt upgrade/remove/reinstall; sentinel preservation; GNOME Software graphical remove/reinstall revision 5 after association/network setup |
| Debian 13 KVM + GNOME | pass: startup, 236 runtime, 35 render, 39 engine | pass: 42 after reboot | apt upgrade/remove/reinstall; sentinel preservation; GNOME Software graphical remove/reinstall revision 5 |
| Fedora 44 KVM + GNOME | pass: startup, 236 runtime, 35 render, 39 engine | pass: 42 after reboot | graphical revision 3 install with password; dnf upgrade/remove/reinstall revision 5; sentinel preservation |
| Mint 22.3 official Cinnamon live ISO | pass: startup, 236 runtime, 35 render, 39 engine | pass: 42 | Captain graphical revision 3 install; apt upgrade to revision 5; installed-system reboot not_asserted |

All render runs retain the Windows-only isolation check as `not_asserted`.
The Precision exact-silence gate now passes on real Ubuntu 22.04 without weakening
its assertion. The EQ fixture correction passes on the 8 kHz virtual-device
configuration. Reference models are explicit QA inputs with recorded hashes.
All subjective tone, pitch, noise and recording quality remain `not_asserted`.
No physical Audient signal was supplied; these VM results do not qualify it.

Evidence: `<distro>-vm/installed-revision5/`, `post-reboot-window/`,
`lifecycle.json`, `reboot.json`, Mint `installer-success.png` and
`revision5-windows/`, `revision5-abi.json`, and `revision5-appimage-host/` under
`output/linux-qualification/`. Native removal tests preserve byte sentinels, not
proof of a valid project's reopen/save behavior. VM kernel/desktop setup and all
failed earlier attempts remain retained separately.

The latest AppImage also passes its ABI gate and 42 native window/35 render checks
on Ubuntu 26.04. The host GTK/WebKit requirement and catalog/Firejail gate remain.
Debug build/copy completed; no pre-running server is required for
`python build.py dev --run`, and port 5183 is clear. Package/ABI tests (11), AI dependency tests (3), release
notes and workflow lint pass. Release-note tests report three pass and ten
platform/environment skips; do not count those skipped cases as tested.

Still open before declaring the entire Linux release complete:

1. Qualify stock Ubuntu/Debian desktop double-click flows, installed Mint
   persistence, additional supported versions, offline/failed/interrupted install
   and update recovery, and required display/session combinations.
2. Finish the full installed editing/project/automation/UI feature matrix;
   deterministic native checks do not cover every advertised user workflow.
3. Investigate Nekobi VST3 state-restore silence and VST3 teardown diagnostics;
   CLAP passes. Bounded startup stress now passes (see final checkpoint); retain
   the earlier intermittent failure for investigation under longer/concurrent
   workloads. Outstanding clean-build vendor warnings remain.
4. Connect a real Audient source for channel identity, track recording/monitoring,
   listening and latency; then physical reconnect/suspend and longer sessions.
5. Verify installed AI GUI import/save/undo and GPU workloads, package/publish the
   corrected Python 3.11 runtime, and collect subjective auditions.
6. Establish production signing/publisher ownership, commit/review and run CI,
   publish qualified packages and website metadata, qualify the catalog path and
   request retesting only after publication. Then complete Snap packaging,
   confinement, publisher verification and publication as Stage 2.


Post-reboot file-manager check: Ubuntu 22.04 GNOME actually opens the DEB in Archive
Manager, despite the earlier SSH-session MIME query preferring GDebi. Debian's
local GNOME desktop opens GNOME Software. Record the real desktop activation,
not just `xdg-mime` run through SSH: XDG desktop-specific overrides matter.
Evidence: `ubuntu2204-vm/default-deb-opens-archive.png` and
`debian13-vm/default-deb-opens-software.png`. The owner was asked whether desktops
requiring one-time “Open With Software Install” guidance should be excluded from
the guaranteed double-click support list or documented with that prerequisite.
**Owner decision:** document the one-time Open With step. The app manual and
website getting-started guide now explain selecting Software Install, setting
the default association, installing/upgrading, and the prerequisite when no
package installer exists. The DEB cannot repair its own handler association
before being opened; unconditional zero-setup double-click support is not claimed.

Debian 13's GNOME Software subsequently removed and reinstalled revision 5 through
the local desktop, including its administrator-password dialog. The package
database confirms `install ok installed`, version `0.1.04-5`. Evidence:
`debian13-vm/revision5-gui-reinstall-success.png`,
`revision5-gui-install-authentication.png` and `revision5-gui-reinstall-dpkg.txt`.
Runtime dependencies were already present; this is a graphical reinstall check,
not evidence of a fresh stock-desktop install. GNOME Software still displays
“Potentially Unsafe / Provided by a third party.” Local package views may show a
generic icon/license information instead of the installed AppStream details;
metadata presence alone does not establish software-center presentation.

Ubuntu 22.04 also passed graphical removal/reinstallation of revision 5 after
setting Software Install as the default handler in Files. A subsequent actual
double-click opened the installer. The cloud image's network was managed by
networkd, so GNOME Software considered it offline and queued installation; moving
the guest's netplan renderer to NetworkManager restored its desktop online state.
The queued background operation lacked interactive authorization. A fresh local
desktop launch then displayed the normal password prompt and installed the DEB,
including FFmpeg dependencies removed by Software's uninstall operation. A
pre-existing guest kernel notice appeared through needrestart and was dismissed.
These are VM setup details, not a requirement to change networking on users'
machines. Evidence: `ubuntu2204-vm/revision5-gui-reinstall-success.png`,
`revision5-gui-install-authentication.png`, `revision5-gui-reinstall-dpkg.txt`,
`set-default-software-install.png`, and `desktop-network-setup.log`.

Repeated installed-app startup/window checks: **pass, five cycles per environment**
on Ubuntu 22.04, Debian 13, Fedora 44 and Mint 22.3 live (20 cycles total). Each
cycle checks the startup prerequisite report, runtime-path spoof handling and all
42 main/detached WebView lifecycle assertions in normal mode, with fresh WebKit
data/cache. Runs are sequential within a guest; Debian/Fedora/Mint ran concurrently
on the host. Evidence: each `<distro>-vm/revision5-startup-stress/summary.json`
and its per-cycle reports. This does not prove the absence of the earlier
intermittent startup failure or qualify arbitrary long sessions/concurrent engine
workloads; no subjective audio claim follows from these window checks.

Offline installed-app startup: **pass on Ubuntu 22.04**. The QA VM's virtual
network link was disconnected before launching the installed application; the
guest recorded NIC carrier `0`. Startup prerequisites, runtime-path spoofing and
all 42 normal-mode window lifecycle checks passed. The network was restored after
the test. Evidence: `ubuntu2204-vm/revision5-offline-window/network.json` and
`checks/qualification.json`. This verifies offline base-app/window readiness,
not AI downloads, unavailable network resources or every editing workflow.

Final handoff: updated the manual and website getting-started guide with the
owner-approved one-time Open With/default-association instructions; website
TypeScript checks and release-notes validation pass. Temporary VM test services
and the local download server are stopped, with disks/reports retained for later
qualification. No production website, GitHub release or store entry was published.

## 2026-10-01: Linux mixer controls and browser coverage

The reported sideways fader was reproduced using the host's actual WebKitGTK
2.52.6. Its native range control ignored the vertical writing mode: the input
occupied 129 horizontal pixels inside an 18-pixel slot, and clicking low or high
gave the same value. The newer Playwright WebKit did not reproduce this failure.
Startup/window readiness alone had missed this interaction defect.

The shared Slider now explicitly rotates a horizontal native range and its hit
area; its length follows the available container height. Both master and track
faders move vertically, remain within their slots, support keyboard adjustment
and reset, and retain one undo transaction per drag. A second defect was found:
the custom pan slider still accepted pointer/reset edits when disabled. Disabled
pan controls now reject those edits and expose their disabled accessibility state.
Screenshot review also found that WebKitGTK obscured the thumb when outlining the
rotated input itself. The focus indicator now belongs to its surrounding control;
keyboard focus remains visible without hiding the thumb.

Verified locally:

- **Pass:** 2,318 frontend unit tests; production frontend build and CMake Debug
  build/copy. Website guide TypeScript checks, release-note gate and workflow lint.
- **Pass:** all 40 selected WebKit scenarios: mixer controls, parameter wheel,
  automation input, audio-settings switching, render planning/error presentation,
  profile onboarding and NAM layout geometry. These use the frontend mock bridge;
  they do not establish native audio rendering or device operation.
- **Pass:** targeted mixer tests in Chromium and WebKit (10 total), profile tests
  in both engines (28 total), and both NAM geometry matrices. These overlap the
  40-scenario run and must not be counted as independent feature coverage.
- **Pass:** 14 assertions against compiled frontend assets in the system
  WebKitGTK, using real X11 pointer/key events. Both faders now have a vertical
  18-pixel-wide hit area; up/down changes volume and sideways dragging does not.
  Geometry/interaction checks cover three browser viewport/scale combinations;
  this is not a complete native desktop scaling/session matrix.

QA infrastructure also needed corrections. Playwright's Safari user agent
reported macOS on Linux while tests sent Linux shortcuts; browser identity now
matches the host. Onboarding expectations now account for Linux profile labels.
NAM alignment tolerance is measured in authored artwork pixels instead of scaled
screen pixels; the half-pixel limit is unchanged. This was a test-coordinate
correction, not a NAM production styling change.

The verification workflow now includes Ubuntu, Chromium/WebKit and a separate
system-WebKitGTK control gate, retaining reports/screenshots on failure. Local
checks pass; the modified workflow has not yet run on GitHub. The system test is
`tools/run-linux-control-ui.py`; browser tests include
`frontend/e2e/mixer-controls.spec.ts`. Evidence is under
`output/linux-ui-audit/`, including `gtk-before.json/png`, `gtk-after.json/png`,
`system-gtk-focus-final/`, `webkit-audit-final.log`, and the targeted test/build logs.
The final focus-indicator correction additionally passes all ten mixer tests in
both engines (`mixer-focus-final.log`) and screenshot inspection in system GTK.
An intermediate repeat accidentally let GTK select the inherited Wayland session
while XTest sent input to Xvfb, so its pointer assertions failed. The harness now
explicitly selects X11 and translates logical coordinates through the GTK scale
factor; the corrected final run passes. That intermediate evidence is retained in
`system-gtk-final/` and must not be mistaken for the final result.

Local installer: `OpenStudio-0.1.04-6-ubuntu-22.04-amd64.deb`, copied to Downloads.
SHA-256: `db6fb33deff512f362d2a5b85c287dd15d9bf737d28a267d2768ed1ae4e79a1c`.
It reuses the qualified Ubuntu 22.04 native executables and contains the rebuilt
frontend. The staged frontend was compared byte-for-byte with `frontend/dist`.
No RPM/AppImage was rebuilt for this UI checkpoint, and the package is unpublished.
The Ubuntu 22.04 VM upgraded from revision 5 to 6 through APT without uninstalling.
The installed revision 6 passed startup prerequisites, runtime-path handling and
all 42 native window lifecycle assertions. Evidence:
`installed-revision6-upgrade.log` and `installed-revision6-window/qualification.json`.
After the final focus-indicator change, the exact package hash above was
reinstalled with APT's `--reinstall` option and passed the same installed startup
and 42 window lifecycle checks again. Final evidence:
`installed-revision6-final-reinstall.log` and
`installed-revision6-final-window/qualification.json`. The QA VM and owned browser
test services were stopped afterward. Debug frontend assets were explicitly
synchronized and checked byte-for-byte, followed by the required CMake Debug
build; no pre-running Vite server is required and port 5183 is clear.

The physical host's App Center has reported “already installed” for a newer local
package. Until that upgrade flow is qualified, the explicit workaround is to close
the app and run `sudo apt install ~/Downloads/OpenStudio-0.1.04-6-ubuntu-22.04-amd64.deb`,
entering the password locally. This upgrades in place; removal is unnecessary.
The terminal workaround does **not** satisfy the promised graphical upgrade gate.
Do not send administrator passwords to the agent.

Not asserted: every app control or feature, actual Windows installed-app behavior
in this checkpoint, subjective audio quality, real-source Audient recording, and
the other outstanding release gates listed above. Further visual/interaction QA
must include actual distribution WebKitGTK versions, not only Chromium or the
Playwright browser build.

### Broader UI audit checkpoint — 2026-10-01

The requested broader audit is recorded in
[Linux UI audit — 2026-10-01](linux-ui-audit-2026-10-01.md), including a per-area
checked/failed/untested matrix, reproductions and local evidence paths. This
checkpoint changes documentation and QA artifacts only; its new defects are
**not fixed or shipped**.

- **Pass:** all 214 existing frontend E2E tests in Chromium and WebKit. Visual
  inspection expanded to 35 surfaces at 1280×800 and 800×600, with 139/140 primary
  captures completed; the remaining capture failed in the harness. Additional
  populated editor, keyboard, font-scale and installed-app probes are documented.
- **Fail — release blocker (UI-01):** saving/reopening loses track routing state,
  confirmed in installed revision 6 on Ubuntu 22.04. Store-level round trips also
  identify omitted notes, folder membership, waveform zoom and takes. Preserve
  supported track data and older-project defaults before release qualification.
- **Fail (UI-02/UI-03):** Audio Settings and Plugin Browser allow focus behind
  their overlays and ignore Escape. WebKit testing activated Add Track behind
  Audio Settings. Add dialog focus/background isolation and regressions.
- **Fail (UI-04/UI-05):** 150% app fonts overflow essential controls at the
  supported minimum viewport; malformed MIDI events can pass validation and
  crash the frontend. Add responsive-layout and input-validation coverage.
- **Needs native investigation (UI-06):** MIDI pop-out and keyboard target
  behavior differed from passing mock-browser tests. Instrument focus, hit
  targets and detached-window boot before assigning the cause or marking passed.
- **Checked narrowly:** native command palette, add-track Undo/Redo, valid project
  chooser/load, theme contents, tone pitch-analysis display, FX list and settled
  built-in EQ editor. These do not prove the underlying audio features or all
  controls work. No new Windows parity, live-input or audio-quality claim is made.

Close these defects and repeat the affected native workflows before continuing
the outstanding hardware, distribution, installer/update, provenance and store
publication gates. The older 40-scenario result above was a targeted checkpoint,
not evidence that the entire UI had already been qualified.

The [UI fixes and app-wide coverage plan](ui-fixes-and-coverage-plan.md) defines
the next implementation sequence, regression requirements for each audit finding,
and native Windows/macOS/Linux qualification gates. It also defines how to expand
the sampled audit into a maintained inventory of all supported UI and workflows.
Its status is planned; none of its fixes or cross-platform checks are claimed
complete by adding this plan.

### UI implementation and broader testing checkpoint — 2026-10-01

The five confirmed audit findings now have source changes and focused regression
coverage. See [UI fix verification](ui-fix-verification-2026-10-01.md) for the exact
scope, native/browser evidence, additional findings and remaining gates. This
supersedes the earlier planned-only status for those source fixes, not the pending
installer, installed-release, hardware or cross-platform qualification status.
The [coverage inventory](ui-coverage-inventory.json) keeps 176 declared features
and 138 component/window sources visible; untested entries must not be treated
as passed because a related dialog was captured.


## Synthetic-source follow-up — 2026-10-01

See [synthetic audio verification](synthetic-audio-verification-2026-10-01.md)
for the generated clips, realtime stereo defect and revision 8 fix, native
recording/playback/export evidence, picker corrections and remaining gates.
This supersedes the older candidate number for this checkpoint, not its limits.


## AI follow-up — 2026-10-01, revisions 12–14

The [Ubuntu AI report](ai-ubuntu-qualification-2026-10-01.md) now records the
Basic Pitch fix with installed tests on Ubuntu 22.04/24.04/26.04, corrected
model-specific setup links and the download timer, complete model-cache checks,
and successful native AMD generation/import/undo/redo on the Ubuntu 26.04 host.
The earlier 2 GiB GPU assessment was wrong: the Radeon 8060S exposes 100000 MiB
of shared GPU memory. NVIDIA-only INT8 remains untested.

The separate [Linux AI runtime 0.0.14](https://github.com/sdevil7th/OpenStudio/releases/tag/ai-runtime-linux-v0.0.14)
is published with Python 3.11.15. Both website manifests point to its verified
archive; Windows/macOS runtime assets remain unchanged. Fresh in-app runtime
installation and six-stem separation pass on all three Ubuntu systems. The
application fixes are still an unpublished candidate; the physical host package
has not been upgraded by this work.

MiniMax/Stable Audio real model setup and inference still require approved model
access. Subjective audio quality requires audition of the exact generated files.
Other distribution, native Windows/macOS, signing and store gates remain as
listed above; this checkpoint does not mark full-app qualification complete.

Final revision 14 evidence: runtime 0.0.14 downloaded and installed through the
app on Ubuntu 22/24/26; each completed six-stem separation and project reopening.
The physical AMD host also completed fresh in-app ROCm setup, native generation,
import/undo/redo, cancellation without late import, and retry. First/warm/retry
generation took 154/2/55 seconds respectively, so cold performance remains a
documented limitation. Logs, functional audio assertions and unqualified cases
are in `docs/ai-ubuntu-qualification-2026-10-01.md`. All owned test processes and
VMs have stopped; generated audio is retained for user audition.
