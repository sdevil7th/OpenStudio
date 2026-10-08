import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { expandedBuiltInParamId } from "./builtInExpandedSelectors";
import { applyEQBandValues, readEQBand, parseEQBandClipboard, type EQBandValues } from "./eqBandClipboard";

export type EQGroupAction = "offset" | "flip" | "enable" | "bypass" | "reset" | "gainScale" | "qScale";
export function eqBandGroupChanges(schema: BuiltInPluginSchema, bands: number[], action: EQGroupAction, semitones = 0, gainOffset = 0, factor = 1): Record<string, number> {
  if (!bands.length) throw new Error("Select at least one band.");
  if (action === "offset" && (!Number.isFinite(semitones) || !Number.isFinite(gainOffset) || Math.abs(semitones) > 48 || Math.abs(gainOffset) > 30)) throw new Error("Use -48 to 48 semitones and -30 to 30 dB.");
  if ((action === "gainScale" || action === "qScale") && (!Number.isFinite(factor) || factor < (action === "qScale" ? .125 : 0) || factor > (action === "qScale" ? 8 : 2))) throw new Error(action === "qScale" ? "Use a Q multiplier from 0.125 to 8." : "Use a gain multiplier from 0 to 2.");
  const changes: Record<string, number> = {};
  for (const band of new Set(bands)) {
    const values = readEQBand(schema, band);
    if (!Number.isInteger(band) || values.freq === undefined) throw new Error("A selected band is unavailable. Reopen Group bands.");
    const hasGain = ((values.type ?? 0) <= 2 || (values.type ?? 0) >= 8) && values.allPass !== 1;
    const cut = values.allPass !== 1 && (values.type === 3 || values.type === 4);
    const qActive = values.type !== 9 && (!cut || ((values.slope ?? 0) !== 0 && !((schema.parameters.find(p => p.id === "phaseMode")?.value ?? 0) >= .5 && (values.cutMode ?? 0) > 0)));
    const next = action === "reset" ? readEQBand(schema, band, true)
      : action === "enable" || action === "bypass" ? { enabled: action === "enable" ? 1 : 0 }
      : action === "gainScale" ? hasGain ? { gain: (values.gain ?? 0) * factor, dynamicRange: (values.dynamicRange ?? 0) * factor } : {}
      : action === "qScale" ? qActive ? { q: (values.q ?? 1) * factor } : {}
      : action === "flip" ? hasGain ? { gain: -(values.gain ?? 0), dynamicRange: -(values.dynamicRange ?? 0) } : {}
      : { freq: values.freq * 2 ** (semitones / 12), ...(hasGain ? { gain: (values.gain ?? 0) + gainOffset } : {}) };
    // Reject the whole proposal at a bound so relative spacing/offsets survive.
    for (const [field, value] of Object.entries(next)) {
      const id = expandedBuiltInParamId(schema, `band${band}.${field}`), parameter = schema.parameters.find(p => p.id === id);
      if (parameter && (value < parameter.min || value > parameter.max)) throw new Error(`Band ${band + 1}: ${parameter.label} would exceed its range. Use a smaller offset.`);
    }
    Object.assign(changes, applyEQBandValues(schema, band, next));
  }
  if (action === "bypass" || action === "reset") {
    for (const id of [expandedBuiltInParamId(schema, "auditionBand"), "detectorListenBand"])
      if (bands.includes((schema.parameters.find(p => p.id === id)?.value ?? 0) - 1)) changes[id] = 0;
  }
  return changes;
}

export const EQ_GROUP_CLIPBOARD_KEY = "openstudio.eqGroupClipboard.v1";
export function parseEQGroupClipboard(text: string | null): EQBandValues[] | null {
  if (!text || text.length > 65536) return null;
  try {
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.bands) || !data.bands.length || data.bands.length > 24) return null;
    const bands = data.bands.map((values: unknown) => parseEQBandClipboard(JSON.stringify({ version: 1, values })));
    return bands.every((band: EQBandValues | null) => band !== null) ? bands : null;
  } catch { return null; }
}
export function pasteEQBandGroup(schema: BuiltInPluginSchema, copied: EQBandValues[], excluded: number[]) {
  const available = schema.parameters.filter(p => /^band\d+\.enabled$/.test(p.id) && p.value < .5)
    .map(p => Number(p.id.slice(4, p.id.indexOf("."))))
    .filter(band => { const values = readEQBand(schema, band); return !excluded.includes(band) && values.type !== 3 && values.type !== 4; });
  if (available.length < copied.length) throw new Error(`Need ${copied.length} unused non-cut bands outside the selection; only ${available.length} available.`);
  const bands = available.slice(0, copied.length), changes: Record<string, number> = {};
  copied.forEach((values, index) => Object.assign(changes, applyEQBandValues(schema, bands[index], { ...readEQBand(schema, bands[index], true), ...values, enabled: 1 })));
  return { bands, changes };
}
