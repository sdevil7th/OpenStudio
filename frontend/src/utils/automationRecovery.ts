import type { AutomationLane } from "../store/useDAWStore";
import { automationParameterMetadata, type AutomationParameterMetadata } from "../store/automationParams";
import type { PluginParameterInfo } from "../services/NativeBridge";
import { normalizeSavedMIDILearnMappings, type SavedMIDILearnMapping } from "./midiLearnRecovery";

export interface SavedSafeParameter { param: string; metadata?: AutomationParameterMetadata }
export function savedAutomationAddress(param: string) {
  const match = /^((builtin|plugin)_(input|track|instrument)_\d+_|(builtin|plugin)_(master|monitor)_[^:]+:)(.+)$/.exec(param);
  return match ? { prefix: match[1], kind: match[2] ?? match[4], chain: match[3] ?? match[5], suffix: match[6] } : undefined;
}
export function normalizeSavedSafeParameters(value: unknown): SavedSafeParameter[] {
  if (!Array.isArray(value)) return [];
  // The 8192 SDK limit is per plugin; a document can protect several plugins.
  // Never silently truncate contracts and revert the tail to numeric indices.
  if (value.length > 1_048_576) throw new Error("Saved Automation Safe controls exceed the supported document limit");
  return value.flatMap(entry => entry && typeof entry.param === "string"
    && savedAutomationAddress(entry.param) ? [{ param: entry.param,
      ...(entry.metadata && typeof entry.metadata.name === "string" ? { metadata: { ...entry.metadata, referenceGeneration: undefined } } : {}) }] : []);
}
export function resolveSavedSafeParameter(entry: SavedSafeParameter, parameters: PluginParameterInfo[]) {
  const parameter = resolveSavedPluginParameter({ param: entry.param, metadata: entry.metadata } as AutomationLane, parameters);
  return parameter && compatibleAutomationMetadata(entry.metadata, automationParameterMetadata(parameter)) ? parameter : undefined;
}

export interface UnavailableFXSlot {
  key: string;
  chain: "input" | "track";
  pluginPath: string;
  pluginType: string;
  originalIndex: number;
  state: string;
  sidechain?: string;
  safeParams?: string[];
  safeParameters?: SavedSafeParameter[];
  midiLearnMappings?: SavedMIDILearnMapping[];
}

export function unavailableFXKey(chain: "input" | "track", index: number, path: string) {
  return `${chain}:${index}:${encodeURIComponent(path)}`;
}

export function normalizeUnavailableFXSlots(value: unknown): UnavailableFXSlot[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  return value.slice(0, 128).flatMap(slot => {
    if (!slot || !["input", "track"].includes(slot.chain) || typeof slot.key !== "string" || !slot.key
      || keys.has(slot.key) || typeof slot.pluginPath !== "string" || !slot.pluginPath
      || !Number.isInteger(slot.originalIndex) || slot.originalIndex < 0 || slot.originalIndex > 128) return [];
    keys.add(slot.key);
    return [{ key: slot.key, chain: slot.chain, pluginPath: slot.pluginPath, originalIndex: slot.originalIndex,
      pluginType: typeof slot.pluginType === "string" ? slot.pluginType : "plugin",
      state: typeof slot.state === "string" ? slot.state : "", sidechain: typeof slot.sidechain === "string" ? slot.sidechain : "",
      safeParams: Array.isArray(slot.safeParams) ? slot.safeParams.filter((param: unknown): param is string => typeof param === "string") : [],
      ...(slot.safeParameters ? { safeParameters: normalizeSavedSafeParameters(slot.safeParameters) } : {}),
      ...(slot.midiLearnMappings ? { midiLearnMappings: normalizeSavedMIDILearnMappings(slot.midiLearnMappings) } : {}) }];
  });
}

export function compatibleAutomationMetadata(before: AutomationParameterMetadata | undefined, after: AutomationParameterMetadata) {
  if (!before) return true;
  if (before.meaningSignature && before.meaningSignature !== after.meaningSignature) return false;
  if (before.hostParamId && before.hostParamId !== after.hostParamId) return false;
  if (before.stepCount !== undefined && before.stepCount !== after.stepCount) return false;
  if (before.paramId && after.paramId && before.paramId !== after.paramId) return false;
  if (before.discrete !== undefined && before.discrete !== Boolean(after.discrete)) return false;
  if (before.min !== undefined && after.min !== undefined && before.min !== after.min) return false;
  if (before.max !== undefined && after.max !== undefined && before.max !== after.max) return false;
  if (before.enumOptions && after.enumOptions && JSON.stringify(before.enumOptions) !== JSON.stringify(after.enumOptions)) return false;
  return true;
}
export function resolveSavedPluginParameter(lane: AutomationLane, parameters: PluginParameterInfo[]) {
  const address = savedAutomationAddress(lane.unavailableParameter?.param ?? lane.param);
  return address && parameters.find(item => address.kind === "builtin" ? item.paramId === address.suffix
    : lane.metadata?.hostParamId ? item.hostParamId === lane.metadata.hostParamId : item.index === Number(address.suffix));
}

/** Reinsert saved missing slots into the load plan, without changing the saved document. */
export interface RecoverableFXTrack {
  inputFXPaths?: string[]; inputFXTypes?: string[]; inputFXStates?: string[];
  trackFXPaths?: string[]; trackFXTypes?: string[]; trackFXStates?: string[]; trackFXSidechains?: string[];
  automationLanes?: AutomationLane[]; automationSafeParams?: string[]; automationSafeParameters?: SavedSafeParameter[]; unavailableFX?: UnavailableFXSlot[];
}
export function prepareUnavailableFXForLoad<T extends RecoverableFXTrack>(track: T): T & RecoverableFXTrack & {
  recoveryKeys: Record<"input" | "track", Map<number, string>>;
  liveIndices: Record<"input" | "track", Map<number, number>>;
} {
  const lanes = (Array.isArray(track.automationLanes) ? track.automationLanes : []).map(lane => ({ ...lane }));
  const pendingSlots = normalizeUnavailableFXSlots(track.unavailableFX);
  for (const lane of lanes) {
    const pending = lane.unavailableParameter;
    const match = pending && /^(builtin|plugin)_(input|track)_(\d+)_(.+)$/.exec(pending.param);
    if (!pending?.pluginPath || !match || pending.fxKey || pending.parameterOnly) continue;
    const chain = match[2] as "input" | "track", index = Number(match[3]);
    const key = unavailableFXKey(chain, index, pending.pluginPath);
    if (!pendingSlots.some(slot => slot.key === key)) pendingSlots.push({ key, chain, originalIndex: index,
      pluginPath: pending.pluginPath, pluginType: match[1] === "builtin" ? "builtin" : /\.jsfx$/i.test(pending.pluginPath) ? "jsfx" : "plugin", state: "" });
    lane.unavailableParameter = { ...pending, fxKey: key };
  }
  let safe = [...(track.automationSafeParams ?? [])];
  let safeParameters = normalizeSavedSafeParameters(track.automationSafeParameters);
  for (const param of safe) {
    const metadata = lanes.find(lane => lane.param === param)?.metadata;
    if (metadata && !safeParameters.some(entry => entry.param === param)) safeParameters.push({ param, metadata });
  }
  const result = { ...track, automationLanes: lanes, automationSafeParams: safe, automationSafeParameters: safeParameters,
    unavailableFX: pendingSlots, recoveryKeys: { input: new Map<number, string>(), track: new Map<number, string>() },
    liveIndices: { input: new Map<number, number>(), track: new Map<number, number>() } };
  for (const chain of ["input", "track"] as const) {
    const slots = pendingSlots.filter(slot => slot.chain === chain && slot.pluginPath)
      .sort((a, b) => a.originalIndex - b.originalIndex);
    const paths = [...(chain === "input" ? track.inputFXPaths ?? [] : track.trackFXPaths ?? [])];
    const savedTypes = chain === "input" ? track.inputFXTypes : track.trackFXTypes;
    const savedStates = chain === "input" ? track.inputFXStates : track.trackFXStates;
    const types = paths.map((_, index) => savedTypes?.[index] ?? "");
    const states = paths.map((_, index) => savedStates?.[index] ?? "");
    const sidechains = paths.map((_, index) => track.trackFXSidechains?.[index] ?? "");
    const indices = paths.map((_, index) => index);
    for (const slot of slots) {
      const position = Math.max(0, Math.min(paths.length, Math.floor(slot.originalIndex)));
      for (const [index, key] of [...result.recoveryKeys[chain]].sort((a, b) => b[0] - a[0])) {
        if (index >= position) { result.recoveryKeys[chain].delete(index); result.recoveryKeys[chain].set(index + 1, key); }
      }
      for (let index = 0; index < indices.length; ++index) if (indices[index] >= position) ++indices[index];
      paths.splice(position, 0, slot.pluginPath);
      types.splice(position, 0, slot.pluginType);
      states.splice(position, 0, slot.state);
      if (chain === "track") sidechains.splice(position, 0, slot.sidechain ?? "");
      result.recoveryKeys[chain].set(position, slot.key);
    }
    const remap = (param: string) => {
      const match = /^(builtin|plugin)_(input|track)_(\d+)_(.+)$/.exec(param);
      return match?.[2] === chain && indices[Number(match[3])] !== undefined
        ? `${match[1]}_${chain}_${indices[Number(match[3])]}_${match[4]}` : param;
    };
    indices.forEach((planIndex, liveIndex) => result.liveIndices[chain].set(liveIndex, planIndex));
    for (const lane of lanes) {
      const pending = lane.unavailableParameter;
      if (pending?.manualRecoveryRequired) {
        const original = remap(pending.param);
        lane.param = `unavailable_references:${original}:${lane.id}`;
        lane.unavailableParameter = { ...pending, param: original };
      }
      else if (pending?.parameterOnly) lane.param = remap(pending.param);
      else if (pending?.fxKey) {
        const entry = [...result.recoveryKeys[chain]].find(([, key]) => key === pending.fxKey);
        const match = /^(builtin|plugin)_(input|track)_\d+_(.+)$/.exec(pending.param);
        if (entry && match?.[2] === chain) lane.param = `${match[1]}_${chain}_${entry[0]}_${match[3]}`;
      } else if (!pending) lane.param = remap(lane.param);
    }
    safe = safe.map(remap);
    safeParameters = safeParameters.map(entry => ({ ...entry, param: remap(entry.param) }));
    for (const slot of slots) {
      const index = [...result.recoveryKeys[chain]].find(([, key]) => key === slot.key)?.[0];
      if (index === undefined) continue;
      for (const param of slot.safeParams ?? []) {
        const match = /^(builtin|plugin)_(input|track)_\d+_(.+)$/.exec(param);
        if (match?.[2] === chain) safe.push(`${match[1]}_${chain}_${index}_${match[3]}`);
      }
      for (const entry of slot.safeParameters ?? []) {
        const match = /^(builtin|plugin)_(input|track)_\d+_(.+)$/.exec(entry.param);
        if (match?.[2] === chain) safeParameters.push({ ...entry, param: `${match[1]}_${chain}_${index}_${match[3]}` });
      }
    }
    if (chain === "input") Object.assign(result, { inputFXPaths: paths, inputFXTypes: types, inputFXStates: states });
    else Object.assign(result, { trackFXPaths: paths, trackFXTypes: types, trackFXStates: states, trackFXSidechains: sidechains });
  }
  result.automationSafeParams = [...new Set(safe)];
  result.automationSafeParameters = safeParameters;
  return result;
}

export function recoveredAutomationLabel(lane: AutomationLane) {
  return lane.label?.replace(/ \(FX unavailable\)$/, "");
}
