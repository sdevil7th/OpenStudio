# OpenStudio Runtime Dependency Contract

This document defines which dependencies are allowed to block launch, which files must ship with the app, and which extras must remain optional.

## Dependency Classes

### Hard Launch Prerequisites

These are required for the base app shell to start successfully.

- Windows: Microsoft Edge WebView2 Runtime
- Windows: Microsoft Visual C++ x64 Redistributable
- macOS: supported macOS version and working system WebKit backend
- Both platforms: packaged frontend entrypoint and the web assets required by the shell

If a hard prerequisite is missing or unusable:

- startup may be blocked
- the startup doctor must log the exact failure branch
- the user must get an actionable recovery path

### Startup Evidence

`--startup-self-test` verifies dependency discovery, packaged shell assets, and
whether an embedded-browser environment can be requested. It does **not** prove
that a window rendered the React application.

`boot-ready` is the stronger UI signal emitted after a browser role has loaded
its frontend. Release qualification requires both checks. The browser startup
watchdog must remain active and must turn a missing `boot-ready` signal into a
diagnosable failure instead of leaving a blank window.

## Bundled Feature Assets

These are bundled with OpenStudio and should be present in the installed/runtime bundle, but they must not block the base shell from launching.

- `webui/index.html`
- `effects/`
- `scripts/`
- `models/basic_pitch_nmp.onnx`
- `models/basic_pitch_nmp.provenance.json`
- `OpenStudio.version`, generated from the same CMake version compiled into the
  application and validated without launching a GUI process
- `LICENSE`, `THIRD_PARTY_LICENSES.md`, and the packaged dependency notices
  under `licenses/`; notices with repository-pinned digests are checksum
  validated before packaging
- Windows: the checksum-pinned FFmpeg executable, shared-library set, runtime
  manifest, source lock, provenance, and applicable license files

If a bundled feature asset is missing:

- startup must still succeed
- the affected feature surface must identify the missing asset
- release validation must fail

## Optional Feature Prerequisites

These must never block base app launch.

- Python for AI tools
- AI models and downloadable AI helper runtimes
- ONNX Runtime in custom builds and on platforms where it is not provisioned;
  official Windows/Linux releases provision the pinned runtime
- Linux `secret-tool` (normally provided by `libsecret-tools`) and an available
  Secret Service/keyring for optional TONE3000 sign-in; local NAM loading does
  not depend on it
- macOS/Linux: a system `ffmpeg` on `PATH` for MP3/OGG export, video-audio
  extraction, FFmpeg-backed time stretch/pitch shift, and conversions that need
  FFmpeg. OpenStudio does not redistribute an unpinned Unix FFmpeg binary.
- ASIO
- plugin-vendor-specific external runtimes

If an optional dependency is missing:

- the related feature surface should show guidance
- setup/download should run in the background when supported
- the main app thread must remain responsive

## Platform Rules

### Windows

- The installer owns hard launch prerequisites.
- The packaged app stages offline Windows prerequisite installers in `prereqs/windows`.
- Browser capability checks and browser construction must use the same shared
  options factory. Every WebView2 role uses the writable per-user data folder
  `%APPDATA%\OpenStudio\WebView2UserData`; no installed path may fall back to a
  user-data folder beside the executable under `Program Files`.
- A Debug browser pass is not evidence that the MSVC Release build works. The
  packaged Release executable must complete the frontend-ready lifecycle gate.
- The startup doctor must distinguish:
  - WebView2 not installed
  - WebView2 installed but unusable
  - VC++ redistributable missing
  - shell asset missing

### macOS

- The app relies on system WebKit; no separate browser runtime installer is bundled.
- The Basic Pitch model is bundled for provenance consistency, but the current
  macOS release pipeline does not provision ONNX Runtime, so Basic Pitch
  inference is unavailable in that build.
- FFmpeg-backed features require a system FFmpeg on `PATH`; FFmpeg is not
  bundled in the macOS app.
- The startup doctor must distinguish:
  - backend unavailable on the current system
  - shipped runtime asset missing
  - packaged frontend missing
- Safe mode and the startup log must remain available for recovery.

### Linux

- Release validation must read `OpenStudio.version` and fail on a missing,
  empty, or mismatched manifest; it must not launch the GUI binary for a
  best-effort version check.
- FFmpeg-backed features use the system `ffmpeg` installed by the distribution;
  OpenStudio does not copy a developer-local FFmpeg into the AppImage.
- Missing FFmpeg must disable only the affected conversion operation and must
  produce an actionable diagnostic rather than blocking startup.

## Embedded and Native Window Roles

The embedded-browser lifecycle contract covers the main shell, detached Mixer,
each detached MIDI editor, and each built-in effect editor. Each role must reach
`boot-ready`, survive close/reopen cycles, and release closed secondary views.
Third-party plug-in editors use their native JUCE editor path and are qualified
separately for open/close/reopen behavior while audio is running. The graphical
Pitch Editor remains part of the main window rather than a detached browser
role.

## JUCE Dependency Policy

OpenStudio is pinned to JUCE `9.0.1`. A JUCE upgrade must be an isolated,
reviewable dependency change with Debug and Release builds plus audio-device,
plug-in-host, browser lifecycle, and packaging qualification. OpenStudio's
realtime JUCE patches must fail closed when their expected upstream source
context changes; an upgrade must never silently skip or partially apply them.

## Distribution Trust Boundary

Signing, launch reputation, and runtime health are separate gates. A valid
signature is not automatically reputation-clean on Windows, and a self-signed
binary is not a substitute for established Authenticode reputation. On macOS,
signature verification does not replace notarization/Gatekeeper assessment.
Unsigned releases may use the documented user-approved first-launch path, but
must not describe that path as warning-free.

## AI Tools Contract

- Clicking the toolbar AI button may start optional setup work.
- A lightweight popup should confirm that setup is running in the background.
- The top-right AI button is the persistent progress surface.
- Python is optional for the base app and must never block startup.
