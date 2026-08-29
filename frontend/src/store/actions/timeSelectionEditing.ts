/**
 * Atomic timeline time-selection edits.
 *
 * These actions intentionally live after the legacy inline store actions so
 * every caller (shortcut, menu, command palette, or pointer UI) gets the same
 * mixed audio/MIDI, lock-aware, undoable behavior.
 */

import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { isMIDIClipboardClip } from "../../utils/timelineClipboard";
import { commandManager } from "../commands";
import type { Marker, Region } from "../useDAWStore";
import {
  buildPostDeleteMIDIEditorState,
  buildSafeUndoMIDIEditorState,
  cloneClipboardAutomationTracks,
  cloneMIDIEditorSnapshot,
  cloneSelectionSnapshot,
  cloneTimelineClipDeep,
  cloneTimelineClipboard,
  cloneTracksForTimelineUndo,
  closeDeletedWindowedMIDIEditors,
  removeAutomationPointsWithClips,
  syncAutomationTrackSnapshots,
  syncMIDITracksForTimelineClips,
} from "./clipEditing";

type SetFn = (...args: any[]) => void;
type GetFn = () => any;

const TIME_EDIT_EPSILON = 0.000001;

export interface NormalizedTimelineTimeSelection {
  start: number;
  end: number;
  duration: number;
}

interface NormalizedRazorEdit extends NormalizedTimelineTimeSelection {
  trackId: string;
}

export function getNormalizedTimelineTimeSelection(
  state: any,
): NormalizedTimelineTimeSelection | null {
  const selection = state?.timeSelection;
  if (!selection
      || !Number.isFinite(selection.start)
      || !Number.isFinite(selection.end)) {
    return null;
  }
  const start = Math.max(0, Math.min(selection.start, selection.end));
  const end = Math.max(0, Math.max(selection.start, selection.end));
  if (end - start <= TIME_EDIT_EPSILON) return null;
  return { start, end, duration: end - start };
}

function isTimelineClipMutable(state: any, track: any, clip: any) {
  return !state.globalLocked
    && !state.lockSettings?.items
    && !track?.frozen
    && !clip?.locked;
}

function clipOverlapsRange(clip: any, start: number, end: number) {
  const clipStart = Number(clip?.startTime);
  const clipDuration = Number(clip?.duration);
  if (!Number.isFinite(clipStart)
      || !Number.isFinite(clipDuration)
      || clipDuration <= TIME_EDIT_EPSILON) {
    return false;
  }
  const clipEnd = clipStart + clipDuration;
  return clipStart < end - TIME_EDIT_EPSILON
    && clipEnd > start + TIME_EDIT_EPSILON;
}

function cloneTimeSelectionClipboardFragment(clip: any, start: number, end: number) {
  const trimStart = Math.max(clip.startTime, start);
  const trimEnd = Math.min(clip.startTime + clip.duration, end);
  const sourceDelta = trimStart - clip.startTime;
  const fragment = {
    ...cloneTimelineClipDeep(clip),
    // Keep absolute source time. pasteClips uses the earliest clipboard item as
    // its origin, and automation-copy needs the original source interval.
    startTime: trimStart,
    duration: trimEnd - trimStart,
    offset: (clip.offset || 0) + sourceDelta,
  };
  if (!isMIDIClipboardClip(clip)) {
    fragment.fadeIn = trimStart > clip.startTime + TIME_EDIT_EPSILON ? 0 : clip.fadeIn;
    fragment.fadeOut = trimEnd < clip.startTime + clip.duration - TIME_EDIT_EPSILON
      ? 0
      : clip.fadeOut;
  }
  return fragment;
}

function collectClipboardEntries(
  state: any,
  range: NormalizedTimelineTimeSelection,
  mutableOnly: boolean,
) {
  const entries: Array<{ clip: any; trackId: string }> = [];
  for (const track of state.tracks || []) {
    for (const clip of [...(track.clips || []), ...(track.midiClips || [])]) {
      if (!clipOverlapsRange(clip, range.start, range.end)) continue;
      if (mutableOnly && !isTimelineClipMutable(state, track, clip)) continue;
      entries.push({
        clip: cloneTimeSelectionClipboardFragment(clip, range.start, range.end),
        trackId: track.id,
      });
    }
  }
  return entries;
}

function createLeftFragment(clip: any, duration: number) {
  const fragment = {
    ...cloneTimelineClipDeep(clip),
    id: crypto.randomUUID(),
    duration,
  };
  if (!isMIDIClipboardClip(clip)) fragment.fadeOut = 0;
  return fragment;
}

function createRightFragment(clip: any, sourceStart: number, timelineStart: number) {
  const sourceDelta = sourceStart - clip.startTime;
  const fragment = {
    ...cloneTimelineClipDeep(clip),
    id: crypto.randomUUID(),
    startTime: timelineStart,
    duration: clip.startTime + clip.duration - sourceStart,
    offset: (clip.offset || 0) + sourceDelta,
  };
  if (!isMIDIClipboardClip(clip)) fragment.fadeIn = 0;
  return fragment;
}

interface ClipTransformResult {
  clips: any[];
  changed: boolean;
  replacedIds: Set<string>;
}

function removeRangeFromClips(
  state: any,
  track: any,
  clips: any[],
  range: NormalizedTimelineTimeSelection,
  ripple: boolean,
): ClipTransformResult {
  const result: any[] = [];
  const replacedIds = new Set<string>();
  let changed = false;

  for (const clip of clips) {
    const clipStart = Number(clip.startTime);
    const clipDuration = Number(clip.duration);
    if (!Number.isFinite(clipStart)
        || !Number.isFinite(clipDuration)
        || clipDuration <= TIME_EDIT_EPSILON) {
      result.push(clip);
      continue;
    }
    const clipEnd = clipStart + clipDuration;
    if (!isTimelineClipMutable(state, track, clip)) {
      result.push(clip);
      continue;
    }
    if (clipEnd <= range.start + TIME_EDIT_EPSILON) {
      result.push(clip);
      continue;
    }
    if (clipStart >= range.end - TIME_EDIT_EPSILON) {
      if (ripple) {
        result.push({
          ...cloneTimelineClipDeep(clip),
          startTime: Math.max(0, clipStart - range.duration),
        });
        changed = true;
      } else {
        result.push(clip);
      }
      continue;
    }

    changed = true;
    replacedIds.add(clip.id);
    if (clipStart < range.start - TIME_EDIT_EPSILON) {
      result.push(createLeftFragment(clip, range.start - clipStart));
    }
    if (clipEnd > range.end + TIME_EDIT_EPSILON) {
      result.push(createRightFragment(
        clip,
        range.end,
        ripple ? range.start : range.end,
      ));
    }
  }

  return { clips: result, changed, replacedIds };
}

function insertRangeIntoClips(
  state: any,
  track: any,
  clips: any[],
  range: NormalizedTimelineTimeSelection,
): ClipTransformResult {
  const result: any[] = [];
  const replacedIds = new Set<string>();
  let changed = false;

  for (const clip of clips) {
    const clipStart = Number(clip.startTime);
    const clipDuration = Number(clip.duration);
    if (!Number.isFinite(clipStart)
        || !Number.isFinite(clipDuration)
        || clipDuration <= TIME_EDIT_EPSILON) {
      result.push(clip);
      continue;
    }
    const clipEnd = clipStart + clipDuration;
    if (!isTimelineClipMutable(state, track, clip)
        || clipEnd <= range.start + TIME_EDIT_EPSILON) {
      result.push(clip);
      continue;
    }
    changed = true;
    if (clipStart >= range.start - TIME_EDIT_EPSILON) {
      result.push({
        ...cloneTimelineClipDeep(clip),
        startTime: clipStart + range.duration,
      });
      continue;
    }

    replacedIds.add(clip.id);
    result.push(createLeftFragment(clip, range.start - clipStart));
    result.push(createRightFragment(
      clip,
      range.start,
      range.start + range.duration,
    ));
  }

  return { clips: result, changed, replacedIds };
}

function deleteAutomationTime(
  tracks: any[],
  range: NormalizedTimelineTimeSelection,
) {
  let changed = false;
  const next = tracks.map((track) => {
    if (track.frozen) return track;
    const automationLanes = (track.automationLanes || []).map((lane: any) => {
      const points = (lane.points || []).flatMap((point: any) => {
        if (!Number.isFinite(point.time)) return [{ ...point }];
        if (point.time < range.start - TIME_EDIT_EPSILON) return [{ ...point }];
        changed = true;
        if (point.time >= range.end - TIME_EDIT_EPSILON) {
          return [{ ...point, time: Math.max(0, point.time - range.duration) }];
        }
        return [];
      });
      return { ...lane, points };
    });
    return { ...track, automationLanes };
  });
  return { tracks: next, changed };
}

function insertAutomationTime(
  tracks: any[],
  range: NormalizedTimelineTimeSelection,
) {
  let changed = false;
  const next = tracks.map((track) => {
    if (track.frozen) return track;
    const automationLanes = (track.automationLanes || []).map((lane: any) => ({
      ...lane,
      points: (lane.points || []).map((point: any) => {
        if (!Number.isFinite(point.time)) return { ...point };
        if (point.time < range.start - TIME_EDIT_EPSILON) return { ...point };
        changed = true;
        return { ...point, time: point.time + range.duration };
      }),
    }));
    return { ...track, automationLanes };
  });
  return { tracks: next, changed };
}

function deleteMarkerTime(state: any, range: NormalizedTimelineTimeSelection) {
  if (state.lockSettings?.markers) {
    return {
      markers: state.markers,
      regions: state.regions,
      changed: false,
    };
  }
  let changed = false;
  const markers = (state.markers || []).flatMap((marker: any) => {
    if (!Number.isFinite(marker.time)) return [{ ...marker }];
    if (marker.time < range.start - TIME_EDIT_EPSILON) return [{ ...marker }];
    changed = true;
    if (marker.time >= range.end - TIME_EDIT_EPSILON) {
      return [{ ...marker, time: Math.max(0, marker.time - range.duration) }];
    }
    return [];
  });
  const regions = (state.regions || []).flatMap((region: any) => {
    if (!Number.isFinite(region.startTime) || !Number.isFinite(region.endTime)) {
      return [{ ...region }];
    }
    if (region.endTime <= range.start + TIME_EDIT_EPSILON) return [{ ...region }];
    if (region.startTime >= range.end - TIME_EDIT_EPSILON) {
      changed = true;
      return [{
        ...region,
        startTime: Math.max(0, region.startTime - range.duration),
        endTime: Math.max(0, region.endTime - range.duration),
      }];
    }
    changed = true;
    const startTime = region.startTime < range.start ? region.startTime : range.start;
    const endTime = region.endTime > range.end
      ? region.endTime - range.duration
      : range.start;
    return endTime > startTime + TIME_EDIT_EPSILON
      ? [{ ...region, startTime, endTime }]
      : [];
  });
  return { markers, regions, changed };
}

function insertMarkerTime(state: any, range: NormalizedTimelineTimeSelection) {
  if (state.lockSettings?.markers) {
    return {
      markers: state.markers,
      regions: state.regions,
      changed: false,
    };
  }
  let changed = false;
  const markers = (state.markers || []).map((marker: any) => {
    if (!Number.isFinite(marker.time)) return { ...marker };
    if (marker.time < range.start - TIME_EDIT_EPSILON) return { ...marker };
    changed = true;
    return { ...marker, time: marker.time + range.duration };
  });
  const regions = (state.regions || []).map((region: any) => {
    if (!Number.isFinite(region.startTime) || !Number.isFinite(region.endTime)) {
      return { ...region };
    }
    if (region.endTime <= range.start + TIME_EDIT_EPSILON) return { ...region };
    changed = true;
    if (region.startTime >= range.start - TIME_EDIT_EPSILON) {
      return {
        ...region,
        startTime: region.startTime + range.duration,
        endTime: region.endTime + range.duration,
      };
    }
    return { ...region, endTime: region.endTime + range.duration };
  });
  return { markers, regions, changed };
}

function hasMutableTimelineClipAtOrAfter(
  state: any,
  range: NormalizedTimelineTimeSelection,
) {
  for (const track of state.tracks || []) {
    for (const clip of [...(track.clips || []), ...(track.midiClips || [])]) {
      if (!isTimelineClipMutable(state, track, clip)) continue;
      const clipEnd = Number(clip.startTime) + Number(clip.duration);
      if (Number.isFinite(clipEnd) && clipEnd > range.start + TIME_EDIT_EPSILON) {
        return true;
      }
    }
  }
  return false;
}

function hasEditableAutomationAtOrAfter(state: any, time: number) {
  if (state.lockSettings?.envelopes) return false;
  return (state.tracks || []).some((track: any) => !track.frozen
    && (track.automationLanes || []).some((lane: any) =>
      (lane.points || []).some((point: any) => point.time >= time - TIME_EDIT_EPSILON)));
}

function hasEditableMarkerOrRegionAtOrAfter(state: any, time: number) {
  if (state.lockSettings?.markers) return false;
  return (state.markers || []).some((marker: any) => marker.time >= time - TIME_EDIT_EPSILON)
    || (state.regions || []).some((region: any) => region.endTime > time + TIME_EDIT_EPSILON);
}

function normalizedRazorEdits(state: any): NormalizedRazorEdit[] {
  return (state.razorEdits || []).flatMap((edit: any) => {
    if (!edit?.trackId || !Number.isFinite(edit.start) || !Number.isFinite(edit.end)) return [];
    const start = Math.max(0, Math.min(edit.start, edit.end));
    const end = Math.max(0, Math.max(edit.start, edit.end));
    return end - start > TIME_EDIT_EPSILON
      ? [{ trackId: edit.trackId as string, start, end, duration: end - start }]
      : [];
  });
}

export function canDeleteRazorEditContent(state: any) {
  if (state.globalLocked) return false;
  const edits = normalizedRazorEdits(state);
  if (edits.length === 0) return false;
  return edits.some((edit) => {
    const track = (state.tracks || []).find((candidate: any) => candidate.id === edit.trackId);
    if (!track || track.frozen) return false;
    const hasClipContent = !state.lockSettings?.items
      && [...(track.clips || []), ...(track.midiClips || [])].some((clip: any) => (
        !clip.locked && clipOverlapsRange(clip, edit.start, edit.end)
      ));
    const hasAutomationContent = !state.lockSettings?.envelopes
      && (track.automationLanes || []).some((lane: any) => (lane.points || []).some((point: any) => (
        point.time >= edit.start - TIME_EDIT_EPSILON
        && point.time < edit.end - TIME_EDIT_EPSILON
      )));
    return hasClipContent || hasAutomationContent;
  });
}

export function canCopyWithinTimelineTimeSelection(state: any) {
  const range = getNormalizedTimelineTimeSelection(state);
  return Boolean(range && collectClipboardEntries(state, range, false).length > 0);
}

export function canCutWithinTimelineTimeSelection(state: any) {
  const range = getNormalizedTimelineTimeSelection(state);
  return Boolean(range
    && !state.globalLocked
    && !state.lockSettings?.items
    && collectClipboardEntries(state, range, true).length > 0);
}

export function canDeleteWithinTimelineTimeSelection(state: any) {
  const range = getNormalizedTimelineTimeSelection(state);
  if (!range || state.globalLocked) return false;
  return hasMutableTimelineClipAtOrAfter(state, range)
    || hasEditableAutomationAtOrAfter(state, range.start)
    || hasEditableMarkerOrRegionAtOrAfter(state, range.start);
}

export function canInsertSilenceAtTimelineTimeSelection(state: any) {
  const range = getNormalizedTimelineTimeSelection(state);
  if (!range || state.globalLocked) return false;
  return hasMutableTimelineClipAtOrAfter(state, range)
    || hasEditableAutomationAtOrAfter(state, range.start)
    || hasEditableMarkerOrRegionAtOrAfter(state, range.start);
}

function selectionAfterReplacingClips(state: any, replacedIds: ReadonlySet<string>) {
  const before = cloneSelectionSnapshot(state);
  const selectedClipIds = before.selectedClipIds.filter((id: string) => !replacedIds.has(id));
  return {
    ...before,
    selectedClipIds,
    selectedClipId: before.selectedClipId && !replacedIds.has(before.selectedClipId)
      ? before.selectedClipId
      : selectedClipIds[selectedClipIds.length - 1] || null,
  };
}

function syncTimeEdit(
  get: GetFn,
  beforeTracks: any[],
  afterTracks: any[],
  touchedAudio: boolean,
  touchedMIDI: boolean,
  context: string,
) {
  if (touchedAudio) {
    const result = get().syncClipsWithBackend?.();
    if (result?.catch) result.catch(logBridgeError(context));
  }
  if (touchedMIDI) syncMIDITracksForTimelineClips(get, afterTracks);
  syncAutomationTrackSnapshots(beforeTracks, afterTracks);
}

function closeEditorsForReplacedClips(
  get: GetFn,
  midiBefore: any,
  replacedMIDIIds: ReadonlySet<string>,
  replacedAudioIds: ReadonlySet<string>,
) {
  if (replacedMIDIIds.size > 0) {
    closeDeletedWindowedMIDIEditors(midiBefore, replacedMIDIIds);
  }
  if (get().showPitchEditor && replacedAudioIds.has(get().pitchEditorClipId)) {
    get().closePitchEditor?.();
  }
}

export const timeSelectionEditingActions = (set: SetFn, get: GetFn) => ({
  deleteRazorEditContent: () => {
    const state = get();
    if (!canDeleteRazorEditContent(state)) return false;
    const edits = normalizedRazorEdits(state);
    const oldTracks = cloneTracksForTimelineUndo(state.tracks);
    const replacedAudioIds = new Set<string>();
    const replacedMIDIIds = new Set<string>();
    let touchedAudio = false;
    let touchedMIDI = false;
    let automationChanged = false;

    let newTracks = oldTracks.map((track: any) => {
      const trackEdits = edits.filter((edit) => edit.trackId === track.id);
      if (trackEdits.length === 0 || track.frozen) return track;
      let clips = track.clips;
      let midiClips = track.midiClips;
      for (const edit of trackEdits) {
        const audio = removeRangeFromClips(state, track, clips, edit, false);
        const midi = removeRangeFromClips(state, track, midiClips, edit, false);
        clips = audio.clips;
        midiClips = midi.clips;
        if (audio.changed) touchedAudio = true;
        if (midi.changed) touchedMIDI = true;
        audio.replacedIds.forEach((id) => replacedAudioIds.add(id));
        midi.replacedIds.forEach((id) => replacedMIDIIds.add(id));
      }
      const automationLanes = state.lockSettings?.envelopes
        ? track.automationLanes
        : (track.automationLanes || []).map((lane: any) => ({
            ...lane,
            points: (lane.points || []).filter((point: any) => {
              const remove = trackEdits.some((edit) => (
                point.time >= edit.start - TIME_EDIT_EPSILON
                && point.time < edit.end - TIME_EDIT_EPSILON
              ));
              if (remove) automationChanged = true;
              return !remove;
            }),
          }));
      return { ...track, clips, midiClips, automationLanes };
    });
    if (!touchedAudio && !touchedMIDI && !automationChanged) return false;
    newTracks = cloneTracksForTimelineUndo(newTracks);

    const oldRazorEdits = (state.razorEdits || []).map((edit: any) => ({ ...edit }));
    const replacedIds = new Set([...replacedAudioIds, ...replacedMIDIIds]);
    const selectionBefore = cloneSelectionSnapshot(state);
    const selectionAfter = selectionAfterReplacingClips(state, replacedIds);
    const midiBefore = cloneMIDIEditorSnapshot(state);
    const midiAfter = replacedMIDIIds.size > 0
      ? buildPostDeleteMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;
    const midiUndo = replacedMIDIIds.size > 0
      ? buildSafeUndoMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;

    const apply = (
      tracks: any[],
      razorEdits: Array<{ trackId: string; start: number; end: number }>,
      selection: Record<string, unknown>,
      midiEditor: Record<string, unknown>,
      phase: "delete" | "undo",
    ) => {
      const beforeApply = cloneTracksForTimelineUndo(get().tracks);
      if (phase === "delete") {
        closeEditorsForReplacedClips(get, midiBefore, replacedMIDIIds, replacedAudioIds);
      }
      set({
        tracks: cloneTracksForTimelineUndo(tracks),
        razorEdits: razorEdits.map((edit) => ({ ...edit })),
        ...selection,
        ...midiEditor,
        isModified: true,
      });
      syncTimeEdit(get, beforeApply, tracks, touchedAudio, touchedMIDI, "sync razor delete");
    };

    commandManager.execute({
      type: "DELETE_RAZOR_EDIT",
      description: "Delete razor edit content",
      timestamp: Date.now(),
      execute: () => apply(newTracks, [], selectionAfter, midiAfter, "delete"),
      undo: () => apply(oldTracks, oldRazorEdits, selectionBefore, midiUndo, "undo"),
    });
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    return true;
  },

  copyWithinTimeSelection: () => {
    const state = get();
    const range = getNormalizedTimelineTimeSelection(state);
    if (!range) return false;
    const entries = collectClipboardEntries(state, range, false);
    if (entries.length === 0) return false;
    const trackIds = new Set(entries.map((entry) => entry.trackId));
    const clipboard = {
      clip: entries[0].clip,
      clips: entries,
      isCut: false,
      sourceRemoved: false,
      automationTracks: cloneClipboardAutomationTracks(state.tracks, trackIds),
    };
    set({ clipboard: cloneTimelineClipboard(clipboard) });
    return true;
  },

  cutWithinTimeSelection: () => {
    const state = get();
    const range = getNormalizedTimelineTimeSelection(state);
    if (!range || state.globalLocked || state.lockSettings?.items) return false;
    const entries = collectClipboardEntries(state, range, true);
    if (entries.length === 0) return false;

    const oldTracks = cloneTracksForTimelineUndo(state.tracks);
    const oldClipboard = cloneTimelineClipboard(state.clipboard);
    const trackIds = new Set(entries.map((entry) => entry.trackId));
    const clipboard = {
      clip: entries[0].clip,
      clips: entries,
      isCut: true,
      sourceRemoved: true,
      automationTracks: cloneClipboardAutomationTracks(oldTracks, trackIds),
    };
    const replacedAudioIds = new Set<string>();
    const replacedMIDIIds = new Set<string>();
    let touchedAudio = false;
    let touchedMIDI = false;
    let newTracks = oldTracks.map((track) => {
      const audio = removeRangeFromClips(state, track, track.clips, range, false);
      const midi = removeRangeFromClips(state, track, track.midiClips, range, false);
      if (audio.changed) touchedAudio = true;
      if (midi.changed) touchedMIDI = true;
      audio.replacedIds.forEach((id) => replacedAudioIds.add(id));
      midi.replacedIds.forEach((id) => replacedMIDIIds.add(id));
      return { ...track, clips: audio.clips, midiClips: midi.clips };
    });
    if (state.moveEnvelopesWithItems && !state.lockSettings?.envelopes) {
      newTracks = removeAutomationPointsWithClips(
        newTracks,
        entries.map((entry) => ({
          sourceTrackId: entry.trackId,
          originalStartTime: entry.clip.startTime,
          duration: entry.clip.duration,
        })),
      );
    }
    newTracks = cloneTracksForTimelineUndo(newTracks);

    const replacedIds = new Set([...replacedAudioIds, ...replacedMIDIIds]);
    const selectionBefore = cloneSelectionSnapshot(state);
    const selectionAfter = selectionAfterReplacingClips(state, replacedIds);
    const midiBefore = cloneMIDIEditorSnapshot(state);
    const midiAfter = replacedMIDIIds.size > 0
      ? buildPostDeleteMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;
    const midiUndo = replacedMIDIIds.size > 0
      ? buildSafeUndoMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;

    const apply = (
      tracks: any[],
      nextClipboard: any,
      selection: Record<string, unknown>,
      midiEditor: Record<string, unknown>,
      phase: "cut" | "undo",
    ) => {
      const beforeApply = cloneTracksForTimelineUndo(get().tracks);
      if (phase === "cut") {
        closeEditorsForReplacedClips(get, midiBefore, replacedMIDIIds, replacedAudioIds);
      }
      set({
        tracks: cloneTracksForTimelineUndo(tracks),
        clipboard: cloneTimelineClipboard(nextClipboard),
        ...selection,
        ...midiEditor,
        isModified: true,
      });
      syncTimeEdit(get, beforeApply, tracks, touchedAudio, touchedMIDI, "sync time-selection cut");
    };

    commandManager.execute({
      type: "CUT_WITHIN_TIME_SELECTION",
      description: "Cut within time selection",
      timestamp: Date.now(),
      execute: () => apply(newTracks, clipboard, selectionAfter, midiAfter, "cut"),
      undo: () => apply(oldTracks, oldClipboard, selectionBefore, midiUndo, "undo"),
    });
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    return true;
  },

  deleteWithinTimeSelection: () => {
    const state = get();
    const range = getNormalizedTimelineTimeSelection(state);
    if (!range || state.globalLocked) return false;

    const oldTracks = cloneTracksForTimelineUndo(state.tracks);
    const replacedAudioIds = new Set<string>();
    const replacedMIDIIds = new Set<string>();
    let touchedAudio = false;
    let touchedMIDI = false;
    let newTracks = oldTracks.map((track) => {
      const audio = removeRangeFromClips(state, track, track.clips, range, true);
      const midi = removeRangeFromClips(state, track, track.midiClips, range, true);
      if (audio.changed) touchedAudio = true;
      if (midi.changed) touchedMIDI = true;
      audio.replacedIds.forEach((id) => replacedAudioIds.add(id));
      midi.replacedIds.forEach((id) => replacedMIDIIds.add(id));
      return { ...track, clips: audio.clips, midiClips: midi.clips };
    });
    let automationChanged = false;
    if (!state.lockSettings?.envelopes) {
      const automation = deleteAutomationTime(newTracks, range);
      newTracks = automation.tracks;
      automationChanged = automation.changed;
    }
    const markerResult = deleteMarkerTime(state, range);
    if (!touchedAudio && !touchedMIDI && !automationChanged && !markerResult.changed) return false;
    newTracks = cloneTracksForTimelineUndo(newTracks);

    const oldMarkers = (state.markers || []).map((marker: Marker) => ({ ...marker }));
    const oldRegions = (state.regions || []).map((region: Region) => ({ ...region }));
    const oldTimeSelection = { ...state.timeSelection };
    const newTimeSelection = state.lockSettings?.timeSelection
      ? { ...oldTimeSelection }
      : null;
    const replacedIds = new Set([...replacedAudioIds, ...replacedMIDIIds]);
    const selectionBefore = cloneSelectionSnapshot(state);
    const selectionAfter = selectionAfterReplacingClips(state, replacedIds);
    const midiBefore = cloneMIDIEditorSnapshot(state);
    const midiAfter = replacedMIDIIds.size > 0
      ? buildPostDeleteMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;
    const midiUndo = replacedMIDIIds.size > 0
      ? buildSafeUndoMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;

    const apply = (
      tracks: any[],
      markers: Marker[],
      regions: Region[],
      timeSelection: { start: number; end: number } | null,
      selection: Record<string, unknown>,
      midiEditor: Record<string, unknown>,
      phase: "delete" | "undo",
    ) => {
      const beforeApply = cloneTracksForTimelineUndo(get().tracks);
      if (phase === "delete") {
        closeEditorsForReplacedClips(get, midiBefore, replacedMIDIIds, replacedAudioIds);
      }
      set({
        tracks: cloneTracksForTimelineUndo(tracks),
        markers: markers.map((marker: Marker) => ({ ...marker })),
        regions: regions.map((region: Region) => ({ ...region })),
        timeSelection: timeSelection ? { ...timeSelection } : null,
        ...selection,
        ...midiEditor,
        isModified: true,
      });
      syncTimeEdit(get, beforeApply, tracks, touchedAudio, touchedMIDI, "sync delete time");
    };

    commandManager.execute({
      type: "DELETE_WITHIN_TIME_SELECTION",
      description: "Delete within time selection (ripple)",
      timestamp: Date.now(),
      execute: () => apply(
        newTracks,
        markerResult.markers,
        markerResult.regions,
        newTimeSelection,
        selectionAfter,
        midiAfter,
        "delete",
      ),
      undo: () => apply(
        oldTracks,
        oldMarkers,
        oldRegions,
        oldTimeSelection,
        selectionBefore,
        midiUndo,
        "undo",
      ),
    });
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    return true;
  },

  insertSilenceAtTimeSelection: () => {
    const state = get();
    const range = getNormalizedTimelineTimeSelection(state);
    if (!range || state.globalLocked) return false;

    const oldTracks = cloneTracksForTimelineUndo(state.tracks);
    const replacedAudioIds = new Set<string>();
    const replacedMIDIIds = new Set<string>();
    let touchedAudio = false;
    let touchedMIDI = false;
    let newTracks = oldTracks.map((track) => {
      const audio = insertRangeIntoClips(state, track, track.clips, range);
      const midi = insertRangeIntoClips(state, track, track.midiClips, range);
      if (audio.changed) touchedAudio = true;
      if (midi.changed) touchedMIDI = true;
      audio.replacedIds.forEach((id) => replacedAudioIds.add(id));
      midi.replacedIds.forEach((id) => replacedMIDIIds.add(id));
      return { ...track, clips: audio.clips, midiClips: midi.clips };
    });
    let automationChanged = false;
    if (!state.lockSettings?.envelopes) {
      const automation = insertAutomationTime(newTracks, range);
      newTracks = automation.tracks;
      automationChanged = automation.changed;
    }
    const markerResult = insertMarkerTime(state, range);
    if (!touchedAudio && !touchedMIDI && !automationChanged && !markerResult.changed) return false;
    newTracks = cloneTracksForTimelineUndo(newTracks);

    const oldMarkers = (state.markers || []).map((marker: Marker) => ({ ...marker }));
    const oldRegions = (state.regions || []).map((region: Region) => ({ ...region }));
    const oldTimeSelection = { ...state.timeSelection };
    const newTimeSelection = state.lockSettings?.timeSelection
      ? { ...oldTimeSelection }
      : null;
    const replacedIds = new Set([...replacedAudioIds, ...replacedMIDIIds]);
    const selectionBefore = cloneSelectionSnapshot(state);
    const selectionAfter = selectionAfterReplacingClips(state, replacedIds);
    const midiBefore = cloneMIDIEditorSnapshot(state);
    const midiAfter = replacedMIDIIds.size > 0
      ? buildPostDeleteMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;
    const midiUndo = replacedMIDIIds.size > 0
      ? buildSafeUndoMIDIEditorState(midiBefore, replacedMIDIIds)
      : midiBefore;

    const apply = (
      tracks: any[],
      markers: Marker[],
      regions: Region[],
      timeSelection: { start: number; end: number } | null,
      selection: Record<string, unknown>,
      midiEditor: Record<string, unknown>,
      phase: "insert" | "undo",
    ) => {
      const beforeApply = cloneTracksForTimelineUndo(get().tracks);
      if (phase === "insert") {
        closeEditorsForReplacedClips(get, midiBefore, replacedMIDIIds, replacedAudioIds);
      }
      set({
        tracks: cloneTracksForTimelineUndo(tracks),
        markers: markers.map((marker: Marker) => ({ ...marker })),
        regions: regions.map((region: Region) => ({ ...region })),
        timeSelection: timeSelection ? { ...timeSelection } : null,
        ...selection,
        ...midiEditor,
        isModified: true,
      });
      syncTimeEdit(get, beforeApply, tracks, touchedAudio, touchedMIDI, "sync insert silence");
    };

    commandManager.execute({
      type: "INSERT_SILENCE",
      description: "Insert silence",
      timestamp: Date.now(),
      execute: () => apply(
        newTracks,
        markerResult.markers,
        markerResult.regions,
        newTimeSelection,
        selectionAfter,
        midiAfter,
        "insert",
      ),
      undo: () => apply(
        oldTracks,
        oldMarkers,
        oldRegions,
        oldTimeSelection,
        selectionBefore,
        midiUndo,
        "undo",
      ),
    });
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    return true;
  },
});
