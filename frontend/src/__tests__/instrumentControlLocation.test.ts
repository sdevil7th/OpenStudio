import { describe, expect, it } from "vitest";
import { instrumentControlLocation } from "../components/builtin/instrumentControlLocation";

describe("instrument feature navigation", () => {
  it("reveals all eight synth matrix routes, including expanded automation aliases", () => {
    for (let route = 1; route <= 8; route++) for (const suffix of ["Source", "Target", "TargetFull", "Amount"])
      expect(instrumentControlLocation("synth", `matrix${route}${suffix}`)).toEqual({ page: "Modulation", section: "Matrix", route });
    expect(instrumentControlLocation("synth", "macro4Channel")).toEqual({ page: "Expression", macro: 4 });
    expect(instrumentControlLocation("synth", "macro4")).toEqual({ page: "Modulation", section: "Macros" });
    expect(instrumentControlLocation("synth", "filterReleaseMs")?.page).toBe("Filter envelope");
  });
  it("keeps performance controls discoverable outside the compact primary views", () => {
    expect(instrumentControlLocation("piano", "softPedalDepth")?.page).toBe("Performance");
    expect(instrumentControlLocation("piano", "coupledBody")?.page).toBe("Resonance");
    expect(instrumentControlLocation("guitar", "harmonicNode")).toEqual({ page: "Play", section: "Articulation" });
    expect(instrumentControlLocation("guitar", "stringMode")).toEqual({ page: "Play", section: "Performance" });
  });
  it("selects the requested drum mixer group without changing the MIDI input map", () => {
    for (let piece = 0; piece < 8; piece++) for (const field of ["Gain", "Tuning", "Pan", "Decay", "Output"])
      expect(instrumentControlLocation("drums", `piece${field}${piece}`)).toEqual({ page: "Kit", section: "Selected piece", piece });
    for (let input = 0; input < 128; input++)
      expect(instrumentControlLocation("drums", `noteMap${input}`)).toEqual({ page: "Mapping", mapInput: input });
  });
  it("leaves pinned output controls on the current page", () => {
    for (const kind of ["synth", "piano", "guitar", "drums"] as const) expect(instrumentControlLocation(kind, "outputGain")).toBeNull();
    expect(instrumentControlLocation("drums", "stereoWidth")).toBeNull();
  });
});
