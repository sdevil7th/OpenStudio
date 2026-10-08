import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";
import { useDAWStore } from "../../store/useDAWStore";
import { analyzerPosition, type AnalyzerSettings } from "../../utils/eqAnalyzerHistory";
import { spectrumOverlap } from "../../utils/eqSpectrumOverlap";
import { useEQAnalyzer } from "./AnalyzerDisplayControls";

type Visualization = NonNullable<BuiltInPluginSchema["visualization"]>;
const colors = ["#e3ae75", "#ac9de0"];
const empty: Visualization = {};

export function useEQAnalyzerReferences(address: BuiltInPluginAddress, size: number, source: number, settings: AnalyzerSettings, reset: number, current: Visualization, active: boolean) {
  const [candidates, setCandidates] = useState<BuiltInPluginAddress[]>([]);
  const [selected, setSelected] = useState<[string, string]>(["", ""]);
  const [output, setOutput] = useState(true);
  const [overlap, setOverlap] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [frames, setFrames] = useState<Array<Visualization | null>>([null, null]);
  const { tracks } = useDAWStore(useShallow(s => ({ tracks: s.tracks })));
  const ownId = address.instanceId ?? "";
  const identity = `${ownId}:${address.chain}:${address.trackId}:${address.fxIndex}`;
  useEffect(() => { setSelected(["", ""]); setFrames([null, null]); }, [identity]);
  useEffect(() => {
    let retired = false;
    void nativeBridge.eqMatch("list").then(result => {
      if (retired) return;
      if (!result.success) { setError(result.error ?? "EQ instances unavailable"); setCandidates([]); return; }
      const others = (result.candidates ?? []).filter(item => item.instanceId && item.instanceId !== ownId
        && !(item.chain === address.chain && item.trackId === address.trackId && item.fxIndex === address.fxIndex));
      setCandidates(others); setError("");
      setSelected(previous => previous.map(id => others.some(item => item.instanceId === id) ? id : "") as [string, string]);
    }).catch(() => { if (!retired) { setError("EQ instances unavailable"); setCandidates([]); } });
    return () => { retired = true; };
  }, [identity, ownId, revision, address.chain, address.trackId, address.fxIndex]);
  useEffect(() => {
    let retired = false, pending = false;
    setFrames([null, null]);
    const poll = async () => {
      if (pending || !active || document.hidden) return;
      pending = true;
      const next = await Promise.all(selected.map(async id => {
        const candidate = candidates.find(item => item.instanceId === id);
        if (!candidate) return null;
        try {
          const frame = await nativeBridge.getBuiltInPluginMeters(candidate, size, source);
          return frame?.spectrumSize === size && frame.spectrumSource === source ? frame : null;
        } catch { return null; }
      }));
      if (!retired) setFrames(next);
      pending = false;
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 200);
    return () => { retired = true; window.clearInterval(timer); };
  }, [selected, candidates, size, source, active]);
  const first = useEQAnalyzer(frames[0] ?? empty, settings, `${identity}:${selected[0]}:${size}:${source}`, reset);
  const second = useEQAnalyzer(frames[1] ?? empty, settings, `${identity}:${selected[1]}:${size}:${source}`, reset);
  const snapshots = [first, second];
  const name = (item: BuiltInPluginAddress) => `${item.chain === "master" ? "Master" : item.chain === "monitor" ? "Monitor" : tracks.find(track => track.id === item.trackId)?.name ?? item.trackId ?? "Track"} / ${item.chain === "input" ? "Input" : "FX"} ${(item.fxIndex ?? 0) + 1}`;
  const labels = selected.map(id => candidates.find(item => item.instanceId === id)).map(item => item ? name(item) : "");
  const curves = active ? snapshots.flatMap((snapshot, i) => selected[i] && frames[i]?.spectrumReady && snapshot.ready ? [{
    id: `reference-${i}`, color: colors[i], opacity: .8, strokeWidth: 1.25,
    points: (output ? snapshot.post : snapshot.pre).map((db, bin) => ({ x: snapshot.frequencies[bin], y: analyzerPosition(db, snapshot.frequencies[bin], settings) })).filter(point => !frames[i]?.sampleRate || point.x < frames[i]!.sampleRate! * .5),
  }] : []) : [];
  // Overlap deliberately uses current raw frames, never accumulated/held display peaks.
  const regions = active && overlap && !settings.paused && !settings.hold && current.spectrumReady ? frames.flatMap((frame, i) => {
    if (!selected[i] || !frame?.spectrumReady) return [];
    return spectrumOverlap({ frequencies: current.frequencies ?? [], values: current.spectrumPostDb ?? [] },
      { frequencies: frame.frequencies ?? [], values: (output ? frame.spectrumPostDb : frame.spectrumPreDb) ?? [] })
      .map((region, j) => ({ ...region, end: Math.min(region.end, (current.sampleRate ?? 40000) * .5, (frame.sampleRate ?? 40000) * .5), id: `overlap-${i}-${j}`, color: colors[i], opacity: .12 }))
      .filter(region => region.end > region.start);
  }) : [];
  return { candidates, selected, setSelected, output, setOutput, overlap, setOverlap, refresh: () => setRevision(n => n + 1), error, name, labels, curves, regions,
    statuses: selected.map((id, i) => !id ? "Off" : !active ? "Hidden" : !frames[i]?.spectrumReady ? "Waiting / unavailable" : "Live"), colors };
}

export function EQAnalyzerReferences({ model }: { model: ReturnType<typeof useEQAnalyzerReferences> }) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  return <details ref={details} className="relative">
    <summary className={`${editorButton} list-none`} aria-label="Analyzer references">References</summary>
    <div className="absolute right-0 top-9 z-30 flex max-h-[65vh] w-64 flex-col gap-3 overflow-y-auto rounded border border-daw-border-light bg-daw-panel p-3 shadow-xl" aria-label="Analyzer reference controls">
      {[0, 1].map(index => <label key={index} className="flex min-w-0 flex-col gap-1">Reference {index + 1}<select className={`${editorSelect} min-w-0 max-w-full`} aria-label={`Analyzer reference ${index + 1}`} value={model.selected[index]} onChange={event => model.setSelected(old => old.map((id, i) => i === index ? event.target.value : id) as [string, string])}>
        <option value="">Off</option>{model.candidates.map(item => <option key={item.instanceId} value={item.instanceId} disabled={model.selected[1 - index] === item.instanceId}>{model.name(item)}</option>)}
      </select><span className="text-[10px] text-daw-text-muted" role="status">{model.statuses[index]}</span></label>)}
      <label className="flex items-center justify-between gap-2">Signal<select className={editorSelect} aria-label="Reference signal" value={model.output ? "output" : "input"} onChange={event => model.setOutput(event.target.value === "output")}><option value="output">Output</option><option value="input">Input</option></select></label>
      <label className="flex items-center justify-between gap-2">Overlap guide<input type="checkbox" aria-label="Overlap guide" checked={model.overlap} onChange={event => model.setOverlap(event.target.checked)} /></label>
      <button className={editorButton} onClick={model.refresh}>Refresh instances</button>
      {model.error && <p role="status" className="text-[10px] text-daw-text-muted">{model.error}</p>}
      <p className="text-[10px] leading-relaxed text-daw-text-muted">View only, for this window. References follow Display resolution, channel, range and tilt. Overlap shades strong energy shared with this EQ's output; it pauses with Hold or Pause. Independent capture times limit transient comparisons. Shared energy does not establish masking. Audio and routing stay unchanged.</p>
    </div>
  </details>;
}
