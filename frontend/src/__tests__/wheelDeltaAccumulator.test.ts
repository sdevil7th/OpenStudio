import { afterEach, describe, expect, it, vi } from "vitest";
import { createWheelDeltaAccumulator } from "../utils/wheelDeltaAccumulator";

afterEach(() => {
  vi.useRealTimers();
});

describe("wheel delta accumulator", () => {
  it("combines tiny high-resolution packets while preserving a 100px notch exactly", () => {
    const accumulator = createWheelDeltaAccumulator({ quantum: 1 });

    expect(accumulator.consume("gain", -0.25)).toBe(0);
    expect(accumulator.consume("gain", -0.25)).toBe(0);
    expect(accumulator.consume("gain", -0.25)).toBe(0);
    expect(accumulator.consume("gain", -0.25)).toBe(-1);
    accumulator.reset();
    expect(accumulator.consume("gain", -100)).toBe(-100);
    accumulator.dispose();
  });

  it("drops residue on a direction reversal", () => {
    const resets: string[] = [];
    const accumulator = createWheelDeltaAccumulator({
      quantum: 1,
      onReset: ({ reason }) => resets.push(reason),
    });

    expect(accumulator.consume("gain", 0.75)).toBe(0);
    expect(accumulator.consume("gain", -0.5)).toBe(0);
    expect(accumulator.getState().remainder).toBe(-0.5);
    expect(resets).toEqual(["direction-change"]);
    accumulator.dispose();
  });

  it("does not leak residue when switching targets", () => {
    const resets: string[] = [];
    const accumulator = createWheelDeltaAccumulator({
      quantum: 1,
      onReset: ({ reason, targetKey }) => resets.push(`${reason}:${targetKey}`),
    });

    expect(accumulator.consume("gain", 0.75)).toBe(0);
    expect(accumulator.consume("pan", 0.5)).toBe(0);
    expect(accumulator.consume("pan", 0.5)).toBe(1);
    expect(resets).toEqual(["target-change:gain"]);
    accumulator.dispose();
  });

  it("ends a burst after idle and disposal exactly once", () => {
    vi.useFakeTimers();
    const resets: string[] = [];
    const accumulator = createWheelDeltaAccumulator({
      quantum: 1,
      idleMs: 180,
      onReset: ({ reason, targetKey }) => resets.push(`${reason}:${targetKey}`),
    });

    accumulator.consume("gain", 1);
    vi.advanceTimersByTime(179);
    expect(resets).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(resets).toEqual(["idle:gain"]);

    accumulator.consume("pan", -0.5);
    accumulator.dispose();
    accumulator.dispose();
    expect(resets).toEqual(["idle:gain", "dispose:pan"]);
    expect(accumulator.consume("pan", -100)).toBe(0);
    vi.runAllTimers();
    expect(resets).toHaveLength(2);
  });
});
