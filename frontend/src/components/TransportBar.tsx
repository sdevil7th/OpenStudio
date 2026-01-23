import { useState, useEffect } from "react";
import classNames from "classnames";
import { useDAWStore } from "../store/useDAWStore";
import { MetronomeSettings } from "./MetronomeSettings";

export function TransportBar() {
  const {
    transport,
    tracks,
    play,
    record,
    pause,
    stop,
    toggleLoop,
    setTempo,
    seekTo,
    toggleMetronome,
    metronomeEnabled,
    timeSignature,
    setTimeSignature,
  } = useDAWStore();

  const { isPlaying, isPaused, isRecording, currentTime, tempo, loopEnabled } =
    transport;

  // Local state for input fields (blur-based updates)
  const [tempTempo, setTempTempo] = useState(tempo.toString());
  const [tempNumerator, setTempNumerator] = useState(
    timeSignature.numerator.toString(),
  );
  const [tempDenominator, setTempDenominator] = useState(
    timeSignature.denominator.toString(),
  );
  const [showMetronomeSettings, setShowMetronomeSettings] = useState(false);

  // Sync local state when store changes (e.g., from external source)
  useEffect(() => {
    setTempTempo(tempo.toString());
  }, [tempo]);

  useEffect(() => {
    setTempNumerator(timeSignature.numerator.toString());
    setTempDenominator(timeSignature.denominator.toString());
  }, [timeSignature.numerator, timeSignature.denominator]);

  // Format with actual time signature
  const formatMusicalTime = (seconds: number): string => {
    const beatsPerSecond = tempo / 60;
    const totalBeats = seconds * beatsPerSecond;
    const beatsPerBar = timeSignature.numerator;
    const bars = Math.floor(totalBeats / beatsPerBar) + 1;
    const beats = Math.floor(totalBeats % beatsPerBar) + 1;
    const ticks = Math.floor((totalBeats % 1) * 100);
    return `${bars}.${beats}.${ticks.toString().padStart(2, "0")}`;
  };

  const formatRealTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
  };

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

  // Time signature numerator: only update on blur
  const handleNumeratorBlur = () => {
    const val = parseInt(tempNumerator);
    if (isNaN(val) || val < 1 || val > 32) {
      // Revert to current value
      setTempNumerator(timeSignature.numerator.toString());
    } else {
      setTimeSignature(val, timeSignature.denominator);
    }
  };

  // Time signature denominator: only update on blur
  const handleDenominatorBlur = () => {
    const val = parseInt(tempDenominator);
    // Denominator should be a power of 2: 1, 2, 4, 8, 16, 32
    const validDenominators = [1, 2, 4, 8, 16, 32];
    if (isNaN(val) || val < 1 || val > 32 || !validDenominators.includes(val)) {
      // Revert to current value
      setTempDenominator(timeSignature.denominator.toString());
    } else {
      setTimeSignature(timeSignature.numerator, val);
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
          <div className="bg-neutral-950 text-sky-500 px-3 py-1 rounded text-sm min-w-[70px] text-center">
            {formatMusicalTime(currentTime)}
          </div>
          <span className="text-neutral-500">/</span>
          <div className="bg-neutral-950 text-emerald-500 px-3 py-1 rounded text-sm min-w-[80px] text-center">
            {formatRealTime(currentTime)}
          </div>
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
          <button
            onClick={handleGoToStart}
            className="w-8 h-8 bg-neutral-800 border border-neutral-700 rounded text-neutral-400 hover:text-white hover:border-neutral-500 transition-all text-sm flex items-center justify-center"
            title="Go to Start"
          >
            ⏮
          </button>
          <button
            onClick={handleRecord}
            disabled={!hasArmedTracks && isPlaying}
            className={classNames(
              "w-8 h-8 rounded transition-all text-sm flex items-center justify-center border",
              {
                "bg-red-700 text-white border-red-600": isRecording,
                "bg-neutral-800 text-red-500 border-neutral-700 hover:bg-red-700 hover:text-white":
                  hasArmedTracks && !isRecording,
                "bg-neutral-800 text-neutral-500 border-neutral-700":
                  !hasArmedTracks && !isRecording,
              },
            )}
            title={hasArmedTracks ? "Play & Record" : "Arm a track to record"}
          >
            ●
          </button>
          <button
            onClick={handlePlay}
            disabled={isPlaying && !isPaused}
            className={classNames(
              "w-8 h-8 rounded transition-all text-sm flex items-center justify-center border disabled:opacity-40",
              {
                "bg-green-700 text-white border-green-600":
                  isPlaying && !isRecording,
                "bg-neutral-800 text-green-500 border-neutral-700 hover:bg-green-700 hover:text-white":
                  !isPlaying || isRecording,
              },
            )}
            title="Play"
          >
            ▶
          </button>
          <button
            onClick={handleStop}
            disabled={!isPlaying && !isPaused}
            className="w-8 h-8 bg-neutral-800 border border-neutral-700 rounded text-neutral-400 hover:text-white hover:bg-neutral-700 transition-all text-sm disabled:opacity-40 flex items-center justify-center"
            title="Stop"
          >
            ■
          </button>
          <button
            onClick={handlePause}
            disabled={!isPlaying}
            className={classNames(
              "w-8 h-8 rounded transition-all text-sm flex items-center justify-center border disabled:opacity-40",
              {
                "bg-blue-600 text-white border-blue-500": isPaused,
                "bg-neutral-800 text-neutral-400 border-neutral-700 hover:text-white":
                  !isPaused,
              },
            )}
            title="Pause"
          >
            ⏸
          </button>
          <button
            onClick={toggleLoop}
            className={classNames(
              "w-8 h-8 rounded transition-all text-sm flex items-center justify-center border",
              {
                "bg-purple-700 text-white border-purple-600": loopEnabled,
                "bg-neutral-800 text-purple-500 border-neutral-700 hover:bg-purple-700 hover:text-white":
                  !loopEnabled,
              },
            )}
            title="Loop"
          >
            🔁
          </button>
          <div className="w-2"></div>
          {/* Metronome */}
          <button
            onClick={toggleMetronome}
            className={classNames(
              "w-8 h-8 rounded transition-all text-sm flex items-center justify-center border",
              {
                "bg-yellow-700 text-white border-yellow-600": metronomeEnabled,
                "bg-neutral-800 text-yellow-500 border-neutral-700 hover:bg-yellow-700 hover:text-white":
                  !metronomeEnabled,
              },
            )}
            title="Metronome Click"
          >
            M
          </button>
        </div>

        {/* Right: Project Info */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1">
            <div className="flex flex-col items-center">
              <span className="text-neutral-500 text-[9px] uppercase">
                Time Sig
              </span>
              <div className="flex items-center gap-1 bg-neutral-800 border border-neutral-700 rounded px-1">
                <input
                  className="w-5 bg-transparent text-center text-white focus:outline-none"
                  value={tempNumerator}
                  onChange={(e) => setTempNumerator(e.target.value)}
                  onBlur={handleNumeratorBlur}
                  onKeyDown={handleKeyDown}
                />
                <span className="text-neutral-500">/</span>
                <input
                  className="w-5 bg-transparent text-center text-white focus:outline-none"
                  value={tempDenominator}
                  onChange={(e) => setTempDenominator(e.target.value)}
                  onBlur={handleDenominatorBlur}
                  onKeyDown={handleKeyDown}
                />
              </div>
            </div>
            {/* Metronome Settings Button */}
            <button
              onClick={() => setShowMetronomeSettings(true)}
              className="w-6 h-6 flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-700 rounded transition-colors"
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
            </button>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-neutral-500 text-[9px] uppercase">BPM</span>
            <input
              type="text"
              value={tempTempo}
              onChange={(e) => setTempTempo(e.target.value)}
              onBlur={handleTempoBlur}
              onKeyDown={handleKeyDown}
              className="w-12 bg-neutral-900 border border-neutral-700 rounded px-1 text-center text-neutral-400 text-xs focus:outline-none focus:border-blue-600"
            />
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
