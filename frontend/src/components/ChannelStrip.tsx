import React, { useState, useCallback, useMemo } from "react";
import classNames from "classnames";
import { Power } from "lucide-react";
import { PeakMeter } from "./PeakMeter";
import { useDAWStore, Track, getTrackGroupInfo, TRACK_GROUP_COLORS } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { FXChainPanel } from "./FXChainPanel";
import { Button, Slider } from "./ui";
import { useContextMenu, MenuItem } from "./ContextMenu";
import { automationToBackend } from "../store/automationParams";

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
  const autoValues = useDAWStore((s) => s.automatedParamValues[track.id]);

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
    openTrackRouting,
    currentTime,
    masterVolume,
    openChannelStripEQ,
    masterMono,
    toggleMasterMono,
    openEnvelopeManager,
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
      openTrackRouting: s.openTrackRouting,
      currentTime: s.transport.currentTime,
      masterVolume: s.masterVolume,
      openChannelStripEQ: s.openChannelStripEQ,
      masterMono: s.masterMono,
      toggleMasterMono: s.toggleMasterMono,
      openEnvelopeManager: s.openEnvelopeManager,
    })),
  );

  const { showContextMenu, ContextMenuComponent } = useContextMenu();

  const [showFXChain, setShowFXChain] = useState(false);
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

  const effectivePan = autoValues?.pan !== undefined ? automationToBackend("pan", autoValues.pan) : track.pan;
  const effectiveVolumeDB = autoValues?.volume !== undefined ? automationToBackend("volume", autoValues.volume) : track.volumeDB;
  const panDisplay =
    effectivePan === 0
      ? "C"
      : effectivePan > 0
        ? `R${Math.round(Math.abs(effectivePan * 100))}`
        : `L${Math.round(Math.abs(effectivePan * 100))}`;

  // Use fewer dB marks for track strips to save space
  const dbMarks = isMaster
    ? DB_MARKS
    : DB_MARKS.filter((m) => [12, 0, -12, -48, -60].includes(m.db));

  return (
  <>
    <div
      role="group"
      aria-label={`Channel strip for ${track.name}`}
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

      {/* Pre-fader controls — scrollable when content exceeds available space */}
      <div className="overflow-y-auto min-h-0">
      {/* IO Button — opens Track Routing Modal */}
      {!isMaster && (
        <div className="px-1 pt-0.5 pb-0.5 shrink-0">
          <button
            onClick={() => openTrackRouting(track.id)}
            title="Sends, receives & hardware output routing"
            className={classNames(
              "w-full h-4 rounded text-[7px] font-bold cursor-pointer transition-colors border",
              track.sends?.length > 0
                ? "border-cyan-600/60 text-cyan-400 bg-neutral-900 hover:bg-neutral-800"
                : "border-neutral-700 text-neutral-500 bg-neutral-900/60 hover:border-cyan-500 hover:text-cyan-400",
            )}
          >
            IO {track.sends?.length > 0 && `(${track.sends.length})`}
          </button>
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

      {/* M/S/Mono Buttons for Master */}
      {isMaster && (
        <div className="flex gap-0.5 p-1 shrink-0">
          <Button
            variant="success"
            size="xs"
            active={track.muted}
            onClick={() => toggleTrackMute(track.id)}
            title="Mute"
            aria-label={track.muted ? "Unmute master" : "Mute master"}
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
            aria-label={track.soloed ? "Unsolo master" : "Solo master"}
            className="flex-1"
          >
            S
          </Button>
          <button
            onClick={toggleMasterMono}
            className={classNames(
              "flex-1 h-3.5 rounded text-[7px] font-bold cursor-pointer transition-colors",
              masterMono ? "bg-yellow-600 text-white" : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
            )}
            title={masterMono ? "Disable Mono" : "Enable Mono"}
          >
            MONO
          </button>
        </div>
      )}

      {/* FX + Bypass + EQ — single row */}
      <div className={classNames("flex justify-between px-1 shrink-0 pb-1")}>
        <span className="flex">
          <button
            type="button"
            onClick={() => setShowFXChain(true)}
            aria-label={`Open FX chain for ${track.name}`}
            className={classNames(
              "h-4 w-4 rounded rounded-r-none text-[7px] flex items-center justify-center cursor-pointer transition-colors p-0",
              hasFx
                ? track.fxBypassed
                  ? "bg-neutral-800 border border-red-500 text-red-400 shadow-[0_0_6px_rgba(239,68,68,0.4)]"
                  : "bg-neutral-800 border border-green-500 text-green-400 shadow-[0_0_6px_rgba(34,197,94,0.4)]"
                : "bg-neutral-800 border border-dashed border-neutral-600 text-neutral-500 hover:border-green-500 hover:text-green-500",
            )}
          >
            FX
          </button>
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
            aria-label={
              hasFx
                ? track.fxBypassed
                  ? `Enable FX on ${track.name}`
                  : `Bypass FX on ${track.name}`
                : `Open FX chain for ${track.name}`
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
        {!isMaster && (
          <button
            onClick={() => openChannelStripEQ(track.id)}
            title="Channel Strip EQ"
            aria-label={`Open EQ for ${track.name}`}
            className="h-4 px-1.5 shrink-0 rounded flex items-center justify-center text-[7px] font-bold transition-colors border border-neutral-600 text-neutral-500 bg-neutral-800 hover:border-daw-accent hover:text-daw-accent cursor-pointer"
          >
            EQ
          </button>
        )}
        {isMaster && (
          <button
            onClick={() => openEnvelopeManager("master")}
            title="Master Automation"
            aria-label="Open master automation envelopes"
            className="h-4 px-1.5 shrink-0 rounded flex items-center justify-center text-[7px] font-bold transition-colors border border-neutral-600 text-neutral-500 bg-neutral-800 hover:border-daw-accent hover:text-daw-accent cursor-pointer"
          >
            A
          </button>
        )}
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

      </div>

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
            value={effectivePan * 100}
            onChange={handlePanChange}
            defaultValue={0}
            className="w-full"
            title={panDisplay}
            aria-label={`Pan for ${track.name}: ${panDisplay}`}
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
            value={effectiveVolumeDB}
            onChange={handleVolumeChange}
            defaultValue={0}
            height="100%"
            width="18px"
            title={`${formatVolume(effectiveVolumeDB)} dB`}
            aria-label={`Volume fader for ${track.name}: ${formatVolume(effectiveVolumeDB)} dB`}
          />
        </div>
      </div>

      {/* Volume Display (with gain staging tooltip for tracks) */}
      <div
        className={classNames(
          "text-[9px] font-mono text-center py-0.5 shrink-0",
          {
            "bg-slate-900 text-blue-400 mt-2": isMaster,
            "bg-neutral-900 text-neutral-400": !isMaster,
          },
        )}
        title={!isMaster ? `Clip: ${activeClipGainDB !== null ? formatGainDb(activeClipGainDB) : "--"}\nFader: ${formatGainDb(effectiveVolumeDB)}\nMaster: ${formatGainDb(masterVolumeDB)}\n────────\nSum: ${formatGainDb((activeClipGainDB ?? 0) + effectiveVolumeDB + masterVolumeDB)}` : undefined}
      >
        {formatVolume(effectiveVolumeDB)} dB
      </div>

      {/* M/S/R Buttons for tracks */}
      {!isMaster && (
        <div className="flex gap-0.5 p-1 shrink-0">
          <Button
            variant="success"
            size="xs"
            active={track.muted}
            onClick={() => toggleTrackMute(track.id)}
            title="Mute"
            aria-label={track.muted ? `Unmute track ${track.name}` : `Mute track ${track.name}`}
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
            aria-label={track.soloed ? `Unsolo track ${track.name}` : `Solo track ${track.name}`}
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
            aria-label={track.armed ? `Disarm recording on track ${track.name}` : `Arm track ${track.name} for recording`}
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
