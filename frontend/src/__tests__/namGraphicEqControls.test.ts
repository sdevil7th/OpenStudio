// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAM_RACK_ADVANCED_CONTROL_IDS } from "../components/NAMRackMixer";
import { NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT } from "../components/NAMRackDesignPort";
import { projectNAMRackSchemaForUI, type BuiltInPluginSchema } from "../services/NativeBridge";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

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

describe("NAM Rack current graphic EQ frontend contract", () => {
  it("migrates old complete presets to a flat current output level without losing an explicit level", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(11);

    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { eq65Db: -4.5 },
      dspState: { namEffectsDspVersion: 6, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };
    expect(migrated.values.eq65Db).toBe(-4.5);
    expect(migrated.values.eqLevelDb).toBe(0);
    expect(migrated.dspState.namEffectsDspVersion).toBe(11);
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);

    const explicit = migrateLegacyNAMRackPresetDspState({
      values: { eqLevelDb: -3.25 },
      dspState: { namEffectsDspVersion: 6, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(explicit.values.eqLevelDb).toBe(-3.25);
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

    for (const id of [...bandIds, "eqLevelDb"]) {
      expect(sources.panel).toContain(id);
      expect(sources.design).toContain(id);
      expect(sources.registry).toContain(id);
      expect(sources.bridge).toContain(id);
      expect(scene.controls.some((control) => control.paramId === id)).toBe(true);
    }
    expect(scene.controls.filter((control) => control.kind === "fader")).toHaveLength(10);
    expect(scene.controls.find((control) => control.paramId === "eq65Db")?.label).toBe("65");
    expect(scene.controls.find((control) => control.paramId === "eqLevelDb"))
      .toMatchObject({ kind: "fader", label: "Level", valuePlacement: "above" });
    expect(scene.controls.some((control) => control.id === "eq-out-led")).toBe(false);
    expect(sources.design).toContain('<Fader x={x} y={layout.faderY} h={layout.faderH} paramId={lane.paramId}');
    expect(sources.design).not.toMatch(/<Knob[^>]+paramId="eqLevelDb"/);
    expect(scene.controls.some((control) => control.id === "eq-31" || control.id === "eq-62")).toBe(false);
    expect(sources.panel).toContain('eq65Db: "65 Hz"');
    expect(sources.panel).not.toContain('eq65Db: "62 Hz"');
  });

  it("centres ten equal fader lanes and their scales inside the recessed EQ bay", () => {
    const layout = NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT;
    const halfCapWidth = 3.05 * 1.7 / 2;
    const gridRight = layout.grid.x + layout.grid.w;
    const gridCenter = layout.grid.x + layout.grid.w / 2;
    const lastLaneX = layout.laneXs[layout.laneXs.length - 1];
    const laneCenter = (layout.laneXs[0] + lastLaneX) / 2;

    expect(layout.laneXs).toHaveLength(10);
    for (const x of layout.laneXs) {
      expect(x - halfCapWidth).toBeGreaterThan(layout.grid.x);
      expect(x + halfCapWidth).toBeLessThan(gridRight);
    }
    const gaps = layout.laneXs.slice(1).map((x, index) => x - layout.laneXs[index]);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 1);
    expect(gridCenter).toBeCloseTo(layout.contentCenterX, 5);
    expect(laneCenter).toBeCloseTo(layout.contentCenterX, 5);
    expect(layout.laneXs[0] - layout.grid.x)
      .toBeCloseTo(gridRight - lastLaneX, 5);
    expect((layout.scaleXs.left + layout.scaleXs.right) / 2)
      .toBeCloseTo(layout.contentCenterX, 5);
    expect(layout.title.x).toBe(layout.contentCenterX);
    expect(layout.levelSeparatorX).toBeGreaterThan(layout.laneXs[8]);
    expect(layout.levelSeparatorX).toBeLessThan(layout.laneXs[9]);
    expect(layout.faderY - layout.faderH / 2).toBeGreaterThan(layout.grid.y);
    expect(layout.faderY + layout.faderH / 2).toBeLessThan(layout.grid.y + layout.grid.h);

    const scene = JSON.parse(readFileSync(
      new URL("../components/namScenes/eq-rack.scene.json", import.meta.url),
      "utf8",
    )) as { artboard: { width: number }; controls: Array<{ kind: string; x: number; width: number }> };
    const sceneFaders = scene.controls.filter((control) => control.kind === "fader");
    const sceneGaps = sceneFaders.slice(1).map((control, index) => control.x - sceneFaders[index].x);
    expect(sceneFaders).toHaveLength(10);
    for (const control of sceneFaders) {
      expect(control.x - control.width / 2).toBeGreaterThan(0);
      expect(control.x + control.width / 2).toBeLessThan(scene.artboard.width);
    }
    for (const gap of sceneGaps) expect(Math.abs(gap - sceneGaps[0])).toBeLessThanOrEqual(1);
    expect((sceneFaders[0].x + sceneFaders[sceneFaders.length - 1].x) / 2)
      .toBe(scene.artboard.width / 2);
  });

  it("keeps the frontend-only fallback EQ flat and unity-gain", () => {
    const bridge = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    for (const id of [...bandIds, "eqLevelDb"]) {
      expect(bridge).toMatch(new RegExp(`param\\("${id}",\\s*"[^"]+",\\s*0,\\s*-12,\\s*12`));
    }
  });
});
