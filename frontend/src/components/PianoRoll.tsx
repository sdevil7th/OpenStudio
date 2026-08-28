import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import {
  DEFAULT_PIANO_ROLL_VISIBLE_LANES,
  useDAWStore,
  MIDIEvent,
  MIDICCEvent,
  type PianoRollVisibleLane,
} from "../store/useDAWStore";
import { getEditableMidiClip } from "../store/actions/midi";
import {
  DEFAULT_PITCH_BEND_RANGE_SEMITONES,
  MIDI_PITCH_BEND_CENTER,
  MIDI_PITCH_BEND_MAX,
  type ControllerInterpolationMode,
  type ControllerLFOShape,
  clamp7Bit,
  combine14BitCCValue,
  generateControllerLFOEvents,
  generateControllerLineEvents,
  laneValueToPitchBend,
  pitchBendToLaneValue,
  pitchBendValueToLaneFraction,
  semitonesToPitchBendValueWithRange,
  split14BitCCValue,
  snapPitchBendValueToSemitoneWithRange,
  thinControllerEvents,
  transformControllerEvents,
} from "../utils/midiControllerLanes";
import { getMIDIClipSourceLoopLength } from "../utils/midiClipSerialization";
import {
  applyNoteMetadataValueToEvents,
  noteIdFor,
  noteMetadataLaneMax,
  noteMetadataLaneName,
  noteMetadataValueForPair,
  parseMIDINotePairs,
  rebuildMIDIEventsForNotes,
  sortMIDIEvents,
  type MIDINotePair,
} from "../utils/midiNotes";
import {
  CC_PRESETS,
  CHANNEL_PRESSURE_LANE,
  CHANCE_LANE,
  NOTE_OFF_VELOCITY_LANE,
  PITCH_BEND_LANE,
  POLY_PRESSURE_LANE,
  PROGRAM_CHANGE_LANE,
  VELOCITY_VARIANCE_LANE,
  noteMetadataLaneTypeForLane,
  scalarMIDIEventName,
  scalarMIDIEventTypeForLane,
} from "../utils/pianoRollLanes";
import {
  gestureKindForHit,
  hitTestPianoRoll,
  type PianoRollGestureSession,
} from "../utils/pianoRollInteraction";
import {
  midiSourceTimeToProjectX,
  projectXToMidiSourceTime,
} from "../utils/timelineGeometry";
import {
  guardModalContextMenu,
  isEditorWheelOwnedTarget,
  shouldSuppressWorkspaceContextMenu,
} from "../utils/modalEventGuards";
import {
  calculateGridInterval,
  GRID_SIZE_GROUPS,
  GRID_TICKS_PER_SIXTEENTH,
  GRID_TYPE_MODE_OPTIONS,
  getGridSizeLabel,
  getQuantizePresetById,
  resolveVisualGrid,
  snapTimeByType,
  ticksToSeconds,
  type GridSize,
  type QuantizeGroovePreset,
} from "../utils/snapToGrid";
import { windowRole, windowSessionId } from "../utils/windowEnvironment";
import {
  publishDetachedLoopRegion,
  publishDetachedMidiQuantize,
} from "../utils/detachedMainActionRouting";
import { matchesActionShortcut } from "../utils/globalShortcutDispatcher";
import {
  getDisplayEffectiveShortcut,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import {
  activateShortcutContext,
  registerShortcutSurface,
  type EditShortcutContext,
  type ShortcutSurfaceHandler,
} from "../utils/shortcutContext";
import { getShortcutPlatform } from "../utils/platform";
import { getMouseBehaviorProfile, toMouseBehaviorPlatform } from "../utils/mouseBehaviorProfiles";
import { resolveWheelGesture } from "../utils/wheelGestureResolver";
import {
  computeAnchoredVerticalWheelZoom,
  createWheelEditBurstController,
  getAccumulatedWheelNudgeDirection,
  getAccumulatedWheelStepCount,
  getMidiNoteHeightZoomPointerOffset,
  type WheelEditBurstController,
} from "../utils/contextWheelBehaviors";
import {
  createWheelDeltaAccumulator,
  type WheelDeltaAccumulator,
} from "../utils/wheelDeltaAccumulator";
import {
  getNoteNameFromPitch,
  isNoteInScale,
  NOTE_NAMES,
  NOTES_PER_OCTAVE,
  SCALE_DISPLAY_NAMES,
} from "../utils/pianoRollPitch";
import {
  velocityColor,
  velocityStrokeColor,
} from "../utils/pianoRollVelocity";
import { Button, ProfiledRangeInput } from "./ui";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { PianoRollControllerLaneSection } from "./PianoRollControllerLaneSection";
import { PianoRollInspectorSummary } from "./PianoRollInspectorSummary";
import { PianoRollInfoLine } from "./PianoRollInfoLine";
import { PianoRollLaneEditorSection } from "./PianoRollLaneEditorSection";
import { PianoRollNoteInspectorSection } from "./PianoRollNoteInspectorSection";
import { PianoRollPitchBendSection } from "./PianoRollPitchBendSection";
import { PianoRollStatusStrip } from "./PianoRollStatusStrip";
import { PianoRollToolbar } from "./PianoRollToolbar";
import "./PianoRoll.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KonvaEvent = any;

interface PianoRollProps {
  readonly clipId: string;
  readonly trackId: string;
  readonly sessionId?: string;
  readonly additionalClipIds?: string[];
  readonly isDetached?: boolean;
  readonly onDetach?: () => void;
}

type NotePair = MIDINotePair;

interface MultiClipNotePair extends NotePair {
  clipId: string;
  clipIndex: number;
  timeOffset: number;
}

type DragMode = "move" | "resize-start" | "resize-end";

interface NoteDragState {
  mode: DragMode;
  noteIds: string[];
  originalEvents: MIDIEvent[];
  startPointerTime: number;
  startPointerNote: number;
  activeNoteId: string;
  originalIsModified: boolean;
}

interface DrawingState {
  startTime: number;
  endTime: number;
  noteNumber: number;
  velocity: number;
}

interface VelocityEditState {
  noteId: string;
  timestamp: number;
  noteNumber: number;
  originalEvents: MIDIEvent[];
  originalIsModified: boolean;
}

interface CCDrawState {
  lane: "cc" | "pitchBend" | "midiEvent" | "noteMetadata";
  originalCCEvents: MIDICCEvent[];
  originalEvents: MIDIEvent[];
  originalIsModified: boolean;
}

interface MarqueeState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  mode: "replace" | "add" | "toggle";
}

interface RangeDragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface LaneResizeState {
  laneId: string;
  laneKind: PianoRollVisibleLane["kind"];
  startY: number;
  originalHeight: number;
}

interface PanDragState {
  startX: number;
  startY: number;
  originalScrollX: number;
  originalScrollY: number;
}

interface LoopBoundaryDragState {
  edge: "start" | "end";
  startX: number;
  currentX: number;
  currentSourceTime: number;
  initialLoopOffset: number;
  initialLoopLength: number;
}

interface ControllerLaneClipboard {
  sourceLabel: string;
  duration: number;
  points: Array<{ time: number; valueFraction: number }>;
}

type QuantizeMode = "start" | "ends" | "both" | "length";

type TransformDialogState =
  | { type: "quantize"; value: number; gridSize: GridSize; strength: number; mode: QuantizeMode; swing: number; groovePreset: QuantizeGroovePreset; tupletDivisions: number; catchRangeTicks: number; safeRangeTicks: number; roughTicks: number; fixedLength: number; fixedLengthGridSize: GridSize | "quantize_link"; moveControllers: boolean; autoApply: boolean }
  | { type: "humanize"; timingMs: number; velocity: number }
  | { type: "velocity"; value: number }
  | { type: "randomVelocity"; amount: number }
  | { type: "length"; value: number }
  | { type: "mirror"; centerNote: number };

type ControllerTransformDialogState =
  | { type: "line"; interpolation: ControllerInterpolationMode; curve: number; startValue: number; endValue: number }
  | { type: "lfo"; shape: ControllerLFOShape; rateHz: number; centerValue: number; depth: number }
  | { type: "thin"; tolerance: number }
  | { type: "transform"; timeScalePercent: number; valueScalePercent: number; valueOffset: number; tilt: number };

type PianoRollContextMenuState = {
  x: number;
  y: number;
  kind: "note" | "grid" | "range";
  noteId?: string;
  noteNumber?: number;
  time?: number;
} | null;

type PianoRollContextWheelEditTarget = {
  kind: "note-nudge" | "note-property";
  trackId: string;
  clipId: string;
  sessionKey: string;
  initialNoteId: string;
  currentNoteId: string;
  propertyKey: string;
  description: string;
  originalEvents: MIDIEvent[] | null;
  originalIsModified: boolean;
};

const MULTI_CLIP_TINTS = [
  null,
  "#ff6b9d",
  "#51cf66",
  "#ffd43b",
  "#748ffc",
  "#f06595",
  "#20c997",
  "#ff922b",
];

const STEP_SIZE_OPTIONS = [
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
];

const PIANO_STEP_INPUT_ACTION_SEMITONES: Record<string, number> = {
  "midi.stepInputC": 0,
  "midi.stepInputD": 2,
  "midi.stepInputE": 4,
  "midi.stepInputF": 5,
  "midi.stepInputG": 7,
  "midi.stepInputA": 9,
  "midi.stepInputB": 11,
  "midi.stepInputCSharp": 1,
  "midi.stepInputDSharp": 3,
  "midi.stepInputESharp": 5,
  "midi.stepInputFSharp": 6,
  "midi.stepInputGSharp": 8,
  "midi.stepInputASharp": 10,
  "midi.stepInputBSharp": 12,
};

const PIANO_TOOL_ACTIONS = {
  "midi.tool.draw": "draw",
  "midi.tool.select": "select",
  "midi.tool.erase": "erase",
  "midi.tool.trim": "trim",
  "midi.tool.split": "split",
  "midi.tool.glue": "glue",
  "midi.tool.mute": "mute",
  "midi.tool.velocity": "velocity",
  "midi.tool.line": "line",
  "midi.tool.zoom": "zoom",
  "midi.tool.pan": "pan",
  "midi.tool.range": "range",
} as const;

const PIANO_MOVE_ACTION_IDS = [
  "midi.moveLeft",
  "midi.moveRight",
  "midi.movePitchUp",
  "midi.movePitchDown",
  "midi.moveLeftFine",
  "midi.moveRightFine",
  "midi.movePitchOctaveUp",
  "midi.movePitchOctaveDown",
] as const;

const PIANO_SHORTCUT_ACTION_IDS = [
  ...Object.keys(PIANO_STEP_INPUT_ACTION_SEMITONES),
  ...Object.keys(PIANO_TOOL_ACTIONS),
  "midi.repeatSelection",
  "midi.quantizeLast",
  "midi.selectAll",
  "midi.deselectAll",
  "midi.selectNextNote",
  "midi.selectPreviousNote",
  "midi.glueSelectedNotes",
  "view.togglePianoRoll",
  "midi.loopFromSelectedNotes",
  "midi.noteProperties",
  "midi.toggleGhostReference",
  "midi.configureControllerLanes",
  "midi.openQuantizePanel",
  "midi.quantizeLength",
  "midi.controllerLine",
  "midi.controllerSineLfo",
  "midi.controllerTriangleLfo",
  "midi.controllerSquareLfo",
  "midi.controllerSawUpLfo",
  "midi.controllerSawDownLfo",
  "midi.controllerTransform",
  "midi.controllerThin",
  "midi.copyControllerLane",
  "midi.pasteControllerLane",
  "midi.clearControllerLane",
  "midi.copySelection",
  "midi.cutSelection",
  "midi.pasteSelection",
  "midi.duplicateSelection",
  "midi.deleteSelection",
  ...PIANO_MOVE_ACTION_IDS,
  "midi.closeEditor",
] as const;

const PIANO_REPEATABLE_ACTION_IDS = new Set<string>([
  ...Object.keys(PIANO_STEP_INPUT_ACTION_SEMITONES),
  ...PIANO_MOVE_ACTION_IDS,
]);

const PIANO_LOCK_SAFE_ACTION_IDS = new Set<string>([
  ...Object.keys(PIANO_TOOL_ACTIONS),
  "view.togglePianoRoll",
  "midi.closeEditor",
  "midi.selectAll",
  "midi.deselectAll",
  "midi.selectNextNote",
  "midi.selectPreviousNote",
  "midi.noteProperties",
  "midi.toggleGhostReference",
  "midi.configureControllerLanes",
  "midi.openQuantizePanel",
  "midi.controllerLine",
  "midi.controllerSineLfo",
  "midi.controllerTriangleLfo",
  "midi.controllerSquareLfo",
  "midi.controllerSawUpLfo",
  "midi.controllerSawDownLfo",
  "midi.controllerTransform",
  "midi.controllerThin",
  "midi.copyControllerLane",
  "midi.copySelection",
]);

const TOTAL_NOTES = 128;
const DEFAULT_NOTE_HEIGHT = 12;
const MIN_NOTE_HEIGHT = 6;
const MAX_NOTE_HEIGHT = 36;
const PIANO_WIDTH = 0;
const PIANO_KEY_STRIP_MIN_WIDTH = 56;
const PIANO_KEY_STRIP_MAX_WIDTH = 86;
const EDITOR_HORIZONTAL_PADDING_BARS = 4;
const EDITOR_HORIZONTAL_PADDING_VIEWPORT_RATIO = 0.75;
const LOOP_BOUNDARY_EDGE_SCROLL_ZONE_PX = 56;
const LOOP_BOUNDARY_EDGE_SCROLL_MAX_STEP_PX = 36;
const VELOCITY_LANE_HEIGHT = 60;
const CC_LANE_HEIGHT = 80;
const LANE_DIVIDER_HEIGHT = 1;
const TOOLBAR_HEIGHT = 40;
const INFO_LINE_HEIGHT = 38;
const RULER_HEIGHT = 26;
const STATUS_STRIP_HEIGHT = 30;
const HORIZONTAL_SCROLLBAR_HEIGHT = 16;
const VERTICAL_SCROLLBAR_WIDTH = 16;
const TIMELINE_DIVIDER_WIDTH = 6;
const NOTE_EDGE_HIT_WIDTH = 7;
const AUDITION_DURATION_MS = 180;
const AUDITION_THROTTLE_MS = 120;

function PianoRollPlayheadLine({
  pixelsPerSecond,
  scrollX,
  stageHeight,
  stageWidth,
}: {
  pixelsPerSecond: number;
  scrollX: number;
  stageHeight: number;
  stageWidth: number;
}) {
  const lineRef = useRef<any>(null);
  const ppsRef = useRef(pixelsPerSecond);
  const scrollXRef = useRef(scrollX);
  ppsRef.current = pixelsPerSecond;
  scrollXRef.current = scrollX;

  useEffect(() => {
    const update = (time: number) => {
      const x = time * ppsRef.current - scrollXRef.current;
      const visible = x >= 0 && x <= stageWidth;
      if (!lineRef.current) return;
      lineRef.current.visible(visible);
      if (visible) {
        lineRef.current.points([x, 0, x, stageHeight]);
      }
      lineRef.current.getLayer()?.batchDraw();
    };

    update(useDAWStore.getState().transport.currentTime);
    const unsubscribe = useDAWStore.subscribe((state) => {
      update(state.transport.currentTime);
    });
    return unsubscribe;
  }, [stageHeight, stageWidth]);

  const initialTime = useDAWStore.getState().transport.currentTime;
  const initialX = initialTime * pixelsPerSecond - scrollX;
  return (
    <Line
      ref={lineRef}
      points={[initialX, 0, initialX, stageHeight]}
      stroke="#4cc9f0"
      strokeWidth={1.5}
      listening={false}
      shadowColor="#4cc9f0"
      shadowBlur={5}
      visible={initialX >= 0 && initialX <= stageWidth}
    />
  );
}

function PianoRollRulerPlayhead({
  pixelsPerSecond,
  scrollX,
  width,
}: {
  pixelsPerSecond: number;
  scrollX: number;
  width: number;
}) {
  const markerRef = useRef<HTMLDivElement>(null);
  const ppsRef = useRef(pixelsPerSecond);
  const scrollXRef = useRef(scrollX);
  ppsRef.current = pixelsPerSecond;
  scrollXRef.current = scrollX;

  useEffect(() => {
    const update = (time: number) => {
      const x = time * ppsRef.current - scrollXRef.current;
      const visible = x >= 0 && x <= width;
      if (!markerRef.current) return;
      markerRef.current.style.transform = `translateX(${x}px)`;
      markerRef.current.style.opacity = visible ? "1" : "0";
    };

    update(useDAWStore.getState().transport.currentTime);
    const unsubscribe = useDAWStore.subscribe((state) => {
      update(state.transport.currentTime);
    });
    return unsubscribe;
  }, [width]);

  const initialX = useDAWStore.getState().transport.currentTime * pixelsPerSecond - scrollX;
  return (
    <div
      ref={markerRef}
      className="piano-roll-ruler-playhead"
      data-qa="piano-roll-ruler-playhead"
      style={{
        transform: `translateX(${initialX}px)`,
        opacity: initialX >= 0 && initialX <= width ? 1 : 0,
      }}
      aria-hidden="true"
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const sortEvents = sortMIDIEvents;

function parseNotePairs(events?: MIDIEvent[]): NotePair[] {
  return parseMIDINotePairs(events || []);
}

function getPianoRollClipEventsSnapshot(
  trackId: string,
  clipId: string,
): MIDIEvent[] | null {
  const track = useDAWStore.getState().tracks.find((candidate) => candidate.id === trackId);
  const clip = track?.midiClips.find((candidate) => candidate.id === clipId);
  return clip ? clip.events.map((event) => ({ ...event })) : null;
}

export function PianoRoll({ clipId, trackId, sessionId, additionalClipIds = [], isDetached = false, onDetach }: PianoRollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const controllerLaneSelectorRef = useRef<HTMLSelectElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const verticalScrollbarRef = useRef<HTMLDivElement>(null);
  const auditionRef = useRef<{ note: number | null; timeoutId: number | null; lastAt: number }>({
    note: null,
    timeoutId: null,
    lastAt: 0,
  });
  const previewNoteTimeoutsRef = useRef<Map<number, number>>(new Map());
  const lastRevealedPreviewNoteAtRef = useRef<Map<number, number>>(new Map());
  const keyDragRef = useRef<{ active: boolean; visited: Set<number> }>({ active: false, visited: new Set() });
  const latestDragAuditionRef = useRef<{ noteNumber: number; velocity: number } | null>(null);
  const gestureSessionRef = useRef<PianoRollGestureSession | null>(null);
  const ccDrawStateRef = useRef<CCDrawState | null>(null);
  const panDragRef = useRef<PanDragState | null>(null);
  const contextWheelEditControllerRef = useRef<
    WheelEditBurstController<PianoRollContextWheelEditTarget> | null
  >(null);
  if (contextWheelEditControllerRef.current === null) {
    contextWheelEditControllerRef.current = createWheelEditBurstController({
      idleMs: 180,
      getKey: (target) => [
        target.kind,
        target.sessionKey,
        target.trackId,
        target.clipId,
        target.initialNoteId,
        target.propertyKey,
      ].join(":"),
      onBegin: (target) => {
        target.originalEvents = getPianoRollClipEventsSnapshot(
          target.trackId,
          target.clipId,
        );
        target.originalIsModified = useDAWStore.getState().isModified;
      },
      onCommit: (target) => {
        const finalEvents = getPianoRollClipEventsSnapshot(
          target.trackId,
          target.clipId,
        );
        if (
          !target.originalEvents
          || !finalEvents
          || JSON.stringify(target.originalEvents) === JSON.stringify(finalEvents)
        ) {
          return;
        }
        useDAWStore.getState().commitMIDIClipEvents(
          target.trackId,
          target.clipId,
          target.originalEvents,
          finalEvents,
          target.description,
        );
      },
    });
  }

  const createPianoRollContextWheelAccumulator = useCallback(() => (
    createWheelDeltaAccumulator({
      quantum: 100,
      idleMs: 180,
      onReset: ({ hadOutput }) => {
        if (hadOutput) contextWheelEditControllerRef.current?.commit();
      },
    })
  ), []);
  const contextWheelAccumulatorRef = useRef<WheelDeltaAccumulator | null>(null);
  if (contextWheelAccumulatorRef.current === null) {
    contextWheelAccumulatorRef.current = createPianoRollContextWheelAccumulator();
  }

  useEffect(() => () => {
    contextWheelAccumulatorRef.current?.reset();
    contextWheelEditControllerRef.current?.commit();
  }, [clipId, sessionId, trackId]);

  useEffect(() => {
    if (contextWheelAccumulatorRef.current?.getState().disposed) {
      contextWheelAccumulatorRef.current = createPianoRollContextWheelAccumulator();
    }
    return () => {
      contextWheelAccumulatorRef.current?.dispose();
      contextWheelEditControllerRef.current?.dispose();
    };
  }, [createPianoRollContextWheelAccumulator]);

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [toolbarHeight, setToolbarHeight] = useState(TOOLBAR_HEIGHT);
  const [noteHeight, setNoteHeight] = useState(DEFAULT_NOTE_HEIGHT);
  const [scrollY, setScrollY] = useState(TOTAL_NOTES * DEFAULT_NOTE_HEIGHT / 2 - 300);
  const [sourceLengthDraft, setSourceLengthDraft] = useState("");
  const [stepInputOctave, setStepInputOctave] = useState(4);
  const [selectedCC, setSelectedCC] = useState(1);
  const [cc14BitMode, setCC14BitMode] = useState(false);
  const [polyPressureNote, setPolyPressureNote] = useState(60);
  const [snapPitchBendSemitones, setSnapPitchBendSemitones] = useState(false);
  const [velocityLaneHeight, setVelocityLaneHeight] = useState(VELOCITY_LANE_HEIGHT);
  const [ccLaneHeight, setCCLaneHeight] = useState(CC_LANE_HEIGHT);
  const [showGhostMIDIClips, setShowGhostMIDIClips] = useState(true);
  const [showSelectedMIDIClipRefs, setShowSelectedMIDIClipRefs] = useState(true);
  const [showTransformMenu, setShowTransformMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<PianoRollContextMenuState>(null);
  const [marqueeState, setMarqueeState] = useState<MarqueeState | null>(null);
  const [rangeDragState, setRangeDragState] = useState<RangeDragState | null>(null);
  const [transformDialog, setTransformDialog] = useState<TransformDialogState | null>(null);
  const [controllerDialog, setControllerDialog] = useState<ControllerTransformDialogState | null>(null);
  const [dragState, setDragState] = useState<NoteDragState | null>(null);
  const [drawingState, setDrawingState] = useState<DrawingState | null>(null);
  const [velocityEdit, setVelocityEdit] = useState<VelocityEditState | null>(null);
  const [ccDrawState, setCCDrawState] = useState<CCDrawState | null>(null);
  const [loopBoundaryDrag, setLoopBoundaryDrag] = useState<LoopBoundaryDragState | null>(null);
  const [laneResizeState, setLaneResizeState] = useState<LaneResizeState | null>(null);
  const [panDragState, setPanDragState] = useState<PanDragState | null>(null);
  const [activePreviewNotes, setActivePreviewNotes] = useState<Set<number>>(() => new Set());
  const [controllerLaneClipboard, setControllerLaneClipboard] = useState<ControllerLaneClipboard | null>(null);
  const controllerPromptQueueRef = useRef<number[]>([]);
  const controllerLineModeOverrideRef = useRef<string | null>(null);
  const transformMenuRef = useRef<HTMLDivElement>(null);

  const {
    track,
    tempo,
    timeSignature,
    scaleRoot,
    scaleType,
    stepInputEnabled,
    stepInputSize,
    stepInputPosition,
    selectedNoteIds,
    midiNoteClipboard,
    midiRangeClipboard,
    midiEditRange,
    pianoRollEditCursorTime,
    activeMidiTool,
    pianoRollVisibleLanes,
    pianoRollActiveLaneId,
    pianoRollInsertVelocity,
    pianoRollAuditionEnabled,
    timelinePixelsPerSecond,
    timelineScrollX,
    timelineScrollY,
    snapEnabled,
    snapType,
    gridSize,
    quantizePresetId,
    quantizePresets,
    isTransportPlaying,
    tcpWidth,
    keyboardShortcutProfileId,
    customShortcuts,
    globalLocked,
    itemsLocked,
  } = useDAWStore(
    useShallow((state) => ({
      track: state.tracks.find((candidate) => candidate.id === trackId),
      tempo: state.transport.tempo,
      timeSignature: state.timeSignature,
      scaleRoot: state.pianoRollScaleRoot,
      scaleType: state.pianoRollScaleType,
      stepInputEnabled: state.stepInputEnabled,
      stepInputSize: state.stepInputSize,
      stepInputPosition: state.stepInputPosition,
      selectedNoteIds: state.selectedNoteIds,
      midiNoteClipboard: state.midiNoteClipboard,
      midiRangeClipboard: state.midiRangeClipboard,
      midiEditRange: state.midiEditRange,
      pianoRollEditCursorTime: state.pianoRollEditCursorTime,
      activeMidiTool: state.activeMidiTool,
      pianoRollVisibleLanes: state.pianoRollVisibleLanes,
      pianoRollActiveLaneId: state.pianoRollActiveLaneId,
      pianoRollInsertVelocity: state.pianoRollInsertVelocity,
      pianoRollAuditionEnabled: state.pianoRollAuditionEnabled,
      timelinePixelsPerSecond: state.pixelsPerSecond,
      timelineScrollX: state.scrollX,
      timelineScrollY: state.scrollY,
      snapEnabled: state.snapEnabled,
      snapType: state.snapType,
      gridSize: state.gridSize,
      quantizePresetId: state.quantizePresetId,
      quantizePresets: state.quantizePresets,
      isTransportPlaying: state.transport.isPlaying,
      tcpWidth: state.tcpWidth,
      keyboardShortcutProfileId: state.keyboardShortcutProfileId,
      customShortcuts: state.customShortcuts,
      globalLocked: state.globalLocked,
      itemsLocked: state.lockSettings.items,
    })),
  );
  const shortcut = useCallback(
    (actionId: string, fallback: string) => getDisplayEffectiveShortcut(actionId) ?? fallback,
    [customShortcuts, keyboardShortcutProfileId],
  );
  const tool = activeMidiTool;
  const pitchBendRangeUp = clamp(track?.midiPitchBendRangeUp ?? DEFAULT_PITCH_BEND_RANGE_SEMITONES, 1, 24);
  const pitchBendRangeDown = clamp(track?.midiPitchBendRangeDown ?? pitchBendRangeUp, 1, 24);
  const pitchBendRangeLinked = track?.midiPitchBendRangeLinked ?? true;

  const {
    toggleStepInput,
    setStepInputSize,
    setStepInputPosition,
    setTrackMidiPitchBendRange,
    updateMIDINoteVelocity,
    updateMIDICCEvents,
    commitMIDICCEvents,
    previewMIDIClipEvents,
    commitMIDIClipEvents,
    glueSelectedMIDINotes,
    addMIDINote,
    removeMIDINotes,
    moveMIDINotes,
    resizeMIDINote,
    setSelectedNoteIds,
    selectAllMIDINotes,
    copySelectedMIDINotes,
    cutSelectedMIDINotes,
    copyMIDIRange,
    cutMIDIRange,
    deleteMIDIRange,
    pasteMIDIRange,
    duplicateMIDIRange,
    repeatMIDISelection,
    pasteMIDINotes,
    duplicateSelectedMIDINotes,
    invertMIDISelection,
    selectMIDINotesByPitch,
    selectMIDINotesInRange,
    quantizeSelectedMIDINotes,
    quantizeSelectedMIDINotesUsingLast,
    resetMIDIQuantize,
    freezeMIDIQuantize,
    humanizeSelectedMIDINotes,
    setSelectedMIDINoteVelocity,
    scaleSelectedMIDINoteVelocity,
    randomizeSelectedMIDINoteVelocity,
    setSelectedMIDINoteLength,
    legatoSelectedMIDINotes,
    reverseSelectedMIDINotes,
    invertSelectedMIDINotePitches,
    mirrorSelectedMIDINotePitches,
    snapSelectedMIDINotesToScale,
    toggleSelectedMIDINoteMute,
    insertMIDIChord,
    cropMIDIClipToSelectedNotes,
    setMIDIEditRange,
    clearMIDIEditRange,
    setActiveMidiTool,
    setPianoRollVisibleLanes,
    setPianoRollActiveLane,
    updatePianoRollVisibleLane,
    addPianoRollVisibleLane,
    removePianoRollVisibleLane,
    setPianoRollEditCursorTime,
    setPianoRollInsertVelocity,
    setPianoRollAuditionEnabled,
    toggleSnap,
    setSnapType,
    setGridSize,
    setQuantizePresetId,
    setPianoRollScaleRoot,
    setPianoRollScaleType,
    setTimelineZoom,
    setTimelineScroll,
    seekTo,
    updateMidiEditorSession,
    setMIDIClipSourceWindow,
    transposeMIDINotes,
    scaleMIDINoteVelocity,
    reverseMIDINotes,
    invertMIDINotes,
    openPianoRoll,
  } = useDAWStore(
    useShallow((state) => ({
      toggleStepInput: state.toggleStepInput,
      setStepInputSize: state.setStepInputSize,
      setStepInputPosition: state.setStepInputPosition,
      setTrackMidiPitchBendRange: state.setTrackMidiPitchBendRange,
      updateMIDINoteVelocity: state.updateMIDINoteVelocity,
      updateMIDICCEvents: state.updateMIDICCEvents,
      commitMIDICCEvents: state.commitMIDICCEvents,
      previewMIDIClipEvents: state.previewMIDIClipEvents,
      commitMIDIClipEvents: state.commitMIDIClipEvents,
      glueSelectedMIDINotes: state.glueSelectedMIDINotes,
      addMIDINote: state.addMIDINote,
      removeMIDINotes: state.removeMIDINotes,
      moveMIDINotes: state.moveMIDINotes,
      resizeMIDINote: state.resizeMIDINote,
      setSelectedNoteIds: state.setSelectedNoteIds,
      selectAllMIDINotes: state.selectAllMIDINotes,
      copySelectedMIDINotes: state.copySelectedMIDINotes,
      cutSelectedMIDINotes: state.cutSelectedMIDINotes,
      copyMIDIRange: state.copyMIDIRange,
      cutMIDIRange: state.cutMIDIRange,
      deleteMIDIRange: state.deleteMIDIRange,
      pasteMIDIRange: state.pasteMIDIRange,
      duplicateMIDIRange: state.duplicateMIDIRange,
      repeatMIDISelection: state.repeatMIDISelection,
      pasteMIDINotes: state.pasteMIDINotes,
      duplicateSelectedMIDINotes: state.duplicateSelectedMIDINotes,
      invertMIDISelection: state.invertMIDISelection,
      selectMIDINotesByPitch: state.selectMIDINotesByPitch,
      selectMIDINotesInRange: state.selectMIDINotesInRange,
      quantizeSelectedMIDINotes: state.quantizeSelectedMIDINotes,
      quantizeSelectedMIDINotesUsingLast: state.quantizeSelectedMIDINotesUsingLast,
      resetMIDIQuantize: state.resetMIDIQuantize,
      freezeMIDIQuantize: state.freezeMIDIQuantize,
      humanizeSelectedMIDINotes: state.humanizeSelectedMIDINotes,
      setSelectedMIDINoteVelocity: state.setSelectedMIDINoteVelocity,
      scaleSelectedMIDINoteVelocity: state.scaleSelectedMIDINoteVelocity,
      randomizeSelectedMIDINoteVelocity: state.randomizeSelectedMIDINoteVelocity,
      setSelectedMIDINoteLength: state.setSelectedMIDINoteLength,
      legatoSelectedMIDINotes: state.legatoSelectedMIDINotes,
      reverseSelectedMIDINotes: state.reverseSelectedMIDINotes,
      invertSelectedMIDINotePitches: state.invertSelectedMIDINotePitches,
      mirrorSelectedMIDINotePitches: state.mirrorSelectedMIDINotePitches,
      snapSelectedMIDINotesToScale: state.snapSelectedMIDINotesToScale,
      toggleSelectedMIDINoteMute: state.toggleSelectedMIDINoteMute,
      insertMIDIChord: state.insertMIDIChord,
      cropMIDIClipToSelectedNotes: state.cropMIDIClipToSelectedNotes,
      setMIDIEditRange: state.setMIDIEditRange,
      clearMIDIEditRange: state.clearMIDIEditRange,
      setActiveMidiTool: state.setActiveMidiTool,
      setPianoRollVisibleLanes: state.setPianoRollVisibleLanes,
      setPianoRollActiveLane: state.setPianoRollActiveLane,
      updatePianoRollVisibleLane: state.updatePianoRollVisibleLane,
      addPianoRollVisibleLane: state.addPianoRollVisibleLane,
      removePianoRollVisibleLane: state.removePianoRollVisibleLane,
      setPianoRollEditCursorTime: state.setPianoRollEditCursorTime,
      setPianoRollInsertVelocity: state.setPianoRollInsertVelocity,
      setPianoRollAuditionEnabled: state.setPianoRollAuditionEnabled,
      toggleSnap: state.toggleSnap,
      setSnapType: state.setSnapType,
      setGridSize: state.setGridSize,
      setQuantizePresetId: state.setQuantizePresetId,
      setPianoRollScaleRoot: state.setPianoRollScaleRoot,
      setPianoRollScaleType: state.setPianoRollScaleType,
      setTimelineZoom: state.setZoom,
      setTimelineScroll: state.setScroll,
      seekTo: state.seekTo,
      updateMidiEditorSession: state.updateMidiEditorSession,
      setMIDIClipSourceWindow: state.setMIDIClipSourceWindow,
      transposeMIDINotes: state.transposeMIDINotes,
      scaleMIDINoteVelocity: state.scaleMIDINoteVelocity,
      reverseMIDINotes: state.reverseMIDINotes,
      invertMIDINotes: state.invertMIDINotes,
      openPianoRoll: state.openPianoRoll,
    })),
  );
  const setTool = setActiveMidiTool;
  const visibleLanes = useMemo(
    () => (pianoRollVisibleLanes?.length ? pianoRollVisibleLanes : DEFAULT_PIANO_ROLL_VISIBLE_LANES),
    [pianoRollVisibleLanes],
  );
  const activeLane = visibleLanes.find((lane) => lane.id === pianoRollActiveLaneId) ?? visibleLanes[0];
  const isVelocityLaneActive = activeLane?.kind === "velocity";
  const activeControllerLane = isVelocityLaneActive ? undefined : activeLane;

  const clip = track?.midiClips.find((candidate) => candidate.id === clipId);
  const midiTargetEditable = Boolean(getEditableMidiClip(
    {
      tracks: track ? [track] : [],
      globalLocked,
      lockSettings: { items: itemsLocked },
    },
    trackId,
    clipId,
  ));

  useEffect(() => {
    const cancelLockedGesture = (state: ReturnType<typeof useDAWStore.getState>) => {
      if (getEditableMidiClip(state, trackId, clipId)) return;
      const wheelTarget = contextWheelEditControllerRef.current?.getActiveTarget();
      const activeCCDrawState = ccDrawStateRef.current || ccDrawState;
      const hasActiveGesture = Boolean(
        dragState
        || drawingState
        || velocityEdit
        || activeCCDrawState
        || loopBoundaryDrag
        || wheelTarget,
      );
      if (!hasActiveGesture) return;

      const originalEvents = activeCCDrawState?.originalEvents
        ?? velocityEdit?.originalEvents
        ?? dragState?.originalEvents
        ?? wheelTarget?.originalEvents
        ?? null;
      const originalCCEvents = activeCCDrawState?.originalCCEvents ?? null;
      const originalIsModified = activeCCDrawState?.originalIsModified
        ?? velocityEdit?.originalIsModified
        ?? dragState?.originalIsModified
        ?? wheelTarget?.originalIsModified
        ?? state.isModified;
      if (originalEvents || originalCCEvents) {
        useDAWStore.setState((current) => ({
          tracks: current.tracks.map((candidate) => candidate.id === trackId
            ? {
                ...candidate,
                midiClips: candidate.midiClips.map((candidateClip) => candidateClip.id === clipId
                  ? {
                      ...candidateClip,
                      ...(originalEvents ? { events: originalEvents.map((event) => ({ ...event })) } : {}),
                      ...(originalCCEvents ? { ccEvents: originalCCEvents.map((event) => ({ ...event })) } : {}),
                    }
                  : candidateClip),
              }
            : candidate),
          isModified: originalIsModified,
        }));
        void useDAWStore.getState().syncMIDITrackToBackend(trackId, { debounce: false });
      }

      const restoredSelection = dragState?.noteIds
        ?? (velocityEdit ? [velocityEdit.noteId] : undefined)
        ?? (wheelTarget ? [wheelTarget.initialNoteId] : undefined);
      if (restoredSelection) useDAWStore.getState().setSelectedNoteIds(restoredSelection);
      contextWheelEditControllerRef.current?.cancel();
      contextWheelAccumulatorRef.current?.reset();
      gestureSessionRef.current = null;
      ccDrawStateRef.current = null;
      latestDragAuditionRef.current = null;
      setDragState(null);
      setDrawingState(null);
      setVelocityEdit(null);
      setCCDrawState(null);
      setLoopBoundaryDrag(null);
    };

    cancelLockedGesture(useDAWStore.getState());
    return useDAWStore.subscribe(cancelLockedGesture);
  }, [ccDrawState, clipId, dragState, drawingState, loopBoundaryDrag, trackId, velocityEdit]);
  const clipEvents = clip?.events;
  const clipCCEvents = clip?.ccEvents;
  const clipDuration = clip ? getMIDIClipSourceLoopLength(clip) : 0;
  const clipStartTime = clip?.startTime ?? 0;
  const beatsPerSecond = tempo / 60;
  const pixelsPerSecond = timelinePixelsPerSecond;
  const scrollX = timelineScrollX - clipStartTime * pixelsPerSecond;
  const activeQuantizePreset = useMemo(
    () => getQuantizePresetById(quantizePresets, quantizePresetId),
    [quantizePresetId, quantizePresets],
  );
  const snapDuration = useMemo(
    () => calculateGridInterval(tempo, timeSignature, gridSize, {
      quantizePreset: activeQuantizePreset,
      quantizeGridSize: activeQuantizePreset.gridSize,
      pixelsPerSecond,
    }),
    [activeQuantizePreset, gridSize, pixelsPerSecond, tempo, timeSignature],
  );
  const stepDurationSeconds = snapDuration || stepInputSize / beatsPerSecond;
  const sidebarWidth = tcpWidth;
  const pianoKeyStripWidth = clamp(
    Math.round(sidebarWidth * 0.32),
    PIANO_KEY_STRIP_MIN_WIDTH,
    PIANO_KEY_STRIP_MAX_WIDTH,
  );
  const stageWidth = Math.max(1, dimensions.width - sidebarWidth - TIMELINE_DIVIDER_WIDTH - VERTICAL_SCROLLBAR_WIDTH);
  const activeLaneHeight = isVelocityLaneActive ? velocityLaneHeight : ccLaneHeight;
  const bottomLanesHeight = activeLaneHeight + LANE_DIVIDER_HEIGHT;
  const stageHeight = Math.max(
    1,
    dimensions.height - toolbarHeight - INFO_LINE_HEIGHT - RULER_HEIGHT - HORIZONTAL_SCROLLBAR_HEIGHT - STATUS_STRIP_HEIGHT,
  );
  const noteGridHeight = Math.max(noteHeight * 4, stageHeight - bottomLanesHeight);
  const velocityLaneY = noteGridHeight;
  const ccLaneY = noteGridHeight;
  const visibleGridWidth = Math.max(1, stageWidth - PIANO_WIDTH);
  const isCC14BitMode = cc14BitMode && selectedCC >= 0 && selectedCC <= 31;
  const selectedScalarMIDIEventType = scalarMIDIEventTypeForLane(selectedCC);
  const selectedScalarMIDIEventLabel = selectedScalarMIDIEventType
    ? scalarMIDIEventName(selectedScalarMIDIEventType, polyPressureNote)
    : "";
  const selectedNoteMetadataLaneType = noteMetadataLaneTypeForLane(selectedCC);
  const selectedNoteMetadataLaneLabel = selectedNoteMetadataLaneType
    ? noteMetadataLaneName(selectedNoteMetadataLaneType)
    : "";
  const selectedNoteMetadataLaneMax = selectedNoteMetadataLaneType
    ? noteMetadataLaneMax(selectedNoteMetadataLaneType)
    : 127;
  const controllerLaneLabel = isVelocityLaneActive
    ? "Velocity"
    : selectedCC === PITCH_BEND_LANE
      ? "Pitch Bend"
      : selectedScalarMIDIEventType
        ? selectedScalarMIDIEventLabel
        : selectedNoteMetadataLaneType
          ? selectedNoteMetadataLaneLabel
          : isCC14BitMode
            ? `14-bit CC#${selectedCC}/${selectedCC + 32}`
            : `CC#${selectedCC}`;
  const selectedScalarMIDIEventMatches = useCallback((event: MIDIEvent) => {
    if (!selectedScalarMIDIEventType || event.type !== selectedScalarMIDIEventType) return false;
    return selectedScalarMIDIEventType !== "polyPressure" || event.note === polyPressureNote;
  }, [polyPressureNote, selectedScalarMIDIEventType]);
  const makeSelectedScalarMIDIEvent = useCallback((timestamp: number, value: number): MIDIEvent => ({
    type: selectedScalarMIDIEventType ?? "channelPressure",
    timestamp,
    value: clamp7Bit(value),
    ...(selectedScalarMIDIEventType === "polyPressure" ? { note: polyPressureNote } : {}),
  }), [polyPressureNote, selectedScalarMIDIEventType]);

  const selectControllerLane = useCallback((lane: PianoRollVisibleLane) => {
    setPianoRollActiveLane(lane.id);
    if (lane.kind === "velocity") return;
    if (lane.kind === "noteOffVelocity") {
      setSelectedCC(NOTE_OFF_VELOCITY_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "chance") {
      setSelectedCC(CHANCE_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "velocityVariance") {
      setSelectedCC(VELOCITY_VARIANCE_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "pitchBend") {
      setSelectedCC(PITCH_BEND_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "programBank") {
      setSelectedCC(PROGRAM_CHANGE_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "channelPressure") {
      setSelectedCC(CHANNEL_PRESSURE_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "polyPressure") {
      setSelectedCC(POLY_PRESSURE_LANE);
      setCC14BitMode(false);
      return;
    }
    if (lane.kind === "cc14") {
      setSelectedCC(clamp(lane.cc ?? 1, 0, 31));
      setCC14BitMode(true);
      return;
    }
    if (lane.kind === "cc7") {
      setSelectedCC(clamp(lane.cc ?? 1, 0, 127));
      setCC14BitMode(false);
    }
  }, [setPianoRollActiveLane]);

  const notePairs = useMemo(() => parseNotePairs(clipEvents), [clipEvents]);
  const trackMIDIClipOptions = useMemo(() => track?.midiClips ?? [], [track]);
  const additionalClips = useMemo(() => {
    if (!track || !showSelectedMIDIClipRefs || additionalClipIds.length === 0) return [];
    return additionalClipIds
      .map((id) => track.midiClips.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null);
  }, [track, additionalClipIds, showSelectedMIDIClipRefs]);

  const additionalClipNotePairs: MultiClipNotePair[] = useMemo(() => {
    const allPairs: MultiClipNotePair[] = [];
    additionalClips.forEach((additionalClip, clipIndex) => {
      const timeOffset = additionalClip.startTime - clipStartTime;
      parseNotePairs(additionalClip.events).forEach((pair) => {
        allPairs.push({
          ...pair,
          startTime: pair.startTime + timeOffset,
          clipId: additionalClip.id,
          clipIndex: clipIndex + 1,
          timeOffset,
        });
      });
    });
    return allPairs;
  }, [additionalClips, clipStartTime]);

  const controllerEventsForLane: Array<{ time: number; value: number; rawValue?: number }> = useMemo(() => {
    if (selectedNoteMetadataLaneType) {
      const maxValue = noteMetadataLaneMax(selectedNoteMetadataLaneType);
      return notePairs
        .map((pair) => {
          const rawValue = noteMetadataValueForPair(pair, selectedNoteMetadataLaneType);
          return {
            time: pair.startTime,
            value: clamp((rawValue / maxValue) * 127, 0, 127),
            rawValue,
          };
        })
        .sort((a, b) => a.time - b.time);
    }
    if (selectedCC === PITCH_BEND_LANE) {
      return (clipEvents || [])
        .filter((event) => event.type === "pitchBend")
        .map((event) => {
          const rawValue = event.value ?? event.pitchBend ?? MIDI_PITCH_BEND_CENTER;
          return {
            time: event.timestamp,
            value: pitchBendToLaneValue(rawValue),
            rawValue,
          };
        })
        .sort((a, b) => a.time - b.time);
    }
    if (selectedScalarMIDIEventType) {
      return (clipEvents || [])
        .filter(selectedScalarMIDIEventMatches)
        .map((event) => ({
          time: event.timestamp,
          value: clamp7Bit(event.value ?? 0),
          rawValue: event.value ?? 0,
        }))
        .sort((a, b) => a.time - b.time);
    }

    if (!clipCCEvents) return [];
    if (isCC14BitMode) {
      const lsbCC = selectedCC + 32;
      return clipCCEvents
        .filter((event) => event.cc === selectedCC)
        .map((event) => {
          const lsb = clipCCEvents.find((candidate) =>
            candidate.cc === lsbCC && Math.abs(candidate.time - event.time) < 0.000001,
          );
          const rawValue = combine14BitCCValue(event.value, lsb?.value ?? 0);
          return {
            time: event.time,
            value: clamp(Math.round((rawValue / MIDI_PITCH_BEND_MAX) * 127), 0, 127),
            rawValue,
          };
        })
        .sort((a, b) => a.time - b.time);
    }
    return clipCCEvents
      .filter((event) => event.cc === selectedCC)
      .map((event) => ({ time: event.time, value: event.value }))
      .sort((a, b) => a.time - b.time);
  }, [clipCCEvents, clipEvents, isCC14BitMode, notePairs, selectedCC, selectedNoteMetadataLaneType, selectedScalarMIDIEventMatches, selectedScalarMIDIEventType]);

  const getEditorPaddingSeconds = useCallback((pps = pixelsPerSecond) => {
    const safePps = Math.max(1, pps || 1);
    const secondsPerBar = Math.max(0.001, timeSignature.numerator / Math.max(0.001, beatsPerSecond));
    const viewportPadding = (visibleGridWidth / safePps) * EDITOR_HORIZONTAL_PADDING_VIEWPORT_RATIO;
    return Math.max(secondsPerBar * EDITOR_HORIZONTAL_PADDING_BARS, viewportPadding, 1);
  }, [beatsPerSecond, pixelsPerSecond, timeSignature.numerator, visibleGridWidth]);

  const contentDuration = useMemo(() => {
    const noteEnd = notePairs.reduce((max, pair) => Math.max(max, pair.startTime + pair.duration), 0);
    const ccEnd = (clipCCEvents || []).reduce((max, event) => Math.max(max, event.time), 0);
    const drawEnd = drawingState ? Math.max(drawingState.startTime, drawingState.endTime) : 0;
    const loopDragEnd = loopBoundaryDrag ? loopBoundaryDrag.currentSourceTime : 0;
    const visibleItemEnd = clip?.duration ?? 0;
    return Math.max(clipDuration, visibleItemEnd, noteEnd, ccEnd, drawEnd, loopDragEnd, stepInputPosition + stepDurationSeconds, 1);
  }, [clip?.duration, clipDuration, notePairs, clipCCEvents, drawingState, loopBoundaryDrag, stepInputPosition, stepDurationSeconds]);

  const eventContentLength = useMemo(() => {
    const noteEnd = notePairs.reduce((max, pair) => Math.max(max, pair.startTime + pair.duration), 0);
    const ccEnd = (clipCCEvents || []).reduce((max, event) => Math.max(max, event.time), 0);
    const scalarEventEnd = (clipEvents || []).reduce((max, event) => Math.max(max, event.timestamp), 0);
    return Math.max(0.01, noteEnd, ccEnd, scalarEventEnd);
  }, [clipCCEvents, clipEvents, notePairs]);

  const sourceLength = Math.max(0.01, clip?.sourceLength || clip?.loopLength || clipDuration || 0.01);
  const editorPaddingSeconds = getEditorPaddingSeconds(pixelsPerSecond);
  const editorContentEnd = clipStartTime + contentDuration + editorPaddingSeconds;
  const contentWidth = Math.max(visibleGridWidth, editorContentEnd * pixelsPerSecond);
  const maxScrollX = Math.max(0, contentWidth - visibleGridWidth);
  const maxScrollY = Math.max(0, TOTAL_NOTES * noteHeight - noteGridHeight);
  const formatSeconds = useCallback((value: number) => value.toFixed(3), []);
  const applySourceLength = useCallback((nextLength: number, description: string) => {
    if (!clip) return;
    const length = Math.max(0.01, Number.isFinite(nextLength) ? nextLength : sourceLength);
    setSourceLengthDraft(formatSeconds(length));
    setMIDIClipSourceWindow(clipId, {
      sourceLength: length,
      loopLength: length,
    }, description);
  }, [clip, clipId, formatSeconds, setMIDIClipSourceWindow, sourceLength]);

  const commitSourceLengthDraft = useCallback(() => {
    const parsed = Number.parseFloat(sourceLengthDraft);
    if (!Number.isFinite(parsed)) {
      setSourceLengthDraft(formatSeconds(sourceLength));
      return;
    }
    applySourceLength(parsed, "Edit MIDI source length");
  }, [applySourceLength, formatSeconds, sourceLength, sourceLengthDraft]);

  useEffect(() => {
    setSourceLengthDraft(formatSeconds(sourceLength));
  }, [clipId, formatSeconds, sourceLength]);

  useEffect(() => {
    if (!sessionId) return;
    updateMidiEditorSession(sessionId, {
      scrollY,
      ...(isDetached ? {
        windowPixelsPerSecond: timelinePixelsPerSecond,
        windowScrollX: timelineScrollX,
      } : {}),
    });
  }, [isDetached, scrollY, sessionId, timelinePixelsPerSecond, timelineScrollX, updateMidiEditorSession]);

  const stopAudition = useCallback(() => {
    const current = auditionRef.current;
    if (current.timeoutId !== null) {
      window.clearTimeout(current.timeoutId);
      current.timeoutId = null;
    }
    if (current.note !== null) {
      void nativeBridge.sendMidiNote(trackId, current.note, 0, false).catch(() => undefined);
      current.note = null;
    }
  }, [trackId]);

  const auditionNote = useCallback((note: number, velocity = 90, options?: { throttle?: boolean; durationMs?: number }) => {
    if (!pianoRollAuditionEnabled) return;
    const now = performance.now();
    if (options?.throttle && now - auditionRef.current.lastAt < AUDITION_THROTTLE_MS) return;
    auditionRef.current.lastAt = now;
    stopAudition();
    const safeNote = clamp(Math.round(note), 0, 127);
    const safeVelocity = clamp(Math.round(velocity), 1, 127);
    auditionRef.current.note = safeNote;
    void nativeBridge.sendMidiNote(trackId, safeNote, safeVelocity, true).catch(() => undefined);
    auditionRef.current.timeoutId = window.setTimeout(() => {
      stopAudition();
    }, options?.durationMs ?? AUDITION_DURATION_MS);
  }, [pianoRollAuditionEnabled, stopAudition, trackId]);

  const auditionDraggedPianoKey = useCallback((noteNumber: number) => {
    const safeNote = clamp(Math.round(noteNumber), 0, 127);
    if (keyDragRef.current.visited.has(safeNote)) return;
    keyDragRef.current.visited.add(safeNote);
    auditionNote(safeNote, pianoRollInsertVelocity, { durationMs: 360 });
  }, [auditionNote, pianoRollInsertVelocity]);

  const beginPianoKeyDrag = useCallback((noteNumber: number) => {
    keyDragRef.current = { active: true, visited: new Set() };
    auditionDraggedPianoKey(noteNumber);
  }, [auditionDraggedPianoKey]);

  const maybeAuditionPianoKeyDuringDrag = useCallback((noteNumber: number) => {
    if (!keyDragRef.current.active) return;
    auditionDraggedPianoKey(noteNumber);
  }, [auditionDraggedPianoKey]);

  const noteFromPianoKeyPointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top + scrollY) / noteHeight);
    return clamp(TOTAL_NOTES - 1 - row, 0, TOTAL_NOTES - 1);
  }, [noteHeight, scrollY]);

  const beginPianoKeyPointerDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginPianoKeyDrag(noteFromPianoKeyPointer(event));
  }, [beginPianoKeyDrag, noteFromPianoKeyPointer]);

  const updatePianoKeyPointerDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!keyDragRef.current.active) return;
    maybeAuditionPianoKeyDuringDrag(noteFromPianoKeyPointer(event));
  }, [maybeAuditionPianoKeyDuringDrag, noteFromPianoKeyPointer]);

  const endPianoKeyDrag = useCallback(() => {
    if (!keyDragRef.current.active) return;
    keyDragRef.current.active = false;
    keyDragRef.current.visited.clear();
    stopAudition();
  }, [stopAudition]);

  useEffect(() => {
    if (!pianoRollAuditionEnabled) stopAudition();
  }, [pianoRollAuditionEnabled, stopAudition]);

  useEffect(() => {
    window.addEventListener("pointerup", endPianoKeyDrag);
    window.addEventListener("pointercancel", endPianoKeyDrag);
    return () => {
      window.removeEventListener("pointerup", endPianoKeyDrag);
      window.removeEventListener("pointercancel", endPianoKeyDrag);
    };
  }, [endPianoKeyDrag]);

  const getNoteY = useCallback((noteNumber: number) => {
    return (TOTAL_NOTES - 1 - noteNumber) * noteHeight - scrollY;
  }, [noteHeight, scrollY]);

  const getNoteFromY = useCallback((y: number): number => {
    return clamp(TOTAL_NOTES - 1 - Math.floor((y + scrollY) / noteHeight), 0, 127);
  }, [noteHeight, scrollY]);

  const midiSnapEventTimes = useMemo(() => {
    const times: number[] = [];
    for (const pair of notePairs) {
      times.push(pair.startTime, pair.startTime + pair.duration);
    }
    for (const event of clipCCEvents || []) {
      times.push(event.time);
    }
    for (const event of clipEvents || []) {
      if (Number.isFinite(event.timestamp)) times.push(event.timestamp);
    }
    return times.filter((time) => Number.isFinite(time) && time >= 0);
  }, [clipCCEvents, clipEvents, notePairs]);

  const snapTime = useCallback((
    time: number,
    options: { bypassSnap?: boolean; originalTime?: number } = {},
  ): number => {
    if (!snapEnabled || options.bypassSnap) return Math.max(0, time);
    const projectTime = clipStartTime + time;
    const originalProjectTime = options.originalTime === undefined
      ? undefined
      : clipStartTime + options.originalTime;
    const snappedProjectTime = snapTimeByType({
      time: projectTime,
      originalTime: originalProjectTime,
      tempo,
      timeSignature,
      gridSize,
      snapType,
      quantizePreset: activeQuantizePreset,
      quantizeGridSize: activeQuantizePreset.gridSize,
      pixelsPerSecond,
      cursorTime: useDAWStore.getState().transport.currentTime,
      eventTimes: midiSnapEventTimes.map((eventTime) => clipStartTime + eventTime),
    });
    return Math.max(0, snappedProjectTime - clipStartTime);
  }, [
    activeQuantizePreset,
    clipStartTime,
    gridSize,
    midiSnapEventTimes,
    pixelsPerSecond,
    snapEnabled,
    snapType,
    tempo,
    timeSignature,
  ]);

  const getTimeFromX = useCallback((x: number) => {
    return projectXToMidiSourceTime(x - PIANO_WIDTH, {
      pixelsPerSecond,
      scrollX: timelineScrollX,
      clipStartTime,
    });
  }, [clipStartTime, pixelsPerSecond, timelineScrollX]);

  const pianoRollHitNotes = useMemo(() => notePairs.map((pair) => ({
    id: noteIdFor(clipId, pair.startTime, pair.noteNumber),
    x: PIANO_WIDTH + midiSourceTimeToProjectX(pair.startTime, {
      pixelsPerSecond,
      scrollX: timelineScrollX,
      clipStartTime,
    }),
    y: getNoteY(pair.noteNumber),
    width: Math.max(4, pair.duration * pixelsPerSecond),
    height: noteHeight,
  })), [clipId, clipStartTime, getNoteY, noteHeight, notePairs, pixelsPerSecond, timelineScrollX]);

  const pianoRollHitLanes = useMemo(() => {
    if (!activeLane) return [];
    const activeLaneIsVelocity = activeLane.kind === "velocity";
    const lanes: Array<{
      id: string;
      y: number;
      height: number;
      headerWidth: number;
      resizeHandleHeight: number;
      kind: "velocity" | "controller";
    }> = [{
      id: activeLane.id,
      y: noteGridHeight,
      height: activeLaneIsVelocity ? velocityLaneHeight : ccLaneHeight,
      headerWidth: PIANO_WIDTH,
      resizeHandleHeight: 6,
      kind: activeLaneIsVelocity ? "velocity" : "controller",
    }];
    return lanes;
  }, [activeLane, ccLaneHeight, noteGridHeight, velocityLaneHeight]);

  const pianoRollControllerHitEvents = useMemo(() => {
    if (!activeControllerLane) return [];
    const laneId = activeControllerLane.id;
    return controllerEventsForLane.map((event, index) => ({
      laneId,
      eventId: `${laneId}-${event.time.toFixed(6)}-${index}`,
      x: PIANO_WIDTH + event.time * pixelsPerSecond - scrollX,
      y: ccLaneY + ccLaneHeight * (1 - event.value / 127),
      radius: 6,
    }));
  }, [activeControllerLane, ccLaneHeight, ccLaneY, controllerEventsForLane, pixelsPerSecond, scrollX]);

  const loopBoundaryStartX = clip?.loopEnabled
    ? PIANO_WIDTH + (clip.loopOffset ?? clip.offset ?? 0) * pixelsPerSecond - scrollX
    : undefined;
  const loopBoundaryEndX = clip?.loopEnabled
    ? PIANO_WIDTH + ((clip.loopOffset ?? clip.offset ?? 0) + (clip.loopLength ?? clip.sourceLength ?? clipDuration)) * pixelsPerSecond - scrollX
    : undefined;
  const previewLoopBoundaryStartX = loopBoundaryDrag?.edge === "start" ? loopBoundaryDrag.currentX : loopBoundaryStartX;
  const previewLoopBoundaryEndX = loopBoundaryDrag?.edge === "end" ? loopBoundaryDrag.currentX : loopBoundaryEndX;

  const getPointer = (event: KonvaEvent) => {
    const stage = event.target.getStage();
    return stage?.getPointerPosition() ?? null;
  };

  const rangeFromRect = useCallback((rect: RangeDragState) => {
    const left = Math.min(rect.startX, rect.currentX);
    const right = Math.max(rect.startX, rect.currentX);
    const top = Math.min(rect.startY, rect.currentY);
    const bottom = Math.max(rect.startY, rect.currentY);
    const startTime = Math.max(0, snapTime(getTimeFromX(left)));
    const endTime = Math.max(0, snapTime(getTimeFromX(right)));
    return {
      startTime,
      endTime,
      minNote: Math.min(getNoteFromY(top), getNoteFromY(bottom)),
      maxNote: Math.max(getNoteFromY(top), getNoteFromY(bottom)),
      includeCC: true,
    };
  }, [clipDuration, getNoteFromY, getTimeFromX, snapTime]);

  const pointInsideEditRange = useCallback((x: number, y: number) => {
    if (!midiEditRange) return false;
    const time = getTimeFromX(x);
    const note = getNoteFromY(y);
    return time >= midiEditRange.startTime
      && time <= midiEditRange.endTime
      && note >= midiEditRange.minNote
      && note <= midiEditRange.maxNote;
  }, [getNoteFromY, getTimeFromX, midiEditRange]);

  const getLatestClipEvents = useCallback(() => {
    const latestTrack = useDAWStore.getState().tracks.find((candidate) => candidate.id === trackId);
    const latestClip = latestTrack?.midiClips.find((candidate) => candidate.id === clipId);
    return latestClip?.events ? latestClip.events.map((event) => ({ ...event })) : [];
  }, [trackId, clipId]);

  const getLatestCCEvents = useCallback(() => {
    const latestTrack = useDAWStore.getState().tracks.find((candidate) => candidate.id === trackId);
    const latestClip = latestTrack?.midiClips.find((candidate) => candidate.id === clipId);
    return latestClip?.ccEvents ? latestClip.ccEvents.map((event) => ({ ...event })) : [];
  }, [trackId, clipId]);

  useEffect(() => {
    const updateDimensions = () => {
      if (!containerRef.current) return;
      setDimensions({
        width: Math.max(1, containerRef.current.clientWidth),
        height: Math.max(1, containerRef.current.clientHeight),
      });
      setToolbarHeight(toolbarRef.current?.offsetHeight || TOOLBAR_HEIGHT);
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateDimensions)
      : null;
    if (containerRef.current && resizeObserver) {
      resizeObserver.observe(containerRef.current);
    }
    if (toolbarRef.current && resizeObserver) {
      resizeObserver.observe(toolbarRef.current);
    }
    return () => {
      window.removeEventListener("resize", updateDimensions);
      resizeObserver?.disconnect();
    };
  }, []);

  useEffect(() => {
    setScrollY((previous) => clamp(previous, 0, maxScrollY));
  }, [maxScrollY]);

  useEffect(() => {
    const scrollbar = scrollbarRef.current;
    if (scrollbar && Math.abs(scrollbar.scrollLeft - timelineScrollX) > 1) {
      scrollbar.scrollLeft = timelineScrollX;
    }
  }, [timelineScrollX]);

  useEffect(() => {
    const scrollbar = verticalScrollbarRef.current;
    if (scrollbar && Math.abs(scrollbar.scrollTop - scrollY) > 1) {
      scrollbar.scrollTop = scrollY;
    }
  }, [scrollY]);

  const revealPreviewNote = useCallback((note: number) => {
    const safeNote = clamp(Math.round(note), 0, 127);
    const noteTop = (TOTAL_NOTES - 1 - safeNote) * noteHeight;
    const noteBottom = noteTop + noteHeight;
    const verticalPadding = noteHeight * 2;
    setScrollY((previous) => {
      const visibleTop = previous + verticalPadding;
      const visibleBottom = previous + noteGridHeight - verticalPadding;
      if (noteTop >= visibleTop && noteBottom <= visibleBottom) return previous;
      return clamp(noteTop - noteGridHeight * 0.45, 0, maxScrollY);
    });
  }, [maxScrollY, noteGridHeight, noteHeight]);

  const showPreviewNote = useCallback((
    rawNote: number,
    velocity = 96,
    isNoteOn = true,
    options?: { reveal?: boolean },
  ) => {
    const note = clamp(Math.round(rawNote), 0, 127);
    const isOn = isNoteOn && velocity > 0;
    const existingTimeout = previewNoteTimeoutsRef.current.get(note);
    if (existingTimeout !== undefined) {
      window.clearTimeout(existingTimeout);
      previewNoteTimeoutsRef.current.delete(note);
    }
    setActivePreviewNotes((previous) => {
      const next = new Set(previous);
      if (isOn) next.add(note);
      else next.delete(note);
      return next;
    });
    if (isOn) {
      if (options?.reveal) revealPreviewNote(note);
      const timeoutId = window.setTimeout(() => {
        previewNoteTimeoutsRef.current.delete(note);
        setActivePreviewNotes((previous) => {
          if (!previous.has(note)) return previous;
          const next = new Set(previous);
          next.delete(note);
          return next;
        });
      }, 1800);
      previewNoteTimeoutsRef.current.set(note, timeoutId);
    }
  }, [revealPreviewNote]);

  useEffect(() => {
    const handlePreviewNote = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        trackId?: string;
        note?: number;
        velocity?: number;
        isNoteOn?: boolean;
      } | undefined;
      if (!detail || detail.trackId !== trackId || typeof detail.note !== "number") return;
      const isOn = detail.isNoteOn !== false && (detail.velocity ?? 0) > 0;
      showPreviewNote(detail.note, detail.velocity ?? 0, isOn);
    };

    window.addEventListener("openstudio-midi-note-preview", handlePreviewNote);
    return () => {
      window.removeEventListener("openstudio-midi-note-preview", handlePreviewNote);
      previewNoteTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      previewNoteTimeoutsRef.current.clear();
    };
  }, [showPreviewNote, trackId]);

  useEffect(() => {
    if (!trackId || isTransportPlaying) return;
    let cancelled = false;
    const pollNoteActivity = async () => {
      const activities = await nativeBridge.getTrackMIDINoteActivity(trackId, 1200).catch(() => []);
      if (cancelled) return;
      const now = performance.now();
      for (const activity of activities) {
        if (typeof activity.note !== "number") continue;
        const note = clamp(Math.round(activity.note), 0, 127);
        const ageMs = typeof activity.ageMs === "number" ? activity.ageMs : 1200;
        const lastRevealAt = lastRevealedPreviewNoteAtRef.current.get(note) ?? 0;
        const shouldReveal = activity.active !== false && ageMs < 260 && now - lastRevealAt > 280;
        if (shouldReveal) {
          lastRevealedPreviewNoteAtRef.current.set(note, now);
        }
        showPreviewNote(note, activity.velocity ?? 96, activity.active !== false, { reveal: shouldReveal });
      }
    };
    void pollNoteActivity();
    const intervalId = window.setInterval(() => {
      void pollNoteActivity();
    }, 80);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isTransportPlaying, showPreviewNote, trackId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (isEditorWheelOwnedTarget(event.target)) return;
      const eventElement = event.target instanceof Element ? event.target : null;
      const isSidebar = Boolean(eventElement?.closest(".piano-roll-sidebar"));
      const keyboardViewport = eventElement?.closest<HTMLElement>(".piano-roll-key-viewport");
      const isKeyboard = Boolean(keyboardViewport);
      const stageElement = container.querySelector<HTMLElement>(".piano-roll-stage-wrap");
      const stageRect = stageElement?.getBoundingClientRect();
      const stageX = stageRect ? event.clientX - stageRect.left : -1;
      const stageY = stageRect ? event.clientY - stageRect.top : -1;
      const isInsideStage = Boolean(
        stageRect
        && stageX >= 0
        && stageY >= 0
        && stageX <= stageRect.width
        && stageY <= stageRect.height,
      );
      const wheelHit = isInsideStage
        ? hitTestPianoRoll(stageX, stageY, {
          pianoWidth: PIANO_WIDTH,
          noteGridHeight,
          velocityLaneY,
          velocityLaneHeight: isVelocityLaneActive ? velocityLaneHeight : 0,
          controllerLaneY: ccLaneY,
          controllerLaneHeight: activeControllerLane ? ccLaneHeight : 0,
          noteEdgeHitWidth: NOTE_EDGE_HIT_WIDTH,
          timeFromX: getTimeFromX,
          noteFromY: getNoteFromY,
          notes: pianoRollHitNotes,
          lanes: pianoRollHitLanes,
          controllerEvents: pianoRollControllerHitEvents,
          loopStartX: loopBoundaryStartX,
          loopEndX: loopBoundaryEndX,
          loopBoundaryHitWidth: 6,
        })
        : { kind: "outside" as const };
      const isControllerTarget = wheelHit.kind === "velocity-lane"
        || wheelHit.kind === "controller-lane"
        || wheelHit.kind === "controller-node"
        || wheelHit.kind === "controller-segment"
        || wheelHit.kind === "lane-header"
        || wheelHit.kind === "lane-resize";
      const wheelSubtarget = isSidebar
        ? "sidebar" as const
        : isKeyboard
          ? "keyboard" as const
          : wheelHit.kind === "note"
            ? "note" as const
            : isControllerTarget
              ? "controller_lane" as const
              : "grid" as const;
      const shortcutPlatform = getShortcutPlatform();
      const behaviorProfile = getMouseBehaviorProfile(
        useDAWStore.getState().mouseBehaviorProfileId,
        shortcutPlatform,
      );
      const gesture = resolveWheelGesture(event, {
        surface: "piano_roll",
        subtarget: wheelSubtarget,
        platform: toMouseBehaviorPlatform(shortcutPlatform),
        hoveredTargetId: wheelHit.kind === "note" ? wheelHit.noteId : undefined,
      }, behaviorProfile.wheel);
      if (gesture.preventDefault) event.preventDefault();
      if (gesture.stopPropagation) event.stopPropagation();
      const isAccumulatedNoteWheel = wheelHit.kind === "note" && (
        (gesture.operation === "nudge" && gesture.target === "note-position")
        || (gesture.operation === "adjust" && gesture.target === "note-property")
      );
      if (!isAccumulatedNoteWheel) contextWheelAccumulatorRef.current?.reset();
      if (gesture.operation === "native-scroll") return;

      if (gesture.operation === "zoom" && gesture.target === "midi-note-height") {
        if (gesture.amount === 0) return;
        const keyboardRect = keyboardViewport?.getBoundingClientRect();
        const noteHeightZoomTarget = isKeyboard
          ? "keyboard" as const
          : wheelHit.kind === "note"
            ? "note" as const
            : "grid" as const;
        const pointerY = getMidiNoteHeightZoomPointerOffset({
          target: noteHeightZoomTarget,
          stagePointerOffset: isInsideStage ? stageY : undefined,
          keyboardPointerOffset: keyboardRect
            ? event.clientY - keyboardRect.top
            : undefined,
          gridHeight: noteGridHeight,
        });
        const unclampedNextHeight = clamp(
          noteHeight * Math.exp(-gesture.amount * 0.0015),
          MIN_NOTE_HEIGHT,
          MAX_NOTE_HEIGHT,
        );
        const nextMaxScrollY = Math.max(0, TOTAL_NOTES * unclampedNextHeight - noteGridHeight);
        const next = computeAnchoredVerticalWheelZoom({
          itemHeight: noteHeight,
          scrollOffset: scrollY,
          pointerOffset: pointerY,
          amount: gesture.amount,
          minItemHeight: MIN_NOTE_HEIGHT,
          maxItemHeight: MAX_NOTE_HEIGHT,
          maxScrollOffset: nextMaxScrollY,
        });
        setNoteHeight(next.itemHeight);
        setScrollY(next.scrollOffset);
        return;
      }

      if (
        gesture.operation === "nudge"
        && gesture.target === "note-position"
        && wheelHit.kind === "note"
      ) {
        const sessionKey = sessionId ?? (isDetached ? "detached" : "embedded");
        const activeTarget = contextWheelEditControllerRef.current?.getActiveTarget();
        const matchingTarget = activeTarget?.kind === "note-nudge"
          && activeTarget.sessionKey === sessionKey
          && activeTarget.trackId === trackId
          && activeTarget.clipId === clipId
          && (
            wheelHit.noteId === activeTarget.initialNoteId
            || wheelHit.noteId === activeTarget.currentNoteId
          )
          ? activeTarget
          : null;
        if (!contextWheelAccumulatorRef.current) return;
        const initialNoteId = matchingTarget?.initialNoteId ?? wheelHit.noteId;
        const direction = getAccumulatedWheelNudgeDirection(
          contextWheelAccumulatorRef.current,
          `note-nudge:${sessionKey}:${trackId}:${clipId}:${initialNoteId}`,
          gesture.amount,
        );
        if (direction === 0) {
          const pendingTarget = contextWheelEditControllerRef.current?.getActiveTarget();
          if (pendingTarget === matchingTarget && pendingTarget) {
            contextWheelEditControllerRef.current?.touch(pendingTarget);
          }
          return;
        }
        const currentEvents = getLatestClipEvents();
        const currentNoteId = matchingTarget?.currentNoteId ?? wheelHit.noteId;
        const pair = parseNotePairs(currentEvents).find((candidate) =>
          noteIdFor(clipId, candidate.startTime, candidate.noteNumber) === currentNoteId,
        );
        if (!pair) return;
        const nextStart = Math.max(0, pair.startTime + direction * stepDurationSeconds);
        if (nextStart === pair.startTime) return;
        const target = matchingTarget ?? {
          kind: "note-nudge" as const,
          trackId,
          clipId,
          sessionKey,
          initialNoteId: wheelHit.noteId,
          currentNoteId: wheelHit.noteId,
          propertyKey: "position",
          description: "Nudge MIDI note",
          originalEvents: null,
          originalIsModified: useDAWStore.getState().isModified,
        };
        contextWheelEditControllerRef.current?.touch(target);
        const { events: nextEvents, nextIds } = rebuildMIDIEventsForNotes(
          currentEvents,
          clipId,
          [currentNoteId],
          (candidate) => ({ ...candidate, startTime: nextStart }),
        );
        if (JSON.stringify(nextEvents) === JSON.stringify(currentEvents)) return;
        previewMIDIClipEvents(trackId, clipId, nextEvents);
        if (nextIds[0]) target.currentNoteId = nextIds[0];
        if (nextIds.length > 0) setSelectedNoteIds(nextIds);
        return;
      }

      if (
        gesture.operation === "adjust"
        && gesture.target === "note-property"
        && wheelHit.kind === "note"
      ) {
        const sessionKey = sessionId ?? (isDetached ? "detached" : "embedded");
        const propertyKey = selectedNoteMetadataLaneType ?? "velocity";
        const activeTarget = contextWheelEditControllerRef.current?.getActiveTarget();
        const matchingTarget = activeTarget?.kind === "note-property"
          && activeTarget.sessionKey === sessionKey
          && activeTarget.trackId === trackId
          && activeTarget.clipId === clipId
          && activeTarget.propertyKey === propertyKey
          && (
            wheelHit.noteId === activeTarget.initialNoteId
            || wheelHit.noteId === activeTarget.currentNoteId
          )
          ? activeTarget
          : null;
        if (!contextWheelAccumulatorRef.current) return;
        const initialNoteId = matchingTarget?.initialNoteId ?? wheelHit.noteId;
        const stepCount = getAccumulatedWheelStepCount(
          contextWheelAccumulatorRef.current,
          `note-property:${sessionKey}:${trackId}:${clipId}:${initialNoteId}:${propertyKey}`,
          gesture.amount,
        );
        if (stepCount === 0) {
          const pendingTarget = contextWheelEditControllerRef.current?.getActiveTarget();
          if (pendingTarget === matchingTarget && pendingTarget) {
            contextWheelEditControllerRef.current?.touch(pendingTarget);
          }
          return;
        }
        const oldEvents = getLatestClipEvents();
        const currentNoteId = matchingTarget?.currentNoteId ?? wheelHit.noteId;
        const pair = parseNotePairs(oldEvents).find((candidate) =>
          noteIdFor(clipId, candidate.startTime, candidate.noteNumber) === currentNoteId,
        );
        if (!pair) return;
        const integerStep = Math.trunc(stepCount);
        if (integerStep === 0) return;
        const nextEvents = selectedNoteMetadataLaneType
          ? applyNoteMetadataValueToEvents(
            oldEvents,
            pair,
            selectedNoteMetadataLaneType,
            clamp(
              noteMetadataValueForPair(pair, selectedNoteMetadataLaneType) + integerStep,
              0,
              noteMetadataLaneMax(selectedNoteMetadataLaneType),
            ),
          )
          : oldEvents.map((midiEvent, index) => index === pair.onIndex
            ? { ...midiEvent, velocity: clamp((midiEvent.velocity ?? pair.velocity) + integerStep, 1, 127) }
            : midiEvent);
        if (JSON.stringify(nextEvents) === JSON.stringify(oldEvents)) return;
        const target = matchingTarget ?? {
          kind: "note-property" as const,
          trackId,
          clipId,
          sessionKey,
          initialNoteId: wheelHit.noteId,
          currentNoteId,
          propertyKey,
          description: selectedNoteMetadataLaneType
            ? `Adjust MIDI ${noteMetadataLaneName(selectedNoteMetadataLaneType)}`
            : "Adjust MIDI note velocity",
          originalEvents: null,
          originalIsModified: useDAWStore.getState().isModified,
        };
        contextWheelEditControllerRef.current?.touch(target);
        previewMIDIClipEvents(trackId, clipId, sortEvents(nextEvents));
        setSelectedNoteIds([currentNoteId]);
        return;
      }

      if (gesture.operation === "zoom" && gesture.target === "timeline") {
        const rect = container.getBoundingClientRect();
        const cursorGridX = clamp(event.clientX - rect.left - sidebarWidth - TIMELINE_DIVIDER_WIDTH - PIANO_WIDTH, 0, visibleGridWidth);
        const projectTimeAtCursor = (timelineScrollX + cursorGridX) / pixelsPerSecond;
        const factor = Math.exp(-gesture.amount * 0.0015);
        const nextPixelsPerSecond = clamp(pixelsPerSecond * factor, 1, 1000);
        const nextEditorContentEnd = clipStartTime + contentDuration + getEditorPaddingSeconds(nextPixelsPerSecond);
        const nextContentWidth = Math.max(visibleGridWidth, nextEditorContentEnd * nextPixelsPerSecond);
        const nextMaxScrollX = Math.max(0, nextContentWidth - visibleGridWidth);
        const nextScrollX = clamp(projectTimeAtCursor * nextPixelsPerSecond - cursorGridX, 0, nextMaxScrollX);
        setTimelineZoom(nextPixelsPerSecond);
        setTimelineScroll(nextScrollX, timelineScrollY);
        return;
      }
      if (gesture.operation === "scroll" && gesture.axis === "horizontal") {
        setTimelineScroll(clamp(timelineScrollX + gesture.amount, 0, maxScrollX), timelineScrollY);
      } else if (gesture.operation === "scroll") {
        setScrollY((previous) => clamp(previous + gesture.amount, 0, maxScrollY));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [
    activeControllerLane,
    ccLaneHeight,
    ccLaneY,
    clipStartTime,
    clipId,
    contentDuration,
    getEditorPaddingSeconds,
    getLatestClipEvents,
    getNoteFromY,
    getTimeFromX,
    isVelocityLaneActive,
    isDetached,
    loopBoundaryEndX,
    loopBoundaryStartX,
    maxScrollX,
    maxScrollY,
    noteGridHeight,
    noteHeight,
    pianoRollControllerHitEvents,
    pianoRollHitLanes,
    pianoRollHitNotes,
    pixelsPerSecond,
    previewMIDIClipEvents,
    scrollY,
    sessionId,
    selectedNoteMetadataLaneType,
    setSelectedNoteIds,
    setTimelineScroll,
    setTimelineZoom,
    sidebarWidth,
    stepDurationSeconds,
    timelineScrollX,
    timelineScrollY,
    trackId,
    velocityLaneHeight,
    velocityLaneY,
    visibleGridWidth,
  ]);

  useEffect(() => {
    if (!showTransformMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (transformMenuRef.current && !transformMenuRef.current.contains(event.target as Node)) {
        setShowTransformMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTransformMenu]);

  useEffect(() => {
    return () => {
      stopAudition();
    };
  }, [stopAudition]);

  useEffect(() => {
    const handleBlur = () => stopAudition();
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [stopAudition]);

  // The root app owns the one capture-phase key listener. The most recently
  // interacted editor session registers its local behavior with that router.
  const shortcutSessionId = sessionId || windowSessionId || `docked:${trackId}:${clipId}`;
  const pianoShortcutContext = useMemo<EditShortcutContext>(
    () => ({ kind: "piano_roll", sessionId: shortcutSessionId }),
    [shortcutSessionId],
  );
  const pianoActionExecutorRef = useRef<
    (actionId: string) => ReturnType<ShortcutSurfaceHandler>
  >(() => "unmatched");
  pianoActionExecutorRef.current = (actionId) => {
    if (actionId === "midi.closeEditor") {
      stopAudition();
      if (isDetached || windowRole !== "main") {
        void nativeBridge.closeMidiEditorWindow(shortcutSessionId, "close");
      } else {
        useDAWStore.getState().closePianoRoll();
      }
      return "handled";
    }
    if (actionId === "view.togglePianoRoll") {
      stopAudition();
      if (isDetached || windowRole !== "main") {
        void nativeBridge.closeMidiEditorWindow(shortcutSessionId, "close");
      } else {
        useDAWStore.getState().closePianoRoll();
      }
      return "handled";
    }

    if (!PIANO_LOCK_SAFE_ACTION_IDS.has(actionId)
        && !getEditableMidiClip(useDAWStore.getState(), trackId, clipId)) {
      return "claimed_noop";
    }

    const stepInputSemitone = PIANO_STEP_INPUT_ACTION_SEMITONES[actionId];
    if (stepInputSemitone !== undefined) {
      if (!stepInputEnabled || selectedNoteIds.length > 0) return "claimed_noop";
      const noteNumber = (stepInputOctave + 2) * 12 + stepInputSemitone;
      if (noteNumber < 0 || noteNumber > 127) return "claimed_noop";
      const newId = addMIDINote(
        trackId,
        clipId,
        stepInputPosition,
        noteNumber,
        stepDurationSeconds,
        pianoRollInsertVelocity,
      );
      if (!newId) return "claimed_noop";
      setSelectedNoteIds([newId]);
      auditionNote(noteNumber, pianoRollInsertVelocity);
      setStepInputPosition(stepInputPosition + stepDurationSeconds);
      return "handled";
    }

    const nextTool = PIANO_TOOL_ACTIONS[actionId as keyof typeof PIANO_TOOL_ACTIONS];
    if (nextTool) {
      setTool(nextTool);
      return "handled";
    }

    if (actionId === "midi.repeatSelection") {
      const repeatingRange = Boolean(midiEditRange);
      const nextIds = repeatMIDISelection(trackId, clipId);
      if (!repeatingRange && nextIds.length > 0) setSelectedNoteIds(nextIds);
      return repeatingRange || nextIds.length > 0 ? "handled" : "claimed_noop";
    }
    if (actionId === "midi.quantizeLast") {
      if (isDetached || windowRole !== "main") {
        return publishDetachedMidiQuantize(
          shortcutSessionId,
          selectedNoteIds,
          midiEditRange,
        ) ? "handled" : "claimed_noop";
      }
      const nextIds = quantizeSelectedMIDINotesUsingLast(trackId, clipId);
      if (nextIds.length > 0) setSelectedNoteIds(nextIds);
      return nextIds.length > 0 ? "handled" : "claimed_noop";
    }
    if (actionId === "midi.selectAll") {
      selectAllMIDINotes();
      return "handled";
    }
    if (actionId === "midi.deselectAll") {
      if (selectedNoteIds.length === 0 && !midiEditRange) return "claimed_noop";
      setSelectedNoteIds([]);
      setMIDIEditRange(null);
      return "handled";
    }
    if (actionId === "midi.selectNextNote" || actionId === "midi.selectPreviousNote") {
      const orderedPairs = parseNotePairs(getLatestClipEvents()).sort((left, right) => (
        left.startTime - right.startTime
        || left.noteNumber - right.noteNumber
        || (left.channel ?? 1) - (right.channel ?? 1)
        || left.duration - right.duration
      ));
      const anchorId = selectedNoteIds[selectedNoteIds.length - 1];
      if (!anchorId) return "claimed_noop";
      const currentIndex = orderedPairs.findIndex((pair) => (
        noteIdFor(clipId, pair.startTime, pair.noteNumber) === anchorId
      ));
      const nextIndex = currentIndex + (actionId === "midi.selectNextNote" ? 1 : -1);
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= orderedPairs.length) {
        return "claimed_noop";
      }
      const next = orderedPairs[nextIndex];
      setSelectedNoteIds([noteIdFor(clipId, next.startTime, next.noteNumber)]);
      setMIDIEditRange(null);
      return "handled";
    }
    if (actionId === "midi.glueSelectedNotes") {
      const nextIds = glueSelectedMIDINotes(trackId, clipId, selectedNoteIds);
      if (nextIds.length === 0) return "claimed_noop";
      setSelectedNoteIds(nextIds);
      return "handled";
    }
    if (actionId === "midi.loopFromSelectedNotes") {
      const actionPairs = parseNotePairs(getLatestClipEvents()).filter((pair) =>
        selectedNoteIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)),
      );
      if (actionPairs.length === 0) return "claimed_noop";
      const start = Math.min(...actionPairs.map((pair) => pair.startTime));
      const end = Math.max(...actionPairs.map((pair) => pair.startTime + pair.duration));
      const loopStart = clipStartTime + start;
      const loopEnd = clipStartTime + end;
      if (isDetached || windowRole !== "main") {
        if (!publishDetachedLoopRegion(loopStart, loopEnd, shortcutSessionId)) {
          return "claimed_noop";
        }
      } else {
        useDAWStore.getState().setLoopRegion(loopStart, loopEnd);
      }
      return "handled";
    }
    if (actionId === "midi.noteProperties") {
      const selectedPair = parseNotePairs(getLatestClipEvents()).find((pair) =>
        selectedNoteIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)),
      );
      if (!selectedPair) return "claimed_noop";
      setTransformDialog({ type: "velocity", value: selectedPair.velocity });
      setContextMenu(null);
      return "handled";
    }
    if (actionId === "midi.toggleGhostReference") {
      setShowGhostMIDIClips((visible) => !visible);
      return "handled";
    }
    if (actionId === "midi.configureControllerLanes") {
      const selector = controllerLaneSelectorRef.current as (
        HTMLSelectElement & { showPicker?: () => void }
      ) | null;
      if (!selector) return "claimed_noop";
      selector.focus();
      try {
        selector.showPicker?.();
      } catch {
        // Browsers can reject showPicker outside transient activation; focus is
        // still a safe, keyboard-usable fallback for this exact editor instance.
      }
      return "handled";
    }
    if (actionId === "midi.openQuantizePanel") {
      openQuantizePanel();
      return "handled";
    }
    if (actionId === "midi.quantizeLength") {
      if (selectedNoteIds.length === 0) return "claimed_noop";
      applyCurrentQuantizePreset("length");
      return "handled";
    }
    if (actionId === "midi.controllerLine") {
      openControllerLineDialog();
      return "handled";
    }
    const controllerLfoShape = {
      "midi.controllerSineLfo": "sine",
      "midi.controllerTriangleLfo": "triangle",
      "midi.controllerSquareLfo": "square",
      "midi.controllerSawUpLfo": "sawUp",
      "midi.controllerSawDownLfo": "sawDown",
    }[actionId] as ControllerLFOShape | undefined;
    if (controllerLfoShape) {
      if (selectedNoteMetadataLaneType) return "claimed_noop";
      openControllerLFODialog(controllerLfoShape);
      return "handled";
    }
    if (actionId === "midi.controllerTransform") {
      if (selectedNoteMetadataLaneType) return "claimed_noop";
      openControllerTransformDialog();
      return "handled";
    }
    if (actionId === "midi.controllerThin") {
      if (selectedNoteMetadataLaneType) return "claimed_noop";
      openControllerThinDialog();
      return "handled";
    }
    if (actionId === "midi.copyControllerLane") {
      copyCurrentControllerLane();
      return "handled";
    }
    if (actionId === "midi.pasteControllerLane") {
      if (!controllerLaneClipboard) return "claimed_noop";
      pasteControllerLaneClipboard();
      return "handled";
    }
    if (actionId === "midi.clearControllerLane") {
      clearCurrentControllerLane();
      return "handled";
    }
    if (actionId === "midi.copySelection") {
      if (!midiEditRange && selectedNoteIds.length === 0) return "claimed_noop";
      if (midiEditRange) copyMIDIRange(trackId, clipId);
      else copySelectedMIDINotes(trackId, clipId);
      return "handled";
    }
    if (actionId === "midi.cutSelection") {
      if (!midiEditRange && selectedNoteIds.length === 0) return "claimed_noop";
      if (midiEditRange) cutMIDIRange(trackId, clipId);
      else cutSelectedMIDINotes(trackId, clipId);
      stopAudition();
      return "handled";
    }
    if (actionId === "midi.pasteSelection") {
      const pastingRange = midiRangeClipboard.rangeLength > 0;
      const nextIds = pastingRange
        ? pasteMIDIRange(trackId, clipId)
        : pasteMIDINotes(trackId, clipId);
      if (!pastingRange && nextIds.length > 0) setSelectedNoteIds(nextIds);
      return pastingRange || nextIds.length > 0 ? "handled" : "claimed_noop";
    }
    if (actionId === "midi.duplicateSelection") {
      if (!midiEditRange && selectedNoteIds.length === 0) return "claimed_noop";
      const duplicatingRange = Boolean(midiEditRange);
      const nextIds = duplicatingRange
        ? duplicateMIDIRange(trackId, clipId)
        : duplicateSelectedMIDINotes(trackId, clipId);
      if (!duplicatingRange && nextIds.length > 0) setSelectedNoteIds(nextIds);
      return "handled";
    }
    if (actionId === "midi.deleteSelection") {
      if (midiEditRange) {
        deleteMIDIRange(trackId, clipId);
      } else if (selectedNoteIds.length > 0) {
        removeMIDINotes(trackId, clipId, selectedNoteIds);
        setSelectedNoteIds([]);
      } else {
        return "claimed_noop";
      }
      stopAudition();
      return "handled";
    }

    if (PIANO_MOVE_ACTION_IDS.includes(actionId as typeof PIANO_MOVE_ACTION_IDS[number])) {
      if (selectedNoteIds.length > 0) {
        const usesStepSize = actionId === "midi.moveLeftFine" || actionId === "midi.moveRightFine";
        const timeStep = usesStepSize ? stepDurationSeconds : snapDuration;
        let deltaTime = 0;
        let deltaNote = 0;
        if (actionId === "midi.moveLeft" || actionId === "midi.moveLeftFine") deltaTime = -timeStep;
        if (actionId === "midi.moveRight" || actionId === "midi.moveRightFine") deltaTime = timeStep;
        if (actionId === "midi.movePitchUp") deltaNote = 1;
        if (actionId === "midi.movePitchDown") deltaNote = -1;
        if (actionId === "midi.movePitchOctaveUp") deltaNote = 12;
        if (actionId === "midi.movePitchOctaveDown") deltaNote = -12;
        const nextIds = moveMIDINotes(trackId, clipId, selectedNoteIds, deltaTime, deltaNote);
        if (nextIds.length > 0) {
          setSelectedNoteIds(nextIds);
          const nextPair = parseNotePairs(getLatestClipEvents()).find((pair) =>
            nextIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)),
          );
          if (nextPair) auditionNote(nextPair.noteNumber, nextPair.velocity);
        }
        return "handled";
      }

      if (stepInputEnabled) {
        if (actionId === "midi.movePitchUp" || actionId === "midi.movePitchOctaveUp") {
          setStepInputOctave((previous) => Math.min(8, previous + 1));
        }
        if (actionId === "midi.movePitchDown" || actionId === "midi.movePitchOctaveDown") {
          setStepInputOctave((previous) => Math.max(-2, previous - 1));
        }
        if (actionId === "midi.moveLeft" || actionId === "midi.moveLeftFine") {
          setStepInputPosition(Math.max(0, stepInputPosition - stepDurationSeconds));
          setTimelineScroll(
            clamp(timelineScrollX - stepDurationSeconds * pixelsPerSecond, 0, maxScrollX),
            timelineScrollY,
          );
        }
        if (actionId === "midi.moveRight" || actionId === "midi.moveRightFine") {
          setStepInputPosition(stepInputPosition + stepDurationSeconds);
          setTimelineScroll(
            clamp(timelineScrollX + stepDurationSeconds * pixelsPerSecond, 0, maxScrollX),
            timelineScrollY,
          );
        }
        return "handled";
      }

      return "claimed_noop";
    }

    return "unmatched";
  };

  const shortcutHandlerRef = useRef<ShortcutSurfaceHandler>(() => "unmatched");
  shortcutHandlerRef.current = (event) => {
    if (matchesActionShortcut(event, "edit.undo")) {
      if (event.repeat) return "claimed_noop";
      if (isDetached || windowRole !== "main") {
        void nativeBridge.publishAppCommand({ command: "edit.undo", sessionId: shortcutSessionId });
      } else {
        useDAWStore.getState().undo();
      }
      return "handled";
    }
    if (matchesActionShortcut(event, "edit.redo")) {
      if (event.repeat) return "claimed_noop";
      if (isDetached || windowRole !== "main") {
        void nativeBridge.publishAppCommand({ command: "edit.redo", sessionId: shortcutSessionId });
      } else {
        useDAWStore.getState().redo();
      }
      return "handled";
    }

    const stepActionId = stepInputEnabled && selectedNoteIds.length === 0
      ? Object.keys(PIANO_STEP_INPUT_ACTION_SEMITONES).find((actionId) =>
          matchesActionShortcut(event, actionId),
        )
      : undefined;
    const actionId = stepActionId ?? PIANO_SHORTCUT_ACTION_IDS.find((candidate) =>
      matchesActionShortcut(event, candidate),
    );
    if (!actionId) return "unmatched";
    if (event.repeat && !PIANO_REPEATABLE_ACTION_IDS.has(actionId)) return "claimed_noop";
    return pianoActionExecutorRef.current(actionId);
  };

  useEffect(() => {
    const unregisterSurface = registerShortcutSurface(
      pianoShortcutContext,
      (event) => shortcutHandlerRef.current(event),
      isDetached ? { kind: "application" } : { kind: "timeline" },
    );
    const unregisterActions = registerScopedActionExecutor(
      pianoShortcutContext,
      (actionId) => pianoActionExecutorRef.current(actionId),
      PIANO_SHORTCUT_ACTION_IDS,
    );
    if (isDetached || windowRole !== "main") activateShortcutContext(pianoShortcutContext);
    return () => {
      unregisterActions();
      unregisterSurface();
    };
  }, [isDetached, pianoShortcutContext]);

  const handleScrollbarScroll = useCallback(() => {
    const scrollbar = scrollbarRef.current;
    if (!scrollbar) return;
    setTimelineScroll(clamp(scrollbar.scrollLeft, 0, maxScrollX), timelineScrollY);
  }, [maxScrollX, setTimelineScroll, timelineScrollY]);

  const handleVerticalScrollbarScroll = useCallback(() => {
    const scrollbar = verticalScrollbarRef.current;
    if (!scrollbar) return;
    setScrollY(clamp(scrollbar.scrollTop, 0, maxScrollY));
  }, [maxScrollY]);

  const getVelocityFromLaneY = useCallback((y: number) => {
    const relY = clamp(y - velocityLaneY, 0, velocityLaneHeight);
    return clamp(Math.round(127 * (1 - relY / velocityLaneHeight)), 1, 127);
  }, [velocityLaneHeight, velocityLaneY]);

  const upsertCCEvent = useCallback((eventX: number, eventY: number, existingEvents: MIDICCEvent[]) => {
    const time = snapTime(getTimeFromX(eventX));
    const relY = clamp(eventY - ccLaneY, 0, ccLaneHeight);
    if (isCC14BitMode) {
      const rawValue = clamp(Math.round(MIDI_PITCH_BEND_MAX * (1 - relY / ccLaneHeight)), 0, MIDI_PITCH_BEND_MAX);
      const split = split14BitCCValue(rawValue);
      const lsbCC = selectedCC + 32;
      const filtered = existingEvents.filter(
        (event) => !((event.cc === selectedCC || event.cc === lsbCC) && Math.abs(event.time - time) < snapDuration * 0.5),
      );
      return [
        ...filtered,
        { cc: selectedCC, time, value: split.msb },
        { cc: lsbCC, time, value: split.lsb },
      ].sort((a, b) => a.time - b.time || a.cc - b.cc);
    }
    const value = clamp(Math.round(127 * (1 - relY / ccLaneHeight)), 0, 127);
    const filtered = existingEvents.filter(
      (event) => !(event.cc === selectedCC && Math.abs(event.time - time) < snapDuration * 0.5),
    );
    return [...filtered, { cc: selectedCC, time, value }].sort((a, b) => a.time - b.time);
  }, [ccLaneHeight, ccLaneY, getTimeFromX, isCC14BitMode, selectedCC, snapDuration, snapTime]);

  const upsertPitchBendEvent = useCallback((eventX: number, eventY: number, existingEvents: MIDIEvent[]) => {
    const time = snapTime(getTimeFromX(eventX));
    const relY = clamp(eventY - ccLaneY, 0, ccLaneHeight);
    const laneValue = clamp(Math.round(127 * (1 - relY / ccLaneHeight)), 0, 127);
    const rawValue = laneValueToPitchBend(laneValue);
    const value = snapPitchBendSemitones
      ? snapPitchBendValueToSemitoneWithRange(rawValue, pitchBendRangeUp, pitchBendRangeDown)
      : rawValue;
    const filtered = existingEvents.filter(
      (event) => !(event.type === "pitchBend" && Math.abs(event.timestamp - time) < snapDuration * 0.5),
    );
    return sortEvents([...filtered, { type: "pitchBend", timestamp: time, value }]);
  }, [ccLaneHeight, ccLaneY, getTimeFromX, pitchBendRangeDown, pitchBendRangeUp, snapDuration, snapPitchBendSemitones, snapTime]);

  const upsertScalarMIDIEvent = useCallback((eventX: number, eventY: number, existingEvents: MIDIEvent[]) => {
    if (!selectedScalarMIDIEventType) return existingEvents;
    const time = snapTime(getTimeFromX(eventX));
    const relY = clamp(eventY - ccLaneY, 0, ccLaneHeight);
    const value = clamp7Bit(127 * (1 - relY / ccLaneHeight));
    const filtered = existingEvents.filter(
      (event) => !(selectedScalarMIDIEventMatches(event) && Math.abs(event.timestamp - time) < snapDuration * 0.5),
    );
    return sortEvents([...filtered, makeSelectedScalarMIDIEvent(time, value)]);
  }, [
    ccLaneHeight,
    ccLaneY,
    getTimeFromX,
    makeSelectedScalarMIDIEvent,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    snapDuration,
    snapTime,
  ]);

  const getNoteMetadataValueFromLaneY = useCallback((y: number) => {
    if (!selectedNoteMetadataLaneType) return 0;
    const relY = clamp(y - ccLaneY, 0, ccLaneHeight);
    return clamp(
      Math.round(selectedNoteMetadataLaneMax * (1 - relY / ccLaneHeight)),
      0,
      selectedNoteMetadataLaneMax,
    );
  }, [
    ccLaneHeight,
    ccLaneY,
    selectedNoteMetadataLaneMax,
    selectedNoteMetadataLaneType,
  ]);

  const upsertNoteMetadataLaneValue = useCallback((eventX: number, eventY: number, existingEvents: MIDIEvent[]) => {
    if (!selectedNoteMetadataLaneType) return existingEvents;
    const time = getTimeFromX(eventX);
    const value = getNoteMetadataValueFromLaneY(eventY);
    const pairs = parseNotePairs(existingEvents);
    const pair = pairs.find((candidate) => {
      const start = candidate.startTime;
      const end = candidate.startTime + candidate.duration;
      return time >= start - 0.000001 && time <= end + 0.000001;
    }) ?? pairs
      .map((candidate) => ({
        candidate,
        distance: Math.min(
          Math.abs(time - candidate.startTime),
          Math.abs(time - (candidate.startTime + candidate.duration)),
        ),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.candidate;

    if (!pair) return existingEvents;
    return sortEvents(applyNoteMetadataValueToEvents(existingEvents, pair, selectedNoteMetadataLaneType, value));
  }, [
    getNoteMetadataValueFromLaneY,
    getTimeFromX,
    selectedNoteMetadataLaneType,
  ]);

  const getControllerTransformRange = useCallback(() => {
    const maxEnd = Math.max(contentDuration, clipDuration, snapDuration);
    const start = midiEditRange
      ? Math.max(0, Math.min(midiEditRange.startTime, midiEditRange.endTime))
      : 0;
    const rawEnd = midiEditRange
      ? Math.max(midiEditRange.startTime, midiEditRange.endTime)
      : maxEnd;
    const end = Math.min(Math.max(rawEnd, start + snapDuration), maxEnd);
    return { startTime: start, endTime: Math.max(end, start + snapDuration) };
  }, [clipDuration, contentDuration, midiEditRange, snapDuration]);

  const promptNumber = useCallback((message: string, fallback: number, min: number, max: number) => {
    const queued = controllerPromptQueueRef.current.shift();
    if (queued !== undefined) {
      return Number.isFinite(queued) ? clamp(queued, min, max) : fallback;
    }
    void message;
    return clamp(fallback, min, max);
  }, []);

  const applyControllerLine = useCallback(() => {
    const range = getControllerTransformRange();
    const stepSeconds = Math.max(0.005, Math.min(snapDuration, 1 / 64));
    const modeInput = controllerLineModeOverrideRef.current ?? "ramp";
    controllerLineModeOverrideRef.current = null;
    if (modeInput === null) return;
    const mode = modeInput.trim().toLowerCase();
    const interpolation: ControllerInterpolationMode = mode.startsWith("s")
      ? "step"
      : mode.startsWith("p")
        ? "parabola"
      : mode.startsWith("c")
        ? "curve"
        : "linear";
    const curve = interpolation === "curve"
      ? promptNumber("Curve amount (-1 slow, 0 parabola, 1 fast)", 0.5, -0.99, 0.99)
      : 0;
    if (curve === null) return;

    if (isVelocityLaneActive) {
      const startValue = promptNumber("Start velocity value", 1, 1, 127);
      if (startValue === null) return;
      const endValue = promptNumber("End velocity value", 127, 1, 127);
      if (endValue === null) return;

      const oldEvents = getLatestClipEvents();
      const duration = Math.max(0.000001, range.endTime - range.startTime);
      const nextEvents = sortEvents(oldEvents.map((event) => {
        if (event.type !== "noteOn" || event.timestamp < range.startTime || event.timestamp > range.endTime) {
          return event;
        }

        const t = clamp((event.timestamp - range.startTime) / duration, 0, 1);
        const shaped = interpolation === "step"
          ? (t >= 1 ? 1 : 0)
          : interpolation === "parabola"
            ? t * t
            : interpolation === "curve"
              ? Math.pow(t, Math.pow(2, -curve * 4))
              : t;
        const velocity = clamp(Math.round(startValue + (endValue - startValue) * shaped), 1, 127);
        return { ...event, velocity };
      }));
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Generate MIDI velocity line");
      setShowTransformMenu(false);
      return;
    }

    if (selectedCC === PITCH_BEND_LANE) {
      const startSemitones = promptNumber("Start pitch bend in semitones", 0, -pitchBendRangeDown, pitchBendRangeUp);
      if (startSemitones === null) return;
      const endSemitones = promptNumber("End pitch bend in semitones", 0, -pitchBendRangeDown, pitchBendRangeUp);
      if (endSemitones === null) return;

      const oldEvents = getLatestClipEvents();
      const generated = generateControllerLineEvents({
        ...range,
        startValue: semitonesToPitchBendValueWithRange(startSemitones, pitchBendRangeUp, pitchBendRangeDown),
        endValue: semitonesToPitchBendValueWithRange(endSemitones, pitchBendRangeUp, pitchBendRangeDown),
        stepSeconds,
        valueMin: 0,
        valueMax: MIDI_PITCH_BEND_MAX,
        interpolation,
        curve,
      }).map((point) => ({
        type: "pitchBend" as const,
        timestamp: point.time,
        value: point.value,
      }));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...generated,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Generate MIDI pitch bend line");
      setShowTransformMenu(false);
      return;
    }
    if (selectedScalarMIDIEventType) {
      const label = selectedScalarMIDIEventLabel;
      const startValue = promptNumber(`Start ${label} value`, 0, 0, 127);
      if (startValue === null) return;
      const endValue = promptNumber(`End ${label} value`, 127, 0, 127);
      if (endValue === null) return;

      const oldEvents = getLatestClipEvents();
      const generated = generateControllerLineEvents({
        ...range,
        startValue,
        endValue,
        stepSeconds,
        interpolation,
        curve,
      }).map((point) => makeSelectedScalarMIDIEvent(point.time, point.value));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...generated,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Generate MIDI ${label} line`);
      setShowTransformMenu(false);
      return;
    }

    if (selectedNoteMetadataLaneType) {
      const label = selectedNoteMetadataLaneLabel;
      const maxValue = noteMetadataLaneMax(selectedNoteMetadataLaneType);
      const startValue = promptNumber(`Start ${label} value`, 0, 0, maxValue);
      if (startValue === null) return;
      const endValue = promptNumber(`End ${label} value`, maxValue, 0, maxValue);
      if (endValue === null) return;

      const oldEvents = getLatestClipEvents();
      const duration = Math.max(0.000001, range.endTime - range.startTime);
      const nextEvents = parseNotePairs(oldEvents)
        .filter((pair) => pair.startTime < range.endTime && pair.startTime + pair.duration > range.startTime)
        .reduce((events, pair) => {
          const t = clamp((pair.startTime - range.startTime) / duration, 0, 1);
          const shaped = interpolation === "step"
            ? (t >= 1 ? 1 : 0)
            : interpolation === "parabola"
              ? t * t
              : interpolation === "curve"
                ? Math.pow(t, Math.pow(2, -curve * 4))
                : t;
          const value = Math.round(startValue + (endValue - startValue) * shaped);
          return applyNoteMetadataValueToEvents(events, pair, selectedNoteMetadataLaneType, value);
        }, oldEvents);
      commitMIDIClipEvents(trackId, clipId, oldEvents, sortEvents(nextEvents), `Generate MIDI ${label} line`);
      setShowTransformMenu(false);
      return;
    }

    const maxCCValue = isCC14BitMode ? MIDI_PITCH_BEND_MAX : 127;
    const startValue = promptNumber(`Start CC#${selectedCC} value`, 0, 0, maxCCValue);
    if (startValue === null) return;
    const endValue = promptNumber(`End CC#${selectedCC} value`, maxCCValue, 0, maxCCValue);
    if (endValue === null) return;

    const oldCCEvents = getLatestCCEvents();
    const generatedPoints = generateControllerLineEvents({
      ...range,
      startValue,
      endValue,
      stepSeconds,
      valueMax: maxCCValue,
      interpolation,
      curve,
    });
    const generated = isCC14BitMode
      ? generatedPoints.flatMap((point) => {
          const split = split14BitCCValue(point.value);
          return [
            { cc: selectedCC, time: point.time, value: split.msb },
            { cc: selectedCC + 32, time: point.time, value: split.lsb },
          ];
        })
      : generatedPoints.map((point) => ({
          cc: selectedCC,
          time: point.time,
          value: clamp7Bit(point.value),
        }));
    const nextCCEvents = [
      ...oldCCEvents.filter((event) => {
        const laneMatch = isCC14BitMode
          ? event.cc === selectedCC || event.cc === selectedCC + 32
          : event.cc === selectedCC;
        return !(laneMatch && event.time >= range.startTime && event.time <= range.endTime);
      }),
      ...generated,
    ].sort((a, b) => a.time - b.time || a.cc - b.cc);
    updateMIDICCEvents(trackId, clipId, nextCCEvents, {
      oldCCEvents,
      description: `Generate MIDI CC#${selectedCC} line`,
    });
    setShowTransformMenu(false);
  }, [
    clipId,
    commitMIDIClipEvents,
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    isVelocityLaneActive,
    pitchBendRangeDown,
    pitchBendRangeUp,
    promptNumber,
    isCC14BitMode,
    makeSelectedScalarMIDIEvent,
    selectedCC,
    selectedNoteMetadataLaneLabel,
    selectedNoteMetadataLaneType,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    snapDuration,
    trackId,
    updateMIDICCEvents,
  ]);

  const applyControllerLFO = useCallback((shape: ControllerLFOShape) => {
    const range = getControllerTransformRange();
    const rateHz = promptNumber("LFO rate in Hz", 2, 0.01, 40);
    if (rateHz === null) return;
    const stepSeconds = Math.max(0.005, Math.min(snapDuration, 1 / 64));

    if (selectedCC === PITCH_BEND_LANE) {
      const maxDepthSemitones = Math.min(pitchBendRangeUp, pitchBendRangeDown);
      const depthSemitones = promptNumber("Pitch bend LFO depth in semitones", Math.min(1, maxDepthSemitones), 0, maxDepthSemitones);
      if (depthSemitones === null) return;
      const depthValue = Math.abs(semitonesToPitchBendValueWithRange(depthSemitones, pitchBendRangeUp, pitchBendRangeDown) - MIDI_PITCH_BEND_CENTER);
      const oldEvents = getLatestClipEvents();
      const generated = generateControllerLFOEvents({
        ...range,
        centerValue: MIDI_PITCH_BEND_CENTER,
        depth: depthValue,
        rateHz,
        shape,
        stepSeconds,
        valueMin: 0,
        valueMax: MIDI_PITCH_BEND_MAX,
      }).map((point) => ({
        type: "pitchBend" as const,
        timestamp: point.time,
        value: point.value,
      }));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...generated,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Generate MIDI pitch bend ${shape} LFO`);
      setShowTransformMenu(false);
      return;
    }
    if (selectedScalarMIDIEventType) {
      const label = selectedScalarMIDIEventLabel;
      const centerValue = promptNumber(`${label} LFO center`, 64, 0, 127);
      if (centerValue === null) return;
      const depth = promptNumber(`${label} LFO depth`, 32, 0, 127);
      if (depth === null) return;
      const oldEvents = getLatestClipEvents();
      const generated = generateControllerLFOEvents({
        ...range,
        centerValue,
        depth,
        rateHz,
        shape,
        stepSeconds,
      }).map((point) => makeSelectedScalarMIDIEvent(point.time, point.value));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...generated,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Generate MIDI ${label} ${shape} LFO`);
      setShowTransformMenu(false);
      return;
    }

    const maxCCValue = isCC14BitMode ? MIDI_PITCH_BEND_MAX : 127;
    const centerValue = promptNumber(`CC#${selectedCC} LFO center`, isCC14BitMode ? 8192 : 64, 0, maxCCValue);
    if (centerValue === null) return;
    const depth = promptNumber(`CC#${selectedCC} LFO depth`, isCC14BitMode ? 4096 : 32, 0, maxCCValue);
    if (depth === null) return;
    const oldCCEvents = getLatestCCEvents();
    const generatedPoints = generateControllerLFOEvents({
      ...range,
      centerValue,
      depth,
      rateHz,
      shape,
      stepSeconds,
      valueMax: maxCCValue,
    });
    const generated = isCC14BitMode
      ? generatedPoints.flatMap((point) => {
          const split = split14BitCCValue(point.value);
          return [
            { cc: selectedCC, time: point.time, value: split.msb },
            { cc: selectedCC + 32, time: point.time, value: split.lsb },
          ];
        })
      : generatedPoints.map((point) => ({
          cc: selectedCC,
          time: point.time,
          value: clamp7Bit(point.value),
        }));
    const nextCCEvents = [
      ...oldCCEvents.filter((event) => {
        const laneMatch = isCC14BitMode
          ? event.cc === selectedCC || event.cc === selectedCC + 32
          : event.cc === selectedCC;
        return !(laneMatch && event.time >= range.startTime && event.time <= range.endTime);
      }),
      ...generated,
    ].sort((a, b) => a.time - b.time || a.cc - b.cc);
    updateMIDICCEvents(trackId, clipId, nextCCEvents, {
      oldCCEvents,
      description: `Generate MIDI CC#${selectedCC} ${shape} LFO`,
    });
    setShowTransformMenu(false);
  }, [
    clipId,
    commitMIDIClipEvents,
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    pitchBendRangeDown,
    pitchBendRangeUp,
    promptNumber,
    isCC14BitMode,
    makeSelectedScalarMIDIEvent,
    selectedCC,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    snapDuration,
    trackId,
    updateMIDICCEvents,
  ]);

  const thinCurrentControllerLane = useCallback(() => {
    const range = getControllerTransformRange();

    if (selectedCC === PITCH_BEND_LANE) {
      const toleranceCents = promptNumber("Pitch bend thinning tolerance in cents", 5, 0, 1200);
      if (toleranceCents === null) return;
      const toleranceValue = Math.max(
        1,
        Math.abs(semitonesToPitchBendValueWithRange(toleranceCents / 100, pitchBendRangeUp, pitchBendRangeDown) - MIDI_PITCH_BEND_CENTER),
      );
      const oldEvents = getLatestClipEvents();
      const editablePoints = oldEvents
        .filter((event) => event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)
        .map((event) => ({
          time: event.timestamp,
          value: event.value ?? event.pitchBend ?? MIDI_PITCH_BEND_CENTER,
        }));
      if (editablePoints.length <= 2) {
        setShowTransformMenu(false);
        return;
      }

      const thinned = thinControllerEvents(editablePoints, toleranceValue).map((point) => ({
        type: "pitchBend" as const,
        timestamp: point.time,
        value: point.value,
      }));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...thinned,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Thin MIDI pitch bend data");
      setShowTransformMenu(false);
      return;
    }
    if (selectedScalarMIDIEventType) {
      const label = selectedScalarMIDIEventLabel;
      const tolerance = promptNumber(`${label} thinning tolerance`, 2, 0, 127);
      if (tolerance === null) return;
      const oldEvents = getLatestClipEvents();
      const editablePoints = oldEvents
        .filter((event) => selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)
        .map((event) => ({
          time: event.timestamp,
          value: event.value ?? 0,
        }));
      if (editablePoints.length <= 2) {
        setShowTransformMenu(false);
        return;
      }

      const thinned = thinControllerEvents(editablePoints, tolerance)
        .map((point) => makeSelectedScalarMIDIEvent(point.time, point.value));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...thinned,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Thin MIDI ${label} data`);
      setShowTransformMenu(false);
      return;
    }

    const maxCCValue = isCC14BitMode ? MIDI_PITCH_BEND_MAX : 127;
    const tolerance = promptNumber(`CC#${selectedCC} thinning tolerance`, isCC14BitMode ? 128 : 2, 0, maxCCValue);
    if (tolerance === null) return;
    const oldCCEvents = getLatestCCEvents();
    const editablePoints = isCC14BitMode
      ? oldCCEvents
          .filter((event) => event.cc === selectedCC && event.time >= range.startTime && event.time <= range.endTime)
          .map((event) => {
            const lsb = oldCCEvents.find((candidate) =>
              candidate.cc === selectedCC + 32 && Math.abs(candidate.time - event.time) < 0.000001,
            );
            return {
              time: event.time,
              value: combine14BitCCValue(event.value, lsb?.value ?? 0),
            };
          })
      : oldCCEvents
          .filter((event) => event.cc === selectedCC && event.time >= range.startTime && event.time <= range.endTime)
          .map((event) => ({
            time: event.time,
            value: event.value,
          }));
    if (editablePoints.length <= 2) {
      setShowTransformMenu(false);
      return;
    }

    const thinned = isCC14BitMode
      ? thinControllerEvents(editablePoints, tolerance).flatMap((point) => {
          const split = split14BitCCValue(point.value);
          return [
            { cc: selectedCC, time: point.time, value: split.msb },
            { cc: selectedCC + 32, time: point.time, value: split.lsb },
          ];
        })
      : thinControllerEvents(editablePoints, tolerance).map((point) => ({
          cc: selectedCC,
          time: point.time,
          value: clamp7Bit(point.value),
        }));
    const nextCCEvents = [
      ...oldCCEvents.filter((event) => {
        const laneMatch = isCC14BitMode
          ? event.cc === selectedCC || event.cc === selectedCC + 32
          : event.cc === selectedCC;
        return !(laneMatch && event.time >= range.startTime && event.time <= range.endTime);
      }),
      ...thinned,
    ].sort((a, b) => a.time - b.time || a.cc - b.cc);
    updateMIDICCEvents(trackId, clipId, nextCCEvents, {
      oldCCEvents,
      description: `Thin MIDI CC#${selectedCC} data`,
    });
    setShowTransformMenu(false);
  }, [
    clipId,
    commitMIDIClipEvents,
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    pitchBendRangeDown,
    pitchBendRangeUp,
    promptNumber,
    isCC14BitMode,
    makeSelectedScalarMIDIEvent,
    selectedCC,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    trackId,
    updateMIDICCEvents,
  ]);

  const transformCurrentControllerLane = useCallback(() => {
    const range = getControllerTransformRange();

    const transformPoints = (
      points: Array<{ time: number; value: number }>,
      maxValue: number,
      valueAnchor: number,
    ) => {
      if (points.length === 0) return null;
      const timeScalePercent = promptNumber("Time scale percent", 100, 1, 400);
      if (timeScalePercent === null) return null;
      const valueScalePercent = promptNumber("Value scale percent", 100, 0, 400);
      if (valueScalePercent === null) return null;
      const valueOffset = promptNumber("Value offset", 0, -maxValue, maxValue);
      if (valueOffset === null) return null;
      const tilt = promptNumber("Tilt amount", 0, -maxValue, maxValue);
      if (tilt === null) return null;
      return transformControllerEvents(points, {
        timeAnchor: range.startTime,
        timeScale: timeScalePercent / 100,
        valueAnchor,
        valueScale: valueScalePercent / 100,
        valueOffset,
        tilt,
        valueMin: 0,
        valueMax: maxValue,
      });
    };

    if (selectedCC === PITCH_BEND_LANE) {
      const oldEvents = getLatestClipEvents();
      const editablePoints = oldEvents
        .filter((event) => event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)
        .map((event) => ({
          time: event.timestamp,
          value: event.value ?? event.pitchBend ?? MIDI_PITCH_BEND_CENTER,
        }));
      const transformed = transformPoints(editablePoints, MIDI_PITCH_BEND_MAX, MIDI_PITCH_BEND_CENTER);
      if (transformed === null) {
        setShowTransformMenu(false);
        return;
      }

      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...transformed.map((point) => ({
          type: "pitchBend" as const,
          timestamp: point.time,
          value: point.value,
        })),
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Transform MIDI pitch bend lane");
      setShowTransformMenu(false);
      return;
    }

    if (selectedScalarMIDIEventType) {
      const label = selectedScalarMIDIEventLabel;
      const oldEvents = getLatestClipEvents();
      const editablePoints = oldEvents
        .filter((event) => selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)
        .map((event) => ({
          time: event.timestamp,
          value: event.value ?? 0,
        }));
      const transformed = transformPoints(editablePoints, 127, 64);
      if (transformed === null) {
        setShowTransformMenu(false);
        return;
      }

      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)),
        ...transformed.map((point) => makeSelectedScalarMIDIEvent(point.time, point.value)),
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Transform MIDI ${label} lane`);
      setShowTransformMenu(false);
      return;
    }

    const maxCCValue = isCC14BitMode ? MIDI_PITCH_BEND_MAX : 127;
    const oldCCEvents = getLatestCCEvents();
    const editablePoints = isCC14BitMode
      ? oldCCEvents
          .filter((event) => event.cc === selectedCC && event.time >= range.startTime && event.time <= range.endTime)
          .map((event) => {
            const lsb = oldCCEvents.find((candidate) =>
              candidate.cc === selectedCC + 32 && Math.abs(candidate.time - event.time) < 0.000001,
            );
            return {
              time: event.time,
              value: combine14BitCCValue(event.value, lsb?.value ?? 0),
            };
          })
      : oldCCEvents
          .filter((event) => event.cc === selectedCC && event.time >= range.startTime && event.time <= range.endTime)
          .map((event) => ({
            time: event.time,
            value: event.value,
          }));
    const transformed = transformPoints(editablePoints, maxCCValue, isCC14BitMode ? MIDI_PITCH_BEND_CENTER : 64);
    if (transformed === null) {
      setShowTransformMenu(false);
      return;
    }

    const transformedEvents = isCC14BitMode
      ? transformed.flatMap((point) => {
          const split = split14BitCCValue(point.value);
          return [
            { cc: selectedCC, time: point.time, value: split.msb },
            { cc: selectedCC + 32, time: point.time, value: split.lsb },
          ];
        })
      : transformed.map((point) => ({
          cc: selectedCC,
          time: point.time,
          value: clamp7Bit(point.value),
        }));
    const nextCCEvents = [
      ...oldCCEvents.filter((event) => {
        const laneMatch = isCC14BitMode
          ? event.cc === selectedCC || event.cc === selectedCC + 32
          : event.cc === selectedCC;
        return !(laneMatch && event.time >= range.startTime && event.time <= range.endTime);
      }),
      ...transformedEvents,
    ].sort((a, b) => a.time - b.time || a.cc - b.cc);
    updateMIDICCEvents(trackId, clipId, nextCCEvents, {
      oldCCEvents,
      description: `Transform MIDI ${isCC14BitMode ? `14-bit CC#${selectedCC}/${selectedCC + 32}` : `CC#${selectedCC}`} lane`,
    });
    setShowTransformMenu(false);
  }, [
    clipId,
    commitMIDIClipEvents,
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    isCC14BitMode,
    makeSelectedScalarMIDIEvent,
    promptNumber,
    selectedCC,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    trackId,
    updateMIDICCEvents,
  ]);

  const openControllerLineDialog = useCallback(() => {
    const endValue = selectedNoteMetadataLaneType
      ? noteMetadataLaneMax(selectedNoteMetadataLaneType)
      : selectedCC === PITCH_BEND_LANE
        ? 0
        : (isCC14BitMode ? MIDI_PITCH_BEND_MAX : 127);
    setShowTransformMenu(false);
    setControllerDialog({
      type: "line",
      interpolation: "linear",
      curve: 0.5,
      startValue: selectedCC === PITCH_BEND_LANE ? 0 : 0,
      endValue,
    });
  }, [isCC14BitMode, selectedCC, selectedNoteMetadataLaneType]);

  const openControllerLFODialog = useCallback((shape: ControllerLFOShape) => {
    if (selectedNoteMetadataLaneType) return;
    const maxDepthSemitones = Math.min(pitchBendRangeUp, pitchBendRangeDown);
    setShowTransformMenu(false);
    setControllerDialog({
      type: "lfo",
      shape,
      rateHz: 2,
      centerValue: selectedCC === PITCH_BEND_LANE ? 0 : (isCC14BitMode ? MIDI_PITCH_BEND_CENTER : 64),
      depth: selectedCC === PITCH_BEND_LANE ? Math.min(1, maxDepthSemitones) : (isCC14BitMode ? 4096 : 32),
    });
  }, [isCC14BitMode, pitchBendRangeDown, pitchBendRangeUp, selectedCC, selectedNoteMetadataLaneType]);

  const openControllerThinDialog = useCallback(() => {
    if (selectedNoteMetadataLaneType) return;
    setShowTransformMenu(false);
    setControllerDialog({
      type: "thin",
      tolerance: selectedCC === PITCH_BEND_LANE ? 5 : (isCC14BitMode ? 128 : 2),
    });
  }, [isCC14BitMode, selectedCC, selectedNoteMetadataLaneType]);

  const openControllerTransformDialog = useCallback(() => {
    if (selectedNoteMetadataLaneType) return;
    setShowTransformMenu(false);
    setControllerDialog({
      type: "transform",
      timeScalePercent: 100,
      valueScalePercent: 100,
      valueOffset: 0,
      tilt: 0,
    });
  }, [selectedNoteMetadataLaneType]);

  const submitControllerDialog = useCallback(() => {
    if (!controllerDialog) return;

    if (controllerDialog.type === "line") {
      controllerLineModeOverrideRef.current = controllerDialog.interpolation;
      controllerPromptQueueRef.current = controllerDialog.interpolation === "curve"
        ? [controllerDialog.curve, controllerDialog.startValue, controllerDialog.endValue]
        : [controllerDialog.startValue, controllerDialog.endValue];
      applyControllerLine();
    } else if (controllerDialog.type === "lfo") {
      controllerPromptQueueRef.current = [
        controllerDialog.rateHz,
        ...(selectedCC === PITCH_BEND_LANE
          ? [controllerDialog.depth]
          : [controllerDialog.centerValue, controllerDialog.depth]),
      ];
      applyControllerLFO(controllerDialog.shape);
    } else if (controllerDialog.type === "thin") {
      controllerPromptQueueRef.current = [controllerDialog.tolerance];
      thinCurrentControllerLane();
    } else {
      controllerPromptQueueRef.current = [
        controllerDialog.timeScalePercent,
        controllerDialog.valueScalePercent,
        controllerDialog.valueOffset,
        controllerDialog.tilt,
      ];
      transformCurrentControllerLane();
    }

    controllerPromptQueueRef.current = [];
    controllerLineModeOverrideRef.current = null;
    setControllerDialog(null);
  }, [
    applyControllerLFO,
    applyControllerLine,
    controllerDialog,
    selectedCC,
    thinCurrentControllerLane,
    transformCurrentControllerLane,
  ]);

  const copyCurrentControllerLane = useCallback(() => {
    const range = getControllerTransformRange();

    if (selectedCC === PITCH_BEND_LANE) {
      const points = getLatestClipEvents()
        .filter((event) => event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime)
        .map((event) => ({
          time: event.timestamp - range.startTime,
          valueFraction: clamp((event.value ?? event.pitchBend ?? MIDI_PITCH_BEND_CENTER) / MIDI_PITCH_BEND_MAX, 0, 1),
        }));
      if (points.length > 0) {
        setControllerLaneClipboard({
          sourceLabel: "Pitch Bend",
          duration: Math.max(snapDuration, range.endTime - range.startTime),
          points,
        });
      }
      setShowTransformMenu(false);
      return;
    }

    if (selectedScalarMIDIEventType) {
      const label = selectedScalarMIDIEventLabel;
      const points = getLatestClipEvents()
        .filter((event) => selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime)
        .map((event) => ({
          time: event.timestamp - range.startTime,
          valueFraction: clamp((event.value ?? 0) / 127, 0, 1),
        }));
      if (points.length > 0) {
        setControllerLaneClipboard({
          sourceLabel: label,
          duration: Math.max(snapDuration, range.endTime - range.startTime),
          points,
        });
      }
      setShowTransformMenu(false);
      return;
    }

    if (selectedNoteMetadataLaneType) {
      const maxValue = noteMetadataLaneMax(selectedNoteMetadataLaneType);
      const points = parseNotePairs(getLatestClipEvents())
        .filter((pair) => pair.startTime < range.endTime && pair.startTime + pair.duration > range.startTime)
        .map((pair) => ({
          time: Math.max(0, pair.startTime - range.startTime),
          valueFraction: clamp(noteMetadataValueForPair(pair, selectedNoteMetadataLaneType) / maxValue, 0, 1),
        }));
      if (points.length > 0) {
        setControllerLaneClipboard({
          sourceLabel: selectedNoteMetadataLaneLabel,
          duration: Math.max(snapDuration, range.endTime - range.startTime),
          points,
        });
      }
      setShowTransformMenu(false);
      return;
    }

    const oldCCEvents = getLatestCCEvents();
    if (isCC14BitMode) {
      const points = oldCCEvents
        .filter((event) => event.cc === selectedCC && event.time >= range.startTime && event.time <= range.endTime)
        .map((event) => {
          const lsb = oldCCEvents.find((candidate) =>
            candidate.cc === selectedCC + 32 && Math.abs(candidate.time - event.time) < 0.000001,
          );
          return {
            time: event.time - range.startTime,
            valueFraction: combine14BitCCValue(event.value, lsb?.value ?? 0) / MIDI_PITCH_BEND_MAX,
          };
        });
      if (points.length > 0) {
        setControllerLaneClipboard({
          sourceLabel: `14-bit CC#${selectedCC}/${selectedCC + 32}`,
          duration: Math.max(snapDuration, range.endTime - range.startTime),
          points,
        });
      }
      setShowTransformMenu(false);
      return;
    }

    const points = oldCCEvents
      .filter((event) => event.cc === selectedCC && event.time >= range.startTime && event.time <= range.endTime)
      .map((event) => ({
        time: event.time - range.startTime,
        valueFraction: clamp(event.value / 127, 0, 1),
      }));
    if (points.length > 0) {
      setControllerLaneClipboard({
        sourceLabel: `CC#${selectedCC}`,
        duration: Math.max(snapDuration, range.endTime - range.startTime),
        points,
      });
    }
    setShowTransformMenu(false);
  }, [
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    isCC14BitMode,
    selectedNoteMetadataLaneLabel,
    selectedNoteMetadataLaneType,
    selectedCC,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    snapDuration,
  ]);

  const pasteControllerLaneClipboard = useCallback(() => {
    if (!controllerLaneClipboard) return;
    const range = getControllerTransformRange();
    const pasteStart = range.startTime;
    const pasteEnd = pasteStart + controllerLaneClipboard.duration;

    if (selectedCC === PITCH_BEND_LANE) {
      const oldEvents = getLatestClipEvents();
      const pasted = controllerLaneClipboard.points.map((point) => ({
        type: "pitchBend" as const,
        timestamp: pasteStart + point.time,
        value: clamp(Math.round(point.valueFraction * MIDI_PITCH_BEND_MAX), 0, MIDI_PITCH_BEND_MAX),
      }));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(event.type === "pitchBend" && event.timestamp >= pasteStart && event.timestamp <= pasteEnd)),
        ...pasted,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Paste controller lane to pitch bend`);
      setShowTransformMenu(false);
      return;
    }

    if (selectedScalarMIDIEventType) {
      const oldEvents = getLatestClipEvents();
      const label = selectedScalarMIDIEventLabel;
      const pasted = controllerLaneClipboard.points
        .map((point) => makeSelectedScalarMIDIEvent(pasteStart + point.time, point.valueFraction * 127));
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => !(selectedScalarMIDIEventMatches(event) && event.timestamp >= pasteStart && event.timestamp <= pasteEnd)),
        ...pasted,
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Paste controller lane to MIDI ${label}`);
      setShowTransformMenu(false);
      return;
    }

    if (selectedNoteMetadataLaneType) {
      const oldEvents = getLatestClipEvents();
      const maxValue = noteMetadataLaneMax(selectedNoteMetadataLaneType);
      const pairs = parseNotePairs(oldEvents);
      const nextEvents = controllerLaneClipboard.points.reduce((events, point) => {
        const targetTime = pasteStart + point.time;
        const pair = pairs.find((candidate) =>
          targetTime >= candidate.startTime - 0.000001
          && targetTime <= candidate.startTime + candidate.duration + 0.000001,
        );
        if (!pair) return events;
        return applyNoteMetadataValueToEvents(events, pair, selectedNoteMetadataLaneType, point.valueFraction * maxValue);
      }, oldEvents);
      commitMIDIClipEvents(trackId, clipId, oldEvents, sortEvents(nextEvents), `Paste controller lane to MIDI ${selectedNoteMetadataLaneLabel}`);
      setShowTransformMenu(false);
      return;
    }

    const oldCCEvents = getLatestCCEvents();
    const pasted = isCC14BitMode
      ? controllerLaneClipboard.points.flatMap((point) => {
          const split = split14BitCCValue(point.valueFraction * MIDI_PITCH_BEND_MAX);
          const time = pasteStart + point.time;
          return [
            { cc: selectedCC, time, value: split.msb },
            { cc: selectedCC + 32, time, value: split.lsb },
          ];
        })
      : controllerLaneClipboard.points.map((point) => ({
          cc: selectedCC,
          time: pasteStart + point.time,
          value: clamp7Bit(point.valueFraction * 127),
        }));
    const nextCCEvents = [
      ...oldCCEvents.filter((event) => {
        const laneMatch = isCC14BitMode
          ? event.cc === selectedCC || event.cc === selectedCC + 32
          : event.cc === selectedCC;
        return !(laneMatch && event.time >= pasteStart && event.time <= pasteEnd);
      }),
      ...pasted,
    ].sort((a, b) => a.time - b.time || a.cc - b.cc);
    updateMIDICCEvents(trackId, clipId, nextCCEvents, {
      oldCCEvents,
      description: `Paste controller lane to ${isCC14BitMode ? `14-bit CC#${selectedCC}/${selectedCC + 32}` : `CC#${selectedCC}`}`,
    });
    setShowTransformMenu(false);
  }, [
    clipId,
    commitMIDIClipEvents,
    controllerLaneClipboard,
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    isCC14BitMode,
    makeSelectedScalarMIDIEvent,
    selectedCC,
    selectedNoteMetadataLaneLabel,
    selectedNoteMetadataLaneType,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    trackId,
    updateMIDICCEvents,
  ]);

  const clearCurrentControllerLane = useCallback(() => {
    const range = getControllerTransformRange();
    if (selectedCC === PITCH_BEND_LANE) {
      const oldEvents = getLatestClipEvents();
      const nextEvents = sortEvents(oldEvents.filter(
        (event) => !(event.type === "pitchBend" && event.timestamp >= range.startTime && event.timestamp <= range.endTime),
      ));
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Clear MIDI pitch bend lane");
      setShowTransformMenu(false);
      return;
    }
    if (selectedScalarMIDIEventType) {
      const oldEvents = getLatestClipEvents();
      const nextEvents = sortEvents(oldEvents.filter(
        (event) => !(selectedScalarMIDIEventMatches(event) && event.timestamp >= range.startTime && event.timestamp <= range.endTime),
      ));
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, `Clear MIDI ${selectedScalarMIDIEventLabel} lane`);
      setShowTransformMenu(false);
      return;
    }
    if (selectedNoteMetadataLaneType) {
      const oldEvents = getLatestClipEvents();
      const defaultValue = selectedNoteMetadataLaneType === "chance" ? 100 : 0;
      const nextEvents = parseNotePairs(oldEvents)
        .filter((pair) => pair.startTime < range.endTime && pair.startTime + pair.duration > range.startTime)
        .reduce(
          (events, pair) => applyNoteMetadataValueToEvents(events, pair, selectedNoteMetadataLaneType, defaultValue),
          oldEvents,
        );
      commitMIDIClipEvents(trackId, clipId, oldEvents, sortEvents(nextEvents), `Clear MIDI ${selectedNoteMetadataLaneLabel} lane`);
      setShowTransformMenu(false);
      return;
    }

    const oldCCEvents = getLatestCCEvents();
    const nextCCEvents = oldCCEvents.filter((event) => {
      const laneMatch = isCC14BitMode
        ? event.cc === selectedCC || event.cc === selectedCC + 32
        : event.cc === selectedCC;
      return !(laneMatch && event.time >= range.startTime && event.time <= range.endTime);
    });
    updateMIDICCEvents(trackId, clipId, nextCCEvents, {
      oldCCEvents,
      description: `Clear MIDI ${isCC14BitMode ? `14-bit CC#${selectedCC}/${selectedCC + 32}` : `CC#${selectedCC}`} lane`,
    });
    setShowTransformMenu(false);
  }, [
    clipId,
    commitMIDIClipEvents,
    getControllerTransformRange,
    getLatestCCEvents,
    getLatestClipEvents,
    isCC14BitMode,
    selectedCC,
    selectedNoteMetadataLaneLabel,
    selectedNoteMetadataLaneType,
    selectedScalarMIDIEventLabel,
    selectedScalarMIDIEventMatches,
    selectedScalarMIDIEventType,
    trackId,
    updateMIDICCEvents,
  ]);

  const handleVelocityMouseDown = useCallback((event: KonvaEvent) => {
    if (!midiTargetEditable) return;
    const pos = getPointer(event);
    if (!pos || pos.y < velocityLaneY || pos.y >= velocityLaneY + velocityLaneHeight) return;

    const pair = notePairs.find((candidate) => {
      const barX = PIANO_WIDTH + candidate.startTime * pixelsPerSecond - scrollX;
      const barWidth = Math.max(4, candidate.duration * pixelsPerSecond);
      return pos.x >= barX && pos.x <= barX + barWidth;
    });
    if (!pair) return;

    const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
    const velocity = getVelocityFromLaneY(pos.y);
    setSelectedNoteIds([id]);
    setVelocityEdit({
      noteId: id,
      timestamp: pair.startTime,
      noteNumber: pair.noteNumber,
      originalEvents: getLatestClipEvents(),
      originalIsModified: useDAWStore.getState().isModified,
    });
    updateMIDINoteVelocity(trackId, clipId, pair.startTime, pair.noteNumber, velocity, { transient: true });
    auditionNote(pair.noteNumber, velocity, { throttle: true });
  }, [
    auditionNote,
    clipId,
    getLatestClipEvents,
    getVelocityFromLaneY,
    notePairs,
    pixelsPerSecond,
    scrollX,
    trackId,
    updateMIDINoteVelocity,
    velocityLaneHeight,
    velocityLaneY,
    midiTargetEditable,
  ]);

  const handleCCMouseDown = useCallback((event: KonvaEvent) => {
    if (!midiTargetEditable) return;
    const pos = getPointer(event);
    if (!pos || pos.y < ccLaneY || pos.y >= ccLaneY + ccLaneHeight) return;
    const originalEvents = getLatestClipEvents();
    const originalCCEvents = getLatestCCEvents();

    if (selectedNoteMetadataLaneType) {
      const newEvents = upsertNoteMetadataLaneValue(pos.x, pos.y, originalEvents);
      const nextDrawState: CCDrawState = { lane: "noteMetadata", originalCCEvents, originalEvents, originalIsModified: useDAWStore.getState().isModified };
      ccDrawStateRef.current = nextDrawState;
      setCCDrawState(nextDrawState);
      previewMIDIClipEvents(trackId, clipId, newEvents);
      return;
    }
    if (selectedCC === PITCH_BEND_LANE) {
      const newEvents = upsertPitchBendEvent(pos.x, pos.y, originalEvents);
      const nextDrawState: CCDrawState = { lane: "pitchBend", originalCCEvents, originalEvents, originalIsModified: useDAWStore.getState().isModified };
      ccDrawStateRef.current = nextDrawState;
      setCCDrawState(nextDrawState);
      previewMIDIClipEvents(trackId, clipId, newEvents);
      return;
    }
    if (selectedScalarMIDIEventType) {
      const newEvents = upsertScalarMIDIEvent(pos.x, pos.y, originalEvents);
      const nextDrawState: CCDrawState = { lane: "midiEvent", originalCCEvents, originalEvents, originalIsModified: useDAWStore.getState().isModified };
      ccDrawStateRef.current = nextDrawState;
      setCCDrawState(nextDrawState);
      previewMIDIClipEvents(trackId, clipId, newEvents);
      return;
    }

    const newEvents = upsertCCEvent(pos.x, pos.y, originalCCEvents);
    const nextDrawState: CCDrawState = { lane: "cc", originalCCEvents, originalEvents, originalIsModified: useDAWStore.getState().isModified };
    ccDrawStateRef.current = nextDrawState;
    setCCDrawState(nextDrawState);
    updateMIDICCEvents(trackId, clipId, newEvents, { transient: true });
  }, [
    ccLaneHeight,
    ccLaneY,
    clipId,
    getLatestCCEvents,
    getLatestClipEvents,
    previewMIDIClipEvents,
    selectedCC,
    selectedNoteMetadataLaneType,
    selectedScalarMIDIEventType,
    trackId,
    updateMIDICCEvents,
    upsertCCEvent,
    upsertNoteMetadataLaneValue,
    upsertPitchBendEvent,
    upsertScalarMIDIEvent,
    midiTargetEditable,
  ]);

  const updateDragPreview = useCallback((event: KonvaEvent) => {
    if (!dragState || !midiTargetEditable) return;
    const pos = getPointer(event);
    if (!pos) return;

    const nativeEvent = event.evt as MouseEvent;
    const bypassSnap = Boolean(nativeEvent?.ctrlKey || nativeEvent?.metaKey);
    const pointerTime = snapTime(getTimeFromX(pos.x), {
      bypassSnap,
      originalTime: dragState.startPointerTime,
    });
    const pointerNote = getNoteFromY(pos.y);
    const deltaTime = pointerTime - dragState.startPointerTime;
    const deltaNote = pointerNote - dragState.startPointerNote;

    const { events: nextEvents, nextIds, auditionPair } = rebuildMIDIEventsForNotes(
      dragState.originalEvents,
      clipId,
      dragState.noteIds,
      (pair) => {
        if (dragState.mode === "move") {
          return {
            ...pair,
            startTime: Math.max(0, pair.startTime + deltaTime),
            noteNumber: clamp(pair.noteNumber + deltaNote, 0, 127),
          };
        }

        if (dragState.mode === "resize-start") {
          const oldEnd = pair.startTime + pair.duration;
          const nextStart = clamp(pointerTime, 0, oldEnd - snapDuration);
          return {
            ...pair,
            startTime: nextStart,
            duration: oldEnd - nextStart,
          };
        }

        const nextEnd = Math.max(pair.startTime + snapDuration, pointerTime);
        return {
          ...pair,
          duration: nextEnd - pair.startTime,
        };
      },
    );

    previewMIDIClipEvents(trackId, clipId, nextEvents);
    if (nextIds.length > 0) setSelectedNoteIds(nextIds);
    if (auditionPair) {
      latestDragAuditionRef.current = {
        noteNumber: auditionPair.noteNumber,
        velocity: auditionPair.velocity,
      };
      auditionNote(auditionPair.noteNumber, auditionPair.velocity, { throttle: true, durationMs: 120 });
    }
  }, [
    auditionNote,
    clipDuration,
    clipId,
    dragState,
    getNoteFromY,
    getTimeFromX,
    previewMIDIClipEvents,
    snapDuration,
    snapTime,
    trackId,
    midiTargetEditable,
  ]);

  const handleNoteMouseDown = useCallback((event: KonvaEvent, pair: NotePair) => {
    event.cancelBubble = true;
    const nativeEvent = event.evt as MouseEvent;
    const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
    const pos = getPointer(event);
    const noteX = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
    const noteWidth = Math.max(4, pair.duration * pixelsPerSecond);
    const relX = pos ? pos.x - noteX : noteWidth / 2;
    const edge = relX <= NOTE_EDGE_HIT_WIDTH
      ? "start"
      : noteWidth - relX <= NOTE_EDGE_HIT_WIDTH
        ? "end"
        : "body";
    const gestureKind = gestureKindForHit(tool, { kind: "note", noteId: id, edge });
    if (gestureKind && pos) {
      gestureSessionRef.current = {
        kind: gestureKind,
        tool,
        target: { kind: "note", noteId: id, edge },
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
      };
    }

    if (!midiTargetEditable && ["erase", "mute", "glue", "split"].includes(tool)) return;

    if (tool === "erase") {
      removeMIDINotes(trackId, clipId, [id]);
      setSelectedNoteIds(selectedNoteIds.filter((noteId) => noteId !== id));
      stopAudition();
      return;
    }

    if (tool === "mute") {
      setSelectedNoteIds([id]);
      toggleSelectedMIDINoteMute(trackId, clipId);
      stopAudition();
      return;
    }

    if (tool === "glue") {
      const nextSelection = selectedNoteIds.includes(id) ? selectedNoteIds : [id];
      setSelectedNoteIds(nextSelection);
      const nextIds = glueSelectedMIDINotes(trackId, clipId, nextSelection);
      if (nextIds.length > 0) {
        setSelectedNoteIds(nextIds);
        return;
      }
      legatoSelectedMIDINotes(trackId, clipId);
      return;
    }

    if (tool === "split") {
      if (!pos) return;
      const splitTime = snapTime(getTimeFromX(pos.x), {
        bypassSnap: Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey),
        originalTime: pair.startTime,
      });
      const noteEnd = pair.startTime + pair.duration;
      if (splitTime <= pair.startTime + 0.01 || splitTime >= noteEnd - 0.01) return;
      const oldEvents = getLatestClipEvents();
      const pairChannel = pair.channel ?? 1;
      const nextEvents = sortEvents([
        ...oldEvents.filter((event) => {
          if (event.note !== pair.noteNumber || (event.channel ?? 1) !== pairChannel) return true;
          if (event.type === "noteOn" && Math.abs(event.timestamp - pair.startTime) < 0.000001) return false;
          if (event.type === "noteOff" && Math.abs(event.timestamp - noteEnd) < 0.000001) return false;
          return true;
        }),
        { ...pair.noteOn, timestamp: pair.startTime },
        { ...pair.noteOff, timestamp: splitTime, velocity: pair.releaseVelocity ?? pair.noteOff.velocity ?? 0 },
        { ...pair.noteOn, timestamp: splitTime },
        { ...pair.noteOff, timestamp: noteEnd, velocity: pair.releaseVelocity ?? pair.noteOff.velocity ?? 0 },
      ]);
      commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Split MIDI note");
      setSelectedNoteIds([
        noteIdFor(clipId, pair.startTime, pair.noteNumber),
        noteIdFor(clipId, splitTime, pair.noteNumber),
      ]);
      auditionNote(pair.noteNumber, pair.velocity);
      return;
    }

    if (tool === "range") {
      if (!pos) return;
      setSelectedNoteIds([]);
      setRangeDragState({
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
      });
      return;
    }

    const modifier = nativeEvent.shiftKey;
    if (
      tool === "select"
      && nativeEvent.altKey
      && midiTargetEditable
      && selectedNoteIds.includes(id)
      && selectedNoteIds.length > 0
    ) {
      if (!pos) return;
      const nextIds = duplicateSelectedMIDINotes(trackId, clipId);
      if (nextIds.length === 0) return;
      setSelectedNoteIds(nextIds);
      setDragState({
        mode: "move",
        noteIds: nextIds,
        originalEvents: getLatestClipEvents(),
        startPointerTime: snapTime(getTimeFromX(pos.x), {
          bypassSnap: Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey),
          originalTime: pair.startTime,
        }),
        startPointerNote: pair.noteNumber,
        activeNoteId: nextIds[0],
        originalIsModified: useDAWStore.getState().isModified,
      });
      latestDragAuditionRef.current = {
        noteNumber: pair.noteNumber,
        velocity: pair.velocity,
      };
      return;
    }

    let nextSelection = selectedNoteIds;
    if (modifier) {
      nextSelection = selectedNoteIds.includes(id)
        ? selectedNoteIds.filter((noteId) => noteId !== id)
        : [...selectedNoteIds, id];
    } else if (!selectedNoteIds.includes(id)) {
      nextSelection = [id];
    }

    setSelectedNoteIds(nextSelection);
    auditionNote(pair.noteNumber, pair.velocity);

    if ((tool !== "select" && tool !== "trim") || !nextSelection.includes(id)) return;
    if (!midiTargetEditable) return;

    if (!pos) return;
    const mode: DragMode =
      relX <= NOTE_EDGE_HIT_WIDTH
        ? "resize-start"
        : noteWidth - relX <= NOTE_EDGE_HIT_WIDTH
          ? "resize-end"
          : "move";

    setDragState({
      mode,
      noteIds: mode === "move" ? nextSelection : [id],
      originalEvents: getLatestClipEvents(),
      startPointerTime: snapTime(getTimeFromX(pos.x), {
        bypassSnap: Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey),
        originalTime: pair.startTime,
      }),
      startPointerNote: pair.noteNumber,
      activeNoteId: id,
      originalIsModified: useDAWStore.getState().isModified,
    });
    latestDragAuditionRef.current = {
      noteNumber: pair.noteNumber,
      velocity: pair.velocity,
    };
  }, [
    auditionNote,
    clipId,
    duplicateSelectedMIDINotes,
    commitMIDIClipEvents,
    getLatestClipEvents,
    getTimeFromX,
    legatoSelectedMIDINotes,
    pixelsPerSecond,
    removeMIDINotes,
    scrollX,
    selectedNoteIds,
    setSelectedNoteIds,
    setRangeDragState,
    snapTime,
    stopAudition,
    tool,
    toggleSelectedMIDINoteMute,
    trackId,
    midiTargetEditable,
  ]);

  const handleNoteContextMenu = useCallback((event: KonvaEvent, pair: NotePair) => {
    event.evt.preventDefault();
    event.cancelBubble = true;
    if (shouldSuppressWorkspaceContextMenu(event.evt.target)) return;
    const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
    if (!selectedNoteIds.includes(id)) {
      setSelectedNoteIds([id]);
    }
    setPianoRollEditCursorTime(pair.startTime);
    setContextMenu({
      x: event.evt.clientX,
      y: event.evt.clientY,
      kind: "note",
      noteId: id,
      noteNumber: pair.noteNumber,
      time: pair.startTime,
    });
  }, [
    clipId,
    selectedNoteIds,
    setPianoRollEditCursorTime,
    setSelectedNoteIds,
  ]);

  const handleStageMouseDown = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos) return;
    const hitTarget = hitTestPianoRoll(pos.x, pos.y, {
      pianoWidth: PIANO_WIDTH,
      noteGridHeight,
      velocityLaneY,
      velocityLaneHeight: isVelocityLaneActive ? velocityLaneHeight : 0,
      controllerLaneY: ccLaneY,
      controllerLaneHeight: activeControllerLane ? ccLaneHeight : 0,
      noteEdgeHitWidth: NOTE_EDGE_HIT_WIDTH,
      timeFromX: getTimeFromX,
      noteFromY: getNoteFromY,
      notes: pianoRollHitNotes,
      lanes: pianoRollHitLanes,
      controllerEvents: pianoRollControllerHitEvents,
      loopStartX: loopBoundaryStartX,
      loopEndX: loopBoundaryEndX,
      loopBoundaryHitWidth: 6,
    });

    if (hitTarget.kind === "lane-header") {
      const lane = visibleLanes.find((candidate) => candidate.id === hitTarget.laneId)
        ?? (hitTarget.laneId === "velocity" ? visibleLanes.find((candidate) => candidate.kind === "velocity") : undefined);
      if (lane) selectControllerLane(lane);
      return;
    }

    if (hitTarget.kind === "lane-resize") {
      const lane = visibleLanes.find((candidate) => candidate.id === hitTarget.laneId)
        ?? (hitTarget.laneId === "velocity" ? visibleLanes.find((candidate) => candidate.kind === "velocity") : undefined);
      if (!lane) return;
      setLaneResizeState({
        laneId: lane.id,
        laneKind: lane.kind,
        startY: pos.y,
        originalHeight: lane.kind === "velocity" ? velocityLaneHeight : ccLaneHeight,
      });
      return;
    }

    if (hitTarget.kind === "loop-boundary" && clip?.loopEnabled) {
      const currentLoopOffset = clip.loopOffset ?? clip.offset ?? 0;
      const currentLoopLength = clip.loopLength ?? clip.sourceLength ?? clipDuration;
      setLoopBoundaryDrag({
        edge: hitTarget.edge,
        startX: pos.x,
        currentX: pos.x,
        currentSourceTime: hitTarget.edge === "start" ? currentLoopOffset : currentLoopOffset + currentLoopLength,
        initialLoopOffset: currentLoopOffset,
        initialLoopLength: currentLoopLength,
      });
      return;
    }

    if (
      (hitTarget.kind === "controller-lane" || hitTarget.kind === "controller-node" || hitTarget.kind === "controller-segment")
      && hitTarget.laneId
    ) {
      const lane = visibleLanes.find((candidate) => candidate.id === hitTarget.laneId);
      if (lane && lane.id !== activeLane?.id) selectControllerLane(lane);
    }

    const gestureKind = gestureKindForHit(tool, hitTarget);
    if (gestureKind) {
      gestureSessionRef.current = {
        kind: gestureKind,
        tool,
        target: hitTarget,
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
      };
    }

    if (tool === "zoom") {
      const nativeEvent = event.evt as MouseEvent;
      const direction = nativeEvent.altKey ? -1 : 1;
      const cursorGridX = clamp(pos.x - PIANO_WIDTH, 0, visibleGridWidth);
      const projectTimeAtCursor = (cursorGridX + timelineScrollX) / pixelsPerSecond;
      const nextPixelsPerSecond = clamp(pixelsPerSecond * (direction > 0 ? 1.18 : 0.85), 1, 1000);
      const nextEditorContentEnd = clipStartTime + contentDuration + getEditorPaddingSeconds(nextPixelsPerSecond);
      const nextContentWidth = Math.max(visibleGridWidth, nextEditorContentEnd * nextPixelsPerSecond);
      const nextMaxScrollX = Math.max(0, nextContentWidth - visibleGridWidth);
      setTimelineZoom(nextPixelsPerSecond);
      setTimelineScroll(clamp(projectTimeAtCursor * nextPixelsPerSecond - cursorGridX, 0, nextMaxScrollX), timelineScrollY);
      return;
    }

    if (tool === "pan") {
      const nextPanDrag = {
        startX: pos.x,
        startY: pos.y,
        originalScrollX: timelineScrollX,
        originalScrollY: scrollY,
      };
      panDragRef.current = nextPanDrag;
      setPanDragState(nextPanDrag);
      return;
    }

    const isControllerTarget = hitTarget.kind === "controller-lane"
      || hitTarget.kind === "controller-node"
      || hitTarget.kind === "controller-segment";

    if (tool === "line" && isControllerTarget) {
      openControllerLineDialog();
      return;
    }

    if (isControllerTarget) {
      handleCCMouseDown(event);
      return;
    }
    if (hitTarget.kind === "velocity-lane") {
      handleVelocityMouseDown(event);
      return;
    }
    const isNoteGridCaptureTarget = hitTarget.kind === "grid"
      || hitTarget.kind === "note"
      || hitTarget.kind === "loop-boundary";
    if (!isNoteGridCaptureTarget) return;

    const nativeEvent = event.evt as MouseEvent;
    const ctrlSnapBypass = Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey);
    const rawTime = hitTarget.kind === "grid" ? hitTarget.time : getTimeFromX(pos.x);
    const time = snapTime(rawTime, { bypassSnap: ctrlSnapBypass, originalTime: rawTime });
    const note = hitTarget.kind === "grid" ? hitTarget.noteNumber : getNoteFromY(pos.y);
    setPianoRollEditCursorTime(time);

    const selectionModifier = nativeEvent.shiftKey;

    if (tool === "range") {
      setSelectedNoteIds([]);
      setRangeDragState({
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
      });
      return;
    }

    if (tool === "draw" && !selectionModifier) {
      setSelectedNoteIds([]);
      clearMIDIEditRange();
      setDrawingState({
        startTime: time,
        endTime: time + snapDuration,
        noteNumber: note,
        velocity: pianoRollInsertVelocity,
      });
      return;
    }

    if (tool === "select" || selectionModifier) {
      const mode = nativeEvent.shiftKey ? "toggle" : "replace";
      clearMIDIEditRange();
      if (mode === "replace") setSelectedNoteIds([]);
      setMarqueeState({
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
        mode,
      });
    }
  }, [
    ccLaneHeight,
    ccLaneY,
    clearMIDIEditRange,
    clip,
    clipDuration,
    contentDuration,
    clipStartTime,
    activeLane,
    activeControllerLane,
    getEditorPaddingSeconds,
    getNoteFromY,
    getTimeFromX,
    handleCCMouseDown,
    handleVelocityMouseDown,
    isVelocityLaneActive,
    loopBoundaryEndX,
    loopBoundaryStartX,
    openControllerLineDialog,
    noteGridHeight,
    pianoRollControllerHitEvents,
    pianoRollHitLanes,
    pianoRollHitNotes,
    pianoRollInsertVelocity,
    pixelsPerSecond,
    scrollY,
    selectControllerLane,
    setTimelineScroll,
    setTimelineZoom,
    snapDuration,
    snapTime,
    stageWidth,
    setPianoRollEditCursorTime,
    setLoopBoundaryDrag,
    setSelectedNoteIds,
    tool,
    visibleLanes,
    visibleGridWidth,
    velocityLaneHeight,
    velocityLaneY,
    timelineScrollX,
    timelineScrollY,
  ]);

  const handleStageContextMenu = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos || pos.x < PIANO_WIDTH || pos.y >= noteGridHeight) return;
    event.evt.preventDefault();
    event.cancelBubble = true;
    if (shouldSuppressWorkspaceContextMenu(event.evt.target)) return;
    const time = snapTime(getTimeFromX(pos.x));
    const note = getNoteFromY(pos.y);
    setPianoRollEditCursorTime(time);
    const inRange = pointInsideEditRange(pos.x, pos.y);
    setContextMenu({
      x: event.evt.clientX,
      y: event.evt.clientY,
      kind: inRange ? "range" : "grid",
      noteNumber: note,
      time,
    });
  }, [
    clipDuration,
    getNoteFromY,
    getTimeFromX,
    noteGridHeight,
    pointInsideEditRange,
    setPianoRollEditCursorTime,
    snapTime,
  ]);

  const handleStageMouseMove = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos) return;
    const stage = event.target?.getStage?.();
    const setStageCursor = (cursor: string) => {
      const container = stage?.container?.();
      if (container) container.style.cursor = cursor;
    };

    if (laneResizeState) {
      setStageCursor("row-resize");
      const minHeight = laneResizeState.laneKind === "velocity" ? 40 : 48;
      const maxHeight = laneResizeState.laneKind === "velocity" ? 140 : 180;
      const nextHeight = clamp(laneResizeState.originalHeight + pos.y - laneResizeState.startY, minHeight, maxHeight);
      updatePianoRollVisibleLane(laneResizeState.laneId, { height: nextHeight });
      if (laneResizeState.laneKind === "velocity") {
        setVelocityLaneHeight(nextHeight);
      } else {
        setCCLaneHeight(nextHeight);
      }
      return;
    }

    if (loopBoundaryDrag) {
      const nativeEvent = event.evt as MouseEvent;
      setStageCursor("ew-resize");
      const nextX = clamp(pos.x, PIANO_WIDTH, stageWidth);
      const rightEdgeAmount = Math.max(0, nextX - (stageWidth - LOOP_BOUNDARY_EDGE_SCROLL_ZONE_PX));
      const leftEdgeAmount = Math.max(0, (PIANO_WIDTH + LOOP_BOUNDARY_EDGE_SCROLL_ZONE_PX) - nextX);
      const scrollStep = rightEdgeAmount > 0
        ? Math.min(LOOP_BOUNDARY_EDGE_SCROLL_MAX_STEP_PX, Math.max(2, rightEdgeAmount * 0.65))
        : leftEdgeAmount > 0
          ? -Math.min(LOOP_BOUNDARY_EDGE_SCROLL_MAX_STEP_PX, Math.max(2, leftEdgeAmount * 0.65))
          : 0;
      const nextScrollX = clamp(timelineScrollX + scrollStep, 0, maxScrollX);
      if (Math.abs(nextScrollX - timelineScrollX) > 0.5) {
        setTimelineScroll(nextScrollX, timelineScrollY);
      }
      const rawSourceTime = projectXToMidiSourceTime(nextX - PIANO_WIDTH, {
        pixelsPerSecond,
        scrollX: nextScrollX,
        clipStartTime,
      });
      const nextSourceTime = snapTime(rawSourceTime, {
        bypassSnap: Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey),
        originalTime: rawSourceTime,
      });
      setLoopBoundaryDrag((current) => current ? { ...current, currentX: nextX, currentSourceTime: nextSourceTime } : null);
      setPianoRollEditCursorTime(nextSourceTime);
      return;
    }

    const activePanDrag = panDragRef.current || panDragState;
    if (activePanDrag) {
      setTimelineScroll(clamp(activePanDrag.originalScrollX - (pos.x - activePanDrag.startX), 0, maxScrollX), timelineScrollY);
      setScrollY(clamp(activePanDrag.originalScrollY - (pos.y - activePanDrag.startY), 0, maxScrollY));
      return;
    }

    if (dragState) {
      updateDragPreview(event);
      return;
    }

    if (drawingState) {
      const nativeEvent = event.evt as MouseEvent;
      setDrawingState((current) => {
        if (!current) return null;
        const rawTime = getTimeFromX(pos.x);
        return {
          ...current,
          endTime: Math.max(0, snapTime(rawTime, {
            bypassSnap: Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey),
            originalTime: current.startTime,
          })),
          noteNumber: getNoteFromY(pos.y),
        };
      });
      return;
    }

    if (marqueeState) {
      setMarqueeState((current) =>
        current ? { ...current, currentX: pos.x, currentY: pos.y } : null,
      );
      return;
    }

    if (rangeDragState) {
      setRangeDragState((current) =>
        current ? { ...current, currentX: pos.x, currentY: pos.y } : null,
      );
      return;
    }

    if (velocityEdit) {
      const velocity = getVelocityFromLaneY(pos.y);
      updateMIDINoteVelocity(trackId, clipId, velocityEdit.timestamp, velocityEdit.noteNumber, velocity, { transient: true });
      auditionNote(velocityEdit.noteNumber, velocity, { throttle: true, durationMs: 120 });
      return;
    }

    const activeCCDrawState = ccDrawStateRef.current;
    if (activeCCDrawState) {
      const nativeEvent = event.evt as MouseEvent;
      if ((nativeEvent.buttons & 1) !== 1) {
        ccDrawStateRef.current = null;
        setCCDrawState(null);
        return;
      }
      if (activeCCDrawState.lane === "noteMetadata") {
        const nextEvents = upsertNoteMetadataLaneValue(pos.x, pos.y, getLatestClipEvents());
        previewMIDIClipEvents(trackId, clipId, nextEvents);
      } else if (activeCCDrawState.lane === "pitchBend") {
        const nextEvents = upsertPitchBendEvent(pos.x, pos.y, getLatestClipEvents());
        previewMIDIClipEvents(trackId, clipId, nextEvents);
      } else if (activeCCDrawState.lane === "midiEvent") {
        const nextEvents = upsertScalarMIDIEvent(pos.x, pos.y, getLatestClipEvents());
        previewMIDIClipEvents(trackId, clipId, nextEvents);
      } else {
        const currentEvents = getLatestCCEvents();
        const nextEvents = upsertCCEvent(pos.x, pos.y, currentEvents);
        updateMIDICCEvents(trackId, clipId, nextEvents, { transient: true });
      }
      return;
    }

    const hoverTarget = hitTestPianoRoll(pos.x, pos.y, {
      pianoWidth: PIANO_WIDTH,
      noteGridHeight,
      velocityLaneY,
      velocityLaneHeight: isVelocityLaneActive ? velocityLaneHeight : 0,
      controllerLaneY: ccLaneY,
      controllerLaneHeight: activeControllerLane ? ccLaneHeight : 0,
      noteEdgeHitWidth: NOTE_EDGE_HIT_WIDTH,
      timeFromX: getTimeFromX,
      noteFromY: getNoteFromY,
      notes: pianoRollHitNotes,
      lanes: pianoRollHitLanes,
      controllerEvents: pianoRollControllerHitEvents,
      loopStartX: loopBoundaryStartX,
      loopEndX: loopBoundaryEndX,
      loopBoundaryHitWidth: 6,
    });
    setStageCursor(hoverTarget.kind === "loop-boundary" && clip?.loopEnabled ? "ew-resize" : "");
  }, [
    activeControllerLane,
    auditionNote,
    ccLaneHeight,
    ccLaneY,
    ccDrawState,
    clip,
    clipDuration,
    clipId,
    clipStartTime,
    dragState,
    drawingState,
    getLatestCCEvents,
    getLatestClipEvents,
    getNoteFromY,
    getTimeFromX,
    getVelocityFromLaneY,
    isVelocityLaneActive,
    laneResizeState,
    loopBoundaryDrag,
    loopBoundaryEndX,
    loopBoundaryStartX,
    marqueeState,
    maxScrollX,
    maxScrollY,
    noteGridHeight,
    panDragState,
    pianoRollControllerHitEvents,
    pianoRollHitLanes,
    pianoRollHitNotes,
    pixelsPerSecond,
    previewMIDIClipEvents,
    rangeDragState,
    snapTime,
    setTimelineScroll,
    setPianoRollEditCursorTime,
    stageWidth,
    timelineScrollX,
    timelineScrollY,
    trackId,
    updateDragPreview,
    updateMIDICCEvents,
    updateMIDINoteVelocity,
    updatePianoRollVisibleLane,
    upsertCCEvent,
    upsertNoteMetadataLaneValue,
    upsertPitchBendEvent,
    upsertScalarMIDIEvent,
    velocityEdit,
    velocityLaneHeight,
    velocityLaneY,
  ]);

  const handleStageMouseLeave = useCallback((event: KonvaEvent) => {
    const stage = event.target?.getStage?.();
    const container = stage?.container?.();
    if (container) container.style.cursor = "";
  }, []);

  const handleStageMouseUp = useCallback(() => {
    const activeCCDrawState = ccDrawStateRef.current;
    const hadEdit = dragState || drawingState || velocityEdit || activeCCDrawState;
    if (hadEdit) stopAudition();
    gestureSessionRef.current = null;
    if (loopBoundaryDrag && clip) {
      const loopOffset = loopBoundaryDrag.initialLoopOffset;
      const loopLength = Math.max(snapDuration, loopBoundaryDrag.initialLoopLength);
      const loopEnd = loopOffset + loopLength;
      const sourceTime = Math.max(0, loopBoundaryDrag.currentSourceTime);

      if (loopBoundaryDrag.edge === "start") {
        const nextOffset = clamp(sourceTime, 0, Math.max(0, loopEnd - snapDuration));
        setMIDIClipSourceWindow(clipId, {
          loopOffset: nextOffset,
          loopLength: Math.max(snapDuration, loopEnd - nextOffset),
        }, "Edit MIDI source loop start");
      } else {
        const nextEnd = Math.max(loopOffset + snapDuration, sourceTime);
        setMIDIClipSourceWindow(clipId, {
          sourceLength: nextEnd,
          loopLength: Math.max(snapDuration, nextEnd - loopOffset),
        }, "Edit MIDI source loop end");
      }
      setLoopBoundaryDrag(null);
      return;
    }
    if (laneResizeState) {
      setLaneResizeState(null);
      return;
    }

    const activePanDrag = panDragRef.current || panDragState;
    if (activePanDrag) {
      panDragRef.current = null;
      setPanDragState(null);
      return;
    }

    if (dragState) {
      const finalEvents = getLatestClipEvents();
      const description = dragState.mode === "move"
        ? "Move MIDI notes"
        : "Resize MIDI note";
      commitMIDIClipEvents(trackId, clipId, dragState.originalEvents, finalEvents, description);
      const preview = latestDragAuditionRef.current;
      if (preview) auditionNote(preview.noteNumber, preview.velocity, { durationMs: 140 });
      latestDragAuditionRef.current = null;
      setDragState(null);
    }

    if (drawingState) {
      const start = Math.min(drawingState.startTime, drawingState.endTime);
      const end = Math.max(drawingState.startTime, drawingState.endTime);
      const duration = Math.max(snapDuration, end - start || snapDuration);
      const newId = addMIDINote(trackId, clipId, start, drawingState.noteNumber, duration, drawingState.velocity);
      setSelectedNoteIds(newId ? [newId] : []);
      auditionNote(drawingState.noteNumber, drawingState.velocity);
      setDrawingState(null);
    }

    if (marqueeState) {
      const left = Math.min(marqueeState.startX, marqueeState.currentX);
      const right = Math.max(marqueeState.startX, marqueeState.currentX);
      const top = Math.min(marqueeState.startY, marqueeState.currentY);
      const bottom = Math.max(marqueeState.startY, marqueeState.currentY);
      if (right - left > 3 || bottom - top > 3) {
        selectMIDINotesInRange(
          clipId,
          {
            startTime: Math.max(0, getTimeFromX(left)),
            endTime: Math.max(0, getTimeFromX(right)),
            minNote: Math.min(getNoteFromY(top), getNoteFromY(bottom)),
            maxNote: Math.max(getNoteFromY(top), getNoteFromY(bottom)),
          },
          marqueeState.mode,
        );
      }
      setMarqueeState(null);
    }

    if (rangeDragState) {
      const left = Math.min(rangeDragState.startX, rangeDragState.currentX);
      const right = Math.max(rangeDragState.startX, rangeDragState.currentX);
      const top = Math.min(rangeDragState.startY, rangeDragState.currentY);
      const bottom = Math.max(rangeDragState.startY, rangeDragState.currentY);
      if (right - left > 3 || bottom - top > 3) {
        const range = rangeFromRect(rangeDragState);
        setMIDIEditRange(range);
        selectMIDINotesInRange(
          clipId,
          {
            startTime: range.startTime,
            endTime: range.endTime,
            minNote: range.minNote,
            maxNote: range.maxNote,
          },
          "replace",
        );
      }
      setRangeDragState(null);
    }

    if (velocityEdit) {
      const finalPair = parseNotePairs(getLatestClipEvents()).find((pair) =>
        noteIdFor(clipId, pair.startTime, pair.noteNumber) === velocityEdit.noteId
        || (Math.abs(pair.startTime - velocityEdit.timestamp) < 0.001 && pair.noteNumber === velocityEdit.noteNumber),
      );
      commitMIDIClipEvents(trackId, clipId, velocityEdit.originalEvents, getLatestClipEvents(), "Edit MIDI velocity");
      if (finalPair) auditionNote(finalPair.noteNumber, finalPair.velocity, { durationMs: 140 });
      setVelocityEdit(null);
    }

    if (activeCCDrawState) {
      if (activeCCDrawState.lane === "noteMetadata") {
        const label = selectedNoteMetadataLaneLabel || "note metadata";
        commitMIDIClipEvents(trackId, clipId, activeCCDrawState.originalEvents, getLatestClipEvents(), `Draw MIDI ${label} lane`);
      } else if (activeCCDrawState.lane === "pitchBend") {
        commitMIDIClipEvents(trackId, clipId, activeCCDrawState.originalEvents, getLatestClipEvents(), "Draw MIDI pitch bend");
      } else if (activeCCDrawState.lane === "midiEvent") {
        commitMIDIClipEvents(trackId, clipId, activeCCDrawState.originalEvents, getLatestClipEvents(), "Draw MIDI event lane");
      } else {
        commitMIDICCEvents(trackId, clipId, activeCCDrawState.originalCCEvents, getLatestCCEvents(), "Draw MIDI CC");
      }
      ccDrawStateRef.current = null;
      setCCDrawState(null);
    }
  }, [
    addMIDINote,
    auditionNote,
    ccDrawState,
    clip,
    clipDuration,
    clipId,
    commitMIDICCEvents,
    commitMIDIClipEvents,
    dragState,
    drawingState,
    getLatestCCEvents,
    getLatestClipEvents,
    getNoteFromY,
    getTimeFromX,
    laneResizeState,
    loopBoundaryDrag,
    marqueeState,
    panDragState,
    rangeDragState,
    rangeFromRect,
    selectMIDINotesInRange,
    selectedNoteMetadataLaneLabel,
    setMIDIEditRange,
    setMIDIClipSourceWindow,
    snapDuration,
    snapTime,
    stopAudition,
    trackId,
    velocityEdit,
  ]);

  useEffect(() => {
    window.addEventListener("mouseup", handleStageMouseUp);
    return () => window.removeEventListener("mouseup", handleStageMouseUp);
  }, [handleStageMouseUp]);

  if (!clip || !track) {
    return <div className="piano-roll-empty">No MIDI clip selected</div>;
  }

  const renderGrid = () => {
    const elements: React.ReactNode[] = [];
    const beatInterval = 1 / beatsPerSecond;
    const firstRow = Math.max(0, Math.floor(scrollY / noteHeight) - 1);
    const lastRow = Math.min(TOTAL_NOTES, Math.ceil((scrollY + noteGridHeight) / noteHeight) + 1);
    const visibleProjectStart = Math.max(0, timelineScrollX / pixelsPerSecond - beatInterval);
    const visibleProjectEnd = (timelineScrollX + stageWidth) / pixelsPerSecond + beatInterval;
    const projectContentEnd = editorContentEnd;

    const firstBeatIndex = Math.max(0, Math.floor(visibleProjectStart / beatInterval));
    const lastBeatIndex = Math.ceil(Math.min(visibleProjectEnd, projectContentEnd) / beatInterval);
    for (let beatIndex = firstBeatIndex; beatIndex < lastBeatIndex; beatIndex += 1) {
      const projectTime = beatIndex * beatInterval;
      const x = projectTime * pixelsPerSecond - timelineScrollX;
      const width = beatInterval * pixelsPerSecond;
      if (x + width < PIANO_WIDTH || x > stageWidth) {
        continue;
      }
      if (beatIndex % 2 === 1) {
        elements.push(
          <Rect
            key={`beat-shade-${beatIndex}`}
            x={Math.max(PIANO_WIDTH, x)}
            y={0}
            width={Math.min(width, stageWidth - x)}
            height={noteGridHeight}
            fill="#ffffff"
            opacity={0.035}
            listening={false}
          />,
        );
      }
    }

    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = row * noteHeight - scrollY;
      const noteNumber = TOTAL_NOTES - 1 - row;
      const noteName = NOTE_NAMES[noteNumber >= 0 ? noteNumber % NOTES_PER_OCTAVE : 0];
      const isC = noteName === "C";
      const isBlackKey = noteName.includes("#");
      const inScale = noteNumber >= 0 && isNoteInScale(noteNumber, scaleRoot, scaleType);

      if (row < TOTAL_NOTES && scaleType !== "chromatic" && inScale) {
        elements.push(
          <Rect
            key={`scale-bg-${row}`}
            x={PIANO_WIDTH}
            y={y}
            width={contentWidth}
            height={noteHeight}
            fill="#4cc9f0"
            opacity={0.06}
            listening={false}
          />,
        );
      }
      if (isBlackKey && row < TOTAL_NOTES) {
        elements.push(
          <Rect
            key={`black-bg-${row}`}
            x={PIANO_WIDTH}
            y={y}
            width={contentWidth}
            height={noteHeight}
            fill="#000000"
            opacity={0.08}
            listening={false}
          />,
        );
      }

      elements.push(
        <Line
          key={`h-${row}`}
          points={[PIANO_WIDTH, y, stageWidth, y]}
          stroke={isC ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.055)"}
          strokeWidth={isC ? 1 : 0.5}
          listening={false}
        />,
      );
    }

    const visualGrid = resolveVisualGrid(tempo, timeSignature, gridSize, {
      quantizePreset: activeQuantizePreset,
      quantizeGridSize: activeQuantizePreset.gridSize,
      pixelsPerSecond,
      viewportPixels: visibleGridWidth,
      maxVisibleLines: 180,
      minPixelsPerGrid: 18,
    });
    const pushDivisionLine = (projectTime: number, key: string) => {
      if (projectTime > projectContentEnd) return;
      const x = projectTime * pixelsPerSecond - timelineScrollX;
      if (x < PIANO_WIDTH || x > stageWidth) return;
      const beatIndex = projectTime / beatInterval;
      const isBeat = Math.abs(beatIndex - Math.round(beatIndex)) < 0.0001;
      const barIndex = projectTime / Math.max(0.000001, visualGrid.barInterval);
      const isBar = Math.abs(barIndex - Math.round(barIndex)) < 0.0001;
      elements.push(
        <Line
          key={key}
          points={[x, 0, x, noteGridHeight]}
          stroke={isBar || isBeat ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.055)"}
          strokeWidth={isBar || isBeat ? 1 : 0.5}
          listening={false}
        />,
      );
    };

    if (visualGrid.alignedToBar) {
      const startBar = Math.floor(visibleProjectStart / visualGrid.barInterval) - 1;
      const endBar = Math.ceil(Math.min(visibleProjectEnd, projectContentEnd) / visualGrid.barInterval) + 1;
      for (let bar = Math.max(0, startBar); bar <= endBar; bar += 1) {
        const barTime = bar * visualGrid.barInterval;
        for (let division = 0; division < visualGrid.divisionsPerBar; division += 1) {
          pushDivisionLine(barTime + division * visualGrid.visualInterval, `v-bar-${bar}-${division}`);
        }
      }
    } else {
      const firstDivisionIndex = Math.max(0, Math.floor(visibleProjectStart / visualGrid.visualInterval));
      const lastDivisionIndex = Math.ceil(Math.min(visibleProjectEnd, projectContentEnd) / visualGrid.visualInterval);
      for (let divisionIndex = firstDivisionIndex; divisionIndex <= lastDivisionIndex; divisionIndex += 1) {
        pushDivisionLine(divisionIndex * visualGrid.visualInterval, `v-${divisionIndex}`);
      }
    }

    return elements;
  };

  const renderLoopBoundaries = () => {
    if (previewLoopBoundaryStartX === undefined || previewLoopBoundaryEndX === undefined) return null;
    const markerColor = "rgba(100,199,232,0.78)";
    const dragFill = loopBoundaryDrag ? "rgba(100,199,232,0.12)" : "rgba(100,199,232,0.05)";
    return (
      <Group listening={false}>
        <Line points={[previewLoopBoundaryStartX, 0, previewLoopBoundaryStartX, stageHeight]} stroke={markerColor} strokeWidth={1} dash={[5, 4]} />
        <Line points={[previewLoopBoundaryEndX, 0, previewLoopBoundaryEndX, stageHeight]} stroke={markerColor} strokeWidth={1} dash={[5, 4]} />
        <Rect x={previewLoopBoundaryStartX - 4} y={0} width={8} height={noteGridHeight} fill={dragFill} />
        <Rect x={previewLoopBoundaryEndX - 4} y={0} width={8} height={noteGridHeight} fill={dragFill} />
        <Text x={Math.max(PIANO_WIDTH + 4, previewLoopBoundaryStartX + 4)} y={4} text="Loop" fontSize={9} fill="rgba(205,241,255,0.72)" />
      </Group>
    );
  };

  const handleAdditionalClipNoteMouseDown = useCallback((event: KonvaEvent, pair: MultiClipNotePair) => {
    event.cancelBubble = true;
    const localStartTime = Math.max(0, pair.startTime - pair.timeOffset);
    openPianoRoll(trackId, pair.clipId);
    useDAWStore.getState().setSelectedNoteIds([
      noteIdFor(pair.clipId, localStartTime, pair.noteNumber),
    ]);
  }, [openPianoRoll, trackId]);

  const renderGhostNotes = () => {
    if (!showGhostMIDIClips) return [];
    const ghostElements: React.ReactNode[] = [];
    const editingClipIds = new Set([clipId, ...additionalClipIds]);
    track.midiClips
      .filter((candidate) => !editingClipIds.has(candidate.id))
      .forEach((otherClip) => {
        const timeOffset = otherClip.startTime - clipStartTime;
        parseNotePairs(otherClip.events).forEach((pair) => {
          const adjustedTime = pair.startTime + timeOffset;
          const x = PIANO_WIDTH + adjustedTime * pixelsPerSecond - scrollX;
          const y = getNoteY(pair.noteNumber);
          const width = pair.duration * pixelsPerSecond;
          if (x + width < PIANO_WIDTH || x > stageWidth || y + noteHeight < 0 || y > noteGridHeight) return;
          ghostElements.push(
            <Rect
              key={`ghost-${otherClip.id}-${pair.startTime}-${pair.noteNumber}`}
              x={x}
              y={y}
              width={Math.max(3, width)}
              height={noteHeight - 1}
              fill="#9ca3af"
              opacity={0.2}
              cornerRadius={2}
              listening={false}
            />,
          );
        });
      });
    return ghostElements;
  };

  const renderPrimaryNotes = () => {
    return notePairs.map((pair) => {
      const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const y = getNoteY(pair.noteNumber);
      const width = Math.max(4, pair.duration * pixelsPerSecond);
      if (x + width < PIANO_WIDTH || x > stageWidth || y + noteHeight < 0 || y > noteGridHeight) return null;

      const selected = selectedNoteIds.includes(id);
      const fillColor = velocityColor(pair.velocity);
      const strokeColor = selected ? "#ffffff" : velocityStrokeColor(pair.velocity);
      const showName = width > 40;
      const muted = !!pair.muted;

      return (
        <Group
          key={`note-${id}`}
          onMouseDown={(event) => handleNoteMouseDown(event, pair)}
          onContextMenu={(event) => handleNoteContextMenu(event, pair)}
        >
          <Rect
            x={x}
            y={y}
            width={width}
            height={noteHeight - 1}
            fill={fillColor}
            opacity={muted ? 0.28 : selected ? 0.98 : 0.85}
            stroke={strokeColor}
            strokeWidth={selected ? 1.5 : muted ? 0.5 : 1}
            cornerRadius={2}
            shadowColor={selected ? "#ffffff" : undefined}
            shadowBlur={selected ? 5 : 0}
            shadowOpacity={selected ? 0.28 : 0}
          />
          {selected && width > 14 && (
            <>
              <Rect x={x + 2} y={y + 2} width={2} height={Math.max(1, noteHeight - 5)} fill="#ffffff" opacity={0.9} listening={false} />
              <Rect x={x + width - 4} y={y + 2} width={2} height={Math.max(1, noteHeight - 5)} fill="#ffffff" opacity={0.9} listening={false} />
            </>
          )}
          {pair.pressure !== undefined && pair.pressure > 0 && (
            <Rect x={x} y={y} width={width} height={noteHeight - 1} fill="#ffffff" opacity={pair.pressure * 0.3} cornerRadius={2} listening={false} />
          )}
          {pair.pitchBend !== undefined && pair.pitchBend !== 0 && width > 8 && (
            <Line
              points={pair.pitchBend > 0
                ? [x + width - 6, y + noteHeight - 4, x + width - 3, y + 2, x + width, y + noteHeight - 4]
                : [x + width - 6, y + 2, x + width - 3, y + noteHeight - 4, x + width, y + 2]}
              fill="#ffffff"
              closed
              opacity={0.7}
              listening={false}
            />
          )}
          {pair.slide !== undefined && pair.slide > 0 && width > 8 && (
            <Line points={[x + width - 8, y + noteHeight - 3, x + width - 2, y + 2]} stroke="#ffffff" strokeWidth={1.5} opacity={0.6} listening={false} />
          )}
          {showName && (
            <Text
              x={x + 4}
              y={y + 1}
              text={getNoteNameFromPitch(pair.noteNumber)}
              fontSize={8}
              fill="#000000"
              opacity={0.7}
              width={width - 8}
              listening={false}
            />
          )}
        </Group>
      );
    });
  };

  const renderAdditionalClipNotes = () => {
    return additionalClipNotePairs.map((pair) => {
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const y = getNoteY(pair.noteNumber);
      const width = Math.max(4, pair.duration * pixelsPerSecond);
      if (x + width < PIANO_WIDTH || x > stageWidth || y + noteHeight < 0 || y > noteGridHeight) return null;
      const tintColor = MULTI_CLIP_TINTS[pair.clipIndex % MULTI_CLIP_TINTS.length] || "#ff6b9d";
      return (
        <Group
          key={`mcnote-${pair.clipId}-${pair.startTime}-${pair.noteNumber}`}
          onMouseDown={(event) => handleAdditionalClipNoteMouseDown(event, pair)}
        >
          <Rect
            x={x}
            y={y}
            width={width}
            height={noteHeight - 1}
            fill={tintColor}
            opacity={0.74}
            stroke={tintColor}
            strokeWidth={1}
            cornerRadius={2}
          />
          {width > 40 && (
            <Text x={x + 3} y={y + 1} text={getNoteNameFromPitch(pair.noteNumber)} fontSize={8} fill="#000000" opacity={0.6} width={width - 6} listening={false} />
          )}
        </Group>
      );
    });
  };

  const renderDrawingPreview = () => {
    if (!drawingState) return null;
    const start = Math.min(drawingState.startTime, drawingState.endTime);
    const end = Math.max(drawingState.startTime, drawingState.endTime);
    const x = PIANO_WIDTH + start * pixelsPerSecond - scrollX;
    const y = getNoteY(drawingState.noteNumber);
    const width = Math.max(4, (end - start || snapDuration) * pixelsPerSecond);
    return (
      <Rect
        x={x}
        y={y}
        width={width}
        height={noteHeight - 1}
        fill="#ffffff"
        opacity={0.35}
        stroke="#4cc9f0"
        strokeWidth={1}
        dash={[4, 2]}
        cornerRadius={2}
        listening={false}
      />
    );
  };

  const renderMarqueeSelection = () => {
    if (!marqueeState) return null;
    const x = Math.min(marqueeState.startX, marqueeState.currentX);
    const y = Math.min(marqueeState.startY, marqueeState.currentY);
    const width = Math.abs(marqueeState.currentX - marqueeState.startX);
    const height = Math.abs(marqueeState.currentY - marqueeState.startY);
    return (
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="rgba(76, 201, 240, 0.16)"
        stroke="#4cc9f0"
        strokeWidth={1}
        dash={[4, 3]}
        listening={false}
      />
    );
  };

  const renderRangeSelection = () => {
    const activeRange = rangeDragState ? rangeFromRect(rangeDragState) : midiEditRange;
    if (!activeRange || activeRange.endTime <= activeRange.startTime) return null;
    const x = PIANO_WIDTH + activeRange.startTime * pixelsPerSecond - scrollX;
    const width = Math.max(1, (activeRange.endTime - activeRange.startTime) * pixelsPerSecond);
    const topY = getNoteY(activeRange.maxNote);
    const bottomY = getNoteY(activeRange.minNote) + noteHeight;
    return (
      <Rect
        x={x}
        y={topY}
        width={width}
        height={Math.max(noteHeight, bottomY - topY)}
        fill="rgba(250, 204, 21, 0.14)"
        stroke="#facc15"
        strokeWidth={1}
        dash={[6, 3]}
        listening={false}
      />
    );
  };

  const renderStepInputCursor = () => {
    if (!stepInputEnabled) return null;
    const cursorX = PIANO_WIDTH + stepInputPosition * pixelsPerSecond - scrollX;
    if (cursorX < PIANO_WIDTH || cursorX > stageWidth) return null;
    return (
      <Group>
        <Line points={[cursorX, 0, cursorX, noteGridHeight]} stroke="#ff4444" strokeWidth={2} opacity={0.9} dash={[6, 3]} listening={false} />
        <Line points={[cursorX - 5, 0, cursorX + 5, 0, cursorX, 8]} fill="#ff4444" closed listening={false} />
      </Group>
    );
  };

  const renderVelocityLane = () => {
    const elements: React.ReactNode[] = [
      <Rect key="vel-bg" x={0} y={velocityLaneY} width={stageWidth} height={velocityLaneHeight} fill="#161616" listening={false} />,
      <Line key="vel-divider" points={[0, velocityLaneY, stageWidth, velocityLaneY]} stroke="rgba(255,255,255,0.15)" strokeWidth={1} listening={false} />,
      <Text key="vel-label" x={4} y={velocityLaneY + 2} text="Vel" fontSize={9} fill="#8a8a8a" listening={false} />,
    ];

    [0.25, 0.5, 0.75].forEach((frac) => {
      const y = velocityLaneY + velocityLaneHeight * (1 - frac);
      elements.push(<Line key={`vel-guide-${frac}`} points={[PIANO_WIDTH, y, stageWidth, y]} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} listening={false} />);
    });

    notePairs.forEach((pair) => {
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const width = Math.max(4, pair.duration * pixelsPerSecond - 1);
      if (x + width < PIANO_WIDTH || x > stageWidth) return;
      const barHeight = (pair.velocity / 127) * (velocityLaneHeight - 4);
      const y = velocityLaneY + velocityLaneHeight - barHeight - 2;
      elements.push(
        <Rect
          key={`vel-bar-${pair.startTime}-${pair.noteNumber}`}
          x={x}
          y={y}
          width={width}
          height={barHeight}
          fill={velocityColor(pair.velocity)}
          opacity={pair.muted ? 0.25 : selectedNoteIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)) ? 1 : 0.8}
          cornerRadius={1}
        />,
      );
    });

    elements.push(<Rect key="vel-overlay" x={PIANO_WIDTH} y={velocityLaneY} width={stageWidth - PIANO_WIDTH} height={velocityLaneHeight} fill="transparent" />);
    return elements;
  };

  const renderCCLane = () => {
    const elements: React.ReactNode[] = [];
    const ccPreset = CC_PRESETS.find((preset) => preset.cc === selectedCC);
    const laneLabel = isCC14BitMode
      ? `14-bit CC#${selectedCC}/${selectedCC + 32}`
      : selectedNoteMetadataLaneType
        ? selectedNoteMetadataLaneLabel
        : selectedScalarMIDIEventType
          ? selectedScalarMIDIEventLabel
          : (ccPreset?.name || `CC#${selectedCC}`);
    elements.push(
      <Rect key="cc-bg" x={0} y={ccLaneY} width={stageWidth} height={ccLaneHeight} fill="#141414" listening={false} />,
      <Line key="cc-divider" points={[0, ccLaneY, stageWidth, ccLaneY]} stroke="rgba(255,255,255,0.15)" strokeWidth={1} listening={false} />,
      <Text key="cc-label" x={4} y={ccLaneY + 2} text={laneLabel} fontSize={9} fill="#8a8a8a" listening={false} />,
    );

    [0.25, 0.5, 0.75].forEach((frac) => {
      const y = ccLaneY + ccLaneHeight * (1 - frac);
      elements.push(<Line key={`cc-guide-${frac}`} points={[PIANO_WIDTH, y, stageWidth, y]} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} listening={false} />);
    });
    if (selectedCC === PITCH_BEND_LANE) {
      const y = ccLaneY + ccLaneHeight * 0.5;
      elements.push(<Line key="pitchbend-center" points={[PIANO_WIDTH, y, stageWidth, y]} stroke="rgba(255,255,255,0.22)" strokeWidth={1} dash={[4, 3]} listening={false} />);
      const upRange = Math.max(1, Math.round(pitchBendRangeUp));
      const downRange = Math.max(1, Math.round(pitchBendRangeDown));
      const spacing = ccLaneHeight / (upRange + downRange);
      for (let semitone = -downRange; semitone <= upRange; semitone += 1) {
        if (semitone === 0) continue;
        const value = semitonesToPitchBendValueWithRange(semitone, upRange, downRange);
        const gridY = ccLaneY + ccLaneHeight * (1 - pitchBendValueToLaneFraction(value));
        elements.push(
          <Line
            key={`pitchbend-semitone-${semitone}`}
            points={[PIANO_WIDTH, gridY, stageWidth, gridY]}
            stroke="rgba(76,201,240,0.12)"
            strokeWidth={0.5}
            listening={false}
          />,
        );
        if (spacing >= 8 || semitone === -downRange || semitone === upRange) {
          const label = `${semitone > 0 ? "+" : ""}${semitone}`;
          elements.push(
            <Text
              key={`pitchbend-semitone-label-${semitone}`}
              x={PIANO_WIDTH + 4}
              y={gridY - 5}
              text={label}
              fontSize={8}
              fill="rgba(180,230,255,0.48)"
              listening={false}
            />,
          );
        }
      }
    }

    if (selectedNoteMetadataLaneType) {
      const maxValue = noteMetadataLaneMax(selectedNoteMetadataLaneType);
      notePairs.forEach((pair) => {
        const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
        const width = Math.max(4, pair.duration * pixelsPerSecond - 1);
        if (x + width < PIANO_WIDTH || x > stageWidth) return;
        const rawValue = noteMetadataValueForPair(pair, selectedNoteMetadataLaneType);
        const barHeight = (rawValue / maxValue) * (ccLaneHeight - 4);
        const y = ccLaneY + ccLaneHeight - barHeight - 2;
        const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
        const selected = selectedNoteIds.includes(id);
        elements.push(
          <Rect
            key={`meta-bar-${selectedNoteMetadataLaneType}-${pair.startTime}-${pair.noteNumber}`}
            x={x}
            y={y}
            width={width}
            height={barHeight}
            fill={selectedNoteMetadataLaneType === "chance" ? "#f59e0b" : selectedNoteMetadataLaneType === "velocityVariance" ? "#c084fc" : "#4cc9f0"}
            opacity={pair.muted ? 0.25 : selected ? 1 : 0.78}
            cornerRadius={1}
            onMouseDown={(konvaEvent) => {
              konvaEvent.cancelBubble = true;
              handleCCMouseDown(konvaEvent);
            }}
          />,
        );
      });
      elements.push(
        <Rect
          key="metadata-overlay"
          x={PIANO_WIDTH}
          y={ccLaneY}
          width={stageWidth - PIANO_WIDTH}
          height={ccLaneHeight}
          fill="transparent"
          onMouseDown={(konvaEvent) => {
            konvaEvent.cancelBubble = true;
            handleCCMouseDown(konvaEvent);
          }}
        />,
      );
      return elements;
    }

    const linePoints: number[] = [];
    controllerEventsForLane.forEach((event) => {
      const x = PIANO_WIDTH + event.time * pixelsPerSecond - scrollX;
      const y = ccLaneY + ccLaneHeight * (1 - event.value / 127);
      linePoints.push(x, y);
    });
    if (linePoints.length >= 4) {
      elements.push(<Line key="cc-line" points={linePoints} stroke="#4cc9f0" strokeWidth={1.5} opacity={0.6} listening={false} />);
    }

    controllerEventsForLane.forEach((event, index) => {
      const x = PIANO_WIDTH + event.time * pixelsPerSecond - scrollX;
      if (x < PIANO_WIDTH || x > stageWidth) return;
      const barHeight = (event.value / 127) * (ccLaneHeight - 4);
      const y = ccLaneY + ccLaneHeight - barHeight - 2;
      elements.push(
        <Rect key={`cc-bar-${index}`} x={x - 1} y={y} width={3} height={barHeight} fill="#4cc9f0" opacity={0.5} listening={false} />,
        <Rect
          key={`cc-dot-${index}`}
          x={x - 3}
          y={y - 3}
          width={6}
          height={6}
          fill="#4cc9f0"
          cornerRadius={3}
          opacity={0.9}
          onMouseDown={(konvaEvent) => {
            konvaEvent.cancelBubble = true;
            handleCCMouseDown(konvaEvent);
          }}
        />,
      );
    });

    elements.push(<Rect key="cc-overlay" x={PIANO_WIDTH} y={ccLaneY} width={stageWidth - PIANO_WIDTH} height={ccLaneHeight} fill="transparent" />);
    return elements;
  };

  const renderActiveControllerLane = () => {
    return isVelocityLaneActive ? renderVelocityLane() : renderCCLane();
  };

  const getRulerTimeFromClientX = useCallback((clientX: number, bypassSnap: boolean) => {
    const ruler = containerRef.current?.querySelector(".piano-roll-ruler") as HTMLDivElement | null;
    const rect = ruler?.getBoundingClientRect();
    const x = rect ? clientX - rect.left : 0;
    const rawTime = Math.max(0, (x + timelineScrollX) / pixelsPerSecond);
    if (!snapEnabled || bypassSnap) return rawTime;
    return snapTimeByType({
      time: rawTime,
      tempo,
      timeSignature,
      gridSize,
      snapType,
      quantizePreset: activeQuantizePreset,
      quantizeGridSize: activeQuantizePreset.gridSize,
      pixelsPerSecond,
      cursorTime: useDAWStore.getState().transport.currentTime,
      eventTimes: midiSnapEventTimes.map((time) => clipStartTime + time),
    });
  }, [
    activeQuantizePreset,
    clipStartTime,
    gridSize,
    midiSnapEventTimes,
    pixelsPerSecond,
    snapEnabled,
    snapType,
    tempo,
    timeSignature,
    timelineScrollX,
  ]);

  const handleRulerPointerDown = useCallback((event: any) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bypassSnap = event.ctrlKey || event.metaKey;
    const targetSessionId = sessionId || windowSessionId || undefined;
    const publishPreviewSeek = (time: number) => {
      useDAWStore.getState().setCurrentTime(time);
      if (isDetached || windowRole !== "main") {
        void nativeBridge.publishAppCommand({
          command: "transport.seekPreview",
          time,
          sessionId: targetSessionId,
        });
      }
    };
    const publishFinalSeek = (time: number) => {
      if (isDetached || windowRole !== "main") {
        void nativeBridge.publishAppCommand({
          command: "transport.seek",
          time,
          sessionId: targetSessionId,
        });
      } else {
        void seekTo(time);
      }
    };

    let latestTime = getRulerTimeFromClientX(event.clientX, bypassSnap);
    publishPreviewSeek(latestTime);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      latestTime = getRulerTimeFromClientX(moveEvent.clientX, moveEvent.ctrlKey || moveEvent.metaKey);
      publishPreviewSeek(latestTime);
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      publishFinalSeek(latestTime);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [getRulerTimeFromClientX, isDetached, seekTo, sessionId]);

  const renderRulerMarks = () => {
    const marks: React.ReactNode[] = [];
    const secondsPerBeat = 60 / Math.max(1, tempo);
    const beatsPerBar = Math.max(1, timeSignature.numerator || 4);
    const secondsPerBar = secondsPerBeat * beatsPerBar;
    const pixelsPerBeat = secondsPerBeat * pixelsPerSecond;
    const visibleStart = Math.max(0, timelineScrollX / pixelsPerSecond - secondsPerBar);
    const visibleEnd = (timelineScrollX + stageWidth) / pixelsPerSecond + secondsPerBar;
    const firstBeat = Math.floor(visibleStart / secondsPerBeat);
    const lastBeat = Math.ceil(visibleEnd / secondsPerBeat);
    const labelEveryBar = pixelsPerBeat * beatsPerBar < 70 ? 2 : 1;

    for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
      const projectTime = beat * secondsPerBeat;
      const x = projectTime * pixelsPerSecond - timelineScrollX;
      if (x < -80 || x > stageWidth + 80) continue;
      const isBar = beat % beatsPerBar === 0;
      const bar = Math.floor(beat / beatsPerBar) + 1;
      const beatInBar = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar + 1;
      const showLabel = isBar && (bar - 1) % labelEveryBar === 0;
      marks.push(
        <div
          key={`ruler-tick-${beat}`}
          className={isBar ? "piano-roll-ruler-tick piano-roll-ruler-tick-bar" : "piano-roll-ruler-tick"}
          style={{ left: x }}
        >
          {showLabel && <span>{bar}</span>}
          {!showLabel && pixelsPerBeat >= 42 && <small>{beatInBar}</small>}
        </div>,
      );
    }

    return marks;
  };

  const renderPianoKeys = () => {
    const keys: React.ReactNode[] = [];
    const firstRow = Math.max(0, Math.floor(scrollY / noteHeight) - 1);
    const lastRow = Math.min(TOTAL_NOTES - 1, Math.ceil((scrollY + noteGridHeight) / noteHeight) + 1);

    for (let row = firstRow; row <= lastRow; row += 1) {
      const noteNumber = TOTAL_NOTES - 1 - row;
      const y = row * noteHeight - scrollY;
      const noteName = NOTE_NAMES[noteNumber % NOTES_PER_OCTAVE];
      const isBlackKey = noteName.includes("#");
      const isC = noteName === "C";
      const isActive = activePreviewNotes.has(noteNumber);
      keys.push(
        <button
          key={`piano-key-${noteNumber}`}
          type="button"
          className={[
            "piano-roll-piano-key",
            isBlackKey ? "piano-roll-piano-key-black" : "piano-roll-piano-key-white",
            isActive ? "piano-roll-piano-key-active" : "",
          ].filter(Boolean).join(" ")}
          style={{
            top: y,
            height: noteHeight,
            width: isBlackKey ? "64%" : "100%",
          }}
          title={`${getNoteNameFromPitch(noteNumber)} audition`}
          data-tooltip={`${getNoteNameFromPitch(noteNumber)} audition`}
          data-midi-note={noteNumber}
          aria-label={`${getNoteNameFromPitch(noteNumber)} piano key`}
        >
          {isC && <span>{getNoteNameFromPitch(noteNumber)}</span>}
        </button>,
      );
    }

    return keys;
  };

  const selectedPairs = notePairs.filter((pair) =>
    selectedNoteIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)),
  );
  const selectedMuted = selectedPairs.length > 0 && selectedPairs.every((pair) => pair.noteOn.muted || pair.noteOff.muted);
  const inspectedNotePair = selectedPairs.length === 1 ? selectedPairs[0] : null;
  const inspectedChanceRaw = inspectedNotePair?.probability ?? inspectedNotePair?.chance ?? 1;
  const inspectedChancePercent = clamp(
    Math.round((inspectedChanceRaw > 1 ? inspectedChanceRaw / 100 : inspectedChanceRaw) * 100),
    0,
    100,
  );
  const mixed = "";
  const commonSelectedValue = useCallback(<T,>(values: T[], fallback: T | ""): T | "" => {
    if (values.length === 0) return fallback;
    const [first] = values;
    return values.every((value) => Object.is(value, first)) ? first : mixed;
  }, []);
  const selectedVelocityValue = commonSelectedValue(selectedPairs.map((pair) => pair.velocity), mixed);
  const selectedChannelValue = commonSelectedValue(selectedPairs.map((pair) => pair.channel ?? 1), mixed);
  const selectedReleaseVelocityValue = commonSelectedValue(
    selectedPairs.map((pair) => pair.releaseVelocity ?? pair.noteOff.velocity ?? 0),
    mixed,
  );
  const selectedChanceValue = commonSelectedValue(
    selectedPairs.map((pair) => {
      const raw = pair.probability ?? pair.chance ?? 1;
      return clamp(Math.round((raw > 1 ? raw / 100 : raw) * 100), 0, 100);
    }),
    mixed,
  );
  const selectedVarianceValue = commonSelectedValue(selectedPairs.map((pair) => pair.velocityVariance ?? 0), mixed);
  const selectedPlayCountValue = commonSelectedValue(selectedPairs.map((pair) => pair.playCount ?? 0), mixed);
  const selectedCentOffsetValue = commonSelectedValue(selectedPairs.map((pair) => pair.centOffset ?? 0), mixed);

  const addLane = useCallback((kind: PianoRollVisibleLane["kind"], cc?: number) => {
    const nextId = `${kind}-${cc ?? Date.now()}`;
    const labelByKind: Record<PianoRollVisibleLane["kind"], string> = {
      velocity: "Velocity",
      noteOffVelocity: "Note-Off Velocity",
      chance: "Chance",
      velocityVariance: "Velocity Variance",
      pitchBend: "Pitch Bend",
      programBank: "Program / Bank",
      channelPressure: "Channel Pressure",
      polyPressure: "Poly Pressure",
      cc7: `CC#${cc ?? 1}`,
      cc14: `14-bit CC#${cc ?? 1}/${(cc ?? 1) + 32}`,
    };
    const lane: PianoRollVisibleLane = {
      id: nextId,
      kind,
      label: labelByKind[kind],
      height: kind === "velocity" ? 72 : 88,
      cc,
      interpolation: kind === "velocity" ? "step" : "linear",
    };
    addPianoRollVisibleLane(lane);
    selectControllerLane(lane);
  }, [addPianoRollVisibleLane, selectControllerLane]);

  useEffect(() => {
    if (!activeLane) return;
    if (activeLane.kind === "velocity") {
      setVelocityLaneHeight(clamp(activeLane.height || VELOCITY_LANE_HEIGHT, 40, 140));
      return;
    }
    selectControllerLane(activeLane);
    setCCLaneHeight(clamp(activeLane.height || CC_LANE_HEIGHT, 48, 180));
  }, [activeLane, selectControllerLane]);

  useEffect(() => {
    if (selectedCC === POLY_PRESSURE_LANE && inspectedNotePair) {
      setPolyPressureNote(inspectedNotePair.noteNumber);
    }
  }, [inspectedNotePair, selectedCC]);

  useEffect(() => {
    ccDrawStateRef.current = null;
    setCCDrawState(null);
  }, [selectedCC]);

  const editInspectedNote = useCallback((field: "note" | "start" | "duration" | "velocity", value: number) => {
    if (!inspectedNotePair) return;
    const id = noteIdFor(clipId, inspectedNotePair.startTime, inspectedNotePair.noteNumber);
    if (field === "note") {
      const nextNote = clamp(Math.round(value), 0, 127);
      const ids = moveMIDINotes(trackId, clipId, [id], 0, nextNote - inspectedNotePair.noteNumber);
      setSelectedNoteIds(ids);
      return;
    }
    if (field === "start") {
      const nextStart = Math.max(0, value);
      const ids = moveMIDINotes(trackId, clipId, [id], nextStart - inspectedNotePair.startTime, 0);
      setSelectedNoteIds(ids);
      return;
    }
    if (field === "duration") {
      const ids = resizeMIDINote(trackId, clipId, id, inspectedNotePair.startTime, Math.max(0.01, value));
      setSelectedNoteIds(ids);
      return;
    }
    setSelectedMIDINoteVelocity(trackId, clipId, clamp(Math.round(value), 1, 127));
  }, [
    clipId,
    inspectedNotePair,
    moveMIDINotes,
    resizeMIDINote,
    setSelectedMIDINoteVelocity,
    setSelectedNoteIds,
    trackId,
  ]);

  const editInspectedNoteMetadata = useCallback((
    field: "channel" | "releaseVelocity" | "chance" | "playCount" | "velocityVariance" | "centOffset",
    value: number,
  ) => {
    if (selectedPairs.length === 0) return;

    const oldEvents = getLatestClipEvents();
    const nextEvents = sortEvents(oldEvents.map((event) => {
      const matchedPair = selectedPairs.find((pair) => {
        const noteChannel = pair.channel ?? 1;
        const sameNote = event.note === pair.noteNumber && (event.channel ?? 1) === noteChannel;
        if (!sameNote) return false;
        if (event.type === "noteOn") return Math.abs(event.timestamp - pair.startTime) < 0.000001;
        if (event.type === "noteOff") return Math.abs(event.timestamp - (pair.startTime + pair.duration)) < 0.000001;
        return false;
      });
      if (!matchedPair) return event;

      if (event.type === "noteOn") {
        if (field === "channel") return { ...event, channel: clamp(Math.round(value), 1, 16) };
        if (field === "chance") {
          const nextEvent: MIDIEvent = { ...event, probability: clamp(value / 100, 0, 1) };
          delete nextEvent.chance;
          return nextEvent;
        }
        if (field === "playCount") return { ...event, playCount: Math.max(0, Math.round(value)) };
        if (field === "velocityVariance") return { ...event, velocityVariance: clamp(Math.round(value), 0, 127) };
        if (field === "centOffset") return { ...event, centOffset: clamp(value, -100, 100) };
      }

      if (event.type === "noteOff") {
        if (field === "channel") return { ...event, channel: clamp(Math.round(value), 1, 16) };
        if (field === "releaseVelocity") {
          const releaseVelocity = clamp(Math.round(value), 0, 127);
          return { ...event, velocity: releaseVelocity, releaseVelocity };
        }
      }

      return event;
    }));

    commitMIDIClipEvents(trackId, clipId, oldEvents, nextEvents, "Edit MIDI note metadata");
  }, [
    clipId,
    commitMIDIClipEvents,
    getLatestClipEvents,
    selectedPairs,
    trackId,
  ]);

  const openTransformDialog = (dialog: TransformDialogState) => {
    setTransformDialog(dialog);
    setContextMenu(null);
  };

  const openQuantizePanel = useCallback((overrides: Partial<Extract<TransformDialogState, { type: "quantize" }>> = {}) => {
    const preset = activeQuantizePreset;
    const panelGridSize = overrides.gridSize ?? preset.gridSize;
    const panelGridSeconds = calculateGridInterval(tempo, timeSignature, panelGridSize, {
      quantizePreset: preset,
      quantizeGridSize: preset.gridSize,
      pixelsPerSecond,
    });
    openTransformDialog({
      type: "quantize",
      value: panelGridSeconds,
      gridSize: panelGridSize,
      strength: overrides.strength ?? preset.strength,
      mode: overrides.mode ?? "start",
      swing: overrides.swing ?? preset.swing,
      groovePreset: overrides.groovePreset ?? preset.groovePreset,
      tupletDivisions: overrides.tupletDivisions ?? preset.tupletDivisions,
      catchRangeTicks: overrides.catchRangeTicks ?? preset.catchRangeTicks,
      safeRangeTicks: overrides.safeRangeTicks ?? preset.safeRangeTicks,
      roughTicks: overrides.roughTicks ?? preset.roughTicks,
      fixedLength: overrides.fixedLength ?? panelGridSeconds,
      fixedLengthGridSize: overrides.fixedLengthGridSize ?? "quantize_link",
      moveControllers: overrides.moveControllers ?? preset.moveControllers,
      autoApply: overrides.autoApply ?? false,
    });
  }, [activeQuantizePreset, pixelsPerSecond, tempo, timeSignature]);

  const applyCurrentQuantizePreset = useCallback((mode: QuantizeMode = "start") => {
    const preset = activeQuantizePreset;
    const gridSeconds = calculateGridInterval(tempo, timeSignature, preset.gridSize, {
      quantizePreset: preset,
      quantizeGridSize: preset.gridSize,
      pixelsPerSecond,
    });
    const nextIds = quantizeSelectedMIDINotes(trackId, clipId, gridSeconds, preset.strength, {
      presetId: preset.id,
      gridSize: preset.gridSize,
      mode,
      swing: preset.swing,
      groovePreset: preset.groovePreset,
      tupletDivisions: preset.tupletDivisions,
      catchRangeMs: ticksToSeconds(preset.catchRangeTicks, tempo) * 1000,
      safeRangeMs: ticksToSeconds(preset.safeRangeTicks, tempo) * 1000,
      randomizeMs: ticksToSeconds(preset.roughTicks, tempo) * 1000,
      fixedLength: mode === "length" ? gridSeconds : undefined,
      moveControllers: preset.moveControllers,
    });
    if (nextIds.length > 0) setSelectedNoteIds(nextIds);
  }, [
    activeQuantizePreset,
    clipId,
    pixelsPerSecond,
    quantizeSelectedMIDINotes,
    setSelectedNoteIds,
    tempo,
    timeSignature,
    trackId,
  ]);

  const buildPianoRollContextMenuItems = (menu: NonNullable<PianoRollContextMenuState>): MenuItem[] => {
    const hasSelection = selectedNoteIds.length > 0;
    const hasRange = !!midiEditRange;
    const hasRangeClipboard = midiRangeClipboard.rangeLength > 0;
    const pasteTime = menu.time ?? 0;
    const selectedPitch = menu.noteNumber ?? selectedPairs[0]?.noteNumber ?? 60;
    return [
      ...(menu.kind === "grid" || menu.kind === "range"
        ? [
            {
              label: "Paste Here",
              shortcut: shortcut("midi.pasteSelection", "Ctrl+V"),
              disabled: !midiNoteClipboard.notes.length && !hasRangeClipboard,
              onClick: () => {
                if (hasRangeClipboard) pasteMIDIRange(trackId, clipId, pasteTime);
                else pasteMIDINotes(trackId, clipId, pasteTime);
              },
            },
            {
              label: "Insert Note",
              onClick: () => {
                const id = addMIDINote(trackId, clipId, pasteTime, selectedPitch, snapDuration, pianoRollInsertVelocity);
                if (id) setSelectedNoteIds([id]);
              },
            },
            {
              label: "Insert Chord",
              submenu: [
                { label: "Diatonic Triad", onClick: () => insertMIDIChord(trackId, clipId, pasteTime, selectedPitch, "diatonic") },
                { label: "Major", onClick: () => insertMIDIChord(trackId, clipId, pasteTime, selectedPitch, "major") },
                { label: "Minor", onClick: () => insertMIDIChord(trackId, clipId, pasteTime, selectedPitch, "minor") },
                { label: "Power", onClick: () => insertMIDIChord(trackId, clipId, pasteTime, selectedPitch, "power") },
              ],
            },
            { divider: true, label: "" },
            {
              label: "Select Notes in Region",
              onClick: () => selectMIDINotesInRange(clipId, {
                startTime: Math.max(0, pasteTime - snapDuration),
                endTime: Math.max(0, pasteTime + snapDuration),
                minNote: selectedPitch - 6,
                maxNote: selectedPitch + 6,
              }),
            },
            { label: "Cut Region", disabled: !hasRange && !hasSelection, onClick: () => hasRange ? cutMIDIRange(trackId, clipId) : cutSelectedMIDINotes(trackId, clipId) },
            { label: "Copy Region", disabled: !hasRange && !hasSelection, onClick: () => hasRange ? copyMIDIRange(trackId, clipId) : copySelectedMIDINotes(trackId, clipId) },
            {
              label: "Delete Region",
              disabled: !hasRange && !hasSelection,
              onClick: () => {
                if (hasRange) {
                  deleteMIDIRange(trackId, clipId);
                } else {
                  removeMIDINotes(trackId, clipId, selectedNoteIds);
                  setSelectedNoteIds([]);
                }
              },
            },
            { label: "Duplicate Region", disabled: !hasRange, onClick: () => duplicateMIDIRange(trackId, clipId) },
            {
              label: "Repeat Region",
              disabled: !hasRange,
              onClick: () => {
                repeatMIDISelection(trackId, clipId);
              },
            },
            {
              label: "Crop Clip to Region",
              disabled: selectedPairs.length === 0,
              onClick: () => cropMIDIClipToSelectedNotes(trackId, clipId),
            },
            {
              label: "Set Loop to Region",
              disabled: selectedPairs.length === 0,
              onClick: () => {
                const start = Math.min(...selectedPairs.map((pair) => pair.startTime));
                const end = Math.max(...selectedPairs.map((pair) => pair.startTime + pair.duration));
                useDAWStore.getState().setLoopRegion(clipStartTime + start, clipStartTime + end);
              },
            },
          ]
        : [
            { label: "Cut Notes", shortcut: shortcut("midi.cutSelection", "Ctrl+X"), disabled: !hasSelection, onClick: () => cutSelectedMIDINotes(trackId, clipId) },
            { label: "Copy Notes", shortcut: shortcut("midi.copySelection", "Ctrl+C"), disabled: !hasSelection, onClick: () => copySelectedMIDINotes(trackId, clipId) },
            { label: "Paste Notes", shortcut: shortcut("midi.pasteSelection", "Ctrl+V"), disabled: !midiNoteClipboard.notes.length && !hasRangeClipboard, onClick: () => hasRangeClipboard ? pasteMIDIRange(trackId, clipId, pasteTime) : pasteMIDINotes(trackId, clipId, pasteTime) },
            { label: "Duplicate Notes", shortcut: shortcut("midi.duplicateSelection", "Ctrl+D"), disabled: !hasSelection, onClick: () => duplicateSelectedMIDINotes(trackId, clipId) },
            {
              label: "Delete Notes",
              shortcut: shortcut("midi.deleteSelection", "Del"),
              disabled: !hasSelection,
              onClick: () => {
                removeMIDINotes(trackId, clipId, selectedNoteIds);
                setSelectedNoteIds([]);
              },
            },
            { divider: true, label: "" },
            { label: "Select All Notes", shortcut: shortcut("midi.selectAll", "Ctrl+A"), onClick: selectAllMIDINotes },
            { label: "Invert Selection", onClick: () => invertMIDISelection(clipId) },
            { label: "Select Same Pitch", onClick: () => selectMIDINotesByPitch(clipId, menu.noteNumber) },
          ]),
      { divider: true, label: "" },
      { label: "Quantize...", disabled: !hasSelection, onClick: () => openQuantizePanel() },
      { label: "Humanize...", disabled: !hasSelection, onClick: () => openTransformDialog({ type: "humanize", timingMs: 10, velocity: 5 }) },
      {
        label: "Transpose",
        disabled: !hasSelection,
        submenu: [
          { label: "Up Semitone", onClick: () => { const ids = moveMIDINotes(trackId, clipId, selectedNoteIds, 0, 1); setSelectedNoteIds(ids); } },
          { label: "Down Semitone", onClick: () => { const ids = moveMIDINotes(trackId, clipId, selectedNoteIds, 0, -1); setSelectedNoteIds(ids); } },
          { label: "Up Octave", onClick: () => { const ids = moveMIDINotes(trackId, clipId, selectedNoteIds, 0, 12); setSelectedNoteIds(ids); } },
          { label: "Down Octave", onClick: () => { const ids = moveMIDINotes(trackId, clipId, selectedNoteIds, 0, -12); setSelectedNoteIds(ids); } },
        ],
      },
      {
        label: "Velocity",
        disabled: !hasSelection,
        submenu: [
          { label: "Set...", onClick: () => openTransformDialog({ type: "velocity", value: 80 }) },
          { label: "+10%", onClick: () => scaleSelectedMIDINoteVelocity(trackId, clipId, 1.1) },
          { label: "-10%", onClick: () => scaleSelectedMIDINoteVelocity(trackId, clipId, 0.9) },
          { label: "Randomize...", onClick: () => openTransformDialog({ type: "randomVelocity", amount: 8 }) },
        ],
      },
      { label: "Set Length...", disabled: !hasSelection, onClick: () => openTransformDialog({ type: "length", value: snapDuration }) },
      { label: "Legato", disabled: !hasSelection, onClick: () => legatoSelectedMIDINotes(trackId, clipId) },
      { label: "Reverse Timing", disabled: !hasSelection, onClick: () => reverseSelectedMIDINotes(trackId, clipId) },
      { label: "Invert Pitches", disabled: !hasSelection, onClick: () => invertSelectedMIDINotePitches(trackId, clipId) },
      { label: "Mirror Around Note...", disabled: !hasSelection, onClick: () => openTransformDialog({ type: "mirror", centerNote: selectedPitch }) },
      { label: selectedMuted ? "Unmute Notes" : "Mute Notes", disabled: !hasSelection, onClick: () => toggleSelectedMIDINoteMute(trackId, clipId) },
      { label: "Note Properties...", disabled: !hasSelection, onClick: () => openTransformDialog({ type: "velocity", value: selectedPairs[0]?.velocity ?? 80 }) },
    ];
  };

  const applyQuantizeDialogSettings = useCallback((settings: Extract<TransformDialogState, { type: "quantize" }>) => {
    const quantizeGridSeconds = calculateGridInterval(tempo, timeSignature, settings.gridSize, {
      quantizePreset: activeQuantizePreset,
      quantizeGridSize: activeQuantizePreset.gridSize,
      pixelsPerSecond,
    });
    const fixedLengthSeconds = settings.fixedLengthGridSize === "quantize_link"
      ? quantizeGridSeconds
      : calculateGridInterval(tempo, timeSignature, settings.fixedLengthGridSize, {
          quantizePreset: activeQuantizePreset,
          quantizeGridSize: activeQuantizePreset.gridSize,
          pixelsPerSecond,
        });
    const nextIds = quantizeSelectedMIDINotes(trackId, clipId, quantizeGridSeconds, settings.strength, {
      presetId: activeQuantizePreset.id,
      gridSize: settings.gridSize,
      mode: settings.mode,
      swing: settings.swing,
      groovePreset: settings.groovePreset,
      tupletDivisions: settings.tupletDivisions,
      catchRangeMs: ticksToSeconds(settings.catchRangeTicks, tempo) * 1000,
      safeRangeMs: ticksToSeconds(settings.safeRangeTicks, tempo) * 1000,
      randomizeMs: ticksToSeconds(settings.roughTicks, tempo) * 1000,
      fixedLength: settings.mode === "length" ? fixedLengthSeconds : undefined,
      moveControllers: settings.moveControllers,
    });
    if (nextIds.length > 0) setSelectedNoteIds(nextIds);
  }, [
    activeQuantizePreset,
    clipId,
    pixelsPerSecond,
    quantizeSelectedMIDINotes,
    setSelectedNoteIds,
    tempo,
    timeSignature,
    trackId,
  ]);

  useEffect(() => {
    if (transformDialog?.type !== "quantize" || !transformDialog.autoApply) return undefined;
    const timeoutId = window.setTimeout(() => applyQuantizeDialogSettings(transformDialog), 250);
    return () => window.clearTimeout(timeoutId);
  }, [applyQuantizeDialogSettings, transformDialog]);

  const applyTransformDialog = () => {
    if (!transformDialog) return;
    if (transformDialog.type === "quantize") {
      applyQuantizeDialogSettings(transformDialog);
    } else if (transformDialog.type === "humanize") {
      humanizeSelectedMIDINotes(trackId, clipId, { timingMs: transformDialog.timingMs, velocity: transformDialog.velocity });
    } else if (transformDialog.type === "velocity") {
      setSelectedMIDINoteVelocity(trackId, clipId, transformDialog.value);
    } else if (transformDialog.type === "randomVelocity") {
      randomizeSelectedMIDINoteVelocity(trackId, clipId, transformDialog.amount);
    } else if (transformDialog.type === "length") {
      setSelectedMIDINoteLength(trackId, clipId, transformDialog.value);
    } else if (transformDialog.type === "mirror") {
      mirrorSelectedMIDINotePitches(trackId, clipId, transformDialog.centerNote);
    }
    setTransformDialog(null);
  };

  return (
    <div
      className="piano-roll"
      ref={containerRef}
      onPointerDownCapture={() => activateShortcutContext(pianoShortcutContext)}
      onContextMenuCapture={() => activateShortcutContext(pianoShortcutContext)}
      onFocusCapture={() => activateShortcutContext(pianoShortcutContext)}
      data-shortcut-context={`piano_roll:${shortcutSessionId}`}
    >
      <PianoRollToolbar
        ref={toolbarRef}
        tool={tool}
        onToolChange={setTool}
        scaleRoot={scaleRoot}
        scaleType={scaleType}
        onScaleRootChange={setPianoRollScaleRoot}
        onScaleTypeChange={setPianoRollScaleType}
        selectedCount={selectedPairs.length}
        noteCount={notePairs.length}
        onSnapSelectedToScale={() => snapSelectedMIDINotesToScale(trackId, clipId, scaleRoot, scaleType)}
        auditionEnabled={pianoRollAuditionEnabled}
        onAuditionEnabledChange={setPianoRollAuditionEnabled}
        insertVelocity={pianoRollInsertVelocity}
        onInsertVelocityChange={setPianoRollInsertVelocity}
        stepInputEnabled={stepInputEnabled}
        onToggleStepInput={toggleStepInput}
        stepInputSize={stepInputSize}
        stepSizeOptions={STEP_SIZE_OPTIONS}
        onStepInputSizeChange={setStepInputSize}
        clipOptions={trackMIDIClipOptions}
        activeClipId={clipId}
        onActiveClipChange={(nextClipId) => openPianoRoll(trackId, nextClipId)}
        showSelectedMIDIClipRefs={showSelectedMIDIClipRefs}
        onShowSelectedMIDIClipRefsChange={setShowSelectedMIDIClipRefs}
        showGhostMIDIClips={showGhostMIDIClips}
        onShowGhostMIDIClipsChange={setShowGhostMIDIClips}
        visibleLanes={visibleLanes}
        activeLaneId={activeLane?.id}
        onActiveLaneChange={(laneId) => {
          const lane = visibleLanes.find((candidate) => candidate.id === laneId);
          if (lane) selectControllerLane(lane);
        }}
        snapEnabled={snapEnabled}
        onSnapToggle={toggleSnap}
        snapType={snapType}
        onSnapTypeChange={setSnapType}
        gridSize={gridSize}
        onGridSizeChange={setGridSize}
        gridTypeOptions={GRID_TYPE_MODE_OPTIONS}
        quantizePresetId={quantizePresetId}
        quantizePresets={quantizePresets}
        onQuantizePresetChange={setQuantizePresetId}
        onApplyQuantize={() => applyCurrentQuantizePreset("start")}
        onLengthQuantize={() => applyCurrentQuantizePreset("length")}
        onQuantizeLast={() => {
          const nextIds = quantizeSelectedMIDINotesUsingLast(trackId, clipId);
          if (nextIds.length > 0) setSelectedNoteIds(nextIds);
        }}
        onOpenQuantizeDialog={() => openQuantizePanel()}
        onResetQuantize={() => resetMIDIQuantize(trackId, clipId)}
        onFreezeQuantize={() => freezeMIDIQuantize(trackId, clipId)}
        onDetach={!isDetached ? onDetach : undefined}
      />

      <PianoRollInfoLine
        typeLabel={inspectedNotePair ? "Note" : selectedPairs.length > 1 ? "Notes" : "Clip"}
        startLabel={inspectedNotePair ? inspectedNotePair.startTime.toFixed(3) : (pianoRollEditCursorTime?.toFixed(3) ?? "--")}
        lengthLabel={inspectedNotePair ? inspectedNotePair.duration.toFixed(3) : clipDuration.toFixed(3)}
        valueLabel={selectedVelocityValue || "--"}
        channelLabel={selectedChannelValue || "--"}
        chanceLabel={selectedChanceValue || "--"}
        laneLabel={controllerLaneLabel}
        curveLabel={activeLane?.interpolation ?? "linear"}
      />

      <div className="piano-roll-toolbar" aria-hidden="true" style={{ display: "none" }}>
        <Button variant="default" size="sm" active={tool === "draw"} onClick={() => setTool("draw")} title="Draw Tool (D)">
          Draw
        </Button>
        <Button variant="default" size="sm" active={tool === "select"} onClick={() => setTool("select")} title="Select Tool (V)">
          Select
        </Button>
        <Button variant="default" size="sm" active={tool === "erase"} onClick={() => setTool("erase")} title="Erase Tool (E)">
          Erase
        </Button>
        <Button variant="default" size="sm" active={tool === "range"} onClick={() => setTool("range")} title="Range Tool">
          Range
        </Button>
        {selectedPairs.length > 0 && (
          <>
            <div className="toolbar-divider" />
            {inspectedNotePair ? (
              <>
                <label htmlFor="pr-note-pitch">Note</label>
                <input
                  id="pr-note-pitch"
                  className="piano-roll-number"
                  type="number"
                  min={0}
                  max={127}
                  value={inspectedNotePair.noteNumber}
                  onChange={(event) => editInspectedNote("note", Number(event.target.value))}
                />
                <label htmlFor="pr-note-start">Start</label>
                <input
                  id="pr-note-start"
                  className="piano-roll-number"
                  type="number"
                  min={0}
                  step={snapDuration}
                  value={Number(inspectedNotePair.startTime.toFixed(3))}
                  onChange={(event) => editInspectedNote("start", Number(event.target.value))}
                />
                <label htmlFor="pr-note-length">Len</label>
                <input
                  id="pr-note-length"
                  className="piano-roll-number"
                  type="number"
                  min={0.01}
                  step={snapDuration}
                  value={Number(inspectedNotePair.duration.toFixed(3))}
                  onChange={(event) => editInspectedNote("duration", Number(event.target.value))}
                />
                <label htmlFor="pr-note-velocity">Vel</label>
                <input
                  id="pr-note-velocity"
                  className="piano-roll-number"
                  type="number"
                  min={1}
                  max={127}
                  value={inspectedNotePair.velocity}
                  onChange={(event) => editInspectedNote("velocity", Number(event.target.value))}
                />
                <label htmlFor="pr-note-release-velocity">Off</label>
                <input
                  id="pr-note-release-velocity"
                  className="piano-roll-number"
                  type="number"
                  min={0}
                  max={127}
                  value={inspectedNotePair.releaseVelocity ?? inspectedNotePair.noteOff.velocity ?? 0}
                  onChange={(event) => editInspectedNoteMetadata("releaseVelocity", Number(event.target.value))}
                />
                <label htmlFor="pr-note-channel">Ch</label>
                <input
                  id="pr-note-channel"
                  className="piano-roll-number"
                  type="number"
                  min={1}
                  max={16}
                  value={inspectedNotePair.channel ?? 1}
                  onChange={(event) => editInspectedNoteMetadata("channel", Number(event.target.value))}
                />
                <label htmlFor="pr-note-chance">Chance</label>
                <input
                  id="pr-note-chance"
                  className="piano-roll-number"
                  type="number"
                  min={0}
                  max={100}
                  value={inspectedChancePercent}
                  onChange={(event) => editInspectedNoteMetadata("chance", Number(event.target.value))}
                />
                <label htmlFor="pr-note-play-count">Plays</label>
                <input
                  id="pr-note-play-count"
                  className="piano-roll-number"
                  type="number"
                  min={0}
                  max={64}
                  value={inspectedNotePair.playCount ?? 0}
                  onChange={(event) => editInspectedNoteMetadata("playCount", Number(event.target.value))}
                />
                <label htmlFor="pr-note-velocity-variance">Var</label>
                <input
                  id="pr-note-velocity-variance"
                  className="piano-roll-number"
                  type="number"
                  min={0}
                  max={127}
                  value={inspectedNotePair.velocityVariance ?? 0}
                  onChange={(event) => editInspectedNoteMetadata("velocityVariance", Number(event.target.value))}
                />
                <label htmlFor="pr-note-cent-offset">Cent</label>
                <input
                  id="pr-note-cent-offset"
                  className="piano-roll-number"
                  type="number"
                  min={-100}
                  max={100}
                  value={inspectedNotePair.centOffset ?? 0}
                  onChange={(event) => editInspectedNoteMetadata("centOffset", Number(event.target.value))}
                />
              </>
            ) : (
              <span className="piano-roll-selection-count">{selectedPairs.length} notes</span>
            )}
          </>
        )}
        <div className="toolbar-divider" />
        <label htmlFor="pr-root">Root</label>
        <select id="pr-root" className="piano-roll-select" value={scaleRoot} onChange={(event) => setPianoRollScaleRoot(Number.parseInt(event.target.value, 10))}>
          {NOTE_NAMES.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <label htmlFor="pr-scale">Scale</label>
        <select id="pr-scale" className="piano-roll-select" value={scaleType} onChange={(event) => setPianoRollScaleType(event.target.value)}>
          {Object.entries(SCALE_DISPLAY_NAMES).map(([key, displayLabel]) => (
            <option key={key} value={key}>{displayLabel}</option>
          ))}
        </select>
        <Button
          variant="default"
          size="sm"
          disabled={selectedPairs.length === 0 || scaleType === "chromatic"}
          onClick={() => snapSelectedMIDINotesToScale(trackId, clipId, scaleRoot, scaleType)}
          title="Snap selected notes to the active scale"
        >
          Snap Sel
        </Button>
        <div className="toolbar-divider" />
        <label htmlFor="pr-cc">CC</label>
        <select ref={controllerLaneSelectorRef} id="pr-cc" className="piano-roll-select" value={selectedCC} onChange={(event) => {
          const nextCC = Number.parseInt(event.target.value, 10);
          setSelectedCC(nextCC);
          if (nextCC < 0 || nextCC > 31) setCC14BitMode(false);
        }}>
          {CC_PRESETS.map((preset) => (
            <option key={preset.cc} value={preset.cc}>{preset.name}</option>
          ))}
          {!CC_PRESETS.some((preset) => preset.cc === selectedCC) && (
            <option value={selectedCC}>CC#{selectedCC}</option>
          )}
        </select>
        {selectedCC >= 0 && (
          <>
            <input
              className="piano-roll-number"
              type="number"
              min={0}
              max={127}
              value={selectedCC}
              onChange={(event) => {
                const nextCC = clamp(Number.parseInt(event.target.value, 10) || 0, 0, 127);
                setSelectedCC(nextCC);
                if (nextCC > 31) setCC14BitMode(false);
              }}
              title="Controller number"
            />
            <label className="piano-roll-checkbox" title="Use 14-bit MSB/LSB CC pairs">
              <input
                type="checkbox"
                checked={isCC14BitMode}
                disabled={selectedCC < 0 || selectedCC > 31}
                onChange={(event) => setCC14BitMode(event.target.checked)}
              />
              14-bit
            </label>
          </>
        )}
        {selectedCC === POLY_PRESSURE_LANE && (
          <>
            <label htmlFor="pr-poly-pressure-note">Note</label>
            <input
              id="pr-poly-pressure-note"
              className="piano-roll-number"
              type="number"
              min={0}
              max={127}
              value={polyPressureNote}
              onChange={(event) => setPolyPressureNote(clamp(Number.parseInt(event.target.value, 10) || 0, 0, 127))}
              title="Poly pressure note number"
            />
            {inspectedNotePair && (
              <Button
                variant="default"
                size="sm"
                onClick={() => setPolyPressureNote(inspectedNotePair.noteNumber)}
                title="Use the selected note for the poly pressure lane"
              >
                Sel Note
              </Button>
            )}
          </>
        )}
        {selectedCC === PITCH_BEND_LANE && (
          <>
            <label htmlFor="pr-pitch-bend-up">PB Up</label>
            <input
              id="pr-pitch-bend-up"
              className="piano-roll-number"
              type="number"
              min={1}
              max={24}
              step={1}
              value={pitchBendRangeUp}
              onChange={(event) => {
                const nextUp = clamp(Number.parseInt(event.target.value, 10) || DEFAULT_PITCH_BEND_RANGE_SEMITONES, 1, 24);
                setTrackMidiPitchBendRange(trackId, nextUp, pitchBendRangeLinked ? nextUp : pitchBendRangeDown, pitchBendRangeLinked);
              }}
              title="Pitch bend up range"
            />
            {!pitchBendRangeLinked && (
              <>
                <label htmlFor="pr-pitch-bend-down">Down</label>
                <input
                  id="pr-pitch-bend-down"
                  className="piano-roll-number"
                  type="number"
                  min={1}
                  max={24}
                  step={1}
                  value={pitchBendRangeDown}
                  onChange={(event) => {
                    const nextDown = clamp(Number.parseInt(event.target.value, 10) || DEFAULT_PITCH_BEND_RANGE_SEMITONES, 1, 24);
                    setTrackMidiPitchBendRange(trackId, pitchBendRangeUp, nextDown, false);
                  }}
                  title="Pitch bend down range"
                />
              </>
            )}
            <label className="piano-roll-checkbox" title="Link pitch bend up/down ranges">
              <input
                type="checkbox"
                checked={pitchBendRangeLinked}
                onChange={(event) => setTrackMidiPitchBendRange(
                  trackId,
                  pitchBendRangeUp,
                  event.target.checked ? pitchBendRangeUp : pitchBendRangeDown,
                  event.target.checked,
                )}
              />
              Link
            </label>
            <label className="piano-roll-checkbox" title="Snap drawn pitch bend points to semitone values">
              <input
                type="checkbox"
                checked={snapPitchBendSemitones}
                onChange={(event) => setSnapPitchBendSemitones(event.target.checked)}
              />
              Snap
            </label>
          </>
        )}
        <div className="toolbar-divider" />
        <label htmlFor="pr-vel-lane-height">Vel H</label>
        <ProfiledRangeInput
          id="pr-vel-lane-height"
          min={40}
          max={140}
          value={velocityLaneHeight}
          onValueChange={(value) => setVelocityLaneHeight(clamp(value, 40, 140))}
          className="zoom-slider"
          title="Velocity lane height"
        />
        <label htmlFor="pr-cc-lane-height">CC H</label>
        <ProfiledRangeInput
          id="pr-cc-lane-height"
          min={48}
          max={180}
          value={ccLaneHeight}
          onValueChange={(value) => setCCLaneHeight(clamp(value, 48, 180))}
          className="zoom-slider"
          title="Controller lane height"
        />
        <div className="toolbar-divider" />
        <div ref={transformMenuRef} style={{ position: "relative", display: "inline-block" }}>
          <Button variant="default" size="sm" onClick={() => setShowTransformMenu((value) => !value)} title="MIDI Transform">
            Transform
          </Button>
          {showTransformMenu && (
            <div className="piano-roll-transform-menu">
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, 1); setShowTransformMenu(false); }}>Transpose Up (+1)</button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, -1); setShowTransformMenu(false); }}>Transpose Down (-1)</button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, 12); setShowTransformMenu(false); }}>Transpose Octave Up (+12)</button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, -12); setShowTransformMenu(false); }}>Transpose Octave Down (-12)</button>
              <button className="piano-roll-transform-item" onClick={() => { snapSelectedMIDINotesToScale(trackId, clipId, scaleRoot, scaleType); setShowTransformMenu(false); }}>Snap Selected to Scale</button>
              <div className="piano-roll-transform-separator" />
              <button className="piano-roll-transform-item" onClick={() => { scaleMIDINoteVelocity(clipId, 1.1); setShowTransformMenu(false); }}>Velocity +10%</button>
              <button className="piano-roll-transform-item" onClick={() => { scaleMIDINoteVelocity(clipId, 0.9); setShowTransformMenu(false); }}>Velocity -10%</button>
              <div className="piano-roll-transform-separator" />
              <button className="piano-roll-transform-item" onClick={openControllerLineDialog}>Controller Ramp / Step / Curve...</button>
              <button className="piano-roll-transform-item" onClick={() => openControllerLFODialog("sine")}>Controller Sine LFO...</button>
              <button className="piano-roll-transform-item" onClick={() => openControllerLFODialog("triangle")}>Controller Triangle LFO...</button>
              <button className="piano-roll-transform-item" onClick={() => openControllerLFODialog("square")}>Controller Square LFO...</button>
              <button className="piano-roll-transform-item" onClick={() => openControllerLFODialog("sawUp")}>Controller Saw Up LFO...</button>
              <button className="piano-roll-transform-item" onClick={() => openControllerLFODialog("sawDown")}>Controller Saw Down LFO...</button>
              <button className="piano-roll-transform-item" onClick={openControllerTransformDialog}>Scale / Tilt / Stretch Controller...</button>
              <button className="piano-roll-transform-item" onClick={openControllerThinDialog}>Thin Controller Data...</button>
              <button className="piano-roll-transform-item" onClick={copyCurrentControllerLane}>Copy Controller Lane</button>
              <button className="piano-roll-transform-item" onClick={pasteControllerLaneClipboard} disabled={!controllerLaneClipboard}>
                {controllerLaneClipboard ? `Paste ${controllerLaneClipboard.sourceLabel}` : "Paste Controller Lane"}
              </button>
              <button className="piano-roll-transform-item" onClick={clearCurrentControllerLane}>Clear Controller Lane</button>
              <div className="piano-roll-transform-separator" />
              <button className="piano-roll-transform-item" onClick={() => { reverseMIDINotes(clipId); setShowTransformMenu(false); }}>Reverse</button>
              <button className="piano-roll-transform-item" onClick={() => { invertMIDINotes(clipId); setShowTransformMenu(false); }}>Invert</button>
              <div className="piano-roll-transform-separator" />
              <button className="piano-roll-transform-item" onClick={() => { quantizeSelectedMIDINotesUsingLast(trackId, clipId); setShowTransformMenu(false); }}>Quantize Last Settings</button>
              <button className="piano-roll-transform-item" onClick={() => { resetMIDIQuantize(trackId, clipId); setShowTransformMenu(false); }}>Reset Quantize</button>
              <button className="piano-roll-transform-item" onClick={() => { freezeMIDIQuantize(trackId, clipId); setShowTransformMenu(false); }}>Freeze Quantize</button>
            </div>
          )}
        </div>
        <div className="toolbar-divider" />
        <Button variant={stepInputEnabled ? "primary" : "default"} size="sm" active={stepInputEnabled} onClick={toggleStepInput} title="Step Input Mode - type C-B to enter notes">
          Step
        </Button>
        {stepInputEnabled && (
          <>
            <label htmlFor="pr-step-size">Size</label>
            <select id="pr-step-size" className="piano-roll-select" value={stepInputSize} onChange={(event) => setStepInputSize(Number.parseFloat(event.target.value))}>
              {STEP_SIZE_OPTIONS.map((option) => (
                <option key={option.label} value={option.beats}>{option.label}</option>
              ))}
            </select>
            <span className="piano-roll-step-octave">Oct: {stepInputOctave}</span>
          </>
        )}
        {trackMIDIClipOptions.length > 1 && (
          <>
            <div className="toolbar-divider" />
            <label htmlFor="pr-active-midi-clip">Clip</label>
            <select
              id="pr-active-midi-clip"
              className="piano-roll-select piano-roll-clip-select"
              value={clipId}
              onChange={(event) => openPianoRoll(trackId, event.target.value)}
              title="Choose the active editable MIDI clip"
            >
              {trackMIDIClipOptions.map((option, index) => (
                <option key={option.id} value={option.id}>
                  {option.name || `MIDI Clip ${index + 1}`}
                </option>
              ))}
            </select>
            <label className="piano-roll-checkbox" title="Show selected MIDI clips from this track as colored references. Click a reference note to make that clip editable.">
              <input
                type="checkbox"
                checked={showSelectedMIDIClipRefs}
                onChange={(event) => setShowSelectedMIDIClipRefs(event.target.checked)}
              />
              Refs
            </label>
            <label className="piano-roll-checkbox" title="Show other MIDI clips on this track as grey ghost notes">
              <input
                type="checkbox"
                checked={showGhostMIDIClips}
                onChange={(event) => setShowGhostMIDIClips(event.target.checked)}
              />
              Ghost
            </label>
          </>
        )}
        {additionalClipIds.length > 0 && (
          <>
            <span className="piano-roll-multi-clip">
              {showSelectedMIDIClipRefs ? `Refs ${additionalClips.length}` : "Refs hidden"}
            </span>
          </>
        )}
      </div>

      <div
        className="piano-roll-workspace"
        style={{ gridTemplateColumns: `${sidebarWidth}px ${TIMELINE_DIVIDER_WIDTH}px minmax(0, 1fr)` }}
      >
        <div
          className="piano-roll-left-panel"
          data-qa="piano-roll-left-sidebar"
          style={{ gridTemplateColumns: `minmax(0, 1fr) ${pianoKeyStripWidth}px` }}
        >
        <aside
          className="piano-roll-inspector piano-roll-sidebar"
          aria-label="Piano roll inspector"
          data-qa="piano-roll-left-inspector"
        >
          <section className="piano-roll-inspector-section piano-roll-source-section" data-qa="piano-roll-source-header">
            <div className="piano-roll-section-title">
              <span className="piano-roll-panel-title">Source</span>
              <span className="piano-roll-source-clip">{clip.name || "MIDI Clip"}</span>
            </div>
            <div className="piano-roll-source-grid">
              <label htmlFor="pr-source-length">Source</label>
              <input
                id="pr-source-length"
                data-qa="piano-roll-source-length-input"
                type="number"
                min={0.01}
                step={snapDuration}
                value={sourceLengthDraft}
                onChange={(event) => setSourceLengthDraft(event.target.value)}
                onBlur={commitSourceLengthDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    setSourceLengthDraft(formatSeconds(sourceLength));
                    event.currentTarget.blur();
                  }
                }}
              />
              <span>Item</span>
              <strong data-qa="piano-roll-item-length-readout">{formatSeconds(clip.duration)}s</strong>
            </div>
            <div className="piano-roll-source-actions">
              <button
                type="button"
                onClick={() => applySourceLength(clip.duration, "Set MIDI source length to item")}
                data-qa="piano-roll-source-item"
                title="Set MIDI source length to the visible item length"
                data-tooltip="Set source length to item length"
                aria-label="Set MIDI source length to item length"
              >
                Source = Item
              </button>
              <button
                type="button"
                onClick={() => applySourceLength(eventContentLength, "Set MIDI source length to content")}
                data-qa="piano-roll-source-content"
                title="Set MIDI source length to the end of the MIDI content"
                data-tooltip="Set source length to MIDI content"
                aria-label="Set MIDI source length to MIDI content"
              >
                Source = Content
              </button>
              <button
                type="button"
                data-active={clip.loopEnabled}
                aria-pressed={clip.loopEnabled}
                aria-label={clip.loopEnabled ? "Disable MIDI source loop" : "Enable MIDI source loop"}
                title={clip.loopEnabled ? "Disable MIDI source loop" : "Enable MIDI source loop"}
                data-tooltip={clip.loopEnabled ? "Disable MIDI source loop" : "Enable MIDI source loop"}
                onClick={() => setMIDIClipSourceWindow(
                  clipId,
                  { loopEnabled: !clip.loopEnabled },
                  clip.loopEnabled ? "Disable MIDI source loop" : "Enable MIDI source loop",
                )}
                data-qa="piano-roll-source-loop"
              >
                Loop
              </button>
            </div>
          </section>

          <PianoRollInspectorSummary
            trackName={track.name}
            clipName={clip.name}
            noteCount={notePairs.length}
            selectedCount={selectedPairs.length}
          />

          <PianoRollNoteInspectorSection
            selectedCount={selectedPairs.length}
            inspectedNotePair={inspectedNotePair}
            snapDuration={snapDuration}
            selectedVelocityValue={selectedVelocityValue}
            selectedReleaseVelocityValue={selectedReleaseVelocityValue}
            selectedChannelValue={selectedChannelValue}
            selectedChanceValue={selectedChanceValue}
            selectedVarianceValue={selectedVarianceValue}
            selectedPlayCountValue={selectedPlayCountValue}
            selectedCentOffsetValue={selectedCentOffsetValue}
            onEditInspectedNote={editInspectedNote}
            onSelectedVelocityChange={(value) => setSelectedMIDINoteVelocity(trackId, clipId, clamp(Math.round(value), 1, 127))}
            onEditInspectedNoteMetadata={editInspectedNoteMetadata}
          />

          <PianoRollControllerLaneSection
            visibleLanes={visibleLanes}
            activeLaneId={activeLane?.id}
            selectedCC={selectedCC}
            onResetLanes={() => setPianoRollVisibleLanes(DEFAULT_PIANO_ROLL_VISIBLE_LANES.map((lane) => ({ ...lane })))}
            onSelectLane={selectControllerLane}
            onLaneHeightChange={(lane, value) => {
              const height = clamp(value, lane.kind === "velocity" ? 40 : 48, lane.kind === "velocity" ? 140 : 180);
              updatePianoRollVisibleLane(lane.id, { height });
              if (lane.kind === "velocity") setVelocityLaneHeight(height);
              else setCCLaneHeight(height);
            }}
            onLaneInterpolationChange={(lane, interpolation) => updatePianoRollVisibleLane(lane.id, { interpolation })}
            onRemoveLane={removePianoRollVisibleLane}
            onAddLane={addLane}
          />

          <PianoRollLaneEditorSection
            selectedCC={selectedCC}
            isCC14BitMode={isCC14BitMode}
            polyPressureNote={polyPressureNote}
            transformsDisabled={Boolean(selectedNoteMetadataLaneType)}
            canPaste={Boolean(controllerLaneClipboard)}
            onSelectedCCChange={setSelectedCC}
            onCC14BitModeChange={setCC14BitMode}
            onPolyPressureNoteChange={setPolyPressureNote}
            onOpenLine={openControllerLineDialog}
            onOpenLFO={() => openControllerLFODialog("sine")}
            onOpenTransform={openControllerTransformDialog}
            onOpenThin={openControllerThinDialog}
            onCopy={copyCurrentControllerLane}
            onPaste={pasteControllerLaneClipboard}
            onClear={clearCurrentControllerLane}
          />

          <PianoRollPitchBendSection
            pitchBendRangeUp={pitchBendRangeUp}
            pitchBendRangeDown={pitchBendRangeDown}
            pitchBendRangeLinked={pitchBendRangeLinked}
            snapPitchBendSemitones={snapPitchBendSemitones}
            fallbackRangeSemitones={DEFAULT_PITCH_BEND_RANGE_SEMITONES}
            onPitchBendRangeChange={(up, down, linked) => setTrackMidiPitchBendRange(trackId, up, down, linked)}
            onSnapPitchBendSemitonesChange={setSnapPitchBendSemitones}
          />
        </aside>

          <div
            className="piano-roll-piano-key-strip"
            aria-label="Piano keyboard"
            data-qa="piano-roll-key-strip"
          >
            <div className="piano-roll-key-ruler-spacer" style={{ height: RULER_HEIGHT }} />
            <div
              className="piano-roll-key-viewport"
              style={{ height: noteGridHeight }}
              data-qa="piano-roll-key-viewport"
              onPointerDown={beginPianoKeyPointerDrag}
              onPointerMove={updatePianoKeyPointerDrag}
              onPointerUp={endPianoKeyDrag}
              onPointerCancel={endPianoKeyDrag}
              onLostPointerCapture={endPianoKeyDrag}
            >
              {renderPianoKeys()}
            </div>
            <div className="piano-roll-key-lane-spacer" style={{ height: bottomLanesHeight }}>
              {controllerLaneLabel}
            </div>
            <div className="piano-roll-key-scroll-spacer" style={{ height: HORIZONTAL_SCROLLBAR_HEIGHT }} />
            <div className="piano-roll-key-status-spacer" style={{ height: STATUS_STRIP_HEIGHT }} />
          </div>
        </div>

        <div className="piano-roll-timeline-gutter" aria-hidden="true" />

        <div className="piano-roll-editor-pane" data-qa="piano-roll-editor-pane">
          <div
            className="piano-roll-ruler"
            style={{ width: stageWidth, height: RULER_HEIGHT }}
            data-qa="piano-roll-ruler"
            onPointerDown={handleRulerPointerDown}
          >
            {renderRulerMarks()}
            <PianoRollRulerPlayhead
              pixelsPerSecond={pixelsPerSecond}
              scrollX={timelineScrollX}
              width={stageWidth}
            />
          </div>
          <div className="piano-roll-stage-row" style={{ height: stageHeight }}>
            <div className="piano-roll-stage-wrap" data-qa="piano-roll-grid-stage">
              <Stage
                width={stageWidth}
                height={stageHeight}
                onMouseDown={handleStageMouseDown}
                onMouseMove={handleStageMouseMove}
                onMouseLeave={handleStageMouseLeave}
                onContextMenu={handleStageContextMenu}
                pixelRatio={window.devicePixelRatio || 1}
              >
                <Layer>
                  <Rect x={0} y={0} width={stageWidth} height={stageHeight} fill="#1a1a1a" />
                  {renderGrid()}
                  {renderLoopBoundaries()}
                  {renderGhostNotes()}
                  {renderAdditionalClipNotes()}
                  {renderPrimaryNotes()}
                  {renderDrawingPreview()}
                  {renderRangeSelection()}
                  {renderMarqueeSelection()}
                  {renderStepInputCursor()}
                  {renderActiveControllerLane()}
                  <PianoRollPlayheadLine
                    pixelsPerSecond={pixelsPerSecond}
                    scrollX={timelineScrollX}
                    stageHeight={stageHeight}
                    stageWidth={stageWidth}
                  />
                </Layer>
              </Stage>
            </div>
            <div
              className="piano-roll-vertical-scroll"
              ref={verticalScrollbarRef}
              onScroll={handleVerticalScrollbarScroll}
              data-qa="piano-roll-vertical-scrollbar"
              aria-label="Piano roll vertical scroll"
            >
              <div style={{ height: TOTAL_NOTES * noteHeight, width: 1 }} />
            </div>
          </div>

          <div
            className="piano-roll-horizontal-scroll"
            ref={scrollbarRef}
            onScroll={handleScrollbarScroll}
            data-qa="piano-roll-horizontal-scrollbar"
            aria-label="Piano roll horizontal scroll"
            style={{ width: stageWidth }}
          >
            <div style={{ width: contentWidth, height: 1 }} />
          </div>

          <PianoRollStatusStrip
            tool={tool}
            snapLabel={getGridSizeLabel(gridSize === "use_quantize" ? activeQuantizePreset.gridSize : gridSize)}
            cursorSeconds={pianoRollEditCursorTime}
            sourceSeconds={clipDuration}
            laneLabel={controllerLaneLabel}
          />
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildPianoRollContextMenuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {controllerDialog && (
        <div
          className="piano-roll-modal-backdrop"
          data-modal-root="true"
          onContextMenu={guardModalContextMenu}
        >
          <div
            className="piano-roll-transform-dialog piano-roll-controller-dialog"
            onContextMenu={guardModalContextMenu}
          >
            <div className="piano-roll-transform-dialog-title">
              {controllerDialog.type === "line" && `Generate ${controllerLaneLabel} Curve`}
              {controllerDialog.type === "lfo" && `Generate ${controllerLaneLabel} ${controllerDialog.shape} LFO`}
              {controllerDialog.type === "thin" && `Thin ${controllerLaneLabel}`}
              {controllerDialog.type === "transform" && `Transform ${controllerLaneLabel}`}
            </div>
            {controllerDialog.type === "line" && (
              <>
                <label>Mode</label>
                <select className="piano-roll-select" value={controllerDialog.interpolation} onChange={(event) => setControllerDialog({ ...controllerDialog, interpolation: event.target.value as ControllerInterpolationMode })}>
                  <option value="linear">Ramp</option>
                  <option value="step">Step</option>
                  <option value="curve">Curve</option>
                  <option value="parabola">Parabola</option>
                </select>
                {controllerDialog.interpolation === "curve" && (
                  <>
                    <label>Curve</label>
                    <input type="number" step="0.05" min="-0.99" max="0.99" value={controllerDialog.curve} onChange={(event) => setControllerDialog({ ...controllerDialog, curve: Number(event.target.value) })} />
                  </>
                )}
                <label>{selectedCC === PITCH_BEND_LANE ? "Start Semitones" : "Start Value"}</label>
                <input type="number" step={selectedCC === PITCH_BEND_LANE ? 0.1 : 1} value={controllerDialog.startValue} onChange={(event) => setControllerDialog({ ...controllerDialog, startValue: Number(event.target.value) })} />
                <label>{selectedCC === PITCH_BEND_LANE ? "End Semitones" : "End Value"}</label>
                <input type="number" step={selectedCC === PITCH_BEND_LANE ? 0.1 : 1} value={controllerDialog.endValue} onChange={(event) => setControllerDialog({ ...controllerDialog, endValue: Number(event.target.value) })} />
              </>
            )}
            {controllerDialog.type === "lfo" && (
              <>
                <label>Rate Hz</label>
                <input type="number" step="0.1" min="0.01" max="40" value={controllerDialog.rateHz} onChange={(event) => setControllerDialog({ ...controllerDialog, rateHz: Number(event.target.value) })} />
                {selectedCC !== PITCH_BEND_LANE && (
                  <>
                    <label>Center</label>
                    <input type="number" step="1" value={controllerDialog.centerValue} onChange={(event) => setControllerDialog({ ...controllerDialog, centerValue: Number(event.target.value) })} />
                  </>
                )}
                <label>{selectedCC === PITCH_BEND_LANE ? "Depth Semitones" : "Depth"}</label>
                <input type="number" step={selectedCC === PITCH_BEND_LANE ? 0.1 : 1} min="0" value={controllerDialog.depth} onChange={(event) => setControllerDialog({ ...controllerDialog, depth: Number(event.target.value) })} />
              </>
            )}
            {controllerDialog.type === "thin" && (
              <>
                <label>{selectedCC === PITCH_BEND_LANE ? "Tolerance Cents" : "Tolerance"}</label>
                <input type="number" step="1" min="0" value={controllerDialog.tolerance} onChange={(event) => setControllerDialog({ ...controllerDialog, tolerance: Number(event.target.value) })} />
              </>
            )}
            {controllerDialog.type === "transform" && (
              <>
                <label>Time Scale %</label>
                <input type="number" step="1" min="1" max="400" value={controllerDialog.timeScalePercent} onChange={(event) => setControllerDialog({ ...controllerDialog, timeScalePercent: Number(event.target.value) })} />
                <label>Value Scale %</label>
                <input type="number" step="1" min="0" max="400" value={controllerDialog.valueScalePercent} onChange={(event) => setControllerDialog({ ...controllerDialog, valueScalePercent: Number(event.target.value) })} />
                <label>Value Offset</label>
                <input type="number" step="1" value={controllerDialog.valueOffset} onChange={(event) => setControllerDialog({ ...controllerDialog, valueOffset: Number(event.target.value) })} />
                <label>Tilt</label>
                <input type="number" step="1" value={controllerDialog.tilt} onChange={(event) => setControllerDialog({ ...controllerDialog, tilt: Number(event.target.value) })} />
              </>
            )}
            <div className="piano-roll-transform-dialog-actions">
              <Button variant="default" size="sm" onClick={() => setControllerDialog(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={submitControllerDialog}>Apply</Button>
            </div>
          </div>
        </div>
      )}

      {transformDialog && (
        <div
          className="piano-roll-modal-backdrop"
          data-modal-root="true"
          onContextMenu={guardModalContextMenu}
        >
          <div
            className="piano-roll-transform-dialog"
            onContextMenu={guardModalContextMenu}
          >
            <div className="piano-roll-transform-dialog-title">
              {transformDialog.type === "quantize" && "Quantize Notes"}
              {transformDialog.type === "humanize" && "Humanize Notes"}
              {transformDialog.type === "velocity" && "Set Velocity"}
              {transformDialog.type === "randomVelocity" && "Randomize Velocity"}
              {transformDialog.type === "length" && "Set Note Length"}
              {transformDialog.type === "mirror" && "Mirror Around Note"}
            </div>
            {transformDialog.type === "quantize" && (
              <>
                <label>Preset</label>
                <select
                  className="piano-roll-select"
                  value={quantizePresetId}
                  onChange={(event) => {
                    const preset = getQuantizePresetById(quantizePresets, event.target.value);
                    setQuantizePresetId(preset.id);
                    setTransformDialog({
                      ...transformDialog,
                      gridSize: preset.gridSize,
                      value: calculateGridInterval(tempo, timeSignature, preset.gridSize, {
                        quantizePreset: preset,
                        quantizeGridSize: preset.gridSize,
                        pixelsPerSecond,
                      }),
                      strength: preset.strength,
                      swing: preset.swing,
                      groovePreset: preset.groovePreset,
                      tupletDivisions: preset.tupletDivisions,
                      catchRangeTicks: preset.catchRangeTicks,
                      safeRangeTicks: preset.safeRangeTicks,
                      roughTicks: preset.roughTicks,
                      moveControllers: preset.moveControllers,
                    });
                  }}
                >
                  {quantizePresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
                <label>Mode</label>
                <select className="piano-roll-select" value={transformDialog.mode} onChange={(event) => setTransformDialog({ ...transformDialog, mode: event.target.value as QuantizeMode })}>
                  <option value="start">Starts</option>
                  <option value="ends">Ends</option>
                  <option value="both">Starts + Ends</option>
                  <option value="length">Length</option>
                </select>
                <label>Quantize Grid</label>
                <select
                  className="piano-roll-select"
                  value={transformDialog.gridSize}
                  onChange={(event) => {
                    const nextGridSize = event.target.value as GridSize;
                    setTransformDialog({
                      ...transformDialog,
                      gridSize: nextGridSize,
                      value: calculateGridInterval(tempo, timeSignature, nextGridSize, {
                        quantizePreset: activeQuantizePreset,
                        quantizeGridSize: activeQuantizePreset.gridSize,
                        pixelsPerSecond,
                      }),
                    });
                  }}
                >
                  {GRID_SIZE_GROUPS.flatMap((group) => [
                    <option key={`${group.label}-label`} value={`__${group.label}`} disabled>{group.label}</option>,
                    ...group.options.map((option) => (
                      <option key={option} value={option}>{getGridSizeLabel(option)}</option>
                    )),
                  ])}
                </select>
                <label>Soft Quantize</label>
                <input type="number" step="0.05" min="0" max="1" value={transformDialog.strength} onChange={(event) => setTransformDialog({ ...transformDialog, strength: Number(event.target.value) })} />
                <label>Tuplet</label>
                <input type="number" step="1" min="1" max="12" value={transformDialog.tupletDivisions} onChange={(event) => setTransformDialog({ ...transformDialog, tupletDivisions: Math.max(1, Math.round(Number(event.target.value) || 1)) })} />
                <label>Swing</label>
                <input type="number" step="0.05" min="-1" max="1" value={transformDialog.swing} onChange={(event) => setTransformDialog({ ...transformDialog, swing: Number(event.target.value) })} />
                <label>Groove</label>
                <select className="piano-roll-select" value={transformDialog.groovePreset} onChange={(event) => setTransformDialog({ ...transformDialog, groovePreset: event.target.value as QuantizeGroovePreset })}>
                  <option value="straight">Straight</option>
                  <option value="swingLight">Swing Light</option>
                  <option value="swingHeavy">Swing Heavy</option>
                  <option value="laidBack16">Laid Back 16</option>
                  <option value="push16">Push 16</option>
                </select>
                <label>Catch Range</label>
                <input type="number" step={GRID_TICKS_PER_SIXTEENTH} min="0" value={transformDialog.catchRangeTicks} onChange={(event) => setTransformDialog({ ...transformDialog, catchRangeTicks: Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
                <label>Safe Range</label>
                <input type="number" step={GRID_TICKS_PER_SIXTEENTH} min="0" value={transformDialog.safeRangeTicks} onChange={(event) => setTransformDialog({ ...transformDialog, safeRangeTicks: Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
                <label>Rough Quantize</label>
                <input type="number" step={GRID_TICKS_PER_SIXTEENTH} min="0" value={transformDialog.roughTicks} onChange={(event) => setTransformDialog({ ...transformDialog, roughTicks: Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
                {transformDialog.mode === "length" && (
                  <>
                    <label>Length Quantize</label>
                    <select className="piano-roll-select" value={transformDialog.fixedLengthGridSize} onChange={(event) => setTransformDialog({ ...transformDialog, fixedLengthGridSize: event.target.value as GridSize | "quantize_link" })}>
                      <option value="quantize_link">Quantize Link</option>
                      {GRID_SIZE_GROUPS.flatMap((group) => [
                        <option key={`${group.label}-length-label`} value={`__length-${group.label}`} disabled>{group.label}</option>,
                        ...group.options.map((option) => (
                          <option key={`length-${option}`} value={option}>{getGridSizeLabel(option)}</option>
                        )),
                      ])}
                    </select>
                  </>
                )}
                <label className="piano-roll-checkbox-row">
                  <input type="checkbox" checked={transformDialog.moveControllers} onChange={(event) => setTransformDialog({ ...transformDialog, moveControllers: event.target.checked })} />
                  Move Controllers
                </label>
                <label className="piano-roll-checkbox-row">
                  <input type="checkbox" checked={transformDialog.autoApply} onChange={(event) => setTransformDialog({ ...transformDialog, autoApply: event.target.checked })} />
                  Auto Apply
                </label>
              </>
            )}
            {transformDialog.type === "humanize" && (
              <>
                <label>Timing ms</label>
                <input type="number" step="1" min="0" value={transformDialog.timingMs} onChange={(event) => setTransformDialog({ ...transformDialog, timingMs: Number(event.target.value) })} />
                <label>Velocity</label>
                <input type="number" step="1" min="0" value={transformDialog.velocity} onChange={(event) => setTransformDialog({ ...transformDialog, velocity: Number(event.target.value) })} />
              </>
            )}
            {transformDialog.type === "velocity" && (
              <>
                <label>Velocity</label>
                <input type="number" step="1" min="1" max="127" value={transformDialog.value} onChange={(event) => setTransformDialog({ ...transformDialog, value: Number(event.target.value) })} />
              </>
            )}
            {transformDialog.type === "randomVelocity" && (
              <>
                <label>Amount</label>
                <input type="number" step="1" min="0" max="127" value={transformDialog.amount} onChange={(event) => setTransformDialog({ ...transformDialog, amount: Number(event.target.value) })} />
              </>
            )}
            {transformDialog.type === "length" && (
              <>
                <label>Length Seconds</label>
                <input type="number" step="0.01" min="0.01" value={transformDialog.value} onChange={(event) => setTransformDialog({ ...transformDialog, value: Number(event.target.value) })} />
              </>
            )}
            {transformDialog.type === "mirror" && (
              <>
                <label>Center Note</label>
                <input type="number" step="1" min="0" max="127" value={transformDialog.centerNote} onChange={(event) => setTransformDialog({ ...transformDialog, centerNote: Number(event.target.value) })} />
              </>
            )}
            <div className="piano-roll-transform-dialog-actions">
              {transformDialog.type === "quantize" && (
                <Button variant="default" size="sm" onClick={() => openQuantizePanel()}>Reset</Button>
              )}
              <Button variant="default" size="sm" onClick={() => setTransformDialog(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={applyTransformDialog}>Apply</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
