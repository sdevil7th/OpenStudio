import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore, type AutomationLane } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { compatibleAutomationMetadata, normalizeSavedSafeParameters, normalizeUnavailableFXSlots, resolveSavedSafeParameter, prepareUnavailableFXForLoad, type UnavailableFXSlot } from "../utils/automationRecovery";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import type { MIDILearnMappingInfo } from "../services/NativeBridge";
import { normalizeSavedMIDILearnMappings, resolveSavedMIDILearnParameter } from "../utils/midiLearnRecovery";

const initial = useDAWStore.getState();
const slot: UnavailableFXSlot = { key: "missing", chain: "track", originalIndex: 0, pluginPath: "OpenStudio Gain Phase", pluginType: "builtin", state: "saved", safeParams: ["builtin_track_0_gain"] };
const lane: AutomationLane = { id: "missing-lane", param: "unavailable:gain", label: "Gain (FX unavailable)", points: [{ id: "point", time: 2, value: .3 }],
  visible: true, armed: false, readEnabled: true, mode: "read", unavailableParameter: { param: "builtin_track_0_gain", pluginPath: slot.pluginPath, fxKey: slot.key },
  metadata: { name: "Gain", builtIn: true, paramId: "gain", min: -60, max: 24 } };
let slots: { index: number; pluginPath: string; instanceId: string }[];
let mappings: MIDILearnMappingInfo[];
beforeEach(() => {
  commandManager.clear();
  mappings = [];
  slots = [{ index: 0, pluginPath: "OpenStudio Delay", instanceId: "original-delay" }];
  useDAWStore.setState({ ...initial, automationRecoveryBusy: false, tracks: [{ ...createDefaultTrack("track", "Track", "#fff", "audio"),
    trackFxCount: 1, unavailableFX: [structuredClone(slot)], automationLanes: [structuredClone(lane), { ...structuredClone(lane), id: "delay-lane", param: "builtin_track_0_mix", unavailableParameter: undefined }], automationSafeParams: ["builtin_track_0_mix"] }],
    transport: { ...initial.transport, isPlaying: false, isRecording: false } });
  vi.spyOn(nativeBridge, "getTrackFX").mockImplementation(async () => slots.map((item, index) => ({ ...item, index })));
  vi.spyOn(nativeBridge, "addTrackBuiltInFX").mockImplementation(async (_id, path) => { slots.push({ index: slots.length, pluginPath: path, instanceId: crypto.randomUUID() }); return true; });
  vi.spyOn(nativeBridge, "removeTrackFX").mockImplementation(async (_id, index) => {
    slots.splice(index, 1); mappings = mappings.filter(mapping => mapping.pluginIndex !== index).map(mapping => ({ ...mapping, pluginIndex: mapping.pluginIndex > index ? mapping.pluginIndex - 1 : mapping.pluginIndex })); return true;
  });
  vi.spyOn(nativeBridge, "reorderTrackFX").mockImplementation(async (_id, from, to) => {
    slots.splice(to, 0, slots.splice(from, 1)[0]); mappings = mappings.map(mapping => ({ ...mapping, pluginIndex: mapping.pluginIndex === from ? to
      : from < to && mapping.pluginIndex > from && mapping.pluginIndex <= to ? mapping.pluginIndex - 1
      : from > to && mapping.pluginIndex >= to && mapping.pluginIndex < from ? mapping.pluginIndex + 1 : mapping.pluginIndex })); return true;
  });
  vi.spyOn(nativeBridge, "getMIDILearnMappings").mockImplementation(async () => structuredClone(mappings));
  vi.spyOn(nativeBridge, "setMIDILearnMappings").mockImplementation(async next => { mappings = structuredClone(next); return true; });
  vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 0, name: "Gain", value: .5, text: "0 dB", builtIn: true, paramId: "gain", min: -60, max: 24 }]);
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
});
afterEach(async () => { await vi.waitFor(() => expect(useDAWStore.getState().automationRecoveryBusy).toBeFalsy()); vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial); });

describe("unavailable FX load plans", () => {
  it("retains Safe contracts beyond a single plugin's SDK budget", () => {
    const contracts = Array.from({ length: 8193 }, (_, index) => ({ param: `plugin_track_${Math.floor(index / 4096)}_${index % 4096}`,
      metadata: { name: "Control", hostParamId: `sdk-${index}`, referenceGeneration: 3 } }));
    const restored = normalizeSavedSafeParameters(contracts);
    expect(restored).toHaveLength(8193);
    expect(restored[8192].metadata?.hostParamId).toBe("sdk-8192");
    expect(restored[8192].metadata?.referenceGeneration).toBeUndefined();
    expect(resolveSavedSafeParameter(restored[8192], [{ index: 7, name: "Control", hostParamId: "sdk-8192", value: .5, text: "" }])?.index).toBe(7);
  });
  it("remaps live and missing Safe contracts without persisting runtime generations", () => {
    const contract = { param: "plugin_track_0_2", metadata: { name: "Gain", hostParamId: "sdk-gain", referenceGeneration: 7 } };
    const plan = prepareUnavailableFXForLoad({ trackFXPaths: ["Delay"], automationSafeParams: [contract.param], automationSafeParameters: [contract],
      unavailableFX: [{ ...slot, safeParams: ["plugin_track_0_0"], safeParameters: [{ ...contract, param: "plugin_track_0_0" }] }] });
    expect(plan.automationSafeParameters?.map(entry => entry.param)).toEqual(["plugin_track_1_2", "plugin_track_0_0"]);
    expect(plan.automationSafeParameters?.every(entry => entry.metadata?.referenceGeneration === undefined)).toBe(true);
    expect(resolveSavedSafeParameter(contract, [{ index: 8, name: "Gain", hostParamId: "sdk-gain", value: .5, text: "" }])?.index).toBe(8);
  });

  it("reconstructs both chains, saved state and sidechains without changing the document", () => {
    const document = { trackFXPaths: ["Delay"], unavailableFX: [slot, { ...slot, key: "second", originalIndex: 2, pluginPath: "Reverb", sidechain: "bus", state: "reverb" }], automationLanes: [lane] };
    const original = structuredClone(document), plan = prepareUnavailableFXForLoad(document);
    expect(document).toEqual(original);
    expect(plan.trackFXPaths).toEqual([slot.pluginPath, "Delay", "Reverb"]);
    expect(plan.trackFXStates).toEqual(["saved", "", "reverb"]);
    expect(plan.trackFXSidechains).toEqual(["", "", "bus"]);
    expect(plan.automationLanes?.[0].param).toBe("builtin_track_0_gain");
    expect([...plan.recoveryKeys.track]).toEqual([[0, "missing"], [2, "second"]]);
    expect([...plan.liveIndices.track]).toEqual([[0, 1]]);
  });
  it("remaps live parameters past missing slots and supports legacy unavailable lanes", () => {
    const plan = prepareUnavailableFXForLoad({ trackFXPaths: ["Delay"], automationLanes: [{ ...lane, unavailableParameter: { param: "builtin_track_0_gain", pluginPath: slot.pluginPath } }, { ...lane, id: "live", param: "plugin_track_0_7", unavailableParameter: undefined }] });
    expect(plan.trackFXPaths).toEqual([slot.pluginPath, "Delay"]);
    expect(plan.automationLanes?.map(item => item.param)).toEqual(["builtin_track_0_gain", "plugin_track_1_7"]);
    expect(plan.unavailableFX?.[0].state).toBe("");
  });
  it("retains duplicate plugin paths as separate slots and shifts recovery keys without collisions", () => {
    const plan = prepareUnavailableFXForLoad({ trackFXPaths: ["Delay"], unavailableFX: [{ ...slot, key: "a", originalIndex: 0 }, { ...slot, key: "b", originalIndex: 0 }] });
    expect(plan.trackFXPaths).toHaveLength(3);
    expect([...plan.recoveryKeys.track]).toEqual([[1, "a"], [0, "b"]]);
  });
  it("rejects malformed slots and changed parameter ranges or choices", () => {
    expect(normalizeUnavailableFXSlots([slot, slot, { ...slot, key: "bad", originalIndex: -1 }])).toEqual([expect.objectContaining({ key: "missing" })]);
    expect(compatibleAutomationMetadata(lane.metadata, { ...lane.metadata!, max: 12 })).toBe(false);
    expect(compatibleAutomationMetadata(undefined, { name: "Legacy" })).toBe(true);
  });
});

describe("unavailable FX transactions", () => {
  it("recovers a Safe-only parameter by stable SDK ID after a parameter reorder, with one Undo/Redo", async () => {
    const protectedSlot = { ...slot, safeParams: ["plugin_track_0_0"], safeParameters: [{ param: "plugin_track_0_0", metadata: { name: "Gain", hostParamId: "sdk-gain", meaningSignature: "continuous-gain" } }] };
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationLanes: [], unavailableFX: [protectedSlot] })) }));
    vi.mocked(nativeBridge.getPluginParameters).mockResolvedValue([{ index: 7, name: "Gain", value: .5, text: "", hostParamId: "sdk-gain", meaningSignature: "continuous-gain" }]);
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual(["builtin_track_1_mix", "plugin_track_0_7"]);
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].unavailableFX).toEqual([protectedSlot]));
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].automationSafeParams).toContain("plugin_track_0_7"));
    expect(useDAWStore.getState().tracks[0].automationSafeParams).not.toContain("plugin_track_0_0");
  });
  it("retains a Safe-only FX when the protected parameter's meaning changed", async () => {
    const protectedSlot = { ...slot, safeParams: ["plugin_track_0_0"], safeParameters: [{ param: "plugin_track_0_0", metadata: { name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-before" } }] };
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationLanes: [], unavailableFX: [protectedSlot] })) }));
    vi.mocked(nativeBridge.getPluginParameters).mockResolvedValue([{ index: 0, name: "Gain", value: .5, text: "", hostParamId: "sdk-gain", meaningSignature: "gain-after" }]);
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(false);
    expect(slots).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0].unavailableFX).toEqual([protectedSlot]);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("uses a legacy envelope's SDK ID for Safe recovery rather than retaining its old index", async () => {
    const old = { ...lane, metadata: { name: "Gain", hostParamId: "sdk-gain" }, unavailableParameter: { ...lane.unavailableParameter!, param: "plugin_track_0_0" } };
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationLanes: [old], unavailableFX: [{ ...slot, safeParams: ["plugin_track_0_0"] }] })) }));
    vi.mocked(nativeBridge.getPluginParameters).mockResolvedValue([{ index: 7, name: "Gain", value: .5, text: "", hostParamId: "sdk-gain" }]);
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toContain("plugin_track_0_7");
    expect(useDAWStore.getState().tracks[0].automationSafeParams).not.toContain("plugin_track_0_0");
  });

  it("restores a missing FX's MIDI Learn controls without retargeting live controls, including undo and redo", async () => {
    const pending = { ccNumber: 7, trackId: "track", chainType: "track" as const, pluginIndex: 0, paramIndex: 0, builtIn: true, paramId: "gain", metadata: lane.metadata };
    mappings = [{ ccNumber: 11, trackId: "track", chainType: "track", pluginIndex: 0, paramIndex: 0, builtIn: true, paramId: "mix" }];
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, unavailableFX: [{ ...slot, midiLearnMappings: [pending] }] })) }));
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(true);
    expect(mappings).toEqual(expect.arrayContaining([expect.objectContaining({ ccNumber: 7, pluginIndex: 0, paramId: "gain" }), expect.objectContaining({ ccNumber: 11, pluginIndex: 1, paramId: "mix" })]));
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].unavailableFX?.[0].midiLearnMappings).toEqual([pending]));
    expect(mappings).toEqual([expect.objectContaining({ ccNumber: 11, pluginIndex: 0, paramId: "mix" })]);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(mappings).toContainEqual(expect.objectContaining({ ccNumber: 7, pluginIndex: 0, paramId: "gain" })));
  });
  it("preserves a CC reassigned while its original FX was unavailable", async () => {
    const toast = vi.spyOn(useDAWStore.getState(), "showToast");
    mappings = [{ ccNumber: 7, trackId: "track", chainType: "track", pluginIndex: 0, paramIndex: 0, builtIn: true, paramId: "mix" }];
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, unavailableFX: [{ ...slot, midiLearnMappings: [{ ccNumber: 7, trackId: "track", chainType: "track", pluginIndex: 0, paramIndex: 0, builtIn: true, paramId: "gain" }] }] })) }));
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(true);
    expect(mappings).toEqual([expect.objectContaining({ ccNumber: 7, pluginIndex: 1, paramId: "mix" })]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Existing assignments were preserved"), "info");
  });
  it("rejects incompatible MIDI Learn meaning even without an automation envelope", async () => {
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationLanes: [], unavailableFX: [{ ...slot, midiLearnMappings: [{ ccNumber: 7, trackId: "track", chainType: "track", pluginIndex: 0, paramIndex: 0, metadata: { name: "Gain", hostParamId: "old-gain" } }] }] })) }));
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(false);
    expect(slots).toHaveLength(1); expect(mappings).toEqual([]); expect(commandManager.canUndo()).toBe(false);
  });
  it("restores settings and curves, clears old addresses, and undoes/redoes the entire recovery", async () => {
    const before = structuredClone(useDAWStore.getState().tracks[0]);
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(true);
    expect(nativeBridge.setPluginState).toHaveBeenCalledWith("track", 1, false, "saved");
    expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("track", "builtin_track_0_mix", []);
    expect(slots.map(item => item.pluginPath)).toEqual([slot.pluginPath, "OpenStudio Delay"]);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ unavailableFX: [], trackFxCount: 2, automationSafeParams: ["builtin_track_1_mix", "builtin_track_0_gain"],
      automationLanes: [expect.objectContaining({ param: "builtin_track_0_gain", label: "Gain", unavailableParameter: undefined, points: lane.points }), expect.objectContaining({ param: "builtin_track_1_mix" })] });
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].unavailableFX).toEqual(before.unavailableFX));
    expect(slots.map(item => item.instanceId)).toEqual(["original-delay"]);
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(before.automationLanes);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].unavailableFX).toEqual([]));
    expect(slots.map(item => item.pluginPath)).toEqual([slot.pluginPath, "OpenStudio Delay"]);
  });
  it.each(["rejected-state", "exception-state", "changed-parameter", "rejected-reorder"])("rolls back %s without losing saved data or adding history", async failure => {
    const before = structuredClone(useDAWStore.getState().tracks[0]);
    if (failure === "rejected-state") vi.mocked(nativeBridge.setPluginState).mockResolvedValue(false);
    if (failure === "exception-state") vi.mocked(nativeBridge.setPluginState).mockRejectedValue(new Error("State error"));
    if (failure === "changed-parameter") vi.mocked(nativeBridge.getPluginParameters).mockResolvedValue([{ index: 0, name: "Gain", value: .5, text: "", builtIn: true, paramId: "gain", min: -60, max: 12 }]);
    if (failure === "rejected-reorder") vi.mocked(nativeBridge.reorderTrackFX).mockResolvedValue(false);
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(false);
    expect(slots.map(item => item.instanceId)).toEqual(["original-delay"]);
    expect(useDAWStore.getState().tracks[0]).toEqual(before);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("does not touch a replacement project after an asynchronous reply", async () => {
    vi.mocked(nativeBridge.setPluginState).mockImplementation(async () => { advanceProjectEpoch(); useDAWStore.setState({ tracks: [], automationRecoveryBusy: false }); return true; });
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(false);
    expect(nativeBridge.removeTrackFX).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks).toEqual([]);
  });
  it("requires a stopped, unlocked and unfrozen track", async () => {
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: true } });
    expect(await useDAWStore.getState().retryUnavailableFX("track", "missing")).toBe(false);
    expect(nativeBridge.addTrackBuiltInFX).not.toHaveBeenCalled();
  });
});

describe("MIDI Learn saved parameter contracts", () => {
  it("validates legacy mappings, resolves stable IDs after index changes, and excludes runtime generations", () => {
    const mapping = { ccNumber: 1, trackId: "track", chainType: "input" as const, pluginIndex: 0, paramIndex: 3,
      metadata: { name: "Gain", hostParamId: "slider:2", meaningSignature: "gain-v1", referenceGeneration: 9 } };
    const normalized = normalizeSavedMIDILearnMappings([mapping, { ...mapping, ccNumber: 128 }, { ...mapping, pluginIndex: -1 }]);
    expect(normalized).toHaveLength(1); expect(normalized[0].metadata?.referenceGeneration).toBeUndefined();
    const parameter = { index: 7, name: "Gain", hostParamId: "slider:2", meaningSignature: "gain-v1", value: .5, text: "" };
    expect(resolveSavedMIDILearnParameter(normalized[0], [parameter])?.index).toBe(7);
    expect(resolveSavedMIDILearnParameter(normalized[0], [{ ...parameter, meaningSignature: "different" }])).toBeUndefined();
    expect(normalizeSavedMIDILearnMappings([{ ...mapping, metadata: undefined, builtIn: true, paramId: "gain", paramIndex: -1 }])).toHaveLength(1);
    expect(normalizeSavedMIDILearnMappings([{ ...mapping, paramIndex: -1 }])).toEqual([]);
  });
});
