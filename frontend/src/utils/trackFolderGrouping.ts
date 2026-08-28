export interface FolderGroupingTrack {
  id: string;
  parentFolderId?: string;
}

export interface TrackFolderGroupPlan {
  /** Stable flattened order after inserting the folder and gathering subtrees. */
  orderedTrackIds: string[];
  /** Selected roots in their original project order. */
  selectedRootIds: string[];
  /** The hierarchy level inherited by the new folder. */
  parentFolderId?: string;
}

function normalizedParent(track: FolderGroupingTrack): string | undefined {
  return track.parentFolderId || undefined;
}

/**
 * Plan a DAW-style Group Tracks operation without mutating state. Selected
 * roots must share a hierarchy level. Their complete subtrees move together,
 * preserving the original order of every selected and unaffected track.
 */
export function buildTrackFolderGroupPlan(
  tracks: readonly FolderGroupingTrack[],
  selectedTrackIds: readonly string[],
  folderId: string,
): TrackFolderGroupPlan | null {
  if (!folderId || tracks.some((track) => track.id === folderId)) return null;
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  if (trackById.size !== tracks.length) return null;

  const requested = new Set(selectedTrackIds.filter((trackId) => trackById.has(trackId)));
  const selectedRootIds = tracks
    .filter((track) => requested.has(track.id))
    .map((track) => track.id);
  if (selectedRootIds.length === 0) return null;
  const selected = new Set(selectedRootIds);

  const commonParent = normalizedParent(trackById.get(selectedRootIds[0])!);
  if (selectedRootIds.some((trackId) => normalizedParent(trackById.get(trackId)!) !== commonParent)) {
    return null;
  }

  const ancestryCache = new Map<string, string[] | null>();
  const ancestryFor = (trackId: string): string[] | null => {
    const cached = ancestryCache.get(trackId);
    if (cached !== undefined) return cached;
    const ancestry: string[] = [];
    const visited = new Set([trackId]);
    let current = trackById.get(trackId);
    while (current?.parentFolderId) {
      const parentId = current.parentFolderId;
      if (visited.has(parentId) || !trackById.has(parentId)) {
        ancestryCache.set(trackId, null);
        return null;
      }
      visited.add(parentId);
      ancestry.push(parentId);
      current = trackById.get(parentId);
    }
    ancestryCache.set(trackId, ancestry);
    return ancestry;
  };

  for (const track of tracks) {
    if (ancestryFor(track.id) === null) return null;
  }
  for (const trackId of selectedRootIds) {
    if (ancestryFor(trackId)!.some((ancestorId) => selected.has(ancestorId))) return null;
  }

  const movingIds = new Set<string>();
  for (const track of tracks) {
    const ancestry = ancestryFor(track.id)!;
    if (selected.has(track.id) || ancestry.some((ancestorId) => selected.has(ancestorId))) {
      movingIds.add(track.id);
    }
  }

  const firstMovingIndex = tracks.findIndex((track) => movingIds.has(track.id));
  if (firstMovingIndex < 0) return null;
  const insertionIndex = tracks
    .slice(0, firstMovingIndex)
    .filter((track) => !movingIds.has(track.id))
    .length;
  const unaffectedIds = tracks
    .filter((track) => !movingIds.has(track.id))
    .map((track) => track.id);
  const movingInProjectOrder = tracks
    .filter((track) => movingIds.has(track.id))
    .map((track) => track.id);
  unaffectedIds.splice(insertionIndex, 0, folderId, ...movingInProjectOrder);

  return {
    orderedTrackIds: unaffectedIds,
    selectedRootIds,
    parentFolderId: commonParent,
  };
}
