import { describe, expect, it } from "vitest";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import {
  chorusRateHzFromNormalized,
  chorusRateNormalizedFromHz,
  migrateLegacyChorusRateAutomationValue,
  normalizeParamValue,
  quantizeParamValue,
} from "../utils/builtInParamValue";

const chorusRateParam: BuiltInParamDescriptor = {
  id: "chorusRateHz",
  label: "Chorus Rate",
  type: "continuous",
  value: 1,
  min: 0.01,
  max: 8,
  defaultValue: 0.75,
  unit: "Hz",
  automatable: true,
  graphRole: "modulation",
};

describe("NAM Rack chorus rate curve", () => {
  it("lands exactly on 0.01, 1, and 8 Hz", () => {
    expect(chorusRateHzFromNormalized(0)).toBeCloseTo(0.01, 8);
    expect(chorusRateHzFromNormalized(0.5)).toBeCloseTo(1, 8);
    expect(chorusRateHzFromNormalized(1)).toBeCloseTo(8, 8);
  });

  it("matches the intended smooth representative values", () => {
    expect(chorusRateHzFromNormalized(0.25)).toBeCloseTo(0.1545, 3);
    expect(chorusRateHzFromNormalized(0.75)).toBeCloseTo(3.4423, 3);
  });

  it("round-trips raw Hz through the knob position", () => {
    for (const rate of [0.01, 0.0438, 0.1545, 0.4382, 1, 1.9487, 3.4423, 5.5118, 8]) {
      expect(chorusRateHzFromNormalized(chorusRateNormalizedFromHz(rate))).toBeCloseTo(rate, 5);
    }
    expect(normalizeParamValue(chorusRateParam, 1)).toBeCloseTo(0.5, 8);
  });

  it("quantizes in knob space so the slow range keeps useful resolution", () => {
    const quantized = quantizeParamValue(chorusRateParam, 0.011);
    expect(quantized).toBeGreaterThanOrEqual(0.01);
    expect(quantized).toBeLessThan(0.02);
  });

  it("migrates legacy linear automation without changing its audible Hz value", () => {
    for (const legacyNormalized of [0, 0.25, 0.5, 0.75, 1]) {
      const legacyRate = 0.05 + legacyNormalized * 7.95;
      const migrated = migrateLegacyChorusRateAutomationValue(legacyNormalized);
      expect(chorusRateHzFromNormalized(migrated)).toBeCloseTo(legacyRate, 5);
    }
  });
});
