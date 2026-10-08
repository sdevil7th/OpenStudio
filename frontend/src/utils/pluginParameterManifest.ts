import type { AutomationLane } from "../store/useDAWStore";
import type { PluginParameterInfo } from "../services/NativeBridge";
import { automationParameterMetadata } from "../store/automationParams";
import { compatibleAutomationMetadata } from "./automationRecovery";
import { getProjectEpoch } from "./projectLifetime";

interface Manifest { parameters: PluginParameterInfo[]; pluginPath: string }
const manifests = new Map<string, Manifest>();
let epoch = getProjectEpoch();
function current() { if (epoch !== getProjectEpoch()) { manifests.clear(); epoch = getProjectEpoch(); } }
export function registerPluginParameterManifest(trackId: string, prefix: string, parameters: PluginParameterInfo[], pluginPath: string) {
  current(); manifests.set(`${trackId}::${prefix}`, { parameters, pluginPath });
}
export function clearPluginParameterManifests(trackId: string, chain?: string) {
  current();
  for (const key of manifests.keys()) if (key.startsWith(`${trackId}::`) && (!chain || ["plugin", "builtin"].some(kind => key.startsWith(`${trackId}::${kind}_${chain}_`)))) manifests.delete(key);
}
/** Undo may restore envelope data, but cannot restore an externally changed plugin/script. */
export function retirePluginAutomationLane(lane: AutomationLane, pluginPath = ""): AutomationLane {
  if (lane.unavailableParameter?.manualRecoveryRequired) return lane;
  const original = lane.unavailableParameter?.param ?? lane.param;
  return { ...lane, param: `unavailable_references:${original}:${lane.id}`, mode: "off", readEnabled: false, armed: false,
    label: `${lane.label?.replace(/ \(parameter unavailable\)$/, "") ?? lane.metadata?.name ?? original} (plugin cleared automation)`,
    unavailableParameter: { ...lane.unavailableParameter, param: original, pluginPath, parameterOnly: true, manualRecoveryRequired: true } };
}
export function validatePluginAutomationLane(trackId: string, lane: AutomationLane): AutomationLane {
  current();
  if (lane.unavailableParameter?.manualRecoveryRequired) return lane;
  if (lane.unavailableParameter && !lane.unavailableParameter.parameterOnly) return lane;
  const original = lane.unavailableParameter?.param ?? lane.param;
  const match = /^((?:plugin|builtin)_(?:input|track|instrument)_\d+_|(?:plugin|builtin)_(?:master|monitor)_[^:]+:)(.+)$/.exec(original);
  if (!match) return lane;
  const manifest = manifests.get(`${trackId}::${match[1]}`);
  if (!manifest) return lane;
  const builtIn = match[1].startsWith("builtin_");
  const parameter = manifest.parameters.find(item => builtIn ? item.paramId === match[2] : lane.metadata?.hostParamId
    ? item.hostParamId === lane.metadata.hostParamId : item.index === Number(match[2]));
  if (parameter && ((lane.metadata?.referenceGeneration !== undefined && parameter.referenceGeneration !== lane.metadata.referenceGeneration)
    || (lane.metadata?.referenceGeneration === undefined && (parameter.referenceGeneration ?? 0) > 0))) return retirePluginAutomationLane(lane, manifest.pluginPath);
  if (parameter && compatibleAutomationMetadata(lane.metadata, automationParameterMetadata(parameter))) {
    const metadata = automationParameterMetadata(parameter);
    if (lane.metadata?.initialNormalized !== undefined) metadata.initialNormalized = lane.metadata.initialNormalized;
    const label = lane.label?.replace(/ \(parameter unavailable\)$/, "");
    return { ...lane, param: `${match[1]}${builtIn ? parameter.paramId : parameter.index}`, unavailableParameter: undefined,
      metadata, label: !label || label === original || /^(?:plugin|builtin)_(?:input|track|instrument)_\d+_.+$/.test(label) ? parameter.name : label };
  }
  return { ...lane, param: `unavailable_parameter:${original}`, label: `${lane.label?.replace(/ \(parameter unavailable\)$/, "") ?? lane.metadata?.name ?? original} (parameter unavailable)`,
    unavailableParameter: { param: original, pluginPath: manifest.pluginPath, parameterOnly: true } };
}
