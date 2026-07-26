import { describe, expect, it } from "vitest";

import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { resolveNAMRackMissingAssets } from "../utils/namAssetRecovery";

function schema(overrides: Partial<BuiltInPluginSchema> = {}): BuiltInPluginSchema {
  return {
    schemaVersion: 1,
    name: "OpenStudio NAM Rack",
    category: "NAM",
    chain: "track",
    fxIndex: 0,
    parameters: [
      { id: "pedalMix", label: "Pedal", type: "continuous", value: 1, min: 0, max: 1, defaultValue: 1 },
      { id: "ampEnabled", label: "Amp", type: "toggle", value: 1, min: 0, max: 1, defaultValue: 1 },
      { id: "cabEnabled", label: "Cab", type: "toggle", value: 1, min: 0, max: 1, defaultValue: 1 },
    ],
    modelState: {},
    ...overrides,
  };
}

describe("NAM current-rack asset recovery", () => {
  it("distinguishes missing resources from intentionally empty slots", () => {
    const result = resolveNAMRackMissingAssets(schema({
      modelState: {
        pedalModelPath: "",
        ampModelPath: "D:/Session/Missing Amp.nam",
        cabIRPath: "",
        hasPedalModel: false,
        hasAmpModel: false,
        hasCabIR: false,
        cabIRState: "empty",
      },
    }));

    expect(result).toEqual([
      expect.objectContaining({ slot: "amp", path: "D:/Session/Missing Amp.nam", bypassed: false }),
    ]);
  });

  it("reports the native missing IR state and preserves bypass truth", () => {
    const base = schema({
      parameters: [
        { id: "cabEnabled", label: "Cab", type: "toggle", value: 0, min: 0, max: 1, defaultValue: 1 },
      ],
      modelState: {
        cabIRPath: "D:/Session/Missing Cab.wav",
        hasCabIR: false,
        cabIRState: "missing",
      },
    });

    expect(resolveNAMRackMissingAssets(base)).toEqual([
      expect.objectContaining({ slot: "cab", bypassParamId: "cabEnabled", bypassed: true }),
    ]);
  });

  it("does not treat a valid but bypassed resource as missing", () => {
    const result = resolveNAMRackMissingAssets(schema({
      parameters: [
        { id: "ampEnabled", label: "Amp", type: "toggle", value: 0, min: 0, max: 1, defaultValue: 1 },
      ],
      modelState: { ampModelPath: "D:/Session/Valid Amp.nam", hasAmpModel: true },
    }));

    expect(result).toEqual([]);
  });
});

