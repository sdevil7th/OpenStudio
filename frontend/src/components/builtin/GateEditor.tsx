import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { createEffectParameterRenderer, EffectModeSwitch, EffectMeterProvider, useEffectMeterSnapshot, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { LiveDynamicsHistory } from "./CoreEffectVisuals";
import "./CoreEffectEditors.css";
import "./GateEditor.css";

function GateStatus({ listening }: { listening: boolean }) {
  const meters = useEffectMeterSnapshot();
  const stage = meters?.gateStage;
  return <span className="gate-live-status" role="status"><i aria-hidden="true" data-open={meters?.gateOpen} />{listening ? "LISTENING TO DETECTOR" : stage === undefined ? "STATUS UNAVAILABLE" : ["CLOSED", "OPENING", "OPEN", "HOLDING", "CLOSING", "EXPANDING"][stage] ?? "STATUS UNAVAILABLE"}</span>;
}
export function GateEditor(props: ApprovedEffectEditorProps) {
  const p = (id: string) => findBuiltInParameter(props.schema, id);
  const value = (id: string) => p(id)?.value ?? 0;
  const control = createEffectParameterRenderer(props);
  const expansion = value("expansionMode") >= .5;
  const mode = p("expansionMode");
  return <EffectMeterProvider {...props}><div className="approved-effect-editor core-effect-editor gate-approved flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="gate">
    <EQToolbar {...props} />
    <div className="core-effect-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px_24px] gap-[15px]">
      <div className="core-effect-topline flex shrink-0 flex-wrap items-center justify-between gap-[16px]">
        <EffectModeSwitch {...props} parameter={mode && { ...mode, enumOptions: [{ value: 0, label: "Gate" }, { value: 1, label: "Expander" }] }} label="Gate operation" />
        <GateStatus listening={value("detectorListen") >= .5} />{control("detectorMode", false, "Detection")}
      </div>
      <div className="gate-meter-row flex shrink-0 gap-4"><LiveDynamicsHistory detector threshold={value("threshold")} /></div>
      <div className="core-main-controls gate-main flex shrink-0 items-center justify-around p-[8px_12px] gap-[18px]" aria-label="Gate primary controls">
        {control("threshold", true, "Open threshold")}{control("hysteresis", false, "Hysteresis")}
        <div className="gate-timing flex items-center">{control("attackMs", false, "Attack")}{control("holdMs", false, "Hold")}{control("releaseMs", false, "Release")}</div>
        {control("range", true, "Max reduction")}
      </div>
      <div className="gate-detail-panels flex shrink-0 gap-3">
        <section className="core-detail min-w-0 flex-1" aria-label="Gate detector">
          <h3 className="core-panel-label px-4 pt-3 text-[10px] tracking-[1.5px]">DETECTOR <small>Hear the trigger signal</small></h3>
          <div className="core-detail-content flex flex-wrap items-center justify-around p-[14px_18px] gap-[20px]">{control("externalDetector", false, "Key source")}{control("sidechainHPF", false, "Low cut")}{control("sidechainLPF", false, "High cut")}{control("detectorListen", false, "Listen")}</div>
          {!expansion && p("transientResponse") && <div className="flex flex-wrap items-center gap-3 border-t border-daw-border-light p-3">{control("transientResponse", false, "Onset response")}<p className="core-detail-note min-w-0 flex-1 text-[12px] leading-[1.6]">{value("transientResponse") >= .5 ? "Peak and Auto detect short onsets immediately; Attack still controls opening. RMS retains its integration window." : "Legacy detector timing preserves saved projects and can soften or miss short bursts."}</p></div>}
        </section>
        <section className="core-detail gate-behavior min-w-0" aria-label="Gate behavior"><h3 className="core-panel-label px-4 pt-3 text-[10px] tracking-[1.5px]">BEHAVIOR</h3>
          <div className="core-detail-content flex flex-wrap items-center justify-around p-[14px_18px] gap-[20px]">{expansion && <>{control("expansionRatio", false, "Ratio")}{control("expansionKnee", false, "Knee")}</>}{control("mix", false, "Mix")}{control("rateIndependentDetector", false, "Rate-correct timing")}</div>
        </section>
      </div>
    </div>
  </div></EffectMeterProvider>;
}
