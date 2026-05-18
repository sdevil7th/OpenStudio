import { useEffect, useMemo, useRef, useState } from "react";
import {
  Repeat,
  Circle,
  Play,
  Square,
  Undo2,
  Redo2,
  Grid3x3,
  Check,
  ChevronDown,
  SlidersHorizontal,
  Settings,
  Blend,
  MousePointer,
  Scissors,
  VolumeX,
  Wand2,
} from "lucide-react";
import { usePitchEditorStore } from "../store/pitchEditorStore";
import { getDisplayShortcut, getActionShortcutScopeLabel } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, NativeSelect } from "./ui";
import {
  calculateGridInterval,
  GRID_TYPE_MODE_OPTIONS,
  SNAP_TYPE_OPTIONS,
  getGridSizeLabel,
  getQuantizePresetById,
  ticksToSeconds,
  type GridSize,
  type SnapType,
} from "../utils/snapToGrid";

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
  const [showQuantizePanel, setShowQuantizePanel] = useState(false);
  const [quantizeApplyState, setQuantizeApplyState] = useState<"idle" | "applied">("idle");
  const gridPanelRef = useRef<HTMLSpanElement | null>(null);
  const applyCloseTimerRef = useRef<number | null>(null);
  const mixerShortcut = getDisplayShortcut("view.toggleMixer") ?? "Ctrl+M";
  const loopShortcut = getDisplayShortcut("transport.loop") ?? "L";
  const recordShortcut = getDisplayShortcut("transport.record") ?? "Ctrl+R";
  const undoShortcut = getDisplayShortcut("edit.undo") ?? "Ctrl+Z";
  const redoShortcut = getDisplayShortcut("edit.redo") ?? "Ctrl+Shift+Z";
  const selectToolShortcut = getDisplayShortcut("tools.selectTool") ?? "V";
  const splitToolShortcut = getDisplayShortcut("tools.splitTool") ?? "B";
  const muteToolShortcut = getDisplayShortcut("tools.muteTool") ?? "X";
  const smartToolShortcut = getDisplayShortcut("tools.smartTool") ?? "Y";
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
    snapType,
    setSnapType,
    gridSize,
    setGridSize,
    quantizePresetId,
    quantizePresets,
    setQuantizePresetId,
    saveQuantizePreset,
    renameQuantizePreset,
    removeQuantizePreset,
    restoreFactoryQuantizePresets,
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
    aiToolsStatus,
    openAiToolsSetup,
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
      snapType: s.snapType,
      setSnapType: s.setSnapType,
      gridSize: s.gridSize,
      setGridSize: s.setGridSize,
      quantizePresetId: s.quantizePresetId,
      quantizePresets: s.quantizePresets,
      setQuantizePresetId: s.setQuantizePresetId,
      saveQuantizePreset: s.saveQuantizePreset,
      renameQuantizePreset: s.renameQuantizePreset,
      removeQuantizePreset: s.removeQuantizePreset,
      restoreFactoryQuantizePresets: s.restoreFactoryQuantizePresets,
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
      aiToolsStatus: s.aiToolsStatus,
      openAiToolsSetup: s.openAiToolsSetup,
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
  const gridOptions = useMemo(
    () => [...GRID_TYPE_MODE_OPTIONS],
    [],
  );
  const quantizeOptions = useMemo(
    () => quantizePresets.map((preset) => ({
      value: preset.id,
      label: preset.name,
    })),
    [quantizePresets],
  );
  const selectedQuantizePreset = useMemo(
    () => getQuantizePresetById(quantizePresets, quantizePresetId),
    [quantizePresetId, quantizePresets],
  );
  const toolbarGridLabel = getGridSizeLabel(
    gridSize === "use_quantize" ? selectedQuantizePreset.gridSize : gridSize,
  );

  useEffect(() => {
    if (!showQuantizePanel) return undefined;
    setQuantizeApplyState("idle");
    const handlePointerDown = (event: MouseEvent) => {
      if (!gridPanelRef.current?.contains(event.target as Node)) {
        setShowQuantizePanel(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowQuantizePanel(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showQuantizePanel]);

  useEffect(() => {
    return () => {
      if (applyCloseTimerRef.current !== null) {
        window.clearTimeout(applyCloseTimerRef.current);
      }
    };
  }, []);

  const handleApplyQuantize = () => {
    const state = useDAWStore.getState();
    const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
    const gridSeconds = calculateGridInterval(
      state.transport.tempo,
      state.timeSignature,
      preset.gridSize,
      {
        quantizePreset: preset,
        quantizeGridSize: preset.gridSize,
        pixelsPerSecond: state.pixelsPerSecond,
      },
    );

    if (state.pianoRollTrackId && state.pianoRollClipId) {
      state.quantizeSelectedMIDINotes(
        state.pianoRollTrackId,
        state.pianoRollClipId,
        gridSeconds,
        preset.strength,
        {
          presetId: preset.id,
          gridSize: preset.gridSize,
          mode: "start",
          swing: preset.swing,
          groovePreset: preset.groovePreset,
          tupletDivisions: preset.tupletDivisions,
          catchRangeMs: ticksToSeconds(preset.catchRangeTicks, state.transport.tempo) * 1000,
          safeRangeMs: ticksToSeconds(preset.safeRangeTicks, state.transport.tempo) * 1000,
          randomizeMs: ticksToSeconds(preset.roughTicks, state.transport.tempo) * 1000,
          moveControllers: preset.moveControllers,
        },
      );
    } else {
      state.quantizeSelectedClips();
    }

    setQuantizeApplyState("applied");
    if (applyCloseTimerRef.current !== null) {
      window.clearTimeout(applyCloseTimerRef.current);
    }
    applyCloseTimerRef.current = window.setTimeout(() => {
      setShowQuantizePanel(false);
      setQuantizeApplyState("idle");
      applyCloseTimerRef.current = null;
    }, 450);
  };

  const handleSavePreset = () => {
    const name = window.prompt("Quantize preset name:", selectedQuantizePreset.name);
    if (!name) return;
    saveQuantizePreset(name, selectedQuantizePreset);
  };

  const handleRenamePreset = () => {
    if (selectedQuantizePreset.isFactory) return;
    const name = window.prompt("Rename quantize preset:", selectedQuantizePreset.name);
    if (!name) return;
    renameQuantizePreset(selectedQuantizePreset.id, name);
  };

  const handleRemovePreset = () => {
    if (selectedQuantizePreset.isFactory) return;
    if (!window.confirm(`Remove quantize preset "${selectedQuantizePreset.name}"?`)) return;
    removeQuantizePreset(selectedQuantizePreset.id);
  };

  const handleAiToolsClick = () => {
    openAiToolsSetup();
  };

  const aiToolsTitle = aiToolsStatus.available
    ? "AI Tools Ready"
    : aiToolsStatus.installInProgress
      ? aiToolsStatus.message || "Installing AI Tools..."
      : aiToolsStatus.buildRuntimeMode === "downloaded-runtime"
        ? aiToolsStatus.state === "error"
          ? "Repair AI Tools runtime download"
          : aiToolsStatus.state === "modelMissing"
            ? "Download the AI model to finish setup"
            : "Download AI Tools runtime"
      : aiToolsStatus.requiresExternalPython
        ? aiToolsStatus.state === "pythonMissing"
          ? "Install Python 3.10 to 3.13, then retry AI Tools"
          : "Install AI Tools with Python"
        : "Prepare AI Tools";

  const aiButtonProgress = Math.max(0, Math.min(1, aiToolsStatus.progress || 0));
  const aiButtonHaloStyle = aiToolsStatus.installInProgress
    ? {
        boxShadow: `0 0 0 2px rgba(34, 197, 94, ${0.35 + aiButtonProgress * 0.3}), inset 0 0 0 1px rgba(255,255,255,0.08)`,
        borderColor: "rgba(74, 222, 128, 0.95)",
      }
    : undefined;

  return (
    <div
      className="relative z-[2000] h-12 overflow-visible bg-neutral-900 border-b border-b-neutral-950 flex items-center px-4 gap-4 shrink-0"
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
        <span className="relative inline-flex" ref={gridPanelRef}>
          <Button
            variant="default"
            size="sm"
            active={showQuantizePanel}
            onClick={() => setShowQuantizePanel((value) => !value)}
            title="Grid, Snap, and Quantize settings"
            aria-label="Grid, Snap, and Quantize settings"
          >
            Grid: {toolbarGridLabel}
            <ChevronDown size={14} />
          </Button>
          {showQuantizePanel && (
            <div className="absolute right-0 top-full z-[3000] mt-2 w-[320px] rounded-md border border-neutral-700 bg-neutral-950 p-3 text-xs text-neutral-200 shadow-2xl shadow-black/70 ring-1 ring-black/50">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-normal text-neutral-500">Grid / Snap</div>
                  <div className="truncate text-sm font-semibold text-neutral-100">{toolbarGridLabel}</div>
                </div>
                <Button
                  variant={quantizeApplyState === "applied" ? "success" : "primary"}
                  size="sm"
                  onClick={handleApplyQuantize}
                  disabled={quantizeApplyState === "applied"}
                >
                  <Check size={13} />
                  {quantizeApplyState === "applied" ? "Applied" : "Apply"}
                </Button>
              </div>

              <div className="grid grid-cols-[90px_1fr] items-center gap-x-2 gap-y-2 border-t border-neutral-800 pt-3 text-[11px]">
                <span className="text-neutral-500">Snap Type</span>
                <NativeSelect
                  size="sm"
                  variant="compact"
                  className="w-full"
                  options={[...SNAP_TYPE_OPTIONS]}
                  value={snapType}
                  onChange={(value) => setSnapType(value as SnapType)}
                  title="Snap Type"
                />
                <span className="text-neutral-500">Grid Mode</span>
                <NativeSelect
                  size="sm"
                  variant="compact"
                  className="w-full"
                  options={gridOptions}
                  value={gridSize}
                  onChange={(value) => setGridSize(value as GridSize)}
                  title="Grid Mode"
                />
                <span className="text-neutral-500">Quantize</span>
                <NativeSelect
                  size="sm"
                  variant="compact"
                  className="w-full"
                  options={quantizeOptions}
                  value={quantizePresetId}
                  onChange={(value) => setQuantizePresetId(String(value))}
                  title="Quantize Presets"
                />
              </div>

              <div className="mt-3 grid grid-cols-[90px_1fr] gap-x-2 gap-y-1 border-t border-neutral-800 pt-3 text-[11px]">
                <span className="text-neutral-500">Strength</span>
                <span>{Math.round(selectedQuantizePreset.strength * 100)}%</span>
                <span className="text-neutral-500">Swing</span>
                <span>{Math.round(selectedQuantizePreset.swing * 100)}%</span>
                <span className="text-neutral-500">Tuplet</span>
                <span>{selectedQuantizePreset.tupletDivisions > 1 ? selectedQuantizePreset.tupletDivisions : "Off"}</span>
                <span className="text-neutral-500">Catch/Safe</span>
                <span>{selectedQuantizePreset.catchRangeTicks} / {selectedQuantizePreset.safeRangeTicks} ticks</span>
                <span className="text-neutral-500">Rough</span>
                <span>{selectedQuantizePreset.roughTicks} ticks</span>
              </div>

              <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t border-neutral-800 pt-3">
                <Button variant="default" size="sm" onClick={handleSavePreset}>Save</Button>
                <Button variant="default" size="sm" onClick={handleRenamePreset} disabled={selectedQuantizePreset.isFactory}>Rename</Button>
                <Button variant="default" size="sm" onClick={handleRemovePreset} disabled={selectedQuantizePreset.isFactory}>Remove</Button>
                <Button variant="default" size="sm" onClick={restoreFactoryQuantizePresets}>Restore</Button>
              </div>
            </div>
          )}
        </span>
        <Button
          variant={aiToolsStatus.available ? "success" : aiToolsStatus.installInProgress ? "primary" : "default"}
          size="icon-lg"
          active={aiToolsStatus.available || aiToolsStatus.installInProgress}
          onClick={() => void handleAiToolsClick()}
          title={aiToolsTitle}
          aria-label="AI Tools"
          style={aiButtonHaloStyle}
        >
          <span className="text-[10px] font-black leading-none tracking-normal">AI</span>
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
