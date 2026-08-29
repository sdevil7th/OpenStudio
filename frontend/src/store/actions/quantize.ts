import { calculateGridInterval, getQuantizePresetById } from "../../utils/snapToGrid";
import { isClipEditLocked } from "../../utils/clipEditLock";
import { commandManager } from "../commands";
import type { AudioClip, MIDIClip, Track } from "../useDAWStore";
import {
  cloneTracksForTimelineUndo,
  moveAutomationPointsWithClips,
  syncAutomationTrackSnapshots,
} from "./clipEditing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const quantizeActions = (set: SetFn, get: GetFn) => ({
    quantizeSelectedClips: () => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.items) return false;
      const selectedIds = new Set<string>(
        state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [],
      );
      if (selectedIds.size === 0) return false;
      const quantizePreset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
      const gridInterval = calculateGridInterval(
        state.transport.tempo,
        state.timeSignature,
        state.gridSize,
        {
          quantizePreset,
          quantizeGridSize: quantizePreset.gridSize,
          pixelsPerSecond: state.pixelsPerSecond,
        },
      );
      if (!Number.isFinite(gridInterval) || gridInterval <= 0) return false;

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      const clipMetadata = new Map<string, { trackId: string; duration: number }>();
      const midiTrackIds = new Set<string>();
      let touchesAudio = false;
      for (const track of state.tracks) {
        if (track.frozen) continue;
        for (const clip of track.clips) {
          if (selectedIds.has(clip.id) && !isClipEditLocked(state, clip)) {
            clipPositions.set(clip.id, clip.startTime);
            clipMetadata.set(clip.id, { trackId: track.id, duration: clip.duration });
            touchesAudio = true;
          }
        }
        for (const clip of track.midiClips) {
          if (selectedIds.has(clip.id) && !isClipEditLocked(state, clip)) {
            clipPositions.set(clip.id, clip.startTime);
            clipMetadata.set(clip.id, { trackId: track.id, duration: clip.duration });
            midiTrackIds.add(track.id);
          }
        }
      }
      if (clipPositions.size === 0) return false;

      // Compute new snapped positions
      const snappedPositions = new Map<string, number>();
      for (const [id, time] of clipPositions) {
        snappedPositions.set(id, Math.max(0, Math.round(time / gridInterval) * gridInterval));
      }
      const hasChange = [...snappedPositions].some(
        ([id, snapped]) => Math.abs(snapped - (clipPositions.get(id) ?? snapped)) > 0.000001,
      );
      if (!hasChange) return false;

      const syncTimeline = () => {
        if (touchesAudio) {
          const result = get().syncClipsWithBackend?.();
          if (result?.catch) result.catch(() => {});
        }
        for (const trackId of midiTrackIds) {
          const result = get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          if (result?.catch) result.catch(() => {});
        }
      };
      const cloneTracks = (tracks: Track[]): Track[] => cloneTracksForTimelineUndo(tracks);
      const oldTracks = cloneTracks(state.tracks);
      let newTracks = oldTracks.map((track: Track) => {
            const applyAudio = (clip: AudioClip): AudioClip => {
              const startTime = snappedPositions.get(clip.id);
              return startTime === undefined ? clip : { ...clip, startTime };
            };
            const applyMIDI = (clip: MIDIClip): MIDIClip => {
              const startTime = snappedPositions.get(clip.id);
              return startTime === undefined ? clip : { ...clip, startTime };
            };
            return {
              ...track,
              clips: track.clips.map(applyAudio),
              midiClips: track.midiClips.map(applyMIDI),
            };
          });
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        const moves = [...snappedPositions].flatMap(([clipId, newStartTime]) => {
          const metadata = clipMetadata.get(clipId);
          const originalStartTime = clipPositions.get(clipId);
          return metadata && originalStartTime !== undefined && originalStartTime !== newStartTime
            ? [{
                clipId,
                sourceTrackId: metadata.trackId,
                targetTrackId: metadata.trackId,
                originalStartTime,
                newStartTime,
                duration: metadata.duration,
              }]
            : [];
        });
        newTracks = moveAutomationPointsWithClips(newTracks, moves, oldTracks);
      }
      newTracks = cloneTracks(newTracks);

      const applyTracks = (tracks: Track[]) => {
        const previousTracks = cloneTracks(get().tracks);
        set({
          tracks: cloneTracks(tracks),
          isModified: true,
        });
        syncAutomationTrackSnapshots(previousTracks, tracks);
        syncTimeline();
      };

      commandManager.execute({
        type: "QUANTIZE_CLIPS",
        description: "Quantize clips to grid",
        timestamp: Date.now(),
        execute: () => applyTracks(newTracks),
        undo: () => applyTracks(oldTracks),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

});
