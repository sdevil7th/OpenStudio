import type { StoreApi } from "zustand";
import type { AutomationLane, AutomationPreviewSession, DAWState, DAWActions } from "../useDAWStore";
import { nativeBridge } from "../../services/NativeBridge";
import { getProjectEpoch } from "../../utils/projectLifetime";
import { automationLaneIsDiscrete, automationToBackend, getAutomationDefault, quantizeAutomationLaneValue } from "../automationParams";
import { editEnvelopeRange, envelopeValue } from "../../utils/automationEnvelopeEdits";
import { captureAutomationProjectSnapshot, isAutomationEditLocked, pushAppliedAutomationProjectCommand, applyAutomationProjectSnapshot } from "./automation";
import { automationPunchedParameters, automationWriteKey } from "../../utils/automationWriteOwnership";

type State = DAWState & DAWActions;
type Set = StoreApi<State>["setState"];
const owner = (state: State, id: string) => id === "master" ? {
  automationLanes: state.masterAutomationLanes, automationWriteEnabled: state.masterAutomationWriteEnabled,
  automationTrimWriteEnabled: state.masterAutomationTrimWriteEnabled, automationSafeParams: state.masterAutomationSafeParams,
  automationReadEnabled: state.masterAutomationReadEnabled,
} : state.tracks.find(track => track.id === id);
export function automationPreviewAllowed(state: State, id: string, lane: AutomationLane): boolean {
  const target = owner(state, id);
  return Boolean(target && !isAutomationEditLocked(state) && !state.isProjectLoading && !state.automationRecoveryBusy && !nativeBridge.hasAutomationSnapshotRequest()
    && !state.transport.isRecording && !target.automationWriteEnabled && !target.automationTrimWriteEnabled
    && !state.automationJoinSession?.prepared && !state.automationJoinSession?.preparing
    && !target.automationSafeParams?.includes(lane.param) && !lane.unavailableParameter && !lane.param.startsWith("midi_"));
}

export function automationPreviewActions(set: Set, get: () => State) {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(task: () => Promise<T>) => { const next = queue.then(task, task); queue = next.catch(() => undefined); return next; };
  const laneFor = (id: string, laneId: string) => owner(get(), id)?.automationLanes.find(lane => lane.id === laneId);
  const sameSession = (id: string) => get().automationPreviewSession?.id === id && get().automationPreviewSession?.phase === "active" && get().automationPreviewSession?.projectEpoch === getProjectEpoch();
  const cancel = async (): Promise<boolean> => {
    const session = get().automationPreviewSession;
    if (!session) {
      if(automationPunchedParameters.size || get().automationJoinSession?.prepared || get().automationJoinSession?.preparing) {
        get().endAutomationWriteSession();
        try {return await enqueue(()=>nativeBridge.clearAutomationPreviews());}catch {return false;}
      }
      return true;
    }
    set({ automationPreviewSession: { ...session, phase: "restoring" } });
    if(session.phase === "writing")get().endAutomationWriteSession();
    let success = false;
    try { success = await enqueue(() => nativeBridge.clearAutomationPreviews()); }
    catch { /* Keep the session visible and allow restoration to be retried. */ }
    if (get().automationPreviewSession?.id === session.id) {
      if (success) set({ automationPreviewSession: null });
      else { set({ automationPreviewSession: { ...session, phase: "restoring" } }); get().showToast("Preview values could not be restored. Retry Cancel Preview before saving or rendering.", "error"); }
    }
    return success;
  };
  return {
    beginAutomationPreview: async (id: string, laneId: string): Promise<boolean> => {
      const state = get(), lane = laneFor(id, laneId);
      if (!lane || !automationPreviewAllowed(state, id, lane)) return false;
      let session: AutomationPreviewSession | null | undefined = state.automationPreviewSession;
      if (session && (session.trackId !== id || session.phase !== "active")) { state.showToast("Cancel the current Preview before auditioning another track.", "info"); return false; }
      if (session?.values[lane.param]) return true;
      if (session && Object.keys(session.values).length >= 64) return false;
      session ??= { id: crypto.randomUUID(), trackId: id, projectEpoch: getProjectEpoch(), phase: "active", values: {} };
      const fallback = lane.points.length && owner(state, id)?.automationReadEnabled && lane.readEnabled
        ? envelopeValue(lane.points, state.transport.currentTime, automationLaneIsDiscrete(lane)) : lane.metadata?.initialNormalized ?? getAutomationDefault(lane.param);
      const entry = { laneId, param: lane.param, label: lane.label || lane.metadata?.name || lane.param,
        value: fallback, originalValue: fallback, revision: 0, pending: true, beforePoints: JSON.stringify(lane.points), metadataKey: JSON.stringify(lane.metadata ?? null) };
      const sessionId = session.id;
      set({ automationPreviewSession: { ...session, values: { ...session.values, [lane.param]: entry } } });
      let success = false;
      try { success = await enqueue(async () => {
        const actual = await nativeBridge.getAutomationCurrentValue(id, lane.param);
        const currentLane = laneFor(id, laneId);
        if (!sameSession(sessionId) || actual === null || !currentLane || !automationPreviewAllowed(get(), id, currentLane)
          || JSON.stringify(currentLane.points) !== entry.beforePoints || JSON.stringify(currentLane.metadata ?? null) !== entry.metadataKey) return false;
        const minimum = automationToBackend(lane.param, 0), range = automationToBackend(lane.param, 1) - minimum;
        const value = quantizeAutomationLaneValue(lane, actual === undefined ? fallback : (actual - minimum) / range);
        if (!await nativeBridge.setAutomationPreview(id, lane.param, automationToBackend(lane.param, value), lane.metadata?.meaningSignature ?? "", lane.metadata?.referenceGeneration ?? -1)) return false;
        if (!sameSession(sessionId)) return false;
        const current = get().automationPreviewSession!;
        set({ automationPreviewSession: { ...current, values: { ...current.values, [lane.param]: { ...entry, value, originalValue: value, pending: false } } } });
        return true;
      }); } catch { success = false; }
      if (!success && get().automationPreviewSession?.id === sessionId) { await cancel(); get().showToast("This parameter could not enter Preview. Its envelope was preserved.", "error"); }
      return success;
    },
    setAutomationPreviewValue: async (id: string, param: string, normalized: number): Promise<boolean> => {
      const session = get().automationPreviewSession, entry = session?.values[param], lane = entry ? laneFor(id, entry.laneId) : undefined;
      if (!session || session.trackId !== id || !["active","writing"].includes(session.phase) || !entry || entry.pending || !lane || lane.param !== param || !Number.isFinite(normalized) || !automationPreviewAllowed(get(), id, lane)) return false;
      const value = quantizeAutomationLaneValue(lane, normalized), revision = entry.revision + 1;
      set({ automationPreviewSession: { ...session, values: { ...session.values, [param]: { ...entry, value, revision } } } });
      let success = false;
      try { success = await enqueue(async () => {
        const latest = get().automationPreviewSession?.values[param];
        if (get().automationPreviewSession?.id !== session.id || !["active","writing"].includes(get().automationPreviewSession?.phase ?? "") || !latest || latest.revision !== revision) return true; // Coalesce pending slider changes.
        return await nativeBridge.setAutomationPreview(id, param, automationToBackend(param, value), lane.metadata?.meaningSignature ?? "", lane.metadata?.referenceGeneration ?? -1);
      }); } catch { success = false; }
      if (!success && get().automationPreviewSession?.id === session.id) { await cancel(); get().showToast("Preview could not update this parameter.", "error"); }
      if(success && session.phase === "writing" && get().automationPreviewSession?.id === session.id && get().transport.isPlaying) {
        get().setAutomationWriteValue(id,param,value);
        get().recordAutomationWriteTick(undefined,{trackId:id,param,time:get().transport.currentTime});
      }
      return success;
    },
    captureAutomationPreview: async (): Promise<boolean> => {
      await queue;
      const session = get().automationPreviewSession;
      if (!session || !sameSession(session.id) || Object.values(session.values).some(value => value.pending)) return false;
      set({ automationCapturedPreview: structuredClone(session) }); return true;
    },
    cancelAutomationPreview: cancel,
    discardAutomationPreviewCapture: () => set({ automationCapturedPreview: null }),
    punchAutomationPreview: async (): Promise<boolean> => {
      await queue;
      const state=get(), session=state.automationPreviewSession;
      if(!session || !sameSession(session.id) || !state.transport.isPlaying || state.transport.isRecording || Object.values(session.values).some(value => value.pending))return false;
      const entries=Object.values(session.values);
      if(!entries.length || !owner(state,session.trackId)?.automationReadEnabled || entries.some(entry => {
        const lane=laneFor(session.trackId,entry.laneId);
        return !lane || lane.param !== entry.param || !lane.readEnabled || !automationPreviewAllowed(state,session.trackId,lane)
          || JSON.stringify(lane.points) !== entry.beforePoints || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey;
      })) { state.showToast("Enable Read on the auditioned envelopes before Punch.","info");return false; }
      set({automationPreviewSession:{...session,phase:"punching"}});
      let time:number|null|undefined=null;
      try { time=await enqueue(()=>nativeBridge.punchAutomationPreviews(session.trackId)); }catch { /* Restore below. */ }
      if(time === null || getProjectEpoch() !== session.projectEpoch || get().automationPreviewSession?.id !== session.id
        || get().automationPreviewSession?.phase !== "punching" || !get().transport.isPlaying
        || entries.some(entry => {const lane=laneFor(session.trackId,entry.laneId);return !lane || lane.param !== entry.param || !automationPreviewAllowed(get(),session.trackId,lane)
          || !lane.readEnabled || JSON.stringify(lane.points) !== entry.beforePoints || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey;})) {
        await cancel();return false;
      }
      time ??= get().transport.currentTime;
      for(const entry of entries)automationPunchedParameters.add(automationWriteKey(session.trackId,entry.param));
      set({automationPreviewSession:{...session,phase:"writing"}});
      for(const entry of entries) {
        get().beginAutomationParamTouch(session.trackId,entry.param,{time,initialValue:entry.originalValue});
        get().setAutomationWriteValue(session.trackId,entry.param,entry.value);
        get().recordAutomationWriteTick(undefined,{trackId:session.trackId,param:entry.param,time});
        get().endAutomationParamTouch(session.trackId,entry.param,{time});
      }
      return true;
    },
    commitAutomationPreview: async (): Promise<boolean> => {
      const captured = get().automationCapturedPreview, selection = get().timeSelection;
      if (!captured || captured.projectEpoch !== getProjectEpoch() || !selection || selection.start < 0 || selection.end <= selection.start
        || get().transport.isPlaying || get().transport.isRecording) return false;
      const entries = Object.values(captured.values), lanes = entries.map(entry => laneFor(captured.trackId, entry.laneId));
      if (!entries.length || entries.some((entry, index) => !lanes[index] || lanes[index]!.param !== entry.param || !automationPreviewAllowed(get(), captured.trackId, lanes[index]!)
        || JSON.stringify(lanes[index]!.points) !== entry.beforePoints || JSON.stringify(lanes[index]!.metadata ?? null) !== entry.metadataKey)) {
        get().showToast("A captured envelope changed or became unavailable. Capture the values again.", "error"); return false;
      }
      if (!await cancel() || captured.projectEpoch !== getProjectEpoch() || get().transport.isPlaying || get().transport.isRecording) return false;
      // Recheck after native restoration; another edit may have completed while it was pending.
      if (entries.some(entry => { const lane = laneFor(captured.trackId, entry.laneId); return !lane || lane.param !== entry.param || !automationPreviewAllowed(get(), captured.trackId, lane) || JSON.stringify(lane.points) !== entry.beforePoints || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey; })) return false;
      const before = captureAutomationProjectSnapshot(get());
      const changes = new Map(entries.map(entry => { const lane = laneFor(captured.trackId, entry.laneId)!; return [lane.id,
        editEnvelopeRange(lane.points, selection.start, selection.end, "fill", entry.value, entry.originalValue, automationLaneIsDiscrete(lane))]; }));
      const updated = owner(get(), captured.trackId)!.automationLanes.map(lane => changes.has(lane.id) ? { ...lane, points: changes.get(lane.id)!, mode: "read" as const, readEnabled: true } : lane);
      set(state => captured.trackId === "master" ? { masterAutomationLanes: updated, masterAutomationReadEnabled: true, masterAutomationEnabled: true, isModified: true }
        : { tracks: state.tracks.map(track => track.id === captured.trackId ? { ...track, automationLanes: updated, automationReadEnabled: true, automationEnabled: true } : track), isModified: true });
      const after = captureAutomationProjectSnapshot(get()); applyAutomationProjectSnapshot(set, get, after);
      pushAppliedAutomationProjectCommand(set, get, before, after, "COMMIT_AUTOMATION_PREVIEW", "Commit captured Preview to time selection");
      set({ automationCapturedPreview: null }); return true;
    },
  };
}
