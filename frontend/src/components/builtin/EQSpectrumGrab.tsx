import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEQDraftAudition } from "./useEQDraftAudition";
import { eqValues, type EQToolbarProps } from "./EQToolbar";
import { eqFrequencyTicks } from "../../utils/eqFrequencyView";
import { Fragment, useEffect, useRef, useState } from "react";
import { getParameterWheelStepCount, resolveProfiledParameterWheel } from "../../utils/parameterWheel";
import { moveSpectrumGrabBand, type SpectrumGrabBand, type SpectrumGrabFrame } from "../../utils/eqSpectrumPeaks";
import "./EQSpectrumGrab.css";

export function EQSpectrumGrab({ auditionProps, sampleRate, frame, width, height, available, onApply, onClose, onRecapture, canRecapture, frequencyMin = 20, frequencyMax = 20000 }: {
  auditionProps: EQToolbarProps; sampleRate?: number;
  frequencyMin?: number; frequencyMax?: number;
  frame: SpectrumGrabFrame; width: number; height: number; available: boolean;
  onRecapture: () => void; canRecapture: boolean;
  onApply: (band: SpectrumGrabBand) => Promise<boolean>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<SpectrumGrabBand | null>(null), [selected, setSelected] = useState(-1);
  const [persistent, setPersistent] = useState(false), [usedPeaks, setUsedPeaks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const audition = useEQDraftAudition(auditionProps, draft ? [draft] : undefined, eqValues(auditionProps.schema), sampleRate, true);
  const latest = useRef(draft); latest.current = draft;
  const drag = useRef<{ pointer: number; x: number; y: number; band: SpectrumGrabBand } | null>(null);
  const svg = useRef<SVGSVGElement>(null), applying = useRef(false), mounted = useRef(true);
  const graphHeight = Math.max(100, height - 92), plotWidth = Math.max(1, width - 52), plotHeight = Math.max(1, graphHeight - 34);
  const x = (hz: number) => 38 + Math.log(hz / frequencyMin) / Math.log(frequencyMax / frequencyMin) * plotWidth;
  const y = (db: number) => 10 + Math.max(0, Math.min(1, -db / 90)) * plotHeight;
  const point = (event: React.PointerEvent) => {
    const box = svg.current!.getBoundingClientRect(); return { x: (event.clientX - box.left) * width / box.width, y: (event.clientY - box.top) * graphHeight / box.height };
  };
  const choose = (index: number) => {
    const peak = frame.peaks[index]; const band = { frequency: peak.frequency, gain: 0, q: peak.q };
    latest.current = band; setDraft(band); setSelected(index); setError(""); return band;
  };
  const update = (band: SpectrumGrabBand) => { const bounded = { ...band, frequency: Math.max(frequencyMin, Math.min(frequencyMax, band.frequency)) }; latest.current = bounded; setDraft(bounded); };
  const cancel = () => { void audition.stop(); drag.current = null; latest.current = null; setDraft(null); setSelected(-1); setError(""); };
  const apply = async () => {
    const band = latest.current; if (!band || applying.current || !available) return;
    applying.current = true; setBusy(true); setError("");
    try { await audition.stop(true); if (await onApply(band)) { if (persistent) { setUsedPeaks(previous => [...previous, selected]); cancel(); } else onClose(); } else if (mounted.current) setError("Could not add the band. Free a band or try again."); }
    catch { if (mounted.current) setError("Could not apply the band. Check the editor status; Undo restores any partial change."); }
    finally { applying.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; drag.current = null; }; }, []);
  useEffect(() => { cancel(); setUsedPeaks([]); }, [frame]);
  // Place numbered handles near their peaks without overlapping hit circles.
  // Leaders retain the exact spectrum position when a dense cluster needs space.
  const handles: { x: number; y: number; anchorX: number; anchorY: number }[] = [];
  for (let index = 0; index < frame.peaks.length; index++) {
    const peak = frame.peaks[index], band = selected === index && draft ? draft : { frequency: peak.frequency, gain: 0, q: peak.q };
    const anchorX = x(band.frequency), anchorY = Math.max(24, Math.min(graphHeight - 40, y(peak.db) - band.gain / 60 * plotHeight));
    const candidates = [{ x: Math.max(24, Math.min(width - 24, anchorX)), y: anchorY }];
    for (let cy = 24; cy <= graphHeight - 24; cy += 34) for (let cx = 24; cx <= width - 24; cx += 34) candidates.push({ x: cx, y: cy });
    candidates.sort((a, b) => (a.x - anchorX) ** 2 + (a.y - anchorY) ** 2 - (b.x - anchorX) ** 2 - (b.y - anchorY) ** 2);
    const position = candidates.find(candidate => handles.every(handle => Math.hypot(handle.x - candidate.x, handle.y - candidate.y) >= 34)) ?? candidates[0];
    handles.push({ ...position, anchorX, anchorY });
  }
  const path = frame.frequencies.map((hz, i) => `${i ? "L" : "M"}${x(hz).toFixed(2)},${y(frame.db[i]).toFixed(2)}`).join(" ");
  return <div className="eq-spectrum-grab absolute inset-0 flex min-h-0 flex-col bg-daw-dark" onKeyDownCapture={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) { if (draft) cancel(); else onClose(); } }
  }}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-daw-border-light bg-daw-panel px-3 py-2 text-[11px]">
      <span className="text-daw-text-muted">{frame.source} · frozen · 90 dB</span>
      <label className="flex items-center gap-1">Peak<select className={editorSelect} aria-label="Captured peak" disabled={busy || !available} value={selected} onChange={event => choose(Number(event.target.value))}><option value={-1} disabled>Choose…</option>{frame.peaks.map((peak, index) => <option key={peak.frequency} value={index} disabled={usedPeaks.includes(index)}>{Math.round(peak.frequency)} Hz</option>)}</select></label>
      <label className="flex items-center gap-1">Q<input className={`${editorSelect} w-16`} type="number" min={.1} max={30} step={.1} aria-label="Captured band Q" disabled={!draft || busy} value={draft ? Number(draft.q.toFixed(2)) : 1} onChange={event => { const next = Number(event.target.value); if (draft && Number.isFinite(next)) update({ ...draft, q: Math.max(.1, Math.min(30, next)) }); }} /></label>
      <button className={editorButton} disabled={!draft || busy || audition.pending || !audition.eligible} aria-pressed={audition.active} title="Temporary correction in the current EQ phase mode. Use Stereo with Auto gain and Listen off." onClick={() => { if (audition.active) void audition.stop(); else void audition.start(); }}>{audition.active ? "Stop audition" : "Audition peak"}</button>
      <button className={editorButton} disabled={!draft || busy || !available} onClick={() => void apply()}>Apply bell</button>
      <button className={editorButton} aria-pressed={persistent} disabled={busy} onClick={() => setPersistent(!persistent)}>Keep capture</button>
      <button className={editorButton} disabled={busy || !canRecapture} onClick={onRecapture}>Recapture</button>
      <button className={editorButton} disabled={busy} onClick={onClose}>Exit grab</button>
      <p className="w-full text-[10px] leading-4 text-daw-text-muted" role="status">{error || (busy ? "Applying bell…" : !available ? "No unused non-cut band." : frame.peaks.length === 0 ? "No distinct peaks in this frame. Recapture when the spectrum changes." : usedPeaks.length === frame.peaks.length ? "All captured peaks used. Recapture to choose them again." : draft ? `${Math.round(draft.frequency)} Hz · ${draft.gain.toFixed(1)} dB · Q ${draft.q.toFixed(2)}. ${audition.active ? "Audition follows edits. " : ""}Release or Enter applies; Escape cancels.` : "Drag a numbered peak. Arrows adjust frequency/gain; wheel or Q adjusts width. Audio changes on apply.")}{audition.message && ` ${audition.message}`}</p>
    </div>
    <svg ref={svg} className="min-h-0 w-full flex-1" viewBox={`0 0 ${width} ${graphHeight}`} preserveAspectRatio="none" aria-label="Captured spectrum editing">
      {eqFrequencyTicks(frequencyMin, frequencyMax, plotWidth).map(hz => <g key={hz}><line x1={x(hz)} x2={x(hz)} y1={10} y2={10 + plotHeight} stroke="#282b2e" /><text x={x(hz)} y={graphHeight - 5} textAnchor="middle" fontSize={9} fill="#939a9f">{hz >= 1000 ? `${hz / 1000}k` : hz}</text></g>)}
      <path d={path} fill="none" stroke="#bac3cb" strokeWidth={1.5} />
      {frame.peaks.map((peak, index) => {
        const handle = handles[index], unavailable = busy || !available || usedPeaks.includes(index);
        return <Fragment key={peak.frequency}><line x1={handle.anchorX} y1={handle.anchorY} x2={handle.x} y2={handle.y} stroke="#939a9f" strokeWidth={1} pointerEvents="none" /><g role="button" tabIndex={unavailable ? -1 : 0} aria-disabled={unavailable} aria-label={`Grab peak ${Math.round(peak.frequency)} Hz`} aria-pressed={selected === index} className="eq-grab-peak" transform={`translate(${handle.x},${handle.y})`}
          onPointerDown={event => { if (event.button !== 0 || unavailable) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); const band = selected === index && latest.current ? latest.current : choose(index); drag.current = { pointer: event.pointerId, ...point(event), band }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { const start = drag.current; if (!start || event.pointerId !== start.pointer) return; const at = point(event); update(moveSpectrumGrabBand(start.band, (at.x - start.x) / plotWidth * Math.log2(frequencyMax / frequencyMin), (start.y - at.y) / plotHeight * 60, frequencyMin, frequencyMax)); }}
          onPointerUp={event => { if (drag.current?.pointer !== event.pointerId) return; drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); void apply(); }}
          onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}
          onKeyDown={event => {
            if (unavailable || !["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); const band = selected === index && latest.current ? latest.current : choose(index);
            if (event.key === "Enter") { void apply(); return; }
            const fine = event.shiftKey ? .1 : 1;
            update(moveSpectrumGrabBand(band, (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0) * fine / 24, (event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0) * fine, frequencyMin, frequencyMax));
          }}
          onWheel={event => { if (unavailable) return; const gesture = resolveProfiledParameterWheel(event.nativeEvent, "graph"); if (gesture.operation !== "adjust") return; event.stopPropagation(); const band = selected === index && latest.current ? latest.current : choose(index); update({ ...band, q: Math.max(.1, Math.min(30, band.q * 2 ** (getParameterWheelStepCount(gesture, { normal: 1, fine: .1 }) / 8))) }); }}>
          <circle r={14} fill="#20272c" stroke={selected === index ? "#58b6ff" : "#bac3cb"} strokeWidth={2} /><text textAnchor="middle" dominantBaseline="central" fontSize={10} fill="#e7edf2">{index + 1}</text>
        </g></Fragment>;
      })}
    </svg>
  </div>;
}
