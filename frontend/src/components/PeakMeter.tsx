import { useEffect, useRef, useCallback } from "react";
import {
  getMeterSegmentColor,
  getPeakIndicatorColor,
  getThresholdNormalized,
  CENTER_DBFS_LABEL_FONT_PX,
  MeterColorScheme,
  METER_COLORS,
  METER_RULER_FONT_PX,
  METER_SEGMENT_GAP,
  METER_SEGMENT_HEIGHT,
  MeterScaleMode,
  normalizeDbToMeter,
  normalizeLevelToMeter,
  normalizedMeterToDb,
  MASTER_DBFS_RULING_MARKS,
} from "./meterConfig";

export interface PeakMeterProps {
  level: number;
  midiInputLevel?: number;
  meterSource?: "audio" | "midi_input" | "idle";
  ariaLabel?: string;
  peakHold?: number;
  height?: number;
  stereo?: boolean;
  clipping?: boolean; // Show red clip indicator
  onReset?: () => void;
  scaleMode?: MeterScaleMode;
  showThresholdLine?: boolean;
  showRulings?: boolean;
  rulingMarksDb?: readonly number[];
  width?: number;
  resetSignal?: number;
  showBorder?: boolean;
  renderMode?: "segmented" | "continuous";
  showCenterDivider?: boolean;
  showRulingLabels?: boolean;
  showRulingLines?: boolean;
  colorScheme?: MeterColorScheme;
}

export function getStereoMeterChannelLevels(
  normalizedLevel: number,
  rmsLevel: number,
  source: "audio" | "midi_input" | "idle",
) {
  if (source === "midi_input") {
    return {
      leftLevel: normalizedLevel,
      rightLevel: normalizedLevel,
      leftRms: rmsLevel,
      rightRms: rmsLevel,
    };
  }
  return {
    leftLevel: normalizedLevel * 0.97,
    rightLevel: normalizedLevel * 1.03,
    leftRms: rmsLevel * 0.97,
    rightRms: rmsLevel * 1.03,
  };
}

export function PeakMeter({
  level,
  midiInputLevel = 0,
  meterSource = "audio",
  ariaLabel,
  peakHold = 0,
  height,
  stereo = true,
  clipping = false,
  onReset,
  scaleMode = "extended",
  showThresholdLine = false,
  showRulings = false,
  rulingMarksDb = MASTER_DBFS_RULING_MARKS,
  width,
  resetSignal = 0,
  showBorder = true,
  renderMode = "segmented",
  showCenterDivider = true,
  showRulingLabels = false,
  showRulingLines = true,
  colorScheme = "default",
}: PeakMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const containerHeightRef = useRef(height || 140);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Peak hold with 3 dB/sec decay
  const peakHoldLevelRef = useRef(0);
  const peakHoldTimerRef = useRef(0); // timestamp when peak was captured
  const animFrameRef = useRef<number | null>(null);
  const lastDrawTimeRef = useRef(0);

  // RMS simulation via exponential smoothing of squared peak values
  const rmsSmoothedRef = useRef(0);

  // Observe container size changes — store in ref to avoid re-render loop
  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    resizeObserverRef.current?.disconnect();
    if (node) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const h = Math.floor(entry.contentRect.height);
          if (h > 0) containerHeightRef.current = h;
        }
      });
      observer.observe(node);
      resizeObserverRef.current = observer;
      // Initial measurement
      const h = Math.floor(node.getBoundingClientRect().height);
      if (h > 0) containerHeightRef.current = h;
    }
  }, []);

  // Refs for latest values (avoid stale closures in animation loop)
  const levelRef = useRef(level);
  levelRef.current = level;
  const midiInputLevelRef = useRef(midiInputLevel);
  midiInputLevelRef.current = midiInputLevel;
  const meterSourceRef = useRef(meterSource);
  meterSourceRef.current = meterSource;
  const peakHoldPropRef = useRef(peakHold);
  peakHoldPropRef.current = peakHold;
  const stereoRef = useRef(stereo);
  stereoRef.current = stereo;
  const clippingRef = useRef(clipping);
  clippingRef.current = clipping;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  const scaleModeRef = useRef(scaleMode);
  scaleModeRef.current = scaleMode;
  const showThresholdLineRef = useRef(showThresholdLine);
  showThresholdLineRef.current = showThresholdLine;
  const showRulingsRef = useRef(showRulings);
  showRulingsRef.current = showRulings;
  const rulingMarksDbRef = useRef(rulingMarksDb);
  rulingMarksDbRef.current = rulingMarksDb;
  const renderModeRef = useRef(renderMode);
  renderModeRef.current = renderMode;
  const showCenterDividerRef = useRef(showCenterDivider);
  showCenterDividerRef.current = showCenterDivider;
  const showRulingLabelsRef = useRef(showRulingLabels);
  showRulingLabelsRef.current = showRulingLabels;
  const showRulingLinesRef = useRef(showRulingLines);
  showRulingLinesRef.current = showRulingLines;
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;

  useEffect(() => {
    peakHoldLevelRef.current = 0;
    peakHoldTimerRef.current = 0;
    rmsSmoothedRef.current = 0;
  }, [resetSignal]);

  // Animation loop for smooth peak hold decay
  useEffect(() => {
    const draw = (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) { animFrameRef.current = requestAnimationFrame(draw); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { animFrameRef.current = requestAnimationFrame(draw); return; }

      // Throttle to ~20fps; backend meter events arrive around 10Hz.
      if (timestamp - lastDrawTimeRef.current < 50) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawTimeRef.current = timestamp;

      const currentLevel = levelRef.current;
      const currentMidiInputLevel = midiInputLevelRef.current;
      const currentMeterSource = meterSourceRef.current;
      const isMIDIInput = currentMeterSource === "midi_input";
      const currentPeakHoldProp = peakHoldPropRef.current;
      const isStereo = stereoRef.current;
      const isClipping = clippingRef.current;
      const currentScaleMode = scaleModeRef.current;
      const shouldShowThresholdLine = showThresholdLineRef.current;
      const shouldShowRulings = showRulingsRef.current;
      const currentRulingMarks = rulingMarksDbRef.current;
      const currentRenderMode = renderModeRef.current;
      const shouldShowCenterDivider = showCenterDividerRef.current;
      const shouldShowRulingLabels = showRulingLabelsRef.current;
      const shouldShowRulingLines = showRulingLinesRef.current;
      const currentColorScheme = colorSchemeRef.current;
      const ch = height || containerHeightRef.current;
      if (ch <= 0) { animFrameRef.current = requestAnimationFrame(draw); return; }

      // Sync canvas pixel resolution only when it actually changed
      if (canvas.height !== ch) {
        canvas.height = ch;
      }
      const width = canvas.width;
      const dividerWidth = isStereo && shouldShowCenterDivider ? 1 : 0;
      const leftWidth = isStereo ? Math.floor((width - dividerWidth) / 2) : width;
      const rightX = leftWidth + dividerWidth;
      const rightWidth = isStereo ? width - rightX : width;

      // Update peak hold with decay
      const normalizedLevel = isMIDIInput
        ? Math.max(0, Math.min(1, currentMidiInputLevel))
        : normalizeLevelToMeter(currentLevel, currentScaleMode);

      // RMS simulation: exponential smoothing of squared normalized level
      const smoothFactor = 0.3;
      const squared = normalizedLevel * normalizedLevel;
      if (!isMIDIInput) {
        rmsSmoothedRef.current = rmsSmoothedRef.current * (1 - smoothFactor) + squared * smoothFactor;
      }
      const rmsLevel = isMIDIInput
        ? normalizedLevel
        : Math.sqrt(rmsSmoothedRef.current);

      // Use prop peakHold if provided, otherwise compute our own
      let peakDisplay: number;
      if (currentPeakHoldProp > 0) {
        peakDisplay = normalizeLevelToMeter(currentPeakHoldProp, currentScaleMode);
      } else {
        peakDisplay = 0;
      }

      // Internal peak hold with 3 dB/sec decay
      if (!isMIDIInput && normalizedLevel > peakHoldLevelRef.current) {
        peakHoldLevelRef.current = normalizedLevel;
        peakHoldTimerRef.current = timestamp;
      } else if (!isMIDIInput) {
        // Decay: 3dB/sec in normalized space ~ 3/72 per second
        const elapsed = (timestamp - peakHoldTimerRef.current) / 1000;
        if (elapsed > 1.5) { // Hold for 1.5 seconds before decay
          const decay = (elapsed - 1.5) * (3 / 72);
          peakHoldLevelRef.current = Math.max(0, peakHoldLevelRef.current - decay);
        }
      }

      // Use whichever peak is higher
      const effectivePeak = isMIDIInput
        ? 0
        : Math.max(peakDisplay, peakHoldLevelRef.current);

      // Clear canvas
      ctx.fillStyle = METER_COLORS.background;
      ctx.fillRect(0, 0, width, ch);

      // Draw meter channel with gradient fill (RMS = dimmer bar, peak = bright bar on top)
      const drawChannel = (cx: number, w: number, peakLv: number, rmsLv: number) => {
        const peakH = ch * peakLv;
        const rmsH = ch * rmsLv;

        if (currentRenderMode === "continuous") {
          for (let y = 0; y < ch; ++y) {
            const pixelNorm = 1 - ((y + 0.5) / ch);
            const pixelDb = normalizedMeterToDb(pixelNorm, currentScaleMode);
            const pixelColor = isMIDIInput
              ? METER_COLORS.midiInput
              : getMeterSegmentColor(pixelDb, currentScaleMode, currentColorScheme);
            const litFromPeak = y >= ch - peakH;
            const litFromRms = y >= ch - rmsH;

            if (litFromPeak) {
              ctx.fillStyle = pixelColor;
              ctx.globalAlpha = 1;
            } else if (litFromRms) {
              ctx.fillStyle = pixelColor;
              ctx.globalAlpha = 0.35;
            } else {
              ctx.fillStyle = isMIDIInput ? METER_COLORS.midiInputDim : METER_COLORS.unlit;
              ctx.globalAlpha = 1;
            }
            ctx.fillRect(cx, y, w, 1);
          }
          ctx.globalAlpha = 1;
          return;
        }

        for (let y = ch; y > 0; y -= METER_SEGMENT_HEIGHT + METER_SEGMENT_GAP) {
          const segY = y - METER_SEGMENT_HEIGHT;
          const segmentCenterNorm = 1 - ((segY + METER_SEGMENT_HEIGHT * 0.5) / ch);
          const segmentDb = normalizedMeterToDb(segmentCenterNorm, currentScaleMode);
          const segmentColor = isMIDIInput
            ? METER_COLORS.midiInput
            : getMeterSegmentColor(segmentDb, currentScaleMode, currentColorScheme);
          if (segY >= ch - peakH) {
            ctx.fillStyle = segmentColor;
            ctx.globalAlpha = 1;
          } else if (segY >= ch - rmsH) {
            ctx.fillStyle = segmentColor;
            ctx.globalAlpha = 0.35;
          } else {
            ctx.fillStyle = isMIDIInput ? METER_COLORS.midiInputDim : METER_COLORS.unlit;
            ctx.globalAlpha = 1;
          }
          ctx.fillRect(cx, segY, w, METER_SEGMENT_HEIGHT);
        }
        ctx.globalAlpha = 1;
      };

      if (isStereo) {
        const { leftLevel, rightLevel, leftRms, rightRms } =
          getStereoMeterChannelLevels(normalizedLevel, rmsLevel, currentMeterSource);
        drawChannel(0, leftWidth, leftLevel, leftRms);
        drawChannel(rightX, rightWidth, rightLevel, rightRms);

        if (shouldShowCenterDivider) {
          ctx.fillStyle = METER_COLORS.background;
          ctx.fillRect(leftWidth, 0, dividerWidth, ch);
        }
      } else {
        drawChannel(0, width, normalizedLevel, rmsLevel);
      }

      if (shouldShowRulings) {
        ctx.strokeStyle = METER_COLORS.rulerOverlay;
        ctx.fillStyle = METER_COLORS.rulerOverlay;
        ctx.lineWidth = 1;
        const rulingFontPx =
          currentColorScheme === "centerContrast" ? CENTER_DBFS_LABEL_FONT_PX : METER_RULER_FONT_PX;
        ctx.font =
          currentColorScheme === "centerContrast"
            ? `900 ${rulingFontPx}px Arial, Helvetica, sans-serif`
            : `${rulingFontPx}px Consolas, 'SFMono-Regular', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const markDb of currentRulingMarks) {
          const markNorm = Math.max(0, Math.min(1, 1 - normalizeDbToMeter(markDb, currentScaleMode)));
          const y = Math.round(markNorm * ch);
          if (shouldShowRulingLines) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
          }

          if (shouldShowRulingLabels) {
            const label = markDb > 0 ? `+${markDb}` : `${markDb}`;
            const labelY = Math.max(
              rulingFontPx * 0.6,
              Math.min(ch - rulingFontPx * 0.4, y),
            );
            if (currentColorScheme === "centerContrast") {
              ctx.lineWidth = 2;
              ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
              ctx.strokeText(label, width * 0.5, labelY);
              ctx.fillStyle = "rgba(18, 18, 18, 0.98)";
            }
            ctx.fillText(label, width * 0.5, labelY);
          }
        }
      }

      if (shouldShowThresholdLine) {
        const thresholdY = ch - ch * getThresholdNormalized(currentScaleMode);
        ctx.fillStyle = METER_COLORS.thresholdLine;
        ctx.fillRect(0, Math.round(thresholdY), width, 1);
      }

      // Peak hold indicator line (white/bright line)
      if (effectivePeak > 0.01) {
        const peakY = ch - ch * effectivePeak;
        const peakColor = getPeakIndicatorColor(
          normalizedMeterToDb(effectivePeak, currentScaleMode),
          currentScaleMode,
          currentColorScheme,
        );

        ctx.fillStyle = peakColor;
        if (isStereo) {
          ctx.fillRect(0, peakY, leftWidth, 2);
          ctx.fillRect(rightX, peakY, rightWidth, 2);
        } else {
          ctx.fillRect(0, peakY, width, 2);
        }
      }

      // Clip indicator - red block at top if clipping
      if (isClipping && !isMIDIInput) {
        ctx.fillStyle = METER_COLORS.clip;
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
  }, [height]);

  return (
    <div ref={containerCallbackRef} className="h-full">
      <canvas
        ref={canvasRef}
        width={width ?? (stereo ? 16 : 10)}
        height={containerHeightRef.current}
        className={showBorder ? "rounded-sm border border-neutral-700 h-full" : "h-full"}
        data-meter-source={meterSource}
        aria-label={ariaLabel}
        role={ariaLabel ? "meter" : undefined}
        aria-valuemin={ariaLabel ? 0 : undefined}
        aria-valuemax={ariaLabel ? 1 : undefined}
        aria-valuenow={ariaLabel ? (meterSource === "midi_input" ? midiInputLevel : level) : undefined}
        onClick={() => {
          peakHoldLevelRef.current = 0;
          peakHoldTimerRef.current = 0;
          onResetRef.current?.();
        }}
      />
    </div>
  );
}
