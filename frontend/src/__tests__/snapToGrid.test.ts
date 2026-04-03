import { describe, it, expect } from "vitest";
import {
  calculateGridInterval,
  snapToGrid,
  snapToGridFloor,
  snapToGridCeil,
} from "../utils/snapToGrid";

const TS_4_4 = { numerator: 4, denominator: 4 };
const TS_3_4 = { numerator: 3, denominator: 4 };

describe("calculateGridInterval", () => {
  it("returns correct bar interval at 120 BPM 4/4", () => {
    // 120 BPM = 0.5s per beat, 4 beats = 2s per bar
    expect(calculateGridInterval(120, TS_4_4, "bar")).toBe(2);
  });

  it("returns correct beat interval at 120 BPM", () => {
    expect(calculateGridInterval(120, TS_4_4, "beat")).toBe(0.5);
  });

  it("returns correct half_beat interval", () => {
    expect(calculateGridInterval(120, TS_4_4, "half_beat")).toBe(0.25);
  });

  it("returns correct quarter_beat interval", () => {
    expect(calculateGridInterval(120, TS_4_4, "quarter_beat")).toBe(0.125);
  });

  it("handles 3/4 time signature", () => {
    // 120 BPM = 0.5s per beat, 3 beats = 1.5s per bar
    expect(calculateGridInterval(120, TS_3_4, "bar")).toBe(1.5);
  });

  it("returns 1 second for 'second' grid", () => {
    expect(calculateGridInterval(120, TS_4_4, "second")).toBe(1);
  });

  it("returns 60 seconds for 'minute' grid", () => {
    expect(calculateGridInterval(120, TS_4_4, "minute")).toBe(60);
  });

  it("handles slow tempo (60 BPM)", () => {
    // 60 BPM = 1s per beat, 4 beats = 4s per bar
    expect(calculateGridInterval(60, TS_4_4, "bar")).toBe(4);
    expect(calculateGridInterval(60, TS_4_4, "beat")).toBe(1);
  });
});

describe("snapToGrid", () => {
  it("snaps to nearest beat at 120 BPM", () => {
    // Beats at 0, 0.5, 1.0, 1.5, ...
    expect(snapToGrid(0.3, 120, TS_4_4, "beat")).toBe(0.5);
    expect(snapToGrid(0.2, 120, TS_4_4, "beat")).toBe(0);
    expect(snapToGrid(0.75, 120, TS_4_4, "beat")).toBe(1.0);
  });

  it("snaps to nearest bar at 120 BPM 4/4", () => {
    // Bars at 0, 2, 4, 6, ...
    expect(snapToGrid(0.9, 120, TS_4_4, "bar")).toBe(0);
    expect(snapToGrid(1.1, 120, TS_4_4, "bar")).toBe(2);
  });

  it("never returns negative values", () => {
    expect(snapToGrid(-0.5, 120, TS_4_4, "beat")).toBe(0);
  });

  it("handles exact grid positions", () => {
    expect(snapToGrid(1.0, 120, TS_4_4, "beat")).toBe(1.0);
  });
});

describe("snapToGridFloor", () => {
  it("always rounds down", () => {
    expect(snapToGridFloor(0.7, 120, TS_4_4, "beat")).toBe(0.5);
    expect(snapToGridFloor(0.9, 120, TS_4_4, "beat")).toBe(0.5);
    expect(snapToGridFloor(1.0, 120, TS_4_4, "beat")).toBe(1.0);
  });

  it("never returns negative", () => {
    expect(snapToGridFloor(-1, 120, TS_4_4, "beat")).toBe(0);
  });
});

describe("snapToGridCeil", () => {
  it("always rounds up", () => {
    expect(snapToGridCeil(0.1, 120, TS_4_4, "beat")).toBe(0.5);
    expect(snapToGridCeil(0.5, 120, TS_4_4, "beat")).toBe(0.5);
    expect(snapToGridCeil(0.51, 120, TS_4_4, "beat")).toBe(1.0);
  });
});
