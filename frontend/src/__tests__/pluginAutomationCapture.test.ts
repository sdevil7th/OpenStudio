import { automationPunchedParameters, automationWriteKey } from "../utils/automationWriteOwnership";
import { envelopeValue } from "../utils/automationEnvelopeEdits";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPluginAutomationCapture, type PluginParameterEdit } from "../services/pluginAutomationCapture";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { _automationTouchedParams, automationTouchKey } from "../store/actions/storeHelpers";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import { resetShortcutContextForTests } from "../utils/shortcutContext";

const initial = useDAWStore.getState();
let emit: (event: PluginParameterEdit) => void;
let stop: () => void;
const param = "plugin_track_0_1";
function event(phase: PluginParameterEdit["phase"], value = 0.7, id = param) {
  emit({ trackId: "track", param: id, phase, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  commandManager.clear();
  automationPunchedParameters.clear();
  const track = createDefaultTrack("track", "Track", "#fff", "audio");
  useDAWStore.setState({ ...initial, tracks: [track], isModified: false,
    keyboardShortcutProfileId: "cubase", customShortcuts: {},
    transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
  vi.spyOn(nativeBridge, "subscribe").mockImplementation((id, handler) => {
    if (id === "pluginParameterEdit") emit = handler;
    return () => {};
  });
  stop = startPluginAutomationCapture();
});
afterEach(() => {
  stop();
  useDAWStore.getState().endAutomationWriteSession();
  commandManager.clear();
  useDAWStore.setState(initial);
  resetShortcutContextForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native plugin and detached NAM automation capture", () => {
  it("creates native-editor lanes with stable identity and preserves the actual pre-edit value", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    emit({trackId:"track",param,phase:"value",value:.8,initialValue:.25,capturedTime:2,capturedWhileRolling:true,
      metadata:{index:1,name:"Gain",hostParamId:"slider:2",meaningSignature:"slider:2|0|Gain|0|2",min:0,max:2,value:.25,text:"0.5"}});
    const lane = useDAWStore.getState().tracks[0].automationLanes[0];
    expect(lane.metadata).toMatchObject({hostParamId:"slider:2",meaningSignature:"slider:2|0|Gain|0|2",min:0,max:2});
    expect(lane.points[0]).toMatchObject({time:0,value:.25});
  });
  it("does not write an event whose parameter meaning differs from the saved curve", () => {
    const state = useDAWStore.getState(); state.addAutomationLane("track",param,"Gain",{name:"Gain",meaningSignature:"old"});
    state.setTrackAutomationWrite("track",true);
    emit({trackId:"track",param,phase:"value",value:.8,capturedTime:2,capturedWhileRolling:true,
      metadata:{index:1,name:"Other",value:.8,text:"",meaningSignature:"new"}});
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([]);
  });
  it("retains rapid extrema at their captured times instead of the display playhead time", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    emit({ trackId: "track", param, phase: "begin", value: .2, capturedTime: 1.1, capturedWhileRolling: true });
    for (const [time, value] of [[1.101, .2], [1.102, .8], [1.103, .3]])
      emit({ trackId: "track", param, phase: "value", value, capturedTime: time, capturedWhileRolling: true, timing: "sample" });
    useDAWStore.setState(state => ({ transport: { ...state.transport, currentTime: 1.105 } }));
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 100);
    event("end");
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points.map(point => [point.time, point.value]))
      .toEqual([[0, .2], [1.1 - .000001, .2], [1.101, .2], [1.102, .8], [1.103, .3], [1.105, .3]]);
  });
  it("captures the final native batch after Stop updates the UI, and includes it in one pass Undo", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    useDAWStore.setState(state => ({ transport: { ...state.transport, isPlaying: false, currentTime: 0 } }));
    for (const phase of ["begin", "value", "end"] as const)
      emit({ trackId: "track", param, phase, value: .8, capturedTime: 2.012, capturedWhileRolling: true, transportFlush: true });
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([expect.objectContaining({time:0,value:.8}), expect.objectContaining({time:2.011999,value:.8}), expect.objectContaining({ time: 2.012, value: .8 })]);
    useDAWStore.getState().endAutomationWriteSession();
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([]);
  });
  it("does not capture stopped native notifications as rolling edits", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    emit({ trackId: "track", param, phase: "value", value: .8, capturedTime: 2, capturedWhileRolling: false });
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
  });
  it.each(["builtin_master_instance_hash:gainDb", "plugin_monitor_instance_hash:0"])("captures master/monitor %s with master Write and undo", id => {
    useDAWStore.getState().setMasterAutomationWrite(true);
    emit({ trackId: "master", param: id, phase: "begin", value: .3, name: "Monitor Gain" });
    emit({ trackId: "master", param: id, phase: "value", value: .8 });
    emit({ trackId: "master", param: id, phase: "end", value: .8 });
    expect(useDAWStore.getState().masterAutomationLanes.find(lane => lane.param === id)?.points)
      .toEqual([expect.objectContaining({time:0,value:.3}), expect.objectContaining({time:1.999999,value:.3}), expect.objectContaining({ time: 2, value: .8 })]);
    useDAWStore.getState().endAutomationWriteSession(); useDAWStore.getState().undo();
    expect(useDAWStore.getState().masterAutomationLanes.find(lane => lane.param === id)?.points).toEqual([]);
  });
  it.each([param, "plugin_instrument_0_0", "builtin_track_0_ampGainDb", "builtin_input_1_mix"])("captures brief %s edits and allows undo", id => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("begin", 0.3, id); event("value", 0.8, id); event("end", 0.8, id);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([
      expect.objectContaining({time:0,value:.3}), expect.objectContaining({time:1.999999,value:.3}),
      expect.objectContaining({ time: 2, value: 0.8 }),
    ]);
    expect(_automationTouchedParams.has(automationTouchKey("track", id))).toBe(false);
    useDAWStore.getState().endAutomationWriteSession();
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([]);
  });
  it("marks stopped edits unsaved without creating automation", () => {
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: false } });
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("value");
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
  });
  it("ignores restore notifications while opening a project", () => {
    useDAWStore.setState({ isProjectLoading: true }); event("value");
    expect(useDAWStore.getState().isModified).toBe(false);
  });
  it("times out value-only plugins without ending explicit held gestures", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("value"); vi.advanceTimersByTime(181);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(false);
    event("begin"); event("value"); vi.advanceTimersByTime(1000);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(true);
    event("end");
  });
  it("does not time out or tear down a gesture owned by the frontend slider", () => {
    const state = useDAWStore.getState();
    state.setTrackAutomationWrite("track", true);
    state.beginAutomationParamTouch("track", param);
    event("value", 0.6);
    vi.advanceTimersByTime(1000);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points.length).toBeGreaterThan(0);
    stop();
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(true);
    state.endAutomationParamTouch("track", param);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(false);
  });
  it("latches the last edit until Write is disabled", () => {
    useDAWStore.getState().setAutomationWriteBehavior("latch");
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("begin"); event("value"); event("end");
    useDAWStore.setState({ transport: { ...useDAWStore.getState().transport, currentTime: 3 } });
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points.slice(-1)[0]?.time).toBe(3);
    useDAWStore.getState().setTrackAutomationWrite("track", false);
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(true);
  });
  it("keeps an explicit gesture held after a value-only notification", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("value");
    event("begin");
    vi.advanceTimersByTime(1000);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(true);
    event("end");
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(false);
  });
  it("releases touches and timers when capture is torn down", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("begin");
    event("value", 0.7, "builtin_track_1_mix");
    stop();
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(false);
    expect(_automationTouchedParams.has(automationTouchKey("track", "builtin_track_1_mix"))).toBe(false);
  });
  it("dispatches Cubase all-track R/W and F6 with timeline/global focus", () => {
    dispatchGlobalShortcut({ key: "w", code: "KeyW", altKey: true });
    expect(useDAWStore.getState().tracks[0].automationWriteEnabled).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(true);
    dispatchGlobalShortcut({ key: "w", code: "KeyW", altKey: true });
    expect(useDAWStore.getState().tracks[0].automationWriteEnabled).toBe(false);
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(true);
    dispatchGlobalShortcut({ key: "r", code: "KeyR", altKey: true });
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(false);
    dispatchGlobalShortcut({ key: "F6", code: "F6" });
    expect(useDAWStore.getState().showEnvelopeManager).toBe(true);
  });
  it("keeps master Read enabled when Write is switched off before recording", () => {
    useDAWStore.getState().setMasterAutomationRead(true);
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(true);
    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().setMasterAutomationWrite(false);
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(true);
  });
  it("removes instrument lanes with the plugin and restores them on undo", async () => {
    vi.spyOn(nativeBridge, "getInstrumentState").mockResolvedValue("saved");
    vi.spyOn(nativeBridge, "removeInstrument").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "loadInstrument").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setInstrumentState").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [{ ...useDAWStore.getState().tracks[0], type: "instrument", instrumentPlugin: "Kontakt" }] });
    useDAWStore.getState().addAutomationLane("track", "plugin_instrument_0_0");
    useDAWStore.getState().addAutomationLane("track", "plugin_track_0_0");
    const before = useDAWStore.getState().tracks[0].automationLanes;
    await useDAWStore.getState().removeInstrumentWithUndo("track");
    expect(useDAWStore.getState().tracks[0].automationLanes.map(lane => lane.param)).toEqual(["plugin_track_0_0"]);
    commandManager.undo();
    for (let i = 0; i < 12; ++i) await Promise.resolve();
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(expect.arrayContaining(before));
    expect(nativeBridge.setInstrumentState).toHaveBeenCalledWith("track", "saved");
  });
});

describe("parameter-owned native capture", () => {

  it.each(["track", "master"])("captures native edits through Preview, Punch, Stop, Undo and AutoJoin for %s", async owner => {
    const state = useDAWStore.getState();
    vi.spyOn(nativeBridge, "getAutomationCurrentValue").mockResolvedValue(.2);
    const previewWrite = vi.spyOn(nativeBridge, "setAutomationPreview").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "clearAutomationPreviews").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "punchAutomationPreviews").mockResolvedValue(6);
    vi.spyOn(nativeBridge, "setAutomationWriteHold").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "clearAutomationWriteHold").mockResolvedValue(true);
    useDAWStore.setState(current => ({ transport: { ...current.transport, isPlaying: false, currentTime: 6 } }));
    state.setAutomationAutoJoin(true);
    const add = (target: string) => owner === "master" ? state.addMasterAutomationLane(target)! : state.addAutomationLane(owner, target)!;
    const id = add(param), other = add("plugin_track_0_2");
    state.applyAutomationEnvelopeEdit(owner, id, [{ time: 0, value: .2 }, { time: 12, value: .2 }], "Baseline");
    const lanes = () => owner === "master" ? useDAWStore.getState().masterAutomationLanes : useDAWStore.getState().tracks[0].automationLanes;
    const curve = () => lanes().find(lane => lane.id === id)!.points;
    const before = structuredClone(curve());
    commandManager.clear();
    useDAWStore.setState(current => ({ transport: { ...current.transport, isPlaying: true } }));
    expect(await state.beginAutomationPreview(owner, id)).toBe(true);
    expect(await state.setAutomationPreviewValue(owner, param, .6)).toBe(true);
    expect(await state.punchAutomationPreview()).toBe(true);
    const previewCalls = previewWrite.mock.calls.length;
    const revision = useDAWStore.getState().automationPreviewSession!.values[param].revision;
    emit({ trackId: owner, param, phase: "begin", value: .6, capturedTime: 7, capturedWhileRolling: true });
    emit({ trackId: owner, param, phase: "value", value: .9, capturedTime: 7.125, capturedWhileRolling: true });
    emit({ trackId: owner, param: "plugin_track_0_2", phase: "value", value: .8, capturedTime: 7.125, capturedWhileRolling: true });
    expect(envelopeValue(curve(), 7.125)).toBe(.9);
    expect(useDAWStore.getState().automationPreviewSession!.values[param]).toMatchObject({ value: .9, revision: revision + 1 });
    expect(previewWrite.mock.calls).toHaveLength(previewCalls);
    expect(lanes().find(lane => lane.id === other)!.points).toEqual([]);
    useDAWStore.setState(current => ({ transport: { ...current.transport, isPlaying: false, currentTime: 6 } }));
    emit({ trackId: owner, param, phase: "value", value: .8, capturedTime: 8, capturedWhileRolling: true, transportFlush: true });
    emit({ trackId: owner, param, phase: "end", value: .8, capturedTime: 8, capturedWhileRolling: true, transportFlush: true });
    state.endAutomationWriteSession(8);
    await state.cancelAutomationPreview();
    expect(curve()).toContainEqual(expect.objectContaining({ time: 8, value: .8 }));
    expect(useDAWStore.getState().automationJoinSession?.entries).toContainEqual(expect.objectContaining({ trackId: owner, param, value: .8, punched: true }));
    expect(await state.prepareAutomationAutoJoin(6)).toBe(true);
    useDAWStore.setState(current => ({ transport: { ...current.transport, isPlaying: true, currentTime: 8.01 } }));
    state.recordAutomationWriteTick(Date.now() + 1000);
    expect(automationPunchedParameters.has(automationWriteKey(owner, param))).toBe(true);
    emit({ trackId: owner, param, phase: "value", value: .7, capturedTime: 8.25, capturedWhileRolling: true });
    expect(envelopeValue(curve(), 8.25)).toBe(.7);
    useDAWStore.setState(current => ({ transport: { ...current.transport, isPlaying: false, currentTime: 8.5 } }));
    state.endAutomationWriteSession(8.5);
    state.undo(); // Joined pass.
    state.undo(); // Original Punch pass.
    expect(curve()).toEqual(before);
    expect(commandManager.canUndo()).toBe(false);
  });
  it.each(["track", "master"])("records a punched %s control with ordinary Write off and preserves other lanes", owner => {
    const state = useDAWStore.getState();
    const id = owner === "master" ? state.addMasterAutomationLane(param)! : state.addAutomationLane(owner, param)!;
    state.applyAutomationEnvelopeEdit(owner, id, [{ time: 0, value: .2 }, { time: 12, value: .2 }], "Baseline");
    const other = owner === "master" ? state.addMasterAutomationLane("plugin_track_0_2")! : state.addAutomationLane(owner, "plugin_track_0_2")!;
    automationPunchedParameters.add(automationWriteKey(owner, param));
    emit({ trackId: owner, param, phase: "value", value: .9, capturedTime: 7, capturedWhileRolling: true });
    emit({ trackId: owner, param: "plugin_track_0_2", phase: "value", value: .8, capturedTime: 7, capturedWhileRolling: true });
    const lanes = owner === "master" ? useDAWStore.getState().masterAutomationLanes : useDAWStore.getState().tracks[0].automationLanes;
    expect(envelopeValue(lanes.find(lane => lane.id === id)!.points, 7)).toBe(.9);
    expect(lanes.find(lane => lane.id === other)!.points).toEqual([]);
  });

  it("keeps Automation Safe effective for a punched native control", () => {
    automationPunchedParameters.add(automationWriteKey("track", param));
    useDAWStore.getState().setPluginAutomationSafe("track", [param], true);
    emit({ trackId: "track", param, phase: "value", value: .9, capturedTime: 7, capturedWhileRolling: true });
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
  });
});
