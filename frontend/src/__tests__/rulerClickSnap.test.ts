import { describe, expect, it } from "vitest";
import { getRulerClickSnapTime } from "../utils/rulerClickSnap";

const TS_4_4 = { numerator: 4, denominator: 4 };

describe("getRulerClickSnapTime", () => {
  it("prefers nearest beat when within the ruler snap threshold", () => {
    expect(
      getRulerClickSnapTime({
        time: 0.52,
        pixelsPerSecond: 100,
        tempo: 120,
        timeSignature: TS_4_4,
        gridSize: "quarter_beat",
        snapEnabled: false,
      })
    ).toBe(0.5);
  });

  it("falls back to grid snap when beat snap is too far and grid snap is close", () => {
    expect(
      getRulerClickSnapTime({
        time: 0.37,
        pixelsPerSecond: 100,
        tempo: 120,
        timeSignature: TS_4_4,
        gridSize: "quarter_beat",
        snapEnabled: true,
      })
    ).toBe(0.375);
  });

  it("returns the raw time when no snap target is within threshold", () => {
    expect(
      getRulerClickSnapTime({
        time: 0.28,
        pixelsPerSecond: 100,
        tempo: 120,
        timeSignature: TS_4_4,
        gridSize: "minute",
        snapEnabled: true,
      })
    ).toBe(0.28);
  });

  it("uses beat snap even when ctrl bypass is active", () => {
    expect(
      getRulerClickSnapTime({
        time: 0.52,
        pixelsPerSecond: 100,
        tempo: 120,
        timeSignature: TS_4_4,
        gridSize: "quarter_beat",
        snapEnabled: true,
        ctrlBypass: true,
      })
    ).toBe(0.5);
  });

  it("skips grid fallback when ctrl bypass is active", () => {
    expect(
      getRulerClickSnapTime({
        time: 0.37,
        pixelsPerSecond: 100,
        tempo: 120,
        timeSignature: TS_4_4,
        gridSize: "quarter_beat",
        snapEnabled: true,
        ctrlBypass: true,
      })
    ).toBe(0.37);
  });
});
