import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultTrack, resetSyncCache, useDAWStore, type AudioClip } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { crossfadeGainAtTime } from "../utils/clipCrossfades";
import type { ProjectRateCopyResult } from "../services/NativeBridge";

const initial = useDAWStore.getState();
const clip = (id: string, startTime: number, duration: number): AudioClip => ({
  id, name: id, filePath: `C:/${id}.wav`, startTime, duration, offset: 0,
  sampleRate: 48000, color: "#abc", volumeDB: 0, fadeIn: 0, fadeOut: 0,
});
beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({ ...initial, globalLocked: false, autoCrossfade: false,
    lockSettings: { ...initial.lockSettings, items: false }, selectedClipIds: [], tracks: [],
    syncClipsWithBackend: vi.fn().mockResolvedValue(undefined) });
});
afterEach(async () => { await resetSyncCache(); useDAWStore.setState(initial); commandManager.clear(); vi.restoreAllMocks(); });

it("can remove a selected crossfade after splitting a member", () => {
  useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "T"),
    clips: [clip("bed", 0, 10), clip("insert", 2, 2)] }], selectedClipIds: ["bed", "insert"] });
  expect(useDAWStore.getState().crossfadeSelectedClips()).toBe(true);
  useDAWStore.getState().splitClipAtPosition("bed", 1);
  const ids = useDAWStore.getState().tracks[0].clips.map(item => item.id);
  expect(useDAWStore.getState().clearClipCrossfades(ids)).toBe(true);
  expect(useDAWStore.getState().tracks[0].clips.every(item => !item.crossfadeLayers?.length)).toBe(true);
});

it("replanning an expanded crossfade selection preserves unity linear handoffs", () => {
  useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "T"),
    clips: [clip("a", 0, 6), clip("b", 2, 6), clip("c", 4, 6)] }], selectedClipIds: ["a", "b"] });
  expect(useDAWStore.getState().crossfadeSelectedClips()).toBe(true);
  useDAWStore.setState({ selectedClipIds: ["a", "b", "c"] });
  expect(useDAWStore.getState().crossfadeSelectedClips()).toBe(true);
  const gain = useDAWStore.getState().tracks[0].clips.reduce((sum, item) =>
    sum + crossfadeGainAtTime(item, 5 - item.startTime), 0);
  expect(gain).toBeCloseTo(1, 6);
});

it.each([false, true])("creates a project-rate copy without changing muted=%s", async muted => {
  await resetSyncCache();
  const published = new Map<string, string>();
  vi.spyOn(nativeBridge, "clearPlaybackClips").mockImplementation(async () => { published.clear(); return true; });
  vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockImplementation(async clips => {
    for (const item of clips) published.set(item.clipId!, item.filePath);
    return true;
  });
  // Mirror the native source replacement's required existing ID/path match.
  vi.spyOn(nativeBridge, "replacePlaybackClipSource").mockImplementation(async (_track, id, expected, replacement) => {
    if (published.get(id) !== expected) return false;
    published.set(id, replacement); return true;
  });
  vi.spyOn(nativeBridge, "createProjectRateCopy").mockResolvedValue({ success: true,
    filePath: "C:/converted.wav", sampleRate: 44100, duration: 10, numChannels: 2 });
  vi.spyOn(nativeBridge, "refreshWaveformPeaks").mockResolvedValue(true);
  useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "T"), clips: [{ ...clip("a", 0, 10), muted }] }],
    projectSampleRate: 44100, audioConversionJobs: {}, showToast: vi.fn(),
    syncClipsWithBackend: initial.syncClipsWithBackend });
  await useDAWStore.getState().syncClipsWithBackend();
  await useDAWStore.getState().createProjectRateCopy("t", "a");
  expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ filePath: "C:/converted.wav", muted });
});

async function publicationFixture(muted = false) {
  await resetSyncCache();
  const published = new Map<string, string>();
  vi.spyOn(nativeBridge, "clearPlaybackClips").mockImplementation(async () => { published.clear(); return true; });
  vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockImplementation(async clips => {
    for (const item of clips) published.set(item.clipId!, item.filePath);
    return true;
  });
  vi.spyOn(nativeBridge, "removePlaybackClipById").mockImplementation(async (_track, id) => { published.delete(id); return true; });
  vi.spyOn(nativeBridge, "replacePlaybackClipSource").mockImplementation(async (_track, id, expected, replacement) => {
    if (published.get(id) !== expected) return false;
    published.set(id, replacement); return true;
  });
  vi.spyOn(nativeBridge, "createProjectRateCopy").mockResolvedValue({ success: true,
    filePath: "C:/converted.wav", sampleRate: 44100, duration: 10, numChannels: 2 });
  vi.spyOn(nativeBridge, "refreshWaveformPeaks").mockResolvedValue(true);
  useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "T"), clips: [{ ...clip("a", 0, 10), muted }] }],
    projectSampleRate: 44100, audioConversionJobs: {}, showToast: vi.fn(), syncClipsWithBackend: initial.syncClipsWithBackend });
  await useDAWStore.getState().syncClipsWithBackend();
  return published;
}

it("publishes the latest rapid source Undo/Redo intent, including mute and unmute", async () => {
  const published = await publicationFixture(true);
  await useDAWStore.getState().createProjectRateCopy("t", "a");
  expect(published.size).toBe(0);
  commandManager.undo(); commandManager.redo(); commandManager.undo();
  await useDAWStore.getState().syncClipsWithBackend();
  expect(useDAWStore.getState().tracks[0].clips[0].filePath).toBe("C:/a.wav");
  expect(published.size).toBe(0);
  commandManager.redo();
  useDAWStore.getState().toggleClipMute("a");
  await useDAWStore.getState().syncClipsWithBackend();
  expect(published.get("a")).toBe("C:/converted.wav");
});

it.each(["mute", "changeSource", "delete"])("reconciles a %s while native source publication is pending", async change => {
  const published = await publicationFixture();
  let finish!: () => void;
  vi.mocked(nativeBridge.replacePlaybackClipSource).mockImplementationOnce(async (_track, id, _expected, replacement) => {
    await new Promise<void>(resolve => { finish = resolve; });
    published.set(id, replacement); return true;
  });
  const converting = useDAWStore.getState().createProjectRateCopy("t", "a");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  if (change === "mute") useDAWStore.getState().toggleClipMute("a");
  else useDAWStore.setState({ tracks: useDAWStore.getState().tracks.map(track => ({ ...track,
    clips: change === "delete" ? [] : track.clips.map(item => ({ ...item, filePath: "C:/other.wav" })) })) });
  finish(); await converting; await useDAWStore.getState().syncClipsWithBackend();
  if (change === "mute") {
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ muted: true, filePath: "C:/converted.wav" });
    expect(published.size).toBe(0);
  } else {
    expect(published.get("a")).toBe(change === "delete" ? undefined : "C:/other.wav");
    expect(commandManager.getUndoStack().some(command => command.type === "CREATE_PROJECT_RATE_COPY")).toBe(false);
  }
});

it("uses current publication state when a muted source is unmuted during conversion", async () => {
  const published = await publicationFixture(true);
  let finish!: (value: ProjectRateCopyResult) => void;
  vi.mocked(nativeBridge.createProjectRateCopy).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const converting = useDAWStore.getState().createProjectRateCopy("t", "a");
  useDAWStore.getState().toggleClipMute("a");
  await useDAWStore.getState().syncClipsWithBackend();
  expect(published.get("a")).toBe("C:/a.wav");
  finish({ success: true, filePath: "C:/converted.wav", sampleRate: 44100, duration: 10, numChannels: 2 });
  await converting;
  expect(published.get("a")).toBe("C:/converted.wav");
  expect(useDAWStore.getState().tracks[0].clips[0].muted).toBe(false);
});

it("reads a muted tempo source without adding it to playback and rejects stale analysis", async () => {
  const published = await publicationFixture(true);
  let finish!: (value: Awaited<ReturnType<typeof nativeBridge.analyzeClipTempo>>) => void;
  const analyze = vi.spyOn(nativeBridge, "analyzeClipTempo").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  useDAWStore.getState().openTempoDetection("t", "a");
  const pending = useDAWStore.getState().analyzeTempoDetectionTarget(1, 5, "analysis-test");
  expect(analyze).toHaveBeenCalledWith("t", "a", 1, 5, expect.objectContaining({ filePath: "C:/a.wav", duration: 10, offset: 0 }), "analysis-test");
  expect(published.size).toBe(0);
  useDAWStore.getState().removeClip("t", "a");
  finish({ bpm: 120, confidence: 1, beatOffsetSeconds: 0, candidates: [], source: "audio" });
  expect((await pending).error).toMatch(/changed/);
});
