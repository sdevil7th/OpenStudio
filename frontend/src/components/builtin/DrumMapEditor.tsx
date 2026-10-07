import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";

type Props = { schema: BuiltInPluginSchema; address: BuiltInPluginAddress; onApply: (values: Record<string, number>) => Promise<boolean>; onClose: () => void };
export function DrumMapEditor({ schema, address, onApply, onClose }: Props) {
  const saved = Array.from({ length: 128 }, (_, note) => schema.parameters.find(p => p.id === `noteMap${note}`)?.value ?? note);
  const savedEnabled = (schema.parameters.find(p => p.id === "customMapEnabled")?.value ?? 0) >= .5;
  const fingerprint = JSON.stringify([savedEnabled, saved]);
  const [mapping, setMapping] = useState(saved), [enabled, setEnabled] = useState(savedEnabled), [input, setInput] = useState(36);
  const [busy, setBusy] = useState(false), [learning, setLearning] = useState(false), [message, setMessage] = useState("");
  const armed = useRef<{ serial: number; until: number } | null>(null), mounted = useRef(true);
  useEffect(() => { setMapping(JSON.parse(fingerprint)[1]); setEnabled(JSON.parse(fingerprint)[0]); armed.current = null; setLearning(false); }, [fingerprint]);
  useEffect(() => {
    mounted.current = true; let cancelled = false, pending = false;
    const poll = async () => {
      if (!armed.current || pending || document.hidden) return;
      if (Date.now() > armed.current.until) { armed.current = null; setLearning(false); setMessage("No new note received. Choose an input manually or learn again."); return; }
      pending = true;
      try { const event = (await nativeBridge.getBuiltInPluginMeters(address))?.midiNoteEvent;
        if (cancelled || !armed.current || !event || event[0] === armed.current.serial || event[1] < 0 || event[1] > 127) return;
        setInput(event[1]); armed.current = null; setLearning(false); setMessage(`Selected MIDI input ${event[1]}. Choose its destination and Apply.`);
      } catch { if (!cancelled) { armed.current = null; setLearning(false); setMessage("MIDI input is unavailable."); } }
      finally { pending = false; }
    };
    const timer = setInterval(() => { void poll(); }, 200);
    return () => { cancelled = true; mounted.current = false; armed.current = null; clearInterval(timer); };
  }, [address.instanceId, address.trackId, address.chain, address.fxIndex]);
  const learn = async () => {
    setBusy(true); setMessage("");
    try { const event = (await nativeBridge.getBuiltInPluginMeters(address))?.midiNoteEvent;
      if (!mounted.current) return;
      if (!event) throw Error("MIDI Learn requires the native Drums processor.");
      armed.current = { serial: event[0], until: Date.now() + 30000 }; setLearning(true); setMessage("Play one incoming MIDI note. The latest new note selects the input only.");
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const apply = async () => {
    if (busy) return; setBusy(true); armed.current = null; setLearning(false);
    const values: Record<string, number> = {};
    if (enabled !== savedEnabled) values.customMapEnabled = enabled ? 1 : 0;
    mapping.forEach((target, note) => { if (target !== saved[note]) values[`noteMap${note}`] = target; });
    try { if (Object.keys(values).length && !await onApply(values)) throw Error("The processor did not accept the map."); if (mounted.current) onClose(); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const changed = mapping.filter((target, note) => target !== note).length;
  return <Modal isOpen title="Drum MIDI map" onClose={() => { if (!busy) onClose(); }} size="lg">
    <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto p-1 text-sm">
      <p className="text-xs text-daw-text-muted">Custom mapping runs before the selected GM, Roland TD or Extended studio map. It applies to every MIDI channel. Each destination is an input note in that map; Ignore suppresses the note. Apply saves all changes as one Undo step.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />Enable custom mapping</label>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-2">Incoming note<select className={editorSelect} aria-label="Incoming drum note" value={input} disabled={busy} onChange={event => setInput(Number(event.target.value))}>{Array.from({ length: 128 }, (_, note) => <option key={note} value={note}>MIDI {note}</option>)}</select></label>
        <label className="flex flex-col gap-2">Destination<select className={editorSelect} aria-label="Drum destination note" value={mapping[input]} disabled={busy} onChange={event => setMapping(current => current.map((target, note) => note === input ? Number(event.target.value) : target))}><option value={-1}>Ignore</option>{Array.from({ length: 128 }, (_, note) => <option key={note} value={note}>Map note {note}</option>)}</select></label>
        <button className={editorButton} disabled={busy || learning} onClick={() => void learn()}>Learn input</button>
        {learning && <button className={editorButton} onClick={() => { armed.current = null; setLearning(false); setMessage("Learn cancelled."); }}>Cancel learn</button>}
      </div>
      <p role="status" className="min-h-8 text-xs text-daw-text-muted">{message || `${changed} non-identity assignments. Draft changes take effect only after Apply.`}</p>
      <div className="flex flex-wrap justify-between gap-3"><button className={editorButton} disabled={busy} onClick={() => setMapping(Array.from({ length: 128 }, (_, note) => note))}>Reset draft to identity</button><div className="flex gap-2"><button className={editorButton} disabled={busy} onClick={onClose}>Cancel</button><button className={editorButton} disabled={busy} onClick={() => void apply()}>{busy ? "Applying..." : "Apply map"}</button></div></div>
    </div>
  </Modal>;
}
