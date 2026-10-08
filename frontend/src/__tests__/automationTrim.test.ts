import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { freezeTrimEnvelope, normalizeTrimDB } from "../utils/automationTrim";
import { envelopeValue } from "../utils/automationEnvelopeEdits";
const initial = useDAWStore.getState();
const normal = (db: number) => (db + 60) / 72;
beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({ ...initial, automationTrimLiveValues: {}, masterTrimVolumeDB: 0, masterAutomationTrimWriteEnabled: false,
    tracks: [createDefaultTrack("track", "Track", "#fff", "audio")], transport: { ...initial.transport, isPlaying: false, isRecording: false } });
});
afterEach(() => { useDAWStore.getState().endAutomationWriteSession(); commandManager.clear(); vi.restoreAllMocks(); useDAWStore.setState(initial); });
describe("realtime Trim", () => {
  it("defaults old projects to neutral and clamps finite manual values", () => {
    expect([undefined, null, "6", NaN, Infinity].map(normalizeTrimDB)).toEqual([0, 0, 0, 0, 0]);
    expect(normalizeTrimDB(-70)).toBe(-60); expect(normalizeTrimDB(20)).toBe(12);
  });
  it("makes a continuous manual edit one undoable change", () => {
    const state = useDAWStore.getState(), setter = vi.spyOn(nativeBridge, "setAutomationTrimValue");
    state.beginAutomationTrimEdit("track"); state.setAutomationTrimValue("track", -2); state.setAutomationTrimValue("track", -6); state.commitAutomationTrimEdit("track");
    expect(useDAWStore.getState().tracks[0].trimVolumeDB).toBe(-6); state.undo();
    expect(useDAWStore.getState().tracks[0].trimVolumeDB).toBe(0); expect(commandManager.canUndo()).toBe(false);
    expect(setter).toHaveBeenLastCalledWith("track", 0); state.redo(); expect(useDAWStore.getState().tracks[0].trimVolumeDB).toBe(-6);
  });
  it("writes an independent Trim pass, preserves volume, and restores manual gain when stopping and undoing", () => {
    const state = useDAWStore.getState(), setter = vi.spyOn(nativeBridge, "setAutomationTrimValue");
    state.addAutomationLane("track", "volume"); state.addAutomationLane("track", "pan");
    const volume = [{ id: "v0", time: 0, value: normal(-12) }, { id: "v1", time: 10, value: normal(-6) }];
    useDAWStore.setState(current => ({ tracks: current.tracks.map(track => ({ ...track, automationLanes: track.automationLanes.map(lane => lane.param === "volume" ? { ...lane, points: volume } : lane) })) }));
    state.setAutomationTrimWrite("track", true); state.setTrackAutomationWrite("track", true); commandManager.clear();
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
    state.beginAutomationTrimEdit("track"); state.setAutomationTrimValue("track", -6);
    state.beginAutomationParamTouch("track", "volume"); state.setAutomationWriteValue("track", "volume", 1);
    state.beginAutomationParamTouch("track", "pan"); state.setAutomationWriteValue("track", "pan", 1); state.recordAutomationWriteTick(1000);
    state.commitAutomationTrimEdit("track"); state.endAutomationWriteSession();
    const track = useDAWStore.getState().tracks[0];
    expect(track.automationLanes.find(lane => lane.param === "volume")!.points).toEqual(volume);
    expect(track.automationLanes.find(lane => lane.param === "volume")!.mode).toBe("read");
    expect(track.automationLanes.find(lane => lane.param === "pan")!.points).toEqual([]);
    expect(track.automationLanes.find(lane => lane.param === "trim_volume")!.points).toContainEqual(expect.objectContaining({time:2,value:normal(-6)}));
    expect(track.trimVolumeDB).toBe(0); expect(setter).toHaveBeenLastCalledWith("track", 0);
    state.undo(); expect(useDAWStore.getState().tracks[0].automationLanes.find(lane => lane.param === "trim_volume")!.points).toEqual([]);
  });
  it("records and undoes master Trim without enabling master-wide Write", () => {
    const state = useDAWStore.getState(); state.setAutomationTrimWrite("master", true); commandManager.clear();
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: true, currentTime: 3 } });
    state.beginAutomationTrimEdit("master"); state.setAutomationTrimValue("master", -3); state.commitAutomationTrimEdit("master"); state.endAutomationWriteSession();
    expect(useDAWStore.getState().masterAutomationWriteEnabled).toBe(false);
    expect(useDAWStore.getState().masterAutomationLanes[0].points).toContainEqual(expect.objectContaining({time:3,value:normal(-3)}));
    state.undo(); expect(useDAWStore.getState().masterAutomationLanes[0].points).toEqual([]);
  });
  it("freezes every dB-linear knot and undoes both curves and the manual offset", () => {
    const state = useDAWStore.getState(); state.addAutomationLane("track", "volume"); state.addAutomationLane("track", "trim_volume");
    const base = [{ id:"b0",time:0,value:normal(-12) }, { id:"b1",time:4,value:normal(-6) }], trim = [{id:"t0",time:0,value:normal(0)}, {id:"t1",time:2,value:normal(3)}, {id:"t2",time:4,value:normal(0)}];
    useDAWStore.setState(current => ({ tracks: current.tracks.map(track => ({...track, trimVolumeDB:2, automationLanes:track.automationLanes.map(lane => ({...lane,points:lane.param === "volume" ? base : trim}))})) }));
    commandManager.clear(); expect(state.freezeAutomationTrim("track")).toBe(true);
    const after = useDAWStore.getState().tracks[0]; expect(after.trimVolumeDB).toBe(0); expect(after.automationLanes[1].points).toEqual([]);
    for (const time of [0, 1, 2, 3, 4, 5]) expect(envelopeValue(after.automationLanes[0].points,time)).toBeCloseTo(envelopeValue(base,time)+envelopeValue(trim,time)-normal(0));
    state.undo(); expect(useDAWStore.getState().tracks[0]).toMatchObject({trimVolumeDB:2,automationLanes:[expect.objectContaining({points:base}),expect.objectContaining({points:trim})]});
    expect(commandManager.canUndo()).toBe(false);
  });
  it("rejects freeze operations that would change mute or clip the combined range", () => {
    expect(() => freezeTrimEnvelope([{time:0,value:0}],[],3)).toThrow(/muted/);
    expect(() => freezeTrimEnvelope([{time:0,value:1}],[],3)).toThrow(/range/);
    expect(() => freezeTrimEnvelope([],[],3)).toThrow(/existing/);
  });
});
