import { useEffect, useRef, useState } from "react";
import type { BuiltInPluginSchema } from "../../services/NativeBridge";
import { useEffectMeterSnapshot, useReceivedEffectMeters } from "./ApprovedEffectEditor";

export const levelText = (value: number | undefined, unit = "dBFS") => Number.isFinite(value) && value! > -100 ? `${value!.toFixed(1)} ${unit}` : "—";
export function EffectStat({ label, value, unit = "dBFS" }: { label: string; value?: number; unit?: string }) {
  return <div className="core-effect-stat"><span>{label}</span><strong>{Number.isFinite(value) && value! > -100 ? value!.toFixed(1) : "—"}<small>{unit}</small></strong></div>;
}

type Sample = { time: number; level?: number; reduction?: number };
/** History contains only samples received from the processor, never a decorative waveform. */
export function EffectLevelHistory({ meters, receivedAt, detector = false, threshold }: { meters: BuiltInPluginSchema["visualization"]; receivedAt: number; detector?: boolean; threshold?: number }) {
  const [history, setHistory] = useState<Sample[]>([]);
  const [now, setNow] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    const level = detector ? meters?.detectorLevelDb : meters?.outputLevelDb;
    const reduction = meters?.gainReductionDb;
    if (!Number.isFinite(level) && !Number.isFinite(reduction)) return;
    const time = receivedAt;
    if (time <= 0) return;
    if (time - last.current < 90) return;
    last.current = time;
    setNow(time);
    setHistory(old => [...old.filter(point => time - point.time < 4000).slice(-79), { time, level, reduction }]);
  }, [meters, receivedAt, detector]);
  useEffect(() => {
    const expire = () => { const time = performance.now(); setNow(time); setHistory(old => old.filter(point => time - point.time < 4000)); };
    const visibility = () => { if (document.hidden) setHistory([]); else expire(); };
    const timer = window.setInterval(expire, 250);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const end = now;
  const latest = history[history.length - 1];
  const x = (time: number) => 20 + Math.max(0, Math.min(1, 1 - (end - time) / 4000)) * 740;
  const y = (db: number) => 154 - Math.max(0, Math.min(1, (db + 80) / 80)) * 136;
  const path = (reduction: boolean) => history.map((point, index) => {
    const value = reduction ? point.reduction : point.level;
    if (!Number.isFinite(value)) return "";
    const previous = history[index - 1];
    return `${index && Number.isFinite(reduction ? previous?.reduction : previous?.level) ? "L" : "M"}${x(point.time)},${reduction ? 18 + Math.min(30, Math.abs(value!)) / 30 * 136 : y(value!)}`;
  }).join(" ");
  return <div className="core-effect-history flex min-h-0 flex-1 flex-col" role="img" aria-label={`${detector ? "Detector" : "Output"} level and gain reduction history from the processor`}>
    <div className="core-chart-heading flex items-center justify-between gap-3 p-[10px_13px] text-[10px] tracking-[1px]"><span>{detector ? "DETECTOR LEVEL" : "OUTPUT LEVEL"}</span><span>GAIN REDUCTION</span></div>
    <svg viewBox="0 0 780 170" preserveAspectRatio="none" className="min-h-0 w-full flex-1" aria-hidden="true">
      {[0, 1, 2, 3, 4].map(i => <line key={i} x1="20" x2="760" y1={18 + i * 34} y2={18 + i * 34} className="core-chart-grid" />)}
      {Number.isFinite(threshold) && <line x1="20" x2="760" y1={y(threshold!)} y2={y(threshold!)} className="core-chart-threshold" />}
      <path d={path(false)} className="core-chart-level" /><path d={path(true)} className="core-chart-reduction" />
      {Number.isFinite(latest?.level) && <circle cx={x(latest!.time)} cy={y(latest!.level!)} r="2.5" className="core-chart-level-point" />}
      {Number.isFinite(latest?.reduction) && <circle cx={x(latest!.time)} cy={18 + Math.min(30, Math.abs(latest!.reduction!)) / 30 * 136} r="2.5" className="core-chart-reduction-point" />}
      {!history.length && <text x="390" y="85" textAnchor="middle">Waiting for processor metering</text>}
    </svg>
    <div className="core-chart-caption flex justify-between gap-3 p-[3px_13px_8px] text-[10px]"><span>Recent received samples · 4 s window</span><span>{detector ? "dBFS" : "Output dBFS"} / reduction dB</span></div>
  </div>;
}

export function SignalLevelPanel({ meters, reference }: { meters: BuiltInPluginSchema["visualization"]; reference?: number }) {
  const entries: [string, number | undefined][] = [["INPUT", meters?.inputLevelDb], ...(reference === undefined ? [["DRIVEN", meters?.drivenLevelDb] as [string, number | undefined]] : []), ["OUTPUT", meters?.outputLevelDb]];
  return <section className="core-signal-levels flex min-w-0 flex-1 flex-col gap-4" aria-label="Processor signal levels">
    <div className="core-chart-heading flex justify-between gap-3 p-[10px_13px] text-[10px] tracking-[1px]"><span>SIGNAL LEVELS</span><span>LIVE PEAKS</span></div>
    <div className="flex flex-1 flex-col justify-center gap-5 px-4 pb-3">{entries.map(([name, level]) => <div key={name} className="core-signal-row grid items-center gap-3 text-[11px]"><span>{name}</span><meter aria-label={`${name.toLowerCase()} peak`} min={-80} max={12} value={Number.isFinite(level) ? level! : -80} /><output>{levelText(level)}</output></div>)}</div>
    {reference !== undefined && <p>Driven signal relative to saturation reference: {levelText(meters?.drivenReferenceDb, "dB")}. Reference {reference.toFixed(1)} dBFS.</p>}
  </section>;
}

export function LiveSignalLevelPanel({ reference }: { reference?: number }) {
  return <SignalLevelPanel meters={useEffectMeterSnapshot()} reference={reference} />;
}

export function LiveDynamicsHistory({ detector = false, threshold }: { detector?: boolean; threshold?: number }) {
  const { meters, receivedAt } = useReceivedEffectMeters();
  return <><EffectLevelHistory meters={meters} receivedAt={receivedAt} detector={detector} threshold={threshold} /><div className="compressor-meter-stats flex shrink-0 flex-col justify-around gap-4"><EffectStat label="REDUCTION" value={meters?.gainReductionDb === undefined ? undefined : -Math.abs(meters.gainReductionDb)} unit="dB" /><EffectStat label={detector ? "DETECTOR" : "OUTPUT"} value={detector ? meters?.detectorLevelDb : meters?.outputLevelDb} /></div></>;
}
