import { describe, it, expect } from "vitest";
import {
  automationToBackend,
  interpolateAtTime,
  getAutomationDefault,
  pluginAutomationParamId,
} from "../store/automationParams";

describe("automationToBackend", () => {
  it("converts volume 0.0 to -60 dB", () => {
    expect(automationToBackend("volume", 0)).toBe(-60);
  });

  it("converts volume 1.0 to +12 dB", () => {
    expect(automationToBackend("volume", 1)).toBe(12);
  });

  it("converts volume 0.5 to midpoint (-24 dB)", () => {
    expect(automationToBackend("volume", 0.5)).toBe(-24);
  });

  it("maps the default volume lane to exactly 0 dB", () => {
    expect(automationToBackend("volume", getAutomationDefault("volume"))).toBeCloseTo(0);
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

  it("builds namespaced plugin automation ids", () => {
    expect(pluginAutomationParamId(true, 0, 3)).toBe("plugin_input_0_3");
    expect(pluginAutomationParamId(false, 2, 4)).toBe("plugin_track_2_4");
  });

  it("converts MIDI automation params to backend ranges", () => {
    expect(automationToBackend("midi_velocity_scale", 0.5)).toBe(1);
    expect(automationToBackend("midi_pitch_bend", 0)).toBe(-1);
    expect(automationToBackend("midi_pitch_bend", 1)).toBe(1);
    expect(automationToBackend("midi_cc_74", 1)).toBe(127);
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
