import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

export function RecordingFailureBanner() {
  const [failures, setFailures] = useState<Array<{ path: string; name: string }>>([]);
  useEffect(() => nativeBridge.onRecordingWriteFailure(entries => {
    const tracks = useDAWStore.getState().tracks;
    setFailures(current => [...current, ...entries.map(entry => ({
      path: entry.path, name: tracks.find(track => track.id === entry.trackId)?.name || entry.trackId,
    }))].slice(-20));
  }), []);
  if (!failures.length) return null;
  return <div role="alert" className="flex shrink-0 items-start gap-3 border-b border-red-700/60 bg-red-950 px-4 py-3 text-red-100">
    <AlertTriangle size={20} className="mt-0.5 shrink-0" />
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold">Recording storage failed</p>
      <p className="mt-1 text-xs leading-5">These takes stopped accepting audio. Other tracks and monitoring continue. Stop recording to finalize the available audio, then check the destination before starting another take.</p>
      <p className="mt-1 truncate text-xs" title={failures.map(entry => `${entry.name}: ${entry.path}`).join("\n")}>{failures.map(entry => entry.name).join(", ")}</p>
    </div>
    <Button size="sm" variant="ghost" onClick={() => setFailures([])}>Dismiss</Button>
  </div>;
}
