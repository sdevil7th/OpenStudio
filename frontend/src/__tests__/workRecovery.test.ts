import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type WorkRecoveryEntry } from "../services/NativeBridge";
import { aiRecoveryProblem, importRecoveredAudio, restartRecoveredAI, resumeRecoveredAIImport } from "../services/workRecovery";
import { cancelAITrackJob } from "../services/aiTrackJobs";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import { sourceClipIdentity } from "../utils/sourceClipIdentity";
import { parseValidatedProject } from "../utils/projectValidation";
import { normalizeWorkRecovery } from "../utils/workRecoveryValidation";

const initial = useDAWStore.getState();
const entry: WorkRecoveryEntry = { id: "session/job", kind: "recording", status: "recording", startTime: 2.5 };
const flush = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({ ...initial, tracks: [createDefaultTrack("ai", "AI", "#fff", "ai")] });
  vi.spyOn(nativeBridge, "importMediaFile").mockResolvedValue({ filePath: "copy.wav", duration: 2, sampleRate: 48000, numChannels: 1, format: "wav" });
  vi.spyOn(nativeBridge, "workRecovery").mockImplementation(async action => action === "createAI" ? "next/job" : true);
  vi.spyOn(nativeBridge, "addTrack").mockImplementation(async id => id || "id");
  vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);
});
afterEach(async () => { await cancelAITrackJob("ai"); vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial); });

describe("work recovery", () => {
  it("contains malformed journal display fields and duplicate identities", () => {
    expect(normalizeWorkRecovery([null, { id: {}, kind: "ai" }, { ...entry, duration: "bad", channels: Infinity,
      status: {}, projectName: {}, error: [], startTime: -1 }, entry])).toEqual([
      { id: entry.id, kind: "recording", status: "interrupted" },
    ]);
  });
  it("retains the recovery reminder after native insertion and undo/redo until a durable save", async () => {
    let finish!: (accepted: boolean) => void;
    vi.mocked(nativeBridge.addPlaybackClip).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = importRecoveredAudio(entry, "repair.wav");
    await flush();
    expect(nativeBridge.workRecovery).not.toHaveBeenCalled();
    commandManager.undo(); commandManager.redo();
    vi.mocked(nativeBridge.addPlaybackClip).mockResolvedValue(true);
    finish(true);
    await pending; await flush();
    expect(nativeBridge.addTrack).toHaveBeenCalledTimes(2);
    expect(nativeBridge.removeTrack).toHaveBeenCalledTimes(1);
    expect(nativeBridge.workRecovery).not.toHaveBeenCalled();
  });
  it("retains the reminder if native mounting rejects the audio", async () => {
    vi.mocked(nativeBridge.addPlaybackClip).mockResolvedValue(false);
    await expect(importRecoveredAudio(entry, "repair.wav")).rejects.toThrow(/rejected/);
    expect(nativeBridge.workRecovery).not.toHaveBeenCalled();
    commandManager.undo(); await flush();
    vi.mocked(nativeBridge.addPlaybackClip).mockResolvedValue(true);
    await importRecoveredAudio(entry, "repair.wav");
  });
  it("imports a recording and its new track in one undoable operation", async () => {
    await importRecoveredAudio(entry, "repair.wav");
    expect(useDAWStore.getState().tracks).toHaveLength(2);
    expect(useDAWStore.getState().tracks[1].clips[0]).toMatchObject({ recoveryJobId: entry.id, startTime: 2.5, duration: 2 });
    commandManager.undo(); await flush();
    expect(useDAWStore.getState().tracks).toHaveLength(1);
    commandManager.redo(); await flush();
    expect(useDAWStore.getState().tracks).toHaveLength(2);
    expect(nativeBridge.removeTrack).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate imports while the unsaved recovery reminder is retained", async () => {
    vi.mocked(nativeBridge.workRecovery).mockResolvedValue(false);
    await importRecoveredAudio(entry, "repair.wav", "ai");
    await expect(importRecoveredAudio(entry, "repair.wav", "ai")).rejects.toThrow(/already/);
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(1);
  });
  it("rejects a changed document while media preparation is pending", async () => {
    vi.mocked(nativeBridge.importMediaFile).mockImplementation(async () => {
      advanceProjectEpoch();
      return { filePath: "copy.wav", duration: 2, sampleRate: 48000, numChannels: 1, format: "wav" };
    });
    await expect(importRecoveredAudio(entry, "repair.wav")).rejects.toThrow(/project changed/);
    expect(useDAWStore.getState().tracks).toHaveLength(1);
    expect(nativeBridge.workRecovery).not.toHaveBeenCalled();
  });
  it("restores continuation placement through the original source workflow", async () => {
    const source = { id: "source", filePath: "source.wav", name: "Bass", color: "#fff", startTime: 5, duration: 3, offset: 0, volumeDB: 0, fadeIn: 0, fadeOut: 0, sampleRate: 48000 };
    useDAWStore.setState(current => ({ tracks: [{ ...current.tracks[0], clips: [source] }] }));
    const ai: WorkRecoveryEntry = { ...entry, kind: "ai", status: "completed", projectId: initial.projectPersistentId,
      trackId: "ai", modelId: "stable-audio-3-medium", workflowId: "continue-clip", params: { seed: 22 },
      sourceClipId: source.id, sourceIdentity: sourceClipIdentity(source), extensionDuration: 1, outputFile: "generated.wav" };
    expect(aiRecoveryProblem(ai)).toBeNull();
    await resumeRecoveredAIImport(ai);
    expect(nativeBridge.workRecovery).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks[0].clips[1]).toMatchObject({ startTime: 8, duration: 1, recoveryJobId: entry.id });
    commandManager.undo();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(1);
  });
  it("blocks stale-source AI recovery without launching any worker", () => {
    expect(aiRecoveryProblem({ ...entry, kind: "ai", projectId: "another", trackId: "ai" })).toMatch(/original project/);
    expect(aiRecoveryProblem({ ...entry, kind: "ai", projectId: initial.projectPersistentId, trackId: "ai", sourceClipId: "gone" })).toMatch(/source clip/);
  });
  it("restarts with the saved seed and remains cancellable through the normal track controls", async () => {
    vi.spyOn(nativeBridge, "startAIGeneration").mockResolvedValue({ started: true, requestId: "restart" });
    vi.spyOn(nativeBridge, "getAIGenerationProgress").mockResolvedValue({ state: "generating", progress: 0.1, requestId: "restart" });
    vi.spyOn(nativeBridge, "cancelAIGeneration").mockResolvedValue(undefined);
    const ai: WorkRecoveryEntry = { ...entry, kind: "ai", projectId: initial.projectPersistentId, trackId: "ai",
      modelId: "stable-audio-3-medium", workflowId: "text-to-audio", params: { seed: 123, prompt: "Bass" } };
    expect(await restartRecoveredAI(ai)).toBe(true);
    expect(nativeBridge.startAIGeneration).toHaveBeenCalledWith("ai", ai.modelId, ai.workflowId, expect.objectContaining({ seed: 123, _openStudioRecoveryId: "next/job" }));
    await cancelAITrackJob("ai");
    expect(nativeBridge.cancelAIGeneration).toHaveBeenCalledWith("restart");
    expect(nativeBridge.workRecovery).toHaveBeenCalledWith("updateAI", "next/job", { status: "cancelled" });
  });
  it("round-trips recovery identities in a project without changing its schema version", () => {
    const data = parseValidatedProject(JSON.stringify({ version: "1.2.0", projectPersistentId: initial.projectPersistentId,
      tracks: [{ ...initial.tracks[0], id: "a", clips: [{ id: "clip", recoveryJobId: entry.id, startTime: 2, duration: 1 }] }] }));
    expect(data.projectPersistentId).toBe(initial.projectPersistentId);
    expect(parseValidatedProject(JSON.stringify(data))).toEqual(data);
  });
});
