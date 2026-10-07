import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { findBuiltInParameter } from "./builtInExpandedSelectors";
import { readEQBand } from "./eqBandClipboard";

/** One shared bound per axis keeps the selected bands' relative relationships. */
export function eqBandDragChanges(schema: BuiltInPluginSchema, selected: number[], anchor: number, next: { x?: number; y?: number; z?: number }) {
  const bands = [...new Set(selected)], source = readEQBand(schema, anchor), changes: Record<string, number> = {};
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const field = (band: number, name: string) => findBuiltInParameter(schema, `band${band}.${name}`);
  for (const [axis, name, relative] of [["x", "freq", true], ["y", "gain", false], ["z", "q", true]] as const) {
    const requested = next[axis];
    if (requested === undefined || !Number.isFinite(requested)) continue;
    const usable = bands.filter(band => {
      const values = readEQBand(schema, band), type = values.allPass === 1 ? 7 : values.type ?? 0;
      if (name === "gain") return type <= 2 || type >= 8;
      if (name === "q") return type !== 9 && (!([3, 4].includes(type)) || (values.slope !== 0 && !((schema.parameters.find(p => p.id === "phaseMode")?.value ?? 0) >= .5 && (values.cutMode ?? 0) > 0)));
      return true;
    }).map(band => field(band, name)).filter(p => p !== undefined);
    const initial = source[name];
    if (initial === undefined || (relative && initial <= 0) || !usable.length) continue;
    let delta = relative ? requested / initial : requested - initial;
    const low = Math.max(...usable.map(p => relative ? p.min / p.value : p.min - p.value));
    const high = Math.min(...usable.map(p => relative ? p.max / p.value : p.max - p.value));
    delta = clamp(delta, low, high);
    for (const parameter of usable) changes[parameter.id] = clamp(relative ? parameter.value * delta : parameter.value + delta, parameter.min, parameter.max);
  }
  return changes;
}

export function eqBandParameterChanges(schema: BuiltInPluginSchema, selected: number[], id: string, value: number): Record<string, number> {
  const match = /^band(\d+)\.(.+)$/.exec(id);
  if (!match || selected.length < 2 || !selected.includes(Number(match[1]))) return { [id]: value };
  const anchor = Number(match[1]), field = match[2];
  if (field === "freq" || field === "frequencyExtended") return eqBandDragChanges(schema, selected, anchor, { x: value });
  if (field === "gain") return eqBandDragChanges(schema, selected, anchor, { y: value });
  if (field === "q") return eqBandDragChanges(schema, selected, anchor, { z: value });
  const changes: Record<string, number> = {};
  for (const band of selected) {
    const values = readEQBand(schema, band), type = values.allPass === 1 ? 7 : values.type ?? 0;
    if ((field.startsWith("dynamic") || field.startsWith("spectral") || field.startsWith("detector")) && type > 2) continue;
    if (field === "gainQInteraction" && type !== 0) continue;
    if (field === "slope" && ![1, 2, 3, 4].includes(type)) continue;
    if ((field === "cutMode" || field === "cutSlope") && ![3, 4].includes(type)) continue;
    const parameter = findBuiltInParameter(schema, `band${band}.${field}`);
    if (parameter) changes[parameter.id] = Math.max(parameter.min, Math.min(parameter.max, value));
  }
  return changes;
}
