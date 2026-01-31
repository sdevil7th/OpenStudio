import { useState } from "react";
import classNames from "classnames";
import { PeakMeter } from "./PeakMeter";
import { useDAWStore, Track } from "../store/useDAWStore";
import { FXChainPanel } from "./FXChainPanel";
import { Button, Slider } from "./ui";

interface ChannelStripProps {
  track: Track;
  trackIndex: number;
  isMaster?: boolean;
}

export function ChannelStrip({
  track,
  trackIndex,
  isMaster = false,
}: ChannelStripProps) {
  const {
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    setTrackVolume,
    setTrackPan,
    setMasterVolume,
    setMasterPan,
  } = useDAWStore();

  const [phaseInverted, setPhaseInverted] = useState(false);
  const [showFXChain, setShowFXChain] = useState(false);

  const handleVolumeChange = (volumeDB: number) => {
    if (isMaster) {
      // Convert dB to linear for master
      const linearVolume = volumeDB <= -60 ? 0 : Math.pow(10, volumeDB / 20);
      setMasterVolume(linearVolume);
    } else {
      setTrackVolume(track.id, volumeDB);
    }
  };

  const handlePanChange = (panValue: number) => {
    const pan = panValue / 100;
    if (isMaster) {
      setMasterPan(pan);
    } else {
      setTrackPan(track.id, pan);
    }
  };

  const formatVolume = (db: number) => {
    if (db <= -60) return "-∞";
    return db.toFixed(1);
  };

  const panDisplay =
    track.pan === 0
      ? "C"
      : track.pan > 0
        ? `R${Math.round(Math.abs(track.pan * 100))}`
        : `L${Math.round(Math.abs(track.pan * 100))}`;

  return (
    <div
      className={classNames(
        "flex flex-col shrink-0 h-full border-r border-l border-neutral-800",
        {
          "w-[90px] bg-slate-800 sticky left-0 z-10 border-x-2 border-x-green-600":
            isMaster,
          "w-[75px] bg-neutral-800": !isMaster,
        },
      )}
    >
      {/* Track Name Header */}
      <div
        className={classNames(
          "text-[9px] font-bold text-center truncate px-1 py-1 shrink-0",
          {
            "bg-green-600 text-white": isMaster,
            "bg-neutral-700 text-neutral-200 border-b-2": !isMaster,
          },
        )}
        style={!isMaster ? { borderColor: track.color || "#666" } : undefined}
      >
        {isMaster ? "● MASTER ●" : track.name}
      </div>

      {/* Send Slot Placeholder */}
      {!isMaster && (
        <div className="px-1 py-1 shrink-0">
          <div
            className="h-4 bg-neutral-800 border border-dashed border-neutral-600 rounded text-[7px] text-neutral-500 
                                   flex items-center justify-center cursor-pointer hover:border-neutral-400 hover:text-neutral-400 transition-colors"
          >
            + Send
          </div>
        </div>
      )}

      {/* Input Routing */}
      {!isMaster && (
        <div className="px-1 pb-1 shrink-0">
          <div className="bg-emerald-700 text-[8px] text-white text-center py-0.5 rounded truncate cursor-pointer hover:bg-emerald-600 transition-colors">
            {track.inputChannelCount === 1
              ? `In ${track.inputStartChannel + 1}`
              : `${track.inputStartChannel + 1}-${track.inputStartChannel + 2}`}
          </div>
        </div>
      )}

      {/* FX Slot */}
      <div className="px-1 pb-1 shrink-0">
        <div
          onClick={() => !isMaster && setShowFXChain(true)}
          className="h-4 bg-neutral-800 border border-dashed border-neutral-600 rounded text-[7px] text-neutral-500 
                               flex items-center justify-center cursor-pointer hover:border-green-500 hover:text-green-500 transition-colors"
        >
          FX
        </div>
      </div>

      {/* FX Chain Panel */}
      {showFXChain && !isMaster && (
        <FXChainPanel
          trackId={track.id}
          trackName={track.name}
          chainType="track"
          onClose={() => setShowFXChain(false)}
        />
      )}

      {/* Phase Invert */}
      <div className="px-1 pb-1 shrink-0">
        <Button
          variant="warning"
          size="xs"
          fullWidth
          active={phaseInverted}
          onClick={() => setPhaseInverted(!phaseInverted)}
          title="Phase Invert"
        >
          Ø
        </Button>
      </div>

      {/* Pan Section - Horizontal Slider like Reaper */}
      <div className="px-1 pb-1 shrink-0">
        <div className="flex flex-col items-center gap-0.5">
          <Slider
            orientation="horizontal"
            variant="pan"
            min={-100}
            max={100}
            value={track.pan * 100}
            onChange={handlePanChange}
            className="w-full"
            title={panDisplay}
          />
          <span className="text-[8px] text-neutral-500 font-mono">
            {panDisplay}
          </span>
        </div>
      </div>

      {/* Meter + Fader Section - Main area */}
      <div className="flex-1 flex gap-0.5 px-1 py-1 min-h-0">
        {/* dB Scale */}
        <div className="flex flex-col justify-between text-[6px] text-neutral-600 w-2 shrink-0">
          <span>12</span>
          <span>0</span>
          <span>-12</span>
          <span>-∞</span>
        </div>

        {/* VU Meter */}
        <div className="shrink-0">
          <PeakMeter
            level={track.meterLevel}
            height={isMaster ? 110 : 95}
            stereo={true}
          />
        </div>

        {/* Vertical Fader */}
        <div className="flex-1 flex justify-center">
          <Slider
            orientation="vertical"
            variant="fader"
            min={-60}
            max={12}
            step={0.1}
            value={track.volumeDB}
            onChange={handleVolumeChange}
            height={isMaster ? "100px" : "75px"}
            width="18px"
            title={`${formatVolume(track.volumeDB)} dB`}
          />
        </div>
      </div>

      {/* Volume Display */}
      <div
        className={classNames(
          "text-[9px] font-mono text-center py-1 shrink-0",
          {
            "bg-slate-900 text-blue-400": isMaster,
            "bg-neutral-900 text-neutral-400": !isMaster,
          },
        )}
      >
        {formatVolume(track.volumeDB)} dB
      </div>

      {/* M/S/R Buttons */}
      <div className="flex gap-0.5 p-1 shrink-0">
        <Button
          variant="success"
          size="xs"
          active={track.muted}
          onClick={() => toggleTrackMute(track.id)}
          title="Mute"
          className="flex-1"
        >
          M
        </Button>
        <Button
          variant="warning"
          size="xs"
          active={track.soloed}
          onClick={() => toggleTrackSolo(track.id)}
          title="Solo"
          className="flex-1"
        >
          S
        </Button>
        {!isMaster && (
          <Button
            variant="danger"
            size="xs"
            active={track.armed}
            activeStyle={track.armed ? "glow" : "solid"}
            onClick={() => toggleTrackArmed(track.id)}
            title="Record Arm"
            className="flex-1"
          >
            R
          </Button>
        )}
      </div>

      {/* Track Number / OUT */}
      <div
        className={classNames(
          "text-[10px] font-bold text-center py-1 shrink-0",
          {
            "bg-green-600 text-white": isMaster,
            "bg-neutral-800/50 text-neutral-500": !isMaster,
          },
        )}
      >
        {isMaster ? "OUT" : trackIndex + 1}
      </div>
    </div>
  );
}
