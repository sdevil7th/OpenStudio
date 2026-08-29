import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeAnchoredVerticalWheelZoom,
  computeSpectrogramBandGeometry,
  computeWheelResizedSize,
  createWheelEditBurstController,
  DEFAULT_TIMELINE_VERTICAL_SCALE_VIEW,
  getAccumulatedWheelNudgeDirection,
  getAccumulatedWheelStepCount,
  getMidiNoteHeightZoomPointerOffset,
  getTimelineHorizontalScrollMax,
  getTimelineVerticalScaleSubtarget,
  getTimelineVisibleContentEnd,
  getWheelNudgeDirection,
  getWheelStepCount,
  updateTimelineVerticalScaleView,
} from "../utils/contextWheelBehaviors";
import { createWheelDeltaAccumulator } from "../utils/wheelDeltaAccumulator";

afterEach(() => {
  vi.useRealTimers();
});

describe("context-specific wheel behavior helpers", () => {
  it.each([
    { amount: -100, expected: 1 },
    { amount: 100, expected: -1 },
    { amount: -250, expected: 2.5 },
    { amount: -1, expected: 0.01 },
    { amount: 0, expected: 0 },
    { amount: Number.NaN, expected: 0 },
  ])("converts $amount to $expected parameter steps", ({ amount, expected }) => {
    expect(getWheelStepCount(amount)).toBe(expected);
  });

  it("accumulates fractional context steps and discrete nudges per target", () => {
    const smooth = createWheelDeltaAccumulator({ quantum: 1 });
    expect(getAccumulatedWheelStepCount(smooth, "fade:a", -0.5)).toBe(0);
    expect(getAccumulatedWheelStepCount(smooth, "fade:a", -0.5)).toBe(0.01);
    expect(getAccumulatedWheelStepCount(smooth, "fade:b", -0.5)).toBe(0);

    const discrete = createWheelDeltaAccumulator({ quantum: 100 });
    expect(getAccumulatedWheelNudgeDirection(discrete, "clip:a", 25)).toBe(0);
    expect(getAccumulatedWheelNudgeDirection(discrete, "clip:a", 25)).toBe(0);
    expect(getAccumulatedWheelNudgeDirection(discrete, "clip:a", 25)).toBe(0);
    expect(getAccumulatedWheelNudgeDirection(discrete, "clip:a", 25)).toBe(1);
    smooth.dispose();
    discrete.dispose();
  });

  it("isolates accumulated edit bursts across target, direction, and disposal", () => {
    const events: string[] = [];
    const controller = createWheelEditBurstController({
      idleMs: 180,
      getKey: (target: { id: string }) => target.id,
      onBegin: (target) => events.push(`begin:${target.id}`),
      onCommit: (target) => events.push(`commit:${target.id}`),
    });
    const accumulator = createWheelDeltaAccumulator({
      quantum: 100,
      idleMs: 180,
      onReset: ({ hadOutput }) => {
        if (hadOutput) controller.commit();
      },
    });
    const dispatchPacket = (id: string, amount: number) => {
      const direction = getAccumulatedWheelNudgeDirection(
        accumulator,
        `note-nudge:${id}`,
        amount,
      );
      if (direction === 0) {
        const pending = controller.getActiveTarget();
        if (pending?.id === id) controller.touch(pending);
        return;
      }
      controller.touch({ id });
      events.push(`output:${id}:${direction}`);
    };

    dispatchPacket("a", 100);
    dispatchPacket("a", 25);
    dispatchPacket("b", 75);
    dispatchPacket("b", 25);
    dispatchPacket("b", -25);
    dispatchPacket("b", -75);
    accumulator.dispose();
    controller.dispose();

    expect(events).toEqual([
      "begin:a",
      "output:a:1",
      "commit:a",
      "begin:b",
      "output:b:1",
      "commit:b",
      "begin:b",
      "output:b:-1",
      "commit:b",
    ]);
  });

  it.each([
    { amount: -120, expected: -1 },
    { amount: 120, expected: 1 },
    { amount: 0, expected: 0 },
    { amount: Number.POSITIVE_INFINITY, expected: 0 },
  ] as const)("maps $amount to nudge direction $expected", ({ amount, expected }) => {
    expect(getWheelNudgeDirection(amount)).toBe(expected);
  });

  it("keeps the MIDI row under the pointer stable while changing note height", () => {
    const before = { itemHeight: 12, scrollOffset: 480, pointerOffset: 120 };
    const rowAtPointer = (before.scrollOffset + before.pointerOffset) / before.itemHeight;
    const result = computeAnchoredVerticalWheelZoom({
      ...before,
      amount: -120,
      minItemHeight: 6,
      maxItemHeight: 36,
      maxScrollOffset: 4_000,
    });

    expect(result.itemHeight).toBeGreaterThan(before.itemHeight);
    expect((result.scrollOffset + before.pointerOffset) / result.itemHeight)
      .toBeCloseTo(rowAtPointer, 10);
  });

  it.each([
    { amount: -100_000, expected: 36 },
    { amount: 100_000, expected: 6 },
  ])("clamps extreme note-height zoom to $expected", ({ amount, expected }) => {
    const result = computeAnchoredVerticalWheelZoom({
      itemHeight: 12,
      scrollOffset: 0,
      pointerOffset: 0,
      amount,
      minItemHeight: 6,
      maxItemHeight: 36,
      maxScrollOffset: 4_000,
    });
    expect(result.itemHeight).toBe(expected);
  });

  it.each([
    { target: "grid" as const, pointer: 0 },
    { target: "grid" as const, pointer: 120 },
    { target: "grid" as const, pointer: 240 },
    { target: "keyboard" as const, pointer: 0 },
    { target: "keyboard" as const, pointer: 120 },
    { target: "keyboard" as const, pointer: 240 },
  ])("anchors $target MIDI note-height zoom at pointer Y $pointer", ({ target, pointer }) => {
    const pointerOffset = getMidiNoteHeightZoomPointerOffset({
      target,
      stagePointerOffset: target === "grid" ? pointer : undefined,
      keyboardPointerOffset: target === "keyboard" ? pointer : undefined,
      gridHeight: 240,
    });
    const rowBefore = (480 + pointerOffset) / 12;
    const result = computeAnchoredVerticalWheelZoom({
      itemHeight: 12,
      scrollOffset: 480,
      pointerOffset,
      amount: -120,
      minItemHeight: 6,
      maxItemHeight: 36,
      maxScrollOffset: 4_000,
    });

    expect(pointerOffset).toBe(pointer);
    expect((result.scrollOffset + pointerOffset) / result.itemHeight)
      .toBeCloseTo(rowBefore, 10);
  });

  it.each([
    { target: "grid" as const, stagePointerOffset: -50, keyboardPointerOffset: undefined, expected: 0 },
    { target: "grid" as const, stagePointerOffset: 500, keyboardPointerOffset: undefined, expected: 240 },
    { target: "keyboard" as const, stagePointerOffset: undefined, keyboardPointerOffset: -50, expected: 0 },
    { target: "keyboard" as const, stagePointerOffset: undefined, keyboardPointerOffset: 500, expected: 240 },
  ])("clamps $target pointer coordinates to the note grid", (entry) => {
    expect(getMidiNoteHeightZoomPointerOffset({
      ...entry,
      gridHeight: 240,
    })).toBe(entry.expected);
  });

  it.each([
    { amount: -120, relation: "grow" },
    { amount: 120, relation: "shrink" },
    { amount: 0, relation: "same" },
  ])("resizes a hovered lane in the expected direction for $amount", ({ amount, relation }) => {
    const result = computeWheelResizedSize({
      currentSize: 60,
      amount,
      minSize: 24,
      maxSize: 240,
    });
    if (relation === "grow") expect(result).toBeGreaterThan(60);
    if (relation === "shrink") expect(result).toBeLessThan(60);
    if (relation === "same") expect(result).toBe(60);
  });

  it.each([
    { amount: -100_000, expected: 240 },
    { amount: 100_000, expected: 24 },
    { amount: Number.NaN, expected: 60 },
  ])("clamps or sanitizes lane resizing for $amount", ({ amount, expected }) => {
    expect(computeWheelResizedSize({
      currentSize: 60,
      amount,
      minSize: 24,
      maxSize: 240,
    })).toBe(expected);
  });

  it("uses MIDI clips when calculating horizontal Timeline wheel extent", () => {
    expect(getTimelineVisibleContentEnd([
      {
        clips: [{ startTime: 1, duration: 2 }],
        midiClips: [{ startTime: 12, duration: 4 }],
      },
    ])).toBe(16);
    expect(getTimelineVisibleContentEnd([
      {
        clips: [],
        midiClips: [{ startTime: 20, duration: 3 }],
      },
    ])).toBe(23);
  });

  it("includes active recording extent and ignores malformed clip geometry", () => {
    expect(getTimelineVisibleContentEnd([
      {
        clips: [
          { startTime: Number.NaN, duration: 10 },
          { startTime: 8, duration: -4 },
        ],
        midiClips: [{ startTime: 2, duration: Number.POSITIVE_INFINITY }],
      },
    ], 14)).toBe(14);
  });

  it("shares one finite horizontal scroll extent between Timeline content and ruler", () => {
    const tracks = [{
      clips: [{ startTime: 4, duration: 2 }],
      midiClips: [{ startTime: 20, duration: 5 }],
    }];
    expect(getTimelineHorizontalScrollMax(tracks, 30, 10, 500)).toBe(2_800);
    expect(getTimelineHorizontalScrollMax(tracks, undefined, 10, 500)).toBe(2_750);
    expect(getTimelineHorizontalScrollMax(tracks, undefined, Number.NaN, 500)).toBe(0);
  });

  it.each([
    { stageX: -0.01, expected: undefined },
    { stageX: 0, expected: "spectrogram_scale" },
    { stageX: 27.99, expected: "spectrogram_scale" },
    { stageX: 28, expected: undefined },
  ])("limits the spectrogram scale target to its exact strip at x=$stageX", ({ stageX, expected }) => {
    expect(getTimelineVerticalScaleSubtarget({
      stageX,
      scaleStripWidth: 28,
      trackType: "audio",
      spectralView: true,
    })).toBe(expected);
  });

  it("keeps spectrogram zoom, pan, and dB floor as independent coexisting view state", () => {
    const zoomed = updateTimelineVerticalScaleView(
      DEFAULT_TIMELINE_VERTICAL_SCALE_VIEW,
      "zoom",
      -120,
    );
    const panned = updateTimelineVerticalScaleView(zoomed, "pan", 100);
    const adjusted = updateTimelineVerticalScaleView(panned, "db-floor", -200);

    expect(adjusted.spectrogramScale).toBeGreaterThan(1);
    expect(adjusted.verticalOffset).toBeCloseTo(0.2);
    expect(adjusted.spectrogramDbFloor).toBe(-70);
  });

  it("clamps every spectrogram scale-strip view dimension", () => {
    const zoomedIn = updateTimelineVerticalScaleView(
      DEFAULT_TIMELINE_VERTICAL_SCALE_VIEW,
      "zoom",
      -100_000,
    );
    const zoomedOut = updateTimelineVerticalScaleView(zoomedIn, "zoom", 100_000);
    const panned = updateTimelineVerticalScaleView(zoomedOut, "pan", 100_000);
    const floored = updateTimelineVerticalScaleView(panned, "db-floor", -100_000);

    expect(zoomedIn.spectrogramScale).toBe(8);
    expect(zoomedOut.spectrogramScale).toBe(0.25);
    expect(panned.verticalOffset).toBe(1);
    expect(floored.spectrogramDbFloor).toBe(-120);
  });

  it("changes rendered spectrogram band geometry when its scale changes", () => {
    const normal = computeSpectrogramBandGeometry({
      height: 80,
      bandCount: 8,
      scale: 1,
      verticalOffset: 0,
    });
    const zoomed = computeSpectrogramBandGeometry({
      height: 80,
      bandCount: 8,
      scale: 2,
      verticalOffset: 0,
    });
    const panned = computeSpectrogramBandGeometry({
      height: 80,
      bandCount: 8,
      scale: 1,
      verticalOffset: 0.5,
    });

    expect(normal[3]).toEqual({ bandIndex: 3, y: 40, height: 10 });
    expect(zoomed[3]).toEqual({ bandIndex: 3, y: 40, height: 20 });
    expect(panned[3].y).toBe(50);
    expect(zoomed).not.toEqual(normal);
  });

  it("groups one target's wheel burst and commits it after the full idle delay", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const controller = createWheelEditBurstController({
      idleMs: 180,
      getKey: (target: { id: string }) => target.id,
      onBegin: (target) => events.push(`begin:${target.id}`),
      onCommit: (target) => events.push(`commit:${target.id}`),
    });

    controller.touch({ id: "lane-a" });
    vi.advanceTimersByTime(100);
    controller.touch({ id: "lane-a" });
    expect(events).toEqual(["begin:lane-a"]);

    vi.advanceTimersByTime(179);
    expect(events).toEqual(["begin:lane-a"]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["begin:lane-a", "commit:lane-a"]);
    expect(controller.getActiveTarget()).toBeNull();
  });

  it("commits when switching targets and when the owning UI is disposed", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const controller = createWheelEditBurstController({
      idleMs: 180,
      getKey: (target: { id: string }) => target.id,
      onBegin: (target) => events.push(`begin:${target.id}`),
      onCommit: (target) => events.push(`commit:${target.id}`),
    });

    controller.touch({ id: "lane-a" });
    controller.touch({ id: "lane-b" });
    controller.dispose();

    expect(events).toEqual([
      "begin:lane-a",
      "commit:lane-a",
      "begin:lane-b",
      "commit:lane-b",
    ]);
    vi.runAllTimers();
    expect(events).toHaveLength(4);
  });
});
