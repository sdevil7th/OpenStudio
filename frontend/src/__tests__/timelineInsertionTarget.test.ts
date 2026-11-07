import { describe, expect, it } from "vitest";
import { resolveTimelineInsertionIndex } from "../utils/timelineDragAxisLock";

describe("shared timeline divider targets", () => {
  it("distinguishes track bodies, dividers and the bottom, including variable rows", () => {
    const rows = [0, 100, 340];
    expect(resolveTimelineInsertionIndex(50, rows, 440)).toBeNull();
    expect(resolveTimelineInsertionIndex(98, rows, 440)).toBe(1);
    expect(resolveTimelineInsertionIndex(342, rows, 440)).toBe(2);
    expect(resolveTimelineInsertionIndex(500, rows, 440)).toBe(3);
    expect(resolveTimelineInsertionIndex(-20, rows, 440)).toBeNull();
  });
  it("holds an acquired divider through small pointer noise", () => {
    expect(resolveTimelineInsertionIndex(106, [0, 100], 200)).toBeNull();
    expect(resolveTimelineInsertionIndex(106, [0, 100], 200, 1)).toBe(1);
    expect(resolveTimelineInsertionIndex(110, [0, 100], 200, 1)).toBeNull();
  });
});
