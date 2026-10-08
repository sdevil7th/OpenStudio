import { editorButton, editorSelect } from "./PluginEditorControls";
﻿import { useEffect, useRef, useState } from "react";
import { EQAnalyzerHistory, type AnalyzerFrame, type AnalyzerSettings, type AnalyzerSnapshot } from "../../utils/eqAnalyzerHistory";

export function useEQAnalyzer(frame: AnalyzerFrame, settings: AnalyzerSettings, identity: string, reset: number) {
  const history = useRef(new EQAnalyzerHistory());
  const [snapshot, setSnapshot] = useState<AnalyzerSnapshot>({ frequencies: [], pre: [], post: [], ready: false });
  useEffect(() => { history.current.reset(); }, [identity, reset]);
  useEffect(() => {
    setSnapshot(history.current.update(frame, settings, performance.now()));
  }, [frame.frequencies, frame.spectrumPreDb, frame.spectrumPostDb, frame.spectrumExternalDb, frame.spectrumReady, settings, identity, reset]);
  return snapshot;
}

export function AnalyzerDisplayControls({ settings, onChange, onClear, resolution, source, onResolution, onSource, windowMs, binHz, autoGrab, onAutoGrab }: {
  autoGrab: boolean; onAutoGrab: (enabled: boolean) => void;
  resolution: number; source: number; onResolution: (size: number) => void; onSource: (source: number) => void; windowMs?: number; binHz?: number;
  settings: AnalyzerSettings; onChange: (settings: AnalyzerSettings) => void; onClear: () => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  return <details ref={details} className="relative">
    <summary className={`${editorButton} list-none`} aria-label="Analyzer display settings">Display</summary>
    <div className="absolute right-0 top-9 z-30 flex w-64 flex-col gap-3 rounded border border-daw-border-light bg-daw-panel p-3 shadow-xl" aria-label="Analyzer display controls">
      <label className="flex items-center justify-between gap-2">Resolution<select className={editorSelect} aria-label="Analyzer resolution" value={resolution} onChange={e => onResolution(Number(e.target.value))}>{[1024,2048,4096,8192].map(value => <option key={value} value={value}>{value} samples</option>)}</select></label>
      <label className="flex items-center justify-between gap-2">Source<select className={editorSelect} aria-label="Analyzer channel source" value={source} onChange={e => onSource(Number(e.target.value))}><option value={0}>Left</option><option value={1}>Right</option><option value={2}>Stereo power</option></select></label>
      {windowMs !== undefined && binHz !== undefined && <p className="text-[10px] text-daw-text-muted" aria-label="Analyzer window detail">{windowMs.toFixed(1)} ms window / {binHz.toFixed(2)} Hz per bin</p>}
      <label className="flex items-center justify-between gap-2">Range<select className={editorSelect} aria-label="Analyzer range" value={settings.range} onChange={e => onChange({ ...settings, range: Number(e.target.value) })}>{[60,90,120].map(value => <option key={value} value={value}>{value} dB</option>)}</select></label>
      <label className="flex items-center justify-between gap-2">Release<select className={editorSelect} aria-label="Analyzer release" value={settings.release} onChange={e => onChange({ ...settings, release: Number(e.target.value) })}><option value={0}>Instant</option><option value={60}>Fast · 60 dB/s</option><option value={24}>Medium · 24 dB/s</option><option value={6}>Slow · 6 dB/s</option></select></label>
      <label className="flex items-center justify-between gap-2">Tilt<select className={editorSelect} aria-label="Analyzer tilt" value={settings.tilt} onChange={e => onChange({ ...settings, tilt: Number(e.target.value) })}>{[0,3,4.5].map(value => <option key={value} value={value}>{value} dB/oct</option>)}</select></label>
      <label className="flex items-center justify-between gap-2">Automatic Spectrum Grab<input type="checkbox" aria-label="Automatic Spectrum Grab" checked={autoGrab} onChange={event => onAutoGrab(event.target.checked)} /></label>
      <p className="text-[10px] leading-relaxed text-daw-text-muted">When enabled, rest the mouse near the spectrum for 1.8 seconds to capture it. Moving, dragging or leaving cancels the wait. Audio changes only when a bell is applied.</p>
      <div className="flex gap-2"><button className={editorButton} aria-pressed={settings.hold} onClick={() => onChange({ ...settings, hold: !settings.hold })}>Hold peaks</button><button className={editorButton} aria-pressed={settings.paused} onClick={() => onChange({ ...settings, paused: !settings.paused })}>Pause</button><button className={editorButton} onClick={onClear}>Clear</button></div>
      <p className="text-[10px] leading-relaxed text-daw-text-muted">View only, for this window. Larger FFT windows take longer to fill. Stereo power averages L/R energy. Tilt pivots at 1 kHz. Hold accumulates peaks; Pause keeps a snapshot. Clear resumes from current input. EQ response and audio stay unchanged.</p>
    </div>
  </details>;
}
