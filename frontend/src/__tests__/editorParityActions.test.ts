import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import { nativeBridge } from "../services/NativeBridge";
import {
  getRegisteredAction,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  getMinimumVisibleTrackHeight,
  type AudioClip,
  type MIDIClip,
  type MIDIEvent,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";
import { noteIdFor, parseMIDINotePairs } from "../utils/midiNotes";
import {
  activateShortcutContext,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

const originalState = useDAWStore.getState();
const scopedCleanups: Array<() => void> = [];

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 0,
    duration: 1,
    offset: 0,
    color: "#123456",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function midiClip(id: string, events: MIDIEvent[] = [], overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id,
    name: id,
    startTime: 0,
    duration: 2,
    sourceLength: 2,
    loopLength: 2,
    events,
    ccEvents: [],
    color: "#654321",
    ...overrides,
  };
}

function track(id: string, type: Track["type"] = "audio", overrides: Partial<Track> = {}): Track {
  return {
    ...createDefaultTrack(id, id, "#222222", type, []),
    ...overrides,
  };
}

function noteEvents(note: number, start: number, end: number, channel = 1): MIDIEvent[] {
  return [
    { type: "noteOn", timestamp: start, note, velocity: 90, channel },
    { type: "noteOff", timestamp: end, note, velocity: 7, releaseVelocity: 7, channel },
  ];
}

beforeEach(() => {
  commandManager.clear();
  resetShortcutContextForTests();
  activateShortcutContext({ kind: "application" });
  useDAWStore.setState({
    tracks: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    selectedClipId: null,
    selectedClipIds: [],
    selectedNoteIds: [],
    midiEditRange: null,
    midiEditorSessions: [],
    activeMidiEditorSessionId: null,
    dockedMidiEditorSessionId: null,
    showPianoRoll: false,
    pianoRollTrackId: null,
    pianoRollClipId: null,
    canUndo: false,
    canRedo: false,
    isModified: false,
    trackHeight: 100,
    tcpWidth: 250,
  });
});

afterEach(() => {
  while (scopedCleanups.length > 0) scopedCleanups.pop()?.();
  vi.restoreAllMocks();
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState(originalState);
});

describe("vendor-parity editor action catalog", () => {
  it("registers exact actions and does not invent unsupported source-only behavior", () => {
    const scopedExpectations = new Map([
      ["view.verticalZoomIn", "timeline"],
      ["view.verticalZoomOut", "timeline"],
      ["edit.selectPreviousClip", "timeline"],
      ["edit.selectNextClip", "timeline"],
      ["edit.muteSelectedClips", "timeline"],
      ["edit.unmuteSelectedClips", "timeline"],
      ["track.moveSelectedUp", "track_control_panel"],
      ["track.moveSelectedDown", "track_control_panel"],
      ["midi.deselectAll", "piano_roll"],
      ["midi.selectNextNote", "piano_roll"],
      ["midi.selectPreviousNote", "piano_roll"],
      ["midi.glueSelectedNotes", "piano_roll"],
    ]);
    expect(getRegisteredAction("view.togglePianoRoll")?.shortcutScope).toBe("global");
    scopedExpectations.forEach((scope, actionId) => {
      expect(getRegisteredAction(actionId)?.shortcutScope, actionId).toBe(scope);
    });

    for (const unsupportedId of [
      "edit.toggleSelectedClipLoop",
      "midi.tool.paint",
      "midi.tool.playback",
      "edit.joinSelectedClipsOrNotes",
      "edit.consolidateSelectedClips",
      "view.toggleWaveformMultitrackEditor",
      "edit.cropSelectedClips",
    ]) {
      expect(getRegisteredAction(unsupportedId), unsupportedId).toBeUndefined();
    }
  });
});

describe("Piano Roll routing and view actions", () => {
  it("opens the selected MIDI clip, closes the docked editor, and no-ops without an eligible clip", () => {
    useDAWStore.setState({
      tracks: [track("midi-track", "midi", { midiClips: [midiClip("midi-clip")] })],
      selectedClipId: "midi-clip",
      selectedClipIds: ["midi-clip"],
    });
    const action = getRegisteredAction("view.togglePianoRoll")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    expect(useDAWStore.getState()).toMatchObject({
      showPianoRoll: true,
      pianoRollTrackId: "midi-track",
      pianoRollClipId: "midi-clip",
    });

    action.execute();
    expect(useDAWStore.getState().showPianoRoll).toBe(false);

    useDAWStore.setState({
      tracks: [track("audio-track", "audio", { clips: [audioClip("audio-clip")] })],
      selectedClipId: "audio-clip",
      selectedClipIds: ["audio-clip"],
    });
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(useDAWStore.getState().showPianoRoll).toBe(false);
  });

  it("closes only the active detached editor even without main-window Piano Roll state", () => {
    const firstClose = vi.fn((_actionId: string) => "handled" as const);
    const secondClose = vi.fn((_actionId: string) => "handled" as const);
    scopedCleanups.push(registerScopedActionExecutor(
      { kind: "piano_roll", sessionId: "first" },
      firstClose,
      ["view.togglePianoRoll"],
    ));
    scopedCleanups.push(registerScopedActionExecutor(
      { kind: "piano_roll", sessionId: "second" },
      secondClose,
      ["view.togglePianoRoll"],
    ));
    activateShortcutContext({ kind: "piano_roll", sessionId: "second" });
    useDAWStore.setState({
      showPianoRoll: false,
      tracks: [],
      selectedClipId: null,
      selectedClipIds: [],
    });

    const action = getRegisteredAction("view.togglePianoRoll")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    expect(secondClose).toHaveBeenCalledExactlyOnceWith("view.togglePianoRoll");
    expect(firstClose).not.toHaveBeenCalled();
    expect(useDAWStore.getState().showPianoRoll).toBe(false);
  });

  it("routes MIDI selection commands to the exact active editor instance", () => {
    const first = vi.fn((_actionId: string) => "handled" as const);
    const second = vi.fn((_actionId: string) => "handled" as const);
    const ids = ["midi.deselectAll", "midi.selectNextNote", "midi.selectPreviousNote", "midi.glueSelectedNotes"];
    scopedCleanups.push(registerScopedActionExecutor(
      { kind: "piano_roll", sessionId: "first" },
      first,
      ids,
    ));
    scopedCleanups.push(registerScopedActionExecutor(
      { kind: "piano_roll", sessionId: "second" },
      second,
      ids,
    ));
    activateShortcutContext({ kind: "piano_roll", sessionId: "second" });

    ids.forEach((actionId) => getRegisteredAction(actionId)?.execute());
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls.map(([actionId]) => actionId)).toEqual(ids);
    for (const actionId of ids) expect(pianoRollSource).toContain(`actionId === "${actionId}"`);
  });

  it("zooms track height vertically with exact clamping and no undo entry", () => {
    const zoomIn = getRegisteredAction("view.verticalZoomIn")!;
    const zoomOut = getRegisteredAction("view.verticalZoomOut")!;
    zoomIn.execute();
    expect(useDAWStore.getState().trackHeight).toBe(120);
    zoomOut.execute();
    expect(useDAWStore.getState().trackHeight).toBe(100);
    expect(useDAWStore.getState().canUndo).toBe(false);

    const minimum = getMinimumVisibleTrackHeight([], useDAWStore.getState().tcpWidth);
    useDAWStore.setState({ trackHeight: minimum });
    expect(zoomOut.canHandleShortcut?.()).toBe(false);
    zoomOut.execute();
    expect(useDAWStore.getState().trackHeight).toBe(minimum);

    useDAWStore.setState({ trackHeight: 500 });
    expect(zoomIn.canHandleShortcut?.()).toBe(false);
    zoomIn.execute();
    expect(useDAWStore.getState().trackHeight).toBe(500);
  });
});

describe("timeline clip navigation and directional mute", () => {
  it("selects adjacent audio/MIDI clips in deterministic time and track order", () => {
    useDAWStore.setState({
      tracks: [
        track("first", "midi", {
          clips: [audioClip("late", { startTime: 2 })],
          midiClips: [midiClip("first-at-one", [], { startTime: 1 })],
        }),
        track("second", "audio", { clips: [audioClip("second-at-one", { startTime: 1 })] }),
      ],
      selectedClipId: "first-at-one",
      selectedClipIds: ["first-at-one"],
    });

    expect(useDAWStore.getState().selectAdjacentClip("next")).toBe(true);
    expect(useDAWStore.getState().selectedClipId).toBe("second-at-one");
    expect(getRegisteredAction("edit.selectNextClip")?.canHandleShortcut?.()).toBe(true);
    getRegisteredAction("edit.selectNextClip")?.execute();
    expect(useDAWStore.getState().selectedClipId).toBe("late");
    expect(getRegisteredAction("edit.selectNextClip")?.canHandleShortcut?.()).toBe(false);
    expect(useDAWStore.getState().selectAdjacentClip("next")).toBe(false);

    expect(useDAWStore.getState().selectAdjacentClip("previous")).toBe(true);
    expect(useDAWStore.getState().selectedClipId).toBe("second-at-one");
    useDAWStore.setState({ selectedClipId: null, selectedClipIds: [] });
    expect(useDAWStore.getState().selectAdjacentClip("previous")).toBe(false);
  });

  it("mutes mixed audio/MIDI selection in one undo step and skips locked clips", () => {
    const syncAudio = vi.fn(async () => undefined);
    const syncMIDI = vi.fn(async () => undefined);
    useDAWStore.setState({
      tracks: [
        track("audio", "audio", {
          clips: [
            audioClip("audio-open"),
            audioClip("audio-locked", { locked: true }),
          ],
        }),
        track("midi", "midi", {
          midiClips: [
            midiClip("midi-open"),
            midiClip("midi-already", [], { muted: true }),
          ],
        }),
      ],
      selectedClipId: "midi-already",
      selectedClipIds: ["audio-open", "audio-locked", "midi-open", "midi-already"],
      syncClipsWithBackend: syncAudio,
      syncMIDITrackToBackend: syncMIDI,
    });

    expect(useDAWStore.getState().setSelectedClipsMuted(true)).toBe(true);
    const muted = useDAWStore.getState().tracks;
    expect(muted[0].clips.map((clip) => clip.muted)).toEqual([true, undefined]);
    expect(muted[1].midiClips.map((clip) => clip.muted)).toEqual([true, true]);
    expect(useDAWStore.getState().canUndo).toBe(true);
    expect(syncAudio).toHaveBeenCalledTimes(1);
    expect(syncMIDI).toHaveBeenCalledWith("midi", { debounce: false });

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.muted)).toEqual([undefined, undefined]);
    expect(useDAWStore.getState().tracks[1].midiClips.map((clip) => clip.muted)).toEqual([undefined, true]);
    expect(useDAWStore.getState().canUndo).toBe(false);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].muted).toBe(true);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    expect(useDAWStore.getState().setSelectedClipsMuted(true)).toBe(false);
    expect(useDAWStore.getState().canUndo).toBe(false);
    expect(getRegisteredAction("edit.muteSelectedClips")?.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("edit.unmuteSelectedClips")?.canHandleShortcut?.()).toBe(true);
  });
});

describe("atomic track reordering", () => {
  it("moves a selected folder with its descendants and restores one exact snapshot", () => {
    const reorderSpy = vi.spyOn(nativeBridge, "reorderTrack").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [
        track("folder", "audio", { isFolder: true }),
        track("child-a", "audio", { parentFolderId: "folder" }),
        track("child-b", "midi", { parentFolderId: "folder" }),
        track("outside"),
      ],
      selectedTrackId: "folder",
      selectedTrackIds: ["folder"],
    });

    expect(useDAWStore.getState().canMoveSelectedTracks("down")).toBe(true);
    expect(useDAWStore.getState().moveSelectedTracks("down")).toBe(true);
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.id))
      .toEqual(["outside", "folder", "child-a", "child-b"]);
    expect(useDAWStore.getState().tracks.filter((candidate) => candidate.parentFolderId).map((candidate) => candidate.parentFolderId))
      .toEqual(["folder", "folder"]);
    expect(useDAWStore.getState().canUndo).toBe(true);
    expect(reorderSpy).toHaveBeenCalledTimes(4);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.id))
      .toEqual(["folder", "child-a", "child-b", "outside"]);
    expect(useDAWStore.getState().canUndo).toBe(false);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.id))
      .toEqual(["outside", "folder", "child-a", "child-b"]);
  });

  it("moves multi-selection as an ordered block and prevents children crossing folder boundaries", () => {
    vi.spyOn(nativeBridge, "reorderTrack").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [track("a"), track("b"), track("c"), track("d")],
      selectedTrackId: "c",
      selectedTrackIds: ["b", "c"],
    });
    expect(useDAWStore.getState().moveSelectedTracks("down")).toBe(true);
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.id)).toEqual(["a", "d", "b", "c"]);

    commandManager.clear();
    useDAWStore.setState({
      tracks: [
        track("folder", "audio", { isFolder: true }),
        track("child-a", "audio", { parentFolderId: "folder" }),
        track("child-b", "audio", { parentFolderId: "folder" }),
        track("outside"),
      ],
      selectedTrackId: "child-b",
      selectedTrackIds: ["child-b"],
      canUndo: false,
      canRedo: false,
    });
    expect(useDAWStore.getState().canMoveSelectedTracks("down")).toBe(false);
    expect(useDAWStore.getState().moveSelectedTracks("down")).toBe(false);
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.id))
      .toEqual(["folder", "child-a", "child-b", "outside"]);
    expect(useDAWStore.getState().canUndo).toBe(false);
  });
});

describe("Piano Roll glue transaction", () => {
  it("glues eligible same-pitch/channel notes once and undoes/redoes exactly", () => {
    const events = [
      ...noteEvents(60, 0, 0.4),
      ...noteEvents(60, 0.5, 1),
      ...noteEvents(64, 0.25, 0.75),
    ];
    const syncMIDI = vi.fn(async () => undefined);
    useDAWStore.setState({
      tracks: [track("midi", "midi", { midiClips: [midiClip("clip", events)] })],
      syncMIDITrackToBackend: syncMIDI,
    });
    const selection = [noteIdFor("clip", 0, 60), noteIdFor("clip", 0.5, 60)];
    const nextIds = useDAWStore.getState().glueSelectedMIDINotes("midi", "clip", selection);
    expect(nextIds).toEqual([noteIdFor("clip", 0, 60)]);
    let pairs = parseMIDINotePairs(useDAWStore.getState().tracks[0].midiClips[0].events, "clip");
    expect(pairs.map((pair) => [pair.noteNumber, pair.startTime, pair.duration]))
      .toEqual([[60, 0, 1], [64, 0.25, 0.5]]);
    expect(useDAWStore.getState().canUndo).toBe(true);

    useDAWStore.getState().undo();
    pairs = parseMIDINotePairs(useDAWStore.getState().tracks[0].midiClips[0].events, "clip");
    expect(pairs.filter((pair) => pair.noteNumber === 60)).toHaveLength(2);
    expect(useDAWStore.getState().canUndo).toBe(false);
    useDAWStore.getState().redo();
    pairs = parseMIDINotePairs(useDAWStore.getState().tracks[0].midiClips[0].events, "clip");
    expect(pairs.filter((pair) => pair.noteNumber === 60)).toHaveLength(1);
  });

  it("is undo-safe for no selection, mixed pitches/channels, and locked clips", () => {
    const events = [
      ...noteEvents(60, 0, 0.4, 1),
      ...noteEvents(60, 0.5, 1, 2),
      ...noteEvents(64, 0.25, 0.75, 1),
    ];
    useDAWStore.setState({
      tracks: [track("midi", "midi", { midiClips: [midiClip("clip", events)] })],
    });
    expect(useDAWStore.getState().glueSelectedMIDINotes("midi", "clip", [])).toEqual([]);
    expect(useDAWStore.getState().glueSelectedMIDINotes("midi", "clip", [
      noteIdFor("clip", 0, 60),
      noteIdFor("clip", 0.25, 64),
    ])).toEqual([]);
    expect(useDAWStore.getState().canUndo).toBe(false);

    useDAWStore.setState({
      tracks: [track("midi", "midi", { midiClips: [midiClip("clip", events, { locked: true })] })],
    });
    expect(useDAWStore.getState().glueSelectedMIDINotes("midi", "clip", [
      noteIdFor("clip", 0, 60),
      noteIdFor("clip", 0.5, 60),
    ])).toEqual([]);
    expect(useDAWStore.getState().canUndo).toBe(false);
  });
});
