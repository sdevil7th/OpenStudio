// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  labelForNAMInstrumentProfile,
  namInstrumentLabelsAreCompatible,
  normalizeNAMInstrumentProfile,
} from "../utils/namInstrumentProfile";
import {
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

describe("NAM Rack instrument profile", () => {
  it("defaults missing and malformed values to Guitar and keeps the enum binary", () => {
    expect(normalizeNAMInstrumentProfile(undefined)).toBe(0);
    expect(normalizeNAMInstrumentProfile(Number.NaN)).toBe(0);
    expect(normalizeNAMInstrumentProfile(-5)).toBe(0);
    expect(normalizeNAMInstrumentProfile(0.49)).toBe(0);
    expect(normalizeNAMInstrumentProfile(0.5)).toBe(1);
    expect(normalizeNAMInstrumentProfile(7)).toBe(0);
    expect(labelForNAMInstrumentProfile(0)).toBe("Guitar");
    expect(labelForNAMInstrumentProfile(1)).toBe("Bass");
  });

  it("keeps untagged/shared captures discoverable and hides only explicit opposite-instrument metadata", () => {
    expect(namInstrumentLabelsAreCompatible([], 0)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Electric Guitar"], 0)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Electric Guitar"], 1)).toBe(false);
    expect(namInstrumentLabelsAreCompatible(["Bass Guitar"], 0)).toBe(false);
    expect(namInstrumentLabelsAreCompatible(["Bass Guitar"], 1)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Keys"], 1)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Guitar and Bass"], 0)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Guitar and Bass"], 1)).toBe(true);
  });

  it("migrates legacy complete presets and every latent comparison snapshot to Guitar", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {},
      dspState: { namEffectsDspVersion: 7, reverbEngineVersion: 4 },
      uiState: {
        namPresetBaseline: { values: {}, dspState: {} },
        namRackCompare: {
          snapshots: {
            A: { values: {}, dspState: {} },
            B: { values: { instrumentProfile: 1 }, dspState: { namEffectsDspVersion: 8 } },
          },
        },
      },
    }, { completePreset: true }) as any;

    expect(migrated.values.instrumentProfile).toBe(0);
    expect(migrated.uiState.namPresetBaseline.values.instrumentProfile).toBe(0);
    expect(migrated.uiState.namRackCompare.snapshots.A.values.instrumentProfile).toBe(0);
    expect(migrated.uiState.namRackCompare.snapshots.B.values.instrumentProfile).toBe(1);
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);

    const { instrumentProfile: _removed, ...incompleteValues } = migrated.values;
    expect(isCurrentNAMRackPresetState({ ...migrated, values: incompleteValues })).toBe(false);

    const malformed = migrateLegacyNAMRackPresetDspState({
      values: { instrumentProfile: 9 },
      dspState: { namEffectsDspVersion: 8, reverbEngineVersion: 4 },
    }, { completePreset: true }) as any;
    expect(malformed.values.instrumentProfile).toBe(0);

    const preV8Collision = migrateLegacyNAMRackPresetDspState({
      values: { instrumentProfile: 1 },
      dspState: { namEffectsDspVersion: 7, reverbEngineVersion: 4 },
    }, { completePreset: true }) as any;
    expect(preV8Collision.values.instrumentProfile).toBe(0);
  });

  it("plumbs the saved enum through boot/mock schemas, all Explorer surfaces, and the header card", () => {
    const bridge = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const boot = readFileSync(new URL("../components/BuiltInPluginPanel.tsx", import.meta.url), "utf8");
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");

    expect(bridge).toContain('param("instrumentProfile", "Instrument", 0, 0, 1, "", "global", "enum", false)');
    expect(boot).toContain('makeFallbackParam("instrumentProfile", "Instrument", 0, 0, 1');
    expect(panel.match(/instrumentProfile=\{instrumentProfile\}/g)).toHaveLength(3);
    expect(panel).toContain("utilityControls={{\n                  instrumentProfile,");
    expect(panel).toContain('id: "bass-clean-foundation"');
    expect(panel).toContain('id: "bass-grit-parallel"');
    expect(design).toContain('useBoundDesignParam("instrumentProfile")');
  });
});
