import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge, type ClipTempoAnalysis, type ClipTempoPreviewData } from "../services/NativeBridge";
import { getVisibleMIDIEventsForClip } from "../utils/midiClipSerialization";
import { parseMIDINotePairs } from "../utils/midiNotes";
import { clipSourceDescriptor } from "../utils/clipSourceDescriptor";
import { TempoAuditionPlayer, tempoClickTimes, tempoFromBeatIntervals, tempoFromTapTimes } from "../utils/tempoAudition";
import { Button, Modal, ProfiledRangeInput } from "./ui";

const fieldClass = "min-w-0 w-24 rounded border border-daw-border bg-daw-dark px-2 py-1.5 text-sm tabular-nums outline-none focus:border-daw-accent focus-visible:ring-1 focus-visible:ring-daw-accent";

export function TempoDetectionModal() {
  const { target, clip, isMidi, projectTempo, hasTempoMap, timeSelection, busyTransport, analyze, applyTempo, close } = useDAWStore(useShallow(state => {
    const target = state.tempoDetectionTarget;
    const track = state.tracks.find(candidate => candidate.id === target?.trackId);
    const midi = track?.midiClips.find(candidate => candidate.id === target?.clipId);
    return { target, clip: midi ?? track?.clips.find(candidate => candidate.id === target?.clipId), isMidi: Boolean(midi),
      projectTempo: state.transport.tempo, hasTempoMap: state.tempoMarkers.length > 0, timeSelection: state.timeSelection,
      busyTransport: state.transport.isPlaying || state.transport.isRecording,
      analyze: state.analyzeTempoDetectionTarget, applyTempo: state.applyDetectedTempo, close: state.closeTempoDetection };
  }));
  const generation = useRef(0), auditionGeneration = useRef(0), draftRevision = useRef(0);
  const analysisRequest = useRef<string | null>(null);
  const cancelAnalysis = useCallback(() => {
    generation.current++;
    const id = analysisRequest.current;
    analysisRequest.current = null;
    if (id) void nativeBridge.cancelClipTempoAnalysis(id).catch(error => console.warn("Tempo cancellation failed", error));
  }, []);
  const taps = useRef<number[]>([]);
  const player = useRef<TempoAuditionPlayer | null>(null);
  if (!player.current) player.current = new TempoAuditionPlayer();
  const previewCache = useRef<{ key: string; data: ClipTempoPreviewData } | null>(null);
  const auditionMode = useRef<"source" | "click">("click");
  const [result, setResult] = useState<ClipTempoAnalysis | null>(null);
  const [bpmDraft, setBpmDraft] = useState("");
  const [phaseDraft, setPhaseDraft] = useState("0");
  const [rangeStartDraft, setRangeStartDraft] = useState("0");
  const [rangeEndDraft, setRangeEndDraft] = useState(String(clip?.duration ?? 0));
  const [previewStartDraft, setPreviewStartDraft] = useState("0");
  const [previewLength, setPreviewLength] = useState(4);
  const [grouping, setGrouping] = useState(4);
  const [clickLevel, setClickLevel] = useState(0.2);
  const [beatIntervals, setBeatIntervals] = useState("4");
  const [tapCount, setTapCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [auditionState, setAuditionState] = useState<"idle" | "preparing" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const duration = clip?.duration ?? 0;
  const rangeStart = Number(rangeStartDraft), rangeEnd = Number(rangeEndDraft);
  const validRange = rangeStartDraft !== "" && rangeEndDraft !== "" && Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)
    && rangeStart >= 0 && rangeEnd <= duration + 0.0005 && rangeEnd > rangeStart;
  const bpm = Number(bpmDraft), phase = Number(phaseDraft), previewStart = Number(previewStartDraft);
  const validBpm = bpmDraft.trim() !== "" && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400;
  const validSourcePreview = previewStartDraft !== "" && Number.isFinite(previewStart) && previewStart >= 0 && previewStart < duration;
  const validPreview = validSourcePreview && validBpm && phaseDraft !== "" && Number.isFinite(phase) && phase >= 0 && phase <= duration;
  const previewDuration = Math.max(0, Math.min(previewLength, duration - previewStart));
  const stopAudition = useCallback(() => {
    auditionGeneration.current++; player.current?.stop(); setAuditionState("idle");
  }, []);
  const updateBpm = (value: string) => {
    draftRevision.current++; setBpmDraft(value);
    if (auditionMode.current !== "source") stopAudition();
  };

  const runAnalysis = useCallback(async (start: number, end: number) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return;
    cancelAnalysis();
    const requestId = crypto.randomUUID();
    analysisRequest.current = requestId;
    const run = ++generation.current, revision = draftRevision.current;
    stopAudition(); setAnalyzing(true); setError(null); setResult(null);
    try {
      // Yield once so the busy indicator paints before bounded MIDI analysis.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (run !== generation.current) return;
      const next = await analyze(start, end - start, requestId);
      if (run !== generation.current) return;
      if (next.error || !Number.isFinite(next.bpm) || next.bpm <= 0) {
        setError(next.error || "No reliable pulse was found. Select a clearer range, tap, or count beats."); return;
      }
      setResult(next);
      if (revision === draftRevision.current) {
        setBpmDraft(String(Math.round(next.bpm * 100) / 100));
        setPhaseDraft((Number.isFinite(next.beatOffsetSeconds) ? next.beatOffsetSeconds : 0).toFixed(3));
      }
      setPreviewStartDraft(Math.max(start, Math.min(end - 0.1, next.analysisStartSeconds ?? next.segments?.[0]?.startSeconds ?? start)).toFixed(3));
    } catch (reason) {
      if (run === generation.current) setError(reason instanceof Error ? reason.message : "Tempo analysis failed. Try again.");
    } finally {
      if (analysisRequest.current === requestId) analysisRequest.current = null;
      if (run === generation.current) setAnalyzing(false);
    }
  }, [analyze, stopAudition, cancelAnalysis]);

  useEffect(() => {
    cancelAnalysis(); stopAudition(); previewCache.current = null; setResult(null); setAnalyzing(false);
  }, [clip, stopAudition, cancelAnalysis]);
  useEffect(() => {
    if (!target) return;
    if (!clip) { close(); return; }
    let start = 0, end = clip.duration;
    if (timeSelection) {
      const a = Math.max(0, Math.min(timeSelection.start, timeSelection.end) - clip.startTime);
      const b = Math.min(clip.duration, Math.max(timeSelection.start, timeSelection.end) - clip.startTime);
      if (b > a) { start = a; end = b; }
    }
    setRangeStartDraft(start.toFixed(3)); setRangeEndDraft(end.toFixed(3)); setPreviewStartDraft(start.toFixed(3));
    setBpmDraft(""); setPhaseDraft("0"); taps.current = []; setTapCount(0);
    void runAnalysis(start, end);
    return () => { cancelAnalysis(); stopAudition(); };
    // A new target owns the initial range. Editing the range is an explicit Analyze action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, close, runAnalysis, cancelAnalysis]);
  useEffect(() => { if (busyTransport) stopAudition(); }, [busyTransport, stopAudition]);
  useEffect(() => {
    const hide = () => { if (document.hidden) stopAudition(); };
    window.addEventListener("blur", stopAudition); document.addEventListener("visibilitychange", hide);
    return () => { generation.current++; auditionGeneration.current++; player.current?.dispose();
      window.removeEventListener("blur", stopAudition); document.removeEventListener("visibilitychange", hide); };
  }, [stopAudition]);

  const guideNotes = useMemo(() => {
    if (!clip || !("events" in clip)) return [];
    return parseMIDINotePairs(getVisibleMIDIEventsForClip(clip)).map(note => ({ startSeconds: note.startTime,
      durationSeconds: note.duration, pitch: note.noteNumber, velocity: note.velocity }));
  }, [clip]);

  const audition = async (sourceOnly: boolean) => {
    if (!target || !clip || !(sourceOnly ? validSourcePreview : validPreview) || busyTransport) return;
    stopAudition(); auditionMode.current = sourceOnly ? "source" : "click";
    const run = ++auditionGeneration.current;
    setPreviewError(null); setAuditionState("preparing");
    try {
      await player.current!.ready();
      let data: ClipTempoPreviewData | undefined;
      if (!isMidi && "filePath" in clip) {
        const key = JSON.stringify([target, clip.filePath, clip.offset, clip.duration, clip.volumeDB, clip.fadeIn, clip.fadeOut, previewStart, previewDuration]);
        data = previewCache.current?.key === key ? previewCache.current.data
          : await nativeBridge.getClipTempoPreviewData(target.trackId, target.clipId, previewStart, previewDuration, clipSourceDescriptor(clip));
        if (run !== auditionGeneration.current) return;
        if (data.error || !data.wavBase64) throw new Error(data.error || "No clip audio was returned for preview.");
        if ((data.filePath && data.filePath.replace(/\\/g, "/").toLowerCase() !== clip.filePath.replace(/\\/g, "/").toLowerCase())
          || (data.sourceOffsetSeconds !== undefined && Math.abs(data.sourceOffsetSeconds - clip.offset) > 1e-4)
          || (data.rangeStartSeconds !== undefined && Math.abs(data.rangeStartSeconds - previewStart) > 1e-4)
          || (data.clipDurationSeconds !== undefined && Math.abs(data.clipDurationSeconds - clip.duration) > 1e-6))
          throw new Error("The clip source changed. Analyze it again before auditioning.");
        previewCache.current = { key, data };
      }
      if (run !== auditionGeneration.current) return;
      const started = await player.current!.play({ bpm, phaseSeconds: phase, rangeStartSeconds: previewStart,
        durationSeconds: Math.min(previewDuration, data?.durationSeconds ?? previewDuration), wavBase64: data?.wavBase64,
        notes: isMidi ? guideNotes : undefined, pulseGrouping: grouping, clickLevel: sourceOnly ? 0 : clickLevel,
        onEnded: () => { if (run === auditionGeneration.current) setAuditionState("idle"); } });
      if (started && run === auditionGeneration.current) setAuditionState("playing");
    } catch (reason) {
      if (run === auditionGeneration.current) { stopAudition(); setPreviewError(reason instanceof Error ? reason.message : "Preview could not start."); }
    }
  };
  const handleClose = () => { cancelAnalysis(); stopAudition(); close(); };
  if (!target || !clip) return null;
  const confidence = result && Number.isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : 0;
  const choices = result ? [result.bpm / 2, result.bpm, result.bpm * 2, ...result.candidates.map(candidate => candidate.bpm)]
    .filter((value, index, values) => Number.isFinite(value) && value >= 20 && value <= 400
      && values.findIndex(candidate => Math.abs(candidate - value) < 0.01) === index) : [];
  const sourceLabel = result?.source === "midi-metadata" ? "MIDI tempo metadata"
    : result?.source === "midi-estimate" ? "MIDI beat-grid estimate" : "Audio beat estimate";
  const ticks = validPreview ? tempoClickTimes(bpm, phase, previewStart, previewDuration) : [];
  const counted = validRange ? tempoFromBeatIntervals(rangeStart, rangeEnd, Number(beatIntervals)) : null;

  return <Modal isOpen onClose={handleClose} title="Detect Clip Tempo" size="lg" footer={<>
    <Button size="sm" onClick={handleClose}>Close</Button>
    <Button size="sm" variant="primary" disabled={!validBpm || bpm === projectTempo} onClick={() => {
      stopAudition(); if (applyTempo(bpm)) handleClose(); else setError("The project tempo could not be changed. Check the active project and try again.");
    }}>Apply Project Tempo</Button>
  </>}>
    <div className="space-y-3 text-sm text-daw-text">
      <p className="truncate text-daw-text-muted" title={clip.name}>{clip.name}</p>
      <fieldset className="rounded border border-daw-border p-3">
        <legend className="px-1 text-xs font-medium">Analyze a steady range · seconds from clip start</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">Start<input className={fieldClass} type="number" min={0} max={duration} step={0.001} aria-label="Tempo analysis range start" value={rangeStartDraft} onChange={event => { stopAudition(); setRangeStartDraft(event.target.value); }} /></label>
          <label className="flex flex-col gap-1 text-xs">End<input className={fieldClass} type="number" min={0} max={duration} step={0.001} aria-label="Tempo analysis range end" value={rangeEndDraft} onChange={event => { stopAudition(); setRangeEndDraft(event.target.value); }} /></label>
          <Button size="sm" disabled={!validRange || analyzing} onClick={() => void runAnalysis(rangeStart, rangeEnd)}>Analyze range</Button>
          <Button size="sm" onClick={() => { cancelAnalysis(); stopAudition(); setAnalyzing(false); }} disabled={!analyzing}>Cancel analysis</Button>
        </div>
        {!validRange && <p className="mt-2 text-xs text-amber-300">Choose an increasing range inside this {duration.toFixed(3)} s clip.</p>}
      </fieldset>
      {analyzing && <p role="status" aria-label="Tempo analysis status" className="rounded bg-daw-dark p-3">Analyzing repeated pulses across the range…</p>}
      {error && <p role="alert" className="rounded bg-amber-950/30 p-3 text-xs text-amber-200">{error}</p>}
      {result && <>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-daw-text-muted"><span>{sourceLabel}</span><span>{confidence < 0.5 ? "Weak" : confidence >= 0.8 ? "Strong" : "Moderate"} pulse evidence ({Math.round(confidence * 100)}%)</span></div>
        <p className="text-xs text-daw-text-muted">{result.segments?.length ?? 1} section(s) compared.{result.tempoSpreadBpm !== undefined ? ` Pulse-family spread: ${result.tempoSpreadBpm.toFixed(2)} BPM.` : ""} Evidence strength is not a calibrated probability or a detected downbeat.</p>
        {result.segments && <div className="flex flex-wrap gap-2 text-xs text-daw-text-muted">{result.segments.map(segment => <button key={segment.startSeconds} className="rounded border border-daw-border px-2 py-1 hover:border-daw-accent focus-visible:outline-2 focus-visible:outline-daw-accent" onClick={() => { stopAudition(); setPreviewStartDraft(segment.startSeconds.toFixed(3)); }} title="Audition this analyzed section">{segment.startSeconds.toFixed(1)}–{(segment.startSeconds + segment.durationSeconds).toFixed(1)} s · {segment.bpm.toFixed(1)} BPM</button>)}</div>}
      </>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-medium">Tempo<input className={fieldClass} type="number" min={20} max={400} step={0.01} aria-label="Detected tempo in BPM" aria-invalid={!validBpm || undefined} value={bpmDraft} onChange={event => updateBpm(event.target.value)} />BPM</label>
        <Button size="sm" onClick={() => { const now = performance.now(); if (taps.current.length && now - taps.current[taps.current.length - 1] > 3000) taps.current = []; taps.current = [...taps.current, now].slice(-9); setTapCount(taps.current.length); const tempo = tempoFromTapTimes(taps.current); if (tempo !== null) updateBpm(tempo.toFixed(2)); }}>Tap pulse{tapCount > 0 ? ` (${tapCount})` : ""}</Button>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tempo candidates">{choices.map(value => <Button key={value} size="sm" active={Math.abs(value - bpm) < 0.01} aria-pressed={Math.abs(value - bpm) < 0.01} onClick={() => updateBpm(String(Math.round(value * 100) / 100))}>{Math.round(value * 100) / 100} BPM{result && Math.abs(value - result.bpm / 2) < 0.01 ? " (½)" : result && Math.abs(value - result.bpm * 2) < 0.01 ? " (2×)" : ""}</Button>)}</div>
      {result?.warning && <p className="rounded bg-amber-950/30 p-3 text-xs text-amber-200">{result.warning}</p>}
      {result && confidence < 0.5 && <p className="text-xs text-amber-200">This pulse is uncertain. Audition the candidates, tap, or count beats before applying.</p>}
      <details className="rounded border border-daw-border p-3"><summary className="cursor-pointer text-xs font-medium">Set tempo by counting beats in the selected range</summary><div className="mt-2 flex flex-wrap items-end gap-3"><label className="flex flex-col gap-1 text-xs">Beat intervals<input className={fieldClass} type="number" min={1} max={512} step={1} value={beatIntervals} onChange={event => setBeatIntervals(event.target.value)} aria-label="Beat intervals in tempo range" /></label><Button size="sm" disabled={counted === null} onClick={() => { if (counted !== null) { updateBpm(counted.toFixed(2)); setPhaseDraft(rangeStart.toFixed(3)); } }}>Use counted tempo{counted !== null ? ` · ${counted.toFixed(2)} BPM` : ""}</Button></div><p className="mt-2 text-xs text-daw-text-muted">Set Start and End exactly on beats, then count the spaces between them: beat 1 to beat 5 is 4 intervals. This also works when automatic analysis is uncertain.</p></details>
      <fieldset className="rounded border border-daw-border p-3"><legend className="px-1 text-xs font-medium">Audition and align the click</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">Preview from (s)<input className={fieldClass} type="number" min={0} max={duration} step={0.001} value={previewStartDraft} onChange={event => { stopAudition(); setPreviewStartDraft(event.target.value); }} aria-label="Tempo preview start" /></label>
          <label className="flex flex-col gap-1 text-xs">First accented click (s)<input className={fieldClass} type="number" min={0} max={duration} step={0.001} value={phaseDraft} onChange={event => { stopAudition(); setPhaseDraft(event.target.value); }} aria-label="Tempo click phase" /></label>
          <Button size="sm" onClick={() => { stopAudition(); setPhaseDraft(previewStartDraft); }}>Align click to preview start</Button>
          <label className="flex flex-col gap-1 text-xs">Group pulses<input className={fieldClass} type="number" min={1} max={12} step={1} value={grouping} onChange={event => { stopAudition(); setGrouping(Math.max(1, Math.min(12, Number(event.target.value) || 1))); }} aria-label="Tempo preview pulse grouping" /></label>
          <label className="flex flex-col gap-1 text-xs">Length<select className={fieldClass} value={previewLength} onChange={event => { stopAudition(); setPreviewLength(Number(event.target.value)); }} aria-label="Tempo preview length"><option value={4}>4 seconds</option><option value={8}>8 seconds</option></select></label>
        </div>
        <svg viewBox="0 0 640 62" className="mt-2 h-16 w-full" role="img" aria-label={`Visual beat spacing at ${validBpm ? bpm : 0} BPM over ${previewDuration.toFixed(1)} seconds`}><line x1="0" x2="640" y1="40" y2="40" stroke="#555" />{ticks.map(tick => <line key={tick.beat} x1={tick.seconds / previewDuration * 640} x2={tick.seconds / previewDuration * 640} y1={tick.beat % grouping === 0 ? 4 : 15} y2="40" stroke="#38bdf8" strokeWidth="2" />)}<text x="0" y="59" fill="#aaa" fontSize="11">{Number.isFinite(previewStart) ? previewStart.toFixed(2) : "0"} s</text><text x="640" y="59" fill="#aaa" fontSize="11" textAnchor="end">{Number.isFinite(previewStart + previewDuration) ? (previewStart + previewDuration).toFixed(2) : "0"} s</text></svg>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={!validPreview || busyTransport || auditionState !== "idle"} onClick={() => void audition(false)}>{isMidi ? "Audition note guide + click" : "Audition clip + click"}</Button><Button size="sm" disabled={!validSourcePreview || busyTransport || auditionState !== "idle"} onClick={() => void audition(true)}>{isMidi ? "Guide only" : "Source only"}</Button><Button size="sm" disabled={auditionState === "idle"} onClick={stopAudition}>Stop audition</Button><span role="status" aria-label="Tempo audition status" className="text-xs text-daw-text-muted">{auditionState === "preparing" ? "Preparing preview…" : auditionState === "playing" ? "Playing bounded preview" : ""}</span></div>
        <label className="mt-2 flex items-center gap-2 text-xs">Click level<ProfiledRangeInput className="w-32 accent-daw-accent" min={0} max={0.3} step={0.01} value={clickLevel} onValueChange={value => { stopAudition(); setClickLevel(value); }} aria-label="Tempo audition click level" /></label>
        <p className="mt-2 text-xs text-daw-text-muted">Audition uses your system audio output, which may differ from the DAW audio device.</p>
        <p className="mt-2 text-xs text-daw-text-muted">{isMidi ? "MIDI preview uses simple guide tones, not the track’s instrument or FX." : "Dry clip audio includes its gain and fades; track/master FX are excluded."} Use {isMidi ? "Guide only" : "Source only"} while tapping. Close, Stop, changing clips or leaving this window stops the preview. Project transport stays in place.</p>
        {busyTransport && <p className="mt-2 text-xs text-amber-200">Stop project playback or recording before starting this separate preview.</p>}
        {previewError && <p role="alert" className="mt-2 text-xs text-amber-200">{previewError}</p>}
      </fieldset>
      <p className="text-xs text-daw-text-muted">Apply changes the project’s base tempo from {projectTempo} BPM. It does not stretch or move clips, change beat phase, or create tempo markers.</p>
      {hasTempoMap && <p className="text-xs text-amber-200">Existing tempo markers remain and can override the base tempo.</p>}
    </div>
  </Modal>;
}
