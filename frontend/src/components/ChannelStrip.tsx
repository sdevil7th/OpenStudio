import { useState } from "react";
import classNames from "classnames";
import { PeakMeter } from "./PeakMeter";
import { useDAWStore, Track } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { FXChainPanel } from "./FXChainPanel";
import { Button, Slider } from "./ui";

interface ChannelStripProps {
  track: Track;
  trackIndex: number;
  isMaster?: boolean;
}

// dB marks with their positions as percentage from top
// position = (12 - dB) / 72 * 100  (range is -60 to +12 = 72 dB)
const DB_MARKS: { db: number; label: string }[] = [
  { db: 12, label: "12" },
  { db: 6, label: "6" },
  { db: 0, label: "0" },
  { db: -6, label: "-6" },
  { db: -12, label: "-12" },
  { db: -24, label: "-24" },
  { db: -48, label: "-48" },
  { db: -60, label: "-∞" },
];

function getDbPosition(db: number): number {
  return ((12 - db) / 72) * 100;
}

export function ChannelStrip({
  track,
  trackIndex,
  isMaster = false,
}: ChannelStripProps) {
  // Subscribe to this track's meter level directly from the dedicated slice.
  // This component re-renders at 10Hz for metering; keeping it isolated from
  // the tracks array means Timeline/App never see those re-renders.
  const meterLevel = useDAWStore((s) => s.meterLevels[track.id] ?? 0);

  const {
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    setTrackVolume,
    setTrackPan,
    setMasterVolume,
    setMasterPan,
  } = useDAWStore(useShallow((s) => ({
    toggleTrackMute: s.toggleTrackMute,
    toggleTrackSolo: s.toggleTrackSolo,
    toggleTrackArmed: s.toggleTrackArmed,
    setTrackVolume: s.setTrackVolume,
    setTrackPan: s.setTrackPan,
    setMasterVolume: s.setMasterVolume,
    setMasterPan: s.setMasterPan,
  })));

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

  // Use fewer dB marks for track strips to save space
  const dbMarks = isMaster ? DB_MARKS : DB_MARKS.filter(m => [12, 0, -12, -48, -60].includes(m.db));

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

      {/* Send Slots (Phase 11) */}
      {!isMaster && (
        <div className="px-1 pt-0.5 pb-0.5 shrink-0 space-y-0.5">
          {track.sends.map((send, i) => {
            const destTrack = useDAWStore.getState().tracks.find((t) => t.id === send.destTrackId);
            return (
              <div
                key={i}
                className={classNames(
                  "h-3.5 rounded text-[7px] flex items-center justify-between px-1 cursor-pointer transition-colors",
                  send.enabled
                    ? "bg-neutral-800 border border-cyan-500 text-cyan-400"
                    : "bg-neutral-800 border border-neutral-600 text-neutral-500"
                )}
                onClick={() => useDAWStore.getState().setTrackSendEnabled(track.id, i, !send.enabled)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useDAWStore.getState().removeTrackSend(track.id, i);
                }}
                title={`Send → ${destTrack?.name || "?"} (${Math.round(send.level * 100)}%) — Right-click to remove`}
              >
                <span className="truncate max-w-[50px]">→ {destTrack?.name || "?"}</span>
                <span>{Math.round(send.level * 100)}%</span>
              </div>
            );
          })}
          <div
            className="h-3.5 bg-neutral-800 border border-dashed border-neutral-600 rounded text-[7px] text-neutral-500
                       flex items-center justify-center cursor-pointer hover:border-cyan-400 hover:text-cyan-400 transition-colors"
            onClick={() => {
              const otherTracks = useDAWStore.getState().tracks.filter((t) => t.id !== track.id);
              if (otherTracks.length > 0) {
                // Add send to first available track (user can change via routing matrix)
                useDAWStore.getState().addTrackSend(track.id, otherTracks[0].id);
              }
            }}
          >
            + Send
          </div>
        </div>
      )}

      {/* Input Routing */}
      {!isMaster && (
        <div className="px-1 pb-0.5 shrink-0">
          <div className="bg-emerald-700 text-[8px] text-white text-center py-0.5 rounded truncate cursor-pointer hover:bg-emerald-600 transition-colors">
            {track.inputChannelCount === 1
              ? `In ${track.inputStartChannel + 1}`
              : `${track.inputStartChannel + 1}-${track.inputStartChannel + 2}`}
          </div>
        </div>
      )}

      {/* FX Slot */}
      <div className={classNames("px-1 shrink-0", isMaster ? "pb-1" : "pb-0.5")}>
        <div
          onClick={() => !isMaster && setShowFXChain(true)}
          className={
            (track.inputFxCount + track.trackFxCount) > 0
              ? "h-3.5 bg-neutral-800 border border-green-500 rounded text-[7px] text-green-400 flex items-center justify-center cursor-pointer shadow-[0_0_6px_rgba(34,197,94,0.4)] transition-colors"
              : "h-3.5 bg-neutral-800 border border-dashed border-neutral-600 rounded text-[7px] text-neutral-500 flex items-center justify-center cursor-pointer hover:border-green-500 hover:text-green-500 transition-colors"
          }
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

      {/* Phase Invert - compact for track strips */}
      <div className={classNames("px-1 shrink-0", isMaster ? "pb-1" : "pb-0.5")}>
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

      {/* Pan Section */}
      <div className={classNames("px-1 shrink-0", isMaster ? "pb-1" : "pb-0.5")}>
        <div className="flex flex-col items-center gap-0.5">
          <Slider
            orientation="horizontal"
            variant="pan"
            min={-100}
            max={100}
            value={track.pan * 100}
            onChange={handlePanChange}
            defaultValue={0}
            className="w-full"
            title={panDisplay}
          />
          <span className="text-[8px] text-neutral-500 font-mono">
            {panDisplay}
          </span>
        </div>
      </div>

      {/* Meter + Fader Section - Main area */}
      <div className="flex-1 flex gap-0.5 px-1 py-0.5 min-h-0 overflow-hidden">
        {/* VU Meter */}
        <div className="shrink-0 h-full">
          <PeakMeter
            level={meterLevel}
            stereo={true}
          />
        </div>

        {/* dB Scale - inset to match fader thumb padding (5px = half of 10px thumb) */}
        <div className="relative w-2 shrink-0 h-full">
          <div className="absolute inset-x-0" style={{ top: 5, bottom: 5 }}>
            {dbMarks.map(({ db, label }) => (
              <span
                key={db}
                className="absolute text-[6px] text-neutral-400 leading-none right-0"
                style={{ top: `${getDbPosition(db)}%`, transform: "translateY(-50%)" }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Vertical Fader */}
        <div className="flex-1 flex justify-center h-full">
          <Slider
            orientation="vertical"
            variant="fader"
            min={-60}
            max={12}
            step={0.1}
            value={track.volumeDB}
            onChange={handleVolumeChange}
            defaultValue={0}
            height="100%"
            width="18px"
            title={`${formatVolume(track.volumeDB)} dB`}
          />
        </div>
      </div>

      {/* Volume Display */}
      <div
        className={classNames(
          "text-[9px] font-mono text-center py-0.5 shrink-0",
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
