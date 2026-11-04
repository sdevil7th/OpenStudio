import { useShallow } from "zustand/react/shallow";
import { useDAWStore } from "../store/useDAWStore";

export function AudioConversionStatus() {
  const { jobs, cancel } = useDAWStore(useShallow(state => ({
    jobs: state.audioConversionJobs, cancel: state.cancelProjectRateCopy,
  })));
  const entries = Object.entries(jobs);
  if (!entries.length) return null;
  return <div className="fixed bottom-20 right-4 z-[9500] flex max-h-[60vh] max-w-sm flex-col gap-2 overflow-y-auto overscroll-contain" role="region" aria-label="Audio conversion progress">
    {entries.map(([clipId, job]) => <div key={clipId}
      className="flex items-center gap-3 rounded-lg border border-daw-border bg-daw-panel px-3 py-2 text-xs text-daw-text shadow-lg">
      <span role="status" className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={job.label ?? clipId}>{job.label ?? clipId}</span>
        {job.stage === "cancelling" ? "Cancelling audio copy…" : job.stage === "publishing" ? "Applying audio source…" : `Creating ${job.targetRate / 1000} kHz audio copy…`}
      </span>
      <button type="button" onClick={() => cancel(clipId)} disabled={job.stage !== "converting"}
        aria-label={`Cancel ${job.targetRate / 1000} kHz audio copy: ${job.label ?? clipId}`}
        className="rounded border border-daw-border px-2 py-1 hover:bg-daw-dark focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50">
        Cancel
      </button>
    </div>)}
  </div>;
}
