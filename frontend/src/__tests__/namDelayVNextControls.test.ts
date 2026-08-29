// @ts-expect-error Vitest provides Node builtins while the app tsconfig omits Node typings.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNAMBootSchema } from "../components/BuiltInPluginPanel";
import { delayModeDisplayLabel, delaySyncDisplay } from "../components/NAMRackDesignPort";
import {
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

const delaySchemaContract = [
  { id: "delayMix", label: "Delay", type: "continuous", value: 0.22, min: 0, max: 1, defaultValue: 0.22, enumOptions: undefined },
  { id: "delayTimeMs", label: "Delay Time", type: "continuous", value: 360, min: 1, max: 2000, defaultValue: 360, enumOptions: undefined },
  { id: "delayFeedback", label: "Delay Fdbk", type: "continuous", value: 0.22, min: 0, max: 0.85, defaultValue: 0.22, enumOptions: undefined },
  { id: "delayMod", label: "Delay Mod", type: "continuous", value: 0.18, min: 0, max: 1, defaultValue: 0.18, enumOptions: undefined },
  { id: "delayDucker", label: "Ducker", type: "continuous", value: 0.12, min: 0, max: 1, defaultValue: 0.12, enumOptions: undefined },
  {
    id: "delayMode",
    label: "Delay Mode",
    type: "enum",
    value: 1,
    min: 0,
    max: 4,
    defaultValue: 1,
    enumOptions: [
      { value: 0, label: "Digital" },
      { value: 1, label: "Tape" },
      { value: 2, label: "Analog" },
      { value: 3, label: "Multi" },
      { value: 4, label: "Dual" },
    ],
  },
  { id: "delayPingPong", label: "Ping Pong", type: "toggle", value: 1, min: 0, max: 1, defaultValue: 1, enumOptions: undefined },
  { id: "delayTempoSync", label: "Delay Sync", type: "toggle", value: 0, min: 0, max: 1, defaultValue: 0, enumOptions: undefined },
  { id: "delayEnabled", label: "Delay Engage", type: "toggle", value: 0, min: 0, max: 1, defaultValue: 0, enumOptions: undefined },
] as const;

describe("NAM Rack Delay V10 contract", () => {
  it("resolves the sync screen through three monotonic steps without an endpoint overflow", () => {
    const boundaries = [0, 0.499999, 0.5, 0.999999, 1];
    expect(boundaries.map((value) => delaySyncDisplay(value, false))).toEqual([
      "1/4", "1/4", "1/8", "1/8", "1/16",
    ]);
    expect(boundaries.map((value) => delaySyncDisplay(value, true))).toEqual([
      "1/4 / 1/8", "1/4 / 1/8", "1/8 / 1/16", "1/8 / 1/16", "1/16",
    ]);

    const noteDuration = { "1/4": 1, "1/8": 0.5, "1/16": 0.25 } as const;
    const leftDurations = boundaries.map((value) => {
      const leftLabel = delaySyncDisplay(value, true).split(" / ")[0] as keyof typeof noteDuration;
      return noteDuration[leftLabel];
    });
    expect(leftDurations.every((duration, index) => index === 0 || duration <= leftDurations[index - 1])).toBe(true);
  });

  it("boots with all nine delay parameters matching the native public schema", () => {
    const schema = createNAMBootSchema({ chain: "track", trackId: "delay-test", fxIndex: 0 }, "OpenStudio NAM Rack");
    const descriptors = delaySchemaContract.map(({ id }) => schema.parameters.find((param) => param.id === id));
    expect(descriptors.every(Boolean)).toBe(true);
    expect(descriptors.map((descriptor) => descriptor && ({
      id: descriptor.id,
      label: descriptor.label,
      type: descriptor.type,
      value: descriptor.value,
      min: descriptor.min,
      max: descriptor.max,
      defaultValue: descriptor.defaultValue,
      enumOptions: descriptor.enumOptions,
    }))).toEqual(delaySchemaContract);
  });

  it("shows the exact five delay voices on the existing pedal screen and tooltip", () => {
    expect([0, 1, 2, 3, 4].map(delayModeDisplayLabel)).toEqual([
      "Digital", "Tape", "Analog", "Multi", "Dual",
    ]);
    expect(delayModeDisplayLabel(Number.NaN)).toBe("Tape");
    const source = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    expect(source).toContain("<BoundDelayModeDisplay />");
    expect(source).toContain('semanticLabel="Delay Voice"');
  });

  it("keeps the panel starting points complete and aligned with native defaults", () => {
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const defaultsStart = panelSource.indexOf("const NAM_RACK_GLOBAL_DEFAULT_VALUES");
    const defaultsEnd = panelSource.indexOf("type RackCompareSnapshot", defaultsStart);
    const defaults = panelSource.slice(defaultsStart, defaultsEnd);
    for (const line of [
      "delayMix: 0.22",
      "delayTimeMs: 360",
      "delayFeedback: 0.22",
      "delayMod: 0.18",
      "delayDucker: 0.12",
      "delayMode: 1",
      "delayPingPong: 1",
      "delayTempoSync: 0",
      "delayEnabled: 0",
    ]) expect(defaults).toContain(line);
  });

  it("migrates all nine V9 fields numerically while retaining its 0..2 mode range", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        delayMix: -2,
        delayTimeMs: 9000,
        delayFeedback: 2,
        delayMod: Number.NaN,
        delayDucker: -1,
        delayMode: 1.6,
        delayPingPong: 0.49,
        delayTempoSync: 0.5,
        delayEnabled: 3,
      },
      dspState: { namEffectsDspVersion: 9, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      delayMix: 0,
      delayTimeMs: 2000,
      delayFeedback: 0.85,
      delayMod: 0.18,
      delayDucker: 0,
      delayMode: 2,
      delayPingPong: 0,
      delayTempoSync: 1,
      delayEnabled: 1,
    });
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);
    expect(isCurrentNAMRackPresetState({
      ...migrated,
      values: { ...migrated.values, delayFeedback: 0.851 },
    })).toBe(false);
  });

  it("preserves V9 modes numerically and reserves Multi/Dual for recognized V10 state", () => {
    for (const mode of [0, 1, 2]) {
      const migrated = migrateLegacyNAMRackPresetDspState({
        values: { delayMode: mode },
        dspState: { namEffectsDspVersion: 9, reverbEngineVersion: 5 },
      }, { completePreset: true }) as { values: Record<string, number> };
      expect(migrated.values.delayMode).toBe(mode);
    }
    const legacyOutOfRange = migrateLegacyNAMRackPresetDspState({
      values: { delayMode: 4 },
      dspState: { namEffectsDspVersion: 9, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(legacyOutOfRange.values.delayMode).toBe(2);

    for (const mode of [3, 4]) {
      const current = migrateLegacyNAMRackPresetDspState({
        values: { delayMode: mode },
        dspState: { namEffectsDspVersion: 10, reverbEngineVersion: 5 },
      }, { completePreset: true }) as { values: Record<string, number> };
      expect(current.values.delayMode).toBe(mode);
      expect(isCurrentNAMRackPresetState(current)).toBe(true);
    }
  });

  it("applies the same sanitization to the baseline and both A/B snapshots", () => {
    const dirtyDelayValues = {
      delayMix: 4,
      delayTimeMs: -20,
      delayFeedback: -4,
      delayMod: 7,
      delayDucker: 6,
      delayMode: -2,
      delayPingPong: 0.9,
      delayTempoSync: 0.1,
      delayEnabled: 0.51,
    };
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {},
      dspState: { namEffectsDspVersion: 10, reverbEngineVersion: 5 },
      uiState: {
        namPresetBaseline: { values: dirtyDelayValues },
        namRackCompare: {
          snapshots: {
            A: { values: dirtyDelayValues },
            B: { values: { ...dirtyDelayValues, delayMode: 99 } },
          },
        },
      },
    }, { completePreset: true }) as Record<string, any>;

    const baseline = migrated.uiState.namPresetBaseline.values;
    const a = migrated.uiState.namRackCompare.snapshots.A.values;
    const b = migrated.uiState.namRackCompare.snapshots.B.values;
    const expected = {
      delayMix: 1,
      delayTimeMs: 1,
      delayFeedback: 0,
      delayMod: 1,
      delayDucker: 1,
      delayMode: 0,
      delayPingPong: 1,
      delayTempoSync: 0,
      delayEnabled: 1,
    };
    expect(baseline).toMatchObject(expected);
    expect(a).toMatchObject(expected);
    expect(b).toMatchObject({ ...expected, delayMode: 4 });
  });
});
