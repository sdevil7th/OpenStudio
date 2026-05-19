export const MIDI_7BIT_MIN = 0;
export const MIDI_7BIT_MAX = 127;
export const MIDI_PITCH_BEND_MIN = 0;
export const MIDI_PITCH_BEND_CENTER = 8192;
export const MIDI_PITCH_BEND_MAX = 16383;
export const DEFAULT_PITCH_BEND_RANGE_SEMITONES = 2;

export type ControllerLFOShape = "sine" | "triangle" | "square" | "sawUp" | "sawDown";
export type ControllerInterpolationMode = "step" | "linear" | "curve" | "parabola";

export interface GeneratedControllerPoint {
  time: number;
  value: number;
}

export interface ControllerLineOptions {
  startTime: number;
  endTime: number;
  startValue: number;
  endValue: number;
  stepSeconds?: number;
  valueMin?: number;
  valueMax?: number;
  interpolation?: ControllerInterpolationMode;
  curve?: number;
}

export interface ControllerLFOOptions {
  startTime: number;
  endTime: number;
  centerValue: number;
  depth: number;
  rateHz: number;
  shape?: ControllerLFOShape;
  phase?: number;
  stepSeconds?: number;
  valueMin?: number;
  valueMax?: number;
}

export interface ControllerTransformOptions {
  timeAnchor?: number;
  timeScale?: number;
  valueAnchor?: number;
  valueScale?: number;
  valueOffset?: number;
  tilt?: number;
  valueMin?: number;
  valueMax?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positiveRange(rangeSemitones: number): number {
  const absRange = Math.abs(rangeSemitones);
  return Number.isFinite(absRange) && absRange > 0 ? absRange : DEFAULT_PITCH_BEND_RANGE_SEMITONES;
}

function normalizeStep(stepSeconds?: number): number {
  const step = stepSeconds ?? 0;
  return Math.max(0.001, Number.isFinite(step) && step > 0 ? step : 1 / 64);
}

function normalizeTimeRange(startTime: number, endTime: number): { startTime: number; endTime: number } {
  const start = Math.max(0, Math.min(startTime, endTime));
  const end = Math.max(0, Math.max(startTime, endTime));
  return { startTime: start, endTime: end };
}

export function clamp7Bit(value: number): number {
  return clamp(Math.round(value), MIDI_7BIT_MIN, MIDI_7BIT_MAX);
}

export function clampPitchBend(value: number): number {
  return clamp(Math.round(value), MIDI_PITCH_BEND_MIN, MIDI_PITCH_BEND_MAX);
}

export function pitchBendToLaneValue(value?: number): number {
  const raw = clampPitchBend(value ?? MIDI_PITCH_BEND_CENTER);
  return clamp7Bit((raw / MIDI_PITCH_BEND_MAX) * MIDI_7BIT_MAX);
}

export function laneValueToPitchBend(value: number): number {
  return clampPitchBend((clamp7Bit(value) / MIDI_7BIT_MAX) * MIDI_PITCH_BEND_MAX);
}

export function clamp14Bit(value: number): number {
  return clamp(Math.round(value), 0, 16383);
}

export function split14BitCCValue(value: number): { msb: number; lsb: number } {
  const raw = clamp14Bit(value);
  return {
    msb: (raw >> 7) & 0x7f,
    lsb: raw & 0x7f,
  };
}

export function combine14BitCCValue(msb: number, lsb = 0): number {
  return clamp14Bit((clamp7Bit(msb) << 7) + clamp7Bit(lsb));
}

export function pitchBendValueToSemitones(value: number, rangeSemitones: number): number {
  const range = positiveRange(rangeSemitones);
  const raw = clampPitchBend(value);
  const delta = raw - MIDI_PITCH_BEND_CENTER;
  if (delta >= 0) {
    return (delta / (MIDI_PITCH_BEND_MAX - MIDI_PITCH_BEND_CENTER)) * range;
  }
  return (delta / MIDI_PITCH_BEND_CENTER) * range;
}

export function semitonesToPitchBendValue(semitones: number, rangeSemitones: number): number {
  const range = positiveRange(rangeSemitones);
  const safeSemitones = clamp(semitones, -range, range);
  if (safeSemitones >= 0) {
    return clampPitchBend(MIDI_PITCH_BEND_CENTER + (safeSemitones / range) * (MIDI_PITCH_BEND_MAX - MIDI_PITCH_BEND_CENTER));
  }
  return clampPitchBend(MIDI_PITCH_BEND_CENTER + (safeSemitones / range) * MIDI_PITCH_BEND_CENTER);
}

export function pitchBendValueToSemitonesWithRange(value: number, rangeUpSemitones: number, rangeDownSemitones = rangeUpSemitones): number {
  const upRange = positiveRange(rangeUpSemitones);
  const downRange = positiveRange(rangeDownSemitones);
  const raw = clampPitchBend(value);
  const delta = raw - MIDI_PITCH_BEND_CENTER;
  if (delta >= 0) {
    return (delta / (MIDI_PITCH_BEND_MAX - MIDI_PITCH_BEND_CENTER)) * upRange;
  }
  return (delta / MIDI_PITCH_BEND_CENTER) * downRange;
}

export function semitonesToPitchBendValueWithRange(semitones: number, rangeUpSemitones: number, rangeDownSemitones = rangeUpSemitones): number {
  const upRange = positiveRange(rangeUpSemitones);
  const downRange = positiveRange(rangeDownSemitones);
  if (semitones >= 0) {
    const safeSemitones = clamp(semitones, 0, upRange);
    return clampPitchBend(MIDI_PITCH_BEND_CENTER + (safeSemitones / upRange) * (MIDI_PITCH_BEND_MAX - MIDI_PITCH_BEND_CENTER));
  }
  const safeSemitones = clamp(semitones, -downRange, 0);
  return clampPitchBend(MIDI_PITCH_BEND_CENTER + (safeSemitones / downRange) * MIDI_PITCH_BEND_CENTER);
}

export function snapPitchBendValueToSemitone(value: number, rangeSemitones: number, stepSemitones = 1): number {
  const step = Math.max(0.01, Math.abs(stepSemitones));
  const snappedSemitones = Math.round(pitchBendValueToSemitones(value, rangeSemitones) / step) * step;
  return semitonesToPitchBendValue(snappedSemitones, rangeSemitones);
}

export function snapPitchBendValueToSemitoneWithRange(
  value: number,
  rangeUpSemitones: number,
  rangeDownSemitones = rangeUpSemitones,
  stepSemitones = 1,
): number {
  const step = Math.max(0.01, Math.abs(stepSemitones));
  const snappedSemitones = Math.round(pitchBendValueToSemitonesWithRange(value, rangeUpSemitones, rangeDownSemitones) / step) * step;
  return semitonesToPitchBendValueWithRange(snappedSemitones, rangeUpSemitones, rangeDownSemitones);
}

export function pitchBendValueToLaneFraction(value: number): number {
  return clampPitchBend(value) / MIDI_PITCH_BEND_MAX;
}

export function generateControllerLineEvents(options: ControllerLineOptions): GeneratedControllerPoint[] {
  const { startTime, endTime } = normalizeTimeRange(options.startTime, options.endTime);
  const valueMin = options.valueMin ?? MIDI_7BIT_MIN;
  const valueMax = options.valueMax ?? MIDI_7BIT_MAX;
  const startValue = clamp(options.startValue, valueMin, valueMax);
  const endValue = clamp(options.endValue, valueMin, valueMax);
  const duration = endTime - startTime;
  if (duration <= 0) {
    return [{ time: startTime, value: Math.round(startValue) }];
  }

  const count = Math.max(1, Math.ceil(duration / normalizeStep(options.stepSeconds)));
  const points: GeneratedControllerPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const interpolation = options.interpolation ?? "linear";
    const curve = clamp(options.curve ?? 0, -0.99, 0.99);
    const shaped = interpolation === "step"
      ? (t >= 1 ? 1 : 0)
      : interpolation === "parabola"
        ? t * t
        : interpolation === "curve"
          ? Math.pow(t, Math.pow(2, -curve * 4))
          : t;
    points.push({
      time: startTime + duration * t,
      value: Math.round(startValue + (endValue - startValue) * shaped),
    });
  }
  return points;
}

export function generateControllerCurveEvents(options: ControllerLineOptions): GeneratedControllerPoint[] {
  return generateControllerLineEvents({
    ...options,
    interpolation: "curve",
    curve: options.curve ?? 0.5,
  });
}

function waveValue(shape: ControllerLFOShape, phase: number): number {
  const wrapped = ((phase % 1) + 1) % 1;
  switch (shape) {
    case "triangle":
      return 1 - 4 * Math.abs(wrapped - 0.5);
    case "square":
      return wrapped < 0.5 ? 1 : -1;
    case "sawUp":
      return wrapped * 2 - 1;
    case "sawDown":
      return 1 - wrapped * 2;
    case "sine":
    default:
      return Math.sin(wrapped * Math.PI * 2);
  }
}

export function generateControllerLFOEvents(options: ControllerLFOOptions): GeneratedControllerPoint[] {
  const { startTime, endTime } = normalizeTimeRange(options.startTime, options.endTime);
  const valueMin = options.valueMin ?? MIDI_7BIT_MIN;
  const valueMax = options.valueMax ?? MIDI_7BIT_MAX;
  const center = clamp(options.centerValue, valueMin, valueMax);
  const depth = Math.max(0, Math.abs(options.depth));
  const duration = endTime - startTime;
  if (duration <= 0) {
    return [{ time: startTime, value: Math.round(center) }];
  }

  const rateHz = Math.max(0.001, Math.abs(options.rateHz));
  const count = Math.max(1, Math.ceil(duration / normalizeStep(options.stepSeconds)));
  const phaseOffset = options.phase ?? 0;
  const shape = options.shape ?? "sine";
  const points: GeneratedControllerPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const time = startTime + duration * t;
    const phase = phaseOffset + (time - startTime) * rateHz;
    points.push({
      time,
      value: Math.round(clamp(center + waveValue(shape, phase) * depth, valueMin, valueMax)),
    });
  }
  return points;
}

export function thinControllerEvents(points: GeneratedControllerPoint[], tolerance = 1): GeneratedControllerPoint[] {
  if (points.length <= 2) return [...points].sort((a, b) => a.time - b.time);

  const sorted = [...points].sort((a, b) => a.time - b.time);
  const safeTolerance = Math.max(0, Math.abs(tolerance));
  if (safeTolerance === 0) return sorted;

  const keep = new Set<number>([0, sorted.length - 1]);
  const reduceRange = (startIndex: number, endIndex: number) => {
    if (endIndex <= startIndex + 1) return;

    const start = sorted[startIndex];
    const end = sorted[endIndex];
    const duration = end.time - start.time;
    let worstIndex = -1;
    let worstError = -1;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const point = sorted[index];
      const t = duration === 0 ? 0 : (point.time - start.time) / duration;
      const expected = start.value + (end.value - start.value) * t;
      const error = Math.abs(point.value - expected);
      if (error > worstError) {
        worstError = error;
        worstIndex = index;
      }
    }

    if (worstIndex >= 0 && worstError > safeTolerance) {
      keep.add(worstIndex);
      reduceRange(startIndex, worstIndex);
      reduceRange(worstIndex, endIndex);
    }
  };

  reduceRange(0, sorted.length - 1);
  return sorted.filter((_, index) => keep.has(index));
}

export function transformControllerEvents(
  points: GeneratedControllerPoint[],
  options: ControllerTransformOptions,
): GeneratedControllerPoint[] {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.time - b.time);
  const valueMin = options.valueMin ?? MIDI_7BIT_MIN;
  const valueMax = options.valueMax ?? MIDI_7BIT_MAX;
  const timeAnchor = options.timeAnchor ?? sorted[0].time;
  const timeScale = Number.isFinite(options.timeScale) ? options.timeScale! : 1;
  const valueAnchor = options.valueAnchor ?? 64;
  const valueScale = Number.isFinite(options.valueScale) ? options.valueScale! : 1;
  const valueOffset = Number.isFinite(options.valueOffset) ? options.valueOffset! : 0;
  const tilt = Number.isFinite(options.tilt) ? options.tilt! : 0;
  const firstTime = sorted[0].time;
  const lastTime = sorted[sorted.length - 1].time;
  const duration = Math.max(0.000001, lastTime - firstTime);

  return sorted.map((point) => {
    const normalized = (point.time - firstTime) / duration;
    const tiltedValue = point.value + (normalized - 0.5) * tilt;
    const transformedValue = valueAnchor + (tiltedValue - valueAnchor) * valueScale + valueOffset;
    return {
      time: Math.max(0, timeAnchor + (point.time - timeAnchor) * timeScale),
      value: Math.round(clamp(transformedValue, valueMin, valueMax)),
    };
  });
}
