import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Slider } from "./ui";
import { Volume2, VolumeX, Power } from "lucide-react";
import { FXChainPanel } from "./FXChainPanel";

/**
 * MasterTrackHeader - Compact master channel displayed at the bottom of the TCP sidebar
 * Shows master volume fader, mute, FX button with bypass toggle
 */
export function MasterTrackHeader() {
  const { masterVolume, isMasterMuted, masterFxCount, setMasterVolume, toggleMasterMute } = useDAWStore(useShallow((s) => ({
    masterVolume: s.masterVolume,
    isMasterMuted: s.isMasterMuted,
    masterFxCount: s.masterFxCount,
    setMasterVolume: s.setMasterVolume,
    toggleMasterMute: s.toggleMasterMute,
  })));

  const [showFXChain, setShowFXChain] = useState(false);
  const [fxBypassed, setFxBypassed] = useState(false);

  const hasFx = masterFxCount > 0;

  const masterVolumeDB =
    masterVolume > 0 ? 20 * Math.log10(masterVolume) : -60;

  const handleVolumeChange = (db: number) => {
    const linear = db <= -60 ? 0 : Math.pow(10, db / 20);
    void setMasterVolume(linear);
  };

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
