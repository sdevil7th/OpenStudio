import { describe, expect, it } from "vitest";
import {
  resolveNAMChannelMeterDb,
  resolveNAMLinkedMeterDb,
} from "../utils/namMeterLevel";

describe("NAM Rack channel meter telemetry", () => {
  it("prefers current independent channel diagnostics over linked and schema values", () => {
    const diagnostics = {
      inputLevelDb: -5,
      inputLeftLevelDb: -7,
      inputRightLevelDb: -19,
    };

    expect(resolveNAMLinkedMeterDb("input", diagnostics, -30)).toBe(-5);
    expect(resolveNAMChannelMeterDb("input", "left", diagnostics, -31, -5)).toBe(-7);
    expect(resolveNAMChannelMeterDb("input", "right", diagnostics, -32, -5)).toBe(-19);
  });

  it("uses a live linked value only as compatibility fallback for an older native build", () => {
    const diagnostics = { outputLevelDb: -8 };

    expect(resolveNAMChannelMeterDb("output", "left", diagnostics, -20, -8)).toBe(-8);
    expect(resolveNAMChannelMeterDb("output", "right", diagnostics, -26, -8)).toBe(-8);
  });

  it("uses independent schema channels before the first live diagnostic poll", () => {
    expect(resolveNAMChannelMeterDb("input", "left", null, -14, -4)).toBe(-14);
    expect(resolveNAMChannelMeterDb("input", "right", null, -23, -4)).toBe(-23);
  });
});
