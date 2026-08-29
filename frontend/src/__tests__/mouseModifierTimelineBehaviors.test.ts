import { describe, expect, it } from "vitest";
import {
  CLIP_FADE_SHAPE_COUNT,
  FINE_MOUSE_POINTER_SCALE,
  SAFE_MOUSE_MODIFIER_NOOPS,
  computeMouseModifierTimelineResize,
  getNextClipFadeShape,
  getSafeMouseModifierNoop,
} from "../utils/mouseModifierTimelineBehaviors";

const base = {
  kind: "resize-right" as const,
  isMidi: false,
  originalStartTime: 4,
  originalDuration: 6,
  originalOffset: 3,
  sourceLength: 20,
};

describe("mouse-modifier timeline resize behavior", () => {
  it("preserves ordinary resize behavior", () => {
    expect(computeMouseModifierTimelineResize({
      ...base,
      action: "resize",
      deltaTime: 2,
    })).toEqual({ startTime: 4, duration: 8, offset: 3 });
  });

  it("scales fine resize movement without changing its anchor", () => {
    expect(FINE_MOUSE_POINTER_SCALE).toBe(0.1);
    expect(computeMouseModifierTimelineResize({
      ...base,
      action: "fine",
      deltaTime: 2,
    })).toEqual({ startTime: 4, duration: 6.2, offset: 3 });
  });

  it("previews stretch geometry without trimming source material", () => {
    expect(computeMouseModifierTimelineResize({
      ...base,
      action: "stretch",
      deltaTime: 3,
    })).toEqual({ startTime: 4, duration: 9, offset: 4.5 });
  });

  it.each([
    {
      kind: "resize-left" as const,
      deltaTime: 1,
      expected: { startTime: 5, duration: 4, offset: 4 },
    },
    {
      kind: "resize-right" as const,
      deltaTime: 1,
      expected: { startTime: 3, duration: 8, offset: 2 },
    },
  ])("keeps the clip center fixed for $kind", ({ kind, deltaTime, expected }) => {
    expect(computeMouseModifierTimelineResize({
      ...base,
      kind,
      action: "symmetric",
      deltaTime,
    })).toEqual(expected);
  });

  it("clamps symmetric expansion at the timeline and source boundaries", () => {
    expect(computeMouseModifierTimelineResize({
      kind: "resize-left",
      action: "symmetric",
      isMidi: false,
      originalStartTime: 1,
      originalDuration: 4,
      originalOffset: 1,
      sourceLength: 6,
      deltaTime: -10,
    })).toEqual({ startTime: 0, duration: 6, offset: 0 });

    expect(computeMouseModifierTimelineResize({
      kind: "resize-right",
      action: "symmetric",
      isMidi: false,
      originalStartTime: 5,
      originalDuration: 4,
      originalOffset: 2,
      sourceLength: 7,
      deltaTime: 10,
    })).toEqual({ startTime: 4, duration: 6, offset: 1 });
  });

  it("honors snapping before applying symmetric bounds", () => {
    expect(computeMouseModifierTimelineResize({
      ...base,
      action: "symmetric",
      deltaTime: 0.4,
      snapTime: (time) => Math.round(time),
    })).toEqual({ startTime: 4, duration: 6, offset: 3 });
  });
});

describe("explicit safe mouse-modifier no-ops", () => {
  it("has no guarded modifier operations after stretch and master automation integration", () => {
    expect(SAFE_MOUSE_MODIFIER_NOOPS).toEqual([]);
  });

  it("does not classify implemented operations as no-ops", () => {
    expect(getSafeMouseModifierNoop("clip_resize", "stretch")).toBeNull();
    expect(getSafeMouseModifierNoop("fade_handle", "shape_cycle")).toBeNull();
    expect(getSafeMouseModifierNoop("clip_resize", "fine")).toBeNull();
    expect(getSafeMouseModifierNoop("clip_drag", "move")).toBeNull();
  });

});

describe("fade-shape cycling", () => {
  it("advances each supported shape and wraps the final shape to linear", () => {
    expect(CLIP_FADE_SHAPE_COUNT).toBe(5);
    expect(Array.from(
      { length: CLIP_FADE_SHAPE_COUNT },
      (_, shape) => getNextClipFadeShape(shape),
    )).toEqual([1, 2, 3, 4, 0]);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "recovers malformed shape %s through the first valid shape",
    (shape) => {
      expect(getNextClipFadeShape(shape)).toBe(1);
    },
  );
});
