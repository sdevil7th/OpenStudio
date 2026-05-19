import { useCallback, useState } from "react";
import { useDAWStore, AUTOMATION_LANE_HEIGHT } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Knob } from "./ui";
import { ChevronDown, Volume2, VolumeX, Power } from "lucide-react";
import { FXChainPanel } from "./FXChainPanel";
import { getAutomationColor, getAutomationShortLabel, getAutomationParamDef } from "../store/automationParams";
import {
  TCP_HEADER_ANCHORED_BUTTON_PAIR_CLASS,
  TCP_HEADER_BUTTON_PAIR_CLASS,
  TCP_HEADER_PRIMARY_BUTTON_CLASS,
  TCP_HEADER_TOGGLE_BUTTON_CLASS,
} from "./tcpHeaderButtonStyles";

/**
 * MasterTrackHeader - Compact master channel displayed at the bottom of the TCP sidebar
 * Shows master volume fader, mute, FX, mono, automation button + automation lane sub-headers
 */
export function MasterTrackHeader() {
  const {
    masterVolume,
    isMasterMuted,
    masterFxCount,
    masterMono,
    masterAutomationLanes,
    showMasterAutomation,
    masterAutomationReadEnabled,
    masterAutomationWriteEnabled,
    masterAutomationEnabled,
    setMasterVolume,
    toggleMasterMute,
    toggleMasterMono,
    toggleMasterAutomation,
    toggleMasterAutomationRead,
    toggleMasterAutomationWrite,
    beginAutomationParamTouch,
    endAutomationParamTouch,
    openEnvelopeManager,
    toggleMasterAutomationLaneVisibility,
    toggleMasterAutomationLaneRead,
  } = useDAWStore(useShallow((s) => ({
    masterVolume: s.masterVolume,
    isMasterMuted: s.isMasterMuted,
    masterFxCount: s.masterFxCount,
    masterMono: s.masterMono,
    masterAutomationLanes: s.masterAutomationLanes,
    showMasterAutomation: s.showMasterAutomation,
    masterAutomationReadEnabled: s.masterAutomationReadEnabled,
    masterAutomationWriteEnabled: s.masterAutomationWriteEnabled,
    masterAutomationEnabled: s.masterAutomationEnabled,
    setMasterVolume: s.setMasterVolume,
    toggleMasterMute: s.toggleMasterMute,
    toggleMasterMono: s.toggleMasterMono,
    toggleMasterAutomation: s.toggleMasterAutomation,
    toggleMasterAutomationRead: s.toggleMasterAutomationRead,
    toggleMasterAutomationWrite: s.toggleMasterAutomationWrite,
    beginAutomationParamTouch: s.beginAutomationParamTouch,
    endAutomationParamTouch: s.endAutomationParamTouch,
    openEnvelopeManager: s.openEnvelopeManager,
    toggleMasterAutomationLaneVisibility: s.toggleMasterAutomationLaneVisibility,
    toggleMasterAutomationLaneRead: s.toggleMasterAutomationLaneRead,
  })));

  const [showFXChain, setShowFXChain] = useState(false);
  const [fxBypassed, setFxBypassed] = useState(false);

  const hasFx = masterFxCount > 0;
  const hasAutomationLane = masterAutomationLanes.length > 0;
  const hasAutomation =
    (showMasterAutomation &&
      masterAutomationLanes.some((lane) => lane.visible)) ||
    masterAutomationLanes.some((lane) => lane.points.length > 0);
  const automationReadActive =
    typeof masterAutomationReadEnabled === "boolean"
      ? masterAutomationReadEnabled
      : typeof masterAutomationEnabled === "boolean"
        ? masterAutomationEnabled
        : hasAutomationLane;
  const automationWriteActive = masterAutomationWriteEnabled === true;
  const canToggleAutomationRead = hasAutomationLane || automationWriteActive;
  const autoReadClass = !canToggleAutomationRead
    ? automationReadActive
      ? "text-teal-200! border-teal-600! bg-teal-500/15! disabled:opacity-100!"
      : "text-neutral-600! border-neutral-700! bg-neutral-800/60!"
    : automationReadActive
    ? "text-teal-200! border-teal-500! bg-teal-500/15!"
    : "hover:text-teal-300 hover:border-teal-500";
  const autoWriteClass = automationWriteActive
    ? "text-red-200! border-red-500! bg-red-500/15!"
    : "hover:text-red-300 hover:border-red-500";
  const autoMenuClass = hasAutomation
    ? "text-teal-300! border-teal-500!"
    : "hover:text-teal-300 hover:border-teal-500";

  const masterVolumeDB =
    masterVolume > 0 ? 20 * Math.log10(masterVolume) : -60;

  const handleVolumeChange = (db: number) => {
    const linear = db <= -60 ? 0 : Math.pow(10, db / 20);
    void setMasterVolume(linear);
  };
  const formatVolume = (db: number) =>
    db <= -60 ? "-inf dB" : `${db.toFixed(1)} dB`;

  const handleMasterVolumeBeginEdit = useCallback(() => {
    beginAutomationParamTouch("master", "volume");
  }, [beginAutomationParamTouch]);

  const handleMasterVolumeCommitEdit = useCallback(() => {
    endAutomationParamTouch("master", "volume");
  }, [endAutomationParamTouch]);

  const handleAutomationContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // Toggle showMasterAutomation on right-click
    toggleMasterAutomation();
  }, [toggleMasterAutomation]);

  return (
    <>
      <div className="border-t border-daw-border bg-daw-panel px-2 py-1.5 shrink-0">
        <div className="flex min-h-6 items-center gap-1.5">
          {/* Label */}
          <span className="self-center leading-none text-[10px] font-bold uppercase text-daw-text-muted shrink-0">
            Master
          </span>

          {/* Mute */}
          <Button
            variant="default"
            size="icon-sm"
            active={isMasterMuted}
            onClick={toggleMasterMute}
            title={isMasterMuted ? "Unmute Master" : "Mute Master"}
          >
            {isMasterMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </Button>

          {/* Mono */}
          <Button
            variant="default"
            size="sm"
            onClick={toggleMasterMono}
            title={masterMono ? "Disable Mono" : "Enable Mono"}
            className={`self-center font-bold ${
              masterMono
                ? "bg-yellow-600! text-white! border-yellow-500!"
                : "hover:text-yellow-300 hover:border-yellow-500"
            }`}
          >
            MONO
          </Button>

          {/* FX + Bypass */}
          <div
            data-tcp-pair="fx"
            className={`${TCP_HEADER_BUTTON_PAIR_CLASS} self-center`}
          >
            <Button
              variant="default"
              size="icon-sm"
              shape="square"
              onClick={() => setShowFXChain(true)}
              title="Master FX Chain"
              className={
                hasFx
                  ? `text-green-400! border-green-500! shadow-[0_0_6px_rgba(34,197,94,0.4)] ${TCP_HEADER_PRIMARY_BUTTON_CLASS}`
                  : `hover:text-green-500 hover:border-green-500 ${TCP_HEADER_PRIMARY_BUTTON_CLASS}`
              }
            >
              FX
            </Button>
            <Button
              variant="default"
              size="icon-xs"
              shape="square"
              onClick={() => setFxBypassed(!fxBypassed)}
              title={hasFx ? (fxBypassed ? "Enable FX" : "Bypass FX") : "No FX loaded"}
              disabled={!hasFx}
              className={
                !hasFx
                  ? `opacity-40 ${TCP_HEADER_TOGGLE_BUTTON_CLASS}`
                  : fxBypassed
                    ? `text-red-400! border-red-500! ${TCP_HEADER_TOGGLE_BUTTON_CLASS}`
                    : `text-green-400! border-green-500! ${TCP_HEADER_TOGGLE_BUTTON_CLASS}`
              }
            >
              <Power size={10} strokeWidth={2.5} />
            </Button>
          </div>

          {/* Automation button */}
          <div
            data-tcp-pair="automation"
            className={`${TCP_HEADER_ANCHORED_BUTTON_PAIR_CLASS} gap-0.5 self-center`}
          >
            <Button
              variant="default"
              size="icon-sm"
              shape="square"
              onClick={toggleMasterAutomationRead}
              disabled={!canToggleAutomationRead}
              title={
                canToggleAutomationRead
                  ? automationReadActive ? "Disable master automation read" : "Enable master automation read"
                  : "Add a master automation lane or enable write first"
              }
              aria-label={
                canToggleAutomationRead
                  ? automationReadActive ? "Disable master automation read" : "Enable master automation read"
                  : "Master automation read unavailable"
              }
              className={`${autoReadClass} rounded`}
            >
              <span className="leading-none">R</span>
            </Button>
            <span className={TCP_HEADER_BUTTON_PAIR_CLASS}>
              <Button
                variant="default"
                size="icon-sm"
                shape="square"
                onClick={toggleMasterAutomationWrite}
                title={automationWriteActive ? "Disable master automation write" : "Enable master automation write"}
                aria-label={automationWriteActive ? "Disable master automation write" : "Enable master automation write"}
                className={`${autoWriteClass} ${TCP_HEADER_PRIMARY_BUTTON_CLASS}`}
              >
                <span className="leading-none">W</span>
              </Button>
              <Button
                variant="default"
                size="icon-xs"
                shape="square"
                onClick={() => openEnvelopeManager("master")}
                onContextMenu={handleAutomationContextMenu}
                title="Master automation panel"
                aria-label="Open master automation panel"
                className={`${autoMenuClass} ${TCP_HEADER_TOGGLE_BUTTON_CLASS}`}
              >
                <ChevronDown size={10} strokeWidth={2.5} />
              </Button>
            </span>
          </div>

          {/* Master Volume Knob */}
          <div className="shrink-0 self-center flex items-center">
            <Knob
              variant="default"
              size="sm"
              min={-60}
              max={12}
              value={masterVolumeDB}
              onChange={handleVolumeChange}
              onBeginEdit={handleMasterVolumeBeginEdit}
              onCommitEdit={handleMasterVolumeCommitEdit}
              defaultValue={0}
              formatValue={formatVolume}
              label="Master Volume"
            />
          </div>

          {/* dB Display */}
          <span className="self-center leading-none text-[10px] font-mono text-daw-text-muted w-11 text-right shrink-0">
            {masterVolumeDB <= -60 ? "-inf" : `${masterVolumeDB.toFixed(1)}`} dB
          </span>
        </div>

        {/* Automation Lane Sub-Headers */}
        {showMasterAutomation && masterAutomationLanes.filter((l) => l.visible).map((lane) => {
          const laneColor = getAutomationColor(lane.param);
          const laneLabel = getAutomationShortLabel(lane.param);
          const paramDef = getAutomationParamDef(lane.param);
          return (
            <div
              key={lane.id}
              className="flex items-center gap-1 px-1 border-t border-neutral-700/50 shrink-0"
              style={{ height: AUTOMATION_LANE_HEIGHT }}
            >
              {/* Color indicator */}
              <div className="w-0.5 h-full shrink-0 rounded-sm" style={{ backgroundColor: laneColor }} />
              {/* Param name */}
              <span className="text-[10px] text-neutral-400 w-7 truncate shrink-0" title={lane.param}>
                {laneLabel}
              </span>
              {/* Value display */}
              <span className="text-[8px] text-neutral-500 w-12 text-center truncate shrink-0">
                {paramDef.formatNormalized(paramDef.defaultNormalized)}
              </span>
              {/* Lane read toggle */}
              <button
                className={`text-[9px] w-5 h-4 rounded flex items-center justify-center shrink-0 cursor-pointer ${
                  (lane.readEnabled ?? lane.mode !== "off")
                    ? "bg-teal-600/70 text-white border border-teal-400"
                    : "bg-neutral-700 text-neutral-500 hover:text-neutral-300 border border-neutral-600"
                }`}
                onClick={() => toggleMasterAutomationLaneRead(lane.id)}
                title={(lane.readEnabled ?? lane.mode !== "off") ? "Disable lane read" : "Enable lane read"}
              >
                R
              </button>
              {/* Hide lane button */}
              <button
                className="text-[10px] text-neutral-500 hover:text-neutral-300 w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer"
                onClick={() => toggleMasterAutomationLaneVisibility(lane.id)}
                title="Hide this lane"
              >
                &times;
              </button>
            </div>
          );
        })}
      </div>

      {showFXChain && (
        <FXChainPanel
          trackId="master"
          trackName="Master"
          chainType="master"
          onClose={() => setShowFXChain(false)}
        />
      )}
    </>
  );
}
