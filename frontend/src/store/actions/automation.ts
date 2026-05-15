// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import {
  getFXChainSlots,
  notifyFXChainChanged,
  notifyInstrumentChanged,
  waitForFXChainLength,
} from "../../utils/fxChain";
import {
  automationToBackend,
  getAutomationDefault,
  interpolateAtTime,
  VOLUME_DB_RANGE,
  VOLUME_MIN_DB,
} from "../automationParams";
import {
  syncAutomationLaneToBackend,
  _autoRecordTimers,
  AUTO_RECORD_INTERVAL_MS,
  _automationTouchedParams,
  _automationLatchedParams,
  _automationWriteValues,
  automationTouchKey,
} from "./storeHelpers";

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

const AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS = 0.025;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function currentNormalizedAutomationValue(track: any, lane: any, time: number): number {
  const writeValue = _automationWriteValues.get(automationTouchKey(track.id, lane.param));
  if (writeValue !== undefined)
    return clamp01(writeValue);

  switch (lane.param) {
    case "volume":
      return clamp01(((track.volumeDB ?? 0) - VOLUME_MIN_DB) / VOLUME_DB_RANGE);
    case "pan":
    case "pan_prefx":
      return clamp01(((track.pan ?? 0) + 1) / 2);
    case "width":
      return clamp01((track.stereoWidth ?? 100) / 200);
    case "volume_prefx":
    case "trim_volume":
    case "width_prefx":
    case "midi_pitch_bend":
      return lane.points?.length ? interpolateAtTime(lane.points, time) : getAutomationDefault(lane.param);
    case "mute":
      return track.muted ? 1 : 0;
    default:
      return lane.points?.length ? interpolateAtTime(lane.points, time) : getAutomationDefault(lane.param);
  }
}

function writeAutomationPoint(points: any[], time: number, value: number) {
  const start = Math.max(0, time - AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS);
  const end = time + AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS;
  const next = (points || [])
    .filter((point) => point.time < start || point.time > end)
    .concat([{ time: Math.max(0, time), value: clamp01(value) }]);
  next.sort((a, b) => a.time - b.time);
  return next;
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

    loadInstrumentWithUndo: async (trackId, pluginPath) => {
      const track = get().tracks.find((t: any) => t.id === trackId);
      if (!track) return false;

      const previousPlugin = track.instrumentPlugin || "";
      const previousType = track.type;
      const previousState = previousPlugin
        ? await nativeBridge.getInstrumentState(trackId).catch(() => "")
        : "";

      const success = await nativeBridge.loadInstrument(trackId, pluginPath);
      if (!success) return false;

      get().updateTrack(trackId, { type: "instrument", instrumentPlugin: pluginPath });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
      notifyInstrumentChanged({ trackId, instrumentPlugin: pluginPath });

      const command: Command = {
        type: "LOAD_INSTRUMENT",
        description: "Load instrument",
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.loadInstrument(trackId, pluginPath);
          get().updateTrack(trackId, { type: "instrument", instrumentPlugin: pluginPath });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: pluginPath });
        },
        undo: async () => {
          if (previousPlugin) {
            await nativeBridge.loadInstrument(trackId, previousPlugin);
            if (previousState) await nativeBridge.setInstrumentState(trackId, previousState);
            get().updateTrack(trackId, { type: "instrument", instrumentPlugin: previousPlugin });
            notifyInstrumentChanged({ trackId, instrumentPlugin: previousPlugin });
          } else {
            await nativeBridge.removeInstrument(trackId);
            get().updateTrack(trackId, { type: previousType || "midi", instrumentPlugin: undefined });
            notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
          }
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    removeInstrumentWithUndo: async (trackId) => {
      const track = get().tracks.find((t: any) => t.id === trackId);
      if (!track?.instrumentPlugin) {
        if (!track || track.type !== "instrument" || track.samplerSamplePath) return false;

        const previousType = track.type;
        await nativeBridge.setTrackType(trackId, "midi").catch(() => false);
        get().updateTrack(trackId, { type: "midi", instrumentPlugin: undefined });
        await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });

        const command: Command = {
          type: "REMOVE_INSTRUMENT",
          description: "Remove basic synth",
          timestamp: Date.now(),
          execute: async () => {
            await nativeBridge.setTrackType(trackId, "midi").catch(() => false);
            get().updateTrack(trackId, { type: "midi", instrumentPlugin: undefined });
            await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
            notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
          },
          undo: async () => {
            await nativeBridge.setTrackType(trackId, previousType || "instrument").catch(() => false);
            get().updateTrack(trackId, { type: previousType || "instrument", instrumentPlugin: undefined });
            await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
            notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
          },
        };
        commandManager.push(command);
        set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        return true;
      }

      const previousPlugin = track.instrumentPlugin;
      const previousType = track.type;
      const previousState = await nativeBridge.getInstrumentState(trackId).catch(() => "");
      const typeAfterRemoval = (candidate: any) =>
        candidate?.samplerSamplePath || previousType === "instrument" ? "instrument" : "midi";
      const success = await nativeBridge.removeInstrument(trackId);
      if (!success) return false;

      get().updateTrack(trackId, {
        type: typeAfterRemoval(track),
        instrumentPlugin: undefined,
      });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
      notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });

      const command: Command = {
        type: "REMOVE_INSTRUMENT",
        description: "Remove instrument",
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.removeInstrument(trackId);
          const currentTrack = get().tracks.find((t: any) => t.id === trackId);
          get().updateTrack(trackId, {
            type: typeAfterRemoval(currentTrack),
            instrumentPlugin: undefined,
          });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
        },
        undo: async () => {
          await nativeBridge.loadInstrument(trackId, previousPlugin);
          if (previousState) await nativeBridge.setInstrumentState(trackId, previousState);
          get().updateTrack(trackId, { type: previousType || "instrument", instrumentPlugin: previousPlugin });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: previousPlugin });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    setTrackSamplerSampleWithUndo: async (trackId, samplePath, rootNote = 60) => {
      const track = get().tracks.find((t: any) => t.id === trackId);
      if (!track || !samplePath) return false;

      const previousSamplePath = track.samplerSamplePath || "";
      const previousRootNote = track.samplerRootNote ?? 60;
      const previousType = track.type;
      const nextRootNote = Math.max(0, Math.min(127, Math.round(rootNote)));

      const success = await nativeBridge.setTrackSamplerSample(trackId, samplePath, nextRootNote);
      if (!success) return false;

      get().updateTrack(trackId, {
        type: "instrument",
        samplerSamplePath: samplePath,
        samplerRootNote: nextRootNote,
        samplerSourceType: String(samplePath).toLowerCase().endsWith(".sf2") ? "soundfont" : "audio",
      });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });

      const command: Command = {
        type: "LOAD_INSTRUMENT",
        description: "Load sampler sample",
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.setTrackSamplerSample(trackId, samplePath, nextRootNote);
          get().updateTrack(trackId, {
            type: "instrument",
            samplerSamplePath: samplePath,
            samplerRootNote: nextRootNote,
            samplerSourceType: String(samplePath).toLowerCase().endsWith(".sf2") ? "soundfont" : "audio",
          });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        },
        undo: async () => {
          if (previousSamplePath) {
            await nativeBridge.setTrackSamplerSample(trackId, previousSamplePath, previousRootNote);
            get().updateTrack(trackId, {
              type: previousType === "audio" || previousType === "ai" || previousType === "bus" ? "instrument" : previousType,
              samplerSamplePath: previousSamplePath,
              samplerRootNote: previousRootNote,
              samplerSourceType: String(previousSamplePath).toLowerCase().endsWith(".sf2") ? "soundfont" : "audio",
            });
          } else {
            await nativeBridge.clearTrackSamplerSample(trackId);
            get().updateTrack(trackId, {
              type: previousType,
              samplerSamplePath: undefined,
              samplerRootNote: previousRootNote,
              samplerSourceType: undefined,
            });
          }
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    clearTrackSamplerSampleWithUndo: async (trackId) => {
      const track = get().tracks.find((t: any) => t.id === trackId);
      if (!track?.samplerSamplePath) return false;

      const previousSamplePath = track.samplerSamplePath;
      const previousRootNote = track.samplerRootNote ?? 60;
      const previousType = track.type;
      const success = await nativeBridge.clearTrackSamplerSample(trackId);
      if (!success) return false;

      get().updateTrack(trackId, {
        samplerSamplePath: undefined,
        samplerRootNote: previousRootNote,
        samplerSourceType: undefined,
      });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });

      const command: Command = {
        type: "REMOVE_INSTRUMENT",
        description: "Clear sampler sample",
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.clearTrackSamplerSample(trackId);
          get().updateTrack(trackId, {
            samplerSamplePath: undefined,
            samplerRootNote: previousRootNote,
            samplerSourceType: undefined,
          });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        },
        undo: async () => {
          await nativeBridge.setTrackSamplerSample(trackId, previousSamplePath, previousRootNote);
          get().updateTrack(trackId, {
            type: previousType || "instrument",
            samplerSamplePath: previousSamplePath,
            samplerRootNote: previousRootNote,
            samplerSourceType: String(previousSamplePath).toLowerCase().endsWith(".sf2") ? "soundfont" : "audio",
          });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
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

    recordAutomationWriteTick: (nowMs = Date.now()) => {
      const state = get();
      if (!state.transport.isPlaying) return;

      const time = state.transport.currentTime;
      const lanesToSync: Array<{
        trackId: string;
        lane: any;
        start: number;
        end: number;
        point: { time: number; value: number };
      }> = [];

      set((s) => {
        let changed = false;
        const tracks = s.tracks.map((track) => {
          if (!track.automationEnabled) return track;

          let trackChanged = false;
          const automationLanes = track.automationLanes.map((lane) => {
            if (!lane.armed || lane.mode === "off" || lane.mode === "read")
              return lane;

            const key = automationTouchKey(track.id, lane.param);
            const shouldRecord = lane.mode === "write"
              || (lane.mode === "touch" && _automationTouchedParams.has(key))
              || (lane.mode === "latch" && (_automationTouchedParams.has(key) || _automationLatchedParams.has(key)));

            if (!shouldRecord)
              return lane;

            const lastRecorded = _autoRecordTimers.get(key) ?? 0;
            if (nowMs - lastRecorded < AUTO_RECORD_INTERVAL_MS)
              return lane;

            _autoRecordTimers.set(key, nowMs);
            const value = currentNormalizedAutomationValue(track, lane, time);
            const point = { time: Math.max(0, time), value: clamp01(value) };
            const nextLane = {
              ...lane,
              points: writeAutomationPoint(lane.points, time, point.value),
            };
            lanesToSync.push({
              trackId: track.id,
              lane: nextLane,
              start: Math.max(0, time - AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS),
              end: time + AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS,
              point,
            });
            trackChanged = true;
            changed = true;
            return nextLane;
          });

          return trackChanged ? { ...track, automationLanes } : track;
        });

        return changed ? { tracks, isModified: true } : s;
      });

      for (const { trackId, lane, start, end, point } of lanesToSync) {
        const convertedPoint = {
          time: point.time,
          value: automationToBackend(lane.param, point.value),
        };
        nativeBridge
          .replaceAutomationPointsInRange(trackId, lane.param, start, end, [convertedPoint])
          .then((ok) => {
            if (!ok) syncAutomationLaneToBackend(trackId, lane);
          })
          .catch(() => syncAutomationLaneToBackend(trackId, lane));
      }
    },

    endAutomationWriteSession: () => {
      _automationTouchedParams.clear();
      _automationLatchedParams.clear();
      _autoRecordTimers.clear();
      _automationWriteValues.clear();
    },

    setAutomationWriteValue: (trackId, param, value) => {
      _automationWriteValues.set(automationTouchKey(trackId, param), clamp01(value));
    },

    beginAutomationParamTouch: (trackId, param) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.param === param);
      if (!lane || !lane.armed || (lane.mode !== "touch" && lane.mode !== "latch")) return;
      const key = automationTouchKey(trackId, param);
      _automationTouchedParams.add(key);
      if (lane.mode === "latch") _automationLatchedParams.add(key);
      else _automationLatchedParams.delete(key);
      nativeBridge.beginTouchAutomation(trackId, param).catch(() => {});
    },

    endAutomationParamTouch: (trackId, param) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.param === param);
      if (!lane) return;
      const key = automationTouchKey(trackId, param);
      _automationTouchedParams.delete(key);
      if (lane.mode !== "latch") _automationLatchedParams.delete(key);
      nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
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
          const key = automationTouchKey(trackId, lane.param);
          _automationTouchedParams.delete(key);
          _automationLatchedParams.delete(key);
          nativeBridge.setAutomationMode(trackId, lane.param, "off").catch(logBridgeError("sync"));
          nativeBridge.endTouchAutomation(trackId, lane.param).catch(logBridgeError("sync"));
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
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      const oldPoints = [...lane.points];
      const newPoints = [...lane.points, { time: Math.max(0, time), value: clamp01(value) }].sort((a, b) => a.time - b.time);
      const applyPoints = (points) => {
        set((s) => ({
          tracks: s.tracks.map((t) => t.id !== trackId ? t : {
            ...t,
            automationLanes: t.automationLanes.map((candidate) =>
              candidate.id === laneId ? { ...candidate, points } : candidate,
            ),
          }),
          isModified: true,
        }));
        const updatedLane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
        if (updatedLane) syncAutomationLaneToBackend(trackId, updatedLane);
      };
      commandManager.execute({
        type: "AUTOMATION_POINT_ADD",
        description: "Add automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeAutomationPoint: (trackId, laneId, pointIndex) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const oldPoints = [...lane.points];
      const newPoints = lane.points.filter((_, i) => i !== pointIndex);
      const applyPoints = (points) => {
        set((s) => ({
          tracks: s.tracks.map((t) => t.id !== trackId ? t : {
            ...t,
            automationLanes: t.automationLanes.map((candidate) =>
              candidate.id === laneId ? { ...candidate, points } : candidate,
            ),
          }),
          isModified: true,
        }));
        const updatedLane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
        if (updatedLane) syncAutomationLaneToBackend(trackId, updatedLane);
      };
      commandManager.execute({
        type: "AUTOMATION_POINT_REMOVE",
        description: "Remove automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    moveAutomationPoint: (trackId, laneId, pointIndex, time, value) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const oldPoints = [...lane.points];
      const newPoints = lane.points
        .map((p, i) => i === pointIndex ? { time: Math.max(0, time), value: clamp01(value) } : p)
        .sort((a, b) => a.time - b.time);
      const applyPoints = (points) => {
        set((s) => ({
          tracks: s.tracks.map((t) => t.id !== trackId ? t : {
            ...t,
            automationLanes: t.automationLanes.map((candidate) =>
              candidate.id === laneId ? { ...candidate, points } : candidate,
            ),
          }),
          isModified: true,
        }));
        const updatedLane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
        if (updatedLane) syncAutomationLaneToBackend(trackId, updatedLane);
      };
      commandManager.execute({
        type: "AUTOMATION_POINT_MOVE",
        description: "Move automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
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
      if (!lane) return;
      const oldPoints = [...lane.points];
      const applyPoints = (points) => {
        set((s) => ({
          tracks: s.tracks.map((t) => t.id !== trackId ? t : {
            ...t,
            automationLanes: t.automationLanes.map((candidate) =>
              candidate.id === laneId ? { ...candidate, points } : candidate,
            ),
          }),
          isModified: true,
        }));
        const updatedLane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
        if (updatedLane) syncAutomationLaneToBackend(trackId, updatedLane);
      };
      commandManager.execute({
        type: "AUTOMATION_LANE_CLEAR",
        description: "Clear automation lane",
        timestamp: Date.now(),
        execute: () => applyPoints([]),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return;
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
      if (lane) {
        if (mode === "off" || mode === "read") {
          const key = automationTouchKey(trackId, lane.param);
          _automationTouchedParams.delete(key);
          _automationLatchedParams.delete(key);
          nativeBridge.endTouchAutomation(trackId, lane.param).catch(() => {});
        }
        nativeBridge.setAutomationMode(trackId, lane.param, mode).catch(() => {});
      }
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
          if (mode === "off" || mode === "read") {
            const key = automationTouchKey(trackId, lane.param);
            _automationTouchedParams.delete(key);
            _automationLatchedParams.delete(key);
            nativeBridge.endTouchAutomation(trackId, lane.param).catch(() => {});
          }
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
