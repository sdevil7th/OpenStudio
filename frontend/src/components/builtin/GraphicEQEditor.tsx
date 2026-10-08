import { editorButton, editorSelect, editorTab } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { nativeBridge, type BuiltInParamDescriptor } from "../../services/NativeBridge";
import { EQToolbar, type EQToolbarProps } from "./EQToolbar";
import { SuiteParameter, type ParameterChange } from "./SuiteParameter";
import "./GraphicEQEditor.css";
import { useStableMeterSnapshot } from "./useStableMeterSnapshot";
import { ProfiledRangeInput } from "../ui/ProfiledRangeInput";

type Props = EQToolbarProps & { onChange: ParameterChange; onGestureStart: (id: string) => void; onGestureEnd: () => void };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const label = (hz: string) => { const n = Number.parseFloat(hz) * (/kHz/i.test(hz) ? 1000 : 1); return n >= 1000 ? `${Number((n / 1000).toFixed(2))}k` : String(n); };

function GainValue({ band, onChange }: { band: BuiltInParamDescriptor; onChange: ParameterChange }) {
  const [draft, setDraft] = useState(String(Number(band.value.toFixed(2))));
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(Number(band.value.toFixed(2)))); }, [band.value]);
  const commit = () => {
    editing.current = false;
    if (!cancelled.current && draft.trim() && Number.isFinite(Number(draft))) { const next = clamp(Number(draft), band.min, band.max); setDraft(String(next)); if (next !== band.value) onChange(band, next); }
    else setDraft(String(Number(band.value.toFixed(2))));
    cancelled.current = false;
  };
  return <input className="graphic-eq-value" aria-label={`${band.label} value`} type="number" min="-12" max="12" step=".1" value={draft}
    onFocus={() => { editing.current = true; cancelled.current = false; }} onChange={e => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } else if (e.key === "Escape") { cancelled.current = true; editing.current = false; setDraft(String(Number(band.value.toFixed(2)))); e.stopPropagation(); e.currentTarget.blur(); } }} />;
}

// Spectrum snapshots update only this plot, not faders or their gesture callbacks.
function GraphicEQResponse({ schema, address, analyzer }: Pick<Props, "schema" | "address"> & { analyzer: string }) {
  const [meters, setMeters] = useStableMeterSnapshot();
  const responseRef = useRef<SVGSVGElement>(null);
  const [responseSize, setResponseSize] = useState({ width: 700, height: 176 });
  useEffect(() => {
    const svg = responseRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setResponseSize({ width, height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const visualization = { ...schema.visualization, ...meters };
  useEffect(() => {
    let retired = false, pending = false;
    const timer = window.setInterval(() => {
      if (pending || document.hidden) return;
      pending = true;
      void nativeBridge.getBuiltInPluginMeters(address).then(next => { if (!retired) setMeters(next); }).catch(() => { if (!retired) setMeters(null); }).finally(() => { pending = false; });
    }, 100);
    return () => { retired = true; window.clearInterval(timer); };
  }, [address.chain, address.trackId, address.fxIndex, address.instanceId]);
  const plotRight = responseSize.width - 34, plotBottom = Math.max(32, responseSize.height - 22);
  const midY = (12 + plotBottom) / 2, halfY = (plotBottom - 12) / 2;
  const x = (hz: number) => 34 + Math.log(Math.max(20, hz) / 20) / Math.log(1000) * (plotRight - 34);
  const curve = (data: number[] | undefined, spectrum = false) => (data ?? []).map((db, i) => `${x(visualization.frequencies?.[i] ?? 20)},${spectrum ? 12 + clamp(-db / 120, 0, 1) * (plotBottom - 12) : midY - clamp(db, -24, 24) / 24 * halfY}`).join(" ");
  return (<div className="graphic-eq-response min-h-0 flex-1 p-[11px_12px_0]">
      <div className="flex justify-between gap-2 text-[10px] text-daw-text-muted"><span>Selected target response (dB)</span><span>{Math.round(visualization.sampleRate ?? 44100)} Hz | Spectrum dBFS</span></div>
      <svg ref={responseRef} viewBox={`0 0 ${responseSize.width} ${responseSize.height}`} role="img" aria-label="Graphic EQ frequency response">
        {[-24, -12, 0, 12, 24].map(db => <g key={db}><line className="gridline" x1="34" x2={plotRight} y1={midY-db/24*halfY} y2={midY-db/24*halfY} /><text x="28" y={midY+3-db/24*halfY} textAnchor="end">{db}</text></g>)}
        {[20, 100, 1000, 10000, 20000].map(hz => <g key={hz}><line className="gridline" x1={x(hz)} x2={x(hz)} y1="12" y2={plotBottom} /><text x={x(hz)} y={plotBottom + 16} textAnchor="middle">{label(String(hz))}</text></g>)}
        <text x={plotRight + 6} y="15">0</text><text x={plotRight + 6} y={midY + 3}>-60</text><text x={plotRight + 6} y={plotBottom}>-120</text>
        {visualization.spectrumReady && ["pre", "both"].includes(analyzer) && <polyline className="spectrum-pre" points={curve(visualization.spectrumPreDb, true)} />}
        {visualization.spectrumReady && ["post", "both"].includes(analyzer) && <polyline className="spectrum-post" points={curve(visualization.spectrumPostDb, true)} />}
        <polyline className="response" points={curve(visualization.responseDb)} />
      </svg>
    </div>);
}

export function GraphicEQEditor(props: Props) {
  const { schema, address, onChange } = props;
  const [page, setPage] = useState(0), [range, setRange] = useState(12), [selected, setSelected] = useState<string[]>([]);
  const [analyzer, setAnalyzer] = useState("both"), [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const gesture = useRef<{ id: string; values: Record<string, number> } | null>(null);
  const p = (id: string) => schema.parameters.find(p => p.id === id);
  const value = (id: string) => p(id)?.value ?? 0;
  const third = value("graphicMode") >= .5;
  const bands = schema.parameters.filter(p => third ? /^third\d+$/.test(p.id) : /^geq\d+$/.test(p.id));
  const displayRange = Math.max(range, bands.some(p => Math.abs(p.value) > 6) ? 12 : 6);
  const activeSelection = selected.filter(id => bands.some(p => p.id === id));
  const apply = async (values: Record<string, number>) => {
    if (busy) return; setBusy(true); setError("");
    try { if (!await props.onApplyValues(values)) setError("The processor did not accept this change."); }
    catch (e) { setError(e instanceof Error ? e.message : "Change failed"); }
    finally { setBusy(false); }
  };
  const parameter = (id: string) => { const descriptor = p(id); return descriptor && <SuiteParameter layout={id === "graphicTarget" ? "horizontal" : "vertical"} parameter={descriptor} onChange={onChange} onGestureStart={props.onGestureStart} onGestureEnd={props.onGestureEnd} />; };
  return <div className="approved-effect-editor graphic-eq-editor flex min-h-0 min-w-0 flex-1 flex-col text-daw-text" data-mode={third ? 31 : 10} data-page={page}>
    <EQToolbar {...props} />
    {error && <div role="alert" className="px-4 text-xs text-daw-record">{error}</div>}
    <div className="graphic-eq-heading flex flex-wrap items-end justify-between gap-3 p-[15px_22px_10px]">
      <div className="graphic-eq-modes flex gap-[2px] p-[2px]" role="group" aria-label="Bands">{["10 octave", "31 third-octave"].map((name, index) => <button type="button" className={editorButton} key={name} aria-pressed={third === (index === 1)} onClick={() => { const mode = p("graphicMode"); if (mode) onChange(mode, index); setPage(0); setSelected([]); }}>{name}</button>)}</div>
      {parameter("graphicTarget")}
      <label className="flex flex-row items-center gap-2 text-xs">Range<select className={editorSelect} aria-label="Gain display range" value={displayRange} onChange={e => setRange(Number(e.target.value))}><option value="6">+/-6 dB</option><option value="12">+/-12 dB</option></select></label>
      <label className="flex flex-row items-center gap-2 text-xs">Analyzer<select className={editorSelect} aria-label="Analyzer" value={analyzer} onChange={e => setAnalyzer(e.target.value)}><option value="off">Off</option><option value="pre">Input</option><option value="post">Output</option><option value="both">Pre + post</option></select></label>
    </div>
    <GraphicEQResponse schema={schema} address={address} analyzer={analyzer} />
    {third && <div role="tablist" aria-label="Frequency bands" className="graphic-eq-pages flex shrink-0 gap-2 px-4 pt-1">{["Low: 20-160 Hz", "Mid: 200 Hz-2 kHz", "High: 2.5-20 kHz"].map((name, index) => <button key={name} className={editorTab} role="tab" id={`graphic-page-${index}`} aria-controls="graphic-band-panel" tabIndex={page === index ? 0 : -1} aria-selected={page === index} onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); const next = e.key === "Home" ? 0 : e.key === "End" ? 2 : (index + (e.key === "ArrowRight" ? 1 : 2)) % 3; setPage(next); document.getElementById(`graphic-page-${next}`)?.focus(); } }} onClick={() => setPage(index)}>{name}</button>)}</div>}
    <div className="graphic-eq-bands flex min-h-0 flex-1 justify-between gap-[4px] p-[0_22px_10px]" id="graphic-band-panel" role={third ? "tabpanel" : "group"} aria-labelledby={third ? `graphic-page-${page}` : undefined} aria-label={third ? undefined : "Graphic equalizer bands"}>
      {bands.map((band, index) => <div key={band.id} data-param={band.id} data-page={index < 10 ? 0 : index < 21 ? 1 : 2} className="graphic-eq-band flex min-w-0 flex-1 flex-col items-center gap-[7px] pt-[3px]">
        <GainValue band={band} onChange={onChange} />
        <ProfiledRangeInput className="graphic-eq-fader min-h-0 flex-1" aria-label={band.label} min={-displayRange} max={displayRange} step={.1} value={band.value}
          onBeginEdit={() => { const group = activeSelection.includes(band.id) ? bands.filter(p => activeSelection.includes(p.id)) : [band]; gesture.current = { id: band.id, values: Object.fromEntries(group.map(p => [p.id, p.value])) }; props.onGestureStart(band.id); }}
          onCommitEdit={() => { gesture.current = null; props.onGestureEnd(); }}
          onDoubleClick={() => { props.onGestureStart(band.id); onChange(band, band.defaultValue); props.onGestureEnd(); }}
          onValueChange={next => { const start = gesture.current; if (start?.id === band.id) { const delta = next - start.values[band.id]; for (const [id, before] of Object.entries(start.values)) { const parameter = p(id); if (parameter) onChange(parameter, clamp(before + delta, -displayRange, displayRange)); } } else onChange(band, next); }} />
        <button className={`${editorButton} w-full`} aria-label={`Select ${band.label}`} aria-pressed={selected.includes(band.id)} onClick={() => setSelected(old => old.includes(band.id) ? old.filter(id => id !== band.id) : [...old, band.id])}>{label(band.label)}</button>
      </div>)}
    </div>
    <div className="graphic-eq-group flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs p-[9px_12px]" inert={busy}>
      <span>{activeSelection.length} selected</span><button className={editorButton} onClick={() => setSelected(activeSelection.length === bands.length ? [] : bands.map(p => p.id))}>{activeSelection.length === bands.length ? "Clear selection" : "Select all"}</button>
      <label className="flex items-center gap-2">Offset<input className="graphic-eq-offset" aria-label="Group offset" type="number" min="-24" max="24" step=".1" value={offset} onChange={e => setOffset(Number(e.target.value))} />dB</label>
      <button className={editorButton} disabled={!activeSelection.length || !Number.isFinite(offset)} onClick={() => void apply(Object.fromEntries(bands.filter(p => activeSelection.includes(p.id)).map(p => [p.id, clamp(p.value + offset, -displayRange, displayRange)])))}>Apply offset</button>
      <button className={editorButton} onClick={() => void apply(Object.fromEntries(bands.map(p => [p.id, 0])))}>Flat bank</button>
    </div>
    <div className="graphic-eq-footer flex shrink-0 flex-wrap items-center justify-evenly gap-3 border-t border-daw-border-light p-[12px_4px]">
      <div className="flex items-center gap-3">{parameter("graphicHPEnabled")}{value("graphicHPEnabled") >= .5 && parameter("graphicHP")}</div>
      <div className="flex items-center gap-3">{parameter("graphicLPEnabled")}{value("graphicLPEnabled") >= .5 && parameter("graphicLP")}</div>
      {parameter("outputGain")}
    </div>
  </div>;
}
