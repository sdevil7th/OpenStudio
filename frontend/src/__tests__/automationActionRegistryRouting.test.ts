import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import {
  getActionShortcutScopes,
  getRegisteredAction,
  isRemoteAutomationActionId,
  routeAutomationAction,
} from "../store/actionRegistry";
import { executeDetachedMainActionRequest } from "../utils/detachedMainActionRouting";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AutomationLane,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

const stableAutomationActionIds = [
  "automation.toggleArrangementView",
  "automation.writeBehavior.touch",
  "automation.writeBehavior.latch",
  "automation.writeBehavior.overwrite",
  ...(["off", "read", "write", "touch", "latch"] as const).flatMap((mode) => [
    `automation.selectedTracks.mode.${mode}`,
    `automation.master.mode.${mode}`,
    `automation.selectedLane.mode.${mode}`,
  ]),
  "automation.selectedTracks.toggleOffRead",
  "automation.selectedTracks.toggleLatchRead",
  "automation.allTracks.mode.off",
  "automation.allTracks.mode.read",
  "automation.allTracks.mode.touch",
  "automation.allTracks.mode.latch",
  "automation.allTracks.writeOff",
  "automation.allTracks.toggleRead",
  ...(["show", "hide", "readOn", "readOff", "writeOn", "writeOff"] as const).flatMap((operation) => [
    `automation.selectedTracks.${operation}`,
    `automation.master.${operation}`,
    `automation.selectedLane.${operation}`,
  ]),
  "automation.point.selectNext",
  "automation.point.selectPrevious",
  "automation.point.deleteSelected",
  "automation.point.nudgeTimeLeft",
  "automation.point.nudgeTimeRight",
  "automation.point.nudgeValueUp",
  "automation.point.nudgeValueDown",
  "automation.point.addAtPlayhead",
  "automation.selectedLane.clear",
  "automation.suspend",
  "automation.resume",
] as const;

function volumeLane(): AutomationLane {
  return {
    id: "volume-lane",
    param: "volume",
    points: [{ id: "point-a", time: 1, value: 0.5 }],
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
  };
}

function automationTrack(id: string): Track {
  return {
    ...createDefaultTrack(id, id, "#14b8a6", "audio", []),
    automationReadEnabled: true,
    automationWriteEnabled: false,
    automationEnabled: true,
    automationLanes: [volumeLane()],
  };
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({
    ...originalState,
    tracks: [automationTrack("track-a"), automationTrack("track-b")],
    selectedTrackId: "track-a",
    selectedTrackIds: ["track-a", "track-b"],
    selectedClipId: null,
    selectedClipIds: [],
    timeSelection: null,
    selectedAutomationTarget: {
      kind: "track",
      trackId: "track-a",
      laneId: "volume-lane",
      pointId: "point-a",
    },
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("automation action registry", () => {
  it("registers every stable action ID but forwards only authoritatively targetable automation", () => {
    for (const actionId of stableAutomationActionIds) {
      expect(getRegisteredAction(actionId), actionId).toBeDefined();
      const targetNeedsExactLaneOrPoint = actionId.startsWith("automation.selectedLane.")
        || actionId.startsWith("automation.point.");
      expect(isRemoteAutomationActionId(actionId), actionId).toBe(!targetNeedsExactLaneOrPoint);
    }

    expect(isRemoteAutomationActionId("edit.delete")).toBe(false);
    expect(isRemoteAutomationActionId("automation.not-a-real-action")).toBe(false);
  });

  it("keeps adjacent-lane selection local to the focused automation window", () => {
    for (const actionId of [
      "automation.lane.selectPrevious",
      "automation.lane.selectNext",
    ]) {
      const action = getRegisteredAction(actionId);
      expect(action).toMatchObject({ shortcutScope: "automation" });
      expect(action?.shortcut).toBeUndefined();
      expect(isRemoteAutomationActionId(actionId)).toBe(false);
    }

    const selectAdjacentAutomationLane = vi.fn();
    useDAWStore.setState({ selectAdjacentAutomationLane });
    getRegisteredAction("automation.lane.selectPrevious")?.execute();
    getRegisteredAction("automation.lane.selectNext")?.execute();
    expect(selectAdjacentAutomationLane.mock.calls).toEqual([["previous"], ["next"]]);
  });

  it("lets adjacent-lane actions recover a stale selection instead of consuming a no-op", () => {
    useDAWStore.setState({
      selectedAutomationTarget: {
        kind: "track",
        trackId: "missing-track",
        laneId: "missing-lane",
        pointId: null,
      },
    });
    const nextLane = getRegisteredAction("automation.lane.selectNext")!;
    expect(nextLane.canHandleShortcut?.()).toBe(true);

    nextLane.execute();

    expect(useDAWStore.getState().selectedAutomationTarget).toEqual({
      kind: "track",
      trackId: "track-a",
      laneId: "volume-lane",
      pointId: null,
    });
  });

  it("keeps arrangement A surface-scoped and declares the point-editing defaults", () => {
    const arrangement = getRegisteredAction("automation.toggleArrangementView")!;
    expect(arrangement).toMatchObject({ shortcut: "A", shortcutScope: "timeline" });
    expect(getActionShortcutScopes(arrangement)).toEqual(["timeline", "automation"]);
    expect(getActionShortcutScopes(arrangement)).not.toContain("global");

    expect(getRegisteredAction("automation.point.selectNext")).toMatchObject({ shortcut: "Tab", shortcutScope: "automation" });
    expect(getRegisteredAction("automation.point.selectPrevious")).toMatchObject({ shortcut: "Shift+Tab", shortcutScope: "automation" });
    expect(getRegisteredAction("automation.point.deleteSelected")).toMatchObject({
      shortcut: "Delete",
      shortcutAliases: ["Backspace"],
      shortcutScope: "automation",
    });
    expect(getRegisteredAction("automation.point.nudgeTimeLeft")?.shortcut).toBe("Left");
    expect(getRegisteredAction("automation.point.nudgeTimeRight")?.shortcut).toBe("Right");
    expect(getRegisteredAction("automation.point.nudgeValueUp")?.shortcut).toBe("Up");
    expect(getRegisteredAction("automation.point.nudgeValueDown")?.shortcut).toBe("Down");
    expect(getRegisteredAction("automation.point.addAtPlayhead")?.shortcut).toBe("Ctrl+Enter");
    expect(getRegisteredAction("automation.selectedLane.clear")?.shortcut).toBe("Ctrl+Delete");
  });

  it("routes selected-track modes through one atomic store command", () => {
    getRegisteredAction("automation.selectedTracks.mode.write")?.execute();

    const state = useDAWStore.getState();
    expect(state.tracks.map((track) => track.automationWriteEnabled)).toEqual([true, true]);
    expect(state.tracks.flatMap((track) => track.automationLanes.map((lane) => lane.mode)))
      .toEqual(["write", "write"]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    expect(useDAWStore.getState().tracks.map((track) => track.automationWriteEnabled))
      .toEqual([false, false]);
  });

  it("routes Logic/Cakewalk selected and all-track actions through one batch API call", () => {
    const toggleTracksAutomationModes = vi.fn();
    const setTracksAutomationMode = vi.fn();
    const setTracksAutomationWrite = vi.fn();
    const toggleTracksAutomationRead = vi.fn();
    useDAWStore.setState({
      toggleTracksAutomationModes,
      setTracksAutomationMode,
      setTracksAutomationWrite,
      toggleTracksAutomationRead,
    });

    getRegisteredAction("automation.selectedTracks.toggleOffRead")?.execute();
    getRegisteredAction("automation.selectedTracks.toggleLatchRead")?.execute();
    for (const mode of ["off", "read", "touch", "latch"] as const) {
      getRegisteredAction(`automation.allTracks.mode.${mode}`)?.execute();
    }
    getRegisteredAction("automation.allTracks.writeOff")?.execute();
    getRegisteredAction("automation.allTracks.toggleRead")?.execute();

    expect(toggleTracksAutomationModes.mock.calls).toEqual([
      [["track-a", "track-b"], "off", "read"],
      [["track-a", "track-b"], "latch", "read"],
    ]);
    expect(setTracksAutomationMode.mock.calls).toEqual([
      [["track-a", "track-b"], "off"],
      [["track-a", "track-b"], "read"],
      [["track-a", "track-b"], "touch"],
      [["track-a", "track-b"], "latch"],
    ]);
    expect(setTracksAutomationWrite).toHaveBeenCalledOnce();
    expect(setTracksAutomationWrite).toHaveBeenCalledWith(["track-a", "track-b"], false);
    expect(toggleTracksAutomationRead).toHaveBeenCalledOnce();
    expect(toggleTracksAutomationRead).toHaveBeenCalledWith(["track-a", "track-b"]);
  });

  it("keeps repeated all-track mode and one-way write commands no-op safe", () => {
    getRegisteredAction("automation.allTracks.mode.touch")?.execute();
    expect(useDAWStore.getState().tracks.map((track) => track.automationWriteEnabled))
      .toEqual([true, true]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    getRegisteredAction("automation.allTracks.mode.touch")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(1);

    commandManager.clear();
    getRegisteredAction("automation.allTracks.writeOff")?.execute();
    expect(useDAWStore.getState().tracks.map((track) => track.automationWriteEnabled))
      .toEqual([false, false]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    getRegisteredAction("automation.allTracks.writeOff")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("commits each selected-track two-mode toggle as one undo command", () => {
    getRegisteredAction("automation.selectedTracks.toggleOffRead")?.execute();
    expect(useDAWStore.getState().tracks.flatMap((track) => track.automationLanes.map((lane) => lane.mode)))
      .toEqual(["off", "off"]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    getRegisteredAction("automation.selectedTracks.toggleOffRead")?.execute();
    expect(useDAWStore.getState().tracks.flatMap((track) => track.automationLanes.map((lane) => lane.mode)))
      .toEqual(["read", "read"]);
    expect(commandManager.getUndoStack()).toHaveLength(2);

    commandManager.clear();
    getRegisteredAction("automation.selectedTracks.toggleLatchRead")?.execute();
    expect(useDAWStore.getState().tracks.flatMap((track) => track.automationLanes.map((lane) => lane.mode)))
      .toEqual(["latch", "latch"]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("shows and hides every selected track with one idempotent history entry", () => {
    getRegisteredAction("automation.selectedTracks.show")?.execute();
    expect(useDAWStore.getState().tracks.map((track) => track.showAutomation))
      .toEqual([true, true]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    getRegisteredAction("automation.selectedTracks.show")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(1);

    getRegisteredAction("automation.selectedTracks.hide")?.execute();
    expect(useDAWStore.getState().tracks.map((track) => track.showAutomation))
      .toEqual([false, false]);
    expect(commandManager.getUndoStack()).toHaveLength(2);

    getRegisteredAction("automation.selectedTracks.hide")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(2);
  });

  it("keeps master one-way show/hide/read/write actions idempotent", () => {
    useDAWStore.setState({
      showMasterAutomation: false,
      masterAutomationLanes: [{ ...volumeLane(), visible: false }],
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: true,
    });

    getRegisteredAction("automation.master.show")?.execute();
    expect(useDAWStore.getState().showMasterAutomation).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    getRegisteredAction("automation.master.show")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(1);

    getRegisteredAction("automation.master.hide")?.execute();
    expect(useDAWStore.getState().showMasterAutomation).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(2);
    getRegisteredAction("automation.master.hide")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(2);

    commandManager.clear();
    getRegisteredAction("automation.master.readOn")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(0);
    getRegisteredAction("automation.master.readOff")?.execute();
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    getRegisteredAction("automation.master.readOff")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(1);

    commandManager.clear();
    getRegisteredAction("automation.master.writeOff")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(0);
    getRegisteredAction("automation.master.writeOn")?.execute();
    expect(useDAWStore.getState().masterAutomationWriteEnabled).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    getRegisteredAction("automation.master.writeOn")?.execute();
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("does not claim point-edit shortcuts for a stale or locked selection", () => {
    const remove = getRegisteredAction("automation.point.deleteSelected")!;
    expect(remove.canHandleShortcut?.()).toBe(true);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, envelopes: true },
    }));
    expect(remove.canHandleShortcut?.()).toBe(false);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, envelopes: false },
      selectedAutomationTarget: null,
    }));
    expect(remove.canHandleShortcut?.()).toBe(false);
  });

  it.each(["global", "envelope"] as const)(
    "does not claim automation mode/read/write commands under %s lock",
    (lockKind) => {
      useDAWStore.setState((state) => ({
        globalLocked: lockKind === "global",
        lockSettings: {
          ...state.lockSettings,
          envelopes: lockKind === "envelope",
        },
      }));

      const nonMutatingStableIds = new Set([
        "automation.toggleArrangementView",
        "automation.point.selectNext",
        "automation.point.selectPrevious",
      ]);
      for (const actionId of [
        ...stableAutomationActionIds.filter((id) => !nonMutatingStableIds.has(id)),
        "track.toggleSelectedAutomationRead",
        "track.toggleSelectedAutomationWrite",
        "track.toggleSelectedAutomation",
        "automation.showAllSelectedTrackEnvelopes",
        "automation.hideAllSelectedTrackEnvelopes",
        "mixer.toggleMasterAutomationRead",
        "mixer.toggleMasterAutomationWrite",
        "mixer.toggleMasterAutomationLanes",
      ]) {
        expect(getRegisteredAction(actionId)?.canHandleShortcut?.(), actionId).toBe(false);
      }

      expect(getRegisteredAction("automation.toggleArrangementView")?.canHandleShortcut?.()).toBe(true);
      expect(getRegisteredAction("automation.point.selectNext")?.canHandleShortcut?.()).toBe(true);
      expect(getRegisteredAction("automation.point.selectPrevious")?.canHandleShortcut?.()).toBe(true);
    },
  );
});

describe("detached automation action routing", () => {
  it("publishes the exact selected tracks and defers project mutation to the main realm", async () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const detachedMutation = vi.fn();

    routeAutomationAction(
      "automation.selectedTracks.mode.write",
      detachedMutation,
      "mixer",
    );

    expect(detachedMutation).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      command: "action.execute",
      actionId: "automation.selectedTracks.mode.write",
      selectedTrackIds: ["track-a", "track-b"],
      selectedClipIds: [],
      timeSelection: null,
    });

    const payload = publish.mock.calls[0][0] as { actionId: string };
    expect(isRemoteAutomationActionId(payload.actionId)).toBe(true);
    expect(executeDetachedMainActionRequest(payload, getRegisteredAction, { role: "main" })).toBe(true);

    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks.map((track) => track.automationWriteEnabled))
      .toEqual([true, true]);
    await Promise.resolve();
  });

  it("allowlists a QA all-track mutation and executes it once in the main realm", () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);

    routeAutomationAction("automation.allTracks.mode.latch", () => {
      throw new Error("detached realm must not mutate project state");
    }, "mixer");

    expect(publish).toHaveBeenCalledOnce();
    const payload = publish.mock.calls[0][0] as { actionId: string };
    expect(payload.actionId).toBe("automation.allTracks.mode.latch");
    expect(executeDetachedMainActionRequest(payload, getRegisteredAction, { role: "main" })).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks.flatMap((track) => track.automationLanes.map((lane) => lane.mode)))
      .toEqual(["latch", "latch"]);
  });

  it("does not forward or execute IDs outside the explicit allowlist", () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const localMutation = vi.fn();

    routeAutomationAction("edit.delete", localMutation, "mixer");

    expect(publish).not.toHaveBeenCalled();
    expect(localMutation).not.toHaveBeenCalled();
  });

  it("executes an allowlisted action locally exactly once in the main role", () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const mainMutation = vi.fn();

    routeAutomationAction(
      "automation.selectedTracks.mode.write",
      mainMutation,
      "main",
    );

    expect(mainMutation).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("behaviorally rejects an invalid receiver ID without mutation", () => {
    const beforeTracks = useDAWStore.getState().tracks;

    expect(executeDetachedMainActionRequest({
      command: "action.execute",
      actionId: "edit.delete",
      selectedTrackIds: [],
      selectedClipIds: [],
      timeSelection: null,
    }, getRegisteredAction, { role: "main" })).toBe(false);
    expect(executeDetachedMainActionRequest({
      command: "action.execute",
      actionId: "automation.not-a-real-action",
      selectedTrackIds: [],
    }, getRegisteredAction, { role: "main" })).toBe(false);
    expect(useDAWStore.getState().tracks).toBe(beforeTracks);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
