import { describe, it, expect } from "vitest";
import { fadeCurve } from "../utils/fadeUtils";

describe("fadeCurve", () => {
  it("linear (shape 0): identity function", () => {
    expect(fadeCurve(0, 0)).toBe(0);
    expect(fadeCurve(0.5, 0)).toBe(0.5);
    expect(fadeCurve(1, 0)).toBe(1);
  });

  it("equal power (shape 1): sqrt curve", () => {
    expect(fadeCurve(0, 1)).toBe(0);
    expect(fadeCurve(1, 1)).toBe(1);
    expect(fadeCurve(0.25, 1)).toBe(0.5); // sqrt(0.25) = 0.5
  });

  it("S-curve (shape 2): stays between 0 and 1", () => {
    expect(fadeCurve(0, 2)).toBe(0);
    expect(fadeCurve(1, 2)).toBe(1);
    expect(fadeCurve(0.5, 2)).toBe(0.5); // symmetric midpoint
  });

  it("logarithmic (shape 3): fast attack", () => {
    expect(fadeCurve(0, 3)).toBeCloseTo(0, 5);
    expect(fadeCurve(1, 3)).toBeCloseTo(1, 5);
    // Log curve rises faster than linear at start
    expect(fadeCurve(0.1, 3)).toBeGreaterThan(0.1);
  });

  it("exponential (shape 4): slow attack", () => {
    expect(fadeCurve(0, 4)).toBeCloseTo(0, 5);
    expect(fadeCurve(1, 4)).toBeCloseTo(1, 5);
    // Exponential curve rises slower than linear at start
    expect(fadeCurve(0.1, 4)).toBeLessThan(0.1);
  });

  it("clamps input to 0-1 range", () => {
    expect(fadeCurve(-0.5, 0)).toBe(0);
    expect(fadeCurve(1.5, 0)).toBe(1);
  });

  it("unknown shape defaults to linear", () => {
    expect(fadeCurve(0.5, 99)).toBe(0.5);
  });
});
