import { describe, expect, it } from "vitest";
import { hasTimelineClipDragStarted } from "../utils/timelineClipGestures";

describe("timeline clip drag activation", () => {
  it.each([[0, 0], [3, 0], [0, -3], [3, 3], [-3.99, 3.99]])(
    "keeps a click with displacement (%s, %s) pending",
    (x, y) => expect(hasTimelineClipDragStarted(x, y)).toBe(false),
  );

  it.each([[4, 0], [-4, 0], [0, 4], [0, -4], [20, 1]])(
    "activates horizontal or vertical dragging at (%s, %s)",
    (x, y) => expect(hasTimelineClipDragStarted(x, y)).toBe(true),
  );
});
