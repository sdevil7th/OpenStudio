import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import { quantizeParamValue } from "./builtInParamValue";

export const NAM_FUZZ_VOICE_LABELS = ["Vintage", "Sustain", "Gated"] as const;

export const NAM_FUZZ_DEFAULT_VALUES = {
  fuzzEnabled: 0,
  fuzzDrive: 0.5,
  fuzzTone: 0.5,
  fuzzLevelDb: 0,
  fuzzVoice: 0,
  fuzzCleanMix: 0,
} as const;

const finiteValue = (value: unknown, fallback: number) => {
  const numeric = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(numeric) ? numeric : fallback;
};

export function normalizeNAMFuzzVoice(value: unknown): 0 | 1 | 2 {
  return Math.max(0, Math.min(2, Math.round(finiteValue(value, 0)))) as 0 | 1 | 2;
}

export function normalizeNAMFuzzValues(values: Readonly<Record<string, unknown>>) {
  const bounded = (id: keyof typeof NAM_FUZZ_DEFAULT_VALUES, min: number, max: number) =>
    Math.max(min, Math.min(max, finiteValue(values[id], NAM_FUZZ_DEFAULT_VALUES[id])));
  return {
    fuzzEnabled: bounded("fuzzEnabled", 0, 1) >= 0.5 ? 1 : 0,
    fuzzDrive: bounded("fuzzDrive", 0, 1),
    fuzzTone: bounded("fuzzTone", 0, 1),
    fuzzLevelDb: bounded("fuzzLevelDb", -18, 12),
    fuzzVoice: normalizeNAMFuzzVoice(values.fuzzVoice),
    fuzzCleanMix: bounded("fuzzCleanMix", 0, 1),
  };
}

export function hasCurrentNAMFuzzValues(values: Readonly<Record<string, unknown>>) {
  return Object.entries(normalizeNAMFuzzValues(values)).every(([id, value]) => values[id] === value);
}

/** Return display text even when clamping/rounding leaves the live value unchanged. */
export function resolveNAMFuzzCleanEntry(param: BuiltInParamDescriptor, draft: string): { value: number | null; text: string } {
  const percent = draft.trim() === "" ? Number.NaN : Number(draft);
  const value = Number.isFinite(percent) ? quantizeParamValue(param, percent / 100) : null;
  return { value, text: String(Math.round((value ?? param.value) * 1000) / 10) };
}

export function resolveNAMOctaverFuzzActivity(octaverEnabled: unknown, fuzzEnabled: unknown, fuzzVoice: unknown) {
  const octaveActive = finiteValue(octaverEnabled, 0) >= 0.5;
  const fuzzActive = finiteValue(fuzzEnabled, 0) >= 0.5;
  const voice = NAM_FUZZ_VOICE_LABELS[normalizeNAMFuzzVoice(fuzzVoice)];
  return {
    active: octaveActive || fuzzActive,
    octaveActive,
    fuzzActive,
    label: octaveActive && fuzzActive ? `Octave + ${voice} Fuzz` : octaveActive ? "Octave" : fuzzActive ? `${voice} Fuzz` : "Bypassed",
  };
}
