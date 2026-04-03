import React, { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Line, Text } from "react-konva";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { MemoizedPlayhead as Playhead } from "./Playhead";
import { snapToGrid } from "../utils/snapToGrid";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KonvaEvent = any;

export const TIMELINE_RULER_HEIGHT = 30;

const RANGE_HANDLE_HIT_PX = 8;
const DRAG_THRESHOLD_PX = 4;

export function TimelineRuler() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const rulerDragRef = useRef<{
    type: "handle" | "range-create" | "pending";
    handle?: "start" | "end";
    startX: number;
    startTime: number;
  } | null>(null);
  const [, setRulerDragging] = useState(false);

  const {
    pixelsPerSecond,
    scrollX,
    seekTo,
    markers,
    snapEnabled,
    gridSize,
    timeSignature,
    projectRange,
    setProjectRange,
    setTimeSelection,
  } = useDAWStore(
    useShallow((state) => ({
      pixelsPerSecond: state.pixelsPerSecond,
      scrollX: state.scrollX,
      seekTo: state.seekTo,
      markers: state.markers,
      snapEnabled: state.snapEnabled,
      gridSize: state.gridSize,
      timeSignature: state.timeSignature,
      projectRange: state.projectRange,
      setProjectRange: state.setProjectRange,
      setTimeSelection: state.setTimeSelection,
    })),
  );
  const tempo = useDAWStore((state) => state.transport.tempo);

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

  const handleRulerMouseDown = (e: KonvaEvent) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
    if (!pointerPos) return;

    const clickedTime = Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond);

    const startX = projectRange.start * pixelsPerSecond - scrollX;
    const endX = projectRange.end * pixelsPerSecond - scrollX;

    if (Math.abs(pointerPos.x - endX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = {
        type: "handle",
        handle: "end",
        startX: pointerPos.x,
        startTime: clickedTime,
      };
      setRulerDragging(true);
      return;
    }
    if (Math.abs(pointerPos.x - startX) < RANGE_HANDLE_HIT_PX) {
      rulerDragRef.current = {
        type: "handle",
        handle: "start",
        startX: pointerPos.x,
        startTime: clickedTime,
      };
      setRulerDragging(true);
      return;
    }

    if (e.evt?.shiftKey) {
      const currentSel = useDAWStore.getState().timeSelection;
      if (currentSel) {
        const distToStart = Math.abs(clickedTime - currentSel.start);
        const distToEnd = Math.abs(clickedTime - currentSel.end);
        if (distToStart < distToEnd) {
          setTimeSelection(Math.min(clickedTime, currentSel.end), currentSel.end);
        } else {
          setTimeSelection(currentSel.start, Math.max(clickedTime, currentSel.start));
        }
      } else {
        const playheadTime = useDAWStore.getState().transport.currentTime;
        setTimeSelection(
          Math.min(playheadTime, clickedTime),
          Math.max(playheadTime, clickedTime),
        );
      }
      return;
    }

    rulerDragRef.current = {
      type: "pending",
      startX: pointerPos.x,
      startTime: clickedTime,
    };
  };

  const handleRulerDblClick = (e: KonvaEvent) => {
    const stage = e.target.getStage();
    const pointerPos = stage.getPointerPosition();
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

      if (drag.type === "handle") {
        if (drag.handle === "start") {
          setProjectRange(Math.min(time, range.end), range.end);
        } else {
          setProjectRange(range.start, Math.max(time, range.start));
        }
        setRulerDragging(true);
      } else if (drag.type === "pending") {
        if (Math.abs(pointerX - drag.startX) > DRAG_THRESHOLD_PX) {
          drag.type = "range-create";
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
          setProjectRange(Math.min(startTime, time), Math.max(startTime, time));
          setRulerDragging(true);
        }
      } else if (drag.type === "range-create") {
        setProjectRange(
          Math.min(drag.startTime, time),
          Math.max(drag.startTime, time),
        );
      }
    };

    const handleGlobalMouseUp = () => {
      const drag = rulerDragRef.current;
      if (!drag) return;

      if (drag.type === "pending") {
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
      if (barX < -60 || barX > width + 60) continue;

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

      if (rulerDensity.mode === "bar") continue;

      for (let beat = 1; beat < beatsPerBar; beat += 1) {
        const beatTime = barTime + beat * secondsPerBeat;
        const beatX = beatTime * pixelsPerSecond - scrollX;
        if (beatX < -20 || beatX > width + 20) continue;

        marks.push(
          <Line
            key={`beat-line-${bar}-${beat}`}
            points={[beatX, 18, beatX, TIMELINE_RULER_HEIGHT]}
            stroke="#444"
            strokeWidth={0.5}
          />,
        );

        if (rulerDensity.mode === "beat" && beatX >= 0 && beatX <= width) {
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
