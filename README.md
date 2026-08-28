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
  <img src="https://img.shields.io/badge/engine-JUCE%209-informational" alt="JUCE 9"/>
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
  <a href="#included-in-openstudio-at-no-charge">Included Free</a>
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
| Guitar / Bass / NAM Rack | Free A1/A2 amp, full-rig, and pedal capture host; explicit capture choice inside multi-capture packs; Guitar/Bass voicing profiles; native pedalboard, cabinet IRs, Cabinet Space, Graphic EQ, modulation, delay, reverb/shimmer, presets, calibration, transactional audition, and project recall; optional TONE3000 connection |
| Pitch | Graphical pitch editor, YIN analysis, note blobs, drift/vibrato tools, real-time auto-tune style FX, Basic Pitch polyphonic detection |
| AI | Optional AI Tools runtime, stem separation, ACE-Step music generation, Stable Audio 3 text-to-audio, clip variation, inpaint, continuation |
| Render | WAV, AIFF, FLAC, MP3, and OGG; target sample rate, mono/stereo, normalize, tail, dither, track stems, and secondary output |
| Delivery | Render queue, region render matrix, DDP export, batch converter, session archive, project compare, and clean-project tools |
| Workflow | Command palette, searchable/printable shortcut reference, 19 built-in DAW keyboard profiles, independently selectable mouse/scroll profiles, scoped rebinding, custom keyboard-profile import/export, help overlay, getting started guide, screensets, themes, toolbar editor |
| Extensibility | Lua scripting API, script editor, JSFX/S13FX script effects, project automation helpers |
| Sync / media | Timecode display/settings, big clock, media explorer browse/import, media-pool plumbing (partial), missing media resolver, video window plumbing |

Some advanced features are still evolving. See [Implemented But Partial / Caveated](docs/implemented_features.md#implemented-but-partial--caveated) for the honest edges.

## Included In OpenStudio At No Charge

OpenStudio does not use a time-limited DAW trial, a paid track-count tier, or a paid
NAM Rack unlock. The base desktop application and the features below are part of
the AGPL-licensed repository. Optional third-party plug-ins, NAM captures,
cabinet IRs, AI models/runtimes, and connected services retain their own
licenses, accounts, hardware requirements, and usage terms.

| Capability | OpenStudio access | Included in the base application |
|---|---|---|
| Multitrack DAW and recording | **Included — free** | Audio/MIDI tracks, recording, monitoring, arrangement, automation, mixer, routing, and export; no app-imposed eight-track tier |
| MIDI note editing | **Included — free** | Piano roll, note/velocity/CC editing, transforms, virtual keyboard, and MIDI import/export |
| Pitch and source workflows | **Included — free** | Graphical monophonic pitch workflow, real-time pitch corrector, stem-separation integration, and audio-to-MIDI plumbing; optional models/runtime may be required |
| Guitar and bass rig | **Included — free** | NAM A1/A2 capture hosting, pedal/amp/full-rig slots, local cabinet-IR loading, native pedalboard and post effects, Guitar/Bass voicing, presets, A/B, and project recall |
| Plug-in and scripting host | **Included — free** | Primarily VST3 hosting with CLAP/LV2 code paths, built-in effects, JSFX/S13FX-style effects, and Lua scripting |
| Hotkey and mouse profiles | **Included — free** | 19 built-in DAW-style keyboard maps, independent mouse/scroll maps, scoped multi-binding, conflict checks, and named custom keyboard profiles with JSON import/export |
| AI-assisted creation | **Free / optional setup** | Local integration for supported generation, variation, inpaint, continuation, stems, and audio-to-MIDI workflows; Basic Pitch is bundled, while large generation/stem runtimes and models are optional downloads and hardware requirements vary |
| Local and inspectable workflow | **Included — free** | Local project files and source-visible JUCE/React implementation under the GNU AGPLv3 |

### Free-access context

This is a product-shape comparison, not a claim that unlike products have the
same depth or maturity. “Free” means the vendor's currently advertised access
model; third-party content and services can still carry separate terms.

| Capability | OpenStudio | Cubase 15 | Pro Tools | REAPER | Suno | Udio |
|---|---|---|---|---|---|---|
| Access model | Full open-source app; no paid DAW/NAM tier | 60-day trial, then a paid license | Intro is free with 8 audio, 8 instrument, and 8 MIDI tracks plus 40 included plug-ins; larger tiers are paid | Fully functional 60-day evaluation, then a discounted or commercial license | Free plan is credit-limited and non-commercial | Free account is credit-limited; audio/stem downloads are currently disabled |
| Desktop DAW + recording | Included without a paid track-count tier; the current engine processes up to 64 real-time tracks | Full commercial DAW during trial/license | Included in track-limited Intro | Full DAW during evaluation/license | Cloud song-generation service; Suno Studio is a Premier feature | Cloud song-generation service; Sessions editing is paid |
| MIDI note editing | Included | Included, edition-dependent feature depth | Included in Intro | Included | Not part of the free plan's conventional DAW workflow | Not a conventional MIDI DAW editor |
| Graphical pitch workflow | Built in | VariAudio in Artist/Pro | Melodyne ARA in Intro requires a separate license or trial | ReaTune manual/automatic pitch correction included during evaluation/license | No note-based pitch editor is advertised in the free plan | Paid Sessions provides waveform generation/editing; no note-based pitch editor is advertised |
| AI song generation | Optional local workflow; no OpenStudio subscription | No full-song prompt generator is advertised; Cubase Pro includes AI stem separation | No full-song prompt generator is advertised in the core DAW | No bundled full-song AI generator is advertised | Free credit-limited generation; paid tiers add models/tools and eligible commercial-use rights | Free credit-limited generation; paid tiers add editing and higher limits |
| Integrated guitar rig / NAM capture support | NAM A1/A2 rack included | VST Amp Rack is included in Elements/Artist/Pro; no advertised native NAM A1/A2 host | Intro includes Eleven Lite and SansAmp; no advertised native NAM A1/A2 host | Can host third-party NAM plug-ins; NAM is not a bundled rack | Not core | Not core |
| Third-party plug-in host | VST3 plus CLAP/LV2 code paths | VST3 ecosystem | Third-party AAX works in Intro and paid tiers | VST/VST3 (including ARA), LV2, CLAP, and JSFX; AU on macOS and DX on Windows | Suno documents no plug-in-host integration or direct DAW sync | No third-party plug-in host is documented |
| Open source | Yes | No | No | No | No | No |

Vendor facts in this table were checked August 28, 2026 against
[Cubase editions](https://www.steinberg.net/cubase/compare-editions/) and
[trial terms](https://www.steinberg.net/cubase/trial/),
[Pro Tools comparison](https://www.avid.com/pro-tools/comparison) and
[current Intro contents](https://www.avid.com/pro-tools/whats-included-with-pro-tools-intro),
[REAPER's product](https://www.reaper.fm/about.php) and
[license](https://www.reaper.fm/purchase.php) pages plus its
[current user guide](https://www.reaper.fm/userguide/ReaperUserGuide779a.pdf),
[Suno pricing](https://suno.com/pricing) and
[terms](https://suno.com/terms-of-service) plus
[Studio 2.0 documentation](https://help.suno.com/en/articles/13670529), and Udio's
[credit limits](https://help.udio.com/en/articles/10739134-credits-and-credit-limits) and
[download notice](https://help.udio.com/en/articles/12683565-changes-associated-with-the-universal-music-group-umg-partnership) plus
[Sessions overview](https://www.udio.com/blog/sessions).

## Why OpenStudio?

Cubase, Pro Tools, and Suno AI are strong products. OpenStudio is aimed at a different lane: a native, open, local-first DAW where recording, editing, mixing, plugin hosting, pitch work, and AI-assisted generation live in the same project.

### OpenStudio NAM Rack vs AmpliTube, Guitar Rig, and Neural DSP

OpenStudio's NAM Rack is a free, open-source alternative for guitar and bass players who want
modern Neural Amp Modeler A1/A2 captures, pedals, cabinets, effects, and the DAW
session in one application. It competes in the same creative category as
AmpliTube, Guitar Rig, and Neural DSP plug-ins without charging to unlock the
rack. Third-party captures and IRs keep their own licenses.

| Capability | OpenStudio NAM Rack | AmpliTube 5 CS | Guitar Rig 7 Player | Neural DSP plug-ins |
|---|---|---|---|---|
| Core access | Free and open source; no paid NAM Rack tier | Free forever with 40+ included gear models; additional gear/editions are paid | Free with 2 amps, matched cabinets, 26 effects/tools, and 60 presets; Pro is paid | Paid per product; 14-day trials are available |
| Product shape | Guitar/bass rig inside a recording, MIDI, editing, mixing, automation, and render DAW | Guitar/bass amp-and-effects suite as a plug-in and standalone app | Modular rack as a plug-in and standalone app | Focused artist/amp suites as plug-ins and standalone apps |
| NAM A1/A2 | Native A1/A2 pedal, amp, and full-rig capture host | Uses IK's own modelling/capture products; no advertised native NAM A1/A2 host | Uses NI components/ICM; no advertised native NAM A1/A2 host | Uses product-specific models; no advertised native NAM A1/A2 host |
| Captures and IRs | Local NAM files, local cabinet IRs, explicit child-capture choice in packs, and an optional TONE3000 path whose production release still requires partner approval | TONEX/Custom Shop ecosystem; availability depends on product and gear | Player has a fixed free selection; Pro advertises an IR loader | Curated product-specific amps/cabs rather than a general NAM library |
| Pedals/effects | Native compressor, EQ Boost, poly octaver, Precision Drive, distortion, Pedal NAM, Graphic EQ, Cabinet Space, modulation, delay, reverb, and shimmer | Broad free starter set plus a large commercial gear catalog | Modular free selection; Pro advertises 26 amps and 115 effects/tools | Product-specific amp, cabinet, and effect chains with factory and artist presets |
| Full DAW project | Tone, recording, arrangement, automation, mix, and export live in one project | Standalone CS includes a 2-track recorder; paid AmpliTube 5 expands it to 8 tracks. AmpliTube also runs as a DAW plug-in | Not a multitrack DAW; runs standalone or inside a host DAW | Not a multitrack DAW; guitar/bass products run standalone or inside a host DAW |
| Open/customizable | Source-visible, forkable, and scriptable | Closed source | Closed source | Closed source |
| Trade-off / scope | Requires broader real-interface musician audition and does not bundle third-party captures/IRs by default | 40+ models in CS; larger paid editions and a 400+ model Custom Shop catalog | Player is limited; Pro lists 26 amps and 115 effects/tools | Each suite is separately licensed and built around product-specific chains/presets |

Product facts and free-tier distinctions should be rechecked at release time:
[AmpliTube 5 CS](https://www.ikmultimedia.com/products/amplitube5cs/) and the
[official AmpliTube edition comparison](https://www.ikmultimedia.com/products/include/at5/gear_list_pdf/AmpliTube_5_v5.10.4_comparison.pdf),
[Guitar Rig 7 Player](https://www.native-instruments.com/products/guitar-rig-player),
[Guitar Rig 7 Pro](https://www.native-instruments.com/products/guitar-rig-pro),
[Neural DSP plug-ins](https://neuraldsp.com/plugins), the
[Neural DSP trial guide](https://neuraldsp.com/getting-started/plugin-quick-start-guide), and
[NAM A2](https://www.tone3000.com/guides/nam-a2-the-complete-guide).

### OpenStudio vs Cubase

Cubase is a mature commercial composition DAW. OpenStudio is the open local-first alternative for people who want DAW depth, hackability, and AI workflows without moving the session into a closed product lane.

| Capability | Cubase | OpenStudio |
|---|---|---|
| Pricing / model | Commercial DAW; current Pro/Elements trials run 60 days | Open-source app with local project files and no paid track-count tier; current real-time engine cap is 64 tracks |
| Full DAW timeline | ✅ Mature arrange, MIDI, scoring, MixConsole, VariAudio | ✅ Multitrack timeline, MIDI, mixer, routing, pitch editor, render tools |
| Recording / editing / mixing | ✅ Decades of polished DAW workflows | ✅ Native JUCE engine, clip editing, takes, razor/ripple edits, sends, buses, mixer snapshots |
| Pitch / stems / audio-to-MIDI | VariAudio 3 is in Artist/Pro; AI stem separation is Pro-only; Audio-to-MIDI chords are in Elements/Artist/Pro | Graphical pitch editor, real-time pitch corrector, stem separation integration, Basic Pitch audio-to-MIDI |
| AI generation | ⚠️ Assisted tools, but not a local AI music-generation DAW workflow | ✅ Optional local AI Tools runtime for ACE-Step, Stable Audio 3, variation, inpaint, continuation, stems |
| Plugin ecosystem | VST3 hosting; ARA 2 in Artist/Pro. VST2 can be enabled in limited cases but is officially unsupported | ✅ VST3 plus CLAP/LV2 code paths, input/track/master/monitoring FX, JSFX/S13FX, Lua |
| Local / private workflow | Local desktop DAW; proprietary software and licensing | ✅ Local project files, optional local AI runtime, source-visible implementation |
| Open / customizable | ❌ Closed source | ✅ Fork it, script it, extend it, inspect the engine |
| Where Cubase still wins | ✅ Mature scoring, VariAudio polish, bundled content, commercial support | ⚠️ Some advanced OpenStudio features remain partial or release-hardening dependent |

### OpenStudio vs Pro Tools

Pro Tools is the facility standard. OpenStudio is for producers and builders who want modern DAW workflows, integrated AI creation, and transparent native code without AAX/HDX/session-ecosystem lock-in.

| Capability | Pro Tools | OpenStudio |
|---|---|---|
| Pricing / model | Free Intro tier plus paid Artist/Studio/Ultimate tiers | Open-source app with local-first project control |
| Studio / post standard | ✅ Industry-standard facility workflow, AAX, HDX, advanced post tooling | ⚠️ Strong DAW foundations, but not a Pro Tools session-compatibility replacement |
| Recording / editing / mixing | ✅ Deep tracking, comping, editing, post-production, automation | ✅ Multitrack recording, takes, razor/ripple edits, routing, automation, mixer, render queue |
| Pitch / repair | All tiers support ARA 2. Intro requires a separately licensed or trial ARA plug-in; active paid subscriptions and perpetual Upgrade Plans include Melodyne essential, RePitch Elements, and other repair tools | Built-in graphical pitch editor, real-time pitch corrector, ARA host plumbing |
| AI generation | ⚠️ Integrations and assisted workflows, but not a local AI music generator inside the DAW core | ✅ Text-to-music, lyrics+style, text-to-audio, variation, inpaint, continuation, stems |
| Plugin ecosystem | AAX Native/AudioSuite across all tiers, plus ARA 2 integration; third-party AAX works in Intro and paid tiers | VST3 plus CLAP/LV2 code paths, built-in FX, JSFX/S13FX, Lua scripting |
| Local / private workflow | Local desktop DAW; proprietary software/licensing with optional connected services | ✅ Local files, optional local AI runtime, inspectable source |
| Open / customizable | ❌ Closed source | ✅ Source-visible, scriptable, hackable |
| Where Pro Tools still wins | ✅ Commercial facilities, HDX/AAX workflows, immersive/post pipelines, support ecosystem | ⚠️ OpenStudio is not claiming facility-standard interchange parity |

### OpenStudio vs Suno AI

Suno provides a dedicated cloud prompt-to-song workflow. OpenStudio is for when that idea needs to become an editable production with tracks, clips, MIDI, plugins, pitch work, stems, and export control.

| Capability | Suno AI | OpenStudio |
|---|---|---|
| Product shape | Core cloud AI song generator; Premier adds the browser-based Suno Studio 2.0 production environment | Full DAW with optional local AI-assisted generation |
| Full DAW timeline | Studio 2.0 adds browser multitrack production to Premier; the free plan does not include it | Tracks, clips, timeline editing, MIDI, routing, mixer, render workflows |
| Recording / editing / mixing | Studio 2.0 adds effects, automation, MIDI, stems, and exports, but Suno documents no direct DAW sync or third-party plug-in host | Record, import, arrange, edit, tune, mix, host plugins, render |
| Pitch / stems / audio-to-MIDI | Free has no stem separation; Pro/Premier add stem tools. No note-based pitch or audio-to-MIDI editor is advertised | ✅ Stem separation, graphical pitch editor, real-time pitch correction, Basic Pitch audio-to-MIDI |
| AI generation | Fast cloud prompt-to-song workflow; free access is credit-limited | Local/optional ACE-Step and Stable Audio 3 workflows inside a DAW session |
| Plugin ecosystem | Suno documents no plug-in-host integration or direct DAW sync | ✅ Input, track, master, monitoring FX plus built-in FX and script effects |
| Local / private workflow | ❌ Cloud service; uploads and outputs depend on Suno terms | ✅ Local projects and optional local runtime; users choose what media enters the session |
| Commercial rights | Free-plan songs are for personal, non-commercial use; eligible songs made while subscribed to Pro/Premier receive commercial-use rights, subject to Suno's current terms and feature-specific restrictions | OpenStudio adds no cloud-service rights tier; rights still depend on the user's source media, models, and third-party licenses |
| Product-focus difference | Dedicated cloud prompt-to-song workflow | OpenStudio's optional local AI setup depends on hardware, models, runtime installation, and licenses |

### The Honest Edge

OpenStudio is not pretending Cubase and Pro Tools vanish overnight. They have decades of polish, commercial support, huge ecosystems, and deep specialist workflows. Suno focuses specifically on cloud prompt-to-song output.

OpenStudio's edge is different: a real DAW, local files, native audio, open source, scriptability, plugin hosting, and AI tools that serve the session instead of replacing it.

Comparison style reference: [OmniVoice Studio README](https://github.com/debpalash/OmniVoice-Studio). Product references were rechecked August 28, 2026: [Cubase features](https://www.steinberg.net/cubase/features/), [Cubase editions](https://www.steinberg.net/cubase/compare-editions/), [Pro Tools](https://www.avid.com/pro-tools), [Pro Tools Intro FAQ](https://kb.avid.com/pkb/articles/en_US/Knowledge/Pro-Tools-Intro-FAQ), [REAPER](https://www.reaper.fm/about.php), [Suno pricing](https://suno.com/pricing), [Suno Studio 2.0](https://help.suno.com/en/articles/13670529), [Suno rights help](https://help.suno.com/en/categories/550145-rights-ownership), and [Suno terms](https://suno.com/terms-of-service).

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

- Render master mixes and selected/all-track stems over project, custom, time-selection, and region ranges. A razor-area job renders that range from its owning track stem.
- Export WAV, AIFF, FLAC, MP3, and OGG with mono/stereo output, target sample rate, bit depth/quality, normalize, render tail, dither, and an optional secondary format.
- Use render queue, region render matrix, DDP export, batch converter, MIDI export, archive, project compare, and clean-project tools for handoff. Selected-item-only source filtering remains caveated in the [partial-feature inventory](docs/implemented_features.md#implemented-but-partial--caveated).

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

The v1 macOS community package is unsigned. Verify the published SHA-256 checksum, try to open the app once, then use **System Settings > Privacy & Security > Open Anyway** and confirm **Open**. This is Apple's per-app override and preserves the diagnostic distinction between Gatekeeper and an OpenStudio startup failure.

Only when diagnosing a verified artifact that still cannot be approved through the macOS UI, compare behavior after removing quarantine:

```bash
xattr -dr com.apple.quarantine /Applications/OpenStudio.app
```

Removing quarantine is not the preferred installation path because it recursively removes download provenance from the bundle.

## Documentation

- [User Manual](docs/USER_MANUAL.md)
- [Lua Scripting API](docs/API.md)
- [Runtime Dependency Contract](docs/runtime-dependency-contract.md)
- [Release Runbook](docs/release-runbook.md)
- [Release Smoke Checklist](docs/release-smoke-checklist.md)
- [Implemented Features Audit](docs/implemented_features.md)
- [Documentation Index](docs/README.md)
- [NAM Rack](docs/nam-rack.md)
- [Keyboard and Mouse Profiles](docs/input-profiles.md)
- [MIDI Editor](docs/midi-editor.md)
- [Release Roadmap](docs/roadmap.md)

Stable guides describe the current product; implementation history remains
available in Git instead of accumulating as dated plan documents.

## Tech Stack

| Layer | Tools |
|---|---|
| Native audio | JUCE 9.0.1, ASIO SDK, WASAPI, DirectSound |
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

OpenStudio is distributed in this repository under the GNU AGPLv3. See `LICENSE` and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for licensing and dependency notices.
