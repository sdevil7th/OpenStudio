import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { nativeBridge } from "../../services/NativeBridge";
import { eqBandGroupChanges, EQ_GROUP_CLIPBOARD_KEY, parseEQGroupClipboard, pasteEQBandGroup, type EQGroupAction } from "../../utils/eqBandGroup";
import { readEQBand } from "../../utils/eqBandClipboard";
import type { EQToolbarProps } from "./EQToolbar";

export function EQBandGroup({ schema, address, onFlush, onApplyValues, selected, bands, setBands }: Pick<EQToolbarProps, "schema" | "address" | "onFlush" | "onApplyValues"> & { selected: number; bands: number[]; setBands: (next: number[] | ((current: number[]) => number[])) => void }) {
  const details = useRef<HTMLDetailsElement>(null), busy = useRef(false), mounted = useRef(true);
  const [action, setAction] = useState<EQGroupAction>("offset");
  const [semitones, setSemitones] = useState("0"), [gain, setGain] = useState("0"), [status, setStatus] = useState(""), [pending, setPending] = useState(false);
  const [factor, setFactor] = useState("1");
  const available = schema.parameters.filter(p => /^band\d+\.enabled$/.test(p.id)).map(p => ({ band: Number(p.id.slice(4, p.id.indexOf("."))), enabled: p.value >= .5 }));
  useEffect(() => {
    mounted.current = true;
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { mounted.current = false; document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  const apply = async (clipboard?: "copy" | "paste") => {
    if (busy.current) return; busy.current = true; setPending(true); setStatus("");
    try {
      if (!await onFlush() || !mounted.current) return;
      const current = await nativeBridge.getBuiltInPluginSchema(address);
      if (!current || !mounted.current) return;
      if (clipboard === "copy") {
        if (!bands.length) throw new Error("Select at least one band.");
        localStorage.setItem(EQ_GROUP_CLIPBOARD_KEY, JSON.stringify({ version: 1, bands: bands.map(band => readEQBand(current, band)) }));
        setStatus(`Copied ${bands.length} bands to the local group clipboard.`); return;
      }
      if (clipboard === "paste") {
        const copied = parseEQGroupClipboard(localStorage.getItem(EQ_GROUP_CLIPBOARD_KEY));
        if (!copied) throw new Error("Copy a group first. Its local clipboard is empty or invalid.");
        const pasted = pasteEQBandGroup(current, copied, bands);
        if (!await onApplyValues(pasted.changes)) throw new Error("Could not paste the group. Check the editor status.");
        if (mounted.current) { setBands(pasted.bands); setStatus(`Pasted ${pasted.bands.length} bands. Undo restores the whole group.`); }
        return;
      }
      if (action === "offset" && (!semitones.trim() || !gain.trim())) throw new Error("Enter both offsets, using 0 for no change.");
      if ((action === "gainScale" || action === "qScale") && !factor.trim()) throw new Error("Enter a multiplier.");
      const changes = eqBandGroupChanges(current, bands, action, Number(semitones), Number(gain), Number(factor));
      if (!await onApplyValues(changes)) throw new Error("Could not apply the group edit. Check the editor status.");
      if (mounted.current) { setStatus(`Updated ${bands.length} ${bands.length === 1 ? "band" : "bands"}. Undo restores the whole group.`); setSemitones("0"); setGain("0"); setFactor("1"); }
    } catch (error) { if (mounted.current) setStatus(error instanceof Error ? error.message : "Group edit failed."); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  return <details ref={details} className="relative">
    <summary className={`${editorButton} list-none`} aria-label="Group EQ bands" onClick={() => { if (!details.current?.open) { if (!bands.length) setBands([selected]); setStatus(""); setSemitones("0"); setGain("0"); setFactor("1"); } }}>Group</summary>
    <div className="absolute bottom-9 left-0 z-30 flex w-80 max-w-[85vw] flex-col gap-2 rounded border border-daw-border-light bg-daw-panel p-3 shadow-xl" aria-label="EQ band group controls">
      <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">Group bands</p><div className="flex gap-1"><button className={editorButton} aria-label="Copy band group" disabled={pending || !bands.length} onClick={() => void apply("copy")}>Copy</button><button className={editorButton} aria-label="Paste band group" disabled={pending} onClick={() => void apply("paste")}>Paste</button></div></div>
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-1">
        <legend className="sr-only">Choose EQ bands</legend>
        <div className="grid grid-cols-6 gap-1">{available.map(({ band, enabled }) => <label key={band} className="flex min-h-6 items-center justify-center gap-1 rounded border border-daw-border-light text-xs" title={`Band ${band + 1}, ${enabled ? "enabled" : "bypassed"}`}><input type="checkbox" className="accent-daw-accent" aria-label={`Group band ${band + 1}`} checked={bands.includes(band)} onChange={event => setBands(current => event.target.checked ? [...current, band] : current.filter(value => value !== band))} />{band + 1}</label>)}</div>
        <div className="flex gap-1"><button className={editorButton} onClick={() => setBands(available.filter(p => p.enabled).map(p => p.band))}>Enabled bands</button><button className={editorButton} onClick={() => setBands(available.map(p => p.band))}>All</button><button className={editorButton} onClick={() => setBands([])}>None</button></div>
        <label className="flex items-center justify-between gap-2 text-xs">Action<select className={editorSelect} aria-label="Group band action" value={action} onChange={event => setAction(event.target.value as EQGroupAction)}><option value="offset">Relative offsets</option><option value="gainScale">Scale gain and range</option><option value="qScale">Scale Q</option><option value="flip">Flip gain and range</option><option value="enable">Enable</option><option value="bypass">Bypass</option><option value="reset">Reset to defaults</option></select></label>
        {action === "offset" && <><label className="flex items-center justify-between gap-2 text-xs">Frequency shift (st)<input className={`${editorSelect} w-24`} type="number" min={-48} max={48} step={.1} aria-label="Group frequency shift" value={semitones} onChange={event => setSemitones(event.target.value)} /></label><label className="flex items-center justify-between gap-2 text-xs">Gain offset (dB)<input className={`${editorSelect} w-24`} type="number" min={-30} max={30} step={.1} aria-label="Group gain offset" value={gain} onChange={event => setGain(event.target.value)} /></label></>}
        {(action === "gainScale" || action === "qScale") && <label className="flex items-center justify-between gap-2 text-xs">Multiplier<input className={`${editorSelect} w-24`} type="number" min={action === "qScale" ? .125 : 0} max={action === "qScale" ? 8 : 2} step={.125} aria-label="Group scale multiplier" value={factor} onChange={event => setFactor(event.target.value)} /></label>}
        <button className={editorButton} disabled={!bands.length} onClick={() => void apply()}>{pending ? "Applying..." : `Apply to ${bands.length} ${bands.length === 1 ? "band" : "bands"}`}</button>
      </fieldset>
      <p className="text-[10px] leading-4 text-daw-text-muted" role="status">{status || "One Undo step. Paste uses unused bands. Gain actions affect bells/shelves. Offsets reject the whole edit at a range limit."}</p>
    </div>
  </details>;
}
