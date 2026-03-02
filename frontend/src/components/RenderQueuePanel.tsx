import { X, Trash2, Play, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { useDAWStore, RenderJob } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button } from "./ui";

function StatusIcon({ status }: { status: RenderJob["status"] }) {
  switch (status) {
    case "pending":
      return <Clock size={14} className="text-neutral-400" />;
    case "rendering":
      return <div className="w-3.5 h-3.5 border-2 border-daw-accent border-t-transparent rounded-full animate-spin" />;
    case "done":
      return <CheckCircle size={14} className="text-green-400" />;
    case "error":
      return <AlertCircle size={14} className="text-red-400" />;
  }
}

export function RenderQueuePanel() {
  const {
    renderQueue, removeFromRenderQueue, clearRenderQueue,
    executeRenderQueue, toggleRenderQueue,
  } = useDAWStore(useShallow((s) => ({
    renderQueue: s.renderQueue,
    removeFromRenderQueue: s.removeFromRenderQueue,
    clearRenderQueue: s.clearRenderQueue,
    executeRenderQueue: s.executeRenderQueue,
    toggleRenderQueue: s.toggleRenderQueue,
  })));

  const pendingCount = renderQueue.filter((j) => j.status === "pending").length;
  const isRunning = renderQueue.some((j) => j.status === "rendering");

  return (
    <div className="flex flex-col w-80 max-h-96 bg-daw-panel border border-daw-border rounded shadow-lg text-sm text-daw-text">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-daw-border">
        <h3 className="text-xs font-semibold uppercase text-daw-text-muted">
          Render Queue ({renderQueue.length})
        </h3>
        <Button variant="ghost" size="icon-sm" onClick={toggleRenderQueue}>
          <X size={14} />
        </Button>
      </div>

      {/* Queue List */}
      <div className="flex-1 overflow-y-auto">
        {renderQueue.length === 0 ? (
          <div className="px-3 py-4 text-daw-text-muted text-xs text-center">
            No jobs in queue. Use "Add to Queue" in the Render dialog.
          </div>
        ) : (
          renderQueue.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-2 px-3 py-1.5 border-b border-daw-border/50 hover:bg-daw-darker/50"
            >
              <StatusIcon status={job.status} />
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">
                  {job.options.fileName}.{job.options.format}
                </div>
                <div className="text-[10px] text-daw-text-muted">
                  {job.options.source} / {job.options.channels} / {job.options.bitDepth}bit
                </div>
              </div>
              {job.status === "error" && (
                <span className="text-[10px] text-red-400 truncate max-w-20" title={job.error}>
                  {job.error}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => removeFromRenderQueue(job.id)}
                disabled={job.status === "rendering"}
                title="Remove"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-daw-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={clearRenderQueue}
          disabled={isRunning || renderQueue.length === 0}
        >
          Clear All
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void executeRenderQueue()}
          disabled={isRunning || pendingCount === 0}
        >
          <Play size={12} className="mr-1" />
          {isRunning ? "Rendering..." : `Render ${pendingCount} Job${pendingCount !== 1 ? "s" : ""}`}
        </Button>
      </div>
    </div>
  );
}
