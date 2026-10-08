import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore, type AutomationLane } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { nativeBridge, type PluginParameterInfo } from "../services/NativeBridge";
import { clearPluginParameterManifests, registerPluginParameterManifest, validatePluginAutomationLane } from "../utils/pluginParameterManifest";
import { prepareUnavailableFXForLoad } from "../utils/automationRecovery";
import { reorderTrackFXAutomationLanes, removeTrackFXAutomationLanes } from "../store/actions/automation";
import { syncAutomationLaneToBackend } from "../store/actions/storeHelpers";
const initial = useDAWStore.getState();
const parameter: PluginParameterInfo = { index: 0, hostParamId: "slider:1", name: "Gain", value: .3, text: ".3", min: 0, max: 2, discrete: false };
const lane: AutomationLane = { id: "lane", param: "plugin_track_0_0", label: "Script: Gain", metadata: { name: "Gain", hostParamId: "slider:1", min: 0, max: 2, discrete: false },
  points: [{ id: "p", time: 2, value: .3 }], mode: "read", readEnabled: true, visible: true, armed: false };
beforeEach(() => {
  commandManager.clear(); clearPluginParameterManifests("track");
  useDAWStore.setState({ ...initial, tracks: [{ ...createDefaultTrack("track", "Track", "#fff", "audio"), automationLanes: [structuredClone(lane)] }] });
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
});
afterEach(() => { commandManager.clear(); vi.restoreAllMocks(); clearPluginParameterManifests("track"); useDAWStore.setState(initial); });
describe("dynamic parameter manifests", () => {
  it("retains cleared references permanently and never lets Undo rebind their old runtime generation", () => {
    const previous = { ...lane, metadata: { ...lane.metadata!, referenceGeneration: 0 } };
    useDAWStore.setState(current => ({ tracks: current.tracks.map(track => ({ ...track, automationLanes: [previous], automationSafeParams: [lane.param] })) }));
    registerPluginParameterManifest("track", "plugin_track_0_", [{ ...parameter, referenceGeneration: 1 }], "example.clap");
    useDAWStore.getState().retirePluginAutomationReferences("track", lane.param);
    const archived = useDAWStore.getState().tracks[0].automationLanes[0];
    expect(archived).toMatchObject({ points: lane.points, readEnabled: false, armed: false, unavailableParameter: { manualRecoveryRequired: true, safe: true } });
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual([]);
    expect(validatePluginAutomationLane("track", archived)).toEqual(archived);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toMatchObject({ points: lane.points, unavailableParameter: { manualRecoveryRequired: true } });
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual([]);
    const load = prepareUnavailableFXForLoad({ trackFXPaths: ["example.clap"], automationLanes: [archived] });
    expect(load.automationLanes?.[0]).toMatchObject({ param: archived.param, unavailableParameter: { manualRecoveryRequired: true } });
    expect(load.unavailableFX).toEqual([]);
  });
  it("uses stable host IDs when indices change", () => {
    registerPluginParameterManifest("track", "plugin_track_0_", [{ ...parameter, index: 5 }], "script.jsfx");
    expect(validatePluginAutomationLane("track", lane)).toMatchObject({ param: "plugin_track_0_5", points: lane.points, unavailableParameter: undefined });
  });
  it("hydrates old built-in metadata without changing a user's envelope name", () => {
    const builtin = { ...lane, param: "builtin_input_1_gain", metadata: undefined };
    registerPluginParameterManifest("track", "builtin_input_1_", [{ ...parameter, builtIn: true, paramId: "gain" }], "OpenStudio Gain Phase");
    expect(validatePluginAutomationLane("track", builtin)).toMatchObject({ param: builtin.param, label: lane.label, metadata: { paramId: "gain", name: "Gain" } });
  });
  it("does not clear a new compatible curve on the address of a retained incompatible curve", async () => {
    const changed = { ...parameter, max: 3 };
    registerPluginParameterManifest("track", "plugin_track_0_", [changed], "script.jsfx");
    const missing = validatePluginAutomationLane("track", lane);
    const active = { ...lane, id: "new", metadata: { ...lane.metadata!, max: 3 }, points: [{ id: "new-p", time: 2, value: .7 }] };
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationLanes: [missing, active] })) }));
    await syncAutomationLaneToBackend("track", missing);
    expect(nativeBridge.setAutomationPoints).not.toHaveBeenCalled();
    await syncAutomationLaneToBackend("track", active);
    expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("track", active.param, [{ time: 2, value: .7 }]);
  });
  it("preserves data and blocks a missing or changed control, including after Undo", () => {
    useDAWStore.getState().refreshPluginAutomationParameters("track", "plugin_track_0_", [{ ...parameter, max: 3 }], "script.jsfx");
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toMatchObject({ param: "unavailable_parameter:plugin_track_0_0", points: lane.points,
      unavailableParameter: { parameterOnly: true, param: "plugin_track_0_0" } });
    expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("track", "plugin_track_0_0", []);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].unavailableParameter?.parameterOnly).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(lane.points);
  });
  it("reattaches a compatible returned parameter and keeps its envelope", () => {
    useDAWStore.getState().refreshPluginAutomationParameters("track", "plugin_track_0_", [], "script.jsfx");
    useDAWStore.getState().refreshPluginAutomationParameters("track", "plugin_track_0_", [parameter], "script.jsfx");
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toMatchObject({ param: lane.param, points: lane.points, label: lane.label, unavailableParameter: undefined });
    expect(commandManager.canUndo()).toBe(true);
  });
  it("does not insert a second FX slot when a saved parameter is unavailable", () => {
    registerPluginParameterManifest("track", "plugin_track_0_", [], "script.jsfx");
    const missing = validatePluginAutomationLane("track", lane);
    const plan = prepareUnavailableFXForLoad({ trackFXPaths: ["script.jsfx"], automationLanes: [missing] });
    expect(plan.trackFXPaths).toEqual(["script.jsfx"]);
    expect(plan.unavailableFX).toEqual([]);
    expect(plan.automationLanes?.[0].param).toBe(lane.param);
  });
  it("remaps retained parameter-only addresses when their actual plugin moves, and removes them with it", () => {
    registerPluginParameterManifest("track", "plugin_track_0_", [], "script.jsfx");
    const missing = validatePluginAutomationLane("track", lane);
    expect(reorderTrackFXAutomationLanes([missing], "track", 0, 2)[0]).toMatchObject({ param: "unavailable_parameter:plugin_track_2_0", unavailableParameter: { param: "plugin_track_2_0" } });
    expect(removeTrackFXAutomationLanes([missing], "track", 0)).toEqual([]);
  });
});
