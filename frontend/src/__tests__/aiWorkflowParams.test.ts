import { describe, expect, it } from "vitest";
import {
  ACE_STEP_MODEL_ID,
  AI_WORKFLOWS,
  STABLE_AUDIO_3_MODEL_ID,
  getAIModelsForWorkflow,
  getAIWorkflowsForSurface,
  getClipInpaintRange,
  getDefaultWorkflowParams,
  normalizeWorkflowParams,
} from "../data/aiWorkflows";

describe("AI workflow params", () => {
  it("provides the fixed ACE-Step parameter surface for text-to-music", () => {
    const defaults = getDefaultWorkflowParams("text-to-music");

    expect(defaults).toMatchObject({
      prompt: "",
      lyrics: "",
      seed: -1,
      bpm: 120,
      duration: 30,
      timesignature: "4/4",
      language: "en",
      keyscale: "C major",
      inferenceSteps: 8,
      shift: 3,
    });
  });

  it("normalizes and clamps AI workflow params to the pinned schema", () => {
    const normalized = normalizeWorkflowParams("lyrics+style", {
      prompt: 123,
      lyrics: null,
      seed: "42",
      bpm: "999",
      duration: "-50",
      timesignature: "3",
      language: "xx",
      keyscale: "not-a-key",
      shift: "9.5",
      inferenceSteps: "99",
      ignored: "value",
    });

    expect(normalized).toEqual({
      prompt: "123",
      lyrics: "",
      seed: 42,
      bpm: 240,
      duration: 10,
      timesignature: "3/4",
      language: "en",
      keyscale: "C major",
      inferenceSteps: 24,
      shift: 9.5,
    });
  });

  it("preserves explicit musical metadata in the Diffusers request surface", () => {
    const normalized = normalizeWorkflowParams("text-to-music", {
      bpm: 170,
      duration: 191,
      timesignature: "3/4",
      keyscale: "C# minor",
    });

    expect(normalized).toMatchObject({
      bpm: 170,
      duration: 191,
      timesignature: "3/4",
      keyscale: "C# minor",
    });
  });

  it("keeps Diffusers-only ACE params visible by default", () => {
    const normalized = normalizeWorkflowParams("text-to-music", {});

    expect(normalized).toMatchObject({
      bpm: 120,
      duration: 30,
      timesignature: "4/4",
      keyscale: "C major",
      inferenceSteps: 8,
      shift: 3,
    });
  });

  it("filters workflows by surface and selected model", () => {
    expect(getAIWorkflowsForSurface("ai-track", ACE_STEP_MODEL_ID).map((workflow) => workflow.id)).toEqual([
      "text-to-music",
      "lyrics-style",
    ]);
    expect(getAIWorkflowsForSurface("ai-track", STABLE_AUDIO_3_MODEL_ID).map((workflow) => workflow.id)).toEqual([
      "text-to-audio",
    ]);
    expect(getAIWorkflowsForSurface("clip-context", STABLE_AUDIO_3_MODEL_ID).map((workflow) => workflow.id)).toEqual([
      "variation",
      "inpaint-selection",
      "continue-clip",
    ]);
  });

  it("uses Stable Audio defaults and clamps source workflow params", () => {
    const defaults = getDefaultWorkflowParams("text-to-audio", STABLE_AUDIO_3_MODEL_ID);
    expect(defaults).toMatchObject({
      prompt: "",
      negative_prompt: "",
      seed: -1,
      duration: 30,
      steps: 8,
      cfg_scale: 1,
      lora_path: "",
      lora_strength: 1,
    });

    const normalized = normalizeWorkflowParams("variation", {
      steps: "999",
      cfg_scale: "-4",
      noise_amount: "-1",
      lora_strength: "5",
    }, STABLE_AUDIO_3_MODEL_ID);

    expect(normalized).toMatchObject({
      steps: 32,
      cfg_scale: 0.1,
      noise_amount: 0,
      lora_strength: 2,
    });
  });

  it("keeps clip source workflow forms source-specific", () => {
    const stableVariation = getDefaultWorkflowParams("variation", STABLE_AUDIO_3_MODEL_ID);
    expect(stableVariation).toMatchObject({
      prompt: "Create a close musical variation that preserves the source clip's tempo, key, primary instrument, arrangement density, and mix character. Do not add vocals or unrelated instruments.",
      negative_prompt: "unrelated instruments, unexpected vocals, full band arrangement unless present in the source, distorted, noisy, clipped, abrupt transition, low quality",
      seed: -1,
      noise_amount: 0.5,
      steps: 8,
      cfg_scale: 1,
    });
    expect(stableVariation).not.toHaveProperty("duration");
    expect(stableVariation).not.toHaveProperty("extension_duration");
    expect(stableVariation).not.toHaveProperty("inpaint_start");

    const stableContinue = getDefaultWorkflowParams("continue-clip", STABLE_AUDIO_3_MODEL_ID);
    expect(stableContinue).toMatchObject({
      prompt: "Continue the same musical idea, matching the source clip's tempo, key, primary instrument, harmony, room tone, and mix. Do not add vocals or unrelated instruments unless requested.",
      negative_prompt: "unrelated instruments, unexpected vocals, full band arrangement unless present in the source, distorted, noisy, clipped, abrupt transition, low quality",
      seed: -1,
      extension_duration: 8,
      steps: 8,
      cfg_scale: 1,
    });
    expect(stableContinue).not.toHaveProperty("duration");
    expect(stableContinue).not.toHaveProperty("noise_amount");

    const stableInpaint = getDefaultWorkflowParams("inpaint-selection", STABLE_AUDIO_3_MODEL_ID);
    expect(stableInpaint.prompt).toBe("Replace the selected range naturally while matching the surrounding clip.");
    expect(stableInpaint).not.toHaveProperty("duration");

    const aceVariation = getDefaultWorkflowParams("variation", ACE_STEP_MODEL_ID);
    expect(aceVariation).toMatchObject({
      prompt: "Create a close musical variation that preserves the source clip's tempo, key, primary instrument, and arrangement density. Do not add vocals or unrelated instruments.",
      seed: -1,
      audio_cover_strength: 0.85,
      inferenceSteps: 8,
      shift: 3,
    });
    expect(aceVariation).not.toHaveProperty("lyrics");
    expect(aceVariation).not.toHaveProperty("duration");
    expect(aceVariation).not.toHaveProperty("extension_duration");
  });

  it("converts timeline time selection into clip-relative inpaint range", () => {
    expect(getClipInpaintRange({ start: 12, end: 16 }, { startTime: 10, duration: 8 })).toEqual({
      start: 2,
      end: 6,
    });
    expect(getClipInpaintRange({ start: 1, end: 4 }, { startTime: 10, duration: 8 })).toBeNull();
    expect(getClipInpaintRange(null, { startTime: 10, duration: 8 })).toBeNull();
  });

  it("does not expose unsupported ACE-only workflow ids", () => {
    const ids = AI_WORKFLOWS.map((workflow) => workflow.id);
    expect(ids).not.toContain("extract");
    expect(ids).not.toContain("lego");
    expect(ids).not.toContain("complete");
    expect(ids).not.toContain("continuation");
  });

  it("limits source workflow model choices to supporting models", () => {
    expect(getAIModelsForWorkflow("variation").map((model) => model.id)).toEqual([
      ACE_STEP_MODEL_ID,
      STABLE_AUDIO_3_MODEL_ID,
    ]);
    expect(getAIModelsForWorkflow("text-to-audio").map((model) => model.id)).toEqual([
      STABLE_AUDIO_3_MODEL_ID,
    ]);
  });
});
