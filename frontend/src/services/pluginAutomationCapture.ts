import { automationParameterMetadata } from "../store/automationParams";
import { compatibleAutomationMetadata } from "../utils/automationRecovery";
import type { PluginParameterInfo } from "./NativeBridge";
import { nativeBridge } from "./NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { _autoRecordTimers, _automationTouchedParams, automationTouchKey, syncAutomationLaneToBackend } from "../store/actions/storeHelpers";
import { getProjectEpoch } from "../utils/projectLifetime";
import { notifyFXChainChanged, notifyInstrumentChanged } from "../utils/fxChain";
import { automationPunchedParameters, automationWriteKey } from "../utils/automationWriteOwnership";

export interface PluginParameterEdit {
  trackId: string;
  param: string;
  phase: "begin" | "value" | "end" | "metadata" | "references-cleared" | "overflow" | "playback-overflow" | "editor-flush-failed";
  capturedTime?: number;
  initialValue?: number;
  metadata?: PluginParameterInfo;
  capturedWhileRolling?: boolean;
  timing?: "sample" | "block" | "estimated";
  captureSequence?: number;
  transportEpoch?: number;
  transportFlush?: boolean;
  droppedEvents?: number;
  deferSync?: boolean;
  chain?: "input" | "track" | "instrument" | "master" | "monitor";
  index?: number;
  automationPrefix?: string;
  value?: number;
  name?: string;
}

// Runs only in the main project WebView. Detached editors send native events
// here instead of writing into their independent copy of the Zustand store.
export function startPluginAutomationCapture() {
  const touched = new Map<string, PluginParameterEdit>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let active = true;
  const metadataRequests = new Map<string, number>();
  let lastOverflowWarning = -Infinity;
  const refresh = async (event: PluginParameterEdit) => {
    const epoch = getProjectEpoch(), chain = event.chain, index = event.index;
    if (!chain || !Number.isInteger(index)) return;
    const key = `${event.trackId}:${chain}:${index}`, request = (metadataRequests.get(key) ?? 0) + 1;
    metadataRequests.set(key, request);
    const stage = chain === "master" || chain === "monitor";
    const slots = stage ? chain === "monitor" ? await nativeBridge.getMonitoringFX() : await nativeBridge.getMasterFX()
      : chain === "instrument" ? [] : chain === "input" ? await nativeBridge.getTrackInputFX(event.trackId) : await nativeBridge.getTrackFX(event.trackId);
    const slot = slots[index!];
    const parameters = await nativeBridge.getPluginParameters(stage ? chain : event.trackId, index!, chain === "input");
    if (slot?.instanceId) {
      const latest = stage ? chain === "monitor" ? await nativeBridge.getMonitoringFX() : await nativeBridge.getMasterFX()
        : chain === "input" ? await nativeBridge.getTrackInputFX(event.trackId) : await nativeBridge.getTrackFX(event.trackId);
      if (latest[index!]?.instanceId !== slot.instanceId) return;
    }
    if (!active || epoch !== getProjectEpoch() || request !== metadataRequests.get(key) || useDAWStore.getState().isProjectLoading) return;
    const prefix = stage ? event.automationPrefix : `plugin_${chain}_${chain === "instrument" ? 0 : index}_`;
    if (!prefix) return;
    useDAWStore.getState().refreshPluginAutomationParameters(event.trackId, prefix, parameters, slot?.pluginPath ?? "");
    const current = useDAWStore.getState();
    const lanes = event.trackId === "master" ? current.masterAutomationLanes : current.tracks.find(track => track.id === event.trackId)?.automationLanes ?? [];
    for (const [touchKey, touch] of touched) if (touch.trackId === event.trackId && touch.param.startsWith(prefix)
      && !lanes.some(lane => lane.param === touch.param && !lane.unavailableParameter)) {
      clearTimeout(timers.get(touchKey)); timers.delete(touchKey); touched.delete(touchKey);
    }
    if (chain === "instrument") notifyInstrumentChanged({ trackId: event.trackId });
    else notifyFXChainChanged({ trackId: event.trackId, chainType: chain });
  };
  const finish = (event: PluginParameterEdit) => {
    const key = `${event.trackId}:${event.param}`;
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (touched.delete(key)) useDAWStore.getState().endAutomationParamTouch(event.trackId, event.param,
      event.phase === "end" && Number.isFinite(event.capturedTime) ? { time: event.capturedTime!, allowStopped: event.transportFlush && event.capturedWhileRolling } : undefined);
  };
  const handle = (event: PluginParameterEdit) => {
    const state = useDAWStore.getState();
    if (state.isProjectLoading || !event) return;
    if (event.phase === "editor-flush-failed") {
      state.showToast("Audio stopped, but an editor could not finish sending its automation edits. Check the final envelope value before saving.", "error");
      return;
    }
    if (event.phase === "overflow" || event.phase === "playback-overflow") {
      if (Date.now() - lastOverflowWarning > 5000) {
        state.showToast(event.phase === "playback-overflow" ? "Automation playback exceeded the plugin event budget. Reduce the number of simultaneously automated controls or use a smaller audio buffer." : "Automation capture overflowed. Some rapid edits could not be retained; the latest values were recovered.", "error");
        lastOverflowWarning = Date.now();
      }
      return;
    }
    if (event.phase === "metadata") { void refresh(event).catch(error => console.warn("Parameter refresh failed", error)); return; }
    if (event.phase === "references-cleared") {
      useDAWStore.setState({ isModified: true });
      const key = `${event.trackId}:${event.param}`;
      clearTimeout(timers.get(key)); timers.delete(key); touched.delete(key);
      state.retirePluginAutomationReferences(event.trackId, event.param);
      return;
    }
    if (!["begin", "value", "end"].includes(event.phase)) return;
    const track = state.tracks.find(candidate => candidate.id === event.trackId);
    const master = event.trackId === "master";
    if (state.automationPreviewSession?.trackId === event.trackId && state.automationPreviewSession.phase === "active"
      && state.automationPreviewSession.values[event.param]) {
      if (event.phase === "value" && Number.isFinite(event.value)) void state.setAutomationPreviewValue(event.trackId, event.param, event.value!);
      return;
    }
    if (event.trackId && !track && !master) return;
    if (event.phase === "value") {
      state.setModified(true);
      if (event.param) useDAWStore.setState({ lastTouchedAutomationParameter: {
        trackId: event.trackId, param: event.param, name: event.name, value: event.value,
      } });
    }
    if ((!track && !master) || !event.param) return;
    if ((master ? state.masterAutomationSafeParams : track!.automationSafeParams)?.includes(event.param)) return;
    const key = `${event.trackId}:${event.param}`;
    if (event.phase === "end") { finish(event); return; }
    const punched = automationPunchedParameters.has(automationWriteKey(event.trackId, event.param));
    if (!punched && (master ? state.masterAutomationTrimWriteEnabled : track!.automationTrimWriteEnabled)) return;
    if (!(punched || (master ? state.masterAutomationWriteEnabled : track!.automationWriteEnabled))
      || (!state.transport.isPlaying && !state.transport.isRecording && !(event.transportFlush && event.capturedWhileRolling))) return;
    if (event.capturedWhileRolling === false) return;
    if (!Number.isFinite(event.value)) return;
    const lane = master ? state.masterAutomationLanes.find(item => item.param === event.param)
      : track!.automationLanes.find(item => item.param === event.param);
    const metadata = event.metadata ? automationParameterMetadata(event.metadata) : undefined;
    if (lane && metadata && !compatibleAutomationMetadata(lane.metadata, metadata)) return;
    // Punch owns only auditioned parameters. Native/detached editors must update
    // the displayed held value without echoing another setter back to the editor.
    const preview = state.automationPreviewSession;
    const entry = preview?.values[event.param];
    if (punched && preview?.trackId === event.trackId && preview.phase === "writing" && entry && event.phase === "value") {
      useDAWStore.setState({ automationPreviewSession: {
        ...preview, values: { ...preview.values, [event.param]: { ...entry, value: event.value!, revision: entry.revision + 1 } },
      } });
    }
    if (!lane) {
      if (master) state.addMasterAutomationLane(event.param, event.name, metadata);
      else state.addAutomationLane(event.trackId, event.param, event.name, metadata);
    }
    // Generic FX sliders already own their frontend begin/end gesture. Their
    // native setter echoes a value notification; its inactivity fallback must
    // not release a pointer that the frontend is still holding.
    const externallyTouched = !touched.has(key)
      && _automationTouchedParams.has(automationTouchKey(event.trackId, event.param));
    if (!_automationTouchedParams.has(automationTouchKey(event.trackId, event.param)) && (!touched.has(key) || event.phase === "begin")) {
      state.beginAutomationParamTouch(event.trackId, event.param, { time: Number.isFinite(event.capturedTime) ? event.capturedTime! : state.transport.currentTime, allowStopped: event.transportFlush && event.capturedWhileRolling, initialValue: event.initialValue ?? (event.phase === "begin" ? event.value : undefined) });
    }
    if (event.phase === "begin" && !externallyTouched) {
      clearTimeout(timers.get(key));
      timers.delete(key);
      touched.set(key, event);
    }
    const capture = Number.isFinite(event.capturedTime)
      ? { time: event.capturedTime!, allowStopped: event.transportFlush && event.capturedWhileRolling, deferSync: event.deferSync } : undefined;
    state.setAutomationWriteValue(event.trackId, event.param, event.value!, capture);
    // Capture brief toggles even if begin/value/end arrive between writer ticks.
    if (event.phase === "value") {
      _autoRecordTimers.delete(automationTouchKey(event.trackId, event.param));
      state.recordAutomationWriteTick(undefined, capture ? { ...capture, trackId: event.trackId, param: event.param } : undefined);
    }
    if (externallyTouched) return;
    if (!touched.has(key)) {
      touched.set(key, event);
      if (!Number.isFinite(event.capturedTime)) timers.set(key, setTimeout(() => finish(event), 180));
    } else if (timers.has(key)) {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => finish(event), 180));
    }
  };
  const unsubscribe = nativeBridge.subscribe("pluginParameterEdit", handle);
  const unsubscribeBatch = nativeBridge.subscribe("pluginParameterEditBatch", (events: PluginParameterEdit[]) => {
    if (!Array.isArray(events)) return;
    const changed = new Map<string, PluginParameterEdit>();
    for (const event of events) {
      const before = useDAWStore.getState();
      const previous = event.trackId === "master" ? before.masterAutomationLanes.find(item => item.param === event.param)?.points
        : before.tracks.find(track => track.id === event.trackId)?.automationLanes.find(item => item.param === event.param)?.points;
      handle({ ...event, deferSync: true });
      const after = useDAWStore.getState();
      const next = event.trackId === "master" ? after.masterAutomationLanes.find(item => item.param === event.param)?.points
        : after.tracks.find(track => track.id === event.trackId)?.automationLanes.find(item => item.param === event.param)?.points;
      if (event.phase === "value" && event.param && previous !== next) changed.set(`${event.trackId}:${event.param}`, event);
    }
    const state = useDAWStore.getState();
    for (const event of changed.values()) {
      const lane = event.trackId === "master" ? state.masterAutomationLanes.find(item => item.param === event.param)
        : state.tracks.find(track => track.id === event.trackId)?.automationLanes.find(item => item.param === event.param);
      if (lane) syncAutomationLaneToBackend(event.trackId, lane);
    }
  });
  return () => {
    active = false;
    unsubscribe();
    unsubscribeBatch();
    for (const timer of timers.values()) clearTimeout(timer);
    for (const event of [...touched.values()]) finish(event);
  };
}
