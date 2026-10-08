import { editorButton, editorSelect } from "./PluginEditorControls";
import { useState } from "react";
import type { EQMIDIProgramInfo } from "../../services/NativeBridge";

export function EQMIDIPrograms({ info, busy, onEdit }: { info: EQMIDIProgramInfo; busy: boolean; onEdit: (edit: Record<string, unknown>) => Promise<boolean> }) {
  const [bank, setBank] = useState(0), [program, setProgram] = useState(0), [name, setName] = useState("EQ setting");
  const [working, setWorking] = useState(false), [message, setMessage] = useState("");
  const run = async (edit: Record<string, unknown>) => {
    if (busy || working) return;
    setWorking(true); setMessage("");
    try { setMessage(await onEdit(edit) ? "Program map saved; Undo restores the previous map" : "Stop playback/recording before editing the program map. The previous map is retained."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Program-map edit failed"); }
    finally { setWorking(false); }
  };
  const disabled = busy || working;
  return <div className="flex min-h-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={info.enabled} disabled={disabled} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void run({ action: "configure", enabled: !info.enabled, channel: info.channel }); } }} onChange={event => void run({ action: "configure", enabled: event.target.checked, channel: info.channel })} />Enable MIDI program recall</label>
      <label className="flex items-center gap-2">Channel<select className={editorSelect} aria-label="EQ program MIDI channel" value={info.channel} disabled={disabled} onChange={event => void run({ action: "configure", enabled: info.enabled, channel: Number(event.target.value) })}><option value={0}>Omni</option>{Array.from({ length: 16 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex w-24 flex-col gap-1">Bank<input className={`${editorSelect} w-full`} aria-label="EQ MIDI bank" type="number" min={0} max={16383} step={1} value={bank} onChange={event => setBank(Math.max(0, Math.min(16383, Math.round(Number(event.target.value)))))} /></label>
      <label className="flex w-24 flex-col gap-1">Program<input className={`${editorSelect} w-full`} aria-label="EQ MIDI program" type="number" min={0} max={127} step={1} value={program} onChange={event => setProgram(Math.max(0, Math.min(127, Math.round(Number(event.target.value)))))} /></label>
      <label className="flex min-w-32 flex-1 flex-col gap-1">Name<input className={`${editorSelect} w-full`} aria-label="EQ MIDI program name" maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
      <button className={editorButton} disabled={disabled || (info.entries.length >= info.capacity && !info.entries.some(entry => entry.bank === bank && entry.program === program))} onClick={() => void run({ action: "capture", bank, program, name })}>Capture current EQ</button>
    </div>
    <div className="flex max-h-44 min-h-16 flex-col gap-1 overflow-y-auto" aria-label="EQ MIDI program map">
      {!info.entries.length && <p>No programs captured. Load or edit an EQ setting, then capture its bank/program address.</p>}
      {info.entries.map(entry => <div className="flex min-w-0 items-center gap-2" key={`${entry.bank}/${entry.program}`}><button className={`${editorButton} min-w-0 flex-1 truncate text-left`} onClick={() => { setBank(entry.bank); setProgram(entry.program); setName(entry.name); }} title={entry.name}>{entry.bank}/{entry.program} {entry.name}{entry.compatible ? "" : " (configuration differs)"}</button><button className={editorButton} disabled={disabled} aria-label={`Remove EQ program ${entry.bank}/${entry.program}`} onClick={() => void run({ action: "remove", bank: entry.bank, program: entry.program })}>Remove</button></div>)}
    </div>
    {info.preparedConfigurations && <p className="text-xs text-daw-accent">Prepared configuration bank: {info.reservedLatency ?? 0} samples of fixed latency. Only the current and incoming settings process audio.</p>}
    <p className="text-xs text-daw-text-muted">Stop transport to edit this map. Disable recall before changing processing configuration.</p>
    <details className="text-xs leading-relaxed text-daw-text-muted"><summary className="cursor-pointer py-1">Recall behavior and MIDI addresses</summary><p className="pt-2">Up to {info.capacity} snapshots travel with this project, preset and Compare state. Numbers use MIDI's 0-based convention. Bank = CC0 x 128 + CC32, followed by Program Change. Different phase, quality, spectral and key-input configurations are prepared when recall is enabled. The bank reserves the largest latency; changes warm up and crossfade over 20 ms. Rapid recalls finish an audible fade before starting the latest target.</p></details>
    <p role="status">{message && `${message}. `}{info.restoreRejected ? "An invalid saved program map was disabled" : info.lastStatus ? `MIDI ${info.lastBank}/${info.lastProgram} on channel ${info.lastChannel}: ${info.lastStatus === 1 ? "recalled" : info.lastStatus === 2 ? "unmapped" : "configuration differs; unchanged"}` : "Waiting for a mapped MIDI program change"}</p>
  </div>;
}
