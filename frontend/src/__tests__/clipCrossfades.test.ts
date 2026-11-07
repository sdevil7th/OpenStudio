import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, resetSyncCache, useDAWStore, type AudioClip } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import { cloneTracksForTimelineUndo } from "../store/actions/clipEditing";
import { parseValidatedProject } from "../utils/projectValidation";
import { crossfadeGainAtTime, getClipPlaybackGainEnvelope, interpolateClipGain, planClipCrossfades } from "../utils/clipCrossfades";

const initial = useDAWStore.getState();
const clip = (id: string, startTime: number, duration: number, properties: Partial<AudioClip> = {}): AudioClip => ({
  id, name: id, filePath: `C:/${id}.wav`, startTime, duration, offset: 0, sampleRate: 48000,
  color: "#abc", volumeDB: 0, fadeIn: 0, fadeOut: 0, ...properties,
});
function planned(clips: AudioClip[], options = {}) {
  const plan = planClipCrossfades(clips, options)!;
  expect(plan).not.toBeNull();
  return { plan, clips: clips.map(item => ({ ...item, crossfadeLayers: [plan.layers.get(item.id)!] })) };
}
function gainsAt(clips: AudioClip[], absolute: number) {
  return clips.filter(item => absolute >= item.startTime && absolute < item.startTime + item.duration)
    .map(item => crossfadeGainAtTime(item, absolute - item.startTime));
}
beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({ ...initial, globalLocked: false, lockSettings: { ...initial.lockSettings, items: false },
    selectedClipIds: [], tracks: [], syncClipsWithBackend: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(nativeBridge, "setClipGainEnvelope").mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); useDAWStore.setState(initial); commandManager.clear(); });

describe("general overlap crossfades", () => {
  it("returns to the containing clip through separate entry/exit transitions", () => {
    const { clips, plan } = planned([clip("bed", 0, 10), clip("insert", 2, 2)]);
    expect(plan.transitions).toHaveLength(2);
    expect(plan.transitions.map(item => [item.fromClipId, item.toClipId])).toEqual([["bed", "insert"], ["insert", "bed"]]);
    expect(gainsAt(clips, 1)).toEqual([1]);
    expect(gainsAt(clips, 2.025)).toEqual(expect.arrayContaining([expect.closeTo(0.5, 6)]));
    expect(gainsAt(clips, 3)).toEqual([0, 1]);
    expect(gainsAt(clips, 3.975)).toEqual(expect.arrayContaining([expect.closeTo(0.5, 6)]));
    expect(gainsAt(clips, 5)).toEqual([1]);
  });
  it.each([
    [clip("long", 0, 10), clip("short", 0, 4)],
    [clip("long", 0, 10), clip("short", 6, 4)],
    [clip("a", 0, 10), clip("b", 0, 10)],
    [clip("a", 0, 10), clip("b", 0, 10), clip("c", 0, 10)],
    [clip("bed", 0, 10), clip("b", 2, 2), clip("c", 6, 2)],
    [clip("bed", 0, 10), clip("b", 2, 6), clip("c", 4, 2)],
    [clip("a", 0, 6), clip("b", 2, 6), clip("c", 4, 6)],
  ])("keeps a unity linear gain handoff for same edges, coincident, nested and chained overlaps: %j", (...input) => {
    const { clips } = planned(input as AudioClip[]);
    for (let sample = 1; sample < 10000; sample++) {
      const time = sample / 1000;
      const gains = gainsAt(clips, time);
      if (gains.length) expect(gains.reduce((sum, gain) => sum + gain, 0)).toBeCloseTo(1, 5);
    }
  });
  it("uses complementary equal-power curves with a bounded linear-envelope approximation", () => {
    const { clips } = planned([clip("bed", 0, 10), clip("insert", 2, 2)], { fadeInShape: 1, fadeOutShape: 1 });
    for (let sample = 1; sample < 10000; sample++) {
      const gains = gainsAt(clips, sample / 1000);
      expect(gains.reduce((sum, gain) => sum + gain * gain, 0)).toBeCloseTo(1, 3);
    }
    expect(clips.every(item => getClipPlaybackGainEnvelope(item).length < 1000)).toBe(true);
  });
  it("places short handoffs within the overlap instead of leaving a double-gain middle", () => {
    const { clips, plan } = planned([clip("a", 0, 5), clip("b", 3, 5)], { transitionLength: 0.2 });
    expect(plan.transitions[0]).toMatchObject({ startTime: 3, endTime: 3.2 });
    expect(gainsAt(clips, 3.1)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(0.5, 6)]);
    expect(gainsAt(clips, 4)).toEqual([0, 1]);
  });
  it("preserves manual fades and gain automation and composes at their union breakpoints", () => {
    const base = [{ time: 0, gain: 0.2 }, { time: 1, gain: 1.8 }, { time: 7, gain: 0.4 }];
    const original = [clip("bed", 0, 10, { gainEnvelope: base, fadeIn: 0.4, fadeOut: 0.6, fadeInShape: 3, fadeOutShape: 4 }), clip("insert", 2, 2)];
    const { clips } = planned(original, { fadeInShape: 4, fadeOutShape: 2 });
    expect(clips[0].gainEnvelope).toBe(base);
    expect(clips[0]).toMatchObject({ fadeIn: 0.4, fadeOut: 0.6, fadeInShape: 3, fadeOutShape: 4 });
    const actual = getClipPlaybackGainEnvelope(clips[0]);
    for (let sample = 0; sample <= 10000; sample++) {
      const time = sample / 1000;
      expect(Math.abs(interpolateClipGain(actual, time)
        - interpolateClipGain(base, time) * crossfadeGainAtTime(clips[0], time))).toBeLessThan(0.00015);
    }
    expect(original[0].crossfadeLayers).toBeUndefined();
  });
});

describe("crossfade transactions and retained state", () => {
  function mount() {
    const bed = clip("bed", 0, 10, { gainEnvelope: [{ time: 0, gain: 0.5 }, { time: 10, gain: 1.5 }], fadeIn: 0.3 });
    const insert = clip("insert", 2, 2);
    useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "T"), clips: [bed, insert] }], selectedClipIds: [bed.id, insert.id] });
    return { bed, insert };
  }
  it("applies/replaces/removes as atomic undo steps without repeatedly attenuating the same group", () => {
    const { bed } = mount();
    const state = useDAWStore.getState();
    expect(state.crossfadeSelectedClips()).toBe(true);
    const first = useDAWStore.getState().tracks[0].clips;
    expect(state.crossfadeSelectedClips()).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(state.applyClipCrossfade("bed", "insert", { transitionLength: 0.2, fadeInShape: 1, fadeOutShape: 1 })).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0].crossfadeLayers).toHaveLength(1);
    state.undo();
    expect(useDAWStore.getState().tracks[0].clips).toEqual(first);
    expect(state.clearClipCrossfades(["bed", "insert"])).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ gainEnvelope: bed.gainEnvelope, fadeIn: bed.fadeIn });
    expect(useDAWStore.getState().tracks[0].clips[0].crossfadeLayers).toBeUndefined();
    state.undo();
    expect(useDAWStore.getState().tracks[0].clips).toEqual(first);
  });
  it("opens the complete group from a partial selection and protects locked partners", () => {
    mount(); useDAWStore.getState().crossfadeSelectedClips();
    useDAWStore.setState({ selectedClipIds: ["insert"] });
    expect(useDAWStore.getState().editSelectedCrossfade()).toBe(true);
    expect(useDAWStore.getState().crossfadeSelectedClips()).toBe(false);
    expect(useDAWStore.getState().showCrossfadeEditor).toBe(true);
    const tracks = useDAWStore.getState().tracks;
    useDAWStore.setState({ tracks: tracks.map(track => ({ ...track, clips: track.clips.map(item => item.id === "bed" ? { ...item, locked: true } : item) })) });
    expect(useDAWStore.getState().clearClipCrossfades(["insert"])).toBe(false);
    useDAWStore.setState({ tracks });
    expect(useDAWStore.getState().clearClipCrossfades(["insert"])).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips.every(item => !item.crossfadeLayers?.length)).toBe(true);
  });
  it.each(["duplicate", "copyToPosition", "paste"])("forks a complete crossfade on %s without touching its source", method => {
    mount(); useDAWStore.getState().crossfadeSelectedClips();
    const original = useDAWStore.getState().tracks[0].clips;
    const oldGroup = original[0].crossfadeLayers![0].id;
    if (method === "duplicate") useDAWStore.getState().duplicateSelectedClips();
    else if (method === "copyToPosition") useDAWStore.getState().duplicateClipsToPositions(original.map(item => ({ clipId: item.id, targetTrackId: "t", targetStartTime: item.startTime + 12 })));
    else { useDAWStore.getState().copySelectedClips(); useDAWStore.getState().pasteClips("t", 12); }
    const copies = useDAWStore.getState().tracks[0].clips.filter(item => !["bed", "insert"].includes(item.id));
    expect(copies).toHaveLength(2);
    expect(copies[0].crossfadeLayers![0].id).not.toBe(oldGroup);
    expect(copies[1].crossfadeLayers![0].id).toBe(copies[0].crossfadeLayers![0].id);
    expect(new Set(copies[0].crossfadeLayers![0].memberClipIds)).toEqual(new Set(copies.map(item => item.id)));
    expect(useDAWStore.getState().clearClipCrossfades([copies[0].id])).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips.filter(item => ["bed", "insert"].includes(item.id))).toEqual(original);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.filter(item => !["bed", "insert"].includes(item.id))).toEqual(copies);
  });
  it("keeps a partial duplicate removable without linking it to the original", () => {
    mount(); useDAWStore.getState().crossfadeSelectedClips();
    const original = useDAWStore.getState().tracks[0].clips;
    const id = useDAWStore.getState().duplicateClip("insert")!;
    const copy = useDAWStore.getState().tracks[0].clips.find(item => item.id === id)!;
    expect(copy.crossfadeLayers![0].memberClipIds).toEqual([id]);
    for (let i = 0; i < 100; i++) expect(crossfadeGainAtTime(copy, i / 50)).toBe(crossfadeGainAtTime(original[1], i / 50));
    expect(useDAWStore.getState().clearClipCrossfades([id])).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips.slice(0, 2)).toEqual(original);
  });
  it("maintains actual membership through split, legacy IDs, deletion and save/reopen", () => {
    mount(); useDAWStore.getState().crossfadeSelectedClips();
    const tracks = useDAWStore.getState().tracks;
    useDAWStore.setState({ tracks: tracks.map(track => ({ ...track, clips: track.clips.map(item => ({ ...item,
      crossfadeLayers: item.crossfadeLayers!.map(layer => ({ ...layer, id: "crossfade:bed|insert" })) })) })) });
    useDAWStore.getState().splitClipAtPosition("bed", 3);
    const split = useDAWStore.getState().tracks[0].clips;
    for (const item of split) expect(new Set(item.crossfadeLayers![0].memberClipIds)).toEqual(new Set(split.map(clip => clip.id)));
    useDAWStore.getState().removeClip("t", "insert");
    const document = parseValidatedProject(JSON.stringify({ version: "1.2.0", tracks: useDAWStore.getState().tracks }));
    useDAWStore.setState({ tracks: document.tracks as unknown as typeof tracks });
    expect(useDAWStore.getState().clearClipCrossfades([split.find(item => item.id !== "insert")!.id])).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips.every(item => !item.crossfadeLayers?.length)).toBe(true);
  });
  it("survives legacy/new project parsing and snapshot cloning without aliasing, and Compare sees the change", async () => {
    const { bed, insert } = mount();
    const previous = JSON.stringify({ version: "1.2.0", tracks: [{ ...createDefaultTrack("t", "T"), clips: [bed, insert] }] });
    expect((parseValidatedProject(previous).tracks[0].clips as AudioClip[])[0].crossfadeLayers).toBeUndefined();
    useDAWStore.getState().crossfadeSelectedClips();
    const tracks = useDAWStore.getState().tracks;
    const document = parseValidatedProject(JSON.stringify({ version: "1.2.0", tracks }));
    expect(document.version).toBe("1.2.0");
    expect(parseValidatedProject(JSON.stringify(document))).toEqual(document);
    const snapshot = cloneTracksForTimelineUndo(tracks);
    snapshot[0].clips[0].crossfadeLayers[0].points[0].gain = 0;
    expect(tracks[0].clips[0].crossfadeLayers![0].points[0].gain).toBe(1);
    useDAWStore.setState({ projectPath: "C:/example.osproj" });
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(previous);
    await useDAWStore.getState().compareWithSavedProject();
    expect(useDAWStore.getState().projectCompareData?.clipsDiff).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bed", details: expect.stringContaining("crossfade handoffs changed") }),
    ]));
  });
  it("retains crossfade gain through trim/untrim, move, split and undo", async () => {
    mount();
    useDAWStore.getState().crossfadeSelectedClips();
    const original = useDAWStore.getState().tracks[0].clips[0];
    const gain = (item: AudioClip, time: number) => crossfadeGainAtTime(item, time);
    useDAWStore.getState().resizeClip("bed", 1, 8, 1);
    const trimmed = useDAWStore.getState().tracks[0].clips[0];
    expect(gain(trimmed, 1.025)).toBeCloseTo(gain(original, 2.025), 6);
    useDAWStore.getState().resizeClip("bed", 0, 10, 0);
    expect(gain(useDAWStore.getState().tracks[0].clips[0], 2.025)).toBeCloseTo(gain(original, 2.025), 6);
    const target = createDefaultTrack("target", "Target");
    useDAWStore.setState({ tracks: [...useDAWStore.getState().tracks, target], autoCrossfade: false });
    await useDAWStore.getState().moveClipToTrack("bed", "target", 20);
    expect(gain(useDAWStore.getState().tracks[1].clips[0], 2.025)).toBeCloseTo(gain(original, 2.025), 6);
    useDAWStore.getState().undo();
    useDAWStore.setState({ selectedClipIds: ["bed"] });
    useDAWStore.getState().splitClipAtPosition("bed", 3);
    const children = useDAWStore.getState().tracks[0].clips.filter(item => item.id !== "insert");
    expect(children).toHaveLength(2);
    for (const child of children) for (let sample = 0; sample < 30; sample++) {
      const time = child.duration * sample / 30;
      expect(gain(child, time)).toBeCloseTo(gain(original, child.startTime + time), 6);
    }
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.find(item => item.id === "bed")?.crossfadeLayers).toEqual(original.crossfadeLayers);
  });
  it("publishes composed envelopes and explicitly restores the native base/empty envelopes on Undo", async () => {
    const { bed } = mount();
    await resetSyncCache();
    vi.spyOn(nativeBridge, "clearPlaybackClips").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockResolvedValue(true);
    useDAWStore.setState({ syncClipsWithBackend: initial.syncClipsWithBackend });
    useDAWStore.getState().crossfadeSelectedClips();
    await vi.waitFor(() => expect(nativeBridge.setClipGainEnvelope).toHaveBeenCalledTimes(2));
    const insertEnvelope = vi.mocked(nativeBridge.setClipGainEnvelope).mock.calls.find(call => call[1] === "insert")![2];
    expect(interpolateClipGain(insertEnvelope, 1)).toBe(1);
    expect(interpolateClipGain(insertEnvelope, 0)).toBe(0);
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(nativeBridge.setClipGainEnvelope).toHaveBeenCalledTimes(4));
    expect(nativeBridge.setClipGainEnvelope).toHaveBeenCalledWith("t", "bed", bed.gainEnvelope);
    expect(nativeBridge.setClipGainEnvelope).toHaveBeenLastCalledWith("t", "insert", []);
    await resetSyncCache();
  });
});
