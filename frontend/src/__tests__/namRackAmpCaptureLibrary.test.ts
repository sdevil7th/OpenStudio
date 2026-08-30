import { describe, expect, it } from "vitest";
import {
  rankNAMRackAmpCaptures,
  rankNAMRackCabIRs,
} from "../utils/namRackAmpCaptureLibrary";

describe("NAM Rack amp capture rail ranking", () => {
  it("keeps the active capture first and then ranks captures by saved-preset usage", () => {
    const captures = [
      { localPath: "C:\\NAM\\Clean.nam", name: "Clean" },
      { localPath: "C:\\NAM\\Heavy.nam", name: "Heavy" },
      { localPath: "C:\\NAM\\Lead.nam", name: "Lead" },
    ];
    const ranked = rankNAMRackAmpCaptures(
      captures,
      ["c:/nam/heavy.nam", "C:\\NAM\\Heavy.nam", "C:\\NAM\\Clean.nam"],
      "C:\\NAM\\Lead.nam",
    );

    expect(ranked.map((entry) => entry.name)).toEqual(["Lead", "Heavy", "Clean"]);
    expect(ranked.map((entry) => entry.presetUsageCount)).toEqual([0, 2, 1]);
    expect(ranked[0].active).toBe(true);
  });

  it("filters non-amp library records and uses stable tie-breakers", () => {
    const ranked = rankNAMRackAmpCaptures([
      { localPath: "z.nam", name: "Zulu", gearType: "amp", favorite: false, installedAt: "2025-01-01" },
      { localPath: "a.nam", name: "Alpha", gearType: "full rig", favorite: true, installedAt: "2024-01-01" },
      { localPath: "cab.wav", name: "Cab", gearType: "ir", favorite: true },
    ], [], undefined);

    expect(ranked.map((entry) => entry.name)).toEqual(["Alpha", "Zulu"]);
  });

  it("merges manifest and persistent IR history without duplicate paths", () => {
    const ranked = rankNAMRackCabIRs([
      { localPath: "C:\\IRs\\Mesa.wav", name: "Mesa", gearType: "cabinet ir" },
      { localPath: "c:/irs/mesa.wav", favorite: true, gearType: "ir", lastUsed: 20 },
      { localPath: "C:\\IRs\\Orange.flac", name: "Orange", lastUsed: 10 },
      { localPath: "C:\\NAM\\Amp.nam", name: "Amp", gearType: "amp" },
    ], "C:\\IRs\\Orange.flac");

    expect(ranked).toHaveLength(2);
    expect(ranked.map((entry) => entry.name)).toEqual(["Orange", "Mesa"]);
    expect(ranked[0].active).toBe(true);
    expect(ranked[1].favorite).toBe(true);
  });
});
