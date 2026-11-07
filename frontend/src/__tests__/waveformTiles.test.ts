import { describe, expect, it } from "vitest";
import { planWaveformTiles, readWaveformTileWindow, WAVEFORM_TILE_PEAKS } from "../utils/waveformTiles";
import type { WaveformPeak } from "../services/NativeBridge";

const peak = (value: number): WaveformPeak => ({ channels: [{ min: -value, max: value }] });

describe("canonical source waveform tiles", () => {
  it("reuses fixed complete requests as the prefetch endpoint advances, without growing prefixes", () => {
    const observed = new Map<string, number>();
    for (let end = 1000; end < 8000; end += 73) {
      for (const tile of planWaveformTiles("source.wav", 1, 0, end, 0, 90000)) {
        observed.set(tile.key, tile.numPixels);
      }
    }
    expect([...observed.values()]).toEqual([WAVEFORM_TILE_PEAKS, WAVEFORM_TILE_PEAKS]);
    expect([...observed.keys()]).toEqual(["source.wav-1-0", "source.wav-1-4096"]);
  });

  it("shares interior tiles across trim ranges while both consumers use the same exact boundary keys", () => {
    const prefetch = planWaveformTiles("source.wav", 64, 33, 900000, 33, 890111);
    const visible = planWaveformTiles("source.wav", 64, 33, 400000, 33, 890111);
    expect(visible).toEqual(prefetch.slice(0, visible.length));
    expect(prefetch[0].sourceRangeStartSample).toBe(33);
    expect(prefetch[0].sourceRangeEndSample).toBe(-1);
    expect(prefetch[1].key).toBe("source.wav-64-262144");
    expect(prefetch[prefetch.length - 1].sourceRangeStartSample).toBe(0);
    expect(prefetch[prefetch.length - 1].sourceRangeEndSample).toBe(890111);
    const anotherClip = planWaveformTiles("source.wav", 64, 262144, 600000, 91, 999999);
    expect(anotherClip[0].key).toBe(prefetch[1].key);
  });

  it("assembles absolute source order without copying peak objects and waits for every requested tile", () => {
    const requests = planWaveformTiles("source.wav", 1, 4000, 5000);
    const first = [peak(0.1), peak(0.2)], last = [peak(0.3)];
    const sources = new Map([[requests[0].key, first]]);
    const windows = new Map<string, WaveformPeak[]>();
    expect(readWaveformTileWindow(requests, sources, windows)).toBeUndefined();
    sources.set(requests[1].key, last);
    const result = readWaveformTileWindow(requests, sources, windows)!;
    expect(result).toEqual([...first, ...last]);
    expect(result[0]).toBe(first[0]);
    expect(result[2]).toBe(last[0]);
    expect(readWaveformTileWindow(requests, sources, windows)).toBe(result);
    // New source generation owns a fresh memo, so an old assembled window
    // cannot keep invalidated/evicted data visible.
    const replaced = new Map([[requests[0].key, [peak(0.9)]], [requests[1].key, last]]);
    expect(readWaveformTileWindow(requests, replaced, new Map())![0]).toEqual(peak(0.9));
  });

  it("does not request beyond a clip end and bounds pathological viewport work", () => {
    expect(planWaveformTiles("source.wav", 1, 8000, 20000, 0, 9000).map((tile) => tile.startSample)).toEqual([4096, 8192]);
    expect(planWaveformTiles("source.wav", 1, 0, 1e12)).toHaveLength(16);
    expect(planWaveformTiles("", 64, 0, 100)).toEqual([]);
    expect(planWaveformTiles("source.wav", 0, 0, 100)).toEqual([]);
    expect(planWaveformTiles("source.wav", 64, 0, NaN)).toEqual([]);
  });
});
