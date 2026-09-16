import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type AiToolsStatus } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();
afterEach(() => {
  vi.restoreAllMocks();
  useDAWStore.setState(initialState);
});

describe("AI setup terminal results", () => {
  it.each(["error", "cancelled"] as const)("preserves %s when another tool is available", async (state) => {
    const status: AiToolsStatus = {
      ...initialState.aiToolsStatus,
      state,
      installInProgress: false,
      available: true,
      requestedModelId: "stable-audio-3-medium",
      error: "Stable Audio setup did not complete",
      errorCode: "stable_audio_import_failed",
    };
    useDAWStore.getState().applyAiToolsStatusUpdate(status);
    expect(useDAWStore.getState().aiToolsStatus).toMatchObject(status);
    vi.spyOn(nativeBridge, "refreshAiToolsStatus").mockResolvedValue(status);
    expect(await useDAWStore.getState().refreshAiToolsStatus(true)).toMatchObject(status);
  });
});


it("installs ACE INT8 even when the Original audio-generation feature is ready", async () => {
  const status = { ...initialState.aiToolsStatus, state: "ready" as const,
    available: true, installInProgress: false, musicGenerationReady: true,
    musicGenerationLayoutValid: true, musicGenerationAvailableProfiles: ["ace-diffusers"] };
  useDAWStore.setState({ aiToolsStatus: status });
  vi.spyOn(nativeBridge, "installAiTools").mockResolvedValue({ started: true });
  vi.spyOn(nativeBridge, "refreshAiToolsStatus").mockResolvedValue(status);
  const result = await useDAWStore.getState().installAiTools({
    modelId: "ace-step-v15-xl-turbo", modelVariant: "int8", userConfirmedDownload: true,
    selectedFeatures: ["audioGeneration"], requestedFeature: "audioGeneration",
  });
  expect(result?.started).toBe(true);
  expect(nativeBridge.installAiTools).toHaveBeenCalledWith(expect.objectContaining({
    modelId: "ace-step-v15-xl-turbo", modelVariant: "int8",
  }));
});
