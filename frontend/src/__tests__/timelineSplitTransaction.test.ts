import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";

const initialState = useDAWStore.getState();

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-clip",
    filePath: "C:/audio/shared.wav",
    name: "Audio",
    startTime: 2,
    duration: 6,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    sampleRate: 48000,
    sourceLength: 20,
    ...overrides,
  };
}

function midiClip(overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id: "midi-clip",
    name: "MIDI",
    startTime: 1,
    duration: 6,
    offset: 0,
    sourceStart: 0,
    sourceLength: 8,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 8,
    events: [
      { timestamp: 2, type: "noteOn", note: 60, velocity: 96 },
      { timestamp: 4, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [{ time: 2.5, cc: 1, value: 64 }],
    color: "#f72585",
    ...overrides,
  };
}

function setupTracks() {
  const audioTrack = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
  const midiTrack = createDefaultTrack("track-midi", "MIDI", "#f72585", "midi");
  return { audioTrack, midiTrack };
}

describe("unified timeline split transaction", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState(initialState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initialState);
  });

  it("splits selected audio and MIDI clips in place as one undoable transaction", () => {
    const { audioTrack, midiTrack } = setupTracks();
    audioTrack.clips = [
      audioClip({ id: "audio-before", startTime: 0, duration: 1 }),
      audioClip({ id: "audio-selected" }),
      audioClip({ id: "audio-after", startTime: 10, duration: 1 }),
    ];
    midiTrack.midiClips = [midiClip({ id: "midi-selected" })];
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    const syncMIDITrackToBackend = vi.fn().mockResolvedValue(undefined);

    useDAWStore.setState({
      tracks: [audioTrack, midiTrack],
      transport: { ...initialState.transport, currentTime: 4 },
      selectedClipIds: ["audio-selected", "midi-selected"],
      selectedClipId: "midi-selected",
      selectedTrackIds: ["track-audio", "track-midi"],
      selectedTrackId: "track-midi",
      lastSelectedTrackId: "track-audio",
      syncClipsWithBackend,
      syncMIDITrackToBackend,
      canUndo: false,
      canRedo: false,
    });

    useDAWStore.getState().splitClipAtPlayhead();

    const splitState = useDAWStore.getState();
    expect(splitState.tracks[0].clips.map((clip) => clip.id)).toEqual([
      "audio-before",
      expect.not.stringMatching(/^audio-/),
      expect.not.stringMatching(/^audio-/),
      "audio-after",
    ]);
    expect(splitState.tracks[0].clips.slice(1, 3).map((clip) => clip.startTime)).toEqual([2, 4]);
    expect(splitState.tracks[1].midiClips.map((clip) => clip.startTime)).toEqual([1, 4]);
    expect(splitState.selectedClipIds).toHaveLength(4);
    expect(splitState.selectedClipIds).toEqual(expect.arrayContaining([
      splitState.tracks[0].clips[1].id,
      splitState.tracks[0].clips[2].id,
      splitState.tracks[1].midiClips[0].id,
      splitState.tracks[1].midiClips[1].id,
    ]));
    expect(splitState.selectedClipId).toBe(splitState.tracks[1].midiClips[1].id);
    expect(splitState.selectedTrackIds).toEqual(["track-audio", "track-midi"]);
    expect(syncClipsWithBackend).toHaveBeenCalledTimes(1);
    expect(syncMIDITrackToBackend).toHaveBeenCalledWith("track-midi", { debounce: false });
    expect(commandManager.getUndoStack()).toHaveLength(1);

    const splitAudioIds = splitState.tracks[0].clips.slice(1, 3).map((clip) => clip.id);
    const splitMIDIIds = splitState.tracks[1].midiClips.map((clip) => clip.id);
    useDAWStore.getState().undo();

    const undone = useDAWStore.getState();
    expect(undone.tracks[0].clips.map((clip) => clip.id)).toEqual([
      "audio-before",
      "audio-selected",
      "audio-after",
    ]);
    expect(undone.tracks[1].midiClips.map((clip) => clip.id)).toEqual(["midi-selected"]);
    expect(undone.selectedClipIds).toEqual(["audio-selected", "midi-selected"]);
    expect(undone.selectedClipId).toBe("midi-selected");
    expect(undone.selectedTrackIds).toEqual(["track-audio", "track-midi"]);
    expect(undone.selectedTrackId).toBe("track-midi");
    expect(undone.lastSelectedTrackId).toBe("track-audio");

    useDAWStore.getState().redo();
    const redone = useDAWStore.getState();
    expect(redone.tracks[0].clips.slice(1, 3).map((clip) => clip.id)).toEqual(splitAudioIds);
    expect(redone.tracks[1].midiClips.map((clip) => clip.id)).toEqual(splitMIDIIds);
  });

  it("uses selected tracks when no clips are selected, keeps clip selection empty, and skips locked clips", () => {
    const { audioTrack, midiTrack } = setupTracks();
    const otherTrack = createDefaultTrack("track-other", "Other", "#94a3b8", "audio");
    audioTrack.clips = [
      audioClip({ id: "audio-anchor" }),
      audioClip({ id: "audio-locked", startTime: 3, locked: true }),
    ];
    midiTrack.midiClips = [midiClip({ id: "midi-track-selected" })];
    otherTrack.clips = [audioClip({ id: "audio-other" })];
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    const syncMIDITrackToBackend = vi.fn().mockResolvedValue(undefined);

    useDAWStore.setState({
      tracks: [audioTrack, midiTrack, otherTrack],
      selectedClipIds: [],
      selectedClipId: null,
      selectedTrackIds: ["track-audio", "track-midi"],
      selectedTrackId: "track-audio",
      lastSelectedTrackId: "track-midi",
      syncClipsWithBackend,
      syncMIDITrackToBackend,
      canUndo: false,
      canRedo: false,
    });

    useDAWStore.getState().splitClipAtPosition("audio-anchor", 4);

    const state = useDAWStore.getState();
    expect(state.tracks[0].clips).toHaveLength(3);
    expect(state.tracks[0].clips.map((clip) => clip.id)).toContain("audio-locked");
    expect(state.tracks[1].midiClips).toHaveLength(2);
    expect(state.tracks[2].clips.map((clip) => clip.id)).toEqual(["audio-other"]);
    expect(state.selectedClipIds).toEqual([]);
    expect(state.selectedClipId).toBeNull();
    expect(state.selectedTrackIds).toEqual(["track-audio", "track-midi"]);
    expect(state.selectedTrackId).toBe("track-audio");
    expect(state.lastSelectedTrackId).toBe("track-midi");
  });

  it("falls through non-crossing selected clips to clips crossing on selected tracks", () => {
    const { audioTrack } = setupTracks();
    audioTrack.clips = [
      audioClip({ id: "selected-elsewhere", startTime: 0, duration: 1 }),
      audioClip({ id: "track-crossing", startTime: 3, duration: 4 }),
    ];
    useDAWStore.setState({
      tracks: [audioTrack],
      transport: { ...initialState.transport, currentTime: 5 },
      selectedClipIds: ["selected-elsewhere"],
      selectedClipId: "selected-elsewhere",
      selectedTrackIds: ["track-audio"],
      selectedTrackId: "track-audio",
      syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
    });

    useDAWStore.getState().splitClipAtPlayhead();

    const state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.id)).toContain("selected-elsewhere");
    expect(state.tracks[0].clips.filter((clip) => clip.id !== "selected-elsewhere")).toHaveLength(2);
    expect(state.tracks[0].clips.map((clip) => clip.startTime)).toEqual([0, 3, 5]);
    expect(state.selectedClipIds).toEqual(["selected-elsewhere"]);
  });

  it("splits every unlocked crossing clip at the playhead when nothing is selected", () => {
    const { audioTrack, midiTrack } = setupTracks();
    audioTrack.clips = [
      audioClip({ id: "audio-crossing", startTime: 2, duration: 5 }),
      audioClip({ id: "audio-outside", startTime: 8, duration: 2 }),
      audioClip({ id: "audio-locked", startTime: 1, duration: 6, locked: true }),
    ];
    midiTrack.midiClips = [midiClip({ id: "midi-crossing", startTime: 1, duration: 6 })];
    useDAWStore.setState({
      tracks: [audioTrack, midiTrack],
      transport: { ...initialState.transport, currentTime: 4 },
      selectedClipIds: [],
      selectedClipId: null,
      selectedTrackIds: [],
      selectedTrackId: null,
      syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
      syncMIDITrackToBackend: vi.fn().mockResolvedValue(undefined),
    });

    useDAWStore.getState().splitClipAtPlayhead();

    const state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.startTime)).toEqual([2, 4, 8, 1]);
    expect(state.tracks[0].clips.map((clip) => clip.id)).toEqual(expect.arrayContaining([
      "audio-outside",
      "audio-locked",
    ]));
    expect(state.tracks[1].midiClips.map((clip) => clip.startTime)).toEqual([1, 4]);
    expect(state.selectedClipIds).toEqual([]);
  });

  it("does not create history or sync for a locked clip or a boundary split", () => {
    const { audioTrack } = setupTracks();
    audioTrack.clips = [audioClip({ id: "locked", locked: true })];
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      tracks: [audioTrack],
      selectedClipIds: ["locked"],
      selectedClipId: "locked",
      syncClipsWithBackend,
      canUndo: false,
      canRedo: false,
    });

    useDAWStore.getState().splitClipAtPosition("locked", 4);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(syncClipsWithBackend).not.toHaveBeenCalled();

    audioTrack.clips = [audioClip({ id: "boundary" })];
    useDAWStore.setState({ tracks: [audioTrack], selectedClipIds: ["boundary"], selectedClipId: "boundary" });
    useDAWStore.getState().splitClipAtPosition("boundary", 2);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["boundary"]);

    useDAWStore.getState().splitClipAtPosition("boundary", 8);
    useDAWStore.getState().splitClipAtPosition("boundary", 2.0000005);
    useDAWStore.getState().splitClipAtPosition("boundary", 7.9999995);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["boundary"]);
  });

  it("transforms source offsets, fades, gain envelopes, and alternate takes for both audio children", () => {
    const { audioTrack } = setupTracks();
    audioTrack.clips = [audioClip({
      id: "detailed",
      startTime: 2,
      duration: 8,
      offset: 1,
      pitchCorrectionSourceFilePath: "C:/audio/original.wav",
      pitchCorrectionSourceOffset: 5,
      fadeIn: 4,
      fadeOut: 6,
      gainEnvelope: [
        { time: 0, gain: 0.5 },
        { time: 4, gain: 1.5 },
        { time: 8, gain: 1 },
      ],
      takes: [audioClip({
        id: "take-one",
        filePath: "C:/audio/take.wav",
        startTime: 2,
        duration: 8,
        offset: 2,
        pitchCorrectionSourceOffset: 10,
        fadeIn: 2,
        fadeOut: 3,
        gainEnvelope: [{ time: 0, gain: 1 }, { time: 6, gain: 0.4 }],
        takes: undefined,
        activeTakeIndex: undefined,
      })],
      activeTakeIndex: 0,
    })];
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      tracks: [audioTrack],
      selectedClipIds: ["detailed"],
      selectedClipId: "detailed",
      syncClipsWithBackend,
    });

    useDAWStore.getState().splitClipAtPosition("detailed", 5);

    const [left, right] = useDAWStore.getState().tracks[0].clips;
    expect(left).toMatchObject({ startTime: 2, duration: 3, offset: 1, fadeIn: 3, fadeOut: 0 });
    expect(right).toMatchObject({
      startTime: 5,
      duration: 5,
      offset: 4,
      pitchCorrectionSourceOffset: 8,
      fadeIn: 0,
      fadeOut: 5,
    });
    expect(left.gainEnvelope).toEqual([
      { time: 0, gain: 0.5 },
      { time: 3, gain: 1.25 },
    ]);
    expect(right.gainEnvelope).toEqual([
      { time: 0, gain: 1.25 },
      { time: 1, gain: 1.5 },
      { time: 5, gain: 1 },
    ]);
    expect(left.activeTakeIndex).toBe(0);
    expect(right.activeTakeIndex).toBe(0);
    expect(left.takes?.[0]).toMatchObject({ startTime: 2, duration: 3, offset: 2, fadeIn: 2, fadeOut: 0 });
    expect(right.takes?.[0]).toMatchObject({
      startTime: 5,
      duration: 5,
      offset: 5,
      pitchCorrectionSourceOffset: 13,
      fadeIn: 0,
      fadeOut: 3,
    });
    expect(left.takes?.[0].id).not.toBe("take-one");
    expect(right.takes?.[0].id).not.toBe("take-one");
    expect(left.takes?.[0].id).not.toBe(right.takes?.[0].id);
    expect(Number.isFinite(left.takes?.[0].startTime)).toBe(true);
    expect(Number.isFinite(right.takes?.[0].startTime)).toBe(true);
    expect(useDAWStore.getState().selectedClipIds).toEqual([left.id, right.id]);
    expect(useDAWStore.getState().selectedClipId).toBe(right.id);
  });

  it("bounds heterogeneous alternate takes to their own duration and source window", () => {
    const { audioTrack } = setupTracks();
    audioTrack.clips = [audioClip({
      id: "heterogeneous",
      startTime: 2,
      duration: 8,
      takes: [
        audioClip({
          id: "short-source-take",
          filePath: "C:/audio/short.wav",
          startTime: 2,
          duration: 5,
          offset: 2,
          sourceLength: 6,
          pitchCorrectionSourceOffset: 10,
          fadeOut: 3,
          takes: undefined,
          activeTakeIndex: undefined,
        }),
        audioClip({
          id: "ends-before-split",
          filePath: "C:/audio/shorter.wav",
          startTime: 2,
          duration: 2,
          offset: 1,
          sourceLength: 3,
          pitchCorrectionSourceOffset: 20,
          fadeOut: 1,
          takes: undefined,
          activeTakeIndex: undefined,
        }),
      ],
      activeTakeIndex: 0,
    })];
    useDAWStore.setState({
      tracks: [audioTrack],
      selectedClipIds: ["heterogeneous"],
      selectedClipId: "heterogeneous",
      syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
    });

    useDAWStore.getState().splitClipAtPosition("heterogeneous", 5);

    const [left, right] = useDAWStore.getState().tracks[0].clips;
    expect(left.takes?.[0]).toMatchObject({ duration: 3, offset: 2, fadeOut: 0 });
    expect(right.takes?.[0]).toMatchObject({
      duration: 1,
      offset: 5,
      pitchCorrectionSourceOffset: 13,
      fadeOut: 1,
    });
    expect((right.takes?.[0].offset || 0) + (right.takes?.[0].duration || 0)).toBe(6);

    expect(left.takes?.[1]).toMatchObject({ duration: 2, offset: 1, fadeOut: 1 });
    expect(right.takes?.[1]).toMatchObject({
      duration: 0,
      offset: 3,
      pitchCorrectionSourceOffset: 22,
      fadeOut: 0,
    });
  });

  it("clones MIDI source content and keeps invalid MIDI editor sessions closed across undo", () => {
    const { midiTrack } = setupTracks();
    midiTrack.midiClips = [midiClip({ id: "edited-midi", offset: 1 })];
    const session = {
      sessionId: "session-midi",
      trackId: "track-midi",
      clipId: "edited-midi",
      mode: "docked" as const,
      selectedNoteIds: ["note-1"],
      midiEditRange: null,
      editCursorTime: 2,
      activeTool: "select" as const,
      visibleLanes: [{ id: "velocity", kind: "velocity" as const, label: "Velocity", height: 72 }],
      activeLaneId: "velocity",
      scrollY: 0,
      windowPixelsPerSecond: 100,
      windowScrollX: 0,
      openedAt: 1,
      updatedAt: 1,
    };
    const syncMIDITrackToBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      tracks: [midiTrack],
      selectedClipIds: ["edited-midi"],
      selectedClipId: "edited-midi",
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      dockedMidiEditorSessionId: session.sessionId,
      detachedPanels: ["midiEditor"],
      showPianoRoll: true,
      pianoRollTrackId: "track-midi",
      pianoRollClipId: "edited-midi",
      selectedNoteIds: ["note-1"],
      pianoRollEditCursorTime: 2,
      syncMIDITrackToBackend,
    });

    useDAWStore.getState().splitMIDIClipAtPosition("edited-midi", 4);

    const splitState = useDAWStore.getState();
    const [left, right] = splitState.tracks[0].midiClips;
    expect(left.offset).toBe(1);
    expect(right.offset).toBe(4);
    expect(left.events).toEqual(right.events);
    expect(left.events).not.toBe(right.events);
    expect(left.events[0]).not.toBe(right.events[0]);
    expect(left.events[0]).not.toBe(midiTrack.midiClips[0].events[0]);
    expect(splitState.midiEditorSessions).toEqual([]);
    expect(splitState.pianoRollClipId).toBeNull();
    expect(splitState.showPianoRoll).toBe(false);
    expect(splitState.detachedPanels).not.toContain("midiEditor");

    useDAWStore.getState().undo();
    const undone = useDAWStore.getState();
    expect(undone.tracks[0].midiClips.map((clip) => clip.id)).toEqual(["edited-midi"]);
    expect(undone.midiEditorSessions).toEqual([]);
    expect(undone.pianoRollClipId).toBeNull();
    expect(undone.showPianoRoll).toBe(false);
    expect(undone.selectedNoteIds).toEqual([]);
  });

  it("closes a detached native MIDI editor window whose source clip is split", () => {
    const { midiTrack } = setupTracks();
    midiTrack.midiClips = [midiClip({ id: "windowed-midi" })];
    const session = {
      sessionId: "windowed-session",
      trackId: "track-midi",
      clipId: "windowed-midi",
      mode: "windowed" as const,
      selectedNoteIds: [],
      midiEditRange: null,
      editCursorTime: null,
      activeTool: "select" as const,
      visibleLanes: [],
      activeLaneId: "velocity",
      scrollY: 0,
      windowPixelsPerSecond: 100,
      windowScrollX: 0,
      openedAt: 1,
      updatedAt: 1,
    };
    const closeMidiEditorWindow = vi.spyOn(nativeBridge, "closeMidiEditorWindow").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [midiTrack],
      selectedClipIds: ["windowed-midi"],
      selectedClipId: "windowed-midi",
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      dockedMidiEditorSessionId: null,
      detachedPanels: ["midiEditor"],
      showPianoRoll: false,
      pianoRollTrackId: "track-midi",
      pianoRollClipId: "windowed-midi",
      syncMIDITrackToBackend: vi.fn().mockResolvedValue(undefined),
    });

    useDAWStore.getState().splitMIDIClipAtPosition("windowed-midi", 4);

    expect(closeMidiEditorWindow).toHaveBeenCalledWith("windowed-session", "sourceSplit");
    expect(useDAWStore.getState().midiEditorSessions).toEqual([]);
    expect(useDAWStore.getState().detachedPanels).not.toContain("midiEditor");
  });

  it("closes the pitch editor before removing its source clip ID", () => {
    const { audioTrack } = setupTracks();
    audioTrack.clips = [audioClip({ id: "pitch-source" })];
    const closePitchEditor = vi.fn(() => useDAWStore.setState({
      showPitchEditor: false,
      pitchEditorTrackId: null,
      pitchEditorClipId: null,
      pitchEditorFxIndex: 0,
    }));
    useDAWStore.setState({
      tracks: [audioTrack],
      selectedClipIds: ["pitch-source"],
      selectedClipId: "pitch-source",
      showPitchEditor: true,
      pitchEditorTrackId: "track-audio",
      pitchEditorClipId: "pitch-source",
      closePitchEditor,
      syncClipsWithBackend: vi.fn().mockResolvedValue(undefined),
    });

    useDAWStore.getState().splitClipAtPosition("pitch-source", 4);

    expect(closePitchEditor).toHaveBeenCalledTimes(1);
    expect(useDAWStore.getState().showPitchEditor).toBe(false);
    expect(useDAWStore.getState().pitchEditorClipId).toBeNull();
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().showPitchEditor).toBe(false);
  });
});

describe("playback clip sync identity", () => {
  beforeEach(async () => {
    commandManager.clear();
    const { resetSyncCache } = await import("../store/actions/clips");
    await resetSyncCache();
    useDAWStore.setState(initialState);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    commandManager.clear();
    const { resetSyncCache } = await import("../store/actions/clips");
    await resetSyncCache();
    useDAWStore.setState(initialState);
  });

  it("removes one clip by ID without removing an identical same-file sibling", async () => {
    const track = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
    track.clips = [
      audioClip({ id: "same-a", startTime: 2 }),
      audioClip({ id: "same-b", startTime: 2 }),
    ];
    const clearPlaybackClips = vi.spyOn(nativeBridge, "clearPlaybackClips").mockResolvedValue(true);
    const addPlaybackClipsBatch = vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockResolvedValue(true);
    const removePlaybackClipById = vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);

    useDAWStore.setState({ tracks: [track] });
    await useDAWStore.getState().syncClipsWithBackend();

    expect(clearPlaybackClips).toHaveBeenCalledTimes(1);
    expect(addPlaybackClipsBatch).toHaveBeenCalledTimes(1);
    expect(addPlaybackClipsBatch.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ clipId: "same-a" }),
      expect.objectContaining({ clipId: "same-b" }),
    ]));

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((entry) => entry.id === "track-audio"
        ? { ...entry, clips: entry.clips.filter((clip) => clip.id !== "same-a") }
        : entry),
    }));
    await useDAWStore.getState().syncClipsWithBackend();

    expect(clearPlaybackClips).toHaveBeenCalledTimes(1);
    expect(removePlaybackClipById).toHaveBeenCalledTimes(1);
    expect(removePlaybackClipById).toHaveBeenCalledWith("track-audio", "same-a");
    expect(addPlaybackClipsBatch).toHaveBeenCalledTimes(1);
  });

  it("serializes an in-flight split sync so undo is the final backend state", async () => {
    const track = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
    track.clips = [
      audioClip({ id: "race-target", startTime: 2, duration: 6 }),
      audioClip({ id: "race-sibling-a", startTime: 12, duration: 2 }),
      audioClip({ id: "race-sibling-b", startTime: 16, duration: 2 }),
    ];
    const backendClipIds = new Set<string>();
    let releaseTargetRemoval!: () => void;
    const targetRemovalGate = new Promise<void>((resolve) => {
      releaseTargetRemoval = resolve;
    });
    let blockTargetRemoval = false;

    vi.spyOn(nativeBridge, "clearPlaybackClips").mockImplementation(async () => {
      backendClipIds.clear();
      return true;
    });
    vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockImplementation(async (clips) => {
      for (const clip of clips) backendClipIds.add(clip.clipId || "");
      return true;
    });
    const removePlaybackClipById = vi
      .spyOn(nativeBridge, "removePlaybackClipById")
      .mockImplementation(async (_trackId, clipId) => {
        backendClipIds.delete(clipId);
        if (blockTargetRemoval && clipId === "race-target") {
          await targetRemovalGate;
        }
        return true;
      });

    useDAWStore.setState({
      tracks: [track],
      selectedClipIds: ["race-target"],
      selectedClipId: "race-target",
      selectedTrackIds: [],
      selectedTrackId: null,
    });
    await useDAWStore.getState().syncClipsWithBackend();
    expect([...backendClipIds].sort()).toEqual([
      "race-sibling-a",
      "race-sibling-b",
      "race-target",
    ]);

    blockTargetRemoval = true;
    useDAWStore.getState().splitClipAtPosition("race-target", 4);
    await vi.waitFor(() => {
      expect(removePlaybackClipById).toHaveBeenCalledWith("track-audio", "race-target");
    });
    const splitChildIds = useDAWStore.getState().tracks[0].clips
      .filter((clip) => !clip.id.startsWith("race-sibling"))
      .map((clip) => clip.id);

    useDAWStore.getState().undo();
    const latestStateBarrier = useDAWStore.getState().syncClipsWithBackend();
    releaseTargetRemoval();
    await latestStateBarrier;

    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual([
      "race-target",
      "race-sibling-a",
      "race-sibling-b",
    ]);
    expect([...backendClipIds].sort()).toEqual([
      "race-sibling-a",
      "race-sibling-b",
      "race-target",
    ]);
    for (const splitChildId of splitChildIds) {
      expect(backendClipIds.has(splitChildId)).toBe(false);
    }
  });

  it("retries one failed native rebuild and leaves the cache invalidated for the next sync", async () => {
    const track = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
    track.clips = [audioClip({ id: "recovery-target" })];
    const clearPlaybackClips = vi
      .spyOn(nativeBridge, "clearPlaybackClips")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const addPlaybackClipsBatch = vi
      .spyOn(nativeBridge, "addPlaybackClipsBatch")
      .mockResolvedValue(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    useDAWStore.setState({ tracks: [track] });

    await expect(useDAWStore.getState().syncClipsWithBackend()).rejects.toThrow(
      "clearPlaybackClips returned false",
    );
    expect(clearPlaybackClips).toHaveBeenCalledTimes(2);
    expect(addPlaybackClipsBatch).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("retrying one full rebuild"),
      expect.any(Error),
    );

    await useDAWStore.getState().syncClipsWithBackend();

    expect(clearPlaybackClips).toHaveBeenCalledTimes(3);
    expect(addPlaybackClipsBatch).toHaveBeenCalledTimes(1);
    expect(addPlaybackClipsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ clipId: "recovery-target" }),
    ]);
  });

  it("logs a split sync failure after the bounded recovery attempt", async () => {
    const track = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
    track.clips = [audioClip({ id: "failed-split" })];
    const clearPlaybackClips = vi
      .spyOn(nativeBridge, "clearPlaybackClips")
      .mockResolvedValue(false);
    vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockResolvedValue(true);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useDAWStore.setState({
      tracks: [track],
      selectedClipIds: ["failed-split"],
      selectedClipId: "failed-split",
    });

    useDAWStore.getState().splitClipAtPosition("failed-split", 4);

    await vi.waitFor(() => {
      expect(errorLog).toHaveBeenCalledWith(
        "[timeline.split] Backend clip sync failed after recovery attempt",
        expect.any(Error),
      );
    });
    expect(clearPlaybackClips).toHaveBeenCalledTimes(2);
  });

  it("makes reset an awaited barrier before direct clip inserts", async () => {
    const track = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
    track.clips = [
      audioClip({ id: "barrier-source" }),
      audioClip({ id: "barrier-sibling-a", startTime: 12 }),
      audioClip({ id: "barrier-sibling-b", startTime: 20 }),
    ];
    const backendClipIds: string[] = [];
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let blockRemoval = false;

    const clearPlaybackClips = vi
      .spyOn(nativeBridge, "clearPlaybackClips")
      .mockImplementation(async () => {
        backendClipIds.splice(0, backendClipIds.length);
        return true;
      });
    vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockImplementation(async (clips) => {
      for (const clip of clips) backendClipIds.push(clip.clipId || "");
      return true;
    });
    const removePlaybackClipById = vi
      .spyOn(nativeBridge, "removePlaybackClipById")
      .mockImplementation(async (_trackId, clipId) => {
        const index = backendClipIds.indexOf(clipId);
        if (index >= 0) backendClipIds.splice(index, 1);
        if (blockRemoval && clipId === "barrier-source") await removalGate;
        return true;
      });
    vi.spyOn(nativeBridge, "addPlaybackClip").mockImplementation(async (
      _trackId,
      _filePath,
      _startTime,
      _duration,
      _offset,
      _volumeDB,
      _fadeIn,
      _fadeOut,
      clipId,
    ) => {
      backendClipIds.push(clipId || "");
      return true;
    });

    useDAWStore.setState({ tracks: [track] });
    await useDAWStore.getState().syncClipsWithBackend();
    expect([...backendClipIds].sort()).toEqual([
      "barrier-sibling-a",
      "barrier-sibling-b",
      "barrier-source",
    ]);

    blockRemoval = true;
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((entry) => entry.id === "track-audio"
        ? {
            ...entry,
            clips: entry.clips.map((clip) => clip.id === "barrier-source"
              ? { ...clip, startTime: 3 }
              : clip),
          }
        : entry),
    }));
    const pendingSync = useDAWStore.getState().syncClipsWithBackend();
    await vi.waitFor(() => {
      expect(removePlaybackClipById).toHaveBeenCalledWith("track-audio", "barrier-source");
    });

    const { resetSyncCache } = await import("../store/actions/clips");
    const resetBarrier = resetSyncCache();
    releaseRemoval();
    await pendingSync;
    await resetBarrier;

    const recordedClip = audioClip({ id: "direct-recording", startTime: 10 });
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((entry) => entry.id === "track-audio"
        ? { ...entry, clips: [...entry.clips, recordedClip] }
        : entry),
    }));
    await nativeBridge.addPlaybackClip(
      "track-audio",
      recordedClip.filePath,
      recordedClip.startTime,
      recordedClip.duration,
      recordedClip.offset,
      recordedClip.volumeDB,
      recordedClip.fadeIn,
      recordedClip.fadeOut,
      recordedClip.id,
    );
    await useDAWStore.getState().syncClipsWithBackend();

    expect(clearPlaybackClips).toHaveBeenCalledTimes(2);
    expect([...backendClipIds].sort()).toEqual([
      "barrier-sibling-a",
      "barrier-sibling-b",
      "barrier-source",
      "direct-recording",
    ].sort());
  });

  it("deletes an identity-aware same-file clip while rebuilding only its sibling", async () => {
    const track = createDefaultTrack("track-audio", "Audio", "#38bdf8", "audio");
    track.clips = [
      audioClip({ id: "delete-a" }),
      audioClip({ id: "keep-b" }),
    ];
    const clearPlaybackClips = vi.spyOn(nativeBridge, "clearPlaybackClips").mockResolvedValue(true);
    const addPlaybackClipsBatch = vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [track],
      selectedClipIds: ["delete-a"],
      selectedClipId: "delete-a",
      rippleMode: "off",
    });

    useDAWStore.getState().deleteClip("delete-a");
    await vi.waitFor(() => expect(addPlaybackClipsBatch).toHaveBeenCalledTimes(1));

    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["keep-b"]);
    expect(clearPlaybackClips).toHaveBeenCalledTimes(1);
    expect(addPlaybackClipsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ trackId: "track-audio", clipId: "keep-b" }),
    ]);
  });
});
