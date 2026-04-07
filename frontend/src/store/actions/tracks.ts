// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError, toastBridgeError } from "../../utils/bridgeErrorHandler";
import { createDefaultTrack } from "../useDAWStore";
import { getLinkedTrackIds, _linkingInProgress, _editSnapshots, _autoRecordTimers, AUTO_RECORD_INTERVAL_MS, syncAutomationLaneToBackend } from "./storeHelpers";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

function cloneAudioClip(clip: any): any {
  return {
    ...clip,
    id: crypto.randomUUID(),
    gainEnvelope: clip.gainEnvelope?.map((point: any) => ({ ...point })),
    takes: clip.takes?.map((take: any) => cloneAudioClip(take)),
  };
}

function cloneMidiClip(clip: any): any {
  return {
    ...clip,
    id: crypto.randomUUID(),
    events: clip.events?.map((event: any) => ({ ...event })) ?? [],
    ccEvents: clip.ccEvents?.map((event: any) => ({ ...event })) ?? [],
  };
}

function cloneTrackForDuplication(track: any, newTrackId: string) {
  return {
    ...JSON.parse(JSON.stringify(track)),
    id: newTrackId,
    name: `${track.name} (copy)`,
    meterLevel: 0,
    peakLevel: 0,
    clipping: false,
    suspendedAutomationState: null,
    vcaGroupId: undefined,
    isVCALeader: false,
    clips: track.clips.map((clip: any) => cloneAudioClip(clip)),
    frozenOriginalClips: track.frozenOriginalClips?.map((clip: any) => cloneAudioClip(clip)),
    takes: track.takes?.map((lane: any[]) => lane.map((clip: any) => cloneAudioClip(clip))) ?? [],
    midiClips: track.midiClips.map((clip: any) => cloneMidiClip(clip)),
  };
}

function collectTrackClipIds(track: any): Set<string> {
  const clipIds = new Set<string>();
  for (const clip of track?.clips ?? [])
    clipIds.add(clip.id);
  for (const clip of track?.midiClips ?? [])
    clipIds.add(clip.id);
  return clipIds;
}

async function clearTrackBoundUiBeforeRemoval(state: any, trackId: string, track: any) {
  const clipIds = collectTrackClipIds(track);

  if (state.showPitchEditor
      && (state.pitchEditorTrackId === trackId
          || (state.pitchEditorClipId && clipIds.has(state.pitchEditorClipId)))) {
    state.closePitchEditor();
  }

  if (state.showPianoRoll
      && (state.pianoRollTrackId === trackId
          || (state.pianoRollClipId && clipIds.has(state.pianoRollClipId)))) {
    state.closePianoRoll();
  }

  if (state.showPluginBrowser && state.pluginBrowserTrackId === trackId)
    state.closePluginBrowser();

  if (state.showEnvelopeManager && state.envelopeManagerTrackId === trackId)
    state.closeEnvelopeManager();

  if (state.showChannelStripEQ && state.channelStripEQTrackId === trackId)
    state.closeChannelStripEQ();

  if (state.showTrackRouting && state.trackRoutingTrackId === trackId)
    state.closeTrackRouting();

  if (state.showStemSeparation
      && (state.stemSepTrackId === trackId
          || (state.stemSepClipId && clipIds.has(state.stemSepClipId)))) {
    state.closeStemSeparation();
  }

  if (state.showDynamicSplit && state.dynamicSplitClipId && clipIds.has(state.dynamicSplitClipId))
    state.closeDynamicSplit();

  if (state.showCrossfadeEditor && state.crossfadeEditorClipIds) {
    const [clipA, clipB] = state.crossfadeEditorClipIds;
    if ((clipA && clipIds.has(clipA)) || (clipB && clipIds.has(clipB)))
      state.closeCrossfadeEditor();
  }

  if (state.showClipProperties) {
    const selectedClipIds = [
      ...(state.selectedClipId ? [state.selectedClipId] : []),
      ...(state.selectedClipIds ?? []),
    ];
    if (selectedClipIds.some((clipId: string) => clipIds.has(clipId))) {
      state.toggleClipProperties();
    }
  }

  await nativeBridge.closeAllPluginWindows().catch(() => false);
}

async function syncTrackCoreToBackend(track: any, options?: { includeAddTrack?: boolean }) {
  if (options?.includeAddTrack) {
    await nativeBridge.addTrack(track.id);
  }

  await nativeBridge.setTrackType(track.id, track.type).catch(() => false);
  await nativeBridge.setTrackRecordArm(track.id, track.armed).catch(() => false);
  await nativeBridge.setTrackInputMonitoring(track.id, track.monitorEnabled).catch(() => false);
  await nativeBridge.setTrackInputChannels(
    track.id,
    track.inputStartChannel ?? 0,
    track.inputChannelCount ?? 2,
  ).catch(() => false);

  if (track.type === "midi" || track.type === "instrument" || track.inputType === "midi") {
    if (track.midiInputDevice) {
      await nativeBridge.openMIDIDevice(track.midiInputDevice).catch(() => false);
    }

    await nativeBridge.setTrackMIDIInput(
      track.id,
      track.midiInputDevice || "",
      track.midiChannel ?? 0,
    ).catch(() => false);
  }

  if (track.midiOutputDevice) {
    await nativeBridge.setTrackMIDIOutput(track.id, track.midiOutputDevice).catch(() => false);
  }
}

async function restoreTrackFxChain(sourceTrackId: string, newTrackId: string, isInputFX: boolean) {
  const getFx = isInputFX ? nativeBridge.getTrackInputFX.bind(nativeBridge) : nativeBridge.getTrackFX.bind(nativeBridge);
  const addFx = isInputFX ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);
  const bypassFx = isInputFX ? nativeBridge.bypassTrackInputFX.bind(nativeBridge) : nativeBridge.bypassTrackFX.bind(nativeBridge);
  const sourceFx = await getFx(sourceTrackId).catch(() => []);

  for (let i = 0; i < sourceFx.length; i++) {
    const pluginPath = sourceFx[i]?.pluginPath;
    if (!pluginPath) continue;
    const success = await addFx(newTrackId, pluginPath, false).catch(() => false);
    if (!success) continue;
    const pluginState = await nativeBridge.getPluginState(sourceTrackId, i, isInputFX).catch(() => null);
    if (pluginState) {
      await nativeBridge.setPluginState(newTrackId, i, isInputFX, pluginState).catch(() => false);
    }
    if (sourceFx[i]?.bypassed) {
      await bypassFx(newTrackId, i, true).catch(() => false);
    }
  }

  return sourceFx.length;
}

async function syncDuplicatedTrackToBackend(sourceTrack: any, newTrack: any, insertIndex: number) {
  await syncTrackCoreToBackend(newTrack);
  await nativeBridge.reorderTrack(newTrack.id, insertIndex).catch(() => false);
  await nativeBridge.setTrackVolume(newTrack.id, newTrack.volumeDB).catch(() => false);
  await nativeBridge.setTrackPan(newTrack.id, newTrack.pan).catch(() => false);
  await nativeBridge.setTrackMute(newTrack.id, newTrack.muted).catch(() => false);
  await nativeBridge.setTrackSolo(newTrack.id, newTrack.soloed).catch(() => false);
  await nativeBridge.setTrackRecordSafe(newTrack.id, newTrack.recordSafe).catch(() => false);
  await nativeBridge.setTrackPhaseInvert(newTrack.id, !!newTrack.phaseInverted).catch(() => false);
  await nativeBridge.setTrackStereoWidth(newTrack.id, newTrack.stereoWidth ?? 100).catch(() => false);
  await nativeBridge.setTrackMasterSendEnabled(newTrack.id, newTrack.masterSendEnabled ?? true).catch(() => false);
  await nativeBridge.setTrackOutputChannels(
    newTrack.id,
    newTrack.outputStartChannel ?? 0,
    newTrack.outputChannelCount ?? 2,
  ).catch(() => false);
  await nativeBridge.setTrackPlaybackOffset(newTrack.id, newTrack.playbackOffsetMs ?? 0).catch(() => false);
  await nativeBridge.setTrackChannelCount(newTrack.id, newTrack.trackChannelCount ?? 2).catch(() => false);

  for (const clip of newTrack.clips) {
    if (!clip.filePath) continue;
    await nativeBridge.addPlaybackClip(
      newTrack.id,
      clip.filePath,
      clip.startTime,
      clip.duration,
      clip.offset || 0,
      clip.volumeDB || 0,
      clip.fadeIn || 0,
      clip.fadeOut || 0,
      clip.id,
      clip.pitchCorrectionSourceFilePath,
      clip.pitchCorrectionSourceOffset,
    ).catch(() => false);
  }

  if (newTrack.midiClips.length > 0) {
    await nativeBridge.setTrackMIDIClips(newTrack.id, newTrack.midiClips).catch(() => false);
  }

  for (const [sendIndex, send] of (newTrack.sends ?? []).entries()) {
    const createdIndex = await nativeBridge.addTrackSend(newTrack.id, send.destTrackId).catch(() => sendIndex);
    const resolvedIndex = typeof createdIndex === "number" && createdIndex >= 0 ? createdIndex : sendIndex;
    await nativeBridge.setTrackSendLevel(newTrack.id, resolvedIndex, send.level).catch(() => false);
    await nativeBridge.setTrackSendPan(newTrack.id, resolvedIndex, send.pan).catch(() => false);
    await nativeBridge.setTrackSendEnabled(newTrack.id, resolvedIndex, send.enabled).catch(() => false);
    await nativeBridge.setTrackSendPreFader(newTrack.id, resolvedIndex, send.preFader).catch(() => false);
    await nativeBridge.setTrackSendPhaseInvert(newTrack.id, resolvedIndex, send.phaseInvert).catch(() => false);
  }

  const inputFxCount = await restoreTrackFxChain(sourceTrack.id, newTrack.id, true);
  const trackFxCount = await restoreTrackFxChain(sourceTrack.id, newTrack.id, false);

  if (newTrack.fxBypassed) {
    for (let i = 0; i < inputFxCount; i++) {
      await nativeBridge.bypassTrackInputFX(newTrack.id, i, true).catch(() => false);
    }
    for (let i = 0; i < trackFxCount; i++) {
      await nativeBridge.bypassTrackFX(newTrack.id, i, true).catch(() => false);
    }
  }

  for (const lane of newTrack.automationLanes) {
    syncAutomationLaneToBackend(newTrack.id, lane);
  }
  if (!newTrack.automationEnabled) {
    for (const lane of newTrack.automationLanes) {
      await nativeBridge.setAutomationMode(newTrack.id, lane.param, "off").catch(() => false);
    }
  }
}

export const trackActions = (set: SetFn, get: GetFn) => ({
    addTrack: (trackData) => {
      const newTrack = createDefaultTrack(
        trackData.id,
        trackData.name,
        trackData.color,
      );
      const fullTrack = { ...newTrack, ...trackData };

      const command: Command = {
        type: "ADD_TRACK",
        description: `Add track "${trackData.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((state) => {
            const insertAfter = (trackData as any).insertAfterTrackId as string | undefined;
            if (insertAfter) {
              const idx = state.tracks.findIndex((t) => t.id === insertAfter);
              if (idx >= 0) {
                const newTracks = [...state.tracks];
                newTracks.splice(idx + 1, 0, fullTrack);
                return { tracks: newTracks };
              }
            }
            return { tracks: [...state.tracks, fullTrack] };
          });
          syncTrackCoreToBackend(fullTrack, { includeAddTrack: true })
            .catch((e) =>
              console.error("[DAW] Failed to sync new track with backend:", e),
            );
        },
        undo: () => {
          nativeBridge.removeTrack(trackData.id).catch((e) =>
            console.error("[DAW] Failed to sync removeTrack with backend:", e),
          );
          set((state) => ({
            tracks: state.tracks.filter((t) => t.id !== trackData.id),
            selectedTrackId:
              state.selectedTrackId === trackData.id ? null : state.selectedTrackId,
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    duplicateTrack: async (trackId) => {
      const state = get();
      const sourceTrack = state.tracks.find((t) => t.id === trackId);
      if (!sourceTrack) return;

      const sourceTrackIndex = state.tracks.findIndex((t) => t.id === trackId);
      const newTrackId = crypto.randomUUID();
      const duplicatedTrack = cloneTrackForDuplication(sourceTrack, newTrackId);

      try {
        await nativeBridge.addTrack(newTrackId);
        set((s) => {
          const tracks = [...s.tracks];
          tracks.splice(sourceTrackIndex + 1, 0, duplicatedTrack);
          return {
            tracks,
            selectedTrackId: newTrackId,
            selectedTrackIds: [newTrackId],
            lastSelectedTrackId: newTrackId,
          };
        });
        await syncDuplicatedTrackToBackend(sourceTrack, duplicatedTrack, sourceTrackIndex + 1);
      } catch (error) {
        console.error("[DAW] Failed to fully duplicate track:", error);
        await nativeBridge.removeTrack(newTrackId).catch(() => false);
        set((s) => ({
          tracks: s.tracks.filter((t) => t.id !== newTrackId),
          selectedTrackId: s.selectedTrackId === newTrackId ? sourceTrack.id : s.selectedTrackId,
          selectedTrackIds: s.selectedTrackIds.filter((id) => id !== newTrackId),
          lastSelectedTrackId: s.lastSelectedTrackId === newTrackId ? sourceTrack.id : s.lastSelectedTrackId,
        }));
        toastBridgeError("Duplicate track")(
          error instanceof Error ? error : new Error("Failed to duplicate track"),
        );
      }
    },

    removeTrack: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      // Capture full track data and its index for undo
      const trackSnapshot = JSON.parse(JSON.stringify(track)) as Track;
      const trackIndex = state.tracks.findIndex((t) => t.id === id);

      const command: Command = {
        type: "REMOVE_TRACK",
        description: `Remove track "${track.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          await clearTrackBoundUiBeforeRemoval(get(), id, trackSnapshot);

          // Clear clips from backend playback engine
          for (const clip of trackSnapshot.clips) {
            if (clip.filePath) {
              await nativeBridge.removePlaybackClip(id, clip.filePath).catch(() => {});
            }
          }
          await nativeBridge.removeTrack(id).catch(() => {});
          set((s) => ({
            tracks: s.tracks.filter((t) => t.id !== id),
            selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
            selectedTrackIds: s.selectedTrackIds.filter((trackId) => trackId !== id),
            lastSelectedTrackId: s.lastSelectedTrackId === id ? null : s.lastSelectedTrackId,
            selectedClipId: s.selectedClipId && collectTrackClipIds(trackSnapshot).has(s.selectedClipId) ? null : s.selectedClipId,
            selectedClipIds: s.selectedClipIds.filter((clipId) => !collectTrackClipIds(trackSnapshot).has(clipId)),
            metronomeTrackId: s.metronomeTrackId === id ? null : s.metronomeTrackId,
          }));
        },
        undo: async () => {
          // Re-add track to backend
          await nativeBridge.addTrack(id).catch(() => {});
          // Restore track at original position
          set((s) => {
            const newTracks = [...s.tracks];
            newTracks.splice(Math.min(trackIndex, newTracks.length), 0, trackSnapshot);
            return { tracks: newTracks };
          });
          // Re-add clips to backend
          for (const clip of trackSnapshot.clips) {
            if (clip.filePath) {
              await nativeBridge.addPlaybackClip(
                id, clip.filePath, clip.startTime, clip.duration,
                clip.offset || 0, clip.volumeDB || 0, clip.fadeIn || 0, clip.fadeOut || 0,
                clip.id,
              ).catch(() => {});
            }
          }
          // Restore backend track order
          nativeBridge.reorderTrack(id, trackIndex).catch(() => {});
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateTrack: (id, updates) => {
      set((state) => ({
        tracks: state.tracks.map((t) => {
          if (t.id === id) {
            // If color is being updated, also update all clips to match
            const updatedTrack = { ...t, ...updates };
            if (updates.color) {
              updatedTrack.clips = t.clips.map((clip) => ({
                ...clip,
                color: updates.color!,
              }));
            }
            return updatedTrack;
          }
          return t;
        }),
      }));
    },

    setTrackNotes: (trackId, notes) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const oldNotes = track.notes || "";
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, notes } : t,
        ),
      }));
      const command: Command = {
        type: "UPDATE_TRACK",
        description: `Set track notes on "${track.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, notes } : t,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, notes: oldNotes } : t,
            ),
          }));
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reorderTrack: (activeId, overId) => {
      const state = get();
      const oldIndex = state.tracks.findIndex((t) => t.id === activeId);
      const newIndex = state.tracks.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const command: Command = {
        type: "REORDER_TRACK",
        description: "Reorder track",
        timestamp: Date.now(),
        execute: () => {
          set((s) => {
            const oi = s.tracks.findIndex((t) => t.id === activeId);
            const ni = s.tracks.findIndex((t) => t.id === overId);
            if (oi === -1 || ni === -1) return s;
            const newTracks = [...s.tracks];
            const [moved] = newTracks.splice(oi, 1);
            newTracks.splice(ni, 0, moved);
            nativeBridge.reorderTrack(activeId, ni);
            return { tracks: newTracks };
          });
        },
        undo: () => {
          set((s) => {
            const ci = s.tracks.findIndex((t) => t.id === activeId);
            if (ci === -1) return s;
            const newTracks = [...s.tracks];
            const [moved] = newTracks.splice(ci, 1);
            newTracks.splice(Math.min(oldIndex, newTracks.length), 0, moved);
            nativeBridge.reorderTrack(activeId, oldIndex);
            return { tracks: newTracks };
          });
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reorderMultipleTracks: (trackIds, overId) => {
      set((state) => {
        // Find the target position (where the drop target is)
        const overIndex = state.tracks.findIndex((t) => t.id === overId);
        if (overIndex === -1) return state;

        // Extract selected tracks in their original relative order
        const selectedTracks = state.tracks.filter((t) => trackIds.includes(t.id));
        const remainingTracks = state.tracks.filter((t) => !trackIds.includes(t.id));

        // Find where to insert in the remaining array
        let insertIndex = remainingTracks.findIndex((t) => t.id === overId);
        if (insertIndex === -1) {
          // overId was a selected track — insert at the original position
          insertIndex = Math.min(overIndex, remainingTracks.length);
        } else {
          // Determine drag direction: if first selected was above over target, we're moving down
          const firstSelectedIndex = state.tracks.findIndex((t) => trackIds.includes(t.id));
          if (firstSelectedIndex < overIndex) {
            insertIndex++; // Insert AFTER the over item when moving down
          }
        }

        // Insert all selected tracks at the target position
        const newTracks = [...remainingTracks];
        newTracks.splice(insertIndex, 0, ...selectedTracks);

        // Sync backend for each moved track
        newTracks.forEach((track, i) => {
          nativeBridge.reorderTrack(track.id, i);
        });

        return { tracks: newTracks };
      });
    },

    selectTrack: (id, modifiers) => {
      if (id === null) {
        // Deselect all
        set({
          selectedTrackId: null,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
        });
        return;
      }

      const state = get();
      const { shift, ctrl } = modifiers || {};

      if (shift && state.lastSelectedTrackId) {
        // Range selection: select all tracks between lastSelectedTrackId and id
        const trackIds = state.tracks.map((t) => t.id);
        const lastIndex = trackIds.indexOf(state.lastSelectedTrackId);
        const currentIndex = trackIds.indexOf(id);
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeIds = trackIds.slice(start, end + 1);
          // Merge with existing selection
          const newSelection = [
            ...new Set([...state.selectedTrackIds, ...rangeIds]),
          ];
          set({ selectedTrackIds: newSelection, selectedTrackId: id });
        }
      } else if (ctrl) {
        // Toggle selection: add or remove from selection
        const isSelected = state.selectedTrackIds.includes(id);
        if (isSelected) {
          const newSelection = state.selectedTrackIds.filter(
            (tid) => tid !== id,
          );
          set({
            selectedTrackIds: newSelection,
            selectedTrackId:
              newSelection.length > 0
                ? newSelection[newSelection.length - 1]
                : null,
            lastSelectedTrackId: id,
          });
        } else {
          set({
            selectedTrackIds: [...state.selectedTrackIds, id],
            selectedTrackId: id,
            lastSelectedTrackId: id,
          });
        }
      } else {
        // Single selection: replace selection with this track + all linked group members
        const linkedIds = getLinkedTrackIds(id, state.trackGroups);
        set({
          selectedTrackId: id,
          selectedTrackIds: linkedIds,
          lastSelectedTrackId: id,
        });
      }
    },

    selectAllTracks: () => {
      const state = get();
      const allIds = state.tracks.map((t) => t.id);
      set({
        selectedTrackIds: allIds,
        selectedTrackId: allIds.length > 0 ? allIds[0] : null,
      });
    },

    deselectAllTracks: () => {
      set({
        selectedTrackId: null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    deleteSelectedTracks: async () => {
      const state = get();
      const { selectedTrackIds, removeTrack } = state;

      // Delete all selected tracks (removeTrack handles backend sync)
      for (const trackId of selectedTrackIds) {
        await removeTrack(trackId);
      }

      // Clear selection after deletion
      set({
        selectedTrackId: null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    // ========== Track Audio Controls ==========
    setTrackVolume: async (id, volumeDB) => {
      if (_linkingInProgress.has("vol_" + id)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, get().trackGroups, "volume");
      const linear = Math.pow(10, volumeDB / 20);

      // Batch update all linked tracks in a single set()
      set((state) => ({
        tracks: state.tracks.map((t) =>
          linkedIds.includes(t.id) ? { ...t, volumeDB, volume: Math.min(1, linear) } : t,
        ),
      }));

      // Bridge calls for each linked track
      for (const tid of linkedIds) {
        _linkingInProgress.add("vol_" + tid);
        nativeBridge.setTrackVolume(tid, volumeDB);
      }
      for (const tid of linkedIds) _linkingInProgress.delete("vol_" + tid);

      // Auto-record automation: write points when playing + lane armed + mode is write/touch/latch
      if (get().transport.isPlaying) {
        const freshTrack = get().tracks.find((t) => t.id === id);
        const volLane = freshTrack?.automationLanes.find((l) => l.param === "volume");
        if (volLane && volLane.armed && (volLane.mode === "write" || volLane.mode === "touch" || volLane.mode === "latch")) {
          const now = Date.now();
          const key = `${id}_volume`;
          const lastRecorded = _autoRecordTimers.get(key) ?? 0;
          if (now - lastRecorded >= AUTO_RECORD_INTERVAL_MS) {
            _autoRecordTimers.set(key, now);
            const normalizedValue = Math.max(0, Math.min(1, (volumeDB + 60) / 66));
            get().addAutomationPoint(id, volLane.id, get().transport.currentTime, normalizedValue);
          }
        }
      }
    },

    setTrackPan: async (id, pan) => {
      if (_linkingInProgress.has("pan_" + id)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, get().trackGroups, "pan");

      set((state) => ({
        tracks: state.tracks.map((t) => (linkedIds.includes(t.id) ? { ...t, pan } : t)),
      }));

      for (const tid of linkedIds) {
        _linkingInProgress.add("pan_" + tid);
        nativeBridge.setTrackPan(tid, pan);
      }
      for (const tid of linkedIds) _linkingInProgress.delete("pan_" + tid);

      // Auto-record automation: write points when playing + lane armed + mode is write/touch/latch
      if (get().transport.isPlaying) {
        const freshTrack = get().tracks.find((t) => t.id === id);
        const panLane = freshTrack?.automationLanes.find((l) => l.param === "pan");
        if (panLane && panLane.armed && (panLane.mode === "write" || panLane.mode === "touch" || panLane.mode === "latch")) {
          const now = Date.now();
          const key = `${id}_pan`;
          const lastRecorded = _autoRecordTimers.get(key) ?? 0;
          if (now - lastRecorded >= AUTO_RECORD_INTERVAL_MS) {
            _autoRecordTimers.set(key, now);
            const normalizedValue = Math.max(0, Math.min(1, (pan + 1) / 2));
            get().addAutomationPoint(id, panLane.id, get().transport.currentTime, normalizedValue);
          }
        }
      }
    },

    toggleTrackMute: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "mute");
      const newMuted = !track.muted;
      // Capture old states for undo
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldStates.set(tid, t.muted);
      }

      const command: Command = {
        type: "TOGGLE_TRACK_MUTE",
        description: newMuted ? "Mute track(s)" : "Unmute track(s)",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              linkedIds.includes(t.id) ? { ...t, muted: newMuted } : t,
            ),
          }));
          for (const tid of linkedIds) nativeBridge.setTrackMute(tid, newMuted);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldStates.get(t.id);
              return old !== undefined ? { ...t, muted: old } : t;
            }),
          }));
          for (const [tid, val] of oldStates) nativeBridge.setTrackMute(tid, val);
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackSolo: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "solo");
      const newSoloed = !track.soloed;
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldStates.set(tid, t.soloed);
      }

      const command: Command = {
        type: "TOGGLE_TRACK_SOLO",
        description: newSoloed ? "Solo track(s)" : "Unsolo track(s)",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              linkedIds.includes(t.id) ? { ...t, soloed: newSoloed } : t,
            ),
          }));
          for (const tid of linkedIds) nativeBridge.setTrackSolo(tid, newSoloed);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldStates.get(t.id);
              return old !== undefined ? { ...t, soloed: old } : t;
            }),
          }));
          for (const [tid, val] of oldStates) nativeBridge.setTrackSolo(tid, val);
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackArmed: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      // Record-safe: prevent arming
      if (track.recordSafe && !track.armed) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "armed");
      const newArmed = !track.armed;

      // Filter out record-safe tracks from linked set when trying to arm
      const effectiveIds = newArmed
        ? linkedIds.filter((tid) => !state.tracks.find((t) => t.id === tid)?.recordSafe)
        : linkedIds;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          effectiveIds.includes(t.id) ? { ...t, armed: newArmed } : t,
        ),
      }));

      for (const tid of effectiveIds) await nativeBridge.setTrackRecordArm(tid, newArmed);
    },

    toggleTrackFXBypass: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "fxBypass");
      const newBypassed = !track.fxBypassed;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          linkedIds.includes(t.id) ? { ...t, fxBypassed: newBypassed } : t,
        ),
      }));

      // Bypass/unbypass all FX on all linked tracks
      for (const tid of linkedIds) {
        const linkedTrack = state.tracks.find((t) => t.id === tid);
        if (!linkedTrack) continue;
        for (let i = 0; i < linkedTrack.inputFxCount; i++)
          await nativeBridge.bypassTrackInputFX(tid, i, newBypassed);
        for (let i = 0; i < linkedTrack.trackFxCount; i++)
          await nativeBridge.bypassTrackFX(tid, i, newBypassed);
      }
    },

    toggleTrackMonitor: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const newMonitor = !track.monitorEnabled;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, monitorEnabled: newMonitor } : t,
        ),
      }));

      await nativeBridge.setTrackInputMonitoring(id, newMonitor);
    },

    setTrackInput: async (id, startChannel, channelCount) => {
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === id
            ? {
                ...t,
                inputStartChannel: startChannel,
                inputChannelCount: channelCount,
              }
            : t,
        ),
      }));

      await nativeBridge.setTrackInputChannels(id, startChannel, channelCount);
    },

    // ========== Continuous Edit Begin/Commit (for undo/redo of fader drags) ==========
    beginTrackVolumeEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "volume");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) _editSnapshots.set("vol_" + tid, t.volumeDB);
        // Signal touch begin to backend for touch/latch automation
        const volLane = t?.automationLanes.find((l) => l.param === "volume");
        if (volLane && volLane.armed && (volLane.mode === "touch" || volLane.mode === "latch")) {
          nativeBridge.beginTouchAutomation(tid, "volume");
        }
      }
    },
    commitTrackVolumeEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "volume");

      // Collect old/new values for all linked tracks
      const changes: Array<{ tid: string; oldVal: number; newVal: number }> = [];
      for (const tid of linkedIds) {
        const key = "vol_" + tid;
        const oldVal = _editSnapshots.get(key);
        _editSnapshots.delete(key);
        if (oldVal === undefined) continue;
        const t = state.tracks.find((tr) => tr.id === tid);
        if (!t || t.volumeDB === oldVal) continue;
        changes.push({ tid, oldVal, newVal: t.volumeDB });
      }
      if (changes.length === 0) return;

      const command: Command = {
        type: "SET_TRACK_VOLUME",
        description: "Adjust track volume",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, volumeDB: c.newVal, volume: Math.min(1, Math.pow(10, c.newVal / 20)) } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackVolume(c.tid, c.newVal);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, volumeDB: c.oldVal, volume: Math.min(1, Math.pow(10, c.oldVal / 20)) } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackVolume(c.tid, c.oldVal);
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      // Signal touch end to backend + clear throttle timers for touch/latch automation
      for (const c of changes) {
        const t = get().tracks.find((tr) => tr.id === c.tid);
        const volLane = t?.automationLanes.find((l) => l.param === "volume");
        if (volLane && volLane.armed && (volLane.mode === "touch" || volLane.mode === "latch")) {
          nativeBridge.endTouchAutomation(c.tid, "volume");
          _autoRecordTimers.delete(`${c.tid}_volume`);
        }
      }
    },
    beginTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) _editSnapshots.set("pan_" + tid, t.pan);
        // Signal touch begin to backend for touch/latch automation
        const panLane = t?.automationLanes.find((l) => l.param === "pan");
        if (panLane && panLane.armed && (panLane.mode === "touch" || panLane.mode === "latch")) {
          nativeBridge.beginTouchAutomation(tid, "pan");
        }
      }
    },
    commitTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");

      const changes: Array<{ tid: string; oldVal: number; newVal: number }> = [];
      for (const tid of linkedIds) {
        const key = "pan_" + tid;
        const oldVal = _editSnapshots.get(key);
        _editSnapshots.delete(key);
        if (oldVal === undefined) continue;
        const t = state.tracks.find((tr) => tr.id === tid);
        if (!t || t.pan === oldVal) continue;
        changes.push({ tid, oldVal, newVal: t.pan });
      }
      if (changes.length === 0) return;

      const command: Command = {
        type: "SET_TRACK_PAN",
        description: "Adjust track pan",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, pan: c.newVal } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackPan(c.tid, c.newVal);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, pan: c.oldVal } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackPan(c.tid, c.oldVal);
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      // Signal touch end to backend + clear throttle timers for touch/latch automation
      for (const c of changes) {
        const t = get().tracks.find((tr) => tr.id === c.tid);
        const panLane = t?.automationLanes.find((l) => l.param === "pan");
        if (panLane && panLane.armed && (panLane.mode === "touch" || panLane.mode === "latch")) {
          nativeBridge.endTouchAutomation(c.tid, "pan");
          _autoRecordTimers.delete(`${c.tid}_pan`);
        }
      }
    },
    beginClipVolumeEdit: (clipId) => {
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { _editSnapshots.set("clipVol_" + clipId, clip.volumeDB); break; }
      }
    },
    commitClipVolumeEdit: (clipId) => {
      const key = "clipVol_" + clipId;
      const oldValue = _editSnapshots.get(key);
      _editSnapshots.delete(key);
      if (oldValue === undefined) return;
      let newValue = oldValue;
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { newValue = clip.volumeDB; break; }
      }
      if (newValue === oldValue) return;
      const command: Command = {
        type: "SET_CLIP_VOLUME",
        description: "Adjust clip volume",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, volumeDB: newValue } : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, volumeDB: oldValue } : clip,
              ),
            })),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

});
