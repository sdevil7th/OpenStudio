import { describe, expect, it } from "vitest";
import { countRenderOutputs, reserveUniqueRenderPath } from "../utils/renderJobPlanning";

describe("render output planning", () => {
  it("counts every stem and selected-track output across regions", () => {
    expect(countRenderOutputs({
      source: "stems",
      trackCount: 3,
      selectedTrackCount: 0,
      razorEditCount: 0,
      rangeCount: 2,
    })).toBe(8);
    expect(countRenderOutputs({
      source: "selected_tracks",
      trackCount: 5,
      selectedTrackCount: 2,
      razorEditCount: 0,
      rangeCount: 3,
    })).toBe(6);
  });

  it("counts razor areas independently of region bounds", () => {
    expect(countRenderOutputs({
      source: "razor",
      trackCount: 4,
      selectedTrackCount: 0,
      razorEditCount: 3,
      rangeCount: 5,
    })).toBe(3);
  });

  it("keeps duplicate wildcard results from overwriting one another", () => {
    const reserved = new Set<string>();
    expect(reserveUniqueRenderPath("C:\\Exports\\Song.wav", "master", reserved))
      .toBe("C:\\Exports\\Song.wav");
    expect(reserveUniqueRenderPath("C:\\Exports\\Song.wav", "Lead Guitar", reserved))
      .toBe("C:\\Exports\\Song-Lead Guitar.wav");
    expect(reserveUniqueRenderPath("c:\\exports\\song.wav", "Lead Guitar", reserved))
      .toBe("c:\\exports\\song-Lead Guitar-2.wav");
  });

  it("sanitizes suffixes without damaging the directory or extension", () => {
    const reserved = new Set(["c:\\exports\\song.flac"]);
    expect(reserveUniqueRenderPath("C:\\Exports\\Song.flac", "Bass: DI/FX", reserved))
      .toBe("C:\\Exports\\Song-Bass_ DI_FX.flac");
  });
});
