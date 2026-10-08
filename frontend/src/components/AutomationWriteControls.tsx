import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";

export function AutomationWriteControls() {
  const {enabled,pending,playing,locked,toggle,write}=useDAWStore(useShallow(state => ({
    enabled:state.automationAutoJoinEnabled ?? false,pending:state.automationJoinSession,playing:state.transport.isPlaying || state.transport.isRecording,
    locked:state.globalLocked || state.lockSettings.envelopes,toggle:state.setAutomationAutoJoin,write:state.writeAutomationToBoundary,
  })));
  return <details className="mt-3 rounded border border-neutral-700 p-2 text-[11px]">
    <summary className="cursor-pointer focus-visible:outline focus-visible:outline-daw-accent">Writing &amp; AutoJoin</summary>
    <p className="mt-2 text-neutral-400">These commands affect controls currently writing. Write to end extends to the last clip or envelope point in the project. Both extensions belong to the current pass and undo with that pass.</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" disabled={locked || !playing} onClick={() => write("start")} className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Write to start</button>
      <button type="button" disabled={locked || !playing} onClick={() => write("end")} className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Write to end</button>
      <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={enabled} disabled={locked || playing} onChange={event => toggle(event.target.checked)} />AutoJoin latched controls</label>
    </div>
    <p className="mt-2 text-neutral-400">Restart playback before the last stop point to resume its latched values there. Touch controls do not rejoin. Editing a captured curve, Safe, a replaced parameter, or a new project cancels that control's join.</p>
    {pending && <p className="mt-2 text-sky-300" role="status">{pending.prepared ? "AutoJoin scheduled" : "AutoJoin ready"} at {pending.time.toFixed(3)} s for {pending.entries.length} control{pending.entries.length === 1 ? "" : "s"}.</p>}
  </details>;
}
