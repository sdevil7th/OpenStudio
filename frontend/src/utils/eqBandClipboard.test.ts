import { describe, expect, it } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { applyEQBandValues, freeEQBand, parseEQBandClipboard, readEQBand } from "./eqBandClipboard";

const schema = { pluginId: "eq", parameters: [
  ...Array.from({ length: 3 }, (_, band) => [
    ["enabled", band === 1 ? 1 : 0, 0, 1], ["type", band === 0 ? 3 : 0, 0, 6], ["freq", 1000, 20, 20000],
    ["gain", 4, -30, 30], ["q", 1, .1, 30], ["slope", 1, 0, 3], ["slopeMode", 6, 0, 7],
    ["dynamicRange", -24, -24, 24], ["dynamicRangeExtended", -29, -30, 30],
  ].map(([field, value, min, max]) => ({ id: `band${band}.${field}`, value, min, max, defaultValue: 0, type: field === "type" || field === "slopeMode" ? "enum" : "continuous" }))).flat(),
] } as unknown as BuiltInPluginSchema;

describe("EQ band clipboard", () => {
  it("uses current expanded values and maps destination aliases without old-range clipping", () => {
    const band = readEQBand(schema, 1);
    expect(band.dynamicRange).toBe(-29); expect(band.slope).toBe(6);
    const next = applyEQBandValues(schema, 2, band);
    expect(next["band2.dynamicRangeExtended"]).toBe(-29); expect(next["band2.slopeMode"]).toBe(6);
    expect(next).not.toHaveProperty("band2.dynamicRange"); expect(next).not.toHaveProperty("band2.slope");
  });
  it("round-trips valid scalar fields and rejects malformed or unrelated payloads", () => {
    const values = readEQBand(schema, 1);
    expect(parseEQBandClipboard(JSON.stringify({ version: 1, values }))).toEqual(values);
    for (const payload of [null, "", "{", JSON.stringify({version:2,values}), JSON.stringify({version:1,values:{...values,freq:null}}), JSON.stringify({version:1,values:{...values,path:"file.wav"}}), "x".repeat(8193)]) expect(parseEQBandClipboard(payload)).toBeNull();
  });
  it("bounds destination fields and reserves disabled cut bands", () => {
    expect(applyEQBandValues(schema,2,{gain:100,q:-5,type:2.7})).toEqual({"band2.type":3,"band2.gain":30,"band2.q":.1});
    expect(freeEQBand(schema)).toBe(2); expect(freeEQBand(schema,2)).toBeNull();
  });
});
