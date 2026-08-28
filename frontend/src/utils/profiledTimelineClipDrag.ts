import type { PointerModifierEventLike } from "./mouseModifierResolver";
import { shouldBypassTimelineDragSnap } from "./timelineClipEdgeSnap";
import {
  getTimelineAxisLockedDeltas,
  type TimelineDragAxisLock,
} from "./timelineDragAxisLock";

export interface ProfiledTimelineClipDragInput {
  profileId: unknown;
  copyOnDrag: boolean;
  snapBypassRequested: boolean;
  preserveTimeRequested: boolean;
  axisLockRequested: boolean;
  axisLock: TimelineDragAxisLock | null | undefined;
  rawDeltaX: number;
  rawDeltaY: number;
  /** Current pointer modifiers. Omit only when an event cannot provide them. */
  liveModifiers?: PointerModifierEventLike;
}

export interface ProfiledTimelineClipDragResolution {
  effectiveSnapBypass: boolean;
  preserveTime: boolean;
  axisLockRequested: boolean;
  axisLock: TimelineDragAxisLock | null;
  deltaX: number;
  deltaY: number;
}

/**
 * Resolves the two source-DAW clip-drag behaviors whose meaning can change
 * after pointer-down:
 *
 * - Studio One: Shift temporarily bypasses snap while an existing move drag
 *   is in progress. Releasing Shift restores snap on the next pointer event.
 * - Mixcraft: Shift compounds an established Alt-copy drag with a fixed time
 *   offset. Releasing Shift restores an ordinary copy drag.
 *
 * Other profiles retain the intent captured at pointer-down. Keeping this
 * logic pure makes audio and MIDI drags share exactly the same behavior.
 */
export function resolveProfiledTimelineClipDrag(
  input: ProfiledTimelineClipDragInput,
): ProfiledTimelineClipDragResolution {
  const profileId = typeof input.profileId === "string" ? input.profileId : "openstudio";
  const hasLiveModifiers = input.liveModifiers !== undefined;
  const liveShift = Boolean(input.liveModifiers?.shiftKey);

  const preserveTime = profileId === "mixcraft" && input.copyOnDrag && hasLiveModifiers
    ? liveShift
    : input.preserveTimeRequested;
  const snapBypassRequested = input.snapBypassRequested
    || (profileId === "studio_one" && liveShift);

  if (preserveTime) {
    return {
      effectiveSnapBypass: false,
      preserveTime: true,
      axisLockRequested: true,
      axisLock: "y",
      deltaX: 0,
      deltaY: input.rawDeltaY,
    };
  }

  const constrained = getTimelineAxisLockedDeltas(
    input.axisLockRequested,
    input.axisLock,
    input.rawDeltaX,
    input.rawDeltaY,
  );
  return {
    effectiveSnapBypass: shouldBypassTimelineDragSnap(
      snapBypassRequested,
      input.copyOnDrag,
    ),
    preserveTime: false,
    axisLockRequested: input.axisLockRequested,
    ...constrained,
  };
}

export interface TimelineCopyDropNoopInput {
  originalStartTime: number;
  previewStartTime: number;
  pixelsPerSecond: number;
  anchorTrackIndex: number;
  targetTrackIndex: number;
  showGhostTrack: boolean;
}

/** A click or a time-preserving copy that never reaches another track is a no-op. */
export function isTimelineCopyDropNoop(input: TimelineCopyDropNoopInput): boolean {
  const movedPixels = Math.abs(input.previewStartTime - input.originalStartTime)
    * Math.max(0, input.pixelsPerSecond);
  return movedPixels <= 4
    && input.targetTrackIndex === input.anchorTrackIndex
    && !input.showGhostTrack;
}
