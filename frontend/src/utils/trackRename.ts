export interface TrackRenameCandidate {
  id: string;
  name: string;
}

export interface TrackRenameChange {
  id: string;
  oldName: string;
  newName: string;
}

export type TrackNameEditKeyAction = "commit" | "cancel" | null;

export function shouldCommitTrackNameEdit(
  initialDraft: string,
  finalDraft: string,
): boolean {
  return initialDraft !== finalDraft;
}

export function getTrackNameEditKeyAction(
  key: string,
  isComposing: boolean,
  keyCode?: number,
): TrackNameEditKeyAction {
  if (isComposing || keyCode === 229) return null;
  if (key === "Enter") return "commit";
  if (key === "Escape") return "cancel";
  return null;
}

/**
 * Resolve the tracks affected by a name edit.
 *
 * An edited track that is outside the current selection is renamed alone.
 * Otherwise every selected track is returned in project/visual order so the
 * topmost selected track always receives the unsuffixed base name.
 */
export function resolveTrackRenameTargetIds(
  tracks: readonly TrackRenameCandidate[],
  selectedTrackIds: readonly string[],
  anchorTrackId: string,
): string[] {
  const anchorExists = tracks.some((track) => track.id === anchorTrackId);
  if (!anchorExists) return [];

  const selectedIds = new Set(selectedTrackIds);
  if (!selectedIds.has(anchorTrackId)) return [anchorTrackId];

  return tracks
    .filter((track) => selectedIds.has(track.id))
    .map((track) => track.id);
}

/** Build the atomic rename transaction in project/visual order. */
export function buildTrackRenameChanges(
  tracks: readonly TrackRenameCandidate[],
  targetTrackIds: readonly string[],
  baseName: string,
): TrackRenameChange[] {
  const targetIds = new Set(targetTrackIds);
  let targetIndex = 0;
  const changes: TrackRenameChange[] = [];

  for (const track of tracks) {
    if (!targetIds.has(track.id)) continue;

    const newName = targetIndex === 0 ? baseName : `${baseName} ${targetIndex}`;
    targetIndex += 1;

    if (track.name === newName) continue;
    changes.push({ id: track.id, oldName: track.name, newName });
  }

  return changes;
}
