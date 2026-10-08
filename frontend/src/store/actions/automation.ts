import type { StoreApi } from "zustand";
import type { DAWState, DAWActions, AutomationLane, AutomationPoint, Track, AutomationSuspendSnapshot, AutomationWriteBehavior } from "../useDAWStore";
import { automationCrossOverTime } from "../../utils/automationCrossOver";
import { automationPunchedParameters, automationWriteKey, automationPunchOwnsTrack } from "../../utils/automationWriteOwnership";
import { editEnvelopeRange } from "../../utils/automationEnvelopeEdits";
import { nativeBridge } from "../../services/NativeBridge";
import { bindStageFXHistoryStore, editFXStage } from "../../utils/stageFXHistory";
import { retryUnavailableFX } from "../../services/fxRecovery";
import { getProjectEpoch } from "../../utils/projectLifetime";
import { enqueueFXMutation } from "../../utils/fxMutationQueue";
import { clearPluginParameterManifests, registerPluginParameterManifest, retirePluginAutomationLane, validatePluginAutomationLane } from "../../utils/pluginParameterManifest";
import { savedAutomationAddress, resolveSavedSafeParameter } from "../../utils/automationRecovery";
import type { Command } from "../commands/CommandManager";
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
  automationLaneIsDiscrete,
  quantizeAutomationLaneValue,
  parseSendAutomationParamId,
  sendAutomationParamId,
  VOLUME_DB_RANGE,
  VOLUME_MIN_DB,
} from "../automationParams";
import {
  syncAutomationLaneToBackend,
  bindAutomationSyncState,
  _autoRecordTimers,
  AUTO_RECORD_INTERVAL_MS,
  _automationTouchedParams,
  _automationLatchedParams,
  _automationWriteValues,
  automationTouchKey,
  automationLaneReadEnabled,
  automationWriteBehaviorToBackendMode,
  effectiveAutomationWriteBehavior,
} from "./storeHelpers";

type SetFn = StoreApi<DAWState & DAWActions>["setState"];
type GetFn = StoreApi<DAWState & DAWActions>["getState"];
type State = DAWState & DAWActions;
type AutomationOwner = Pick<Track, "id"> & Partial<Track>;
type AutomationProjectSnapshot = ReturnType<typeof captureAutomationProjectSnapshot>;
type TrackModeSnapshot = ReturnType<typeof captureTrackAutomationModeSnapshot>;


function replayTrackFXHistory(set: SetFn, _get: GetFn, epoch: number, operation: () => Promise<unknown>) {
  return enqueueFXMutation(async () => {
    if (epoch !== getProjectEpoch()) return;
    set({ automationRecoveryBusy: true });
    try { await operation(); }
    finally { if (epoch === getProjectEpoch()) set({ automationRecoveryBusy: false }); }
  });
}

export function isAutomationEditLocked(state: State): boolean {
  return Boolean(state?.globalLocked || state?.lockSettings?.envelopes);
}

function buildAutomationSuspendSnapshot(track: AutomationOwner): AutomationSuspendSnapshot {
  return {
    showAutomation: Boolean(track.showAutomation),
    automationReadEnabled: trackReadEnabled(track),
    automationWriteEnabled: trackWriteEnabled(track),
    automationEnabled: trackReadEnabled(track),
    lanes: Object.fromEntries(
      (track.automationLanes ?? []).map(lane => [
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
  points: AutomationPoint[];
}>();
const _automationNativeCapturedParams = new Set<string>();
const _automationNativeCaptureTimes = new Map<string, number>();
const _automationGestureOriginal = new Map<string, { points: AutomationPoint[]; start: number; guarded: boolean; hadPoints: boolean }>();
const _automationCrossOver = new Map<string, { original: AutomationPoint[]; gestures: number; released: boolean; punchedOut: boolean; difference: number; time: number }>();
let _automationJoinPreparation=0;
let _automationJoinPreparationQueue:Promise<void>=Promise.resolve();

let _automationPointEditSnapshot: null | {
  target: NonNullable<State["selectedAutomationTarget"]>;
  originalPoints: AutomationPoint[];
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

export function getAutomationPointId(point: AutomationPoint, index: number) {
  const time = Math.max(0, Number(point?.time) || 0);
  const value = clamp01(Number(point?.value));
  return typeof point?.id === "string" && point.id.length > 0
    ? point.id
    : `legacy-automation-point-${index}-${Math.round(time * 1_000_000)}-${Math.round(value * 1_000_000)}`;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function currentNormalizedAutomationValue(track: AutomationOwner | undefined, lane: AutomationLane, time: number): number {
  if (!track) return lane.points.length ? interpolateAtTime(lane.points, time) : getAutomationDefault(lane.param);
  const writeValue = _automationWriteValues.get(automationTouchKey(track.id, lane.param));
  if (writeValue !== undefined)
    return clamp01(writeValue);

  const sendTarget = parseSendAutomationParamId(lane.param);
  if (sendTarget) {
    const send = track.sends?.find(item => item.destTrackId === sendTarget.destinationId);
    if (send) return sendTarget.control === "trim" ? clamp01(((send.trimDB ?? 0) - VOLUME_MIN_DB) / VOLUME_DB_RANGE) : sendTarget.control === "level" ? clamp01(send.level)
      : sendTarget.control === "pan" ? clamp01((send.pan + 1) / 2) : send.enabled ? 0 : 1;
  }

  switch (lane.param) {
    case "volume":
      return clamp01(((track.volumeDB ?? 0) - VOLUME_MIN_DB) / VOLUME_DB_RANGE);
    case "pan":
    case "pan_prefx":
      return clamp01(((track.pan ?? 0) + 1) / 2);
    case "width":
      return clamp01((track.stereoWidth ?? 100) / 200);
    case "trim_volume":
      return clamp01(((track.trimVolumeDB ?? 0) - VOLUME_MIN_DB) / VOLUME_DB_RANGE);
    case "volume_prefx":
    case "width_prefx":
    case "midi_pitch_bend":
      return lane.points?.length ? interpolateAtTime(lane.points, time) : getAutomationDefault(lane.param);
    case "mute":
      return track.muted ? 1 : 0;
    default:
      return lane.points?.length ? interpolateAtTime(lane.points, time) : getAutomationDefault(lane.param);
  }
}

function automationGestureBaseline(trackId: string, state: State, lane: AutomationLane, time: number, initialValue?: number) {
  if (lane.points.length) return normalizeAutomationPoints(lane.points);
  const track = trackId === "master" ? masterAutomationTrack(state) : state.tracks.find(item => item.id === trackId);
  const value = Number.isFinite(initialValue) ? clamp01(initialValue!) : lane.metadata?.initialNormalized ?? currentNormalizedAutomationValue(track, lane, time);
  return [{ id: createAutomationPointId(), time: 0, value }];
}

function writeAutomationGesturePoint(trackId: string, lane: AutomationLane, time: number, value: number, radius: number) {
  const gesture = _automationGestureOriginal.get(automationTouchKey(trackId, lane.param));
  const start = Math.max(gesture?.start ?? 0, time - radius), end = time + radius;
  const guard = gesture && !gesture.guarded && gesture.points.length && gesture.start > 0
    ? { id: createAutomationPointId(), time: Math.max(0, gesture.start - .000001), value: originalCrossOverValue(lane, gesture.points, Math.max(0, gesture.start - .000001)) } : undefined;
  if (gesture) gesture.guarded = true;
  const source = lane.points.length ? lane.points : gesture?.points ?? [];
  const points = normalizeAutomationPoints([...source.filter(point => point.time < start || point.time > end),
    ...(guard ? [guard] : []), { id: createAutomationPointId(), time: Math.max(0, time), value: clamp01(value) }]);
  return { points, guarded: Boolean(guard) };
}

function isDiscreteAutomationParam(param: string) {
  return param === "mute" || param === "midi_cc_64" || parseSendAutomationParamId(param)?.control === "mute";
}

function linearAutomationError(point: AutomationPoint, start: AutomationPoint, end: AutomationPoint) {
  const duration = end.time - start.time;
  if (duration <= 0.000001)
    return Math.abs(point.value - start.value);

  const t = (point.time - start.time) / duration;
  const expected = start.value + (end.value - start.value) * t;
  return Math.abs(point.value - expected);
}

function simplifyAutomationPointsRDP(points: AutomationPoint[], tolerance: number) {
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

function simplifyContinuousAutomationWritePoints(param: string, points: AutomationPoint[], focusTime: number, sessionStartTime?: number, discrete = false) {
  const normalized = normalizeAutomationPoints(points);
  if (discrete || isDiscreteAutomationParam(param) || normalized.length < 4)
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

function normalizeAutomationPoints(points: AutomationPoint[] = []) {
  return points
    .map((point, index) => {
      const time = Math.max(0, Number(point?.time) || 0);
      const value = clamp01(Number(point?.value));
      const id = getAutomationPointId(point, index);
      return { id, time, value };
    })
    .sort((a, b) => a.time - b.time);
}

function trackReadEnabled(track: AutomationOwner | undefined): boolean {
  if (typeof track?.automationReadEnabled === "boolean") return track.automationReadEnabled;
  if (typeof track?.automationEnabled === "boolean") return track.automationEnabled;
  return (track?.automationLanes?.length ?? 0) > 0;
}

function trackWriteEnabled(track: AutomationOwner | undefined): boolean {
  return track?.automationWriteEnabled === true || track?.automationTrimWriteEnabled === true || automationPunchOwnsTrack(track?.id ?? "");
}

function parameterWriteEnabled(track: AutomationOwner | undefined, param: string): boolean {
  if (!track) return false;
  if(automationPunchedParameters.has(automationWriteKey(track?.id,param)))return true;
  return track?.automationTrimWriteEnabled === true ? param === "trim_volume" || parseSendAutomationParamId(param)?.control === "trim" : track?.automationWriteEnabled === true;
}

function masterVolumeDb(state: State): number {
  const volume = Number(state?.masterVolume);
  if (!Number.isFinite(volume) || volume <= 0) return VOLUME_MIN_DB;
  return 20 * Math.log10(volume);
}

function masterAutomationTrack(state: State): AutomationOwner {
  return {
    id: "master",
    volumeDB: masterVolumeDb(state),
    pan: Number.isFinite(Number(state?.masterPan)) ? Number(state.masterPan) : 0,
    muted: Boolean(state?.isMasterMuted),
    trimVolumeDB: state?.automationTrimLiveValues?.master ?? state?.masterTrimVolumeDB ?? 0,
    automationTrimWriteEnabled: state?.masterAutomationTrimWriteEnabled === true,
    automationReadEnabled: state?.masterAutomationReadEnabled === true,
    automationWriteEnabled: state?.masterAutomationWriteEnabled === true,
    automationEnabled: state?.masterAutomationEnabled === true,
    automationLanes: state?.masterAutomationLanes || [],
  };
}

function writeBehavior(get: GetFn) {
  return get().automationWriteBehavior ?? "touch";
}

function automationTransportRolling(state: State): boolean {
  return Boolean(state?.transport?.isPlaying || state?.transport?.isRecording);
}

function resolvedLaneMode(track: AutomationOwner | undefined, lane: AutomationLane, behavior: AutomationWriteBehavior, activeWriting = false) {
  if (!track || !trackReadEnabled(track) || !automationLaneReadEnabled(lane))
    return "off";
  if (!parameterWriteEnabled(track, lane.param))
    return "read";
  if(automationPunchedParameters.has(automationWriteKey(track?.id,lane.param)))return "latch";
  if (behavior === "overwrite" && !activeWriting)
    return "read";
  return automationWriteBehaviorToBackendMode(behavior, lane.param);
}

export function withResolvedLaneMode(track: AutomationOwner | undefined, lane: AutomationLane, behavior: AutomationWriteBehavior, activeWriting = false) {
  const readEnabled = automationLaneReadEnabled(lane);
  return {
    ...lane,
    readEnabled,
    mode: resolvedLaneMode(track, { ...lane, readEnabled }, behavior, activeWriting),
  };
}

function syncTrackAutomationModes(track: AutomationOwner, behavior: AutomationWriteBehavior) {
  for (const lane of track.automationLanes || []) {
    const key = automationTouchKey(track.id, lane.param);
    const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
    syncAutomationLaneToBackend(track.id, withResolvedLaneMode(track, lane, behavior, activeWriting));
  }
}

function clearAutomationTouchState(trackId: string, param: string) {
  const key = automationTouchKey(trackId, param);
  _automationCrossOver.delete(key);
  _automationNativeCapturedParams.delete(key);
  _automationNativeCaptureTimes.delete(key);
  _automationGestureOriginal.delete(key);
  const wasTouched = _automationTouchedParams.delete(key);
  const wasLatched = _automationLatchedParams.delete(key);
  const hadWriteValue = _automationWriteValues.delete(key);
  const hadTimer = _autoRecordTimers.delete(key);
  const hadSessionStart = _automationWriteSessionStartTimes.delete(key);
  nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
  return wasTouched || wasLatched || hadWriteValue || hadTimer || hadSessionStart;
}

function syncAutomationLaneAfterManualEdit(trackId: string, lane: AutomationLane, resetWriteState: boolean) {
  if (!resetWriteState) {
    syncAutomationLaneToBackend(trackId, lane);
    return;
  }

  nativeBridge
    .setAutomationMode(trackId, lane.param, "read")
    .catch(logBridgeError("sync"))
    .then(() => syncAutomationLaneToBackend(trackId, lane));
}

function captureTrackAutomationModeSnapshot(state: State, trackId: string) {
  const track = state.tracks.find(candidate => candidate.id === trackId);
  if (!track) return null;
  return {
    trackId,
    automationReadEnabled: track.automationReadEnabled,
    automationWriteEnabled: track.automationWriteEnabled,
    automationEnabled: track.automationEnabled,
    automationLanes: (track.automationLanes ?? []).map(lane => ({ ...lane })),
    hadAutomatedValues: Object.prototype.hasOwnProperty.call(state.automatedParamValues || {}, trackId),
    automatedValues: state.automatedParamValues?.[trackId]
      ? { ...state.automatedParamValues[trackId] }
      : undefined,
  };
}

function applyTrackAutomationModeSnapshot(set: SetFn, get: GetFn, snapshot: TrackModeSnapshot) {
  if (!snapshot) return;
  set(state => {
    const automatedParamValues = { ...(state.automatedParamValues || {}) };
    if (snapshot.hadAutomatedValues) {
      automatedParamValues[snapshot.trackId] = { ...(snapshot.automatedValues || {}) };
    } else {
      delete automatedParamValues[snapshot.trackId];
    }
    return {
      tracks: state.tracks.map(track => track.id === snapshot.trackId
        ? {
            ...track,
            automationReadEnabled: snapshot.automationReadEnabled,
            automationWriteEnabled: snapshot.automationWriteEnabled,
            automationEnabled: snapshot.automationEnabled,
            automationLanes: snapshot.automationLanes.map(lane => ({ ...lane })),
          }
        : track),
      automatedParamValues,
      isModified: true,
    };
  });
  const track = get().tracks.find(candidate => candidate.id === snapshot.trackId);
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

function cloneAutomationLane<L extends Pick<AutomationLane, "param" | "points"> & Partial<AutomationLane>>(lane: L): L {
  return {
    ...lane,
    points: normalizeAutomationPoints(lane?.points || []),
  };
}

function originalCrossOverValue(lane: AutomationLane, points: AutomationPoint[], time: number) {
  if (!points.length) return lane.metadata?.initialNormalized ?? getAutomationDefault(lane.param);
  if (!automationLaneIsDiscrete(lane)) return interpolateAtTime(points, time);
  return [...points].reverse().find(point => point.time <= time)?.value ?? points[0].value;
}

function beginCrossOver(trackId: string, lane: AutomationLane, time: number) {
  const key = automationTouchKey(trackId, lane.param);
  const previous = _automationCrossOver.get(key);
  if (_automationTouchedParams.has(key)) return;
  const original = previous && !previous.punchedOut ? previous.original : normalizeAutomationPoints(lane.points);
  const value = _automationWriteValues.get(key) ?? originalCrossOverValue(lane, original, time);
  _automationCrossOver.set(key, { original, gestures: previous && !previous.punchedOut ? previous.gestures + 1 : 1,
    released: false, punchedOut: false, difference: value - originalCrossOverValue(lane, original, time), time });
  if (!_automationWriteSessionSnapshots.has(key)) _automationWriteSessionSnapshots.set(key, { trackId, laneId: lane.id, points: normalizeAutomationPoints(lane.points) });
}

function punchOutCrossOver(set: SetFn, get: GetFn, trackId: string, param: string, value: number, capture?: { time?: number; allowStopped?: boolean }) {
  if (writeBehavior(get) !== "cross-over") return false;
  const key = automationTouchKey(trackId, param), pass = _automationCrossOver.get(key);
  if (!pass) return false;
  if (pass.punchedOut) return true;
  if (pass.gestures < 2 || !_automationTouchedParams.has(key)) return false;
  const state = get(), lane = trackId === "master" ? state.masterAutomationLanes.find(item => item.param === param)
    : state.tracks.find(track => track.id === trackId)?.automationLanes.find(item => item.param === param);
  if (!lane || !pass.original.length) return false;
  const time = Math.max(0, capture?.time ?? state.transport.currentTime);
  const difference = value - originalCrossOverValue(lane, pass.original, time);
  const crossingTime = automationCrossOverTime(pass.original, pass.time, time,
    pass.difference + originalCrossOverValue(lane, pass.original, pass.time), value, automationLaneIsDiscrete(lane));
  if (crossingTime === undefined) { pass.difference = difference; pass.time = time; return false; }
  const junction = { id: createAutomationPointId(), time: crossingTime, value: originalCrossOverValue(lane, pass.original, crossingTime) };
  const points = normalizeAutomationPoints([...lane.points.filter(point => point.time < crossingTime), junction, ...pass.original.filter(point => point.time > crossingTime)]);
  const update = (item: AutomationLane): AutomationLane => item.id === lane.id ? { ...item, points, mode: "read" } : item;
  set(current => trackId === "master" ? { masterAutomationLanes: current.masterAutomationLanes.map(update), isModified: true }
    : { tracks: current.tracks.map(track => track.id === trackId ? { ...track, automationLanes: track.automationLanes.map(update) } : track), isModified: true });
  pass.punchedOut = true;
  _automationTouchedParams.delete(key); _automationLatchedParams.delete(key); _automationWriteValues.delete(key); _autoRecordTimers.delete(key);
  void nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
  syncAutomationLaneToBackend(trackId, { ...lane, points, mode: "read" });
  return true;
}

function applyTouchReturn(set: SetFn, get: GetFn, trackId: string, lane: AutomationLane, capture?: { time: number; allowStopped?: boolean }) {
  const state = get();
  const seconds = Math.max(0, Math.min(5, state.automationTouchReturnSeconds ?? 0));
  const key = automationTouchKey(trackId, lane.param);
  const original = _automationGestureOriginal.get(key) ?? _automationWriteSessionSnapshots.get(key);
  const value = _automationWriteValues.get(key);
  if (!original?.points.length || ("hadPoints" in original && !original.hadPoints) || automationLaneIsDiscrete(lane) || value === undefined || !Number.isFinite(value)
    || (!automationTransportRolling(state) && !capture?.allowStopped)) return false;
  const time = Math.max(0, capture?.time ?? state.transport.currentTime);
  const end = time + Math.max(.000001, automationLaneIsDiscrete(lane) ? 0 : seconds);
  const target = originalCrossOverValue(lane, original.points, end) ?? getAutomationDefault(lane.param);
  const points = normalizeAutomationPoints([...lane.points.filter(point => point.time < time), ...original.points.filter(point => point.time > end)].concat([
    { id: createAutomationPointId(), time, value }, { id: createAutomationPointId(), time: end, value: target },
  ]));
  set(current => trackId === "master" ? { masterAutomationLanes: current.masterAutomationLanes.map(item => item.id === lane.id ? { ...item, points } : item), isModified: true }
    : { tracks: current.tracks.map(track => track.id === trackId ? { ...track,
      automationLanes: track.automationLanes.map(item => item.id === lane.id ? { ...item, points } : item) } : track), isModified: true });
  // Publish the exact ramp that was written before releasing native Touch.
  void nativeBridge.setAutomationPoints(trackId, lane.param, points.map(point => ({ time: point.time, value: automationToBackend(lane.param, point.value) })))
    .catch(logBridgeError("Touch return"))
    .finally(() => {
      if (!_automationTouchedParams.has(key)) void nativeBridge.endTouchAutomation(trackId, lane.param).catch(() => {});
    });
  return true;
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

export function remapTrackFXAutomationLanes<L extends Pick<AutomationLane, "param" | "points"> & Partial<AutomationLane>>(
  lanes: readonly L[],
  chainType: TrackFXAutomationChain,
  mapIndex: (fxIndex: number) => number | null,
) {
  const next: L[] = [];
  for (const lane of lanes || []) {
    const parameterOnly = lane?.unavailableParameter?.parameterOnly;
    const parsed = parseTrackFXAutomationParam(parameterOnly ? lane.unavailableParameter!.param : lane?.param);
    if (!parsed || parsed.chainType !== chainType) {
      next.push(cloneAutomationLane(lane));
      continue;
    }

    const mappedIndex = mapIndex(parsed.fxIndex);
    if (mappedIndex === null) continue;
    const param = replaceTrackFXAutomationIndex(parsed, mappedIndex);
    next.push({
      ...cloneAutomationLane(lane),
      param: parameterOnly ? lane.unavailableParameter!.manualRecoveryRequired ? `unavailable_references:${param}:${lane.id}` : `unavailable_parameter:${param}` : param,
      ...(parameterOnly ? { unavailableParameter: { ...lane.unavailableParameter!, param } } : {}),
    });
  }
  return next;
}

export function reorderTrackFXAutomationLanes<L extends Pick<AutomationLane, "param" | "points"> & Partial<AutomationLane>>(
  lanes: readonly L[],
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

export function removeTrackFXAutomationLanes<L extends Pick<AutomationLane, "param" | "points"> & Partial<AutomationLane>>(
  lanes: readonly L[],
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
  automationLanes: readonly AutomationLane[],
  automationSafeParams?: string[],
) {
  const countField = chainType === "input" ? "inputFxCount" : "trackFxCount";
  const clonedLanes = automationLanes.map(cloneAutomationLane);
  set(state => ({
    tracks: state.tracks.map(track => track.id === trackId
      ? { ...track, [countField]: fxCount, automationLanes: clonedLanes,
        ...(automationSafeParams ? { automationSafeParams } : {}) }
      : track),
    isModified: true,
  }));
  const updatedTrack = get().tracks.find(track => track.id === trackId);
  for (const lane of updatedTrack?.automationLanes || []) {
    syncAutomationLaneToBackend(trackId, lane);
  }
  notifyFXChainChanged({ trackId, chainType });
}

function cloneAutomationSuspendSnapshot(snapshot: AutomationSuspendSnapshot | null | undefined) {
  if (!snapshot) return null;
  return {
    ...snapshot,
    lanes: Object.fromEntries(
      Object.entries(snapshot.lanes || {}).map(([laneId, laneState]) => [
        laneId,
        { ...(laneState as AutomationSuspendSnapshot["lanes"][string]) },
      ]),
    ),
  };
}

function isInstrumentAutomationParam(param: string) {
  return param.startsWith("plugin_instrument_") || param.startsWith("builtin_instrument_");
}

function applyInstrumentAutomationLanes(set: SetFn, get: GetFn, trackId: string, lanes: readonly AutomationLane[], safeParams: readonly string[] = []) {
  const track = get().tracks.find(candidate => candidate.id === trackId);
  if (!track) return;
  for (const lane of track.automationLanes.filter(candidate => isInstrumentAutomationParam(candidate.param))) {
    clearAutomationTouchState(trackId, lane.param);
    nativeBridge.clearAutomation(trackId, lane.param).catch(() => {});
  }
  set(state => ({
    tracks: state.tracks.map(candidate => candidate.id === trackId
      ? { ...candidate, automationSafeParams: [
          ...(candidate.automationSafeParams ?? []).filter((param: string) => !isInstrumentAutomationParam(param)),
          ...safeParams,
        ], automationLanes: [
          ...candidate.automationLanes.filter(lane => !isInstrumentAutomationParam(lane.param)),
          ...lanes.map(cloneAutomationLane),
        ] }
      : candidate),
    isModified: true,
  }));
  for (const lane of lanes) syncAutomationLaneToBackend(trackId, lane);
}

export function captureAutomationProjectSnapshot(state: State) {
  return {
    automationWriteBehavior: state.automationWriteBehavior ?? "touch",
    automationTouchReturnSeconds: state.automationTouchReturnSeconds ?? 0,
    automationTrimCoalesce: state.automationTrimCoalesce ?? "manual",
    automationAutoJoinEnabled: state.automationAutoJoinEnabled ?? false,
    masterAutomationSafeParams: [...(state.masterAutomationSafeParams ?? [])],
    tracks: (state.tracks || []).map(track => ({
      id: track.id,
      automationSafeParams: [...(track.automationSafeParams ?? [])],
      showAutomation: Boolean(track.showAutomation),
      automationReadEnabled: trackReadEnabled(track),
      automationWriteEnabled: track.automationWriteEnabled === true,
      automationTrimWriteEnabled: track.automationTrimWriteEnabled === true,
      trimVolumeDB: track.trimVolumeDB ?? 0,
      sendTrimDBs: Object.fromEntries((track.sends ?? []).map(send => [send.destTrackId, send.trimDB ?? 0])),
      automationEnabled: trackReadEnabled(track),
      suspendedAutomationState: cloneAutomationSuspendSnapshot(track.suspendedAutomationState),
      automationLanes: (track.automationLanes ?? []).map(cloneAutomationLane),
    })),
    showMasterAutomation: Boolean(state.showMasterAutomation),
    masterAutomationReadEnabled: state.masterAutomationReadEnabled === true,
    masterAutomationWriteEnabled: state.masterAutomationWriteEnabled === true,
    masterAutomationTrimWriteEnabled: state.masterAutomationTrimWriteEnabled === true,
    masterTrimVolumeDB: state.masterTrimVolumeDB ?? 0,
    masterAutomationEnabled: state.masterAutomationEnabled === true,
    suspendedMasterAutomationState: cloneAutomationSuspendSnapshot(
      state.suspendedMasterAutomationState,
    ),
    masterAutomationLanes: (state.masterAutomationLanes || []).map(cloneAutomationLane),
  };
}

function automationProjectSnapshotsEqual(before: AutomationProjectSnapshot, after: AutomationProjectSnapshot) {
  return JSON.stringify(before) === JSON.stringify(after);
}

export function applyAutomationProjectSnapshot(
  set: SetFn,
  get: GetFn,
  snapshot: AutomationProjectSnapshot,
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
    (snapshot.tracks || []).map(track => [track.id, track]),
  );
  const validateSaved = (id: string, lanes: AutomationLane[], safe: string[]) => lanes.map(lane => {
    const validated = validatePluginAutomationLane(id, cloneAutomationLane(lane));
    return validated.unavailableParameter?.manualRecoveryRequired && safe.includes(validated.unavailableParameter.param)
      ? { ...validated, unavailableParameter: { ...validated.unavailableParameter, safe: true } } : validated;
  });
  const savedMasterSafe = snapshot.masterAutomationSafeParams ?? [];
  const masterLanes = validateSaved("master", snapshot.masterAutomationLanes, savedMasterSafe);
  const activeSafe = (safe: string[], lanes: AutomationLane[]) => safe.filter(param => !lanes.some(lane => lane.unavailableParameter?.manualRecoveryRequired && lane.unavailableParameter.param === param));
  set(state => ({
    automationWriteBehavior: snapshot.automationWriteBehavior,
    automationTouchReturnSeconds: snapshot.automationTouchReturnSeconds ?? 0,
    automationTrimCoalesce: snapshot.automationTrimCoalesce ?? "manual",
    automationAutoJoinEnabled: snapshot.automationAutoJoinEnabled ?? false,
    automationJoinSession:null,
    masterAutomationSafeParams: activeSafe(savedMasterSafe, masterLanes),
    tracks: state.tracks.map(track => {
      const saved = byTrackId.get(track.id);
      if (!saved) return track;
      const safe = saved.automationSafeParams ?? [], lanes = validateSaved(track.id, saved.automationLanes, safe);
      return {
        ...track,
        automationSafeParams: activeSafe(safe, lanes),
        showAutomation: saved.showAutomation,
        automationReadEnabled: saved.automationReadEnabled,
        automationWriteEnabled: saved.automationWriteEnabled,
        automationTrimWriteEnabled: saved.automationTrimWriteEnabled === true,
        trimVolumeDB: saved.trimVolumeDB ?? 0,
        sends: track.sends.map(send => ({...send, trimDB:saved.sendTrimDBs?.[send.destTrackId] ?? send.trimDB ?? 0})),
        automationEnabled: saved.automationEnabled,
        suspendedAutomationState: cloneAutomationSuspendSnapshot(
          saved.suspendedAutomationState,
        ),
        automationLanes: lanes,
      };
    }),
    showMasterAutomation: snapshot.showMasterAutomation,
    masterAutomationReadEnabled: snapshot.masterAutomationReadEnabled,
    masterAutomationWriteEnabled: snapshot.masterAutomationWriteEnabled,
    masterAutomationTrimWriteEnabled: snapshot.masterAutomationTrimWriteEnabled === true,
    masterTrimVolumeDB: snapshot.masterTrimVolumeDB ?? 0,
    masterAutomationEnabled: snapshot.masterAutomationEnabled,
    suspendedMasterAutomationState: cloneAutomationSuspendSnapshot(
      snapshot.suspendedMasterAutomationState,
    ),
    masterAutomationLanes: masterLanes,
    isModified: true,
  }));

  _automationTouchedParams.clear();
  _automationLatchedParams.clear();
  _autoRecordTimers.clear();
  _automationWriteValues.clear();
  _automationWriteSessionStartTimes.clear();
  _automationCrossOver.clear();
  _automationNativeCapturedParams.clear();
  _automationNativeCaptureTimes.clear();
  _automationGestureOriginal.clear();
  automationPunchedParameters.clear();

  get().restoreAutomationTrimLiveValues?.();
  const state = get();
  void nativeBridge.setAutomationTrimValue("master", state.masterTrimVolumeDB ?? 0);
  for (const track of state.tracks || []) void nativeBridge.setAutomationTrimValue(track.id, track.trimVolumeDB ?? 0);
  for (const track of state.tracks || []) for (const send of track.sends ?? []) void nativeBridge.setAutomationTrimValue(track.id, send.trimDB ?? 0, sendAutomationParamId(send.destTrackId, "trim"));
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
  before: AutomationProjectSnapshot,
  after: AutomationProjectSnapshot,
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

function resolveAutomationLaneTarget(state: State, target = state.selectedAutomationTarget) {
  if (!target || typeof target.laneId !== "string") return null;
  if (target.kind === "master") {
    const lane = (state.masterAutomationLanes || []).find(
      candidate => candidate.id === target.laneId,
    );
    return lane ? { target, track: null, lane, trackId: "master" } : null;
  }
  if (target.kind !== "track" || typeof target.trackId !== "string") return null;
  const track = (state.tracks || []).find(
    candidate => candidate.id === target.trackId,
  );
  const lane = track?.automationLanes?.find(
    candidate => candidate.id === target.laneId,
  );
  return track && lane ? { target, track, lane, trackId: track.id } : null;
}

function resolveAutomationPointTarget(state: State, target = state.selectedAutomationTarget) {
  const resolved = resolveAutomationLaneTarget(state, target);
  if (!resolved || typeof target?.pointId !== "string") return null;
  const pointIndex = resolved.lane.points.findIndex(
    (point: AutomationPoint, index: number) => getAutomationPointId(point, index) === target.pointId,
  );
  if (pointIndex < 0) return null;
  return { ...resolved, pointIndex, point: resolved.lane.points[pointIndex] };
}

function applyAutomationTargetPoints(
  set: SetFn,
  get: GetFn,
  target: NonNullable<State["selectedAutomationTarget"]>,
  points: AutomationPoint[],
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
    set(state => ({
      masterAutomationLanes: state.masterAutomationLanes.map(lane =>
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
      candidate => candidate.id === target.laneId,
    );
    if (lane) syncAutomationLaneToBackend("master", lane);
    return;
  }

  set(state => ({
    tracks: state.tracks.map(track => track.id !== target.trackId
      ? track
      : {
          ...track,
          automationLanes: track.automationLanes.map(lane =>
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
  const lane = get().tracks.find(track => track.id === target.trackId)
    ?.automationLanes.find(candidate => candidate.id === target.laneId);
  if (lane) syncAutomationLaneAfterManualEdit(target.trackId, lane, false);
}

function applyRecordedAutomationWritePass(
  set: SetFn,
  get: GetFn,
  changes: Array<{
    trackId: string;
    laneId: string;
    beforePoints: AutomationPoint[];
    afterPoints: AutomationPoint[];
  }>,
  side: "beforePoints" | "afterPoints",
) {
  set(state => ({
    tracks: state.tracks.map(track => ({
      ...track,
      automationLanes: track.automationLanes.map(lane => {
        const change = changes.find(
          (candidate) => candidate.trackId === track.id && candidate.laneId === lane.id,
        );
        return change ? { ...lane, points: normalizeAutomationPoints(change[side]) } : lane;
      }),
    })),
    masterAutomationLanes: state.masterAutomationLanes.map(lane => {
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
      ? state.masterAutomationLanes.find(candidate => candidate.id === change.laneId)
      : state.tracks.find(track => track.id === change.trackId)
        ?.automationLanes.find(candidate => candidate.id === change.laneId);
    if (lane) syncAutomationLaneToBackend(change.trackId, lane);
  }
  state.updateAutomatedValues?.();
}

export const automationActions = (set: SetFn, get: GetFn) => (bindAutomationSyncState(get), bindStageFXHistoryStore({ getState: get, setState: set }), {
    retirePluginAutomationReferences: (trackId, param) => {
      const state = get(), before = captureAutomationProjectSnapshot(state);
      const owner = trackId === "master" ? state.masterAutomationLanes : state.tracks.find(track => track.id === trackId)?.automationLanes;
      if (!owner?.some(lane => lane.param === param && !lane.unavailableParameter)) return;
      clearAutomationTouchState(trackId, param);
      const safe = trackId === "master" ? (state.masterAutomationSafeParams ?? []) : state.tracks.find(track => track.id === trackId)?.automationSafeParams ?? [];
      const lanes = owner.map(lane => {
        if (lane.param !== param || lane.unavailableParameter) return lane;
        const retired = retirePluginAutomationLane(lane);
        return { ...retired, unavailableParameter: { param, pluginPath: "", ...retired.unavailableParameter, safe: safe.includes(param) } };
      });
      set(current => trackId === "master" ? { masterAutomationLanes: lanes, masterAutomationSafeParams: safe.filter(item => item !== param), isModified: true }
        : { tracks: current.tracks.map(track => track.id === trackId ? { ...track, automationLanes: lanes, automationSafeParams: safe.filter(item => item !== param) } : track), isModified: true });
      for (const lane of lanes) if (lane.unavailableParameter?.param === param) void syncAutomationLaneToBackend(trackId, lane);
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "RETIRE_PLUGIN_AUTOMATION", "Retain automation cleared by plugin");
      get().showToast("The plugin cleared this parameter's automation references. Its previous envelope was retained as an inactive lane; create a new lane to automate the current parameter.", "info");
    },
    refreshPluginAutomationParameters: (trackId, prefix, parameters, pluginPath) => {
      const before = captureAutomationProjectSnapshot(get());
      registerPluginParameterManifest(trackId, prefix, parameters, pluginPath);
      const update = (lanes: AutomationLane[]) => lanes.map(lane => validatePluginAutomationLane(trackId, lane));
      const owner = trackId === "master" ? get().masterAutomationLanes : get().tracks.find(track => track.id === trackId)?.automationLanes;
      if (!owner) return;
      const afterLanes = update(owner);
      const changed = JSON.stringify(owner) !== JSON.stringify(afterLanes);
      if (changed) set(current => trackId === "master" ? { masterAutomationLanes: afterLanes, isModified: true }
        : { tracks: current.tracks.map(track => track.id === trackId ? { ...track, automationLanes: afterLanes } : track), isModified: true });
      for (const lane of afterLanes) {
        if (lane.unavailableParameter?.parameterOnly) {
          clearAutomationTouchState(trackId, lane.unavailableParameter.param);
        }
        syncAutomationLaneToBackend(trackId, lane);
      }
      if (changed) pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "REFRESH_PLUGIN_AUTOMATION", "Refresh plugin automation parameters");
    },
    retryUnavailableFX: (trackId, key) => retryUnavailableFX(set, get, trackId, key),
    retryUnavailableFXStage: async (chain) => {
      const state = get(), slots = state.unavailableFXStages?.[chain], epoch = getProjectEpoch();
      if (!Array.isArray(slots) || !slots.length || state.automationRecoveryBusy || isAutomationEditLocked(state)
        || state.isProjectLoading || state.transport.isPlaying || state.transport.isRecording) return false;
      set({ automationRecoveryBusy: true });
      try {
        return await editFXStage(chain, `Recover ${chain} FX`, async () => {
          const live = await nativeBridge.getFXStageState(chain);
          if (!live || epoch !== getProjectEpoch()) return false;
          const keys = new Set(slots.map(slot => slot.automationKey));
          if (!await nativeBridge.setFXStageState(chain, [...slots, ...live.filter(slot => !keys.has(slot.automationKey))])) {
            get().showToast(`The ${chain} FX stage is still unavailable. Saved settings and envelopes were retained.`, "error");
            return false;
          }
          if (epoch !== getProjectEpoch()) return false;
          try {
            const restoredSlots = await (chain === "master" ? nativeBridge.getMasterFX() : nativeBridge.getMonitoringFX());
            const schemas = await Promise.all(restoredSlots.map(slot => nativeBridge.getPluginParameters(chain, slot.index, false)));
            if (epoch !== getProjectEpoch()) return false;
            schemas.forEach((parameters, index) => {
              const prefixes = new Set(parameters.map(parameter => parameter.automationId && savedAutomationAddress(parameter.automationId)?.prefix).filter((prefix): prefix is string => Boolean(prefix)));
              for (const prefix of prefixes) registerPluginParameterManifest("master", prefix, parameters, restoredSlots[index]?.pluginPath ?? "");
            });
            const safe = (get().masterAutomationSafeParams ?? []).map(param => {
              const address = savedAutomationAddress(param);
              if (address?.chain !== chain) return param;
              const schema = schemas.find(parameters => parameters.some(parameter => parameter.automationId?.startsWith(address.prefix)));
              const contract = get().masterAutomationSafeParameters?.find(entry => entry.param === param)
                ?? { param, metadata: get().masterAutomationLanes.find(lane => lane.param === param)?.metadata };
              const parameter = schema && resolveSavedSafeParameter(contract, schema);
              if (!parameter) throw new Error("A saved Automation Safe control changed or is unavailable");
              return parameter.automationId ?? `${address.prefix}${address.kind === "builtin" ? parameter.paramId : parameter.index}`;
            });
            const contracts = (get().masterAutomationSafeParameters ?? []).map(entry => ({ ...entry,
              param: safe[(get().masterAutomationSafeParams ?? []).indexOf(entry.param)] ?? entry.param }));
            set({ masterAutomationSafeParams: safe, masterAutomationSafeParameters: contracts,
              masterAutomationLanes: get().masterAutomationLanes.map(lane => validatePluginAutomationLane("master", lane)) });
          } catch (error) {
            clearPluginParameterManifests("master", chain);
            if (epoch === getProjectEpoch()) {
              const rolledBack = await nativeBridge.setFXStageState(chain, live).catch(() => false);
              if (!rolledBack) set({ projectRestoreError: `FX recovery rollback failed: ${String(error)}` });
              get().showToast(`The ${chain} FX recovery was rejected: ${String(error)}. Saved controls were retained.`, "error");
            }
            return false;
          }
          set(current => ({ unavailableFXStages: { ...current.unavailableFXStages, [chain]: undefined } }));
          for (const lane of get().masterAutomationLanes) await syncAutomationLaneToBackend("master", lane);
          return true;
        });
      } finally { if (epoch === getProjectEpoch()) set({ automationRecoveryBusy: false }); }
    },
    addTrackFXWithUndo: async (trackId, pluginPath, chainType, pluginType) => {
      const epoch = getProjectEpoch();
      if (get().automationRecoveryBusy || get().globalLocked || get().tracks.find(track => track.id === trackId)?.frozen) return false;
      if (get().automationRecoveryBusy) return false;
      clearPluginParameterManifests(trackId, chainType);
      const addFn = pluginType === "jsfx" || /\.jsfx$/i.test(pluginPath)
        ? (id: string, path: string) => nativeBridge.addTrackJSFX(id, path, chainType === "input")
        : chainType === "input" ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);
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
        execute: () => { void replayTrackFXHistory(set, get, epoch, async () => {
          const redoBaseLength = (await getFXChainSlots(trackId, chainType)).length;
          if (epoch !== getProjectEpoch()) return;
          await addFn(trackId, pluginPath);
          if (epoch !== getProjectEpoch()) return;
          const list = await waitForFXChainLength(trackId, chainType, redoBaseLength + 1);
          if (epoch !== getProjectEpoch()) return;
          get().updateTrack(trackId, { [countField]: Math.max(list.length, redoBaseLength + 1) });
          notifyFXChainChanged({ trackId, chainType });
        }).catch(logBridgeError("redo track FX add")); },
        undo: () => { void replayTrackFXHistory(set, get, epoch, async () => {
          await removeFn(trackId, newIndex);
          if (epoch !== getProjectEpoch()) return;
          const list = await getFXChainSlots(trackId, chainType);
          if (epoch !== getProjectEpoch()) return;
          get().updateTrack(trackId, { [countField]: list.length });
          notifyFXChainChanged({ trackId, chainType });
        }).catch(logBridgeError("undo track FX add")); },
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
      const epoch = getProjectEpoch();
      const state = get();
      const track = state.tracks.find(candidate => candidate.id === trackId);
      if (!track || state.automationRecoveryBusy || state.globalLocked || track.frozen || !String(effectName).trim()) return false;
      clearPluginParameterManifests(trackId, chainType);

      const beforeSlots = await getFXChainSlots(trackId, chainType);
      const beforeLanes = (track.automationLanes ?? []).map(cloneAutomationLane);
      const beforeSafe = [...(track.automationSafeParams ?? [])];
      const newIndex = beforeSlots.length;
      const isInput = chainType === "input";
      const added = await nativeBridge.addTrackBuiltInFX(trackId, effectName, isInput);
      if (!added) return false;

      const afterSlots = await waitForFXChainLength(trackId, chainType, newIndex + 1);
      applyTrackFXFrontendState(set, get, trackId, chainType, afterSlots.length, beforeLanes);

      const addAgain = async () => {
        const currentLength = (await getFXChainSlots(trackId, chainType)).length;
        if (epoch !== getProjectEpoch()) return false;
        const success = await nativeBridge.addTrackBuiltInFX(trackId, effectName, isInput);
        if (!success || epoch !== getProjectEpoch()) return false;
        const slots = await waitForFXChainLength(trackId, chainType, currentLength + 1);
        if (epoch !== getProjectEpoch()) return false;
        applyTrackFXFrontendState(set, get, trackId, chainType, slots.length, beforeLanes, beforeSafe);
        return true;
      };
      const removeAgain = async () => {
        const success = isInput
          ? await nativeBridge.removeTrackInputFX(trackId, newIndex)
          : await nativeBridge.removeTrackFX(trackId, newIndex);
        if (!success || epoch !== getProjectEpoch()) return false;
        const lanes = removeTrackFXAutomationLanes(
          get().tracks.find(candidate => candidate.id === trackId)?.automationLanes || [],
          chainType,
          newIndex,
        );
        const slots = await getFXChainSlots(trackId, chainType);
        if (epoch !== getProjectEpoch()) return false;
        const safeParams = beforeSafe;
        applyTrackFXFrontendState(set, get, trackId, chainType, slots.length, lanes, safeParams);
        return true;
      };

      commandManager.push({
        type: "ADD_TRACK_BUILTIN_FX",
        description: `Add ${effectName}`,
        timestamp: Date.now(),
        execute: () => { void replayTrackFXHistory(set, get, epoch, addAgain).catch(logBridgeError("redo built-in FX add")); },
        undo: () => { void replayTrackFXHistory(set, get, epoch, removeAgain).catch(logBridgeError("undo built-in FX add")); },
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
      const epoch = getProjectEpoch();
      const state = get();
      const track = state.tracks.find(candidate => candidate.id === trackId);
      if (!track || state.automationRecoveryBusy || state.globalLocked || track.frozen) return false;
      if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
      clearPluginParameterManifests(trackId, chainType);

      const slots = await getFXChainSlots(trackId, chainType);
      if (fromIndex >= slots.length || toIndex >= slots.length) return false;
      const beforeLanes = (track.automationLanes ?? []).map(cloneAutomationLane);
      const afterLanes = reorderTrackFXAutomationLanes(beforeLanes, chainType, fromIndex, toIndex);
      const beforeSafe = [...(track.automationSafeParams ?? [])];
      const afterSafe = reorderTrackFXAutomationLanes(beforeSafe.map(param => ({ param, points: [] })), chainType, fromIndex, toIndex).map(lane => lane.param);
      const reorder = chainType === "input"
        ? nativeBridge.reorderTrackInputFX.bind(nativeBridge)
        : nativeBridge.reorderTrackFX.bind(nativeBridge);
      const success = await reorder(trackId, fromIndex, toIndex);
      if (!success) return false;
      applyTrackFXFrontendState(set, get, trackId, chainType, slots.length, afterLanes, afterSafe);

      const applyOrder = async (from: number, to: number, lanes: readonly AutomationLane[], safe: string[]) => {
        const reordered = await reorder(trackId, from, to);
        if (!reordered || epoch !== getProjectEpoch()) return false;
        const currentSlots = await getFXChainSlots(trackId, chainType);
        if (epoch !== getProjectEpoch()) return false;
        applyTrackFXFrontendState(set, get, trackId, chainType, currentSlots.length, lanes, safe);
        return true;
      };
      commandManager.push({
        type: "REORDER_TRACK_FX",
        description: `Reorder ${chainType} FX`,
        timestamp: Date.now(),
        execute: () => { void replayTrackFXHistory(set, get, epoch, () => applyOrder(fromIndex, toIndex, afterLanes, afterSafe)).catch(logBridgeError("redo FX reorder")); },
        undo: () => { void replayTrackFXHistory(set, get, epoch, () => applyOrder(toIndex, fromIndex, beforeLanes, beforeSafe)).catch(logBridgeError("undo FX reorder")); },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    setSidechainSourceWithUndo: async (trackId: string, fxIndex: number, sourceTrackId: string) => {
      const state = get();
      const track = state.tracks.find(candidate => candidate.id === trackId);
      if (!track || state.automationRecoveryBusy || state.globalLocked || track.frozen || !Number.isInteger(fxIndex) || fxIndex < 0
        || sourceTrackId === trackId || (sourceTrackId && !state.tracks.some(candidate => candidate.id === sourceTrackId))) return false;
      const slots = await nativeBridge.getTrackFX(trackId);
      if (!slots[fxIndex]) return false;
      const previous = await nativeBridge.getSidechainSource(trackId, fxIndex);
      if (previous === sourceTrackId) return true;
      const apply = async (source: string) => {
        const success = source ? await nativeBridge.setSidechainSource(trackId, fxIndex, source)
          : await nativeBridge.clearSidechainSource(trackId, fxIndex);
        if (success) {
          set({ isModified: true });
          notifyFXChainChanged({ trackId, chainType: "track" });
        }
        return success;
      };
      if (!await apply(sourceTrackId)) return false;
      commandManager.push({
        type: "SET_SIDECHAIN_SOURCE", description: "Change sidechain source", timestamp: Date.now(),
        execute: async () => { await apply(sourceTrackId); },
        undo: async () => { await apply(previous); },
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
      if (await nativeBridge.getFXStageState("master"))
        return editFXStage("master", "Remove master FX", () => nativeBridge.removeMasterFX(fxIndex));

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
          : pluginType === "jsfx"
            ? await nativeBridge.addMasterJSFX(pluginReference)
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
      const epoch = getProjectEpoch();
      const state = get();
      const track = state.tracks.find(candidate => candidate.id === trackId);
      if (!track || state.automationRecoveryBusy || state.globalLocked || track.frozen || !Number.isInteger(fxIndex) || fxIndex < 0) return false;
      clearPluginParameterManifests(trackId, chainType);

      const isInput = chainType === "input";
      const fxList = await getFXChainSlots(trackId, chainType);
      const pluginInfo = fxList[fxIndex];
      if (!pluginInfo) return false;
      const pluginType = String(pluginInfo.type || "").trim().toLowerCase();
      const pluginReference = String(pluginInfo.pluginPath || pluginInfo.name || "").trim();
      if (!pluginReference) return false;

      const savedState = await nativeBridge.getPluginState(trackId, fxIndex, isInput);
      if (typeof savedState !== "string") return false;
      const savedMappings = (await nativeBridge.getMIDILearnMappings()).filter(mapping =>
        mapping.trackId === trackId && mapping.chainType === chainType && mapping.pluginIndex === fxIndex);
      const savedSidechain = isInput ? "" : await nativeBridge.getSidechainSource(trackId, fxIndex);
      const wasBypassed = Boolean(pluginInfo.bypassed);
      const precisionOverride = pluginInfo.precisionOverride === "float32" ? "float32" : "auto";
      const beforeLanes = (track.automationLanes ?? []).map(cloneAutomationLane);
      const afterLanes = removeTrackFXAutomationLanes(beforeLanes, chainType, fxIndex);
      const beforeSafe = [...(track.automationSafeParams ?? [])];
      const afterSafe = removeTrackFXAutomationLanes(beforeSafe.map(param => ({ param, points: [] })), chainType, fxIndex).map(lane => lane.param);
      const removeFn = isInput
        ? nativeBridge.removeTrackInputFX.bind(nativeBridge)
        : nativeBridge.removeTrackFX.bind(nativeBridge);
      const reorderFn = isInput
        ? nativeBridge.reorderTrackInputFX.bind(nativeBridge)
        : nativeBridge.reorderTrackFX.bind(nativeBridge);

      const addSavedPlugin = async () => {
        const beforeLength = (await getFXChainSlots(trackId, chainType)).length;
        if (epoch !== getProjectEpoch()) return false;
        const added = pluginType === "builtin"
          ? await nativeBridge.addTrackBuiltInFX(trackId, pluginReference, isInput)
          : pluginType === "jsfx"
            ? await nativeBridge.addTrackJSFX(trackId, pluginReference, isInput)
            : isInput
              ? await nativeBridge.addTrackInputFX(trackId, pluginReference, false)
              : await nativeBridge.addTrackFX(trackId, pluginReference, false);
        if (!added || epoch !== getProjectEpoch()) return false;

        const restoredList = await waitForFXChainLength(trackId, chainType, beforeLength + 1);
        if (epoch !== getProjectEpoch()) return false;
        const appendedIndex = restoredList.length - 1;
        if (appendedIndex < 0) return false;
        const stateRestored = savedState
          ? await nativeBridge.setPluginState(trackId, appendedIndex, isInput, savedState)
          : true;
        if (epoch !== getProjectEpoch()) return false;
        const bypassRestored = isInput
          ? await nativeBridge.bypassTrackInputFX(trackId, appendedIndex, wasBypassed)
          : await nativeBridge.bypassTrackFX(trackId, appendedIndex, wasBypassed);
        if (epoch !== getProjectEpoch()) return false;
        const precisionRestored = await nativeBridge.setTrackPluginPrecisionOverride(
          trackId,
          appendedIndex,
          isInput,
          precisionOverride,
        );
        if (epoch !== getProjectEpoch()) return false;
        const sidechainRestored = !savedSidechain || await nativeBridge.setSidechainSource(trackId, appendedIndex, savedSidechain);
        if (epoch !== getProjectEpoch()) return false;
        const orderRestored = appendedIndex === fxIndex
          ? true
          : await reorderFn(trackId, appendedIndex, fxIndex);
        if (!(stateRestored && bypassRestored && precisionRestored && sidechainRestored && orderRestored) || epoch !== getProjectEpoch()) return false;
        if (savedMappings.length) {
          const currentMappings = await nativeBridge.getMIDILearnMappings();
          if (epoch !== getProjectEpoch()) return false;
          const restoredCCs = new Set(savedMappings.map(mapping => mapping.ccNumber));
          if (!await nativeBridge.setMIDILearnMappings([
            ...currentMappings.filter(mapping => !restoredCCs.has(mapping.ccNumber)), ...savedMappings,
          ])) return false;
          if (epoch !== getProjectEpoch()) return false;
        }
        const list = await getFXChainSlots(trackId, chainType);
        if (epoch !== getProjectEpoch()) return false;
        applyTrackFXFrontendState(set, get, trackId, chainType, list.length, beforeLanes, beforeSafe);
        return true;
      };

      const removeSavedPlugin = async () => {
        const removed = await removeFn(trackId, fxIndex);
        if (!removed || epoch !== getProjectEpoch()) return false;
        const list = await getFXChainSlots(trackId, chainType);
        if (epoch !== getProjectEpoch()) return false;
        applyTrackFXFrontendState(set, get, trackId, chainType, list.length, afterLanes, afterSafe);
        return true;
      };

      if (!await removeSavedPlugin()) return false;
      commandManager.push({
        type: "REMOVE_TRACK_FX",
        description: `Remove ${pluginInfo.name || chainType + " FX"}`,
        timestamp: Date.now(),
        execute: () => { void replayTrackFXHistory(set, get, epoch, removeSavedPlugin).catch(logBridgeError("redo track FX removal")); },
        undo: () => { void replayTrackFXHistory(set, get, epoch, addSavedPlugin).catch(logBridgeError("undo track FX removal")); },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    loadInstrumentWithUndo: async (trackId, pluginPath) => {
      const track = get().tracks.find(t => t.id === trackId);
      if (!track) return false;
      const previousLanes = track.automationLanes.filter(lane => isInstrumentAutomationParam(lane.param)).map(cloneAutomationLane);
      const previousSafe = (track.automationSafeParams ?? []).filter(isInstrumentAutomationParam);

      const previousPlugin = track.instrumentPlugin || "";
      const previousType = track.type;
      const previousState = previousPlugin
        ? await nativeBridge.getInstrumentState(trackId).catch(() => "")
        : "";

      const success = await nativeBridge.loadInstrument(trackId, pluginPath);
      if (!success) return false;

      applyInstrumentAutomationLanes(set, get, trackId, []);
      get().updateTrack(trackId, { type: "instrument", instrumentPlugin: pluginPath, builtInInstrument: undefined });
      await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
      notifyInstrumentChanged({ trackId, instrumentPlugin: pluginPath });

      const command: Command = {
        type: "LOAD_INSTRUMENT",
        description: "Load instrument",
        timestamp: Date.now(),
        execute: async () => {
          await nativeBridge.loadInstrument(trackId, pluginPath);
          applyInstrumentAutomationLanes(set, get, trackId, []);
          get().updateTrack(trackId, { type: "instrument", instrumentPlugin: pluginPath, builtInInstrument: undefined });
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
          notifyInstrumentChanged({ trackId, instrumentPlugin: pluginPath });
        },
        undo: async () => {
          if (previousPlugin) {
            await nativeBridge.loadInstrument(trackId, previousPlugin);
            if (previousState) await nativeBridge.setInstrumentState(trackId, previousState);
            applyInstrumentAutomationLanes(set, get, trackId, previousLanes, previousSafe);
            get().updateTrack(trackId, { type: "instrument", instrumentPlugin: previousPlugin, builtInInstrument: undefined });
            notifyInstrumentChanged({ trackId, instrumentPlugin: previousPlugin });
          } else {
            await nativeBridge.removeInstrument(trackId);
            get().updateTrack(trackId, { type: previousType || "midi", instrumentPlugin: undefined, builtInInstrument: track.builtInInstrument });
            applyInstrumentAutomationLanes(set, get, trackId, previousLanes, previousSafe);
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
      const track = get().tracks.find(t => t.id === trackId);
      if (!track) return false;
      const previousLanes = track.automationLanes.filter(lane => isInstrumentAutomationParam(lane.param)).map(cloneAutomationLane);
      const previousSafe = (track.automationSafeParams ?? []).filter(isInstrumentAutomationParam);

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

      applyInstrumentAutomationLanes(set, get, trackId, []);
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
          applyInstrumentAutomationLanes(set, get, trackId, []);
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
            applyInstrumentAutomationLanes(set, get, trackId, previousLanes, previousSafe);
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
            await nativeBridge.setTrackType(trackId, previousType === "bus" ? "instrument" : previousType || "instrument").catch(() => false);
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
            applyInstrumentAutomationLanes(set, get, trackId, previousLanes, previousSafe);
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
      const track = get().tracks.find(t => t.id === trackId);
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
            await nativeBridge.setTrackType(trackId, previousType).catch(() => false);
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
      const previousLanes = track.automationLanes.filter(lane => isInstrumentAutomationParam(lane.param)).map(cloneAutomationLane);
      const previousSafe = (track.automationSafeParams ?? []).filter(isInstrumentAutomationParam);
      const previousType = track.type;
      const previousState = await nativeBridge.getInstrumentState(trackId).catch(() => "");
      const typeAfterRemoval = (candidate: Track | undefined) =>
        candidate?.samplerSamplePath || previousType === "instrument" ? "instrument" : "midi";
      const success = await nativeBridge.removeInstrument(trackId);
      if (!success) return false;

      applyInstrumentAutomationLanes(set, get, trackId, []);
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
          applyInstrumentAutomationLanes(set, get, trackId, []);
          const currentTrack = get().tracks.find(t => t.id === trackId);
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
          applyInstrumentAutomationLanes(set, get, trackId, previousLanes, previousSafe);
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
      const track = get().tracks.find(t => t.id === trackId);
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
      const track = get().tracks.find(t => t.id === trackId);
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
      const nextBehavior = ["latch", "overwrite", "touch-latch", "cross-over"].includes(behavior) ? behavior : "touch";
      if ((get().automationWriteBehavior ?? "touch") === nextBehavior) return;
      get().endAutomationWriteSession();
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
                automationTrimWriteEnabled: s.masterAutomationTrimWriteEnabled,
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
      _automationCrossOver.clear();
      _automationNativeCapturedParams.clear();
      _automationNativeCaptureTimes.clear();
  _automationGestureOriginal.clear();
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
                automationTrimWriteEnabled: state.masterAutomationTrimWriteEnabled,
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

    setAutomationTouchReturnSeconds: (seconds) => {
      if (isAutomationEditLocked(get()) || !Number.isFinite(seconds)) return;
      const before = captureAutomationProjectSnapshot(get());
      set({ automationTouchReturnSeconds: Math.max(0, Math.min(5, seconds)), isModified: true });
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "TOUCH_RETURN_TIME", "Set Touch return time");
    },

    setPluginAutomationSafe: (trackId, params, safe) => {
      if (isAutomationEditLocked(get())) return;
      get().endAutomationWriteSession();
      const before = captureAutomationProjectSnapshot(get());
      const update = (previous: string[] = []) => safe ? [...new Set([...previous, ...params])]
        : previous.filter(param => !params.includes(param));
      if (trackId === "master") set({ masterAutomationSafeParams: update(get().masterAutomationSafeParams), isModified: true });
      else set(state => ({ tracks: state.tracks.map(track => track.id === trackId
        ? { ...track, automationSafeParams: update(track.automationSafeParams) } : track), isModified: true }));
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "PLUGIN_AUTOMATION_SAFE", "Change plugin Automation Safe");
    },

    recordAutomationWriteTick: (nowMs = Date.now(), capture) => {
      const state = get();
      if (isAutomationEditLocked(state) || (!automationTransportRolling(state) && !capture?.allowStopped)) return;

      const time = capture && Number.isFinite(capture.time) ? Math.max(0, capture.time) : state.transport.currentTime;
      const join=state.automationJoinSession;
      if(join?.prepared && !capture && time >= join.time) {
        set({automationJoinSession:null});
        for(const entry of join.entries) {
          const track=entry.trackId === "master" ? masterAutomationTrack(get()) : get().tracks.find(track => track.id === entry.trackId);
          const lane=track?.automationLanes?.find(lane => lane.id === entry.laneId);
          const safe=entry.trackId === "master" ? get().masterAutomationSafeParams : track?.automationSafeParams;
          if(join.projectEpoch !== getProjectEpoch() || !lane || lane.param !== entry.param || lane.unavailableParameter || safe?.includes(entry.param)
            || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey || JSON.stringify(lane.points) !== entry.pointsKey
            || (!entry.punched && !parameterWriteEnabled(track,entry.param))) { void nativeBridge.clearAutomationWriteHold(entry.trackId,entry.param);continue; }
          automationPunchedParameters.add(automationWriteKey(entry.trackId,entry.param));
          // After joining, hold through subsequent loop iterations too.
          void nativeBridge.setAutomationWriteHold(entry.trackId,entry.param,automationToBackend(entry.param,entry.value),0,lane.metadata?.meaningSignature ?? "",lane.metadata?.referenceGeneration ?? -1);
          get().beginAutomationParamTouch(entry.trackId,entry.param,{time:join.time,initialValue:entry.value});
          get().setAutomationWriteValue(entry.trackId,entry.param,entry.value);
          get().recordAutomationWriteTick(nowMs,{trackId:entry.trackId,param:entry.param,time:join.time});
          get().endAutomationParamTouch(entry.trackId,entry.param,{time:join.time});
        }
      }
      const radius = capture ? .0000001 : AUTOMATION_WRITE_REPLACE_RADIUS_SECONDS;
      const behavior = writeBehavior(get);
      const lanesToSync: Array<{
        trackId: string;
        lane: AutomationLane;
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
            if (!parameterWriteEnabled(track, lane.param)) return lane;
            if (capture && (capture.trackId !== track.id || capture.param !== lane.param)) return lane;
            if (track.automationSafeParams?.includes(lane.param)) return lane;
            if (!automationLaneReadEnabled(lane))
              return lane;

            const key = automationTouchKey(track.id, lane.param);
            if (capture) { _automationNativeCapturedParams.add(key); _automationNativeCaptureTimes.set(key, time); }
            else if (_automationNativeCapturedParams.has(key) && (_automationTouchedParams.has(key)
              || time <= (_automationNativeCaptureTimes.get(key) ?? 0) + radius)) return lane;
            const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
            const shouldRecord = activeWriting;

            if (!shouldRecord)
              return lane;

            const lastRecorded = _autoRecordTimers.get(key) ?? 0;
            if (!capture && nowMs - lastRecorded < AUTO_RECORD_INTERVAL_MS)
              return lane;

            _autoRecordTimers.set(key, nowMs);
            if (!_automationWriteSessionSnapshots.has(key)) {
              _automationWriteSessionSnapshots.set(key, {
                trackId: track.id,
                laneId: lane.id,
                points: normalizeAutomationPoints(lane.points),
              });
            }
            const value = lane.param === "trim_volume" && Number.isFinite(s.automationTrimLiveValues?.[track.id])
              ? clamp01((s.automationTrimLiveValues![track.id] - VOLUME_MIN_DB) / VOLUME_DB_RANGE) : currentNormalizedAutomationValue(track, lane, time);
            const point = { time: Math.max(0, time), value: clamp01(value) };
            const written = writeAutomationGesturePoint(track.id, lane, time, point.value, radius);
            const simplifiedWrite = simplifyContinuousAutomationWritePoints(
              lane.param,
              written.points,
              point.time,
              _automationWriteSessionStartTimes.get(key),
              automationLaneIsDiscrete(lane) || _automationNativeCapturedParams.has(key),
            );
            const nextLane = {
              ...withResolvedLaneMode(track, lane, behavior, activeWriting),
              points: simplifiedWrite.points,
            };
            lanesToSync.push({
              trackId: track.id,
              lane: nextLane,
              start: Math.max(0, time - radius),
              end: time + radius,
              point,
              syncFullLane: simplifiedWrite.didSimplify || written.guarded,
            });
            trackChanged = true;
            changed = true;
            return nextLane;
          });

          return trackChanged ? { ...track, automationLanes } : track;
        });

        let masterAutomationLanes = s.masterAutomationLanes;
        if (s.masterAutomationWriteEnabled || s.masterAutomationTrimWriteEnabled || automationPunchOwnsTrack("master")) {
          const masterTrack = masterAutomationTrack(s);
          masterAutomationLanes = s.masterAutomationLanes.map((lane) => {
            if (!parameterWriteEnabled(masterTrack, lane.param)) return lane;
            if (capture && (capture.trackId !== "master" || capture.param !== lane.param)) return lane;
            if (s.masterAutomationSafeParams?.includes(lane.param)) return lane;
            if (!automationLaneReadEnabled(lane))
              return lane;

            const key = automationTouchKey("master", lane.param);
            if (capture) { _automationNativeCapturedParams.add(key); _automationNativeCaptureTimes.set(key, time); }
            else if (_automationNativeCapturedParams.has(key) && (_automationTouchedParams.has(key)
              || time <= (_automationNativeCaptureTimes.get(key) ?? 0) + radius)) return lane;
            const activeWriting = _automationTouchedParams.has(key) || _automationLatchedParams.has(key);
            if (!activeWriting)
              return lane;

            const lastRecorded = _autoRecordTimers.get(key) ?? 0;
            if (!capture && nowMs - lastRecorded < AUTO_RECORD_INTERVAL_MS)
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
            const written = writeAutomationGesturePoint("master", lane, time, point.value, radius);
            const simplifiedWrite = simplifyContinuousAutomationWritePoints(
              lane.param,
              written.points,
              point.time,
              _automationWriteSessionStartTimes.get(key),
              automationLaneIsDiscrete(lane) || _automationNativeCapturedParams.has(key),
            );
            const nextLane = {
              ...withResolvedLaneMode(masterTrack, lane, behavior, activeWriting),
              points: simplifiedWrite.points,
            };
            lanesToSync.push({
              trackId: "master",
              lane: nextLane,
              start: Math.max(0, time - radius),
              end: time + radius,
              point,
              syncFullLane: simplifiedWrite.didSimplify || written.guarded,
            });
              changed = true;
            return nextLane;
          });
        }

        return changed ? { tracks, masterAutomationLanes, isModified: true } : s;
      });

      for (const { trackId, lane, start, end, point, syncFullLane } of lanesToSync) {
        if (capture?.deferSync) continue;
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

    writeAutomationToBoundary: (boundary) => {
      const state=get(),time=state.transport.currentTime;
      if(!["start","end"].includes(boundary) || !automationTransportRolling(state) || isAutomationEditLocked(state) || state.isProjectLoading) return false;
      get().recordAutomationWriteTick();
      let projectEnd=time;
      for(const track of state.tracks) {
        for(const clip of [...(track.clips ?? []),...(track.midiClips ?? [])])projectEnd=Math.max(projectEnd,clip.startTime+clip.duration);
        for(const lane of track.automationLanes)for(const point of lane.points)projectEnd=Math.max(projectEnd,point.time);
      }
      for(const lane of state.masterAutomationLanes)for(const point of lane.points)projectEnd=Math.max(projectEnd,point.time);
      const start=boundary === "start" ? 0 : time,end=boundary === "start" ? time : projectEnd;
      if(end <= start)return false;
      let changed=false;
      for(const pass of _automationWriteSessionSnapshots.values()) {
        const track=pass.trackId === "master" ? masterAutomationTrack(get()) : get().tracks.find(track => track.id === pass.trackId);
        const lane=track?.automationLanes?.find(lane => lane.id === pass.laneId),key=automationTouchKey(pass.trackId,lane?.param ?? "");
        const safe=pass.trackId === "master" ? get().masterAutomationSafeParams : track?.automationSafeParams;
        if(!lane || lane.unavailableParameter || safe?.includes(lane.param) || !parameterWriteEnabled(track,lane.param)
          || !(_automationTouchedParams.has(key) || _automationLatchedParams.has(key)))continue;
        const value=_automationWriteValues.get(key) ?? currentNormalizedAutomationValue(track,lane,time);
        const points=editEnvelopeRange(lane.points,start,end,"fill",value,currentNormalizedAutomationValue(track,lane,time),automationLaneIsDiscrete(lane));
        set(current => pass.trackId === "master" ? {masterAutomationLanes:current.masterAutomationLanes.map(item => item.id === lane.id ? {...item,points}:item),isModified:true}
          : {tracks:current.tracks.map(item => item.id === pass.trackId ? {...item,automationLanes:item.automationLanes.map(candidate => candidate.id === lane.id ? {...candidate,points}:candidate)}:item),isModified:true});
        syncAutomationLaneToBackend(pass.trackId,{...lane,points});changed=true;
      }
      return changed;
    },

    setAutomationAutoJoin: (enabled) => {
      if(isAutomationEditLocked(get()) || automationTransportRolling(get()))return;
      const before=captureAutomationProjectSnapshot(get());set({automationAutoJoinEnabled:Boolean(enabled),automationJoinSession:null,isModified:true});
      pushAppliedAutomationProjectCommand(set,get,before,captureAutomationProjectSnapshot(get()),"AUTOMATION_AUTO_JOIN","Set AutoJoin");
    },

    prepareAutomationAutoJoin: async (startTime) => {
      const request=++_automationJoinPreparation,previous=_automationJoinPreparationQueue;
      let release!: () => void;_automationJoinPreparationQueue=new Promise<void>(resolve => {release=resolve;});
      await previous;
      try {
      if(request !== _automationJoinPreparation)return false;
      const state=get(),join=state.automationJoinSession;
      if(!state.automationAutoJoinEnabled || !join)return true;
      if(join.projectEpoch !== getProjectEpoch() || startTime >= join.time || state.automationPreviewSession || isAutomationEditLocked(state)) {set({automationJoinSession:null});return true;}
      if(state.transport.loopEnabled && (join.time < state.transport.loopStart || join.time >= state.transport.loopEnd)) {
        set({automationJoinSession:null});state.showToast("The previous AutoJoin point is outside this loop. Start a new pass to set its join point.","info");return true;
      }
      if(join.entries.length>128) {state.showToast("AutoJoin supports up to 128 controls per pass. Playback was not started.","error");return false;}
      const preparing={...join,preparing:true};set({automationJoinSession:preparing});
      const accepted=[];
      for(const entry of join.entries) {
        const track=entry.trackId === "master" ? masterAutomationTrack(get()) : get().tracks.find(track => track.id === entry.trackId);
        const lane=track?.automationLanes?.find(lane => lane.id === entry.laneId),safe=entry.trackId === "master" ? get().masterAutomationSafeParams : track?.automationSafeParams;
        if(!lane || lane.param !== entry.param || lane.unavailableParameter || !trackReadEnabled(track) || !lane.readEnabled || safe?.includes(entry.param)
          || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey || JSON.stringify(lane.points) !== entry.pointsKey
          || (!entry.punched && !parameterWriteEnabled(track,entry.param)))continue;
        let success=false;
        try { success=await nativeBridge.setAutomationWriteHold(entry.trackId,entry.param,automationToBackend(entry.param,entry.value),join.time,lane.metadata?.meaningSignature ?? "",lane.metadata?.referenceGeneration ?? -1); }catch { /* Roll back the prepared set. */ }
        if(!success || request !== _automationJoinPreparation || join.projectEpoch !== getProjectEpoch() || get().automationJoinSession !== preparing) {
          for(const item of [...accepted,entry])await nativeBridge.clearAutomationWriteHold(item.trackId,item.param);
          set({automationJoinSession:null});get().showToast("AutoJoin could not prepare its controls; playback was not started.","error");return false;
        }
        accepted.push(entry);
      }
      set({automationJoinSession:accepted.length ? {...join,entries:accepted,prepared:true,preparing:false}:null});return true;
      } finally { release(); }
    },

    endAutomationWriteSession: (stopTime) => {
      ++_automationJoinPreparation;
      const finalTime=stopTime ?? get().transport.currentTime;
      // RAF may not run between the last held value and native Stop. Extend
      // every active writer to the actual stop sample before committing it.
      for(const key of new Set([..._automationTouchedParams,..._automationLatchedParams])) {
        if(!_automationWriteSessionSnapshots.has(key))continue;
        const [trackId,param]=key.split("::");
        get().recordAutomationWriteTick(undefined,{trackId,param,time:finalTime,allowStopped:true});
      }
      const preparedJoin=get().automationJoinSession;
      if(preparedJoin?.prepared || preparedJoin?.preparing) {
        for(const entry of preparedJoin.entries)void nativeBridge.clearAutomationWriteHold(entry.trackId,entry.param);
        set({automationJoinSession:{...preparedJoin,prepared:false,preparing:false}});
      }
      get().restoreAutomationTrimLiveValues?.();
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
      const punched=[...automationPunchedParameters];automationPunchedParameters.clear();
      if(get().automationAutoJoinEnabled && writePassChanges.length) {
        const entries=[..._automationLatchedParams].flatMap(key => {
          const [trackId,param]=key.split("::"),track=trackId === "master" ? masterAutomationTrack(get()) : get().tracks.find(track => track.id === trackId);
          const lane=track?.automationLanes?.find(lane => lane.param === param);
          const safe=trackId === "master" ? get().masterAutomationSafeParams : track?.automationSafeParams;
          if(!lane || lane.unavailableParameter || safe?.includes(param) || (!punched.includes(key) && effectiveAutomationWriteBehavior(behavior,param) !== "latch"))return [];
          return [{trackId,param,laneId:lane.id,value:_automationWriteValues.get(key) ?? currentNormalizedAutomationValue(track,lane,get().transport.currentTime),
            metadataKey:JSON.stringify(lane.metadata ?? null),pointsKey:JSON.stringify(lane.points),punched:punched.includes(key)}];
        });
        set({automationJoinSession:entries.length ? {projectEpoch:getProjectEpoch(),time:stopTime ?? get().transport.currentTime,entries}:null});
      }
      for(const key of punched) {
        const [id,param]=key.split("::");
        const track=id === "master" ? masterAutomationTrack(get()) : get().tracks.find(track => track.id === id);
        const lane=track?.automationLanes?.find(lane => lane.param === param);
        void nativeBridge.clearAutomationWriteHold(id,param);
        if(lane) {
          const updated=withResolvedLaneMode(track,lane,behavior,false);
          set(current => id === "master" ? {masterAutomationLanes:current.masterAutomationLanes.map(item => item.id === lane.id ? updated:item)}
            : {tracks:current.tracks.map(item => item.id === id ? {...item,automationLanes:item.automationLanes.map(candidate => candidate.id === lane.id ? updated:candidate)}:item)});
          syncAutomationLaneToBackend(id,updated);
        }
      }
      const preview = get().automationPreviewSession;
      if(preview?.phase === "writing") {
        set({automationPreviewSession:{...preview,phase:"restoring"}});
        void get().cancelAutomationPreview();
      }
      _automationTouchedParams.clear();
      _automationLatchedParams.clear();
      _autoRecordTimers.clear();
      _automationWriteValues.clear();
      _automationWriteSessionStartTimes.clear();
      _automationWriteSessionSnapshots.clear();
      _automationCrossOver.clear();
      _automationNativeCapturedParams.clear();
      _automationNativeCaptureTimes.clear();
  _automationGestureOriginal.clear();
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
                automationTrimWriteEnabled: s.masterAutomationTrimWriteEnabled,
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
                automationTrimWriteEnabled: state.masterAutomationTrimWriteEnabled,
              },
              lane,
              behavior,
              false,
            ),
          );
        }
      }
      if (writePassChanges.length > 0) {
        if(get().automationTrimCoalesce === "after-pass" && !automationTransportRolling(get())) {
          const before=captureAutomationProjectSnapshot(get());
          for(const change of writePassChanges) {
            const lanes=change.trackId === "master" ? before.masterAutomationLanes : before.tracks.find(track => track.id === change.trackId)?.automationLanes;
            const lane=lanes?.find(lane => lane.id === change.laneId); if(lane)lane.points=change.beforePoints;
          }
          let coalesced=false;
          for(const change of writePassChanges) {
            const lane=change.trackId === "master" ? get().masterAutomationLanes.find(lane => lane.id === change.laneId)
              : get().tracks.find(track => track.id === change.trackId)?.automationLanes.find(lane => lane.id === change.laneId);
            if(lane && (lane.param === "trim_volume" || parseSendAutomationParamId(lane.param)?.control === "trim"))
              coalesced=get().freezeAutomationTrim(change.trackId,lane.param,{undoable:false,disarm:false}) || coalesced;
          }
          if(coalesced) {
            pushAppliedAutomationProjectCommand(set,get,before,captureAutomationProjectSnapshot(get()),"RECORD_AUTOMATION_WRITE_PASS","Record and coalesce Trim pass");
            return;
          }
        }
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

    setAutomationWriteValue: (trackId, param, value, capture) => {
      const state = get();
      if ((trackId === "master" ? state.masterAutomationSafeParams
        : state.tracks.find(track => track.id === trackId)?.automationSafeParams)?.includes(param)) return;
      if (isAutomationEditLocked(state) || (!automationTransportRolling(state) && !capture?.allowStopped)) {
        clearAutomationTouchState(trackId, param);
        return;
      }
      if (punchOutCrossOver(set, get, trackId, param, clamp01(value), capture)) return;
      if (trackId === "master") {
        const state = get();
        if (!parameterWriteEnabled(masterAutomationTrack(state), param)) return;
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
      if (track && parameterWriteEnabled(track, param)) {
        const keepTrackRead = trackReadEnabled(track);
        const existing = track.automationLanes?.find((l) => l.param === param);
        if (!existing) {
          get().addAutomationLane(trackId, param);
          if (!keepTrackRead) get().setTrackAutomationRead(trackId, false);
        } else if (!automationLaneReadEnabled(existing)) {
          get().setAutomationLaneRead(trackId, existing.id, true);
        }
      }
      _automationWriteValues.set(automationTouchKey(trackId, param), clamp01(value));
    },

    beginAutomationParamTouch: (trackId, param, capture) => {
      const state = get();
      if(state.automationJoinSession?.prepared && (capture?.time ?? state.transport.currentTime) < state.automationJoinSession.time) {
        set({automationJoinSession:{...state.automationJoinSession,entries:state.automationJoinSession.entries.filter(entry => entry.trackId !== trackId || entry.param !== param)}});
        void nativeBridge.clearAutomationWriteHold(trackId,param);
      }
      if ((trackId === "master" ? state.masterAutomationSafeParams
        : state.tracks.find(track => track.id === trackId)?.automationSafeParams)?.includes(param)) return;
      if (isAutomationEditLocked(state) || (!automationTransportRolling(state) && !capture?.allowStopped)) {
        clearAutomationTouchState(trackId, param);
        return;
      }
      if (trackId === "master") {
        const state = get();
        if (!parameterWriteEnabled(masterAutomationTrack(state), param)) return;
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
          lane = get().masterAutomationLanes.find((l) => l.id === lane!.id) ?? lane;
        }
        const key = automationTouchKey(trackId, param);
        if (!_automationTouchedParams.has(key)) _automationGestureOriginal.set(key, { points: automationGestureBaseline(trackId, get(), lane, capture?.time ?? get().transport.currentTime, capture?.initialValue), start: Math.max(0, capture?.time ?? get().transport.currentTime), guarded: false, hadPoints: lane.points.length > 0 });
        const behavior = automationPunchedParameters.has(automationWriteKey(trackId,param)) ? "latch" : effectiveAutomationWriteBehavior(writeBehavior(get), param);
        if (behavior === "cross-over") beginCrossOver(trackId, lane, Math.max(0, capture?.time ?? get().transport.currentTime));
        _automationTouchedParams.add(key);
        if (!_automationWriteSessionStartTimes.has(key))
          _automationWriteSessionStartTimes.set(key, Math.max(0, capture?.time ?? get().transport?.currentTime ?? 0));
        if (behavior === "latch" || behavior === "overwrite" || behavior === "cross-over") _automationLatchedParams.add(key);
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
      if (!track || !parameterWriteEnabled(track, param)) return;
      const keepTrackRead = trackReadEnabled(track);
      let lane = track.automationLanes?.find((l) => l.param === param);
      if (!lane) {
        const laneId = get().addAutomationLane(trackId, param);
        if (!keepTrackRead) get().setTrackAutomationRead(trackId, false);
        lane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === laneId);
      }
      if (!lane) return;
      if (!automationLaneReadEnabled(lane)) {
        get().setAutomationLaneRead(trackId, lane.id, true);
        lane = get().tracks.find((t) => t.id === trackId)?.automationLanes.find((l) => l.id === lane!.id) ?? lane;
      }
      const key = automationTouchKey(trackId, param);
      if (!_automationTouchedParams.has(key)) _automationGestureOriginal.set(key, { points: automationGestureBaseline(trackId, get(), lane, capture?.time ?? get().transport.currentTime, capture?.initialValue), start: Math.max(0, capture?.time ?? get().transport.currentTime), guarded: false, hadPoints: lane.points.length > 0 });
      const behavior = automationPunchedParameters.has(automationWriteKey(trackId,param)) ? "latch" : effectiveAutomationWriteBehavior(writeBehavior(get), param);
      if (behavior === "cross-over") beginCrossOver(trackId, lane, Math.max(0, capture?.time ?? get().transport.currentTime));
      _automationTouchedParams.add(key);
      if (!_automationWriteSessionStartTimes.has(key))
        _automationWriteSessionStartTimes.set(key, Math.max(0, capture?.time ?? get().transport?.currentTime ?? 0));
      if (behavior === "latch" || behavior === "overwrite" || behavior === "cross-over") _automationLatchedParams.add(key);
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

    endAutomationParamTouch: (trackId, param, capture) => {
      const keyForCapture = automationTouchKey(trackId, param);
      if (_automationNativeCapturedParams.has(keyForCapture) && _automationTouchedParams.has(keyForCapture))
        get().recordAutomationWriteTick(undefined, { trackId, param,
          time: Math.max(_automationNativeCaptureTimes.get(keyForCapture) ?? 0, capture?.time ?? get().transport.currentTime),
          allowStopped: capture?.allowStopped });
      if (trackId === "master") {
        const lane = get().masterAutomationLanes.find((l) => l.param === param);
        if (!lane) return;
        const key = automationTouchKey(trackId, param);
        const behavior = automationPunchedParameters.has(automationWriteKey(trackId,param)) ? "latch" : effectiveAutomationWriteBehavior(writeBehavior(get), param);
        const returning = behavior === "touch" && applyTouchReturn(set, get, trackId, lane, capture);
        _automationTouchedParams.delete(key);
        if (behavior === "touch") {
          _automationLatchedParams.delete(key);
          _automationWriteSessionStartTimes.delete(key);
        }
        if (behavior !== "overwrite" && !returning)
          nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
        return;
      }
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes?.find((l) => l.param === param);
      if (!lane) return;
      const key = automationTouchKey(trackId, param);
      const behavior = automationPunchedParameters.has(automationWriteKey(trackId,param)) ? "latch" : effectiveAutomationWriteBehavior(writeBehavior(get), param);
      const returning = behavior === "touch" && applyTouchReturn(set, get, trackId, lane, capture);
      _automationTouchedParams.delete(key);
      if (behavior === "touch") {
        _automationLatchedParams.delete(key);
        _automationWriteSessionStartTimes.delete(key);
      }
      if (behavior !== "overwrite" && !returning)
        nativeBridge.endTouchAutomation(trackId, param).catch(() => {});
    },

    setTrackAutomationRead: (trackId, enabled) => {
      if (isAutomationEditLocked(get())) return;
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
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
          const keepReadOn = trackReadEnabled(t);
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

    addAutomationLane: (trackId, param, label, metadata, options = {}) => {
      const state = get();
      if (isAutomationEditLocked(state)) return null;
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return null;
      const before = captureAutomationProjectSnapshot(get());
      const behavior = writeBehavior(get);
      // Don't add duplicate lanes for the same param
      const existing = track.automationLanes?.find((l) => l.param === param);
      if (existing) {
        set((s) => ({
          tracks: s.tracks.map((t) => {
            if (t.id !== trackId) return t;
            const nextTrack = {
              ...t,
              automationReadEnabled: options.read === false ? trackReadEnabled(t) : true,
              automationEnabled: options.read === false ? trackReadEnabled(t) : true,
              showAutomation: t.showAutomation || (options.visible ?? true),
            };
            return {
              ...nextTrack,
              automationLanes: t.automationLanes.map((lane) =>
                lane.id === existing.id
                  ? withResolvedLaneMode(nextTrack, { ...lane, label: label ?? lane.label, metadata: metadata ?? lane.metadata,
                    visible: options.visible ?? true, readEnabled: options.read === false ? lane.readEnabled : true }, behavior, false)
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
      const send = parseSendAutomationParamId(param);
      const sendName = send ? `${state.tracks.find(item => item.id === send.destinationId)?.name ?? "Send"}: ${send.control}` : undefined;
      const baseLane: AutomationLane = { id: laneId, param, label: label || sendName, metadata, points: [], visible: options.visible ?? true,
        mode: options.read === false ? "off" : "read", armed: false, readEnabled: options.read ?? true };
      const nextTrackForLane = {
        ...track,
        automationReadEnabled: options.read === false ? trackReadEnabled(track) : true,
        automationEnabled: options.read === false ? trackReadEnabled(track) : true,
      };
      const newLane: AutomationLane = withResolvedLaneMode(nextTrackForLane, baseLane, behavior, false);
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationReadEnabled: nextTrackForLane.automationReadEnabled,
            automationEnabled: nextTrackForLane.automationEnabled,
            automationLanes: [...t.automationLanes, newLane],
            showAutomation: t.showAutomation || (options.visible ?? true),
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
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
      if (!lane) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const oldTrackRead = trackReadEnabled(track);
      const oldTrackWrite = trackWriteEnabled(track);
      const oldLaneRead = automationLaneReadEnabled(lane);
      const oldLaneMode = lane.mode;
      const newPoints = [
        ...oldPoints,
        { id: createAutomationPointId(), time: Math.max(0, time), value: quantizeAutomationLaneValue(lane, value) },
      ].sort((a, b) => a.time - b.time);
      const applyPoints = (points: AutomationPoint[], options?: { restoreReadState?: boolean }) => {
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
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
      if (!lane || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const newPoints = oldPoints.filter((_, i) => i !== pointIndex);
      const applyPoints = (points: AutomationPoint[]) => {
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
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
      if (!lane || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= lane.points.length) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const newPoints = oldPoints
        .map((p, i) => i === pointIndex ? { ...p, time: Math.max(0, time), value: quantizeAutomationLaneValue(lane, value) } : p)
        .sort((a, b) => a.time - b.time);
      if (JSON.stringify(oldPoints) === JSON.stringify(newPoints)) return;
      const applyPoints = (points: AutomationPoint[]) => {
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

    applyAutomationEnvelopeEdit: (trackId, laneId, points, description) => {
      if (isAutomationEditLocked(get()) || automationTransportRolling(get())) return false;
      const target: NonNullable<State["selectedAutomationTarget"]> = trackId === "master" ? { kind: "master", laneId, pointId: null } : { kind: "track", trackId, laneId, pointId: null };
      const resolved = resolveAutomationLaneTarget(get(), target);
      if (!resolved || points.some(point => !Number.isFinite(point.time) || !Number.isFinite(point.value))) return false;
      const before = captureAutomationProjectSnapshot(get());
      applyAutomationTargetPoints(set, get, target, normalizeAutomationPoints(points.map(point => ({...point,
        value: quantizeAutomationLaneValue(resolved.lane, point.value)}))), null);
      return pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "EDIT_AUTOMATION_ENVELOPE", description);
    },

    setAutomationLanePoints: (trackId, laneId, points, options = {}) => {
      if (isAutomationEditLocked(get())) return;
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
      if (!track || !lane) return;

      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(options.oldPoints ?? lane.points);
      const oldTrackRead = options.oldTrackRead ?? trackReadEnabled(track);
      const oldTrackWrite = options.oldTrackWrite ?? trackWriteEnabled(track);
      const oldLaneRead = options.oldLaneRead ?? automationLaneReadEnabled(lane);
      const oldLaneMode = options.oldLaneMode ?? lane.mode;
      const nextPoints = normalizeAutomationPoints(points);
      if (JSON.stringify(oldPoints) === JSON.stringify(nextPoints)) return;

      const applyPoints = (targetPoints: AutomationPoint[], applyOptions?: { restoreReadState?: boolean }) => {
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
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
      if (!track || !lane) return;
      if (automationLaneReadEnabled(lane) === Boolean(enabled) && (!enabled || trackReadEnabled(track))) return;
      const before = captureAutomationProjectSnapshot(get());
      const behavior = writeBehavior(get);
      if (!enabled) clearAutomationTouchState(trackId, lane.param);
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const nextTrack = enabled ? { ...t, automationReadEnabled: true, automationEnabled: true } : t;
          return {
            ...nextTrack,
            automationLanes: t.automationLanes.map((candidate) =>
              withResolvedLaneMode(nextTrack, candidate.id === laneId ? { ...candidate, readEnabled: Boolean(enabled) } : candidate,
                behavior, _automationTouchedParams.has(automationTouchKey(trackId, candidate.param)) || _automationLatchedParams.has(automationTouchKey(trackId, candidate.param))),
            ),
          };
        }),
      }));
      const updatedTrack = get().tracks.find((t) => t.id === trackId);
      const updatedLane = updatedTrack?.automationLanes.find((l) => l.id === laneId);
      if (updatedTrack && updatedLane) syncTrackAutomationModes(updatedTrack, behavior);
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
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
      if (!lane || lane.points.length === 0) return;
      const laneParam = lane.param;
      const oldPoints = normalizeAutomationPoints(lane.points);
      const applyPoints = (points: AutomationPoint[]) => {
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
      const lane = track?.automationLanes?.find((l) => l.id === laneId);
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
        : get().tracks.find((track) => track.id === (resolved.target.kind === "track" ? resolved.target.trackId : "master"))?.automationLanes || [];
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
        : getAutomationPointId(laneAfter!.points[nextIndex], nextIndex);
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
      const sourcePoint = originalPoints.find(point => point.id === target.pointId);
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
        ? { ...point, id: snapshot.target.pointId ?? point.id ?? createAutomationPointId(), time: Math.max(0, time), value: quantizeAutomationLaneValue(resolved.lane, value) }
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
          const keepReadOn = trackReadEnabled(track);
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
          const keepReadOn = trackReadEnabled(track);
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
      const trackMode = (track: Track) => {
        if (!trackReadEnabled(track)) return "off";
        if (!trackWriteEnabled(track)) return "read";
        const laneModes = new Set(track.automationLanes.map((lane) => lane.mode));
        if (laneModes.size === 1) return track.automationLanes[0]?.mode || "read";
        return writeBehavior(get) === "overwrite" ? "write" : writeBehavior(get);
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
              mode: "off" as const,
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
                mode: "off" as const,
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

} satisfies Partial<State>);
