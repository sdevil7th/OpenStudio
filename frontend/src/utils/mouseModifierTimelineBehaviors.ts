import {
  computeTimelineResize,
  type TimelineResizeInput,
  type TimelineResizeResult,
} from "./timelineClipGestures";
import { computeTimelineStretchGeometry } from "./timelineClipStretch";
import type {
  MouseModifierAction,
  MouseModifierContext,
} from "./mouseModifierResolver";

export type ImplementedClipResizeAction = "resize" | "fine" | "symmetric" | "stretch";

export interface MouseModifierResizeInput extends TimelineResizeInput {
  action: ImplementedClipResizeAction;
}

export interface SafeMouseModifierNoop {
  context: MouseModifierContext;
  action: MouseModifierAction;
  reason: string;
}

export const FINE_MOUSE_POINTER_SCALE = 0.1;
export const CLIP_FADE_SHAPE_COUNT = 5;

export const SAFE_MOUSE_MODIFIER_NOOPS: readonly SafeMouseModifierNoop[] = [];

export function getSafeMouseModifierNoop(
  context: MouseModifierContext,
  action: MouseModifierAction,
): SafeMouseModifierNoop | null {
  return SAFE_MOUSE_MODIFIER_NOOPS.find(
    (entry) => entry.context === context && entry.action === action,
  ) ?? null;
}

export function getNextClipFadeShape(currentShape: number | undefined): number {
  const normalized = typeof currentShape === "number" && Number.isFinite(currentShape)
    ? Math.max(0, Math.min(CLIP_FADE_SHAPE_COUNT - 1, Math.trunc(currentShape)))
    : 0;
  return (normalized + 1) % CLIP_FADE_SHAPE_COUNT;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function computeSymmetricResize(input: TimelineResizeInput): TimelineResizeResult {
  const minDuration = input.minDuration ?? (input.isMidi ? 0.01 : 0.1);
  const sourceLimit = !input.isMidi && input.sourceLength !== undefined
    ? input.sourceLength
    : undefined;
  const originalEnd = input.originalStartTime + input.originalDuration;
  let deltaTime = input.deltaTime;

  if (input.snapTime) {
    if (input.kind === "resize-left") {
      deltaTime = input.snapTime(input.originalStartTime + deltaTime)
        - input.originalStartTime;
    } else {
      deltaTime = input.snapTime(originalEnd + deltaTime) - originalEnd;
    }
  }

  if (input.kind === "resize-left") {
    const minimumDelta = Math.max(
      -input.originalStartTime,
      -input.originalOffset,
      sourceLimit === undefined
        ? Number.NEGATIVE_INFINITY
        : input.originalOffset + input.originalDuration - sourceLimit,
    );
    const maximumDelta = (input.originalDuration - minDuration) / 2;
    const appliedDelta = clamp(deltaTime, minimumDelta, maximumDelta);
    return {
      startTime: input.originalStartTime + appliedDelta,
      duration: Math.max(minDuration, input.originalDuration - appliedDelta * 2),
      offset: Math.max(0, input.originalOffset + appliedDelta),
    };
  }

  const minimumDelta = (minDuration - input.originalDuration) / 2;
  const maximumDelta = Math.min(
    input.originalStartTime,
    input.originalOffset,
    sourceLimit === undefined
      ? Number.POSITIVE_INFINITY
      : sourceLimit - input.originalOffset - input.originalDuration,
  );
  const appliedDelta = clamp(deltaTime, minimumDelta, maximumDelta);
  return {
    startTime: input.originalStartTime - appliedDelta,
    duration: Math.max(minDuration, input.originalDuration + appliedDelta * 2),
    offset: Math.max(0, input.originalOffset - appliedDelta),
  };
}

export function computeMouseModifierTimelineResize(
  input: MouseModifierResizeInput,
): TimelineResizeResult {
  if (input.action === "stretch") {
    const stretched = computeTimelineStretchGeometry({
      kind: input.kind,
      originalStartTime: input.originalStartTime,
      originalDuration: input.originalDuration,
      originalOffset: input.originalOffset,
      deltaTime: input.deltaTime,
      minDuration: input.minDuration ?? (input.isMidi ? 0.01 : 0.1),
      snapTime: input.snapTime,
    });
    return {
      startTime: stretched.startTime,
      duration: stretched.duration,
      offset: stretched.offset,
    };
  }
  if (input.action === "symmetric") return computeSymmetricResize(input);
  return computeTimelineResize({
    ...input,
    deltaTime: input.action === "fine"
      ? input.deltaTime * FINE_MOUSE_POINTER_SCALE
      : input.deltaTime,
  });
}
