import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";
import {
  computeTimelineStretchGeometry,
  createStretchedMIDIClip,
} from "../utils/timelineClipStretch";

const initialState = useDAWStore.getState();

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-stretch",
    filePath: "C:/audio/current.wav",
    pitchCorrectionSourceFilePath: "C:/audio/pre-pitch.wav",
    pitchCorrectionSourceOffset: 3,
    name: "Audio",
    startTime: 4,
    duration: 6,
    offset: 2,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 1,
    fadeOut: 0.5,
    sampleRate: 48000,
    sourceLength: 12,
    gainEnvelope: [{ time: 1.5, gain: 0.75 }],
    ...overrides,
  };
}

function midiClip(overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id: "midi-stretch",
    name: "MIDI",
    startTime: 2,
    duration: 8,
    offset: 1,
    sourceStart: 0.5,
    sourceLength: 8,
    loopEnabled: true,
    loopOffset: 2,
    loopLength: 4,
    events: [
      { timestamp: 1, type: "noteOn", note: 60, velocity: 100 },
      { timestamp: 3, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [{ time: 2, cc: 1, value: 64 }],
    quantizeBackup: {
      events: [{ timestamp: 1.25, type: "noteOn", note: 62, velocity: 90 }],
      ccEvents: [{ time: 2.5, cc: 11, value: 100 }],
    },
    color: "#f72585",
    ...overrides,
  };
}

describe("timeline stretch geometry", () => {
  it("keeps the left edge fixed for a right-edge stretch and scales source offset", () => {
    expect(computeTimelineStretchGeometry({
      kind: "resize-right",
      originalStartTime: 4,
      originalDuration: 6,
      originalOffset: 3,
      deltaTime: 3,
      minDuration: 0.1,
    })).toEqual({
      startTime: 4,
      duration: 9,
      offset: 4.5,
      timeScale: 1.5,
      playbackRateRatio: 2 / 3,
    });
  });

  it("keeps the right edge fixed for a left-edge stretch", () => {
    expect(computeTimelineStretchGeometry({
      kind: "resize-left",
      originalStartTime: 4,
      originalDuration: 6,
      originalOffset: 3,
      deltaTime: -2,
    })).toEqual({
      startTime: 2,
      duration: 8,
      offset: 4,
      timeScale: 4 / 3,
      playbackRateRatio: 0.75,
    });
  });

  it("snaps the dragged edge and clamps against the timeline/minimum duration", () => {
    expect(computeTimelineStretchGeometry({
      kind: "resize-left",
      originalStartTime: 0.25,
      originalDuration: 2,
      originalOffset: 0,
      deltaTime: -10,
      snapTime: Math.round,
    }).startTime).toBe(0);
    expect(computeTimelineStretchGeometry({
      kind: "resize-right",
      originalStartTime: 4,
      originalDuration: 2,
      originalOffset: 0,
      deltaTime: -20,
      minDuration: 0.1,
    }).duration).toBeCloseTo(0.1);
  });
});

describe("MIDI time-domain scaling", () => {
  it("scales events, controllers, loops, source fields, and quantize backups", () => {
    const stretched = createStretchedMIDIClip(midiClip(), 6, 4);
    expect(stretched).toMatchObject({
      startTime: 6,
      duration: 4,
      offset: 0.5,
      sourceStart: 0.25,
      sourceLength: 4,
      loopOffset: 1,
      loopLength: 2,
    });
    expect(stretched.events.map((event) => event.timestamp)).toEqual([0.5, 1.5]);
    expect(stretched.ccEvents?.[0].time).toBe(1);
    expect(stretched.quantizeBackup?.events[0].timestamp).toBe(0.625);
    expect(stretched.quantizeBackup?.ccEvents?.[0].time).toBe(1.25);
  });
});

describe("undo-safe clip stretching", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState(initialState);
    vi.spyOn(nativeBridge, "timeStretchClip").mockResolvedValue({
      success: true,
      filePath: "C:/audio/current_ts.wav",
      duration: 24,
      sampleRate: 96000,
    });
    vi.spyOn(nativeBridge, "refreshWaveformPeaks").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initialState);
  });

  it("processes audio exactly once, commits one command, and reuses the result for redo", async () => {
    const track = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio");
    track.clips = [audioClip()];
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ tracks: [track], syncClipsWithBackend, canUndo: false, canRedo: false });

    await expect(useDAWStore.getState().stretchClip("audio-stretch", 2, 12)).resolves.toBe(true);

    expect(nativeBridge.timeStretchClip).toHaveBeenCalledTimes(1);
    expect(nativeBridge.timeStretchClip).toHaveBeenCalledWith("C:/audio/current.wav", 0.5);
    expect(nativeBridge.refreshWaveformPeaks).toHaveBeenCalledWith("C:/audio/current_ts.wav");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({
      filePath: "C:/audio/current_ts.wav",
      originalFilePath: "C:/audio/current.wav",
      playbackRate: 0.5,
      startTime: 2,
      duration: 12,
      offset: 4,
      sourceLength: 24,
      fadeIn: 2,
      fadeOut: 1,
      sampleRate: 96000,
      pitchCorrectionSourceFilePath: undefined,
      pitchCorrectionSourceOffset: undefined,
    });
    expect(useDAWStore.getState().tracks[0].clips[0].gainEnvelope?.[0].time).toBe(3);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips[0]).toEqual(audioClip());

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips[0].filePath).toBe("C:/audio/current_ts.wav");
    expect(nativeBridge.timeStretchClip).toHaveBeenCalledTimes(1);
    expect(syncClipsWithBackend).toHaveBeenCalledTimes(3);
  });

  it("leaves state and history unchanged when audio processing fails", async () => {
    vi.mocked(nativeBridge.timeStretchClip).mockResolvedValue({ success: false });
    const track = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio");
    track.clips = [audioClip()];
    useDAWStore.setState({ tracks: [track], canUndo: false, canRedo: false });

    await expect(useDAWStore.getState().stretchClip("audio-stretch", 4, 10)).resolves.toBe(false);

    expect(useDAWStore.getState().tracks[0].clips[0]).toEqual(audioClip());
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("does not overwrite a clip changed while audio rendering is in flight", async () => {
    let finishStretch!: (value: { success: true; filePath: string; duration: number }) => void;
    vi.mocked(nativeBridge.timeStretchClip).mockImplementation(() => new Promise((resolve) => {
      finishStretch = resolve;
    }));
    const track = createDefaultTrack("audio-track", "Audio", "#38bdf8", "audio");
    track.clips = [audioClip()];
    useDAWStore.setState({ tracks: [track], canUndo: false, canRedo: false });

    const pending = useDAWStore.getState().stretchClip("audio-stretch", 4, 12);
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((candidate) => ({
        ...candidate,
        clips: candidate.clips.map((clip) => clip.id === "audio-stretch"
          ? { ...clip, volumeDB: -6 }
          : clip),
      })),
    }));
    finishStretch({ success: true, filePath: "C:/audio/orphaned-render.wav", duration: 24 });

    await expect(pending).resolves.toBe(false);
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({
      filePath: "C:/audio/current.wav",
      duration: 6,
      volumeDB: -6,
    });
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(nativeBridge.refreshWaveformPeaks).not.toHaveBeenCalled();
  });

  it("stretches MIDI without audio processing and restores all timing on undo", async () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#f72585", "midi");
    track.midiClips = [midiClip()];
    const syncMIDITrackToBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ tracks: [track], syncMIDITrackToBackend, canUndo: false, canRedo: false });

    await expect(useDAWStore.getState().stretchClip("midi-stretch", 4, 4)).resolves.toBe(true);

    expect(nativeBridge.timeStretchClip).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks[0].midiClips[0].events.map((event) => event.timestamp))
      .toEqual([0.5, 1.5]);
    expect(syncMIDITrackToBackend).toHaveBeenCalledWith("midi-track", { debounce: false });
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].midiClips[0]).toEqual(midiClip());
  });
});
