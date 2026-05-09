import { describe, expect, it } from "vitest";
import { nativeBridge } from "../services/NativeBridge";

const pendingAiTools = {
  assistantRuntimeReady: false,
  audioUnderstandingRuntimeReady: false,
  audioUnderstandingStatus: "not_installed",
  audioUnderstandingPrefilterProfile: "midashenglm-7b-1021-bf16-local-cuda",
};

describe("assistant web fallback", () => {
  it("does not create a setup plan for selected audio-analysis prompts", async () => {
    const response = await nativeBridge.runAssistantPrompt(
      "can you analyze the vocal track and tell me what should be done?",
      {
        aiToolsStatus: pendingAiTools,
        selectedClipIds: ["clip-1"],
        tracks: [{
          id: "track-1",
          clips: [{ id: "clip-1", name: "Lead vocal" }],
        }],
      },
    );

    expect(response.ok).toBe(true);
    expect(response.mode).toBe("answer");
    expect(response.plan).toBeUndefined();
    expect(response.reply).toContain("OpenStudio cannot hear or analyze");
    expect(response.reply).toContain("core music analyzer");
  });

  it("asks for clip selection instead of opening setup for audio-analysis prompts", async () => {
    const response = await nativeBridge.runAssistantPrompt(
      "analyze the vocal track and make it sound better",
      {
        aiToolsStatus: pendingAiTools,
        selectedClipIds: [],
        tracks: [],
      },
    );

    expect(response.ok).toBe(true);
    expect(response.mode).toBe("clarification");
    expect(response.plan).toBeUndefined();
    expect(response.reply).toContain("Select an audio clip");
  });

  it("keeps explicit setup prompts as setup plans", async () => {
    const response = await nativeBridge.runAssistantPrompt(
      "open ai tools setup",
      {
        aiToolsStatus: pendingAiTools,
        selectedClipIds: [],
        tracks: [],
      },
    );

    expect(response.ok).toBe(true);
    expect(response.mode).toBe("plan");
    expect(response.plan).toMatchObject({
      actions: [{ kind: "ai.openSetup" }],
    });
  });
});
