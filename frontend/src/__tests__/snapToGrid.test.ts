import { describe, it, expect } from "vitest";
import {
  calculateGridInterval,
  FACTORY_QUANTIZE_PRESETS,
  getQuantizePresetById,
  resolveVisualGrid,
  snapTimeByType,
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

  it("resolves straight, triplet, and dotted Cubase-style note values", () => {
    expect(calculateGridInterval(120, TS_4_4, "1/1")).toBe(2);
    expect(calculateGridInterval(120, TS_3_4, "1/1")).toBe(2);
    expect(calculateGridInterval(120, TS_4_4, "1/16")).toBe(0.125);
    expect(calculateGridInterval(120, TS_4_4, "1/8T")).toBeCloseTo(1 / 6, 6);
    expect(calculateGridInterval(120, TS_4_4, "1/8D")).toBe(0.375);
  });

  it("resolves Use Quantize through the active quantize preset", () => {
    const preset = getQuantizePresetById(FACTORY_QUANTIZE_PRESETS, "factory-1/32");
    expect(calculateGridInterval(120, TS_4_4, "use_quantize", { quantizePreset: preset })).toBe(0.0625);
  });

  it("adapts to zoom from coarse bars to fine subdivisions", () => {
    expect(calculateGridInterval(120, TS_4_4, "adapt_to_zoom", { pixelsPerSecond: 4 })).toBe(2);
    expect(calculateGridInterval(120, TS_4_4, "adapt_to_zoom", { pixelsPerSecond: 1200 })).toBe(0.03125);
  });
});

describe("resolveVisualGrid", () => {
  it("thins dense straight grids using equal bar subdivisions", () => {
    const visual = resolveVisualGrid(120, TS_4_4, "1/16", {
      pixelsPerSecond: 55,
      minPixelsPerGrid: 18,
    });

    expect(visual.alignedToBar).toBe(true);
    expect(visual.divisionsPerBar).toBe(4);
    expect(visual.visualInterval).toBe(0.5);
  });

  it("shows the full grid when spacing is readable", () => {
    const visual = resolveVisualGrid(120, TS_4_4, "1/16", {
      pixelsPerSecond: 200,
      minPixelsPerGrid: 18,
    });

    expect(visual.alignedToBar).toBe(true);
    expect(visual.divisionsPerBar).toBe(16);
    expect(visual.visualInterval).toBe(0.125);
  });
});

describe("snapTimeByType", () => {
  it("snaps to grid candidates", () => {
    expect(snapTimeByType({
      time: 0.19,
      tempo: 120,
      timeSignature: TS_4_4,
      gridSize: "1/16",
      snapType: "grid",
    })).toBe(0.25);
  });

  it("preserves the original offset for Grid Relative", () => {
    expect(snapTimeByType({
      time: 0.44,
      originalTime: 0.06,
      tempo: 120,
      timeSignature: TS_4_4,
      gridSize: "1/16",
      snapType: "grid_relative",
    })).toBeCloseTo(0.435, 6);
  });

  it("chooses event and cursor candidates for combined snap types", () => {
    expect(snapTimeByType({
      time: 1.03,
      tempo: 120,
      timeSignature: TS_4_4,
      gridSize: "1/4",
      snapType: "events_grid_cursor",
      cursorTime: 0.88,
      eventTimes: [1.01, 1.7],
    })).toBe(1.01);
  });

  it("includes adjacent event candidates for Shuffle snap", () => {
    expect(snapTimeByType({
      time: 0.92,
      tempo: 120,
      timeSignature: TS_4_4,
      gridSize: "1/4",
      snapType: "shuffle",
      eventTimes: [0.91, 1.5],
    })).toBe(0.91);
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
