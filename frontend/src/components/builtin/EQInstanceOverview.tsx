import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";

type Row = { address: BuiltInPluginAddress; name: string; current: boolean };
type Visualization = NonNullable<BuiltInPluginSchema["visualization"]>;
function MiniGraph({ row, paused, spectrum, range, revision, onSelect }: {
  row: Row; paused: boolean; spectrum: boolean; range: number; revision: number; onSelect: (address: BuiltInPluginAddress) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Visualization | null>(null);
  const [error, setError] = useState("");
  const addressKey = JSON.stringify(row.address);
  useEffect(() => {
    const address = JSON.parse(addressKey) as BuiltInPluginAddress;
    let retired = false, pending = false, visible = true;
    const refresh = async () => {
      if (retired || pending || paused || !visible || document.hidden) return;
      pending = true;
      try {
        const next = await nativeBridge.getBuiltInPluginMeters(address);
        if (!retired) { setData(next ?? null); setError(next?.responseDb?.length ? "" : "Response unavailable. Refresh the instance list if this EQ was removed."); }
      } catch { if (!retired) { setData(null); setError("Instance unavailable. Refresh to check its location."); } }
      finally { pending = false; }
    };
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; if (visible) void refresh(); });
    if (container.current) observer.observe(container.current);
    void refresh(); const timer = window.setInterval(() => void refresh(), 700);
    return () => { retired = true; window.clearInterval(timer); observer.disconnect(); };
  }, [addressKey, paused, revision]);
  const x = (frequency: number) => 34 + Math.log(Math.max(10, Math.min(30000, frequency)) / 10) / Math.log(3000) * 348;
  const responseY = (db: number) => 72 - Math.max(-range, Math.min(range, db)) / range * 54;
  const spectrumY = (db: number) => 126 - (Math.max(-100, Math.min(0, db)) + 100) / 100 * 108;
  const curve = (values: number[] | undefined, y: (value: number) => number) => (data?.frequencies ?? []).flatMap((frequency, index) => {
    const value = values?.[index]; return Number.isFinite(frequency) && typeof value === "number" && Number.isFinite(value) ? [`${x(frequency)},${y(value)}`] : [];
  }).join(" ");
  return <div ref={container} className="flex min-w-0 flex-col gap-2 rounded border border-daw-border-light p-2" aria-label={`EQ graph ${row.name}`}>
    <div className="flex min-w-0 items-center justify-between gap-2"><strong className="min-w-0 truncate" title={row.name}>{row.name}{row.current ? " · Current" : ""}</strong><button className={`${editorButton} shrink-0`} aria-label={`Edit graph ${row.name}`} onClick={() => onSelect(row.address)}>Edit</button></div>
    <svg className="h-40 w-full rounded bg-daw-dark" viewBox="0 0 400 150" preserveAspectRatio="none" role="img" aria-label={`${row.name} response and spectra`}>
      <title>{row.name}: response ±{range} dB. Spectra use a separate -100 to 0 dBFS scale.</title>
      {[100, 1000, 10000].map(frequency => <g key={frequency}><line x1={x(frequency)} x2={x(frequency)} y1={18} y2={126} stroke="var(--color-daw-border-light)" /><text x={x(frequency)} y={144} textAnchor="middle" fontSize={10} fill="var(--color-daw-text-muted)">{frequency < 1000 ? frequency : `${frequency / 1000}k`}</text></g>)}
      {[range, 0, -range].map(db => <g key={db}><line x1={34} x2={382} y1={responseY(db)} y2={responseY(db)} stroke="var(--color-daw-border-light)" /><text x={28} y={responseY(db) + 3} textAnchor="end" fontSize={10} fill="var(--color-daw-text-muted)">{db > 0 ? "+" : ""}{db}</text></g>)}
      {spectrum && data?.spectrumReady && <><polyline points={curve(data.spectrumPreDb, spectrumY)} fill="none" stroke="var(--color-daw-text-muted)" strokeWidth={1} opacity={.65} /><polyline points={curve(data.spectrumPostDb, spectrumY)} fill="none" stroke="var(--color-daw-solo)" strokeWidth={1} opacity={.65} /></>}
      {!error && <polyline points={curve(data?.responseDb, responseY)} fill="none" stroke="var(--color-daw-accent)" strokeWidth={2} />}
    </svg>
    <p className="text-[10px] text-daw-text-muted" role={error ? "status" : undefined}>{error || (paused ? "Paused snapshot" : !data ? "Loading response…" : `${Math.round(data.latencySamples ?? 0)} samples latency${data.phaseUpdating ? " · Preparing response…" : ""}${spectrum && !data.spectrumReady ? " · No spectrum yet" : ""}`)}</p>
  </div>;
}

export function EQInstanceOverview({ rows, revision, onSelect }: { rows: Row[]; revision: number; onSelect: (address: BuiltInPluginAddress) => void }) {
  const [page, setPage] = useState(0), [paused, setPaused] = useState(false), [spectrum, setSpectrum] = useState(true), [range, setRange] = useState(24);
  const pages = Math.max(1, Math.ceil(rows.length / 6)), currentPage = Math.min(page, pages - 1);
  return <div className="flex min-w-0 flex-col gap-3" aria-label="EQ graph overview">
    <div className="flex flex-wrap items-center gap-2"><button className={editorButton} aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Resume graphs" : "Pause graphs"}</button><button className={editorButton} aria-pressed={spectrum} onClick={() => setSpectrum(!spectrum)}>Spectra</button><label className="flex items-center gap-1">Range<select className={editorSelect} aria-label="Overview gain range" value={range} onChange={event => setRange(Number(event.target.value))}>{[12, 24, 48].map(value => <option key={value} value={value}>±{value} dB</option>)}</select></label><button className={editorButton} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous graphs</button><span>{currentPage + 1} / {pages}</span><button className={editorButton} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next graphs</button></div>
    <div className="@container max-h-[48vh] min-h-24 overflow-y-auto"><div className="grid grid-cols-1 gap-2 @[620px]:grid-cols-2">{rows.slice(currentPage * 6, currentPage * 6 + 6).map(row => <MiniGraph key={row.address.instanceId} row={row} paused={paused} spectrum={spectrum} range={range} revision={revision} onSelect={onSelect} />)}</div>{!rows.length && <p role="status">No matching EQ instances</p>}</div>
    <p className="text-[10px] text-daw-text-muted">Blue: EQ response. Grey: input spectrum. Yellow: output spectrum. Spectra use -100 to 0 dBFS independently of the response range. Up to six graphs per page; offscreen graphs pause. Edit opens that EQ with its own Undo history.</p>
  </div>;
}
