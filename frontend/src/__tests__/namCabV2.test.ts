// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync as readRawFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrateLegacyNAMRackPresetDspState } from "../utils/namRackPresetTransactions";

function readFileSync(path: URL): string {
  return readRawFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

describe("NAM Rack Cab V3", () => {
  it.each([0, 1, 2])("preserves bypassed Cab and EQ settings in Cab version %s", (version) => {
    const values = { cabEnabled: 0, cabRequestedEnabled: 0, eqEnabled: 0, eq1kDb: 6, eqLevelDb: 3,
      eqHPFHz: 120, eqLPFHz: 9000, cabHPFEnabled: 1, cabLPFEnabled: 1, cabHPFHz: 80, cabLPFHz: 8500,
      ...(version ? { cabEngineVersion: version } : {}) };
    const migrated = migrateLegacyNAMRackPresetDspState({ values,
      dspState: { namEffectsDspVersion: 19 } }, { completePreset: true }) as { values: Record<string, number> };
    expect(migrated.values).toMatchObject({ cabEnabled: 0, eqEnabled: 0, eq1kDb: 6, eqLevelDb: 3,
      eqHPFHz: 120, eqLPFHz: 9000, cabEngineVersion: 3 });
    expect(migrateLegacyNAMRackPresetDspState(migrated, { completePreset: true })).toEqual(migrated);
  });

  it("moves audible Cab cutoffs without activating a bypassed EQ curve or its cutoffs", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({ values: {
      cabEnabled: 1, eqEnabled: 0, eq1kDb: 6, eqLevelDb: 3, eqHPFHz: 120, eqLPFHz: 4000,
      cabHPFHz: 80, cabLPFHz: 8500,
    }, dspState: { namEffectsDspVersion: 19 } }, { completePreset: true }) as { values: Record<string, number> };
    expect(migrated.values).toMatchObject({ eqEnabled: 1, eq1kDb: 0, eqLevelDb: 0, eqHPFHz: 80, eqLPFHz: 8500 });
  });

  it("migrates every pre-V2 tone to literal Cab playback with its cutoffs owned by EQ", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        cabHPFHz: 87,
        cabLPFHz: 8300,
        cabMicPosition: 0.73,
        cabMicDistance: 0.42,
        cabMicBlend: 0.19,
        cabRoomSend: 0.31,
      },
      dspState: { namEffectsDspVersion: 19, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      cabEngineVersion: 3,
      cabHPFEnabled: 0,
      cabLPFEnabled: 0,
      cabHPFHz: 30,
      cabLPFHz: 16000,
      cabIRStereo: 1,
      cabDirectMix: 0,
      eqEnabled: 1,
      eqHPFHz: 87,
      eqLPFHz: 8300,
    });
    expect(migrated.values).not.toHaveProperty("cabMicPosition");
    expect(migrated.values).not.toHaveProperty("cabMicDistance");
    expect(migrated.values).not.toHaveProperty("cabMicBlend");
    expect(migrated.values).not.toHaveProperty("cabRoomSend");
  });

  it("moves explicit V2 filters into EQ and neutralizes their retired Cab state", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        cabEngineVersion: 2,
        cabHPFEnabled: 0,
        cabLPFEnabled: 1,
        cabHPFHz: -400,
        cabLPFHz: 99999,
        cabIRStereo: 0,
        cabDirectMix: 0.37,
      },
      dspState: { namEffectsDspVersion: 19, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      cabEngineVersion: 3,
      cabHPFEnabled: 0,
      cabLPFEnabled: 0,
      cabHPFHz: 30,
      cabLPFHz: 16000,
      cabIRStereo: 0,
      cabDirectMix: 0.37,
      eqEnabled: 1,
      eqHPFHz: 0,
      eqLPFHz: 20000,
    });
  });

  it("merges V2 cutoffs with an existing EQ using the narrowest audible window", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        cabEngineVersion: 2,
        cabHPFEnabled: 1,
        cabLPFEnabled: 1,
        cabHPFHz: 65,
        cabLPFHz: 11800,
        eqEnabled: 1,
        eqHPFHz: 92,
        eqLPFHz: 9600,
      },
      dspState: { namEffectsDspVersion: 19, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      cabEngineVersion: 3,
      cabHPFEnabled: 0,
      cabLPFEnabled: 0,
      eqEnabled: 1,
      eqHPFHz: 92,
      eqLPFHz: 9600,
    });
  });

  it("does not invent EQ coloration for an already-current neutral Cab V3 tone", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        cabEngineVersion: 3,
        cabHPFEnabled: 0,
        cabLPFEnabled: 0,
        cabHPFHz: 30,
        cabLPFHz: 16000,
        eqEnabled: 0,
        eqHPFHz: 0,
        eqLPFHz: 24000,
      },
      dspState: { namEffectsDspVersion: 20, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      cabEngineVersion: 3,
      cabHPFEnabled: 0,
      cabLPFEnabled: 0,
      cabHPFHz: 30,
      cabLPFHz: 16000,
      eqEnabled: 0,
      eqHPFHz: 0,
      eqLPFHz: 24000,
    });
  });

  it("boots new racks neutral and separates literal IR operations from Room ambience", () => {
    const boot = readFileSync(new URL("../components/BuiltInPluginPanel.tsx", import.meta.url));
    const bridge = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url));
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url));
    const cabStage = design.slice(
      design.indexOf("function CabStage("),
      design.indexOf("function EqBoostStage("),
    );

    expect(boot).toContain('makeFallbackParam("cabEngineVersion", "Cab Engine Version", 3, 1, 3');
    expect(boot).toContain('makeFallbackParam("cabHPFEnabled", "Retired Cab HPF Power", 0');
    expect(boot).toContain('makeFallbackParam("cabLPFEnabled", "Retired Cab LPF Power", 0');
    expect(boot).toContain('makeFallbackParam("cabHPFHz", "Retired Cab HPF", 30');
    expect(boot).toContain('makeFallbackParam("cabLPFHz", "Retired Cab LPF", 16000');
    expect(boot).toContain('makeFallbackParam("cabIRStereo", "Stereo IR", 0');
    expect(boot).toContain('makeFallbackParam("cabDirectMix", "Direct Mix", 0');
    expect(bridge).toContain('param("cabEngineVersion", "Cab Engine Version", 3, 1, 3');
    expect(bridge).toContain('param("cabHPFEnabled", "Retired Cab HPF Power", 0');
    expect(bridge).toContain('param("cabLPFEnabled", "Retired Cab LPF Power", 0');
    expect(bridge).toContain('param("cabHPFHz", "Retired Cab HPF", 30');
    expect(bridge).toContain('param("cabLPFHz", "Retired Cab LPF", 16000');
    expect(bridge).toContain('param("cabIRStereo", "Stereo IR", 0');
    expect(bridge).toContain('param("cabDirectMix", "Direct Mix", 0');

    expect(cabStage).not.toContain("TONE FILTERS IN EQ");
    expect(cabStage).toContain("body={BODIES.cab}");
    expect(cabStage).toContain("body={BODIES.cabController}");
    expect(cabStage).toContain('paramId="cabDirectMix"');
    expect(cabStage).toContain('<DesignParamContext.Provider value={designParamContext}>');
    expect(cabStage).not.toContain('paramId="cabHPFEnabled"');
    expect(cabStage).not.toContain('paramId="cabLPFEnabled"');
    expect(cabStage).not.toContain('paramId="cabHPFHz"');
    expect(cabStage).not.toContain('paramId="cabLPFHz"');
    expect(cabStage).toContain('paramId="cabIRStereo"');
    expect(cabStage).toContain('paramId="cabPhaseInvert"');
    expect(cabStage).toContain('paramId="cabRoomAmount"');
    expect(cabStage).toContain('paramId="cabRoomWidth"');
    expect(cabStage).toContain("<CabRoomPowerSwitch />");
    expect(cabStage).not.toContain("Legacy cabinet shaping");
    expect(cabStage).not.toContain("Convert to IR-only");
    expect(cabStage).not.toContain('paramId="cabMicPosition"');
    expect(cabStage).not.toContain('paramId="cabMicDistance"');
    expect(cabStage).not.toContain('paramId="cabMicBlend"');
    expect(cabStage).not.toContain('paramId="cabRoomSend"');
  });

  it("does not hide EQ-filter rewrites behind the instrument selector", () => {
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url));
    const handler = panel.slice(
      panel.indexOf("const onDesignPortParamChange"),
      panel.indexOf("const rightRailTuner"),
    );

    expect(handler).toContain("Graphic-EQ cutoffs are explicit user choices");
    expect(handler).not.toContain('paramsById.get("cabHPFEnabled")');
    expect(handler).not.toContain('paramsById.get("cabLPFEnabled")');
    expect(handler).not.toContain('paramsById.get("cabHPFHz")');
    expect(handler).not.toContain('paramsById.get("cabLPFHz")');
    expect(handler).toContain('param.id !== "cabDirectMix"');
  });

  it("keeps retired Cab filters out of live DSP and direct parameter writes", () => {
    const nativeRack = readFileSync(new URL("../../../Source/BuiltInEffects2.cpp", import.meta.url));
    const audioEngine = readFileSync(new URL("../../../Source/AudioEngine.cpp", import.meta.url));
    const cabProcessor = nativeRack.slice(
      nativeRack.indexOf("void OpenStudioNAMRack::processCabStage"),
      nativeRack.indexOf("void OpenStudioNAMRack::resetPostCabOrder"),
    );
    const cabSetter = audioEngine.slice(
      audioEngine.indexOf('if (paramId == "cabHPFEnabled"'),
      audioEngine.indexOf('if (paramId == "cabIRStereo"'),
    );

    expect(cabProcessor).not.toContain("cabHPF");
    expect(cabProcessor).not.toContain("cabLPF");
    expect(cabSetter).toContain("return false;");
  });
});
