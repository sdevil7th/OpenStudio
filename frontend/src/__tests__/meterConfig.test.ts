import { describe, it, expect } from "vitest";
import {
  normalizeDbToMeter,
  normalizedMeterToDb,
  linearLevelToDb,
  normalizeLevelToMeter,
} from "../components/meterConfig";

describe("linearLevelToDb", () => {
  it("converts unity gain to 0 dB", () => {
    expect(linearLevelToDb(1.0)).toBeCloseTo(0, 1);
  });

  it("converts half amplitude to ~-6 dB", () => {
    expect(linearLevelToDb(0.5)).toBeCloseTo(-6.02, 1);
  });

  it("converts zero to -Infinity", () => {
    expect(linearLevelToDb(0)).toBe(-Infinity);
  });
});

describe("normalizeDbToMeter / normalizedMeterToDb round-trip", () => {
  const scales = ["dbfs", "extended"] as const;

  for (const scale of scales) {
    it(`round-trips through scale "${scale}"`, () => {
      const testDb = -12;
      const normalized = normalizeDbToMeter(testDb, scale);
      const recovered = normalizedMeterToDb(normalized, scale);
      expect(recovered).toBeCloseTo(testDb, 1);
    });
  }

  it("normalizes 0 dB near top of range", () => {
    const normalized = normalizeDbToMeter(0, "dbfs");
    expect(normalized).toBeGreaterThan(0.8);
    expect(normalized).toBeLessThanOrEqual(1);
  });

  it("normalizes -60 dB near bottom of range", () => {
    const normalized = normalizeDbToMeter(-60, "dbfs");
    expect(normalized).toBeGreaterThanOrEqual(0);
    expect(normalized).toBeLessThan(0.1);
  });
});

describe("normalizeLevelToMeter", () => {
  it("converts linear 1.0 (0 dB) to high meter value", () => {
    const result = normalizeLevelToMeter(1.0, "dbfs");
    expect(result).toBeGreaterThan(0.8);
  });

  it("converts linear 0.0 to 0 meter value", () => {
    expect(normalizeLevelToMeter(0, "dbfs")).toBe(0);
  });
});
