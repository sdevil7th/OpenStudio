import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAIClipJob, cancelAIClipJob, clipJobOwner, useAIClipJob } from "../services/aiClipJobs";
import { startAITrackJob, cancelAITrackJob } from "../services/aiTrackJobs";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useDAWStore.getState();
const flush = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const owner = clipJobOwner("source", "clip");
const request = { trackId: "source", clipId: "clip", modelId: "stable-audio-3-medium",
  workflowId: "variation" as const, params: {}, extensionDuration: 2 };

describe("source clip jobs share app-owned, request-bound generation", () => {
  beforeEach(() => {
    vi.useFakeTimers(); commandManager.clear();
    const source = createDefaultTrack("source", "Bass DI", "#fff", "audio");
    source.clips = [{ id: "clip", filePath: "bass.wav", name: "Bass", startTime: 1,
      duration: 4, offset: 0, color: "#fff", volumeDB: 0, fadeIn: 0, fadeOut: 0 }];
    useDAWStore.setState({ ...initial, tracks: [source, createDefaultTrack("ai", "AI", "#fff", "ai")] });
    vi.spyOn(nativeBridge, "startAIGeneration").mockResolvedValue({ started: true, requestId: "request" });
    vi.spyOn(nativeBridge, "getAIGenerationProgress").mockResolvedValue({ state: "generating", progress: 0.2, requestId: "request" });
    vi.spyOn(nativeBridge, "cancelAIGeneration").mockResolvedValue(undefined);
    vi.spyOn(nativeBridge, "importMediaFile").mockResolvedValue({ filePath: "generated.wav", duration: 2, sampleRate: 48000, numChannels: 2, format: "wav" });
  });
  afterEach(async () => {
    await cancelAIClipJob(owner); await cancelAITrackJob("ai");
    vi.restoreAllMocks(); vi.useRealTimers(); commandManager.clear(); useDAWStore.setState(initial);
  });
  it.each(["variation", "continue-clip", "inpaint-selection"] as const)("%s completes once without a mounted modal, with undo", async workflowId => {
    await startAIClipJob({ ...request, workflowId });
    useDAWStore.getState().closeAIClipGeneration();
    vi.mocked(nativeBridge.getAIGenerationProgress).mockResolvedValue({ state: "done", progress: 1, requestId: "request", outputFile: "generated.wav" });
    await vi.advanceTimersByTimeAsync(250);
    expect(useDAWStore.getState().tracks.flatMap(track => track.clips)).toHaveLength(2);
    expect(commandManager.canUndo()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeBridge.importMediaFile).toHaveBeenCalledTimes(1);
    commandManager.undo();
    expect(useDAWStore.getState().tracks.flatMap(track => track.clips)).toHaveLength(1);
  });
  it.each(["filePath", "offset", "duration", "startTime", "playbackRate", "reversed"])("cancels on a source %s edit", async property => {
    await startAIClipJob(request);
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => track.id === "source" ? { ...track,
      clips: track.clips.map(clip => ({ ...clip, [property]: property === "filePath" ? "other.wav" : property === "reversed" ? true : 3 })) } : track) }));
    await flush();
    expect(nativeBridge.cancelAIGeneration).toHaveBeenCalledWith("request");
    expect(useAIClipJob.getState().progress.phase).toBe("source_changed");
    expect(nativeBridge.importMediaFile).not.toHaveBeenCalled();
  });
  it("retains source identity across harmless selection/name/meter updates", async () => {
    await startAIClipJob(request);
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, name: "Renamed" })) })) }));
    await vi.advanceTimersByTimeAsync(250);
    expect(nativeBridge.cancelAIGeneration).not.toHaveBeenCalled();
  });
  it("cancels the eventual request when cancelled before its start reply", async () => {
    const pending = deferred<{ started: boolean; requestId: string }>();
    vi.mocked(nativeBridge.startAIGeneration).mockReturnValue(pending.promise);
    const start = startAIClipJob(request);
    const cancel = cancelAIClipJob(owner);
    await flush();
    expect(nativeBridge.cancelAIGeneration).not.toHaveBeenCalled();
    pending.resolve({ started: true, requestId: "late" });
    await start; await cancel;
    expect(nativeBridge.cancelAIGeneration).toHaveBeenCalledWith("late");
  });
  it("shares exclusivity with AI tracks and never lets an old modal cancel a track job", async () => {
    await startAIClipJob(request); await startAITrackJob("ai");
    expect(nativeBridge.startAIGeneration).toHaveBeenCalledTimes(1);
    await cancelAIClipJob(owner); await startAITrackJob("ai");
    vi.mocked(nativeBridge.cancelAIGeneration).mockClear();
    await cancelAIClipJob(owner);
    expect(nativeBridge.cancelAIGeneration).not.toHaveBeenCalled();
  });
  it.each(["delete", "project", "trim", "cancel"])("rejects late prepared media after %s", async change => {
    const pending = deferred<any>();
    vi.mocked(nativeBridge.importMediaFile).mockReturnValue(pending.promise);
    vi.mocked(nativeBridge.getAIGenerationProgress).mockResolvedValue({ state: "done", progress: 1, requestId: "request", outputFile: "generated.wav" });
    await startAIClipJob(request); await flush();
    if (change === "cancel") await cancelAIClipJob(owner);
    else {
      if (change === "project") advanceProjectEpoch();
      useDAWStore.setState(state => ({ tracks: change === "delete" ? [] : state.tracks.map(track => ({ ...track,
        clips: track.clips.map(clip => ({ ...clip, duration: change === "trim" ? 3 : clip.duration })) })) }));
    }
    pending.resolve({ filePath: "generated.wav", duration: 2, sampleRate: 48000 }); await flush();
    expect(useDAWStore.getState().tracks.flatMap(track => track.clips).some(clip => clip.filePath === "generated.wav")).toBe(false);
  });
});
