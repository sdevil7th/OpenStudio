import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";
import type { KeyboardShortcutProfileId } from "../utils/shortcutProfiles";
import type { ShortcutPlatform } from "../utils/platform";

const originalState = useDAWStore.getState();

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 0,
    duration: 2,
    offset: 0,
    color: "#123456",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function midiClip(id: string): MIDIClip {
  return {
    id,
    name: id,
    startTime: 0,
    duration: 2,
    sourceLength: 2,
    loopLength: 2,
    events: [],
    ccEvents: [],
    color: "#654321",
  };
}

function track(id: string, clips: AudioClip[] = [], midiClips: MIDIClip[] = []): Track {
  return {
    ...createDefaultTrack(id, id, "#222222", "audio", []),
    clips,
    midiClips,
  };
}

function currentAudioClip(id: string): AudioClip | undefined {
  return useDAWStore.getState().tracks.flatMap((candidate) => candidate.clips)
    .find((clip) => clip.id === id);
}

beforeEach(() => {
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState({
    tracks: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    keyboardShortcutProfileId: "openstudio",
    customShortcuts: {},
    canUndo: false,
    canRedo: false,
    isModified: false,
    syncClipsWithBackend: vi.fn(async () => {}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState(originalState);
});

describe("selected audio clip peak normalization", () => {
  it("analyzes each exact trimmed range and atomically normalizes only eligible audio", async () => {
    const first = audioClip("first", { offset: 1.25, duration: 2.5, volumeDB: -3 });
    const second = audioClip("second", { offset: 0.5, duration: 1, volumeDB: 4 });
    const locked = audioClip("locked", { locked: true, volumeDB: -8 });
    const invalid = audioClip("invalid", { duration: 0, volumeDB: -9 });
    const midi = midiClip("midi");
    useDAWStore.setState({
      tracks: [track("track", [first, second, locked, invalid], [midi])],
      selectedClipId: first.id,
      selectedClipIds: [first.id, second.id, locked.id, invalid.id, midi.id],
    });
    const peak = vi.spyOn(nativeBridge, "getAudioPeakAmplitude")
      .mockResolvedValueOnce(0.5)
      .mockResolvedValueOnce(2);
    const sync = useDAWStore.getState().syncClipsWithBackend as ReturnType<typeof vi.fn>;

    await expect(useDAWStore.getState().normalizeSelectedClips()).resolves.toBe(true);

    expect(peak.mock.calls).toEqual([
      [first.filePath, 1.25, 2.5],
      [second.filePath, 0.5, 1],
    ]);
    expect(currentAudioClip(first.id)?.volumeDB).toBeCloseTo(6.020599913, 8);
    expect(currentAudioClip(second.id)?.volumeDB).toBeCloseTo(-6.020599913, 8);
    expect(currentAudioClip(locked.id)?.volumeDB).toBe(-8);
    expect(currentAudioClip(invalid.id)?.volumeDB).toBe(-9);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(sync).toHaveBeenCalledTimes(1);

    useDAWStore.getState().undo();
    expect(currentAudioClip(first.id)?.volumeDB).toBe(-3);
    expect(currentAudioClip(second.id)?.volumeDB).toBe(4);
    expect(sync).toHaveBeenCalledTimes(2);

    useDAWStore.getState().redo();
    expect(currentAudioClip(first.id)?.volumeDB).toBeCloseTo(6.020599913, 8);
    expect(currentAudioClip(second.id)?.volumeDB).toBeCloseTo(-6.020599913, 8);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("clamps extreme gain, accepts the primary-selection fallback, and skips silent or missing files", async () => {
    const quiet = audioClip("quiet");
    useDAWStore.setState({
      tracks: [track("track", [quiet])],
      selectedClipId: quiet.id,
      selectedClipIds: [],
    });
    vi.spyOn(nativeBridge, "getAudioPeakAmplitude").mockResolvedValue(0.001);
    await expect(useDAWStore.getState().normalizeSelectedClips()).resolves.toBe(true);
    expect(currentAudioClip(quiet.id)?.volumeDB).toBe(12);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    vi.mocked(nativeBridge.getAudioPeakAmplitude).mockResolvedValue(0);
    await expect(useDAWStore.getState().normalizeSelectedClips()).resolves.toBe(false);
    expect(currentAudioClip(quiet.id)?.volumeDB).toBe(12);
    expect(commandManager.canUndo()).toBe(false);

    vi.mocked(nativeBridge.getAudioPeakAmplitude).mockResolvedValue(null);
    await expect(useDAWStore.getState().normalizeSelectedClips()).resolves.toBe(false);
    expect(commandManager.canUndo()).toBe(false);

    vi.mocked(nativeBridge.getAudioPeakAmplitude).mockResolvedValue(10000);
    await expect(useDAWStore.getState().normalizeSelectedClips()).resolves.toBe(true);
    expect(currentAudioClip(quiet.id)?.volumeDB).toBe(-60);
  });

  it("does not create history when the calculated gain is already applied", async () => {
    const normalized = audioClip("normalized", { volumeDB: 0 });
    useDAWStore.setState({
      tracks: [track("track", [normalized])],
      selectedClipId: normalized.id,
      selectedClipIds: [normalized.id],
    });
    vi.spyOn(nativeBridge, "getAudioPeakAmplitude").mockResolvedValue(1);

    await expect(useDAWStore.getState().normalizeSelectedClips()).resolves.toBe(false);
    expect(commandManager.canUndo()).toBe(false);
    expect(useDAWStore.getState().syncClipsWithBackend).not.toHaveBeenCalled();
  });

  it("skips a clip changed while analysis is pending", async () => {
    let resolvePeak: (peak: number | null) => void = () => {};
    const pendingPeak = new Promise<number | null>((resolve) => { resolvePeak = resolve; });
    const clip = audioClip("changed", { offset: 1 });
    useDAWStore.setState({
      tracks: [track("track", [clip])],
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
    });
    vi.spyOn(nativeBridge, "getAudioPeakAmplitude").mockReturnValue(pendingPeak);

    const normalization = useDAWStore.getState().normalizeSelectedClips();
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((candidate) => ({
        ...candidate,
        clips: candidate.clips.map((entry) => entry.id === clip.id
          ? { ...entry, offset: 1.5 }
          : entry),
      })),
    }));
    resolvePeak(0.5);

    await expect(normalization).resolves.toBe(false);
    expect(currentAudioClip(clip.id)?.offset).toBe(1.5);
    expect(currentAudioClip(clip.id)?.volumeDB).toBe(0);
    expect(commandManager.canUndo()).toBe(false);
  });

  it("does not apply a result to a clip removed from the selection while analysis is pending", async () => {
    let resolvePeak: (peak: number | null) => void = () => {};
    const pendingPeak = new Promise<number | null>((resolve) => { resolvePeak = resolve; });
    const clip = audioClip("deselected");
    useDAWStore.setState({
      tracks: [track("track", [clip])],
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
    });
    vi.spyOn(nativeBridge, "getAudioPeakAmplitude").mockReturnValue(pendingPeak);

    const normalization = useDAWStore.getState().normalizeSelectedClips();
    useDAWStore.setState({ selectedClipId: null, selectedClipIds: [] });
    resolvePeak(0.5);

    await expect(normalization).resolves.toBe(false);
    expect(currentAudioClip(clip.id)?.volumeDB).toBe(0);
    expect(commandManager.canUndo()).toBe(false);
  });

  it("lets only the latest overlapping request mutate the same clip", async () => {
    let resolveFirst: (peak: number | null) => void = () => {};
    let resolveSecond: (peak: number | null) => void = () => {};
    const firstPeak = new Promise<number | null>((resolve) => { resolveFirst = resolve; });
    const secondPeak = new Promise<number | null>((resolve) => { resolveSecond = resolve; });
    const clip = audioClip("race");
    useDAWStore.setState({
      tracks: [track("track", [clip])],
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
    });
    vi.spyOn(nativeBridge, "getAudioPeakAmplitude")
      .mockReturnValueOnce(firstPeak)
      .mockReturnValueOnce(secondPeak);

    const firstRequest = useDAWStore.getState().normalizeSelectedClips();
    const secondRequest = useDAWStore.getState().normalizeSelectedClips();
    resolveSecond(0.5);
    await expect(secondRequest).resolves.toBe(true);
    resolveFirst(0.25);
    await expect(firstRequest).resolves.toBe(false);

    expect(currentAudioClip(clip.id)?.volumeDB).toBeCloseTo(6.020599913, 8);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });
});

describe("normalization shortcut profiles", () => {
  const cases: Array<{
    profile: KeyboardShortcutProfileId;
    platform: ShortcutPlatform;
    event: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean };
  }> = [
    { profile: "reaper", platform: "windows", event: { key: "n", code: "KeyN" } },
    { profile: "reaper", platform: "macos", event: { key: "n", code: "KeyN" } },
    { profile: "studio_one", platform: "windows", event: { key: "n", code: "KeyN", altKey: true } },
    { profile: "studio_one", platform: "macos", event: { key: "n", code: "KeyN", altKey: true } },
    { profile: "mixcraft", platform: "windows", event: { key: "k", code: "KeyK", ctrlKey: true } },
    { profile: "mixcraft", platform: "macos", event: { key: "k", code: "KeyK", metaKey: true } },
  ];

  it.each(cases)("dispatches $profile peak normalization on $platform", ({ profile, platform, event }) => {
    const clip = audioClip("dispatch");
    useDAWStore.setState({
      tracks: [track("track", [clip])],
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
      keyboardShortcutProfileId: profile,
    });
    activateShortcutContext({ kind: "timeline" });
    const actionIds: string[] = [];
    const preventDefault = vi.fn();

    expect(dispatchGlobalShortcut(
      { ...event, preventDefault, source: "clip-normalization-test" },
      platform,
      { executeAction: (action) => actionIds.push(action.id) },
    )).toBe(true);
    expect(actionIds).toEqual(["edit.normalizeClips"]);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("is timeline-only and unavailable for global/item/clip locks, frozen tracks, MIDI-only, or invalid selections", () => {
    const locked = audioClip("locked", { locked: true });
    const midi = midiClip("midi");
    useDAWStore.setState({
      tracks: [track("track", [locked], [midi])],
      selectedClipId: locked.id,
      selectedClipIds: [locked.id, midi.id],
    });
    const action = getRegisteredAction("edit.normalizeClips")!;
    const executeAction = vi.fn();
    const expectShortcutUnavailable = () => {
      activateShortcutContext({ kind: "timeline" });
      useDAWStore.setState({ keyboardShortcutProfileId: "reaper" });
      expect(dispatchGlobalShortcut(
        { key: "n", code: "KeyN", source: "clip-normalization-lock-test" },
        "windows",
        { executeAction },
      )).toBe(false);
      expect(executeAction).not.toHaveBeenCalled();
    };
    expect(action.shortcutScope).toBe("timeline");
    expect(action.canHandleShortcut?.()).toBe(false);
    expectShortcutUnavailable();

    const valid = audioClip("valid");
    const validTrack = track("track", [valid]);
    useDAWStore.setState({
      tracks: [validTrack],
      selectedClipId: valid.id,
      selectedClipIds: [valid.id],
      globalLocked: true,
    });
    expect(action.canHandleShortcut?.()).toBe(false);
    expectShortcutUnavailable();
    useDAWStore.setState({
      globalLocked: false,
      lockSettings: { ...useDAWStore.getState().lockSettings, items: true },
    });
    expect(action.canHandleShortcut?.()).toBe(false);
    expectShortcutUnavailable();
    useDAWStore.setState({
      lockSettings: { ...useDAWStore.getState().lockSettings, items: false },
      tracks: [{ ...validTrack, frozen: true }],
    });
    expect(action.canHandleShortcut?.()).toBe(false);
    expectShortcutUnavailable();

    useDAWStore.setState({
      tracks: [track("track", [audioClip("valid")])],
      selectedClipId: "valid",
      selectedClipIds: ["valid"],
    });
    expect(action.canHandleShortcut?.()).toBe(true);
    activateShortcutContext({ kind: "mixer" });
    useDAWStore.setState({ keyboardShortcutProfileId: "reaper" });
    expect(dispatchGlobalShortcut(
      { key: "n", code: "KeyN", source: "clip-normalization-test" },
      "windows",
      { executeAction: () => { throw new Error("must not dispatch"); } },
    )).toBe(false);
  });
});
