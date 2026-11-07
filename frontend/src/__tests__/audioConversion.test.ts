import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type MediaFileInfo, type ProjectRateCopyResult } from "../services/NativeBridge";
import { audioConversionActions, prepareImportedProjectRateCopy } from "../store/actions/audioConversion";
import { commandManager } from "../store/commands";
import { resetSyncCache } from "../store/actions/clips";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import type { DAWActions, DAWState } from "../store/useDAWStore";
vi.mock("../store/useDAWStore", () => ({
  createDefaultTrack: vi.fn(),
  useDAWStore: { getState: vi.fn(), setState: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

function fixture() {
  const clip = { id: "clip", filePath: "C:/audio/source.wav", name: "Take", startTime: 12.5,
    duration: 0.8, offset: 0.2, sourceLength: 1.5, sampleRate: 48000, color: "red", volumeDB: -3,
    fadeIn: 0.1, fadeOut: 0.2, fadeInShape: 1, fadeOutShape: 2,
    gainEnvelope: [{ time: 0, gain: 0.5 }, { time: 0.8, gain: 1 }] };
  let state = { tracks: [{ id: "track", clips: [clip], midiClips: [] }], projectSampleRate: 44100,
    projectPath: "C:/project/song.osproj", showPitchEditor: false, audioConversionJobs: {},
    showToast: vi.fn(), syncClipsWithBackend: vi.fn().mockResolvedValue(undefined), isModified: false } as unknown as DAWState & DAWActions;
  const get = () => state;
  const set = (patch: object | ((previous: typeof state) => object)) => {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  };
  Object.assign(state, audioConversionActions(set, get));
  return { get, set, clip };
}
const converted: ProjectRateCopyResult = { success: true, filePath: "C:/project/Audio/RateCopies/44100.wav",
  sampleRate: 44100, duration: 1.5, numChannels: 2, originalSourceFilePath: "C:/project/Audio/RateCopies/44100.wav" };
const info: MediaFileInfo = { filePath: "C:/audio/source.wav", sampleRate: 48000, duration: 1.5, numChannels: 2, format: "WAV" };

beforeEach(async () => {
  commandManager.clear(); await resetSyncCache();
  vi.spyOn(nativeBridge, "createProjectRateCopy").mockResolvedValue(converted);
  vi.spyOn(nativeBridge, "replacePlaybackClipSource").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "cancelProjectRateCopy").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "refreshWaveformPeaks").mockResolvedValue(true);
});
afterEach(async () => { await resetSyncCache(); vi.restoreAllMocks(); commandManager.clear(); });

describe("project-rate source copies", () => {
  it("preserves seconds, gains and fades and restores source fields through Undo/Redo", async () => {
    const { get, clip } = fixture();
    await get().createProjectRateCopy("track", "clip");
    const after = get().tracks[0].clips[0];
    expect(after).toMatchObject({ ...clip, filePath: converted.filePath, sampleRate: 44100, originalFilePath: clip.filePath });
    expect(nativeBridge.replacePlaybackClipSource).toHaveBeenCalledWith("track", "clip", clip.filePath,
      converted.filePath, converted.filePath, clip.offset);
    expect(commandManager.serialize().undoStack).toHaveLength(1);
    commandManager.undo();
    await vi.waitFor(() => expect(get().tracks[0].clips[0].filePath).toBe(clip.filePath));
    commandManager.redo();
    await vi.waitFor(() => expect(get().tracks[0].clips[0].filePath).toBe(converted.filePath));
    expect(get().tracks[0].clips[0].offset).toBe(clip.offset);
    expect(get().audioConversionJobs).toEqual({});
  });

  it("carries a separately converted immutable pitch source and its offset", async () => {
    const { get } = fixture();
    Object.assign(get().tracks[0].clips[0], { pitchCorrectionSourceFilePath: "C:/audio/immutable.wav", pitchCorrectionSourceOffset: 0.7 });
    vi.mocked(nativeBridge.createProjectRateCopy).mockResolvedValue({ ...converted, originalSourceFilePath: "C:/project/Audio/RateCopies/original44100.wav" });
    await get().createProjectRateCopy("track", "clip");
    expect(get().tracks[0].clips[0]).toMatchObject({ pitchCorrectionSourceFilePath: "C:/project/Audio/RateCopies/original44100.wav", pitchCorrectionSourceOffset: 0.7, offset: 0.2 });
  });

  it("does not replace a clip after cancellation or a project epoch change", async () => {
    for (const changeEpoch of [false, true]) {
      const { get } = fixture();
      let finish!: (value: ProjectRateCopyResult) => void;
      vi.mocked(nativeBridge.createProjectRateCopy).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = get().createProjectRateCopy("track", "clip");
      if (changeEpoch) advanceProjectEpoch(); else get().cancelProjectRateCopy("clip");
      finish(converted); await pending;
      expect(get().tracks[0].clips[0].filePath).toBe(info.filePath);
    }
    expect(nativeBridge.replacePlaybackClipSource).not.toHaveBeenCalled();
    expect(commandManager.canUndo()).toBe(false);
  });

  it("ignores completed conversion when the source geometry changed", async () => {
    const { get } = fixture();
    let finish!: (value: ProjectRateCopyResult) => void;
    vi.mocked(nativeBridge.createProjectRateCopy).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = get().createProjectRateCopy("track", "clip");
    get().tracks[0].clips[0].offset = 0.3; finish(converted); await pending;
    expect(nativeBridge.replacePlaybackClipSource).not.toHaveBeenCalled();
    expect(get().tracks[0].clips[0].offset).toBe(0.3);
  });

  it("retains original import on conversion failure and aborts a removed target", async () => {
    const { get, set } = fixture();
    vi.mocked(nativeBridge.createProjectRateCopy).mockRejectedValueOnce(new Error("runtime unavailable"));
    expect(await prepareImportedProjectRateCopy(set, get, "track", "clip", info, () => true)).toEqual(info);
    await expect(prepareImportedProjectRateCopy(set, get, "track", "clip", info, () => false)).rejects.toMatchObject({ name: "AbortError" });
    expect(commandManager.canUndo()).toBe(false);
  });

  it("prepares import media without adding another Undo and preserves musical duration", async () => {
    const { get, set } = fixture();
    vi.mocked(nativeBridge.createProjectRateCopy).mockResolvedValue({ ...converted, duration: 1.50001 });
    const ready = await prepareImportedProjectRateCopy(set, get, "track", "clip", info, () => true);
    expect(ready).toMatchObject({ filePath: converted.filePath, sampleRate: 44100, duration: info.duration, numChannels: 2, originalFilePath: info.filePath });
    expect(commandManager.canUndo()).toBe(false);
  });
});
