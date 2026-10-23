import { describe, expect, it } from "vitest";
import { getRulerDragZoom, resolveRulerDragAxis } from "../utils/timelineRulerDrag";

describe("timeline ruler direction and time zoom", () => {
  it("treats a click as pending and locks the first dominant direction", () => {
    expect(resolveRulerDragAxis(null, 3, 2)).toBeNull();
    expect(resolveRulerDragAxis(null, 7, -20)).toBe("y");
    expect(resolveRulerDragAxis("y", 70, -2)).toBe("y");
    expect(resolveRulerDragAxis(null, 20, 7)).toBe("x");
    expect(resolveRulerDragAxis("x", 2, 70)).toBe("x");
  });

  it("zooms out upward, in downward, with the original time under the cursor", () => {
    const up = getRulerDragZoom(100, -30, 10, 200);
    const down = getRulerDragZoom(100, 30, 10, 200);
    expect(up.pixelsPerSecond).toBeLessThan(100);
    expect(down.pixelsPerSecond).toBeGreaterThan(100);
    expect((up.scrollX + 200) / up.pixelsPerSecond).toBeCloseTo(10);
    expect((down.scrollX + 200) / down.pixelsPerSecond).toBeCloseTo(10);
  });

  it("clamps time zoom and scroll at the supported boundaries", () => {
    expect(getRulerDragZoom(100, 10000, 0, 200)).toEqual({ pixelsPerSecond: 1000, scrollX: 0 });
    expect(getRulerDragZoom(100, -10000, 0, 200)).toEqual({ pixelsPerSecond: 1, scrollX: 0 });
  });
});
