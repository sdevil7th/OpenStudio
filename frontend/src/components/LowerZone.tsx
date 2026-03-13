import React, { useCallback, useRef } from "react";
import { X, GripHorizontal } from "lucide-react";

interface LowerZoneProps {
  title: string;
  height: number;
  onHeightChange: (h: number) => void;
  onClose: () => void;
  toolbar?: React.ReactNode;
  statusBar?: React.ReactNode;
  children: React.ReactNode;
}

export function LowerZone({
  title,
  height,
  onHeightChange,
  onClose,
  toolbar,
  statusBar,
  children,
}: LowerZoneProps) {
  const isDragging = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      const startY = e.clientY;
      const startHeight = height;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (me: MouseEvent) => {
        // Dragging up = larger panel (negative delta = increase height)
        const delta = startY - me.clientY;
        onHeightChange(startHeight + delta);
      };
      const onUp = () => {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [height, onHeightChange]
  );

  return (
    <div
      className="flex flex-col border-t border-daw-border bg-daw-panel shrink-0"
      style={{ height }}
    >
      {/* Resize handle */}
      <div
        className="h-1.5 cursor-row-resize group flex items-center justify-center shrink-0 hover:bg-daw-accent/20 active:bg-daw-accent/40 transition-colors"
        onMouseDown={handleResizeStart}
        title="Drag to resize"
      >
        <GripHorizontal size={12} className="text-neutral-600 group-hover:text-neutral-400" />
      </div>

      {/* Header bar */}
      <div className="flex items-center h-7 px-2 bg-neutral-800/80 border-b border-daw-border shrink-0 gap-2">
        <span className="text-[11px] font-medium text-neutral-300 shrink-0">{title}</span>
        {toolbar && <div className="flex-1 flex items-center gap-1 ml-2 overflow-x-auto">{toolbar}</div>}
        <button
          onClick={onClose}
          className="ml-auto p-0.5 rounded hover:bg-neutral-700 text-neutral-500 hover:text-neutral-300 transition-colors shrink-0"
          title="Close (Escape)"
        >
          <X size={14} />
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>

      {/* Status bar */}
      {statusBar && (
        <div className="h-5 px-2 flex items-center bg-neutral-800/60 border-t border-daw-border shrink-0 text-[10px] text-neutral-500 gap-3">
          {statusBar}
        </div>
      )}
    </div>
  );
}
