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

  // Peak hold with 3 dB/sec decay
  const peakHoldLevelRef = useRef(0);
  const peakHoldTimerRef = useRef(0); // timestamp when peak was captured
  const animFrameRef = useRef<number | null>(null);
  const lastDrawTimeRef = useRef(0);

  // RMS simulation via exponential smoothing of squared peak values
  const rmsSmoothedRef = useRef(0);

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

  // Refs for latest values (avoid stale closures in animation loop)
  const levelRef = useRef(level);
  levelRef.current = level;
  const peakHoldPropRef = useRef(peakHold);
  peakHoldPropRef.current = peakHold;
  const stereoRef = useRef(stereo);
  stereoRef.current = stereo;
  const clippingRef = useRef(clipping);
  clippingRef.current = clipping;
  const canvasHeightRef = useRef(canvasHeight);
  canvasHeightRef.current = canvasHeight;

  // Create gradient once and cache it
  const gradientCacheRef = useRef<{ gradient: CanvasGradient; height: number; ctxId: CanvasRenderingContext2D } | null>(null);

  const getGradient = useCallback((ctx: CanvasRenderingContext2D, h: number): CanvasGradient => {
    const cached = gradientCacheRef.current;
    if (cached && cached.height === h && cached.ctxId === ctx) {
      return cached.gradient;
    }
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, "#16a34a");     // Green 600 at bottom
    grad.addColorStop(0.5, "#22c55e");   // Green 500
    grad.addColorStop(0.7, "#4ade80");   // Green 400
    grad.addColorStop(0.85, "#facc15");  // Yellow 400
    grad.addColorStop(0.92, "#f97316");  // Orange 500
    grad.addColorStop(1.0, "#ef4444");   // Red 500 at top
    gradientCacheRef.current = { gradient: grad, height: h, ctxId: ctx };
    return grad;
  }, []);

  // Animation loop for smooth peak hold decay
  useEffect(() => {
    const draw = (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) { animFrameRef.current = requestAnimationFrame(draw); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { animFrameRef.current = requestAnimationFrame(draw); return; }

      const currentLevel = levelRef.current;
      const currentPeakHoldProp = peakHoldPropRef.current;
      const isStereo = stereoRef.current;
      const isClipping = clippingRef.current;
      const ch = canvasHeightRef.current;
      const width = canvas.width;
      const channelWidth = isStereo ? (width - 1) / 2 : width;

      // Throttle to ~30fps to reduce CPU
      if (timestamp - lastDrawTimeRef.current < 33) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawTimeRef.current = timestamp;

      // Update peak hold with decay
      const NOISE_FLOOR = 0.001;
      const clampedLevel = currentLevel < NOISE_FLOOR ? 0 : currentLevel;
      const dbLevel = clampedLevel > 0 ? 20 * Math.log10(clampedLevel) : -Infinity;
      const normalizedLevel = dbLevel === -Infinity ? 0 : Math.max(0, Math.min(1, (dbLevel + 60) / 72));

      // RMS simulation: exponential smoothing of squared normalized level
      const smoothFactor = 0.3;
      const squared = normalizedLevel * normalizedLevel;
      rmsSmoothedRef.current = rmsSmoothedRef.current * (1 - smoothFactor) + squared * smoothFactor;
      const rmsLevel = Math.sqrt(rmsSmoothedRef.current);

      // Use prop peakHold if provided, otherwise compute our own
      let peakDisplay: number;
      if (currentPeakHoldProp > 0) {
        // External peak hold
        const peakDb = 20 * Math.log10(currentPeakHoldProp);
        peakDisplay = Math.max(0, Math.min(1, (peakDb + 60) / 72));
      } else {
        peakDisplay = 0;
      }

      // Internal peak hold with 3 dB/sec decay
      if (normalizedLevel > peakHoldLevelRef.current) {
        peakHoldLevelRef.current = normalizedLevel;
        peakHoldTimerRef.current = timestamp;
      } else {
        // Decay: 3dB/sec in normalized space ~ 3/72 per second
        const elapsed = (timestamp - peakHoldTimerRef.current) / 1000;
        if (elapsed > 1.5) { // Hold for 1.5 seconds before decay
          const decay = (elapsed - 1.5) * (3 / 72);
          peakHoldLevelRef.current = Math.max(0, peakHoldLevelRef.current - decay);
        }
      }

      // Use whichever peak is higher
      const effectivePeak = Math.max(peakDisplay, peakHoldLevelRef.current);

      // Clear canvas
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, width, ch);

      const meterGradient = getGradient(ctx, ch);

      // Draw meter channel with gradient fill (RMS = dimmer bar, peak = bright bar on top)
      const drawChannel = (cx: number, w: number, peakLv: number, rmsLv: number) => {
        const peakH = ch * peakLv;
        const rmsH = ch * rmsLv;

        // LED-style segments with gradient
        const segHeight = 2;
        const gap = 1;
        for (let y = ch; y > 0; y -= segHeight + gap) {
          const segY = y - segHeight;
          if (segY >= ch - peakH) {
            // Peak: fully lit segment
            ctx.fillStyle = meterGradient;
            ctx.globalAlpha = 1;
          } else if (segY >= ch - rmsH) {
            // RMS only zone: dimmer gradient
            ctx.fillStyle = meterGradient;
            ctx.globalAlpha = 0.35;
          } else {
            // Unlit segment
            ctx.fillStyle = "#171717";
            ctx.globalAlpha = 1;
          }
          ctx.fillRect(cx, segY, w, segHeight);
        }
        ctx.globalAlpha = 1;
      };

      if (isStereo) {
        const leftLevel = normalizedLevel * 0.97;
        const rightLevel = normalizedLevel * 1.03;
        const leftRms = rmsLevel * 0.97;
        const rightRms = rmsLevel * 1.03;
        drawChannel(0, channelWidth, leftLevel, leftRms);
        drawChannel(channelWidth + 1, channelWidth, rightLevel, rightRms);

        // Center divider
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(channelWidth, 0, 1, ch);
      } else {
        drawChannel(0, width, normalizedLevel, rmsLevel);
      }

      // Peak hold indicator line (white/bright line)
      if (effectivePeak > 0.01) {
        const peakY = ch - ch * effectivePeak;
        // Determine peak color based on level
        let peakColor: string;
        if (effectivePeak > 0.92) peakColor = "#ef4444";
        else if (effectivePeak > 0.85) peakColor = "#f97316";
        else peakColor = "#ffffff";

        ctx.fillStyle = peakColor;
        if (isStereo) {
          ctx.fillRect(0, peakY, channelWidth, 2);
          ctx.fillRect(channelWidth + 1, peakY, channelWidth, 2);
        } else {
          ctx.fillRect(0, peakY, width, 2);
        }
      }

      // Clip indicator - red block at top if clipping
      if (isClipping) {
        ctx.fillStyle = "#dc2626";
        ctx.fillRect(0, 0, width, 3);
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [getGradient]);

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
