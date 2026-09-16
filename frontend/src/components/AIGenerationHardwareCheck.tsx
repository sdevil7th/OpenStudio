import { useEffect, useRef, useState } from "react";
import { nativeBridge, type AIGenerationPreflight } from "../services/NativeBridge";
import { Button } from "./ui";

// Serialize checks across both generation surfaces. Ignore obsolete requests before
// starting their native probe so typing cannot queue multiple Torch processes.
let pendingCheck: Promise<unknown> = Promise.resolve();
const gib = (bytes: number | null) => bytes == null ? "Unknown" : `${(bytes / 1024 ** 3).toFixed(3)} GiB`;

export function AIGenerationHardwareCheck({ modelId, workflowId, params, enabled }: {
  modelId: string; workflowId: string; params: Record<string, unknown>; enabled: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; report?: AIGenerationPreflight }>({ key: "" });
  const requestKey = JSON.stringify({ modelId, workflowId, params });
  const latest = useRef(requestKey);
  latest.current = requestKey;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const run = async () => {
        if (cancelled || latest.current !== requestKey) return;
        setState({ key: requestKey });
        let report: AIGenerationPreflight;
        try {
          const request = JSON.parse(requestKey);
          report = await nativeBridge.getAIGenerationPreflight(request.modelId, request.workflowId, request.params);
        } catch {
          report = { status: "unavailable", memory: [], notes: ["Hardware check did not complete. Refresh to try again; generation still validates its requirements."] };
        }
        if (!cancelled && latest.current === requestKey) setState({ key: requestKey, report });
      };
      pendingCheck = pendingCheck.then(run, run);
    }, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [enabled, requestKey, refresh]);
  if (!enabled) return null;
  const report = state.key === requestKey ? state.report : undefined;
  const caution = report && report.status !== "ready";
  return (
    <section aria-label="Generation hardware check" className={`min-w-0 rounded border p-4 ${caution ? "border-amber-700/50 bg-amber-950/20" : "border-neutral-700 bg-neutral-950/40"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-daw-text">Hardware check{!report ? " — checking…" : caution ? " — review before generating" : " — estimated to fit"}</p>
        <Button variant="secondary" size="sm" onClick={() => { setState({ key: requestKey }); setRefresh((value) => value + 1); }} disabled={!report}>Refresh hardware check</Button>
      </div>
      <div role="status" aria-live="polite" className="mt-2 space-y-2 break-words text-xs leading-5 text-daw-text-secondary">
        {report && <>
          {report.deviceName && <p>{report.deviceName} · {report.precision} · {report.placement?.split("-").join(" ")}</p>}
          {report.memory.map((row) => <div key={row.label} className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="font-semibold">{row.label}</span>
            <span>Estimated need: {gib(row.requiredBytes)}</span><span>Available now: {gib(row.availableBytes)}</span>
            {!!row.shortfallBytes && <span className="text-amber-200">Short by {gib(row.shortfallBytes)}</span>}
          </div>)}
          {report.estimateBasis && <p>{report.estimateBasis}</p>}
          {report.checkedAt && <p>Checked at {new Date(report.checkedAt * 1000).toLocaleTimeString()}. Refresh after closing other applications.</p>}
          {report.notes.map((note, index) => <p key={index}>{note}</p>)}
          <p>Other allocations can include a reusable, idle model cache. This check is advisory; the generation worker makes the final memory decision.</p>
        </>}
      </div>
    </section>
  );
}
