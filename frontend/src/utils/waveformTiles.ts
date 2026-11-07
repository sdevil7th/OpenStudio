import type { WaveformPeak } from "../services/NativeBridge";

export const WAVEFORM_TILE_PEAKS = 4096;
export interface WaveformTileRequest {
  key: string;
  filePath: string;
  samplesPerPixel: number;
  startSample: number;
  numPixels: number;
  sourceRangeStartSample: number;
  sourceRangeEndSample: number;
}

/** Fixed source tiles let prefetch and visible clips share complete immutable windows. */
export function planWaveformTiles(
  filePath: string,
  samplesPerPixel: number,
  firstSample: number,
  endSample: number,
  sourceStart = 0,
  sourceEnd = -1,
): WaveformTileRequest[] {
  if (!filePath || ![samplesPerPixel, firstSample, endSample, sourceStart, sourceEnd].every(Number.isFinite)
    || !Number.isInteger(samplesPerPixel) || samplesPerPixel < 1 || firstSample < 0
    || endSample <= firstSample || sourceStart < 0 || (sourceEnd >= 0 && sourceEnd <= sourceStart)) return [];
  const tileSamples = WAVEFORM_TILE_PEAKS * samplesPerPixel;
  const last = sourceEnd >= 0 ? Math.min(endSample, sourceEnd) : endSample;
  const requests: WaveformTileRequest[] = [];
  // A viewport must not produce an unbounded request burst at extreme geometry.
  for (let startSample = Math.floor(firstSample / tileSamples) * tileSamples;
    startSample < last && requests.length < 16; startSample += tileSamples) {
    const rangeStart = sourceStart > startSample ? Math.round(sourceStart) : 0;
    const rangeEnd = sourceEnd >= 0 && sourceEnd < startSample + tileSamples ? Math.round(sourceEnd) : -1;
    const suffix = rangeStart > 0 || rangeEnd >= 0 ? `|bounds:${rangeStart}:${rangeEnd}` : "";
    requests.push({
      key: `${filePath}-${samplesPerPixel}-${startSample}${suffix}`,
      filePath, samplesPerPixel, startSample, numPixels: WAVEFORM_TILE_PEAKS,
      sourceRangeStartSample: rangeStart, sourceRangeEndSample: rangeEnd,
    });
  }
  return requests;
}

/** Memoize only for the lifetime of the owning source cache to release evicted data. */
export function readWaveformTileWindow(
  requests: readonly WaveformTileRequest[],
  sourceCache: ReadonlyMap<string, WaveformPeak[]>,
  windows: Map<string, WaveformPeak[]>,
): WaveformPeak[] | undefined {
  if (requests.length === 0) return undefined;
  const parts = requests.map((request) => sourceCache.get(request.key));
  if (parts.some((part) => !part)) return undefined;
  if (parts.length === 1) return parts[0];
  const key = requests.map((request) => request.key).join("\n");
  let combined = windows.get(key);
  if (!combined) {
    combined = (parts as WaveformPeak[][]).flat();
    if (windows.size >= 64) windows.delete(windows.keys().next().value!);
    windows.set(key, combined);
  }
  return combined;
}
