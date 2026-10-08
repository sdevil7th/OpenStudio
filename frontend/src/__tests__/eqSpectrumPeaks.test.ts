import { describe, expect, it } from "vitest";
import { captureSpectrumPeaks, captureSpectrumGrab, moveSpectrumGrabBand } from "../utils/eqSpectrumPeaks";
const frame = (frequencies: number[], spectrumPreDb: number[]) => ({ frequencies, spectrumPreDb, spectrumReady: true });
describe("Captured EQ spectrum peaks", () => {
  it("ranks separated peaks without changing input data", () => {
    const f=frame([20,40,80,160,320,640,1280,2560,5120],[-100,-90,-10,-60,-70,-20,-80,-90,-100]);
    const before=JSON.stringify(f);expect(captureSpectrumPeaks(f)).toEqual([{frequency:80,db:-10},{frequency:640,db:-20}]);expect(JSON.stringify(f)).toBe(before);
  });
  it("rejects unavailable, silent, flat, malformed and nonfinite frames", () => {
    for(const f of [{...frame([20,40,80,160,320],[-50,-40,-10,-40,-50]),spectrumReady:false},frame([20,40,80,160,320],[-100,-100,-95,-100,-100]),frame([20,40,80,160,320],[-20,-20,-20,-20,-20]),frame([20,40,40,160,320],[-50,-40,-10,-40,-50]),frame([20,40,80,160,320],[-50,NaN,-10,-40,-50])])expect(captureSpectrumPeaks(f)).toEqual([]);
  });
  it("keeps the strongest candidate within a sixth octave and caps crowded spectra", () => {
    const hz=Array.from({length:45},(_,i)=>100*2**(i/12));const db=hz.map((_,i)=>i%2?-60:-10-i/10);
    const peaks=captureSpectrumPeaks(frame(hz,db));expect(peaks).toHaveLength(6);
    for(let i=1;i<peaks.length;i++)expect(Math.abs(Math.log2(peaks[i].frequency/peaks[i-1].frequency))).toBeGreaterThanOrEqual(1/6);
  });
  it("captures an independent output frame and estimates logarithmic half-power width", () => {
    const frequencies = [250, 500, 750, 1000, 1500, 2000, 3000];
    const input = frame(frequencies, frequencies.map(() => -90));
    const spectrumPostDb = [-40, -30, -16, -10, -16, -30, -40];
    const capture = captureSpectrumGrab({ ...input, spectrumPostDb }, true)!;
    expect(capture.source).toBe("Output"); expect(capture.peaks).toHaveLength(1);
    expect(capture.peaks[0].q).toBeCloseTo(1000 / (Math.sqrt(1000 * 1500) - Math.sqrt(750 * 1000)), 8);
    frequencies[3] = 1100; spectrumPostDb[3] = -80;
    expect(capture.frequencies[3]).toBe(1000); expect(capture.db[3]).toBe(-10);
    expect(captureSpectrumGrab(input, true)).toBeNull();
    expect(captureSpectrumGrab({ ...input, spectrumExternalDb: capture.db }, "external")?.source).toBe("External key");
  });
  it("keeps grab movement in band bounds without changing the measured Q", () => {
    const initial = { frequency: 1000, gain: 0, q: 4 };
    expect(moveSpectrumGrabBand(initial, 1, -6)).toEqual({ frequency: 2000, gain: -6, q: 4 });
    expect(moveSpectrumGrabBand(initial, 50, 100)).toEqual({ frequency: 20000, gain: 24, q: 4 });
    expect(moveSpectrumGrabBand(initial, -50, -100)).toEqual({ frequency: 20, gain: -24, q: 4 });
    expect(moveSpectrumGrabBand(initial, -50, 0, 10, 30000).frequency).toBe(10);
    expect(moveSpectrumGrabBand(initial, 50, 0, 10, 30000).frequency).toBe(30000);
    expect(moveSpectrumGrabBand(initial, 0, 0, 1200, 2400).frequency).toBe(1200);
    expect(initial).toEqual({ frequency: 1000, gain: 0, q: 4 });
  });
});
