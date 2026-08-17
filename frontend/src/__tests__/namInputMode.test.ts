// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nativeBridge,
  projectNAMRackSchemaForUI,
  resolveNAMRackOctaverPresentation,
  type BuiltInPluginSchema,
} from "../services/NativeBridge";
import { NAM_RACK_ADVANCED_CONTROL_IDS } from "../components/NAMRackMixer";

function schemaForNAMEffectsVersion(version: number | undefined): BuiltInPluginSchema {
  return {
    schemaVersion: 1,
    name: "OpenStudio NAM Rack",
    category: "Built-in",
    chain: "track",
    fxIndex: 0,
    parameters: [
      {
        id: "inputMode",
        label: "Input Mode",
        type: "enum",
        value: 2,
        min: 0,
        max: 2,
        defaultValue: 0,
        enumOptions: [
          { value: 0, label: "Mono" },
          { value: 2, label: "Stereo" },
        ],
      },
      {
        id: "auditionSource",
        label: "Demo Source",
        type: "toggle",
        value: 1,
        min: 0,
        max: 1,
        defaultValue: 0,
      },
      {
        id: "octaverEnabled",
        label: "Legacy Octaver",
        type: "toggle",
        value: 0,
        min: 0,
        max: 1,
        defaultValue: 0,
      },
    ],
    modelState: version === undefined ? {} : { namEffectsDspVersion: version },
  };
}

describe("NAM Rack automatic input routing contract", () => {
  it("removes the retired input-mode and audition parameters from every UI schema", () => {
    for (const version of [undefined, 1, 10, 11]) {
      const projected = projectNAMRackSchemaForUI(schemaForNAMEffectsVersion(version));
      expect(projected.parameters.map(({ id }) => id)).toEqual(["octaverEnabled"]);
      if (version !== undefined) {
        expect(projected.parameters[0].label).toBe("Stereo Poly Octaver");
      }
    }
  });

  it("keeps routing topology out of the dev schema and Device Controls", () => {
    const bridgeSource = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");

    expect(bridgeSource).not.toContain('param("inputMode"');
    expect(bridgeSource).not.toContain("inputMode: NAM_RACK_INPUT_MODE_OPTIONS");
    expect(bridgeSource).toContain('parameter.id !== "inputMode"');
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.input).toEqual(["inputTrimDb"]);
    expect(panelSource).not.toContain('paramById(params, "inputMode")');
    expect(panelSource).not.toContain("NAM_RACK_INPUT_MODE_OPTIONS");
    expect(panelSource).not.toContain("setPendingInputModeWrite");
    expect(panelSource).not.toContain('aria-label="NAM processing mode"');
  });

  it("rejects retired dev parameter writes and prunes legacy state at set, persistence, and readback", async () => {
    const scope = globalThis as any;
    const previousWindow = Object.getOwnPropertyDescriptor(scope, "window");
    Object.defineProperty(scope, "window", {
      configurable: true,
      writable: true,
      value: {
        location: { search: "?mockPlugin=nam" },
        setTimeout,
        clearTimeout,
      },
    });

    try {
      const address = { trackId: "retired-routing-test", chain: "track" as const, fxIndex: 991 };
      expect(await nativeBridge.setBuiltInPluginState(address, JSON.stringify({
        values: { inputMode: 2, ampMix: 0.73 },
        uiState: {
          namPresetBaseline: { values: { inputMode: 0, delayMix: 0.24 } },
          namRackCompare: {
            snapshots: {
              A: { values: { inputMode: 2, reverbMix: 0.31 } },
            },
          },
        },
        dspState: { namEffectsDspVersion: 10, reverbEngineVersion: 5 },
      }))).toBe(true);
      expect(await nativeBridge.setBuiltInPluginParam(address, "inputMode", 0)).toBe(false);

      const readback = await nativeBridge.getBuiltInPluginState(address);
      expect(JSON.stringify(readback)).not.toContain('"inputMode"');
      expect(readback.values.ampMix).toBe(0.73);
      expect(readback.uiState.namPresetBaseline.values.delayMix).toBe(0.24);
      expect(readback.uiState.namRackCompare.snapshots.A.values.reverbMix).toBe(0.31);
      expect(readback.dspState.namEffectsDspVersion).toBe(11);
    } finally {
      if (previousWindow) {
        Object.defineProperty(scope, "window", previousWindow);
      } else {
        delete scope.window;
      }
    }
  });

  it("uses native effective routing diagnostics only for behavior that depends on topology", () => {
    const bridgeSource = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");

    expect(bridgeSource).toContain("inputRoutingAutomatic?: boolean");
    expect(bridgeSource).toContain("automaticInputRoutingMode?: number");
    expect(bridgeSource).toContain("effectiveInputRoutingMode?: number");
    expect(panelSource).toContain('numberFromRecord(rackLiveDiagnostics, "effectiveInputRoutingMode")');
    expect(panelSource).toContain('numberFromRecord(rackLiveDiagnostics, "activeInputRoutingMode")');
    expect(panelSource).toContain('numberFromRecord(rackLiveDiagnostics, "automaticInputRoutingMode")');
    expect(panelSource).toContain("const stereoInputActive = effectiveInputRoutingMode >= 1.5");
    expect(panelSource).toContain("the DAW route is stereo");
  });

  it("always presents the single current stereo-poly octaver", () => {
    for (const version of [1, 2, 3, 4, 5, 6, 10, 11, undefined]) {
      expect(resolveNAMRackOctaverPresentation(version)).toMatchObject({
        label: "Stereo Poly Octaver",
        captionPrefix: "Polyphonic stereo",
        stereoPolyphonic: true,
      });
    }
  });
});
