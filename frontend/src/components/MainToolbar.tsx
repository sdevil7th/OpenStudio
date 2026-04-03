import {
  Repeat,
  Circle,
  Play,
  Square,
  Undo2,
  Redo2,
  Grid3x3,
  SlidersHorizontal,
  Settings,
  Blend,
  MousePointer,
  Scissors,
  VolumeX,
  Wand2,
  Cpu,
} from "lucide-react";
import { usePitchEditorStore } from "../store/pitchEditorStore";
import { getActionShortcut, getActionShortcutScopeLabel } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button } from "./ui";
import { useAiToolsStatus } from "../hooks/useAiToolsStatus";

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
  const { status: aiToolsStatus, install, openHelp } = useAiToolsStatus();
  const mixerShortcut = getActionShortcut("view.toggleMixer") ?? "Ctrl+M";
  const loopShortcut = getActionShortcut("transport.loop") ?? "L";
  const recordShortcut = getActionShortcut("transport.record") ?? "Ctrl+R";
  const undoShortcut = getActionShortcut("edit.undo") ?? "Ctrl+Z";
  const redoShortcut = getActionShortcut("edit.redo") ?? "Ctrl+Shift+Z";
  const selectToolShortcut = getActionShortcut("tools.selectTool") ?? "V";
  const splitToolShortcut = getActionShortcut("tools.splitTool") ?? "B";
  const muteToolShortcut = getActionShortcut("tools.muteTool") ?? "X";
  const smartToolShortcut = getActionShortcut("tools.smartTool") ?? "Y";
  const timelineScopeLabel = getActionShortcutScopeLabel("timeline");
  const {
    isPlaying,
    isPaused,
    loopEnabled,
    play,
    record,
    stop,
    toggleLoop,
    tracks,
    snapEnabled,
    toggleSnap,
    undo,
    redo,
    canUndo,
    canRedo,
    autoCrossfade,
    toggleAutoCrossfade,
    toolMode,
    setToolMode,
    toggleSplitTool,
    toggleMuteTool,
    showPitchEditor,
  } = useDAWStore(
    useShallow((s) => ({
      isPlaying: s.transport.isPlaying,
      isPaused: s.transport.isPaused,
      loopEnabled: s.transport.loopEnabled,
      play: s.play,
      record: s.record,
      stop: s.stop,
      toggleLoop: s.toggleLoop,
      tracks: s.tracks,
      snapEnabled: s.snapEnabled,
      toggleSnap: s.toggleSnap,
      undo: s.undo,
      redo: s.redo,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      autoCrossfade: s.autoCrossfade,
      toggleAutoCrossfade: s.toggleAutoCrossfade,
      toolMode: s.toolMode,
      setToolMode: s.setToolMode,
      toggleSplitTool: s.toggleSplitTool,
      toggleMuteTool: s.toggleMuteTool,
      showPitchEditor: s.showPitchEditor,
    })),
  );

  // When pitch editor is open, delegate undo/redo to its own stack
  const peUndo = usePitchEditorStore((s) => s.undo);
  const peRedo = usePitchEditorStore((s) => s.redo);
  const peUndoStack = usePitchEditorStore((s) => s.undoStack);
  const peRedoStack = usePitchEditorStore((s) => s.redoStack);

  const effectiveUndo = showPitchEditor ? peUndo : undo;
  const effectiveRedo = showPitchEditor ? peRedo : redo;
  const effectiveCanUndo = showPitchEditor ? peUndoStack.length > 0 : canUndo;
  const effectiveCanRedo = showPitchEditor ? peRedoStack.length > 0 : canRedo;
  const hasArmedTracks = tracks.some((t) => t.armed);

  const handleAiToolsClick = async () => {
    if (aiToolsStatus.installInProgress || aiToolsStatus.available) {
      return;
    }

    if (aiToolsStatus.state === "pythonMissing") {
      await openHelp();
      return;
    }

    await install();
  };

  const aiToolsTitle = aiToolsStatus.available
    ? "AI Tools Ready"
    : aiToolsStatus.installInProgress
      ? aiToolsStatus.message || "Installing AI Tools..."
      : aiToolsStatus.state === "pythonMissing"
        ? "Install Python, then retry AI Tools"
        : "Install AI Tools";

  return (
    <div
      className="h-12 bg-neutral-900 border-b border-b-neutral-950 flex items-center px-4 gap-4 shrink-0"
      role="toolbar"
      aria-label="Main Toolbar"
    >
      {/* Transport Section */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Transport Controls"
      >
        <Button
          variant="purple"
          size="icon-lg"
          active={loopEnabled}
          onClick={toggleLoop}
          title={`Toggle Loop (${loopShortcut})`}
          aria-label={loopEnabled ? "Disable Loop" : "Enable Loop"}
        >
          <Repeat size={16} />
        </Button>
        <Button
          variant="danger"
          size="icon-lg"
          active={hasArmedTracks && isPlaying}
          disabled={!hasArmedTracks}
          onClick={() => record()}
          title={hasArmedTracks ? `Record (${recordShortcut})` : "Arm a track to record"}
          aria-label={hasArmedTracks ? "Record" : "Arm a track to record"}
        >
          <Circle size={16} fill="currentColor" />
        </Button>
        <Button
          variant="success"
          size="icon-lg"
          active={isPlaying}
          onClick={() => play()}
          title="Play (Space)"
          aria-label="Play"
        >
          <Play size={16} fill="currentColor" />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled={!isPlaying && !isPaused}
          onClick={() => stop()}
          title="Stop (Space)"
          aria-label="Stop"
        >
          <Square size={14} fill="currentColor" />
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* Edit Tools */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Edit Tools"
      >
        <Button
          variant="default"
          size="icon-lg"
          disabled={!effectiveCanUndo}
          onClick={effectiveUndo}
          title={`Undo (${undoShortcut})`}
          aria-label="Undo"
        >
          <Undo2 size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          disabled={!effectiveCanRedo}
          onClick={effectiveRedo}
          title={`Redo (${redoShortcut})`}
          aria-label="Redo"
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
          aria-label={
            snapEnabled ? "Disable Snap to Grid" : "Enable Snap to Grid"
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
          aria-label={
            autoCrossfade ? "Disable Auto-Crossfade" : "Enable Auto-Crossfade"
          }
        >
          <Blend size={16} />
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* Tool Mode */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Tool Mode"
      >
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "select"}
          onClick={() => setToolMode("select")}
          title={`Select Tool (${timelineScopeLabel}: ${selectToolShortcut})`}
          aria-label="Select Tool"
        >
          <MousePointer size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "split"}
          onClick={toggleSplitTool}
          title={`Split Tool (${timelineScopeLabel}: ${splitToolShortcut})`}
          aria-label="Split Tool"
        >
          <Scissors size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "mute"}
          onClick={toggleMuteTool}
          title={`Mute Tool (${timelineScopeLabel}: ${muteToolShortcut})`}
          aria-label="Mute Tool"
        >
          <VolumeX size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          active={toolMode === "smart"}
          onClick={() => setToolMode("smart")}
          title={`Smart Tool (${timelineScopeLabel}: ${smartToolShortcut}) - auto-switches between move/trim/fade`}
          aria-label="Smart Tool"
        >
          <Wand2 size={16} />
        </Button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* View Toggles - Mixer Now Works! */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="View Toggles"
      >
        <Button
          variant="default"
          size="icon-lg"
          active={showMixer}
          onClick={onToggleMixer}
          title={`Toggle Mixer (${mixerShortcut})`}
          aria-label={showMixer ? "Hide Mixer" : "Show Mixer"}
        >
          <SlidersHorizontal size={16} />
        </Button>
      </div>

      <div style={{ flex: 1 }}></div>

      {/* Settings */}
      <div className="flex items-center gap-1">
        <Button
          variant={aiToolsStatus.available ? "success" : aiToolsStatus.installInProgress ? "primary" : "default"}
          size="icon-lg"
          active={aiToolsStatus.available || aiToolsStatus.installInProgress}
          onClick={() => void handleAiToolsClick()}
          title={aiToolsTitle}
          aria-label="AI Tools"
        >
          <Cpu size={16} />
        </Button>
        <Button
          variant="default"
          size="icon-lg"
          onClick={onOpenSettings}
          title="Audio Settings"
          aria-label="Audio Settings"
        >
          <Settings size={16} />
        </Button>
      </div>
    </div>
  );
}
