import { afterEach, describe, expect, it } from "vitest";
import { createDefaultTrack, type AutomationLane, type Track, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import {
  _autoRecordTimers,
  _automationLatchedParams,
  _automationTouchedParams,
  _automationWriteValues,
  automationTouchKey,
} from "../store/actions/storeHelpers";

const initialState = useDAWStore.getState();

function makeTrack(overrides: Partial<Track> = {}): Track {
  const base = createDefaultTrack("track-auto", "Track Auto", "#14b8a6", "audio", []);
  return {
    ...base,
    ...overrides,
  };
}

function volumeLane(overrides: Partial<AutomationLane> = {}): AutomationLane {
  return {
    id: "vol",
    param: "volume",
    points: [],
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
    ...overrides,
  };
}

function loadTrack(track: Track, isPlaying = false, currentTime = 1) {
  useDAWStore.setState({
    tracks: [track],
    transport: {
      ...useDAWStore.getState().transport,
      isPlaying,
      currentTime,
    },
    automatedParamValues: {},
  });
}

afterEach(() => {
  useDAWStore.getState().endAutomationWriteSession?.();
  _automationTouchedParams.clear();
  _automationLatchedParams.clear();
  _automationWriteValues.clear();
  _autoRecordTimers.clear();
  commandManager.clear();
  useDAWStore.setState(initialState);
});

describe("Cubase-style automation read/write state", () => {
  it("new tracks start without readable automation", () => {
    const track = makeTrack();

    expect(track.automationLanes).toHaveLength(0);
    expect(track.automationReadEnabled).toBe(false);
    expect(track.automationWriteEnabled).toBe(false);
  });

  it("adding a track does not run mute automation write capture", () => {
    useDAWStore.setState({
      tracks: [],
      canUndo: false,
      canRedo: false,
    });

    expect(() => {
      useDAWStore.getState().addTrack({
        id: "track-added",
        name: "Added",
        type: "audio",
      });
    }).not.toThrow();

    expect(useDAWStore.getState().tracks.map((track) => track.id)).toContain("track-added");
    expect(useDAWStore.getState().canUndo).toBe(true);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).not.toContain("track-added");
  });

  it("enabling write also enables read", () => {
    const track = makeTrack({
      automationReadEnabled: false,
      automationWriteEnabled: false,
      automationEnabled: false,
      automationLanes: [volumeLane({ mode: "off" })],
    });
    loadTrack(track);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationReadEnabled).toBe(true);
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes[0].mode).toBe("touch");
  });

  it("toggles read only on empty tracks while write stays armed", () => {
    const track = makeTrack({
      automationReadEnabled: false,
      automationWriteEnabled: false,
      automationEnabled: false,
      automationLanes: [],
    });
    loadTrack(track);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    useDAWStore.getState().toggleTrackAutomationRead(track.id);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationReadEnabled).toBe(false);
    expect(updated.automationWriteEnabled).toBe(true);
  });

  it("toggles master read only with no master automation lanes while write stays armed", () => {
    useDAWStore.setState({
      masterAutomationLanes: [],
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
    });

    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().toggleMasterAutomationRead();

    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(false);
    expect(useDAWStore.getState().masterAutomationWriteEnabled).toBe(true);
  });

  it("disabling read keeps lanes and points visible but resolves backend mode off", () => {
    const track = makeTrack({
      showAutomation: true,
      automationReadEnabled: true,
      automationWriteEnabled: true,
      automationLanes: [volumeLane({ points: [{ time: 0.5, value: 0.8 }], mode: "touch" })],
    });
    loadTrack(track);

    useDAWStore.getState().setTrackAutomationRead(track.id, false);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.showAutomation).toBe(true);
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes[0].visible).toBe(true);
    expect(updated.automationLanes[0].points).toHaveLength(1);
    expect(updated.automationLanes[0].mode).toBe("off");
  });

  it("write can capture while track read is off without re-enabling read", () => {
    const track = makeTrack({
      automationReadEnabled: false,
      automationWriteEnabled: true,
      automationEnabled: false,
      automationLanes: [],
    });
    loadTrack(track, true, 2);

    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");
    useDAWStore.getState().setAutomationWriteValue(track.id, "volume", 0.75);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationReadEnabled).toBe(false);
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes).toHaveLength(1);
    expect(updated.automationLanes[0].readEnabled).toBe(true);
    expect(updated.automationLanes[0].mode).toBe("off");
    expect(updated.automationLanes[0].points).toEqual([{ time: 2, value: 0.75 }]);
  });

  it("write enabled with no touched parameter writes no points", () => {
    const track = makeTrack({
      automationReadEnabled: true,
      automationEnabled: true,
      automationLanes: [volumeLane()],
    });
    loadTrack(track, true, 2);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationLanes.find((lane) => lane.param === "volume")?.points).toHaveLength(0);
  });

  it("touching a parameter while stopped does not start a write session or create lanes", () => {
    const track = makeTrack({
      automationLanes: [],
      showAutomation: false,
    });
    loadTrack(track, false, 3);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");
    useDAWStore.getState().setAutomationWriteValue(track.id, "volume", 0.75);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);

    const key = automationTouchKey(track.id, "volume");
    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes).toHaveLength(0);
    expect(_automationTouchedParams.has(key)).toBe(false);
    expect(_automationLatchedParams.has(key)).toBe(false);
    expect(_automationWriteValues.has(key)).toBe(false);
  });

  it("touching an existing lane while stopped leaves write armed but inactive", () => {
    const track = makeTrack({
      automationReadEnabled: true,
      automationWriteEnabled: false,
      automationEnabled: true,
      automationLanes: [volumeLane()],
    });
    loadTrack(track, false, 3);

    useDAWStore.getState().setAutomationWriteBehavior("latch");
    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");
    useDAWStore.getState().setAutomationWriteValue(track.id, "volume", 0.75);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);

    const key = automationTouchKey(track.id, "volume");
    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes[0].mode).toBe("latch");
    expect(updated.automationLanes[0].points).toHaveLength(0);
    expect(_automationTouchedParams.has(key)).toBe(false);
    expect(_automationLatchedParams.has(key)).toBe(false);
  });

  it("touching a parameter with write enabled creates and writes a revealed lane", () => {
    const track = makeTrack({
      automationLanes: [],
      showAutomation: false,
    });
    loadTrack(track, true, 3);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");
    useDAWStore.getState().setAutomationWriteValue(track.id, "volume", 0.75);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);
    useDAWStore.getState().endAutomationParamTouch(track.id, "volume");

    const updated = useDAWStore.getState().tracks[0];
    const lane = updated.automationLanes.find((candidate) => candidate.param === "volume");
    expect(updated.showAutomation).toBe(true);
    expect(lane?.visible).toBe(true);
    expect(lane?.readEnabled).toBe(true);
    expect(lane?.points).toEqual([{ time: 3, value: 0.75 }]);
  });

  it("continuous touch writing simplifies simple ramps into sparse points", () => {
    const track = makeTrack({
      automationReadEnabled: true,
      automationEnabled: true,
      automationLanes: [volumeLane()],
    });
    loadTrack(track, true, 0);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");

    for (let i = 0; i <= 40; i += 1) {
      useDAWStore.setState((state) => ({
        transport: {
          ...state.transport,
          isPlaying: true,
          currentTime: i * 0.05,
        },
      }));
      useDAWStore.getState().setAutomationWriteValue(track.id, "volume", i / 40);
      useDAWStore.getState().recordAutomationWriteTick(1000 + i * 60);
    }

    const points = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(points.length).toBeLessThanOrEqual(6);
    expect(points[0]).toEqual({ time: 0, value: 0 });
    expect(points[points.length - 1].time).toBeCloseTo(2);
    expect(points[points.length - 1].value).toBeCloseTo(1);
  });

  it("global write behavior maps touch, latch, and overwrite to backend lane modes", () => {
    const track = makeTrack({
      automationReadEnabled: true,
      automationEnabled: true,
      automationLanes: [volumeLane()],
    });
    loadTrack(track);

    useDAWStore.getState().setTrackAutomationWrite(track.id, true);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].mode).toBe("touch");

    useDAWStore.getState().setAutomationWriteBehavior("latch");
    expect(useDAWStore.getState().tracks[0].automationLanes[0].mode).toBe("latch");

    useDAWStore.getState().setAutomationWriteBehavior("overwrite");
    expect(useDAWStore.getState().tracks[0].automationLanes[0].mode).toBe("read");

    loadTrack(useDAWStore.getState().tracks[0], true, 1);
    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");
    expect(useDAWStore.getState().tracks[0].automationLanes[0].mode).toBe("write");
  });

  it("manual point add enables read and stays undoable", () => {
    const track = makeTrack({
      automationReadEnabled: false,
      automationWriteEnabled: false,
      automationEnabled: false,
      automationLanes: [volumeLane({ mode: "off", readEnabled: false })],
    });
    loadTrack(track);

    useDAWStore.getState().addAutomationPoint(track.id, "vol", 1.25, 0.5);

    let updated = useDAWStore.getState().tracks[0];
    expect(updated.automationReadEnabled).toBe(true);
    expect(updated.automationLanes[0].readEnabled).toBe(true);
    expect(updated.automationLanes[0].points).toEqual([{ time: 1.25, value: 0.5 }]);

    useDAWStore.getState().undo();

    updated = useDAWStore.getState().tracks[0];
    expect(updated.automationReadEnabled).toBe(false);
    expect(updated.automationLanes[0].readEnabled).toBe(false);
    expect(updated.automationLanes[0].points).toHaveLength(0);
  });

  it("manual point add punches out active write capture for that lane only", () => {
    const track = makeTrack({
      automationReadEnabled: true,
      automationWriteEnabled: true,
      automationEnabled: true,
      automationLanes: [volumeLane({ mode: "latch" })],
    });
    loadTrack(track, true, 4);

    useDAWStore.getState().setAutomationWriteBehavior("latch");
    useDAWStore.getState().beginAutomationParamTouch(track.id, "volume");
    useDAWStore.getState().setAutomationWriteValue(track.id, "volume", 0.9);

    const key = automationTouchKey(track.id, "volume");
    expect(_automationTouchedParams.has(key)).toBe(true);
    expect(_automationLatchedParams.has(key)).toBe(true);

    useDAWStore.getState().addAutomationPoint(track.id, "vol", 1.25, 0.5);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes[0].points).toEqual([{ time: 1.25, value: 0.5 }]);
    expect(_automationTouchedParams.has(key)).toBe(false);
    expect(_automationLatchedParams.has(key)).toBe(false);
    expect(_automationWriteValues.has(key)).toBe(false);
  });

  it("manual lane drawing works while stopped even when write is armed", () => {
    const track = makeTrack({
      showAutomation: true,
      automationReadEnabled: true,
      automationWriteEnabled: true,
      automationEnabled: true,
      automationLanes: [volumeLane({ mode: "touch" })],
    });
    loadTrack(track, false, 2);

    useDAWStore.getState().setAutomationLanePoints(track.id, "vol", [
      { time: 1, value: 0.25 },
      { time: 1.5, value: 0.75 },
    ], {
      undoable: true,
      oldPoints: [],
      oldTrackRead: true,
      oldTrackWrite: true,
      oldLaneRead: true,
      oldLaneMode: "touch",
    });

    let updated = useDAWStore.getState().tracks[0];
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes[0].readEnabled).toBe(true);
    expect(updated.automationLanes[0].points).toEqual([
      { time: 1, value: 0.25 },
      { time: 1.5, value: 0.75 },
    ]);

    useDAWStore.getState().undo();
    updated = useDAWStore.getState().tracks[0];
    expect(updated.automationWriteEnabled).toBe(true);
    expect(updated.automationLanes[0].points).toHaveLength(0);
  });

  it("toggle mute writes mute automation while playing and track write is armed", async () => {
    const track = makeTrack({
      automationReadEnabled: true,
      automationWriteEnabled: true,
      automationEnabled: true,
      automationLanes: [],
    });
    loadTrack(track, true, 5);

    await useDAWStore.getState().toggleTrackMute(track.id);

    const updated = useDAWStore.getState().tracks[0];
    const muteLane = updated.automationLanes.find((lane) => lane.param === "mute");
    expect(updated.muted).toBe(true);
    expect(muteLane?.points).toEqual([{ time: 5, value: 1 }]);
  });

  it("toggle mute does not create write data while stopped", async () => {
    const track = makeTrack({
      automationReadEnabled: false,
      automationWriteEnabled: true,
      automationEnabled: false,
      automationLanes: [],
    });
    loadTrack(track, false, 5);

    await useDAWStore.getState().toggleTrackMute(track.id);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.muted).toBe(true);
    expect(updated.automationLanes).toHaveLength(0);
  });

  it("master volume write records a master automation point", async () => {
    useDAWStore.setState({
      masterVolume: 1,
      masterPan: 0,
      masterAutomationLanes: [],
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        currentTime: 6,
      },
    });

    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().beginAutomationParamTouch("master", "volume");
    await useDAWStore.getState().setMasterVolume(0.5);
    useDAWStore.getState().recordAutomationWriteTick(1000);
    useDAWStore.getState().endAutomationParamTouch("master", "volume");

    const lane = useDAWStore.getState().masterAutomationLanes.find((candidate) => candidate.param === "volume");
    expect(lane?.points[0].time).toBe(6);
    expect(lane?.points[0].value).toBeCloseTo((20 * Math.log10(0.5) + 60) / 72, 6);
  });

  it("master pan write records normalized pan automation", async () => {
    useDAWStore.setState({
      masterPan: 0,
      masterAutomationLanes: [],
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        currentTime: 7,
      },
    });

    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().beginAutomationParamTouch("master", "pan");
    await useDAWStore.getState().setMasterPan(0.25);
    useDAWStore.getState().recordAutomationWriteTick(1000);
    useDAWStore.getState().endAutomationParamTouch("master", "pan");

    const lane = useDAWStore.getState().masterAutomationLanes.find((candidate) => candidate.param === "pan");
    expect(lane?.points).toEqual([{ time: 7, value: 0.625 }]);
  });

  it("master write while stopped does not create automation lanes", async () => {
    useDAWStore.setState({
      masterAutomationLanes: [],
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: false,
        currentTime: 8,
      },
    });

    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().beginAutomationParamTouch("master", "volume");
    await useDAWStore.getState().setMasterVolume(0.5);
    useDAWStore.getState().recordAutomationWriteTick(1000);

    expect(useDAWStore.getState().masterAutomationLanes).toHaveLength(0);
  });

  it("master read-off write-on captures points while resolving lane mode off", async () => {
    useDAWStore.setState({
      masterVolume: 1,
      masterAutomationLanes: [],
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        currentTime: 9,
      },
    });

    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().toggleMasterAutomationRead();
    useDAWStore.getState().beginAutomationParamTouch("master", "volume");
    await useDAWStore.getState().setMasterVolume(1);
    useDAWStore.getState().recordAutomationWriteTick(1000);
    useDAWStore.getState().endAutomationParamTouch("master", "volume");

    const state = useDAWStore.getState();
    const lane = state.masterAutomationLanes.find((candidate) => candidate.param === "volume");
    expect(state.masterAutomationReadEnabled).toBe(false);
    expect(state.masterAutomationWriteEnabled).toBe(true);
    expect(lane?.mode).toBe("off");
    expect(lane?.points).toEqual([{ time: 9, value: 60 / 72 }]);
  });
});
