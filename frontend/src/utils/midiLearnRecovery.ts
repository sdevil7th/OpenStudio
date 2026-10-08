import type { MIDILearnMappingInfo, PluginParameterInfo } from "../services/NativeBridge";
import { automationParameterMetadata, type AutomationParameterMetadata } from "../store/automationParams";
import { compatibleAutomationMetadata } from "./automationRecovery";

export interface SavedMIDILearnMapping extends MIDILearnMappingInfo {
  metadata?: AutomationParameterMetadata;
}

export function normalizeSavedMIDILearnMappings(value: unknown): SavedMIDILearnMapping[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((mapping): SavedMIDILearnMapping[] => {
    if (!mapping || !Number.isInteger(mapping.ccNumber) || mapping.ccNumber < 0 || mapping.ccNumber > 127
      || typeof mapping.trackId !== "string" || !mapping.trackId || !["input", "track"].includes(mapping.chainType)
      || !Number.isInteger(mapping.pluginIndex) || mapping.pluginIndex < 0 || mapping.pluginIndex > 128
      || !Number.isInteger(mapping.paramIndex) || mapping.paramIndex < (mapping.builtIn ? -1 : 0) || mapping.paramIndex > 65535
      || (mapping.builtIn && (typeof mapping.paramId !== "string" || !mapping.paramId))) return [];
    return [{ ccNumber: mapping.ccNumber, trackId: mapping.trackId, chainType: mapping.chainType,
      pluginIndex: mapping.pluginIndex, paramIndex: mapping.paramIndex,
      ...(mapping.builtIn ? { builtIn: true, paramId: mapping.paramId } : {}),
      ...(mapping.metadata && typeof mapping.metadata.name === "string" ? { metadata: { ...mapping.metadata, referenceGeneration: undefined } } : {}) }];
  });
}

export function resolveSavedMIDILearnParameter(mapping: SavedMIDILearnMapping, parameters: PluginParameterInfo[]) {
  const parameter = parameters.find(item => mapping.builtIn ? item.paramId === mapping.paramId
    : mapping.metadata?.hostParamId ? item.hostParamId === mapping.metadata.hostParamId : item.index === mapping.paramIndex);
  return parameter && compatibleAutomationMetadata(mapping.metadata, automationParameterMetadata(parameter)) ? parameter : undefined;
}

export function savedMIDILearnMapping(mapping: MIDILearnMappingInfo, parameter: PluginParameterInfo | undefined): SavedMIDILearnMapping {
  if (!parameter) return { ...mapping };
  const { referenceGeneration: _generation, ...metadata } = automationParameterMetadata(parameter);
  return { ...mapping, metadata };
}
