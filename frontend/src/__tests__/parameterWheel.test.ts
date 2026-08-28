import { describe, expect, it } from "vitest";
import {
  accumulateParameterWheelGesture,
  getParameterWheelStepCount,
  getParameterWheelValue,
} from "../utils/parameterWheel";
import { createWheelDeltaAccumulator } from "../utils/wheelDeltaAccumulator";

describe("parameter wheel values", () => {
  it("moves one declared step per conventional mouse notch", () => {
    expect(getParameterWheelValue(
      { operation: "adjust", amount: -100, precision: "normal" },
      { min: 0, max: 10, value: 5, step: 0.5 },
    )).toBe(5.5);
  });

  it("uses one tenth of the normal step in fine mode", () => {
    expect(getParameterWheelValue(
      { operation: "adjust", amount: 100, precision: "fine" },
      { min: -1, max: 1, value: 0, step: 0.1 },
    )).toBe(-0.01);
  });

  it("keeps tiny packets fractional and preserves exact normal/fine rates", () => {
    expect(getParameterWheelValue(
      { operation: "adjust", amount: -1, precision: "normal" },
      { min: 0, max: 10, value: 5, step: 0.5 },
    )).toBe(5.005);
    expect(getParameterWheelValue(
      { operation: "adjust", amount: -1, precision: "fine" },
      { min: 0, max: 10, value: 5, step: 0.5 },
    )).toBe(5.0005);
  });

  it("scales larger deltas and clamps both ends", () => {
    expect(getParameterWheelValue(
      { operation: "adjust", amount: -800, precision: "normal" },
      { min: 0, max: 1, value: 0.8, step: 0.1 },
    )).toBe(1);
    expect(getParameterWheelValue(
      { operation: "adjust", amount: 800, precision: "normal" },
      { min: 0, max: 1, value: 0.2, step: 0.1 },
    )).toBe(0);
  });

  it("is a no-op for suppress/native gestures and zero deltas", () => {
    expect(getParameterWheelValue(
      { operation: "suppress", amount: -100, precision: "normal" },
      { min: 0, max: 1, value: 0.5 },
    )).toBe(0.5);
  });
});

describe("parameter wheel step counts", () => {
  it("derives direction and precision from the resolved gesture", () => {
    expect(getParameterWheelStepCount(
      { operation: "adjust", amount: -100, precision: "normal" },
    )).toBe(4);
    expect(getParameterWheelStepCount(
      { operation: "adjust", amount: 100, precision: "fine" },
    )).toBe(-1);
  });

  it("supports control-specific rates while retaining resolver precision", () => {
    expect(getParameterWheelStepCount(
      { operation: "adjust", amount: -100, precision: "normal" },
      { normal: 2, fine: 1 },
    )).toBe(2);
    expect(getParameterWheelStepCount(
      { operation: "adjust", amount: -100, precision: "fine" },
      { normal: 2, fine: 1 },
    )).toBe(1);
  });

  it("scales normalized amounts and rejects non-adjustment gestures", () => {
    expect(getParameterWheelStepCount(
      { operation: "adjust", amount: 250, precision: "normal" },
    )).toBe(-10);
    expect(getParameterWheelStepCount(
      { operation: "native-scroll", amount: -100, precision: "fine" },
    )).toBe(0);
    expect(getParameterWheelStepCount(
      { operation: "adjust", amount: 0, precision: "normal" },
    )).toBe(0);
  });

  it("accumulates sub-pixel gesture packets per parameter target", () => {
    const accumulator = createWheelDeltaAccumulator({ quantum: 1 });
    const gesture = {
      profileId: "openstudio",
      ruleId: "parameter.adjust",
      matched: true,
      operation: "adjust" as const,
      target: "parameter" as const,
      axis: "vertical" as const,
      amount: -0.25,
      delta: { x: 0, y: -0.25, mode: "pixel" as const, sourceMode: 0, isZero: false },
      modifiers: {
        primary: false,
        secondary: false,
        alt: false,
        shift: false,
        raw: { control: false, commandOrMeta: false, altOrOption: false, shift: false },
      },
      device: { device: "trackpad" as const, basis: "fractional-pixel-delta" as const },
      anchor: { kind: "hovered-control" as const },
      precision: "normal" as const,
      preventDefault: true,
      stopPropagation: true,
    };

    expect(accumulateParameterWheelGesture(accumulator, gesture, "gain")).toBeNull();
    expect(accumulateParameterWheelGesture(accumulator, gesture, "gain")).toBeNull();
    expect(accumulateParameterWheelGesture(accumulator, gesture, "gain")).toBeNull();
    expect(accumulateParameterWheelGesture(accumulator, gesture, "gain")?.amount).toBe(-1);
    accumulator.dispose();
  });
});
