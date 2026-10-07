import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import { envelopeValue } from "../utils/automationEnvelopeEdits";
import { startAutomationPreviewLifecycle } from "../services/automationPreviewLifecycle";
import { advanceProjectEpoch } from "../utils/projectLifetime";
const initial = useDAWStore.getState();
const norm = (db: number) => (db + 60) / 72;
let stop: (() => void) | undefined;
beforeEach(() => {
  commandManager.clear(); useDAWStore.setState({ ...initial, automationPreviewSession:null, automationCapturedPreview:null,
    tracks:[createDefaultTrack("track","Track","#fff","audio")], transport:{...initial.transport,isPlaying:false,isRecording:false},
    timeSelection:{start:1,end:2} });
  vi.spyOn(nativeBridge,"setAutomationPreview").mockResolvedValue(true);
  vi.spyOn(nativeBridge,"clearAutomationPreviews").mockResolvedValue(true);
});
afterEach(async () => {
  stop?.(); stop=undefined; vi.mocked(nativeBridge.clearAutomationPreviews).mockResolvedValue(true);
  await useDAWStore.getState().cancelAutomationPreview(); vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial);
});
function lane(param: string) { const state=useDAWStore.getState(); const id=state.addAutomationLane("track",param)!; commandManager.clear(); return id; }
describe("audible Preview, Capture and Commit", () => {
  it("auditions and cancels without changing stored points, manual controls or undo history", async () => {
    const id=lane("volume"), state=useDAWStore.getState();
    vi.spyOn(nativeBridge,"getAutomationCurrentValue").mockResolvedValue(-12);
    useDAWStore.setState({isModified:false});
    expect(await state.beginAutomationPreview("track",id)).toBe(true);
    expect(await state.setAutomationPreviewValue("track","volume",norm(-6))).toBe(true);
    expect(nativeBridge.setAutomationPreview).toHaveBeenLastCalledWith("track","volume",-6,"",-1);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([]);
    expect(useDAWStore.getState().tracks[0].volumeDB).toBe(0); expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.canUndo()).toBe(false); expect(await state.cancelAutomationPreview()).toBe(true);
    expect(useDAWStore.getState().automationPreviewSession).toBeNull(); expect(nativeBridge.clearAutomationPreviews).toHaveBeenCalledOnce();
  });
  it("captures multiple held values, preserves both curves outside the range, and commits one undo command", async () => {
    const volumeId=lane("volume"), panId=lane("pan"), state=useDAWStore.getState();
    const volume=[{id:"v0",time:0,value:norm(-12)},{id:"v1",time:4,value:norm(-6)}], pan=[{id:"p0",time:0,value:.2},{id:"p1",time:4,value:.8}];
    useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationLanes:track.automationLanes.map(item=>({...item,points:item.param==="volume"?volume:pan}))}))}));
    await state.beginAutomationPreview("track",volumeId); await state.setAutomationPreviewValue("track","volume",norm(-3));
    await state.beginAutomationPreview("track",panId); await state.setAutomationPreviewValue("track","pan",.9);
    expect(await state.captureAutomationPreview()).toBe(true);
    await state.setAutomationPreviewValue("track","pan",.1); // Captured values stay separate from the live audition.
    expect(await state.commitAutomationPreview()).toBe(true);
    const after=useDAWStore.getState().tracks[0].automationLanes;
    expect(envelopeValue(after[0].points,1.5)).toBeCloseTo(norm(-3)); expect(envelopeValue(after[1].points,1.5)).toBeCloseTo(.9);
    for(const time of [.25,.75,2.5,3.5]) { expect(envelopeValue(after[0].points,time)).toBeCloseTo(envelopeValue(volume,time)); expect(envelopeValue(after[1].points,time)).toBeCloseTo(envelopeValue(pan,time)); }
    state.undo(); expect(useDAWStore.getState().tracks[0].automationLanes.map(item=>item.points)).toEqual([volume,pan]); expect(commandManager.canUndo()).toBe(false);
    state.redo(); expect(envelopeValue(useDAWStore.getState().tracks[0].automationLanes[1].points,1.5)).toBeCloseTo(.9);
  });
  it("keeps switch boundaries stepped when committing a captured Fill", async () => {
    const id=lane("mute"),state=useDAWStore.getState(),before=[{id:"m0",time:0,value:0},{id:"m1",time:4,value:1}];
    useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationLanes:track.automationLanes.map(item=>({...item,points:before}))}))}));
    vi.spyOn(nativeBridge,"getAutomationCurrentValue").mockResolvedValue(0);
    await state.beginAutomationPreview("track",id); await state.setAutomationPreviewValue("track","mute",1); await state.captureAutomationPreview();
    expect(await state.commitAutomationPreview()).toBe(true); const points=useDAWStore.getState().tracks[0].automationLanes[0].points;
    expect(envelopeValue(points,.9,true)).toBe(0); expect(envelopeValue(points,1,true)).toBe(1); expect(envelopeValue(points,2.1,true)).toBe(0); expect(envelopeValue(points,4,true)).toBe(1);
  });
  it("retains a capture after cancellation and refuses stale curves, Safe and Write", async () => {
    const id=lane("pan"),state=useDAWStore.getState(); await state.beginAutomationPreview("track",id); await state.captureAutomationPreview(); await state.cancelAutomationPreview();
    expect(useDAWStore.getState().automationCapturedPreview).not.toBeNull();
    useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationLanes:track.automationLanes.map(item=>({...item,points:[{time:0,value:.3}]}))}))}));
    expect(await state.commitAutomationPreview()).toBe(false); expect(commandManager.canUndo()).toBe(false);
    state.setPluginAutomationSafe("track",["pan"],true); expect(await state.beginAutomationPreview("track",id)).toBe(false);
    state.setPluginAutomationSafe("track",["pan"],false); state.setTrackAutomationWrite("track",true); expect(await state.beginAutomationPreview("track",id)).toBe(false);
  });
  it("cancels when an auditioned parameter disappears, metadata changes, or recording starts", async () => {
    const id=lane("pan"),state=useDAWStore.getState(); stop=startAutomationPreviewLifecycle(); await state.beginAutomationPreview("track",id);
    useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationLanes:[]}))}));
    await vi.waitFor(()=>expect(useDAWStore.getState().automationPreviewSession).toBeNull());
    expect(nativeBridge.clearAutomationPreviews).toHaveBeenCalled();
    const another=lane("pan"); await state.beginAutomationPreview("track",another);
    useDAWStore.setState(current=>({transport:{...current.transport,isRecording:true}}));
    await vi.waitFor(()=>expect(useDAWStore.getState().automationPreviewSession).toBeNull());
  });
  it("does not publish an audition after its asynchronous initialization becomes stale", async () => {
    const id=lane("pan"),state=useDAWStore.getState(); let finish!:(value:number)=>void;
    vi.spyOn(nativeBridge,"getAutomationCurrentValue").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=state.beginAutomationPreview("track",id); await Promise.resolve();
    advanceProjectEpoch(); finish(0); expect(await pending).toBe(false); expect(nativeBridge.setAutomationPreview).not.toHaveBeenCalled();
  });
  it("keeps restoration failures visible and allows Cancel to be retried", async () => {
    const id=lane("pan"),state=useDAWStore.getState(); await state.beginAutomationPreview("track",id);
    vi.mocked(nativeBridge.clearAutomationPreviews).mockResolvedValue(false); expect(await state.cancelAutomationPreview()).toBe(false);
    expect(useDAWStore.getState().automationPreviewSession?.phase).toBe("restoring");
    expect(await state.beginAutomationPreview("track",id)).toBe(false);
    vi.mocked(nativeBridge.clearAutomationPreviews).mockResolvedValue(true); expect(await state.cancelAutomationPreview()).toBe(true);
  });
  it("coalesces queued slider changes and Capture waits for the audible value", async () => {
    const id=lane("pan"),state=useDAWStore.getState(); await state.beginAutomationPreview("track",id); vi.mocked(nativeBridge.setAutomationPreview).mockClear();
    const values=[state.setAutomationPreviewValue("track","pan",.2),state.setAutomationPreviewValue("track","pan",.6),state.setAutomationPreviewValue("track","pan",.9)];
    const captured=state.captureAutomationPreview(); await Promise.all(values); expect(await captured).toBe(true);
    expect(nativeBridge.setAutomationPreview).toHaveBeenCalledOnce(); expect(nativeBridge.setAutomationPreview).toHaveBeenLastCalledWith("track","pan",.8,"",-1);
    expect(useDAWStore.getState().automationCapturedPreview!.values.pan.value).toBe(.9);
  });
});
