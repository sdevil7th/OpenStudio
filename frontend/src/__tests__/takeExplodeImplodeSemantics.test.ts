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
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    filePath: `C:/takes/${id}.wav`,
    name: id,
    startTime: 1,
    duration: 2,
    offset: 0,
    color: "#38bdf8",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    gainEnvelope: [{ time: 0.25, gain: 0.75 }],
    ...overrides,
  };
}

beforeEach(() => {
  commandManager.clear();
  vi.spyOn(nativeBridge, "addTrack").mockImplementation(async (id) => id || "generated-track");
  vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "reorderTrack").mockResolvedValue(true);
  useDAWStore.setState((state) => ({
    tracks: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    globalLocked: false,
    lockSettings: { ...state.lockSettings, items: false },
    syncClipsWithBackend: vi.fn(async () => undefined),
    canUndo: false,
    canRedo: false,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("take explode/implode transactions", () => {
  it("explodes nested takes to stable new tracks with one undo and exact backend replay", async () => {
    const nested = audioClip("nested", {
      startTime: 99,
      gainEnvelope: [{ time: 0.5, gain: 0.4 }],
    });
    const take = audioClip("take", {
      startTime: 50,
      gainEnvelope: [{ time: 0.25, gain: 0.6 }],
      takes: [nested],
    });
    const source = audioClip("source", { startTime: 7, takes: [take], activeTakeIndex: 0 });
    const track = createDefaultTrack("source-track", "Vocals", "#123456", "audio", []);
    track.clips = [source];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: source.id,
      selectedClipIds: [source.id],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      lastSelectedTrackId: track.id,
    });

    const action = getRegisteredAction("edit.explodeTakes")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();

    await vi.waitFor(() => expect(useDAWStore.getState().tracks).toHaveLength(3));

    let state = useDAWStore.getState();
    expect(state.tracks).toHaveLength(3);
    expect(state.tracks[0].clips[0].takes).toBeUndefined();
    expect(state.tracks.slice(1).map((entry) => entry.type)).toEqual(["audio", "audio"]);
    expect(state.tracks.slice(1).map((entry) => entry.clips[0].startTime)).toEqual([7, 7]);
    expect(state.tracks.slice(1).map((entry) => entry.clips[0].filePath)).toEqual([
      take.filePath,
      nested.filePath,
    ]);
    expect(state.tracks.slice(1).every((entry) => !entry.clips[0].takes)).toBe(true);
    expect(state.tracks[1].clips[0].id).not.toBe(take.id);
    expect(state.tracks[1].clips[0].gainEnvelope).not.toBe(take.gainEnvelope);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    const explodedTrackIds = state.tracks.slice(1).map((entry) => entry.id);
    const explodedClipIds = state.tracks.slice(1).map((entry) => entry.clips[0].id);

    take.gainEnvelope![0].gain = 9;
    expect(useDAWStore.getState().tracks[1].clips[0].gainEnvelope![0].gain).toBe(0.6);

    const sync = state.syncClipsWithBackend as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(nativeBridge.addTrack).toHaveBeenCalledTimes(2);
    expect(nativeBridge.reorderTrack).toHaveBeenCalledTimes(2);

    state.undo();
    state = useDAWStore.getState();
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0].clips[0].takes?.map((entry) => entry.id)).toEqual(["take"]);
    expect(state.tracks[0].clips[0].takes?.[0].takes?.[0].id).toBe("nested");
    expect(state.selectedClipIds).toEqual([source.id]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    await vi.waitFor(() => expect(nativeBridge.removeTrack).toHaveBeenCalledTimes(2));
    expect(sync).toHaveBeenCalledTimes(2);

    state.redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks).toHaveLength(3));
    state = useDAWStore.getState();
    expect(state.tracks.slice(1).map((entry) => entry.id)).toEqual(explodedTrackIds);
    expect(state.tracks.slice(1).map((entry) => entry.clips[0].id)).toEqual(explodedClipIds);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(3));
    expect(nativeBridge.addTrack).toHaveBeenCalledTimes(4);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("rolls back a partial native track failure without frontend state or history", async () => {
    const source = audioClip("source", {
      takes: [audioClip("take-one"), audioClip("take-two")],
    });
    const track = createDefaultTrack("source-track", "Vocals", "#123456", "audio", []);
    track.clips = [source];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: source.id,
      selectedClipIds: [source.id],
    });
    vi.mocked(nativeBridge.addTrack)
      .mockImplementationOnce(async (id) => id || "generated-track")
      .mockRejectedValueOnce(new Error("second native track failed"));

    await useDAWStore.getState().explodeTakes(source.id);

    const state = useDAWStore.getState();
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0].clips[0].takes?.map((take) => take.id)).toEqual([
      "take-one",
      "take-two",
    ]);
    expect(nativeBridge.removeTrack).toHaveBeenCalledTimes(1);
    expect(nativeBridge.removeTrack).toHaveBeenCalledWith(
      vi.mocked(nativeBridge.addTrack).mock.calls[0][0],
    );
    expect(nativeBridge.reorderTrack).not.toHaveBeenCalled();
    expect((state.syncClipsWithBackend as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("removes provisioned tracks and restores the source when playback sync fails", async () => {
    const source = audioClip("source", { takes: [audioClip("take")] });
    const track = createDefaultTrack("source-track", "Vocals", "#123456", "audio", []);
    track.clips = [source];
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error("clip sync failed"))
      .mockResolvedValueOnce(undefined);
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: source.id,
      selectedClipIds: [source.id],
      syncClipsWithBackend: sync,
    });

    await useDAWStore.getState().explodeTakes(source.id);

    expect(useDAWStore.getState().tracks).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].clips[0].takes?.[0].id).toBe("take");
    expect(nativeBridge.addTrack).toHaveBeenCalledTimes(1);
    expect(nativeBridge.removeTrack).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("implodes eligible clips without losing existing/nested takes and replays one backend command", async () => {
    const mainExisting = audioClip("main-existing", {
      gainEnvelope: [{ time: 0.1, gain: 0.2 }],
    });
    const main = audioClip("main", { takes: [mainExisting], activeTakeIndex: 0 });
    const secondaryNested = audioClip("secondary-nested", {
      gainEnvelope: [{ time: 0.2, gain: 0.3 }],
    });
    const secondary = audioClip("secondary", {
      startTime: 4,
      takes: [secondaryNested],
      gainEnvelope: [{ time: 0.3, gain: 0.4 }],
    });
    const locked = audioClip("locked", { startTime: 8, locked: true });
    const firstTrack = createDefaultTrack("first", "First", "#111111", "audio", []);
    const secondTrack = createDefaultTrack("second", "Second", "#222222", "audio", []);
    const lockedTrack = createDefaultTrack("locked-track", "Locked", "#333333", "audio", []);
    firstTrack.clips = [main];
    secondTrack.clips = [secondary];
    lockedTrack.clips = [locked];
    useDAWStore.setState({
      tracks: [firstTrack, secondTrack, lockedTrack],
      selectedClipId: secondary.id,
      selectedClipIds: [main.id, secondary.id, locked.id],
    });

    const action = getRegisteredAction("edit.implodeTakes")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    action.execute();

    let state = useDAWStore.getState();
    const result = state.tracks[0].clips[0];
    expect(result.takes?.map((take) => take.id)).toEqual([
      "main-existing",
      "secondary",
      "secondary-nested",
    ]);
    expect(state.tracks[1].clips).toEqual([]);
    expect(state.tracks[2].clips.map((clip) => clip.id)).toEqual([locked.id]);
    expect(state.selectedClipId).toBe(main.id);
    expect(state.selectedClipIds).toEqual([main.id, locked.id]);
    expect(result.takes?.[1].gainEnvelope).not.toBe(secondary.gainEnvelope);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    const takeIds = result.takes!.map((take) => take.id);

    secondary.gainEnvelope![0].gain = 8;
    expect(useDAWStore.getState().tracks[0].clips[0].takes?.[1].gainEnvelope?.[0].gain).toBe(0.4);

    const sync = state.syncClipsWithBackend as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(nativeBridge.addTrack).not.toHaveBeenCalled();
    expect(nativeBridge.removeTrack).not.toHaveBeenCalled();

    state.undo();
    state = useDAWStore.getState();
    expect(state.tracks[1].clips.map((clip) => clip.id)).toEqual([secondary.id]);
    expect(state.tracks[0].clips[0].takes?.map((take) => take.id)).toEqual([mainExisting.id]);
    expect(state.selectedClipId).toBe(secondary.id);
    expect(state.selectedClipIds).toEqual([main.id, secondary.id, locked.id]);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));

    state.redo();
    state = useDAWStore.getState();
    expect(state.tracks[0].clips[0].takes?.map((take) => take.id)).toEqual(takeIds);
    expect(state.tracks[1].clips).toEqual([]);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(3));
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("claims but does not mutate when take actions are ineligible or locked", () => {
    const source = audioClip("source", { takes: [audioClip("take")] });
    const second = audioClip("second", { startTime: 5 });
    const track = createDefaultTrack("track", "Track", "#111111", "audio", []);
    track.clips = [source, second];
    useDAWStore.setState({
      tracks: [track],
      selectedClipId: source.id,
      selectedClipIds: [source.id, second.id],
    });
    const explode = getRegisteredAction("edit.explodeTakes")!;
    const implode = getRegisteredAction("edit.implodeTakes")!;

    expect(explode.canHandleShortcut?.()).toBe(false);
    expect(executeAvailableRegisteredAction(explode.id)).toBe("claimed_noop");
    expect(implode.canHandleShortcut?.()).toBe(true);

    useDAWStore.setState((state) => ({
      globalLocked: true,
      lockSettings: { ...state.lockSettings, items: false },
    }));
    expect(implode.canHandleShortcut?.()).toBe(false);
    expect(executeAvailableRegisteredAction(implode.id)).toBe("claimed_noop");
    useDAWStore.getState().implodeTakes([source.id, second.id]);

    useDAWStore.setState((state) => ({
      globalLocked: false,
      lockSettings: { ...state.lockSettings, items: true },
    }));
    useDAWStore.getState().explodeTakes(source.id);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, items: false },
      tracks: state.tracks.map((candidate) => candidate.id === track.id
        ? {
            ...candidate,
            frozen: true,
            clips: candidate.clips.map((clip) => clip.id === second.id
              ? { ...clip, locked: true }
              : clip),
          }
        : candidate),
      selectedClipId: source.id,
      selectedClipIds: [source.id],
    }));
    expect(explode.canHandleShortcut?.()).toBe(false);
    useDAWStore.getState().explodeTakes(source.id);
    useDAWStore.setState({ selectedClipIds: [source.id, second.id] });
    expect(implode.canHandleShortcut?.()).toBe(false);
    useDAWStore.getState().implodeTakes([source.id, second.id]);

    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual([
      source.id,
      second.id,
    ]);
    expect(nativeBridge.addTrack).not.toHaveBeenCalled();
    expect((useDAWStore.getState().syncClipsWithBackend as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
