import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../../store/useDAWStore";
import { nativeBridge, type BuiltInPluginAddress, type EQMatchResult } from "../../services/NativeBridge";
import { applyEQBandValues, readEQBand } from "../../utils/eqBandClipboard";
import { useEQDraftAudition } from "./useEQDraftAudition";
import { eqValues, type EQToolbarProps } from "./EQToolbar";
import { EQ_REFERENCE_KEY, readEQReferences, saveEQReference, removeEQReference, referenceForRate, type EQReference } from "../../utils/eqMatchReferences";

export function EQMatchPanel(props: EQToolbarProps) {
  const { schema, address, onApplyValues, onFlush } = props;
  const { tracks } = useDAWStore(useShallow(s => ({ tracks: s.tracks })));
  const [candidates, setCandidates] = useState<BuiltInPluginAddress[]>([]);
  const [referenceId, setReferenceId] = useState(address.instanceId ?? "");
  const [current, setCurrent] = useState<EQMatchResult | null>(null);
  const [reference, setReference] = useState<EQMatchResult | null>(null);
  const [proposal, setProposal] = useState<EQMatchResult | null>(null);
  const [detail, setDetail] = useState(4);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const [library, setLibrary] = useState<EQReference[]>([]);
  const [savedId, setSavedId] = useState("");
  const [referenceName, setReferenceName] = useState("");
  const [fileStart, setFileStart] = useState("0");
  const mounted = useRef(true);
  const audition = useEQDraftAudition(props, !applied && proposal?.accepted ? proposal.bands : undefined, current?.values, current?.sampleRate);
  const name = (item: BuiltInPluginAddress) => `${item.chain === "master" ? "Master" : tracks.find(track => track.id === item.trackId)?.name ?? item.trackId} · ${item.chain === "input" ? "Input" : "FX"} ${(item.fxIndex ?? 0) + 1}`;
  useEffect(() => {
    const refresh = () => {
      try { setLibrary(readEQReferences()); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Saved references are unavailable"); }
    };
    const changed = (event: StorageEvent) => { if (event.key === EQ_REFERENCE_KEY || event.key === null) refresh(); };
    refresh(); window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void nativeBridge.eqMatch("list").then(result => {
      if (!mounted.current) return;
      if (!result.success) { setError(result.error ?? "Could not list EQ instances"); return; }
      setCandidates(result.candidates ?? []);
      setReferenceId(items => result.candidates?.some(item => item.instanceId === items) ? items : result.candidates?.[0]?.instanceId ?? "");
    }).catch(() => { if (mounted.current) setError("Could not list EQ instances"); });
    return () => { mounted.current = false; };
  }, [address.instanceId]);
  const freeBands = schema.parameters.filter(p => /^band\d+\.enabled$/.test(p.id) && p.value < .5).map(p => p.id.slice(0, p.id.indexOf(".")));
  const run = async (label: string, operation: () => Promise<void>) => {
    if (busy) return; await audition.stop(true); setBusy(label); setError("");
    try { await operation(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "EQ Match failed"); }
    finally { if (mounted.current) setBusy(""); }
  };
  const learn = (side: "current" | "reference") => void run(`Learning ${side}…`, async () => {
    if (!await onFlush()) throw new Error("Pending EQ writes failed");
    if (side === "current") {
      const actual = await nativeBridge.getBuiltInPluginSchema(address); const values = eqValues(actual);
      if (values.stereoMode >= .5 || values.autoGain >= .5 || values.auditionBand >= .5 || (values.detectorListenBand ?? 0) >= .5 || values.bypass >= .5)
        throw new Error("Use active Stereo EQ with Auto gain and Listen off before learning the current output");
    }
    const source = side === "current" ? address : candidates.find(item => item.instanceId === referenceId);
    if (!source) throw new Error("Select an existing reference EQ");
    const result = await nativeBridge.eqMatch("capture", { address: source });
    if (!result.success || !result.spectrum) throw new Error(result.error ?? "Could not learn spectrum");
    if (mounted.current) { (side === "current" ? setCurrent : setReference)({ ...result, sourceName: "Live output" }); if (side === "reference") setSavedId(""); setProposal(null); setApplied(false); }
  });
  const learnFile = () => void run("Learning audio file…", async () => {
    const startSeconds = Number(fileStart);
    if (!fileStart.trim() || !Number.isFinite(startSeconds) || startSeconds < 0) throw new Error("Enter a non-negative reference start time");
    const path = await nativeBridge.browseForFile("Select EQ reference audio", "*.wav;*.aif;*.aiff;*.flac");
    if (!path || !mounted.current) return;
    const result = await nativeBridge.eqMatch("file", { path, startSeconds });
    if (!result.success || !result.spectrum) throw new Error(result.error ?? "Could not learn the audio file");
    if (mounted.current) { setReference(result); setSavedId(""); setProposal(null); setApplied(false); }
  });
  const save = (result: EQMatchResult | null) => void run("Saving reference…", async () => {
    if (!result) return;
    setLibrary(saveEQReference(referenceName, result));
  });
  const selectSaved = (id: string) => {
    setSavedId(id); const selected = library.find(item => item.id === id);
    setReference(selected ? { ...selected, success: true, sourceName: `Saved: ${selected.name}` } : null);
    setProposal(null); setApplied(false); setError("");
  };
  const removeSaved = () => void run("Removing saved reference…", async () => {
    setLibrary(removeEQReference(savedId)); selectSaved("");
  });
  const fit = () => void run("Fitting bells…", async () => {
    if (!current?.spectrum || !reference?.spectrum) return;
    const referenceCurve = referenceForRate(reference, current.sampleRate ?? 0);
    const result = await nativeBridge.eqMatch("fit", { current: current.spectrum, reference: referenceCurve, sampleRate: current.sampleRate, bands: Math.min(detail, freeBands.length), analogResponse: (current.values?.phaseMode ?? 0) < .5 && (current.values?.minimumPhaseFIR ?? 0) >= .5 && (current.values?.analogResponse ?? 0) >= .5 });
    if (!result.success) throw new Error(result.error ?? "Could not fit spectrum");
    if (mounted.current) { setProposal(result); setApplied(false); }
  });
  const apply = () => void run("Applying proposal…", async () => {
    if (!proposal?.accepted || !proposal.bands?.length || !current?.values) return;
    if (!await onFlush()) throw new Error("Pending EQ writes failed");
    const actualSchema = await nativeBridge.getBuiltInPluginSchema(address);
    const actual = eqValues(actualSchema);
    if (Object.entries(current.values).some(([id, value]) => actual[id] === undefined || Math.abs(actual[id] - value) > 1e-5)) throw new Error("Current EQ settings changed since learning; learn again");
    if (proposal.bands.length > freeBands.length) throw new Error("Not enough unused bands");
    const values: Record<string, number> = {};
    proposal.bands.forEach((band, index) => { const number = Number(freeBands[index].slice(4)); Object.assign(values, applyEQBandValues(actualSchema, number, { ...readEQBand(actualSchema, number, true), enabled: 1, type: 0, slope: 1, allPass: 0, freq: band.frequency, gain: band.gain, q: band.q, target: 0, dynamicEnabled: 0, cutMode: 0, gainQInteraction: 0 })); });
    await audition.stop(true);
    if (!await onApplyValues(values)) throw new Error("The EQ did not accept the complete proposal");
    if (mounted.current) setApplied(true);
  });
  const frequencies = current?.frequencies ?? reference?.frequencies ?? [];
  const graphPath = (values: number[] | undefined) => values?.map((value, i) => `${i ? "L" : "M"}${20 + i / Math.max(1, values.length - 1) * 560},${80 - Math.max(-15, Math.min(15, value)) * 4}`).join(" ") ?? "";
  return <section role="region" aria-label="EQ Match" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 text-xs">
    <p className="text-daw-text-muted">Learn related audio with playback running and looping off. Each capture collects about four seconds of output from an existing EQ.</p>
    <div className="flex items-end gap-2"><label className="flex min-w-0 flex-1 flex-col gap-1">Reference EQ<select className={editorSelect} aria-label="Match reference EQ" disabled={!!busy} value={referenceId} onChange={event => { setReferenceId(event.target.value); setReference(null); setProposal(null); setApplied(false); }}>{candidates.map(item => <option key={item.instanceId} value={item.instanceId}>{name(item)}</option>)}</select></label></div>
    <div className="flex flex-wrap gap-2"><button className={editorButton} disabled={!!busy} onClick={() => learn("current")}>Learn current output</button><button className={editorButton} disabled={!!busy || !referenceId} onClick={() => learn("reference")}>Learn reference output</button></div>
    <div className="flex flex-wrap items-end gap-2"><label className="flex flex-col gap-1">File start (seconds)<input className={`${editorSelect} w-28`} aria-label="Reference file start" type="number" min="0" step=".1" value={fileStart} disabled={!!busy} onChange={event => setFileStart(event.target.value)} /></label><button className={editorButton} disabled={!!busy} onClick={learnFile}>Learn audio file</button><span className="text-daw-text-muted">Up to 4 s · WAV, AIFF, FLAC</span></div>
    <div className="flex flex-wrap items-end gap-2"><label className="flex min-w-40 flex-1 flex-col gap-1">Saved reference<select className={`${editorSelect} min-w-0`} aria-label="Saved EQ reference" value={savedId} disabled={!!busy} onChange={event => selectSaved(event.target.value)}><option value="">Choose a saved spectrum</option>{library.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className={editorButton} disabled={!!busy || !savedId} onClick={removeSaved}>Remove saved</button></div>
    <div className="flex flex-wrap items-end gap-2"><label className="flex min-w-40 flex-1 flex-col gap-1">Reference name<input className={`${editorSelect} min-w-0`} aria-label="EQ reference name" maxLength={80} value={referenceName} disabled={!!busy} onChange={event => setReferenceName(event.target.value)} /></label><button className={editorButton} disabled={!!busy || !current || !referenceName.trim()} onClick={() => save(current)}>Save current</button><button className={editorButton} disabled={!!busy || !reference || !referenceName.trim()} onClick={() => save(reference)}>Save reference</button></div>
    <p className="text-[10px] text-daw-text-muted">{library.length}/32 saved on this device/browser profile. Spectra only; not included in projects or presets.</p>
    <div className="flex flex-wrap gap-x-5 gap-y-1 break-words text-daw-text-muted"><span>Current: {current ? `${current.seconds?.toFixed(1)} s captured` : "Not learned"}</span><span className="min-w-0">Reference: {reference ? `${reference.sourceName ?? "Learned"} · ${reference.seconds?.toFixed(1)} s` : "Not learned"}</span></div>
    <div className="flex flex-wrap items-end gap-2"><label className="flex flex-col gap-1">Maximum bells<select className={editorSelect} aria-label="Match detail" disabled={!!busy} value={detail} onChange={event => { setDetail(Number(event.target.value)); setProposal(null); setApplied(false); }}>{[1,2,4,6,8].map(count => <option key={count} value={count}>{count}</option>)}</select></label><button className={editorButton} disabled={!!busy || !current || !reference || !freeBands.length} onClick={fit}>Propose match</button>{proposal?.accepted && <button className={editorButton} disabled={!!busy || applied || !proposal.bands?.length} onClick={apply}>{applied ? "Applied" : "Apply bells"}</button>}</div>
    {!!busy && <p role="status">{busy}</p>}{error && <p role="alert" className="text-daw-record">{error}</p>}
    {proposal?.accepted && !applied && !!proposal.bands?.length && <div className="flex flex-wrap items-center gap-2"><button className={editorButton} disabled={!!busy || audition.pending || !audition.eligible} aria-pressed={audition.active} onClick={() => { if (audition.active) void audition.stop(); else void audition.start(); }}>{audition.active ? "Stop audition" : "Audition proposal"}</button><span className="text-[10px] text-daw-text-muted">{audition.message || (audition.eligible ? "Preview without committing bands. Apply adds one Undo step." : "Audition requires active Stereo EQ with Auto gain and Listen off.")}</span></div>}
    {proposal && <>
      <svg className="min-h-24 max-h-40 w-full shrink-0" viewBox="0 0 600 160" role="img" aria-label="Proposed EQ correction, target and fitted bells"><path d="M20 80H580" stroke="currentColor" opacity=".25" /><path d={graphPath(proposal.target)} fill="none" stroke="#a1a8ad" strokeWidth="2" /><path d={graphPath(proposal.curve)} fill="none" stroke="#58b6ff" strokeWidth="2" /><text x="20" y="153" fill="currentColor" fontSize="11">{frequencies[0]?.toFixed(0) ?? 80} Hz</text><text x="540" y="153" fill="currentColor" fontSize="11">{((frequencies[frequencies.length - 1] ?? 16000)/1000).toFixed(1)}k</text></svg>
      <p role="status">{proposal.reason}. {proposal.bands?.length ?? 0} bells. Shape error {proposal.beforeError?.toFixed(2)} → {proposal.afterError?.toFixed(2)} dB RMS.</p>
      <p className="text-[10px] text-daw-text-muted">Gray: level-normalized target. Blue: proposed bells. Error measures the learned curves, not perceived similarity.</p>
    </>}
    <p className="text-[11px] leading-relaxed text-daw-text-muted">Matching covers 80 Hz to 16 kHz (lower at low sample rates), ignores weak bins, removes average level difference and limits each bell to ±9 dB. Apply adds static stereo bells to unused bands, preserving current filters and trim. With dynamics active, the result matches the captured average, not every moment. Unsaved spectra are temporary; live capture windows can have gaps. Reuse at another sample rate requires reference coverage of the current frequency range.</p>
  </section>;
}
