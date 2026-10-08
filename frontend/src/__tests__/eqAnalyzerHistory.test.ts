import { describe, expect, it } from "vitest";
import { analyzerPosition, defaultAnalyzerSettings as defaults, EQAnalyzerHistory } from "../utils/eqAnalyzerHistory";
const frame = (db: number, frequencies = [100, 1000, 10000]) => ({ frequencies, spectrumPreDb: frequencies.map(() => db), spectrumPostDb: frequencies.map(() => db - 6), spectrumReady: true });

describe("EQ analyzer display history", () => {
  it("uses elapsed time for release, immediate attack and preserves the default raw view", () => {
    const a = new EQAnalyzerHistory(), b = new EQAnalyzerHistory();
    const settings = { ...defaults, release: 24 };
    a.update(frame(-20), settings, 0); b.update(frame(-20), settings, 0);
    for (let time = 50; time <= 1000; time += 50) a.update(frame(-100), settings, time);
    expect(a.update(frame(-100), settings, 1000).pre[0]).toBeCloseTo(-44, 10);
    expect(b.update(frame(-100), settings, 1000).pre[0]).toBe(-44);
    expect(a.update(frame(-10), settings, 1100).pre[0]).toBe(-10);
    expect(a.update(frame(-100), defaults, 1150).pre[0]).toBe(-100);
  });
  it("holds maxima while Pause freezes exactly and resume does not count paused time", () => {
    const history = new EQAnalyzerHistory(), hold = { ...defaults, hold: true };
    history.update(frame(-20), hold, 0);
    expect(history.update(frame(-40), hold, 100).pre[0]).toBe(-20);
    expect(history.update(frame(-10), hold, 200).pre[0]).toBe(-10);
    const snapshot = history.update(frame(-5), { ...hold, paused: true }, 300);
    expect(snapshot.pre[0]).toBe(-10);
    expect(history.update(frame(0), { ...hold, paused: true }, 10300)).toBe(snapshot);
    expect(history.update(frame(-80), { ...defaults, release: 24 }, 10350).pre[0]).toBeCloseTo(-11.2);
    expect(snapshot.pre[0]).toBe(-10);
  });
  it("discards history across frequency grids, invalid data, and explicit reset", () => {
    const history = new EQAnalyzerHistory();history.update(frame(-10), defaults, 0);
    expect(history.update(frame(-80, [200,2000,18000]), { ...defaults, paused: true }, 10).pre[0]).toBe(-80);
    expect(history.update(frame(-20, [1,1,3]), defaults, 20).ready).toBe(false);
    const bad=frame(-20);bad.spectrumPreDb[0]=NaN;bad.spectrumPostDb[1]=Infinity;
    const output=history.update(bad,defaults,30);expect(output.pre[0]).toBe(-160);expect(output.post[1]).toBe(-160);expect(bad.spectrumPreDb[0]).toBeNaN();
    history.reset();expect(history.update(frame(-90),{...defaults,hold:true},40).pre[0]).toBe(-90);
  });
  it("changes only display mapping and pivots tilt exactly at one kilohertz", () => {
    expect(analyzerPosition(-45,1000,defaults)).toBe(0);
    expect(analyzerPosition(-60,1000,{range:120,tilt:0})).toBe(0);
    expect(analyzerPosition(-30,1000,{range:60,tilt:4.5})).toBe(0);
    expect(analyzerPosition(-30,2000,{range:60,tilt:4.5})).toBeCloseTo(4.5);
    expect(analyzerPosition(-30,500,{range:60,tilt:4.5})).toBeCloseTo(-4.5);
    expect(analyzerPosition(NaN,1000,defaults)).toBe(-30);
    expect(analyzerPosition(20,1000,defaults)).toBe(30);
  });
  it("keeps external-key history independent and drops it when unavailable", () => {
    const history = new EQAnalyzerHistory();
    const a = history.update({ ...frame(-10), spectrumExternalDb: [-20, -30, -40] }, defaults, 0);
    expect(a.external).toEqual([-20, -30, -40]); expect(a.pre).toEqual([-10, -10, -10]);
    expect(history.update({ ...frame(-10), spectrumExternalDb: [-40, -20, -80] }, { ...defaults, hold: true }, 100).external).toEqual([-20, -20, -40]);
    expect(history.update(frame(-10), defaults, 200).external).toBeUndefined();
  });
});
