import React, { useRef, useEffect, useState, useCallback } from "react";
import { Stage, Layer, Rect, Line, Text, Group, Circle } from "react-konva";
import {
  useDAWStore,
  Track,
  AudioClip,
  RecordingClip,
} from "../store/useDAWStore";
import { nativeBridge, WaveformPeak } from "../services/NativeBridge";

// Constants
const RULER_HEIGHT = 30;
const MIN_PIXELS_PER_SECOND = 10;
const MAX_PIXELS_PER_SECOND = 200;

interface TimelineProps {
  tracks: Track[];
}

// Cache for waveform data to avoid re-fetching
type WaveformCache = Map<string, WaveformPeak[]>;

export function Timeline({ tracks }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 400 });
  const [waveformCache, setWaveformCache] = useState<WaveformCache>(new Map());

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

  const {
    transport,
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
  } = useDAWStore();

  const { currentTime, tempo, loopEnabled, loopStart, loopEnd } = transport;

  // Handle container resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: Math.max(
            containerRef.current.clientHeight,
            RULER_HEIGHT + tracks.length * trackHeight,
          ),
        });
      }
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, [tracks.length, trackHeight]);

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
      } else {
        // Normal scroll: VERTICAL (scroll tracks up/down)
        e.preventDefault();
        const scrollSpeed = 1.5;
        // Calculate max vertical scroll based on track count
        const stageHeight = dimensions.height - 16; // Account for scrollbar
        const totalTracksHeight = tracks.length * trackHeight + RULER_HEIGHT;
        const maxScrollY = Math.max(0, totalTracksHeight - stageHeight);
        const newScrollY = Math.max(
          0,
          Math.min(maxScrollY, scrollY + e.deltaY * scrollSpeed),
        );
        scheduleScroll(scrollX, newScrollY);
      }
    };

    // Use passive: false to allow preventDefault to work
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
    dimensions.height,
  ]);

  // Handle ruler click for seek
  const handleRulerClick = async (e: any) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
    if (pointerPos && pointerPos.y < RULER_HEIGHT) {
      const clickedTime = (pointerPos.x + scrollX) / pixelsPerSecond;
      await seekTo(Math.max(0, clickedTime));
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
          pasteClip(tracks[0].id, currentTime);
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
    currentTime,
    copyClip,
    cutClip,
    pasteClip,
    deleteClip,
    duplicateClip,
    tracks,
  ]);

  // Auto-Scroll during playback
  useEffect(() => {
    if (!transport.isPlaying) return;

    const playheadX = currentTime * pixelsPerSecond;
    const triggerPoint = scrollX + dimensions.width * 0.75;

    // If playhead goes past 75% of viewport, scroll to keep it there
    if (playheadX > triggerPoint) {
      const targetScrollX = playheadX - dimensions.width * 0.75;
      setScroll(targetScrollX, 0);
    }
  }, [
    currentTime,
    transport.isPlaying,
    scrollX,
    pixelsPerSecond,
    dimensions.width,
    setScroll,
  ]);

  // Note: Removed auto-scroll when stopped - users should be able to freely scroll
  // the timeline when not playing. Auto-scroll only happens during playback.

  // Render Grid Lines (Bars and Beats)
  const renderGrid = () => {
    const gridLines = [];
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
      gridLines.push(
        <Line
          key={`bar-${bar}`}
          points={[barX, RULER_HEIGHT, barX, dimensions.height]}
          stroke="#ffffff"
          strokeWidth={1}
          opacity={0.15}
          listening={false}
        />,
      );

      // Draw Bar Number in Ruler
      gridLines.push(
        <Text
          key={`bar-label-${bar}`}
          x={barX + 2}
          y={RULER_HEIGHT - 12}
          text={(bar + 1).toString()}
          fontSize={10}
          fill="#888"
          listening={false}
        />,
      );

      // Draw Beat Lines (Weaker)
      for (let beat = 1; beat < beatsPerBar; beat++) {
        const beatTime = barTime + beat * secondsPerBeat;
        if (beatTime > endVisibleTime) break;

        const beatX = beatTime * pixelsPerSecond - scrollX;
        gridLines.push(
          <Line
            key={`beat-${bar}-${beat}`}
            points={[beatX, RULER_HEIGHT, beatX, dimensions.height]}
            stroke="#ffffff"
            strokeWidth={0.5}
            opacity={0.05}
            listening={false}
          />,
        );
      }
    }
    return gridLines;
  };

  // Generate ruler marks (beat/bar-based to work correctly at any tempo)
  const generateRulerMarks = () => {
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
  };

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

    // Handle drag start
    const handleDragStart = (e: any) => {
      selectClip(clip.id);
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
      const newStartTime = Math.max(0, dragState.originalStartTime + deltaTime);

      // Calculate target track based on Y position
      const targetTrackIndex = Math.floor(
        (pointerPos.y - RULER_HEIGHT) / trackHeight,
      );

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
    const handleDragEnd = () => {
      // Only handle if this clip was actually being dragged
      if (dragState.clipId !== clip.id) return;

      // If ghost track was shown, create a new track and move clip to it
      if (showGhostTrack) {
        const newTrackId = crypto.randomUUID(); // Generate string ID
        addTrack({
          id: newTrackId,
          name: `Track ${tracks.length + 1}`,
        });
        // Move clip to the new track (last index)
        moveClipToTrack(clip.id, newTrackId, clip.startTime);
      }

      // Always hide ghost track and reset drag state
      setShowGhostTrack(false);
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

      // Determine drag type
      let dragType: "move" | "resize-left" | "resize-right" = "move";
      if (relativeX < EDGE_THRESHOLD) {
        dragType = "resize-left";
      } else if (relativeX > width - EDGE_THRESHOLD) {
        dragType = "resize-right";
      }

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
        const newStartTime = Math.max(
          0,
          dragState.originalStartTime + deltaTime,
        );
        const timeDiff = newStartTime - dragState.originalStartTime;
        const newDuration = Math.max(
          0.1,
          dragState.originalDuration - timeDiff,
        );
        const newOffset = Math.max(0, dragState.originalOffset + timeDiff);
        resizeClip(clip.id, newStartTime, newDuration, newOffset);
      } else if (dragState.type === "resize-right") {
        const newDuration = Math.max(
          0.1,
          dragState.originalDuration + deltaTime,
        );
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
        {/* Fade handles - draggable triangles at corners */}
        {isSelected &&
          (() => {
            const handleFadeInDrag = (e: any) => {
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              const relativeX = pointerPos.x - x;
              const fadeLength = Math.max(
                0,
                Math.min(clip.duration / 2, relativeX / pixelsPerSecond),
              );
              setClipFades(clip.id, fadeLength, clip.fadeOut);
            };

            const handleFadeOutDrag = (e: any) => {
              const stage = e.target.getStage();
              const pointerPos = stage.getPointerPosition();
              const relativeX = x + width - pointerPos.x;
              const fadeLength = Math.max(
                0,
                Math.min(clip.duration / 2, relativeX / pixelsPerSecond),
              );
              setClipFades(clip.id, clip.fadeIn, fadeLength);
            };

            const fadeHandleSize = 12;
            const fadeInWidth = clip.fadeIn * pixelsPerSecond;
            const fadeOutWidth = clip.fadeOut * pixelsPerSecond;

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
                {/* Fade in handle */}
                <Line
                  points={[
                    x,
                    trackY + 5,
                    x + fadeHandleSize,
                    trackY + 5,
                    x,
                    trackY + 5 + fadeHandleSize,
                  ]}
                  fill="#4cc9f0"
                  closed
                  draggable
                  onDragMove={handleFadeInDrag}
                  dragBoundFunc={(pos: any) => ({
                    x: Math.max(x, Math.min(x + width / 2, pos.x)),
                    y: trackY + 5,
                  })}
                />
                {/* Fade out handle */}
                <Line
                  points={[
                    x + width,
                    trackY + 5,
                    x + width - fadeHandleSize,
                    trackY + 5,
                    x + width,
                    trackY + 5 + fadeHandleSize,
                  ]}
                  fill="#4cc9f0"
                  closed
                  draggable
                  onDragMove={handleFadeOutDrag}
                  dragBoundFunc={(pos: any) => ({
                    x: Math.max(x + width / 2, Math.min(x + width, pos.x)),
                    y: trackY + 5,
                  })}
                />
              </>
            );
          })()}
      </Group>
    );
  };

  // Render recording clip (visual placeholder for active recording)
  const renderRecordingClip = (
    clip: RecordingClip,
    trackY: number,
    trackColor: string,
  ) => {
    const x = clip.startTime * pixelsPerSecond - scrollX;
    const width = (currentTime - clip.startTime) * pixelsPerSecond;

    if (width <= 0) return null;

    return (
      <Group key={`recording-${clip.trackId}`}>
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          fill={trackColor}
          opacity={0.5}
          cornerRadius={3}
          stroke={trackColor}
          strokeWidth={1}
        />
        <Text
          x={x + 5}
          y={trackY + 8}
          text="Recording..."
          fontSize={10}
          fill="#fff"
          width={width - 10}
          listening={false}
        />
        {/* Pulse animation effect overlay */}
        <Rect
          x={x}
          y={trackY + 5}
          width={width}
          height={trackHeight - 10}
          fill={trackColor}
          opacity={0.2}
          cornerRadius={3}
          listening={false}
        />
      </Group>
    );
  };

  // Render playhead
  const renderPlayhead = () => {
    const x = currentTime * pixelsPerSecond - scrollX;
    if (x < 0 || x > dimensions.width) return null;

    return (
      <Group>
        {/* Playhead line */}
        <Line
          points={[x, 0, x, dimensions.height]}
          stroke="#4cc9f0"
          strokeWidth={1}
        />
        {/* Playhead handle */}
        <Rect
          x={x - 6}
          y={0}
          width={12}
          height={RULER_HEIGHT}
          fill="#4cc9f0"
          opacity={0.3}
        />
      </Group>
    );
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
        height={dimensions.height}
        fill="#a855f7"
        opacity={0.1}
        listening={false}
      />
    );
  };

  // Render ghost track when dragging to empty space
  const renderGhostTrack = () => {
    if (!showGhostTrack) return null;

    const ghostY = RULER_HEIGHT + tracks.length * trackHeight;

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
      const recordingEnd = currentTime;
      if (recordingEnd > maxClipEnd) maxClipEnd = recordingEnd;
    });

    // Timeline length = last clip end + 5 minutes (300 seconds)
    const extraTime = 300; // 5 minutes
    return (maxClipEnd + extraTime) * pixelsPerSecond;
  }, [tracks, recordingClips, currentTime, pixelsPerSecond]);

  const totalTimelineWidth = calculateTotalWidth();

  return (
    <div
      ref={containerRef}
      className="timeline-container relative flex-1 bg-neutral-900 overflow-hidden flex flex-col"
    >
      <Stage
        width={dimensions.width}
        height={dimensions.height - 16}
        onMouseDown={handleRulerClick}
      >
        <Layer>
          {/* Background */}
          <Rect
            width={dimensions.width}
            height={dimensions.height - 16}
            fill="#121212"
          />

          {/* Grid Lines */}
          {renderGrid()}

          {/* Loop Region */}
          {renderLoopRegion()}

          {/* Tracks Background Alternating */}
          {tracks.map((_, i) => (
            <Rect
              key={`track-bg-${i}`}
              x={0}
              y={RULER_HEIGHT + i * trackHeight - scrollY}
              width={dimensions.width}
              height={trackHeight}
              fill={i % 2 === 0 ? "#1a1a1a" : "#171717"}
              opacity={1}
            />
          ))}

          {/* Ruler Background */}
          <Rect
            x={0}
            y={0}
            width={dimensions.width}
            height={RULER_HEIGHT}
            fill="#0a0a0a"
          />
          {/* Ruler Marks */}
          {generateRulerMarks()}

          {/* Clips and Recording Clips */}
          {tracks.map((track, i) => {
            const trackY = RULER_HEIGHT + i * trackHeight - scrollY;

            return (
              <Group key={track.id}>
                {/* Existing Clips */}
                {track.clips.map((clip) =>
                  renderClip(clip, i, trackY, track.color),
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

          {/* Playhead */}
          {renderPlayhead()}
        </Layer>
      </Stage>

      {/* Custom Horizontal Scrollbar with dynamic thumb width */}
      {(() => {
        const trackWidth = dimensions.width - 16; // Account for padding
        const thumbWidthRatio = Math.min(
          1,
          dimensions.width / totalTimelineWidth,
        );
        const thumbWidth = Math.max(30, trackWidth * thumbWidthRatio); // Min 30px thumb
        const maxScroll = Math.max(0, totalTimelineWidth - dimensions.width);
        const thumbPosition =
          maxScroll > 0 ? (scrollX / maxScroll) * (trackWidth - thumbWidth) : 0;

        const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const clickX = e.clientX - rect.left - 8; // Account for padding
          const clickRatio = clickX / trackWidth;
          const newScrollX = clickRatio * maxScroll;
          scheduleScroll(Math.max(0, Math.min(maxScroll, newScrollX)), scrollY);
        };

        const handleThumbMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
          e.stopPropagation();
          const startX = e.clientX;
          const startScrollX = scrollX;

          // Use RAF for smooth dragging
          let rafId: number | null = null;
          let pendingScrollX = startScrollX;

          const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const scrollableTrackWidth = trackWidth - thumbWidth;
            const deltaScroll =
              scrollableTrackWidth > 0
                ? (deltaX / scrollableTrackWidth) * maxScroll
                : 0;
            pendingScrollX = Math.max(
              0,
              Math.min(maxScroll, startScrollX + deltaScroll),
            );

            // Schedule update on next frame
            if (rafId === null) {
              rafId = requestAnimationFrame(() => {
                setScroll(pendingScrollX, scrollY);
                rafId = null;
              });
            }
          };

          const handleMouseUp = () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            // Cancel any pending RAF and apply final position
            if (rafId !== null) {
              cancelAnimationFrame(rafId);
              setScroll(pendingScrollX, scrollY);
            }
          };

          document.addEventListener("mousemove", handleMouseMove);
          document.addEventListener("mouseup", handleMouseUp);
        };

        return (
          <div
            className="h-4 bg-neutral-800 flex items-center px-2 cursor-pointer"
            onClick={handleTrackClick}
          >
            <div className="relative w-full h-2 bg-neutral-700 rounded">
              <div
                className="absolute h-2 bg-neutral-500 rounded cursor-grab active:cursor-grabbing hover:bg-neutral-400 transition-colors"
                style={{
                  left: `${thumbPosition}px`,
                  width: `${thumbWidth}px`,
                }}
                onMouseDown={handleThumbMouseDown}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
