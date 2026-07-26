# OpenStudio Feature Inventory

> **Last updated:** 2026-06-01
>
> **Primary project format:** `.osproj`
>
> **Legacy project format:** `.s13`
>
> **Scope of this update:** current source tree, mounted UI, action registry, frontend bridge, backend native functions, and adjacent feature docs.
>
> **Note:** This file used to be a historical REAPER-parity tracker with stale counts. It is now a current feature inventory. Keep older planning docs for traceability, but use this file, `README.md`, and `docs/implemented_features.md` for public-facing feature claims.

## Status Legend

| Status | Meaning |
|---|---|
| Implemented | User-facing workflow has a UI/action and a store, bridge, or backend path. |
| Partial / Experimental | Real code exists, but the workflow is incomplete, hardware/runtime dependent, or not yet release-hardened. |
| Planned / Stub | UI state, bridge stubs, or planning notes exist, but the feature should not be advertised as complete. |

## Latest Additions Since The Old Tracker

| Area | Latest feature surface |
|---|---|
| AI runtime setup | In-app AI Tools setup with install, cancel, reset, status refresh, feature selection, background install notification, and platform-specific runtime plans. |
| AI music generation | ACE-Step 1.5 XL Turbo workflows for text-to-music and lyrics-plus-style generation. |
| AI audio generation | Stable Audio 3 Medium support for text-to-audio and source-conditioned workflows, including license-gated local model import. |
| Clip AI workflows | Create variation, inpaint selected range, and continue clip from a selected source audio clip. |
| Stem separation | Async stem separation with progress polling, cancellation, selectable stems, and result import to tracks. |
| Audio-to-MIDI | Convert an audio clip to a new MIDI track using polyphonic note extraction where the native Basic Pitch / ONNX path is available. |
| Detached editors | Detached mixer and detached MIDI editor window flows with UI snapshot publishing through the native bridge. |
| MIDI editor depth | Docked or windowed piano roll sessions, velocity/CC lanes, pitch bend controls, quantize, note transforms, and range editing. |
| Render/export | Dither path, secondary output, render queue, region render matrix, DDP export, batch converter, render-in-place, and add-render-to-project options. |
| Routing and mixing | Send/bus routing, routing matrix, sidechain assignment, channel output selection, stereo width, phase invert, pan law, and mixer snapshots. |
| Project delivery | Project compare, archive/unarchive, clean project directory, safe-mode open, project templates, and project tabs. |
| Video and sync | Video window plumbing, FFmpeg-backed video/audio extraction path, MTC input/output, MIDI clock sync state, and timecode settings. |
| Scripting and effects | Lua script editor/API, S13FX/JSFX audio effects, JSFX `@gfx` editor support, plugin A/B states, FX chain presets, and built-in FX presets. |
| Workflow customization | Command palette, shortcuts modal, screensets, theme editor, toolbar editor, custom actions/macros, mouse modifiers, and help surfaces. |

## At A Glance

| Area | Current support |
|---|---|
| Core engine | JUCE C++ audio engine with React/TypeScript WebView UI and synchronous `window.__JUCE__.backend` bridge. |
| Recording | Multitrack audio recording, MIDI recording, punch range, record modes, armed tracks, record-safe state, and input monitoring. |
| Editing | Clip move/trim/split, ripple edit, razor edit, time selection edits, fades, grouping, takes, slip edit, reverse, normalize, time stretch, and pitch shift. |
| MIDI | MIDI and instrument tracks, piano roll, virtual keyboard, MIDI import/export, MIDI output routing, quantize, transforms, CC lanes, and audio-to-MIDI. |
| Mixing | Mixer, detached mixer, sends, buses, routing matrix, master strip, channel strip EQ, metering, automation, mixer snapshots, and sidechains. |
| Plugins | VST3 hosting, CLAP/LV2 code paths, native editors, input/track/master/monitoring FX, presets, A/B states, MIDI learn, and built-in FX. |
| Pitch | Graphical pitch editor, YIN pitch analysis, note blobs, drift/vibrato tools, real-time pitch corrector, polyphonic detection, and ARA host plumbing. |
| AI | Optional local AI Tools runtime for stem separation, ACE-Step music generation, Stable Audio 3 audio generation, variation, inpaint, and continuation. |
| Render | WAV, AIFF, FLAC, MP3, OGG, stems, selected items, razor areas, regions, render queue, region matrix, DDP, batch conversion, dither, metadata, and secondary output. |
| Project tools | `.osproj` save/load, `.s13` legacy support, recent projects, templates, safe mode, autosave/backup, compare, archive, clean directory, missing media resolver. |
| Workflow | Command palette, keyboard shortcuts, menus, screensets, themes, toolbar editor, help overlay, getting started guide, big clock, and timecode settings. |
| Sync/media | MTC/MIDI clock plumbing, control surface manager, OSC support, MCU-style control surface paths, video window, and FFmpeg video extraction. |

## Core Engine, Transport, And Recording

### Implemented

- Native JUCE audio engine with a React/TypeScript UI hosted in WebView2.
- Audio device settings for driver, device, input/output channels, sample rate, buffer size, and channel configuration.
- Sample-rate-aware clip playback and render mixing through the playback engine.
- Transport controls for play, pause, stop, record, seek, rewind, loop, set loop to time selection, and auto-scroll.
- Tempo, tap tempo, time signature, tempo markers, and metronome controls.
- Metronome accenting, volume, custom click/accent sounds, reset sounds, and render-to-file support.
- Multitrack audio recording with track arm, record-safe, input channel selection, monitoring, punch range, and record modes.
- MIDI recording with live preview and completed MIDI clip handoff.
- Background waveform peak cache and recording waveform previews.
- Real-time meter update event flow isolated from track arrays for render performance.

### Partial / Experimental

- External sync paths exist for MTC and MIDI clock, but device and studio integration still needs hardware validation.
- LTC output has a UI/bridge surface, but the backend explicitly treats generation as a stub.
- Live capture output has bridge/store state and should be treated as experimental until fully validated in-session.

## Project, Files, And Media Management

### Implemented

- New, open, save, save as, close project, quit, and unsaved-changes confirmation flows.
- `.osproj` as the primary project extension with `.s13` legacy open/save support.
- Recent projects, startup recovery/diagnostics, and safe-mode project open with FX bypass.
- Project settings for name, notes, sample rate, bit depth, tempo, time signature, author/revision style metadata, and related state.
- Timestamped backup/autosave preferences.
- Project tabs, project templates, save-as-template, and new-from-template flows.
- Project compare with saved version.
- Session archive/unarchive backend paths.
- Media import through native dialogs, drag/drop, and audio/video import path.
- Missing media resolver.
- Media explorer surface, recent paths, and media import workflow.
- Clean project directory tool.
- Batch file converter modal.

### Partial / Experimental

- Media explorer audition/preview should be treated as limited until the backend preview engine is expanded.
- AAF/session interchange code paths exist, but AAF import is not a complete advertised workflow.

## Arrangement And Clip Editing

### Implemented

- Konva timeline with ruler, grid, snap, zoom, scroll, playhead, waveform rendering, MIDI thumbnails, and time selection.
- Audio and MIDI clip creation, media import, drag/drop, move, resize, trim, and track-to-track moves.
- Multi-clip and multi-track selection, select all clips, select all tracks, and deselect all.
- Undo/redo through the command manager for editing operations.
- Cut, copy, paste, duplicate, delete, nudge, and fine nudge.
- Split at cursor and split at time selection.
- Cut/copy/delete within time selection and insert silence.
- Ripple editing modes: off, per-track, and all-tracks.
- Razor edit areas with content deletion and render source support.
- Clip mute, lock, color, volume, pan, fade in/out, fade shape, gain envelope, and clip properties panel.
- Auto-crossfade and a crossfade editor surface.
- Reverse clip, normalize selected clips, time stretch, and clip pitch shift.
- Dynamic split/transient split UI and execution path.
- Slip editing and free item positioning.
- Takes: add take, set active take, explode takes to tracks, and implode clips into takes.
- Track spacers, empty items, empty MIDI items, insert multiple tracks, and folder tracks.
- Clip launcher view.
- Quantize selected clips to grid.

## MIDI And Instruments

### Implemented

- MIDI device enumeration, input opening, output routing, and MIDI panic.
- MIDI tracks and instrument tracks.
- Virtual instrument on new track and quick-add instrument track actions.
- MIDI clip storage, serialization, playback scheduling, import, export, and project MIDI export.
- Piano roll editor with docked and detached/windowed sessions.
- Note draw, edit, select, cut/copy/paste, delete, resize, move, and range operations.
- Velocity editing, CC lanes, pitch bend controls, visible lane preferences, and note inspector style surfaces.
- MIDI quantize using last settings, reset quantize, freeze quantize, and quantize test coverage.
- MIDI transforms: transpose, octave transpose, velocity scale, reverse notes, invert note pitches, and snap selected notes to scale.
- Virtual piano keyboard.
- MIDI input readiness checks before recording.
- Audio-to-MIDI conversion creates a generated MIDI track beside the source track, with undo support.
- Built-in instrument paths for basic synth, piano, drums, and sampler-style state.

### Partial / Experimental

- Drum editor and media pool toggles/actions exist, but should be confirmed as mounted, complete workflows before being advertised heavily.
- Step sequencer/step input state exists in the store surface, but the full user workflow needs validation.

## Mixing, Routing, Metering, And Automation

### Implemented

- Mixer panel, channel strips, master strip, master track in TCP, and detached mixer window.
- Track controls for volume, pan, mute, solo, arm, input monitoring, record-safe, channel count, playback offset, and output channels.
- Master volume, pan, mute, mono, and master automation state.
- Peak/RMS meters, master meter cluster, clipping state, and reset meter clip actions.
- Channel strip EQ modal and built-in channel EQ backend parameters.
- Sends with level, pan, enable, pre/post fader, and phase invert.
- Bus/group tracks and create-bus-from-selected-tracks.
- Routing matrix and track routing modal.
- Sidechain source assignment into plugins.
- Phase invert, stereo width, master send enable, pan law, and DC offset handling.
- Track groups / linked group parameters.
- Mixer snapshots with save, recall, delete, backend sync, and undo on recall.
- Track and master automation lanes with read, write, touch, latch, manual point editing, range replace, backend sync, and envelope manager.
- Move-envelopes-with-items option.
- Loudness meter, phase correlation, and spectrum data bridge paths.

## Plugins, FX, And Scripting

### Implemented

- Plugin scanning and loading for VST3, with CLAP/LV2 code paths present.
- Native plugin editor window management.
- Input FX, track FX, master FX, and monitoring FX chains.
- Add, remove, bypass, reorder, and open editor flows for FX chains.
- Plugin parameters, preset load/save, state save/load, and plugin A/B compare.
- Plugin MIDI learn, mapping list, and clear mapping flows.
- FX chain presets for track, input, and master chains.
- Built-in EQ, compressor, gate, limiter, delay, reverb, chorus, saturator, pitch corrector, and instrument-style processors.
- Built-in FX preset save/load/delete.
- Built-in FX oversampling controls.
- S13FX / JSFX-style script effects.
- JSFX `@gfx` native editor support through `S13FXGfxEditor`.
- Lua script execution, script directory/listing, script editor UI, and console output.
- App-facing Lua API documentation in `docs/API.md`.

### Partial / Experimental

- CLAP and LV2 support should be described as code-path/plugin-format support until compatibility is validated with a plugin test matrix.
- 32-bit plugin bridge is currently a preference/toggle surface, not a completed out-of-process legacy plugin host.

## Pitch, Analysis, And Audio Processing

### Implemented

- Monophonic pitch analysis with YIN contour and note segmentation.
- Graphical pitch editor with note blobs, pitch contour, piano grid, zoom, scroll, and lower-zone UI.
- Pitch editor tools for pitch, drift, vibrato, transition, draw/split style editing, selection, undo, and redo.
- Scale/key snapping, chromatic snap, correct-pitch macro, and scale detection support.
- Offline monophonic graphical pitch correction/apply path.
- Pitch preview, scrub preview, rendered preview segments, and route/status diagnostics.
- Real-time auto-tune style pitch corrector FX.
- Polyphonic detection and audio-to-MIDI extraction through the Basic Pitch / ONNX path where available.
- Audio analyzer, transient detection, and silent-region style analysis utilities.
- ARA host controller lifecycle and track/clip ARA status plumbing.

### Partial / Experimental

- Polyphonic pitch correction/resynthesis is less mature than monophonic pitch editing. Treat detection and MIDI extraction as stronger than polyphonic audio correction.
- Subjective pitch, formant, stem, and artifact quality always requires user audition. Harness diagnostics are not proof of audible quality.

## AI And Assisted Audio

### Implemented

- Optional AI Tools runtime status with refresh, install, cancel, reset, selected feature install, requested feature routing, and setup progress.
- Modular AI Tools feature IDs for `stemSeparation` and `audioGeneration`.
- Hardware/runtime status including GPU support hints and model/runtime readiness.
- Platform runtime packaging plans for Windows DirectML/CUDA and Linux CUDA/ROCm style profiles.
- Stem separation workflow with selectable stems, progress polling, cancellation, and imported result clips/tracks.
- AI track type and AI track header controls.
- AI generation modal and AI workflow parameter fields.
- ACE-Step 1.5 XL Turbo model surface.
- Stable Audio 3 Medium model surface.
- AI workflows:
  - Text to Music
  - Lyrics + Style
  - Text to Audio
  - Create Variation
  - Inpaint Selection
  - Continue Clip
- Source-conditioned AI generation from selected clips, with time-selection requirements for inpaint.
- AI generation progress and cancellation.
- Stable Audio setup includes local snapshot selection and license acknowledgement state.

### Partial / Experimental

- AI generation quality and speed depend on installed optional runtimes, local hardware, available VRAM/RAM, model availability, and accepted model licenses.
- The core app intentionally does not bundle large AI model runtimes.

## Render, Export, And Delivery

### Implemented

- Offline render through the same playback/FX path used by playback.
- Render sources for master, stems, selected tracks, selected media items, selected items through master, and razor edit areas.
- Region render matrix UI.
- Render bounds for entire project, custom range, time selection, project regions, and selected regions where the UI path is available.
- Output directory, filename, and wildcard filename resolution.
- Metadata state for rendered files.
- Formats: WAV, AIFF, FLAC, MP3, and OGG.
- Sample-rate conversion and lossy encoding through FFmpeg where needed.
- Mono/stereo output, bit depth/quality options, normalize, render tail, and include-metronome options.
- Dithered render path through `renderProjectWithDither`.
- Secondary output format and secondary bit depth.
- Online render and add-rendered-output-to-project UI state.
- Render queue panel and queue actions.
- Render clip in place and render track in place.
- Consolidate track.
- Freeze/unfreeze track state and related UI.
- DDP disc image export backend and modal.
- Batch converter modal.
- Export project MIDI.

### Partial / Experimental

- Region render matrix, DDP, batch conversion, online render, and add-to-project workflows should receive release smoke testing before high-confidence public release notes.
- Advanced broadcast metadata, immersive multichannel delivery, and full CD mastering validation remain specialist areas to test separately.

## Workflow, UI, And Customization

### Implemented

- Central action registry used by menus, command palette, shortcut reference, and global shortcuts.
- Menu bar, main toolbar, transport bar, lower zone, mixer, timeline, and modal surfaces.
- Command palette.
- Keyboard shortcuts modal.
- Preferences modal with general, editing, display, and backup preferences.
- Help overlay and getting started guide.
- Big clock and timecode settings.
- Screensets/layout state with save/load actions.
- Theme presets, theme editor, custom theme overrides, theme import/export style state, and high-contrast support.
- Toolbar editor and custom toolbar state.
- Custom actions/macros.
- Mouse modifier preferences and reset.
- Toast notifications, modal safety guards, startup recovery app, and error boundary.
- Detachable panels for mixer and MIDI editor.

## Sync, Control Surfaces, Video, And Pro-Audio Plumbing

### Implemented / Present

- Timecode display and timecode settings panel.
- MTC generator and receiver paths.
- MIDI clock sync source/status plumbing.
- MIDI control surface manager.
- OSC control surface support.
- MCU-style control surface support.
- Video window component.
- FFmpeg-backed video metadata/frame extraction and audio extraction path.
- Surround/channel layout and VBAP panner source modules.
- Track channel format and master channel format state.

### Partial / Experimental

- Video support is functional plumbing, not a full post-production video suite.
- External sync and control surface workflows should be tested with real devices.
- Surround/immersive workflows need dedicated validation before being advertised as mature.

## File Types And Sidecar Assets

| Type | Current role |
|---|---|
| `.osproj` | Primary project file. |
| `.s13` | Legacy project file support. |
| `.ostheme` | Current theme export/import target. |
| `.s13theme` | Legacy theme import support. |
| `.ospreset` | Built-in FX preset style. |
| `.ospeaks` | Current waveform peak cache sidecar. |
| `.s13peaks` | Legacy waveform peak cache sidecar support. |
| `.mid` / `.midi` | MIDI import/export. |
| `.wav`, `.aiff`, `.flac`, `.mp3`, `.ogg` | Render/export and media workflows. |

## Current Caveats To Keep Honest

| Feature | Caveat |
|---|---|
| Polyphonic pitch correction | Detection and MIDI extraction are present; polyphonic audio correction/resynthesis is still less mature. |
| CLAP/LV2 hosting | Code paths exist; plugin compatibility still needs broad validation. |
| 32-bit plugin bridge | Toggle/state exists; full legacy plugin bridge is not complete. |
| LTC output | Bridge surface exists; backend generation is stubbed. |
| Media explorer preview | Import/browse surface exists; audition preview is limited. |
| AAF import/interchange | Source code exists, but it should not be advertised as complete AAF support. |
| Video | FFmpeg-backed video plumbing exists; editing/post-production workflow maturity is still evolving. |
| AI generation | Optional runtime and hardware dependent; model licenses and local setup affect availability. |
| Audio quality claims | Pitch, formant, stem, and generation quality must be validated by listening, not just diagnostics. |

## Source Cross-Reference

- `README.md` - public overview and product positioning.
- `docs/implemented_features.md` - codebase feature audit and caveats.
- `frontend/src/store/actionRegistry.ts` - commands exposed to menus, shortcuts, and command palette.
- `frontend/src/App.tsx` - mounted panels, modals, lower zones, detached windows, and workflow surfaces.
- `frontend/src/services/NativeBridge.ts` - frontend-to-native feature boundary.
- `frontend/src/data/aiWorkflows.ts` - AI models, workflows, and parameters.
- `frontend/src/store/actions/*` - current Zustand action modules.
- `Source/MainComponent.cpp` - native bridge functions exposed to the frontend.
- `Source/AudioEngine.*`, `Source/PlaybackEngine.*`, `Source/TrackProcessor.*`, `Source/MIDIManager.*`, `Source/Pitch*`, `Source/StemSeparator.*`, `Source/AITrackEngine.*`, and related source files - backend feature implementation.
