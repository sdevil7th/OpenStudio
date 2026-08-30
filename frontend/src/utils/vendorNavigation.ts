const TIME_EPSILON = 1e-7;

export type NavigationDirection = "previous" | "next";

export interface TimelineBoundaryClip {
  startTime: number;
  duration: number;
}

export interface TimelineBoundaryTrack {
  clips: readonly TimelineBoundaryClip[];
  midiClips: readonly TimelineBoundaryClip[];
}

export interface TimelineBoundaryMarker {
  time: number;
}

export interface TimelineTimeSelection {
  start: number;
  end: number;
}

function asTimelineTime(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

/**
 * Resolve a strict previous/next grid line. A playhead already on a grid line
 * advances by one whole division instead of resolving back to itself.
 */
export function resolveAdjacentGridLineTime(
  currentTime: number,
  gridInterval: number,
  direction: NavigationDirection,
): number | null {
  if (!Number.isFinite(currentTime) || !Number.isFinite(gridInterval) || gridInterval <= 0) {
    return null;
  }

  const clampedTime = Math.max(0, currentTime);
  const position = clampedTime / gridInterval;
  const nearestIndex = Math.round(position);
  const isOnGrid = Math.abs(position - nearestIndex) <= TIME_EPSILON;
  const targetIndex = direction === "next"
    ? (isOnGrid ? nearestIndex + 1 : Math.ceil(position))
    : (isOnGrid ? nearestIndex - 1 : Math.floor(position));
  const target = Math.max(0, targetIndex * gridInterval);

  if (Math.abs(target - clampedTime) <= TIME_EPSILON) return null;
  return target;
}

/**
 * Audition's adjacent-boundary command considers marker positions, both clip
 * edges, and both time-selection edges. Duplicate/tied boundaries collapse to
 * one time so navigation never stalls on overlapping clips or markers.
 */
export function collectTimelineBoundaryTimes({
  tracks,
  markers,
  timeSelection,
}: {
  tracks: readonly TimelineBoundaryTrack[];
  markers: readonly TimelineBoundaryMarker[];
  timeSelection: TimelineTimeSelection | null;
}): number[] {
  const times: number[] = [];
  const pushTime = (value: number) => {
    const time = asTimelineTime(value);
    if (time !== null) times.push(time);
  };

  for (const marker of markers) pushTime(marker.time);
  for (const track of tracks) {
    for (const clip of [...track.clips, ...track.midiClips]) {
      if (!Number.isFinite(clip.startTime) || !Number.isFinite(clip.duration)) continue;
      pushTime(clip.startTime);
      pushTime(clip.startTime + Math.max(0, clip.duration));
    }
  }
  if (timeSelection) {
    pushTime(timeSelection.start);
    pushTime(timeSelection.end);
  }

  return times
    .sort((left, right) => left - right)
    .filter((time, index, sorted) => index === 0 || Math.abs(time - sorted[index - 1]) > TIME_EPSILON);
}

export function resolveAdjacentTimelineBoundary(
  currentTime: number,
  boundaryTimes: readonly number[],
  direction: NavigationDirection,
): number | null {
  if (!Number.isFinite(currentTime)) return null;
  const clampedTime = Math.max(0, currentTime);
  const validTimes = boundaryTimes
    .map(asTimelineTime)
    .filter((time): time is number => time !== null)
    .sort((left, right) => left - right);

  if (direction === "next") {
    return validTimes.find((time) => time > clampedTime + TIME_EPSILON) ?? null;
  }
  for (let index = validTimes.length - 1; index >= 0; index -= 1) {
    if (validTimes[index] < clampedTime - TIME_EPSILON) return validTimes[index];
  }
  return null;
}

export function collectClipIdsInsideTimeSelection(
  tracks: ReadonlyArray<{
    clips: ReadonlyArray<TimelineBoundaryClip & { id: string }>;
    midiClips: ReadonlyArray<TimelineBoundaryClip & { id: string }>;
  }>,
  timeSelection: TimelineTimeSelection | null,
): string[] {
  if (!timeSelection || !Number.isFinite(timeSelection.start) || !Number.isFinite(timeSelection.end)) {
    return [];
  }
  const selectionStart = Math.max(0, Math.min(timeSelection.start, timeSelection.end));
  const selectionEnd = Math.max(0, Math.max(timeSelection.start, timeSelection.end));

  return tracks.flatMap((track) => [...track.clips, ...track.midiClips]
    .filter((clip) => {
      if (!Number.isFinite(clip.startTime) || !Number.isFinite(clip.duration)) return false;
      const start = Math.max(0, clip.startTime);
      const end = Math.max(0, clip.startTime + Math.max(0, clip.duration));
      return start >= selectionStart - TIME_EPSILON && end <= selectionEnd + TIME_EPSILON;
    })
    .map((clip) => clip.id));
}
