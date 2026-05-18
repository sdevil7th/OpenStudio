import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import {
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  Music,
  RotateCcw,
  Snowflake,
  Volume2,
  VolumeX,
  Wand2,
} from "lucide-react";
import type { MIDIClip, PianoRollTool, PianoRollVisibleLane } from "../store/useDAWStore";
import { chooseResponsiveToolbarGroups } from "../utils/responsiveToolbar";
import type { ResponsiveToolbarGroup } from "../utils/responsiveToolbar";
import { NOTE_NAMES, SCALE_DISPLAY_NAMES } from "../utils/pianoRollPitch";
import { PIANO_ROLL_TOOL_BUTTONS } from "../utils/pianoRollTools";
import {
  SNAP_TYPE_OPTIONS,
  type GridSize,
  type QuantizePreset,
  type SnapType,
} from "../utils/snapToGrid";

interface StepSizeOption {
  label: string;
  beats: number;
}

interface PianoRollToolbarProps {
  readonly tool: PianoRollTool;
  readonly onToolChange: (tool: PianoRollTool) => void;
  readonly scaleRoot: number;
  readonly scaleType: string;
  readonly onScaleRootChange: (scaleRoot: number) => void;
  readonly onScaleTypeChange: (scaleType: string) => void;
  readonly selectedCount: number;
  readonly noteCount: number;
  readonly onSnapSelectedToScale: () => void;
  readonly auditionEnabled: boolean;
  readonly onAuditionEnabledChange: (enabled: boolean) => void;
  readonly insertVelocity: number;
  readonly onInsertVelocityChange: (velocity: number) => void;
  readonly stepInputEnabled: boolean;
  readonly onToggleStepInput: () => void;
  readonly stepInputSize: number;
  readonly stepSizeOptions: readonly StepSizeOption[];
  readonly onStepInputSizeChange: (stepSize: number) => void;
  readonly clipOptions: readonly MIDIClip[];
  readonly activeClipId: string;
  readonly onActiveClipChange: (clipId: string) => void;
  readonly showSelectedMIDIClipRefs: boolean;
  readonly onShowSelectedMIDIClipRefsChange: (show: boolean) => void;
  readonly showGhostMIDIClips: boolean;
  readonly onShowGhostMIDIClipsChange: (show: boolean) => void;
  readonly visibleLanes: readonly PianoRollVisibleLane[];
  readonly activeLaneId?: string;
  readonly onActiveLaneChange: (laneId: string) => void;
  readonly snapEnabled: boolean;
  readonly onSnapToggle: () => void;
  readonly snapType: SnapType;
  readonly onSnapTypeChange: (snapType: SnapType) => void;
  readonly gridSize: GridSize;
  readonly onGridSizeChange: (gridSize: GridSize) => void;
  readonly gridTypeOptions: readonly { value: GridSize; label: string }[];
  readonly quantizePresetId: string;
  readonly quantizePresets: readonly QuantizePreset[];
  readonly onQuantizePresetChange: (presetId: string) => void;
  readonly onApplyQuantize: () => void;
  readonly onLengthQuantize: () => void;
  readonly onQuantizeLast: () => void;
  readonly onOpenQuantizeDialog: () => void;
  readonly onResetQuantize: () => void;
  readonly onFreezeQuantize: () => void;
  readonly onDetach?: () => void;
}

type ToolbarGroupId =
  | "tools"
  | "scale"
  | "lane"
  | "quantize"
  | "audition"
  | "step"
  | "popout"
  | "clip";

type ToolbarPlacement = "inline" | "overflow" | "measure";

interface MeasuredToolbarState {
  availableWidth: number;
  groupWidths: Record<string, number>;
  gap: number;
  moreButtonWidth: number;
}

const LEFT_GROUP_IDS: ToolbarGroupId[] = ["scale", "lane", "quantize", "audition", "step"];
const RIGHT_GROUP_IDS: ToolbarGroupId[] = ["popout", "clip"];
const DEFAULT_MORE_BUTTON_WIDTH = 70;
const DEFAULT_TOOLBAR_GAP = 10;

const OVERFLOW_ORDER: Record<ToolbarGroupId, number> = {
  tools: Number.POSITIVE_INFINITY,
  popout: 10,
  clip: 20,
  step: 30,
  quantize: 40,
  scale: 50,
  lane: 60,
  audition: 70,
};

function setForwardedRef<T>(ref: Ref<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

function parseCssPixels(value: string | null | undefined, fallback: number) {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function measuredStateEquals(a: MeasuredToolbarState, b: MeasuredToolbarState) {
  if (
    Math.abs(a.availableWidth - b.availableWidth) > 0.5
    || Math.abs(a.gap - b.gap) > 0.5
    || Math.abs(a.moreButtonWidth - b.moreButtonWidth) > 0.5
  ) {
    return false;
  }
  const aKeys = Object.keys(a.groupWidths);
  const bKeys = Object.keys(b.groupWidths);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Math.abs((a.groupWidths[key] ?? 0) - (b.groupWidths[key] ?? 0)) <= 0.5);
}

function controlId(placement: ToolbarPlacement, id: string) {
  if (placement === "inline") return `pr-${id}`;
  return `pr-${placement}-${id}`;
}

function preventToolbarButtonFocus(event: ReactMouseEvent<HTMLButtonElement>) {
  if (event.button === 0) {
    event.preventDefault();
  }
}

export const PianoRollToolbar = forwardRef<HTMLDivElement, PianoRollToolbarProps>(
  function PianoRollToolbar(
    {
      tool,
      onToolChange,
      scaleRoot,
      scaleType,
      onScaleRootChange,
      onScaleTypeChange,
      selectedCount,
      noteCount,
      onSnapSelectedToScale,
      auditionEnabled,
      onAuditionEnabledChange,
      insertVelocity,
      onInsertVelocityChange,
      stepInputEnabled,
      onToggleStepInput,
      stepInputSize,
      stepSizeOptions,
      onStepInputSizeChange,
      clipOptions,
      activeClipId,
      onActiveClipChange,
      showSelectedMIDIClipRefs,
      onShowSelectedMIDIClipRefsChange,
      showGhostMIDIClips,
      onShowGhostMIDIClipsChange,
      visibleLanes,
      activeLaneId,
      onActiveLaneChange,
      snapEnabled,
      onSnapToggle,
      snapType,
      onSnapTypeChange,
      gridSize,
      onGridSizeChange,
      gridTypeOptions,
      quantizePresetId,
      quantizePresets,
      onQuantizePresetChange,
      onApplyQuantize,
      onLengthQuantize,
      onQuantizeLast,
      onOpenQuantizeDialog,
      onResetQuantize,
      onFreezeQuantize,
      onDetach,
    },
    forwardedRef,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const measureRef = useRef<HTMLDivElement | null>(null);
    const moreWrapRef = useRef<HTMLDivElement | null>(null);
    const [measuredState, setMeasuredState] = useState<MeasuredToolbarState>({
      availableWidth: Number.POSITIVE_INFINITY,
      groupWidths: {},
      gap: DEFAULT_TOOLBAR_GAP,
      moreButtonWidth: DEFAULT_MORE_BUTTON_WIDTH,
    });
    const [isOverflowOpen, setIsOverflowOpen] = useState(false);
    const resizeObserverAvailable = typeof ResizeObserver !== "undefined";

    const setRootRef = useCallback((node: HTMLDivElement | null) => {
      rootRef.current = node;
      setForwardedRef(forwardedRef, node);
    }, [forwardedRef]);

    const toolbarGroups = useMemo<ResponsiveToolbarGroup[]>(() => {
      const groups: ResponsiveToolbarGroup[] = [
        {
          id: "tools",
          fixed: true,
          width: measuredState.groupWidths.tools ?? 0,
          overflowOrder: OVERFLOW_ORDER.tools,
        },
        {
          id: "scale",
          width: measuredState.groupWidths.scale ?? 0,
          overflowOrder: OVERFLOW_ORDER.scale,
        },
        {
          id: "lane",
          width: measuredState.groupWidths.lane ?? 0,
          overflowOrder: OVERFLOW_ORDER.lane,
        },
        {
          id: "quantize",
          width: measuredState.groupWidths.quantize ?? 0,
          overflowOrder: OVERFLOW_ORDER.quantize,
        },
        {
          id: "audition",
          width: measuredState.groupWidths.audition ?? 0,
          overflowOrder: OVERFLOW_ORDER.audition,
        },
        {
          id: "step",
          width: measuredState.groupWidths.step ?? 0,
          overflowOrder: OVERFLOW_ORDER.step,
        },
      ];
      if (onDetach) {
        groups.push({
          id: "popout",
          width: measuredState.groupWidths.popout ?? 0,
          overflowOrder: OVERFLOW_ORDER.popout,
        });
      }
      groups.push({
        id: "clip",
        width: measuredState.groupWidths.clip ?? 0,
        overflowOrder: OVERFLOW_ORDER.clip,
      });
      return groups;
    }, [measuredState.groupWidths, onDetach]);

    const responsiveLayout = useMemo(() => {
      if (!resizeObserverAvailable) {
        return {
          visibleIds: toolbarGroups.map((group) => group.id),
          overflowIds: [],
          hasOverflow: false,
        };
      }
      return chooseResponsiveToolbarGroups({
        availableWidth: measuredState.availableWidth,
        groups: toolbarGroups,
        gap: measuredState.gap,
        moreButtonWidth: measuredState.moreButtonWidth,
      });
    }, [
      measuredState.availableWidth,
      measuredState.gap,
      measuredState.moreButtonWidth,
      resizeObserverAvailable,
      toolbarGroups,
    ]);

    const visibleGroupIds = useMemo(
      () => new Set<ToolbarGroupId>(responsiveLayout.visibleIds as ToolbarGroupId[]),
      [responsiveLayout.visibleIds],
    );
    const overflowGroupIds = responsiveLayout.overflowIds as ToolbarGroupId[];

    const measureToolbar = useCallback(() => {
      const root = rootRef.current;
      const measure = measureRef.current;
      if (!root || !measure) return;

      const rootStyle = window.getComputedStyle(root);
      const paddingX = parseCssPixels(rootStyle.paddingLeft, 0) + parseCssPixels(rootStyle.paddingRight, 0);
      const availableWidth = Math.max(0, root.clientWidth - paddingX);
      const gap = parseCssPixels(rootStyle.columnGap || rootStyle.gap, DEFAULT_TOOLBAR_GAP);
      const groupWidths: Record<string, number> = {};
      measure.querySelectorAll<HTMLElement>("[data-measure-group-id]").forEach((element) => {
        const id = element.dataset.measureGroupId;
        if (id) groupWidths[id] = element.offsetWidth;
      });
      const moreButton = measure.querySelector<HTMLElement>("[data-measure-more]");
      const nextState: MeasuredToolbarState = {
        availableWidth,
        groupWidths,
        gap,
        moreButtonWidth: moreButton?.offsetWidth || DEFAULT_MORE_BUTTON_WIDTH,
      };
      setMeasuredState((previous) => measuredStateEquals(previous, nextState) ? previous : nextState);
    }, []);

    useLayoutEffect(() => {
      measureToolbar();
    });

    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root || typeof ResizeObserver === "undefined") return undefined;
      const resizeObserver = new ResizeObserver(() => measureToolbar());
      resizeObserver.observe(root);
      return () => resizeObserver.disconnect();
    }, [measureToolbar]);

    useEffect(() => {
      if (!isOverflowOpen) return undefined;
      const handlePointerDown = (event: MouseEvent) => {
        if (moreWrapRef.current && !moreWrapRef.current.contains(event.target as Node)) {
          setIsOverflowOpen(false);
        }
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") setIsOverflowOpen(false);
      };
      document.addEventListener("mousedown", handlePointerDown);
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("mousedown", handlePointerDown);
        document.removeEventListener("keydown", handleKeyDown);
      };
    }, [isOverflowOpen]);

    useEffect(() => {
      if (!responsiveLayout.hasOverflow) setIsOverflowOpen(false);
    }, [responsiveLayout.hasOverflow]);

    const groupAttributes = (id: ToolbarGroupId, placement: ToolbarPlacement) => {
      if (placement === "measure") {
        return { "data-measure-group-id": id };
      }
      return {
        "data-qa": "piano-roll-toolbar-group",
        "data-toolbar-group-id": id,
        "data-overflow-state": placement === "overflow" ? "overflow" : "visible",
      };
    };

    const renderTools = (placement: ToolbarPlacement) => (
      <div
        key={`${placement}-tools`}
        className="piano-roll-tool-cluster"
        role="toolbar"
        aria-label="Piano roll tools"
        {...groupAttributes("tools", placement)}
      >
        {PIANO_ROLL_TOOL_BUTTONS.map(({ tool: toolId, label, shortcut, Icon }) => (
          <button
            key={toolId}
            type="button"
            className="piano-roll-icon-tool"
            data-active={tool === toolId}
            aria-pressed={tool === toolId}
            title={`${label} Tool (${shortcut})`}
            data-tooltip={`${label} tool (${shortcut})`}
            aria-label={`${label} tool (${shortcut})`}
            onMouseDown={preventToolbarButtonFocus}
            onClick={() => onToolChange(toolId)}
            tabIndex={placement === "measure" ? -1 : undefined}
          >
            <Icon size={15} strokeWidth={2.1} />
          </button>
        ))}
      </div>
    );

    const renderScaleGroup = (placement: ToolbarPlacement) => (
      <div
        key={`${placement}-scale`}
        className="piano-roll-key-strip-group"
        {...groupAttributes("scale", placement)}
      >
        <Music size={14} />
        <select
          className="piano-roll-compact-select"
          value={scaleRoot}
          onChange={(event) => onScaleRootChange(Number.parseInt(event.target.value, 10))}
          title="Scale root"
          aria-label="Scale root"
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          {NOTE_NAMES.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <select
          className="piano-roll-compact-select"
          value={scaleType}
          onChange={(event) => onScaleTypeChange(event.target.value)}
          title="Scale"
          aria-label="Scale"
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          {Object.entries(SCALE_DISPLAY_NAMES).map(([key, displayLabel]) => (
            <option key={key} value={key}>{displayLabel}</option>
          ))}
        </select>
        <button
          type="button"
          className="piano-roll-strip-command"
          disabled={selectedCount === 0 || scaleType === "chromatic"}
          onClick={onSnapSelectedToScale}
          title="Snap selected notes to scale"
          data-tooltip="Snap selected notes to the active scale"
          aria-label="Snap selected notes to the active scale"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          <Wand2 size={13} />
        </button>
      </div>
    );

    const renderLaneGroup = (placement: ToolbarPlacement) => {
      const laneId = controlId(placement, "visible-lane");
      return (
        <div
          key={`${placement}-lane`}
          className="piano-roll-key-strip-group"
          {...groupAttributes("lane", placement)}
        >
          <label className="piano-roll-strip-readout" htmlFor={laneId}>Lane</label>
          <select
            id={laneId}
            className="piano-roll-compact-select piano-roll-lane-select"
            value={activeLaneId ?? visibleLanes[0]?.id ?? "velocity"}
            onChange={(event) => onActiveLaneChange(event.target.value)}
            title="Visible controller lane"
            aria-label="Visible controller lane"
            tabIndex={placement === "measure" ? -1 : undefined}
          >
            {visibleLanes.map((lane) => (
              <option key={lane.id} value={lane.id}>{lane.label}</option>
            ))}
          </select>
        </div>
      );
    };

    const renderQuantizeGroup = (placement: ToolbarPlacement) => (
      <div
        key={`${placement}-quantize`}
        className="piano-roll-key-strip-group"
        {...groupAttributes("quantize", placement)}
      >
        <button
          type="button"
          className="piano-roll-strip-command"
          data-active={snapEnabled}
          onClick={onSnapToggle}
          title={snapEnabled ? "Snap enabled" : "Snap disabled"}
          data-tooltip={snapEnabled ? "Disable snap" : "Enable snap"}
          aria-label={snapEnabled ? "Disable snap" : "Enable snap"}
          aria-pressed={snapEnabled}
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          Snap
        </button>
        <select
          className="piano-roll-compact-select piano-roll-snap-type-select"
          value={snapType}
          onChange={(event) => onSnapTypeChange(event.target.value as SnapType)}
          title="Snap type"
          aria-label="Snap type"
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          {SNAP_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="piano-roll-compact-select piano-roll-grid-select"
          value={gridSize}
          onChange={(event) => onGridSizeChange(event.target.value as GridSize)}
          title="Grid type"
          aria-label="Grid type"
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          {gridTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="piano-roll-compact-select piano-roll-quantize-preset-select"
          value={quantizePresetId}
          onChange={(event) => onQuantizePresetChange(event.target.value)}
          title="Quantize preset"
          aria-label="Quantize preset"
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          {quantizePresets.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.name}</option>
          ))}
        </select>
        <button
          type="button"
          className="piano-roll-strip-command piano-roll-quantize-command"
          onClick={onApplyQuantize}
          title="Apply selected quantize preset"
          data-tooltip="Apply selected quantize preset"
          aria-label="Apply selected quantize preset"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          Apply
        </button>
        <button
          type="button"
          className="piano-roll-strip-command piano-roll-quantize-command"
          onClick={onQuantizeLast}
          title="Quantize notes using last settings (Q). If no notes are selected, quantize the whole active clip."
          data-tooltip="Quantize using last settings (Q)"
          aria-label="Quantize notes using last settings"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          Q
        </button>
        <button
          type="button"
          className="piano-roll-strip-command"
          onClick={onOpenQuantizeDialog}
          title="Open detailed Quantize settings. Shortcut: Q applies the last quantize settings."
          data-tooltip="Open Quantize settings. Q applies last settings."
          aria-label="Open detailed Quantize settings"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          Panel
        </button>
        <button
          type="button"
          className="piano-roll-strip-command"
          onClick={onLengthQuantize}
          title="Length Quantize using the selected preset"
          data-tooltip="Length Quantize using selected preset"
          aria-label="Length Quantize using selected preset"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          Length
        </button>
        <button
          type="button"
          className="piano-roll-strip-command"
          onClick={onResetQuantize}
          title="Reset the last applied MIDI quantize"
          data-tooltip="Reset MIDI quantize"
          aria-label="Reset MIDI quantize"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          <RotateCcw size={13} />
        </button>
        <button
          type="button"
          className="piano-roll-strip-command"
          onClick={onFreezeQuantize}
          title="Freeze MIDI quantize as the new note timing"
          data-tooltip="Freeze MIDI quantize"
          aria-label="Freeze MIDI quantize"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          <Snowflake size={13} />
        </button>
      </div>
    );

    const renderAuditionGroup = (placement: ToolbarPlacement) => {
      const velocityId = controlId(placement, "insert-velocity");
      return (
        <div
          key={`${placement}-audition`}
          className="piano-roll-key-strip-group"
          {...groupAttributes("audition", placement)}
        >
          <button
            type="button"
            className="piano-roll-strip-command"
            data-active={auditionEnabled}
            onClick={() => onAuditionEnabledChange(!auditionEnabled)}
            title={auditionEnabled ? "Audition enabled" : "Audition disabled"}
            data-tooltip={auditionEnabled ? "Disable MIDI note audition" : "Enable MIDI note audition"}
            aria-label={auditionEnabled ? "Disable MIDI note audition" : "Enable MIDI note audition"}
            onMouseDown={preventToolbarButtonFocus}
            tabIndex={placement === "measure" ? -1 : undefined}
          >
            {auditionEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>
          <label className="piano-roll-strip-readout" htmlFor={velocityId}>Vel</label>
          <input
            id={velocityId}
            className="piano-roll-compact-number"
            type="number"
            min={1}
            max={127}
            value={insertVelocity}
            onChange={(event) => onInsertVelocityChange(Number(event.target.value))}
            title="Insert velocity"
            aria-label="Insert velocity"
            tabIndex={placement === "measure" ? -1 : undefined}
          />
        </div>
      );
    };

    const renderStepGroup = (placement: ToolbarPlacement) => (
      <div
        key={`${placement}-step`}
        className="piano-roll-key-strip-group"
        {...groupAttributes("step", placement)}
      >
        <button
          type="button"
          className="piano-roll-strip-command"
          data-active={stepInputEnabled}
          onClick={onToggleStepInput}
          title="Step input"
          data-tooltip="Toggle step input"
          aria-label="Toggle step input"
          onMouseDown={preventToolbarButtonFocus}
          tabIndex={placement === "measure" ? -1 : undefined}
        >
          Step
        </button>
        {stepInputEnabled && (
          <select
            className="piano-roll-compact-select"
            value={stepInputSize}
            onChange={(event) => onStepInputSizeChange(Number.parseFloat(event.target.value))}
            title="Step size"
            aria-label="Step input size"
            tabIndex={placement === "measure" ? -1 : undefined}
          >
            {stepSizeOptions.map((option) => (
              <option key={option.label} value={option.beats}>{option.label}</option>
            ))}
          </select>
        )}
      </div>
    );

    const renderPopoutGroup = (placement: ToolbarPlacement) => {
      if (!onDetach) return null;
      return (
        <div
          key={`${placement}-popout`}
          className="piano-roll-key-strip-group"
          {...groupAttributes("popout", placement)}
        >
          <button
            type="button"
            className="piano-roll-strip-command"
            onClick={onDetach}
            title="Pop out this MIDI clip to a separate editor window"
            data-tooltip="Pop out this MIDI clip"
            aria-label="Pop out this MIDI clip to a separate editor window"
            onMouseDown={preventToolbarButtonFocus}
            tabIndex={placement === "measure" ? -1 : undefined}
          >
            <ExternalLink size={13} />
            Pop Out
          </button>
        </div>
      );
    };

    const renderClipGroup = (placement: ToolbarPlacement) => (
      <div
        key={`${placement}-clip`}
        className="piano-roll-key-strip-group piano-roll-clip-group"
        {...groupAttributes("clip", placement)}
      >
        {clipOptions.length > 1 && (
          <select
            className="piano-roll-compact-select piano-roll-clip-select"
            value={activeClipId}
            onChange={(event) => onActiveClipChange(event.target.value)}
            title="Active editable MIDI clip"
            aria-label="Active editable MIDI clip"
            tabIndex={placement === "measure" ? -1 : undefined}
          >
            {clipOptions.map((option, index) => (
              <option key={option.id} value={option.id}>
                {option.name || `MIDI Clip ${index + 1}`}
              </option>
            ))}
          </select>
        )}
        <label className="piano-roll-strip-toggle" title="Show colored selected-clip references" data-tooltip="Show colored selected-clip references">
          <input
            type="checkbox"
            checked={showSelectedMIDIClipRefs}
            onChange={(event) => onShowSelectedMIDIClipRefsChange(event.target.checked)}
            tabIndex={placement === "measure" ? -1 : undefined}
          />
          Refs
        </label>
        <label className="piano-roll-strip-toggle" title="Show ghost MIDI clips on this track" data-tooltip="Show ghost MIDI clips on this track">
          <input
            type="checkbox"
            checked={showGhostMIDIClips}
            onChange={(event) => onShowGhostMIDIClipsChange(event.target.checked)}
            tabIndex={placement === "measure" ? -1 : undefined}
          />
          Ghost
        </label>
        <span className="piano-roll-strip-readout">
          {selectedCount ? `${selectedCount} selected` : `${noteCount} notes`}
        </span>
      </div>
    );

    const renderGroup = (id: ToolbarGroupId, placement: ToolbarPlacement) => {
      switch (id) {
        case "tools":
          return renderTools(placement);
        case "scale":
          return renderScaleGroup(placement);
        case "lane":
          return renderLaneGroup(placement);
        case "quantize":
          return renderQuantizeGroup(placement);
        case "audition":
          return renderAuditionGroup(placement);
        case "step":
          return renderStepGroup(placement);
        case "popout":
          return renderPopoutGroup(placement);
        case "clip":
          return renderClipGroup(placement);
        default:
          return null;
      }
    };

    const renderMoreButton = (placement: ToolbarPlacement) => (
      <button
        type="button"
        className="piano-roll-strip-command piano-roll-toolbar-more-button"
        data-measure-more={placement === "measure" ? true : undefined}
        data-qa={placement === "inline" ? "piano-roll-toolbar-more" : undefined}
        data-active={placement === "inline" ? isOverflowOpen : undefined}
        aria-haspopup="menu"
        aria-expanded={placement === "inline" ? isOverflowOpen : undefined}
        aria-label="More MIDI editor toolbar controls"
        title="More MIDI editor toolbar controls"
        onMouseDown={preventToolbarButtonFocus}
        onClick={() => setIsOverflowOpen((open) => !open)}
        tabIndex={placement === "measure" ? -1 : undefined}
      >
        <MoreHorizontal size={13} />
        More
        <ChevronDown size={12} />
      </button>
    );

    const leftVisibleIds = LEFT_GROUP_IDS.filter((id) => visibleGroupIds.has(id));
    const rightVisibleIds = RIGHT_GROUP_IDS.filter((id) => visibleGroupIds.has(id));
    const allMeasureIds = toolbarGroups.map((group) => group.id as ToolbarGroupId);

    return (
      <div
        className="piano-roll-key-strip"
        ref={setRootRef}
        data-qa="piano-roll-responsive-toolbar"
        data-responsive-mode={resizeObserverAvailable ? "overflow" : "scroll"}
        data-overflow-active={responsiveLayout.hasOverflow}
        data-visible-group-ids={responsiveLayout.visibleIds.join(" ")}
        data-overflow-group-ids={responsiveLayout.overflowIds.join(" ")}
      >
        {renderTools("inline")}
        {leftVisibleIds.map((id) => renderGroup(id, "inline"))}
        <div className="piano-roll-key-strip-spacer" />
        {rightVisibleIds.map((id) => renderGroup(id, "inline"))}
        {responsiveLayout.hasOverflow && (
          <div className="piano-roll-toolbar-more-wrap" ref={moreWrapRef}>
            {renderMoreButton("inline")}
            {isOverflowOpen && (
              <div
                className="piano-roll-toolbar-overflow-menu"
                data-qa="piano-roll-toolbar-overflow-menu"
                role="menu"
                aria-label="More MIDI editor toolbar controls"
              >
                {overflowGroupIds.map((id) => renderGroup(id, "overflow"))}
              </div>
            )}
          </div>
        )}
        <div
          className="piano-roll-toolbar-measurer"
          ref={measureRef}
          aria-hidden="true"
        >
          {allMeasureIds.map((id) => renderGroup(id, "measure"))}
          {renderMoreButton("measure")}
        </div>
      </div>
    );
  },
);
