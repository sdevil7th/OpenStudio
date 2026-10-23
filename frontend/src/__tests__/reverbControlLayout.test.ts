import { describe, expect, it } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { reverbControlLayout } from "../utils/reverbControlLayout";

function schema(type: number, values: Record<string, number> = {}): BuiltInPluginSchema {
  return { schemaVersion: 1, name: "OpenStudio Reverb", pluginId: "reverb", category: "Reverb", chain: "track", fxIndex: 0,
    parameters: Object.entries({ algorithm: Math.min(3, type), reverbTypeAll: type, spaceEngine: 1, plateEngineExpanded: 1, springEngine: 1, shimmerVoiceEngine: 1, studioDecayFilter: 0, plateDecayFilter: 0, ...values })
      .map(([id, value]) => ({ id, value, label: id, type: "continuous", min: 0, max: 40, defaultValue: 0 })) };
}
const visibleIds = (layout: ReturnType<typeof reverbControlLayout>) => [layout.type === 7 ? "ir.shape" : layout.primary.id, ...layout.shape.map(control => control.id), ...layout.pages.flatMap(page => page.controls.map(control => control.id))];

describe("approved Reverb native applicability", () => {
  it("exposes the saved control behavior independently of Processing on every type", () => {
    for (let type=0; type<41; ++type) {
      const layout=reverbControlLayout(schema(type,{ reverbControlMode: 0, reverbReturnMode: 1 }));
      const character=layout.pages.find(page=>page.id==="setup")!;
      expect(character.controls[0].id).toBe("reverbReturnMode");
      expect(character.controls.find(control=>control.id==="reverbControlMode")?.description).toContain("older saved states load Legacy");
      expect(character.help).toContain("Wet/Dry");
    }
  });
  it("shows pitch scheduling only for spectral Shimmer and broadband body only for Vowel", () => {
    for (let type = 0; type < 41; ++type) {
      const layout = reverbControlLayout(schema(type));
      expect(visibleIds(layout).includes("shimmerScheduling")).toBe(type === 5);
      expect(visibleIds(layout).includes("ambBody")).toBe(type === 20);
    }
    expect(visibleIds(reverbControlLayout(schema(5, { shimmerVoiceEngine: 0 })))).not.toContain("shimmerScheduling");
    expect(reverbControlLayout(schema(5)).pages.find(page => page.id === "character")?.help).toContain("30 ms hop");
    expect(reverbControlLayout(schema(20)).pages.find(page => page.id === "character")?.help).toContain("feedback tank are unchanged");
  });
  it("offers shared Return level in Setup on every type, including legacy and convolution engines", () => {
    for (let type = 0; type < 41; ++type) {
      const layout = reverbControlLayout(schema(type, { reverbReturnMode: 1, spaceEngine: 0, plateEngineExpanded: 0, springEngine: 0 }));
      const character = layout.pages.find(page => page.id === "setup")!;
      expect(character.controls[0].id).toBe("reverbReturnMode");
      expect(character.controls[0].description).toContain("fixed wet-return trims");
      expect(character.controls[0].description).toContain("Legacy Room/Hall/Chamber/Plate and custom IRs retain their levels");
      expect(character.help).toContain("older states without this choice use Original");
      expect(visibleIds(layout).filter(id => id === "reverbReturnMode")).toHaveLength(1);
    }
  });
  it("offers Refined processing only where an active engine uses it", () => {
    for (let type = 0; type < 41; ++type) {
      const layout = reverbControlLayout(schema(type, { reverbCharacterMode: 0 }));
      const applicable = type === 2 || type === 19 || (type >= 21 && type <= 35) || type >= 37;
      expect(visibleIds(layout).includes("reverbCharacterMode")).toBe(applicable);
    }
    for (const plateEngineExpanded of [0, 2]) {
      expect(visibleIds(reverbControlLayout(schema(2, { reverbCharacterMode: 0, plateEngineExpanded })))).not.toContain("reverbCharacterMode");
    }
  });
  it("uses the expanded native identity for all41 types, with timing and routing reachable", () => {
    for (let type = 0; type < 41; ++type) {
      const result = reverbControlLayout(schema(type));
      expect(result.type).toBe(type);
      expect(result.pages.some(page => page.id === "character")).toBe(true);
      expect(visibleIds(result)).toContain("sendMode");
      expect(visibleIds(result)).toContain("mixLock");
      expect(visibleIds(result)).toContain("wetDuckDepth");
      expect(result.pages.map(page => page.id).length).toBe(new Set(result.pages.map(page => page.id)).size);
    }
  });

  it("does not expose inert algorithmic Decay, Size or Diffusion on special engines", () => {
    const positioned = visibleIds(reverbControlLayout(schema(16)));
    expect(positioned).toEqual(expect.arrayContaining(["roomSize", "sourceX", "sourceY", "roomShape"]));
    expect(positioned).not.toContain("decayTime"); expect(positioned).not.toContain("diffusion");
    const modal = visibleIds(reverbControlLayout(schema(2, { plateEngineExpanded: 2 })));
    expect(modal).toEqual(expect.arrayContaining(["modalLength", "modalAspect", "modalExciterX", "modalRightY", "modalPickupRadius", "plateDrive"]));
    expect(modal).not.toContain("roomSize"); expect(modal).not.toContain("diffusion"); expect(modal).not.toContain("plateModulation");
    const ir = visibleIds(reverbControlLayout(schema(7)));
    expect(ir).not.toContain("decayTime"); expect(ir).not.toContain("damping"); expect(ir).toContain("irExtension5");
    const shaped = visibleIds(reverbControlLayout(schema(36)));
    expect(shaped).toContain("retroAttack"); expect(shaped).not.toContain("retroDecay"); expect(shaped).not.toContain("diffusion");
  });

  it("keeps compatibility Freeze and hides unsupported prepared-engine controls", () => {
    const legacySpace = reverbControlLayout(schema(0, { spaceEngine: 0 }));
    expect(legacySpace.hold).toBeNull(); expect(visibleIds(legacySpace)).toContain("freezeMode");
    expect(visibleIds(legacySpace)).not.toContain("spaceModulation"); expect(visibleIds(legacySpace)).not.toContain("holdInputMode");
    const legacyPlate = reverbControlLayout(schema(2, { plateEngineExpanded: 0 }));
    expect(visibleIds(legacyPlate)).toContain("earlyLevel"); expect(visibleIds(legacyPlate)).not.toContain("plateDrive");
    const legacySpring = reverbControlLayout(schema(4, { springEngine: 0 }));
    expect(legacySpring.hold).toBeNull(); expect(visibleIds(legacySpring)).toContain("roomSize");
    expect(visibleIds(legacySpring)).not.toContain("diffusion"); expect(visibleIds(legacySpring)).not.toContain("springDwell");
    expect(visibleIds(reverbControlLayout(schema(5, { shimmerVoiceEngine: 0 })))).not.toContain("shimmerPitchA");
  });

  it("preserves correct Hold enums and native spatial timing", () => {
    for (const type of [10, 11, 14, 36]) expect(reverbControlLayout(schema(type)).hold).toBeNull();
    for (const type of [17, 18, 19, 20]) {
      const ambient = reverbControlLayout(schema(type));
      expect(ambient.hold).toBe("ambHold"); expect(visibleIds(ambient)).not.toContain("holdInputMode");
    }
    for (const type of [12, 13, 14]) {
      const spatial = reverbControlLayout(schema(type, { spatialSync: 1 }));
      expect(spatial.sync).toBe("spatialSync"); expect(spatial.division).toBe("spatialDivision");
      expect(visibleIds(spatial)).toContain("spatialDelayCapacity"); expect(visibleIds(spatial)).not.toContain("preDelay");
    }
    expect(reverbControlLayout(schema(4)).hold).toBe("springHold");
    expect(reverbControlLayout(schema(6)).hold).toBe("nonlinearHold");
  });

  it("reveals active decay filters, output cuts and material details without duplicating legacy selectors", () => {
    const space = visibleIds(reverbControlLayout(schema(1, { studioDecayFilter: 2, studioOutputCutOff: 1 })));
    expect(space).toContain("studioDecayCutoff"); expect(space).not.toContain("damping"); expect(space).not.toContain("highCut");
    const material = visibleIds(reverbControlLayout(schema(2, { plateEngineExpanded: 2, modalMaterial: 1 })));
    expect(material).toEqual(expect.arrayContaining(["modalYoung", "modalDensity", "modalPoisson", "modalThickness"]));
    expect(material).not.toContain("modalRigidity"); expect(material).not.toContain("plateCharacter");
  });
});
