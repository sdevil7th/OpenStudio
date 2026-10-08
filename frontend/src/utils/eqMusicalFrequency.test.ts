import { describe, expect, it } from "vitest";
import { eqFrequencyNote, parseEQFrequency } from "./eqMusicalFrequency";

describe("musical EQ frequency entry", () => {
  it("parses explicit frequency units without implicit tuning", () => {
    expect(parseEQFrequency(" 2 kHz ")).toBe(2000); expect(parseEQFrequency(".44k")).toBe(440);
    expect(parseEQFrequency("440 Hz")).toBe(440); expect(parseEQFrequency("20")).toBe(20);
  });
  it("uses A4=440 and correct enharmonic, octave and cents relationships", () => {
    expect(parseEQFrequency("A4")).toBe(440); expect(parseEQFrequency("A5")).toBe(880);
    expect(parseEQFrequency("C#4")).toBe(parseEQFrequency("Db4")); expect(parseEQFrequency("C♯4")).toBe(parseEQFrequency("D♭4"));
    expect(parseEQFrequency("C-1")).toBeCloseTo(8.1757989156, 8);
    expect(parseEQFrequency("a4+12ct")).toBeCloseTo(440 * 2 ** (.12 / 12), 10);
    expect(parseEQFrequency("A4 - 25 cents")).toBeCloseTo(440 * 2 ** (-.25 / 12), 10);
  });
  it("rejects ambiguous or malformed input and labels note/cents accurately", () => {
    for (const text of ["", "0", "-440", "Infinity", "NaN", "H4", "A", "A4+5000", "A4x", "2ms"]) expect(parseEQFrequency(text)).toBeNull();
    expect(eqFrequencyNote(440)).toBe("A4"); expect(eqFrequencyNote(880)).toBe("A5");
    expect(eqFrequencyNote(440 * 2 ** (.25 / 12))).toBe("A4 +25 ct");
    expect(eqFrequencyNote(NaN)).toBe("");
  });
});
