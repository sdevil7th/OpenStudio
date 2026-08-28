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

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 2,
    duration: 2,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    gainEnvelope: [{ time: 0.5, gain: 0.75 }],
    ...overrides,
  };
}

function midiClip(id: string): MIDIClip {
  return {
    id,
    name: id,
    startTime: 4,
    duration: 2,
    offset: 0,
    sourceLength: 2,
    loopLength: 2,
    events: [
      { timestamp: 0.25, type: "noteOn", note: 60, velocity: 100 },
      { timestamp: 1.25, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [{ cc: 1, time: 0.5, value: 64 }],
    color: "#f72585",
  };
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState((state) => ({
    tracks: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    clipboard: { clip: null, clips: [], isCut: false },
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    moveEnvelopesWithItems: true,
    transport: { ...state.transport, currentTime: 0 },
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

describe("deep timeline clipboard and paste entry points", () => {
  it("cuts immediately, then context/menu paste moves deep audio and automation atomically", () => {
    const track = createDefaultTrack("audio", "Audio", "#38bdf8", "audio", []);
    const source = audioClip("source", {
      takes: [audioClip("take", { startTime: 0 })],
    });
    track.clips = [source];
    track.automationLanes = [{
      id: "lane",
      param: "volume",
      points: [{ id: "point", time: 2.5, value: 0.5 }],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: source.id,
      selectedClipIds: [source.id],
    });

    useDAWStore.getState().cutSelectedClips();
    let state = useDAWStore.getState();
    expect(state.tracks[0].clips).toEqual([]);
    expect(state.tracks[0].automationLanes[0].points).toEqual([]);
    expect(state.clipboard).toMatchObject({ isCut: true, sourceRemoved: true });
    expect(state.clipboard.clip?.id).toBe(source.id);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    // pasteClip is the explicit target/time path used by EditMenu and both
    // Timeline context menus. It now delegates to the same deep paste planner.
    state.pasteClip("audio", 6);
    state = useDAWStore.getState();
    const pasted = state.tracks[0].clips[0];
    const pastedId = pasted.id;
    expect(pasted).toMatchObject({ startTime: 6, duration: 2 });
    expect(pasted.id).not.toBe(source.id);
    expect(pasted.gainEnvelope).not.toBe((state.clipboard.clip as AudioClip | null)?.gainEnvelope);
    expect(pasted.takes?.[0].id).not.toBe(source.takes?.[0].id);
    expect(state.tracks[0].automationLanes[0].points)
      .toEqual([{ id: "point", time: 6.5, value: 0.5 }]);
    expect(state.clipboard.clip).toBeNull();
    expect(commandManager.getUndoStack()).toHaveLength(2);

    state.undo();
    expect(useDAWStore.getState().tracks[0].clips).toEqual([]);
    expect(useDAWStore.getState().clipboard).toMatchObject({ isCut: true, sourceRemoved: true });
    state = useDAWStore.getState();
    state.undo();
    expect(useDAWStore.getState().tracks[0].clips[0].id).toBe(source.id);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].id).toBe("point");

    state = useDAWStore.getState();
    state.redo();
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].id).toBe(pastedId);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].id).toBe("point");
  });

  it("claims but safely no-ops for explicit incompatible, frozen, and locked paste targets", () => {
    const audio = createDefaultTrack("audio", "Audio", "#38bdf8", "audio", []);
    const midi = createDefaultTrack("midi", "MIDI", "#f72585", "midi", []);
    const source = audioClip("source");
    useDAWStore.setState({
      tracks: [audio, midi],
      clipboard: {
        clip: source,
        clips: [{ clip: source, trackId: "audio" }],
        isCut: false,
      },
    });

    useDAWStore.getState().pasteClip("midi", 3);
    expect(useDAWStore.getState().tracks[1].midiClips).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState((state) => ({
      globalLocked: true,
      selectedTrackIds: ["audio"],
      transport: { ...state.transport, currentTime: 3 },
    }));
    expect(getRegisteredAction("edit.paste")!.canHandleShortcut?.()).toBe(false);
    useDAWStore.getState().pasteClip("audio", 3);
    expect(useDAWStore.getState().tracks[0].clips).toEqual([]);

    useDAWStore.setState((state) => ({
      globalLocked: false,
      tracks: state.tracks.map((track) => track.id === "audio" ? { ...track, frozen: true } : track),
    }));
    useDAWStore.getState().pasteClip("audio", 3);
    expect(useDAWStore.getState().tracks[0].clips).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("smart-pastes mixed audio/MIDI entries only into compatible selected tracks", () => {
    const targetAudio = createDefaultTrack("target-audio", "Audio", "#38bdf8", "audio", []);
    const targetMIDI = createDefaultTrack("target-midi", "MIDI", "#f72585", "instrument", []);
    const audio = audioClip("audio-source", { startTime: 1 });
    const midi = midiClip("midi-source");
    useDAWStore.setState((state) => ({
      tracks: [targetAudio, targetMIDI],
      selectedTrackId: "target-midi",
      selectedTrackIds: ["target-audio", "target-midi"],
      transport: { ...state.transport, currentTime: 10 },
      clipboard: {
        clip: audio,
        clips: [
          { clip: audio, trackId: "source-audio" },
          { clip: midi, trackId: "source-midi" },
        ],
        isCut: false,
      },
    }));

    const action = getRegisteredAction("edit.paste")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();
    const state = useDAWStore.getState();
    expect(state.tracks[0].clips).toHaveLength(1);
    expect(state.tracks[0].midiClips).toHaveLength(0);
    expect(state.tracks[1].clips).toHaveLength(0);
    expect(state.tracks[1].midiClips).toHaveLength(1);
    expect(state.tracks[0].clips[0].startTime).toBe(10);
    expect(state.tracks[1].midiClips[0].startTime).toBe(13);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });
});
