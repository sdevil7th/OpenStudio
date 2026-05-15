import { describe, expect, it } from "vitest";
import modalSource from "../components/AiToolsSetupModal.tsx?raw";
import bridgeSource from "../services/NativeBridge.ts?raw";
import storeSource from "../store/useDAWStore.ts?raw";

describe("AI feature installer contract", () => {
  it("defaults the setup checklist to requested compatible features or stem separation", () => {
    expect(modalSource).toContain("const AI_FEATURES: AiFeatureId[] = [\"stemSeparation\", \"audioGeneration\"]");
    expect(modalSource).toContain("function defaultSelectedFeatures");
    expect(modalSource).toContain("if (requestedFeature)");
    expect(modalSource).toContain("return stem.compatible && !stem.ready ? [\"stemSeparation\"] : []");
  });

  it("keeps incompatible Audio Generation disabled while Stem Separation remains selectable", () => {
    expect(modalSource).toContain("!feature.compatible");
    expect(modalSource).toContain("Incompatible features are disabled and will not be installed.");
    expect(modalSource).toContain("supported GPU with at least 8 GB memory was not detected");
    expect(modalSource).toContain("CPU-only machines are supported.");
  });

  it("sends modular feature selections over the native bridge", () => {
    expect(bridgeSource).toContain("export type AiFeatureId = \"stemSeparation\" | \"audioGeneration\"");
    expect(bridgeSource).toContain("selectedFeatures?: AiFeatureId[]");
    expect(bridgeSource).toContain("requestedFeature?: AiFeatureId");
    expect(bridgeSource).toContain("JSON.stringify(options)");
  });

  it("keeps old install calls as a stem-separation default in the store", () => {
    expect(storeSource).toContain("options.requestedFeature ?? \"stemSeparation\"");
    expect(storeSource).toContain("selectedFeatures: [\"stemSeparation\"]");
  });
});
