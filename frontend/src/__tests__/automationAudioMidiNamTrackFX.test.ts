import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fxChainPanelSource from "../components/FXChainPanel.tsx?raw";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AutomationLane,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";
import {
  removeTrackFXAutomationLanes,
  reorderTrackFXAutomationLanes,
} from "../store/actions/automation";

const initialState = useDAWStore.getState();

function makeTrack(id: string, type: "audio" | "midi", lanes: AutomationLane[] = []): Track {
  return {
    ...createDefaultTrack(id, id, "#4488cc", type, []),
    automationLanes: lanes,
  };
}

function lane(id: string, param: string, value = 0.5): AutomationLane {
  return {
    id,
    param,
    points: [{ id: `${id}-point`, time: 1, value }],
    visible: true,
    mode: "read",
    armed: false,
    readEnabled: true,
  };
}

function resetStore(tracks: Track[]) {
  commandManager.clear();
  useDAWStore.setState({
    tracks,
    selectedTrackId: tracks[0]?.id ?? null,
    selectedTrackIds: tracks[0] ? [tracks[0].id] : [],
    globalLocked: false,
    lockSettings: { ...useDAWStore.getState().lockSettings, envelopes: false },
    canUndo: false,
    canRedo: false,
    isModified: false,
  });
}

beforeEach(() => {
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(initialState);
});

describe("audio and MIDI track automation flows", () => {
  it.each([
    ["audio", "volume", 0.75, 1, -6],
    ["midi", "midi_velocity_scale", 0.75, 1, 1.5],
    ["midi", "midi_pitch_bend", 0.75, 1, 0.5],
    ["midi", "midi_channel_pressure", 0.75, 1, 95.25],
    ["midi", "midi_cc_74", 0.75, 1, 95.25],
  ] as const)(
    "creates, edits, syncs and undoes a %s %s lane",
    (trackType, param, value, time, expectedBackendValue) => {
      const track = makeTrack(`track-${trackType}-${param}`, trackType);
      resetStore([track]);

      const laneId = useDAWStore.getState().addAutomationLane(track.id, param);
      expect(laneId).toBeTruthy();
      useDAWStore.getState().addAutomationPoint(track.id, laneId!, time, value);

      const updatedLane = useDAWStore.getState().tracks[0].automationLanes[0];
      expect(updatedLane).toMatchObject({ param, mode: "read", readEnabled: true });
      expect(updatedLane.points).toHaveLength(1);
      expect(nativeBridge.setAutomationPoints).toHaveBeenLastCalledWith(
        track.id,
        param,
        [{ time, value: expectedBackendValue }],
      );
      expect(nativeBridge.setAutomationMode).toHaveBeenLastCalledWith(track.id, param, "read");

      useDAWStore.getState().undo();
      expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([]);
      useDAWStore.getState().redo();
      expect(useDAWStore.getState().tracks[0].automationLanes[0].points)
        .toMatchObject([{ time, value }]);
    },
  );

  it("records one MIDI CC write pass and restores it with one undo", () => {
    const midiTrack = makeTrack("midi-write", "midi", [
      lane("cc74", "midi_cc_74", 0.2),
    ]);
    midiTrack.automationReadEnabled = true;
    midiTrack.automationWriteEnabled = true;
    midiTrack.automationLanes[0].mode = "touch";
    midiTrack.automationLanes[0].armed = true;
    resetStore([midiTrack]);
    useDAWStore.setState({
      transport: { ...useDAWStore.getState().transport, isPlaying: true, currentTime: 2 },
    });

    useDAWStore.getState().beginAutomationParamTouch(midiTrack.id, "midi_cc_74");
    useDAWStore.getState().setAutomationWriteValue(midiTrack.id, "midi_cc_74", 0.8);
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);
    useDAWStore.getState().endAutomationParamTouch(midiTrack.id, "midi_cc_74");
    useDAWStore.getState().endAutomationWriteSession();

    const written = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(written.some((point) => point.time === 2 && point.value === 0.8)).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points)
      .toEqual(midiTrack.automationLanes[0].points);
  });

  it.each(["audio", "midi"] as const)("blocks direct %s automation edits under both automation locks", (type) => {
    const track = makeTrack(`locked-${type}`, type, [lane("locked", type === "midi" ? "midi_cc_1" : "volume")]);
    resetStore([track]);

    for (const lockedState of [
      { globalLocked: true, envelopes: false },
      { globalLocked: false, envelopes: true },
    ]) {
      commandManager.clear();
      useDAWStore.setState({
        globalLocked: lockedState.globalLocked,
        lockSettings: { ...useDAWStore.getState().lockSettings, envelopes: lockedState.envelopes },
      });
      useDAWStore.getState().addAutomationPoint(track.id, "locked", 4, 0.9);
      useDAWStore.getState().setTrackAutomationMode(track.id, "write");
      expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(track.automationLanes[0].points);
      expect(commandManager.getUndoStack()).toHaveLength(0);
    }
  });
});

describe("NAM Rack automation in a track FX chain", () => {
  it("routes add and reorder UI operations through undo-aware store actions", () => {
    expect(fxChainPanelSource).toContain("addTrackBuiltInFXWithUndo(");
    expect(fxChainPanelSource).toContain("reorderTrackFXWithUndo(");
    expect(fxChainPanelSource).not.toContain("success = await nativeBridge.addTrackBuiltInFX(");
    expect(fxChainPanelSource).not.toContain("success = await nativeBridge.reorderTrackFX(");
  });

  it("remaps built-in and hosted automation identities without changing lane or point identity", () => {
    const lanes = [
      lane("nam", "builtin_track_0_ampGainDb", 0.75),
      lane("hosted", "plugin_track_1_17", 0.25),
      lane("input", "builtin_input_0_mix", 0.5),
      lane("volume", "volume", 0.5),
    ];
    const reordered = reorderTrackFXAutomationLanes(lanes, "track", 0, 1);
    expect(reordered.map((entry) => entry.param)).toEqual([
      "builtin_track_1_ampGainDb",
      "plugin_track_0_17",
      "builtin_input_0_mix",
      "volume",
    ]);
    expect(reordered[0].id).toBe("nam");
    expect(reordered[0].points[0].id).toBe("nam-point");

    const removed = removeTrackFXAutomationLanes(reordered, "track", 1);
    expect(removed.map((entry) => entry.param)).toEqual([
      "plugin_track_0_17",
      "builtin_input_0_mix",
      "volume",
    ]);
  });

  it("adds, automates, reorders, removes and restores the exact NAM Rack instance", async () => {
    let slots: Array<Record<string, unknown>> = [];
    vi.spyOn(nativeBridge, "getTrackFX").mockImplementation(async () => slots.map((slot) => ({ ...slot })));
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "addTrackBuiltInFX").mockImplementation(async (_trackId, name) => {
      slots.push({ index: slots.length, name, pluginPath: name, type: "builtin", bypassed: false, precisionOverride: "auto" });
      return true;
    });
    vi.spyOn(nativeBridge, "removeTrackFX").mockImplementation(async (_trackId, index) => {
      if (!slots[index]) return false;
      slots.splice(index, 1);
      slots = slots.map((slot, slotIndex) => ({ ...slot, index: slotIndex }));
      return true;
    });
    vi.spyOn(nativeBridge, "reorderTrackFX").mockImplementation(async (_trackId, from, to) => {
      if (!slots[from] || !slots[to]) return false;
      const [moved] = slots.splice(from, 1);
      slots.splice(to, 0, moved);
      slots = slots.map((slot, slotIndex) => ({ ...slot, index: slotIndex }));
      return true;
    });
    vi.spyOn(nativeBridge, "getPluginState").mockResolvedValue("NAM-STATE");
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "bypassTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackPluginPrecisionOverride").mockResolvedValue(true);

    const track = makeTrack("nam-track", "audio");
    resetStore([track]);
    expect(await useDAWStore.getState().addTrackBuiltInFXWithUndo(
      track.id,
      "OpenStudio NAM Rack",
      "track",
    )).toBe(true);
    expect(slots.map((slot) => slot.name)).toEqual(["OpenStudio NAM Rack"]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    const namLaneId = useDAWStore.getState().addAutomationLane(
      track.id,
      "builtin_track_0_ampGainDb",
      "Amp Gain",
    );
    expect(namLaneId).toBeTruthy();
    useDAWStore.getState().addAutomationPoint(track.id, namLaneId!, 1, 0.75);
    expect(nativeBridge.setAutomationPoints).toHaveBeenLastCalledWith(
      track.id,
      "builtin_track_0_ampGainDb",
      [{ time: 1, value: 0.75 }],
    );
    const originalLane = structuredClone(
      useDAWStore.getState().tracks[0].automationLanes[0],
    );
    slots.push({ index: 1, name: "OpenStudio Delay", pluginPath: "OpenStudio Delay", type: "builtin", bypassed: false, precisionOverride: "auto" });
    commandManager.clear();

    expect(await useDAWStore.getState().reorderTrackFXWithUndo(track.id, 0, 1, "track")).toBe(true);
    expect(slots.map((slot) => slot.name)).toEqual(["OpenStudio Delay", "OpenStudio NAM Rack"]);
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toMatchObject({
      id: namLaneId,
      param: "builtin_track_1_ampGainDb",
    });
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    await vi.waitFor(() => {
      expect(slots.map((slot) => slot.name)).toEqual(["OpenStudio NAM Rack", "OpenStudio Delay"]);
      expect(useDAWStore.getState().tracks[0].automationLanes[0].param).toBe("builtin_track_0_ampGainDb");
    });
    useDAWStore.getState().redo();
    await vi.waitFor(() => {
      expect(slots.map((slot) => slot.name)).toEqual(["OpenStudio Delay", "OpenStudio NAM Rack"]);
      expect(useDAWStore.getState().tracks[0].automationLanes[0].param).toBe("builtin_track_1_ampGainDb");
    });

    commandManager.clear();
    const reorderedLane = structuredClone(
      useDAWStore.getState().tracks[0].automationLanes[0],
    );
    expect(await useDAWStore.getState().removeTrackFXWithUndo(track.id, 1, "track")).toBe(true);
    expect(slots.map((slot) => slot.name)).toEqual(["OpenStudio Delay"]);
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(slots.map((slot) => slot.name)).toEqual(["OpenStudio Delay", "OpenStudio NAM Rack"]));
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toMatchObject({
      id: namLaneId,
      param: "builtin_track_1_ampGainDb",
    });
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toEqual(reorderedLane);
    expect(originalLane).toMatchObject({ id: namLaneId, param: "builtin_track_0_ampGainDb" });
    expect(nativeBridge.setPluginState).toHaveBeenCalledWith(track.id, 1, false, "NAM-STATE");
  });
});
