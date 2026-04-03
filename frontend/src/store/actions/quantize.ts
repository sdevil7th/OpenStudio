// @ts-nocheck
import { calculateGridInterval } from "../../utils/snapToGrid";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const quantizeActions = (set: SetFn, get: GetFn) => ({
    quantizeSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;
      const gridInterval = calculateGridInterval(
        state.transport.tempo,
        state.timeSignature,
        state.gridSize,
      );

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipPositions.set(clip.id, clip.startTime);
          }
        }
      }

      // Compute new snapped positions
      const snappedPositions = new Map<string, number>();
      for (const [id, time] of clipPositions) {
        snappedPositions.set(id, Math.round(time / gridInterval) * gridInterval);
      }

      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            const snapped = snappedPositions.get(c.id);
            return snapped !== undefined ? { ...c, startTime: snapped } : c;
          }),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "QUANTIZE_CLIPS",
        description: "Quantize clips to grid",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                const snapped = snappedPositions.get(c.id);
                return snapped !== undefined ? { ...c, startTime: snapped } : c;
              }),
            })),
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                const oldTime = clipPositions.get(c.id);
                return oldTime !== undefined ? { ...c, startTime: oldTime } : c;
              }),
            })),
            isModified: true,
          }));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

});
