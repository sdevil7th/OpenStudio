import React, { useRef, useLayoutEffect } from "react";
import { Line, Rect } from "react-konva";
import Konva from "konva";
import { useDAWStore } from "../store/useDAWStore";

interface PlayheadProps {
  pixelsPerSecond: number;
  scrollX: number;
  stageHeight: number;
  viewportWidth: number;
  type: "main" | "ruler";
  rulerHeight?: number;
}

/**
 * Lightweight Playhead component that subscribes to currentTime.
 * Separated from Timeline to prevent entire Timeline from re-rendering 60fps.
 * Uses Konva refs for direct DOM manipulation when possible.
 */
export function Playhead({
  pixelsPerSecond,
  scrollX: _scrollX,
  stageHeight,
  viewportWidth,
  type,
  rulerHeight = 30,
}: PlayheadProps) {
  const lineRef = useRef<Konva.Line>(null);
  const rectRef = useRef<Konva.Rect>(null);

  // Read the entire horizontal transform from one store snapshot. Zoom and
  // scroll writes can arrive before React commits new props during wheel zoom.
  useLayoutEffect(() => {
    const updatePosition = (state: ReturnType<typeof useDAWStore.getState>) => {
      const time = state.transport.currentTime;
      const storeScrollX = state.scrollX;
      const x = time * state.pixelsPerSecond - storeScrollX;
      const isVisible = x >= 0 && x <= viewportWidth;

      if (type === "main" && lineRef.current) {
        lineRef.current.visible(isVisible);
        if (isVisible) {
          lineRef.current.points([x, 0, x, stageHeight]);
        }
      }

      if (type === "ruler" && rectRef.current) {
        rectRef.current.visible(isVisible);
        if (isVisible) {
          rectRef.current.x(x - 6);
        }
      }
    };

    const unsubscribe = useDAWStore.subscribe((state, previous) => {
      if (
        state.transport.currentTime === previous.transport.currentTime
        && state.scrollX === previous.scrollX
        && state.pixelsPerSecond === previous.pixelsPerSecond
      ) return;
      updatePosition(state);
    });

    // Restore imperative Konva attributes after every geometry change, even
    // when JSX props compare equal and transport is stopped.
    updatePosition(useDAWStore.getState());

    return () => unsubscribe();
  }, [pixelsPerSecond, stageHeight, viewportWidth, type]);

  // Get initial position - use store scrollX for consistency
  const initialState = useDAWStore.getState();
  const initialTime = initialState.transport.currentTime;
  const initialScrollX = initialState.scrollX;
  const initialX = initialTime * initialState.pixelsPerSecond - initialScrollX;
  const initialVisible = initialX >= 0 && initialX <= viewportWidth;

  if (type === "main") {
    return (
      <Line
        ref={lineRef}
        points={[initialX, 0, initialX, stageHeight]}
        stroke="#4cc9f0"
        strokeWidth={1}
        visible={initialVisible}
        listening={false}
      />
    );
  }

  // Ruler type
  return (
    <Rect
      ref={rectRef}
      x={initialX - 6}
      y={0}
      width={12}
      height={rulerHeight}
      fill="#4cc9f0"
      opacity={0.3}
      visible={initialVisible}
      listening={false}
    />
  );
}

// Memoize to prevent unnecessary re-renders from parent
export const MemoizedPlayhead = React.memo(Playhead);
