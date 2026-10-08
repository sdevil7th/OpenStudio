import { editorButton } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import type { AnalyzerFrame } from "../../utils/eqAnalyzerHistory";
import { captureSpectrumPeaks, type SpectrumPeak } from "../../utils/eqSpectrumPeaks";

export function EQPeakPicker({ frame, available, onAdd }: {
  frame: AnalyzerFrame; available: boolean; onAdd: (frequency: number) => Promise<boolean>;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [peaks, setPeaks] = useState<SpectrumPeak[] | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  const add = async (frequency: number) => {
    if (busy || !available) return; setBusy(true); setError("");
    try {
      if (await onAdd(frequency)) { if (details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } }
      else setError("Could not add the band. Capture again or free a band.");
    } catch { setError("Could not add the band. Try again."); }
    finally { setBusy(false); }
  };
  return <details ref={details} className="relative">
    <summary className={`${editorButton} list-none`} aria-label="Input spectrum peak list">Peaks</summary>
    <div className="absolute right-0 top-9 z-30 flex w-60 flex-col gap-2 rounded border border-daw-border-light bg-daw-panel p-3 shadow-xl" aria-label="Captured spectrum peaks">
      <p className="text-[11px] text-daw-text-muted">Capture the latest input frame. Choose a peak to add a 0 dB bell with Q 1, then adjust its gain.</p>
      <button className={editorButton} disabled={busy || !frame.spectrumReady} onClick={() => { setPeaks(captureSpectrumPeaks(frame)); setError(""); }}>Capture input peaks</button>
      {!frame.spectrumReady && <p className="text-[10px] text-daw-text-muted">Waiting for analyzer input.</p>}
      {peaks?.map(peak => <button key={peak.frequency} className={`${editorButton} justify-between`} disabled={busy || !available} aria-label={`Add bell at ${Math.round(peak.frequency)} Hz`} onClick={() => void add(peak.frequency)}><span>{Math.round(peak.frequency)} Hz</span><span className="text-daw-text-muted">{peak.db.toFixed(1)} dBFS</span></button>)}
      {peaks?.length === 0 && <p role="status" className="text-[11px] text-daw-text-muted">No distinct peaks above -90 dBFS in this frame.</p>}
      {!available && <p role="status" className="text-[11px] text-daw-text-muted">No unused non-cut band. Disable one to add a bell.</p>}
      {error && <p role="alert" className="text-[11px] text-daw-record">{error}</p>}
      <p className="text-[10px] text-daw-text-muted">Approximate display-grid peaks, independent of display tilt, hold and pause. No automatic correction.</p>
    </div>
  </details>;
}
