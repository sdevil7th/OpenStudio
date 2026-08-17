import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type NAMRackTooltipPlacement = "above" | "below";

export interface NAMRackTooltipRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface NAMRackTooltipViewport {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface NAMRackTooltipPosition {
  left: number;
  top: number;
  placement: NAMRackTooltipPlacement;
}

const TOOLTIP_VIEWPORT_MARGIN = 8;
const TOOLTIP_ANCHOR_GAP = 10;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * Places a tooltip in fixed viewport coordinates. The preferred placement is
 * above the control; it flips below when that is the roomier visible side and
 * clamps on both axes so a narrow or short WebView cannot crop it.
 */
export function positionNAMRackTooltip(
  anchor: NAMRackTooltipRect,
  tooltip: Pick<NAMRackTooltipRect, "width" | "height">,
  viewport: NAMRackTooltipViewport,
  margin = TOOLTIP_VIEWPORT_MARGIN,
  gap = TOOLTIP_ANCHOR_GAP,
): NAMRackTooltipPosition {
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const availableAbove = anchor.top - viewport.top - margin - gap;
  const availableBelow = viewportBottom - anchor.bottom - margin - gap;
  const placement: NAMRackTooltipPlacement =
    tooltip.height <= availableAbove || availableAbove >= availableBelow ? "above" : "below";

  const idealLeft = anchor.left + anchor.width / 2 - tooltip.width / 2;
  const idealTop = placement === "above"
    ? anchor.top - gap - tooltip.height
    : anchor.bottom + gap;

  return {
    left: clamp(idealLeft, viewport.left + margin, viewportRight - margin - tooltip.width),
    top: clamp(idealTop, viewport.top + margin, viewportBottom - margin - tooltip.height),
    placement,
  };
}

function currentTooltipViewport(): NAMRackTooltipViewport {
  const visualViewport = window.visualViewport;
  return {
    top: visualViewport?.offsetTop ?? 0,
    left: visualViewport?.offsetLeft ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
}

export function NAMRackControlTooltip({
  anchor,
  open,
  label,
  value,
  kind = "value",
}: {
  anchor: HTMLElement | null;
  open: boolean;
  label?: ReactNode;
  value: ReactNode;
  kind?: "value" | "reason";
}) {
  const generatedId = useId();
  const tooltipId = `nam-rack-tooltip-${generatedId.replace(/:/g, "")}`;
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [position, setPosition] = useState<NAMRackTooltipPosition | null>(null);

  useEffect(() => {
    if (!anchor || !open) return undefined;
    const previousDescription = anchor.getAttribute("aria-describedby");
    const descriptionIds = new Set(previousDescription?.split(/\s+/).filter(Boolean) ?? []);
    descriptionIds.add(tooltipId);
    anchor.setAttribute("aria-describedby", Array.from(descriptionIds).join(" "));

    return () => {
      const currentIds = new Set(anchor.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? []);
      currentIds.delete(tooltipId);
      if (currentIds.size > 0) anchor.setAttribute("aria-describedby", Array.from(currentIds).join(" "));
      else anchor.removeAttribute("aria-describedby");
    };
  }, [anchor, open, tooltipId]);

  useLayoutEffect(() => {
    if (!anchor || !open) {
      setPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !anchor.isConnected) return;
      const next = positionNAMRackTooltip(
        anchor.getBoundingClientRect(),
        { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
        currentTooltipViewport(),
      );
      setPosition((current) => current
        && current.left === next.left
        && current.top === next.top
        && current.placement === next.placement
        ? current
        : next);
    };
    const schedulePositionUpdate = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        updatePosition();
      });
    };

    updatePosition();
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    window.visualViewport?.addEventListener("resize", schedulePositionUpdate);
    window.visualViewport?.addEventListener("scroll", schedulePositionUpdate);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePositionUpdate);
    resizeObserver?.observe(anchor);
    if (tooltipRef.current) resizeObserver?.observe(tooltipRef.current);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      window.visualViewport?.removeEventListener("resize", schedulePositionUpdate);
      window.visualViewport?.removeEventListener("scroll", schedulePositionUpdate);
    };
  }, [anchor, kind, label, open, value]);

  if (!open || !anchor || typeof document === "undefined") return null;

  const style = {
    left: `${position?.left ?? 0}px`,
    top: `${position?.top ?? 0}px`,
    visibility: position ? "visible" : "hidden",
  } as CSSProperties;

  return createPortal(
    <div
      ref={tooltipRef}
      id={tooltipId}
      role="tooltip"
      className="nam-rack-control-tooltip"
      data-kind={kind}
      data-placement={position?.placement ?? "above"}
      style={style}
    >
      {label ? <small>{label}</small> : null}
      <strong>{value}</strong>
    </div>,
    document.body,
  );
}
