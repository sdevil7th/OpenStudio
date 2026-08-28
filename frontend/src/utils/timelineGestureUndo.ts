import type { Command } from "../store/commands";

export interface TimelineGestureSnapshot<TTrack> {
  tracks: readonly TTrack[];
  selectedClipId: string | null;
  selectedClipIds: readonly string[];
  isModified: boolean;
}

export interface TimelineGestureCommandHooks<TTrack> {
  cloneTracks: (tracks: readonly TTrack[]) => TTrack[];
  applySnapshot: (snapshot: TimelineGestureSnapshot<TTrack>) => void;
  afterApply?: (
    previous: TimelineGestureSnapshot<TTrack>,
    next: TimelineGestureSnapshot<TTrack>,
  ) => void;
}

export interface TimelineTrackIdentity {
  id: string;
}

export interface TimelineTrackTopologyDelta<TTrack extends TimelineTrackIdentity> {
  added: readonly TTrack[];
  removed: readonly TTrack[];
}

export interface TimelineTrackTopologyHooks<TTrack extends TimelineTrackIdentity> {
  addTrack: (track: TTrack) => void | Promise<void>;
  syncContent: () => void | Promise<void>;
  removeTrack: (track: TTrack) => void | Promise<void>;
}

export function getTimelineTrackTopologyDelta<TTrack extends TimelineTrackIdentity>(
  previousTracks: readonly TTrack[],
  nextTracks: readonly TTrack[],
): TimelineTrackTopologyDelta<TTrack> {
  const previousIds = new Set(previousTracks.map((track) => track.id));
  const nextIds = new Set(nextTracks.map((track) => track.id));
  return {
    added: nextTracks.filter((track) => !previousIds.has(track.id)),
    removed: previousTracks.filter((track) => !nextIds.has(track.id)),
  };
}

/**
 * Reconcile native track topology around content synchronization. Added tracks
 * must exist before clips target them; removed tracks stay alive until their
 * clips and automation have been torn down. Removals still run if content sync
 * fails so a failed undo cannot strand an invisible native track.
 */
export async function reconcileTimelineTrackTopology<TTrack extends TimelineTrackIdentity>(
  previousTracks: readonly TTrack[],
  nextTracks: readonly TTrack[],
  hooks: TimelineTrackTopologyHooks<TTrack>,
): Promise<void> {
  const topology = getTimelineTrackTopologyDelta(previousTracks, nextTracks);
  for (const track of topology.added) await hooks.addTrack(track);
  try {
    await hooks.syncContent();
  } finally {
    for (const track of topology.removed) await hooks.removeTrack(track);
  }
}

/**
 * Build the single command that owns an already-previewed timeline gesture.
 * The caller pushes (rather than executes) this command because the `after`
 * snapshot is already live when the pointer gesture commits.
 */
export function createTimelineGestureUndoCommand<TTrack>(
  description: string,
  before: TimelineGestureSnapshot<TTrack>,
  after: TimelineGestureSnapshot<TTrack>,
  hooks: TimelineGestureCommandHooks<TTrack>,
): Command {
  const apply = (
    previous: TimelineGestureSnapshot<TTrack>,
    next: TimelineGestureSnapshot<TTrack>,
  ) => {
    hooks.applySnapshot({
      tracks: hooks.cloneTracks(next.tracks),
      selectedClipId: next.selectedClipId,
      selectedClipIds: [...next.selectedClipIds],
      isModified: next.isModified,
    });
    hooks.afterApply?.(previous, next);
  };

  return {
    type: "TIMELINE_CLIP_GESTURE",
    description,
    timestamp: Date.now(),
    execute: () => apply(before, after),
    undo: () => apply(after, before),
  };
}
