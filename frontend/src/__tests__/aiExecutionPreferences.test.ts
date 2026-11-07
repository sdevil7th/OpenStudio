import { beforeEach, describe, expect, it } from "vitest";
import { ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID, normalizeWorkflowParams } from "../data/aiWorkflows";
import { getAIExecutionPreference, setAIExecutionPreference, withAIExecutionPreference } from "../services/aiExecutionPreferences";

describe("local AI execution preferences", () => {
  beforeEach(() => {
    setAIExecutionPreference(ACE_STEP_MODEL_ID, "standard");
    setAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, "standard");
  });
  it("attaches local policy only to a copied outgoing request", () => {
    const params = normalizeWorkflowParams("text-to-audio", { prompt: "Song", duration: 30 }, STABLE_AUDIO_3_MODEL_ID);
    const saved = JSON.stringify(params);
    setAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, "fp8-storage");
    const request = withAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, params);
    expect(request.generationOptimization).toBe("fp8-storage");
    expect(JSON.stringify(params)).toBe(saved);
    expect(params).not.toHaveProperty("generationOptimization");
    expect(normalizeWorkflowParams("text-to-audio", request, STABLE_AUDIO_3_MODEL_ID)).not.toHaveProperty("generationOptimization");
  });
  it("keeps per-model choices separate and preserves saved INT8 execution", () => {
    setAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, "fp8-storage");
    expect(getAIExecutionPreference(ACE_STEP_MODEL_ID)).toBe("standard");
    expect(withAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, { modelVariant: "int8" })).not.toHaveProperty("generationOptimization");
    setAIExecutionPreference(ACE_STEP_MODEL_ID, "disk-offload");
    expect(getAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID)).toBe("fp8-storage");
    setAIExecutionPreference(ACE_STEP_MODEL_ID, "rocm-fast-startup");
    expect(withAIExecutionPreference(ACE_STEP_MODEL_ID, {}).generationOptimization).toBe("rocm-fast-startup");
    expect(withAIExecutionPreference(ACE_STEP_MODEL_ID, { modelVariant: "int8" })).not.toHaveProperty("generationOptimization");
    setAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, "compile");
    expect(withAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, {}).generationOptimization).toBe("compile");
    expect(withAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, { modelVariant: "int8" })).not.toHaveProperty("generationOptimization");
  });
  it("rejects an unsupported model/format pairing", () => {
    expect(() => setAIExecutionPreference(ACE_STEP_MODEL_ID, "fp8-storage")).toThrow();
    expect(() => setAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, "disk-offload")).toThrow();
    expect(() => setAIExecutionPreference(STABLE_AUDIO_3_MODEL_ID, "rocm-fast-startup")).toThrow();
    expect(() => setAIExecutionPreference(ACE_STEP_MODEL_ID, "compile")).toThrow();
  });
});
