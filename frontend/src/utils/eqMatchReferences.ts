import type { EQMatchResult } from "../services/NativeBridge";

export const EQ_REFERENCE_KEY = "openstudio.eqMatchReferences.v1";
const maxEntries = 32;
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export type EQReference = {
  id: string; name: string; createdAt: string;
  spectrum: number[]; frequencies: number[]; sampleRate: number; seconds: number; windows: number;
};
const validNumber = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
export const eqReferenceGrid = (rate: number) => Array.from({ length: 129 }, (_, i) => 80 * Math.pow(Math.min(16000, rate * .4) / 80, i / 128));

function curveData(value: unknown): Pick<EQReference, "spectrum" | "frequencies" | "sampleRate" | "seconds" | "windows"> {
  if (!value || typeof value !== "object") throw new Error("Invalid learned reference");
  const data = value as Record<string, unknown>;
  if (!validNumber(data.sampleRate, 8000, 192000) || !validNumber(data.seconds, 0, 30)
    || !validNumber(data.windows, 1, 2000) || !Number.isInteger(data.windows)
    || !Array.isArray(data.spectrum) || data.spectrum.length !== 129 || !data.spectrum.every(v => validNumber(v, -120, 80))
    || !Array.isArray(data.frequencies) || data.frequencies.length !== 129)
    throw new Error("Invalid learned reference");
  const grid = eqReferenceGrid(data.sampleRate);
  if (!data.frequencies.every((v, i) => validNumber(v, 80, 16000.001) && Math.abs(v - grid[i]) < .001))
    throw new Error("Reference frequency grid is invalid");
  return { sampleRate: data.sampleRate, seconds: data.seconds, windows: data.windows,
    spectrum: [...data.spectrum], frequencies: [...data.frequencies] };
}

export function readEQReferences(storage: StorageAccess = localStorage): EQReference[] {
  const raw = storage.getItem(EQ_REFERENCE_KEY);
  if (raw === null) return [];
  try {
    if (raw.length > 512 * 1024) throw new Error();
    const library = JSON.parse(raw);
    if (library.version !== 1 || !Array.isArray(library.entries) || library.entries.length > maxEntries) throw new Error();
    const ids = new Set<string>();
    return library.entries.map((entry: Record<string, unknown>) => {
      if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 80 || ids.has(entry.id)
        || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80
        || typeof entry.createdAt !== "string" || entry.createdAt.length > 30 || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error();
      ids.add(entry.id);
      return { id: entry.id, name: entry.name, createdAt: entry.createdAt, ...curveData(entry) };
    });
  } catch { throw new Error("Saved EQ references are unreadable; existing storage has been preserved"); }
}

export function saveEQReference(name: string, result: EQMatchResult, storage: StorageAccess = localStorage): EQReference[] {
  const entries = readEQReferences(storage);
  const label = name.trim();
  if (!label || label.length > 80) throw new Error("Name the reference using 1-80 characters");
  if (entries.length >= maxEntries) throw new Error("The library holds 32 references; remove one before saving");
  const entry: EQReference = { id: crypto.randomUUID(), name: label, createdAt: new Date().toISOString(), ...curveData(result) };
  const updated = [...entries, entry];
  storage.setItem(EQ_REFERENCE_KEY, JSON.stringify({ version: 1, entries: updated }));
  return updated;
}

export function removeEQReference(id: string, storage: StorageAccess = localStorage): EQReference[] {
  const entries = readEQReferences(storage).filter(entry => entry.id !== id);
  storage.setItem(EQ_REFERENCE_KEY, JSON.stringify({ version: 1, entries }));
  return entries;
}

/** Interpolate dB against log frequency; never invent bins beyond measured coverage. */
export function referenceForRate(reference: EQMatchResult | EQReference, rate: number): number[] {
  const data = curveData(reference);
  if (!validNumber(rate, 8000, 192000)) throw new Error("Invalid current sample rate");
  const target = eqReferenceGrid(rate);
  if (target[128] > data.frequencies[128] + .001) throw new Error("Reference does not cover the current high frequencies; learn it at a higher sample rate");
  let index = 0;
  return target.map(hz => {
    while (index < 127 && data.frequencies[index + 1] < hz) ++index;
    const fraction = Math.max(0, Math.min(1, Math.log(hz / data.frequencies[index]) / Math.log(data.frequencies[index + 1] / data.frequencies[index])));
    return data.spectrum[index] + fraction * (data.spectrum[index + 1] - data.spectrum[index]);
  });
}
