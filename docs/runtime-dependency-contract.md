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

## Bundled Feature Assets

These are bundled with OpenStudio and should be present in the installed/runtime bundle, but they must not block the base shell from launching.

- `webui/index.html`
- `effects/`
- `scripts/`
- `models/basic_pitch_nmp.onnx`
- `ffmpeg` / `ffmpeg.exe`

If a bundled feature asset is missing:

- startup must still succeed
- the affected feature surface must identify the missing asset
- release validation must fail

## Optional Feature Prerequisites

These must never block base app launch.

- Python for AI tools
- AI models and downloadable AI helper runtimes
- ONNX Runtime
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
- The startup doctor must distinguish:
  - WebView2 not installed
  - WebView2 installed but unusable
  - VC++ redistributable missing
  - shell asset missing

### macOS

- The app relies on system WebKit; no separate browser runtime installer is bundled.
- The startup doctor must distinguish:
  - backend unavailable on the current system
  - shipped runtime asset missing
  - packaged frontend missing
- Safe mode and the startup log must remain available for recovery.

## AI Tools Contract

- Clicking the toolbar AI button may start optional setup work.
- A lightweight popup should confirm that setup is running in the background.
- The top-right AI button is the persistent progress surface.
- Python is optional for the base app and must never block startup.
