# Implemented DAW Features

This audit treats the codebase as the source of truth: `CMakeLists.txt`, `Source/*`, `frontend/src/App.tsx`, `frontend/src/store/useDAWStore.ts`, store action modules, `frontend/src/store/actionRegistry.ts`, and mounted React panels/modals.

Features are sorted by impact first, then complexity.

Ratings:

- `H`: High
- `M`: Medium
- `L`: Low

## Core Engine / Transport

| Feature | Impact | Complexity |
|---|---:|---:|
| JUCE audio engine with React/WebView2 frontend bridge | H | H |
| Real-time playback engine with sample-rate-aware clip mixing | H | H |
| Audio device setup: driver, I/O, sample rate, buffer, channels | H | H |
| Multitrack audio recording with armed tracks, monitoring, punch range | H | H |
| Transport: play, stop, pause, record, seek, loop, current time | H | M |
| Tempo, time signature, tap tempo, tempo markers | H | M |
| Metronome with accenting, volume, custom sounds, render-to-track | M | M |
| Background waveform peak cache and recording waveform previews | H | H |
| MIDI recording preview and completed MIDI clip handoff | H | M |

## Arrangement / Editing

| Feature | Impact | Complexity |
|---|---:|---:|
| Konva-based timeline with ruler, grid, zoom, scroll, snap | H | H |
| Audio and MIDI clip creation, import, drag/drop, move, trim, resize | H | H |
| Multi-clip and multi-track selection | H | M |
| Split, cut, copy, paste, duplicate, delete, nudge, fine nudge | H | M |
| Time selection editing: cut, copy, delete, insert silence | H | H |
| Razor edit areas and razor content deletion | H | H |
| Slip editing, free item positioning, ripple modes | H | H |
| Clip fades, clip volume, gain envelopes, mute, lock, color | H | M |
| Clip reverse, normalize, time stretch, pitch shift | H | H |
| Auto-crossfade and crossfade editor | H | M |
| Takes: explode, implode, active-take style state | M | M |
| Markers, named markers, regions, region manager | H | M |
| Tempo marker support | H | M |
| Quantize selected clips | M | M |

## Mixing / Routing / Metering

| Feature | Impact | Complexity |
|---|---:|---:|
| Mixer panel, channel strips, master strip, detached mixer | H | H |
| Track volume, pan, mute, solo, arm, monitor controls | H | M |
| Master volume, pan, mute, mono, master automation | H | M |
| Peak/RMS metering, master meter, clipping reset | H | H |
| Track sends, send pan/level/phase, pre/post routing | H | H |
| Routing matrix and track routing modal | H | H |
| Bus tracks, folder tracks, create bus from selected tracks | H | M |
| Track groups / linked group params | M | H |
| Sidechain routing into plugins | H | H |
| Phase invert, stereo width, pan law, DC offset handling | M | M |
| Output channel selection, track channel count, playback offset | M | M |
| LUFS measurement, phase correlation, spectrum data | M | H |
| Channel strip EQ modal | M | M |

## Plugins / FX / Scripting

| Feature | Impact | Complexity |
|---|---:|---:|
| Plugin scanning/loading for hosted FX formats, primarily VST3 with CLAP/LV2 code paths | H | H |
| Native plugin editor window management | H | H |
| Input FX, track FX, master FX, monitoring FX chains | H | H |
| Add, remove, bypass, reorder FX chains | H | M |
| Plugin parameters, presets, state save/load, A/B compare | H | H |
| Plugin MIDI learn and parameter mapping | H | H |
| Processing precision override / hybrid precision support | M | H |
| Plugin capability matrix, guardrails, release benchmark hooks | M | H |
| Built-in EQ, compressor, gate, limiter, delay, reverb, chorus, saturator | H | H |
| Built-in real-time pitch corrector FX | H | H |
| Built-in FX editors and oversampling controls | M | H |
| S13FX / JSFX-style script effects with sliders and reload | H | H |
| S13FX `@gfx` native editor support | M | H |
| Lua script execution, script listing, script editor UI | M | H |

## MIDI / Instruments

| Feature | Impact | Complexity |
|---|---:|---:|
| MIDI device enumeration, input open/close, output routing | H | H |
| MIDI track type, instrument track type, MIDI channel routing | H | M |
| MIDI clips with note storage and playback scheduling | H | H |
| MIDI recording into clips with live preview | H | H |
| Piano roll editor | H | H |
| MIDI note draw/edit/select, velocity, CC editing | H | H |
| Virtual piano keyboard | M | M |
| Step sequencer and step input state/actions | M | M |
| MIDI transforms: transpose, velocity scale, reverse, invert | M | M |
| MIDI import/export and project MIDI export | H | M |
| Load/open virtual instrument on instrument tracks | H | H |

## Pitch / Audio Analysis

| Feature | Impact | Complexity |
|---|---:|---:|
| Monophonic pitch analysis with YIN contour and note segmentation | H | H |
| Graphical pitch editor with blobs, contour, piano grid, zoom/scroll | H | H |
| Pitch tools: pitch, drift, vibrato, transition, draw, split | H | H |
| Scale/key snapping, chromatic snap, correct-pitch macro, scale detection | H | H |
| Offline monophonic pitch correction render/apply path | H | H |
| Pitch preview, scrub preview, HQ note/full-clip render states | H | H |
| Real-time auto-tune style pitch corrector plugin | H | H |
| Pitch editor undo/redo and A/B style comparison state | M | M |
| Transient detection and silent-region detection | M | M |
| Polyphonic pitch detection and MIDI extraction via Basic Pitch / ONNX | H | H |
| Stem-aware / AI-adjacent audio analysis plumbing | M | H |

## Rendering / Export / Interchange

| Feature | Impact | Complexity |
|---|---:|---:|
| Offline project render through the same playback/FX engine | H | H |
| Render formats: WAV, AIFF, FLAC, MP3, OGG | H | H |
| Render options: sample rate, bit depth/quality, mono/stereo, normalize, tail | H | M |
| Dithered render path | M | H |
| Stem/track render code path and region render matrix UI | H | H |
| Render queue | M | M |
| Add rendered output back into project | M | M |
| Render metadata and filename wildcards | M | M |
| Render in place, consolidate track, freeze/unfreeze | H | H |
| Batch audio converter | M | M |
| DDP export | M | H |
| Session archive/unarchive | M | H |
| RPP import and RPP/EDL export | M | H |

## Project / Media Management

| Feature | Impact | Complexity |
|---|---:|---:|
| Project new/open/save/save as/close, unsaved changes flow | H | H |
| Recent projects and startup recovery/diagnostics | M | M |
| Project tabs | M | M |
| Project settings, notes, author/revision metadata | M | M |
| Project templates and save-from-template flow | M | M |
| Safe-mode project open / FX bypass recovery path | H | M |
| Media import and drag/drop handling | H | M |
| Missing media resolver | H | M |
| Media explorer browse/import | M | M |
| Clean project directory tool | M | M |
| Project compare | M | M |
| Preferences, autosave/backup/display/editing settings | M | M |

## AI / Assisted Audio

| Feature | Impact | Complexity |
|---|---:|---:|
| AI tools runtime status, install, cancel, reset flow | H | H |
| Stem separation workflow with selectable stems and progress polling | H | H |
| Stem separation result import into new tracks/clips | H | H |
| AI track type and AI track header controls | M | H |
| Text-to-music generation workflow | H | H |
| Lyrics + style music generation workflow | H | H |
| AI generation progress/cancel handling | M | H |

## Workflow / UI Customization

| Feature | Impact | Complexity |
|---|---:|---:|
| Central action registry powering menus, shortcuts, command palette | H | H |
| Menu bar, main toolbar, custom toolbar strip/editor | H | M |
| Keyboard shortcuts modal and global shortcut handling | H | M |
| Command palette | H | M |
| Screensets/layout state | M | M |
| Theme editor and custom theme state | M | M |
| Mouse modifier preferences | M | M |
| Big clock and timecode display settings | M | M |
| Help overlay and getting started guide | L | M |
| App updater hooks | M | M |
| Crash diagnostics source/module present | M | M |

## Sync / Control / Video / Pro Tools

| Feature | Impact | Complexity |
|---|---:|---:|
| MIDI clock output/input | M | H |
| MTC output/input and sync status/source management | M | H |
| Control surface manager with MIDI learn/mappings | M | H |
| OSC connection support | M | H |
| MCU-style control surface support | M | H |
| Video window, video metadata/frame extraction, audio extraction path | M | H |
| Surround/channel layout and VBAP panner code paths | M | H |
| ARA host controller lifecycle and track ARA status plumbing | H | H |

## Implemented But Partial / Caveated

These have real code surfaces, but should not be counted as fully delivered DAW features yet.

| Feature | Status |
|---|---|
| Polyphonic pitch correction / solo-note resynthesis | Detection and MIDI extraction exist; `PolyResynthesizer` is still stub-like |
| AAF import | Stubbed in session interchange |
| LTC output | Bridge stub exists, not a real implementation |
| Live capture start/stop | Bridge stubs exist |
| Media Explorer audio preview | UI exists; backend preview function appears to only acknowledge/log |
| AI continuation workflow | Present in workflow list but marked unavailable |
| Drum editor / media pool | Store toggles/actions exist, but no mounted full UI components were found |
| Master FX reorder | Track/input reorder exists; master reorder is noted as unsupported in UI |
| Legacy `executeScript/loadScriptFile` bridge names | Stubbed, but newer `runScript/runScriptCode` paths are implemented |

