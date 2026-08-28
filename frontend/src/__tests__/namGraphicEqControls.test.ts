// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAM_RACK_ADVANCED_CONTROL_IDS } from "../components/NAMRackMixer";
import {
  NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT,
  NAM_GRAPHIC_EQ_FILTER_KNOB_PX,
} from "../components/NAMRackDesignPort";
import {
  nativeBridge,
  projectNAMRackSchemaForUI,
  type BuiltInPluginSchema,
} from "../services/NativeBridge";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
  namRackSnapshotValuesDiffer,
} from "../utils/namRackPresetTransactions";
import {
  denormalizeParamValue,
  formatParamValue,
  namGraphicEqActiveRecallUpdate,
  NAM_GRAPHIC_EQ_FILTER_OFF_DETENT,
  normalizeParamValue,
  offsetParamValue,
  quantizeParamValue,
} from "../utils/builtInParamValue";

const bandIds = [
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
const filterIds = ["eqHPFHz", "eqLPFHz"] as const;

const filterParam = (
  id: typeof filterIds[number],
  value: number,
): BuiltInPluginSchema["parameters"][number] => ({
  id,
  label: id === "eqHPFHz" ? "HPF" : "LPF",
  type: "continuous",
  value,
  min: id === "eqHPFHz" ? 0 : 3000,
  max: id === "eqHPFHz" ? 500 : 24000,
  defaultValue: id === "eqHPFHz" ? 0 : 24000,
  unit: "Hz",
});

describe("NAM Rack current graphic EQ frontend contract", () => {
  it("migrates old complete presets to a flat current output level without losing an explicit level", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(19);

    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { eq65Db: -4.5 },
      dspState: { namEffectsDspVersion: 6, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };
    expect(migrated.values.eq65Db).toBe(-4.5);
    expect(migrated.values.eqLevelDb).toBe(0);
    expect(migrated.values.eqHPFHz).toBe(0);
    expect(migrated.values.eqLPFHz).toBe(24000);
    expect(migrated.dspState.namEffectsDspVersion).toBe(19);
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);

    const explicit = migrateLegacyNAMRackPresetDspState({
      values: { eqLevelDb: -3.25 },
      dspState: { namEffectsDspVersion: 6, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(explicit.values.eqLevelDb).toBe(-3.25);

    const current = migrateLegacyNAMRackPresetDspState({
      values: { eqHPFHz: 82, eqLPFHz: 12750 },
      dspState: { namEffectsDspVersion: 14, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(current.values).toMatchObject({ eqHPFHz: 82, eqLPFHz: 12750 });

    const developmentV13 = migrateLegacyNAMRackPresetDspState({
      values: { eqHPFHz: 82, eqLPFHz: 12750 },
      dspState: { namEffectsDspVersion: 13, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(developmentV13.values).toMatchObject({ eqHPFHz: 0, eqLPFHz: 24000 });
  });

  it("keeps the native +/-12 dB level contract intact through UI projection", () => {
    const level: BuiltInPluginSchema["parameters"][number] = {
      id: "eqLevelDb",
      label: "Level",
      type: "continuous",
      value: 0,
      min: -12,
      max: 12,
      defaultValue: 0,
      unit: "dB",
    };
    const projected = projectNAMRackSchemaForUI({
      schemaVersion: 1,
      name: "OpenStudio NAM Rack",
      category: "NAM",
      chain: "track",
      fxIndex: 0,
      parameters: [level],
      modelState: { namEffectsDspVersion: 8 },
    });

    expect(projected.parameters).toEqual([level]);
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.eq).toContain("eqLevelDb");
  });

  it("binds nine truthful bands plus output Level on every current rack surface", () => {
    const sources = {
      panel: readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8"),
      mixer: readFileSync(new URL("../components/NAMRackMixer.tsx", import.meta.url), "utf8"),
      design: readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8"),
      registry: readFileSync(new URL("../components/NAMRackNeuralSkinRegistry.ts", import.meta.url), "utf8"),
      bridge: readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8"),
    };
    const scene = JSON.parse(readFileSync(
      new URL("../components/namScenes/eq-rack.scene.json", import.meta.url),
      "utf8",
    )) as { controls: Array<{ id: string; paramId?: string; kind: string; label?: string; valuePlacement?: string }> };

    for (const id of [...filterIds, ...bandIds, "eqLevelDb"]) {
      expect(sources.panel).toContain(id);
      expect(sources.design).toContain(id);
      expect(sources.registry).toContain(id);
      expect(sources.bridge).toContain(id);
      expect(scene.controls.some((control) => control.paramId === id)).toBe(true);
    }
    // The compatibility manifest mirrors the approved V4 production deck:
    // nine upper-tier bands and three lower-tier rotary utilities.
    expect(scene.controls.filter((control) => control.kind === "fader")).toHaveLength(9);
    expect(scene.controls.filter((control) => control.kind === "knob")).toHaveLength(3);
    expect(scene.controls.filter((control) => control.kind === "display" && filterIds.includes(control.paramId as typeof filterIds[number]))).toHaveLength(0);
    expect(scene.controls.find((control) => control.paramId === "eq65Db")?.label).toBe("65");
    expect(scene.controls.find((control) => control.paramId === "eqLevelDb"))
      .toMatchObject({ kind: "knob", label: "LEVEL", valuePlacement: "hidden" });
    expect(scene.controls.find((control) => control.paramId === "eqHPFHz"))
      .toMatchObject({ kind: "knob", valuePlacement: "hidden" });
    expect(scene.controls.find((control) => control.paramId === "eqLPFHz"))
      .toMatchObject({ kind: "knob", valuePlacement: "hidden" });
    expect(scene.controls.some((control) => control.id === "eq-out-led")).toBe(false);
    expect(sources.design).toContain("<Fader");
    expect(sources.design).toContain("paramId={lane.paramId}");
    expect(sources.design).toContain('paramId="eqLevelDb"');
    expect(sources.design).toContain('semanticLabel="Output level"');
    expect(scene.controls.some((control) => control.id === "eq-31" || control.id === "eq-62")).toBe(false);
    expect(sources.design).toContain('{ label: "65", paramId: "eq65Db"');
    expect(sources.design).toContain('semanticLabel="High-pass filter"');
    expect(sources.design).toContain('semanticLabel="Low-pass filter"');
    expect(sources.design).not.toContain('{ label: "62", paramId: "eq65Db"');
  });

  it("implements the approved V4 source-pixel geometry with nine disjoint fader lanes", () => {
    const layout = NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT;
    const moduleWidth = 720;
    const moduleHeight = 240;
    const paintedLeft = 24;
    const paintedRight = 696;
    const lastLaneX = layout.laneXs[layout.laneXs.length - 1];
    const laneCenter = (layout.laneXs[0] + lastLaneX) / 2;

    expect(layout.laneXs).toHaveLength(9);
    expect(laneCenter).toBe(50);
    for (const x of layout.laneXs) {
      const centerPx = x * moduleWidth / 100;
      expect(centerPx - layout.fader.hitWidthPx / 2).toBeGreaterThan(paintedLeft);
      expect(centerPx + layout.fader.hitWidthPx / 2).toBeLessThan(paintedRight);
    }
    const gaps = layout.laneXs.slice(1).map((x, index) => x - layout.laneXs[index]);
    for (const gap of gaps) expect(gap).toBeCloseTo(6.53935185, 7);
    expect(gaps[0] * moduleWidth / 100 - layout.fader.hitWidthPx).toBeCloseTo(9.75, 7);

    const faderTop =
      layout.fader.y * moduleHeight / 100 -
      layout.fader.hitHeightPx / 2 +
      layout.fader.trackTopPx;
    expect(faderTop).toBeCloseTo(144 / 3, 7);
    expect(faderTop + layout.fader.trackHeightPx).toBeCloseTo(404 / 3, 7);
    expect(layout.fader.hitWidthPx).toBeCloseTo(112 / 3, 7);
    expect(layout.fader.hitHeightPx).toBeCloseTo(328 / 3, 7);
    expect(layout.fader.trackWidthPx).toBe(10);
    expect(layout.fader.capSizePx).toBe(18);

    expect(layout.utility.hpfSize * moduleWidth / 100)
      .toBeCloseTo(NAM_GRAPHIC_EQ_FILTER_KNOB_PX, 8);
    expect(layout.utility.hpfHitSize * moduleWidth / 100).toBeCloseTo(60, 8);
    expect(layout.utility.hpfY * moduleHeight / 100).toBeCloseTo(274 / 3, 8);
    expect(layout.utility.levelY * moduleHeight / 100).toBeCloseTo(525 / 3, 8);
    [layout.utility.hpfX, layout.utility.levelX, layout.utility.lpfX]
      .forEach((x, index) => {
        expect(x).toBeCloseTo([290 / 21.6, 1870 / 21.6, 1870 / 21.6][index], 8);
      });
    expect(layout.power.toggle.x * moduleWidth / 100).toBeCloseTo(290 / 3, 7);
    expect(layout.power.led.x * moduleWidth / 100).toBeCloseTo(400 / 3, 7);
    expect(layout.power.toggle.y * moduleHeight / 100).toBeCloseTo(525 / 3, 7);
    expect(layout.power.led.y * moduleHeight / 100).toBeCloseTo(525 / 3, 7);
  });

  it("renders three full-size lower-tier rotaries and physical fader hit envelopes", () => {
    const design = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );
    const eqStage = design.slice(
      design.indexOf("function EqStage()"),
      design.indexOf("function PostFxStage()"),
    );
    const eqFilterKnobs = eqStage.match(/<EqFilterKnob\b/g) ?? [];

    expect(NAM_GRAPHIC_EQ_FILTER_KNOB_PX).toBe(50);
    expect(eqFilterKnobs).toHaveLength(3);
    expect(eqStage).toContain('paramId="eqHPFHz"');
    expect(eqStage).toContain('paramId="eqLevelDb"');
    expect(eqStage).toContain('paramId="eqLPFHz"');
    expect(eqStage).toContain('semanticLabel="High-pass filter"');
    expect(eqStage).toContain('semanticLabel="Output level"');
    expect(eqStage).toContain('semanticLabel="Low-pass filter"');
    expect(eqStage).toContain("physicalGeometry={layout.fader}");
    expect(eqStage).toContain("showValueTooltip");
    expect(eqStage).toContain("assetId={CONTROLS.knobBlueSteelPanel}");
    expect(eqStage).toContain("capAssetId={CONTROLS.sliderPanel}");
  });

  it("keeps the frontend-only fallback EQ flat and unity-gain", () => {
    const bridge = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    for (const id of [...bandIds, "eqLevelDb"]) {
      expect(bridge).toMatch(new RegExp(`param\\("${id}",\\s*"[^"]+",\\s*0,\\s*-12,\\s*12`));
    }
    expect(bridge).toContain('param("eqHPFHz", "HPF", 0, 0, 500, "Hz", "graphicEq")');
    expect(bridge).toContain('param("eqLPFHz", "LPF", 24000, 3000, 24000, "Hz", "graphicEq")');
  });

  it("makes factory OFF recall deterministic without exposing private cutoff memory as controls", () => {
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const bridge = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const factoryDefaults = panel.slice(
      panel.indexOf("const NAM_RACK_FACTORY_HIDDEN_EQ_DEFAULT_VALUES"),
      panel.indexOf("const NAM_RACK_GLOBAL_DEFAULT_VALUES"),
    );
    const factoryPayload = panel.slice(
      panel.indexOf("function presetValuesWithRackDefaults"),
      panel.indexOf("function factoryPresetMatchesInstrumentProfile"),
    );
    const resetPayload = panel.slice(
      panel.indexOf("const resetSlotModule"),
      panel.indexOf("const removeSlotModule"),
    );
    const duplicatePayload = panel.slice(
      panel.indexOf("const duplicateSlotSettings"),
      panel.indexOf("const applySlotCopy"),
    );
    const removePayload = panel.slice(
      panel.indexOf("const removeSlotModule"),
      panel.indexOf("const recoverUnverifiedPresetMutation"),
    );

    expect(factoryDefaults).toContain("eqHPFLastActiveHz: 80");
    expect(factoryDefaults).toContain("eqLPFLastActiveHz: 12000");
    expect(factoryPayload).toContain("...NAM_RACK_FACTORY_HIDDEN_EQ_DEFAULT_VALUES");
    expect(resetPayload).toContain('moduleId === "pedal" || moduleId === "eq"');
    expect(resetPayload).toContain("Object.entries(NAM_RACK_FACTORY_HIDDEN_EQ_DEFAULT_VALUES)");
    expect(resetPayload).toContain('moduleId === "pedal"');
    expect(resetPayload).toContain('id.startsWith("preEq")');
    expect(resetPayload).toContain("if (belongsToModule) values[id] = value");
    expect(duplicatePayload).toMatch(/moduleId === "eq"[\s\S]+\["eqHPFLastActiveHz", diagnosticEqHPFLastActiveHz\]/);
    expect(duplicatePayload).toContain('["eqLPFLastActiveHz", diagnosticEqLPFLastActiveHz]');
    expect(duplicatePayload).toContain("if (value !== undefined) values[id] = value");
    expect(removePayload).toContain("Object.assign(values, NAM_RACK_GRAPHIC_EQ_NEUTRAL_VALUES)");
    expect(removePayload).not.toContain("Object.assign(values, NAM_RACK_FACTORY_HIDDEN_EQ_DEFAULT_VALUES)");
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.eq).not.toContain("eqHPFLastActiveHz");
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.eq).not.toContain("eqLPFLastActiveHz");
    expect(bridge).not.toContain('param("eqHPFLastActiveHz"');
    expect(bridge).not.toContain('param("eqLPFLastActiveHz"');

    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        eqHPFHz: 0,
        eqLPFHz: 24000,
        eqHPFLastActiveHz: 96,
        eqLPFLastActiveHz: 13600,
        futurePrivateEqState: 7,
      },
      dspState: { namEffectsDspVersion: 14, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(migrated.values).toMatchObject({
      eqHPFLastActiveHz: 96,
      eqLPFLastActiveHz: 13600,
      futurePrivateEqState: 7,
    });
  });

  it("keeps private cutoff memory truthful in the NAM development mock", async () => {
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
      const address = { trackId: "eq-hidden-memory-test", chain: "track" as const, fxIndex: 992 };
      const schema = await nativeBridge.getBuiltInPluginSchema(address);
      expect(schema.parameters.map(({ id }) => id)).not.toContain("eqHPFLastActiveHz");
      expect(schema.parameters.map(({ id }) => id)).not.toContain("eqLPFLastActiveHz");

      const initial = await nativeBridge.getBuiltInPluginState(address);
      expect(initial.values).toMatchObject({
        eqHPFLastActiveHz: 80,
        eqLPFLastActiveHz: 12000,
      });
      expect(await nativeBridge.getNAMRackDiagnostics(address)).toMatchObject({
        eqHPFLastActiveHz: 80,
        eqLPFLastActiveHz: 12000,
      });

      expect(await nativeBridge.setBuiltInPluginParam(address, "eqHPFHz", 96)).toBe(true);
      expect(await nativeBridge.setBuiltInPluginParam(address, "eqLPFHz", 13600)).toBe(true);
      expect(await nativeBridge.setBuiltInPluginParam(address, "eqHPFHz", 0)).toBe(true);
      expect(await nativeBridge.setBuiltInPluginParam(address, "eqLPFHz", 24000)).toBe(true);
      const recalled = await nativeBridge.getBuiltInPluginState(address);
      expect(recalled.values).toMatchObject({
        eqHPFHz: 0,
        eqLPFHz: 24000,
        eqHPFLastActiveHz: 96,
        eqLPFLastActiveHz: 13600,
      });
      expect(await nativeBridge.getNAMRackDiagnostics(address)).toMatchObject({
        eqHPFLastActiveHz: 96,
        eqLPFLastActiveHz: 13600,
      });
    } finally {
      if (previousWindow) Object.defineProperty(scope, "window", previousWindow);
      else delete scope.window;
    }
  });

  it("keeps saved and recalled OFF snapshots clean without hiding observable cutoff edits", () => {
    const publicOffSnapshot = {
      eqEnabled: 1,
      eqHPFHz: 0,
      eqLPFHz: 24000,
      eq65Db: 0,
    };
    const authoritativeSavedSnapshot = {
      ...publicOffSnapshot,
      eqHPFLastActiveHz: 80,
      eqLPFLastActiveHz: 12000,
    };

    // Immediate save/recall compares a public schema snapshot with an
    // authoritative baseline. Unobservable private memory cannot make it dirty.
    expect(namRackSnapshotValuesDiffer(
      publicOffSnapshot,
      authoritativeSavedSnapshot,
    )).toBe(false);

    // The two visible cutoff values remain ordinary dirty-state controls.
    expect(namRackSnapshotValuesDiffer(
      { ...publicOffSnapshot, eqHPFHz: 80 },
      authoritativeSavedSnapshot,
    )).toBe(true);
    expect(namRackSnapshotValuesDiffer(
      { ...publicOffSnapshot, eqLPFHz: 12000 },
      authoritativeSavedSnapshot,
    )).toBe(true);

    // Explicit active 80 -> 96 -> OFF regression: the public HPF is back at
    // zero, but the next-on cutoff changed and must leave the preset dirty.
    const afterActive80To96ThenOff = {
      ...authoritativeSavedSnapshot,
      eqHPFHz: 0,
      eqHPFLastActiveHz: 96,
    };
    expect(namRackSnapshotValuesDiffer(
      afterActive80To96ThenOff,
      authoritativeSavedSnapshot,
    )).toBe(true);
    // The LPF private memory follows the same authoritative comparison rule.
    expect(namRackSnapshotValuesDiffer(
      { ...authoritativeSavedSnapshot, eqLPFLastActiveHz: 13600 },
      authoritativeSavedSnapshot,
    )).toBe(true);

    // Missing ordinary values retain the existing union-and-zero behavior.
    expect(namRackSnapshotValuesDiffer(
      publicOffSnapshot,
      { ...authoritativeSavedSnapshot, eq125Db: 2 },
    )).toBe(true);

    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const currentSnapshotSource = panel.slice(
      panel.indexOf("const diagnosticEqHPFLastActiveHz"),
      panel.indexOf("const activeUserPresetBaseline"),
    );
    const factoryDirtySource = panel.slice(
      panel.indexOf("function presetDirty"),
      panel.indexOf("const currentCompareDirty"),
    );
    const optimisticRecallSource = panel.slice(
      panel.indexOf("const onDesignPortParamChange"),
      panel.indexOf("const rightRailTuner"),
    );
    expect(currentSnapshotSource).toMatch(/numberFromRecord\(\s*rackDiagnostics,\s*"eqHPFLastActiveHz"/);
    expect(currentSnapshotSource).toMatch(/numberFromRecord\(\s*rackDiagnostics,\s*"eqLPFLastActiveHz"/);
    expect(currentSnapshotSource).toContain("values[id] = value");
    expect(factoryDirtySource).toContain("presetDirty(preset, params, currentSnapshot.values)");
    expect(factoryDirtySource).toContain("NAM_RACK_PRIVATE_EQ_RECALL_VALUE_KEYS.has(id)");

    const factoryOffSnapshot = {
      ...publicOffSnapshot,
      eqHPFLastActiveHz: 80,
      eqLPFLastActiveHz: 12000,
    };
    // A just-recalled factory OFF state is clean, but active 80 -> 96 -> OFF
    // remains edited because its next-on cutoff no longer matches the factory.
    expect(namRackSnapshotValuesDiffer(factoryOffSnapshot, factoryOffSnapshot)).toBe(false);
    expect(namRackSnapshotValuesDiffer(
      { ...factoryOffSnapshot, eqHPFHz: 0, eqHPFLastActiveHz: 96 },
      factoryOffSnapshot,
    )).toBe(true);

    expect(namGraphicEqActiveRecallUpdate("eqHPFHz", 96)).toEqual(["eqHPFLastActiveHz", 96]);
    expect(namGraphicEqActiveRecallUpdate("eqHPFHz", 0)).toBeNull();
    expect(namGraphicEqActiveRecallUpdate("eqHPFHz", 19)).toBeNull();
    expect(namGraphicEqActiveRecallUpdate("eqHPFHz", 501)).toBeNull();
    expect(namGraphicEqActiveRecallUpdate("eqLPFHz", 13600)).toEqual(["eqLPFLastActiveHz", 13600]);
    expect(namGraphicEqActiveRecallUpdate("eqLPFHz", 24000)).toBeNull();
    expect(namGraphicEqActiveRecallUpdate("eqLPFHz", 20001)).toBeNull();
    expect(namGraphicEqActiveRecallUpdate("eqLPFHz", Number.NaN)).toBeNull();
    expect(optimisticRecallSource).toContain("namGraphicEqActiveRecallUpdate(param.id, value)");
    expect(optimisticRecallSource).toContain("setRackLiveDiagnostics((current)");
    expect(optimisticRecallSource).toContain("the next native poll remains authoritative");
  });

  it("uses logarithmic active travel with mirrored OFF endpoint detents", () => {
    const hpf = filterParam("eqHPFHz", 0);
    const lpf = filterParam("eqLPFHz", 24000);

    expect(formatParamValue(hpf)).toBe("OFF");
    expect(formatParamValue(lpf)).toBe("OFF");
    expect(normalizeParamValue(hpf, 0)).toBe(0);
    expect(normalizeParamValue(hpf, 20)).toBeCloseTo(NAM_GRAPHIC_EQ_FILTER_OFF_DETENT, 8);
    expect(normalizeParamValue(hpf, 500)).toBe(1);
    expect(normalizeParamValue(lpf, 3000)).toBe(0);
    expect(normalizeParamValue(lpf, 20000)).toBeCloseTo(1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT, 8);
    expect(normalizeParamValue(lpf, 24000)).toBe(1);

    expect(denormalizeParamValue(hpf, NAM_GRAPHIC_EQ_FILTER_OFF_DETENT / 2)).toBe(0);
    expect(denormalizeParamValue(lpf, 1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT / 2)).toBe(24000);
    expect(denormalizeParamValue(hpf, (1 + NAM_GRAPHIC_EQ_FILTER_OFF_DETENT) / 2)).toBeCloseTo(100, 4);
    expect(denormalizeParamValue(lpf, (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT) / 2)).toBeCloseTo(Math.sqrt(3000 * 20000), 4);

    expect(quantizeParamValue(hpf, offsetParamValue(hpf, 0, 1))).toBe(20);
    expect(quantizeParamValue(lpf, offsetParamValue(lpf, 24000, -1))).toBe(20000);
    expect(formatParamValue({ ...hpf, value: 80 })).toBe("80 Hz");
    expect(formatParamValue({ ...lpf, value: 12000 })).toBe("12.0 kHz");
  });
});
