import { useState, useCallback } from "react";
import { useDAWStore, AUTOMATION_LANE_HEIGHT, AutomationModeType } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Slider } from "./ui";
import { Volume2, VolumeX, Power } from "lucide-react";
import { FXChainPanel } from "./FXChainPanel";
import { getAutomationColor, getAutomationShortLabel, getAutomationParamDef } from "../store/automationParams";

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
    setMasterVolume,
    toggleMasterMute,
    toggleMasterMono,
    toggleMasterAutomation,
    openEnvelopeManager,
    toggleMasterAutomationLaneVisibility,
    setMasterAutomationLaneMode,
    armMasterAutomationLane,
  } = useDAWStore(useShallow((s) => ({
    masterVolume: s.masterVolume,
    isMasterMuted: s.isMasterMuted,
    masterFxCount: s.masterFxCount,
    masterMono: s.masterMono,
    masterAutomationLanes: s.masterAutomationLanes,
    showMasterAutomation: s.showMasterAutomation,
    setMasterVolume: s.setMasterVolume,
    toggleMasterMute: s.toggleMasterMute,
    toggleMasterMono: s.toggleMasterMono,
    toggleMasterAutomation: s.toggleMasterAutomation,
    openEnvelopeManager: s.openEnvelopeManager,
    toggleMasterAutomationLaneVisibility: s.toggleMasterAutomationLaneVisibility,
    setMasterAutomationLaneMode: s.setMasterAutomationLaneMode,
    armMasterAutomationLane: s.armMasterAutomationLane,
  })));

  const [showFXChain, setShowFXChain] = useState(false);
  const [fxBypassed, setFxBypassed] = useState(false);

  const hasFx = masterFxCount > 0;
  const hasVisibleLanes = masterAutomationLanes.some((l) => l.visible);

  const masterVolumeDB =
    masterVolume > 0 ? 20 * Math.log10(masterVolume) : -60;

  const handleVolumeChange = (db: number) => {
    const linear = db <= -60 ? 0 : Math.pow(10, db / 20);
    void setMasterVolume(linear);
  };

  const handleAutomationClick = useCallback(() => {
    openEnvelopeManager("master");
  }, [openEnvelopeManager]);

  const handleAutomationContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // Toggle showMasterAutomation on right-click
    toggleMasterAutomation();
  }, [toggleMasterAutomation]);

  return (
    <>
      <div className="border-t border-daw-border bg-daw-panel px-2 py-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          {/* Label */}
          <span className="text-[10px] font-bold uppercase text-daw-text-muted shrink-0">
            Master
          </span>

          {/* Mute */}
          <Button
            variant={isMasterMuted ? "danger" : "default"}
            size="icon-sm"
            onClick={toggleMasterMute}
            title={isMasterMuted ? "Unmute Master" : "Mute Master"}
          >
            {isMasterMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </Button>

          {/* Mono */}
          <Button
            variant="default"
            size="icon-sm"
            shape="square"
            onClick={toggleMasterMono}
            title={masterMono ? "Disable Mono" : "Enable Mono"}
            className={masterMono ? "bg-yellow-600! text-white! border-yellow-500!" : ""}
          >
            <span className="text-[8px] font-bold">M</span>
          </Button>

          {/* FX + Bypass */}
          <div className="flex gap-px shrink-0">
            <Button
              variant="default"
              size="icon-sm"
              shape="square"
              onClick={() => setShowFXChain(true)}
              title="Master FX Chain"
              className={
                hasFx
                  ? "text-green-400! border-green-500! shadow-[0_0_6px_rgba(34,197,94,0.4)] rounded-l"
                  : "hover:text-green-500 hover:border-green-500 rounded-l"
              }
            >
              FX
            </Button>
            <Button
              variant="default"
              size="icon-sm"
              shape="square"
              onClick={() => setFxBypassed(!fxBypassed)}
              title={hasFx ? (fxBypassed ? "Enable FX" : "Bypass FX") : "No FX loaded"}
              disabled={!hasFx}
              className={
                !hasFx
                  ? "opacity-40 rounded-r"
                  : fxBypassed
                    ? "text-red-400! border-red-500! rounded-r"
                    : "text-green-400! border-green-500! rounded-r"
              }
            >
              <Power size={10} strokeWidth={2.5} />
            </Button>
          </div>

          {/* Automation button */}
          <Button
            variant="default"
            size="icon-sm"
            shape="square"
            onClick={handleAutomationClick}
            onContextMenu={handleAutomationContextMenu}
            title="Master Automation (right-click to toggle lanes)"
            className={hasVisibleLanes ? "text-daw-accent! border-daw-accent!" : ""}
          >
            <span className="text-[9px] font-bold">A</span>
          </Button>

          {/* Volume Fader */}
          <div className="flex-1 min-w-0">
            <Slider
              min={-60}
              max={12}
              step={0.1}
              value={masterVolumeDB}
              onChange={handleVolumeChange}
            />
          </div>

          {/* dB Display */}
          <span className="text-[10px] font-mono text-daw-text-muted w-11 text-right shrink-0">
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
              {/* Mode selector */}
              <select
                className="text-[9px] bg-neutral-700 text-neutral-300 rounded px-0.5 h-5 shrink-0 cursor-pointer"
                value={lane.mode}
                onChange={(e) => setMasterAutomationLaneMode(lane.id, e.target.value as AutomationModeType)}
              >
                <option value="off">Off</option>
                <option value="read">Read</option>
                <option value="touch">Touch</option>
                <option value="latch">Latch</option>
                <option value="write">Write</option>
              </select>
              {/* Arm toggle */}
              <button
                className={`text-[9px] w-4 h-4 rounded flex items-center justify-center shrink-0 cursor-pointer ${lane.armed ? "bg-red-600 text-white" : "bg-neutral-700 text-neutral-500 hover:text-neutral-300"}`}
                onClick={() => armMasterAutomationLane(lane.id, !lane.armed)}
                title={lane.armed ? "Disarm automation" : "Arm automation"}
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
