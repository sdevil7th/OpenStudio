import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Power, Redo2, Save, Settings2, Undo2 } from "lucide-react";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";
import { Modal } from "../ui";
import { EQPresetBrowser, eqSettingsClipboardKey } from "./EQPresetBrowser";

export type { PluginEditorToolbarProps as EQToolbarProps } from "./PluginEditorContracts";
import type { PluginEditorToolbarProps as EQToolbarProps } from "./PluginEditorContracts";
export const eqValues = (schema: BuiltInPluginSchema) => Object.fromEntries(schema.parameters.filter(p => p.type !== "meter").map(p => [p.id, p.value]));
export const capturePluginState = async (address: BuiltInPluginAddress) => {
  const state = await nativeBridge.getBuiltInPluginState(address);
  return JSON.stringify(state.fullState ? { name: state.name, fullState: state.fullState } : { name: state.name, values: state.values, modelState: state.modelState });
};
const equalValues = (a: Record<string, number>, b: Record<string, number>) => Object.keys(a).every(id => Math.abs(a[id] - b[id]) < 1e-5) && Object.keys(a).length === Object.keys(b).length;

export function EQToolbar({ schema, address, canUndo, canRedo, onUndo, onRedo, onApplyValues, onApplyState, onRecallPreset, onFlush, onHostBypass }: EQToolbarProps) {
  const [presets, setPresets] = useState<string[]>([]);
  const [preset, setPreset] = useState("");
  const [savedValues, setSavedValues] = useState<Record<string, number> | null>(Object.fromEntries(schema.parameters.filter(p => p.type !== "meter").map(p => [p.id, p.defaultValue])));
  const [compare, setCompare] = useState<"A" | "B">("A");
  const slots = useRef<{ A: string | null; B: string | null }>({ A: null, B: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedProgramMap, setSavedProgramMap] = useState("");
  const [savedIR, setSavedIR] = useState<string | null>(null);
  const irFingerprint = schema.impulseResponse ? JSON.stringify(schema.impulseResponse) : null;
  const [saveOpen, setSaveOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [fileMessage, setFileMessage] = useState("");
  const [name, setName] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void nativeBridge.getBuiltInFXPresets(schema.name).then(list => { if (mounted.current) setPresets(list.map(p => p.name)); }).catch(() => { if (mounted.current) setError("Could not read presets"); });
    return () => { mounted.current = false; };
  }, [schema.name]);
  useEffect(() => {
    let retired = false;
    void capturePluginState(address).then(snapshot => {
      if (!retired) { if (slots.current.A === null) slots.current.A = snapshot; if (slots.current.B === null) slots.current.B = snapshot; }
    }).catch(() => { if (!retired) setError("Could not capture comparison state"); });
    return () => { retired = true; };
  }, [address.trackId, address.chain, address.fxIndex]);
  const current = eqValues(schema);
  const run = async (operation: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { if (!await operation()) throw new Error("The processor did not accept the change"); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Operation failed"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const recall = (next: string) => void run(async () => {
    const ok = next === "" ? await onApplyState(JSON.stringify({ factoryDefault: true })) : await onRecallPreset(next);
    if (ok) { const readback = await nativeBridge.getBuiltInPluginSchema(address); if (mounted.current) { setPreset(next); setSavedValues(eqValues(readback)); setSavedProgramMap(readback.midiPrograms?.fingerprint ?? ""); setSavedIR(readback.impulseResponse ? JSON.stringify(readback.impulseResponse) : null); } }
    return ok;
  });
  const switchCompare = (next: "A" | "B") => void run(async () => {
    if (next === compare) return true;
    if (!await onFlush()) return false;
    const snapshot = await capturePluginState(address);
    slots.current[compare] = snapshot;
    if (slots.current[next] === null) slots.current[next] = snapshot;
    const ok = await onApplyState(slots.current[next]!);
    if (ok && mounted.current) setCompare(next);
    return ok;
  });
  const fileAction = (action: "folder" | "import" | "export") => void run(async () => {
    setFileMessage("");
    if (action === "folder") {
      const result = await nativeBridge.builtInPresetFile(schema.name, action);
      if (!result.success || !result.path || !await nativeBridge.openFileExternal(result.path))
        throw new Error(result.error ?? "Preset folder could not be opened");
      return true;
    }
    if (action === "import") {
      const path = await nativeBridge.browseForFile(`Import ${schema.name} preset`, "*.ospreset");
      if (!path) return true;
      const result = await nativeBridge.builtInPresetFile(schema.name, action, { path });
      if (!result.success || !result.state) throw new Error(result.error ?? "Preset could not be read");
      if (!await onApplyState(JSON.stringify(result.state))) return false;
      setFileMessage("Preset imported. Undo restores the previous settings.");
      return true;
    }
    if (!await onFlush()) return false;
    const state = JSON.parse(await capturePluginState(address));
    if (typeof state.fullState !== "string") throw new Error("Complete native settings are unavailable");
    const path = await nativeBridge.showSaveDialog(`${schema.name}.ospreset`, "Export plugin settings", "*.ospreset", true);
    if (!path) return true;
    const result = await nativeBridge.builtInPresetFile(schema.name, action, { path, fullState: state.fullState, overwrite: true });
    if (!result.success) throw new Error(result.error ?? "Preset could not be exported");
    setFileMessage("Complete preset exported, including embedded assets.");
    return true;
  });
  const index = presets.indexOf(preset);
  const dirty = savedProgramMap !== (schema.midiPrograms?.fingerprint ?? "") || (savedValues !== null && !equalValues(savedValues, current)) || (savedIR !== null ? savedIR !== irFingerprint : Boolean(schema.impulseResponse && (schema.impulseResponse.name !== "Studio room (generated)" || Math.abs(schema.impulseResponse.trimSeconds - 1.2) > .0001)));
  const bypass = schema.parameters.find(p => p.id === "bypass");
  return <div className="relative flex min-h-12 shrink-0 items-center gap-2 border-b border-daw-border-light bg-daw-panel px-3 py-2 text-xs" aria-label="Plugin toolbar">
    <button className={editorButton} title="Previous preset" aria-label="Previous preset" disabled={busy || presets.length === 0} onClick={() => recall(presets[index < 0 ? presets.length - 1 : (index - 1 + presets.length) % presets.length])}><ChevronLeft size={14} /></button>
    <select className={`${editorSelect} min-w-0 w-48`} aria-label="Preset" disabled={busy} value={preset} onChange={e => recall(e.target.value)}><option value="">Default{preset === "" && dirty ? " *" : ""}</option>{presets.map(p => <option key={p} value={p}>{p}{p === preset && dirty ? " *" : ""}</option>)}</select>
    <button className={editorButton} title="Next preset" aria-label="Next preset" disabled={busy || presets.length === 0} onClick={() => recall(presets[(index + 1) % presets.length])}><ChevronRight size={14} /></button>
    <button className={editorButton} aria-label="Save preset" title="Save preset" disabled={busy} onClick={() => { setName(""); setSaveOpen(!saveOpen); }}><Save size={14} /></button>
    {schema.pluginId === "eq" && <button className={editorButton} aria-label="Browse EQ presets" title="Browse EQ presets" disabled={busy} onClick={() => setLibraryOpen(true)}>…</button>}
    <button className={editorButton} aria-label="Plugin options" title="Preset files and saved processor bypass" disabled={busy} onClick={() => { setFileMessage(""); setOptionsOpen(true); }}><Settings2 size={14} /></button>
    <span className="min-w-0 flex-1 truncate text-[10px] text-daw-text-muted" role="status" title={error}>{error || (busy ? "Applying…" : dirty ? "Modified" : "")}</span>
    <button className={editorButton} disabled={busy || !canUndo} onClick={onUndo} aria-label="Undo" title="Undo"><Undo2 size={14} /></button><button className={editorButton} disabled={busy || !canRedo} onClick={onRedo} aria-label="Redo" title="Redo"><Redo2 size={14} /></button>
    <div className="flex shrink-0 gap-1 whitespace-nowrap" aria-label="Compare"><button className={editorButton} disabled={busy} aria-pressed={compare === "A"} onClick={() => switchCompare("A")}>A</button><button className={editorButton} disabled={busy} aria-pressed={compare === "B"} onClick={() => switchCompare("B")}>B</button><button className={editorButton} disabled={busy} title={`Copy ${compare} to ${compare === "A" ? "B" : "A"}`} onClick={() => void run(async () => { if (!await onFlush()) return false; slots.current[compare === "A" ? "B" : "A"] = await capturePluginState(address); return true; })}>{compare === "A" ? "A → B" : "B → A"}</button></div>
    {onHostBypass && typeof schema.hostBypassed === "boolean" ? <button className={`${editorButton} ml-1`} disabled={busy}
      aria-label="Host bypass" aria-pressed={schema.hostBypassed} title="Bypass this FX slot"
      onClick={() => void run(() => onHostBypass(!schema.hostBypassed))}><Power size={14} /><span>{schema.hostBypassed ? "Bypassed" : bypass && bypass.value >= .5 ? "DSP bypass" : "Active"}</span></button> : bypass && <button className={`${editorButton} ml-1`} disabled={busy} aria-label={schema.pluginId === "eq" ? "Bypass equalizer" : "Bypass processor"} aria-pressed={bypass.value >= .5} title="Bypass" onClick={() => void run(() => onApplyValues({ bypass: bypass.value >= .5 ? 0 : 1 }))}><Power size={14} /><span>{bypass.value >= .5 ? "Bypassed" : "Active"}</span></button>}
    {optionsOpen && <Modal isOpen title="Plugin options" size="sm" onClose={() => setOptionsOpen(false)}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-2"><button className={editorButton} disabled={busy} onClick={() => fileAction("import")}>Import preset</button><button className={editorButton} disabled={busy} onClick={() => fileAction("export")}>Export current</button><button className={editorButton} disabled={busy} onClick={() => fileAction("folder")}>Preset folder</button></div>
        <p className="text-xs text-daw-text-muted">Complete settings include hidden controls and embedded assets. Import is one undoable change; Host bypass stays separate.</p>
        {bypass && <label className="flex items-start gap-3"><input type="checkbox" aria-label="Saved processor bypass" checked={bypass.value >= .5} disabled={busy} onChange={event => void run(() => onApplyValues({ bypass: event.target.checked ? 1 : 0 }))} /><span>Saved processor bypass<small className="mt-1 block text-daw-text-muted">Stored in this plugin's presets and Compare. Turn it off to reactivate processing when the toolbar shows DSP bypass.</small></span></label>}
        {(error || fileMessage) && <p role={error ? "alert" : "status"} className="text-xs">{error || fileMessage}</p>}
      </div>
    </Modal>}
    {saveOpen && <form className="absolute top-full left-3 z-30 mt-1 flex w-80 flex-col gap-3 rounded border border-daw-border-light bg-daw-panel p-4 shadow-xl" aria-label="Save EQ preset" onSubmit={e => { e.preventDefault(); void run(async () => {
      const trimmed = name.trim();
      if (!trimmed || presets.includes(trimmed)) throw new Error("Choose a new preset name");
      if (!await onFlush()) return false;
      const snapshot = await nativeBridge.getBuiltInPluginSchema(address);
      const route = await nativeBridge.resolveBuiltInAddress(address);
      const ok = await nativeBridge.saveBuiltInFXPreset(route.trackId ?? "", route.fxIndex ?? -1, route.chain === "input", trimmed, route.chain);
      if (ok && mounted.current) { setPresets(previous => [...previous, trimmed]); setPreset(trimmed); setSavedValues(eqValues(snapshot)); setSavedProgramMap(snapshot.midiPrograms?.fingerprint ?? ""); setSavedIR(snapshot.impulseResponse ? JSON.stringify(snapshot.impulseResponse) : null); setSaveOpen(false); }
      return ok;
    }); }}><label className="flex flex-col gap-2">Preset name<input autoFocus maxLength={80} className={editorSelect} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setSaveOpen(false); } }} /></label><div className="flex justify-end gap-2"><button type="button" className={editorButton} onClick={() => setSaveOpen(false)}>Cancel</button><button className={editorButton} type="submit" disabled={busy || !name.trim()}>Save</button></div></form>}
    {libraryOpen && <EQPresetBrowser programs={schema.midiPrograms} onProgramEdit={async edit => await onFlush() && await onApplyState(JSON.stringify({ eqMidiProgram: edit }))} presets={presets} selected={preset} busy={busy} onClose={() => setLibraryOpen(false)}
      onRecall={recall} onRefresh={async () => { setPresets((await nativeBridge.getBuiltInFXPresets(schema.name)).map(item => item.name)); return true; }}
      onFileAction={async action => {
        if (action === "import") {
          const path = await nativeBridge.browseForFile("Import OpenStudio EQ preset", "*.ospreset"); if (!path) return null;
          const result = await nativeBridge.eqPresetLibrary("import", { path });
          if (!result.success || !result.state) throw new Error(result.error ?? "Preset could not be read");
          if (!await onApplyState(JSON.stringify(result.state))) throw new Error("EQ did not accept the preset");
          return "Preset imported; Undo restores the previous EQ";
        }
        if (action === "folder") {
          const result = await nativeBridge.eqPresetLibrary("folder");
          if (!result.success || !result.path || !await nativeBridge.openFileExternal(result.path)) throw new Error(result.error ?? "Preset folder could not be opened");
          return "Preset folder opened";
        }
        if (action === "clearStartup") {
          const result = await nativeBridge.eqPresetLibrary(action); if (!result.success) throw new Error(result.error ?? "Startup settings could not be cleared");
          return "New EQs will use factory settings";
        }
        if (!await onFlush()) throw new Error("Finish the current edit before saving");
        const state = JSON.parse(await capturePluginState(address));
        if (typeof state.fullState !== "string") throw new Error("Complete native EQ settings are unavailable");
        const path = action === "export" ? await nativeBridge.showSaveDialog("OpenStudio EQ.ospreset", "Export EQ settings", "*.ospreset", true) : undefined;
        if (action === "export" && !path) return null;
        const result = await nativeBridge.eqPresetLibrary(action, { fullState: state.fullState, path, overwrite: action === "export" });
        if (!result.success) throw new Error(result.error ?? "EQ settings could not be saved");
        return action === "export" ? "Complete EQ preset exported" : "Current settings saved for newly added EQs";
      }}
      onCopy={async () => {
        if (!await onFlush()) return false;
        const state = await capturePluginState(address);
        localStorage.setItem(eqSettingsClipboardKey, JSON.stringify({ pluginId: "eq", state })); return true;
      }}
      onPaste={async () => {
        const raw = localStorage.getItem(eqSettingsClipboardKey);
        if (!raw || raw.length > 8 * 1024 * 1024) throw new Error("Copy EQ settings first");
        const clipboard = JSON.parse(raw);
        if (clipboard.pluginId !== "eq" || typeof clipboard.state !== "string") throw new Error("Clipboard does not contain EQ settings");
        const state = JSON.parse(clipboard.state);
        if (!state || typeof state !== "object" || state.name !== schema.name || (typeof state.fullState !== "string" && (!state.values || typeof state.values !== "object"))) throw new Error("Invalid EQ settings");
        return onApplyState(clipboard.state);
      }} />}
  </div>;
}
