import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAITrackJob, cancelAITrackJob } from "../services/aiTrackJobs";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useDAWStore.getState();
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe("application-owned AI track jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    commandManager.clear();
    useDAWStore.setState({ ...initial, tracks: [createDefaultTrack("ai", "AI", "#fff", "ai")] });
    vi.spyOn(nativeBridge, "startAIGeneration").mockResolvedValue({ started: true, requestId: "request-a" });
    vi.spyOn(nativeBridge, "getAIGenerationProgress").mockResolvedValue({ state: "generating", progress: 0.5, requestId: "request-a" });
    vi.spyOn(nativeBridge, "cancelAIGeneration").mockResolvedValue(undefined);
    vi.spyOn(nativeBridge, "importMediaFile").mockResolvedValue({ filePath: "generated.wav", duration: 1, sampleRate: 48000, numChannels: 2, format: "wav" });
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "workRecovery").mockImplementation(async action => action === "createAI" ? "session/job" : true);
  });
  afterEach(async () => {
    await cancelAITrackJob("ai");
    vi.useRealTimers();
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initial);
  });
  it("finishes without any mounted header and imports exactly once", async () => {
    await startAITrackJob("ai");
    vi.mocked(nativeBridge.getAIGenerationProgress).mockResolvedValue({ state: "done", progress: 1, outputFile: "generated.wav", requestId: "request-a" });
    await vi.advanceTimersByTimeAsync(250);
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].aiGenerationState).toBe("idle");
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeBridge.importMediaFile).toHaveBeenCalledTimes(1);
    expect(commandManager.canUndo()).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0].recoveryJobId).toBe("session/job");
    expect(nativeBridge.workRecovery).toHaveBeenCalledWith("updateAI", "session/job", {
      status: "completed", outputFile: "generated.wav",
    });
    expect(nativeBridge.workRecovery).not.toHaveBeenCalledWith("updateAI", "session/job",
      expect.objectContaining({ status: "imported" }));
    expect(vi.mocked(nativeBridge.workRecovery).mock.calls.filter(([action]) => action === "dismiss")).toHaveLength(0);
  });
  it("serializes cancel-before-start-reply and binds cancellation to the request", async () => {
    const pending = deferred<{ started: boolean; requestId: string }>();
    vi.mocked(nativeBridge.startAIGeneration).mockReturnValue(pending.promise);
    const start = startAITrackJob("ai");
    const cancel = cancelAITrackJob("ai");
    expect(nativeBridge.cancelAIGeneration).not.toHaveBeenCalled();
    pending.resolve({ started: true, requestId: "request-a" });
    await start; await cancel;
    expect(nativeBridge.cancelAIGeneration).toHaveBeenCalledWith("request-a");
    expect(nativeBridge.importMediaFile).not.toHaveBeenCalled();
  });
  it("never cancels someone else's worker when its own start was rejected", async () => {
    const pending = deferred<{ started: boolean }>();
    vi.mocked(nativeBridge.startAIGeneration).mockReturnValue(pending.promise);
    const start = startAITrackJob("ai");
    const cancel = cancelAITrackJob("ai");
    pending.resolve({ started: false });
    await start; await cancel;
    expect(nativeBridge.cancelAIGeneration).not.toHaveBeenCalled();
  });
  it("cancels when a track disappears and rejects its late completion", async () => {
    const pending = deferred<any>();
    vi.mocked(nativeBridge.getAIGenerationProgress).mockReturnValue(pending.promise);
    await startAITrackJob("ai");
    useDAWStore.setState({ tracks: [] });
    pending.resolve({ state: "done", outputFile: "generated.wav", requestId: "request-a" });
    await flush();
    expect(nativeBridge.cancelAIGeneration).toHaveBeenCalledWith("request-a");
    expect(nativeBridge.importMediaFile).not.toHaveBeenCalled();
  });
  it("rejects completion after reopening a project with the same track ID", async () => {
    const pending = deferred<any>();
    vi.mocked(nativeBridge.getAIGenerationProgress).mockReturnValue(pending.promise);
    await startAITrackJob("ai");
    advanceProjectEpoch();
    useDAWStore.setState({ tracks: [createDefaultTrack("ai", "Reopened", "#fff", "ai")] });
    pending.resolve({ state: "done", outputFile: "generated.wav", requestId: "request-a" });
    await flush();
    expect(nativeBridge.importMediaFile).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(0);
  });
  it("cancellation during media preparation cannot insert a late clip", async () => {
    const pending = deferred<any>();
    vi.mocked(nativeBridge.importMediaFile).mockReturnValue(pending.promise);
    vi.mocked(nativeBridge.getAIGenerationProgress).mockResolvedValue({ state: "done", progress: 1, outputFile: "generated.wav", requestId: "request-a" });
    await startAITrackJob("ai"); await flush();
    await cancelAITrackJob("ai");
    pending.resolve({ filePath: "generated.wav", duration: 1, sampleRate: 48000 });
    await flush();
    expect(nativeBridge.addPlaybackClip).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(0);
  });
  it("rejects a mismatched native request without cancelling that request", async () => {
    vi.mocked(nativeBridge.getAIGenerationProgress).mockResolvedValue({ state: "done", progress: 1, outputFile: "other.wav", requestId: "request-b" });
    await startAITrackJob("ai"); await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(nativeBridge.importMediaFile).not.toHaveBeenCalled();
    expect(nativeBridge.cancelAIGeneration).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks[0].aiGenerationState).toBe("error");
  });
  it("bounds failed progress retries and cancels only the owned worker", async () => {
    vi.mocked(nativeBridge.getAIGenerationProgress).mockRejectedValue(new Error("Bridge failed"));
    await startAITrackJob("ai"); await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(nativeBridge.getAIGenerationProgress).toHaveBeenCalledTimes(3);
    expect(nativeBridge.cancelAIGeneration).toHaveBeenCalledWith("request-a");
    expect(useDAWStore.getState().tracks[0].aiGenerationState).toBe("error");
  });
});
