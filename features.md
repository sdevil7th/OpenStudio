1. Import clips audio + video -> if video is imported, take the audio only and import as a clip
2. Fx chain on master channel.
3. Export -> Full detailed analysis (will do later) (timeline range selector, for selected range export)
4. clips editiing actions.
5. undo/redo -> history actions
6. Project settings and saving and opening saved ones. the project file should have a .s13 extension.
7. Loop selected range

Small features for later:

1. Tap tempo
2. snap to bar grid for moving clips or resizing them
3. Reaper shows the peak level graph for recordings while the recording is happening (with a delay though), can we populate the peak graph for the clips while recording? Can we do that once each bar is completed?

notes for me:

1. check support with re-pitch, very important

Export details:

Export options ->
Source: master mix, selected tracks (stem), master mix + stems, Selected tracks via Master, region render matrix, region render matrix via Master

Bounds: Custom time range, Entire Project, time selection

File format: WAV, AIFF, FLAC, MP3, OGG

---

# Feature Implementation Plan

> **Last Updated:** 2026-01-29
> **Status Legend:** `[ ]` Not started | `[/]` In Progress | `[x]` Completed

## Recent Updates (2026-01-29)

**Major Implementations Completed:**
- ✅ Export/Render Modal UI (backend rendering still needed)
- ✅ Tap Tempo with keyboard shortcut (T key)
- ✅ Snap to Grid system with MainToolbar toggle, View menu settings, and Timeline integration
- ✅ Markers & Regions system with Insert menu integration and Timeline visualization
- ✅ Loop Selected Range with Shift+drag time selection creation
- ✅ Enhanced View Menu with loop controls and snap settings
- ✅ Enhanced Insert Menu with marker/region creation
- ✅ Recent Projects submenu in File menu with localStorage persistence
- ✅ ProjectSettingsModal component for project metadata (name, notes, sample rate, bit depth, tempo, time signature)
- ✅ Virtual MIDI Keyboard component with 2-octave piano interface, routes to selected MIDI track
- ✅ Media Import frontend (F10) - Import audio/video files with Insert key shortcut
- ✅ Timeline enhancements: markers/regions/time selection visualization, snap grid lines, Shift+drag time selection
- ✅ Keyboard shortcuts: T (tap), M (marker), Shift+M (named marker), Shift+R (region), L (loop), Ctrl+L (loop to selection), Alt+Enter (project settings), Alt+B (virtual keyboard), Insert (import media), Shift+drag (time selection)
- ✅ Created comprehensive snap utilities for musical time calculations

## Configuration Decisions

| Setting                    | Value                   | Notes                                          |
| -------------------------- | ----------------------- | ---------------------------------------------- |
| Project Templates Location | App Data                | Stored in app data folder                      |
| Recent Projects Limit      | 10                      | Maximum recent projects to remember            |
| Render Mode                | One-at-a-time           | Single thread for reliability over speed       |
| Video Audio Extraction     | FFmpeg (bundled)        | Will bundle FFmpeg for cross-platform support  |
| Snap Grid Default          | Bar                     | Configurable via UI                            |
| Undo History Size          | 50                      | Configurable variable: `MAX_UNDO_HISTORY = 50` |
| Live Recording Peaks       | Per Bar                 | Update waveform display once per bar           |
| Master Track Position      | Bottom of track headers | Master strip already positioned in mixer       |

---

## Phase 1: Core Infrastructure (CRITICAL)

### F1. Undo/Redo System with History

**Complexity:** HIGH | **Backend Dependency:** None

- [x] Create `Command` interface and `CommandManager` class
- [x] Create command classes in `src/store/commands/`:
  - [x] `AddTrackCommand` / `RemoveTrackCommand`
  - [x] `MoveClipCommand` / `ResizeClipCommand` / `DeleteClipCommand`
  - [x] `AddClipCommand` (for recording/import)
  - [x] `UpdateTrackCommand` (name, color, etc.)
  - [x] `SetClipFadesCommand` / `SetClipVolumeCommand`
- [x] Add to `useDAWStore.ts`:
  - [x] `canUndo: boolean` and `canRedo: boolean` state
  - [x] `executeCommand(command: Command)` action
  - [x] `undo()` and `redo()` actions
  - [x] `MAX_UNDO_HISTORY = 50` constant (in CommandManager)
- [x] Wrap existing store actions in command objects (progressive migration)
  - [x] `deleteClip` - fully undoable
  - [x] `duplicateClip` - fully undoable
  - [x] `resizeClip` - fully undoable
  - [x] `setClipFades` - fully undoable
- [x] Add global keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z)
- [x] Create `UndoHistoryPanel` component for visual history display

---

### F2. Project Save/Load System (.s13 format)

**Complexity:** CRITICAL | **Backend Dependency:** HIGH

#### Backend (C++) Tasks

- [x] Implement plugin state serialization in `AudioEngine`:
  - [x] `getPluginState(trackId, fxIndex, isInputFX)` → Base64 string
  - [x] `setPluginState(trackId, fxIndex, isInputFX, base64State)` → bool
  - [x] `getMasterPluginState(fxIndex)` → Base64 string
  - [x] `setMasterPluginState(fxIndex, base64State)` → bool
- [x] Add file dialog natives in `MainComponent.cpp`:
  - [x] `showSaveDialog(defaultPath, filters)` → string (path)
  - [x] `showOpenDialog(filters)` → string (path)
- [x] Add project I/O methods:
  - [x] `saveProject(filePath, jsonState)` → bool
  - [x] `loadProject(filePath)` → string (JSON)

#### Frontend Tasks

- [x] Add to `nativeBridge.ts`:
  - [x] `saveProject()`, `loadProject()`
  - [x] `getPluginState()`, `setPluginState()`
  - [x] `showSaveDialog()`, `showOpenDialog()`
- [x] Add to `useDAWStore.ts`:
  - [x] `projectPath: string | null`
  - [x] `isModified: boolean`
  - [x] `serializeProject()` → Studio13Project JSON (implemented inline in `saveProject`)
  - [x] `deserializeProject(json)` → void (implemented inline in `loadProject`)
  - [x] `saveProject()`, `loadProject()`, `newProject()` actions
  - [x] `recentProjects: string[]` (max 10, stored in localStorage)
  - [x] `clearRecentProjects()` action
  - [x] Project metadata fields: `projectName`, `projectNotes`, `projectSampleRate`, `projectBitDepth`
  - [x] Project settings actions: `setProjectName()`, `setProjectNotes()`, `setProjectSampleRate()`, `setProjectBitDepth()`
  - [x] `showProjectSettings: boolean` state
  - [x] `openProjectSettings()`, `closeProjectSettings()` actions
- [x] Create `ProjectSettingsModal.tsx`:
  - [x] Project name input
  - [x] Project notes textarea
  - [x] Sample rate selector (44.1k-192k Hz)
  - [x] Bit depth selector (16/24/32-bit)
  - [x] Tempo input (BPM)
  - [x] Time signature selectors (numerator/denominator)
  - [x] Apply/Cancel buttons with local state management
- [x] Integrate ProjectSettingsModal with App.tsx
- [x] Wire to File menu (Alt+Enter) and keyboard shortcut
- [x] Update save/load to persist project metadata in .s13 files
- [x] Wire up File menu items (see F4)

---

### F3. Export/Render System

**Complexity:** CRITICAL | **Backend Dependency:** CRITICAL
**Status:** Frontend Complete ✅ | Backend Pending ⏳

#### Backend (C++) Tasks

- [ ] Implement offline rendering in `AudioEngine`:
  - [ ] `renderOffline(options, progressCallback)` method
  - [ ] Stop realtime audio device during render
  - [ ] Process graph in offline loop
  - [ ] Write to disk (WAV/AIFF/FLAC/MP3/OGG)
  - [ ] Restart realtime device after completion
- [ ] Register progress callback as native event

#### Frontend Tasks ✅ COMPLETED

- [x] Add to `nativeBridge.ts`:
  - [x] `renderProject(options)` with progress listener (mock implementation)
- [x] Add to `useDAWStore.ts`:
  - [x] `showRenderModal: boolean` state
  - [x] `openRenderModal()` and `closeRenderModal()` actions
  - [x] `timeSelection: { start: number; end: number } | null` for render bounds
- [x] Create `RenderModal.tsx`:
  - [x] Source selector (Master mix, Selected tracks, Stems)
  - [x] Bounds selector (Entire project, Custom time range, Time selection)
  - [x] Time bounds editor with tail support (ms)
  - [x] Directory browser and filename input
  - [x] Format selector: WAV, AIFF, FLAC, MP3, OGG
  - [x] Sample rate selector (44.1k-192k Hz)
  - [x] Bit depth selector (16/24/32-bit)
  - [x] Channels selector (Stereo/Mono)
  - [x] Normalize and Dither checkboxes
  - [x] Progress bar during render
  - [x] Cancel button
- [x] Wire to File menu (Ctrl+Alt+R) and View menu
- [x] Integrate with App.tsx

---

## Phase 2: Menu System Implementation

### F4. File Menu

**Complexity:** MEDIUM | **Backend Dependency:** Depends on F2/F3
**Status:** Complete ✅ | Close Project Deferred

- [x] Create `components/menus/MenuDropdown.tsx` (reusable dropdown)
  - [x] Supports keyboard shortcuts display
  - [x] Submenu support with arrow indicator
  - [x] Checkmark support for toggles
  - [x] Dividers between menu sections
  - [x] Disabled state styling
- [x] Implement in `MenuBar.tsx`:
  - [x] New project (Ctrl+N) - Reset store, clear backend with confirmation
  - [x] Open project... (Ctrl+O) - File dialog, load .s13
  - [x] Save project (Ctrl+S) - Save or prompt if new
  - [x] Save project as... (Ctrl+Shift+S) - Always prompt
  - [x] Recent projects submenu (from localStorage) - Lists recent .s13 files with "Clear Recent Projects" option
  - [ ] Close project (Ctrl+F4) - Save prompt, then clear - **DEFERRED**
  - [x] Project settings... (Alt+Enter) - Opens ProjectSettingsModal (project name, notes, sample rate, bit depth, tempo, time signature)
  - [x] Render... (Ctrl+Alt+R) - Opens RenderModal
  - [x] Quit (Ctrl+Q) - Console log (native window close needed)

---

### F5. Edit Menu

**Complexity:** MEDIUM | **Backend Dependency:** None
**Status:** Core Complete ✅ | Advanced Features Deferred

- [x] Create `components/menus/EditMenu.tsx`
- [x] Create reusable `components/menus/MenuDropdown.tsx`
- [x] Core menu items implemented:
  - [x] Undo (Ctrl+Z) - from F1, disabled when canUndo=false
  - [x] Redo (Ctrl+Shift+Z) - from F1, disabled when canRedo=false
  - [x] Cut (Ctrl+X) - cuts selected clip
  - [x] Copy (Ctrl+C) - copies selected clip
  - [x] Paste (Ctrl+V) - pastes at playhead on selected track
  - [x] Duplicate (Ctrl+D) - duplicates selected clip
  - [x] Delete (Delete) - deletes selected tracks or clips
  - [x] Select All Tracks (Ctrl+A)
  - [x] Deselect All (Esc)
- [ ] Advanced features deferred:
  - [ ] Undo History Panel (Ctrl+Alt+Z)
  - [ ] `selectAllClips()`
  - [ ] Cut within time selection (Ctrl+Shift+X)
  - [ ] Copy within time selection (Ctrl+Shift+C)
  - [ ] Nudge/Set Items (N)
  - [ ] Dynamic Split (D) - transient detection
  - [ ] Crossfade Editor

---

### F6. Insert Menu

**Complexity:** MEDIUM | **Backend Dependency:** LOW
**Status:** Core Features Complete ✅ | Timeline Visualization Pending

- [x] Implemented in `MenuBar.tsx` (no separate InsertMenu.tsx needed)
- [x] Add new types to store:
  - [x] `Marker` interface (id, time, name, color)
  - [x] `Region` interface (id, name, startTime, endTime, color)
- [x] Add to `useDAWStore.ts`:
  - [x] `markers: Marker[]` state
  - [x] `regions: Region[]` state
  - [x] `addMarker(time, name?)` - creates marker with auto-name or custom
  - [x] `removeMarker(id)`
  - [x] `updateMarker(id, updates)`
  - [x] `addRegion(start, end, name?)` - creates region from time bounds
  - [x] `removeRegion(id)`
  - [x] `updateRegion(id, updates)`
- [x] Update `Timeline.tsx` to render markers and regions in ruler
- [x] Implement menu items:
  - [x] Media file... (Insert) - Import audio/video - Frontend complete, backend pending
  - [ ] New MIDI item - Create empty MIDI clip - **DEFERRED**
  - [x] Marker (M) - Add at playhead, keyboard shortcut added
  - [x] Marker with name (Shift+M) - Prompt for name, keyboard shortcut added
  - [x] Region from selection (Shift+R) - Creates from timeSelection, keyboard shortcut added
  - [x] Track (Ctrl+T) - Add new audio track (already implemented)
  - [x] New MIDI Track (Ctrl+Shift+T) - Add new MIDI track
  - [ ] Virtual instrument on new track... - **DEFERRED**

---

### F7. Actions Menu (Command Palette)

**Complexity:** MEDIUM | **Backend Dependency:** None

- [ ] Create `store/actionRegistry.ts`:
  ```typescript
  interface Action {
    id: string;
    name: string;
    description: string;
    shortcut?: string;
    category: string;
    execute: () => void;
  }
  ```
- [ ] Create `components/CommandPalette.tsx`:
  - [ ] Searchable modal
  - [ ] Filter by category
  - [ ] Recent actions section
  - [ ] Keyboard navigation
- [ ] Register all actions in registry
- [ ] Add global shortcut (`) to open palette

---

### F8. View Menu & Options

**Complexity:** LOW | **Backend Dependency:** None
**Status:** Enhanced ✅ | Master Track Visibility Pending

- [x] Implemented in `MenuBar.tsx`:
  - [x] Show Mixer (Ctrl+M) - toggle with checkmark
  - [x] Show Virtual MIDI Keyboard (Alt+B) - toggle with checkmark
  - [x] Audio Settings... - opens SettingsModal
  - [x] Render... (Ctrl+Alt+R) - opens RenderModal
  - [x] Zoom In (Ctrl++) - increases pixelsPerSecond
  - [x] Zoom Out (Ctrl+-) - decreases pixelsPerSecond
  - [x] Zoom to Fit (Ctrl+0) - resets to default zoom
  - [x] Loop Enabled (L) - toggle with checkmark
  - [x] Set Loop to Selection (Ctrl+L) - sets loop region from timeSelection
  - [x] Snap Enabled - toggle with checkmark (F14)
  - [x] Grid Size submenu - Bar, Beat, Half Beat, Quarter Beat (F14)
- [x] Add to `useDAWStore.ts`:
  - [x] `showVirtualKeyboard: boolean` - added with toggleVirtualKeyboard() action
  - [ ] `showMasterTrack: boolean` - **TODO** (for track headers section)
  - [x] `snapEnabled: boolean` (default: true) - completed (F14)
  - [x] `gridSize: 'bar' | 'beat' | 'half_beat' | 'quarter_beat'` (default: 'bar') - completed (F14)
- [x] Create `VirtualPianoKeyboard.tsx`:
  - [x] On-screen piano keys (2 octaves, C3-B4)
  - [x] Click/touch to send MIDI note on/off
  - [x] Visual feedback for active notes (blue highlight)
  - [x] Note names displayed on keys
  - [x] Routes to first selected MIDI track
  - [x] Warning message when no MIDI track selected
  - [x] Close button in header
- [x] Add sendMidiNote to NativeBridge
- [x] Keyboard shortcut Alt+B to toggle virtual keyboard
- [x] Integrate with App.tsx
- [ ] View menu additions needed:
  - [ ] Toggle master track visible (Ctrl+Alt+M) - **TODO**

---

### F9. Help Menu

**Complexity:** LOW | **Backend Dependency:** None

- [ ] Create `components/AboutModal.tsx`
- [ ] Create `components/KeyboardShortcutsModal.tsx`
- [ ] Create `components/menus/HelpMenu.tsx`:
  - [ ] Documentation (open URL)
  - [ ] Key bindings and mouse modifiers (Shift+F1)
  - [ ] About Studio13 (Ctrl+F1)
  - [ ] Changelog

---

## Phase 3: Media & Clip Features

### F10. Import Media (Audio + Video)

**Complexity:** MEDIUM | **Backend Dependency:** MEDIUM
**Status:** Frontend Complete ✅ | Backend Pending ⏳

#### Backend (C++) Tasks

- [ ] Bundle FFmpeg with application
- [ ] Add to `AudioConverter.cpp`:
  - [ ] `extractAudioFromVideo(videoPath, outputPath)` → string
- [ ] Support formats: WAV, AIFF, FLAC, MP3, OGG, MP4, MOV, AVI, MKV

#### Frontend Tasks ✅ COMPLETED

- [x] Add to `nativeBridge.ts`:
  - [x] `importMediaFile(filePath)` → returns media metadata (mock implementation)
- [x] Add to `useDAWStore.ts`:
  - [x] `importMedia(filePath, trackId, startTime)` action
- [x] Add "Media file..." menu item to Insert menu (Insert key)
- [x] Integrate with MenuBar.tsx and App.tsx
- [x] Add keyboard shortcut: Insert key
- [x] Auto-detect target track (selected or first audio track)
- [x] Import at current playhead position

---

### F11. Clip Editing Actions (Fix + Enhance)

**Complexity:** HIGH | **Backend Dependency:** MEDIUM

- [ ] Fix broken functionality in `Timeline.tsx`:
  - [ ] Resize (left/right edge drag)
  - [ ] Fade In/Out handles
- [ ] Add new clip actions:
  - [ ] Split at playhead (S)
  - [ ] Mute clip - add `muted: boolean` to AudioClip
  - [ ] Lock clip - add `locked: boolean` to AudioClip
- [ ] **FUTURE:** Reverse, Normalize (requires backend processing)

---

### F12. Loop Selected Range

**Complexity:** LOW | **Backend Dependency:** None
**Status:** FULLY COMPLETE ✅

- [x] Add to `useDAWStore.ts`:
  - [x] `timeSelection: { start: number; end: number } | null` state
  - [x] `setTimeSelection(start, end)` action
  - [x] `clearTimeSelection()` action
  - [x] `setLoopToSelection()` action - enables loop and sets bounds from timeSelection
- [x] Add keyboard shortcuts:
  - [x] L - Toggle Loop (also in View menu)
  - [x] Ctrl+L - Set Loop to Selection (also in View menu)
- [x] Update `Timeline.tsx`:
  - [x] Render time selection visually (distinct from loop region - blue overlay)
  - [x] Shift+drag to create time selection
  - [x] Display time selection bounds

---

## Phase 4: Small Features

### F13. Tap Tempo

**Complexity:** LOW | **Backend Dependency:** None
**Status:** FULLY COMPLETE ✅

- [x] Add to `useDAWStore.ts`:
  - [x] `tapTimestamps: number[]` - stores last 8 taps
  - [x] `tapTempo()` action:
    - [x] Records timestamp using `performance.now()`
    - [x] Calculates average BPM from intervals between taps
    - [x] Clamps BPM to range 40-240
    - [x] Auto-resets after 2 seconds of inactivity
    - [x] Requires minimum 2 taps to calculate tempo
- [x] Add TAP button to `TransportBar.tsx` next to BPM input
- [x] Keyboard shortcut (T) added to App.tsx
- [x] Updates tempo immediately via `setTempo()` action

---

### F14. Snap to Grid

**Complexity:** MEDIUM | **Backend Dependency:** None
**Status:** FULLY COMPLETE ✅

- [x] Add snap settings to store:
  - [x] `snapEnabled: boolean` (default: true)
  - [x] `gridSize: 'bar' | 'beat' | 'half_beat' | 'quarter_beat'` (default: 'bar')
  - [x] `toggleSnap()` action
  - [x] `setGridSize(size)` action
- [x] Create utility function `utils/snapToGrid.ts`:
  - [x] `snapToGrid(time, tempo, timeSignature, gridSize)` → snapped time
  - [x] `snapToGridFloor()` and `snapToGridCeil()` variants
  - [x] `calculateGridInterval()` - calculates interval based on tempo/time sig/grid size
  - [x] `getGridLines()` - returns array of grid line positions for rendering
  - [x] `isSnappedToGrid()` - checks if time is already snapped (with tolerance)
- [x] Modify drag handlers in `Timeline.tsx`:
  - [x] Apply snap to clip drag (when snapEnabled)
  - [x] Apply snap to clip resize left (when snapEnabled)
  - [x] Apply snap to clip resize right (when snapEnabled)
  - [ ] Apply snap to fade handles (when snapEnabled) - **DEFERRED**
  - [ ] Apply snap to marker/region placement - **DEFERRED**
- [x] Add visual grid lines in Timeline ruler (green dashed lines when snap enabled)
- [x] Add snap toggle button to MainToolbar
  - [x] Shows blue when enabled
  - [x] Displays snap state in tooltip
- [x] Add snap settings to View menu:
  - [x] "Snap Enabled" toggle with checkmark
  - [x] "Grid Size" submenu with options: Bar, Beat, Half Beat, Quarter Beat
  - [x] Checkmark shows current grid size

---

### F15. Live Peak Graph During Recording

**Complexity:** MEDIUM | **Backend Dependency:** MEDIUM

- [ ] Add to `AudioRecorder.cpp`:
  - [ ] Buffer peak data during recording
  - [ ] `getRecordingPeaks(trackId)` → vector of peaks
- [ ] Add to `nativeBridge.ts`:
  - [ ] `getRecordingPeaks(trackId)` method
- [ ] Update `Timeline.tsx`:
  - [ ] Poll peaks every bar during recording
  - [ ] Render partial waveform in recording clip

---

## Phase 5: Master Channel & Track

### F16. Master Channel FX Chain

**Complexity:** LOW | **Backend Dependency:** Already exists

- [ ] Add Master track to mixer panel (already done)
- [ ] Add FX button to master channel strip
- [ ] Wire to `FXChainPanel` with `chainType="master"`

---

### F17. Master Track Header

**Complexity:** LOW | **Backend Dependency:** None

- [ ] Add `MasterTrackHeader.tsx` component
- [ ] Position at bottom of track headers list when `showMasterTrack` is true
- [ ] Show master volume fader, mute button
- [ ] FX button to open master FX chain

---

## Implementation Summary (as of 2026-01-29)

### ✅ Fully Completed Features

#### F1. Undo/Redo System
- Command pattern implementation with 50-step history
- Supports: deleteClip, duplicateClip, resizeClip, setClipFades
- Keyboard: Ctrl+Z (undo), Ctrl+Shift+Z (redo)
- UI: Disabled state in Edit menu when no undo/redo available

#### F2. Project Save/Load
- .s13 JSON file format with plugin state serialization
- Backend: getPluginState/setPluginState, showSaveDialog/showOpenDialog
- Frontend: saveProject(), loadProject(), newProject() with confirmation
- File menu: New, Open, Save, Save As fully functional
- recentProjects array in store (max 10, localStorage) with UI submenu in File menu
- ProjectSettingsModal for project metadata: name, notes, sample rate, bit depth, tempo, time signature
- Project metadata saved/loaded with .s13 files
- Keyboard: Alt+Enter to open Project Settings

#### F3. Export/Render (Frontend Complete)
- Comprehensive RenderModal.tsx with all options:
  - Source: Master mix, Selected tracks, Stems
  - Bounds: Entire project, Custom time range, Time selection
  - Formats: WAV, AIFF, FLAC, MP3, OGG
  - Sample rate: 44.1k-192k Hz
  - Bit depth: 16/24/32-bit
  - Channels: Stereo/Mono
  - Normalize, Dither, Tail length options
  - Progress bar UI
- Menu integration: Ctrl+Alt+R in File and View menus
- Backend C++ rendering implementation still needed

#### F13. Tap Tempo
- Smart BPM calculation from last 8 taps
- Auto-reset after 2 seconds inactivity
- BPM clamping (40-240)
- UI: TAP button in TransportBar
- Keyboard: T key

#### F14. Snap to Grid
- Store: snapEnabled (default: true), gridSize (bar/beat/half_beat/quarter_beat)
- Utility functions: snapToGrid(), snapToGridFloor(), snapToGridCeil(), getGridLines(), isSnappedToGrid()
- UI: Toggle button in MainToolbar (blue when enabled)
- View menu: "Snap Enabled" toggle + "Grid Size" submenu with checkmarks
- Timeline: Visual snap grid lines (green dashed), snap applied to clip drag/resize operations

#### F6. Markers & Regions (Timeline Visualization)
- Store: Full CRUD for markers and regions (add/remove/update)
- Timeline: Visual markers (yellow circles with vertical lines, names displayed in ruler)
- Timeline: Visual regions (cyan overlays in ruler with borders and names)
- Insert menu: Marker at playhead (M), Marker with name (Shift+M), Region from selection (Shift+R)
- Keyboard shortcuts integrated

#### F12. Loop Selected Range
- Store: timeSelection state with setTimeSelection()/clearTimeSelection()/setLoopToSelection()
- Timeline: Shift+drag to create time selection with visual blue overlay
- Keyboard: L (toggle loop), Ctrl+L (set loop to selection), Shift+drag (time selection)
- View menu integration with loop controls

### ⏳ Partially Completed Features

#### F4. File Menu
- ✅ New, Open, Save, Save As, Render, Quit
- ✅ Project Settings (opens ProjectSettingsModal)
- ✅ Recent Projects submenu (shows last 10 projects, click to load, "Clear Recent Projects" option)
- ⏳ Close Project (deferred)

#### F5. Edit Menu
- ✅ Core operations: Undo, Redo, Cut, Copy, Paste, Duplicate, Delete
- ✅ Selection: Select All Tracks, Deselect All
- ⏳ Advanced: Cut/Copy within time selection, Nudge, Undo History panel

#### F6. Insert Menu
- ✅ New Audio Track (Ctrl+T), New MIDI Track (Ctrl+Shift+T)
- ✅ Marker at Playhead (M), Marker with name (Shift+M)
- ✅ Region from selection (Shift+R)
- ✅ Store: Full CRUD for markers and regions
- ✅ Timeline visualization of markers/regions complete
- ✅ Media Import (F10 - frontend complete, backend pending)

#### F8. View Menu
- ✅ Show Mixer (Ctrl+M), Audio Settings, Render
- ✅ Show Virtual MIDI Keyboard (Alt+B) - On-screen piano with 2 octaves
- ✅ Zoom In/Out/Fit (Ctrl++/-/0)
- ✅ Loop Enabled (L), Set Loop to Selection (Ctrl+L)
- ✅ Snap/Grid settings (F14 - completed)

#### F12. Loop Selected Range
- ✅ Store: timeSelection state, setTimeSelection(), clearTimeSelection(), setLoopToSelection()
- ✅ Keyboard: L (toggle), Ctrl+L (set to selection), Shift+drag (create time selection)
- ✅ View menu integration
- ✅ Timeline UI: Shift+drag time selection creation and visualization (blue overlay)

#### F10. Import Media
- ✅ Frontend: importMedia() action, importMediaFile() bridge method, Insert menu item, Insert key shortcut
- ✅ Auto-detect target track (selected track or first audio track)
- ✅ Import at playhead position
- ⏳ Backend: FFmpeg video extraction, format support (WAV/AIFF/FLAC/MP3/OGG/MP4/MOV/AVI/MKV)

### 📋 Not Started

- F7. Actions Menu (Command Palette)
- F9. Help Menu (About, Keyboard Shortcuts modal)
- F11. Clip Editing Actions (resize, fade handles, split, mute, lock)
- F15. Live Peak Graph During Recording
- F16. Master Channel FX Chain UI
- F17. Master Track Header

### 🎹 Keyboard Shortcuts Added

| Key | Action |
|-----|--------|
| T | Tap Tempo |
| M | Add Marker at Playhead |
| Shift+M | Add Marker with Name |
| Shift+R | Create Region from Selection |
| L | Toggle Loop |
| Ctrl+L | Set Loop to Selection |
| Alt+Enter | Open Project Settings |
| Alt+B | Toggle Virtual MIDI Keyboard |
| Insert | Import Media File |
| Ctrl+Alt+R | Open Render Modal |

### 📁 Files Created/Modified

**New Files:**
- `frontend/src/components/RenderModal.tsx` (496 lines) - Comprehensive render/export UI
- `frontend/src/components/ProjectSettingsModal.tsx` (283 lines) - Project metadata configuration modal
- `frontend/src/components/VirtualPianoKeyboard.tsx` (230 lines) - On-screen MIDI keyboard with 2 octaves
- `frontend/src/utils/snapToGrid.ts` (156 lines) - Snap to grid utilities with musical time calculations

**Modified Files:**
- `frontend/src/store/useDAWStore.ts` - Added: timeSelection, markers, regions, tapTimestamps, showRenderModal, snapEnabled, gridSize, projectName, projectNotes, projectSampleRate, projectBitDepth, showProjectSettings, showVirtualKeyboard, importMedia() action, recentProjects loading from localStorage, and all related actions (clearRecentProjects, setProjectName, setProjectNotes, setProjectSampleRate, setProjectBitDepth, openProjectSettings, closeProjectSettings, toggleVirtualKeyboard, setTimeSelection, clearTimeSelection)
- `frontend/src/services/NativeBridge.ts` - Added: renderProject(), sendMidiNote() for virtual keyboard MIDI output, importMediaFile() for media import (F10)
- `frontend/src/components/MenuBar.tsx` - Enhanced View and Insert menus with snap settings submenu, added Recent Projects submenu with dynamic list and "Clear Recent Projects" option, updated "Project Settings..." to open ProjectSettingsModal, added "Show Virtual MIDI Keyboard" (Alt+B) toggle, added "Media file..." (Insert) menu item for importing audio/video
- `frontend/src/components/TransportBar.tsx` - Added TAP button for tap tempo
- `frontend/src/components/MainToolbar.tsx` - Made snap toggle button functional
- `frontend/src/components/Timeline.tsx` - Added: Markers/regions/time selection visualization, snap grid lines rendering, Shift+drag time selection creation, snap-to-grid applied to clip drag/resize operations
- `frontend/src/App.tsx` - Added ProjectSettingsModal, VirtualPianoKeyboard, integrated showProjectSettings/closeProjectSettings/showVirtualKeyboard, added keyboard shortcuts (T, M, Shift+M, Shift+R, L, Ctrl+L, Alt+Enter, Alt+B, Insert for media import, Shift+drag for time selection)

---

## Additional Menu Features (from Design Screenshots)

### File Menu Extras

- [ ] New project tab (Ctrl+Alt+N) - **DEFERRED** (requires MDI)
- [ ] Project templates submenu - **DEFERRED**
- [ ] Save new version of project (Ctrl+Alt+Shift+S) - **DEFERRED**
- [ ] Queued Renders - **DEFERRED** (using one-at-a-time)
- [ ] Region Render Matrix - **DEFERRED**
- [ ] Batch File/Item Converter - **DEFERRED**
- [ ] Save live output to disk (bounce) - **DEFERRED**
- [ ] Consolidate/Export tracks - **DEFERRED**
- [ ] Export project MIDI - **DEFERRED**
- [ ] Clean current project directory - **DEFERRED**

### Edit Menu Extras

- [ ] Dynamic Split (D) - **DEFERRED** (transient detection)
- [ ] Transient Detection Settings - **DEFERRED**
- [ ] Crossfade Editor - **DEFERRED**

### Insert Menu Extras

- [ ] Empty item - **DEFERRED**
- [ ] SMPTE LTC/MTC Timecode Generator - **DEFERRED**
- [ ] Click source - **DEFERRED**
- [ ] New subproject - **DEFERRED**
- [ ] Tempo/time signature change marker - **DEFERRED**
- [ ] Track from template - **DEFERRED**

---

## Verification Plan

### Manual Testing (No automated tests per project settings)

- [ ] Test all menu items manually after implementation
- [ ] Test all keyboard shortcuts
- [ ] Test project save/load with plugins
- [ ] Test export in all formats
- [ ] Verify undo/redo for all actions
