// @ts-nocheck
/**
 * Timeline view actions - zoom, scroll, track height, TCP width, snap, grid, tool mode.
 * Extracted from useDAWStore.ts for modularity.
 */

import { getMinimumVisibleTrackHeight } from "../useDAWStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const timelineActions = (set: SetFn, get: GetFn) => ({
  setZoom: (pixelsPerSecond) => {
    set({ pixelsPerSecond: Math.max(1, Math.min(1000, pixelsPerSecond)) });
  },

  setScroll: (x, y) => set({ scrollX: x, scrollY: y }),
  setTrackHeight: (height) => {
    const minH = getMinimumVisibleTrackHeight(get().tracks, get().tcpWidth);
    set({ trackHeight: Math.max(minH, Math.min(500, height)) });
  },
  setTcpWidth: (width) => {
    const clamped = Math.max(150, Math.min(600, width));
    const minH = getMinimumVisibleTrackHeight(get().tracks, clamped);
    const curHeight = get().trackHeight;
    // Auto-raise track height if shrinking TCP would clip content
    set({ tcpWidth: clamped, trackHeight: Math.max(minH, curHeight) });
  },

  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  setGridSize: (size) => set({ gridSize: size }),

  // ========== Tool Mode ==========
  setToolMode: (mode) => set({ toolMode: mode }),
  toggleSplitTool: () =>
    set((state) => ({
      toolMode: state.toolMode === "split" ? "select" : "split",
    })),
  toggleMuteTool: () =>
    set((state) => ({
      toolMode: state.toolMode === "mute" ? "select" : "mute",
    })),
});
