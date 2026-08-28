import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AutomationPoint,
  useDAWStore,
} from "../store/useDAWStore";
import {
  resolveAutomationPointDrag,
  type AutomationPointDragGesture,
} from "../utils/automationPointDrag";
import { snapTimeByType } from "../utils/snapToGrid";

const originalState = useDAWStore.getState();

const gesture = (
  action: AutomationPointDragGesture["action"],
  overrides: Partial<AutomationPointDragGesture> = {},
): AutomationPointDragGesture => ({
  action,
  originalX: 125,
  originalY: 50,
  originalTime: 1.25,
  originalValue: 0.5,
  axisLock: null,
  ...overrides,
});

const resolve = (
  action: AutomationPointDragGesture["action"],
  overrides: Partial<Parameters<typeof resolveAutomationPointDrag>[1]> = {},
  gestureOverrides: Partial<AutomationPointDragGesture> = {},
) => resolveAutomationPointDrag(gesture(action, gestureOverrides), {
  rawX: 137,
  rawY: 20,
  scrollX: 0,
  pixelsPerSecond: 100,
  laneTop: 0,
  laneHeight: 100,
  snapEnabled: false,
  snapTime: (time) => time,
  ...overrides,
});

describe("automation point drag geometry", () => {
  it("snaps ordinary time movement through the active Timeline grid resolver", () => {
    const snapTime = vi.fn((time: number, originalTime: number) => snapTimeByType({
      time,
      originalTime,
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      gridSize: "beat",
      snapType: "grid",
    }));

    const result = resolve("move", { snapEnabled: true, snapTime });

    expect(snapTime).toHaveBeenCalledOnce();
    expect(snapTime).toHaveBeenCalledWith(1.37, 1.25);
    expect(result).toMatchObject({
      time: 1.5,
      value: 0.8,
      x: 150,
      snapApplied: true,
      timeLocked: false,
      valueLocked: false,
    });
    expect(result.y).toBeCloseTo(20);
  });

  it("preserves raw time for the explicit snap-bypass action", () => {
    const snapTime = vi.fn(() => 99);

    const result = resolve("bypass_snap", { snapEnabled: true, snapTime });

    expect(snapTime).not.toHaveBeenCalled();
    expect(result.time).toBeCloseTo(1.37);
    expect(result.x).toBeCloseTo(137);
    expect(result.value).toBeCloseTo(0.8);
    expect(result.snapApplied).toBe(false);
  });

  it("defines constrain_x as time-only movement and constrain_y as value-only movement", () => {
    const snapTime = vi.fn(() => 1.5);
    const horizontal = resolve("constrain_x", { snapEnabled: true, snapTime });
    expect(horizontal).toMatchObject({
      time: 1.5,
      value: 0.5,
      x: 150,
      y: 50,
      timeLocked: false,
      valueLocked: true,
      snapApplied: true,
    });

    snapTime.mockClear();
    const vertical = resolve("constrain_y", { snapEnabled: true, snapTime });
    expect(vertical).toMatchObject({
      time: 1.25,
      value: 0.8,
      x: 125,
      timeLocked: true,
      valueLocked: false,
      snapApplied: false,
    });
    expect(vertical.y).toBeCloseTo(20);
    expect(snapTime).not.toHaveBeenCalled();
  });

  it("preserves both meanings for fine/axis plus snap-bypass compounds", () => {
    const snapTime = vi.fn(() => 99);
    const horizontal = resolve("constrain_x_bypass_snap", {
      snapEnabled: true,
      snapTime,
    });
    expect(horizontal.time).toBeCloseTo(1.37);
    expect(horizontal.value).toBe(0.5);
    expect(horizontal).toMatchObject({ valueLocked: true, snapApplied: false });

    const vertical = resolve("constrain_y_bypass_snap", {
      snapEnabled: true,
      snapTime,
    });
    expect(vertical.time).toBe(1.25);
    expect(vertical.value).toBeCloseTo(0.8);
    expect(vertical).toMatchObject({ timeLocked: true, snapApplied: false });

    const fine = resolve("fine_bypass_snap", {
      rawX: 225,
      rawY: -50,
      snapEnabled: true,
      snapTime,
    });
    expect(fine.time).toBeCloseTo(1.35);
    expect(fine.value).toBeCloseTo(0.6);
    expect(fine.snapApplied).toBe(false);

    const dominant = resolve("constrain_axis_bypass_snap", {
      rawX: 137,
      rawY: 47,
      snapEnabled: true,
      snapTime,
    });
    expect(dominant).toMatchObject({
      axisLock: "time",
      value: 0.5,
      valueLocked: true,
      snapApplied: false,
    });
    expect(dominant.time).toBeCloseTo(1.37);
    expect(snapTime).not.toHaveBeenCalled();
  });

  it("treats Reason copy movement like ordinary movement and preserves its axis constraint", () => {
    const copied = resolve("copy", {
      snapEnabled: true,
      snapTime: () => 1.5,
    });
    expect(copied).toMatchObject({
      time: 1.5,
      value: 0.8,
      snapApplied: true,
      timeLocked: false,
      valueLocked: false,
    });

    const constrainedCopy = resolve("copy_constrain_axis", {
      rawX: 140,
      rawY: 47,
      snapEnabled: false,
    });
    expect(constrainedCopy).toMatchObject({
      axisLock: "time",
      value: 0.5,
      valueLocked: true,
    });
    expect(constrainedCopy.time).toBeCloseTo(1.4);
  });

  it("chooses and then preserves the dominant axis after the movement threshold", () => {
    const undecided = resolve("constrain_axis", {
      rawX: 126,
      rawY: 49,
    });
    expect(undecided.axisLock).toBeNull();
    expect(undecided.valueLocked).toBe(false);
    expect(undecided.timeLocked).toBe(false);

    const horizontal = resolve("constrain_axis", {
      rawX: 130,
      rawY: 47,
    });
    expect(horizontal).toMatchObject({ axisLock: "time", valueLocked: true });
    expect(horizontal.value).toBe(0.5);

    const stillHorizontal = resolve(
      "constrain_axis",
      { rawX: 126, rawY: 5 },
      { axisLock: horizontal.axisLock },
    );
    expect(stillHorizontal).toMatchObject({ axisLock: "time", valueLocked: true });
    expect(stillHorizontal.value).toBe(0.5);

    const vertical = resolve("constrain_axis", {
      rawX: 127,
      rawY: 40,
    });
    expect(vertical).toMatchObject({
      axisLock: "value",
      timeLocked: true,
      time: 1.25,
    });
  });

  it("applies fine movement before snapping and clamps time/value safely", () => {
    const fine = resolve("fine", {
      rawX: 225,
      rawY: -50,
      snapEnabled: false,
    });
    expect(fine.time).toBeCloseTo(1.35);
    expect(fine.value).toBeCloseTo(0.6);

    const clamped = resolve("bypass_snap", {
      rawX: -1_000,
      rawY: 1_000,
      scrollX: 50,
    });
    expect(clamped).toMatchObject({ time: 0, value: 0, x: -50, y: 100 });
  });
});

describe("automation point drag transaction", () => {
  const point = (id: string, time: number, value: number): AutomationPoint => ({
    id,
    time,
    value,
  });

  beforeEach(() => {
    useDAWStore.getState().cancelAutomationPointEdit();
    commandManager.clear();
    vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [{
        ...createDefaultTrack("track-a", "Track A", "#fff", "audio", []),
        showAutomation: true,
        automationLanes: [{
          id: "track-volume",
          param: "volume",
          points: [point("stable-point", 1.25, 0.5)],
          visible: true,
          mode: "read",
          armed: false,
          readEnabled: true,
        }],
      }],
      masterAutomationLanes: [],
      selectedAutomationTarget: null,
      lockSettings: {
        ...useDAWStore.getState().lockSettings,
        envelopes: false,
      },
      isModified: false,
      canUndo: false,
      canRedo: false,
    });
  });

  afterEach(() => {
    useDAWStore.getState().cancelAutomationPointEdit();
    commandManager.clear();
    vi.restoreAllMocks();
    useDAWStore.setState(originalState);
  });

  const target = {
    kind: "track" as const,
    trackId: "track-a",
    laneId: "track-volume",
    pointId: "stable-point",
  };

  const currentPoint = () => useDAWStore.getState().tracks[0].automationLanes[0].points[0];

  it("commits a snapped preview with its stable ID as exactly one undo command", () => {
    const preview = resolve("move", {
      snapEnabled: true,
      snapTime: () => 1.5,
    });

    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(preview.time, preview.value)).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(true);
    expect(currentPoint()).toEqual(point("stable-point", 1.5, 0.8));
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(currentPoint()).toEqual(point("stable-point", 1.25, 0.5));
  });

  it("restores cancellation exactly and creates no history for cancellation or a no-op drag", () => {
    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(2, 0.9)).toBe(true);
    expect(useDAWStore.getState().cancelAutomationPointEdit()).toBe(true);
    expect(currentPoint()).toEqual(point("stable-point", 1.25, 0.5));
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(1.25, 0.5)).toBe(true);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(false);
    expect(currentPoint()).toEqual(point("stable-point", 1.25, 0.5));
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("copy-drags a stable point while preserving a new stable-ID source copy in one command", () => {
    expect(useDAWStore.getState().beginAutomationPointCopyEdit(target)).toBe(true);
    let points = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(points).toHaveLength(2);
    const preservedCopy = points.find((candidate) => candidate.id !== "stable-point");
    expect(preservedCopy).toMatchObject({ time: 1.25, value: 0.5 });
    expect(preservedCopy?.id).toBeTypeOf("string");

    expect(useDAWStore.getState().previewAutomationPointEdit(2, 0.75)).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(true);

    points = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(points).toHaveLength(2);
    expect(points.find((candidate) => candidate.id === "stable-point")).toEqual(
      point("stable-point", 2, 0.75),
    );
    expect(points.find((candidate) => candidate.id === preservedCopy?.id)).toEqual(preservedCopy);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([
      point("stable-point", 1.25, 0.5),
    ]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(points);
  });

  it("removes a provisional source copy exactly on cancel and on snapped no-op commit", () => {
    expect(useDAWStore.getState().beginAutomationPointCopyEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(2, 0.75)).toBe(true);
    expect(useDAWStore.getState().cancelAutomationPointEdit()).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([
      point("stable-point", 1.25, 0.5),
    ]);
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    expect(useDAWStore.getState().beginAutomationPointCopyEdit(target)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(1.25, 0.5)).toBe(true);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(false);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([
      point("stable-point", 1.25, 0.5),
    ]);
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("uses the same atomic copy transaction for a master automation point", () => {
    useDAWStore.setState({
      masterAutomationLanes: [{
        id: "master-volume",
        param: "volume",
        points: [point("master-stable", 1, 0.25)],
        visible: true,
        mode: "read",
        armed: false,
        readEnabled: true,
      }],
    });
    const masterTarget = {
      kind: "master" as const,
      laneId: "master-volume",
      pointId: "master-stable",
    };

    expect(useDAWStore.getState().beginAutomationPointCopyEdit(masterTarget)).toBe(true);
    expect(useDAWStore.getState().previewAutomationPointEdit(2, 0.75)).toBe(true);
    expect(useDAWStore.getState().commitAutomationPointEdit()).toBe(true);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toHaveLength(2);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toContainEqual(
      point("master-stable", 2, 0.75),
    );
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual([
      point("master-stable", 1, 0.25),
    ]);
  });

  it("rejects a transaction while envelope locking is enabled", () => {
    useDAWStore.setState({
      lockSettings: {
        ...useDAWStore.getState().lockSettings,
        envelopes: true,
      },
    });

    expect(useDAWStore.getState().beginAutomationPointEdit(target)).toBe(false);
    expect(useDAWStore.getState().beginAutomationPointCopyEdit(target)).toBe(false);
    expect(currentPoint()).toEqual(point("stable-point", 1.25, 0.5));
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
