import React, { useRef, useEffect } from "react";
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
  scrollX,
  stageHeight,
  viewportWidth,
  type,
  rulerHeight = 30,
}: PlayheadProps) {
  const lineRef = useRef<Konva.Line>(null);
  const rectRef = useRef<Konva.Rect>(null);

  // Subscribe to both currentTime AND scrollX from store for perfect sync
  // This ensures both ruler and main playhead update atomically when auto-scroll happens
  useEffect(() => {
    let prevTime = useDAWStore.getState().transport.currentTime;
    let prevScrollX = useDAWStore.getState().scrollX;

    const unsubscribe = useDAWStore.subscribe((state) => {
      const time = state.transport.currentTime;
      const storeScrollX = state.scrollX;

      // Only update if time or scrollX changed
      if (time === prevTime && storeScrollX === prevScrollX) return;
      prevTime = time;
      prevScrollX = storeScrollX;

      // Use scrollX from store for perfect sync during auto-scroll
      const x = time * pixelsPerSecond - storeScrollX;
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
    });

    return () => unsubscribe();
  }, [pixelsPerSecond, stageHeight, viewportWidth, type]);

  // Get initial position - use store scrollX for consistency
  const initialState = useDAWStore.getState();
  const initialTime = initialState.transport.currentTime;
  const initialScrollX = initialState.scrollX;
  const initialX = initialTime * pixelsPerSecond - initialScrollX;
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
