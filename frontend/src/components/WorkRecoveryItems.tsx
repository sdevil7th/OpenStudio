import { useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { nativeBridge, type WorkRecoveryEntry } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { aiRecoveryProblem, importRecoveredAudio, recoveryAlreadyImported, restartRecoveredAI, resumeRecoveredAIImport } from "../services/workRecovery";
import { Button, NativeSelect } from "./ui";

export function WorkRecoveryItems({ entries, busy, setBusy, remove }: {
  entries: WorkRecoveryEntry[]; busy: boolean; setBusy: (value: boolean) => void; remove: (id: string) => void;
}) {
  const { tracks } = useDAWStore(useShallow(state => ({ tracks: state.tracks })));
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<Record<string, string>>({});
  const [previewId, setPreviewId] = useState("");
  const running = useRef(false);
  if (!entries.length) return null;
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(String(error)); } finally { running.current = false; setBusy(false); }
  };
  const prepare = async (entry: WorkRecoveryEntry) => {
    if (entry.kind === "ai") {
      if (!entry.outputFile) throw new Error("There is no completed output to import");
      return entry.outputFile;
    }
    if (prepared[entry.id]) return prepared[entry.id];
    const result = await nativeBridge.workRecovery("repair", entry.id) as WorkRecoveryEntry;
    if (typeof result?.repairedPath !== "string" || !result.repairedPath || result.error)
      throw new Error(typeof result?.error === "string" ? result.error : "Could not repair this recording");
    setPrepared(current => ({ ...current, [entry.id]: result.repairedPath! }));
    return result.repairedPath;
  };
  return <div className="space-y-3 border-t border-daw-border pt-4">
    <h3 className="text-sm font-semibold text-daw-text">Recordings and AI work</h3>
    <p className="text-xs leading-5 text-daw-text-muted">Original files are retained. Recording repair recovers complete samples on disk, not input lost to a dropout or power failure. AI restart begins sampling again with the saved request and seed; it is not a step checkpoint.</p>
    <NativeSelect label="Import destination" value={target} onChange={value => setTarget(String(value))} disabled={busy}
      options={[{ value: "", label: "New audio track (included in undo)" }, ...tracks.map(track => ({ value: track.id, label: track.name }))]} fullWidth />
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {entries.map(entry => {
      const hasAudio = entry.kind === "recording" ? !entry.error && (entry.duration ?? 0) > 0 : !!entry.outputFile;
      const problem = entry.kind === "ai" ? aiRecoveryProblem(entry) : null;
      const imported = recoveryAlreadyImported(entry.id);
      return <section key={entry.id} className="min-w-0 space-y-2 rounded-lg border border-daw-border bg-daw-dark p-4">
        <h4 className="break-words text-sm font-medium text-daw-text">{entry.kind === "recording" ? "Interrupted recording" : "AI generation"} · {entry.projectName || entry.trackId || "Untitled"}</h4>
        <p className="break-all text-xs leading-5 text-daw-text-muted">{entry.kind === "recording" ? entry.path : `${entry.modelId} · ${entry.workflowId}`}</p>
        {entry.duration != null && <p className="text-xs text-daw-text-secondary">{entry.duration.toFixed(2)} seconds recoverable · {(entry.droppedSamples ?? 0)} known dropped samples · {(entry.ignoredTailBytes ?? 0)} incomplete tail bytes omitted</p>}
        {entry.error && <p className="break-words text-xs text-red-300">{entry.error}</p>}
        {entry.kind === "ai" && problem && !hasAudio && <p className="text-xs leading-5 text-amber-300">{problem}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => {
            if (previewId === entry.id) { await nativeBridge.stopPreview(); setPreviewId(""); }
            if (!await nativeBridge.workRecovery("dismiss", entry.id)) throw new Error("Could not dismiss this reminder");
            remove(entry.id);
          })}>Dismiss reminder</Button>
          {hasAudio && <>
            {entry.kind === "ai" && !problem && <Button variant="primary" size="sm" disabled={busy || imported} onClick={() => void run(async () => {
              await nativeBridge.stopPreview(); setPreviewId("");
              await resumeRecoveredAIImport(entry); remove(entry.id);
            })}>Resume original import</Button>}
            <Button size="sm" disabled={busy} onClick={() => void run(async () => {
              if (previewId === entry.id) { await nativeBridge.stopPreview(); setPreviewId(""); }
              else { if (!await nativeBridge.previewAudioFile(await prepare(entry))) throw new Error("Preview could not start"); setPreviewId(entry.id); }
            })}>{previewId === entry.id ? "Stop preview" : "Preview copy"}</Button>
            <Button variant="primary" size="sm" disabled={busy || imported} onClick={() => void run(async () => {
              await nativeBridge.stopPreview(); setPreviewId("");
              await importRecoveredAudio(entry, await prepare(entry), target);
              remove(entry.id);
            })}>{imported ? "Already imported" : "Import recovered audio"}</Button>
          </>}
          {entry.kind === "ai" && !hasAudio && <Button variant="primary" size="sm" disabled={busy || !!problem} onClick={() => void run(async () => {
            if (await restartRecoveredAI(entry)) remove(entry.id);
          })}>Restart generation</Button>}
        </div>
      </section>;
    })}
  </div>;
}
