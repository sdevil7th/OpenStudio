import { useState } from "react";
import { projectBuiltInSelectorView } from "../../utils/builtInExpandedSelectors";
import { createEffectParameterRenderer, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { InstrumentControls, InstrumentEnvelope, InstrumentHelp, InstrumentKeyboard, InstrumentPerformanceReadout, InstrumentSection, InstrumentShell, InstrumentSlider, InstrumentWaveform, instrumentValue } from "./InstrumentEditorParts";
import { SynthMacroLearn } from "./SynthMacroLearn";
import { SynthMatrixGuide } from "./SynthMatrixGuide";
import "./BasicSynthEditor.css";

export function BasicSynthEditor(props: ApprovedEffectEditorProps) {
  const [tab, setTab] = useState("Voice"), [route, setRoute] = useState(1), [macro, setMacro] = useState(1);
  const control = createEffectParameterRenderer(props), v = (id: string) => instrumentValue(props.schema, id);
  const macros = <div className="synth-macros mt-3 flex flex-wrap items-center gap-5 rounded-md border p-3"><div className="synth-macro-title flex flex-col gap-[5px] text-[11px]"><strong>MACROS</strong><span>Performance controls</span></div>{[1, 2, 3, 4].map(slot => <InstrumentSlider key={slot} props={props} id={`macro${slot}`} label={`Macro ${slot}`} />)}</div>;
  return <InstrumentShell props={props} kind="synth" tabs={["Voice", "Modulation", "Filter envelope", "Expression"]} tab={tab} onTab={setTab}
    footer={<><InstrumentPerformanceReadout props={props} /><InstrumentKeyboard address={props.address} output={<InstrumentSlider props={props} id="outputGain" label="Output · dB" />} /></>}>
    {tab === "Voice" && <><div className="synth-voice-layout grid gap-[12px]">
      <InstrumentSection title="01 / Oscillators" detail="Two oscillators + sub / noise">
        {(["A", "B"] as const).map(letter => <div key={letter} className="synth-oscillator"><div className="flex items-center gap-3">{control(`oscillator${letter}Shape`)}<b className="synth-oscillator-letter flex items-center justify-center text-[18px] font-[400]">{letter}</b></div><InstrumentWaveform shape={v(`oscillator${letter}Shape`)} name={`Oscillator ${letter}`} /></div>)}
        <InstrumentControls>{control("oscillatorBlend", false, "A / B blend")}{control("detuneCents")}{control("subLevel", false, "Sub")}{control("noiseLevel", false, "Air")}</InstrumentControls>
      </InstrumentSection>
      <InstrumentSection title="02 / Filter" detail="Shape">{control("filterMode", false, "Filter type")}
        <div className="synth-filter-identity my-5 flex items-center justify-center gap-2"><strong>{v("filterMode") === 0 ? "LEGACY" : "12"}</strong><span>{v("filterMode") === 0 ? "Brightness filter" : "dB / octave"}</span></div>
        {v("filterMode") > 0 ? <><InstrumentControls>{control("filterCutoff", true, "Cutoff")}{control("filterQ", false, "Resonance")}</InstrumentControls><div className="mt-4"><InstrumentSlider props={props} id="filterEnvelope" label="Envelope depth" /></div></> : <InstrumentHelp>Brightness shapes the legacy voice. Choose Low, High or Band pass to use cutoff, resonance and their modulation routes.</InstrumentHelp>}
      </InstrumentSection>
      <InstrumentSection title="03 / Amplifier" detail="ADSR"><InstrumentEnvelope schema={props.schema} /><InstrumentControls>{["attackMs", "decayMs", "sustain", "releaseMs"].map(id => control(id))}</InstrumentControls><div className="mt-4"><InstrumentSlider props={props} id="brightness" /></div></InstrumentSection>
    </div>{macros}</>}
    {tab === "Modulation" && <><div className="synth-modulation-layout grid gap-[12px]">
      <InstrumentSection title="Modulation matrix" detail="8 routes · 28 destinations"><div className="synth-route-table">{Array.from({ length: 8 }, (_, index) => index + 1).map(slot => <div key={slot} className="synth-route-row grid gap-[8px] items-center p-[8px_0]"><button type="button" className="synth-route-number text-[12px]" aria-label={`Select route ${slot}`} aria-pressed={slot === route} onClick={() => setRoute(slot)}>{String(slot).padStart(2, "0")}</button>{control(`matrix${slot}Source`, false, `Route ${slot} source`)}{control(`matrix${slot}Target`, false, `Route ${slot} destination`)}<InstrumentSlider props={props} id={`matrix${slot}Amount`} label={`Route ${slot} amount`} /></div>)}</div>
        <details className="mt-3 text-xs"><summary className="cursor-pointer py-2">Route ranges and applicability</summary><SynthMatrixGuide schema={projectBuiltInSelectorView(props.schema)} selected={route} onSelect={setRoute} /></details>
      </InstrumentSection>
      <InstrumentSection title="LFO">{control("lfoMode", false, "Trigger")}{control("lfoShape", false, "Shape")}<InstrumentWaveform shape={[3, 2, 0, 1][v("lfoShape")] ?? 3} name="LFO" /><div className="my-4"><InstrumentControls>{control("lfoRate", false, "Rate")}{control("lfoDepth", false, "Direct depth")}</InstrumentControls></div>{control("lfoDestination", false, "Direct destination")}<InstrumentHelp>Matrix routes use their own amount. Shared free run is independent of transport.</InstrumentHelp></InstrumentSection>
    </div>{macros}</>}
    {tab === "Filter envelope" && <div className="synth-two-columns grid gap-[14px]"><InstrumentSection title="Filter envelope" detail="Independent shaping">{control("filterEnvelopeSource")}<InstrumentEnvelope schema={props.schema} filter /><InstrumentControls>{["filterAttackMs", "filterDecayMs", "filterSustain", "filterReleaseMs"].map(id => control(id))}</InstrumentControls></InstrumentSection><InstrumentSection title="Envelope response"><InstrumentControls>{control("filterEnvelope")}{control("filterVelocity")}{control("filterKeyTrack")}</InstrumentControls><InstrumentHelp>The independent ADSR and velocity depth apply to new notes. Choose an active filter and a nonzero depth to hear filter-envelope modulation. Amplitude release still ends the voice.</InstrumentHelp></InstrumentSection></div>}
    {tab === "Expression" && <div className="synth-two-columns grid gap-[14px]"><InstrumentSection title="MPE expression" detail="Zone configuration">{control("mpeEnabled")}
      <div className="synth-zone mt-4 pt-[12px]"><h4>Lower zone · master channel 1</h4><InstrumentControls>{control("mpeLowerMembers")}{control("mpeLowerBend")}{control("mpeLowerMasterBend")}</InstrumentControls></div>
      <div className="synth-zone mt-4 pt-[12px]"><h4>Upper zone · master channel 16</h4><InstrumentControls>{control("mpeUpperMembers")}{control("mpeUpperBend")}{control("mpeUpperMasterBend")}</InstrumentControls></div>
      <InstrumentHelp>Zones extend inward without overlap. Editing zones stops current voices. Keep the track MIDI channel on All to preserve per-note expression.</InstrumentHelp>
    </InstrumentSection><InstrumentSection title="Macro controller assignments"><SynthMacroLearn {...props} slot={macro} onSlotChange={setMacro} /><div className="my-4 flex flex-wrap gap-4">{control(`macro${macro}CC`)}{control(`macro${macro}Channel`)}</div>{control("wheelMode", false, "Mod wheel behavior")}<InstrumentHelp>Use each macro as a source in the matrix. MIDI values override its saved base value until a manual edit or controller reset.</InstrumentHelp></InstrumentSection></div>}
  </InstrumentShell>;
}
