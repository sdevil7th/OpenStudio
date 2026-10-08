import { useState } from "react";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { changedEffectSettings, detailDescription, EffectDetailIndicator } from "./EffectDetailIndicator";
import { createEffectParameterRenderer, EffectModeSwitch, EffectMeterProvider, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { LiveSignalLevelPanel } from "./CoreEffectVisuals";
import "./CoreEffectEditors.css";
import "./SaturatorEditor.css";

export function SaturatorEditor(props: ApprovedEffectEditorProps) {
  const p = (id: string) => findBuiltInParameter(props.schema, id);
  const engine = p("colourEngine")?.value ?? 0, enhanced = engine >= .5;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const control = createEffectParameterRenderer(props);
  const filterState = changedEffectSettings(props.schema, ["inputTrim", "cornerBump", "steepCut"]);
  const changeEngine: ApprovedEffectEditorProps["onChange"] = (parameter, value) => {
    if (busy) return;
    setBusy(true); setError("");
    void props.onApplyValues({ [parameter.id]: value }).then(ok => { if (!ok) setError("The processor did not accept the colour engine change."); })
      .catch(() => setError("Could not change colour engine.")).finally(() => setBusy(false));
  };
  return <EffectMeterProvider {...props}><div className="approved-effect-editor core-effect-editor saturator-approved flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="saturator">
    <EQToolbar {...props} />
    <div className="core-effect-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px_24px] gap-[15px]" inert={busy}>
      <header className="saturator-voices shrink-0"><EffectModeSwitch {...props} onChange={changeEngine} parameter={p("colourEngine")} label="Colour engine" descriptions={{ 0: "8 algorithms", 1: "Magnetic weight", 2: "Soft recovery", 3: "Dense harmonics", 4: "Fast edge", 5: "Firm symmetry" }} /></header>
      {error && <p role="alert" className="core-effect-error text-[12px]">{error}</p>}
      <div className="saturator-main flex shrink-0 items-center gap-7"><div className="saturator-drive core-main-controls flex flex-col items-center p-[8px_12px] gap-[18px]">{control("drive", true, "Drive")}{enhanced && control("boostDrive", false, "Boost +20 dB")}</div><LiveSignalLevelPanel /><div className="saturator-output core-main-controls flex flex-col items-center p-[8px_12px] gap-[18px]">{control("outputGain", true, "Output")}{enhanced ? control("driveCompensation", false, "Compensate") : <span className="core-detail-note text-[12px] leading-[1.6]">Legacy compensation</span>}<span className="core-detail-note text-[12px] leading-[1.6]">Estimated gain matching</span></div></div>
      <div className="saturator-bottom flex shrink-0 items-center gap-5"><div className="saturator-tone flex min-w-0 flex-1 items-center justify-around gap-5">{control("lowCutFreq", false, "Low cut")}{enhanced && control("colourTone", false, "Tilt")}{control("toneFreq", false, "High cut")}{enhanced && control("colourDynamics", false, "Dynamics")}{control("mix", false, "Mix")}</div><div className="saturator-quality flex shrink-0 items-center gap-4">{!enhanced && control("satType", false, "Legacy type")}{control("asymmetry", false, "Bias")}{control("oversampleMode", false, "Quality")}</div></div>
      {enhanced && <details className="core-detail saturator-detail shrink-0"><summary aria-description={filterState || undefined} title={detailDescription("Input & filter detail", filterState)}>Input &amp; filter detail<EffectDetailIndicator summary={filterState} /></summary><div className="core-detail-content flex flex-wrap items-center p-[14px_18px] gap-[20px]">{control("inputTrim", false, "Input trim")}{control("cornerBump", false, "Corner bump")}{control("steepCut", false, "High cut slope")}</div></details>}
      <p className="core-detail-note saturator-caption mt-auto text-[12px] leading-[1.6]">The display shows actual signal levels. Colour engines retain their parameters when you switch back to Legacy.</p>
    </div>
  </div></EffectMeterProvider>;
}
