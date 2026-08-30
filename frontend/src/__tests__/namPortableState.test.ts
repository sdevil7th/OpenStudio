import { describe, expect, it } from "vitest";
import {
  isRetiredNAMRackAutomationParamId,
  normalizeNAMEffectsDspVersion,
  omitNAMNonPortableState,
  pruneRetiredNAMRackInputRoutingState,
  sanitizeNAMRackDspState,
  sanitizeNAMRackPortableDspState,
} from "../utils/namPortableState";

describe("portable NAM Rack state", () => {
  it("recursively omits interface, runtime, and retired effect state", () => {
    const state = {
      calibrationReferenceDbu: -10,
      auditionSource: 1,
      inputMode: 2,
      laserEnabled: 1,
      laserMode: 4,
      laserMix: 0.5,
      laserSpeedHz: 2.5,
      laserSensitivity: 0.6,
      laserEnvelopeMode: 1,
      laserTrigger: 1,
      precisionDriveMode: 1,
      tapeEchoEnabled: 1,
      tapeEchoMix: 0.6,
      reverbCharacter: 2,
      reverbFreeze: 1,
      inputTrimDb: 2,
      chaosGate: 0.22,
      cabRoomEnabled: 0,
      cabRoomAmount: 0.73,
      cabDoublerEnabled: 1,
      cabDoublerMix: 0.24,
      uiState: {
        compare: {
          calibrationReferenceDbu: 4,
          auditionSource: 1,
          inputMode: 0,
          laserEnabled: 1,
          laserMode: 2,
          laserMix: 0.4,
          laserTrigger: 1,
          precisionDriveMode: 1,
          tapeEchoFeedback: 0.72,
          reverbWidth: 0.4,
          reverbShimmerRegen: 0.8,
          ampMix: 0.75,
        },
      },
    };

    const json = JSON.stringify(state, omitNAMNonPortableState);
    expect(json).not.toContain("calibrationReferenceDbu");
    expect(json).not.toContain("auditionSource");
    expect(json).not.toContain("inputMode");
    expect(json).not.toContain("laser");
    expect(json).not.toContain("precisionDriveMode");
    expect(json).not.toContain("tapeEcho");
    expect(json).not.toContain("reverbCharacter");
    expect(json).not.toContain("reverbFreeze");
    expect(json).not.toContain("reverbWidth");
    expect(json).not.toContain("reverbShimmerRegen");
    expect(JSON.parse(json)).toEqual({
      inputTrimDb: 2,
      chaosGate: 0.22,
      cabRoomEnabled: 0,
      cabRoomAmount: 0.73,
      cabDoublerEnabled: 1,
      cabDoublerMix: 0.24,
      uiState: { compare: { ampMix: 0.75 } },
    });
  });

  it("also strips those keys while importing a bundle", () => {
    const imported = JSON.parse(
      '{"state":{"auditionSource":1,"inputMode":2,"laserEnabled":1,"laserMode":5,"laserTrigger":1,"precisionDriveMode":1,"tapeEchoEnabled":1,"tapeEchoTimeMs":420,"calibrationReferenceDbu":-18,"outputTrimDb":-1}}',
      omitNAMNonPortableState,
    );
    expect(imported).toEqual({ state: { outputTrimDb: -1 } });
  });

  it("recursively prunes only the retired routing selector from live-compatible state", () => {
    expect(pruneRetiredNAMRackInputRoutingState({
      values: { inputMode: 2, auditionSource: 1, ampMix: 0.75 },
      uiState: {
        namPresetBaseline: { values: { inputMode: 0, delayMix: 0.2 } },
        list: [{ inputMode: 2, keep: true }],
      },
    })).toEqual({
      values: { auditionSource: 1, ampMix: 0.75 },
      uiState: {
        namPresetBaseline: { values: { delayMix: 0.2 } },
        list: [{ keep: true }],
      },
    });
  });

  it("identifies retired effect and Precision mode automation lanes without touching current parameters", () => {
    const legacyLanes = [
      { param: "builtin_track_0_laserEnabled", points: [{ time: 0, value: 0 }] },
      { param: "builtin_input_12_laserTrigger", points: [{ time: 2, value: 1 }] },
      { param: "builtin_track_0_reverbCharacter", points: [{ time: 0, value: 2 }] },
      { param: "builtin_track_0_reverbFreeze", points: [{ time: 1, value: 1 }] },
      { param: "builtin_input_12_reverbShimmerRegen", points: [{ time: 2, value: 0.8 }] },
      { param: "builtin_track_0_precisionDriveMode", points: [{ time: 3, value: 1 }] },
      { param: "builtin_track_0_compressorDetail", points: [{ time: 4, value: 0.55 }] },
      { param: "builtin_track_0_auditionSource", points: [{ time: 5, value: 1 }] },
      { param: "builtin_track_0_inputMode", points: [{ time: 6, value: 2 }] },
      { param: "builtin_track_0_tapeEchoEnabled", points: [{ time: 7, value: 1 }] },
      { param: "builtin_input_12_tapeEchoTone", points: [{ time: 8, value: 0.5 }] },
    ];

    expect(legacyLanes.every((lane) => isRetiredNAMRackAutomationParamId(lane.param))).toBe(true);
    expect(isRetiredNAMRackAutomationParamId("builtin_track_0_reverbShimmer")).toBe(false);
    expect(isRetiredNAMRackAutomationParamId("builtin_track_42_compressorAttackMs")).toBe(false);
    expect(isRetiredNAMRackAutomationParamId("builtin_track_42_compressorReleaseMs")).toBe(false);
    expect(isRetiredNAMRackAutomationParamId("laserEnabled")).toBe(false);
  });

  it("canonicalizes recognized portable NAM Rack selectors to the current DSP", () => {
    expect(normalizeNAMEffectsDspVersion(1)).toBe(19);
    expect(normalizeNAMEffectsDspVersion("3")).toBe(19);
    expect(normalizeNAMEffectsDspVersion(0)).toBeUndefined();
    expect(normalizeNAMEffectsDspVersion(4)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(5)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(6)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(7)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(8)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(9)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(10)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(11)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(12)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(13)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(14)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(15)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(16)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(17)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(18)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(19)).toBe(19);
    expect(normalizeNAMEffectsDspVersion(20)).toBeUndefined();
    expect(sanitizeNAMRackDspState({
      reverbEngineVersion: 5,
      namEffectsDspVersion: 19,
      unknownEngineVersion: 99,
    })).toEqual({
      reverbEngineVersion: 5,
      namEffectsDspVersion: 19,
    });
    expect(sanitizeNAMRackDspState({
      reverbEngineVersion: 2,
      namEffectsDspVersion: 8,
    })).toEqual({ reverbEngineVersion: 5, namEffectsDspVersion: 19 });
  });

  it("keeps legacy PRE EQ bands alive until versioned preset migration runs", () => {
    const parsed = JSON.parse(JSON.stringify({
      values: {
        preEq100Db: -3.5,
        preEq6k4Db: 2.25,
      },
      dspState: { namEffectsDspVersion: 18 },
    }), omitNAMNonPortableState) as Record<string, any>;

    expect(parsed.values).toMatchObject({
      preEq100Db: -3.5,
      preEq6k4Db: 2.25,
    });
  });

  it("does not invent DSP selectors on generic partial state patches", () => {
    const partialPatch = { values: { ampMix: 0.5 } };
    expect(sanitizeNAMRackPortableDspState(partialPatch)).toBe(partialPatch);
    expect(sanitizeNAMRackPortableDspState({
      values: { ampMix: 0.5 },
      dspState: { namEffectsDspVersion: 9 },
    })).toEqual({ values: { ampMix: 0.5 }, dspState: { namEffectsDspVersion: 19 } });
  });
});
