import { useState } from "react";
import type { BuiltInPluginSchema } from "../../services/NativeBridge";

type Estimate = NonNullable<BuiltInPluginSchema["impulseResponse"]>["decayEstimate"];
export function IRDecayView({ estimate: analysis }: { estimate?: Estimate }) {
  const [selected, setSelected] = useState(0);
  const options = analysis ? [analysis, ...(analysis.bands ?? []), ...(analysis.octaves ?? [])] : [];
  const estimate = options[selected] ?? analysis;
  const hz = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0)} kHz` : `${Math.round(value)} Hz`;
  const bandRange = estimate?.lowHz !== undefined && estimate?.highHz ? `${hz(estimate.lowHz)} to ${hz(estimate.highHz)}` : "All frequencies";
  const points = estimate?.curve ?? [];
  const start = estimate?.startSeconds ?? 0, end = estimate?.endSeconds ?? 1;
  const x = (seconds: number) => 50 + (seconds - start) / Math.max(.001, end - start) * 850;
  const y = (db: number) => 12 - Math.max(-80, Math.min(0, db)) * 2;
  return <div className="flex min-h-0 flex-col gap-2" aria-label="IR decay estimate">
    {options.length > 1 && <div className="flex items-center justify-between gap-2 text-[11px]"><label className="flex items-center gap-2">Band<select className="suite-select" aria-label="IR decay band" value={selected < options.length ? selected : 0} onChange={event => setSelected(Number(event.target.value))}>{options.map((item, index) => <option key={index} value={index}>{item.bandName ?? "Broadband"}</option>)}</select></label><span aria-label="IR decay band range" className="text-daw-text-muted">{bandRange}</span></div>}
    <svg className="min-h-8 max-h-20 w-full flex-1 rounded border border-daw-border-light bg-daw-dark" viewBox="0 0 960 210" preserveAspectRatio="none" role="img" aria-label="Applied IR backward energy decay">
      <title>Selected band sum of channel energies after Early end. The shaded area is the -5 to -25 dB fit interval.</title>
      {estimate && estimate.fitEndSeconds > estimate.fitStartSeconds && <rect x={x(estimate.fitStartSeconds)} y="12" width={x(estimate.fitEndSeconds) - x(estimate.fitStartSeconds)} height="160" fill="var(--color-daw-accent)" opacity=".12" />}
      {[0, -20, -40, -60, -80].map(db => <g key={db}><line x1="50" x2="900" y1={y(db)} y2={y(db)} stroke="var(--color-daw-border-light)" /><text x="5" y={y(db) + 6} fill="var(--color-daw-text-muted)" fontSize="17">{db}</text></g>)}
      {points.length > 0 && <polyline points={points.map(p => `${x(p.seconds)},${y(p.db)}`).join(" ")} fill="none" stroke="var(--color-daw-accent)" strokeWidth="2" />}
      <g fill="var(--color-daw-text-muted)" fontSize="17"><text x="50" y="199">{start.toFixed(2)} s</text><text x="900" y="199" textAnchor="end">{end.toFixed(2)} s</text></g>
    </svg>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span aria-label="Estimated IR RT60">{estimate?.available ? `Estimated RT60 ${estimate.rt60Seconds.toFixed(2)} s` : "RT60 unavailable"}</span><span className="text-daw-text-muted">{estimate?.available ? `T20 fit R² ${estimate.rSquared.toFixed(3)}` : estimate?.reason ?? "No applied decay analysis"}</span></div>
    {estimate?.filterMethod && <p className="text-[11px] text-daw-text-muted" title={estimate.filterMethod}>Butterworth octave band. Minimum reported decay: {estimate.minimumReliableRT60?.toFixed(2)} s.</p>}
    <p className="text-[11px] leading-relaxed text-daw-text-muted">Diagnostic T20 after Early end, before wet EQ/outer controls. Low/Mid/High follow Damping splits; octaves use separate filters. Noise and filter ringing can bias results. Not a certified room measurement.</p>
  </div>;
}
