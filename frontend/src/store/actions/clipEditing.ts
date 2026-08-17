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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

function isMidiClipLike(clip: any) {
  return clip && Array.isArray(clip.events);
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

function cloneTracksForTimelineUndo(tracks: any[]) {
  return tracks.map((track) => ({
    ...track,
    clips: [...track.clips],
    midiClips: [...track.midiClips],
  }));
}

function removeTimelineClipFromTrack(track: any, clipId: string) {
  return {
    ...track,
    clips: track.clips.filter((clip: any) => clip.id !== clipId),
    midiClips: track.midiClips.filter((clip: any) => clip.id !== clipId),
  };
}

function syncMIDITracksForTimelineClips(get: GetFn, tracks: any[]) {
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

function cloneSelectionSnapshot(state: any) {
  return {
    selectedClipIds: [...state.selectedClipIds],
    selectedClipId: state.selectedClipId,
    selectedTrackIds: [...state.selectedTrackIds],
    selectedTrackId: state.selectedTrackId,
    lastSelectedTrackId: state.lastSelectedTrackId,
  };
}

function cloneMIDIEditorSnapshot(state: any) {
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

  const entries = getTimelineClipEntries(state);
  const selectedClipIds = new Set<string>(state.selectedClipIds);
  const selectedTrackIds = new Set<string>(state.selectedTrackIds);
  const crossingEntries = entries.filter((entry: any) =>
    clipContainsSplitTime(entry.clip, splitTime));
  const selectedClipCrossings = crossingEntries.filter((entry: any) =>
    selectedClipIds.has(entry.clip.id));
  const selectedTrackCrossings = crossingEntries.filter((entry: any) =>
    selectedTrackIds.has(entry.trackId));
  const editable = (candidates: any[]) => candidates.filter((entry: any) => !entry.clip.locked);
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
        return split?.kind === "audio" ? [split.leftClip, split.rightClip] : [clip];
      }),
      afterMIDIClips: track.midiClips.flatMap((clip: any) => {
        const split = replacements.get(clip.id);
        return split?.kind === "midi" ? [split.leftClip, split.rightClip] : [clip];
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
    [split.leftClip.id, split.rightClip.id],
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
    selectedClipId: primaryReplacement?.[1]
      || (before.selectedClipId && uniqueSelectedClipIds.includes(before.selectedClipId)
        ? before.selectedClipId
        : null),
  };
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
    description: `Split ${splitData.length} clip${splitData.length === 1 ? "" : "s"}`,
    timestamp: Date.now(),
    execute: () => apply("after", afterSelection),
    undo: () => apply("before", beforeSelection),
  });

  set({
    canUndo: commandManager.canUndo(),
    canRedo: commandManager.canRedo(),
    isModified: true,
  });
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
        const clickedClip = state.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        let ids = [clipId];
        if (clickedClip?.groupId) {
          ids = state.tracks
            .flatMap((t) => t.clips)
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

    moveClipToTrack: async (clipId, newTrackId, newStartTime) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found) return;

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

      set((state) => ({
        tracks: state.tracks.map((track) => {
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
        }),
        ...(isMidi ? {
          midiEditorSessions: (state.midiEditorSessions || []).map((session) =>
            session.clipId === clipId
              ? { ...session, trackId: newTrackId, updatedAt: Date.now() }
              : session,
          ),
          ...(state.pianoRollClipId === clipId ? { pianoRollTrackId: newTrackId } : {}),
        } : {}),
        isModified: true,
      }));

      if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);

      // Apply auto-crossfades on affected audio track(s)
      if (!isMidi && get().autoCrossfade) {
        get().applyAutoCrossfades(newTrackId);
        if (sourceTrackId !== newTrackId) {
          get().applyAutoCrossfades(sourceTrackId);
        }
      }
    },

    resizeClip: (clipId, newStartTime, newDuration, newOffset) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.clip.locked) return;

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

    setMIDIClipSourceWindow: (clipId, patch, description = "Edit MIDI clip source") => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.kind !== "midi" || found.clip.locked) return;

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
      const found = findTimelineClip(get(), clipId);
      if (!found) return;
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
    },

    setClipVolume: (clipId, volumeDB) => {
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, volumeDB } : clip,
          ),
        })),
      }));
    },

    setClipFades: (clipId, fadeIn, fadeOut) => {
      const state = get();

      // Find old fade values
      let oldValues: { fadeIn: number; fadeOut: number } | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldValues = { fadeIn: clip.fadeIn, fadeOut: clip.fadeOut };
          break;
        }
      }

      if (!oldValues) return;

      const command: Command = {
        type: "SET_CLIP_FADES",
        description: "Adjust clip fades",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, fadeIn, fadeOut } : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
          }));
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
        set({ clipboard: { clip: foundClip, clips: [{ clip: foundClip, trackId: foundTrackId }], isCut: false } });
      }
    },

    cutClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      const foundClip = found?.clip ?? null;
      const foundTrackId = found?.trackId ?? null;

      if (foundClip && foundTrackId) {
        set({ clipboard: { clip: foundClip, clips: [{ clip: foundClip, trackId: foundTrackId }], isCut: true } });
      }
    },

    copySelectedClips: () => {
      const state = get();
      const clipEntries: Array<{ clip: AudioClip | MIDIClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
        for (const clip of track.midiClips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        set({ clipboard: { clip: clipEntries[0].clip, clips: clipEntries, isCut: false } });
      }
    },

    cutSelectedClips: () => {
      const state = get();
      const clipEntries: Array<{ clip: AudioClip | MIDIClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
        for (const clip of track.midiClips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        set({ clipboard: { clip: clipEntries[0].clip, clips: clipEntries, isCut: true } });
      }
    },

    copySelectedTimelineClips: () => {
      get().copySelectedClips();
    },

    pasteSelectedTimelineClips: () => {
      get().pasteClips();
    },

    pasteClip: (targetTrackId, targetTime) => {
      const state = get();
      const { clipboard } = state;
      if (!clipboard.clip) return;

      // Snapshot for undo
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const oldClipboard = clipboard;
      const isMidi = isMidiClipLike(clipboard.clip);

      const newClip = {
        ...clipboard.clip,
        id: crypto.randomUUID(),
        startTime: targetTime,
      };

      set((s) => {
        let newTracks = s.tracks;
        if (clipboard.isCut) {
          newTracks = s.tracks.map((t) => ({
            ...removeTimelineClipFromTrack(t, clipboard.clip!.id),
          }));
        }

        return {
          tracks: newTracks.map((t) =>
            t.id === targetTrackId
              ? isMidi
                ? { ...t, midiClips: [...t.midiClips, newClip] }
                : { ...t, clips: [...t.clips, newClip] }
              : t,
          ),
          clipboard: clipboard.isCut
            ? { clip: null, clips: [], isCut: false }
            : s.clipboard,
          isModified: true,
        };
      });

      const newTracks = cloneTracksForTimelineUndo(get().tracks);
      const newClipboardState = get().clipboard;
      if (isMidi) syncMIDITracksForTimelineClips(get, newTracks);

      commandManager.push({
        type: "PASTE_CLIP",
        description: "Paste clip",
        timestamp: Date.now(),
        execute: () => {
          set({ tracks: newTracks, clipboard: newClipboardState, isModified: true });
          if (isMidi) syncMIDITracksForTimelineClips(get, newTracks);
        },
        undo: () => {
          set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true });
          if (isMidi) syncMIDITracksForTimelineClips(get, oldTracks);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    pasteClips: () => {
      const state = get();
      const { clipboard } = state;
      if (clipboard.clips.length === 0) return;

      // Snapshot for undo
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const oldClipboard = clipboard;

      const currentTime = state.transport.currentTime;
      const earliestTime = Math.min(...clipboard.clips.map((c) => c.clip.startTime));
      const sourceTrackIds = [...new Set(clipboard.clips.map((entry) => entry.trackId))];
      const targetTrackIds = sourceTrackIds.map((sourceTrackId, index) =>
        state.selectedTrackIds[index] || sourceTrackId || state.tracks[0]?.id,
      );
      const trackMap = new Map<string, string>();
      sourceTrackIds.forEach((sourceTrackId, index) => trackMap.set(sourceTrackId, targetTrackIds[index]));
      const originalIds = new Set(clipboard.clips.map((entry) => entry.clip.id));

      const pastedEntries = clipboard.clips.map((entry) => ({
        clip: {
          ...entry.clip,
          id: crypto.randomUUID(),
          startTime: currentTime + (entry.clip.startTime - earliestTime),
        },
        targetTrackId: trackMap.get(entry.trackId) || targetTrackIds[0],
        isMidi: isMidiClipLike(entry.clip),
      }));

      set((s) => {
        let tracks = s.tracks;
        if (clipboard.isCut) {
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

        return {
          tracks,
          clipboard: clipboard.isCut ? { clip: null, clips: [], isCut: false } : s.clipboard,
          isModified: true,
        };
      });

      // Undo tracking (captures full state after paste)
      const afterState = get();
      const newTracksSnapshot = cloneTracksForTimelineUndo(afterState.tracks);
      const newClipboardSnapshot = afterState.clipboard;
      const touchedMIDI = pastedEntries.some((entry) => entry.isMidi);
      if (touchedMIDI || clipboard.clips.some((entry) => isMidiClipLike(entry.clip))) {
        syncMIDITracksForTimelineClips(get, newTracksSnapshot);
      }

      commandManager.push({
        type: "PASTE_CLIPS",
        description: "Paste clips",
        timestamp: Date.now(),
        execute: () => {
          set({ tracks: newTracksSnapshot, clipboard: newClipboardSnapshot, isModified: true });
          if (touchedMIDI) syncMIDITracksForTimelineClips(get, newTracksSnapshot);
        },
        undo: () => {
          set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true });
          if (touchedMIDI) syncMIDITracksForTimelineClips(get, oldTracks);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    nudgeClips: (direction, fine) => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      const amount = fine
        ? 0.01 // 10ms fine nudge
        : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
      const delta = direction === "right" ? amount : -amount;

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipPositions.set(clip.id, clip.startTime);
          }
        }
        for (const clip of track.midiClips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipPositions.set(clip.id, clip.startTime);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, startTime: Math.max(0, clip.startTime + delta) }
              : clip,
          ),
        })),
        isModified: true,
      }));

      const command: Command = {
        type: "NUDGE_CLIPS",
        description: `Nudge clips ${direction}`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
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
            })),
            isModified: true,
          }));
          syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clipPositions.has(clip.id)
                  ? { ...clip, startTime: clipPositions.get(clip.id)! }
                  : clip,
              ),
              midiClips: track.midiClips.map((clip) =>
                clipPositions.has(clip.id)
                  ? { ...clip, startTime: clipPositions.get(clip.id)! }
                  : clip,
              ),
            })),
            isModified: true,
          }));
          syncMIDITracksForTimelineClips(get, get().tracks);
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.clip.locked) return;

      // Capture values for ripple editing and backend sync
      const foundClip = found.clip;
      const foundTrackId = found.trackId;
      const clipIndex = found.index;
      const isMidi = found.kind === "midi";
      const clipFilePath = foundClip.filePath;
      const trackIdForBackend = foundTrackId;
      const rippleMode = state.rippleMode;
      const deletedDuration = foundClip.duration;
      const deletedEnd = foundClip.startTime + deletedDuration;
      const previousMidiEditorState = isMidi
        ? {
            sessions: (state.midiEditorSessions || []).filter((session) => session.clipId === clipId),
            activeId: state.activeMidiEditorSessionId,
            dockedId: state.dockedMidiEditorSessionId,
            showPianoRoll: state.showPianoRoll,
            pianoRollTrackId: state.pianoRollTrackId,
            pianoRollClipId: state.pianoRollClipId,
            selectedNoteIds: [...(state.selectedNoteIds || [])],
            midiEditRange: state.midiEditRange,
            pianoRollEditCursorTime: state.pianoRollEditCursorTime,
          }
        : null;

      // Create and execute command
      const command: Command = {
        type: "DELETE_CLIP",
        description: `Delete clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Remove from frontend state + apply ripple shift
          set((s) => ({
            tracks: s.tracks.map((track) => {
              let clips = track.clips.filter((c) => c.id !== clipId);
              let midiClips = track.midiClips.filter((c) => c.id !== clipId);

              // Ripple: shift downstream clips left by the deleted clip's duration
              if (rippleMode === "per_track" && track.id === foundTrackId) {
                clips = clips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
                midiClips = midiClips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
              } else if (rippleMode === "all_tracks") {
                clips = clips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
                midiClips = midiClips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
              }

              return { ...track, clips, midiClips };
            }),
            selectedClipId:
              s.selectedClipId === clipId ? null : s.selectedClipId,
            selectedClipIds: s.selectedClipIds.filter((id) => id !== clipId),
            ...(isMidi ? (() => {
              const remainingSessions = (s.midiEditorSessions || []).filter((session) => session.clipId !== clipId);
              const dockedId = remainingSessions.some((session) => session.sessionId === s.dockedMidiEditorSessionId)
                ? s.dockedMidiEditorSessionId
                : null;
              const activeId = remainingSessions.some((session) => session.sessionId === s.activeMidiEditorSessionId)
                ? s.activeMidiEditorSessionId
                : (dockedId || remainingSessions[0]?.sessionId || null);
              return {
                midiEditorSessions: remainingSessions,
                activeMidiEditorSessionId: activeId,
                dockedMidiEditorSessionId: dockedId,
                showPianoRoll: Boolean(dockedId),
                ...(s.pianoRollClipId === clipId ? {
                  pianoRollTrackId: null,
                  pianoRollClipId: null,
                  selectedNoteIds: [],
                  midiEditRange: null,
                  pianoRollEditCursorTime: null,
                } : {}),
              };
            })() : {}),
          }));

          // Sync with backend - remove from playback engine
          if (clipFilePath) {
            try {
              await nativeBridge.removePlaybackClipById(trackIdForBackend, clipId);
              console.log(`[DAW] Clip deleted and removed from backend: ${clipFilePath}`);
            } catch (error) {
              console.error("[DAW] Failed to remove clip from backend:", error);
            }
          }
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: async () => {
          // Restore to frontend state + reverse ripple shift
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id === foundTrackId) {
                // Reverse ripple shift on this track
                let clips = [...track.clips];
                let midiClips = [...track.midiClips];
                if (rippleMode !== "off") {
                  clips = clips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  );
                  midiClips = midiClips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  );
                }
                if (isMidi) {
                  midiClips.splice(clipIndex, 0, foundClip);
                } else {
                  clips.splice(clipIndex, 0, foundClip);
                }
                return { ...track, clips, midiClips };
              }
              if (rippleMode === "all_tracks") {
                // Reverse ripple on other tracks too
                return {
                  ...track,
                  clips: track.clips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  ),
                  midiClips: track.midiClips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  ),
                };
              }
              return track;
            }),
            ...(previousMidiEditorState ? {
              midiEditorSessions: [
                ...(s.midiEditorSessions || []).filter((session) => session.clipId !== clipId),
                ...previousMidiEditorState.sessions,
              ],
              activeMidiEditorSessionId: previousMidiEditorState.activeId,
              dockedMidiEditorSessionId: previousMidiEditorState.dockedId,
              showPianoRoll: previousMidiEditorState.showPianoRoll,
              pianoRollTrackId: previousMidiEditorState.pianoRollTrackId,
              pianoRollClipId: previousMidiEditorState.pianoRollClipId,
              selectedNoteIds: previousMidiEditorState.selectedNoteIds,
              midiEditRange: previousMidiEditorState.midiEditRange,
              pianoRollEditCursorTime: previousMidiEditorState.pianoRollEditCursorTime,
            } : {}),
          }));

          // Re-add to backend
          if (clipFilePath && foundClip) {
            try {
              await nativeBridge.addPlaybackClip(
                trackIdForBackend,
                clipFilePath,
                foundClip.startTime,
                foundClip.duration,
                foundClip.offset || 0,
                foundClip.volumeDB || 0,
                foundClip.fadeIn || 0,
                foundClip.fadeOut || 0,
                foundClip.id,
                foundClip.pitchCorrectionSourceFilePath,
                foundClip.pitchCorrectionSourceOffset,
              );
              console.log(`[DAW] Clip restored to backend: ${clipFilePath}`);
            } catch (error) {
              console.error("[DAW] Failed to restore clip to backend:", error);
            }
          }
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    duplicateClip: (clipId) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found) return;
      const foundClip = found.clip;
      const foundTrackId = found.trackId;
      const isMidi = found.kind === "midi";

      // Create new clip ID upfront so we can track it for undo
      const newClipId = crypto.randomUUID();
      const newClip = {
        ...foundClip,
        id: newClipId,
        startTime: foundClip.startTime + foundClip.duration,
      };

      const command: Command = {
        type: "DUPLICATE_CLIP",
        description: `Duplicate clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) =>
              track.id === foundTrackId
                ? isMidi
                  ? { ...track, midiClips: [...track.midiClips, newClip] }
                  : { ...track, clips: [...track.clips, newClip] }
                : track,
            ),
            selectedClipId: newClipId,
            selectedClipIds: [newClipId],
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.filter((c) => c.id !== newClipId),
              midiClips: track.midiClips.filter((c) => c.id !== newClipId),
            })),
            selectedClipId: clipId,
            selectedClipIds: [clipId],
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

    duplicateClipToPosition: (clipId, targetTrackId, targetStartTime) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      const targetTrack = state.tracks.find((track: any) => track.id === targetTrackId);
      if (!found || !targetTrack || found.clip.locked) return null;

      const isMidi = found.kind === "midi";
      if (isMidi && targetTrack.type !== "midi" && targetTrack.type !== "instrument") return null;
      if (!isMidi && (targetTrack.type === "midi" || targetTrack.type === "instrument")) return null;

      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const oldSelectedClipId = state.selectedClipId;
      const oldSelectedClipIds = [...state.selectedClipIds];
      const newClipId = crypto.randomUUID();
      const newClip = {
        ...found.clip,
        id: newClipId,
        startTime: Math.max(0, targetStartTime),
        color: targetTrack.color || found.clip.color,
      };

      const command: Command = {
        type: "DUPLICATE_CLIP_TO_POSITION",
        description: isMidi ? "Copy MIDI clip" : "Copy clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) =>
              track.id === targetTrackId
                ? isMidi
                  ? { ...track, midiClips: [...track.midiClips, newClip] }
                  : { ...track, clips: [...track.clips, newClip] }
                : track,
            ),
            selectedClipId: newClipId,
            selectedClipIds: [newClipId],
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set({
            tracks: oldTracks,
            selectedClipId: oldSelectedClipId,
            selectedClipIds: oldSelectedClipIds,
            isModified: true,
          });
          if (isMidi) syncMIDITracksForTimelineClips(get, oldTracks);
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
      return newClipId;
    },

    repeatClip: (clipId, repeatCount = 3) => {
      const state = get();
      const found = findTimelineClip(state, clipId);
      if (!found || found.clip.locked) return;

      const count = Math.max(1, Math.min(128, Math.floor(Number(repeatCount) || 1)));
      const isMidi = found.kind === "midi";
      const newClips = Array.from({ length: count }, (_, index) => ({
        ...found.clip,
        id: crypto.randomUUID(),
        startTime: found.clip.startTime + found.clip.duration * (index + 1),
      }));
      const newIds = newClips.map((clip) => clip.id);

      const command: Command = {
        type: "REPEAT_CLIP",
        description: `Repeat clip ${count} time${count === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) =>
              track.id === found.trackId
                ? isMidi
                  ? { ...track, midiClips: [...track.midiClips, ...newClips] }
                  : { ...track, clips: [...track.clips, ...newClips] }
                : track,
            ),
            selectedClipId: newIds[newIds.length - 1],
            selectedClipIds: newIds,
            isModified: true,
          }));
          if (isMidi) syncMIDITracksForTimelineClips(get, get().tracks);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.filter((clip) => !newIds.includes(clip.id)),
              midiClips: track.midiClips.filter((clip) => !newIds.includes(clip.id)),
            })),
            selectedClipId: clipId,
            selectedClipIds: [clipId],
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

    // ========== Advanced Clip Editing ==========
    splitAtTimeSelection: () => {
      const state = get();
      const { timeSelection } = state;
      if (!timeSelection) return;

      const splitTimes = [timeSelection.start, timeSelection.end];
      const newClipEntries: Array<{ trackId: string; clips: AudioClip[] }> = [];

      for (const track of state.tracks) {
        const clipsToRemove: string[] = [];
        const clipsToAdd: AudioClip[] = [];

        for (const clip of track.clips) {
          let currentClip = clip;
          let wasSplit = false;

          for (const splitTime of splitTimes) {
            if (splitTime > currentClip.startTime && splitTime < currentClip.startTime + currentClip.duration) {
              if (!wasSplit) {
                clipsToRemove.push(clip.id);
                wasSplit = true;
              }
              const leftDuration = splitTime - currentClip.startTime;
              const leftClip: AudioClip = {
                ...currentClip,
                id: crypto.randomUUID(),
                duration: leftDuration,
                fadeOut: 0,
              };
              clipsToAdd.push(leftClip);

              currentClip = {
                ...currentClip,
                id: crypto.randomUUID(),
                startTime: splitTime,
                duration: currentClip.startTime + currentClip.duration - splitTime,
                offset: currentClip.offset + leftDuration,
                fadeIn: 0,
              };
            }
          }
          if (wasSplit) {
            clipsToAdd.push(currentClip);
          }
        }

        if (clipsToRemove.length > 0) {
          newClipEntries.push({ trackId: track.id, clips: clipsToAdd });
        }
      }

      if (newClipEntries.length === 0) return;

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const entry = newClipEntries.find((e) => e.trackId === track.id);
          if (!entry) return track;
          const removeIds = new Set(
            track.clips
              .filter((c) => {
                const clipEnd = c.startTime + c.duration;
                return (
                  (timeSelection.start > c.startTime && timeSelection.start < clipEnd) ||
                  (timeSelection.end > c.startTime && timeSelection.end < clipEnd)
                );
              })
              .map((c) => c.id),
          );
          return {
            ...track,
            clips: [...track.clips.filter((c) => !removeIds.has(c.id)), ...entry.clips],
          };
        }),
        isModified: true,
      }));
    },

    groupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length < 2) return;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }

      const groupId = crypto.randomUUID();
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, groupId }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "GROUP_CLIPS",
        description: "Group selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldGroupIds.has(c.id) ? { ...c, groupId } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldGroupIds.get(c.id);
              return old !== undefined || oldGroupIds.has(c.id) ? { ...c, groupId: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    ungroupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, groupId: undefined }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "UNGROUP_CLIPS",
        description: "Ungroup selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldGroupIds.has(c.id) ? { ...c, groupId: undefined } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldGroupIds.get(c.id);
              return old !== undefined || oldGroupIds.has(c.id) ? { ...c, groupId: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    normalizeSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Capture old volumes for undo
      const oldVolumes = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldVolumes.set(clip.id, clip.volumeDB ?? 0);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, volumeDB: 0 }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "NORMALIZE_CLIPS",
        description: "Normalize selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldVolumes.has(c.id) ? { ...c, volumeDB: 0 } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldVolumes.get(c.id);
              return old !== undefined ? { ...c, volumeDB: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },


});

// ========== Quantize Clips (appended) ==========
