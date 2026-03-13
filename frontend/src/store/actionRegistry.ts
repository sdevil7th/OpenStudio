/**
 * Action Registry - Centralized registry of all available actions
 * Used by Command Palette, keyboard shortcuts reference, and Actions menu
 */

import { useDAWStore } from "./useDAWStore";

export interface ActionDef {
  id: string;
  name: string;
  category: string;
  shortcut?: string;
  execute: () => void;
}

/**
 * Returns the full list of registered actions.
 * Actions reference the store via getState() so they always use current state.
 */
export function getRegisteredActions(): ActionDef[] {
  const s = () => useDAWStore.getState();

  return [
    // ===== Transport =====
    { id: "transport.play", name: "Play / Pause", category: "Transport", shortcut: "Space", execute: () => s().togglePlayPause() },
    { id: "transport.stop", name: "Stop", category: "Transport", shortcut: "Space (while playing)", execute: () => s().stop() },
    { id: "transport.record", name: "Record", category: "Transport", shortcut: "Ctrl+R", execute: () => s().record() },
    { id: "transport.rewind", name: "Go to Start", category: "Transport", execute: () => s().setCurrentTime(0) },
    { id: "transport.loop", name: "Toggle Loop", category: "Transport", shortcut: "L", execute: () => s().toggleLoop() },

    // ===== Navigation =====
    { id: "navigate.nextTransient", name: "Next Transient", category: "Navigation", shortcut: "Tab", execute: () => {
      const state = s();
      const selectedIds = state.selectedClipIds;
      if (selectedIds.length === 0) return;
      const clip = state.tracks.flatMap(t => t.clips).find(c => selectedIds.includes(c.id));
      if (!clip?.filePath) return;
      import("../services/NativeBridge").then(({ nativeBridge }) => {
        nativeBridge.detectTransients(clip.filePath!, 0.3, 50).then((transients: number[]) => {
          const currentTime = state.transport.currentTime - clip.startTime + (clip.offset || 0);
          const next = transients.find(t => t > currentTime + 0.01);
          if (next !== undefined) state.setCurrentTime(clip.startTime + next - (clip.offset || 0));
        });
      });
    }},
    { id: "navigate.prevTransient", name: "Previous Transient", category: "Navigation", shortcut: "Shift+Tab", execute: () => {
      const state = s();
      const selectedIds = state.selectedClipIds;
      if (selectedIds.length === 0) return;
      const clip = state.tracks.flatMap(t => t.clips).find(c => selectedIds.includes(c.id));
      if (!clip?.filePath) return;
      import("../services/NativeBridge").then(({ nativeBridge }) => {
        nativeBridge.detectTransients(clip.filePath!, 0.3, 50).then((transients: number[]) => {
          const currentTime = state.transport.currentTime - clip.startTime + (clip.offset || 0);
          const prev = [...transients].reverse().find(t => t < currentTime - 0.01);
          if (prev !== undefined) state.setCurrentTime(clip.startTime + prev - (clip.offset || 0));
        });
      });
    }},

    // ===== Tools =====
    { id: "tools.selectTool", name: "Select Tool", category: "Tools", shortcut: "V", execute: () => s().setToolMode("select") },
    { id: "tools.splitTool", name: "Split Tool", category: "Tools", shortcut: "B", execute: () => s().toggleSplitTool() },
    { id: "tools.muteTool", name: "Mute Tool", category: "Tools", shortcut: "X", execute: () => s().toggleMuteTool() },
    { id: "tools.smartTool", name: "Smart Tool", category: "Tools", shortcut: "Y", execute: () => s().setToolMode("smart") },

    // ===== Edit =====
    { id: "edit.undo", name: "Undo", category: "Edit", shortcut: "Ctrl+Z", execute: () => s().undo() },
    { id: "edit.redo", name: "Redo", category: "Edit", shortcut: "Ctrl+Shift+Z", execute: () => s().redo() },
    { id: "edit.cut", name: "Cut Selected Clips", category: "Edit", shortcut: "Ctrl+X", execute: () => s().cutSelectedClips() },
    { id: "edit.copy", name: "Copy Selected Clips", category: "Edit", shortcut: "Ctrl+C", execute: () => s().copySelectedClips() },
    { id: "edit.paste", name: "Paste Clips", category: "Edit", shortcut: "Ctrl+V", execute: () => s().pasteClips() },
    { id: "edit.delete", name: "Delete Selected", category: "Edit", shortcut: "Delete", execute: () => {
      const state = s();
      if (state.selectedTrackIds.length > 0) state.deleteSelectedTracks();
      else if (state.selectedClipIds.length > 0) state.selectedClipIds.forEach((id) => state.deleteClip(id));
    }},
    { id: "edit.selectAllTracks", name: "Select All Tracks", category: "Edit", shortcut: "Ctrl+A", execute: () => s().selectAllTracks() },
    { id: "edit.selectAllClips", name: "Select All Clips", category: "Edit", shortcut: "Ctrl+Shift+A", execute: () => s().selectAllClips() },
    { id: "edit.deselectAll", name: "Deselect All", category: "Edit", shortcut: "Esc", execute: () => s().deselectAllTracks() },
    { id: "edit.splitAtCursor", name: "Split at Cursor", category: "Edit", shortcut: "S", execute: () => s().splitClipAtPlayhead() },
    { id: "edit.splitAtSelection", name: "Split at Time Selection", category: "Edit", execute: () => s().splitAtTimeSelection() },
    { id: "edit.groupClips", name: "Group Selected Clips", category: "Edit", shortcut: "Ctrl+G", execute: () => s().groupSelectedClips() },
    { id: "edit.ungroupClips", name: "Ungroup Selected Clips", category: "Edit", shortcut: "Ctrl+Shift+G", execute: () => s().ungroupSelectedClips() },
    { id: "edit.normalizeClips", name: "Normalize Selected Clips", category: "Edit", execute: () => s().normalizeSelectedClips() },
    { id: "edit.deleteRazorContent", name: "Delete Razor Edit Content", category: "Edit", execute: () => s().deleteRazorEditContent() },
    { id: "edit.clearRazorEdits", name: "Clear Razor Edits", category: "Edit", execute: () => s().clearRazorEdits() },
    { id: "edit.muteClips", name: "Toggle Clip Mute", category: "Edit", shortcut: "U", execute: () => { const state = s(); state.selectedClipIds.forEach((id) => state.toggleClipMute(id)); } },
    { id: "edit.nudgeLeft", name: "Nudge Clips Left", category: "Edit", shortcut: "Left", execute: () => s().nudgeClips("left") },
    { id: "edit.nudgeRight", name: "Nudge Clips Right", category: "Edit", shortcut: "Right", execute: () => s().nudgeClips("right") },
    { id: "edit.nudgeLeftFine", name: "Nudge Clips Left (Fine)", category: "Edit", shortcut: "Ctrl+Left", execute: () => s().nudgeClips("left", true) },
    { id: "edit.nudgeRightFine", name: "Nudge Clips Right (Fine)", category: "Edit", shortcut: "Ctrl+Right", execute: () => s().nudgeClips("right", true) },

    // ===== Insert =====
    { id: "insert.audioTrack", name: "New Audio Track", category: "Insert", shortcut: "Ctrl+T", execute: () => {
      const state = s();
      state.addTrack({ id: crypto.randomUUID(), name: `Audio ${state.tracks.length + 1}`, type: "audio" });
    }},
    { id: "insert.midiTrack", name: "New MIDI Track", category: "Insert", shortcut: "Ctrl+Shift+T", execute: () => {
      const state = s();
      state.addTrack({ id: crypto.randomUUID(), name: `MIDI ${state.tracks.length + 1}`, type: "midi" });
    }},
    { id: "insert.instrumentTrack", name: "Virtual Instrument on New Track", category: "Insert", execute: () => {
      const state = s();
      const trackId = crypto.randomUUID();
      state.addTrack({ id: trackId, name: `Instrument ${state.tracks.filter((t) => t.type === "instrument").length + 1}`, type: "instrument", armed: true, monitorEnabled: true });
      state.openPluginBrowser(trackId);
    }},
    { id: "insert.quickAddInstrument", name: "Quick Add Instrument Track", category: "Insert", shortcut: "Ctrl+Shift+I", execute: () => {
      const state = s();
      const trackId = crypto.randomUUID();
      state.addTrack({ id: trackId, name: `Instrument ${state.tracks.filter((t) => t.type === "instrument").length + 1}`, type: "instrument", armed: true, monitorEnabled: true });
      state.openPluginBrowser(trackId);
    }},
    { id: "insert.folderTrack", name: "New Folder Track", category: "Insert", execute: () => {
      const state = s();
      state.createFolderTrack(`Folder ${state.tracks.filter((t: any) => t.isFolder).length + 1}`);
    }},
    { id: "insert.marker", name: "Add Marker at Playhead", category: "Insert", shortcut: "M", execute: () => s().addMarker(s().transport.currentTime) },

    // ===== View =====
    { id: "view.toggleMixer", name: "Toggle Mixer", category: "View", shortcut: "Ctrl+M", execute: () => s().toggleMixer() },
    { id: "view.toggleMasterTrackTCP", name: "Toggle Master Track in TCP", category: "View", execute: () => s().toggleMasterTrackInTCP() },
    { id: "view.toggleSnap", name: "Toggle Snap", category: "View", execute: () => s().toggleSnap() },
    { id: "view.toggleAutoCrossfade", name: "Toggle Auto-Crossfade", category: "View", execute: () => s().toggleAutoCrossfade() },
    { id: "view.toggleVirtualKeyboard", name: "Toggle Virtual MIDI Keyboard", category: "View", shortcut: "Alt+B", execute: () => s().toggleVirtualKeyboard() },
    { id: "view.toggleUndoHistory", name: "Toggle Undo History", category: "View", shortcut: "Ctrl+Alt+Z", execute: () => s().toggleUndoHistory() },

    // ===== File =====
    { id: "file.new", name: "New Project", category: "File", shortcut: "Ctrl+N", execute: () => s().newProject() },
    { id: "file.save", name: "Save Project", category: "File", shortcut: "Ctrl+S", execute: () => s().saveProject() },
    { id: "file.open", name: "Open Project", category: "File", shortcut: "Ctrl+O", execute: () => { void s().loadProject(); } },
    { id: "file.projectSettings", name: "Project Settings", category: "File", shortcut: "Alt+Enter", execute: () => s().openProjectSettings() },
    { id: "file.render", name: "Render / Export", category: "File", shortcut: "Ctrl+Alt+R", execute: () => s().openRenderModal() },
    { id: "file.settings", name: "Audio Settings", category: "File", execute: () => s().openSettings() },
    { id: "project.compare", name: "Compare with Saved Version", category: "File", execute: () => { void s().compareWithSavedProject(); } },

    // ===== Options =====
    { id: "options.tapTempo", name: "Tap Tempo", category: "Options", shortcut: "T", execute: () => s().tapTempo() },
    { id: "view.regionMarkerManager", name: "Toggle Region/Marker Manager", category: "View", execute: () => s().toggleRegionMarkerManager() },
    { id: "view.clipProperties", name: "Toggle Clip Properties", category: "View", shortcut: "F2", execute: () => s().toggleClipProperties() },
    { id: "edit.toggleClipLock", name: "Toggle Clip Lock", category: "Edit", execute: () => { const state = s(); state.selectedClipIds.forEach((id) => state.toggleClipLock(id)); } },
    { id: "edit.cutWithinSelection", name: "Cut within Time Selection", category: "Edit", execute: () => s().cutWithinTimeSelection() },
    { id: "edit.copyWithinSelection", name: "Copy within Time Selection", category: "Edit", execute: () => s().copyWithinTimeSelection() },
    { id: "edit.deleteWithinSelection", name: "Delete within Time Selection (Ripple)", category: "Edit", execute: () => s().deleteWithinTimeSelection() },
    { id: "edit.insertSilence", name: "Insert Silence", category: "Edit", execute: () => s().insertSilenceAtTimeSelection() },
    { id: "view.bigClock", name: "Toggle Big Clock", category: "View", execute: () => s().toggleBigClock() },
    { id: "view.keyboardShortcuts", name: "Keyboard Shortcuts", category: "View", execute: () => s().toggleKeyboardShortcuts() },
    { id: "help.contextualHelp", name: "Help Reference", category: "Help", shortcut: "F1", execute: () => s().toggleContextualHelp() },
    { id: "help.gettingStarted", name: "Getting Started Guide", category: "Help", execute: () => s().toggleGettingStarted() },
    { id: "options.preferences", name: "Preferences", category: "Options", shortcut: "Ctrl+,", execute: () => s().togglePreferences() },
    { id: "options.recordNormal", name: "Record Mode: Normal", category: "Options", execute: () => s().setRecordMode("normal") },
    { id: "options.recordOverdub", name: "Record Mode: Overdub", category: "Options", execute: () => s().setRecordMode("overdub") },
    { id: "options.recordReplace", name: "Record Mode: Replace", category: "Options", execute: () => s().setRecordMode("replace") },
    { id: "options.rippleOff", name: "Ripple Editing: Off", category: "Options", execute: () => s().setRippleMode("off") },
    { id: "options.ripplePerTrack", name: "Ripple Editing: Per Track", category: "Options", execute: () => s().setRippleMode("per_track") },
    { id: "options.rippleAllTracks", name: "Ripple Editing: All Tracks", category: "Options", execute: () => s().setRippleMode("all_tracks") },

    // ===== New Phase 8 Actions =====
    { id: "file.openSafeMode", name: "Open Project (Safe Mode)", category: "File", shortcut: "Ctrl+Shift+O", execute: () => { void s().loadProject(undefined, { bypassFX: true }); } },
    { id: "insert.emptyItem", name: "Insert Empty Item", category: "Insert", execute: () => {
      const state = s();
      const trackId = state.selectedTrackIds[0] || state.tracks.find((t: { type: string }) => t.type === "audio")?.id;
      if (trackId) state.addEmptyClip(trackId, state.transport.currentTime, 4);
    }},
    { id: "insert.trackSpacer", name: "Insert Track Spacer Below", category: "Insert", execute: () => {
      const state = s();
      const trackId = state.selectedTrackIds[0] || state.tracks[state.tracks.length - 1]?.id;
      if (trackId) state.addSpacer(trackId);
    }},
    { id: "options.toggleGlobalLock", name: "Toggle Global Lock", category: "Options", execute: () => s().toggleGlobalLock() },
    { id: "options.moveEnvelopesWithItems", name: "Toggle Move Envelopes with Items", category: "Options", execute: () => s().toggleMoveEnvelopesWithItems() },
    { id: "edit.quantizeToGrid", name: "Quantize Selected Clips to Grid", category: "Edit", execute: () => s().quantizeSelectedClips() },
    { id: "view.saveScreenset1", name: "Save Screenset 1", category: "View", shortcut: "Ctrl+Shift+1", execute: () => s().saveScreenset(0) },
    { id: "view.saveScreenset2", name: "Save Screenset 2", category: "View", shortcut: "Ctrl+Shift+2", execute: () => s().saveScreenset(1) },
    { id: "view.saveScreenset3", name: "Save Screenset 3", category: "View", shortcut: "Ctrl+Shift+3", execute: () => s().saveScreenset(2) },
    { id: "view.loadScreenset1", name: "Load Screenset 1", category: "View", shortcut: "Ctrl+1", execute: () => s().loadScreenset(0) },
    { id: "view.loadScreenset2", name: "Load Screenset 2", category: "View", shortcut: "Ctrl+2", execute: () => s().loadScreenset(1) },
    { id: "view.loadScreenset3", name: "Load Screenset 3", category: "View", shortcut: "Ctrl+3", execute: () => s().loadScreenset(2) },

    // ===== Phase 9: Audio Engine =====
    { id: "edit.reverseClip", name: "Reverse Clip", category: "Edit", execute: () => { const id = s().selectedClipId; if (id) void s().reverseClip(id); } },
    { id: "edit.dynamicSplit", name: "Dynamic Split...", category: "Edit", execute: () => s().openDynamicSplit() },
    { id: "options.resetMetronomeSounds", name: "Reset Metronome Sounds", category: "Options", execute: () => { void s().resetMetronomeSounds(); } },

    // ===== Phase 10: Render Pipeline =====
    { id: "file.regionRenderMatrix", name: "Region Render Matrix...", category: "File", execute: () => s().toggleRegionRenderMatrix() },

    // ===== Phase 11: Routing & Mixing =====
    { id: "view.routingMatrix", name: "Routing Matrix", category: "View", execute: () => s().toggleRoutingMatrix() },

    // ===== Phase 12: Media & File Management =====
    { id: "view.mediaExplorer", name: "Toggle Media Explorer", category: "View", execute: () => s().toggleMediaExplorer() },
    { id: "file.cleanProject", name: "Clean Project Directory...", category: "File", execute: () => s().toggleCleanProject() },
    { id: "file.exportMIDI", name: "Export Project MIDI...", category: "File", execute: () => { void s().exportProjectMIDI(); } },
    { id: "file.batchConverter", name: "Batch File Converter...", category: "File", execute: () => s().toggleBatchConverter() },

    // ===== Phase 13: Advanced Editing =====
    { id: "edit.explodeTakes", name: "Explode Takes to New Tracks", category: "Edit", execute: () => { const id = s().selectedClipId; if (id) s().explodeTakes(id); } },
    { id: "edit.implodeTakes", name: "Implode Clips into Takes", category: "Edit", execute: () => { const ids = s().selectedClipIds; if (ids.length > 1) s().implodeTakes(ids); } },
    { id: "view.freePositioning", name: "Toggle Free Item Positioning", category: "View", execute: () => s().toggleFreePositioning() },

    // ===== Phase 14: Theming & Customization =====
    { id: "view.themeEditor", name: "Theme Editor...", category: "View", execute: () => s().toggleThemeEditor() },
    { id: "options.themeDark", name: "Theme: Dark", category: "Options", execute: () => s().setTheme("dark") },
    { id: "options.themeLight", name: "Theme: Light", category: "Options", execute: () => s().setTheme("light") },
    { id: "options.themeMidnight", name: "Theme: Midnight", category: "Options", execute: () => s().setTheme("midnight") },
    { id: "options.themeHighContrast", name: "Theme: High Contrast", category: "Options", execute: () => s().setTheme("high-contrast") },
    { id: "options.resetMouseModifiers", name: "Reset Mouse Modifiers", category: "Options", execute: () => s().resetMouseModifiers() },

    // ===== Phase 15: Platform & Extensibility =====
    { id: "view.videoWindow", name: "Toggle Video Window", category: "View", execute: () => s().toggleVideoWindow() },
    { id: "view.scriptEditor", name: "Toggle Script Editor", category: "View", execute: () => s().toggleScriptEditor() },
    { id: "view.toolbarEditor", name: "Toolbar Editor...", category: "View", execute: () => s().toggleToolbarEditor() },
    { id: "file.newTab", name: "New Project Tab", category: "File", execute: () => s().addProjectTab() },

    // ===== Phase 16: Pro Audio & Compatibility =====
    { id: "file.ddpExport", name: "DDP Disc Image Export...", category: "File", execute: () => s().toggleDDPExport() },
    { id: "file.captureOutput", name: "Toggle Capture Output", category: "File", execute: () => { if (s().liveCaptureEnabled) { void s().stopLiveCapture(); } else { void s().startLiveCapture(); } } },
    { id: "options.pluginBridge", name: "Toggle 32-bit Plugin Bridge", category: "Options", execute: () => s().togglePluginBridge() },

    // ===== Sprint 18: Interaction/Workflow =====
    { id: "view.zoomToSelection", name: "Zoom to Time Selection", category: "View", shortcut: "Ctrl+Shift+E", execute: () => s().zoomToSelection() },
    { id: "view.autoScroll", name: "Toggle Auto-Scroll During Playback", category: "View", execute: () => s().toggleAutoScroll() },
    { id: "edit.transpose", name: "Transpose Selected Notes", category: "Edit", execute: () => { /* Handled in PianoRoll */ } },
    { id: "edit.velocityScale", name: "Scale Velocity of Selected Notes", category: "Edit", execute: () => { /* Handled in PianoRoll */ } },

    // ===== MIDI Transform =====
    { id: "edit.transposeUp", name: "Transpose Up (+1 semitone)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, 1); } },
    { id: "edit.transposeDown", name: "Transpose Down (-1 semitone)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, -1); } },
    { id: "edit.transposeOctaveUp", name: "Transpose Octave Up (+12)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, 12); } },
    { id: "edit.transposeOctaveDown", name: "Transpose Octave Down (-12)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, -12); } },
    { id: "edit.velocityUp", name: "Velocity +10%", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.scaleMIDINoteVelocity(st.pianoRollClipId, 1.1); } },
    { id: "edit.velocityDown", name: "Velocity -10%", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.scaleMIDINoteVelocity(st.pianoRollClipId, 0.9); } },
    { id: "edit.reverseNotes", name: "Reverse MIDI Notes", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.reverseMIDINotes(st.pianoRollClipId); } },
    { id: "edit.invertNotes", name: "Invert MIDI Note Pitches", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.invertMIDINotes(st.pianoRollClipId); } },

    // ===== Sprint 19: MIDI + Plugin + Mixing =====
    { id: "midi.quantize", name: "Quantize Notes...", category: "MIDI", shortcut: "Q", execute: () => s().toggleQuantizeDialog() },
    { id: "midi.transpose", name: "Transpose Notes...", category: "MIDI", execute: () => { /* PianoRoll modal */ } },
    { id: "midi.selectAll", name: "Select All Notes", category: "MIDI", execute: () => s().selectAllMIDINotes() },
    { id: "view.drumEditor", name: "Toggle Drum Editor", category: "View", execute: () => s().toggleDrumEditor() },
    { id: "insert.busTrack", name: "Insert Bus/Group Track", category: "Insert", execute: () => {
      const state = s();
      const id = crypto.randomUUID();
      state.addTrack({ id, name: `Bus ${state.tracks.filter((t: any) => t.type === "bus").length + 1}`, type: "bus" });
    }},
    { id: "view.mediaPool", name: "Toggle Media Pool", category: "View", execute: () => s().toggleMediaPool() },

    // ===== Sprint 20: Cross-Platform + Accessibility =====
    { id: "view.loudnessMeter", name: "Toggle Loudness Meter", category: "View", execute: () => s().toggleLoudnessMeter() },
    { id: "view.spectrumAnalyzer", name: "Toggle Spectrum Analyzer", category: "View", execute: () => s().toggleSpectrumAnalyzer() },
    { id: "view.phaseCorrelation", name: "Toggle Phase Correlation Meter", category: "View", execute: () => s().togglePhaseCorrelation() },
    { id: "file.archiveSession", name: "Archive Session...", category: "File", execute: () => { void s().archiveSession(); } },
    { id: "file.newFromTemplate", name: "New from Template...", category: "File", execute: () => s().toggleProjectTemplates() },

    // ===== Pitch Editor =====
    { id: "edit.editPitch", name: "Edit Pitch", category: "Edit", shortcut: "P", execute: () => {
      const state = s();
      const clipId = state.selectedClipIds[0];
      if (!clipId) return;
      const track = state.tracks.find((t: any) => t.clips.some((c: any) => c.id === clipId));
      if (!track || track.type === "midi") return;
      if (state.showPitchEditor && state.pitchEditorClipId === clipId) {
        state.closePitchEditor();
      } else {
        state.openPitchEditor(track.id, clipId, -1);
      }
    }},

    // ===== Polyphonic Pitch Detection (Phase 6) =====
    { id: "edit.extractMidi", name: "Extract MIDI from Audio", category: "Edit", execute: () => {
      const state = s();
      const clipId = state.selectedClipIds[0];
      if (!clipId) return;
      const track = state.tracks.find((t: any) => t.clips.some((c: any) => c.id === clipId));
      if (!track || track.type === "midi") return;
      void import("../services/NativeBridge").then(({ nativeBridge }) => {
        void nativeBridge.extractMidiFromAudio(track.id, clipId).then((result) => {
          if (result && result.notes && result.notes.length > 0) {
            const st = s();
            const sourceClip = track.clips.find((c: any) => c.id === clipId);
            const newTrackId = crypto.randomUUID();
            st.addTrack({ id: newTrackId, name: `MIDI from ${sourceClip?.name || "Audio"}`, type: "midi" });
            const maxEnd = Math.max(...result.notes.map((n: any) => n.endTime));
            const newClipId = st.addMIDIClip(newTrackId, sourceClip?.startTime || 0, maxEnd);
            const events: any[] = [];
            for (const n of result.notes) {
              events.push({ timestamp: n.startTime, type: "noteOn", note: n.midiPitch, velocity: Math.round(n.velocity * 127) });
              events.push({ timestamp: n.endTime, type: "noteOff", note: n.midiPitch, velocity: 0 });
            }
            events.sort((a: any, b: any) => a.timestamp - b.timestamp);
            useDAWStore.setState((prev) => ({
              tracks: prev.tracks.map((t: any) => t.id === newTrackId ? {
                ...t, midiClips: t.midiClips.map((c: any) => c.id === newClipId ? { ...c, events } : c),
              } : t),
            }));
          }
        });
      });
    }},

    // ===== Sprint 21: Timeline Interaction =====
    { id: "view.toggleCrosshair", name: "Toggle Crosshair Cursor", category: "View", execute: () => s().toggleCrosshair() },

    // ===== Mixer Snapshots & Bus/Group & Templates =====
    { id: "insert.bus", name: "Create Bus from Selected Tracks", category: "Insert", execute: () => s().createBusFromSelectedTracks() },
    { id: "mixer.saveSnapshot", name: "Save Mixer Snapshot", category: "Mixer", execute: () => {
      const name = prompt("Snapshot name:", `Snapshot ${s().mixerSnapshots.length + 1}`);
      if (name) s().saveMixerSnapshot(name);
    }},
    { id: "file.saveAsTemplate", name: "Save as Template...", category: "File", execute: () => {
      const name = prompt("Template name:");
      if (name) s().saveAsTemplate(name);
    }},
  ];
}
