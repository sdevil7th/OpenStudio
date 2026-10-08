import { describe, expect, it } from "vitest";
import { eqFrequencyTicks, eqFrequencyWindow } from "./eqFrequencyView";

describe("EQ frequency view", () => {
  it("keeps logarithmic width while panning against both limits", () => {
    for (const zoom of [2, 4, 8]) for (const center of [1, 20, 1000, 20000, 1e9]) {
      const view = eqFrequencyWindow(zoom, center);
      expect(view.min).toBeGreaterThanOrEqual(20 - 1e-10);
      expect(view.max).toBeLessThanOrEqual(20000 + 1e-8);
      expect(Math.log(view.max / view.min)).toBeCloseTo(Math.log(1000) / zoom, 12);
      expect(Math.sqrt(view.min * view.max)).toBeCloseTo(view.center, 8);
    }
  });
  it("restores the exact full range and handles invalid local values", () => {
    expect(eqFrequencyWindow(1, 20000)).toEqual({ min: 20, max: 20000, center: Math.sqrt(400000) });
    expect(eqFrequencyWindow(NaN, NaN)).toEqual(eqFrequencyWindow(1, 20));
    expect(eqFrequencyWindow(4, NaN)).toEqual(eqFrequencyWindow(4, Math.sqrt(400000)));
  });
  it("keeps visible ticks readable across zoom levels and compact widths", () => {
    for (const zoom of [1, 2, 4, 8]) for (const width of [240, 568, 928]) {
      const view = eqFrequencyWindow(zoom, 1000);
      const ticks = eqFrequencyTicks(view.min, view.max, width);
      expect(ticks.length).toBeGreaterThan(1);
      ticks.forEach((hz, i) => {
        expect(hz).toBeGreaterThanOrEqual(view.min); expect(hz).toBeLessThanOrEqual(view.max);
        if (i) expect(Math.log(hz / ticks[i - 1]) / Math.log(view.max / view.min) * width).toBeGreaterThanOrEqual(45 - 1e-10);
      });
    }
  });
});
