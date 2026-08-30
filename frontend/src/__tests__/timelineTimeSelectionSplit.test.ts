import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio",
    filePath: "C:/audio.wav",
    name: "Audio",
    startTime: 0,
    duration: 8,
    offset: 1,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0.5,
    fadeOut: 0.75,
    sampleRate: 48_000,
    sourceLength: 16,
    ...overrides,
  };
}

function midiClip(overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id: "midi",
    name: "MIDI",
    startTime: 0,
    duration: 8,
    offset: 2,
    sourceStart: 0,
    sourceLength: 12,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 12,
    events: [
      { timestamp: 1, type: "noteOn", note: 60, velocity: 100 },
      { timestamp: 6, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [{ time: 2, cc: 1, value: 64 }],
    color: "#f72585",
    ...overrides,
  };
}

beforeEach(() => {
  commandManager.clear();
  const audio = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio");
  const midi = createDefaultTrack("midi-track", "MIDI", "#f72585", "midi");
  audio.clips = [audioClip()];
  midi.midiClips = [midiClip()];
  useDAWStore.setState({
    tracks: [audio, midi],
    selectedClipId: "midi",
    selectedClipIds: ["audio", "midi"],
    selectedTrackId: null,
    selectedTrackIds: [],
    timeSelection: { start: 5, end: 2 },
    globalLocked: false,
    lockSettings: { ...originalState.lockSettings, items: false },
    syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
    syncMIDITrackToBackend: vi.fn().mockResolvedValue(undefined),
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("split at time selection", () => {
  it("splits selected audio and MIDI at both normalized boundaries as one stable transaction", () => {
    const state = useDAWStore.getState();
    const syncAudio = state.syncClipsWithBackend as ReturnType<typeof vi.fn>;
    const syncMIDI = state.syncMIDITrackToBackend as ReturnType<typeof vi.fn>;
    const action = getRegisteredAction("edit.splitAtSelection")!;

    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();

    const split = useDAWStore.getState();
    expect(split.tracks[0].clips.map((clip) => [clip.startTime, clip.duration, clip.offset]))
      .toEqual([[0, 2, 1], [2, 3, 3], [5, 3, 6]]);
    expect(split.tracks[1].midiClips.map((clip) => [clip.startTime, clip.duration, clip.offset]))
      .toEqual([[0, 2, 2], [2, 3, 4], [5, 3, 7]]);
    expect(split.selectedClipIds).toHaveLength(6);
    expect(split.selectedClipId).toBe(split.tracks[1].midiClips[2].id);
    expect(new Set(split.selectedClipIds).size).toBe(6);
    expect(split.tracks[1].midiClips[0].events).not.toBe(split.tracks[1].midiClips[1].events);
    expect(syncAudio).toHaveBeenCalledTimes(1);
    expect(syncMIDI).toHaveBeenCalledWith("midi-track", { debounce: false });
    expect(commandManager.getUndoStack()).toHaveLength(1);

    const splitIds = split.tracks.flatMap((track) => [
      ...track.clips.map((clip) => clip.id),
      ...track.midiClips.map((clip) => clip.id),
    ]);
    split.undo();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["audio"]);
    expect(useDAWStore.getState().tracks[1].midiClips.map((clip) => clip.id)).toEqual(["midi"]);
    expect(useDAWStore.getState().selectedClipIds).toEqual(["audio", "midi"]);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.flatMap((track) => [
      ...track.clips.map((clip) => clip.id),
      ...track.midiClips.map((clip) => clip.id),
    ])).toEqual(splitIds);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("honors selected-clip precedence, individual locks, item locks, and exact no-op availability", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, clips: track.clips.map((clip) => ({ ...clip, locked: true })) }
        : track),
      selectedClipId: "audio",
      selectedClipIds: ["audio"],
    }));
    const action = getRegisteredAction("edit.splitAtSelection")!;
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[1].midiClips).toHaveLength(1);

    useDAWStore.setState((state) => ({
      selectedClipId: "midi",
      selectedClipIds: ["midi"],
      lockSettings: { ...state.lockSettings, items: true },
    }));
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, items: false },
      globalLocked: true,
    }));
    expect(action.canHandleShortcut?.()).toBe(false);
    action.execute();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("rejects missing, zero-length, non-finite, and boundary-only selections", () => {
    const action = getRegisteredAction("edit.splitAtSelection")!;
    for (const timeSelection of [
      null,
      { start: 2, end: 2 },
      { start: Number.NaN, end: 3 },
      { start: 0, end: 8 },
    ]) {
      useDAWStore.setState({ timeSelection });
      expect(action.canHandleShortcut?.(), JSON.stringify(timeSelection)).toBe(false);
      action.execute();
      expect(commandManager.getUndoStack()).toHaveLength(0);
    }
  });
});
