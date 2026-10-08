import { editorButton } from "./PluginEditorControls";
import { useState } from "react";
import { createEffectParameterRenderer, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { InstrumentControls, InstrumentHelp, InstrumentPerformanceReadout, InstrumentSection, InstrumentShell, InstrumentSlider, instrumentValue, useInstrumentPerformance, useInstrumentPreview } from "./InstrumentEditorParts";
import { displayedDrumNotes, drumPadFromSchema, drumPieceNames } from "./instrumentDrumPads";
import { DrumMapEditor } from "./DrumMapEditor";
import { DrumMappingGuide } from "./DrumMappingGuide";
import "./DrumsEditor.css";

function DrumPads({ props, selectedInput, onSelect }: { props: ApprovedEffectEditorProps; selectedInput: number | null; onSelect: (note: number) => void }) {
  const preview = useInstrumentPreview(props.address), meters = useInstrumentPerformance();
  const inputKeys = meters?.instrumentPerformance?.notes ?? [];
  return <><div className="drums-pad-grid grid gap-[9px]" role="group" aria-label="Sixteen drum input pads">{displayedDrumNotes.map((note, index) => {
    const mapping = drumPadFromSchema(props.schema, note);
    const start = () => { onSelect(note); if (mapping.available && !mapping.ignored) preview.start(note); };
    const output = mapping.piece === null ? "" : props.schema.parameters.find(parameter => parameter.id === `pieceOutput${mapping.piece}`);
    const outputName = output && output.enumOptions?.find(option => option.value === output.value)?.label;
    return <button key={note} type="button" className="drums-pad flex flex-col justify-end items-start p-[10px] text-left" data-piece={mapping.piece ?? "none"} data-ignored={mapping.ignored}
      data-audition={preview.pressed.has(note)} data-input-held={inputKeys.some(item => item.note === note && item.held)} aria-pressed={selectedInput === note}
      aria-label={`${mapping.ignored ? "Select ignored input" : "Audition"} ${mapping.label}, MIDI input ${note}${mapping.voiceNote !== null ? `, voice ${mapping.voiceNote}` : ""}`}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); start(); }}
      onPointerUp={() => preview.stop(note)} onPointerCancel={() => preview.stop(note)} onLostPointerCapture={() => preview.stop(note)} onBlur={() => preview.stop(note)}
      onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); if (!event.repeat) start(); } }}
      onKeyUp={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); preview.stop(note); } }}>
      <span className="drums-pad-index flex items-center justify-between">{String(index + 1).padStart(2, "0")}<i aria-hidden="true" title="Incoming MIDI key held" /></span>
      <strong>{mapping.label}</strong><span className="drums-pad-note">IN {note}{mapping.voiceNote !== null && mapping.voiceNote !== note ? ` → ${mapping.voiceNote}` : ""}</span><small>{mapping.ignored ? "Silent input" : outputName || ""}</small>
    </button>;
  })}</div><span className="mt-2 block min-h-4 text-xs text-daw-text-muted" role="status">{preview.error}</span></>;
}

export function DrumsEditor(props: ApprovedEffectEditorProps) {
  const [tab, setTab] = useState("Kit"), [selectedInput, setSelectedInput] = useState<number | null>(36), [pieceOverride, setPieceOverride] = useState(0), [mapOpen, setMapOpen] = useState(false);
  const control = createEffectParameterRenderer(props);
  const selected = selectedInput === null ? null : drumPadFromSchema(props.schema, selectedInput);
  const piece = selected ? selected.piece : pieceOverride;
  const choosePiece = (value: number) => { setSelectedInput(null); setPieceOverride(value); };
  return <InstrumentShell props={props} kind="drums" tabs={["Kit", "Mapping", "Outputs"]} tab={tab} onTab={setTab}
    footer={<><div className="drums-master-strip flex shrink-0 flex-wrap items-center gap-5 px-4 py-3"><InstrumentSlider props={props} id="outputGain" label="Master output · dB" /><InstrumentSlider props={props} id="stereoWidth" label="Stereo width" /><span>16 input pads · 8 mixer groups</span></div><InstrumentPerformanceReadout props={props} /></>}>
    {mapOpen && <DrumMapEditor schema={props.schema} address={props.address} onApply={props.onApplyValues} onClose={() => setMapOpen(false)} />}
    <div className="drums-topbar mb-4 flex flex-wrap items-end gap-4">{control("kit", false, "Kit voice")}{control("articulationEngine", false, "Voice engine")}{control("mapPreset", false, "MIDI mapping")}<button className={editorButton} type="button" onClick={() => setMapOpen(true)}>Edit all 128 notes</button></div>
    {tab === "Kit" && <div className="drums-kit-layout grid gap-[14px]"><InstrumentSection title="Performance pads" detail="Effective input mapping"><DrumPads props={props} selectedInput={selectedInput} onSelect={setSelectedInput} /><InstrumentHelp>Pad labels follow the current map. The small light reports held incoming MIDI keys; pressing a pad auditions its input note.</InstrumentHelp></InstrumentSection>
      <InstrumentSection title={piece === null ? selected?.label ?? "Select a piece" : drumPieceNames[piece]} detail={selectedInput === null ? "Mixer group" : `Input ${selectedInput}`}>
        <label className="mb-4 flex flex-col gap-2 text-xs">Piece inspector<select className="suite-select" aria-label="Drum piece" value={piece ?? ""} onChange={event => choosePiece(Number(event.target.value))}>{piece === null && <option value="">No voice selected</option>}{drumPieceNames.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>
        {piece === null ? <InstrumentHelp>{selected?.ignored ? `MIDI ${selectedInput} is ignored and selects no mixer group. Change its mapping to assign a voice.` : "Choose a mapped pad or a mixer group."}</InstrumentHelp> : <><InstrumentControls>{control(`pieceGain${piece}`, false, "Level")}{control(`pieceTuning${piece}`, false, "Tune")}{control(`piecePan${piece}`, false, "Pan")}{control(`pieceDecay${piece}`, false, "Decay")}</InstrumentControls><div className="mt-4">{control(`pieceOutput${piece}`, false, "Output")}</div><DrumMappingGuide schema={props.schema} piece={piece} /></>}
      </InstrumentSection>
      <InstrumentSection title="Kit character" className="drums-character"><InstrumentControls>{["tuning", "punch", "ambience", "hihatTightness", "velocityCurve"].map(id => control(id))}</InstrumentControls></InstrumentSection>
    </div>}
    {tab === "Mapping" && <div className="drums-mapping-layout grid gap-[14px]"><InstrumentSection title="MIDI input map" detail="All 128 notes"><InstrumentHelp>Map an incoming note to another voice or Ignore. MIDI Learn captures the incoming key, then Apply saves the complete edit as one Undo step.</InstrumentHelp><button className={`${editorButton} my-4`} type="button" onClick={() => setMapOpen(true)}>Open mapping editor</button>{control("customMapEnabled", false, "Custom map")}<div className="drums-mapping-table mt-4" role="table" aria-label="Effective MIDI mapping">{props.schema.drumMapping?.map(row => { const mapping = drumPadFromSchema(props.schema, row.inputNote); return <div role="row" key={row.inputNote}><span role="cell">{row.inputNote}</span><span role="cell">{mapping.voiceNote ?? "—"}</span><span role="cell">{mapping.label}</span><span role="cell">{mapping.piece === null ? "—" : drumPieceNames[mapping.piece]}</span></div>; })}</div></InstrumentSection><InstrumentSection title="Playing response"><InstrumentControls>{control("velocityCurve")}{control("hihatTightness")}</InstrumentControls><InstrumentHelp>{instrumentValue(props.schema, "articulationEngine") >= .5 ? "Articulated voices share eight mixer groups. Closed and pedal hats choke open hats on the same channel." : "Choose Articulated to enable additional drum hits."}</InstrumentHelp><InstrumentHelp>Incoming input notes remain distinct from the effective voices. Ignored inputs are silent.</InstrumentHelp></InstrumentSection></div>}
    {tab === "Outputs" && <InstrumentSection title="Piece mixer" detail="Exclusive outputs"><div className="drums-piece-mixer grid gap-[14px]">{drumPieceNames.map((name, index) => <section key={name} aria-label={`${name} mixer`}><h4>{name}</h4><InstrumentControls>{control(`pieceGain${index}`, false, "Level")}{control(`piecePan${index}`, false, "Pan")}</InstrumentControls>{control(`pieceOutput${index}`, false, "Output")}</section>)}</div><InstrumentHelp>Main 1/2 and Drum 1–8 are exclusive destinations. Route auxiliary output pairs with track sends; a piece assigned to an auxiliary pair is removed from Main.</InstrumentHelp></InstrumentSection>}
  </InstrumentShell>;
}
