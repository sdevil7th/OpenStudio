import { automationCrossOverTime } from "../utils/automationCrossOver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import { automationLineCoordinates, automationParameterChoices, formatAutomationParameterValue, quantizeAutomationLaneValue } from "../store/automationParams";
import { editEnvelopeRange, thinEnvelope, envelopeValue } from "../utils/automationEnvelopeEdits";
const initial = useDAWStore.getState();
beforeEach(() => { commandManager.clear(); useDAWStore.setState({ ...initial, automationTouchReturnSeconds: 0, masterAutomationSafeParams: [],
  tracks: [createDefaultTrack("track", "Track", "#fff", "audio")], transport: { ...initial.transport, isPlaying: false } }); });
afterEach(() => { useDAWStore.getState().endAutomationWriteSession(); vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial); });
describe("automation presentation and guarded editing", () => {
  it("finds the first Cross-Over intersection across original curve knots", () => {
    const points = [{time:0,value:.2},{time:1,value:.9},{time:2,value:.2}];
    expect(automationCrossOverTime(points, 0, 2, .6, .6)).toBeCloseTo(4 / 7);
    expect(automationCrossOverTime(points, 0, 2, .95, .95)).toBeUndefined();
    expect(automationCrossOverTime([{time:0,value:0},{time:1,value:1}], 0, 2, .5, .5, true)).toBeUndefined();
  });
  it("uses Touch for main volume and Latch for other controls in Touch/Latch mode", () => {
    const state = useDAWStore.getState();
    state.addAutomationLane("track", "volume"); state.addAutomationLane("track", "pan");
    state.setAutomationWriteBehavior("touch-latch"); state.setTrackAutomationWrite("track", true);
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
    for (const param of ["volume", "pan"]) { state.beginAutomationParamTouch("track", param); state.setAutomationWriteValue("track", param, .8); }
    state.recordAutomationWriteTick(1000);
    for (const param of ["volume", "pan"]) state.endAutomationParamTouch("track", param);
    useDAWStore.setState(current => ({ transport: { ...current.transport, currentTime: 3 } }));
    state.recordAutomationWriteTick(1100);
    const lanes = useDAWStore.getState().tracks[0].automationLanes;
    expect(lanes.find(lane => lane.param === "volume")!.points.slice(-1)[0]?.time).toBe(2);
    expect(lanes.find(lane => lane.param === "pan")!.points.slice(-1)[0]?.time).toBe(3);
    expect(lanes.find(lane => lane.param === "volume")!.mode).toBe("touch");
    expect(lanes.find(lane => lane.param === "pan")!.mode).toBe("latch");
  });
  it("latches Cross-Over until a second touch crosses the original curve, preserves the future, and undoes the pass", () => {
    const before = [{ id: "a", time: 0, value: .3 }, { id: "b", time: 10, value: .3 }];
    const state = useDAWStore.getState();
    state.addAutomationLane("track", "pan");
    useDAWStore.setState(current => ({ tracks: current.tracks.map(track => ({ ...track, automationLanes: track.automationLanes.map(lane => ({ ...lane, points: before })) })) }));
    state.setAutomationWriteBehavior("cross-over"); state.setTrackAutomationWrite("track", true);
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
    state.beginAutomationParamTouch("track", "pan"); state.setAutomationWriteValue("track", "pan", .8); state.recordAutomationWriteTick(1000); state.endAutomationParamTouch("track", "pan");
    useDAWStore.setState(current => ({ transport: { ...current.transport, currentTime: 3 } })); state.recordAutomationWriteTick(1100);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toContainEqual(expect.objectContaining({ time: 3, value: .8 }));
    useDAWStore.setState(current => ({ transport: { ...current.transport, currentTime: 4 } }));
    state.beginAutomationParamTouch("track", "pan"); state.setAutomationWriteValue("track", "pan", .6); state.recordAutomationWriteTick(1200);
    useDAWStore.setState(current => ({ transport: { ...current.transport, currentTime: 5 } })); state.setAutomationWriteValue("track", "pan", .1);
    const after = useDAWStore.getState().tracks[0].automationLanes[0];
    expect(after.mode).toBe("read"); expect(after.points).toContainEqual(expect.objectContaining({ time: 4.6, value: .3 })); expect(after.points.slice(-1)[0]).toEqual(before[1]);
    state.setAutomationWriteValue("track", "pan", .9); state.recordAutomationWriteTick(1400);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(after.points);
    state.endAutomationWriteSession(); state.undo(); expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(before);
  });
  it("keeps lane visibility independent of Read, including existing lanes", () => {
    const state = useDAWStore.getState();
    state.addAutomationLane("track", "pan", "Pan", undefined, { read: false });
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ showAutomation: true, automationReadEnabled: false,
      automationLanes: [expect.objectContaining({ visible: true, readEnabled: false, mode: "off" })] });
    state.addAutomationLane("track", "pan", "Pan", undefined, { read: false });
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(false);
    state.addMasterAutomationLane("plugin_master_instance_hash:0", "Master gain", undefined, { read: false });
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(false);
    state.setAutomationLaneRead("track", useDAWStore.getState().tracks[0].automationLanes[0].id, true);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({automationReadEnabled:true, automationLanes:[expect.objectContaining({mode:"read"})]});
    state.setMasterAutomationLaneRead(useDAWStore.getState().masterAutomationLanes[0].id, true);
    expect(useDAWStore.getState()).toMatchObject({masterAutomationReadEnabled:true, masterAutomationLanes:[expect.objectContaining({mode:"read"})]});
  });
  it("uses native units, enum names, and staircase geometry", () => {
    const metadata = { name: "Mode", builtIn: true, paramId: "mode", min: 0, max: 2, discrete: true,
      type: "enum", enumOptions: [{ value: 0, label: "A" }, { value: 1, label: "B" }, { value: 2, label: "C" }] };
    expect(automationParameterChoices(metadata).map(option => option.value)).toEqual([0, .5, 1]);
    expect(formatAutomationParameterValue(metadata, .5)).toBe("B");
    expect(formatAutomationParameterValue({ name: "Gain", builtIn: true, paramId: "gain", min: -60, max: 24, unit: "dB" }, .5)).toBe("-18 dB");
    expect(automationLineCoordinates([{ time: 0, value: 0 }, { time: 1, value: 1 }], t => t * 10, v => 10 - v * 10, true)).toEqual([0, 10, 10, 10, 10, 0]);
  });
  it("writes an exact Touch return ramp and undoes the complete pass", () => {
    const before = [{ id: "a", time: 0, value: .2 }, { id: "b", time: 5, value: .2 }];
    const track = { ...createDefaultTrack("track", "Track", "#fff", "audio"), automationReadEnabled: true, automationEnabled: true,
      automationWriteEnabled: true, automationLanes: [{ id: "lane", param: "pan", points: before, mode: "touch" as const, readEnabled: true, visible: true, armed: false }] };
    useDAWStore.setState({ tracks: [track], automationTouchReturnSeconds: .25, automationWriteBehavior: "touch",
      transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
    const state = useDAWStore.getState();
    state.beginAutomationParamTouch("track", "pan"); state.setAutomationWriteValue("track", "pan", .8); state.recordAutomationWriteTick(); state.endAutomationParamTouch("track", "pan");
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(expect.arrayContaining([
      expect.objectContaining({ time: 2, value: .8 }), expect.objectContaining({ time: 2.25, value: .2 }),
    ]));
    state.endAutomationWriteSession(); state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(before);
  });
  it("preserves the curve before Touch and returns immediately without erasing future points", () => {
    const before = [{ id: "a", time: 0, value: .2 }, { id: "b", time: 10, value: .4 }];
    const state = useDAWStore.getState(); state.addAutomationLane("track", "pan");
    useDAWStore.setState(current => ({ tracks: current.tracks.map(track => ({ ...track,
      automationReadEnabled: true, automationWriteEnabled: true, automationLanes: track.automationLanes.map(lane => ({ ...lane, points: before, readEnabled: true, mode: "touch" as const })) })),
      automationWriteBehavior: "touch", transport: { ...current.transport, isPlaying: true, currentTime: 2 } }));
    state.beginAutomationParamTouch("track", "pan"); state.setAutomationWriteValue("track", "pan", .8); state.recordAutomationWriteTick(1000);
    let points = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(envelopeValue(points, 1)).toBeCloseTo(.22, 6);
    expect(envelopeValue(points, 2)).toBe(.8);
    state.endAutomationParamTouch("track", "pan");
    points = useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(envelopeValue(points, 3)).toBeCloseTo(.26, 6);
    expect(points.slice(-1)[0]).toEqual(before[1]);
    state.endAutomationWriteSession(); state.undo(); expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(before);
  });
  it("sends the volume Touch return curve to native in dB", () => {
    const publish = vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
    const state = useDAWStore.getState(); state.addAutomationLane("track", "volume");
    useDAWStore.setState(current => ({ tracks: current.tracks.map(track => ({ ...track,
      automationReadEnabled: true, automationWriteEnabled: true, automationLanes: track.automationLanes.map(lane => ({ ...lane, points: [{id:"a",time:0,value: .5},{id:"b",time:5,value:.5}], readEnabled:true,mode:"touch" as const })) })),
      automationWriteBehavior:"touch", automationTouchReturnSeconds:.25, transport:{...current.transport,isPlaying:true,currentTime:2} }));
    state.beginAutomationParamTouch("track", "volume"); state.setAutomationWriteValue("track", "volume", .8); state.recordAutomationWriteTick(); state.endAutomationParamTouch("track", "volume");
    expect(publish.mock.calls.slice(-1)[0]?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({time:2.25,value:-24})]));
  });
  it("snaps manual discrete points to actual choices and preserves undo", () => {
    const metadata = { name: "Mode", builtIn: true, paramId: "mode", min: 0, max: 2, discrete: true,
      type: "enum", enumOptions: [{ value: 0, label: "A" }, { value: 1, label: "B" }, { value: 2, label: "C" }] };
    const state = useDAWStore.getState();
    const id = state.addAutomationLane("track", "builtin_track_0_mode", "Mode", metadata)!;
    state.addAutomationPoint("track", id, 1, .62);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].value).toBe(.5);
    state.moveAutomationPoint("track", id, 0, 2, .91);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0].value).toBe(1);
    state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0]).toMatchObject({time: 1, value: .5});
    expect(quantizeAutomationLaneValue({param: "plugin_track_0_0", metadata: {name: "Many steps", discrete: true}}, .62)).toBe(.62);
  });
  it("preserves the manual baseline around a fill on an empty envelope", () => {
    const points = editEnvelopeRange([], 1, 3, "fill", .6, .7142857);
    expect(envelopeValue(points, 0)).toBeCloseTo(.7142857);
    expect(envelopeValue(points, 2)).toBe(.6);
    expect(envelopeValue(points, 4)).toBeCloseTo(.7142857);
  });
  it("Automation Safe prevents recording and survives undo", () => {
    const state = useDAWStore.getState(); state.setPluginAutomationSafe("track", ["plugin_track_0_0"], true);
    useDAWStore.setState({ tracks: useDAWStore.getState().tracks.map(track => ({ ...track, automationWriteEnabled: true })),
      transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
    state.beginAutomationParamTouch("track", "plugin_track_0_0"); state.setAutomationWriteValue("track", "plugin_track_0_0", .8); state.recordAutomationWriteTick();
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
    state.undo(); expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual([]);
  });
  it("clears replaced instrument protection and restores it on undo", async () => {
    vi.spyOn(nativeBridge, "setBuiltInPluginParam").mockResolvedValue(true);
    const track = {...createDefaultTrack("track", "Track", "#fff", "instrument"), builtInInstrument: "synth" as const,
      automationSafeParams:["builtin_instrument_0_brightness","plugin_track_0_0"]};
    useDAWStore.setState({tracks:[track]});
    expect(await useDAWStore.getState().setBuiltInInstrumentWithUndo("track", "piano")).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toEqual(["plugin_track_0_0"]);
    useDAWStore.getState().undo();
    for(let index=0;index<40;index++) await Promise.resolve();
    expect(useDAWStore.getState().tracks[0].automationSafeParams).toContain("builtin_instrument_0_brightness");
  });
  it("previews edits without mutating points and applies one undoable edit", () => {
    const state = useDAWStore.getState(); const laneId = state.addAutomationLane("track", "pan")!;
    state.applyAutomationEnvelopeEdit("track", laneId, [{ time: 0, value: .2 }, { time: 5, value: .8 }], "Original");
    const before = useDAWStore.getState().tracks[0].automationLanes[0].points;
    const proposal = editEnvelopeRange(before, 1, 3, "fill", .6);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(before);
    state.applyAutomationEnvelopeEdit("track", laneId, proposal, "Fill range"); state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual(before);
  });
  it("preserves outside ranges, clamp crossings and bounded thinning error", () => {
    const before = [{ time: 0, value: 0 }, { time: 10, value: 1 }];
    const edited = editEnvelopeRange(before, 2, 8, "trim", -.5);
    expect(envelopeValue(edited, 1)).toBeCloseTo(.1);
    expect(envelopeValue(edited, 9)).toBeCloseTo(.9);
    expect(envelopeValue(edited, 4)).toBeCloseTo(0);
    expect(envelopeValue(edited, 6)).toBeCloseTo(.1);
    const many = Array.from({ length: 500 }, (_, index) => ({ time: index / 10, value: .5 + Math.sin(index / 10) * .4 }));
    const thinned = thinEnvelope(many, .005);
    expect(thinned.length).toBeLessThan(many.length);
    for (const point of many) expect(Math.abs(envelopeValue(thinned, point.time) - point.value)).toBeLessThanOrEqual(.005 + 1e-10);
  });
});
