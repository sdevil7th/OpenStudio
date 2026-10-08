import { describe, expect, it } from "vitest";
import { spectrumAt, spectrumOverlap } from "./eqSpectrumOverlap";
const series = (values: number[], frequencies = [100, 200, 400, 800, 1600]) => ({ frequencies, values });
describe("spectrum overlap visual heuristic", () => {
  it("interpolates in log frequency and never extrapolates", () => {
    const data = series([-20, -40], [100, 400]);
    expect(spectrumAt(data, 200)).toBeCloseTo(-30);
    expect(spectrumAt(data, 99)).toBeNull(); expect(spectrumAt(data, 401)).toBeNull();
  });
  it("excludes silence and separated energy", () => {
    expect(spectrumOverlap(series(Array(5).fill(-100)), series(Array(5).fill(-100)))).toEqual([]);
    expect(spectrumOverlap(series([-10,-60,-60,-60,-60]), series([-60,-60,-60,-60,-10]))).toEqual([]);
  });
  it("groups jointly strong bins and clips to shared support", () => {
    const result = spectrumOverlap(series([-80,-20,-10,-25,-80]), series([-30,-10,-30], [150,400,1000]));
    expect(result).toHaveLength(1); expect(result[0].start).toBe(150);
    expect(result[0].end).toBe(1000);
  });
  it("rejects malformed frequency grids and nonfinite bins", () => {
    for (const bad of [series([-10,NaN]), series([-10,-10],[100,100]), series([-10,-10],[200,100]),series([-10],[100])])
      expect(spectrumOverlap(bad, series(Array(5).fill(-10)))).toEqual([]);
  });
});
