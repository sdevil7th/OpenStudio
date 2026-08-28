// @ts-expect-error Vitest provides Node builtins while the app tsconfig omits Node typings.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNAMBootSchema } from "../components/BuiltInPluginPanel";
import { NAM_RACK_ADVANCED_CONTROL_IDS } from "../components/NAMRackMixer";
import {
  projectNAMRackSchemaForUI,
  type BuiltInPluginSchema,
} from "../services/NativeBridge";
import {
  NAM_PRECISION_DRIVE_VOICE_LABELS,
  normalizeNAMEffectsDspVersion,
  normalizeNAMPrecisionDriveVoice,
} from "../utils/namPortableState";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

type RackState = {
  values: Record<string, number>;
  dspState: Record<string, number>;
  uiState?: Record<string, any>;
};

function migrateComplete(
  version: number | undefined,
  voice: unknown,
  uiState?: Record<string, unknown>,
) {
  return migrateLegacyNAMRackPresetDspState({
    values: { precisionDriveVoice: voice, precisionDriveDrive: 0.42 },
    dspState: version === undefined ? {} : { namEffectsDspVersion: version },
    uiState,
  }, { completePreset: true }) as RackState;
}

describe("NAM Rack retired Maxon selector V18 compatibility contract", () => {
  it("loads old and current presets as Precision Drive while deleting the retired selector", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(19);
    for (const version of [1, 7, 14, 15, 16, 17, 18, 19, undefined, 0, 20, 999]) {
      const migrated = migrateComplete(version, 1);
      expect(migrated.values).not.toHaveProperty("precisionDriveVoice");
      expect(migrated.values.precisionDriveDrive).toBe(0.42);
      expect(migrated.dspState.namEffectsDspVersion).toBe(19);
      expect(isCurrentNAMRackPresetState(migrated)).toBe(true);
    }
  });

  it("retains only the surviving Precision identity", () => {
    expect(NAM_PRECISION_DRIVE_VOICE_LABELS).toEqual(["Precision"]);
    for (const value of [-1, 0, 0.5, 1, 2, "1", Number.NaN, undefined]) {
      expect(normalizeNAMPrecisionDriveVoice(value)).toBe(0);
    }
    for (const version of [14, 15, 16, 17, 18, 19]) {
      expect(normalizeNAMEffectsDspVersion(version)).toBe(19);
    }
    expect(normalizeNAMEffectsDspVersion(20)).toBeUndefined();
  });

  it("prunes the retired selector from baseline and Compare snapshots", () => {
    const snapshot = {
      values: { precisionDriveVoice: 1, precisionDriveDrive: 0.6 },
      dspState: { namEffectsDspVersion: 17, reverbEngineVersion: 5 },
    };
    const migrated = migrateComplete(17, 1, {
      namPresetBaseline: snapshot,
      namRackCompare: { snapshots: { A: snapshot, B: snapshot } },
    });

    expect(migrated.values).not.toHaveProperty("precisionDriveVoice");
    expect(migrated.uiState?.namPresetBaseline.values).not.toHaveProperty("precisionDriveVoice");
    expect(migrated.uiState?.namRackCompare.snapshots.A.values).not.toHaveProperty("precisionDriveVoice");
    expect(migrated.uiState?.namRackCompare.snapshots.B.values).not.toHaveProperty("precisionDriveVoice");
  });

  it("filters stale native schemas and omits the selector from boot schema", () => {
    const rawVoice: BuiltInPluginSchema["parameters"][number] = {
      id: "precisionDriveVoice",
      label: "Legacy voice",
      type: "enum",
      value: 1,
      min: 0,
      max: 1,
      defaultValue: 0,
      automatable: true,
      enumOptions: [{ value: 0, label: "Precision" }, { value: 1, label: "Maxon OD808" }],
    };
    const projected = projectNAMRackSchemaForUI({
      schemaVersion: 1,
      name: "OpenStudio NAM Rack",
      category: "NAM",
      chain: "track",
      fxIndex: 0,
      parameters: [rawVoice],
      modelState: { namEffectsDspVersion: 17 },
    });
    expect(projected.parameters).toEqual([]);

    const bootSchema = createNAMBootSchema(
      { chain: "track", fxIndex: 0 },
      "OpenStudio NAM Rack",
    );
    expect(bootSchema.modelState?.namEffectsDspVersion).toBe(19);
    expect(bootSchema.parameters.some((param) => param.id === "precisionDriveVoice")).toBe(false);
  });

  it("removes Maxon from active UI and keeps EQ Boost before the standalone Drive", () => {
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    const driveScene = readFileSync(new URL("../components/namScenes/pre-precision-drive.scene.json", import.meta.url), "utf8");

    expect(panel).not.toContain('paramById(params, "precisionDriveVoice")');
    expect(design).not.toContain("Maxon OD808");
    expect(driveScene).not.toContain("precisionDriveVoice");
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["pre-eq"]).toContain("preEqEnabled");
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["precision-drive"]).not.toContain("preEqEnabled");
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["precision-drive"]).not.toContain("precisionDriveVoice");
  });
});
