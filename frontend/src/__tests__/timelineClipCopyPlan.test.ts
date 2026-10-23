import { describe, expect, it } from "vitest";
import { planTimelineClipCopy, type TimelineCopySource } from "../utils/timelineClipCopyPlan";
import type { Track } from "../store/useDAWStore";

const track = (id: string, type: Track["type"] = "audio", extra: Partial<Track> = {}) => ({
  id, type, frozen: extra.frozen ?? false, isFolder: extra.isFolder,
});
const source = (clipId: string, sourceTrackId: string, isMidi = false): TimelineCopySource => ({
  clipId, sourceTrackId, isMidi, originalStartTime: 2, duration: 1,
});

describe("timeline copy destinations", () => {
  it("uses source IDs when collapsed children make full and visible row indices differ", () => {
    const plan = planTimelineClipCopy({
      tracks: [track("folder", "audio", { isFolder: true }), track("hidden"), track("a"), track("b")],
      visibleTrackIds: ["folder", "a", "b"], sources: [source("ca", "a"), source("cb", "b")],
      anchorTrackId: "a", targetRowIndex: 1,
    });
    expect(plan?.placements.map(row => [row.clipId, row.targetRowIndex, row.targetTrackId]))
      .toEqual([["ca", 1, "a"], ["cb", 2, "b"]]);
    expect(plan?.newTracks).toEqual([]);
  });

  it("moves the entire mixed group to generated rows when one requested destination is incompatible", () => {
    const plan = planTimelineClipCopy({
      tracks: [track("a"), track("m", "midi"), track("m2", "midi"), track("b")],
      visibleTrackIds: ["a", "m", "m2", "b"], sources: [source("ca", "a"), source("cm", "m", true)],
      anchorTrackId: "a", targetRowIndex: 1,
    });
    expect(plan?.placements.map(row => [row.clipId, row.targetRowIndex, row.targetTrackId]))
      .toEqual([["ca", 4, undefined], ["cm", 5, undefined]]);
    expect(plan?.newTracks).toEqual([{ rowIndex: 4, type: "audio" }, { rowIndex: 5, type: "midi" }]);
  });

  it.each([{ frozen: true }, { isFolder: true }])("does not copy onto an unavailable target %j", extra => {
    const plan = planTimelineClipCopy({
      tracks: [track("a"), track("blocked", "audio", extra)], visibleTrackIds: ["a", "blocked"],
      sources: [source("ca", "a")], anchorTrackId: "a", targetRowIndex: 1,
    });
    expect(plan?.placements[0].targetRowIndex).toBe(2);
    expect(plan?.newTracks).toHaveLength(1);
  });

  it("retains row gaps and includes selected hidden sources instead of silently dropping them", () => {
    const plan = planTimelineClipCopy({
      tracks: [track("folder", "audio", { isFolder: true }), track("hidden"), track("gap"), track("a")],
      visibleTrackIds: ["folder", "a"], sources: [source("hiddenClip", "hidden"), source("ca", "a")],
      anchorTrackId: "a", targetRowIndex: 1,
    });
    expect(plan?.placements.map(row => [row.clipId, row.targetRowIndex]))
      .toEqual([["hiddenClip", 2], ["ca", 4]]);
    expect(plan?.newTracks).toHaveLength(3);
  });

  it("keeps a group above the pointer in bounds when dragging its last row upward", () => {
    const plan = planTimelineClipCopy({
      tracks: [track("a"), track("gap"), track("b")], visibleTrackIds: ["a", "gap", "b"],
      sources: [source("ca", "a"), source("cb", "b")], anchorTrackId: "b", targetRowIndex: 0,
    });
    expect(plan?.targetAnchorRowIndex).toBe(2);
    expect(plan?.placements.map(row => row.targetTrackId)).toEqual(["a", "b"]);
  });

  it("rejects a gesture whose source track disappeared", () => {
    expect(planTimelineClipCopy({ tracks: [track("a")], visibleTrackIds: ["a"],
      sources: [source("missing", "removed")], anchorTrackId: "a", targetRowIndex: 0 })).toBeNull();
  });
});
