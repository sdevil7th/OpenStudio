# Studio13-v3 Implementation Plan

> **Goal**: Close the gap between Studio13-v3 and professional DAWs like Ardour/REAPER by implementing missing features end-to-end (C++ backend + bridge + React frontend).

---

## Remaining Work — Honest Audit (March 2026)

Everything below was audited against the actual codebase. Features are categorized by what's actually missing.

### Category A: Broken — Code Exists Both Sides But Not Connected

| # | Feature | Problem | Fix Effort |
|---|---------|---------|------------|
| 8 | Clip Gain Envelope | Backend interpolation works. Frontend state+undo works. But `syncClipsWithBackend()` never sends `gainEnvelope` to backend. Also no UI to draw envelope points on clips. | Medium |
| 13 | Trigger Engine (Clip Launcher) | Backend `TriggerEngine::processBlock()` runs in audio callback. Frontend store has full state. But NO bridge functions sync slot data from frontend to backend. Clips never actually launch. | Medium |

### Category B: Backend Done, No Frontend UI

| # | Feature | What Exists | What's Missing |
|---|---------|-------------|----------------|
| 4 | Channel Strip EQ | S13EQ class (HPF+LPF+4 bands), processes before FX chain in TrackProcessor | No UI controls — no enable toggle, no frequency/gain/Q knobs |
| 5 | Sidechain Routing | Topological sort, sidechain buffer routing, TrackProcessor expands channels | No UI to select sidechain source per plugin |
| 6 | Pan Law Options | All 4 algorithms (Constant Power, -4.5dB, -6dB, Linear) in TrackProcessor | No dropdown UI in Project Settings |
| 7 | DC Offset Removal | 5Hz high-pass filter in TrackProcessor | No toggle UI per track |
| 10 | Monitoring FX Chain | Post-master chain, correctly excluded from renders | No UI to add/manage monitoring FX |
| 12 | Timecode Sync | Full MIDI Clock + MTC send/receive in TimecodeSync.h/cpp | No settings panel for sync source/MIDI device/framerate |

### Category C: Not Implemented At All

| # | Feature | Notes |
|---|---------|-------|
| 29 | Crosshair Cursor | Only exists in ParametricGraph (EQ editing), NOT as timeline toggle |
| 30 | Accessibility | No ARIA labels, no focus indicators, no systematic keyboard navigation |
| — | Missing Media Resolver | No detection of missing audio files on project load, no relink dialog |
| — | Tab-to-Transient Navigation | No Tab/Shift+Tab handler for jumping between transients |
| — | Contextual Help (F1) | helpTexts.ts exists but no F1 key handler or hover help system |
| — | In-App Getting Started Guide | No tutorial/onboarding component |
| — | User Manual / API Docs | No manual or doc generation |
| — | Plugin Crash Isolation | Only blacklist exists, no separate-process sandboxing |
| — | 32-bit Plugin Bridge | Not implemented |

### Category D: Uncertain / Incomplete

| Feature | Status |
|---------|--------|
| Lagrange Resampling in Render | Referenced in code comments but implementation not fully visible |
| Note Expression / MPE | Infrastructure exists (setNoteExpression action, pitchBend/pressure/slide) but Piano Roll UI for MPE editing may be incomplete |

---

## Detailed Plans for Remaining Work

### Plan R1: Fix Clip Gain Envelope (Feature #8)

**Priority**: High — backend code is wasted without the sync

**Step 1: Add gainEnvelope to syncClipsWithBackend()**
- File: `frontend/src/store/useDAWStore.ts`
- In `syncClipsWithBackend()` (~line 4278-4350), after syncing basic clip properties, add:
  ```typescript
  // After addPlaybackClip calls, sync gain envelopes
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.gainEnvelope && clip.gainEnvelope.length > 0) {
        await nativeBridge.setClipGainEnvelope(track.id, clip.id, clip.gainEnvelope);
      }
    }
  }
  ```
- Also add gainEnvelope to the clip key hash so changes trigger re-sync

**Step 2: Add clip gain drawing UI**
- File: `frontend/src/components/Timeline.tsx`
- When a clip is selected and Shift is held, show gain envelope overlay:
  - Render gain points as small circles on the clip
  - Click to add point, drag to move, right-click to delete
  - Points are relative to clip start, value 0.0-2.0 (0 = silence, 1.0 = unity, 2.0 = +6dB)
- Wire to existing `addClipGainPoint()`, `moveClipGainPoint()`, `removeClipGainPoint()` in store

**Undo**: Already implemented in store (addClipGainPoint etc. use commandManager)

---

### Plan R2: Fix Trigger Engine Bridge (Feature #13)

**Priority**: High — complete audio engine wasted without bridge

**Step 1: Add bridge functions in MainComponent.cpp**
- Register native functions:
  - `setTriggerSlot(trackIndex, slotIndex, filePath, duration, offset, mode)` → calls `triggerEngine.setSlotClip()`
  - `triggerSlot(trackIndex, slotIndex)` → calls `triggerEngine.triggerSlot()`
  - `stopSlot(trackIndex, slotIndex)` → calls `triggerEngine.stopSlot()`
  - `triggerScene(sceneIndex)` → calls `triggerEngine.triggerScene()`
  - `stopAllSlots()` → calls `triggerEngine.stopAll()`
  - `setTriggerQuantize(mode)` → calls `triggerEngine.setQuantizeMode()`
  - `getTriggerGridState()` → calls `triggerEngine.getGridState()`

**Step 2: Add NativeBridge.ts wrappers**
- Add corresponding functions with mock fallbacks

**Step 3: Wire frontend store to bridge**
- In `triggerClipLauncherSlot()`, `stopClipLauncherSlot()`, etc. — add `nativeBridge.triggerSlot()` calls
- On play, sync all slot assignments to backend via `setTriggerSlot()` for each populated slot

**Step 4: Add Clip Launcher UI**
- New component `ClipLauncherView.tsx` — grid of slots, each with play/stop/record buttons
- Toggle between Arrangement view and Session view
- Scene launch row at bottom

---

### Plan R3: Channel Strip EQ UI (Feature #4)

**Priority**: Medium — enhances mixing workflow

**Where**: `frontend/src/components/ChannelStrip.tsx`

**Implementation**:
- Add collapsible "EQ" section in ChannelStrip (below existing Gain Staging section)
- Enable/disable toggle → calls `nativeBridge.setChannelStripEQEnabled(trackId, bool)`
- Per-band controls (HPF, LPF, 4 parametric):
  - Frequency knob/slider
  - Gain knob/slider (parametric bands only)
  - Q knob/slider (parametric bands only)
  - Enable toggle per band
- Wire each control to `nativeBridge.setChannelStripEQParam(trackId, bandIndex, paramName, value)`
- Optional: Reuse ParametricGraph component for visual EQ curve

**Bridge functions needed**: Already exposed (`setChannelStripEQEnabled`, `setChannelStripEQParam`)

---

### Plan R4: Sidechain Routing UI (Feature #5)

**Priority**: Medium — essential for sidechain compression workflows

**Where**: `frontend/src/components/FXChainPanel.tsx`

**Implementation**:
- Per plugin slot, add a "Sidechain" dropdown (only for plugins that support sidechain input)
- Dropdown lists all other tracks as potential sidechain sources
- On select → `nativeBridge.setSidechainSource(trackId, fxIndex, sourceTrackId)`
- "None" option → `nativeBridge.clearSidechainSource(trackId, fxIndex)`
- Visual indicator when sidechain is active (small icon/badge on plugin slot)

**Bridge functions needed**: Already exposed (`setSidechainSource`, `clearSidechainSource`, `getSidechainSource`)

---

### Plan R5: Pan Law Options UI (Feature #6)

**Priority**: Low — rarely changed, but easy to add

**Where**: `frontend/src/components/ProjectSettingsModal.tsx`

**Implementation**:
- Add "Pan Law" dropdown in project settings, options:
  - Constant Power (-3dB) — default
  - -4.5dB
  - -6dB (Linear)
  - 0dB (Unity)
- On change → `nativeBridge.setPanLaw(value)`
- Store current pan law in project state for save/load

**Bridge functions needed**: Already exposed (`setPanLaw`)

---

### Plan R6: DC Offset Removal UI (Feature #7)

**Priority**: Low — niche feature, easy to add

**Where**: `frontend/src/components/ChannelStrip.tsx` or track context menu

**Implementation**:
- Add "DC Offset" toggle per track (small checkbox or button)
- On toggle → `nativeBridge.setTrackDCOffset(trackId, enabled)`
- Visual indicator when active

**Bridge functions needed**: Already exposed (`setTrackDCOffset`)

---

### Plan R7: Monitoring FX Chain UI (Feature #10)

**Priority**: Medium — important for recording musicians

**Where**: New section in `MixerPanel.tsx` or dedicated panel

**Implementation**:
- Add "Monitor FX" section after Master channel strip
- Add/remove plugins → `nativeBridge.addMonitoringFX(pluginId)`, `removeMonitoringFX(index)`
- Bypass toggle → `nativeBridge.bypassMonitoringFX(index, bypassed)`
- Open plugin editor → `nativeBridge.openMonitoringFXEditor(index)`
- Clear visual label: "Monitor Only — not included in renders"

**Bridge functions needed**: Already exposed

---

### Plan R8: Timecode Sync Settings UI (Feature #12)

**Priority**: Low — needed for professional studio integration

**Where**: New component `TimecodeSettingsPanel.tsx` or tab in SettingsModal

**Implementation**:
- Sync Source dropdown: Internal / MIDI Clock / MTC
- MIDI Output Device selector (for clock/MTC send)
- MIDI Input Device selector (for external sync)
- SMPTE Frame Rate: 24 / 25 / 29.97df / 30
- Sync status indicator (locked/unlocked/seeking)
- Wire to TimecodeSyncManager via bridge calls:
  - `setSyncSource(mode)`
  - `setTimecodeFrameRate(fps)`
  - `setTimecodeMIDIDevice(deviceId, isInput)`

**Bridge functions needed**: Need to be added to MainComponent.cpp for TimecodeSyncManager

---

### Plan R9: Crosshair Cursor (Feature #29)

**Priority**: Low — visual aid

**Where**: `frontend/src/components/Timeline.tsx`

**Implementation**:
- Add `showCrosshair: boolean` to store, toggle via View menu
- On mouse move over timeline stage, render:
  - Vertical line from top to bottom at mouse X
  - Horizontal line across full width at mouse Y
  - Semi-transparent, dashed style
- Use a dedicated Konva Layer (non-listening) for performance
- Hide during drag operations

---

### Plan R10: Accessibility (Feature #30)

**Priority**: Medium-High — important for inclusivity, significant effort

**Implementation** (phased):

**Phase A: ARIA labels + focus indicators**
- Add `aria-label` to all buttons, inputs, sliders across all components
- Add `tabIndex` to interactive elements
- Add visible focus rings (already in Tailwind: `focus:ring-2 focus:ring-daw-accent`)
- Ensure all tooltips include shortcut hints

**Phase B: Keyboard navigation**
- Track list: Arrow up/down to select tracks, Enter to expand
- Timeline: Arrow keys to move selection, Shift+Arrow to extend
- Mixer: Tab between channel strips, arrow keys for faders
- All modals: Tab trap, Escape to close

**Phase C: Screen reader optimization**
- Announce state changes (recording started, track armed, etc.)
- Live regions for transport status, meter readings
- Landmark roles for main areas (timeline, mixer, transport)

---

### Plan R11: Missing Media Resolver

**Priority**: Medium — prevents broken projects

**Where**: `frontend/src/store/useDAWStore.ts` (in project load) + new dialog component

**Implementation**:
- On project load, after parsing clips, check if each audio file exists via `nativeBridge.fileExists(path)`
- If any files are missing, show `MissingMediaDialog.tsx`:
  - List of missing files with original paths
  - "Locate" button per file → opens file picker
  - "Locate Folder" → search a directory for matching filenames
  - "Skip" → keep clip but mark as offline (dimmed in timeline)
- Update clip paths after relinking

---

### Plan R12: Tab-to-Transient Navigation

**Priority**: Low — workflow enhancement

**Where**: `frontend/src/components/App.tsx` (keyboard handler) + `Timeline.tsx`

**Implementation**:
- Tab key: Jump playhead to next transient in selected clip
- Shift+Tab: Jump to previous transient
- Requires transient detection: call `nativeBridge.detectTransients(filePath, sensitivity)` (may need C++ implementation if not already present)
- Cache transient positions per clip
- Move playhead to nearest transient after current position

---

## Completed Features Reference

<details>
<summary>Phase 1: Wire Frontend to Backend (ALL COMPLETED)</summary>

- 1.1 Automation Playback — Per-sample volume/pan automation in TrackProcessor, frontend sync, touch/latch modes
- 1.2 Tempo Map — Binary search tempo lookup, metronome integration, tempo markers
- 1.3 Comping / Takes — Frontend take management synced to backend via clip swap
- 1.4 Razor Editing — Backend clip sync after razor content deletion
- 1.5 Track Groups — Linked parameter changes propagated to backend per-track
</details>

<details>
<summary>Phase 2: Complete Stubs (ALL COMPLETED)</summary>

- 2.1 MIDI Recording — MIDIRecorder captures events during recording, saves to .mid
- 2.2 Time Stretching — RubberBand/FFmpeg integration for offline stretch
- 2.3 Pitch Shifting — Same engine as time stretching
- 2.4 Sample Rate Conversion on Render — Device rate conversion in render path
- 2.5 Dither — TPDF and noise-shaped dither on 16/24-bit export
- 2.6 Monitoring FX Chain — Backend complete (see Plan R7 for missing UI)
</details>

<details>
<summary>Phase 3: New Features (ALL COMPLETED except UI gaps)</summary>

- 3.1 Punch In/Out Recording — Punch range in audio callback
- 3.2 Loop Recording — Multi-take per loop pass
- 3.3 Record-Safe Mode — Per-track lock on arming
- 3.4 LV2 Plugin Support — JUCE built-in + configured search paths
- 3.5 CLAP Plugin Support — CLAPPluginFormat class
- 3.6 Audio Units — Deferred (macOS only)
- 3.7 Surround / Spatial Audio — VBAP panner, speaker layouts
- 3.8 Video Integration — VideoReader + FFmpeg + VideoWindow UI
- 3.9 Timecode / Sync — Backend complete (see Plan R8 for missing UI)
- 3.10 Control Surfaces — Generic MIDI, MCU, OSC implementations
- 3.11 Scripting Engine — Lua s13.* API expanded
- 3.12 Strip Silence — Detection + split
- 3.13 Freeze Track — Render + bypass FX
- 3.14 Session Import/Export — RPP import/export + EDL export
- 3.15 DDP Export — Full DDP 2.0 exporter + UI
</details>

<details>
<summary>Phase 4: Advanced Features (COMPLETED except bridge gaps)</summary>

- 4.1 Clip Launch / Trigger Engine — Backend complete (see Plan R2 for broken bridge)
- 4.2 Step Sequencer — Drum Editor implementation
- 4.3 Built-in Effects — S13 EQ/Comp/Gate/Limiter/Delay/Reverb/Chorus/Saturator
- 4.4 Sidechain — Backend complete (see Plan R4 for missing UI)
</details>

<details>
<summary>Deferred Features — Status</summary>

**Visual / Cosmetic**: All done (waveform rendering, clip rendering, fade curves, automation styling, themes, track icons, meters, piano roll, transport, scrollbars, loading states, animations, High-DPI, color picker)

**Interaction / Workflow**: Mostly done. Missing: crosshair cursor (Plan R9), tab-to-transient (Plan R12), contextual help F1. Done: drag-and-drop, custom shortcuts, smart tool, snap preview, track folders, slip editing, marquee zoom, auto-scroll, media browser, project notes, track notes, waveform zoom, spectral view, time selection, recent files.

**Performance / Optimization**: All done (diff-based sync, waveform virtualization, useShallow everywhere, LRU eviction, concurrent peaks, Konva layers, plugin scan caching, bridge batching, reader pooling).

**Audio Quality**: Done except Lagrange resampling (uncertain). Done: pan law options (backend), DC offset removal (backend), gain staging display, oversampling, LUFS/phase/spectrum metering.

**MIDI Editing**: All done (velocity, CC lanes, quantize, transform, step input, multi-clip, MIDI learn, drum editor, MIDI import/export, scale highlighting). Note expression/MPE infrastructure exists but UI may be incomplete.

**Plugin Management**: Mostly done. Missing: crash isolation (sandboxing), 32-bit bridge. Done: favorites, categories, presets, generic editor, A/B comparison, chain presets, PDC, parameter automation list.

**Project Management**: All done (templates, archive, missing media — actually missing media resolver NOT done, media pool, cleanup, auto-save, compare, metadata).

**Mixing / Routing**: Mostly done. Missing: channel strip EQ UI (Plan R3). Done: routing matrix, bus workflow, pre/post fader sends, mixer snapshots, mixer undo, VCA faders.

**Accessibility**: NOT DONE — see Plan R10.

**Documentation / Help**: Mostly NOT DONE. Missing: in-app guide, F1 help, user manual, API docs. Done: keyboard shortcut cheat sheet (printable).
</details>

---

## Implementation Priority Order

### Sprint A (Fix Broken Features) — HIGH PRIORITY
1. **R1: Clip Gain Envelope sync** — Add gainEnvelope to syncClipsWithBackend + clip gain drawing UI
2. **R2: Trigger Engine bridge** — Add bridge functions + wire frontend store + basic Clip Launcher UI

### Sprint B (Add Missing UI for Backend Features) — MEDIUM PRIORITY
3. **R3: Channel Strip EQ UI** — Collapsible EQ section in ChannelStrip
4. **R4: Sidechain Routing UI** — Per-plugin sidechain source dropdown in FXChainPanel
5. **R5: Pan Law dropdown** — Simple dropdown in ProjectSettingsModal
6. **R6: DC Offset toggle** — Per-track toggle
7. **R7: Monitoring FX UI** — Monitor FX section in mixer

### Sprint C (Missing Features) — MEDIUM PRIORITY
8. **R9: Crosshair Cursor** — Konva layer with vertical+horizontal lines
9. **R11: Missing Media Resolver** — Detection on project load + relink dialog

### Sprint D (Accessibility) — MEDIUM-HIGH PRIORITY
10. **R10: Accessibility Phase A** — ARIA labels + focus indicators across all components
11. **R10: Accessibility Phase B** — Keyboard navigation
12. **R10: Accessibility Phase C** — Screen reader optimization

### Sprint E (Low Priority Remaining)
13. **R8: Timecode Sync UI** — Sync settings panel
14. **R12: Tab-to-Transient** — Transient detection + keyboard navigation
15. Contextual help (F1) system
16. In-app getting started guide
17. User manual / API documentation
18. Plugin crash isolation (separate process sandboxing)
19. 32-bit plugin bridge
20. MPE/Note Expression UI completion

---

## Score Card

| Category | Done | Remaining | Total |
|----------|------|-----------|-------|
| Core Audio Features (1-13) | 7 | 6 (UI gaps + 2 broken) | 13 |
| Frontend Features (14-30) | 15 | 2 | 17 |
| Backend Features (31-36) | 6 | 0 | 6 |
| Major Flow Changes | 7 | 1 uncertain | 8 |
| Deferred: Visual/Cosmetic | 17 | 0 | 17 |
| Deferred: Interaction/Workflow | 17 | 3 | 20 |
| Deferred: Performance | 14 | 0 | 14 |
| Deferred: Audio Quality | 8 | 1 uncertain | 9 |
| Deferred: MIDI Editing | 11 | 0-1 (MPE) | 11 |
| Deferred: Plugin Management | 8 | 2 | 10 |
| Deferred: Project Management | 7 | 1 | 8 |
| Deferred: Mixing/Routing | 6 | 1 | 7 |
| Deferred: Accessibility | 0 | 6 | 6 |
| Deferred: Documentation | 1 | 4 | 5 |
| **TOTAL** | **~124** | **~27** | **~151** |

**Completion: ~82%** — Most core functionality works. Remaining work is primarily UI wiring, accessibility, and documentation.
