import { commandManager } from "../commands";
import type { Marker, Region, TempoMarker } from "../useDAWStore";
import { syncTempoMarkersToBackend } from "./storeHelpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const markerActions = (set: SetFn, get: GetFn) => ({
    addMarker: (time: number, name?: string) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers || !Number.isFinite(time)) return;
      const marker: Marker = {
        id: crypto.randomUUID(),
        time: Math.max(0, time),
        name: typeof name === "string" && name.trim()
          ? name.trim()
          : `Marker ${state.markers.length + 1}`,
        color: "#60a5fa",
      };
      const before = [...state.markers];
      const after = [...before, marker];
      const apply = (markers: Marker[]) => set({ markers, isModified: true });
      commandManager.execute({
        type: "ADD_MARKER",
        description: `Add marker "${marker.name}"`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeMarker: (id: string) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers) return;
      const marker = state.markers.find((candidate: Marker) => candidate.id === id);
      if (!marker) return;
      const before = [...state.markers];
      const after = before.filter((candidate) => candidate.id !== id);
      const apply = (markers: Marker[]) => set({ markers, isModified: true });
      commandManager.execute({
        type: "REMOVE_MARKER",
        description: `Remove marker "${marker.name}"`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateMarker: (id: string, updates: Partial<Omit<Marker, "id">>) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers) return;
      const marker = state.markers.find((candidate: Marker) => candidate.id === id);
      if (!marker) return;
      if (updates.time !== undefined && !Number.isFinite(updates.time)) return;
      const nextMarker = {
        ...marker,
        ...updates,
        id: marker.id,
        time: updates.time === undefined ? marker.time : Math.max(0, updates.time),
      };
      if (JSON.stringify(nextMarker) === JSON.stringify(marker)) return;
      const before = [...state.markers];
      const after = before.map((candidate) => candidate.id === id ? nextMarker : candidate);
      const apply = (markers: Marker[]) => set({ markers, isModified: true });
      commandManager.execute({
        type: "UPDATE_MARKER",
        description: `Update marker "${marker.name}"`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    addRegion: (start: number, end: number, name?: string) => {
      const state = get();
      if (
        state.globalLocked
        || state.lockSettings?.markers
        || !Number.isFinite(start)
        || !Number.isFinite(end)
        || Math.abs(end - start) <= 0.000001
      ) return;
      const region: Region = {
        id: crypto.randomUUID(),
        name: typeof name === "string" && name.trim()
          ? name.trim()
          : `Region ${state.regions.length + 1}`,
        startTime: Math.max(0, Math.min(start, end)),
        endTime: Math.max(0, Math.max(start, end)),
        color: "#8b5cf6",
      };
      if (region.endTime - region.startTime <= 0.000001) return;
      const before = [...state.regions];
      const after = [...before, region];
      const apply = (regions: Region[]) => set({ regions, isModified: true });
      commandManager.execute({
        type: "ADD_REGION",
        description: `Add region "${region.name}"`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeRegion: (id: string) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers) return;
      const region = state.regions.find((candidate: Region) => candidate.id === id);
      if (!region) return;
      const before = [...state.regions];
      const after = before.filter((candidate) => candidate.id !== id);
      const apply = (regions: Region[]) => set({ regions, isModified: true });
      commandManager.execute({
        type: "REMOVE_REGION",
        description: `Remove region "${region.name}"`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateRegion: (id: string, updates: Partial<Omit<Region, "id">>) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers) return;
      const region = state.regions.find((candidate: Region) => candidate.id === id);
      if (!region) return;
      if (
        (updates.startTime !== undefined && !Number.isFinite(updates.startTime))
        || (updates.endTime !== undefined && !Number.isFinite(updates.endTime))
      ) return;
      const requestedStart = Math.max(0, updates.startTime ?? region.startTime);
      const requestedEnd = Math.max(0, updates.endTime ?? region.endTime);
      const nextRegion = {
        ...region,
        ...updates,
        id: region.id,
        startTime: Math.min(requestedStart, requestedEnd),
        endTime: Math.max(requestedStart, requestedEnd),
      };
      if (
        nextRegion.endTime - nextRegion.startTime <= 0.000001
        || JSON.stringify(nextRegion) === JSON.stringify(region)
      ) return;
      const before = [...state.regions];
      const after = before.map((candidate) => candidate.id === id ? nextRegion : candidate);
      const apply = (regions: Region[]) => set({ regions, isModified: true });
      commandManager.execute({
        type: "UPDATE_REGION",
        description: `Update region "${region.name}"`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Tempo Map ==========
    addTempoMarker: (time: number, tempo: number) => {
      const state = get();
      if (state.globalLocked
          || state.lockSettings?.markers
          || !Number.isFinite(time)
          || !Number.isFinite(tempo)) return;
      const marker: TempoMarker = {
        id: crypto.randomUUID(),
        time: Math.max(0, time),
        tempo: Math.max(10, Math.min(300, tempo)),
      };
      const before = state.tempoMarkers.map((candidate: TempoMarker) => ({ ...candidate }));
      const after = [...before, marker].sort((a, b) => a.time - b.time);
      const apply = (tempoMarkers: TempoMarker[]) => {
        const snapshot = tempoMarkers.map((candidate) => ({ ...candidate }));
        set({ tempoMarkers: snapshot, isModified: true });
        syncTempoMarkersToBackend(snapshot);
      };
      commandManager.execute({
        type: "ADD_TEMPO_MARKER",
        description: `Add tempo marker at ${marker.time}`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeTempoMarker: (id: string) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers) return;
      const existing = state.tempoMarkers.find((marker: TempoMarker) => marker.id === id);
      if (!existing) return;
      const before = state.tempoMarkers.map((marker: TempoMarker) => ({ ...marker }));
      const after = before.filter((marker: TempoMarker) => marker.id !== id);
      const apply = (tempoMarkers: TempoMarker[]) => {
        const snapshot = tempoMarkers.map((marker) => ({ ...marker }));
        set({ tempoMarkers: snapshot, isModified: true });
        syncTempoMarkersToBackend(snapshot);
      };
      commandManager.execute({
        type: "REMOVE_TEMPO_MARKER",
        description: `Remove tempo marker at ${existing.time}`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateTempoMarker: (id: string, updates: Partial<Omit<TempoMarker, "id">>) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.markers) return;
      const existing = state.tempoMarkers.find((marker: TempoMarker) => marker.id === id);
      if (!existing
          || (updates.time !== undefined && !Number.isFinite(updates.time))
          || (updates.tempo !== undefined && !Number.isFinite(updates.tempo))) return;
      const updated: TempoMarker = {
        ...existing,
        ...updates,
        id: existing.id,
        time: Math.max(0, updates.time ?? existing.time),
        tempo: Math.max(10, Math.min(300, updates.tempo ?? existing.tempo)),
      };
      if (updated.time === existing.time && updated.tempo === existing.tempo) return;
      const before = state.tempoMarkers.map((marker: TempoMarker) => ({ ...marker }));
      const after = before
        .map((marker: TempoMarker) => marker.id === id ? updated : marker)
        .sort((a: TempoMarker, b: TempoMarker) => a.time - b.time);
      const apply = (tempoMarkers: TempoMarker[]) => {
        const snapshot = tempoMarkers.map((marker) => ({ ...marker }));
        set({ tempoMarkers: snapshot, isModified: true });
        syncTempoMarkersToBackend(snapshot);
      };
      commandManager.execute({
        type: "UPDATE_TEMPO_MARKER",
        description: `Update tempo marker at ${existing.time}`,
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    getTempoAtTime: (time: number) => {
      const { tempoMarkers, transport } = get();
      if (tempoMarkers.length === 0) return transport.tempo;
      // Find the last tempo marker before or at the given time
      let activeTempo = transport.tempo;
      for (const marker of tempoMarkers) {
        if (marker.time <= time) {
          activeTempo = marker.tempo;
        } else {
          break;
        }
      }
      return activeTempo;
    },

    // ========== UI State ==========
});
