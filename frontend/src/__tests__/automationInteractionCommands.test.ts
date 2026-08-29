import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  _autoRecordTimers,
  _automationLatchedParams,
  _automationTouchedParams,
  _automationWriteValues,
} from "../store/actions/storeHelpers";
import {
  createDefaultTrack,
  type AutomationLane,
  type AutomationPoint,
  type AutomationSelectionTarget,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function point(id: string, time: number, value: number): AutomationPoint {
  return { id, time, value };
}

function lane(
  id: string,
  param: string,
  points: AutomationPoint[] = [],
  overrides: Partial<AutomationLane> = {},
): AutomationLane {
  return {
    id,
    param,
    points,
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
    ...overrides,
  };
}

function track(
  id: string,
  automationLanes: AutomationLane[],
  overrides: Partial<Track> = {},
): Track {
  return {
    ...createDefaultTrack(id, id, "#14b8a6", "audio", []),
    automationLanes,
    showAutomation: true,
    automationReadEnabled: true,
    automationWriteEnabled: false,
    automationEnabled: true,
    suspendedAutomationState: null,
    ...overrides,
  };
}

function trackLane(trackId = "track-a", laneId = "track-volume") {
  return useDAWStore.getState().tracks
    .find((candidate) => candidate.id === trackId)
    ?.automationLanes.find((candidate) => candidate.id === laneId);
}

function resetAutomationRuntime() {
  useDAWStore.getState().cancelAutomationPointEdit?.();
  useDAWStore.getState().endAutomationWriteSession?.();
  _automationTouchedParams.clear();
  _automationLatchedParams.clear();
  _automationWriteValues.clear();
  _autoRecordTimers.clear();
  commandManager.clear();
}

beforeEach(() => {
  resetAutomationRuntime();
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearAutomation").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "replaceAutomationPointsInRange").mockResolvedValue(true);
  useDAWStore.setState({
    tracks: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    selectedAutomationTarget: null,
    masterAutomationLanes: [],
    showMasterAutomation: false,
    masterAutomationReadEnabled: false,
    masterAutomationWriteEnabled: false,
    masterAutomationEnabled: false,
    suspendedMasterAutomationState: null,
    automationWriteBehavior: "touch",
    globalLocked: false,
    lockSettings: {
      ...useDAWStore.getState().lockSettings,
      envelopes: false,
    },
    transport: {
      ...useDAWStore.getState().transport,
      isPlaying: false,
      currentTime: 0,
    },
    canUndo: false,
    canRedo: false,
    isModified: false,
  });
});

afterEach(() => {
  resetAutomationRuntime();
  vi.restoreAllMocks();
  useDAWStore.setState(originalState);
});

describe("automation point identity and edit transactions", () => {
  it("keeps the selected point ID when it crosses neighbours and commits one undo command", () => {
    const originalPoints = [
      point("moving", 1, 0.1),
      point("middle", 2, 0.2),
      point("last", 3, 0.3),
    ];
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", originalPoints)])],
    });
    const target: AutomationSelectionTarget = {
      kind: "track",
      trackId: "track-a",
      laneId: "track-volume",
      pointId: "moving",
    };

    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(4, 0.9)).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(true);

    expect(trackLane()?.points).toEqual([
      point("middle", 2, 0.2),
      point("last", 3, 0.3),
      point("moving", 4, 0.9),
    ]);
    expect(useDAWStore.getState().selectedAutomationTarget).toEqual(target);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(trackLane()?.points).toEqual(originalPoints);
    expect(useDAWStore.getState().selectedAutomationTarget).toEqual(target);

    useDAWStore.getState().redo();
    expect(trackLane()?.points.map((candidate) => candidate.id)).toEqual([
      "middle",
      "last",
      "moving",
    ]);
  });

  it("restores the exact preview snapshot on cancel without creating history", () => {
    const originalPoints = [point("first", 1, 0.2), point("second", 2, 0.8)];
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", originalPoints)])],
      isModified: false,
    });
    const target: AutomationSelectionTarget = {
      kind: "track",
      trackId: "track-a",
      laneId: "track-volume",
      pointId: "second",
    };

    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(0.25, 0.1)).toBe(true);
    expect(trackLane()?.points).not.toEqual(originalPoints);
    expect(useDAWStore.getState().cancelAutomationPointEdit()).toBe(true);

    expect(trackLane()?.points).toEqual(originalPoints);
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("uses the same one-command stable-ID transaction for master points", () => {
    const originalPoints = [point("master-first", 1, 0.25), point("master-moving", 2, 0.75)];
    useDAWStore.setState({
      masterAutomationLanes: [lane("master-volume", "volume", originalPoints)],
    });
    const target: AutomationSelectionTarget = {
      kind: "master",
      laneId: "master-volume",
      pointId: "master-moving",
    };

    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(0.5, 0.6)).toBe(true);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(true);

    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual([
      point("master-moving", 0.5, 0.6),
      point("master-first", 1, 0.25),
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual(originalPoints);
  });
});

describe("automation envelope locking", () => {
  it("blocks track and master point mutations while envelopes are locked", () => {
    const trackPoints = [point("track-point", 1, 0.25)];
    const masterPoints = [point("master-point", 2, 0.75)];
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", trackPoints)])],
      masterAutomationLanes: [lane("master-volume", "volume", masterPoints)],
      selectedAutomationTarget: {
        kind: "track",
        trackId: "track-a",
        laneId: "track-volume",
        pointId: "track-point",
      },
      lockSettings: { ...useDAWStore.getState().lockSettings, envelopes: true },
    });

    useDAWStore.getState().addAutomationPoint("track-a", "track-volume", 3, 0.5);
    useDAWStore.getState().removeAutomationPoint("track-a", "track-volume", 0);
    useDAWStore.getState().moveAutomationPoint("track-a", "track-volume", 0, 4, 1);
    useDAWStore.getState().clearAutomationLane("track-a", "track-volume");
    useDAWStore.getState().deleteSelectedAutomationPoint();
    useDAWStore.getState().addMasterAutomationPoint("master-volume", 3, 0.5);
    useDAWStore.getState().removeMasterAutomationPoint("master-volume", 0);
    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 4, 0);
    useDAWStore.getState().clearMasterAutomationLane("master-volume");

    expect(useDAWStore.getState().beginAutomationPointEdit({
      kind: "master",
      laneId: "master-volume",
      pointId: "master-point",
    })).toBe(false);
    expect(trackLane()?.points).toEqual(trackPoints);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual(masterPoints);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("allows existing point commands to undo after the envelope lock is enabled", () => {
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", [point("track-point", 1, 0.25)])])],
      masterAutomationLanes: [lane("master-volume", "volume", [point("master-point", 2, 0.75)])],
    });

    useDAWStore.getState().moveAutomationPoint("track-a", "track-volume", 0, 3, 0.5);
    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 4, 0.25);
    expect(commandManager.getUndoStack()).toHaveLength(2);

    useDAWStore.setState({
      lockSettings: { ...useDAWStore.getState().lockSettings, envelopes: true },
    });
    useDAWStore.getState().undo();
    useDAWStore.getState().undo();

    expect(trackLane()?.points).toEqual([point("track-point", 1, 0.25)]);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual([
      point("master-point", 2, 0.75),
    ]);
  });

  it("treats Global Lock as an umbrella for track/master point, draw, copy, write, and suspend paths", () => {
    const trackPoints = [point("track-point", 1, 0.25)];
    const masterPoints = [point("master-point", 2, 0.75)];
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", trackPoints)], {
        automationWriteEnabled: true,
      })],
      masterAutomationLanes: [lane("master-volume", "volume", masterPoints)],
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: true,
      masterAutomationEnabled: true,
      selectedAutomationTarget: {
        kind: "track",
        trackId: "track-a",
        laneId: "track-volume",
        pointId: "track-point",
      },
      globalLocked: true,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        currentTime: 3,
      },
    });

    useDAWStore.getState().addAutomationPoint("track-a", "track-volume", 3, 0.5);
    useDAWStore.getState().removeAutomationPoint("track-a", "track-volume", 0);
    useDAWStore.getState().moveAutomationPoint("track-a", "track-volume", 0, 4, 1);
    useDAWStore.getState().setAutomationLanePoints("track-a", "track-volume", []);
    useDAWStore.getState().deleteSelectedAutomationPoint();
    useDAWStore.getState().addAutomationPointAtPlayhead();
    expect(useDAWStore.getState().beginAutomationPointEdit({
      kind: "track",
      trackId: "track-a",
      laneId: "track-volume",
      pointId: "track-point",
    })).toBe(false);
    expect(useDAWStore.getState().beginAutomationPointCopyEdit({
      kind: "track",
      trackId: "track-a",
      laneId: "track-volume",
      pointId: "track-point",
    })).toBe(false);

    useDAWStore.getState().addMasterAutomationPoint("master-volume", 3, 0.5);
    useDAWStore.getState().removeMasterAutomationPoint("master-volume", 0);
    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 4, 0);
    useDAWStore.getState().clearMasterAutomationLane("master-volume");
    expect(useDAWStore.getState().addAutomationLane("track-a", "pan")).toBeNull();
    expect(useDAWStore.getState().addMasterAutomationLane("pan")).toBeNull();

    useDAWStore.getState().beginAutomationParamTouch("track-a", "volume");
    useDAWStore.getState().setAutomationWriteValue("track-a", "volume", 0.9);
    useDAWStore.getState().recordAutomationWriteTick(1_000);
    useDAWStore.getState().suspendAutomation();

    expect(getRegisteredAction("automation.point.deleteSelected")!.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("automation.selectedLane.clear")!.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("automation.suspend")!.canHandleShortcut?.()).toBe(false);

    expect(trackLane()?.points).toEqual(trackPoints);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual(masterPoints);
    expect(useDAWStore.getState().tracks[0].automationLanes).toHaveLength(1);
    expect(useDAWStore.getState().masterAutomationLanes).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].suspendedAutomationState).toBeNull();
    expect(useDAWStore.getState().suspendedMasterAutomationState).toBeNull();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it.each([
    ["Global Lock", { globalLocked: true }],
    ["Envelope Lock", { lockSettings: { envelopes: true } }],
  ] as const)("blocks every track/master automation mode mutation under %s", (_label, lock) => {
    const trackLanes = [
      lane("track-volume", "volume", [point("track-point", 1, 0.25)], { armed: true }),
      lane("track-pan", "pan", [], { armed: false }),
    ];
    const masterLanes = [
      lane("master-volume", "volume", [point("master-point", 2, 0.75)], { armed: true }),
      lane("master-pan", "pan", [], { armed: false }),
    ];
    useDAWStore.setState((state) => ({
      tracks: [track("track-a", trackLanes)],
      selectedTrackId: "track-a",
      selectedTrackIds: ["track-a"],
      selectedAutomationTarget: {
        kind: "track",
        trackId: "track-a",
        laneId: "track-volume",
        pointId: "track-point",
      },
      masterAutomationLanes: masterLanes,
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: true,
      globalLocked: "globalLocked" in lock ? lock.globalLocked : false,
      lockSettings: {
        ...state.lockSettings,
        envelopes: "lockSettings" in lock ? lock.lockSettings.envelopes : false,
      },
    }));

    const automationSnapshot = () => {
      const state = useDAWStore.getState();
      return JSON.stringify({
        automationWriteBehavior: state.automationWriteBehavior,
        tracks: state.tracks,
        masterAutomationLanes: state.masterAutomationLanes,
        showMasterAutomation: state.showMasterAutomation,
        masterAutomationReadEnabled: state.masterAutomationReadEnabled,
        masterAutomationWriteEnabled: state.masterAutomationWriteEnabled,
        masterAutomationEnabled: state.masterAutomationEnabled,
      });
    };
    const before = automationSnapshot();
    const state = useDAWStore.getState();

    state.setAutomationWriteBehavior("latch");
    state.setTrackAutomationRead("track-a", false);
    state.toggleTrackAutomationRead("track-a");
    state.setTrackAutomationWrite("track-a", true);
    state.toggleTrackAutomationWrite("track-a");
    state.setAutomationLaneRead("track-a", "track-volume", false);
    state.setAutomationLaneMode("track-a", "track-volume", "write");
    state.toggleTrackAutomation("track-a");
    state.toggleAutomationLaneVisibility("track-a", "track-volume");
    state.setSelectedAutomationLaneVisibility(false);
    state.setTrackAutomationMode("track-a", "write");
    state.armAutomationLane("track-a", "track-volume", false);
    state.armAllVisibleAutomationLanes("track-a");
    state.disarmAllAutomationLanes("track-a");
    state.setTracksAutomationRead(["track-a"], false);
    state.toggleTracksAutomationRead(["track-a"]);
    state.setTracksAutomationWrite(["track-a"], true);
    state.toggleTracksAutomationWrite(["track-a"]);
    state.setTracksAutomationMode(["track-a"], "latch");
    state.setTracksAutomationVisibility(["track-a"], false);
    state.setMasterAutomationRead(false);
    state.toggleMasterAutomationRead();
    state.setMasterAutomationWrite(true);
    state.toggleMasterAutomationWrite();
    state.setMasterAutomationLaneRead("master-volume", false);
    state.setMasterAutomationLaneMode("master-volume", "write");
    state.armMasterAutomationLane("master-volume", false);
    state.toggleMasterAutomation();
    state.toggleMasterAutomationLaneVisibility("master-volume");
    state.setMasterTrackAutomationMode("latch");
    state.armAllVisibleMasterAutomationLanes();
    state.disarmAllMasterAutomationLanes();

    expect(automationSnapshot()).toBe(before);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("keeps only non-project arrangement and selection navigation available while locked", () => {
    useDAWStore.setState((state) => ({
      tracks: [track("track-a", [lane("track-volume", "volume")], { showAutomation: true })],
      selectedTrackId: "track-a",
      selectedTrackIds: ["track-a"],
      selectedAutomationTarget: {
        kind: "track",
        trackId: "track-a",
        laneId: "track-volume",
        pointId: null,
      },
      lockSettings: { ...state.lockSettings, envelopes: true },
    }));

    expect(getRegisteredAction("automation.selectedTracks.show")?.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("automation.selectedLane.show")?.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("automation.toggleArrangementView")?.canHandleShortcut?.()).toBe(true);
    expect(getRegisteredAction("automation.lane.selectNext")?.canHandleShortcut?.()).toBe(true);

    getRegisteredAction("automation.toggleArrangementView")?.execute();
    expect(useDAWStore.getState().tracks[0].showAutomation).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});

describe("automation project commands", () => {
  it("clears a newly-added track lane from the backend when lane creation is undone", () => {
    useDAWStore.setState({ tracks: [track("track-a", [], {
      showAutomation: false,
      automationReadEnabled: false,
      automationEnabled: false,
    })] });
    const clearSpy = vi.mocked(nativeBridge.clearAutomation);

    const laneId = useDAWStore.getState().addAutomationLane("track-a", "volume");
    expect(laneId).toBeTypeOf("string");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();

    expect(trackLane("track-a", laneId as string)).toBeUndefined();
    expect(clearSpy).toHaveBeenCalledWith("track-a", "volume");
  });

  it("clears a newly-added master lane from the backend when lane creation is undone", () => {
    const clearSpy = vi.mocked(nativeBridge.clearAutomation);

    const laneId = useDAWStore.getState().addMasterAutomationLane("pan");
    expect(laneId).toBe("master-pan");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();

    expect(useDAWStore.getState().masterAutomationLanes).toHaveLength(0);
    expect(clearSpy).toHaveBeenCalledWith("master", "pan");
  });

  it("applies selected-track mode and visibility changes atomically and skips no-ops", () => {
    const tracks = ["track-a", "track-b"].map((trackId) => track(
      trackId,
      [lane(`${trackId}-volume`, "volume", [point(`${trackId}-point`, 1, 0.5)], {
        visible: false,
      })],
      { showAutomation: false },
    ));
    useDAWStore.setState({ tracks });

    useDAWStore.getState().setTracksAutomationMode(["track-a", "track-b"], "write");
    useDAWStore.getState().setTracksAutomationMode(["track-a", "track-b"], "write");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks.every((candidate) => (
      candidate.automationReadEnabled
      && candidate.automationWriteEnabled
      && candidate.automationLanes[0].mode === "write"
      && candidate.automationLanes[0].armed
    ))).toBe(true);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.every((candidate) => (
      candidate.automationLanes[0].mode === "read" && !candidate.automationWriteEnabled
    ))).toBe(true);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    useDAWStore.getState().setTracksAutomationVisibility(["track-a", "track-b"], true);
    useDAWStore.getState().setTracksAutomationVisibility(["track-a", "track-b"], true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks.every((candidate) => (
      candidate.showAutomation && candidate.automationLanes[0].visible
    ))).toBe(true);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.every((candidate) => (
      !candidate.showAutomation && !candidate.automationLanes[0].visible
    ))).toBe(true);
  });

  it("toggles arrangement automation as view state without changing lane visibility or history", () => {
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", [], { visible: false })])],
      showMasterAutomation: false,
      masterAutomationLanes: [lane("master-pan", "pan", [], { visible: true })],
    });

    useDAWStore.getState().toggleArrangementAutomationView();
    expect(useDAWStore.getState().tracks[0].showAutomation).toBe(false);
    expect(useDAWStore.getState().showMasterAutomation).toBe(false);
    expect(trackLane()?.visible).toBe(false);
    expect(useDAWStore.getState().masterAutomationLanes[0].visible).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.getState().toggleArrangementAutomationView();
    expect(useDAWStore.getState().tracks[0].showAutomation).toBe(true);
    expect(useDAWStore.getState().showMasterAutomation).toBe(true);
    expect(trackLane()?.visible).toBe(false);
    expect(useDAWStore.getState().masterAutomationLanes[0].visible).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("suspends and resumes track and master automation without duplicate history", () => {
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", [point("track-point", 1, 0.4)], {
        mode: "touch",
        armed: true,
      })], { automationWriteEnabled: true })],
      showMasterAutomation: true,
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: true,
      masterAutomationEnabled: true,
      masterAutomationLanes: [lane("master-pan", "pan", [point("master-point", 1, 0.6)], {
        mode: "latch",
        armed: true,
      })],
    });

    useDAWStore.getState().suspendAutomation();
    useDAWStore.getState().suspendAutomation();
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(trackLane()?.mode).toBe("off");
    expect(trackLane()?.readEnabled).toBe(false);
    expect(useDAWStore.getState()).toMatchObject({
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
    });
    expect(useDAWStore.getState().tracks[0].suspendedAutomationState).not.toBeNull();
    expect(useDAWStore.getState().suspendedMasterAutomationState).not.toBeNull();

    useDAWStore.getState().resumeAutomation();
    useDAWStore.getState().resumeAutomation();
    expect(commandManager.getUndoStack()).toHaveLength(2);
    expect(trackLane()).toMatchObject({ mode: "touch", readEnabled: true, armed: true });
    expect(useDAWStore.getState().masterAutomationLanes[0]).toMatchObject({
      mode: "latch",
      readEnabled: true,
      armed: true,
    });
    expect(useDAWStore.getState().tracks[0].suspendedAutomationState).toBeNull();
    expect(useDAWStore.getState().suspendedMasterAutomationState).toBeNull();

    useDAWStore.getState().undo();
    expect(trackLane()?.mode).toBe("off");
    useDAWStore.getState().undo();
    expect(trackLane()).toMatchObject({ mode: "touch", readEnabled: true, armed: true });
  });
});

describe("automation selection and recorded passes", () => {
  it("cycles lanes and point IDs, wraps lanes, and clears stale targets safely", () => {
    useDAWStore.setState({
      tracks: [track("track-a", [
        lane("lane-a", "volume", [point("a1", 1, 0.1), point("a2", 2, 0.2)]),
        lane("lane-b", "pan", [point("b1", 1, 0.3)]),
      ])],
    });
    useDAWStore.getState().setSelectedAutomationLane({
      kind: "track",
      trackId: "track-a",
      laneId: "lane-a",
    });

    useDAWStore.getState().selectAdjacentAutomationPoint("next");
    expect(useDAWStore.getState().selectedAutomationTarget?.pointId).toBe("a1");
    useDAWStore.getState().selectAdjacentAutomationPoint("next");
    expect(useDAWStore.getState().selectedAutomationTarget?.pointId).toBe("a2");
    useDAWStore.getState().selectAdjacentAutomationLane("next");
    expect(useDAWStore.getState().selectedAutomationTarget).toMatchObject({
      laneId: "lane-b",
      pointId: null,
    });
    useDAWStore.getState().selectAdjacentAutomationLane("next");
    expect(useDAWStore.getState().selectedAutomationTarget?.laneId).toBe("lane-a");
    useDAWStore.getState().selectAdjacentAutomationLane("previous");
    expect(useDAWStore.getState().selectedAutomationTarget?.laneId).toBe("lane-b");

    useDAWStore.setState({
      selectedAutomationTarget: {
        kind: "track",
        trackId: "missing",
        laneId: "missing",
        pointId: "missing",
      },
    });
    useDAWStore.getState().selectAdjacentAutomationPoint("next");
    expect(useDAWStore.getState().selectedAutomationTarget).toBeNull();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("records track and master write data as one undoable pass", () => {
    const beforeTrack = [point("track-before", 0, 0.2)];
    const beforeMaster = [point("master-before", 0, 0.4)];
    useDAWStore.setState({
      tracks: [track("track-a", [lane("track-volume", "volume", beforeTrack, {
        mode: "touch",
      })], { automationWriteEnabled: true })],
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: true,
      masterAutomationEnabled: true,
      masterAutomationLanes: [lane("master-pan", "pan", beforeMaster, { mode: "touch" })],
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        currentTime: 2,
      },
    });

    useDAWStore.getState().beginAutomationParamTouch("track-a", "volume");
    useDAWStore.getState().beginAutomationParamTouch("master", "pan");
    useDAWStore.getState().setAutomationWriteValue("track-a", "volume", 0.7);
    useDAWStore.getState().setAutomationWriteValue("master", "pan", 0.8);
    useDAWStore.getState().recordAutomationWriteTick(1_000);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    useDAWStore.getState().endAutomationWriteSession();

    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(commandManager.getUndoStack()[0]?.type).toBe("RECORD_AUTOMATION_WRITE_PASS");
    expect(trackLane()?.points.map(({ time, value }) => ({ time, value }))).toEqual([
      { time: 0, value: 0.2 },
      { time: 2, value: 0.7 },
    ]);
    expect(useDAWStore.getState().masterAutomationLanes[0].points
      .map(({ time, value }) => ({ time, value }))).toEqual([
      { time: 0, value: 0.4 },
      { time: 2, value: 0.8 },
    ]);

    useDAWStore.getState().undo();
    expect(trackLane()?.points).toEqual(beforeTrack);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual(beforeMaster);
    useDAWStore.getState().redo();
    const redoneTrackPoints = trackLane()?.points ?? [];
    const redoneMasterPoints = useDAWStore.getState().masterAutomationLanes[0].points;
    expect(redoneTrackPoints[redoneTrackPoints.length - 1]).toMatchObject({ time: 2, value: 0.7 });
    expect(redoneMasterPoints[redoneMasterPoints.length - 1])
      .toMatchObject({ time: 2, value: 0.8 });
  });
});
