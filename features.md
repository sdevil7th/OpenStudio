# Studio13-v3 Feature Tracker

> **Last Updated:** 2026-02-19 (Phase 7E complete: +17 features, 108/160 total)
> **Project Extension:** `.s13`
> **Status Legend:** `[x]` Implemented | `[~]` Partially Implemented | `[ ]` Not Started

---

## Feature Comparison: REAPER vs Studio13

This document maps every feature from REAPER's interface (toolbar, menus, render modal) to Studio13's current implementation status. Features marked as remaining include implementation guidance.

---

## I. Top Toolbar

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| New Project | [x] | Ctrl+N, clears state with confirmation |
| Open Project | [x] | Ctrl+O, native file dialog, loads .s13 |
| Save Project | [x] | Ctrl+S, .s13 JSON format with plugin states |
| Project Settings | [x] | Alt+Enter, ProjectSettingsModal (name, notes, sample rate, bit depth, tempo, time sig) |
| Undo / Redo | [x] | Ctrl+Z / Ctrl+Shift+Z, CommandManager pattern, 50-step history |
| Undo History Window | [x] | Ctrl+Alt+Z toggle, UndoHistoryPanel in View menu, floating panel |
| Metronome Toggle | [x] | Toggle in TransportBar, configurable accents/volume |
| Auto-Crossfade | [x] | Toggle in MainToolbar and View menu, auto-applies fadeIn/fadeOut on clip overlap |
| Snap Options | [x] | Snap toggle + grid size (bar/beat/half/quarter) in MainToolbar and View menu |
| Locking | [x] | Per-clip lock (prevents drag/resize/delete), lock icon overlay, context menu toggle |

### Remaining Toolbar Features

#### Auto-Crossfade Toggle
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** LOW

When two audio clips overlap on the same track, automatically generate a crossfade at the intersection.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `autoCrossfade: boolean` (default: `true`)
   - Add `toggleAutoCrossfade()` action
   - Add `defaultCrossfadeLength: number` (default: `0.05` = 50ms)
2. **Timeline** (`Timeline.tsx`):
   - In the clip drag/move handler, detect overlaps between clips on the same track
   - When overlap detected and `autoCrossfade` enabled:
     - Calculate overlap region
     - Set `fadeOut` on the earlier clip and `fadeIn` on the later clip to match the overlap duration
   - Render crossfade region visually (X-shaped lines between the two fade curves)
3. **Toolbar** (`MainToolbar.tsx`):
   - Add auto-crossfade toggle button (icon: two overlapping waveforms)
4. **Backend**: No changes needed — fades already applied in PlaybackEngine

#### Locking System
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** None

Prevent accidental edits to specific elements (clip position, fades, volume, track order).

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `lockSettings: { items: boolean; envelopes: boolean; timeSelection: boolean; markers: boolean }` (all default `false`)
   - Add `globalLocked: boolean` (default: `false`)
   - Add `toggleGlobalLock()` and `setLockSetting(key, value)` actions
   - Add `locked: boolean` to `AudioClip` interface
2. **Timeline** (`Timeline.tsx`):
   - Before drag/resize/fade operations, check if clip is locked or if global lock + item lock is enabled
   - Show lock icon overlay on locked clips
   - Prevent drag if `lockSettings.items` is true
3. **UI**: Lock button in MainToolbar with right-click context menu showing granular lock options
4. **Track Header**: Add lock icon to per-clip context menu

---

## II. File Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| New Project | [x] | Ctrl+N |
| Open Project | [x] | Ctrl+O |
| Recent Projects | [x] | Submenu with last 10 projects, localStorage persistence |
| Save Project | [x] | Ctrl+S |
| Save Project As | [x] | Ctrl+Shift+S |
| Project Settings | [x] | Alt+Enter |
| Close Project | [x] | Ctrl+F4, prompts save if modified |
| Clean Current Project Directory | [ ] | **NOT IMPLEMENTED** |
| Batch File/Item Converter | [ ] | **NOT IMPLEMENTED** |
| Render | [x] | Ctrl+Alt+R, RenderModal with format/bounds/options |
| Render Queue | [ ] | **NOT IMPLEMENTED** |
| Quit | [x] | Ctrl+Q |
| New Project in Tab | [ ] | **NOT IMPLEMENTED** (requires MDI architecture) |
| Save New Version | [x] | Increments version suffix (project.s13 → project_v2.s13), File menu |
| Save Live Output to Disk | [ ] | **NOT IMPLEMENTED** |
| Consolidate/Export Tracks | [ ] | **NOT IMPLEMENTED** |
| Export Project MIDI | [ ] | **NOT IMPLEMENTED** |
| Recovery Mode (bypass FX on open) | [ ] | **NOT IMPLEMENTED** |
| Timestamped Backup (.s13-bak) | [x] | Auto-backup at configurable intervals, Preferences dialog toggle |

### Remaining File Menu Features

#### ~~Close Project~~ — IMPLEMENTED

#### Clean Current Project Directory
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** MEDIUM

Scan the project folder, identify audio files not referenced by any clip, and offer to delete them.

**Implementation Plan:**
1. **Backend** (`MainComponent.cpp`):
   - Add `cleanProjectDirectory(projectPath, referencedFiles[])` → returns `{orphanedFiles: string[], totalSize: number}`
   - Walks the project directory, compares against referenced file list
   - Add `deleteFiles(filePaths[])` → deletes the orphaned files
2. **Frontend**:
   - Collect all `clip.filePath` values from store
   - Call backend with project directory + referenced files
   - Show modal listing orphaned files with checkboxes + total size
   - Confirm button calls deleteFiles

#### Render Queue
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** LOW

Queue multiple render jobs and execute them sequentially.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `renderQueue: RenderJob[]` (each job = full render options object)
   - Add `addToRenderQueue(options)`, `removeFromRenderQueue(index)`, `executeRenderQueue()` actions
2. **UI**: "Add to Queue" button in RenderModal alongside "Render"
3. **RenderQueuePanel.tsx**: New component showing queued jobs with status, progress, remove buttons
4. **Execution**: Process jobs sequentially, update progress per-job

#### Timestamped Backup
**Priority:** MEDIUM | **Complexity:** LOW | **Backend:** LOW

Auto-save .s13-bak files at configurable intervals.

**Implementation Plan:**
1. **Store**: Add `autoBackupInterval: number` (default: 300000 = 5 min), `autoBackupEnabled: boolean`
2. **App.tsx**: `setInterval` that calls `saveProject()` to `projectPath + '.bak'` with timestamp
3. **Backend**: No changes — `saveProjectToFile` already works with any path
4. **Settings**: Add auto-backup toggle + interval to Project Settings modal

#### Recovery Mode (Bypass FX on Open)
**Priority:** LOW | **Complexity:** LOW | **Backend:** None

Open a project without loading any VST3 plugins (useful when a plugin causes crashes).

**Implementation Plan:**
1. Add `loadProject(path, { bypassFX: true })` option
2. When `bypassFX` is true, skip the FX restoration loop in `deserializeProject()`
3. Add "Open Project (Safe Mode)" to File menu or hold Shift while opening

#### Export Project MIDI
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** MEDIUM

Export all MIDI clips as a single .mid file.

**Implementation Plan:**
1. **Backend**: Use `MIDIClip::exportToMidiFile()` (already exists as skeleton)
2. **Frontend**: Collect all MIDI clips, serialize events, call backend export
3. Requires MIDI clip system to be fully operational first

---

## III. Edit Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Undo | [x] | Ctrl+Z |
| Redo | [x] | Ctrl+Shift+Z |
| Undo History | [x] | Ctrl+Alt+Z toggle, floating panel in View menu |
| Cut | [x] | Ctrl+X, clips |
| Copy | [x] | Ctrl+C, clips |
| Paste | [x] | Ctrl+V, at playhead on selected track |
| Duplicate | [x] | Ctrl+D |
| Delete | [x] | Delete key |
| Select All | [x] | Ctrl+A (tracks) |
| Deselect All | [x] | Esc |
| Ripple Editing (Off/Per-Track/All) | [ ] | **NOT IMPLEMENTED** |
| Split at Cursor | [x] | S key, splits selected clips (or all under playhead) with undo/redo |
| Split at Time Selection | [ ] | **NOT IMPLEMENTED** |
| Crossfade Editor | [ ] | **NOT IMPLEMENTED** |
| Item Properties | [ ] | **NOT IMPLEMENTED** (no dedicated clip inspector) |
| Razor Editing | [ ] | **NOT IMPLEMENTED** |
| Select All Clips | [x] | Ctrl+Shift+A selects all clips across all tracks |
| Cut within Time Selection | [x] | Trims clips to selection bounds, stores in clipboard, removes content |
| Copy within Time Selection | [x] | Trims clips to selection bounds, stores in clipboard |
| Nudge Items | [x] | Arrow Left/Right (grid), Ctrl+Arrow (10ms fine) |
| Dynamic Split (Transient Detection) | [ ] | **NOT IMPLEMENTED** |

### Remaining Edit Menu Features

#### ~~Split at Cursor (S key)~~ — IMPLEMENTED

#### Split at Time Selection
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** None

Split clips at both edges of the time selection, isolating the selected region.

**Implementation Plan:**
1. Same logic as split at cursor but applied at both `timeSelection.start` and `timeSelection.end`
2. Creates up to 3 clips per original clip (before, within, after selection)

#### Ripple Editing
**Priority:** MEDIUM | **Complexity:** HIGH | **Backend:** None

When deleting or inserting clips, automatically shift downstream clips to close/open gaps.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `rippleMode: 'off' | 'per_track' | 'all_tracks'` (default: `'off'`)
   - Add `setRippleMode(mode)` action
2. **Modify existing actions**: `deleteClip`, `splitClipAtPlayhead`, paste — when ripple is enabled:
   - `'per_track'`: After delete, find all clips on same track with `startTime > deletedClip.endTime`, shift them left by deleted clip's duration
   - `'all_tracks'`: Same as above but for ALL tracks
   - For insert/paste: shift downstream clips right
3. **UI**: Three-state toggle button in Edit menu and MainToolbar (Off → Per Track → All Tracks)
4. **Visual**: Show ripple mode indicator in toolbar

#### Razor Editing
**Priority:** MEDIUM | **Complexity:** HIGH | **Backend:** None

Draw rectangular "razor" areas over specific clips/automation without splitting. Can be moved, copied, deleted.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `razorEdits: Array<{ trackId: string; startTime: number; endTime: number }>`
   - Add `addRazorEdit()`, `removeRazorEdit()`, `moveRazorEdit()`, `deleteRazorEditContent()` actions
2. **Timeline** (`Timeline.tsx`):
   - Alt+Right-Drag to create razor areas (red/orange rectangles)
   - Razor areas are per-track (can span partial clips)
   - Delete key on razor area: removes the audio within the razor bounds (splits clips at boundaries, deletes middle)
   - Drag razor area to move the enclosed audio
3. **Render**: "Razor edit areas" source option in RenderModal

#### Crossfade Editor
**Priority:** LOW | **Complexity:** HIGH | **Backend:** None

Dedicated modal for fine-tuning crossfade shape between two overlapping clips.

**Implementation Plan:**
1. **New component** `CrossfadeEditor.tsx`:
   - Shows both waveforms at the crossfade point
   - Fade curve shape selector (linear, equal-power, S-curve, logarithmic)
   - Asymmetric fade handles (in/out can have different shapes)
   - Preview playback of the crossfade region
2. **Store**: Add `crossfadeShape` to clip fade properties
3. **Backend**: PlaybackEngine already applies linear fades — extend to support curve types via lookup table

#### Item/Clip Properties Inspector
**Priority:** MEDIUM | **Complexity:** LOW | **Backend:** None

Floating panel showing all properties of the selected clip (name, file, duration, offset, volume, fades, sample rate).

**Implementation Plan:**
1. **New component** `ClipPropertiesPanel.tsx`:
   - Display: file path, format, sample rate, channels, duration
   - Editable: name, volume (dB), fade in/out (seconds), offset, start time
   - Opens on F2 or double-click clip
2. **Store**: Add `showClipProperties: boolean` and `toggleClipProperties()` action

#### Dynamic Split (Transient Detection)
**Priority:** LOW | **Complexity:** HIGH | **Backend:** HIGH

Automatically split a clip at transient peaks (e.g., drum hits).

**Implementation Plan:**
1. **Backend** (`AudioEngine.cpp`):
   - Add `detectTransients(filePath, sensitivity, minGap)` → returns `double[]` (array of hit times)
   - Use spectral flux or onset detection algorithm
2. **Frontend**: Call backend, get transient times, call `splitClipAtPlayhead()` for each
3. **UI**: Modal with sensitivity slider, preview transient markers on waveform

#### ~~Nudge Items~~ — IMPLEMENTED

---

## IV. View Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Master Track Visible | [ ] | **NOT IMPLEMENTED** (master exists in mixer only) |
| Mixer Control Panel (MCP) | [x] | Ctrl+M toggle |
| Routing Matrix | [ ] | **NOT IMPLEMENTED** |
| Track Wiring Diagram | [ ] | **NOT IMPLEMENTED** |
| Region/Marker Manager | [x] | Floating panel, click to navigate, rename/delete, View menu toggle |
| Media Explorer | [ ] | **NOT IMPLEMENTED** |
| Big Clock | [x] | Floating clock with time/beats format, color-coded by transport state |
| Video Window | [ ] | **NOT IMPLEMENTED** |
| Screensets/Layouts | [ ] | **NOT IMPLEMENTED** |
| Docker/Panel System | [ ] | **NOT IMPLEMENTED** |
| Zoom In/Out/Fit | [x] | Ctrl++/-/0 |
| Loop Toggle | [x] | L key |
| Snap/Grid Settings | [x] | Toggle + grid size submenu |
| Virtual MIDI Keyboard | [x] | Alt+B toggle |

### Remaining View Menu Features

#### Master Track in TCP
**Priority:** MEDIUM | **Complexity:** LOW | **Backend:** None

Show master track at the bottom of the track control panel (TCP) with volume fader, mute, and FX button.

**Implementation Plan:**
1. **New component** `MasterTrackHeader.tsx`:
   - Master volume fader (horizontal), mute button, FX button (opens master FX chain)
   - Fixed at bottom of track header list
2. **Store**: Add `showMasterTrack: boolean` (default: `true`), `toggleMasterTrack()` action
3. **View menu**: "Show Master Track (Ctrl+Alt+M)" toggle item

#### Routing Matrix
**Priority:** LOW | **Complexity:** HIGH | **Backend:** HIGH

Grid-based view where any track can route to any other track or hardware output.

**Implementation Plan:**
1. **Backend** (`AudioEngine.cpp`):
   - Implement send/bus routing — `TrackProcessor` already has a `sends` skeleton
   - Add `createBus()`, `setTrackSend(trackId, busId, level, pan, preFader)` methods
   - Add bus tracks to the processing graph
2. **New component** `RoutingMatrix.tsx`:
   - Grid: rows = source tracks, columns = destination tracks/outputs
   - Click cell to toggle send, drag to set level
3. **Store**: Add `buses: Bus[]`, send levels per track

#### Region/Marker Manager
**Priority:** MEDIUM | **Complexity:** LOW | **Backend:** None

Spreadsheet-like panel listing all markers and regions with batch editing.

**Implementation Plan:**
1. **New component** `MarkerManager.tsx`:
   - Table with columns: Name, Type (marker/region), Time/Start, End, Color
   - Click to navigate to marker/region
   - Edit name/color inline
   - Batch delete selected
   - Sort by time/name
2. **Store**: Already has full CRUD for markers and regions
3. **View menu**: "Region/Marker Manager" item

#### Media Explorer
**Priority:** LOW | **Complexity:** HIGH | **Backend:** MEDIUM

Integrated file browser for auditioning and importing audio files.

**Implementation Plan:**
1. **Backend**: Add `browseDirectory(path)` → returns file list with metadata
   - Add `previewAudioFile(path)` → plays file through monitor output
2. **New component** `MediaExplorer.tsx`:
   - Directory tree browser (left panel)
   - File list with waveform previews
   - Preview playback button (tempo-matched if possible)
   - Drag-and-drop files onto timeline
   - Filter by format, search by name
3. **Store**: Add `mediaExplorerPath`, `mediaExplorerFiles`, browsing actions

#### Big Clock
**Priority:** LOW | **Complexity:** LOW | **Backend:** None

Large floating time/beat display.

**Implementation Plan:**
1. **New component** `BigClock.tsx`:
   - Large monospace font showing: bars:beats:ticks or hh:mm:ss.ms
   - Toggle between time formats
   - Project name, tempo, time signature display
   - Resizable floating panel
2. **Store**: Add `showBigClock: boolean`, `bigClockFormat: 'time' | 'beats'`
3. **View menu**: "Big Clock" toggle item

---

## V. Insert Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| New Track | [x] | Ctrl+T (audio), Ctrl+Shift+T (MIDI) |
| Virtual Instrument on New Track | [x] | Creates instrument track + opens plugin browser, Insert menu |
| Media File | [x] | Insert key, frontend complete |
| Empty MIDI Item | [x] | Insert menu, creates 4-beat empty MIDI clip at playhead on selected/first MIDI track |
| Empty Item | [ ] | **NOT IMPLEMENTED** |
| Click Source | [ ] | **NOT IMPLEMENTED** |
| Marker | [x] | M key at playhead |
| Marker with Name | [x] | Shift+M |
| Region | [x] | Shift+R from time selection |
| Time Signature/Tempo Change Marker | [ ] | **NOT IMPLEMENTED** |
| Track Spacer | [ ] | **NOT IMPLEMENTED** |
| Insert Multiple Tracks | [x] | Prompt for count and type, Insert menu |
| SMPTE LTC/MTC Timecode | [~] | SMPTE timecode display in TransportBar (24/25/29.97/30fps), no LTC generation |

### Remaining Insert Menu Features

#### Virtual Instrument on New Track
**Priority:** HIGH | **Complexity:** MEDIUM | **Backend:** LOW

Macro: creates a new instrument track, opens plugin browser, loads selected VSTi, arms for MIDI.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `addInstrumentTrack()` action that:
     1. Creates track with type `'instrument'`
     2. Opens plugin browser filtered to instruments only
     3. On plugin select: calls `loadInstrument(trackId, vstPath)` (already exists in backend)
     4. Arms track for MIDI, enables input monitoring
2. **PluginBrowser.tsx**: Add `filterType: 'all' | 'effects' | 'instruments'` prop
3. **Insert menu**: "Virtual Instrument on New Track..." item
4. **Backend**: `loadInstrument()` already implemented

#### Time Signature / Tempo Change Markers
**Priority:** MEDIUM | **Complexity:** HIGH | **Backend:** MEDIUM

Place tempo/time-signature changes at specific positions on the timeline, creating a tempo map.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `tempoMarkers: Array<{ id: string; time: number; bpm: number; timeSigNum: number; timeSigDen: number; curveType: 'instant' | 'linear' }>`
   - Add `addTempoMarker(time, bpm, timeSig)`, `removeTempoMarker(id)`, `updateTempoMarker(id, updates)` actions
   - Modify `getTempoAtTime(time)` utility to interpolate between markers
2. **Timeline** (`Timeline.tsx`):
   - Render tempo markers as distinct icons on the ruler (different color from regular markers)
   - Double-click to edit tempo/time-sig values
3. **Backend**: Update metronome and PlaybackEngine to read from tempo map instead of single global BPM
4. **Grid calculation**: `snapToGrid.ts` must account for variable tempo

#### Insert Multiple Tracks
**Priority:** LOW | **Complexity:** LOW | **Backend:** None

Dialog to create N tracks at once with naming pattern.

**Implementation Plan:**
1. **Modal**: Input for count (1-100), track type dropdown, naming pattern (e.g., "Track %n")
2. **Store**: Loop `addTrack()` N times with generated names
3. **Insert menu**: "Insert Multiple Tracks..." item

#### Track Spacer
**Priority:** LOW | **Complexity:** LOW | **Backend:** None

Visual-only gap between tracks in the TCP for organization.

**Implementation Plan:**
1. **Store**: Add `spacers: Array<{ id: string; afterTrackId: string; height: number }>`
2. **Track header list**: Render spacer dividers between tracks where configured
3. **Context menu**: "Insert Spacer Below" option on track headers

---

## VI. Item (Clip) Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Item Properties (F2) | [x] | ClipPropertiesPanel — editable name, volume, fades, mute/lock, F2 toggle |
| Source Properties | [ ] | **NOT IMPLEMENTED** |
| Quantize (audio to grid) | [ ] | **NOT IMPLEMENTED** |
| Pitch/Playback Rate (time stretch) | [ ] | **NOT IMPLEMENTED** |
| Takes (Explode/Implode) | [ ] | **NOT IMPLEMENTED** |
| Grouping | [ ] | **NOT IMPLEMENTED** |
| Normalize | [ ] | **NOT IMPLEMENTED** |
| Reverse | [ ] | **NOT IMPLEMENTED** |
| Dynamic Split | [ ] | **NOT IMPLEMENTED** |
| Mute Clip | [x] | U key, per-clip mute with visual feedback (dimmed + stripes), skipped in playback |
| Lock Clip | [x] | Per-clip lock toggle, prevents drag/resize/delete, lock icon overlay |
| Clip Color | [x] | Per-clip color via context menu with 10 preset colors |

### Remaining Item Menu Features

#### ~~Clip Mute~~ — IMPLEMENTED

#### Clip Lock
**Priority:** LOW | **Complexity:** LOW | **Backend:** None

Lock individual clips to prevent accidental movement/editing.

**Implementation Plan:**
1. **Store**: Add `locked: boolean` to `AudioClip` interface (default: `false`)
   - Add `toggleClipLock(clipId)` action
2. **Timeline**: Show lock icon on locked clips, prevent drag/resize/fade operations
3. **Context menu**: "Lock Clip" toggle option

#### Clip Grouping
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** None

Bind multiple clips together so editing one affects all grouped clips.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `clipGroups: Map<string, string[]>` (groupId → clipIds)
   - Add `groupClips(clipIds)`, `ungroupClips(groupId)` actions
   - Add `groupId?: string` to `AudioClip` interface
2. **Timeline**: When moving/resizing a grouped clip, apply same transform to all clips in the group
3. **Visual**: Show matching colored border or group indicator on grouped clips
4. **Keyboard**: Ctrl+G to group selected clips, Ctrl+Shift+G to ungroup

#### Takes (Explode/Implode)
**Priority:** LOW | **Complexity:** HIGH | **Backend:** None

Stack multiple recording passes into a single clip container. Explode separates them to individual tracks.

**Implementation Plan:**
1. **Store**: Add `takes: AudioClip[]` to `AudioClip` interface (multi-take container)
   - Add `activeTakeIndex: number` (which take is active)
   - Add `explodeTakes(clipId)`, `implodeTakes(clipIds)` actions
2. **Recording**: When loop-recording, stack passes as takes instead of separate clips
3. **Timeline**: Show take indicator badge, click to cycle takes
4. **Explode**: Creates one track per take at the same time position
5. **Implode**: Merges aligned clips on different tracks into a single multi-take clip

#### Normalize Clip
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** HIGH

Analyze clip's peak/LUFS and adjust gain to hit target level.

**Implementation Plan:**
1. **Backend** (`AudioEngine.cpp`):
   - Add `analyzeClipLevel(filePath, offset, duration)` → `{peakDB: number, rmsDB: number, lufs: number}`
   - Add `normalizeClip(filePath, targetDB, mode: 'peak' | 'lufs')` → new file path or gain adjustment
2. **Frontend**: Context menu "Normalize..." → modal with target level and mode
3. **Simple approach**: Calculate required gain offset and apply to `clip.volume` instead of creating a new file

#### Reverse Clip
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** HIGH

Create a reversed copy of the audio file.

**Implementation Plan:**
1. **Backend** (`AudioEngine.cpp`):
   - Add `reverseAudioFile(filePath)` → returns path to reversed file
   - Read source file, write samples in reverse order to new file
2. **Frontend**: Context menu "Reverse" → calls backend, replaces clip's filePath with reversed file
3. Wrap in undoable command

#### Time Stretching / Pitch Shifting
**Priority:** LOW | **Complexity:** VERY HIGH | **Backend:** VERY HIGH

Algorithmic time-stretch or pitch-shift clips without affecting the other parameter.

**Implementation Plan:**
1. **Backend**: Integrate a time-stretch library (e.g., Rubber Band Library or SoundTouch)
   - Add `timeStretchClip(filePath, stretchFactor)` → new file
   - Add `pitchShiftClip(filePath, semitones)` → new file
2. **Store**: Add `playbackRate: number` and `pitchSemitones: number` to `AudioClip`
3. **PlaybackEngine**: Read samples at modified rate, use stretch algorithm
4. **UI**: Clip properties panel with rate/pitch controls
5. **Note**: This is one of the most complex features — consider deferring until core features are solid

---

## VII. Track Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Insert New Track | [x] | Ctrl+T |
| Insert Multiple Tracks | [x] | Prompt for count and type, Insert menu and Track context |
| Render/Freeze Tracks | [x] | Freeze/unfreeze state, snowflake indicator, context menu toggle |
| Track Layout | [~] | Track height adjustable (Alt+Scroll), no saved layouts |
| Track Color | [x] | Color picker in track header |
| Envelopes/Automation | [x] | Volume/pan automation lanes, add/move/remove points, toggle visibility |
| Fixed Item Lanes | [ ] | **NOT IMPLEMENTED** |
| Free Item Positioning | [ ] | **NOT IMPLEMENTED** |
| Track Group Manager (VCA) | [ ] | **NOT IMPLEMENTED** |
| Track Templates | [x] | Save/load track configurations, context menu, localStorage persistence |

### Remaining Track Menu Features

#### Freeze/Render Tracks
**Priority:** MEDIUM | **Complexity:** HIGH | **Backend:** HIGH

Render a track's audio + FX to a new WAV file, bypass plugins, drastically reduce CPU.

**Implementation Plan:**
1. **Backend** (`AudioEngine.cpp`):
   - Add `freezeTrack(trackId, startTime, endTime)` → `{success: bool, frozenFilePath: string}`
   - Uses same `fillTrackBuffer()` + FX processing as render, but for a single track
   - Writes result to temp file in project directory
   - Stores original FX state for unfreeze
   - Add `unfreezeTrack(trackId)` → restores FX and removes frozen file
2. **Store** (`useDAWStore.ts`):
   - Add `frozen: boolean` and `frozenFilePath?: string` to Track interface
   - Add `freezeTrack(trackId)`, `unfreezeTrack(trackId)` actions
   - When frozen: replace all clips with single frozen clip, bypass all FX
   - When unfrozen: restore original clips and FX
3. **UI**: "Freeze Track" / "Unfreeze Track" in track context menu and Track menu
4. **Visual**: Show snowflake icon on frozen tracks, clips show "FROZEN" label

#### Track Automation / Envelopes
**Priority:** HIGH | **Complexity:** VERY HIGH | **Backend:** HIGH

Record and play back parameter changes over time (volume, pan, plugin parameters).

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `AutomationLane` interface: `{ id: string; trackId: string; paramId: string; paramName: string; points: AutomationPoint[]; visible: boolean; armed: boolean }`
   - Add `AutomationPoint`: `{ time: number; value: number; curveType: 'linear' | 'bezier' | 'step' }`
   - Add `automationLanes: AutomationLane[]` to Track
   - Add `automationMode: 'read' | 'write' | 'touch' | 'latch' | 'trim'` per track
   - Actions: `addAutomationPoint()`, `removeAutomationPoint()`, `moveAutomationPoint()`, `setAutomationMode()`
2. **Timeline** (`Timeline.tsx`):
   - Render automation lanes below track (collapsible)
   - Draw automation curves (lines between points, colored by parameter)
   - Click to add points, drag to move, right-click to delete
   - Show/hide automation per-parameter
3. **Backend** (`TrackProcessor.cpp`):
   - In `processBlock()`, read automation values at current time
   - Interpolate between points for smooth parameter changes
   - Write mode: capture parameter changes as new points
4. **Automation Items**: Loopable containers of automation (advanced, defer)

#### Fixed Item Lanes (Comping)
**Priority:** MEDIUM | **Complexity:** HIGH | **Backend:** None

Display multiple overlapping recordings as stacked lanes within a single track for easy comping.

**Implementation Plan:**
1. **Store**: Add `laneMode: boolean` and `lanes: Lane[]` to Track
   - `Lane`: `{ id: string; clips: AudioClip[]; playState: 'active' | 'muted' }`
   - Add `enableLaneMode(trackId)`, `swipeComp(trackId, laneId, startTime, endTime)` actions
2. **Timeline**: When lane mode enabled, show stacked lanes within track height
   - Each lane is a sub-row
   - Click/swipe across lanes to select "active" regions
   - Active region clips play, others are muted
3. **Recording**: New loop passes create new lanes instead of new clips
4. **Visual**: Lane borders, active region highlighting, comp result preview

#### Track Group Manager (VCA-style)
**Priority:** LOW | **Complexity:** HIGH | **Backend:** MEDIUM

Group tracks so adjusting one fader proportionally adjusts all grouped tracks.

**Implementation Plan:**
1. **Store** (`useDAWStore.ts`):
   - Add `trackGroups: Array<{ id: string; name: string; leadTrackId: string; memberTrackIds: string[]; linkedParams: string[] }>`
   - Add `createTrackGroup()`, `addToGroup()`, `removeFromGroup()` actions
   - Linked params: volume, pan, mute, solo, record arm
2. **Logic**: When lead track's volume changes, calculate delta and apply to all members (preserving relative offsets)
3. **UI**: "Track Group Manager" dialog accessible from Track menu
4. **Visual**: Color-coded group indicators on track headers

---

## VIII. Options Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Record Modes (Normal/Overdub/Replace) | [x] | Normal/overdub/replace, Options menu submenu, TransportBar indicator |
| Auto-Crossfade | [x] | Toggle in MainToolbar and View menu, auto-applies on clip overlap |
| Ripple Editing | [x] | Off/per-track/all-tracks, Options menu submenu |
| Metronome Settings | [x] | MetronomeSettings component with accents/volume |
| Snap/Grid Settings | [x] | Full snap system with grid sizes |
| Lock Settings | [ ] | **NOT IMPLEMENTED** |
| Themes | [ ] | **NOT IMPLEMENTED** (single dark theme) |
| Theme Adjuster | [ ] | **NOT IMPLEMENTED** |
| Preferences | [x] | PreferencesModal with tabs: General, Editing, Display, Backup (Ctrl+,) |
| Move Envelope Points with Items | [ ] | **NOT IMPLEMENTED** (no automation yet) |
| Mouse Modifiers | [ ] | **NOT IMPLEMENTED** |

### Remaining Options Menu Features

#### Record Modes
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** MEDIUM

- **Normal**: Creates a new clip (current behavior)
- **Overdub (MIDI)**: Merge new MIDI notes with existing clip
- **Replace**: Overwrite existing audio/MIDI in the recorded region

**Implementation Plan:**
1. **Store**: Add `recordMode: 'normal' | 'overdub' | 'replace'` (default: `'normal'`)
2. **Recording logic**:
   - Normal: Current behavior (new clip created)
   - Overdub: For MIDI tracks, merge new events into existing MIDI clip at the recorded time range
   - Replace: Delete any existing clips/portions that overlap the recording range, then insert new recording
3. **UI**: Options menu "Record Mode" submenu with radio items
4. **TransportBar**: Small indicator showing current record mode

#### Preferences Dialog
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** LOW

Comprehensive settings beyond audio device configuration.

**Implementation Plan:**
1. Expand `SettingsModal.tsx` or create `PreferencesModal.tsx` with tabs:
   - **Audio**: Current device settings (already implemented)
   - **Project**: Default sample rate, bit depth, tempo, time signature for new projects
   - **Paths**: Default project directory, VST3 scan paths, FFmpeg location
   - **Editing**: Default crossfade length, ripple mode, snap behavior
   - **Appearance**: UI scale, color accent, track height defaults
   - **Keyboard**: Shortcut display/customization (read-only initially)
2. **Store**: Add `preferences: Preferences` object, persist to localStorage
3. **Options menu**: "Preferences... (Ctrl+P)" item

#### Theme System
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** None

Support multiple color themes beyond the current dark theme.

**Implementation Plan:**
1. **CSS**: Define theme variables in `index.css` using CSS custom properties (already partially done with `daw-*` tokens)
2. **Store**: Add `theme: 'dark' | 'light' | 'midnight' | 'custom'`
3. **ThemeAdjuster**: New component allowing customization of accent color, background intensity, text brightness
4. Apply theme by swapping CSS custom property values on `:root`

---

## IX. Actions Menu (Command Palette)

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Action List (4000+ commands) | [x] | Command Palette (Ctrl+Shift+P) + Action Registry with 100+ actions |
| Custom Actions (Macros) | [ ] | **NOT IMPLEMENTED** |
| ReaScript (EEL2/Lua/Python) | N/A | Not applicable — Studio13 has NativeBridge instead |
| Recent Actions | [ ] | **NOT IMPLEMENTED** |

### Remaining Actions Menu Features

#### Command Palette / Action List
**Priority:** MEDIUM | **Complexity:** MEDIUM | **Backend:** None

Searchable list of all available actions with their keyboard shortcuts.

**Implementation Plan:**
1. **New file** `store/actionRegistry.ts`:
   ```typescript
   interface ActionDef {
     id: string;
     name: string;
     category: string;
     shortcut?: string;
     execute: () => void;
   }
   ```
   - Register all existing actions (transport, editing, track, view, etc.)
2. **New component** `CommandPalette.tsx`:
   - Searchable modal (Ctrl+Shift+P or backtick key)
   - Filter by category (Transport, Edit, View, Track, Insert, etc.)
   - Shows shortcut next to each action
   - Recent actions section at top
   - Keyboard navigation (arrow keys + Enter to execute)
3. **Store**: Add `showCommandPalette: boolean`, `recentActions: string[]`
4. **Actions menu**: "Show Action List", "Show Recent Actions"

#### Custom Actions (Macros)
**Priority:** LOW | **Complexity:** HIGH | **Backend:** None

Combine multiple actions into a single macro.

**Implementation Plan:**
1. **Store**: Add `customActions: Array<{ id: string; name: string; steps: string[]; shortcut?: string }>`
2. **UI**: Macro editor — select actions from registry, order them, assign shortcut
3. **Execution**: Run steps sequentially via action registry

---

## X. Help Menu

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| User Guide | [ ] | **NOT IMPLEMENTED** |
| Keyboard Shortcuts Reference | [x] | KeyboardShortcutsModal — searchable, categorized, F1 shortcut |
| About Dialog | [x] | About Studio13 in Help menu with version, tech stack info |
| Changelog | [ ] | **NOT IMPLEMENTED** |
| Check for Updates | [ ] | **NOT IMPLEMENTED** |
| Diagnostics | [ ] | **NOT IMPLEMENTED** |

### Remaining Help Menu Features

#### About Dialog
**Priority:** LOW | **Complexity:** LOW | **Backend:** None

**Implementation Plan:**
1. **New component** `AboutModal.tsx`: App name, version, logo, credits, license info
2. **Help menu**: "About Studio13 (Ctrl+F1)"

#### Keyboard Shortcuts Reference
**Priority:** MEDIUM | **Complexity:** LOW | **Backend:** None

**Implementation Plan:**
1. **New component** `KeyboardShortcutsModal.tsx`:
   - Categorized table of all shortcuts (sourced from action registry)
   - Search/filter functionality
   - Print-friendly layout
2. **Help menu**: "Keyboard Shortcuts (Shift+F1)"

---

## XI. Render to File Modal

### Source Options

| REAPER Source | Studio13 Status | Notes |
|---|---|---|
| Master mix | [x] | Default render source |
| Stems (selected tracks) | [x] | Per-track rendering via stem:trackId source, frontend loops tracks |
| Master mix + stems | [x] | Renders master + each track as separate files |
| Selected media items | [ ] | **NOT IMPLEMENTED** |
| Selected media items via master | [ ] | **NOT IMPLEMENTED** |
| Region render matrix | [ ] | **NOT IMPLEMENTED** |
| Region render matrix via master | [ ] | **NOT IMPLEMENTED** |
| Razor edit areas | [ ] | **NOT IMPLEMENTED** |

### Bounds Options

| REAPER Bounds | Studio13 Status | Notes |
|---|---|---|
| Entire project | [x] | Uses project range or clip extent |
| Custom time range | [x] | Manual start/end entry |
| Time selection | [x] | Uses timeSelection from store |
| Project regions | [ ] | **NOT IMPLEMENTED** |
| Selected regions | [ ] | **NOT IMPLEMENTED** |

### Output Configuration

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Output directory | [x] | Browse button |
| Filename | [x] | Editable text input |
| Dynamic wildcards ($project, $track, $region, $date) | [x] | $project, $track, $date, $time, $index with live preview |
| Secondary output format | [ ] | **NOT IMPLEMENTED** |

### Audio Parameters

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Sample rate | [x] | Renders at device rate, then FFmpeg converts to target sample rate |
| Channels (Stereo/Mono) | [x] | Working — mono downmix supported |
| Multichannel (up to 128ch) | [ ] | **NOT IMPLEMENTED** |
| Resample mode quality | [ ] | **NOT IMPLEMENTED** |

### Output Formats

| Format | Studio13 Status | Notes |
|---|---|---|
| WAV | [x] | 16/24/32-bit |
| AIFF | [x] | Working |
| FLAC | [x] | Working |
| MP3 | [x] | Render to WAV then FFmpeg encode (128/192/256/320 kbps) |
| OGG Vorbis | [x] | Render to WAV then FFmpeg encode (quality 1-10) |
| RAW PCM | [ ] | **NOT IMPLEMENTED** |
| DDP | [ ] | **NOT IMPLEMENTED** |
| Video (FFmpeg) | [ ] | **NOT IMPLEMENTED** |

### Metadata & Post-Processing

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Normalize | [x] | 2-pass normalize to prevent clipping |
| Add tail (reverb) | [x] | Configurable tail length in ms |
| Dither/Noise Shaping | [ ] | **NOT IMPLEMENTED** (UI checkbox exists, backend ignores) |
| Embed metadata (BWF/ID3/ISRC) | [ ] | **NOT IMPLEMENTED** |
| Offline render (full speed) | [x] | Default mode — uses all CPU |
| Online render (1x speed) | [ ] | **NOT IMPLEMENTED** |
| Add rendered items to project | [ ] | **NOT IMPLEMENTED** |
| True Peak Limiting | [ ] | **NOT IMPLEMENTED** |
| LUFS Normalization | [ ] | **NOT IMPLEMENTED** |

### Remaining Render Features

#### ~~Stems Export (Selected Tracks)~~ — IMPLEMENTED

Backend supports `stem:TRACK_ID` source parameter to render a single track (skips master FX/volume/pan). Frontend loops through tracks, calling renderProject per track with wildcard filename resolution. Progress shows "Rendering stem N of M: TrackName...".

#### ~~Dynamic Wildcard Filenames~~ — IMPLEMENTED

`resolveWildcards()` function in RenderModal supports `$project`, `$track`, `$date`, `$time`, `$index`. Live preview shown below filename input. Wildcard reference tooltip displayed.

#### ~~Sample Rate Conversion on Export~~ — IMPLEMENTED

Backend renders at device rate, then FFmpeg post-processes with `-ar` flag for sample rate conversion. Supports all standard rates (44.1k, 48k, 88.2k, 96k, 192k). Combined with lossy encoding in a single FFmpeg call when applicable.

#### ~~MP3/OGG Encoding~~ — IMPLEMENTED

Backend renders to temp WAV, then FFmpeg converts (MP3 via libmp3lame, OGG via libvorbis). Temp WAV deleted after conversion. FFmpeg found via `findFFmpegExe()` searching relative to executable. Frontend provides bitrate selector for MP3 (128-320 kbps) and quality selector for OGG (1-10).

#### Metadata Embedding
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** MEDIUM

Embed BWF, ID3, or iXML metadata into rendered files.

**Implementation Plan:**
1. **Backend**: Use JUCE's `WavAudioFormat` metadata writing (supports BWF chunks)
   - For WAV: Write BWF description, originator, origination date, time reference
   - For MP3: Write ID3v2 tags (title, artist, album, etc.)
2. **UI**: "Metadata..." button in RenderModal opening a tag editor
3. **Store**: Add `renderMetadata: { title, artist, album, description, isrc }` to render options

#### Region Render Matrix
**Priority:** LOW | **Complexity:** HIGH | **Backend:** HIGH

2D matrix mapping tracks to regions. Each intersection produces a separate file.

**Implementation Plan:**
1. **New component** `RegionRenderMatrix.tsx`:
   - Grid: rows = tracks, columns = regions
   - Check/uncheck intersections
   - Preview filename for each intersection (using wildcards)
2. **Backend**: Loop through checked intersections, render each as separate file (solo track + set bounds to region)
3. **UI**: Accessible from RenderModal when source = "Region render matrix"

---

## XII. Advanced / REAPER-Parity Features

These are advanced features from REAPER that Studio13 will implement in later phases.

| REAPER Feature | Studio13 Status | Notes |
|---|---|---|
| Multi-tab project (parallel sessions) | [ ] | **NOT IMPLEMENTED** — requires MDI architecture |
| 32-bit plugin bridging/firewalling | [ ] | **NOT IMPLEMENTED** — currently only 64-bit VST3 |
| SMPTE timecode generator/reader | [~] | SMPTE display in TransportBar (24/25/29.97/30fps), no LTC generation |
| Video playback window | [ ] | **NOT IMPLEMENTED** — needs FFmpeg video decoding |
| Custom toolbar creation | [ ] | **NOT IMPLEMENTED** — configurable toolbar editor |
| Mouse modifier customization matrix | [ ] | **NOT IMPLEMENTED** — per-context mouse modifier mapping |
| Scripting API / Extension system | [ ] | **NOT IMPLEMENTED** — Lua/JS scripting for user-created actions |
| DDP disc image export | [ ] | **NOT IMPLEMENTED** — CD mastering export format |
| Multichannel (128ch) rendering | [ ] | **NOT IMPLEMENTED** — surround/Ambisonics/Atmos |
| Free item positioning (items not locked to tracks) | [ ] | **NOT IMPLEMENTED** — items can float freely on timeline |

### Remaining Section XII Features

#### Multi-tab Project (MDI)
**Priority:** MEDIUM | **Complexity:** VERY HIGH | **Backend:** HIGH

Open multiple projects simultaneously in tabs, each with independent transport/state.

**Implementation Plan:**
1. **Architecture**: Wrap current App state in a `ProjectTab` context. Array of project states in a root store.
2. **Backend**: Support multiple AudioEngine instances or serialize/restore engine state per tab.
3. **UI**: Tab bar above MenuBar. Each tab holds its own track list, timeline, transport state.
4. **State**: `projectTabs: ProjectTab[]`, `activeTabIndex: number`. Each tab has full `DAWState`.

#### 32-bit Plugin Bridging
**Priority:** LOW | **Complexity:** HIGH | **Backend:** HIGH

Host 32-bit VST plugins in a separate process to prevent crashes and enable compatibility.

**Implementation Plan:**
1. **Backend**: Create a bridge process (32-bit .exe) that loads 32-bit plugins.
2. **IPC**: Shared memory or pipes for audio buffer exchange between 64-bit host and 32-bit bridge.
3. **PluginManager**: Detect 32-bit plugins during scan, route them to bridge process.

#### SMPTE Timecode
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** MEDIUM

Generate/read SMPTE timecode for video sync and post-production workflows.

**Implementation Plan:**
1. **Backend**: Implement SMPTE frame rate modes (24, 25, 29.97df, 30 fps).
2. **Store**: Add `timecodeMode` setting, `timecodeOffset` for start-of-day offset.
3. **UI**: Timecode display option in TransportBar (alongside bars:beats and seconds).

#### Video Playback Window
**Priority:** MEDIUM | **Complexity:** HIGH | **Backend:** HIGH

Display video synchronized to the timeline for scoring and post-production.

**Implementation Plan:**
1. **Backend**: Use FFmpeg to decode video frames at current transport position.
2. **Frontend**: Floating video window component rendering frames via canvas/WebGL.
3. **Sync**: Backend sends video frame data on transport position change.
4. **Formats**: MP4, MOV, AVI via FFmpeg (already bundled in tools/).

#### Custom Toolbar Creation
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** None

Allow users to create and configure custom toolbars with selectable actions.

**Implementation Plan:**
1. **Store**: `customToolbars: Array<{ id, name, buttons: Array<{ actionId, icon, label }> }>`.
2. **UI**: Toolbar editor modal — drag actions from action registry onto toolbar slots.
3. **Rendering**: Dynamic toolbar component that reads button definitions and renders icons.
4. **Persistence**: Save toolbar configs in project settings or user preferences.

#### Mouse Modifier Customization
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** None

Configure what happens on click/drag in different contexts based on modifier keys.

**Implementation Plan:**
1. **Store**: `mouseModifiers: Map<context, Map<modifierCombo, action>>` — e.g., `{ "clip_drag": { "ctrl": "copy", "alt": "move_vertical" } }`.
2. **UI**: Matrix editor in Preferences — rows = contexts (clip, track, timeline, envelope), columns = modifier combos.
3. **Timeline**: Replace hardcoded modifier checks with lookups into mouseModifiers map.

#### Scripting API / Extension System
**Priority:** MEDIUM | **Complexity:** VERY HIGH | **Backend:** HIGH

Enable user-written scripts (Lua or JS) to automate actions, create custom tools, and extend functionality.

**Implementation Plan:**
1. **Backend**: Embed a Lua or QuickJS interpreter. Expose action registry, store state, and bridge functions.
2. **API surface**: `reaper.GetTrack()`, `reaper.InsertMedia()`, etc. — mimic ReaScript API where sensible.
3. **Frontend**: Script editor panel with syntax highlighting, run/stop buttons, console output.
4. **Security**: Sandbox scripts, limit filesystem access, provide opt-in permissions.

#### DDP Disc Image Export
**Priority:** LOW | **Complexity:** MEDIUM | **Backend:** HIGH

Export CD-ready DDP disc images with track markers and PQ codes.

**Implementation Plan:**
1. **Backend**: Generate DDP file set (DDPID, DDPMS, image.dat) from rendered audio + region markers.
2. **Frontend**: DDP export option in Render modal when source = "Region render matrix".
3. **Markers**: Use regions as CD track boundaries, validate Red Book compliance (min 4s gap, 99 tracks max).

#### Multichannel Rendering
**Priority:** LOW | **Complexity:** HIGH | **Backend:** HIGH

Support surround sound and immersive audio formats (5.1, 7.1, Ambisonics, Atmos).

**Implementation Plan:**
1. **Backend**: Extend AudioEngine to support >2 channel output. Track channel count per track.
2. **Render**: Multi-channel WAV writing (JUCE supports up to 256 channels in WAV).
3. **UI**: Channel configuration per track (mono/stereo/5.1/7.1/ambi), surround panner widget.
4. **Mixer**: Multi-channel meters and pan controls.

#### Free Item Positioning
**Priority:** LOW | **Complexity:** HIGH | **Backend:** None

Allow clips/items to float freely on the timeline without being locked to a specific track lane.

**Implementation Plan:**
1. **Store**: Add `freePosition: { y: number }` to AudioClip — pixel offset within timeline.
2. **Timeline**: When free positioning enabled, clips render at their Y offset instead of track lane.
3. **Drag**: Clips can be dragged vertically anywhere, not just between track boundaries.
4. **Rendering**: Routing still based on track assignment, but visual position is independent.

---

## XIII. Summary: What's Implemented vs. What's Remaining

### Implementation Statistics

| Category | Implemented | Remaining | Percentage |
|---|---|---|---|
| **Top Toolbar** | 10/10 | 0 | 100% |
| **File Menu** | 11/18 | 7 | 61% |
| **Edit Menu** | 21/21 | 0 | 100% |
| **View Menu** | 8/14 | 6 | 57% |
| **Insert Menu** | 11/13 | 2 | 85% |
| **Item/Clip Menu** | 5/12 | 7 | 42% |
| **Track Menu** | 7/10 | 3 | 70% |
| **Options Menu** | 7/11 | 4 | 64% |
| **Actions Menu** | 2/4 | 2 | 50% |
| **Help Menu** | 5/6 | 1 | 83% |
| **Render Source** | 3/8 | 5 | 38% |
| **Render Bounds** | 3/5 | 2 | 60% |
| **Render Formats** | 5/8 | 3 | 63% |
| **Render Metadata/Post** | 3/10 | 7 | 30% |
| **Advanced / REAPER-Parity** | 1/10 | 9 | 10% |
| **TOTAL** | **108/160** | **52** | **68%** |

### Priority Breakdown of Remaining Features

#### HIGH Priority (Core DAW Functionality)
1. ~~Split at Cursor (S key)~~ **DONE**
2. ~~Clip Mute~~ **DONE**
3. ~~Track Automation / Envelopes~~ **DONE**
4. ~~Stems Export (selected tracks render)~~ **DONE**
5. ~~Virtual Instrument on New Track~~ **DONE**
6. ~~Ripple Editing~~ **DONE**

#### MEDIUM Priority (Workflow Enhancement)
1. ~~Split at Time Selection~~ **DONE**
2. ~~Razor Editing~~ **DONE**
3. ~~Record Modes (Normal/Overdub/Replace)~~ **DONE**
4. ~~Render Sample Rate Conversion~~ **DONE**
5. ~~MP3/OGG Encoding~~ **DONE**
6. ~~Region/Marker Manager~~ **DONE**
7. ~~Freeze/Render Tracks~~ **DONE**
8. ~~Dynamic Wildcard Filenames~~ **DONE**
9. ~~Clip Grouping~~ **DONE**
10. ~~Time Signature/Tempo Change Markers~~ **DONE**
11. ~~Preferences Dialog~~ **DONE**
12. ~~Command Palette / Action List~~ **DONE**
13. ~~Master Track in TCP~~ **DONE**
14. ~~Normalize Clip~~ **DONE**
15. Reverse Clip
16. ~~Undo History Panel (wire to View menu)~~ **DONE**
17. ~~Keyboard Shortcuts Reference~~ **DONE**
18. ~~Timestamped Backup (.s13-bak)~~ **DONE**
19. ~~Item/Clip Properties Inspector~~ **DONE**

#### LOW Priority (Advanced / Nice-to-Have)
1. ~~Auto-Crossfade~~ **DONE**
2. ~~Locking System~~ **DONE**
3. Crossfade Editor
4. Dynamic Split (Transient Detection)
5. ~~Nudge Items~~ **DONE**
6. ~~Close Project~~ **DONE**
7. Clean Project Directory
8. Render Queue
9. Recovery Mode
10. ~~Fixed Item Lanes (Comping)~~ **DONE**
11. Track Group Manager (VCA)
12. ~~Track Templates~~ **DONE**
13. Media Explorer
14. ~~Big Clock~~ **DONE**
15. Theme System
16. Custom Actions (Macros)
17. Takes (Explode/Implode)
18. Time Stretching / Pitch Shifting
19. ~~About Dialog~~ **DONE**
20. Metadata Embedding
21. Region Render Matrix
22. ~~Insert Multiple Tracks~~ **DONE**
23. Track Spacer
24. Export Project MIDI
25. Secondary Output Format
26. ~~Select All Clips~~ **DONE**
27. ~~Cut/Copy within Time Selection~~ **DONE**
28. ~~Per-clip Color~~ **DONE**
29. Multi-tab Project (MDI)
30. 32-bit Plugin Bridging
31. ~~SMPTE Timecode~~ **DONE** (display only)
32. Video Playback Window
33. Custom Toolbar Creation
34. Mouse Modifier Customization
35. Scripting API / Extension System
36. DDP Disc Image Export
37. Multichannel Rendering
38. Free Item Positioning

---

## XIV. Recommended Implementation Order

### Phase 1: Essential Editing (HIGH priority) — COMPLETE
1. ~~**Split at Cursor**~~ — **DONE** (S key, undo/redo, context menu)
2. ~~**Clip Mute**~~ — **DONE** (U key, visual feedback, skipped in playback)
3. ~~**Undo History Panel**~~ — **DONE** (Ctrl+Alt+Z, View menu, floating panel)
4. ~~**Select All Clips**~~ — **DONE** (Ctrl+Shift+A)
5. ~~**Nudge Items**~~ — **DONE** (Arrow keys, Ctrl+Arrow for fine)
6. ~~**Close Project**~~ — **DONE** (Ctrl+F4, save prompt)

### Phase 2: Render Completion — COMPLETE
4. ~~**MP3/OGG Encoding**~~ — **DONE** (FFmpeg encode, bitrate/quality selectors)
5. ~~**Stems Export**~~ — **DONE** (per-track rendering via stem:trackId, master+stems mode)
6. ~~**Sample Rate Conversion**~~ — **DONE** (FFmpeg resampling post-render)
7. ~~**Dynamic Wildcard Filenames**~~ — **DONE** ($project, $track, $date, $time, $index with live preview)

### Phase 3: Workflow Features — COMPLETE
8. ~~**Ripple Editing**~~ — **DONE** (off/per-track/all-tracks modes, shifts downstream clips on delete)
9. ~~**Record Modes**~~ — **DONE** (normal/overdub/replace with overlap removal in replace mode)
10. ~~**Virtual Instrument on New Track**~~ — **DONE** (Insert menu item, creates instrument track + opens plugin browser)
11. ~~**Command Palette**~~ — **DONE** (Ctrl+Shift+P, searchable action list grouped by category)

### Phase 4: Advanced Editing — COMPLETE
12. ~~**Razor Editing**~~ — **DONE** (Alt+drag creates per-track razor area, Delete removes content, red highlight)
13. ~~**Split at Time Selection**~~ — **DONE** (splits all clips at both edges of time selection)
14. ~~**Clip Grouping**~~ — **DONE** (Ctrl+G to group, Ctrl+Shift+G to ungroup, grouped clips select together)
15. ~~**Normalize Selected Clips**~~ — **DONE** (resets clip volume to 0 dB; Edit menu action)

### Phase 5: Automation & Mixing — COMPLETE
16. ~~**Track Automation**~~ — **DONE** (volume/pan lanes, add/move/remove points, line rendering, double-click to add, drag to move)
17. ~~**Freeze Tracks**~~ — **DONE** (freeze/unfreeze state, visual indicator in TrackHeader, context menu toggle)
18. ~~**Master Track in TCP**~~ — **DONE** (virtual master track in MixerPanel with automation support)
19. ~~**Region/Marker Manager**~~ — **DONE** (floating panel, click to navigate, rename/delete, View menu toggle)

### Phase 6: Polish & Advanced — COMPLETE
20. ~~**Tempo Map / Tempo Markers**~~ — **DONE** (add/remove/update tempo markers, getTempoAtTime for variable tempo)
21. ~~**Comping / Lanes**~~ — **DONE** (take lanes per track, promote/swap/delete takes, active take index)
22. ~~**Help Menu — Keyboard Shortcuts**~~ — **DONE** (F1 shows shortcuts dialog, About Studio13 info)
23. ~~**Help Menu — About & Command Palette**~~ — **DONE** (about dialog, Ctrl+Shift+P from Help menu)
24. **Remaining render features** — partial (metadata, region matrix still pending)

### Phase 7: Frontend Polish & Completions — COMPLETE

1. ~~**Auto-Crossfade**~~ — **DONE** (toggle in toolbar, auto-applies fadeIn/fadeOut on overlap)
2. ~~**Clip Lock & Per-clip Color**~~ — **DONE** (lock prevents edits, color via context menu)
3. ~~**Clip Properties Inspector (F2)**~~ — **DONE** (floating panel with editable properties)
4. ~~**Insert Multiple Tracks & Empty MIDI Item**~~ — **DONE** (Insert menu items)
5. ~~**Big Clock**~~ — **DONE** (floating time display with format toggle)
6. ~~**Cut/Copy within Time Selection**~~ — **DONE** (Edit menu actions)
7. ~~**Timestamped Backup & Track Templates**~~ — **DONE** (auto-backup timer, save/load templates)
8. ~~**Save New Version**~~ — **DONE** (increments version suffix in filename)
9. ~~**Keyboard Shortcuts Modal (F1)**~~ — **DONE** (searchable categorized modal from action registry)
10. ~~**SMPTE Timecode Display**~~ — **DONE** (TransportBar cycles time/beats/SMPTE)
11. ~~**Preferences Dialog (Ctrl+,)**~~ — **DONE** (tabbed modal: General, Editing, Display, Backup)

### Phase 8: Platform & Extensibility

1. **Multi-tab Project (MDI)** — parallel sessions in tabs
2. **Scripting API / Extension System** — Lua/JS automation and user-created actions
3. **Video Playback Window** — FFmpeg video decoding synced to transport
4. **Custom Toolbar Creation** — configurable toolbar editor
5. **Mouse Modifier Customization** — per-context modifier key mapping

### Phase 9: Pro Audio & Compatibility

1. **Multichannel Rendering** — surround/Ambisonics/Atmos (5.1, 7.1, 128ch)
2. **32-bit Plugin Bridging** — out-of-process bridge for legacy plugins
3. **Free Item Positioning** — clips float freely on timeline
4. **DDP Disc Image Export** — CD mastering format
