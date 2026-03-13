import type { TrackType } from "./useDAWStore";

// ============================================
// Centralized Automation Parameter Registry
// ============================================
// Single source of truth for all automation parameter metadata.
// Replaces hardcoded lists in TrackHeader, Timeline, EnvelopeManagerModal, and useDAWStore.

export interface AutomationParamDef {
  id: string;
  label: string;          // Full: "Volume", "Pan (Pre-FX)"
  shortLabel: string;     // Compact: "Vol", "Pan(Pre)"
  color: string;
  defaultNormalized: number; // Default 0-1 value (0.77 ≈ 0 dB for volume, 0.5 for pan)
  category: "base" | "pre-fx" | "tail";
  toBackend: (normalized: number) => number;
  formatNormalized: (normalized: number) => string;
  inlineFader: InlineFaderConfig | null;
}

export interface InlineFaderConfig {
  trackProperty: "volumeDB" | "pan" | "muted";
  variant: "default" | "pan" | "toggle";
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  formatValue: (v: number) => string;
}

// --- Format helpers ---

function formatVolumeDB(db: number): string {
  return db <= -60 ? "-\u221E dB" : `${db.toFixed(1)} dB`;
}

function formatPan(pan: number): string {
  const pct = Math.round(Math.abs(pan) * 100);
  if (pct === 0) return "C";
  return pan < 0 ? `L${pct}` : `R${pct}`;
}

function formatNormalizedVolume(n: number): string {
  return formatVolumeDB(n * 66 - 60);
}

function formatNormalizedPan(n: number): string {
  const pan = Math.round((n * 2 - 1) * 100);
  if (pan === 0) return "C";
  return pan < 0 ? `${pan}L` : `${pan}R`;
}

function formatNormalizedWidth(n: number): string {
  return `${Math.round((n * 2 - 1) * 100)}%`;
}

function formatNormalizedMute(n: number): string {
  return n >= 0.5 ? "Muted" : "Active";
}

function formatNormalizedPercent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// --- Conversion helpers ---

const volToBackend = (n: number) => n * 66 - 60;
const panToBackend = (n: number) => n * 2 - 1;
const identity = (n: number) => n;

// --- Registry ---

export const AUTOMATION_PARAMS: readonly AutomationParamDef[] = [
  {
    id: "volume",
    label: "Volume",
    shortLabel: "Vol",
    color: "#4488ff",
    defaultNormalized: 0.77,
    category: "base",
    toBackend: volToBackend,
    formatNormalized: formatNormalizedVolume,
    inlineFader: {
      trackProperty: "volumeDB",
      variant: "default",
      min: -60, max: 12, step: 0.1,
      defaultValue: 0,
      formatValue: formatVolumeDB,
    },
  },
  {
    id: "pan",
    label: "Pan",
    shortLabel: "Pan",
    color: "#44ff88",
    defaultNormalized: 0.5,
    category: "base",
    toBackend: panToBackend,
    formatNormalized: formatNormalizedPan,
    inlineFader: {
      trackProperty: "pan",
      variant: "pan",
      min: -1, max: 1, step: 0.01,
      defaultValue: 0,
      formatValue: formatPan,
    },
  },
  {
    id: "width",
    label: "Width",
    shortLabel: "Width",
    color: "#aa88ff",
    defaultNormalized: 0.5,
    category: "base",
    toBackend: panToBackend,
    formatNormalized: formatNormalizedWidth,
    inlineFader: null,
  },
  {
    id: "volume_prefx",
    label: "Volume (Pre-FX)",
    shortLabel: "Vol(Pre)",
    color: "#6699ff",
    defaultNormalized: 0.77,
    category: "pre-fx",
    toBackend: volToBackend,
    formatNormalized: formatNormalizedVolume,
    inlineFader: null,
  },
  {
    id: "pan_prefx",
    label: "Pan (Pre-FX)",
    shortLabel: "Pan(Pre)",
    color: "#66ffaa",
    defaultNormalized: 0.5,
    category: "pre-fx",
    toBackend: panToBackend,
    formatNormalized: formatNormalizedPan,
    inlineFader: null,
  },
  {
    id: "width_prefx",
    label: "Width (Pre-FX)",
    shortLabel: "W(Pre)",
    color: "#bb99ff",
    defaultNormalized: 0.5,
    category: "pre-fx",
    toBackend: panToBackend,
    formatNormalized: formatNormalizedWidth,
    inlineFader: null,
  },
  {
    id: "mute",
    label: "Mute",
    shortLabel: "Mute",
    color: "#ff4444",
    defaultNormalized: 0.5,
    category: "tail",
    toBackend: identity,
    formatNormalized: formatNormalizedMute,
    inlineFader: {
      trackProperty: "muted",
      variant: "toggle",
      min: 0, max: 1, step: 1,
      defaultValue: 0,
      formatValue: (v: number) => v >= 0.5 ? "Muted" : "Active",
    },
  },
  {
    id: "trim_volume",
    label: "Trim Volume",
    shortLabel: "Trim",
    color: "#44aaff",
    defaultNormalized: 0.77,
    category: "tail",
    toBackend: volToBackend,
    formatNormalized: formatNormalizedVolume,
    inlineFader: null,
  },
] as const;

export const DEFAULT_AUTOMATION_COLOR = "#ffaa44";

// --- Lookup map ---

const PARAM_MAP = new Map<string, AutomationParamDef>(
  AUTOMATION_PARAMS.map((p) => [p.id, p]),
);

// Fallback for unknown/plugin params
const FALLBACK_DEF: Omit<AutomationParamDef, "id" | "label" | "shortLabel"> = {
  color: DEFAULT_AUTOMATION_COLOR,
  defaultNormalized: 0.5,
  category: "base",
  toBackend: identity,
  formatNormalized: formatNormalizedPercent,
  inlineFader: null,
};

export function getAutomationParamDef(paramId: string): AutomationParamDef {
  const def = PARAM_MAP.get(paramId);
  if (def) return def;
  return { id: paramId, label: paramId, shortLabel: paramId, ...FALLBACK_DEF };
}

export function getAutomationColor(paramId: string): string {
  return PARAM_MAP.get(paramId)?.color ?? DEFAULT_AUTOMATION_COLOR;
}

export function getAutomationShortLabel(paramId: string): string {
  return PARAM_MAP.get(paramId)?.shortLabel ?? paramId;
}

export function getAutomationDefault(paramId: string): number {
  return PARAM_MAP.get(paramId)?.defaultNormalized ?? 0.5;
}

export function automationToBackend(paramId: string, normalized: number): number {
  const def = PARAM_MAP.get(paramId);
  return def ? def.toBackend(normalized) : normalized;
}

export function formatAutomationValue(paramId: string, normalized: number): string {
  const def = PARAM_MAP.get(paramId);
  return def ? def.formatNormalized(normalized) : formatNormalizedPercent(normalized);
}

export function getTrackAutomationParams(trackType: TrackType): AutomationParamDef[] {
  const hasPreFX = trackType === "instrument" || trackType === "bus";
  return AUTOMATION_PARAMS.filter(
    (p) => p.category === "base" || p.category === "tail" || (hasPreFX && p.category === "pre-fx"),
  );
}

export function getMasterAutomationParams(): AutomationParamDef[] {
  return AUTOMATION_PARAMS.filter((p) => p.id === "volume" || p.id === "pan");
}

// --- Interpolation ---

/**
 * Linearly interpolate automation points at a given time.
 * Points must be sorted by time. Returns normalized 0-1 value.
 * Holds first/last point value outside range.
 */
export function interpolateAtTime(
  points: readonly { time: number; value: number }[],
  time: number,
): number {
  if (points.length === 0) return 0.5;
  if (points.length === 1 || time <= points[0].time) return points[0].value;
  if (time >= points[points.length - 1].time) return points[points.length - 1].value;

  // Binary search for the segment containing `time`
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= time) lo = mid;
    else hi = mid;
  }

  const p0 = points[lo];
  const p1 = points[hi];
  const dt = p1.time - p0.time;
  if (dt <= 0) return p0.value;
  const t = (time - p0.time) / dt;
  return p0.value + (p1.value - p0.value) * t;
}
