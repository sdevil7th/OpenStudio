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
} from "../store/useDAWStore";
import { nativeBridge, WaveformPeak } from "../services/NativeBridge";
import { ContextMenu } from "./ContextMenu";
import { HorizontalScrollbar } from "./HorizontalScrollbar";
import { MemoizedPlayhead as Playhead } from "./Playhead";
import {
  snapToGrid,
  calculateGridInterval,
} from "../utils/snapToGrid";

// Constants
const RULER_HEIGHT = 30;
const MIN_PIXELS_PER_SECOND = 1;
const MAX_PIXELS_PER_SECOND = 1000;

// Snap samplesPerPixel to nearest power-of-2 so the waveform cache key
// stays stable across a wide zoom range (prevents re-fetch on every tick).
const quantizeSpp = (spp: number) =>
  Math.max(1, Math.pow(2, Math.round(Math.log2(spp))));

interface TimelineProps {
  tracks: Track[];
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

export function Timeline({ tracks }: TimelineProps) {
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
  }, []);

  // Global mouseup and blur handlers to prevent stuck drag/marquee state
  useEffect(() => {
    const resetMarquee = () => {
      marqueeRef.current = null;
      setMarqueeRect(null);
    };

    const handleGlobalMouseUp = () => {
      if (dragState.type !== null) {
        console.log("[Timeline] Global mouseup - resetting drag state");
        resetDragState();
      }
      if (marqueeRef.current) {
        resetMarquee();
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
    trackGroups,
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
      trackGroups: state.trackGroups,
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
  const contentHeight = tracks.length * trackHeight;
  const stageHeight = Math.max(contentHeight, availableHeight, 200);

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
  const scrollXRef = useRef(scrollX);
  scrollXRef.current = scrollX;
  const scrollYRef = useRef(scrollY);
  scrollYRef.current = scrollY;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const dimensionsWidthRef = useRef(dimensions.width);
  dimensionsWidthRef.current = dimensions.width;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
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

    // Not on a handle — record as pending (will become seek or range-create on mouseup/move)
    rulerDragRef.current = { type: "pending", startX: pointerPos.x, startTime: clickedTime };
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

  // Handle mouse up to finalize time selection / razor edit / marquee (on main stage)
  const handleStageMouseUp = () => {
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
        const clipTop = trackIndex * trackHeight + 5;
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

  // Subscribe to peaksReady events from C++ — invalidate waveform cache for the
  // finished file so renderClip re-fetches on the next render pass.
  useEffect(() => {
    const unsubscribe = nativeBridge.onPeaksReady((filePath: string) => {
      if (!filePath) return;
      setWaveformCache((prev) => {
        const next = new Map(prev);
        // Remove every cached resolution for this file path
        for (const key of next.keys()) {
          if (key.startsWith(filePath)) {
            next.delete(key);
          }
        }
        return next;
      });
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

  // Fetch waveform data for the entire audio file at current zoom resolution.
  // Uses quantized samplesPerPixel so the cache key stays stable across a wide
  // zoom range — prevents re-fetching on every tiny zoom tick.
  const fetchWaveformData = async (filePath: string, fileSampleRate: number = 44100, clipDuration: number = 0) => {
    if (!filePath) return;

    // Skip fetch during active zoom or scroll — use cached data at nearest resolution
    if (isZoomingRef.current || isScrollingRef.current) return;

    const rawSpp = Math.max(1, Math.round(fileSampleRate / pixelsPerSecond));
    const cacheSpp = quantizeSpp(rawSpp);
    const cacheKey = `${filePath}-${cacheSpp}`;

    // Already in-flight — don't duplicate the request
    if (inFlightRef.current.has(cacheKey)) return;

    inFlightRef.current.add(cacheKey);
    try {
      // Calculate actual peaks needed from clip duration (not 999999)
      const totalFileSamples = clipDuration > 0
        ? clipDuration * fileSampleRate
        : 600 * fileSampleRate; // fallback: 10 min max
      const numPeaks = Math.min(100000, Math.ceil(totalFileSamples / cacheSpp));

      const peaks = await nativeBridge.getWaveformPeaks(
        filePath,
        cacheSpp,
        numPeaks,
      );

      if (peaks && peaks.length > 0) {
        setWaveformCache((prev) => new Map(prev).set(cacheKey, peaks));
      }
    } catch (e) {
      console.error("Failed to fetch waveform:", e);
    } finally {
      inFlightRef.current.delete(cacheKey);
    }
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
          trackY = dragState.targetTrackIndex * trackHeight;
        }
      } else if (dragState.multiClipInfo && dragState.multiClipInfo.length > 1) {
        // Other clips in multi-selection — offset by same track delta
        const info = dragState.multiClipInfo.find(m => m.clipId === clip.id);
        if (info) {
          const trackDelta = dragState.targetTrackIndex - (dragState.trackIndex ?? 0);
          const visualTrackIdx = info.trackIndex + trackDelta;
          if (visualTrackIdx !== trackIndex) {
            trackY = visualTrackIdx * trackHeight;
          }
        }
      }
    }

    // Skip if clip is outside visible area
    if (x + width < 0 || x > dimensions.width) return null;

    // Skip zero-duration (or near-zero) clips — a width-0 Rect still renders
    // its stroke as a white hairline, which confuses users after a failed recording.
    if (width < 1) return null;

    // Fetch waveform data if we don't have it (quantized cache key for stability)
    const fileSR = clip.sampleRate || 44100;
    const renderSpp = Math.max(1, Math.round(fileSR / pixelsPerSecond));
    const cacheSpp = quantizeSpp(renderSpp);
    const cacheKey = `${clip.filePath}-${cacheSpp}`;
    const waveformData = waveformCache.get(cacheKey);
    const neededPeaks = Math.ceil(((clip.offset || 0) + clip.duration) * fileSR / cacheSpp);
    if (clip.filePath && (!waveformData || waveformData.length < neededPeaks)) {
      fetchWaveformData(clip.filePath, fileSR, (clip.offset || 0) + clip.duration);
    }

    // Scale factor: maps pixel positions to peak indices when the cached
    // resolution differs from the current zoom level.
    const peakScale = renderSpp / cacheSpp;

    // Generate waveform points for Line drawing.
    // Only renders the visible portion of the clip within the viewport,
    // so large clips don't generate tens of thousands of off-screen points.
    const generateWaveformPoints = (): React.ReactNode[] => {
      if (!waveformData || waveformData.length === 0) return [];

      const numChannels = waveformData[0]?.channels?.length || 1;
      const waveforms: React.ReactNode[] = [];

      // Apply clip gain to waveform visualization
      const gainFactor = clip.volumeDB <= -60 ? 0 : Math.pow(10, clip.volumeDB / 20);

      // Calculate dynamic waveform height based on current trackHeight
      const waveformHeight = trackHeight - 20;

      // Determine which peaks correspond to the clip's audio portion
      const clipStartPeak = Math.max(0, Math.floor((clip.offset * fileSR) / cacheSpp));
      const totalAvailablePeaks = Math.max(0, waveformData.length - clipStartPeak);
      // How many screen pixels the available peaks can fill
      const totalClipPeaks = Math.min(Math.ceil(width), Math.ceil(totalAvailablePeaks / peakScale));

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
          const dataIndex = clipStartPeak + Math.floor(i * peakScale);
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
          const dataIndex = clipStartPeak + Math.floor(i * peakScale);
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
          waveforms.push(
            <Line
              key={`waveform-${clip.id}-ch${ch}`}
              points={points}
              fill={clip.color || trackColor}
              opacity={0.7}
              closed
              stroke={clip.color || trackColor}
              strokeWidth={0.5}
              listening={false}
            />,
          );
        }
      }

      return waveforms;
    };

    // Skip expensive waveform generation during active zoom — just show clip rect
    const waveformShapes = isZoomingRef.current ? [] : generateWaveformPoints();

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
      let newStartTime = Math.max(0, dragState.originalStartTime + deltaTime);

      // Apply snap-to-grid if enabled
      if (snapEnabled) {
        newStartTime = snapToGrid(newStartTime, tempo, timeSignature, gridSize);
      }

      // Compute actual timeDelta after snap (for multi-clip)
      const timeDelta = newStartTime - dragState.originalStartTime;

      // Calculate target track based on Y position
      const targetTrackIdx = Math.floor(pointerPos.y / trackHeight);

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
        {/* Clip background */}
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          fill={clip.color || trackColor}
          opacity={clip.muted ? 0.1 : isCut ? 0.1 : 0.15}
          cornerRadius={3}
          listening={false}
        />
        {/* Waveform visualization */}
        {!clip.muted && waveformShapes}
        {/* Fade envelope overlays — always visible */}
        {clip.fadeIn > 0 && (
          <Line
            points={[
              x, trackY + 5,
              x + clip.fadeIn * pixelsPerSecond, trackY + 5,
              x, trackY + trackHeight - 5,
            ]}
            fill="#000000"
            opacity={0.25}
            closed
            listening={false}
          />
        )}
        {clip.fadeOut > 0 && (
          <Line
            points={[
              x + width, trackY + 5,
              x + width - clip.fadeOut * pixelsPerSecond, trackY + 5,
              x + width, trackY + trackHeight - 5,
            ]}
            fill="#000000"
            opacity={0.25}
            closed
            listening={false}
          />
        )}
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
          width={width - 10}
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
          trackY = visualTrackIdx * trackHeight;
        }
      }
    }

    // Skip if clip is outside visible area
    if (x + width < 0 || x > dimensions.width) return null;

    // Get note events and calculate visual representation
    const noteOns = clip.events.filter((e) => e.type === "noteOn");

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

    const handleMIDIClipClick = (e: any) => {
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
        {/* MIDI indicator */}
        <Text
          x={x + 5}
          y={trackY + 8}
          text={`♪ ${clip.name}`}
          fontSize={10}
          fill="#fff"
          width={width - 10}
          listening={false}
        />
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
  const renderAutomationLanes = (track: Track, trackY: number) => {
    if (!track.showAutomation) return null;

    const automationColors: Record<string, string> = {
      volume: "#22c55e",
      pan: "#3b82f6",
      mute: "#ef4444",
    };

    return track.automationLanes
      .filter((lane) => lane.visible && lane.points.length > 0)
      .map((lane) => {
        const color = automationColors[lane.param] || "#888";
        const points: number[] = [];

        for (const point of lane.points) {
          const x = point.time * pixelsPerSecond - scrollX;
          const y = trackY + trackHeight * (1 - point.value);
          points.push(x, y);
        }

        return (
          <Group key={`auto-${track.id}-${lane.id}`}>
            {/* Automation line */}
            {points.length >= 4 && (
              <Line
                points={points}
                stroke={color}
                strokeWidth={1.5}
                opacity={0.8}
                listening={false}
              />
            )}
            {/* Automation points (circles) */}
            {lane.points.map((point, pi) => {
              const x = point.time * pixelsPerSecond - scrollX;
              const y = trackY + trackHeight * (1 - point.value);
              return (
                <Circle
                  key={`ap-${lane.id}-${pi}`}
                  x={x}
                  y={y}
                  radius={4}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1}
                  opacity={0.9}
                  draggable
                  onDragMove={(e: any) => {
                    const newX = e.target.x();
                    const newY = e.target.y();
                    const newTime = (newX + scrollX) / pixelsPerSecond;
                    const newValue = 1 - (newY - trackY) / trackHeight;
                    useDAWStore.getState().moveAutomationPoint(
                      track.id, lane.id, pi, newTime, newValue,
                    );
                  }}
                  onDblClick={() => {
                    useDAWStore.getState().removeAutomationPoint(track.id, lane.id, pi);
                  }}
                />
              );
            })}
          </Group>
        );
      });
  };

  // Render razor edits (per-track highlight areas)
  const renderRazorEdits = () => {
    if (razorEdits.length === 0) return null;

    return razorEdits.map((razor, i) => {
      const trackIndex = tracks.findIndex((t) => t.id === razor.trackId);
      if (trackIndex === -1) return null;

      const startX = razor.start * pixelsPerSecond - scrollX;
      const endX = razor.end * pixelsPerSecond - scrollX;
      const y = trackIndex * trackHeight - scrollY;

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

    const ghostY = tracks.length * trackHeight;

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
          onMouseDown={handleRulerMouseDown}
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

      {/* Main Timeline Stage */}
      <Stage
        width={dimensions.width}
        height={stageHeight}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        onMouseDown={(e: any) => {
          const targetName = e.target.name?.() || e.target.attrs?.name || "";
          // Alt+drag on background starts razor edit
          if (e.evt?.altKey) {
            if (targetName === "timeline-bg") {
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              if (pointerPos) {
                const time = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
                const trackIndex = Math.floor((pointerPos.y + scrollY) / trackHeight);
                if (trackIndex >= 0 && trackIndex < tracks.length) {
                  clearRazorEdits();
                  setRazorDrag({ active: true, trackId: tracks[trackIndex].id, startTime: time });
                }
              }
            }
          }
          // Marquee selection: plain click+drag on background (no Alt, select tool)
          else if (targetName === "timeline-bg" && toolModeRef.current !== "split") {
            const stage = e.target.getStage();
            const pointerPos = stage.getPointerPosition();
            if (pointerPos) {
              marqueeRef.current = {
                startX: pointerPos.x + scrollX,
                startY: pointerPos.y + scrollY,
                currentX: pointerPos.x + scrollX,
                currentY: pointerPos.y + scrollY,
                ctrlHeld: e.evt?.ctrlKey || e.evt?.metaKey || false,
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
        <Layer>
          {/* Background */}
          <Rect
            name="timeline-bg"
            width={dimensions.width}
            height={stageHeight}
            fill="#121212"
          />

          {/* Tracks Background Alternating - rendered BEFORE grid lines so lines show on top */}
          {tracks.map((track, i) => (
            <Rect
              name="timeline-bg"
              key={`track-bg-${i}`}
              x={0}
              y={i * trackHeight}
              width={dimensions.width}
              height={trackHeight}
              fill={i % 2 === 0 ? "#1a1a1a" : "#171717"}
              opacity={1}
              onDblClick={(e: any) => {
                const stage = e.target.getStage();
                const pointerPos = stage.getPointerPosition();
                const clickTime = (pointerPos.x + scrollX) / pixelsPerSecond;

                // If automation is visible, add a point on the first visible lane
                if (track.showAutomation) {
                  const visibleLane = track.automationLanes.find((l) => l.visible);
                  if (visibleLane) {
                    const clickY = pointerPos.y;
                    const trackY = i * trackHeight - scrollY;
                    const value = 1 - (clickY - trackY) / trackHeight;
                    useDAWStore.getState().addAutomationPoint(
                      track.id, visibleLane.id, clickTime, value,
                    );
                    return;
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
            />
          ))}

          {/* Track group tint overlays */}
          {tracks.map((track, i) => {
            const gInfo = getTrackGroupInfo(track.id, trackGroups);
            if (!gInfo) return null;
            return (
              <Rect
                key={`group-tint-${i}`}
                x={0}
                y={i * trackHeight}
                width={dimensions.width}
                height={trackHeight}
                fill={TRACK_GROUP_COLORS[gInfo.colorIndex]}
                opacity={0.06}
                listening={false}
              />
            );
          })}

          {/* Grid Lines - rendered after track backgrounds so they're visible on top */}
          {gridLines}

          {/* Snap Grid Lines */}
          {renderSnapGridLines()}

          {/* Loop Region */}
          {renderLoopRegion()}

          {/* Time Selection */}
          {renderTimeSelection()}

          {/* Razor Edit Highlights */}
          {renderRazorEdits()}

          {/* Regions (behind markers) */}
          {renderRegions()}

          {/* Markers */}
          {renderMarkers()}

          {/* Clips and Recording Clips */}
          {tracks.map((track, i) => {
            const trackY = i * trackHeight;

            return (
              <Group key={track.id}>
                {/* Existing Audio Clips — render non-selected first, selected on top
                    so that fade handles / volume line of the selected clip are always
                    clickable even when two clips overlap. */}
                {track.clips
                  .filter((clip) => !selectedClipIds.includes(clip.id))
                  .map((clip) =>
                    renderClip(clip, i, trackY, track.color, track.id),
                  )}
                {track.clips
                  .filter((clip) => selectedClipIds.includes(clip.id))
                  .map((clip) =>
                    renderClip(clip, i, trackY, track.color, track.id),
                  )}

                {/* Existing MIDI Clips */}
                {track.midiClips.map((clip) =>
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
          })}

          {/* Ghost Track */}
          {renderGhostTrack()}

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

          {/* Playhead - separate component to avoid Timeline re-renders */}
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
