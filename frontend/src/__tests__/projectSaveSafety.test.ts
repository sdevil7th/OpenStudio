import type { FXStageSlotState } from "../services/fxStageState";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import { sendAutomationParamId } from "../store/automationParams";

const initial = useDAWStore.getState();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

describe("project save concurrency and recovery", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState({ ...initial, projectPath: "C:/session.osproj", projectName: "Before",
      tracks: [createDefaultTrack("track", "Track", "#fff", "audio")], isModified: true });
    vi.spyOn(nativeBridge, "getNAMLibrary").mockResolvedValue({ installed: [] } as any);
    vi.spyOn(nativeBridge, "getTrackInputFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getTrackFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "getMasterFX").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "removeMasterFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getMIDILearnMappings").mockResolvedValue([]);
    vi.spyOn(nativeBridge, "setRecentProjects").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "saveProjectToFile").mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initial);
  });

  it.each(["master", "monitor"] as const)("round trips a Safe-only %s control and blocks changed parameter meaning", async chain => {
    const param = `plugin_${chain}_instance_fingerprint:0`;
    const stage = [fxSlot({ automationKey: "instance", pluginPath: "vendor.vst3", type: "plugin", state: "opaque" })];
    const parameter = { index: 0, name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-v1", value: .5, text: "", automationId: param, referenceGeneration: 4 };
    let present = true;
    useDAWStore.setState({ masterAutomationSafeParams: [param], masterAutomationLanes: [] });
    vi.mocked(nativeBridge.getMasterFX).mockImplementation(async () => chain === "master" && present ? [{ index: 0, name: "Vendor", pluginPath: "vendor.vst3" }] : []);
    vi.mocked(nativeBridge.removeMasterFX).mockImplementation(async () => { present = false; return true; });
    vi.spyOn(nativeBridge, "getMonitoringFX").mockResolvedValue(chain === "monitor" ? [{ index: 0, name: "Vendor", pluginPath: "vendor.vst3" }] : []);
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async target => target === chain ? stage : []);
    const parameters = vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([parameter]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    expect(JSON.parse(json).masterAutomationSafeParameters).toEqual([expect.objectContaining({ param, metadata: expect.objectContaining({ hostParamId: "sdk-gain" }) })]);
    expect(JSON.parse(json).masterAutomationSafeParameters[0].metadata).not.toHaveProperty("referenceGeneration");
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async target => { if (target === chain) present = true; return true; });
    parameters.mockResolvedValue([{ ...parameter, index: 7, automationId: param.replace(/:0$/, ":7"), referenceGeneration: 0 }]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([param.replace(/:0$/, ":7")]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const remapped = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[1][1]);
    expect(remapped.masterAutomationSafeParameters[0].param).toBe(param.replace(/:0$/, ":7"));
    parameters.mockResolvedValue([{ ...parameter, meaningSignature: "different-control", referenceGeneration: 0 }]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(false);
    expect(useDAWStore.getState().projectRestoreError).toContain("Automation Safe");
    const saves = vi.mocked(nativeBridge.saveProjectToFile).mock.calls.length;
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledTimes(saves);
  });

  it("round trips a Safe-only dedicated instrument by SDK ID and rejects incompatible protection", async () => {
    const param = "plugin_instrument_0_0";
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, type: "instrument", instrumentPlugin: "vendor.vst3", automationSafeParams: [param] })) }));
    vi.spyOn(nativeBridge, "getInstrumentState").mockResolvedValue("opaque-instrument");
    const parameter = { index: 0, name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-v1", value: .5, text: "", automationId: param };
    const parameters = vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([parameter]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    expect(parameters).toHaveBeenCalledWith("track", -1, false);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    vi.spyOn(nativeBridge, "loadInstrument").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setInstrumentState").mockResolvedValue(true);
    parameters.mockResolvedValue([{ ...parameter, index: 8, automationId: "plugin_instrument_0_8" }]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual(["plugin_instrument_0_8"]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    expect(JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[1][1]).tracks[0].automationSafeParameters[0].param).toBe("plugin_instrument_0_8");
    parameters.mockResolvedValue([{ ...parameter, hostParamId: "different-control" }]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(false);
    expect(useDAWStore.getState().projectRestoreError).toContain("Automation Safe");
    expect(await useDAWStore.getState().saveProject()).toBe(false);
  });

  it("does not write a project when a master Safe snapshot is unavailable", async () => {
    useDAWStore.setState({ masterAutomationSafeParams: ["plugin_master_instance_fingerprint:0"] });
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValue([]);
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
  });

  it("restores the fallback instrument mode before validating a Safe-only control", async () => {
    const param = "builtin_instrument_0_instrumentVolume";
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, type: "instrument", builtInInstrument: "drums", automationSafeParams: [param] })) }));
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 0, name: "Level", builtIn: true, paramId: "instrumentVolume", value: .5, text: "", automationId: param }]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    const mode = vi.spyOn(nativeBridge, "setBuiltInPluginParam").mockResolvedValue(true);
    vi.mocked(nativeBridge.getPluginParameters).mockImplementation(async () => {
      expect(mode).toHaveBeenCalledWith({ trackId: "track", chain: "instrument", fxIndex: -1 }, "instrumentMode", 2);
      return [{ index: 0, name: "Level", builtIn: true, paramId: "instrumentVolume", value: .5, text: "", automationId: param }];
    });
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual([param]);
  });

  it.each([false, true])("recovers a stage Safe-only target by SDK ID, with incompatible=%s", async incompatible => {
    const param = "plugin_master_missing_fingerprint:0", remapped = "plugin_master_missing_fingerprint:7";
    const missing = [fxSlot({ automationKey: "missing", pluginPath: "vendor.vst3", state: "opaque" })];
    let native: typeof missing = [];
    const contract = { param, metadata: { name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-v1" } };
    useDAWStore.setState({ masterAutomationLanes: [], masterAutomationSafeParams: [param], masterAutomationSafeParameters: [contract], unavailableFXStages: { master: missing } });
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(native));
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, slots) => { native = structuredClone(slots); return true; });
    vi.mocked(nativeBridge.getMasterFX).mockImplementation(async () => native.map((slot, index) => ({ ...slot, index, name: "Vendor" })));
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 7, name: "Gain", hostParamId: "sdk-gain", meaningSignature: incompatible ? "different" : "gain-v1", value: .5, text: "", automationId: remapped }]);
    expect(await useDAWStore.getState().retryUnavailableFXStage("master")).toBe(!incompatible);
    if (incompatible) {
      expect(native).toEqual([]);
      expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([param]);
      expect(useDAWStore.getState().unavailableFXStages?.master).toEqual(missing);
      expect(commandManager.canUndo()).toBe(false);
    } else {
      expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([remapped]);
      expect(useDAWStore.getState().masterAutomationSafeParameters?.[0].param).toBe(remapped);
      useDAWStore.getState().undo();
      await vi.waitFor(() => expect(useDAWStore.getState().unavailableFXStages?.master).toEqual(missing));
      expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([param]);
      expect(useDAWStore.getState().masterAutomationSafeParameters).toEqual([contract]);
      useDAWStore.getState().redo();
      await vi.waitFor(() => expect(useDAWStore.getState().unavailableFXStages?.master).toBeUndefined());
      expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([remapped]);
    }
  });

  it.each(["input", "track"] as const)("round trips a Safe-only %s control by SDK ID rather than parameter index", async chain => {
    const param = `plugin_${chain}_0_0`;
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationSafeParams: [param] })) }));
    vi.mocked(nativeBridge[chain === "input" ? "getTrackInputFX" : "getTrackFX"]).mockResolvedValue([{ index: 0, name: "Vendor", pluginPath: "vendor.vst3", instanceId: "original" }] as any);
    vi.spyOn(nativeBridge, "getPluginState").mockResolvedValue("state");
    const parameters = vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 0, name: "Gain", hostParamId: "gain", meaningSignature: "gain-contract", referenceGeneration: 7, value: .5, text: "" }]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    const saved = JSON.parse(json).tracks[0].automationSafeParameters;
    expect(saved).toEqual([expect.objectContaining({ param, metadata: expect.objectContaining({ hostParamId: "gain" }) })]);
    expect(saved[0].metadata).not.toHaveProperty("referenceGeneration");
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    vi.spyOn(nativeBridge, chain === "input" ? "addTrackInputFX" : "addTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(true);
    parameters.mockResolvedValue([{ index: 7, name: "Gain (renamed)", hostParamId: "gain", meaningSignature: "gain-contract", value: .5, text: "" }]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual([`plugin_${chain}_0_7`]);
  });
  it("keeps a changed Safe-only parameter unavailable on load and retains its contract for retry", async () => {
    const track = useDAWStore.getState().tracks[0], param = "plugin_track_0_0";
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [{ ...track, trackFXPaths: ["vendor.vst3"],
      automationSafeParams: [param], automationSafeParameters: [{ param, metadata: { name: "Gain", hostParamId: "gain", meaningSignature: "before" } }] }] }));
    vi.spyOn(nativeBridge, "addTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removeTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 0, name: "Gain", hostParamId: "gain", meaningSignature: "after", value: .5, text: "" }]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ automationSafeParams: [], unavailableFX: [expect.objectContaining({ safeParams: [param], safeParameters: [expect.objectContaining({ param })] })] });
  });
  it("does not overwrite the project when a Safe parameter snapshot fails", async () => {
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationSafeParams: ["plugin_track_0_0"] })) }));
    vi.mocked(nativeBridge.getTrackFX).mockResolvedValue([{ index: 0, name: "Vendor", pluginPath: "vendor.vst3" }] as any);
    vi.spyOn(nativeBridge, "getPluginParameters").mockRejectedValue(new Error("Parameter snapshot unavailable"));
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
  });
  it("saves and reopens optional metronome choices, including prepared custom copies", async () => {
    const choices = { metronomeClickPath: "builtin:woodblock", metronomeAccentPath: "C:/cache/custom.wav" };
    useDAWStore.setState(choices);
    await useDAWStore.getState().saveProject();
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    expect(JSON.parse(json)).toMatchObject(choices);
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    vi.spyOn(nativeBridge, "resetMetronomeSounds").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setMetronomeClickSound").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setMetronomeAccentSound").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getMetronomeSoundInfo").mockImplementation(async accent => ({ selection:accent ? choices.metronomeAccentPath : choices.metronomeClickPath, error:"" }));
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState()).toMatchObject(choices);
  });
  it("persists cleared curves as inactive archives and excludes runtime CLAP generations", async () => {
    const points = [{ id: "p", time: 2, value: .7 }];
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationLanes: [{ id: "archived", param: "unavailable_references:plugin_track_0_0:archived",
      points, readEnabled: false, mode: "off", armed: false, visible: true, metadata: { name: "Gain", referenceGeneration: 7 },
      unavailableParameter: { param: "plugin_track_0_0", pluginPath: "", parameterOnly: true, manualRecoveryRequired: true } }] })) }));
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1], saved = JSON.parse(json);
    expect(saved.tracks[0].automationLanes[0]).toMatchObject({ points, unavailableParameter: { manualRecoveryRequired: true } });
    expect(saved.tracks[0].automationLanes[0].metadata).not.toHaveProperty("referenceGeneration");
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes[0]).toMatchObject({ points, unavailableParameter: { manualRecoveryRequired: true }, mode: "off" });
  });
  it("accepts a sound only after native preparation and marks the project edited", async () => {
    vi.spyOn(nativeBridge, "setMetronomeClickSound").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getMetronomeSoundInfo").mockResolvedValue({selection:"C:/cache/prepared.wav",error:""});
    useDAWStore.setState({isModified:false});
    expect(await useDAWStore.getState().setMetronomeClickSound("C:/Downloads/raw.wav")).toBe(true);
    expect(useDAWStore.getState()).toMatchObject({metronomeClickPath:"C:/cache/prepared.wav",isModified:true});
  });
  it("round trips manual Trim and disarms Trim Write without saving a transient offset", async () => {
    useDAWStore.setState(state => ({ masterTrimVolumeDB: -3, masterAutomationTrimWriteEnabled: true,
      automationTrimCoalesce:"after-pass",automationAutoJoinEnabled:true,
      automationJoinSession:{projectEpoch:0,time:8,entries:[]},
      automationTrimLiveValues: { master: 8, track: 7 }, isMasterMuted: true,
      tracks: state.tracks.map(track => ({ ...track, trimVolumeDB: -6, automationTrimWriteEnabled: true })) }));
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1], saved = JSON.parse(json);
    expect(saved).toMatchObject({ masterTrimVolumeDB: -3, masterAutomationTrimWriteEnabled: false,
      automationTrimCoalesce:"after-pass",automationAutoJoinEnabled:true,
      tracks: [expect.objectContaining({trimVolumeDB:-6,automationTrimWriteEnabled:false})] });
    expect(saved).not.toHaveProperty("automationTrimLiveValues");
    expect(saved).not.toHaveProperty("automationJoinSession");
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    const trim = vi.spyOn(nativeBridge, "setAutomationTrimValue"), mute = vi.spyOn(nativeBridge, "setMasterMute");
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState()).toMatchObject({ masterTrimVolumeDB: -3, masterAutomationTrimWriteEnabled: false,
      automationTrimCoalesce:"after-pass",automationAutoJoinEnabled:true,automationJoinSession:null,
      automationTrimLiveValues: {}, tracks: [expect.objectContaining({trimVolumeDB:-6,automationTrimWriteEnabled:false})] });
    expect(trim).toHaveBeenCalledWith("master", -3); expect(trim).toHaveBeenCalledWith("track", -6);
    expect(mute).toHaveBeenLastCalledWith(true);
  });
  it("opens old projects with neutral Trim and rejects malformed offsets", async () => {
    const track = useDAWStore.getState().tracks[0];
    const { trimVolumeDB: _old, ...legacy } = track;
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [legacy] }));
    expect(await useDAWStore.getState().loadProject("C:/legacy.osproj")).toBe(true);
    expect(useDAWStore.getState()).toMatchObject({masterTrimVolumeDB:0,automationTrimCoalesce:"manual",automationAutoJoinEnabled:false,tracks:[expect.objectContaining({trimVolumeDB:0})]});
    vi.mocked(nativeBridge.loadProjectFromFile).mockResolvedValue(JSON.stringify({ masterTrimVolumeDB: "bad", tracks: [{...legacy,trimVolumeDB:100}] }));
    expect(await useDAWStore.getState().loadProject("C:/malformed.osproj")).toBe(true);
    expect(useDAWStore.getState()).toMatchObject({masterTrimVolumeDB:0,tracks:[expect.objectContaining({trimVolumeDB:12})]});
  });
  it("restores output-pair sends after both tracks exist and preserves master routing", async () => {
    const source = createDefaultTrack("source", "Drums", "#fff", "instrument");
    source.masterSendEnabled = false;
    source.sends = [{ destTrackId: "destination", level: .7, pan: -.2, enabled: true, preFader: true, phaseInvert: true, sourceChannel: 4, trimDB:-3 }];
    useDAWStore.setState({ tracks: [source, createDefaultTrack("destination", "Snare", "#fff", "bus")] });
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify(saved));
    const created = new Set<string>();
    vi.spyOn(nativeBridge, "addTrack").mockImplementation(async id => { created.add(id!); return id!; });
    const replace = vi.spyOn(nativeBridge, "replaceTrackSends").mockImplementation(async (from, sends) => created.has(from) && sends.every(send => created.has(send.destTrackId)));
    const add = vi.spyOn(nativeBridge, "addTrackSend");
    const master = vi.spyOn(nativeBridge, "setTrackMasterSendEnabled").mockResolvedValue(true);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(replace).toHaveBeenCalledWith("source", source.sends);
    expect(add).not.toHaveBeenCalled();
    expect(master).toHaveBeenCalledWith("source", false);
    expect(useDAWStore.getState().tracks[0].sends).toEqual(source.sends);
  });

  it("round-trips send envelopes and binds them after native sends exist", async () => {
    const source = createDefaultTrack("source", "Source", "#fff", "audio");
    source.automationReadEnabled = true;
    source.automationEnabled = true;
    source.sends = [{ destTrackId: "destination", level: 0, pan: 0, enabled: false, preFader: true, phaseInvert: false }];
    source.automationLanes = [{ id: "send-lane", param: sendAutomationParamId("destination", "mute"),
      label: "Send: Return / Mute", points: [{ id: "point", time: 1, value: 0 }], visible: true, armed: false, readEnabled: true, mode: "read" }];
    useDAWStore.setState({ tracks: [source, createDefaultTrack("destination", "Return", "#fff", "bus")] });
    await useDAWStore.getState().saveProject();
    const saved = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(saved);
    const sendsCreated = new Set<string>();
    vi.spyOn(nativeBridge, "replaceTrackSends").mockImplementation(async id => { sendsCreated.add(id); return true; });
    const points = vi.spyOn(nativeBridge, "setAutomationPoints").mockImplementation(async (id, param) => {
      if (param.startsWith("send_")) expect(sendsCreated.has(id)).toBe(true);
      return true;
    });
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(source.automationLanes);
    expect(points).toHaveBeenCalledWith("source", source.automationLanes[0].param, [{ time: 1, value: 0 }]);
  });

  it("round-trips optional master/monitor snapshots before binding their persistent envelopes", async () => {
    const param = "builtin_monitor_instance_fingerprint:gainDb";
    const stage = [fxSlot({ automationKey: "instance", name: "Gain", state: "state", bypassed: false })];
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValue(stage);
    useDAWStore.setState({ masterAutomationReadEnabled: true, masterAutomationEnabled: true,
      masterAutomationLanes: [{ id: "stage", param, label: "Monitor Gain", points: [{ id: "p", time: 1, value: .4 }],
        visible: true, readEnabled: true, mode: "read", armed: false }] });
    await useDAWStore.getState().saveProject();
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    expect(JSON.parse(json)).toMatchObject({ masterFXStageState: stage, monitorFXStageState: stage });
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    const restored = new Set<string>();
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async chain => { restored.add(chain); return true; });
    const points = vi.spyOn(nativeBridge, "setAutomationPoints").mockImplementation(async (_id, target, values) => {
      if (target === param && values.length) expect(restored.has("monitor")).toBe(true);
      return true;
    });
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(points).toHaveBeenCalledWith("master", param, [{ time: 1, value: .4 }]);
    expect(useDAWStore.getState().masterAutomationLanes[0].label).toBe("Monitor Gain");
  });

  it("leaves no sends when the complete restored configuration is rejected", async () => {
    const source = createDefaultTrack("source", "Drums", "#fff", "instrument");
    source.sends = [{ destTrackId: "destination", level: .7, pan: 0, enabled: true, preFader: false, phaseInvert: false, sourceChannel: 4 }];
    useDAWStore.setState({ tracks: [source, createDefaultTrack("destination", "Snare", "#fff", "bus")] });
    await useDAWStore.getState().saveProject();
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    vi.spyOn(nativeBridge, "addTrackSend").mockResolvedValue(0);
    vi.spyOn(nativeBridge, "replaceTrackSends").mockResolvedValue(false);
    const enabled = vi.spyOn(nativeBridge, "setTrackSendEnabled").mockResolvedValue(true);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(enabled).not.toHaveBeenCalledWith("source", 0, true);
    expect(useDAWStore.getState().tracks[0].sends).toEqual([]);
    expect(nativeBridge.addTrackSend).not.toHaveBeenCalled();
  });
  it("retains failed stage settings through Save/reopen and restores them when available", async () => {
    const stage = [fxSlot({ automationKey: "missing", pluginPath: "missing.vst3", state: "saved-state", bypassed: false })];
    const saved = { tracks: [], masterFXStageState: stage, monitorFXStageState: stage };
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify(saved));
    const restore = vi.spyOn(nativeBridge, "setFXStageState").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValue([]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().unavailableFXStages).toEqual({ master: stage, monitor: stage });
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const roundTrip = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    expect(JSON.parse(roundTrip).unavailableFXStages).toEqual({ master: stage, monitor: stage });
    vi.mocked(nativeBridge.loadProjectFromFile).mockResolvedValue(roundTrip);
    restore.mockResolvedValue(true);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(restore).toHaveBeenLastCalledWith("monitor", stage);
    expect(useDAWStore.getState().unavailableFXStages).toEqual({});
  });
  it("retains complete legacy master chains and raw state when restoration fails", async () => {
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({tracks: [], masterFXPaths:["missing.vst3", "OpenStudio Gain Phase"], masterFXStates:["exact-vendor-state", "exact-builtin-state"]}));
    vi.spyOn(nativeBridge, "setFXStageState").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValue([]);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    const pending = useDAWStore.getState().unavailableFXStages?.master;
    expect(pending).toMatchObject([{pluginPath:"missing.vst3",state:"exact-vendor-state",type:"plugin"}, {pluginPath:"OpenStudio Gain Phase",state:"exact-builtin-state",type:"builtin"}]);
    expect(new Set(pending?.map(slot => slot.automationKey)).size).toBe(2);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    expect(JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]).unavailableFXStages.master).toEqual(pending);
  });
  it.each(["input", "track"] as const)("retains rejected NAM %s state instead of losing it", async chain => {
    const track = useDAWStore.getState().tracks[0], state = "exact-rejected-NAM-state";
    const savedTrack = { ...track, [`${chain}FXPaths`]: ["OpenStudio NAM Rack"], [`${chain}FXStates`]: [state] };
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [savedTrack] }));
    vi.spyOn(nativeBridge, chain === "input" ? "addTrackInputFX" : "addTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, chain === "input" ? "removeTrackInputFX" : "removeTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(false);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].unavailableFX).toContainEqual(expect.objectContaining({chain,pluginPath:"OpenStudio NAM Rack",state}));
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    expect(JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]).tracks[0].unavailableFX).toContainEqual(expect.objectContaining({chain,state}));
  });
  it("recovers a stage without dropping new live slots, and undoes the saved recovery data", async () => {
    const missing = [fxSlot({ automationKey: "missing", pluginPath: "missing.vst3", state: "saved" })];
    const live = [fxSlot({ automationKey: "new", pluginPath: "new.vst3", state: "new" })];
    let native = live;
    useDAWStore.setState({ unavailableFXStages: { master: missing }, masterAutomationLanes: [{ id: "missing-lane", param: "plugin_master_missing_hash:0",
      points: [{ id: "p", time: 1, value: .4 }], visible: true, readEnabled: true, mode: "read", armed: false }] });
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(native));
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, slots) => { native = slots; return true; });
    expect(await useDAWStore.getState().retryUnavailableFXStage("master")).toBe(true);
    expect(native).toEqual([...missing, ...live]);
    expect(useDAWStore.getState().unavailableFXStages?.master).toBeUndefined();
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().unavailableFXStages?.master).toEqual(missing));
    expect(native).toEqual(live);
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(useDAWStore.getState().unavailableFXStages?.master).toBeUndefined());
    expect(native).toEqual([...missing, ...live]);
  });

  it("saves sidechain slots and restores later-created source tracks after failed FX loads", async () => {
    useDAWStore.setState({ tracks: [createDefaultTrack("track", "Destination", "#fff", "audio"), createDefaultTrack("key", "Key", "#fff", "audio")] });
    vi.mocked(nativeBridge.getTrackFX).mockImplementation(async id => id === "track" ? [
      { index: 0, name: "Missing", pluginPath: "missing.vst3" },
      { index: 1, name: "Compressor", pluginPath: "OpenStudio Compressor" },
    ] as any : []);
    vi.spyOn(nativeBridge, "getPluginState").mockResolvedValue("state");
    vi.spyOn(nativeBridge, "getSidechainSource").mockImplementation(async (_id, index) => index === 1 ? "key" : "");
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.tracks[0].trackFXSidechains).toEqual(["", "key"]);
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockImplementation(async () => JSON.stringify(saved));
    const created = new Set<string>();
    vi.spyOn(nativeBridge, "addTrack").mockImplementation(async id => { created.add(id!); return id!; });
    vi.spyOn(nativeBridge, "addTrackFX").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "addTrackBuiltInFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(true);
    const restore = vi.spyOn(nativeBridge, "setSidechainSource").mockImplementation(async (_id, _index, source) => created.has(source));
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(restore).toHaveBeenCalledExactlyOnceWith("track", 0, "key");
    restore.mockClear(); delete saved.tracks[0].trackFXSidechains;
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(restore).not.toHaveBeenCalled();
  });

  it("saves MIDI overlap policy and restores it before connecting hardware, with a legacy Raw default", async () => {
    useDAWStore.setState({ tracks: [{ ...useDAWStore.getState().tracks[0], midiOutputMergeKeys: true, midiOutputDevice: "mock-device" }] });
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.tracks[0].midiOutputMergeKeys).toBe(true);
    const calls: string[] = [];
    const restore = vi.spyOn(nativeBridge, "setTrackMIDIOutputMergeKeys").mockImplementation(async () => { calls.push("policy"); return true; });
    vi.spyOn(nativeBridge, "setTrackMIDIOutput").mockImplementation(async () => { calls.push("device"); return true; });
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockImplementation(async () => JSON.stringify(saved));
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(restore).toHaveBeenLastCalledWith("track", true);
    expect(useDAWStore.getState().tracks[0].midiOutputMergeKeys).toBe(true);
    expect(calls.indexOf("policy")).toBeLessThan(calls.indexOf("device"));
    delete saved.tracks[0].midiOutputMergeKeys;
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(restore).toHaveBeenLastCalledWith("track", false);
    expect(!!useDAWStore.getState().tracks[0].midiOutputMergeKeys).toBe(false);
  });
  it("round-trips routing, folders, notes and takes and restores native sends after destinations", async () => {
    const clip = { id: "take", name: "Alternate", filePath: "", startTime: 0, duration: 1, offset: 0 };
    const fields = { stereoWidth: 150, masterSendEnabled: false, outputStartChannel: 2,
      outputChannelCount: 2, playbackOffsetMs: -12, phaseInverted: true, trackChannelCount: 4,
      notes: "Keep this note", waveformZoom: 2, parentFolderId: "bus", activeTakeIndex: 1,
      takes: [[clip]], recordSafe: true, spectralView: true,
      sends: [{ destTrackId: "bus", level: 0, pan: -0.25, enabled: false, preFader: true, phaseInvert: true }] };
    useDAWStore.setState({ tracks: [
      { ...createDefaultTrack("track", "Track"), ...fields } as any,
      { ...createDefaultTrack("bus", "Bus", undefined, "bus"), isFolder: true, folderCollapsed: true },
    ] });
    const addTrack = vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("ok");
    const replaceSends = vi.spyOn(nativeBridge, "replaceTrackSends").mockResolvedValue(true);
    const width = vi.spyOn(nativeBridge, "setTrackStereoWidth");
    const master = vi.spyOn(nativeBridge, "setTrackMasterSendEnabled");
    const offset = vi.spyOn(nativeBridge, "setTrackPlaybackOffset");
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.tracks[0]).toMatchObject(fields);
    expect(saved.tracks[1]).toMatchObject({ isFolder: true, folderCollapsed: true });
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify(saved));
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0]).toMatchObject(fields);
    expect(replaceSends.mock.invocationCallOrder[0]).toBeGreaterThan(addTrack.mock.invocationCallOrder[1]);
    expect(replaceSends).toHaveBeenCalledWith("track", expect.arrayContaining([expect.objectContaining(fields.sends[0])]));
    expect(width).toHaveBeenCalledWith("track", 150);
    expect(master).toHaveBeenCalledWith("track", false);
    expect(offset).toHaveBeenCalledWith("track", -12);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const resaved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[1][1]);
    expect(resaved.tracks[0]).toMatchObject(fields);
  });
  it("restores the channel layout before loading FX and keeps rejected sends dirty", async () => {
    const track = createDefaultTrack("source", "Source", "#fff", "audio");
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [
      { ...track, trackChannelCount: 4, trackFXPaths: ["OpenStudio EQ"], sends: [{ destTrackId: "bus" }] },
      createDefaultTrack("bus", "Return", "#fff", "bus"),
    ] }));
    const channels = vi.spyOn(nativeBridge, "setTrackChannelCount").mockResolvedValue(true);
    const fx = vi.spyOn(nativeBridge, "addTrackBuiltInFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "replaceTrackSends").mockImplementation(async id => id !== "source");
    const toast = vi.spyOn(useDAWStore.getState(), "showToast");
    expect(await useDAWStore.getState().loadProject("C:/routing.osproj")).toBe(true);
    expect(channels).toHaveBeenCalledWith("source", 4);
    expect(channels.mock.invocationCallOrder[0]).toBeLessThan(fx.mock.invocationCallOrder[0]);
    expect(useDAWStore.getState().tracks[0].sends).toEqual([]);
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("routing"), "error");
  });
  it("restores legacy routing defaults without disabling the master", async () => {
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [{ id: "old", name: "Old" }] }));
    expect(await useDAWStore.getState().loadProject("C:/old.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ stereoWidth: 100, masterSendEnabled: true,
      playbackOffsetMs: 0, phaseInverted: false, outputStartChannel: 0, outputChannelCount: 2,
      activeTakeIndex: 0, trackChannelCount: 2 });
  });
  it("reports native routing rejection and keeps the document dirty", async () => {
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [createDefaultTrack("t", "Track")] }));
    vi.spyOn(nativeBridge, "setTrackStereoWidth").mockResolvedValue(false);
    const toast = vi.spyOn(useDAWStore.getState(), "showToast");
    await useDAWStore.getState().loadProject("C:/routing.osproj");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("routing"), "error");
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("clears dirty only for the document actually saved", async () => {
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    expect(useDAWStore.getState().isModified).toBe(false);
  });
  it("round-trips Solo Safe and defaults older projects to disabled", async () => {
    useDAWStore.setState({ tracks: [{ ...useDAWStore.getState().tracks[0], soloSafe: true }] });
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.tracks[0].soloSafe).toBe(true);
    const restore = vi.spyOn(nativeBridge, "setTrackSoloSafe").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockImplementation(async () => JSON.stringify(saved));
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(useDAWStore.getState().tracks[0].soloSafe).toBe(true);
    expect(restore).toHaveBeenLastCalledWith("track", true);
    delete saved.tracks[0].soloSafe;
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(!!useDAWStore.getState().tracks[0].soloSafe).toBe(false);
    expect(restore).toHaveBeenLastCalledWith("track", false);
  });
  it("saves fresh input and track plugin state at the matching slot", async () => {
    vi.mocked(nativeBridge.getTrackInputFX).mockResolvedValue([
      { index: 0, name: "Input", pluginPath: "vendor-input.vst3" },
    ] as any);
    vi.mocked(nativeBridge.getTrackFX).mockResolvedValue([
      { index: 0, name: "Delay", pluginPath: "OpenStudio Delay" },
      { index: 1, name: "Vendor", pluginPath: "vendor.vst3" },
    ] as any);
    const states = vi.spyOn(nativeBridge, "getPluginState").mockImplementation(async (_track, slot, input) =>
      input ? "input-knob-0.8" : [`delay-mix-0.37`, "vendor-gain-0.6"][slot]);
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.tracks[0].inputFXStates).toEqual(["input-knob-0.8"]);
    expect(saved.tracks[0].trackFXPaths).toEqual(["OpenStudio Delay", "vendor.vst3"]);
    expect(saved.tracks[0].trackFXStates).toEqual(["delay-mix-0.37", "vendor-gain-0.6"]);
    expect(states).toHaveBeenCalledTimes(3);
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify(saved));
    vi.spyOn(nativeBridge, "addTrackInputFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "addTrackBuiltInFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "addTrackFX").mockResolvedValue(true);
    const restore = vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(true);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(restore).toHaveBeenCalledWith("track", 0, true, "input-knob-0.8");
    expect(restore).toHaveBeenCalledWith("track", 0, false, "delay-mix-0.37");
    expect(restore).toHaveBeenCalledWith("track", 1, false, "vendor-gain-0.6");
  });
  it("refuses to shift saved state onto the next plugin when identity is missing", async () => {
    vi.mocked(nativeBridge.getTrackFX).mockResolvedValue([
      { index: 0, name: "Unknown" }, { index: 1, name: "Delay", pluginPath: "OpenStudio Delay" },
    ] as any);
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("keeps failed FX envelopes inert and rebinds later restored FX indices", async () => {
    const track = useDAWStore.getState().tracks[0];
    const lane = (index: number) => ({id: `lane${index}`, param: `plugin_track_${index}_0`, label: `FX ${index}`, points: [{id:"p",time:0,value:.4}],
      visible:true, readEnabled:true, mode:"read", armed:false});
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks:[{...track,
      trackFXPaths:["missing.vst3","present.vst3"], automationLanes:[lane(0),lane(1)],
      automationSafeParams:["plugin_track_0_0","plugin_track_1_0"]}] }));
    vi.spyOn(nativeBridge, "addTrackFX").mockImplementation(async (_id, path) => path === "present.vst3");
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    const loaded = useDAWStore.getState().tracks[0];
    expect(loaded.automationLanes[0]).toMatchObject({unavailableParameter:{param:"plugin_track_0_0",pluginPath:"missing.vst3"}});
    expect(loaded.automationLanes[0].param).toMatch(/^unavailable:/);
    expect(loaded.automationLanes[1].param).toBe("plugin_track_0_0");
    expect(loaded.automationSafeParams).toEqual(["plugin_track_0_0"]);
  });
  it("saves JSFX host types and restores scripts through their script loader", async () => {
    vi.mocked(nativeBridge.getTrackFX).mockResolvedValue([{index:0,name:"Script",type:"jsfx",pluginPath:"C:/script.jsfx"}] as any);
    vi.spyOn(nativeBridge, "getPluginState").mockResolvedValue("script-state");
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1];
    expect(JSON.parse(json).tracks[0].trackFXTypes).toEqual(["jsfx"]);
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(json);
    const load = vi.spyOn(nativeBridge, "addTrackJSFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(true);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(load).toHaveBeenCalledWith("track", "C:/script.jsfx", false);
  });
  it("loads the added utility effects through the built-in loader in both chains", async () => {
    const track = useDAWStore.getState().tracks[0], paths=["OpenStudio Preamp","OpenStudio Graphic EQ","OpenStudio Gain Phase"];
    vi.spyOn(nativeBridge,"loadProjectFromFile").mockResolvedValue(JSON.stringify({tracks:[{...track,inputFXPaths:paths,trackFXPaths:paths}]}));
    const add=vi.spyOn(nativeBridge,"addTrackBuiltInFX").mockResolvedValue(true);
    const vendor=vi.spyOn(nativeBridge,"addTrackFX").mockResolvedValue(false);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    for(const path of paths)for(const input of [false,true])expect(add).toHaveBeenCalledWith("track",path,input);
    expect(vendor).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks[0]).toMatchObject({trackFXPaths:paths});
  });
  it("does not save an instrument with silently discarded state after a bridge failure", async () => {
    useDAWStore.setState({ tracks: [{ ...useDAWStore.getState().tracks[0], instrumentPlugin: "Kontakt" }] });
    vi.spyOn(nativeBridge, "getInstrumentState").mockRejectedValue(new Error("state unavailable"));
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
  });
  it("reports rejected third-party state instead of claiming a clean load", async () => {
    const track = useDAWStore.getState().tracks[0];
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({
      tracks: [{ ...track, trackFXPaths: ["vendor.vst3"], trackFXStates: ["saved-knobs"] }],
    }));
    vi.spyOn(nativeBridge, "addTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "removeTrackFX").mockResolvedValue(true);
    const toast = vi.spyOn(useDAWStore.getState(), "showToast");
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("vendor.vst3 state could not be restored"), "error");
    expect(useDAWStore.getState().tracks[0].unavailableFX?.[0]).toMatchObject({ pluginPath: "vendor.vst3", state: "saved-knobs" });
  });
  it.each(["input", "track"] as const)("keeps %s MIDI Learn targets attached across missing-FX compression and repeated save/reopen", async chain => {
    const track = useDAWStore.getState().tracks[0], input = chain === "input";
    const missing = { ccNumber: 1, trackId: "track", chainType: chain, pluginIndex: 0, paramIndex: 0 };
    const live = { ccNumber: 2, trackId: "track", chainType: chain, pluginIndex: 1, paramIndex: 0, builtIn: true, paramId: "gain" };
    const load = vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [{ ...track,
      [input ? "inputFXPaths" : "trackFXPaths"]: ["missing.vst3", "OpenStudio Gain Phase"] }], midiLearnMappings: [missing, live] }));
    vi.spyOn(nativeBridge, input ? "addTrackInputFX" : "addTrackFX").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "addTrackBuiltInFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 0, name: "Gain", builtIn: true, paramId: "gain", min: -60, max: 24, value: .5, text: "" }]);
    const publish = vi.spyOn(nativeBridge, "setMIDILearnMappings").mockResolvedValue(true);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(publish.mock.calls.slice(-1)[0]?.[0]).toEqual([expect.objectContaining({ ...live, pluginIndex: 0 })]);
    expect(useDAWStore.getState().tracks[0].unavailableFX?.[0]).toMatchObject({ midiLearnMappings: [missing] });
    vi.mocked(nativeBridge.getMIDILearnMappings).mockResolvedValue([{ ...live, pluginIndex: 0 }]);
    vi.mocked(input ? nativeBridge.getTrackInputFX : nativeBridge.getTrackFX).mockResolvedValue([{ index: 0, name: "Gain Phase", pluginPath: "OpenStudio Gain Phase", type: "builtin" }]);
    vi.spyOn(nativeBridge, "getPluginState").mockResolvedValue("");
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const json = vi.mocked(nativeBridge.saveProjectToFile).mock.calls.slice(-1)[0][1];
    expect(JSON.parse(json).midiLearnMappings[0]).toMatchObject({ pluginIndex: 0, metadata: { name: "Gain", paramId: "gain" } });
    load.mockResolvedValue(json);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(true);
    expect(publish.mock.calls.slice(-1)[0]?.[0]).toEqual([expect.objectContaining({ ...live, pluginIndex: 0 })]);
    expect(useDAWStore.getState().tracks[0].unavailableFX?.[0].midiLearnMappings).toEqual([missing]);
  });
  it("fails closed when rejected plugin recovery cannot be rolled back", async () => {
    const track = useDAWStore.getState().tracks[0];
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [{ ...track, trackFXPaths: ["vendor.vst3"], trackFXStates: ["saved-knobs"] }] }));
    vi.spyOn(nativeBridge, "addTrackFX").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setPluginState").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "removeTrackFX").mockResolvedValue(false);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(false);
    expect(useDAWStore.getState().projectRestoreError).toContain("Could not roll back");
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
  });
  it("retains the last project file when the MIDI Learn snapshot fails", async () => {
    vi.mocked(nativeBridge.getMIDILearnMappings).mockRejectedValue(new Error("CC snapshot unavailable"));
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it.each([false, new Error("CC restore unavailable")])("blocks saving an incomplete MIDI Learn restoration (%s)", async failure => {
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: useDAWStore.getState().tracks }));
    const publish = vi.spyOn(nativeBridge, "setMIDILearnMappings");
    if (failure instanceof Error) publish.mockRejectedValue(failure);
    else publish.mockResolvedValue(failure);
    expect(await useDAWStore.getState().loadProject("C:/session.osproj")).toBe(false);
    expect(useDAWStore.getState().projectRestoreError).toContain("MIDI Learn restoration failed");
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(nativeBridge.saveProjectToFile).not.toHaveBeenCalled();
  });
  it("persists a named mixer snapshot in the project payload", async () => {
    useDAWStore.getState().saveMixerSnapshot("Field mix");
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved.mixerSnapshots).toEqual(useDAWStore.getState().mixerSnapshots);
    expect(saved.mixerSnapshots[0].name).toBe("Field mix");
  });
  it("never persists click-only playback or its pending/error state", async () => {
    useDAWStore.setState({ metronomePracticeEnabled: true, metronomePracticePending: true,
      metronomePracticeError: "runtime only" });
    expect(await useDAWStore.getState().saveProject()).toBe(true);
    const saved = JSON.parse(vi.mocked(nativeBridge.saveProjectToFile).mock.calls[0][1]);
    expect(saved).not.toHaveProperty("metronomePracticeEnabled");
    expect(saved).not.toHaveProperty("metronomePracticePending");
    expect(saved).not.toHaveProperty("metronomePracticeError");
  });
  it("stops click-only playback before native project teardown", async () => {
    const stopPractice = vi.spyOn(nativeBridge, "setMetronomePracticeEnabled").mockResolvedValue(true);
    const closeEditors = vi.spyOn(nativeBridge, "closeAllPluginWindows").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [], metronomePracticeEnabled: true });
    expect(await useDAWStore.getState().newProject()).toBe(true);
    expect(stopPractice).toHaveBeenCalledWith(false);
    expect(stopPractice.mock.invocationCallOrder[0]).toBeLessThan(closeEditors.mock.invocationCallOrder[0]);
    expect(useDAWStore.getState().metronomePracticeEnabled).toBe(false);
  });
  it("does not hide a failed practice stop by resetting the project UI", async () => {
    vi.spyOn(nativeBridge, "setMetronomePracticeEnabled").mockResolvedValue(false);
    const closeEditors = vi.spyOn(nativeBridge, "closeAllPluginWindows");
    useDAWStore.setState({ metronomePracticeEnabled: true });
    const tracks = useDAWStore.getState().tracks;
    expect(await useDAWStore.getState().newProject()).toBe(false);
    expect(closeEditors).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks).toBe(tracks);
    expect(useDAWStore.getState().metronomePracticeEnabled).toBe(true);
  });
  it("does not lose edits made while the file write is pending", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValue(pending.promise);
    const saved = useDAWStore.getState().saveProject();
    await flush();
    useDAWStore.setState({ projectName: "Newer edit", isModified: true });
    pending.resolve(true);
    expect(await saved).toBe(true);
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().projectName).toBe("Newer edit");
  });
  it("tracks native/plugin dirty notifications even when the dirty flag was already true", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValue(pending.promise);
    const saved = useDAWStore.getState().saveProject();
    await flush();
    useDAWStore.getState().setModified(true);
    pending.resolve(true);
    await saved;
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("a backup does not overwrite explicit save state or clear dirty", async () => {
    await useDAWStore.getState().saveProject(false, true);
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledWith("C:/session.osproj", expect.any(String), true, 3, expect.stringMatching(/^[a-f0-9]{32}$/));
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().projectPath).toBe("C:/session.osproj");
  });
  it("never opens a save dialog for an untitled timer backup", async () => {
    const dialog = vi.spyOn(nativeBridge, "showSaveDialog");
    useDAWStore.setState({ projectPath: "" });
    expect(await useDAWStore.getState().saveProject(false, true)).toBe(true);
    expect(dialog).not.toHaveBeenCalled();
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledWith("", expect.any(String), true, 3, expect.stringMatching(/^[a-f0-9]{32}$/));
  });
  it("serializes overlapping saves and snapshots the latest state for the queued save", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValueOnce(pending.promise);
    const first = useDAWStore.getState().saveProject();
    await flush();
    useDAWStore.setState({ projectName: "After" });
    const second = useDAWStore.getState().saveProject();
    await flush();
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await first; await second;
    expect(nativeBridge.saveProjectToFile).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(nativeBridge.saveProjectToFile).mock.calls;
    expect(JSON.parse(calls[0][1]).projectName).toBe("Before");
    expect(JSON.parse(calls[1][1]).projectName).toBe("After");
  });
  it("a late save cannot change the identity/dirty state of a newly opened project", async () => {
    const pending = deferred();
    vi.mocked(nativeBridge.saveProjectToFile).mockReturnValue(pending.promise);
    const saved = useDAWStore.getState().saveProject();
    await flush();
    advanceProjectEpoch();
    useDAWStore.setState({ projectPath: "C:/new.osproj", projectName: "New", isModified: true });
    pending.resolve(true);
    expect(await saved).toBe(false);
    expect(useDAWStore.getState().projectPath).toBe("C:/new.osproj");
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("reports write failure without clearing dirty", async () => {
    vi.mocked(nativeBridge.saveProjectToFile).mockResolvedValue(false);
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(useDAWStore.getState().isModified).toBe(true);
  });
});

function fxSlot(values: Partial<FXStageSlotState> & Pick<FXStageSlotState, "automationKey">): FXStageSlotState {
  return { name: "Vendor", type: "plugin", pluginPath: "vendor.vst3", pluginFormat: "VST3", state: "opaque", bypassed: false, forceFloat: false, ...values };
}
