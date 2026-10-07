import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema, type ReverbResponseResult } from "../../services/NativeBridge";

const db = (value: number) => 20 * Math.log10(Math.max(1e-6, value));
const level = (value?: number) => value === undefined ? "Unavailable" : value === 0 ? "Silent" : `${db(value).toFixed(1)} dBFS`;

export function ReverbResponsePanel({ schema, address }: { schema: BuiltInPluginSchema; address: BuiltInPluginAddress }) {
  const [seconds, setSeconds] = useState(5);
  const [input, setInput] = useState(2);
  const [result, setResult] = useState<ReverbResponseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ stage: 0, value: 0 });
  const current = useRef("");
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 600, height: 165 });
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(180, entry.contentRect.width), height: Math.max(64, entry.contentRect.height) }));
    observer.observe(svg.current); return () => observer.disconnect();
  }, []);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const snapshot = JSON.stringify([address.instanceId, address.trackId, address.chain, schema.parameters.map(p => [p.id, p.value]), schema.modelState, schema.visualization?.sampleRate, schema.visualization?.tempoBpm]);
  const stop = () => {
    const id = current.current;
    current.current = "";
    clearInterval(timer.current);
    if (id) void nativeBridge.reverbResponse("release", id).catch(() => {});
  };
  useEffect(() => {
    stop(); setBusy(false); setResult(null); setError("");
    return stop;
    // Changes invalidate the graph and cancel its worker. Meter-only polls do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, seconds, input]);
  const render = async () => {
    stop(); const id = crypto.randomUUID(); current.current = id;
    setBusy(true); setResult(null); setError(""); setProgress({ stage: 0, value: 0 });
    let polling = false;
    timer.current = setInterval(() => {
      if (polling) return;
      polling = true;
      void nativeBridge.reverbResponse("status", id).then(status => {
        if (current.current !== id) return;
        if (status.success) setProgress({ stage: status.stage ?? 0, value: status.progress ?? 0 });
      }).catch(() => {}).finally(() => { polling = false; });
    }, 1000);
    try {
      const response = await nativeBridge.reverbResponse("render", id, { address, seconds, input });
      if (current.current !== id) return;
      if (!response.success) throw new Error(response.error || "Response rendering failed");
      if (!response.peak || !response.rms || response.peak.length !== 2 || response.rms.length !== 2
        || [...response.peak, ...response.rms].some(values => values.length !== 640 || values.some(value => !Number.isFinite(value) || value < 0)))
        throw new Error("The response data was incomplete");
      setResult(response);
    } catch (reason) {
      if (current.current === id) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current.current === id) { stop(); setBusy(false); }
    }
  };
  const right = size.width - 8, bottom = size.height - 20;
  const y = (value: number) => 10 - value / 120 * (bottom - 10);
  const path = (values: number[]) => values.map((value, i) => `${i ? "L" : "M"}${34 + i / Math.max(1, values.length - 1) * (right - 34)},${y(Math.max(-120, Math.min(0, db(value))))}`).join(" ");
  return <section aria-label="Rendered reverb response" className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-2">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1">Window<select className={editorSelect} aria-label="Response window" value={seconds} disabled={busy} onChange={event => setSeconds(Number(event.target.value))}>{[2, 5, 10].map(value => <option key={value} value={value}>{value} s</option>)}</select></label>
      <label className="flex items-center gap-1">Impulse<select className={editorSelect} aria-label="Response input" value={input} disabled={busy} onChange={event => setInput(Number(event.target.value))}>{["Left", "Right", "Both"].map((name, i) => <option key={name} value={i}>{name}</option>)}</select></label>
      <button type="button" className={editorButton} disabled={busy} onClick={() => void render()}>Render response</button>
      {busy && <button type="button" className={editorButton} onClick={() => { stop(); setBusy(false); setError("Response cancelled"); }}>Cancel response</button>}
    </div>
    {busy && <div role="status" className="flex items-center gap-2 text-xs"><span>{progress.stage < 2 ? "Preparing copy" : `Rendering ${Math.round(progress.value * 100)}%`}</span><progress className="min-w-0 flex-1" aria-label="Response progress" value={progress.value} max={1} /></div>}
    {error && <p role="alert" className="text-xs text-daw-record">{error}</p>}
    <svg ref={svg} className="suite-reverb-envelope min-h-16 w-full flex-1" preserveAspectRatio="none" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="Rendered stereo wet response in dBFS">
      <title>Actual peak envelopes and RMS from a fresh wet-only copy. Left is blue, right is green. Solid peak; dashed RMS. Values below -120 dBFS are clipped in this graph.</title>
      {[0, -30, -60, -90, -120].map(value => <g key={value}><line className="gridline" x1="34" x2={right} y1={y(value)} y2={y(value)} /><text x="28" y={y(value) + 3} textAnchor="end">{value}</text></g>)}
      {result?.peak?.map((values, ch) => <path key={`p${ch}`} d={path(values)} fill="none" stroke={ch ? "#8ac878" : "#66b5e5"} strokeWidth="1.5" />)}
      {result?.rms?.map((values, ch) => <path key={`r${ch}`} d={path(values)} fill="none" stroke={ch ? "#8ac878" : "#66b5e5"} strokeWidth="1" strokeDasharray="4 3" opacity=".6" />)}
      {!result && <text x={size.width / 2} y={size.height / 2} textAnchor="middle">{busy ? "Rendering isolated copy..." : "Render to inspect the current settings"}</text>}
      <text x="34" y={size.height - 3}>0 s</text><text x={right} y={size.height - 3} textAnchor="end">{result?.seconds ?? seconds} s</text>
    </svg>
    {result && <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" aria-label="Response measurements"><span className="text-sky-300">L {level(result.maximum?.[0])}</span><span className="text-lime-300">R {level(result.maximum?.[1])}</span><span>{result.sampleRate} Hz / {result.tempoBpm?.toFixed(1)} BPM</span><span>Solid peak / dashed RMS</span></div>}
    <p className="text-[10px] leading-relaxed text-daw-text-muted">Fresh wet-only copy, -12 dBFS impulse per selected input, 100 ms silent warm-up. Playback stays unchanged. This finite, level-dependent response is not a measured room IR or an RT60 measurement.{result && !result.nonzero ? " No output within this window; check Hold, predelay or a longer window." : result?.tailBeyondWindow ? " The nominal tail extends beyond this window." : ""}</p>
  </section>;
}
