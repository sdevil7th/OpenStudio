import { expandedBuiltInParamId } from "../../utils/builtInExpandedSelectors";
import type { BuiltInParamDescriptor } from "../../services/NativeBridge";
import type { ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { EQToolbar } from "./EQToolbar";
import { SuiteParameter } from "./SuiteParameter";
import "./SuiteEditor.css";

const sectionNames: Record<string, string> = {
  scale: "Key & scale", correction: "Correction", detection: "Detection", notes: "Custom scale notes",
  formant: "Formants", midi: "MIDI output", mix: "Processing", controls: "Parameters",
};
const sectionOrder = ["scale", "correction", "detection", "notes", "formant", "midi", "mix"];

/** Parameter-only fallback. Graphical pitch editing stays in the shared clip editor. */
export function SuiteEditor(props: ApprovedEffectEditorProps) {
  const { schema } = props;
  const pitch = schema.pluginId === "pitch" || schema.name === "OpenStudio Pitch Correct";
  const customScale = schema.parameters.find(parameter => parameter.id === "scale")?.value === 15;
  const groups = new Map<string, BuiltInParamDescriptor[]>();
  for (const parameter of schema.parameters) {
    if (parameter.type === "meter" || parameter.graphRole === "stateBank"
      || expandedBuiltInParamId(schema, parameter.id) !== parameter.id
      || (pitch && parameter.id.startsWith("noteEnable_") && !customScale)) continue;
    const role = parameter.graphRole || "controls";
    const parameters = groups.get(role) ?? [];
    parameters.push(parameter); groups.set(role, parameters);
  }
  const order = (role: string) => sectionOrder.includes(role) ? sectionOrder.indexOf(role) : sectionOrder.length;
  return <div className="approved-effect-editor suite-editor flex min-h-0 min-w-0 flex-1 flex-col" data-suite-kind={pitch ? "pitch" : schema.pluginId}>
    <EQToolbar {...props} />
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {pitch && <div className="rounded border border-daw-border-light bg-daw-dark p-4 text-sm">
        <h2 className="font-medium">Realtime pitch parameters</h2>
        <p className="mt-2 text-xs leading-relaxed text-daw-text-muted">For recorded audio, open this effect from the FX chain or choose Edit Pitch on a clip to use the existing pitch editor.</p>
      </div>}
      {[...groups].sort(([left], [right]) => order(left) - order(right)).map(([role, parameters]) => <section key={role} className="suite-fallback-section shrink-0 rounded border border-daw-border-light" aria-label={sectionNames[role] ?? role}>
        <h3 className="border-b border-daw-border-light px-4 py-2 text-xs font-medium text-daw-text-muted">{sectionNames[role] ?? role}</h3>
        <div className="flex flex-wrap items-center gap-6 p-4">{parameters.map(parameter => <SuiteParameter key={parameter.id} parameter={parameter}
          label={pitch && parameter.id === "bypass" ? "Realtime processor bypass" : undefined}
          onChange={props.onChange} onGestureStart={props.onGestureStart} onGestureEnd={props.onGestureEnd} />)}</div>
      </section>)}
      {groups.size === 0 && <p role="status" className="p-4 text-sm text-daw-text-muted">No editable parameters are available for this processor.</p>}
    </div>
  </div>;
}
