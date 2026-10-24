import { resolveTimelineDragAxisLock, type TimelineDragAxisLock } from "./timelineDragAxisLock";

/** Once a ruler gesture starts, diagonal movement keeps its original intent. */
export function resolveRulerDragAxis(
  currentAxis: TimelineDragAxisLock | null | undefined,
  deltaX: number,
  deltaY: number,
): TimelineDragAxisLock | null {
  return resolveTimelineDragAxisLock(true, currentAxis, deltaX, deltaY, 4);
}

/** Down zooms in and up zooms out, anchored to the pointer-down time. */
export function getRulerDragZoom(
  initialZoom: number,
  deltaY: number,
  anchorTime: number,
  anchorX: number,
): { pixelsPerSecond: number; scrollX: number } {
  const pixelsPerSecond = Math.max(1, Math.min(1000, initialZoom * Math.exp(deltaY * 0.012)));
  return { pixelsPerSecond, scrollX: Math.max(0, anchorTime * pixelsPerSecond - anchorX) };
}
