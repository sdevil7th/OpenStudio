import { describe, expect, it } from "vitest";
import {
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
      generate_audio_codes: true,
      cfg_scale: 2,
      guidance_scale: 1,
      shift: 3,
      temperature: 0.85,
      top_p: 0.9,
      top_k: 0,
      min_p: 0,
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
      generate_audio_codes: "false",
      cfg_scale: "4.5",
      guidance_scale: "21",
      shift: "9.5",
      temperature: "1.25",
      top_p: "0.95",
      top_k: "12",
      min_p: "0.123",
      ignored: "value",
    });

    expect(normalized).toEqual({
      prompt: "123",
      lyrics: "",
      seed: 42,
      bpm: 240,
      duration: 5,
      timesignature: "3/4",
      language: "en",
      keyscale: "C major",
      generate_audio_codes: false,
      inferenceSteps: 8,
      cfg_scale: 4.5,
      guidance_scale: 20,
      shift: 5,
      temperature: 1.25,
      top_p: 0.95,
      top_k: 12,
      min_p: 0.123,
    });
  });

  it("preserves explicit musical metadata in the native parity request surface", () => {
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
      generate_audio_codes: true,
    });
  });

  it("keeps generate_audio_codes enabled by default", () => {
    const normalized = normalizeWorkflowParams("text-to-music", {
      generate_audio_codes: true,
    });

    expect(normalized).toMatchObject({
      bpm: 120,
      duration: 30,
      timesignature: "4/4",
      keyscale: "C major",
      generate_audio_codes: true,
    });
  });
});
