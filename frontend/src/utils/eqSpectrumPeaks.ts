import type { AnalyzerFrame } from "./eqAnalyzerHistory";
export type SpectrumPeak = { frequency: number; db: number };
export type SpectrumGrabFrame = { frequencies: number[]; db: number[]; peaks: Array<SpectrumPeak & { q: number }>; source: "Input" | "Output" | "External key" };
export type SpectrumGrabBand = { frequency: number; gain: number; q: number };

export function captureSpectrumGrab(frame: AnalyzerFrame, output: boolean | "external"): SpectrumGrabFrame | null {
  const frequencies = frame.frequencies ?? [], db = (output === "external" ? frame.spectrumExternalDb : output ? frame.spectrumPostDb : frame.spectrumPreDb) ?? [];
  if (!frame.spectrumReady || frequencies.length < 5 || db.length !== frequencies.length
    || frequencies.some((f, i) => !Number.isFinite(f) || f <= 0 || (i > 0 && f <= frequencies[i - 1])) || db.some(v => !Number.isFinite(v))) return null;
  const peaks = captureSpectrumPeaks({ frequencies, spectrumPreDb: db, spectrumReady: true }).map(peak => {
    const centre = frequencies.indexOf(peak.frequency), threshold = peak.db - 3;
    const crossing = (direction: number) => {
      let inner = centre, outer = centre + direction;
      while (outer >= 0 && outer < db.length && db[outer] > threshold) { inner = outer; outer += direction; }
      if (outer < 0 || outer >= db.length) return null;
      const proportion = (threshold - db[inner]) / (db[outer] - db[inner]);
      return Math.exp(Math.log(frequencies[inner]) + proportion * Math.log(frequencies[outer] / frequencies[inner]));
    };
    const low = crossing(-1), high = crossing(1);
    return { ...peak, q: low !== null && high !== null && high > low ? Math.max(.35, Math.min(30, peak.frequency / (high - low))) : 1 };
  });
  return { frequencies: [...frequencies], db: [...db], peaks, source: output === "external" ? "External key" : output ? "Output" : "Input" };
}

export function moveSpectrumGrabBand(start: SpectrumGrabBand, octaves: number, gainDelta: number, minimum = 20, maximum = 20000): SpectrumGrabBand {
  return { ...start, frequency: Math.max(minimum, Math.min(maximum, start.frequency * 2 ** octaves)), gain: Math.max(-24, Math.min(24, start.gain + gainDelta)) };
}

// Candidates from the native display grid, not sub-bin pitch/resonance estimates.
export function captureSpectrumPeaks(frame: AnalyzerFrame): SpectrumPeak[] {
  const hz = frame.frequencies ?? [], db = frame.spectrumPreDb ?? [];
  if (!frame.spectrumReady || hz.length < 5 || db.length !== hz.length
    || hz.some((f, i) => !Number.isFinite(f) || f <= 0 || (i > 0 && f <= hz[i - 1]))) return [];
  const candidates: SpectrumPeak[] = [];
  for (let i = 2; i < hz.length - 2; ++i) {
    const level = db[i];
    if (hz[i] < 20 || hz[i] > 20000 || !db.slice(i - 2, i + 3).every(Number.isFinite)
      || level < -90 || level < db[i - 1] || level <= db[i + 1]
      || level - Math.min(db[i - 2], db[i - 1], db[i + 1], db[i + 2]) < 3) continue;
    candidates.push({ frequency: hz[i], db: level });
  }
  const peaks: SpectrumPeak[] = [];
  for (const peak of candidates.sort((a, b) => b.db - a.db || a.frequency - b.frequency)) {
    if (peaks.every(other => Math.abs(Math.log2(peak.frequency / other.frequency)) >= 1 / 6)) peaks.push(peak);
    if (peaks.length === 6) break;
  }
  return peaks;
}
