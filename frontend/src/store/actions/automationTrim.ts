import type { StoreApi } from "zustand";
import type { AutomationLane, DAWState, DAWActions } from "../useDAWStore";
import { nativeBridge } from "../../services/NativeBridge";
import { getProjectEpoch } from "../../utils/projectLifetime";
import { freezeTrimEnvelope, freezeSendTrimEnvelope, normalizeTrimDB } from "../../utils/automationTrim";
import { parseSendAutomationParamId, sendAutomationParamId, VOLUME_DB_RANGE, VOLUME_MIN_DB } from "../automationParams";
import { commandManager } from "../commands";
import { applyAutomationProjectSnapshot, captureAutomationProjectSnapshot, isAutomationEditLocked,
  pushAppliedAutomationProjectCommand, withResolvedLaneMode } from "./automation";

type State = DAWState & DAWActions;
type Set = StoreApi<State>["setState"];
const rolling = (state: State) => state.transport.isPlaying || state.transport.isRecording;
const owner = (state: State, id: string) => id === "master" ? {
  id, trimVolumeDB: state.masterTrimVolumeDB ?? 0, automationTrimWriteEnabled: state.masterAutomationTrimWriteEnabled,
  automationWriteEnabled: state.masterAutomationWriteEnabled, automationReadEnabled: state.masterAutomationReadEnabled,
  automationLanes: state.masterAutomationLanes,
} : state.tracks.find(track => track.id === id);

export function automationTrimActions(set: Set, get: () => State) {
  const edits = new Map<string, { db: number; epoch: number; writing: boolean }>();
  const key = (id: string, param: string) => param === "trim_volume" ? id : `${id}\n${param}`;
  const sendFor = (id: string, param: string) => {
    const send = parseSendAutomationParamId(param);
    return send?.control === "trim" ? get().tracks.find(track => track.id === id)?.sends.find(item => item.destTrackId === send.destinationId) : undefined;
  };
  const manual = (id: string, param: string) => param === "trim_volume" ? owner(get(), id)?.trimVolumeDB ?? 0 : sendFor(id, param)?.trimDB ?? 0;
  const nativeManual = (id: string, db: number, param: string) => param === "trim_volume" ? nativeBridge.setAutomationTrimValue(id, db) : nativeBridge.setAutomationTrimValue(id, db, param);
  const applyManual = (id: string, db: number, param = "trim_volume") => {
    if (param !== "trim_volume") {
      const send = sendFor(id, param); if (!send) return;
      set(state => ({tracks:state.tracks.map(track => track.id === id ? {...track,sends:track.sends.map(item => item.destTrackId === send.destTrackId ? {...item,trimDB:db} : item)} : track),isModified:true}));
      void nativeManual(id, db, param); return;
    }
    set(state => id === "master" ? { masterTrimVolumeDB: db, isModified: true }
      : { tracks: state.tracks.map(track => track.id === id ? { ...track, trimVolumeDB: db } : track), isModified: true });
    void nativeBridge.setAutomationTrimValue(id, db);
  };
  const syncModes = (id: string) => {
    const state = get(), target = owner(state, id);
    if (!target) return;
    const lanes = target.automationLanes.map(lane => withResolvedLaneMode(target, lane, state.automationWriteBehavior, false) as AutomationLane);
    set(current => id === "master" ? { masterAutomationLanes: lanes }
      : { tracks: current.tracks.map(track => track.id === id ? { ...track, automationLanes: lanes } : track) });
    // Snapshot application publishes all changed modes through the existing native sync path.
    applyAutomationProjectSnapshot(set, get, captureAutomationProjectSnapshot(get()));
  };
  const begin = (id: string, param = "trim_volume") => {
    const state = get(), target = owner(state, id);
    if (!target || (param !== "trim_volume" && !sendFor(id, param)) || isAutomationEditLocked(state) || state.isProjectLoading || state.automationPreviewSession || edits.has(key(id,param))) return;
    const safe = id === "master" ? state.masterAutomationSafeParams : state.tracks.find(track => track.id === id)?.automationSafeParams;
    if (safe?.includes(param)) return;
    const writing = rolling(state) && (target.automationTrimWriteEnabled || target.automationWriteEnabled);
    edits.set(key(id,param), { db: manual(id,param), epoch: getProjectEpoch(), writing: Boolean(writing) });
    if (writing) get().beginAutomationParamTouch(id, param, { time: state.transport.currentTime,
      initialValue: ((state.automationTrimLiveValues?.[key(id,param)] ?? manual(id,param)) - VOLUME_MIN_DB) / VOLUME_DB_RANGE });
  };
  const commit = (id: string, param = "trim_volume") => {
    const edit = edits.get(key(id,param)); edits.delete(key(id,param));
    if (!edit || edit.epoch !== getProjectEpoch()) return;
    if (edit.writing) { get().endAutomationParamTouch(id, param); return; }
    const after = manual(id,param);
    if (edit.db === after) return;
    commandManager.push({ type: "SET_AUTOMATION_TRIM", description: "Adjust manual Trim", timestamp: Date.now(),
      execute: () => applyManual(id, after, param), undo: () => applyManual(id, edit.db, param) });
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
  };
  return {
    setAutomationTrimCoalesce: (policy: "manual" | "after-pass" | "on-exit") => {
      if (!["manual","after-pass","on-exit"].includes(policy) || isAutomationEditLocked(get()) || get().isProjectLoading || rolling(get())) return;
      const before=captureAutomationProjectSnapshot(get()); set({automationTrimCoalesce:policy,isModified:true});
      pushAppliedAutomationProjectCommand(set,get,before,captureAutomationProjectSnapshot(get()),"TRIM_COALESCE_POLICY","Set Trim coalescing policy");
    },
    setAutomationTrimWrite: (id: string, enabled: boolean) => {
      const state = get(), target = owner(state, id);
      if (!target || isAutomationEditLocked(state) || state.isProjectLoading || state.automationPreviewSession || Boolean(target.automationTrimWriteEnabled) === enabled) return;
      if(!enabled && rolling(state) && state.automationTrimCoalesce === "on-exit") {
        state.showToast("Stop playback before exiting Trim with on-exit coalescing.","info"); return;
      }
      get().endAutomationWriteSession();
      const before = captureAutomationProjectSnapshot(get());
      if (!enabled && get().automationTrimCoalesce === "on-exit" && !rolling(get())) {
        for (const lane of owner(get(),id)!.automationLanes.filter(lane => lane.param === "trim_volume" || parseSendAutomationParamId(lane.param)?.control === "trim"))
          get().freezeAutomationTrim(id,lane.param,{undoable:false,disarm:false});
      }
      const trim: AutomationLane = target.automationLanes.find(lane => lane.param === "trim_volume") ?? {
        id: crypto.randomUUID(), param: "trim_volume", label: "Trim Volume", points: [], visible: true, readEnabled: true, mode: "read", armed: false,
      };
      const current=owner(get(),id)!;
      const lanes = current.automationLanes.some(lane => lane.param === "trim_volume") ? [...current.automationLanes] : [...current.automationLanes, trim];
      for(const send of get().tracks.find(track => track.id === id)?.sends ?? []) {
        const param=sendAutomationParamId(send.destTrackId,"trim");
        if(!lanes.some(lane => lane.param === param))lanes.push({...trim,id:crypto.randomUUID(),param,label:"Send Trim"});
      }
      set(current => id === "master" ? { masterAutomationTrimWriteEnabled: enabled, masterAutomationReadEnabled: true,
        masterAutomationEnabled: true, showMasterAutomation: true, masterAutomationLanes: lanes, isModified: true }
        : { tracks: current.tracks.map(track => track.id === id ? { ...track, automationTrimWriteEnabled: enabled,
          automationReadEnabled: true, automationEnabled: true, showAutomation: true, automationLanes: lanes } : track), isModified: true });
      syncModes(id);
      pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "ARM_AUTOMATION_TRIM", enabled ? "Arm Trim automation" : "Disarm Trim automation");
    },
    beginAutomationTrimEdit: begin,
    setAutomationTrimValue: (id: string, value: number, param = "trim_volume") => {
      if (!Number.isFinite(value) || isAutomationEditLocked(get()) || get().isProjectLoading || get().automationPreviewSession || !owner(get(), id)) return;
      const oneShot = !edits.has(key(id,param)); if (oneShot) begin(id,param);
      const edit = edits.get(key(id,param)), db = normalizeTrimDB(value);
      if (!edit || edit.epoch !== getProjectEpoch()) return;
      if (edit.writing && rolling(get())) {
        set(state => ({ automationTrimLiveValues: { ...state.automationTrimLiveValues, [key(id,param)]: db } }));
        get().setAutomationWriteValue(id, param, (db - VOLUME_MIN_DB) / VOLUME_DB_RANGE);
        get().recordAutomationWriteTick(undefined, { trackId: id, param, time: get().transport.currentTime });
        void nativeManual(id, db, param);
      } else if (!edit.writing) applyManual(id, db, param);
      if (oneShot) commit(id,param);
    },
    commitAutomationTrimEdit: commit,
    restoreAutomationTrimLiveValues: () => {
      const state = get();
      for (const entry of Object.keys(state.automationTrimLiveValues ?? {})) {
        const [id,param="trim_volume"]=entry.split("\n"); void nativeManual(id,manual(id,param),param);
      }
      edits.clear(); set({ automationTrimLiveValues: {} });
    },
    freezeAutomationTrim: (id: string, param = "trim_volume", options: {undoable?: boolean; disarm?: boolean} = {}): boolean => {
      const state = get(), target = owner(state, id);
      const previewBlocks=state.automationPreviewSession && !(options.undoable === false && state.automationPreviewSession.phase === "restoring");
      if (!target || isAutomationEditLocked(state) || state.isProjectLoading || previewBlocks || rolling(state)) return false;
      const send=parseSendAutomationParamId(param);
      if(param !== "trim_volume" && (!send || send.control !== "trim" || !sendFor(id,param)))return false;
      const baseParam=send ? sendAutomationParamId(send.destinationId,"level") : "volume";
      const safe=id === "master" ? state.masterAutomationSafeParams : state.tracks.find(track => track.id === id)?.automationSafeParams;
      if(safe?.includes(baseParam) || safe?.includes(param))return false;
      const volume = target.automationLanes.find(lane => lane.param === baseParam), trim = target.automationLanes.find(lane => lane.param === param);
      if (!target.automationReadEnabled || !volume?.readEnabled || (trim?.points.length && !trim.readEnabled)) {
        state.showToast("Enable Read on the volume and Trim envelopes before freezing.", "error"); return false;
      }
      if (!(trim?.points.length || manual(id,param))) return false;
      let points;
      try { points = (send ? freezeSendTrimEnvelope : freezeTrimEnvelope)(volume.points, trim?.points ?? [], manual(id,param)); }
      catch (error) { state.showToast((error as Error).message, "error"); return false; }
      if(options.undoable !== false)get().endAutomationWriteSession();
      const before = captureAutomationProjectSnapshot(get());
      const lanes = owner(get(),id)!.automationLanes.map(lane => lane.param === baseParam ? { ...lane, points } : lane.param === param ? { ...lane, points: [] } : lane);
      const disarm=options.disarm !== false;
      if(send) {
        set(current => ({tracks:current.tracks.map(track => track.id === id ? {...track,automationLanes:lanes,
          sends:track.sends.map(item => item.destTrackId === send.destinationId ? {...item,trimDB:0}:item),
          automationTrimWriteEnabled:disarm ? false : track.automationTrimWriteEnabled}:track),isModified:true}));
      } else {
      set(current => id === "master" ? { masterAutomationLanes: lanes, masterTrimVolumeDB: 0, masterAutomationTrimWriteEnabled: disarm ? false : current.masterAutomationTrimWriteEnabled, isModified: true }
        : { tracks: current.tracks.map(track => track.id === id ? { ...track, automationLanes: lanes, trimVolumeDB: 0, automationTrimWriteEnabled: disarm ? false : track.automationTrimWriteEnabled } : track), isModified: true });
      }
      syncModes(id); void nativeManual(id,0,param);
      if(options.undoable === false)return true;
      return pushAppliedAutomationProjectCommand(set, get, before, captureAutomationProjectSnapshot(get()), "FREEZE_AUTOMATION_TRIM", "Freeze Trim into level automation");
    },
  };
}
