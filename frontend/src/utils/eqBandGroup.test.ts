import { describe, expect, it } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { eqBandGroupChanges, parseEQGroupClipboard, pasteEQBandGroup } from "./eqBandGroup";
const schema = { pluginId: "eq", parameters: [
  ...Array.from({ length: 3 }, (_, band) => [
    ["enabled", 1, 0, 1, 0], ["type", band === 0 ? 3 : 0, 0, 6, 0], ["freq", 1000 * (band + 1), 20, 20000, 1000],
    ["q", 1, .1, 30, 1], ["gain", 4, -30, 30, 0], ["dynamicRange", -24, -24, 24, 0], ["dynamicRangeExtended", -29, -30, 30, 0],
  ].map(([field, value, min, max, defaultValue]) => ({ id: `band${band}.${field}`, value, min, max, defaultValue, type: "continuous" }))).flat(),
  { id: "bandAudition", value: 2 }, { id: "detectorListenBand", value: 3 },
] } as unknown as BuiltInPluginSchema;
describe("EQ group edits", () => {
  it("scales gain/range around zero and Q multiplicatively without changing unrelated fields", () => {
    expect(eqBandGroupChanges(schema,[0,1],"gainScale",0,0,.5)).toEqual({"band1.gain":2,"band1.dynamicRangeExtended":-14.5});
    expect(eqBandGroupChanges(schema,[0,1,2],"qScale",0,0,2)).toEqual({"band1.q":2,"band2.q":2});
    const allPass = {...schema,parameters:[...schema.parameters,{id:"band0.allPass",value:1,min:0,max:1,defaultValue:0,label:"All Pass",type:"toggle"}]};
    expect(eqBandGroupChanges(allPass,[0],"qScale",0,0,2)).toEqual({"band0.q":2});
    expect(()=>eqBandGroupChanges(schema,[1],"gainScale",0,0,2)).toThrow(/exceed/);
    expect(()=>eqBandGroupChanges(schema,[1],"qScale",0,0,9)).toThrow(/multiplier/);
  });
  it("validates every copied band and bounds group size", () => {
    const band = {enabled:1,type:0,freq:1000,gain:4,q:1};
    expect(parseEQGroupClipboard(JSON.stringify({version:1,bands:[band,band]}))).toEqual([band,band]);
    for (const bands of [[],[band,{...band,freq:null}],Array(25).fill(band)]) expect(parseEQGroupClipboard(JSON.stringify({version:1,bands}))).toBeNull();
    expect(parseEQGroupClipboard("bad")).toBeNull();
  });
  it("pastes whole groups into unused non-cut slots or rejects before mutation", () => {
    const empty = {...schema,parameters:schema.parameters.map(p=>p.id.endsWith(".enabled")?{...p,value:0}:p)};
    const band = {enabled:0,type:0,freq:500,gain:2,q:1};
    const pasted=pasteEQBandGroup(empty,[band,band],[]);
    expect(pasted.bands).toEqual([1,2]);expect(pasted.changes).toMatchObject({"band1.enabled":1,"band2.enabled":1,"band1.freq":500,"band2.freq":500});
    expect(()=>pasteEQBandGroup(empty,[band,band],[1])).toThrow(/only 1/);
  });
  it("preserves frequency ratios, offsets gain shapes only, and leaves unselected bands alone", () => {
    const changes = eqBandGroupChanges(schema, [0,1], "offset", 12, 3);
    expect(changes).toEqual({"band0.freq":2000,"band1.freq":4000,"band1.gain":7});
  });
  it("rejects the entire proposal when any selected value would clip", () => {
    expect(() => eqBandGroupChanges(schema,[0,1],"offset",48,0)).toThrow(/exceed/);
    expect(() => eqBandGroupChanges(schema,[1],"offset",0,30)).toThrow(/exceed/);
    expect(() => eqBandGroupChanges(schema,[],"offset")).toThrow(/Select/);
  });
  it("flips expanded ranges and clears only selected audition on grouped bypass", () => {
    expect(eqBandGroupChanges(schema,[0,1],"flip")).toEqual({"band1.gain":-4,"band1.dynamicRangeExtended":29});
    expect(eqBandGroupChanges(schema,[1],"bypass")).toEqual({"band1.enabled":0,"bandAudition":0});
    expect(eqBandGroupChanges(schema,[2],"reset")).toMatchObject({"band2.gain":0,"band2.dynamicRangeExtended":0,"detectorListenBand":0});
  });
});
