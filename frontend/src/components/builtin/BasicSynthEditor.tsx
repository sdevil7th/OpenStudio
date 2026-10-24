import { useState } from "react";
import { projectBuiltInSelectorView } from "../../utils/builtInExpandedSelectors";
import { createEffectParameterRenderer, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { InstrumentControls, InstrumentEnvelope, InstrumentFocusTabs, InstrumentHelp, InstrumentKeyboard, InstrumentPerformanceReadout, InstrumentSection, InstrumentShell, InstrumentSlider, InstrumentWaveform, instrumentValue, useInstrumentPage } from "./InstrumentEditorParts";
import { instrumentControlLocation } from "./instrumentControlLocation";
import { SynthMacroLearn } from "./SynthMacroLearn";
import { SynthMatrixGuide } from "./SynthMatrixGuide";
import "./BasicSynthEditor.css";

export function BasicSynthEditor(props: ApprovedEffectEditorProps) {
  const { tab, setTab, wide, onOverviewChange } = useInstrumentPage("Voice");
  const [route, setRoute] = useState(1), [macro, setMacro] = useState(1);
  const [voiceFocus, setVoiceFocus] = useState("Oscillators"), [modulationFocus, setModulationFocus] = useState("Matrix");
  const control = createEffectParameterRenderer(props), v = (id: string) => instrumentValue(props.schema, id);
  const macros = <div className="synth-macros mt-3 flex flex-wrap items-center gap-5 rounded-md border p-3"><div className="synth-macro-title flex flex-col gap-[5px] text-[11px]"><strong>MACROS</strong><span>Performance controls</span></div>{[1, 2, 3, 4].map(slot => <InstrumentSlider key={slot} props={props} id={`macro${slot}`} label={`Macro ${slot}`} />)}</div>;
  return <InstrumentShell props={props} kind="synth" tabs={["Voice", "Modulation", "Filter envelope", "Expression"]} tab={tab} onTab={setTab} wide={wide} onOverviewChange={onOverviewChange}
    onReveal={({ parameterId, workflowId }) => {
      const location = parameterId ? instrumentControlLocation("synth", parameterId) : null;
      if (location) { setTab(location.page); if (location.section) (location.page === "Voice" ? setVoiceFocus : setModulationFocus)(location.section); if (location.route) setRoute(location.route); if (location.macro) setMacro(location.macro); }
      else if (workflowId) { setTab(workflowId === "matrix" ? "Modulation" : "Expression"); setModulationFocus("Matrix"); }
    }}
    footer={<><InstrumentPerformanceReadout props={props} /><InstrumentKeyboard address={props.address} output={<InstrumentSlider props={props} id="outputGain" label="Output · dB" />} /></>}>
    {(tab === "Voice" || tab === "Overview") && <div className="synth-overview-voice"><InstrumentFocusTabs sections={["Oscillators", "Filter", "Amplifier"]} selected={voiceFocus} onSelect={setVoiceFocus} /><div className="synth-voice-layout grid gap-3" data-focus={voiceFocus}>
      <InstrumentSection title="Oscillators" detail="Two voices + sub / noise" className="synth-oscillators">
        {(["A", "B"] as const).map(letter => <div key={letter} className="synth-oscillator"><div className="flex items-center gap-3">{control(`oscillator${letter}Shape`)}<b className="synth-oscillator-letter flex items-center justify-center text-[18px] font-[400]">{letter}</b></div><InstrumentWaveform shape={v(`oscillator${letter}Shape`)} name={`Oscillator ${letter}`} /></div>)}
        <InstrumentControls>{control("oscillatorBlend", false, "A / B blend")}{control("detuneCents")}{control("subLevel", false, "Sub")}{control("noiseLevel", false, "Air")}</InstrumentControls>
      </InstrumentSection>
      <InstrumentSection title="Filter" detail="12 dB / octave" className="synth-filter">{control("filterMode", false, "Filter type")}
        <div className="my-4"><InstrumentControls>{control("filterCutoff", true, "Cutoff", v("filterMode") === 0)}{control("filterQ", false, "Resonance", v("filterMode") === 0)}</InstrumentControls></div>{tab !== "Overview" && <InstrumentSlider props={props} id="filterEnvelope" label="Envelope depth" disabled={v("filterMode") === 0} />}
        {v("filterMode") === 0 && <InstrumentHelp>Legacy uses Brightness in Amplifier. Select Low, High or Band pass to activate these retained filter settings.</InstrumentHelp>}
      </InstrumentSection>
      <InstrumentSection title="Amplifier" detail="ADSR" className="synth-amplifier"><InstrumentEnvelope schema={props.schema} /><InstrumentControls>{["attackMs", "decayMs", "sustain", "releaseMs"].map(id => control(id))}</InstrumentControls><div className="mt-4"><InstrumentSlider props={props} id="brightness" /></div></InstrumentSection>
    </div>{tab !== "Overview" && macros}</div>}
    {(tab === "Modulation" || tab === "Overview") && <div data-focus={modulationFocus} className="synth-modulation-page"><InstrumentFocusTabs sections={["Matrix", "LFO", "Macros"]} selected={modulationFocus} onSelect={setModulationFocus} /><div className="synth-modulation-layout grid gap-3">
      <InstrumentSection title="Modulation matrix" detail="8 routes · 28 destinations" className="synth-matrix" feature="matrix"><div className="synth-route-heading grid gap-2 text-xs" aria-hidden="true"><span>#</span><span>Source</span><span>Destination</span><span>Amount</span></div><div className="synth-route-table">{Array.from({ length: 8 }, (_, index) => index + 1).map(slot => <div key={slot} className="synth-route-row grid items-center gap-2 py-1"><button type="button" className="synth-route-number text-[12px]" aria-label={`Select route ${slot}`} aria-pressed={slot === route} onClick={() => setRoute(slot)}>{String(slot).padStart(2, "0")}</button>{control(`matrix${slot}Source`, false, `Route ${slot} source`)}{control(`matrix${slot}Target`, false, `Route ${slot} destination`)}<InstrumentSlider props={props} id={`matrix${slot}Amount`} label={`Route ${slot} amount`} /></div>)}</div>
        <details className="mt-3 text-xs"><summary className="cursor-pointer py-2">Route ranges and applicability</summary><SynthMatrixGuide schema={projectBuiltInSelectorView(props.schema)} selected={route} onSelect={setRoute} /></details>
      </InstrumentSection>
      <InstrumentSection title="LFO" className="synth-lfo">{control("lfoMode", false, "Trigger")}{control("lfoShape", false, "Shape")}<InstrumentWaveform shape={[3, 2, 0, 1][v("lfoShape")] ?? 3} name="LFO" /><div className="my-4"><InstrumentControls>{control("lfoRate", false, "Rate")}{control("lfoDepth", false, "Direct depth")}</InstrumentControls></div>{control("lfoDestination", false, "Direct destination")}<InstrumentHelp>Matrix routes use their own amount. Shared free run is independent of transport.</InstrumentHelp></InstrumentSection>
    </div>{macros}</div>}
    {(tab === "Filter envelope" || tab === "Overview") && <div className="synth-two-columns grid gap-[14px]"><InstrumentSection title="Filter envelope" detail="Independent shaping">{control("filterEnvelopeSource")}<InstrumentEnvelope schema={props.schema} filter /><InstrumentControls>{["filterAttackMs", "filterDecayMs", "filterSustain", "filterReleaseMs"].map(id => control(id))}</InstrumentControls></InstrumentSection><InstrumentSection title="Envelope response"><InstrumentControls>{control("filterEnvelope")}{control("filterVelocity")}{control("filterKeyTrack")}</InstrumentControls><InstrumentHelp>The independent ADSR and velocity depth apply to new notes. Choose an active filter and a nonzero depth to hear filter-envelope modulation. Amplitude release still ends the voice.</InstrumentHelp></InstrumentSection></div>}
    {(tab === "Expression" || tab === "Overview") && <div className="synth-two-columns grid gap-[14px]"><InstrumentSection title="MPE expression" detail="Zone configuration" feature="mpe">{control("mpeEnabled")}
      <div className="synth-zone mt-4 pt-[12px]"><h4>Lower zone · master channel 1</h4><InstrumentControls>{control("mpeLowerMembers")}{control("mpeLowerBend")}{control("mpeLowerMasterBend")}</InstrumentControls></div>
      <div className="synth-zone mt-4 pt-[12px]"><h4>Upper zone · master channel 16</h4><InstrumentControls>{control("mpeUpperMembers")}{control("mpeUpperBend")}{control("mpeUpperMasterBend")}</InstrumentControls></div>
      <InstrumentHelp>Zones extend inward without overlap. Editing zones stops current voices. Keep the track MIDI channel on All to preserve per-note expression.</InstrumentHelp>
    </InstrumentSection><InstrumentSection title="Macro controller assignments" feature="macro-learn"><SynthMacroLearn {...props} slot={macro} onSlotChange={setMacro} /><div className="my-4 flex flex-wrap gap-4">{control(`macro${macro}CC`)}{control(`macro${macro}Channel`)}</div>{control("wheelMode", false, "Mod wheel behavior")}<InstrumentHelp>Use each macro as a source in the matrix. MIDI values override its saved base value until a manual edit or controller reset.</InstrumentHelp></InstrumentSection></div>}
  </InstrumentShell>;
}
