// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { syncAutomationLaneToBackend } from "./storeHelpers";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

function buildMasterAutomationSuspendSnapshot(state: any) {
  return {
    showAutomation: state.showMasterAutomation,
    lanes: Object.fromEntries(
      state.masterAutomationLanes.map((lane: any) => [
        lane.id,
        { visible: lane.visible, armed: lane.armed, mode: lane.mode },
      ]),
    ),
  };
}

export const mixerActions = (set: SetFn, get: GetFn) => ({
    setMasterVolume: async (volume) => {
      set({ masterVolume: volume });
      await nativeBridge.setMasterVolume(volume);
    },

    setMasterPan: async (pan: number) => {
      set({ masterPan: pan });
      await nativeBridge.setMasterPan(pan);
    },

    toggleMasterMute: () => {
      const current = get().isMasterMuted;
      set({ isMasterMuted: !current });
      // When muted, send 0 to backend; when unmuted, restore volume
      nativeBridge.setMasterVolume(!current ? 0 : get().masterVolume);
    },
    toggleMasterMono: () => {
      const next = !get().masterMono;
      set({ masterMono: next });
      nativeBridge.setMasterMono(next).catch(() => {});
    },
    toggleMasterAutomation: () => set((s) => ({ showMasterAutomation: !s.showMasterAutomation })),
    toggleMasterAutomationEnabled: () => {
      const state = get();
      if (state.masterAutomationEnabled) {
        const snapshot = buildMasterAutomationSuspendSnapshot(state);
        set((s) => ({
          masterAutomationEnabled: false,
          showMasterAutomation: false,
          suspendedMasterAutomationState: snapshot,
          masterAutomationLanes: s.masterAutomationLanes.map((lane) => ({
            ...lane,
            visible: false,
            armed: false,
            mode: "off",
          })),
        }));
        for (const lane of state.masterAutomationLanes) {
          nativeBridge.setAutomationMode("master", lane.param, "off").catch(() => {});
        }
        nativeBridge.setMasterVolume(state.masterVolume).catch(() => {});
        nativeBridge.setMasterPan(state.masterPan).catch(() => {});
        return;
      }

      const snapshot = state.suspendedMasterAutomationState;
      const restoredLanes = state.masterAutomationLanes.map((lane) => {
        const saved = snapshot?.lanes?.[lane.id];
        return {
          ...lane,
          visible: saved?.visible ?? lane.visible,
          armed: saved?.armed ?? lane.armed,
          mode: saved?.mode ?? (lane.mode === "off" ? "read" : lane.mode),
        };
      });
      set({
        masterAutomationEnabled: true,
        showMasterAutomation: snapshot?.showAutomation ?? state.showMasterAutomation,
        suspendedMasterAutomationState: null,
        masterAutomationLanes: restoredLanes,
      });
      for (const lane of restoredLanes) {
        syncAutomationLaneToBackend("master", lane);
      }
    },
    addMasterAutomationLane: (param) => {
      const existing = get().masterAutomationLanes.find((l) => l.param === param);
      if (existing) {
        set((s) => ({
          showMasterAutomation: true,
          masterAutomationLanes: s.masterAutomationLanes.map((l) =>
            l.param === param ? { ...l, visible: true } : l,
          ),
        }));
        return existing.id;
      }
      const newId = `master-${param}`;
      set((s) => ({
        showMasterAutomation: true,
        masterAutomationLanes: [
          ...s.masterAutomationLanes,
          { id: newId, param, points: [], visible: true, mode: "read" as AutomationModeType, armed: false },
        ],
      }));
      return newId;
    },
    toggleMasterAutomationLaneVisibility: (laneId) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, visible: !l.visible } : l,
        ),
      }));
    },
    setMasterAutomationLaneMode: (laneId, mode) => {
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) {
        nativeBridge.setAutomationMode("master", lane.param, mode).catch(() => {});
      }
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, mode } : l,
        ),
      }));
    },
    armMasterAutomationLane: (laneId, armed) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, armed } : l,
        ),
      }));
    },
    setMasterTrackAutomationMode: (mode) => {
      const lanes = get().masterAutomationLanes;
      for (const lane of lanes) {
        nativeBridge.setAutomationMode("master", lane.param, mode).catch(() => {});
      }
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, mode })),
      }));
    },
    showAllActiveMasterEnvelopes: () => {
      set((s) => ({
        showMasterAutomation: true,
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.points.length > 0 ? { ...l, visible: true } : l,
        ),
      }));
    },
    hideAllMasterEnvelopes: () => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, visible: false })),
      }));
    },
    armAllVisibleMasterAutomationLanes: () => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.visible ? { ...l, armed: true } : l,
        ),
      }));
    },
    disarmAllMasterAutomationLanes: () => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, armed: false })),
      }));
    },
    addMasterAutomationPoint: (laneId, time, value) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          const newPoints = [...lane.points, { time, value: Math.max(0, Math.min(1, value)) }];
          newPoints.sort((a, b) => a.time - b.time);
          return { ...lane, points: newPoints };
        }),
        isModified: true,
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },
    removeMasterAutomationPoint: (laneId, pointIndex) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          return { ...lane, points: lane.points.filter((_, i) => i !== pointIndex) };
        }),
        isModified: true,
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },
    moveMasterAutomationPoint: (laneId, pointIndex, time, value) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          const newPoints = lane.points.map((p, i) =>
            i === pointIndex ? { time: Math.max(0, time), value: Math.max(0, Math.min(1, value)) } : p,
          );
          newPoints.sort((a, b) => a.time - b.time);
          return { ...lane, points: newPoints };
        }),
        isModified: true,
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },

});
