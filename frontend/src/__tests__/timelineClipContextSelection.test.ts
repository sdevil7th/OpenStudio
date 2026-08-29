import { describe, expect, it } from "vitest";
import { shouldPreserveClipContextSelection } from "../utils/timelineClipContextSelection";

describe("timeline clip context-menu selection", () => {
  it("preserves a multi-clip selection for a selected member", () => {
    expect(shouldPreserveClipContextSelection({
      selectedClipIds: ["one", "two"],
      selectedTrackIds: [],
    }, "two", "track-b")).toBe(true);
  });

  it("preserves selected tracks when no clips are selected", () => {
    expect(shouldPreserveClipContextSelection({
      selectedClipIds: [],
      selectedTrackIds: ["track-a", "track-b"],
    }, "unselected-clip", "track-b")).toBe(true);
  });

  it("selects an anchor outside the active clip or track scope", () => {
    expect(shouldPreserveClipContextSelection({
      selectedClipIds: ["one", "two"],
      selectedTrackIds: ["track-a", "track-b"],
    }, "outside", "track-c")).toBe(false);
  });

  it("does not let a selected track override an active clip selection", () => {
    expect(shouldPreserveClipContextSelection({
      selectedClipIds: ["one"],
      selectedTrackIds: ["track-b"],
    }, "outside", "track-b")).toBe(false);
  });
});
