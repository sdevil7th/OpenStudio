import { useState } from "react";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { changedEffectSettings, detailDescription, EffectDetailIndicator } from "./EffectDetailIndicator";
import { createEffectParameterRenderer, EffectMeterProvider, useEffectMeterSnapshot, useReceivedEffectMeters, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { EffectStat } from "./CoreEffectVisuals";
import { LoudnessPanel } from "./LoudnessPanel";
import "./CoreEffectEditors.css";
import "./LimiterEditor.css";

function LimiterMetering({ address }: Pick<ApprovedEffectEditorProps, "address">) {
  const { meters, receivedAt } = useReceivedEffectMeters();
  return <section className="limiter-metering flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Loudness and transients"><LoudnessPanel address={address} meters={meters} receivedAt={receivedAt} threshold={null} /><div className="limiter-peak-stats flex shrink-0 flex-wrap justify-around gap-3"><EffectStat label="SHORT TERM" value={meters?.shortTermLUFS} unit="LUFS" /><EffectStat label="TRUE PEAK" value={meters?.outputTruePeakDb} unit="dBTP" /><EffectStat label="REDUCTION" value={meters?.gainReductionDb === undefined ? undefined : Math.abs(meters.gainReductionDb)} unit="dB" /></div></section>;
}
function LimiterLatency() {
  const meters = useEffectMeterSnapshot();
  return <p className="core-detail-note text-[12px] leading-[1.6]">{Number.isFinite(meters?.latencyMs) ? `Reported latency: ${meters!.latencyMs!.toFixed(2)} ms.` : "Latency compensation is reported to the host by the processor."} Oversampling changes restart processing history. 16× and 32× use substantially more CPU.</p>;
}
export function LimiterEditor(props: ApprovedEffectEditorProps) {
  const p = (id: string) => findBuiltInParameter(props.schema, id);
  const value = (id: string) => p(id)?.value ?? 0;
  const style = value("limitingStyle"), edge = style === 6;
  const [detail, setDetail] = useState("Timing & linking");
  const detailState: Record<string, string> = {
    "Timing & linking": changedEffectSettings(props.schema, ["lookaheadMs", "releaseMs", "transientLink", ...(!edge ? ["slowAttackMs", "automaticRelease", "releaseLink"] : [])]),
    Monitoring: changedEffectSettings(props.schema, ["unityAudition", "linkedEdits"]),
    Quality: changedEffectSettings(props.schema, ["oversampleQuality", "truePeak"]),
  };
  const change: ApprovedEffectEditorProps["onChange"] = (parameter, next) => {
    if (value("linkedEdits") >= .5 && ["threshold", "ceiling"].includes(parameter.id)) {
      const partner = p(parameter.id === "threshold" ? "ceiling" : "threshold");
      if (!partner) return;
      const delta = Math.max(Math.max(parameter.min - parameter.value, partner.min - partner.value), Math.min(Math.min(parameter.max - parameter.value, partner.max - partner.value), next - parameter.value));
      props.onChange(parameter, parameter.value + delta); props.onChange(partner, partner.value + delta);
    } else props.onChange(parameter, next);
  };
  const control = createEffectParameterRenderer({ ...props, onChange: change });
  return <EffectMeterProvider {...props}><div className="approved-effect-editor core-effect-editor limiter-approved flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="limiter">
    <EQToolbar {...props} />
    <div className="core-effect-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px_24px] gap-[15px]">
      <div className="core-effect-topline flex shrink-0 flex-wrap items-center justify-between gap-[16px]">{control("limitingStyle", false, "Algorithm")}<div className="flex items-center gap-4">{control("truePeak", false, "True peak")}{control("oversampleQuality", false, "Oversampling")}</div></div>
      <div className="limiter-main flex shrink-0 gap-5"><div className="limiter-input core-main-controls flex shrink-0 flex-col items-center justify-around p-[8px_12px] gap-[18px]">{control("threshold", true, "Threshold")}{control("continuousGain", false, "Continuous gain")}{control("ceiling", true, "Ceiling")}</div><LimiterMetering address={props.address} /></div>
      <section className="core-detail shrink-0" aria-label="Limiter detail"><div className="core-detail-tabs flex flex-wrap p-[0_8px] gap-[3px]" role="group" aria-label="Limiter detail pages">{["Timing & linking", "Monitoring", "Quality"].map(tab => <button key={tab} type="button" aria-label={tab} aria-description={detailState[tab] || undefined} title={detailDescription(tab, detailState[tab])} aria-pressed={detail === tab} onClick={() => setDetail(tab)}>{tab}<EffectDetailIndicator summary={detailState[tab]} /></button>)}</div>
        <div className="core-detail-content flex flex-wrap items-center justify-around p-[14px_18px] gap-[20px]">
          {detail === "Timing & linking" ? <>{control("lookaheadMs", false, "Lookahead")}{!edge && control("slowAttackMs", false, "Attack")}{control("releaseMs", false, "Release")}{!edge && control("automaticRelease", false, "Auto release")}{control("transientLink", false, "Transient link")}{!edge && control("releaseLink", false, "Release link")}{edge && <p className="core-detail-note text-[12px] leading-[1.6]">Edge uses minimal peak hold and fast recovery. Slow attack, automatic recovery and release linking do not apply.</p>}</>
            : detail === "Monitoring" ? <>{control("unityAudition", false, "Unity gain audition")}{control("linkedEdits", false, "Link threshold / ceiling")}<p className="core-detail-note text-[12px] leading-[1.6]">Linked edits preserve the threshold-to-ceiling distance within both controls’ limits.</p></>
            : <>{control("oversampleQuality", false, "Oversampling")}<LimiterLatency /><p className="core-detail-note text-[12px] leading-[1.6]">True-peak protection remains independent of the chosen response. Loudness readings support comparison; target delivery requirements depend on the destination.</p></>}
        </div>
      </section>
    </div>
  </div></EffectMeterProvider>;
}
