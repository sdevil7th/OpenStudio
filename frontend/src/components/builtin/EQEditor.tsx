import { editorButton, editorSelect, editorTab } from "./PluginEditorControls";
import { applyEQBandValues, freeEQBand, readEQBand } from "../../utils/eqBandClipboard";
import { findBuiltInParameter, expandedBuiltInParamId } from "../../utils/builtInExpandedSelectors";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Headphones, Power } from "lucide-react";
import { nativeBridge, type BuiltInPluginSchema } from "../../services/NativeBridge";
import { ParametricGraph } from "../ParametricGraph";
import { SuiteParameter, type ParameterChange } from "./SuiteParameter";
import { EQToolbar, type EQToolbarProps } from "./EQToolbar";
import "./EQEditor.css";
import { AnalyzerDisplayControls, useEQAnalyzer } from "./AnalyzerDisplayControls";
import { analyzerPosition, defaultAnalyzerSettings } from "../../utils/eqAnalyzerHistory";
import { EQPeakPicker } from "./EQPeakPicker";
import { EQAnalyzerReferences, useEQAnalyzerReferences } from "./EQAnalyzerReferences";
import { EQFrequencyView } from "./EQFrequencyView";
import { EQBandGroup } from "./EQBandGroup";
import { EQBandActions } from "./EQBandActions";
import { eqBandDragChanges, eqBandParameterChanges } from "../../utils/eqBandDrag";
import { eqFrequencyWindow, eqFrequencyTicks } from "../../utils/eqFrequencyView";
import { EQSketchPanel } from "./EQSketchPanel";
import { EQMatchPanel } from "./EQMatchPanel";
import { useSpectrumHoverGrab } from "./useSpectrumHoverGrab";
import { EQSpectrumGrab } from "./EQSpectrumGrab";
import { useStableMeterSnapshot } from "./useStableMeterSnapshot";
import { captureSpectrumGrab, type SpectrumGrabFrame } from "../../utils/eqSpectrumPeaks";
import { ProfiledRangeInput } from "../ui/ProfiledRangeInput";
import { applyEQPhaseTransition, type EQPhaseField } from "../../utils/eqPhaseTransition";

type EQGeometryStyle = CSSProperties & { "--band-color"?: string; "--meter-level"?: string };
const eqGeometryStyle = (style: EQGeometryStyle): EQGeometryStyle => style;

const colors = ["#f08080", "#eea968", "#dec46c", "#8ac878", "#64c7bc", "#66b5e5", "#ae9bdb", "#d98eb9"];
const frequencyLabel = (hz: number) => hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : `${Math.round(hz)}`;
const filterLabel = (type: number, fallback: string) => type === 3 ? "High Pass (Low Cut)" : type === 4 ? "Low Pass (High Cut)" : fallback;
type Props = EQToolbarProps & {
  onBrowseInstances?: () => void;
  onChange: ParameterChange;
  onGestureStart: (id: string) => void;
  onGestureEnd: () => void;
};

export function EQEditor(props: Props) {
  const { schema, onChange, onGestureStart, onGestureEnd } = props;
  const [analyzerSize, setAnalyzerSize] = useState(2048);
  const [analyzerSource, setAnalyzerSource] = useState(0);
  const [meters, setMeters] = useStableMeterSnapshot(true);
  useEffect(() => {
    let retired = false; let pending = false;
    const timer = window.setInterval(() => {
      if (pending || document.hidden) return;
      pending = true;
      void nativeBridge.getBuiltInPluginMeters(props.address, analyzerSize, analyzerSource).then(next => { if (!retired) setMeters(next); }).catch(() => { if (!retired) setMeters(null); }).finally(() => { pending = false; });
    }, 50);
    return () => { retired = true; window.clearInterval(timer); };
  }, [props.address.chain, props.address.trackId, props.address.fxIndex, props.address.instanceId, analyzerSize, analyzerSource]);
  const [selected, setPrimary] = useState(1);
  const [selectedBands, setSelectedBandsState] = useState<number[]>([1]);
  const selectionRef = useRef<number[]>([1]);
  const setSelectedBands = (next: number[] | ((current: number[]) => number[])) => {
    const bands = typeof next === "function" ? next(selectionRef.current) : next;
    selectionRef.current = bands; setSelectedBandsState(bands);
    if (bands.length && !bands.includes(selected)) setPrimary(bands[0]);
  };
  const setSelected = (band: number) => { setPrimary(band); selectionRef.current = [band]; setSelectedBandsState([band]); };
  const creatingBand = useRef(false), creationRevision = useRef(0);
  const [bandCreationError, setBandCreationError] = useState("");
  const phaseChanging = useRef(false);
  const [phasePending, setPhasePending] = useState(false), [phaseError, setPhaseError] = useState("");
  const changePhase = async (field: EQPhaseField, next: number) => {
    if (phaseChanging.current || schema.midiPrograms?.preparedConfigurations) return;
    phaseChanging.current = true; setPhasePending(true); setPhaseError("");
    try {
      if (!await applyEQPhaseTransition(schema, field, next, props)) setPhaseError("The phase change was not applied. The previous configuration is retained.");
    } catch { setPhaseError("Could not change phase. Check the processor connection and try again."); }
    finally { phaseChanging.current = false; setPhasePending(false); }
  };
  useEffect(() => { ++creationRevision.current; setBandCreationError(""); return () => { ++creationRevision.current; }; }, [schema.instanceId, props.address.instanceId, props.address.trackId, props.address.chain, props.address.fxIndex]);
  const addBell = async (frequency: number, gain = 0, q = 1) => {
    if (creatingBand.current) return false;
    creatingBand.current = true; const revision = creationRevision.current;
    try {
      if (!await props.onFlush() || revision !== creationRevision.current) return false;
      const actual = await nativeBridge.getBuiltInPluginSchema(props.address);
      if (revision !== creationRevision.current) return false;
      const free = freeEQBand(actual);
      if (free === null) { setBandCreationError("No unused non-cut band. Disable a band to add a bell."); return false; }
      const values = applyEQBandValues(actual, free, { ...readEQBand(actual, free, true), enabled: 1, type: 0, allPass: 0, freq: frequency, gain, q, slope: 0, dynamicEnabled: 0, target: 0, cutMode: 0, gainQInteraction: 0 });
      const applied = await props.onApplyValues(values);
      if (revision !== creationRevision.current) return false;
      if (applied) { setSelected(free); setInspector("basic"); setBandCreationError(""); }
      else setBandCreationError("Could not add the band. Check the editor status; Undo restores any partial change.");
      return applied;
    } catch { if (revision === creationRevision.current) setBandCreationError("Could not add the band. Try again."); return false; }
    finally { creatingBand.current = false; }
  };
  const dragSnapshot = useRef<{ schema: BuiltInPluginSchema; bands: number[]; touched: Set<string> } | null>(null);
  const selectGraphBands = (ids: string[], primary?: string) => {
    const bands = ids.map(Number); setSelectedBands(bands);
    if (primary !== undefined && bands.includes(Number(primary))) setPrimary(Number(primary));
  };
  const startGraphEdit = (id: string) => {
    const band = Number(id), bands = selectionRef.current.includes(band) ? selectionRef.current : [band];
    setSelectedBands(bands); setPrimary(band);
    dragSnapshot.current = { schema, bands, touched: new Set() };
    onGestureStart(expandedBuiltInParamId(schema, `band${id}.freq`));
  };
  const changeGraphBands = (id: string, next: { x?: number; y?: number; z?: number }) => {
    const snapshot = dragSnapshot.current; if (!snapshot) return;
    const changes = eqBandDragChanges(snapshot.schema, snapshot.bands, Number(id), next);
    for (const [parameterId, value] of Object.entries(changes)) {
      const parameter = schema.parameters.find(p => p.id === parameterId);
      if (parameter && parameter.value !== value) { snapshot.touched.add(parameterId); onChange(parameter, value); }
    }
  };
  const finishGraphEdit = (cancel = false) => {
    const snapshot = dragSnapshot.current; dragSnapshot.current = null;
    if (cancel && snapshot) for (const id of snapshot.touched) {
      const parameter = snapshot.schema.parameters.find(p => p.id === id);
      if (parameter) onChange(parameter, parameter.value);
    }
    onGestureEnd();
  };
  const [frequencyZoom, setFrequencyZoom] = useState(1);
  const [frequencyCenter, setFrequencyCenter] = useState(Math.sqrt(400000));
  const [gainRange, setGainRange] = useState(30);
  const extendedFrequency = schema.parameters.some(p => p.id === "band0.frequencyExtended");
  const frequencyView = eqFrequencyWindow(frequencyZoom, frequencyCenter, extendedFrequency ? 10 : 20, extendedFrequency ? 30000 : 20000);
  const [matching, setMatching] = useState(false);
  const [sketching, setSketching] = useState(false);
  const [grab, setGrab] = useState<SpectrumGrabFrame | null>(null);
  const [autoGrab, setAutoGrab] = useState(false);
  const [inspector, setInspector] = useState<"basic" | "dynamic" | "detector">("basic");
  const [analyzer, setAnalyzer] = useState("both");
  const [analyzerSettings, setAnalyzerSettings] = useState(defaultAnalyzerSettings);
  const [analyzerReset, setAnalyzerReset] = useState(0);
  const graph = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 720, height: 280 });
  useEffect(() => {
    const element = graph.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(240, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [matching, sketching]);
  const parameter = (id: string) => findBuiltInParameter(schema, id);
  const value = (id: string, fallback = 0) => parameter(id)?.value ?? fallback;
  const changeInspector = useCallback<ParameterChange>((parameter, next) => {
    const changes = eqBandParameterChanges(schema, selectionRef.current, parameter.id, next);
    for (const [id, value] of Object.entries(changes)) {
      const target = schema.parameters.find(p => p.id === id);
      if (target && target.value !== value) onChange(target, value);
    }
  }, [schema, onChange]);
  const change = (id: string, next: number) => { const p = parameter(id); if (p) changeInspector(p, next); };
  const prefix = `band${selected}.`;
  const type = value(`${prefix}allPass`) >= .5 ? 7 : value(`${prefix}type`);
  const dynamicFilter = type <= 2;
  const gainFilter = dynamicFilter || type >= 8;
  const linearPhase = value("phaseMode") >= .5;
  const minimumFIR = !linearPhase && value("minimumPhaseFIR") >= .5;
  const preparedPhase = linearPhase || minimumFIR;
  const spectralProcessing = value("spectralProcessing") >= .5;
  const spectralBand = spectralProcessing && value(`${prefix}spectralEnabled`) >= .5;
  const linearDynamics = preparedPhase && value("linearBandDynamics") >= .5;
  const dynamicsAvailable = !preparedPhase || spectralBand || linearDynamics;
  const dynamicInspector = inspector === "dynamic" && dynamicFilter && (dynamicsAvailable || spectralProcessing);
  const adaptiveThreshold = value(`${prefix}dynamicThresholdMode`) >= .5;
  const automaticTiming = value(`${prefix}dynamicTimingMode`) >= .5;
  const dynamicActive = value(`${prefix}dynamicEnabled`) >= .5 && Math.abs(value(`${prefix}dynamicRange`)) > .01;
  const detectorInspector = inspector === "detector" && dynamicFilter && dynamicsAvailable && !!parameter(`${prefix}detectorSource`);
  const selectedExternalKey = value(`${prefix}detectorSource`) === 2 || (value(`${prefix}detectorSource`) === 0 && value("externalDetector") >= .5);
  const slopeFilter = [1, 2, 3, 4].includes(type);
  const cutFilter = type === 3 || type === 4;
  const advancedCut = cutFilter && preparedPhase && value(`${prefix}cutMode`) > 0;
  const displayedFilter = useMemo(() => {
    const filter = findBuiltInParameter(schema, `${prefix}type`);
    return filter && { ...filter, enumOptions: filter.enumOptions?.map(option => ({ ...option, label: filterLabel(option.value, option.label) })) };
  }, [schema, prefix]);
  const render = (id: string, label?: string) => {
    const p = parameter(id);
    if (!p) return null;
    const displayed = id === `${prefix}type` ? displayedFilter ?? p : p;
    const control = <SuiteParameter key={id} parameter={displayed} label={label} onChange={changeInspector} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />;
    return id === "externalDetector" && schema.midiPrograms?.preparedConfigurations
      ? <fieldset key={id} disabled title="Disable MIDI program recall before changing Global key" className="min-w-0 opacity-50">{control}</fieldset>
      : control;
  };
  const visualization = { ...schema.visualization, ...meters };
  if (visualization.spectrumSize !== undefined && (visualization.spectrumSize !== analyzerSize || visualization.spectrumSource !== analyzerSource)) visualization.spectrumReady = false;
  const frequencies = visualization.frequencies ?? [];
  const references = useEQAnalyzerReferences({ ...props.address, instanceId: schema.instanceId ?? props.address.instanceId }, analyzerSize, analyzerSource, analyzerSettings, analyzerReset, visualization, analyzer !== "off" && !matching && !sketching && !grab);
  const analyzerSnapshot = useEQAnalyzer(visualization, analyzerSettings, `${schema.instanceId ?? ""}:${props.address.chain}:${props.address.trackId}:${props.address.fxIndex}:${analyzerSize}:${analyzerSource}`, analyzerReset);
  // Position cut handles on the native combined response, including when stopped.
  const responseAt = (hz: number) => {
    const response = visualization.responseDb ?? [];
    const upper = frequencies.findIndex(f => f >= hz);
    if (!response.length || upper < 0) return response[response.length - 1] ?? 0;
    if (upper === 0) return response[0];
    const fraction = Math.log(hz / frequencies[upper - 1]) / Math.log(frequencies[upper] / frequencies[upper - 1]);
    return response[upper - 1] + fraction * (response[upper] - response[upper - 1]);
  };
  const bandCount = schema.parameters.filter(p => /^band\d+\.enabled$/.test(p.id)).length;
  const matrixResponse = value("stereoMode") < .5 && schema.parameters.some(p => /^band\d+\.target$/.test(p.id) && p.value >= .5 && value(p.id.replace("target", "enabled")) >= .5);
  const bands = Array.from({ length: bandCount }, (_, i) => {
    const shape = value(`band${i}.allPass`) >= .5 ? 7 : value(`band${i}.type`);
    const cut = shape === 3 ? "HPF" : shape === 4 ? "LPF" : null;
    const hz = value(`band${i}.freq`, 1000);
    return { id: String(i), cut, label: cut ? `${cut} (Band ${i + 1})` : `Band ${i + 1}`, displayLabel: cut ?? String(i + 1), x: hz,
      y: cut ? Math.max(-gainRange * .9, Math.min(gainRange * .9, responseAt(hz))) : (shape <= 2 || shape >= 8) ? value(`band${i}.gain`) : 0,
      lockY: shape > 2 && shape < 8, z: shape === 9 || (cut && (value(`band${i}.slope`) === 0 || (preparedPhase && value(`band${i}.cutMode`) > 0))) ? undefined : value(`band${i}.q`, 1), enabled: value(`band${i}.enabled`) >= .5, color: colors[i % colors.length] };
  });
  const spectrum = (id: "pre" | "post" | "external", color: string) => ({ id, color, opacity: .36, points: (analyzerSnapshot[id] ?? []).map((db, i) => ({ x: analyzerSnapshot.frequencies[i], y: analyzerPosition(db, analyzerSnapshot.frequencies[i], analyzerSettings) * gainRange / 30 })) });
  const captureGrab = () => {
    const frame = captureSpectrumGrab(visualization, analyzer === "external" ? "external" : analyzer !== "pre");
    if (!frame) return null;
    const bins = frame.frequencies.map((hz, i) => ({ hz, db: frame.db[i] })).filter(({ hz }) => hz >= frequencyView.min && hz <= frequencyView.max);
    return { ...frame, frequencies: bins.map(bin => bin.hz), db: bins.map(bin => bin.db), peaks: frame.peaks.filter(peak => peak.frequency >= frequencyView.min && peak.frequency <= frequencyView.max) };
  };
  const hoverGrab = useSpectrumHoverGrab({
    enabled: autoGrab, blocked: matching || sketching || grab !== null || analyzer === "off" || analyzerSettings.paused || !visualization.spectrumReady || !bands.some(b => !b.enabled && !b.cut),
    frequencyMin: frequencyView.min, frequencyMax: frequencyView.max,
    gainRange,
    identity: `${gainRange}:${frequencyView.min}:${frequencyView.max}:${schema.instanceId}:${analyzer}:${analyzerSize}:${analyzerSource}:${analyzerReset}:${size.width}:${size.height}:${analyzerSettings.range}:${analyzerSettings.tilt}`,
    points: spectrum(analyzer === "external" ? "external" : analyzer === "pre" ? "pre" : "post", "").points,
    capture: captureGrab, onCapture: setGrab,
  });
  const outputL = Number.isFinite(meters?.outputLeftDb) ? meters?.outputLeftDb : undefined;
  const outputR = Number.isFinite(meters?.outputRightDb) ? meters?.outputRightDb : undefined;
  const [toolsOpen, setToolsOpen] = useState(false);
  const bypassed = value("bypass") >= .5;
  return <div className="approved-effect-editor eq-editor flex min-h-0 min-w-0 flex-1 flex-col font-sans text-daw-text" data-bypassed={bypassed}>
    <EQToolbar {...props} />
    {bandCreationError && <p role="alert" className="shrink-0 px-4 py-1 text-xs text-daw-record">{bandCreationError}</p>}
    {phaseError && <p className="shrink-0 px-4 py-1 text-xs text-daw-record" role="alert">{phaseError}</p>}
    <div className="eq-workspace flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="eq-main flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="eq-workflow-bar flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-daw-border-light px-4 py-2 text-xs">
          <div className="eq-processing-summary flex items-center gap-2"><span className="eq-band-count">{bandCount} bands</span>{parameter("phaseMode") && <select className={editorSelect} aria-label="Phase mode" disabled={phasePending || schema.midiPrograms?.preparedConfigurations} value={linearPhase ? 1 : minimumFIR ? 2 : 0} onChange={event => void changePhase("processingMode", Number(event.target.value))}><option value={0}>Minimum phase</option><option value={1}>Linear phase</option>{parameter("minimumPhaseFIR") && <option value={2}>Minimum FIR</option>}</select>}<span className="eq-latency-summary" title="Current processor latency">{visualization.latencySamples !== undefined ? `${visualization.latencySamples} samples` : preparedPhase ? "Prepared path" : "Zero latency"}</span></div>
          <div className="flex flex-wrap items-center gap-2"><button className={editorButton} aria-pressed={matching} onClick={() => { setGrab(null); setSketching(false); setMatching(!matching); }}>{matching ? "Edit EQ" : "Match"}</button><button className={editorButton} aria-pressed={sketching} onClick={() => { setGrab(null); setMatching(false); setSketching(!sketching); }}>{sketching ? "Edit EQ" : "Draw"}</button>{!matching && !sketching && <><label className="flex items-center gap-2 text-daw-text-muted">Analyzer<select className={`${editorSelect} w-32 shrink-0`} aria-label="Analyzer" value={analyzer} onChange={e => { setGrab(null); setAnalyzer(e.target.value); }}><option value="off">Off</option><option value="pre">Input</option><option value="post">Output</option><option value="both">Pre + post</option>{parameter("externalDetector") && <><option value="external">External key</option><option value="all">All + key</option></>}</select></label>
            <button className={editorButton} aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)}>More tools</button>
            {toolsOpen && <div className="flex basis-full flex-wrap items-center gap-2 border-t border-daw-border-light pt-2">
            <button className={editorButton} aria-pressed={grab !== null} disabled={!grab && (!visualization.spectrumReady || analyzer === "off")} onClick={() => setGrab(grab ? null : captureGrab())}>Grab</button>
            <EQFrequencyView minimum={extendedFrequency ? 10 : 20} maximum={extendedFrequency ? 30000 : 20000} zoom={frequencyZoom} center={frequencyCenter} gainRange={gainRange} selectedFrequency={bands[selected].x} selectedGain={bands[selected].y} onChange={(zoom, center, range) => { setGrab(null); setFrequencyZoom(zoom); setFrequencyCenter(center); setGainRange(range); }} />
            <EQAnalyzerReferences model={references} />
            {props.onBrowseInstances && <button className={editorButton} onClick={props.onBrowseInstances}>Instances</button>}
            <EQPeakPicker key={`${schema.instanceId}:${props.address.chain}:${props.address.trackId}:${props.address.fxIndex}:${analyzerSize}:${analyzerSource}`} frame={visualization} available={bands.some(b => !b.enabled && !b.cut)} onAdd={frequency => addBell(frequency)} />
            <AnalyzerDisplayControls autoGrab={autoGrab} onAutoGrab={setAutoGrab} resolution={analyzerSize} source={analyzerSource} onResolution={setAnalyzerSize} onSource={setAnalyzerSource} windowMs={visualization.spectrumWindowMs} binHz={visualization.spectrumBinHz} settings={analyzerSettings} onChange={setAnalyzerSettings} onClear={() => { setAnalyzerSettings(previous => ({ ...previous, paused: false })); setAnalyzerReset(previous => previous + 1); }} />
            {parameter("stereoMode") && <label className="flex items-center gap-2 text-daw-text-muted">Process<select className={editorSelect} aria-label="Processing" value={value("stereoMode")} onChange={e => change("stereoMode", Number(e.target.value))}>{parameter("stereoMode")!.enumOptions?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>}
            </div>}
          </>} </div>
        </div>
        {toolsOpen && parameter("phaseMode") && <div className="eq-phase-details flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 text-[11px]" aria-label="EQ phase processing">
          {minimumFIR && parameter("analogResponse") && <label className="flex items-center gap-2"><input type="checkbox" aria-label="Analog target" disabled={schema.midiPrograms?.preparedConfigurations} checked={value("analogResponse") >= .5} onChange={event => change("analogResponse", event.target.checked ? 1 : 0)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); change("analogResponse", value("analogResponse") >= .5 ? 0 : 1); } }} />Analog target</label>}
          {(preparedPhase || spectralProcessing) && <label className="flex items-center gap-2">Quality<select className={editorSelect} aria-label="Phase resolution" disabled={schema.midiPrograms?.preparedConfigurations} value={value("phaseQuality", 1)} onChange={event => change("phaseQuality", Number(event.target.value))}>{parameter("phaseQuality")?.enumOptions?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
          <span className="tabular-nums text-daw-text-muted" aria-label="EQ latency">{schema.midiPrograms?.preparedConfigurations ? `${schema.midiPrograms.reservedLatency ?? 0} samples / MIDI bank` : preparedPhase || spectralProcessing ? `${visualization.latencySamples ?? ((linearPhase ? [768, 2304, 8448][Math.round(value("phaseQuality", 1))] : minimumFIR ? (value("analogResponse") >= .5 ? 512 : 256) : 0) + ((spectralProcessing || linearDynamics) ? [1024, 2048, 4096][Math.round(value("phaseQuality", 1))] : 0))} samples${visualization.latencyMs !== undefined ? ` / ${visualization.latencyMs.toFixed(1)} ms` : ""}` : "Zero latency"}</span>
          {parameter("spectralProcessing") && <label className="flex items-center gap-2"><input type="checkbox" aria-label="Spectral processing" disabled={schema.midiPrograms?.preparedConfigurations} checked={spectralProcessing} onChange={event => change("spectralProcessing", event.target.checked ? 1 : 0)} />Spectral</label>}
          {preparedPhase && parameter("linearBandDynamics") && <label className="flex items-center gap-2"><input type="checkbox" aria-label="Linear band dynamics" disabled={schema.midiPrograms?.preparedConfigurations} checked={linearDynamics} onChange={event => change("linearBandDynamics", event.target.checked ? 1 : 0)} />Band dynamics</label>}
          {minimumFIR && <details className="relative"><summary className={`${editorButton} cursor-pointer`}>FIR help</summary><p className="absolute top-full right-0 z-20 mt-2 w-64 rounded border border-daw-border-light bg-daw-panel p-3 text-[10px] leading-4 text-daw-text-muted">Causal finite kernels support continuous cuts with a 256-sample processing delay. Analog target uses unwarped prototype responses and adds 256 samples; it is an original finite-band approximation. Resolution controls tail accuracy. The graph shows the actual prepared response. Enable Band dynamics for whole-band processing. Mode/resolution changes restart history.</p></details>}
          {linearPhase && <details className="relative"><summary className={`${editorButton} cursor-pointer`}>Phase help</summary><p className="absolute top-full right-0 z-20 mt-2 w-64 rounded border border-daw-border-light bg-daw-panel p-3 text-[10px] leading-4 text-daw-text-muted">{visualization.phaseUpdating ? "Updating filter. " : ""}Static filters use Linear phase. Linear band dynamics adds one detector envelope per bell/shelf; Spectral processing enables per-frequency dynamics. The prepared correction follows the static filters. Bypass keeps the same delay. Mode/resolution changes restart filter history.</p></details>}
        </div>}
        {matching ? <EQMatchPanel {...props} /> : sketching ? <EQSketchPanel {...props} sampleRate={visualization.sampleRate} /> : <>
        <div ref={graph} {...hoverGrab} className="eq-graph relative min-h-32 flex-1" aria-label="Equalizer frequency response">
          {grab ? <EQSpectrumGrab auditionProps={props} sampleRate={visualization.sampleRate} frequencyMin={frequencyView.min} frequencyMax={frequencyView.max} frame={grab} onRecapture={() => { const next = captureGrab(); if (next) setGrab(next); }} canRecapture={!!visualization.spectrumReady} width={size.width} height={size.height} available={bands.some(b => !b.enabled && !b.cut)} onClose={() => setGrab(null)} onApply={band => addBell(band.frequency, band.gain, band.q)} /> : <ParametricGraph width={size.width} height={size.height} selectedNodeId={String(selected)} selectedNodeIds={selectedBands.map(String)} onSelectionChange={selectGraphBands} onNodeSelect={id => setPrimary(Number(id))}
            xAxis={{ label: "Frequency", min: frequencyView.min, max: frequencyView.max, scale: "log", unit: "Hz", gridLines: eqFrequencyTicks(frequencyView.min, frequencyView.max, size.width - 52) }}
            yAxis={{ label: "Gain", min: -gainRange, max: gainRange, scale: "linear", unit: "dB", gridLines: gainRange === 30 ? [-24, -12, 0, 12, 24] : [-gainRange, -gainRange / 2, 0, gainRange / 2, gainRange] }}
            nodes={bands.filter(band => band.x >= frequencyView.min && band.x <= frequencyView.max && Math.abs(band.y) <= gainRange)} nodeConfig={{ maxNodes: bandCount, zAxis: { label: "Q", min: .1, max: 30, default: 1, sensitivity: .01 } }}
            responseCurve={visualization.responseDb?.map((y, i) => ({ x: frequencies[i], y }))}
            backgroundRegions={references.regions}
            backgroundCurves={[...references.curves.map(curve => ({ ...curve, points: curve.points.map(point => ({ ...point, y: point.y * gainRange / 30 })) })), ...(analyzerSnapshot.ready ? [...(["pre", "both", "all"].includes(analyzer) ? [spectrum("pre", "#a1a8ad")] : []), ...(["post", "both", "all"].includes(analyzer) ? [spectrum("post", "#64b5a1")] : []), ...(["external", "all"].includes(analyzer) ? [spectrum("external", "#df9aab")] : [])] : [])]}
            onNodeDragStart={startGraphEdit} onNodeDragEnd={() => finishGraphEdit()} onNodeDragCancel={() => finishGraphEdit(true)}
            onNodeChange={changeGraphBands}
            onNodeAdd={(x, y) => { void addBell(x, y); }} />}
          {!grab && analyzer !== "off" && <div className="pointer-events-none absolute top-3 right-4 flex flex-col items-end gap-1 text-[9px] text-daw-text-muted"><span>{analyzerSettings.tilt ? `Spectrum + ${analyzerSettings.tilt} dB/oct tilt` : "Spectrum · dBFS"}</span>{analyzerSettings.paused ? <span>Paused</span> : analyzerSettings.hold && <span>Holding peaks</span>}<span>0</span>{["pre", "both", "all"].includes(analyzer) && <span className="text-[#a1a8ad]">Input</span>}{["post", "both", "all"].includes(analyzer) && <span className="text-[#64b5a1]">Output</span>}{["external", "all"].includes(analyzer) && <span className="text-[#df9aab]">External key</span>}</div>}
          {!grab && references.labels.some(Boolean) && <div className="pointer-events-none absolute top-3 left-14 flex max-w-[45%] flex-col gap-1 text-[9px]" aria-label="Reference legend">{references.labels.map((label, i) => label && <span key={i} className={`truncate ${i === 0 ? "text-[#e3ae75]" : "text-[#ac9de0]"}`} title={label}>{i + 1}: {label} / {references.statuses[i]}</span>)}</div>}
          {!grab && analyzer !== "off" && <span className="pointer-events-none absolute right-4 bottom-7 text-[9px] text-daw-text-muted">−{analyzerSettings.range} {analyzerSettings.tilt ? "dB display" : "dBFS"}</span>}
        </div>
        {["external", "all"].includes(analyzer) && !grab && <p className="shrink-0 px-4 py-1 text-[10px] text-daw-text-muted">External key shows the track FX SC input before detector filtering; unavailable sources are silent.</p>}
        {(dynamicInspector || detectorInspector) && selectedExternalKey && <p className="shrink-0 px-4 py-1 text-[10px] text-daw-text-muted">This band uses the FX chain SC source. Missing keys and input/master FX receive silence.</p>}
        {value("detectorListenBand") > 0 && <div className="flex shrink-0 items-center justify-between gap-2 border-y border-daw-accent px-4 py-1 text-xs" role="status"><span>Listening to Band {Math.round(value("detectorListenBand"))} detector</span><button className={editorButton} onClick={() => change("detectorListenBand", 0)}>Stop key listen</button></div>}
        {!grab && <>
        <div className="eq-band-selector flex h-12 shrink-0 items-stretch gap-1 border-y border-daw-border-light px-3 py-1.5" aria-label="Select EQ band">
          {bandCount > 8 && <select className={`${editorSelect} eq-page-picker`} aria-label="Band page" value={Math.floor(selected / 8)} onChange={event => setSelected(Number(event.target.value) * 8)}>{Array.from({ length: Math.ceil(bandCount / 8) }, (_, page) => <option key={page} value={page}>{page * 8 + 1}-{Math.min(bandCount, (page + 1) * 8)}</option>)}</select>}
          {bands.slice(Math.floor(selected / 8) * 8, Math.floor(selected / 8) * 8 + 8).map((band) => { const i = Number(band.id); return <div key={band.id} className={`flex min-w-0 gap-0.5 ${band.cut ? "flex-[1.4]" : "flex-1"}`}>
            <button type="button" className="eq-band flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded text-xs" aria-pressed={selectedBands.includes(i)} aria-label={`${band.label}, ${frequencyLabel(band.x)} Hz, ${band.enabled ? "enabled" : "disabled"}`} onClick={event => { if (event.shiftKey || event.ctrlKey || event.metaKey) { const next = selectedBands.includes(i) ? selectedBands.filter(band => band !== i) : [...selectedBands, i]; selectGraphBands(next.map(String), String(i)); } else setSelected(i); }} style={eqGeometryStyle({ "--band-color": band.color })}><i className="suite-band-dot shrink-0" /><span>{band.cut ?? i + 1}</span><span className="hidden text-[10px] text-daw-text-muted @min-[760px]/eq:inline">{frequencyLabel(band.x)}</span></button>
            {band.cut && <button type="button" className="eq-band flex w-6 shrink-0 items-center justify-center rounded text-daw-text-muted aria-pressed:text-daw-accent" aria-label={`${band.cut} band ${i + 1} on/off`} aria-pressed={band.enabled} title={`${band.cut} ${band.enabled ? "On" : "Off"}`} onClick={() => { setSelected(i); change(`band${i}.enabled`, band.enabled ? 0 : 1); }}><Power size={13} /></button>}
          </div>; })}
        </div>
        <div className="eq-band-heading flex h-11 shrink-0 items-center justify-between gap-2 px-4 text-xs">
          <div className="flex items-center gap-2"><select className={`${editorSelect} eq-compact-band`} aria-label="Band selection" value={selected} onChange={event => setSelected(Number(event.target.value))}>{bands.map((band, index) => <option key={band.id} value={index}>Band {index + 1}</option>)}</select><EQBandActions {...props} selected={selected} label={bands[selected].label} onSelected={setSelected} /><EQBandGroup {...props} selected={selected} bands={selectedBands} setBands={setSelectedBands} /><span className="hidden whitespace-nowrap text-daw-text-muted @min-[760px]:inline">{filterLabel(type, type === 7 ? "All Pass" : parameter(`${prefix}type`)?.enumOptions?.find(o => o.value === type)?.label ?? "")}</span></div>
          {parameter(`${prefix}target`) && (value("stereoMode") < .5 ? <label className="flex items-center gap-1 text-[10px]">Target<select className={editorSelect} aria-label="Band target" value={value(`${prefix}target`)} onChange={e => change(`${prefix}target`, Number(e.target.value))}>{parameter(`${prefix}target`)!.enumOptions?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label> : <span className="text-[10px] text-daw-text-muted">Global target overrides band</span>)}
          <div className="flex items-center gap-1" role="tablist" aria-label="Band inspector"><button className={editorTab} role="tab" aria-selected={!dynamicInspector && !detectorInspector} onClick={() => setInspector("basic")}>Filter</button><button className={editorTab} role="tab" aria-selected={dynamicInspector} disabled={!dynamicFilter || (preparedPhase && !spectralProcessing && !linearDynamics)} title={preparedPhase && !spectralProcessing && !linearDynamics ? "Enable Linear band dynamics or Spectral processing" : undefined} onClick={() => setInspector("dynamic")}>Dynamics</button>{parameter(`${prefix}detectorSource`) && <button className={editorTab} role="tab" aria-selected={detectorInspector} disabled={!dynamicFilter || !dynamicsAvailable} title={!dynamicsAvailable ? "Enable Linear band dynamics, select Spectral, or use Minimum phase" : undefined} onClick={() => setInspector("detector")}>Detector</button>}</div>
        </div>
        {dynamicInspector && parameter(`${prefix}spectralEnabled`) && <div className="flex shrink-0 flex-wrap items-center justify-center gap-4 border-t border-daw-border-light px-3 py-2 text-xs" aria-label="Spectral band controls">
          <label className="flex items-center gap-2"><input type="checkbox" aria-label="Spectral band" checked={value(`${prefix}spectralEnabled`) >= .5} disabled={!spectralProcessing} onChange={event => change(`${prefix}spectralEnabled`, event.target.checked ? 1 : 0)} />Spectral</label>
          {spectralBand ? <><label className="flex items-center gap-2">Density<ProfiledRangeInput data-param={`${prefix}spectralDensity`} className="w-24 accent-daw-accent" aria-label="Spectral density" min={0} max={1} step={.01} value={value(`${prefix}spectralDensity`, .75)} onBeginEdit={() => onGestureStart(`${prefix}spectralDensity`)} onCommitEdit={onGestureEnd} onValueChange={next => change(`${prefix}spectralDensity`, next)} /><span className="w-9 tabular-nums">{Math.round(value(`${prefix}spectralDensity`, .75) * 100)}%</span></label><label className="flex items-center gap-2"><input type="checkbox" aria-label="Spectral detector tilt" checked={value(`${prefix}spectralTilt`, 1) >= .5} onChange={event => change(`${prefix}spectralTilt`, event.target.checked ? 1 : 0)} />+3 dB/oct key tilt</label></> : <span className="text-[10px] text-daw-text-muted">{spectralProcessing ? "Select Spectral for per-frequency correction." : linearDynamics ? "Whole-band correction uses one filtered RMS envelope." : "Enable Spectral processing above to prepare the engine."}</span>}
        {dynamicInspector && parameter(`${prefix}dynamicThresholdMode`) && <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 text-[10px]" aria-label="Dynamics policy">
          <label className="flex items-center gap-2">Threshold<select className={editorSelect} aria-label="Dynamic threshold mode" value={value(`${prefix}dynamicThresholdMode`)} onChange={event => change(`${prefix}dynamicThresholdMode`, Number(event.target.value))}><option value={0}>Manual</option><option value={1}>Adaptive</option></select></label>
          <label className="flex items-center gap-2">Timing<select className={editorSelect} aria-label="Dynamic timing mode" value={value(`${prefix}dynamicTimingMode`)} onChange={event => change(`${prefix}dynamicTimingMode`, Number(event.target.value))}><option value={0}>Manual</option><option value={1}>Auto</option></select></label>
        </div>}
        </div>}

        <div className="eq-inspector flex min-h-28 shrink-0 items-center justify-evenly gap-4 border-t border-daw-border-light px-5 py-3" role="tabpanel" aria-label={`Band ${selected + 1} controls`}>
          {detectorInspector ? <><div className="flex w-28 shrink-0 flex-col gap-2">{render(`${prefix}detectorSource`, "Band key")}{render(`${prefix}detectorMode`, "Trigger")}</div>{value(`${prefix}detectorMode`) >= .5 ? <>{render(`${prefix}detectorLowCut`, "Key low cut")}{render(`${prefix}detectorHighCut`, "Key high cut")}</> : <p className="max-w-44 text-[11px] text-daw-text-muted">Band follows this filter's frequency and Q. Free uses an independent high/low-pass range.</p>}<button className={editorButton} aria-pressed={value("detectorListenBand") === selected + 1} onClick={() => void props.onApplyValues({ detectorListenBand: value("detectorListenBand") === selected + 1 ? 0 : selected + 1, [expandedBuiltInParamId(schema, "auditionBand")]: 0 })}><Headphones size={13} />Listen key</button></> : dynamicInspector ? <><div className="flex w-24 shrink-0 flex-col gap-3">{render("externalDetector", "Global key")}{render(`${prefix}dynamicEnabled`, "Dynamic")}</div>{render(`${prefix}${adaptiveThreshold ? "dynamicSensitivity" : "dynamicThreshold"}`, adaptiveThreshold ? "Sensitivity" : "Threshold")}{render(`${prefix}dynamicRange`, "Range")}{automaticTiming ? <p className="max-w-36 text-[11px] leading-5 text-daw-text-muted" aria-label="Automatic dynamic timing">{dynamicActive ? <>Attack {visualization.dynamicAttackMs?.[selected]?.toFixed(1) ?? "--"} ms<br />Release {visualization.dynamicReleaseMs?.[selected]?.toFixed(0) ?? "--"} ms<br />Follows band frequency, range and key transients.</> : "Auto timing starts with Dynamics On and a non-zero Range."}</p> : <>{render(`${prefix}dynamicAttack`, "Attack")}{render(`${prefix}dynamicRelease`, "Release")}</>}</> : <>
            <div className="flex shrink-0 flex-col gap-2">{render(`${prefix}enabled`, "Enabled")}<button className={editorButton} aria-pressed={value("auditionBand") === selected + 1} onClick={() => void props.onApplyValues({ [expandedBuiltInParamId(schema, "auditionBand")]: value("auditionBand") === selected + 1 ? 0 : selected + 1, detectorListenBand: 0 })} title="Listen to this band's filtered signal"><Headphones size={13} />Listen</button></div>
            <div className="flex min-w-0 flex-col gap-2">
              {parameter(`${prefix}typeExpanded`) ? render(`${prefix}type`, "Shape") : parameter(`${prefix}allPass`) ? <label className="flex min-w-0 flex-col gap-2 text-xs">Shape<select className="suite-select" aria-label="Shape" value={type} onChange={event => { const shape = Number(event.target.value); void props.onApplyValues({ [`${prefix}allPass`]: shape === 7 ? 1 : 0, ...(shape === 7 ? {} : { [expandedBuiltInParamId(schema, `${prefix}type`)]: shape }) }); }}>{parameter(`${prefix}type`)?.enumOptions?.map(option => <option key={option.value} value={option.value}>{filterLabel(option.value, option.label)}</option>)}<option value={7}>All Pass</option></select></label> : render(`${prefix}type`, "Shape")}
              {cutFilter && preparedPhase && render(`${prefix}cutMode`, "Cut target")}
              {type === 0 && parameter(`${prefix}gainQInteraction`) && <label className="flex items-center gap-1 text-[10px]"><input type="checkbox" aria-label="Gain-Q interaction" checked={value(`${prefix}gainQInteraction`) >= .5} onChange={event => change(`${prefix}gainQInteraction`, event.target.checked ? 1 : 0)} />Gain-Q</label>}
            </div>
            {render(`${prefix}freq`, bands[selected].cut ? "Cutoff" : "Frequency")}{gainFilter && render(`${prefix}gain`, "Gain")}{type !== 9 && !advancedCut && !(cutFilter && value(`${prefix}slope`) === 0) && render(`${prefix}q`, "Q")}
            {slopeFilter && (!advancedCut ? render(`${prefix}slope`, "Slope") : value(`${prefix}cutMode`) === 1 ? render(`${prefix}continuousSlope`, "Slope") : <p className="max-w-28 text-[10px] leading-4 text-daw-text-muted">Finite FIR edge; Resolution sets transition width.</p>)}
          </>}
        </div>
        {dynamicInspector && spectralBand && <p className="shrink-0 px-4 py-1 text-[10px] leading-4 text-daw-text-muted">Per-frequency correction follows the static EQ. Higher density narrows triggering; the graph shows static filters. Spectral bypass preserves latency. Listen suspends spectral correction.</p>}
        {type === 7 && <p className="shrink-0 px-4 py-1 text-[10px] text-daw-text-muted">{linearPhase ? "All Pass is inactive in Linear phase. Switch to Minimum phase for phase rotation." : "All Pass changes phase while preserving magnitude. Frequency and Q set the rotation."}</p>}
        {cutFilter && !preparedPhase && value(`${prefix}cutMode`) > 0 && <p className="shrink-0 px-4 py-1 text-[10px] text-daw-text-muted">Enable Minimum FIR or Linear phase to use the saved advanced cut target.</p>}
        </>}
        </>}
        {!matching && !sketching && !grab && dynamicInspector && adaptiveThreshold && <p className="shrink-0 border-t border-daw-border-light px-3 py-1 text-center text-[10px] text-daw-text-muted" role="status">{dynamicActive ? <>Adaptive threshold {visualization.dynamicThresholdDb?.[selected]?.toFixed(1) ?? "--"} dBFS. Higher sensitivity increases triggering; steady key levels become the reference.</> : "Adaptive threshold starts with Dynamics On and a non-zero Range."}</p>}
      </div>
      <aside className="eq-output flex shrink-0 items-center justify-between gap-4" aria-label="Output">
        <div title="Estimated compensation from the filter response; not measured loudness matching">{matrixResponse && !preparedPhase ? <span className="text-[10px] text-daw-text-muted">Auto gain unavailable for band targets</span> : render("autoGain", "Auto gain")}</div>
        <div className="eq-output-readings flex items-center gap-3" aria-label="Stereo output meters">
          {[outputL, outputR].map((db, i) => <div key={i} className="flex items-center gap-1.5 text-[10px] text-daw-text-muted"><span>{i ? "R" : "L"}</span><div className="eq-output-meter" role="meter" aria-label={`${i ? "Right" : "Left"} output peak`} aria-valuemin={-100} aria-valuemax={6} aria-valuenow={db} aria-valuetext={db === undefined ? "Unavailable" : `${db.toFixed(1)} dBFS`}><div style={eqGeometryStyle({ "--meter-level": `${db === undefined ? 0 : Math.max(0, Math.min(100, (db + 90) / 96 * 100))}%` })} /></div></div>)}
          <span className="eq-output-value text-xs tabular-nums">{outputL === undefined || outputR === undefined ? "Unavailable" : Math.max(outputL, outputR) <= -99 ? "Silent" : `${Math.max(outputL, outputR).toFixed(1)} dBFS`}</span>
        </div>
        <div className="eq-output-trim">{render("outputGain", "Output")}</div>
      </aside>
    </div>
  </div>;
}
