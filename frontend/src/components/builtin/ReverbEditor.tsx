import { editorButton } from "./PluginEditorControls";
import { memo, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { BuiltInParamDescriptor } from "../../services/NativeBridge";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { reverbControlLayout, type ReverbControl } from "../../utils/reverbControlLayout";
import { useApprovedEffectMeters, type ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { EQToolbar } from "./EQToolbar";
import { SuiteParameter } from "./SuiteParameter";
import { ImpulseResponseEditor } from "./ImpulseResponseEditor";
import { ReverbPeakReadouts } from "./ReverbPeakReadouts";
import { ReverbResponsePanel } from "./ReverbResponsePanel";
import "./ReverbEditor.css";

const studioTypes = new Set([0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 38, 39, 40]);
const number = (value: number | undefined, suffix: string, precision = 1) => Number.isFinite(value) ? `${value!.toFixed(precision)} ${suffix}` : "Unavailable";

// Polling lives below the editor, so meter frames never rerender its controls.
const ReverbTelemetry = memo(function ReverbTelemetry({ schema, address, onChange, detailed = false }: Pick<ApprovedEffectEditorProps, "schema" | "address" | "onChange"> & { detailed?: boolean }) {
  const values = useApprovedEffectMeters({ schema, address });
  const reconstruction = findBuiltInParameter(schema, "reconstructedPeaks");
  const peak = (readings?: number[]) => { const finite = readings?.filter(Number.isFinite) ?? []; return finite.length ? Math.max(...finite) : undefined; };
  const spatial = [12, 13, 14].includes(Math.round(findBuiltInParameter(schema, "algorithm")?.value ?? 0));
  return <div className={detailed ? "reverb-telemetry-detail flex flex-col gap-4" : "reverb-telemetry flex flex-wrap items-center gap-x-4 gap-y-1"} aria-label="Reverb live readings">
    <span>In <b>{number(peak(values?.inputPeaksDb), "dBFS")}</b></span><span>Out <b>{number(peak(values?.outputPeaksDb), "dBFS")}</b></span>
    <span>Ducking <b>{number(values?.gainReductionDb, "dB")}</b></span>
    <span>{spatial ? "Input echo" : "Effective pre-delay"} <b>{number(values?.effectivePredelayMs, "ms", 0)}</b><small> / {number(values?.tempoBpm, "BPM", 1)}</small>{(spatial ? values?.spatialDelayCapped : values?.predelayLimited) && <strong className="ml-2" role="status">Capacity limit</strong>}</span>
    {detailed && <ReverbPeakReadouts visualization={values} address={address} reconstructed={(reconstruction?.value ?? 0) >= .5} onReconstructionChange={reconstruction ? enabled => onChange(reconstruction, enabled ? 1 : 0) : undefined} />}
  </div>;
});

export function ReverbEditor(props: ApprovedEffectEditorProps) {
  const { schema, address } = props;
  const layout = reverbControlLayout(schema);
  const parameter = (id: string) => findBuiltInParameter(schema, id);
  const value = (id: string) => parameter(id)?.value ?? 0;
  const machine = parameter("algorithm");
  const machines = machine?.enumOptions ?? [];
  const machineName = machines.find(option => option.value === layout.type)?.label ?? schema.name;
  const [query, setQuery] = useState(""), [category, setCategory] = useState("all");
  const [selectedPage, setSelectedPage] = useState("character");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const identity = `${schema.instanceId ?? address.instanceId}:${address.chain}:${address.trackId}:${address.fxIndex}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const tabPrefix = useId();
  const run = async (operation: () => Promise<boolean>) => {
    if (mutation.current) return;
    const started = currentIdentity.current;
    mutation.current = true; setBusy(true); setError("");
    try { if (!await operation() && started === currentIdentity.current) setError("The processor did not accept this change. Check its current settings and try again."); }
    catch (reason) { if (started === currentIdentity.current) setError(reason instanceof Error ? reason.message : "Could not apply the change."); }
    finally { mutation.current = false; if (started === currentIdentity.current) setBusy(false); }
  };
  const apply = (id: string, next: number) => { const descriptor = parameter(id); if (descriptor && descriptor.value !== next) void run(() => props.onApplyValues({ [descriptor.id]: next })); };
  const change = (descriptor: BuiltInParamDescriptor, next: number) => {
    if (descriptor.id === machine?.id || descriptor.id === "sendMode") apply(descriptor.id, next);
    else props.onChange(descriptor, next);
  };
  const render = (control: string | ReverbControl, large = false) => {
    const { id, label } = typeof control === "string" ? { id: control, label: undefined } : control;
    let descriptor = parameter(id);
    if (!descriptor) return null;
    if (id === "decayTime" && layout.dispersive) descriptor = { ...descriptor, min: .8, max: 10 };
    if (id === "decayTime" && layout.type === 6) descriptor = { ...descriptor, max: 2 };
    const name = label ?? (id === "retroAttack" ? layout.type === 32 ? "Early / tail" : layout.type === 36 ? "Envelope shape" : "Buildup" : id === "diffusion" && layout.type >= 24 ? "Late diffusion" : undefined);
    return <SuiteParameter key={descriptor.id} parameter={descriptor} label={name} large={large} onChange={change} onGestureStart={props.onGestureStart} onGestureEnd={props.onGestureEnd} />;
  };
  const pages = [...layout.pages, { id: "meters", label: "Metering", controls: [] }, { id: "response", label: "Response", controls: [] }];
  const page = pages.find(item => item.id === selectedPage) ?? pages[0];
  const selectPage = (id: string) => {
    if (id === "response") void run(async () => { if (!await props.onFlush()) return false; setSelectedPage(id); return true; });
    else setSelectedPage(id);
  };
  const held = layout.hold && value(layout.hold) >= .5;
  const send = value("sendMode") >= .5;
  const filtered = machines.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase())
    && (category === "all" || category === "ir" && option.value === 7 || category === "studio" && studioTypes.has(option.value) || category === "creative" && option.value !== 7 && !studioTypes.has(option.value)));
  const modified = (controls: ReverbControl[]) => controls.some(control => { const p = parameter(control.id); return p && Math.abs(p.value - p.defaultValue) > 1e-5; });
  const family = layout.type === 7 ? "CONVOLUTION" : studioTypes.has(layout.type) ? "STUDIO" : "CREATIVE";
  return <div className="approved-effect-editor reverb-editor flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Reverb editor">
    <EQToolbar {...props} />
    {error && <p className="reverb-error shrink-0 px-4 py-2 text-xs" role="alert">{error}</p>}
    <div className="reverb-face flex min-h-0 min-w-0 flex-1" inert={busy} aria-busy={busy} data-machine={layout.type}>
      <aside className="reverb-bank flex min-h-0 shrink-0 flex-col" aria-label="Reverb machine browser">
        <div className="reverb-bank-caption flex items-center justify-between"><span>REVERB MACHINES</span><span>{machines.length}</span></div>
        <label className="reverb-search flex items-center gap-2"><Search size={14} aria-hidden="true" /><input type="search" className="min-w-0 flex-1" aria-label="Search reverb machines" placeholder="Find a machine" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="reverb-filters flex" aria-label="Filter reverb machines">{[["all", "All"], ["studio", "Studio"], ["creative", "Creative"], ["ir", "IR"]].map(([id, label]) => <button type="button" key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}</button>)}</div>
        <div className="reverb-machine-list min-h-0 flex-1 overflow-y-auto">{filtered.map(option => <button type="button" key={option.value} className="reverb-machine flex w-full items-center gap-2.5 text-left" aria-pressed={layout.type === option.value} onClick={() => apply("algorithm", option.value)}><span className="reverb-machine-number">{String(option.value + 1).padStart(2, "0")}</span><span>{option.label}</span>{option.value === layout.type && <i className="ml-auto" aria-hidden="true" />}</button>)}{!filtered.length && <p className="px-2 py-4 text-xs" role="status">No matching machines.</p>}</div>
        <div className="reverb-bank-foot">ALGORITHMIC + CONVOLUTION</div>
      </aside>
      <main className="reverb-console flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="reverb-machine-heading flex shrink-0 items-center justify-between gap-4">
          <div className="reverb-machine-title min-w-0"><p className="reverb-overline">{family} <span>/</span> {String(layout.type + 1).padStart(2, "0")}</p><h2 className="truncate" title={machineName}>{machineName}</h2></div>
          <label className="reverb-compact-picker min-w-0"><span className="sr-only">Reverb machine</span><select className="suite-select" aria-label="Reverb machine" value={layout.type} onChange={event => apply("algorithm", Number(event.target.value))}>{machines.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {layout.hold ? <div className="reverb-hold shrink-0 text-center">{render({ id: layout.hold, label: layout.ambient ? "Hold" : held ? "Release hold" : "Hold" })}<span>{layout.ambient ? ["OFF", "INFINITE", "FREEZE"][Math.round(value(layout.hold))] : held ? "TEXTURE SUSTAINED" : "INFINITE / FREEZE"}</span></div> : <span className="reverb-engine-mark">{layout.type === 7 ? "IR / SPACE" : "REVERB / SPACE"}</span>}
        </header>
        <div className="reverb-primary grid shrink-0 items-center">
          <div className="reverb-predelay flex min-w-0 flex-col items-center gap-2">{render({ id: value(layout.sync) >= .5 ? layout.division : layout.time, label: layout.spatial ? "Input echo" : "Pre-delay" })}{render({ id: layout.sync, label: "Sync" })}</div>
          <div className="reverb-decay min-w-0 text-center">{layout.type === 7 ? <div className="reverb-ir-identity"><span>APPLIED RESPONSE</span><strong>{schema.impulseResponse ? (schema.impulseResponse.processedDuration ?? schema.impulseResponse.trimSeconds).toFixed(2) : "—"}<small> s</small></strong><p className="truncate" title={schema.impulseResponse?.name}>{schema.impulseResponse?.name ?? "No response available"}</p><button className={editorButton} onClick={() => setSelectedPage("character")}>Shape IR</button></div> : render(layout.primary, true)}<span className="reverb-tick-caption">{layout.type === 7 ? "IR SHAPING BELOW" : layout.type === 16 ? "ROOM GEOMETRY" : layout.type === 6 ? "EARLY ENVELOPE" : layout.type === 14 ? "DIFFUSE RETURN" : layout.type === 15 ? "REPEAT TIME" : "REVERBERATION TIME"}</span></div>
          {layout.shape.map(control => render(control))}{render("width")}
        </div>
        <section className="reverb-character flex min-h-0 flex-1 flex-col" aria-label="Reverb details">
          <div className="reverb-detail-tabs flex shrink-0 overflow-x-auto" role="tablist" aria-label="Reverb detail pages">{pages.map((item, index) => <button type="button" key={item.id} role="tab" id={`${tabPrefix}-${item.id}`} aria-controls={`${tabPrefix}-panel`} aria-selected={page.id === item.id} tabIndex={page.id === item.id ? 0 : -1} title={modified(item.controls) ? `${item.label}: modified settings` : item.label} onClick={() => selectPage(item.id)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + pages.length) % pages.length; selectPage(pages[next].id); document.getElementById(`${tabPrefix}-${pages[next].id}`)?.focus(); } }}>{item.label}{modified(item.controls) && <i aria-label="Modified" />}</button>)}</div>
          <div className="reverb-context-body min-h-0 flex-1 overflow-y-auto" id={`${tabPrefix}-panel`} role="tabpanel" aria-labelledby={`${tabPrefix}-${page.id}`}>
            {page.id === "character" && layout.type === 7 ? <ImpulseResponseEditor schema={schema} address={address} onApplyState={props.onApplyState} /> : page.id === "meters" ? <ReverbTelemetry schema={schema} address={address} onChange={props.onChange} detailed /> : page.id === "response" ? <ReverbResponsePanel schema={schema} address={address} /> : <>
              <div className="reverb-detail-controls flex flex-wrap items-center justify-evenly gap-x-5 gap-y-4">{page.controls.map(control => render(control))}</div>
              {page.help && <details className="reverb-help"><summary>About {page.label.toLowerCase()}</summary><p>{page.help}</p></details>}
            </>}
          </div>
          {held && <p className="reverb-held-note shrink-0" role="status">Hold is active. Some machine controls take effect after release.</p>}
        </section>
        <footer className="reverb-output flex shrink-0 items-center justify-between gap-4">
          <div className="reverb-output-routing min-w-0"><span className="reverb-output-label">OUTPUT</span><div className="mt-2 flex gap-2">{render({ id: "sendMode", label: "Send mode" })}{render({ id: "mixLock", label: "Lock balance" })}</div></div>
          <div className="reverb-levels flex shrink-0 gap-5" inert={send} aria-disabled={send} title={send ? "Send mode is 100% wet. Disable it to restore the saved insert balance." : undefined}>{render("dryLevel")}{render("wetLevel")}</div>
          <div className="reverb-spill text-center">{render("tailSpillover")}<span>{send ? "100% WET / SEND" : "CONTINUOUS TAILS"}</span></div>
        </footer>
        {page.id !== "meters" && <ReverbTelemetry schema={schema} address={address} onChange={props.onChange} />}
      </main>
    </div>
  </div>;
}
