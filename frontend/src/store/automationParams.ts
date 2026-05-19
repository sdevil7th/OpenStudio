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
  category: "base" | "pre-fx" | "tail" | "midi";
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
  return formatVolumeDB(n * VOLUME_DB_RANGE + VOLUME_MIN_DB);
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

function formatNormalizedVelocityScale(n: number): string {
  return `${Math.round(n * 200)}%`;
}

function formatNormalizedMIDI127(n: number): string {
  return `${Math.round(n * 127)}`;
}

// --- Conversion helpers ---

export const VOLUME_MIN_DB = -60;
export const VOLUME_MAX_DB = 12;
export const VOLUME_DB_RANGE = VOLUME_MAX_DB - VOLUME_MIN_DB;
export const VOLUME_UNITY_NORMALIZED = (0 - VOLUME_MIN_DB) / VOLUME_DB_RANGE;

const volToBackend = (n: number) => n * VOLUME_DB_RANGE + VOLUME_MIN_DB;
const panToBackend = (n: number) => n * 2 - 1;
const velocityScaleToBackend = (n: number) => n * 2;
const midi127ToBackend = (n: number) => n * 127;
const identity = (n: number) => n;

// --- Registry ---

export const AUTOMATION_PARAMS: readonly AutomationParamDef[] = [
  {
    id: "volume",
    label: "Volume",
    shortLabel: "Vol",
    color: "#4488ff",
    defaultNormalized: VOLUME_UNITY_NORMALIZED,
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
    defaultNormalized: VOLUME_UNITY_NORMALIZED,
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
    defaultNormalized: VOLUME_UNITY_NORMALIZED,
    category: "tail",
    toBackend: volToBackend,
    formatNormalized: formatNormalizedVolume,
    inlineFader: null,
  },
  {
    id: "midi_velocity_scale",
    label: "MIDI Velocity Scale",
    shortLabel: "Vel%",
    color: "#4cc9f0",
    defaultNormalized: 0.5,
    category: "midi",
    toBackend: velocityScaleToBackend,
    formatNormalized: formatNormalizedVelocityScale,
    inlineFader: null,
  },
  {
    id: "midi_pitch_bend",
    label: "MIDI Pitch Bend",
    shortLabel: "PB",
    color: "#f59e0b",
    defaultNormalized: 0.5,
    category: "midi",
    toBackend: panToBackend,
    formatNormalized: formatNormalizedWidth,
    inlineFader: null,
  },
  {
    id: "midi_channel_pressure",
    label: "MIDI Channel Pressure",
    shortLabel: "Press",
    color: "#c084fc",
    defaultNormalized: 0,
    category: "midi",
    toBackend: midi127ToBackend,
    formatNormalized: formatNormalizedMIDI127,
    inlineFader: null,
  },
  {
    id: "midi_cc_1",
    label: "MIDI CC 1 Mod Wheel",
    shortLabel: "CC1",
    color: "#22c55e",
    defaultNormalized: 0,
    category: "midi",
    toBackend: midi127ToBackend,
    formatNormalized: formatNormalizedMIDI127,
    inlineFader: null,
  },
  {
    id: "midi_cc_7",
    label: "MIDI CC 7 Volume",
    shortLabel: "CC7",
    color: "#14b8a6",
    defaultNormalized: 0.7874,
    category: "midi",
    toBackend: midi127ToBackend,
    formatNormalized: formatNormalizedMIDI127,
    inlineFader: null,
  },
  {
    id: "midi_cc_10",
    label: "MIDI CC 10 Pan",
    shortLabel: "CC10",
    color: "#a3e635",
    defaultNormalized: 0.5,
    category: "midi",
    toBackend: midi127ToBackend,
    formatNormalized: formatNormalizedMIDI127,
    inlineFader: null,
  },
  {
    id: "midi_cc_64",
    label: "MIDI CC 64 Sustain",
    shortLabel: "CC64",
    color: "#f97316",
    defaultNormalized: 0,
    category: "midi",
    toBackend: midi127ToBackend,
    formatNormalized: formatNormalizedMIDI127,
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
  if (/^midi_cc_(\d{1,3})$/.test(paramId)) {
    const cc = Number(paramId.slice("midi_cc_".length));
    if (cc >= 0 && cc <= 127) {
      return {
        id: paramId,
        label: `MIDI CC ${cc}`,
        shortLabel: `CC${cc}`,
        color: DEFAULT_AUTOMATION_COLOR,
        defaultNormalized: 0,
        category: "midi",
        toBackend: midi127ToBackend,
        formatNormalized: formatNormalizedMIDI127,
        inlineFader: null,
      };
    }
  }
  return { id: paramId, label: paramId, shortLabel: paramId, ...FALLBACK_DEF };
}

export function getAutomationColor(paramId: string): string {
  return PARAM_MAP.get(paramId)?.color ?? DEFAULT_AUTOMATION_COLOR;
}

export function getAutomationShortLabel(paramId: string): string {
  return PARAM_MAP.get(paramId)?.shortLabel ?? paramId;
}

export function getAutomationDefault(paramId: string): number {
  return getAutomationParamDef(paramId).defaultNormalized;
}

export function automationToBackend(paramId: string, normalized: number): number {
  return getAutomationParamDef(paramId).toBackend(normalized);
}

export function formatAutomationValue(paramId: string, normalized: number): string {
  return getAutomationParamDef(paramId).formatNormalized(normalized);
}

export function getTrackAutomationParams(trackType: TrackType): AutomationParamDef[] {
  const hasPreFX = trackType === "instrument" || trackType === "bus";
  const hasMIDI = trackType === "midi" || trackType === "instrument";
  return AUTOMATION_PARAMS.filter(
    (p) => p.category === "base"
      || p.category === "tail"
      || (hasPreFX && p.category === "pre-fx")
      || (hasMIDI && p.category === "midi"),
  );
}

export function pluginAutomationParamId(isInputFX: boolean, fxIndex: number, paramIndex: number): string {
  return `plugin_${isInputFX ? "input" : "track"}_${fxIndex}_${paramIndex}`;
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
