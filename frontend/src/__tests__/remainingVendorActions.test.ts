import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { getProfileActionBindings } from "../utils/shortcutProfiles";
import { buildTrackFolderGroupPlan } from "../utils/trackFolderGrouping";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";
import {
  collectClipIdsInsideTimeSelection,
  collectTimelineBoundaryTimes,
  resolveAdjacentGridLineTime,
  resolveAdjacentTimelineBoundary,
} from "../utils/vendorNavigation";

const originalState = useDAWStore.getState();

function clip(id: string, startTime: number, duration: number) {
  return { id, startTime, duration };
}

beforeEach(() => {
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState({
    tracks: [],
    markers: [],
    timeSelection: null,
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    transport: {
      ...originalState.transport,
      tempo: 120,
      currentTime: 0,
      isPlaying: false,
      isPaused: false,
      isRecording: false,
    },
    timeSignature: { numerator: 4, denominator: 4 },
    gridSize: "1/4",
    quantizePresetId: "factory-1/16",
    pixelsPerSecond: 100,
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState(originalState);
});

describe("vendor navigation primitives", () => {
  it("moves strictly between grid lines, handles fractional positions, and clamps at zero", () => {
    expect(resolveAdjacentGridLineTime(1, 0.5, "next")).toBe(1.5);
    expect(resolveAdjacentGridLineTime(1, 0.5, "previous")).toBe(0.5);
    expect(resolveAdjacentGridLineTime(1.1, 0.5, "next")).toBe(1.5);
    expect(resolveAdjacentGridLineTime(1.1, 0.5, "previous")).toBe(1);
    expect(resolveAdjacentGridLineTime(0, 0.5, "previous")).toBeNull();
    expect(resolveAdjacentGridLineTime(Number.NaN, 0.5, "next")).toBeNull();
    expect(resolveAdjacentGridLineTime(1, 0, "next")).toBeNull();
  });

  it("collects the exact Audition boundary union and collapses ties", () => {
    const boundaries = collectTimelineBoundaryTimes({
      tracks: [{
        clips: [clip("audio", 1, 2)],
        midiClips: [clip("midi", 3, 1), clip("invalid", Number.NaN, 1)],
      }],
      markers: [{ time: -1 }, { time: 1 }, { time: 6 }],
      timeSelection: { start: 3, end: 5 },
    });
    expect(boundaries).toEqual([0, 1, 3, 4, 5, 6]);
    expect(resolveAdjacentTimelineBoundary(3, boundaries, "previous")).toBe(1);
    expect(resolveAdjacentTimelineBoundary(3, boundaries, "next")).toBe(4);
    expect(resolveAdjacentTimelineBoundary(0, boundaries, "previous")).toBeNull();
    expect(resolveAdjacentTimelineBoundary(6, boundaries, "next")).toBeNull();
  });

  it("selects only audio and MIDI clips fully contained by a normalized time selection", () => {
    const tracks = [{
      clips: [clip("exact", 1, 2), clip("overlap-left", 0.5, 1), clip("overlap-right", 2.5, 1)],
      midiClips: [clip("midi-inside", 1.5, 0.5)],
    }];
    expect(collectClipIdsInsideTimeSelection(tracks, { start: 3, end: 1 })).toEqual([
      "exact",
      "midi-inside",
    ]);
    expect(collectClipIdsInsideTimeSelection(tracks, null)).toEqual([]);
  });
});

describe("track folder grouping plan", () => {
  it("gathers selected subtrees at the first selected position while preserving order", () => {
    expect(buildTrackFolderGroupPlan([
      { id: "before" },
      { id: "first" },
      { id: "first-child", parentFolderId: "first" },
      { id: "between" },
      { id: "second" },
      { id: "after" },
    ], ["second", "first"], "group")).toEqual({
      orderedTrackIds: ["before", "group", "first", "first-child", "second", "between", "after"],
      selectedRootIds: ["first", "second"],
      parentFolderId: undefined,
    });
  });

  it("inherits a common parent and rejects cross-level, ancestor, cyclic, and empty selections", () => {
    const nested = [
      { id: "parent" },
      { id: "one", parentFolderId: "parent" },
      { id: "two", parentFolderId: "parent" },
      { id: "root" },
    ];
    expect(buildTrackFolderGroupPlan(nested, ["one", "two"], "group")?.parentFolderId).toBe("parent");
    expect(buildTrackFolderGroupPlan(nested, ["one", "root"], "group")).toBeNull();
    expect(buildTrackFolderGroupPlan(nested, ["parent", "one"], "group")).toBeNull();
    expect(buildTrackFolderGroupPlan([{ id: "a", parentFolderId: "b" }, { id: "b", parentFolderId: "a" }], ["a"], "group")).toBeNull();
    expect(buildTrackFolderGroupPlan(nested, [], "group")).toBeNull();
    expect(buildTrackFolderGroupPlan(nested, ["missing"], "group")).toBeNull();
  });
});

describe("remaining exact vendor actions", () => {
  it("registers exact timeline-scoped commands and profile chords on both layouts", () => {
    for (const actionId of [
      "navigate.previousGridLine",
      "navigate.nextGridLine",
      "navigate.previousBoundary",
      "navigate.nextBoundary",
      "edit.selectClipsInTimeSelection",
    ]) {
      expect(getRegisteredAction(actionId)?.shortcutScope, actionId).toBe("timeline");
    }

    for (const platform of ["macos", "windows"] as const) {
      expect(getProfileActionBindings("ardour", "navigate.previousGridLine", platform)).toEqual(["Left"]);
      expect(getProfileActionBindings("ardour", "navigate.nextGridLine", platform)).toEqual(["Right"]);
      expect(getProfileActionBindings("ardour", "edit.selectClipsInTimeSelection", platform)).toEqual(["U"]);
      expect(getProfileActionBindings("adobe_audition", "navigate.previousBoundary", platform)).toEqual(["Ctrl+Left"]);
      expect(getProfileActionBindings("adobe_audition", "navigate.nextBoundary", platform)).toEqual(["Ctrl+Right"]);
      expect(getProfileActionBindings("studio_one", "edit.muteSelectedClips", platform)).toEqual(["Shift+M"]);
      expect(getProfileActionBindings("studio_one", "edit.unmuteSelectedClips", platform)).toEqual(["Shift+U"]);
      expect(getProfileActionBindings("studio_one", "insert.markerNamed", platform)).toEqual([]);
      expect(getProfileActionBindings("ableton_live", "track.groupSelectedIntoFolder", platform)).toEqual(["Ctrl+G"]);
      expect(getProfileActionBindings("bitwig_studio", "track.groupSelectedIntoFolder", platform)).toEqual(["Ctrl+G"]);
    }
  });

  it("seeks one active musical grid division and no-ops before zero", () => {
    const seekTo = vi.fn(async (time: number) => {
      useDAWStore.setState((state) => ({ transport: { ...state.transport, currentTime: time } }));
    });
    useDAWStore.setState((state) => ({
      seekTo,
      transport: { ...state.transport, currentTime: 1 },
    }));

    const previous = getRegisteredAction("navigate.previousGridLine")!;
    const next = getRegisteredAction("navigate.nextGridLine")!;
    expect(previous.canHandleShortcut?.()).toBe(true);
    previous.execute();
    expect(seekTo).toHaveBeenLastCalledWith(0.5);
    next.execute();
    expect(seekTo).toHaveBeenLastCalledWith(1);

    useDAWStore.setState((state) => ({ transport: { ...state.transport, currentTime: 0 } }));
    seekTo.mockClear();
    expect(previous.canHandleShortcut?.()).toBe(false);
    previous.execute();
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("navigates tied marker/clip/selection boundaries and no-ops without a target", () => {
    const track = createDefaultTrack("track", "Track", "#123456", "audio", []);
    const seekTo = vi.fn(async (time: number) => {
      useDAWStore.setState((state) => ({ transport: { ...state.transport, currentTime: time } }));
    });
    useDAWStore.setState((state) => ({
      seekTo,
      tracks: [{
        ...track,
        clips: [{
          id: "clip",
          filePath: "C:/audio.wav",
          name: "Clip",
          startTime: 1,
          duration: 2,
          offset: 0,
          color: "#123456",
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
        }],
      }],
      markers: [{ id: "marker", time: 1, name: "Marker", color: "#fff" }],
      timeSelection: { start: 3, end: 5 },
      transport: { ...state.transport, currentTime: 3 },
    }));

    const previous = getRegisteredAction("navigate.previousBoundary")!;
    const next = getRegisteredAction("navigate.nextBoundary")!;
    previous.execute();
    expect(seekTo).toHaveBeenLastCalledWith(1);
    next.execute();
    expect(seekTo).toHaveBeenLastCalledWith(3);

    useDAWStore.setState((state) => ({
      tracks: [],
      markers: [],
      timeSelection: null,
      transport: { ...state.transport, currentTime: 8 },
    }));
    seekTo.mockClear();
    expect(next.canHandleShortcut?.()).toBe(false);
    next.execute();
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("selects contained clips without creating project history and clears track selection", () => {
    const audioTrack = createDefaultTrack("audio-track", "Audio", "#123456", "audio", []);
    const midiTrack = createDefaultTrack("midi-track", "MIDI", "#654321", "midi", []);
    useDAWStore.setState({
      tracks: [
        {
          ...audioTrack,
          clips: [
            { id: "inside", filePath: "C:/inside.wav", name: "Inside", startTime: 1, duration: 1, offset: 0, color: "#123456", volumeDB: 0, fadeIn: 0, fadeOut: 0 },
            { id: "overlap", filePath: "C:/overlap.wav", name: "Overlap", startTime: 0.5, duration: 1, offset: 0, color: "#123456", volumeDB: 0, fadeIn: 0, fadeOut: 0 },
          ],
        },
        {
          ...midiTrack,
          midiClips: [{ id: "midi", name: "MIDI", startTime: 2, duration: 1, sourceLength: 1, loopLength: 1, events: [], ccEvents: [], color: "#654321" }],
        },
      ],
      timeSelection: { start: 1, end: 3 },
      selectedTrackId: "audio-track",
      selectedTrackIds: ["audio-track"],
      lastSelectedTrackId: "audio-track",
    });

    const action = getRegisteredAction("edit.selectClipsInTimeSelection")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    expect(useDAWStore.getState()).toMatchObject({
      selectedClipIds: ["inside", "midi"],
      selectedClipId: "midi",
      selectedTrackIds: [],
      selectedTrackId: null,
      lastSelectedTrackId: null,
      canUndo: false,
    });
  });

  it("dispatches Ardour grid navigation and Audition boundary navigation in Timeline context", () => {
    const unregister = registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });
    const seekTo = vi.fn(async (time: number) => {
      useDAWStore.setState((state) => ({ transport: { ...state.transport, currentTime: time } }));
    });
    useDAWStore.setState((state) => ({
      keyboardShortcutProfileId: "ardour",
      customShortcuts: {},
      seekTo,
      transport: { ...state.transport, currentTime: 1 },
    }));

    expect(dispatchGlobalShortcut({ key: "ArrowLeft", code: "ArrowLeft", source: "browser" }, "windows")).toBe(true);
    expect(seekTo).toHaveBeenLastCalledWith(0.5);
    expect(dispatchGlobalShortcut({ key: "ArrowRight", code: "ArrowRight", source: "browser" }, "windows")).toBe(true);
    expect(seekTo).toHaveBeenLastCalledWith(1);

    const track = createDefaultTrack("track", "Track", "#123456", "audio", []);
    useDAWStore.setState((state) => ({
      keyboardShortcutProfileId: "adobe_audition",
      tracks: [{ ...track, clips: [{ id: "clip", filePath: "C:/clip.wav", name: "Clip", startTime: 1, duration: 2, offset: 0, color: "#123456", volumeDB: 0, fadeIn: 0, fadeOut: 0 }] }],
      markers: [{ id: "marker", time: 1, name: "Marker", color: "#fff" }],
      timeSelection: { start: 3, end: 5 },
      transport: { ...state.transport, currentTime: 3 },
    }));
    expect(dispatchGlobalShortcut({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, source: "browser" }, "macos")).toBe(true);
    expect(seekTo).toHaveBeenLastCalledWith(1);
    expect(dispatchGlobalShortcut({ key: "ArrowRight", code: "ArrowRight", metaKey: true, source: "browser" }, "macos")).toBe(true);
    expect(seekTo).toHaveBeenLastCalledWith(3);
    expect(dispatchGlobalShortcut({ key: "ArrowRight", code: "ArrowRight", ctrlKey: true, source: "browser" }, "macos")).toBe(false);
    unregister();
  });

  it("dispatches Studio One directional mute/unmute without toggling already-matching clips", () => {
    const unregister = registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });
    const track = createDefaultTrack("track", "Track", "#123456", "audio", []);
    useDAWStore.setState({
      keyboardShortcutProfileId: "studio_one",
      customShortcuts: {},
      tracks: [{
        ...track,
        clips: [{ id: "clip", filePath: "C:/clip.wav", name: "Clip", startTime: 0, duration: 1, offset: 0, color: "#123456", volumeDB: 0, fadeIn: 0, fadeOut: 0, muted: false }],
      }],
      selectedClipId: "clip",
      selectedClipIds: ["clip"],
    });

    expect(dispatchGlobalShortcut({ key: "M", code: "KeyM", shiftKey: true, source: "browser" }, "windows")).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0].muted).toBe(true);
    expect(dispatchGlobalShortcut({ key: "M", code: "KeyM", shiftKey: true, source: "browser" }, "windows")).toBe(false);
    expect(dispatchGlobalShortcut({ key: "U", code: "KeyU", shiftKey: true, source: "browser" }, "windows")).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0].muted).toBe(false);
    unregister();
  });

  it("groups same-level selected track subtrees atomically with stable native undo/redo", async () => {
    const addTrack = vi.spyOn(nativeBridge, "addTrack").mockImplementation(async (id) => id || "generated");
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    const reorderTrack = vi.spyOn(nativeBridge, "reorderTrack").mockResolvedValue(true);
    const parent = { ...createDefaultTrack("parent", "Parent", "#111111", "audio", []), isFolder: true };
    const one = { ...createDefaultTrack("one", "One", "#222222", "audio", []), parentFolderId: "parent" };
    const child = { ...createDefaultTrack("child", "Child", "#333333", "audio", []), parentFolderId: "one" };
    const between = { ...createDefaultTrack("between", "Between", "#444444", "audio", []), parentFolderId: "parent" };
    const two = { ...createDefaultTrack("two", "Two", "#555555", "audio", []), parentFolderId: "parent" };
    const after = createDefaultTrack("after", "After", "#666666", "audio", []);
    useDAWStore.setState({
      tracks: [parent, one, child, between, two, after],
      selectedTrackId: "two",
      selectedTrackIds: ["two", "one"],
      lastSelectedTrackId: "two",
    });

    expect(useDAWStore.getState().canGroupSelectedTracksIntoFolder()).toBe(true);
    expect(useDAWStore.getState().groupSelectedTracksIntoFolder()).toBe(true);
    const grouped = useDAWStore.getState().tracks;
    const folder = grouped.find((track) => !["parent", "one", "child", "between", "two", "after"].includes(track.id))!;
    expect(folder).toMatchObject({ name: "Group 1", isFolder: true, parentFolderId: "parent" });
    expect(grouped.map((track) => track.id)).toEqual(["parent", folder.id, "one", "child", "two", "between", "after"]);
    expect(grouped.find((track) => track.id === "one")?.parentFolderId).toBe(folder.id);
    expect(grouped.find((track) => track.id === "two")?.parentFolderId).toBe(folder.id);
    expect(grouped.find((track) => track.id === "child")?.parentFolderId).toBe("one");
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["two", "one"]);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["parent", "one", "child", "between", "two", "after"]);
    expect(useDAWStore.getState().tracks.find((track) => track.id === "one")?.parentFolderId).toBe("parent");
    expect(useDAWStore.getState().canUndo).toBe(false);
    expect(useDAWStore.getState().canRedo).toBe(true);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["parent", folder.id, "one", "child", "two", "between", "after"]);
    expect(useDAWStore.getState().tracks.find((track) => track.id === "one")?.parentFolderId).toBe(folder.id);
    await vi.waitFor(() => {
      expect(addTrack.mock.calls.filter(([id]) => id === folder.id)).toHaveLength(2);
      expect(removeTrack).toHaveBeenCalledExactlyOnceWith(folder.id);
      expect(reorderTrack).toHaveBeenCalledWith(folder.id, 1);
    });
  });

  it("rejects unsafe hierarchy grouping without history or native mutation", () => {
    const addTrack = vi.spyOn(nativeBridge, "addTrack").mockImplementation(async (id) => id || "generated");
    const parent = { ...createDefaultTrack("parent", "Parent", "#111111", "audio", []), isFolder: true };
    const child = { ...createDefaultTrack("child", "Child", "#222222", "audio", []), parentFolderId: "parent" };
    const root = createDefaultTrack("root", "Root", "#333333", "audio", []);
    useDAWStore.setState({
      tracks: [parent, child, root],
      selectedTrackId: "child",
      selectedTrackIds: ["child", "root"],
      lastSelectedTrackId: "child",
    });
    expect(useDAWStore.getState().canGroupSelectedTracksIntoFolder()).toBe(false);
    expect(useDAWStore.getState().groupSelectedTracksIntoFolder()).toBe(false);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["parent", "child", "root"]);
    expect(useDAWStore.getState().canUndo).toBe(false);
    expect(addTrack).not.toHaveBeenCalled();
  });

  it.each([
    { profileId: "ableton_live" as const, platform: "windows" as const, event: { key: "g", code: "KeyG", ctrlKey: true } },
    { profileId: "bitwig_studio" as const, platform: "macos" as const, event: { key: "g", code: "KeyG", metaKey: true } },
  ])("dispatches $profileId Group Tracks through Timeline on $platform", ({ profileId, platform, event }) => {
    const unregister = registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });
    const first = createDefaultTrack("first", "First", "#111111", "audio", []);
    const second = createDefaultTrack("second", "Second", "#222222", "audio", []);
    useDAWStore.setState({
      keyboardShortcutProfileId: profileId,
      customShortcuts: {},
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["first", "second"],
      lastSelectedTrackId: "second",
    });

    expect(dispatchGlobalShortcut({ ...event, source: "browser" }, platform)).toBe(true);
    expect(useDAWStore.getState().tracks).toHaveLength(3);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ isFolder: true, name: "Group 1" });
    expect(useDAWStore.getState().tracks.slice(1).every((track) => track.parentFolderId === useDAWStore.getState().tracks[0].id)).toBe(true);
    unregister();
  });
});
