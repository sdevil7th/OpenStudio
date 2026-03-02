import { useEffect, useRef, useCallback } from "react";
import { nativeBridge } from "../services/NativeBridge";

interface SpectrumAnalyzerProps {
  width?: number;
  height?: number;
}

/**
 * SpectrumAnalyzer (Sprint 20.11)
 * Real-time FFT spectrum display showing frequency content of the master output.
 * Renders as a bar chart with logarithmic frequency scaling.
 */
export function SpectrumAnalyzer({
  width = 300,
  height = 150,
}: SpectrumAnalyzerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(undefined);
  const dataRef = useRef<number[]>([]);

  const fetchSpectrum = useCallback(async () => {
    try {
      const result = await nativeBridge.getSpectrumData();
      if (Array.isArray(result) && result.length > 0) {
        dataRef.current = result;
      }
    } catch {
      // Backend not available
    }
  }, []);

  // Fetch data at ~30fps
  useEffect(() => {
    const interval = setInterval(fetchSpectrum, 33);
    return () => clearInterval(interval);
  }, [fetchSpectrum]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;

    const render = () => {
      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = "#0d0d0d";
      ctx.fillRect(0, 0, w, h);

      const data = dataRef.current;
      if (data.length === 0) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      // Draw frequency bars with logarithmic grouping
      const numBars = 64;
      const barWidth = (w - numBars) / numBars;
      const nyquist = 24000; // assume 48kHz sample rate

      for (let i = 0; i < numBars; i++) {
        // Log-spaced frequency bins
        const freqLow = 20 * Math.pow(nyquist / 20, i / numBars);
        const freqHigh = 20 * Math.pow(nyquist / 20, (i + 1) / numBars);

        // Map to FFT bin indices
        const binLow = Math.floor((freqLow / nyquist) * (data.length - 1));
        const binHigh = Math.ceil((freqHigh / nyquist) * (data.length - 1));

        // Average magnitude in this range
        let sum = 0;
        let count = 0;
        for (let b = binLow; b <= Math.min(binHigh, data.length - 1); b++) {
          sum += data[b];
          count++;
        }
        const avg = count > 0 ? sum / count : 0;

        // Convert to dB (0 to 1 magnitude → -60 to 0 dB)
        const db = avg > 0 ? 20 * Math.log10(avg) : -60;
        const normalizedHeight = Math.max(0, (db + 60) / 60);

        const barHeight = normalizedHeight * (h - 20 * dpr);
        const x = i * (barWidth + 1);
        const y = h - 10 * dpr - barHeight;

        // Color gradient based on height
        const gradient = ctx.createLinearGradient(x, y, x, h - 10 * dpr);
        if (normalizedHeight > 0.85) {
          gradient.addColorStop(0, "#ef4444");
          gradient.addColorStop(0.3, "#eab308");
          gradient.addColorStop(1, "#22c55e");
        } else if (normalizedHeight > 0.6) {
          gradient.addColorStop(0, "#eab308");
          gradient.addColorStop(1, "#22c55e");
        } else {
          gradient.addColorStop(0, "#22c55e");
          gradient.addColorStop(1, "#166534");
        }

        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, barWidth, barHeight);
      }

      // Frequency labels
      ctx.fillStyle = "#555";
      ctx.font = `${8 * dpr}px monospace`;
      ctx.textAlign = "center";
      const freqLabels = [100, 1000, 10000];
      for (const freq of freqLabels) {
        const pos =
          (Math.log(freq / 20) / Math.log(nyquist / 20)) * w;
        ctx.fillText(
          freq >= 1000 ? `${freq / 1000}k` : `${freq}`,
          pos,
          h - 2 * dpr,
        );
      }

      // dB scale
      ctx.textAlign = "right";
      ctx.fillText("0dB", w - 2 * dpr, 12 * dpr);
      ctx.fillText("-60dB", w - 2 * dpr, h - 12 * dpr);

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [width, height]);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] text-daw-text-muted font-semibold uppercase tracking-wide">
        Spectrum
      </div>
      <canvas
        ref={canvasRef}
        width={width * dpr}
        height={height * dpr}
        style={{ width, height }}
        className="rounded border border-daw-border"
      />
    </div>
  );
}
