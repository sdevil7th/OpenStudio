import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { capturePitchFXOrigin, reviewPitchFXEditorEntry, type PitchFXOrigin } from "../services/pitchEditorFXEntry";
import { createDefaultTrack, useDAWStore, type AudioClip } from "../store/useDAWStore";
import { usePitchEditorStore } from "../store/pitchEditorStore";
import { advanceProjectEpoch, getProjectEpoch } from "../utils/projectLifetime";
import { getPitchClipChoices, getPitchPlaybackRoutes, getSelectedPitchClip, isPitchCorrectFX, resolvePitchClipTarget } from "../utils/pitchEditorEntry";

const original = useDAWStore.getState();
const audio = (id: string): AudioClip => ({ id, name: id, filePath: `C:/${id}.wav`, startTime: 1, duration: 2, offset: 0, color: "#fff", volumeDB: 0, fadeIn: 0, fadeOut: 0 });
const pitch = (index = 0, bypassed = false) => ({ index, bypassed, type: "builtin", name: "OpenStudio Pitch Correct" });
const origin: PitchFXOrigin = { trackId: "a", chain: "track", fxIndex: 0, instanceId: "pitch-instance" };
const target = { trackId: "a", clipId: "a2" };
const fixture = () => ({
  tracks: [{ ...createDefaultTrack("a", "Vocal"), clips: [audio("a1"), audio("a2")] },
    { ...createDefaultTrack("b", "Double"), clips: [audio("b1")] }],
  globalLocked: false,
  lockSettings: { ...original.lockSettings, items: false },
  selectedClipId: "a2", selectedClipIds: ["a2"],
});

beforeEach(() => {
  useDAWStore.setState({ ...fixture(), showPitchEditor: false, pitchEditorTrackId: null, pitchEditorClipId: null });
  vi.spyOn(nativeBridge, "resolveBuiltInAddress").mockImplementation(async address => address);
  vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([pitch()]);
  vi.spyOn(nativeBridge, "getMasterFX").mockResolvedValue([]);
  vi.spyOn(nativeBridge, "fileExists").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "pitchEditorSession").mockResolvedValue({ state: "closed" });
});
afterEach(() => { useDAWStore.setState(original); vi.restoreAllMocks(); });

describe("Pitch Correct clip choice", () => {
  it("uses the explicit selected audio clip instead of the first clip", () => {
    expect(getSelectedPitchClip(fixture(), "a", "track")).toEqual(target);
  });
  it("requires a choice for absent, multiple and other-track selections", () => {
    const state = fixture();
    for (const ids of [[], ["a1", "a2"], ["b1"], ["deleted"], ["midi-note-clip"]]) {
      expect(getSelectedPitchClip({ ...state, selectedClipId: ids[0] || null, selectedClipIds: ids }, "a", "track")).toBeNull();
    }
  });
  it("requires explicit recorded audio choice for input and master FX even with a selection", () => {
    expect(getSelectedPitchClip(fixture(), "a", "input")).toBeNull();
    expect(getSelectedPitchClip(fixture(), "a", "master")).toBeNull();
    expect(getPitchClipChoices(fixture())).toHaveLength(3);
    expect(getPitchClipChoices(fixture(), "a")).toHaveLength(2);
  });
  it("rejects stale, locked, frozen, failed, unfinished and invalid targets", () => {
    const state = fixture();
    expect(resolvePitchClipTarget(state, { ...target, clipId: "missing" })).toBeNull();
    expect(resolvePitchClipTarget({ ...state, globalLocked: true }, target)).toBeNull();
    expect(resolvePitchClipTarget({ ...state, lockSettings: { items: true } }, target)).toBeNull();
    state.tracks[0].frozen = true;
    expect(resolvePitchClipTarget(state, target)).toBeNull();
    state.tracks[0].frozen = false;
    for (const override of [{ locked: true }, { filePath: "" }, { duration: 0 }, { offset: -1 }, { importStatus: "failed" as const }, { importStatus: "preparingPlayback" as const }]) {
      state.tracks[0].clips[1] = { ...audio("a2"), ...override };
      expect(resolvePitchClipTarget(state, target)).toBeNull();
    }
  });
  it("recognizes only the built-in effect, not unrelated plugin names", () => {
    expect(isPitchCorrectFX(pitch())).toBe(true);
    expect(isPitchCorrectFX({ name: "OpenStudio Pitch Correct", type: "vst3" })).toBe(false);
    expect(isPitchCorrectFX({ name: "Pitch Corrector", type: "builtin" })).toBe(false);
  });
  it("traverses enabled audible send routes and terminates cycles", () => {
    const state = fixture();
    const send = (destTrackId: string, enabled = true, level = 1) => ({ destTrackId, enabled, level, preFader: false, pan: 0, phaseInvert: false });
    state.tracks[0].masterSendEnabled = false;
    state.tracks[0].sends = [send("b"), send("disabled", false), send("silent", true, 0)];
    state.tracks[1].sends = [send("a")];
    expect(getPitchPlaybackRoutes(state.tracks, "a")).toEqual({ trackIds: ["a", "b"], master: true });
  });
});

describe("Pitch Correct entry safety", () => {
  it("captures the native instance identity before presenting a clip choice", async () => {
    vi.spyOn(nativeBridge, "getBuiltInPluginSchema").mockResolvedValue({ name: pitch().name, pluginId: "pitch", instanceId: "stable-id" } as never);
    expect((await capturePitchFXOrigin({ ...origin, instanceId: undefined })).instanceId).toBe("stable-id");
  });
  it("rejects replacement between the listed instance and the first schema read", async () => {
    vi.spyOn(nativeBridge, "getBuiltInPluginSchema").mockResolvedValue({ name: pitch().name, pluginId: "pitch", instanceId: "replacement-id" } as never);
    await expect(capturePitchFXOrigin(origin)).rejects.toThrow("replaced");
  });
  it("follows a reordered origin and reports active correction without changing effect state", async () => {
    vi.mocked(nativeBridge.resolveBuiltInAddress).mockResolvedValue({ ...origin, fxIndex: 3 });
    vi.mocked(nativeBridge.getTrackFX).mockResolvedValue([pitch(3)]);
    const bypass = vi.spyOn(nativeBridge, "bypassTrackFX");
    const setState = vi.spyOn(nativeBridge, "setBuiltInPluginState");
    const result = await reviewPitchFXEditorEntry(origin, target, getProjectEpoch());
    expect(result.activeEffects).toEqual(["Vocal · FX 4"]);
    expect(bypass).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
  it("reports downstream bus and master correction, ignoring bypassed effects", async () => {
    const state = fixture();
    state.tracks[0].fxBypassed = true;
    state.tracks[0].sends = [{ destTrackId: "b", enabled: true, level: 1, pan: 0, preFader: false, phaseInvert: false }];
    useDAWStore.setState(state);
    vi.mocked(nativeBridge.getTrackFX).mockImplementation(async id => id === "a" ? [pitch()] : [pitch(1), pitch(2, true)]);
    vi.mocked(nativeBridge.getMasterFX).mockResolvedValue([pitch(2)]);
    expect((await reviewPitchFXEditorEntry(origin, target, getProjectEpoch())).activeEffects).toEqual(["Double · FX 2", "Master · FX 3"]);
  });
  it("rejects a removed FX instance or missing source audio", async () => {
    vi.mocked(nativeBridge.resolveBuiltInAddress).mockRejectedValueOnce(new Error("instance removed"));
    await expect(reviewPitchFXEditorEntry(origin, target, getProjectEpoch())).rejects.toThrow("removed");
    vi.mocked(nativeBridge.fileExists).mockResolvedValue(false);
    await expect(reviewPitchFXEditorEntry(origin, target, getProjectEpoch())).rejects.toThrow("source audio");
  });
  it("does not open a removed or locked clip after asynchronous route checks", async () => {
    vi.mocked(nativeBridge.fileExists).mockImplementation(async () => {
      useDAWStore.setState(s => ({ tracks: s.tracks.map(t => ({ ...t, clips: t.clips.filter(c => c.id !== target.clipId) })) }));
      return true;
    });
    await expect(reviewPitchFXEditorEntry(origin, target, getProjectEpoch())).rejects.toThrow("clip changed");
  });
  it("invalidates a pending entry on project replacement", async () => {
    vi.mocked(nativeBridge.fileExists).mockImplementation(async () => { advanceProjectEpoch(); return true; });
    await expect(reviewPitchFXEditorEntry(origin, target, getProjectEpoch())).rejects.toThrow("project changed");
  });
  it("invalidates a pending entry when its routing changes", async () => {
    vi.mocked(nativeBridge.fileExists).mockImplementation(async () => {
      useDAWStore.setState(s => ({ tracks: s.tracks.map(t => ({ ...t, masterSendEnabled: false })) }));
      return true;
    });
    await expect(reviewPitchFXEditorEntry(origin, target, getProjectEpoch())).rejects.toThrow("routing changed");
  });
  it("the shared context-menu/FX action refuses a missing or locked target before changing editor state", () => {
    const open = vi.spyOn(usePitchEditorStore.getState(), "open").mockImplementation(() => {});
    const toast = vi.spyOn(useDAWStore.getState(), "showToast").mockImplementation(() => {});
    useDAWStore.getState().openPitchEditor("a", "deleted", -1);
    useDAWStore.setState({ globalLocked: true });
    useDAWStore.getState().openPitchEditor("a", "a2", -1);
    expect(open).not.toHaveBeenCalled();
    expect(useDAWStore.getState().showPitchEditor).toBe(false);
    expect(toast).toHaveBeenCalledTimes(2);
  });
  it("the shared action opens the same store and does not refocus a session closed during native status read", async () => {
    let finish!: (value: { state: "visible" }) => void;
    vi.mocked(nativeBridge.pitchEditorSession).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const open = vi.spyOn(usePitchEditorStore.getState(), "open").mockImplementation(() => {});
    useDAWStore.getState().openPitchEditor("a", "a2", -1);
    expect(open).toHaveBeenCalledWith("a", "a2", -1);
    useDAWStore.setState({ showPitchEditor: false });
    finish({ state: "visible" });
    await Promise.resolve();
    expect(nativeBridge.pitchEditorSession).toHaveBeenCalledTimes(1);
  });
});
