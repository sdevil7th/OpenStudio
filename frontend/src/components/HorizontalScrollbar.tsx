import React from "react";

interface HorizontalScrollbarProps {
  viewportWidth: number;
  totalWidth: number;
  scrollX: number;
  scrollY: number;
  onScroll: (scrollX: number, scrollY: number) => void;
  setScroll: (scrollX: number, scrollY: number) => void;
}

export function HorizontalScrollbar({
  viewportWidth,
  totalWidth,
  scrollX,
  scrollY,
  onScroll,
  setScroll,
}: HorizontalScrollbarProps) {
  const trackWidth = viewportWidth - 16; // Account for padding
  const thumbWidthRatio = Math.min(1, viewportWidth / totalWidth);
  const thumbWidth = Math.max(30, trackWidth * thumbWidthRatio); // Min 30px thumb
  const maxScroll = Math.max(0, totalWidth - viewportWidth);
  const thumbPosition =
    maxScroll > 0 ? (scrollX / maxScroll) * (trackWidth - thumbWidth) : 0;

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left - 8; // Account for padding
    const clickRatio = clickX / trackWidth;
    const newScrollX = clickRatio * maxScroll;
    onScroll(Math.max(0, Math.min(maxScroll, newScrollX)), scrollY);
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
        Math.min(maxScroll, startScrollX + deltaScroll)
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
      className="sticky bottom-0 left-0 h-4 bg-neutral-800 flex items-center px-1 cursor-pointer z-20"
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
}
