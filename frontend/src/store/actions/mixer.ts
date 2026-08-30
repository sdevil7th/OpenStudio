// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { VOLUME_DB_RANGE, VOLUME_MIN_DB } from "../automationParams";
import { automationLaneReadEnabled, automationWriteBehaviorToBackendMode, syncAutomationLaneToBackend } from "./storeHelpers";
import {
  captureAutomationProjectSnapshot,
  createAutomationPointId,
  getAutomationPointId,
  isAutomationEditLocked,
  pushAppliedAutomationProjectCommand,
} from "./automation";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

const masterControlEditSnapshots = new Map<"volume" | "pan", number>();

function cloneMasterAutomationLanes(lanes: any[]) {
  return lanes.map((lane) => ({
    ...lane,
    points: cloneMasterAutomationPoints(lane.points),
  }));
}

function snapshotMasterAutomationMode(state: any) {
  return {
    masterAutomationReadEnabled: state.masterAutomationReadEnabled,
    masterAutomationWriteEnabled: state.masterAutomationWriteEnabled,
    masterAutomationEnabled: state.masterAutomationEnabled,
    masterAutomationLanes: cloneMasterAutomationLanes(state.masterAutomationLanes || []),
  };
}

function buildMasterAutomationSuspendSnapshot(state: any) {
  return {
    showAutomation: state.showMasterAutomation,
    automationReadEnabled: state.masterAutomationReadEnabled,
    automationWriteEnabled: state.masterAutomationWriteEnabled,
    automationEnabled: state.masterAutomationEnabled,
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

function cloneMasterAutomationPoints(points: any) {
  if (!Array.isArray(points)) return [];
  return points.map((point) => (
    point && typeof point === "object"
      ? { ...point }
      : { time: 0, value: 0 }
  ));
}

function normalizedMasterAutomationPoint(time: number, value: number, id?: string) {
  return {
    id: id || createAutomationPointId(),
    time: Math.max(0, Number.isFinite(time) ? time : 0),
    value: clamp01(value),
  };
}

/**
 * Sorts deterministically without losing the source order of equal-time
 * points. That stable tie-break is important when undo restores a lane with
 * stacked points or a drag moves a point through one of its neighbours.
 */
function sortMasterAutomationPoints(points: any[]) {
  return cloneMasterAutomationPoints(points)
    .map((point, sourceIndex) => ({
      point: {
        ...point,
        ...normalizedMasterAutomationPoint(
          point.time,
          point.value,
          point.id || getAutomationPointId(point, sourceIndex),
        ),
      },
      sourceIndex,
    }))
    .sort((a, b) => (a.point.time - b.point.time) || (a.sourceIndex - b.sourceIndex))
    .map(({ point }) => point);
}

function masterAutomationPointsEqual(a: any[], b: any[]) {
  if (a.length !== b.length) return false;
  return a.every((point, index) => (
    point.id === b[index]?.id
    && point.time === b[index]?.time
    && point.value === b[index]?.value
  ));
}

function commitMasterAutomationProjectMutation(
  set: SetFn,
  get: GetFn,
  type: string,
  description: string,
  mutate: () => void,
  sync?: () => void,
) {
  const before = captureAutomationProjectSnapshot(get());
  mutate();
  const after = captureAutomationProjectSnapshot(get());
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (!changed) return false;
  sync?.();
  return pushAppliedAutomationProjectCommand(set, get, before, after, type, description);
}

function syncMasterAutomationLane(get: GetFn, laneId: string) {
  const lane = get().masterAutomationLanes.find((candidate: any) => candidate.id === laneId);
  if (lane) syncAutomationLaneToBackend("master", lane);
}

function syncOrClearMasterAutomationLane(get: GetFn, laneId: string) {
  const lane = get().masterAutomationLanes.find((candidate: any) => candidate.id === laneId);
  if (!lane) return;
  if (lane.points.length === 0) {
    nativeBridge.clearAutomation("master", lane.param).catch(() => {});
    return;
  }
  syncAutomationLaneToBackend("master", lane);
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

    beginMasterVolumeEdit: () => {
      if (!masterControlEditSnapshots.has("volume")) {
        masterControlEditSnapshots.set("volume", get().masterVolume);
      }
      get().beginAutomationParamTouch?.("master", "volume");
    },
    commitMasterVolumeEdit: () => {
      const oldValue = masterControlEditSnapshots.get("volume");
      masterControlEditSnapshots.delete("volume");
      get().endAutomationParamTouch?.("master", "volume");
      const newValue = get().masterVolume;
      if (oldValue === undefined || oldValue === newValue) return;
      const apply = (masterVolume: number) => {
        set({ masterVolume, isModified: true });
        nativeBridge.setMasterVolume(masterVolume).catch(logBridgeError("master volume"));
      };
      commandManager.execute({
        type: "SET_MASTER_VOLUME",
        description: "Adjust master volume",
        timestamp: Date.now(),
        execute: () => apply(newValue),
        undo: () => apply(oldValue),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    beginMasterPanEdit: () => {
      if (!masterControlEditSnapshots.has("pan")) {
        masterControlEditSnapshots.set("pan", get().masterPan);
      }
      get().beginAutomationParamTouch?.("master", "pan");
    },
    commitMasterPanEdit: () => {
      const oldValue = masterControlEditSnapshots.get("pan");
      masterControlEditSnapshots.delete("pan");
      get().endAutomationParamTouch?.("master", "pan");
      const newValue = get().masterPan;
      if (oldValue === undefined || oldValue === newValue) return;
      const apply = (masterPan: number) => {
        set({ masterPan, isModified: true });
        nativeBridge.setMasterPan(masterPan).catch(logBridgeError("master pan"));
      };
      commandManager.execute({
        type: "SET_MASTER_PAN",
        description: "Adjust master pan",
        timestamp: Date.now(),
        execute: () => apply(newValue),
        undo: () => apply(oldValue),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleMasterMute: () => {
      const current = get().isMasterMuted;
      const next = !current;
      const applyMute = (isMasterMuted: boolean) => {
        set({ isMasterMuted, isModified: true });
        // The backend represents master mute by receiving zero gain.
        nativeBridge.setMasterVolume(isMasterMuted ? 0 : get().masterVolume).catch(logBridgeError("master mute"));
      };
      commandManager.execute({
        type: "TOGGLE_MASTER_MUTE",
        description: next ? "Mute master" : "Unmute master",
        timestamp: Date.now(),
        execute: () => applyMute(next),
        undo: () => applyMute(current),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    toggleMasterMono: () => {
      const current = get().masterMono;
      const next = !current;
      const applyMono = (masterMono: boolean) => {
        set({ masterMono, isModified: true });
        nativeBridge.setMasterMono(masterMono).catch(logBridgeError("master mono"));
      };
      commandManager.execute({
        type: "TOGGLE_MASTER_MONO",
        description: next ? "Enable master mono" : "Disable master mono",
        timestamp: Date.now(),
        execute: () => applyMono(next),
        undo: () => applyMono(current),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    toggleMasterAutomation: () => {
      if (isAutomationEditLocked(get())) return;
      const show = !get().showMasterAutomation;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "TOGGLE_MASTER_AUTOMATION_VIEW",
        show ? "Show master automation" : "Hide master automation",
        () => set({ showMasterAutomation: show }),
      );
    },
    setMasterAutomationRead: (enabled) => {
      if (isAutomationEditLocked(get())) return;
      const nextRead = Boolean(enabled);
      const current = get();
      if (current.masterAutomationLanes.length === 0 && !masterWriteEnabled(current)) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "SET_MASTER_AUTOMATION_READ",
        nextRead ? "Enable master automation read" : "Disable master automation read",
        () => set((s) => {
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
        }),
        () => {
          const state = get();
          syncMasterAutomationModes(state);
          if (!nextRead) {
            nativeBridge.setMasterVolume(state.masterVolume).catch(() => {});
            nativeBridge.setMasterPan(state.masterPan).catch(() => {});
          } else {
            state.updateAutomatedValues?.();
          }
        },
      );
    },
    toggleMasterAutomationRead: () => {
      get().setMasterAutomationRead(!masterReadEnabled(get()));
    },
    setMasterAutomationWrite: (enabled) => {
      if (isAutomationEditLocked(get())) return;
      const nextWrite = Boolean(enabled);
      commitMasterAutomationProjectMutation(
        set,
        get,
        "SET_MASTER_AUTOMATION_WRITE",
        nextWrite ? "Enable master automation write" : "Disable master automation write",
        () => set((s) => {
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
        }),
        () => syncMasterAutomationModes(get()),
      );
    },
    toggleMasterAutomationWrite: () => {
      get().setMasterAutomationWrite(!masterWriteEnabled(get()));
    },
    toggleMasterAutomationEnabled: () => {
      get().toggleMasterAutomationRead();
    },
    addMasterAutomationLane: (param) => {
      const state = get();
      if (isAutomationEditLocked(state)) return null;
      const existing = state.masterAutomationLanes.find((l) => l.param === param);
      if (existing) {
        commitMasterAutomationProjectMutation(
          set,
          get,
          "SHOW_MASTER_AUTOMATION_LANE",
          "Show master automation lane",
          () => set((s) => {
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
          }),
          () => {
            const updated = get().masterAutomationLanes.find((l) => l.id === existing.id);
            if (updated) syncAutomationLaneToBackend("master", updated);
          },
        );
        return existing.id;
      }
      const newId = `master-${param}`;
      let laneToSync: any = null;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "ADD_MASTER_AUTOMATION_LANE",
        "Add master automation lane",
        () => set((s) => {
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
        }),
        () => {
          if (laneToSync) syncAutomationLaneToBackend("master", laneToSync);
        },
      );
      return newId;
    },
    toggleMasterAutomationLaneVisibility: (laneId) => {
      if (isAutomationEditLocked(get())) return;
      const lane = get().masterAutomationLanes.find((candidate) => candidate.id === laneId);
      if (!lane) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "TOGGLE_MASTER_AUTOMATION_LANE_VISIBILITY",
        lane.visible ? "Hide master automation lane" : "Show master automation lane",
        () => set((s) => ({
          masterAutomationLanes: s.masterAutomationLanes.map((l) =>
            l.id === laneId ? { ...l, visible: !l.visible } : l,
          ),
        })),
      );
    },
    setMasterAutomationLaneRead: (laneId, enabled) => {
      if (isAutomationEditLocked(get())) return;
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (!lane || automationLaneReadEnabled(lane) === Boolean(enabled)) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "SET_MASTER_AUTOMATION_LANE_READ",
        enabled ? "Enable master automation lane read" : "Disable master automation lane read",
        () => set((s) => {
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
        }),
        () => {
          const updatedLane = get().masterAutomationLanes.find((l) => l.id === laneId);
          if (updatedLane) syncAutomationLaneToBackend("master", updatedLane);
          get().updateAutomatedValues?.();
        },
      );
    },
    toggleMasterAutomationLaneRead: (laneId) => {
      if (isAutomationEditLocked(get())) return;
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      get().setMasterAutomationLaneRead(laneId, !automationLaneReadEnabled(lane));
    },
    setMasterAutomationLaneMode: (laneId, mode) => {
      if (isAutomationEditLocked(get())) return;
      const laneBefore = get().masterAutomationLanes.find((lane) => lane.id === laneId);
      if (!laneBefore || (
        laneBefore.mode === mode
        && laneBefore.readEnabled === (mode !== "off")
        && laneBefore.armed === (mode === "write" || mode === "touch" || mode === "latch")
      )) return;
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      commitMasterAutomationProjectMutation(
        set,
        get,
        "SET_MASTER_AUTOMATION_LANE_MODE",
        `Set master automation lane mode to ${mode}`,
        () => set((s) => ({
          masterAutomationReadEnabled: readEnabled ? true : s.masterAutomationReadEnabled,
          masterAutomationWriteEnabled: shouldWrite ? true : (mode === "read" || mode === "off" ? false : s.masterAutomationWriteEnabled),
          masterAutomationEnabled: readEnabled ? true : s.masterAutomationEnabled,
          masterAutomationLanes: s.masterAutomationLanes.map((l) => {
            if (l.id !== laneId) return l;
            return { ...l, mode, readEnabled, armed: shouldWrite };
          }),
        })),
        () => {
          const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
          if (lane) syncAutomationLaneToBackend("master", lane);
        },
      );
    },
    armMasterAutomationLane: (laneId, armed) => {
      if (isAutomationEditLocked(get())) return;
      const lane = get().masterAutomationLanes.find((candidate) => candidate.id === laneId);
      if (!lane || lane.armed === Boolean(armed)) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "ARM_MASTER_AUTOMATION_LANE",
        armed ? "Arm master automation lane" : "Disarm master automation lane",
        () => set((s) => ({
          masterAutomationLanes: s.masterAutomationLanes.map((l) =>
            l.id === laneId ? { ...l, armed: Boolean(armed) } : l,
          ),
        })),
      );
    },
    setMasterTrackAutomationMode: (mode) => {
      if (isAutomationEditLocked(get())) return;
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      const state = get();
      if (
        state.masterAutomationReadEnabled === readEnabled
        && state.masterAutomationWriteEnabled === shouldWrite
        && state.masterAutomationEnabled === readEnabled
        && state.masterAutomationLanes.every((lane) => (
          lane.mode === mode && lane.readEnabled === readEnabled && lane.armed === shouldWrite
        ))
      ) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "SET_MASTER_AUTOMATION_MODE",
        `Set master automation mode to ${mode}`,
        () => set((s) => ({
          masterAutomationReadEnabled: readEnabled,
          masterAutomationWriteEnabled: shouldWrite,
          masterAutomationEnabled: readEnabled,
          masterAutomationLanes: s.masterAutomationLanes.map((l) => ({
            ...l,
            mode,
            readEnabled,
            armed: shouldWrite,
          })),
        })),
        () => syncMasterAutomationModes(get()),
      );
    },
    showAllActiveMasterEnvelopes: () => {
      if (isAutomationEditLocked(get())) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "SHOW_ACTIVE_MASTER_ENVELOPES",
        "Show active master envelopes",
        () => set((s) => ({
          showMasterAutomation: true,
          masterAutomationLanes: s.masterAutomationLanes.map((l) =>
            l.points.length > 0 ? { ...l, visible: true } : l,
          ),
        })),
      );
    },
    hideAllMasterEnvelopes: () => {
      if (isAutomationEditLocked(get())) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "HIDE_MASTER_ENVELOPES",
        "Hide master envelopes",
        () => set((s) => ({
          showMasterAutomation: false,
          masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, visible: false })),
        })),
      );
    },
    armAllVisibleMasterAutomationLanes: () => {
      if (isAutomationEditLocked(get())) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "ARM_VISIBLE_MASTER_AUTOMATION_LANES",
        "Arm visible master automation lanes",
        () => set((s) => ({
          masterAutomationLanes: s.masterAutomationLanes.map((l) =>
            l.visible ? { ...l, armed: true } : l,
          ),
        })),
      );
    },
    disarmAllMasterAutomationLanes: () => {
      if (isAutomationEditLocked(get())) return;
      commitMasterAutomationProjectMutation(
        set,
        get,
        "DISARM_MASTER_AUTOMATION_LANES",
        "Disarm master automation lanes",
        () => set((s) => ({
          masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, armed: false })),
        })),
      );
    },
    addMasterAutomationPoint: (laneId, time, value) => {
      const state = get();
      if (isAutomationEditLocked(state)) return;
      if (!Number.isFinite(time) || !Number.isFinite(value)) return;
      const lane = state.masterAutomationLanes.find((candidate) => candidate.id === laneId);
      if (!lane) return;

      const oldPoints = sortMasterAutomationPoints(lane.points);
      const newPoints = sortMasterAutomationPoints([
        ...oldPoints,
        normalizedMasterAutomationPoint(time, value),
      ]);
      const oldReadState = {
        masterAutomationReadEnabled: state.masterAutomationReadEnabled,
        masterAutomationWriteEnabled: state.masterAutomationWriteEnabled,
        masterAutomationEnabled: state.masterAutomationEnabled,
        laneReadEnabled: lane.readEnabled,
        laneMode: lane.mode,
      };
      const enabledState = {
        ...state,
        masterAutomationReadEnabled: true,
        masterAutomationEnabled: true,
      };
      const enabledLane = { ...lane, readEnabled: true };
      const newLaneMode = masterLaneMode(enabledState, enabledLane);

      const applyPoints = (points, restoreReadState: boolean) => {
        const targetPoints = cloneMasterAutomationPoints(points);
        set((current) => ({
          ...(restoreReadState
            ? {
                masterAutomationReadEnabled: oldReadState.masterAutomationReadEnabled,
                masterAutomationWriteEnabled: oldReadState.masterAutomationWriteEnabled,
                masterAutomationEnabled: oldReadState.masterAutomationEnabled,
              }
            : {
                masterAutomationReadEnabled: true,
                masterAutomationEnabled: true,
              }),
          masterAutomationLanes: current.masterAutomationLanes.map((candidate) => (
            candidate.id === laneId
              ? {
                  ...candidate,
                  points: targetPoints,
                  readEnabled: restoreReadState ? oldReadState.laneReadEnabled : true,
                  mode: restoreReadState ? oldReadState.laneMode : newLaneMode,
                }
              : candidate
          )),
          isModified: true,
        }));
        syncOrClearMasterAutomationLane(get, laneId);
      };

      commandManager.execute({
        type: "MASTER_AUTOMATION_POINT_ADD",
        description: "Add master automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints, false),
        undo: () => applyPoints(oldPoints, true),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    removeMasterAutomationPoint: (laneId, pointIndex) => {
      const state = get();
      if (isAutomationEditLocked(state)) return;
      const lane = state.masterAutomationLanes.find((candidate) => candidate.id === laneId);
      if (!lane) return;
      const oldPoints = sortMasterAutomationPoints(lane.points);
      if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= oldPoints.length) return;
      const newPoints = oldPoints.filter((_, index) => index !== pointIndex);
      const applyPoints = (points) => {
        const targetPoints = cloneMasterAutomationPoints(points);
        set((state) => ({
          masterAutomationLanes: state.masterAutomationLanes.map((candidate) => (
            candidate.id === laneId ? { ...candidate, points: targetPoints } : candidate
          )),
          isModified: true,
        }));
        syncOrClearMasterAutomationLane(get, laneId);
      };

      commandManager.execute({
        type: "MASTER_AUTOMATION_POINT_REMOVE",
        description: "Remove master automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    moveMasterAutomationPoint: (laneId, pointIndex, time, value) => {
      const state = get();
      if (isAutomationEditLocked(state)) return;
      if (!Number.isFinite(time) || !Number.isFinite(value)) return;
      const lane = state.masterAutomationLanes.find((candidate) => candidate.id === laneId);
      if (!lane) return;
      const oldPoints = sortMasterAutomationPoints(lane.points);
      if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= oldPoints.length) return;
      const movedPoint = {
        ...oldPoints[pointIndex],
        ...normalizedMasterAutomationPoint(time, value, oldPoints[pointIndex].id),
      };
      const newPoints = sortMasterAutomationPoints(oldPoints.map((point, index) => (
        index === pointIndex ? movedPoint : point
      )));
      if (masterAutomationPointsEqual(oldPoints, newPoints)) return;

      const applyPoints = (points) => {
        const targetPoints = cloneMasterAutomationPoints(points);
        set((state) => ({
          masterAutomationLanes: state.masterAutomationLanes.map((candidate) => (
            candidate.id === laneId ? { ...candidate, points: targetPoints } : candidate
          )),
          isModified: true,
        }));
        syncOrClearMasterAutomationLane(get, laneId);
      };

      commandManager.execute({
        type: "MASTER_AUTOMATION_POINT_MOVE",
        description: "Move master automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    clearMasterAutomationLane: (laneId) => {
      const state = get();
      if (isAutomationEditLocked(state)) return;
      const lane = state.masterAutomationLanes.find((candidate) => candidate.id === laneId);
      if (!lane || lane.points.length === 0) return;
      const oldPoints = sortMasterAutomationPoints(lane.points);
      const applyPoints = (points) => {
        const targetPoints = cloneMasterAutomationPoints(points);
        set((current) => ({
          masterAutomationLanes: current.masterAutomationLanes.map((candidate) => (
            candidate.id === laneId ? { ...candidate, points: targetPoints } : candidate
          )),
          isModified: true,
        }));
        syncOrClearMasterAutomationLane(get, laneId);
      };
      commandManager.execute({
        type: "MASTER_AUTOMATION_LANE_CLEAR",
        description: "Clear master automation lane",
        timestamp: Date.now(),
        execute: () => applyPoints([]),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

});
