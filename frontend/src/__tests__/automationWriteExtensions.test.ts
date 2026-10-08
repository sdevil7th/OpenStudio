import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { envelopeValue } from "../utils/automationEnvelopeEdits";
import { sendAutomationParamId } from "../store/automationParams";
import { freezeSendTrimEnvelope } from "../utils/automationTrim";
import { startAutomationPreviewLifecycle } from "../services/automationPreviewLifecycle";

const initial=useDAWStore.getState(),norm=(db:number)=>(db+60)/72;
beforeEach(async()=>{
  await useDAWStore.getState().cancelAutomationPreview();useDAWStore.getState().endAutomationWriteSession();commandManager.clear();
  useDAWStore.setState({...initial,tracks:[createDefaultTrack("track","Guitar","#fff","audio")],automationAutoJoinEnabled:false,
    automationJoinSession:null,automationTrimCoalesce:"manual",automationPreviewSession:null,automationCapturedPreview:null,
    transport:{...initial.transport,isPlaying:false,isRecording:false,currentTime:6}});
  vi.spyOn(nativeBridge,"clearAutomationPreviews").mockResolvedValue(true);
  vi.spyOn(nativeBridge,"setAutomationPreview").mockResolvedValue(true);
  vi.spyOn(nativeBridge,"setAutomationWriteHold").mockResolvedValue(true);
  vi.spyOn(nativeBridge,"clearAutomationWriteHold").mockResolvedValue(true);
});
afterEach(async()=>{await useDAWStore.getState().cancelAutomationPreview();useDAWStore.getState().endAutomationWriteSession();commandManager.clear();vi.restoreAllMocks();useDAWStore.setState(initial);});
function volume(){
  const state=useDAWStore.getState(),id=state.addAutomationLane("track","volume")!;
  state.applyAutomationEnvelopeEdit("track",id,[{time:0,value:norm(-6)},{time:12,value:norm(-6)}],"baseline");
  commandManager.clear();return id;
}
const rolling=(time:number)=>useDAWStore.setState(state=>({transport:{...state.transport,isPlaying:true,currentTime:time}}));
const curve=()=>useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param==="volume")!.points;
describe("advanced automation writing",()=>{
  it("extends a punched held value to native Stop when no final animation frame ran",async()=>{
    const id=volume(),state=useDAWStore.getState(),before=structuredClone(curve());rolling(6);
    await state.beginAutomationPreview("track",id);await state.setAutomationPreviewValue("track","volume",norm(-18));await state.punchAutomationPreview();
    useDAWStore.setState(current=>({transport:{...current.transport,isPlaying:false,currentTime:6}}));
    state.endAutomationWriteSession(8.5);await state.cancelAutomationPreview();
    expect(envelopeValue(curve(),8.49)).toBeCloseTo(norm(-18));
    expect(curve()).toContainEqual(expect.objectContaining({time:8.5,value:norm(-18)}));
    state.undo();expect(curve()).toEqual(before);
  });
  it("ends a running Punch when its target becomes Safe",async()=>{
    const id=volume(),state=useDAWStore.getState(),stop=startAutomationPreviewLifecycle();rolling(6);
    try {
      await state.beginAutomationPreview("track",id);await state.punchAutomationPreview();
      useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationSafeParams:["volume"]}))}));
      await state.cancelAutomationPreview();expect(useDAWStore.getState().automationPreviewSession).toBeNull();
      expect(nativeBridge.clearAutomationWriteHold).toHaveBeenCalledWith("track","volume");
    }finally{stop();}
  });
  it("invalidates a reordered target address even when its metadata and curve are unchanged",async()=>{
    const state=useDAWStore.getState(),id=state.addAutomationLane("track","builtin_track_0_gain")!,stop=startAutomationPreviewLifecycle();rolling(6);
    try {
      expect(await state.beginAutomationPreview("track",id)).toBe(true);
      useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationLanes:track.automationLanes.map(lane=>lane.id === id ? {...lane,param:"builtin_track_1_gain"}:lane)}))}));
      await state.cancelAutomationPreview();expect(useDAWStore.getState().automationPreviewSession).toBeNull();
      expect(await state.setAutomationPreviewValue("track","builtin_track_0_gain",.8)).toBe(false);
    }finally{stop();}
  });
  it("Punch writes only auditioned controls and undoes one complete pass including both boundary extensions",async()=>{
    const id=volume(),state=useDAWStore.getState(),before=structuredClone(curve());state.addAutomationLane("track","pan");commandManager.clear();
    rolling(6);expect(await state.beginAutomationPreview("track",id)).toBe(true);await state.setAutomationPreviewValue("track","volume",norm(-18));
    expect(await state.punchAutomationPreview()).toBe(true);expect(useDAWStore.getState().tracks[0].automationWriteEnabled).toBe(false);
    expect(envelopeValue(curve(),5)).toBeCloseTo(norm(-6));rolling(7);state.recordAutomationWriteTick(Date.now()+1000);
    expect(envelopeValue(curve(),6.5)).toBeCloseTo(norm(-18));
    expect(state.writeAutomationToBoundary("start")).toBe(true);expect(state.writeAutomationToBoundary("end")).toBe(true);
    expect(envelopeValue(curve(),1)).toBeCloseTo(norm(-18));expect(envelopeValue(curve(),10)).toBeCloseTo(norm(-18));
    await state.cancelAutomationPreview();
    expect(useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param==="pan")!.points).toEqual([]);
    state.undo();expect(curve()).toEqual(before);expect(commandManager.canUndo()).toBe(false);
    state.redo();expect(envelopeValue(curve(),10)).toBeCloseTo(norm(-18));
  });
  it("protects a target made Safe while the native Punch acknowledgement was pending",async()=>{
    const id=volume(),state=useDAWStore.getState(),before=structuredClone(curve());rolling(6);
    await state.beginAutomationPreview("track",id);
    let resolve!:(value:number)=>void;vi.spyOn(nativeBridge,"punchAutomationPreviews").mockReturnValue(new Promise(done=>{resolve=done;}));
    const pending=state.punchAutomationPreview();await Promise.resolve();await Promise.resolve();
    useDAWStore.setState(current=>({tracks:current.tracks.map(track=>({...track,automationSafeParams:["volume"]}))}));
    resolve(6);expect(await pending).toBe(false);expect(curve()).toEqual(before);expect(useDAWStore.getState().automationPreviewSession).toBeNull();
  });
  it("retains the actual stop point for AutoJoin even if the UI returns to the play start",async()=>{
    const id=volume(),state=useDAWStore.getState();state.setAutomationAutoJoin(true);commandManager.clear();
    rolling(6);await state.beginAutomationPreview("track",id);await state.setAutomationPreviewValue("track","volume",norm(-18));await state.punchAutomationPreview();
    rolling(8);state.recordAutomationWriteTick(Date.now()+1000);
    useDAWStore.setState(current=>({transport:{...current.transport,isPlaying:false,currentTime:6}}));state.endAutomationWriteSession(8);
    await state.cancelAutomationPreview();
    expect(useDAWStore.getState().automationJoinSession?.time).toBe(8);
    expect(await state.prepareAutomationAutoJoin(6)).toBe(true);
    expect(nativeBridge.setAutomationWriteHold).toHaveBeenLastCalledWith("track","volume",-18,8,"",-1);
    const before=structuredClone(curve());rolling(7);state.recordAutomationWriteTick(Date.now()+2000);expect(curve()).toEqual(before);
    rolling(8.02);state.recordAutomationWriteTick(Date.now()+3000);expect(curve()).toContainEqual(expect.objectContaining({time:8,value:norm(-18)}));
    expect(useDAWStore.getState().automationJoinSession).toBeNull();
  });
  it("does not AutoJoin Touch controls or a manually changed captured curve",async()=>{
    const id=volume(),state=useDAWStore.getState();state.setAutomationAutoJoin(true);state.setTrackAutomationWrite("track",true);
    rolling(6);state.beginAutomationParamTouch("track","volume");state.setAutomationWriteValue("track","volume",norm(-18));state.recordAutomationWriteTick(Date.now()+1000);
    state.endAutomationParamTouch("track","volume");state.endAutomationWriteSession(7);expect(useDAWStore.getState().automationJoinSession).toBeNull();
    useDAWStore.setState(current=>({transport:{...current.transport,isPlaying:false},automationJoinSession:{projectEpoch:0,time:8,entries:[{trackId:"track",laneId:id,param:"volume",value:.5,metadataKey:"null",pointsKey:"[]",punched:true}]}}));
    await state.prepareAutomationAutoJoin(6);expect(nativeBridge.setAutomationWriteHold).not.toHaveBeenCalled();
  });
});
describe("send Trim and automatic coalescing",()=>{
  function send(){
    useDAWStore.setState(state=>({tracks:state.tracks.map(track=>({...track,sends:[{destTrackId:"bus",level:.5,pan:0,enabled:true,preFader:false,phaseInvert:false}]}))}));
    const state=useDAWStore.getState(),base=sendAutomationParamId("bus","level"),trim=sendAutomationParamId("bus","trim");
    const id=state.addAutomationLane("track",base)!;state.applyAutomationEnvelopeEdit("track",id,[{time:0,value:.25},{time:12,value:.5}],"send curve");
    state.addAutomationLane("track",trim);commandManager.clear();return {base,trim};
  }
  it("preserves a curved product when coalescing a send and refuses an overload",()=>{
    const base=[{time:0,value:.2},{time:4,value:.8}],trim=[{time:0,value:norm(-12)},{time:4,value:norm(0)}];
    const merged=freezeSendTrimEnvelope(base,trim,0);
    for(let i=0;i<=1000;i++){const time=i/250,expected=envelopeValue(base,time)*Math.pow(10,(envelopeValue(trim,time)*72-60)/20);expect(Math.abs(envelopeValue(merged,time)-expected)).toBeLessThan(.000011);}
    expect(()=>freezeSendTrimEnvelope([{time:0,value:.8}],[],6)).toThrow(/range/);
  });
  it("records a destination-bound send offset without changing level and undoes its coalescing",()=>{
    const {base,trim}=send(),state=useDAWStore.getState();state.setAutomationTrimWrite("track",true);commandManager.clear();
    const old=structuredClone(useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param===base)!.points);
    rolling(6);state.beginAutomationTrimEdit("track",trim);state.setAutomationTrimValue("track",-6,trim);state.commitAutomationTrimEdit("track",trim);
    useDAWStore.setState(current=>({transport:{...current.transport,isPlaying:false}}));state.endAutomationWriteSession();
    expect(useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param===base)!.points).toEqual(old);
    expect(state.freezeAutomationTrim("track",trim)).toBe(true);state.undo();
    expect(useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param===base)!.points).toEqual(old);
    expect(useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param===trim)!.points.length).toBeGreaterThan(0);
  });
  it("coalesces at Stop with a single Undo for the pass and the merge",()=>{
    volume();const state=useDAWStore.getState();state.setAutomationTrimWrite("track",true);state.setAutomationTrimCoalesce("after-pass");commandManager.clear();
    const before=structuredClone(curve());rolling(6);state.beginAutomationTrimEdit("track");state.setAutomationTrimValue("track",-6);state.commitAutomationTrimEdit("track");
    useDAWStore.setState(current=>({transport:{...current.transport,isPlaying:false}}));state.endAutomationWriteSession();
    expect(envelopeValue(curve(),6)).toBeCloseTo(norm(-12));expect(useDAWStore.getState().tracks[0].automationLanes.find(lane=>lane.param==="trim_volume")!.points).toEqual([]);
    state.undo();expect(curve()).toEqual(before);expect(commandManager.canUndo()).toBe(false);
  });
  it("coalesces a Trim pass while another owner's Punch is restoring at Stop",async()=>{
    const id=volume(),state=useDAWStore.getState();
    const other=createDefaultTrack("other","Other","#fff","audio");useDAWStore.setState(current=>({tracks:[...current.tracks,other]}));
    const base=state.addAutomationLane("other","volume")!;state.applyAutomationEnvelopeEdit("other",base,[{time:0,value:norm(-6)},{time:12,value:norm(-6)}],"base");
    state.setAutomationTrimWrite("other",true);state.setAutomationTrimCoalesce("after-pass");commandManager.clear();rolling(6);
    state.beginAutomationTrimEdit("other");state.setAutomationTrimValue("other",-6);state.commitAutomationTrimEdit("other");
    await state.beginAutomationPreview("track",id);await state.setAutomationPreviewValue("track","volume",norm(-18));await state.punchAutomationPreview();
    useDAWStore.setState(current=>({transport:{...current.transport,isPlaying:false}}));state.endAutomationWriteSession(7);await state.cancelAutomationPreview();
    const lanes=useDAWStore.getState().tracks.find(track=>track.id === "other")!.automationLanes;
    expect(lanes.find(lane=>lane.param === "trim_volume")!.points).toEqual([]);
    expect(envelopeValue(lanes.find(lane=>lane.param === "volume")!.points,6.5)).toBeCloseTo(norm(-12));
    state.undo();expect(commandManager.canUndo()).toBe(false);
  });
});
