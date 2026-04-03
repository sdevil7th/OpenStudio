import { describe, it, expect } from "vitest";
import {
  automationToBackend,
  interpolateAtTime,
} from "../store/automationParams";

describe("automationToBackend", () => {
  it("converts volume 0.0 to -60 dB", () => {
    expect(automationToBackend("volume", 0)).toBe(-60);
  });

  it("converts volume 1.0 to +6 dB", () => {
    expect(automationToBackend("volume", 1)).toBe(6);
  });

  it("converts volume 0.5 to midpoint (-27 dB)", () => {
    expect(automationToBackend("volume", 0.5)).toBe(-27);
  });

  it("converts pan 0.0 to -1.0 (full left)", () => {
    expect(automationToBackend("pan", 0)).toBe(-1);
  });

  it("converts pan 1.0 to +1.0 (full right)", () => {
    expect(automationToBackend("pan", 1)).toBe(1);
  });

  it("converts pan 0.5 to 0.0 (center)", () => {
    expect(automationToBackend("pan", 0.5)).toBe(0);
  });

  it("returns raw value for unknown params", () => {
    expect(automationToBackend("plugin_0_3", 0.7)).toBe(0.7);
  });
});

describe("interpolateAtTime", () => {
  const points = [
    { time: 0, value: 0 },
    { time: 1, value: 1 },
    { time: 2, value: 0.5 },
  ];

  it("returns first value before first point", () => {
    expect(interpolateAtTime(points, -1)).toBe(0);
  });

  it("returns last value after last point", () => {
    expect(interpolateAtTime(points, 3)).toBe(0.5);
  });

  it("returns exact value at point", () => {
    expect(interpolateAtTime(points, 0)).toBe(0);
    expect(interpolateAtTime(points, 1)).toBe(1);
    expect(interpolateAtTime(points, 2)).toBe(0.5);
  });

  it("interpolates linearly between points", () => {
    expect(interpolateAtTime(points, 0.5)).toBeCloseTo(0.5);
    expect(interpolateAtTime(points, 1.5)).toBeCloseTo(0.75);
  });

  it("returns default value for empty points array", () => {
    expect(interpolateAtTime([], 1)).toBe(0.5);
  });
});
