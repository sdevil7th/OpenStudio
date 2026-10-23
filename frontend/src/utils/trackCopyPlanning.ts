export interface TrackCopySource {
  id: string;
  parentFolderId?: string;
  isFolder?: boolean;
}

function isDescendantOf(track: TrackCopySource, ancestorId: string, tracksById: ReadonlyMap<string, TrackCopySource>): boolean {
  const visited = new Set<string>([track.id]);
  let parentId = track.parentFolderId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = tracksById.get(parentId)?.parentFolderId;
  }
  return false;
}

export function trackDragSourceIds(
  tracks: readonly TrackCopySource[],
  selectedIds: readonly string[],
  draggedId: string,
): string[] {
  const targets = new Set(selectedIds.includes(draggedId) ? selectedIds : [draggedId]);
  return trackCopySourceIds(tracks, [...targets]);
}

/** A folder is copied with its complete subtree, including collapsed children. */
export function trackCopySourceIds(tracks: readonly TrackCopySource[], selectedIds: readonly string[]): string[] {
  const targets = new Set(selectedIds);
  const folders = tracks.filter((track) => track.isFolder && targets.has(track.id));
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return tracks.filter((track) => targets.has(track.id)
    || folders.some((folder) => isDescendantOf(track, folder.id, byId))).map((track) => track.id);
}

export function insertTrackCopies<T extends TrackCopySource>(
  tracks: readonly T[],
  copies: readonly { sourceTrack: T; duplicate: T }[],
  beforeTrackId?: string,
): T[] {
  const beforeIndex = beforeTrackId ? tracks.findIndex((track) => track.id === beforeTrackId) : -1;
  const copiedSourceIds = new Set(copies.map(({ sourceTrack }) => sourceTrack.id));
  const roots = copies.filter(({ sourceTrack }) => !sourceTrack.parentFolderId || !copiedSourceIds.has(sourceTrack.parentFolderId));
  if (beforeIndex >= 0) {
    const rootIds = new Set(roots.map(({ sourceTrack }) => sourceTrack.id));
    const parentFolderId = tracks[beforeIndex].parentFolderId;
    const inserted = copies.map(({ sourceTrack, duplicate }) => rootIds.has(sourceTrack.id)
      ? { ...duplicate, parentFolderId }
      : duplicate);
    return [...tracks.slice(0, beforeIndex), ...inserted, ...tracks.slice(beforeIndex)];
  }
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const afterSubtree = new Map<string, T[]>();
  for (const { sourceTrack } of roots) {
    const subtree = tracks.filter((track) => track.id === sourceTrack.id || isDescendantOf(track, sourceTrack.id, tracksById));
    const lastTrack = subtree[subtree.length - 1];
    if (!lastTrack) continue;
    afterSubtree.set(lastTrack.id, copies.filter((copy) => copy.sourceTrack.id === sourceTrack.id
      || isDescendantOf(copy.sourceTrack, sourceTrack.id, tracksById)).map(({ duplicate }) => duplicate));
  }
  return tracks.flatMap((track) => {
    return [track, ...(afterSubtree.get(track.id) ?? [])];
  });
}
