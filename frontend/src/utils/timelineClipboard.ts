export interface TimelineClipboardTrack {
  id: string;
  type: string;
  isFolder?: boolean;
  frozen?: boolean;
}

export interface TimelineClipboardEntry<TClip = unknown> {
  clip: TClip;
  trackId: string;
}

export interface TimelinePasteTarget<TClip = unknown> extends TimelineClipboardEntry<TClip> {
  targetTrackId: string;
  isMidi: boolean;
}

export function isMIDIClipboardClip(clip: unknown): boolean {
  return Boolean(clip && Array.isArray((clip as { events?: unknown }).events));
}

export function canTrackAcceptTimelineClip(
  track: TimelineClipboardTrack | undefined,
  isMidi: boolean,
): boolean {
  if (!track || track.isFolder || track.frozen) return false;
  return isMidi
    ? track.type === "midi" || track.type === "instrument"
    : track.type !== "midi" && track.type !== "instrument";
}

/** Resolve every clipboard entry independently to a compatible, live destination track. */
export function resolveTimelinePasteTargets<TClip>(
  tracks: readonly TimelineClipboardTrack[],
  selectedTrackIds: readonly string[],
  entries: readonly TimelineClipboardEntry<TClip>[],
): TimelinePasteTarget<TClip>[] {
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const sourceTrackIds = [...new Set(entries.map((entry) => entry.trackId))];
  const selectedBySource = new Map(
    sourceTrackIds.map((sourceTrackId, index) => [sourceTrackId, selectedTrackIds[index]]),
  );

  return entries.flatMap((entry) => {
    const isMidi = isMIDIClipboardClip(entry.clip);
    const preferredIds = [selectedBySource.get(entry.trackId), entry.trackId]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const preferredTrack = preferredIds
      .map((id) => tracksById.get(id))
      .find((track) => canTrackAcceptTimelineClip(track, isMidi));
    const targetTrack = preferredTrack
      ?? tracks.find((track) => canTrackAcceptTimelineClip(track, isMidi));
    return targetTrack
      ? [{ ...entry, targetTrackId: targetTrack.id, isMidi }]
      : [];
  });
}
