import { useState, useEffect, useRef, useCallback } from "react";
import { nativeBridge } from "../services/NativeBridge";

interface PhaseCorrelationMeterProps {
  width?: number;
  height?: number;
}

/**
 * PhaseCorrelationMeter (Sprint 20.10)
 * Displays stereo phase correlation as a horizontal bar.
 * Range: -1 (out of phase) to +1 (in phase / mono).
 * 0 = no correlation (stereo). Values below 0 indicate phase issues.
 */
export function PhaseCorrelationMeter({
  width = 200,
  height = 24,
}: PhaseCorrelationMeterProps) {
  const [correlation, setCorrelation] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fetchCorrelation = useCallback(async () => {
    try {
      const val = await nativeBridge.getPhaseCorrelation();
      if (typeof val === "number" && isFinite(val)) {
        setCorrelation(val);
      }
    } catch {
      // Backend not available
    }
  }, []);

  useEffect(() => {
    intervalRef.current = setInterval(fetchCorrelation, 100);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchCorrelation]);

  // Draw the meter
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, h);

    // Center line
    const centerX = w / 2;
    ctx.strokeStyle = "#444";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.stroke();

    // Tick marks
    ctx.fillStyle = "#555";
    ctx.font = `${8 * dpr}px monospace`;
    ctx.textAlign = "center";
    // -1 mark
    ctx.fillText("-1", 10 * dpr, h - 2 * dpr);
    // 0 mark
    ctx.fillText("0", centerX, h - 2 * dpr);
    // +1 mark
    ctx.fillText("+1", w - 10 * dpr, h - 2 * dpr);

    // Indicator bar
    const barY = 2 * dpr;
    const barH = h - 14 * dpr;
    // Map correlation (-1 to +1) to pixel position
    const normalized = (correlation + 1) / 2; // 0 to 1
    const indicatorX = normalized * (w - 4 * dpr) + 2 * dpr;

    // Draw gradient bar from center to indicator
    const gradStart = centerX;
    const gradEnd = indicatorX;

    if (correlation >= 0) {
      // Green for positive correlation
      const grad = ctx.createLinearGradient(gradStart, 0, gradEnd, 0);
      grad.addColorStop(0, "#22c55e80");
      grad.addColorStop(1, "#22c55e");
      ctx.fillStyle = grad;
      ctx.fillRect(gradStart, barY, gradEnd - gradStart, barH);
    } else {
      // Red for negative correlation
      const grad = ctx.createLinearGradient(gradEnd, 0, gradStart, 0);
      grad.addColorStop(0, "#ef4444");
      grad.addColorStop(1, "#ef444480");
      ctx.fillStyle = grad;
      ctx.fillRect(gradEnd, barY, gradStart - gradEnd, barH);
    }

    // Indicator line
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(indicatorX, barY);
    ctx.lineTo(indicatorX, barY + barH);
    ctx.stroke();
  }, [correlation]);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] text-daw-text-muted font-semibold uppercase tracking-wide">
        Phase
      </div>
      <canvas
        ref={canvasRef}
        width={width * dpr}
        height={height * dpr}
        style={{ width, height }}
        className="rounded border border-daw-border"
      />
      <div className="text-[10px] text-daw-text tabular-nums text-center">
        {correlation.toFixed(2)}
      </div>
    </div>
  );
}
