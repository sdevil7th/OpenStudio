// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import {
  getFXChainSlots,
  notifyFXChainChanged,
  waitForFXChainLength,
} from "../../utils/fxChain";
import { automationToBackend } from "../automationParams";
import { syncAutomationLaneToBackend } from "./storeHelpers";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

function buildAutomationSuspendSnapshot(track: any) {
  return {
    showAutomation: track.showAutomation,
    lanes: Object.fromEntries(
      track.automationLanes.map((lane: any) => [
        lane.id,
        { visible: lane.visible, armed: lane.armed, mode: lane.mode },
      ]),
    ),
  };
}

export const automationActions = (set: SetFn, get: GetFn) => ({
    addTrackFXWithUndo: async (trackId, pluginPath, chainType) => {
      const addFn = chainType === "input" ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);
      const removeFn = chainType === "input" ? nativeBridge.removeTrackInputFX.bind(nativeBridge) : nativeBridge.removeTrackFX.bind(nativeBridge);
      const countField = chainType === "input" ? "inputFxCount" : "trackFxCount";
      const preAddLength = (await getFXChainSlots(trackId, chainType)).length;

      const success = await addFn(trackId, pluginPath);
      if (!success) return false;

      const fxList = await waitForFXChainLength(trackId, chainType, preAddLength + 1);
      const confirmedLength = Math.max(fxList.length, preAddLength + 1);
      const newIndex = fxList.length > preAddLength ? fxList.length - 1 : preAddLength;
      get().updateTrack(trackId, { [countField]: confirmedLength });
      notifyFXChainChanged({ trackId, chainType });

      const command: Command = {
        type: "ADD_TRACK_FX",
        description: `Add ${chainType} FX`,
        timestamp: Date.now(),
        execute: async () => {
          const redoBaseLength = (await getFXChainSlots(trackId, chainType)).length;
          await addFn(trackId, pluginPath);
          const list = await waitForFXChainLength(trackId, chainType, redoBaseLength + 1);
          get().updateTrack(trackId, { [countField]: Math.max(list.length, redoBaseLength + 1) });
          notifyFXChainChanged({ trackId, chainType });
        },
        undo: async () => {
          await removeFn(trackId, newIndex);
          const list = await getFXChainSlots(trackId, chainType);
          get().updateTrack(trackId, { [countField]: list.length });
          notifyFXChainChanged({ trackId, chainType });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    removeTrackFXWithUndo: async (trackId, fxIndex, chainType) => {
      const isInput = chainType === "input";

      // Save plugin state and path before removing
      const fxList = isInput
        ? await nativeBridge.getTrackInputFX(trackId)
        : await nativeBridge.getTrackFX(trackId);
      const pluginInfo = fxList[fxIndex];
      const pluginPath = pluginInfo?.pluginPath || "";
      const savedState = await nativeBridge.getPluginState(trackId, fxIndex, isInput);

      const removeFn = isInput ? nativeBridge.removeTrackInputFX.bind(nativeBridge) : nativeBridge.removeTrackFX.bind(nativeBridge);
      const addFn = isInput ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);

      await removeFn(trackId, fxIndex);

      // Update store FX counts
      const countField = isInput ? "inputFxCount" : "trackFxCount";
      const newList = isInput
        ? await nativeBridge.getTrackInputFX(trackId)
        : await nativeBridge.getTrackFX(trackId);
      get().updateTrack(trackId, { [countField]: newList.length });
      notifyFXChainChanged({ trackId, chainType });

      const command: Command = {
        type: "REMOVE_TRACK_FX",
        description: `Remove ${chainType} FX`,
        timestamp: Date.now(),
        execute: async () => {
          await removeFn(trackId, fxIndex);
          const list = isInput
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
          get().updateTrack(trackId, { [countField]: list.length });
          notifyFXChainChanged({ trackId, chainType });
        },
        undo: async () => {
          // Re-add the plugin and restore its state
          const success = await addFn(trackId, pluginPath);
          if (success && savedState) {
            // The re-added plugin is at the end; move it to original position if needed
            await nativeBridge.setPluginState(trackId, fxIndex, isInput, savedState);
          }
          const list = isInput
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
          get().updateTrack(trackId, { [countField]: list.length });
          notifyFXChainChanged({ trackId, chainType });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },


    toggleTrackAutomation: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, showAutomation: !t.showAutomation } : t,
        ),
      }));
    },

    toggleTrackAutomationEnabled: (trackId) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;

      if (track.automationEnabled) {
        const snapshot = buildAutomationSuspendSnapshot(track);
        set((s) => {
          const automatedParamValues = { ...s.automatedParamValues };
          delete automatedParamValues[trackId];
          return {
            tracks: s.tracks.map((t) =>
              t.id === trackId
                ? {
                    ...t,
                    automationEnabled: false,
                    showAutomation: false,
                    suspendedAutomationState: snapshot,
                    automationLanes: t.automationLanes.map((lane) => ({
                      ...lane,
                      visible: false,
                      armed: false,
                      mode: "off",
                    })),
                  }
                : t,
            ),
            automatedParamValues,
          };
        });

        for (const lane of track.automationLanes) {
          nativeBridge.setAutomationMode(trackId, lane.param, "off").catch(logBridgeError("sync"));
        }
        nativeBridge.setTrackVolume(trackId, track.volumeDB).catch(logBridgeError("sync"));
        nativeBridge.setTrackPan(trackId, track.pan).catch(logBridgeError("sync"));
        nativeBridge.setTrackMute(trackId, track.muted).catch(logBridgeError("sync"));
        return;
      }

      const snapshot = track.suspendedAutomationState;
      const restoredLanes = track.automationLanes.map((lane) => {
        const saved = snapshot?.lanes?.[lane.id];
        return {
          ...lane,
          visible: saved?.visible ?? lane.visible,
          armed: saved?.armed ?? lane.armed,
          mode: saved?.mode ?? (lane.mode === "off" ? "read" : lane.mode),
        };
      });

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                automationEnabled: true,
                showAutomation: snapshot?.showAutomation ?? t.showAutomation,
                suspendedAutomationState: null,
                automationLanes: restoredLanes,
              }
            : t,
        ),
      }));

      for (const lane of restoredLanes) {
        syncAutomationLaneToBackend(trackId, lane);
      }
      get().updateAutomatedValues();
    },

    addAutomationLane: (trackId, param, _label) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return null;
      // Don't add duplicate lanes for the same param
      const existing = track.automationLanes.find((l) => l.param === param);
      if (existing) return existing.id;
      const laneId = `lane_${param}_${Date.now()}`;
      const newLane: AutomationLane = { id: laneId, param, points: [], visible: true, mode: "read", armed: false };
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return { ...t, automationLanes: [...t.automationLanes, newLane], showAutomation: true };
        }),
        isModified: true,
      }));
      return laneId;
    },

    addAutomationPoint: (trackId, laneId, time, value) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              // Insert point in time-sorted order
              const newPoints = [...lane.points, { time, value: Math.max(0, Math.min(1, value)) }];
              newPoints.sort((a, b) => a.time - b.time);
              return { ...lane, points: newPoints };
            }),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend(trackId, lane);
    },

    removeAutomationPoint: (trackId, laneId, pointIndex) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              return { ...lane, points: lane.points.filter((_, i) => i !== pointIndex) };
            }),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend(trackId, lane);
    },

    moveAutomationPoint: (trackId, laneId, pointIndex, time, value) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              const newPoints = lane.points.map((p, i) =>
                i === pointIndex ? { time: Math.max(0, time), value: Math.max(0, Math.min(1, value)) } : p,
              );
              newPoints.sort((a, b) => a.time - b.time);
              return { ...lane, points: newPoints };
            }),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend(trackId, lane);
    },

    toggleAutomationLaneVisibility: (trackId, laneId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, visible: !lane.visible } : lane,
            ),
          };
        }),
      }));
    },

    clearAutomationLane: (trackId, laneId) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((l) =>
              l.id === laneId ? { ...l, points: [] } : l,
            ),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend — clear the automation for this parameter
      if (lane) {
        const parameterId = lane.param === "mute" ? "mute" : lane.param;
        nativeBridge.clearAutomation(trackId, parameterId).catch(() => {});
      }
    },

    setAutomationLaneMode: (trackId, laneId, mode) => {
      // Auto-arm when setting to write/touch/latch, auto-disarm for read/off
      const shouldArm = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, mode, armed: shouldArm } : lane,
            ),
          };
        }),
      }));
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) nativeBridge.setAutomationMode(trackId, lane.param, mode).catch(() => {});
    },

    setTrackAutomationMode: (trackId, mode) => {
      // Auto-arm when setting to write/touch/latch, auto-disarm for read/off
      const shouldArm = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => ({ ...lane, mode, armed: shouldArm })),
          };
        }),
      }));
      const track = get().tracks.find((t) => t.id === trackId);
      if (track) {
        for (const lane of track.automationLanes) {
          nativeBridge.setAutomationMode(trackId, lane.param, mode).catch(() => {});
        }
      }
    },

    armAutomationLane: (trackId, laneId, armed) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, armed } : lane,
            ),
          };
        }),
      }));
    },

    armAllVisibleAutomationLanes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.visible ? { ...lane, armed: true } : lane,
            ),
          };
        }),
      }));
    },

    disarmAllAutomationLanes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => ({ ...lane, armed: false })),
          };
        }),
      }));
    },

    showAllActiveEnvelopes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            showAutomation: true,
            automationLanes: t.automationLanes.map((lane) =>
              lane.points.length > 0 ? { ...lane, visible: true } : lane,
            ),
          };
        }),
      }));
    },

    hideAllEnvelopes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return { ...t, showAutomation: false };
        }),
      }));
    },

});
