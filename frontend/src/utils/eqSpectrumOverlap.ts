export type SpectrumSeries = { frequencies: number[]; values: number[] };

const valid = ({ frequencies, values }: SpectrumSeries) => frequencies.length > 1 && values.length === frequencies.length
  && frequencies.every((hz, i) => Number.isFinite(hz) && hz > 0 && (i === 0 || hz > frequencies[i - 1]))
  && values.every(Number.isFinite);

// Independent FFT grids need logarithmic frequency interpolation, without extrapolation.
export function spectrumAt(series: SpectrumSeries, hz: number): number | null {
  const { frequencies: f, values: v } = series;
  if (!Number.isFinite(hz) || hz < f[0] || hz > f[f.length - 1]) return null;
  let low = 0, high = f.length - 1;
  while (high - low > 1) { const mid = (low + high) >> 1; if (f[mid] <= hz) low = mid; else high = mid; }
  return v[low] + (v[high] - v[low]) * Math.log(hz / f[low]) / Math.log(f[high] / f[low]);
}

// A visual joint-energy heuristic only. It cannot establish perceptual masking.
export function spectrumOverlap(current: SpectrumSeries, reference: SpectrumSeries): Array<{ start: number; end: number }> {
  if (!valid(current) || !valid(reference)) return [];
  const currentFloor = Math.max(-70, Math.max(...current.values) - 18);
  const referenceFloor = Math.max(-70, Math.max(...reference.values) - 18);
  const result: Array<{ start: number; end: number }> = [];
  let run: { start: number; end: number } | null = null;
  current.frequencies.forEach((hz, i, frequencies) => {
    const ref = spectrumAt(reference, hz);
    if (hz < 20 || hz > 20000 || ref === null || ref < referenceFloor || current.values[i] < currentFloor) { run = null; return; }
    const start = Math.max(20, reference.frequencies[0], i ? Math.sqrt(frequencies[i - 1] * hz) : hz);
    const end = Math.min(20000, reference.frequencies[reference.frequencies.length - 1], i + 1 < frequencies.length ? Math.sqrt(hz * frequencies[i + 1]) : hz);
    if (end <= start) { run = null; return; }
    if (run) run.end = end;
    else { run = { start, end }; result.push(run); }
  });
  return result;
}
