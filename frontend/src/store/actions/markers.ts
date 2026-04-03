// @ts-nocheck
import { commandManager } from "../commands";
import { syncTempoMarkersToBackend } from "./storeHelpers";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const markerActions = (set: SetFn, get: GetFn) => ({
    addMarker: (time, name) => {
      const marker: Marker = {
        id: crypto.randomUUID(),
        time,
        name: name || `Marker ${get().markers.length + 1}`,
        color: "#60a5fa",
      };
      set((state) => ({
        markers: [...state.markers, marker],
      }));
    },

    removeMarker: (id) => {
      set((state) => ({
        markers: state.markers.filter((m) => m.id !== id),
      }));
    },

    updateMarker: (id, updates) => {
      set((state) => ({
        markers: state.markers.map((m) =>
          m.id === id ? { ...m, ...updates } : m
        ),
      }));
    },

    addRegion: (start, end, name) => {
      const region: Region = {
        id: crypto.randomUUID(),
        name: name || `Region ${get().regions.length + 1}`,
        startTime: Math.min(start, end),
        endTime: Math.max(start, end),
        color: "#8b5cf6",
      };
      set((state) => ({
        regions: [...state.regions, region],
      }));
    },

    removeRegion: (id) => {
      set((state) => ({
        regions: state.regions.filter((r) => r.id !== id),
      }));
    },

    updateRegion: (id, updates) => {
      set((state) => ({
        regions: state.regions.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      }));
    },

    // ========== Tempo Map ==========
    addTempoMarker: (time, tempo) => {
      const marker: TempoMarker = {
        id: crypto.randomUUID(),
        time,
        tempo: Math.max(10, Math.min(300, tempo)),
      };
      set((state) => ({
        tempoMarkers: [...state.tempoMarkers, marker].sort((a, b) => a.time - b.time),
        isModified: true,
      }));
      syncTempoMarkersToBackend(get().tempoMarkers);
    },

    removeTempoMarker: (id) => {
      set((state) => ({
        tempoMarkers: state.tempoMarkers.filter((m) => m.id !== id),
        isModified: true,
      }));
      syncTempoMarkersToBackend(get().tempoMarkers);
    },

    updateTempoMarker: (id, updates) => {
      set((state) => ({
        tempoMarkers: state.tempoMarkers
          .map((m) => (m.id === id ? { ...m, ...updates } : m))
          .sort((a, b) => a.time - b.time),
        isModified: true,
      }));
      syncTempoMarkersToBackend(get().tempoMarkers);
    },

    getTempoAtTime: (time) => {
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
