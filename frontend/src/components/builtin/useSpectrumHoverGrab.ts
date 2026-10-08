import { useEffect, useRef, type PointerEvent } from "react";
import type { SpectrumGrabFrame } from "../../utils/eqSpectrumPeaks";

// Explicit Grab remains available to touch and keyboard users. Coordinates use
// the displayed analyzer curve, including its range and tilt.
export function useSpectrumHoverGrab({ enabled, blocked, identity, points, capture, onCapture, frequencyMin = 20, frequencyMax = 20000, gainRange = 30 }: {
  gainRange?: number;
  frequencyMin?: number; frequencyMax?: number;
  enabled: boolean; blocked: boolean; identity: string;
  points: { x: number; y: number }[];
  capture: () => SpectrumGrabFrame | null;
  onCapture: (frame: SpectrumGrabFrame) => void;
}) {
  const latest = useRef({ enabled, blocked, points, capture, onCapture, frequencyMin, frequencyMax, gainRange });
  latest.current = { enabled, blocked, points, capture, onCapture, frequencyMin, frequencyMax, gainRange };
  const pending = useRef<{ timer: number; x: number; y: number } | null>(null);
  const clear = () => { if (pending.current) window.clearTimeout(pending.current.timer); pending.current = null; };
  useEffect(() => { clear(); return clear; }, [enabled, blocked, identity]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || blocked || event.pointerType !== "mouse" || event.buttons !== 0
      || (event.target instanceof Element && event.target.closest('[role="button"], button, input, select'))) { clear(); return; }
    const element = event.currentTarget, box = element.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    const nearSpectrum = () => {
      const width = element.clientWidth - 52, height = element.clientHeight - 34;
      if (x < 38 || x > width + 38 || y < 10 || y > height + 10 || width <= 0 || height <= 0) return false;
      const points = latest.current.points;
      if (points.length < 2) return false;
      const hz = latest.current.frequencyMin * (latest.current.frequencyMax / latest.current.frequencyMin) ** ((x - 38) / width), right = points.findIndex(point => point.x >= hz);
      if (right <= 0) return false;
      const a = points[right - 1], b = points[right];
      const position = a.y + (b.y - a.y) * Math.log(hz / a.x) / Math.log(b.x / a.x);
      return Number.isFinite(position) && Math.abs(y - (10 + (latest.current.gainRange - position) / (2 * latest.current.gainRange) * height)) <= 18;
    };
    if (!nearSpectrum()) { clear(); return; }
    if (pending.current && Math.hypot(x - pending.current.x, y - pending.current.y) <= 6) return;
    clear();
    pending.current = { x, y, timer: window.setTimeout(() => {
      pending.current = null;
      const current = latest.current;
      if (document.hidden || !element.isConnected || !current.enabled || current.blocked || !nearSpectrum()) return;
      const frame = current.capture();
      if (frame?.peaks.length) current.onCapture(frame);
    }, 1800) };
  };
  return { onPointerMove: move, onPointerLeave: clear, onPointerDownCapture: clear, onWheelCapture: clear };
}
