import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { audioToMidiActions, mapPolyNotesToMIDIEvents } from "../store/actions/audioToMidi";
import { commandManager } from "../store/commands";
import { createDefaultTrack, type AudioClip, useDAWStore } from "../store/useDAWStore";
import actionRegistrySource from "../store/actionRegistry.ts?raw";
import timelineSource from "../components/Timeline.tsx?raw";

const initialState = useDAWStore.getState();

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sourceClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-clip",
    filePath: "C:/audio/source.wav",
    name: "Source Loop",
    startTime: 12,
    duration: 5,
    offset: 1,
    color: "#4cc9f0",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    sampleRate: 44100,
    sourceLength: 8,
    ...overrides,
  };
}

function analysis(notes: any[] = []) {
  return {
    clipId: "audio-clip",
    sampleRate: 22050,
    hopSize: 256,
    pitchSalience: [],
    salienceDownsampleFactor: 1,
    notes,
  };
}

describe("audio clip to MIDI conversion", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState(initialState);
    vi.spyOn(nativeBridge, "extractMidiFromAudio").mockResolvedValue(analysis());
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("generated-track");
    vi.spyOn(nativeBridge, "setTrackType").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackMIDIClips").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initialState);
  });

  it("maps detected notes to clipped MIDI note events", () => {
    const events = mapPolyNotesToMIDIEvents([
      { startTime: -0.5, endTime: 0.5, midiPitch: 60.2, velocity: 0.5 },
      { startTime: 4.8, endTime: 7, midiPitch: 64, velocity: 2 },
      { startTime: 1, endTime: 1.005, midiPitch: 65, velocity: 0.8 },
      { startTime: Number.NaN, endTime: 2, midiPitch: 67, velocity: 0.8 },
    ] as any, 5);

    expect(events).toEqual([
      { timestamp: 0, type: "noteOn", note: 60, velocity: 64 },
      { timestamp: 0.5, type: "noteOff", note: 60, velocity: 0 },
      { timestamp: 4.8, type: "noteOn", note: 64, velocity: 2 },
      { timestamp: 5, type: "noteOff", note: 64, velocity: 0 },
    ]);
  });

  it("creates one silent MIDI track below the source track with a matching clip duration", async () => {
    vi.mocked(nativeBridge.extractMidiFromAudio).mockResolvedValue(analysis([
      { startTime: 0.25, endTime: 2, midiPitch: 60, velocity: 0.75 },
      { startTime: 4.5, endTime: 8, midiPitch: 67, velocity: 1 },
    ]));

    const sourceTrack = createDefaultTrack("source-track", "Audio", "#4cc9f0", "audio");
    sourceTrack.clips = [sourceClip()];
    const nextTrack = createDefaultTrack("next-track", "Next", "#f72585", "audio");
    useDAWStore.setState({ tracks: [sourceTrack, nextTrack], canUndo: false, canRedo: false });

    const result = await useDAWStore.getState().convertAudioClipToMIDI("source-track", "audio-clip");
    await flushPromises();

    const tracks = useDAWStore.getState().tracks;
    expect(result).not.toBeNull();
    expect(tracks).toHaveLength(3);
    expect(tracks[1].type).toBe("midi");
    expect(tracks[1].instrumentPlugin).toBeUndefined();
    expect(tracks[1].builtInInstrument).toBeUndefined();
    expect(tracks[1].midiEffects).toEqual([]);
    expect(tracks[2].id).toBe("next-track");

    const midiClip = tracks[1].midiClips[0];
    expect(midiClip.startTime).toBe(12);
    expect(midiClip.duration).toBe(5);
    expect(midiClip.sourceLength).toBe(5);
    expect(midiClip.loopLength).toBe(5);
    expect(midiClip.events).toEqual([
      { timestamp: 0.25, type: "noteOn", note: 60, velocity: 95 },
      { timestamp: 2, type: "noteOff", note: 60, velocity: 0 },
      { timestamp: 4.5, type: "noteOn", note: 67, velocity: 127 },
      { timestamp: 5, type: "noteOff", note: 67, velocity: 0 },
    ]);
    expect(nativeBridge.setTrackMIDIClips).toHaveBeenCalled();
    expect(useDAWStore.getState().canUndo).toBe(true);
  });

  it("undoes and redoes the generated MIDI track as one command", async () => {
    vi.mocked(nativeBridge.extractMidiFromAudio).mockResolvedValue(analysis([
      { startTime: 0, endTime: 1, midiPitch: 60, velocity: 0.8 },
    ]));
    const sourceTrack = createDefaultTrack("source-track", "Audio", "#4cc9f0", "audio");
    sourceTrack.clips = [sourceClip()];
    useDAWStore.setState({ tracks: [sourceTrack], canUndo: false, canRedo: false });

    const result = await useDAWStore.getState().convertAudioClipToMIDI("source-track", "audio-clip");
    await flushPromises();
    const generatedTrackId = result?.trackId ?? "";

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["source-track"]);
    expect(nativeBridge.removeTrack).toHaveBeenCalledWith(generatedTrackId);

    useDAWStore.getState().redo();
    await flushPromises();
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["source-track", generatedTrackId]);
    expect(nativeBridge.addTrack).toHaveBeenCalledWith(generatedTrackId, "midi");
  });

  it("creates an empty matching MIDI clip when analysis finds no notes", async () => {
    const sourceTrack = createDefaultTrack("source-track", "Audio", "#4cc9f0", "audio");
    sourceTrack.clips = [sourceClip()];
    useDAWStore.setState({ tracks: [sourceTrack], canUndo: false, canRedo: false });

    await useDAWStore.getState().convertAudioClipToMIDI("source-track", "audio-clip");

    const midiClip = useDAWStore.getState().tracks[1].midiClips[0];
    expect(midiClip.duration).toBe(5);
    expect(midiClip.events).toEqual([]);
    expect(useDAWStore.getState().toastType).toBe("info");
  });

  it("does not create a track when the backend reports an analysis error", async () => {
    vi.mocked(nativeBridge.extractMidiFromAudio).mockResolvedValue({
      ...analysis(),
      error: "Polyphonic model not loaded.",
    });
    const sourceTrack = createDefaultTrack("source-track", "Audio", "#4cc9f0", "audio");
    sourceTrack.clips = [sourceClip()];
    useDAWStore.setState({ tracks: [sourceTrack], canUndo: false, canRedo: false });

    const result = await useDAWStore.getState().convertAudioClipToMIDI("source-track", "audio-clip");

    expect(result).toBeNull();
    expect(useDAWStore.getState().tracks).toHaveLength(1);
    expect(useDAWStore.getState().toastMessage).toBe("Polyphonic model not loaded.");
  });

  it("keeps context menu and action registry wired to the store conversion action", () => {
    expect(timelineSource).toContain('label: "Convert to MIDI..."');
    expect(timelineSource).toContain("convertAudioClipToMIDI(menu.trackId, menu.clipId)");
    expect(timelineSource).not.toContain("Extract MIDI from Audio...");
    expect(actionRegistrySource).toContain('name: "Convert Audio to MIDI"');
    expect(actionRegistrySource).toContain("state.convertAudioClipToMIDI(track.id, clipId)");
  });

  it("exposes the action through the store contract", () => {
    expect(typeof audioToMidiActions).toBe("function");
    expect(typeof useDAWStore.getState().convertAudioClipToMIDI).toBe("function");
  });
});
