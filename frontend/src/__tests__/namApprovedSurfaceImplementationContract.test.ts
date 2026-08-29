import { describe, expect, it } from "vitest";

import { createNAMBootSchema } from "../components/BuiltInPluginPanel";
import {
  NAM_AMP_FACEPLATE_LAYOUT,
  NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT,
  NAM_PRE_SIGNAL_LAYOUT,
} from "../components/NAMRackDesignPort";
import { NAM_RACK_ADVANCED_CONTROL_IDS } from "../components/NAMRackMixer";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  CURRENT_NAM_REVERB_ENGINE_VERSION,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

const PRE_EQ_PARAM_IDS = [
  "preEqEnabled",
  "preEq120Db",
  "preEq250Db",
  "preEq500Db",
  "preEq1kDb",
  "preEq2k5Db",
  "preEq5kDb",
  "preEq8kDb",
  "preEq12kDb",
  "preEqHPFHz",
  "preEqLPFHz",
] as const;

const PRE_EQ_BAND_IDS = PRE_EQ_PARAM_IDS.slice(1, 9);

const DRIVE_PARAM_IDS = [
  "precisionDriveEnabled",
  "precisionDriveDrive",
  "precisionDriveVolumeDb",
  "precisionDriveBright",
  "precisionDriveAttack",
  "precisionDriveGate",
] as const;

const AMP_PARAM_IDS = [
  "ampEnabled",
  "ampBoost",
  "ampVoice",
  "ampGainDb",
  "bassDb",
  "midDb",
  "trebleDb",
  "presenceDb",
  "ampMix",
  "ampOutputDb",
] as const;

const POST_EQ_BAND_IDS = [
  "eq65Db",
  "eq125Db",
  "eq250Db",
  "eq500Db",
  "eq1kDb",
  "eq2kDb",
  "eq4kDb",
  "eq8kDb",
  "eq16kDb",
] as const;

const POST_EQ_PARAM_IDS = [
  "eqEnabled",
  ...POST_EQ_BAND_IDS,
  "eqHPFHz",
  "eqLevelDb",
  "eqLPFHz",
] as const;

describe("NAM Rack approved-surface implementation contract", () => {
  it("exposes every approved Amp, post-EQ, Drive, and PRE-EQ parameter in the boot schema", () => {
    const schema = createNAMBootSchema(
      { chain: "track", trackId: "approved-surface-contract", fxIndex: 0 },
      "OpenStudio NAM Rack",
    );
    const byId = new Map(schema.parameters.map((parameter) => [parameter.id, parameter]));
    const required = [
      ...AMP_PARAM_IDS,
      ...POST_EQ_PARAM_IDS,
      ...DRIVE_PARAM_IDS,
      ...PRE_EQ_PARAM_IDS,
    ];

    for (const paramId of required) expect(byId.has(paramId), paramId).toBe(true);
    expect(byId.has("preEqLevelDb")).toBe(false);

    expect(byId.get("preEqEnabled")).toMatchObject({
      type: "toggle",
      min: 0,
      max: 1,
      defaultValue: 0,
      automatable: true,
    });
    for (const paramId of PRE_EQ_BAND_IDS) {
      expect(byId.get(paramId)).toMatchObject({
        type: "continuous",
        min: -12,
        max: 12,
        defaultValue: 0,
        unit: "dB",
        automatable: true,
      });
    }
    expect(byId.get("preEqHPFHz")).toMatchObject({
      type: "continuous",
      min: 0,
      max: 180,
      defaultValue: 0,
      unit: "Hz",
      automatable: true,
    });
    expect(byId.get("preEqLPFHz")).toMatchObject({
      type: "continuous",
      min: 3000,
      max: 24000,
      defaultValue: 24000,
      unit: "Hz",
      automatable: true,
    });
  });

  it("keeps EQ Boost and Precision Drive independently addressable as separate stages", () => {
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["pre-eq"]).toEqual(PRE_EQ_PARAM_IDS);
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["precision-drive"]).toEqual(DRIVE_PARAM_IDS);
    expect(new Set(NAM_RACK_ADVANCED_CONTROL_IDS["precision-drive"]).size).toBe(6);
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["precision-drive"]).not.toContain("preEqLevelDb");
  });

  it("preserves every remaining pedal size while centring the five-device PRE row", () => {
    expect(NAM_PRE_SIGNAL_LAYOUT).toEqual({
      compressor: { x: 85, y: 42, w: 156, h: 232 },
      octaver: { x: 251, y: 42, w: 120, h: 232 },
      eqBoost: { x: 381, y: 42, w: 156, h: 232 },
      precisionDrive: { x: 547, y: 42, w: 120, h: 232 },
      distortion: { x: 677, y: 42, w: 156, h: 232 },
    });

    expect(NAM_AMP_FACEPLATE_LAYOUT.controlY).toBeCloseTo(745 / 10.35, 6);
    const ampCentres = [
      NAM_AMP_FACEPLATE_LAYOUT.powerX,
      NAM_AMP_FACEPLATE_LAYOUT.inputX,
      NAM_AMP_FACEPLATE_LAYOUT.boostX,
      NAM_AMP_FACEPLATE_LAYOUT.voiceX,
      NAM_AMP_FACEPLATE_LAYOUT.bassX,
      NAM_AMP_FACEPLATE_LAYOUT.midX,
      NAM_AMP_FACEPLATE_LAYOUT.trebleX,
      NAM_AMP_FACEPLATE_LAYOUT.presenceX,
      NAM_AMP_FACEPLATE_LAYOUT.mixX,
      NAM_AMP_FACEPLATE_LAYOUT.outputX,
    ];
    ampCentres.forEach((x, index) => {
      expect(x).toBeCloseTo(
        [225, 360, 520, 675, 875, 1080, 1285, 1490, 1695, 1900][index] / 21.6,
        8,
      );
    });

    NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.laneXs.forEach((x, index) => {
      expect(x).toBeCloseTo(
        [515, 656.25, 797.5, 938.75, 1080, 1221.25, 1362.5, 1503.75, 1645][index] / 21.6,
        8,
      );
    });
    expect(NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.utility.levelX).toBeCloseTo(1870 / 21.6, 8);
    expect(NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.utility.hpfX).toBeCloseTo(290 / 21.6, 8);
    expect(NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.utility.lpfX).toBeCloseTo(1870 / 21.6, 8);
    expect(NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.power.led.x).toBeCloseTo(400 / 21.6, 8);
    expect(
      NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.power.led.x
        - NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT.power.toggle.x,
    ).toBeLessThan(5.5);
  });

  it("keeps EQ Boost state introduced in V16 while migrating its bands to V19", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(19);

    const v15 = migrateLegacyNAMRackPresetDspState({
      values: {
        preEqEnabled: 1,
        preEq100Db: 6,
        preEqHPFHz: 70,
        preEqLPFHz: 11000,
      },
      dspState: {
        namEffectsDspVersion: 15,
        reverbEngineVersion: CURRENT_NAM_REVERB_ENGINE_VERSION,
      },
    }, { completePreset: true }) as {
      values: Record<string, number>;
      dspState: Record<string, number>;
    };
    expect(v15.values).toMatchObject({
      preEqEnabled: 0,
      preEq120Db: 0,
      preEq250Db: 0,
      preEq500Db: 0,
      preEq1kDb: 0,
      preEq2k5Db: 0,
      preEq5kDb: 0,
      preEq8kDb: 0,
      preEq12kDb: 0,
      preEqHPFHz: 0,
      preEqLPFHz: 24000,
    });
    expect(v15.dspState.namEffectsDspVersion).toBe(19);
    expect(v15.values).not.toHaveProperty("preEq100Db");

    const v16 = migrateLegacyNAMRackPresetDspState({
      values: {
        preEqEnabled: 1,
        preEq100Db: -2.5,
        preEq200Db: -1.5,
        preEq400Db: -0.5,
        preEq800Db: 0.5,
        preEq1k6Db: 1.5,
        preEq3k2Db: 2.5,
        preEq6k4Db: 3.5,
        preEqHPFHz: 62,
        preEqLPFHz: 12500,
      },
      dspState: {
        namEffectsDspVersion: 16,
        reverbEngineVersion: CURRENT_NAM_REVERB_ENGINE_VERSION,
      },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(v16.values).toMatchObject({
      preEqEnabled: 1,
      preEq120Db: -2.5,
      preEq250Db: -1.5,
      preEq500Db: -0.5,
      preEq1kDb: 0.5,
      preEq2k5Db: 1.5,
      preEq5kDb: 2.5,
      preEq8kDb: 3.5,
      preEq12kDb: 0,
      preEqHPFHz: 62,
      preEqLPFHz: 12500,
    });
    expect(v16.values).not.toHaveProperty("preEq6k4Db");
  });
});
