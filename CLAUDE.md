# Studio13-v3

A hybrid DAW (Digital Audio Workstation) with a **JUCE C++ backend** for audio processing and a **React/TypeScript frontend** rendered in WebView2.

## Architecture

```
C++ (JUCE) Backend          React/TypeScript Frontend
┌─────────────────────┐     ┌──────────────────────────┐
│ AudioEngine          │◄───►│ NativeBridge.ts          │
│ PlaybackEngine       │     │   (window.__JUCE__)      │
│ AudioRecorder        │     ├──────────────────────────┤
│ TrackProcessor       │     │ useDAWStore.ts (Zustand)  │
│ PluginManager        │     ├──────────────────────────┤
│ MIDIManager          │     │ Timeline.tsx (Konva)      │
│ Metronome            │     │ MixerPanel / ChannelStrip │
│ MainComponent        │     │ TransportBar / MenuBar    │
│   (WebBrowserComponent)    │ FXChainPanel / PianoRoll  │
└─────────────────────┘     └──────────────────────────┘
```

- **C++ backend** handles: audio I/O, recording to disk, clip playback with sample-rate conversion, VST3 plugin hosting, MIDI device management, metering, offline render/export
- **React frontend** handles: all UI, state management (Zustand), canvas-based timeline (Konva/react-konva), keyboard shortcuts, drag-and-drop, project save/load
- **Communication**: synchronous bridge via `window.__JUCE__.backend.*` functions (defined in NativeBridge.ts, exposed in MainComponent.cpp)

## Directory Structure

```
Studio13-v3/
├── Source/                      # C++ backend
│   ├── Main.cpp                 # JUCE app entry point
│   ├── MainComponent.h/cpp      # Hosts WebBrowserComponent + AudioEngine, exposes native functions to JS
│   ├── AudioEngine.h/cpp        # Core audio callback, device management, track graph, render, pitch correction entry point
│   ├── PlaybackEngine.h/cpp     # Clip playback scheduling, sample-rate-aware mixing, replaceClipAudioFile
│   ├── AudioRecorder.h/cpp      # Thread-safe recording via juce::AudioFormatWriter::ThreadedWriter
│   ├── TrackProcessor.h/cpp     # Per-track juce::AudioProcessor: metering, FX chain, input monitoring
│   ├── PluginManager.h/cpp      # VST3/CLAP/LV2 plugin scanning and loading
│   ├── PluginWindowManager.h/cpp# Native plugin editor window management
│   ├── CLAPPluginFormat.h/cpp   # CLAP plugin hosting (parameter discovery, GUI, state)
│   ├── MIDIManager.h/cpp        # MIDI device enumeration and input routing
│   ├── MIDIClip.h/cpp           # MIDI note event storage and time-range queries
│   ├── Metronome.h/cpp          # Click track generation (BPM, time sig, accent patterns)
│   ├── AudioConverter.h/cpp     # Channel/sample-rate conversion utilities
│   ├── PeakCache.h/cpp          # REAPER-style multi-resolution peak cache (.s13peaks sidecar files)
│   ├── AudioAnalyzer.h/cpp      # Audio analysis utilities
│   ├── BuiltInEffects.h/cpp     # Built-in audio effects (EQ, compressor, etc.)
│   ├── BuiltInEffects2.h/cpp    # Additional built-in effects
│   │
│   │   # Pitch Editor / Correction Pipeline (see "Pitch Editor Subsystem" below)
│   ├── PitchAnalyzer.h/cpp      # YIN monophonic pitch detection, note segmentation, pitchDrift
│   ├── PitchDetector.h/cpp      # Low-level YIN pitch detection algorithm
│   ├── PitchMapper.h/cpp        # Maps detected pitch to corrected pitch (scale/key snapping)
│   ├── PitchShifter.h/cpp       # Phase vocoder pitch shifter (FFT 2048, hop 512, FIFO-based)
│   ├── PitchResynthesizer.h/cpp # Offline pitch correction: builds correction curve, applies via RubberBand (default), WORLD, or phase vocoder
│   ├── RubberBandShifter.h/cpp  # Rubber Band Library R3 wrapper: multi-channel, per-block pitch ratios, formant preservation
│   ├── FormantPreserver.h/cpp   # WORLD vocoder (DIO+StoneMask+CheapTrick+D4C) for formant-preserving pitch shift (fallback)
│   ├── PolyPitchDetector.h/cpp  # Polyphonic pitch detection via Basic-Pitch ONNX model
│   ├── PolyResynthesizer.h/cpp  # Polyphonic pipeline: STFT→Wiener masks→per-note shift→accumulate→ISTFT
│   ├── HarmonicMaskGenerator.h/cpp # Wiener-filter soft masks at harmonic positions for poly separation
│   ├── SpectralPitchShifter.h/cpp  # Phase vocoder on masked spectrograms with cepstral formant preservation
│   ├── SpectralProcessor.h/cpp  # STFT/ISTFT utilities for spectral processing
│   ├── S13PitchCorrector.h/cpp  # Real-time inline pitch corrector (auto-tune style)
│   │
│   │   # Plugin System
│   ├── S13FXProcessor.h/cpp     # JSFX/Lua script-based audio processor (wraps YSFX)
│   ├── S13FXGfxEditor.h/cpp     # JSFX @gfx rendering via juce::Image framebuffer at 30fps
│   ├── S13PluginEditors.h/cpp   # Built-in plugin editor windows
│   ├── S13ScriptWindow.h/cpp    # Lua gfx API framebuffer window
│   ├── ScriptEngine.h/cpp       # Lua scripting engine (sol2)
│   │
│   │   # Other Features
│   ├── StemSeparator.h/cpp      # AI stem separation (vocals/drums/bass/other)
│   └── ARAHostController.h/cpp  # ARA plugin hosting controller
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Main layout: MenuBar → MainToolbar → workspace(TCP + Timeline) → TransportBar → LowerZone → Modals
│   │   ├── main.tsx             # React entry point
│   │   ├── index.css            # Tailwind theme with daw-* custom colors
│   │   ├── store/
│   │   │   ├── useDAWStore.ts   # Zustand store — all app state and actions (~3400 lines)
│   │   │   ├── actionRegistry.ts # Centralized action defs for Command Palette, shortcuts, menus
│   │   │   ├── pitchEditorStore.ts # Pitch editor Zustand store: notes, viewport, tools, undo, poly mode
│   │   │   ├── automationParams.ts # Automation parameter definitions
│   │   │   └── commands/        # Undo/redo: CommandManager.ts, TrackCommands.ts, ClipCommands.ts
│   │   ├── services/
│   │   │   └── NativeBridge.ts  # Type-safe bridge to C++ backend (with mock fallbacks for dev)
│   │   ├── utils/
│   │   │   └── snapToGrid.ts   # Musical grid snapping (bar, beat, subdivisions)
│   │   └── components/
│   │       ├── Timeline.tsx     # Konva canvas: clips, waveforms, rulers, zoom, drag, selection (~2100 lines)
│   │       ├── TransportBar.tsx # Bottom bar: play/stop/record, BPM, time display, loop, metronome
│   │       ├── MixerPanel.tsx   # Horizontal mixer with ChannelStrip components
│   │       ├── ChannelStrip.tsx # Track volume fader, pan, solo/mute, FX, meter
│   │       ├── ChannelStripEQModal.tsx # Per-channel EQ editor
│   │       ├── TrackHeader.tsx  # Track name, arm, solo, mute, input selector
│   │       ├── TrackRoutingModal.tsx   # Track I/O routing configuration
│   │       ├── SortableTrackHeader.tsx # @dnd-kit wrapper for track reordering + context menu
│   │       ├── FXChainPanel.tsx # Plugin browser + FX chain management (input FX + track FX)
│   │       ├── PianoRoll.tsx    # MIDI note editor (Konva canvas)
│   │       ├── VirtualPianoKeyboard.tsx # 88-key on-screen MIDI keyboard
│   │       ├── MainToolbar.tsx  # Top toolbar: transport, undo/redo, snap, mixer toggle, settings
│   │       ├── MenuBar.tsx      # File/Edit/View/Insert/Help dropdown menus
│   │       ├── SettingsModal.tsx # Audio device configuration (driver, I/O, sample rate, buffer)
│   │       ├── RenderModal.tsx  # Export dialog (format, bit depth, channels, normalize, tail)
│   │       ├── PreferencesModal.tsx # Tabbed prefs: General, Editing, Display, Backup
│   │       ├── ProjectSettingsModal.tsx # Project-level settings
│   │       ├── KeyboardShortcutsModal.tsx # Searchable action/shortcut reference (from actionRegistry)
│   │       ├── CommandPalette.tsx # Ctrl+Shift+P fuzzy action search
│   │       ├── PluginBrowser.tsx # VST3/CLAP/LV2 plugin selection UI
│   │       ├── LowerZone.tsx    # Bottom panel container (pitch editor, clip properties, etc.)
│   │       ├── ClipPropertiesPanel.tsx  # Clip property inspector
│   │       ├── ClipLauncherView.tsx     # Ableton-style clip launcher grid
│   │       │
│   │       │   # Pitch Editor UI
│   │       ├── PitchCorrectorPanel.tsx  # Real-time inline corrector (auto-tune style, key/scale/retune)
│   │       ├── PitchEditorLowerZone.tsx # Graphical pitch editor: canvas host, tools, controls, interaction handlers
│   │       ├── PitchEditorCanvas.ts     # Imperative canvas renderer (60fps RAF loop): notes, contour, grid, piano keys
│   │       ├── S13PitchEditor.tsx       # Pitch editor wrapper/container
│   │       ├── pitchCorrectorPresets.ts # Preset definitions for real-time pitch corrector
│   │       │
│   │       │   # Other
│   │       ├── StemSeparationModal.tsx  # AI stem separation UI
│   │       ├── EnvelopeManagerModal.tsx # Automation envelope management
│   │       ├── TimecodeSettingsPanel.tsx # Timecode display settings
│   │       ├── ThemeEditor.tsx  # Theme customization + REAPER theme import
│   │       ├── GettingStartedGuide.tsx  # First-run guide
│   │       ├── HelpOverlay.tsx  # Contextual help overlay
│   │       ├── MasterTrackHeader.tsx    # Master track control strip
│   │       ├── Playhead.tsx     # Timeline playhead cursor
│   │       ├── PeakMeter.tsx    # Audio level meters
│   │       ├── icons.tsx        # SVG icon components
│   │       ├── menus/           # MenuDropdown.tsx, EditMenu.tsx
│   │       └── ui/              # Base components: Button, Input, Select, NativeSelect, Slider, Modal, Checkbox, Textarea, TimeSignatureInput
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── tools/                       # ffmpeg.exe, stem_separator.py, setup scripts
├── resources/                   # ONNX models, presets, resources
├── build/                       # CMake build output
├── CMakeLists.txt               # C++ build: JUCE 8.0.0, ASIO SDK, WebView2, VST3, ONNX Runtime
├── build.py                     # Python orchestrator: cmake + npm + vite dev server
├── pitch_corrector_feat_plan.md # Detailed pitch editor implementation plan (Melodyne/RePitch/VariAudio parity)
└── WORKFLOWS.md                 # Dev workflow docs
```

## Build & Dev

```bash
# Full dev (installs deps, builds C++ Debug, starts Vite HMR, launches app)
python build.py dev --run

# Frontend only (no C++ rebuild needed for UI changes)
cd frontend && npm run dev

# C++ rebuild only — Debug (for Source/ changes, skips cmake configure if already done)
cmake --build build --config Debug

# C++ rebuild only — Release
cmake --build build --config Release

# Production (builds frontend + Release C++, single .exe with embedded frontend)
python build.py prod
```

**No feature flags** — all features (ASIO, WASAPI, DirectSound, VST3 hosting, WebView2) are always enabled via hardcoded `target_compile_definitions` in CMakeLists.txt. The `build.py dev` mode uses Debug config; `build.py prod` uses Release.

## Key Technical Details

### State Management
- **Zustand** store in `useDAWStore.ts` holds all application state (~3400 lines)
- `useShallow` selectors prevent unnecessary re-renders
- Undo/redo via CommandManager pattern (TrackCommands, ClipCommands)
- Multi-clip selection: `selectedClipIds: string[]`, multi-track: `selectedTrackIds: string[]`
- Clipboard supports single and multi-clip with track position info
- **Action Registry** (`actionRegistry.ts`): centralized list of all actions with id, name, category, shortcut, execute. Used by CommandPalette, KeyboardShortcutsModal, and menus
- **Modal state pattern**: each modal follows `showX: boolean` + `toggleX()` in store + useShallow selector in App.tsx + keyboard shortcut + menu item + action registry entry

### Undo/Redo Requirement (IMPORTANT)

**Every new action/function that modifies clip or track data MUST be tracked via `commandManager.push()` or `commandManager.execute()`.** This includes but is not limited to:

- Adding, removing, moving, splitting, resizing clips
- Changing clip properties: volume, pan, fades, color, mute, lock, groupId, reverse
- Paste, nudge, quantize, normalize operations
- Time selection operations (cut, delete, insert silence)
- Razor edit content deletion
- Track property changes (name, color, volume, pan, mute, solo, armed)

**Pattern for adding undo support:**

1. **Before** the `set()` call, capture old state (snapshot or specific values)
2. **After** the `set()` call, capture new state
3. Call `commandManager.push({ type, description, timestamp, execute: () => set(newState), undo: () => set(oldState) })`
4. Call `set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() })`

For **continuous edits** (faders, knobs), use the begin/commit pattern: `beginXEdit()` captures initial state, intermediate `setX()` calls update live without undo, `commitXEdit()` pushes a single undo command covering the full range.

**Do not skip undo tracking** — users expect Ctrl+Z to undo any data-modifying action.

### Timeline Rendering
- **Konva** (react-konva) for canvas-based rendering
- Waveform peaks fetched from C++ via `getWaveformPeaks(filePath, samplesPerPixel, numPixels)` — backed by PeakCache (`.s13peaks` files), never reads audio files directly
- `samplesPerPixel` uses the clip's `sampleRate` (not hardcoded) with power-of-2 quantization for cache stability
- Zoom: exponential scaling via `Math.exp(-deltaY * sensitivity)`, anchored to cursor position
- Zoom debounce: suppresses waveform re-fetches during active zoom (`isZoomingRef`, 200ms timeout)
- Scroll debounce: suppresses waveform re-fetches during active scrolling (`isScrollingRef`, 200ms timeout)
- In-flight request dedup: `inFlightRef` prevents duplicate concurrent bridge calls for the same waveform cache key
- Zoom range: 1–1000 pixels/second (clamped in both Timeline.tsx and store's `setZoom`)
- Waveform peak data is parsed from flat C++ arrays into `WaveformPeak[]` objects via `parseFlatPeaks()` in NativeBridge.ts — format: `[numChannels, min_ch0_px0, max_ch0_px0, min_ch1_px0, max_ch1_px0, ...]`

### Audio Engine
- Sample rate conversion in PlaybackEngine: linear interpolation when file rate != device rate
- Render uses same PlaybackEngine.fillTrackBuffer() — automatically handles rate conversion
- FX plugins: per-track input FX chain + track FX chain + master FX chain
- Render re-prepares plugins for offline block size, restores state after

### Pitch Editor Subsystem

The pitch editor enables vocal pitch correction with both real-time (auto-tune style) and graphical (Melodyne-style) modes. The implementation plan for reaching Melodyne/RePitch/VariAudio quality is in `pitch_corrector_feat_plan.md`.

**Architecture**:
```
Monophonic pipeline (default — Rubber Band):
  PitchAnalyzer (YIN) → PitchNotes → PitchResynthesizer::processMultiChannel() → RubberBandShifter (R3 engine)

Monophonic pipeline (fallback — WORLD):
  PitchAnalyzer (YIN) → PitchNotes → PitchResynthesizer::process() → FormantPreserver (WORLD vocoder)

Polyphonic pipeline:
  PolyPitchDetector (Basic-Pitch ONNX) → PolyNotes → HarmonicMaskGenerator (Wiener) → SpectralPitchShifter → PolyResynthesizer

Real-time corrector:
  S13PitchCorrector (per-block, key/scale aware) → inserted as FX plugin on track
```

**Key data flow** (graphical editor):
1. User opens pitch editor → `pitchEditorStore.open()` → `nativeBridge.analyzePitchContourDirect()`
2. C++ `PitchAnalyzer` runs YIN detection, returns frames (per-hop pitch data) + notes (segmented note objects)
3. Frontend renders notes as blobs on canvas (`PitchEditorCanvas.ts`), user edits correctedPitch/drift/vibrato/etc.
4. On edit commit (400ms auto-apply debounce) → `nativeBridge.applyPitchCorrection(trackId, clipId, notes)`
5. C++ `AudioEngine::applyPitchCorrection()`:
   - Loads original clip audio → extracts window around edited notes
   - Passes all channels to `PitchResynthesizer::processMultiChannel()` with Rubber Band (native stereo)
   - Crossfades corrected window back into clip at splice points (512-sample crossfade)
   - Deletes old output file, writes new rotating output file → `PlaybackEngine::replaceClipAudioFile()` swaps it in (resets `clip.offset = 0`)

**Rubber Band Library** (default pitch engine): Uses R3 (Finer) engine in RealTime mode with `OptionPitchHighQuality`, `OptionFormantPreserved`, `OptionChannelsTogether`. RealTime mode is required for per-block `setPitchScale()` calls (Offline mode rejects mid-processing pitch changes). Has latency compensation: flush with silence after input, skip first `getLatency()` output samples. Built from `single/RubberBandSingle.cpp` with `USE_KISSFFT` + `NOMINMAX`. GPL v2+ license.

**PitchResynthesizer engines** (`PitchEngine` enum): `RubberBand` (default, native stereo, high quality), `WorldVocoder` (WORLD, mono-only, speech-oriented fallback), `PhaseVocoder` (basic, no formant preservation).

**PitchShifter FIFO latency**: The phase vocoder has 2048-sample FIFO latency. The first fftSize output samples are zeros. `PitchResynthesizer` compensates by flushing the FIFO with silence and trimming the latency from the output.

**WORLD vocoder** (`FormantPreserver`): Kept as fallback engine. Decomposes audio into F0 + spectral envelope + aperiodicity. Mono-only — when used via `processMultiChannel`, creates mono mix and duplicates to all channels.

**Polyphonic detection**: Uses Spotify's Basic-Pitch ONNX model (22050 Hz, 256 hop). Thresholds are tunable: `noteThreshold=0.15`, `onsetThreshold=0.3`. Onset bypass accepts sustained notes ≥200ms even without detected onset.

**Frontend state**: `pitchEditorStore.ts` (separate Zustand store from main DAW store) — holds notes, viewport, selectedNoteIds, tools (Select/Pitch/Drift/Vibrato/Transition), undo/redo stack, poly mode toggle, auto-apply debounce.

### Audio Thread Safety (REAPER-inspired)

- **PlaybackEngine::fillTrackBuffer()** uses `ScopedTryLock` (not `ScopedLock`) — returns silence if the message thread holds the lock (adding/removing clips). This is rare and inaudible. Never use blocking locks on the audio thread.
- **Pre-allocated buffers**: `PlaybackEngine` has a `reusableFileBuffer` member that is reused across clips/callbacks. Never heap-allocate (`new`, `AudioBuffer<float>(...)`) on the audio thread.
- **Pre-loaded readers**: `addClip()` calls `preloadReader()` on the message thread so `AudioFormatReader` objects are cached before the audio thread needs them. The audio thread uses `getCachedReader()` which only does a map lookup — never creates readers or does disk I/O.
- **Cached pan gains**: `TrackProcessor` pre-computes `cos`/`sin` pan gains as `std::atomic<float>` (`cachedPanL`, `cachedPanR`) when `setPan()` or `setVolume()` is called on the message thread. `processBlock()` on the audio thread loads these atomics cheaply — no trig computation per callback.
- **AudioRecorder::writeBlock()** also uses `ScopedTryLock` — same pattern.

### PeakCache System (.s13peaks)

- REAPER-inspired multi-resolution peak cache stored as `.s13peaks` sidecar files alongside audio files
- 4 mipmap levels at strides: 64, 256, 1024, 4096 samples per peak
- File format: `PeakFileHeader` (magic `0x53313350` / "S13P", version, source file size/timestamp for invalidation, sample rate, channels, level count) followed by flat float arrays per level
- `AudioEngine::getWaveformPeaks()` reads from PeakCache — never reads audio files directly. First call generates the cache synchronously; subsequent calls are instant (memory-cached mipmap lookup)
- Peak generation is triggered automatically in the background when recording stops (`peakCache.generateAsync()` for each completed clip)
- `PeakCache::buildPeaks()` reads the audio file in a single pass, computing all 4 mipmap levels simultaneously using per-level accumulators
- Background generation uses a `juce::ThreadPool` with 1 thread; completion callbacks fire on the message thread via `juce::MessageManager::callAsync`

### Bridge Pattern
- `NativeBridge.ts` wraps `window.__JUCE__.backend.*` calls
- All methods have mock fallbacks for frontend-only development
- Real-time metering via event system (`addEventListener`/`removeEventListener`)
- Async: all bridge calls return Promises

### Theme
- Tailwind CSS v4 with custom `daw-*` color tokens defined in `index.css`
- Dark theme: `daw-dark` (#121212), `daw-panel` (#1a1a1a), `daw-accent` (#0078d4)
- Semantic colors: `daw-record` (red), `daw-mute` (green), `daw-solo` (yellow), `daw-fx` (lime)
- UI components in `components/ui/` use variant pattern (default, primary, success, danger, etc.)

## When You're Stuck

**If you encounter the same error in a loop (3+ attempts) or need admin/system-level access you don't have (installing software, modifying system PATH, registry, etc.), STOP and immediately ask the user for help.** Do not keep retrying the same failing approach. Clearly explain:
1. What you're trying to do
2. What's failing and why
3. What the user needs to do (step by step)

## Coding Preferences

- Prefer targeted, minimal fixes over large refactors
- Frontend changes don't require C++ rebuild — just refresh the WebView
- C++ changes require `cmake --build build --config Debug` (or Release)
- C++ builds should compile with **zero warnings** (`/W4` is enabled) — use `juce::ignoreUnused()` for required-but-unused params, avoid C macro name collisions, use `const auto&` for rvalue refs
- TypeScript has some pre-existing errors in MenuBar, Playhead, ProjectSettingsModal, TrackHeader — these are known
- Use `npx tsc --noEmit` to check for new TS errors after changes

## Known Pitfalls & Past Issues

### useShallow Is Required for ALL useDAWStore Consumers

**Every** component that calls `useDAWStore()` must use a `useShallow` selector. The RAF-based `setCurrentTime` loop fires at 60fps during playback, so any bare `useDAWStore()` (no selector) causes 60fps re-renders. With N tracks this multiplies. Always use `useShallow((s) => ({ ... }))` and only pick the fields you need.

### Meter State Must Be Isolated from Tracks Array

`meterLevels` and `peakLevels` are separate top-level maps in the store, NOT inside `tracks[]`. Never return a new `tracks` reference when only meters changed — otherwise every track-dependent component re-renders at 60fps.

### syncBackend Must Pass Explicit Track IDs

`App.tsx`'s `syncBackend` must call `nativeBridge.addTrack(track.id)` with the Zustand track ID. Without the ID, C++ creates tracks with auto-generated UUIDs that don't match Zustand's — causing `setTrackRecordArm` etc. to silently fail.

### Dual Clamping on Zoom

Zoom (`pixelsPerSecond`) is clamped in **two places**: `Timeline.tsx` constants AND `setZoom` in `useDAWStore.ts`. They must agree.

### Konva Event Bubbling & Click Handlers

In Konva, `onMouseDown` fires before `onClick`. Handle all selection logic in `onMouseDown` with modifier keys, not in `onClick`. To detect "background click" for deselection, check `e.target.name() === "timeline-bg"` — don't use `!targetName` as unnamed clip shapes also match.

### Waveform samplesPerPixel Must Use File's Sample Rate

`samplesPerPixel` must use the **file's** sample rate (`clip.sampleRate`), not a hardcoded 44100. For trimmed clips (`clip.offset > 0`), `numPeaks` must cover `(clip.offset + clip.duration) * sampleRate / samplesPerPixel`, not just `clip.duration` — peak data always starts from sample 0.

### PlaybackEngine Sample Rate Mismatch

`fillTrackBuffer()` uses the file's own `reader->sampleRate` for sample positions and linearly interpolates to the device rate. Without this, files at different rates play at wrong pitch/speed.

### Plugin Channel Safety & Render State

Some VST3 plugins (e.g., Amplitube) expect specific channel counts — `TrackProcessor` and render path expand buffers before `processBlock()` if needed (`safeRenderFX` lambda). The render path must also re-prepare all FX plugins with render block size (512) and `reset()` them, then restore original state after. Without this, plugins overflow internal buffers and produce noise.

### Render Modal — What Actually Works in Backend

- **Working**: format (wav/aiff/flac), bit depth (16/24/32), channels (stereo/mono), normalize, tail
- **Ignored**: sample rate (always renders at device rate)
- **Not implemented**: "selected_tracks"/"stems" source (always master mix), dither

### C++ Naming Conflicts with C Standard Library Macros

Never use `stderr`, `stdout`, `stdin`, or `errno` as C++ variable names — they are macros. Use names like `errOutput` instead.
