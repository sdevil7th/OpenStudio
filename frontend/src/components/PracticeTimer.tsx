import { useEffect, useId, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { formatPracticeTime, usePracticeTimerStore } from "../store/practiceTimerStore";
import { Button, Input } from "./ui";
import { ChevronDown, Timer } from "lucide-react";

export function PracticeTimerStatus({ onOpen }: { onOpen: () => void }) {
  const { status, elapsed, duration, refresh } = usePracticeTimerStore();
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 200);
    return () => window.clearInterval(timer);
  }, [refresh]);
  if (status === "idle") return null;
  return <button type="button" onClick={onOpen} className="rounded px-1 text-xs tabular-nums text-amber-300 focus-visible:outline-2 focus-visible:outline-amber-300"
    aria-label={`Practice timer ${status}`} title={`Practice timer: ${status}`}>
    {formatPracticeTime(duration > 0 ? duration - elapsed : elapsed)} · {status}
  </button>;
}

export function PracticeTimer() {
  const timer = usePracticeTimerStore();
  const [countdown, setCountdown] = useState(timer.status === "idle" || timer.duration > 0);
  const [seconds, setSeconds] = useState(timer.duration > 0 ? timer.duration : 60);
  const { tempo, playing, recording } = useDAWStore(useShallow(s => ({ tempo: s.transport.tempo, playing: s.transport.isPlaying, recording: s.transport.isRecording })));
  const engaged = timer.status === "running" || timer.status === "paused";
  const [expanded, setExpanded] = useState(timer.status !== "idle");
  const contentId = useId();
  useEffect(() => {
    if (expanded) document.getElementById(contentId)?.scrollIntoView({ block: "nearest" });
  }, [expanded, contentId]);
  return <section className="overflow-hidden rounded-lg border border-daw-border bg-daw-dark/40">
    <button type="button" aria-label="Practice timer" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded(!expanded)}
      className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daw-accent hover:bg-daw-lighter/50">
      <Timer size={16} className="shrink-0 text-daw-text-muted" />
      <span className="flex-1 font-medium text-daw-text">Practice timer</span>
      <output className={`text-xs tabular-nums ${engaged ? "text-daw-solo" : "text-daw-text-muted"}`}>
        {formatPracticeTime(timer.duration > 0 ? timer.duration - timer.elapsed : timer.elapsed)} · {timer.status}
      </output>
      <ChevronDown size={14} className={`shrink-0 text-daw-text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
    {expanded && <div id={contentId} className="space-y-3 border-t border-daw-border px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-36 flex-1 flex-col gap-1.5 text-xs text-daw-text-muted">Mode
          <select aria-label="Practice timer mode" value={countdown ? "countdown" : "stopwatch"} disabled={engaged || timer.pending}
            onChange={e => setCountdown(e.target.value === "countdown")}
            className="h-8 rounded border border-daw-border bg-daw-lighter px-2 text-sm text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50">
            <option value="countdown">Countdown</option><option value="stopwatch">Stopwatch</option>
          </select>
        </label>
        {countdown && <label className="flex w-32 shrink-0 flex-col gap-1.5 text-xs text-daw-text-muted">Duration<Input aria-label="Practice duration in seconds" type="number" size="md" unit="sec" fullWidth
          min={1} max={86400} value={seconds} disabled={engaged || timer.pending}
          onChange={e => setSeconds(Number(e.target.value))} /></label>}
        <span className="pb-2 text-xs tabular-nums text-daw-text-muted">{tempo} BPM</span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={timer.pending || playing || recording || (countdown && (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400))}
          onClick={() => void timer.control(timer.status === "running" ? "pause" : timer.status === "paused" ? "resume" : "start", countdown ? seconds : 0)}>
          {timer.status === "running" ? "Pause timer" : timer.status === "paused" ? "Resume timer" : "Start timer"}
        </Button>
        <Button size="sm" disabled={timer.pending} onClick={() => void timer.control("reset")}>Reset timer</Button>
      </div>
      <p className="text-xs leading-relaxed text-daw-text-muted">Keeps running when this dialog closes. Play or Record ends timed practice.</p>
      {timer.error && <p role="alert" className="text-xs text-daw-record">{timer.error}</p>}
    </div>}
  </section>;
}
