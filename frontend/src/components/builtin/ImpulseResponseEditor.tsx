import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { modalPointerBoundaryProps } from "../../utils/modalEventGuards";
import { nativeBridge, type IRPreparationStatus, type BuiltInPluginSchema } from "../../services/NativeBridge";
import type { EQToolbarProps } from "./EQToolbar";
import { IRGeometryEditor } from "./IRGeometryEditor";
import { IRDecayView } from "./IRDecayView";
import { IRAudition } from "./IRAudition";

type Shape = Required<NonNullable<NonNullable<BuiltInPluginSchema["impulseResponse"]>["shape"]>>;
type NumberKey = { [K in keyof Shape]: Shape[K] extends number ? K : never }[keyof Shape];
const neutral: Shape = {
  start: 0, end: 1.2, attack: 0, size: 1, reverse: false, normalise: true,
  geometryEnabled: false, geometrySourceLX: -1, geometrySourceLY: 2, geometrySourceRX: 1, geometrySourceRY: 2, geometryMicLX: -.15, geometryMicLY: 0, geometryMicRX: .15, geometryMicRY: 0, geometryTargetLX: -1, geometryTargetLY: 2, geometryTargetRX: 1, geometryTargetRY: 2,
  channelOrder: 0, outputLayout: 0, octaveAnalysis: false, crossTerms: 1, brightness: 0, sourceBlendLeft: 0, sourceBlendRight: 1, directDb: 0, earlyDb: 0, tailDb: 0, directEnd: .005, earlyEnd: .08,
  lowDecay: 0, midDecay: 0, highDecay: 0, lowCrossover: 250, highCrossover: 4000,
  eqEnabled: true, eq0Frequency: 120, eq0Gain: 0, eq0Q: Math.SQRT1_2,
  eq1Frequency: 500, eq1Gain: 0, eq1Q: 1, eq2Frequency: 2500, eq2Gain: 0, eq2Q: 1,
  eq3Frequency: 8000, eq3Gain: 0, eq3Q: Math.SQRT1_2,
};
const sections = ["Shape", "Balance", "Sources", "Position", "Damping", "Bright", "EQ", "Decay", "Audition"] as const;

function EQResponse({ points }: { points?: { frequency: number; db: number }[] }) {
  const data = points?.length ? points : [{ frequency: 20, db: 0 }, { frequency: 20000, db: 0 }];
  const limit = Math.max(12, Math.ceil(Math.max(...data.map(p => Math.abs(p.db))) / 6) * 6);
  const maximum = data[data.length - 1].frequency;
  const x = (frequency: number) => 48 + Math.log(frequency / 20) / Math.log(maximum / 20) * 860;
  const path = data.map(p => `${x(p.frequency)},${43 - p.db / limit * 30}`).join(" ");
  return <svg className="min-h-16 max-h-20 w-full flex-1 rounded border border-daw-border-light bg-daw-dark" viewBox="0 0 960 100" preserveAspectRatio="none" role="img" aria-label="Applied convolution wet EQ response">
    <title>Applied four-band wet EQ only. IR spectrum and separate wet cuts are not included.</title>
    {[13, 43, 73].map(y => <line key={y} x1="48" x2="908" y1={y} y2={y} stroke="var(--color-daw-border-light)" />)}
    {[100, 1000, 10000].filter(f => f < maximum).map(f => <line key={f} x1={x(f)} x2={x(f)} y1="10" y2="75" stroke="var(--color-daw-border-light)" />)}
    <polyline points={path} fill="none" stroke="var(--color-daw-accent)" strokeWidth="2" />
    <g fill="var(--color-daw-text-muted)" fontSize="18"><text x="5" y="18">+{limit}</text><text x="5" y="77">-{limit}</text><text x="48" y="94">20 Hz</text><text x={x(1000)} y="94" textAnchor="middle">1k</text><text x="908" y="94" textAnchor="end">{(maximum / 1000).toFixed(1)}k Hz</text></g>
  </svg>;
}

export function ImpulseResponseEditor({ schema, address, onApplyState }: Pick<EQToolbarProps, "address" | "onApplyState"> & { schema: BuiltInPluginSchema }) {
  const ir = schema.impulseResponse;
  const current: Shape = { ...neutral, end: ir?.trimSeconds ?? neutral.end, ...ir?.shape };
  const [draft, setDraft] = useState<Shape>(current);
  const [section, setSection] = useState<typeof sections[number]>("Shape");
  useEffect(() => { if (ir?.channels !== 4 && (section === "Sources" || section === "Position")) setSection("Shape"); }, [ir?.channels, section]);
  const [band, setBand] = useState<0 | 1 | 2 | 3>(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preparation, setPreparation] = useState<{ id: string; status: IRPreparationStatus } | null>(null);
  const activePreparation = useRef<string | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    const id = activePreparation.current;
    activePreparation.current = null;
    if (id) void nativeBridge.irPreparation("release", id).catch(() => {});
  }; }, []);
  useEffect(() => {
    const id = preparation?.id;
    if (!id) return;
    let disposed = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const status = await nativeBridge.irPreparation("status", id);
        if (!disposed && status && activePreparation.current === id) setPreparation({ id, status });
      } finally { polling = false; }
    };
    const timer = window.setInterval(() => void poll().catch(() => {}), 200);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [preparation?.id]);
  const appliedIR = useRef(JSON.stringify([schema.instanceId, ir]));
  useEffect(() => {
    const snapshot = JSON.stringify([schema.instanceId, ir]);
    if (snapshot === appliedIR.current) return;
    appliedIR.current = snapshot;
    setDraft({ ...neutral, end: ir?.trimSeconds ?? neutral.end, ...ir?.shape });
  }, [ir, schema.instanceId]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const geometryValid = !draft.geometryEnabled || (!draft.reverse && draft.size === 1 && ir?.channels === 4 && [
    [draft.geometrySourceLX, draft.geometrySourceLY], [draft.geometrySourceRX, draft.geometrySourceRY], [draft.geometryTargetLX, draft.geometryTargetLY], [draft.geometryTargetRX, draft.geometryTargetRY],
  ].every(([x, y]) => [[draft.geometryMicLX, draft.geometryMicLY], [draft.geometryMicRX, draft.geometryMicRY]].every(([mx, my]) => Math.hypot(x - mx, y - my) >= .1)));
  const valid = geometryValid && Object.entries(draft).every(([key, value]) => !key.startsWith("geometry") || typeof value !== "number" || Math.abs(value) <= 50) && Object.values(draft).every(v => typeof v !== "number" || Number.isFinite(v))
    && draft.start >= 0 && draft.end > draft.start && draft.end <= (ir?.duration ?? 10)
    && draft.attack >= 0 && draft.attack <= 2 && draft.size >= .5 && draft.size <= 2
    && draft.sourceBlendLeft >= 0 && draft.sourceBlendLeft <= 1 && draft.sourceBlendRight >= 0 && draft.sourceBlendRight <= 1
    && draft.crossTerms >= 0 && draft.crossTerms <= 1 && draft.brightness >= 0 && draft.brightness <= 1
    && draft.directEnd >= 0 && draft.directEnd <= 1 && draft.earlyEnd >= draft.directEnd && draft.earlyEnd <= 10
    && [draft.directDb, draft.earlyDb, draft.tailDb].every(v => v >= -60 && v <= 12)
    && [draft.lowDecay, draft.midDecay, draft.highDecay].every(v => v === 0 || v >= .1 && v <= 20)
    && draft.lowCrossover >= 60 && draft.lowCrossover <= 2000 && draft.highCrossover >= 1000 && draft.highCrossover <= 16000 && draft.highCrossover >= draft.lowCrossover * 2
    && [0, 1, 2, 3].every(b => draft[`eq${b}Frequency` as NumberKey] >= 20 && draft[`eq${b}Frequency` as NumberKey] <= 20000 && Math.abs(draft[`eq${b}Gain` as NumberKey]) <= 12 && draft[`eq${b}Q` as NumberKey] >= .3 && draft[`eq${b}Q` as NumberKey] <= 6);
  const prepareState = async (state: object): Promise<boolean> => {
    if (!mounted.current) return false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = crypto.randomUUID();
    const initial = await nativeBridge.irPreparation("begin", id);
    if (!mounted.current) { if (initial) await nativeBridge.irPreparation("release", id).catch(() => {}); return false; }
    if (!initial) return onApplyState(JSON.stringify(state));
    activePreparation.current = id;
    setPreparation({ id, status: initial });
    try {
      const applied = await onApplyState(JSON.stringify({ ...state, irPreparationId: id }));
      const status = await nativeBridge.irPreparation("status", id).catch(() => null);
      if (!applied && status?.state === "cancelled") {
        setError("Preparation cancelled. The previous IR is retained.");
        return true; // Cancellation is handled, not an invalid-file error.
      }
      return applied;
    } finally {
      activePreparation.current = null;
      setPreparation(null);
      await nativeBridge.irPreparation("release", id).catch(() => {});
      requestAnimationFrame(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
    }
  };
  const cancelPreparation = async () => {
    const id = activePreparation.current;
    if (!id) return;
    const status = await nativeBridge.irPreparation("cancel", id);
    if (status && activePreparation.current === id) setPreparation({ id, status });
  };
  const change = async (state: object) => {
    if (busy) return; setBusy(true); setError("");
    try { if (!await prepareState(state)) setError("Invalid response or settings. The previous IR is retained."); }
    catch { setError("Could not finish preparation. Check the current response before retrying."); }
    finally { setBusy(false); }
  };
  const loadIR = async () => {
    if (busy) return; setBusy(true); setError("");
    try {
      const file = await nativeBridge.browseForFile("Select impulse response", "*.wav;*.aif;*.aiff;*.flac");
      if (file && !await prepareState({ irFile: file })) setError("Use a non-silent mono, stereo or four-channel file, up to 10 seconds.");
    } catch { setError("Could not finish loading. Check the current response before retrying."); }
    finally { setBusy(false); }
  };
  const number = (key: NumberKey, label: string, min: number, max: number, step: number) =>
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px]" key={key}>{label}<input type="number" aria-label={`IR ${label}`} className={`${editorSelect} min-w-0 w-full`} value={draft[key]} min={min} max={max} step={step} disabled={busy || (draft.geometryEnabled && (key === "size" || key === "sourceBlendLeft" || key === "sourceBlendRight"))}
      onChange={e => setDraft(previous => ({ ...previous, [key]: Number(e.target.value) }))} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (valid && dirty) void change({ irShape: draft }); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(current); } }} /></label>;
  const description = section === "Damping" ? "Extra tail decay: 0 = unchanged; lower seconds shorten more. Starts after Early end; crossovers clamp below source Nyquist."
    : section === "Sources" ? "Each input blends the recorded left/right source columns. Cross terms follows the blend; Normalize applies to the result. Opposed measurements can cancel."
    : section === "Bright" ? "Synthetic high-band response follows early/tail energy after Direct end. Normalize applies to the combined IR; source samples stay portable. Apply before auditioning."
    : section === "EQ" ? `Applied EQ curve at ${((ir?.eqSampleRate ?? 48000) / 1000).toFixed(1)} kHz. Wet only; EQ frequency clamps below playback Nyquist.`
      : ir?.channels === 4 ? "First letter = input, second = output. Four paths switch together." : "Original samples retained. IR changes crossfade. -60 dB mutes a section.";
  const stages = ["Queued", "Reading source", "Validating source", "Shaping response", "Analysing decay", "Preparing playback", "Publishing response"];
  return <div className="flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-y-auto px-4 py-3 [&>*]:shrink-0" aria-label="Impulse response">
    {preparation && createPortal(<div role="dialog" aria-label="Preparing impulse response" aria-modal="true" tabIndex={-1}
      {...modalPointerBoundaryProps}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); void cancelPreparation().catch(() => {}); }
        if (event.key === "Tab") { event.preventDefault(); (event.currentTarget.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? event.currentTarget).focus(); }
      }}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded border border-daw-border-light bg-daw-panel p-5 text-daw-text shadow-xl">
        <p role="status" className="text-sm">{preparation.status.state === "cancelled" ? "Cancellation requested. Finishing the current preparation stage..." : stages[preparation.status.stage] ?? "Preparing response"}</p>
        <progress className="h-2 w-full accent-daw-accent" aria-label="IR preparation stages" value={preparation.status.stage} max={6} />
        <p className="text-xs leading-5 text-daw-text-muted">Progress shows completed stages, not estimated time. The previous response stays active until preparation finishes.</p>
        <button autoFocus className={`${editorButton} self-end`} disabled={!preparation.status.cancellable}
          onClick={event => { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus(); void cancelPreparation().catch(() => setError("Cancellation request failed.")); }}>Cancel preparation</button>
      </div>
    </div>, document.body)}
    <div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-base" title={ir?.name}>{ir?.name ?? "Studio room (generated)"}</p><p className="mt-1 text-[11px] text-daw-text-muted">{(ir?.processedDuration ?? ir?.trimSeconds ?? 1.2).toFixed(2)} s processed / {(ir?.duration ?? 1.2).toFixed(2)} s source / {ir?.channels === 4 ? "True stereo" : ir?.channels === 1 ? "Mono IR" : "Stereo IR"} / Embedded</p></div><button className={editorButton} disabled={busy} onClick={() => void loadIR()}>Load IR...</button></div>
    {section === "Decay" ? <><div className="flex flex-wrap items-center gap-2"><button className={editorButton} disabled={busy || dirty} aria-pressed={current.octaveAnalysis} onClick={() => void change({ irShape: { ...current, octaveAnalysis: !current.octaveAnalysis } })}>{current.octaveAnalysis ? "Remove octave analysis" : "Analyze octave bands"}</button><span className="text-[11px] text-daw-text-muted">Prepared analysis only; audio is unchanged.</span></div><IRDecayView estimate={ir?.decayEstimate} /></> : section === "Position" ? <IRGeometryEditor shape={draft} busy={busy} geometry={ir?.geometry} onChange={patch => setDraft(previous => ({ ...previous, ...patch }))} /> : section === "EQ" ? <EQResponse points={ir?.eqResponse} /> : ir?.waveform && <svg className="min-h-8 max-h-16 w-full flex-1 rounded border border-daw-border-light bg-daw-dark" viewBox="0 0 960 100" preserveAspectRatio="none" role="img" aria-label="Processed impulse response amplitude envelope">{ir.waveform.map((amplitude, index) => <rect key={index} x={index * 10 + 2} y={50 - amplitude * 46} width={6} height={Math.max(1, amplitude * 92)} fill="var(--color-daw-accent)" />)}</svg>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2" aria-label="IR editing section">{sections.filter(name => !["Sources", "Position"].includes(name) || ir?.channels === 4).map(name => <button className={editorButton} key={name} aria-pressed={section === name} onClick={() => setSection(name)}>{name}</button>)}</div>
      {section !== "Decay" && section !== "Audition" && (ir?.channels === 4 ? <label className="flex items-center gap-2 text-[11px]">Channel order<select className={editorSelect} aria-label="IR channel order" disabled={busy} value={draft.channelOrder} onChange={e => setDraft(previous => ({ ...previous, channelOrder: Number(e.target.value) }))}><option value={0}>LL / LR / RL / RR</option><option value={1}>LL / RL / LR / RR</option></select></label> : <span className="text-[11px] text-daw-text-muted">Original samples retained</span>)}</div>
    {ir?.channels === 4 && section === "Balance" && <label className="flex flex-wrap items-center gap-2 text-xs text-daw-text-secondary">
      Output layout
      <select className={editorSelect} aria-label="Convolution output layout" disabled={busy} value={draft.outputLayout ?? 0}
        onChange={event => setDraft(previous => ({ ...previous, outputLayout: Number(event.target.value) }))}>
        <option value={0}>Stereo sum: 1/2</option><option value={1}>Four outputs: direct 1/2, cross 3/4</option>
      </select>
      <span>Route 3/4 to another track with a send.</span>
    </label>}
    {section !== "Decay" && section !== "Audition" && section !== "Position" && <div className="flex items-end gap-3">
      {section === "Shape" && <>{number("start", "Start (s)", 0, ir?.duration ?? 10, .001)}{number("end", "End (s)", .001, ir?.duration ?? 10, .001)}{number("attack", "Attack (s)", 0, 2, .01)}{number("size", "Size (x)", .5, 2, .01)}<button className={editorButton} aria-pressed={draft.reverse} disabled={busy || draft.geometryEnabled} onClick={() => setDraft(previous => ({ ...previous, reverse: !previous.reverse }))}>Reverse</button></>}
      {section === "Balance" && <>{number("directDb", "Direct (dB)", -60, 12, 1)}{number("earlyDb", "Early (dB)", -60, 12, 1)}{number("tailDb", "Tail (dB)", -60, 12, 1)}{number("directEnd", "Direct end (s)", 0, 1, .001)}{number("earlyEnd", "Early end (s)", 0, 10, .001)}{ir?.channels === 4 && number("crossTerms", "Cross terms (x)", 0, 1, .05)}</>}
      {section === "Sources" && <>{number("sourceBlendLeft", "Left source blend", 0, 1, .05)}{number("sourceBlendRight", "Right source blend", 0, 1, .05)}<p className="min-w-0 flex-[2] text-xs leading-relaxed text-daw-text-muted">0 = recorded left source; 1 = recorded right source. This interpolates the two measurements; it does not model a new geometric position.</p></>}
      {section === "Bright" && <>{number("brightness", "Brightness (x)", 0, 1, .05)}<p className="min-w-0 flex-[3] text-xs leading-relaxed text-daw-text-muted">Add high-frequency reverberation from the input, shaped by this response. Zero keeps the original sound. Apply prepares a new response and crossfades it into playback.</p></>}
      {section === "Damping" && <>{number("lowDecay", "Low damping (s)", 0, 20, .1)}{number("midDecay", "Mid damping (s)", 0, 20, .1)}{number("highDecay", "High damping (s)", 0, 20, .1)}{number("lowCrossover", "Low split (Hz)", 60, 2000, 10)}{number("highCrossover", "High split (Hz)", 1000, 16000, 100)}</>}
      {section === "EQ" && <><label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px]">Band<select className={editorSelect} aria-label="IR EQ band" value={band} onChange={e => setBand(Number(e.target.value) as 0 | 1 | 2 | 3)}><option value={0}>Low shelf</option><option value={1}>Bell 1</option><option value={2}>Bell 2</option><option value={3}>High shelf</option></select></label>{number(`eq${band}Frequency`, "EQ frequency (Hz)", 20, 20000, 10)}{number(`eq${band}Gain`, "EQ gain (dB)", -12, 12, .1)}{band === 1 || band === 2 ? number(`eq${band}Q`, "EQ Q", .3, 6, .1) : <span className="flex-1 pb-2 text-xs text-daw-text-muted">Smooth shelf</span>}<button className={editorButton} disabled={busy} aria-pressed={draft.eqEnabled} onClick={() => setDraft(previous => ({ ...previous, eqEnabled: !previous.eqEnabled }))}>EQ {draft.eqEnabled ? "On" : "Off"}</button><button className={editorButton} disabled={busy} onClick={() => setDraft(previous => ({ ...previous, eq0Gain: 0, eq1Gain: 0, eq2Gain: 0, eq3Gain: 0 }))}>Flat EQ</button></>}
    </div>}
    {section !== "Decay" && section !== "Audition" && <div className="flex items-center gap-3"><button className={editorButton} aria-pressed={draft.normalise} disabled={busy} onClick={() => setDraft(previous => ({ ...previous, normalise: !previous.normalise }))}>Normalize</button><button className={editorButton} disabled={busy || !valid || !dirty} onClick={() => void change({ irShape: draft })}>Apply IR edits</button><button className={editorButton} disabled={busy || !dirty} onClick={() => setDraft(current)}>Revert edits</button><button className={editorButton} disabled={busy} onClick={() => void change({ defaultIR: true })}>Default room</button></div>}
    {(section !== "Decay" && section !== "Audition" || busy || dirty || error) && <p className="text-[10px] text-daw-text-muted" role="status">{busy ? "Preparing response..." : error || !valid ? error || (!geometryValid ? "Direct placement needs a four-path IR, Size 1, Reverse off, and at least 0.1 m between every source and microphone." : "Check control ranges; coordinates are -50 to 50 m, damping is 0 or 0.1-20 s, and High split is at least twice Low split.") : dirty ? "Unapplied changes. Apply commits one undo step; graphs show applied settings." : description}</p>}
    {section === "Audition" && <IRAudition address={address} disabled={busy || dirty} fingerprint={JSON.stringify([schema.instanceId, ir])} />}
  </div>;
}
