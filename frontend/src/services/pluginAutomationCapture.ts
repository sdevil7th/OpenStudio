import { nativeBridge } from "./NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { _autoRecordTimers, _automationTouchedParams, automationTouchKey } from "../store/actions/storeHelpers";

export interface PluginParameterEdit {
  trackId: string;
  param: string;
  phase: "begin" | "value" | "end";
  value?: number;
  name?: string;
}

// Runs only in the main project WebView. Detached editors send native events
// here instead of writing into their independent copy of the Zustand store.
export function startPluginAutomationCapture() {
  const touched = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const finish = (event: PluginParameterEdit) => {
    const key = `${event.trackId}:${event.param}`;
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (touched.delete(key)) useDAWStore.getState().endAutomationParamTouch(event.trackId, event.param);
  };
  const unsubscribe = nativeBridge.subscribe("pluginParameterEdit", (event: PluginParameterEdit) => {
    const state = useDAWStore.getState();
    if (state.isProjectLoading || !event || !["begin", "value", "end"].includes(event.phase)) return;
    const track = state.tracks.find(candidate => candidate.id === event.trackId);
    if (event.trackId && !track) return;
    if (event.phase === "value") state.setModified(true);
    if (!track || !event.param) return;
    const key = `${event.trackId}:${event.param}`;
    if (event.phase === "end") { finish(event); return; }
    if (!track.automationWriteEnabled || (!state.transport.isPlaying && !state.transport.isRecording)) return;
    if (!Number.isFinite(event.value)) return;
    if (!_automationTouchedParams.has(automationTouchKey(track.id, event.param))) {
      state.beginAutomationParamTouch(track.id, event.param);
      if (event.phase === "begin") touched.add(key);
    }
    state.setAutomationWriteValue(track.id, event.param, event.value!);
    // Capture brief toggles even if begin/value/end arrive between writer ticks.
    if (event.phase === "value") {
      _autoRecordTimers.delete(automationTouchKey(track.id, event.param));
      state.recordAutomationWriteTick();
    }
    if (!touched.has(key)) {
      touched.add(key);
      timers.set(key, setTimeout(() => finish(event), 180));
    } else if (timers.has(key)) {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => finish(event), 180));
    }
  });
  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    touched.clear();
  };
}
