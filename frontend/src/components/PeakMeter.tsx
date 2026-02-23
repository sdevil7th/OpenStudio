import { useEffect, useRef, useState, useCallback } from "react";

interface PeakMeterProps {
  level: number;
  peakHold?: number;
  height?: number;
  stereo?: boolean;
  clipping?: boolean; // Show red clip indicator
}

export function PeakMeter({
  level,
  peakHold = 0,
  height,
  stereo = true,
  clipping = false,
}: PeakMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerHeight, setContainerHeight] = useState(height || 140);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Observe container size changes
  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    if (node) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const h = Math.floor(entry.contentRect.height);
          if (h > 0) setContainerHeight(h);
        }
      });
      observer.observe(node);
      resizeObserverRef.current = observer;
      // Initial measurement
      const h = Math.floor(node.getBoundingClientRect().height);
      if (h > 0) setContainerHeight(h);
    }
  }, []);

  const canvasHeight = height || containerHeight;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const channelWidth = stereo ? (width - 1) / 2 : width;

    // Clear canvas
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, canvasHeight);

    // Apply noise floor - levels below this are treated as silence
    const NOISE_FLOOR = 0.001; // ~-60dB
    const clampedLevel = level < NOISE_FLOOR ? 0 : level;

    // Convert RMS to dB with proper zero handling
    const dbLevel =
      clampedLevel > 0 ? 20 * Math.log10(clampedLevel) : -Infinity;
    const normalizedLevel =
      dbLevel === -Infinity ? 0 : Math.max(0, Math.min(1, (dbLevel + 60) / 72)); // -60dB to +12dB

    // Draw meter for left channel
    const drawChannel = (x: number, w: number, lv: number) => {
      const h = canvasHeight * lv;

      // Background segments (LED style)
      const segHeight = 2;
      const gap = 1;
      for (let y = canvasHeight; y > 0; y -= segHeight + gap) {
        const segY = y - segHeight;
        if (segY >= canvasHeight - h) {
          // Lit segment
          const ratio = 1 - segY / canvasHeight;
          if (ratio < 0.7) {
            ctx.fillStyle = "#16a34a"; // Green 600
          } else if (ratio < 0.85) {
            ctx.fillStyle = "#4ade80"; // Green 400
          } else if (ratio < 0.92) {
            ctx.fillStyle = "#facc15"; // Yellow 400
          } else {
            ctx.fillStyle = "#ef4444"; // Red 500
          }
        } else {
          // Unlit segment
          ctx.fillStyle = "#171717"; // Neutral 900
        }
        ctx.fillRect(x, segY, w, segHeight);
      }
    };

    if (stereo) {
      // Slight deterministic L/R offset for visual interest (no Math.random() —
      // random values differ every render, forcing unnecessary canvas redraws)
      const leftLevel = normalizedLevel * 0.97;
      const rightLevel = normalizedLevel * 1.03;
      drawChannel(0, channelWidth, leftLevel);
      drawChannel(channelWidth + 1, channelWidth, rightLevel);

      // Center divider
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(channelWidth, 0, 1, canvasHeight);
    } else {
      drawChannel(0, width, normalizedLevel);
    }

    // Peak hold indicator
    if (peakHold > 0) {
      const peakDb = 20 * Math.log10(peakHold);
      const normalizedPeak = Math.max(0, Math.min(1, (peakDb + 60) / 72));
      const peakY = canvasHeight - canvasHeight * normalizedPeak;
      ctx.fillStyle = "#f97316"; // Orange 500
      ctx.fillRect(0, peakY, width, 2);
    }

    // Clip indicator - red line at top if clipping
    if (clipping) {
      ctx.fillStyle = "#dc2626"; // Red 600
      ctx.fillRect(0, 0, width, 3);
    }
  }, [level, peakHold, canvasHeight, stereo, clipping]);

  return (
    <div ref={containerCallbackRef} className="h-full">
      <canvas
        ref={canvasRef}
        width={stereo ? 16 : 10}
        height={canvasHeight}
        className="rounded-sm border border-neutral-700 h-full"
      />
    </div>
  );
}
