import { editorButton } from "./PluginEditorControls";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";
import "./LoudnessPanel.css";

type Point = { time: number; output: number; reduction: number };
export function LoudnessPanel({ meters, address, threshold, receivedAt }: { meters: BuiltInPluginSchema["visualization"]; address: BuiltInPluginAddress; threshold: ReactNode; receivedAt: number }) {
  const [history, setHistory] = useState<Point[]>([]);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const nextSample = useRef(0);
  useEffect(() => {
    if (receivedAt <= 0 || !Number.isFinite(meters?.outputLevelDb) || !Number.isFinite(meters?.gainReductionDb) || receivedAt < nextSample.current) return; nextSample.current = receivedAt + 95;
    setNow(receivedAt);
    setHistory(points => [...points.filter(point => receivedAt - point.time < 30000).slice(-299), { time: receivedAt, output: meters!.outputLevelDb!, reduction: Math.abs(meters!.gainReductionDb!) }]);
  }, [meters, receivedAt]);
  useEffect(() => {
    const expire = () => { const time = performance.now(); setNow(time); setHistory(points => points.filter(point => time - point.time < 30000)); };
    const visibility = () => { if (document.hidden) setHistory([]); else expire(); };
    const timer = window.setInterval(expire, 250);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const command = async (id: string, value: number) => {
    if (busy) return; setBusy(true); setError("");
    try { if (!await nativeBridge.setBuiltInPluginParam(address, id, value)) throw new Error("The meter did not accept the change."); if (id === "meterReset") setHistory([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Meter change failed."); }
    finally { setBusy(false); }
  };
  const number = (value: number | undefined, ready = true) => ready && Number.isFinite(value) && value! > -99 ? value!.toFixed(1) : "--";
  const available = typeof meters?.meterRunning === "boolean";
  const running = meters?.meterRunning === true;
  const points = (reduction: boolean) => history.map(point => `${Math.max(0, Math.min(1, 1 - (now - point.time) / 30000)) * 588},${reduction ? Math.min(24, point.reduction) / 24 * 102 : 102 - Math.max(0, Math.min(1, (point.output + 60) / 60)) * 102}`).join(" ");
  return <div className="loudness-panel flex min-h-0 flex-1 flex-col gap-3 px-5 py-3">
    <div className="flex shrink-0 items-center justify-evenly gap-4">
      {threshold}
      <div className="text-center"><span className="text-[10px] uppercase tracking-wider text-daw-text-muted">Integrated</span><div className="text-3xl font-light tabular-nums" aria-label="Integrated loudness">{number(meters?.integratedLUFS, meters?.integratedReady)}<small className="ml-1 text-[10px]">LUFS</small></div><span className="text-[10px] text-daw-text-muted">{Number.isFinite(meters?.measurementSeconds) ? meters!.measurementSeconds!.toFixed(1) : "--"} s measured</span></div>
      <div className="text-center"><span className="text-[10px] uppercase tracking-wider text-daw-text-muted">Loudness range</span><div className="text-3xl font-light tabular-nums" aria-label="Loudness range">{number(meters?.loudnessRangeLU, meters?.loudnessRangeReady)}<small className="ml-1 text-[10px]">LU</small></div><span className="text-[10px] text-daw-text-muted">{!available ? "Waiting for measurement" : meters?.loudnessRangeProvisional !== false ? "Provisional: first 60 s" : "60 s measured"}</span></div>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-[10px] text-daw-text-muted"><span>GR {Number.isFinite(meters?.gainReductionDb) ? Math.abs(meters!.gainReductionDb!).toFixed(1) : "--"} dB</span><span>Max M {number(meters?.maximumMomentaryLUFS)} / S {number(meters?.maximumShortTermLUFS)} LUFS</span></div>
    <div className="flex min-h-16 flex-1 gap-2 py-2 text-[10px] tabular-nums text-daw-text-muted" role="img" aria-label="Recent output and gain reduction history">
      <div className="flex w-6 shrink-0 flex-col justify-between text-right" aria-hidden="true">{[0, -20, -40, -60].map(db => <span key={db}>{db}</span>)}</div>
      <svg className="loudness-history min-w-0 flex-1" viewBox="0 0 588 102" preserveAspectRatio="none" aria-hidden="true">
        {[0, 1, 2, 3].map(i => <line key={i} x1="0" x2="588" y1={i * 34} y2={i * 34} />)}
        <polyline className="output" points={points(false)} /><polyline className="reduction" points={points(true)} />
      </svg>
      <div className="flex w-5 shrink-0 flex-col justify-between" aria-hidden="true">{[0, 8, 16, 24].map(db => <span key={db}>{db}</span>)}</div>
    </div>
    <div className="flex shrink-0 justify-between px-8 text-[10px] text-daw-text-muted"><span>Output dBFS</span><span>Reduction dB</span></div>
    <div className="flex shrink-0 items-center justify-between gap-2 text-xs"><span role="status">{!available ? "Metering unavailable" : running ? "Measuring" : "Measurement paused"}</span><div className="flex gap-2"><button className={editorButton} disabled={busy || !available} onClick={() => void command("meterRunning", running ? 0 : 1)}>{running ? "Pause measurement" : "Resume measurement"}</button><button className={editorButton} disabled={busy || !available} onClick={() => void command("meterReset", 1)}>Reset meters</button></div></div>
    {error && <p role="alert" className="text-xs text-daw-record">{error}</p>}
  </div>;
}
