# Studio13-v3 — Remaining Features Implementation Plan

> **Status:** 108/160 features implemented (68%)
> **Remaining:** 52 features across 9 phases
> **Date:** 2026-02-19

---

## Table of Contents

1. [Feature Inventory](#1-feature-inventory)
2. [Architecture Overview](#2-architecture-overview)
3. [Phase 8: Frontend-Only Polish](#phase-8-frontend-only-polish)
4. [Phase 9: Audio Engine Enhancements](#phase-9-audio-engine-enhancements)
5. [Phase 10: Render Pipeline Expansion](#phase-10-render-pipeline-expansion)
6. [Phase 11: Routing & Mixing](#phase-11-routing--mixing)
7. [Phase 12: Media & File Management](#phase-12-media--file-management)
8. [Phase 13: Advanced Editing](#phase-13-advanced-editing)
9. [Phase 14: Theming & Customization](#phase-14-theming--customization)
10. [Phase 15: Platform & Extensibility](#phase-15-platform--extensibility)
11. [Phase 16: Pro Audio & Compatibility](#phase-16-pro-audio--compatibility)
12. [Dependency Graph](#dependency-graph)
13. [Effort Estimates](#effort-estimates)

---

## 1. Feature Inventory

### All 52 Remaining Features by Category

| # | Feature | Category | BE Effort | FE Effort | Priority |
|---|---------|----------|-----------|-----------|----------|
| 1 | Clean Project Directory | File | MEDIUM | LOW | LOW |
| 2 | Batch File/Item Converter | File | HIGH | MEDIUM | LOW |
| 3 | Render Queue | File | LOW | MEDIUM | LOW |
| 4 | New Project in Tab (MDI) | File | HIGH | HIGH | LOW |
| 5 | Save Live Output to Disk | File | HIGH | LOW | LOW |
| 6 | Consolidate/Export Tracks | File | HIGH | MEDIUM | LOW |
| 7 | Export Project MIDI | File | MEDIUM | LOW | LOW |
| 8 | Recovery Mode (bypass FX) | File | NONE | LOW | LOW |
| 9 | Crossfade Editor | Edit | NONE | HIGH | LOW |
| 10 | Master Track in TCP | View | NONE | LOW | MEDIUM |
| 11 | Routing Matrix | View | HIGH | HIGH | LOW |
| 12 | Track Wiring Diagram | View | NONE | MEDIUM | LOW |
| 13 | Media Explorer | View | MEDIUM | HIGH | MEDIUM |
| 14 | Video Window | View | HIGH | MEDIUM | MEDIUM |
| 15 | Screensets/Layouts | View | NONE | MEDIUM | LOW |
| 16 | Docker/Panel System | View | NONE | HIGH | LOW |
| 17 | Empty Item | Insert | NONE | LOW | LOW |
| 18 | Click Source | Insert | MEDIUM | LOW | LOW |
| 19 | Track Spacer | Insert | NONE | LOW | LOW |
| 20 | SMPTE LTC Generation | Insert | HIGH | LOW | LOW |
| 21 | Source Properties | Clip | LOW | MEDIUM | LOW |
| 22 | Quantize to Grid | Clip | NONE | MEDIUM | LOW |
| 23 | Time Stretch/Pitch Shift | Clip | VERY HIGH | MEDIUM | LOW |
| 24 | Takes (Explode/Implode) | Clip | NONE | HIGH | LOW |
| 25 | Reverse Clip | Clip | MEDIUM | LOW | MEDIUM |
| 26 | Dynamic Split | Clip | HIGH | MEDIUM | LOW |
| 27 | Free Item Positioning | Track | NONE | MEDIUM | LOW |
| 28 | Track Group Manager (VCA) | Track | MEDIUM | MEDIUM | LOW |
| 29 | Lock Settings (granular) | Options | NONE | LOW | LOW |
| 30 | Themes | Options | NONE | MEDIUM | LOW |
| 31 | Theme Adjuster | Options | NONE | MEDIUM | LOW |
| 32 | Move Envelopes with Items | Options | NONE | MEDIUM | LOW |
| 33 | Mouse Modifiers | Options | NONE | HIGH | LOW |
| 34 | Custom Actions (Macros) | Actions | NONE | MEDIUM | LOW |
| 35 | Recent Actions | Actions | NONE | LOW | LOW |
| 36 | User Guide | Help | NONE | LOW | LOW |
| 37 | Selected Media Items render | Render | MEDIUM | LOW | LOW |
| 38 | Selected Media via Master | Render | MEDIUM | LOW | LOW |
| 39 | Region Render Matrix | Render | MEDIUM | HIGH | LOW |
| 40 | Razor Edit Areas render | Render | LOW | LOW | LOW |
| 41 | Project Regions bounds | Render | LOW | LOW | LOW |
| 42 | Selected Regions bounds | Render | LOW | LOW | LOW |
| 43 | Secondary Output Format | Render | LOW | MEDIUM | LOW |
| 44 | Multichannel Rendering | Render | HIGH | MEDIUM | LOW |
| 45 | Resample Mode Quality | Render | MEDIUM | LOW | LOW |
| 46 | RAW PCM Format | Render | LOW | LOW | LOW |
| 47 | DDP Export | Render | HIGH | MEDIUM | LOW |
| 48 | Video Render (FFmpeg) | Render | MEDIUM | LOW | LOW |
| 49 | Dither/Noise Shaping | Render | MEDIUM | LOW | LOW |
| 50 | Metadata Embedding | Render | MEDIUM | MEDIUM | LOW |
| 51 | Online Render (1x speed) | Render | LOW | LOW | LOW |
| 52 | True Peak / LUFS Normalize | Render | HIGH | MEDIUM | LOW |

---

## 2. Architecture Overview

### Current Bridge Functions (58 total)
The `NativeBridge.ts` exposes 58 methods via `window.__JUCE__.backend.*`. New backend features need:
1. C++ function added to `MainComponent.cpp` (`webBrowserComponent->bind(...)`)
2. TypeScript wrapper added to `NativeBridge.ts` with mock fallback
3. Store action in `useDAWStore.ts` calling the bridge

### Backend Capabilities Available but Unexposed
- `TrackProcessor` has `SendConfig` struct with `setSendLevel/Pan/Enabled/PreFader` — routing ready in C++ but no JS bridge
- `MIDIClip::exportToMidiFile()` — skeleton exists
- `AudioEngine::renderProject()` — supports format/bitDepth/channels/normalize/tail but not metadata/dither/LUFS

### New C++ Files Needed
| File | Purpose |
|---|---|
| `Source/AudioAnalyzer.h/cpp` | Transient detection, LUFS measurement, true-peak analysis |
| `Source/AudioProcessor.h/cpp` | Reverse, time-stretch, pitch-shift, dither algorithms |
| `Source/FileManager.h/cpp` | Project directory cleanup, file conversion, MIDI export |
| `Source/VideoDecoder.h/cpp` | FFmpeg-based video frame extraction |
| `Source/TimecodeGenerator.h/cpp` | SMPTE LTC/MTC generation |

### New Frontend Components Needed
| Component | Purpose |
|---|---|
| `CrossfadeEditor.tsx` | Visual crossfade curve editor with waveform preview |
| `RoutingMatrix.tsx` | Grid-based send/bus routing |
| `MediaExplorer.tsx` | File browser with preview playback |
| `VideoWindow.tsx` | Floating video playback panel |
| `ScreensetManager.tsx` | Save/restore UI layouts |
| `RenderQueuePanel.tsx` | Queue management for batch renders |
| `RegionRenderMatrix.tsx` | Track × Region render grid |
| `MacroEditor.tsx` | Custom action sequence builder |
| `ThemeEditor.tsx` | Theme adjuster with live preview |
| `MouseModifierMatrix.tsx` | Per-context modifier key mapping |
| `MasterTrackHeader.tsx` | Master track in TCP sidebar |
| `TrackGroupManager.tsx` | VCA group management |

---

## Phase 8: Frontend-Only Polish
> **0 backend changes** | **~12 features** | Estimated: 2-3 days

These features need NO C++ changes — purely React/TypeScript/CSS.

### 8A: Quick Wins (1 day)

#### 1. Recovery Mode (bypass FX on open)
**Files:** `useDAWStore.ts`, `MenuBar.tsx`
```
FE: Add loadProject(path, { bypassFX: true }) option
    - In deserializeProject(), skip FX restoration loop when bypassFX=true
    - Add "Open Project (Safe Mode)..." to File menu (Shift+Ctrl+O)
    - No backend changes — FX loading is purely frontend-driven
```

#### 2. Empty Item (silent clip)
**Files:** `useDAWStore.ts`, `MenuBar.tsx`
```
FE: Add addEmptyClip(trackId, startTime, duration) action
    - Creates AudioClip with no filePath (empty/silent)
    - Timeline renders it as a colored block with "(empty)" label
    - Insert menu: "Empty Item" entry
```

#### 3. Track Spacer
**Files:** `useDAWStore.ts`, `App.tsx`, `SortableTrackHeader.tsx`
```
FE: Add spacers: Array<{ id, afterTrackId, height }> to state
    - Render <div> with configurable height between track headers
    - Context menu on track: "Insert Spacer Below" / "Remove Spacer"
    - Spacers are draggable for height adjustment
```

#### 4. Lock Settings (granular)
**Files:** `useDAWStore.ts`, `MainToolbar.tsx`
```
FE: Add lockSettings: { items, envelopes, timeSelection, markers }
    - Global lock toggle button in MainToolbar
    - Right-click shows checkbox submenu for granular locks
    - Timeline checks lockSettings before drag/resize operations
    - Already have per-clip lock — this extends to categories
```

#### 5. Recent Actions
**Files:** `useDAWStore.ts`, `CommandPalette.tsx`
```
FE: Add recentActions: string[] to state (last 10 action IDs)
    - Command Palette shows "Recent" section at top when no search query
    - Each action execution pushes to recentActions (deduped, capped at 10)
```

#### 6. Master Track in TCP
**Files:** `MasterTrackHeader.tsx` (new), `App.tsx`
```
FE: New component at bottom of TCP sidebar
    - Master volume fader (horizontal), mute, FX button
    - Opens master FX chain on FX click
    - Store: showMasterTrack: boolean, toggleMasterTrack()
    - View menu: "Show Master Track" toggle
```

### 8B: Medium Frontend (1-2 days)

#### 7. Render Queue
**Files:** `RenderQueuePanel.tsx` (new), `RenderModal.tsx`, `useDAWStore.ts`
```
FE: Add renderQueue: RenderJob[] to state
    - RenderJob = full render options + status (pending/rendering/done/error)
    - RenderModal: "Add to Queue" button alongside "Render"
    - RenderQueuePanel: list of queued jobs with progress, remove, reorder
    - executeRenderQueue() processes jobs sequentially via nativeBridge.renderProject()
    - Show in View menu or as tab in RenderModal
```

#### 8. Screensets/Layouts
**Files:** `useDAWStore.ts`, `MenuBar.tsx`
```
FE: Add screensets: Array<{ id, name, layout }> to state
    - Layout captures: showMixer, showPianoRoll, showBigClock, showClipProperties,
      showUndoHistory, showRegionMarkerManager, pixelsPerSecond, trackHeights
    - Save current layout: "Save Screenset" (Ctrl+Shift+1-9)
    - Recall: "Load Screenset" (Ctrl+1-9)
    - Persist to localStorage
    - View menu: "Screensets" submenu
```

#### 9. Quantize Clips to Grid
**Files:** `useDAWStore.ts`, `Timeline.tsx`
```
FE: Add quantizeSelectedClips() action
    - For each selected clip, snap startTime to nearest grid position
    - Optionally snap duration to grid
    - Edit menu: "Quantize Items to Grid"
    - Uses existing snapToGrid.ts utility
```

#### 10. Move Envelope Points with Items
**Files:** `useDAWStore.ts`, `Timeline.tsx`
```
FE: Add moveEnvelopesWithItems: boolean to state (default: true)
    - When moving a clip, if this is enabled, also shift any automation points
      within the clip's time range by the same delta
    - Options menu toggle
```

#### 11. Custom Actions (Macros)
**Files:** `MacroEditor.tsx` (new), `useDAWStore.ts`, `actionRegistry.ts`
```
FE: Add customActions: Array<{ id, name, steps: string[], shortcut? }> to state
    - MacroEditor: drag actions from registry into sequence, assign shortcut
    - Execute macro: run steps[] sequentially via actionRegistry lookup
    - Register custom actions in actionRegistry so they appear in Command Palette
    - Persist to localStorage
```

#### 12. Source Properties Panel
**Files:** `ClipPropertiesPanel.tsx` (extend)
```
FE: Extend existing Clip Properties to show source file info
    - File format, codec, channels, bit depth, sample rate, file size
    - Read from clip metadata (already have sampleRate on clip)
    - "Open Source Location" button (if backend supports openFileExplorer)
    - No new component needed — add "Source" section to ClipPropertiesPanel
```

---

## Phase 9: Audio Engine Enhancements
> **Heavy backend** | **~6 features** | Estimated: 4-6 days

### 9A: Reverse Clip

#### Backend (`Source/MainComponent.cpp`, `Source/AudioEngine.cpp`)
```cpp
// New bridge function: reverseAudioFile(filePath) -> reversedFilePath
// Implementation:
// 1. Open source file with AudioFormatReader
// 2. Create temp output file: "filename_reversed.wav"
// 3. Read samples from end to start, write in order
// 4. Return path to reversed file
// Complexity: ~50 lines of C++
```

#### Frontend
```
FE: Add reverseClip(clipId) action to store
    - Call nativeBridge.reverseAudioFile(clip.filePath)
    - Update clip.filePath to reversed file
    - Toggle clip.reversed: boolean flag for UI indicator
    - Context menu: "Reverse Clip"
    - Wrap in undoable command (store original filePath for undo)
```

### 9B: Dynamic Split (Transient Detection)

#### Backend (`Source/AudioAnalyzer.h/cpp` — new file)
```cpp
// New class: AudioAnalyzer
// Method: detectTransients(filePath, sensitivity, minGapMs)
//   - Read audio file via AudioFormatReader
//   - Compute spectral flux or energy-based onset detection:
//     1. Process in frames (512-1024 samples)
//     2. Compute frame energy: sum of squared samples
//     3. Compare to running average * sensitivity threshold
//     4. When energy exceeds threshold and gap > minGapMs: mark transient
//   - Return array of transient times (seconds)
// Expose via bridge: detectTransients(filePath, sensitivity, minGap) -> number[]
```

#### Frontend
```
FE: New DynamicSplitModal.tsx
    - Select clip(s), adjust sensitivity slider (0.1-1.0), min gap (10-500ms)
    - "Preview" shows transient markers on waveform (vertical lines)
    - "Split" calls splitClipAtTime() for each transient
    - Edit menu: "Dynamic Split..."
```

### 9C: Click Source (Custom Metronome)

#### Backend (`Source/Metronome.cpp`)
```cpp
// Extend Metronome to load custom WAV samples for click/accent
// New bridge functions:
//   setMetronomeClickSound(filePath) — loads WAV for regular beats
//   setMetronomeAccentSound(filePath) — loads WAV for accent beats
//   resetMetronomeToDefault() — restores synthesized click
// Implementation:
//   Store AudioBuffer for click/accent samples
//   In generateClick(), use stored sample instead of sine wave if loaded
```

#### Frontend
```
FE: Extend MetronomeSettings.tsx
    - "Click Sound" dropdown: Default, Custom...
    - File browser for custom WAV selection
    - Preview button
    - Store: metronomeClickPath, metronomeAccentPath
```

### 9D: LUFS Measurement & True Peak Limiting

#### Backend (`Source/AudioAnalyzer.h/cpp`)
```cpp
// New methods:
// measureLUFS(filePath, startTime, endTime) -> { integrated, shortTerm, momentary, truePeak }
//   - ITU-R BS.1770-4 algorithm:
//     1. K-weighting filter (high-shelf + high-pass)
//     2. Mean square per channel
//     3. Gated loudness (absolute gate -70 LUFS, relative gate -10 LUFS)
//   - True peak: 4x oversampled peak detection
//
// applyTruePeakLimiter(filePath, ceilingDB) -> outputFilePath
//   - Simple lookahead brickwall limiter at ceiling
//   - Write to new file
```

#### Frontend
```
FE: RenderModal.tsx additions
    - "Normalize" dropdown: Peak / LUFS / True Peak Limit
    - Target LUFS input (-14, -16, -23 presets + custom)
    - True peak ceiling input (-0.1, -0.3, -1.0 dB presets)
    - Store: renderNormalizeMode, renderTargetLUFS, renderTruePeakCeiling
```

### 9E: Dither/Noise Shaping

#### Backend (`Source/AudioEngine.cpp` render path)
```cpp
// In renderProject(), after final mix and before writing:
// If dither enabled and output bit depth < 32:
//   1. TPDF dither: add triangular PDF noise at LSB level
//   2. Noise shaping (optional): 1st-order highpass feedback filter
//      moves dither noise energy to less audible high frequencies
// Add ditherEnabled and ditherType to render options
```

#### Frontend
```
FE: RenderModal already has dither checkbox — wire it to backend
    - Add ditherType: 'none' | 'tpdf' | 'shaped' to render options
    - Pass through nativeBridge.renderProject()
```

### 9F: Resample Mode Quality

#### Backend (`Source/AudioEngine.cpp` or FFmpeg post-process)
```cpp
// Currently renders at device rate, FFmpeg resamples with default quality
// Add resampleQuality option: 'fast' | 'good' | 'best'
// Map to FFmpeg flags:
//   fast  -> -af aresample=resampler=soxr:precision=16
//   good  -> -af aresample=resampler=soxr:precision=20
//   best  -> -af aresample=resampler=soxr:precision=28
// Or implement in C++ using JUCE's ResamplingAudioSource with quality param
```

#### Frontend
```
FE: RenderModal: "Resample Quality" dropdown (Fast/Good/Best)
    - Only visible when target sample rate != device rate
```

---

## Phase 10: Render Pipeline Expansion
> **Mixed backend/frontend** | **~12 features** | Estimated: 3-5 days

### 10A: Render Source Expansion (4 features)

#### Selected Media Items / Selected Media via Master
```
BE: renderProject() already accepts source param ("master", "stem:trackId")
    Add: source = "selected_items"
    - Collect clipIds from frontend
    - Only play clips matching those IDs during render
    - "via master" variant: also apply master FX chain
FE: RenderModal source dropdown: add "Selected media items" and "via master"
    - Send selectedClipIds in render options
```

#### Razor Edit Areas render
```
BE: source = "razor" + razorEdits array
    - For each razor edit: render only the content within that track+time range
    - Output one file per razor area
FE: Pass current razorEdits from store when source = "Razor edit areas"
```

#### Region Render Matrix
```
BE: Loop: for each (track, region) intersection, call renderProject() with
    source=stem:trackId, startTime=region.start, endTime=region.end
FE: New RegionRenderMatrix.tsx
    - Grid: rows = tracks, columns = regions
    - Checkbox at each intersection
    - Filename preview per intersection using wildcards
    - "Render Matrix" button processes all checked intersections
```

### 10B: Render Bounds Expansion (2 features)

#### Project Regions / Selected Regions
```
BE: No changes — bounds are just startTime/endTime
FE: RenderModal bounds dropdown: add "Project regions" and "Selected regions"
    - "Project regions": render one file per region
    - "Selected regions": render one file per selected region
    - Loop through regions, call renderProject() for each
    - Filename uses $region wildcard
```

### 10C: Output Format Expansion (3 features)

#### RAW PCM
```
BE: AudioEngine::renderProject()
    - Add format="raw" option
    - Write samples directly to file without WAV header
    - Support 16/24/32 bit
FE: RenderModal format dropdown: add "RAW PCM"
```

#### Video Render (FFmpeg)
```
BE: After audio render, if video source exists:
    - FFmpeg mux: ffmpeg -i video_source -i rendered_audio -c:v copy -c:a aac output.mp4
    - Requires video file association in project
FE: RenderModal: "Video" format option (only enabled when project has video)
    - Video codec selection: copy/h264/h265
```

#### Secondary Output Format
```
FE: RenderModal: "Secondary output" section
    - Toggle to enable
    - Independent format/quality settings
    - After primary render completes, trigger secondary render (or FFmpeg convert)
BE: Minimal — can be done by calling renderProject() twice or FFmpeg conversion
```

### 10D: Metadata & Post-Processing (3 features)

#### Metadata Embedding
```
BE: AudioEngine::renderProject()
    - For WAV: Use JUCE WavAudioFormat::createWriterFor() with metadata StringPairArray
    - BWF fields: description, originator, originatorRef, originationDate, timeReference
    - For MP3: Pass metadata to FFmpeg as -metadata title="..." -metadata artist="..."
    - Add renderMetadata object to render options
FE: RenderModal: "Metadata..." button opening inline form
    - Fields: title, artist, album, genre, year, description, ISRC
    - Store: renderMetadata: { title, artist, ... }
```

#### Online Render (1x speed)
```
BE: AudioEngine::renderProject()
    - Add realtime: boolean option
    - When realtime=true: use a timer to pace the render at 1x speed
    - Useful for live monitoring of the render output
    - Process one block per audio callback instead of as fast as possible
FE: RenderModal: "Online render (1x)" checkbox
```

#### Add Rendered Items to Project
```
FE: After render completes, option to auto-import rendered file(s)
    - Create new track(s), import rendered WAV/MP3 as clips
    - Post-render dialog: "Add to project?" checkbox
BE: No changes — uses existing importMedia flow
```

---

## Phase 11: Routing & Mixing
> **Heavy backend** | **~3 features** | Estimated: 3-5 days

### 11A: Send/Bus Routing

#### Backend (`Source/TrackProcessor.cpp`, `Source/AudioEngine.cpp`)
```cpp
// TrackProcessor already has SendConfig struct:
//   struct SendConfig { int destTrackIndex; float level; float pan; bool enabled; bool preFader; }
// Need to expose via bridge and implement the actual routing in AudioEngine:

// New bridge functions:
//   createBusTrack() -> trackId
//   addTrackSend(sourceTrackId, destTrackId) -> sendIndex
//   removeTrackSend(sourceTrackId, sendIndex)
//   setTrackSendLevel(sourceTrackId, sendIndex, levelDB)
//   setTrackSendPan(sourceTrackId, sendIndex, pan)
//   setTrackSendPreFader(sourceTrackId, sendIndex, preFader)

// AudioEngine::audioDeviceIOCallbackWithContext():
//   After processing each track's FX chain:
//   1. For each send on this track:
//      a. Copy track's output buffer (or pre-fader buffer)
//      b. Apply send level + pan
//      c. Mix into destination track's input buffer
//   2. Process bus tracks (which now have accumulated send audio)
//   3. Mix all tracks (including buses) to master
```

#### Frontend
```
FE: useDAWStore.ts:
    - Add sends: Array<{ id, sourceTrackId, destTrackId, level, pan, preFader }> to Track
    - Actions: addSend, removeSend, setSendLevel, setSendPan, setSendPreFader
    - ChannelStrip: add "Send" section with level knob per send
    - Track context menu: "Add Send To..." submenu listing other tracks/buses
```

### 11B: Routing Matrix

#### Frontend (`RoutingMatrix.tsx` — new)
```
FE: Grid-based view (accessible from View menu)
    - Rows = source tracks
    - Columns = destination tracks + hardware outputs
    - Click cell = toggle send (creates/removes send)
    - Drag cell = adjust send level
    - Color intensity shows send level
    - Uses send data from 11A
```

### 11C: Track Group Manager (VCA)

#### Frontend + Minor Backend
```
FE: useDAWStore.ts:
    - Add trackGroups: Array<{ id, name, leadTrackId, memberTrackIds, linkedParams }>
    - linkedParams: ['volume', 'pan', 'mute', 'solo', 'arm'] selectable
    - When lead track's param changes, compute delta and apply to all members
    - Preserve relative offsets (VCA-style, not absolute)
    - TrackGroupManager.tsx: assign tracks to groups, set lead, choose linked params
    - Visual: group color stripe on track headers

BE: Optional — for real-time VCA on the audio thread:
    - AudioEngine could respect group relationships for volume/mute
    - But frontend-driven is sufficient for now
```

---

## Phase 12: Media & File Management
> **Mixed backend/frontend** | **~5 features** | Estimated: 3-4 days

### 12A: Media Explorer

#### Backend (`Source/MainComponent.cpp`)
```cpp
// New bridge functions:
//   browseDirectory(path) -> { files: Array<{ name, path, size, format, duration, sampleRate }> }
//     - Use juce::File to list directory
//     - For audio files: open with AudioFormatReader to get metadata
//   previewAudioFile(path)
//     - Load file into a preview AudioSource
//     - Play through current output device (not through the track graph)
//     - Add stopPreview() to stop playback
```

#### Frontend (`MediaExplorer.tsx` — new)
```
FE: Dockable panel (left side or floating)
    - Directory tree browser (expandable folders)
    - File list with: name, duration, sample rate, format, size
    - Click to preview (small play button)
    - Drag file onto timeline to import
    - Search/filter bar
    - Recent directories
    - Store: mediaExplorerPath, showMediaExplorer
```

### 12B: Clean Project Directory

#### Backend (`Source/MainComponent.cpp`)
```cpp
// New bridge functions:
//   cleanProjectDirectory(projectDir, referencedFiles[])
//     -> { orphanedFiles: Array<{ path, size }>, totalSize }
//     - Walk projectDir recursively
//     - Compare against referencedFiles list
//     - Return files not in the list
//   deleteFiles(filePaths[])
//     -> { deleted: number, errors: string[] }
```

#### Frontend
```
FE: New CleanProjectModal.tsx
    - Triggered from File menu
    - Collect all clip.filePath values from store
    - Call backend cleanProjectDirectory()
    - Show list of orphaned files with checkboxes + sizes
    - "Delete Selected" button calls deleteFiles()
    - Confirmation dialog before delete
```

### 12C: Export Project MIDI

#### Backend (`Source/MIDIClip.cpp`)
```cpp
// MIDIClip::exportToMidiFile() skeleton already exists
// Implementation:
//   1. Create juce::MidiFile
//   2. For each MIDI track in project:
//      a. Create MidiMessageSequence
//      b. For each note event: add noteOn/noteOff at correct tick positions
//      c. Set tempo meta-events from tempo map
//   3. Write to file
// Bridge: exportProjectMIDI(filePath, tracks[]) -> success
```

#### Frontend
```
FE: File menu: "Export Project MIDI..."
    - Save dialog for .mid file
    - Collect all MIDI clips from all tracks
    - Call nativeBridge.exportProjectMIDI(filePath, midiData)
```

### 12D: Consolidate/Export Tracks

#### Backend
```cpp
// Reuse renderProject() with source="stem:trackId"
// For each selected track:
//   1. Render track audio (with FX) to WAV
//   2. Save to project directory as "TrackName_consolidated.wav"
//   3. Optionally replace track clips with single consolidated clip
// Bridge: consolidateTrack(trackId, outputDir) -> filePath
```

#### Frontend
```
FE: Track context menu: "Consolidate Track"
    - Or File menu: "Consolidate/Export Tracks..."
    - Multi-select tracks to consolidate
    - Progress indicator for each track
```

### 12E: Batch File/Item Converter

#### Backend
```cpp
// Bridge: convertAudioFile(inputPath, outputFormat, options) -> outputPath
// Uses JUCE AudioFormatReader + Writer for lossless
// Uses FFmpeg for lossy (MP3/OGG)
// Options: sampleRate, bitDepth, channels, normalize
```

#### Frontend
```
FE: New BatchConverterModal.tsx
    - Select files from project or browse
    - Choose output format, sample rate, bit depth
    - Queue and process
    - Progress per file
```

---

## Phase 13: Advanced Editing
> **Mixed** | **~4 features** | Estimated: 3-5 days

### 13A: Crossfade Editor

#### Frontend (`CrossfadeEditor.tsx` — new)
```
FE: Modal showing two overlapping clip waveforms at crossfade region
    - Fade curve shape selector: linear, equal-power, S-curve, logarithmic, exponential
    - Asymmetric handles (fadeOut shape can differ from fadeIn shape)
    - Preview playback of crossfade region
    - Store: add crossfadeShape to clip fade properties
      fadeInShape: 'linear' | 'equal_power' | 's_curve' | 'log' | 'exp'
      fadeOutShape: same
    - Open: double-click crossfade region in Timeline

BE: PlaybackEngine currently applies linear fades
    - Extend to support curve types via lookup table:
      linear: y = x
      equal_power: y = sqrt(x)
      s_curve: y = 3x² - 2x³
      log: y = log(1 + 9x) / log(10)
      exp: y = (exp(3x) - 1) / (exp(3) - 1)
    - Minimal C++ change (~20 lines in applyFade)
```

### 13B: Takes (Explode/Implode)

#### Frontend
```
FE: useDAWStore.ts:
    - Add to AudioClip: takes?: AudioClip[], activeTakeIndex?: number
    - Actions:
      addTake(clipId, take) — push new take, set active
      setActiveTake(clipId, takeIndex) — switch visible take
      explodeTakes(clipId) — create one track per take
      implodeTakes(clipIds) — merge aligned clips into single multi-take clip
    - Timeline: show take indicator badge on clips with takes
      Click badge to cycle takes
      Right-click for take submenu: "Promote to Active", "Delete Take"
    - Loop recording: when loopEnabled + recording, stack passes as takes

BE: No changes — PlaybackEngine plays the active take's audio
    (takes are just clip metadata in the frontend)
```

### 13C: Time Stretching / Pitch Shifting

#### Backend (VERY HIGH effort)
```cpp
// Option A: Integrate Rubber Band Library (MIT license)
//   - Add rubberband as CMake dependency
//   - New class: AudioStretcher
//     timeStretchFile(inputPath, factor, outputPath) -> success
//     pitchShiftFile(inputPath, semitones, outputPath) -> success
//   - Process offline: read file → stretch/shift → write new file
//   - Bridge: timeStretchClip(filePath, factor) -> newFilePath
//             pitchShiftClip(filePath, semitones) -> newFilePath

// Option B: Use FFmpeg (simpler but lower quality)
//   - ffmpeg -i input.wav -af "rubberband=tempo=1.5" output.wav
//   - ffmpeg -i input.wav -af "rubberband=pitch=2" output.wav
//   - Requires FFmpeg built with librubberband

// Option C: Use SoundTouch (LGPL)
//   - Simpler API but lower quality than Rubber Band
```

#### Frontend
```
FE: useDAWStore.ts:
    - Add to AudioClip: playbackRate?: number, pitchSemitones?: number
    - Actions: setClipPlaybackRate(clipId, rate), setClipPitch(clipId, semitones)
    - ClipPropertiesPanel: rate slider (0.25x-4.0x), pitch slider (-12 to +12 semitones)
    - Context menu: "Item Properties..." includes rate/pitch
    - On change: call backend to create processed file, update clip.filePath
```

### 13D: Free Item Positioning

#### Frontend
```
FE: useDAWStore.ts:
    - Add to AudioClip: freeY?: number (pixel offset within timeline)
    - Add freePositioning: boolean to state (global toggle)
    - Timeline: when freePositioning enabled:
      - Clips render at their freeY offset instead of track lane
      - Drag clips vertically to any position (not snapped to track boundaries)
      - Still assigned to a track for routing purposes
    - View menu: "Free Item Positioning" toggle
```

---

## Phase 14: Theming & Customization
> **Frontend-only** | **~4 features** | Estimated: 2-3 days

### 14A: Theme System

#### Frontend
```
FE: index.css already uses daw-* CSS custom properties
    - Define theme presets as JS objects mapping property names to values:
      dark (current), light, midnight, high-contrast
    - Store: theme: string, customThemeOverrides: Record<string, string>
    - On theme change: apply to document.documentElement.style
    - Options menu: "Theme" submenu with preset list

    Theme preset example:
      midnight: { daw-dark: '#0a0a1a', daw-panel: '#10102a', daw-accent: '#6366f1' }
      light: { daw-dark: '#f5f5f5', daw-panel: '#ffffff', daw-accent: '#2563eb' }
```

### 14B: Theme Adjuster

#### Frontend (`ThemeEditor.tsx` — new)
```
FE: Panel with live-preview sliders:
    - Accent color: color picker (hue/sat/light)
    - Background intensity: slider (darker ↔ lighter)
    - Text brightness: slider
    - Border opacity: slider
    - Track header width: slider
    - All changes apply instantly via CSS custom properties
    - "Save as Theme" button
    - "Reset to Default" button
```

### 14C: Mouse Modifier Customization

#### Frontend (`MouseModifierMatrix.tsx` — new)
```
FE: Matrix editor in Preferences modal (new "Mouse" tab)
    - Rows = contexts: clip_drag, clip_resize, timeline_click, track_header,
                       automation_point, fade_handle, ruler_click
    - Columns = modifier combos: none, ctrl, shift, alt, ctrl+shift, ctrl+alt
    - Each cell = action dropdown (move, copy, select, zoom, etc.)
    - Store: mouseModifiers: Record<context, Record<modifiers, action>>
    - Timeline.tsx: replace hardcoded modifier checks with map lookups
    - Default map matches current behavior
```

### 14D: Docker/Panel System

#### Frontend
```
FE: Architectural change to panel management
    - Panels (Mixer, MediaExplorer, UndoHistory, ClipProperties, etc.) can be:
      floating, docked-left, docked-right, docked-bottom, tabbed
    - Store: panelPositions: Record<panelId, { dock, position, size }>
    - DockContainer component wraps panels with drag handles
    - Drag panel header to dock zone (shows drop indicator)
    - Save/restore with screensets
    - This is a significant UI architecture change
```

---

## Phase 15: Platform & Extensibility
> **Heavy backend + frontend** | **~5 features** | Estimated: 5-8 days

### 15A: Video Playback Window

#### Backend (`Source/VideoDecoder.h/cpp` — new)
```cpp
// Use FFmpeg C API (libavformat, libavcodec, libswscale):
//   1. Open video container (MP4, MOV, AVI)
//   2. Find video stream
//   3. On request: decode frame at time T
//   4. Convert to RGBA via swscale
//   5. Return frame data as base64 or shared memory
//
// Bridge functions:
//   openVideoFile(filePath) -> { width, height, duration, fps }
//   getVideoFrame(time) -> base64ImageData
//   closeVideoFile()
//
// Performance: cache recent frames, decode ahead during playback
// FFmpeg already bundled in tools/ for audio — extend to video
```

#### Frontend (`VideoWindow.tsx` — new)
```
FE: Floating/dockable panel showing video frame
    - Canvas element renders decoded frames
    - Subscribes to transport.currentTime for sync
    - During playback: request frames at display rate (30fps)
    - During seek: request single frame
    - Show/hide via View menu: "Video Window"
    - Resize maintains aspect ratio
```

### 15B: Scripting API / Extension System

#### Backend
```cpp
// Option A: Embed QuickJS (small, embeddable JS engine)
//   - Runs user scripts in sandboxed JS context
//   - Expose API: studio.getTracks(), studio.addTrack(), studio.play(), etc.
//   - Scripts can register as custom actions in the action registry
//
// Option B: Lua via sol2 (lightweight, fast)
//   - Similar API surface
//   - Smaller footprint than JS
//
// Bridge: executeScript(code) -> { result, error }
//         loadScriptFile(filePath) -> { result, error }
```

#### Frontend
```
FE: ScriptEditor.tsx (new)
    - Monaco editor or CodeMirror with syntax highlighting
    - Run/Stop buttons
    - Console output panel
    - Script file browser
    - "Install Script" from file/URL
    - Scripts appear as actions in Command Palette
```

### 15C: Multi-tab Project (MDI)

#### Architecture
```
This is the most complex remaining feature — requires fundamental restructuring.

Current: Single DAWState in useDAWStore
Needed: Array of DAWState, one per tab

Approach:
1. Wrap DAWState in ProjectTab: { id, name, state: DAWState, isActive }
2. Root store: { tabs: ProjectTab[], activeTabIndex: number }
3. All component selectors must go through activeTab.state
4. AudioEngine: serialize/restore state when switching tabs
   OR: maintain separate processing graphs per tab (memory intensive)

Backend:
  - AudioEngine needs to support multiple processing graphs
  - Or: stop playback, serialize current graph, load new graph on tab switch
  - Bridge: setActiveProject(index) to switch audio engine context

Frontend:
  - TabBar component above MenuBar
  - Each tab shows project name (from projectName state)
  - Right-click tab: Close, Close Others, Duplicate
  - Drag tabs to reorder
  - Ctrl+Tab to switch tabs
```

### 15D: Custom Toolbar Creation

#### Frontend
```
FE: ToolbarEditor.tsx (new)
    - Drag actions from action registry onto toolbar slots
    - Choose icon for each button (from lucide-react icon set)
    - Save toolbar configuration
    - Store: customToolbars: Array<{ id, name, buttons: Array<{ actionId, icon }> }>
    - Render custom toolbars below MainToolbar
    - View menu: "Toolbars" submenu to show/hide custom toolbars
```

### 15E: SMPTE LTC Generation

#### Backend (`Source/TimecodeGenerator.h/cpp` — new)
```cpp
// SMPTE LTC (Linear Timecode) is an audio signal encoding time:
//   - Biphase mark encoding of 80-bit frames
//   - Frame rate: 24, 25, 29.97df, 30 fps
//   - Each frame encodes: hours, minutes, seconds, frames + user bits
//
// Implementation:
//   1. Generate LTC audio signal at current transport position
//   2. Output on designated audio channel (or virtual track)
//   3. Use libtc or implement from SMPTE 12M spec
//
// Bridge: setLTCOutput(enabled, channel, frameRate)
//         Current SMPTE display already works — this adds audio output
```

---

## Phase 16: Pro Audio & Compatibility
> **Very heavy backend** | **~4 features** | Estimated: 5-10 days

### 16A: Multichannel Rendering

#### Backend
```cpp
// AudioEngine currently outputs stereo (2ch)
// Changes needed:
//   1. Track channel count: mono (1), stereo (2), 5.1 (6), 7.1 (8), ambi (4+)
//   2. AudioBuffer sizing: per-track channel count in processing graph
//   3. Surround panner: replaces stereo pan knob
//   4. Master bus: sum all tracks into N-channel master
//   5. Render: write multichannel WAV (JUCE supports up to 256 channels)
//   6. Channel format metadata in WAV (speaker positions)
```

#### Frontend
```
FE: Channel configuration per track
    - Track header: channel format selector (mono/stereo/5.1/7.1)
    - Surround panner widget: replaces horizontal pan slider
    - Mixer: multichannel meters
    - RenderModal: channel count option beyond stereo/mono
```

### 16B: 32-bit Plugin Bridging

#### Backend
```cpp
// Create a separate 32-bit host process:
//   1. tools/pluginbridge32.exe (compiled as 32-bit)
//   2. IPC via shared memory + named pipes
//   3. Bridge process loads 32-bit VST2/3 plugins
//   4. Audio buffers exchanged via shared memory
//   5. Parameter changes via pipe messages
//   6. GUI: bridge process creates plugin window, host embeds via HWND
//
// PluginManager: detect plugin bitness during scan
//   32-bit plugins route to bridge process
//   64-bit plugins load normally
//
// This is one of the most complex features — consider deferring
```

### 16C: DDP Disc Image Export

#### Backend
```cpp
// DDP (Disc Description Protocol) for CD mastering:
//   1. DDPID: text file identifying DDP version
//   2. DDPMS: binary map stream describing tracks
//   3. IMAGE.DAT: raw 16-bit 44.1kHz PCM audio data
//   4. PQ subcode: CD track markers from project regions
//
// Validate Red Book compliance:
//   - Minimum 4-second gap between tracks (or 2s for gapless)
//   - Maximum 99 tracks
//   - Total duration ≤ 79:57:74 (frames)
//   - Audio: 16-bit, 44.1kHz, stereo
//
// Implementation: ~500 lines of binary file writing
// Bridge: exportDDP(outputDir, regions[], audioFilePath)
```

### 16D: Save Live Output to Disk

#### Backend
```cpp
// Record the master output to a file while playing:
//   1. In audioDeviceIOCallbackWithContext(), after master mix:
//      If liveRecording: write master buffer to ThreadedWriter
//   2. Bridge: startLiveCapture(filePath, format)
//              stopLiveCapture() -> { filePath, duration }
//   3. Uses same ThreadedWriter pattern as AudioRecorder
```

#### Frontend
```
FE: TransportBar or File menu: "Capture Output" toggle button
    - When enabled: shows recording indicator + duration counter
    - Stop: saves file, optionally imports into project
```

---

## Dependency Graph

```
Phase 8  (FE-only polish)     ─── no dependencies, start immediately
  │
Phase 9  (Audio engine)       ─── needs C++ build environment
  │
Phase 10 (Render pipeline)    ─── depends on Phase 9 for LUFS/dither
  │                                ─── depends on Phase 8 for render queue
  │
Phase 11 (Routing/Mixing)     ─── TrackProcessor sends already in C++
  │                                ─── Phase 11B depends on 11A
  │
Phase 12 (Media/File mgmt)    ─── independent of other phases
  │
Phase 13 (Advanced editing)   ─── 13C depends on Phase 9 (audio processing)
  │                                ─── 13B is independent
  │
Phase 14 (Theming)            ─── independent, can run parallel
  │
Phase 15 (Platform)           ─── 15A needs FFmpeg video integration
  │                                ─── 15C is the most disruptive (MDI)
  │
Phase 16 (Pro audio)          ─── should be last, most complex
                                   ─── 16A needs Phase 11 routing
```

### Recommended Parallel Tracks

```
Track A (Frontend):  Phase 8 → Phase 14 → Phase 13B/D → Phase 15D
Track B (Backend):   Phase 9 → Phase 10 → Phase 11A → Phase 12A-C
Track C (Mixed):     Phase 12D-E → Phase 13A/C → Phase 15A-B
Track D (Deferred):  Phase 15C → Phase 16 (MDI + Pro Audio — do last)
```

---

## Effort Estimates

| Phase | Features | Backend Days | Frontend Days | Total Est. |
|-------|----------|-------------|---------------|------------|
| **8** | 12 | 0 | 2-3 | **2-3 days** |
| **9** | 6 | 3-4 | 1-2 | **4-6 days** |
| **10** | 12 | 2-3 | 2-3 | **3-5 days** |
| **11** | 3 | 2-3 | 2-3 | **3-5 days** |
| **12** | 5 | 2-3 | 1-2 | **3-4 days** |
| **13** | 4 | 2-4 | 2-3 | **3-5 days** |
| **14** | 4 | 0 | 2-3 | **2-3 days** |
| **15** | 5 | 3-5 | 3-4 | **5-8 days** |
| **16** | 4 | 4-8 | 2-3 | **5-10 days** |
| **TOTAL** | **52** | **18-33** | **17-26** | **30-49 days** |

### Quick Win vs. Heavy Lift

**Quick wins (< 1 day each):**
Recovery Mode, Empty Item, Track Spacer, Lock Settings, Recent Actions,
Master Track in TCP, RAW PCM format, Online Render, Add Rendered Items

**Heavy lifts (3+ days each):**
Time Stretch/Pitch Shift, Multichannel Rendering, 32-bit Plugin Bridging,
Multi-tab Project (MDI), Scripting API, Video Playback, Routing Matrix

---

## Implementation Priority Order

### Tier 1: High Value, Low Effort (Do First)
1. Phase 8A: Quick frontend wins (Recovery Mode, Empty Item, Track Spacer, etc.)
2. Phase 8B: Render Queue, Screensets, Macros
3. Phase 14A-B: Theme System + Adjuster

### Tier 2: Core Professional Features
4. Phase 9A-B: Reverse Clip + Dynamic Split
5. Phase 10A-B: Render source/bounds expansion
6. Phase 11: Routing & Sends
7. Phase 12A: Media Explorer

### Tier 3: Advanced Production
8. Phase 9D-E: LUFS/True Peak + Dither
9. Phase 10C-D: Format expansion + Metadata
10. Phase 13A-B: Crossfade Editor + Takes

### Tier 4: Platform & Extensibility
11. Phase 15A: Video Playback
12. Phase 15B: Scripting API
13. Phase 15D: Custom Toolbars
14. Phase 14C-D: Mouse Modifiers + Docker System

### Tier 5: Deferred / Pro Audio
15. Phase 13C: Time Stretching (needs Rubber Band)
16. Phase 15C: Multi-tab Project (MDI)
17. Phase 16: All pro audio features
