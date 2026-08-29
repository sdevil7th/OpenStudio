import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import {
  executeAvailableRegisteredAction,
  getRegisteredAction,
} from "../store/actionRegistry";
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
    filePath: "C:/source.wav",
    name: "Audio",
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

function midiClip(): MIDIClip {
  return {
    id: "midi",
    name: "MIDI",
    startTime: 0,
    duration: 4,
    offset: 0,
    sourceStart: 0,
    sourceLength: 4,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 4,
    events: [],
    ccEvents: [],
    color: "#f72585",
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
    selectedClipId: "audio",
    selectedClipIds: ["audio"],
    globalLocked: false,
    lockSettings: { ...originalState.lockSettings, items: false },
    syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("reverse selected audio clip", () => {
  it("syncs execute/undo/redo to playback as one stable transaction", async () => {
    vi.spyOn(nativeBridge, "reverseAudioFile").mockResolvedValue("C:/source_reversed.wav");
    const sync = useDAWStore.getState().syncClipsWithBackend as ReturnType<typeof vi.fn>;
    const action = getRegisteredAction("edit.reverseClip")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();

    await vi.waitFor(() => {
      expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({
        filePath: "C:/source_reversed.wav",
        reversed: true,
      });
    });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({
      filePath: "C:/source.wav",
      reversed: false,
    });
    expect(sync).toHaveBeenCalledTimes(2);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({
      filePath: "C:/source_reversed.wav",
      reversed: true,
    });
    expect(sync).toHaveBeenCalledTimes(3);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("claims the focused chord but does not execute for MIDI, mixed, locked, or missing-file targets", () => {
    const reverse = vi.spyOn(nativeBridge, "reverseAudioFile");
    const action = getRegisteredAction("edit.reverseClip")!;
    const cases = [
      { selectedClipId: "midi", selectedClipIds: ["midi"] },
      { selectedClipId: "audio", selectedClipIds: ["audio", "midi"] },
    ];
    for (const selection of cases) {
      useDAWStore.setState(selection);
      expect(action.canHandleShortcut?.()).toBe(false);
      expect(executeAvailableRegisteredAction("edit.reverseClip")).toBe("claimed_noop");
    }

    useDAWStore.setState((state) => ({
      selectedClipId: "audio",
      selectedClipIds: ["audio"],
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, clips: track.clips.map((clip) => ({ ...clip, locked: true })) }
        : track),
    }));
    expect(action.canHandleShortcut?.()).toBe(false);
    expect(executeAvailableRegisteredAction("edit.reverseClip")).toBe("claimed_noop");

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, clips: track.clips.map((clip) => ({ ...clip, locked: false, filePath: "" })) }
        : track),
    }));
    expect(action.canHandleShortcut?.()).toBe(false);
    expect(executeAvailableRegisteredAction("edit.reverseClip")).toBe("claimed_noop");
    expect(reverse).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("rejects global/item locks and stale async results without history or backend sync", async () => {
    let resolveReverse!: (path: string) => void;
    vi.spyOn(nativeBridge, "reverseAudioFile").mockImplementation(() => new Promise((resolve) => {
      resolveReverse = resolve;
    }));
    const sync = useDAWStore.getState().syncClipsWithBackend as ReturnType<typeof vi.fn>;

    const pending = useDAWStore.getState().reverseClip("audio");
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, clips: track.clips.map((clip) => ({ ...clip, filePath: "C:/new-source.wav" })) }
        : track),
    }));
    resolveReverse("C:/stale-reversed.wav");
    await pending;
    expect(useDAWStore.getState().tracks[0].clips[0].filePath).toBe("C:/new-source.wav");
    expect(sync).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState((state) => ({ globalLocked: true, lockSettings: { ...state.lockSettings, items: false } }));
    await useDAWStore.getState().reverseClip("audio");
    useDAWStore.setState((state) => ({ globalLocked: false, lockSettings: { ...state.lockSettings, items: true } }));
    await useDAWStore.getState().reverseClip("audio");
    expect(nativeBridge.reverseAudioFile).toHaveBeenCalledTimes(1);
  });

  it("rejects frozen tracks both before native work and while a reverse request is pending", async () => {
    const action = getRegisteredAction("edit.reverseClip")!;
    const reverse = vi.spyOn(nativeBridge, "reverseAudioFile");
    const sync = useDAWStore.getState().syncClipsWithBackend as ReturnType<typeof vi.fn>;
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, frozen: true }
        : track),
    }));

    expect(action.canHandleShortcut?.()).toBe(false);
    await useDAWStore.getState().reverseClip("audio");
    expect(reverse).not.toHaveBeenCalled();

    let resolveReverse!: (path: string) => void;
    reverse.mockImplementation(() => new Promise((resolve) => {
      resolveReverse = resolve;
    }));
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, frozen: false }
        : track),
    }));
    const pending = useDAWStore.getState().reverseClip("audio");
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "audio-track"
        ? { ...track, frozen: true }
        : track),
    }));
    resolveReverse("C:/frozen-result.wav");
    await pending;

    expect(useDAWStore.getState().tracks[0].clips[0].filePath).toBe("C:/source.wav");
    expect(sync).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
