import { describe, expect, it } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { eqBandDragChanges, eqBandParameterChanges } from "./eqBandDrag";

const schema = { pluginId: "eq", parameters: [
  ...[100, 1000, 15000].flatMap((frequency, band) => [
    ["enabled", 1, 0, 1], ["type", band === 0 ? 3 : 0, 0, 6], ["freq", frequency, 20, 20000], ["frequencyExtended", frequency, 10, 30000],
    ["gain", band * 10, -30, 30], ["q", band + 1, .1, 30], ["slope", 0, 0, 3], ["target", 0, 0, 4], ["dynamicEnabled", 0, 0, 1],
  ].map(([field, value, min, max]) => ({ id: `band${band}.${field}`, value, min, max, defaultValue: value, type: "continuous" }))),
] } as unknown as BuiltInPluginSchema;

describe("EQ graph groups", () => {
  it("stops the entire group at a bound without squeezing its frequency spacing or gain differences", () => {
    const changes = eqBandDragChanges(schema, [0, 1, 2], 1, { x: 4000, y: 40 });
    expect(changes).toEqual({ "band0.frequencyExtended": 200, "band1.frequencyExtended": 2000, "band2.frequencyExtended": 30000, "band1.gain": 20, "band2.gain": 30 });
    expect(changes["band2.frequencyExtended"] / changes["band1.frequencyExtended"]).toBe(15);
  });
  it("scales Q together while excluding a first-order cut and leaves unselected bands untouched", () => {
    expect(eqBandDragChanges(schema, [0, 1, 2], 1, { z: 30 })).toEqual({ "band1.q": 20, "band2.q": 30 });
    expect(eqBandDragChanges(schema, [1], 1, { x: 500, y: 2 })).toEqual({ "band1.frequencyExtended": 500, "band1.gain": 2 });
  });
  it("shares common inspector settings but applies dynamics only to eligible shapes", () => {
    expect(eqBandParameterChanges(schema, [0, 1, 2], "band1.target", 3)).toEqual({ "band0.target": 3, "band1.target": 3, "band2.target": 3 });
    expect(eqBandParameterChanges(schema, [0, 1, 2], "band1.dynamicEnabled", 1)).toEqual({ "band1.dynamicEnabled": 1, "band2.dynamicEnabled": 1 });
    expect(eqBandParameterChanges(schema, [1, 2], "band1.gain", 5)).toEqual({ "band1.gain": 5, "band2.gain": 15 });
  });
});
