import React, { useState, useCallback, useMemo } from "react";
import classNames from "classnames";
import { Power, ChevronDown, ChevronRight } from "lucide-react";
import { PeakMeter } from "./PeakMeter";
import { useDAWStore, Track, getTrackGroupInfo, TRACK_GROUP_COLORS } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { FXChainPanel } from "./FXChainPanel";
import { Button, Slider } from "./ui";
import { useContextMenu, MenuItem } from "./ContextMenu";

interface ChannelStripProps {
  track: Track;
  trackIndex: number;
  isMaster?: boolean;
  isSelected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
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

/** Color-code a dB value: green (-18 to -6), yellow (-6 to 0), red (>0), dim otherwise */
function gainDbColor(db: number): string {
  if (db > 0) return "text-red-400";
  if (db > -6) return "text-yellow-400";
  if (db >= -18) return "text-green-400";
  return "text-neutral-500";
}

function formatGainDb(db: number): string {
  if (db <= -60) return "-inf";
  return (db >= 0 ? "+" : "") + db.toFixed(1);
}

export const ChannelStrip = React.memo(function ChannelStrip({
  track,
  trackIndex,
  isMaster = false,
  isSelected = false,
  onSelect,
}: ChannelStripProps) {
  // Subscribe to this track's meter level directly from the dedicated slice.
  // This component re-renders at 10Hz for metering; keeping it isolated from
  // the tracks array means Timeline/App never see those re-renders.
  const meterLevel = useDAWStore((s) => s.meterLevels[track.id] ?? 0);

  const {
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    toggleTrackFXBypass,
    setTrackVolume,
    setTrackPan,
    setMasterVolume,
    setMasterPan,
    beginTrackVolumeEdit,
    commitTrackVolumeEdit,
    beginTrackPanEdit,
    commitTrackPanEdit,
    selectedTrackIds,
    trackGroups,
    addTrackGroup,
    removeTrackGroup,
    updateTrackGroup,
    tracks,
    addTrackSend,
    removeTrackSend,
    setTrackSendLevel,
    setTrackSendEnabled,
    setTrackSendPreFader,
    currentTime,
    masterVolume,
  } = useDAWStore(
    useShallow((s) => ({
      toggleTrackMute: s.toggleTrackMute,
      toggleTrackSolo: s.toggleTrackSolo,
      toggleTrackArmed: s.toggleTrackArmed,
      toggleTrackFXBypass: s.toggleTrackFXBypass,
      setTrackVolume: s.setTrackVolume,
      setTrackPan: s.setTrackPan,
      setMasterVolume: s.setMasterVolume,
      setMasterPan: s.setMasterPan,
      beginTrackVolumeEdit: s.beginTrackVolumeEdit,
      commitTrackVolumeEdit: s.commitTrackVolumeEdit,
      beginTrackPanEdit: s.beginTrackPanEdit,
      commitTrackPanEdit: s.commitTrackPanEdit,
      selectedTrackIds: s.selectedTrackIds,
      trackGroups: s.trackGroups,
      addTrackGroup: s.addTrackGroup,
      removeTrackGroup: s.removeTrackGroup,
      updateTrackGroup: s.updateTrackGroup,
      tracks: s.tracks,
      addTrackSend: s.addTrackSend,
      removeTrackSend: s.removeTrackSend,
      setTrackSendLevel: s.setTrackSendLevel,
      setTrackSendEnabled: s.setTrackSendEnabled,
      setTrackSendPreFader: s.setTrackSendPreFader,
      currentTime: s.transport.currentTime,
      masterVolume: s.masterVolume,
    })),
  );

  const { showContextMenu, ContextMenuComponent } = useContextMenu();

  const [phaseInverted, setPhaseInverted] = useState(false);
  const [showFXChain, setShowFXChain] = useState(false);
  const [showGainStaging, setShowGainStaging] = useState(false);
  const hasFx = track.inputFxCount + track.trackFxCount > 0;

  // Find the clip under the playhead for gain staging display
  const activeClipGainDB = useMemo(() => {
    if (isMaster) return null;
    const clip = track.clips.find(
      (c) => currentTime >= c.startTime && currentTime < c.startTime + c.duration && !c.muted,
    );
    return clip ? (clip.volumeDB ?? 0) : null;
  }, [isMaster, track.clips, currentTime]);

  const masterVolumeDB = masterVolume > 0 ? 20 * Math.log10(masterVolume) : -60;

  const ALL_LINKED_PARAMS = ["volume", "pan", "mute", "solo", "armed", "fxBypass"];
  const trackGroup = trackGroups.find((g) => g.memberTrackIds.includes(track.id));
  const groupInfo = getTrackGroupInfo(track.id, trackGroups);
  const groupColor = groupInfo ? TRACK_GROUP_COLORS[groupInfo.colorIndex] : null;
  const isMultiSelected = selectedTrackIds.includes(track.id) && selectedTrackIds.length > 1;
  const allInSameGroup = isMultiSelected && trackGroups.find((g) =>
    selectedTrackIds.every((id) => g.memberTrackIds.includes(id)),
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isMaster) return;

    const items: MenuItem[] = [];

    if (isMultiSelected && !allInSameGroup) {
      items.push({
        label: `Link ${selectedTrackIds.length} Tracks`,
        onClick: () => addTrackGroup("Group", selectedTrackIds[0], [...selectedTrackIds], ALL_LINKED_PARAMS),
      });
    }
    if (isMultiSelected && allInSameGroup) {
      items.push({
        label: "Unlink Entire Group",
        onClick: () => removeTrackGroup(allInSameGroup.id),
      });
    }
    if (trackGroup) {
      items.push({
        label: "Unlink This Track",
        onClick: () => {
          const remaining = trackGroup.memberTrackIds.filter((id) => id !== track.id);
          if (remaining.length <= 1) {
            removeTrackGroup(trackGroup.id);
          } else {
            updateTrackGroup(trackGroup.id, { memberTrackIds: remaining });
          }
        },
      });
      if (!allInSameGroup) {
        items.push({
          label: "Unlink Entire Group",
          onClick: () => removeTrackGroup(trackGroup.id),
        });
      }
    }

    if (items.length > 0) {
      showContextMenu(e, items);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMaster, isMultiSelected, allInSameGroup, trackGroup, selectedTrackIds, addTrackGroup, removeTrackGroup, updateTrackGroup, showContextMenu, track.id]);

  const handleVolumeChange = (volumeDB: number) => {
    if (isMaster) {
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

  // Undo/redo: capture starting value on pointer down, commit on pointer up
  const handleVolumePointerDown = useCallback(() => {
    if (isMaster) return;
    beginTrackVolumeEdit(track.id);
    const commitOnUp = () => {
      document.removeEventListener("pointerup", commitOnUp);
      commitTrackVolumeEdit(track.id);
    };
    document.addEventListener("pointerup", commitOnUp);
  }, [isMaster, track.id, beginTrackVolumeEdit, commitTrackVolumeEdit]);

  const handlePanPointerDown = useCallback(() => {
    if (isMaster) return;
    beginTrackPanEdit(track.id);
    const commitOnUp = () => {
      document.removeEventListener("pointerup", commitOnUp);
      commitTrackPanEdit(track.id);
    };
    document.addEventListener("pointerup", commitOnUp);
  }, [isMaster, track.id, beginTrackPanEdit, commitTrackPanEdit]);

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
  const dbMarks = isMaster
    ? DB_MARKS
    : DB_MARKS.filter((m) => [12, 0, -12, -48, -60].includes(m.db));

  return (
  <>
    <div
      className={classNames(
        "flex flex-col shrink-0 h-full border-r border-l border-neutral-800",
        {
          "w-[90px] bg-slate-800 sticky left-0 z-10 border-x-2 border-x-green-600":
            isMaster,
          "w-[75px] bg-neutral-800": !isMaster && !isSelected,
          "w-[75px] bg-neutral-700": !isMaster && isSelected,
        },
      )}
      onClick={onSelect}
      onDoubleClick={() => {
        if (isMaster) return;
        const el = document.querySelector(`[data-track-id="${track.id}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }}
      onContextMenu={handleContextMenu}
    >
      {/* Link group indicator bar */}
      {groupColor && !isMaster && (
        <div className="h-[3px] shrink-0" style={{ backgroundColor: groupColor }} />
      )}

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

      {/* Sends Section */}
      {!isMaster && (
        <div className="px-1 pt-0.5 pb-0.5 shrink-0 space-y-0.5">
          {track.sends?.length > 0 && track.sends.map((send, i) => {
            const destTrack = tracks.find((t) => t.id === send.destTrackId);
            return (
              <div
                key={i}
                className={classNames(
                  "rounded text-[7px] transition-colors",
                  send.enabled
                    ? "bg-neutral-900 border border-cyan-600/60"
                    : "bg-neutral-900 border border-neutral-700 opacity-50",
                )}
              >
                {/* Send header: destination + pre/post + remove */}
                <div className="flex items-center justify-between px-1 h-3.5">
                  <span
                    className={classNames(
                      "truncate max-w-[32px] cursor-pointer",
                      send.enabled ? "text-cyan-400" : "text-neutral-500",
                    )}
                    onClick={() => setTrackSendEnabled(track.id, i, !send.enabled)}
                    title={`${send.enabled ? "Disable" : "Enable"} send to ${destTrack?.name || "?"}`}
                  >
                    {destTrack?.name || "?"}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <button
                      className={classNames(
                        "text-[6px] px-0.5 rounded cursor-pointer transition-colors",
                        send.preFader
                          ? "bg-cyan-700/50 text-cyan-300"
                          : "bg-neutral-700/50 text-neutral-500 hover:text-neutral-300",
                      )}
                      onClick={() => setTrackSendPreFader(track.id, i, !send.preFader)}
                      title={send.preFader ? "Pre-fader (click for post)" : "Post-fader (click for pre)"}
                    >
                      {send.preFader ? "PRE" : "PST"}
                    </button>
                    <button
                      className="text-neutral-600 hover:text-red-400 cursor-pointer transition-colors leading-none"
                      onClick={() => removeTrackSend(track.id, i)}
                      title="Remove send"
                    >
                      &times;
                    </button>
                  </span>
                </div>
                {/* Send level slider */}
                <div className="flex items-center gap-0.5 px-1 pb-0.5">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(send.level * 100)}
                    onChange={(e) => setTrackSendLevel(track.id, i, Number(e.target.value) / 100)}
                    className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
                    style={{ minWidth: 0 }}
                    title={`${Math.round(send.level * 100)}%`}
                  />
                  <span className={classNames(
                    "text-[7px] font-mono w-[20px] text-right",
                    send.enabled ? "text-cyan-400" : "text-neutral-500",
                  )}>
                    {Math.round(send.level * 100)}
                  </span>
                </div>
              </div>
            );
          })}
          {/* Add send button */}
          <div
            className="h-3.5 bg-neutral-900/60 border border-dashed border-neutral-700 rounded text-[7px] text-neutral-500
                       flex items-center justify-center cursor-pointer hover:border-cyan-500 hover:text-cyan-400 transition-colors"
            onClick={() => {
              const otherTracks = tracks.filter((t) => t.id !== track.id);
              if (otherTracks.length > 0) {
                addTrackSend(track.id, otherTracks[0].id);
              }
            }}
            title="Add send to another track"
          >
            + Send
          </div>
        </div>
      )}

      {/* Input Routing */}
      {!isMaster && (
        <div className="px-1 py-1 shrink-0">
          <div className="bg-emerald-700 text-[8px] text-white text-center py-0.5 rounded truncate cursor-pointer hover:bg-emerald-600 transition-colors">
            {track.inputChannelCount === 1
              ? `In ${track.inputStartChannel + 1}`
              : `${track.inputStartChannel + 1}-${track.inputStartChannel + 2}`}
          </div>
        </div>
      )}

      {/* M/S Buttons for Master */}
      {isMaster && (
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
        </div>
      )}

      {/* FX + Bypass + Phase Invert — single row */}
      <div className={classNames("flex justify-between px-1 shrink-0 pb-1")}>
        <span className="flex">
          <div
            onClick={() => setShowFXChain(true)}
            className={classNames(
              "h-4 w-4 rounded rounded-r-none text-[7px] flex items-center justify-center cursor-pointer transition-colors",
              hasFx
                ? track.fxBypassed
                  ? "bg-neutral-800 border border-red-500 text-red-400 shadow-[0_0_6px_rgba(239,68,68,0.4)]"
                  : "bg-neutral-800 border border-green-500 text-green-400 shadow-[0_0_6px_rgba(34,197,94,0.4)]"
                : "bg-neutral-800 border border-dashed border-neutral-600 text-neutral-500 hover:border-green-500 hover:text-green-500",
            )}
          >
            FX
          </div>
          <button
            onClick={() => {
              if (!hasFx) {
                setShowFXChain(true);
              } else {
                toggleTrackFXBypass(track.id);
              }
            }}
            title={
              hasFx
                ? track.fxBypassed
                  ? "Enable FX"
                  : "Bypass FX"
                : "No FX loaded"
            }
            className={classNames(
              "h-4 w-3 shrink-0 rounded rounded-l-none flex items-center justify-center transition-colors border hover:cursor-pointer",
              !hasFx && "border-neutral-700 text-neutral-600 bg-neutral-800",
              hasFx &&
                !track.fxBypassed &&
                "border-green-500 text-green-400 bg-neutral-800",
              hasFx &&
                track.fxBypassed &&
                "border-red-500 text-red-400 bg-neutral-800",
            )}
          >
            <Power size={8} strokeWidth={2.5} />
          </button>
        </span>
        <button
          onClick={() => setPhaseInverted(!phaseInverted)}
          title="Phase Invert"
          className={classNames(
            "h-4 w-4 shrink-0 rounded flex items-center justify-center text-[8px] font-bold transition-colors border",
            phaseInverted
              ? "border-yellow-500 text-yellow-400 bg-neutral-800"
              : "border-neutral-600 text-neutral-500 bg-neutral-800 hover:border-yellow-500 hover:text-yellow-500",
          )}
        >
          Ø
        </button>
      </div>

      {/* FX Chain Panel */}
      {showFXChain && (
        <FXChainPanel
          trackId={track.id}
          trackName={track.name}
          chainType={isMaster ? "master" : "track"}
          onClose={() => setShowFXChain(false)}
        />
      )}

      {/* Pan Section */}
      <div
        className={classNames("px-1 shrink-0", isMaster ? "pb-1" : "pb-0.5")}
        onPointerDown={handlePanPointerDown}
      >
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
          <PeakMeter level={meterLevel} stereo={true} />
        </div>

        {/* dB Scale - inset to match fader thumb padding (5px = half of 10px thumb) */}
        <div className="relative w-2 shrink-0 h-full">
          <div className="absolute inset-x-0" style={{ top: 5, bottom: 5 }}>
            {dbMarks.map(({ db, label }) => (
              <span
                key={db}
                className="absolute text-[6px] text-neutral-400 leading-none right-0"
                style={{
                  top: `${getDbPosition(db)}%`,
                  transform: "translateY(-50%)",
                }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Vertical Fader */}
        <div
          className="flex-1 flex justify-center h-full"
          onPointerDown={handleVolumePointerDown}
        >
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
            "bg-slate-900 text-blue-400 mt-2": isMaster,
            "bg-neutral-900 text-neutral-400": !isMaster,
          },
        )}
      >
        {formatVolume(track.volumeDB)} dB
      </div>

      {/* Gain Staging Display */}
      {!isMaster && (
        <div className="shrink-0">
          <button
            className="w-full text-[7px] text-neutral-500 hover:text-neutral-300 bg-neutral-900/50 border-t border-neutral-700/50 flex items-center justify-center gap-0.5 py-0.5 cursor-pointer transition-colors"
            onClick={() => setShowGainStaging(!showGainStaging)}
            title="Gain staging — signal levels at each stage"
          >
            {showGainStaging ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
            GAIN
          </button>
          {showGainStaging && (
            <div className="bg-neutral-950/60 px-1 py-0.5 space-y-px border-t border-neutral-800">
              {/* Clip Gain */}
              <div className="flex justify-between text-[7px] font-mono">
                <span className="text-neutral-500">Clip</span>
                <span className={activeClipGainDB !== null ? gainDbColor(activeClipGainDB) : "text-neutral-600"}>
                  {activeClipGainDB !== null ? formatGainDb(activeClipGainDB) : "--"}
                </span>
              </div>
              {/* Track Fader */}
              <div className="flex justify-between text-[7px] font-mono">
                <span className="text-neutral-500">Fader</span>
                <span className={gainDbColor(track.volumeDB)}>
                  {formatGainDb(track.volumeDB)}
                </span>
              </div>
              {/* Master */}
              <div className="flex justify-between text-[7px] font-mono">
                <span className="text-neutral-500">Master</span>
                <span className={gainDbColor(masterVolumeDB)}>
                  {formatGainDb(masterVolumeDB)}
                </span>
              </div>
              {/* Sum indicator */}
              <div className="flex justify-between text-[7px] font-mono border-t border-neutral-700/50 pt-px mt-px">
                <span className="text-neutral-400">Sum</span>
                {(() => {
                  const clipDb = activeClipGainDB ?? 0;
                  const sum = clipDb + track.volumeDB + masterVolumeDB;
                  return (
                    <span className={gainDbColor(sum)}>
                      {formatGainDb(sum)}
                    </span>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* M/S/R Buttons for tracks */}
      {!isMaster && (
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
        </div>
      )}

      {/* Track Number / OUT */}
      {!isMaster ? (
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
      ) : (
        ""
      )}
    </div>
    {ContextMenuComponent}
  </>
  );
});
