import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { createDefaultTrack, type AudioClip, type MIDIClip, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-clip",
    filePath: "C:/audio/source.wav",
    name: "Lead Vocal",
    startTime: 2,
    duration: 6,
    offset: 0,
    color: "#f72585",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    sampleRate: 48000,
    sourceLength: 6,
    ...overrides,
  };
}

function midiClip(overrides: Partial<MIDIClip> = {}): MIDIClip {
  return {
    id: "midi-clip",
    name: "One Bar Late",
    startTime: 4,
    duration: 8,
    offset: 0,
    sourceStart: 0,
    sourceLength: 8,
    loopEnabled: false,
    loopOffset: 0,
    loopLength: 8,
    events: [
      { timestamp: 2, type: "noteOn", note: 60, velocity: 96 },
      { timestamp: 3, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [],
    color: "#38bdf8",
    ...overrides,
  };
}

describe("render in place alignment", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState(initialState);
    vi.spyOn(nativeBridge, "showRenderSaveDialog").mockResolvedValue("C:/renders/midi-render.wav");
    vi.spyOn(nativeBridge, "renderProject").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "importMediaFile").mockResolvedValue({
      filePath: "C:/renders/midi-render.wav",
      duration: 9.25,
      sampleRate: 48000,
      numChannels: 2,
      format: "wav",
    });
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("rendered-track");
    vi.spyOn(nativeBridge, "reorderTrack").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "refreshWaveformPeaks").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initialState);
  });

  it("renders the requested MIDI timeline range without adding a visible tail", async () => {
    const sourceTrack = createDefaultTrack("track-source", "Instrument", "#38bdf8", "instrument");
    sourceTrack.midiClips = [midiClip()];
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    const syncMIDITrackToBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      tracks: [sourceTrack],
      syncClipsWithBackend,
      syncMIDITrackToBackend,
      canUndo: false,
      canRedo: false,
    });

    await useDAWStore.getState().renderClipInPlace("midi-clip");
    await flushPromises();

    expect(nativeBridge.renderProject).toHaveBeenCalledWith(expect.objectContaining({
      source: "stem:track-source",
      startTime: 4,
      endTime: 12,
      addTail: false,
      tailLength: 0,
    }));

    const tracks = useDAWStore.getState().tracks;
    const renderedClip = tracks[1].clips[0];
    expect(renderedClip).toMatchObject({
      filePath: "C:/renders/midi-render.wav",
      startTime: 4,
      duration: 8,
      sourceLength: 9.25,
      sampleRate: 48000,
    });
    expect(tracks[0].midiClips[0].muted).toBe(true);
    expect(nativeBridge.refreshWaveformPeaks).toHaveBeenCalledWith("C:/renders/midi-render.wav");
    expect(useDAWStore.getState().canUndo).toBe(true);
  });

  it("resyncs audio clip render-in-place from muted frontend state instead of directly double-registering clips", async () => {
    vi.mocked(nativeBridge.showRenderSaveDialog).mockResolvedValue("C:/renders/audio-render.wav");
    vi.mocked(nativeBridge.importMediaFile).mockResolvedValue({
      filePath: "C:/renders/audio-render.wav",
      duration: 6.5,
      sampleRate: 48000,
      numChannels: 2,
      format: "wav",
    });

    const sourceTrack = createDefaultTrack("track-source", "Vocals", "#f72585", "audio");
    sourceTrack.clips = [audioClip()];
    const syncedSnapshots: Array<Array<{ trackId: string; clipId: string; filePath: string }>> = [];
    const syncClipsWithBackend = vi.fn().mockImplementation(async () => {
      syncedSnapshots.push(useDAWStore.getState().tracks.flatMap((track) =>
        track.clips
          .filter((clip) => clip.filePath && !clip.muted)
          .map((clip) => ({ trackId: track.id, clipId: clip.id, filePath: clip.filePath })),
      ));
    });
    useDAWStore.setState({
      tracks: [sourceTrack],
      syncClipsWithBackend,
      canUndo: false,
      canRedo: false,
    });

    await useDAWStore.getState().renderClipInPlace("audio-clip");
    await flushPromises();

    expect(nativeBridge.addPlaybackClip).not.toHaveBeenCalled();
    expect(syncClipsWithBackend).toHaveBeenCalledTimes(2);
    expect(syncedSnapshots[0]).toEqual([
      { trackId: "track-source", clipId: "audio-clip", filePath: "C:/audio/source.wav" },
    ]);
    const finalSync = syncedSnapshots[syncedSnapshots.length - 1] ?? [];
    expect(finalSync).toHaveLength(1);
    expect(finalSync[0]).toMatchObject({
      filePath: "C:/renders/audio-render.wav",
    });
    expect(useDAWStore.getState().tracks[0].clips[0].muted).toBe(true);
  });
});
