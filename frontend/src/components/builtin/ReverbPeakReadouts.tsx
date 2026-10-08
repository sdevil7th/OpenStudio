import { editorSelect } from "./PluginEditorControls";
import { useState } from "react";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../../services/NativeBridge";

export function ReverbPeakReadouts({ visualization, address, reconstructed = false, onReconstructionChange }: { visualization: BuiltInPluginSchema["visualization"]; address: BuiltInPluginAddress; reconstructed?: boolean; onReconstructionChange?: (enabled: boolean) => void }) {
  const [held, setHeld] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const heldInput = reconstructed ? visualization?.heldInputTruePeaksDb : visualization?.heldInputPeaksDb;
  const heldOutput = reconstructed ? visualization?.heldOutputTruePeaksDb : visualization?.heldOutputPeaksDb;
  const input = held ? heldInput : reconstructed ? visualization?.inputTruePeaksDb : visualization?.inputPeaksDb;
  const output = held ? heldOutput : reconstructed ? visualization?.outputTruePeaksDb : visualization?.outputPeaksDb;
  const overloaded = [...(heldInput ?? []), ...(heldOutput ?? [])].some(db => Number.isFinite(db) && db >= 0);
  const reset = async () => {
    if (busy) return; setBusy(true); setError("");
    try { if (!await nativeBridge.setBuiltInPluginParam(address, "peakHoldReset", 1)) throw new Error("Peak reset unavailable"); }
    catch { setError("Peak reset unavailable"); }
    finally { setBusy(false); }
  };
  return <div className="w-full text-center text-[10px] tabular-nums">
    {onReconstructionChange && <select className={`${editorSelect} mb-1 w-full text-[10px]`} aria-label="Reverb peak measurement" value={reconstructed ? "reconstructed" : "sample"} onChange={event => onReconstructionChange(event.target.value === "reconstructed")}><option value="sample">Sample</option><option value="reconstructed">8x peak</option></select>}
    <span className="text-daw-text-muted" title={reconstructed ? "Finite reconstruction estimate; not a certified true-peak meter. Adds no audio latency." : undefined}>{reconstructed ? "Peak estimate / dBTP" : "Sample peaks / dBFS"}</span>
    <button className="mt-1 w-full rounded border border-daw-border-light px-1 py-1 text-[10px] hover:bg-daw-dark focus-visible:outline-2 focus-visible:outline-daw-accent" aria-label="Reverb maximum peak view" aria-pressed={held} onClick={() => setHeld(!held)}>{held ? "Maximum" : "Current"}</button>
    <table className="mt-1 w-full text-right" aria-label={reconstructed ? "Reverb input and output reconstructed peaks" : "Reverb input and output sample peaks"}><thead className="text-daw-text-muted"><tr><th className="font-normal" /><th className="font-normal">L</th><th className="font-normal">R</th></tr></thead><tbody>{[["In", input], ["Out", output]].map(([label, readings]) => <tr key={String(label)}><th className="text-left font-normal text-daw-text-muted">{String(label)}</th>{[0, 1].map(channel => {
      const db = Array.isArray(readings) ? readings[channel] : undefined;
      return <td key={channel} aria-label={`Reverb ${label} ${channel ? "R" : "L"} peak`} className={typeof db === "number" && db >= 0 ? "text-daw-record" : ""}>{typeof db === "number" && Number.isFinite(db) && db > -99 ? db.toFixed(1) : "\u2014"}</td>;
    })}</tr>)}</tbody></table>
    {overloaded && <span className="mt-1 block text-daw-record" role="status">{reconstructed ? "0 dBTP reached" : "0 dBFS reached"}</span>}
    <button className="mt-1 w-full rounded border border-daw-border-light px-1 py-1 text-[10px] hover:bg-daw-dark disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-daw-accent" disabled={busy || visualization?.peakResetPending} onClick={() => { void reset(); }} title="Clear maxima on the next audio block; no audio or saved settings change">Reset peaks</button>
    {visualization?.peakResetPending && <span className="mt-1 block text-daw-text-muted" role="status">Reset on next audio block</span>}
    {error && <span className="mt-1 block text-daw-text-muted" role="status">{error}</span>}
  </div>;
}
