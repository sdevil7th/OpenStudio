import type { MouseModifierActionFor } from "./mouseModifierResolver";

export type AutomationPointDragAxis = "time" | "value" | null;

export interface AutomationPointDragGesture {
  action: MouseModifierActionFor<"automation_point">;
  originalX: number;
  originalY: number;
  originalTime: number;
  originalValue: number;
  axisLock: AutomationPointDragAxis;
}

export interface AutomationPointDragOptions {
  rawX: number;
  rawY: number;
  scrollX: number;
  pixelsPerSecond: number;
  laneTop: number;
  laneHeight: number;
  snapEnabled: boolean;
  snapTime: (time: number, originalTime: number) => number;
}

export interface AutomationPointDragResult {
  x: number;
  y: number;
  time: number;
  value: number;
  axisLock: AutomationPointDragAxis;
  timeLocked: boolean;
  valueLocked: boolean;
  snapApplied: boolean;
}

const AXIS_LOCK_THRESHOLD_PX = 2;

const finiteOr = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

/**
 * Resolves an automation-point pointer preview without changing project state.
 *
 * The semantic constraint names describe the axis on which the point moves:
 * - constrain_x: move in time while preserving the original Y/value
 * - constrain_y: move in value while preserving the original X/time
 * - constrain_axis: choose one of those axes after a small movement threshold
 * Compound `_bypass_snap` actions preserve their adjustment semantics while
 * skipping Timeline snapping; a second modifier never silently erases the
 * first modifier's constraint or fine-adjustment meaning.
 */
export function resolveAutomationPointDrag(
  gesture: AutomationPointDragGesture,
  options: AutomationPointDragOptions,
): AutomationPointDragResult {
  const rawX = finiteOr(options.rawX, gesture.originalX);
  const rawY = finiteOr(options.rawY, gesture.originalY);
  const pixelsPerSecond = Math.max(1, finiteOr(options.pixelsPerSecond, 1));
  const scrollX = Math.max(0, finiteOr(options.scrollX, 0));
  const laneTop = finiteOr(options.laneTop, 0);
  const laneHeight = Math.max(1, finiteOr(options.laneHeight, 1));
  const laneBottom = laneTop + laneHeight;

  let axisLock = gesture.axisLock;
  const constrainAxis = gesture.action === "constrain_axis"
    || gesture.action === "constrain_axis_bypass_snap"
    || gesture.action === "copy_constrain_axis";
  const constrainX = gesture.action === "constrain_x"
    || gesture.action === "constrain_x_bypass_snap";
  const constrainY = gesture.action === "constrain_y"
    || gesture.action === "constrain_y_bypass_snap";
  const fine = gesture.action === "fine"
    || gesture.action === "fine_bypass_snap";
  const bypassSnap = gesture.action === "bypass_snap"
    || gesture.action === "fine_bypass_snap"
    || gesture.action === "constrain_x_bypass_snap"
    || gesture.action === "constrain_y_bypass_snap"
    || gesture.action === "constrain_axis_bypass_snap";

  if (constrainAxis && axisLock === null) {
    const deltaX = Math.abs(rawX - gesture.originalX);
    const deltaY = Math.abs(rawY - gesture.originalY);
    if (Math.max(deltaX, deltaY) >= AXIS_LOCK_THRESHOLD_PX) {
      axisLock = deltaX >= deltaY ? "time" : "value";
    }
  }

  const timeLocked = constrainY || axisLock === "value";
  const valueLocked = constrainX || axisLock === "time";
  const adjustedX = timeLocked
    ? gesture.originalX
    : fine
      ? gesture.originalX + (rawX - gesture.originalX) * 0.1
      : rawX;
  const adjustedY = valueLocked
    ? gesture.originalY
    : fine
      ? gesture.originalY + (rawY - gesture.originalY) * 0.1
      : rawY;

  const clampedX = Math.max(-scrollX, adjustedX);
  const clampedY = Math.max(laneTop, Math.min(laneBottom, adjustedY));
  const rawTime = timeLocked
    ? Math.max(0, gesture.originalTime)
    : Math.max(0, (clampedX + scrollX) / pixelsPerSecond);
  const snapApplied = !timeLocked
    && options.snapEnabled
    && !bypassSnap;
  const snappedTime = snapApplied
    ? finiteOr(options.snapTime(rawTime, gesture.originalTime), rawTime)
    : rawTime;
  const time = Math.max(0, snappedTime);
  const value = valueLocked
    ? Math.max(0, Math.min(1, gesture.originalValue))
    : Math.max(0, Math.min(1, 1 - (clampedY - laneTop) / laneHeight));

  return {
    x: time * pixelsPerSecond - scrollX,
    y: laneTop + laneHeight * (1 - value),
    time,
    value,
    axisLock,
    timeLocked,
    valueLocked,
    snapApplied,
  };
}
