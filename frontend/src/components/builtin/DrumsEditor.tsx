import { editorButton } from "./PluginEditorControls";
import { useState } from "react";
import { createEffectParameterRenderer, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { InstrumentControls, InstrumentFocusTabs, InstrumentHelp, InstrumentPerformanceReadout, InstrumentSection, InstrumentShell, InstrumentSlider, instrumentValue, useInstrumentPerformance, useInstrumentPreview, useInstrumentPage } from "./InstrumentEditorParts";
import { displayedDrumNotes, drumPadFromSchema, drumPieceNames } from "./instrumentDrumPads";
import { DrumMapEditor } from "./DrumMapEditor";
import { DrumMappingGuide } from "./DrumMappingGuide";
import "./DrumsEditor.css";
import { instrumentControlLocation } from "./instrumentControlLocation";

const performancePadNotes = [36, 38, 42, 46, 41, 45, 47, 44, ...displayedDrumNotes.filter(note => ![36, 38, 42, 46, 41, 45, 47, 44].includes(note))];

function DrumPads({ props, selectedInput, onSelect }: { props: ApprovedEffectEditorProps; selectedInput: number | null; onSelect: (note: number) => void }) {
  const preview = useInstrumentPreview(props.address), meters = useInstrumentPerformance();
  const inputKeys = meters?.instrumentPerformance?.notes ?? [];
  const [bank, setBank] = useState("Core kit");
  return <><div className="drums-pad-banks mb-2 flex gap-2" role="group" aria-label="Pad bank">{["Core kit", "Cymbals & extras"].map(name => <button className="instrument-text-button text-xs" key={name} type="button" aria-pressed={bank === name} onClick={() => { preview.stopAll(); setBank(name); }}>{name}</button>)}</div><div className="drums-pad-grid grid gap-2" data-bank={bank} role="group" aria-label="Sixteen drum input pads">{performancePadNotes.map((note, index) => {
    const mapping = drumPadFromSchema(props.schema, note);
    const start = () => { onSelect(note); if (mapping.available && !mapping.ignored) preview.start(note); };
    const output = mapping.piece === null ? "" : props.schema.parameters.find(parameter => parameter.id === `pieceOutput${mapping.piece}`);
    const outputName = output && output.enumOptions?.find(option => option.value === output.value)?.label;
    return <button key={note} type="button" className="drums-pad flex flex-col justify-end items-start p-[10px] text-left" data-bank={index < 8 ? "Core kit" : "Cymbals & extras"} data-piece={mapping.piece ?? "none"} data-ignored={mapping.ignored}
      data-audition={preview.pressed.has(note)} data-input-held={inputKeys.some(item => item.note === note && item.held)} aria-pressed={selectedInput === note}
      aria-label={`${mapping.ignored ? "Select ignored input" : "Audition"} ${mapping.label}, MIDI input ${note}${mapping.voiceNote !== null ? `, voice ${mapping.voiceNote}` : ""}`}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); start(); }}
      onPointerUp={() => preview.stop(note)} onPointerCancel={() => preview.stop(note)} onLostPointerCapture={() => preview.stop(note)} onBlur={() => preview.stop(note)}
      onKeyDown={event => {
        const direction = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 } as Record<string, number>)[event.key];
        if (direction) { event.preventDefault(); const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? []).filter(button => button.offsetParent !== null); const position = buttons.indexOf(event.currentTarget); buttons[(position + direction + buttons.length) % buttons.length]?.focus(); }
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); if (!event.repeat) start(); } }}
      onKeyUp={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); preview.stop(note); } }}>
      <span className="drums-pad-index flex items-center justify-between">{String(index + 1).padStart(2, "0")}<i aria-hidden="true" title="Incoming MIDI key held" /></span>
      <strong>{mapping.label}</strong><span className="drums-pad-note">IN {note}{mapping.voiceNote !== null && mapping.voiceNote !== note ? ` → ${mapping.voiceNote}` : ""}</span><small>{mapping.ignored ? "Silent input" : outputName || ""}</small>
    </button>;
  })}</div>{preview.error && <span className="mt-2 block text-xs text-daw-text-muted" role="status">{preview.error}</span>}</>;
}

export function DrumsEditor(props: ApprovedEffectEditorProps) {
  const { tab, setTab, wide, onOverviewChange } = useInstrumentPage("Kit");
  const [selectedInput, setSelectedInput] = useState<number | null>(36), [pieceOverride, setPieceOverride] = useState(0), [mapOpen, setMapOpen] = useState(false);
  const [focus, setFocus] = useState("Pads"), [mapInput, setMapInput] = useState(36);
  const [mapOwner, setMapOwner] = useState<string>();
  const control = createEffectParameterRenderer(props);
  const articulated = instrumentValue(props.schema, "articulationEngine") >= .5;
  const selected = selectedInput === null ? null : drumPadFromSchema(props.schema, selectedInput);
  const piece = selected ? selected.piece : pieceOverride;
  const choosePiece = (value: number) => { setSelectedInput(null); setPieceOverride(value); };
  return <InstrumentShell props={props} kind="drums" tabs={["Kit", "Mapping", "Outputs"]} tab={tab} onTab={setTab} wide={wide} onOverviewChange={onOverviewChange}
    onReveal={({ parameterId, workflowId, ownerId }) => {
      const location = parameterId ? instrumentControlLocation("drums", parameterId) : null;
      if (location) { setTab(location.page); if (location.section) setFocus(location.section); if (location.piece !== undefined) choosePiece(location.piece); if (location.mapInput !== undefined) { setMapInput(location.mapInput); setMapOwner(ownerId); setMapOpen(true); } }
      else if (workflowId === "drum-map") { setTab("Mapping"); setMapOwner(ownerId); setMapOpen(true); }
      else if (workflowId === "outputs") setTab("Outputs");
    }}
    footer={<><div className="drums-master-strip flex shrink-0 flex-wrap items-center gap-5 px-4 py-3"><InstrumentSlider props={props} id="outputGain" label="Master output · dB" /><InstrumentSlider props={props} id="stereoWidth" label="Stereo width" /><span>16 input pads · 8 mixer groups</span></div><InstrumentPerformanceReadout props={props} /></>}>
    {mapOpen && <DrumMapEditor initialInput={mapInput} featureOwner={mapOwner} schema={props.schema} address={props.address} onApply={props.onApplyValues} onClose={() => setMapOpen(false)} />}
    <div className="drums-topbar mb-3 flex flex-wrap items-end gap-3">{control("kit", false, articulated ? "Kit (Legacy engine)" : "Kit voice", articulated)}{control("articulationEngine", false, "Voice engine")}{control("mapPreset", false, "MIDI mapping")}<button className={editorButton} data-feature="drum-map" type="button" onClick={() => { setMapInput(selectedInput ?? 36); setMapOpen(true); }}>Edit MIDI map</button></div>
    {(tab === "Kit" || tab === "Overview") && <><InstrumentFocusTabs sections={["Pads", "Selected piece", "Character"]} selected={focus} onSelect={setFocus} /><div className="drums-kit-layout grid gap-3" data-focus={focus}><InstrumentSection title="Performance pads" detail="Hold to audition" className="drums-pads-panel"><DrumPads props={props} selectedInput={selectedInput} onSelect={setSelectedInput} /></InstrumentSection>
      {tab !== "Overview" && <InstrumentSection title={piece === null ? selected?.label ?? "Select a piece" : drumPieceNames[piece]} detail={selectedInput === null ? "Mixer group" : `Input ${selectedInput}`} className="drums-piece-inspector">
        <label className="mb-4 flex flex-col gap-2 text-xs">Piece inspector<select className="suite-select" aria-label="Drum piece" value={piece ?? ""} onChange={event => choosePiece(Number(event.target.value))}>{piece === null && <option value="">No voice selected</option>}{drumPieceNames.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>
        {piece === null ? <InstrumentHelp>{selected?.ignored ? `MIDI ${selectedInput} is ignored and selects no mixer group. Change its mapping to assign a voice.` : "Choose a mapped pad or a mixer group."}</InstrumentHelp> : <><InstrumentControls>{control(`pieceGain${piece}`, false, "Level")}{control(`pieceTuning${piece}`, false, "Tune")}{control(`piecePan${piece}`, false, "Pan")}{control(`pieceDecay${piece}`, false, "Decay")}</InstrumentControls><div className="mt-4">{control(`pieceOutput${piece}`, false, "Output")}</div><details className="mt-3 text-xs"><summary className="cursor-pointer py-1">Mapped input notes</summary><DrumMappingGuide schema={props.schema} piece={piece} /></details></>}
      </InstrumentSection>}
      <InstrumentSection title="Kit character" className="drums-character"><InstrumentControls>{["tuning", "punch", "ambience", "hihatTightness", "velocityCurve"].map(id => control(id, false, undefined, articulated && id === "hihatTightness"))}</InstrumentControls>{articulated && <InstrumentHelp>Hi-hat Tightness and Kit apply to Legacy voices. Their values are retained.</InstrumentHelp>}</InstrumentSection>
    </div></>}
    {(tab === "Mapping" || tab === "Overview") && <div className="drums-mapping-layout grid gap-[14px]"><InstrumentSection title="MIDI input map" detail="All 128 notes" feature="drum-map"><InstrumentHelp>Map an incoming note to another voice or Ignore. MIDI Learn captures the incoming key, then Apply saves the complete edit as one Undo step.</InstrumentHelp><button className={`${editorButton} my-4`} type="button" onClick={() => setMapOpen(true)}>Open mapping editor</button>{control("customMapEnabled", false, "Custom map")}<div className="drums-mapping-table mt-4" role="table" aria-label="Effective MIDI mapping">{props.schema.drumMapping?.map(row => { const mapping = drumPadFromSchema(props.schema, row.inputNote); return <div role="row" key={row.inputNote}><span role="cell">{row.inputNote}</span><span role="cell">{mapping.voiceNote ?? "—"}</span><span role="cell">{mapping.label}</span><span role="cell">{mapping.piece === null ? "—" : drumPieceNames[mapping.piece]}</span></div>; })}</div></InstrumentSection>{tab !== "Overview" && <InstrumentSection title="Playing response"><InstrumentControls>{control("velocityCurve")}{control("hihatTightness", false, "Hi-hat Tightness (Legacy engine)", articulated)}</InstrumentControls><InstrumentHelp>{instrumentValue(props.schema, "articulationEngine") >= .5 ? "Articulated voices use their own kit and hi-hat response; Kit and Hi-hat Tightness apply to the Legacy engine. Articulated voices share eight mixer groups. Closed and pedal hats choke open hats on the same channel." : "Choose Articulated to enable additional drum hits."}</InstrumentHelp><InstrumentHelp>Incoming input notes remain distinct from the effective voices. Ignored inputs are silent.</InstrumentHelp></InstrumentSection>}</div>}
    {(tab === "Outputs" || tab === "Overview") && <InstrumentSection title="Piece mixer" detail="Exclusive outputs" feature="outputs"><div className="drums-piece-mixer grid gap-[14px]">{drumPieceNames.map((name, index) => <section key={name} aria-label={`${name} mixer`}><h4>{name}</h4><InstrumentControls>{control(`pieceGain${index}`, false, "Level")}{control(`piecePan${index}`, false, "Pan")}{tab === "Overview" && <>{control(`pieceTuning${index}`, false, "Tune")}{control(`pieceDecay${index}`, false, "Decay")}</>}</InstrumentControls>{control(`pieceOutput${index}`, false, "Output")}</section>)}</div><InstrumentHelp>Main 1/2 and Drum 1–8 are exclusive destinations. Route auxiliary output pairs with track sends; a piece assigned to an auxiliary pair is removed from Main.</InstrumentHelp></InstrumentSection>}
  </InstrumentShell>;
}
