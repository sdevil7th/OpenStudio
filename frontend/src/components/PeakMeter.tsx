import { useEffect, useRef } from "react";

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
  height = 140,
  stereo = true,
  clipping = false,
}: PeakMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const canvasHeight = canvas.height;
    const channelWidth = stereo ? (width - 1) / 2 : width;

    // Clear canvas
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, canvasHeight);

    // Convert RMS to dB
    const dbLevel = level > 0 ? 20 * Math.log10(level) : -60;
    const normalizedLevel = Math.max(0, Math.min(1, (dbLevel + 60) / 72)); // -60dB to +12dB

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
      // Simulate slight L/R variation for visual interest
      const leftLevel = normalizedLevel * (0.95 + Math.random() * 0.1);
      const rightLevel = normalizedLevel * (0.95 + Math.random() * 0.1);
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
  }, [level, peakHold, height, stereo, clipping]);

  return (
    <canvas
      ref={canvasRef}
      width={stereo ? 16 : 10}
      height={height}
      className="rounded-sm border border-neutral-700"
    />
  );
}
