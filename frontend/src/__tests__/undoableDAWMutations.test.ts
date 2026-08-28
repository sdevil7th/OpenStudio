import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type AutomationLane,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";

const originalState = useDAWStore.getState();

function audioClip(id: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    name: id,
    filePath: `C:/audio/${id}.wav`,
    startTime: 0,
    duration: 2,
    offset: 0,
    color: "#111111",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    ...createDefaultTrack(id, id, "#111111", "audio", []),
    ...overrides,
  };
}

function volumeLane(overrides: Partial<AutomationLane> = {}): AutomationLane {
  return {
    id: "volume-lane",
    param: "volume",
    points: [],
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
    ...overrides,
  };
}

function currentTrack(id: string): Track {
  const value = useDAWStore.getState().tracks.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Missing test track ${id}`);
  return value;
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({
    tracks: [],
    trackGroups: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    selectedClipId: null,
    selectedClipIds: [],
    automatedParamValues: {},
    isMasterMuted: false,
    masterMono: false,
    masterVolume: 0.8,
    masterPan: 0,
    masterAutomationLanes: [],
    masterAutomationReadEnabled: false,
    masterAutomationWriteEnabled: false,
    masterAutomationEnabled: false,
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("undo-aware track control mutations", () => {
  it("coalesces AI parameter packets into one exact UPDATE_TRACK undo/redo edit", () => {
    useDAWStore.setState({
      tracks: [track("ai", {
        type: "ai",
        aiWorkflow: "text-to-music",
        aiWorkflowParams: { bpm: 120 },
      })],
    });
    const state = useDAWStore.getState();
    expect(state.beginAITrackParamsEdit("ai")).toBe(true);
    state.setAITrackParams("ai", { ...currentTrack("ai").aiWorkflowParams, bpm: 121 });
    state.setAITrackParams("ai", { ...currentTrack("ai").aiWorkflowParams, bpm: 122 });
    state.setAITrackParams("ai", { ...currentTrack("ai").aiWorkflowParams, bpm: 123 });
    expect(state.commitAITrackParamsEdit("ai")).toBe(true);
    expect(state.commitAITrackParamsEdit("ai")).toBe(false);
    expect(currentTrack("ai").aiWorkflowParams?.bpm).toBe(123);

    useDAWStore.getState().undo();
    expect(currentTrack("ai").aiWorkflowParams).toEqual({ bpm: 120 });
    expect(useDAWStore.getState().canUndo).toBe(false);
    useDAWStore.getState().redo();
    expect(currentTrack("ai").aiWorkflowParams?.bpm).toBe(123);
  });

  it("does not create AI parameter commands for invalid or no-op sessions", () => {
    useDAWStore.setState({
      tracks: [track("ai", {
        type: "ai",
        aiWorkflow: "text-to-music",
        aiWorkflowParams: { bpm: 120 },
      })],
    });
    const state = useDAWStore.getState();
    expect(state.beginAITrackParamsEdit("missing")).toBe(false);
    expect(state.beginAITrackParamsEdit("ai")).toBe(true);
    expect(state.commitAITrackParamsEdit("ai")).toBe(false);
    expect(useDAWStore.getState().canUndo).toBe(false);
  });

  it("adjusts a selected linked fader group as one exact undo/redo transaction", () => {
    vi.spyOn(nativeBridge, "setTrackVolume").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [
        track("a", { volumeDB: 0, volume: 1 }),
        track("b", { volumeDB: -6, volume: Math.pow(10, -6 / 20) }),
        track("outside", { volumeDB: -12, volume: Math.pow(10, -12 / 20) }),
      ],
      selectedTrackId: "a",
      selectedTrackIds: ["a"],
      trackGroups: [{
        id: "volume-group",
        name: "Linked volume",
        leadTrackId: "a",
        memberTrackIds: ["a", "b"],
        linkedParams: ["volume"],
      }],
    });

    const state = useDAWStore.getState();
    expect(state.beginTrackVolumeBatchEdit(state.selectedTrackIds)).toBe(true);
    expect(state.adjustTrackVolumeBatch(1)).toBe(true);
    expect(state.commitTrackVolumeBatchEdit()).toBe(true);
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.volumeDB))
      .toEqual([1, -5, -12]);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.volumeDB))
      .toEqual([0, -6, -12]);
    expect(useDAWStore.getState().canUndo).toBe(false);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.volumeDB))
      .toEqual([1, -5, -12]);
  });

  it("deduplicates all-track linked members and keeps frozen tracks eligible", () => {
    vi.spyOn(nativeBridge, "setTrackVolume").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [
        track("a", { volumeDB: 0 }),
        track("b", { volumeDB: -6 }),
        track("frozen", { volumeDB: -12, frozen: true }),
      ],
      trackGroups: [{
        id: "volume-group",
        name: "Linked volume",
        leadTrackId: "a",
        memberTrackIds: ["a", "b"],
        linkedParams: ["volume"],
      }],
    });

    const state = useDAWStore.getState();
    expect(state.beginTrackVolumeBatchEdit(["a", "b", "frozen", "a"])).toBe(true);
    expect(state.adjustTrackVolumeBatch(-0.5)).toBe(true);
    expect(state.commitTrackVolumeBatchEdit()).toBe(true);
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.volumeDB))
      .toEqual([-0.5, -6.5, -12.5]);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.volumeDB))
      .toEqual([0, -6, -12]);
  });

  it("does not create batch-volume undo entries for empty, invalid, or clamped no-op edits", () => {
    useDAWStore.setState({ tracks: [track("ceiling", { volumeDB: 12 })] });
    const state = useDAWStore.getState();

    expect(state.beginTrackVolumeBatchEdit([])).toBe(false);
    expect(state.adjustTrackVolumeBatch(1)).toBe(false);
    expect(state.commitTrackVolumeBatchEdit()).toBe(false);
    expect(state.beginTrackVolumeBatchEdit(["missing"])).toBe(false);
    expect(state.beginTrackVolumeBatchEdit(["ceiling"])).toBe(true);
    expect(state.adjustTrackVolumeBatch(Number.NaN)).toBe(false);
    expect(state.adjustTrackVolumeBatch(1)).toBe(false);
    expect(state.commitTrackVolumeBatchEdit()).toBe(false);
    expect(useDAWStore.getState().canUndo).toBe(false);
  });

  it("arms linked tracks, skips record-safe members, and restores the exact prior states", async () => {
    vi.spyOn(nativeBridge, "setTrackRecordArm").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [
        track("a", { armed: false }),
        track("b", { armed: false, recordSafe: true }),
      ],
      trackGroups: [{
        id: "armed-group",
        name: "Armed",
        leadTrackId: "a",
        memberTrackIds: ["a", "b"],
        linkedParams: ["armed"],
      }],
    });

    await useDAWStore.getState().toggleTrackArmed("a");
    expect(currentTrack("a").armed).toBe(true);
    expect(currentTrack("b").armed).toBe(false);

    useDAWStore.getState().undo();
    expect(currentTrack("a").armed).toBe(false);
    expect(currentTrack("b").armed).toBe(false);

    useDAWStore.getState().redo();
    expect(currentTrack("a").armed).toBe(true);
    expect(currentTrack("b").armed).toBe(false);
  });

  it("restores mixed linked FX bypass states on undo", async () => {
    vi.spyOn(nativeBridge, "bypassTrackInputFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "bypassTrackFX").mockResolvedValue(true);
    useDAWStore.setState({
      tracks: [
        track("a", { fxBypassed: false, inputFxCount: 1, trackFxCount: 1 }),
        track("b", { fxBypassed: true, inputFxCount: 1, trackFxCount: 1 }),
      ],
      trackGroups: [{
        id: "fx-group",
        name: "FX",
        leadTrackId: "a",
        memberTrackIds: ["a", "b"],
        linkedParams: ["fxBypass"],
      }],
    });

    await useDAWStore.getState().toggleTrackFXBypass("a");
    expect([currentTrack("a").fxBypassed, currentTrack("b").fxBypassed]).toEqual([true, true]);

    useDAWStore.getState().undo();
    expect([currentTrack("a").fxBypassed, currentTrack("b").fxBypassed]).toEqual([false, true]);

    useDAWStore.getState().redo();
    expect([currentTrack("a").fxBypassed, currentTrack("b").fxBypassed]).toEqual([true, true]);
  });

  it("undoes and redoes monitoring and phase inversion with native synchronization", async () => {
    const monitorSpy = vi.spyOn(nativeBridge, "setTrackInputMonitoring").mockResolvedValue(true);
    const phaseSpy = vi.spyOn(nativeBridge, "setTrackPhaseInvert").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [track("a", { monitorEnabled: false, phaseInverted: false })] });

    await useDAWStore.getState().toggleTrackMonitor("a");
    expect(currentTrack("a").monitorEnabled).toBe(true);
    useDAWStore.getState().undo();
    expect(currentTrack("a").monitorEnabled).toBe(false);
    useDAWStore.getState().redo();
    expect(currentTrack("a").monitorEnabled).toBe(true);
    expect(monitorSpy).toHaveBeenCalledWith("a", false);

    commandManager.clear();
    await useDAWStore.getState().setTrackPhaseInvert("a", true);
    expect(currentTrack("a").phaseInverted).toBe(true);
    useDAWStore.getState().undo();
    expect(currentTrack("a").phaseInverted).toBe(false);
    useDAWStore.getState().redo();
    expect(currentTrack("a").phaseInverted).toBe(true);
    expect(phaseSpy).toHaveBeenCalledWith("a", false);
  });

  it("undoes and redoes automation read/write mode snapshots", () => {
    const lane = volumeLane();
    useDAWStore.setState({
      tracks: [track("a", {
        automationReadEnabled: true,
        automationWriteEnabled: false,
        automationEnabled: true,
        automationLanes: [lane],
      })],
    });

    useDAWStore.getState().toggleTrackAutomationRead("a");
    expect(currentTrack("a")).toMatchObject({ automationReadEnabled: false, automationEnabled: false });
    expect(currentTrack("a").automationLanes[0].mode).toBe("off");
    useDAWStore.getState().undo();
    expect(currentTrack("a")).toMatchObject({ automationReadEnabled: true, automationEnabled: true });
    expect(currentTrack("a").automationLanes[0].mode).toBe("read");
    useDAWStore.getState().redo();
    expect(currentTrack("a").automationReadEnabled).toBe(false);

    commandManager.clear();
    useDAWStore.getState().toggleTrackAutomationWrite("a");
    expect(currentTrack("a")).toMatchObject({ automationReadEnabled: true, automationWriteEnabled: true });
    useDAWStore.getState().undo();
    expect(currentTrack("a")).toMatchObject({ automationReadEnabled: false, automationWriteEnabled: false });
    useDAWStore.getState().redo();
    expect(currentTrack("a")).toMatchObject({ automationReadEnabled: true, automationWriteEnabled: true });
  });
});

describe("undo-aware structural track mutations", () => {
  it("duplicates a track as one reversible native/store transaction", async () => {
    vi.spyOn(nativeBridge, "addTrack").mockImplementation(async (trackId) => trackId || "mock-track");
    vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "closeAllPluginWindows").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    useDAWStore.setState({
      tracks: [track("source")],
      selectedTrackId: "source",
      selectedTrackIds: ["source"],
      lastSelectedTrackId: "source",
    });

    await useDAWStore.getState().duplicateTrack("source");
    const duplicateId = useDAWStore.getState().tracks.find((candidate) => candidate.id !== "source")?.id;
    expect(duplicateId).toBeTruthy();
    expect(useDAWStore.getState().selectedTrackIds).toEqual([duplicateId]);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((candidate) => candidate.id)).toEqual(["source"]));
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["source"]);

    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks.map((candidate) => candidate.id)).toEqual(["source", duplicateId]));
    expect(useDAWStore.getState().selectedTrackIds).toEqual([duplicateId]);
  });

  it("sets multiple track and clip colors in one undo step", () => {
    const midiClip = {
      id: "midi",
      name: "MIDI",
      startTime: 0,
      duration: 1,
      offset: 0,
      color: "#222222",
      events: [],
      ccEvents: [],
    };
    useDAWStore.setState({
      tracks: [
        track("a", { clips: [audioClip("audio")], midiClips: [midiClip] }),
        track("b", { color: "#333333" }),
      ],
    });

    useDAWStore.getState().setTracksColorWithUndo(["a", "b", "a"], "#abcdef");
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.color)).toEqual(["#abcdef", "#abcdef"]);
    expect(currentTrack("a").clips[0].color).toBe("#abcdef");
    expect(currentTrack("a").midiClips[0].color).toBe("#abcdef");

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.color)).toEqual(["#111111", "#333333"]);
    expect(currentTrack("a").clips[0].color).toBe("#111111");
    expect(currentTrack("a").midiClips[0].color).toBe("#222222");
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((candidate) => candidate.color)).toEqual(["#abcdef", "#abcdef"]);
  });

  it("links and unlinks selections atomically", () => {
    useDAWStore.setState({ tracks: [track("a"), track("b"), track("c")] });

    useDAWStore.getState().addTrackGroup("Group", "a", ["a", "b", "b"], ["mute", "solo"]);
    expect(useDAWStore.getState().trackGroups[0].memberTrackIds).toEqual(["a", "b"]);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().trackGroups).toEqual([]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().trackGroups).toHaveLength(1);

    commandManager.clear();
    useDAWStore.setState({
      trackGroups: [{
        id: "old-group",
        name: "Old",
        leadTrackId: "a",
        memberTrackIds: ["a", "c"],
        linkedParams: ["mute"],
      }],
    });
    useDAWStore.getState().addTrackGroup("Replacement", "a", ["a", "b"], ["mute"]);
    expect(useDAWStore.getState().trackGroups).toHaveLength(1);
    expect(useDAWStore.getState().trackGroups[0]).toMatchObject({
      name: "Replacement",
      memberTrackIds: ["a", "b"],
    });
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().trackGroups[0]).toMatchObject({
      id: "old-group",
      memberTrackIds: ["a", "c"],
    });
    useDAWStore.getState().redo();

    commandManager.clear();
    useDAWStore.getState().unlinkTracksFromGroups(["a"]);
    expect(useDAWStore.getState().trackGroups).toEqual([]);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().trackGroups[0].memberTrackIds).toEqual(["a", "b"]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().trackGroups).toEqual([]);
  });

  it("moves and removes multiple tracks from folders in reversible batches", () => {
    const folder = track("folder", { isFolder: true });
    useDAWStore.setState({ tracks: [folder, track("a"), track("b")] });

    useDAWStore.getState().moveTracksToFolder(["a", "b"], "folder");
    expect([currentTrack("a").parentFolderId, currentTrack("b").parentFolderId]).toEqual(["folder", "folder"]);
    useDAWStore.getState().undo();
    expect([currentTrack("a").parentFolderId, currentTrack("b").parentFolderId]).toEqual([undefined, undefined]);
    useDAWStore.getState().redo();
    expect([currentTrack("a").parentFolderId, currentTrack("b").parentFolderId]).toEqual(["folder", "folder"]);

    commandManager.clear();
    useDAWStore.getState().removeTracksFromFolders(["a", "b"]);
    expect([currentTrack("a").parentFolderId, currentTrack("b").parentFolderId]).toEqual([undefined, undefined]);
    useDAWStore.getState().undo();
    expect([currentTrack("a").parentFolderId, currentTrack("b").parentFolderId]).toEqual(["folder", "folder"]);
  });

  it("consolidates all audio clips in one undoable replacement", async () => {
    vi.spyOn(nativeBridge, "showRenderSaveDialog").mockResolvedValue("C:/renders/consolidated.wav");
    vi.spyOn(nativeBridge, "renderProject").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "clearPitchPreviewRoutesForCorrectedSources").mockResolvedValue(0);
    const syncClipsWithBackend = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      tracks: [track("a", {
        clips: [
          audioClip("one", { startTime: 1, duration: 2 }),
          audioClip("two", { startTime: 4, duration: 1 }),
        ],
      })],
      selectedClipId: "one",
      selectedClipIds: ["one", "two"],
      syncClipsWithBackend,
    });

    await useDAWStore.getState().consolidateTrack("a");
    const consolidatedId = currentTrack("a").clips[0].id;
    expect(currentTrack("a").clips).toHaveLength(1);
    expect(currentTrack("a").clips[0]).toMatchObject({ startTime: 1, duration: 4 });

    useDAWStore.getState().undo();
    expect(currentTrack("a").clips.map((clip) => clip.id)).toEqual(["one", "two"]);
    expect(useDAWStore.getState().selectedClipIds).toEqual(["one", "two"]);
    useDAWStore.getState().redo();
    expect(currentTrack("a").clips.map((clip) => clip.id)).toEqual([consolidatedId]);
  });

  it("re-establishes native freeze state when freeze and unfreeze commands are redone", async () => {
    const freezeSpy = vi.spyOn(nativeBridge, "freezeTrack").mockResolvedValue({
      success: true,
      filePath: "C:/renders/frozen.wav",
      startTime: 0,
      duration: 2,
      sampleRate: 48_000,
    });
    const unfreezeSpy = vi.spyOn(nativeBridge, "unfreezeTrack").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [track("a", { clips: [audioClip("source")] })] });

    useDAWStore.getState().freezeTrack("a");
    await vi.waitFor(() => expect(currentTrack("a").frozen).toBe(true));
    expect(freezeSpy).toHaveBeenCalledTimes(1);
    useDAWStore.getState().undo();
    expect(currentTrack("a").frozen).toBe(false);
    useDAWStore.getState().redo();
    expect(currentTrack("a").frozen).toBe(true);
    await vi.waitFor(() => expect(freezeSpy).toHaveBeenCalledTimes(2));

    commandManager.clear();
    useDAWStore.getState().unfreezeTrack("a");
    await vi.waitFor(() => expect(currentTrack("a").frozen).toBe(false));
    useDAWStore.getState().undo();
    expect(currentTrack("a").frozen).toBe(true);
    await vi.waitFor(() => expect(freezeSpy).toHaveBeenCalledTimes(3));
    useDAWStore.getState().redo();
    expect(currentTrack("a").frozen).toBe(false);
    expect(unfreezeSpy).toHaveBeenCalled();
  });
});

describe("undo-aware master and fade-shape mutations", () => {
  it("commits master volume and pan edits once and restores the backend on undo/redo", async () => {
    const volumeSpy = vi.spyOn(nativeBridge, "setMasterVolume").mockResolvedValue(true);
    const panSpy = vi.spyOn(nativeBridge, "setMasterPan").mockResolvedValue(true);

    useDAWStore.getState().beginMasterVolumeEdit();
    await useDAWStore.getState().setMasterVolume(0.5);
    await useDAWStore.getState().setMasterVolume(0.25);
    useDAWStore.getState().commitMasterVolumeEdit();
    expect(useDAWStore.getState().masterVolume).toBe(0.25);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterVolume).toBe(0.8);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().masterVolume).toBe(0.25);
    expect(volumeSpy).toHaveBeenCalledWith(0.8);

    commandManager.clear();
    useDAWStore.getState().beginMasterPanEdit();
    await useDAWStore.getState().setMasterPan(0.4);
    useDAWStore.getState().commitMasterPanEdit();
    expect(useDAWStore.getState().masterPan).toBe(0.4);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterPan).toBe(0);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().masterPan).toBe(0.4);
    expect(panSpy).toHaveBeenCalledWith(0);
  });

  it("does not create master control undo entries for no-op edits", () => {
    useDAWStore.getState().beginMasterVolumeEdit();
    useDAWStore.getState().commitMasterVolumeEdit();
    useDAWStore.getState().beginMasterPanEdit();
    useDAWStore.getState().commitMasterPanEdit();
    expect(useDAWStore.getState().canUndo).toBe(false);
  });

  it("undoes and redoes master automation read/write mode snapshots", () => {
    useDAWStore.setState({
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: true,
      masterAutomationLanes: [volumeLane()],
    });

    useDAWStore.getState().toggleMasterAutomationRead();
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(false);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(true);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(false);

    commandManager.clear();
    useDAWStore.getState().toggleMasterAutomationWrite();
    expect(useDAWStore.getState().masterAutomationWriteEnabled).toBe(true);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterAutomationWriteEnabled).toBe(false);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().masterAutomationWriteEnabled).toBe(true);
  });

  it("undoes and redoes master mute and mono", () => {
    const volumeSpy = vi.spyOn(nativeBridge, "setMasterVolume").mockResolvedValue(true);
    const monoSpy = vi.spyOn(nativeBridge, "setMasterMono").mockResolvedValue(true);

    useDAWStore.getState().toggleMasterMute();
    expect(useDAWStore.getState().isMasterMuted).toBe(true);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().isMasterMuted).toBe(false);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().isMasterMuted).toBe(true);
    expect(volumeSpy).toHaveBeenCalledWith(0.8);

    commandManager.clear();
    useDAWStore.getState().toggleMasterMono();
    expect(useDAWStore.getState().masterMono).toBe(true);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterMono).toBe(false);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().masterMono).toBe(true);
    expect(monoSpy).toHaveBeenCalledWith(false);
  });

  it("tracks fade-in and fade-out shape changes through undo and redo", () => {
    useDAWStore.setState({
      tracks: [track("a", { clips: [audioClip("clip", { fadeInShape: 1, fadeOutShape: 2 })] })],
    });

    useDAWStore.getState().setClipFadeInShape("clip", 4);
    expect(currentTrack("a").clips[0].fadeInShape).toBe(4);
    useDAWStore.getState().undo();
    expect(currentTrack("a").clips[0].fadeInShape).toBe(1);
    useDAWStore.getState().redo();
    expect(currentTrack("a").clips[0].fadeInShape).toBe(4);

    commandManager.clear();
    useDAWStore.getState().setClipFadeOutShape("clip", 3);
    expect(currentTrack("a").clips[0].fadeOutShape).toBe(3);
    useDAWStore.getState().undo();
    expect(currentTrack("a").clips[0].fadeOutShape).toBe(2);
    useDAWStore.getState().redo();
    expect(currentTrack("a").clips[0].fadeOutShape).toBe(3);
  });
});

describe("undo-aware per-slot FX bypass", () => {
  it("sets track FX bypass and restores the native slot on undo/redo", async () => {
    useDAWStore.setState({ tracks: [track("a")] });
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([{
      index: 0,
      name: "Compressor",
      bypassed: false,
    }]);
    const bypassSpy = vi.spyOn(nativeBridge, "bypassTrackFX").mockResolvedValue(true);

    await expect(useDAWStore.getState().setFXSlotBypassedWithUndo("a", 0, "track", true))
      .resolves.toBe(true);
    useDAWStore.getState().undo();
    useDAWStore.getState().redo();

    expect(bypassSpy.mock.calls).toEqual([
      ["a", 0, true],
      ["a", 0, false],
      ["a", 0, true],
    ]);
  });

  it("sets input FX bypass and restores the native slot on undo/redo", async () => {
    useDAWStore.setState({ tracks: [track("a")] });
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([{
      index: 0,
      name: "Gate",
      bypassed: true,
    }]);
    const bypassSpy = vi.spyOn(nativeBridge, "bypassTrackInputFX").mockResolvedValue(true);

    await expect(useDAWStore.getState().setFXSlotBypassedWithUndo("a", 0, "input", false))
      .resolves.toBe(true);
    useDAWStore.getState().undo();
    useDAWStore.getState().redo();

    expect(bypassSpy.mock.calls).toEqual([
      ["a", 0, false],
      ["a", 0, true],
      ["a", 0, false],
    ]);
  });

  it("toggles master FX bypass through the same central API", async () => {
    vi.spyOn(nativeBridge, "getMasterFX").mockResolvedValue([{
      index: 0,
      name: "Limiter",
      bypassed: false,
    }]);
    const bypassSpy = vi.spyOn(nativeBridge, "bypassMasterFX").mockResolvedValue(true);

    await expect(useDAWStore.getState().toggleFXSlotBypassWithUndo("master", 0, "master"))
      .resolves.toBe(true);
    useDAWStore.getState().undo();
    useDAWStore.getState().redo();

    expect(bypassSpy.mock.calls).toEqual([
      [0, true],
      [0, false],
      [0, true],
    ]);
  });

  it("rejects invalid or missing slots without creating undo history", async () => {
    useDAWStore.setState({ tracks: [track("a")] });
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);

    await expect(useDAWStore.getState().setFXSlotBypassedWithUndo("a", 3, "track", true))
      .resolves.toBe(false);
    expect(commandManager.canUndo()).toBe(false);
  });
});

describe("undo-aware master FX removal", () => {
  it.each([
    {
      label: "built-in",
      pluginType: "builtin",
      pluginName: "OpenStudio Limiter",
      pluginReference: "OpenStudio Limiter",
      addKind: "builtin" as const,
      bypassed: true,
      precisionOverride: "float32" as const,
    },
    {
      label: "S13FX",
      pluginType: "s13fx",
      pluginName: "Transient Designer",
      pluginReference: "C:/effects/transient.jsfx",
      addKind: "s13fx" as const,
      bypassed: false,
      precisionOverride: "auto" as const,
    },
    {
      label: "hosted plug-in",
      pluginType: "clap",
      pluginName: "Studio Compressor",
      pluginReference: "C:/plugins/compressor.clap",
      addKind: "hosted" as const,
      bypassed: true,
      precisionOverride: "auto" as const,
    },
  ])("restores a removed $label slot with state, flags, order, undo, and redo", async ({
    pluginType,
    pluginName,
    pluginReference,
    addKind,
    bypassed,
    precisionOverride,
  }) => {
    const target = {
      index: 1,
      name: pluginName,
      type: pluginType,
      pluginPath: pluginReference,
      bypassed,
      precisionOverride,
    };
    const getMasterFXSpy = vi.spyOn(nativeBridge, "getMasterFX")
      .mockResolvedValueOnce([
        { index: 0, name: "Before" },
        target,
        { index: 2, name: "After" },
      ])
      .mockResolvedValueOnce([
        { index: 0, name: "Before" },
        { index: 1, name: "After" },
        { ...target, index: 2 },
      ]);
    const savedState = `base64-${pluginType}`;
    vi.spyOn(nativeBridge, "getMasterPluginState").mockResolvedValue(savedState);
    const removeSpy = vi.spyOn(nativeBridge, "removeMasterFX").mockResolvedValue(true);
    const addSpies = {
      builtin: vi.spyOn(nativeBridge, "addMasterBuiltInFX").mockResolvedValue(true),
      s13fx: vi.spyOn(nativeBridge, "addMasterS13FX").mockResolvedValue(true),
      hosted: vi.spyOn(nativeBridge, "addMasterFX").mockResolvedValue(true),
    };
    const stateSpy = vi.spyOn(nativeBridge, "setMasterPluginState").mockResolvedValue(true);
    const bypassSpy = vi.spyOn(nativeBridge, "bypassMasterFX").mockResolvedValue(true);
    const precisionSpy = vi.spyOn(nativeBridge, "setMasterFXPrecisionOverride").mockResolvedValue(true);
    const reorderSpy = vi.spyOn(nativeBridge, "reorderMasterFX").mockResolvedValue(true);

    await expect(useDAWStore.getState().removeMasterFXWithUndo(1)).resolves.toBe(true);
    expect(removeSpy).toHaveBeenCalledWith(1);
    expect(commandManager.canUndo()).toBe(true);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(reorderSpy).toHaveBeenCalledWith(2, 1));

    expect(addSpies[addKind]).toHaveBeenCalledWith(pluginReference);
    expect(stateSpy).toHaveBeenCalledWith(2, savedState);
    expect(bypassSpy).toHaveBeenCalledWith(2, bypassed);
    expect(precisionSpy).toHaveBeenCalledWith(2, precisionOverride);
    expect(getMasterFXSpy).toHaveBeenCalledTimes(2);
    expect(stateSpy.mock.invocationCallOrder[0]).toBeLessThan(reorderSpy.mock.invocationCallOrder[0]);
    expect(bypassSpy.mock.invocationCallOrder[0]).toBeLessThan(reorderSpy.mock.invocationCallOrder[0]);
    expect(precisionSpy.mock.invocationCallOrder[0]).toBeLessThan(reorderSpy.mock.invocationCallOrder[0]);

    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(2));
    expect(removeSpy.mock.calls).toEqual([[1], [1]]);
  });

  it("rejects a master slot that cannot be recreated without removing it or adding history", async () => {
    vi.spyOn(nativeBridge, "getMasterFX").mockResolvedValue([{
      index: 0,
      name: "Unidentified plug-in",
      type: "vst3",
    }]);
    const removeSpy = vi.spyOn(nativeBridge, "removeMasterFX").mockResolvedValue(true);

    await expect(useDAWStore.getState().removeMasterFXWithUndo(0)).resolves.toBe(false);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(commandManager.canUndo()).toBe(false);
  });
});
