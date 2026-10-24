import type { Track } from "../store/useDAWStore";

export interface TimelineCopySource {
  clipId: string;
  sourceTrackId: string;
  originalStartTime: number;
  duration: number;
  isMidi: boolean;
}

type CopyTrack = Pick<Track, "id" | "type" | "isFolder" | "frozen">;

export interface TimelineClipCopyPlan {
  targetAnchorRowIndex: number;
  placements: Array<TimelineCopySource & {
    sourceRowIndex: number;
    targetRowIndex: number;
    targetTrackId?: string;
  }>;
  newTracks: Array<{ rowIndex: number; type: "audio" | "midi" }>;
}

/** Plan the entire group before preview or commit, using IDs across collapsed folders. */
export function planTimelineClipCopy({ sources, tracks, visibleTrackIds, anchorTrackId, targetRowIndex }: {
  sources: readonly TimelineCopySource[];
  tracks: readonly CopyTrack[];
  visibleTrackIds: readonly string[];
  anchorTrackId: string;
  targetRowIndex: number;
}): TimelineClipCopyPlan | null {
  const anchorRow = visibleTrackIds.indexOf(anchorTrackId);
  const anchorFullIndex = tracks.findIndex(track => track.id === anchorTrackId);
  if (!sources.length || anchorRow < 0 || anchorFullIndex < 0
    || sources.some(source => !tracks.some(track => track.id === source.sourceTrackId))) return null;

  // A selected hidden source still belongs to the group. In that case retain
  // full-list spacing and publish the whole group on visible, generated rows.
  const hasHiddenSource = sources.some(source => !visibleTrackIds.includes(source.sourceTrackId));
  const rows = sources.map(source => ({
    ...source,
    sourceRowIndex: hasHiddenSource
      ? anchorRow + tracks.findIndex(track => track.id === source.sourceTrackId) - anchorFullIndex
      : visibleTrackIds.indexOf(source.sourceTrackId),
  }));
  const firstRow = Math.min(...rows.map(source => source.sourceRowIndex));
  const lastRow = Math.max(...rows.map(source => source.sourceRowIndex));
  const targetAnchorRowIndex = Math.max(anchorRow - firstRow, Math.trunc(targetRowIndex));
  const delta = targetAnchorRowIndex - anchorRow;
  const existing = rows.map(source => {
    const rowIndex = source.sourceRowIndex + delta;
    const track = tracks.find(candidate => candidate.id === visibleTrackIds[rowIndex]);
    const midi = track?.type === "midi" || track?.type === "instrument";
    const compatible = track && !track.isFolder && !track.frozen && midi === source.isMidi;
    return { ...source, targetRowIndex: rowIndex, targetTrackId: compatible ? track.id : undefined };
  });
  if (!hasHiddenSource && existing.every(placement => placement.targetTrackId)) {
    return { targetAnchorRowIndex, placements: existing, newTracks: [] };
  }

  // Appending only incompatible members would split or reorder a mixed group.
  // Generate its entire row span instead, including gaps, so preview and drop agree.
  const start = visibleTrackIds.length;
  const placements = rows.map(source => ({ ...source, targetRowIndex: start + source.sourceRowIndex - firstRow }));
  const newTracks = Array.from({ length: lastRow - firstRow + 1 }, (_, offset) => {
    const source = rows.find(row => row.sourceRowIndex === firstRow + offset);
    return { rowIndex: start + offset, type: source?.isMidi ? "midi" as const : "audio" as const };
  });
  return { targetAnchorRowIndex, placements, newTracks };
}
