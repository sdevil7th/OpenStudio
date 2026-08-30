import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  type AutomationLane,
  type AutomationPoint,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function masterLane(points: AutomationPoint[] = [], overrides: Partial<AutomationLane> = {}): AutomationLane {
  return {
    id: "master-volume",
    param: "volume",
    points,
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
    ...overrides,
  };
}

function currentPoints(): AutomationPoint[] {
  return useDAWStore.getState().masterAutomationLanes[0]?.points ?? [];
}

function expectCurrentPointValues(expected: Array<{ time: number; value: number }>) {
  const points = currentPoints();
  expect(points.map(({ time, value }) => ({ time, value }))).toEqual(expected);
  expect(points.every((point) => typeof point.id === "string" && point.id.length > 0)).toBe(true);
  expect(new Set(points.map((point) => point.id)).size).toBe(expected.length);
}

beforeEach(() => {
  commandManager.clear();
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
  useDAWStore.setState({
    masterAutomationLanes: [],
    masterAutomationReadEnabled: false,
    masterAutomationWriteEnabled: false,
    masterAutomationEnabled: false,
    automationWriteBehavior: "touch",
    globalLocked: false,
    lockSettings: { ...useDAWStore.getState().lockSettings, envelopes: false },
    canUndo: false,
    canRedo: false,
    isModified: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("undo-aware master automation points", () => {
  it("adds a clamped point, enables read, and restores the exact prior state", () => {
    const originalPoints = [
      { id: "stacked-a", time: 1, value: 0.8 },
      { id: "stacked-b", time: 1, value: 0.2 },
    ];
    useDAWStore.setState({
      masterAutomationLanes: [masterLane(originalPoints, { mode: "off", readEnabled: false })],
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
    });

    useDAWStore.getState().addMasterAutomationPoint("master-volume", -4, 2);

    expectCurrentPointValues([
      { time: 0, value: 1 },
      { time: 1, value: 0.8 },
      { time: 1, value: 0.2 },
    ]);
    expect(useDAWStore.getState()).toMatchObject({
      masterAutomationReadEnabled: true,
      masterAutomationEnabled: true,
      canUndo: true,
    });
    expect(useDAWStore.getState().masterAutomationLanes[0]).toMatchObject({
      mode: "read",
      readEnabled: true,
    });

    useDAWStore.getState().undo();
    expect(currentPoints()).toEqual(originalPoints);
    expect(useDAWStore.getState()).toMatchObject({
      masterAutomationReadEnabled: false,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: false,
    });
    expect(useDAWStore.getState().masterAutomationLanes[0]).toMatchObject({
      mode: "off",
      readEnabled: false,
    });

    useDAWStore.getState().redo();
    expectCurrentPointValues([
      { time: 0, value: 1 },
      { time: 1, value: 0.8 },
      { time: 1, value: 0.2 },
    ]);
  });

  it("removes exactly the requested stacked point and restores its order on undo", () => {
    const originalPoints = [
      { id: "stacked-a", time: 1, value: 0.1 },
      { id: "stacked-b", time: 1, value: 0.2 },
      { id: "later", time: 2, value: 0.3 },
    ];
    useDAWStore.setState({ masterAutomationLanes: [masterLane(originalPoints)] });

    useDAWStore.getState().removeMasterAutomationPoint("master-volume", 1);
    expectCurrentPointValues([
      { time: 1, value: 0.1 },
      { time: 2, value: 0.3 },
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(currentPoints()).toEqual(originalPoints);
    useDAWStore.getState().redo();
    expectCurrentPointValues([
      { time: 1, value: 0.1 },
      { time: 2, value: 0.3 },
    ]);
  });

  it("moves a point through neighbours in one command and restores index identity", () => {
    const originalPoints = [
      { id: "moving", time: 1, value: 0.1 },
      { id: "middle", time: 2, value: 0.2 },
      { id: "last", time: 3, value: 0.3 },
    ];
    useDAWStore.setState({ masterAutomationLanes: [masterLane(originalPoints)] });

    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 4, 0.9);
    expectCurrentPointValues([
      { time: 2, value: 0.2 },
      { time: 3, value: 0.3 },
      { time: 4, value: 0.9 },
    ]);
    expect(currentPoints().map((point) => point.id)).toEqual(["middle", "last", "moving"]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(currentPoints()).toEqual(originalPoints);
    useDAWStore.getState().redo();
    expectCurrentPointValues([
      { time: 2, value: 0.2 },
      { time: 3, value: 0.3 },
      { time: 4, value: 0.9 },
    ]);
  });

  it("keeps equal-time point ordering stable after a move", () => {
    useDAWStore.setState({
      masterAutomationLanes: [masterLane([
        { id: "first", time: 1, value: 0.1 },
        { id: "second", time: 1, value: 0.2 },
        { id: "moving", time: 3, value: 0.3 },
      ])],
    });

    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 2, 1, 0.9);
    expectCurrentPointValues([
      { time: 1, value: 0.1 },
      { time: 1, value: 0.2 },
      { time: 1, value: 0.9 },
    ]);
    expect(currentPoints().map((point) => point.id)).toEqual(["first", "second", "moving"]);
  });

  it("sanitizes non-finite movement and does not record malformed or missing targets", () => {
    useDAWStore.setState({ masterAutomationLanes: [masterLane([{ id: "stable", time: 2, value: 0.5 }])] });

    for (const pointIndex of [-1, 0.5, 2, Number.NaN]) {
      useDAWStore.getState().moveMasterAutomationPoint(
        "master-volume",
        pointIndex,
        4,
        0.8,
      );
      useDAWStore.getState().removeMasterAutomationPoint("master-volume", pointIndex);
    }
    useDAWStore.getState().addMasterAutomationPoint("missing", 1, 0.5);
    useDAWStore.getState().moveMasterAutomationPoint("missing", 0, 1, 0.5);
    useDAWStore.getState().removeMasterAutomationPoint("missing", 0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expectCurrentPointValues([{ time: 2, value: 0.5 }]);

    useDAWStore.setState({
      masterAutomationLanes: [{
        ...masterLane(),
        points: undefined,
      } as unknown as AutomationLane],
    });
    expect(() => {
      useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 1, 0.5);
      useDAWStore.getState().removeMasterAutomationPoint("master-volume", 0);
    }).not.toThrow();
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState({ masterAutomationLanes: [masterLane([{ id: "stable", time: 2, value: 0.5 }])] });

    useDAWStore.getState().moveMasterAutomationPoint(
      "master-volume",
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    );
    expectCurrentPointValues([{ time: 2, value: 0.5 }]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("does not create an undo entry for a no-op move", () => {
    useDAWStore.setState({ masterAutomationLanes: [masterLane([{ id: "stable", time: 2, value: 0.5 }])] });

    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 2, 0.5);

    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().canUndo).toBe(false);
  });

  it("synchronizes execute, undo, and redo to the master backend lane", () => {
    useDAWStore.setState({ masterAutomationLanes: [masterLane([{ id: "stable", time: 2, value: 0.5 }])] });
    const pointsSpy = vi.mocked(nativeBridge.setAutomationPoints);

    useDAWStore.getState().moveMasterAutomationPoint("master-volume", 0, 3, 0.75);
    useDAWStore.getState().undo();
    useDAWStore.getState().redo();

    expect(pointsSpy).toHaveBeenCalledTimes(3);
    expect(pointsSpy.mock.calls.every(([trackId, param]) => (
      trackId === "master" && param === "volume"
    ))).toBe(true);
  });
});
