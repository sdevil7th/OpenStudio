// @ts-expect-error Vitest provides Node builtins while the app tsconfig omits Node typings.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNAMBootSchema } from "../components/BuiltInPluginPanel";
import {
  NAM_PEDAL_HARDWARE_STANDARD_PX,
  NAM_POST_FX_FACEPLATE_LAYOUT,
  NAM_REVERB_VOICE_LABELS,
  NAM_REVERB_VOICE_CONTROL_LABELS,
  NAM_REVERB_VOICE_SELECTOR_PX,
  NAM_REVERB_VOICE_SELECTOR_ROTATIONS,
  namReverbVoiceSelectorDetentPlacement,
  reverbVoiceDisplayLabel,
  reverbVoiceControlLabels,
} from "../components/NAMRackDesignPort";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  CURRENT_NAM_REVERB_ENGINE_VERSION,
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
  normalizeNAMReverbVoice,
} from "../utils/namRackPresetTransactions";

describe("NAM Rack Reverb V5 voice contract", () => {
  it("migrates every pre-V9 complete preset to the exact Studio compatibility voice", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { reverbVoice: 3, reverbDecaySec: 3.4 },
      dspState: { namEffectsDspVersion: 8, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };

    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(11);
    expect(CURRENT_NAM_REVERB_ENGINE_VERSION).toBe(5);
    expect(migrated.values.reverbVoice).toBe(0);
    expect(migrated.values.reverbDecaySec).toBe(3.4);
    expect(migrated.dspState).toEqual({ namEffectsDspVersion: 11, reverbEngineVersion: 5 });
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);
  });

  it("clamps the one current four-state voice enum", () => {
    expect([0, 1, 2, 3].map(normalizeNAMReverbVoice)).toEqual([0, 1, 2, 3]);
    expect(normalizeNAMReverbVoice(-2)).toBe(0);
    expect(normalizeNAMReverbVoice(99)).toBe(3);
    expect(normalizeNAMReverbVoice(Number.NaN)).toBe(0);
    expect(NAM_REVERB_VOICE_LABELS).toEqual(["STUDIO", "PLATE", "HALL", "ROOM"]);
    expect([0, 1, 2, 3].map((value) => reverbVoiceDisplayLabel(value)))
      .toEqual(["STUDIO", "PLATE", "HALL", "ROOM"]);
  });

  it("uses a toggle-sized selector, exactly four aligned detents, and one screen label", () => {
    const { voiceDisplay, voiceSelector, topRowY, topKnobSize } = NAM_POST_FX_FACEPLATE_LAYOUT.reverb;
    const box = NAM_POST_FX_FACEPLATE_LAYOUT.modules.reverb.box;
    const selectorRadius = voiceSelector.size * box.w / 200;
    const selectorBottom = voiceSelector.y * box.h / 100 + selectorRadius;
    const displayBottom = (voiceDisplay.y + voiceDisplay.h) * box.h / 100;
    const topKnobTop = topRowY * box.h / 100 - topKnobSize * box.w / 200;

    expect(NAM_REVERB_VOICE_SELECTOR_PX).toBe(NAM_PEDAL_HARDWARE_STANDARD_PX.toggle);
    expect(voiceSelector.size * box.w / 100).toBeCloseTo(24, 8);
    expect(selectorBottom).toBeCloseTo(displayBottom, 8);
    expect(topKnobTop - displayBottom).toBeGreaterThanOrEqual(4);
    expect(NAM_REVERB_VOICE_SELECTOR_ROTATIONS).toEqual([-60, -20, 20, 60]);
    expect(NAM_REVERB_VOICE_SELECTOR_ROTATIONS.map(namReverbVoiceSelectorDetentPlacement)).toHaveLength(4);
  });

  it("wires the voice across schema, state, advanced controls, fallback skins, and the live pedal", () => {
    const sources = {
      bridge: readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8"),
      panel: readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8"),
      mixer: readFileSync(new URL("../components/NAMRackMixer.tsx", import.meta.url), "utf8"),
      design: readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8"),
      registry: readFileSync(new URL("../components/NAMRackNeuralSkinRegistry.ts", import.meta.url), "utf8"),
      scene: readFileSync(new URL("../components/namScenes/post-reverb.scene.json", import.meta.url), "utf8"),
    };
    for (const source of Object.values(sources)) expect(source).toContain("reverbVoice");
    expect(sources.design).toContain("<ReverbVoiceDisplay paramId=\"reverbVoice\"");
    expect(sources.design).toContain("<FourPositionRotarySelector {...postLayout.reverb.voiceSelector} paramId=\"reverbVoice\"");
    expect(sources.design).toContain("enableButtonDrag");
    expect(sources.design.match(/NAM_REVERB_VOICE_LABELS/g)?.length).toBeGreaterThan(0);
    expect(sources.bridge).toContain("reverbEngineVersion: 5");

    const bootSchema = createNAMBootSchema(
      { chain: "track", trackId: "reverb-test", fxIndex: 0 },
      "OpenStudio NAM Rack",
    );
    expect(bootSchema.parameters.find(({ id }) => id === "reverbVoice")).toMatchObject({
      label: "Reverb Voice",
      type: "enum",
      value: 0,
      min: 0,
      max: 3,
      defaultValue: 0,
      enumOptions: [
        { value: 0, label: "Studio" },
        { value: 1, label: "Plate" },
        { value: 2, label: "Hall" },
        { value: 3, label: "Room" },
      ],
    });
  });

  it("keeps complete factory starting points deterministic for the new voice engine", () => {
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const defaultsStart = panel.indexOf("const NAM_RACK_GLOBAL_DEFAULT_VALUES");
    const defaultsEnd = panel.indexOf("type RackCompareSnapshot", defaultsStart);
    const defaults = panel.slice(defaultsStart, defaultsEnd);
    for (const line of [
      "reverbVoice: 0",
      "reverbMix: 0.28",
      "reverbDecaySec: 2.2",
      "reverbTone: 0.62",
      "reverbPreDelayMs: 18",
      "reverbLowCutHz: 120",
      "reverbShimmer: 0",
      "reverbEnabled: 0",
    ]) expect(defaults).toContain(line);

    const explorer = readFileSync(new URL("../components/NAMExplorer.tsx", import.meta.url), "utf8");
    const plateStart = explorer.indexOf('id: "plate-room"');
    const plateEnd = explorer.indexOf("\n  },", plateStart);
    const platePreset = explorer.slice(plateStart, plateEnd);
    expect(platePreset).toContain("reverbVoice: 1");
    expect(platePreset).toContain("reverbLowCutHz: 120");
    expect(platePreset).toContain("reverbShimmer: 0");
  });

  it("keeps the shared macros stable and gives every voice truthful texture labels", () => {
    expect(NAM_REVERB_VOICE_CONTROL_LABELS).toEqual([
      { preDelay: "PRE DLY", decay: "DECAY", mix: "MIX", lowCut: "LOW CUT", tone: "TONE", texture: "AIR" },
      { preDelay: "PRE DLY", decay: "DECAY", mix: "MIX", lowCut: "LOW CUT", tone: "DAMP", texture: "SHIMMER" },
      { preDelay: "PRE DLY", decay: "DECAY", mix: "MIX", lowCut: "LOW CUT", tone: "DAMP", texture: "MOTION" },
      { preDelay: "PRE DLY", decay: "SIZE", mix: "MIX", lowCut: "LOW CUT", tone: "TONE", texture: "EARLY" },
    ]);
    expect([0, 1, 2, 3].map((value) => reverbVoiceControlLabels(value)))
      .toEqual(NAM_REVERB_VOICE_CONTROL_LABELS);
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    expect(design).toContain("labelText={reverbLabels.decay}");
    expect(design).toContain("labelText={reverbLabels.texture}");
    expect(design).toContain("semanticLabel={reverbLabels.decay === \"SIZE\" ? \"Room Size\" : \"Decay\"}");
    expect(design).not.toContain("labelText=\"VOICE\"");
  });
});
