import React, { useRef, useEffect, useState, useCallback, useMemo, useTransition } from "react";
import { Stage, Layer, Rect, Line, Text, Group, Circle } from "react-konva";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KonvaEvent = any; // Konva events access .evt.shiftKey, .target.getStage() etc. — full typing requires 70+ null guards
import { useShallow } from "zustand/shallow";
import {
  useDAWStore,
  Track,
  AudioClip,
  MIDIClip,
  MIDIEvent,
  AutomationPoint,
  RecordingClip,
  getTrackGroupInfo,
  TRACK_GROUP_COLORS,
  getEffectiveTrackHeight,
  getTrackYPositions,
  getTrackAtY,
  AUTOMATION_LANE_HEIGHT,
  BOTTOM_INTERACTION_BUFFER,
  DEFAULT_HORIZONTAL_SCROLLBAR_HEIGHT,
  getTimelineRowMetrics,
} from "../store/useDAWStore";
import {
  nativeBridge,
  WaveformPeak,
  type ExternalMediaDragEvent,
  type MIDIImportTrack,
} from "../services/NativeBridge";
import { ContextMenu } from "./ContextMenu";
import { HorizontalScrollbar } from "./HorizontalScrollbar";
import { MemoizedPlayhead as Playhead } from "./Playhead";
import {
  calculateGridInterval,
  getQuantizePresetById,
  resolveVisualGrid,
  snapTimeByType,
  ticksToSeconds,
} from "../utils/snapToGrid";
import { getRulerClickSnapTime } from "../utils/rulerClickSnap";
import { guardModalContextMenu, shouldSuppressWorkspaceContextMenu } from "../utils/modalEventGuards";
import {
  fadeInCurvePoints,
  fadeOutCurvePoints,
} from "../utils/fadeUtils";
import {
  getAutomationColor,
  getAutomationShortLabel,
  getAutomationDefault,
  formatAutomationValue,
} from "../store/automationParams";
import {
  createTrackOfType,
  type InsertableTrackType,
} from "../utils/trackCreation";
import { buildScrollbarOverview } from "../utils/scrollbarOverview";
import { buildMIDIThumbnailBars, sampleMIDIThumbnailBars } from "../utils/midiPreview";
import { getMIDIClipSourceLoopLength, getVisibleMIDIEventsForClip, serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";
import {
  buildTimelineClipHitMap,
  findTimelineClipHit,
} from "../utils/timelineClipHitTest";
import {
  classifyTimelineClipGesture,
  computeSlipOffset,
  computeTimelineMoveStart,
  computeTimelineResize,
} from "../utils/timelineClipGestures";
import { commandManager } from "../store/commands";

// Constants
const RULER_HEIGHT = 30;
const MIN_PIXELS_PER_SECOND = 1;
const MAX_PIXELS_PER_SECOND = 1000;
const CLIP_COLOR_OPTIONS = [
  { label: "Blue", color: "#4361ee" },
  { label: "Teal", color: "#2dd4bf" },
  { label: "Amber", color: "#f59e0b" },
  { label: "Red", color: "#ef4444" },
  { label: "Violet", color: "#a78bfa" },
  { label: "Green", color: "#22c55e" },
  { label: "Orange", color: "#f97316" },
  { label: "Yellow", color: "#eab308" },
  { label: "Pink", color: "#ec4899" },
  { label: "Slate", color: "#6b7280" },
  { label: "White", color: "#ffffff" },
] as const;

// Snap samplesPerPixel to nearest power-of-2 so the waveform cache key
// stays stable across a wide zoom range (prevents re-fetch on every tick).
// Minimum is 64 — the finest mipmap stride available in PeakCache (LEVEL_STRIDES[0]).
// Requesting finer than 64 makes the C++ use ratio=1 (finest mipmap) anyway, but
// the JS coordinate math breaks if cacheSpp < actual stride.
const FINEST_MIPMAP_STRIDE = 64;
const quantizeSpp = (spp: number) =>
  Math.max(FINEST_MIPMAP_STRIDE, Math.pow(2, Math.round(Math.log2(Math.max(1, spp)))));

interface MasterAutomationProps {
  lanes: { id: string; param: string; points: { time: number; value: number }[]; visible: boolean; mode: string; armed: boolean }[];
  showAutomation: boolean;
}

interface TimelineProps {
  tracks: Track[];
  masterAutomation?: MasterAutomationProps;
  footerHeight?: number;
  onOpenAddMultipleTracksModal?: (type?: InsertableTrackType) => void;
  showRuler?: boolean;
}

// Cache for waveform data to avoid re-fetching
type WaveformCache = Map<string, WaveformPeak[]>;

// Recording waveform cache (trackId -> peaks + width at fetch time)
type RecordingWaveformData = { peaks: WaveformPeak[]; widthPixels: number };
type RecordingWaveformCache = Map<string, RecordingWaveformData>;
const AUDIO_RECORD_LOG_PREFIX = "[audio.record]";
const EXTERNAL_MEDIA_EXTENSIONS = new Set([
  ".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif", ".wma", ".m4a", ".aac",
  ".mid", ".midi",
  ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".m4v",
]);
const EXTERNAL_MIDI_EXTENSIONS = new Set([".mid", ".midi"]);
const EXTERNAL_TRACK_INSERT_BAND_PX = 8;

type ExternalMediaKind = "audio" | "midi";

type ExternalMediaDropTarget =
  | { kind: "existingTrack"; trackIndex: number }
  | { kind: "insertTrack"; insertIndex: number };

type ExternalMediaDropPreview = {
  dragId: string;
  filePath: string;
  name: string;
  mediaKind: ExternalMediaKind;
  target: ExternalMediaDropTarget;
  startTime: number;
  duration: number;
  peaks?: WaveformPeak[];
  sampleRate?: number;
  midiEvents?: MIDIEvent[];
  midiTrackCount?: number;
};

type ExternalMediaDragContext = {
  dragId: string;
  files: NonNullable<ExternalMediaDragEvent["files"]>;
  filePath: string;
  name: string;
  mediaKind: ExternalMediaKind;
  duration?: number;
  sampleRate?: number;
  peaks?: WaveformPeak[];
  midiTracks?: MIDIImportTrack[];
  midiEvents?: MIDIEvent[];
  midiTrackCount?: number;
};

const getExternalMediaFileExtension = (file: { extension?: string; name: string }) => {
  const raw = (file.extension || `.${file.name.split(".").pop() || ""}`).trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith(".") ? raw : `.${raw}`;
};

const getExternalMediaKind = (file: { extension?: string; name: string }): ExternalMediaKind =>
  EXTERNAL_MIDI_EXTENSIONS.has(getExternalMediaFileExtension(file)) ? "midi" : "audio";

const normalizeExternalMIDIVelocity = (value: unknown, fallback = 80) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed > 0 && parsed <= 1) return Math.max(1, Math.min(127, Math.round(parsed * 127)));
  return Math.max(1, Math.min(127, Math.round(parsed)));
};

const normalizeExternalMIDIEvents = (events: any[] = []): MIDIEvent[] =>
  events
    .map((event) => {
      const timestamp = Math.max(0, Number(event?.timestamp) || 0);
      const channel = Number.isFinite(Number(event?.channel))
        ? Math.max(1, Math.min(16, Math.round(Number(event.channel))))
        : undefined;

      if (event?.type === "noteOn" || event?.type === "noteOff") {
        return {
          timestamp,
          type: event.type,
          note: Math.max(0, Math.min(127, Math.round(Number(event.note) || 60))),
          velocity: event.type === "noteOn" ? normalizeExternalMIDIVelocity(event.velocity) : 0,
          channel,
        } as MIDIEvent;
      }

      if (event?.type === "pitchBend") {
        return {
          timestamp,
          type: "pitchBend",
          value: Math.max(0, Math.min(16383, Math.round(Number(event.value) || 8192))),
          channel,
        } as MIDIEvent;
      }

      return null;
    })
    .filter((event): event is MIDIEvent => Boolean(event))
    .sort((a, b) => a.timestamp - b.timestamp || (a.note ?? 0) - (b.note ?? 0));

const getNonEmptyExternalMIDITracks = (tracks: MIDIImportTrack[] | undefined) =>
  (tracks ?? []).filter((track) => Array.isArray(track.events) && track.events.length > 0);

const getExternalMIDITrackDuration = (track: MIDIImportTrack | undefined) => {
  const maxTime = (track?.events ?? []).reduce((max, event) => {
    const timestamp = Number(event?.timestamp);
    return Number.isFinite(timestamp) ? Math.max(max, timestamp) : max;
  }, 0);
  return Math.max(0.25, maxTime || 4);
};

// Clip context menu state type
type ClipContextMenuState = {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
  kind: "audio" | "midi";
  time: number;
} | null;

type TimelineBackgroundContextMenuState = {
  x: number;
  y: number;
  time: number;
  trackId: string | null;
  trackType: Track["type"] | null;
} | null;

type MidiSourceLengthDialogState = {
  clipId: string;
  value: string;
  error: string | null;
};

type RepeatClipDialogState = {
  clipId: string;
  value: string;
  error: string | null;
};

type TimelineDragState = {
  type: "move" | "resize-left" | "resize-right" | null;
  clipId: string | null;
  trackIndex: number | null;
  targetTrackIndex: number | null;
  startX: number;
  startTime: number;
  originalStartTime: number;
  originalDuration: number;
  originalOffset: number;
  copyOnDrag?: boolean;
  previewStartTime?: number;
  ghostX?: number;
  ghostY?: number;
  isFadeDrag?: boolean;
  multiClipInfo?: Array<{
    clipId: string;
    trackIndex: number;
    originalStartTime: number;
    isMidi: boolean;
  }>;
};

type TimelineGestureUndoSnapshot = {
  tracks: Track[];
  selectedClipId: string | null;
  selectedClipIds: string[];
  isModified: boolean;
};

type AutomationDrawState = {
  trackId: string;
  laneId: string;
  laneParam: string;
  trackIndex: number;
  laneIndex: number;
  originalPoints: AutomationPoint[];
  points: AutomationPoint[];
  oldTrackRead: boolean;
  oldTrackWrite: boolean;
  oldLaneRead: boolean;
  oldLaneMode: Track["automationLanes"][number]["mode"];
  lastPoint: AutomationPoint;
};

const createEmptyTimelineDragState = (): TimelineDragState => ({
  type: null,
  clipId: null,
  trackIndex: null,
  targetTrackIndex: null,
  startX: 0,
  startTime: 0,
  originalStartTime: 0,
  originalDuration: 0,
  originalOffset: 0,
  copyOnDrag: false,
  previewStartTime: 0,
});

const cloneTimelineGestureTracks = (tracks: Track[]): Track[] =>
  tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => ({
      ...clip,
      gainEnvelope: clip.gainEnvelope ? clip.gainEnvelope.map((point) => ({ ...point })) : clip.gainEnvelope,
    })),
    midiClips: track.midiClips.map((clip) => ({
      ...clip,
      events: (clip.events || []).map((event) => ({ ...event })),
      ccEvents: clip.ccEvents ? clip.ccEvents.map((event) => ({ ...event })) : clip.ccEvents,
      quantizeBackup: clip.quantizeBackup
        ? {
            events: clip.quantizeBackup.events?.map((event) => ({ ...event })),
            ccEvents: clip.quantizeBackup.ccEvents?.map((event) => ({ ...event })),
          }
        : clip.quantizeBackup,
    })),
  }));

const timelineGestureSignature = (tracks: Track[]) =>
  JSON.stringify(
    tracks.map((track) => ({
      id: track.id,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        startTime: clip.startTime,
        duration: clip.duration,
        offset: clip.offset || 0,
        muted: !!clip.muted,
      })),
      midiClips: track.midiClips.map((clip) => ({
        id: clip.id,
        startTime: clip.startTime,
        duration: clip.duration,
        offset: clip.offset || 0,
        sourceLength: clip.sourceLength,
        loopLength: clip.loopLength,
        loopEnabled: clip.loopEnabled,
        loopOffset: clip.loopOffset,
        muted: !!clip.muted,
      })),
    })),
  );

const clampAutomationValue = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const cloneAutomationPoints = (points: AutomationPoint[] = []) =>
  points.map((point) => ({ time: point.time, value: point.value }));

const mergeAutomationDrawPoints = (
  basePoints: AutomationPoint[],
  additions: AutomationPoint[],
  pixelsPerSecond: number,
) => {
  if (additions.length === 0) return basePoints;
  const replaceRadiusSeconds = Math.max(0.004, 3 / Math.max(1, pixelsPerSecond));
  let next = cloneAutomationPoints(basePoints);

  for (const addition of additions) {
    const normalized = {
      time: Math.max(0, addition.time),
      value: clampAutomationValue(addition.value),
    };
    next = next.filter((point) => Math.abs(point.time - normalized.time) > replaceRadiusSeconds);
    next.push(normalized);
  }

  next.sort((a, b) => a.time - b.time);
  return next;
};

const interpolateAutomationDrawSegment = (
  from: AutomationPoint,
  to: AutomationPoint,
  pixelsPerSecond: number,
) => {
  const dxPixels = Math.abs(to.time - from.time) * Math.max(1, pixelsPerSecond);
  const steps = Math.max(1, Math.ceil(dxPixels / 6));
  const points: AutomationPoint[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    points.push({
      time: from.time + (to.time - from.time) * t,
      value: clampAutomationValue(from.value + (to.value - from.value) * t),
    });
  }
  return points;
};

export function Timeline({
  tracks,
  masterAutomation,
  footerHeight = DEFAULT_HORIZONTAL_SCROLLBAR_HEIGHT,
  onOpenAddMultipleTracksModal,
  showRuler = true,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 400 });
  const [waveformCache, setWaveformCache] = useState<WaveformCache>(new Map());
  const [waveformPreviewCache, setWaveformPreviewCache] = useState<WaveformCache>(new Map());
  const [recordingWaveformCache, setRecordingWaveformCache] = useState<RecordingWaveformCache>(new Map());
  const waveformCacheRef = useRef(waveformCache);
  waveformCacheRef.current = waveformCache;
  const recordingWaveformCacheRef = useRef(recordingWaveformCache);
  recordingWaveformCacheRef.current = recordingWaveformCache;
  // Marks recording-waveform updates as low-priority so React won't interrupt
  // the current RAF frame (playhead animation) to process them.
  const [, startRecordingWaveformTransition] = useTransition();

  // Zooming flag — suppresses waveform fetches during active zoom
  const isZoomingRef = useRef(false);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceRender] = useState(0); // trigger re-render when zoom ends

  // Scrolling flag — suppresses waveform fetches during active scroll (like zoom debounce)
  const isScrollingRef = useRef(false);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // In-flight waveform fetches — prevents duplicate concurrent requests for same cache key
  const inFlightRef = useRef<Set<string>>(new Set());

  // Hovered automation point — for tooltip display
  const [hoveredAutoPoint, setHoveredAutoPoint] = useState<{
    laneId: string;
    pointIndex: number;
    param: string;
    value: number;
    time: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const automationDrawRef = useRef<AutomationDrawState | null>(null);

  // Clip context menu state
  const [clipContextMenu, setClipContextMenu] =
    useState<ClipContextMenuState>(null);
  const [backgroundContextMenu, setBackgroundContextMenu] =
    useState<TimelineBackgroundContextMenuState>(null);
  const [midiSourceLengthDialog, setMidiSourceLengthDialog] =
    useState<MidiSourceLengthDialogState | null>(null);
  const [repeatClipDialog, setRepeatClipDialog] =
    useState<RepeatClipDialogState | null>(null);

  // Drag state for clip movement and resizing
  const [dragState, setDragStateState] = useState<TimelineDragState>(createEmptyTimelineDragState);
  const dragStateRef = useRef<TimelineDragState>(dragState);
  const timelineGestureUndoRef = useRef<TimelineGestureUndoSnapshot | null>(null);
  const externalMidiDragRef = useRef<{ clipId: string } | null>(null);

  const setTimelineDragState = useCallback((
    next: TimelineDragState | ((previous: TimelineDragState) => TimelineDragState),
  ) => {
    setDragStateState((previous) => {
      const base = dragStateRef.current || previous;
      const resolved = typeof next === "function"
        ? (next as (previous: TimelineDragState) => TimelineDragState)(base)
        : next;
      dragStateRef.current = resolved;
      return resolved;
    });
  }, []);
  /*
    type: "move" | "resize-left" | "resize-right" | null;
    clipId: string | null;
    trackIndex: number | null;
    targetTrackIndex: number | null; // Visual target track during cross-track drag
    startX: number;
    startTime: number;
    originalStartTime: number;
    originalDuration: number;
    originalOffset: number;
    copyOnDrag?: boolean;
    previewStartTime?: number;
    ghostX?: number; // Ghost preview position
    ghostY?: number;
    isFadeDrag?: boolean; // Smart tool: drag adjusts fade instead of trim
    // Multi-clip drag info — populated when dragging a clip that's part of multi-selection
    multiClipInfo?: Array<{
      clipId: string;
      trackIndex: number;
      originalStartTime: number;
      isMidi: boolean;
    }>;
  }>({
    type: null,
    clipId: null,
    trackIndex: null,
    targetTrackIndex: null,
    startX: 0,
    startTime: 0,
    originalStartTime: 0,
    originalDuration: 0,
    originalOffset: 0,
    copyOnDrag: false,
    previewStartTime: 0,
  });
*/

  // Ghost track state for auto-creation when dragging to empty space
  const [showGhostTrack, setShowGhostTrack] = useState(false);

  // Snap ghost preview state (ref-based to avoid re-renders during drag)
  const snapGhostRef = useRef<{
    x: number;        // snapped X position (screen px)
    y: number;        // track Y position (screen px)
    width: number;    // clip width (px)
    height: number;   // clip height (px)
    color: string;    // clip color
    visible: boolean;
  } | null>(null);
  const [snapGhostRender, setSnapGhostRender] = useState<typeof snapGhostRef.current>(null);

  // Marquee zoom state (Ctrl+drag on background)
  const marqueeZoomRef = useRef<{
    startX: number;   // screen X at mousedown
    startTime: number;
    currentX: number; // current screen X
    currentTime: number;
  } | null>(null);
  const [marqueeZoomRect, setMarqueeZoomRect] = useState<{
    x: number; width: number;
  } | null>(null);

  // Reset drag state helper function
  const resetDragState = useCallback(() => {
    setTimelineDragState(createEmptyTimelineDragState());
    timelineGestureUndoRef.current = null;
    setShowGhostTrack(false);
    // Clear snap ghost preview
    snapGhostRef.current = null;
    setSnapGhostRender(null);
  }, [setTimelineDragState]);

  const captureTimelineGestureUndo = useCallback(() => {
    if (timelineGestureUndoRef.current) return;
    const state = useDAWStore.getState();
    timelineGestureUndoRef.current = {
      tracks: cloneTimelineGestureTracks(state.tracks),
      selectedClipId: state.selectedClipId,
      selectedClipIds: [...state.selectedClipIds],
      isModified: state.isModified,
    };
  }, []);

  const clearTimelineGestureUndo = useCallback(() => {
    timelineGestureUndoRef.current = null;
  }, []);

  const restoreTimelineGestureUndo = useCallback(() => {
    const before = timelineGestureUndoRef.current;
    if (!before) return;

    useDAWStore.setState({
      tracks: cloneTimelineGestureTracks(before.tracks),
      selectedClipId: before.selectedClipId,
      selectedClipIds: [...before.selectedClipIds],
      isModified: before.isModified,
    });
  }, []);

  const commitTimelineGestureUndo = useCallback((description: string) => {
    const before = timelineGestureUndoRef.current;
    if (!before) return;

    const state = useDAWStore.getState();
    const after: TimelineGestureUndoSnapshot = {
      tracks: cloneTimelineGestureTracks(state.tracks),
      selectedClipId: state.selectedClipId,
      selectedClipIds: [...state.selectedClipIds],
      isModified: state.isModified,
    };

    if (timelineGestureSignature(before.tracks) === timelineGestureSignature(after.tracks)) {
      timelineGestureUndoRef.current = null;
      return;
    }

    const syncAfterState = () => {
      const syncResult = useDAWStore.getState().syncClipsWithBackend?.();
      if (syncResult?.catch) syncResult.catch(() => {});
    };

    commandManager.push({
      type: "TIMELINE_CLIP_GESTURE",
      description,
      timestamp: Date.now(),
      execute: () => {
        useDAWStore.setState({
          tracks: cloneTimelineGestureTracks(after.tracks),
          selectedClipId: after.selectedClipId,
          selectedClipIds: [...after.selectedClipIds],
          isModified: true,
        });
        syncAfterState();
      },
      undo: () => {
        useDAWStore.setState({
          tracks: cloneTimelineGestureTracks(before.tracks),
          selectedClipId: before.selectedClipId,
          selectedClipIds: [...before.selectedClipIds],
          isModified: true,
        });
        syncAfterState();
      },
    });

    useDAWStore.setState({
      canUndo: commandManager.canUndo(),
      canRedo: commandManager.canRedo(),
      isModified: true,
    });
    timelineGestureUndoRef.current = null;
  }, []);

  const previewResizeTimelineClip = useCallback((
    clipId: string,
    isMidi: boolean,
    nextValues: { startTime: number; duration: number; offset: number },
  ) => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: isMidi
          ? track.clips
          : track.clips.map((clip) => clip.id === clipId ? { ...clip, ...nextValues } : clip),
        midiClips: isMidi
          ? track.midiClips.map((clip) => clip.id === clipId ? { ...clip, ...nextValues } : clip)
          : track.midiClips,
      })),
      isModified: true,
    }));
  }, []);

  const commitPreviewedResizeTimelineClip = useCallback((
    clipId: string,
    isMidi: boolean,
    originalValues: { startTime: number; duration: number; offset: number },
  ) => {
    let finalClip: AudioClip | MIDIClip | undefined;
    for (const track of useDAWStore.getState().tracks) {
      finalClip = (isMidi ? track.midiClips : track.clips).find((candidate) => candidate.id === clipId);
      if (finalClip) break;
    }
    if (!finalClip) return;

    const finalValues = {
      startTime: finalClip.startTime,
      duration: finalClip.duration,
      offset: finalClip.offset || 0,
    };

    const changed =
      Math.abs(finalValues.startTime - originalValues.startTime) > 0.000001 ||
      Math.abs(finalValues.duration - originalValues.duration) > 0.000001 ||
      Math.abs(finalValues.offset - originalValues.offset) > 0.000001;
    if (!changed) return;

    previewResizeTimelineClip(clipId, isMidi, originalValues);
    useDAWStore.getState().resizeClip(
      clipId,
      finalValues.startTime,
      finalValues.duration,
      finalValues.offset,
    );
  }, [previewResizeTimelineClip]);

  // Global mouseup and blur handlers to prevent stuck drag/marquee state
  useEffect(() => {
    const resetMarquee = () => {
      marqueeRef.current = null;
      setMarqueeRect(null);
    };

    const resetMarqueeZoom = () => {
      marqueeZoomRef.current = null;
      setMarqueeZoomRect(null);
    };

    const handleGlobalMouseUp = () => {
      // Konva's dragend owns clip gesture finalization. Resetting here can
      // clear the drag state before a MIDI clip move/resize has committed.
      if (marqueeRef.current) {
        resetMarquee();
      }
      if (marqueeZoomRef.current) {
        resetMarqueeZoom();
      }
      // Slip edits are also finalized by the Stage mouseup handler.
    };

    const handleWindowBlur = () => {
      if (dragState.type !== null) {
        console.log("[Timeline] Window blur - resetting drag state");
        resetDragState();
      }
      if (marqueeRef.current) {
        resetMarquee();
      }
      if (marqueeZoomRef.current) {
        resetMarqueeZoom();
      }
      // Reset slip edit state on window blur
      if (slipEditRef.current) {
        slipEditRef.current = null;
      }
    };

    // Always listen — handlers are cheap no-ops when nothing is active
    window.addEventListener("mouseup", handleGlobalMouseUp);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [dragState.type, resetDragState]);

  // Time selection drag state
  const [timeSelectionDrag, setTimeSelectionDrag] = useState<{
    active: boolean;
    startTime: number;
  } | null>(null);

  // Razor edit drag state
  const [razorDrag, setRazorDrag] = useState<{
    active: boolean;
    trackId: string;
    startTime: number;
  } | null>(null);

  // Marquee (rubber-band) selection state
  const marqueeRef = useRef<{
    startX: number; // timeline-space X (includes scrollX)
    startY: number; // timeline-space Y
    currentX: number;
    currentY: number;
    ctrlHeld: boolean;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number; y: number; width: number; height: number;
  } | null>(null);
  const marqueeJustCompletedRef = useRef(false);

  // Crosshair cursor position (screen coordinates relative to Stage)
  const [crosshairPos, setCrosshairPos] = useState<{ x: number; y: number } | null>(null);

  // Slip editing state (Alt+drag on clip adjusts offset instead of position)
  const slipEditRef = useRef<{
    clipId: string;
    trackId: string;
    isMidi: boolean;
    startX: number;
    originalOffset: number;
    sourceLength: number;
    clipDuration: number;
    maxOffset: number;
  } | null>(null);

  // Split tool preview line
  const [splitPreviewX, setSplitPreviewX] = useState<number | null>(null);
  const [externalMediaPreview, setExternalMediaPreview] = useState<ExternalMediaDropPreview | null>(null);

  // Ruler interaction state (ref-based to avoid stale closures in global listeners)
  const rulerDragRef = useRef<{
    type: "handle-pending" | "handle-drag" | "range-create" | "pending"; // pending = mousedown, not yet determined
    handle?: "start" | "end";
    startX: number; // pixel X at mousedown (relative to ruler canvas)
    startTime: number; // time at mousedown
  } | null>(null);
  // Reactive state just to trigger re-renders when range changes during drag
  const [_rulerDragging, setRulerDragging] = useState(false);

  // Use useShallow to prevent re-renders when unrelated state changes (like currentTime)
  const {
    recordingClips,
    recordingMIDIPreviews,
    pixelsPerSecond,
    setZoom,
    seekTo,
    scrollX,
    scrollY,
    setScroll,
    trackHeight,
    setTrackHeight,
    selectedClipIds,
    selectClip,
    moveClipToTrack,
    setClipVolume,
    beginClipVolumeEdit,
    commitClipVolumeEdit,
    setClipFades,
    copyClip,
    cutClip,
    pasteClip,
    deleteClip,
    duplicateClip,
    duplicateClipToPosition,
    repeatClip,
    clipboard,
    addTrack,
    importExternalMediaAtTimeline,
    importExternalMIDIAtTimeline,
    timeSignature,
    markers,
    regions,
    snapEnabled,
    snapType,
    gridSize,
    quantizePresetId,
    quantizePresets,
    timeSelection,
    setTimeSelection,
    clearTimeSelection,
    openPianoRoll,
    addMIDIClip,
    addEmptyClip,
    syncClipsWithBackend,
    projectRange,
    setProjectRange,
    deselectAllTracks,
    razorEdits,
    addRazorEdit,
    clearRazorEdits,
    toolMode,
    splitClipAtPosition,
    splitMIDIClipAtPosition,
    trackGroups,
    showCrosshair,
    setTrackWaveformZoom,
    slipEditClip,
    rippleMode,
    addClipGainPoint,
    moveClipGainPoint,
    removeClipGainPoint,
  } = useDAWStore(
    useShallow((state) => ({
      recordingClips: state.recordingClips,
      recordingMIDIPreviews: state.recordingMIDIPreviews,
      pixelsPerSecond: state.pixelsPerSecond,
      setZoom: state.setZoom,
      seekTo: state.seekTo,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      setScroll: state.setScroll,
      trackHeight: state.trackHeight,
      setTrackHeight: state.setTrackHeight,
      selectedClipIds: state.selectedClipIds,
      selectClip: state.selectClip,
      moveClipToTrack: state.moveClipToTrack,
      setClipVolume: state.setClipVolume,
      beginClipVolumeEdit: state.beginClipVolumeEdit,
      commitClipVolumeEdit: state.commitClipVolumeEdit,
      setClipFades: state.setClipFades,
      copyClip: state.copyClip,
      cutClip: state.cutClip,
      pasteClip: state.pasteClip,
      deleteClip: state.deleteClip,
      duplicateClip: state.duplicateClip,
      duplicateClipToPosition: state.duplicateClipToPosition,
      repeatClip: state.repeatClip,
      clipboard: state.clipboard,
      addTrack: state.addTrack,
      importExternalMediaAtTimeline: state.importExternalMediaAtTimeline,
      importExternalMIDIAtTimeline: state.importExternalMIDIAtTimeline,
      timeSignature: state.timeSignature,
      markers: state.markers,
      regions: state.regions,
      snapEnabled: state.snapEnabled,
      snapType: state.snapType,
      gridSize: state.gridSize,
      quantizePresetId: state.quantizePresetId,
      quantizePresets: state.quantizePresets,
      timeSelection: state.timeSelection,
      setTimeSelection: state.setTimeSelection,
      clearTimeSelection: state.clearTimeSelection,
      openPianoRoll: state.openPianoRoll,
      addMIDIClip: state.addMIDIClip,
      addEmptyClip: state.addEmptyClip,
      syncClipsWithBackend: state.syncClipsWithBackend,
      projectRange: state.projectRange,
      setProjectRange: state.setProjectRange,
      deselectAllTracks: state.deselectAllTracks,
      razorEdits: state.razorEdits,
      addRazorEdit: state.addRazorEdit,
      clearRazorEdits: state.clearRazorEdits,
      toolMode: state.toolMode,
      splitClipAtPosition: state.splitClipAtPosition,
      splitMIDIClipAtPosition: state.splitMIDIClipAtPosition,
      trackGroups: state.trackGroups,
      showCrosshair: state.showCrosshair,
      setTrackWaveformZoom: state.setTrackWaveformZoom,
      slipEditClip: state.slipEditClip,
      rippleMode: state.rippleMode,
      addClipGainPoint: state.addClipGainPoint,
      moveClipGainPoint: state.moveClipGainPoint,
      removeClipGainPoint: state.removeClipGainPoint,
    }))
  );

  // Use selectors for transport values - but NOT currentTime (causes 60fps re-renders)
  // currentTime is handled via Zustand subscribe for playhead animation only
  const tempo = useDAWStore((state) => state.transport.tempo);
  const loopEnabled = useDAWStore((state) => state.transport.loopEnabled);
  const loopStart = useDAWStore((state) => state.transport.loopStart);
  const loopEnd = useDAWStore((state) => state.transport.loopEnd);
  const isPlaying = useDAWStore((state) => state.transport.isPlaying);
  const isRecording = useDAWStore((state) => state.transport.isRecording);
  const [recordingRenderTime, setRecordingRenderTime] = useState(
    () => useDAWStore.getState().transport.currentTime,
  );

  useEffect(() => {
    if (!isRecording || recordingClips.length === 0) {
      setRecordingRenderTime(useDAWStore.getState().transport.currentTime);
      return;
    }

    let previousTime = useDAWStore.getState().transport.currentTime;
    const unsubscribe = useDAWStore.subscribe((state) => {
      const nextTime = state.transport.currentTime;
      if (nextTime === previousTime) return;
      previousTime = nextTime;
      setRecordingRenderTime(nextTime);
    });

    return () => unsubscribe();
  }, [isRecording, recordingClips.length]);

  useEffect(() => {
    const recordingMIDITrackIds = recordingClips
      .map((clip) => clip.trackId)
      .filter((trackId) => {
        const track = tracks.find((candidate) => candidate.id === trackId);
        return track?.type === "midi" || track?.type === "instrument";
      });

    if (!isRecording || recordingMIDITrackIds.length === 0) {
      if (Object.keys(useDAWStore.getState().recordingMIDIPreviews).length > 0) {
        useDAWStore.setState({ recordingMIDIPreviews: {} });
      }
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const fetchRecordingMIDIPreviews = async () => {
      if (inFlight) return;
      inFlight = true;

      try {
        const state = useDAWStore.getState();
        const requests = recordingMIDITrackIds.map((trackId) => {
          const preview = state.recordingMIDIPreviews[trackId];
          return {
            trackId,
            generation: preview?.generation ?? 0,
            knownEventCount: preview?.totalEventCount ?? 0,
          };
        });

        const previews = await nativeBridge.getActiveRecordingMIDIPreviews(requests);
        if (cancelled || previews.length === 0) return;

        useDAWStore.setState((currentState) => {
          const nextPreviews = Object.fromEntries(
            recordingMIDITrackIds
              .filter((trackId) => currentState.recordingMIDIPreviews[trackId] !== undefined)
              .map((trackId) => [trackId, currentState.recordingMIDIPreviews[trackId]]),
          ) as typeof currentState.recordingMIDIPreviews;

          for (const preview of previews) {
            const existing = currentState.recordingMIDIPreviews[preview.trackId];
            const shouldReset =
              !existing ||
              existing.generation !== preview.generation ||
              existing.totalEventCount > preview.totalEventCount ||
              existing.recordingStartTime !== preview.recordingStartTime;

            const deltaEvents: MIDIEvent[] = preview.deltaEvents.map((event) => ({
              timestamp: event.timestamp,
              type: event.type as MIDIEvent["type"],
              note: event.note,
              velocity: event.velocity,
            }));

            nextPreviews[preview.trackId] = {
              generation: preview.generation,
              recordingStartTime: preview.recordingStartTime,
              totalEventCount: preview.totalEventCount,
              events: shouldReset ? deltaEvents : [...existing.events, ...deltaEvents],
              activeNotes: preview.activeNotes,
            };
          }

          return { recordingMIDIPreviews: nextPreviews };
        });
      } finally {
        inFlight = false;
      }
    };

    void fetchRecordingMIDIPreviews();
    const intervalId = window.setInterval(() => {
      void fetchRecordingMIDIPreviews();
    }, 150);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isRecording, recordingClips, tracks]);

  // Calculate stage height: fill available viewport space, or grow for content
  const bottomSpacerHeight = footerHeight + BOTTOM_INTERACTION_BUFFER;
  const rulerOffset = showRuler ? RULER_HEIGHT : 0;
  const availableHeight = dimensions.height - rulerOffset - footerHeight;
  const { trackYs, totalHeight: contentHeight } = useMemo(
    () => getTrackYPositions(tracks, trackHeight),
    [tracks, trackHeight],
  );
  // Master automation lanes add height below all tracks
  const masterVisibleLanes = useMemo(
    () => (masterAutomation?.showAutomation ? masterAutomation.lanes.filter((l) => l.visible) : []),
    [masterAutomation],
  );
  const masterAutoHeight = masterVisibleLanes.length > 0 ? trackHeight + masterVisibleLanes.length * AUTOMATION_LANE_HEIGHT : 0;
  const stageHeight = Math.max(
    contentHeight + masterAutoHeight + bottomSpacerHeight,
    availableHeight,
    200,
  );
  const timelineClipHitMap = useMemo(
    () => buildTimelineClipHitMap({
      tracks,
      trackYs,
      trackHeight,
      pixelsPerSecond,
      scrollX,
    }),
    [tracks, trackYs, trackHeight, pixelsPerSecond, scrollX],
  );

  // Refs for ruler drag to avoid stale closures in global listeners
  const projectRangeRef = useRef(projectRange);
  projectRangeRef.current = projectRange;
  const shouldUseSnapRef = useRef(snapEnabled);
  shouldUseSnapRef.current = snapEnabled;

  const isSnapActive = useCallback((ctrlBypass = false) => {
    return shouldUseSnapRef.current && !ctrlBypass;
  }, []);

  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;
  const snapTypeRef = useRef(snapType);
  snapTypeRef.current = snapType;
  const quantizePresetIdRef = useRef(quantizePresetId);
  quantizePresetIdRef.current = quantizePresetId;
  const quantizePresetsRef = useRef(quantizePresets);
  quantizePresetsRef.current = quantizePresets;
  const tempoRef = useRef(tempo);
  tempoRef.current = tempo;
  const timeSignatureRef = useRef(timeSignature);
  timeSignatureRef.current = timeSignature;
  const toolModeRef = useRef(toolMode);
  toolModeRef.current = toolMode;

  const timelineSnapEventTimes = useMemo(() => {
    const times: number[] = [];
    for (const track of tracks) {
      for (const clip of track.clips || []) {
        times.push(clip.startTime, clip.startTime + clip.duration);
      }
      for (const clip of track.midiClips || []) {
        const duration = clip.duration || clip.sourceLength || clip.loopLength || 0;
        times.push(clip.startTime, clip.startTime + duration);
      }
    }
    for (const marker of markers || []) {
      times.push(marker.time);
    }
    for (const region of regions || []) {
      times.push(region.startTime, region.endTime);
    }
    return times.filter((time) => Number.isFinite(time) && time >= 0);
  }, [markers, regions, tracks]);

  const snapTimelineTime = useCallback((time: number, originalTime?: number) => {
    const preset = getQuantizePresetById(quantizePresetsRef.current, quantizePresetIdRef.current);
    return snapTimeByType({
      time,
      originalTime,
      tempo: tempoRef.current,
      timeSignature: timeSignatureRef.current,
      gridSize: gridSizeRef.current,
      snapType: snapTypeRef.current,
      quantizePreset: preset,
      quantizeGridSize: preset.gridSize,
      pixelsPerSecond: pixelsPerSecondRef.current,
      cursorTime: useDAWStore.getState().transport.currentTime,
      eventTimes: timelineSnapEventTimes,
    });
  }, [timelineSnapEventTimes]);

  // Handle container resize using ResizeObserver for accurate detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    // Calculate available width from parent workspace minus track control panel
    // This is the single source of truth for available width
    const getAvailableWidth = () => {
      const workspace = container.closest(".workspace") as HTMLDivElement | null;
      if (!workspace) return 800; // Fallback

      // Calculate directly from parent - don't rely on container.clientWidth
      // which may not have shrunk yet due to CSS layout timing
      const workspaceWidth = workspace.clientWidth;
      const tcpWidth = useDAWStore.getState().tcpWidth + 4; // +4 for resize handle
      return Math.max(100, workspaceWidth - tcpWidth);
    };

    const updateDimensions = () => {
      const newWidth = getAvailableWidth();
      const workspace = container.closest(".workspace") as HTMLDivElement | null;
      const stickyHeader = workspace?.querySelector(
        ".workspace-sticky-header",
      ) as HTMLDivElement | null;
      const stickyHeaderHeight = stickyHeader?.offsetHeight ?? 0;
      const newHeight = workspace
        ? Math.max(0, workspace.clientHeight - stickyHeaderHeight)
        : container.clientHeight;

      setDimensions((prev) => {
        if (prev.width === newWidth && prev.height === newHeight) {
          return prev;
        }
        return { width: newWidth, height: newHeight };
      });
    };

    // Immediate update on resize with small debounce for performance
    const handleResize = () => {
      // Cancel pending timeout
      if (resizeTimeout) clearTimeout(resizeTimeout);

      // Immediate update for responsive feel
      updateDimensions();

      // Also schedule a follow-up update after layout settles
      resizeTimeout = setTimeout(updateDimensions, 100);
    };

    // Initial measurement
    updateDimensions();

    // Watch parent (workspace) for size changes - most reliable for shrinking
    const resizeObserver = new ResizeObserver(handleResize);
    const workspace = container.closest(".workspace");
    if (workspace) {
      resizeObserver.observe(workspace);
    }

    // Window resize as additional trigger
    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, []);

  // Re-measure when TCP width changes (draggable divider)
  useEffect(() => {
    let prevTcpWidth = useDAWStore.getState().tcpWidth;
    const unsub = useDAWStore.subscribe((state) => {
      if (state.tcpWidth === prevTcpWidth) return;
      prevTcpWidth = state.tcpWidth;
      const container = containerRef.current;
      if (!container) return;
      const workspace = container.closest(".workspace") as HTMLDivElement | null;
      if (!workspace) return;
      const stickyHeader = workspace.querySelector(
        ".workspace-sticky-header",
      ) as HTMLDivElement | null;
      const workspaceWidth = workspace.clientWidth;
      const newWidth = Math.max(100, workspaceWidth - state.tcpWidth - 4);
      const newHeight = Math.max(
        0,
        workspace.clientHeight - (stickyHeader?.offsetHeight ?? 0),
      );
      setDimensions((prev) => {
        if (prev.width === newWidth && prev.height === newHeight) return prev;
        return { width: newWidth, height: newHeight };
      });
    });
    return unsub;
  }, []);

  // Sync native vertical scroll (workspace's scrollTop) → store's scrollY
  // The workspace div has overflow-y: auto and handles vertical scrolling natively.
  // We need to sync scrollTop to scrollY so viewport culling and hit-testing work.
  useEffect(() => {
    const workspace = containerRef.current?.closest(".workspace");
    if (!workspace) return;
    const handleScroll = () => {
      const newScrollY = workspace.scrollTop;
      if (Math.abs(newScrollY - scrollY) > 0.5) {
        setScroll(scrollX, newScrollY);
      }
    };
    workspace.addEventListener("scroll", handleScroll, { passive: true });
    return () => workspace.removeEventListener("scroll", handleScroll);
  }, [scrollX, scrollY, setScroll]);

  // Handle scroll wheel for zoom with native listener to prevent browser zoom
  // Use requestAnimationFrame for smooth scrolling and zooming
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null);
  const pendingZoomRef = useRef<number | null>(null);
  const pendingTrackHeightRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const manualScrollLockUntilRef = useRef(0);

  // Accumulated zoom delta — coalesces rapid wheel events into one zoom per frame
  const accZoomDeltaRef = useRef(0);
  const zoomCursorXRef = useRef(0); // cursor X relative to container
  const ZOOM_SENSITIVITY = 0.0015;

  const applyPendingUpdates = useCallback(() => {
    // Compute zoom from accumulated delta (coalesces all wheel events this frame)
    if (accZoomDeltaRef.current !== 0) {
      const curZoom = pendingZoomRef.current ?? pixelsPerSecondRef.current;
      const factor = Math.exp(-accZoomDeltaRef.current * ZOOM_SENSITIVITY);
      const newZoom = Math.max(
        MIN_PIXELS_PER_SECOND,
        Math.min(MAX_PIXELS_PER_SECOND, curZoom * factor),
      );

      // Anchor zoom to cursor position — the time under the cursor stays fixed
      const cursorX = zoomCursorXRef.current;
      const curScrollX = pendingScrollRef.current?.x ?? scrollXRef.current;
      const timeAtCursor = (curScrollX + cursorX) / curZoom;
      const newScrollX = Math.max(0, timeAtCursor * newZoom - cursorX);

      pendingZoomRef.current = newZoom;
      pendingScrollRef.current = {
        x: newScrollX,
        y: pendingScrollRef.current?.y ?? scrollYRef.current,
      };
      accZoomDeltaRef.current = 0;
    }

    // Apply all pending state in one batch
    if (pendingZoomRef.current !== null) {
      setZoom(pendingZoomRef.current);
      pendingZoomRef.current = null;
    }
    if (pendingTrackHeightRef.current !== null) {
      setTrackHeight(pendingTrackHeightRef.current);
      pendingTrackHeightRef.current = null;
    }
    if (pendingScrollRef.current !== null) {
      setScroll(pendingScrollRef.current.x, pendingScrollRef.current.y);
      pendingScrollRef.current = null;
    }
    rafIdRef.current = null;
  }, [setScroll, setZoom, setTrackHeight]);

  const scheduleRAF = useCallback(() => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(applyPendingUpdates);
    }
  }, [applyPendingUpdates]);

  const queueScroll = useCallback(
    (
      newScrollX: number,
      newScrollY: number,
      options?: { suppressWaveformFetch?: boolean; isManual?: boolean },
    ) => {
      pendingScrollRef.current = { x: newScrollX, y: newScrollY };
      scheduleRAF();

      if (options?.isManual !== false) {
        manualScrollLockUntilRef.current = performance.now() + 250;
      }

      if (options?.suppressWaveformFetch === false) return;

      isScrollingRef.current = true;
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      scrollDebounceRef.current = setTimeout(() => {
        isScrollingRef.current = false;
        forceRender((n) => n + 1);
      }, 200);
    },
    [scheduleRAF],
  );

  const scheduleScroll = useCallback(
    (newScrollX: number, newScrollY: number) => {
      queueScroll(newScrollX, newScrollY, {
        suppressWaveformFetch: true,
        isManual: true,
      });
    },
    [queueScroll],
  );

  // Auto-scroll variant: batches via RAF like scheduleScroll but does NOT
  // suppress waveform fetches. Playback auto-scroll is incremental and
  // predictable — suppressing fetches here keeps isScrollingRef permanently
  // true during playback, which blocks zoom waveform updates.
  const scheduleFollowScroll = useCallback(
    (newScrollX: number, newScrollY: number) => {
      queueScroll(newScrollX, newScrollY, {
        suppressWaveformFetch: false,
        isManual: false,
      });
    },
    [queueScroll],
  );

  const scheduleTrackHeight = useCallback(
    (newHeight: number) => {
      pendingTrackHeightRef.current = newHeight;
      scheduleRAF();
    },
    [scheduleRAF],
  );

  // Cleanup RAF + zoom debounce on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (zoomDebounceRef.current) {
        clearTimeout(zoomDebounceRef.current);
      }
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
    };
  }, []);

  // Use refs so the wheel handler reads latest values without re-registering
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;
  const trackHeightRef = useRef(trackHeight);
  trackHeightRef.current = trackHeight;
  const trackYsRef = useRef(trackYs);
  trackYsRef.current = trackYs;
  const scrollXRef = useRef(scrollX);
  scrollXRef.current = scrollX;
  const scrollYRef = useRef(scrollY);
  scrollYRef.current = scrollY;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const contentHeightRef = useRef(contentHeight);
  contentHeightRef.current = contentHeight;
  const dimensionsWidthRef = useRef(dimensions.width);
  dimensionsWidthRef.current = dimensions.width;
  const setTrackWaveformZoomRef = useRef(setTrackWaveformZoom);
  setTrackWaveformZoomRef.current = setTrackWaveformZoom;

  const getAutomationDrawHit = useCallback((stageY: number) => {
    const absoluteY = stageY + scrollYRef.current;
    const hit = getTrackAtY(
      absoluteY,
      tracksRef.current,
      trackYsRef.current,
      trackHeightRef.current,
    );
    if (!hit || hit.isInClipArea || hit.laneIndex < 0) return null;

    const track = tracksRef.current[hit.trackIndex];
    if (!track?.showAutomation) return null;

    const visibleLanes = track.automationLanes.filter((lane) => lane.visible);
    const lane = visibleLanes[hit.laneIndex];
    if (!lane) return null;

    return {
      track,
      lane,
      trackIndex: hit.trackIndex,
      laneIndex: hit.laneIndex,
      laneTop: (trackYsRef.current[hit.trackIndex] ?? 0)
        + trackHeightRef.current
        + hit.laneIndex * AUTOMATION_LANE_HEIGHT,
    };
  }, []);

  const automationPointFromStagePosition = useCallback((
    stageX: number,
    stageY: number,
    laneTop: number,
  ): AutomationPoint => {
    const time = Math.max(0, (stageX + scrollXRef.current) / Math.max(1, pixelsPerSecondRef.current));
    const absoluteY = stageY + scrollYRef.current;
    const value = 1 - ((absoluteY - laneTop) / AUTOMATION_LANE_HEIGHT);
    return { time, value: clampAutomationValue(value) };
  }, []);

  const beginAutomationLaneDraw = useCallback((stageX: number, stageY: number) => {
    const hit = getAutomationDrawHit(stageY);
    if (!hit) return false;

    const firstPoint = automationPointFromStagePosition(stageX, stageY, hit.laneTop);
    const originalPoints = cloneAutomationPoints(hit.lane.points);
    const nextPoints = mergeAutomationDrawPoints(
      originalPoints,
      [firstPoint],
      pixelsPerSecondRef.current,
    );
    const oldTrackRead = typeof hit.track.automationReadEnabled === "boolean"
      ? hit.track.automationReadEnabled
      : Boolean(hit.track.automationEnabled);
    const oldLaneRead = hit.lane.readEnabled ?? hit.lane.mode !== "off";

    automationDrawRef.current = {
      trackId: hit.track.id,
      laneId: hit.lane.id,
      laneParam: hit.lane.param,
      trackIndex: hit.trackIndex,
      laneIndex: hit.laneIndex,
      originalPoints,
      points: nextPoints,
      oldTrackRead,
      oldTrackWrite: hit.track.automationWriteEnabled === true,
      oldLaneRead,
      oldLaneMode: hit.lane.mode,
      lastPoint: firstPoint,
    };

    useDAWStore.getState().setAutomationLanePoints(hit.track.id, hit.lane.id, nextPoints);
    return true;
  }, [automationPointFromStagePosition, getAutomationDrawHit]);

  const continueAutomationLaneDraw = useCallback((stageX: number, stageY: number) => {
    const draw = automationDrawRef.current;
    if (!draw) return false;

    const laneTop = (trackYsRef.current[draw.trackIndex] ?? 0)
      + trackHeightRef.current
      + draw.laneIndex * AUTOMATION_LANE_HEIGHT;
    const nextPoint = automationPointFromStagePosition(stageX, stageY, laneTop);
    const additions = interpolateAutomationDrawSegment(
      draw.lastPoint,
      nextPoint,
      pixelsPerSecondRef.current,
    );
    if (additions.length === 0) return true;

    const nextPoints = mergeAutomationDrawPoints(
      draw.points,
      additions,
      pixelsPerSecondRef.current,
    );
    draw.points = nextPoints;
    draw.lastPoint = nextPoint;
    useDAWStore.getState().setAutomationLanePoints(draw.trackId, draw.laneId, nextPoints);
    return true;
  }, [automationPointFromStagePosition]);

  const finishAutomationLaneDraw = useCallback(() => {
    const draw = automationDrawRef.current;
    if (!draw) return false;

    automationDrawRef.current = null;
    const originalSignature = JSON.stringify(draw.originalPoints);
    const nextSignature = JSON.stringify(draw.points);
    if (originalSignature !== nextSignature) {
      useDAWStore.getState().setAutomationLanePoints(draw.trackId, draw.laneId, draw.points, {
        undoable: true,
        description: `Draw ${getAutomationShortLabel(draw.laneParam)} automation`,
        oldPoints: draw.originalPoints,
        oldTrackRead: draw.oldTrackRead,
        oldTrackWrite: draw.oldTrackWrite,
        oldLaneRead: draw.oldLaneRead,
        oldLaneMode: draw.oldLaneMode,
      });
    }
    marqueeJustCompletedRef.current = true;
    setHoveredAutoPoint(null);
    return true;
  }, []);

  const externalMediaPreviewRef = useRef<ExternalMediaDropPreview | null>(null);
  externalMediaPreviewRef.current = externalMediaPreview;
  const externalMediaDragContextRef = useRef<ExternalMediaDragContext | null>(null);
  const requestedExternalPreviewIdsRef = useRef<Set<string>>(new Set());

  const getSupportedExternalMediaFiles = useCallback((files: ExternalMediaDragEvent["files"] | undefined) => {
    const inputFiles = files ?? [];
    return inputFiles.filter((file) => {
      const ext = getExternalMediaFileExtension(file);
      return EXTERNAL_MEDIA_EXTENSIONS.has(ext);
    });
  }, []);

  const getFirstSupportedExternalMediaFile = useCallback((event: ExternalMediaDragEvent) => {
    const eventFiles = getSupportedExternalMediaFiles(event.files);
    if (eventFiles.length > 0) return eventFiles[0];
    const context = externalMediaDragContextRef.current;
    if (context?.dragId === event.dragId) {
      return getSupportedExternalMediaFiles(context.files)[0] ?? null;
    }
    return null;
  }, [getSupportedExternalMediaFiles]);

  const getExternalMediaEventFiles = useCallback((event: ExternalMediaDragEvent) => {
    const eventFiles = getSupportedExternalMediaFiles(event.files);
    if (eventFiles.length > 0) return eventFiles;
    const context = externalMediaDragContextRef.current;
    if (context?.dragId === event.dragId) {
      return getSupportedExternalMediaFiles(context.files);
    }
    return [];
  }, [getSupportedExternalMediaFiles]);

  const isExternalTrackCompatible = useCallback((track: Track | undefined, mediaKind: ExternalMediaKind) => {
    if (!track) return false;
    return mediaKind === "midi"
      ? track.type === "midi" || track.type === "instrument"
      : track.type !== "midi" && track.type !== "instrument";
  }, []);

  const resolveExternalMediaDropTarget = useCallback((
    absoluteY: number,
    mediaKind: ExternalMediaKind,
    midiTrackCount = 1,
  ): ExternalMediaDropTarget => {
    const currentTracks = tracksRef.current;
    const currentTrackYs = trackYsRef.current;
    const currentTrackHeight = trackHeightRef.current;
    if (currentTracks.length === 0) return { kind: "insertTrack", insertIndex: 0 };

    const halfBand = EXTERNAL_TRACK_INSERT_BAND_PX / 2;
    for (let index = 1; index < currentTracks.length; index += 1) {
      const dividerY = currentTrackYs[index] ?? 0;
      if (Math.abs(absoluteY - dividerY) <= halfBand) {
        return { kind: "insertTrack", insertIndex: index };
      }
    }

    if (absoluteY >= contentHeightRef.current - halfBand) {
      return { kind: "insertTrack", insertIndex: currentTracks.length };
    }

    const hit = getTrackAtY(absoluteY, currentTracks, currentTrackYs, currentTrackHeight);
    if (!hit) {
      return { kind: "insertTrack", insertIndex: absoluteY >= contentHeightRef.current ? currentTracks.length : 0 };
    }

    const hitTrack = currentTracks[hit.trackIndex];
    const needsTrackInsertion =
      !isExternalTrackCompatible(hitTrack, mediaKind) ||
      (mediaKind === "midi" && midiTrackCount > 1);

    return needsTrackInsertion
      ? { kind: "insertTrack", insertIndex: hit.trackIndex }
      : { kind: "existingTrack", trackIndex: hit.trackIndex };
  }, [isExternalTrackCompatible]);

  const getNormalizedExternalDragPoint = useCallback((event: ExternalMediaDragEvent, rect: DOMRect) => {
    const nativeClientX = typeof event.nativeClientX === "number" ? event.nativeClientX : event.clientX;
    const nativeClientY = typeof event.nativeClientY === "number" ? event.nativeClientY : event.clientY;
    const scale = event.deviceScaleFactor || window.devicePixelRatio || 1;

    let clientX = nativeClientX / scale;
    let clientY = nativeClientY / scale;
    const scaledInside =
      clientX >= rect.left - 2 &&
      clientX <= rect.right + 2 &&
      clientY >= rect.top - 2 &&
      clientY <= rect.bottom + 2;
    const rawInside =
      nativeClientX >= rect.left - 2 &&
      nativeClientX <= rect.right + 2 &&
      nativeClientY >= rect.top - 2 &&
      nativeClientY <= rect.bottom + 2;

    if (!scaledInside && rawInside) {
      clientX = nativeClientX;
      clientY = nativeClientY;
    }

    return {
      clientX,
      clientY,
      nativeClientX,
      nativeClientY,
      scale,
      localX: clientX - rect.left,
      localY: clientY - rect.top,
    };
  }, []);

  const buildExternalMediaPreview = useCallback((event: ExternalMediaDragEvent): ExternalMediaDropPreview | null => {
    const file = getFirstSupportedExternalMediaFile(event);
    const container = containerRef.current;
    if (!file || !container) return null;

    const rect = container.getBoundingClientRect();
    const point = getNormalizedExternalDragPoint(event, rect);
    const localX = point.localX;
    const stageY = point.localY - (showRuler ? RULER_HEIGHT : 0);
    if (localX < 0 || localX > rect.width || stageY < 0) return null;

    const absoluteY = stageY + scrollYRef.current;
    const timelineLocalX = Math.abs(localX) <= 8 ? 0 : localX;
    const rawStartTime = Math.max(0, (timelineLocalX + scrollXRef.current) / pixelsPerSecondRef.current);
    const startTime = snapEnabled
      ? snapTimelineTime(rawStartTime)
      : rawStartTime;
    const context = externalMediaDragContextRef.current;
    const mediaKind = context?.filePath === file.path ? context.mediaKind : getExternalMediaKind(file);
    const midiTracks = context?.filePath === file.path ? getNonEmptyExternalMIDITracks(context.midiTracks) : [];
    const midiTrackCount = mediaKind === "midi" ? Math.max(1, context?.midiTrackCount || midiTracks.length || 1) : undefined;
    const target = resolveExternalMediaDropTarget(absoluteY, mediaKind, midiTrackCount);
    const firstMidiTrack = midiTracks[0];

    if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
      console.debug("[audio.import] external drag coordinates", {
        dragId: event.dragId,
        mediaKind,
        target,
        nativeClientX: point.nativeClientX,
        nativeClientY: point.nativeClientY,
        scale: point.scale,
        cssClientX: point.clientX,
        cssClientY: point.clientY,
        rectLeft: rect.left,
        rectTop: rect.top,
        localX,
        stageY,
        rawStartTime,
        startTime,
      });
    }

    return {
      dragId: event.dragId,
      filePath: file.path,
      name: file.name.replace(/\.[^.]+$/, "") || file.name,
      mediaKind,
      target,
      startTime,
      duration: context?.filePath === file.path && context.duration
        ? context.duration
        : mediaKind === "midi"
          ? getExternalMIDITrackDuration(firstMidiTrack)
        : externalMediaPreviewRef.current?.filePath === file.path
          ? externalMediaPreviewRef.current.duration
          : 4,
      peaks: context?.filePath === file.path && context.peaks
        ? context.peaks
        : externalMediaPreviewRef.current?.filePath === file.path
          ? externalMediaPreviewRef.current.peaks
          : undefined,
      sampleRate: context?.filePath === file.path && context.sampleRate
        ? context.sampleRate
        : externalMediaPreviewRef.current?.filePath === file.path
          ? externalMediaPreviewRef.current.sampleRate
          : undefined,
      midiEvents: context?.filePath === file.path && context.midiEvents
        ? context.midiEvents
        : mediaKind === "midi"
          ? normalizeExternalMIDIEvents(firstMidiTrack?.events ?? [])
          : undefined,
      midiTrackCount,
    };
  }, [getFirstSupportedExternalMediaFile, getNormalizedExternalDragPoint, isExternalTrackCompatible, resolveExternalMediaDropTarget, showRuler, snapEnabled, snapTimelineTime]);

  useEffect(() => {
    const requestPreviewData = (dragId: string, filePath: string, mediaKind: ExternalMediaKind) => {
      if (requestedExternalPreviewIdsRef.current.has(dragId)) return;
      requestedExternalPreviewIdsRef.current.add(dragId);

      if (mediaKind === "midi") {
        void nativeBridge.importMIDIFile(filePath).then((info) => {
          if (!info.success) return;
          const nonEmptyTracks = getNonEmptyExternalMIDITracks(info.tracks);
          const firstTrack = nonEmptyTracks[0];
          const duration = Math.max(0.25, ...nonEmptyTracks.map(getExternalMIDITrackDuration), 4);
          const midiEvents = normalizeExternalMIDIEvents(firstTrack?.events ?? []);
          const context = externalMediaDragContextRef.current;
          if (context?.dragId === dragId && context.filePath === filePath) {
            context.midiTracks = nonEmptyTracks;
            context.midiTrackCount = Math.max(1, nonEmptyTracks.length);
            context.midiEvents = midiEvents;
            context.duration = duration;
          }
          setExternalMediaPreview((current) =>
            current?.dragId === dragId && current.filePath === filePath
              ? {
                  ...current,
                  duration,
                  midiEvents,
                  midiTrackCount: Math.max(1, nonEmptyTracks.length),
                }
              : current,
          );
        }).catch(() => {});
        return;
      }

      void nativeBridge.probeMediaFile(filePath).then((info) => {
        if (!info) return;
        const context = externalMediaDragContextRef.current;
        if (context?.dragId === dragId && context.filePath === filePath) {
          context.duration = Math.max(0.25, info.duration || context.duration || 4);
          context.sampleRate = info.sampleRate || context.sampleRate;
        }
        setExternalMediaPreview((current) =>
          current?.dragId === dragId && current.filePath === filePath
            ? {
                ...current,
                duration: Math.max(0.25, info.duration || current.duration),
                sampleRate: info.sampleRate || current.sampleRate,
              }
            : current,
        );
      }).catch(() => {});

      void nativeBridge.requestWaveformPreview(filePath, dragId, 640);
    };

    const ensureDragContext = (event: ExternalMediaDragEvent): ExternalMediaDragContext | null => {
      const files = getExternalMediaEventFiles(event);
      const file = files[0] ?? null;
      if (!file) {
        return externalMediaDragContextRef.current?.dragId === event.dragId
          ? externalMediaDragContextRef.current
          : null;
      }

      const existing = externalMediaDragContextRef.current;
      const mediaKind = getExternalMediaKind(file);
      const context: ExternalMediaDragContext =
        existing?.dragId === event.dragId && existing.filePath === file.path
          ? { ...existing, files }
          : {
              dragId: event.dragId,
              files,
              filePath: file.path,
              name: file.name.replace(/\.[^.]+$/, "") || file.name,
              mediaKind,
            };
      externalMediaDragContextRef.current = context;
      requestPreviewData(context.dragId, context.filePath, context.mediaKind);
      return context;
    };

    const onEnter = (event: ExternalMediaDragEvent) => {
      const context = ensureDragContext(event);
      if (!context) return;
      const preview = buildExternalMediaPreview(event);
      if (preview) setExternalMediaPreview(preview);
      console.log("[audio.import] external drag entered", {
        filePath: context.filePath,
        previewVisible: Boolean(preview),
      });
    };

    const onMove = (event: ExternalMediaDragEvent) => {
      ensureDragContext(event);
      const preview = buildExternalMediaPreview(event);
      if (preview) setExternalMediaPreview(preview);
    };

    const clearDragContext = (dragId?: string) => {
      const targetDragId = dragId || externalMediaDragContextRef.current?.dragId;
      if (targetDragId) {
        void nativeBridge.cancelWaveformPreview(targetDragId);
        requestedExternalPreviewIdsRef.current.delete(targetDragId);
      }
      externalMediaDragContextRef.current = null;
      setExternalMediaPreview(null);
    };

    const onLeave = (event: ExternalMediaDragEvent) => {
      clearDragContext(event?.dragId);
    };

    const onDrop = (event: ExternalMediaDragEvent) => {
      const context = ensureDragContext(event);
      const preview = buildExternalMediaPreview(event) ?? externalMediaPreviewRef.current;
      const mediaFiles = getExternalMediaEventFiles(event);
      if (!context || !preview || mediaFiles.length === 0) {
        clearDragContext(event?.dragId);
        return;
      }

      console.log("[audio.import] external drop committed", {
        count: mediaFiles.length,
        mediaKind: preview.mediaKind,
        target: preview.target,
        startTime: Number(preview.startTime.toFixed(3)),
      });

      mediaFiles.forEach((file, index) => {
        const mediaKind = getExternalMediaKind(file);
        const name = file.name.replace(/\.[^.]+$/, "") || file.name;
        if (mediaKind === "midi") {
          const targetTrack =
            preview.target.kind === "existingTrack"
              ? tracksRef.current[preview.target.trackIndex]
              : undefined;
          const useExisting =
            index === 0 &&
            targetTrack &&
            isExternalTrackCompatible(targetTrack, "midi") &&
            (preview.midiTrackCount ?? 1) <= 1;
          const insertIndex = preview.target.kind === "insertTrack"
            ? preview.target.insertIndex + index
            : preview.target.kind === "existingTrack"
              ? preview.target.trackIndex + index
              : tracksRef.current.length + index;

          void importExternalMIDIAtTimeline({
            filePath: file.path,
            name,
            targetTrackId: useExisting ? targetTrack.id : undefined,
            insertIndex: useExisting ? undefined : insertIndex,
            startTime: preview.startTime,
            parsedTracks: index === 0 && context.filePath === file.path && context.midiTracks && context.midiTracks.length > 0
              ? context.midiTracks
              : undefined,
          }).catch((error) => console.error("[Timeline] External MIDI drop import failed", error));
          return;
        }

        const targetTrack =
          preview.target.kind === "existingTrack"
            ? tracksRef.current[preview.target.trackIndex]
            : undefined;
        const useExisting =
          index === 0 &&
          targetTrack &&
          isExternalTrackCompatible(targetTrack, "audio");
        const insertIndex = preview.target.kind === "insertTrack"
          ? preview.target.insertIndex + index
          : preview.target.kind === "existingTrack"
            ? preview.target.trackIndex + index
            : tracksRef.current.length + index;

        void importExternalMediaAtTimeline({
          filePath: file.path,
          name,
          trackId: useExisting ? targetTrack.id : undefined,
          insertIndex: useExisting ? undefined : insertIndex,
          startTime: preview.startTime,
          duration: index === 0 ? preview.duration : undefined,
          sampleRate: index === 0 ? preview.sampleRate : undefined,
          waveformStatus: index === 0 && preview.peaks ? "preview" : "building",
        }).catch((error) => console.error("[audio.import] external drop import failed", error));
      });

      clearDragContext(preview.dragId);
    };

    const unsubscribers = [
      nativeBridge.onExternalMediaDragEnter(onEnter),
      nativeBridge.onExternalMediaDragMove(onMove),
      nativeBridge.onExternalMediaDragLeave(onLeave),
      nativeBridge.onExternalMediaDrop(onDrop),
      nativeBridge.onWaveformPreviewReady((data) => {
        if (data.filePath && data.peaks.length > 0) {
          setWaveformPreviewCache((prev) => {
            const next = new Map(prev);
            next.set(data.filePath, data.peaks);
            if (next.size > 32) {
              const oldest = next.keys().next().value;
              if (oldest) next.delete(oldest);
            }
            return next;
          });
        }

        const context = externalMediaDragContextRef.current;
        if (context?.dragId === data.requestId && context.filePath === data.filePath) {
          context.peaks = data.peaks;
          context.duration = Math.max(0.25, data.duration || context.duration || 4);
          context.sampleRate = data.sampleRate || context.sampleRate;
        }

        setExternalMediaPreview((current) =>
          current?.dragId === data.requestId && current.filePath === data.filePath
            ? {
                ...current,
                peaks: data.peaks,
                duration: Math.max(0.25, data.duration || current.duration),
                sampleRate: data.sampleRate || current.sampleRate,
              }
            : current,
        );
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [buildExternalMediaPreview, getExternalMediaEventFiles, importExternalMIDIAtTimeline, importExternalMediaAtTimeline, isExternalTrackCompatible]);

  const findCurrentTimelineClip = useCallback((clipId: string) => {
    for (let trackIndex = 0; trackIndex < useDAWStore.getState().tracks.length; trackIndex += 1) {
      const track = useDAWStore.getState().tracks[trackIndex];
      const audioClip = track.clips.find((candidate) => candidate.id === clipId);
      if (audioClip) {
        return { kind: "audio" as const, track, trackIndex, clip: audioClip };
      }
      const midiClip = track.midiClips.find((candidate) => candidate.id === clipId);
      if (midiClip) {
        return { kind: "midi" as const, track, trackIndex, clip: midiClip };
      }
    }
    return null;
  }, []);

  const beginExternalMIDIClipFileDrag = useCallback((clipId: string) => {
    if (externalMidiDragRef.current) return;

    const found = findCurrentTimelineClip(clipId);
    if (!found || found.kind !== "midi") return;

    externalMidiDragRef.current = { clipId };
    restoreTimelineGestureUndo();
    clearTimelineGestureUndo();
    resetDragState();

    const state = useDAWStore.getState();
    const track = state.tracks.find((candidate) => candidate.id === found.track.id);
    const midiClip = track?.midiClips.find((candidate) => candidate.id === clipId);
    if (!track || !midiClip) {
      externalMidiDragRef.current = null;
      return;
    }

    const exportClip = { ...midiClip, startTime: 0 };
    const exported = serializeMIDIClipsForBackend([exportClip], track.midiEffects || [])[0];
    const defaultFileName = `${midiClip.name || "MIDI Clip"}.mid`;
    const midiTracks = [{
      name: track.name || "MIDI Track",
      clips: [{
        startTime: 0,
        duration: exported?.duration ?? midiClip.duration,
        events: exported?.events ?? getVisibleMIDIEventsForClip(midiClip),
      }],
    }];

    void (async () => {
      const prepared = await nativeBridge.prepareExternalMIDIFileDrag(defaultFileName, midiTracks);
      if (!prepared.success || !prepared.filePath) {
        useDAWStore.getState().showToast(prepared.error || "Failed to prepare MIDI drag export", "error");
        return;
      }

      const started = await nativeBridge.beginExternalFileDrag(prepared.filePath);
      if (!started) {
        useDAWStore.getState().showToast("Could not start external MIDI drag", "error");
      }
    })().finally(() => {
      externalMidiDragRef.current = null;
    });
  }, [
    clearTimelineGestureUndo,
    findCurrentTimelineClip,
    resetDragState,
    restoreTimelineGestureUndo,
  ]);

  const getTimelineDropTrackIndex = useCallback((
    absoluteY: number,
    currentTracks = tracksRef.current,
    currentTrackYs = trackYsRef.current,
    currentTrackHeight = trackHeightRef.current,
  ) => {
    if (currentTracks.length === 0) return 0;
    const hit = getTrackAtY(absoluteY, currentTracks, currentTrackYs, currentTrackHeight);
    if (hit?.isInClipArea) return hit.trackIndex;
    if (absoluteY >= contentHeightRef.current) return currentTracks.length;
    return hit?.trackIndex ?? Math.max(0, currentTracks.length - 1);
  }, []);

  const previewTimelineGestureFromPointer = useCallback((stageX: number, stageY: number, ctrlBypass: boolean) => {
    const gesture = dragStateRef.current;
    if (!gesture.clipId || gesture.type === null || gesture.isFadeDrag) return;
    const found = findCurrentTimelineClip(gesture.clipId);
    if (!found) return;

    const pps = pixelsPerSecondRef.current;
    const deltaTime = (stageX - gesture.startX) / pps;
    const isMidi = found.kind === "midi";

    if (gesture.type === "resize-left" || gesture.type === "resize-right") {
      const nextValues = computeTimelineResize({
        kind: gesture.type,
        isMidi,
        originalStartTime: gesture.originalStartTime,
        originalDuration: gesture.originalDuration,
        originalOffset: gesture.originalOffset,
        deltaTime,
        sourceLength: found.clip.sourceLength,
        snapTime: isSnapActive(ctrlBypass)
          ? (time) => snapTimelineTime(time, gesture.originalStartTime)
          : undefined,
      });
      previewResizeTimelineClip(gesture.clipId, isMidi, nextValues);
      return;
    }

    const rawStartTime = Math.max(0, gesture.originalStartTime + deltaTime);
    const newStartTime = computeTimelineMoveStart(
      gesture.originalStartTime,
      deltaTime,
      isSnapActive(ctrlBypass)
        ? (time) => snapTimelineTime(time, gesture.originalStartTime)
        : undefined,
    );
    const latestTracks = tracksRef.current;
    const targetTrackIdx = getTimelineDropTrackIndex(stageY + scrollYRef.current, latestTracks, trackYsRef.current, trackHeightRef.current);
    const clampedTarget = Math.max(0, targetTrackIdx);
    const timeDelta = newStartTime - gesture.originalStartTime;

    if (gesture.copyOnDrag) {
      const targetTrack = latestTracks[Math.max(0, Math.min(targetTrackIdx, latestTracks.length - 1))];
      const targetMetrics = targetTrack
        ? getTimelineRowMetrics(targetTrack, trackHeightRef.current)
        : getTimelineRowMetrics(found.track, trackHeightRef.current);
      snapGhostRef.current = {
        x: newStartTime * pps - scrollXRef.current,
        y: (targetTrackIdx >= latestTracks.length
          ? contentHeightRef.current
          : (trackYsRef.current[Math.max(0, targetTrackIdx)] ?? 0)) + targetMetrics.clipInsetY,
        width: found.clip.duration * pps,
        height: targetMetrics.clipHeight,
        color: found.clip.color || found.track.color,
        visible: true,
      };
      setSnapGhostRender(snapGhostRef.current);
      setShowGhostTrack(targetTrackIdx >= latestTracks.length);
      if (
        clampedTarget !== gesture.targetTrackIndex
        || Math.abs((gesture.previewStartTime ?? gesture.originalStartTime) - newStartTime) > 0.0001
      ) {
        setTimelineDragState((previous) => ({
          ...previous,
          targetTrackIndex: clampedTarget,
          previewStartTime: newStartTime,
        }));
      }
      return;
    }

    const multi = gesture.multiClipInfo && gesture.multiClipInfo.length > 1;
    const trackDelta = targetTrackIdx - (gesture.trackIndex ?? found.trackIndex);
    const needsGhost = multi
      ? Math.max(...gesture.multiClipInfo!.map((info) => info.trackIndex)) + trackDelta >= latestTracks.length
      : targetTrackIdx >= latestTracks.length;
    setShowGhostTrack(needsGhost);

    if (isSnapActive(ctrlBypass) && Math.abs(newStartTime - rawStartTime) > 0.001) {
      const targetTrack = latestTracks[Math.max(0, Math.min(targetTrackIdx, latestTracks.length - 1))];
      const targetMetrics = targetTrack
        ? getTimelineRowMetrics(targetTrack, trackHeightRef.current)
        : getTimelineRowMetrics(found.track, trackHeightRef.current);
      snapGhostRef.current = {
        x: newStartTime * pps - scrollXRef.current,
        y: (trackYsRef.current[Math.max(0, targetTrackIdx)] ?? 0) + targetMetrics.clipInsetY,
        width: found.clip.duration * pps,
        height: targetMetrics.clipHeight,
        color: found.clip.color || found.track.color,
        visible: true,
      };
      setSnapGhostRender(snapGhostRef.current);
    } else if (snapGhostRef.current) {
      snapGhostRef.current = null;
      setSnapGhostRender(null);
    }

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          const info = gesture.multiClipInfo?.find((candidate) => candidate.clipId === clip.id && !candidate.isMidi);
          if (multi && info) return { ...clip, startTime: Math.max(0, info.originalStartTime + timeDelta) };
          if (!multi && clip.id === gesture.clipId && !isMidi) return { ...clip, startTime: newStartTime };
          return clip;
        }),
        midiClips: track.midiClips.map((clip) => {
          const info = gesture.multiClipInfo?.find((candidate) => candidate.clipId === clip.id && candidate.isMidi);
          if (multi && info) return { ...clip, startTime: Math.max(0, info.originalStartTime + timeDelta) };
          if (!multi && clip.id === gesture.clipId && isMidi) return { ...clip, startTime: newStartTime };
          return clip;
        }),
      })),
      isModified: true,
    }));

    if (clampedTarget !== gesture.targetTrackIndex) {
      setTimelineDragState((previous) => ({ ...previous, targetTrackIndex: clampedTarget }));
    }
  }, [
    findCurrentTimelineClip,
    getTimelineDropTrackIndex,
    isSnapActive,
    previewResizeTimelineClip,
    setTimelineDragState,
  ]);

  const finalizeSlipTimelineGesture = useCallback(() => {
    const edit = slipEditRef.current;
    if (!edit) return false;

    const currentClip = useDAWStore.getState().tracks
      .flatMap((track) => (edit.isMidi ? track.midiClips : track.clips) as Array<AudioClip | MIDIClip>)
      .find((clip) => clip.id === edit.clipId);
    const finalOffset = currentClip?.offset ?? edit.originalOffset;

    if (Math.abs(finalOffset - edit.originalOffset) > 0.000001) {
      useDAWStore.setState((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: edit.isMidi
            ? track.clips
            : track.clips.map((clip) =>
                clip.id === edit.clipId ? { ...clip, offset: edit.originalOffset } : clip,
              ),
          midiClips: edit.isMidi
            ? track.midiClips.map((clip) =>
                clip.id === edit.clipId ? { ...clip, offset: edit.originalOffset } : clip,
              )
            : track.midiClips,
        })),
      }));
      slipEditClip(edit.clipId, finalOffset);
    }

    clearTimelineGestureUndo();
    slipEditRef.current = null;
    return true;
  }, [clearTimelineGestureUndo, slipEditClip]);

  const finalizeTimelineClipGesture = useCallback(async () => {
    const gesture = dragStateRef.current;
    if (!gesture.clipId || gesture.type === null) return false;

    const found = findCurrentTimelineClip(gesture.clipId);
    if (!found) {
      resetDragState();
      return false;
    }
    if (gesture.isFadeDrag) {
      clearTimelineGestureUndo();
      resetDragState();
      return true;
    }

    const isMidi = found.kind === "midi";
    const anchorTrackIdx = gesture.trackIndex ?? found.trackIndex;
    const targetIdx = gesture.targetTrackIndex ?? anchorTrackIdx;
    const latestTracks = useDAWStore.getState().tracks;
    const trackDelta = targetIdx - anchorTrackIdx;

    if (gesture.type === "resize-left" || gesture.type === "resize-right") {
      commitPreviewedResizeTimelineClip(gesture.clipId, isMidi, {
        startTime: gesture.originalStartTime,
        duration: gesture.originalDuration,
        offset: gesture.originalOffset,
      });
      await syncClipsWithBackend();
      clearTimelineGestureUndo();
      resetDragState();
      return true;
    }

    if (gesture.copyOnDrag) {
      const copyStartTime = gesture.previewStartTime ?? gesture.originalStartTime;
      const copyMovedPixels = Math.abs(copyStartTime - gesture.originalStartTime) * pixelsPerSecondRef.current;
      if (copyMovedPixels <= 4 && targetIdx === anchorTrackIdx && !showGhostTrack) {
        clearTimelineGestureUndo();
        resetDragState();
        return true;
      }

      let targetTrackId = latestTracks[Math.max(0, Math.min(targetIdx, latestTracks.length - 1))]?.id;
      const targetTrack = latestTracks.find((track) => track.id === targetTrackId);
      const compatible = targetTrack
        ? isMidi
          ? targetTrack.type === "midi" || targetTrack.type === "instrument"
          : targetTrack.type !== "midi" && targetTrack.type !== "instrument"
        : false;

      if (showGhostTrack || !targetTrackId || !compatible) {
        const backendTrackId = await nativeBridge.addTrack(undefined, isMidi ? "midi" : found.track.type);
        addTrack({
          id: backendTrackId,
          name: `Track ${useDAWStore.getState().tracks.length + 1}`,
          type: isMidi ? "midi" : found.track.type,
        });
        targetTrackId = backendTrackId;
      }

      if (targetTrackId) {
        duplicateClipToPosition(gesture.clipId, targetTrackId, copyStartTime);
      }
      await syncClipsWithBackend();
      clearTimelineGestureUndo();
      resetDragState();
      return true;
    }

    const multi = gesture.multiClipInfo && gesture.multiClipInfo.length > 1;
    if (multi) {
      const sorted = [...gesture.multiClipInfo!].sort((a, b) => a.trackIndex - b.trackIndex);
      const createdTracks = new Map<number, string>();
      for (const info of sorted) {
        const desiredTrackIdx = info.trackIndex + trackDelta;
        if (desiredTrackIdx === info.trackIndex) continue;

        const currentTracks = useDAWStore.getState().tracks;
        const sourceTrack = currentTracks[info.trackIndex];
        let targetTrackId: string | undefined;
        const existingTarget = currentTracks[desiredTrackIdx];
        if (existingTarget && sourceTrack) {
          const compatible = info.isMidi
            ? existingTarget.type === "midi" || existingTarget.type === "instrument"
            : existingTarget.type !== "midi" && existingTarget.type !== "instrument";
          if (compatible) targetTrackId = existingTarget.id;
        }

        if (!targetTrackId) {
          if (createdTracks.has(desiredTrackIdx)) {
            targetTrackId = createdTracks.get(desiredTrackIdx);
          } else {
            const backendTrackId = await nativeBridge.addTrack(
              undefined,
              info.isMidi ? "midi" : sourceTrack?.type || "audio",
            );
            addTrack({
              id: backendTrackId,
              name: `Track ${useDAWStore.getState().tracks.length + 1}`,
              type: info.isMidi ? "midi" : sourceTrack?.type || "audio",
            });
            createdTracks.set(desiredTrackIdx, backendTrackId);
            targetTrackId = backendTrackId;
          }
        }

        const currentClip = useDAWStore.getState().tracks
          .flatMap((track) => [...track.clips, ...track.midiClips])
          .find((clip) => clip.id === info.clipId);
        if (currentClip && targetTrackId) {
          await moveClipToTrack(info.clipId, targetTrackId, currentClip.startTime);
        }
      }
    } else if (showGhostTrack) {
      const backendTrackId = await nativeBridge.addTrack(undefined, isMidi ? "midi" : found.track.type);
      addTrack({
        id: backendTrackId,
        name: `Track ${latestTracks.length + 1}`,
        type: isMidi ? "midi" : found.track.type,
      });
      await moveClipToTrack(gesture.clipId, backendTrackId, found.clip.startTime);
    } else if (targetIdx !== found.trackIndex && targetIdx >= 0 && targetIdx < latestTracks.length) {
      const targetTrack = latestTracks[targetIdx];
      const compatible = isMidi
        ? targetTrack.type === "midi" || targetTrack.type === "instrument"
        : targetTrack.type !== "midi" && targetTrack.type !== "instrument";
      if (compatible) {
        await moveClipToTrack(gesture.clipId, targetTrack.id, found.clip.startTime);
      }
    }

    await syncClipsWithBackend();
    commitTimelineGestureUndo(multi ? "Move timeline clips" : isMidi ? "Move MIDI clip" : "Move timeline clip");
    resetDragState();
    return true;
  }, [
    addTrack,
    clearTimelineGestureUndo,
    commitPreviewedResizeTimelineClip,
    commitTimelineGestureUndo,
    duplicateClipToPosition,
    findCurrentTimelineClip,
    moveClipToTrack,
    resetDragState,
    showGhostTrack,
    syncClipsWithBackend,
  ]);

  useEffect(() => {
    const toStagePoint = (event: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    };

    const handleWindowMouseMove = (event: MouseEvent) => {
      const point = toStagePoint(event);
      if (!point) return;

      const activeDrag = dragStateRef.current;
      if (activeDrag.type !== null && activeDrag.clipId) {
        const rect = containerRef.current?.getBoundingClientRect();
        const isOutsideWindow =
          rect &&
          (event.clientX < rect.left - 12 ||
            event.clientX > rect.right + 12 ||
            event.clientY < rect.top - 12 ||
            event.clientY > rect.bottom + 12);
        if (
          isOutsideWindow &&
          activeDrag.type === "move" &&
          !activeDrag.copyOnDrag &&
          (!activeDrag.multiClipInfo || activeDrag.multiClipInfo.length <= 1)
        ) {
          const found = findCurrentTimelineClip(activeDrag.clipId);
          if (found?.kind === "midi") {
            beginExternalMIDIClipFileDrag(activeDrag.clipId);
            return;
          }
        }

        previewTimelineGestureFromPointer(point.x, point.y, Boolean(event.ctrlKey || event.metaKey));
      }

      const slipEdit = slipEditRef.current;
      if (slipEdit) {
        const deltaTime = (point.x - slipEdit.startX) / pixelsPerSecondRef.current;
        const nextOffset = computeSlipOffset(slipEdit.originalOffset, deltaTime, slipEdit.maxOffset);
        useDAWStore.setState((state) => ({
          tracks: state.tracks.map((track) => ({
            ...track,
            clips: slipEdit.isMidi
              ? track.clips
              : track.clips.map((clip) =>
                  clip.id === slipEdit.clipId ? { ...clip, offset: nextOffset } : clip,
                ),
            midiClips: slipEdit.isMidi
              ? track.midiClips.map((clip) =>
                  clip.id === slipEdit.clipId ? { ...clip, offset: nextOffset } : clip,
                )
              : track.midiClips,
          })),
        }));
      }
    };

    const handleWindowMouseUp = () => {
      if (slipEditRef.current) {
        finalizeSlipTimelineGesture();
      }
      if (dragStateRef.current.type !== null && dragStateRef.current.clipId) {
        void finalizeTimelineClipGesture();
      }
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [
    beginExternalMIDIClipFileDrag,
    findCurrentTimelineClip,
    finalizeSlipTimelineGesture,
    finalizeTimelineClipGesture,
    previewTimelineGestureFromPointer,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        // Waveform Vertical Zoom (Ctrl+Shift+Scroll) — per-track
        e.preventDefault();
        e.stopPropagation();
        const rect = container.getBoundingClientRect();
        const mouseY = e.clientY - rect.top + scrollYRef.current;
        const trackHit = getTrackAtY(mouseY, tracksRef.current, trackYsRef.current, trackHeightRef.current);
        const trackIdx = trackHit?.trackIndex ?? -1;
        const currentTracks = tracksRef.current;
        if (trackIdx >= 0 && trackIdx < currentTracks.length) {
          const track = currentTracks[trackIdx];
          const currentWaveformZoom = track.waveformZoom ?? 1.0;
          const factor = e.deltaY > 0 ? 0.9 : 1.1;
          const newZoom = Math.max(0.1, Math.min(5.0, currentWaveformZoom * factor));
          setTrackWaveformZoomRef.current(track.id, newZoom);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        // Horizontal Zoom — accumulate delta, compute in rAF
        e.preventDefault();
        e.stopPropagation();
        accZoomDeltaRef.current += e.deltaY;
        // Capture cursor X relative to container for zoom anchoring
        const rect = container.getBoundingClientRect();
        zoomCursorXRef.current = e.clientX - rect.left;

        // Mark as zooming — suppresses waveform fetches until 200ms idle
        isZoomingRef.current = true;
        if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
        zoomDebounceRef.current = setTimeout(() => {
          isZoomingRef.current = false;
          forceRender((n) => n + 1); // re-render to fetch waveforms at final zoom
        }, 200);

        scheduleRAF();
      } else if (e.altKey) {
        // Vertical Zoom (Track Height)
        e.preventDefault();
        e.stopPropagation();
        const curHeight = pendingTrackHeightRef.current ?? trackHeightRef.current;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        scheduleTrackHeight(curHeight * delta);
      } else if (e.shiftKey) {
        // Horizontal scroll with Shift + Mouse Wheel
        e.preventDefault();
        const scrollSpeed = 2;
        const curScrollX = pendingScrollRef.current?.x ?? scrollXRef.current;
        const curZoom = pendingZoomRef.current ?? pixelsPerSecondRef.current;
        const maxClipEnd = tracksRef.current.reduce(
          (max, track) =>
            Math.max(max, ...track.clips.map((c) => c.startTime + c.duration)),
          0,
        );
        const maxTimelineScroll = Math.max(
          0,
          (maxClipEnd + 300) * curZoom - dimensionsWidthRef.current,
        );
        const newScrollX = Math.max(
          0,
          Math.min(maxTimelineScroll, curScrollX + e.deltaY * scrollSpeed),
        );
        scheduleScroll(newScrollX, scrollYRef.current);
      }
      // Normal vertical scroll: Let native scroll handle it (no preventDefault)
    };

    // Use passive: false to allow preventDefault to work for zoom/horizontal scroll
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [scheduleRAF, scheduleScroll, scheduleTrackHeight]);

  // ── Ruler interaction: click = seek, drag = set range, drag handle = adjust range ──
  const RANGE_HANDLE_HIT_PX = 8;
  const RANGE_HANDLE_VISUAL_HEIGHT_PX = 8;
  const DRAG_THRESHOLD_PX = 4; // Movement needed to distinguish drag from click

  const handleRulerMouseDown = (e: KonvaEvent) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
    if (!pointerPos) return;

    const rawClickedTime = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
    const quantizePreset = getQuantizePresetById(quantizePresetsRef.current, quantizePresetIdRef.current);
    const clickedTime = getRulerClickSnapTime({
      time: rawClickedTime,
      pixelsPerSecond: pixelsPerSecondRef.current,
      tempo: tempoRef.current,
      timeSignature: timeSignatureRef.current,
      gridSize: gridSizeRef.current,
      snapType: snapTypeRef.current,
      quantizePreset,
      quantizeGridSize: quantizePreset.gridSize,
      cursorTime: useDAWStore.getState().transport.currentTime,
      eventTimes: timelineSnapEventTimes,
      snapEnabled: shouldUseSnapRef.current,
      ctrlBypass: Boolean(e.evt?.ctrlKey || e.evt?.metaKey),
    });

    // Check if clicking near a range handle inside the visible marker zone.
    const startX = projectRange.start * pixelsPerSecond - scrollX;
    const endX = projectRange.end * pixelsPerSecond - scrollX;
    const inHandleZone = pointerPos.y <= RANGE_HANDLE_VISUAL_HEIGHT_PX;

    // Prefer end handle when both overlap (both at 0)
    if (inHandleZone && Math.abs(pointerPos.x - endX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = { type: "handle-pending", handle: "end", startX: pointerPos.x, startTime: clickedTime };
      setRulerDragging(true);
      return;
    }
    if (inHandleZone && Math.abs(pointerPos.x - startX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = { type: "handle-pending", handle: "start", startX: pointerPos.x, startTime: clickedTime };
      setRulerDragging(true);
      return;
    }

    // Shift+click: extend current time selection to clicked position
    if (e.evt?.shiftKey) {
      const currentSel = useDAWStore.getState().timeSelection;
      if (currentSel) {
        // Extend toward whichever end is closer to the click
        const distToStart = Math.abs(clickedTime - currentSel.start);
        const distToEnd = Math.abs(clickedTime - currentSel.end);
        if (distToStart < distToEnd) {
          setTimeSelection(Math.min(clickedTime, currentSel.end), currentSel.end);
        } else {
          setTimeSelection(currentSel.start, Math.max(clickedTime, currentSel.start));
        }
      } else {
        // No existing selection — create from playhead to clicked position
        const playheadTime = useDAWStore.getState().transport.currentTime;
        setTimeSelection(Math.min(playheadTime, clickedTime), Math.max(playheadTime, clickedTime));
      }
      return;
    }

    // Not on a handle — plain click clears any existing time selection and seeks
    if (useDAWStore.getState().timeSelection) {
      clearTimeSelection();
    }
    rulerDragRef.current = { type: "pending", startX: pointerPos.x, startTime: clickedTime };
  };

  // Double-click on ruler: select region between nearest markers on either side
  const handleRulerDblClick = (e: KonvaEvent) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
    if (!pointerPos) return;

    const clickedTime = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
    const currentMarkers = useDAWStore.getState().markers;

    if (!currentMarkers || currentMarkers.length === 0) return;

    // Sort markers by time
    const sortedTimes = currentMarkers.map((m) => m.time).sort((a, b) => a - b);

    // Find nearest marker to the left (at or before clickedTime)
    let leftBound = 0; // default to timeline start
    for (let i = sortedTimes.length - 1; i >= 0; i--) {
      if (sortedTimes[i] <= clickedTime) {
        leftBound = sortedTimes[i];
        break;
      }
    }

    // Find nearest marker to the right (after clickedTime)
    let rightBound = leftBound; // fallback
    for (let i = 0; i < sortedTimes.length; i++) {
      if (sortedTimes[i] > clickedTime) {
        rightBound = sortedTimes[i];
        break;
      }
    }

    // Only create selection if we found distinct bounds
    if (rightBound > leftBound) {
      setTimeSelection(leftBound, rightBound);
    }
  };

  const openTimelineBackgroundContextMenu = useCallback(
    (clientX: number, clientY: number, stageX: number, stageY: number) => {
      const time = Math.max(
        0,
        (stageX + scrollXRef.current) / pixelsPerSecondRef.current,
      );
      const hit = getTrackAtY(
        stageY + scrollYRef.current,
        tracksRef.current,
        trackYsRef.current,
        trackHeightRef.current,
      );
      const track = hit ? tracksRef.current[hit.trackIndex] : null;

      setClipContextMenu(null);
      setBackgroundContextMenu({
        x: clientX,
        y: clientY,
        time,
        trackId: track?.id ?? null,
        trackType: track?.type ?? null,
      });
    },
    [],
  );

  // Global listeners for ruler drag (works even when mouse leaves the canvas)
  useEffect(() => {
    const getRulerCanvas = () =>
      containerRef.current?.querySelector(".sticky canvas") as HTMLCanvasElement | null;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const drag = rulerDragRef.current;
      if (!drag) return;

      const canvas = getRulerCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const curScrollX = scrollXRef.current;
      const curPPS = pixelsPerSecondRef.current;
      let time = Math.max(0, (pointerX + curScrollX) / curPPS);
      const range = projectRangeRef.current;

      // Apply snap-to-grid if enabled
      if (isSnapActive(Boolean(e.ctrlKey || e.metaKey))) {
        time = snapTimelineTime(time, drag.startTime);
      }

      if (drag.type === "handle-pending") {
        if (Math.abs(pointerX - drag.startX) <= DRAG_THRESHOLD_PX) {
          return;
        }
        drag.type = "handle-drag";
      }

      if (drag.type === "handle-drag") {
        // Dragging an existing handle
        if (drag.handle === "start") {
          setProjectRange(Math.min(time, range.end), range.end);
        } else {
          setProjectRange(range.start, Math.max(time, range.start));
        }
        setRulerDragging(true);
      } else if (drag.type === "pending") {
        // Check if we've moved enough to start a range-create drag
        if (Math.abs(pointerX - drag.startX) > DRAG_THRESHOLD_PX) {
          drag.type = "range-create";
          // Snap the drag start time too
          let startTime = drag.startTime;
          if (isSnapActive(Boolean(e.ctrlKey || e.metaKey))) {
            startTime = snapTimelineTime(startTime, drag.startTime);
            drag.startTime = startTime;
          }
          setProjectRange(Math.min(startTime, time), Math.max(startTime, time));
          setRulerDragging(true);
        }
      } else if (drag.type === "range-create") {
        // Continuing range-create drag
        const startTime = drag.startTime;
        setProjectRange(Math.min(startTime, time), Math.max(startTime, time));
      }
    };

    const handleGlobalMouseUp = () => {
      const drag = rulerDragRef.current;
      if (!drag) return;

      if (drag.type === "pending") {
        // No significant movement — this was a click, so seek
        seekTo(drag.startTime);
      } else if (drag.type === "handle-pending") {
        if (useDAWStore.getState().timeSelection) {
          clearTimeSelection();
        }
        seekTo(drag.startTime);
      }

      rulerDragRef.current = null;
      setRulerDragging(false);
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [clearTimeSelection, seekTo, setProjectRange]);

  // Handle mouse move for time selection / razor edit dragging (on main stage)
  const handleStageMouseMove = (e: KonvaEvent) => {
    // Track crosshair cursor position
    if (showCrosshair) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) {
        setCrosshairPos({ x: pointerPos.x, y: pointerPos.y });
      }
    }

    if (automationDrawRef.current) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) continueAutomationLaneDraw(pointerPos.x, pointerPos.y);
      return;
    }

    // Slip editing: Alt+drag adjusts clip offset in real-time
    if (slipEditRef.current) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) {
        const deltaX = pointerPos.x - slipEditRef.current.startX;
        const deltaTime = deltaX / pixelsPerSecond;
        // Moving mouse right shifts content left (increases offset), moving left shifts content right (decreases offset)
        const newOffset = computeSlipOffset(
          slipEditRef.current.originalOffset,
          deltaTime,
          slipEditRef.current.maxOffset,
        );
        // Apply offset change live (without undo tracking — undo happens on mouseup)
        useDAWStore.setState((s) => ({
          tracks: s.tracks.map((track) => ({
            ...track,
            clips: slipEditRef.current!.isMidi
              ? track.clips
              : track.clips.map((clip) =>
                  clip.id === slipEditRef.current!.clipId
                    ? { ...clip, offset: newOffset }
                    : clip,
                ),
            midiClips: slipEditRef.current!.isMidi
              ? track.midiClips.map((clip) =>
                  clip.id === slipEditRef.current!.clipId
                    ? { ...clip, offset: newOffset }
                    : clip,
                )
              : track.midiClips,
          })),
        }));
      }
    }

    // Split tool preview line
    if (toolModeRef.current === "split") {
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      if (pointerPos) setSplitPreviewX(pointerPos.x);
    } else if (splitPreviewX !== null) {
      setSplitPreviewX(null);
    }

    if (timeSelectionDrag && timeSelectionDrag.active) {
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      if (pointerPos) {
        const currentTime = (pointerPos.x + scrollX) / pixelsPerSecond;
        const startTime = timeSelectionDrag.startTime;
        const endTime = Math.max(0, currentTime);

        setTimeSelection(
          Math.min(startTime, endTime),
          Math.max(startTime, endTime)
        );
      }
    }

    // Razor edit dragging (Alt+drag)
    if (razorDrag && razorDrag.active) {
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      if (pointerPos) {
        const currentTime = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
        // Update the last razor edit's end time in real time
        const start = Math.min(razorDrag.startTime, currentTime);
        const end = Math.max(razorDrag.startTime, currentTime);
        useDAWStore.getState().clearRazorEdits();
        addRazorEdit(razorDrag.trackId, start, end);
      }
    }

    // Marquee zoom drag (Ctrl+drag on background)
    if (marqueeZoomRef.current) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) {
        const time = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
        marqueeZoomRef.current.currentX = pointerPos.x;
        marqueeZoomRef.current.currentTime = time;
        const dx = pointerPos.x - marqueeZoomRef.current.startX;
        if (Math.abs(dx) > 4) {
          const left = Math.min(marqueeZoomRef.current.startX, pointerPos.x);
          const w = Math.abs(dx);
          setMarqueeZoomRect({ x: left, width: w });
        }
      }
    }

    // Marquee selection drag
    if (marqueeRef.current) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) {
        const tlX = pointerPos.x + scrollX;
        const tlY = pointerPos.y + scrollY;
        marqueeRef.current.currentX = tlX;
        marqueeRef.current.currentY = tlY;
        const dx = tlX - marqueeRef.current.startX;
        const dy = tlY - marqueeRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          const left = Math.min(marqueeRef.current.startX, tlX) - scrollX;
          const top = Math.min(marqueeRef.current.startY, tlY) - scrollY;
          const w = Math.abs(dx);
          const h = Math.abs(dy);
          setMarqueeRect({ x: left, y: top, width: w, height: h });
        }
      }
    }
  };

  // Handle mouse up to finalize time selection / razor edit / marquee / slip edit (on main stage)
  const handleStageMouseUp = () => {
    if (finishAutomationLaneDraw()) return;

    // Finalize slip edit with undo support
    finalizeSlipTimelineGesture();

    if (timeSelectionDrag && timeSelectionDrag.active) {
      setTimeSelectionDrag(null);
    }
    if (razorDrag && razorDrag.active) {
      setRazorDrag(null);
    }
    // Finalize marquee selection
    if (marqueeRef.current && marqueeRect) {
      const m = marqueeRef.current;
      const left = Math.min(m.startX, m.currentX);
      const top = Math.min(m.startY, m.currentY);
      const right = Math.max(m.startX, m.currentX);
      const bottom = Math.max(m.startY, m.currentY);

      const intersectingIds: string[] = [];
      const store = useDAWStore.getState();
      store.tracks.forEach((track, trackIndex) => {
        const rowMetrics = getTimelineRowMetrics(track, trackHeightRef.current);
        const clipTop = trackYsRef.current[trackIndex] + rowMetrics.clipInsetY;
        const clipBottom = clipTop + rowMetrics.clipHeight;
        if (clipBottom < top || clipTop > bottom) return; // skip entire track
        const checkClip = (clip: { id: string; startTime: number; duration: number }) => {
          const clipLeft = clip.startTime * pixelsPerSecond;
          const clipRight = clipLeft + clip.duration * pixelsPerSecond;
          if (clipLeft < right && clipRight > left) {
            intersectingIds.push(clip.id);
          }
        };
        track.clips.forEach(checkClip);
        track.midiClips.forEach(checkClip);
      });

      if (m.ctrlHeld) {
        const merged = [...new Set([...store.selectedClipIds, ...intersectingIds])];
        store.setSelectedClipIds(merged);
      } else {
        store.setSelectedClipIds(intersectingIds);
      }

      marqueeRef.current = null;
      setMarqueeRect(null);
      marqueeJustCompletedRef.current = true;
    } else if (marqueeRef.current) {
      // Was a click, not a drag — let onClick handle deselection
      marqueeRef.current = null;
      setMarqueeRect(null);
    }

    // Finalize marquee zoom (Ctrl+drag)
    if (marqueeZoomRef.current && marqueeZoomRect) {
      const mz = marqueeZoomRef.current;
      const startTime = Math.min(mz.startTime, mz.currentTime);
      const endTime = Math.max(mz.startTime, mz.currentTime);
      const timeRange = endTime - startTime;

      if (timeRange > 0.01) {
        // Calculate new zoom to fit the selected time range into the viewport
        const viewportWidth = dimensions.width;
        const newPPS = viewportWidth / timeRange;
        // Set zoom and scroll to the start of the selection
        setZoom(newPPS);
        setScroll(startTime * newPPS, scrollY);
      }

      marqueeZoomRef.current = null;
      setMarqueeZoomRect(null);
      // Prevent click handler from firing after zoom
      marqueeJustCompletedRef.current = true;
    } else if (marqueeZoomRef.current) {
      // Was a click, not a drag — just clear
      marqueeZoomRef.current = null;
      setMarqueeZoomRect(null);
    }
  };

  // Keyboard shortcuts for clip editing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const state = useDAWStore.getState();
      const hasClips = state.selectedClipIds.length > 0;
      const hasModifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (state.showPianoRoll) {
        const isPianoRollEditShortcut =
          (hasModifier && ["a", "c", "d", "v", "x"].includes(key))
          || e.key === "Delete"
          || e.key === "Backspace";
        if (isPianoRollEditShortcut) return;
      }

      // Tool switching (bare keys, skip if in input/textarea)
      const tag = (e.target as HTMLElement).tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") {
        if ((e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          state.setToolMode("select");
          return;
        }
        if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          state.toggleSplitTool();
          return;
        }
        if ((e.key === "x" || e.key === "X") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          state.toggleMuteTool();
          return;
        }
        if ((e.key === "y" || e.key === "Y") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          state.setToolMode("smart");
          return;
        }
        if (e.key === "Escape") {
          state.setToolMode("select");
          // Don't return — let Escape also deselect via action registry
        }
      }

      // Copy: Ctrl+C
      if (hasModifier && key === "c" && hasClips) {
        e.preventDefault();
        state.copySelectedClips();
      }
      // Cut: Ctrl+X
      else if (hasModifier && key === "x" && hasClips) {
        e.preventDefault();
        state.cutSelectedClips();
      }
      // Paste: Ctrl+V (works even without clips selected — uses clipboard)
      else if (hasModifier && key === "v") {
        const { clipboard } = state;
        if (clipboard.clips.length > 0 || clipboard.clip) {
          e.preventDefault();
          state.pasteClips();
        }
      }
      // Duplicate: Ctrl+D
      else if (hasModifier && key === "d" && hasClips) {
        e.preventDefault();
        state.selectedClipIds.forEach((id) => state.duplicateClip(id));
      }
      // Group: Ctrl+G
      else if (hasModifier && !e.shiftKey && key === "g" && hasClips) {
        e.preventDefault();
        state.groupSelectedClips();
      }
      // Ungroup: Ctrl+Shift+G
      else if (hasModifier && e.shiftKey && key === "g" && hasClips) {
        e.preventDefault();
        state.ungroupSelectedClips();
      }
      // Delete: Delete or Backspace
      else if (e.key === "Delete" || e.key === "Backspace") {
        // Razor edits take priority
        if (state.razorEdits.length > 0) {
          e.preventDefault();
          state.deleteRazorEditContent();
        } else if (hasClips) {
          e.preventDefault();
          state.selectedClipIds.forEach((id) => state.deleteClip(id));
        } else if (state.timeSelection) {
          e.preventDefault();
          state.deleteWithinTimeSelection();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Auto-Scroll during playback - uses Zustand subscribe to avoid re-renders.
  // IMPORTANT: scrollX is read from scrollXRef (not the dep array) to prevent a
  // re-render → effect re-run → setScroll → re-render loop that caused the
  // "white border flicker" during playback auto-scroll.
  useEffect(() => {
    if (!isPlaying) return;

    // Initialise from the ref so the effect doesn't depend on scrollX state.
    let lastAutoScrollX = scrollXRef.current;
    const FOLLOW_TRIGGER_RATIO = 0.82;
    const FOLLOW_TARGET_RATIO = 0.72;
    const FOLLOW_BACK_JUMP_PADDING = 120;

    const unsubscribe = useDAWStore.subscribe((state) => {
      if (!state.transport.isPlaying) return;
      if (performance.now() < manualScrollLockUntilRef.current) return;

      const currentTime = state.transport.currentTime;
      const pps = pixelsPerSecondRef.current;
      const playheadX = currentTime * pps;
      const viewWidth = dimensions.width;

      // If playhead jumped behind viewport (e.g. loop wrap), scroll back to show it
      if (playheadX < lastAutoScrollX) {
        const targetScrollX = Math.max(0, playheadX - FOLLOW_BACK_JUMP_PADDING);
        lastAutoScrollX = targetScrollX;
        scheduleFollowScroll(targetScrollX, scrollYRef.current);
        return;
      }

      const triggerPoint = lastAutoScrollX + viewWidth * FOLLOW_TRIGGER_RATIO;

      // If playhead goes past the trigger point, move it to a stable follow target.
      if (playheadX > triggerPoint) {
        const targetScrollX = Math.max(
          0,
          playheadX - viewWidth * FOLLOW_TARGET_RATIO,
        );
        if (Math.abs(targetScrollX - lastAutoScrollX) < 1) return;
        lastAutoScrollX = targetScrollX;
        scheduleFollowScroll(targetScrollX, scrollYRef.current);
      }
    });

    return () => unsubscribe();
  }, [dimensions.width, isPlaying, scheduleFollowScroll]);

  // Note: Removed auto-scroll when stopped - users should be able to freely scroll
  // the timeline when not playing. Auto-scroll only happens during playback.

  // Pre-fetch waveform tiles ahead of the playhead during playback.
  // This prevents visual gaps when auto-scroll reveals a new tile that hasn't been fetched yet.
  // Runs on a 1s interval, fetching tiles for clips near the playhead + 2 viewport widths ahead.
  const prefetchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!isPlaying) {
      if (prefetchIntervalRef.current) {
        clearInterval(prefetchIntervalRef.current);
        prefetchIntervalRef.current = null;
      }
      return;
    }

    const prefetch = () => {
      const daw = useDAWStore.getState();
      const pps = daw.pixelsPerSecond;
      const curTime = daw.transport.currentTime;
      const viewWidth = dimensions.width;
      // Look ahead 2 viewport widths
      const lookAheadSec = (viewWidth * 2) / pps;
      const aheadTime = curTime + lookAheadSec;

      for (const track of daw.tracks) {
        for (const clip of track.clips) {
          // Skip clips not in the look-ahead range
          if (clip.startTime > aheadTime || clip.startTime + clip.duration < curTime) continue;
          if (!clip.filePath) continue;

          const fileSR = clip.sampleRate || 44100;
          const renderSpp = Math.max(1, Math.round(fileSR / pps));
          const cacheSpp = quantizeSpp(renderSpp);
          const tileSamples = 4096 * cacheSpp; // TILE_PEAKS = 4096

          // Compute which tiles cover the look-ahead range within this clip
          const clipOffset = clip.offset || 0;
          const rangeStartInClip = Math.max(0, curTime - clip.startTime);
          const rangeEndInClip = Math.min(clip.duration, aheadTime - clip.startTime);
          const startSampleInFile = Math.floor((clipOffset + rangeStartInClip) * fileSR);
          const endSampleInFile = Math.floor((clipOffset + rangeEndInClip) * fileSR);

          for (let tileSample = Math.floor(startSampleInFile / tileSamples) * tileSamples;
               tileSample < endSampleInFile;
               tileSample += tileSamples) {
            const cacheKey = `${clip.filePath}-${cacheSpp}-${tileSample}`;
            if (!waveformCacheRef.current.has(cacheKey) && !inFlightRef.current.has(cacheKey)) {
              const numPeaks = Math.min(8000, Math.ceil((endSampleInFile - tileSample) / cacheSpp) + 4096);
              fetchWaveformDataRef.current(clip.filePath, cacheSpp, tileSample, numPeaks);
            }
          }
        }
      }
    };

    // Run immediately, then every 1s
    prefetch();
    prefetchIntervalRef.current = setInterval(prefetch, 1000);

    return () => {
      if (prefetchIntervalRef.current) {
        clearInterval(prefetchIntervalRef.current);
        prefetchIntervalRef.current = null;
      }
    };
  }, [isPlaying, dimensions.width]);

  // Fetch recording waveforms on a short throttle while recording so short takes
  // also produce visible waveforms during record.
  useEffect(() => {
    if (!isRecording || recordingClips.length === 0) {
      // Clear recording waveform cache and reset bar tracking when not recording
      if (recordingWaveformCache.size > 0) {
        setRecordingWaveformCache(new Map());
      }
      return;
    }

    let cancelled = false;
    const fetchRecordingPeaks = async () => {
      const currentTime = useDAWStore.getState().transport.currentTime;
      const newCache = new Map(recordingWaveformCacheRef.current);

      for (const rc of recordingClips) {
        const track = tracks.find((candidate) => candidate.id === rc.trackId);
        if (track?.type === "midi" || track?.type === "instrument") {
          newCache.delete(rc.trackId);
          continue;
        }

        const recordingDuration = currentTime - rc.startTime;
        if (recordingDuration <= 0) {
          continue;
        }

        const widthPixels = Math.ceil(recordingDuration * pixelsPerSecond);
        if (widthPixels < 2) {
          continue;
        }

        try {
          const deviceSR = useDAWStore.getState().audioDeviceSetup?.sampleRate || 44100;
          const samplesPerPixel = Math.max(1, Math.floor((recordingDuration * deviceSR) / widthPixels));
          const peaks = await nativeBridge.getRecordingPeaks(
            rc.trackId,
            samplesPerPixel,
            widthPixels,
          );

          if (peaks && peaks.length > 0) {
            newCache.set(rc.trackId, { peaks, widthPixels });
          }
        } catch (e) {
          console.error(`${AUDIO_RECORD_LOG_PREFIX} waveformFetch:error`, {
            trackId: rc.trackId,
            error: e,
          });
        }
      }

      if (!cancelled) {
        startRecordingWaveformTransition(() => setRecordingWaveformCache(newCache));
      }
    };

    void fetchRecordingPeaks();
    const intervalId = window.setInterval(() => {
      void fetchRecordingPeaks();
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isRecording, recordingClips, pixelsPerSecond, tempo, timeSignature, tracks]);

  // Subscribe to peaksReady events from C++ — invalidate waveform cache and
  // in-flight guards for the finished file so renderClip re-fetches fresh peaks.
  useEffect(() => {
    const unsubscribe = nativeBridge.onPeaksReady((filePath: string) => {
      if (!filePath) return;
      // Clear in-flight guards so the file can be re-fetched
      for (const key of [...inFlightRef.current]) {
        if (key.startsWith(filePath)) {
          inFlightRef.current.delete(key);
        }
      }
      // Clear cached (empty) waveform data to trigger re-fetch on next render
      setWaveformCache((prev) => {
        const next = new Map(prev);
        for (const key of next.keys()) {
          if (key.startsWith(filePath)) {
            next.delete(key);
          }
        }
        return next;
      });
      // Force a re-render even if no cache entries were cleared (initial fetch
      // may have returned empty so nothing was stored). This guarantees renderClip
      // re-runs and retries fetchWaveformData now that peaks are ready.
      forceRender((n) => n + 1);
    });
    return unsubscribe;
  }, []);

  const rulerDensity = useMemo(() => {
    const beatsPerBar = timeSignature.numerator;
    const secondsPerBeat = 60 / tempo;
    const pixelsPerBeat = secondsPerBeat * pixelsPerSecond;
    const pixelsPerBar = pixelsPerBeat * beatsPerBar;

    if (pixelsPerBeat >= 140) {
      return {
        mode: "division" as const,
        divisionsPerBeat: pixelsPerBeat >= 260 ? 8 : 4,
        labelEveryBars: pixelsPerBar < 90 ? 2 : 1,
      };
    }

    if (pixelsPerBeat >= 32) {
      return {
        mode: "beat" as const,
        divisionsPerBeat: 1,
        labelEveryBars: pixelsPerBar < 60 ? 2 : 1,
      };
    }

    return {
      mode: "bar" as const,
      divisionsPerBeat: 1,
      labelEveryBars:
        pixelsPerBar < 30 ? 8 : pixelsPerBar < 45 ? 4 : pixelsPerBar < 70 ? 2 : 1,
    };
  }, [pixelsPerSecond, tempo, timeSignature.numerator]);

  const gridLines = useMemo(() => {
    const lines: React.ReactNode[] = [];
    const beatsPerBar = timeSignature.numerator;
    const secondsPerBeat = 60 / tempo;
    const secondsPerBar = secondsPerBeat * beatsPerBar;
    const visibleStartTime = Math.max(
      0,
      scrollX / pixelsPerSecond - secondsPerBar,
    );
    const visibleEndTime =
      (scrollX + dimensions.width) / pixelsPerSecond + secondsPerBar;
    const startBar = Math.floor(visibleStartTime / secondsPerBar);
    const endBar = Math.ceil(visibleEndTime / secondsPerBar);

    for (let bar = startBar; bar <= endBar; bar += 1) {
      const barTime = bar * secondsPerBar;
      const barX = barTime * pixelsPerSecond - scrollX;
      lines.push(
        <Line
          key={`bar-${bar}`}
          points={[barX, 0, barX, stageHeight]}
          stroke="#ffffff"
          strokeWidth={1}
          opacity={0.15}
          listening={false}
        />,
      );

      if (rulerDensity.mode === "bar") continue;

      for (let beat = 1; beat < beatsPerBar; beat += 1) {
        const beatTime = barTime + beat * secondsPerBeat;
        if (beatTime > visibleEndTime) break;
        const beatX = beatTime * pixelsPerSecond - scrollX;

        lines.push(
          <Line
            key={`beat-${bar}-${beat}`}
            points={[beatX, 0, beatX, stageHeight]}
            stroke="#ffffff"
            strokeWidth={0.5}
            opacity={0.08}
            listening={false}
          />,
        );

        if (rulerDensity.mode !== "division") continue;

        for (
          let division = 1;
          division < rulerDensity.divisionsPerBeat;
          division += 1
        ) {
          const divisionTime =
            beatTime + (secondsPerBeat * division) / rulerDensity.divisionsPerBeat;
          if (divisionTime > visibleEndTime) break;
          const divisionX = divisionTime * pixelsPerSecond - scrollX;
          lines.push(
            <Line
              key={`division-${bar}-${beat}-${division}`}
              points={[divisionX, 0, divisionX, stageHeight]}
              stroke="#ffffff"
              strokeWidth={0.5}
              opacity={0.04}
              listening={false}
            />,
          );
        }
      }
    }

    return lines;
  }, [
    dimensions.width,
    pixelsPerSecond,
    rulerDensity,
    scrollX,
    stageHeight,
    tempo,
    timeSignature.numerator,
  ]);

  const rulerMarks = useMemo(() => {
    const marks: React.ReactNode[] = [];
    const beatsPerBar = timeSignature.numerator;
    const secondsPerBeat = 60 / tempo;
    const secondsPerBar = secondsPerBeat * beatsPerBar;
    const startTime = Math.max(0, scrollX / pixelsPerSecond - secondsPerBar);
    const endTime =
      (scrollX + dimensions.width) / pixelsPerSecond + secondsPerBar;
    const startBar = Math.floor(startTime / secondsPerBar);
    const endBar = Math.ceil(endTime / secondsPerBar);

    for (let bar = startBar; bar <= endBar; bar += 1) {
      const barTime = bar * secondsPerBar;
      const barX = barTime * pixelsPerSecond - scrollX;
      if (barX < -60 || barX > dimensions.width + 60) continue;

      const showBarLabel = bar >= 0 && bar % rulerDensity.labelEveryBars === 0;
      marks.push(
        <Line
          key={`bar-line-${bar}`}
          points={[barX, showBarLabel ? 0 : 12, barX, RULER_HEIGHT]}
          stroke="#555"
          strokeWidth={showBarLabel ? 1 : 0.5}
        />,
      );

      if (showBarLabel) {
        marks.push(
          <Text
            key={`bar-label-${bar}`}
            x={Math.round(barX) + 3}
            y={2}
            text={`${bar + 1}`}
            fontSize={10}
            fill="#888"
          />,
        );
      }

      if (rulerDensity.mode === "bar") continue;

      for (let beat = 1; beat < beatsPerBar; beat += 1) {
        const beatTime = barTime + beat * secondsPerBeat;
        const beatX = beatTime * pixelsPerSecond - scrollX;
        if (beatX < -20 || beatX > dimensions.width + 20) continue;

        marks.push(
          <Line
            key={`beat-line-${bar}-${beat}`}
            points={[beatX, 18, beatX, RULER_HEIGHT]}
            stroke="#444"
            strokeWidth={0.5}
          />,
        );

        if (rulerDensity.mode === "beat" && beatX >= 0 && beatX <= dimensions.width) {
          marks.push(
            <Text
              key={`beat-label-${bar}-${beat}`}
              x={Math.round(beatX) + 2}
              y={14}
              text={`${bar + 1}.${beat + 1}`}
              fontSize={9}
              fill="#666"
            />,
          );
        }

        if (rulerDensity.mode !== "division") continue;

        for (
          let division = 1;
          division < rulerDensity.divisionsPerBeat;
          division += 1
        ) {
          const divisionTime =
            beatTime + (secondsPerBeat * division) / rulerDensity.divisionsPerBeat;
          const divisionX = divisionTime * pixelsPerSecond - scrollX;
          if (divisionX < -10 || divisionX > dimensions.width + 10) continue;

          marks.push(
            <Line
              key={`division-line-${bar}-${beat}-${division}`}
              points={[divisionX, 22, divisionX, RULER_HEIGHT]}
              stroke="#333"
              strokeWidth={0.5}
            />,
          );

          if (divisionX >= 0 && divisionX <= dimensions.width) {
            marks.push(
              <Text
                key={`division-label-${bar}-${beat}-${division}`}
                x={Math.round(divisionX) + 2}
                y={20}
                text={`${bar + 1}.${beat + 1}.${division + 1}`}
                fontSize={8}
                fill="#555"
              />,
            );
          }
        }
      }
    }

    return marks;
  }, [
    dimensions.width,
    pixelsPerSecond,
    rulerDensity,
    scrollX,
    tempo,
    timeSignature.numerator,
  ]);

  // Render track rows
  //   const renderTrackRows = () => {
  //     return tracks.map((track, index) => {
  //       const y = RULER_HEIGHT + index * TRACK_HEIGHT;
  //       return (
  //         <Group key={track.id}>
  //           {/* Track background */}
  //           <Rect
  //             x={0}
  //             y={y}
  //             width={dimensions.width}
  //             height={TRACK_HEIGHT}
  //             fill={index % 2 === 0 ? "#1a1a1a" : "#1e1e1e"}
  //           />
  //           {/* Track border */}
  //           <Line
  //             points={[0, y + TRACK_HEIGHT, dimensions.width, y + TRACK_HEIGHT]}
  //             stroke="#333"
  //             strokeWidth={1}
  //           />
  //           {/* Render clips for this track */}
  //           {track.clips.map((clip) => renderClip(clip, index, y, track.color))}
  //           {/* Render recording clip if this track is recording (match by ID) */}
  //           {recordingClips
  //             .filter((rc) => rc.trackId === track.id)
  //             .map((rc) => renderRecordingClip(rc, y))}
  //         </Group>
  //       );
  //     });
  //   };

  // Viewport-tile size in peaks per tile. Aligning requests to tile boundaries
  // prevents a new fetch on every scroll pixel while keeping tiles small enough
  // that we never fetch more than ~2x the viewport's worth of data.
  // At cacheSpp=32 (extreme zoom 1000px/s): tile = 4096*32 = 131072 samples ≈ 3s ≈ 3000px
  // At cacheSpp=1024 (zoom 43px/s):        tile = 4096*1024 = 4M samples ≈ 90s ≈ 3900px
  const TILE_PEAKS = 4096;

  // Fetch waveform peaks for the VISIBLE PORTION of a clip only.
  // startSample: file-absolute sample where the visible clip portion begins (tile-aligned).
  // numPixels: number of peaks to fetch (≈ viewport width, capped for safety).
  const fetchWaveformData = async (
    filePath: string,
    cacheSpp: number,
    startSample: number,  // tile-aligned start within the source file
    numPixels: number,    // peaks to fetch (viewport-bounded)
  ) => {
    if (!filePath) return;
    if (isZoomingRef.current || isScrollingRef.current) return;

    const cacheKey = `${filePath}-${cacheSpp}-${startSample}`;
    if (inFlightRef.current.has(cacheKey)) return;

    inFlightRef.current.add(cacheKey);
    try {
      const peaks = await nativeBridge.getWaveformPeaks(filePath, cacheSpp, startSample, numPixels);

      if (peaks && peaks.length > 0) {
        setWaveformCache((prev) => {
          const next = new Map(prev);
          next.set(cacheKey, peaks);
          // Prune cache if it grows too large (> 200 entries) — keep most recent
          if (next.size > 200) {
            const oldest = next.keys().next().value;
            if (oldest) next.delete(oldest);
          }
          return next;
        });
        // Always clear inFlight so evicted cache entries can be re-fetched
        inFlightRef.current.delete(cacheKey);
        return;
      }
      // Empty = peaks still generating async; retry after 2s and force a re-render
      setTimeout(() => {
        inFlightRef.current.delete(cacheKey);
        forceRender((n) => n + 1);
      }, 2000);
      return;
    } catch (e) {
      console.error("Failed to fetch waveform:", e);
    }
    inFlightRef.current.delete(cacheKey);
  };
  // Keep a ref so the pre-fetch interval always calls the latest version
  const fetchWaveformDataRef = useRef(fetchWaveformData);
  fetchWaveformDataRef.current = fetchWaveformData;

  // Render individual clip with waveform
  const renderClip = (
    clip: AudioClip,
    trackIndex: number,
    trackY: number,
    trackColor: string,
    trackId: string,
  ) => {
    const track = tracks[trackIndex];
    const rowMetrics = getTimelineRowMetrics(track, trackHeight);
    const clipHeight = rowMetrics.clipHeight;
    const waveformHeight = Math.max(8, clipHeight - 10);
    const isTrackMuted = !!track?.muted;
    let visualTrackY = trackY;
    const x = clip.startTime * pixelsPerSecond - scrollX;
    const width = clip.duration * pixelsPerSecond;
    const isSelected = selectedClipIds.includes(clip.id);
    const isCut = clipboard.isCut && clipboard.clip?.id === clip.id; // Check if this clip is cut

    // During cross-track drag, visually offset clip to target track position
    // (actual move deferred to drag end to prevent Konva node unmount)
    if (dragState.type === "move" && dragState.targetTrackIndex != null) {
      if (dragState.clipId === clip.id) {
        // Anchor clip — offset to pointer's target track
        if (dragState.targetTrackIndex !== trackIndex) {
          visualTrackY = trackYs[dragState.targetTrackIndex] ?? visualTrackY;
        }
      } else if (dragState.multiClipInfo && dragState.multiClipInfo.length > 1) {
        // Other clips in multi-selection — offset by same track delta
        const info = dragState.multiClipInfo.find(m => m.clipId === clip.id);
        if (info) {
          const trackDelta = dragState.targetTrackIndex - (dragState.trackIndex ?? 0);
          const visualTrackIdx = info.trackIndex + trackDelta;
          if (visualTrackIdx !== trackIndex) {
            visualTrackY = trackYs[visualTrackIdx] ?? visualTrackY;
          }
        }
      }
    }

    const clipY = visualTrackY + rowMetrics.clipInsetY;

    // Skip if clip is outside visible area
    if (x + width < 0 || x > dimensions.width) return null;

    // Skip zero-duration (or near-zero) clips — a width-0 Rect still renders
    // its stroke as a white hairline, which confuses users after a failed recording.
    if (width < 1) return null;

    // Compact thumbnail view for very narrow clips — skip waveform fetch entirely
    const isNarrowClip = width < 60;

    // Fetch waveform peaks for the VISIBLE PORTION only (viewport-tiled).
    const fileSR = clip.sampleRate || 44100;
    const renderSpp = Math.max(1, Math.round(fileSR / pixelsPerSecond));
    const cacheSpp = quantizeSpp(renderSpp);

    // Tile-aligned start sample: snap the visible clip start to TILE_PEAKS boundaries
    // so small scrolls within a tile reuse the same cache entry.
    const visibleStartPx = Math.max(0, -x);          // pixels of clip hidden left of viewport
    const visibleEndPx   = Math.min(width, dimensions.width - x);
    const clipOffsetSamples = Math.floor((clip.offset || 0) * fileSR);
    const visibleStartSampleInFile = clipOffsetSamples + Math.floor(visibleStartPx / pixelsPerSecond * fileSR);
    const tileSamples = TILE_PEAKS * cacheSpp;
    const alignedStartSample = Math.floor(visibleStartSampleInFile / tileSamples) * tileSamples;

    // How many peaks to fetch: visible clip width + extra to cover tile-alignment gap
    const peakScale = renderSpp / cacheSpp;
    const alignmentGapPeaks = Math.ceil((visibleStartSampleInFile - alignedStartSample) / cacheSpp);
    const visiblePeaks = Math.ceil((visibleEndPx - visibleStartPx) / peakScale);
    const numPeaksToFetch = Math.min(visiblePeaks + alignmentGapPeaks + TILE_PEAKS, 8000);

    const cacheKey = `${clip.filePath}-${cacheSpp}-${alignedStartSample}`;
    const waveformData = isNarrowClip ? undefined : waveformCache.get(cacheKey);
    const previewWaveformData = isNarrowClip ? undefined : waveformPreviewCache.get(clip.filePath);

    if (!isNarrowClip && clip.filePath && !waveformData) {
      fetchWaveformData(clip.filePath, cacheSpp, alignedStartSample, numPeaksToFetch);
    }

    // Generate waveform points for Line drawing.
    // Only renders the visible portion of the clip within the viewport,
    // so large clips don't generate tens of thousands of off-screen points.
    const generateWaveformPoints = (): React.ReactNode[] => {
      if (!waveformData || waveformData.length === 0) return [];

      const numChannels = waveformData[0]?.channels?.length || 1;
      const waveforms: React.ReactNode[] = [];

      // Apply clip gain and per-track waveform vertical zoom to visualization
      const baseGain = clip.volumeDB <= -60 ? 0 : Math.pow(10, clip.volumeDB / 20);
      const trackWaveformZoom = tracks.find((t) => t.id === trackId)?.waveformZoom ?? 1.0;
      const gainFactor = baseGain * trackWaveformZoom;

      // waveformData starts at alignedStartSample (not sample 0).
      // clipStartInData: offset (in peaks) from waveformData[0] to the clip's audio start.
      // Can be negative when alignedStartSample > clipStartSampleInFile (clip starts before tile).
      const clipStartSampleInFile = Math.floor((clip.offset || 0) * fileSR);
      const clipStartInData = Math.floor((clipStartSampleInFile - alignedStartSample) / cacheSpp);
      const totalAvailablePeaks = Math.max(0, waveformData.length - Math.max(0, clipStartInData));
      // When clipStartInData < 0, the fetched data starts this many clip-pixels after pixel 0.
      // totalClipPeaks must account for this offset so visibleEnd is computed correctly.
      const dataStartInClipPx = clipStartInData < 0 ? Math.ceil(-clipStartInData / peakScale) : 0;
      const totalClipPeaks = Math.min(Math.ceil(width), dataStartInClipPx + Math.ceil(totalAvailablePeaks / peakScale));

      // Clamp to visible viewport: only iterate over pixels that are on screen
      const visibleStart = Math.max(0, Math.floor(-x));
      const visibleEnd = Math.min(totalClipPeaks, Math.ceil(dimensions.width - x));
      if (visibleEnd <= visibleStart) return [];

      // Render each channel separately
      for (let ch = 0; ch < numChannels; ch++) {
        const points: number[] = [];
        const channelHeight = waveformHeight / numChannels;
        const channelY = clipY + 5 + ch * channelHeight;
        const centerY = channelY + channelHeight / 2;
        const halfHeight = channelHeight / 2 - 2;

        // Draw top half (max values) — only visible peaks
        for (let i = visibleStart; i < visibleEnd; i++) {
          // dataIndex correctly maps pixel i → waveformData entry, accounting for
          // both clip.offset and the tile-alignment gap (clipStartInData can be negative).
          const dataIndex = clipStartInData + Math.floor(i * peakScale);
          if (dataIndex < 0 || dataIndex >= waveformData.length) continue;
          const channelData = waveformData[dataIndex]?.channels[ch];
          if (!channelData) continue;

          // Per-pixel fade attenuation
          const timeInClip = i / pixelsPerSecond;
          let fadeMult = 1;
          if (clip.fadeIn > 0 && timeInClip < clip.fadeIn) {
            fadeMult *= timeInClip / clip.fadeIn;
          }
          if (clip.fadeOut > 0 && timeInClip > clip.duration - clip.fadeOut) {
            fadeMult *= (clip.duration - timeInClip) / clip.fadeOut;
          }
          const pixelGain = gainFactor * fadeMult;

          const px = x + i;
          const scaledMax = Math.max(-1, Math.min(1, channelData.max * pixelGain));
          const py = centerY - scaledMax * halfHeight;
          points.push(px, py);
        }

        // Draw bottom half (min values, reversed) — only visible peaks
        for (let i = visibleEnd - 1; i >= visibleStart; i--) {
          const dataIndex = clipStartInData + Math.floor(i * peakScale);
          if (dataIndex < 0 || dataIndex >= waveformData.length) continue;
          const channelData = waveformData[dataIndex]?.channels[ch];
          if (!channelData) continue;

          // Per-pixel fade attenuation
          const timeInClip = i / pixelsPerSecond;
          let fadeMult = 1;
          if (clip.fadeIn > 0 && timeInClip < clip.fadeIn) {
            fadeMult *= timeInClip / clip.fadeIn;
          }
          if (clip.fadeOut > 0 && timeInClip > clip.duration - clip.fadeOut) {
            fadeMult *= (clip.duration - timeInClip) / clip.fadeOut;
          }
          const pixelGain = gainFactor * fadeMult;

          const px = x + i;
          const scaledMin = Math.max(-1, Math.min(1, channelData.min * pixelGain));
          const py = centerY - scaledMin * halfHeight;
          points.push(px, py);
        }

        if (points.length > 0) {
          const waveColor = clip.color || trackColor;
          waveforms.push(
            <Line
              key={`waveform-${clip.id}-ch${ch}`}
              points={points}
              fill={waveColor}
              opacity={0.6}
              closed
              stroke={waveColor}
              strokeWidth={1}
              tension={0.1}
              lineCap="round"
              lineJoin="round"
              listening={false}
            />,
          );
        }
      }

      return waveforms;
    };

    // Spectral view: amplitude-based heat map rendering using existing peak data
    const generateSpectralView = (): React.ReactNode[] => {
      if (!waveformData || waveformData.length === 0) return [];
      const shapes: React.ReactNode[] = [];
      const wfHeight = waveformHeight;
      const clipStartPeak = Math.max(0, Math.floor((clip.offset * fileSR) / cacheSpp));
      const totalAvailablePeaks = Math.max(0, waveformData.length - clipStartPeak);
      const totalClipPeaks = Math.min(Math.ceil(width), Math.ceil(totalAvailablePeaks / peakScale));
      const visibleStart = Math.max(0, Math.floor(-x));
      const visibleEnd = Math.min(totalClipPeaks, Math.ceil(dimensions.width - x));
      if (visibleEnd <= visibleStart) return [];
      const BAND_COUNT = 8;
      const bandH = wfHeight / BAND_COUNT;
      const colWidth = Math.max(1, Math.ceil(4 / peakScale));
      for (let i = visibleStart; i < visibleEnd; i += colWidth) {
        const dataIndex = clipStartPeak + Math.floor(i * peakScale);
        const peak = waveformData[dataIndex];
        if (!peak) continue;
        const amp = Math.min(1, Math.max(0, Math.abs(peak.channels[0]?.max ?? 0)));
        for (let b = 0; b < BAND_COUNT; b++) {
          const bandAmp = Math.max(0, amp - b * 0.1) * (1 + b * 0.15);
          const intensity = Math.min(1, bandAmp);
          if (intensity < 0.02) continue;
          const r = Math.round(intensity * 255);
          const g = Math.round(Math.max(0, (1 - intensity) * 200));
          const bv = Math.round((1 - intensity) * 180);
          shapes.push(
            <Rect
              key={`spec-${clip.id}-${i}-${b}`}
              x={x + i}
              y={clipY + 5 + (BAND_COUNT - 1 - b) * bandH}
              width={colWidth}
              height={bandH}
              fill={`rgb(${r},${g},${bv})`}
              opacity={intensity * 0.85}
              listening={false}
            />,
          );
        }
      }
      return shapes;
    };

    const generatePreviewWaveformPoints = (): React.ReactNode[] => {
      if (!previewWaveformData || previewWaveformData.length === 0) return [];
      const numChannels = previewWaveformData[0]?.channels?.length || 1;
      const waveforms: React.ReactNode[] = [];
      const visibleStart = Math.max(0, Math.floor(-x));
      const visibleEnd = Math.min(Math.ceil(width), Math.ceil(dimensions.width - x));
      if (visibleEnd <= visibleStart) return [];

      for (let ch = 0; ch < numChannels; ch += 1) {
        const points: number[] = [];
        const channelHeight = waveformHeight / numChannels;
        const channelY = clipY + 5 + ch * channelHeight;
        const centerY = channelY + channelHeight / 2;
        const halfHeight = channelHeight / 2 - 2;
        for (let i = visibleStart; i < visibleEnd; i += 1) {
          const dataIndex = Math.min(previewWaveformData.length - 1, Math.floor((i / Math.max(1, width)) * previewWaveformData.length));
          const channelData = previewWaveformData[dataIndex]?.channels[ch];
          if (!channelData) continue;
          points.push(x + i, centerY - Math.max(-1, Math.min(1, channelData.max)) * halfHeight);
        }
        for (let i = visibleEnd - 1; i >= visibleStart; i -= 1) {
          const dataIndex = Math.min(previewWaveformData.length - 1, Math.floor((i / Math.max(1, width)) * previewWaveformData.length));
          const channelData = previewWaveformData[dataIndex]?.channels[ch];
          if (!channelData) continue;
          points.push(x + i, centerY - Math.max(-1, Math.min(1, channelData.min)) * halfHeight);
        }
        if (points.length > 0) {
          waveforms.push(
            <Line
              key={`preview-waveform-${clip.id}-ch${ch}`}
              points={points}
              fill={clip.color || trackColor}
              opacity={0.38}
              closed
              stroke={clip.color || trackColor}
              strokeWidth={1}
              listening={false}
            />,
          );
        }
      }
      return waveforms;
    };

    const isSpectral = tracks.find((t) => t.id === trackId)?.spectralView;
    // Skip expensive waveform generation during active zoom or for narrow clips — just show clip rect
    const waveformShapes = (isZoomingRef.current || isNarrowClip)
      ? []
      : waveformData
        ? (isSpectral ? generateSpectralView() : generateWaveformPoints())
        : generatePreviewWaveformPoints();

    // Clip click — selection is handled in handleMouseDown to support drag
    const handleClipClick = () => {};

    // Handle drag start - only set up if not already set by handleMouseDown (for resize)
    const handleDragStart = (_e: any) => {
      // Don't re-select if already selected (preserves multi-selection during drag)
      if (!selectedClipIds.includes(clip.id)) {
        selectClip(clip.id);
      }

      // handleMouseDown already sets dragState (including multiClipInfo).
      // If it was set up for resize, keep that. Otherwise, nothing more to do here.
    };

    // Handle drag move
    const handleDragMove = (e: KonvaEvent) => {
      const gesture = dragStateRef.current;
      if (gesture.type !== "move" || gesture.clipId !== clip.id) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();

      // Calculate new time position for anchor clip
      const deltaX = pointerPos.x - gesture.startX;
      const deltaTime = deltaX / pixelsPerSecond;
      const rawStartTime = Math.max(0, gesture.originalStartTime + deltaTime);
      const newStartTime = computeTimelineMoveStart(
        gesture.originalStartTime,
        deltaTime,
        isSnapActive(Boolean(e.evt?.ctrlKey))
          ? (time) => snapTimelineTime(time, gesture.originalStartTime)
          : undefined,
      );

      // Calculate target track based on Y position
      const targetHit = getTrackAtY(pointerPos.y + scrollY, tracks, trackYs, trackHeight);
      const targetTrackIdx = targetHit?.trackIndex ?? Math.max(0, tracks.length - 1);
      const targetTY = trackYs[Math.max(0, targetTrackIdx)] ?? 0;

      // Update snap ghost preview: show semi-transparent rect at snapped position
      if (isSnapActive(Boolean(e.evt?.ctrlKey)) && Math.abs(newStartTime - rawStartTime) > 0.001) {
        const ghostScreenX = newStartTime * pixelsPerSecond - scrollX;
        const targetTrack = tracks[Math.max(0, Math.min(targetTrackIdx, tracks.length - 1))];
        const targetMetrics = targetTrack
          ? getTimelineRowMetrics(targetTrack, trackHeight)
          : rowMetrics;
        snapGhostRef.current = {
          x: ghostScreenX,
          y: targetTY + targetMetrics.clipInsetY,
          width: clip.duration * pixelsPerSecond,
          height: targetMetrics.clipHeight,
          color: clip.color || trackColor,
          visible: true,
        };
        setSnapGhostRender(snapGhostRef.current);
      } else {
        if (snapGhostRef.current) {
          snapGhostRef.current = null;
          setSnapGhostRender(null);
        }
      }

      // Compute actual timeDelta after snap (for multi-clip)
    const timeDelta = newStartTime - gesture.originalStartTime;

      // Determine if multi-clip drag
      const multi = gesture.multiClipInfo && gesture.multiClipInfo.length > 1;

      // Check if any clip in selection would go past last track (ghost track needed)
      const trackDelta = targetTrackIdx - (gesture.trackIndex ?? 0);
      let needsGhost = false;
      if (multi) {
        const maxTrackIdx = Math.max(...gesture.multiClipInfo!.map(m => m.trackIndex));
        needsGhost = maxTrackIdx + trackDelta >= tracks.length;
      } else {
        needsGhost = targetTrackIdx >= tracks.length;
      }

      if (needsGhost) {
        setShowGhostTrack(true);
      } else {
        setShowGhostTrack(false);
      }

      // Update time positions for all clips in the selection
      if (multi) {
        // Batch update all selected clips in one set() call
        useDAWStore.setState((state) => ({
          tracks: state.tracks.map(track => ({
            ...track,
            clips: track.clips.map(c => {
              const info = gesture.multiClipInfo!.find(m => m.clipId === c.id && !m.isMidi);
              if (info) return { ...c, startTime: Math.max(0, info.originalStartTime + timeDelta) };
              return c;
            }),
            midiClips: track.midiClips.map(mc => {
              const info = gesture.multiClipInfo!.find(m => m.clipId === mc.id && m.isMidi);
              if (info) return { ...mc, startTime: Math.max(0, info.originalStartTime + timeDelta) };
              return mc;
            }),
          })),
        }));
      } else {
        // Single clip — use existing moveClipToTrack
        if (newStartTime !== clip.startTime) {
          moveClipToTrack(clip.id, tracks[trackIndex].id, newStartTime);
        }
      }

      // Store visual target track — actual cross-track move happens on drag end
      const clampedTarget = Math.max(0, targetTrackIdx);
      if (clampedTarget !== gesture.targetTrackIndex) {
        setTimelineDragState(prev => ({ ...prev, targetTrackIndex: clampedTarget }));
      }
    };

    // Handle drag end
    const handleDragEnd = async () => {
      const gesture = dragStateRef.current;
      // Only handle if this clip was actually being dragged
      if (gesture.clipId !== clip.id) return;
      await finalizeTimelineClipGesture();

    };

    // Mouse handlers for edge resize
    const EDGE_THRESHOLD = 8;

    const handleMouseMove = (e: KonvaEvent) => {
      // In split mode, always show crosshair cursor
      if (toolModeRef.current === "split") {
        e.target.getStage().container().style.cursor = "crosshair";
        return;
      }
      // In mute mode, show pointer cursor
      if (toolModeRef.current === "mute") {
        e.target.getStage().container().style.cursor = "pointer";
        return;
      }
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      const relativeX = pointerPos.x - x;
      const clipTopY = clipY;
      const relativeY = pointerPos.y - clipTopY;

      if (toolModeRef.current === "smart") {
        // Smart tool: position-dependent cursor
        const FADE_CORNER = 15;
        if (relativeY < FADE_CORNER && (relativeX < FADE_CORNER || relativeX > width - FADE_CORNER)) {
          stage.container().style.cursor = "crosshair"; // fade zone
        } else if (relativeX < EDGE_THRESHOLD || relativeX > width - EDGE_THRESHOLD) {
          stage.container().style.cursor = "ew-resize"; // trim zone
        } else {
          stage.container().style.cursor = "move"; // move zone
        }
        return;
      }

      // Change cursor based on position
      if (relativeX < EDGE_THRESHOLD || relativeX > width - EDGE_THRESHOLD) {
        stage.container().style.cursor = "ew-resize";
      } else {
        stage.container().style.cursor = "move";
      }
    };

    const handleMouseLeave = (e: KonvaEvent) => {
      const stage = e.target.getStage();
      stage.container().style.cursor = "default";
    };

    const handleMouseDown = (e: KonvaEvent) => {
      // Split tool mode: click splits the clip at the clicked position
      if (toolModeRef.current === "split") {
        e.cancelBubble = true;
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        let splitTime = (pointerPos.x + scrollX) / pixelsPerSecond;
        if (isSnapActive(Boolean(e.evt?.ctrlKey))) {
          splitTime = snapTimelineTime(splitTime, splitTime);
        }
        splitClipAtPosition(clip.id, splitTime);
        return;
      }
      // Mute tool mode: click toggles clip mute
      if (toolModeRef.current === "mute") {
        e.cancelBubble = true;
        useDAWStore.getState().toggleClipMute(clip.id);
        return;
      }

      // Shift+click: add a gain envelope point at cursor position
      if (e.evt?.shiftKey && !e.evt?.ctrlKey && !e.evt?.altKey) {
        e.cancelBubble = true;
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        // Time relative to clip start
        const timeInClip = (pointerPos.x + scrollX) / pixelsPerSecond - clip.startTime;
        if (timeInClip >= 0 && timeInClip <= clip.duration) {
          // Map Y position to gain: top of clip = 2.0, bottom = 0.0
          const clipTopY = clipY;
          const clipH = clipHeight;
          const relativeY = pointerPos.y - clipTopY;
          const gain = Math.max(0, Math.min(2, 2 * (1 - relativeY / clipH)));
          addClipGainPoint(clip.id, timeInClip, gain);
        }
        return;
      }

      const ctrl = e.evt?.ctrlKey || e.evt?.metaKey;
      // Preserve multi-selection: if the clip is already selected in a multi-selection
      // and no Ctrl modifier, don't call selectClip (which would clear the selection).
      const currentSelectedIds = useDAWStore.getState().selectedClipIds;
      const isAlreadyInMultiSelection = currentSelectedIds.length > 1 && currentSelectedIds.includes(clip.id);
      if (!isAlreadyInMultiSelection || ctrl) {
        selectClip(clip.id, { ctrl });
      }

      // Locked clips cannot be moved or resized
      if (clip.locked) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      const relativeX = pointerPos.x - x;

      // Alt+drag on audio clip = slip editing (adjust offset, not position)
      if (e.evt?.altKey && clip.filePath) {
        e.cancelBubble = true;
        captureTimelineGestureUndo();
        const sourceLength = clip.sourceLength ?? (clip.offset + clip.duration + 60);
        const maxOffset = Math.max(0, sourceLength - clip.duration);
        slipEditRef.current = {
          clipId: clip.id,
          trackId: trackId,
          isMidi: false,
          startX: pointerPos.x,
          originalOffset: clip.offset || 0,
          sourceLength,
          clipDuration: clip.duration,
          maxOffset,
        };
        stage.container().style.cursor = "grab";
        return;
      }

      // Smart tool: detect fade corner zones
      if (toolModeRef.current === "smart") {
        const FADE_CORNER = 15;
        const clipTopY = clipY;
        const relativeY = pointerPos.y - clipTopY;
        if (relativeY < FADE_CORNER && relativeX < FADE_CORNER) {
          // Top-left corner: fade-in adjustment via drag
          e.cancelBubble = true;
          captureTimelineGestureUndo();
          setTimelineDragState({ type: "resize-left", clipId: clip.id, trackIndex, targetTrackIndex: trackIndex, startX: pointerPos.x, startTime: (pointerPos.x + scrollX) / pixelsPerSecond, originalStartTime: clip.startTime, originalDuration: clip.duration, originalOffset: clip.offset, isFadeDrag: true });
          stage.container().style.cursor = "crosshair";
          return;
        }
        if (relativeY < FADE_CORNER && relativeX > width - FADE_CORNER) {
          // Top-right corner: fade-out adjustment via drag
          e.cancelBubble = true;
          captureTimelineGestureUndo();
          setTimelineDragState({ type: "resize-right", clipId: clip.id, trackIndex, targetTrackIndex: trackIndex, startX: pointerPos.x, startTime: (pointerPos.x + scrollX) / pixelsPerSecond, originalStartTime: clip.startTime, originalDuration: clip.duration, originalOffset: clip.offset, isFadeDrag: true });
          stage.container().style.cursor = "crosshair";
          return;
        }
      }

      const dragType = classifyTimelineClipGesture(relativeX, width, EDGE_THRESHOLD);
      if (dragType !== "move") {
        stage.container().style.cursor = "ew-resize";
      }

      // Build multi-clip info when starting a drag on a multi-selected clip
      let multiClipInfo: typeof dragState.multiClipInfo;
      const latestSelectedIds = useDAWStore.getState().selectedClipIds;
      if (dragType === "move" && latestSelectedIds.length > 1 && latestSelectedIds.includes(clip.id)) {
        multiClipInfo = [];
        const currentTracks = useDAWStore.getState().tracks;
        for (let ti = 0; ti < currentTracks.length; ti++) {
          const t = currentTracks[ti];
          for (const c of t.clips) {
            if (latestSelectedIds.includes(c.id) && !c.locked) {
              multiClipInfo.push({ clipId: c.id, trackIndex: ti, originalStartTime: c.startTime, isMidi: false });
            }
          }
          for (const mc of t.midiClips) {
            if (latestSelectedIds.includes(mc.id)) {
              multiClipInfo.push({ clipId: mc.id, trackIndex: ti, originalStartTime: mc.startTime, isMidi: true });
            }
          }
        }
      }

      // Set drag state immediately - handleDragStart will preserve resize types
      captureTimelineGestureUndo();
      setTimelineDragState({
        type: dragType,
        clipId: clip.id,
        trackIndex,
        targetTrackIndex: trackIndex,
        startX: pointerPos.x,
        startTime: (pointerPos.x + scrollX) / pixelsPerSecond,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        originalOffset: clip.offset,
        multiClipInfo,
      });
    };

    // Modified drag move to handle resize
    const handleDragMoveModified = (e: KonvaEvent) => {
      const gesture = dragStateRef.current;
      if (!gesture.clipId || gesture.clipId !== clip.id) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      const deltaX = pointerPos.x - gesture.startX;
      const deltaTime = deltaX / pixelsPerSecond;

      // Smart tool fade drag: adjust fadeIn/fadeOut instead of resizing
      if (gesture.isFadeDrag) {
        const fadeDelta = Math.max(0, deltaTime);
        if (gesture.type === "resize-left") {
          const newFadeIn = Math.min(fadeDelta, clip.duration * 0.5);
          useDAWStore.getState().setClipFades(clip.id, newFadeIn, clip.fadeOut || 0);
        } else if (gesture.type === "resize-right") {
          const newFadeOut = Math.min(Math.max(0, -deltaTime), clip.duration * 0.5);
          useDAWStore.getState().setClipFades(clip.id, clip.fadeIn || 0, newFadeOut);
        }
        return;
      }

      if (gesture.type === "resize-left" || gesture.type === "resize-right") {
        previewResizeTimelineClip(clip.id, false, computeTimelineResize({
          kind: gesture.type,
          isMidi: false,
          originalStartTime: gesture.originalStartTime,
          originalDuration: gesture.originalDuration,
          originalOffset: gesture.originalOffset,
          deltaTime,
          sourceLength: clip.sourceLength,
          snapTime: isSnapActive(Boolean(e.evt?.ctrlKey))
            ? (time) => snapTimelineTime(time, gesture.originalStartTime)
            : undefined,
        }));
      } else {
        handleDragMove(e);
      }
    };

    return (
      <Group
        key={clip.id}
        draggable={!clip.locked}
        onDragStart={handleDragStart}
        onDragMove={handleDragMoveModified}
        onDragEnd={handleDragEnd}
        dragBoundFunc={(_pos: any) => {
          // During resize operations, prevent the Group from moving
          // Our handleDragMoveModified updates the clip state directly
          if (
            dragState.type === "resize-left" ||
            dragState.type === "resize-right"
          ) {
            return { x: 0, y: 0 }; // Lock position - we manage clip position via state
          }
          // For move operations, also return 0,0 because we update state directly
          // and the Group re-renders at the new position
          return { x: 0, y: 0 };
        }}
      >
        {/* Clip background with gradient-like layering */}
        <Rect
          x={x}
          y={clipY}
          width={width}
          height={clipHeight}
          fill={clip.color || trackColor}
          opacity={clip.muted ? 0.1 : isTrackMuted ? 0.12 : isCut ? 0.1 : 0.18}
          cornerRadius={4}
          listening={false}
        />
        {/* Gradient highlight at top of clip */}
        {!clip.muted && !isTrackMuted && !isCut && (
          <Rect
            x={x}
            y={clipY}
            width={width}
            height={Math.min(12, clipHeight / 3)}
            fill="#ffffff"
            opacity={0.04}
            cornerRadius={[4, 4, 0, 0]}
            listening={false}
          />
        )}
        {/* Waveform skeleton — shown while peaks are loading (skip for narrow clips) */}
        {!clip.muted && !isNarrowClip && clip.filePath && waveformShapes.length === 0 && (() => {
          const barCount = Math.min(32, Math.max(4, Math.floor(width / 6)));
          const barSpacing = width / barCount;
          const barWidth = Math.max(1.5, barSpacing * 0.4);
          const skeletonBars: React.ReactNode[] = [];
          // Deterministic pseudo-random heights based on clip id
          const seed = clip.id.charCodeAt(0) + clip.id.charCodeAt(clip.id.length - 1);
          for (let i = 0; i < barCount; i++) {
            const pseudoRand = Math.abs(Math.sin(seed * (i + 1) * 2.654)) * 0.6 + 0.2;
            const barH = waveformHeight * pseudoRand;
            const barY = clipY + 5 + (waveformHeight - barH) / 2;
            skeletonBars.push(
              <Rect
                key={`skel-${clip.id}-${i}`}
                x={x + i * barSpacing + (barSpacing - barWidth) / 2}
                y={barY}
                width={barWidth}
                height={barH}
                fill={clip.color || trackColor}
                opacity={0.15}
                cornerRadius={1}
                listening={false}
              />
            );
          }
          return skeletonBars;
        })()}
        {/* Waveform visualization */}
        {!clip.muted && waveformShapes}
        {/* Clip gain envelope line */}
        {clip.gainEnvelope && clip.gainEnvelope.length >= 2 && (() => {
          const clipH = clipHeight;
          const clipTopY = clipY;
          // Map gain envelope points to pixel coordinates
          // gain 0.0 = bottom of clip, gain 2.0 = top of clip, gain 1.0 = center
          const points: number[] = [];
          for (const pt of clip.gainEnvelope) {
            const px = x + pt.time * pixelsPerSecond;
            const py = clipTopY + clipH * (1 - pt.gain / 2);
            points.push(px, py);
          }
          return (
            <Line
              key={`gain-env-${clip.id}`}
              points={points}
              stroke="#ffd700"
              strokeWidth={1.5}
              opacity={0.7}
              lineCap="round"
              lineJoin="round"
              listening={false}
            />
          );
        })()}
        {/* Gain envelope dots (when selected) — interactive: drag to move, right-click to delete */}
        {isSelected && clip.gainEnvelope && clip.gainEnvelope.length >= 1 && (() => {
          const clipH = clipHeight;
          const clipTopY = clipY;
          return clip.gainEnvelope.map((pt, idx) => {
            const px = x + pt.time * pixelsPerSecond;
            const py = clipTopY + clipH * (1 - pt.gain / 2);
            return (
              <Circle
                key={`gain-pt-${clip.id}-${idx}`}
                x={px}
                y={py}
                radius={4}
                fill="#ffd700"
                stroke="#fff"
                strokeWidth={0.5}
                draggable
                onDragMove={(e) => {
                  const node = e.target;
                  const newPx = node.x();
                  const newPy = node.y();
                  const newTime = Math.max(0, (newPx - x) / pixelsPerSecond);
                  const newGain = Math.max(0, Math.min(2, 2 * (1 - (newPy - clipTopY) / clipH)));
                  moveClipGainPoint(clip.id, idx, newTime, newGain);
                }}
                onDragEnd={(e) => {
                  e.cancelBubble = true;
                }}
                onContextMenu={(e) => {
                  e.evt.preventDefault();
                  e.cancelBubble = true;
                  removeClipGainPoint(clip.id, idx);
                }}
                hitStrokeWidth={6}
              />
            );
          });
        })()}
        {/* Fade envelope overlays — curve-shaped, always visible */}
        {clip.fadeIn > 0 && (() => {
          const fadeW = clip.fadeIn * pixelsPerSecond;
          const clipH = clipHeight;
          const shape = (clip as AudioClip).fadeInShape ?? 0;
          // Curve points trace the fade gain from left (silence) to right (full)
          const curvePts = fadeInCurvePoints(x, clipY, fadeW, clipH, shape, 24);
          // Build a closed polygon: top-left corner -> along curve -> top edge back
          // The darkened area is above the curve (where audio is attenuated)
          const fillPts = [
            x, clipY,
            ...curvePts,   // curve from bottom-left to top-right
            x + fadeW, clipY,
          ];
          return (
            <>
              <Line
                points={fillPts}
                fill="#000000"
                opacity={0.3}
                closed
                listening={false}
              />
              <Line
                points={curvePts}
                stroke="#ffffff"
                strokeWidth={1}
                opacity={0.5}
                listening={false}
              />
            </>
          );
        })()}
        {clip.fadeOut > 0 && (() => {
          const fadeW = clip.fadeOut * pixelsPerSecond;
          const clipH = clipHeight;
          const shape = (clip as AudioClip).fadeOutShape ?? 0;
          // Curve points trace the fade gain from left (full) to right (silence)
          const curvePts = fadeOutCurvePoints(x, clipY, width, fadeW, clipH, shape, 24);
          // Darkened area is above the curve (where audio is attenuated)
          const fadeStartX = x + width - fadeW;
          const fillPts = [
            fadeStartX, clipY,
            ...curvePts,             // curve from top-left to bottom-right
            x + width, clipY,
          ];
          return (
            <>
              <Line
                points={fillPts}
                fill="#000000"
                opacity={0.3}
                closed
                listening={false}
              />
              <Line
                points={curvePts}
                stroke="#ffffff"
                strokeWidth={1}
                opacity={0.5}
                listening={false}
              />
            </>
          );
        })()}
        {/* Muted clip dark overlay + diagonal stripes */}
        {(clip.muted || isTrackMuted) && (
          <>
            <Rect
              x={x}
              y={clipY}
              width={width}
              height={clipHeight}
              fill="#000000"
              opacity={clip.muted ? 0.4 : 0.24}
              cornerRadius={3}
              listening={false}
            />
            <Group
              listening={false}
              opacity={clip.muted ? 0.2 : 0.12}
              clipFunc={(ctx: any) => {
                ctx.beginPath();
                ctx.roundRect(x, clipY, width, clipHeight, 3);
              }}
            >
              {Array.from({ length: Math.ceil(width / 12) + 1 }).map((_, i) => (
                <Line
                  key={`mute-stripe-${i}`}
                  points={[x + i * 12, clipY, x + i * 12 - clipHeight, clipY + clipHeight]}
                  stroke={clip.color || trackColor}
                  strokeWidth={1}
                />
              ))}
            </Group>
          </>
        )}
        {/* Clip border + interaction surface (must be topmost Rect to receive events) */}
        <Rect
          x={x}
          y={clipY}
          width={width}
          height={clipHeight}
          stroke={clip.muted || isTrackMuted ? "#666" : "#fff"}
          strokeWidth={0.5}
          cornerRadius={3}
          onClick={handleClipClick}
          onTap={handleClipClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onMouseDown={handleMouseDown}
          onContextMenu={(e: KonvaEvent) => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            if (shouldSuppressWorkspaceContextMenu(e.evt.target)) return;
            const stage = e.target.getStage();
            const pointerPos = stage?.getPointerPosition();
            setBackgroundContextMenu(null);
            setClipContextMenu({
              x: e.evt.clientX,
              y: e.evt.clientY,
              clipId: clip.id,
              trackId: trackId,
              kind: "audio",
              time: pointerPos ? Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond) : clip.startTime,
            });
          }}
        />
        {/* Clip name */}
        <Text
          x={x + 5}
          y={clipY + 3}
          text={clip.locked ? `🔒 ${clip.muted ? "[M] " : ""}${clip.name}` : clip.muted ? `[M] ${clip.name}` : clip.name}
          fontSize={10}
          fill={clip.muted || isTrackMuted ? "#888" : "#fff"}
          width={Math.max(0, width - 10)}
          ellipsis={true}
          wrap="none"
          listening={false}
        />
        {/* Volume line - draggable for per-clip gain */}
        {isSelected &&
          (() => {
            // Convert volumeDB to visual position (0dB = center, +12dB = top, -60dB = bottom)
            const volumeRange = 72; // -60 to +12 dB
            const volumeNormalized = (clip.volumeDB + 60) / volumeRange; // 0 to 1
            const volumeY = clipY + clipHeight * (1 - volumeNormalized);

            const handleVolumeMouseDown = (e: KonvaEvent) => {
              e.cancelBubble = true; // Prevent clip drag
              e.evt?.stopPropagation?.(); // Also stop native event
              beginClipVolumeEdit(clip.id); // Capture starting value for undo
            };

            const handleVolumeDrag = (e: KonvaEvent) => {
              e.cancelBubble = true; // Prevent bubbling to parent Group
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              const relativeY = pointerPos.y - clipY;
              const normalizedY = 1 - relativeY / clipHeight;
              const clampedY = Math.max(0, Math.min(1, normalizedY));
              const newVolumeDB = clampedY * volumeRange - 60;
              setClipVolume(clip.id, newVolumeDB);
            };

            const handleVolumeDragEnd = (e: KonvaEvent) => {
              e.cancelBubble = true; // Prevent bubbling
              commitClipVolumeEdit(clip.id); // Create undo command for the full drag
            };

            return (
              <>
                {/* Visible volume line */}
                <Line
                  points={[x, volumeY, x + width, volumeY]}
                  stroke="#ffaa00"
                  strokeWidth={2}
                  opacity={0.8}
                  listening={false}
                />
                {/* Invisible wider hit area for dragging the volume line */}
                <Rect
                  x={x}
                  y={volumeY - 6}
                  width={width}
                  height={12}
                  fill="transparent"
                  draggable
                  onMouseDown={handleVolumeMouseDown}
                  onDragStart={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                  }}
                  onDragMove={handleVolumeDrag}
                  onDragEnd={handleVolumeDragEnd}
                  dragBoundFunc={(pos: any) => ({
                    x: x, // Lock horizontal position
                    y: Math.max(clipY, Math.min(clipY + clipHeight, pos.y)),
                  })}
                  style={{ cursor: "ns-resize" }}
                />
                <Text
                  x={x + 5}
                  y={volumeY - 14}
                  text={`${clip.volumeDB.toFixed(1)} dB`}
                  fontSize={9}
                  fill="#ffaa00"
                  listening={false}
                />
              </>
            );
          })()}
        {/* Fade handles - draggable triangles at fade positions */}
        {isSelected &&
          (() => {
            const handleFadeInDrag = (e: KonvaEvent) => {
              e.cancelBubble = true; // Prevent parent Group from receiving event
              e.evt?.stopPropagation?.();
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              // Calculate fade length based on pointer position relative to clip start
              const relativeX = pointerPos.x - x;
              const fadeLength = Math.max(
                0,
                Math.min(clip.duration / 2, relativeX / pixelsPerSecond),
              );
              setClipFades(clip.id, fadeLength, clip.fadeOut);
            };

            const handleFadeOutDrag = (e: KonvaEvent) => {
              e.cancelBubble = true; // Prevent parent Group from receiving event
              e.evt?.stopPropagation?.();
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              // Calculate fade length based on pointer position relative to clip end
              const relativeX = (x + width) - pointerPos.x;
              const fadeLength = Math.max(
                0,
                Math.min(clip.duration / 2, relativeX / pixelsPerSecond),
              );
              setClipFades(clip.id, clip.fadeIn, fadeLength);
            };

            const fadeInWidth = clip.fadeIn * pixelsPerSecond;
            const fadeOutWidth = clip.fadeOut * pixelsPerSecond;
            // Max position for fade handles (half of clip width)
            const maxFadeWidth = width / 2;

            return (
              <>
                {/* Fade in handle - circle at fade position */}
                <Circle
                  x={x + fadeInWidth}
                  y={clipY + 5}
                  radius={6}
                  fill="#4cc9f0"
                  stroke="#fff"
                  strokeWidth={1}
                  draggable
                  onMouseDown={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragStart={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragMove={handleFadeInDrag}
                  onDragEnd={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  dragBoundFunc={(pos: any) => ({
                    x: Math.max(x, Math.min(x + maxFadeWidth, pos.x)),
                    y: clipY + 5,
                  })}
                />
                {/* Fade out handle - circle at fade position */}
                <Circle
                  x={x + width - fadeOutWidth}
                  y={clipY + 5}
                  radius={6}
                  fill="#4cc9f0"
                  stroke="#fff"
                  strokeWidth={1}
                  draggable
                  onMouseDown={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragStart={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragMove={handleFadeOutDrag}
                  onDragEnd={(e: KonvaEvent) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  dragBoundFunc={(pos: any) => ({
                    x: Math.max(x + width - maxFadeWidth, Math.min(x + width, pos.x)),
                    y: clipY + 5,
                  })}
                />
              </>
            );
          })()}
        {/* Ripple editing indicator — shows arrow on clips that will shift */}
        {rippleMode !== "off" &&
          dragState.type !== null &&
          dragState.clipId !== clip.id &&
          (rippleMode === "all_tracks" || dragState.trackIndex === trackIndex) &&
          clip.startTime >= dragState.originalStartTime && (
          <Group listening={false}>
            <Rect
              x={x + 2}
              y={clipY + clipHeight - 13}
              width={16}
              height={12}
              fill="#000000"
              opacity={0.5}
              cornerRadius={2}
            />
            <Text
              x={x + 3}
              y={clipY + clipHeight - 13}
              text={"\u2192"}
              fontSize={11}
              fill="#4cc9f0"
              listening={false}
            />
          </Group>
        )}
      </Group>
    );
  };

  const renderCompactMIDIThumbnail = (
    events: MIDIEvent[],
    clipDuration: number,
    x: number,
    width: number,
    clipY: number,
    previewHeight: number,
    clipColor: string,
    isMuted: boolean,
    activeNotes?: { note: number; startTimestamp: number }[],
  ) => {
    const safeDuration = Math.max(clipDuration, 0.001);
    const bars = sampleMIDIThumbnailBars(
      buildMIDIThumbnailBars(events, safeDuration, activeNotes),
      width,
    );

    if (bars.length === 0) return null;

    const notes = bars.map((bar) => bar.note);
    const minNote = Math.min(...notes);
    const maxNote = Math.max(...notes);
    const noteRange = Math.max(1, maxNote - minNote);
    const isNarrowMidi = width < 60;

    return bars.map((bar, index) => {
      const noteX = x + (bar.start / safeDuration) * width;
      const noteWidth = Math.max(
        isNarrowMidi ? 1 : 2,
        ((Math.max(bar.end, bar.start) - bar.start) / safeDuration) * width,
      );
      const noteY = clipY + 5 + ((maxNote - bar.note) / noteRange) * (previewHeight - 4);
      const noteHeight = isNarrowMidi
        ? Math.max(1.5, Math.min(3, previewHeight / noteRange))
        : Math.max(2, Math.min(previewHeight / noteRange, 4));

      return (
        <Rect
          key={`midi-preview-${index}-${bar.note}-${bar.start}`}
          x={noteX}
          y={noteY}
          width={isNarrowMidi ? Math.max(1, width * 0.05, noteWidth) : noteWidth}
          height={noteHeight}
          fill={clipColor}
          opacity={isMuted ? (isNarrowMidi ? 0.45 : 0.4) : (isNarrowMidi ? 0.9 : 0.8)}
          listening={false}
        />
      );
    });
  };

  // Render recording clip with live waveform
  const renderRecordingClip = (
    clip: RecordingClip,
    trackY: number,
    trackColor: string,
  ) => {
    const track = tracks.find((candidate) => candidate.id === clip.trackId);
    const isMIDIRecordingTrack =
      track?.type === "midi" || track?.type === "instrument";
    const rowMetrics = getTimelineRowMetrics(
      track ?? {
        type: "audio",
        showAutomation: false,
        automationLanes: [],
      },
      trackHeight,
    );
    const clipY = trackY + rowMetrics.clipInsetY;
    const clipHeight = rowMetrics.clipHeight;
    const x = clip.startTime * pixelsPerSecond - scrollX;
    const width = (recordingRenderTime - clip.startTime) * pixelsPerSecond;
    const previewHeight = Math.max(8, clipHeight - 10);

    if (width <= 0) return null;

    // Get recording waveform data if available
    const recordingData = recordingWaveformCache.get(clip.trackId);
    const midiPreview = recordingMIDIPreviews[clip.trackId];

    // Generate waveform visualization from recording peaks
    const renderRecordingWaveform = (): React.ReactNode[] => {
      if (!recordingData || recordingData.peaks.length === 0) return [];

      const { peaks: recordingPeaks, widthPixels: peaksWidth } = recordingData;
      const numChannels = recordingPeaks[0]?.channels?.length || 1;
      const waveforms: React.ReactNode[] = [];
      const waveformHeight = Math.max(8, clipHeight - 10);

      for (let ch = 0; ch < numChannels; ch++) {
        const points: number[] = [];
        const channelHeight = waveformHeight / numChannels;
        const channelY = clipY + 5 + ch * channelHeight;
        const centerY = channelY + channelHeight / 2;
        const halfHeight = channelHeight / 2 - 2;

        // Draw top half (max values) - use peaksWidth (width at fetch time), not current width
        for (let i = 0; i < recordingPeaks.length; i++) {
          const channelData = recordingPeaks[i].channels[ch];
          if (!channelData) continue;

          const px = x + (i * peaksWidth) / recordingPeaks.length;
          const py = centerY - channelData.max * halfHeight;
          points.push(px, py);
        }

        // Draw bottom half (min values, reversed)
        for (let i = recordingPeaks.length - 1; i >= 0; i--) {
          const channelData = recordingPeaks[i].channels[ch];
          if (!channelData) continue;

          const px = x + (i * peaksWidth) / recordingPeaks.length;
          const py = centerY - channelData.min * halfHeight;
          points.push(px, py);
        }

        if (points.length > 0) {
          waveforms.push(
            <Line
              key={`recording-waveform-${clip.trackId}-ch${ch}`}
              points={points}
              fill={trackColor}
              opacity={0.8}
              closed
              stroke={trackColor}
              strokeWidth={0.5}
              listening={false}
            />,
          );
        }
      }

      return waveforms;
    };

    return (
      <Group key={`recording-${clip.trackId}`}>
        {/* Background */}
        <Rect
          x={x}
          y={clipY}
          width={width}
          height={clipHeight}
          fill={trackColor}
          opacity={0.3}
          cornerRadius={3}
          stroke={trackColor}
          strokeWidth={1}
        />
        {/* Live waveform or MIDI preview visualization */}
        {isMIDIRecordingTrack
          ? renderCompactMIDIThumbnail(
              midiPreview?.events || [],
              Math.max(0.001, recordingRenderTime - clip.startTime),
              x,
              width,
              clipY,
              previewHeight,
              trackColor,
              !!track?.muted,
              midiPreview?.activeNotes,
            )
          : renderRecordingWaveform()}
        {/* Recording indicator text */}
        <Text
          x={x + 5}
          y={clipY + 3}
          text="REC"
          fontSize={10}
          fill="#fff"
          fontStyle="bold"
          listening={false}
        />
        {/* Recording indicator dot (pulsing effect via opacity) */}
        <Circle
          x={x + 35}
          y={clipY + 8}
          radius={4}
          fill="#ff3333"
          listening={false}
        />
      </Group>
    );
  };

  // Render MIDI clip
  const renderMIDIClip = (
    clip: MIDIClip,
    _trackIndex: number,
    trackY: number,
    trackColor: string,
    trackId: string,
  ) => {
    const track = tracks[_trackIndex];
    const x = clip.startTime * pixelsPerSecond - scrollX;
    const width = clip.duration * pixelsPerSecond;
    const rowMetrics = getTimelineRowMetrics(track, trackHeight);
    const clipHeight = rowMetrics.clipHeight;
    const previewHeight = Math.max(8, clipHeight - 10);
    const isTrackMuted = !!track?.muted;
    const isClipMuted = !!clip.muted;
    const isMuted = isTrackMuted || isClipMuted;
    const isSelected = selectedClipIds.includes(clip.id);
    const isNarrowMidi = width < 60;
    let visualTrackY = trackY;

    // Visual offset for multi-clip drag
    if (dragState.type === "move" && dragState.multiClipInfo && dragState.multiClipInfo.length > 1 && dragState.targetTrackIndex != null) {
      const info = dragState.multiClipInfo.find(m => m.clipId === clip.id);
      if (info) {
        const trackDelta = dragState.targetTrackIndex - (dragState.trackIndex ?? 0);
        const visualTrackIdx = info.trackIndex + trackDelta;
        if (visualTrackIdx !== _trackIndex) {
          visualTrackY = trackYs[visualTrackIdx] ?? visualTrackY;
        }
      }
    }
    const clipY = visualTrackY + rowMetrics.clipInsetY;

    // Skip if clip is outside visible area
    if (x + width < 0 || x > dimensions.width) return null;

    const visibleEvents = getVisibleMIDIEventsForClip(clip);
    const sourceLoopLength = getMIDIClipSourceLoopLength(clip);
    const showLoopNotches = sourceLoopLength > 0 && clip.duration > sourceLoopLength + 0.000001;
    const loopPhase = showLoopNotches
      ? (((clip.offset || 0) % sourceLoopLength) + sourceLoopLength) % sourceLoopLength
      : 0;
    const loopNotches: React.ReactNode[] = [];
    if (showLoopNotches) {
      let notchTime = sourceLoopLength - loopPhase;
      if (notchTime <= 0.000001) notchTime += sourceLoopLength;
      let notchIndex = 0;
      while (notchTime < clip.duration - 0.000001 && notchIndex < 512) {
        const notchX = x + notchTime * pixelsPerSecond;
        if (notchX >= x && notchX <= x + width) {
          loopNotches.push(
            <Line
              key={`midi-loop-notch-${clip.id}-${notchIndex}`}
              points={[notchX, clipY + 2, notchX, clipY + clipHeight - 2]}
              stroke="rgba(255,255,255,0.34)"
              strokeWidth={1}
              dash={[3, 3]}
              listening={false}
            />,
          );
        }
        notchTime += sourceLoopLength;
        notchIndex += 1;
      }
    }
    const EDGE_THRESHOLD = 8;

    const handleMIDIClipMouseMove = (e: KonvaEvent) => {
      const stage = e.target.getStage();
      if (toolModeRef.current === "split") {
        stage.container().style.cursor = "crosshair";
        return;
      }
      if (toolModeRef.current === "mute") {
        stage.container().style.cursor = "pointer";
        return;
      }
      const pointerPos = stage.getPointerPosition();
      const relativeX = pointerPos.x - x;
      stage.container().style.cursor =
        relativeX < EDGE_THRESHOLD || relativeX > width - EDGE_THRESHOLD
          ? "ew-resize"
          : "move";
    };

    const handleMIDIClipMouseLeave = (e: KonvaEvent) => {
      e.target.getStage().container().style.cursor = "default";
    };

    const handleMIDIClipMouseDown = (e: KonvaEvent) => {
      if (toolModeRef.current === "split") {
        e.cancelBubble = true;
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        let splitTime = (pointerPos.x + scrollX) / pixelsPerSecond;
        if (isSnapActive(Boolean(e.evt?.ctrlKey))) {
          splitTime = snapTimelineTime(splitTime, splitTime);
        }
        splitMIDIClipAtPosition(clip.id, splitTime);
        return;
      }

      if (toolModeRef.current === "mute") {
        e.cancelBubble = true;
        useDAWStore.getState().toggleClipMute(clip.id);
        return;
      }

      e.cancelBubble = true;
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      const ctrl = e.evt?.ctrlKey || e.evt?.metaKey;
      const relativeX = pointerPos.x - x;
      const dragType = classifyTimelineClipGesture(relativeX, width, EDGE_THRESHOLD);
      if (dragType !== "move") {
        stage.container().style.cursor = "ew-resize";
      }
      const copyOnDrag = Boolean(ctrl && dragType === "move" && !clip.locked);
      const currentSelectedIds = useDAWStore.getState().selectedClipIds;
      const isAlreadyInMultiSelection = currentSelectedIds.length > 1 && currentSelectedIds.includes(clip.id);
      if (!copyOnDrag && (!isAlreadyInMultiSelection || ctrl)) {
        selectClip(clip.id, { ctrl });
      }

      if (clip.locked) return;

      if (e.evt?.altKey) {
        e.cancelBubble = true;
        captureTimelineGestureUndo();
        const sourceLength = Math.max(0.01, clip.sourceLength || clip.loopLength || clip.duration);
        const midiIsLooped = clip.duration > sourceLength + 0.000001;
        const maxOffset = Math.max(0, midiIsLooped ? sourceLength - 0.000001 : sourceLength - clip.duration);
        slipEditRef.current = {
          clipId: clip.id,
          trackId,
          isMidi: true,
          startX: pointerPos.x,
          originalOffset: clip.offset || 0,
          sourceLength,
          clipDuration: clip.duration,
          maxOffset,
        };
        stage.container().style.cursor = "grab";
        return;
      }

      let multiClipInfo: typeof dragState.multiClipInfo;
      const latestSelectedIds = useDAWStore.getState().selectedClipIds;
      if (!copyOnDrag && dragType === "move" && latestSelectedIds.length > 1 && latestSelectedIds.includes(clip.id)) {
        multiClipInfo = [];
        const currentTracks = useDAWStore.getState().tracks;
        for (let ti = 0; ti < currentTracks.length; ti++) {
          const t = currentTracks[ti];
          for (const c of t.clips) {
            if (latestSelectedIds.includes(c.id) && !c.locked) {
              multiClipInfo.push({ clipId: c.id, trackIndex: ti, originalStartTime: c.startTime, isMidi: false });
            }
          }
          for (const mc of t.midiClips) {
            if (latestSelectedIds.includes(mc.id) && !mc.locked) {
              multiClipInfo.push({ clipId: mc.id, trackIndex: ti, originalStartTime: mc.startTime, isMidi: true });
            }
          }
        }
      }

      captureTimelineGestureUndo();
      setTimelineDragState({
        type: dragType,
        clipId: clip.id,
        trackIndex: _trackIndex,
        targetTrackIndex: _trackIndex,
        startX: pointerPos.x,
        startTime: (pointerPos.x + scrollX) / pixelsPerSecond,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        originalOffset: clip.offset || 0,
        copyOnDrag,
        previewStartTime: clip.startTime,
        multiClipInfo,
      });
    };

    const handleMIDIClipClick = (e: KonvaEvent) => {
      if (toolModeRef.current === "split") return; // handled in mousedown
      const ctrl = e.evt?.ctrlKey || e.evt?.metaKey;
      const beforeClick = useDAWStore.getState();
      const preserveDockedSelection = beforeClick.showPianoRoll
        && !ctrl
        && beforeClick.selectedClipIds.length > 1
        && beforeClick.selectedClipIds.includes(clip.id);

      if (!preserveDockedSelection) {
        selectClip(clip.id, { ctrl });
      }

      const afterClick = useDAWStore.getState();
      if (afterClick.showPianoRoll && afterClick.selectedClipIds.includes(clip.id)) {
        openPianoRoll(trackId, clip.id);
      }
    };

    const handleMIDIClipDoubleClick = () => {
      // Open piano roll editor
      openPianoRoll(trackId, clip.id);
    };

    const handleMIDIClipDragStart = () => {
      if (!selectedClipIds.includes(clip.id)) {
        selectClip(clip.id);
      }
    };

    const handleMIDIClipDragMove = (e: KonvaEvent) => {
      const gesture = dragStateRef.current;
      if (!gesture.clipId || gesture.clipId !== clip.id) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      const deltaX = pointerPos.x - gesture.startX;
      const deltaTime = deltaX / pixelsPerSecond;

      if (gesture.type === "resize-left") {
        previewResizeTimelineClip(clip.id, true, computeTimelineResize({
          kind: "resize-left",
          isMidi: true,
          originalStartTime: gesture.originalStartTime,
          originalDuration: gesture.originalDuration,
          originalOffset: gesture.originalOffset,
          deltaTime,
          snapTime: isSnapActive(Boolean(e.evt?.ctrlKey))
            ? (time) => snapTimelineTime(time, gesture.originalStartTime)
            : undefined,
        }));
        return;
      }

      if (gesture.type === "resize-right") {
        previewResizeTimelineClip(clip.id, true, computeTimelineResize({
          kind: "resize-right",
          isMidi: true,
          originalStartTime: gesture.originalStartTime,
          originalDuration: gesture.originalDuration,
          originalOffset: gesture.originalOffset,
          deltaTime,
          sourceLength: clip.sourceLength,
          snapTime: isSnapActive(Boolean(e.evt?.ctrlKey))
            ? (time) => snapTimelineTime(time, gesture.originalStartTime)
            : undefined,
        }));
        return;
      }

      if (gesture.type !== "move") return;

      const rawStartTime = Math.max(0, gesture.originalStartTime + deltaTime);
      const newStartTime = computeTimelineMoveStart(
        gesture.originalStartTime,
        deltaTime,
        isSnapActive(Boolean(e.evt?.ctrlKey))
          ? (time) => snapTimelineTime(time, gesture.originalStartTime)
          : undefined,
      );

      const targetTrackIdx = getTimelineDropTrackIndex(pointerPos.y + scrollY, tracks, trackYs, trackHeight);
      const targetTY = targetTrackIdx >= tracks.length
        ? contentHeight
        : trackYs[Math.max(0, targetTrackIdx)] ?? 0;
      const targetTrack = tracks[Math.max(0, Math.min(targetTrackIdx, tracks.length - 1))];
      const targetMetrics = targetTrack
        ? getTimelineRowMetrics(targetTrack, trackHeight)
        : rowMetrics;

      if (gesture.copyOnDrag) {
        snapGhostRef.current = {
          x: newStartTime * pixelsPerSecond - scrollX,
          y: targetTY + targetMetrics.clipInsetY,
          width: clip.duration * pixelsPerSecond,
          height: targetMetrics.clipHeight,
          color: clip.color || trackColor,
          visible: true,
        };
        setSnapGhostRender(snapGhostRef.current);
        setShowGhostTrack(targetTrackIdx >= tracks.length);
        const clampedTarget = Math.max(0, targetTrackIdx);
        if (
          clampedTarget !== gesture.targetTrackIndex
          || Math.abs((gesture.previewStartTime ?? gesture.originalStartTime) - newStartTime) > 0.0001
        ) {
          setTimelineDragState((prev) => ({
            ...prev,
            targetTrackIndex: clampedTarget,
            previewStartTime: newStartTime,
          }));
        }
        return;
      }

      if (isSnapActive(Boolean(e.evt?.ctrlKey)) && Math.abs(newStartTime - rawStartTime) > 0.001) {
        const ghostScreenX = newStartTime * pixelsPerSecond - scrollX;
        snapGhostRef.current = {
          x: ghostScreenX,
          y: targetTY + targetMetrics.clipInsetY,
          width: clip.duration * pixelsPerSecond,
          height: targetMetrics.clipHeight,
          color: clip.color || trackColor,
          visible: true,
        };
        setSnapGhostRender(snapGhostRef.current);
      } else if (snapGhostRef.current) {
        snapGhostRef.current = null;
        setSnapGhostRender(null);
      }

      const timeDelta = newStartTime - gesture.originalStartTime;
      const multi = gesture.multiClipInfo && gesture.multiClipInfo.length > 1;
      const trackDelta = targetTrackIdx - (gesture.trackIndex ?? 0);
      const needsGhost = multi
        ? Math.max(...gesture.multiClipInfo!.map((m) => m.trackIndex)) + trackDelta >= tracks.length
        : targetTrackIdx >= tracks.length;
      setShowGhostTrack(needsGhost);

      if (multi) {
        useDAWStore.setState((state) => ({
          tracks: state.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((c) => {
              const info = gesture.multiClipInfo!.find((m) => m.clipId === c.id && !m.isMidi);
              return info ? { ...c, startTime: Math.max(0, info.originalStartTime + timeDelta) } : c;
            }),
            midiClips: track.midiClips.map((mc) => {
              const info = gesture.multiClipInfo!.find((m) => m.clipId === mc.id && m.isMidi);
              return info ? { ...mc, startTime: Math.max(0, info.originalStartTime + timeDelta) } : mc;
            }),
          })),
          isModified: true,
        }));
      } else if (newStartTime !== clip.startTime) {
        void moveClipToTrack(clip.id, tracks[_trackIndex].id, newStartTime);
      }

      const clampedTarget = Math.max(0, targetTrackIdx);
      if (clampedTarget !== gesture.targetTrackIndex) {
        setTimelineDragState((prev) => ({ ...prev, targetTrackIndex: clampedTarget }));
      }
    };

    const handleMIDIClipDragEnd = async () => {
      const gesture = dragStateRef.current;
      if (gesture.clipId !== clip.id) return;
      await finalizeTimelineClipGesture();

    };

    return (
      <Group
        key={clip.id}
        draggable={!clip.locked}
        onDragStart={handleMIDIClipDragStart}
        onDragMove={handleMIDIClipDragMove}
        onDragEnd={handleMIDIClipDragEnd}
        dragBoundFunc={() => ({ x: 0, y: 0 })}
      >
        {/* Clip background */}
        <Rect
          x={x}
          y={clipY}
          width={width}
          height={clipHeight}
          fill={clip.color || trackColor}
          opacity={isMuted ? 0.14 : 0.25}
          cornerRadius={3}
          listening={false}
        />
        {/* Note preview */}
        {renderCompactMIDIThumbnail(
          visibleEvents,
          clip.duration,
          x,
          width,
          clipY,
          previewHeight,
          clip.color || trackColor,
          isMuted,
        )}
        {loopNotches}
        {/* Clip border */}
        <Rect
          x={x}
          y={clipY}
          width={width}
          height={clipHeight}
          stroke={isSelected ? "#d9f4ff" : isMuted ? "#666" : "rgba(255,255,255,0.68)"}
          strokeWidth={isSelected ? 1.5 : 0.75}
          cornerRadius={3}
          listening={false}
        />
        {width >= 18 && (
          <>
            <Rect
              x={x}
              y={clipY + 2}
              width={4}
              height={clipHeight - 4}
              fill={isSelected ? "#d9f4ff" : "rgba(255,255,255,0.42)"}
              cornerRadius={2}
              opacity={isMuted ? 0.35 : 0.85}
              listening={false}
            />
            <Rect
              x={x + width - 4}
              y={clipY + 2}
              width={4}
              height={clipHeight - 4}
              fill={isSelected ? "#d9f4ff" : "rgba(255,255,255,0.42)"}
              cornerRadius={2}
              opacity={isMuted ? 0.35 : 0.85}
              listening={false}
            />
          </>
        )}
        {/* MIDI indicator — compact for narrow clips */}
        <Text
          x={x + (isNarrowMidi ? 2 : 5)}
          y={clipY + 3}
          text={isNarrowMidi ? "♪" : `♪ ${clip.name}`}
          fontSize={isNarrowMidi ? 9 : 10}
          fill={isTrackMuted ? "#888" : "#fff"}
          width={Math.max(0, width - (isNarrowMidi ? 4 : 10))}
          ellipsis={true}
          wrap="none"
          listening={false}
        />
        {(clip.offset || 0) > 0.000001 && width >= 70 && (
          <Text
            x={x + 6}
            y={clipY + clipHeight - 14}
            text={`Slip +${(clip.offset || 0).toFixed(2)}s`}
            fontSize={9}
            fill="rgba(255,255,255,0.72)"
            listening={false}
          />
        )}
        <Rect
          x={x}
          y={clipY}
          width={width}
          height={clipHeight}
          fill="rgba(0,0,0,0)"
          onMouseMove={handleMIDIClipMouseMove}
          onMouseLeave={handleMIDIClipMouseLeave}
          onMouseDown={handleMIDIClipMouseDown}
          onClick={handleMIDIClipClick}
          onTap={handleMIDIClipClick}
          onDblClick={handleMIDIClipDoubleClick}
          onDblTap={handleMIDIClipDoubleClick}
          onContextMenu={(e: KonvaEvent) => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            if (shouldSuppressWorkspaceContextMenu(e.evt.target)) return;
            const stage = e.target.getStage();
            const pointerPos = stage?.getPointerPosition();
            if (!selectedClipIds.includes(clip.id)) {
              selectClip(clip.id);
            }
            setBackgroundContextMenu(null);
            setClipContextMenu({
              x: e.evt.clientX,
              y: e.evt.clientY,
              clipId: clip.id,
              trackId,
              kind: "midi",
              time: pointerPos ? Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond) : clip.startTime,
            });
          }}
        />
        {/* Ripple editing indicator — shows arrow on MIDI clips that will shift */}
        {rippleMode !== "off" &&
          dragState.type !== null &&
          dragState.clipId !== clip.id &&
          (rippleMode === "all_tracks" || dragState.trackIndex === _trackIndex) &&
          clip.startTime >= dragState.originalStartTime && (
          <Group listening={false}>
            <Rect
              x={x + 2}
              y={trackY + trackHeight - 18}
              width={16}
              height={12}
              fill="#000000"
              opacity={0.5}
              cornerRadius={2}
            />
            <Text
              x={x + 3}
              y={trackY + trackHeight - 18}
              text={"\u2192"}
              fontSize={11}
              fill="#4cc9f0"
              listening={false}
            />
          </Group>
        )}
      </Group>
    );
  };

  // Handle double-click on empty MIDI track area to create new clip
  const handleTrackDoubleClick = (
    trackId: string,
    trackType: string,
    clickTime: number,
  ) => {
    if (trackType === "midi" || trackType === "instrument") {
      // Create a new MIDI clip at the clicked position
      const newClipId = addMIDIClip(trackId, clickTime, 4); // 4 second default duration
      // Open the piano roll for the new clip
      openPianoRoll(trackId, newClipId);
    }
  };

  // Render loop region
  const renderLoopRegion = () => {
    if (!loopEnabled) return null;

    const startX = loopStart * pixelsPerSecond - scrollX;
    const endX = loopEnd * pixelsPerSecond - scrollX;

    return (
      <Rect
        x={startX}
        y={0}
        width={endX - startX}
        height={stageHeight}
        fill="#a855f7"
        opacity={0.1}
        listening={false}
      />
    );
  };

  // Render time selection
  const renderTimeSelection = () => {
    if (!timeSelection) return null;

    const startX = timeSelection.start * pixelsPerSecond - scrollX;
    const endX = timeSelection.end * pixelsPerSecond - scrollX;

    return (
      <Rect
        x={startX}
        y={0}
        width={endX - startX}
        height={stageHeight}
        fill="#3b82f6"
        opacity={0.15}
        listening={false}
      />
    );
  };

  // Render automation lanes for a track
  // Catmull-Rom spline interpolation between automation points for smooth curves.
  const interpolateAutomationCurve = (rawPts: number[], subdivisions: number = 8): number[] => {
    const n = rawPts.length / 2;
    if (n < 2) return rawPts;
    if (n === 2) return rawPts;
    const result: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const p0x = i > 0 ? rawPts[(i - 1) * 2] : rawPts[0];
      const p0y = i > 0 ? rawPts[(i - 1) * 2 + 1] : rawPts[1];
      const p1x = rawPts[i * 2];
      const p1y = rawPts[i * 2 + 1];
      const p2x = rawPts[(i + 1) * 2];
      const p2y = rawPts[(i + 1) * 2 + 1];
      const p3x = i + 2 < n ? rawPts[(i + 2) * 2] : rawPts[(n - 1) * 2];
      const p3y = i + 2 < n ? rawPts[(i + 2) * 2 + 1] : rawPts[(n - 1) * 2 + 1];
      for (let s = 0; s < subdivisions; s++) {
        const t = s / subdivisions;
        const t2 = t * t;
        const t3 = t2 * t;
        result.push(
          0.5 * ((2 * p1x) + (-p0x + p2x) * t + (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 + (-p0x + 3 * p1x - 3 * p2x + p3x) * t3),
          0.5 * ((2 * p1y) + (-p0y + p2y) * t + (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 + (-p0y + 3 * p1y - 3 * p2y + p3y) * t3),
        );
      }
    }
    result.push(rawPts[(n - 1) * 2], rawPts[(n - 1) * 2 + 1]);
    return result;
  };

  // Format automation value for tooltip display
  const formatAutoValue = (param: string, value: number): string =>
    formatAutomationValue(param, value);

  // Colors and labels are now centralized in automationParams.ts

  // Render automation lanes as separate rows BELOW the clip area
  const renderAutomationLanes = (track: Track, trackY: number) => {
    if (!track.showAutomation) return null;

    const visibleLanes = track.automationLanes.filter((l) => l.visible);
    if (visibleLanes.length === 0) return null;

    return visibleLanes.map((lane, laneIdx) => {
      const color = getAutomationColor(lane.param);
      const laneTop = trackY + trackHeight + laneIdx * AUTOMATION_LANE_HEIGHT;
      const laneH = AUTOMATION_LANE_HEIGHT;
      const laneBottom = laneTop + laneH;

      // Build points in lane-local coordinates
      const rawPoints: number[] = [];
      for (const point of lane.points) {
        const px = point.time * pixelsPerSecond - scrollX;
        const py = laneTop + laneH * (1 - point.value);
        rawPoints.push(px, py);
      }

      const smoothPoints = rawPoints.length >= 4
        ? interpolateAutomationCurve(rawPoints, 8)
        : rawPoints;

      // Fill area under curve
      const fillPoints: number[] = [];
      if (smoothPoints.length >= 4) {
        fillPoints.push(smoothPoints[0], laneBottom);
        for (let fi = 0; fi < smoothPoints.length; fi++) fillPoints.push(smoothPoints[fi]);
        fillPoints.push(smoothPoints[smoothPoints.length - 2], laneBottom);
      }

      const laneLabel = getAutomationShortLabel(lane.param);
      const defaultValue = getAutomationDefault(lane.param);
      const defaultLineY = laneTop + laneH * (1 - defaultValue);

      return (
        <Group key={`auto-${track.id}-${lane.id}`}>
          {/* Lane separator line */}
          <Line
            points={[0, laneTop, dimensions.width, laneTop]}
            stroke="#333"
            strokeWidth={0.5}
            listening={false}
          />
          {/* Lane background tint */}
          <Rect
            x={0}
            y={laneTop}
            width={dimensions.width}
            height={laneH}
            fill={color}
            opacity={0.04}
            listening={false}
          />
          {/* Lane label */}
          <Text
            x={4}
            y={laneTop + 3}
            text={laneLabel}
            fontSize={10}
            fill={color}
            opacity={0.6}
            listening={false}
          />
          {/* Default baseline (shown when lane is empty) */}
          {lane.points.length === 0 && (
            <Line
              points={[0, defaultLineY, dimensions.width, defaultLineY]}
              stroke={color}
              strokeWidth={1}
              dash={[4, 4]}
              opacity={0.3}
              listening={false}
            />
          )}
          {/* Filled area under curve */}
          {fillPoints.length >= 6 && (
            <Line
              points={fillPoints}
              fill={color}
              opacity={0.1}
              closed
              listening={false}
            />
          )}
          {/* Smooth curve line */}
          {smoothPoints.length >= 4 && (
            <Line
              points={smoothPoints}
              stroke={color}
              strokeWidth={1.5}
              opacity={0.85}
              listening={false}
            />
          )}
          {/* Automation points (draggable circles) */}
          {lane.points.map((point, pi) => {
            const px = point.time * pixelsPerSecond - scrollX;
            const py = laneTop + laneH * (1 - point.value);
            const isHovered = hoveredAutoPoint !== null
              && hoveredAutoPoint.laneId === lane.id
              && hoveredAutoPoint.pointIndex === pi;
            return (
              <React.Fragment key={`ap-${lane.id}-${pi}`}>
                <Circle
                  x={px}
                  y={py}
                  radius={isHovered ? 6 : 4}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={isHovered ? 2 : 1}
                  opacity={0.9}
                  draggable
                  onMouseEnter={() => {
                    setHoveredAutoPoint({
                      laneId: lane.id,
                      pointIndex: pi,
                      param: lane.param,
                      value: point.value,
                      time: point.time,
                      screenX: px,
                      screenY: py,
                    });
                  }}
                  onMouseLeave={() => setHoveredAutoPoint(null)}
                  onDragMove={(e: KonvaEvent) => {
                    const newX = e.target.x();
                    const newY = e.target.y();
                    const newTime = (newX + scrollX) / pixelsPerSecond;
                    const newValue = 1 - (newY - laneTop) / laneH;
                    useDAWStore.getState().moveAutomationPoint(
                      track.id, lane.id, pi, newTime, Math.max(0, Math.min(1, newValue)),
                    );
                    setHoveredAutoPoint(null);
                  }}
                  onDblClick={() => {
                    useDAWStore.getState().removeAutomationPoint(track.id, lane.id, pi);
                    setHoveredAutoPoint(null);
                  }}
                />
                {/* Hover tooltip */}
                {isHovered && (
                  <Group listening={false}>
                    <Rect
                      x={px - 30}
                      y={py - 28}
                      width={60}
                      height={18}
                      fill="#1a1a1a"
                      stroke={color}
                      strokeWidth={1}
                      cornerRadius={3}
                      opacity={0.95}
                    />
                    <Text
                      x={px - 30}
                      y={py - 27}
                      width={60}
                      height={18}
                      text={formatAutoValue(lane.param, point.value)}
                      fontSize={10}
                      fontFamily="monospace"
                      fill="#ffffff"
                      align="center"
                      verticalAlign="middle"
                    />
                  </Group>
                )}
              </React.Fragment>
            );
          })}
        </Group>
      );
    });
  };

  // Render master automation lanes at the bottom of all tracks
  const renderMasterAutomationLanes = () => {
    if (masterVisibleLanes.length === 0) return null;
    const masterY = contentHeight;

    return (
      <Group>
        {/* Master separator line + label */}
        <Line
          points={[0, masterY, dimensions.width, masterY]}
          stroke="#555"
          strokeWidth={1}
          listening={false}
        />
        <Rect
          x={0}
          y={masterY}
          width={dimensions.width}
          height={trackHeight}
          fill="#1a1a2a"
          opacity={0.3}
          listening={false}
        />
        <Text
          x={4}
          y={masterY + 4}
          text="Master"
          fontSize={11}
          fill="#888"
          fontStyle="bold"
          listening={false}
        />
        {masterVisibleLanes.map((lane, laneIdx) => {
          const color = getAutomationColor(lane.param);
          const laneTop = masterY + trackHeight + laneIdx * AUTOMATION_LANE_HEIGHT;
          const laneH = AUTOMATION_LANE_HEIGHT;
          const laneBottom = laneTop + laneH;

          const rawPoints: number[] = [];
          for (const point of lane.points) {
            const px = point.time * pixelsPerSecond - scrollX;
            const py = laneTop + laneH * (1 - point.value);
            rawPoints.push(px, py);
          }

          const smoothPoints = rawPoints.length >= 4
            ? interpolateAutomationCurve(rawPoints, 8)
            : rawPoints;

          const fillPoints: number[] = [];
          if (smoothPoints.length >= 4) {
            fillPoints.push(smoothPoints[0], laneBottom);
            for (let fi = 0; fi < smoothPoints.length; fi++) fillPoints.push(smoothPoints[fi]);
            fillPoints.push(smoothPoints[smoothPoints.length - 2], laneBottom);
          }

          const laneLabel = getAutomationShortLabel(lane.param);
          const defaultValue = getAutomationDefault(lane.param);
          const defaultLineY = laneTop + laneH * (1 - defaultValue);

          return (
            <Group key={`master-auto-${lane.id}`}>
              <Line points={[0, laneTop, dimensions.width, laneTop]} stroke="#333" strokeWidth={0.5} listening={false} />
              <Rect x={0} y={laneTop} width={dimensions.width} height={laneH} fill={color} opacity={0.04} listening={false} />
              <Text x={4} y={laneTop + 3} text={laneLabel} fontSize={10} fill={color} opacity={0.6} listening={false} />
              {lane.points.length === 0 && (
                <Line points={[0, defaultLineY, dimensions.width, defaultLineY]} stroke={color} strokeWidth={1} dash={[4, 4]} opacity={0.3} listening={false} />
              )}
              {fillPoints.length >= 6 && (
                <Line points={fillPoints} fill={color} opacity={0.1} closed listening={false} />
              )}
              {smoothPoints.length >= 4 && (
                <Line points={smoothPoints} stroke={color} strokeWidth={1.5} opacity={0.85} listening={false} />
              )}
              {lane.points.map((point, pi) => {
                const px = point.time * pixelsPerSecond - scrollX;
                const py = laneTop + laneH * (1 - point.value);
                const isHovered = hoveredAutoPoint !== null
                  && hoveredAutoPoint.laneId === lane.id
                  && hoveredAutoPoint.pointIndex === pi;
                return (
                  <React.Fragment key={`map-${lane.id}-${pi}`}>
                    <Circle
                      x={px}
                      y={py}
                      radius={isHovered ? 6 : 4}
                      fill={color}
                      stroke="#fff"
                      strokeWidth={isHovered ? 2 : 1}
                      opacity={0.9}
                      draggable
                      onMouseEnter={() => {
                        setHoveredAutoPoint({
                          laneId: lane.id, pointIndex: pi, param: lane.param,
                          value: point.value, time: point.time, screenX: px, screenY: py,
                        });
                      }}
                      onMouseLeave={() => setHoveredAutoPoint(null)}
                      onDragMove={(e: KonvaEvent) => {
                        const newX = e.target.x();
                        const newY = e.target.y();
                        const newTime = (newX + scrollX) / pixelsPerSecond;
                        const newValue = 1 - (newY - laneTop) / laneH;
                        useDAWStore.getState().moveMasterAutomationPoint(
                          lane.id, pi, newTime, Math.max(0, Math.min(1, newValue)),
                        );
                        setHoveredAutoPoint(null);
                      }}
                      onDblClick={() => {
                        useDAWStore.getState().removeMasterAutomationPoint(lane.id, pi);
                        setHoveredAutoPoint(null);
                      }}
                    />
                    {isHovered && (
                      <Group listening={false}>
                        <Rect x={px - 30} y={py - 28} width={60} height={18} fill="#1a1a1a" stroke={color} strokeWidth={1} cornerRadius={3} opacity={0.95} />
                        <Text x={px - 30} y={py - 27} width={60} height={18} text={formatAutoValue(lane.param, point.value)} fontSize={10} fontFamily="monospace" fill="#ffffff" align="center" verticalAlign="middle" />
                      </Group>
                    )}
                  </React.Fragment>
                );
              })}
            </Group>
          );
        })}
      </Group>
    );
  };

  // Render razor edits (per-track highlight areas)
  const renderRazorEdits = () => {
    if (razorEdits.length === 0) return null;

    return razorEdits.map((razor, i) => {
      const trackIndex = tracks.findIndex((t) => t.id === razor.trackId);
      if (trackIndex === -1) return null;

      const startX = razor.start * pixelsPerSecond - scrollX;
      const endX = razor.end * pixelsPerSecond - scrollX;
      const y = (trackYs[trackIndex] ?? 0) - scrollY;

      return (
        <Rect
          key={`razor-${i}`}
          x={startX}
          y={y}
          width={endX - startX}
          height={trackHeight}
          fill="#ef4444"
          opacity={0.2}
          stroke="#ef4444"
          strokeWidth={1}
          listening={false}
        />
      );
    });
  };

  // Render snap grid lines
  const renderSnapGridLines = () => {
    if (!snapEnabled) return null;

    const gridLines: React.ReactNode[] = [];
    const quantizePreset = getQuantizePresetById(quantizePresets, quantizePresetId);
    const visualGrid = resolveVisualGrid(tempo, timeSignature, gridSize, {
      quantizePreset,
      quantizeGridSize: quantizePreset.gridSize,
      pixelsPerSecond,
      viewportPixels: dimensions.width,
      maxVisibleLines: 180,
      minPixelsPerGrid: 18,
    });
    const startTime = scrollX / pixelsPerSecond;
    const endTime = (scrollX + dimensions.width) / pixelsPerSecond;

    const pushGridLine = (time: number, key: string) => {
      if (time < 0) return;
      const x = time * pixelsPerSecond - scrollX;

      if (x < -10 || x > dimensions.width + 10) return;

      const barPosition = time / Math.max(0.000001, visualGrid.barInterval);
      const isBar = Math.abs(barPosition - Math.round(barPosition)) < 0.0001;
      gridLines.push(
        <Line
          key={key}
          points={[x, 0, x, stageHeight]}
          stroke="#10b981"
          strokeWidth={isBar ? 0.75 : 0.5}
          opacity={isBar ? 0.12 : 0.2}
          dash={isBar ? [5, 5] : [4, 4]}
          listening={false}
        />
      );
    };

    if (visualGrid.alignedToBar) {
      const startBar = Math.floor(startTime / visualGrid.barInterval) - 1;
      const endBar = Math.ceil(endTime / visualGrid.barInterval) + 1;
      for (let bar = Math.max(0, startBar); bar <= endBar; bar += 1) {
        const barTime = bar * visualGrid.barInterval;
        for (let division = 0; division < visualGrid.divisionsPerBar; division += 1) {
          const time = barTime + division * visualGrid.visualInterval;
          pushGridLine(time, `snap-grid-bar-${bar}-${division}`);
        }
      }
    } else {
      const startIndex = Math.floor(startTime / visualGrid.visualInterval);
      const endIndex = Math.ceil(endTime / visualGrid.visualInterval);

      for (let index = startIndex; index <= endIndex; index += 1) {
        pushGridLine(index * visualGrid.visualInterval, `snap-grid-${index}`);
      }
    }

    return <Group>{gridLines}</Group>;
  };

  // Render markers (just the lines in main stage - flags are in ruler)
  const renderMarkers = () => {
    if (!markers || markers.length === 0) return null;

    return (
      <Group>
        {markers.map((marker) => {
          const x = marker.time * pixelsPerSecond - scrollX;

          // Skip if outside visible range
          if (x < -20 || x > dimensions.width + 20) return null;

          return (
            <Line
              key={marker.id}
              points={[x, 0, x, stageHeight]}
              stroke={marker.color || "#eab308"}
              strokeWidth={2}
              opacity={0.8}
              listening={false}
            />
          );
        })}
      </Group>
    );
  };

  // Render regions (shown in ruler stage, this just shows borders in main stage)
  const renderRegions = () => {
    if (!regions || regions.length === 0) return null;

    return (
      <Group>
        {regions.map((region) => {
          const startX = region.startTime * pixelsPerSecond - scrollX;
          const endX = region.endTime * pixelsPerSecond - scrollX;

          // Skip if outside visible range
          if (endX < -20 || startX > dimensions.width + 20) return null;

          return (
            <Group key={region.id}>
              {/* Region borders in main stage */}
              <Line
                points={[startX, 0, startX, stageHeight]}
                stroke={region.color || "#06b6d4"}
                strokeWidth={1}
                opacity={0.5}
                listening={false}
              />
              <Line
                points={[endX, 0, endX, stageHeight]}
                stroke={region.color || "#06b6d4"}
                strokeWidth={1}
                opacity={0.5}
                listening={false}
              />
            </Group>
          );
        })}
      </Group>
    );
  };

  // Render ghost track when dragging to empty space
  const renderGhostTrack = () => {
    if (!showGhostTrack) return null;

    const ghostY = contentHeight;

    return (
      <Group>
        <Rect
          x={0}
          y={ghostY}
          width={dimensions.width}
          height={trackHeight}
          fill="#ffffff"
          opacity={0.05}
          listening={false}
        />
        <Text
          x={10}
          y={ghostY + 10}
          text="+ Create New Track"
          fill="#ffffff"
          opacity={0.5}
          listening={false}
        />
      </Group>
    );
  };

  // Calculate total timeline width for scrollbar
  const calculateTotalWidth = useCallback(() => {
    // Find the end time of the last clip across all tracks
    let maxClipEnd = 0;

    tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        const clipEnd = clip.startTime + clip.duration;
        if (clipEnd > maxClipEnd) maxClipEnd = clipEnd;
      });
    });

    // Check recording clips - extend timeline to current recording position
    recordingClips.forEach((_rc) => {
      const recordingEnd = useDAWStore.getState().transport.currentTime;
      if (recordingEnd > maxClipEnd) maxClipEnd = recordingEnd;
    });

    // Timeline length = last clip end + 5 minutes (300 seconds)
    const extraTime = 300; // 5 minutes
    return (maxClipEnd + extraTime) * pixelsPerSecond;
  }, [tracks, recordingClips, pixelsPerSecond]);

  const totalTimelineWidth = calculateTotalWidth();
  const scrollbarOverview = useMemo(() => {
    if (!masterAutomation) return undefined;

    return buildScrollbarOverview(
      tracks,
      totalTimelineWidth / Math.max(1, pixelsPerSecond),
      waveformCache,
    );
  }, [masterAutomation, pixelsPerSecond, totalTimelineWidth, tracks, waveformCache]);

  const buildClipContextMenuItems = (menu: NonNullable<ClipContextMenuState>) => {
    const state = useDAWStore.getState();
    const track = state.tracks.find((candidate) => candidate.id === menu.trackId);
    const clip = menu.kind === "midi"
      ? track?.midiClips.find((candidate) => candidate.id === menu.clipId)
      : track?.clips.find((candidate) => candidate.id === menu.clipId);
    const isMidi = menu.kind === "midi";
    const quantizePreset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
    const gridSeconds = calculateGridInterval(
      state.transport.tempo,
      state.timeSignature,
      quantizePreset.gridSize,
      {
        quantizePreset,
        quantizeGridSize: quantizePreset.gridSize,
        pixelsPerSecond: state.pixelsPerSecond,
      },
    );

    const openAndSelectAllMidiNotes = () => {
      state.openPianoRoll(menu.trackId, menu.clipId);
      useDAWStore.getState().selectAllMIDINotes();
    };

    const exportMIDIClip = () => {
      if (!clip || !isMidi) return;
      const midiClip = clip as MIDIClip;
      void (async () => {
        const filePath = await nativeBridge.showSaveDialog(
          `${midiClip.name || "MIDI Clip"}.mid`,
          "Export MIDI Clip",
          "*.mid;*.midi",
        );
        if (!filePath) return;
        const exportClip = { ...midiClip, startTime: 0 };
        const exported = serializeMIDIClipsForBackend([exportClip], track?.midiEffects || [])[0];
        const success = await nativeBridge.exportProjectMIDI(filePath, [{
          name: track?.name || "MIDI Track",
          clips: [{
            startTime: 0,
            duration: exported?.duration ?? midiClip.duration,
            events: exported?.events ?? getVisibleMIDIEventsForClip(midiClip),
          }],
        }]);
        useDAWStore.getState().showToast(
          success ? "MIDI clip exported" : "Failed to export MIDI clip",
          success ? "success" : "error",
        );
      })();
    };
    const getMIDIContentEnd = () => {
      if (!clip || !isMidi) return 0.01;
      const midiClip = clip as MIDIClip;
      let end = 0.01;
      for (const event of midiClip.events || []) {
        if (Number.isFinite(event.timestamp)) end = Math.max(end, event.timestamp);
      }
      for (const event of midiClip.ccEvents || []) {
        if (Number.isFinite(event.time)) end = Math.max(end, event.time);
      }
      return end;
    };

    return [
      ...(isMidi
        ? [{
            label: "Open in Piano Roll",
            onClick: () => state.openPianoRoll(menu.trackId, menu.clipId),
          }, { divider: true, label: "" }]
        : []),
      {
        label: "Cut",
        shortcut: "Ctrl+X",
        onClick: () => cutClip(menu.clipId),
      },
      {
        label: "Copy",
        shortcut: "Ctrl+C",
        onClick: () => copyClip(menu.clipId),
      },
      {
        label: "Paste",
        shortcut: "Ctrl+V",
        disabled: !clipboard.clip,
        onClick: () => pasteClip(menu.trackId, useDAWStore.getState().transport.currentTime),
      },
      { divider: true, label: "" },
      {
        label: clip?.muted ? "Unmute Clip" : "Mute Clip",
        shortcut: "U",
        onClick: () => useDAWStore.getState().toggleClipMute(menu.clipId),
      },
      {
        label: "Split at Cursor",
        shortcut: "S",
        onClick: () => {
          const st = useDAWStore.getState();
          const splitTime = Number.isFinite(menu.time) ? menu.time : st.transport.currentTime;
          if (isMidi) st.splitMIDIClipAtPosition(menu.clipId, splitTime);
          else st.splitClipAtPosition(menu.clipId, splitTime);
        },
      },
      { divider: true, label: "" },
      {
        label: "Duplicate",
        shortcut: "Ctrl+D",
        onClick: () => duplicateClip(menu.clipId),
      },
      {
        label: "Repeat Clip...",
        onClick: () => {
          setRepeatClipDialog({
            clipId: menu.clipId,
            value: "3",
            error: null,
          });
        },
      },
      {
        label: "Delete",
        shortcut: "Del",
        onClick: () => deleteClip(menu.clipId),
      },
      { divider: true, label: "" },
      {
        label: clip?.locked ? "Unlock Clip" : "Lock Clip",
        onClick: () => useDAWStore.getState().toggleClipLock(menu.clipId),
      },
      {
        label: "Clip Color",
        submenu: CLIP_COLOR_OPTIONS.map(({ label, color }) => ({
          label,
          swatchColor: color,
          onClick: () => useDAWStore.getState().setClipColor(menu.clipId, color),
        })),
      },
      ...(isMidi
        ? [
            { divider: true, label: "" },
            {
              label: "Quantize Notes",
              onClick: () => {
                openAndSelectAllMidiNotes();
                useDAWStore.getState().quantizeSelectedMIDINotes(menu.trackId, menu.clipId, gridSeconds, quantizePreset.strength, {
                  presetId: quantizePreset.id,
                  gridSize: quantizePreset.gridSize,
                  mode: "start",
                  swing: quantizePreset.swing,
                  groovePreset: quantizePreset.groovePreset,
                  tupletDivisions: quantizePreset.tupletDivisions,
                  catchRangeMs: ticksToSeconds(quantizePreset.catchRangeTicks, state.transport.tempo) * 1000,
                  safeRangeMs: ticksToSeconds(quantizePreset.safeRangeTicks, state.transport.tempo) * 1000,
                  randomizeMs: ticksToSeconds(quantizePreset.roughTicks, state.transport.tempo) * 1000,
                  moveControllers: quantizePreset.moveControllers,
                });
              },
            },
            {
              label: "Transpose",
              submenu: [
                {
                  label: "Up Semitone",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().moveMIDINotes(menu.trackId, menu.clipId, useDAWStore.getState().selectedNoteIds, 0, 1);
                  },
                },
                {
                  label: "Down Semitone",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().moveMIDINotes(menu.trackId, menu.clipId, useDAWStore.getState().selectedNoteIds, 0, -1);
                  },
                },
                {
                  label: "Up Octave",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().moveMIDINotes(menu.trackId, menu.clipId, useDAWStore.getState().selectedNoteIds, 0, 12);
                  },
                },
                {
                  label: "Down Octave",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().moveMIDINotes(menu.trackId, menu.clipId, useDAWStore.getState().selectedNoteIds, 0, -12);
                  },
                },
              ],
            },
            {
              label: "Velocity",
              submenu: [
                {
                  label: "Set 80",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().setSelectedMIDINoteVelocity(menu.trackId, menu.clipId, 80);
                  },
                },
                {
                  label: "+10%",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().scaleSelectedMIDINoteVelocity(menu.trackId, menu.clipId, 1.1);
                  },
                },
                {
                  label: "-10%",
                  onClick: () => {
                    openAndSelectAllMidiNotes();
                    useDAWStore.getState().scaleSelectedMIDINoteVelocity(menu.trackId, menu.clipId, 0.9);
                  },
                },
              ],
            },
            {
              label: "Humanize",
              onClick: () => {
                openAndSelectAllMidiNotes();
                useDAWStore.getState().humanizeSelectedMIDINotes(menu.trackId, menu.clipId);
              },
            },
            {
              label: "MIDI Source",
              submenu: [
                {
                  label: "Reset Source Offset",
                  onClick: () => useDAWStore.getState().setMIDIClipSourceWindow(
                    menu.clipId,
                    { offset: 0, loopOffset: 0 },
                    "Reset MIDI source offset",
                  ),
                },
                {
                  label: "Source Length = Item",
                  onClick: () => {
                    const midiClip = clip as MIDIClip | undefined;
                    if (!midiClip) return;
                    useDAWStore.getState().setMIDIClipSourceWindow(
                      menu.clipId,
                      {
                        offset: 0,
                        sourceLength: Math.max(0.01, midiClip.duration),
                        loopLength: Math.max(0.01, midiClip.duration),
                      },
                      "Set MIDI source length to item",
                    );
                  },
                },
                {
                  label: "Source Length = Content",
                  onClick: () => {
                    const length = getMIDIContentEnd();
                    useDAWStore.getState().setMIDIClipSourceWindow(
                      menu.clipId,
                      { sourceLength: length, loopLength: length },
                      "Set MIDI source length to content",
                    );
                  },
                },
                {
                  label: "Set Source Length...",
                  onClick: () => {
                    const midiClip = clip as MIDIClip | undefined;
                    setMidiSourceLengthDialog({
                      clipId: menu.clipId,
                      value: String(midiClip?.sourceLength || midiClip?.loopLength || midiClip?.duration || 1),
                      error: null,
                    });
                  },
                },
              ],
            },
            {
              label: "Export MIDI Clip...",
              onClick: exportMIDIClip,
            },
            { divider: true, label: "" },
            {
              label: "Render in Place",
              onClick: () => { void useDAWStore.getState().renderClipInPlace(menu.clipId); },
            },
          ]
        : [
            { divider: true, label: "" },
            {
              label: (clip as AudioClip | undefined)?.reversed ? "Unreverse Clip" : "Reverse Clip",
              onClick: () => { void useDAWStore.getState().reverseClip(menu.clipId); },
            },
            {
              label: "Edit Pitch...",
              onClick: () => state.openPitchEditor(menu.trackId, menu.clipId, -1),
            },
            {
              label: "Extract MIDI from Audio...",
              onClick: () => {
                void (async () => {
                  const result = await nativeBridge.extractMidiFromAudio(menu.trackId, menu.clipId);
                  if (result && result.notes && result.notes.length > 0) {
                    const sourceTrack = state.tracks.find((t: any) => t.id === menu.trackId);
                    const sourceClip = sourceTrack?.clips.find((c: any) => c.id === menu.clipId);
                    const clipStartTime = sourceClip?.startTime || 0;
                    const trackId = crypto.randomUUID();
                    state.addTrack({
                      id: trackId,
                      name: `MIDI from ${sourceClip?.name || "Audio"}`,
                      type: "midi",
                    });
                    const maxEnd = Math.max(...result.notes.map((n: any) => n.endTime));
                    const newClipId = state.addMIDIClip(trackId, clipStartTime, maxEnd);
                    const events: any[] = [];
                    for (const n of result.notes) {
                      events.push({ timestamp: n.startTime, type: "noteOn", note: n.midiPitch, velocity: Math.round(n.velocity * 127) });
                      events.push({ timestamp: n.endTime, type: "noteOff", note: n.midiPitch, velocity: 0 });
                    }
                    events.sort((a: any, b: any) => a.timestamp - b.timestamp);
                    useDAWStore.setState((s) => ({
                      tracks: s.tracks.map((t: any) => t.id === trackId ? {
                        ...t,
                        midiClips: t.midiClips.map((c: any) => c.id === newClipId ? { ...c, events } : c),
                      } : t),
                    }));
                  } else if (result?.error) {
                    alert(result.error);
                  }
                })();
              },
            },
            {
              label: "Separate Stems...",
              onClick: () => {
                const sourceTrack = state.tracks.find((t: any) => t.id === menu.trackId);
                const sourceClip = sourceTrack?.clips.find((c: any) => c.id === menu.clipId);
                if (!sourceClip) return;
                state.openStemSeparation(menu.trackId, menu.clipId, sourceClip.name || "Audio", sourceClip.duration);
              },
            },
            {
              label: "Dynamic Split...",
              onClick: () => useDAWStore.getState().openDynamicSplit(menu.clipId),
            },
            { divider: true, label: "" },
            {
              label: "Render in Place",
              onClick: () => { void useDAWStore.getState().renderClipInPlace(menu.clipId); },
            },
          ]),
    ];
  };

  return (
    <div
      ref={containerRef}
      className="timeline-container relative flex-1 min-w-0 bg-neutral-900 flex flex-col"
    >
      {showRuler && (
        <div className="sticky top-0 z-10 bg-[#0a0a0a]">
          <Stage
            width={dimensions.width}
            height={RULER_HEIGHT}
            pixelRatio={window.devicePixelRatio || 1}
            onMouseDown={handleRulerMouseDown}
            onDblClick={handleRulerDblClick}
          >
            <Layer>
              {/* Ruler Background */}
              <Rect
                x={0}
                y={0}
                width={dimensions.width}
                height={RULER_HEIGHT}
                fill="#0a0a0a"
              />
              {/* Project Range markers (top strip of ruler) */}
              {(() => {
                const rStartX = projectRange.start * pixelsPerSecond - scrollX;
                const rEndX = projectRange.end * pixelsPerSecond - scrollX;
                const hasRange = projectRange.end > projectRange.start;
                return (
                  <>
                    {/* Highlight bar only when range is set */}
                    {hasRange && (
                      <Rect
                        x={rStartX}
                        y={0}
                        width={rEndX - rStartX}
                        height={6}
                        fill="#f59e0b"
                        opacity={0.5}
                        listening={false}
                      />
                    )}
                    {/* Start handle - triangle pointing down */}
                    <Line
                      points={[rStartX - 5, 0, rStartX + 5, 0, rStartX, 8]}
                      fill="#f59e0b"
                      closed
                      stroke="#b45309"
                      strokeWidth={0.5}
                      listening={false}
                    />
                    {/* End handle - triangle pointing down */}
                    <Line
                      points={[rEndX - 5, 0, rEndX + 5, 0, rEndX, 8]}
                      fill={hasRange ? "#f59e0b" : "#f59e0b80"}
                      closed
                      stroke="#b45309"
                      strokeWidth={0.5}
                      listening={false}
                    />
                  </>
                );
              })()}
              {/* Ruler Marks */}
              {rulerMarks}
              {/* Playhead indicator in ruler - separate component */}
              <Playhead
                type="ruler"
                pixelsPerSecond={pixelsPerSecond}
                scrollX={scrollX}
                stageHeight={0}
                viewportWidth={dimensions.width}
                rulerHeight={RULER_HEIGHT}
              />
            </Layer>
          </Stage>
        </div>
      )}

      {/* Empty State — shown when no tracks exist */}
      {tracks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-5 pointer-events-none" style={{ top: rulerOffset }}>
          <div className="text-center max-w-sm px-6 py-8">
            {/* Audio waveform icon */}
            <svg
              className="mx-auto mb-4 text-daw-text-muted opacity-30"
              width="64"
              height="64"
              viewBox="0 0 64 64"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="8" y1="20" x2="8" y2="44" />
              <line x1="14" y1="14" x2="14" y2="50" />
              <line x1="20" y1="24" x2="20" y2="40" />
              <line x1="26" y1="10" x2="26" y2="54" />
              <line x1="32" y1="18" x2="32" y2="46" />
              <line x1="38" y1="8" x2="38" y2="56" />
              <line x1="44" y1="22" x2="44" y2="42" />
              <line x1="50" y1="12" x2="50" y2="52" />
              <line x1="56" y1="26" x2="56" y2="38" />
            </svg>
            <div className="text-daw-text-muted text-base font-medium mb-2">
              Start creating
            </div>
            <div className="text-neutral-600 text-sm leading-relaxed">
              Drag audio files here or press{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-700/80 text-neutral-300 text-xs font-mono border border-daw-border">
                Ctrl+T
              </kbd>{" "}
              to add a track
            </div>
            <div className="mt-3 text-neutral-600 text-xs">
              Use{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-700/80 text-neutral-300 text-xs font-mono border border-daw-border">
                Insert
              </kbd>{" "}
              to import media or{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-700/80 text-neutral-300 text-xs font-mono border border-daw-border">
                Ctrl+O
              </kbd>{" "}
              to open a project
            </div>
          </div>
        </div>
      )}

      {/* Main Timeline Stage */}
      <Stage
        width={dimensions.width}
        height={stageHeight}
        pixelRatio={window.devicePixelRatio || 1}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        onMouseLeave={() => {
          if (showCrosshair) setCrosshairPos(null);
          finishAutomationLaneDraw();
        }}
        onMouseDown={(e: KonvaEvent) => {
          setBackgroundContextMenu(null);
          const targetName = e.target.name?.() || e.target.attrs?.name || "";
          const stage = e.target.getStage();
          const pointerPos = stage?.getPointerPosition();
          if (
            targetName === "timeline-bg"
            && pointerPos
            && (e.evt?.button ?? 0) === 0
            && !e.evt?.altKey
            && !e.evt?.ctrlKey
            && !e.evt?.metaKey
            && toolModeRef.current !== "split"
            && beginAutomationLaneDraw(pointerPos.x, pointerPos.y)
          ) {
            marqueeRef.current = null;
            setMarqueeRect(null);
            return;
          }
          // Alt+drag on background starts razor edit
          if (e.evt?.altKey) {
            if (targetName === "timeline-bg") {
              if (pointerPos) {
                const time = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
                const trackHitResult = getTrackAtY(pointerPos.y + scrollY, tracks, trackYs, trackHeight);
                const trackIndex = trackHitResult?.trackIndex ?? -1;
                if (trackIndex >= 0 && trackIndex < tracks.length) {
                  clearRazorEdits();
                  setRazorDrag({ active: true, trackId: tracks[trackIndex].id, startTime: time });
                }
              }
            }
          }
          // Marquee zoom: Ctrl+drag on background (not on a clip)
          else if (targetName === "timeline-bg" && (e.evt?.ctrlKey || e.evt?.metaKey) && toolModeRef.current !== "split") {
            if (pointerPos) {
              const time = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
              marqueeZoomRef.current = {
                startX: pointerPos.x,
                startTime: time,
                currentX: pointerPos.x,
                currentTime: time,
              };
            }
          }
          // Marquee selection: plain click+drag on background (no Alt, no Ctrl, select tool)
          else if (targetName === "timeline-bg" && toolModeRef.current !== "split") {
            if (pointerPos) {
              marqueeRef.current = {
                startX: pointerPos.x + scrollX,
                startY: pointerPos.y + scrollY,
                currentX: pointerPos.x + scrollX,
                currentY: pointerPos.y + scrollY,
                ctrlHeld: false,
              };
            }
          }
        }}
        onClick={(e: KonvaEvent) => {
          // Skip deselection if marquee just finished
          if (marqueeJustCompletedRef.current) {
            marqueeJustCompletedRef.current = false;
            return;
          }
          setBackgroundContextMenu(null);
          // Click on background only → deselect all and clear razor edits
          const targetName = e.target.name?.() || e.target.attrs?.name || "";
          if (targetName === "timeline-bg" && !e.evt?.altKey) {
            deselectAllTracks();
            selectClip(null);
            if (razorEdits.length > 0) clearRazorEdits();
          }
        }}
        onContextMenu={(e: KonvaEvent) => {
          e.evt.preventDefault();
          e.cancelBubble = true;
          if (shouldSuppressWorkspaceContextMenu(e.evt.target)) return;

          const stage = e.target.getStage();
          const pointerPos = stage.getPointerPosition();
          if (!pointerPos) return;

          const clipHit = findTimelineClipHit(
            timelineClipHitMap,
            pointerPos.x,
            pointerPos.y,
          );
          if (clipHit) {
            selectClip(clipHit.clipId);
            setBackgroundContextMenu(null);
            setClipContextMenu({
              x: e.evt.clientX,
              y: e.evt.clientY,
              clipId: clipHit.clipId,
              trackId: clipHit.trackId,
              kind: clipHit.kind,
              time: Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond),
            });
            return;
          }

          openTimelineBackgroundContextMenu(
            e.evt.clientX,
            e.evt.clientY,
            pointerPos.x,
            pointerPos.y,
          );
        }}
      >
        {/* Static Layer: grid, track backgrounds, overlays — only redraws on zoom/scroll.
            listening={false} skips Konva hit-testing for every child, reducing event overhead. */}
        <Layer listening={false}>
          {/* Background fill */}
          <Rect
            width={dimensions.width}
            height={stageHeight}
            fill="#121212"
          />

          {/* Tracks Background Alternating - rendered BEFORE grid lines so lines show on top */}
          {/* Virtualized: only render backgrounds for tracks within the vertical viewport */}
          {(() => {
            // Visible track range using prefix-sum Y positions
            let firstBg = 0;
            for (let j = 0; j < tracks.length; j++) {
              const bottom = j + 1 < tracks.length ? trackYs[j + 1] : trackYs[j] + getEffectiveTrackHeight(tracks[j], trackHeight);
              if (bottom > scrollY) { firstBg = j; break; }
            }
            firstBg = Math.max(0, firstBg - 1);
            let lastBg = tracks.length - 1;
            for (let j = firstBg; j < tracks.length; j++) {
              if (trackYs[j] > scrollY + dimensions.height) { lastBg = j; break; }
            }
            lastBg = Math.min(tracks.length - 1, lastBg + 1);

            const bgs: React.ReactNode[] = [];
            for (let i = firstBg; i <= lastBg; i++) {
              const effH = getEffectiveTrackHeight(tracks[i], trackHeight);
              bgs.push(
                <Rect
                  key={`track-bg-${i}`}
                  x={0}
                  y={trackYs[i]}
                  width={dimensions.width}
                  height={effH}
                  fill={i % 2 === 0 ? "#1a1a1a" : "#171717"}
                  opacity={1}
                />,
              );
            }
            return bgs;
          })()}

          {/* Track group tint overlays — virtualized to visible tracks only */}
          {(() => {
            let firstTint = 0;
            for (let j = 0; j < tracks.length; j++) {
              const bottom = j + 1 < tracks.length ? trackYs[j + 1] : trackYs[j] + getEffectiveTrackHeight(tracks[j], trackHeight);
              if (bottom > scrollY) { firstTint = j; break; }
            }
            firstTint = Math.max(0, firstTint - 1);
            let lastTint = tracks.length - 1;
            for (let j = firstTint; j < tracks.length; j++) {
              if (trackYs[j] > scrollY + dimensions.height) { lastTint = j; break; }
            }
            lastTint = Math.min(tracks.length - 1, lastTint + 1);
            const tints: React.ReactNode[] = [];
            for (let i = firstTint; i <= lastTint; i++) {
              const gInfo = getTrackGroupInfo(tracks[i].id, trackGroups);
              if (!gInfo) continue;
              tints.push(
                <Rect
                  key={`group-tint-${i}`}
                  x={0}
                  y={trackYs[i]}
                  width={dimensions.width}
                  height={getEffectiveTrackHeight(tracks[i], trackHeight)}
                  fill={TRACK_GROUP_COLORS[gInfo.colorIndex]}
                  opacity={0.06}
                />,
              );
            }
            return tints;
          })()}

          {/* Grid Lines - rendered after track backgrounds so they're visible on top */}
          {gridLines}

          {/* Snap Grid Lines */}
          {renderSnapGridLines()}

          {/* Loop Region */}
          {renderLoopRegion()}

          {/* Time Selection */}
          {renderTimeSelection()}

          {/* Regions (behind markers) */}
          {renderRegions()}

          {/* Markers */}
          {renderMarkers()}

        </Layer>

        {/* Dynamic Layer: clips, playhead, selection rects, automation — changes during playback/editing */}
        <Layer>
          {/* Invisible full-stage rect for click/drag event detection */}
          <Rect
            name="timeline-bg"
            width={dimensions.width}
            height={stageHeight}
            fill="transparent"
          />

          {/* Track hit areas for double-click events (automation point add, MIDI clip create) */}
          {/* Virtualized: only render hit areas for tracks within the vertical viewport */}
          {(() => {
            // Visible track range using prefix-sum Y positions
            let firstHit = 0;
            for (let j = 0; j < tracks.length; j++) {
              const bottom = j + 1 < tracks.length ? trackYs[j + 1] : trackYs[j] + getEffectiveTrackHeight(tracks[j], trackHeight);
              if (bottom > scrollY) { firstHit = j; break; }
            }
            firstHit = Math.max(0, firstHit - 1);
            let lastHit = tracks.length - 1;
            for (let j = firstHit; j < tracks.length; j++) {
              if (trackYs[j] > scrollY + dimensions.height) { lastHit = j; break; }
            }
            lastHit = Math.min(tracks.length - 1, lastHit + 1);

            const hitAreas: React.ReactNode[] = [];
            for (let i = firstHit; i <= lastHit; i++) {
              const track = tracks[i];
              const effH = getEffectiveTrackHeight(track, trackHeight);
              hitAreas.push(
                <Rect
                  name="timeline-bg"
                  key={`track-hit-${i}`}
                  x={0}
                  y={trackYs[i]}
                  width={dimensions.width}
                  height={effH}
                  fill="transparent"
                  onDblClick={(e: KonvaEvent) => {
                    const stage = e.target.getStage();
                    const pointerPos = stage.getPointerPosition();
                    const clickTime = (pointerPos.x + scrollX) / pixelsPerSecond;
                    const absoluteY = pointerPos.y + scrollY;

                    // Determine if click is in automation lane area
                    if (track.showAutomation) {
                      const hit = getTrackAtY(absoluteY, tracks, trackYs, trackHeight);
                      if (hit && !hit.isInClipArea && hit.laneIndex >= 0) {
                        const visibleLanes = track.automationLanes.filter((l) => l.visible);
                        const lane = visibleLanes[hit.laneIndex];
                        if (lane) {
                          const laneTop = trackYs[i] + trackHeight + hit.laneIndex * AUTOMATION_LANE_HEIGHT;
                          const localY = absoluteY - laneTop;
                          const value = 1 - localY / AUTOMATION_LANE_HEIGHT;
                          useDAWStore.getState().addAutomationPoint(
                            track.id, lane.id, clickTime, Math.max(0, Math.min(1, value)),
                          );
                          return;
                        }
                      }
                    }

                    if (track.type === "midi" || track.type === "instrument") {
                      handleTrackDoubleClick(track.id, track.type, clickTime);
                    }
                  }}
                  onDblTap={(e: KonvaEvent) => {
                    if (track.type === "midi" || track.type === "instrument") {
                      const stage = e.target.getStage();
                      const pointerPos = stage.getPointerPosition();
                      const clickTime = (pointerPos.x + scrollX) / pixelsPerSecond;
                      handleTrackDoubleClick(track.id, track.type, clickTime);
                    }
                  }}
                />,
              );
            }
            return hitAreas;
          })()}

          {/* Razor Edit Highlights */}
          {renderRazorEdits()}

          {/* Clips and Recording Clips — virtualized: skip off-screen tracks/clips */}
          {(() => {
            // Visible time range (horizontal virtualization)
            const visibleStartTime = scrollX / pixelsPerSecond;
            const visibleEndTime = (scrollX + dimensions.width) / pixelsPerSecond;
            // Visible track range (vertical virtualization) — prefix-sum
            let firstVisibleTrack = 0;
            for (let j = 0; j < tracks.length; j++) {
              const bottom = j + 1 < tracks.length ? trackYs[j + 1] : trackYs[j] + getEffectiveTrackHeight(tracks[j], trackHeight);
              if (bottom > scrollY) { firstVisibleTrack = j; break; }
            }
            firstVisibleTrack = Math.max(0, firstVisibleTrack - 1);
            let lastVisibleTrack = tracks.length - 1;
            for (let j = firstVisibleTrack; j < tracks.length; j++) {
              if (trackYs[j] > scrollY + dimensions.height) { lastVisibleTrack = j; break; }
            }
            lastVisibleTrack = Math.min(tracks.length - 1, lastVisibleTrack + 1);

            const isClipVisible = (clip: { startTime: number; duration: number }) =>
              clip.startTime + clip.duration >= visibleStartTime && clip.startTime <= visibleEndTime;

            return tracks.map((track, i) => {
              // Skip tracks entirely outside vertical viewport
              if (i < firstVisibleTrack || i > lastVisibleTrack) return null;

              const trackY = trackYs[i];

              // Filter clips to only those visible in the horizontal viewport
              const visibleClips = track.clips.filter(isClipVisible);
              const visibleMidiClips = track.midiClips.filter(isClipVisible);

              return (
                <Group key={track.id}>
                  {/* Existing Audio Clips — render non-selected first, selected on top
                      so that fade handles / volume line of the selected clip are always
                      clickable even when two clips overlap. */}
                  {visibleClips
                    .filter((clip) => !selectedClipIds.includes(clip.id))
                    .map((clip) =>
                      renderClip(clip, i, trackY, track.color, track.id),
                    )}
                  {visibleClips
                    .filter((clip) => selectedClipIds.includes(clip.id))
                    .map((clip) =>
                      renderClip(clip, i, trackY, track.color, track.id),
                    )}

                  {/* Existing MIDI Clips */}
                  {visibleMidiClips.map((clip) =>
                    renderMIDIClip(clip, i, trackY, track.color, track.id),
                  )}

                  {/* Recording Clip (if this track is recording) */}
                  {recordingClips.find((rc) => rc.trackId === track.id) &&
                    renderRecordingClip(
                      recordingClips.find((rc) => rc.trackId === track.id)!,
                      trackY,
                      track.color,
                    )}

                  {/* Automation Lanes */}
                  {renderAutomationLanes(track, trackY)}
                </Group>
              );
            });
          })()}

          {/* Master Automation Lanes */}
          {renderMasterAutomationLanes()}

          {/* Ghost Track */}
          {renderGhostTrack()}

          {/* Snap ghost preview — semi-transparent rect at snapped position during drag */}
          {snapGhostRender && snapGhostRender.visible && (
            <Rect
              x={snapGhostRender.x}
              y={snapGhostRender.y}
              width={snapGhostRender.width}
              height={snapGhostRender.height}
              fill={snapGhostRender.color}
              opacity={0.2}
              cornerRadius={3}
              stroke="#4cc9f0"
              strokeWidth={1}
              dash={[4, 2]}
              listening={false}
            />
          )}

          {/* Marquee zoom rectangle — Ctrl+drag on background */}
          {marqueeZoomRect && (
            <Rect
              x={marqueeZoomRect.x}
              y={0}
              width={marqueeZoomRect.width}
              height={stageHeight}
              fill="rgba(76, 201, 240, 0.08)"
              stroke="#4cc9f0"
              strokeWidth={1}
              dash={[6, 3]}
              listening={false}
            />
          )}

          {/* Marquee selection rectangle */}
          {marqueeRect && (
            <Rect
              x={marqueeRect.x - scrollX}
              y={marqueeRect.y - scrollY + rulerOffset}
              width={marqueeRect.width}
              height={marqueeRect.height}
              fill="rgba(0, 120, 212, 0.15)"
              stroke="#0078d4"
              strokeWidth={1}
              dash={[4, 2]}
              listening={false}
            />
          )}

          {/* Split tool preview line */}
          {toolMode === "split" && splitPreviewX !== null && (
            <Line
              points={[splitPreviewX, 0, splitPreviewX, stageHeight]}
              stroke="#ffffff"
              strokeWidth={1}
              opacity={0.5}
              dash={[4, 4]}
              listening={false}
            />
          )}

          {/* Crosshair cursor (vertical + horizontal lines at mouse position) */}
          {showCrosshair && crosshairPos && (
            <>
              <Line
                points={[crosshairPos.x, 0, crosshairPos.x, stageHeight]}
                stroke="#0078d4"
                strokeWidth={1}
                opacity={0.4}
                listening={false}
              />
              <Line
                points={[0, crosshairPos.y, dimensions.width, crosshairPos.y]}
                stroke="#0078d4"
                strokeWidth={1}
                opacity={0.4}
                listening={false}
              />
            </>
          )}

        </Layer>

        <Layer listening={false}>
          {externalMediaPreview && (() => {
            const target = externalMediaPreview.target;
            const targetTrack = target.kind === "existingTrack" ? tracks[target.trackIndex] : undefined;
            const rowMetrics = targetTrack
              ? getTimelineRowMetrics(targetTrack, trackHeight)
              : { clipInsetY: 6, clipHeight: Math.max(24, trackHeight - 12) };
            const targetY = target.kind === "existingTrack"
              ? (trackYs[target.trackIndex] ?? 0)
              : target.insertIndex >= tracks.length
                ? contentHeight
                : (trackYs[target.insertIndex] ?? contentHeight);
            const clipY = targetY + rowMetrics.clipInsetY;
            const clipHeight = rowMetrics.clipHeight;
            const x = externalMediaPreview.startTime * pixelsPerSecond - scrollX;
            const width = Math.max(48, externalMediaPreview.duration * pixelsPerSecond);
            if (x + width < 0 || x > dimensions.width) {
              return target.kind === "insertTrack"
                ? (
                    <Group>
                      <Line
                        points={[0, targetY, dimensions.width, targetY]}
                        stroke={externalMediaPreview.mediaKind === "midi" ? "#a78bfa" : "#67e8f9"}
                        strokeWidth={2}
                        dash={[8, 4]}
                        opacity={0.9}
                        listening={false}
                      />
                    </Group>
                  )
                : null;
            }

            const previewShapes: React.ReactNode[] = [];
            if (target.kind === "insertTrack") {
              const insertColor = externalMediaPreview.mediaKind === "midi" ? "#a78bfa" : "#67e8f9";
              previewShapes.push(
                <Rect
                  key="external-insert-lane"
                  x={0}
                  y={Math.round(targetY) + 0.5}
                  width={dimensions.width}
                  height={trackHeight}
                  fill={insertColor}
                  opacity={0.08}
                  listening={false}
                />,
                <Line
                  key="external-insert-line"
                  points={[0, Math.round(targetY) + 0.5, dimensions.width, Math.round(targetY) + 0.5]}
                  stroke={insertColor}
                  strokeWidth={2}
                  dash={[8, 4]}
                  opacity={0.95}
                  listening={false}
                />,
                <Text
                  key="external-insert-label"
                  x={10}
                  y={Math.round(targetY) + 8}
                  text={externalMediaPreview.mediaKind === "midi" ? "+ MIDI Track" : "+ Audio Track"}
                  fontSize={11}
                  fill={insertColor}
                  opacity={0.9}
                  listening={false}
                />,
              );
            }

            if (externalMediaPreview.mediaKind === "midi") {
              const midiColor = "#c4b5fd";
              const midiEvents = externalMediaPreview.midiEvents ?? [];
              const bars = sampleMIDIThumbnailBars(
                buildMIDIThumbnailBars(midiEvents, externalMediaPreview.duration),
                width,
              );
              const noteMin = bars.length > 0 ? Math.min(...bars.map((bar) => bar.note)) : 36;
              const noteMax = bars.length > 0 ? Math.max(...bars.map((bar) => bar.note)) : 84;
              const noteSpan = Math.max(1, noteMax - noteMin + 1);
              const contentTop = clipY + 18;
              const contentHeight = Math.max(8, clipHeight - 24);

              if (bars.length > 0) {
                bars.forEach((bar, index) => {
                  const barX = x + (bar.start / externalMediaPreview.duration) * width;
                  const barW = Math.max(3, ((Math.max(bar.end, bar.start + 0.06) - bar.start) / externalMediaPreview.duration) * width);
                  const normalizedNote = (bar.note - noteMin) / noteSpan;
                  const barY = contentTop + (1 - normalizedNote) * Math.max(0, contentHeight - 4);
                  previewShapes.push(
                    <Rect
                      key={`external-midi-note-${index}`}
                      x={barX}
                      y={barY}
                      width={barW}
                      height={4}
                      fill={midiColor}
                      opacity={0.68}
                      cornerRadius={1}
                      listening={false}
                    />,
                  );
                });
              } else {
                const barCount = Math.min(18, Math.max(6, Math.floor(width / 18)));
                for (let i = 0; i < barCount; i += 1) {
                  const barW = Math.max(10, width / barCount * 0.55);
                  const barX = x + i * (width / barCount) + 3;
                  const barY = contentTop + ((i * 7) % Math.max(8, contentHeight - 4));
                  previewShapes.push(
                    <Rect
                      key={`external-midi-skeleton-${i}`}
                      x={barX}
                      y={barY}
                      width={barW}
                      height={4}
                      fill={midiColor}
                      opacity={0.28}
                      cornerRadius={1}
                      listening={false}
                    />,
                  );
                }
              }
            } else {
              const peaks = externalMediaPreview.peaks;
              if (peaks && peaks.length > 0) {
              const numChannels = peaks[0]?.channels?.length || 1;
              for (let ch = 0; ch < numChannels; ch += 1) {
                const points: number[] = [];
                const channelHeight = Math.max(6, (clipHeight - 14) / numChannels);
                const channelY = clipY + 8 + ch * channelHeight;
                const centerY = channelY + channelHeight / 2;
                const halfHeight = Math.max(2, channelHeight / 2 - 1);
                const visibleStart = Math.max(0, Math.floor(-x));
                const visibleEnd = Math.min(Math.ceil(width), Math.ceil(dimensions.width - x));
                for (let px = visibleStart; px < visibleEnd; px += 1) {
                  const peakIndex = Math.min(peaks.length - 1, Math.floor((px / width) * peaks.length));
                  const channel = peaks[peakIndex]?.channels[ch];
                  if (!channel) continue;
                  points.push(x + px, centerY - Math.max(-1, Math.min(1, channel.max)) * halfHeight);
                }
                for (let px = visibleEnd - 1; px >= visibleStart; px -= 1) {
                  const peakIndex = Math.min(peaks.length - 1, Math.floor((px / width) * peaks.length));
                  const channel = peaks[peakIndex]?.channels[ch];
                  if (!channel) continue;
                  points.push(x + px, centerY - Math.max(-1, Math.min(1, channel.min)) * halfHeight);
                }
                if (points.length > 0) {
                  previewShapes.push(
                    <Line
                      key={`external-wave-${ch}`}
                      points={points}
                      fill="#67e8f9"
                      stroke="#67e8f9"
                      strokeWidth={1}
                      opacity={0.55}
                      closed
                      listening={false}
                    />,
                  );
                }
              }
            } else {
              const barCount = Math.min(40, Math.max(8, Math.floor(width / 8)));
              const barSpacing = width / barCount;
              const barWidth = Math.max(2, barSpacing * 0.42);
              const waveformTop = clipY + 22;
              const waveformHeight = Math.max(8, clipHeight - 30);
              for (let i = 0; i < barCount; i += 1) {
                const pseudo = Math.abs(Math.sin((i + 1) * 1.873 + externalMediaPreview.name.length)) * 0.7 + 0.18;
                const barHeight = waveformHeight * pseudo;
                previewShapes.push(
                  <Rect
                    key={`external-wave-skeleton-${i}`}
                    x={x + i * barSpacing + (barSpacing - barWidth) / 2}
                    y={waveformTop + (waveformHeight - barHeight) / 2}
                    width={barWidth}
                    height={barHeight}
                    fill="#67e8f9"
                    opacity={0.22}
                    cornerRadius={1}
                    listening={false}
                  />,
                );
              }
            }
            }

            return (
              <Group>
                <Rect
                  x={Math.round(x) + 0.5}
                  y={Math.round(clipY) + 0.5}
                  width={Math.round(width)}
                  height={Math.round(clipHeight)}
                  fill={externalMediaPreview.mediaKind === "midi" ? "#312e81" : "#164e63"}
                  opacity={0.42}
                  stroke={externalMediaPreview.mediaKind === "midi" ? "#c4b5fd" : "#67e8f9"}
                  strokeWidth={2}
                  dash={[6, 4]}
                  cornerRadius={3}
                  listening={false}
                />
                {previewShapes}
                <Text
                  x={Math.round(x) + 8}
                  y={Math.round(clipY) + 6}
                  text={externalMediaPreview.mediaKind === "midi" && (externalMediaPreview.midiTrackCount ?? 1) > 1
                    ? `${externalMediaPreview.name} (${externalMediaPreview.midiTrackCount} tracks)`
                    : externalMediaPreview.name}
                  fontSize={11}
                  fill={externalMediaPreview.mediaKind === "midi" ? "#ede9fe" : "#e0f2fe"}
                  width={Math.max(20, Math.round(width) - 16)}
                  height={16}
                  ellipsis
                  listening={false}
                />
              </Group>
            );
          })()}
          {(() => {
            let firstVisibleTrack = 0;
            for (let j = 0; j < tracks.length; j += 1) {
              const bottom =
                j + 1 < tracks.length
                  ? trackYs[j + 1]
                  : trackYs[j] + getEffectiveTrackHeight(tracks[j], trackHeight);
              if (bottom > scrollY) {
                firstVisibleTrack = j;
                break;
              }
            }
            firstVisibleTrack = Math.max(0, firstVisibleTrack - 1);

            let lastVisibleTrack = tracks.length - 1;
            for (let j = firstVisibleTrack; j < tracks.length; j += 1) {
              if (trackYs[j] > scrollY + dimensions.height) {
                lastVisibleTrack = j;
                break;
              }
            }
            lastVisibleTrack = Math.min(tracks.length - 1, lastVisibleTrack + 1);

            const overlays: React.ReactNode[] = [];
            for (let trackIndex = firstVisibleTrack; trackIndex <= lastVisibleTrack; trackIndex += 1) {
              const track = tracks[trackIndex];
              const rowMetrics = getTimelineRowMetrics(track, trackHeight);
              const clipY = trackYs[trackIndex] + rowMetrics.clipInsetY;
              const clipHeight = rowMetrics.clipHeight;

              for (const clip of track.clips) {
                if (!selectedClipIds.includes(clip.id)) continue;
                const x = clip.startTime * pixelsPerSecond - scrollX;
                const width = clip.duration * pixelsPerSecond;
                if (x + width < 0 || x > dimensions.width || width < 1) continue;

                overlays.push(
                  <Rect
                    key={`selected-audio-overlay-${clip.id}`}
                    x={Math.round(x) + 0.5}
                    y={Math.round(clipY) + 0.5}
                    width={Math.max(1, Math.round(width) - 1)}
                    height={Math.max(1, Math.round(clipHeight) - 1)}
                    fill="transparent"
                    stroke="#4cc9f0"
                    strokeWidth={2}
                    opacity={clip.muted || track.muted ? 0.65 : 0.95}
                    cornerRadius={3}
                    shadowColor={clip.color || track.color}
                    shadowBlur={8}
                    shadowOpacity={clip.muted || track.muted ? 0.12 : 0.28}
                    perfectDrawEnabled={false}
                  />,
                );
              }

              for (const clip of track.midiClips) {
                if (!selectedClipIds.includes(clip.id)) continue;
                const x = clip.startTime * pixelsPerSecond - scrollX;
                const width = clip.duration * pixelsPerSecond;
                if (x + width < 0 || x > dimensions.width || width < 1) continue;

                overlays.push(
                  <Rect
                    key={`selected-midi-overlay-${clip.id}`}
                    x={Math.round(x) + 0.5}
                    y={Math.round(clipY) + 0.5}
                    width={Math.max(1, Math.round(width) - 1)}
                    height={Math.max(1, Math.round(clipHeight) - 1)}
                    fill="transparent"
                    stroke="#4cc9f0"
                    strokeWidth={2}
                    opacity={track.muted ? 0.65 : 0.95}
                    cornerRadius={3}
                    shadowColor={clip.color || track.color}
                    shadowBlur={8}
                    shadowOpacity={track.muted ? 0.12 : 0.24}
                    perfectDrawEnabled={false}
                  />,
                );
              }
            }

            return overlays;
          })()}
        </Layer>
        {/* Playhead in its own Layer so it always renders on top, even if other layers error */}
        <Layer listening={false}>
          <Playhead
            type="main"
            pixelsPerSecond={pixelsPerSecond}
            scrollX={scrollX}
            stageHeight={stageHeight}
            viewportWidth={dimensions.width}
          />
        </Layer>
      </Stage>

      {/* Custom Horizontal Scrollbar */}
      <HorizontalScrollbar
        viewportWidth={dimensions.width}
        totalWidth={totalTimelineWidth}
        scrollX={scrollX}
        scrollY={scrollY}
        height={footerHeight}
        overview={scrollbarOverview}
        onScroll={scheduleScroll}
      />

      {/* Timeline Background Context Menu */}
      {backgroundContextMenu && (
        <ContextMenu
          x={backgroundContextMenu.x}
          y={backgroundContextMenu.y}
          items={[
            ...(clipboard.clips.length > 0
              ? [{
                  label: "Paste at Cursor",
                  shortcut: "Ctrl+V",
                  onClick: () => {
                    const state = useDAWStore.getState();
                    if (backgroundContextMenu.trackId && state.clipboard.clip) {
                      state.pasteClip(
                        backgroundContextMenu.trackId,
                        backgroundContextMenu.time,
                      );
                      return;
                    }
                    void (async () => {
                      await state.seekTo(backgroundContextMenu.time);
                      state.pasteClips();
                    })();
                  },
                }]
              : []),
            {
              label: "Add Marker",
              onClick: () =>
                useDAWStore.getState().addMarker(backgroundContextMenu.time),
            },
            ...(timeSelection && timeSelection.end > timeSelection.start
              ? [{
                  label: "Create Region from Selection",
                  onClick: () =>
                    useDAWStore
                      .getState()
                      .addRegion(timeSelection.start, timeSelection.end),
                }]
              : []),
            ...(backgroundContextMenu.trackId === null
              ? [
                  { divider: true, label: "" },
                  {
                    label: "Add Track",
                    onClick: () => {
                      void createTrackOfType("audio");
                    },
                  },
                  {
                    label: "Add Multiple Tracks",
                    onClick: () => onOpenAddMultipleTracksModal?.("audio"),
                  },
                  {
                    label: "Add Instrument Track",
                    onClick: () => {
                      void createTrackOfType("instrument");
                    },
                  },
                  {
                    label: "Add MIDI Track",
                    onClick: () => {
                      void createTrackOfType("midi");
                    },
                  },
                  {
                    label: "Add AI Track",
                    onClick: () => {
                      void createTrackOfType("ai");
                    },
                  },
                ]
              : []),
            ...((backgroundContextMenu.trackType === "midi" ||
              backgroundContextMenu.trackType === "instrument") &&
            backgroundContextMenu.trackId
              ? [
                  { divider: true, label: "" },
                  {
                    label: "Insert Empty MIDI Item",
                    onClick: () =>
                      addMIDIClip(
                        backgroundContextMenu.trackId!,
                        backgroundContextMenu.time,
                        4,
                      ),
                  },
                ]
              : []),
            ...(backgroundContextMenu.trackType === "audio" &&
            backgroundContextMenu.trackId
              ? [
                  { divider: true, label: "" },
                  {
                    label: "Insert Empty Audio Item",
                    onClick: () =>
                      addEmptyClip(
                        backgroundContextMenu.trackId!,
                        backgroundContextMenu.time,
                        4,
                      ),
                  },
                ]
              : []),
          ]}
          onClose={() => setBackgroundContextMenu(null)}
        />
      )}

      {/* Clip Context Menu */}
      {clipContextMenu && (
        <ContextMenu
          x={clipContextMenu.x}
          y={clipContextMenu.y}
          items={buildClipContextMenuItems(clipContextMenu)}
          onClose={() => setClipContextMenu(null)}
        />
      )}

      {repeatClipDialog && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45"
          data-modal-root="true"
          role="dialog"
          aria-modal="true"
          aria-labelledby="timeline-repeat-clip-title"
          onContextMenu={guardModalContextMenu}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRepeatClipDialog(null);
          }}
        >
          <form
            className="w-[300px] rounded-md border border-white/15 bg-[#191d25] p-4 shadow-2xl"
            onContextMenu={guardModalContextMenu}
            onSubmit={(event) => {
              event.preventDefault();
              const count = Math.floor(Number(repeatClipDialog.value));
              if (!Number.isFinite(count) || count < 1) {
                setRepeatClipDialog((dialog) => dialog ? { ...dialog, error: "Enter at least 1 repeat." } : dialog);
                return;
              }
              repeatClip(repeatClipDialog.clipId, Math.min(128, count));
              setRepeatClipDialog(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setRepeatClipDialog(null);
              }
            }}
          >
            <div id="timeline-repeat-clip-title" className="mb-3 text-sm font-semibold text-white">
              Repeat Clip
            </div>
            <label htmlFor="timeline-repeat-clip-count-input" className="mb-1 block text-xs font-medium uppercase tracking-wide text-white/60">
              Additional Repeats
            </label>
            <input
              id="timeline-repeat-clip-count-input"
              type="number"
              min={1}
              max={128}
              step={1}
              autoFocus
              className="h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm text-white outline-none focus:border-[#4cc9f0]"
              value={repeatClipDialog.value}
              onChange={(event) => setRepeatClipDialog({
                ...repeatClipDialog,
                value: event.target.value,
                error: null,
              })}
            />
            {repeatClipDialog.error && (
              <div className="mt-2 text-xs text-red-300">{repeatClipDialog.error}</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded border border-white/10 px-3 text-xs text-white/75 hover:bg-white/10"
                onClick={() => setRepeatClipDialog(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-8 rounded bg-[#2677ff] px-3 text-xs font-semibold text-white hover:bg-[#3b86ff]"
              >
                Apply
              </button>
            </div>
          </form>
        </div>
      )}

      {midiSourceLengthDialog && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45"
          data-modal-root="true"
          role="dialog"
          aria-modal="true"
          aria-labelledby="timeline-midi-source-length-title"
          onContextMenu={guardModalContextMenu}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMidiSourceLengthDialog(null);
          }}
        >
          <form
            className="w-[300px] rounded-md border border-white/15 bg-[#191d25] p-4 shadow-2xl"
            onContextMenu={guardModalContextMenu}
            onSubmit={(event) => {
              event.preventDefault();
              const length = Number(midiSourceLengthDialog.value);
              if (!Number.isFinite(length) || length <= 0) {
                setMidiSourceLengthDialog((dialog) => dialog ? { ...dialog, error: "Enter a length greater than 0." } : dialog);
                return;
              }
              const clampedLength = Math.max(0.01, length);
              useDAWStore.getState().setMIDIClipSourceWindow(
                midiSourceLengthDialog.clipId,
                { sourceLength: clampedLength, loopLength: clampedLength },
                "Set MIDI source length",
              );
              setMidiSourceLengthDialog(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setMidiSourceLengthDialog(null);
              }
            }}
          >
            <div id="timeline-midi-source-length-title" className="mb-3 text-sm font-semibold text-white">
              Set MIDI Source Length
            </div>
            <label htmlFor="timeline-midi-source-length-input" className="mb-1 block text-xs font-medium uppercase tracking-wide text-white/60">
              Length Seconds
            </label>
            <input
              id="timeline-midi-source-length-input"
              type="number"
              min={0.01}
              step={0.01}
              autoFocus
              className="h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm text-white outline-none focus:border-[#4cc9f0]"
              value={midiSourceLengthDialog.value}
              onChange={(event) => setMidiSourceLengthDialog({
                ...midiSourceLengthDialog,
                value: event.target.value,
                error: null,
              })}
            />
            {midiSourceLengthDialog.error && (
              <div className="mt-2 text-xs text-red-300">{midiSourceLengthDialog.error}</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded border border-white/10 px-3 text-xs text-white/75 hover:bg-white/10"
                onClick={() => setMidiSourceLengthDialog(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-8 rounded bg-[#2677ff] px-3 text-xs font-semibold text-white hover:bg-[#3b86ff]"
              >
                Apply
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
