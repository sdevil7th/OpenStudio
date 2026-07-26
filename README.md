<p align="center">
  <img src="frontend/public/icon.svg" height="112" alt="OpenStudio logo"/>
</p>

<h1 align="center">OpenStudio</h1>

<p align="center">
  <strong>The open-source local-first DAW + AI music production alternative.</strong>
</p>

<p align="center">
  Native JUCE audio, real timeline editing, plugin hosting, local project files, and optional AI tools. No Electron shell, no cloud-only workflow, no locked session model.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue" alt="Platform: Windows and macOS"/>
  <img src="https://img.shields.io/badge/engine-JUCE%208-informational" alt="JUCE 8"/>
  <img src="https://img.shields.io/badge/UI-React%20%2B%20TypeScript-61dafb?logo=react" alt="React and TypeScript"/>
  <img src="https://img.shields.io/badge/audio-ASIO%20%7C%20WASAPI%20%7C%20DirectSound-green" alt="Audio drivers"/>
  <img src="https://img.shields.io/badge/plugins-VST3%20%7C%20CLAP%20%7C%20LV2-orange" alt="Plugin formats"/>
  <img src="https://img.shields.io/badge/guitar-NAM%20A1%20%7C%20A2-f5ae27" alt="Neural Amp Modeler A1 and A2"/>
  <img src="https://img.shields.io/badge/AI-ACE--Step%20%7C%20Stable%20Audio%203-purple" alt="AI music models"/>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>
  |
  <a href="#features-at-a-glance">Features</a>
  |
  <a href="#why-openstudio">Why OpenStudio?</a>
  |
  <a href="docs/USER_MANUAL.md">User Manual</a>
  |
  <a href="docs/API.md">Lua API</a>
</p>

> Screenshot/GIF slot: add a first-run timeline or mixer capture here once the current UI pass is ready.

---

## OpenStudio In One Sentence

OpenStudio is for people who want a real DAW surface, not just a prompt box: record or import material, edit it deeply, host plugins, tune vocals, split stems, generate or transform ideas with local AI tools, and render deliverables without leaving the session.

It combines classic multitrack production with newer tools such as stem separation, audio-to-MIDI, source-conditioned AI generation, graphical pitch editing, and scriptable project operations.

## Features At A Glance

| Area | Current support |
|---|---|
| Recording | Multitrack audio recording, MIDI recording, input monitoring, punch range, record modes |
| Editing | Clip move/trim/split, ripple edit, razor edit, fades, grouping, takes, slip edit, reverse, normalize, time stretch, pitch shift |
| MIDI | MIDI tracks, instrument tracks, piano roll, velocity/CC editing, transforms, virtual keyboard, MIDI import/export, audio-to-MIDI |
| Mixing | Mixer, detached mixer, sends, buses, routing matrix, master strip, meter isolation, mixer snapshots |
| Plugins | VST3, CLAP, LV2 code paths, native plugin editors, input/track/master/monitoring FX, plugin presets, A/B states, MIDI learn |
| Built-in FX | EQ, compressor, gate, limiter, delay, reverb, chorus, saturator, pitch corrector, basic synth/piano/drums |
| Guitar / NAM Rack | Free A1/A2 amp and full-rig capture host, native pedalboard, cabinet IRs, EQ/mod/delay/reverb/shimmer, presets, calibration, project recall, optional TONE3000 connection |
| Pitch | Graphical pitch editor, YIN analysis, note blobs, drift/vibrato tools, real-time auto-tune style FX, Basic Pitch polyphonic detection |
| AI | Optional AI Tools runtime, stem separation, ACE-Step music generation, Stable Audio 3 text-to-audio, clip variation, inpaint, continuation |
| Render | WAV, AIFF, FLAC, MP3, OGG, mono/stereo, sample-rate conversion, normalize, tail, dither, secondary output, stems, regions, razor areas |
| Delivery | Render queue, region render matrix, DDP export, batch converter, session archive, project compare, clean project directory |
| Workflow | Command palette, shortcut reference and rebinding, help overlay, getting started guide, screensets, themes, toolbar editor |
| Extensibility | Lua scripting API, script editor, JSFX/S13FX script effects, project automation helpers |
| Sync / media | Timecode display/settings, big clock, media explorer, media pool, missing media resolver, video window plumbing |

Some advanced features are still evolving. See [Implemented But Partial / Caveated](docs/implemented_features.md#implemented-but-partial--caveated) for the honest edges.

## Why OpenStudio?

Cubase, Pro Tools, and Suno AI are strong products. OpenStudio is aimed at a different lane: a native, open, local-first DAW where recording, editing, mixing, plugin hosting, pitch work, and AI-assisted generation live in the same project.

### OpenStudio NAM Rack vs AmpliTube, Guitar Rig, and Neural DSP

OpenStudio's NAM Rack is a free, open-source alternative for guitarists who want
modern Neural Amp Modeler A1/A2 captures, pedals, cabinets, effects, and the DAW
session in one application. It competes in the same creative category as
AmpliTube, Guitar Rig, and Neural DSP plug-ins without charging to unlock the
rack. Third-party captures and IRs keep their own licenses.

| Capability | OpenStudio NAM Rack | AmpliTube 5 | Guitar Rig 7 | Neural DSP plug-ins |
|---|---|---|---|---|
| Core price/model | ✅ Free and open source; no paid NAM Rack tier | ⚠️ Free CS edition with a limited gear set; larger commercial editions/gear | ⚠️ Free Player with a limited component/preset set; commercial Pro edition | ⚠️ Commercial plug-ins sold by product; time-limited trials available |
| Product shape | ✅ Guitar rig inside a full recording, MIDI, editing, mixing, automation, and render DAW | Amp/effects suite as plug-in and standalone app | Modular guitar/effects rack as plug-in and standalone app | Focused artist/amp suites as plug-ins and standalone apps |
| NAM A1/A2 | ✅ Native open NAM A1/A2 amp and full-rig capture support | ❌ No native NAM A1/A2 host; IK's TONEX uses its own capture ecosystem | ❌ No native NAM A1/A2 host | ❌ No native NAM A1/A2 host |
| Captures and IRs | ✅ Local NAM files, local cabinet IRs, and optional approved TONE3000 discovery/download | ✅ TONEX ecosystem; custom IR capability depends on edition/workflow | ✅ ICM components and custom IR in Guitar Rig Pro | ⚠️ Curated product-specific rigs and cabinets rather than a general NAM library |
| Pedals/effects | ✅ Native compressor, tape echo, octaver, Precision Drive, distortion, creative FX, EQ, modulation, delay, reverb, and shimmer | ✅ Large polished commercial gear ecosystem | ✅ Flexible modular rack; Player includes a smaller selection | ✅ Highly polished chains designed around each product/artist |
| Full DAW project | ✅ Tone, recording, arrangement, automation, mix, and export live in one project | ❌ Requires a host DAW for full production | ❌ Requires a host DAW for full production | ❌ Requires a host DAW for full production |
| Open/customizable | ✅ Inspect, fork, script, and extend the source | ❌ Closed source | ❌ Closed source | ❌ Closed source |
| Where the commercial product still wins | ⚠️ OpenStudio still needs broader musician audition, bundled licensed starter tones, and commercial support maturity | ✅ Very large branded gear catalog and mature commercial polish | ✅ Mature modular UX, broad presets, and established ecosystem | ✅ Curated artist suites, polished presets, and focused commercial support |

Product facts and free-tier distinctions should be rechecked at release time:
[AmpliTube 5](https://www.ikmultimedia.com/products/amplitube5/),
[Guitar Rig 7 Player](https://www.native-instruments.com/en/products/komplete/guitar/guitar-rig-7-player/),
[Guitar Rig 7 Pro](https://www.native-instruments.com/en/products/komplete/guitar/guitar-rig-7-pro/),
[Neural DSP plug-ins](https://neuraldsp.com/plugins), and
[NAM A2](https://www.tone3000.com/guides/nam-a2-the-complete-guide).

### OpenStudio vs Cubase

Cubase is a mature commercial composition DAW. OpenStudio is the open local-first alternative for people who want DAW depth, hackability, and AI workflows without moving the session into a closed product lane.

| Capability | Cubase | OpenStudio |
|---|---|---|
| Pricing / model | ❌ Commercial closed-source DAW | ✅ Open-source app with local project files |
| Full DAW timeline | ✅ Mature arrange, MIDI, scoring, MixConsole, VariAudio | ✅ Multitrack timeline, MIDI, mixer, routing, pitch editor, render tools |
| Recording / editing / mixing | ✅ Decades of polished DAW workflows | ✅ Native JUCE engine, clip editing, takes, razor/ripple edits, sends, buses, mixer snapshots |
| Pitch / stems / audio-to-MIDI | ✅ VariAudio, audio alignment, stem separation in current Cubase Pro | ✅ Graphical pitch editor, real-time pitch corrector, stem separation, Basic Pitch audio-to-MIDI |
| AI generation | ⚠️ Assisted tools, but not a local AI music-generation DAW workflow | ✅ Optional local AI Tools runtime for ACE-Step, Stable Audio 3, variation, inpaint, continuation, stems |
| Plugin ecosystem | ✅ VST ecosystem and Steinberg tooling | ✅ VST3 plus CLAP/LV2 code paths, input/track/master/monitoring FX, JSFX/S13FX, Lua |
| Local / private workflow | ⚠️ Local DAW, but closed commercial product | ✅ Local project files, optional local AI runtime, source-visible implementation |
| Open / customizable | ❌ Closed source | ✅ Fork it, script it, extend it, inspect the engine |
| Where Cubase still wins | ✅ Mature scoring, VariAudio polish, bundled content, commercial support | ⚠️ Some advanced OpenStudio features remain partial or release-hardening dependent |

### OpenStudio vs Pro Tools

Pro Tools is the facility standard. OpenStudio is for producers and builders who want modern DAW workflows, integrated AI creation, and transparent native code without AAX/HDX/session-ecosystem lock-in.

| Capability | Pro Tools | OpenStudio |
|---|---|---|
| Pricing / model | ❌ Commercial closed-source platform | ✅ Open-source app with local-first project control |
| Studio / post standard | ✅ Industry-standard facility workflow, AAX, HDX, advanced post tooling | ⚠️ Strong DAW foundations, but not a Pro Tools session-compatibility replacement |
| Recording / editing / mixing | ✅ Deep tracking, comping, editing, post-production, automation | ✅ Multitrack recording, takes, razor/ripple edits, routing, automation, mixer, render queue |
| Pitch / repair | ✅ Strong ARA and third-party repair ecosystem | ✅ Built-in graphical pitch editor, real-time pitch corrector, ARA host plumbing |
| AI generation | ⚠️ Integrations and assisted workflows, but not a local AI music generator inside the DAW core | ✅ Text-to-music, lyrics+style, text-to-audio, variation, inpaint, continuation, stems |
| Plugin ecosystem | ⚠️ AAX-centered ecosystem | ✅ VST3 plus CLAP/LV2 code paths, built-in FX, JSFX/S13FX, Lua scripting |
| Local / private workflow | ⚠️ Local DAW, but tied to a proprietary ecosystem | ✅ Local files, optional local AI runtime, inspectable source |
| Open / customizable | ❌ Closed source | ✅ Source-visible, scriptable, hackable |
| Where Pro Tools still wins | ✅ Commercial facilities, HDX/AAX workflows, immersive/post pipelines, support ecosystem | ⚠️ OpenStudio is not claiming facility-standard interchange parity |

### OpenStudio vs Suno AI

Suno is fast when you want a whole AI song from a prompt. OpenStudio is for when that idea needs to become an editable production with tracks, clips, MIDI, plugins, pitch work, stems, and export control.

| Capability | Suno AI | OpenStudio |
|---|---|---|
| Product shape | ✅ Cloud AI song-generation service | ✅ Full DAW with optional local AI-assisted generation |
| Full DAW timeline | ❌ Prompt/song workspace, not a native multitrack DAW | ✅ Tracks, clips, timeline editing, MIDI, routing, mixer, render workflows |
| Recording / editing / mixing | ❌ Not built around live recording, native plugins, buses, or deep mix routing | ✅ Record, import, arrange, edit, tune, mix, host plugins, render |
| Pitch / stems / audio-to-MIDI | ⚠️ Stems and editor features depend on Suno plan/workspace | ✅ Stem separation, graphical pitch editor, real-time pitch correction, Basic Pitch audio-to-MIDI |
| AI generation | ✅ Very fast prompt-to-song workflow | ✅ Local/optional ACE-Step and Stable Audio 3 workflows inside a DAW session |
| Plugin ecosystem | ❌ No VST3/CLAP/LV2 DAW plugin chain | ✅ Input, track, master, monitoring FX plus built-in FX and script effects |
| Local / private workflow | ❌ Cloud service; uploads and outputs depend on Suno terms | ✅ Local projects and optional local runtime; users choose what media enters the session |
| Commercial rights | ⚠️ Suno free/basic output is non-commercial; paid tiers grant commercial use rights under Suno terms | ✅ Local DAW project workflow; generated/recorded media remains in the user's production pipeline |
| Where Suno still wins | ✅ Fastest path from prompt to finished AI song | ⚠️ OpenStudio's local AI setup depends on hardware, models, runtime install, and licenses |

### The Honest Edge

OpenStudio is not pretending Cubase and Pro Tools vanish overnight. They have decades of polish, commercial support, huge ecosystems, and deep specialist workflows. Suno is also better when the only goal is instant prompt-to-song output.

OpenStudio's edge is different: a real DAW, local files, native audio, open source, scriptability, plugin hosting, and AI tools that serve the session instead of replacing it.

Comparison style reference: [OmniVoice Studio README](https://github.com/debpalash/OmniVoice-Studio). Product references checked June 12, 2026: [Cubase features](https://www.steinberg.net/cubase/features/), [Cubase editions](https://www.steinberg.net/cubase/compare-editions/), [Pro Tools](https://www.avid.com/pro-tools), [Pro Tools comparison](https://www.avid.com/pro-tools/comparison), [Suno rights help](https://help.suno.com/en/categories/550145-rights-ownership), and [Suno terms](https://suno.com/terms-of-service).

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
- [Documentation Index](docs/README.md)
- [NAM Rack](docs/nam-rack.md)
- [MIDI Editor](docs/midi-editor.md)
- [Release Roadmap](docs/roadmap.md)

Stable guides describe the current product; implementation history remains
available in Git instead of accumulating as dated plan documents.

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
