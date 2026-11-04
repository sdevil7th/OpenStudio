import { useCallback, useEffect, useRef } from "react";
import { getActiveShortcutContext, registerShortcutSurface } from "../utils/shortcutContext";

interface PanelResizeHandleProps {
  label: string;
  controls: string;
  height: number;
  min: number;
  max: number;
  defaultHeight: number;
  onResize: (height: number, persist?: boolean) => void;
}

/** Pointer work is coalesced per frame; preference writes happen on release. */
export function PanelResizeHandle({ label, controls, height, min, max, defaultHeight, onResize }: PanelResizeHandleProps) {
  const gesture = useRef<{
    startY: number; startHeight: number; nextHeight: number;
    cursor: string; userSelect: string;
    element: HTMLDivElement; pointerId: number;
    releaseShortcutScope?: () => void;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const clampHeight = (value: number) => Math.max(min, Math.min(max, value));
  const finish = useCallback((cancel = false) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    active.releaseShortcutScope?.();
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    if (document.activeElement === active.element) active.element.blur();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    document.body.style.cursor = active.cursor;
    document.body.style.userSelect = active.userSelect;
    onResize(cancel ? active.startHeight : active.nextHeight, true);
  }, [onResize]);

  useEffect(() => {
    const onBlur = () => finish();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      finish();
    };
  }, [finish]);

  return (
    <div
      role="separator"
      data-panel-resize-handle="true"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(height)}
      aria-valuetext={`${Math.round(height)} pixels high`}
      title={`${label}. Drag or use Up/Down arrows; double-click to reset.`}
      className="flex w-12 shrink-0 self-stretch touch-none cursor-row-resize items-center justify-center rounded text-daw-text-secondary hover:text-daw-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daw-accent"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        finish();
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = {
          startY: event.clientY, startHeight: height, nextHeight: height,
          cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
          element: event.currentTarget, pointerId: event.pointerId,
        };
        // The app dispatches shortcuts at window capture, before onKeyDown.
        // Temporarily own Escape so cancelling a drag cannot deselect tracks.
        const context = getActiveShortcutContext();
        gesture.current.releaseShortcutScope = registerShortcutSurface(context, (keyEvent) => {
          if (keyEvent.key !== "Escape" || keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey || keyEvent.shiftKey) return "unmatched";
          finish(true);
          return "handled";
        }, context);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        const active = gesture.current;
        if (!active) return;
        active.nextHeight = clampHeight(active.startHeight + active.startY - event.clientY);
        if (frame.current === null) {
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (gesture.current) onResize(gesture.current.nextHeight, false);
          });
        }
      }}
      onPointerUp={(event) => {
        const active = gesture.current;
        if (active) active.nextHeight = clampHeight(active.startHeight + active.startY - event.clientY);
        finish();
      }}
      onPointerCancel={() => finish()}
      onLostPointerCapture={() => finish()}
      onDoubleClick={() => onResize(clampHeight(defaultHeight), true)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && gesture.current) {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          return;
        }
        const step = event.shiftKey ? 48 : 16;
        const next = event.key === "ArrowUp" ? height + step
          : event.key === "ArrowDown" ? height - step
          : event.key === "Home" ? min
          : event.key === "End" ? max : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(clampHeight(next), true);
      }}
    >
      <span className="h-0.5 w-6 rounded-full bg-current" aria-hidden="true" />
    </div>
  );
}
