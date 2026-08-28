import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  copyAutomationPointsWithClips,
  moveAutomationPointsWithClips,
  shouldInvertAutomationFollowForClipDrag,
  shouldMoveAutomationWithItems,
  type AutomationClipMove,
} from "../store/actions/clipEditing";
import {
  createDefaultTrack,
  type AudioClip,
  type AutomationLane,
  type AutomationPoint,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function clip(id: string, startTime: number, duration = 2): AudioClip {
  return {
    id,
    name: id,
    filePath: `C:/audio/${id}.wav`,
    startTime,
    duration,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function lane(points: AutomationPoint[], id = "volume-lane"): AutomationLane {
  return {
    id,
    param: "volume",
    points,
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
  };
}

function track(
  id: string,
  clips: AudioClip[],
  points: AutomationPoint[],
  includeLane = true,
): Track {
  return {
    ...createDefaultTrack(id, id, "#38bdf8", "audio", []),
    clips,
    automationLanes: includeLane ? [lane(points, `${id}-volume`)] : [],
    showAutomation: true,
    automationReadEnabled: true,
    automationEnabled: true,
  };
}

function cloneTracks(tracks: Track[]): Track[] {
  return tracks.map((candidate) => ({
    ...candidate,
    clips: candidate.clips.map((item) => ({ ...item })),
    midiClips: candidate.midiClips.map((item) => ({ ...item })),
    automationLanes: candidate.automationLanes.map((automationLane) => ({
      ...automationLane,
      points: automationLane.points.map((point) => ({ ...point })),
    })),
  }));
}

function pointTimes(trackId: string) {
  return useDAWStore.getState().tracks
    .find((candidate) => candidate.id === trackId)
    ?.automationLanes.find((candidate) => candidate.param === "volume")
    ?.points.map((point) => [point.id, Number(point.time.toFixed(6))]);
}

beforeEach(() => {
  commandManager.clear();
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearAutomation").mockResolvedValue(true);
  useDAWStore.setState({
    tracks: [],
    selectedClipId: null,
    selectedClipIds: [],
    moveEnvelopesWithItems: true,
    autoCrossfade: false,
    lockSettings: {
      ...useDAWStore.getState().lockSettings,
      envelopes: false,
    },
    syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  commandManager.clear();
  vi.restoreAllMocks();
  useDAWStore.setState(originalState);
});

describe("automation follows item movement", () => {
  it("fans one source interval out to every repeat with fresh stable point ids", () => {
    const source = [track("track-a", [clip("clip-a", 1, 1)], [
      { id: "source", time: 1.5, value: 0.5 },
      { id: "outside", time: 5, value: 0.8 },
    ])];
    const current = cloneTracks(source);
    current[0].clips.push(clip("copy-a", 2, 1), clip("copy-b", 3, 1));
    const copied = copyAutomationPointsWithClips(current, [
      {
        clipId: "clip-a",
        sourceTrackId: "track-a",
        targetTrackId: "track-a",
        originalStartTime: 1,
        newStartTime: 2,
        duration: 1,
      },
      {
        clipId: "clip-a",
        sourceTrackId: "track-a",
        targetTrackId: "track-a",
        originalStartTime: 1,
        newStartTime: 3,
        duration: 1,
      },
    ], source);

    const points = copied[0].automationLanes[0].points;
    expect(points.map((point: AutomationPoint) => point.time)).toEqual([1.5, 2.5, 3.5, 5]);
    const copiedIds = points.filter((point: AutomationPoint) => point.time === 2.5 || point.time === 3.5)
      .map((point: AutomationPoint) => point.id);
    expect(new Set(copiedIds).size).toBe(2);
    expect(copiedIds).not.toContain("source");
  });

  it("duplicates and repeats item automation atomically with stable redo identities", () => {
    useDAWStore.setState({
      tracks: [track("track-a", [clip("clip-a", 1, 1)], [
        { id: "source", time: 1.5, value: 0.5 },
        { id: "destination-old", time: 2.5, value: 0.1 },
        { id: "outside", time: 5, value: 0.8 },
      ])],
      selectedClipId: "clip-a",
      selectedClipIds: ["clip-a"],
      moveEnvelopesWithItems: true,
    });

    const duplicateIds = useDAWStore.getState().duplicateSelectedClips();
    expect(duplicateIds).toHaveLength(1);
    let duplicatedPoints = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(duplicatedPoints.map((point) => point.time)).toEqual([1.5, 2.5, 5]);
    const duplicatedPointId = duplicatedPoints.find((point) => point.time === 2.5)!.id;
    expect(duplicatedPointId).not.toBe("source");
    expect(duplicatedPointId).not.toBe("destination-old");
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(pointTimes("track-a")).toEqual([
      ["source", 1.5],
      ["destination-old", 2.5],
      ["outside", 5],
    ]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points
      .find((point) => point.time === 2.5)?.id).toBe(duplicatedPointId);

    useDAWStore.getState().undo();
    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    useDAWStore.getState().repeatClip("clip-a", 2);
    const repeatedPoints = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(repeatedPoints.map((point) => point.time)).toEqual([1.5, 2.5, 3.5, 5]);
    const repeatedIds = repeatedPoints
      .filter((point) => point.time === 2.5 || point.time === 3.5)
      .map((point) => point.id);
    expect(new Set(repeatedIds).size).toBe(2);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points
      .filter((point) => point.time === 2.5 || point.time === 3.5)
      .map((point) => point.id)).toEqual(repeatedIds);
  });

  it("keeps deleted-item automation timeline-fixed and ripple-moves only surviving item ranges", () => {
    const locked = { ...clip("locked", 5, 1), locked: true };
    useDAWStore.setState({
      tracks: [track("track-a", [clip("delete", 1, 1), clip("move", 3, 1), locked], [
        { id: "outside", time: 0.5, value: 0.1 },
        { id: "deleted", time: 1.5, value: 0.2 },
        { id: "moving", time: 3.5, value: 0.3 },
        { id: "locked-point", time: 5.5, value: 0.4 },
      ])],
      selectedClipId: "delete",
      selectedClipIds: ["delete"],
      moveEnvelopesWithItems: true,
      rippleMode: "per_track",
    });

    expect(useDAWStore.getState().deleteSelectedClips()).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips.map((item) => [item.id, item.startTime]))
      .toEqual([["move", 2], ["locked", 5]]);
    expect(pointTimes("track-a")).toEqual([
      ["outside", 0.5],
      ["deleted", 1.5],
      ["moving", 2.5],
      ["locked-point", 5.5],
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.map((item) => [item.id, item.startTime]))
      .toEqual([["delete", 1], ["move", 3], ["locked", 5]]);
    expect(pointTimes("track-a")).toEqual([
      ["outside", 0.5],
      ["deleted", 1.5],
      ["moving", 3.5],
      ["locked-point", 5.5],
    ]);
    useDAWStore.getState().redo();
    expect(pointTimes("track-a")).toEqual([
      ["outside", 0.5],
      ["deleted", 1.5],
      ["moving", 2.5],
      ["locked-point", 5.5],
    ]);
  });

  it("moves only points in the original item interval and preserves stable IDs", () => {
    const source = [track("track-a", [clip("clip-a", 1)], [
      { id: "before", time: 0.5, value: 0.1 },
      { id: "start", time: 1, value: 0.2 },
      { id: "middle", time: 2, value: 0.3 },
      { id: "end", time: 3, value: 0.4 },
      { id: "after", time: 3.5, value: 0.5 },
    ])];
    const current = cloneTracks(source);
    current[0].clips[0].startTime = 4;

    const result = moveAutomationPointsWithClips(current, [{
      clipId: "clip-a",
      sourceTrackId: "track-a",
      targetTrackId: "track-a",
      originalStartTime: 1,
      newStartTime: 4,
      duration: 2,
    }], source);

    expect(result[0].automationLanes[0].points.map((point: AutomationPoint) => [point.id, point.time])).toEqual([
      ["before", 0.5],
      ["after", 3.5],
      ["start", 4],
      ["middle", 5],
      ["end", 6],
    ]);
  });

  it("moves multiple item ranges across tracks without moving a point twice", () => {
    const source = [
      track("track-a", [clip("clip-a", 1, 1), clip("clip-b", 4, 1)], [
        { id: "outside-a", time: 0.5, value: 0.1 },
        { id: "a", time: 1.25, value: 0.2 },
        { id: "a-end", time: 2, value: 0.3 },
        { id: "between", time: 2.5, value: 0.4 },
        { id: "b", time: 4.5, value: 0.5 },
        { id: "b-end", time: 5, value: 0.6 },
        { id: "outside-b", time: 6, value: 0.7 },
      ]),
      track("track-b", [], [{ id: "target-existing", time: 1, value: 0.8 }]),
    ];
    const current = cloneTracks(source);
    current[0].clips = [];
    current[1].clips = [clip("clip-a", 10, 1), clip("clip-b", 20, 1)];
    const moves: AutomationClipMove[] = [
      {
        clipId: "clip-a",
        sourceTrackId: "track-a",
        targetTrackId: "track-b",
        originalStartTime: 1,
        newStartTime: 10,
        duration: 1,
      },
      {
        clipId: "clip-b",
        sourceTrackId: "track-a",
        targetTrackId: "track-b",
        originalStartTime: 4,
        newStartTime: 20,
        duration: 1,
      },
    ];

    const result = moveAutomationPointsWithClips(current, moves, source);

    expect(result[0].automationLanes[0].points.map((point: AutomationPoint) => [point.id, point.time])).toEqual([
      ["outside-a", 0.5],
      ["between", 2.5],
      ["outside-b", 6],
    ]);
    expect(result[1].automationLanes[0].points.map((point: AutomationPoint) => [point.id, point.time])).toEqual([
      ["target-existing", 1],
      ["a", 10.25],
      ["a-end", 11],
      ["b", 20.5],
      ["b-end", 21],
    ]);
    expect(result[1].automationLanes[0].id).toBe("track-b-volume");
  });

  it("creates a matching target lane on a cross-track move", () => {
    const source = [
      track("track-a", [clip("clip-a", 1)], [{ id: "moving", time: 2, value: 0.4 }]),
      track("track-b", [], [], false),
    ];
    const current = cloneTracks(source);
    current[0].clips = [];
    current[1].clips = [clip("clip-a", 5)];

    const result = moveAutomationPointsWithClips(current, [{
      clipId: "clip-a",
      sourceTrackId: "track-a",
      targetTrackId: "track-b",
      originalStartTime: 1,
      newStartTime: 5,
      duration: 2,
    }], source);

    expect(result[0].automationLanes[0].points).toEqual([]);
    expect(result[1].automationLanes).toHaveLength(1);
    expect(result[1].automationLanes[0]).toMatchObject({
      id: "lane_volume_track-b",
      param: "volume",
      points: [{ id: "moving", time: 6, value: 0.4 }],
    });
  });

  it("returns the original collection for invalid or non-intersecting moves", () => {
    const source = [track("track-a", [clip("clip-a", 1)], [
      { id: "outside", time: 10, value: 0.4 },
    ])];
    expect(moveAutomationPointsWithClips(source, [], source)).toBe(source);
    expect(moveAutomationPointsWithClips(source, [{
      clipId: "clip-a",
      sourceTrackId: "track-a",
      targetTrackId: "track-a",
      originalStartTime: Number.NaN,
      newStartTime: 4,
      duration: 2,
    }], source)).toBe(source);
    expect(moveAutomationPointsWithClips(source, [{
      clipId: "clip-a",
      sourceTrackId: "track-a",
      targetTrackId: "track-a",
      originalStartTime: 1,
      newStartTime: 4,
      duration: 2,
    }], source)).toBe(source);
  });

  it.each([
    { preference: true, locked: false, follows: true },
    { preference: false, locked: false, follows: false },
    { preference: true, locked: true, follows: false },
  ])("nudges clip and automation atomically when follows=$follows", ({ preference, locked, follows }) => {
    useDAWStore.setState({
      tracks: [track("track-a", [clip("clip-a", 1)], [
        { id: "inside", time: 2, value: 0.5 },
        { id: "outside", time: 4, value: 0.8 },
      ])],
      selectedClipId: "clip-a",
      selectedClipIds: ["clip-a"],
      moveEnvelopesWithItems: preference,
      lockSettings: {
        ...useDAWStore.getState().lockSettings,
        envelopes: locked,
      },
    });

    useDAWStore.getState().nudgeClips("right", true);

    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(1.01);
    expect(pointTimes("track-a")).toEqual([
      ["inside", follows ? 2.01 : 2],
      ["outside", 4],
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(1);
    expect(pointTimes("track-a")).toEqual([
      ["inside", 2],
      ["outside", 4],
    ]);
    expect(commandManager.getRedoStack()).toHaveLength(1);
  });

  it("nudges multiple selected clips and their points in one undo command", () => {
    useDAWStore.setState({
      tracks: [track("track-a", [clip("clip-a", 1, 1), clip("clip-b", 4, 1)], [
        { id: "a", time: 1.5, value: 0.3 },
        { id: "b", time: 4.5, value: 0.7 },
      ])],
      selectedClipId: "clip-a",
      selectedClipIds: ["clip-a", "clip-b"],
      moveEnvelopesWithItems: true,
    });

    useDAWStore.getState().nudgeClips("right", true);

    expect(useDAWStore.getState().tracks[0].clips.map((item) => item.startTime)).toEqual([1.01, 4.01]);
    expect(pointTimes("track-a")).toEqual([
      ["a", 1.51],
      ["b", 4.51],
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.map((item) => item.startTime)).toEqual([1, 4]);
    expect(pointTimes("track-a")).toEqual([
      ["a", 1.5],
      ["b", 4.5],
    ]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips.map((item) => item.startTime)).toEqual([1.01, 4.01]);
    expect(pointTimes("track-a")).toEqual([
      ["a", 1.51],
      ["b", 4.51],
    ]);
  });

  it("moves a clip and its interval automation across tracks in one undo command", async () => {
    useDAWStore.setState({
      tracks: [
        track("track-a", [clip("clip-a", 1)], [
          { id: "outside-before", time: 0.5, value: 0.1 },
          { id: "inside", time: 2, value: 0.5 },
          { id: "outside-after", time: 4, value: 0.9 },
        ]),
        track("track-b", [], [{ id: "existing", time: 1, value: 0.4 }]),
      ],
      moveEnvelopesWithItems: true,
    });

    await useDAWStore.getState().moveClipToTrack("clip-a", "track-b", 5);

    expect(useDAWStore.getState().tracks[0].clips).toEqual([]);
    expect(useDAWStore.getState().tracks[1].clips[0]).toMatchObject({ id: "clip-a", startTime: 5 });
    expect(pointTimes("track-a")).toEqual([
      ["outside-before", 0.5],
      ["outside-after", 4],
    ]);
    expect(pointTimes("track-b")).toEqual([
      ["existing", 1],
      ["inside", 6],
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ id: "clip-a", startTime: 1 });
    expect(useDAWStore.getState().tracks[1].clips).toEqual([]);
    expect(pointTimes("track-a")).toEqual([
      ["outside-before", 0.5],
      ["inside", 2],
      ["outside-after", 4],
    ]);
    expect(pointTimes("track-b")).toEqual([["existing", 1]]);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips).toEqual([]);
    expect(useDAWStore.getState().tracks[1].clips[0]).toMatchObject({ id: "clip-a", startTime: 5 });
    expect(pointTimes("track-a")).toEqual([
      ["outside-before", 0.5],
      ["outside-after", 4],
    ]);
    expect(pointTimes("track-b")).toEqual([
      ["existing", 1],
      ["inside", 6],
    ]);
    expect(useDAWStore.getState().tracks[1].automationLanes[0].id).toBe("track-b-volume");
  });

  it("does not create history for missing targets or unchanged clip positions", async () => {
    useDAWStore.setState({
      tracks: [track("track-a", [clip("clip-a", 1)], [
        { id: "inside", time: 2, value: 0.5 },
      ])],
      moveEnvelopesWithItems: true,
    });

    await useDAWStore.getState().moveClipToTrack("missing", "track-a", 4);
    await useDAWStore.getState().moveClipToTrack("clip-a", "missing-track", 4);
    await useDAWStore.getState().moveClipToTrack("clip-a", "track-a", 1);

    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(1);
    expect(pointTimes("track-a")).toEqual([["inside", 2]]);
  });
});

describe("Cubase momentary automation-follow inversion", () => {
  it("XORs physical Shift with the persisted preference and never bypasses envelope lock", () => {
    expect(shouldInvertAutomationFollowForClipDrag("cubase", true, true)).toBe(true);
    expect(shouldInvertAutomationFollowForClipDrag("cubase", false, true)).toBe(false);
    expect(shouldInvertAutomationFollowForClipDrag("reaper", true, true)).toBe(false);
    expect(shouldInvertAutomationFollowForClipDrag("cubase", true, false)).toBe(false);

    expect(shouldMoveAutomationWithItems(true, false, false)).toBe(true);
    expect(shouldMoveAutomationWithItems(true, true, false)).toBe(false);
    expect(shouldMoveAutomationWithItems(false, false, false)).toBe(false);
    expect(shouldMoveAutomationWithItems(false, true, false)).toBe(true);
    expect(shouldMoveAutomationWithItems(false, true, true)).toBe(false);
  });
});
