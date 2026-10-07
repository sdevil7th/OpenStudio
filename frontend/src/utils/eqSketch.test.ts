import { describe, expect, it } from "vitest";
import { paintSketch, sketchFrequency } from "./eqSketch";
describe("drawn correction",()=>{
 it("interpolates both directions without touching other bins",()=>{
  const initial=Array(129).fill(0);const up=paintSketch(initial,{index:20,gain:0},{index:30,gain:10});
  expect(up[19]).toBe(0);expect(up[25]).toBe(5);expect(up[31]).toBe(0);
  const back=paintSketch(up,{index:30,gain:10},{index:20,gain:-10});expect(back[25]).toBe(0);expect(back[20]).toBe(-10);expect(initial.every(n=>n===0)).toBe(true);
 });
 it("bounds gain and supports a single point",()=>{expect(paintSketch([0,0,0],{index:1,gain:99},{index:1,gain:99})).toEqual([0,12,0]);});
 it("uses logarithmic shared native fit frequencies",()=>{expect(sketchFrequency(0,48000)).toBe(80);expect(sketchFrequency(128,48000)).toBe(16000);expect(sketchFrequency(128,8000)).toBe(3200);expect(sketchFrequency(64,48000)).toBeCloseTo(Math.sqrt(80*16000));});
});
