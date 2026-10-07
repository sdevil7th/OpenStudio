import { useState } from "react";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { changedEffectSettings, detailDescription, EffectDetailIndicator } from "./EffectDetailIndicator";
import { createEffectParameterRenderer, EffectModeSwitch, EffectMeterProvider, useEffectMeterSnapshot, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import "./ChorusEditor.css";

type Detail = "voice" | "tone" | "timing";
function ChorusTiming() {
  const meters = useEffectMeterSnapshot();
  const tempo = Number.isFinite(meters?.tempoBpm) && meters!.tempoBpm! > 0 ? meters!.tempoBpm! : null;
  const rate = Number.isFinite(meters?.effectiveRateHz) && meters!.effectiveRateHz! > 0 ? meters!.effectiveRateHz! : null;
  return <span className="chorus-timing-readout text-center tabular-nums text-[10px]" role="status">{tempo === null ? "Tempo unavailable" : `${tempo.toFixed(1)} BPM`}{rate !== null && ` · ${rate.toFixed(2)} Hz`}</span>;
}
export function ChorusEditor(props: ApprovedEffectEditorProps) {
  const { schema } = props;
  const control = createEffectParameterRenderer(props);
  const value = (id: string) => findBuiltInParameter(schema, id)?.value ?? 0;
  const mode = Math.round(value("mode"));
  const sync = value("tempoSync") >= .5;
  const ensemble = value("characterMode") >= .5;
  const storedVoices = value("voices"), effectiveVoices = mode === 0 && ensemble ? Math.max(4, storedVoices) : storedVoices;
  const [detail, setDetail] = useState<Detail | null>(null);
  const modeDescriptions = ["Layered delay voices", "Short modulated delays", "Cascaded phase stages"];
  const detailState: Record<Detail, string> = {
    voice: changedEffectSettings(schema, ["characterMode", "lfoShape", "voices"]),
    tone: [ensemble ? "Ensemble high cut limited to 12 kHz" : "", changedEffectSettings(schema, ["lowCut", "highCut"])].filter(Boolean).join("; "),
    timing: [sync ? "Tempo sync active" : "", changedEffectSettings(schema, ["syncDivision", "lfoShape", ...(!sync ? ["rate"] : [])]), !sync && changedEffectSettings(schema, ["syncDivision"]) ? "Sync division retained while free running" : ""].filter(Boolean).join("; "),
  };
  const detailSummary = ([['voice', 'Voicing'], ['tone', 'Tone'], ['timing', 'Timing']] as const).filter(([id]) => detailState[id]).map(([id, label]) => detailDescription(label, detailState[id])).join(". ");

  return <EffectMeterProvider {...props}><div className="approved-effect-editor chorus-editor flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="chorus">
    <EQToolbar {...props} />
    <div className="chorus-face flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto p-6 @max-[820px]/chorus:gap-5 @max-[820px]/chorus:p-[22px] @max-[700px]/chorus:gap-[17px] @max-[700px]/chorus:px-[18px] @max-[700px]/chorus:py-[17px]">
      <header className="chorus-heading flex shrink-0 items-center justify-between gap-3 pb-[16px]">
        <div><h2>STEREO MODULATION</h2><p>Rate, depth and stereo movement.</p></div>
        <div className="chorus-mark flex items-center gap-1" aria-hidden="true"><i /><i /><i /><span>03</span></div>
      </header>
      <div className="chorus-front grid shrink-0 items-center gap-[34px]">
        <section className="chorus-modes min-w-0 p-[12px_15px_13px]" aria-label="Modulation mode">
          <EffectModeSwitch {...props} parameter={findBuiltInParameter(schema, "mode")} label="Effect mode" />
          <p>{modeDescriptions[mode]}</p>
        </section>
        <section className="chorus-primary flex min-w-0 items-start justify-around gap-2" aria-label="Primary controls">
          <div className="chorus-rate flex min-w-0 flex-col items-center gap-2">
            {control(sync ? "syncDivision" : "rate", true, sync ? "Cycle length" : "Rate")}
            {control("tempoSync", false, "Tempo sync")}
            {sync && <ChorusTiming />}
          </div>
          {control("depth", true, "Depth")}{control("mix", true, "Dry / wet")}
        </section>
      </div>
      <section className="chorus-lower flex shrink-0 items-center justify-between gap-3 pt-[18px]" aria-label="Feedback and stereo controls">
        <div className="chorus-secondary flex min-w-0 items-center gap-[32px]">
          {control("fbAmount", false, "Feedback")}
          {mode !== 2 ? control("spread", false, "Stereo spread") : <p className="chorus-note text-[11px] leading-[1.5]">Spread is retained<br />for Chorus / Flanger.</p>}
          <div className="chorus-voices grid gap-[4px_10px] pl-[20px]"><span>{mode === 2 ? "STAGE PAIRS" : "VOICES"}</span><strong>{Number(effectiveVoices.toFixed(2))}</strong>
            <button type="button" onClick={() => setDetail("voice")} aria-expanded={detail === "voice"}>Edit voicing ↗</button></div>
        </div>
        <button type="button" className="chorus-detail-button text-[12px] whitespace-nowrap p-[7px_13px]" aria-label={detail ? "Close detail −" : "Detail +"} aria-description={detailSummary || undefined} title={detailDescription("Detail", detailSummary)} aria-expanded={detail !== null} aria-controls="chorus-detail" onClick={() => setDetail(detail ? null : "voice")}>{detail ? "Close detail −" : "Detail +"}<EffectDetailIndicator summary={detailSummary} /></button>
      </section>
      {detail && <section className="chorus-detail shrink-0" id="chorus-detail" aria-label="Modulation detail">
        <div className="chorus-tabs flex p-[0_10px] gap-[3px]" role="group" aria-label="Modulation detail pages">
          {([['voice', 'Voicing'], ['tone', 'Tone'], ['timing', 'Timing']] as const).map(([id, label]) => <button key={id} type="button" aria-label={label} aria-description={detailState[id] || undefined} title={detailDescription(label, detailState[id])} aria-pressed={detail === id} onClick={() => setDetail(id)}>{label}<EffectDetailIndicator summary={detailState[id]} /></button>)}
        </div>
        <div className="chorus-detail-body flex flex-col gap-3 p-[15px_20px]">
          {detail === "voice" && <><div className="chorus-detail-controls flex flex-wrap items-center gap-6">{control("characterMode", false, "Character")}{control("lfoShape", false, "Movement shape")}{control("voices", false, mode === 2 ? "Stage pairs" : "Voices")}</div>
            <p>{mode === 2 ? "Stage pairs remain continuous for automation; six pairs correspond to twelve stages." : ensemble && mode === 0 ? `Ensemble uses at least four voices. Stored voices: ${Number(storedVoices.toFixed(2))}; effective voices: ${Number(effectiveVoices.toFixed(2))}.` : "Voices can be varied continuously. Clean and Ensemble provide different modulation character."}</p></>}
          {detail === "tone" && <><div className="chorus-detail-controls flex items-center gap-8">{control("lowCut", false, "Low cut")}{control("highCut", false, "High cut")}</div><p>{ensemble ? "Ensemble limits the effective high cut to 12 kHz. Higher stored values are retained for Clean." : "These filters shape the effected signal."}</p></>}
          {detail === "timing" && <><div className="chorus-detail-controls flex flex-wrap items-center gap-6">{control("syncDivision", false, "Synchronized cycle")}{control("lfoShape", false, "Movement shape")}{!sync && control("rate", false, "Free rate")}</div><p>Free Rate is retained when Tempo sync is enabled. Tempo and effective rate are read from the processor when available.</p></>}
        </div>
      </section>}
      <footer className="chorus-caption mt-auto flex shrink-0 flex-wrap items-center justify-between gap-2 text-[11px] pt-[5px]"><span><i aria-hidden="true" />{ensemble ? "Ensemble" : "Clean"} character{effectiveVoices !== storedVoices ? ` · ${Number(storedVoices.toFixed(2))} stored / ${Number(effectiveVoices.toFixed(2))} effective voices` : ""}</span><span>{modeDescriptions[mode]}</span></footer>
    </div>
  </div></EffectMeterProvider>;
}
