// @ts-nocheck
/**
 * Timeline view actions - zoom, scroll, track height, TCP width, snap, grid, tool mode.
 * Extracted from useDAWStore.ts for modularity.
 */

import { getMinimumVisibleTrackHeight } from "../useDAWStore";
import {
  calculateGridInterval,
  FACTORY_QUANTIZE_PRESETS,
  getQuantizePresetById,
  ticksToSeconds,
} from "../../utils/snapToGrid";

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
  setSnapType: (type) => set({ snapType: type }),
  setQuantizePresetId: (presetId) => set((state) => {
    const preset = getQuantizePresetById(state.quantizePresets, presetId);
    const tempo = state.transport?.tempo ?? 120;
    return {
      quantizePresetId: preset.id,
      gridSize: state.gridSize === "use_quantize" ? "use_quantize" : state.gridSize,
      lastMIDIQuantizeSettings: {
        presetId: preset.id,
        gridSize: preset.gridSize,
        gridSeconds: calculateGridInterval(
          tempo,
          state.timeSignature ?? { numerator: 4, denominator: 4 },
          preset.gridSize,
          {
            quantizePreset: preset,
            quantizeGridSize: preset.gridSize,
            pixelsPerSecond: state.pixelsPerSecond,
          },
        ),
        strength: preset.strength,
        mode: "start",
        swing: preset.swing,
        groovePreset: preset.groovePreset,
        tupletDivisions: preset.tupletDivisions,
        catchRangeMs: ticksToSeconds(preset.catchRangeTicks, tempo) * 1000,
        safeRangeMs: ticksToSeconds(preset.safeRangeTicks, tempo) * 1000,
        randomizeMs: ticksToSeconds(preset.roughTicks, tempo) * 1000,
        moveControllers: preset.moveControllers,
      },
    };
  }),
  saveQuantizePreset: (name, preset = {}) => {
    const state = get();
    const selected = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
    const idBase = String(name || "Custom Quantize")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      || "custom-quantize";
    const existingIds = new Set((state.quantizePresets || []).map((candidate) => candidate.id));
    let id = `custom-${idBase}`;
    let index = 2;
    while (existingIds.has(id)) {
      id = `custom-${idBase}-${index}`;
      index += 1;
    }

    const nextPreset = {
      ...selected,
      ...preset,
      id,
      name: String(name || selected.name || "Custom Quantize").trim() || "Custom Quantize",
      isFactory: false,
    };

    set((current) => ({
      quantizePresets: [...(current.quantizePresets || FACTORY_QUANTIZE_PRESETS), nextPreset],
      quantizePresetId: id,
      isModified: true,
    }));
    return id;
  },
  renameQuantizePreset: (presetId, name) => set((state) => ({
    quantizePresets: (state.quantizePresets || FACTORY_QUANTIZE_PRESETS).map((preset) =>
      preset.id === presetId && !preset.isFactory
        ? { ...preset, name: String(name || preset.name).trim() || preset.name }
        : preset,
    ),
    isModified: true,
  })),
  removeQuantizePreset: (presetId) => set((state) => {
    const presets = state.quantizePresets || FACTORY_QUANTIZE_PRESETS;
    const target = presets.find((preset) => preset.id === presetId);
    if (!target || target.isFactory) return {};
    const nextPresets = presets.filter((preset) => preset.id !== presetId);
    return {
      quantizePresets: nextPresets,
      quantizePresetId: state.quantizePresetId === presetId ? "factory-1/16" : state.quantizePresetId,
      isModified: true,
    };
  }),
  restoreFactoryQuantizePresets: () => set({
    quantizePresets: [...FACTORY_QUANTIZE_PRESETS],
    quantizePresetId: "factory-1/16",
    isModified: true,
  }),

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
