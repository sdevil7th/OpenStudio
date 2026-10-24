import { useRef, useState } from "react";
import { useEditorOverview } from "./useEditorOverview";
import { usePluginFeatureReveal } from "../../utils/pluginFeatureNavigation";
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
  const style = value("limitingStyle"), edge = style === 6, classic = style === 0;
  const [detail, setDetail] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const overview = useEditorOverview(editor);
  usePluginFeatureReveal(editor, "limiter", ({ parameterId: id }) => {
    if (id) setDetail(["unityAudition", "linkedEdits"].includes(id) ? "Monitoring" : ["oversampleQuality", "truePeak"].includes(id) ? "Quality" : "Timing & linking");
  });
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
  const renderDetail = (detail: string) => <div className="core-detail-content flex flex-wrap items-center justify-around p-[14px_18px] gap-[20px]">
          {detail === "Timing & linking" ? <>{control("lookaheadMs", false, "Lookahead")}{!edge && control("slowAttackMs", false, "Attack", classic)}{control("releaseMs", false, "Release")}{!edge && control("automaticRelease", false, "Auto release", classic)}{control("transientLink", false, "Transient link", classic)}{!edge && control("releaseLink", false, "Release link", classic)}{classic && <p className="core-detail-note text-xs leading-relaxed">Classic uses linked peak recovery. Attack, Auto release and separate linking settings are retained for other algorithms.</p>}{edge && <p className="core-detail-note text-[12px] leading-[1.6]">Edge uses minimal peak hold and fast recovery. Slow attack, automatic recovery and release linking do not apply.</p>}</>
            : detail === "Monitoring" ? <>{control("unityAudition", false, "Unity gain audition")}{control("linkedEdits", false, "Link threshold / ceiling")}<p className="core-detail-note text-[12px] leading-[1.6]">Linked edits preserve the threshold-to-ceiling distance within both controls’ limits.</p></>
            : <>{control("oversampleQuality", false, "Oversampling")}<LimiterLatency /><p className="core-detail-note text-[12px] leading-[1.6]">True-peak protection remains independent of the chosen response. Loudness readings support comparison; target delivery requirements depend on the destination.</p></>}
        </div>;

  return <EffectMeterProvider {...props}><div ref={editor} className="approved-effect-editor core-effect-editor limiter-approved flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="limiter">
    <EQToolbar {...props} />
    <div className="core-effect-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px_24px] gap-[15px]">
      <div className="core-effect-topline flex shrink-0 flex-wrap items-center justify-between gap-[16px]">{control("limitingStyle", false, "Algorithm")}<div className="flex items-center gap-4">{control("truePeak", false, "True peak")}{control("oversampleQuality", false, "Oversampling")}</div></div>
      <div className="limiter-main flex shrink-0 gap-5"><div className="limiter-input flex shrink-0 flex-col justify-between gap-3 p-4"><div className="flex items-start justify-around gap-5">{control("threshold", true, "Threshold", false, "fader")}{control("ceiling", true, "Ceiling", false, "fader")}</div><div className="flex flex-wrap justify-center gap-2">{control("continuousGain", false, "Continuous gain")}{control("linkedEdits", false, "Link threshold / ceiling")}</div></div><LimiterMetering address={props.address} /></div>
      <section className="core-detail shrink-0" data-overview={overview} aria-label="Limiter detail"><div className="core-detail-tabs flex flex-wrap p-[0_8px] gap-[3px]" role="group" aria-label="Limiter detail pages">{["Timing & linking", "Monitoring", "Quality"].map(tab => <button key={tab} type="button" aria-label={tab} aria-description={detailState[tab] || undefined} title={detailDescription(tab, detailState[tab])} aria-expanded={detail === tab} onClick={() => setDetail(detail === tab ? null : tab)}>{tab}<EffectDetailIndicator summary={detailState[tab]} /></button>)}</div>
        {(overview ? ["Timing & linking", "Monitoring", "Quality"] : detail ? [detail] : []).map(page => <section key={page}>{overview && <h3 className="border-t border-daw-border-light px-5 pt-5 text-lg">{page}</h3>}{renderDetail(page)}</section>)}
      </section>
    </div>
  </div></EffectMeterProvider>;
}
