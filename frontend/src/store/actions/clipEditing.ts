// @ts-nocheck
/**
 * Clip Editing actions — split, move, resize, paste, duplicate, normalize,
 * group, reverse, playback rate, strip silence, time selection operations.
 * Extracted from useDAWStore.ts for modularity.
 * Types are enforced at the store spread site (useDAWStore.ts), not here.
 */

import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { calculateGridInterval, type GridSize } from "../../utils/snapToGrid";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { createStretchedMIDIClip } from "../../utils/timelineClipStretch";
import {
  canTrackAcceptTimelineClip,
  isMIDIClipboardClip,
  resolveTimelinePasteTargets,
} from "../../utils/timelineClipboard";
import { _editSnapshots, syncAutomationLaneToBackend } from "./storeHelpers";
import { createAutomationPointId } from "./automation";
import { isClipEditLocked } from "../../utils/clipEditLock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

const clipFadeEditSnapshots = new Map<
  string,
  { fadeIn: number; fadeOut: number }
>();

interface ClipNudgeEditSnapshot {
  positions: Map<string, number>;
  tracksBefore: any[];
  selectionBefore: ReturnType<typeof cloneSelectionSnapshot>;
  selectionAfter: ReturnType<typeof cloneSelectionSnapshot>;
  touchedMIDI: boolean;
}

const clipNudgeEditSnapshots = new Map<string, ClipNudgeEditSnapshot>();

const CLIP_GAIN_MIN_DB = -60;
const CLIP_GAIN_MAX_DB = 12;
let nextClipNormalizationRequestId = 1;
const currentClipNormalizationRequests = new Map<string, number>();

interface PendingClipNormalization {
  clipId: string;
  trackId: string;
  clipReference: any;
  filePath: string;
  offset: number;
  duration: number;
  volumeDB: number;
  requestId: number;
}

interface ClipNormalizationVolumeChange {
  oldVolumeDB: number;
  newVolumeDB: number;
}

function isClipEligibleForPeakNormalization(clip: any) {
  return !clip?.locked
    && typeof clip.filePath === "string"
    && clip.filePath.trim().length > 0
    && Number.isFinite(clip.offset)
    && clip.offset >= 0
    && Number.isFinite(clip.duration)
    && clip.duration > 0
    && Number.isFinite(clip.volumeDB)
    && clip.importStatus !== "failed"
    && clip.importStatus !== "probing"
    && clip.importStatus !== "preparingPlayback";
}

function applyClipNormalizationVolumes(
  set: SetFn,
  get: GetFn,
  changes: ReadonlyMap<string, ClipNormalizationVolumeChange>,
  phase: "old" | "new",
) {
  set((state: any) => ({
    tracks: state.tracks.map((track: any) => ({
      ...track,
      clips: track.clips.map((clip: any) => {
        const change = changes.get(clip.id);
        if (!change) return clip;
        return {
          ...clip,
          volumeDB: phase === "new" ? change.newVolumeDB : change.oldVolumeDB,
        };
      }),
    })),
    isModified: true,
  }));
  syncClipPropertyEdit(get, `${phase === "new" ? "apply" : "undo"} clip normalization`);
}

function normalizedClipFades(clip: any, fadeIn: unknown, fadeOut: unknown) {
  const maxFade = Math.max(0, (Number.isFinite(clip?.duration) ? clip.duration : 0) / 2);
  const normalize = (value: unknown) => Math.max(
    0,
    Math.min(maxFade, typeof value === "number" && Number.isFinite(value) ? value : 0),
  );
  return { fadeIn: normalize(fadeIn), fadeOut: normalize(fadeOut) };
}

function applyClipFadeValues(
  set: SetFn,
  get: GetFn,
  clipId: string,
  fadeIn: unknown,
  fadeOut: unknown,
) {
  const found = findTimelineClip(get(), clipId);
  if (!found || found.kind !== "audio") return false;
  const next = normalizedClipFades(found.clip, fadeIn, fadeOut);
  if (found.clip.fadeIn === next.fadeIn && found.clip.fadeOut === next.fadeOut) {
    return false;
  }
  set((state: any) => ({
    tracks: state.tracks.map((track: any) => ({
      ...track,
      clips: track.clips.map((clip: any) =>
        clip.id === clipId ? { ...clip, ...next } : clip,
      ),
    })),
    isModified: true,
  }));
  return true;
}

function syncClipPropertyEdit(get: GetFn, context: string) {
  const result = get().syncClipsWithBackend?.();
  if (result && typeof result.catch === "function") {
    result.catch(logBridgeError(context));
  }
}

function applyClipNudgePositions(
  set: SetFn,
  get: GetFn,
  positions: ReadonlyMap<string, number>,
  selection: ReturnType<typeof cloneSelectionSnapshot>,
  touchedMIDI: boolean,
) {
  const beforeTracks = cloneTracksForTimelineUndo(get().tracks);
  set((state: any) => {
    let tracks = state.tracks.map((track: any) => ({
      ...track,
      clips: track.clips.map((clip: any) =>
        positions.has(clip.id)
          ? { ...clip, startTime: positions.get(clip.id) }
          : clip,
      ),
      midiClips: track.midiClips.map((clip: any) =>
        positions.has(clip.id)
          ? { ...clip, startTime: positions.get(clip.id) }
          : clip,
      ),
    }));
    if (shouldMoveAutomationWithItems(
      state.moveEnvelopesWithItems,
      false,
      Boolean(state.lockSettings?.envelopes),
    )) {
      const moves: AutomationClipMove[] = [];
      for (const [clipId, nextStart] of positions) {
        const found = findTimelineClip({ tracks: beforeTracks }, clipId);
        if (!found || found.clip.startTime === nextStart) continue;
        moves.push({
          clipId,
          sourceTrackId: found.trackId,
          targetTrackId: found.trackId,
          originalStartTime: found.clip.startTime,
          newStartTime: nextStart,
          duration: found.clip.duration,
        });
      }
      tracks = moveAutomationPointsWithClips(tracks, moves, beforeTracks);
    }
    return { tracks, ...selection, isModified: true };
  });
  syncAutomationTrackSnapshots(beforeTracks, get().tracks);
  if (touchedMIDI) syncMIDITracksForTimelineClips(get, get().tracks);
}

function isMidiClipLike(clip: any) {
  return isMIDIClipboardClip(clip);
}

function findTimelineClip(state: any, clipId: string) {
  for (const track of state.tracks) {
    const audioIndex = track.clips.findIndex((clip: any) => clip.id === clipId);
    if (audioIndex !== -1) {
      return { clip: track.clips[audioIndex], trackId: track.id, track, index: audioIndex, kind: "audio" };
    }

    const midiIndex = track.midiClips.findIndex((clip: any) => clip.id === clipId);
    if (midiIndex !== -1) {
      return { clip: track.midiClips[midiIndex], trackId: track.id, track, index: midiIndex, kind: "midi" };
    }
  }

  return null;
}

function applyTimelineClipName(
  set: SetFn,
  get: GetFn,
  clipId: string,
  name: string,
) {
  const found = findTimelineClip(get(), clipId);
  if (!found || found.clip.name === name) return false;
  const isMidi = found.kind === "midi";
  set((state: any) => ({
    tracks: state.tracks.map((track: any) => ({
      ...track,
      clips: isMidi
        ? track.clips
        : track.clips.map((clip: any) => clip.id === clipId ? { ...clip, name } : clip),
      midiClips: isMidi
        ? track.midiClips.map((clip: any) => clip.id === clipId ? { ...clip, name } : clip)
        : track.midiClips,
    })),
    isModified: true,
  }));
  if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
  return true;
}

function cloneAudioClipDeep(clip: any, regenerateNestedTakeIds = false): any {
  return {
    ...clip,
    gainEnvelope: clip.gainEnvelope?.map((point: any) => ({ ...point })),
    takes: clip.takes?.map((take: any) => ({
      ...cloneAudioClipDeep(take, regenerateNestedTakeIds),
      ...(regenerateNestedTakeIds ? { id: crypto.randomUUID() } : {}),
    })),
  };
}

export function cloneTimelineClipDeep(clip: any, regenerateNestedTakeIds = false) {
  if (isMidiClipLike(clip)) {
    return {
      ...clip,
      ...cloneMIDIClipContent(clip),
    };
  }
  return cloneAudioClipDeep(clip, regenerateNestedTakeIds);
}

export function cloneTracksForTimelineUndo(tracks: any[]) {
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip: any) => cloneAudioClipDeep(clip)),
    midiClips: track.midiClips.map((clip: any) => cloneTimelineClipDeep(clip)),
    automationLanes: (track.automationLanes || []).map((lane: any) => ({
      ...lane,
      points: (lane.points || []).map((point: any) => ({ ...point })),
    })),
  }));
}

export function cloneClipboardAutomationTracks(tracks: any[], trackIds?: ReadonlySet<string>) {
  return tracks
    .filter((track) => !trackIds || trackIds.has(track.id))
    .map((track) => ({
      id: track.id,
      automationLanes: (track.automationLanes || []).map((lane: any) => ({
        ...lane,
        points: (lane.points || []).map((point: any) => ({ ...point })),
      })),
    }));
}

export function cloneTimelineClipboard(clipboard: any) {
  const clips = (clipboard.clips || []).map((entry: any) => ({
    trackId: entry.trackId,
    clip: cloneTimelineClipDeep(entry.clip),
  }));
  return {
    clip: clips[0]?.clip || (clipboard.clip ? cloneTimelineClipDeep(clipboard.clip) : null),
    clips,
    isCut: Boolean(clipboard.isCut),
    sourceRemoved: Boolean(clipboard.sourceRemoved),
    automationTracks: clipboard.automationTracks
      ? cloneClipboardAutomationTracks(clipboard.automationTracks)
      : undefined,
  };
}

export interface AutomationClipMove {
  clipId: string;
  sourceTrackId: string;
  targetTrackId: string;
  originalStartTime: number;
  newStartTime: number;
  duration: number;
}

export function shouldMoveAutomationWithItems(
  moveEnvelopesWithItems: boolean,
  invertFollow: boolean,
  envelopesLocked: boolean,
) {
  return !envelopesLocked
    && Boolean(moveEnvelopesWithItems) !== Boolean(invertFollow);
}

export function shouldInvertAutomationFollowForClipDrag(
  mouseBehaviorProfileId: string,
  shiftKey: boolean,
  isMoveGesture: boolean,
) {
  return isMoveGesture
    && mouseBehaviorProfileId === "cubase"
    && Boolean(shiftKey);
}

const AUTOMATION_ITEM_EDGE_EPSILON = 0.000001;

/**
 * Applies item-follow automation from an immutable pre-move track snapshot to
 * the current clip layout. A point is moved at most once even when selected
 * item ranges overlap, and point identity is preserved across track moves.
 */
export function moveAutomationPointsWithClips(
  currentTracks: any[],
  moves: AutomationClipMove[],
  automationSourceTracks: any[] = currentTracks,
) {
  const validMoves = moves.filter((move) => (
    Number.isFinite(move.originalStartTime)
    && Number.isFinite(move.newStartTime)
    && Number.isFinite(move.duration)
    && move.duration >= 0
    && move.sourceTrackId
    && move.targetTrackId
  ));
  if (validMoves.length === 0) return currentTracks;

  const sourceById = new Map(automationSourceTracks.map((track) => [track.id, track]));
  const targetById = new Map(currentTracks.map((track) => [track.id, track]));
  const touchedTrackIds = new Set<string>();
  const lanePoints = new Map<string, any[]>();
  const laneTemplates = new Map<string, any>();
  const crossTrackAdditions = new Map<string, any[]>();

  for (const track of automationSourceTracks) {
    for (const lane of track.automationLanes || []) {
      lanePoints.set(`${track.id}\u0000${lane.param}`, (lane.points || []).map((point: any) => ({ ...point })));
      laneTemplates.set(`${track.id}\u0000${lane.param}`, lane);
    }
  }

  for (const [sourceTrackId, sourceTrack] of sourceById) {
    const sourceMoves = validMoves.filter((move) => move.sourceTrackId === sourceTrackId);
    if (sourceMoves.length === 0) continue;
    for (const lane of sourceTrack.automationLanes || []) {
      const sourceKey = `${sourceTrackId}\u0000${lane.param}`;
      const originalPoints = (lane.points || []).map((point: any) => ({ ...point }));
      const kept: any[] = [];
      for (const point of originalPoints) {
        const matchingMove = sourceMoves.find((move) => {
          const intervalStart = Math.max(0, move.originalStartTime);
          const intervalEnd = intervalStart + Math.max(0, move.duration);
          return point.time >= intervalStart - AUTOMATION_ITEM_EDGE_EPSILON
            && point.time <= intervalEnd + AUTOMATION_ITEM_EDGE_EPSILON;
        });
        if (!matchingMove) {
          kept.push(point);
          continue;
        }
        const shifted = {
          ...point,
          time: Math.max(0, point.time + matchingMove.newStartTime - matchingMove.originalStartTime),
        };
        if (matchingMove.targetTrackId === sourceTrackId) {
          kept.push(shifted);
        } else {
          const targetKey = `${matchingMove.targetTrackId}\u0000${lane.param}`;
          const list = crossTrackAdditions.get(targetKey) || [];
          list.push(shifted);
          crossTrackAdditions.set(targetKey, list);
          touchedTrackIds.add(matchingMove.targetTrackId);
        }
        touchedTrackIds.add(sourceTrackId);
      }
      kept.sort((a, b) => a.time - b.time);
      lanePoints.set(sourceKey, kept);
    }
  }

  for (const [targetKey, points] of crossTrackAdditions) {
    const existing = lanePoints.get(targetKey) || [];
    lanePoints.set(targetKey, [...existing, ...points].sort((a, b) => a.time - b.time));
    if (!laneTemplates.has(targetKey)) {
      const separator = targetKey.indexOf("\u0000");
      const param = targetKey.slice(separator + 1);
      const template = Array.from(sourceById.values())
        .flatMap((track: any) => track.automationLanes || [])
        .find((lane: any) => lane.param === param);
      if (template) laneTemplates.set(targetKey, template);
    }
  }

  if (touchedTrackIds.size === 0) return currentTracks;
  return currentTracks.map((track) => {
    if (!touchedTrackIds.has(track.id)) return track;
    const existingByParam = new Map((track.automationLanes || []).map((lane: any) => [lane.param, lane]));
    const params = new Set<string>([
      ...existingByParam.keys(),
      ...Array.from(lanePoints.keys())
        .filter((key) => key.startsWith(`${track.id}\u0000`))
        .map((key) => key.slice(key.indexOf("\u0000") + 1)),
    ]);
    const automationLanes = Array.from(params).map((param) => {
      const key = `${track.id}\u0000${param}`;
      const existing: any = existingByParam.get(param);
      const template: any = laneTemplates.get(key);
      const base = existing || {
        ...template,
        id: `lane_${String(param).replace(/[^a-zA-Z0-9_-]/g, "-")}_${track.id}`,
        visible: Boolean(template?.visible),
      };
      return { ...base, points: (lanePoints.get(key) || []).map((point) => ({ ...point })) };
    });
    return { ...track, automationLanes };
  });
}

/**
 * Copy item-follow automation into the destination item ranges. Source points
 * are read once from the immutable pre-copy snapshot, receive fresh stable
 * identities, and replace existing destination points only in ranges where
 * source automation was actually copied.
 */
export function copyAutomationPointsWithClips(
  currentTracks: any[],
  copies: AutomationClipMove[],
  automationSourceTracks: any[] = currentTracks,
  regeneratePointIds = true,
) {
  const validCopies = copies.filter((copy) => (
    Number.isFinite(copy.originalStartTime)
    && Number.isFinite(copy.newStartTime)
    && Number.isFinite(copy.duration)
    && copy.duration >= 0
    && copy.sourceTrackId
    && copy.targetTrackId
  ));
  if (validCopies.length === 0) return currentTracks;

  const sourceById = new Map(automationSourceTracks.map((track) => [track.id, track]));
  const lanePoints = new Map<string, any[]>();
  const laneTemplates = new Map<string, any>();
  const copiedPoints = new Map<string, any[]>();
  const copiedRanges = new Map<string, Array<{ start: number; end: number }>>();
  const touchedTrackIds = new Set<string>();

  for (const track of currentTracks) {
    for (const lane of track.automationLanes || []) {
      const key = `${track.id}\u0000${lane.param}`;
      lanePoints.set(key, (lane.points || []).map((point: any) => ({ ...point })));
      laneTemplates.set(key, lane);
    }
  }

  for (const [sourceTrackId, sourceTrack] of sourceById) {
    const sourceCopies = validCopies.filter((copy) => copy.sourceTrackId === sourceTrackId);
    if (sourceCopies.length === 0) continue;
    for (const lane of sourceTrack.automationLanes || []) {
      const pointsByTarget = new Map<string, any[]>();
      const rangesByTarget = new Map<string, Array<{ start: number; end: number }>>();
      for (const point of lane.points || []) {
        const firstMatchingCopy = sourceCopies.find((copy) => {
          const intervalStart = Math.max(0, copy.originalStartTime);
          const intervalEnd = intervalStart + Math.max(0, copy.duration);
          return point.time >= intervalStart - AUTOMATION_ITEM_EDGE_EPSILON
            && point.time <= intervalEnd + AUTOMATION_ITEM_EDGE_EPSILON;
        });
        if (!firstMatchingCopy) continue;
        // A point covered by overlapping source items belongs to the first
        // source item, but every destination copy/repeat of that source must
        // receive it.
        const matchingCopies = sourceCopies.filter((copy) => copy.clipId === firstMatchingCopy.clipId);
        for (const matchingCopy of matchingCopies) {
          const targetKey = `${matchingCopy.targetTrackId}\u0000${lane.param}`;
          const points = pointsByTarget.get(targetKey) || [];
          points.push({
            ...point,
            id: regeneratePointIds ? createAutomationPointId() : point.id,
            time: Math.max(0, point.time + matchingCopy.newStartTime - matchingCopy.originalStartTime),
          });
          pointsByTarget.set(targetKey, points);
          if (!rangesByTarget.has(targetKey)) rangesByTarget.set(targetKey, []);
          const ranges = rangesByTarget.get(targetKey)!;
          const range = {
            start: Math.max(0, matchingCopy.newStartTime),
            end: Math.max(0, matchingCopy.newStartTime) + Math.max(0, matchingCopy.duration),
          };
          if (!ranges.some((candidate) => candidate.start === range.start && candidate.end === range.end)) {
            ranges.push(range);
          }
        }
      }

      for (const [targetKey, points] of pointsByTarget) {
        copiedPoints.set(targetKey, [...(copiedPoints.get(targetKey) || []), ...points]);
        copiedRanges.set(targetKey, [
          ...(copiedRanges.get(targetKey) || []),
          ...(rangesByTarget.get(targetKey) || []),
        ]);
        if (!laneTemplates.has(targetKey)) laneTemplates.set(targetKey, lane);
        touchedTrackIds.add(targetKey.slice(0, targetKey.indexOf("\u0000")));
      }
    }
  }

  if (touchedTrackIds.size === 0) return currentTracks;
  for (const [targetKey, additions] of copiedPoints) {
    const ranges = copiedRanges.get(targetKey) || [];
    const retained = (lanePoints.get(targetKey) || []).filter((point) => !ranges.some((range) => (
      point.time >= range.start - AUTOMATION_ITEM_EDGE_EPSILON
      && point.time <= range.end + AUTOMATION_ITEM_EDGE_EPSILON
    )));
    lanePoints.set(
      targetKey,
      [...retained, ...additions].sort((left, right) => left.time - right.time),
    );
  }

  return currentTracks.map((track) => {
    if (!touchedTrackIds.has(track.id)) return track;
    const existingByParam = new Map((track.automationLanes || []).map((lane: any) => [lane.param, lane]));
    const params = new Set<string>([
      ...existingByParam.keys(),
      ...Array.from(lanePoints.keys())
        .filter((key) => key.startsWith(`${track.id}\u0000`))
        .map((key) => key.slice(key.indexOf("\u0000") + 1)),
    ]);
    const automationLanes = Array.from(params).map((param) => {
      const key = `${track.id}\u0000${param}`;
      const existing: any = existingByParam.get(param);
      const template: any = laneTemplates.get(key);
      const base = existing || {
        ...template,
        id: `lane_${String(param).replace(/[^a-zA-Z0-9_-]/g, "-")}_${track.id}`,
        visible: Boolean(template?.visible),
      };
      return { ...base, points: (lanePoints.get(key) || []).map((point) => ({ ...point })) };
    });
    return { ...track, automationLanes };
  });
}

/** Remove automation carried by cut/deleted item ranges without touching surrounding points. */
export function removeAutomationPointsWithClips(
  currentTracks: any[],
  clips: readonly Pick<AutomationClipMove, "sourceTrackId" | "originalStartTime" | "duration">[],
) {
  const validClips = clips.filter((clip) => (
    clip.sourceTrackId
    && Number.isFinite(clip.originalStartTime)
    && Number.isFinite(clip.duration)
    && clip.duration >= 0
  ));
  if (validClips.length === 0) return currentTracks;
  return currentTracks.map((track) => {
    const ranges = validClips.filter((clip) => clip.sourceTrackId === track.id);
    if (ranges.length === 0) return track;
    return {
      ...track,
      automationLanes: (track.automationLanes || []).map((lane: any) => ({
        ...lane,
        points: (lane.points || []).filter((point: any) => !ranges.some((range) => {
          const start = Math.max(0, range.originalStartTime);
          const end = start + Math.max(0, range.duration);
          return point.time >= start - AUTOMATION_ITEM_EDGE_EPSILON
            && point.time <= end + AUTOMATION_ITEM_EDGE_EPSILON;
        })),
      })),
    };
  });
}

export function syncAutomationTrackSnapshots(beforeTracks: any[], afterTracks: any[]) {
  const afterPairs = new Set<string>();
  for (const track of afterTracks) {
    for (const lane of track.automationLanes || []) {
      afterPairs.add(`${track.id}\u0000${lane.param}`);
      syncAutomationLaneToBackend(track.id, lane);
    }
  }
  for (const track of beforeTracks) {
    for (const lane of track.automationLanes || []) {
      const key = `${track.id}\u0000${lane.param}`;
      if (!afterPairs.has(key)) nativeBridge.clearAutomation(track.id, lane.param).catch(() => {});
    }
  }
}

export function syncMIDITracksForTimelineClips(get: GetFn, tracks: any[]) {
  const state = get();
  const trackIds = new Set<string>();
  for (const track of tracks) {
    if (track?.type === "midi" || track?.type === "instrument") {
      trackIds.add(track.id);
    }
  }
  for (const trackId of trackIds) {
    const syncResult = state.syncMIDITrackToBackend?.(trackId, { debounce: false });
    if (syncResult?.catch) syncResult.catch(() => {});
  }
}

const SPLIT_TIME_EPSILON = 0.000001;

export function cloneSelectionSnapshot(state: any) {
  return {
    selectedClipIds: [...state.selectedClipIds],
    selectedClipId: state.selectedClipId,
    selectedTrackIds: [...state.selectedTrackIds],
    selectedTrackId: state.selectedTrackId,
    lastSelectedTrackId: state.lastSelectedTrackId,
  };
}

export function cloneMIDIEditorSnapshot(state: any) {
  return {
    midiEditorSessions: (state.midiEditorSessions || []).map((session: any) => ({
      ...session,
      selectedNoteIds: [...(session.selectedNoteIds || [])],
      visibleLanes: (session.visibleLanes || []).map((lane: any) => ({ ...lane })),
    })),
    activeMidiEditorSessionId: state.activeMidiEditorSessionId,
    dockedMidiEditorSessionId: state.dockedMidiEditorSessionId,
    detachedPanels: [...(state.detachedPanels || [])],
    showPianoRoll: state.showPianoRoll,
    pianoRollTrackId: state.pianoRollTrackId,
    pianoRollClipId: state.pianoRollClipId,
    selectedNoteIds: [...(state.selectedNoteIds || [])],
    midiEditRange: state.midiEditRange ? { ...state.midiEditRange } : null,
    pianoRollEditCursorTime: state.pianoRollEditCursorTime,
    activeMidiTool: state.activeMidiTool,
    pianoRollVisibleLanes: (state.pianoRollVisibleLanes || []).map((lane: any) => ({ ...lane })),
    pianoRollActiveLaneId: state.pianoRollActiveLaneId,
  };
}

export function buildPostDeleteMIDIEditorState(before: any, deletedClipIds: ReadonlySet<string>) {
  const midiEditorSessions = before.midiEditorSessions
    .filter((session: any) => !deletedClipIds.has(session.clipId));
  const sessionIds = new Set<string>(midiEditorSessions.map((session: any) => session.sessionId));
  const dockedMidiEditorSessionId = sessionIds.has(before.dockedMidiEditorSessionId)
    ? before.dockedMidiEditorSessionId
    : null;
  const activeMidiEditorSessionId = sessionIds.has(before.activeMidiEditorSessionId)
    ? before.activeMidiEditorSessionId
    : (dockedMidiEditorSessionId || midiEditorSessions[0]?.sessionId || null);
  const activeSession = midiEditorSessions.find(
    (session: any) => session.sessionId === activeMidiEditorSessionId,
  );
  const hasWindowedSession = midiEditorSessions.some((session: any) => session.mode === "windowed");
  const activeSourceWasDeleted = deletedClipIds.has(before.pianoRollClipId);

  return {
    midiEditorSessions,
    activeMidiEditorSessionId,
    dockedMidiEditorSessionId,
    detachedPanels: hasWindowedSession
      ? before.detachedPanels
      : before.detachedPanels.filter((panelId: string) => panelId !== "midiEditor"),
    showPianoRoll: Boolean(dockedMidiEditorSessionId),
    pianoRollTrackId: activeSession?.trackId || null,
    pianoRollClipId: activeSession?.clipId || null,
    selectedNoteIds: activeSourceWasDeleted
      ? [...(activeSession?.selectedNoteIds || [])]
      : before.selectedNoteIds,
    midiEditRange: activeSourceWasDeleted
      ? (activeSession?.midiEditRange ? { ...activeSession.midiEditRange } : null)
      : before.midiEditRange,
    pianoRollEditCursorTime: activeSourceWasDeleted
      ? (activeSession?.editCursorTime ?? null)
      : before.pianoRollEditCursorTime,
    activeMidiTool: activeSourceWasDeleted
      ? (activeSession?.activeTool ?? before.activeMidiTool)
      : before.activeMidiTool,
    pianoRollVisibleLanes: activeSourceWasDeleted
      ? (activeSession?.visibleLanes || before.pianoRollVisibleLanes).map((lane: any) => ({ ...lane }))
      : before.pianoRollVisibleLanes,
    pianoRollActiveLaneId: activeSourceWasDeleted
      ? (activeSession?.activeLaneId ?? before.pianoRollActiveLaneId)
      : before.pianoRollActiveLaneId,
  };
}

/**
 * Detached MIDI editors are native windows, not just Zustand metadata. When
 * their source is deleted we close them permanently; undo can restore docked
 * sessions, but must not recreate a windowed session record without a native
 * window behind it.
 */
export function buildSafeUndoMIDIEditorState(before: any, deletedClipIds: ReadonlySet<string>) {
  const midiEditorSessions = before.midiEditorSessions.filter(
    (session: any) => !(session.mode === "windowed" && deletedClipIds.has(session.clipId)),
  );
  if (midiEditorSessions.length === before.midiEditorSessions.length) return before;

  const sessionIds = new Set<string>(midiEditorSessions.map((session: any) => session.sessionId));
  const dockedMidiEditorSessionId = sessionIds.has(before.dockedMidiEditorSessionId)
    ? before.dockedMidiEditorSessionId
    : null;
  const activeMidiEditorSessionId = sessionIds.has(before.activeMidiEditorSessionId)
    ? before.activeMidiEditorSessionId
    : (dockedMidiEditorSessionId || midiEditorSessions[0]?.sessionId || null);
  const activeSession = midiEditorSessions.find(
    (session: any) => session.sessionId === activeMidiEditorSessionId,
  );
  const hasWindowedSession = midiEditorSessions.some((session: any) => session.mode === "windowed");

  return {
    ...before,
    midiEditorSessions,
    activeMidiEditorSessionId,
    dockedMidiEditorSessionId,
    detachedPanels: hasWindowedSession
      ? before.detachedPanels
      : before.detachedPanels.filter((panelId: string) => panelId !== "midiEditor"),
    showPianoRoll: Boolean(dockedMidiEditorSessionId),
    pianoRollTrackId: activeSession?.trackId || null,
    pianoRollClipId: activeSession?.clipId || null,
    selectedNoteIds: [...(activeSession?.selectedNoteIds || [])],
    midiEditRange: activeSession?.midiEditRange
      ? { ...activeSession.midiEditRange }
      : null,
    pianoRollEditCursorTime: activeSession?.editCursorTime ?? null,
    activeMidiTool: activeSession?.activeTool || before.activeMidiTool,
    pianoRollVisibleLanes: (activeSession?.visibleLanes || before.pianoRollVisibleLanes)
      .map((lane: any) => ({ ...lane })),
    pianoRollActiveLaneId: activeSession?.activeLaneId || before.pianoRollActiveLaneId,
  };
}

export function closeDeletedWindowedMIDIEditors(before: any, deletedClipIds: ReadonlySet<string>) {
  for (const session of before.midiEditorSessions) {
    if (session.mode !== "windowed" || !deletedClipIds.has(session.clipId)) continue;
    const result = nativeBridge.closeMidiEditorWindow(session.sessionId, "sourceDelete");
    if (result?.catch) result.catch(logBridgeError("close deleted MIDI editor"));
  }
}

function buildPostSplitMIDIEditorState(before: any, splitData: any[]) {
  const splitClipIds = new Set<string>(
    splitData
      .filter((split: any) => split.kind === "midi")
      .map((split: any) => split.originalClip.id),
  );
  if (splitClipIds.size === 0) return null;

  const midiEditorSessions = before.midiEditorSessions
    .filter((session: any) => !splitClipIds.has(session.clipId));
  const sessionIds = new Set<string>(midiEditorSessions.map((session: any) => session.sessionId));
  const dockedMidiEditorSessionId = sessionIds.has(before.dockedMidiEditorSessionId)
    ? before.dockedMidiEditorSessionId
    : null;
  const activeMidiEditorSessionId = sessionIds.has(before.activeMidiEditorSessionId)
    ? before.activeMidiEditorSessionId
    : (dockedMidiEditorSessionId || midiEditorSessions[0]?.sessionId || null);
  const activeSession = midiEditorSessions.find(
    (session: any) => session.sessionId === activeMidiEditorSessionId,
  );
  const hasWindowedSession = midiEditorSessions.some((session: any) => session.mode === "windowed");

  return {
    midiEditorSessions,
    activeMidiEditorSessionId,
    dockedMidiEditorSessionId,
    detachedPanels: hasWindowedSession
      ? before.detachedPanels
      : before.detachedPanels.filter((panelId: string) => panelId !== "midiEditor"),
    showPianoRoll: Boolean(dockedMidiEditorSessionId),
    pianoRollTrackId: activeSession?.trackId || null,
    pianoRollClipId: activeSession?.clipId || null,
    selectedNoteIds: [...(activeSession?.selectedNoteIds || [])],
    midiEditRange: activeSession?.midiEditRange || null,
    pianoRollEditCursorTime: activeSession?.editCursorTime ?? null,
    activeMidiTool: activeSession?.activeTool || before.activeMidiTool,
    pianoRollVisibleLanes: (activeSession?.visibleLanes || before.pianoRollVisibleLanes)
      .map((lane: any) => ({ ...lane })),
    pianoRollActiveLaneId: activeSession?.activeLaneId || before.pianoRollActiveLaneId,
  };
}

function clipContainsSplitTime(clip: any, splitTime: number) {
  const clipStart = Number(clip?.startTime);
  const clipEnd = clipStart + Number(clip?.duration);
  return Number.isFinite(clipStart)
    && Number.isFinite(clipEnd)
    && splitTime > clipStart + SPLIT_TIME_EPSILON
    && splitTime < clipEnd - SPLIT_TIME_EPSILON;
}

function getTimelineClipEntries(state: any) {
  return state.tracks.flatMap((track: any) => [
    ...track.clips.map((clip: any, index: number) => ({
      clip,
      track,
      trackId: track.id,
      index,
      kind: "audio",
    })),
    ...track.midiClips.map((clip: any, index: number) => ({
      clip,
      track,
      trackId: track.id,
      index,
      kind: "midi",
    })),
  ]);
}

function resolveTimelineSplitTargets(state: any, splitTime: number, anchorClipId?: string) {
  if (!Number.isFinite(splitTime)) return [];
  if (state.globalLocked || state.lockSettings?.items) return [];

  const entries = getTimelineClipEntries(state);
  const selectedClipIds = new Set<string>(
    state.selectedClipIds.length > 0
      ? state.selectedClipIds
      : state.selectedClipId ? [state.selectedClipId] : [],
  );
  const selectedTrackIds = new Set<string>(state.selectedTrackIds);
  const crossingEntries = entries.filter((entry: any) =>
    clipContainsSplitTime(entry.clip, splitTime));
  const selectedClipCrossings = crossingEntries.filter((entry: any) =>
    selectedClipIds.has(entry.clip.id));
  const selectedTrackCrossings = crossingEntries.filter((entry: any) =>
    selectedTrackIds.has(entry.trackId));
  const editable = (candidates: any[]) => candidates.filter((entry: any) => (
    !entry.track.frozen && !entry.clip.locked
  ));
  const anchor = anchorClipId
    ? entries.find((entry: any) => entry.clip.id === anchorClipId)
    : null;

  if (anchorClipId) {
    if (!anchor) return [];
    if (selectedClipIds.has(anchorClipId)) {
      if (selectedClipCrossings.length > 0) return editable(selectedClipCrossings);
      if (selectedTrackCrossings.length > 0) return editable(selectedTrackCrossings);
    } else if (selectedClipIds.size === 0 && selectedTrackIds.has(anchor.trackId)) {
      if (selectedTrackCrossings.length > 0) return editable(selectedTrackCrossings);
    }
    return editable(crossingEntries.filter((entry: any) => entry.clip.id === anchorClipId));
  }

  if (selectedClipCrossings.length > 0) return editable(selectedClipCrossings);
  if (selectedTrackCrossings.length > 0) return editable(selectedTrackCrossings);
  return editable(crossingEntries);
}

function resolveTimelineSplitTargetsAtTimes(state: any, splitTimes: readonly number[]) {
  if (state.globalLocked || state.lockSettings?.items) return [];
  const finiteTimes = [...new Set(splitTimes.filter(Number.isFinite))].sort((a, b) => a - b);
  if (finiteTimes.length === 0) return [];

  const entries = getTimelineClipEntries(state);
  const crossesBoundary = (entry: any) => finiteTimes.some((time) => (
    clipContainsSplitTime(entry.clip, time)
  ));
  const crossingEntries = entries.filter(crossesBoundary);
  const selectedClipIds = new Set<string>(
    state.selectedClipIds.length > 0
      ? state.selectedClipIds
      : state.selectedClipId ? [state.selectedClipId] : [],
  );
  const selectedTrackIds = new Set<string>(state.selectedTrackIds);
  const selectedClipCrossings = crossingEntries.filter((entry: any) => (
    selectedClipIds.has(entry.clip.id)
  ));
  const selectedTrackCrossings = crossingEntries.filter((entry: any) => (
    selectedTrackIds.has(entry.trackId)
  ));
  const candidates = selectedClipCrossings.length > 0
    ? selectedClipCrossings
    : selectedTrackCrossings.length > 0
      ? selectedTrackCrossings
      : crossingEntries;
  return candidates.filter((entry: any) => !entry.track.frozen && !entry.clip.locked);
}

function interpolateGainEnvelope(points: any[], time: number) {
  if (points.length === 0) return 1;
  if (time <= points[0].time) return points[0].gain;
  if (time >= points[points.length - 1].time) return points[points.length - 1].gain;

  for (let index = 0; index + 1 < points.length; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (time < left.time || time > right.time) continue;
    const span = right.time - left.time;
    if (Math.abs(span) <= SPLIT_TIME_EPSILON) return right.gain;
    const amount = (time - left.time) / span;
    return left.gain + amount * (right.gain - left.gain);
  }

  return 1;
}

function splitGainEnvelope(envelope: any, splitOffset: number) {
  if (!Array.isArray(envelope)) {
    return { left: undefined, right: undefined };
  }
  if (envelope.length === 0) {
    return { left: [], right: [] };
  }

  const points = envelope
    .filter((point: any) => Number.isFinite(point?.time) && Number.isFinite(point?.gain))
    .map((point: any) => ({ time: Number(point.time), gain: Number(point.gain) }))
    .sort((a: any, b: any) => a.time - b.time);
  if (points.length === 0) {
    return { left: [], right: [] };
  }

  const boundaryGain = interpolateGainEnvelope(points, splitOffset);
  const left = points
    .filter((point: any) => point.time < splitOffset - SPLIT_TIME_EPSILON)
    .map((point: any) => ({ ...point }));
  left.push({ time: splitOffset, gain: boundaryGain });

  const right = [{ time: 0, gain: boundaryGain }];
  for (const point of points) {
    if (point.time > splitOffset + SPLIT_TIME_EPSILON) {
      right.push({ time: point.time - splitOffset, gain: point.gain });
    }
  }

  return { left, right };
}

function cloneMIDIClipContent(clip: any) {
  return {
    events: clip.events.map((event: any) => ({ ...event })),
    ccEvents: clip.ccEvents?.map((event: any) => ({ ...event })) || [],
    quantizeBackup: clip.quantizeBackup
      ? {
          events: clip.quantizeBackup.events.map((event: any) => ({ ...event })),
          ccEvents: clip.quantizeBackup.ccEvents?.map((event: any) => ({ ...event })),
        }
      : undefined,
  };
}

function splitAudioTakes(
  takes: any,
  originalStartTime: number,
  splitTime: number,
  splitOffset: number,
  rightDuration: number,
) {
  if (!Array.isArray(takes)) return takes;
  const parentDuration = splitOffset + rightDuration;
  return takes.map((take: any) => {
    if (!take || typeof take !== "object") return take;
    const takeOffset = Number.isFinite(Number(take.offset)) ? Number(take.offset) : 0;
    const declaredDuration = Number.isFinite(Number(take.duration))
      ? Math.max(0, Number(take.duration))
      : parentDuration;
    const sourceLength = Number(take.sourceLength);
    const sourceAvailableDuration = Number.isFinite(sourceLength) && sourceLength > 0
      ? Math.max(0, sourceLength - takeOffset)
      : parentDuration;
    // Imploded/imported takes are not guaranteed to span the parent item. Keep
    // each take slot, but intersect its content with the two child windows so a
    // right-hand take never advances beyond its own source.
    const availableDuration = Math.min(parentDuration, declaredDuration, sourceAvailableDuration);
    const takeSplitOffset = Math.min(splitOffset, availableDuration);
    const leftDuration = takeSplitOffset;
    const boundedRightDuration = Math.min(
      rightDuration,
      Math.max(0, availableDuration - splitOffset),
    );
    const fadeIn = Math.max(0, Number(take.fadeIn) || 0);
    const fadeOut = Math.max(0, Number(take.fadeOut) || 0);
    const envelopes = splitGainEnvelope(take.gainEnvelope, takeSplitOffset);
    const hasRightContent = boundedRightDuration > SPLIT_TIME_EPSILON;
    return {
      left: {
        ...take,
        id: crypto.randomUUID(),
        startTime: originalStartTime,
        duration: leftDuration,
        offset: takeOffset,
        fadeIn: Math.min(fadeIn, leftDuration),
        fadeOut: hasRightContent ? 0 : Math.min(fadeOut, leftDuration),
        gainEnvelope: envelopes.left,
      },
      right: {
        ...take,
        id: crypto.randomUUID(),
        startTime: splitTime,
        duration: boundedRightDuration,
        offset: takeOffset + takeSplitOffset,
        pitchCorrectionSourceOffset: Number.isFinite(take.pitchCorrectionSourceOffset)
          ? take.pitchCorrectionSourceOffset + takeSplitOffset
          : take.pitchCorrectionSourceOffset,
        fadeIn: 0,
        fadeOut: Math.min(fadeOut, boundedRightDuration),
        gainEnvelope: envelopes.right,
      },
    };
  });
}

function createTimelineSplit(entry: any, splitTime: number) {
  const { clip, trackId, kind } = entry;
  const splitOffset = splitTime - clip.startTime;
  const rightDuration = clip.duration - splitOffset;
  const leftId = crypto.randomUUID();
  const rightId = crypto.randomUUID();

  if (kind === "midi") {
    const leftContent = cloneMIDIClipContent(clip);
    const rightContent = cloneMIDIClipContent(clip);
    return {
      originalClip: clip,
      trackId,
      kind,
      leftClip: {
        ...clip,
        ...leftContent,
        id: leftId,
        duration: splitOffset,
        offset: clip.offset || 0,
      },
      rightClip: {
        ...clip,
        ...rightContent,
        id: rightId,
        startTime: splitTime,
        duration: rightDuration,
        offset: (clip.offset || 0) + splitOffset,
      },
    };
  }

  const envelopes = splitGainEnvelope(clip.gainEnvelope, splitOffset);
  const fadeIn = Math.max(0, Number(clip.fadeIn) || 0);
  const fadeOut = Math.max(0, Number(clip.fadeOut) || 0);
  const splitTakes = splitAudioTakes(
    clip.takes,
    clip.startTime,
    splitTime,
    splitOffset,
    rightDuration,
  );
  return {
    originalClip: clip,
    trackId,
    kind,
    leftClip: {
      ...clip,
      id: leftId,
      duration: splitOffset,
      fadeIn: Math.min(fadeIn, splitOffset),
      fadeOut: 0,
      gainEnvelope: envelopes.left,
      takes: splitTakes?.map((take: any) => take.left),
    },
    rightClip: {
      ...clip,
      id: rightId,
      startTime: splitTime,
      duration: rightDuration,
      offset: (clip.offset || 0) + splitOffset,
      pitchCorrectionSourceOffset: Number.isFinite(clip.pitchCorrectionSourceOffset)
        ? clip.pitchCorrectionSourceOffset + splitOffset
        : clip.pitchCorrectionSourceOffset,
      fadeIn: 0,
      fadeOut: Math.min(fadeOut, rightDuration),
      gainEnvelope: envelopes.right,
      takes: splitTakes?.map((take: any) => take.right),
    },
  };
}

function getReplacementClips(split: any) {
  return split.replacementClips || [split.leftClip, split.rightClip];
}

function createTimelineSplitAtTimes(entry: any, splitTimes: readonly number[]) {
  const replacementClips = [entry.clip];
  for (const splitTime of [...new Set(splitTimes)].sort((a, b) => a - b)) {
    const index = replacementClips.findIndex((clip) => clipContainsSplitTime(clip, splitTime));
    if (index < 0) continue;
    const split = createTimelineSplit({ ...entry, clip: replacementClips[index] }, splitTime);
    replacementClips.splice(index, 1, split.leftClip, split.rightClip);
  }
  return {
    originalClip: entry.clip,
    trackId: entry.trackId,
    kind: entry.kind,
    replacementClips,
  };
}

function buildSplitTrackSnapshots(tracks: any[], splitData: any[]) {
  const replacements = new Map(splitData.map((split: any) => [
    split.originalClip.id,
    split,
  ]));
  const snapshots = new Map<string, any>();

  for (const track of tracks) {
    const hasAudioSplit = track.clips.some((clip: any) => replacements.has(clip.id));
    const hasMIDISplit = track.midiClips.some((clip: any) => replacements.has(clip.id));
    if (!hasAudioSplit && !hasMIDISplit) continue;

    snapshots.set(track.id, {
      beforeClips: [...track.clips],
      beforeMIDIClips: [...track.midiClips],
      afterClips: track.clips.flatMap((clip: any) => {
        const split = replacements.get(clip.id);
        return split?.kind === "audio" ? getReplacementClips(split) : [clip];
      }),
      afterMIDIClips: track.midiClips.flatMap((clip: any) => {
        const split = replacements.get(clip.id);
        return split?.kind === "midi" ? getReplacementClips(split) : [clip];
      }),
    });
  }

  return snapshots;
}

function applySplitTrackSnapshots(tracks: any[], snapshots: Map<string, any>, phase: "before" | "after") {
  return tracks.map((track: any) => {
    const snapshot = snapshots.get(track.id);
    if (!snapshot) return track;
    return {
      ...track,
      clips: [...snapshot[`${phase}Clips`]],
      midiClips: [...snapshot[`${phase}MIDIClips`]],
    };
  });
}

function buildPostSplitSelection(before: any, splitData: any[]) {
  const replacements = new Map(splitData.map((split: any) => [
    split.originalClip.id,
    getReplacementClips(split).map((clip: any) => clip.id),
  ]));
  const selectedClipIds: string[] = [];

  for (const clipId of before.selectedClipIds) {
    selectedClipIds.push(...(replacements.get(clipId) || [clipId]));
  }

  const uniqueSelectedClipIds = [...new Set(selectedClipIds)];
  const primaryReplacement = before.selectedClipId
    ? replacements.get(before.selectedClipId)
    : null;
  return {
    ...before,
    selectedClipIds: uniqueSelectedClipIds,
    selectedClipId: primaryReplacement?.[primaryReplacement.length - 1]
      || (before.selectedClipId && uniqueSelectedClipIds.includes(before.selectedClipId)
        ? before.selectedClipId
        : null),
  };
}

function commitTimelineSplit(
  set: SetFn,
  get: GetFn,
  splitData: any[],
  description?: string,
) {
  if (splitData.length === 0) return false;

  const state = get();
  const trackSnapshots = buildSplitTrackSnapshots(state.tracks, splitData);
  const beforeSelection = cloneSelectionSnapshot(state);
  const afterSelection = buildPostSplitSelection(beforeSelection, splitData);
  const splitMIDIClipIds = new Set<string>(
    splitData
      .filter((split: any) => split.kind === "midi")
      .map((split: any) => split.originalClip.id),
  );
  const splitAudioClipIds = new Set<string>(
    splitData
      .filter((split: any) => split.kind === "audio")
      .map((split: any) => split.originalClip.id),
  );

  const apply = (phase: "before" | "after", selection: any) => {
    let midiEditorPatch = null;
    if (phase === "after"
        && get().showPitchEditor
        && splitAudioClipIds.has(get().pitchEditorClipId)) {
      get().closePitchEditor?.();
    }
    if (phase === "after" && splitMIDIClipIds.size > 0) {
      const currentMIDIEditor = cloneMIDIEditorSnapshot(get());
      const detachedMIDISessionIds = currentMIDIEditor.midiEditorSessions
        .filter((session: any) => session.mode === "windowed" && splitMIDIClipIds.has(session.clipId))
        .map((session: any) => session.sessionId);
      for (const sessionId of detachedMIDISessionIds) {
        const result = nativeBridge.closeMidiEditorWindow(sessionId, "sourceSplit");
        if (result?.catch) result.catch(() => {});
      }
      midiEditorPatch = buildPostSplitMIDIEditorState(currentMIDIEditor, splitData);
    }
    set((current: any) => ({
      tracks: applySplitTrackSnapshots(current.tracks, trackSnapshots, phase),
      ...selection,
      ...(midiEditorPatch || {}),
      isModified: true,
    }));
    syncTimelineSplit(get, splitData);
  };

  commandManager.execute({
    type: splitData.some((split: any) => split.kind === "midi")
      ? "SPLIT_TIMELINE_CLIPS"
      : "SPLIT_CLIP",
    description: description
      || `Split ${splitData.length} clip${splitData.length === 1 ? "" : "s"}`,
    timestamp: Date.now(),
    execute: () => apply("after", afterSelection),
    undo: () => apply("before", beforeSelection),
  });

  set({
    canUndo: commandManager.canUndo(),
    canRedo: commandManager.canRedo(),
    isModified: true,
  });
  return true;
}

function syncTimelineSplit(get: GetFn, splitData: any[]) {
  const state = get();
  const hasAudio = splitData.some((split: any) => split.kind === "audio");
  const midiTrackIds = new Set<string>(
    splitData
      .filter((split: any) => split.kind === "midi")
      .map((split: any) => split.trackId),
  );

  if (hasAudio && state.syncClipsWithBackend) {
    const result = state.syncClipsWithBackend();
    if (result?.catch) {
      result.catch((error: unknown) => {
        console.error("[timeline.split] Backend clip sync failed after recovery attempt", error);
      });
    }
  }

  for (const trackId of midiTrackIds) {
    const result = state.syncMIDITrackToBackend?.(trackId, { debounce: false });
    if (result?.catch) result.catch(() => {});
  }
}

function splitTimelineAtPosition(set: SetFn, get: GetFn, splitTime: number, anchorClipId?: string) {
  const state = get();
  const targets = resolveTimelineSplitTargets(state, splitTime, anchorClipId);
  if (targets.length === 0) return;

  const splitData = targets.map((entry: any) => createTimelineSplit(entry, splitTime));
  commitTimelineSplit(set, get, splitData);
}

export const clipEditingActions = (set: SetFn, get: GetFn) => ({
    splitClipAtPlayhead: () => {
      splitTimelineAtPosition(set, get, get().transport.currentTime);
    },

    splitClipAtPosition: (clipId, splitTime) => {
      splitTimelineAtPosition(set, get, splitTime, clipId);
    },

    splitMIDIClipAtPosition: (clipId, splitTime) => {
      splitTimelineAtPosition(set, get, splitTime, clipId);
    },

    selectClip: (clipId, modifiers) => {
      // Clear track selection when selecting a clip to avoid delete conflicts
      if (clipId === null) {
        set({ selectedClipId: null, selectedClipIds: [] });
        return;
      }

      const { ctrl } = modifiers || {};
      const state = get();

      if (ctrl) {
        // Toggle: add or remove from multi-selection
        const isSelected = state.selectedClipIds.includes(clipId);
        if (isSelected) {
          const newIds = state.selectedClipIds.filter((id) => id !== clipId);
          set({
            selectedClipIds: newIds,
            selectedClipId: newIds.length > 0 ? newIds[newIds.length - 1] : null,
          });
        } else {
          set({
            selectedClipIds: [...state.selectedClipIds, clipId],
            selectedClipId: clipId,
            selectedTrackIds: [],
            lastSelectedTrackId: null,
          });
        }
      } else {
        // Single selection — also select grouped clips
        const clickedClip = state.tracks
          .flatMap((t) => [...t.clips, ...t.midiClips])
          .find((c) => c.id === clipId);
        let ids = [clipId];
        if (clickedClip?.groupId) {
          ids = state.tracks
            .flatMap((t) => [...t.clips, ...t.midiClips])
            .filter((c) => c.groupId === clickedClip.groupId)
            .map((c) => c.id);
        }
        set({
          selectedClipId: clipId,
          selectedClipIds: ids,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
        });
      }
    },

    selectAllClips: () => {
      const state = get();
      const allClipIds = state.tracks.flatMap((t) => [
        ...t.clips.map((c) => c.id),
        ...t.midiClips.map((c) => c.id),
      ]);
      set({
        selectedClipIds: allClipIds,
        selectedClipId: allClipIds.length > 0 ? allClipIds[0] : null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    setSelectedClipIds: (clipIds: string[]) => {
      set({
        selectedClipIds: clipIds,
        selectedClipId: clipIds.length > 0 ? clipIds[clipIds.length - 1] : null,
      });
    },

    moveClipToTrack: async (clipId, newTrackId, newStartTime, options = {}) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return;

      const sourceTrackId = found.trackId;
      const targetTrack = state.tracks.find((t) => t.id === newTrackId);
      if (!targetTrack) return;

      const isMidi = found.kind === "midi";
      if (isMidi && targetTrack.type !== "midi" && targetTrack.type !== "instrument") return;
      if (!isMidi && (targetTrack.type === "midi" || targetTrack.type === "instrument")) return;

      const targetColor = targetTrack.color;
      const updatedClip = {
        ...found.clip,
        startTime: Math.max(0, newStartTime),
        color: targetColor || found.clip.color,
      };

      if (
        sourceTrackId === newTrackId
        && found.clip.startTime === updatedClip.startTime
        && found.clip.color === updatedClip.color
      ) return;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const oldMidiEditorSessions = (state.midiEditorSessions || []).map((session) => ({ ...session }));
      const oldPianoRollTrackId = state.pianoRollTrackId;

      set((current) => {
        let tracks = current.tracks.map((track) => {
          if (track.id === sourceTrackId && sourceTrackId === newTrackId) {
            return isMidi
              ? {
                  ...track,
                  midiClips: track.midiClips.map((clip) =>
                    clip.id === clipId ? updatedClip : clip,
                  ),
                }
              : {
                  ...track,
                  clips: track.clips.map((clip) =>
                    clip.id === clipId ? updatedClip : clip,
                  ),
                };
          }

          if (track.id === sourceTrackId) {
            return isMidi
              ? { ...track, midiClips: track.midiClips.filter((clip) => clip.id !== clipId) }
              : { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) };
          }

          if (track.id === newTrackId) {
            return isMidi
              ? { ...track, midiClips: [...track.midiClips, updatedClip] }
              : { ...track, clips: [...track.clips, updatedClip] };
          }

          return track;
        });
        if (
          options.moveAutomation !== false
          && shouldMoveAutomationWithItems(
            current.moveEnvelopesWithItems,
            false,
            Boolean(current.lockSettings?.envelopes),
          )
        ) {
          tracks = moveAutomationPointsWithClips(
            tracks,
            [{
              clipId,
              sourceTrackId,
              targetTrackId: newTrackId,
              originalStartTime: found.clip.startTime,
              newStartTime: updatedClip.startTime,
              duration: found.clip.duration,
            }],
            oldTracks,
          );
        }
        return {
        tracks,
        ...(isMidi ? {
          midiEditorSessions: (current.midiEditorSessions || []).map((session) =>
            session.clipId === clipId
              ? { ...session, trackId: newTrackId, updatedAt: Date.now() }
              : session,
          ),
          ...(current.pianoRollClipId === clipId ? { pianoRollTrackId: newTrackId } : {}),
        } : {}),
        isModified: true,
      };
      });

      if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
      syncAutomationTrackSnapshots(oldTracks, get().tracks);

      // Apply auto-crossfades on affected audio track(s)
      if (!isMidi && get().autoCrossfade) {
        get().applyAutoCrossfades(newTrackId);
        if (sourceTrackId !== newTrackId) {
          get().applyAutoCrossfades(sourceTrackId);
        }
      }

      const newTracks = cloneTracksForTimelineUndo(get().tracks);
      const newMidiEditorSessions = (get().midiEditorSessions || []).map((session) => ({ ...session }));
      const newPianoRollTrackId = get().pianoRollTrackId;
      if (options.recordUndo === false) return;

      const applySnapshot = (tracks, sessions, pianoRollTrackId) => {
        const beforeApply = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({
          tracks: nextTracks,
          ...(isMidi ? {
            midiEditorSessions: sessions.map((session) => ({ ...session })),
            pianoRollTrackId,
          } : {}),
          isModified: true,
        });
        if (isMidi) syncMIDITracksForTimelineClips(get, nextTracks);
        syncAutomationTrackSnapshots(beforeApply, nextTracks);
        const syncResult = get().syncClipsWithBackend?.();
        if (syncResult?.catch) syncResult.catch(logBridgeError("move clip"));
      };
      commandManager.push({
        type: "MOVE_CLIP_TO_TRACK",
        description: sourceTrackId === newTrackId ? "Move clip" : "Move clip to track",
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, newMidiEditorSessions, newPianoRollTrackId),
        undo: () => applySnapshot(oldTracks, oldMidiEditorSessions, oldPianoRollTrackId),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    resizeClip: (clipId, newStartTime, newDuration, newOffset) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return;

      const isMidi = found.kind === "midi";
      const oldValues = {
        startTime: found.clip.startTime,
        duration: found.clip.duration,
        offset: found.clip.offset || 0,
        ...(isMidi ? { loopLength: found.clip.loopLength, sourceLength: found.clip.sourceLength } : {}),
      };
      const midiLoopLength = isMidi
        ? Math.max(0.01, found.clip.sourceLength || found.clip.loopLength || found.clip.duration || newDuration)
        : undefined;
      const nextValues = {
        startTime: Math.max(0, newStartTime),
        duration: Math.max(0.01, newDuration),
        offset: Math.max(0, newOffset || 0),
        ...(isMidi ? { loopLength: midiLoopLength, sourceLength: midiLoopLength } : {}),
      };

      const command: Command = {
        type: "RESIZE_CLIP",
        description: isMidi ? "Resize MIDI clip" : "Resize clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? {
                      ...clip,
                      ...nextValues,
                    }
                  : clip,
              ),
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId
                  ? {
                      ...clip,
                      ...nextValues,
                    }
                  : clip,
              ),
            })),
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    selectAdjacentClip: (direction) => {
      const state = get();
      const trackOrder = new Map(state.tracks.map((track, index) => [track.id, index]));
      const ordered = state.tracks.flatMap((track) => [
        ...track.clips.map((clip, index) => ({ clip, trackId: track.id, kindOrder: 0, index })),
        ...track.midiClips.map((clip, index) => ({ clip, trackId: track.id, kindOrder: 1, index })),
      ]).sort((left, right) => (
        left.clip.startTime - right.clip.startTime
        || (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0)
        || left.kindOrder - right.kindOrder
        || left.index - right.index
      ));
      const anchorId = state.selectedClipId
        && state.selectedClipIds.includes(state.selectedClipId)
        ? state.selectedClipId
        : state.selectedClipIds[0];
      if (!anchorId) return false;
      const currentIndex = ordered.findIndex((entry) => entry.clip.id === anchorId);
      const nextIndex = currentIndex + (direction === "next" ? 1 : -1);
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ordered.length) return false;
      get().selectClip(ordered[nextIndex].clip.id);
      return true;
    },

    stretchClip: async (clipId, newStartTime, newDuration) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return false;
      if (!Number.isFinite(newStartTime) || !Number.isFinite(newDuration)) return false;

      const targetStartTime = Math.max(0, newStartTime);
      const minimumDuration = found.kind === "midi" ? 0.01 : 0.1;
      const targetDuration = Math.max(minimumDuration, newDuration);
      const oldDuration = Math.max(0.000001, found.clip.duration || minimumDuration);
      const timeScale = targetDuration / oldDuration;

      if (
        Math.abs(targetStartTime - found.clip.startTime) <= 0.000001
        && Math.abs(targetDuration - found.clip.duration) <= 0.000001
      ) {
        return false;
      }

      const cloneClip = (clip) => found.kind === "midi"
        ? {
            ...clip,
            events: (clip.events || []).map((event) => ({ ...event })),
            ccEvents: clip.ccEvents?.map((event) => ({ ...event })),
            quantizeBackup: clip.quantizeBackup
              ? {
                  events: (clip.quantizeBackup.events || []).map((event) => ({ ...event })),
                  ccEvents: clip.quantizeBackup.ccEvents?.map((event) => ({ ...event })),
                }
              : undefined,
          }
        : {
            ...clip,
            gainEnvelope: clip.gainEnvelope?.map((point) => ({ ...point })),
          };

      const oldClip = cloneClip(found.clip);
      let newClip;

      if (found.kind === "midi") {
        newClip = createStretchedMIDIClip(oldClip, targetStartTime, targetDuration);
      } else {
        const playbackRateRatio = 1 / timeScale;
        let stretchResult;
        try {
          stretchResult = await nativeBridge.timeStretchClip(oldClip.filePath, playbackRateRatio);
        } catch (error) {
          console.error("[Timeline] Time-stretch processing failed:", error);
          get().showToast?.("Could not time-stretch the clip.", "error");
          return false;
        }

        if (!stretchResult?.success || !stretchResult.filePath) {
          get().showToast?.("Could not time-stretch the clip.", "error");
          return false;
        }

        // Processing is asynchronous. Never overwrite a clip that was edited,
        // moved, replaced, or deleted while the renderer was working.
        const liveFound = findTimelineClip(get(), clipId);
        if (!liveFound
            || liveFound.kind !== found.kind
            || liveFound.clip !== found.clip
            || isClipEditLocked(get(), liveFound.clip)) {
          get().showToast?.("The clip changed before time-stretching finished; no edit was applied.", "info");
          return false;
        }

        const oldRate = Number.isFinite(oldClip.playbackRate) && oldClip.playbackRate > 0
          ? oldClip.playbackRate
          : 1;
        const targetOffset = Math.max(0, (oldClip.offset || 0) * timeScale);
        const reportedSourceLength = Number(stretchResult.duration);
        const scaledSourceLength = Number.isFinite(oldClip.sourceLength)
          ? Math.max(0, oldClip.sourceLength * timeScale)
          : 0;
        const targetSourceLength = Math.max(
          targetOffset + targetDuration,
          Number.isFinite(reportedSourceLength) && reportedSourceLength > 0
            ? reportedSourceLength
            : scaledSourceLength,
        );

        newClip = {
          ...oldClip,
          filePath: stretchResult.filePath,
          originalFilePath: oldClip.originalFilePath || oldClip.filePath,
          playbackRate: oldRate * playbackRateRatio,
          startTime: targetStartTime,
          duration: targetDuration,
          offset: targetOffset,
          sourceLength: targetSourceLength,
          fadeIn: Math.min(targetDuration, Math.max(0, (oldClip.fadeIn || 0) * timeScale)),
          fadeOut: Math.min(targetDuration, Math.max(0, (oldClip.fadeOut || 0) * timeScale)),
          gainEnvelope: oldClip.gainEnvelope?.map((point) => ({
            ...point,
            time: Math.max(0, point.time * timeScale),
          })),
          sampleRate: stretchResult.sampleRate || oldClip.sampleRate,
          // Subsequent graphical pitch edits must use the stretched audio as
          // their immutable source, not pre-stretch material.
          pitchCorrectionSourceFilePath: undefined,
          pitchCorrectionSourceOffset: undefined,
        };

        void nativeBridge.refreshWaveformPeaks(stretchResult.filePath).catch(
          logBridgeError("refresh stretched waveform"),
        );
      }

      const capturedTrackId = found.trackId;
      const applyClip = (snapshot) => {
        set((current) => ({
          tracks: current.tracks.map((track) => track.id === capturedTrackId
            ? {
                ...track,
                clips: found.kind === "audio"
                  ? track.clips.map((clip) => clip.id === clipId ? cloneClip(snapshot) : clip)
                  : track.clips,
                midiClips: found.kind === "midi"
                  ? track.midiClips.map((clip) => clip.id === clipId ? cloneClip(snapshot) : clip)
                  : track.midiClips,
              }
            : track),
          isModified: true,
        }));

        if (found.kind === "midi") {
          const syncResult = get().syncMIDITrackToBackend?.(capturedTrackId, { debounce: false });
          if (syncResult?.catch) syncResult.catch(logBridgeError("sync stretched MIDI clip"));
        } else {
          const syncResult = get().syncClipsWithBackend?.();
          if (syncResult?.catch) syncResult.catch(logBridgeError("sync stretched audio clip"));
        }
      };

      applyClip(newClip);
      commandManager.push({
        type: "STRETCH_TIMELINE_CLIP",
        description: found.kind === "midi" ? "Stretch MIDI clip" : "Time-stretch audio clip",
        timestamp: Date.now(),
        execute: () => applyClip(newClip),
        undo: () => applyClip(oldClip),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
      return true;
    },

    setMIDIClipSourceWindow: (clipId, patch, description = "Edit MIDI clip source") => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "midi" || isClipEditLocked(state, found.clip)) return;

      const oldValues = {
        offset: found.clip.offset || 0,
        sourceLength: found.clip.sourceLength,
        loopLength: found.clip.loopLength,
        loopEnabled: found.clip.loopEnabled,
        loopOffset: found.clip.loopOffset,
      };
      const currentSourceLength = Math.max(
        0.01,
        found.clip.sourceLength || found.clip.loopLength || found.clip.duration || 0.01,
      );
      const nextSourceLength = Math.max(
        0.01,
        patch.sourceLength ?? patch.loopLength ?? currentSourceLength,
      );
      const visibleItemIsLooped = (found.clip.duration || 0) > nextSourceLength + 0.000001;
      const maxOffset = visibleItemIsLooped
        ? Math.max(0, nextSourceLength - 0.000001)
        : Math.max(0, nextSourceLength - (found.clip.duration || 0));
      const nextValues = {
        ...oldValues,
        ...patch,
        sourceLength: patch.sourceLength ?? oldValues.sourceLength ?? nextSourceLength,
        loopLength: patch.loopLength ?? patch.sourceLength ?? oldValues.loopLength ?? nextSourceLength,
        offset: Math.max(0, Math.min(maxOffset, patch.offset ?? oldValues.offset)),
      };
      if (
        nextValues.offset === oldValues.offset
        && nextValues.sourceLength === oldValues.sourceLength
        && nextValues.loopLength === oldValues.loopLength
        && nextValues.loopEnabled === oldValues.loopEnabled
        && nextValues.loopOffset === oldValues.loopOffset
      ) return false;

      const command: Command = {
        type: "EDIT_MIDI_SOURCE_WINDOW",
        description,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId ? { ...clip, ...nextValues } : clip,
              ),
            })),
            isModified: true,
          }));
          syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
            isModified: true,
          }));
          syncMIDITracksForTimelineClips(get, get().tracks);
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    toggleClipMute: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return false;
      const oldMuted = !!found.clip.muted;
      const isMidi = found.kind === "midi";

      const command: Command = {
        type: "TOGGLE_CLIP_MUTE",
        description: oldMuted ? "Unmute clip" : "Mute clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: !oldMuted } : clip,
              ),
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: !oldMuted } : clip,
              ),
            })),
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: oldMuted } : clip,
              ),
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: oldMuted } : clip,
              ),
            })),
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    setSelectedClipsMuted: (muted) => {
      const state = get();
      if (isClipEditLocked(state)) return false;
      const selectedIds = new Set(state.selectedClipIds);
      if (selectedIds.size === 0) return false;

      let touchedAudio = false;
      let touchedMIDI = false;
      const changedIds = new Set<string>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (selectedIds.has(clip.id) && !isClipEditLocked(state, clip) && !!clip.muted !== muted) {
            changedIds.add(clip.id);
            touchedAudio = true;
          }
        }
        for (const clip of track.midiClips) {
          if (selectedIds.has(clip.id) && !isClipEditLocked(state, clip) && !!clip.muted !== muted) {
            changedIds.add(clip.id);
            touchedMIDI = true;
          }
        }
      }
      if (changedIds.size === 0) return false;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const newTracks = cloneTracksForTimelineUndo(state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => changedIds.has(clip.id) ? { ...clip, muted } : clip),
        midiClips: track.midiClips.map((clip) => changedIds.has(clip.id) ? { ...clip, muted } : clip),
      })));
      const applySnapshot = (tracks, context) => {
        set({ tracks: cloneTracksForTimelineUndo(tracks), isModified: true });
        if (touchedAudio) syncClipPropertyEdit(get, `${context} audio clips`);
        if (touchedMIDI) syncMIDITracksForTimelineClips(get, get().tracks);
      };

      commandManager.execute({
        type: muted ? "MUTE_SELECTED_CLIPS" : "UNMUTE_SELECTED_CLIPS",
        description: `${muted ? "Mute" : "Unmute"} selected clips`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, muted ? "mute" : "unmute"),
        undo: () => applySnapshot(oldTracks, muted ? "undo mute" : "undo unmute"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    toggleSelectedClipsMuted: () => {
      const state = get();
      if (isClipEditLocked(state)) return false;
      const selectedIds = new Set(state.selectedClipIds);
      if (selectedIds.size === 0) return false;

      const changedIds = new Set<string>();
      let touchedAudio = false;
      let touchedMIDI = false;
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (selectedIds.has(clip.id) && !isClipEditLocked(state, clip)) {
            changedIds.add(clip.id);
            touchedAudio = true;
          }
        }
        for (const clip of track.midiClips) {
          if (selectedIds.has(clip.id) && !isClipEditLocked(state, clip)) {
            changedIds.add(clip.id);
            touchedMIDI = true;
          }
        }
      }
      if (changedIds.size === 0) return false;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const newTracks = cloneTracksForTimelineUndo(state.tracks.map((track: any) => ({
        ...track,
        clips: track.clips.map((clip: any) => changedIds.has(clip.id)
          ? { ...clip, muted: !clip.muted }
          : clip),
        midiClips: track.midiClips.map((clip: any) => changedIds.has(clip.id)
          ? { ...clip, muted: !clip.muted }
          : clip),
      })));
      const applySnapshot = (tracks: any[], context: string) => {
        set({ tracks: cloneTracksForTimelineUndo(tracks), isModified: true });
        if (touchedAudio) syncClipPropertyEdit(get, `${context} audio clips`);
        if (touchedMIDI) syncMIDITracksForTimelineClips(get, get().tracks);
      };

      commandManager.execute({
        type: "TOGGLE_SELECTED_CLIP_MUTE",
        description: "Toggle selected clip mute",
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, "toggle mute"),
        undo: () => applySnapshot(oldTracks, "undo toggle mute"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    toggleSelectedClipsLocked: () => {
      const state = get();
      if (state.globalLocked) return false;
      const selectedIds = new Set(state.selectedClipIds);
      if (selectedIds.size === 0) return false;

      let touchedMIDI = false;
      let foundAny = false;
      for (const track of state.tracks) {
        if (track.clips.some((clip: any) => selectedIds.has(clip.id))) foundAny = true;
        if (track.midiClips.some((clip: any) => selectedIds.has(clip.id))) {
          foundAny = true;
          touchedMIDI = true;
        }
      }
      if (!foundAny) return false;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const newTracks = cloneTracksForTimelineUndo(state.tracks.map((track: any) => ({
        ...track,
        clips: track.clips.map((clip: any) => selectedIds.has(clip.id)
          ? { ...clip, locked: !clip.locked }
          : clip),
        midiClips: track.midiClips.map((clip: any) => selectedIds.has(clip.id)
          ? { ...clip, locked: !clip.locked }
          : clip),
      })));
      const applySnapshot = (tracks: any[]) => {
        set({ tracks: cloneTracksForTimelineUndo(tracks), isModified: true });
        if (touchedMIDI) syncMIDITracksForTimelineClips(get, get().tracks);
      };

      commandManager.execute({
        type: "TOGGLE_SELECTED_CLIP_LOCK",
        description: "Toggle selected clip lock",
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks),
        undo: () => applySnapshot(oldTracks),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    setClipName: (clipId, name) => {
      if (typeof name !== "string") return;
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip) || found.clip.name === name) return;
      const oldName = found.clip.name;
      commandManager.execute({
        type: "SET_CLIP_NAME",
        description: "Rename clip",
        timestamp: Date.now(),
        execute: () => {
          applyTimelineClipName(set, get, clipId, name);
        },
        undo: () => {
          applyTimelineClipName(set, get, clipId, oldName);
        },
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    setClipVolume: (clipId, volumeDB) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "audio" || isClipEditLocked(state, found.clip) || !Number.isFinite(volumeDB)) return;
      const nextVolumeDB = Math.max(-60, Math.min(12, volumeDB));
      if (found.clip.volumeDB === nextVolumeDB) return;
      const editKey = "clipVol_" + clipId;
      const hadActiveEdit = _editSnapshots.has(editKey);
      if (!hadActiveEdit) get().beginClipVolumeEdit(clipId);
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, volumeDB: nextVolumeDB } : clip,
          ),
        })),
        isModified: true,
      }));
      if (!hadActiveEdit) get().commitClipVolumeEdit(clipId);
    },

    beginClipFadeEdit: (clipId) => {
      if (clipFadeEditSnapshots.has(clipId)) return;
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "audio" || isClipEditLocked(state, found.clip)) return;
      clipFadeEditSnapshots.set(clipId, {
        fadeIn: found.clip.fadeIn,
        fadeOut: found.clip.fadeOut,
      });
    },

    previewClipFades: (clipId, fadeIn, fadeOut) => {
      if (!clipFadeEditSnapshots.has(clipId)) return;
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return;
      applyClipFadeValues(set, get, clipId, fadeIn, fadeOut);
    },

    commitClipFadeEdit: (clipId) => {
      const oldValues = clipFadeEditSnapshots.get(clipId);
      clipFadeEditSnapshots.delete(clipId);
      if (!oldValues) return;
      const found = findTimelineClip(get(), clipId);
      if (!found || found.kind !== "audio") return;
      const newValues = {
        fadeIn: found.clip.fadeIn,
        fadeOut: found.clip.fadeOut,
      };
      if (
        oldValues.fadeIn === newValues.fadeIn
        && oldValues.fadeOut === newValues.fadeOut
      ) {
        return;
      }

      commandManager.push({
        type: "SET_CLIP_FADES",
        description: "Adjust clip fades",
        timestamp: Date.now(),
        execute: () => {
          if (applyClipFadeValues(
            set,
            get,
            clipId,
            newValues.fadeIn,
            newValues.fadeOut,
          )) {
            syncClipPropertyEdit(get, "redo clip fades");
          }
        },
        undo: () => {
          if (applyClipFadeValues(
            set,
            get,
            clipId,
            oldValues.fadeIn,
            oldValues.fadeOut,
          )) {
            syncClipPropertyEdit(get, "undo clip fades");
          }
        },
      });
      syncClipPropertyEdit(get, "clip fades");
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    cancelClipFadeEdit: (clipId) => {
      const oldValues = clipFadeEditSnapshots.get(clipId);
      clipFadeEditSnapshots.delete(clipId);
      if (!oldValues) return;
      if (applyClipFadeValues(
        set,
        get,
        clipId,
        oldValues.fadeIn,
        oldValues.fadeOut,
      )) {
        syncClipPropertyEdit(get, "cancel clip fades");
      }
    },

    setClipFades: (clipId, fadeIn, fadeOut) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "audio" || isClipEditLocked(state, found.clip)) return;
      const oldValues = { fadeIn: found.clip.fadeIn, fadeOut: found.clip.fadeOut };
      const newValues = normalizedClipFades(found.clip, fadeIn, fadeOut);
      if (
        oldValues.fadeIn === newValues.fadeIn
        && oldValues.fadeOut === newValues.fadeOut
      ) return;

      const command: Command = {
        type: "SET_CLIP_FADES",
        description: "Adjust clip fades",
        timestamp: Date.now(),
        execute: () => {
          if (applyClipFadeValues(
            set,
            get,
            clipId,
            newValues.fadeIn,
            newValues.fadeOut,
          )) {
            syncClipPropertyEdit(get, "clip fades");
          }
        },
        undo: () => {
          if (applyClipFadeValues(
            set,
            get,
            clipId,
            oldValues.fadeIn,
            oldValues.fadeOut,
          )) {
            syncClipPropertyEdit(get, "undo clip fades");
          }
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    addClipGainPoint: (clipId, time, gain) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "audio" || isClipEditLocked(state, found.clip)) return;
      const clampedGain = Math.max(0, Math.min(2, gain));
      const newPoint = { time, gain: clampedGain };

      const command: Command = {
        type: "ADD_CLIP_GAIN_POINT",
        description: "Add clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope, newPoint] : [newPoint];
                envelope.sort((a, b) => a.time - b.time);
                return { ...clip, gainEnvelope: envelope };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeClipGainPoint: (clipId, pointIndex) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "audio" || isClipEditLocked(state, found.clip)) return;
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      if (!oldEnvelope || pointIndex < 0 || pointIndex >= oldEnvelope.length) return;

      const command: Command = {
        type: "REMOVE_CLIP_GAIN_POINT",
        description: "Remove clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope] : [];
                envelope.splice(pointIndex, 1);
                return { ...clip, gainEnvelope: envelope.length > 0 ? envelope : undefined };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    moveClipGainPoint: (clipId, pointIndex, time, gain) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "audio" || isClipEditLocked(state, found.clip)) return;
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      if (!oldEnvelope || pointIndex < 0 || pointIndex >= oldEnvelope.length) return;

      const clampedGain = Math.max(0, Math.min(2, gain));

      const command: Command = {
        type: "MOVE_CLIP_GAIN_POINT",
        description: "Move clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope] : [];
                if (pointIndex < envelope.length) {
                  envelope[pointIndex] = { time, gain: clampedGain };
                  envelope.sort((a, b) => a.time - b.time);
                }
                return { ...clip, gainEnvelope: envelope };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    copyClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      const foundClip = found?.clip ?? null;
      const foundTrackId = found?.trackId ?? null;

      if (foundClip && foundTrackId) {
        const clip = cloneTimelineClipDeep(foundClip);
        set({ clipboard: {
          clip,
          clips: [{ clip, trackId: foundTrackId }],
          isCut: false,
          sourceRemoved: false,
          automationTracks: cloneClipboardAutomationTracks(state.tracks, new Set([foundTrackId])),
        } });
      }
    },

    cutClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.clip.locked || state.globalLocked || state.lockSettings?.items) return;
      set({ selectedClipId: clipId, selectedClipIds: [clipId] });
      get().cutSelectedClips();
    },

    copySelectedClips: () => {
      const state = get();
      const selectedIds = new Set<string>(
        state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [],
      );
      const clipEntries: Array<{ clip: AudioClip | MIDIClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (selectedIds.has(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
        for (const clip of track.midiClips) {
          if (selectedIds.has(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        const copiedEntries = clipEntries.map((entry) => ({
          ...entry,
          clip: cloneTimelineClipDeep(entry.clip),
        }));
        set({ clipboard: {
          clip: copiedEntries[0].clip,
          clips: copiedEntries,
          isCut: false,
          sourceRemoved: false,
          automationTracks: cloneClipboardAutomationTracks(
            state.tracks,
            new Set(copiedEntries.map((entry) => entry.trackId)),
          ),
        } });
      }
    },

    cutSelectedClips: () => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.items) return;
      const selectedIds = new Set<string>(
        state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [],
      );
      const clipEntries: Array<{ clip: AudioClip | MIDIClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (selectedIds.has(clip.id) && !clip.locked) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
        for (const clip of track.midiClips) {
          if (selectedIds.has(clip.id) && !clip.locked) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length === 0) return;

      const cutIds = new Set(clipEntries.map((entry) => entry.clip.id));
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const oldClipboard = cloneTimelineClipboard(state.clipboard);
      const selectionBefore = cloneSelectionSnapshot(state);
      const previousMIDIEditor = cloneMIDIEditorSnapshot(state);
      const deletedMIDIIds = new Set(
        clipEntries.filter((entry) => isMidiClipLike(entry.clip)).map((entry) => entry.clip.id),
      );
      const deletedAudioIds = new Set(
        clipEntries.filter((entry) => !isMidiClipLike(entry.clip)).map((entry) => entry.clip.id),
      );
      const clipboardEntries = clipEntries.map((entry) => ({
        ...entry,
        clip: cloneTimelineClipDeep(entry.clip),
      }));
      const nextClipboard = {
        clip: clipboardEntries[0].clip,
        clips: clipboardEntries,
        isCut: true,
        sourceRemoved: true,
        automationTracks: cloneClipboardAutomationTracks(
          oldTracks,
          new Set(clipboardEntries.map((entry) => entry.trackId)),
        ),
      };
      let newTracks = oldTracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !cutIds.has(clip.id)),
        midiClips: track.midiClips.filter((clip) => !cutIds.has(clip.id)),
      }));
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        newTracks = removeAutomationPointsWithClips(
          newTracks,
          clipEntries.map((entry) => ({
            sourceTrackId: entry.trackId,
            originalStartTime: entry.clip.startTime,
            duration: entry.clip.duration,
          })),
        );
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      const remainingSelection = selectionBefore.selectedClipIds.filter((id) => !cutIds.has(id));
      const selectionAfter = {
        ...selectionBefore,
        selectedClipIds: remainingSelection,
        selectedClipId: selectionBefore.selectedClipId && !cutIds.has(selectionBefore.selectedClipId)
          ? selectionBefore.selectedClipId
          : remainingSelection[remainingSelection.length - 1] || null,
      };
      const nextMIDIEditor = deletedMIDIIds.size > 0
        ? buildPostDeleteMIDIEditorState(previousMIDIEditor, deletedMIDIIds)
        : previousMIDIEditor;
      const undoMIDIEditor = deletedMIDIIds.size > 0
        ? buildSafeUndoMIDIEditorState(previousMIDIEditor, deletedMIDIIds)
        : previousMIDIEditor;
      const touchesAudio = deletedAudioIds.size > 0;
      const touchesMIDI = deletedMIDIIds.size > 0;
      const syncCut = (beforeTracks: any[], afterTracks: any[]) => {
        if (touchesAudio) {
          const result = get().syncClipsWithBackend?.();
          if (result?.catch) result.catch(logBridgeError("sync cut clips"));
        }
        if (touchesMIDI) syncMIDITracksForTimelineClips(get, afterTracks);
        syncAutomationTrackSnapshots(beforeTracks, afterTracks);
      };
      const apply = (
        tracks: any[],
        clipboard: any,
        selection: any,
        midiEditor: any,
        phase: "cut" | "undo",
      ) => {
        const beforeTracks = cloneTracksForTimelineUndo(get().tracks);
        if (phase === "cut") {
          closeDeletedWindowedMIDIEditors(previousMIDIEditor, deletedMIDIIds);
          if (get().showPitchEditor && deletedAudioIds.has(get().pitchEditorClipId)) {
            get().closePitchEditor?.();
          }
        }
        set({
          tracks: cloneTracksForTimelineUndo(tracks),
          clipboard: cloneTimelineClipboard(clipboard),
          ...selection,
          ...(midiEditor || {}),
          isModified: true,
        });
        syncCut(beforeTracks, tracks);
      };

      commandManager.execute({
        type: "CUT_CLIPS",
        description: `Cut ${clipEntries.length} clip${clipEntries.length === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => apply(newTracks, nextClipboard, selectionAfter, nextMIDIEditor, "cut"),
        undo: () => apply(oldTracks, oldClipboard, selectionBefore, undoMIDIEditor, "undo"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    copySelectedTimelineClips: () => {
      get().copySelectedClips();
    },

    pasteSelectedTimelineClips: () => {
      get().pasteClips();
    },

    pasteClip: (targetTrackId, targetTime) => {
      get().pasteClips(targetTrackId, targetTime);
    },

    pasteClips: (explicitTargetTrackId?: string, explicitTargetTime?: number) => {
      const state = get();
      const { clipboard } = state;
      if (state.globalLocked || state.lockSettings?.items || clipboard.clips.length === 0) return;
      const explicitTrack = explicitTargetTrackId
        ? state.tracks.find((track: any) => track.id === explicitTargetTrackId)
        : undefined;
      const pasteTargets = explicitTargetTrackId
        ? clipboard.clips.flatMap((entry: any) => {
            const isMidi = isMidiClipLike(entry.clip);
            return canTrackAcceptTimelineClip(explicitTrack, isMidi)
              ? [{ ...entry, targetTrackId: explicitTargetTrackId, isMidi }]
              : [];
          })
        : resolveTimelinePasteTargets(
            state.tracks,
            state.selectedTrackIds,
            clipboard.clips,
          );
      if (pasteTargets.length === 0) return;

      // Snapshot for undo
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const oldClipboard = cloneTimelineClipboard(clipboard);
      const selectionBefore = cloneSelectionSnapshot(state);

      const currentTime = explicitTargetTime ?? state.transport.currentTime;
      if (!Number.isFinite(currentTime)) return;
      const earliestTime = Math.min(...pasteTargets.map((entry) => entry.clip.startTime));
      if (!Number.isFinite(earliestTime)) return;
      const originalIds = new Set(pasteTargets.map((entry) => entry.clip.id));
      const shouldRemoveSources = clipboard.isCut && !clipboard.sourceRemoved;

      const pastedEntries = pasteTargets.map((entry) => {
        const clip = cloneTimelineClipDeep(entry.clip, true);
        return {
          clip: {
            ...clip,
            id: crypto.randomUUID(),
            startTime: Math.max(0, currentTime + (entry.clip.startTime - earliestTime)),
          },
          sourceClip: entry.clip,
          sourceTrackId: entry.trackId,
          targetTrackId: entry.targetTrackId,
          isMidi: entry.isMidi,
        };
      });

      const remainingCutEntries = clipboard.isCut
        ? clipboard.clips.filter((entry) => !originalIds.has(entry.clip.id))
        : clipboard.clips;
      const nextClipboard = clipboard.isCut
        ? {
            clip: remainingCutEntries[0]?.clip || null,
            clips: remainingCutEntries,
            isCut: remainingCutEntries.length > 0,
            sourceRemoved: remainingCutEntries.length > 0 && Boolean(clipboard.sourceRemoved),
            automationTracks: remainingCutEntries.length > 0
              ? clipboard.automationTracks
              : undefined,
          }
        : cloneTimelineClipboard(clipboard);

      set((s) => {
        let tracks = s.tracks;
        if (shouldRemoveSources) {
          tracks = tracks.map((track) => ({
            ...track,
            clips: track.clips.filter((clip) => !originalIds.has(clip.id)),
            midiClips: track.midiClips.filter((clip) => !originalIds.has(clip.id)),
          }));
        }

        tracks = tracks.map((track) => {
          const audioClips = pastedEntries
            .filter((entry) => entry.targetTrackId === track.id && !entry.isMidi)
            .map((entry) => entry.clip);
          const midiClips = pastedEntries
            .filter((entry) => entry.targetTrackId === track.id && entry.isMidi)
            .map((entry) => entry.clip);
          if (audioClips.length === 0 && midiClips.length === 0) return track;
          return {
            ...track,
            clips: [...track.clips, ...audioClips],
            midiClips: [...track.midiClips, ...midiClips],
          };
        });

        if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
          const automationMoves = pastedEntries.map((entry) => ({
            clipId: entry.sourceClip.id,
            sourceTrackId: entry.sourceTrackId,
            targetTrackId: entry.targetTrackId,
            originalStartTime: entry.sourceClip.startTime,
            newStartTime: entry.clip.startTime,
            duration: entry.sourceClip.duration,
          }));
          tracks = shouldRemoveSources
            ? moveAutomationPointsWithClips(tracks, automationMoves, oldTracks)
            : copyAutomationPointsWithClips(
                tracks,
                automationMoves,
                clipboard.automationTracks || oldTracks,
                !clipboard.isCut,
              );
        }

        return {
          tracks,
          clipboard: nextClipboard,
          selectedClipId: pastedEntries[pastedEntries.length - 1]?.clip.id || null,
          selectedClipIds: pastedEntries.map((entry) => entry.clip.id),
          selectedTrackId: null,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
          isModified: true,
        };
      });

      // Undo tracking (captures full state after paste)
      const afterState = get();
      const newTracksSnapshot = cloneTracksForTimelineUndo(afterState.tracks);
      const newClipboardSnapshot = cloneTimelineClipboard(afterState.clipboard);
      const selectionAfter = cloneSelectionSnapshot(afterState);
      const touchedMIDI = pastedEntries.some((entry) => entry.isMidi);
      const touchedAudio = pastedEntries.some((entry) => !entry.isMidi);
      if (touchedMIDI || pasteTargets.some((entry) => entry.isMidi)) {
        syncMIDITracksForTimelineClips(get, newTracksSnapshot);
      }
      if (touchedAudio) {
        const result = get().syncClipsWithBackend?.();
        if (result?.catch) result.catch(logBridgeError("sync pasted clips"));
      }
      syncAutomationTrackSnapshots(oldTracks, newTracksSnapshot);

      commandManager.push({
        type: "PASTE_CLIPS",
        description: "Paste clips",
        timestamp: Date.now(),
        execute: () => {
          const previousTracks = cloneTracksForTimelineUndo(get().tracks);
          set({
            tracks: cloneTracksForTimelineUndo(newTracksSnapshot),
            clipboard: cloneTimelineClipboard(newClipboardSnapshot),
            ...selectionAfter,
            isModified: true,
          });
          if (touchedMIDI) syncMIDITracksForTimelineClips(get, newTracksSnapshot);
          if (touchedAudio) {
            const result = get().syncClipsWithBackend?.();
            if (result?.catch) result.catch(logBridgeError("sync redone pasted clips"));
          }
          syncAutomationTrackSnapshots(previousTracks, newTracksSnapshot);
        },
        undo: () => {
          const previousTracks = cloneTracksForTimelineUndo(get().tracks);
          set({
            tracks: cloneTracksForTimelineUndo(oldTracks),
            clipboard: cloneTimelineClipboard(oldClipboard),
            ...selectionBefore,
            isModified: true,
          });
          if (touchedMIDI) syncMIDITracksForTimelineClips(get, oldTracks);
          if (touchedAudio) {
            const result = get().syncClipsWithBackend?.();
            if (result?.catch) result.catch(logBridgeError("sync undone pasted clips"));
          }
          syncAutomationTrackSnapshots(previousTracks, oldTracks);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    beginClipNudgeEdit: (clipId) => {
      if (clipNudgeEditSnapshots.has(clipId)) return;
      const state = get();
      const anchor = findTimelineClip(state, clipId);
      if (!anchor || isClipEditLocked(state, anchor.clip)) return;
      const selectionBefore = cloneSelectionSnapshot(state);
      get().selectClip(clipId);
      const selectedState = get();
      const selectionAfter = cloneSelectionSnapshot(selectedState);
      const positions = new Map<string, number>();
      let touchedMIDI = false;
      for (const track of selectedState.tracks) {
        for (const clip of track.clips) {
          if (selectedState.selectedClipIds.includes(clip.id) && !isClipEditLocked(selectedState, clip)) {
            positions.set(clip.id, clip.startTime);
          }
        }
        for (const clip of track.midiClips) {
          if (selectedState.selectedClipIds.includes(clip.id) && !isClipEditLocked(selectedState, clip)) {
            positions.set(clip.id, clip.startTime);
            touchedMIDI = true;
          }
        }
      }
      if (positions.size === 0) {
        set(selectionBefore);
        return;
      }
      clipNudgeEditSnapshots.set(clipId, {
        positions,
        tracksBefore: cloneTracksForTimelineUndo(selectedState.tracks),
        selectionBefore,
        selectionAfter,
        touchedMIDI,
      });
    },

    previewClipNudge: (clipId, direction, fine) => {
      const snapshot = clipNudgeEditSnapshots.get(clipId);
      if (!snapshot) return false;
      const state = get();
      if (isClipEditLocked(state)) return false;
      const amount = fine
        ? 0.01
        : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
      const delta = direction === "right" ? amount : -amount;
      const nextPositions = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of [...track.clips, ...track.midiClips]) {
          if (snapshot.positions.has(clip.id) && !isClipEditLocked(state, clip)) {
            nextPositions.set(clip.id, Math.max(0, clip.startTime + delta));
          }
        }
      }
      if (
        nextPositions.size !== snapshot.positions.size
        || Array.from(nextPositions).every(([clipIdKey, position]) => {
          const found = findTimelineClip(state, clipIdKey);
          return found?.clip.startTime === position;
        })
      ) {
        return false;
      }
      applyClipNudgePositions(
        set,
        get,
        nextPositions,
        snapshot.selectionAfter,
        snapshot.touchedMIDI,
      );
      return true;
    },

    commitClipNudgeEdit: (clipId) => {
      const snapshot = clipNudgeEditSnapshots.get(clipId);
      clipNudgeEditSnapshots.delete(clipId);
      if (!snapshot) return;
      const state = get();
      const newPositions = new Map<string, number>();
      for (const clipIdKey of snapshot.positions.keys()) {
        const found = findTimelineClip(state, clipIdKey);
        if (!found) {
          // A target disappearing mid-burst invalidates the exact transaction.
          // Restore every surviving target instead of leaving untracked preview
          // positions behind.
          const currentTracks = cloneTracksForTimelineUndo(get().tracks);
          set({
            tracks: cloneTracksForTimelineUndo(snapshot.tracksBefore),
            ...snapshot.selectionBefore,
            isModified: true,
          });
          syncAutomationTrackSnapshots(currentTracks, snapshot.tracksBefore);
          if (snapshot.touchedMIDI) syncMIDITracksForTimelineClips(get, snapshot.tracksBefore);
          return;
        }
        newPositions.set(clipIdKey, found.clip.startTime);
      }
      const changed = Array.from(snapshot.positions).some(
        ([clipIdKey, oldPosition]) => newPositions.get(clipIdKey) !== oldPosition,
      );
      if (!changed) {
        set(snapshot.selectionBefore);
        return;
      }

      const tracksAfter = cloneTracksForTimelineUndo(state.tracks);

      const applySnapshot = (
        tracks: any[],
        selection: ReturnType<typeof cloneSelectionSnapshot>,
      ) => {
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({ tracks: nextTracks, ...selection, isModified: true });
        syncAutomationTrackSnapshots(previousTracks, nextTracks);
        if (snapshot.touchedMIDI) syncMIDITracksForTimelineClips(get, nextTracks);
      };

      commandManager.push({
        type: "NUDGE_CLIPS",
        description: "Nudge clips",
        timestamp: Date.now(),
        execute: () => {
          applySnapshot(tracksAfter, snapshot.selectionAfter);
        },
        undo: () => {
          applySnapshot(snapshot.tracksBefore, snapshot.selectionBefore);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    nudgeClips: (direction, fine) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.items) return;
      const selectedIds = new Set<string>(
        state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [],
      );
      if (selectedIds.size === 0) return;

      const amount = fine
        ? 0.01 // 10ms fine nudge
        : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
      const delta = direction === "right" ? amount : -amount;

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      let touchedMIDI = false;
      let touchedAudio = false;
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (selectedIds.has(clip.id) && !clip.locked) {
            clipPositions.set(clip.id, clip.startTime);
            touchedAudio = true;
          }
        }
        for (const clip of track.midiClips) {
          if (selectedIds.has(clip.id) && !clip.locked) {
            clipPositions.set(clip.id, clip.startTime);
            touchedMIDI = true;
          }
        }
      }
      if (
        clipPositions.size === 0
        || Array.from(clipPositions.values()).every((startTime) =>
          Math.max(0, startTime + delta) === startTime,
        )
      ) return;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      let newTracks = state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clipPositions.has(clip.id)
              ? { ...clip, startTime: Math.max(0, clipPositions.get(clip.id)! + delta) }
              : clip,
          ),
          midiClips: track.midiClips.map((clip) =>
            clipPositions.has(clip.id)
              ? { ...clip, startTime: Math.max(0, clipPositions.get(clip.id)! + delta) }
              : clip,
          ),
        }));
      if (shouldMoveAutomationWithItems(
        state.moveEnvelopesWithItems,
        false,
        Boolean(state.lockSettings?.envelopes),
      )) {
        const moves: AutomationClipMove[] = [];
        for (const [clipId, oldStart] of clipPositions) {
          const found = findTimelineClip(state, clipId);
          if (!found) continue;
          moves.push({
            clipId,
            sourceTrackId: found.trackId,
            targetTrackId: found.trackId,
            originalStartTime: oldStart,
            newStartTime: Math.max(0, oldStart + delta),
            duration: found.clip.duration,
          });
        }
        newTracks = moveAutomationPointsWithClips(newTracks, moves, oldTracks);
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      set({ tracks: newTracks, isModified: true });
      syncAutomationTrackSnapshots(oldTracks, newTracks);
      if (touchedMIDI) {
        syncMIDITracksForTimelineClips(get, get().tracks);
      }
      if (touchedAudio) {
        const result = get().syncClipsWithBackend?.();
        if (result?.catch) result.catch(logBridgeError("sync nudged clips"));
      }

      const command: Command = {
        type: "NUDGE_CLIPS",
        description: `Nudge clips ${direction}`,
        timestamp: Date.now(),
        execute: () => {
          const previousTracks = cloneTracksForTimelineUndo(get().tracks);
          set({ tracks: cloneTracksForTimelineUndo(newTracks), isModified: true });
          syncAutomationTrackSnapshots(previousTracks, newTracks);
          if (touchedMIDI) syncMIDITracksForTimelineClips(get, newTracks);
          if (touchedAudio) {
            const result = get().syncClipsWithBackend?.();
            if (result?.catch) result.catch(logBridgeError("sync redone clip nudge"));
          }
        },
        undo: () => {
          const previousTracks = cloneTracksForTimelineUndo(get().tracks);
          set({ tracks: cloneTracksForTimelineUndo(oldTracks), isModified: true });
          syncAutomationTrackSnapshots(previousTracks, oldTracks);
          if (touchedMIDI) syncMIDITracksForTimelineClips(get, oldTracks);
          if (touchedAudio) {
            const result = get().syncClipsWithBackend?.();
            if (result?.catch) result.catch(logBridgeError("sync undone clip nudge"));
          }
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return;
      const foundClip = found.clip;
      const foundTrackId = found.trackId;
      const isMidi = found.kind === "midi";
      const deletedDuration = foundClip.duration;
      const deletedEnd = foundClip.startTime + deletedDuration;
      const deletedClipIds = new Set([clipId]);
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      let newTracks = oldTracks.map((track: any) => {
        let clips = track.clips.filter((clip: any) => clip.id !== clipId);
        let midiClips = track.midiClips.filter((clip: any) => clip.id !== clipId);
        const shouldRipple = state.rippleMode === "all_tracks"
          || (state.rippleMode === "per_track" && track.id === foundTrackId);
        if (shouldRipple) {
          clips = clips.map((clip: any) => !clip.locked && clip.startTime >= deletedEnd
            ? { ...clip, startTime: Math.max(0, clip.startTime - deletedDuration) }
            : clip);
          midiClips = midiClips.map((clip: any) => !clip.locked && clip.startTime >= deletedEnd
            ? { ...clip, startTime: Math.max(0, clip.startTime - deletedDuration) }
            : clip);
        }
        return { ...track, clips, midiClips };
      });
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        const rippleMoves: AutomationClipMove[] = [];
        for (const oldTrack of oldTracks) {
          for (const oldClip of [...oldTrack.clips, ...oldTrack.midiClips]) {
            if (oldClip.id === clipId) continue;
            const moved = findTimelineClip({ tracks: newTracks }, oldClip.id);
            if (!moved || moved.clip.startTime === oldClip.startTime) continue;
            rippleMoves.push({
              clipId: oldClip.id,
              sourceTrackId: oldTrack.id,
              targetTrackId: moved.trackId,
              originalStartTime: oldClip.startTime,
              newStartTime: moved.clip.startTime,
              duration: oldClip.duration,
            });
          }
        }
        newTracks = moveAutomationPointsWithClips(newTracks, rippleMoves, oldTracks);
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      const selectionBefore = cloneSelectionSnapshot(state);
      const remainingSelection = selectionBefore.selectedClipIds.filter((id: string) => id !== clipId);
      const selectionAfter = {
        ...selectionBefore,
        selectedClipIds: remainingSelection,
        selectedClipId: selectionBefore.selectedClipId === clipId
          ? (remainingSelection[remainingSelection.length - 1] || null)
          : selectionBefore.selectedClipId,
      };
      const previousMidiEditorState = isMidi ? cloneMIDIEditorSnapshot(state) : null;
      const nextMidiEditorState = previousMidiEditorState
        ? buildPostDeleteMIDIEditorState(previousMidiEditorState, deletedClipIds)
        : null;
      const undoMidiEditorState = previousMidiEditorState
        ? buildSafeUndoMIDIEditorState(previousMidiEditorState, deletedClipIds)
        : null;
      const ownsPitchEditor = found.kind === "audio"
        && state.showPitchEditor
        && state.pitchEditorClipId === clipId;
      const applySnapshot = (
        tracks: any[],
        selection: any,
        midiEditorState: any,
        phase: "delete" | "restore",
      ) => {
        if (phase === "delete") {
          if (previousMidiEditorState) closeDeletedWindowedMIDIEditors(previousMidiEditorState, deletedClipIds);
          if (ownsPitchEditor && get().showPitchEditor && get().pitchEditorClipId === clipId) {
            get().closePitchEditor?.();
          }
        }
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({
          tracks: nextTracks,
          ...selection,
          ...(midiEditorState || {}),
          isModified: true,
        });
        if (isMidi) syncMIDITracksForTimelineClips(get, nextTracks);
        else syncClipPropertyEdit(get, phase === "delete" ? "delete audio clip" : "restore audio clip");
        syncAutomationTrackSnapshots(previousTracks, nextTracks);
      };

      commandManager.execute({
        type: "DELETE_CLIP",
        description: `Delete clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, nextMidiEditorState, "delete"),
        undo: () => applySnapshot(oldTracks, selectionBefore, undoMidiEditorState, "restore"),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
      return true;
    },

    deleteSelectedClips: () => {
      const state = get();
      if (isClipEditLocked(state)) return false;
      const requestedIds = [...new Set<string>(state.selectedClipIds)];
      if (requestedIds.length === 0) return false;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      let newTracks = cloneTracksForTimelineUndo(state.tracks);
      const deletedIds = new Set<string>();
      let touchedAudio = false;
      let touchedMIDI = false;

      // Apply the existing single-item ripple contract to one isolated working
      // snapshot. History and backend synchronization happen only once for the
      // complete key gesture.
      for (const clipId of requestedIds) {
        const found = findTimelineClip({ tracks: newTracks }, clipId);
        if (!found || found.clip.locked) continue;
        const deletedDuration = found.clip.duration;
        const deletedEnd = found.clip.startTime + deletedDuration;
        deletedIds.add(clipId);
        if (found.kind === "midi") touchedMIDI = true;
        else touchedAudio = true;

        newTracks = newTracks.map((track: any) => {
          let clips = track.clips.filter((clip: any) => clip.id !== clipId);
          let midiClips = track.midiClips.filter((clip: any) => clip.id !== clipId);
          const shouldRipple = state.rippleMode === "all_tracks"
            || (state.rippleMode === "per_track" && track.id === found.trackId);
          if (shouldRipple) {
            clips = clips.map((clip: any) => !clip.locked && clip.startTime >= deletedEnd
              ? { ...clip, startTime: Math.max(0, clip.startTime - deletedDuration) }
              : clip);
            midiClips = midiClips.map((clip: any) => !clip.locked && clip.startTime >= deletedEnd
              ? { ...clip, startTime: Math.max(0, clip.startTime - deletedDuration) }
              : clip);
          }
          return { ...track, clips, midiClips };
        });
      }
      if (deletedIds.size === 0) return false;

      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        // "Move envelopes with items" follows move/copy operations. Deleting
        // an item does not itself delete timeline automation inside its former
        // bounds; only surviving items displaced by ripple carry their points.
        const rippleMoves: AutomationClipMove[] = [];
        for (const oldTrack of oldTracks) {
          for (const oldClip of [...oldTrack.clips, ...oldTrack.midiClips]) {
            if (deletedIds.has(oldClip.id)) continue;
            const moved = findTimelineClip({ tracks: newTracks }, oldClip.id);
            if (!moved || moved.clip.startTime === oldClip.startTime) continue;
            rippleMoves.push({
              clipId: oldClip.id,
              sourceTrackId: oldTrack.id,
              targetTrackId: moved.trackId,
              originalStartTime: oldClip.startTime,
              newStartTime: moved.clip.startTime,
              duration: oldClip.duration,
            });
          }
        }
        newTracks = moveAutomationPointsWithClips(newTracks, rippleMoves, oldTracks);
      }

      const selectionBefore = cloneSelectionSnapshot(state);
      const remainingSelectedIds = selectionBefore.selectedClipIds.filter(
        (id: string) => !deletedIds.has(id),
      );
      const selectionAfter = {
        ...selectionBefore,
        selectedClipIds: remainingSelectedIds,
        selectedClipId: selectionBefore.selectedClipId && !deletedIds.has(selectionBefore.selectedClipId)
          ? selectionBefore.selectedClipId
          : (remainingSelectedIds[remainingSelectedIds.length - 1] || null),
      };
      const midiEditorBefore = cloneMIDIEditorSnapshot(state);
      const midiEditorAfter = touchedMIDI
        ? buildPostDeleteMIDIEditorState(midiEditorBefore, deletedIds)
        : midiEditorBefore;
      const midiEditorUndo = touchedMIDI
        ? buildSafeUndoMIDIEditorState(midiEditorBefore, deletedIds)
        : midiEditorBefore;
      const ownsPitchEditor = touchedAudio
        && state.showPitchEditor
        && deletedIds.has(state.pitchEditorClipId);

      const applySnapshot = (
        tracks: any[],
        selection: ReturnType<typeof cloneSelectionSnapshot>,
        midiEditor: ReturnType<typeof cloneMIDIEditorSnapshot>,
        context: string,
        phase: "delete" | "restore",
      ) => {
        if (phase === "delete") {
          if (touchedMIDI) closeDeletedWindowedMIDIEditors(midiEditorBefore, deletedIds);
          if (ownsPitchEditor
              && get().showPitchEditor
              && deletedIds.has(get().pitchEditorClipId)) {
            get().closePitchEditor?.();
          }
        }
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        set({
          tracks: cloneTracksForTimelineUndo(tracks),
          ...selection,
          ...midiEditor,
          isModified: true,
        });
        syncAutomationTrackSnapshots(previousTracks, tracks);
        if (touchedAudio) syncClipPropertyEdit(get, `${context} audio clips`);
        if (touchedMIDI) syncMIDITracksForTimelineClips(get, get().tracks);
      };

      commandManager.execute({
        type: "DELETE_SELECTED_CLIPS",
        description: `Delete ${deletedIds.size} selected clip${deletedIds.size === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, midiEditorAfter, "delete selected", "delete"),
        undo: () => applySnapshot(oldTracks, selectionBefore, midiEditorUndo, "undo delete selected", "restore"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    duplicateClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return;
      const foundClip = found.clip;
      const foundTrackId = found.trackId;
      const isMidi = found.kind === "midi";
      const newClipId = crypto.randomUUID();
      const newClip = {
        ...cloneTimelineClipDeep(foundClip, true),
        id: newClipId,
        startTime: foundClip.startTime + foundClip.duration,
      };
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      let newTracks = oldTracks.map((track: any) => track.id === foundTrackId
        ? isMidi
          ? { ...track, midiClips: [...track.midiClips, newClip] }
          : { ...track, clips: [...track.clips, newClip] }
        : track);
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        newTracks = copyAutomationPointsWithClips(newTracks, [{
          clipId,
          sourceTrackId: foundTrackId,
          targetTrackId: foundTrackId,
          originalStartTime: foundClip.startTime,
          newStartTime: newClip.startTime,
          duration: foundClip.duration,
        }], oldTracks);
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      const selectionBefore = cloneSelectionSnapshot(state);
      const selectionAfter = {
        ...selectionBefore,
        selectedClipId: newClipId,
        selectedClipIds: [newClipId],
      };
      const applySnapshot = (tracks: any[], selection: any, context: string) => {
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({ tracks: nextTracks, ...selection, isModified: true });
        if (isMidi) syncMIDITracksForTimelineClips(get, nextTracks);
        else syncClipPropertyEdit(get, context);
        syncAutomationTrackSnapshots(previousTracks, nextTracks);
      };

      commandManager.execute({
        type: "DUPLICATE_CLIP",
        description: `Duplicate clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, "duplicate audio clip"),
        undo: () => applySnapshot(oldTracks, selectionBefore, "undo duplicate audio clip"),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
      return newClipId;
    },

    duplicateSelectedClips: () => {
      const state = get();
      if (isClipEditLocked(state)) return [];
      const requestedIds = [...new Set<string>(state.selectedClipIds)];
      if (requestedIds.length === 0) return [];

      const sources = requestedIds.flatMap((clipId) => {
        const found = findTimelineClip(state, clipId);
        return found && !isClipEditLocked(state, found.clip) ? [found] : [];
      });
      if (sources.length === 0) return [];

      const selectionBefore = cloneSelectionSnapshot(state);
      const duplicates = sources.map((found: any) => ({
        trackId: found.trackId,
        kind: found.kind,
        clip: {
          ...cloneTimelineClipDeep(found.clip, true),
          id: crypto.randomUUID(),
          startTime: found.clip.startTime + found.clip.duration,
        },
      }));
      const newIds = duplicates.map((entry: any) => entry.clip.id);
      const touchedAudio = duplicates.some((entry: any) => entry.kind === "audio");
      const touchedMIDI = duplicates.some((entry: any) => entry.kind === "midi");
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      let newTracks = oldTracks.map((track: any) => {
        const additions = duplicates.filter((entry: any) => entry.trackId === track.id);
        if (additions.length === 0) return track;
        return {
          ...track,
          clips: [
            ...track.clips,
            ...additions.filter((entry: any) => entry.kind === "audio").map((entry: any) => entry.clip),
          ],
          midiClips: [
            ...track.midiClips,
            ...additions.filter((entry: any) => entry.kind === "midi").map((entry: any) => entry.clip),
          ],
        };
      });
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        newTracks = copyAutomationPointsWithClips(newTracks, sources.map((found: any, index: number) => ({
          clipId: found.clip.id,
          sourceTrackId: found.trackId,
          targetTrackId: duplicates[index].trackId,
          originalStartTime: found.clip.startTime,
          newStartTime: duplicates[index].clip.startTime,
          duration: found.clip.duration,
        })), oldTracks);
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      const selectionAfter = {
        ...selectionBefore,
        selectedClipId: newIds[newIds.length - 1] || null,
        selectedClipIds: newIds,
      };
      const applySnapshot = (tracks: any[], selection: any, context: string) => {
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({ tracks: nextTracks, ...selection, isModified: true });
        if (touchedAudio) syncClipPropertyEdit(get, context);
        if (touchedMIDI) syncMIDITracksForTimelineClips(get, nextTracks);
        syncAutomationTrackSnapshots(previousTracks, nextTracks);
      };

      commandManager.execute({
        type: "DUPLICATE_SELECTED_CLIPS",
        description: `Duplicate ${duplicates.length} selected clip${duplicates.length === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, "duplicate selected audio clips"),
        undo: () => applySnapshot(oldTracks, selectionBefore, "undo duplicate selected audio clips"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return newIds;
    },

    duplicateClipToPosition: (clipId, targetTrackId, targetStartTime) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      const targetTrack = state.tracks.find((track: any) => track.id === targetTrackId);
      if (!found
          || !targetTrack
          || isClipEditLocked(state, found.clip)
          || !Number.isFinite(targetStartTime)) return null;

      const isMidi = found.kind === "midi";
      if (isMidi && targetTrack.type !== "midi" && targetTrack.type !== "instrument") return null;
      if (!isMidi && (targetTrack.type === "midi" || targetTrack.type === "instrument")) return null;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const selectionBefore = cloneSelectionSnapshot(state);
      const newClipId = crypto.randomUUID();
      const newClip = {
        ...cloneTimelineClipDeep(found.clip, true),
        id: newClipId,
        startTime: Math.max(0, targetStartTime),
        color: targetTrack.color || found.clip.color,
      };
      let newTracks = oldTracks.map((track: any) => track.id === targetTrackId
        ? isMidi
          ? { ...track, midiClips: [...track.midiClips, newClip] }
          : { ...track, clips: [...track.clips, newClip] }
        : track);
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        newTracks = copyAutomationPointsWithClips(newTracks, [{
          clipId,
          sourceTrackId: found.trackId,
          targetTrackId,
          originalStartTime: found.clip.startTime,
          newStartTime: newClip.startTime,
          duration: found.clip.duration,
        }], oldTracks);
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      const selectionAfter = {
        ...selectionBefore,
        selectedClipId: newClipId,
        selectedClipIds: [newClipId],
      };
      const applySnapshot = (tracks: any[], selection: any, context: string) => {
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({ tracks: nextTracks, ...selection, isModified: true });
        if (isMidi) syncMIDITracksForTimelineClips(get, nextTracks);
        else syncClipPropertyEdit(get, context);
        syncAutomationTrackSnapshots(previousTracks, nextTracks);
      };

      commandManager.execute({
        type: "DUPLICATE_CLIP_TO_POSITION",
        description: isMidi ? "Copy MIDI clip" : "Copy clip",
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, "copy audio clip"),
        undo: () => applySnapshot(oldTracks, selectionBefore, "undo copy audio clip"),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
      return newClipId;
    },

    repeatClip: (clipId, repeatCount = 3) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || isClipEditLocked(state, found.clip)) return;

      const count = Math.max(1, Math.min(128, Math.floor(Number(repeatCount) || 1)));
      const isMidi = found.kind === "midi";
      const newClips = Array.from({ length: count }, (_, index) => ({
        ...cloneTimelineClipDeep(found.clip, true),
        id: crypto.randomUUID(),
        startTime: found.clip.startTime + found.clip.duration * (index + 1),
      }));
      const newIds = newClips.map((clip) => clip.id);
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      let newTracks = oldTracks.map((track: any) => track.id === found.trackId
        ? isMidi
          ? { ...track, midiClips: [...track.midiClips, ...newClips] }
          : { ...track, clips: [...track.clips, ...newClips] }
        : track);
      if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
        newTracks = copyAutomationPointsWithClips(newTracks, newClips.map((clip: any) => ({
          clipId,
          sourceTrackId: found.trackId,
          targetTrackId: found.trackId,
          originalStartTime: found.clip.startTime,
          newStartTime: clip.startTime,
          duration: found.clip.duration,
        })), oldTracks);
      }
      newTracks = cloneTracksForTimelineUndo(newTracks);
      const selectionBefore = cloneSelectionSnapshot(state);
      const selectionAfter = {
        ...selectionBefore,
        selectedClipId: newIds[newIds.length - 1],
        selectedClipIds: newIds,
      };
      const applySnapshot = (tracks: any[], selection: any, context: string) => {
        const previousTracks = cloneTracksForTimelineUndo(get().tracks);
        const nextTracks = cloneTracksForTimelineUndo(tracks);
        set({ tracks: nextTracks, ...selection, isModified: true });
        if (isMidi) syncMIDITracksForTimelineClips(get, nextTracks);
        else syncClipPropertyEdit(get, context);
        syncAutomationTrackSnapshots(previousTracks, nextTracks);
      };

      commandManager.execute({
        type: "REPEAT_CLIP",
        description: `Repeat clip ${count} time${count === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, "repeat audio clip"),
        undo: () => applySnapshot(oldTracks, selectionBefore, "undo repeat audio clip"),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    // ========== Advanced Clip Editing ==========
    splitAtTimeSelection: () => {
      const state = get();
      const { timeSelection } = state;
      if (!timeSelection) return;
      const splitTimes = [
        Math.min(timeSelection.start, timeSelection.end),
        Math.max(timeSelection.start, timeSelection.end),
      ];
      if (!splitTimes.every(Number.isFinite) || splitTimes[1] - splitTimes[0] <= SPLIT_TIME_EPSILON) {
        return;
      }
      const targets = resolveTimelineSplitTargetsAtTimes(state, splitTimes);
      const splitData = targets.map((entry: any) => createTimelineSplitAtTimes(entry, splitTimes));
      commitTimelineSplit(
        set,
        get,
        splitData,
        `Split ${splitData.length} clip${splitData.length === 1 ? "" : "s"} at time selection`,
      );
    },

    groupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length < 2 || isClipEditLocked(state)) return false;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of [...track.clips, ...track.midiClips]) {
          if (state.selectedClipIds.includes(clip.id) && !isClipEditLocked(state, clip)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }
      if (oldGroupIds.size < 2) return false;

      const groupId = crypto.randomUUID();
      const applyGroupIds = (restore: boolean) => set((current: any) => ({
        tracks: current.tracks.map((track: any) => {
          const apply = (clip: any) => {
            if (!oldGroupIds.has(clip.id)) return clip;
            return {
              ...clip,
              groupId: restore ? oldGroupIds.get(clip.id) : groupId,
            };
          };
          return {
            ...track,
            clips: track.clips.map(apply),
            midiClips: track.midiClips.map(apply),
          };
        }),
        isModified: true,
      }));

      commandManager.execute({
        type: "GROUP_CLIPS",
        description: "Group selected clips",
        timestamp: Date.now(),
        execute: () => applyGroupIds(false),
        undo: () => applyGroupIds(true),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    ungroupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0 || isClipEditLocked(state)) return false;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of [...track.clips, ...track.midiClips]) {
          if (state.selectedClipIds.includes(clip.id)
              && !isClipEditLocked(state, clip)
              && clip.groupId !== undefined) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }
      if (oldGroupIds.size === 0) return false;

      const applyGroupIds = (restore: boolean) => set((current: any) => ({
        tracks: current.tracks.map((track: any) => {
          const apply = (clip: any) => oldGroupIds.has(clip.id)
            ? { ...clip, groupId: restore ? oldGroupIds.get(clip.id) : undefined }
            : clip;
          return {
            ...track,
            clips: track.clips.map(apply),
            midiClips: track.midiClips.map(apply),
          };
        }),
        isModified: true,
      }));

      commandManager.execute({
        type: "UNGROUP_CLIPS",
        description: "Ungroup selected clips",
        timestamp: Date.now(),
        execute: () => applyGroupIds(false),
        undo: () => applyGroupIds(true),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    normalizeSelectedClips: async () => {
      const state = get();
      if (isClipEditLocked(state)) return false;
      const selectedIds = new Set(
        state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [],
      );
      if (selectedIds.size === 0) return false;

      const requestId = nextClipNormalizationRequestId++;
      const pending: PendingClipNormalization[] = [];
      for (const track of state.tracks) {
        if (track.frozen) continue;
        for (const clip of track.clips) {
          if (!selectedIds.has(clip.id) || !isClipEligibleForPeakNormalization(clip)) continue;
          currentClipNormalizationRequests.set(clip.id, requestId);
          pending.push({
            clipId: clip.id,
            trackId: track.id,
            clipReference: clip,
            filePath: clip.filePath,
            offset: clip.offset,
            duration: clip.duration,
            volumeDB: clip.volumeDB,
            requestId,
          });
        }
      }
      if (pending.length === 0) return false;

      const analyses = await Promise.all(pending.map(async (request) => {
        try {
          const peak = await nativeBridge.getAudioPeakAmplitude(
            request.filePath,
            request.offset,
            request.duration,
          );
          return { request, peak };
        } catch {
          return { request, peak: null };
        }
      }));

      const changes = new Map<string, ClipNormalizationVolumeChange>();
      for (const { request, peak } of analyses) {
        const isCurrentRequest = currentClipNormalizationRequests.get(request.clipId)
          === request.requestId;
        if (isCurrentRequest) currentClipNormalizationRequests.delete(request.clipId);
        if (!isCurrentRequest || peak === null || !Number.isFinite(peak) || peak <= 0) continue;

        const currentState = get();
        const currentSelectedIds = new Set(
          currentState.selectedClipIds.length > 0
            ? currentState.selectedClipIds
            : currentState.selectedClipId ? [currentState.selectedClipId] : [],
        );
        const found = findTimelineClip(currentState, request.clipId);
        if (!found
          || found.kind !== "audio"
          || found.track.frozen
          || !currentSelectedIds.has(request.clipId)
          || found.trackId !== request.trackId
          || found.clip !== request.clipReference
          || isClipEditLocked(currentState, found.clip)
          || found.clip.filePath !== request.filePath
          || found.clip.offset !== request.offset
          || found.clip.duration !== request.duration
          || found.clip.volumeDB !== request.volumeDB) {
          continue;
        }

        const normalizedVolumeDB = Math.max(
          CLIP_GAIN_MIN_DB,
          Math.min(CLIP_GAIN_MAX_DB, -20 * Math.log10(peak)),
        );
        if (!Number.isFinite(normalizedVolumeDB)
          || Math.abs(normalizedVolumeDB - request.volumeDB) <= 1e-9) {
          continue;
        }
        changes.set(request.clipId, {
          oldVolumeDB: request.volumeDB,
          newVolumeDB: normalizedVolumeDB,
        });
      }

      if (changes.size === 0) return false;

      commandManager.execute({
        type: "NORMALIZE_CLIPS",
        description: changes.size === 1
          ? "Normalize selected clip"
          : `Normalize ${changes.size} selected clips`,
        timestamp: Date.now(),
        execute: () => applyClipNormalizationVolumes(set, get, changes, "new"),
        undo: () => applyClipNormalizationVolumes(set, get, changes, "old"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },


});

// ========== Quantize Clips (appended) ==========
