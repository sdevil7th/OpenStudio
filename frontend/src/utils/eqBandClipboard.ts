import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { findBuiltInParameter, expandedBuiltInParamId } from "./builtInExpandedSelectors";

export const EQ_BAND_CLIPBOARD_KEY = "openstudio.eqBandClipboard.v1";
const fields = ["enabled", "type", "freq", "gain", "q", "slope", "target", "dynamicEnabled", "dynamicThreshold", "dynamicRange", "dynamicAttack", "dynamicRelease", "detectorSource", "detectorMode", "detectorLowCut", "detectorHighCut", "allPass", "cutMode", "continuousSlope", "dynamicThresholdMode", "dynamicTimingMode", "dynamicSensitivity", "spectralEnabled", "spectralDensity", "spectralTilt", "gainQInteraction"] as const;
export type EQBandValues = Partial<Record<typeof fields[number], number>>;

export function readEQBand(schema: BuiltInPluginSchema, band: number, defaults = false): EQBandValues {
  return Object.fromEntries(fields.flatMap(field => {
    const parameter = findBuiltInParameter(schema, `band${band}.${field}`);
    return parameter ? [[field, defaults ? parameter.defaultValue : parameter.value]] : [];
  }));
}

export function parseEQBandClipboard(text: string | null): EQBandValues | null {
  if (!text || text.length > 8192) return null;
  try {
    const data = JSON.parse(text);
    if (data?.version !== 1 || !data.values || Array.isArray(data.values) || typeof data.values !== "object") return null;
    if (Object.keys(data.values).some(field => !fields.includes(field as typeof fields[number]))) return null;
    if (Object.values(data.values).some(value => typeof value !== "number" || !Number.isFinite(value))) return null;
    if (!["enabled", "type", "freq", "gain", "q"].every(field => Object.prototype.hasOwnProperty.call(data.values, field))) return null;
    if ((data.values.freq as number) <= 0) return null;
    return data.values as EQBandValues;
  } catch { return null; }
}

export function applyEQBandValues(schema: BuiltInPluginSchema, band: number, values: EQBandValues): Record<string, number> {
  return Object.fromEntries(fields.flatMap(field => {
    const value = values[field], id = expandedBuiltInParamId(schema, `band${band}.${field}`);
    const parameter = schema.parameters.find(p => p.id === id);
    if (!parameter || value === undefined || !Number.isFinite(value)) return [];
    const bounded = Math.max(parameter.min, Math.min(parameter.max, value));
    return [[id, parameter.type === "enum" || parameter.type === "toggle" ? Math.round(bounded) : bounded]];
  }));
}

export function freeEQBand(schema: BuiltInPluginSchema, excluded = -1): number | null {
  const count = schema.parameters.filter(p => /^band\d+\.enabled$/.test(p.id)).length;
  for (let band = 0; band < count; ++band) {
    const values = readEQBand(schema, band);
    if (band !== excluded && values.enabled === 0 && values.type !== 3 && values.type !== 4) return band;
  }
  return null;
}
