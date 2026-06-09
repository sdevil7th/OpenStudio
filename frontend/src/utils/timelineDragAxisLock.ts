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
