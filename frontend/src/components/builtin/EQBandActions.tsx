import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useId, useRef, useState } from "react";
import { nativeBridge } from "../../services/NativeBridge";
import { applyEQBandValues, EQ_BAND_CLIPBOARD_KEY, freeEQBand, parseEQBandClipboard, readEQBand } from "../../utils/eqBandClipboard";
import { findBuiltInParameter, expandedBuiltInParamId } from "../../utils/builtInExpandedSelectors";
import { eqFrequencyNote, parseEQFrequency } from "../../utils/eqMusicalFrequency";
import type { EQToolbarProps } from "./EQToolbar";

type Action = "copy" | "paste" | "duplicate" | "flip" | "reset" | "remove" | "tune" | "splitLR" | "splitMS";
export function EQBandActions({ schema, address, onFlush, onApplyValues, selected, label, onSelected }: Pick<EQToolbarProps, "schema" | "address" | "onFlush" | "onApplyValues"> & { selected: number; label: string; onSelected: (band: number) => void }) {
  const details = useRef<HTMLDetailsElement>(null), busy = useRef(false), mounted = useRef(true);
  const [pending, setPending] = useState(false), [status, setStatus] = useState("");
  const [frequencyEntry, setFrequencyEntry] = useState("");
  const frequencyEntryId = useId();
  const entryHz = parseEQFrequency(frequencyEntry);
  const values = readEQBand(schema, selected), free = freeEQBand(schema, selected);
  useEffect(() => {
    mounted.current = true;
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { mounted.current = false; document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  useEffect(() => { setStatus(""); if (details.current) details.current.open = false; }, [selected]);
  const act = async (action: Action) => {
    if (busy.current) return; busy.current = true; setPending(true); setStatus("");
    try {
      if (!await onFlush() || !mounted.current) return;
      const current = await nativeBridge.getBuiltInPluginSchema(address);
      if (!current || !mounted.current) throw new Error("The EQ is unavailable. Reopen its editor.");
      const source = readEQBand(current, selected);
      if (source.freq === undefined) throw new Error("This band is unavailable.");
      if (action === "copy") {
        localStorage.setItem(EQ_BAND_CLIPBOARD_KEY, JSON.stringify({ version: 1, values: source }));
        setStatus("Band copied to the local EQ clipboard."); return;
      }
      if (action === "splitLR" || action === "splitMS") {
        if (!source.enabled || source.target !== 0 || (current.parameters.find(p => p.id === "stereoMode")?.value ?? 0) !== 0) throw new Error("Split requires an enabled Stereo band and global Stereo processing.");
        const left = action === "splitLR" ? 1 : 3;
        const count = current.parameters.filter(p => /^band\d+\.enabled$/.test(p.id)).length;
        const empty = Array.from({ length: count }, (_, band) => band).find(band => {
          const destination = readEQBand(current, band);
          if (band === selected || destination.enabled || destination.type === 3 || destination.type === 4) return false;
          for (let between = Math.min(selected, band) + 1; between < Math.max(selected, band); ++between) {
            const other = readEQBand(current, between);
            if (other.enabled && other.target !== 0 && other.target !== left && other.target !== left + 1) return false;
          }
          return true;
        });
        if (empty === undefined) throw new Error("Free an adjacent band before splitting across mixed L/R and M/S filters.");
        const changes = { ...applyEQBandValues(current, selected, { target: left }), ...applyEQBandValues(current, empty, { ...source, target: left + 1 }) };
        if (!await onApplyValues(changes)) throw new Error("Could not split the band. Check the editor status.");
        if (mounted.current) { if (details.current) details.current.open = false; onSelected(selected); }
        return;
      }
      let target = selected, next = source;
      if (action === "paste" || action === "duplicate") {
        const empty = freeEQBand(current, selected);
        if (empty === null) throw new Error("No unused non-cut band is available.");
        target = empty;
        if (action === "paste") {
          const copied = parseEQBandClipboard(localStorage.getItem(EQ_BAND_CLIPBOARD_KEY));
          if (!copied) throw new Error("Copy an EQ band first. The local clipboard is empty or invalid.");
          next = { ...readEQBand(current, target, true), ...copied };
        }
        next = { ...next, enabled: 1 };
      } else if (action === "flip") {
        if (((source.type ?? 0) > 2 && (source.type ?? 0) < 8) || source.allPass === 1) throw new Error("This filter shape has no gain to flip.");
        next = { gain: -(source.gain ?? 0), dynamicRange: -(source.dynamicRange ?? 0) };
      } else if (action === "tune") {
        const hz = parseEQFrequency(frequencyEntry), parameter = findBuiltInParameter(current, `band${selected}.freq`);
        if (hz === null || !parameter || hz < parameter.min || hz > parameter.max) throw new Error(`Enter a frequency from ${parameter?.min ?? 20} to ${parameter?.max ?? 20000} Hz.`);
        next = { freq: hz };
      } else if (action === "reset") next = readEQBand(current, selected, true);
      else if (action === "remove") next = { enabled: 0 };
      const changes = applyEQBandValues(current, target, next);
      if (action === "remove" || action === "reset") {
        const audition = expandedBuiltInParamId(current, "auditionBand");
        for (const id of [audition, "detectorListenBand"])
          if (current.parameters.find(p => p.id === id)?.value === selected + 1) changes[id] = 0;
      }
      if (!mounted.current) return;
      if (!await onApplyValues(changes)) throw new Error("Could not update the band. Check the editor status.");
      if (mounted.current) { if (details.current) details.current.open = false; onSelected(target); setStatus(""); }
    } catch (error) { if (mounted.current) setStatus(error instanceof Error ? error.message : "Could not complete the band action."); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  return <details ref={details} className="relative">
    <summary className={`${editorButton} eq-band-actions-trigger list-none font-medium`} aria-label={`${label} actions`} onClick={() => { if (!details.current?.open) { setFrequencyEntry(String(values.freq ?? 1000)); setStatus(""); } }}><span className="eq-band-actions-label">{label}</span><span className="eq-band-actions-compact">Actions</span> <span aria-hidden="true">▾</span></summary>
    <div className="absolute bottom-9 left-0 z-30 flex max-h-[min(60dvh,360px)] w-60 flex-col gap-1 overflow-y-auto rounded border border-daw-border-light bg-daw-panel p-2 shadow-xl [&>*]:shrink-0" aria-label="EQ band actions">
      <label className="flex items-center gap-2 text-xs">Select band<select className={`${editorSelect} min-w-0 flex-1`} aria-label="Selected EQ band" value={selected} onChange={event => onSelected(Number(event.target.value))}>{schema.parameters.filter(parameter => /^band\d+\.enabled$/.test(parameter.id)).map((parameter, index) => <option key={parameter.id} value={index}>Band {index + 1}{parameter.value >= .5 ? "" : " (off)"}</option>)}</select></label>
      <button className={`${editorButton} justify-start`} disabled={pending} onClick={() => void act("copy")}>Copy band</button>
      <button className={`${editorButton} justify-start`} disabled={pending || free === null} onClick={() => void act("paste")}>Paste as new band</button>
      <button className={`${editorButton} justify-start`} disabled={pending || free === null || !values.enabled} onClick={() => void act("duplicate")}>Duplicate band</button>
      {values.target !== undefined && <><button className={`${editorButton} justify-start`} disabled={pending || free === null || !values.enabled || values.target !== 0 || (schema.parameters.find(p => p.id === "stereoMode")?.value ?? 0) !== 0} onClick={() => void act("splitLR")}>Split into Left / Right</button><button className={`${editorButton} justify-start`} disabled={pending || free === null || !values.enabled || values.target !== 0 || (schema.parameters.find(p => p.id === "stereoMode")?.value ?? 0) !== 0} onClick={() => void act("splitMS")}>Split into Mid / Side</button></>}
      <button className={`${editorButton} justify-start`} disabled={pending || ((values.type ?? 0) > 2 && (values.type ?? 0) < 8) || values.allPass === 1} onClick={() => void act("flip")}>Flip gain and range</button>
      <button className={`${editorButton} justify-start`} disabled={pending} onClick={() => void act("reset")}>Reset band</button>
      <button className={`${editorButton} justify-start`} disabled={pending || !values.enabled} onClick={() => void act("remove")}>Remove band</button>
      <form className="mt-1 flex flex-col gap-1 border-t border-daw-border-light px-1 pt-2" onSubmit={event => { event.preventDefault(); void act("tune"); }}>
        <label className="text-[10px] text-daw-text-muted" htmlFor={frequencyEntryId}>Frequency: Hz, kHz or note</label>
        <div className="flex gap-1"><input id={frequencyEntryId} className={`${editorSelect} min-w-0 flex-1`} aria-label="Musical frequency entry" value={frequencyEntry} disabled={pending} placeholder="A4, C#3+12, 2k" onChange={event => setFrequencyEntry(event.target.value)} /><button className={editorButton} disabled={pending || entryHz === null}>Apply</button></div>
        <output className="min-h-4 text-[10px] text-daw-text-muted" aria-label="Frequency entry preview">{entryHz === null ? "A4 = 440 Hz; # or b, octave, optional cents." : `${Number(entryHz.toFixed(3))} Hz / ${eqFrequencyNote(entryHz)} (A4 = 440 Hz)`}</output>
      </form>
      <p className="px-1 py-2 text-[10px] leading-4 text-daw-text-muted" role="status">{pending ? "Updating band..." : status || "Paste and Duplicate use an unused non-cut band. Each edit is one Undo step. The EQ clipboard is shared by editors using this browser storage; it is separate from the system clipboard."}</p>
    </div>
  </details>;
}
