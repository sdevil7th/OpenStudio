import React, { useRef, useEffect, useCallback, useState } from "react";
import type { ScrollbarOverview } from "../utils/scrollbarOverview";

interface HorizontalScrollbarProps {
  viewportWidth: number;
  totalWidth: number;
  scrollX: number;
  scrollY: number;
  onScroll: (scrollX: number, scrollY: number) => void;
  height?: number;
  overview?: ScrollbarOverview;
}

export function HorizontalScrollbar({
  viewportWidth,
  totalWidth,
  scrollX,
  scrollY,
  onScroll,
  height = 16,
  overview,
}: HorizontalScrollbarProps) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDraggingRef = useRef(false);
  const [trackWidth, setTrackWidth] = useState(viewportWidth);

  const maxScroll = Math.max(0, totalWidth - viewportWidth);

  // Measure track width from the DOM — no magic-number padding offsets.
  const getTrackWidth = useCallback(() => {
    return trackRef.current?.clientWidth ?? viewportWidth;
  }, [viewportWidth]);

  const getThumbWidth = useCallback(() => {
    const tw = getTrackWidth();
    const ratio = Math.min(1, viewportWidth / Math.max(1, totalWidth));
    return Math.max(30, tw * ratio);
  }, [getTrackWidth, viewportWidth, totalWidth]);

  // Compute thumb left from a given scrollX value.
  const thumbLeft = useCallback(
    (sx: number) => {
      if (maxScroll <= 0) return 0;
      const tw = getTrackWidth();
      const th = getThumbWidth();
      const scrollable = tw - th;
      if (scrollable <= 0) return 0;
      return Math.max(0, Math.min(scrollable, (sx / maxScroll) * scrollable));
    },
    [maxScroll, getTrackWidth, getThumbWidth],
  );

  // Keep thumb in sync with scrollX prop when NOT dragging (e.g. auto-scroll,
  // keyboard scroll, programmatic scroll).
  useEffect(() => {
    if (!isDraggingRef.current && thumbRef.current) {
      thumbRef.current.style.left = `${thumbLeft(scrollX)}px`;
    }
  }, [scrollX, thumbLeft]);

  useEffect(() => {
    if (!trackRef.current) return;

    const element = trackRef.current;
    const syncSize = () => {
      setTrackWidth(element.clientWidth || viewportWidth);
    };

    syncSize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncSize);
      return () => window.removeEventListener("resize", syncSize);
    }

    const observer = new ResizeObserver(syncSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewportWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overview || trackWidth <= 0) return;

    const devicePixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(trackWidth));
    const drawHeight = Math.max(8, overview ? height - 6 : 12);
    const visualHeight = Math.max(1, Math.floor(drawHeight));

    canvas.width = Math.floor(width * devicePixelRatio);
    canvas.height = Math.floor(visualHeight * devicePixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${visualHeight}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, width, visualHeight);

    const centerY = visualHeight * 0.42;
    const audioMaxHalfHeight = Math.max(2, visualHeight * 0.34);
    const midiBandHeight = Math.max(1.5, visualHeight * 0.16);
    const midiBaseY = visualHeight * 0.78;

    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const startRatio = pixelX / width;
      const endRatio = (pixelX + 1) / width;
      const startIndex = Math.max(
        0,
        Math.floor(startRatio * overview.bins.length),
      );
      const endIndex = Math.min(
        overview.bins.length - 1,
        Math.max(startIndex, Math.ceil(endRatio * overview.bins.length) - 1),
      );

      let audioLevel = 0;
      let midiLevel = 0;
      for (let index = startIndex; index <= endIndex; index += 1) {
        audioLevel = Math.max(audioLevel, overview.bins[index].audio);
        midiLevel = Math.max(midiLevel, overview.bins[index].midi);
      }

      if (audioLevel > 0.001) {
        const halfHeight = Math.max(1, audioLevel * audioMaxHalfHeight);
        const gradient = context.createLinearGradient(0, centerY - halfHeight, 0, centerY + halfHeight);
        gradient.addColorStop(0, "rgba(226, 232, 240, 0.08)");
        gradient.addColorStop(0.5, "rgba(148, 163, 184, 0.28)");
        gradient.addColorStop(1, "rgba(226, 232, 240, 0.08)");
        context.fillStyle = gradient;
        context.fillRect(
          pixelX,
          centerY - halfHeight,
          1,
          halfHeight * 2,
        );
      }

      if (midiLevel > 0.001) {
        context.fillStyle = "rgba(94, 234, 212, 0.22)";
        context.fillRect(
          pixelX,
          midiBaseY - midiLevel * midiBandHeight,
          1,
          Math.max(1, midiLevel * midiBandHeight),
        );
      }
    }

    context.strokeStyle = "rgba(255, 255, 255, 0.05)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, centerY + 0.5);
    context.lineTo(width, centerY + 0.5);
    context.stroke();
  }, [height, overview, trackWidth]);

  // --- Track click: jump scroll to click position ---
  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const tw = trackRef.current.clientWidth;
      if (tw <= 0) return;
      // Center the thumb at click position
      const th = getThumbWidth();
      const scrollable = tw - th;
      if (scrollable <= 0) return;
      const targetLeft = clickX - th / 2;
      const ratio = Math.max(0, Math.min(1, targetLeft / scrollable));
      onScroll(ratio * maxScroll, scrollY);
    },
    [getThumbWidth, maxScroll, scrollY, onScroll],
  );

  // --- Thumb drag ---
  const handleThumbMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingRef.current = true;

      const startMouseX = e.clientX;
      const startScrollX = scrollX;
      const tw = getTrackWidth();
      const th = getThumbWidth();
      const scrollable = tw - th;

      let rafId: number | null = null;
      let pendingScrollX = startScrollX;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (scrollable <= 0) return;
        const deltaX = moveEvent.clientX - startMouseX;
        const deltaScroll = (deltaX / scrollable) * maxScroll;
        pendingScrollX = Math.max(
          0,
          Math.min(maxScroll, startScrollX + deltaScroll),
        );

        // Direct DOM update — thumb follows cursor instantly, no render wait.
        if (thumbRef.current) {
          thumbRef.current.style.left = `${thumbLeft(pendingScrollX)}px`;
        }

        // Batch store update via RAF so Timeline/Playhead stay in sync.
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            onScroll(pendingScrollX, scrollY);
            rafId = null;
          });
        }
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        // Final store update with the last position
        onScroll(pendingScrollX, scrollY);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [scrollX, scrollY, maxScroll, getTrackWidth, getThumbWidth, thumbLeft, onScroll],
  );

  // Hide when content fits in viewport
  if (totalWidth <= viewportWidth) return null;

  const trackHeight = overview
    ? Math.max(12, height - 6)
    : Math.min(12, Math.max(6, height - 6));

  return (
    <div
      className="sticky bottom-0 left-0 bg-neutral-800 flex items-center cursor-pointer z-20 shrink-0"
      style={{ height }}
      onClick={handleTrackClick}
    >
      <div
        ref={trackRef}
        className="relative w-full mx-1 bg-neutral-700 rounded overflow-hidden"
        style={{ height: trackHeight }}
      >
        {overview && (
          <canvas
            ref={canvasRef}
            className="absolute inset-0 pointer-events-none"
            aria-hidden="true"
          />
        )}
        <div
          ref={thumbRef}
          className="absolute top-0 rounded cursor-grab active:cursor-grabbing transition-colors border border-white/10"
          style={{
            left: `${thumbLeft(scrollX)}px`,
            width: `${getThumbWidth()}px`,
            height: trackHeight,
            background: overview
              ? "rgba(115, 115, 115, 0.74)"
              : "rgb(115 115 115)",
            boxShadow: overview
              ? "inset 0 0 0 1px rgba(255,255,255,0.06)"
              : undefined,
          }}
          onMouseDown={handleThumbMouseDown}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}
