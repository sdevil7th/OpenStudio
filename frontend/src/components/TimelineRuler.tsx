import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Line, Text } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { MemoizedPlayhead as Playhead } from "./Playhead";
import { snapToGrid } from "../utils/snapToGrid";
import { getRulerClickSnapTime } from "../utils/rulerClickSnap";
import { getRulerDragZoom, resolveRulerDragAxis } from "../utils/timelineRulerDrag";
import type { TimelineDragAxisLock } from "../utils/timelineDragAxisLock";
import { getMouseBehaviorProfile, toMouseBehaviorPlatform } from "../utils/mouseBehaviorProfiles";
import { getShortcutPlatform } from "../utils/platform";
import { resolveWheelGesture } from "../utils/wheelGestureResolver";
import { getTimelineHorizontalScrollMax } from "../utils/contextWheelBehaviors";
import { resolveMouseModifierAction, type MouseModifierActionFor, type MouseModifierOverrideMap, type PointerModifierEventLike } from "../utils/mouseModifierResolver";

export const TIMELINE_RULER_HEIGHT = 30;

const RANGE_HANDLE_HIT_PX = 8;
const RANGE_HANDLE_VISUAL_HEIGHT_PX = 8;
const DRAG_THRESHOLD_PX = 4;

export function TimelineRuler() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const rulerDragRef = useRef<{
    type: "handle-pending" | "handle-drag" | "range-create" | "time-select" | "zoom-create" | "pending" | "vertical-zoom";
    action: MouseModifierActionFor<"ruler_click">;
    handle?: "start" | "end";
    startX: number;
    startTime: number;
    currentTime?: number;
    zoom?: {
      startY: number;
      initialZoom: number;
      anchorTime: number;
      axisLock: TimelineDragAxisLock | null;
    };
  } | null>(null);
  const [, setRulerDragging] = useState(false);
  const [zoomSelection, setZoomSelection] = useState<{ x: number; width: number } | null>(null);

  const {
    pixelsPerSecond,
    scrollX,
    setScroll,
    trackHeight,
    setTrackHeight,
    seekTo,
    markers,
    snapEnabled,
    gridSize,
    timeSignature,
    projectRange,
    setProjectRange,
    setTimeSelection,
    tempo,
  } = useDAWStore(
    useShallow((state) => ({
      pixelsPerSecond: state.pixelsPerSecond,
      scrollX: state.scrollX,
      setScroll: state.setScroll,
      trackHeight: state.trackHeight,
      setTrackHeight: state.setTrackHeight,
      seekTo: state.seekTo,
      markers: state.markers,
      snapEnabled: state.snapEnabled,
      gridSize: state.gridSize,
      timeSignature: state.timeSignature,
      projectRange: state.projectRange,
      setProjectRange: state.setProjectRange,
      setTimeSelection: state.setTimeSelection,
      tempo: state.transport.tempo,
    })),
  );

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
  const scrollXRef = useRef(scrollX);
  scrollXRef.current = scrollX;
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;
  const trackHeightRef = useRef(trackHeight);
  trackHeightRef.current = trackHeight;
  const widthRef = useRef(width);
  widthRef.current = width;

  // Publish the anchored transform together, at most once per animation frame.
  // Store subscribers (including the playhead) must never see the new zoom
  // paired with the previous scroll position.
  const pendingZoomRef = useRef<{ pixelsPerSecond: number; scrollX: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const ownsRulerZoomRef = useRef(false);
  const finishRulerZoom = useCallback(() => {
    if (!ownsRulerZoomRef.current) return;
    ownsRulerZoomRef.current = false;
    useDAWStore.setState({ isTimelineRulerZooming: false });
  }, []);
  const flushZoom = useCallback(() => {
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = null;
    const pending = pendingZoomRef.current;
    pendingZoomRef.current = null;
    if (pending) {
      const nextZoom = Math.max(1, Math.min(1000, pending.pixelsPerSecond));
      const nextScrollX = Math.max(0, pending.scrollX);
      pixelsPerSecondRef.current = nextZoom;
      scrollXRef.current = nextScrollX;
      useDAWStore.setState({ pixelsPerSecond: nextZoom, scrollX: nextScrollX });
    }
  }, []);
  const scheduleZoom = useCallback((view: { pixelsPerSecond: number; scrollX: number }) => {
    pendingZoomRef.current = view;
    if (zoomFrameRef.current === null) zoomFrameRef.current = requestAnimationFrame(flushZoom);
  }, [flushZoom]);

  useEffect(() => () => {
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = null;
    pendingZoomRef.current = null;
    finishRulerZoom();
  }, [finishRulerZoom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      const nextWidth = Math.max(100, Math.floor(container.clientWidth));
      setWidth((prev) => (prev === nextWidth ? prev : nextWidth));
    };

    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);
    window.addEventListener("resize", updateWidth);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      const shortcutPlatform = getShortcutPlatform();
      const behaviorProfile = getMouseBehaviorProfile(
        useDAWStore.getState().mouseBehaviorProfileId,
        shortcutPlatform,
      );
      const gesture = resolveWheelGesture(event, {
        surface: "timeline",
        subtarget: "ruler",
        platform: toMouseBehaviorPlatform(shortcutPlatform),
      }, behaviorProfile.wheel);
      if (gesture.preventDefault) event.preventDefault();
      if (gesture.stopPropagation) event.stopPropagation();

      if (gesture.target === "waveform-amplitude" && gesture.amount !== 0) {
        const state = useDAWStore.getState();
        const selectedIds = state.selectedTrackIds.length > 0
          ? state.selectedTrackIds
          : state.selectedTrackId ? [state.selectedTrackId] : [];
        const factor = gesture.amount > 0 ? 0.9 : 1.1;
        for (const trackId of selectedIds) {
          const track = state.tracks.find((candidate) => candidate.id === trackId);
          if (track) state.setTrackWaveformZoom(trackId, (track.waveformZoom ?? 1) * factor);
        }
      } else if (gesture.operation === "zoom" && gesture.target === "timeline") {
        const rect = container.getBoundingClientRect();
        const pointerX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        const state = useDAWStore.getState();
        const currentZoom = pendingZoomRef.current?.pixelsPerSecond ?? state.pixelsPerSecond;
        const currentScrollX = pendingZoomRef.current?.scrollX ?? state.scrollX;
        const timeAtPointer = (currentScrollX + pointerX) / currentZoom;
        const nextZoom = Math.max(1, Math.min(1000, currentZoom * Math.exp(-gesture.amount * 0.0015)));
        const maxTimelineScroll = getTimelineHorizontalScrollMax(
          state.tracks,
          state.recordingClips.length > 0 ? state.transport.currentTime : undefined,
          nextZoom,
          widthRef.current,
        );
        scheduleZoom({
          pixelsPerSecond: nextZoom,
          scrollX: Math.max(0, Math.min(maxTimelineScroll, timeAtPointer * nextZoom - pointerX)),
        });
      } else if (gesture.operation === "resize" && gesture.target === "track-height") {
        const factor = gesture.amount > 0 ? 0.9 : 1.1;
        if (gesture.amount !== 0) setTrackHeight(trackHeightRef.current * factor);
      } else if (gesture.operation === "scroll" && gesture.axis === "horizontal") {
        // Preserve input order if a modifier changes before the queued zoom RAF.
        flushZoom();
        const workspace = container.closest<HTMLElement>(".workspace");
        if (gesture.ruleId === "trackpad.pan" && workspace) workspace.scrollTop += gesture.delta.y;
        const state = useDAWStore.getState();
        const maxTimelineScroll = getTimelineHorizontalScrollMax(
          state.tracks,
          state.recordingClips.length > 0 ? state.transport.currentTime : undefined,
          state.pixelsPerSecond,
          widthRef.current,
        );
        setScroll(
          Math.max(0, Math.min(maxTimelineScroll, state.scrollX + gesture.amount)),
          workspace?.scrollTop ?? state.scrollY,
        );
      } else if (gesture.operation === "scroll") {
        flushZoom();
        const workspace = container.closest(".workspace") as HTMLElement | null;
        if (workspace) {
          const maxScrollY = Math.max(0, workspace.scrollHeight - workspace.clientHeight);
          const nextScrollY = Math.max(0, Math.min(maxScrollY, workspace.scrollTop + gesture.amount));
          workspace.scrollTop = nextScrollY;
          setScroll(useDAWStore.getState().scrollX, nextScrollY);
        }
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [flushZoom, scheduleZoom, setScroll, setTrackHeight]);

  const resolveRulerAction = (event: PointerModifierEventLike) => {
    const state = useDAWStore.getState();
    const platform = getShortcutPlatform();
    return resolveMouseModifierAction(event, "ruler_click", {
      platform: toMouseBehaviorPlatform(platform),
      profile: getMouseBehaviorProfile(state.mouseBehaviorProfileId, platform).modifiers,
      overrides: state.mouseModifiers as MouseModifierOverrideMap,
    });
  };

  const handleRulerMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return;
    const action = resolveRulerAction(e.evt);
    if (action === "none") {
      rulerDragRef.current = null;
      return;
    }
    const stage = e.target.getStage();
    const pointerPos = stage?.getPointerPosition();
    if (!pointerPos) return;

    flushZoom();
    const view = useDAWStore.getState();
    const rawClickedTime = Math.max(0, (pointerPos.x + view.scrollX) / view.pixelsPerSecond);
    const clickedTime = getRulerClickSnapTime({
      time: rawClickedTime,
      pixelsPerSecond: pixelsPerSecondRef.current,
      tempo: tempoRef.current,
      timeSignature: timeSignatureRef.current,
      gridSize: gridSizeRef.current,
      snapEnabled: snapEnabledRef.current,
      ctrlBypass: false,
    });

    const startX = projectRange.start * view.pixelsPerSecond - view.scrollX;
    const endX = projectRange.end * view.pixelsPerSecond - view.scrollX;
    const inHandleZone = pointerPos.y <= RANGE_HANDLE_VISUAL_HEIGHT_PX;

    if (action === "seek" && inHandleZone && Math.abs(pointerPos.x - endX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = {
        type: "handle-pending",
        action,
        handle: "end",
        startX: pointerPos.x,
        startTime: clickedTime,
      };
      setRulerDragging(true);
      return;
    }
    if (action === "seek" && inHandleZone && Math.abs(pointerPos.x - startX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = {
        type: "handle-pending",
        action,
        handle: "start",
        startX: pointerPos.x,
        startTime: clickedTime,
      };
      setRulerDragging(true);
      return;
    }

    if (action === "time_select") {
      const currentSel = useDAWStore.getState().timeSelection;
      let anchor = useDAWStore.getState().transport.currentTime;
      if (currentSel) {
        const distToStart = Math.abs(clickedTime - currentSel.start);
        const distToEnd = Math.abs(clickedTime - currentSel.end);
        anchor = distToStart < distToEnd ? currentSel.end : currentSel.start;
      }
      setTimeSelection(Math.min(anchor, clickedTime), Math.max(anchor, clickedTime));
      rulerDragRef.current = { type: "pending", action, startX: pointerPos.x, startTime: anchor, currentTime: clickedTime };
      return;
    }

    rulerDragRef.current = {
      type: "pending",
      action,
      startX: pointerPos.x,
      startTime: clickedTime,
      zoom: action === "seek" ? {
        startY: pointerPos.y,
        initialZoom: view.pixelsPerSecond,
        anchorTime: rawClickedTime,
        axisLock: null,
      } : undefined,
    };
    if (action === "seek") {
      // Protect the pressed time before movement chooses an axis. Otherwise a
      // queued follow frame can move the view before vertical zoom takes over.
      ownsRulerZoomRef.current = true;
      useDAWStore.setState({ isTimelineRulerZooming: true });
    }
  };

  const handleRulerDblClick = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0 || resolveRulerAction(e.evt) === "none") return;
    const stage = e.target.getStage();
    const pointerPos = stage?.getPointerPosition();
    if (!pointerPos) return;

    const clickedTime = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);
    if (!markers || markers.length === 0) return;

    const sortedTimes = markers.map((marker) => marker.time).sort((a, b) => a - b);

    let leftBound = 0;
    for (let i = sortedTimes.length - 1; i >= 0; i -= 1) {
      if (sortedTimes[i] <= clickedTime) {
        leftBound = sortedTimes[i];
        break;
      }
    }

    let rightBound = leftBound;
    for (let i = 0; i < sortedTimes.length; i += 1) {
      if (sortedTimes[i] > clickedTime) {
        rightBound = sortedTimes[i];
        break;
      }
    }

    if (rightBound > leftBound) {
      setTimeSelection(leftBound, rightBound);
    }
  };

  useEffect(() => {
    const getRulerCanvas = () =>
      containerRef.current?.querySelector("canvas") as HTMLCanvasElement | null;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const drag = rulerDragRef.current;
      if (!drag) return;

      const canvas = getRulerCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      if (drag.zoom && (drag.type === "pending" || drag.type === "vertical-zoom")) {
        const deltaY = e.clientY - rect.top - drag.zoom.startY;
        drag.zoom.axisLock = resolveRulerDragAxis(drag.zoom.axisLock, pointerX - drag.startX, deltaY);
        if (!drag.zoom.axisLock) return;
        if (drag.zoom.axisLock === "y") {
          drag.type = "vertical-zoom";
          if (!ownsRulerZoomRef.current) {
            ownsRulerZoomRef.current = true;
            useDAWStore.setState({ isTimelineRulerZooming: true });
          }
          const view = getRulerDragZoom(drag.zoom.initialZoom, deltaY, drag.zoom.anchorTime, drag.startX);
          scheduleZoom(view);
          return;
        }
        finishRulerZoom(); // Horizontal intent no longer owns zoom suppression.
      }
      const curScrollX = scrollXRef.current;
      const curPPS = pixelsPerSecondRef.current;
      let time = Math.max(0, (pointerX + curScrollX) / curPPS);
      const range = projectRangeRef.current;

      if (snapEnabledRef.current) {
        time = snapToGrid(
          time,
          tempoRef.current,
          timeSignatureRef.current,
          gridSizeRef.current,
        );
      }
      drag.currentTime = time;

      if (drag.type === "handle-pending") {
        if (Math.abs(pointerX - drag.startX) <= DRAG_THRESHOLD_PX) {
          return;
        }
        drag.type = "handle-drag";
      }

      if (drag.type === "handle-drag") {
        if (drag.handle === "start") {
          setProjectRange(Math.min(time, range.end), range.end);
        } else {
          setProjectRange(range.start, Math.max(time, range.start));
        }
        setRulerDragging(true);
      } else if (drag.type === "pending") {
        if (Math.abs(pointerX - drag.startX) > DRAG_THRESHOLD_PX) {
          drag.type = drag.action === "time_select" ? "time-select"
            : drag.action === "zoom_to" ? "zoom-create" : "range-create";
          let startTime = drag.startTime;
          if (snapEnabledRef.current) {
            startTime = snapToGrid(
              startTime,
              tempoRef.current,
              timeSignatureRef.current,
              gridSizeRef.current,
            );
            drag.startTime = startTime;
          }
          if (drag.type === "time-select") setTimeSelection(Math.min(startTime, time), Math.max(startTime, time));
          else if (drag.type === "zoom-create") setZoomSelection({ x: Math.min(drag.startX, pointerX), width: Math.abs(pointerX - drag.startX) });
          else setProjectRange(Math.min(startTime, time), Math.max(startTime, time));
          setRulerDragging(true);
        }
      } else if (drag.type === "range-create") {
        setProjectRange(
          Math.min(drag.startTime, time),
          Math.max(drag.startTime, time),
        );
      } else if (drag.type === "time-select") {
        setTimeSelection(Math.min(drag.startTime, time), Math.max(drag.startTime, time));
      } else if (drag.type === "zoom-create") {
        setZoomSelection({ x: Math.min(drag.startX, pointerX), width: Math.abs(pointerX - drag.startX) });
      }
    };

    const handleGlobalMouseUp = () => {
      const drag = rulerDragRef.current;
      if (!drag) return;
      flushZoom();

      if (drag.type === "pending" && drag.action === "seek") {
        seekTo(drag.startTime);
      } else if (drag.type === "handle-pending") {
        seekTo(drag.startTime);
      } else if (drag.type === "range-create" && drag.action === "loop_set") {
        const state = useDAWStore.getState();
        if (!state.transport.loopEnabled) state.toggleLoop();
      } else if (drag.type === "zoom-create") {
        const endTime = drag.currentTime ?? drag.startTime;
        const duration = Math.abs(endTime - drag.startTime);
        if (duration > 0.01) {
          const nextZoom = Math.max(1, Math.min(1000, widthRef.current / duration));
          scheduleZoom({ pixelsPerSecond: nextZoom, scrollX: Math.min(drag.startTime, endTime) * nextZoom });
          flushZoom();
        }
      }

      rulerDragRef.current = null;
      finishRulerZoom();
      setZoomSelection(null);
      setRulerDragging(false);
    };

    const cancelRulerDrag = () => {
      flushZoom();
      rulerDragRef.current = null;
      finishRulerZoom();
      setZoomSelection(null);
      setRulerDragging(false);
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    window.addEventListener("blur", cancelRulerDrag);
    window.addEventListener("pointercancel", cancelRulerDrag);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
      window.removeEventListener("blur", cancelRulerDrag);
      window.removeEventListener("pointercancel", cancelRulerDrag);
    };
  }, [finishRulerZoom, flushZoom, scheduleZoom, seekTo, setProjectRange, setTimeSelection]);

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

  const rulerMarks = useMemo(() => {
    const marks: React.ReactNode[] = [];
    const beatsPerBar = timeSignature.numerator;
    const secondsPerBeat = 60 / tempo;
    const secondsPerBar = secondsPerBeat * beatsPerBar;
    const startTime = Math.max(0, scrollX / pixelsPerSecond - secondsPerBar);
    const endTime = (scrollX + width) / pixelsPerSecond + secondsPerBar;
    const startBar = Math.floor(startTime / secondsPerBar);
    const endBar = Math.ceil(endTime / secondsPerBar);

    for (let bar = startBar; bar <= endBar; bar += 1) {
      const barTime = bar * secondsPerBar;
      const barX = barTime * pixelsPerSecond - scrollX;
      // A bar starting offscreen can still contain visible beats.
      if (barX >= -60 && barX <= width + 60) {
        const showBarLabel = bar >= 0 && bar % rulerDensity.labelEveryBars === 0;
        marks.push(
          <Line
            key={`bar-line-${bar}`}
            points={[barX, showBarLabel ? 0 : 12, barX, TIMELINE_RULER_HEIGHT]}
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
      }

      if (rulerDensity.mode === "bar") continue;

      for (let beat = 0; beat < beatsPerBar; beat += 1) {
        const beatTime = barTime + beat * secondsPerBeat;
        const beatX = beatTime * pixelsPerSecond - scrollX;
        // Cull the beat independently of its subdivisions.
        if (beat > 0 && beatX >= -20 && beatX <= width + 20) {
          marks.push(
            <Line
              key={`beat-line-${bar}-${beat}`}
              points={[beatX, 18, beatX, TIMELINE_RULER_HEIGHT]}
              stroke="#444"
              strokeWidth={0.5}
            />,
          );

          if ((rulerDensity.mode === "beat" || rulerDensity.mode === "division") && beatX >= 0 && beatX <= width) {
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
        }

        if (rulerDensity.mode !== "division") continue;

        for (let division = 1; division < rulerDensity.divisionsPerBeat; division += 1) {
          const divisionTime =
            beatTime + (secondsPerBeat * division) / rulerDensity.divisionsPerBeat;
          const divisionX = divisionTime * pixelsPerSecond - scrollX;
          if (divisionX < -10 || divisionX > width + 10) continue;

          marks.push(
            <Line
              key={`division-line-${bar}-${beat}-${division}`}
              points={[divisionX, 22, divisionX, TIMELINE_RULER_HEIGHT]}
              stroke="#333"
              strokeWidth={0.5}
            />,
          );

          if (divisionX >= 0 && divisionX <= width) {
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
    pixelsPerSecond,
    rulerDensity,
    scrollX,
    tempo,
    timeSignature.numerator,
    width,
  ]);


  const devicePixelRatio =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const rStartX = projectRange.start * pixelsPerSecond - scrollX;
  const rEndX = projectRange.end * pixelsPerSecond - scrollX;
  const hasRange = projectRange.end > projectRange.start;

  return (
    <div ref={containerRef} className="workspace-sticky-ruler">
      <Stage
        width={width}
        height={TIMELINE_RULER_HEIGHT}
        pixelRatio={devicePixelRatio}
        onMouseDown={handleRulerMouseDown}
        onDblClick={handleRulerDblClick}
      >
        <Layer>
          <Rect
            x={0}
            y={0}
            width={width}
            height={TIMELINE_RULER_HEIGHT}
            fill="#0a0a0a"
          />
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
          <Line
            points={[rStartX - 5, 0, rStartX + 5, 0, rStartX, 8]}
            fill="#f59e0b"
            closed
            stroke="#b45309"
            strokeWidth={0.5}
            listening={false}
          />
          <Line
            points={[rEndX - 5, 0, rEndX + 5, 0, rEndX, 8]}
            fill={hasRange ? "#f59e0b" : "#f59e0b80"}
            closed
            stroke="#b45309"
            strokeWidth={0.5}
            listening={false}
          />
          {rulerMarks}
          {zoomSelection && <Rect x={zoomSelection.x} y={0} width={zoomSelection.width} height={TIMELINE_RULER_HEIGHT} fill="#0078d4" opacity={0.3} listening={false} />}
          <Playhead
            type="ruler"
            pixelsPerSecond={pixelsPerSecond}
            scrollX={scrollX}
            stageHeight={0}
            viewportWidth={width}
            rulerHeight={TIMELINE_RULER_HEIGHT}
          />
        </Layer>
      </Stage>
    </div>
  );
}
