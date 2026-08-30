import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";
import { computeSlipOffset } from "../utils/timelineClipGestures";

const originalState = useDAWStore.getState();

function audioClip(): AudioClip {
  return {
    id: "audio-slip",
    filePath: "C:/audio/slip.wav",
    name: "Audio slip",
    startTime: 0,
    duration: 4,
    offset: 1,
    sourceLength: 12,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function midiClip(): MIDIClip {
  return {
    id: "midi-slip",
    name: "MIDI slip",
    startTime: 0,
    duration: 4,
    offset: 1,
    sourceStart: 0,
    sourceLength: 8,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 8,
    events: [],
    ccEvents: [],
    color: "#f72585",
  };
}

beforeEach(() => {
  commandManager.clear();
  const audio = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio", []);
  audio.clips = [audioClip()];
  const midi = createDefaultTrack("midi-track", "MIDI", "#f72585", "midi", []);
  midi.midiClips = [midiClip()];
  useDAWStore.setState({
    tracks: [audio, midi],
    syncMIDITrackToBackend: vi.fn(async () => undefined),
    isModified: false,
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("timeline slip editing", () => {
  it("moves in the expected direction and clamps to the source window", () => {
    expect(computeSlipOffset(5, 2, 10)).toBe(3);
    expect(computeSlipOffset(5, -2, 10)).toBe(7);
    expect(computeSlipOffset(1, 10, 10)).toBe(0);
    expect(computeSlipOffset(9, -10, 10)).toBe(10);
  });

  it("commits one undoable audio offset change and preserves no-op state", () => {
    useDAWStore.getState().slipEditClip("audio-slip", 3);
    expect(useDAWStore.getState().tracks[0].clips[0].offset).toBe(3);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().isModified).toBe(true);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].offset).toBe(1);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].offset).toBe(3);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false, isModified: false });
    useDAWStore.getState().slipEditClip("audio-slip", 3);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().isModified).toBe(false);
  });

  it("commits and synchronizes MIDI slip edits through undo and redo", async () => {
    const sync = useDAWStore.getState().syncMIDITrackToBackend;
    useDAWStore.getState().slipEditClip("midi-slip", 2.5);
    await Promise.resolve();
    expect(useDAWStore.getState().tracks[1].midiClips[0].offset).toBe(2.5);
    expect(sync).toHaveBeenLastCalledWith("midi-track", { debounce: false });

    useDAWStore.getState().undo();
    await Promise.resolve();
    expect(useDAWStore.getState().tracks[1].midiClips[0].offset).toBe(1);
    useDAWStore.getState().redo();
    await Promise.resolve();
    expect(useDAWStore.getState().tracks[1].midiClips[0].offset).toBe(2.5);
    expect(sync).toHaveBeenCalledTimes(3);
  });
});
