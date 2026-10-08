import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { useApprovedEffectMeters, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import "./InstrumentEditorParts.css";
import { ProfiledRangeInput } from "../ui/ProfiledRangeInput";
import { instrumentTabSummary } from "./instrumentTabSummary";

const InstrumentMeters = createContext<BuiltInPluginSchema["visualization"]>(undefined);
function InstrumentMeterBoundary({ props, children }: { props: ApprovedEffectEditorProps; children: ReactNode }) {
  const meters = useApprovedEffectMeters(props);
  return <InstrumentMeters.Provider value={meters}>{children}</InstrumentMeters.Provider>;
}
export const useInstrumentPerformance = () => useContext(InstrumentMeters);

export function InstrumentShell({ props, kind, tabs, tab, onTab, children, footer }: {
  props: ApprovedEffectEditorProps; kind: string; tabs: string[]; tab: string; onTab: (tab: string) => void;
  children: ReactNode; footer?: ReactNode;
}) {
  return <InstrumentMeterBoundary props={props}><div className={`approved-effect-editor approved-instrument-editor instrument-${kind} flex min-h-0 min-w-0 flex-1 flex-col`} data-suite-kind={kind}>
    <EQToolbar {...props} />
    <nav className="instrument-tabs flex shrink-0 gap-1 overflow-x-auto px-4" aria-label={`${props.schema.name} pages`}>
      {tabs.map(name => {
        const summary = instrumentTabSummary(props.schema, kind, name);
        return <button key={name} type="button" aria-label={name} aria-description={summary || undefined} title={summary || name} aria-pressed={name === tab} onClick={() => onTab(name)}>{name}{summary && <span className="instrument-tab-indicator" aria-hidden="true" />}</button>;
      })}
    </nav>
    <div className="instrument-workspace min-h-0 min-w-0 flex-1 overflow-y-auto p-4">{children}</div>
    {footer}
  </div></InstrumentMeterBoundary>;
}

export function InstrumentSection({ title, detail, children, className = "" }: { title: string; detail?: string; children: ReactNode; className?: string }) {
  return <section className={`instrument-section min-w-0 ${className} p-[14px]`} aria-label={title}>
    <header className="mb-3 flex items-baseline justify-between gap-2"><h3>{title}</h3>{detail && <span>{detail}</span>}</header>{children}
  </section>;
}
export function InstrumentControls({ children }: { children: ReactNode }) {
  return <div className="instrument-controls flex flex-wrap items-start justify-around gap-x-3 gap-y-4">{children}</div>;
}
export function InstrumentHelp({ children }: { children: ReactNode }) {
  return <p className="instrument-help mt-3 text-xs leading-relaxed">{children}</p>;
}
export const instrumentValue = (schema: BuiltInPluginSchema, id: string, fallback = 0) => findBuiltInParameter(schema, id)?.value ?? fallback;

export function InstrumentSlider({ props, id, label }: { props: ApprovedEffectEditorProps; id: string; label?: string }) {
  const parameter = findBuiltInParameter(props.schema, id);
  const [draft, setDraft] = useState(String(parameter?.value ?? 0));
  const editing = useRef(false), cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(Number((parameter?.value ?? 0).toFixed(3)))); }, [parameter?.value]);
  if (!parameter) return null;
  const set = (value: number) => props.onChange(parameter, Math.max(parameter.min, Math.min(parameter.max, value)));
  const commit = () => {
    editing.current = false;
    if (!cancelled.current && draft.trim() && Number.isFinite(Number(draft))) { props.onGestureStart(parameter.id); set(Number(draft)); props.onGestureEnd(); }
    cancelled.current = false; setDraft(String(Number(parameter.value.toFixed(3))));
  };
  return <div className="instrument-slider flex min-w-0 flex-col gap-2" data-param={parameter.id}><label className="flex items-center justify-between gap-2 text-xs"><span>{label ?? parameter.label}</span>
    <input type="number" aria-label={`${label ?? parameter.label} value`} className="suite-value" min={parameter.min} max={parameter.max} step="any" value={draft}
      onFocus={event => { editing.current = true; cancelled.current = false; event.currentTarget.select(); }} onChange={event => setDraft(event.currentTarget.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); } }} /></label>
    <ProfiledRangeInput aria-label={label ?? parameter.label} min={parameter.min} max={parameter.max} step={(parameter.max - parameter.min) / 1000} value={parameter.value}
      onValueChange={set} onBeginEdit={() => props.onGestureStart(parameter.id)} onCommitEdit={props.onGestureEnd}
      onDoubleClick={() => { props.onGestureStart(parameter.id); set(parameter.defaultValue); props.onGestureEnd(); }} /></div>;
}

/** A preview session owns only its audition notes, including across address changes. */
export function useInstrumentPreview(address: BuiltInPluginAddress) {
  const [pressed, setPressed] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState("");
  const active = useRef(new Set<number>()), queue = useRef(Promise.resolve());
  const session = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  const send = (note: number, on: boolean) => {
    if (!address.trackId || active.current.has(note) === on) return;
    if (on) active.current.add(note); else active.current.delete(note);
    setPressed(new Set(active.current));
    const token = session.current;
    queue.current = queue.current.then(async () => {
      const accepted = await nativeBridge.sendBuiltInPreview(address, token, note, on);
      if (!accepted && mounted.current) setError("Audition unavailable for this instance.");
    }).catch(() => { if (mounted.current) setError("Audition unavailable for this instance."); });
  };
  const stopAll = () => {
    active.current.clear(); setPressed(new Set());
    const token = session.current;
    queue.current = queue.current.then(() => nativeBridge.sendBuiltInPreview(address, token, -1, false)).then(() => undefined).catch(() => undefined);
  };
  useEffect(() => {
    mounted.current = true;
    const notes = active.current, token = session.current;
    const stop = () => {
      notes.clear();
      if (mounted.current) setPressed(new Set());
      queue.current = queue.current.then(() => nativeBridge.sendBuiltInPreview(address, token, -1, false)).then(() => undefined).catch(() => undefined);
    };
    const visibility = () => { if (document.hidden) stop(); };
    const heartbeat = window.setInterval(() => { if (notes.size) void nativeBridge.sendBuiltInPreview(address, token, -2, false).catch(() => undefined); }, 1000);
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; window.clearInterval(heartbeat); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", visibility); stop(); };
  }, [address.trackId, address.chain, address.fxIndex, address.instanceId]);
  return { pressed, error, start: (note: number) => send(note, true), stop: (note: number) => send(note, false), stopAll };
}

const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const instrumentNoteName = (note: number) => `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`;

export function InstrumentKeyboard({ address, piano = false, output }: { address: BuiltInPluginAddress; piano?: boolean; output?: ReactNode }) {
  const preview = useInstrumentPreview(address);
  const [hidden, setHidden] = useState(false);
  const cells: { white: number; black?: number }[] = [];
  let note = 48;
  for (let index = 0; index < (piano ? 29 : 22); ++index) {
    while (noteNames[note % 12].includes("♯")) ++note;
    cells.push({ white: note, black: noteNames[(note + 1) % 12].includes("♯") && index < (piano ? 28 : 21) ? note + 1 : undefined });
    ++note;
  }
  const key = (midi: number, black: boolean) => <button key={midi} type="button" className={black ? "instrument-key instrument-black-key" : "instrument-key instrument-white-key"}
    aria-label={`Audition ${instrumentNoteName(midi)}, MIDI ${midi}`} aria-pressed={preview.pressed.has(midi)} disabled={!address.trackId}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); preview.start(midi); }}
    onPointerUp={() => preview.stop(midi)} onPointerCancel={() => preview.stop(midi)} onLostPointerCapture={() => preview.stop(midi)} onBlur={() => preview.stop(midi)}
    onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); if (!event.repeat) preview.start(midi); } }}
    onKeyUp={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); preview.stop(midi); } }}>
    {!black && midi % 12 === 0 ? instrumentNoteName(midi) : ""}</button>;
  return <div className="instrument-keyboard-section shrink-0 px-4 py-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><span>KEYBOARD <span className="instrument-subtle">· isolated audition</span></span>{output && <div className="instrument-output-control">{output}</div>}<span role="status">{preview.error}</span>
      <button className="instrument-text-button" type="button" onClick={() => { preview.stopAll(); setHidden(!hidden); }}>{hidden ? "Show keyboard" : "Hide keyboard"}</button></div>
    {!hidden && <div className="instrument-keyboard flex" aria-label="Audition keyboard">{cells.map(cell => <div key={cell.white} className="instrument-key-cell relative min-w-0 flex-1">{key(cell.white, false)}{cell.black !== undefined && key(cell.black, true)}</div>)}</div>}
  </div>;
}

// Isolate the 20 Hz native snapshot from all parameter controls.
export function InstrumentPerformanceReadout({ piano = false }: { props: ApprovedEffectEditorProps; piano?: boolean }) {
  const meters = useInstrumentPerformance();
  const performance = meters?.instrumentPerformance;
  const event = meters?.midiNoteEvent;
  const validEvent = event && event.length >= 3 && event[0] > 0 && event[1] >= 0 && event[1] < 128;
  const notes = performance?.notes.filter(item => item.held);
  const maximum = (values?: number[]) => values?.length ? Math.max(...values) : null;
  return <div className="instrument-performance flex shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 px-4 py-2 text-xs" aria-label="Native instrument performance">
    <span>{notes ? notes.length ? `Held input keys: ${notes.slice(0, 8).map(item => `${instrumentNoteName(item.note)} · ch ${item.channel}`).join(", ")}${notes.length > 8 ? ` · +${notes.length - 8} more` : ""}` : "No held input keys" : validEvent ? `Last input: ${instrumentNoteName(event[1])} · ch ${event[2]}` : "Live input key state unavailable"}</span>
    {piano && <div className="flex gap-4">{([["Soft", "soft"], ["Sostenuto", "sostenuto"], ["Sustain", "sustain"]] as const).map(([label, field]) => {
      const value = maximum(performance?.[field]); return <span key={field} className="instrument-pedal-readout inline-flex items-center gap-[6px]" data-down={value !== null && value > 0}><i aria-hidden="true" />{label} <b>{value === null ? "—" : `${Math.round(value * 100)}%`}</b></span>;
    })}</div>}
  </div>;
}

export function InstrumentWaveform({ shape, name }: { shape: number; name: string }) {
  const y = (x: number) => shape === 0 ? 49 - (x % 62) / 62 * 34 : shape === 1 ? x % 62 < 31 ? 15 : 49 : shape === 2 ? 15 + Math.abs((x % 62) / 31 - 1) * 34 : 32 - Math.sin(x / 62 * Math.PI * 2) * 17;
  return <svg className="instrument-wave w-full" viewBox="0 0 248 64" role="img" aria-label={`${name} waveform schematic`}><title>Waveform shape schematic, not a live signal</title><path className="instrument-gridline" d="M0 32H248 M62 5V59 M124 5V59 M186 5V59" /><path className="instrument-curve" d={Array.from({ length: 249 }, (_, x) => `${x ? "L" : "M"}${x} ${y(x).toFixed(2)}`).join(" ")} /></svg>;
}
export function InstrumentEnvelope({ schema, filter = false }: { schema: BuiltInPluginSchema; filter?: boolean }) {
  const ids = filter ? ["filterAttackMs", "filterDecayMs", "filterSustain", "filterReleaseMs"] : ["attackMs", "decayMs", "sustain", "releaseMs"];
  const attack = 18 + Math.sqrt(instrumentValue(schema, ids[0]) / 5000) * 65;
  const decay = attack + 20 + Math.sqrt(instrumentValue(schema, ids[1]) / 5000) * 65;
  const sustain = 76 - instrumentValue(schema, ids[2]) * 57;
  const release = Math.min(314, 235 + Math.sqrt(instrumentValue(schema, ids[3]) / (filter ? 10000 : 5000)) * 70);
  return <svg className="instrument-envelope w-full" viewBox="0 0 326 102" role="img" aria-label={`${filter ? "Filter" : "Amplifier"} envelope schematic`}><title>Control-based envelope schematic; not a time-scaled audio measurement</title><path className="instrument-gridline" d="M12 20H315 M12 48H315 M12 76H315" /><path className="instrument-envelope-fill" d={`M12 76L${attack} 19L${decay} ${sustain}H224L${release} 76Z`} /><path className="instrument-curve" d={`M12 76L${attack} 19L${decay} ${sustain}H224L${release} 76`} />{["A", "D", "S", "R"].map((label, i) => <text key={label} x={20 + i * 90} y="96">{label}</text>)}</svg>;
}
