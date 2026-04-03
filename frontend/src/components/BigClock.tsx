import { X } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button } from "./ui";

/**
 * BigClock - Large floating time/beat display
 */
export function BigClock() {
  const {
    currentTime, tempo, isPlaying, isRecording,
    format, toggleBigClock, toggleBigClockFormat, timeSignature, projectName,
  } = useDAWStore(useShallow((s) => ({
    currentTime: s.transport.currentTime,
    tempo: s.transport.tempo,
    isPlaying: s.transport.isPlaying,
    isRecording: s.transport.isRecording,
    format: s.bigClockFormat,
    toggleBigClock: s.toggleBigClock,
    toggleBigClockFormat: s.toggleBigClockFormat,
    timeSignature: s.timeSignature,
    projectName: s.projectName,
  })));

  const formatTimeDisplay = (): string => {
    if (format === "beats") {
      const beatsPerSecond = tempo / 60;
      const totalBeats = currentTime * beatsPerSecond;
      const bars = Math.floor(totalBeats / timeSignature.numerator) + 1;
      const beat = Math.floor(totalBeats % timeSignature.numerator) + 1;
      const tick = Math.floor((totalBeats % 1) * 960);
      return `${String(bars).padStart(3, " ")}.${beat}.${String(tick).padStart(3, "0")}`;
    }
    // Time format: HH:MM:SS.mmm
    const h = Math.floor(currentTime / 3600);
    const m = Math.floor((currentTime % 3600) / 60);
    const s = Math.floor(currentTime % 60);
    const ms = Math.floor((currentTime % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  };

  return (
    <div className="flex flex-col bg-black border border-daw-border rounded-lg shadow-2xl overflow-hidden select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 bg-neutral-900 border-b border-neutral-800">
        <span className="text-[10px] text-neutral-500 uppercase tracking-wider">
          {projectName || "OpenStudio"} | {tempo} BPM | {timeSignature.numerator}/{timeSignature.denominator}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={toggleBigClockFormat} title="Toggle format">
            <span className="text-[9px] text-neutral-400">{format === "time" ? "T" : "B"}</span>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={toggleBigClock}>
            <X size={12} />
          </Button>
        </div>
      </div>

      {/* Time Display */}
      <div
        className="px-6 py-3 cursor-pointer"
        onClick={toggleBigClockFormat}
        title="Click to toggle between time and beats"
      >
        <div
          className={`font-mono text-5xl tracking-wider ${
            isRecording
              ? "text-red-500"
              : isPlaying
                ? "text-green-400"
                : "text-neutral-200"
          }`}
        >
          {formatTimeDisplay()}
        </div>
        <div className="text-[10px] text-neutral-600 mt-1 text-right">
          {format === "time" ? "HH:MM:SS.ms" : "BAR.BEAT.TICK"}
        </div>
      </div>
    </div>
  );
}
