import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef } from "react";
import { eqFrequencyWindow } from "../../utils/eqFrequencyView";
import { ProfiledRangeInput } from "../ui/ProfiledRangeInput";

export function EQFrequencyView({ minimum = 20, maximum = 20000, zoom, center, gainRange, selectedFrequency, selectedGain, onChange }: { minimum?: number; maximum?: number; zoom: number; center: number; gainRange: number; selectedFrequency: number; selectedGain: number; onChange: (zoom: number, center: number, gainRange: number) => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const view = eqFrequencyWindow(zoom, center, minimum, maximum);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  return <details ref={details} className="relative">
    <summary className={`${editorButton} list-none`} aria-label="EQ frequency view">View{zoom > 1 ? ` ${zoom}x` : ""}</summary>
    <div className="absolute right-0 top-9 z-30 flex w-64 flex-col gap-3 rounded border border-daw-border-light bg-daw-panel p-3 shadow-xl" aria-label="EQ frequency view controls">
      <label className="flex items-center justify-between gap-2">Zoom<select className={editorSelect} aria-label="Frequency zoom" value={zoom} onChange={event => onChange(Number(event.target.value), center, gainRange)}>{[1, 2, 4, 8].map(value => <option key={value} value={value}>{value}x</option>)}</select></label>
      <label className="flex items-center justify-between gap-2">Center (Hz)<input className={`${editorSelect} w-28`} type="number" min={minimum} max={maximum} step={1} aria-label="Frequency view center" disabled={zoom === 1} value={Math.round(view.center)} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value > 0) onChange(zoom, value, gainRange); }} /></label>
      <ProfiledRangeInput wheelPolicy="navigation" className="w-full accent-daw-accent" aria-label="Pan frequency view" min={Math.log(minimum)} max={Math.log(maximum)} step={.005} disabled={zoom === 1} value={Math.log(view.center)} onValueChange={next => onChange(zoom, Math.exp(next), gainRange)} />
      <label className="flex items-center justify-between gap-2">Gain scale<select className={editorSelect} aria-label="Gain display range" value={gainRange} onChange={event => onChange(zoom, center, Number(event.target.value))}>{[3,6,12,30].map(value => <option key={value} value={value}>+/-{value} dB</option>)}</select></label>
      <div className="flex gap-2"><button className={editorButton} onClick={() => onChange(Math.max(4, zoom), selectedFrequency, Math.max(gainRange, [3,6,12,30].find(value => value >= Math.abs(selectedGain)) ?? 30))}>Focus band</button><button className={editorButton} onClick={() => onChange(1, Math.sqrt(minimum * maximum), 30)}>Full range</button></div>
      <p className="text-[10px] text-daw-text-muted" aria-label="Visible frequency range">{Math.round(view.min)}-{Math.round(view.max)} Hz</p>
      <p className="text-[10px] leading-relaxed text-daw-text-muted">View only, for this window. Focus band reveals the selected filter. Offscreen bands stay in the inspector. Grab captures visible frequencies. Changing the view exits an unapplied capture.</p>
    </div>
  </details>;
}
