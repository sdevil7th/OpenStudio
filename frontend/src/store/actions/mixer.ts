// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { VOLUME_DB_RANGE, VOLUME_MIN_DB } from "../automationParams";
import { automationLaneReadEnabled, automationWriteBehaviorToBackendMode, syncAutomationLaneToBackend } from "./storeHelpers";

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
        { visible: lane.visible, armed: lane.armed, mode: lane.mode, readEnabled: automationLaneReadEnabled(lane) },
      ]),
    ),
  };
}

function masterReadEnabled(state: any): boolean {
  if (typeof state.masterAutomationReadEnabled === "boolean") return state.masterAutomationReadEnabled;
  if (typeof state.masterAutomationEnabled === "boolean") return state.masterAutomationEnabled;
  return (state.masterAutomationLanes?.length ?? 0) > 0;
}

function masterWriteEnabled(state: any): boolean {
  return state.masterAutomationWriteEnabled === true;
}

function masterLaneMode(state: any, lane: any) {
  if (!masterReadEnabled(state) || !automationLaneReadEnabled(lane)) return "off";
  if (!masterWriteEnabled(state)) return "read";
  const behavior = state.automationWriteBehavior ?? "touch";
  if (behavior === "overwrite") return "read";
  return automationWriteBehaviorToBackendMode(behavior);
}

function syncMasterAutomationModes(state: any) {
  for (const lane of state.masterAutomationLanes || []) {
    syncAutomationLaneToBackend("master", { ...lane, mode: masterLaneMode(state, lane) });
  }
}

function automationTransportRolling(state: any): boolean {
  return Boolean(state?.transport?.isPlaying || state?.transport?.isRecording);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizeMasterVolumeForAutomation(volume: number): number {
  const db = Number.isFinite(volume) && volume > 0 ? 20 * Math.log10(volume) : VOLUME_MIN_DB;
  return clamp01((db - VOLUME_MIN_DB) / VOLUME_DB_RANGE);
}

function normalizeMasterPanForAutomation(pan: number): number {
  return clamp01(((Number.isFinite(pan) ? pan : 0) + 1) / 2);
}

export const mixerActions = (set: SetFn, get: GetFn) => ({
    setMasterVolume: async (volume) => {
      set({ masterVolume: volume });
      const state = get();
      if (state.masterAutomationWriteEnabled && automationTransportRolling(state)) {
        state.setAutomationWriteValue?.("master", "volume", normalizeMasterVolumeForAutomation(volume));
      }
      await nativeBridge.setMasterVolume(volume);
    },

    setMasterPan: async (pan: number) => {
      set({ masterPan: pan });
      const state = get();
      if (state.masterAutomationWriteEnabled && automationTransportRolling(state)) {
        state.setAutomationWriteValue?.("master", "pan", normalizeMasterPanForAutomation(pan));
      }
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
    setMasterAutomationRead: (enabled) => {
      const nextRead = Boolean(enabled);
      const current = get();
      if (current.masterAutomationLanes.length === 0 && !masterWriteEnabled(current)) return;
      set((s) => {
        const nextState = {
          ...s,
          masterAutomationReadEnabled: nextRead,
          masterAutomationEnabled: nextRead,
        };
        return {
          masterAutomationReadEnabled: nextState.masterAutomationReadEnabled,
          masterAutomationEnabled: nextState.masterAutomationEnabled,
          masterAutomationLanes: s.masterAutomationLanes.map((lane) => ({
            ...lane,
            mode: masterLaneMode(nextState, lane),
          })),
        };
      });
      const state = get();
      syncMasterAutomationModes(state);
      if (!nextRead) {
        nativeBridge.setMasterVolume(state.masterVolume).catch(() => {});
        nativeBridge.setMasterPan(state.masterPan).catch(() => {});
      } else {
        get().updateAutomatedValues?.();
      }
    },
    toggleMasterAutomationRead: () => {
      get().setMasterAutomationRead(!masterReadEnabled(get()));
    },
    setMasterAutomationWrite: (enabled) => {
      const nextWrite = Boolean(enabled);
      set((s) => {
        const keepReadOn = masterReadEnabled(s) && s.masterAutomationLanes.length > 0;
        const nextState = {
          ...s,
          masterAutomationReadEnabled: nextWrite ? true : keepReadOn,
          masterAutomationWriteEnabled: nextWrite,
          masterAutomationEnabled: nextWrite ? true : keepReadOn,
        };
        return {
          masterAutomationReadEnabled: nextState.masterAutomationReadEnabled,
          masterAutomationWriteEnabled: nextState.masterAutomationWriteEnabled,
          masterAutomationEnabled: nextState.masterAutomationEnabled,
          masterAutomationLanes: s.masterAutomationLanes.map((lane) => ({
            ...lane,
            mode: masterLaneMode(nextState, lane),
          })),
        };
      });
      syncMasterAutomationModes(get());
    },
    toggleMasterAutomationWrite: () => {
      get().setMasterAutomationWrite(!masterWriteEnabled(get()));
    },
    toggleMasterAutomationEnabled: () => {
      get().toggleMasterAutomationRead();
    },
    addMasterAutomationLane: (param) => {
      const existing = get().masterAutomationLanes.find((l) => l.param === param);
      if (existing) {
        set((s) => {
          const nextState = {
            ...s,
            masterAutomationReadEnabled: true,
            masterAutomationEnabled: true,
          };
          return {
            showMasterAutomation: true,
            masterAutomationReadEnabled: true,
            masterAutomationEnabled: true,
            masterAutomationLanes: s.masterAutomationLanes.map((l) =>
              l.param === param
                ? { ...l, visible: true, readEnabled: true, mode: masterLaneMode(nextState, { ...l, readEnabled: true }) }
                : l,
            ),
          };
        });
        const updated = get().masterAutomationLanes.find((l) => l.id === existing.id);
        if (updated) syncAutomationLaneToBackend("master", updated);
        return existing.id;
      }
      const newId = `master-${param}`;
      let laneToSync: any = null;
      set((s) => {
        const nextState = {
          ...s,
          masterAutomationReadEnabled: true,
          masterAutomationEnabled: true,
        };
        const baseLane = {
          id: newId,
          param,
          points: [],
          visible: true,
          mode: "read",
          armed: false,
          readEnabled: true,
        };
        const nextLane = { ...baseLane, mode: masterLaneMode(nextState, baseLane) };
        laneToSync = nextLane;
        return {
          showMasterAutomation: true,
          masterAutomationReadEnabled: true,
          masterAutomationEnabled: true,
          masterAutomationLanes: [...s.masterAutomationLanes, nextLane],
        };
      });
      if (laneToSync) syncAutomationLaneToBackend("master", laneToSync);
      return newId;
    },
    toggleMasterAutomationLaneVisibility: (laneId) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, visible: !l.visible } : l,
        ),
      }));
    },
    setMasterAutomationLaneRead: (laneId, enabled) => {
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      set((s) => {
        const nextState = {
          ...s,
          masterAutomationLanes: s.masterAutomationLanes.map((l) => (
            l.id === laneId ? { ...l, readEnabled: Boolean(enabled) } : l
          )),
        };
        return {
          masterAutomationLanes: nextState.masterAutomationLanes.map((l) => (
            l.id === laneId ? { ...l, mode: masterLaneMode(nextState, l) } : l
          )),
        };
      });
      const updatedLane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (updatedLane) syncAutomationLaneToBackend("master", updatedLane);
      get().updateAutomatedValues?.();
    },
    toggleMasterAutomationLaneRead: (laneId) => {
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      get().setMasterAutomationLaneRead(laneId, !automationLaneReadEnabled(lane));
    },
    setMasterAutomationLaneMode: (laneId, mode) => {
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        masterAutomationReadEnabled: readEnabled ? true : s.masterAutomationReadEnabled,
        masterAutomationWriteEnabled: shouldWrite ? true : (mode === "read" || mode === "off" ? false : s.masterAutomationWriteEnabled),
        masterAutomationEnabled: readEnabled ? true : s.masterAutomationEnabled,
        masterAutomationLanes: s.masterAutomationLanes.map((l) => {
          if (l.id !== laneId) return l;
          return { ...l, mode, readEnabled, armed: shouldWrite };
        }),
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },
    armMasterAutomationLane: (laneId, armed) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, armed } : l,
        ),
      }));
    },
    setMasterTrackAutomationMode: (mode) => {
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        masterAutomationReadEnabled: readEnabled,
        masterAutomationWriteEnabled: shouldWrite,
        masterAutomationEnabled: readEnabled,
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({
          ...l,
          mode,
          readEnabled,
          armed: shouldWrite,
        })),
      }));
      syncMasterAutomationModes(get());
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
        masterAutomationReadEnabled: true,
        masterAutomationEnabled: true,
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          const newPoints = [...lane.points, { time, value: Math.max(0, Math.min(1, value)) }];
          newPoints.sort((a, b) => a.time - b.time);
          const nextLane = { ...lane, points: newPoints, readEnabled: true };
          return { ...nextLane, mode: masterLaneMode({ ...s, masterAutomationReadEnabled: true, masterAutomationEnabled: true }, nextLane) };
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
