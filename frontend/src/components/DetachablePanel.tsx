import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DetachablePanelProps {
  title: string;
  width?: number;
  height?: number;
  isDetached: boolean;
  onDetach: () => void;
  onAttach: () => void;
  children: React.ReactNode;
}

export function DetachablePanel({
  title,
  width = 800,
  height = 400,
  isDetached,
  onDetach: _onDetach,
  onAttach,
  children,
}: Readonly<DetachablePanelProps>) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Center the panel when detaching
  useEffect(() => {
    if (!isDetached) return;
    setPosition({
      x: Math.max(0, (window.innerWidth - width) / 2),
      y: Math.max(0, (window.innerHeight - height) / 2),
    });
  }, [isDetached, width, height]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    setPosition({
      x: Math.max(0, Math.min(e.clientX - dragOffset.current.x, window.innerWidth - width)),
      y: Math.max(0, Math.min(e.clientY - dragOffset.current.y, window.innerHeight - 32)),
    });
  }, [width]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const handleTitleBarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [position.x, position.y, handleMouseMove, handleMouseUp]);

  // Cleanup on unmount or detach=false while dragging
  useEffect(() => {
    if (isDetached) return;
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
    };
  }, [isDetached, handleMouseMove, handleMouseUp]);

  if (!isDetached) {
    return <>{children}</>;
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: position.y,
        left: position.x,
        width,
        height,
        zIndex: 9999,
        backgroundColor: "#1a1a1a",
        border: "1px solid #333",
        borderRadius: 6,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Drag handle / title bar */}
      <div
        onMouseDown={handleTitleBarMouseDown}
        style={{
          height: 32,
          flexShrink: 0,
          backgroundColor: "#252525",
          borderBottom: "1px solid #333",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px 0 12px",
          cursor: "grab",
          userSelect: "none",
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#ccc",
            pointerEvents: "none",
          }}
        >
          {title}
        </span>
        <button
          onClick={onAttach}
          aria-label="Re-attach panel"
          style={{
            background: "none",
            border: "none",
            color: "#999",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: "2px 4px",
            borderRadius: 3,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#fff"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#999"; }}
        >
          ✕
        </button>
      </div>

      {/* Panel content */}
      <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
