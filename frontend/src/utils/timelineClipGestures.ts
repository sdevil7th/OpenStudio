export type TimelineClipGestureKind = "move" | "resize-left" | "resize-right";

export interface TimelineResizeInput {
  kind: Extract<TimelineClipGestureKind, "resize-left" | "resize-right">;
  isMidi: boolean;
  originalStartTime: number;
  originalDuration: number;
  originalOffset: number;
  deltaTime: number;
  minDuration?: number;
  sourceLength?: number;
  snapTime?: (time: number) => number;
}

export interface TimelineResizeResult {
  startTime: number;
  duration: number;
  offset: number;
}

export function classifyTimelineClipGesture(
  relativeX: number,
  width: number,
  edgeThreshold = 8,
): TimelineClipGestureKind {
  if (relativeX < edgeThreshold) return "resize-left";
  if (relativeX > width - edgeThreshold) return "resize-right";
  return "move";
}

export function computeTimelineMoveStart(
  originalStartTime: number,
  deltaTime: number,
  snapTime?: (time: number) => number,
): number {
  const rawStart = Math.max(0, originalStartTime + deltaTime);
  return snapTime ? Math.max(0, snapTime(rawStart)) : rawStart;
}

export function computeTimelineResize(input: TimelineResizeInput): TimelineResizeResult {
  const minDuration = input.minDuration ?? (input.isMidi ? 0.01 : 0.1);
  const originalEnd = input.originalStartTime + input.originalDuration;

  if (input.kind === "resize-left") {
    const minimumStart = input.isMidi
      ? Math.max(0, input.originalStartTime - input.originalOffset)
      : 0;
    const maximumStart = Math.max(minimumStart, originalEnd - minDuration);
    let startTime = Math.max(minimumStart, Math.min(maximumStart, input.originalStartTime + input.deltaTime));
    if (input.snapTime) {
      startTime = Math.max(minimumStart, Math.min(maximumStart, input.snapTime(startTime)));
    }

    const timeDiff = startTime - input.originalStartTime;
    return {
      startTime,
      duration: Math.max(minDuration, input.originalDuration - timeDiff),
      offset: Math.max(0, input.originalOffset + timeDiff),
    };
  }

  let duration = Math.max(minDuration, input.originalDuration + input.deltaTime);
  if (!input.isMidi && input.sourceLength !== undefined) {
    duration = Math.min(duration, Math.max(minDuration, input.sourceLength - input.originalOffset));
  }
  if (input.snapTime) {
    const snappedEnd = input.snapTime(input.originalStartTime + duration);
    duration = Math.max(minDuration, snappedEnd - input.originalStartTime);
    if (!input.isMidi && input.sourceLength !== undefined) {
      duration = Math.min(duration, Math.max(minDuration, input.sourceLength - input.originalOffset));
    }
  }

  return {
    startTime: input.originalStartTime,
    duration,
    offset: input.originalOffset,
  };
}

export function computeSlipOffset(
  originalOffset: number,
  deltaTime: number,
  maxOffset: number,
): number {
  return Math.max(0, Math.min(maxOffset, originalOffset - deltaTime));
}
