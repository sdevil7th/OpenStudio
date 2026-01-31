import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

interface MainToolbarProps {
  onOpenSettings: () => void;
  onToggleMixer?: () => void;
  showMixer?: boolean;
}

export function MainToolbar({
  onOpenSettings,
  onToggleMixer,
  showMixer,
}: MainToolbarProps) {
  const { transport, play, stop, toggleLoop, tracks, snapEnabled, toggleSnap } =
    useDAWStore();
  const { isPlaying, loopEnabled } = transport;
  const hasArmedTracks = tracks.some((t) => t.armed);

  return (
    <div className="h-12 bg-neutral-900 border-b border-b-neutral-950 flex items-center px-4 gap-4 shrink-0">
      {/* Transport Section - Now Connected! */}
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="icon-lg"
          active={hasArmedTracks}
          title={
            hasArmedTracks ? "Tracks armed for recording" : "No tracks armed"
          }
        >
          🎙️
        </Button>
        <Button
          variant="purple"
          size="icon-lg"
          active={loopEnabled}
          onClick={toggleLoop}
          title="Toggle Loop"
        >
          🔁
        </Button>
        <Button
          variant="danger"
          size="icon-lg"
          active={hasArmedTracks && isPlaying}
          onClick={play}
          title={hasArmedTracks ? "Record" : "Arm tracks to record"}
        >
          ●
        </Button>
        <Button
          variant="success"
          size="icon-lg"
          active={isPlaying}
          onClick={play}
          title="Play"
        >
          ▶
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          onClick={stop}
          title="Stop"
        >
          ■
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* Edit Tools */}
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="icon-lg"
          disabled
          title="Undo (TODO)"
        >
          ↶
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled
          title="Redo (TODO)"
        >
          ↷
        </Button>
        <Button
          variant="primary"
          size="icon-lg"
          active={snapEnabled}
          onClick={toggleSnap}
          title={
            snapEnabled
              ? "Snap Enabled (Click to disable)"
              : "Snap Disabled (Click to enable)"
          }
        >
          ▦
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* View Toggles - Mixer Now Works! */}
      <div className="flex items-center gap-1">
        <Button
          variant="primary"
          size="icon-lg"
          active={showMixer}
          onClick={onToggleMixer}
          title="Toggle Mixer"
        >
          🎚️
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled
          title="FX Browser (TODO)"
        >
          🎛️
        </Button>
      </div>

      <div style={{ flex: 1 }}></div>

      {/* Settings */}
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="icon-lg"
          onClick={onOpenSettings}
          title="Audio Settings"
        >
          ⚙️
        </Button>
      </div>
    </div>
  );
}
