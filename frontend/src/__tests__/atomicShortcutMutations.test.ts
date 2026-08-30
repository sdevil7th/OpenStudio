import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  type MidiEditorSession,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 0,
    duration: 1,
    offset: 0,
    color: "#224466",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function midiClip(id: string, overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id,
    name: id,
    startTime: 0,
    duration: 1,
    sourceLength: 1,
    loopLength: 1,
    events: [],
    ccEvents: [],
    color: "#664422",
    ...overrides,
  };
}

function midiSession(clipId: string): MidiEditorSession {
  return {
    sessionId: `session-${clipId}`,
    trackId: "midi",
    clipId,
    mode: "docked",
    selectedNoteIds: ["note-a"],
    midiEditRange: { startTime: 0, endTime: 1, minNote: 36, maxNote: 84, includeCC: true },
    editCursorTime: 0.5,
    activeTool: "select",
    visibleLanes: [],
    activeLaneId: "velocity",
    scrollY: 0,
    windowPixelsPerSecond: 100,
    windowScrollX: 0,
    openedAt: 1,
    updatedAt: 1,
  };
}

function resetProject() {
  commandManager.clear();
  useDAWStore.setState({
    tracks: [],
    trackGroups: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    selectedClipId: null,
    selectedClipIds: [],
    selectedNoteIds: [],
    selectedAutomationTarget: null,
    selectedRegionIds: [],
    timeSelection: null,
    razorEdits: [],
    midiEditRange: null,
    pianoRollEditCursorTime: null,
    midiEditorSessions: [],
    activeMidiEditorSessionId: null,
    dockedMidiEditorSessionId: null,
    detachedPanels: [],
    showPianoRoll: false,
    pianoRollTrackId: null,
    pianoRollClipId: null,
    showPitchEditor: false,
    pitchEditorTrackId: null,
    pitchEditorClipId: null,
    pitchEditorFxIndex: 0,
    rippleMode: "off",
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    canUndo: false,
    canRedo: false,
    syncClipsWithBackend: vi.fn(async () => undefined),
    syncMIDITrackToBackend: vi.fn(async () => undefined),
  });
}

beforeEach(resetProject);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("atomic Timeline shortcut mutations", () => {
  it("deselects zero-time cursors and selection stored in every MIDI editor session", () => {
    const session = {
      ...midiSession("midi-clip"),
      selectedNoteIds: ["session-note"],
      editCursorTime: 0,
    };
    useDAWStore.setState({
      selectedNoteIds: [],
      midiEditRange: null,
      pianoRollEditCursorTime: 0,
      midiEditorSessions: [session],
    });

    const action = getRegisteredAction("edit.deselectAll")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();

    const state = useDAWStore.getState();
    expect(state.pianoRollEditCursorTime).toBeNull();
    expect(state.midiEditorSessions[0].selectedNoteIds).toEqual([]);
    expect(state.midiEditorSessions[0].midiEditRange).toBeNull();
    expect(state.midiEditorSessions[0].editCursorTime).toBeNull();
  });

  it("keeps a selected track safe when the higher-priority clip selection is locked", () => {
    const track = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    track.clips = [audioClip("locked-clip", { locked: true })];
    const deleteSelectedTracks = vi.fn(async () => undefined);
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: "locked-clip",
      selectedClipIds: ["locked-clip"],
      deleteSelectedTracks,
    });

    const action = getRegisteredAction("edit.delete")!;
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();

    expect(useDAWStore.getState().tracks).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["locked-clip"]);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("keeps lower-priority clip and track selections safe when razor content is locked", () => {
    const track = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    track.clips = [
      audioClip("razor-locked", { startTime: 0, duration: 1, locked: true }),
      audioClip("lower-priority", { startTime: 2, duration: 1 }),
    ];
    const deleteSelectedTracks = vi.fn(async () => undefined);
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: "lower-priority",
      selectedClipIds: ["lower-priority"],
      razorEdits: [{ trackId: track.id, start: 0, end: 1 }],
      deleteSelectedTracks,
    });

    const action = getRegisteredAction("edit.delete")!;
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();

    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual([
      "razor-locked",
      "lower-priority",
    ]);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("keeps a selected track safe when the higher-priority time selection is locked", () => {
    const track = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    track.clips = [audioClip("time-target", { startTime: 0, duration: 2 })];
    const deleteSelectedTracks = vi.fn(async () => undefined);
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      timeSelection: { start: 0, end: 1 },
      lockSettings: { items: true, envelopes: false, timeSelection: false, markers: false },
      deleteSelectedTracks,
    });

    const action = getRegisteredAction("edit.delete")!;
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();

    expect(useDAWStore.getState().tracks).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["time-target"]);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("applies one Global Lock policy to structural track hotkeys in Timeline, TCP, and mixer contexts", async () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    const second = createDefaultTrack("second", "Second", "#222", "audio", [first]);
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    const addTrack = vi.spyOn(nativeBridge, "addTrack")
      .mockImplementation(async (explicitId) => explicitId || "generated-track");
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["second"],
      globalLocked: true,
    });

    const timelineDelete = getRegisteredAction("edit.delete")!;
    const tcpDelete = getRegisteredAction("track.deleteSelected")!;
    const duplicate = getRegisteredAction("track.duplicateSelected")!;
    const group = getRegisteredAction("track.groupSelectedIntoFolder")!;
    const moveUp = getRegisteredAction("track.moveSelectedUp")!;
    for (const action of [timelineDelete, tcpDelete, duplicate, group, moveUp]) {
      expect(action.canHandleShortcut?.()).toBe(false);
      action.execute();
    }
    await useDAWStore.getState().deleteSelectedTracks();
    await useDAWStore.getState().duplicateSelectedTracks();
    expect(useDAWStore.getState().groupSelectedTracksIntoFolder()).toBe(false);
    expect(useDAWStore.getState().moveSelectedTracks("up")).toBe(false);

    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["first", "second"]);
    expect(removeTrack).not.toHaveBeenCalled();
    expect(addTrack).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);

    const muteAction = getRegisteredAction("track.toggleSelectedMute")!;
    expect(muteAction.canHandleShortcut?.()).toBe(true);
    muteAction.execute();
    expect(useDAWStore.getState().tracks[1].muted).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("inserts an empty audio item only on an eligible track with one stable undo", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", [audio]);
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedTrackId: "midi",
      selectedTrackIds: ["midi"],
      transport: { ...useDAWStore.getState().transport, currentTime: -5 },
    });

    const action = getRegisteredAction("insert.emptyItem")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    let state = useDAWStore.getState();
    expect(state.tracks[0].clips).toHaveLength(1);
    expect(state.tracks[0].clips[0]).toMatchObject({ startTime: 0, duration: 4, filePath: "" });
    expect(state.tracks[1].clips).toHaveLength(0);
    const clipId = state.tracks[0].clips[0].id;
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(0);
    state.redo();
    expect(useDAWStore.getState().tracks[0].clips[0].id).toBe(clipId);

    useDAWStore.getState().undo();
    commandManager.clear();
    useDAWStore.setState({ globalLocked: true, canUndo: false, canRedo: false });
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("inserts an empty MIDI clip only when item editing and its target track are available", () => {
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.frozen = true;
    useDAWStore.setState({
      tracks: [midi],
      selectedTrackId: midi.id,
      selectedTrackIds: [midi.id],
      transport: { ...useDAWStore.getState().transport, currentTime: 2 },
    });
    const action = getRegisteredAction("insert.emptyMidiClip")!;
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(useDAWStore.getState().tracks[0].midiClips).toEqual([]);

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => ({ ...track, frozen: false })),
      lockSettings: { ...state.lockSettings, items: true },
    }));
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, items: false },
    }));
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    let state = useDAWStore.getState();
    expect(state.tracks[0].midiClips).toHaveLength(1);
    expect(state.tracks[0].midiClips[0]).toMatchObject({ startTime: 2, duration: 4 });
    const clipId = state.tracks[0].midiClips[0].id;
    expect(commandManager.getUndoStack()).toHaveLength(1);
    state.undo();
    expect(useDAWStore.getState().tracks[0].midiClips).toEqual([]);
    state.redo();
    expect(useDAWStore.getState().tracks[0].midiClips[0].id).toBe(clipId);
  });

  it("deletes a mixed clip selection before selected tracks in one undo step", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [
      audioClip("audio-open"),
      audioClip("audio-locked", { startTime: 2, locked: true }),
    ];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-open")];
    const session = midiSession("midi-open");
    const deleteSelectedTracks = vi.fn(async () => undefined);
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedTrackId: "audio",
      selectedTrackIds: ["audio"],
      selectedClipId: "midi-open",
      selectedClipIds: ["audio-open", "audio-locked", "midi-open"],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      dockedMidiEditorSessionId: session.sessionId,
      showPianoRoll: true,
      pianoRollTrackId: "midi",
      pianoRollClipId: "midi-open",
      selectedNoteIds: ["note-a"],
      deleteSelectedTracks,
    });

    getRegisteredAction("edit.delete")!.execute();
    let state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.id)).toEqual(["audio-locked"]);
    expect(state.tracks[1].midiClips).toEqual([]);
    expect(state.selectedClipIds).toEqual(["audio-locked"]);
    expect(state.midiEditorSessions).toEqual([]);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.id)).toEqual(["audio-open", "audio-locked"]);
    expect(state.tracks[1].midiClips.map((clip) => clip.id)).toEqual(["midi-open"]);
    expect(state.selectedClipIds).toEqual(["audio-open", "audio-locked", "midi-open"]);
    expect(state.midiEditorSessions.map((entry) => entry.sessionId)).toEqual([session.sessionId]);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    state.redo();
    expect(useDAWStore.getState().tracks[1].midiClips).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("duplicates mixed audio/MIDI clips with stable ids as one command", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [audioClip("audio-source", { startTime: 1, duration: 2 })];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-source", { startTime: 4, duration: 3 })];
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedClipId: "midi-source",
      selectedClipIds: ["audio-source", "midi-source"],
    });

    getRegisteredAction("edit.duplicateClips")!.execute();
    let state = useDAWStore.getState();
    const duplicateIds = [...state.selectedClipIds];
    expect(duplicateIds).toHaveLength(2);
    expect(state.tracks[0].clips[1]).toMatchObject({ id: duplicateIds[0], startTime: 3 });
    expect(state.tracks[1].midiClips[1]).toMatchObject({ id: duplicateIds[1], startTime: 7 });
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    expect(useDAWStore.getState().selectedClipIds).toEqual(["audio-source", "midi-source"]);
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(1);
    state.redo();
    state = useDAWStore.getState();
    expect(state.selectedClipIds).toEqual(duplicateIds);
    expect(state.tracks[0].clips[1].id).toBe(duplicateIds[0]);
    expect(state.tracks[1].midiClips[1].id).toBe(duplicateIds[1]);
  });

  it("deep-clones nested audio takes/envelopes and MIDI source data", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [audioClip("audio-source", {
      gainEnvelope: [{ time: 0.25, gain: 0.75 }],
      takes: [audioClip("nested-take", {
        gainEnvelope: [{ time: 0.5, gain: 0.5 }],
      })],
    })];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-source", {
      events: [{ timestamp: 0, type: "noteOn", note: 60, velocity: 100 }],
      ccEvents: [{ cc: 1, time: 0, value: 64 }],
      quantizeBackup: {
        events: [{ timestamp: 0.1, type: "noteOn", note: 61, velocity: 90 }],
        ccEvents: [{ cc: 11, time: 0.1, value: 80 }],
      },
    })];
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedClipId: "midi-source",
      selectedClipIds: ["audio-source", "midi-source"],
    });

    const duplicateIds = useDAWStore.getState().duplicateSelectedClips();
    const state = useDAWStore.getState();
    const sourceAudio = state.tracks[0].clips[0];
    const duplicateAudio = state.tracks[0].clips[1];
    const sourceMidi = state.tracks[1].midiClips[0];
    const duplicateMidi = state.tracks[1].midiClips[1];
    expect(duplicateAudio.gainEnvelope).not.toBe(sourceAudio.gainEnvelope);
    expect(duplicateAudio.takes).not.toBe(sourceAudio.takes);
    expect(duplicateAudio.takes?.[0]).not.toBe(sourceAudio.takes?.[0]);
    expect(duplicateAudio.takes?.[0].id).not.toBe(sourceAudio.takes?.[0].id);
    expect(duplicateMidi.events).not.toBe(sourceMidi.events);
    expect(duplicateMidi.events[0]).not.toBe(sourceMidi.events[0]);
    expect(duplicateMidi.ccEvents).not.toBe(sourceMidi.ccEvents);
    expect(duplicateMidi.quantizeBackup).not.toBe(sourceMidi.quantizeBackup);

    duplicateAudio.gainEnvelope![0].gain = 1.5;
    duplicateAudio.takes![0].gainEnvelope![0].gain = 1.25;
    duplicateMidi.events[0].note = 72;
    duplicateMidi.ccEvents![0].value = 127;
    duplicateMidi.quantizeBackup!.events[0].note = 73;
    expect(sourceAudio.gainEnvelope![0].gain).toBe(0.75);
    expect(sourceAudio.takes![0].gainEnvelope![0].gain).toBe(0.5);
    expect(sourceMidi.events[0].note).toBe(60);
    expect(sourceMidi.ccEvents![0].value).toBe(64);
    expect(sourceMidi.quantizeBackup!.events[0].note).toBe(61);

    state.undo();
    state.redo();
    expect(useDAWStore.getState().selectedClipIds).toEqual(duplicateIds);
  });

  it("closes deleted native MIDI windows and pitch ownership without phantom undo state", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [audioClip("pitch-source")];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-source")];
    const session = { ...midiSession("midi-source"), mode: "windowed" as const };
    const closeMidiEditorWindow = vi.spyOn(nativeBridge, "closeMidiEditorWindow").mockResolvedValue(true);
    const closePitchEditor = vi.fn(() => useDAWStore.setState({
      showPitchEditor: false,
      pitchEditorTrackId: null,
      pitchEditorClipId: null,
      pitchEditorFxIndex: 0,
    }));
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedClipId: "midi-source",
      selectedClipIds: ["pitch-source", "midi-source"],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      dockedMidiEditorSessionId: null,
      detachedPanels: ["midiEditor"],
      showPianoRoll: false,
      pianoRollTrackId: "midi",
      pianoRollClipId: "midi-source",
      showPitchEditor: true,
      pitchEditorTrackId: "audio",
      pitchEditorClipId: "pitch-source",
      closePitchEditor,
    });

    expect(useDAWStore.getState().deleteSelectedClips()).toBe(true);
    expect(closeMidiEditorWindow).toHaveBeenCalledWith(session.sessionId, "sourceDelete");
    expect(closePitchEditor).toHaveBeenCalledTimes(1);
    expect(useDAWStore.getState().midiEditorSessions).toEqual([]);
    expect(useDAWStore.getState().showPitchEditor).toBe(false);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].id).toBe("pitch-source");
    expect(useDAWStore.getState().tracks[1].midiClips[0].id).toBe("midi-source");
    expect(useDAWStore.getState().midiEditorSessions).toEqual([]);
    expect(useDAWStore.getState().detachedPanels).not.toContain("midiEditor");
    expect(useDAWStore.getState().showPitchEditor).toBe(false);
  });

  it("groups and ungroups mixed audio/MIDI items with shared selection semantics", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [audioClip("audio-source")];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-source")];
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedClipId: "midi-source",
      selectedClipIds: ["audio-source", "midi-source"],
    });

    expect(useDAWStore.getState().groupSelectedClips()).toBe(true);
    const groupId = useDAWStore.getState().tracks[0].clips[0].groupId;
    expect(groupId).toBeTruthy();
    expect(useDAWStore.getState().tracks[1].midiClips[0].groupId).toBe(groupId);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().selectClip("midi-source");
    expect(useDAWStore.getState().selectedClipIds).toEqual(["audio-source", "midi-source"]);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].groupId).toBeUndefined();
    expect(useDAWStore.getState().tracks[1].midiClips[0].groupId).toBeUndefined();

    useDAWStore.getState().redo();
    commandManager.clear();
    expect(useDAWStore.getState().ungroupSelectedClips()).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips[0].groupId).toBeUndefined();
    expect(useDAWStore.getState().tracks[1].midiClips[0].groupId).toBeUndefined();
  });

  it("quantizes unlocked audio and MIDI timeline items in one undo step", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [
      audioClip("audio-source", { startTime: 0.13 }),
      audioClip("locked", { startTime: 0.37, locked: true }),
    ];
    audio.automationLanes = [{
      id: "volume-lane",
      param: "volume",
      points: [{ id: "point", time: 0.2, value: 0.5 }],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-source", { startTime: 0.26 })];
    const syncAudio = vi.fn(async () => undefined);
    const syncMIDI = vi.fn(async () => undefined);
    useDAWStore.setState((current) => ({
      tracks: [audio, midi],
      selectedClipId: "midi-source",
      selectedClipIds: ["audio-source", "locked", "midi-source"],
      transport: { ...current.transport, tempo: 120 },
      gridSize: "1/16",
      quantizePresetId: "factory-1/16",
      moveEnvelopesWithItems: true,
      syncClipsWithBackend: syncAudio,
      syncMIDITrackToBackend: syncMIDI,
    }));

    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.startTime))
      .toEqual([0.125, 0.37]);
    expect(useDAWStore.getState().tracks[1].midiClips[0].startTime).toBe(0.25);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].time).toBeCloseTo(0.195);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(syncAudio).toHaveBeenCalledTimes(1);
    expect(syncMIDI).toHaveBeenCalledWith("midi", { debounce: false });

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(0.13);
    expect(useDAWStore.getState().tracks[1].midiClips[0].startTime).toBe(0.26);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].time).toBe(0.2);
  });

  it("toggles mute and lock per eligible item with one undo each", () => {
    const track = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    track.clips = [
      audioClip("plain"),
      audioClip("muted", { muted: true }),
      audioClip("locked", { locked: true }),
    ];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: "locked",
      selectedClipIds: ["plain", "muted", "locked"],
    });

    getRegisteredAction("edit.muteClips")!.execute();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => [clip.id, !!clip.muted]))
      .toEqual([["plain", true], ["muted", false], ["locked", false]]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => [clip.id, !!clip.muted]))
      .toEqual([["plain", false], ["muted", true], ["locked", false]]);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    getRegisteredAction("edit.toggleClipLock")!.execute();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => [clip.id, !!clip.locked]))
      .toEqual([["plain", true], ["muted", true], ["locked", false]]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => [clip.id, !!clip.locked]))
      .toEqual([["plain", false], ["muted", false], ["locked", true]]);
  });

  it("does not create history when every selected edit target is missing or locked", () => {
    const track = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    track.clips = [audioClip("locked", { locked: true })];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: "locked",
      selectedClipIds: ["missing", "locked"],
    });
    expect(useDAWStore.getState().deleteSelectedClips()).toBe(false);
    expect(useDAWStore.getState().toggleSelectedClipsMuted()).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("enforces global, item, and per-clip locks in keyboard, wheel, and direct mutation paths", () => {
    const track = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    track.clips = [audioClip("clip", { startTime: 1, volumeDB: 0, fadeIn: 0, fadeOut: 0 })];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: "clip",
      selectedClipIds: ["clip"],
    });

    const attemptAllEntrypoints = () => {
      const state = useDAWStore.getState();
      state.setClipVolume("clip", 6); // Timeline wheel and volume-line endpoint.
      state.beginClipFadeEdit("clip");
      state.previewClipFades("clip", 0.25, 0.25);
      state.commitClipFadeEdit("clip");
      state.toggleClipMute("clip");
      state.nudgeClips("right", false);
      state.setClipColor("clip", "#abcdef");
      getRegisteredAction("edit.muteClips")!.execute();
    };
    const expectUnchanged = () => {
      expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({
        startTime: 1,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        color: "#224466",
      });
      expect(Boolean(useDAWStore.getState().tracks[0].clips[0].muted)).toBe(false);
      expect(commandManager.getUndoStack()).toHaveLength(0);
    };

    useDAWStore.setState({ globalLocked: true });
    attemptAllEntrypoints();
    expectUnchanged();

    useDAWStore.setState({
      globalLocked: false,
      lockSettings: { ...useDAWStore.getState().lockSettings, items: true },
    });
    attemptAllEntrypoints();
    expectUnchanged();

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, items: false },
      tracks: state.tracks.map((candidate) => ({
        ...candidate,
        clips: candidate.clips.map((clip) => ({ ...clip, locked: true })),
      })),
    }));
    attemptAllEntrypoints();
    expectUnchanged();
  });
});

describe("selection semantics", () => {
  it("clears every main-realm selection without creating undo history", () => {
    const track = createDefaultTrack("track", "Track", "#111", "midi", []);
    track.midiClips = [midiClip("clip")];
    const session = midiSession("clip");
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: "track",
      selectedTrackIds: ["track"],
      lastSelectedTrackId: "track",
      selectedClipId: "clip",
      selectedClipIds: ["clip"],
      selectedNoteIds: ["note-a"],
      selectedAutomationTarget: { kind: "track", trackId: "track", laneId: "lane", pointId: "point" },
      selectedRegionIds: ["region"],
      timeSelection: { start: 1, end: 2 },
      razorEdits: [{ trackId: "track", start: 1, end: 2 }],
      midiEditRange: { startTime: 0, endTime: 1, minNote: 36, maxNote: 84, includeCC: true },
      pianoRollEditCursorTime: 0.5,
      midiEditorSessions: [session],
    });

    getRegisteredAction("edit.deselectAll")!.execute();
    expect(useDAWStore.getState()).toMatchObject({
      selectedTrackId: null,
      selectedTrackIds: [],
      lastSelectedTrackId: null,
      selectedClipId: null,
      selectedClipIds: [],
      selectedNoteIds: [],
      selectedAutomationTarget: null,
      selectedRegionIds: [],
      timeSelection: null,
      razorEdits: [],
      midiEditRange: null,
      pianoRollEditCursorTime: null,
    });
    expect(useDAWStore.getState().midiEditorSessions[0]).toMatchObject({
      selectedNoteIds: [],
      midiEditRange: null,
      editCursorTime: null,
    });
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});

describe("atomic selected-track shortcuts", () => {
  it("inserts multiple native tracks with one stable undo command", async () => {
    const addTrack = vi.spyOn(nativeBridge, "addTrack")
      .mockImplementation(async (explicitId) => explicitId || "generated-track");
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    const ids = await useDAWStore.getState().addTracksBatch([
      { id: "batch-a", name: "Audio 1", type: "audio" },
      { id: "batch-b", name: "MIDI 2", type: "midi" },
    ]);
    expect(ids).toEqual(["batch-a", "batch-b"]);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(ids);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(addTrack).toHaveBeenCalledWith("batch-a", "audio");
    expect(addTrack).toHaveBeenCalledWith("batch-b", "midi");

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks).toEqual([]));
    expect(removeTrack.mock.calls.map(([trackId]) => trackId)).toEqual(["batch-b", "batch-a"]);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(ids));
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("coalesces selected folder, automation, and spectral view toggles", () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    const second = createDefaultTrack("second", "Second", "#222", "audio", [first]);
    first.isFolder = true;
    second.isFolder = true;
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["first", "second"],
    });

    for (const actionId of [
      "track.toggleSelectedFolders",
      "track.toggleSelectedAutomation",
      "track.toggleSelectedSpectralView",
    ]) {
      commandManager.clear();
      useDAWStore.setState({ canUndo: false, canRedo: false });
      getRegisteredAction(actionId)!.execute();
      expect(commandManager.getUndoStack(), actionId).toHaveLength(1);
      useDAWStore.getState().undo();
      expect(commandManager.getUndoStack(), actionId).toHaveLength(0);
    }
  });

  it("toggles linked and unlinked track booleans in one undo step", async () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    const linked = createDefaultTrack("linked", "Linked", "#222", "audio", [first]);
    const third = createDefaultTrack("third", "Third", "#333", "audio", [first, linked]);
    third.muted = true;
    third.soloed = true;
    third.monitorEnabled = true;
    third.phaseInverted = true;
    useDAWStore.setState({
      tracks: [first, linked, third],
      selectedTrackId: "first",
      selectedTrackIds: ["first", "linked", "third"],
      trackGroups: [{
        id: "linked-group",
        name: "Linked",
        leadTrackId: "first",
        memberTrackIds: ["first", "linked"],
        linkedParams: ["mute", "solo", "armed", "fxBypass"],
      }],
    });

    getRegisteredAction("track.toggleSelectedMute")!.execute();
    expect(useDAWStore.getState().tracks.map((track) => track.muted)).toEqual([true, true, false]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.muted)).toEqual([false, false, true]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((track) => track.muted)).toEqual([true, true, false]);

    const cases: Array<[string, keyof typeof first, boolean[]]> = [
      ["track.toggleSelectedSolo", "soloed", [true, true, false]],
      ["track.toggleSelectedMonitor", "monitorEnabled", [true, true, false]],
      ["track.toggleSelectedPhaseInvert", "phaseInverted", [true, true, false]],
      ["track.toggleSelectedFxBypass", "fxBypassed", [true, true, true]],
    ];
    for (const [actionId, field, expected] of cases) {
      commandManager.clear();
      useDAWStore.setState({ canUndo: false, canRedo: false });
      getRegisteredAction(actionId)!.execute();
      await vi.waitFor(() => {
        expect(useDAWStore.getState().tracks.map((track) => Boolean(track[field])), actionId)
          .toEqual(expected);
      });
      expect(commandManager.getUndoStack(), actionId).toHaveLength(1);
      useDAWStore.getState().undo();
      expect(commandManager.getUndoStack(), actionId).toHaveLength(0);
      if (actionId === "track.toggleSelectedMonitor") {
        await vi.waitFor(() => {
          expect(useDAWStore.getState().tracks.map((track) => track.monitorEnabled))
            .toEqual([false, false, true]);
        });
      }
    }
  });

  it("arms eligible linked tracks atomically while leaving record-safe tracks untouched", () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    const safe = createDefaultTrack("safe", "Safe", "#222", "audio", [first]);
    safe.recordSafe = true;
    useDAWStore.setState({
      tracks: [first, safe],
      selectedTrackId: "first",
      selectedTrackIds: ["first", "safe"],
      trackGroups: [{
        id: "arm-group",
        name: "Arm",
        leadTrackId: "first",
        memberTrackIds: ["first", "safe"],
        linkedParams: ["armed"],
      }],
    });
    getRegisteredAction("track.toggleSelectedArm")!.execute();
    expect(useDAWStore.getState().tracks.map((track) => track.armed)).toEqual([true, false]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.armed)).toEqual([false, false]);
  });

  it("duplicates a multi-track selection with stable ids in one command", async () => {
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    const second = createDefaultTrack("second", "Second", "#222", "midi", [first]);
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["first", "second"],
    });

    const duplicateIds = await useDAWStore.getState().duplicateSelectedTracks();
    expect(duplicateIds).toHaveLength(2);
    expect(useDAWStore.getState().tracks.map((track) => track.id))
      .toEqual(["first", duplicateIds[0], "second", duplicateIds[1]]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((track) => track.id))
      .toEqual(["first", "second"]));
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["first", "second"]);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((track) => track.id))
      .toEqual(["first", duplicateIds[0], "second", duplicateIds[1]]));
    expect(useDAWStore.getState().selectedTrackIds).toEqual(duplicateIds);
  });

  it("deletes a selected folder subtree and restores it as one native-safe command", async () => {
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    const addTrack = vi.spyOn(nativeBridge, "addTrack")
      .mockImplementation(async (explicitId) => explicitId || "generated-track");
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    const folder = createDefaultTrack("folder", "Folder", "#111", "audio", []);
    folder.isFolder = true;
    folder.clips = [audioClip("pitch-source")];
    const child = createDefaultTrack("child", "Child", "#222", "midi", [folder]);
    child.parentFolderId = "folder";
    child.midiClips = [midiClip("child-clip")];
    const outside = createDefaultTrack("outside", "Outside", "#333", "audio", [folder, child]);
    const session = { ...midiSession("child-clip"), trackId: "child", mode: "windowed" as const };
    const closeMidiEditorWindow = vi.spyOn(nativeBridge, "closeMidiEditorWindow").mockResolvedValue(true);
    const closePitchEditor = vi.fn(() => useDAWStore.setState({
      showPitchEditor: false,
      pitchEditorTrackId: null,
      pitchEditorClipId: null,
      pitchEditorFxIndex: 0,
    }));
    useDAWStore.setState({
      tracks: [folder, child, outside],
      selectedTrackId: "folder",
      selectedTrackIds: ["folder"],
      selectedClipId: "child-clip",
      selectedClipIds: ["child-clip"],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      detachedPanels: ["midiEditor"],
      pianoRollTrackId: "child",
      pianoRollClipId: "child-clip",
      showPitchEditor: true,
      pitchEditorTrackId: "folder",
      pitchEditorClipId: "pitch-source",
      closePitchEditor,
    });

    await useDAWStore.getState().deleteSelectedTracks();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["outside"]);
    expect(useDAWStore.getState().selectedClipIds).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(removeTrack.mock.calls.map(([trackId]) => trackId)).toEqual(["child", "folder"]);
    expect(closeMidiEditorWindow).toHaveBeenCalledWith(session.sessionId, "sourceTrackDelete");
    expect(closePitchEditor).toHaveBeenCalledTimes(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id))
      .toEqual(["folder", "child", "outside"]);
    expect(useDAWStore.getState().tracks[1].parentFolderId).toBe("folder");
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["folder"]);
    expect(useDAWStore.getState().midiEditorSessions).toEqual([]);
    expect(useDAWStore.getState().detachedPanels).not.toContain("midiEditor");
    expect(useDAWStore.getState().showPitchEditor).toBe(false);
    await vi.waitFor(() => expect(addTrack).toHaveBeenCalledWith("folder", "audio"));
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((track) => track.id))
      .toEqual(["outside"]));
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("creates a bus with all selected-track sends as one rollback-safe command", async () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    const second = createDefaultTrack("second", "Second", "#222", "midi", [first]);
    const addTrack = vi.spyOn(nativeBridge, "addTrack")
      .mockImplementation(async (explicitId) => explicitId || "generated-track");
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    const addTrackSend = vi.spyOn(nativeBridge, "addTrackSend").mockResolvedValue(0);
    const removeTrackSend = vi.spyOn(nativeBridge, "removeTrackSend").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["first", "second"],
    });

    const createBusAction = getRegisteredAction("insert.bus")!;
    expect(createBusAction.canHandleShortcut?.()).toBe(true);
    createBusAction.execute();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.some((track) => track.type === "bus")).toBe(true));
    let state = useDAWStore.getState();
    const bus = state.tracks.find((track) => track.type === "bus")!;
    expect(bus).toBeDefined();
    expect(state.tracks.slice(0, 2).map((track) => track.sends.map((send) => send.destTrackId)))
      .toEqual([[bus.id], [bus.id]]);
    expect(addTrack).toHaveBeenCalledWith(bus.id, "bus");
    expect(addTrackSend.mock.calls).toEqual([["first", bus.id], ["second", bus.id]]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["first", "second"]);
    expect(useDAWStore.getState().tracks.every((track) => track.sends.length === 0)).toBe(true);
    await vi.waitFor(() => expect(removeTrack).toHaveBeenCalledWith(bus.id));
    expect(removeTrackSend.mock.calls).toEqual([["second", 0], ["first", 0]]);

    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.some((track) => track.id === bus.id)).toBe(true));
    expect(useDAWStore.getState().tracks.slice(0, 2).map((track) => track.sends.map((send) => send.destTrackId)))
      .toEqual([[bus.id], [bus.id]]);
    expect(addTrack.mock.calls.filter(([trackId]) => trackId === bus.id)).toHaveLength(2);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(removeTrack.mock.calls.filter(([trackId]) => trackId === bus.id)).toHaveLength(2));
    commandManager.clear();
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["first", "second"],
      canUndo: false,
      canRedo: false,
    });
    addTrackSend.mockReset().mockResolvedValueOnce(0).mockResolvedValueOnce(-1);
    removeTrackSend.mockClear();
    removeTrack.mockClear();

    await useDAWStore.getState().createBusFromSelectedTracks();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["first", "second"]);
    expect(useDAWStore.getState().tracks.every((track) => track.sends.length === 0)).toBe(true);
    expect(removeTrackSend).toHaveBeenCalledWith("first", 0);
    expect(removeTrack).toHaveBeenCalledTimes(1);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("clears every eligible selected sampler atomically and rolls a partial native failure back", async () => {
    const first = createDefaultTrack("sampler-a", "Sampler A", "#111", "instrument", []);
    first.samplerSamplePath = "C:/samples/a.wav";
    first.samplerRootNote = 48;
    first.samplerSourceType = "audio";
    const second = createDefaultTrack("sampler-b", "Sampler B", "#222", "instrument", [first]);
    second.samplerSamplePath = "C:/samples/b.sf2";
    second.samplerRootNote = 60;
    second.samplerSourceType = "soundfont";
    const empty = createDefaultTrack("empty", "Empty", "#333", "instrument", [first, second]);
    const clearSample = vi.spyOn(nativeBridge, "clearTrackSamplerSample").mockResolvedValue(true);
    const restoreSample = vi.spyOn(nativeBridge, "setTrackSamplerSample").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [first, second, empty],
      selectedTrackId: "empty",
      selectedTrackIds: ["sampler-a", "sampler-b", "empty"],
    });

    expect(await useDAWStore.getState().clearSelectedTrackSamplerSamples()).toBe(true);
    expect(useDAWStore.getState().tracks.map((track) => track.samplerSamplePath))
      .toEqual([undefined, undefined, undefined]);
    expect(clearSample.mock.calls.map(([trackId]) => trackId)).toEqual(["sampler-a", "sampler-b"]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((track) => track.samplerSamplePath))
      .toEqual(["C:/samples/a.wav", "C:/samples/b.sf2", undefined]));
    expect(restoreSample).toHaveBeenCalledWith("sampler-a", "C:/samples/a.wav", 48);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].samplerSamplePath).toBeUndefined());

    commandManager.clear();
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "sampler-b",
      selectedTrackIds: ["sampler-a", "sampler-b"],
      canUndo: false,
      canRedo: false,
    });
    clearSample.mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    restoreSample.mockClear();
    expect(await useDAWStore.getState().clearSelectedTrackSamplerSamples()).toBe(false);
    expect(useDAWStore.getState().tracks.map((track) => track.samplerSamplePath))
      .toEqual(["C:/samples/a.wav", "C:/samples/b.sf2"]);
    expect(restoreSample).toHaveBeenCalledWith("sampler-a", "C:/samples/a.wav", 48);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("removes plugin and built-in instruments as one reversible selected-track command", async () => {
    const plugin = createDefaultTrack("plugin", "Plugin", "#111", "instrument", []);
    plugin.instrumentPlugin = "C:/plugins/synth.vst3";
    const builtIn = createDefaultTrack("builtin", "Built-in", "#222", "instrument", [plugin]);
    builtIn.builtInInstrument = "piano";
    const plain = createDefaultTrack("plain", "Plain", "#333", "midi", [plugin, builtIn]);
    vi.spyOn(nativeBridge, "getInstrumentState").mockResolvedValue("saved-state");
    const removeInstrument = vi.spyOn(nativeBridge, "removeInstrument").mockResolvedValue(true);
    const setTrackType = vi.spyOn(nativeBridge, "setTrackType").mockResolvedValue(true);
    const loadInstrument = vi.spyOn(nativeBridge, "loadInstrument").mockResolvedValue(true);
    const setInstrumentState = vi.spyOn(nativeBridge, "setInstrumentState").mockResolvedValue(true);
    const setBuiltIn = vi.spyOn(nativeBridge, "setBuiltInPluginParam").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [plugin, builtIn, plain],
      selectedTrackId: "plain",
      selectedTrackIds: ["plugin", "builtin", "plain"],
    });

    expect(await useDAWStore.getState().removeSelectedTrackInstruments()).toBe(true);
    expect(useDAWStore.getState().tracks.map((track) => [track.type, track.instrumentPlugin, track.builtInInstrument]))
      .toEqual([
        ["midi", undefined, undefined],
        ["midi", undefined, undefined],
        ["midi", undefined, undefined],
      ]);
    expect(removeInstrument).toHaveBeenCalledWith("plugin");
    expect(setTrackType).toHaveBeenCalledWith("builtin", "midi");
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].instrumentPlugin)
      .toBe("C:/plugins/synth.vst3"));
    expect(useDAWStore.getState().tracks[1].builtInInstrument).toBe("piano");
    expect(loadInstrument).toHaveBeenCalledWith("plugin", "C:/plugins/synth.vst3");
    expect(setInstrumentState).toHaveBeenCalledWith("plugin", "saved-state");
    expect(setBuiltIn).toHaveBeenCalledWith(
      { trackId: "builtin", chain: "instrument", fxIndex: -1 },
      "instrumentMode",
      1,
    );
  });

  it("rolls back selected instrument removal after a partial native failure", async () => {
    const first = createDefaultTrack("plugin-a", "Plugin A", "#111", "instrument", []);
    first.instrumentPlugin = "C:/plugins/a.vst3";
    const second = createDefaultTrack("plugin-b", "Plugin B", "#222", "instrument", [first]);
    second.instrumentPlugin = "C:/plugins/b.vst3";
    vi.spyOn(nativeBridge, "getInstrumentState").mockResolvedValue("state");
    vi.spyOn(nativeBridge, "removeInstrument")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const loadInstrument = vi.spyOn(nativeBridge, "loadInstrument").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackType").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setInstrumentState").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "plugin-b",
      selectedTrackIds: ["plugin-a", "plugin-b"],
    });

    expect(await useDAWStore.getState().removeSelectedTrackInstruments()).toBe(false);
    expect(useDAWStore.getState().tracks.map((track) => track.instrumentPlugin))
      .toEqual(["C:/plugins/a.vst3", "C:/plugins/b.vst3"]);
    expect(loadInstrument).toHaveBeenCalledWith("plugin-a", "C:/plugins/a.vst3");
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("freezes audio and MIDI selections with one stable command and safe editor cleanup", async () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [audioClip("pitch-source", { startTime: 1, duration: 2 })];
    audio.trackFxCount = 1;
    const midi = createDefaultTrack("midi", "MIDI", "#222", "instrument", [audio]);
    midi.midiClips = [midiClip("midi-source", { startTime: 2, duration: 3 })];
    const empty = createDefaultTrack("empty", "Empty", "#333", "audio", [audio, midi]);
    const docked = { ...midiSession("midi-source"), sessionId: "docked", mode: "docked" as const };
    const windowed = { ...midiSession("midi-source"), sessionId: "windowed", mode: "windowed" as const };
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockImplementation(async (trackId) =>
      trackId === "audio" ? [{ bypassed: false }] : []);
    const freezeTrack = vi.spyOn(nativeBridge, "freezeTrack").mockImplementation(async (trackId) => ({
      success: true,
      filePath: `C:/freeze/${trackId}.wav`,
      startTime: trackId === "audio" ? 1 : 2,
      duration: trackId === "audio" ? 2 : 3,
      sampleRate: 48000,
    }));
    const unfreezeTrack = vi.spyOn(nativeBridge, "unfreezeTrack").mockResolvedValue(true);
    const bypassTrackFX = vi.spyOn(nativeBridge, "bypassTrackFX").mockResolvedValue(true);
    const closeMidiEditorWindow = vi.spyOn(nativeBridge, "closeMidiEditorWindow").mockResolvedValue(true);
    const closePitchEditor = vi.fn(() => useDAWStore.setState({
      showPitchEditor: false,
      pitchEditorTrackId: null,
      pitchEditorClipId: null,
      pitchEditorFxIndex: 0,
    }));
    useDAWStore.setState({
      tracks: [audio, midi, empty],
      selectedTrackId: "empty",
      selectedTrackIds: ["audio", "midi", "empty"],
      midiEditorSessions: [docked, windowed],
      activeMidiEditorSessionId: windowed.sessionId,
      dockedMidiEditorSessionId: docked.sessionId,
      detachedPanels: ["midiEditor"],
      showPianoRoll: true,
      pianoRollTrackId: "midi",
      pianoRollClipId: "midi-source",
      showPitchEditor: true,
      pitchEditorTrackId: "audio",
      pitchEditorClipId: "pitch-source",
      closePitchEditor,
    });

    expect(await useDAWStore.getState().toggleSelectedTracksFreeze()).toBe(true);
    let state = useDAWStore.getState();
    expect(state.tracks.map((track) => track.frozen)).toEqual([true, true, false]);
    expect(state.tracks[0].clips[0]).toMatchObject({ id: "audio_freeze", filePath: "C:/freeze/audio.wav" });
    expect(state.tracks[1].clips[0]).toMatchObject({ id: "midi_freeze", filePath: "C:/freeze/midi.wav" });
    expect(state.tracks[1].midiClips).toEqual([]);
    expect(state.tracks[1].frozenOriginalMIDIClips?.map((clip) => clip.id)).toEqual(["midi-source"]);
    expect(state.midiEditorSessions).toEqual([]);
    expect(closeMidiEditorWindow).toHaveBeenCalledWith("windowed", "sourceFreeze");
    expect(closePitchEditor).toHaveBeenCalledTimes(1);
    expect(bypassTrackFX).toHaveBeenCalledWith("audio", 0, true);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].frozen).toBe(false));
    state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.id)).toEqual(["pitch-source"]);
    expect(state.tracks[1].midiClips.map((clip) => clip.id)).toEqual(["midi-source"]);
    expect(state.midiEditorSessions.map((session) => session.sessionId)).toEqual(["docked"]);
    expect(state.midiEditorSessions.some((session) => session.mode === "windowed")).toBe(false);
    expect(state.showPitchEditor).toBe(false);
    expect(unfreezeTrack).toHaveBeenCalledWith("audio");
    expect(bypassTrackFX).toHaveBeenCalledWith("audio", 0, false);

    state.redo();
    await vi.waitFor(() => expect(
      freezeTrack.mock.calls.filter(([trackId]) => trackId === "audio"),
    ).toHaveLength(2));
    expect(useDAWStore.getState().tracks[0].frozen).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0].id).toBe("audio_freeze");
  });

  it("captures freeze targets at invocation and leaves an empty selection as a true no-op", async () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    first.clips = [audioClip("first-clip")];
    const second = createDefaultTrack("second", "Second", "#222", "audio", [first]);
    second.clips = [audioClip("second-clip")];
    let resolveFreeze: ((value: { success: boolean; filePath: string; duration: number; sampleRate: number }) => void) | null = null;
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "freezeTrack").mockImplementation(() => new Promise((resolve) => {
      resolveFreeze = resolve;
    }));
    vi.spyOn(nativeBridge, "unfreezeTrack").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "first",
      selectedTrackIds: ["first"],
    });

    const pending = useDAWStore.getState().toggleSelectedTracksFreeze();
    await vi.waitFor(() => expect(resolveFreeze).not.toBeNull());
    useDAWStore.setState({ selectedTrackId: "second", selectedTrackIds: ["second"] });
    resolveFreeze!({ success: true, filePath: "C:/freeze/first.wav", duration: 1, sampleRate: 48000 });
    expect(await pending).toBe(true);
    expect(useDAWStore.getState().tracks.map((track) => track.frozen)).toEqual([true, false]);
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["second"]);

    commandManager.clear();
    useDAWStore.setState({
      tracks: [createDefaultTrack("empty", "Empty", "#333", "audio", [])],
      selectedTrackId: "empty",
      selectedTrackIds: ["empty"],
      canUndo: false,
      canRedo: false,
    });
    expect(await useDAWStore.getState().toggleSelectedTracksFreeze()).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("keeps project state/history unchanged when a multi-track freeze render partially fails", async () => {
    const first = createDefaultTrack("first", "First", "#111", "audio", []);
    first.clips = [audioClip("first-clip")];
    const second = createDefaultTrack("second", "Second", "#222", "midi", [first]);
    second.midiClips = [midiClip("second-clip")];
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "freezeTrack")
      .mockResolvedValueOnce({ success: true, filePath: "C:/freeze/first.wav", duration: 1, sampleRate: 48000 })
      .mockResolvedValueOnce({ success: false, error: "render failed" });
    useDAWStore.setState({
      tracks: [first, second],
      selectedTrackId: "second",
      selectedTrackIds: ["first", "second"],
    });

    expect(await useDAWStore.getState().toggleSelectedTracksFreeze()).toBe(false);
    expect(useDAWStore.getState().tracks.map((track) => track.frozen)).toEqual([false, false]);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["first-clip"]);
    expect(useDAWStore.getState().tracks[1].midiClips.map((clip) => clip.id)).toEqual(["second-clip"]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});

describe("atomic multi-item catalog actions", () => {
  it("repeats and recolors mixed selected clips as one undo gesture", () => {
    const audio = createDefaultTrack("audio", "Audio", "#111", "audio", []);
    audio.clips = [audioClip("audio-source")];
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    midi.midiClips = [midiClip("midi-source")];
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedClipId: "midi-source",
      selectedClipIds: ["audio-source", "midi-source"],
    });
    vi.stubGlobal("prompt", vi.fn(() => "2"));

    getRegisteredAction("clip.repeatSelected")!.execute();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(3);
    expect(useDAWStore.getState().tracks[1].midiClips).toHaveLength(3);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(1);
    expect(useDAWStore.getState().tracks[1].midiClips).toHaveLength(1);
    expect(useDAWStore.getState().selectedClipIds).toEqual(["audio-source", "midi-source"]);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    vi.stubGlobal("prompt", vi.fn(() => "#abcdef"));
    getRegisteredAction("clip.setSelectedColor")!.execute();
    expect(useDAWStore.getState().tracks[0].clips[0].color).toBe("#abcdef");
    expect(useDAWStore.getState().tracks[1].midiClips[0].color).toBe("#abcdef");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].color).toBe("#224466");
    expect(useDAWStore.getState().tracks[1].midiClips[0].color).toBe("#664422");
  });

  it("batches MIDI source-window and selected-note transforms across clips", () => {
    const midi = createDefaultTrack("midi", "MIDI", "#222", "midi", []);
    const noteEvents = (note: number) => [
      { timestamp: 0, type: "noteOn" as const, note, velocity: 100 },
      { timestamp: 0.5, type: "noteOff" as const, note, velocity: 0 },
    ];
    midi.midiClips = [
      midiClip("first-midi", { offset: 0.25, loopOffset: 0.25, events: noteEvents(60) }),
      midiClip("second-midi", { offset: 0.5, loopOffset: 0.5, events: noteEvents(64) }),
    ];
    useDAWStore.setState({
      tracks: [midi],
      selectedClipId: "second-midi",
      selectedClipIds: ["first-midi", "second-midi"],
    });

    getRegisteredAction("clip.resetSelectedMidiSourceOffset")!.execute();
    expect(useDAWStore.getState().tracks[0].midiClips.map((clip) => clip.offset)).toEqual([0, 0]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].midiClips.map((clip) => clip.offset)).toEqual([0.25, 0.5]);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    getRegisteredAction("clip.transposeSelectedMidiUp")!.execute();
    expect(useDAWStore.getState().tracks[0].midiClips.map((clip) => clip.events[0].note))
      .toEqual([61, 65]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].midiClips.map((clip) => clip.events[0].note))
      .toEqual([60, 64]);
  });
});
