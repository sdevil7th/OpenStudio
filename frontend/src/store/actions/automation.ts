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
import type { FXChainType } from "../../utils/fxChain";
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

export function isAutomationEditLocked(state: any): boolean {
  return Boolean(state?.globalLocked || state?.lockSettings?.envelopes);
}

function buildAutomationSuspendSnapshot(track: any) {
  return {
    showAutomation: track.showAutomation,
    automationReadEnabled: trackReadEnabled(track),
    automationWriteEnabled: trackWriteEnabled(track),
    automationEnabled: trackReadEnabled(track),
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
const _automationWriteSessionSnapshots = new Map<string, {
  trackId: string;
  laneId: string;
  points: any[];
}>();

let _automationPointEditSnapshot: null | {
  target: any;
  originalPoints: any[];
  originalIsModified: boolean;
  editKind: "move" | "copy";
  workingPointCount: number;
  originalSourcePoint: null | { time: number; value: number };
} = null;

let _automationPointIdCounter = 0;

export function createAutomationPointId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  _automationPointIdCounter += 1;
  return `automation-point-${Date.now()}-${_automationPointIdCounter}`;
}

export function getAutomationPointId(point: any, index: number) {
  const time = Math.max(0, Number(point?.time) || 0);
  const value = clamp01(Number(point?.value));
  return typeof point?.id === "string" && point.id.length > 0
    ? point.id
    : `legacy-automation-point-${index}-${Math.round(time * 1_000_000)}-${Math.round(value * 1_000_000)}`;
}

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
    .concat([{ id: createAutomationPointId(), time: Math.max(0, time), value: clamp01(value) }]);
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
    .map((point, index) => {
      const time = Math.max(0, Number(point?.time) || 0);
      const value = clamp01(Number(point?.value));
      const id = getAutomationPointId(point, index);
      return { id, time, value };
    })
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

function captureTrackAutomationModeSnapshot(state: any, trackId: string) {
  const track = state.tracks.find((candidate: any) => candidate.id === trackId);
  if (!track) return null;
  return {
    trackId,
    automationReadEnabled: track.automationReadEnabled,
    automationWriteEnabled: track.automationWriteEnabled,
    automationEnabled: track.automationEnabled,
    automationLanes: (track.automationLanes || []).map((lane: any) => ({ ...lane })),
    hadAutomatedValues: Object.prototype.hasOwnProperty.call(state.automatedParamValues || {}, trackId),
    automatedValues: state.automatedParamValues?.[trackId]
      ? { ...state.automatedParamValues[trackId] }
      : undefined,
  };
}

function applyTrackAutomationModeSnapshot(set: SetFn, get: GetFn, snapshot: any) {
  if (!snapshot) return;
  set((state: any) => {
    const automatedParamValues = { ...(state.automatedParamValues || {}) };
    if (snapshot.hadAutomatedValues) {
      automatedParamValues[snapshot.trackId] = { ...(snapshot.automatedValues || {}) };
    } else {
      delete automatedParamValues[snapshot.trackId];
    }
    return {
      tracks: state.tracks.map((track: any) => track.id === snapshot.trackId
        ? {
            ...track,
            automationReadEnabled: snapshot.automationReadEnabled,
            automationWriteEnabled: snapshot.automationWriteEnabled,
            automationEnabled: snapshot.automationEnabled,
            automationLanes: snapshot.automationLanes.map((lane: any) => ({ ...lane })),
          }
        : track),
      automatedParamValues,
      isModified: true,
    };
  });
  const track = get().tracks.find((candidate: any) => candidate.id === snapshot.trackId);
  if (!track) return;
  if (!snapshot.automationReadEnabled || !snapshot.automationWriteEnabled) {
    for (const lane of track.automationLanes || []) {
      clearAutomationTouchState(track.id, lane.param);
    }
  }
  syncTrackAutomationModes(track, writeBehavior(get));
  if (!snapshot.automationReadEnabled) {
    nativeBridge.setTrackVolume(track.id, track.volumeDB).catch(logBridgeError("sync"));
    nativeBridge.setTrackPan(track.id, track.pan).catch(logBridgeError("sync"));
    nativeBridge.setTrackMute(track.id, track.muted).catch(logBridgeError("sync"));
  } else {
    get().updateAutomatedValues?.();
  }
}

function cloneAutomationLane(lane: any) {
  return {
    ...lane,
    points: normalizeAutomationPoints(lane?.points || []),
  };
}

type TrackFXAutomationChain = "input" | "track";

function parseTrackFXAutomationParam(
  param: string,
): null | { chainType: TrackFXAutomationChain; fxIndex: number; suffix: string } {
  const match = /^(builtin|plugin)_(input|track)_(\d+)_(.+)$/.exec(String(param));
  if (!match) return null;
  return {
    chainType: match[2] as TrackFXAutomationChain,
    fxIndex: Number(match[3]),
    suffix: `${match[1]}_${match[2]}_#_${match[4]}`,
  };
}

function replaceTrackFXAutomationIndex(
  parsed: NonNullable<ReturnType<typeof parseTrackFXAutomationParam>>,
  fxIndex: number,
) {
  return parsed.suffix.replace("_#_", `_${fxIndex}_`);
}

export function remapTrackFXAutomationLanes(
  lanes: readonly any[],
  chainType: TrackFXAutomationChain,
  mapIndex: (fxIndex: number) => number | null,
) {
  const next: any[] = [];
  for (const lane of lanes || []) {
    const parsed = parseTrackFXAutomationParam(lane?.param);
    if (!parsed || parsed.chainType !== chainType) {
      next.push(cloneAutomationLane(lane));
      continue;
    }

    const mappedIndex = mapIndex(parsed.fxIndex);
    if (mappedIndex === null) continue;
    next.push({
      ...cloneAutomationLane(lane),
      param: replaceTrackFXAutomationIndex(parsed, mappedIndex),
    });
  }
  return next;
}

export function reorderTrackFXAutomationLanes(
  lanes: readonly any[],
  chainType: TrackFXAutomationChain,
  fromIndex: number,
  toIndex: number,
) {
  return remapTrackFXAutomationLanes(lanes, chainType, (fxIndex) => {
    if (fxIndex === fromIndex) return toIndex;
    if (fromIndex < toIndex && fxIndex > fromIndex && fxIndex <= toIndex) return fxIndex - 1;
    if (fromIndex > toIndex && fxIndex >= toIndex && fxIndex < fromIndex) return fxIndex + 1;
    return fxIndex;
  });
}

export function removeTrackFXAutomationLanes(
  lanes: readonly any[],
  chainType: TrackFXAutomationChain,
  removedIndex: number,
) {
  return remapTrackFXAutomationLanes(lanes, chainType, (fxIndex) => {
    if (fxIndex === removedIndex) return null;
    return fxIndex > removedIndex ? fxIndex - 1 : fxIndex;
  });
}

function applyTrackFXFrontendState(
  set: SetFn,
  get: GetFn,
  trackId: string,
  chainType: TrackFXAutomationChain,
  fxCount: number,
  automationLanes: readonly any[],
) {
  const countField = chainType === "input" ? "inputFxCount" : "trackFxCount";
  const clonedLanes = automationLanes.map(cloneAutomationLane);
  set((state: any) => ({
    tracks: state.tracks.map((track: any) => track.id === trackId
      ? { ...track, [countField]: fxCount, automationLanes: clonedLanes }
      : track),
    isModified: true,
  }));
  const updatedTrack = get().tracks.find((track: any) => track.id === trackId);
  for (const lane of updatedTrack?.automationLanes || []) {
    syncAutomationLaneToBackend(trackId, lane);
  }
  notifyFXChainChanged({ trackId, chainType });
}

function cloneAutomationSuspendSnapshot(snapshot: any) {
  if (!snapshot) return null;
  return {
    ...snapshot,
    lanes: Object.fromEntries(
      Object.entries(snapshot.lanes || {}).map(([laneId, laneState]) => [
        laneId,
        { ...(laneState as any) },
      ]),
    ),
  };
}

export function captureAutomationProjectSnapshot(state: any) {
  return {
    automationWriteBehavior: state.automationWriteBehavior ?? "touch",
    tracks: (state.tracks || []).map((track: any) => ({
      id: track.id,
      showAutomation: Boolean(track.showAutomation),
      automationReadEnabled: trackReadEnabled(track),
      automationWriteEnabled: trackWriteEnabled(track),
      automationEnabled: trackReadEnabled(track),
      suspendedAutomationState: cloneAutomationSuspendSnapshot(track.suspendedAutomationState),
      automationLanes: (track.automationLanes || []).map(cloneAutomationLane),
    })),
    showMasterAutomation: Boolean(state.showMasterAutomation),
    masterAutomationReadEnabled: state.masterAutomationReadEnabled === true,
    masterAutomationWriteEnabled: state.masterAutomationWriteEnabled === true,
    masterAutomationEnabled: state.masterAutomationEnabled === true,
    suspendedMasterAutomationState: cloneAutomationSuspendSnapshot(
      state.suspendedMasterAutomationState,
    ),
    masterAutomationLanes: (state.masterAutomationLanes || []).map(cloneAutomationLane),
  };
}

function automationProjectSnapshotsEqual(before: any, after: any) {
  return JSON.stringify(before) === JSON.stringify(after);
}

export function applyAutomationProjectSnapshot(
  set: SetFn,
  get: GetFn,
  snapshot: any,
) {
  const beforeLaneParams = new Map<string, { trackId: string; param: string }>();
  const currentState = get();
  for (const track of currentState.tracks || []) {
    for (const lane of track.automationLanes || []) {
      beforeLaneParams.set(`${track.id}\u0000${lane.param}`, {
        trackId: track.id,
        param: lane.param,
      });
    }
  }
  for (const lane of currentState.masterAutomationLanes || []) {
    beforeLaneParams.set(`master\u0000${lane.param}`, {
      trackId: "master",
      param: lane.param,
    });
  }
  const targetLaneParams = new Set<string>();
  for (const track of snapshot.tracks || []) {
    for (const lane of track.automationLanes || []) {
      targetLaneParams.add(`${track.id}\u0000${lane.param}`);
    }
  }
  for (const lane of snapshot.masterAutomationLanes || []) {
    targetLaneParams.add(`master\u0000${lane.param}`);
  }
  const byTrackId = new Map(
    (snapshot.tracks || []).map((track: any) => [track.id, track]),
  );
  set((state: any) => ({
    automationWriteBehavior: snapshot.automationWriteBehavior,
    tracks: state.tracks.map((track: any) => {
      const saved: any = byTrackId.get(track.id);
      if (!saved) return track;
      return {
        ...track,
        showAutomation: saved.showAutomation,
        automationReadEnabled: saved.automationReadEnabled,
        automationWriteEnabled: saved.automationWriteEnabled,
        automationEnabled: saved.automationEnabled,
        suspendedAutomationState: cloneAutomationSuspendSnapshot(
          saved.suspendedAutomationState,
        ),
        automationLanes: saved.automationLanes.map(cloneAutomationLane),
      };
    }),
    showMasterAutomation: snapshot.showMasterAutomation,
    masterAutomationReadEnabled: snapshot.masterAutomationReadEnabled,
    masterAutomationWriteEnabled: snapshot.masterAutomationWriteEnabled,
    masterAutomationEnabled: snapshot.masterAutomationEnabled,
    suspendedMasterAutomationState: cloneAutomationSuspendSnapshot(
      snapshot.suspendedMasterAutomationState,
    ),
    masterAutomationLanes: snapshot.masterAutomationLanes.map(cloneAutomationLane),
    isModified: true,
  }));

  _automationTouchedParams.clear();
  _automationLatchedParams.clear();
  _autoRecordTimers.clear();
  _automationWriteValues.clear();
  _automationWriteSessionStartTimes.clear();

  const state = get();
  for (const [key, removed] of beforeLaneParams) {
    if (!targetLaneParams.has(key)) {
      nativeBridge.clearAutomation(removed.trackId, removed.param).catch(() => {});
    }
  }
  for (const track of state.tracks || []) {
    for (const lane of track.automationLanes || []) {
      syncAutomationLaneToBackend(track.id, lane);
    }
  }
  for (const lane of state.masterAutomationLanes || []) {
    syncAutomationLaneToBackend("master", lane);
  }
  state.updateAutomatedValues?.();
}

export function pushAppliedAutomationProjectCommand(
  set: SetFn,
  get: GetFn,
  before: any,
  after: any,
  type: string,
  description: string,
) {
  if (automationProjectSnapshotsEqual(before, after)) return false;
  commandManager.push({
    type,
    description,
    timestamp: Date.now(),
    execute: () => applyAutomationProjectSnapshot(set, get, after),
    undo: () => applyAutomationProjectSnapshot(set, get, before),
  });
  set({
    canUndo: commandManager.canUndo(),
    canRedo: commandManager.canRedo(),
    isModified: true,
  });
  return true;
}

function resolveAutomationLaneTarget(state: any, target = state.selectedAutomationTarget) {
  if (!target || typeof target.laneId !== "string") return null;
  if (target.kind === "master") {
    const lane = (state.masterAutomationLanes || []).find(
      (candidate: any) => candidate.id === target.laneId,
    );
    return lane ? { target, track: null, lane, trackId: "master" } : null;
  }
  if (target.kind !== "track" || typeof target.trackId !== "string") return null;
  const track = (state.tracks || []).find(
    (candidate: any) => candidate.id === target.trackId,
  );
  const lane = track?.automationLanes?.find(
    (candidate: any) => candidate.id === target.laneId,
  );
  return track && lane ? { target, track, lane, trackId: track.id } : null;
}

function resolveAutomationPointTarget(state: any, target = state.selectedAutomationTarget) {
  const resolved = resolveAutomationLaneTarget(state, target);
  if (!resolved || typeof target?.pointId !== "string") return null;
  const pointIndex = resolved.lane.points.findIndex(
    (point: any, index: number) => getAutomationPointId(point, index) === target.pointId,
  );
  if (pointIndex < 0) return null;
  return { ...resolved, pointIndex, point: resolved.lane.points[pointIndex] };
}

function applyAutomationTargetPoints(
  set: SetFn,
  get: GetFn,
  target: any,
  points: any[],
  pointId: string | null,
) {
  const normalized = points.map((point) => ({
    id: typeof point?.id === "string" && point.id.length > 0
      ? point.id
      : createAutomationPointId(),
    time: Math.max(0, Number(point?.time) || 0),
    value: clamp01(Number(point?.value)),
  }));
  if (target.kind === "master") {
    set((state: any) => ({
      masterAutomationLanes: state.masterAutomationLanes.map((lane: any) =>
        lane.id === target.laneId ? { ...lane, points: normalized } : lane,
      ),
      selectedAutomationTarget: {
        kind: "master",
        laneId: target.laneId,
        pointId,
      },
      isModified: true,
    }));
    const lane = get().masterAutomationLanes.find(
      (candidate: any) => candidate.id === target.laneId,
    );
    if (lane) syncAutomationLaneToBackend("master", lane);
    return;
  }

  set((state: any) => ({
    tracks: state.tracks.map((track: any) => track.id !== target.trackId
      ? track
      : {
          ...track,
          automationLanes: track.automationLanes.map((lane: any) =>
            lane.id === target.laneId ? { ...lane, points: normalized } : lane,
          ),
        }),
    selectedAutomationTarget: {
      kind: "track",
      trackId: target.trackId,
      laneId: target.laneId,
      pointId,
    },
    isModified: true,
  }));
  const lane = get().tracks.find((track: any) => track.id === target.trackId)
    ?.automationLanes.find((candidate: any) => candidate.id === target.laneId);
  if (lane) syncAutomationLaneAfterManualEdit(target.trackId, lane, false);
}

function applyRecordedAutomationWritePass(
  set: SetFn,
  get: GetFn,
  changes: Array<{
    trackId: string;
    laneId: string;
    beforePoints: any[];
    afterPoints: any[];
  }>,
  side: "beforePoints" | "afterPoints",
) {
  set((state: any) => ({
    tracks: state.tracks.map((track: any) => ({
      ...track,
      automationLanes: track.automationLanes.map((lane: any) => {
        const change = changes.find(
          (candidate) => candidate.trackId === track.id && candidate.laneId === lane.id,
        );
        return change ? { ...lane, points: normalizeAutomationPoints(change[side]) } : lane;
      }),
    })),
    masterAutomationLanes: state.masterAutomationLanes.map((lane: any) => {
      const change = changes.find(
        (candidate) => candidate.trackId === "master" && candidate.laneId === lane.id,
      );
      return change ? { ...lane, points: normalizeAutomationPoints(change[side]) } : lane;
    }),
    isModified: true,
  }));

  const state = get();
  for (const change of changes) {
    const lane = change.trackId === "master"
      ? state.masterAutomationLanes.find((candidate: any) => candidate.id === change.laneId)
      : state.tracks.find((track: any) => track.id === change.trackId)
        ?.automationLanes.find((candidate: any) => candidate.id === change.laneId);
    if (lane) syncAutomationLaneToBackend(change.trackId, lane);
  }
  state.updateAutomatedValues?.();
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

    addTrackBuiltInFXWithUndo: async (
      trackId: string,
      effectName: string,
      chainType: TrackFXAutomationChain,
    ) => {
      const state = get();
      const track = state.tracks.find((candidate: any) => candidate.id === trackId);
      if (!track || state.globalLocked || track.frozen || !String(effectName).trim()) return false;

      const beforeSlots = await getFXChainSlots(trackId, chainType);
      const beforeLanes = (track.automationLanes || []).map(cloneAutomationLane);
      const newIndex = beforeSlots.length;
      const isInput = chainType === "input";
      const added = await nativeBridge.addTrackBuiltInFX(trackId, effectName, isInput);
      if (!added) return false;

      const afterSlots = await waitForFXChainLength(trackId, chainType, newIndex + 1);
      applyTrackFXFrontendState(set, get, trackId, chainType, afterSlots.length, beforeLanes);

      const addAgain = async () => {
        const currentLength = (await getFXChainSlots(trackId, chainType)).length;
        const success = await nativeBridge.addTrackBuiltInFX(trackId, effectName, isInput);
        if (!success) return false;
        const slots = await waitForFXChainLength(trackId, chainType, currentLength + 1);
        applyTrackFXFrontendState(set, get, trackId, chainType, slots.length, beforeLanes);
        return true;
      };
      const removeAgain = async () => {
        const success = isInput
          ? await nativeBridge.removeTrackInputFX(trackId, newIndex)
          : await nativeBridge.removeTrackFX(trackId, newIndex);
        if (!success) return false;
        const lanes = removeTrackFXAutomationLanes(
          get().tracks.find((candidate: any) => candidate.id === trackId)?.automationLanes || [],
          chainType,
          newIndex,
        );
        const slots = await getFXChainSlots(trackId, chainType);
        applyTrackFXFrontendState(set, get, trackId, chainType, slots.length, lanes);
        return true;
      };

      commandManager.push({
        type: "ADD_TRACK_BUILTIN_FX",
        description: `Add ${effectName}`,
        timestamp: Date.now(),
        execute: () => { void addAgain().catch(logBridgeError("redo built-in FX add")); },
        undo: () => { void removeAgain().catch(logBridgeError("undo built-in FX add")); },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    reorderTrackFXWithUndo: async (
      trackId: string,
      fromIndex: number,
      toIndex: number,
      chainType: TrackFXAutomationChain,
    ) => {
      const state = get();
      const track = state.tracks.find((candidate: any) => candidate.id === trackId);
      if (!track || state.globalLocked || track.frozen) return false;
      if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;

      const slots = await getFXChainSlots(trackId, chainType);
      if (fromIndex >= slots.length || toIndex >= slots.length) return false;
      const beforeLanes = (track.automationLanes || []).map(cloneAutomationLane);
      const afterLanes = reorderTrackFXAutomationLanes(beforeLanes, chainType, fromIndex, toIndex);
      const reorder = chainType === "input"
        ? nativeBridge.reorderTrackInputFX.bind(nativeBridge)
        : nativeBridge.reorderTrackFX.bind(nativeBridge);
      const success = await reorder(trackId, fromIndex, toIndex);
      if (!success) return false;
      applyTrackFXFrontendState(set, get, trackId, chainType, slots.length, afterLanes);

      const applyOrder = async (from: number, to: number, lanes: readonly any[]) => {
        const reordered = await reorder(trackId, from, to);
        if (!reordered) return false;
        const currentSlots = await getFXChainSlots(trackId, chainType);
        applyTrackFXFrontendState(set, get, trackId, chainType, currentSlots.length, lanes);
        return true;
      };
      commandManager.push({
        type: "REORDER_TRACK_FX",
        description: `Reorder ${chainType} FX`,
        timestamp: Date.now(),
        execute: () => { void applyOrder(fromIndex, toIndex, afterLanes).catch(logBridgeError("redo FX reorder")); },
        undo: () => { void applyOrder(toIndex, fromIndex, beforeLanes).catch(logBridgeError("undo FX reorder")); },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    setFXSlotBypassedWithUndo: async (
      trackId: string,
      fxIndex: number,
      chainType: FXChainType,
      bypassed: boolean,
    ) => {
      if (!Number.isInteger(fxIndex) || fxIndex < 0) return false;
      if (chainType !== "master" && !get().tracks.some((track) => track.id === trackId)) return false;
      const slots = await getFXChainSlots(trackId, chainType).catch(logBridgeError("read FX chain"));
      const slot = Array.isArray(slots) ? slots[fxIndex] : undefined;
      if (!slot) return false;
      const oldBypassed = Boolean(slot.bypassed);
      const nextBypassed = Boolean(bypassed);
      if (oldBypassed === nextBypassed) return true;

      const applyBypass = async (value: boolean) => {
        const success = chainType === "master"
          ? await nativeBridge.bypassMasterFX(fxIndex, value)
          : chainType === "input"
            ? await nativeBridge.bypassTrackInputFX(trackId, fxIndex, value)
            : await nativeBridge.bypassTrackFX(trackId, fxIndex, value);
        if (success) {
          set({ isModified: true });
          notifyFXChainChanged({ trackId: chainType === "master" ? "master" : trackId, chainType });
        }
        return success;
      };

      const success = await applyBypass(nextBypassed).catch(logBridgeError("set FX slot bypass"));
      if (!success) return false;
      commandManager.push({
        type: "SET_FX_SLOT_BYPASS",
        description: `${nextBypassed ? "Bypass" : "Enable"} ${chainType} FX`,
        timestamp: Date.now(),
        execute: () => {
          void applyBypass(nextBypassed).catch(logBridgeError("redo FX slot bypass"));
        },
        undo: () => {
          void applyBypass(oldBypassed).catch(logBridgeError("undo FX slot bypass"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    toggleFXSlotBypassWithUndo: async (
      trackId: string,
      fxIndex: number,
      chainType: FXChainType,
    ) => {
      if (!Number.isInteger(fxIndex) || fxIndex < 0) return false;
      const slots = await getFXChainSlots(trackId, chainType).catch(logBridgeError("read FX chain"));
      const slot = Array.isArray(slots) ? slots[fxIndex] : undefined;
      if (!slot) return false;
      return await get().setFXSlotBypassedWithUndo(trackId, fxIndex, chainType, !Boolean(slot.bypassed));
    },

    removeMasterFXWithUndo: async (fxIndex: number) => {
      if (!Number.isInteger(fxIndex) || fxIndex < 0) return false;

      const fxList = await nativeBridge.getMasterFX().catch(logBridgeError("read master FX chain"));
      const pluginInfo = Array.isArray(fxList)
        ? fxList.find((slot) => slot?.index === fxIndex) ?? fxList[fxIndex]
        : undefined;
      if (!pluginInfo) return false;

      const pluginType = typeof pluginInfo.type === "string"
        ? pluginInfo.type.trim().toLowerCase()
        : "";
      const pluginReference = pluginType === "builtin"
        ? String(pluginInfo.pluginPath || pluginInfo.name || "").trim()
        : String(pluginInfo.pluginPath || "").trim();
      if (!pluginReference) return false;

      const savedState = await nativeBridge
        .getMasterPluginState(fxIndex)
        .catch(logBridgeError("capture master FX state"));
      if (typeof savedState !== "string") return false;

      const wasBypassed = Boolean(pluginInfo.bypassed);
      const precisionOverride = pluginInfo.precisionOverride === "float32"
        ? "float32"
        : "auto";

      const restorePlugin = async () => {
        const added = pluginType === "builtin"
          ? await nativeBridge.addMasterBuiltInFX(pluginReference)
          : pluginType === "s13fx"
            ? await nativeBridge.addMasterS13FX(pluginReference)
            : await nativeBridge.addMasterFX(pluginReference);
        if (!added) return false;

        const restoredList = await nativeBridge.getMasterFX();
        const appendedSlot = restoredList[restoredList.length - 1];
        const appendedIndex = Number.isInteger(appendedSlot?.index)
          ? appendedSlot.index
          : restoredList.length - 1;
        if (appendedIndex < 0) return false;

        const stateRestored = savedState
          ? await nativeBridge.setMasterPluginState(appendedIndex, savedState)
          : true;
        const bypassRestored = await nativeBridge.bypassMasterFX(appendedIndex, wasBypassed);
        const precisionRestored = await nativeBridge.setMasterFXPrecisionOverride(
          appendedIndex,
          precisionOverride,
        );
        const orderRestored = appendedIndex === fxIndex
          ? true
          : await nativeBridge.reorderMasterFX(appendedIndex, fxIndex);
        const restored = stateRestored && bypassRestored && precisionRestored && orderRestored;
        if (!restored) {
          console.error("[DAWStore] Master FX was re-added but its complete state could not be restored");
        }
        set({ isModified: true });
        notifyFXChainChanged({ trackId: "master", chainType: "master" });
        return restored;
      };

      const removed = await nativeBridge
        .removeMasterFX(fxIndex)
        .catch(logBridgeError("remove master FX"));
      if (!removed) return false;

      set({ isModified: true });
      notifyFXChainChanged({ trackId: "master", chainType: "master" });
      commandManager.push({
        type: "REMOVE_MASTER_FX",
        description: "Remove master FX",
        timestamp: Date.now(),
        execute: () => {
          void nativeBridge.removeMasterFX(fxIndex).then((success) => {
            if (!success) return;
            set({ isModified: true });
            notifyFXChainChanged({ trackId: "master", chainType: "master" });
          }).catch(logBridgeError("redo master FX removal"));
        },
        undo: () => {
          void restorePlugin().catch(logBridgeError("undo master FX removal"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    removeTrackFXWithUndo: async (trackId, fxIndex, chainType) => {
      const state = get();
      const track = state.tracks.find((candidate: any) => candidate.id === trackId);
      if (!track || state.globalLocked || track.frozen || !Number.isInteger(fxIndex) || fxIndex < 0) return false;

      const isInput = chainType === "input";
      const fxList = await getFXChainSlots(trackId, chainType);
      const pluginInfo = fxList[fxIndex];
      if (!pluginInfo) return false;
      const pluginType = String(pluginInfo.type || "").trim().toLowerCase();
      const pluginReference = String(pluginInfo.pluginPath || pluginInfo.name || "").trim();
      if (!pluginReference) return false;

      const savedState = await nativeBridge.getPluginState(trackId, fxIndex, isInput);
      if (typeof savedState !== "string") return false;
      const wasBypassed = Boolean(pluginInfo.bypassed);
      const precisionOverride = pluginInfo.precisionOverride === "float32" ? "float32" : "auto";
      const beforeLanes = (track.automationLanes || []).map(cloneAutomationLane);
      const afterLanes = removeTrackFXAutomationLanes(beforeLanes, chainType, fxIndex);
      const removeFn = isInput
        ? nativeBridge.removeTrackInputFX.bind(nativeBridge)
        : nativeBridge.removeTrackFX.bind(nativeBridge);
      const reorderFn = isInput
        ? nativeBridge.reorderTrackInputFX.bind(nativeBridge)
        : nativeBridge.reorderTrackFX.bind(nativeBridge);

      const addSavedPlugin = async () => {
        const beforeLength = (await getFXChainSlots(trackId, chainType)).length;
        const added = pluginType === "builtin"
          ? await nativeBridge.addTrackBuiltInFX(trackId, pluginReference, isInput)
          : pluginType === "s13fx"
            ? await nativeBridge.addTrackS13FX(trackId, pluginReference, isInput)
            : isInput
              ? await nativeBridge.addTrackInputFX(trackId, pluginReference, false)
              : await nativeBridge.addTrackFX(trackId, pluginReference, false);
        if (!added) return false;

        const restoredList = await waitForFXChainLength(trackId, chainType, beforeLength + 1);
        const appendedIndex = restoredList.length - 1;
        if (appendedIndex < 0) return false;
        const stateRestored = savedState
          ? await nativeBridge.setPluginState(trackId, appendedIndex, isInput, savedState)
          : true;
        const bypassRestored = isInput
          ? await nativeBridge.bypassTrackInputFX(trackId, appendedIndex, wasBypassed)
          : await nativeBridge.bypassTrackFX(trackId, appendedIndex, wasBypassed);
        const precisionRestored = await nativeBridge.setTrackPluginPrecisionOverride(
          trackId,
          appendedIndex,
          isInput,
          precisionOverride,
        );
        const orderRestored = appendedIndex === fxIndex
          ? true
          : await reorderFn(trackId, appendedIndex, fxIndex);
        if (!(stateRestored && bypassRestored && precisionRestored && orderRestored)) return false;
        const list = await getFXChainSlots(trackId, chainType);
        applyTrackFXFrontendState(set, get, trackId, chainType, list.length, beforeLanes);
        return true;
      };

      const removeSavedPlugin = async () => {
        const removed = await removeFn(trackId, fxIndex);
        if (!removed) return false;
        const list = await getFXChainSlots(trackId, chainType);
        applyTrackFXFrontendState(set, get, trackId, chainType, list.length, afterLanes);
        return true;
      };

      if (!await removeSavedPlugin()) return false;
      commandManager.push({
        type: "REMOVE_TRACK_FX",
        description: `Remove ${pluginInfo.name || chainType + " FX"}`,
        timestamp: Date.now(),
        execute: () => { void removeSavedPlugin().catch(logBridgeError("redo track FX removal")); },
        undo: () => { void addSavedPlugin().catch(logBridgeError("undo track FX removal")); },
      });
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
        description: `Load OpenStudio ${instrument}`,
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
      if (isAutomationEditLocked(get())) return;
      if (!get().tracks.some((track) => track.id === trackId)) return;
      const before = captureAutomationProjectSnapshot(get());
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, showAutomation: !t.showAutomation } : t,
        ),
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "TOGGLE_TRACK_AUTOMATION_VIEW",
        "Toggle track automation view",
      );
    },

    setAutomationWriteBehavior: (behavior) => {
      if (isAutomationEditLocked(get())) return;
      const nextBehavior = behavior === "latch" || behavior === "overwrite" ? behavior : "touch";
      if ((get().automationWriteBehavior ?? "touch") === nextBehavior) return;
      const before = captureAutomationProjectSnapshot(get());
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
      _automationWriteSessionSnapshots.clear();
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
      const after = captureAutomationProjectSnapshot(get());
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        after,
        "SET_AUTOMATION_WRITE_BEHAVIOR",
        `Set automation write behavior to ${nextBehavior}`,
      );
    },

    recordAutomationWriteTick: (nowMs = Date.now()) => {
      const state = get();
      if (isAutomationEditLocked(state) || !automationTransportRolling(state)) return;

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
            if (!_automationWriteSessionSnapshots.has(key)) {
              _automationWriteSessionSnapshots.set(key, {
                trackId: track.id,
                laneId: lane.id,
                points: normalizeAutomationPoints(lane.points),
              });
            }
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
            if (!_automationWriteSessionSnapshots.has(key)) {
              _automationWriteSessionSnapshots.set(key, {
                trackId: "master",
                laneId: lane.id,
                points: normalizeAutomationPoints(lane.points),
              });
            }
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
      const beforeSnapshots = Array.from(_automationWriteSessionSnapshots.values());
      const stateBeforeEnd = get();
      const writePassChanges = beforeSnapshots.flatMap((snapshot) => {
        const lane = snapshot.trackId === "master"
          ? stateBeforeEnd.masterAutomationLanes.find((candidate) => candidate.id === snapshot.laneId)
          : stateBeforeEnd.tracks.find((track) => track.id === snapshot.trackId)
            ?.automationLanes.find((candidate) => candidate.id === snapshot.laneId);
        if (!lane) return [];
        const beforePoints = normalizeAutomationPoints(snapshot.points);
        const afterPoints = normalizeAutomationPoints(lane.points);
        if (JSON.stringify(beforePoints) === JSON.stringify(afterPoints)) return [];
        return [{
          trackId: snapshot.trackId,
          laneId: snapshot.laneId,
          beforePoints,
          afterPoints,
        }];
      });
      const behavior = writeBehavior(get);
      _automationTouchedParams.clear();
      _automationLatchedParams.clear();
      _autoRecordTimers.clear();
      _automationWriteValues.clear();
      _automationWriteSessionStartTimes.clear();
      _automationWriteSessionSnapshots.clear();
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
      if (writePassChanges.length > 0) {
        commandManager.push({
          type: "RECORD_AUTOMATION_WRITE_PASS",
          description: "Record automation pass",
          timestamp: Date.now(),
          execute: () => applyRecordedAutomationWritePass(
            set,
            get,
            writePassChanges,
            "afterPoints",
          ),
          undo: () => applyRecordedAutomationWritePass(
            set,
            get,
            writePassChanges,
            "beforePoints",
          ),
        });
        set({
          canUndo: commandManager.canUndo(),
          canRedo: commandManager.canRedo(),
          isModified: true,
        });
      }
    },

    setAutomationWriteValue: (trackId, param, value) => {
      const state = get();
      if (isAutomationEditLocked(state) || !automationTransportRolling(state)) {
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
      const state = get();
      if (isAutomationEditLocked(state) || !automationTransportRolling(state)) {
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
      if (isAutomationEditLocked(get())) return;
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
      const before = captureTrackAutomationModeSnapshot(get(), trackId);
      get().setTrackAutomationRead(trackId, !trackReadEnabled(track));
      const after = captureTrackAutomationModeSnapshot(get(), trackId);
      if (!before || !after || JSON.stringify(before) === JSON.stringify(after)) return;
      commandManager.push({
        type: "TOGGLE_TRACK_AUTOMATION_READ",
        description: after.automationReadEnabled ? "Enable track automation read" : "Disable track automation read",
        timestamp: Date.now(),
        execute: () => applyTrackAutomationModeSnapshot(set, get, after),
        undo: () => applyTrackAutomationModeSnapshot(set, get, before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo(), isModified: true });
    },

    setTrackAutomationWrite: (trackId, enabled) => {
      if (isAutomationEditLocked(get())) return;
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
      const before = captureTrackAutomationModeSnapshot(get(), trackId);
      get().setTrackAutomationWrite(trackId, !trackWriteEnabled(track));
      const after = captureTrackAutomationModeSnapshot(get(), trackId);
      if (!before || !after || JSON.stringify(before) === JSON.stringify(after)) return;
      commandManager.push({
        type: "TOGGLE_TRACK_AUTOMATION_WRITE",
        description: after.automationWriteEnabled ? "Enable track automation write" : "Disable track automation write",
        timestamp: Date.now(),
        execute: () => applyTrackAutomationModeSnapshot(set, get, after),
        undo: () => applyTrackAutomationModeSnapshot(set, get, before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo(), isModified: true });
    },

    toggleTrackAutomationEnabled: (trackId) => {
      get().toggleTrackAutomationRead(trackId);
    },

    addAutomationLane: (trackId, param, _label) => {
      const state = get();
      if (isAutomationEditLocked(state)) return null;
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return null;
      const before = captureAutomationProjectSnapshot(get());
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
        pushAppliedAutomationProjectCommand(
          set,
          get,
          before,
          captureAutomationProjectSnapshot(get()),
          "SHOW_AUTOMATION_LANE",
          "Show automation lane",
        );
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
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "ADD_AUTOMATION_LANE",
        "Add automation lane",
      );
      return laneId;
    },

    addAutomationPoint: (trackId, laneId, time, value) => {
      if (isAutomationEditLocked(get())) return;
      if (!Number.isFinite(time) || !Number.isFinite(value)) return;
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const oldTrackRead = trackReadEnabled(track);
      const oldTrackWrite = trackWriteEnabled(track);
      const oldLaneRead = automationLaneReadEnabled(lane);
      const oldLaneMode = lane.mode;
      const newPoints = [
        ...oldPoints,
        { id: createAutomationPointId(), time: Math.max(0, time), value: clamp01(value) },
      ].sort((a, b) => a.time - b.time);
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
        if (updatedLane) {
          if (updatedLane.points.length === 0) {
            nativeBridge.clearAutomation(trackId, updatedLane.param).catch(() => {});
          } else {
            syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
          }
        }
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
      if (isAutomationEditLocked(get())) return;
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const newPoints = oldPoints.filter((_, i) => i !== pointIndex);
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
      if (isAutomationEditLocked(get())) return;
      if (!Number.isFinite(time) || !Number.isFinite(value)) return;
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const newPoints = oldPoints
        .map((p, i) => i === pointIndex ? { ...p, time: Math.max(0, time), value: clamp01(value) } : p)
        .sort((a, b) => a.time - b.time);
      if (JSON.stringify(oldPoints) === JSON.stringify(newPoints)) return;
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
      if (isAutomationEditLocked(get())) return;
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
      if (JSON.stringify(oldPoints) === JSON.stringify(nextPoints)) return;

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
      if (isAutomationEditLocked(get())) return;
      const lane = get().tracks.find((track) => track.id === trackId)
        ?.automationLanes.find((candidate) => candidate.id === laneId);
      if (!lane) return;
      const before = captureAutomationProjectSnapshot(get());
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
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "TOGGLE_AUTOMATION_LANE_VISIBILITY",
        lane.visible ? "Hide automation lane" : "Show automation lane",
      );
    },

    setAutomationLaneRead: (trackId, laneId, enabled) => {
      if (isAutomationEditLocked(get())) return;
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!track || !lane) return;
      if (automationLaneReadEnabled(lane) === Boolean(enabled)) return;
      const before = captureAutomationProjectSnapshot(get());
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
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "SET_AUTOMATION_LANE_READ",
        enabled ? "Enable automation lane read" : "Disable automation lane read",
      );
    },

    toggleAutomationLaneRead: (trackId, laneId) => {
      if (isAutomationEditLocked(get())) return;
      const lane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
      if (!lane) return;
      get().setAutomationLaneRead(trackId, laneId, !automationLaneReadEnabled(lane));
    },

    clearAutomationLane: (trackId, laneId) => {
      if (isAutomationEditLocked(get())) return;
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (!lane || lane.points.length === 0) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
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
        if (updatedLane) {
          if (updatedLane.points.length === 0) {
            nativeBridge.clearAutomation(trackId, updatedLane.param).catch(() => {});
          } else {
            syncAutomationLaneAfterManualEdit(trackId, updatedLane, resetWriteState);
          }
        }
      };
      commandManager.execute({
        type: "AUTOMATION_LANE_CLEAR",
        description: "Clear automation lane",
        timestamp: Date.now(),
        execute: () => applyPoints([]),
        undo: () => applyPoints(oldPoints),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      // Sync to C++ backend — clear the automation for this parameter
    },

    setAutomationLaneMode: (trackId, laneId, mode) => {
      if (isAutomationEditLocked(get())) return;
      const currentLane = get().tracks.find((track) => track.id === trackId)
        ?.automationLanes.find((lane) => lane.id === laneId);
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      if (!currentLane || (
        currentLane.mode === mode
        && automationLaneReadEnabled(currentLane) === readEnabled
        && currentLane.armed === shouldWrite
      )) return;
      const before = captureAutomationProjectSnapshot(get());
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
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "SET_AUTOMATION_LANE_MODE",
        `Set automation lane mode to ${mode}`,
      );
    },

    setTrackAutomationMode: (trackId, mode) => {
      if (isAutomationEditLocked(get())) return;
      const currentTrack = get().tracks.find((track) => track.id === trackId);
      if (!currentTrack) return;
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      const alreadySet = currentTrack.automationReadEnabled === readEnabled
        && currentTrack.automationWriteEnabled === shouldWrite
        && currentTrack.automationLanes.every((lane) => (
          lane.mode === mode && lane.readEnabled === readEnabled && lane.armed === shouldWrite
        ));
      if (alreadySet) return;
      const before = captureAutomationProjectSnapshot(get());
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
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "SET_TRACK_AUTOMATION_MODE",
        `Set track automation mode to ${mode}`,
      );
    },

    armAutomationLane: (trackId, laneId, armed) => {
      if (isAutomationEditLocked(get())) return;
      const lane = get().tracks.find((track) => track.id === trackId)
        ?.automationLanes.find((candidate) => candidate.id === laneId);
      if (!lane || lane.armed === Boolean(armed)) return;
      const before = captureAutomationProjectSnapshot(get());
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
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        "ARM_AUTOMATION_LANE",
        armed ? "Arm automation lane" : "Disarm automation lane",
      );
    },

    armAllVisibleAutomationLanes: (trackId) => {
      if (isAutomationEditLocked(get())) return;
      const before = captureAutomationProjectSnapshot(get());
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
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "ARM_VISIBLE_AUTOMATION_LANES", "Arm visible automation lanes");
    },

    disarmAllAutomationLanes: (trackId) => {
      if (isAutomationEditLocked(get())) return;
      const before = captureAutomationProjectSnapshot(get());
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => ({ ...lane, armed: false })),
          };
        }),
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "DISARM_AUTOMATION_LANES", "Disarm automation lanes");
    },

    showAllActiveEnvelopes: (trackId) => {
      const before = captureAutomationProjectSnapshot(get());
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
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "SHOW_ACTIVE_ENVELOPES", "Show active automation envelopes");
    },

    hideAllEnvelopes: (trackId) => {
      const before = captureAutomationProjectSnapshot(get());
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return { ...t, showAutomation: false };
        }),
        isModified: true,
      }));
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "HIDE_AUTOMATION_ENVELOPES", "Hide automation envelopes");
    },

    setSelectedAutomationTarget: (target) => {
      if (!target) {
        set({ selectedAutomationTarget: null });
        return;
      }
      const resolvedLane = resolveAutomationLaneTarget(get(), target);
      if (!resolvedLane) {
        set({ selectedAutomationTarget: null });
        return;
      }
      if (
        target.pointId !== null
        && !resolvedLane.lane.points.some(
          (point, index) => getAutomationPointId(point, index) === target.pointId,
        )
      ) {
        set({ selectedAutomationTarget: null });
        return;
      }
      set({ selectedAutomationTarget: { ...target } });
    },

    setSelectedAutomationLane: (target) => {
      get().setSelectedAutomationTarget({ ...target, pointId: null });
    },

    setSelectedAutomationPoint: (target) => {
      get().setSelectedAutomationTarget(target);
    },

    clearSelectedAutomationTarget: () => {
      if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
    },

    selectAdjacentAutomationPoint: (direction) => {
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved || resolved.lane.points.length === 0) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      const currentIndex = typeof resolved.target.pointId === "string"
        ? resolved.lane.points.findIndex(
            (point, index) => getAutomationPointId(point, index) === resolved.target.pointId,
          )
        : -1;
      const pointIndex = direction === "previous"
        ? currentIndex < 0
          ? resolved.lane.points.length - 1
          : Math.max(0, currentIndex - 1)
        : currentIndex < 0
          ? 0
          : Math.min(resolved.lane.points.length - 1, currentIndex + 1);
      const pointId = getAutomationPointId(resolved.lane.points[pointIndex], pointIndex);
      set({ selectedAutomationTarget: { ...resolved.target, pointId } });
    },

    selectAdjacentAutomationLane: (direction) => {
      const state = get();
      const resolved = resolveAutomationLaneTarget(state);
      if (!resolved) {
        const staleTarget = state.selectedAutomationTarget;
        const preferredTrack = (
          staleTarget?.kind === "track"
            ? state.tracks.find((track) => track.id === staleTarget.trackId && track.automationLanes.length > 0)
            : undefined
        )
          || state.tracks.find((track) => track.id === state.selectedTrackId && track.automationLanes.length > 0)
          || state.tracks.find((track) => state.selectedTrackIds.includes(track.id) && track.automationLanes.length > 0)
          || state.tracks.find((track) => track.automationLanes.length > 0);
        if (preferredTrack) {
          const laneIndex = direction === "previous" ? preferredTrack.automationLanes.length - 1 : 0;
          set({
            selectedAutomationTarget: {
              kind: "track",
              trackId: preferredTrack.id,
              laneId: preferredTrack.automationLanes[laneIndex].id,
              pointId: null,
            },
          });
          return;
        }
        if (state.masterAutomationLanes.length > 0) {
          const laneIndex = direction === "previous" ? state.masterAutomationLanes.length - 1 : 0;
          set({
            selectedAutomationTarget: {
              kind: "master",
              laneId: state.masterAutomationLanes[laneIndex].id,
              pointId: null,
            },
          });
          return;
        }
        if (state.selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      const lanes = resolved.target.kind === "master"
        ? get().masterAutomationLanes
        : get().tracks.find((track) => track.id === resolved.target.trackId)?.automationLanes || [];
      if (lanes.length === 0) {
        set({ selectedAutomationTarget: null });
        return;
      }
      const currentIndex = lanes.findIndex((lane) => lane.id === resolved.target.laneId);
      if (currentIndex < 0) {
        set({ selectedAutomationTarget: null });
        return;
      }
      const nextIndex = direction === "previous"
        ? (currentIndex - 1 + lanes.length) % lanes.length
        : (currentIndex + 1) % lanes.length;
      set({
        selectedAutomationTarget: {
          ...resolved.target,
          laneId: lanes[nextIndex].id,
          pointId: null,
        },
      });
    },

    deleteSelectedAutomationPoint: () => {
      if (isAutomationEditLocked(get())) return;
      const resolved = resolveAutomationPointTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget?.pointId !== null) {
          set({ selectedAutomationTarget: null });
        }
        return;
      }
      if (resolved.target.kind === "master") {
        get().removeMasterAutomationPoint(resolved.target.laneId, resolved.pointIndex);
      } else {
        get().removeAutomationPoint(
          resolved.target.trackId,
          resolved.target.laneId,
          resolved.pointIndex,
        );
      }
      const laneAfter = resolveAutomationLaneTarget(get(), resolved.target)?.lane;
      const nextIndex = laneAfter && laneAfter.points.length > 0
        ? Math.min(resolved.pointIndex, laneAfter.points.length - 1)
        : null;
      const nextPointId = nextIndex === null
        ? null
        : getAutomationPointId(laneAfter.points[nextIndex], nextIndex);
      set({
        selectedAutomationTarget: laneAfter
          ? { ...resolved.target, pointId: nextPointId }
          : null,
      });
    },

    beginAutomationPointEdit: (target) => {
      if (isAutomationEditLocked(get())) return false;
      if (_automationPointEditSnapshot) get().cancelAutomationPointEdit();
      const resolved = resolveAutomationPointTarget(get(), target);
      if (!resolved) return false;
      _automationPointEditSnapshot = {
        target: { ...target },
        originalPoints: normalizeAutomationPoints(resolved.lane.points),
        originalIsModified: get().isModified,
        editKind: "move",
        workingPointCount: resolved.lane.points.length,
        originalSourcePoint: null,
      };
      set({ selectedAutomationTarget: { ...target } });
      return true;
    },

    beginAutomationPointCopyEdit: (target) => {
      if (isAutomationEditLocked(get())) return false;
      if (_automationPointEditSnapshot) get().cancelAutomationPointEdit();
      const resolved = resolveAutomationPointTarget(get(), target);
      if (!resolved) return false;
      const originalPoints = normalizeAutomationPoints(resolved.lane.points);
      const sourcePoint = originalPoints.find((point: any) => point.id === target.pointId);
      if (!sourcePoint) return false;
      const preservedCopy = {
        ...sourcePoint,
        id: createAutomationPointId(),
      };
      _automationPointEditSnapshot = {
        target: { ...target },
        originalPoints,
        originalIsModified: get().isModified,
        editKind: "copy",
        workingPointCount: originalPoints.length + 1,
        originalSourcePoint: {
          time: sourcePoint.time,
          value: sourcePoint.value,
        },
      };
      applyAutomationTargetPoints(
        set,
        get,
        target,
        [...originalPoints, preservedCopy],
        target.pointId,
      );
      return true;
    },

    previewAutomationPointEdit: (time, value) => {
      const snapshot = _automationPointEditSnapshot;
      if (!snapshot || isAutomationEditLocked(get())) return false;
      if (!Number.isFinite(time) || !Number.isFinite(value)) return false;
      const resolved = resolveAutomationLaneTarget(get(), snapshot.target);
      const currentPointIndex = resolved?.lane.points.findIndex(
        (point, index) => getAutomationPointId(point, index) === snapshot.target.pointId,
      ) ?? -1;
      if (
        !resolved
        || resolved.lane.points.length !== snapshot.workingPointCount
        || currentPointIndex < 0
      ) {
        get().cancelAutomationPointEdit();
        return false;
      }
      const nextPoints = resolved.lane.points.map((point, index) => index === currentPointIndex
        ? { ...point, id: snapshot.target.pointId, time: Math.max(0, time), value: clamp01(value) }
        : { ...point });
      applyAutomationTargetPoints(
        set,
        get,
        snapshot.target,
        nextPoints,
        snapshot.target.pointId,
      );
      return true;
    },

    commitAutomationPointEdit: () => {
      const snapshot = _automationPointEditSnapshot;
      if (!snapshot) return false;
      _automationPointEditSnapshot = null;
      if (isAutomationEditLocked(get())) {
        applyAutomationTargetPoints(
          set,
          get,
          snapshot.target,
          snapshot.originalPoints,
          snapshot.target.pointId,
        );
        set({ isModified: snapshot.originalIsModified });
        return false;
      }
      const resolved = resolveAutomationLaneTarget(get(), snapshot.target);
      if (!resolved || resolved.lane.points.length !== snapshot.workingPointCount) {
        applyAutomationTargetPoints(
          set,
          get,
          snapshot.target,
          snapshot.originalPoints,
          snapshot.target.pointId,
        );
        set({ isModified: snapshot.originalIsModified });
        return false;
      }
      const sorted = resolved.lane.points
        .map((point, sourceIndex) => ({ point: { ...point }, sourceIndex }))
        .sort((a, b) => (a.point.time - b.point.time) || (a.sourceIndex - b.sourceIndex));
      const finalPoints = sorted.map((entry) => entry.point);
      const finalSourcePoint = snapshot.editKind === "copy"
        ? finalPoints.find((point) => point.id === snapshot.target.pointId)
        : null;
      const copyDidNotMove = snapshot.editKind === "copy"
        && snapshot.originalSourcePoint
        && finalSourcePoint
        && Math.abs(finalSourcePoint.time - snapshot.originalSourcePoint.time) <= 0.000001
        && Math.abs(finalSourcePoint.value - snapshot.originalSourcePoint.value) <= 0.000001;
      if (
        (snapshot.editKind === "move"
          && JSON.stringify(snapshot.originalPoints) === JSON.stringify(finalPoints))
        || copyDidNotMove
      ) {
        applyAutomationTargetPoints(
          set,
          get,
          snapshot.target,
          snapshot.originalPoints,
          snapshot.target.pointId,
        );
        set({ isModified: snapshot.originalIsModified });
        return false;
      }
      applyAutomationTargetPoints(
        set,
        get,
        snapshot.target,
        finalPoints,
        snapshot.target.pointId,
      );
      const afterTarget = { ...snapshot.target };
      commandManager.push({
        type: snapshot.editKind === "copy"
          ? snapshot.target.kind === "master"
            ? "MASTER_AUTOMATION_POINT_COPY"
            : "AUTOMATION_POINT_COPY"
          : snapshot.target.kind === "master"
            ? "MASTER_AUTOMATION_POINT_MOVE"
            : "AUTOMATION_POINT_MOVE",
        description: snapshot.editKind === "copy"
          ? snapshot.target.kind === "master"
            ? "Copy master automation point"
            : "Copy automation point"
          : snapshot.target.kind === "master"
            ? "Move master automation point"
            : "Move automation point",
        timestamp: Date.now(),
        execute: () => applyAutomationTargetPoints(
          set,
          get,
          afterTarget,
          finalPoints,
          snapshot.target.pointId,
        ),
        undo: () => applyAutomationTargetPoints(
          set,
          get,
          snapshot.target,
          snapshot.originalPoints,
          snapshot.target.pointId,
        ),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
      return true;
    },

    cancelAutomationPointEdit: () => {
      const snapshot = _automationPointEditSnapshot;
      if (!snapshot) return false;
      _automationPointEditSnapshot = null;
      const resolved = resolveAutomationLaneTarget(get(), snapshot.target);
      if (!resolved) {
        set({ selectedAutomationTarget: null });
        return false;
      }
      applyAutomationTargetPoints(
        set,
        get,
        snapshot.target,
        snapshot.originalPoints,
        snapshot.target.pointId,
      );
      set({ isModified: snapshot.originalIsModified });
      return true;
    },

    nudgeSelectedAutomationPoint: (axis, direction) => {
      if (isAutomationEditLocked(get())) return;
      const resolved = resolveAutomationPointTarget(get());
      if (!resolved || !get().beginAutomationPointEdit(resolved.target)) {
        if (!resolved) set({ selectedAutomationTarget: null });
        return;
      }
      const nextTime = axis === "time"
        ? Math.max(0, resolved.point.time + direction * 0.01)
        : resolved.point.time;
      const nextValue = axis === "value"
        ? clamp01(resolved.point.value + direction * 0.01)
        : resolved.point.value;
      if (!get().previewAutomationPointEdit(nextTime, nextValue)) {
        get().cancelAutomationPointEdit();
        return;
      }
      get().commitAutomationPointEdit();
    },

    addAutomationPointAtPlayhead: () => {
      if (isAutomationEditLocked(get())) return;
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      const time = Math.max(0, Number(get().transport?.currentTime) || 0);
      const value = resolved.lane.points.length > 0
        ? interpolateAtTime(resolved.lane.points, time)
        : getAutomationDefault(resolved.lane.param);
      const beforePointIds = new Set(
        resolved.lane.points.map((point, index) => getAutomationPointId(point, index)),
      );
      if (resolved.target.kind === "master") {
        get().addMasterAutomationPoint(resolved.target.laneId, time, value);
      } else {
        get().addAutomationPoint(
          resolved.target.trackId,
          resolved.target.laneId,
          time,
          value,
        );
      }
      const laneAfter = resolveAutomationLaneTarget(get(), resolved.target)?.lane;
      if (!laneAfter) return;
      const pointIndex = laneAfter.points.findIndex(
        (point, index) => !beforePointIds.has(getAutomationPointId(point, index)),
      );
      const pointId = pointIndex < 0
        ? null
        : getAutomationPointId(laneAfter.points[pointIndex], pointIndex);
      set({ selectedAutomationTarget: { ...resolved.target, pointId } });
    },

    clearSelectedAutomationLane: () => {
      if (isAutomationEditLocked(get())) return;
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      if (resolved.target.kind === "master") {
        get().clearMasterAutomationLane(resolved.target.laneId);
      } else {
        get().clearAutomationLane(resolved.target.trackId, resolved.target.laneId);
      }
      set({ selectedAutomationTarget: { ...resolved.target, pointId: null } });
    },

    setSelectedAutomationLaneVisibility: (visible) => {
      if (isAutomationEditLocked(get())) return;
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      if (resolved.lane.visible === Boolean(visible)) return;
      if (resolved.target.kind === "master") {
        get().toggleMasterAutomationLaneVisibility(resolved.target.laneId);
      } else {
        get().toggleAutomationLaneVisibility(resolved.target.trackId, resolved.target.laneId);
      }
    },

    setSelectedAutomationLaneRead: (enabled) => {
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      if (automationLaneReadEnabled(resolved.lane) === Boolean(enabled)) return;
      if (resolved.target.kind === "master") {
        get().setMasterAutomationLaneRead(resolved.target.laneId, enabled);
      } else {
        get().setAutomationLaneRead(resolved.target.trackId, resolved.target.laneId, enabled);
      }
    },

    setSelectedAutomationLaneWrite: (enabled) => {
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      const desiredMode = enabled ? "write" : "read";
      if (resolved.lane.mode === desiredMode && resolved.lane.armed === Boolean(enabled)) return;
      get().setSelectedAutomationLaneMode(desiredMode);
    },

    setSelectedAutomationLaneMode: (mode) => {
      const resolved = resolveAutomationLaneTarget(get());
      if (!resolved) {
        if (get().selectedAutomationTarget) set({ selectedAutomationTarget: null });
        return;
      }
      if (resolved.target.kind === "master") {
        get().setMasterAutomationLaneMode(resolved.target.laneId, mode);
      } else {
        get().setAutomationLaneMode(resolved.target.trackId, resolved.target.laneId, mode);
      }
    },

    toggleArrangementAutomationView: () => {
      const state = get();
      const hasAutomation = state.tracks.some((track) => track.automationLanes.length > 0)
        || state.masterAutomationLanes.length > 0;
      if (!hasAutomation) return;
      const anyShown = state.tracks.some((track) => track.showAutomation)
        || state.showMasterAutomation;
      // Arrangement visibility is editor view state. Lane visibility is left
      // untouched, and this intentionally does not enter project undo history.
      set((current) => ({
        tracks: current.tracks.map((track) => ({
          ...track,
          showAutomation: anyShown ? false : track.automationLanes.length > 0,
        })),
        showMasterAutomation: anyShown
          ? false
          : current.masterAutomationLanes.length > 0,
      }));
    },

    setTracksAutomationRead: (trackIds, enabled) => {
      if (isAutomationEditLocked(get())) return;
      const ids = new Set(trackIds);
      if (ids.size === 0) return;
      const behavior = writeBehavior(get);
      const wasModified = Boolean(get().isModified);
      const before = captureAutomationProjectSnapshot(get());
      set((state) => ({
        tracks: state.tracks.map((track) => {
          if (!ids.has(track.id)) return track;
          if (track.automationLanes.length === 0 && !trackWriteEnabled(track)) return track;
          const nextRead = Boolean(enabled);
          const nextTrack = {
            ...track,
            automationReadEnabled: nextRead,
            automationEnabled: nextRead,
          };
          return {
            ...nextTrack,
            automationLanes: track.automationLanes.map((lane) =>
              withResolvedLaneMode(nextTrack, lane, behavior, false),
            ),
          };
        }),
        isModified: true,
      }));
      const after = captureAutomationProjectSnapshot(get());
      if (automationProjectSnapshotsEqual(before, after)) {
        if (get().isModified !== wasModified) set({ isModified: wasModified });
        return;
      }
      for (const track of get().tracks) {
        if (ids.has(track.id)) syncTrackAutomationModes(track, behavior);
      }
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        after,
        "SET_TRACKS_AUTOMATION_READ",
        enabled ? "Enable selected tracks automation read" : "Disable selected tracks automation read",
      );
    },

    toggleTracksAutomationRead: (trackIds) => {
      if (isAutomationEditLocked(get())) return;
      const ids = new Set(trackIds);
      if (ids.size === 0) return;
      const behavior = writeBehavior(get);
      const wasModified = Boolean(get().isModified);
      const before = captureAutomationProjectSnapshot(get());
      set((state) => ({
        tracks: state.tracks.map((track) => {
          if (!ids.has(track.id)) return track;
          if (track.automationLanes.length === 0 && !trackWriteEnabled(track)) return track;
          const nextRead = !trackReadEnabled(track);
          const nextTrack = {
            ...track,
            automationReadEnabled: nextRead,
            automationEnabled: nextRead,
          };
          return {
            ...nextTrack,
            automationLanes: track.automationLanes.map((lane) =>
              withResolvedLaneMode(nextTrack, lane, behavior, false),
            ),
          };
        }),
        isModified: true,
      }));
      const after = captureAutomationProjectSnapshot(get());
      if (automationProjectSnapshotsEqual(before, after)) {
        if (get().isModified !== wasModified) set({ isModified: wasModified });
        return;
      }
      for (const track of get().tracks) {
        if (ids.has(track.id)) syncTrackAutomationModes(track, behavior);
      }
      pushAppliedAutomationProjectCommand(set, get, before, after, "TOGGLE_TRACKS_AUTOMATION_READ", "Toggle selected tracks automation read");
    },

    setTracksAutomationWrite: (trackIds, enabled) => {
      if (isAutomationEditLocked(get())) return;
      const ids = new Set(trackIds);
      if (ids.size === 0) return;
      const behavior = writeBehavior(get);
      const wasModified = Boolean(get().isModified);
      const before = captureAutomationProjectSnapshot(get());
      set((state) => ({
        tracks: state.tracks.map((track) => {
          if (!ids.has(track.id)) return track;
          const nextWrite = Boolean(enabled);
          const keepReadOn = trackReadEnabled(track) && track.automationLanes.length > 0;
          const nextTrack = {
            ...track,
            automationReadEnabled: nextWrite ? true : keepReadOn,
            automationWriteEnabled: nextWrite,
            automationEnabled: nextWrite ? true : keepReadOn,
          };
          return {
            ...nextTrack,
            automationLanes: track.automationLanes.map((lane) =>
              withResolvedLaneMode(nextTrack, lane, behavior, false),
            ),
          };
        }),
        isModified: true,
      }));
      const after = captureAutomationProjectSnapshot(get());
      if (automationProjectSnapshotsEqual(before, after)) {
        if (get().isModified !== wasModified) set({ isModified: wasModified });
        return;
      }
      for (const track of get().tracks) {
        if (ids.has(track.id)) syncTrackAutomationModes(track, behavior);
      }
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        after,
        "SET_TRACKS_AUTOMATION_WRITE",
        enabled ? "Enable selected tracks automation write" : "Disable selected tracks automation write",
      );
    },

    toggleTracksAutomationWrite: (trackIds) => {
      if (isAutomationEditLocked(get())) return;
      const ids = new Set(trackIds);
      if (ids.size === 0) return;
      const behavior = writeBehavior(get);
      const wasModified = Boolean(get().isModified);
      const before = captureAutomationProjectSnapshot(get());
      set((state) => ({
        tracks: state.tracks.map((track) => {
          if (!ids.has(track.id)) return track;
          const nextWrite = !trackWriteEnabled(track);
          const keepReadOn = trackReadEnabled(track) && track.automationLanes.length > 0;
          const nextTrack = {
            ...track,
            automationReadEnabled: nextWrite ? true : keepReadOn,
            automationWriteEnabled: nextWrite,
            automationEnabled: nextWrite ? true : keepReadOn,
          };
          return {
            ...nextTrack,
            automationLanes: track.automationLanes.map((lane) =>
              withResolvedLaneMode(nextTrack, lane, behavior, false),
            ),
          };
        }),
        isModified: true,
      }));
      const after = captureAutomationProjectSnapshot(get());
      if (automationProjectSnapshotsEqual(before, after)) {
        if (get().isModified !== wasModified) set({ isModified: wasModified });
        return;
      }
      for (const track of get().tracks) {
        if (ids.has(track.id)) syncTrackAutomationModes(track, behavior);
      }
      pushAppliedAutomationProjectCommand(set, get, before, after, "TOGGLE_TRACKS_AUTOMATION_WRITE", "Toggle selected tracks automation write");
    },

    setTracksAutomationMode: (trackIds, mode) => {
      if (isAutomationEditLocked(get())) return;
      const ids = new Set(trackIds);
      if (ids.size === 0) return;
      const readEnabled = mode !== "off";
      const shouldWrite = mode === "write" || mode === "touch" || mode === "latch";
      const wasModified = Boolean(get().isModified);
      const before = captureAutomationProjectSnapshot(get());
      set((state) => ({
        tracks: state.tracks.map((track) => ids.has(track.id)
          ? {
              ...track,
              automationReadEnabled: readEnabled,
              automationWriteEnabled: shouldWrite,
              automationEnabled: readEnabled,
              automationLanes: track.automationLanes.map((lane) => ({
                ...lane,
                mode,
                readEnabled,
                armed: shouldWrite,
              })),
            }
          : track),
        isModified: true,
      }));
      const after = captureAutomationProjectSnapshot(get());
      if (automationProjectSnapshotsEqual(before, after)) {
        if (get().isModified !== wasModified) set({ isModified: wasModified });
        return;
      }
      for (const track of get().tracks) {
        if (!ids.has(track.id)) continue;
        for (const lane of track.automationLanes) syncAutomationLaneToBackend(track.id, lane);
      }
      pushAppliedAutomationProjectCommand(set, get, before, after, "SET_TRACKS_AUTOMATION_MODE", `Set selected tracks automation mode to ${mode}`);
    },

    toggleTracksAutomationModes: (trackIds, firstMode, secondMode) => {
      const ids = new Set(trackIds);
      if (ids.size === 0 || firstMode === secondMode) return;
      const selectedTracks = get().tracks.filter((track) => ids.has(track.id));
      if (selectedTracks.length === 0) return;
      const trackMode = (track) => {
        if (!trackReadEnabled(track)) return "off";
        if (!trackWriteEnabled(track)) return "read";
        const laneModes = new Set(track.automationLanes.map((lane) => lane.mode));
        if (laneModes.size === 1) return track.automationLanes[0]?.mode || "read";
        return writeBehavior(get()) === "overwrite" ? "write" : writeBehavior(get());
      };
      const allAtSecondMode = selectedTracks.every((track) => trackMode(track) === secondMode);
      get().setTracksAutomationMode(trackIds, allAtSecondMode ? firstMode : secondMode);
    },

    setTracksAutomationVisibility: (trackIds, visible) => {
      if (isAutomationEditLocked(get())) return;
      const ids = new Set(trackIds);
      if (ids.size === 0) return;
      const before = captureAutomationProjectSnapshot(get());
      set((state) => ({
        tracks: state.tracks.map((track) => {
          if (!ids.has(track.id) || track.automationLanes.length === 0) return track;
          if (!visible) return track.showAutomation ? { ...track, showAutomation: false } : track;
          return {
            ...track,
            showAutomation: true,
            automationLanes: track.automationLanes.map((lane) => (
              lane.points.length > 0 ? { ...lane, visible: true } : lane
            )),
          };
        }),
      }));
      pushAppliedAutomationProjectCommand(
        set,
        get,
        before,
        captureAutomationProjectSnapshot(get()),
        visible ? "SHOW_SELECTED_TRACK_AUTOMATION" : "HIDE_SELECTED_TRACK_AUTOMATION",
        visible ? "Show selected track automation" : "Hide selected track automation",
      );
    },

    suspendAutomation: () => {
      const state = get();
      if (isAutomationEditLocked(state)) return;
      if (_automationWriteSessionSnapshots.size > 0) get().endAutomationWriteSession();
      const hasUnsuspended = state.tracks.some((track) => (
        !track.suspendedAutomationState
        && (track.automationLanes.length > 0 || trackReadEnabled(track) || trackWriteEnabled(track))
      )) || (
        !state.suspendedMasterAutomationState
        && (state.masterAutomationLanes.length > 0 || state.masterAutomationReadEnabled || state.masterAutomationWriteEnabled)
      );
      if (!hasUnsuspended) return;
      const before = captureAutomationProjectSnapshot(state);
      set((current) => ({
        tracks: current.tracks.map((track) => {
          if (
            track.suspendedAutomationState
            || (track.automationLanes.length === 0 && !trackReadEnabled(track) && !trackWriteEnabled(track))
          ) return track;
          return {
            ...track,
            suspendedAutomationState: buildAutomationSuspendSnapshot(track),
            automationReadEnabled: false,
            automationWriteEnabled: false,
            automationEnabled: false,
            automationLanes: track.automationLanes.map((lane) => ({
              ...lane,
              mode: "off",
              armed: false,
              readEnabled: false,
            })),
          };
        }),
        ...(current.suspendedMasterAutomationState
          || (current.masterAutomationLanes.length === 0
            && !current.masterAutomationReadEnabled
            && !current.masterAutomationWriteEnabled)
          ? {}
          : {
              suspendedMasterAutomationState: {
                showAutomation: current.showMasterAutomation,
                automationReadEnabled: current.masterAutomationReadEnabled,
                automationWriteEnabled: current.masterAutomationWriteEnabled,
                automationEnabled: current.masterAutomationEnabled,
                lanes: Object.fromEntries(current.masterAutomationLanes.map((lane) => [
                  lane.id,
                  {
                    visible: lane.visible,
                    armed: lane.armed,
                    mode: lane.mode,
                    readEnabled: automationLaneReadEnabled(lane),
                  },
                ])),
              },
              masterAutomationReadEnabled: false,
              masterAutomationWriteEnabled: false,
              masterAutomationEnabled: false,
              masterAutomationLanes: current.masterAutomationLanes.map((lane) => ({
                ...lane,
                mode: "off",
                armed: false,
                readEnabled: false,
              })),
            }),
        isModified: true,
      }));
      _automationTouchedParams.clear();
      _automationLatchedParams.clear();
      _automationWriteValues.clear();
      _autoRecordTimers.clear();
      const after = captureAutomationProjectSnapshot(get());
      applyAutomationProjectSnapshot(set, get, after);
      pushAppliedAutomationProjectCommand(set, get, before, after, "SUSPEND_AUTOMATION", "Suspend automation");
    },

    resumeAutomation: () => {
      const state = get();
      if (isAutomationEditLocked(state)) return;
      if (
        !state.suspendedMasterAutomationState
        && !state.tracks.some((track) => track.suspendedAutomationState)
      ) return;
      const before = captureAutomationProjectSnapshot(state);
      set((current) => ({
        tracks: current.tracks.map((track) => {
          const snapshot = track.suspendedAutomationState;
          if (!snapshot) return track;
          return {
            ...track,
            showAutomation: snapshot.showAutomation,
            automationReadEnabled: snapshot.automationReadEnabled ?? false,
            automationWriteEnabled: snapshot.automationWriteEnabled ?? false,
            automationEnabled: snapshot.automationEnabled ?? snapshot.automationReadEnabled ?? false,
            suspendedAutomationState: null,
            automationLanes: track.automationLanes.map((lane) => {
              const laneState = snapshot.lanes[lane.id];
              return laneState ? { ...lane, ...laneState } : lane;
            }),
          };
        }),
        ...(current.suspendedMasterAutomationState
          ? {
              showMasterAutomation: current.suspendedMasterAutomationState.showAutomation,
              masterAutomationReadEnabled: current.suspendedMasterAutomationState.automationReadEnabled ?? false,
              masterAutomationWriteEnabled: current.suspendedMasterAutomationState.automationWriteEnabled ?? false,
              masterAutomationEnabled: current.suspendedMasterAutomationState.automationEnabled
                ?? current.suspendedMasterAutomationState.automationReadEnabled
                ?? false,
              masterAutomationLanes: current.masterAutomationLanes.map((lane) => {
                const laneState = current.suspendedMasterAutomationState?.lanes[lane.id];
                return laneState ? { ...lane, ...laneState } : lane;
              }),
              suspendedMasterAutomationState: null,
            }
          : {}),
        isModified: true,
      }));
      const after = captureAutomationProjectSnapshot(get());
      applyAutomationProjectSnapshot(set, get, after);
      pushAppliedAutomationProjectCommand(set, get, before, after, "RESUME_AUTOMATION", "Resume automation");
    },

});
