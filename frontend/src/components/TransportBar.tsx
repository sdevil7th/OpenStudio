import { useState, useEffect, memo } from "react";
import classNames from "classnames";
import { useShallow } from "zustand/shallow";
import { SkipBack, Circle, Play, Square, Pause, Repeat, Settings } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { MetronomeSettings } from "./MetronomeSettings";
import { MetronomeIcon } from "./icons";
import { Button, Input, TimeSignatureInput } from "./ui";

/**
 * Format time as SMPTE timecode (HH:MM:SS:FF)
 */
function formatSMPTE(seconds: number, frameRate: number): string {
  const totalFrames = Math.floor(seconds * frameRate);
  const ff = totalFrames % Math.round(frameRate);
  const totalSecs = Math.floor(totalFrames / Math.round(frameRate));
  const ss = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const mm = totalMins % 60;
  const hh = Math.floor(totalMins / 60);
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}:${ff.toString().padStart(2, "0")}`;
}

/**
 * Lightweight time display component - subscribes ONLY to currentTime.
 * This prevents the entire TransportBar from re-rendering 60fps.
 * Supports three modes: time (MM:SS.ms), beats (BAR.BEAT.TICK), smpte (HH:MM:SS:FF)
 */
const TimeDisplay = memo(function TimeDisplay() {
  const currentTime = useDAWStore((state) => state.transport.currentTime);
  const tempo = useDAWStore((state) => state.transport.tempo);
  const timeSignature = useDAWStore((state) => state.timeSignature);
  const timecodeMode = useDAWStore((state) => state.timecodeMode);
  const smpteFrameRate = useDAWStore((state) => state.smpteFrameRate);

  const cycleTimecodeMode = () => {
    const modes: Array<"time" | "beats" | "smpte"> = ["time", "beats", "smpte"];
    const idx = modes.indexOf(timecodeMode);
    useDAWStore.getState().setTimecodeMode(modes[(idx + 1) % modes.length]);
  };

  if (timecodeMode === "beats") {
    const beatsPerSecond = tempo / 60;
    const totalBeats = currentTime * beatsPerSecond;
    const beatsPerBar = timeSignature.numerator;
    const bars = Math.floor(totalBeats / beatsPerBar) + 1;
    const beats = Math.floor(totalBeats % beatsPerBar) + 1;
    const ticks = Math.floor((totalBeats % 1) * 100);

    return (
      <div
        className="bg-neutral-950 text-sky-500 px-3 py-1 rounded text-sm min-w-[100px] text-center cursor-pointer select-none tabular-nums"
        onClick={cycleTimecodeMode}
        title="Click to cycle: Beats → SMPTE → Time"
        aria-live="polite"
        aria-label={`Position: bar ${bars}, beat ${beats}, tick ${ticks}`}
      >
        {`${bars}.${beats}.${ticks.toString().padStart(2, "0")}`}
      </div>
    );
  }

  if (timecodeMode === "smpte") {
    return (
      <div
        className="bg-neutral-950 text-amber-500 px-3 py-1 rounded text-sm min-w-[100px] text-center cursor-pointer select-none font-mono tabular-nums"
        onClick={cycleTimecodeMode}
        title={`SMPTE ${smpteFrameRate}fps — Click to cycle`}
        aria-live="polite"
        aria-label={`SMPTE time: ${formatSMPTE(currentTime, smpteFrameRate)}`}
      >
        {formatSMPTE(currentTime, smpteFrameRate)}
      </div>
    );
  }

  // Default: time mode (MM:SS.ms)
  const mins = Math.floor(currentTime / 60);
  const secs = Math.floor(currentTime % 60);
  const ms = Math.floor((currentTime % 1) * 1000);

  return (
    <div
      className="bg-neutral-950 text-emerald-500 px-3 py-1 rounded text-sm min-w-[100px] text-center cursor-pointer select-none tabular-nums"
      onClick={cycleTimecodeMode}
      title="Click to cycle: Time → Beats → SMPTE"
      aria-live="polite"
      aria-label={`Time: ${mins} minutes ${secs} seconds`}
    >
      {`${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`}
    </div>
  );
});

export function TransportBar() {
  // Use useShallow to prevent re-renders from currentTime changes
  const {
    tracks,
    play,
    record,
    pause,
    stop,
    toggleLoop,
    setTempo,
    tapTempo,
    seekTo,
    toggleMetronome,
    metronomeEnabled,
    timeSignature,
    setTimeSignature,
  } = useDAWStore(
    useShallow((state) => ({
      tracks: state.tracks,
      play: state.play,
      record: state.record,
      pause: state.pause,
      stop: state.stop,
      toggleLoop: state.toggleLoop,
      setTempo: state.setTempo,
      tapTempo: state.tapTempo,
      seekTo: state.seekTo,
      toggleMetronome: state.toggleMetronome,
      metronomeEnabled: state.metronomeEnabled,
      timeSignature: state.timeSignature,
      setTimeSignature: state.setTimeSignature,
    }))
  );

  // These transport values are needed for button states - use individual selectors
  const isPlaying = useDAWStore((state) => state.transport.isPlaying);
  const isPaused = useDAWStore((state) => state.transport.isPaused);
  const isRecording = useDAWStore((state) => state.transport.isRecording);
  const tempo = useDAWStore((state) => state.transport.tempo);
  const loopEnabled = useDAWStore((state) => state.transport.loopEnabled);
  const recordMode = useDAWStore((state) => state.recordMode);
  const rippleMode = useDAWStore((state) => state.rippleMode);

  // Local state for input fields (blur-based updates)
  const [tempTempo, setTempTempo] = useState(tempo.toString());
  const [showMetronomeSettings, setShowMetronomeSettings] = useState(false);

  // Sync local state when store changes (e.g., from external source)
  useEffect(() => {
    setTempTempo(tempo.toString());
  }, [tempo]);

  const handlePlay = async () => {
    if (!isPlaying || isPaused) {
      await play();
    }
  };

  const handleRecord = async () => {
    if (!isPlaying || isPaused) {
      await record();
    }
  };

  const handleStop = async () => {
    await stop();
  };

  const handlePause = () => {
    if (isPlaying && !isPaused) {
      pause();
    }
  };

  const handleGoToStart = async () => {
    await seekTo(0);
  };

  // BPM: only update on blur, validate, revert if invalid
  const handleTempoBlur = () => {
    const newTempo = parseFloat(tempTempo);
    if (isNaN(newTempo) || newTempo < 10 || newTempo > 300) {
      // Revert to current value
      setTempTempo(tempo.toString());
    } else {
      setTempo(newTempo);
    }
  };

  // Handle Enter key to blur the input (apply changes)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  };

  const hasArmedTracks = tracks.some((t) => t.armed);

  const getStatusText = () => {
    if (isRecording) return "Recording";
    if (isPlaying) return "Playing";
    if (isPaused) return "Paused";
    return "Stopped";
  };

  return (
    <>
      <div className="h-10 bg-neutral-900 border-t border-neutral-700 border-b border-b-neutral-950 flex items-center px-4 justify-between shrink-0">
        {/* Left: Time Display */}
        <div className="flex items-center gap-2 font-mono">
          <TimeDisplay />
          <div
            className={classNames("text-xs px-2 flex items-center gap-1.5", {
              "text-red-500": isRecording,
              "text-neutral-500": !isRecording,
            })}
            aria-live="polite"
            aria-label={`Transport status: ${getStatusText()}`}
          >
            {isRecording && (
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 recording-dot" aria-hidden="true" />
            )}
            [{getStatusText()}]
          </div>
          {recordMode !== "normal" && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 uppercase">
              {recordMode}
            </span>
          )}
          {rippleMode !== "off" && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400">
              Ripple: {rippleMode === "per_track" ? "Track" : "All"}
            </span>
          )}
        </div>

        {/* Center: Transport Controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="default"
            size="icon-lg"
            onClick={handleGoToStart}
            title="Go to Start (Home)"
            aria-label="Go to Start"
          >
            <SkipBack size={16} />
          </Button>
          <Button
            variant="danger"
            size="icon-lg"
            active={isRecording}
            disabled={!hasArmedTracks}
            onClick={handleRecord}
            title={hasArmedTracks ? "Record (Ctrl+R)" : "Arm a track to record"}
            aria-label={hasArmedTracks ? "Record" : "Arm a track to record"}
          >
            <Circle size={16} fill="currentColor" />
          </Button>
          <Button
            variant="success"
            size="icon-lg"
            active={isPlaying && !isRecording}
            disabled={isPlaying && !isPaused}
            onClick={handlePlay}
            title="Play (Space)"
            aria-label="Play"
          >
            <Play size={16} fill="currentColor" />
          </Button>
          <Button
            variant="default"
            size="icon-lg"
            disabled={!isPlaying && !isPaused}
            onClick={handleStop}
            title="Stop (Space)"
            aria-label="Stop"
          >
            <Square size={14} fill="currentColor" />
          </Button>
          <Button
            variant="primary"
            size="icon-lg"
            active={isPaused}
            disabled={!isPlaying}
            onClick={handlePause}
            title="Pause (Space)"
            aria-label="Pause"
          >
            <Pause size={16} fill="currentColor" />
          </Button>
          <Button
            variant="purple"
            size="icon-lg"
            active={loopEnabled}
            onClick={toggleLoop}
            title="Toggle Loop (L)"
            aria-label={loopEnabled ? "Disable Loop" : "Enable Loop"}
          >
            <Repeat size={16} />
          </Button>
          <div className="w-2"></div>
          {/* Metronome */}
          <Button
            variant="warning"
            size="icon-lg"
            active={metronomeEnabled}
            onClick={toggleMetronome}
            title="Toggle Metronome"
            aria-label={metronomeEnabled ? "Disable Metronome" : "Enable Metronome"}
          >
            <MetronomeIcon size={16} />
          </Button>
        </div>

        {/* Right: Project Info */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-end gap-1">
            <TimeSignatureInput
              numerator={timeSignature.numerator}
              denominator={timeSignature.denominator}
              onChange={setTimeSignature}
              showLabel
              size="sm"
            />
            {/* Metronome Settings Button */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowMetronomeSettings(true)}
              title="Metronome Settings"
            >
              <Settings size={14} />
            </Button>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-neutral-500 text-[9px] uppercase">BPM</span>
            <div className="flex items-center gap-1">
              <Input
                type="text"
                variant="compact"
                size="xs"
                centerText
                value={tempTempo}
                onChange={(e) => setTempTempo(e.target.value)}
                onBlur={handleTempoBlur}
                onKeyDown={handleKeyDown}
                className="w-8"
                inputClassName="w-8"
              />
              <Button
                variant="default"
                size="xs"
                onClick={tapTempo}
                title="Tap Tempo (T)"
              >
                TAP
              </Button>
            </div>
          </div>
        </div>

        {/* Metronome Settings Popup */}
        <MetronomeSettings
          isOpen={showMetronomeSettings}
          onClose={() => setShowMetronomeSettings(false)}
        />
      </div>
    </>
  );
}
