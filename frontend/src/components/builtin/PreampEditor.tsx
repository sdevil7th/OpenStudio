import { useState } from "react";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { EQToolbar } from "./EQToolbar";
import { changedEffectSettings, detailDescription, EffectDetailIndicator } from "./EffectDetailIndicator";
import { createEffectParameterRenderer, EffectMeterProvider, useEffectMeterSnapshot, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { EffectStat, LiveSignalLevelPanel } from "./CoreEffectVisuals";
import "./CoreEffectEditors.css";
import "./PreampEditor.css";

function OutputPeak() { return <EffectStat label="OUTPUT" value={useEffectMeterSnapshot()?.outputLevelDb} />; }
export function PreampEditor(props: ApprovedEffectEditorProps) {
  const p = (id: string) => findBuiltInParameter(props.schema, id);
  const value = (id: string) => p(id)?.value ?? 0;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const change: ApprovedEffectEditorProps["onChange"] = (parameter, next) => {
    if (parameter.id !== "audioCharacter") { props.onChange(parameter, next); return; }
    if (busy) return;
    setBusy(true); setError("");
    void props.onApplyValues({ audioCharacter: next }).then(ok => { if (!ok) setError("The processor did not accept the audio-stage change."); })
      .catch(() => setError("Could not change the preamp audio stages.")).finally(() => setBusy(false));
  };
  const control = createEffectParameterRenderer({ ...props, onChange: change }), tone = value("toneEnabled") >= .5;
  const audioStageState = [value("audioCharacter") >= .5 ? "Original input and output stages active" : changedEffectSettings(props.schema, ["headroom", "outputDrive"]) ? "Drive and Headroom retained while Legacy is active" : "", changedEffectSettings(props.schema, ["audioCharacter", "headroom", "outputDrive"])].filter(Boolean).join("; ");
  return <EffectMeterProvider {...props}><div className="approved-effect-editor core-effect-editor preamp-approved flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="preamp">
    <EQToolbar {...props} />
    <div className="core-effect-face flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px_24px] gap-[15px]" inert={busy}>
      {error && <p role="alert" className="core-effect-error text-[12px]">{error}</p>}
      <header className="preamp-heading flex shrink-0 flex-wrap items-center justify-between gap-3"><span className="core-panel-label text-[10px] tracking-[1.5px]">ORIGINAL PREAMP COLOUR</span>{control("toneEnabled", false, "Tone circuit")}<span className="preamp-route">LINE → DRIVE → TONE → OUTPUT</span></header>
      <div className="preamp-main flex shrink-0 items-center justify-around gap-6">
        <div className="preamp-gain core-main-controls flex shrink-0 flex-col items-center p-[8px_12px] gap-[18px]">{control("drive", true, "Input drive")}{control("saturationReference", false, "Reference")}<p className="core-detail-note text-center text-[12px] leading-[1.6]">Reference sets the<br />saturation operating point.</p></div>
        <section className="preamp-tone flex min-w-0 flex-1 justify-center" aria-label="Three-band tone section" data-active={tone}>
          {tone ? <><div className="preamp-tone-strip flex min-w-0 flex-1 flex-col items-center"><h3>LOW SHELF</h3>{value("toneLowFrequency") > 0 ? control("toneLowGain", false, "Low gain") : <span className="preamp-band-off">Shelf off</span>}{control("toneLowFrequency", false, "Low corner")}</div>
            <div className="preamp-tone-strip flex min-w-0 flex-1 flex-col items-center"><h3>MID BELL</h3>{value("toneMidFrequency") > 0 ? control("toneMidGain", false, "Mid gain") : <span className="preamp-band-off">Bell off</span>}{control("toneMidFrequency", false, "Mid frequency")}</div>
            <div className="preamp-tone-strip flex min-w-0 flex-1 flex-col items-center"><h3>HIGH SHELF</h3>{control("toneHighGain", false, "High gain")}<span className="preamp-fixed-frequency">12 kHz <small>fixed</small></span></div></>
            : <div className="preamp-tone-off flex flex-col items-center justify-center gap-3"><h3>TONE CIRCUIT OFF</h3><p>Enable Tone circuit to shape the three bands.<br />Your tone settings are retained.</p></div>}
        </section>
        <div className="preamp-output core-main-controls flex shrink-0 flex-col items-center p-[8px_12px] gap-[18px]">{control("outputGain", true, "Output")}<OutputPeak /></div>
      </div>
      <div className="preamp-analysis flex min-h-44 shrink-0 gap-5"><LiveSignalLevelPanel reference={value("saturationReference")} /><div className="preamp-character flex flex-wrap items-center justify-center gap-5">{control("colour", false, "Colour")}{tone && control("toneHighPass", false, "High pass")}<p className="core-detail-note text-[12px] leading-[1.6]">Original digital colour<br />and stepped tone filters.</p></div></div>
      {p("audioCharacter") && <details className="core-detail core-advanced shrink-0"><summary aria-description={audioStageState || undefined} title={detailDescription("Audio stages", audioStageState)}>Audio stages<EffectDetailIndicator summary={audioStageState} /></summary><div className="core-detail-content flex flex-wrap items-center p-[14px_18px] gap-[20px]">
        {control("audioCharacter", false, "Audio character")}{value("audioCharacter") >= .5 && <>{control("headroom", false, "Headroom")}{control("outputDrive", false, "Output drive")}</>}
        <p className="core-detail-note text-[12px] leading-[1.6]">{value("audioCharacter") >= .5 ? "Original digital input and output stages. Positive Headroom reduces colour; Output trim follows the output amplifier." : "Legacy preserves the saved response. Original stages are optional; Headroom and Output drive settings are retained."}</p>
      </div></details>}
    </div>
  </div></EffectMeterProvider>;
}
