import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  useDAWStore,
} from "../store/useDAWStore";
import { createTrackOfType } from "../utils/trackCreation";

const originalState = useDAWStore.getState();

function clip(id = "clip", overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 0,
    duration: 1,
    offset: 0,
    color: "#224466",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function editableTrack() {
  const track = createDefaultTrack("track", "Track", "#224466", "audio", []);
  track.clips = [clip()];
  return track;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({
    tracks: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    selectedClipId: null,
    selectedClipIds: [],
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    showPluginBrowser: false,
    pluginBrowserTrackId: null,
    canUndo: false,
    canRedo: false,
    syncClipsWithBackend: vi.fn(async () => undefined),
    syncMIDITrackToBackend: vi.fn(async () => undefined),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("Global Lock structural action contract", () => {
  it.each([
    "insert.audioTrack",
    "insert.midiTrack",
    "insert.instrumentTrack",
    "insert.aiTrack",
    "insert.quickAddInstrument",
    "insert.folderTrack",
    "insert.multipleTracks",
    "insert.busTrack",
    "track.setSelectedColor",
    "track.consolidateSelected",
    "track.toggleSelectedFreeze",
    "track.renderSelectedInPlace",
    "clip.renderSelectedInPlace",
    "insert.bus",
  ])("does not advertise %s while Global Lock is enabled", (actionId) => {
    const track = editableTrack();
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: track.clips[0].id,
      selectedClipIds: [track.clips[0].id],
      globalLocked: true,
    });

    expect(getRegisteredAction(actionId)?.canHandleShortcut?.()).toBe(false);
  });

  it("rejects direct track creation/color entry points without phantom UI or history", async () => {
    const track = editableTrack();
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      globalLocked: true,
    });

    useDAWStore.getState().addTrack({ id: "new", name: "New", type: "audio" });
    useDAWStore.getState().createFolderTrack("Folder");
    useDAWStore.getState().setTracksColorWithUndo([track.id], "#ff0000");
    const created = await createTrackOfType("instrument", { openInstrumentBrowser: true });

    const state = useDAWStore.getState();
    expect(created).toBeNull();
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0].color).toBe("#224466");
    expect(state.selectedTrackIds).toEqual([track.id]);
    expect(state.showPluginBrowser).toBe(false);
    expect(state.pluginBrowserTrackId).toBeNull();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it.each([
    ["track.consolidateSelected", "items"],
    ["track.toggleSelectedFreeze", "items"],
    ["track.renderSelectedInPlace", "items"],
    ["clip.renderSelectedInPlace", "items"],
  ] as const)("does not advertise %s under the %s lock", (actionId, _lockKind) => {
    const track = editableTrack();
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: "clip",
      selectedClipIds: ["clip"],
      lockSettings: { items: true, envelopes: false, timeSelection: false, markers: false },
    });
    expect(getRegisteredAction(actionId)?.canHandleShortcut?.()).toBe(false);
  });

  it.each([
    "track.consolidateSelected",
    "track.renderSelectedInPlace",
    "clip.renderSelectedInPlace",
  ])("does not advertise %s for a frozen target", (actionId) => {
    const track = editableTrack();
    track.frozen = true;
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: "clip",
      selectedClipIds: ["clip"],
    });
    expect(getRegisteredAction(actionId)?.canHandleShortcut?.()).toBe(false);
  });

  it.each([
    "track.consolidateSelected",
    "track.renderSelectedInPlace",
    "clip.renderSelectedInPlace",
  ])("does not advertise %s for a clip-locked target", (actionId) => {
    const track = editableTrack();
    track.clips[0].locked = true;
    useDAWStore.setState({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: "clip",
      selectedClipIds: ["clip"],
    });
    expect(getRegisteredAction(actionId)?.canHandleShortcut?.()).toBe(false);
  });

  it("rolls back a batch add if Global Lock engages during the native add", async () => {
    const add = deferred<string>();
    vi.spyOn(nativeBridge, "addTrack").mockReturnValueOnce(add.promise);
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);

    const pending = useDAWStore.getState().addTracksBatch([
      { id: "late-track", name: "Late", type: "audio" },
    ]);
    useDAWStore.setState({ globalLocked: true });
    add.resolve("late-track");

    await expect(pending).resolves.toEqual([]);
    expect(removeTrack).toHaveBeenCalledWith("late-track");
    expect(useDAWStore.getState().tracks).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("rolls back a bus if Global Lock engages during native creation", async () => {
    const source = editableTrack();
    const add = deferred<string>();
    vi.spyOn(nativeBridge, "addTrack").mockReturnValueOnce(add.promise);
    const removeTrack = vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    const addTrackSend = vi.spyOn(nativeBridge, "addTrackSend").mockResolvedValue(0);
    useDAWStore.setState({
      tracks: [source],
      selectedTrackId: source.id,
      selectedTrackIds: [source.id],
    });

    const pending = Promise.resolve(useDAWStore.getState().createBusFromSelectedTracks());
    useDAWStore.setState({ globalLocked: true });
    add.resolve("bus");

    await expect(pending).resolves.toBe(false);
    expect(addTrackSend).not.toHaveBeenCalled();
    expect(removeTrack).toHaveBeenCalledTimes(1);
    expect(useDAWStore.getState().tracks).toEqual([source]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("rolls back native freeze if Global Lock engages while rendering", async () => {
    const track = editableTrack();
    const freeze = deferred<{ success: boolean; filePath: string; duration: number; sampleRate: number }>();
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "freezeTrack").mockReturnValueOnce(freeze.promise);
    const unfreeze = vi.spyOn(nativeBridge, "unfreezeTrack").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [track], selectedTrackId: track.id, selectedTrackIds: [track.id] });

    const pending = useDAWStore.getState().toggleSelectedTracksFreeze();
    await vi.waitFor(() => expect(nativeBridge.freezeTrack).toHaveBeenCalled());
    useDAWStore.setState({ globalLocked: true });
    freeze.resolve({
      success: true,
      filePath: "C:/freeze/track.wav",
      duration: 1,
      sampleRate: 48_000,
    });

    await expect(pending).resolves.toBe(false);
    expect(unfreeze).toHaveBeenCalledWith(track.id);
    expect(useDAWStore.getState().tracks[0]).toBe(track);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it.each([
    ["consolidate", (trackId: string) => useDAWStore.getState().consolidateTrack(trackId)],
    ["render-track", (trackId: string) => useDAWStore.getState().renderTrackInPlace(trackId)],
    ["render-clip", (_trackId: string) => useDAWStore.getState().renderClipInPlace("clip")],
  ] as const)("aborts %s if Global Lock engages while its dialog is open", async (_label, invoke) => {
    const track = editableTrack();
    const dialog = deferred<string>();
    vi.spyOn(nativeBridge, "showRenderSaveDialog").mockReturnValueOnce(dialog.promise);
    const render = vi.spyOn(nativeBridge, "renderProject").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [track] });

    const pending = invoke(track.id);
    useDAWStore.setState({ globalLocked: true });
    dialog.resolve("C:/renders/result.wav");
    await pending;

    expect(render).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks).toEqual([track]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("still replays an already-created track command after Global Lock is enabled", async () => {
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("new");
    vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    await useDAWStore.getState().addTracksBatch([{ id: "new", name: "New", type: "audio" }]);
    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["new"]);

    useDAWStore.setState({ globalLocked: true });
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks).toEqual([]));
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["new"]));
  });

  it("still replays an already-created freeze command after Global Lock is enabled", async () => {
    const track = editableTrack();
    const freeze = vi.spyOn(nativeBridge, "freezeTrack").mockResolvedValue({
      success: true,
      filePath: "C:/freeze/track.wav",
      duration: 1,
      sampleRate: 48_000,
    });
    const unfreeze = vi.spyOn(nativeBridge, "unfreezeTrack").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    useDAWStore.setState({ tracks: [track], selectedTrackId: track.id, selectedTrackIds: [track.id] });

    await expect(useDAWStore.getState().toggleSelectedTracksFreeze()).resolves.toBe(true);
    useDAWStore.setState({ globalLocked: true });
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].frozen).toBe(false);
    await vi.waitFor(() => expect(unfreeze).toHaveBeenCalled());
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].frozen).toBe(true);
    await vi.waitFor(() => expect(freeze).toHaveBeenCalledTimes(2));
  });
});
