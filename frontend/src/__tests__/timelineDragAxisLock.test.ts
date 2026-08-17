import { describe, expect, it } from "vitest";
import {
  getTimelineAxisLockedDeltas,
  resolveTimelineDropTrackIndex,
  resolveTimelineDragAxisLock,
} from "../utils/timelineDragAxisLock";
import { canApplyTimelineHorizontalSnap } from "../utils/timelineClipEdgeSnap";

describe("timeline drag axis lock", () => {
  it("does not lock or move before the drag threshold", () => {
    expect(resolveTimelineDragAxisLock(true, null, 3, 5)).toBeNull();
    expect(getTimelineAxisLockedDeltas(true, null, 3, 5)).toEqual({
      axisLock: null,
      deltaX: 0,
      deltaY: 0,
    });
  });

  it("locks horizontally when horizontal movement dominates", () => {
    expect(resolveTimelineDragAxisLock(true, null, 12, 4)).toBe("x");
    expect(getTimelineAxisLockedDeltas(true, null, 12, 4)).toEqual({
      axisLock: "x",
      deltaX: 12,
      deltaY: 0,
    });
  });

  it("locks vertically when vertical movement dominates", () => {
    expect(resolveTimelineDragAxisLock(true, null, 4, 12)).toBe("y");
    expect(getTimelineAxisLockedDeltas(true, null, 4, 12)).toEqual({
      axisLock: "y",
      deltaX: 0,
      deltaY: 12,
    });
  });

  it("chooses horizontal lock on ties", () => {
    expect(resolveTimelineDragAxisLock(true, null, 8, -8)).toBe("x");
  });

  it("keeps an existing lock for the rest of the drag", () => {
    expect(resolveTimelineDragAxisLock(true, "y", 30, 1)).toBe("y");
    expect(getTimelineAxisLockedDeltas(true, "y", 30, 1)).toEqual({
      axisLock: "y",
      deltaX: 0,
      deltaY: 1,
    });
  });

  it("does not constrain deltas when Shift axis lock was not requested", () => {
    expect(getTimelineAxisLockedDeltas(false, null, 4, 12)).toEqual({
      axisLock: null,
      deltaX: 4,
      deltaY: 12,
    });
  });

  it("blocks horizontal snapping while Shift lock is pending or locked vertically", () => {
    expect(canApplyTimelineHorizontalSnap(true, null)).toBe(false);
    expect(canApplyTimelineHorizontalSnap(true, "y")).toBe(false);
    expect(canApplyTimelineHorizontalSnap(true, "x")).toBe(true);
    expect(canApplyTimelineHorizontalSnap(false, null)).toBe(true);
  });

  it("clamps a drag above the timeline to the first track", () => {
    expect(resolveTimelineDropTrackIndex(-12, 300, 3, null)).toBe(0);
    expect(resolveTimelineDropTrackIndex(-0.01, 300, 3, null)).toBe(0);
  });

  it("keeps normal hits and the below-track insertion target unchanged", () => {
    expect(resolveTimelineDropTrackIndex(120, 300, 3, {
      trackIndex: 1,
      isInClipArea: true,
    })).toBe(1);
    expect(resolveTimelineDropTrackIndex(301, 300, 3, null)).toBe(3);
    expect(resolveTimelineDropTrackIndex(-12, 0, 0, null)).toBe(0);
  });
});
