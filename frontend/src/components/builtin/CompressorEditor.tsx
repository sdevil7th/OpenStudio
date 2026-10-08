import { useState } from "react";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { changedEffectSettings, detailDescription, EffectDetailIndicator } from "./EffectDetailIndicator";
import { createEffectParameterRenderer, EffectModeSwitch, EffectRange, EffectMeterProvider, useEffectMeterSnapshot, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { LiveDynamicsHistory, EffectStat } from "./CoreEffectVisuals";
import "./CoreEffectEditors.css";
import "./CompressorEditor.css";

type Detail = "Tone & timing" | "Sidechain" | "Metering" | "Noise & monitor";
function CalibratedMeter({ mode, channel, reference }: { mode: number; channel: number; reference: number }) {
  const meters = useEffectMeterSnapshot();
  const levels = mode === 1 ? meters?.inputAverageDb : meters?.outputAverageDb;
  const average = levels?.length === 2 ? channel === 0 ? Math.max(...levels) : levels[channel - 1] : undefined;
  const value = mode === 0 ? meters?.gainReductionDb === undefined ? undefined : Math.abs(meters.gainReductionDb) : average === undefined ? undefined : average - reference;
  return <EffectStat label={mode === 0 ? "GAIN REDUCTION" : `${mode === 1 ? "INPUT" : "OUTPUT"} · RELATIVE TO ${reference} dBFS`} value={value} unit="dB" />;
}
export function CompressorEditor(props: ApprovedEffectEditorProps) {
  const p = (id: string) => findBuiltInParameter(props.schema, id);
  const v = (id: string) => p(id)?.value ?? 0;
  const model = Math.round(v("model"));
  const prefix = ["", "", "fet", "tubeOpto", "solidOpto", "busVca", "punchVca"][model] ?? "";
  const currentEngine = model >= 2 && v(`${prefix}Engine`) >= .5;
  const fet = model === 2 && currentEngine, optical = [3, 4].includes(model) && currentEngine;
  const vca = [5, 6].includes(model) && currentEngine;
  const [channel, setChannel] = useState(0);
  const routing = v(`${prefix}Routing`), bank = `${prefix}${routing === 0 ? 0 : channel}`;
  const ratioOff = fet && v("fetRatio") === 5;
  const [detail, setDetail] = useState<Detail>("Tone & timing");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const change: ApprovedEffectEditorProps["onChange"] = (parameter, next) => {
    if (!["model", "audioCharacter"].includes(parameter.id)) { props.onChange(parameter, next); return; }
    if (busy) return;
    setBusy(true); setError("");
    void props.onApplyValues({ [parameter.id]: next }).then(ok => { if (!ok) setError("The processor did not accept the configuration change."); })
      .catch(() => setError("Could not change compressor configuration.")).finally(() => setBusy(false));
  };
  const control = createEffectParameterRenderer({ ...props, onChange: change });
  const tabs: Detail[] = ["Tone & timing", "Sidechain", "Metering", ...(model === 6 && currentEngine ? ["Noise & monitor" as const] : [])];
  const shownDetail = tabs.includes(detail) ? detail : "Tone & timing";
  const ratio = p("fetRatio");
  const activeBanks = routing === 0 ? [`${prefix}0`] : [`${prefix}0`, `${prefix}1`];
  const toneIds = fet ? ["fetRecovery", "fetTilt"] : optical ? [] : vca ? model === 5 ? activeBanks.flatMap(id => [`${id}Attack`, `${id}Release`, `${id}AutoRelease`]) : [] : ["knee", "autoRelease", "autoMakeup"];
  const keyIds = vca ? activeBanks.map(id => `${id}HighPass`) : optical ? ["stereoLink"] : ["sidechainHPF", "stereoLink", ...(!fet ? ["detectorMode"] : [])];
  const detailState: Record<Detail, string> = {
    "Tone & timing": [ratioOff && changedEffectSettings(props.schema, toneIds) ? "Stored while compression is off" : "", changedEffectSettings(props.schema, toneIds)].filter(Boolean).join("; "),
    "Sidechain": [v("externalDetector") >= .5 ? "External key selected" : "", changedEffectSettings(props.schema, ["externalDetector", ...keyIds, "lookaheadMs"])].filter(Boolean).join("; "),
    "Metering": changedEffectSettings(props.schema, ["meterMode", "meterChannel", "meterReference"]),
    "Noise & monitor": changedEffectSettings(props.schema, ["punchNoiseLeft", ...(routing !== 0 ? ["punchNoiseRight"] : []), "punchHum", "punchMonitor"]),
  };
  const audioStageState = [v("audioCharacter") >= .5 ? model >= 2 ? "Original stages active" : "Linear path; colour inactive for this model" : changedEffectSettings(props.schema, ["headroom"]) ? "Headroom retained while Legacy is active" : "", changedEffectSettings(props.schema, ["audioCharacter", "headroom"])].filter(Boolean).join("; ");

  return <EffectMeterProvider {...props}><div className="approved-effect-editor core-effect-editor compressor-approved flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="compressor">
    <EQToolbar {...props} />
    <div className="core-effect-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px_24px] gap-[15px]" inert={busy}>
      <div className="compressor-models shrink-0"><EffectModeSwitch {...props} onChange={change} parameter={p("model")} label="Compressor model" /></div>
      {error && <p role="alert" className="core-effect-error text-[12px]">{error}</p>}
      <div className="core-effect-topline flex shrink-0 flex-wrap items-center justify-between gap-[16px]">
        {model >= 2 ? control(`${prefix}Engine`, false, "Response engine") : model === 0 ? control("style", false, "Legacy style") : <span className="core-panel-label text-[10px] tracking-[1.5px]">CLEAN RESPONSE</span>}
        {vca && <>{control(`${prefix}Routing`, false, "Channel routing")}{routing !== 0 ? <label className="flex flex-col gap-2 text-xs">Edit channel<select className="suite-select" aria-label="Edit channel" value={channel} onChange={e => setChannel(Number(e.currentTarget.value))}>{(routing === 2 ? ["Mid", "Side"] : ["Left", "Right"]).map((name, index) => <option value={index} key={index}>{name}</option>)}</select></label> : <span className="core-detail-note text-[12px] leading-[1.6]">Both channels linked</span>}</>}
        <EffectRange {...props} parameter={p("mix")} label="Parallel mix" />
      </div>
      <div className="compressor-meter-row flex min-h-36 shrink-0 gap-4"><LiveDynamicsHistory /></div>
      <div className="core-main-controls compressor-main flex shrink-0 items-center justify-around p-[8px_12px] gap-[18px]" aria-label="Compressor primary controls">
        {fet ? <>{control("fetInput", true, "Input")}<div className="compressor-ratio flex flex-col items-center gap-3">{control("fetRatio", false, "Ratio / button combination")}{ratioOff && <span className="core-detail-note text-[12px] leading-[1.6]">Compression off</span>}</div>{ratioOff ? <p className="core-detail-note text-[12px] leading-[1.6]">Input and output remain active.<br />Compression timing is inactive.</p> : <>{control("fetAttack", false, "Attack")}{control("fetRelease", false, "Release")}</>}{control("fetOutput", true, "Output")}</>
          : optical ? <>{control(`${prefix}Reduction`, true, "Peak reduction")}<div className="compressor-opto flex flex-col items-center gap-3">{control(`${prefix}Mode`, false, "Operation")}<p className="core-detail-note text-[12px] leading-[1.6]">Program-dependent recovery<br />with optical memory</p></div>{control(`${prefix}Emphasis`, false, "HF emphasis")}{control(`${prefix}Gain`, true, "Makeup gain")}</>
          : vca ? <>{control(`${bank}Input`, false, "Input")}{control(`${bank}Threshold`, true, "Threshold")}<div className="compressor-ratio flex flex-col items-center gap-3">{v(`${bank}Infinity`) >= .5 ? <span className="text-lg">Ratio ∞:1</span> : control(`${bank}Ratio`, false, "Ratio")}{control(`${bank}Infinity`, false, "Infinity ratio")}</div>{control(`${bank}Output`, true, "Output")}</>
          : <>{control("threshold", true, "Threshold")}{control("ratio", false, "Ratio")}{control("attack", false, "Attack")}{control("release", false, "Release")}{control("makeupGain", true, "Makeup")}</>}
      </div>
      <section className="core-detail shrink-0" aria-label="Compressor detail">
        <div className="core-detail-tabs flex flex-wrap p-[0_8px] gap-[3px]" role="group" aria-label="Compressor detail pages">{tabs.map(tab => <button type="button" key={tab} aria-label={tab} aria-description={detailState[tab] || undefined} title={detailDescription(tab, detailState[tab])} aria-pressed={shownDetail === tab} onClick={() => setDetail(tab)}>{tab}<EffectDetailIndicator summary={detailState[tab]} /></button>)}</div>
        <div className="core-detail-content flex flex-wrap items-center justify-start p-[14px_18px] gap-[20px]">
          {shownDetail === "Sidechain" ? <>{control("externalDetector", false, "Key source")}{ratioOff ? <p className="core-detail-note text-[12px] leading-[1.6]">The detector does not reduce gain while Ratio is Off.</p> : vca ? <>{control(`${bank}HighPass`, false, "Key high pass · 90 Hz")}{control("lookaheadMs", false, "Lookahead")}</> : <>{!optical && <>{!fet && control("detectorMode", false, "Detection")}{control("sidechainHPF", false, "Key high pass")}</>}{control("lookaheadMs", false, "Lookahead")}{control("stereoLink", false, "Stereo link")}</>}</>
            : shownDetail === "Metering" ? <>{control("meterMode", false, "Display")}{control("meterChannel", false, "Meter channel")}{control("meterReference", false, "Calibration")}<CalibratedMeter mode={v("meterMode")} channel={v("meterChannel")} reference={v("meterReference")} /><p className="core-detail-note text-[12px] leading-[1.6]">300 ms average · the main output history shows peaks.</p></>
            : shownDetail === "Noise & monitor" ? <>{control("punchNoiseLeft", false, routing === 2 ? "Noise · Mid" : "Noise · Left")}{routing !== 0 ? control("punchNoiseRight", false, routing === 2 ? "Noise · Side" : "Noise · Right") : <p className="core-detail-note text-[12px] leading-[1.6]">Noise linked to both channels</p>}{control("punchHum", false, "Hum frequency")}{control("punchMonitor", false, "Listen")}</>
            : fet ? ratioOff ? <p className="core-detail-note text-[12px] leading-[1.6]">Choose a compression ratio to edit recovery and detector tilt.</p> : <>{control("fetRecovery", false, "Recovery memory")}{control("fetTilt", false, "Detector tilt")}<p className="core-detail-note text-[12px] leading-[1.6]">{ratio?.enumOptions?.length ?? 0} single and multi-button ratio choices<br />are available in the Ratio menu.</p></>
            : optical ? <p className="core-detail-note text-[12px] leading-[1.6]">Recovery follows the selected optical response. Peak reduction and HF emphasis shape its action.</p>
            : vca ? model === 5 ? <>{control(`${bank}Attack`, false, "Attack")}{v(`${bank}AutoRelease`) < .5 && control(`${bank}Release`, false, "Release")}{control(`${bank}AutoRelease`, false, "Auto release")}<p className="core-detail-note text-[12px] leading-[1.6]">{routing === 0 ? "Linked timing" : `Editing ${routing === 2 ? channel ? "Side" : "Mid" : channel ? "Right" : "Left"}`}</p></> : <p className="core-detail-note text-[12px] leading-[1.6]">Punch VCA uses program-dependent timing. Input, Threshold and Ratio shape its response.</p>
            : <>{control("knee", false, "Knee")}{control("autoRelease", false, "Auto release")}{control("autoMakeup", false, "Estimated makeup")}</>}
        </div>
      </section>
      {p("audioCharacter") && <details className="core-detail core-advanced shrink-0"><summary aria-description={audioStageState || undefined} title={detailDescription("Audio stages", audioStageState)}>Audio stages<EffectDetailIndicator summary={audioStageState} /></summary>
        <div className="core-detail-content flex flex-wrap items-center p-[14px_18px] gap-[20px]">{control("audioCharacter", false, "Audio character")}{v("audioCharacter") >= .5 && model >= 2 && control("headroom", false, "Headroom")}
          <p className="core-detail-note text-[12px] leading-[1.6]">{v("audioCharacter") < .5 ? "Legacy preserves the saved response. Original stages are optional; your Headroom setting is retained." : model < 2 ? "Clean and Legacy stay linear. Original stages add colour in the FET, optical and VCA models; Headroom is retained." : "Original digital stages add level-dependent colour. Positive Headroom reduces gain reduction and colour."}</p>
        </div>
      </details>}
    </div>
  </div></EffectMeterProvider>;
}
