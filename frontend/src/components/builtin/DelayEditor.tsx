import { useState } from "react";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { changedEffectSettings, detailDescription, EffectDetailIndicator } from "./EffectDetailIndicator";
import { createEffectParameterRenderer, EffectModeSwitch, EffectMeterProvider, useEffectMeterSnapshot, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import "./DelayEditor.css";

type Detail = "motion" | "duck" | "routing" | "engine";
const descriptions = ["Clear repeats with adjustable colour.", "Tape-inspired repeats with custom wow and flutter.",
  "Darkened repeats with controllable feedback colour.", "Four-head repeats; shape the head pattern in Routing.",
  "Two delay engines with independent feedback, tone and motion."];

function DelayTempo() {
  const meters = useEffectMeterSnapshot();
  const tempo = Number.isFinite(meters?.tempoBpm) && meters!.tempoBpm! > 0 ? meters!.tempoBpm! : null;
  return <span className="tabular-nums">{tempo === null ? "—" : Number(tempo.toFixed(1))}<small>{tempo === null ? "TEMPO UNAVAILABLE" : meters?.tempoSource === "fallback" ? "BPM · FALLBACK" : meters?.tempoSource === "retained-host" ? "BPM · RETAINED HOST" : "BPM · HOST"}</small></span>;
}
function DelayTimeReadout({ channel, sync }: { channel: "L" | "R"; sync: boolean }) {
  const meters = useEffectMeterSnapshot();
  const effective = channel === "L" ? meters?.effectiveDelayMsL : meters?.effectiveDelayMsR;
  return <div className="delay-time-readout tabular-nums text-[10px]" role="status">{sync ? Number.isFinite(effective) && effective! > 0 ? `${effective!.toFixed(1)} ms · effective` : "Effective time unavailable" : "Free time · 1–2,000 ms"}</div>;
}

export function DelayEditor(props: ApprovedEffectEditorProps) {
  const { schema } = props;
  const control = createEffectParameterRenderer(props);
  const value = (id: string) => findBuiltInParameter(schema, id)?.value ?? 0;
  const mode = Math.round(value("delayMode"));
  const sync = value("tempoSync") >= .5;
  const type = findBuiltInParameter(schema, "delayMode");
  const modeLabel = type?.enumOptions?.find(option => option.value === mode)?.label ?? "Delay";
  const [detail, setDetail] = useState<Detail | null>(null);
  const visibleDetail = detail === "engine" && mode !== 4 ? "routing" : detail;
  const diffusion = value("diffusionAmount") > 0;
  const diffusionDescription = diffusion ? `Diffusion adds ${Number(value("diffusionSpanMs").toFixed(1))} ms of post-repeat span.` : "Diffusion off.";
  const pages: [Detail, string][] = [["motion", "Motion"], ["duck", "Ducking"], ["routing", mode === 3 ? "Heads & routing" : "Routing"], ...(mode === 4 ? [["engine", "Engine B"] as [Detail, string]] : [])];
  const detailState: Record<Detail, string> = {
    motion: changedEffectSettings(schema, ["customMotion", "wowDepthMs", "wowRateHz", "flutterDepthMs", "flutterRateHz"]),
    duck: [value("ducking") > 0 ? `Ducking ${Number((value("ducking") * 100).toFixed(1))}%` : "", changedEffectSettings(schema, ["duckAttackMs", "duckReleaseMs", "duckMaxReduction"])].filter(Boolean).join("; "),
    routing: changedEffectSettings(schema, ["crossFeed", "stereoWidth", ...(mode >= 3 ? ["topologyControl"] : []), ...(mode === 4 ? ["dualTimeRatio"] : [])]),
    engine: mode === 4 ? ["Engine B active", changedEffectSettings(schema, ["dualFeedback", "dualHighPassHz", "dualLowPassHz", "dualSaturation", "dualModDepthMs", "dualModRateHz"])].filter(Boolean).join("; ") : "",
  };
  if (value("customMotion") < .5 && changedEffectSettings(schema, ["wowDepthMs", "wowRateHz"])) detailState.motion += "; custom wow values retained while off";
  const detailSummary = pages.filter(([id]) => detailState[id]).map(([id, label]) => detailDescription(label, detailState[id])).join(". ");

  const timeBlock = (channel: "L" | "R") => {
    return <div className="delay-time min-w-0">
      <div className="delay-time-label flex items-center gap-2 text-[10px] tracking-[1.3px] font-[800]"><b>{channel}</b><span>{channel === "L" ? "LEFT" : "RIGHT"} DELAY</span></div>
      {control(sync ? `syncNote${channel}` : `delayTime${channel}`, true, `${channel === "L" ? "Left" : "Right"} ${sync ? "note division" : "delay time"}`)}
      <DelayTimeReadout channel={channel} sync={sync} />
      <div className="delay-time-rule flex items-end justify-between" aria-hidden="true">{Array.from({ length: 21 }, (_, i) => <i key={i} data-major={i % 5 === 0} />)}</div>
    </div>;
  };

  return <EffectMeterProvider {...props}><div className="approved-effect-editor delay-editor flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="delay">
    <EQToolbar {...props} />
    <div className="delay-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[23px_26px_13px] gap-[16px]">
      <header className="delay-heading flex shrink-0 items-end justify-between gap-3">
        <div className="min-w-0"><h2>ECHO ENGINE</h2><EffectModeSwitch {...props} parameter={type} label="Echo engine" /></div>
        <div className="delay-clock flex shrink-0 flex-col items-end gap-2">{control("tempoSync", false, "Tempo sync")}
          <DelayTempo />
        </div>
      </header>
      <section className="delay-primary grid shrink-0" aria-label="Delay timing and balance">
        <div className="delay-time-pair grid min-w-0 p-[23px_22px_12px] gap-[20px_22px]">
          {timeBlock("L")}{timeBlock("R")}
          <div className="delay-pair-footer col-span-2 flex items-center justify-between gap-2">{control("pingPong", false, "Ping-pong")}<span>{modeLabel} · stereo timing</span></div>
        </div>
        <div className="delay-feedback flex flex-col items-center justify-between gap-2"><span className="delay-overline">REPEAT</span>{control(mode === 3 ? "multiFeedback" : "feedback", true, mode === 3 ? "Head feedback" : "Feedback")}<span className="delay-control-caption text-[10px]">Return to the delay</span></div>
        <div className="delay-balance flex flex-col items-center justify-between gap-2"><span className="delay-overline">BALANCE</span>{control("mix", true, "Dry / wet")}<div className="delay-dry-wet flex w-full items-center gap-2 text-[9px] tracking-[1px]"><span>DRY</span><i className="flex-1" /><span>WET</span></div></div>
      </section>
      <section className="delay-shaping grid shrink-0" aria-label="Delay colour and shaping">
        <div><h3>COLOUR</h3><div className="delay-controls flex items-center justify-evenly gap-2">{control("fbSaturation", false, "Drive")}{control("ducking", false, "Ducking")}</div></div>
        <div><h3>TONE</h3><div className="delay-controls flex items-center justify-evenly gap-2">{control("hpfFreq", false, "Low cut")}{control("lpfFreq", false, "High cut")}</div></div>
        <div><h3>DIFFUSION</h3><div className="delay-controls flex items-center justify-evenly gap-2">{control("diffusionAmount", false, "Amount")}{control("diffusionSpanMs", false, "Span")}</div></div>
      </section>
      <div className="delay-foot flex shrink-0 items-center justify-between gap-3"><p><b>{modeLabel.toUpperCase()}</b><span className="delay-description">{descriptions[mode]}</span><span className="delay-compact-contract">{diffusionDescription}</span></p>
        <button type="button" className="delay-detail-button text-[12px] whitespace-nowrap p-[7px_13px]" aria-label={detail ? "Close detail −" : "Detail +"} aria-description={detailSummary || undefined} title={detailDescription("Detail", detailSummary)} aria-expanded={detail !== null} aria-controls="delay-detail" onClick={() => setDetail(detail ? null : "motion")}>{detail ? "Close detail −" : "Detail +"}<EffectDetailIndicator summary={detailSummary} /></button>
      </div>
      {detail && <section className="delay-detail shrink-0" id="delay-detail" aria-label="Delay detail">
        <div className="delay-tabs flex flex-wrap gap-[2px] p-[0_10px]" role="group" aria-label="Delay detail pages">{pages.map(([id, label]) => <button key={id} type="button" aria-label={label} aria-description={detailState[id] || undefined} title={detailDescription(label, detailState[id])} aria-pressed={visibleDetail === id} onClick={() => setDetail(id)}>{label}<EffectDetailIndicator summary={detailState[id]} /></button>)}</div>
        <div className="delay-detail-body flex flex-col gap-3 p-[15px_20px]">
          {visibleDetail === "motion" && <>{control("customMotion", false, "Custom wow")}<div className="delay-detail-controls flex flex-wrap items-center gap-6">{value("customMotion") >= .5 && <>{control("wowDepthMs", false, "Wow depth")}{control("wowRateHz", false, "Wow rate")}</>}{control("flutterDepthMs", false, "Flutter depth")}{control("flutterRateHz", false, "Flutter rate")}</div><p>{value("customMotion") >= .5 ? "Custom wow controls the main repeat engine’s slow motion. Flutter adds faster movement." : "The repeat engine sets its own wow. Enable Custom wow to use the stored depth and rate."}</p></>}
          {visibleDetail === "duck" && <><div className="delay-detail-controls flex flex-wrap items-center gap-6">{control("duckAttackMs", false, "Attack")}{control("duckReleaseMs", false, "Release")}{control("duckMaxReduction", false, "Reduction limit")}</div><p>Ducking amount stays on the front panel. These controls set how the wet signal returns between phrases.</p></>}
          {visibleDetail === "routing" && <><div className="delay-detail-controls flex flex-wrap items-center gap-6">{control("crossFeed", false, "Crossfeed")}{control("stereoWidth", false, "Stereo width")}{mode === 3 && control("topologyControl", false, "Head pattern")}{mode === 4 && <>{control("topologyControl", false, "Topology")}{control("dualTimeRatio", false, "B time ratio")}</>}</div><p>{mode === 4 ? "Engine B has independent feedback, tone and motion. Its time follows each channel’s main delay by B time ratio." : mode === 3 ? "Four weighted heads share a feedback path. Head pattern changes their timing and balance; the heads are not individually switchable." : "Left and right timing remain independent. Crossfeed routes feedback between channels; Ping-pong alternates the return."}</p></>}
          {visibleDetail === "engine" && <><div className="delay-detail-controls flex flex-wrap items-center gap-6">{control("dualFeedback", false, "B feedback")}{control("dualHighPassHz", false, "B low cut")}{control("dualLowPassHz", false, "B high cut")}{control("dualSaturation", false, "B colour")}{control("dualModDepthMs", false, "B motion")}{control("dualModRateHz", false, "B rate")}</div><p>Engine A uses the front-panel feedback and tone. Engine B retains its own settings when another mode is selected.</p></>}
        </div>
      </section>}
      <footer className="delay-contract mt-auto flex shrink-0 flex-wrap justify-between gap-2 text-[11px] pt-[10px]"><span>{diffusionDescription}</span><span>Free times are retained during sync.</span></footer>
    </div>
  </div></EffectMeterProvider>;
}
