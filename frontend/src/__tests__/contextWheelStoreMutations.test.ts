import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  getEffectiveTrackHeight,
  getTrackAtY,
  getTrackYPositions,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";
import {
  createWheelEditBurstController,
  getAccumulatedWheelNudgeDirection,
} from "../utils/contextWheelBehaviors";
import { createWheelDeltaAccumulator } from "../utils/wheelDeltaAccumulator";

const originalState = useDAWStore.getState();

function audioClip(id: string, startTime: number, locked = false): AudioClip {
  return {
    id,
    name: id,
    filePath: `C:/audio/${id}.wav`,
    startTime,
    duration: 2,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    locked,
  };
}

function midiClip(id: string, startTime: number, locked = false): MIDIClip {
  return {
    id,
    name: id,
    startTime,
    duration: 2,
    offset: 0,
    sourceStart: 0,
    sourceLength: 2,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 2,
    events: [
      { timestamp: 0.5, type: "noteOn", note: 60, velocity: 90 },
      { timestamp: 1, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [],
    color: "#f72585",
    locked,
  };
}

beforeEach(() => {
  commandManager.clear();
  const audioTrack = createDefaultTrack("audio", "Audio", "#38bdf8", "audio");
  audioTrack.clips = [audioClip("audio-clip", 1), audioClip("locked-audio", 2, true)];
  const midiTrack = createDefaultTrack("midi", "MIDI", "#f72585", "midi");
  midiTrack.midiClips = [midiClip("midi-clip", 1), midiClip("locked-midi", 2, true)];
  useDAWStore.setState({
    tracks: [audioTrack, midiTrack],
    selectedClipId: null,
    selectedClipIds: [],
    canUndo: false,
    canRedo: false,
    syncMIDITrackToBackend: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("wheel-triggered store mutations", () => {
  it("groups FL Playlist track reorder packets into one exact-order command", () => {
    const thirdTrack = createDefaultTrack("audio-2", "Audio 2", "#22c55e", "audio");
    useDAWStore.setState((state) => ({ tracks: [...state.tracks, thirdTrack] }));
    const state = useDAWStore.getState();

    state.beginTrackReorderEdit("audio");
    expect(state.previewTrackReorder("audio", 1)).toBe(true);
    expect(state.previewTrackReorder("audio", 1)).toBe(true);
    state.commitTrackReorderEdit("audio");
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "midi",
      "audio-2",
      "audio",
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "audio",
      "midi",
      "audio-2",
    ]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "midi",
      "audio-2",
      "audio",
    ]);
  });

  it("accumulates precision Playlist packets into native steps and one undo burst", () => {
    vi.useFakeTimers();
    const thirdTrack = createDefaultTrack("audio-2", "Audio 2", "#22c55e", "audio");
    useDAWStore.setState((state) => ({ tracks: [...state.tracks, thirdTrack] }));
    const target = { kind: "track" as const, id: "audio" };
    const controller = createWheelEditBurstController({
      idleMs: 180,
      getKey: (value: typeof target) => `${value.kind}:${value.id}`,
      onBegin: (value) => useDAWStore.getState().beginTrackReorderEdit(value.id),
      onCommit: (value) => useDAWStore.getState().commitTrackReorderEdit(value.id),
    });
    const accumulator = createWheelDeltaAccumulator({
      quantum: 100,
      idleMs: 180,
      onReset: ({ hadOutput }) => {
        if (hadOutput) controller.commit();
      },
    });
    const dispatchPacket = (amount: number) => {
      const direction = getAccumulatedWheelNudgeDirection(
        accumulator,
        `track-reorder:${target.id}`,
        amount,
      );
      if (direction === 0) {
        const pending = controller.getActiveTarget();
        if (pending) controller.touch(pending);
        return;
      }
      controller.touch(target);
      expect(useDAWStore.getState().previewTrackReorder(target.id, direction)).toBe(true);
    };

    dispatchPacket(25);
    dispatchPacket(25);
    dispatchPacket(25);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "audio",
      "midi",
      "audio-2",
    ]);
    dispatchPacket(25);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "midi",
      "audio",
      "audio-2",
    ]);

    vi.advanceTimersByTime(100);
    dispatchPacket(25);
    vi.advanceTimersByTime(100);
    dispatchPacket(25);
    dispatchPacket(25);
    dispatchPacket(25);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "midi",
      "audio-2",
      "audio",
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    vi.advanceTimersByTime(179);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "audio",
      "midi",
      "audio-2",
    ]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "midi",
      "audio-2",
      "audio",
    ]);

    accumulator.dispose();
    controller.dispose();
  });

  it("rejects invalid and boundary-only Playlist reorder previews without history", () => {
    const state = useDAWStore.getState();
    expect(state.previewTrackReorder("audio", 1)).toBe(false);
    state.beginTrackReorderEdit("missing-track");
    expect(state.previewTrackReorder("missing-track", 1)).toBe(false);
    state.commitTrackReorderEdit("missing-track");
    state.beginTrackReorderEdit("audio");
    expect(state.previewTrackReorder("audio", -1)).toBe(false);
    state.commitTrackReorderEdit("audio");
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["audio", "midi"]);
  });

  it("groups FL clip nudge packets and restores the exact pre-gesture selection", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id !== "audio"
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, groupId: "group-a" })),
          }),
      selectedClipId: "midi-clip",
      selectedClipIds: ["midi-clip"],
    }));
    const state = useDAWStore.getState();
    state.beginClipNudgeEdit("audio-clip");
    expect(useDAWStore.getState().selectedClipIds).toEqual(["audio-clip", "locked-audio"]);
    expect(state.previewClipNudge("audio-clip", "right", true)).toBe(true);
    expect(state.previewClipNudge("audio-clip", "right", true)).toBe(true);
    state.commitClipNudgeEdit("audio-clip");
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.startTime)).toEqual([1.02, 2]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.startTime)).toEqual([1, 2]);
    expect(useDAWStore.getState().selectedClipIds).toEqual(["midi-clip"]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.startTime)).toEqual([1.02, 2]);
    expect(useDAWStore.getState().selectedClipIds).toEqual(["audio-clip", "locked-audio"]);
  });

  it("rejects invalid, locked, and boundary-only clip nudge sessions", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === "audio-clip"
          ? { ...clip, startTime: 0 }
          : clip),
      })),
    }));
    const state = useDAWStore.getState();
    expect(state.previewClipNudge("audio-clip", "right", true)).toBe(false);
    state.beginClipNudgeEdit("missing-clip");
    state.commitClipNudgeEdit("missing-clip");
    state.beginClipNudgeEdit("locked-audio");
    state.commitClipNudgeEdit("locked-audio");
    state.beginClipNudgeEdit("audio-clip");
    expect(state.previewClipNudge("audio-clip", "left", true)).toBe(false);
    state.commitClipNudgeEdit("audio-clip");
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(0);
  });

  it("restores surviving clip previews when a nudge target disappears mid-burst", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id !== "audio"
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, groupId: "group-a", locked: false })),
          }),
    }));
    const state = useDAWStore.getState();
    state.beginClipNudgeEdit("audio-clip");
    expect(state.previewClipNudge("audio-clip", "right", true)).toBe(true);
    useDAWStore.setState((current) => ({
      tracks: current.tracks.map((track) => track.id !== "audio"
        ? track
        : { ...track, clips: track.clips.filter((clip) => clip.id !== "locked-audio") }),
    }));

    state.commitClipNudgeEdit("audio-clip");

    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(1);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("commits exact FL wheel transactions on target switch and owner disposal", () => {
    const thirdTrack = createDefaultTrack("audio-2", "Audio 2", "#22c55e", "audio");
    useDAWStore.setState((state) => ({ tracks: [...state.tracks, thirdTrack] }));
    type Target =
      | { kind: "track"; id: string }
      | { kind: "clip"; id: string };
    const controller = createWheelEditBurstController<Target>({
      idleMs: 180,
      getKey: (target) => `${target.kind}:${target.id}`,
      onBegin: (target) => {
        const state = useDAWStore.getState();
        if (target.kind === "track") state.beginTrackReorderEdit(target.id);
        else state.beginClipNudgeEdit(target.id);
      },
      onCommit: (target) => {
        const state = useDAWStore.getState();
        if (target.kind === "track") state.commitTrackReorderEdit(target.id);
        else state.commitClipNudgeEdit(target.id);
      },
    });

    controller.touch({ kind: "track", id: "audio" });
    expect(useDAWStore.getState().previewTrackReorder("audio", 1)).toBe(true);
    controller.touch({ kind: "clip", id: "audio-clip" });
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().previewClipNudge("audio-clip", "right", true)).toBe(true);
    controller.dispose();
    expect(commandManager.getUndoStack()).toHaveLength(2);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === "audio-clip")?.startTime).toBe(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "audio",
      "midi",
      "audio-2",
    ]);
    useDAWStore.getState().redo();
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual([
      "midi",
      "audio",
      "audio-2",
    ]);
    expect(useDAWStore.getState().tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === "audio-clip")?.startTime).toBe(1.01);
  });

  it("nudges selected audio and MIDI clips in one undoable transaction", () => {
    useDAWStore.setState({
      selectedClipIds: ["audio-clip", "midi-clip", "locked-audio", "locked-midi"],
    });

    useDAWStore.getState().nudgeClips("right", true);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.startTime)).toEqual([1.01, 2]);
    expect(useDAWStore.getState().tracks[1].midiClips.map((clip) => clip.startTime)).toEqual([1.01, 2]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(1);
    expect(useDAWStore.getState().tracks[1].midiClips[0].startTime).toBe(1);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].startTime).toBe(1.01);
    expect(useDAWStore.getState().tracks[1].midiClips[0].startTime).toBe(1.01);
  });

  it("does not create history for a locked or left-boundary-only nudge", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === "audio-clip" ? { ...clip, startTime: 0 } : clip),
      })),
      selectedClipIds: ["audio-clip", "locked-audio"],
    }));

    useDAWStore.getState().nudgeClips("left", true);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.startTime)).toEqual([0, 2]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("commits Cubase-style fade and event-volume wheel edits as undoable actions", () => {
    const state = useDAWStore.getState();
    state.beginClipFadeEdit("audio-clip");
    state.previewClipFades("audio-clip", 0.1, 0);
    state.previewClipFades("audio-clip", 0.25, 0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    state.commitClipFadeEdit("audio-clip");
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0.25);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0.25);

    commandManager.clear();
    state.beginClipVolumeEdit("audio-clip");
    state.setClipVolume("audio-clip", 0.5);
    state.setClipVolume("audio-clip", 1);
    state.commitClipVolumeEdit("audio-clip");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips[0].volumeDB).toBe(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].volumeDB).toBe(0);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].volumeDB).toBe(1);
  });

  it("commits a multi-packet Cubase fade burst only after the idle timeout", () => {
    vi.useFakeTimers();
    const controller = createWheelEditBurstController({
      idleMs: 180,
      getKey: (clipId: string) => clipId,
      onBegin: (clipId) => useDAWStore.getState().beginClipFadeEdit(clipId),
      onCommit: (clipId) => useDAWStore.getState().commitClipFadeEdit(clipId),
    });

    controller.touch("audio-clip");
    useDAWStore.getState().previewClipFades("audio-clip", 0.1, 0);
    vi.advanceTimersByTime(100);
    controller.touch("audio-clip");
    useDAWStore.getState().previewClipFades("audio-clip", 0.25, 0);
    vi.advanceTimersByTime(179);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0.25);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0.25);
  });

  it("guards fade previews without a valid transaction and skips no-op history", () => {
    const state = useDAWStore.getState();
    state.previewClipFades("audio-clip", 0.5, 0);
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0);

    state.beginClipFadeEdit("missing-clip");
    state.previewClipFades("missing-clip", 0.5, 0);
    state.commitClipFadeEdit("missing-clip");
    state.beginClipFadeEdit("audio-clip");
    state.previewClipFades("audio-clip", 0, 0);
    state.commitClipFadeEdit("audio-clip");
    expect(commandManager.getUndoStack()).toHaveLength(0);

    state.beginClipFadeEdit("audio-clip");
    state.previewClipFades("audio-clip", 0.5, 0);
    state.cancelClipFadeEdit("audio-clip");
    expect(useDAWStore.getState().tracks[0].clips[0].fadeIn).toBe(0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("commits a hovered MIDI note property edit and restores it on undo", () => {
    const oldEvents = useDAWStore.getState().tracks[1].midiClips[0].events.map((event) => ({ ...event }));
    const firstPreview = oldEvents.map((event) => event.type === "noteOn"
      ? { ...event, velocity: 91 }
      : event);
    const nextEvents = firstPreview.map((event) => event.type === "noteOn"
      ? { ...event, velocity: 92 }
      : event);

    useDAWStore.getState().previewMIDIClipEvents("midi", "midi-clip", firstPreview);
    useDAWStore.getState().previewMIDIClipEvents("midi", "midi-clip", nextEvents);
    useDAWStore.getState().commitMIDIClipEvents(
      "midi",
      "midi-clip",
      oldEvents,
      nextEvents,
      "Adjust MIDI note velocity",
    );
    expect(useDAWStore.getState().tracks[1].midiClips[0].events[0].velocity).toBe(92);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[1].midiClips[0].events[0].velocity).toBe(90);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[1].midiClips[0].events[0].velocity).toBe(92);
  });

  it("commits a multi-packet MIDI note nudge as one undo command", () => {
    const oldEvents = useDAWStore.getState().tracks[1].midiClips[0].events.map((event) => ({ ...event }));
    const firstPreview = oldEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp + 0.01,
    }));
    const finalEvents = firstPreview.map((event) => ({
      ...event,
      timestamp: event.timestamp + 0.01,
    }));

    useDAWStore.getState().previewMIDIClipEvents("midi", "midi-clip", firstPreview);
    useDAWStore.getState().previewMIDIClipEvents("midi", "midi-clip", finalEvents);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    useDAWStore.getState().commitMIDIClipEvents(
      "midi",
      "midi-clip",
      oldEvents,
      finalEvents,
      "Nudge MIDI note",
    );
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks[1].midiClips[0].events[0].timestamp).toBeCloseTo(0.52);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[1].midiClips[0].events[0].timestamp).toBe(0.5);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[1].midiClips[0].events[0].timestamp).toBeCloseTo(0.52);
  });

  it("commits one automation-lane resize transaction with undo and redo", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track, index) => index !== 0
        ? track
        : {
            ...track,
            showAutomation: true,
            automationLanes: [{
              id: "volume-lane",
              param: "volume",
              points: [],
              visible: true,
              mode: "read" as const,
              armed: false,
              readEnabled: true,
            }],
          }),
    }));

    const state = useDAWStore.getState();
    state.setAutomationLaneHeight("audio", "volume-lane", 96);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].height).toBeUndefined();

    state.beginAutomationLaneHeightEdit("audio", "volume-lane");
    state.setAutomationLaneHeight("audio", "volume-lane", 80);
    state.setAutomationLaneHeight("audio", "volume-lane", 96);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    state.commitAutomationLaneHeightEdit("audio", "volume-lane");
    expect(commandManager.getUndoStack()).toHaveLength(1);

    let tracks = useDAWStore.getState().tracks;
    expect(tracks[0].automationLanes[0].height).toBe(96);
    expect(getEffectiveTrackHeight(tracks[0], 100)).toBe(196);

    const { trackYs } = getTrackYPositions(tracks, 100);
    expect(trackYs[1]).toBe(196);
    expect(getTrackAtY(170, tracks, trackYs, 100)).toEqual({
      trackIndex: 0,
      isInClipArea: false,
      laneIndex: 0,
    });
    expect(getTrackAtY(197, tracks, trackYs, 100)).toEqual({
      trackIndex: 1,
      isInClipArea: true,
      laneIndex: -1,
    });

    useDAWStore.getState().undo();
    tracks = useDAWStore.getState().tracks;
    expect(tracks[0].automationLanes[0].height).toBeUndefined();
    expect(getEffectiveTrackHeight(tracks[0], 100)).toBe(160);

    useDAWStore.getState().redo();
    tracks = useDAWStore.getState().tracks;
    expect(tracks[0].automationLanes[0].height).toBe(96);
    expect(getEffectiveTrackHeight(tracks[0], 100)).toBe(196);
  });

  it("does not create lane-height history for a no-op or invalid target", () => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track, index) => index !== 0
        ? track
        : {
            ...track,
            showAutomation: true,
            automationLanes: [{
              id: "volume-lane",
              param: "volume",
              points: [],
              visible: true,
              mode: "read" as const,
              armed: false,
              readEnabled: true,
            }],
          }),
    }));

    const state = useDAWStore.getState();
    state.beginAutomationLaneHeightEdit("audio", "volume-lane");
    state.setAutomationLaneHeight("audio", "volume-lane", 60);
    state.commitAutomationLaneHeightEdit("audio", "volume-lane");
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].height).toBeUndefined();

    state.beginAutomationLaneHeightEdit("missing-track", "volume-lane");
    state.setAutomationLaneHeight("missing-track", "volume-lane", 96);
    state.commitAutomationLaneHeightEdit("missing-track", "volume-lane");
    state.beginAutomationLaneHeightEdit("audio", "missing-lane");
    state.setAutomationLaneHeight("audio", "missing-lane", 96);
    state.commitAutomationLaneHeightEdit("audio", "missing-lane");
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].automationLanes).toHaveLength(1);
  });
});
