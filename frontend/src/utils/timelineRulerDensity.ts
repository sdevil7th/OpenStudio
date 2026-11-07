import { calculateGridInterval } from "./snapToGrid";

/** Thin displayed marks only; snapping and musical positions stay unchanged. */
export function getTimelineRulerDensity(
  pixelsPerSecond: number,
  tempo: number,
  timeSignature: { numerator: number; denominator: number },
  scrollX: number,
  width: number,
) {
  const secondsPerBeat = calculateGridInterval(tempo, timeSignature, "beat");
  const secondsPerBar = calculateGridInterval(tempo, timeSignature, "bar");
  const pixelsPerBeat = secondsPerBeat * pixelsPerSecond;
  const pixelsPerBar = secondsPerBar * pixelsPerSecond;
  const labelDigits = String(Math.max(1, Math.ceil((scrollX + width) / pixelsPerBar) + 1)).length;
  const powerOfTwoStride = (minimumPixels: number) =>
    2 ** Math.max(0, Math.ceil(Math.log2(minimumPixels / pixelsPerBar)));
  const barStep = powerOfTwoStride(8);
  const labelEveryBars = powerOfTwoStride(Math.max(48, labelDigits * 6 + 10));
  const mode = pixelsPerBeat >= 140 ? "division" as const
    : pixelsPerBeat >= Math.max(32, (labelDigits + 2) * 5.5 + 8) ? "beat" as const
      : "bar" as const;
  let divisionsPerBeat = mode === "division" ? (pixelsPerBeat >= 260 ? 8 : 4) : 1;
  const divisionLabelWidth = Math.max(32, (labelDigits + 4) * 5 + 8);
  while (divisionsPerBeat > 1 && pixelsPerBeat / divisionsPerBeat < divisionLabelWidth)
    divisionsPerBeat /= 2;
  return { secondsPerBeat, secondsPerBar, mode, divisionsPerBeat, barStep, labelEveryBars };
}
