import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { nativeBridge, type EQMatchResult } from "../../services/NativeBridge";
import { applyEQBandValues, readEQBand } from "../../utils/eqBandClipboard";
import { paintSketch, sketchFrequency, sketchPoints } from "../../utils/eqSketch";
import { useEQDraftAudition } from "./useEQDraftAudition";
import { eqValues, type EQToolbarProps } from "./EQToolbar";

export function EQSketchPanel(props: EQToolbarProps & { sampleRate?: number }) {
  const { schema, address, onFlush, onApplyValues, sampleRate = 0 } = props;
  const [target, setTarget] = useState<number[]>(() => Array(sketchPoints).fill(0));
  const [selected, setSelected] = useState(64);
  const [detail, setDetail] = useState(4);
  const [mixedShapes, setMixedShapes] = useState(false);
  const minimum = mixedShapes ? -48 : -12, maximum = mixedShapes ? 24 : 12;
  const graphY = (gain: number) => 28 + (maximum - gain) / (maximum - minimum) * 144;
  const paint = (values: number[], from: { index: number; gain: number }, to: { index: number; gain: number }) => paintSketch(values, from, to, minimum, maximum);
  const [proposal, setProposal] = useState<(EQMatchResult & { fingerprint: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const mounted = useRef(true), operation = useRef(false);
  const gesture = useRef<{ before: number[]; last: { index: number; gain: number }; pointer: number } | null>(null);
  const descriptionId = useId();
  const rateValid = Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000;
  const currentValues = eqValues(schema);
  const fingerprint = JSON.stringify(currentValues);
  const eligible = currentValues.stereoMode < .5 && currentValues.autoGain < .5 && currentValues.auditionBand < .5 && (currentValues.detectorListenBand ?? 0) < .5 && currentValues.bypass < .5;
  const freeBands = schema.parameters.filter(p => /^band\d+\.enabled$/.test(p.id) && p.value < .5 && ![3, 4].includes(currentValues[p.id.replace("enabled", "type")])).map(p => p.id.slice(0, p.id.indexOf(".")));
  const audition = useEQDraftAudition(props, proposal?.accepted ? proposal.bands : undefined, proposal ? JSON.parse(proposal.fingerprint) : undefined, sampleRate);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setProposal(null); setStatus(""); }, [sampleRate, props.historyReplayRevision]);
  const edit = (next: number[]) => { setTarget(next); setProposal(null); setStatus(""); };
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 600, y = (event.clientY - rect.top) / rect.height * 220;
    return { index: Math.max(0, Math.min(128, Math.round((x - 32) / 548 * 128))), gain: Math.max(minimum, Math.min(maximum, maximum - (y - 28) / 144 * (maximum - minimum))) };
  };
  const path = (values: number[]) => values.map((gain, index) => `${index ? "L" : "M"}${32 + index / 128 * 548},${graphY(gain)}`).join(" ");
  const fit = async () => {
    if (operation.current || !rateValid || !eligible || !freeBands.length) return;
    operation.current = true; setBusy(true); setStatus(""); setProposal(null);
    try {
      if (!await onFlush()) throw new Error("Pending EQ changes failed");
      const actual = await nativeBridge.getBuiltInPluginSchema(address);
      const meters = await nativeBridge.getBuiltInPluginMeters(address);
      if (!mounted.current) return;
      if (JSON.stringify(eqValues(actual)) !== fingerprint || meters?.sampleRate !== sampleRate) throw new Error("EQ settings or sample rate changed. Fit again.");
      const result = await nativeBridge.eqMatch("sketch", { target, sampleRate, bands: Math.min(detail, freeBands.length), mixedShapes, analogResponse: currentValues.phaseMode < .5 && (currentValues.minimumPhaseFIR ?? 0) >= .5 && (currentValues.analogResponse ?? 0) >= .5 });
      if (!mounted.current) return;
      if (!result.success) throw new Error(result.error ?? "Could not fit the drawing");
      setProposal({ ...result, fingerprint }); setStatus(result.reason ?? "Proposal ready");
    } catch (reason) { if (mounted.current) setStatus(reason instanceof Error ? reason.message : "Could not fit the drawing"); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const apply = async () => {
    if (operation.current || !proposal?.accepted || !proposal.bands?.length) return;
    operation.current = true; setBusy(true); setStatus("");
    try {
      if (!await onFlush()) throw new Error("Pending EQ changes failed");
      const actual = await nativeBridge.getBuiltInPluginSchema(address);
      const meters = await nativeBridge.getBuiltInPluginMeters(address);
      if (!mounted.current) return;
      if (JSON.stringify(eqValues(actual)) !== proposal.fingerprint || meters?.sampleRate !== proposal.sampleRate || proposal.sampleRate !== sampleRate) throw new Error("EQ settings or sample rate changed. Fit again.");
      if (proposal.bands.length > freeBands.length) throw new Error("Not enough unused bands");
      const values: Record<string, number> = {};
      proposal.bands.forEach((band, index) => {
        const number = Number(freeBands[index].slice(4));
        Object.assign(values, applyEQBandValues(actual, number, { ...readEQBand(actual, number, true), enabled: 1, type: band.type ?? 0, slope: band.slope ?? 1, allPass: 0, freq: band.frequency, gain: band.gain, q: band.q, target: 0, dynamicEnabled: 0, cutMode: 0, gainQInteraction: 0 }));
      });
      await audition.stop(true);
      if (!await onApplyValues(values)) throw new Error("The EQ did not accept the complete proposal");
      if (mounted.current) { setProposal(null); setStatus(`Applied ${proposal.bands.length} filters. Undo restores the previous EQ.`); }
    } catch (reason) { if (mounted.current) { setProposal(null); setStatus(reason instanceof Error ? reason.message : "Could not apply the drawing"); } }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-xs" aria-label="Draw EQ correction">
    <p className="text-daw-text-muted">Draw an added correction. Fit proposes static stereo filters in unused non-cut slots; Apply adds them as one Undo step.</p>
    {!eligible && <p role="status">Use active Stereo EQ with Auto gain and Listen off.</p>}
    <svg viewBox="0 0 600 220" preserveAspectRatio="none" className="min-h-44 max-h-72 w-full shrink-0 touch-none rounded border border-daw-border-light bg-daw-dark outline-none focus-visible:ring-2 focus-visible:ring-daw-accent" tabIndex={0} role="img" aria-label="Draw correction curve" aria-describedby={descriptionId} aria-disabled={busy}
      onPointerDown={event => { if (busy || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); const next = point(event); gesture.current = { before: [...target], last: next, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); setSelected(next.index); edit(paint(target, next, next)); }}
      onPointerMove={event => { const active = gesture.current; if (!active || active.pointer !== event.pointerId) return; const next = point(event); const last = active.last; setTarget(previous => paint(previous, last, next)); active.last = next; setSelected(next.index); }}
      onPointerUp={event => { if (gesture.current?.pointer === event.pointerId) { gesture.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { if (gesture.current) edit(gesture.current.before); gesture.current = null; }}
      onKeyDown={event => {
        if (busy) return;
        if (event.key === "Escape" && gesture.current) { edit(gesture.current.before); gesture.current = null; event.preventDefault(); return; }
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setSelected(index => event.key === "Home" ? 0 : event.key === "End" ? 128 : Math.max(0, Math.min(128, index + (event.key === "ArrowRight" ? 1 : -1)))); }
        else if (["ArrowUp", "ArrowDown", "Backspace", "Delete"].includes(event.key)) { event.preventDefault(); const next = [...target]; next[selected] = event.key === "Backspace" || event.key === "Delete" ? 0 : Math.max(minimum, Math.min(maximum, next[selected] + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? .1 : .5))); edit(next); }
      }}>
      {(mixedShapes ? [-48, -36, -24, -12, 0, 12, 24] : [-12, -6, 0, 6, 12]).map(gain => <g key={gain}><path d={`M32 ${graphY(gain)}H580`} stroke="currentColor" opacity={gain === 0 ? .35 : .12} /><text x={3} y={graphY(gain) + 3} fill="currentColor" fontSize={9}>{gain}</text></g>)}
      <path d={path(target)} fill="none" stroke="#b7bec2" strokeWidth={2} />
      {proposal?.curve && <path d={path(proposal.curve)} fill="none" stroke="#58b6ff" strokeWidth={2} />}
      <circle cx={32 + selected / 128 * 548} cy={graphY(target[selected])} r={4} fill="#58b6ff" />
      <text x={32} y={207} fill="currentColor" fontSize={10}>80 Hz</text><text x={520} y={207} fill="currentColor" fontSize={10}>{rateValid ? `${Math.min(16000, sampleRate * .4) / 1000} kHz` : "Waiting"}</text>
    </svg>
    <p id={descriptionId} className="text-[10px] leading-relaxed text-daw-text-muted">Drag in either direction to redraw a section. Keyboard: Left/Right selects a point; Up/Down changes 0.5 dB, Shift changes 0.1 dB; Delete resets the point. Home/End selects an edge. Drawing and fitting do not change audio.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">Shapes<select className={editorSelect} aria-label="Sketch filter shapes" disabled={busy} value={mixedShapes ? "mixed" : "bells"} onChange={event => { const mixed = event.target.value === "mixed"; setMixedShapes(mixed); edit(target.map(gain => Math.max(mixed ? -48 : -12, Math.min(mixed ? 24 : 12, gain)))); }}><option value="bells">Bells</option><option value="mixed">Bells, shelves and cuts</option></select></label>
      <label className="flex flex-col gap-1">Point <select className={editorSelect} aria-label="Sketch frequency point" disabled={busy || !rateValid} value={selected} onChange={event => setSelected(Number(event.target.value))}>{Array.from({ length: sketchPoints }, (_, index) => <option key={index} value={index}>{Math.round(sketchFrequency(index, rateValid ? sampleRate : 48000))} Hz</option>)}</select></label>
      <label className="flex flex-col gap-1">Gain (dB)<input className={`${editorSelect} w-24`} type="number" min={minimum} max={maximum} step={.1} aria-label="Sketch point gain" disabled={busy} value={Number(target[selected].toFixed(2))} onChange={event => { const gain = event.currentTarget.valueAsNumber; if (Number.isFinite(gain)) edit(paint(target, { index: selected, gain }, { index: selected, gain })); }} /></label>
      <label className="flex flex-col gap-1">Maximum bands<select className={editorSelect} aria-label="Sketch detail" disabled={busy} value={detail} onChange={event => { setDetail(Number(event.target.value)); setProposal(null); }}>{[1, 2, 4, 6, 8].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
      <button className={editorButton} disabled={busy} onClick={() => edit(Array(sketchPoints).fill(0))}>Clear drawing</button>
      <button className={editorButton} disabled={busy || !rateValid || !eligible || !freeBands.length} onClick={() => { void fit(); }}>Fit drawing</button>
      {proposal?.accepted && !!proposal.bands?.length && <button className={editorButton} disabled={busy || proposal.fingerprint !== fingerprint || proposal.sampleRate !== sampleRate || !eligible} onClick={() => { void apply(); }}>Apply drawing</button>}
    </div>
    {proposal?.accepted && !!proposal.bands?.length && <div className="flex flex-wrap items-center gap-2"><button className={editorButton} disabled={busy || audition.pending || !audition.eligible || proposal.fingerprint !== fingerprint} aria-pressed={audition.active} onClick={() => { if (audition.active) void audition.stop(); else void audition.start(); }}>{audition.active ? "Stop audition" : "Audition proposal"}</button><span className="text-[10px] text-daw-text-muted">{audition.message || (audition.eligible ? "Preview without committing bands. Apply adds one Undo step." : "Audition requires active Stereo EQ with Auto gain and Listen off.")}</span></div>}
    <p role="status" className="text-daw-text-muted">{busy ? "Working..." : status || (rateValid ? `${freeBands.length} unused bands` : "Waiting for the native sample rate")}</p>
    {proposal && <p className="text-[10px] text-daw-text-muted">Gray: drawing. Blue: proposed correction. {proposal.bands?.length ?? 0} filters; numerical RMS error {proposal.afterError?.toFixed(2)} dB. {proposal.fingerprint !== fingerprint && "EQ changed; fit again."}</p>}
    {!!proposal?.bands?.length && <ul aria-label="Drawn filter proposal" className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-daw-text-muted">{proposal.bands.map((band, index) => <li key={index}>{["Bell", "Low shelf", "High shelf", "Low cut", "High cut"][band.type ?? 0]} {Math.round(band.frequency)} Hz{(band.type ?? 0) >= 3 ? ` / ${[6, 12, 24, 48][band.slope ?? 1]} dB/oct` : ` / ${band.gain.toFixed(1)} dB`}</li>)}</ul>}
    <p className="text-[10px] leading-relaxed text-daw-text-muted">Original bounded fit: 80 Hz to 16 kHz (lower at low sample rates), {mixedShapes ? "target -48 to +24 dB; bells/shelves up to +/-18 dB, cuts at 6/12/24/48 dB per octave." : "target +/-12 dB; each bell up to +/-9 dB and Q 0.35-3."} Existing filters stay in place. The fitted response is approximate; inspect it before Apply. Numerical error is a fitting diagnostic.</p>
  </section>;
}
