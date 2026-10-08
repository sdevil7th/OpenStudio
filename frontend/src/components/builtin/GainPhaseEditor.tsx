import { editorButton, editorSelect } from "./PluginEditorControls";
import { memo, useState } from "react";
import { createEffectParameterRenderer, useApprovedEffectMeters, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { EQToolbar } from "./EQToolbar";
import { GainPhaseAlignmentPanel } from "./GainPhaseAlignmentPanel";
import { SpectralPhaseGuide } from "./SpectralPhaseGuide";
import "./GainPhaseEditor.css";

const Correlation = memo(function Correlation(props: ApprovedEffectEditorProps) {
  const meters = useApprovedEffectMeters(props);
  const correlation = meters?.correlation;
  const valid = typeof correlation === "number" && Number.isFinite(correlation);
  return <div className="gain-phase-correlation flex items-center gap-3 text-xs" aria-label="Stereo correlation">
    <span>−1</span><meter className="min-w-0 flex-1" min={-1} max={1} value={valid ? correlation : 0} aria-label="Output stereo correlation" aria-valuetext={valid ? correlation.toFixed(2) : "Unavailable"} />
    <span>+1</span><output>{valid ? correlation.toFixed(2) : "Unavailable"}</output>
  </div>;
});

export function GainPhaseEditor(props: ApprovedEffectEditorProps) {
  const [tab, setTab] = useState("Alignment");
  const [point, setPoint] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const control = createEffectParameterRenderer(props);
  const value = (id: string) => props.schema.parameters.find(p => p.id === id)?.value ?? 0;
  const copyChannel = async (from: "L" | "R") => {
    setBusy(true); setError("");
    const to = from === "L" ? "R" : "L";
    try {
      const changes = Object.fromEntries([
        ...["delay", "fine", "polarity", "phaseEnabled", "phaseFrequency", "phaseStages"].map(id => [id + to, value(id + from)]),
        ...Array.from({ length: 48 }, (_, index) => [`spectralPhase${to}${index}`, value(`spectralPhase${from}${index}`)]),
      ]);
      if (!await props.onApplyValues(changes)) throw new Error("Channel settings could not be copied.");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const tabs = ["Alignment", "Phase shaping", "Spectral"];
  return <div className="approved-effect-editor gain-phase-editor flex min-h-0 min-w-0 flex-1 flex-col">
    <EQToolbar {...props} />
    <header className="gain-phase-heading flex shrink-0 items-center justify-between gap-4"><div><h2>GAIN / PHASE</h2><p>Timing, polarity and microphone alignment</p></div><span className="gain-phase-mark" aria-hidden="true">Ø</span></header>
    <div className="gain-phase-manual flex shrink-0 items-center justify-evenly gap-4 @max-[760px]/gain-phase:[&_.suite-parameter>span:last-child]:flex-col @max-[760px]/gain-phase:[&_.suite-parameter>span:last-child]:items-center @max-[760px]/gain-phase:[&_.suite-parameter>span:last-child]:gap-0">
      {control("gain", true, "Gain")}
      {(["L", "R"] as const).map(channel => <section key={channel} className="gain-phase-channel flex min-w-0 flex-1 items-center justify-evenly gap-3" aria-label={channel === "L" ? "Left timing" : "Right timing"}>
        <div className="flex flex-col gap-2"><h3>{channel === "L" ? "LEFT" : "RIGHT"}</h3>{control(`polarity${channel}`, false, "Polarity Ø")}</div>
        {control(`delay${channel}`, false, "Delay")}{control(`fine${channel}`, false, "Fine")}
      </section>)}
    </div>
    <div className="gain-phase-tabs flex shrink-0 gap-1" role="tablist" aria-label="Phase workspace">
      {tabs.map((name, index) => <button type="button" role="tab" id={`phase-workspace-${index}`} key={name}
        aria-selected={tab === name} aria-controls="phase-workspace" tabIndex={tab === name ? 0 : -1}
        onClick={() => setTab(name)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
          setTab(tabs[next]); document.getElementById(`phase-workspace-${next}`)?.focus();
        }}>{name}{name === "Phase shaping" && (value("phaseEnabledL") >= .5 || value("phaseEnabledR") >= .5) ? " •" : name === "Spectral" && value("spectralPhaseEnabled") >= .5 ? " •" : ""}</button>)}
    </div>
    <div className="gain-phase-workspace min-h-0 flex-1 overflow-y-auto" id="phase-workspace" role="tabpanel" aria-labelledby={`phase-workspace-${tabs.indexOf(tab)}`}>
      {tab === "Alignment" ? <GainPhaseAlignmentPanel address={props.address} historyReplayRevision={props.historyReplayRevision} onApply={props.onApplyAlignment} /> : <div className="flex flex-col gap-5 p-5">
        {tab === "Phase shaping" ? <><div className="flex flex-wrap justify-evenly gap-4">{["L", "R"].map(channel => <section key={channel} className="flex flex-col gap-3" aria-label={`${channel === "L" ? "Left" : "Right"} phase rotation`}>
          {control(`phaseEnabled${channel}`, false, `${channel === "L" ? "Left" : "Right"} phase`)}<div className="flex gap-5">{control(`phaseFrequency${channel}`, false, "Corner")}{control(`phaseStages${channel}`, false, "Stages")}</div>
        </section>)}</div><Correlation {...props} /><p className="text-xs text-daw-text-muted">Correlation compares the output channels. It is independent of reference-track alignment confidence.</p></> : <>
          <div className="flex flex-wrap items-center justify-between gap-4">{control("spectralPhaseEnabled", false, "Spectral phase")}{control("spectralPhaseAmount", false, "Amount")}</div>
          <SpectralPhaseGuide schema={props.schema} />
          <details><summary className={`${editorButton} cursor-pointer`}>Edit saved phase points</summary><div className="mt-4 flex flex-wrap items-center justify-evenly gap-4"><label className="flex flex-col gap-2 text-xs">Frequency point<select className={editorSelect} aria-label="Spectral phase frequency point" value={point} onChange={event => setPoint(Number(event.target.value))}>{Array.from({ length: 48 }, (_, index) => <option value={index} key={index}>{Math.round(20 * 1000 ** (index / 47)).toLocaleString()} Hz</option>)}</select></label>{control(`spectralPhaseL${point}`, false, "Left phase")}{control(`spectralPhaseR${point}`, false, "Right phase")}</div></details>
        </>}
        <div className="flex justify-center gap-3">{(["L", "R"] as const).map(from => <button key={from} type="button" className={editorButton} disabled={busy} onClick={() => void copyChannel(from)}>Copy {from} → {from === "L" ? "R" : "L"}</button>)}</div>
        {error && <p role="alert" className="text-xs text-daw-record">{error}</p>}
      </div>}
    </div>
  </div>;
}
