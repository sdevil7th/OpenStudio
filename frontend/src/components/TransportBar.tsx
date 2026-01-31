import { useState, useEffect, memo } from "react";
import classNames from "classnames";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { MetronomeSettings } from "./MetronomeSettings";
import { Button, Input, TimeSignatureInput } from "./ui";

/**
 * Lightweight time display component - subscribes ONLY to currentTime.
 * This prevents the entire TransportBar from re-rendering 60fps.
 */
const MusicalTimeDisplay = memo(function MusicalTimeDisplay() {
  const currentTime = useDAWStore((state) => state.transport.currentTime);
  const tempo = useDAWStore((state) => state.transport.tempo);
  const timeSignature = useDAWStore((state) => state.timeSignature);

  const beatsPerSecond = tempo / 60;
  const totalBeats = currentTime * beatsPerSecond;
  const beatsPerBar = timeSignature.numerator;
  const bars = Math.floor(totalBeats / beatsPerBar) + 1;
  const beats = Math.floor(totalBeats % beatsPerBar) + 1;
  const ticks = Math.floor((totalBeats % 1) * 100);

  return (
    <div className="bg-neutral-950 text-sky-500 px-3 py-1 rounded text-sm min-w-[70px] text-center">
      {`${bars}.${beats}.${ticks.toString().padStart(2, "0")}`}
    </div>
  );
});

const RealTimeDisplay = memo(function RealTimeDisplay() {
  const currentTime = useDAWStore((state) => state.transport.currentTime);

  const mins = Math.floor(currentTime / 60);
  const secs = Math.floor(currentTime % 60);
  const ms = Math.floor((currentTime % 1) * 1000);

  return (
    <div className="bg-neutral-950 text-emerald-500 px-3 py-1 rounded text-sm min-w-[80px] text-center">
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
          <MusicalTimeDisplay />
          <span className="text-neutral-500">/</span>
          <RealTimeDisplay />
          <div
            className={classNames("text-xs px-2", {
              "text-red-500": isRecording,
              "text-neutral-500": !isRecording,
            })}
          >
            [{getStatusText()}]
          </div>
        </div>

        {/* Center: Transport Controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="default"
            size="icon-lg"
            onClick={handleGoToStart}
            title="Go to Start"
          >
            ⏮
          </Button>
          <Button
            variant="danger"
            size="icon-lg"
            active={isRecording}
            disabled={!hasArmedTracks && isPlaying}
            onClick={handleRecord}
            title={hasArmedTracks ? "Play & Record" : "Arm a track to record"}
          >
            ●
          </Button>
          <Button
            variant="success"
            size="icon-lg"
            active={isPlaying && !isRecording}
            disabled={isPlaying && !isPaused}
            onClick={handlePlay}
            title="Play"
          >
            ▶
          </Button>
          <Button
            variant="default"
            size="icon-lg"
            disabled={!isPlaying && !isPaused}
            onClick={handleStop}
            title="Stop"
          >
            ■
          </Button>
          <Button
            variant="primary"
            size="icon-lg"
            active={isPaused}
            disabled={!isPlaying}
            onClick={handlePause}
            title="Pause"
          >
            ⏸
          </Button>
          <Button
            variant="purple"
            size="icon-lg"
            active={loopEnabled}
            onClick={toggleLoop}
            title="Loop"
          >
            🔁
          </Button>
          <div className="w-2"></div>
          {/* Metronome */}
          <Button
            variant="warning"
            size="icon-lg"
            active={metronomeEnabled}
            onClick={toggleMetronome}
            title="Metronome Click"
          >
            M
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
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4"
              >
                <path
                  fillRule="evenodd"
                  d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z"
                  clipRule="evenodd"
                />
              </svg>
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
