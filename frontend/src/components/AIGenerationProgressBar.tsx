import type { CSSProperties } from "react";
import "./AIGenerationProgressBar.css";

export function formatGenerationStageProgress(value?: number) {
  return value != null && Number.isFinite(value) && value >= 0
    ? `${Math.round(Math.min(1, value) * 100)}% of stage` : "In progress";
}

export function AIGenerationProgressBar({ value, compact = false }: { value?: number; compact?: boolean }) {
  const percent = value != null && Number.isFinite(value) && value >= 0
    ? Math.min(1, value) * 100 : undefined;
  return (
    <div className={`ai-generation-progress overflow-hidden rounded-full bg-daw-dark ${compact ? "h-1.5 min-w-0 flex-1" : "mt-3 h-2.5 w-full"}`}
      role="progressbar" aria-label="Current generation stage" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent} aria-valuetext={formatGenerationStageProgress(value)}
      data-indeterminate={percent === undefined}
      style={{ "--ai-stage-progress": `${percent ?? 0}%` } as CSSProperties}>
      <div className="ai-generation-progress-fill h-full rounded-full bg-daw-accent" />
    </div>
  );
}
