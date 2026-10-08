import type { BuiltInPluginSchema } from "../services/NativeBridge";

// Expanded controls use appended IDs. Original normalized automation ranges stay
// fixed; both IDs address the same native stored value.
export function expandedBuiltInParamId(schema: BuiltInPluginSchema, id: string): string {
  const alias = schema.pluginId === "reverb" && (id === "algorithm" || id === "reverbType") ? (schema.parameters.some(parameter => parameter.id === "reverbTypeAll") ? "reverbTypeAll" : schema.parameters.some(parameter => parameter.id === "reverbTypeExtended") ? "reverbTypeExtended" : schema.parameters.some(parameter => parameter.id === "reverbTypeExpanded") ? "reverbTypeExpanded" : id === "algorithm" ? "reverbType" : id)
    : schema.pluginId === "reverb" && id === "plateEngine" ? "plateEngineExpanded"
    : schema.pluginId === "reverb" && id === "predelayDivision" ? "predelayDivisionExtended"
    : schema.pluginId === "compressor" && id === "fetRatio" ? "fetRatioExtended"
    : schema.pluginId === "delay" && id === "delayMode" ? "delayType"
    : schema.pluginId === "synth" && /^matrix[1-8]Target$/.test(id) && schema.parameters.some(parameter => parameter.id === `${id}Full`) ? `${id}Full`
    : schema.pluginId === "synth" && /^matrix[1-3](Source|Target)$/.test(id) ? `${id}Expanded`
    : schema.pluginId === "limiter" && id === "limitingStyle" ? "limitingStyleAll"
    : schema.pluginId === "drums" && id === "mapPreset" ? "drumMapAll"
    : schema.pluginId === "eq" && /^band\d+\.type$/.test(id) ? id.replace(".type", ".typeExpanded")
    : schema.pluginId === "eq" && /^band\d+\.freq$/.test(id) ? id.replace(".freq", ".frequencyExtended")
    : schema.pluginId === "eq" && id === "auditionBand" ? "bandAudition"
    : schema.pluginId === "eq" && /^band\d+\.dynamicRange$/.test(id) ? id.replace(".dynamicRange", ".dynamicRangeExtended")
    : schema.pluginId === "eq" && /^band[0-7]\.slope$/.test(id) ? id.replace(".slope", ".slopeMode") : id;
  return alias !== id && schema.parameters.some(parameter => parameter.id === alias) ? alias : id;
}

// Resolve the alias once, outside the descriptor scan. Resolving it inside
// find's predicate turns every lookup into a nested full-schema search.
export function findBuiltInParameter(schema: BuiltInPluginSchema, id: string) {
  const resolved = expandedBuiltInParamId(schema, id);
  return schema.parameters.find(parameter => parameter.id === resolved);
}

// Schematic views still read their established semantic keys. Actual controls
// resolve the appended descriptor above, so recording uses its new automation ID.
export function projectBuiltInSelectorView(schema: BuiltInPluginSchema): BuiltInPluginSchema {
  const parameters = new Map(schema.parameters.map(parameter => [parameter.id, parameter]));
  return { ...schema, parameters: schema.parameters.map(parameter => {
    const id = expandedBuiltInParamId(schema, parameter.id);
    return id === parameter.id ? parameter : { ...parameters.get(id)!, id: parameter.id };
  }) };
}
