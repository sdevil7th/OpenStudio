import { Repeat, Circle, Play, Square, Undo2, Redo2, Grid3x3, SlidersHorizontal, SlidersVertical, Settings, Blend, MousePointer, Scissors, VolumeX } from "lucide-react";
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
  const { transport, play, record, stop, toggleLoop, tracks, snapEnabled, toggleSnap, undo, redo, canUndo, canRedo, autoCrossfade, toggleAutoCrossfade, toolMode, setToolMode, toggleSplitTool, toggleMuteTool } =
    useDAWStore();
  const { isPlaying, isPaused, loopEnabled } = transport;
  const hasArmedTracks = tracks.some((t) => t.armed);

  return (
    <div className="h-12 bg-neutral-900 border-b border-b-neutral-950 flex items-center px-4 gap-4 shrink-0">
      {/* Transport Section */}
      <div className="flex items-center gap-1">
        <Button
          variant="purple"
          size="icon-lg"
          active={loopEnabled}
          onClick={toggleLoop}
          title="Toggle Loop"
        >
          <Repeat size={16} />
        </Button>
        <Button
          variant="danger"
          size="icon-lg"
          active={hasArmedTracks && isPlaying}
          disabled={!hasArmedTracks}
          onClick={() => record()}
          title={hasArmedTracks ? "Record" : "Arm a track to record"}
        >
          <Circle size={16} fill="currentColor" />
        </Button>
        <Button
          variant="success"
          size="icon-lg"
          active={isPlaying}
          onClick={() => play()}
          title="Play"
        >
          <Play size={16} fill="currentColor" />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled={!isPlaying && !isPaused}
          onClick={() => stop()}
          title="Stop"
        >
          <Square size={14} fill="currentColor" />
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* Edit Tools */}
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="icon-lg"
          disabled={!canUndo}
          onClick={undo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled={!canRedo}
          onClick={redo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={snapEnabled}
          onClick={toggleSnap}
          title={
            snapEnabled
              ? "Snap Enabled (Click to disable)"
              : "Snap Disabled (Click to enable)"
          }
        >
          <Grid3x3 size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={autoCrossfade}
          onClick={toggleAutoCrossfade}
          title={
            autoCrossfade
              ? "Auto-Crossfade On (Click to disable)"
              : "Auto-Crossfade Off (Click to enable)"
          }
        >
          <Blend size={16} />
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* Tool Mode */}
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "select"}
          onClick={() => setToolMode("select")}
          title="Select Tool (V)"
        >
          <MousePointer size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "split"}
          onClick={toggleSplitTool}
          title="Split Tool (B)"
        >
          <Scissors size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "mute"}
          onClick={toggleMuteTool}
          title="Mute Tool (X)"
        >
          <VolumeX size={16} />
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* View Toggles - Mixer Now Works! */}
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="icon-lg"
          active={showMixer}
          onClick={onToggleMixer}
          title="Toggle Mixer"
        >
          <SlidersHorizontal size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled
          title="FX Browser (TODO)"
        >
          <SlidersVertical size={16} />
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
          <Settings size={16} />
        </Button>
      </div>
    </div>
  );
}
