import { nativeBridge, type PluginParameterInfo } from "./NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { automationParameterMetadata, builtInAutomationParamId, pluginAutomationParamId } from "../store/automationParams";
import { getProjectEpoch } from "../utils/projectLifetime";

export async function lookupAutomationParameter(trackId: string, id: string): Promise<PluginParameterInfo | undefined> {
  if (trackId === "master") {
    const chain = id.startsWith("plugin_monitor_") || id.startsWith("builtin_monitor_") ? "monitor" : "master";
    const slots = chain === "monitor" ? await nativeBridge.getMonitoringFX() : await nativeBridge.getMasterFX();
    for (const slot of slots) {
      const params = await nativeBridge.getPluginParameters(chain, slot.index, false);
      const parameter = params.find(param => param.automationId === id);
      if (parameter) return parameter;
    }
    return undefined;
  }
  const address = /^(builtin|plugin)_(input|track|instrument)_(\d+)_(.+)$/.exec(id);
  if (!address) return undefined;
  const input = address[2] === "input";
  const index = address[2] === "instrument" ? -1 : Number(address[3]);
  const params = await nativeBridge.getPluginParameters(trackId, index, input);
  return params.find(param => (param.automationId ?? (param.builtIn && param.paramId
    ? builtInAutomationParamId(input, index, param.paramId) : pluginAutomationParamId(input, index, param.index))) === id);
}

export async function showLastTouchedAutomationLane() {
  const touched = useDAWStore.getState().lastTouchedAutomationParameter;
  if (!touched) return;
  const epoch = getProjectEpoch();
  const parameter = await lookupAutomationParameter(touched.trackId, touched.param).catch(() => undefined);
  if (epoch !== getProjectEpoch()) return;
  const state = useDAWStore.getState();
  const isPlugin = touched.param.startsWith("plugin_") || touched.param.startsWith("builtin_");
  if (isPlugin && !parameter) { state.showToast("This parameter is no longer available in the FX chain.", "info"); return; }
  const metadata = parameter ? automationParameterMetadata(parameter) : undefined;
  const label = touched.name || parameter?.name;
  const laneId = touched.trackId === "master"
    ? state.addMasterAutomationLane(touched.param, label, metadata, { read: false })
    : state.addAutomationLane(touched.trackId, touched.param, label, metadata, { read: false });
  if (laneId) state.setSelectedAutomationLane(touched.trackId === "master" ? { kind: "master", laneId }
    : { kind: "track", trackId: touched.trackId, laneId });
}
