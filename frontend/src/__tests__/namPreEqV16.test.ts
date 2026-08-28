import { describe, expect, it } from "vitest";

import {
  projectNAMRackSchemaForUI,
  type BuiltInParamDescriptor,
  type BuiltInPluginSchema,
} from "../services/NativeBridge";
import {
  NAM_GRAPHIC_EQ_FILTER_OFF_DETENT,
  formatParamValue,
  namGraphicEqActiveRecallUpdate,
  namGraphicEqFilterHzFromNormalized,
  namGraphicEqFilterNormalizedFromHz,
  normalizeParamValue,
  offsetParamValue,
  paramValueFromRangeInput,
  rangeInputMax,
  rangeInputMin,
  rangeInputValue,
} from "../utils/builtInParamValue";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

const makeFilter = (
  id: "preEqHPFHz" | "preEqLPFHz",
  value: number,
): BuiltInParamDescriptor => ({
  id,
  label: id === "preEqHPFHz" ? "PRE HPF" : "PRE LPF",
  type: "continuous",
  value,
  min: id === "preEqHPFHz" ? 0 : 3000,
  max: id === "preEqHPFHz" ? 180 : 24000,
  defaultValue: id === "preEqHPFHz" ? 0 : 24000,
  unit: "Hz",
  automatable: true,
});

describe("NAM Rack PRE EQ V19 state and control contract", () => {
  it("uses logarithmic active travel with opposite six-percent OFF detents", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(19);
    const detent = NAM_GRAPHIC_EQ_FILTER_OFF_DETENT;

    expect(namGraphicEqFilterHzFromNormalized("preEqHPFHz", detent / 2)).toBe(0);
    expect(namGraphicEqFilterHzFromNormalized("preEqHPFHz", detent)).toBeCloseTo(35, 6);
    expect(namGraphicEqFilterHzFromNormalized("preEqHPFHz", 1)).toBeCloseTo(180, 6);
    expect(namGraphicEqFilterHzFromNormalized("preEqHPFHz", (1 + detent) / 2))
      .toBeCloseTo(Math.sqrt(35 * 180), 6);

    expect(namGraphicEqFilterHzFromNormalized("preEqLPFHz", 0)).toBeCloseTo(3000, 6);
    expect(namGraphicEqFilterHzFromNormalized("preEqLPFHz", 1 - detent)).toBeCloseTo(20000, 6);
    expect(namGraphicEqFilterHzFromNormalized("preEqLPFHz", 1 - detent / 2)).toBe(24000);
    expect(namGraphicEqFilterHzFromNormalized("preEqLPFHz", (1 - detent) / 2))
      .toBeCloseTo(Math.sqrt(3000 * 20000), 6);

    expect(namGraphicEqFilterNormalizedFromHz("preEqHPFHz", 0)).toBe(0);
    expect(namGraphicEqFilterNormalizedFromHz("preEqHPFHz", 35)).toBeCloseTo(detent, 8);
    expect(namGraphicEqFilterNormalizedFromHz("preEqLPFHz", 20000)).toBeCloseTo(1 - detent, 8);
    expect(namGraphicEqFilterNormalizedFromHz("preEqLPFHz", 24000)).toBe(1);
  });

  it("uses the curved domain for range, wheel, and keyboard paths", () => {
    const hpfOff = makeFilter("preEqHPFHz", 0);
    const lpfOff = makeFilter("preEqLPFHz", 24000);

    expect(rangeInputMin(hpfOff)).toBe(0);
    expect(rangeInputMax(hpfOff)).toBe(1);
    expect(rangeInputValue(hpfOff)).toBe(0);
    expect(rangeInputValue(lpfOff)).toBe(1);
    expect(normalizeParamValue(makeFilter("preEqHPFHz", 35), 35))
      .toBeCloseTo(NAM_GRAPHIC_EQ_FILTER_OFF_DETENT, 8);
    expect(paramValueFromRangeInput(hpfOff, NAM_GRAPHIC_EQ_FILTER_OFF_DETENT)).toBeCloseTo(35, 6);
    expect(offsetParamValue(hpfOff, 0, 1)).toBe(35);
    expect(offsetParamValue(hpfOff, 0, -1)).toBe(0);
    expect(offsetParamValue(lpfOff, 24000, -1)).toBe(20000);
    expect(offsetParamValue(lpfOff, 24000, 1)).toBe(24000);
    expect(formatParamValue(hpfOff)).toBe("OFF");
    expect(formatParamValue(lpfOff)).toBe("OFF");
  });

  it("updates private recall only for active cutoffs", () => {
    expect(namGraphicEqActiveRecallUpdate("preEqHPFHz", 70))
      .toEqual(["preEqHPFLastActiveHz", 70]);
    expect(namGraphicEqActiveRecallUpdate("preEqLPFHz", 12500))
      .toEqual(["preEqLPFLastActiveHz", 12500]);
    expect(namGraphicEqActiveRecallUpdate("preEqHPFHz", 0)).toBeNull();
    expect(namGraphicEqActiveRecallUpdate("preEqLPFHz", 24000)).toBeNull();
  });

  it("rejects pre-V16 collisions and migrates the V16-V18 seven-band layout", () => {
    const legacy = migrateLegacyNAMRackPresetDspState({
      values: {
        preEqEnabled: 1,
        preEq100Db: 9,
        preEqHPFHz: 120,
        preEqLPFHz: 7000,
        preEqHPFLastActiveHz: 140,
        preEqLPFLastActiveHz: 6000,
      },
      dspState: { namEffectsDspVersion: 15 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(legacy.values).toMatchObject({
      preEqEnabled: 0,
      preEq120Db: 0,
      preEq12kDb: 0,
      preEqHPFHz: 0,
      preEqLPFHz: 24000,
      preEqHPFLastActiveHz: 80,
      preEqLPFLastActiveHz: 12000,
    });

    expect(legacy.values).not.toHaveProperty("preEq100Db");

    const migratedV18 = migrateLegacyNAMRackPresetDspState({
      values: {
        preEqEnabled: 1,
        preEq100Db: -3.5,
        preEq200Db: -2,
        preEq400Db: -1,
        preEq800Db: 0.5,
        preEq1k6Db: 1.5,
        preEq3k2Db: 2.5,
        preEq6k4Db: 3.5,
        preEq12kDb: 11,
        preEqHPFHz: 64,
        preEqLPFHz: 13000,
        preEqHPFLastActiveHz: 64,
        preEqLPFLastActiveHz: 13000,
      },
      dspState: { namEffectsDspVersion: 18 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(migratedV18.values).toMatchObject({
      preEqEnabled: 1,
      preEq120Db: -3.5,
      preEq250Db: -2,
      preEq500Db: -1,
      preEq1kDb: 0.5,
      preEq2k5Db: 1.5,
      preEq5kDb: 2.5,
      preEq8kDb: 3.5,
      preEq12kDb: 0,
      preEqHPFHz: 64,
      preEqLPFHz: 13000,
      preEqHPFLastActiveHz: 64,
      preEqLPFLastActiveHz: 13000,
    });
    expect(migratedV18.values).not.toHaveProperty("preEq100Db");
    expect(migratedV18.values).not.toHaveProperty("preEq6k4Db");
  });

  it("round-trips all eight current bands without treating V19 as legacy", () => {
    const current = migrateLegacyNAMRackPresetDspState({
      values: {
        preEqEnabled: 1,
        preEq120Db: -4,
        preEq250Db: -3,
        preEq500Db: -2,
        preEq1kDb: -1,
        preEq2k5Db: 1,
        preEq5kDb: 2,
        preEq8kDb: 3,
        preEq12kDb: 4,
        preEqHPFHz: 0,
        preEqLPFHz: 24000,
      },
      dspState: { namEffectsDspVersion: 19 },
    }, { completePreset: true }) as {
      values: Record<string, number>;
      dspState: Record<string, number>;
    };
    expect(current.values).toMatchObject({
      preEq120Db: -4,
      preEq250Db: -3,
      preEq500Db: -2,
      preEq1kDb: -1,
      preEq2k5Db: 1,
      preEq5kDb: 2,
      preEq8kDb: 3,
      preEq12kDb: 4,
    });
    expect(current.dspState.namEffectsDspVersion).toBe(19);
  });

  it("migrates baseline and Compare snapshots with the enclosing legacy version", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { preEqEnabled: 1, preEq100Db: -2 },
      dspState: { namEffectsDspVersion: 18 },
      uiState: {
        namPresetBaseline: {
          values: { preEqEnabled: 1, preEq6k4Db: 4 },
        },
        namRackCompare: {
          snapshots: {
            A: { values: { preEq200Db: -5 } },
            B: {
              values: { preEq12kDb: 6 },
              dspState: { namEffectsDspVersion: 19 },
            },
          },
        },
      },
    }, { completePreset: true }) as Record<string, any>;

    expect(migrated.values).toMatchObject({ preEq120Db: -2, preEq12kDb: 0 });
    expect(migrated.uiState.namPresetBaseline.values).toMatchObject({
      preEq8kDb: 4,
      preEq12kDb: 0,
    });
    expect(migrated.uiState.namRackCompare.snapshots.A.values.preEq250Db).toBe(-5);
    expect(migrated.uiState.namRackCompare.snapshots.B.values.preEq12kDb).toBe(6);
    expect(migrated.uiState.namPresetBaseline.values).not.toHaveProperty("preEq6k4Db");
  });

  it("hides retired band IDs from a mixed-version native schema", () => {
    const parameters: BuiltInPluginSchema["parameters"] = [
      {
        id: "preEq100Db",
        label: "100 Hz",
        type: "continuous",
        value: 3,
        min: -12,
        max: 12,
        defaultValue: 0,
      },
      {
        id: "preEq120Db",
        label: "120 Hz",
        type: "continuous",
        value: 3,
        min: -12,
        max: 12,
        defaultValue: 0,
      },
    ];
    const projected = projectNAMRackSchemaForUI({
      schemaVersion: 1,
      name: "OpenStudio NAM Rack",
      category: "NAM",
      chain: "track",
      fxIndex: 0,
      parameters,
      modelState: { namEffectsDspVersion: 18 },
    });

    expect(projected.parameters.map(({ id }) => id)).toEqual(["preEq120Db"]);
  });
});
