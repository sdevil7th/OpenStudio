import { useDAWStore } from "../store/useDAWStore";
import { Button, Slider } from "./ui";
import { Volume2, VolumeX } from "lucide-react";

/**
 * MasterTrackHeader - Compact master channel displayed at the bottom of the TCP sidebar
 * Shows master volume fader, mute, and FX button
 */
export function MasterTrackHeader() {
  const masterVolume = useDAWStore((s) => s.masterVolume);
  const isMasterMuted = useDAWStore((s) => s.isMasterMuted);
  const setMasterVolume = useDAWStore((s) => s.setMasterVolume);
  const toggleMasterMute = useDAWStore((s) => s.toggleMasterMute);

  const masterVolumeDB =
    masterVolume > 0 ? 20 * Math.log10(masterVolume) : -60;

  const handleVolumeChange = (db: number) => {
    const linear = db <= -60 ? 0 : Math.pow(10, db / 20);
    void setMasterVolume(linear);
  };

  return (
    <div className="border-t border-daw-border bg-daw-panel px-2 py-1.5 shrink-0">
      <div className="flex items-center gap-2">
        {/* Label */}
        <span className="text-[10px] font-bold uppercase text-daw-text-muted w-10 shrink-0">
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
  );
}
