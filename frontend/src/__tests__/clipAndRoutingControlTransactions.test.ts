import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clipPropertiesSource from "../components/ClipPropertiesPanel.tsx?raw";
import routingMatrixSource from "../components/RoutingMatrix.tsx?raw";
import trackRoutingSource from "../components/TrackRoutingModal.tsx?raw";
import {
  beginEditTransaction,
  commitEditTransaction,
  createEditTransactionLifecycle,
} from "../components/ui/editTransactionLifecycle";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "clip",
    name: "Clip",
    filePath: "C:/audio/clip.wav",
    startTime: 0,
    duration: 4,
    offset: 0,
    color: "#111111",
    volumeDB: -6,
    fadeIn: 0.2,
    fadeOut: 0.3,
    ...overrides,
  };
}

function routingTrack(overrides: Partial<Track> = {}): Track {
  return {
    ...createDefaultTrack("source", "Source", "#111111", "audio", []),
    sends: [{
      destTrackId: "dest",
      level: 0.5,
      pan: -0.25,
      enabled: true,
      preFader: false,
      phaseInvert: false,
    }],
    clips: [audioClip()],
    ...overrides,
  };
}

function currentClip() {
  const clip = useDAWStore.getState().tracks[0]?.clips[0];
  if (!clip) throw new Error("Missing test clip");
  return clip;
}

function currentSend() {
  const send = useDAWStore.getState().tracks[0]?.sends[0];
  if (!send) throw new Error("Missing test send");
  return send;
}

function currentTrack() {
  const track = useDAWStore.getState().tracks[0];
  if (!track) throw new Error("Missing test track");
  return track;
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({
    tracks: [routingTrack()],
    selectedClipId: "clip",
    selectedClipIds: ["clip"],
    canUndo: false,
    canRedo: false,
    isModified: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("clip property edit transactions", () => {
  it("renames a clip as one project-state command without unnecessary playback resync", () => {
    const syncClips = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ syncClipsWithBackend: syncClips });

    useDAWStore.getState().setClipName("clip", "Verse");
    expect(currentClip().name).toBe("Verse");
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_CLIP_NAME"]);
    expect(syncClips).not.toHaveBeenCalled();
    useDAWStore.getState().undo();
    expect(currentClip().name).toBe("Clip");
    useDAWStore.getState().redo();
    expect(currentClip().name).toBe("Verse");

    commandManager.clear();
    useDAWStore.getState().setClipName("clip", "Verse");
    useDAWStore.getState().setClipName("missing", "Missing");
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("groups multi-packet gain and fade edits and synchronizes commit, undo, and redo", () => {
    const syncClips = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ syncClipsWithBackend: syncClips });

    let state = useDAWStore.getState();
    state.beginClipVolumeEdit("clip");
    state.setClipVolume("clip", -4);
    state.setClipVolume("clip", -2);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    state.commitClipVolumeEdit("clip");
    expect(currentClip().volumeDB).toBe(-2);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_CLIP_VOLUME"]);
    expect(syncClips).toHaveBeenCalledTimes(1);

    useDAWStore.getState().undo();
    expect(currentClip().volumeDB).toBe(-6);
    expect(syncClips).toHaveBeenCalledTimes(2);
    useDAWStore.getState().redo();
    expect(currentClip().volumeDB).toBe(-2);
    expect(syncClips).toHaveBeenCalledTimes(3);

    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    state = useDAWStore.getState();
    state.beginClipFadeEdit("clip");
    state.previewClipFades("clip", 0.4, 0.3);
    state.previewClipFades("clip", 0.7, 0.8);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    state.commitClipFadeEdit("clip");
    expect([currentClip().fadeIn, currentClip().fadeOut]).toEqual([0.7, 0.8]);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_CLIP_FADES"]);
    expect(syncClips).toHaveBeenCalledTimes(4);

    useDAWStore.getState().undo();
    expect([currentClip().fadeIn, currentClip().fadeOut]).toEqual([0.2, 0.3]);
    useDAWStore.getState().redo();
    expect([currentClip().fadeIn, currentClip().fadeOut]).toEqual([0.7, 0.8]);
    expect(syncClips).toHaveBeenCalledTimes(6);
  });

  it("makes resets discrete transactions and rejects no-op or invalid edits", () => {
    const syncClips = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ syncClipsWithBackend: syncClips });
    const state = useDAWStore.getState();

    state.beginClipVolumeEdit("clip");
    state.setClipVolume("clip", 0);
    state.commitClipVolumeEdit("clip");
    expect(currentClip().volumeDB).toBe(0);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    commandManager.clear();
    state.beginClipFadeEdit("clip");
    state.previewClipFades("clip", 0, 0.3);
    state.commitClipFadeEdit("clip");
    expect(currentClip().fadeIn).toBe(0);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    commandManager.clear();
    state.beginClipFadeEdit("clip");
    state.previewClipFades("clip", 0, 0.3);
    state.commitClipFadeEdit("clip");
    state.beginClipVolumeEdit("clip");
    state.setClipVolume("clip", Number.NaN);
    state.commitClipVolumeEdit("clip");
    state.beginClipFadeEdit("missing");
    state.previewClipFades("missing", 1, 1);
    state.commitClipFadeEdit("missing");
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(syncClips).toHaveBeenCalledTimes(2);
  });

  it("closes a cancel/unmount lifecycle exactly once with one undo command", () => {
    const syncClips = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ syncClipsWithBackend: syncClips });
    const lifecycle = createEditTransactionLifecycle();

    expect(beginEditTransaction(
      lifecycle,
      () => useDAWStore.getState().beginClipVolumeEdit("clip"),
      () => useDAWStore.getState().commitClipVolumeEdit("clip"),
    )).toBe(true);
    useDAWStore.getState().setClipVolume("clip", -1);
    useDAWStore.getState().setClipVolume("clip", 2);
    expect(commitEditTransaction(lifecycle)).toBe(true);
    expect(commitEditTransaction(lifecycle)).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(currentClip().volumeDB).toBe(2);
    expect(syncClips).toHaveBeenCalledTimes(1);
  });
});

describe("routing send edit transactions", () => {
  it("groups level and pan packets separately with exact native undo/redo synchronization", async () => {
    const levelBridge = vi.spyOn(nativeBridge, "setTrackSendLevel").mockResolvedValue(true);
    const panBridge = vi.spyOn(nativeBridge, "setTrackSendPan").mockResolvedValue(true);
    let state = useDAWStore.getState();

    state.beginTrackSendLevelEdit("source", 0);
    await state.setTrackSendLevel("source", 0, 0.6);
    await state.setTrackSendLevel("source", 0, 0.8);
    state.commitTrackSendLevelEdit("source", 0);
    expect(currentSend().level).toBe(0.8);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_TRACK_SEND_LEVEL"]);

    state = useDAWStore.getState();
    state.beginTrackSendPanEdit("source", 0);
    await state.setTrackSendPan("source", 0, 0.1);
    await state.setTrackSendPan("source", 0, 0.75);
    state.commitTrackSendPanEdit("source", 0);
    expect(currentSend().pan).toBe(0.75);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_TRACK_SEND_LEVEL", "SET_TRACK_SEND_PAN"]);

    useDAWStore.getState().undo();
    expect(currentSend().pan).toBe(-0.25);
    expect(panBridge).toHaveBeenLastCalledWith("source", 0, -0.25);
    useDAWStore.getState().undo();
    expect(currentSend().level).toBe(0.5);
    expect(levelBridge).toHaveBeenLastCalledWith("source", 0, 0.5);
    useDAWStore.getState().redo();
    useDAWStore.getState().redo();
    expect([currentSend().level, currentSend().pan]).toEqual([0.8, 0.75]);
    expect(levelBridge).toHaveBeenLastCalledWith("source", 0, 0.8);
    expect(panBridge).toHaveBeenLastCalledWith("source", 0, 0.75);
  });

  it("tracks direct resets, clamps bounds, and skips no-op or missing sends", async () => {
    const levelBridge = vi.spyOn(nativeBridge, "setTrackSendLevel").mockResolvedValue(true);
    const panBridge = vi.spyOn(nativeBridge, "setTrackSendPan").mockResolvedValue(true);

    await useDAWStore.getState().setTrackSendLevel("source", 0, 4);
    await useDAWStore.getState().setTrackSendPan("source", 0, -4);
    expect([currentSend().level, currentSend().pan]).toEqual([1, -1]);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_TRACK_SEND_LEVEL", "SET_TRACK_SEND_PAN"]);
    expect(levelBridge).toHaveBeenCalledWith("source", 0, 1);
    expect(panBridge).toHaveBeenCalledWith("source", 0, -1);

    commandManager.clear();
    await useDAWStore.getState().setTrackSendLevel("source", 0, 1);
    await useDAWStore.getState().setTrackSendPan("source", 0, Number.NaN);
    await useDAWStore.getState().setTrackSendLevel("missing", 0, 0.2);
    await useDAWStore.getState().setTrackSendPan("source", 5, 0.2);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("closes cancellation/unmount once and drops a transaction whose send disappeared", async () => {
    vi.spyOn(nativeBridge, "setTrackSendLevel").mockResolvedValue(true);
    const lifecycle = createEditTransactionLifecycle();
    expect(beginEditTransaction(
      lifecycle,
      () => useDAWStore.getState().beginTrackSendLevelEdit("source", 0),
      () => useDAWStore.getState().commitTrackSendLevelEdit("source", 0),
    )).toBe(true);
    await useDAWStore.getState().setTrackSendLevel("source", 0, 0.75);
    expect(commitEditTransaction(lifecycle)).toBe(true);
    expect(commitEditTransaction(lifecycle)).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    commandManager.clear();
    useDAWStore.getState().beginTrackSendLevelEdit("source", 0);
    await useDAWStore.getState().setTrackSendLevel("source", 0, 0.9);
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => track.id === "source"
        ? { ...track, sends: [] }
        : track),
    }));
    useDAWStore.getState().commitTrackSendLevelEdit("source", 0);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState({ tracks: [routingTrack()] });
    const state = useDAWStore.getState();
    state.beginTrackSendLevelEdit("source", 0);
    await state.setTrackSendLevel("source", 0, 0.7);
    state.commitTrackSendLevelEdit("source", 0);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("groups the modal track pan and stereo-width controls with exact backend replay", async () => {
    const panBridge = vi.spyOn(nativeBridge, "setTrackPan").mockResolvedValue(true);
    const widthBridge = vi.spyOn(nativeBridge, "setTrackStereoWidth").mockResolvedValue(true);
    let state = useDAWStore.getState();

    state.beginTrackPanEdit("source");
    await state.setTrackPan("source", 0.2);
    await state.setTrackPan("source", 0.6);
    state.commitTrackPanEdit("source");
    expect(currentTrack().pan).toBe(0.6);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_TRACK_PAN"]);
    expect(panBridge).toHaveBeenCalledTimes(2);

    state = useDAWStore.getState();
    state.beginTrackStereoWidthEdit("source");
    await state.setTrackStereoWidth("source", 125);
    await state.setTrackStereoWidth("source", 150);
    state.commitTrackStereoWidthEdit("source");
    expect(currentTrack().stereoWidth).toBe(150);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_TRACK_PAN", "SET_TRACK_STEREO_WIDTH"]);
    expect(widthBridge).toHaveBeenCalledTimes(2);

    useDAWStore.getState().undo();
    expect(currentTrack().stereoWidth).toBe(100);
    expect(widthBridge).toHaveBeenLastCalledWith("source", 100);
    useDAWStore.getState().undo();
    expect(currentTrack().pan).toBe(0);
    expect(panBridge).toHaveBeenLastCalledWith("source", 0);
    useDAWStore.getState().redo();
    useDAWStore.getState().redo();
    expect([currentTrack().pan, currentTrack().stereoWidth]).toEqual([0.6, 150]);
    expect(panBridge).toHaveBeenLastCalledWith("source", 0.6);
    expect(widthBridge).toHaveBeenLastCalledWith("source", 150);
  });

  it("commits a typed track dB value once and skips unchanged or invalid control values", async () => {
    const volumeBridge = vi.spyOn(nativeBridge, "setTrackVolume").mockResolvedValue(true);
    const widthBridge = vi.spyOn(nativeBridge, "setTrackStereoWidth").mockResolvedValue(true);
    const state = useDAWStore.getState();

    state.beginTrackVolumeEdit("source");
    await state.setTrackVolume("source", -12);
    state.commitTrackVolumeEdit("source");
    expect(currentTrack().volumeDB).toBe(-12);
    expect(commandManager.getUndoStack().map((command) => command.type))
      .toEqual(["SET_TRACK_VOLUME"]);
    expect(volumeBridge).toHaveBeenCalledTimes(1);
    useDAWStore.getState().undo();
    expect(currentTrack().volumeDB).toBe(0);
    useDAWStore.getState().redo();
    expect(currentTrack().volumeDB).toBe(-12);

    commandManager.clear();
    const volumeCalls = volumeBridge.mock.calls.length;
    state.beginTrackVolumeEdit("source");
    await state.setTrackVolume("source", -12);
    state.commitTrackVolumeEdit("source");
    state.beginTrackVolumeEdit("source");
    await state.setTrackVolume("source", Number.NaN);
    state.commitTrackVolumeEdit("source");
    state.beginTrackStereoWidthEdit("source");
    await state.setTrackStereoWidth("source", 100);
    state.commitTrackStereoWidthEdit("source");
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(volumeBridge).toHaveBeenCalledTimes(volumeCalls);
    expect(widthBridge).not.toHaveBeenCalled();
  });
});

describe("clip and routing control wiring", () => {
  it("wires Clip Properties to stable begin/live/commit callbacks and reset defaults", () => {
    expect(clipPropertiesSource).toContain("function ClipNameField(");
    expect(clipPropertiesSource).toContain("useDAWStore.getState().setClipName(clipId, nextName)");
    expect(clipPropertiesSource).toContain('event.key === "Enter"');
    expect(clipPropertiesSource).toContain('event.key === "Escape"');
    expect(clipPropertiesSource).toContain('<ClipNameField clipId={clip.id} value={clip.name} />');
    expect(clipPropertiesSource).not.toContain("useDAWStore.setState((s) =>");
    expect(clipPropertiesSource).toContain("const beginVolumeEdit = useCallback");
    expect(clipPropertiesSource).toContain("const changeFadeIn = useCallback");
    expect(clipPropertiesSource).toContain("const changeFadeOut = useCallback");
    expect(clipPropertiesSource).toContain("onBeginEdit={beginVolumeEdit}");
    expect(clipPropertiesSource).toContain("onCommitEdit={commitVolumeEdit}");
    expect(clipPropertiesSource).toContain("onBeginEdit={beginFadeEdit}");
    expect(clipPropertiesSource).toContain("onCommitEdit={commitFadeEdit}");
    expect(clipPropertiesSource).toContain("previewClipFades(clipId, fadeIn, latestClip.fadeOut)");
    expect(clipPropertiesSource).toContain("previewClipFades(clipId, latestClip.fadeIn, fadeOut)");
    expect(clipPropertiesSource.match(/defaultValue=\{0\}/g)).toHaveLength(3);
    expect(clipPropertiesSource).not.toContain("setClipFades(clip!");
  });

  it("wires Routing Matrix and both routing-modal directions through shared transactions", () => {
    expect(routingMatrixSource).toContain("const handleLevelEditBegin = useCallback");
    expect(routingMatrixSource).toContain("const handleLevelEditCommit = useCallback");
    expect(routingMatrixSource).toContain("onBeginEdit={handleLevelEditBegin}");
    expect(routingMatrixSource).toContain("onCommitEdit={handleLevelEditCommit}");
    expect(routingMatrixSource).toContain("defaultValue={50}");

    expect(trackRoutingSource).toContain("function SendLevelSlider(");
    expect(trackRoutingSource).toContain("function SendPanSlider(");
    expect(trackRoutingSource).toContain("function TrackPanSlider(");
    expect(trackRoutingSource).toContain("function TrackStereoWidthSlider(");
    expect(trackRoutingSource).toContain("function TrackVolumeDbField(");
    expect(trackRoutingSource).toContain("onBeginEdit={beginEdit}");
    expect(trackRoutingSource).toContain("onCommitEdit={commitEdit}");
    expect(trackRoutingSource.match(/<SendLevelSlider/g)).toHaveLength(2);
    expect(trackRoutingSource.match(/<SendPanSlider/g)).toHaveLength(2);
    expect(trackRoutingSource).toContain('<TrackVolumeDbField trackId={trackId} value={track.volumeDB} />');
    expect(trackRoutingSource).toContain('<TrackPanSlider trackId={trackId} value={track.pan} />');
    expect(trackRoutingSource).toContain('<TrackStereoWidthSlider trackId={trackId} value={track.stereoWidth} />');
    expect(trackRoutingSource).toContain('event.key === "Enter"');
    expect(trackRoutingSource).toContain('event.key === "Escape"');
    expect(trackRoutingSource).toContain("useDAWStore.getState().commitTrackVolumeEdit(trackId)");
    expect(trackRoutingSource).not.toContain("dbToLinear");
    expect(trackRoutingSource).not.toMatch(/onChange=\{\(e\) => setTrackSend(Level|Pan)/);
  });
});
