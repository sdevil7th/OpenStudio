import { expandedBuiltInParamId } from "../../utils/builtInExpandedSelectors";
import { memo, useRef, useState } from "react";
import type { BuiltInParamDescriptor } from "../../services/NativeBridge";
import { useApprovedEffectMeters, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { usePluginFeatureReveal } from "../../utils/pluginFeatureNavigation";
import { useEditorOverview } from "./useEditorOverview";
import { EQToolbar } from "./EQToolbar";
import { SuiteParameter } from "./SuiteParameter";
import "./SuiteEditor.css";

const sectionNames: Record<string, string> = {
  scale: "Key & scale", correction: "Correction", detection: "Detection", notes: "Custom scale notes",
  formant: "Formants", midi: "MIDI output", mix: "Processing", controls: "Parameters",
};
const sectionOrder = ["scale", "correction", "detection", "notes", "formant", "midi", "mix"];

const PitchReadout = memo(function PitchReadout(props: ApprovedEffectEditorProps) {
  const meters = useApprovedEffectMeters(props);
  const valid = typeof meters?.detectedHz === "number" && meters.detectedHz > 0 && Number.isFinite(meters.detectedHz);
  return <section className="pitch-live-readout flex flex-wrap items-center justify-between gap-4" aria-label="Live pitch detection">
    <div><span className="pitch-eyebrow">LIVE INPUT</span><strong>{valid ? meters.noteName || `${meters.detectedHz!.toFixed(1)} Hz` : "No pitch detected"}</strong></div>
    <div className="flex flex-wrap gap-5 text-xs tabular-nums"><span>Input <b>{valid ? `${meters.detectedHz!.toFixed(1)} Hz` : "—"}</b></span><span>Corrected <b>{valid && (meters?.correctedHz ?? 0) > 0 ? `${meters!.correctedHz!.toFixed(1)} Hz` : "—"}</b></span><span>Confidence <b>{valid && Number.isFinite(meters?.confidence) ? `${Math.round(meters!.confidence! * 100)}%` : "—"}</b></span></div>
  </section>;
});

/** The live processor has its own controls; recorded audio keeps the shared clip editor. */
function RealtimePitchEditor(props: ApprovedEffectEditorProps) {
  const { schema } = props;
  const editor = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState("Correction");
  const overview = useEditorOverview(editor);
  const parameter = (id: string) => schema.parameters.find(item => item.id === id);
  const value = (id: string) => parameter(id)?.value ?? 0;
  const legacy = value("signalPath") < .5;
  const notesActive = legacy || value("scale") === 15;
  usePluginFeatureReveal(editor, schema.pluginId ?? "pitch", ({ parameterId }) => {
    const role = parameter(parameterId ?? "")?.graphRole;
    setPage(role === "detection" || role === "notes" ? "Source" : role === "midi" ? "MIDI output" : role === "formant" ? "Formants" : "Correction");
  });
  const control = (id: string, label?: string, disabled = false) => {
    const descriptor = parameter(id);
    return descriptor && <SuiteParameter key={id} parameter={descriptor} label={label} disabled={disabled}
      onChange={props.onChange} onGestureStart={props.onGestureStart} onGestureEnd={props.onGestureEnd} />;
  };
  const pages = ["Correction", "Source", "Formants", "MIDI output"];
  const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return <div ref={editor} className="approved-effect-editor suite-editor pitch-editor flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind="pitch" data-overview={overview}>
    <EQToolbar {...props} />
    <header className="pitch-heading flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3"><div><span className="pitch-eyebrow">OPENSTUDIO / PITCH CORRECT</span><h2>Realtime correction</h2></div><div className="pitch-key-scale flex items-center gap-4" aria-label="Key and scale">{control("key")}{control("scale")}</div></header>
    <PitchReadout {...props} />
    <nav className="pitch-pages flex shrink-0 gap-1 px-4" aria-label="Realtime pitch pages">{pages.map(name => <button type="button" key={name} aria-pressed={page === name} onClick={() => setPage(name)}>{name}</button>)}</nav>
    <div className="pitch-workspace min-h-0 min-w-0 flex-1 overflow-y-auto p-4" data-page={page}>
      <section className="pitch-section pitch-correction" aria-label="Pitch correction" hidden={!overview && page !== "Correction"}>
        <h3>Correction</h3><div className="pitch-controls flex flex-wrap items-center justify-evenly gap-4">{control("retuneSpeed")}{control("correctionStrength")}{control("humanize")}{control("transpose")}</div>
        <div className="pitch-secondary flex flex-wrap items-center justify-between gap-4">{control("humanizeMode")}<p>Retune sets how quickly notes move to the selected scale. Humanize softens correction; Sustained notes responds to note age.</p></div>
      </section>
      <section className="pitch-section pitch-source" aria-label="Pitch source and detection" hidden={!overview && page !== "Source"}>
        <h3>Source & detection</h3><div className="pitch-controls flex flex-wrap items-center justify-evenly gap-4">{control("detectionSource", "Detect from")}{control("minFreqParam", "Lowest pitch")}{control("maxFreqParam", "Highest pitch")}{control("sensitivity")}</div>
        <p className="pitch-help">Set the detection range around a single voice or instrument. Stereo source selection changes detection; the correction processes the audio channels.</p>
        <div className="pitch-secondary" aria-label="Custom scale notes"><h4>{legacy ? "Allowed notes · Legacy" : "Custom scale notes"}</h4><div className="pitch-note-switches mt-3 flex flex-wrap gap-2">{notes.map((name, index) => control(`noteEnable_${index}`, legacy ? notes[(Math.round(value("key")) + index) % 12] : name, !notesActive))}</div><p className="pitch-help">{legacy ? "Legacy switches follow the key and restrict named scales too. Corrected mode uses absolute notes only in Custom." : notesActive ? "Enabled notes are absolute C–B targets for the Custom scale." : "Choose Custom in Scale to edit these saved note switches."}</p></div>
      </section>
      <section className="pitch-section pitch-formants" aria-label="Formant controls" hidden={!overview && page !== "Formants"}>
        <h3>Formants</h3><div className="pitch-controls flex flex-wrap items-center justify-start gap-6">{control("formantCorrection", "Preserve formants")}{control("formantShift")}</div><p className="pitch-help">Preserve formants compensates the spectral envelope while correcting pitch. Formant Shift moves the envelope independently of the note target.</p>
      </section>
      <section className="pitch-section pitch-midi" aria-label="Detected MIDI output" hidden={!overview && page !== "MIDI output"}>
        <h3>Detected MIDI output</h3><div className="pitch-controls flex flex-wrap items-center justify-start gap-6">{control("midiOutputEnabled", "MIDI output")}{control("midiOutputChannel", "MIDI channel", value("midiOutputEnabled") < .5)}</div><p className="pitch-help">Sends detected note events on the selected channel. This is an output; incoming MIDI does not set the correction target.</p>
        <div className="pitch-secondary"><h4>Recorded audio</h4><p className="pitch-help">Choose Edit Pitch on an audio clip, or open Pitch Correct from the FX chain, to use the existing graphical editor. Its dock, detach and history remain in that session. Active realtime correction is reviewed before opening the clip.</p></div>
      </section>
    </div>
    <footer className="pitch-output flex shrink-0 flex-wrap items-center justify-between gap-4 px-5 py-3" aria-label="Realtime processing">{control("bypass", "Realtime processor bypass")}<span className="text-xs text-daw-text-muted">{legacy ? "Legacy signal path" : "Corrected signal path"}</span>{control("mix", "Mix")}</footer>
  </div>;
}

/** Parameter-only fallback. Graphical pitch editing stays in the shared clip editor. */
export function SuiteEditor(props: ApprovedEffectEditorProps) {
  const { schema } = props;
  const pitch = schema.pluginId === "pitch" || schema.name === "OpenStudio Pitch Correct";
  if (pitch) return <RealtimePitchEditor {...props} />;
  const groups = new Map<string, BuiltInParamDescriptor[]>();
  for (const parameter of schema.parameters) {
    if (parameter.type === "meter" || parameter.id === "signalPath" || parameter.graphRole === "stateBank"
      || expandedBuiltInParamId(schema, parameter.id) !== parameter.id) continue;
    const role = parameter.graphRole || "controls";
    const parameters = groups.get(role) ?? [];
    parameters.push(parameter); groups.set(role, parameters);
  }
  const order = (role: string) => sectionOrder.includes(role) ? sectionOrder.indexOf(role) : sectionOrder.length;
  return <div className="approved-effect-editor suite-editor flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind={schema.pluginId}>
    <EQToolbar {...props} />
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {[...groups].sort(([left], [right]) => order(left) - order(right)).map(([role, parameters]) => <section key={role} className="suite-fallback-section shrink-0 rounded border border-daw-border-light" aria-label={sectionNames[role] ?? role}>
        <h3 className="border-b border-daw-border-light px-4 py-2 text-xs font-medium text-daw-text-muted">{sectionNames[role] ?? role}</h3>
        <div className="flex flex-wrap items-center gap-6 p-4">{parameters.map(parameter => <SuiteParameter key={parameter.id} parameter={parameter}
          onChange={props.onChange} onGestureStart={props.onGestureStart} onGestureEnd={props.onGestureEnd} />)}</div>
      </section>)}
      {groups.size === 0 && <p role="status" className="p-4 text-sm text-daw-text-muted">No editable parameters are available for this processor.</p>}
    </div>
  </div>;
}
