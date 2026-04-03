# OpenStudio Website, Rebrand, and Production Plan

This document turns the current repo state into a practical launch plan for the OpenStudio website, download flow, rebrand, and production release.

## 1. Repo Audit Summary

Based on the current codebase:

- The app is a desktop DAW with a JUCE C++ backend and a React/TypeScript frontend embedded in a native window.
- The current release flow is still Windows-first. `docs/USER_MANUAL.md` explicitly describes a Windows-native app distributed as a single `Studio13.exe`.
- `build.py` only builds and launches the Windows executable path.
- `CMakeLists.txt` has Apple/Linux compile guards, but `Source/MainComponent.cpp` still hardcodes the WebView2 backend, so macOS/Linux are not production-ready yet.
- There is no real auto-update system in the repo right now.
- Branding is still deeply embedded across product name, executable name, docs, code symbols, file extensions, localStorage keys, scripts, and the SVG wordmark.
- There is a launch blocker around licensing consistency:
  - `LICENSE` is AGPLv3.
  - `THIRD_PARTY_LICENSES.md` says the project is released under AGPLv3-compatible terms.
  - `README.md` still says “Studio13 is proprietary software. All rights reserved.”

### Branding Surface Area

Current branding footprint is large even after excluding `node_modules`, generated files, the build folder, and bundled Python:

- `Studio13`-style product naming: about 200 matches across 42 files
- `S13`-style short prefix and file-format branding: about 146 matches across 29 files

This is a real migration project, not a single search-and-replace.

## 2. Website Strategy

## Goal

The website should do four jobs:

1. Explain what OpenStudio is in one screen.
2. Show real screenshots and credible workflow value.
3. Convert visitors into downloads without overpromising unsupported platforms.
4. Make the rebrand feel deliberate and professional.

## Recommended Positioning

Use this product framing:

> OpenStudio is a modern desktop DAW with a native JUCE audio engine and a fast React interface, built for recording, editing, pitch work, mixing, and export without Electron overhead.

That keeps the core differentiator intact:

- native desktop audio engine
- modern UI stack
- strong pitch workflow
- plugin hosting
- audio + MIDI + export in one app

## Recommended Visual Direction

Do not build a generic SaaS landing page.

Use a visual language closer to “audio workstation meets technical instrument”:

- Background: deep ink/navy with layered gradients, subtle gridlines, and spectrogram/waveform textures
- Core colors:
  - `#08111b` background
  - `#102033` panels
  - `#39a0d8` primary brand blue
  - `#0cfaf7` highlight cyan
  - `#ff9d4d` warm accent for CTA emphasis
- Typography:
  - Headlines: `Space Grotesk` or `Sora`
  - UI/body: `Manrope` or `IBM Plex Sans`
  - Technical labels: `IBM Plex Mono`
- Motion:
  - slow waveform reveals
  - horizontal screenshot parallax
  - meters/spectra that animate once on load, not constantly

## Recommended Information Architecture

### Homepage

1. Hero
2. Proof bar
3. Screenshot-led feature stories
4. Workflow section
5. Plugin and pitch section
6. Download/compatibility section
7. FAQ
8. Roadmap / “coming next”

### Download Page

1. Platform cards
2. Install instructions
3. System requirements
4. Checksums / version history
5. Auto-update policy
6. Known limitations

### Docs / Learn

1. Getting started
2. Recording
3. MIDI editing
4. Pitch correction
5. Plugin hosting
6. Scripting
7. Export

## 3. Homepage Wireframe

## Hero

Suggested headline:

> OpenStudio is a native DAW for recording, editing, pitch work, and mixing.

Suggested subheadline:

> Built on a JUCE C++ audio engine with a modern React interface, OpenStudio gives you fast editing, deep pitch tools, plugin hosting, and streamlined export in a desktop app that feels immediate.

Suggested CTAs:

- `Download for Windows`
- `See Features`
- `Join macOS/Linux waitlist` if those builds are not ready yet

Hero supporting points:

- Native audio engine
- Audio + MIDI workflow
- Pitch editing and correction
- VST3 hosting
- Offline export

## Proof Bar

Use a short strip directly under the hero:

- Native desktop app
- JUCE audio engine
- React UI
- Pitch tools
- Multitrack audio + MIDI
- Export to WAV / AIFF / FLAC

## Feature Story Blocks

Build these as alternating text + screenshot sections.

### 1. Record and Arrange

- Show the main arrange/timeline view
- Copy theme:
  - Record audio, arrange clips, split takes, trim edges, work with waveforms, and keep momentum with fast keyboard-driven editing.

### 2. MIDI and Composition

- Show piano roll and MIDI track view
- Copy theme:
  - Create MIDI tracks, edit notes in the piano roll, use the virtual keyboard, and keep timing tight with snap and quantize tools.

### 3. Pitch Workflow

- Show pitch editor / pitch corrector UI
- Copy theme:
  - Analyze vocal or melodic material, adjust notes visually, refine formants and transitions, or use real-time pitch correction inside the FX workflow.

### 4. Mix and Finish

- Show mixer + FX chain + render/export
- Copy theme:
  - Shape the mix with channel strips, automation, plugin chains, built-in effects, and export-ready rendering options.

## Workflow Section

Three cards:

- Record
- Edit
- Release

Each card should show 3-4 concrete capabilities instead of generic claims.

## Download Section

Use honest platform states:

- Windows: available first
- macOS: planned / experimental until verified
- Linux: planned / experimental until verified

Do not label all three as “available now” unless CI, packaging, and QA are actually ready.

## 4. Feature List for Website Copy

Below is the recommended product copy set based on what exists in the repo today. This is split into:

- features safe to market once verified in QA
- features that should be labeled beta, experimental, or “coming soon” until validated

## A. Safe to Market First

These are strong candidates for the main website once we confirm them in a release checklist.

### Native multitrack recording and playback

- What it does: lets users record and play back multiple tracks with a native desktop audio engine
- How to use it: create tracks, arm recording, choose inputs, and record directly into the timeline
- Why it matters: this is the core DAW workflow and should anchor the homepage

### Audio timeline editing

- What it does: arrange clips, trim, split, move, loop, zoom, and work directly with waveforms
- How to use it: import audio, drag clips on the timeline, use snap/grid controls, and split at the playhead
- Why it matters: this is one of the clearest screenshot-friendly workflows

### MIDI tracks, piano roll, and virtual keyboard

- What it does: supports MIDI input, clip editing, note editing, and on-screen keyboard input
- How to use it: create a MIDI track, open the piano roll, draw or edit notes, and use quantize when needed
- Why it matters: shows the app is not audio-only

### Mixer, channel strips, and metering

- What it does: gives track-level balance control with faders, pan, mute/solo, and meters
- How to use it: open the mixer or track controls, set levels, pan positions, and monitor signal activity in real time
- Why it matters: important for credibility with DAW users

### Built-in effects and FX chains

- What it does: supports per-track input FX, track FX, and master FX, plus built-in processors
- How to use it: open the FX chain, add built-in effects or plugins, then reorder or bypass processors
- Why it matters: this gives clear “record, process, mix” messaging

### Pitch editing and correction

- What it does: offers graphical pitch editing plus a real-time pitch corrector workflow
- How to use it: analyze a clip, open the pitch editor, move notes or use correction controls for faster cleanup
- Why it matters: this is one of the product’s strongest differentiators

### Automation lanes

- What it does: lets users automate volume, pan, and parameter changes over time
- How to use it: show automation on a track, add control points, then shape the curve during playback or editing
- Why it matters: a serious DAW needs visible automation support

### Render and export

- What it does: exports finished work to common audio formats like WAV, AIFF, and FLAC
- How to use it: open the render/export flow, pick format and depth, then render the project or target range
- Why it matters: this completes the “from recording to export” story

### Lua scripting and workflow automation

- What it does: exposes scripting hooks for transport, tracks, FX, and automation workflows
- How to use it: open the script editor, write or run scripts, and automate repetitive tasks
- Why it matters: strong USP for advanced users, but should sit lower on the homepage

## B. Market Only After Verification

These are interesting differentiators, but they should be validated before they appear prominently on the website.

### ARA plugin hosting

- Good USP if stable
- Needs explicit regression testing before public marketing

### Stem separation

- Strong headline feature
- Needs packaging validation because it depends on Python/model/runtime setup

### DDP export

- Valuable for mastering users
- Needs end-to-end QA before public claims

### Theme import/export

- Nice differentiator
- Should be verified so we do not oversell customization depth

### Command palette, screensets, batch conversion, cleanup tools

- Great supporting features
- Better for a features page than the hero

### Video sync and surround workflows

- Present in code paths and UI state
- Should not be advertised until tested and production-ready

### CLAP / LV2 support

- Present in the codebase
- Treat as beta/experimental until scan/load/editor behavior is verified

## 5. Screenshot Plan

The current `Design screenshots/` folder is not enough for marketing. Most of those images are menu captures, not hero-grade product screenshots.

### Capture These Fresh

1. Main timeline with multiple tracks and waveforms
2. Mixer with active meters
3. Piano roll with notes and velocity lane
4. Pitch editor with visible note blobs/curves
5. FX chain + plugin browser
6. Render/export dialog
7. Theme editor or scripting view for the “power users” section

### Existing Assets Worth Reusing

- `design.png`
- `logo_preview.png`
- `icon_preview.png`
- `Design screenshots/midi track and clip.png`
- `Design screenshots/render-export.png`

## 6. Download and Installer Strategy

## Current State

Right now the project is closest to this distribution model:

- Windows executable build output
- copied runtime assets beside the executable
- no formal installer
- no update channel

That matches the current manual as well.

## What To Ship First

Recommendation:

1. Ship Windows first
2. Add a real installer
3. Add signed release artifacts and checksums
4. Add updater support after installer packaging is stable
5. Bring macOS next
6. Bring Linux after macOS if bandwidth is limited

## Windows

### Current Build Output

Current production build command:

- `python build.py prod`

Current output path:

- `build/Studio13_v2_artefacts/Release/Studio13.exe`

### What the Windows Installer Must Include

- main executable
- WebView2 requirement handling
- `ffmpeg.exe`
- `effects/`
- `scripts/`
- `models/`
- bundled Python/runtime if stem separation depends on it
- app icon, version metadata, uninstaller

### Recommended Installer Approach

Use one of these:

- Fastest path: Inno Setup
- More enterprise-heavy path: WiX
- Microsoft-store-style path: MSIX

Recommendation: start with Inno Setup because it is the shortest path to a professional Windows installer.

## macOS

### Feasibility

Possible in theory from the CMake guards, but not ready to promise publicly yet.

Current blocker:

- `Source/MainComponent.cpp` hardcodes the WebView2 backend instead of selecting the browser backend per platform

### What Must Happen Before macOS Download Exists

- fix platform-specific webview backend selection
- build on macOS hardware/CI
- package app resources inside the `.app` bundle
- sign with Apple Developer ID
- notarize
- package as `.dmg`

### What the macOS Bundle Must Include

- `.app` bundle
- resources inside `Contents/Resources`
- models/effects/scripts
- ffmpeg binary
- any Python/runtime dependencies if required

## Linux

### Feasibility

Possible later, but currently not production-ready.

### Minimum Viable Linux Release

- tarball or AppImage first
- `.deb` later if needed

### Linux Requirements To Solve

- webview backend validation
- ALSA/JACK/WebKitGTK dependency strategy
- asset bundling
- plugin scanning differences
- distro testing

Recommendation: if Linux happens, AppImage is the cleanest first public artifact.

## 7. Auto-Update Support

## Current State

There is no updater implementation in the repo right now.

No evidence found for:

- WinSparkle
- Sparkle
- Squirrel
- appcast/update feeds
- update signatures
- check-for-updates UI
- background patching

## Recommendation

### Windows

- Use WinSparkle if you want native desktop-style update checks
- Publish signed installers plus an appcast feed

### macOS

- Use Sparkle
- Pair with code signing + notarization from day one

### Linux

- Avoid promising true in-app auto-update at first
- Prefer package-manager updates or AppImageUpdate only if you commit to AppImage

## Important Timing Note

Do the OpenStudio rename before shipping the first public auto-update channel.

If you launch updates under `Studio13` and then rename immediately after, you create avoidable migration complexity for:

- appcast/feed URLs
- code signing identity
- install directories
- update channels
- support docs

## 8. Rebrand Plan: Studio13 -> OpenStudio

## Critical Warning: Do Not Blindly Replace `S13` With `OS`

This needs one explicit naming decision before implementation.

### Why `OS` Is Dangerous Technically

- In Lua, `os` is already a standard library namespace.
- A project extension like `.os` is too generic and confusing.
- `OS` also reads as “operating system” in code, docs, and support discussions.

### Recommended Rule

- Customer-facing short label: `OS` is okay in visual marketing copy only
- Technical/product identifiers: use `OpenStudio` or `openstudio`, not raw `OS`

## Recommended Naming Map

- Product name: `Studio13` -> `OpenStudio`
- App target / executable: `Studio13_v2` / `Studio13.exe` -> `OpenStudio`
- Internal class prefix:
  - `S13PitchCorrector` -> `OpenStudioPitchCorrector`
  - `S13FXProcessor` -> `OpenStudioFXProcessor`
  - `S13FXGfxEditor` -> `OpenStudioFXGfxEditor`
  - `S13ScriptWindow` -> `OpenStudioScriptWindow`
- Scripting namespace:
  - do not use `os.*`
  - use `openstudio.*` or `ostudio.*`
  - keep `s13.*` as a deprecated compatibility alias for one transition period

## File Extension Recommendations

Avoid `.os`.

Recommended safer replacements:

- project file: `.s13` -> `.ostudio` or `.osproj`
- peak cache: `.s13peaks` -> `.ostudiopeaks`
- theme file: `.s13theme` -> `.ostheme`
- preset file: `.s13preset` -> `.ospreset`

My recommendation:

- `.ostudio` for projects
- `.ostheme` for themes
- `.ospreset` for presets
- `.ostudiopeaks` for cache files

## Branding Surfaces To Rename

### Product and build identity

- CMake project and target names
- `PRODUCT_NAME`
- executable name
- macOS bundle name
- installer product name
- package.json name where user-visible
- manifest names and metadata

### UI and docs

- README
- manual
- API docs
- About dialogs
- onboarding text
- plugin browser author strings
- keyboard shortcut modal
- window titles
- support links

### File formats and runtime keys

- project extension
- theme/preset/cache extensions
- localStorage keys
- saved templates keys
- screenshots/workflow exports
- app data folder paths
- documents paths
- debug log file paths

### Code symbols and filenames

- `S13*` classes/files
- `s13_` localStorage keys and constants
- `Studio13Application`
- `Studio13_Debug.log`

### Plugin and scripting branding

- built-in FX names
- “S13FX” category naming
- scripting APIs
- script templates/comments

## Logo Work

The current `frontend/public/logo.svg` is not simple text. The wordmark is made from vector paths.

That means the clean path is:

1. re-export the logo from the original design source if available, or
2. replace the lower wordmark area with a new `OpenStudio` vector wordmark

Do not treat it like an editable text layer unless you have the original source file.

## Backward Compatibility Plan

To avoid breaking existing users/projects:

- continue reading old `.s13` project files for at least one full transition cycle
- continue reading old theme/preset/cache formats where practical
- support old `s13.*` Lua aliases temporarily if scripts already exist
- migrate old app data paths to new `OpenStudio` paths on first launch

## 9. Production TODO List

## Phase 0: Decisions

- Decide final project file extension
- Decide whether scripting namespace becomes `openstudio.*` or stays `s13.*` with aliasing
- Decide license position: AGPL/commercial/proprietary must be made consistent
- Decide first public platform: recommended `Windows first`
- Decide whether CLAP/LV2/video/DDP are launch features or post-launch features

## Phase 1: Rebrand Foundations

- Rename product name in build system, manifests, app metadata, and docs
- Replace the SVG wordmark with `OpenStudio`
- Rename app data folders and document paths
- Rename visible FX labels from `S13` to `OpenStudio` or `OS FX`
- Rename file formats with backward-compatible import support
- Rename localStorage keys with migration logic
- Add compatibility shims for old script/file naming where needed

## Phase 2: Product Hardening

- Create a release checklist for audio recording, playback, save/load, render, plugin scan/load, pitch edit, MIDI edit, and export
- Validate all “hero” website features manually
- Mark unstable features as beta or hide them
- Test large projects, missing media handling, and plugin crash scenarios
- Test sample rate changes and audio device switching
- Add crash logging and cleaner error reporting
- Add safe mode / recovery mode for plugin-related startup issues if not fully ready yet

## Phase 3: Packaging and Distribution

- Build a proper Windows installer
- Add version metadata and signed binaries
- Add release artifact checksums
- Bundle all required runtime assets consistently
- Verify clean install and uninstall on a new machine
- Define where logs, user data, scripts, models, and themes live after install

## Phase 4: Cross-Platform Readiness

- Remove hardcoded WebView2 backend usage from shared code
- validate browser backend selection per platform
- stand up macOS build pipeline
- stand up Linux build pipeline
- test plugin hosting and file dialogs on each platform
- package runtime assets correctly for `.app` and AppImage/tarball layouts

## Phase 5: Auto-Update

- Choose updater stack per platform
- Generate signed update feed
- create stable/beta channels
- add update settings UI
- test update path from one released version to the next
- test rename-era migration if updater arrives after rebrand work begins

## Phase 6: Website Production

- Design homepage and download page
- Capture polished screenshots
- write short, honest feature copy
- add platform matrix and system requirements
- add release notes/changelog page
- add FAQ for plugins, audio drivers, supported formats, and project compatibility
- add privacy/support/contact pages

## Phase 7: Legal and Compliance

- Resolve the AGPL vs proprietary contradiction
- confirm third-party redistribution rights for FFmpeg, WebView2, ASIO handling, models, and any bundled Python dependencies
- publish third-party notices in installer or app bundle if required
- add EULA/privacy policy only if they match the actual license strategy

## Phase 8: Launch Operations

- create versioning policy
- create release notes template
- create bug-report template
- create support email/contact flow
- create “known issues” page
- create telemetry/privacy stance
- decide whether beta releases are public or invite-only

## 10. Recommended Public Launch Sequence

Best path from the current repo:

1. Finalize branding decisions for OpenStudio naming and file extensions
2. Resolve licensing position
3. Finish the Windows-only production release path
4. Launch website with Windows download first
5. Mark macOS and Linux as “in progress” or “join waitlist”
6. Add updater support after installer and signing are stable
7. Bring macOS next
8. Bring Linux after platform validation

## 11. What Should Not Be Promised on Day One

Until validated, avoid homepage claims like:

- “Available on Windows, macOS, and Linux”
- “Automatic updates included”
- “Full CLAP/LV2 support”
- “Production-ready video workflow”
- “Mastering-grade DDP workflow”

These may become true, but they should not headline the site until verified.

## 12. Recommended Immediate Next Actions

If we want the fastest path to a credible public launch, do these next:

1. Lock the final OpenStudio naming rules, especially file extensions and scripting namespace.
2. Resolve the license mismatch across `LICENSE`, `README.md`, and release messaging.
3. Decide the Windows installer format and build the first signed installer.
4. Capture fresh hero-quality screenshots from the actual app.
5. Build the marketing site around a Windows-first release, with macOS/Linux shown as upcoming unless proven ready.
