import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useState } from "react";
import { Modal } from "../ui";
import { nativeBridge, type EQMIDIProgramInfo } from "../../services/NativeBridge";
import { EQMIDIPrograms } from "./EQMIDIPrograms";
export type EQPresetFileAction = "folder" | "import" | "export" | "saveStartup" | "clearStartup";

type Metadata = { favorite?: boolean; folder?: string; tags?: string; author?: string; notes?: string };
const metadataKey = "openstudio.eq.presetMetadata";
export const eqSettingsClipboardKey = "openstudio.eq.settingsClipboard";
function readMetadata(): Record<string, Metadata> {
  try {
    const source = JSON.parse(localStorage.getItem(metadataKey) ?? "{}");
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};
    return Object.fromEntries(Object.entries(source).slice(0, 2048).filter(([, value]) => value && typeof value === "object").map(([name, value]) => {
      const data = value as Record<string, unknown>;
      return [name, { favorite: data.favorite === true, ...Object.fromEntries(["folder", "tags", "author", "notes"].map(key => [key, typeof data[key] === "string" ? data[key].slice(0, key === "notes" ? 1000 : 160) : ""])) }];
    }));
  } catch { return {}; }
}

export function EQPresetBrowser({ presets, selected, busy, onRecall, onCopy, onPaste, onRefresh, onFileAction, onClose, programs, onProgramEdit }: {
  programs?: EQMIDIProgramInfo; onProgramEdit: (edit: Record<string, unknown>) => Promise<boolean>;
  presets: string[]; selected: string; busy: boolean; onRecall: (name: string) => void;
  onFileAction: (action: EQPresetFileAction) => Promise<string | null>;
  onCopy: () => Promise<boolean>; onPaste: () => Promise<boolean>; onRefresh: () => Promise<boolean>; onClose: () => void;
}) {
  const [metadata, setMetadata] = useState(readMetadata);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [focused, setFocused] = useState(selected);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [startup, setStartup] = useState("");
  const [section, setSection] = useState<"library" | "files" | "midi">("library");
  const files = section === "files";
  useEffect(() => { let retired = false; void nativeBridge.eqPresetLibrary("status").then(result => { if (!retired) setStartup(result.success ? result.hasStartup ? "New EQs use your saved startup settings" : "New EQs use factory settings" : result.error ?? "Startup status unavailable"); }).catch(() => { if (!retired) setStartup("Startup status unavailable"); }); return () => { retired = true; }; }, []);
  const fileAction = async (action: EQPresetFileAction) => {
    if (busy || working) return;
    setWorking(true); setMessage("");
    try { const message = await onFileAction(action); if (message) { setMessage(message); if (action === "saveStartup" || action === "clearStartup") setStartup(action === "saveStartup" ? "New EQs use your saved startup settings" : "New EQs use factory settings"); } }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "Preset file operation failed"); }
    finally { setWorking(false); }
  };

  const update = (patch: Metadata) => setMetadata(previous => {
    const next = { ...previous, [focused]: { ...previous[focused], ...patch } };
    try { localStorage.setItem(metadataKey, JSON.stringify(next)); } catch { setMessage("Local details could not be saved"); }
    return next;
  });
  const run = async (operation: () => Promise<boolean>, success: string) => {
    if (busy || working) return;
    setWorking(true); setMessage("");
    try { setMessage(await operation() ? success : "The processor did not accept the operation"); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "Operation failed"); }
    finally { setWorking(false); }
  };
  const matches = ["", ...presets].filter(name => (!favorites || metadata[name]?.favorite) && [name || "Factory default", ...Object.values(metadata[name] ?? {})].join(" ").toLowerCase().includes(query.toLowerCase()));
  const details = metadata[focused] ?? {};
  return <Modal isOpen onClose={onClose} title="EQ preset library" size="lg">
    <div className="flex min-w-0 flex-col gap-3 p-4 text-xs">
      <div className="flex gap-2" role="tablist" aria-label="Preset library sections"><button className={editorButton} role="tab" aria-selected={section === "library"} onClick={() => setSection("library")}>Library</button><button className={editorButton} role="tab" aria-selected={files} onClick={() => setSection("files")}>Files & startup</button>{programs && <button className={editorButton} role="tab" aria-selected={section === "midi"} onClick={() => setSection("midi")}>MIDI programs</button>}</div>
      {section === "library" && <><div className="flex items-center gap-2"><input autoFocus className={`${editorSelect} min-w-0 flex-1`} aria-label="Find EQ preset" placeholder="Search names, folders, tags or notes" value={query} onChange={event => setQuery(event.target.value)} /><button className={editorButton} aria-pressed={favorites} onClick={() => setFavorites(!favorites)}>Favorites</button><button className={editorButton} disabled={busy || working} onClick={() => void run(onRefresh, "Library refreshed")}>Refresh</button></div>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
        <div className="flex max-h-52 min-h-24 min-w-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="EQ preset results">
          {matches.map(name => <button key={name} className={`${editorButton} w-full justify-start truncate text-left`} aria-pressed={focused === name} onClick={() => setFocused(name)} onDoubleClick={() => { if (!busy && !working) onRecall(name); }}>{metadata[name]?.favorite ? "★ " : ""}{name || "Factory default"}</button>)}
          {!matches.length && <p role="status">No matching presets</p>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2"><strong className="truncate" title={focused || "Factory default"}>{focused || "Factory default"}</strong><button className={editorButton} aria-label="Favorite selected preset" aria-pressed={Boolean(details.favorite)} onClick={() => update({ favorite: !details.favorite })}>★</button></div>
          {([['folder', 'Folder'], ['tags', 'Tags'], ['author', 'Author']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><span className="w-12 shrink-0">{label}</span><input className={`${editorSelect} min-w-0 flex-1`} aria-label={`Preset ${label.toLowerCase()}`} maxLength={160} value={details[key] ?? ""} onChange={event => update({ [key]: event.target.value })} /></label>)}
          <label className="flex flex-col gap-1">Notes<textarea className={`${editorSelect} min-h-12 resize-y`} aria-label="Preset notes" maxLength={1000} value={details.notes ?? ""} onChange={event => update({ notes: event.target.value })} /></label>
          <button className={editorButton} disabled={busy || working || (focused !== "" && !presets.includes(focused))} onClick={() => onRecall(focused)}>Load selected</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2"><button className={editorButton} disabled={busy || working} onClick={() => void run(onCopy, "Complete EQ settings copied")}>Copy settings</button><button className={editorButton} disabled={busy || working} onClick={() => void run(onPaste, "Settings pasted; Undo restores the previous EQ")}>Paste settings</button></div></>}
      {section === "midi" && programs && <EQMIDIPrograms info={programs} busy={busy || working} onEdit={onProgramEdit} />}
      {files && <><div className="flex flex-wrap items-center gap-2" aria-label="Native EQ preset files">{([['import', 'Import file'], ['export', 'Export current'], ['folder', 'Open preset folder'], ['saveStartup', 'Use current for new EQs'], ['clearStartup', 'Factory for new EQs']] as const).map(([action, label]) => <button key={action} className={editorButton} disabled={busy || working} onClick={() => void fileAction(action)}>{label}</button>)}</div>
      <p className="text-[10px] text-daw-text-muted">{startup}. Import applies one undoable edit; Export writes complete .ospreset settings. Startup choices affect newly added EQs, while projects and recalled presets retain their saved settings.</p></>}
      <p role="status">{message}</p>
      {section === "library" && <p className="text-[10px] leading-relaxed text-daw-text-muted">Selecting a name shows its details; Load applies it with Undo. Favorites and details stay in this browser profile. Copy/Paste transfers complete EQ settings between instances sharing this profile. Compare starts anew when navigating to another instance.</p>}
    </div>
  </Modal>;
}
