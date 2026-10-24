import { describe, expect, it } from "vitest";
import { NAM_OCTAVER_FUZZ_FACEPLATE_LAYOUT, NAM_PRE_SIGNAL_LAYOUT, NAM_PRE_LOGICAL_SURFACE } from "../components/NAMRackDesignPort";
import { NAM_RACK_ADVANCED_CONTROL_IDS, NAM_RACK_ADVANCED_ONLY_CONTROL_IDS, namRackAdvancedStageForCompactModule } from "../components/NAMRackMixer";
import { migrateLegacyNAMRackPresetDspState, isCurrentNAMRackPresetState } from "../utils/namRackPresetTransactions";
import { omitNAMNonPortableState } from "../utils/namPortableState";
import { NAM_FUZZ_DEFAULT_VALUES, normalizeNAMFuzzValues, resolveNAMOctaverFuzzActivity, resolveNAMFuzzCleanEntry } from "../utils/namOctaverFuzz";

describe("NAM Octaver Fuzz", () => {
  it("normalizes Clean entry text when clamping or rounding leaves the active value unchanged", () => {
    const clean = { id: "fuzzCleanMix", label: "Fuzz Clean Blend", type: "continuous", min: 0, max: 1, defaultValue: 0, value: 0 };
    expect(resolveNAMFuzzCleanEntry(clean, "-20")).toEqual({ value: 0, text: "0" });
    expect(resolveNAMFuzzCleanEntry({ ...clean, value: 1 }, "1000")).toEqual({ value: 1, text: "100" });
    expect(resolveNAMFuzzCleanEntry({ ...clean, value: 0.386 }, "38.5")).toEqual({ value: 0.386, text: "38.6" });
    expect(resolveNAMFuzzCleanEntry(clean, "38.4")).toEqual({ value: 0.384, text: "38.4" });
    for (const draft of ["", " ", "not a number", "Infinity"]) {
      expect(resolveNAMFuzzCleanEntry({ ...clean, value: 0.384 }, draft)).toEqual({ value: null, text: "38.4" });
    }
  });
  it("recognizes fuzz-only operation and gives each combination a clear stage label", () => {
    expect(resolveNAMOctaverFuzzActivity(0, 1, 1)).toEqual({ active: true, octaveActive: false, fuzzActive: true, label: "Sustain Fuzz" });
    expect(resolveNAMOctaverFuzzActivity(1, 1, 2).label).toBe("Octave + Gated Fuzz");
    expect(resolveNAMOctaverFuzzActivity(1, 0, 0).label).toBe("Octave");
    expect(resolveNAMOctaverFuzzActivity(0, 0, 0).active).toBe(false);
  });

  it("adds bypassed fuzz to old complete projects, presets, baselines and Compare snapshots without an engine bump", () => {
    const legacySnapshot = { values: { octaverEnabled: 1, octaverDownMix: 0.7 }, dspState: { namEffectsDspVersion: 20, reverbEngineVersion: 5 } };
    const migrated = migrateLegacyNAMRackPresetDspState({
      ...legacySnapshot,
      uiState: { namPresetBaseline: legacySnapshot, namRackCompare: { snapshots: { A: legacySnapshot, B: legacySnapshot } } },
    }, { completePreset: true }) as any;
    for (const snapshot of [migrated, migrated.uiState.namPresetBaseline, migrated.uiState.namRackCompare.snapshots.A, migrated.uiState.namRackCompare.snapshots.B]) {
      expect(snapshot.values).toMatchObject(NAM_FUZZ_DEFAULT_VALUES);
      expect(snapshot.values.octaverDownMix).toBe(0.7);
      expect(snapshot.dspState).toEqual({ namEffectsDspVersion: 20, reverbEngineVersion: 5 });
      expect(isCurrentNAMRackPresetState(snapshot)).toBe(true);
    }
  });

  it("round-trips active fuzz through portable state and complete-preset migration", () => {
    const values = { fuzzEnabled: 1, fuzzDrive: 0.82, fuzzTone: 0.36, fuzzLevelDb: -4.5, fuzzVoice: 2, fuzzCleanMix: 0.23 };
    const portable = JSON.parse(JSON.stringify({ values, dspState: { namEffectsDspVersion: 20, reverbEngineVersion: 5 } }, omitNAMNonPortableState));
    const migrated = migrateLegacyNAMRackPresetDspState(portable, { completePreset: true }) as any;
    expect(migrated.values).toMatchObject(values);
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);
    expect(migrateLegacyNAMRackPresetDspState(migrated, { completePreset: true })).toEqual(migrated);
  });

  it("bounds malformed imported fuzz controls and preserves partial-preset intent", () => {
    expect(normalizeNAMFuzzValues({ fuzzEnabled: 3, fuzzDrive: -2, fuzzTone: Number.NaN, fuzzLevelDb: 100, fuzzVoice: 1.7, fuzzCleanMix: 2 }))
      .toEqual({ fuzzEnabled: 1, fuzzDrive: 0, fuzzTone: 0.5, fuzzLevelDb: 12, fuzzVoice: 2, fuzzCleanMix: 1 });
    const partial = { values: { fuzzDrive: 0.3 } };
    expect(migrateLegacyNAMRackPresetDspState(partial)).toEqual(partial);
  });

  it("exposes every fuzz control on the pedal and retains all parameters in Device Controls", () => {
    expect(NAM_RACK_ADVANCED_ONLY_CONTROL_IDS.octaver).toEqual([]);
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.octaver).toEqual(expect.arrayContaining(Object.keys(NAM_FUZZ_DEFAULT_VALUES)));
    expect(namRackAdvancedStageForCompactModule("octaver")).toBeNull();
  });

  it("keeps the seven knob/hit envelopes and two independent foot clusters inside painted zones", () => {
    const box = NAM_PRE_SIGNAL_LAYOUT.octaver;
    const layout = NAM_OCTAVER_FUZZ_FACEPLATE_LAYOUT;
    const inside = (zone: { x: number; y: number; w: number; h: number }, x: number, y: number, diameter: number) => {
      expect(x - diameter / 2).toBeGreaterThanOrEqual(zone.x);
      expect(y - diameter / 2).toBeGreaterThanOrEqual(zone.y);
      expect(x + diameter / 2).toBeLessThanOrEqual(zone.x + zone.w);
      expect(y + diameter / 2).toBeLessThanOrEqual(zone.y + zone.h);
    };
    expect(box.w * layout.knobSize / 100).toBeCloseTo(28, 8);
    expect(box.w * layout.cleanKnob.size / 100).toBeCloseTo(22, 8);
    inside(layout.safeZones.header, box.w * layout.cleanKnob.x / 100,
      box.h * layout.cleanKnob.y / 100, box.w * layout.cleanKnob.hitSize / 100);
    inside(layout.safeZones.header, box.w * layout.voiceSelector.x / 100,
      box.h * layout.voiceSelector.y / 100, box.w * layout.voiceSelector.hitSize / 100);
    for (const row of [layout.topY, layout.lowerY]) for (const column of layout.columns) {
      inside(layout.safeZones.knobs, box.w * column / 100, box.h * row / 100, box.w * layout.knobHitSize / 100);
    }
    for (const column of layout.powerXs) {
      inside(layout.safeZones.footer, box.w * column / 100, box.h * layout.footY / 100, box.w * layout.footHitSize / 100);
      inside(layout.safeZones.footer, box.w * column / 100, box.h * layout.ledY / 100, 12);
    }
    expect(box.h).toBe(232);
    expect(NAM_PRE_LOGICAL_SURFACE.row.w).toBe(784);
    expect(NAM_PRE_LOGICAL_SURFACE.scaleReference).toEqual(NAM_PRE_LOGICAL_SURFACE.row);
    expect(NAM_PRE_SIGNAL_LAYOUT.compressor.x).toBe(NAM_PRE_LOGICAL_SURFACE.width - NAM_PRE_SIGNAL_LAYOUT.distortion.x - NAM_PRE_SIGNAL_LAYOUT.distortion.w);
  });
});
