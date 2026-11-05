import { describe, expect, it } from "vitest";
import { getTimelineRulerDensity } from "../utils/timelineRulerDensity";
import { calculateGridInterval, resolveVisualGrid } from "../utils/snapToGrid";

describe("wide timeline density", () => {
  it("keeps bar labels readable and bounds ticks across zoom, meter and distant positions", () => {
    for (const tempo of [40, 154, 300]) for (const meter of [
      { numerator: 4, denominator: 4 }, { numerator: 7, denominator: 8 }, { numerator: 3, denominator: 2 },
    ]) for (const zoom of [1, 2, 10, 100, 1000]) for (const scroll of [0, 400000]) {
      const density = getTimelineRulerDensity(zoom, tempo, meter, scroll, 1280);
      expect(density.secondsPerBar * zoom * density.labelEveryBars).toBeGreaterThanOrEqual(48);
      expect(density.secondsPerBar * zoom * density.barStep).toBeGreaterThanOrEqual(8);
      expect(density.labelEveryBars % density.barStep).toBe(0);
      expect(density.secondsPerBar).toBeCloseTo(60 / tempo * 4 / meter.denominator * meter.numerator);
    }
  });

  it("retains fine subdivisions at close zoom", () => {
    const density = getTimelineRulerDensity(1000, 120, { numerator: 4, denominator: 4 }, 700, 800);
    expect(density.mode).toBe("division");
    expect(density.divisionsPerBeat).toBe(8);
    expect(density.barStep).toBe(1);
  });

  it("coarsens only displayed lines, keeping exact snap intervals and bar alignment", () => {
    for (const meter of [{ numerator: 4, denominator: 4 }, { numerator: 7, denominator: 8 }]) {
      const visual = resolveVisualGrid(154, meter, "1/16", {
        pixelsPerSecond: 1, viewportPixels: 1280, maxVisibleLines: 100, minPixelsPerGrid: 18,
      });
      expect(visual.gridInterval).toBe(calculateGridInterval(154, meter, "1/16"));
      expect(visual.visualInterval).toBeGreaterThanOrEqual(18);
      expect(visual.visualInterval / visual.barInterval).toBe(Math.round(visual.visualInterval / visual.barInterval));
      expect(Math.ceil(1280 / visual.visualInterval)).toBeLessThanOrEqual(100);
    }
  });
});
