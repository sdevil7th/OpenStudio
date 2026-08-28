import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type AutomationLane,
  useDAWStore,
} from "../store/useDAWStore";
import { activateAutomationLaneShortcutContext } from "../utils/automationShortcutContext";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import {
  getActiveShortcutContext,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

const originalState = useDAWStore.getState();

function clip(): AudioClip {
  return {
    id: "selected-clip",
    name: "Selected clip",
    filePath: "C:/audio/selected.wav",
    startTime: 0,
    duration: 4,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function emptyLane(id: string): AutomationLane {
  return {
    id,
    param: "volume",
    points: [],
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
  };
}

beforeEach(() => {
  commandManager.clear();
  resetShortcutContextForTests();
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearAutomation").mockResolvedValue(true);
  const automationLane = emptyLane("track-volume");
  const track = {
    ...createDefaultTrack("track-a", "Track A", "#38bdf8", "audio", []),
    clips: [clip()],
    automationLanes: [automationLane],
    showAutomation: true,
    automationReadEnabled: true,
    automationEnabled: true,
  };
  useDAWStore.setState({
    tracks: [track],
    selectedTrackId: "track-a",
    selectedTrackIds: ["track-a"],
    selectedClipId: "selected-clip",
    selectedClipIds: ["selected-clip"],
    selectedAutomationTarget: null,
    masterAutomationLanes: [emptyLane("master-volume")],
    showMasterAutomation: true,
    masterAutomationReadEnabled: true,
    masterAutomationEnabled: true,
    customShortcuts: {
      "automation.point.addAtPlayhead": "Ctrl+Shift+P",
    },
    lockSettings: {
      ...useDAWStore.getState().lockSettings,
      envelopes: false,
    },
    transport: {
      ...useDAWStore.getState().transport,
      currentTime: 2,
      isPlaying: false,
    },
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  commandManager.clear();
  resetShortcutContextForTests();
  vi.restoreAllMocks();
  useDAWStore.setState(originalState);
});

describe("automation lane focus and shortcut precedence", () => {
  it("runs a custom automation chord after an empty track-lane click and keeps Delete off the selected clip", () => {
    expect(activateAutomationLaneShortcutContext({
      kind: "track",
      trackId: "track-a",
      laneId: "track-volume",
    })).toBe(true);
    expect(getActiveShortcutContext()).toEqual({ kind: "automation" });

    expect(dispatchGlobalShortcut({
      key: "p",
      ctrlKey: true,
      shiftKey: true,
      source: "browser",
    }, "windows")).toBe(true);

    let state = useDAWStore.getState();
    expect(state.tracks[0].automationLanes[0].points).toHaveLength(1);
    expect(state.tracks[0].automationLanes[0].points[0].time).toBe(2);
    expect(state.selectedAutomationTarget).toMatchObject({
      kind: "track",
      trackId: "track-a",
      laneId: "track-volume",
    });
    expect(state.selectedAutomationTarget?.pointId).toEqual(expect.any(String));
    expect(commandManager.getUndoStack()).toHaveLength(1);

    expect(dispatchGlobalShortcut({ key: "Delete", source: "browser" }, "windows")).toBe(true);
    state = useDAWStore.getState();
    expect(state.tracks[0].automationLanes[0].points).toEqual([]);
    expect(state.tracks[0].clips.map((candidate) => candidate.id)).toEqual(["selected-clip"]);
    expect(state.selectedClipIds).toEqual(["selected-clip"]);
    expect(commandManager.getUndoStack()).toHaveLength(2);

    state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(1);
  });

  it("provides the same empty-lane custom shortcut and Delete behavior for master", () => {
    expect(activateAutomationLaneShortcutContext({
      kind: "master",
      laneId: "master-volume",
    })).toBe(true);

    expect(dispatchGlobalShortcut({
      key: "p",
      ctrlKey: true,
      shiftKey: true,
      source: "browser",
    }, "windows")).toBe(true);
    let state = useDAWStore.getState();
    expect(state.masterAutomationLanes[0].points).toHaveLength(1);
    expect(state.selectedAutomationTarget).toMatchObject({
      kind: "master",
      laneId: "master-volume",
    });

    expect(dispatchGlobalShortcut({ key: "Backspace", source: "browser" }, "windows")).toBe(true);
    state = useDAWStore.getState();
    expect(state.masterAutomationLanes[0].points).toEqual([]);
    expect(state.tracks[0].clips).toHaveLength(1);
    expect(commandManager.getUndoStack()).toHaveLength(2);
  });

  it("does not activate automation for a stale lane target", () => {
    expect(activateAutomationLaneShortcutContext({
      kind: "track",
      trackId: "missing-track",
      laneId: "missing-lane",
    })).toBe(false);
    expect(getActiveShortcutContext()).toEqual({ kind: "application" });
    expect(useDAWStore.getState().selectedAutomationTarget).toBeNull();
  });
});
