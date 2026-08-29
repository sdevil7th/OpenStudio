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
    startTime: -0.13,
    duration: 1,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function midiClip(overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id: "midi",
    name: "MIDI",
    startTime: 0.26,
    duration: 1,
    events: [],
    ccEvents: [],
    color: "#f72585",
    ...overrides,
  };
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState((state) => ({
    tracks: [],
    selectedClipId: null,
    selectedClipIds: [],
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    moveEnvelopesWithItems: true,
    transport: { ...state.transport, tempo: 120 },
    timeSignature: { numerator: 4, denominator: 4 },
    gridSize: "1/16",
    quantizePresetId: "factory-1/16",
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

describe("timeline quantize truthfulness", () => {
  it("clamps negative starts and quantizes mixed audio/MIDI with stable automation and redo", () => {
    const audio = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio", []);
    audio.clips = [audioClip()];
    audio.automationLanes = [{
      id: "lane",
      param: "volume",
      points: [{ id: "point", time: 0.1, value: 0.5 }],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    const midi = createDefaultTrack("midi-track", "MIDI", "#f72585", "midi", []);
    midi.midiClips = [midiClip()];
    useDAWStore.setState({
      tracks: [audio, midi],
      selectedClipId: "midi",
      selectedClipIds: ["audio", "midi"],
    });

    const action = getRegisteredAction("edit.quantizeToGrid")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(true);
    let state = useDAWStore.getState();
    expect(state.tracks[0].clips[0]).toMatchObject({ id: "audio", startTime: 0 });
    expect(state.tracks[1].midiClips[0]).toMatchObject({ id: "midi", startTime: 0.25 });
    expect(state.tracks[0].automationLanes[0].points[0]).toMatchObject({
      id: "point",
      time: 0.23,
    });
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(-0.13);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0])
      .toMatchObject({ id: "point", time: 0.1 });
    state = useDAWStore.getState();
    state.redo();
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ id: "audio", startTime: 0 });
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0])
      .toMatchObject({ id: "point", time: 0.23 });
  });

  it("honors global, item, clip, frozen-track, and envelope locks without false history", () => {
    const audio = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio", []);
    audio.clips = [audioClip({ startTime: 0.13 })];
    audio.automationLanes = [{
      id: "lane",
      param: "volume",
      points: [{ id: "point", time: 0.2, value: 0.5 }],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    useDAWStore.setState({
      tracks: [audio],
      selectedClipId: "audio",
      selectedClipIds: ["audio"],
      lockSettings: { items: false, envelopes: true, timeSelection: false, markers: false },
    });

    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(true);
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(0.125);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].time).toBe(0.2);
    useDAWStore.getState().undo();
    commandManager.clear();

    useDAWStore.setState({ globalLocked: true, canUndo: false, canRedo: false });
    expect(getRegisteredAction("edit.quantizeToGrid")!.canHandleShortcut?.()).toBe(false);
    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState({
      globalLocked: false,
      lockSettings: { items: true, envelopes: false, timeSelection: false, markers: false },
    });
    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(false);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, items: false },
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, locked: true })),
      })),
    }));
    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(false);

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        frozen: true,
        clips: track.clips.map((clip) => ({ ...clip, locked: false })),
      })),
    }));
    expect(useDAWStore.getState().quantizeSelectedClips()).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
