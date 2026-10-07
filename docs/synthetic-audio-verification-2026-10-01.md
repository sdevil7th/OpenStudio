# Synthetic audio verification — 2026-10-01

The user requested a generated clip to continue testing. This checkpoint uses
`9b8f219d52faebe0c26699a9ac2848523ad01575` plus uncommitted candidate changes.
It is not full-app or native Windows/macOS qualification.

## Fixtures and environment

`tools/generate-audio-qa-fixtures.py --output <empty-directory>` creates a
16-second 48 kHz stereo/24-bit WAV with separate left/right tones, silent gaps
and a synthesized melody, plus an 8-second 44.1 kHz mono/24-bit 330 Hz WAV.
Files, manifests, screenshots, projects and measurements are under
`output/synthetic-audio-qa/`. Synthetic signals test routing/timing invariants;
subjective sound quality remains **not_asserted**.

The actual installed application runs in the existing Ubuntu 22.04 GNOME/X11 QA
VM. Separate PulseAudio null sinks provide input and capture output via the ALSA
PulseAudio plugin. Input is a generated WAV fed with `paplay`; output is captured
with `parec`. No physical Audient settings were changed. Alignment uses the known
first tone onset and is **not a latency measurement**.

## Defects found and corrected in candidate revision 8

1. **Realtime stereo corruption:** revision 7 duplicated left-only or right-only
   content into both channels. Export and raw recording preserved isolation.
   `TrackProcessor` guessed mono from a silent channel after FX/width processing.
   Removed that guess; explicit source/plugin channel-layout handling remains.
   Six native regressions cover left/right output, pre-fader sends, dual mono and
   declared mono plugin output. Before/after captures are retained.
2. **Media hidden in native pickers:** five calls omitted filters, so the native
   bridge defaulted to `*.osproj`. Media insertion from menus/actions, batch
   audio conversion, video opening and DDP source selection now pass appropriate
   filters. Project dialogs retain their existing default.
3. **DDP destination used a file picker:** it now uses the existing native folder
   selection bridge. Cancellation does not start export.
4. **Video header blocked by the toolbar:** raised the floating video window above
   the toolbar, below menus/modals. Actual pointer clicks pass in both browser
   engines; no forced-click workaround is used.

## Objective results

| Scenario | Result | Evidence / limit |
| --- | --- | --- |
| Generate deterministic clips | pass | `fixtures/manifest.json`, independent segment measurements |
| Installed rev7 import, move, split at 4 s, undo/redo, save | pass | `imported.osproj`, `split*.osproj`, screenshots |
| Rev7 native GUI export 48 kHz source to 44.1 kHz WAV | pass | `split-export-44100.wav`, `export-44100-check.json`: duration, frequencies, channel isolation |
| Rev7 realtime stereo playback | **fail** | `playback-capture.wav`, `playback-check.json`; retained original failure |
| Rev7 actual GUI recording through virtual input | pass | `app-recorded.wav`, `recording-check.json`; correct left/right signal and silence |
| Rev8 actual GUI recording through virtual input | pass | `app-recorded8.wav`, `recording8-check.json`, `recorded8.osproj`: preserved stereo signal/silence and saved clip |
| Rev8 actual realtime stereo playback | pass | `playback8-capture.wav`, `playback8-check.json`; silent channels remain silent |
| Rev8 mono 44.1 kHz source on 48 kHz device | pass | `mono-playback8-check.json`: 330 Hz both channels, zero channel difference |
| Debug native safety suite | pass | 243 checks, `debug-runtime/result.json`; deliberate bad-storage probes emit WAV assertions, not a diagnostic-free run |
| Installed rev8 native safety suite | pass | 242 checks, `runtime8-result.json`; configuration-specific count differs from Debug |
| Installed rev8 startup/window/render qualification | pass | `installed8/qualification.json`; 42 lifecycle + 35 render checks, no runtime diagnostics; Windows isolation check **not_asserted** |
| Rev8 Ubuntu 22.04 loader/ABI | pass | `abi8.json`, glibc ceiling 2.35 |
| Frontend units | pass | 2,332 tests / 189 files, `unit.log` |
| New picker/control regressions | pass | 12 Chromium/WebKit tests, `picker-browser-fixed.log` |
| Adjacent render UI regressions | pass | 10 Chromium/WebKit tests, `browser.log` |
| Frontend/Debug/Ubuntu 22.04 Release builds | pass | build logs; no new native compiler warnings; Vite chunk/import warnings remain |
| Website TypeScript | pass | `website-types.log` |

Native picker screenshots show the correct media filter and visible WAV files,
and DDP output selects a directory with ordinary files disabled. The native
video-header button opens its video-filtered picker despite the toolbar overlap.
Video decoding and a complete DDP production export are not claimed.
Only supported filter behavior is claimed; this does not qualify every codec.

## Candidate and remaining gates

Local installer: `~/Downloads/OpenStudio-0.1.04-8-ubuntu-22.04-amd64.deb`.
SHA256: `7eaeafc0494dd9088afad6082f670720249d9698259c732d64003c768232ed13`.
The QA VM upgraded from revision 7 without uninstalling. The physical host still
has revision 5. Release notes passed the required gate before packaging; no
release was published. Package trust/reputation and App Center presentation are
not resolved by this update.

Still **not_asserted**: physical Audient live recording/monitoring and subjective
listening, latency/xruns under sustained load, reconnect/suspend, native
Windows/macOS parity, the remaining distro matrix, external-plugin/optional-AI
coverage and exhaustive feature/UI states. A synthetic source cannot replace
those tests. The source inventory continues to mark untested scenarios as such.

The final CMake Debug build completed and all 142 copied Debug/package frontend
files match `frontend/dist`. No pre-running server is required for
`python build.py dev --run`. The QA app/VM and test servers were stopped; the VM
virtual audio devices and temporary device configuration were removed.

Automation notes: the first picker run used the wrong menu locator, and an
early file-picker action typed before the native window settled, modifying a
QA track name. Those harness errors are not product defects. The original
playback failure was initially misread because a later shell command masked
the analyzer exit status; the JSON failure was caught, retained and corrected
before qualification. No failed run was replaced with a passing result.
