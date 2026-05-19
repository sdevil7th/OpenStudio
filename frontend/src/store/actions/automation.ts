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
  automationLaneReadEnabled,
  automationWriteBehaviorToBackendMode,
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
        { visible: lane.visible, armed: lane.armed, mode: lane.mode, readEnabled: automationLaneReadEnabled(lane) },
      ]),
    ),
  };
}

const AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS = 0.025;
const AUTOMATION_WRITE_SIMPLIFY_MAX_GAP_SECONDS = 0.18;
const AUTOMATION_WRITE_SIMPLIFY_VALUE_TOLERANCE = 0.01;
const _automationWriteSessionStartTimes = new Map<string, number>();

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

function isDiscreteAutomationParam(param: string) {
  return param === "mute" || param === "midi_cc_64";
}

function linearAutomationError(point: any, start: any, end: any) {
  const duration = end.time - start.time;
  if (duration <= 0.000001)
    return Math.abs(point.value - start.value);

  const t = (point.time - start.time) / duration;
  const expected = start.value + (end.value - start.value) * t;
  return Math.abs(point.value - expected);
}

function simplifyAutomationPointsRDP(points: any[], tolerance: number) {
  if (points.length <= 2) return points;

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const simplifyRange = (startIndex: number, endIndex: number) => {
    if (endIndex <= startIndex + 1) return;

    let maxError = -1;
    let maxIndex = -1;
    for (let i = startIndex + 1; i < endIndex; i += 1) {
      const error = linearAutomationError(points[i], points[startIndex], points[endIndex]);
      if (error > maxError) {
        maxError = error;
        maxIndex = i;
      }
    }

    if (maxError > tolerance && maxIndex > startIndex) {
      keep[maxIndex] = true;
      simplifyRange(startIndex, maxIndex);
      simplifyRange(maxIndex, endIndex);
    }
  };

  simplifyRange(0, points.length - 1);
  return points.filter((_, index) => keep[index]);
}

function simplifyContinuousAutomationWritePoints(param: string, points: any[], focusTime: number, sessionStartTime?: number) {
  const normalized = normalizeAutomationPoints(points);
  if (isDiscreteAutomationParam(param) || normalized.length < 4)
    return { points: normalized, didSimplify: false };

  let start = 0;
  let end = normalized.length - 1;

  if (Number.isFinite(sessionStartTime)) {
    const lower = Math.min(sessionStartTime as number, focusTime) - 0.000001;
    const upper = Math.max(sessionStartTime as number, focusTime) + 0.000001;

    start = normalized.findIndex((point) => point.time >= lower);
    if (start < 0) start = 0;

    end = normalized.length - 1;
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      if (normalized[i].time <= upper) {
        end = i;
        break;
      }
    }
  } else {
    let focusIndex = 0;
    let focusDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < normalized.length; i += 1) {
      const distance = Math.abs(normalized[i].time - focusTime);
      if (distance < focusDistance) {
        focusDistance = distance;
        focusIndex = i;
      }
    }

    start = focusIndex;
    while (
      start > 0
      && normalized[start].time - normalized[start - 1].time <= AUTOMATION_WRITE_SIMPLIFY_MAX_GAP_SECONDS
    ) {
      start -= 1;
    }

    end = focusIndex;
    while (
      end < normalized.length - 1
      && normalized[end + 1].time - normalized[end].time <= AUTOMATION_WRITE_SIMPLIFY_MAX_GAP_SECONDS
    ) {
      end += 1;
    }
  }

  const run = normalized.slice(start, end + 1);
  if (run.length < 4)
    return { points: normalized, didSimplify: false };

  const simplifiedRun = simplifyAutomationPointsRDP(run, AUTOMATION_WRITE_SIMPLIFY_VALUE_TOLERANCE);
  if (simplifiedRun.length >= run.length)
    return { points: normalized, didSimplify: false };

  return {
    points: [
      ...normalized.slice(0, start),
      ...simplifiedRun,
      ...normalized.slice(end + 1),
    ],
    didSimplify: true,
  };
}

function normalizeAutomationPoints(points: any[] = []) {
  return points
    .map((point) => ({
      time: Math.max(0, Number(point?.time) || 0),
      value: clamp01(Number(point?.value)),
    }))
    .sort((a, b) => a.time - b.time);
}

function trackReadEnabled(track: any): boolean {
  if (typeof track?.automationReadEnabled === "boolean") return track.automationReadEnabled;
  if (typeof track?.automationEnabled === "boolean") return track.automationEnabled;
  return (track?.automationLanes?.length ?? 0) > 0;
}

function trackWriteEnabled(track: any): boolean {
  return track?.automationWriteEnabled === true;
}

function masterVolumeDb(state: any): number {
  const volume = Number(state?.masterVolume);
  if (!Number.isFinite(volume) || volume <= 0) return VOLUME_MIN_DB;
  return 20 * Math.log10(volume);
}

function masterAutomationTrack(state: any) {
  return {
    id: "master",
    volumeDB: masterVolumeDb(state),
    pan: Number.isFinite(Number(state?.masterPan)) ? Number(state.masterPan) : 0,
    muted: Boolean(state?.isMasterMuted),
    automationReadEnabled: state?.masterAutomationReadEnabled === true,
    automationWriteEnabled: state?.masterAutomationWriteEnabled === true,
    automationEnabled: state?.masterAutomationEnabled === true,
    automationLanes: state?.masterAutomationLanes || [],
  };
}

function writeBehavior(get: GetFn): "touch" | "latch" | "overwrite" {
  return get().automationWriteBehavior ?? "touch";
}

function automationTransportRolling(state: any): boolean {
  return Boolean(state?.transport?.isPlaying || state?.transport?.isRecording);
}

function resolvedLaneMode(track: any, lane: any, behavior: "touch" | "latch" | "overwrite", activeWriting = false) {
  if (!trackReadEnabled(track) || !automationLaneReadEnabled(lane))
    return "off";
  if (!trackWriteEnabled(track))
    return "read";
  if (behavior === "overwrite" && !activeWriting)
    return "read";
  return automationWriteBehaviorToBackendMode(behavior);
}

function withResolvedLaneMode(track: any, lane: any, behavior: "touch" | "latch" | "overwrite", activeWriting = false) {
  const readEnabled = automationLaneReadEnabled(lane);
  return {
    ...lane,
    readEnabled,
    mode: resolvedLaneMode(track, { ...lane, readEnabled }, behavior, activeWriting),
  };
}

function syncTrackAutomationModes(track: any, behavior: "touch" | "latch" | "overwrite") {
  for (const lane of track.automationLanes || []) {
    const key = automationTouchKey(track.id, lane.param);
    const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
    syncAutomationLaneToBackend(track.id, withResolvedLaneMode(track, lane, behavior, activeWriting));
  }
}

function syncMasterAutomationModesFromState(state: any, behavior: "touch" | "latch" | "overwrite") {
  const masterTrack = masterAutomationTrack(state);
  for (const lane of state.masterAutomationLanes || []) {
    const key = automationTouchKey("master", lane.param);
    const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
    syncAutomationLaneToBackend("master", withResolvedLaneMode(masterTrack, lane, behavior, activeWriting));
  }
}

function clearAutomationTouchState(trackId: string, param: string) {
  const key = automationTouchKey(trackId, param);
  const wasTouched = _automationTouchedParams.delete(key);
  const wasLatched = _automationLatchedParams.delete(key);
  const hadWriteValue = _automationWriteValues.delete(key);
  const hadTimer = _autoRecordTimers.delete(key);
  const hadSessionStart = _automationWriteSessionStartTimes.delete(key);
  nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
  return wasTouched || wasLatched || hadWriteValue || hadTimer || hadSessionStart;
}

function syncAutomationLaneAfterManualEdit(trackId: string, lane: any, resetWriteState: boolean) {
  if (!resetWriteState) {
    syncAutomationLaneToBackend(trackId, lane);
    return;
  }

  nativeBridge
    .setAutomationMode(trackId, lane.param, "read")
    .catch(logBridgeError("sync"))
    .then(() => syncAutomationLaneToBackend(trackId, lane));
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

      get().updateTrack(trackId, { type: "instrument", instrumentPlugin: pluginPath, builtInInstrument: undefined });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
      notifyInstrumentChanged({ trackId, instrumentPlugin: pluginPath });

      const command: Command = {
        type: "LOAD_INSTRUMENT",
        description: "Load instrument",
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.loadInstrument(trackId, pluginPath);
          get().updateTrack(trackId, { type: "instrument", instrumentPlugin: pluginPath, builtInInstrument: undefined });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: pluginPath });
        },
        undo: async () => {
          if (previousPlugin) {
            await nativeBridge.loadInstrument(trackId, previousPlugin);
            if (previousState) await nativeBridge.setInstrumentState(trackId, previousState);
            get().updateTrack(trackId, { type: "instrument", instrumentPlugin: previousPlugin, builtInInstrument: undefined });
            notifyInstrumentChanged({ trackId, instrumentPlugin: previousPlugin });
          } else {
            await nativeBridge.removeInstrument(trackId);
            get().updateTrack(trackId, { type: previousType || "midi", instrumentPlugin: undefined, builtInInstrument: track.builtInInstrument });
            notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
          }
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    setBuiltInInstrumentWithUndo: async (trackId, instrument) => {
      const track = get().tracks.find((t: any) => t.id === trackId);
      if (!track) return false;

      const modeMap: Record<string, number> = { synth: 0, piano: 1, drums: 2 };
      const mode = modeMap[instrument] ?? 0;
      const previousType = track.type;
      const previousPlugin = track.instrumentPlugin || "";
      const previousPluginState = previousPlugin
        ? await nativeBridge.getInstrumentState(trackId).catch(() => "")
        : "";
      const previousBuiltIn = track.builtInInstrument;
      const previousSamplePath = track.samplerSamplePath || "";
      const previousRootNote = track.samplerRootNote ?? 60;

      if (previousPlugin) await nativeBridge.removeInstrument(trackId).catch(() => false);
      if (previousSamplePath) await nativeBridge.clearTrackSamplerSample(trackId).catch(() => false);
      await nativeBridge.setTrackType(trackId, "instrument").catch(() => false);
      const success = await nativeBridge.setBuiltInPluginParam(
        { trackId, chain: "instrument", fxIndex: -1 },
        "instrumentMode",
        mode,
      );
      if (!success) return false;

      get().updateTrack(trackId, {
        type: "instrument",
        instrumentPlugin: undefined,
        builtInInstrument: instrument,
        samplerSamplePath: undefined,
        samplerSourceType: undefined,
      });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
      notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });

      const command: Command = {
        type: "LOAD_INSTRUMENT",
        description: `Load Studio13 ${instrument}`,
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.removeInstrument(trackId).catch(() => false);
          await nativeBridge.clearTrackSamplerSample(trackId).catch(() => false);
          await nativeBridge.setTrackType(trackId, "instrument").catch(() => false);
          await nativeBridge.setBuiltInPluginParam({ trackId, chain: "instrument", fxIndex: -1 }, "instrumentMode", mode);
          get().updateTrack(trackId, {
            type: "instrument",
            instrumentPlugin: undefined,
            builtInInstrument: instrument,
            samplerSamplePath: undefined,
            samplerSourceType: undefined,
          });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
        },
        undo: async () => {
          if (previousPlugin) {
            await nativeBridge.loadInstrument(trackId, previousPlugin);
            if (previousPluginState) await nativeBridge.setInstrumentState(trackId, previousPluginState);
            get().updateTrack(trackId, {
              type: previousType || "instrument",
              instrumentPlugin: previousPlugin,
              builtInInstrument: undefined,
            });
            notifyInstrumentChanged({ trackId, instrumentPlugin: previousPlugin });
          } else if (previousSamplePath) {
            await nativeBridge.setTrackSamplerSample(trackId, previousSamplePath, previousRootNote);
            get().updateTrack(trackId, {
              type: "instrument",
              instrumentPlugin: undefined,
              builtInInstrument: undefined,
              samplerSamplePath: previousSamplePath,
              samplerRootNote: previousRootNote,
              samplerSourceType: String(previousSamplePath).toLowerCase().endsWith(".sf2") ? "soundfont" : "audio",
            });
            notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
          } else {
            await nativeBridge.setTrackType(trackId, previousType || "instrument").catch(() => false);
            await nativeBridge.setBuiltInPluginParam(
              { trackId, chain: "instrument", fxIndex: -1 },
              "instrumentMode",
              modeMap[previousBuiltIn || "synth"] ?? 0,
            ).catch(() => false);
            get().updateTrack(trackId, {
              type: previousType || "instrument",
              instrumentPlugin: undefined,
              builtInInstrument: previousBuiltIn,
            });
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
        const previousBuiltIn = track.builtInInstrument;
        await nativeBridge.setTrackType(trackId, "midi").catch(() => false);
        get().updateTrack(trackId, { type: "midi", instrumentPlugin: undefined, builtInInstrument: undefined });
        await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });

        const command: Command = {
          type: "REMOVE_INSTRUMENT",
          description: "Remove basic synth",
          timestamp: Date.now(),
          execute: async () => {
            await nativeBridge.setTrackType(trackId, "midi").catch(() => false);
            get().updateTrack(trackId, { type: "midi", instrumentPlugin: undefined, builtInInstrument: undefined });
            await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
            notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
          },
          undo: async () => {
            await nativeBridge.setTrackType(trackId, previousType || "instrument").catch(() => false);
            if (previousBuiltIn) {
              const modeMap: Record<string, number> = { synth: 0, piano: 1, drums: 2 };
              await nativeBridge.setBuiltInPluginParam(
                { trackId, chain: "instrument", fxIndex: -1 },
                "instrumentMode",
                modeMap[previousBuiltIn] ?? 0,
              ).catch(() => false);
            }
            get().updateTrack(trackId, { type: previousType || "instrument", instrumentPlugin: undefined, builtInInstrument: previousBuiltIn });
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
        builtInInstrument: track.builtInInstrument,
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
            builtInInstrument: currentTrack?.builtInInstrument,
          });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: undefined });
        },
        undo: async () => {
          await nativeBridge.loadInstrument(trackId, previousPlugin);
          if (previousState) await nativeBridge.setInstrumentState(trackId, previousState);
          get().updateTrack(trackId, { type: previousType || "instrument", instrumentPlugin: previousPlugin, builtInInstrument: undefined });
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
        builtInInstrument: undefined,
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
            builtInInstrument: undefined,
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

    setAutomationWriteBehavior: (behavior) => {
      const nextBehavior = behavior === "latch" || behavior === "overwrite" ? behavior : "touch";
      set((s) => ({
        automationWriteBehavior: nextBehavior,
        tracks: s.tracks.map((track) => ({
          ...track,
          automationLanes: track.automationLanes.map((lane) =>
            withResolvedLaneMode(track, lane, nextBehavior, false),
          ),
        })),
        masterAutomationLanes: s.masterAutomationLanes.map((lane) =>
          withResolvedLaneMode(
            {
              id: "master",
              automationReadEnabled: s.masterAutomationReadEnabled,
              automationWriteEnabled: s.masterAutomationWriteEnabled,
            },
            lane,
            nextBehavior,
            false,
          ),
        ),
      }));
      _automationTouchedParams.clear();
      _automationLatchedParams.clear();
      _autoRecordTimers.clear();
      _automationWriteValues.clear();
      _automationWriteSessionStartTimes.clear();
      const state = get();
      for (const track of state.tracks) syncTrackAutomationModes(track, nextBehavior);
      for (const lane of state.masterAutomationLanes) {
        syncAutomationLaneToBackend(
          "master",
          withResolvedLaneMode(
            {
              id: "master",
              automationReadEnabled: state.masterAutomationReadEnabled,
              automationWriteEnabled: state.masterAutomationWriteEnabled,
            },
            lane,
            nextBehavior,
            false,
          ),
        );
      }
    },

    recordAutomationWriteTick: (nowMs = Date.now()) => {
      const state = get();
      if (!automationTransportRolling(state)) return;

      const time = state.transport.currentTime;
      const behavior = writeBehavior(get);
      const lanesToSync: Array<{
        trackId: string;
        lane: any;
        start: number;
        end: number;
        point: { time: number; value: number };
        syncFullLane: boolean;
      }> = [];

      set((s) => {
        let changed = false;
        const tracks = s.tracks.map((track) => {
          if (!trackWriteEnabled(track)) return track;

          let trackChanged = false;
          const automationLanes = track.automationLanes.map((lane) => {
            if (!automationLaneReadEnabled(lane))
              return lane;

            const key = automationTouchKey(track.id, lane.param);
            const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
            const shouldRecord = activeWriting;

            if (!shouldRecord)
              return lane;

            const lastRecorded = _autoRecordTimers.get(key) ?? 0;
            if (nowMs - lastRecorded < AUTO_RECORD_INTERVAL_MS)
              return lane;

            _autoRecordTimers.set(key, nowMs);
            const value = currentNormalizedAutomationValue(track, lane, time);
            const point = { time: Math.max(0, time), value: clamp01(value) };
            const writtenPoints = writeAutomationPoint(lane.points, time, point.value);
            const simplifiedWrite = simplifyContinuousAutomationWritePoints(
              lane.param,
              writtenPoints,
              point.time,
              _automationWriteSessionStartTimes.get(key),
            );
            const nextLane = {
              ...withResolvedLaneMode(track, lane, behavior, activeWriting),
              points: simplifiedWrite.points,
            };
            lanesToSync.push({
              trackId: track.id,
              lane: nextLane,
              start: Math.max(0, time - AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS),
              end: time + AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS,
              point,
              syncFullLane: simplifiedWrite.didSimplify,
            });
            trackChanged = true;
            changed = true;
            return nextLane;
          });

          return trackChanged ? { ...track, automationLanes } : track;
        });

        let masterChanged = false;
        let masterAutomationLanes = s.masterAutomationLanes;
        if (s.masterAutomationWriteEnabled) {
          const masterTrack = masterAutomationTrack(s);
          masterAutomationLanes = s.masterAutomationLanes.map((lane) => {
            if (!automationLaneReadEnabled(lane))
              return lane;

            const key = automationTouchKey("master", lane.param);
            const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
            if (!activeWriting)
              return lane;

            const lastRecorded = _autoRecordTimers.get(key) ?? 0;
            if (nowMs - lastRecorded < AUTO_RECORD_INTERVAL_MS)
              return lane;

            _autoRecordTimers.set(key, nowMs);
            const value = currentNormalizedAutomationValue(masterTrack, lane, time);
            const point = { time: Math.max(0, time), value: clamp01(value) };
            const writtenPoints = writeAutomationPoint(lane.points, time, point.value);
            const simplifiedWrite = simplifyContinuousAutomationWritePoints(
              lane.param,
              writtenPoints,
              point.time,
              _automationWriteSessionStartTimes.get(key),
            );
            const nextLane = {
              ...withResolvedLaneMode(masterTrack, lane, behavior, activeWriting),
              points: simplifiedWrite.points,
            };
            lanesToSync.push({
              trackId: "master",
              lane: nextLane,
              start: Math.max(0, time - AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS),
              end: time + AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS,
              point,
              syncFullLane: simplifiedWrite.didSimplify,
            });
            masterChanged = true;
            changed = true;
            return nextLane;
          });
        }

        return changed ? { tracks, masterAutomationLanes, isModified: true } : s;
      });

      for (const { trackId, lane, start, end, point, syncFullLane } of lanesToSync) {
        if (syncFullLane) {
          syncAutomationLaneToBackend(trackId, lane);
          continue;
        }

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
      const behavior = writeBehavior(get);
      _automationTouchedParams.clear();
      _automationLatchedParams.clear();
      _autoRecordTimers.clear();
      _automationWriteValues.clear();
      _automationWriteSessionStartTimes.clear();
      if (behavior === "overwrite") {
        set((s) => ({
          tracks: s.tracks.map((track) => {
            if (!trackWriteEnabled(track)) return track;
            return {
              ...track,
              automationLanes: track.automationLanes.map((lane) =>
                withResolvedLaneMode(track, lane, behavior, false),
              ),
            };
          }),
          masterAutomationLanes: s.masterAutomationLanes.map((lane) =>
            withResolvedLaneMode(
              {
                id: "master",
                automationReadEnabled: s.masterAutomationReadEnabled,
                automationWriteEnabled: s.masterAutomationWriteEnabled,
              },
              lane,
              behavior,
              false,
            ),
          ),
        }));
        const state = get();
        for (const track of state.tracks) {
          if (!trackWriteEnabled(track)) continue;
          syncTrackAutomationModes(track, behavior);
        }
        for (const lane of state.masterAutomationLanes) {
          syncAutomationLaneToBackend(
            "master",
            withResolvedLaneMode(
              {
                id: "master",
                automationReadEnabled: state.masterAutomationReadEnabled,
                automationWriteEnabled: state.masterAutomationWriteEnabled,
              },
              lane,
              behavior,
              false,
            ),
          );
        }
      }
    },

    setAutomationWriteValue: (trackId, param, value) => {
      if (!automationTransportRolling(get())) {
        clearAutomationTouchState(trackId, param);
        return;
      }
      if (trackId === "master") {
        const state = get();
        if (!state.masterAutomationWriteEnabled) return;
        const keepMasterRead = state.masterAutomationReadEnabled === true;
        const existing = state.masterAutomationLanes.find((l) => l.param === param);
        if (!existing) {
          get().addMasterAutomationLane(param);
          if (!keepMasterRead) get().setMasterAutomationRead(false);
        } else if (!automationLaneReadEnabled(existing)) {
          get().setMasterAutomationLaneRead(existing.id, true);
        }
        _automationWriteValues.set(automationTouchKey(trackId, param), clamp01(value));
        return;
      }
      const track = get().tracks.find((t) => t.id === trackId);
      if (track && trackWriteEnabled(track)) {
        const keepTrackRead = trackReadEnabled(track);
        const existing = track.automationLanes.find((l) => l.param === param);
        if (!existing) {
          get().addAutomationLane(trackId, param);
          if (!keepTrackRead) get().setTrackAutomationRead(trackId, false);
        } else if (!automationLaneReadEnabled(existing)) {
          get().setAutomationLaneRead(trackId, existing.id, true);
        }
      }
      _automationWriteValues.set(automationTouchKey(trackId, param), clamp01(value));
    },

    beginAutomationParamTouch: (trackId, param) => {
      if (!automationTransportRolling(get())) {
        clearAutomationTouchState(trackId, param);
        return;
      }
      if (trackId === "master") {
        const state = get();
        if (!state.masterAutomationWriteEnabled) return;
        const keepMasterRead = state.masterAutomationReadEnabled === true;
        let lane = state.masterAutomationLanes.find((l) => l.param === param);
        if (!lane) {
          const laneId = get().addMasterAutomationLane(param);
          if (!keepMasterRead) get().setMasterAutomationRead(false);
          lane = get().masterAutomationLanes.find((l) => l.id === laneId);
        }
        if (!lane) return;
        if (!automationLaneReadEnabled(lane)) {
          get().setMasterAutomationLaneRead(lane.id, true);
          lane = get().masterAutomationLanes.find((l) => l.id === lane.id) ?? lane;
        }
        const key = automationTouchKey(trackId, param);
        const behavior = writeBehavior(get);
        _automationTouchedParams.add(key);
        if (!_automationWriteSessionStartTimes.has(key))
          _automationWriteSessionStartTimes.set(key, Math.max(0, get().transport?.currentTime ?? 0));
        if (behavior === "latch" || behavior === "overwrite") _automationLatchedParams.add(key);
        else _automationLatchedParams.delete(key);

        set((s) => {
          const masterTrack = masterAutomationTrack(s);
          return {
            showMasterAutomation: true,
            masterAutomationLanes: s.masterAutomationLanes.map((candidateLane) =>
              candidateLane.param === param
                ? { ...withResolvedLaneMode(masterTrack, candidateLane, behavior, true), visible: true }
                : candidateLane,
            ),
          };
        });

        const updatedState = get();
        const updatedLane = updatedState.masterAutomationLanes.find((l) => l.param === param);
        if (updatedLane)
          syncAutomationLaneToBackend(
            "master",
            withResolvedLaneMode(masterAutomationTrack(updatedState), updatedLane, behavior, true),
          );
        if (behavior !== "overwrite")
          nativeBridge.beginTouchAutomation(trackId, param).catch(() => {});
        return;
      }
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track || !trackWriteEnabled(track)) return;
      const keepTrackRead = trackReadEnabled(track);
      let lane = track.automationLanes.find((l) => l.param === param);
      if (!lane) {
        const laneId = get().addAutomationLane(trackId, param);
        if (!keepTrackRead) get().setTrackAutomationRead(trackId, false);
        lane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
      }
      if (!lane) return;
      if (!automationLaneReadEnabled(lane)) {
        get().setAutomationLaneRead(trackId, lane.id, true);
        lane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === lane.id) ?? lane;
      }
      const key = automationTouchKey(trackId, param);
      const behavior = writeBehavior(get);
      _automationTouchedParams.add(key);
      if (!_automationWriteSessionStartTimes.has(key))
        _automationWriteSessionStartTimes.set(key, Math.max(0, get().transport?.currentTime ?? 0));
      if (behavior === "latch" || behavior === "overwrite") _automationLatchedParams.add(key);
      else _automationLatchedParams.delete(key);

      const activeWriting = true;
      set((s) => ({
        tracks: s.tracks.map((candidate) => {
          if (candidate.id !== trackId) return candidate;
          return {
            ...candidate,
            showAutomation: true,
            automationLanes: candidate.automationLanes.map((candidateLane) =>
              candidateLane.param === param
                ? { ...withResolvedLaneMode(candidate, candidateLane, behavior, activeWriting), visible: true }
                : candidateLane,
            ),
          };
        }),
      }));

      const updatedTrack = get().tracks.find((t) => t.id === trackId);
      const updatedLane = updatedTrack?.automationLanes.find((l) => l.param === param);
      if (updatedTrack && updatedLane)
        syncAutomationLaneToBackend(trackId, withResolvedLaneMode(updatedTrack, updatedLane, behavior, activeWriting));
      if (behavior !== "overwrite")
        nativeBridge.beginTouchAutomation(trackId, param).catch(() => {});
    },

    endAutomationParamTouch: (trackId, param) => {
      if (trackId === "master") {
        const lane = get().masterAutomationLanes.find((l) => l.param === param);
        if (!lane) return;
        const key = automationTouchKey(trackId, param);
        const behavior = writeBehavior(get);
        _automationTouchedParams.delete(key);
        if (behavior === "touch") {
          _automationLatchedParams.delete(key);
          _automationWriteSessionStartTimes.delete(key);
        }
        if (behavior !== "overwrite")
          nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
        return;
      }
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.param === param);
      if (!lane) return;
      const key = automationTouchKey(trackId, param);
      const behavior = writeBehavior(get);
      _automationTouchedParams.delete(key);
      if (behavior === "touch") {
        _automationLatchedParams.delete(key);
        _automationWriteSessionStartTimes.delete(key);
      }
      if (behavior !== "overwrite")
        nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
    },

    setTrackAutomationRead: (trackId, enabled) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      if (track.automationLanes.length === 0 && !trackWriteEnabled(track)) return;
      const behavior = writeBehavior(get);
      const nextRead = Boolean(enabled);
      for (const lane of track.automationLanes) {
        if (!nextRead) clearAutomationTouchState(trackId, lane.param);
      }
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const nextTrack = {
            ...t,
            automationReadEnabled: nextRead,
            automationEnabled: nextRead,
          };
          return {
            ...nextTrack,
            automationLanes: t.automationLanes.map((lane) =>
              withResolvedLaneMode(nextTrack, lane, behavior, false),
            ),
          };
        }),
      }));
      const updatedTrack = get().tracks.find((t) => t.id === trackId);
      if (updatedTrack) syncTrackAutomationModes(updatedTrack, behavior);
      if (!nextRead) {
        set((s) => {
          const automatedParamValues = { ...s.automatedParamValues };
          delete automatedParamValues[trackId];
          return { automatedParamValues };
        });
        nativeBridge.setTrackVolume(trackId, track.volumeDB).catch(logBridgeError("sync"));
        nativeBridge.setTrackPan(trackId, track.pan).catch(logBridgeError("sync"));
        nativeBridge.setTrackMute(trackId, track.muted).catch(logBridgeError("sync"));
      } else {
        get().updateAutomatedValues();
      }
    },

    toggleTrackAutomationRead: (trackId) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      get().setTrackAutomationRead(trackId, !trackReadEnabled(track));
    },

    setTrackAutomationWrite: (trackId, enabled) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      const behavior = writeBehavior(get);
      const nextWrite = Boolean(enabled);
      for (const lane of track.automationLanes) {
        if (!nextWrite) clearAutomationTouchState(trackId, lane.param);
      }
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const keepReadOn = trackReadEnabled(t) && t.automationLanes.length > 0;
          const nextTrack = {
            ...t,
            automationReadEnabled: nextWrite ? true : keepReadOn,
            automationWriteEnabled: nextWrite,
            automationEnabled: nextWrite ? true : keepReadOn,
          };
          return {
            ...nextTrack,
            automationLanes: t.automationLanes.map((lane) =>
              withResolvedLaneMode(nextTrack, lane, behavior, false),
            ),
          };
        }),
      }));
      const updatedTrack = get().tracks.find((t) => t.id === trackId);
      if (updatedTrack) syncTrackAutomationModes(updatedTrack, behavior);
      get().updateAutomatedValues();
    },

    toggleTrackAutomationWrite: (trackId) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      get().setTrackAutomationWrite(trackId, !trackWriteEnabled(track));
    },

    toggleTrackAutomationEnabled: (trackId) => {
      get().toggleTrackAutomationRead(trackId);
    },

    addAutomationLane: (trackId, param, _label) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return null;
      const behavior = writeBehavior(get);
      // Don't add duplicate lanes for the same param
      const existing = track.automationLanes.find((l) => l.param === param);
      if (existing) {
        set((s) => ({
          tracks: s.tracks.map((t) => {
            if (t.id !== trackId) return t;
            const nextTrack = {
              ...t,
              automationReadEnabled: true,
              automationEnabled: true,
              showAutomation: true,
            };
            return {
              ...nextTrack,
              automationLanes: t.automationLanes.map((lane) =>
                lane.id === existing.id
                  ? withResolvedLaneMode(nextTrack, { ...lane, visible: true, readEnabled: true }, behavior, false)
                  : lane,
              ),
            };
          }),
          isModified: true,
        }));
        const updatedTrack = get().tracks.find((t) => t.id === trackId);
        const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === existing.id);
        if (updatedTrack && updatedLane) syncAutomationLaneToBackend(trackId, updatedLane);
        return existing.id;
      }
      const laneId = `lane_${param}_${Date.now()}`;
      const baseLane: AutomationLane = { id: laneId, param, points: [], visible: true, mode: "read", armed: false, readEnabled: true };
      const nextTrackForLane = {
        ...track,
        automationReadEnabled: true,
        automationEnabled: true,
      };
      const newLane: AutomationLane = withResolvedLaneMode(nextTrackForLane, baseLane, behavior, false);
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationReadEnabled: true,
            automationEnabled: true,
            automationLanes: [...t.automationLanes, newLane],
            showAutomation: true,
          };
        }),
        isModified: true,
      }));
      const updatedTrack = get().tracks.find((t) => t.id === trackId);
      const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
      if (updatedTrack && updatedLane) syncAutomationLaneToBackend(trackId, updatedLane);
      return laneId;
    },

    addAutomationPoint: (trackId, laneId, time, value) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      const laneParam = lane.param;
      const oldPoints = [...lane.points];
      const oldTrackRead = trackReadEnabled(track);
      const oldTrackWrite = trackWriteEnabled(track);
      const oldLaneRead = automationLaneReadEnabled(lane);
      const oldLaneMode = lane.mode;
      const newPoints = [...lane.points, { time: Math.max(0, time), value: clamp01(value) }].sort((a, b) => a.time - b.time);
      const applyPoints = (points, options?: { restoreReadState?: boolean }) => {
        const behavior = writeBehavior(get);
        set((s) => ({
          tracks: s.tracks.map((t) => {
            if (t.id !== trackId) return t;
            const nextTrack = options?.restoreReadState
              ? {
                  ...t,
                  automationReadEnabled: oldTrackRead,
                  automationWriteEnabled: oldTrackWrite,
                  automationEnabled: oldTrackRead,
                }
              : {
                  ...t,
                  automationReadEnabled: true,
                  automationEnabled: true,
                };
            return {
              ...nextTrack,
              automationLanes: t.automationLanes.map((candidate) => {
                if (candidate.id !== laneId) return candidate;
                const nextLane = options?.restoreReadState
                  ? { ...candidate, points, readEnabled: oldLaneRead, mode: oldLaneMode }
                  : { ...candidate, points, readEnabled: true };
                return withResolvedLaneMode(nextTrack, nextLane, behavior, false);
              }),
            };
          }),
          isModified: true,
        }));
        const updatedTrack = get().tracks.find((t) => t.id === trackId);
        const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
        const resetWriteState = clearAutomationTouchState(trackId, laneParam) || trackWriteEnabled(updatedTrack);
        if (updatedLane) syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
      };
      commandManager.execute({
        type: "AUTOMATION_POINT_ADD",
        description: "Add automation point",
        timestamp: Date.now(),
        execute: () => applyPoints(newPoints),
        undo: () => applyPoints(oldPoints, { restoreReadState: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeAutomationPoint: (trackId, laneId, pointIndex) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const laneParam = lane.param;
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
        const updatedTrack = get().tracks.find((t) => t.id === trackId);
        const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
        const resetWriteState = clearAutomationTouchState(trackId, laneParam) || trackWriteEnabled(updatedTrack);
        if (updatedLane) syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
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
      const laneParam = lane.param;
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
        const updatedTrack = get().tracks.find((t) => t.id === trackId);
        const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
        const resetWriteState = clearAutomationTouchState(trackId, laneParam) || trackWriteEnabled(updatedTrack);
        if (updatedLane) syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
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

    setAutomationLanePoints: (trackId, laneId, points, options = {}) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!track || !lane) return;

      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(options.oldPoints ?? lane.points);
      const oldTrackRead = options.oldTrackRead ?? trackReadEnabled(track);
      const oldTrackWrite = options.oldTrackWrite ?? trackWriteEnabled(track);
      const oldLaneRead = options.oldLaneRead ?? automationLaneReadEnabled(lane);
      const oldLaneMode = options.oldLaneMode ?? lane.mode;
      const nextPoints = normalizeAutomationPoints(points);

      const applyPoints = (targetPoints, applyOptions?: { restoreReadState?: boolean }) => {
        const behavior = writeBehavior(get);
        set((s) => ({
          tracks: s.tracks.map((t) => {
            if (t.id !== trackId) return t;
            const nextTrack = applyOptions?.restoreReadState
              ? {
                  ...t,
                  automationReadEnabled: oldTrackRead,
                  automationWriteEnabled: oldTrackWrite,
                  automationEnabled: oldTrackRead,
                }
              : {
                  ...t,
                  automationReadEnabled: true,
                  automationEnabled: true,
                };
            return {
              ...nextTrack,
              automationLanes: t.automationLanes.map((candidate) => {
                if (candidate.id !== laneId) return candidate;
                const nextLane = applyOptions?.restoreReadState
                  ? {
                      ...candidate,
                      points: normalizeAutomationPoints(targetPoints),
                      readEnabled: oldLaneRead,
                      mode: oldLaneMode,
                    }
                  : {
                      ...candidate,
                      points: normalizeAutomationPoints(targetPoints),
                      readEnabled: true,
                    };
                return withResolvedLaneMode(nextTrack, nextLane, behavior, false);
              }),
            };
          }),
          isModified: true,
        }));

        const updatedTrack = get().tracks.find((t) => t.id === trackId);
        const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
        const resetWriteState = clearAutomationTouchState(trackId, laneParam) || trackWriteEnabled(updatedTrack);
        if (updatedLane) syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
      };

      if (options.undoable) {
        applyPoints(nextPoints);
        commandManager.push({
          type: "AUTOMATION_LANE_DRAW",
          description: options.description ?? "Draw automation",
          timestamp: Date.now(),
          execute: () => applyPoints(nextPoints),
          undo: () => applyPoints(oldPoints, { restoreReadState: true }),
        });
        set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        return;
      }

      applyPoints(nextPoints);
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

    setAutomationLaneRead: (trackId, laneId, enabled) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!track || !lane) return;
      const behavior = writeBehavior(get);
      if (!enabled) clearAutomationTouchState(trackId, lane.param);
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((candidate) =>
              candidate.id === laneId
                ? withResolvedLaneMode(t, { ...candidate, readEnabled: Boolean(enabled) }, behavior, false)
                : candidate,
            ),
          };
        }),
      }));
      const updatedTrack = get().tracks.find((t) => t.id === trackId);
      const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
      if (updatedTrack && updatedLane)
        syncAutomationLaneToBackend(trackId, withResolvedLaneMode(updatedTrack, updatedLane, behavior, false));
      get().updateAutomatedValues();
    },

    toggleAutomationLaneRead: (trackId, laneId) => {
      const lane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      get().setAutomationLaneRead(trackId, laneId, !automationLaneReadEnabled(lane));
    },

    clearAutomationLane: (trackId, laneId) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      const laneParam = lane.param;
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
        const updatedTrack = get().tracks.find((t) => t.id === trackId);
        const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
        const resetWriteState = clearAutomationTouchState(trackId, laneParam) || trackWriteEnabled(updatedTrack);
        if (updatedLane) syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
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
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationReadEnabled: readEnabled ? true : t.automationReadEnabled,
            automationWriteEnabled: shouldWrite ? true : (mode === "read" || mode === "off" ? false : t.automationWriteEnabled),
            automationEnabled: readEnabled ? true : t.automationEnabled,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, mode, readEnabled, armed: shouldWrite } : lane,
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
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationReadEnabled: readEnabled,
            automationWriteEnabled: shouldWrite,
            automationEnabled: readEnabled,
            automationLanes: t.automationLanes.map((lane) => ({ ...lane, mode, readEnabled, armed: shouldWrite })),
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
