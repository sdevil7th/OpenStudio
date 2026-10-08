import type { BuiltInPluginSchema } from "../../services/NativeBridge";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { formatParamValue } from "../../utils/builtInParamValue";

/** Compare individual native defaults; opposite edits must not cancel each other. */
export function changedEffectSettings(schema: BuiltInPluginSchema, ids: string[]): string {
  const seen = new Set<string>();
  return ids.flatMap(id => {
    const p = findBuiltInParameter(schema, id);
    if (!p || seen.has(p.id) || !Number.isFinite(p.value) || !Number.isFinite(p.defaultValue)
      || Math.abs(p.value - p.defaultValue) <= 1e-5) return [];
    seen.add(p.id);
    const percent = p.type === "continuous" && p.min === 0 && p.max > 0 && p.max <= 1 && !p.unit;
    return [`${p.label}: ${percent ? `${Number((p.value * 100).toFixed(1))}%` : formatParamValue(p)}`];
  }).join("; ");
}

export const detailDescription = (label: string, summary: string) => summary ? `${label}: ${summary}` : label;

/** The parent exposes the complete summary through title and aria-description. */
export function EffectDetailIndicator({ summary }: { summary: string }) {
  return summary ? <span aria-hidden="true" className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--suite-accent)] align-middle" /> : null;
}
