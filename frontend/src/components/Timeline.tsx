import React, { useRef, useEffect, useState, useCallback, useMemo, useTransition } from "react";
import { Stage, Layer, Rect, Line, Text, Group, Circle } from "react-konva";
import { useShallow } from "zustand/shallow";
import {
  useDAWStore,
  Track,
  AudioClip,
  MIDIClip,
  RecordingClip,
  getTrackGroupInfo,
  TRACK_GROUP_COLORS,
  getEffectiveTrackHeight,
  getTrackYPositions,
  getTrackAtY,
  AUTOMATION_LANE_HEIGHT,
} from "../store/useDAWStore";
import { nativeBridge, WaveformPeak } from "../services/NativeBridge";
import { ContextMenu } from "./ContextMenu";
import { HorizontalScrollbar } from "./HorizontalScrollbar";
import { MemoizedPlayhead as Playhead } from "./Playhead";
import {
  snapToGrid,
  calculateGridInterval,
} from "../utils/snapToGrid";
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

// Constants
const RULER_HEIGHT = 30;
const MIN_PIXELS_PER_SECOND = 1;
const MAX_PIXELS_PER_SECOND = 1000;

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
}

// Cache for waveform data to avoid re-fetching
type WaveformCache = Map<string, WaveformPeak[]>;

// Recording waveform cache (trackId -> peaks + width at fetch time)
type RecordingWaveformData = { peaks: WaveformPeak[]; widthPixels: number };
type RecordingWaveformCache = Map<string, RecordingWaveformData>;

// Clip context menu state type
type ClipContextMenuState = {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
} | null;

export function Timeline({ tracks, masterAutomation }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 400 });
  const [waveformCache, setWaveformCache] = useState<WaveformCache>(new Map());
  const [recordingWaveformCache, setRecordingWaveformCache] = useState<RecordingWaveformCache>(new Map());
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

  // Clip context menu state
  const [clipContextMenu, setClipContextMenu] =
    useState<ClipContextMenuState>(null);

  // Drag state for clip movement and resizing
  const [dragState, setDragState] = useState<{
    type: "move" | "resize-left" | "resize-right" | null;
    clipId: string | null;
    trackIndex: number | null;
    targetTrackIndex: number | null; // Visual target track during cross-track drag
    startX: number;
    startTime: number;
    originalStartTime: number;
    originalDuration: number;
    originalOffset: number;
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
  });

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
    setDragState({
      type: null,
      clipId: null,
      trackIndex: null,
      targetTrackIndex: null,
      startX: 0,
      startTime: 0,
      originalStartTime: 0,
      originalDuration: 0,
      originalOffset: 0,
    });
    setShowGhostTrack(false);
    // Clear snap ghost preview
    snapGhostRef.current = null;
    setSnapGhostRender(null);
  }, []);

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
      if (dragState.type !== null) {
        console.log("[Timeline] Global mouseup - resetting drag state");
        resetDragState();
      }
      if (marqueeRef.current) {
        resetMarquee();
      }
      if (marqueeZoomRef.current) {
        resetMarqueeZoom();
      }
      // Reset slip edit state on global mouseup (safety net)
      if (slipEditRef.current) {
        slipEditRef.current = null;
      }
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
    startX: number;
    originalOffset: number;
    sourceLength: number;
    clipDuration: number;
  } | null>(null);

  // Split tool preview line
  const [splitPreviewX, setSplitPreviewX] = useState<number | null>(null);

  // Ruler interaction state (ref-based to avoid stale closures in global listeners)
  const rulerDragRef = useRef<{
    type: "handle" | "range-create" | "pending"; // pending = mousedown, not yet determined
    handle?: "start" | "end";
    startX: number; // pixel X at mousedown (relative to ruler canvas)
    startTime: number; // time at mousedown
  } | null>(null);
  // Reactive state just to trigger re-renders when range changes during drag
  const [_rulerDragging, setRulerDragging] = useState(false);

  // Use useShallow to prevent re-renders when unrelated state changes (like currentTime)
  const {
    recordingClips,
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
    resizeClip,
    setClipVolume,
    beginClipVolumeEdit,
    commitClipVolumeEdit,
    setClipFades,
    copyClip,
    cutClip,
    pasteClip,
    deleteClip,
    duplicateClip,
    clipboard,
    addTrack,
    timeSignature,
    markers,
    regions,
    snapEnabled,
    gridSize,
    timeSelection,
    setTimeSelection,
    openPianoRoll,
    addMIDIClip,
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
      resizeClip: state.resizeClip,
      setClipVolume: state.setClipVolume,
      beginClipVolumeEdit: state.beginClipVolumeEdit,
      commitClipVolumeEdit: state.commitClipVolumeEdit,
      setClipFades: state.setClipFades,
      copyClip: state.copyClip,
      cutClip: state.cutClip,
      pasteClip: state.pasteClip,
      deleteClip: state.deleteClip,
      duplicateClip: state.duplicateClip,
      clipboard: state.clipboard,
      addTrack: state.addTrack,
      timeSignature: state.timeSignature,
      markers: state.markers,
      regions: state.regions,
      snapEnabled: state.snapEnabled,
      gridSize: state.gridSize,
      timeSelection: state.timeSelection,
      setTimeSelection: state.setTimeSelection,
      openPianoRoll: state.openPianoRoll,
      addMIDIClip: state.addMIDIClip,
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

  // Calculate stage height: fill available viewport space, or grow for content
  const SCROLLBAR_HEIGHT = 16; // h-4 from HorizontalScrollbar
  const availableHeight = dimensions.height - RULER_HEIGHT - SCROLLBAR_HEIGHT;
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
  const stageHeight = Math.max(contentHeight + masterAutoHeight, availableHeight, 200);

  // Refs for ruler drag to avoid stale closures in global listeners
  const projectRangeRef = useRef(projectRange);
  projectRangeRef.current = projectRange;
  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;
  const tempoRef = useRef(tempo);
  tempoRef.current = tempo;
  const timeSignatureRef = useRef(timeSignature);
  timeSignatureRef.current = timeSignature;
  const toolModeRef = useRef(toolMode);
  toolModeRef.current = toolMode;

  // Handle container resize using ResizeObserver for accurate detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    // Calculate available width from parent workspace minus track control panel
    // This is the single source of truth for available width
    const getAvailableWidth = () => {
      const parent = container.parentElement;
      if (!parent) return 800; // Fallback

      // Calculate directly from parent - don't rely on container.clientWidth
      // which may not have shrunk yet due to CSS layout timing
      const workspaceWidth = parent.clientWidth;
      const tcpWidth = useDAWStore.getState().tcpWidth + 4; // +4 for resize handle
      return Math.max(100, workspaceWidth - tcpWidth);
    };

    const updateDimensions = () => {
      const newWidth = getAvailableWidth();
      // Use parent height since container might not have resized yet
      const parent = container.parentElement;
      const newHeight = parent ? parent.clientHeight : container.clientHeight;

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
    if (container.parentElement) {
      resizeObserver.observe(container.parentElement);
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
      const parent = container.parentElement;
      if (!parent) return;
      const workspaceWidth = parent.clientWidth;
      const newWidth = Math.max(100, workspaceWidth - state.tcpWidth - 4);
      const newHeight = parent.clientHeight;
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
    const workspace = containerRef.current?.parentElement;
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

  const scheduleScroll = useCallback(
    (newScrollX: number, newScrollY: number) => {
      pendingScrollRef.current = { x: newScrollX, y: newScrollY };
      scheduleRAF();

      // Suppress waveform fetches during active scrolling (same pattern as zoom debounce)
      isScrollingRef.current = true;
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      scrollDebounceRef.current = setTimeout(() => {
        isScrollingRef.current = false;
        forceRender((n) => n + 1); // trigger re-render to fetch waveforms at new scroll position
      }, 200);
    },
    [scheduleRAF],
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
  const dimensionsWidthRef = useRef(dimensions.width);
  dimensionsWidthRef.current = dimensions.width;
  const setTrackWaveformZoomRef = useRef(setTrackWaveformZoom);
  setTrackWaveformZoomRef.current = setTrackWaveformZoom;

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
  const DRAG_THRESHOLD_PX = 4; // Movement needed to distinguish drag from click

  const handleRulerMouseDown = (e: any) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
    if (!pointerPos) return;

    const clickedTime = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);

    // Check if clicking near a range handle (anywhere in ruler height)
    const startX = projectRange.start * pixelsPerSecond - scrollX;
    const endX = projectRange.end * pixelsPerSecond - scrollX;

    // Prefer end handle when both overlap (both at 0)
    if (Math.abs(pointerPos.x - endX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = { type: "handle", handle: "end", startX: pointerPos.x, startTime: clickedTime };
      setRulerDragging(true);
      return;
    }
    if (Math.abs(pointerPos.x - startX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = { type: "handle", handle: "start", startX: pointerPos.x, startTime: clickedTime };
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

    // Not on a handle — record as pending (will become seek or range-create on mouseup/move)
    rulerDragRef.current = { type: "pending", startX: pointerPos.x, startTime: clickedTime };
  };

  // Double-click on ruler: select region between nearest markers on either side
  const handleRulerDblClick = (e: any) => {
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
      if (snapEnabledRef.current) {
        time = snapToGrid(time, tempoRef.current, timeSignatureRef.current, gridSizeRef.current);
      }

      if (drag.type === "handle") {
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
          if (snapEnabledRef.current) {
            startTime = snapToGrid(startTime, tempoRef.current, timeSignatureRef.current, gridSizeRef.current);
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
  }, [seekTo, setProjectRange]);

  // Handle mouse move for time selection / razor edit dragging (on main stage)
  const handleStageMouseMove = (e: any) => {
    // Track crosshair cursor position
    if (showCrosshair) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) {
        setCrosshairPos({ x: pointerPos.x, y: pointerPos.y });
      }
    }

    // Slip editing: Alt+drag adjusts clip offset in real-time
    if (slipEditRef.current) {
      const stage = e.target.getStage();
      const pointerPos = stage?.getPointerPosition();
      if (pointerPos) {
        const deltaX = pointerPos.x - slipEditRef.current.startX;
        const deltaTime = deltaX / pixelsPerSecond;
        // Moving mouse right shifts content left (increases offset), moving left shifts content right (decreases offset)
        const newOffset = Math.max(
          0,
          Math.min(
            slipEditRef.current.sourceLength - slipEditRef.current.clipDuration,
            slipEditRef.current.originalOffset - deltaTime,
          ),
        );
        // Apply offset change live (without undo tracking — undo happens on mouseup)
        useDAWStore.setState((s) => ({
          tracks: s.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === slipEditRef.current!.clipId
                ? { ...clip, offset: newOffset }
                : clip,
            ),
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
    // Finalize slip edit with undo support
    if (slipEditRef.current) {
      const { clipId, originalOffset } = slipEditRef.current;
      // Read the current offset from store
      const currentClip = useDAWStore.getState().tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === clipId);
      const finalOffset = currentClip?.offset ?? originalOffset;
      // Revert to original offset first, then use slipEditClip to push undo command
      if (finalOffset !== originalOffset) {
        useDAWStore.setState((s) => ({
          tracks: s.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === clipId
                ? { ...clip, offset: originalOffset }
                : clip,
            ),
          })),
        }));
        slipEditClip(clipId, finalOffset);
      }
      slipEditRef.current = null;
    }

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
        const clipTop = trackYsRef.current[trackIndex] + 5;
        const clipBottom = clipTop + trackHeight - 10;
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
        if (e.key === "Escape") {
          state.setToolMode("select");
          // Don't return — let Escape also deselect via action registry
        }
      }

      // Copy: Ctrl+C
      if (e.ctrlKey && e.key === "c" && hasClips) {
        e.preventDefault();
        state.copySelectedClips();
      }
      // Cut: Ctrl+X
      else if (e.ctrlKey && e.key === "x" && hasClips) {
        e.preventDefault();
        state.cutSelectedClips();
      }
      // Paste: Ctrl+V (works even without clips selected — uses clipboard)
      else if (e.ctrlKey && e.key === "v") {
        const { clipboard } = state;
        if (clipboard.clips.length > 0 || clipboard.clip) {
          e.preventDefault();
          state.pasteClips();
        }
      }
      // Duplicate: Ctrl+D
      else if (e.ctrlKey && e.key === "d" && hasClips) {
        e.preventDefault();
        state.selectedClipIds.forEach((id) => state.duplicateClip(id));
      }
      // Group: Ctrl+G
      else if (e.ctrlKey && !e.shiftKey && e.key === "g" && hasClips) {
        e.preventDefault();
        state.groupSelectedClips();
      }
      // Ungroup: Ctrl+Shift+G
      else if (e.ctrlKey && e.shiftKey && e.key === "G" && hasClips) {
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

    const unsubscribe = useDAWStore.subscribe((state) => {
      if (!state.transport.isPlaying) return;

      const currentTime = state.transport.currentTime;
      const pps = pixelsPerSecondRef.current;
      const playheadX = currentTime * pps;
      const viewWidth = dimensions.width;

      // If playhead jumped behind viewport (e.g. loop wrap), scroll back to show it
      if (playheadX < lastAutoScrollX) {
        const targetScrollX = Math.max(0, playheadX - 100);
        lastAutoScrollX = targetScrollX;
        scheduleScroll(targetScrollX, scrollYRef.current);
        return;
      }

      const triggerPoint = lastAutoScrollX + viewWidth * 0.75;

      // If playhead goes past 75% of viewport, scroll to keep it there
      if (playheadX > triggerPoint) {
        const targetScrollX = playheadX - viewWidth * 0.75;
        lastAutoScrollX = targetScrollX;
        // Use scheduleScroll to batch via RAF and suppress waveform refetches
        scheduleScroll(targetScrollX, scrollYRef.current);
      }
    });

    return () => unsubscribe();
  }, [isPlaying, dimensions.width, scheduleScroll]);

  // Note: Removed auto-scroll when stopped - users should be able to freely scroll
  // the timeline when not playing. Auto-scroll only happens during playback.


  // Track the last bar we fetched recording peaks for
  const lastFetchedBarRef = useRef<number>(-1);

  // Fetch recording waveforms only when a bar boundary is crossed
  // Uses Zustand subscribe to avoid Timeline re-renders on every currentTime change
  useEffect(() => {
    if (!isRecording || recordingClips.length === 0) {
      // Clear recording waveform cache and reset bar tracking when not recording
      if (recordingWaveformCache.size > 0) {
        setRecordingWaveformCache(new Map());
      }
      lastFetchedBarRef.current = -1;
      return;
    }

    // Calculate bar duration for this effect
    const secondsPerBeat = 60 / tempo;
    const beatsPerBar = timeSignature.numerator;
    const barDuration = secondsPerBeat * beatsPerBar;

    // Subscribe to currentTime changes
    const unsubscribe = useDAWStore.subscribe((state) => {
      const currentTime = state.transport.currentTime;
      const currentBar = Math.floor(currentTime / barDuration);

      // Only fetch if we've crossed into a new bar
      if (currentBar <= lastFetchedBarRef.current) {
        return;
      }

      lastFetchedBarRef.current = currentBar;

      const fetchRecordingPeaks = async () => {
        const newCache = new Map(recordingWaveformCacheRef.current);

        for (const rc of recordingClips) {
          // Calculate the recording width in pixels
          const recordingDuration = currentTime - rc.startTime;
          if (recordingDuration <= 0) continue;

          const widthPixels = Math.ceil(recordingDuration * pixelsPerSecond);
          if (widthPixels < 10) continue; // Don't fetch for tiny clips

          try {
            // Request peaks at reasonable resolution (use device sample rate for recordings)
            const deviceSR = useDAWStore.getState().audioDeviceSetup?.sampleRate || 44100;
            const samplesPerPixel = Math.floor((recordingDuration * deviceSR) / widthPixels);
            const peaks = await nativeBridge.getRecordingPeaks(
              rc.trackId,
              samplesPerPixel,
              widthPixels,
            );

            if (peaks && peaks.length > 0) {
              newCache.set(rc.trackId, { peaks, widthPixels });
            }
          } catch (e) {
            console.error("Failed to fetch recording peaks:", e);
          }
        }

        startRecordingWaveformTransition(() => setRecordingWaveformCache(newCache));
      };

      fetchRecordingPeaks();
    });

    return () => unsubscribe();
  }, [isRecording, recordingClips, tempo, timeSignature.numerator, pixelsPerSecond]);

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

  // Render Grid Lines (Bars and Beats)
  // Memoized grid rendering - only recalculates when dependencies change, not on every currentTime update
  const gridLines = useMemo(() => {
    const lines = [];
    const secondsPerBeat = 60 / tempo;
    const beatsPerBar = timeSignature.numerator;
    const secondsPerBar = secondsPerBeat * beatsPerBar;

    // Calculate visible time range
    const startVisibleTime = scrollX / pixelsPerSecond;
    const endVisibleTime = (scrollX + dimensions.width) / pixelsPerSecond;

    // Round start/end to nearest bar/beat
    const startBar = Math.floor(startVisibleTime / secondsPerBar);
    const endBar = Math.ceil(endVisibleTime / secondsPerBar);

    for (let bar = startBar; bar <= endBar; bar++) {
      const barTime = bar * secondsPerBar;
      const barX = barTime * pixelsPerSecond - scrollX;

      // Draw Bar Line (Stronger)
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

      // Draw Beat Lines (Weaker)
      for (let beat = 1; beat < beatsPerBar; beat++) {
        const beatTime = barTime + beat * secondsPerBeat;
        if (beatTime > endVisibleTime) break;

        const beatX = beatTime * pixelsPerSecond - scrollX;
        lines.push(
          <Line
            key={`beat-${bar}-${beat}`}
            points={[beatX, 0, beatX, stageHeight]}
            stroke="#ffffff"
            strokeWidth={0.5}
            opacity={0.05}
            listening={false}
          />,
        );
      }
    }
    return lines;
  }, [tempo, timeSignature.numerator, scrollX, pixelsPerSecond, dimensions.width, stageHeight]);

  // Memoized ruler marks - only recalculates when dependencies change
  const rulerMarks = useMemo(() => {
    const marks: React.ReactNode[] = [];
    const beatsPerBar = timeSignature.numerator;
    const secondsPerBeat = 60 / tempo;
    const secondsPerBar = secondsPerBeat * beatsPerBar;

    // Calculate visible time range
    const startTime = scrollX / pixelsPerSecond;
    const endTime = (scrollX + dimensions.width) / pixelsPerSecond;

    // Find the first bar that's visible
    const startBar = Math.floor(startTime / secondsPerBar);
    const endBar = Math.ceil(endTime / secondsPerBar) + 1;

    // Determine how often to show bar numbers based on zoom level
    // At low zoom, skip some bars to avoid overlap
    const pixelsPerBar = secondsPerBar * pixelsPerSecond;
    let barSkip = 1;
    if (pixelsPerBar < 30) barSkip = 10;
    else if (pixelsPerBar < 50) barSkip = 5;
    else if (pixelsPerBar < 80) barSkip = 2;

    for (let bar = startBar; bar <= endBar; bar++) {
      const barTime = bar * secondsPerBar;
      const barX = barTime * pixelsPerSecond - scrollX;

      // Skip if outside visible area
      if (barX < -50 || barX > dimensions.width + 50) continue;

      // Major bar line
      const isMajor = bar % barSkip === 0;

      marks.push(
        <Line
          key={`bar-line-${bar}`}
          points={[barX, isMajor ? 0 : 15, barX, RULER_HEIGHT]}
          stroke="#555"
          strokeWidth={isMajor ? 1 : 0.5}
        />,
      );

      // Bar number (only show on major marks to avoid clutter)
      if (isMajor && bar >= 0) {
        marks.push(
          <Text
            key={`bar-label-${bar}`}
            x={barX + 3}
            y={2}
            text={`${bar + 1}`}
            fontSize={10}
            fill="#888"
          />,
        );
      }

      // Beat subdivisions (only show if zoom is high enough)
      if (pixelsPerBar > 60) {
        for (let beat = 1; beat < beatsPerBar; beat++) {
          const beatTime = barTime + beat * secondsPerBeat;
          const beatX = beatTime * pixelsPerSecond - scrollX;
          if (beatX > 0 && beatX < dimensions.width) {
            marks.push(
              <Line
                key={`beat-line-${bar}-${beat}`}
                points={[beatX, 20, beatX, RULER_HEIGHT]}
                stroke="#444"
                strokeWidth={0.5}
              />,
            );
          }
        }
      }
    }

    return marks;
  }, [tempo, timeSignature.numerator, scrollX, pixelsPerSecond, dimensions.width]);

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

  // Render individual clip with waveform
  const renderClip = (
    clip: AudioClip,
    trackIndex: number,
    trackY: number,
    trackColor: string,
    trackId: string,
  ) => {
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
          trackY = trackYs[dragState.targetTrackIndex] ?? trackY;
        }
      } else if (dragState.multiClipInfo && dragState.multiClipInfo.length > 1) {
        // Other clips in multi-selection — offset by same track delta
        const info = dragState.multiClipInfo.find(m => m.clipId === clip.id);
        if (info) {
          const trackDelta = dragState.targetTrackIndex - (dragState.trackIndex ?? 0);
          const visualTrackIdx = info.trackIndex + trackDelta;
          if (visualTrackIdx !== trackIndex) {
            trackY = trackYs[visualTrackIdx] ?? trackY;
          }
        }
      }
    }

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

      // Calculate dynamic waveform height based on current trackHeight
      const waveformHeight = trackHeight - 20;

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
        const channelY = trackY + 10 + ch * channelHeight;
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
      const wfHeight = trackHeight - 20;
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
              y={trackY + 10 + (BAND_COUNT - 1 - b) * bandH}
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

    const isSpectral = tracks.find((t) => t.id === trackId)?.spectralView;
    // Skip expensive waveform generation during active zoom or for narrow clips — just show clip rect
    const waveformShapes = (isZoomingRef.current || isNarrowClip) ? [] : (isSpectral ? generateSpectralView() : generateWaveformPoints());

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
    const handleDragMove = (e: any) => {
      if (dragState.type !== "move" || dragState.clipId !== clip.id) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();

      // Calculate new time position for anchor clip
      const deltaX = pointerPos.x - dragState.startX;
      const deltaTime = deltaX / pixelsPerSecond;
      const rawStartTime = Math.max(0, dragState.originalStartTime + deltaTime);
      let newStartTime = rawStartTime;

      // Apply snap-to-grid if enabled
      if (snapEnabled) {
        newStartTime = snapToGrid(newStartTime, tempo, timeSignature, gridSize);
      }

      // Calculate target track based on Y position
      const targetHit = getTrackAtY(pointerPos.y + scrollY, tracks, trackYs, trackHeight);
      const targetTrackIdx = targetHit?.trackIndex ?? Math.max(0, tracks.length - 1);
      const targetTY = trackYs[Math.max(0, targetTrackIdx)] ?? 0;

      // Update snap ghost preview: show semi-transparent rect at snapped position
      if (snapEnabled && Math.abs(newStartTime - rawStartTime) > 0.001) {
        const ghostScreenX = newStartTime * pixelsPerSecond - scrollX;
        snapGhostRef.current = {
          x: ghostScreenX,
          y: targetTY + 5,
          width: clip.duration * pixelsPerSecond,
          height: trackHeight - 10,
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
      const timeDelta = newStartTime - dragState.originalStartTime;

      // Determine if multi-clip drag
      const multi = dragState.multiClipInfo && dragState.multiClipInfo.length > 1;

      // Check if any clip in selection would go past last track (ghost track needed)
      const trackDelta = targetTrackIdx - (dragState.trackIndex ?? 0);
      let needsGhost = false;
      if (multi) {
        const maxTrackIdx = Math.max(...dragState.multiClipInfo!.map(m => m.trackIndex));
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
              const info = dragState.multiClipInfo!.find(m => m.clipId === c.id && !m.isMidi);
              if (info) return { ...c, startTime: Math.max(0, info.originalStartTime + timeDelta) };
              return c;
            }),
            midiClips: track.midiClips.map(mc => {
              const info = dragState.multiClipInfo!.find(m => m.clipId === mc.id && m.isMidi);
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
      if (clampedTarget !== dragState.targetTrackIndex) {
        setDragState(prev => ({ ...prev, targetTrackIndex: clampedTarget }));
      }
    };

    // Handle drag end
    const handleDragEnd = async () => {
      // Only handle if this clip was actually being dragged
      if (dragState.clipId !== clip.id) return;

      const multi = dragState.multiClipInfo && dragState.multiClipInfo.length > 1;
      const anchorTrackIdx = dragState.trackIndex ?? 0;
      const targetIdx = dragState.targetTrackIndex ?? anchorTrackIdx;
      const trackDelta = targetIdx - anchorTrackIdx;

      if (multi) {
        // --- Multi-clip cross-track move ---
        // Sort clips by original track index (top-to-bottom) for ordered processing
        const sorted = [...dragState.multiClipInfo!].sort((a, b) => a.trackIndex - b.trackIndex);

        // Track creation cache: maps desired track index -> actual track ID
        const createdTracks = new Map<number, string>();
        const currentTracks = useDAWStore.getState().tracks;

        for (const info of sorted) {
          const desiredTrackIdx = info.trackIndex + trackDelta;

          // Same track — no cross-track move needed (time already updated during drag)
          if (desiredTrackIdx === info.trackIndex) continue;

          let targetTrackId: string | undefined;

          if (desiredTrackIdx >= 0 && desiredTrackIdx < currentTracks.length) {
            // Target track exists — check type compatibility
            const srcTrack = currentTracks[info.trackIndex];
            const dstTrack = currentTracks[desiredTrackIdx];
            if (dstTrack.type === srcTrack.type) {
              targetTrackId = dstTrack.id;
            }
          }

          // Need a new track — either beyond bounds or incompatible type
          if (!targetTrackId) {
            // Check if we already created a track for this index in this batch
            if (createdTracks.has(desiredTrackIdx)) {
              targetTrackId = createdTracks.get(desiredTrackIdx)!;
            } else {
              try {
                const backendTrackId = await nativeBridge.addTrack();
                const srcTrack = currentTracks[info.trackIndex];
                addTrack({
                  id: backendTrackId,
                  name: `Track ${useDAWStore.getState().tracks.length + 1}`,
                  type: srcTrack.type,
                });
                createdTracks.set(desiredTrackIdx, backendTrackId);
                targetTrackId = backendTrackId;
              } catch (error) {
                console.error("[Timeline] Failed to create track for multi-clip drag:", error);
                continue;
              }
            }
          }

          // Move the clip to the target track (keeps current startTime from drag)
          const currentClipState = useDAWStore.getState().tracks
            .flatMap(t => [...t.clips, ...t.midiClips])
            .find(c => c.id === info.clipId);
          if (currentClipState && targetTrackId) {
            await moveClipToTrack(info.clipId, targetTrackId, currentClipState.startTime);
          }
        }
      } else {
        // --- Single clip drag end (existing behavior) ---
        if (showGhostTrack) {
          try {
            const backendTrackId = await nativeBridge.addTrack();
            addTrack({
              id: backendTrackId,
              name: `Track ${tracks.length + 1}`,
            });
            await moveClipToTrack(clip.id, backendTrackId, clip.startTime);
            console.log(`[Timeline] Created new track ${backendTrackId} from drag`);
          } catch (error) {
            console.error("[Timeline] Failed to create track from drag:", error);
          }
        } else if (
          dragState.targetTrackIndex != null &&
          dragState.targetTrackIndex !== trackIndex &&
          dragState.targetTrackIndex < tracks.length
        ) {
          const targetTrackId = tracks[dragState.targetTrackIndex].id;
          await moveClipToTrack(clip.id, targetTrackId, clip.startTime);
        }
      }

      // Sync backend with current frontend clip state after drag completes.
      await syncClipsWithBackend();

      // Always reset drag state (also hides ghost track)
      resetDragState();
    };

    // Mouse handlers for edge resize
    const EDGE_THRESHOLD = 8;

    const handleMouseMove = (e: any) => {
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
      const clipTopY = trackY + 5; // clip has 5px top padding
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

    const handleMouseLeave = (e: any) => {
      const stage = e.target.getStage();
      stage.container().style.cursor = "default";
    };

    const handleMouseDown = (e: any) => {
      // Split tool mode: click splits the clip at the clicked position
      if (toolModeRef.current === "split") {
        e.cancelBubble = true;
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        let splitTime = (pointerPos.x + scrollX) / pixelsPerSecond;
        if (snapEnabled) {
          splitTime = snapToGrid(splitTime, tempo, timeSignature, gridSize);
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
          const clipTopY = trackY + 5;
          const clipH = trackHeight - 10;
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

      // Alt+drag on clip = slip editing (adjust offset, not position)
      if (e.evt?.altKey && clip.filePath) {
        e.cancelBubble = true;
        slipEditRef.current = {
          clipId: clip.id,
          trackId: trackId,
          startX: pointerPos.x,
          originalOffset: clip.offset || 0,
          sourceLength: clip.sourceLength ?? (clip.offset + clip.duration + 60), // fallback generous estimate
          clipDuration: clip.duration,
        };
        stage.container().style.cursor = "grab";
        return;
      }

      // Smart tool: detect fade corner zones
      if (toolModeRef.current === "smart") {
        const FADE_CORNER = 15;
        const clipTopY = trackY + 5;
        const relativeY = pointerPos.y - clipTopY;
        if (relativeY < FADE_CORNER && relativeX < FADE_CORNER) {
          // Top-left corner: fade-in adjustment via drag
          e.cancelBubble = true;
          setDragState({ type: "resize-left", clipId: clip.id, trackIndex, targetTrackIndex: trackIndex, startX: pointerPos.x, startTime: (pointerPos.x + scrollX) / pixelsPerSecond, originalStartTime: clip.startTime, originalDuration: clip.duration, originalOffset: clip.offset, isFadeDrag: true });
          stage.container().style.cursor = "crosshair";
          return;
        }
        if (relativeY < FADE_CORNER && relativeX > width - FADE_CORNER) {
          // Top-right corner: fade-out adjustment via drag
          e.cancelBubble = true;
          setDragState({ type: "resize-right", clipId: clip.id, trackIndex, targetTrackIndex: trackIndex, startX: pointerPos.x, startTime: (pointerPos.x + scrollX) / pixelsPerSecond, originalStartTime: clip.startTime, originalDuration: clip.duration, originalOffset: clip.offset, isFadeDrag: true });
          stage.container().style.cursor = "crosshair";
          return;
        }
      }

      // Determine drag type based on cursor position
      let dragType: "move" | "resize-left" | "resize-right" = "move";
      if (relativeX < EDGE_THRESHOLD) {
        dragType = "resize-left";
        stage.container().style.cursor = "ew-resize";
      } else if (relativeX > width - EDGE_THRESHOLD) {
        dragType = "resize-right";
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
      setDragState({
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
    const handleDragMoveModified = (e: any) => {
      if (!dragState.clipId || dragState.clipId !== clip.id) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      const deltaX = pointerPos.x - dragState.startX;
      const deltaTime = deltaX / pixelsPerSecond;

      // Smart tool fade drag: adjust fadeIn/fadeOut instead of resizing
      if (dragState.isFadeDrag) {
        const fadeDelta = Math.max(0, deltaTime);
        if (dragState.type === "resize-left") {
          const newFadeIn = Math.min(fadeDelta, clip.duration * 0.5);
          useDAWStore.getState().setClipFades(clip.id, newFadeIn, clip.fadeOut || 0);
        } else if (dragState.type === "resize-right") {
          const newFadeOut = Math.min(Math.max(0, -deltaTime), clip.duration * 0.5);
          useDAWStore.getState().setClipFades(clip.id, clip.fadeIn || 0, newFadeOut);
        }
        return;
      }

      if (dragState.type === "resize-left") {
        let newStartTime = Math.max(
          0,
          dragState.originalStartTime + deltaTime,
        );

        // Apply snap-to-grid if enabled
        if (snapEnabled) {
          newStartTime = snapToGrid(newStartTime, tempo, timeSignature, gridSize);
        }

        const timeDiff = newStartTime - dragState.originalStartTime;
        const newDuration = Math.max(
          0.1,
          dragState.originalDuration - timeDiff,
        );
        const newOffset = Math.max(0, dragState.originalOffset + timeDiff);
        resizeClip(clip.id, newStartTime, newDuration, newOffset);
      } else if (dragState.type === "resize-right") {
        let newDuration = Math.max(
          0.1,
          dragState.originalDuration + deltaTime,
        );

        // Clamp to source file length if known
        if (clip.sourceLength !== undefined) {
          const maxDuration = clip.sourceLength - clip.offset;
          newDuration = Math.min(newDuration, maxDuration);
        }

        // Apply snap-to-grid to end time (start + duration) if enabled
        if (snapEnabled) {
          const endTime = clip.startTime + newDuration;
          const snappedEndTime = snapToGrid(
            endTime,
            tempo,
            timeSignature,
            gridSize
          );
          newDuration = Math.max(0.1, snappedEndTime - clip.startTime);
          // Re-clamp after snap
          if (clip.sourceLength !== undefined) {
            newDuration = Math.min(newDuration, clip.sourceLength - clip.offset);
          }
        }

        resizeClip(clip.id, clip.startTime, newDuration, clip.offset);
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
        {/* Selected glow effect */}
        {isSelected && !clip.muted && (
          <Rect
            x={x - 2}
            y={trackY + 3}
            width={width + 4}
            height={trackHeight - 6}
            fill="transparent"
            cornerRadius={5}
            shadowColor={clip.color || trackColor}
            shadowBlur={10}
            shadowOpacity={0.5}
            listening={false}
          />
        )}
        {/* Clip background with gradient-like layering */}
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          fill={clip.color || trackColor}
          opacity={clip.muted ? 0.1 : isCut ? 0.1 : 0.18}
          cornerRadius={4}
          listening={false}
        />
        {/* Gradient highlight at top of clip */}
        {!clip.muted && !isCut && (
          <Rect
            x={x}
            y={trackY + 5}
            width={width}
            height={Math.min(12, (trackHeight - 10) / 3)}
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
            const barH = (trackHeight - 20) * pseudoRand;
            const barY = trackY + 10 + (trackHeight - 20 - barH) / 2;
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
          const clipH = trackHeight - 10;
          const clipTopY = trackY + 5;
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
          const clipH = trackHeight - 10;
          const clipTopY = trackY + 5;
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
          const clipH = trackHeight - 10;
          const shape = (clip as AudioClip).fadeInShape ?? 0;
          // Curve points trace the fade gain from left (silence) to right (full)
          const curvePts = fadeInCurvePoints(x, trackY + 5, fadeW, clipH, shape, 24);
          // Build a closed polygon: top-left corner -> along curve -> top edge back
          // The darkened area is above the curve (where audio is attenuated)
          const fillPts = [
            x, trackY + 5, // top-left corner
            ...curvePts,   // curve from bottom-left to top-right
            x + fadeW, trackY + 5, // top-right corner (close along top)
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
          const clipH = trackHeight - 10;
          const shape = (clip as AudioClip).fadeOutShape ?? 0;
          // Curve points trace the fade gain from left (full) to right (silence)
          const curvePts = fadeOutCurvePoints(x, trackY + 5, width, fadeW, clipH, shape, 24);
          // Darkened area is above the curve (where audio is attenuated)
          const fadeStartX = x + width - fadeW;
          const fillPts = [
            fadeStartX, trackY + 5,  // top-left of fade region
            ...curvePts,             // curve from top-left to bottom-right
            x + width, trackY + 5,   // top-right corner (close along top)
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
        {clip.muted && (
          <>
            <Rect
              x={x}
              y={trackY + 5}
              width={width}
              height={trackHeight - 10}
              fill="#000000"
              opacity={0.4}
              cornerRadius={3}
              listening={false}
            />
            <Group
              listening={false}
              opacity={0.2}
              clipFunc={(ctx: any) => {
                ctx.beginPath();
                ctx.roundRect(x, trackY + 5, width, trackHeight - 10, 3);
              }}
            >
              {Array.from({ length: Math.ceil(width / 12) + 1 }).map((_, i) => (
                <Line
                  key={`mute-stripe-${i}`}
                  points={[x + i * 12, trackY + 5, x + i * 12 - (trackHeight - 10), trackY + trackHeight - 5]}
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
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          stroke={clip.muted ? "#666" : isSelected ? "#4cc9f0" : "#fff"}
          strokeWidth={isSelected ? 2 : 0.5}
          cornerRadius={3}
          onClick={handleClipClick}
          onTap={handleClipClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onMouseDown={handleMouseDown}
          onContextMenu={(e: any) => {
            e.evt.preventDefault();
            setClipContextMenu({
              x: e.evt.clientX,
              y: e.evt.clientY,
              clipId: clip.id,
              trackId: trackId,
            });
          }}
        />
        {/* Clip name */}
        <Text
          x={x + 5}
          y={trackY + 8}
          text={clip.locked ? `🔒 ${clip.muted ? "[M] " : ""}${clip.name}` : clip.muted ? `[M] ${clip.name}` : clip.name}
          fontSize={10}
          fill={clip.muted ? "#888" : "#fff"}
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
            const volumeY =
              trackY + 5 + (trackHeight - 10) * (1 - volumeNormalized);

            const handleVolumeMouseDown = (e: any) => {
              e.cancelBubble = true; // Prevent clip drag
              e.evt?.stopPropagation?.(); // Also stop native event
              beginClipVolumeEdit(clip.id); // Capture starting value for undo
            };

            const handleVolumeDrag = (e: any) => {
              e.cancelBubble = true; // Prevent bubbling to parent Group
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              const relativeY = pointerPos.y - (trackY + 5);
              const normalizedY = 1 - relativeY / (trackHeight - 10);
              const clampedY = Math.max(0, Math.min(1, normalizedY));
              const newVolumeDB = clampedY * volumeRange - 60;
              setClipVolume(clip.id, newVolumeDB);
            };

            const handleVolumeDragEnd = (e: any) => {
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
                  onDragStart={(e: any) => {
                    e.cancelBubble = true;
                  }}
                  onDragMove={handleVolumeDrag}
                  onDragEnd={handleVolumeDragEnd}
                  dragBoundFunc={(pos: any) => ({
                    x: x, // Lock horizontal position
                    y: Math.max(
                      trackY + 5,
                      Math.min(trackY + trackHeight - 5, pos.y),
                    ),
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
            const handleFadeInDrag = (e: any) => {
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

            const handleFadeOutDrag = (e: any) => {
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
                  y={trackY + 10}
                  radius={6}
                  fill="#4cc9f0"
                  stroke="#fff"
                  strokeWidth={1}
                  draggable
                  onMouseDown={(e: any) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragStart={(e: any) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragMove={handleFadeInDrag}
                  onDragEnd={(e: any) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  dragBoundFunc={(pos: any) => ({
                    x: Math.max(x, Math.min(x + maxFadeWidth, pos.x)),
                    y: trackY + 10,
                  })}
                />
                {/* Fade out handle - circle at fade position */}
                <Circle
                  x={x + width - fadeOutWidth}
                  y={trackY + 10}
                  radius={6}
                  fill="#4cc9f0"
                  stroke="#fff"
                  strokeWidth={1}
                  draggable
                  onMouseDown={(e: any) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragStart={(e: any) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  onDragMove={handleFadeOutDrag}
                  onDragEnd={(e: any) => {
                    e.cancelBubble = true;
                    e.evt?.stopPropagation?.();
                  }}
                  dragBoundFunc={(pos: any) => ({
                    x: Math.max(x + width - maxFadeWidth, Math.min(x + width, pos.x)),
                    y: trackY + 10,
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

  // Render recording clip with live waveform
  const renderRecordingClip = (
    clip: RecordingClip,
    trackY: number,
    trackColor: string,
  ) => {
    const x = clip.startTime * pixelsPerSecond - scrollX;
    const currentTime = useDAWStore.getState().transport.currentTime;
    const width = (currentTime - clip.startTime) * pixelsPerSecond;

    if (width <= 0) return null;

    // Get recording waveform data if available
    const recordingData = recordingWaveformCache.get(clip.trackId);

    // Generate waveform visualization from recording peaks
    const renderRecordingWaveform = (): React.ReactNode[] => {
      if (!recordingData || recordingData.peaks.length === 0) return [];

      const { peaks: recordingPeaks, widthPixels: peaksWidth } = recordingData;
      const numChannels = recordingPeaks[0]?.channels?.length || 1;
      const waveforms: React.ReactNode[] = [];
      const waveformHeight = trackHeight - 20;

      for (let ch = 0; ch < numChannels; ch++) {
        const points: number[] = [];
        const channelHeight = waveformHeight / numChannels;
        const channelY = trackY + 10 + ch * channelHeight;
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
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          fill={trackColor}
          opacity={0.3}
          cornerRadius={3}
          stroke={trackColor}
          strokeWidth={1}
        />
        {/* Live waveform visualization */}
        {renderRecordingWaveform()}
        {/* Recording indicator text */}
        <Text
          x={x + 5}
          y={trackY + 8}
          text="REC"
          fontSize={10}
          fill="#fff"
          fontStyle="bold"
          listening={false}
        />
        {/* Recording indicator dot (pulsing effect via opacity) */}
        <Circle
          x={x + 35}
          y={trackY + 13}
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
    const x = clip.startTime * pixelsPerSecond - scrollX;
    const width = clip.duration * pixelsPerSecond;
    const isSelected = selectedClipIds.includes(clip.id);

    // Visual offset for multi-clip drag
    if (dragState.type === "move" && dragState.multiClipInfo && dragState.multiClipInfo.length > 1 && dragState.targetTrackIndex != null) {
      const info = dragState.multiClipInfo.find(m => m.clipId === clip.id);
      if (info) {
        const trackDelta = dragState.targetTrackIndex - (dragState.trackIndex ?? 0);
        const visualTrackIdx = info.trackIndex + trackDelta;
        if (visualTrackIdx !== _trackIndex) {
          trackY = trackYs[visualTrackIdx] ?? trackY;
        }
      }
    }

    // Skip if clip is outside visible area
    if (x + width < 0 || x > dimensions.width) return null;

    // Get note events and calculate visual representation
    const noteOns = clip.events.filter((e) => e.type === "noteOn");
    const isNarrowMidi = width < 60;

    // Generate simple visual representation of notes
    const renderNotePreview = () => {
      if (noteOns.length === 0) return null;

      const previewHeight = trackHeight - 20;
      const lines: React.ReactNode[] = [];

      // Find min/max notes for scaling
      const notes = noteOns.map(e => e.note || 60);
      const minNote = Math.min(...notes);
      const maxNote = Math.max(...notes);
      const noteRange = Math.max(1, maxNote - minNote);

      if (isNarrowMidi) {
        // Compact thumbnail: tiny 1-2px bars showing note positions
        // Limit to a subset of notes to keep rendering fast
        const maxBars = Math.max(2, Math.floor(width / 3));
        const step = Math.max(1, Math.floor(noteOns.length / maxBars));
        for (let i = 0; i < noteOns.length && lines.length < maxBars; i += step) {
          const noteOn = noteOns[i];
          if (noteOn.note === undefined) continue;
          const noteX = x + (noteOn.timestamp / clip.duration) * width;
          const noteY = trackY + 10 + ((maxNote - noteOn.note) / noteRange) * (previewHeight - 4);
          lines.push(
            <Rect
              key={`midi-thumb-${i}`}
              x={noteX}
              y={noteY}
              width={Math.max(1, width * 0.05)}
              height={Math.max(1.5, Math.min(3, previewHeight / noteRange))}
              fill={clip.color || trackColor}
              opacity={0.9}
              listening={false}
            />
          );
        }
        return lines;
      }

      noteOns.forEach((noteOn, i) => {
        const noteOff = clip.events.find(
          (e) => e.type === "noteOff" && e.note === noteOn.note && e.timestamp > noteOn.timestamp
        );
        if (!noteOff || noteOn.note === undefined) return;

        const noteX = x + (noteOn.timestamp / clip.duration) * width;
        const noteWidth = Math.max(2, ((noteOff.timestamp - noteOn.timestamp) / clip.duration) * width);
        const noteY = trackY + 10 + ((maxNote - noteOn.note) / noteRange) * (previewHeight - 4);
        const noteHeight = Math.max(2, previewHeight / noteRange);

        lines.push(
          <Rect
            key={`midi-note-${i}`}
            x={noteX}
            y={noteY}
            width={noteWidth}
            height={Math.min(noteHeight, 4)}
            fill={clip.color || trackColor}
            opacity={0.8}
            listening={false}
          />
        );
      });

      return lines;
    };

    const handleMIDIClipMouseDown = (e: any) => {
      if (toolModeRef.current === "split") {
        e.cancelBubble = true;
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        let splitTime = (pointerPos.x + scrollX) / pixelsPerSecond;
        if (snapEnabled) {
          splitTime = snapToGrid(splitTime, tempo, timeSignature, gridSize);
        }
        splitMIDIClipAtPosition(clip.id, splitTime);
        return;
      }
    };

    const handleMIDIClipClick = (e: any) => {
      if (toolModeRef.current === "split") return; // handled in mousedown
      const ctrl = e.evt?.ctrlKey || e.evt?.metaKey;
      selectClip(clip.id, { ctrl });
    };

    const handleMIDIClipDoubleClick = () => {
      // Open piano roll editor
      openPianoRoll(trackId, clip.id);
    };

    return (
      <Group key={clip.id}>
        {/* Clip background */}
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          fill={clip.color || trackColor}
          opacity={0.25}
          cornerRadius={3}
          onMouseDown={handleMIDIClipMouseDown}
          onClick={handleMIDIClipClick}
          onTap={handleMIDIClipClick}
          onDblClick={handleMIDIClipDoubleClick}
          onDblTap={handleMIDIClipDoubleClick}
        />
        {/* Note preview */}
        {renderNotePreview()}
        {/* Clip border */}
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          stroke={isSelected ? "#4cc9f0" : "#fff"}
          strokeWidth={isSelected ? 2 : 0.5}
          cornerRadius={3}
          listening={false}
        />
        {/* MIDI indicator — compact for narrow clips */}
        <Text
          x={x + (isNarrowMidi ? 2 : 5)}
          y={trackY + 8}
          text={isNarrowMidi ? "♪" : `♪ ${clip.name}`}
          fontSize={isNarrowMidi ? 9 : 10}
          fill="#fff"
          width={Math.max(0, width - (isNarrowMidi ? 4 : 10))}
          ellipsis={true}
          wrap="none"
          listening={false}
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
            text={`${laneLabel} [${lane.mode}]`}
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
                  onDragMove={(e: any) => {
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
              <Text x={4} y={laneTop + 3} text={`${laneLabel} [${lane.mode}]`} fontSize={10} fill={color} opacity={0.6} listening={false} />
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
                      onDragMove={(e: any) => {
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
    const gridInterval = calculateGridInterval(tempo, timeSignature, gridSize);

    // Calculate visible time range
    const startTime = scrollX / pixelsPerSecond;
    const endTime = (scrollX + dimensions.width) / pixelsPerSecond;

    // Generate grid lines for visible range
    const startIndex = Math.floor(startTime / gridInterval);
    const endIndex = Math.ceil(endTime / gridInterval);

    for (let i = startIndex; i <= endIndex; i++) {
      const time = i * gridInterval;
      const x = time * pixelsPerSecond - scrollX;

      // Skip if outside visible range
      if (x < -10 || x > dimensions.width + 10) continue;

      gridLines.push(
        <Line
          key={`snap-grid-${i}`}
          points={[x, 0, x, stageHeight]}
          stroke="#10b981"
          strokeWidth={0.5}
          opacity={0.2}
          dash={[4, 4]}
          listening={false}
        />
      );
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

  return (
    <div
      ref={containerRef}
      className="timeline-container relative flex-1 min-w-0 bg-neutral-900 flex flex-col"
    >
      {/* Sticky Ruler */}
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

      {/* Empty State — shown when no tracks exist */}
      {tracks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-5 pointer-events-none" style={{ top: RULER_HEIGHT }}>
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
        onMouseLeave={() => { if (showCrosshair) setCrosshairPos(null); }}
        onMouseDown={(e: any) => {
          const targetName = e.target.name?.() || e.target.attrs?.name || "";
          // Alt+drag on background starts razor edit
          if (e.evt?.altKey) {
            if (targetName === "timeline-bg") {
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
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
            const stage = e.target.getStage();
            const pointerPos = stage.getPointerPosition();
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
            const stage = e.target.getStage();
            const pointerPos = stage.getPointerPosition();
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
        onClick={(e: any) => {
          // Skip deselection if marquee just finished
          if (marqueeJustCompletedRef.current) {
            marqueeJustCompletedRef.current = false;
            return;
          }
          // Click on background only → deselect all and clear razor edits
          const targetName = e.target.name?.() || e.target.attrs?.name || "";
          if (targetName === "timeline-bg" && !e.evt?.altKey) {
            deselectAllTracks();
            selectClip(null);
            if (razorEdits.length > 0) clearRazorEdits();
          }
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
                  onDblClick={(e: any) => {
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
                  onDblTap={(e: any) => {
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
              y={marqueeRect.y - scrollY + RULER_HEIGHT}
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
        onScroll={scheduleScroll}
        setScroll={setScroll}
      />

      {/* Clip Context Menu */}
      {clipContextMenu && (
        <ContextMenu
          x={clipContextMenu.x}
          y={clipContextMenu.y}
          items={[
            {
              label: "Cut",
              shortcut: "Ctrl+X",
              onClick: () => cutClip(clipContextMenu.clipId),
            },
            {
              label: "Copy",
              shortcut: "Ctrl+C",
              onClick: () => copyClip(clipContextMenu.clipId),
            },
            {
              label: "Paste",
              shortcut: "Ctrl+V",
              disabled: !clipboard.clip,
              onClick: () => pasteClip(clipContextMenu.trackId, useDAWStore.getState().transport.currentTime),
            },
            { divider: true, label: "" },
            {
              label: (() => {
                const clip = useDAWStore.getState().tracks
                  .flatMap((t) => t.clips)
                  .find((c) => c.id === clipContextMenu.clipId);
                return clip?.muted ? "Unmute Clip" : "Mute Clip";
              })(),
              shortcut: "U",
              onClick: () => useDAWStore.getState().toggleClipMute(clipContextMenu.clipId),
            },
            {
              label: "Split at Cursor",
              shortcut: "S",
              onClick: () => {
                useDAWStore.getState().selectClip(clipContextMenu.clipId);
                useDAWStore.getState().splitClipAtPlayhead();
              },
            },
            { divider: true, label: "" },
            {
              label: "Duplicate",
              shortcut: "Ctrl+D",
              onClick: () => duplicateClip(clipContextMenu.clipId),
            },
            {
              label: "Delete",
              shortcut: "Del",
              onClick: () => deleteClip(clipContextMenu.clipId),
            },
            { divider: true, label: "" },
            {
              label: (() => {
                const clip = useDAWStore.getState().tracks
                  .flatMap((t) => t.clips)
                  .find((c) => c.id === clipContextMenu.clipId);
                return clip?.locked ? "Unlock Clip" : "Lock Clip";
              })(),
              onClick: () => useDAWStore.getState().toggleClipLock(clipContextMenu.clipId),
            },
            { divider: true, label: "" },
            {
              label: (() => {
                const clip = useDAWStore.getState().tracks
                  .flatMap((t) => t.clips)
                  .find((c) => c.id === clipContextMenu.clipId);
                return clip?.reversed ? "Unreverse Clip" : "Reverse Clip";
              })(),
              onClick: () => { void useDAWStore.getState().reverseClip(clipContextMenu.clipId); },
            },
            {
              label: "Edit Pitch...",
              onClick: () => {
                const state = useDAWStore.getState();
                state.openPitchEditor(clipContextMenu.trackId, clipContextMenu.clipId, -1);
              },
            },
            {
              label: "Extract MIDI from Audio...",
              onClick: () => {
                void (async () => {
                  const { nativeBridge } = await import("../services/NativeBridge");
                  const result = await nativeBridge.extractMidiFromAudio(clipContextMenu!.trackId, clipContextMenu!.clipId);
                  if (result && result.notes && result.notes.length > 0) {
                    const state = useDAWStore.getState();
                    const sourceTrack = state.tracks.find((t: any) => t.id === clipContextMenu!.trackId);
                    const sourceClip = sourceTrack?.clips.find((c: any) => c.id === clipContextMenu!.clipId);
                    const clipStartTime = sourceClip?.startTime || 0;
                    const trackId = crypto.randomUUID();
                    state.addTrack({
                      id: trackId,
                      name: `MIDI from ${sourceClip?.name || "Audio"}`,
                      type: "midi",
                    });
                    // Calculate total duration from extracted notes
                    const maxEnd = Math.max(...result.notes.map((n: any) => n.endTime));
                    const newClipId = state.addMIDIClip(trackId, clipStartTime, maxEnd);
                    // Convert poly notes to MIDI noteOn/noteOff events
                    const events: any[] = [];
                    for (const n of result.notes) {
                      events.push({ timestamp: n.startTime, type: "noteOn", note: n.midiPitch, velocity: Math.round(n.velocity * 127) });
                      events.push({ timestamp: n.endTime, type: "noteOff", note: n.midiPitch, velocity: 0 });
                    }
                    events.sort((a: any, b: any) => a.timestamp - b.timestamp);
                    // Update the clip with extracted events
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
                const state = useDAWStore.getState();
                const sourceTrack = state.tracks.find((t: any) => t.id === clipContextMenu!.trackId);
                const sourceClip = sourceTrack?.clips.find((c: any) => c.id === clipContextMenu!.clipId);
                if (!sourceClip) return;
                state.openStemSeparation(
                  clipContextMenu!.trackId,
                  clipContextMenu!.clipId,
                  sourceClip.name || "Audio",
                  sourceClip.duration
                );
              },
            },
            {
              label: (() => {
                // Will be replaced dynamically, but static label as fallback
                return "Edit with ARA Plugin...";
              })(),
              onClick: () => {
                void (async () => {
                  const { nativeBridge } = await import("../services/NativeBridge");
                  const araPlugins = await nativeBridge.getARAPlugins();
                  if (araPlugins.length === 0) {
                    alert("No ARA-compatible plugins found. Install an ARA plugin (e.g., Re-Pitch, Melodyne) and rescan.");
                    return;
                  }

                  const trackId = clipContextMenu!.trackId;
                  const clipId = clipContextMenu!.clipId;

                  // If multiple ARA plugins, let user pick; otherwise use the only one
                  let selectedPlugin = araPlugins[0];
                  if (araPlugins.length > 1) {
                    const choice = prompt(`Multiple ARA plugins found. Enter the number (1-${araPlugins.length}):\n\n${araPlugins.map((p, i) => `${i + 1}. ${p.name} (${p.manufacturer})`).join("\n")}`);
                    const idx = parseInt(choice || "1", 10) - 1;
                    if (idx >= 0 && idx < araPlugins.length) selectedPlugin = araPlugins[idx];
                  }

                  // Initialize ARA and add the clip
                  const initResult = await nativeBridge.initializeARA(trackId, 0);
                  if (initResult.success) {
                    const addResult = await nativeBridge.addARAClip(trackId, clipId);
                    if (!addResult.success) {
                      alert(addResult.error || `Failed to add clip to ${selectedPlugin.name}.`);
                    }
                  } else {
                    alert(`Failed to initialize ${selectedPlugin.name}: ${initResult.error || "Unknown error"}`);
                  }
                })();
              },
            },
            {
              label: "Dynamic Split...",
              onClick: () => useDAWStore.getState().openDynamicSplit(clipContextMenu.clipId),
            },
            { divider: true, label: "" },
            {
              label: "Render in Place",
              onClick: () => { void useDAWStore.getState().renderClipInPlace(clipContextMenu.clipId); },
            },
            { divider: true, label: "" },
            {
              label: "Clip Color",
              submenu: [
                "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
                "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#ffffff",
              ].map((color) => ({
                label: color,
                onClick: () => useDAWStore.getState().setClipColor(clipContextMenu.clipId, color),
              })),
            },
          ]}
          onClose={() => setClipContextMenu(null)}
        />
      )}
    </div>
  );
}
