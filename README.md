<p align="center">
  <img src="frontend/public/icon.svg" height="112" alt="OpenStudio logo"/>
</p>

<h1 align="center">OpenStudio</h1>

<p align="center">
  <strong>A native, open DAW for recording, editing, mixing, pitch work, plugin hosting, and local AI-assisted music production.</strong>
</p>

<p align="center">
  Built with a JUCE C++ audio engine and a React/TypeScript interface. No Electron shell, no cloud-only workflow, no locked session model.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue" alt="Platform: Windows and macOS"/>
  <img src="https://img.shields.io/badge/engine-JUCE%208-informational" alt="JUCE 8"/>
  <img src="https://img.shields.io/badge/UI-React%20%2B%20TypeScript-61dafb?logo=react" alt="React and TypeScript"/>
  <img src="https://img.shields.io/badge/audio-ASIO%20%7C%20WASAPI%20%7C%20DirectSound-green" alt="Audio drivers"/>
  <img src="https://img.shields.io/badge/plugins-VST3%20%7C%20CLAP%20%7C%20LV2-orange" alt="Plugin formats"/>
  <img src="https://img.shields.io/badge/AI-ACE--Step%20%7C%20Stable%20Audio%203-purple" alt="AI music models"/>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>
  |
  <a href="#features-at-a-glance">Features</a>
  |
  <a href="#comparison">Comparison</a>
  |
  <a href="docs/USER_MANUAL.md">User Manual</a>
  |
  <a href="docs/API.md">Lua API</a>
</p>

> Screenshot/GIF slot: add a first-run timeline or mixer capture here once the current UI pass is ready.

---

## Why OpenStudio?

OpenStudio is for people who want a real DAW surface, not just a prompt box, and a modern production workflow without giving up native audio performance. It combines classic multitrack production with newer tools such as stem separation, audio-to-MIDI, source-conditioned AI generation, graphical pitch editing, and scriptable project operations.

The goal is direct: record or import material, edit it deeply, route and mix it like a DAW, generate or transform ideas with local AI tools when useful, then render deliverables without leaving the session.

## Features At A Glance

| Area | Current support |
|---|---|
| Recording | Multitrack audio recording, MIDI recording, input monitoring, punch range, record modes |
| Editing | Clip move/trim/split, ripple edit, razor edit, fades, grouping, takes, slip edit, reverse, normalize, time stretch, pitch shift |
| MIDI | MIDI tracks, instrument tracks, piano roll, velocity/CC editing, transforms, virtual keyboard, MIDI import/export, audio-to-MIDI |
| Mixing | Mixer, detached mixer, sends, buses, routing matrix, master strip, meter isolation, mixer snapshots |
| Plugins | VST3, CLAP, LV2 code paths, native plugin editors, input/track/master/monitoring FX, plugin presets, A/B states, MIDI learn |
| Built-in FX | EQ, compressor, gate, limiter, delay, reverb, chorus, saturator, pitch corrector, basic synth/piano/drums |
| Pitch | Graphical pitch editor, YIN analysis, note blobs, drift/vibrato tools, real-time auto-tune style FX, Basic Pitch polyphonic detection |
| AI | Optional AI Tools runtime, stem separation, ACE-Step music generation, Stable Audio 3 text-to-audio, clip variation, inpaint, continuation |
| Render | WAV, AIFF, FLAC, MP3, OGG, mono/stereo, sample-rate conversion, normalize, tail, dither, secondary output, stems, regions, razor areas |
| Delivery | Render queue, region render matrix, DDP export, batch converter, session archive, project compare, clean project directory |
| Workflow | Command palette, shortcut reference and rebinding, help overlay, getting started guide, screensets, themes, toolbar editor |
| Extensibility | Lua scripting API, script editor, JSFX/S13FX script effects, project automation helpers |
| Sync / media | Timecode display/settings, big clock, media explorer, media pool, missing media resolver, video window plumbing |

Some advanced features are still evolving. See [Implemented But Partial / Caveated](docs/implemented_features.md#implemented-but-partial--caveated) for the honest edges.

## Comparison

These comparisons are meant to position OpenStudio clearly, not pretend a young open DAW replaces decades of commercial engineering in every studio tomorrow.

### OpenStudio vs Cubase

| Need | Cubase | OpenStudio |
|---|---|---|
| Composition DAW | Mature commercial DAW with deep MIDI, scoring, VariAudio, built-in instruments, and large content libraries | Native open DAW with MIDI, instrument tracks, piano roll, audio-to-MIDI, pitch editor, and scriptable workflows |
| Pitch editing | VariAudio and ARA-compatible workflows | Built-in graphical pitch editor, real-time pitch corrector FX, Basic Pitch detection, and ARA hosting |
| AI assistance | Cubase Pro includes modern assisted tools such as stem separation | Optional local AI Tools runtime for stem separation plus text-to-music, text-to-audio, variation, inpaint, and continuation workflows |
| Extensibility | VST ecosystem, commercial extension model | VST3/CLAP/LV2, JSFX/S13FX, Lua API, open source codebase |
| Best fit | Established production/composition rooms that need Steinberg's mature ecosystem | Builders, indie producers, researchers, and power users who want DAW depth plus local AI and hackability |

### OpenStudio vs Pro Tools

| Need | Pro Tools | OpenStudio |
|---|---|---|
| Studio standard | Mature industry-standard audio/post platform with AAX, HDX, large facility workflows, and advanced immersive/post tooling | Open native DAW focused on fast iteration, local-first production, and transparent implementation |
| Editing | Deep editing, recording, comping, post-production workflows | Multitrack recording, takes, razor/ripple editing, slip edit, clip properties, freeze, region tools |
| Pitch / repair | Strong third-party ecosystem through ARA partners and plugins | Built-in graphical pitch editor, real-time pitch corrector, ARA host controller, source-aware pitch render diagnostics |
| Delivery | Strong broadcast/post pipelines and collaboration tooling | Offline render, stems, region render matrix, render queue, DDP export, archive tools |
| Best fit | Commercial facilities and sessions that need Pro Tools compatibility | Producers and developers who want open workflows, modern UI, and integrated AI generation inside a DAW |

### OpenStudio vs Suno AI

| Need | Suno AI | OpenStudio |
|---|---|---|
| Product shape | Cloud AI song generation service | Full DAW with optional local AI-assisted generation |
| Starting point | Prompt to generated song | Record, import, generate, edit, arrange, mix, render |
| Control | Fast idea generation with plan/credit limits and cloud queues | Timeline-level control over clips, tracks, routing, plugins, MIDI, pitch, stems, and exports |
| AI workflows | Song generation, editing, uploads, stems depending on plan | ACE-Step text-to-music and lyrics+style, Stable Audio 3 text-to-audio, source variation, inpaint, continuation, stem separation |
| Ownership/privacy model | Depends on Suno plan and terms; free plan is non-commercial as of the current Suno pricing/help pages | Local project files and local optional AI tooling; users decide what media enters the session |
| Best fit | Quickly making complete AI songs | Turning recordings, generated ideas, stems, and MIDI into editable productions |

Reference pages used for the comparison: [Cubase editions](https://www.steinberg.net/cubase/compare-editions/), [Pro Tools](https://www.avid.com/en/pro-tools), [Suno pricing](https://suno.com/pricing), and [Suno rights help](https://help.suno.com/en/categories/550145-rights-ownership).

## AI Music And Assisted Audio

OpenStudio keeps AI as part of the DAW workflow rather than a replacement for it.

| Workflow | What it does |
|---|---|
| Text to Music | Generates a fresh music clip through ACE-Step from prompt, lyrics, BPM, key/scale, language, duration, seed, and diffusion controls |
| Lyrics + Style | Uses structured lyrics plus style/arrangement prompt for song generation |
| Text to Audio | Uses Stable Audio 3 Medium for prompt-based audio generation |
| Create Variation | Builds a source-conditioned variation while preserving the selected clip's identity |
| Inpaint Selection | Regenerates a selected range inside a clip while matching the surrounding audio |
| Continue Clip | Generates a continuation tail from the selected source clip |
| Stem Separation | Splits source audio into vocals, drums, bass, and other stems for remixing or cleanup |
| Audio to MIDI | Extracts MIDI from audio with Basic Pitch / ONNX plumbing where available |

The base app does not bundle heavy AI runtimes. Optional AI Tools are installed from inside OpenStudio so the core DAW can stay lean.

## DAW Workflow

### Record

- ASIO, WASAPI, and DirectSound device support on Windows.
- Track arming, input selection, input monitoring, punch range, and record modes.
- Audio clips and MIDI clips land directly on the timeline.

### Edit

- Konva-powered arrange view with waveforms, MIDI thumbnails, grid, rulers, time selection, razor areas, and zoom/scroll navigation.
- Clip splitting, trimming, moving, copying, muting, grouping, locking, color, fades, auto-crossfade, reverse, normalize, time stretch, and pitch shift.
- Piano roll for note editing, velocity, CC lanes, pitch bend controls, quantize, scale snap, transpose, reverse, invert, and humanize.

### Mix

- Horizontal mixer with channel strips, master strip, detached mixer window, metering, snapshots, routing controls, sends, buses, phase invert, stereo width, sidechain routing, and monitoring FX.
- Built-in effects and third-party plugins can be used on input FX, track FX, master FX, and monitoring FX chains.

### Tune

- Graphical pitch editor for vocal-style correction with note blobs, contour editing, pitch/drift/vibrato/transition tools, correct-pitch macro, and pitch-editor undo/redo.
- Real-time pitch corrector FX for auto-tune style workflows.
- ARA hosting path for compatible pitch/audio editors.

### Deliver

- Render master mixes, selected-track stems, all stems, selected items, selected items through master, razor edit areas, project regions, or selected regions.
- Export WAV, AIFF, FLAC, MP3, and OGG with mono/stereo, target sample rate, bit depth/quality, normalize, render tail, dither, and secondary output.
- Use render queue, region render matrix, DDP export, batch converter, MIDI export, archive, project compare, and clean project tools for handoff.

## Project And File Formats

- Project files: `.osproj`
- Legacy project import/open: `.s13`
- Theme exports: `.ostheme`
- Legacy theme import: `.s13theme`
- Built-in FX presets: `.ospreset`
- Waveform peak cache: `.ospeaks`
- Legacy peak cache support: `.s13peaks`

## Architecture

```text
C++ / JUCE backend                  React / TypeScript frontend
--------------------------------    --------------------------------
AudioEngine                         App.tsx
PlaybackEngine                      useDAWStore / actionRegistry
AudioRecorder                       NativeBridge.ts
TrackProcessor                      Timeline / PianoRoll / Mixer
PluginManager                       Render / FX / Routing panels
MIDIManager                         Pitch editor stores and canvas
PitchAnalyzer / PitchResynthesizer  Help, shortcuts, command palette
StemSeparator / AITrackEngine       AI workflow modals
ARAHostController                   Theme, scripts, project tools
```

The backend owns audio I/O, recording, playback, plugin processing, MIDI, metering, rendering, pitch/audio analysis, stem separation, and AI worker orchestration. The frontend owns layout, state, timeline interaction, editor panels, keyboard shortcuts, project serialization, and user workflows. The bridge is exposed through `window.__JUCE__.backend.*` and wrapped by `frontend/src/services/NativeBridge.ts`.

## Quick Start

### Requirements

- Windows 10/11 x64 for the primary local development flow
- macOS release packaging support for app/DMG builds
- CMake 3.22 or newer
- Visual Studio 2022 with C++ workload on Windows
- Node.js 18 or newer
- Python 3.10 or newer
- NASM in `PATH` for YSFX builds
- ARA SDK and supported third-party SDK/runtime assets as documented in the repo

### Development

```bash
# Full dev flow: installs deps, builds C++ Debug, starts Vite, launches app
python build.py dev --run
```

Partial rebuilds:

```bash
# Frontend only
cd frontend && npm run dev

# C++ Debug
cmake --build build --config Debug

# C++ Release
cmake --build build --config Release

# Production package path
python build.py prod
```

## macOS First Launch Note

The v1 macOS community package is unsigned. If macOS reports that the app is damaged or blocked after installing from the DMG, remove quarantine:

```bash
xattr -dr com.apple.quarantine /Applications/OpenStudio.app
```

Then open the app from Finder, or right-click and choose **Open** if Gatekeeper asks for confirmation.

## Documentation

- [User Manual](docs/USER_MANUAL.md)
- [Lua Scripting API](docs/API.md)
- [Runtime Dependency Contract](docs/runtime-dependency-contract.md)
- [Release Runbook](docs/release-runbook.md)
- [Release Smoke Checklist](docs/release-smoke-checklist.md)
- [Implemented Features Audit](docs/implemented_features.md)

Historical planning documents remain in `docs/` for traceability, but the codebase and `docs/implemented_features.md` should be treated as the fresher feature inventory.

## Tech Stack

| Layer | Tools |
|---|---|
| Native audio | JUCE 8, ASIO SDK, WASAPI, DirectSound |
| Embedded UI | JUCE WebBrowserComponent, WebView2 on Windows |
| Frontend | React 18, TypeScript, Vite, Zustand, Tailwind CSS, Konva |
| Plugins | JUCE plugin hosting, VST3, CLAP integration, LV2 code paths, ARA SDK |
| Analysis / AI | ONNX Runtime, Basic Pitch model flow, ACE-Step, Stable Audio 3 optional runtime |
| Scripting | Lua / sol2, S13FX / JSFX-style script processor |
| Packaging | CMake, build.py orchestration, platform release scripts |

## Status

OpenStudio is under active development. Many core DAW workflows are implemented, while some professional edge cases remain experimental or partial:

- Polyphonic correction/resynthesis is not at the same maturity as monophonic pitch analysis and editing.
- Some video, control-surface, live-capture, plugin-bridge, and interchange paths are still evolving.
- Heavy AI runtimes are optional and depend on local hardware, installed models, and runtime setup.
- Subjective audio quality claims, especially pitch/formant/stem artifacts, require listening tests.

## License

OpenStudio is distributed in this repository under AGPLv3-compatible terms. See `LICENSE` and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for licensing and dependency notices.
