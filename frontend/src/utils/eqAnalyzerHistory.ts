export type AnalyzerSettings = { range: number; release: number; tilt: number; hold: boolean; paused: boolean };
export const defaultAnalyzerSettings: AnalyzerSettings = { range: 90, release: 0, tilt: 0, hold: false, paused: false };
export type AnalyzerFrame = { frequencies?: number[]; spectrumPreDb?: number[]; spectrumPostDb?: number[]; spectrumExternalDb?: number[]; spectrumReady?: boolean };
export type AnalyzerSnapshot = { frequencies: number[]; pre: number[]; post: number[]; external?: number[]; ready: boolean };
const empty = (): AnalyzerSnapshot => ({ frequencies: [], pre: [], post: [], ready: false });
const safeDb = (value: number) => Number.isFinite(value) ? Math.max(-160, Math.min(48, value)) : -160;

export class EQAnalyzerHistory {
  private snapshot = empty();
  private time: number | null = null;
  reset() { this.snapshot = empty(); this.time = null; }
  update(frame: AnalyzerFrame, settings: AnalyzerSettings, now: number): AnalyzerSnapshot {
    const frequencies = frame.frequencies ?? [];
    const valid = frequencies.length > 1 && frequencies.every((hz, i) => Number.isFinite(hz) && hz > 0 && (i === 0 || hz > frequencies[i - 1]));
    const changed = frequencies.length !== this.snapshot.frequencies.length || frequencies.some((hz, i) => hz !== this.snapshot.frequencies[i]);
    if (!valid) { this.reset(); return empty(); }
    if (changed) this.reset();
    const elapsed = this.time === null || !Number.isFinite(now) ? 0 : Math.max(0, (now - this.time) / 1000);
    this.time = Number.isFinite(now) ? now : null;
    if (settings.paused && this.snapshot.ready) return this.snapshot;
    if (!frame.spectrumReady || frame.spectrumPreDb?.length !== frequencies.length || frame.spectrumPostDb?.length !== frequencies.length) {
      this.snapshot = { ...empty(), frequencies: [...frequencies] }; return this.snapshot;
    }
    const follow = (input: number[], previous: number[]) => input.map((raw, i) => {
      const db = safeDb(raw), old = previous[i];
      if (old === undefined) return db;
      if (settings.hold) return Math.max(old, db);
      return settings.release > 0 ? Math.max(db, old - settings.release * elapsed) : db;
    });
    this.snapshot = { frequencies: [...frequencies], pre: follow(frame.spectrumPreDb, this.snapshot.pre), post: follow(frame.spectrumPostDb, this.snapshot.post),
      ...(frame.spectrumExternalDb?.length === frequencies.length ? { external: follow(frame.spectrumExternalDb, this.snapshot.external ?? []) } : {}), ready: true };
    return this.snapshot;
  }
}

// Map display-only spectrum dB into the graph's unchanged -30..30 gain axis.
export function analyzerPosition(db: number, hz: number, settings: Pick<AnalyzerSettings, "range" | "tilt">) {
  const range = [60, 90, 120].includes(settings.range) ? settings.range : 90;
  const tilt = Number.isFinite(settings.tilt) ? settings.tilt : 0;
  const compensated = safeDb(db) + (Number.isFinite(hz) && hz > 0 ? tilt * Math.log2(hz / 1000) : 0);
  return Math.max(-30, Math.min(30, (compensated + range) / range * 60 - 30));
}
