import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { BuiltInPluginSchema } from "../../services/NativeBridge";
import { expandedBuiltInParamId } from "../../utils/builtInExpandedSelectors";
import { dispatchPluginFeatureReveal, locatePluginFeature, type PluginFeatureRevealRequest } from "../../utils/pluginFeatureNavigation";
import { Modal } from "../ui";
import { editorButton } from "./PluginEditorControls";

interface Feature { id: string; label: string; detail: string; parameterId?: string; workflowId?: string }
const workflows: Record<string, ReadonlyArray<readonly [string, string, string]>> = {
  synth: [["matrix", "Modulation matrix", "Eight routes and modulation destinations"], ["macro-learn", "Macros and MIDI learn", "Four macro controllers"], ["mpe", "MPE and pitch bend", "Member and master channels"]],
  piano: [["pedals", "Pedal response", "Sustain, sostenuto and soft pedal"]],
  guitar: [["articulations", "Playing articulations", "Keyswitches and string behavior"]],
  drums: [["drum-map", "Drum map and MIDI learn", "128 input notes, Ignore and articulations"], ["outputs", "Output routing", "Main and auxiliary destinations"]],
  eq: [["draw", "Draw an EQ curve", "Draw, preview and apply"], ["match", "Match a reference", "Capture, compare and apply"], ["grab", "Grab a spectrum", "Capture and review"], ["instances", "EQ instances", "Compare other equalizers"], ["midi-programs", "MIDI programs and presets", "Prepared configurations and library"]],
  utility: [["alignment", "Analyze and align", "Capture, review and apply timing"], ["spectral", "Spectral phase", "48 points per channel"]],
  reverb: [["machines", "Reverb machines", "Search all 41 spaces"], ["response", "Response analysis", "Measure the current space"], ["meters", "Metering", "Input, output, ducking and peak readings"], ...["Shape", "Balance", "Sources", "Position", "Damping", "Bright", "EQ", "Decay", "Audition"].map(page => [`ir-${page.toLowerCase()}`, `Convolution: ${page}`, "Select Convolution to use impulse-response tools"] as const)],
};

export function pluginSearchFeatures(schema: BuiltInPluginSchema): Feature[] {
  const canonicalId = (id: string) => {
    const semanticId = id.replace(/(?:Expanded|Extended|All|Full)$/, "");
    const expanded = expandedBuiltInParamId(schema, semanticId);
    return expanded !== semanticId ? expanded : expandedBuiltInParamId(schema, id);
  };
  const controls = schema.parameters.filter(parameter => ["continuous", "enum", "toggle"].includes(parameter.type)
    && parameter.graphRole !== "stateBank" && !["signalPath", "bypass"].includes(parameter.id) && canonicalId(parameter.id) === parameter.id);
  return [...controls.map(parameter => ({ id: parameter.id, parameterId: parameter.id, label: parameter.label,
    detail: [parameter.graphRole, parameter.enumOptions?.map(option => option.label).join(" · "), parameter.id].filter(Boolean).join(" · ") })),
  ...(workflows[schema.pluginId ?? ""] ?? []).map(([id, label, detail]) => ({ id: `workflow:${id}`, workflowId: id, label, detail }))];
}

export function PluginFeatureFinder({ schema }: { schema: BuiltInPluginSchema }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [notice, setNotice] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const noticeElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (open && notice) noticeElement.current?.focus(); }, [open, notice]);
  const features = useMemo(() => pluginSearchFeatures(schema), [schema]);
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = features.filter(feature => words.every(word => `${feature.label} ${feature.detail}`.toLocaleLowerCase().includes(word)));
  const reveal = (feature: Feature) => {
    const root = button.current?.closest<HTMLElement>(".approved-effect-editor, [data-suite-kind], .eq-editor");
    if (!root) return;
    root.dataset.featureOwner ??= crypto.randomUUID();
    const request: PluginFeatureRevealRequest = { pluginId: schema.pluginId ?? "", parameterId: feature.parameterId, workflowId: feature.workflowId, ownerId: root.dataset.featureOwner };
    setOpen(false);
    dispatchPluginFeatureReveal(root, request);
    // A parent may mount a nested editor. A second dispatch lets that editor select its page.
    requestAnimationFrame(() => {
      if (!root.isConnected) return;
      dispatchPluginFeatureReveal(root, request);
      requestAnimationFrame(() => {
        if (!root.isConnected) return;
        const target = locatePluginFeature(root, request);
        const focusSelector = "button, input, select, textarea, [tabindex]";
        const controls = target ? [...(target.matches(focusSelector) ? [target] : []), ...Array.from(target.querySelectorAll<HTMLElement>(focusSelector))] : [];
        const focus = controls.find(element => !element.matches(":disabled") && !element.closest("[inert], [aria-disabled='true']")
          && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
        const unavailable = !target || target.matches(":disabled") || target.closest("[inert], [aria-disabled='true']")
          || Boolean(feature.parameterId && controls.length && !focus);
        if (unavailable || !target) { setOpen(true); setNotice(`${feature.label} is not active in the current configuration. Its stored setting is retained. Select the relevant model or mode in the editor to use it.`); return; }
        setOpen(false); setNotice("");
        requestAnimationFrame(() => {
          if (!target.isConnected) return;
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
          if (focus?.isConnected) focus.focus({ preventScroll: true });
          else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
        });
      });
    });
  };
  return <><button ref={button} type="button" className={editorButton} aria-label="Find a control or feature" title="Find a control or feature" onClick={() => { setOpen(true); setQuery(""); setNotice(""); }}><Search size={14} /><span>Find</span></button>
    {open && <Modal isOpen title={`Find in ${schema.name.replace(/^OpenStudio /, "")}`} onClose={() => setOpen(false)} size="md">
      <div className="flex min-h-0 flex-col gap-3">
        <input autoFocus aria-label="Search controls and features" className="min-h-10 rounded border border-daw-border-light bg-daw-dark px-3 text-sm text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent" placeholder="Try sidechain, output, MPE or a parameter name" value={query} onChange={event => { setQuery(event.target.value); setNotice(""); }} />
        <p className="text-xs text-daw-text-muted">Find opens the relevant page. It preserves your sound and stored settings.</p>
        {notice && <p ref={noticeElement} role="status" tabIndex={-1} className="rounded border border-daw-border-light p-3 text-sm focus-visible:outline-2 focus-visible:outline-daw-accent">{notice}</p>}
        <div className="flex max-h-[48vh] flex-col gap-1 overflow-y-auto" aria-label="Search results">
          {matches.slice(0, 80).map(feature => <button key={feature.id} type="button" className="flex shrink-0 flex-col gap-1 rounded border border-transparent p-3 text-left hover:bg-daw-lighter focus-visible:border-daw-accent focus-visible:outline-none" onClick={() => reveal(feature)}><span className="text-sm font-medium">{feature.label}</span><span className="text-xs text-daw-text-muted">{feature.detail}</span></button>)}
          {!matches.length && <p role="status" className="p-3 text-sm text-daw-text-muted">No matching controls. Try a shorter name.</p>}
        </div>
        <p className="text-xs text-daw-text-muted">{matches.length} matches{matches.length > 80 ? " · First 80 shown; refine your search" : ""}</p>
      </div>
    </Modal>}
  </>;
}
