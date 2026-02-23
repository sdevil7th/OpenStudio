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
│   ├── AudioEngine.h/cpp        # Core audio callback (juce::AudioIODeviceCallback), device management, track graph, render
│   ├── PlaybackEngine.h/cpp     # Clip playback scheduling, sample-rate-aware mixing with linear interpolation
│   ├── AudioRecorder.h/cpp      # Thread-safe recording via juce::AudioFormatWriter::ThreadedWriter
│   ├── TrackProcessor.h/cpp     # Per-track juce::AudioProcessor: metering, FX chain, input monitoring
│   ├── PluginManager.h/cpp      # VST3 plugin scanning and loading
│   ├── PluginWindowManager.h/cpp# Native VST3 editor window management
│   ├── MIDIManager.h/cpp        # MIDI device enumeration and input routing
│   ├── MIDIClip.h/cpp           # MIDI note event storage and time-range queries
│   ├── Metronome.h/cpp          # Click track generation (BPM, time sig, accent patterns)
│   ├── AudioConverter.h/cpp     # Channel/sample-rate conversion utilities
│   ├── PeakCache.h/cpp          # REAPER-style multi-resolution peak cache (.s13peaks sidecar files)
│   └── AudioAnalyzer.h/cpp      # Audio analysis utilities
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Main layout: MenuBar → MainToolbar → workspace(TCP + Timeline) → TransportBar → Modals
│   │   ├── main.tsx             # React entry point
│   │   ├── index.css            # Tailwind theme with daw-* custom colors
│   │   ├── store/
│   │   │   ├── useDAWStore.ts   # Zustand store — all app state and actions (~3400 lines)
│   │   │   ├── actionRegistry.ts # Centralized action defs for Command Palette, shortcuts, menus
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
│   │       ├── TrackHeader.tsx  # Track name, arm, solo, mute, input selector
│   │       ├── SortableTrackHeader.tsx # @dnd-kit wrapper for track reordering + context menu
│   │       ├── FXChainPanel.tsx # Plugin browser + FX chain management (input FX + track FX)
│   │       ├── PianoRoll.tsx    # MIDI note editor (Konva canvas)
│   │       ├── VirtualPianoKeyboard.tsx # 88-key on-screen MIDI keyboard
│   │       ├── MainToolbar.tsx  # Top toolbar: transport, undo/redo, snap, mixer toggle, settings
│   │       ├── MenuBar.tsx      # File/Edit/View/Insert/Help dropdown menus
│   │       ├── SettingsModal.tsx # Audio device configuration (driver, I/O, sample rate, buffer)
│   │       ├── RenderModal.tsx  # Export dialog (format, bit depth, channels, normalize, tail)
│   │       ├── PreferencesModal.tsx # Tabbed prefs: General, Editing, Display, Backup
│   │       ├── KeyboardShortcutsModal.tsx # Searchable action/shortcut reference (from actionRegistry)
│   │       ├── CommandPalette.tsx # Ctrl+Shift+P fuzzy action search
│   │       ├── PluginBrowser.tsx # VST3 plugin selection UI
│   │       ├── Playhead.tsx     # Timeline playhead cursor
│   │       ├── PeakMeter.tsx    # Audio level meters
│   │       ├── icons.tsx        # SVG icon components
│   │       ├── menus/           # MenuDropdown.tsx, EditMenu.tsx
│   │       └── ui/              # Base components: Button, Input, Select, NativeSelect, Slider, Modal, Checkbox, Textarea, TimeSignatureInput
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── tools/                       # ffmpeg.exe, setup scripts
├── build/                       # CMake build output
├── CMakeLists.txt               # C++ build: JUCE 8.0.0, ASIO SDK, WebView2, VST3
├── build.py                     # Python orchestrator: cmake + npm + vite dev server
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

## Coding Preferences

- Prefer targeted, minimal fixes over large refactors
- Frontend changes don't require C++ rebuild — just refresh the WebView
- C++ changes require `cmake --build build --config Debug` (or Release)
- C++ builds should compile with **zero warnings** (`/W4` is enabled) — use `juce::ignoreUnused()` for required-but-unused params, avoid C macro name collisions, use `const auto&` for rvalue refs
- TypeScript has some pre-existing errors in MenuBar, Playhead, ProjectSettingsModal, TrackHeader — these are known
- Use `npx tsc --noEmit` to check for new TS errors after changes

## Known Pitfalls & Past Issues

### Dual Clamping on Zoom

Zoom level (`pixelsPerSecond`) is clamped in **two places**: the constants in `Timeline.tsx` (MIN/MAX_PIXELS_PER_SECOND) AND inside `setZoom` in `useDAWStore.ts`. If zoom limits seem to not work, check both. They must agree.

### Konva Event Bubbling & Click Handlers

In Konva (react-konva), `onMouseDown` fires before `onClick`. If you handle selection in both (e.g., clip selection), the mouseDown resets state before the click handler can apply modifiers like Ctrl. **Solution**: handle all selection logic in `onMouseDown` with modifier keys, not in `onClick`.

### Stage onClick Deselects Clips

The Konva Stage's onClick fires for ANY click including on clips (if they don't have named shapes). To detect "background click" for deselection, name background rects `"timeline-bg"` and check `e.target.name() === "timeline-bg"` — do NOT use `!targetName` as unnamed clip shapes also match.

### Waveform samplesPerPixel Must Use File's Sample Rate

The `samplesPerPixel` sent to `getWaveformPeaks()` must be calculated from the **file's** sample rate (stored in `clip.sampleRate`), not a hardcoded 44100. A 48kHz file with 44100-based SPP produces a waveform that's visually shorter than the clip rect. The clip's `sampleRate` field was added for this — old clips without it fall back to 44100.

### PlaybackEngine Sample Rate Mismatch

`PlaybackEngine::fillTrackBuffer()` uses the file's own `reader->sampleRate` for sample positions, not the device rate. It reads at the file's native rate and linearly interpolates to the device rate. Without this, files recorded at different rates play with wrong pitch/speed.

### Plugin Crash on Track Arm (Amplitube etc.)

Some VST3 plugins (e.g., Amplitube) expect specific channel counts. The `TrackProcessor` and render path use a channel-safe wrapper: if a plugin needs more channels than the track buffer provides, it expands the buffer before `processBlock()` and copies back the stereo channels after. Check `safeRenderFX` lambda in AudioEngine's render loop.

### Render Noise / Plugin State

The render path must re-prepare all FX plugins with the render block size (512) and `reset()` them. After render, it restores the original device block size and plugin state. Without this, plugins like Amplitube overflow internal buffers and produce noise. See the `prepareProcessorForRender` lambda in `AudioEngine::renderProject()`.

### Native `<select>` Option Styling on WebView2/Windows

Native HTML `<option>` elements don't respect most CSS in WebView2. To get dark backgrounds on dropdown options, you must explicitly set `className="bg-neutral-900 text-white"` on each `<option>`. Both `Select` and `NativeSelect` components do this.

### Z-Index Stacking with Menu Dropdowns

The MenuBar dropdowns need `z-9999` and the MenuBar container itself needs `relative z-9999` to paint above the workspace. The track control panel (TCP) has elements at `z-100` which otherwise overlap the menus.

### Button Variant for Toggle Buttons

`variant="primary"` always looks active (blue bg). For toggle buttons (snap, mixer, etc.) use `variant="default"` which shows neutral gray when inactive and highlighted when active. `variant="primary"` is for modal action buttons only.

### Ctrl+Scroll Zoom Performance

The infinity wheel on mice like Logitech MX Master 3 fires many wheel events. The zoom system accumulates raw `deltaY` between frames via `accZoomDeltaRef` and applies once per `requestAnimationFrame`. During active zoom, waveform fetches are suppressed (`isZoomingRef`) with a 200ms debounce — waveforms re-render from cache at nearest power-of-2 resolution instead.

### Multi-Clip Clipboard Structure

The clipboard has both `clip: AudioClip | null` (legacy single-clip) and `clips: Array<{ clip: AudioClip; trackId: string }>` (multi-clip with track info). The `pasteClips()` action handles both — single clip pastes on selected track at playhead; multi-clip preserves relative track positions and time offsets. Access the clip properties via `entry.clip.startTime`, not `entry.startTime`.

### C++ Naming Conflicts with C Standard Library Macros

Never use `stderr`, `stdout`, `stdin`, or `errno` as C++ variable names — they are C macros that expand to `FILE*` etc. Using them causes cryptic compile errors (C2248 private member access, C2664 type mismatch). Use names like `errOutput` instead.

### JUCE `withNativeFunction` Unused `args` Parameter

All `withNativeFunction` callbacks must accept `(const juce::Array<juce::var>& args, NativeFunctionCompletion completion)` even when `args` isn't used. Add `juce::ignoreUnused(args);` as the first line to suppress C4100 warnings.

### `flags` Shadows `juce::Component::flags`

Local variables named `flags` inside MainComponent methods/lambdas shadow the inherited `juce::Component::flags` member (C4458). Use `chooserFlags` for `FileBrowserComponent` flag variables.

### `MemoryOutputStream::getMemoryBlock()` Returns Rvalue

`decoded.getMemoryBlock()` returns a temporary. Use `const auto& data = decoded.getMemoryBlock()` not `auto& data` (C4239 nonstandard extension).

### Render Modal — What Actually Works in Backend

- **Working**: format (wav/aiff/flac), bit depth (16/24/32), channels (stereo/mono with downmix), normalize (2-pass), add tail with tail length
- **Ignored by backend**: sample rate (always renders at device rate — sample rate conversion not implemented)
- **Not implemented**: source "selected_tracks" and "stems" (always renders master mix), dither
- The render calls `syncClipsWithBackend()` first, then `PlaybackEngine::fillTrackBuffer()` — same code path as real-time playback

### Waveform Peak numPeaks Must Account for Clip Offset

When fetching waveform peaks for a trimmed clip (one with `clip.offset > 0`), the `numPeaks` request must cover `(clip.offset + clip.duration) * sampleRate / samplesPerPixel`, NOT just `clip.duration`. The peak data always starts from sample 0 of the file, and the frontend indexes into it at `clipStartPeak = floor(clip.offset * sampleRate / cacheSpp)`. If too few peaks are fetched, the waveform is truncated for trimmed clips.

### batchUpdateMeterLevels Must Not Create Unnecessary State References

In `useDAWStore.ts`, `batchUpdateMeterLevels` updates track meter levels and `masterLevel`. When only `masterLevel` changed (no track levels changed), it must return `{ masterLevel }` only — NOT `{ tracks, masterLevel }`. Returning a new `tracks` array reference causes every component that selects `tracks` to re-render on every meter update (60fps), even though no track data actually changed.

### useShallow Is Required for MixerPanel and ChannelStrip

`MixerPanel.tsx` and `ChannelStrip.tsx` must use `useShallow` selectors when consuming from `useDAWStore`. Without `useShallow`, these components re-render on **every** store change (including 60fps meter updates), causing severe CPU load. Since there are N ChannelStrips (one per track), the re-render cost multiplies.

### Recording Waveform Effect Dependency Loop

In `Timeline.tsx`, the recording waveform subscription effect must NOT include `recordingWaveformCache` (the state variable) in its dependency array. Doing so causes the effect to re-subscribe on every recording bar update (creating/destroying subscriptions at ~2Hz). Instead, use a ref (`recordingWaveformCacheRef.current`) inside the callback and only include stable references in deps.
