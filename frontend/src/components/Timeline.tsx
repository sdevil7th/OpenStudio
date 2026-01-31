import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { Stage, Layer, Rect, Line, Text, Group, Circle } from "react-konva";
import { useShallow } from "zustand/shallow";
import {
  useDAWStore,
  Track,
  AudioClip,
  MIDIClip,
  RecordingClip,
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
const MIN_PIXELS_PER_SECOND = 10;
const MAX_PIXELS_PER_SECOND = 200;

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


  // Clip context menu state
  const [clipContextMenu, setClipContextMenu] =
    useState<ClipContextMenuState>(null);

  // Drag state for clip movement and resizing
  const [dragState, setDragState] = useState<{
    type: "move" | "resize-left" | "resize-right" | null;
    clipId: string | null;
    trackIndex: number | null;
    startX: number;
    startTime: number;
    originalStartTime: number;
    originalDuration: number;
    originalOffset: number;
    ghostX?: number; // Ghost preview position
    ghostY?: number;
  }>({
    type: null,
    clipId: null,
    trackIndex: null,
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
      startX: 0,
      startTime: 0,
      originalStartTime: 0,
      originalDuration: 0,
      originalOffset: 0,
    });
    setShowGhostTrack(false);
  }, []);

  // Global mouseup and blur handlers to prevent stuck drag state
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (dragState.type !== null) {
        console.log("[Timeline] Global mouseup - resetting drag state");
        resetDragState();
      }
    };

    const handleWindowBlur = () => {
      if (dragState.type !== null) {
        console.log("[Timeline] Window blur - resetting drag state");
        resetDragState();
      }
    };

    // Add global listeners when drag is active
    if (dragState.type !== null) {
      window.addEventListener("mouseup", handleGlobalMouseUp);
      window.addEventListener("blur", handleWindowBlur);
    }

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
    selectedClipId,
    selectClip,
    moveClipToTrack,
    resizeClip,
    setClipVolume,
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
      selectedClipId: state.selectedClipId,
      selectClip: state.selectClip,
      moveClipToTrack: state.moveClipToTrack,
      resizeClip: state.resizeClip,
      setClipVolume: state.setClipVolume,
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

  // Calculate stage height early (needed by multiple effects and render)
  const MIN_STAGE_HEIGHT = 400;
  const stageHeight = Math.max(tracks.length * trackHeight, MIN_STAGE_HEIGHT);

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
      const tcpWidth = 310; // Track control panel fixed width from CSS
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

  // Handle scroll wheel for zoom with native listener to prevent browser zoom
  // Use requestAnimationFrame for smooth scrolling
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const applyPendingScroll = useCallback(() => {
    if (pendingScrollRef.current !== null) {
      setScroll(pendingScrollRef.current.x, pendingScrollRef.current.y);
      pendingScrollRef.current = null;
    }
    rafIdRef.current = null;
  }, [setScroll]);

  const scheduleScroll = useCallback(
    (newScrollX: number, newScrollY: number) => {
      pendingScrollRef.current = { x: newScrollX, y: newScrollY };
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(applyPendingScroll);
      }
    },
    [applyPendingScroll],
  );

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Horizontal Zoom (Time Scale) - must prevent default FIRST
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(
          MIN_PIXELS_PER_SECOND,
          Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecond * delta),
        );

        // Keep the center of the viewport focused on the same time position
        const viewportCenterTime =
          (scrollX + dimensions.width / 2) / pixelsPerSecond;
        const newScrollX = Math.max(
          0,
          viewportCenterTime * newZoom - dimensions.width / 2,
        );

        setZoom(newZoom);
        scheduleScroll(newScrollX, scrollY);
      } else if (e.altKey) {
        // Vertical Zoom (Track Height)
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newHeight = Math.max(80, Math.min(500, trackHeight * delta)); // Min 80px for components
        setTrackHeight(newHeight);
      } else if (e.shiftKey) {
        // Horizontal scroll with Shift + Mouse Wheel
        e.preventDefault();
        const scrollSpeed = 2;
        // Calculate max scroll based on timeline length (5 minutes + content)
        const maxClipEnd = tracks.reduce(
          (max, track) =>
            Math.max(max, ...track.clips.map((c) => c.startTime + c.duration)),
          0,
        );
        const maxTimelineScroll = Math.max(
          0,
          (maxClipEnd + 300) * pixelsPerSecond - dimensions.width,
        );
        const newScrollX = Math.max(
          0,
          Math.min(maxTimelineScroll, scrollX + e.deltaY * scrollSpeed),
        );
        scheduleScroll(newScrollX, scrollY);
      }
      // Normal vertical scroll: Let native scroll handle it (no preventDefault)
    };

    // Use passive: false to allow preventDefault to work for zoom/horizontal scroll
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [
    pixelsPerSecond,
    trackHeight,
    scrollX,
    scrollY,
    setZoom,
    setTrackHeight,
    scheduleScroll,
    tracks,
    dimensions.width,
  ]);

  // Handle ruler click for seek or time selection
  const handleRulerClick = async (e: any) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
    if (!pointerPos) return;

    const clickedTime = (pointerPos.x + scrollX) / pixelsPerSecond;

    // Shift+click: Start time selection drag
    if (e.evt.shiftKey) {
      setTimeSelectionDrag({
        active: true,
        startTime: Math.max(0, clickedTime),
      });
    } else {
      // Normal click: Seek
      await seekTo(Math.max(0, clickedTime));
    }
  };

  // Handle mouse move for time selection dragging
  const handleStageMouseMove = (e: any) => {
    if (timeSelectionDrag && timeSelectionDrag.active) {
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      if (pointerPos) {
        const currentTime = (pointerPos.x + scrollX) / pixelsPerSecond;
        const startTime = timeSelectionDrag.startTime;
        const endTime = Math.max(0, currentTime);

        // Update time selection
        setTimeSelection(
          Math.min(startTime, endTime),
          Math.max(startTime, endTime)
        );
      }
    }
  };

  // Handle mouse up to finalize time selection
  const handleStageMouseUp = () => {
    if (timeSelectionDrag && timeSelectionDrag.active) {
      setTimeSelectionDrag(null);
    }
  };

  // Keyboard shortcuts for clip editing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedClipId) return;

      // Copy: Ctrl+C
      if (e.ctrlKey && e.key === "c") {
        e.preventDefault();
        copyClip(selectedClipId);
      }
      // Cut: Ctrl+X
      else if (e.ctrlKey && e.key === "x") {
        e.preventDefault();
        cutClip(selectedClipId);
      }
      // Paste: Ctrl+V
      else if (e.ctrlKey && e.key === "v") {
        e.preventDefault();
        // Paste at current playhead position on first track
        if (tracks.length > 0) {
          pasteClip(tracks[0].id, useDAWStore.getState().transport.currentTime);
        }
      }
      // Duplicate: Ctrl+D
      else if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        duplicateClip(selectedClipId);
      }
      // Delete: Delete or Backspace
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteClip(selectedClipId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedClipId,
    copyClip,
    cutClip,
    pasteClip,
    deleteClip,
    duplicateClip,
    tracks,
  ]);

  // Auto-Scroll during playback - uses Zustand subscribe to avoid re-renders
  useEffect(() => {
    if (!isPlaying) return;

    // Track last scroll position to avoid scrolling backwards
    let lastAutoScrollX = scrollX;

    const unsubscribe = useDAWStore.subscribe((state) => {
      if (!state.transport.isPlaying) return;

      const currentTime = state.transport.currentTime;
      const playheadX = currentTime * pixelsPerSecond;
      const triggerPoint = lastAutoScrollX + dimensions.width * 0.75;

      // If playhead goes past 75% of viewport, scroll to keep it there
      if (playheadX > triggerPoint) {
        const targetScrollX = playheadX - dimensions.width * 0.75;
        lastAutoScrollX = targetScrollX;
        setScroll(targetScrollX, 0);
      }
    });

    return () => unsubscribe();
  }, [isPlaying, scrollX, pixelsPerSecond, dimensions.width, setScroll]);

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
        const newCache = new Map(recordingWaveformCache);

        for (const rc of recordingClips) {
          // Calculate the recording width in pixels
          const recordingDuration = currentTime - rc.startTime;
          if (recordingDuration <= 0) continue;

          const widthPixels = Math.ceil(recordingDuration * pixelsPerSecond);
          if (widthPixels < 10) continue; // Don't fetch for tiny clips

          try {
            // Request peaks at reasonable resolution
            const samplesPerPixel = Math.floor((recordingDuration * 44100) / widthPixels);
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

        setRecordingWaveformCache(newCache);
      };

      fetchRecordingPeaks();
    });

    return () => unsubscribe();
  }, [isRecording, recordingClips, tempo, timeSignature.numerator, pixelsPerSecond, recordingWaveformCache]);

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

  // Fetch waveform data from backend
  const fetchWaveformData = async (clip: AudioClip, widthPixels: number) => {
    if (!clip.filePath) return;

    try {
      // Request ~1 peak per pixel for decent resolution
      const numPeaks = Math.ceil(widthPixels);
      const samplesPerPixel = Math.floor((clip.duration * 44100) / widthPixels); // Approx

      const peaks = await nativeBridge.getWaveformPeaks(
        clip.filePath,
        samplesPerPixel,
        numPeaks,
      );

      if (peaks && peaks.length > 0) {
        setWaveformCache((prev) =>
          new Map(prev).set(
            `${clip.filePath}-${Math.round(widthPixels)}`,
            peaks,
          ),
        );
      }
    } catch (e) {
      console.error("Failed to fetch waveform:", e);
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
    const isSelected = selectedClipId === clip.id;
    const isCut = clipboard.isCut && clipboard.clip?.id === clip.id; // Check if this clip is cut

    // Skip if clip is outside visible area
    if (x + width < 0 || x > dimensions.width) return null;

    // Fetch waveform data if we don't have it
    const cacheKey = `${clip.filePath}-${Math.round(width)}`;
    const waveformData = waveformCache.get(cacheKey);
    if (!waveformData && clip.filePath) {
      fetchWaveformData(clip, width);
    }

    // Generate waveform points for Line drawing
    const generateWaveformPoints = (): React.ReactNode[] => {
      if (!waveformData || waveformData.length === 0) return [];

      const numChannels = waveformData[0]?.channels?.length || 1;
      const waveforms: React.ReactNode[] = [];

      // Calculate dynamic waveform height based on current trackHeight
      const waveformHeight = trackHeight - 20;

      // Render each channel separately
      for (let ch = 0; ch < numChannels; ch++) {
        const points: number[] = [];
        const channelHeight = waveformHeight / numChannels;
        const channelY = trackY + 10 + ch * channelHeight;
        const centerY = channelY + channelHeight / 2;
        const halfHeight = channelHeight / 2 - 2;

        // Draw top half (max values)
        for (let i = 0; i < waveformData.length; i++) {
          const channelData = waveformData[i].channels[ch];
          if (!channelData) continue;

          const px = x + (i * width) / waveformData.length;
          const py = centerY - channelData.max * halfHeight;
          points.push(px, py);
        }

        // Draw bottom half (min values, reversed)
        for (let i = waveformData.length - 1; i >= 0; i--) {
          const channelData = waveformData[i].channels[ch];
          if (!channelData) continue;

          const px = x + (i * width) / waveformData.length;
          const py = centerY - channelData.min * halfHeight;
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
              listening={false} // Pass clicks to background rect
            />,
          );
        }
      }

      return waveforms;
    };

    const waveformShapes = generateWaveformPoints();

    // Handle clip click for selection
    const handleClipClick = () => {
      selectClip(clip.id);
    };

    // Handle drag start - only set up if not already set by handleMouseDown (for resize)
    const handleDragStart = (e: any) => {
      selectClip(clip.id);

      // If dragState is already set up by handleMouseDown for resize, don't overwrite it
      if (dragState.clipId === clip.id && (dragState.type === "resize-left" || dragState.type === "resize-right")) {
        return; // Keep the resize state that handleMouseDown set
      }

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();

      setDragState({
        type: "move",
        clipId: clip.id,
        trackIndex,
        startX: pointerPos.x,
        startTime: (pointerPos.x + scrollX) / pixelsPerSecond,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        originalOffset: clip.offset,
      });
    };

    // Handle drag move
    const handleDragMove = (e: any) => {
      if (dragState.type !== "move" || dragState.clipId !== clip.id) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();

      // Calculate new time position
      const deltaX = pointerPos.x - dragState.startX;
      const deltaTime = deltaX / pixelsPerSecond;
      let newStartTime = Math.max(0, dragState.originalStartTime + deltaTime);

      // Apply snap-to-grid if enabled
      if (snapEnabled) {
        newStartTime = snapToGrid(newStartTime, tempo, timeSignature, gridSize);
      }

      // Calculate target track based on Y position
      const targetTrackIndex = Math.floor(pointerPos.y / trackHeight);

      // Check if dragging below all existing tracks (to empty space)
      if (targetTrackIndex >= tracks.length) {
        // Show ghost track at bottom
        setShowGhostTrack(true);
        // Update time position only, keep on current track for now
        if (newStartTime !== clip.startTime) {
          moveClipToTrack(clip.id, tracks[trackIndex].id, newStartTime);
        }
      } else {
        // Normal drag within existing tracks
        setShowGhostTrack(false);
        const clampedTrackIndex = Math.max(
          0,
          Math.min(tracks.length - 1, targetTrackIndex),
        );

        // Update clip position
        if (
          clampedTrackIndex !== trackIndex ||
          newStartTime !== clip.startTime
        ) {
          const targetTrackId = tracks[clampedTrackIndex].id;
          moveClipToTrack(clip.id, targetTrackId, newStartTime);
        }
      }
    };

    // Handle drag end
    const handleDragEnd = async () => {
      // Only handle if this clip was actually being dragged
      if (dragState.clipId !== clip.id) return;

      // If ghost track was shown, create a new track and move clip to it
      if (showGhostTrack) {
        try {
          // Call backend to create track first - this returns the real track ID
          const backendTrackId = await nativeBridge.addTrack();

          // Add to frontend with the backend's ID
          addTrack({
            id: backendTrackId,
            name: `Track ${tracks.length + 1}`,
          });

          // Move clip to the new track
          await moveClipToTrack(clip.id, backendTrackId, clip.startTime);

          console.log(
            `[Timeline] Created new track ${backendTrackId} from drag`,
          );
        } catch (error) {
          console.error("[Timeline] Failed to create track from drag:", error);
        }
      }

      // Always reset drag state (also hides ghost track)
      resetDragState();
    };

    // Mouse handlers for edge resize
    const EDGE_THRESHOLD = 8;

    const handleMouseMove = (e: any) => {
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
      selectClip(clip.id);
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

      // Set drag state immediately - handleDragStart will preserve resize types
      setDragState({
        type: dragType,
        clipId: clip.id,
        trackIndex,
        startX: pointerPos.x,
        startTime: (pointerPos.x + scrollX) / pixelsPerSecond,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        originalOffset: clip.offset,
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
        }

        resizeClip(clip.id, clip.startTime, newDuration, clip.offset);
      } else {
        handleDragMove(e);
      }
    };

    return (
      <Group
        key={clip.id}
        draggable
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
          opacity={isCut ? 0.15 : 0.3} // Dimmed if cut
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
        {/* Waveform visualization */}
        {waveformShapes}
        {/* Clip border - highlight if selected */}
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          stroke={isSelected ? "#4cc9f0" : "#fff"}
          strokeWidth={isSelected ? 2 : 0.5}
          cornerRadius={3}
          onClick={handleClipClick}
          onTap={handleClipClick}
        />
        {/* Clip name */}
        <Text
          x={x + 5}
          y={trackY + 8}
          text={clip.name}
          fontSize={10}
          fill="#fff"
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
            };

            return (
              <>
                <Line
                  points={[x, volumeY, x + width, volumeY]}
                  stroke="#ffaa00"
                  strokeWidth={2}
                  opacity={0.8}
                  listening={false}
                />
                <Circle
                  x={x + width / 2}
                  y={volumeY}
                  radius={4}
                  fill="#ffaa00"
                  stroke="#fff"
                  strokeWidth={1}
                  draggable
                  onMouseDown={handleVolumeMouseDown}
                  onDragStart={(e: any) => {
                    e.cancelBubble = true;
                  }}
                  onDragMove={handleVolumeDrag}
                  onDragEnd={handleVolumeDragEnd}
                  dragBoundFunc={(pos: any) => ({
                    x: pos.x,
                    y: Math.max(
                      trackY + 5,
                      Math.min(trackY + trackHeight - 5, pos.y),
                    ),
                  })}
                />
                <Text
                  x={x + width / 2 + 8}
                  y={volumeY - 6}
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
                {/* Fade in triangle overlay */}
                {clip.fadeIn > 0 && (
                  <Line
                    points={[
                      x,
                      trackY + 5,
                      x + fadeInWidth,
                      trackY + 5,
                      x,
                      trackY + trackHeight - 5,
                    ]}
                    fill="#ffffff"
                    opacity={0.15}
                    closed
                    listening={false}
                  />
                )}
                {/* Fade out triangle overlay */}
                {clip.fadeOut > 0 && (
                  <Line
                    points={[
                      x + width,
                      trackY + 5,
                      x + width - fadeOutWidth,
                      trackY + 5,
                      x + width,
                      trackY + trackHeight - 5,
                    ]}
                    fill="#ffffff"
                    opacity={0.15}
                    closed
                    listening={false}
                  />
                )}
                {/* Fade in handle - circle at fade position */}
                <Circle
                  x={x + fadeInWidth}
                  y={trackY + 10}
                  radius={6}
                  fill="#4cc9f0"
                  stroke="#fff"
                  strokeWidth={1}
                  draggable
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
    const isSelected = selectedClipId === clip.id;

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

    const handleMIDIClipClick = () => {
      selectClip(clip.id);
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
          onMouseDown={handleRulerClick}
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
      >
        <Layer>
          {/* Background */}
          <Rect
            width={dimensions.width}
            height={stageHeight}
            fill="#121212"
          />

          {/* Grid Lines */}
          {gridLines}

          {/* Snap Grid Lines */}
          {renderSnapGridLines()}

          {/* Loop Region */}
          {renderLoopRegion()}

          {/* Time Selection */}
          {renderTimeSelection()}

          {/* Tracks Background Alternating - with double-click for MIDI clip creation */}
          {tracks.map((track, i) => (
            <Rect
              key={`track-bg-${i}`}
              x={0}
              y={i * trackHeight}
              width={dimensions.width}
              height={trackHeight}
              fill={i % 2 === 0 ? "#1a1a1a" : "#171717"}
              opacity={1}
              onDblClick={(e: any) => {
                if (track.type === "midi" || track.type === "instrument") {
                  const stage = e.target.getStage();
                  const pointerPos = stage.getPointerPosition();
                  const clickTime = (pointerPos.x + scrollX) / pixelsPerSecond;
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

          {/* Regions (behind markers) */}
          {renderRegions()}

          {/* Markers */}
          {renderMarkers()}

          {/* Clips and Recording Clips */}
          {tracks.map((track, i) => {
            const trackY = i * trackHeight;

            return (
              <Group key={track.id}>
                {/* Existing Audio Clips */}
                {track.clips.map((clip) =>
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
              </Group>
            );
          })}

          {/* Ghost Track */}
          {renderGhostTrack()}

          {/* Playhead - separate component to avoid Timeline re-renders */}
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
              label: "Duplicate",
              shortcut: "Ctrl+D",
              onClick: () => duplicateClip(clipContextMenu.clipId),
            },
            {
              label: "Delete",
              shortcut: "Del",
              onClick: () => deleteClip(clipContextMenu.clipId),
            },
          ]}
          onClose={() => setClipContextMenu(null)}
        />
      )}
    </div>
  );
}
