import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, type Track, useDAWStore } from "../store/useDAWStore";
import transportBarSource from "../components/TransportBar.tsx?raw";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

const initialState = useDAWStore.getState();

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function armedInstrumentTrack(overrides: Partial<Track> = {}): Track {
  return {
    ...createDefaultTrack("track-midi", "Instrument", "#38bdf8", "instrument"),
    armed: true,
    inputType: "midi" as const,
    midiInputDevice: "Keyboard",
    midiChannel: 0,
    ...overrides,
  };
}

describe("transport recording", () => {
  beforeEach(() => {
    useDAWStore.setState(initialState);
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("track-midi");
    vi.spyOn(nativeBridge, "setTrackType").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackRecordArm").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackInputMonitoring").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackInputChannels").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackMIDIInput").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTransportPosition").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTransportPlaying").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTransportRecording").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPunchRange").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getLastCompletedClips").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getLastCompletedMIDIClips").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "refreshWaveformPeaks").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getAudioDebugSnapshot").mockResolvedValue({} as any);
    vi.spyOn(nativeBridge, "getMIDIInputDevices").mockResolvedValue(["Keyboard"]);
    vi.spyOn(nativeBridge, "getOpenMIDIDevices").mockResolvedValue(["Keyboard"]);
    vi.spyOn(nativeBridge, "openMIDIDevice").mockResolvedValue(true);
  });

  afterEach(() => {
    resetShortcutContextForTests();
    vi.restoreAllMocks();
    useDAWStore.setState(initialState);
  });

  it("lets the bottom transport record button toggle recording", () => {
    expect(transportBarSource).toContain("await toggleRecord();");
    expect(transportBarSource).not.toContain("if (isRecording) return;");
    expect(transportBarSource).not.toContain("await record();");
  });

  it("does not resume a pending play request after stop", async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncClipsWithBackend = vi.fn(() => syncGate);
    vi.spyOn(nativeBridge, "hasAnyActiveARA").mockResolvedValue(false);
    useDAWStore.setState({
      syncClipsWithBackend,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: false,
        isPaused: false,
        isRecording: false,
      },
    });

    const playRequest = useDAWStore.getState().play();
    await vi.waitFor(() => expect(syncClipsWithBackend).toHaveBeenCalledTimes(1));
    await useDAWStore.getState().stop();
    releaseSync();
    await playRequest;

    expect(useDAWStore.getState().transport.isPlaying).toBe(false);
    expect(vi.mocked(nativeBridge.setTransportPlaying).mock.calls)
      .not.toContainEqual([true]);
  });

  it("does not resume a pending play request after pause", async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncClipsWithBackend = vi.fn(() => syncGate);
    vi.spyOn(nativeBridge, "hasAnyActiveARA").mockResolvedValue(false);
    useDAWStore.setState({
      syncClipsWithBackend,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: false,
        isPaused: false,
        isRecording: false,
      },
    });

    const playRequest = useDAWStore.getState().play();
    await vi.waitFor(() => expect(syncClipsWithBackend).toHaveBeenCalledTimes(1));
    useDAWStore.getState().pause();
    releaseSync();
    await playRequest;

    expect(useDAWStore.getState().transport).toMatchObject({
      isPlaying: false,
      isPaused: true,
    });
    expect(vi.mocked(nativeBridge.setTransportPlaying).mock.calls)
      .not.toContainEqual([true]);
  });

  it("punches in at the playhead captured when record is pressed", async () => {
    const calls: string[] = [];
    vi.mocked(nativeBridge.setTransportRecording).mockImplementation(async (recording) => {
      calls.push(`record:${recording}`);
      return true;
    });
    vi.mocked(nativeBridge.getMIDIInputDevices).mockImplementation(async () => {
      calls.push("get-midi-devices");
      return ["Keyboard"];
    });

    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      tracks: [armedInstrumentTrack()],
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        isPaused: false,
        isRecording: false,
        currentTime: 12.345,
      },
      recordingClips: [],
      recordingMIDIPreviews: {},
      syncClipsWithBackend,
    });

    await useDAWStore.getState().record();
    await flushPromises();

    expect(syncClipsWithBackend).not.toHaveBeenCalled();
    expect(nativeBridge.setTransportPlaying).not.toHaveBeenCalled();
    expect(nativeBridge.setTransportRecording).toHaveBeenCalledWith(true);
    expect(useDAWStore.getState().recordingClips).toEqual([
      { trackId: "track-midi", startTime: 12.345 },
    ]);
    expect(calls.indexOf("record:true")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("get-midi-devices")).toBeGreaterThan(calls.indexOf("record:true"));
  });

  it("toggles record to stop when a recording session is active", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      stop,
      recordSession: { id: "record-session", startTime: 3, trackIds: ["track-midi"] },
      transport: {
        ...useDAWStore.getState().transport,
        isRecording: true,
      },
    });

    await useDAWStore.getState().toggleRecord();

    expect(stop).toHaveBeenCalled();
  });

  it("uses the full stop path when Play/Pause is invoked during recording", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    useDAWStore.setState({
      stop,
      pause,
      recordSession: { id: "record-session", startTime: 3, trackIds: ["track-midi"] },
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        isPaused: false,
        isRecording: true,
      },
    });

    await useDAWStore.getState().togglePlayPause();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("Space stops and finalizes audio and MIDI takes from the active Timeline", async () => {
    const audioTrack = {
      ...createDefaultTrack("track-audio", "Audio", "#f97316", "audio"),
      armed: true,
    };
    const midiTrack = armedInstrumentTrack();

    vi.mocked(nativeBridge.getLastCompletedClips).mockResolvedValue([
      {
        trackId: audioTrack.id,
        filePath: "C:/recordings/take.wav",
        startTime: 2,
        duration: 3,
      },
    ]);
    vi.mocked(nativeBridge.getLastCompletedMIDIClips).mockResolvedValue([
      {
        trackId: midiTrack.id,
        startTime: 2,
        duration: 3,
        events: [
          { timestamp: 0, type: "noteOn", note: 60, velocity: 96, channel: 1 },
          { timestamp: 1, type: "noteOff", note: 60, velocity: 0, channel: 1 },
        ],
      },
    ]);

    useDAWStore.setState({
      tracks: [audioTrack, midiTrack],
      selectedClipIds: ["old-clip"],
      selectedClipId: "old-clip",
      selectedTrackId: audioTrack.id,
      selectedTrackIds: [audioTrack.id],
      lastSelectedTrackId: audioTrack.id,
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: true,
        isPaused: false,
        isRecording: true,
        currentTime: 5,
      },
      playStartPosition: 2,
      recordSession: {
        id: "space-stop-record-session",
        startTime: 2,
        trackIds: [audioTrack.id, midiTrack.id],
      },
      recordingClips: [
        { trackId: audioTrack.id, startTime: 2 },
        { trackId: midiTrack.id, startTime: 2 },
      ],
      syncMIDITrackToBackend: vi.fn().mockResolvedValue(undefined),
    });

    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });

    expect(dispatchGlobalShortcut({
      key: " ",
      code: "Space",
      source: "browser",
    }, "windows")).toBe(true);

    await vi.waitFor(() => {
      expect(nativeBridge.getLastCompletedClips).toHaveBeenCalledTimes(1);
      expect(nativeBridge.getLastCompletedMIDIClips).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      const completedState = useDAWStore.getState();
      expect(completedState.tracks.find((track) => track.id === audioTrack.id)?.clips)
        .toHaveLength(1);
      expect(completedState.tracks.find((track) => track.id === midiTrack.id)?.midiClips)
        .toHaveLength(1);
    });

    const state = useDAWStore.getState();
    const recordedAudioClip = state.tracks.find((track) => track.id === audioTrack.id)?.clips[0];
    const recordedMIDIClip = state.tracks.find((track) => track.id === midiTrack.id)?.midiClips[0];

    expect(recordedAudioClip).toBeDefined();
    expect(recordedMIDIClip).toBeDefined();
    expect(state.selectedClipIds).toEqual([recordedAudioClip!.id, recordedMIDIClip!.id]);
    expect(state.selectedClipId).toBe(recordedMIDIClip!.id);
    expect(state.selectedTrackId).toBeNull();
    expect(state.selectedTrackIds).toEqual([]);
    expect(state.lastSelectedTrackId).toBeNull();
    expect(state.transport).toMatchObject({
      isPlaying: false,
      isPaused: false,
      isRecording: false,
    });
    expect(state.recordSession).toBeNull();
    expect(state.recordingClips).toEqual([]);
    expect(nativeBridge.setTransportPlaying).toHaveBeenCalledWith(false);
    expect(nativeBridge.setTransportRecording).toHaveBeenCalledWith(false);
  });

  it("finalizes completed clips when transport sync cleared isRecording but a record session remains", async () => {
    const audioTrack = {
      ...createDefaultTrack("track-audio", "Audio", "#f97316", "audio"),
      armed: false,
    };
    vi.mocked(nativeBridge.getLastCompletedClips).mockResolvedValue([
      {
        trackId: audioTrack.id,
        filePath: "C:/recordings/take.wav",
        startTime: 2,
        duration: 3,
      },
    ]);

    useDAWStore.setState({
      tracks: [audioTrack],
      recordSession: { id: "record-session", startTime: 2, trackIds: [audioTrack.id] },
      transport: {
        ...useDAWStore.getState().transport,
        isPlaying: false,
        isPaused: false,
        isRecording: false,
        currentTime: 5,
      },
      playStartPosition: 2,
    });

    await useDAWStore.getState().stop();

    const recordedAudioClip = useDAWStore.getState().tracks[0].clips[0];
    expect(nativeBridge.getLastCompletedClips).toHaveBeenCalled();
    expect(recordedAudioClip).toMatchObject({
      filePath: "C:/recordings/take.wav",
      startTime: 2,
      duration: 3,
    });
  });

  it("prepares MIDI input routing when an instrument track is armed", async () => {
    useDAWStore.setState({
      tracks: [armedInstrumentTrack({ armed: false, midiInputDevice: "" })],
    });

    await useDAWStore.getState().toggleTrackArmed("track-midi");

    expect(nativeBridge.addTrack).toHaveBeenCalledWith("track-midi", "instrument");
    expect(nativeBridge.setTrackType).toHaveBeenCalledWith("track-midi", "instrument");
    expect(nativeBridge.setTrackRecordArm).toHaveBeenCalledWith("track-midi", true);
    expect(nativeBridge.getMIDIInputDevices).toHaveBeenCalled();
    expect(nativeBridge.openMIDIDevice).toHaveBeenCalledWith("Keyboard");
    expect(nativeBridge.setTrackMIDIInput).toHaveBeenCalledWith("track-midi", "", 0);
  });
});
