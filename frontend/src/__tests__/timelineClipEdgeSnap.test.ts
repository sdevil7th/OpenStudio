import { describe, expect, it } from "vitest";
import {
  clampTimelineClipGroupDelta,
  isTimelineClipEdgeSnapMode,
  resolveTimelineClipEdgeSnap,
  snapshotTimelineClipGeometry,
  shouldBypassTimelineDragSnap,
  shouldStartTimelineCopyDrag,
  type TimelineClipSnapShape,
} from "../utils/timelineClipEdgeSnap";

const viewport = {
  startTime: 0,
  endTime: 20,
  visibleTrackIndices: [0, 1, 2],
};

const shape = (
  clipId: string,
  startTime: number,
  duration: number,
  trackIndex = 0,
): TimelineClipSnapShape => ({ clipId, startTime, duration, trackIndex });

describe("timeline clip edge snapping", () => {
  it("snapshots both audio and MIDI geometry at drag start", () => {
    const audioClip = { id: "audio", startTime: 1, duration: 2, locked: false };
    const midiClip = { id: "midi", startTime: 4, duration: 3, locked: true };
    const snapshot = snapshotTimelineClipGeometry([{
      clips: [audioClip],
      midiClips: [midiClip],
    }]);

    audioClip.startTime = 99;
    midiClip.duration = 99;

    expect(snapshot).toEqual([
      shape("audio", 1, 2),
      shape("midi", 4, 3),
    ]);
  });

  it("treats Ctrl as copy rather than snap bypass once copy-drag is established", () => {
    expect(shouldBypassTimelineDragSnap(true, true)).toBe(false);
    expect(shouldBypassTimelineDragSnap(true, false)).toBe(true);
    expect(shouldBypassTimelineDragSnap(false, true)).toBe(false);
    expect(shouldBypassTimelineDragSnap(false, false)).toBe(false);
  });

  it("starts copy-drag only for an unlocked move gesture", () => {
    expect(shouldStartTimelineCopyDrag(true, "move", false)).toBe(true);
    expect(shouldStartTimelineCopyDrag(false, "move", false)).toBe(false);
    expect(shouldStartTimelineCopyDrag(true, "resize-left", false)).toBe(false);
    expect(shouldStartTimelineCopyDrag(true, "resize-right", false)).toBe(false);
    expect(shouldStartTimelineCopyDrag(true, "move", true)).toBe(false);
  });

  it.each([
    ["events", true],
    ["events_cursor", true],
    ["events_grid_cursor", true],
    ["shuffle", true],
    ["grid", false],
    ["grid_relative", false],
    ["cursor", false],
    ["grid_cursor", false],
  ] as const)("enables clip edges for %s only when event snapping is active", (mode, expected) => {
    expect(isTimelineClipEdgeSnapMode(mode)).toBe(expected);
  });

  it.each([
    {
      name: "start to start",
      moving: shape("moving", 2.92, 1),
      target: shape("target", 3, 2),
      movingEdge: "start",
      targetEdge: "start",
    },
    {
      name: "start to end",
      moving: shape("moving", 4.92, 1),
      target: shape("target", 3, 2),
      movingEdge: "start",
      targetEdge: "end",
    },
    {
      name: "end to start",
      moving: shape("moving", 1.92, 1),
      target: shape("target", 3, 2),
      movingEdge: "end",
      targetEdge: "start",
    },
    {
      name: "end to end",
      moving: shape("moving", 3.92, 1),
      target: shape("target", 3, 2),
      movingEdge: "end",
      targetEdge: "end",
    },
  ])("supports $name", ({ moving, target, movingEdge, targetEdge }) => {
    const result = resolveTimelineClipEdgeSnap({
      movingClips: [moving],
      stationaryClips: [target],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    });

    expect(result.match).toMatchObject({ movingEdge, targetEdge });
    expect(result.match?.distancePx).toBeCloseTo(8);
    expect(result.deltaTime).toBeCloseTo(0.08);
  });

  it("uses an inclusive 10 CSS-pixel threshold at any zoom", () => {
    const atThreshold = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 1, 1)],
      stationaryClips: [shape("target", 2.1, 1)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    });
    const outsideThreshold = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 1, 1)],
      stationaryClips: [shape("target", 2.051, 1)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 200,
    });

    expect(atThreshold.match?.distancePx).toBeCloseTo(10);
    expect(outsideThreshold.match).toBeNull();
  });

  it("uses only the individual moving and stationary edges visible in the viewport", () => {
    const result = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 0, 9.94)],
      stationaryClips: [shape("target", 1, 9)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport: { ...viewport, startTime: 5, endTime: 10 },
      pixelsPerSecond: 100,
    });

    expect(result.match).toMatchObject({
      movingEdge: "end",
      targetEdge: "end",
      targetTime: 10,
    });
    expect(result.deltaTime).toBeCloseTo(0.06);
  });

  it("does not use a clip whose body spans the viewport but both edges are hidden", () => {
    const result = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 1, 1)],
      stationaryClips: [shape("spanning", -2, 10)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport: { ...viewport, startTime: 0, endTime: 5 },
      pixelsPerSecond: 100,
    });

    expect(result.match).toBeNull();
  });

  it("requires both moving destination and stationary source tracks to be vertically visible", () => {
    const hiddenMoving = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 1.95, 1, 0)],
      stationaryClips: [shape("target", 3, 1, 1)],
      rawDeltaTime: 0,
      trackDelta: 2,
      viewport: { ...viewport, visibleTrackIndices: [0, 1] },
      pixelsPerSecond: 100,
    });
    const hiddenTarget = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 1.95, 1, 0)],
      stationaryClips: [shape("target", 3, 1, 2)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport: { ...viewport, visibleTrackIndices: [0, 1] },
      pixelsPerSecond: 100,
    });

    expect(hiddenMoving.match).toBeNull();
    expect(hiddenTarget.match).toBeNull();
  });

  it("excludes actual moving IDs but can include the source for copy previews", () => {
    const options = {
      movingClips: [shape("source", 2.95, 1)],
      stationaryClips: [shape("source", 2, 1)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    };

    expect(resolveTimelineClipEdgeSnap(options).match).toBeNull();
    expect(resolveTimelineClipEdgeSnap({
      ...options,
      excludeMovingClipIds: false,
    }).match).toMatchObject({
      movingEdge: "start",
      targetEdge: "end",
    });
  });

  it("keeps nonmoving selected clips eligible as stationary targets", () => {
    const result = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving-unlocked", 1.94, 1)],
      stationaryClips: [
        shape("moving-unlocked", 1, 1),
        shape("selected-but-locked", 3, 1),
      ],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    });

    expect(result.match).toMatchObject({
      movingClipId: "moving-unlocked",
      targetClipId: "selected-but-locked",
      movingEdge: "end",
      targetEdge: "start",
    });
  });

  it("lets a non-anchor edge drive one shared multi-clip delta", () => {
    const result = resolveTimelineClipEdgeSnap({
      movingClips: [
        shape("anchor", 1, 1, 0),
        shape("midi-peer", 6, 2, 1),
      ],
      stationaryClips: [shape("target", 8.08, 1, 2)],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    });

    expect(result.match).toMatchObject({
      movingClipId: "midi-peer",
      movingEdge: "end",
      targetEdge: "start",
    });
    expect(result.deltaTime).toBeCloseTo(0.08);
    expect(1 + result.deltaTime).toBeCloseTo(1.08);
    expect(6 + result.deltaTime).toBeCloseTo(6.08);
  });

  it("clamps the group once at time zero and rejects impossible snap corrections", () => {
    const moving = [shape("earliest", 0.25, 1), shape("anchor", 2, 1)];
    expect(clampTimelineClipGroupDelta(moving, -1)).toBe(-0.25);

    const result = resolveTimelineClipEdgeSnap({
      movingClips: moving,
      stationaryClips: [shape("target", 1.7, 1)],
      rawDeltaTime: -0.2,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    });

    expect(result.match).toBeNull();
    expect(result.deltaTime).toBeCloseTo(-0.2);
  });

  it("breaks equal-distance ties deterministically", () => {
    const result = resolveTimelineClipEdgeSnap({
      movingClips: [shape("moving", 2, 1)],
      stationaryClips: [
        shape("later", 3.05, 1),
        shape("earlier", 2.95, 1),
      ],
      rawDeltaTime: 0,
      trackDelta: 0,
      viewport,
      pixelsPerSecond: 100,
    });

    expect(result.match).toMatchObject({ targetClipId: "earlier", targetTime: 2.95 });
    expect(result.deltaTime).toBeCloseTo(-0.05);
  });
});
