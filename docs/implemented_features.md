# Implemented DAW Features

This audit treats the codebase as the source of truth: `CMakeLists.txt`, `Source/*`, `frontend/src/App.tsx`, `frontend/src/store/useDAWStore.ts`, store action modules, `frontend/src/store/actionRegistry.ts`, and mounted React panels/modals.

Features are sorted by impact first, then complexity.

Inventory status rule: a feature belongs in the main tables only when a
user-facing workflow is mounted and has the necessary state, bridge, or backend
path. A real but incomplete, hardware-dependent, or code-path-only surface
belongs under [Implemented But Partial / Caveated](#implemented-but-partial--caveated)
and must not be advertised as a complete workflow.

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
| Record modes, record-safe state, input-channel selection, and set-loop-to-time-selection workflow | H | M |
| Transport: play, stop, pause, record, seek, loop, current time | H | M |
| Tempo, time signature, tap tempo, tempo markers | H | M |
| Metronome with accenting, volume, custom/reset click sounds, and render inclusion | M | M |
| Background waveform peak cache and recording waveform previews | H | H |
| MIDI recording preview and completed MIDI clip handoff | H | M |
| Meter events isolated from the track array to avoid playback-time UI churn | M | M |

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
| Takes: add, select active, explode to tracks, and implode clips | M | M |
| Dynamic/transient split workflow | M | H |
| Track spacers, empty audio/MIDI items, and clip launcher | M | M |
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
| Mixer snapshots with save, recall, delete, backend sync, and undoable recall | M | H |
| Track/master automation lanes with read, write, touch, latch, range replacement, and envelope management | H | H |
| Move-envelopes-with-items option | M | M |

## Plugins / FX / Scripting

| Feature | Impact | Complexity |
|---|---:|---:|
| Plugin scanning/loading for hosted FX formats, primarily VST3 with CLAP/LV2 code paths | H | H |
| Native plugin editor window management | H | H |
| Input FX, track FX, master FX, monitoring FX chains | H | H |
| Add, remove, bypass, reorder FX chains | H | M |
| Plugin parameters, presets, state save/load, A/B compare | H | H |
| Plugin MIDI learn and parameter mapping | H | H |
| Track, input, and master FX-chain presets | M | M |
| Built-in FX preset save, load, and delete | M | M |
| Processing precision override / hybrid precision support | M | H |
| Plugin capability matrix, guardrails, release benchmark hooks | M | H |
| Built-in EQ, compressor, gate, limiter, delay, reverb, chorus, saturator | H | H |
| Built-in real-time pitch corrector FX | H | H |
| Built-in FX editors and oversampling controls | M | H |
| NAM Rack A1/A2 pedal, amp, and full-rig capture hosting | H | H |
| NAM Rack Guitar/Bass voicing, native pedalboard, cabinet IR/Cabinet Space, Graphic EQ, modulation, delay, reverb/shimmer, tuner, calibration, presets, A/B, and project recall | H | H |
| NAM Rack multi-capture pack selection with per-capture topology, transactional audition/rollback, Use, replace, bypass, unload, and missing-asset recovery | H | H |
| S13FX / JSFX-style script effects with sliders and reload | H | H |
| S13FX `@gfx` native editor support | M | H |
| Lua script execution, script listing/editor, console output, and app-facing API reference | M | H |

## MIDI / Instruments

| Feature | Impact | Complexity |
|---|---:|---:|
| MIDI device enumeration, input open/close, output routing | H | H |
| MIDI track type, instrument track type, MIDI channel routing | H | M |
| MIDI clips with note storage and playback scheduling | H | H |
| MIDI recording into clips with live preview | H | H |
| Piano roll editor | H | H |
| Docked/detached piano-roll sessions with note, velocity, CC, pitch-bend, and range editing | H | H |
| Virtual piano keyboard | M | M |
| Piano-roll step input state/actions | M | M |
| MIDI panic and input-readiness checks | M | M |
| Quantize using last settings, reset quantize, and freeze quantize | M | M |
| MIDI transforms: transpose/octave, velocity scale, reverse, invert, and scale snap | M | M |
| MIDI import/export and project MIDI export | H | M |
| Load/open virtual instrument on instrument tracks | H | H |
| Built-in basic synth, piano, clean-guitar, drum, and fallback sampler paths | M | H |
| Audio-to-MIDI creates an adjacent MIDI track with undo support | H | H |

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
| Master and per-track stem render paths, plus region/razor range orchestration | H | H |
| Project, custom, time-selection, project-region, and selected-region bounds | H | M |
| Include-metronome and optional secondary-format output | M | M |
| Render queue | M | M |
| Add rendered output back into project | M | M |
| Render filename wildcards | M | M |
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
| Session archive/unarchive | M | H |
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
| Feature-selective AI setup with hardware/model readiness and background progress | H | H |
| Stem separation workflow with selectable stems and progress polling | H | H |
| Stem separation result import into new tracks/clips | H | H |
| AI track type and AI track header controls | M | H |
| ACE-Step text-to-music and lyrics-plus-style generation | H | H |
| Stable Audio 3 Medium text-to-audio generation with gated local snapshot import and license acknowledgement | H | H |
| Source-conditioned variation, inpaint-selection, and continue-clip workflows | H | H |
| AI generation progress/cancel handling | M | H |

## Workflow / UI Customization

| Feature | Impact | Complexity |
|---|---:|---:|
| Central action registry powering menus, shortcuts, command palette | H | H |
| Menu bar, main toolbar, custom toolbar strip/editor | H | M |
| Searchable/printable keyboard-shortcuts modal with 19 built-in DAW profile families | H | H |
| Independent keyboard and mouse/scroll profiles with platform-aware labels and documented gesture targeting | H | H |
| Scoped multi-binding, conflict checks, intentional unassignment, and named custom keyboard-profile import/export | H | H |
| Command palette | H | M |
| Screensets/layout state | M | M |
| Theme editor and custom theme state | M | M |
| Persisted mouse modifier preferences and profile-specific wheel/drag behavior, synchronized to detached windows | M | H |
| Custom actions/macros | M | M |
| High-contrast theme, startup recovery surface, modal guards, and top-level error boundary | M | M |
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
| Track/master channel-format state | M | M |
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
| Drum editor / media pool | Store toggles/actions exist, but no mounted full UI components were found |
| Step sequencer | Store state and actions exist, but no mounted step-sequencer component was found; piano-roll step input is the supported workflow |
| Master FX reorder | Track/input reorder exists; master reorder is noted as unsupported in UI |
| Legacy `executeScript/loadScriptFile` bridge names | Stubbed, but newer `runScript/runScriptCode` paths are implemented |
| Public TONE3000 release | OAuth/catalog/download implementation and deterministic mocks exist; partner approval and a fresh-account release-candidate run remain external gates |
| NAM Rack sonic/noise acceptance | Deterministic DSP/state guards exist; tone, transition perception, and real-interface crackle/noise require audition of the exact release build |
| Selected-item render sources | The two choices are present, but the backend does not yet filter the render to selected clips |
| Render metadata | Metadata fields are shown as a disabled placeholder; the renderer does not write them yet |
| Online render | The current render-dialog control is a disabled UI placeholder |
| Specialist delivery workflows | Region matrix, DDP, batch conversion, immersive delivery, broadcast metadata, and CD-mastering behavior need focused release smoke/hardware validation before strong public claims |
| External sync and control surfaces | MTC, MIDI clock, OSC, and MCU-style paths need release validation with real devices |
| Video | FFmpeg-backed plumbing exists, but this is not a mature post-production video suite |
| Surround/immersive delivery | Channel-layout and VBAP paths exist; dedicated workflow and hardware validation remain open |
| AI generation availability and quality | Optional runtime, model licenses, local hardware, RAM/VRAM, and user audition determine availability and results; large generation models are not bundled with the core app |
| Subjective audio quality | Pitch, formant, stem, generation, and NAM tone/artifact claims require audition; automated diagnostics alone are not acceptance evidence |

