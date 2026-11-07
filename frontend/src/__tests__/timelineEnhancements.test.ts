import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, resetSyncCache, useDAWStore, type AudioClip, type MIDIClip } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import { serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";
import { analyzeMIDIClipTempo } from "../utils/midiTempoAnalysis";
import { midiExportOptions } from "../utils/midiExportOptions";
import { getEffectiveActionShortcut } from "../store/actionRegistry";
import { createStretchedMIDIClip } from "../utils/timelineClipStretch";
import { getClipPlaybackGainEnvelope, interpolateClipGain } from "../utils/clipCrossfades";

const initial = useDAWStore.getState();
const midi = (id: string, startTime = 0, changes: Partial<MIDIClip> = {}): MIDIClip => ({
  id, name: id, startTime, duration: 2, loopEnabled: false, color: "#abc",
  events: [{ type: "noteOn", timestamp: 0, note: 60, velocity: 90, channel: 2 },
    { type: "noteOff", timestamp: 1, note: 60, velocity: 12, releaseVelocity: 12, channel: 2 }], ...changes,
});
const audio = (id: string, startTime: number, duration: number): AudioClip => ({
  id, name: id, filePath: `C:/${id}.wav`, startTime, duration, offset: 0, volumeDB: 0,
  fadeIn: 0, fadeOut: 0, color: "#abc", sampleRate: 48000,
});
beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({ ...initial, tracks: [], selectedClipIds: [], selectedClipId: null, globalLocked: false,
    lockSettings: { ...initial.lockSettings, items: false }, keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
  vi.spyOn(nativeBridge, "addTrack").mockImplementation(async id => id!);
  vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setTrackInputChannels").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setTrackChannelCount").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "reorderTrack").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setTrackMIDIClips").mockResolvedValue(true);
  useDAWStore.setState({ syncClipsWithBackend: vi.fn().mockResolvedValue(undefined), syncMIDITrackToBackend: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => { vi.restoreAllMocks(); useDAWStore.setState(initial); commandManager.clear(); });

describe("timeline compound edits", () => {
  it("joins trimmed, looped MIDI windows while retaining gaps, channels, CC and clipped note-offs in one undo", () => {
    const first = midi("first", 4, { duration: 3, offset: 0.5, sourceLength: 2, loopLength: 2, loopEnabled: true,
      ccEvents: [{ cc: 64, value: 127, time: 0.75, channel: 2 }] });
    const second = midi("second", 9, { events: [{ type: "noteOn", timestamp: 0.25, note: 65, velocity: 80, channel: 3 },
      { type: "noteOff", timestamp: 5, note: 65, velocity: 44, channel: 3 }] });
    const track = { ...createDefaultTrack("m", "MIDI", "#abc", "midi"), midiClips: [first, second] };
    useDAWStore.setState({ tracks: [track], selectedClipIds: [first.id, second.id] });
    const before = serializeMIDIClipsForBackend(track.midiClips).flatMap(clip => clip.events.map(event => ({ ...event, timestamp: event.timestamp + clip.startTime })))
      .sort((a, b) => a.timestamp - b.timestamp);
    expect(useDAWStore.getState().joinSelectedMIDIClips()).toBe(true);
    const joined = useDAWStore.getState().tracks[0].midiClips[0];
    expect(joined).toMatchObject({ id: first.id, startTime: 4, duration: 7, offset: 0, loopEnabled: false });
    const after = serializeMIDIClipsForBackend([joined]).flatMap(clip => clip.events.map(event => ({ ...event, timestamp: event.timestamp + clip.startTime })))
      .sort((a, b) => a.timestamp - b.timestamp);
    expect(after).toEqual(before);
    expect(commandManager.serialize().undoStack).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].midiClips).toMatchObject([first, second]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].midiClips).toHaveLength(1);
  });
  it("does not join clips across tracks or through an item lock", () => {
    const first = midi("a"), second = midi("b", 2);
    useDAWStore.setState({ tracks: [{ ...createDefaultTrack("a", "A", "#abc", "midi"), midiClips: [first] },
      { ...createDefaultTrack("b", "B", "#abc", "midi"), midiClips: [second] }], selectedClipIds: ["a", "b"] });
    expect(useDAWStore.getState().joinSelectedMIDIClips()).toBe(false);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("crossfades the complete overlap without merging media and replays both curves in one undo", () => {
    const first = audio("a", 0, 5), second = audio("b", 4, 5);
    useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "Audio"), clips: [first, second] }], selectedClipIds: ["a", "b"] });
    expect(useDAWStore.getState().applyClipCrossfade("a", "b", { fadeInShape: 1, fadeOutShape: 1 })).toBe(true);
    const [outgoing, incoming] = useDAWStore.getState().tracks[0].clips;
    expect(outgoing).toMatchObject({ id: "a", fadeOut: 0, crossfadeLayers: [{ memberClipIds: ["a", "b"] }] });
    expect(incoming).toMatchObject({ id: "b", fadeIn: 0, crossfadeLayers: [{ memberClipIds: ["a", "b"] }] });
    expect(interpolateClipGain(getClipPlaybackGainEnvelope(outgoing), 4.5)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(interpolateClipGain(getClipPlaybackGainEnvelope(incoming), 0.5)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(commandManager.serialize().undoStack).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].clips).toEqual([first, second]);
    expect(useDAWStore.getState().editSelectedCrossfade()).toBe(true);
    expect(useDAWStore.getState().crossfadeEditorClipIds).toEqual(["a", "b"]);
  });
  it("inserts a track at the requested index and moves its clip in a single reversible operation", async () => {
    const clip = audio("clip", 1, 3);
    const source = { ...createDefaultTrack("a", "A"), clips: [clip], trackChannelCount: 1 };
    const destination = createDefaultTrack("b", "B");
    useDAWStore.setState({ tracks: [source, destination], selectedClipIds: ["clip"] });
    const id = await useDAWStore.getState().moveTimelineClipsToNewTrack({ placements: [{ clipId: "clip", startTime: 8 }], insertIndex: 1, type: "audio" });
    expect(id).toBeTruthy();
    expect(useDAWStore.getState().tracks.map(track => track.id)).toEqual(["a", id, "b"]);
    expect(useDAWStore.getState().tracks[1]).toMatchObject({ inputType: "mono", trackChannelCount: 1, clips: [{ id: "clip", startTime: 8 }] });
    expect(nativeBridge.reorderTrack).toHaveBeenCalledWith(id, 1);
    expect(commandManager.serialize().undoStack).toHaveLength(1);
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(nativeBridge.removeTrack).toHaveBeenCalledWith(id));
    expect(useDAWStore.getState().tracks).toMatchObject([source, destination]);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(nativeBridge.addTrack).toHaveBeenCalledTimes(2));
    expect(useDAWStore.getState().tracks[1].clips[0].startTime).toBe(8);
  });
  it("rejects a failed native track insertion without changing arrangement or history", async () => {
    const track = { ...createDefaultTrack("a", "A"), clips: [audio("clip", 1, 3)] };
    useDAWStore.setState({ tracks: [track] });
    vi.mocked(nativeBridge.addTrack).mockResolvedValueOnce("");
    expect(await useDAWStore.getState().moveTimelineClipsToNewTrack({ placements: [{ clipId: "clip", startTime: 8 }], insertIndex: 0, type: "audio" })).toBeNull();
    expect(useDAWStore.getState().tracks).toEqual([track]);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("inserts mixed selections as ordered separate rows and restores every row in one Undo", async () => {
    const first = { ...createDefaultTrack("a", "Mono"), trackChannelCount: 1, clips: [audio("audio", 1, 3)] };
    const gap = createDefaultTrack("gap", "Unselected");
    const second = { ...createDefaultTrack("m", "Notes", "#abc", "midi"), midiClips: [{ ...midi("midi", 3), ccEvents: [] }] };
    const before = [first, gap, second];
    useDAWStore.setState({ tracks: before, selectedClipIds: ["audio", "midi"] });
    const id = await useDAWStore.getState().moveTimelineClipsToNewTrack({ insertIndex: 1, type: "audio",
      placements: [{ clipId: "audio", startTime: 8 }, { clipId: "midi", startTime: 10 }] });
    const state = useDAWStore.getState(), destinations = state.tracks.slice(1, 3);
    expect(id).toBe(destinations[0].id);
    expect(state.tracks.map(track => track.id)).toEqual(["a", destinations[0].id, destinations[1].id, "gap", "m"]);
    expect(destinations[0]).toMatchObject({ type: "audio", inputType: "mono", trackChannelCount: 1, clips: [{ id: "audio", startTime: 8 }], midiClips: [] });
    expect(destinations[1]).toMatchObject({ type: "midi", clips: [], midiClips: [{ id: "midi", startTime: 10 }] });
    expect(commandManager.serialize().undoStack).toHaveLength(1);
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(nativeBridge.removeTrack).toHaveBeenCalledWith(destinations[1].id));
    expect(JSON.parse(JSON.stringify(useDAWStore.getState().tracks))).toEqual(JSON.parse(JSON.stringify(before)));
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(nativeBridge.addTrack).toHaveBeenCalledTimes(4));
    expect(useDAWStore.getState().tracks.slice(1, 3)).toEqual(destinations);
  });
  it("rolls back all reserved native rows if a later row cannot be created", async () => {
    const before = [{ ...createDefaultTrack("a", "A"), clips: [audio("a", 0, 3)] },
      { ...createDefaultTrack("b", "B"), clips: [audio("b", 1, 3)] }];
    useDAWStore.setState({ tracks: before });
    vi.mocked(nativeBridge.addTrack).mockImplementationOnce(async id => id ?? "").mockResolvedValueOnce("");
    expect(await useDAWStore.getState().moveTimelineClipsToNewTrack({ insertIndex: 0, type: "audio",
      placements: [{ clipId: "a", startTime: 4 }, { clipId: "b", startTime: 5 }] })).toBeNull();
    const reserved = vi.mocked(nativeBridge.addTrack).mock.calls[0][0];
    expect(nativeBridge.removeTrack).toHaveBeenCalledWith(reserved);
    expect(useDAWStore.getState().tracks).toEqual(before);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("assigns new editing shortcuts only in OpenStudio's keyboard profile", () => {
    expect(getEffectiveActionShortcut("clip.joinSelectedMidi")).toBe("Ctrl+J");
    expect(getEffectiveActionShortcut("clip.crossfadeSelected")).toBe("Shift+X");
    useDAWStore.setState({ keyboardShortcutProfileId: "reaper" });
    expect(getEffectiveActionShortcut("clip.joinSelectedMidi")).toBe("");
    expect(getEffectiveActionShortcut("clip.crossfadeSelected")).toBe("");
  });
  it("synchronizes a curve-only edit through the playback diff cache", async () => {
    await resetSyncCache();
    const clip = audio("a", 0, 3);
    const batch = vi.spyOn(nativeBridge, "addPlaybackClipsBatch").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "clearPlaybackClips").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [{ ...createDefaultTrack("t", "T"), clips: [clip] }], syncClipsWithBackend: initial.syncClipsWithBackend });
    await useDAWStore.getState().syncClipsWithBackend();
    expect(batch.mock.calls[0][0][0]).toMatchObject({ fadeInCurve: 0, fadeOutCurve: 0 });
    useDAWStore.getState().setClipFadeInShape("a", 1);
    await vi.waitFor(() => expect(batch).toHaveBeenCalledTimes(2));
    expect(batch.mock.calls[1][0][0]).toMatchObject({ fadeInCurve: 1, fadeOutCurve: 0 });
    await resetSyncCache();
  });
});

describe("media import layout and MIDI retention", () => {
  it("applies the optional project-rate import policy within the original import Undo and reuses the copy on Redo", async () => {
    useDAWStore.setState({ projectAudioImportPolicy: "project-rate-copy", projectSampleRate: 44100 });
    vi.spyOn(nativeBridge, "probeMediaFile").mockResolvedValue({ filePath: "C:/mono.wav", duration: 3, sampleRate: 48000, numChannels: 1, format: "WAV" });
    const copy = vi.spyOn(nativeBridge, "createProjectRateCopy").mockResolvedValue({ success: true, filePath: "C:/cache/mono-44100.wav", sampleRate: 44100, duration: 3, numChannels: 1 });
    const playback = vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);
    await useDAWStore.getState().importExternalMediaAtTimeline({ filePath: "C:/mono.wav", startTime: 7 });
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ filePath: "C:/cache/mono-44100.wav",
      originalFilePath: "C:/mono.wav", sampleRate: 44100, startTime: 7, duration: 3, importStatus: "ready" });
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks).toHaveLength(0);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(playback).toHaveBeenCalledTimes(2));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(useDAWStore.getState().tracks[0].clips[0].filePath).toBe("C:/cache/mono-44100.wav");
  });
  it("can Undo an import while its rate copy is pending, then Redo without a stranded placeholder", async () => {
    useDAWStore.setState({ projectAudioImportPolicy: "project-rate-copy", projectSampleRate: 44100 });
    vi.spyOn(nativeBridge, "probeMediaFile").mockResolvedValue({ filePath: "C:/mono.wav", duration: 3, sampleRate: 48000, numChannels: 1, format: "WAV" });
    let finish!: (value: { success: boolean; filePath: string; sampleRate: number }) => void;
    const result = { success: true, filePath: "C:/cache/mono-44100.wav", sampleRate: 44100 };
    const copy = vi.spyOn(nativeBridge, "createProjectRateCopy").mockResolvedValue(result)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const cancel = vi.spyOn(nativeBridge, "cancelProjectRateCopy").mockResolvedValue(true);
    const playback = vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);
    const importing = useDAWStore.getState().importExternalMediaAtTimeline({ filePath: "C:/mono.wav", startTime: 7 });
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    useDAWStore.getState().undo();
    expect(cancel).toHaveBeenCalledOnce();
    finish(result);
    await importing;
    expect(useDAWStore.getState().tracks).toHaveLength(0);
    expect(playback).not.toHaveBeenCalled();
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ sampleRate: 44100, importStatus: "ready" });
  });
  it("keeps the original import usable if optional conversion fails or is cancelled", async () => {
    useDAWStore.setState({ projectAudioImportPolicy: "project-rate-copy", projectSampleRate: 44100 });
    vi.spyOn(nativeBridge, "probeMediaFile").mockResolvedValue({ filePath: "C:/mono.wav", duration: 3, sampleRate: 48000, numChannels: 1, format: "WAV" });
    vi.spyOn(nativeBridge, "createProjectRateCopy").mockRejectedValue(new Error("conversion worker unavailable"));
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    await useDAWStore.getState().importExternalMediaAtTimeline({ filePath: "C:/mono.wav", startTime: 7 });
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ filePath: "C:/mono.wav", sampleRate: 48000, importStatus: "ready" });
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().audioConversionJobs).toEqual({});
  });
  it("uses probed mono layout for a new track and retains it through Undo/Redo", async () => {
    vi.spyOn(nativeBridge, "probeMediaFile").mockResolvedValue({ filePath: "C:/mono.wav", duration: 3, sampleRate: 48000, numChannels: 1, format: "WAV" });
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);
    await useDAWStore.getState().importExternalMediaAtTimeline({ filePath: "C:/mono.wav", startTime: 7, insertIndex: 0 });
    const track = useDAWStore.getState().tracks[0];
    expect(track).toMatchObject({ inputType: "mono", inputChannelCount: 1, trackChannelCount: 1, clips: [{ startTime: 7, sampleRate: 48000 }] });
    expect(nativeBridge.setTrackChannelCount).toHaveBeenLastCalledWith(track.id, 1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks).toHaveLength(0);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(nativeBridge.addTrack).toHaveBeenCalledTimes(2));
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ inputType: "mono", trackChannelCount: 1 });
  });
  it("keeps an existing target track's channel layout when importing mono", async () => {
    const track = createDefaultTrack("t", "Stereo");
    useDAWStore.setState({ tracks: [track] });
    vi.spyOn(nativeBridge, "probeMediaFile").mockResolvedValue({ filePath: "C:/mono.wav", duration: 3, sampleRate: 48000, numChannels: 1, format: "WAV" });
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    await useDAWStore.getState().importExternalMediaAtTimeline({ filePath: "C:/mono.wav", trackId: "t", startTime: 2 });
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ inputType: "stereo", inputChannelCount: 2, trackChannelCount: 2 });
    expect(nativeBridge.setTrackChannelCount).not.toHaveBeenCalled();
    expect(nativeBridge.addTrack).not.toHaveBeenCalled();
  });
  it("retains imported tempo metadata and the full MIDI event families through Undo/Redo", async () => {
    const sourceTempoInfo = { tempo: 96, tempoMarkers: [{ time: 2, bpm: 112 }], timeSignature: { numerator: 6, denominator: 8 } };
    await useDAWStore.getState().importExternalMIDIAtTimeline({ filePath: "C:/phrase.mid", startTime: 5, sourceTempoInfo,
      parsedTracks: [{ name: "Phrase", events: [
        { type: "programChange", timestamp: 0, value: 12, channel: 3 },
        { type: "noteOn", timestamp: 0.1, note: 0, velocity: 90, channel: 3 },
        { type: "pitchBend", timestamp: 0.2, value: 0, channel: 3 },
        { type: "channelPressure", timestamp: 0.3, value: 66, channel: 3 },
        { type: "polyPressure", timestamp: 0.4, value: 55, note: 0, channel: 3 },
        { type: "noteOff", timestamp: 1, note: 0, releaseVelocity: 40, channel: 3 },
      ] }] });
    const clip = useDAWStore.getState().tracks[0].midiClips[0];
    expect(clip.sourceTempoInfo).toEqual(sourceTempoInfo);
    expect(clip.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "noteOn", note: 0, channel: 3 }),
      expect.objectContaining({ type: "noteOff", note: 0, releaseVelocity: 40 }),
      expect.objectContaining({ type: "pitchBend", value: 0 }),
      expect.objectContaining({ type: "programChange", value: 12 }),
      expect.objectContaining({ type: "channelPressure", value: 66 }),
      expect.objectContaining({ type: "polyPressure", value: 55, note: 0 }),
    ]));
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks).toHaveLength(0);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].midiClips[0].sourceTempoInfo).toEqual(sourceTempoInfo);
    expect(JSON.parse(JSON.stringify(useDAWStore.getState().tracks[0].midiClips[0])).sourceTempoInfo).toEqual(sourceTempoInfo);
  });
});

describe("tempo analysis and portable maps", () => {
  it("reads imported tempo metadata at a trimmed visible source start", () => {
    const clip = midi("m", 0, { offset: 2.25, duration: 2, sourceTempoInfo: { tempo: 120,
      tempoMarkers: [{ time: 2, bpm: 90 }], timeSignature: { numerator: 3, denominator: 4 } } });
    expect(analyzeMIDIClipTempo(clip)).toMatchObject({ source: "midi-metadata", bpm: 90, confidence: 1 });
    expect(analyzeMIDIClipTempo(clip).beatOffsetSeconds).toBeCloseTo(5 / 12);
  });
  it("estimates a regular onset pattern with explicit half/double ambiguity", () => {
    const events = Array.from({ length: 16 }, (_, index) => [
      { type: "noteOn" as const, timestamp: index * 0.5, note: 60, velocity: 80 },
      { type: "noteOff" as const, timestamp: index * 0.5 + 0.1, note: 60, velocity: 0 },
    ]).flat();
    const report = analyzeMIDIClipTempo(midi("m", 0, { duration: 8, events }));
    expect(report).toMatchObject({ source: "midi-estimate", bpm: 120 });
    expect(report.confidence).toBeLessThanOrEqual(0.65);
    expect(report.candidates.map(candidate => candidate.bpm)).toEqual(expect.arrayContaining([60, 120, 240]));
    expect(report.warning).toContain("beat unit");
  });
  it("does not invent a tempo for a sustained chord", () => {
    expect(analyzeMIDIClipTempo(midi("m"))).toMatchObject({ bpm: 0, confidence: 0, candidates: [] });
  });
  it("keeps imported musical metadata aligned with an existing MIDI time-stretch", () => {
    const clip = midi("m", 0, { duration: 4, offset: 1, sourceTempoInfo: { tempo: 120,
      tempoMarkers: [{ time: 2, bpm: 100 }], timeSignature: { numerator: 4, denominator: 4 } } });
    const stretched = createStretchedMIDIClip(clip, 0, 8);
    expect(stretched.sourceTempoInfo).toEqual({ tempo: 60, tempoMarkers: [{ time: 4, bpm: 50 }], timeSignature: { numerator: 4, denominator: 4 } });
    expect(analyzeMIDIClipTempo(stretched)).toMatchObject({ source: "midi-metadata", bpm: 60, confidence: 1 });
    expect(clip.sourceTempoInfo?.tempo).toBe(120);
  });
  it("rebases exported tempo changes and changes base BPM with one undo without moving clips", () => {
    const clip = audio("a", 6, 3);
    useDAWStore.setState({ tracks: [{ ...createDefaultTrack("a", "A"), clips: [clip] }],
      tempoMarkers: [{ id: "a", time: 2, tempo: 90 }, { id: "b", time: 8, tempo: 100 }, { id: "c", time: 20, tempo: 110 }] });
    expect(midiExportOptions(useDAWStore.getState(), 6, 12)).toEqual({ tempo: 90, tempoMarkers: [{ time: 2, bpm: 100 }], timeSignature: initial.timeSignature });
    vi.spyOn(nativeBridge, "setTempo").mockResolvedValue(true);
    expect(useDAWStore.getState().applyDetectedTempo(128)).toBe(true);
    expect(useDAWStore.getState().transport.tempo).toBe(128);
    expect(useDAWStore.getState().tracks[0].clips[0]).toEqual(clip);
    expect(useDAWStore.getState().isModified).toBe(true);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().transport.tempo).toBe(initial.transport.tempo);
    expect(commandManager.canUndo()).toBe(false);
  });
});
