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
