import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";
import { serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";

const originalState = useDAWStore.getState();

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 0,
    duration: 4,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function sourceMIDIClip(): MIDIClip {
  return {
    id: "midi-source",
    name: "MIDI source",
    startTime: 1,
    duration: 8,
    offset: 2,
    sourceStart: 0,
    sourceLength: 12,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 12,
    events: [
      { timestamp: 2.5, type: "noteOn", note: 60, velocity: 100 },
      { timestamp: 3.5, type: "noteOff", note: 60, velocity: 0 },
      { timestamp: 4.5, type: "noteOn", note: 62, velocity: 100 },
      { timestamp: 5.5, type: "noteOff", note: 62, velocity: 0 },
      { timestamp: 7.5, type: "noteOn", note: 64, velocity: 100 },
      { timestamp: 8.5, type: "noteOff", note: 64, velocity: 0 },
    ],
    ccEvents: [
      { cc: 1, time: 3, value: 30 },
      { cc: 1, time: 5, value: 50 },
      { cc: 1, time: 8, value: 80 },
    ],
    color: "#f72585",
  };
}

function serializedSummary(clip: MIDIClip) {
  return serializeMIDIClipsForBackend([clip])[0].events.map((event) => ({
    type: event.type,
    timestamp: event.timestamp,
    note: event.note,
    value: event.value,
  }));
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState((state) => ({
    tracks: [],
    markers: [],
    regions: [],
    tempoMarkers: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    selectedNoteIds: [],
    timeSelection: null,
    clipboard: { clip: null, clips: [], isCut: false },
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    moveEnvelopesWithItems: true,
    transport: { ...state.transport, currentTime: 0, tempo: 120 },
    syncClipsWithBackend: vi.fn(async () => undefined),
    syncMIDITrackToBackend: vi.fn(async () => undefined),
    canUndo: false,
    canRedo: false,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("atomic time-selection editing", () => {
  it("deep-copies and cuts MIDI source windows with correct note/CC playback visibility", () => {
    const track = createDefaultTrack("midi", "MIDI", "#f72585", "midi", []);
    const source = sourceMIDIClip();
    track.midiClips = [source];
    useDAWStore.setState({
      tracks: [track],
      timeSelection: { start: 3, end: 6 },
      selectedClipId: source.id,
      selectedClipIds: [source.id],
    });

    useDAWStore.getState().copyWithinTimeSelection();
    const copied = useDAWStore.getState().clipboard.clip as MIDIClip;
    expect(copied).toMatchObject({ startTime: 3, duration: 3, offset: 4 });
    expect(copied.events).not.toBe(source.events);
    expect(copied.ccEvents).not.toBe(source.ccEvents);
    expect(serializedSummary(copied)).toEqual([
      { type: "noteOn", timestamp: 0.5, note: 62, value: undefined },
      { type: "cc", timestamp: 1, note: undefined, value: 50 },
      { type: "noteOff", timestamp: 1.5, note: 62, value: undefined },
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.getState().cutWithinTimeSelection();
    let state = useDAWStore.getState();
    const fragments = state.tracks[0].midiClips;
    expect(fragments.map((clip) => [clip.startTime, clip.duration, clip.offset]))
      .toEqual([[1, 2, 2], [6, 3, 7]]);
    expect(serializedSummary(fragments[0])).toEqual([
      { type: "noteOn", timestamp: 0.5, note: 60, value: undefined },
      { type: "cc", timestamp: 1, note: undefined, value: 30 },
      { type: "noteOff", timestamp: 1.5, note: 60, value: undefined },
    ]);
    expect(serializedSummary(fragments[1])).toEqual([
      { type: "noteOn", timestamp: 0.5, note: 64, value: undefined },
      { type: "cc", timestamp: 1, note: undefined, value: 80 },
      { type: "noteOff", timestamp: 1.5, note: 64, value: undefined },
    ]);
    expect(state.clipboard).toMatchObject({ isCut: true, sourceRemoved: true });
    expect(commandManager.getUndoStack()).toHaveLength(1);
    const fragmentIds = fragments.map((clip) => clip.id);

    state.undo();
    expect(useDAWStore.getState().tracks[0].midiClips).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].midiClips[0]).toMatchObject({
      id: source.id,
      startTime: 1,
      duration: 8,
      offset: 2,
    });
    state = useDAWStore.getState();
    state.redo();
    expect(useDAWStore.getState().tracks[0].midiClips.map((clip) => clip.id))
      .toEqual(fragmentIds);
  });

  it("ripple-deletes mixed audio/MIDI, automation, markers, and regions in one command", () => {
    const audio = createDefaultTrack("audio", "Audio", "#38bdf8", "audio", []);
    audio.clips = [audioClip("audio", { startTime: 1, duration: 5 })];
    audio.automationLanes = [{
      id: "lane",
      param: "volume",
      points: [
        { id: "before", time: 1, value: 0.1 },
        { id: "inside", time: 3, value: 0.3 },
        { id: "after", time: 5, value: 0.5 },
      ],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    const midi = createDefaultTrack("midi", "MIDI", "#f72585", "midi", []);
    midi.midiClips = [{ ...sourceMIDIClip(), startTime: 0, duration: 6, offset: 0 }];
    useDAWStore.setState({
      tracks: [audio, midi],
      timeSelection: { start: 2, end: 4 },
      markers: [
        { id: "inside", time: 3, name: "Inside", color: "#fff" },
        { id: "after", time: 5, name: "After", color: "#fff" },
      ],
      regions: [{ id: "region", name: "Span", startTime: 1, endTime: 5, color: "#fff" }],
      selectedClipId: "midi-source",
      selectedClipIds: ["audio", "midi-source"],
    });

    const action = getRegisteredAction("edit.deleteWithinSelection")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    let state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => [clip.startTime, clip.duration, clip.offset]))
      .toEqual([[1, 1, 0], [2, 2, 3]]);
    expect(state.tracks[1].midiClips.map((clip) => [clip.startTime, clip.duration, clip.offset]))
      .toEqual([[0, 2, 0], [2, 2, 4]]);
    expect(state.tracks[0].automationLanes[0].points.map((point) => [point.id, point.time]))
      .toEqual([["before", 1], ["after", 3]]);
    expect(state.markers).toEqual([{ id: "after", time: 3, name: "After", color: "#fff" }]);
    expect(state.regions).toEqual([{ id: "region", name: "Span", startTime: 1, endTime: 3, color: "#fff" }]);
    expect(state.timeSelection).toBeNull();
    expect(commandManager.getUndoStack()).toHaveLength(1);
    const idsAfterDelete = state.tracks.flatMap((track) => [
      ...track.clips.map((clip) => clip.id),
      ...track.midiClips.map((clip) => clip.id),
    ]);

    state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points.map((point) => point.id))
      .toEqual(["before", "inside", "after"]);
    state = useDAWStore.getState();
    state.redo();
    expect(useDAWStore.getState().tracks.flatMap((track) => [
      ...track.clips.map((clip) => clip.id),
      ...track.midiClips.map((clip) => clip.id),
    ])).toEqual(idsAfterDelete);
  });

  it("deletes mixed razor content atomically without touching locked clips", () => {
    const audio = createDefaultTrack("audio", "Audio", "#38bdf8", "audio", []);
    audio.clips = [audioClip("locked", { startTime: 0, locked: true })];
    audio.automationLanes = [{
      id: "lane",
      param: "volume",
      points: [
        { id: "keep", time: 0.5, value: 0.25 },
        { id: "remove", time: 1.5, value: 0.75 },
      ],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    const midi = createDefaultTrack("midi", "MIDI", "#f72585", "midi", []);
    midi.midiClips = [{ ...sourceMIDIClip(), startTime: 0, duration: 4, offset: 0 }];
    useDAWStore.setState({
      tracks: [audio, midi],
      razorEdits: [
        { trackId: "audio", start: 1, end: 2 },
        { trackId: "midi", start: 1, end: 2 },
      ],
    });

    const action = getRegisteredAction("edit.delete")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    let state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.id)).toEqual(["locked"]);
    expect(state.tracks[0].automationLanes[0].points.map((point) => point.id)).toEqual(["keep"]);
    expect(state.tracks[1].midiClips.map((clip) => [clip.startTime, clip.duration, clip.offset]))
      .toEqual([[0, 1, 0], [2, 2, 2]]);
    expect(state.razorEdits).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    const midiFragmentIds = state.tracks[1].midiClips.map((clip) => clip.id);

    state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points.map((point) => point.id))
      .toEqual(["keep", "remove"]);
    expect(useDAWStore.getState().tracks[1].midiClips).toHaveLength(1);
    expect(useDAWStore.getState().razorEdits).toHaveLength(2);
    state = useDAWStore.getState();
    state.redo();
    expect(useDAWStore.getState().tracks[1].midiClips.map((clip) => clip.id))
      .toEqual(midiFragmentIds);
  });

  it("applies item, envelope, marker, global, and time-selection locks independently", () => {
    const runInsert = (locks: {
      items: boolean;
      envelopes: boolean;
      timeSelection: boolean;
      markers: boolean;
    }) => {
      commandManager.clear();
      const track = createDefaultTrack("audio", "Audio", "#38bdf8", "audio", []);
      track.clips = [audioClip("audio", { startTime: 3 })];
      track.automationLanes = [{
        id: "lane",
        param: "volume",
        points: [{ id: "point", time: 3.5, value: 0.5 }],
        visible: true,
        mode: "read",
        armed: false,
        readEnabled: true,
      }];
      useDAWStore.setState({
        tracks: [track],
        timeSelection: { start: 1, end: 2 },
        markers: [{ id: "marker", time: 3, name: "Marker", color: "#fff" }],
        globalLocked: false,
        lockSettings: locks,
        canUndo: false,
        canRedo: false,
      });
      useDAWStore.getState().insertSilenceAtTimeSelection();
      return useDAWStore.getState();
    };

    let state = runInsert({ items: true, envelopes: false, timeSelection: false, markers: false });
    expect(state.tracks[0].clips[0].startTime).toBe(3);
    expect(state.tracks[0].automationLanes[0].points[0].time).toBe(4.5);
    expect(state.markers[0].time).toBe(4);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state = runInsert({ items: false, envelopes: true, timeSelection: false, markers: false });
    expect(state.tracks[0].clips[0].startTime).toBe(4);
    expect(state.tracks[0].automationLanes[0].points[0].time).toBe(3.5);
    expect(state.markers[0].time).toBe(4);

    state = runInsert({ items: false, envelopes: false, timeSelection: false, markers: true });
    expect(state.tracks[0].clips[0].startTime).toBe(4);
    expect(state.tracks[0].automationLanes[0].points[0].time).toBe(4.5);
    expect(state.markers[0].time).toBe(3);

    state = runInsert({ items: true, envelopes: true, timeSelection: false, markers: true });
    expect(state.tracks[0].clips[0].startTime).toBe(3);
    expect(state.tracks[0].automationLanes[0].points[0].time).toBe(3.5);
    expect(state.markers[0].time).toBe(3);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(getRegisteredAction("edit.insertSilence")!.canHandleShortcut?.()).toBe(false);

    state = runInsert({ items: false, envelopes: true, timeSelection: true, markers: true });
    expect(state.tracks[0].clips[0].startTime).toBe(4);
    expect(state.timeSelection).toEqual({ start: 1, end: 2 });

    commandManager.clear();
    useDAWStore.setState({ globalLocked: true, canUndo: false, canRedo: false });
    expect(getRegisteredAction("edit.insertSilence")!.canHandleShortcut?.()).toBe(false);
    useDAWStore.getState().insertSilenceAtTimeSelection();
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(4);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("locks set/clear/deselect time-selection mutations without blocking other deselection", () => {
    useDAWStore.setState({
      timeSelection: { start: 1, end: 2 },
      selectedClipId: "stale",
      selectedClipIds: ["stale"],
      lockSettings: { items: false, envelopes: false, timeSelection: true, markers: false },
    });
    useDAWStore.getState().setTimeSelection(3, 4);
    useDAWStore.getState().clearTimeSelection();
    useDAWStore.getState().deselectAll();
    expect(useDAWStore.getState().timeSelection).toEqual({ start: 1, end: 2 });
    expect(useDAWStore.getState().selectedClipIds).toEqual([]);

    useDAWStore.setState({ globalLocked: true });
    useDAWStore.getState().setTimeSelection(5, 6);
    useDAWStore.getState().clearTimeSelection();
    expect(useDAWStore.getState().timeSelection).toEqual({ start: 1, end: 2 });

    useDAWStore.setState({
      globalLocked: false,
      lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    });
    useDAWStore.getState().clearTimeSelection();
    expect(useDAWStore.getState().timeSelection).toBeNull();
  });
});
