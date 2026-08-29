import { describe, expect, it } from "vitest";
import {
  NAM_RACK_ADVANCED_CONTROL_IDS,
  NAM_RACK_ADVANCED_ONLY_CONTROL_IDS,
  namRackAdvancedStageForCompactModule,
} from "../components/NAMRackMixer";

describe("NAM Rack advanced-control exposure", () => {
  it("keeps every advanced-only parameter in the complete supported registry", () => {
    for (const stageId of Object.keys(NAM_RACK_ADVANCED_ONLY_CONTROL_IDS)) {
      const stage = stageId as keyof typeof NAM_RACK_ADVANCED_ONLY_CONTROL_IDS;
      const supported = NAM_RACK_ADVANCED_CONTROL_IDS[stage] as readonly string[];
      for (const paramId of NAM_RACK_ADVANCED_ONLY_CONTROL_IDS[stage]) {
        expect(supported).toContain(paramId);
      }
    }
  });

  it("exposes advanced affordances only for stages with hidden controls", () => {
    expect(namRackAdvancedStageForCompactModule("gate")).toBe("gate");
    expect(namRackAdvancedStageForCompactModule("mod")).toBe("mod");
    expect(namRackAdvancedStageForCompactModule("delay")).toBe("delay");
    expect(namRackAdvancedStageForCompactModule("amp-nam")).toBeNull();
    expect(namRackAdvancedStageForCompactModule("cab-ir")).toBeNull();
    expect(namRackAdvancedStageForCompactModule("eq")).toBeNull();
    expect(namRackAdvancedStageForCompactModule("reverb")).toBeNull();
  });
});
