import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { nativeBridge, type BuiltInPluginSchema } from "../../services/NativeBridge";
import type { EQToolbarProps } from "./EQToolbar";

export function SynthMacroLearn(props: EQToolbarProps & { slot: number; onSlotChange: (slot: number) => void }) {
  const { address, slot, schema, onFlush } = props;
  const [meters, setMeters] = useState<BuiltInPluginSchema["visualization"]>(undefined);
  const [learning, setLearning] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const armed = useRef<{ serial: number; until: number; fingerprint: string } | null>(null);
  const mounted = useRef(true), applying = useRef(false), revision = useRef(0);
  const latest = useRef(props); latest.current = props;
  const fingerprint = JSON.stringify(schema.parameters.filter(p => p.id.startsWith("macro")).map(p => [p.id, p.value]));
  const currentFingerprint = useRef(fingerprint); currentFingerprint.current = fingerprint;
  useEffect(() => { ++revision.current; armed.current = null; setLearning(false); setMessage(""); }, [slot, fingerprint, props.historyReplayRevision, address.instanceId, address.trackId, address.chain, address.fxIndex]);
  useEffect(() => {
    mounted.current = true; let polling = false, cancelled = false;
    const poll = async () => {
      if (polling || applying.current || document.hidden) return; polling = true;
      const armAtRequest = armed.current; let ownsOperation = false;
      try {
        const next = await nativeBridge.getBuiltInPluginMeters(address);
        if (!mounted.current || cancelled) return; setMeters(next ?? undefined);
        const capture = armed.current, event = next?.midiCCEvent;
        if (!capture || capture !== armAtRequest) return;
        if (Date.now() >= capture.until) { armed.current = null; setLearning(false); setMessage("No controller received within 30 seconds."); return; }
        if (!event || event.length !== 4 || !event.every(Number.isFinite) || event[0] === capture.serial || event[0] <= 0) return;
        if (!Number.isInteger(event[1]) || event[1] < 0 || event[1] > 119 || !Number.isInteger(event[2]) || event[2] < 1 || event[2] > 16) return;
        armed.current = null; setLearning(false); applying.current = true; ownsOperation = true; setBusy(true);
        const targetSlot = latest.current.slot;
        if (capture.fingerprint !== currentFingerprint.current) throw new Error("Macro settings changed; learn again.");
        if (!await latest.current.onFlush()) throw new Error("Pending macro changes failed");
        if (!mounted.current || cancelled || targetSlot !== latest.current.slot || capture.fingerprint !== currentFingerprint.current) return;
        if (!await latest.current.onApplyValues({ [`macro${targetSlot}CC`]: event[1] + 1, [`macro${targetSlot}Channel`]: event[2] })) throw new Error("Could not save the controller mapping");
        if (mounted.current && !cancelled) setMessage(`Macro ${latest.current.slot}: CC ${event[1]}, channel ${event[2]}. Undo restores the previous mapping.`);
      } catch (reason) {
        if (mounted.current && !cancelled) { armed.current = null; setLearning(false); setMessage(reason instanceof Error ? reason.message : "Controller input is unavailable"); }
      } finally { polling = false; if (ownsOperation) { applying.current = false; if (mounted.current && !cancelled) setBusy(false); } }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 200);
    return () => { cancelled = true; mounted.current = false; armed.current = null; clearInterval(timer); };
  }, [address.instanceId, address.trackId, address.chain, address.fxIndex]);
  const learn = async () => {
    if (busy || applying.current) return; applying.current = true; setBusy(true); setMessage("");
    try {
      if (!await onFlush()) throw new Error("Pending macro changes failed");
      const requestRevision = revision.current;
      const next = await nativeBridge.getBuiltInPluginMeters(address);
      if (!mounted.current || requestRevision !== revision.current) return;
      if (!next?.midiCCEvent) throw new Error("MIDI Learn requires the native Synth");
      armed.current = { serial: next.midiCCEvent[0] ?? 0, until: Date.now() + 30000, fingerprint: currentFingerprint.current };
      setLearning(true); setMessage("Move one MIDI controller, or play its CC events. The latest new CC selects the mapping.");
    } catch (reason) { if (mounted.current) setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { applying.current = false; if (mounted.current) setBusy(false); }
  };
  const live = meters?.macroLive?.[slot - 1], isMidi = meters?.macroActive?.[slot - 1] ?? false;
  return <section className="flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-y-auto px-4 py-2 text-xs" aria-label="Synth macro MIDI mapping">
    <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2">Macro<select className={editorSelect} aria-label="Macro to map" value={slot} disabled={busy} onChange={event => props.onSlotChange(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>Macro {value}</option>)}</select></label>
      <button className={editorButton} disabled={busy || learning} onClick={() => void learn()}>Learn controller</button>
      {learning && <button className={editorButton} onClick={() => { armed.current = null; setLearning(false); setMessage("MIDI Learn cancelled."); }}>Cancel learn</button>}
    <p className="ml-auto text-lg tabular-nums" aria-label="Macro control target">{Number.isFinite(live) ? `${Math.round(live! * 100)}%` : "Unavailable"}<span className="ml-2 text-xs text-daw-text-muted">{isMidi ? "MIDI target" : "Saved base value"}</span></p></div>
    <p role="status" className="min-h-4 text-daw-text-muted">{busy ? "Saving mapping..." : message || "Choose a controller and channel below, or learn from an incoming CC. Learn saves both as one Undo step."}</p>
    <details className="text-daw-text-muted"><summary className="cursor-pointer text-[10px]">How controller mappings work</summary><p className="mt-2 text-[10px] leading-relaxed text-daw-text-muted">Assign this macro as a Matrix source. Incoming CC values temporarily override its saved knob and use the matrix's smoothing. A manual knob edit, relevant Reset All Controllers or processor reset returns to the base value. Mapping does not consume the CC's other functions. Presets and Compare save mappings and base values; they exclude live controller positions.</p></details>
  </section>;
}
