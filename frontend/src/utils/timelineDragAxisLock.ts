export type TimelineDragAxisLock = "x" | "y";

export const TIMELINE_DRAG_AXIS_LOCK_THRESHOLD_PX = 6;

export function resolveTimelineDragAxisLock(
  requested: boolean,
  currentAxis: TimelineDragAxisLock | null | undefined,
  deltaX: number,
  deltaY: number,
  thresholdPx = TIMELINE_DRAG_AXIS_LOCK_THRESHOLD_PX,
): TimelineDragAxisLock | null {
  if (!requested) return null;
  if (currentAxis) return currentAxis;

  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (Math.max(absX, absY) < thresholdPx) return null;

  return absX >= absY ? "x" : "y";
}

export function getTimelineAxisLockedDeltas(
  requested: boolean,
  currentAxis: TimelineDragAxisLock | null | undefined,
  deltaX: number,
  deltaY: number,
  thresholdPx = TIMELINE_DRAG_AXIS_LOCK_THRESHOLD_PX,
): {
  axisLock: TimelineDragAxisLock | null;
  deltaX: number;
  deltaY: number;
} {
  const axisLock = resolveTimelineDragAxisLock(
    requested,
    currentAxis,
    deltaX,
    deltaY,
    thresholdPx,
  );

  if (!requested) return { axisLock: null, deltaX, deltaY };
  if (!axisLock) return { axisLock: null, deltaX: 0, deltaY: 0 };
  return axisLock === "x"
    ? { axisLock, deltaX, deltaY: 0 }
    : { axisLock, deltaX: 0, deltaY };
}

export interface TimelineDropTrackHit {
  trackIndex: number;
  isInClipArea: boolean;
}

/** Divider targets share the same hit band for native imports and clip moves. */
export function resolveTimelineInsertionIndex(
  absoluteY: number,
  rowYs: readonly number[],
  contentHeight: number,
  previousIndex?: number,
  band = 8,
): number | null {
  if (rowYs.length === 0) return 0;
  if (previousIndex !== undefined && previousIndex > 0 && previousIndex < rowYs.length
    && Math.abs(absoluteY - rowYs[previousIndex]) <= band) return previousIndex;
  for (let index = 1; index < rowYs.length; index++) {
    if (Math.abs(absoluteY - rowYs[index]) <= band / 2) return index;
  }
  return absoluteY >= contentHeight - band / 2 ? rowYs.length : null;
}

/** Resolve a vertical clip drop while keeping above-timeline drags on track 0. */
export function resolveTimelineDropTrackIndex(
  absoluteY: number,
  contentHeight: number,
  trackCount: number,
  hit: TimelineDropTrackHit | null,
): number {
  if (trackCount <= 0) return 0;
  if (absoluteY < 0) return 0;
  if (hit?.isInClipArea) return hit.trackIndex;
  if (absoluteY >= contentHeight) return trackCount;
  return hit?.trackIndex ?? Math.max(0, trackCount - 1);
}
