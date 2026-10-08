import { describe, expect, it } from "vitest";
import { EQ_REFERENCE_KEY, eqReferenceGrid, readEQReferences, referenceForRate, removeEQReference, saveEQReference } from "../utils/eqMatchReferences";

const curve = (rate = 48000) => ({ success: true, sampleRate: rate, frequencies: eqReferenceGrid(rate), spectrum: eqReferenceGrid(rate).map(hz => -60 + 3 * Math.log2(hz / 80)), seconds: 4, windows: 45, values: { outputGain: 12 }, sourceName: "private-file.wav" });
const memory = () => {
  let value: string | null = null;
  return { getItem: (_key: string) => value, setItem: (_key: string, data: string) => { value = data; } };
};
describe("EQ reference library", () => {
  it("starts empty and round-trips independent references without audio paths or EQ state", () => {
    const storage = memory(); expect(readEQReferences(storage)).toEqual([]);
    const entries = saveEQReference(" Vocal ", curve(), storage);
    expect(entries[0].name).toBe("Vocal"); expect(readEQReferences(storage)).toEqual(entries);
    expect(storage.getItem(EQ_REFERENCE_KEY)).not.toMatch(/private-file|outputGain|values/);
    const more = saveEQReference("Vocal", curve(96000), storage);
    expect(new Set(more.map(item => item.id)).size).toBe(2);
    expect(removeEQReference(entries[0].id, storage)).toEqual([more[1]]);
  });
  it("preserves corrupt, unsupported and oversized libraries instead of replacing them", () => {
    for (const raw of ["{", JSON.stringify({ version: 2, entries: [] }), " ".repeat(512 * 1024 + 1)]) {
      const storage = memory(); storage.setItem(EQ_REFERENCE_KEY, raw);
      expect(() => saveEQReference("New", curve(), storage)).toThrow(/preserved/);
      expect(storage.getItem(EQ_REFERENCE_KEY)).toBe(raw);
    }
  });
  it("rejects malformed numbers, grids, duplicate identities and excess capacity", () => {
    const storage = memory(); const entry = saveEQReference("Good", curve(), storage)[0];
    for (const bad of [{ ...entry, spectrum: [NaN] }, { ...entry, frequencies: Array(129).fill(80) }, { ...entry, sampleRate: 0 }, { ...entry, windows: 1.5 }]) {
      storage.setItem(EQ_REFERENCE_KEY, JSON.stringify({ version: 1, entries: [bad] }));
      expect(() => readEQReferences(storage)).toThrow(/preserved/);
    }
    storage.setItem(EQ_REFERENCE_KEY, JSON.stringify({ version: 1, entries: [entry, entry] }));
    expect(() => readEQReferences(storage)).toThrow(/preserved/);
    storage.setItem(EQ_REFERENCE_KEY, JSON.stringify({ version: 1, entries: Array.from({ length: 32 }, (_, i) => ({ ...entry, id: String(i) })) }));
    expect(() => saveEQReference("Overflow", curve(), storage)).toThrow(/32 references/);
  });
  it("propagates storage failures and leaves existing references intact", () => {
    const storage = memory(); saveEQReference("Good", curve(), storage); const before = storage.getItem(EQ_REFERENCE_KEY);
    expect(() => saveEQReference("New", curve(), { getItem: storage.getItem, setItem: () => { throw new Error("Quota"); } })).toThrow("Quota");
    expect(storage.getItem(EQ_REFERENCE_KEY)).toBe(before);
  });
  it("interpolates log-frequency curves and rejects missing high-frequency coverage", () => {
    expect(referenceForRate(curve(), 96000)).toEqual(curve().spectrum);
    const remapped = referenceForRate(curve(), 22050), expected = curve(22050).spectrum;
    expect(Math.max(...remapped.map((v, i) => Math.abs(v - expected[i])))).toBeLessThan(1e-12);
    expect(() => referenceForRate(curve(22050), 48000)).toThrow(/higher sample rate/);
  });
});
