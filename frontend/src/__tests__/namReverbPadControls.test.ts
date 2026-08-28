// @ts-expect-error Vitest provides Node builtins while the app tsconfig omits Node typings.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNAMBootSchema } from "../components/BuiltInPluginPanel";
import { NAM_POST_FX_FACEPLATE_LAYOUT } from "../components/NAMRackDesignPort";
import { NAM_RACK_REVERB_ADVANCED_CONTROL_GROUPS } from "../components/NAMRackMixer";
import { deviceSkinForModule } from "../components/NAMRackNeuralSkinRegistry";
import {
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

describe("NAM Rack dedicated Reverb PAD frontend", () => {
  it("publishes one automatable toggle with a deterministic off default", () => {
    const schema = createNAMBootSchema(
      { chain: "track", trackId: "pad-test", fxIndex: 0 },
      "OpenStudio NAM Rack",
    );

    expect(schema.parameters.find(({ id }) => id === "reverbPad")).toMatchObject({
      label: "Pad",
      type: "toggle",
      value: 0,
      min: 0,
      max: 1,
      defaultValue: 0,
      automatable: true,
      graphRole: "space",
    });
    expect(NAM_RACK_REVERB_ADVANCED_CONTROL_GROUPS[0].paramIds).toContain("reverbPad");
  });

  it("migrates missing PAD state off, preserves explicit on, and sanitizes toggle values", () => {
    const migrate = (values: Record<string, number>) => migrateLegacyNAMRackPresetDspState({
      values,
      dspState: { namEffectsDspVersion: 12, reverbEngineVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };

    const missing = migrate({ reverbShimmer: 0.7 });
    const on = migrate({ reverbPad: 1, reverbShimmer: 0.7 });
    const clampedOn = migrate({ reverbPad: 20 });
    const nonFinite = migrate({ reverbPad: Number.NaN });

    expect(missing.values.reverbPad).toBe(0);
    expect(on.values).toMatchObject({ reverbPad: 1, reverbShimmer: 0.7 });
    expect(clampedOn.values.reverbPad).toBe(1);
    expect(nonFinite.values.reverbPad).toBe(0);
    expect(isCurrentNAMRackPresetState(on)).toBe(true);
  });

  it("canonicalizes PAD inside saved baseline and A/B snapshots", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { reverbPad: 1 },
      dspState: { namEffectsDspVersion: 12, reverbEngineVersion: 5 },
      uiState: {
        namPresetBaseline: {
          values: { reverbShimmer: 0.25 },
          dspState: { namEffectsDspVersion: 12, reverbEngineVersion: 5 },
        },
        namRackCompare: {
          snapshots: {
            A: {
              values: { reverbPad: 1 },
              dspState: { namEffectsDspVersion: 12, reverbEngineVersion: 5 },
            },
            B: {
              values: { reverbPad: -20 },
              dspState: { namEffectsDspVersion: 12, reverbEngineVersion: 5 },
            },
          },
        },
      },
    }, { completePreset: true }) as {
      uiState: {
        namPresetBaseline: { values: Record<string, number> };
        namRackCompare: { snapshots: Record<"A" | "B", { values: Record<string, number> }> };
      };
    };

    expect(migrated.uiState.namPresetBaseline.values.reverbPad).toBe(0);
    expect(migrated.uiState.namRackCompare.snapshots.A.values.reverbPad).toBe(1);
    expect(migrated.uiState.namRackCompare.snapshots.B.values.reverbPad).toBe(0);
  });

  it("fits a compact PAD toggle beside the one Engage footswitch without resizing the asset", () => {
    const { box } = NAM_POST_FX_FACEPLATE_LAYOUT.modules.reverb;
    const footer = NAM_POST_FX_FACEPLATE_LAYOUT.reverb;

    expect(box).toEqual({ x: 528, y: 29, w: 220, h: 195 });
    expect(footer.secondaryX).toBe(34);
    expect(footer.primaryX).toBe(66);
    expect(footer.padToggleSize * box.w / 100).toBe(NAM_POST_FX_FACEPLATE_LAYOUT.reverb.voiceSelector.size * box.w / 100);
    expect(footer.padToggleSize).toBeLessThan(footer.footSize);
    expect(footer.secondaryLedSize).toBe(footer.ledSize);

    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    const reverbStart = design.indexOf('name="reverb"');
    const reverbEnd = design.indexOf("</WidePedal>", reverbStart);
    const reverb = design.slice(reverbStart, reverbEnd);
    expect(reverb).toContain("<Toggle");
    expect(reverb).toContain("size={postLayout.reverb.padToggleSize}");
    expect(reverb).toContain('paramId="reverbPad"');
    expect(reverb.match(/<Foot\b/g)).toHaveLength(1);
    expect(reverb).not.toContain("Pad Intensity");
  });

  it("keeps PAD additive and independent from the existing Air/Shimmer texture knob", () => {
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    const reverbStart = design.indexOf('name="reverb"');
    const reverbEnd = design.indexOf("</WidePedal>", reverbStart);
    const reverb = design.slice(reverbStart, reverbEnd);

    expect(reverb).toContain('paramId="reverbShimmer"');
    expect(reverb).toContain("labelText={reverbLabels.texture}");
    expect(reverb).toContain("value={`${reverbLabels.texture}: 0%`}");
    expect(reverb).not.toContain('labelText={reverbPadActive ? "PAD"');
    expect(reverb).not.toContain("Pad intensity");
  });

  it("keeps scene, skin, module-copy/reset, and factory preset surfaces synchronized", () => {
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const registry = readFileSync(new URL("../components/NAMRackNeuralSkinRegistry.ts", import.meta.url), "utf8");
    const sceneGraph = readFileSync(new URL("../components/NAMRackSceneGraph.tsx", import.meta.url), "utf8");
    const scene = JSON.parse(readFileSync(
      new URL("../components/namScenes/post-reverb.scene.json", import.meta.url),
      "utf8",
    )) as { controls: Array<Record<string, unknown>>; composition: { requiredModules: string[] } };

    const pad = scene.controls.find(({ paramId }) => paramId === "reverbPad");
    const engage = scene.controls.find(({ paramId }) => paramId === "reverbEnabled");
    expect(pad).toMatchObject({ id: "reverb-pad", kind: "switch", x: 245, y: 920, width: 72, height: 72, label: "Pad" });
    expect(engage).toMatchObject({ id: "reverb-engage", kind: "footswitch", x: 475, y: 920, label: "Engage" });
    expect(scene.controls.filter(({ kind }) => kind === "footswitch")).toHaveLength(1);
    expect(scene.composition.requiredModules).toContain("Pad");
    expect(registry).toContain('{ id: "reverb-pad", paramId: "reverbPad", kind: "switch"');
    expect(sceneGraph).toContain('if (control.kind === "switch") return <SceneSwitch');
    expect(sceneGraph).toContain("control.label?.toUpperCase()");

    const skin = deviceSkinForModule("reverb");
    expect(skin?.controls.find(({ paramId }) => paramId === "reverbPad")).toMatchObject({ kind: "switch", label: "Pad" });
    expect(skin?.controls.filter(({ kind }) => kind === "footswitch")).toHaveLength(1);

    const moduleMapStart = panel.indexOf("function moduleParamIds");
    const moduleMapEnd = panel.indexOf("function normalizeRackModuleCopy", moduleMapStart);
    expect(panel.slice(moduleMapStart, moduleMapEnd)).toContain('"reverbEnabled", "reverbPad"');

    const presetsStart = panel.indexOf("const NAM_RACK_PRESETS");
    const presetsEnd = panel.indexOf("function clamp(value", presetsStart);
    expect(panel.slice(presetsStart, presetsEnd).match(/reverbPad: 0/g)).toHaveLength(8);

    const explorer = readFileSync(new URL("../components/NAMExplorer.tsx", import.meta.url), "utf8");
    const plateStart = explorer.indexOf('id: "plate-room"');
    const plateEnd = explorer.indexOf("\n  },", plateStart);
    expect(explorer.slice(plateStart, plateEnd)).toContain("reverbPad: 0");
  });
});
