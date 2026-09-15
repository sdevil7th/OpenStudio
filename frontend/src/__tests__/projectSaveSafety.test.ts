import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useDAWStore.getState();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

describe("project save concurrency and recovery", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState({ ...initial, projectPath: "C:/session.osproj", projectName: "Before",
      tracks: [createDefaultTrack("track", "Track", "#fff", "audio")], isModified: true });
    vi.spyOn(nativeBridge, "getNAMLibrary").mockResolvedValue({ installed: [] } as any);
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getMasterFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getMIDILearnMappings").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "setRecentProjects").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "saveProjectToFile").mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initial);
  });
  it("clears dirty only for the document actually saved", async () => {
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    expect(useDAWStore.getState().isModified).toBe(false);
  });
  it("persists a named mixer snapshot in the project payload", async () => {
    useDAWStore.getState().saveMixerSnapshot("Field mix");
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.mixerSnapshots).toEqual(useDAWStore.getState().mixerSnapshots);
    expect(saved.mixerSnapshots[0].name).toBe("Field mix");
  });
  it("never persists click-only playback or its pending/error state", async () => {
    useDAWStore.setState({ metronomePracticeEnabled: true, metronomePracticePending: true,
      metronomePracticeError: "runtime only" });
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved).not.toHaveProperty("metronomePracticeEnabled");
    expect(saved).not.toHaveProperty("metronomePracticePending");
    expect(saved).not.toHaveProperty("metronomePracticeError");
  });
  it("stops click-only playback before native project teardown", async () => {
    const stopPractice = vi.spyOn(nativeBridge, "setMetronomePracticeEnabled").mockResolvedValue(true);
    const closeEditors = vi.spyOn(nativeBridge, "closeAllPluginWindows").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [], metronomePracticeEnabled: true });
    expect(await useDAWStore.getState().newProject()).toBe(true);
    expect(stopPractice).toHaveBeenCalledWith(false);
    expect(stopPractice.mock.invocationCallOrder[0]).toBeLessThan(closeEditors.mock.invocationCallOrder[0]);
    expect(useDAWStore.getState().metronomePracticeEnabled).toBe(false);
  });
  it("does not hide a failed practice stop by resetting the project UI", async () => {
    vi.spyOn(nativeBridge, "setMetronomePracticeEnabled").mockResolvedValue(false);
    const closeEditors = vi.spyOn(nativeBridge, "closeAllPluginWindows");
    useDAWStore.setState({ metronomePracticeEnabled: true });
    const tracks = useDAWStore.getState().tracks;
    expect(await useDAWStore.getState().newProject()).toBe(false);
    expect(closeEditors).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks).toBe(tracks);
    expect(useDAWStore.getState().metronomePracticeEnabled).toBe(true);
  });
  it("does not lose edits made while the file write is pending", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValue(pending.promise);
    const saved = useDAWStore.getState().saveProject();
    await flush();
    useDAWStore.setState({ projectName: "Newer edit", isModified: true });
    pending.resolve(true);
    expect(await saved).toBe(true);
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().projectName).toBe("Newer edit");
  });
  it("tracks native/plugin dirty notifications even when the dirty flag was already true", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValue(pending.promise);
    const saved = useDAWStore.getState().saveProject();
    await flush();
    useDAWStore.getState().setModified(true);
    pending.resolve(true);
    await saved;
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("a backup does not overwrite explicit save state or clear dirty", async () => {
    await useDAWStore.getState().saveProject(false, true);
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledWith("C:/session.osproj", expect.any(String), true, 3, expect.stringMatching(/^[a-f0-9]{32}$/));
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().projectPath).toBe("C:/session.osproj");
  });
  it("never opens a save dialog for an untitled timer backup", async () => {
    const dialog = vi.spyOn(nativeBridge, "showSaveDialog");
    useDAWStore.setState({ projectPath: "" });
    expect(await useDAWStore.getState().saveProject(false, true)).toBe(true);
    expect(dialog).not.toHaveBeenCalled();
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledWith("", expect.any(String), true, 3, expect.stringMatching(/^[a-f0-9]{32}$/));
  });
  it("serializes overlapping saves and snapshots the latest state for the queued save", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValueOnce(pending.promise);
    const first = useDAWStore.getState().saveProject();
    await flush();
    useDAWStore.setState({ projectName: "After" });
    const second = useDAWStore.getState().saveProject();
    await flush();
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await first; await second;
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(nativeBridge.saveProjectToFile).mock.calls;
    expect(JSON.parse(calls[0][1]).projectName).toBe("Before");
    expect(JSON.parse(calls[1][1]).projectName).toBe("After");
  });
  it("a late save cannot change the identity/dirty state of a newly opened project", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValue(pending.promise);
    const saved = useDAWStore.getState().saveProject();
    await flush();
    advanceProjectEpoch();
    useDAWStore.setState({ projectPath: "C:/new.osproj", projectName: "New", isModified: true });
    pending.resolve(true);
    expect(await saved).toBe(false);
    expect(useDAWStore.getState().projectPath).toBe("C:/new.osproj");
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("reports write failure without clearing dirty", async () => {
    vi.mocked(nativeBridge.saveProjectToFile).mockResolvedValue(false);
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(useDAWStore.getState().isModified).toBe(true);
  });
});
