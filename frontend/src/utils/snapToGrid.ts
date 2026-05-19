/**
 * Cubase-style grid and snap utilities.
 *
 * The legacy names are intentionally kept because the timeline, ruler, and MIDI
 * editor already import them. New code should prefer the Cubase-specific types.
 */

export const GRID_TICKS_PER_QUARTER = 480;
export const GRID_TICKS_PER_SIXTEENTH = 120;

export type StraightGridSize =
  | "1/1"
  | "1/2"
  | "1/4"
  | "1/8"
  | "1/16"
  | "1/32"
  | "1/64"
  | "1/128";

export type TripletGridSize =
  | "1/2T"
  | "1/4T"
  | "1/8T"
  | "1/16T"
  | "1/32T"
  | "1/64T";

export type DottedGridSize =
  | "1/2D"
  | "1/4D"
  | "1/8D"
  | "1/16D"
  | "1/32D"
  | "1/64D";

export type LegacyGridSize =
  | "half_bar"
  | "quarter_bar"
  | "eighth_bar"
  | "half_beat"
  | "quarter_beat";

export type TimeGridSize =
  | "1ms"
  | "10ms"
  | "100ms"
  | "1000ms"
  | "second"
  | "minute";

export type CubaseGridSize =
  | "bar"
  | "beat"
  | "use_quantize"
  | "adapt_to_zoom"
  | StraightGridSize
  | TripletGridSize
  | DottedGridSize
  | TimeGridSize;

export type GridSize = CubaseGridSize | LegacyGridSize;

export type SnapType =
  | "grid"
  | "grid_relative"
  | "events"
  | "shuffle"
  | "cursor"
  | "grid_cursor"
  | "events_cursor"
  | "events_grid_cursor";

export type QuantizeGroovePreset =
  | "straight"
  | "swingLight"
  | "swingHeavy"
  | "laidBack16"
  | "push16";

export interface QuantizePreset {
  id: string;
  name: string;
  gridSize: GridSize;
  strength: number;
  swing: number;
  groovePreset: QuantizeGroovePreset;
  tupletDivisions: number;
  catchRangeTicks: number;
  safeRangeTicks: number;
  roughTicks: number;
  moveControllers: boolean;
  isFactory?: boolean;
}

interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface GridResolutionOptions {
  quantizePreset?: QuantizePreset | null;
  quantizeGridSize?: GridSize;
  pixelsPerSecond?: number;
  viewportPixels?: number;
  maxVisibleLines?: number;
  minPixelsPerGrid?: number;
  tempo?: number;
  timeSignature?: TimeSignature;
}

export interface VisualGridResolution {
  gridInterval: number;
  visualInterval: number;
  barInterval: number;
  alignedToBar: boolean;
  divisionsPerBar: number;
}

export interface SnapTimeOptions extends GridResolutionOptions {
  time: number;
  tempo: number;
  timeSignature: TimeSignature;
  gridSize: GridSize;
  snapType?: SnapType;
  originalTime?: number;
  cursorTime?: number;
  eventTimes?: readonly number[];
}

export const STRAIGHT_GRID_SIZES: readonly StraightGridSize[] = [
  "1/1",
  "1/2",
  "1/4",
  "1/8",
  "1/16",
  "1/32",
  "1/64",
  "1/128",
];

export const TRIPLET_GRID_SIZES: readonly TripletGridSize[] = [
  "1/2T",
  "1/4T",
  "1/8T",
  "1/16T",
  "1/32T",
  "1/64T",
];

export const DOTTED_GRID_SIZES: readonly DottedGridSize[] = [
  "1/2D",
  "1/4D",
  "1/8D",
  "1/16D",
  "1/32D",
  "1/64D",
];

export const TIME_GRID_SIZES: readonly TimeGridSize[] = [
  "1ms",
  "10ms",
  "100ms",
  "1000ms",
  "second",
  "minute",
];

export const GRID_SIZE_GROUPS = [
  {
    label: "Grid Type",
    options: ["bar", "beat", "use_quantize", "adapt_to_zoom"] as readonly GridSize[],
  },
  { label: "Straight", options: STRAIGHT_GRID_SIZES },
  { label: "Triplet", options: TRIPLET_GRID_SIZES },
  { label: "Dotted", options: DOTTED_GRID_SIZES },
  { label: "Time", options: TIME_GRID_SIZES },
] as const;

export type GridSizeGroup = (typeof GRID_SIZE_GROUPS)[number];

export const GRID_TYPE_MODE_OPTIONS: readonly { value: GridSize; label: string }[] = [
  { value: "bar", label: "Bar" },
  { value: "beat", label: "Beat" },
  { value: "use_quantize", label: "Use Quantize" },
  { value: "adapt_to_zoom", label: "Adapt to Zoom" },
];

export const SNAP_TYPE_OPTIONS: readonly { value: SnapType; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "grid_relative", label: "Grid Relative" },
  { value: "events", label: "Events" },
  { value: "shuffle", label: "Shuffle" },
  { value: "cursor", label: "Cursor" },
  { value: "grid_cursor", label: "Grid + Cursor" },
  { value: "events_cursor", label: "Events + Cursor" },
  { value: "events_grid_cursor", label: "Events + Grid + Cursor" },
];

export const FACTORY_QUANTIZE_PRESETS: readonly QuantizePreset[] = [
  ...STRAIGHT_GRID_SIZES.map((gridSize) => ({
    id: `factory-${gridSize}`,
    name: getGridSizeLabel(gridSize),
    gridSize,
    strength: 1,
    swing: 0,
    groovePreset: "straight" as const,
    tupletDivisions: 1,
    catchRangeTicks: 0,
    safeRangeTicks: 0,
    roughTicks: 0,
    moveControllers: true,
    isFactory: true,
  })),
  ...TRIPLET_GRID_SIZES.map((gridSize) => ({
    id: `factory-${gridSize}`,
    name: getGridSizeLabel(gridSize),
    gridSize,
    strength: 1,
    swing: 0,
    groovePreset: "straight" as const,
    tupletDivisions: 1,
    catchRangeTicks: 0,
    safeRangeTicks: 0,
    roughTicks: 0,
    moveControllers: true,
    isFactory: true,
  })),
  ...DOTTED_GRID_SIZES.map((gridSize) => ({
    id: `factory-${gridSize}`,
    name: getGridSizeLabel(gridSize),
    gridSize,
    strength: 1,
    swing: 0,
    groovePreset: "straight" as const,
    tupletDivisions: 1,
    catchRangeTicks: 0,
    safeRangeTicks: 0,
    roughTicks: 0,
    moveControllers: true,
    isFactory: true,
  })),
];

function safeTempo(tempo: number): number {
  return Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
}

function secondsPerQuarter(tempo: number): number {
  return 60 / safeTempo(tempo);
}

function secondsPerTimeSignatureBeat(tempo: number, timeSignature: TimeSignature): number {
  const denominator = Number.isFinite(timeSignature.denominator) && timeSignature.denominator > 0
    ? timeSignature.denominator
    : 4;
  return secondsPerQuarter(tempo) * (4 / denominator);
}

function secondsPerBar(tempo: number, timeSignature: TimeSignature): number {
  const numerator = Number.isFinite(timeSignature.numerator) && timeSignature.numerator > 0
    ? timeSignature.numerator
    : 4;
  return secondsPerTimeSignatureBeat(tempo, timeSignature) * numerator;
}

function parseMusicalGrid(gridSize: GridSize): { denominator: number; multiplier: number } | null {
  const match = /^1\/(\d+)([TD])?$/.exec(gridSize);
  if (!match) return null;
  const denominator = Number.parseInt(match[1], 10);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const suffix = match[2];
  const multiplier = suffix === "T" ? 2 / 3 : suffix === "D" ? 1.5 : 1;
  return { denominator, multiplier };
}

export function getGridSizeLabel(gridSize: GridSize): string {
  const legacyLabels: Record<string, string> = {
    bar: "Bar",
    beat: "Beat",
    half_bar: "1/2 Bar",
    quarter_bar: "1/4 Bar",
    eighth_bar: "1/8 Bar",
    half_beat: "1/2 Beat",
    quarter_beat: "1/4 Beat",
    use_quantize: "Use Quantize",
    adapt_to_zoom: "Adapt to Zoom",
    "1ms": "1 ms",
    "10ms": "10 ms",
    "100ms": "100 ms",
    "1000ms": "1000 ms",
    second: "Second",
    minute: "Minute",
  };
  if (legacyLabels[gridSize]) return legacyLabels[gridSize];
  if (gridSize.endsWith("T")) return `${gridSize.slice(0, -1)} Triplet`;
  if (gridSize.endsWith("D")) return `${gridSize.slice(0, -1)} Dotted`;
  return gridSize;
}

export function getQuantizePresetById(
  presets: readonly QuantizePreset[] | undefined,
  presetId: string | undefined,
): QuantizePreset {
  return presets?.find((preset) => preset.id === presetId)
    ?? FACTORY_QUANTIZE_PRESETS.find((preset) => preset.id === presetId)
    ?? FACTORY_QUANTIZE_PRESETS.find((preset) => preset.id === "factory-1/16")
    ?? FACTORY_QUANTIZE_PRESETS[0];
}

export function resolveGridSize(gridSize: GridSize, options: GridResolutionOptions = {}): GridSize {
  if (gridSize === "use_quantize") {
    return options.quantizeGridSize
      ?? options.quantizePreset?.gridSize
      ?? "1/16";
  }

  if (gridSize !== "adapt_to_zoom") return gridSize;

  const pixelsPerSecond = Math.max(1, options.pixelsPerSecond ?? 80);
  const minPixels = Math.max(8, options.minPixelsPerGrid ?? 36);
  const tempo = options.tempo ?? 120;
  const timeSignature = options.timeSignature ?? { numerator: 4, denominator: 4 };
  const candidates: readonly GridSize[] = ["1/64", "1/32", "1/16", "1/8", "1/4", "1/2", "bar"];
  for (const candidate of candidates) {
    const interval = calculateGridInterval(tempo, timeSignature, candidate, options);
    if (interval * pixelsPerSecond >= minPixels) return candidate;
  }
  return "bar";
}

/**
 * Calculates the grid interval in seconds based on tempo and grid size.
 */
export function calculateGridInterval(
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize,
  options: GridResolutionOptions = {},
): number {
  const resolvedGridSize = resolveGridSize(gridSize, { ...options, tempo, timeSignature });
  const secondsPerBeat = secondsPerTimeSignatureBeat(tempo, timeSignature);
  const barSeconds = secondsPerBar(tempo, timeSignature);

  switch (resolvedGridSize) {
    case "bar":
      return barSeconds;
    case "half_bar":
      return barSeconds / 2;
    case "quarter_bar":
      return barSeconds / 4;
    case "eighth_bar":
      return barSeconds / 8;
    case "beat":
      return secondsPerBeat;
    case "half_beat":
      return secondsPerBeat / 2;
    case "quarter_beat":
      return secondsPerBeat / 4;
    case "1ms":
      return 0.001;
    case "10ms":
      return 0.01;
    case "100ms":
      return 0.1;
    case "1000ms":
    case "second":
      return 1;
    case "minute":
      return 60;
    case "use_quantize":
    case "adapt_to_zoom":
      return calculateGridInterval(tempo, timeSignature, resolveGridSize(resolvedGridSize, options), options);
    default: {
      const musical = parseMusicalGrid(resolvedGridSize);
      if (musical) {
        return (secondsPerQuarter(tempo) * 4 / musical.denominator) * musical.multiplier;
      }
      return secondsPerBeat;
    }
  }
}

function nearestWhole(value: number, tolerance = 0.0001): number | null {
  const rounded = Math.round(value);
  return rounded >= 1 && Math.abs(value - rounded) <= tolerance ? rounded : null;
}

function largestDivisorAtOrBelow(value: number, limit: number): number {
  const safeLimit = Math.max(1, Math.floor(limit));
  for (let candidate = Math.min(value, safeLimit); candidate >= 1; candidate -= 1) {
    if (value % candidate === 0) return candidate;
  }
  return 1;
}

export function resolveVisualGrid(
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize,
  options: GridResolutionOptions = {},
): VisualGridResolution {
  const pixelsPerSecond = Math.max(1, options.pixelsPerSecond ?? 80);
  const viewportPixels = Math.max(0, options.viewportPixels ?? 0);
  const lineBudgetSpacing = options.maxVisibleLines && viewportPixels > 0
    ? viewportPixels / Math.max(1, options.maxVisibleLines)
    : 0;
  const minPixels = Math.max(8, options.minPixelsPerGrid ?? 18, lineBudgetSpacing);
  const gridInterval = calculateGridInterval(tempo, timeSignature, gridSize, options);
  const barInterval = calculateGridInterval(tempo, timeSignature, "bar", options);
  const beatInterval = calculateGridInterval(tempo, timeSignature, "beat", options);
  const gridDivisionsPerBar = nearestWhole(barInterval / Math.max(0.000001, gridInterval));

  if (gridDivisionsPerBar !== null) {
    const maxVisibleDivisionsPerBar = Math.max(1, Math.floor((barInterval * pixelsPerSecond) / minPixels));
    const divisionsPerBar = largestDivisorAtOrBelow(gridDivisionsPerBar, maxVisibleDivisionsPerBar);
    return {
      gridInterval,
      visualInterval: barInterval / divisionsPerBar,
      barInterval,
      alignedToBar: true,
      divisionsPerBar,
    };
  }

  if (gridInterval * pixelsPerSecond >= minPixels) {
    return {
      gridInterval,
      visualInterval: gridInterval,
      barInterval,
      alignedToBar: false,
      divisionsPerBar: 1,
    };
  }

  if (beatInterval * pixelsPerSecond >= minPixels) {
    const beatsPerBar = nearestWhole(barInterval / Math.max(0.000001, beatInterval)) ?? 1;
    return {
      gridInterval,
      visualInterval: beatInterval,
      barInterval,
      alignedToBar: true,
      divisionsPerBar: beatsPerBar,
    };
  }

  return {
    gridInterval,
    visualInterval: barInterval,
    barInterval,
    alignedToBar: true,
    divisionsPerBar: 1,
  };
}

export function ticksToSeconds(ticks: number, tempo: number): number {
  return Math.max(0, ticks / GRID_TICKS_PER_QUARTER) * secondsPerQuarter(tempo);
}

export function secondsToTicks(seconds: number, tempo: number): number {
  return Math.max(0, seconds / secondsPerQuarter(tempo)) * GRID_TICKS_PER_QUARTER;
}

function snapToInterval(time: number, interval: number, mode: "round" | "floor" | "ceil" = "round"): number {
  const safeInterval = Math.max(0.000001, interval);
  const scaled = time / safeInterval;
  const snapped = mode === "floor"
    ? Math.floor(scaled)
    : mode === "ceil"
      ? Math.ceil(scaled)
      : Math.round(scaled);
  return Math.max(0, snapped * safeInterval);
}

function nearestCandidate(time: number, candidates: readonly number[]): number {
  if (candidates.length === 0) return time;
  return candidates.reduce((best, candidate) => (
    Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best
  ), candidates[0]);
}

export function snapTimeByType(options: SnapTimeOptions): number {
  const snapType = options.snapType ?? "grid";
  const interval = calculateGridInterval(
    options.tempo,
    options.timeSignature,
    options.gridSize,
    options,
  );
  const gridSnapped = options.originalTime !== undefined && snapType === "grid_relative"
    ? snapToInterval(options.time - (options.originalTime - snapToInterval(options.originalTime, interval)), interval)
      + (options.originalTime - snapToInterval(options.originalTime, interval))
    : snapToInterval(options.time, interval);
  const candidates: number[] = [];

  if (
    snapType === "grid"
    || snapType === "grid_relative"
    || snapType === "grid_cursor"
    || snapType === "events_grid_cursor"
    || snapType === "shuffle"
  ) {
    candidates.push(gridSnapped);
  }

  if (
    options.cursorTime !== undefined
    && (
      snapType === "cursor"
      || snapType === "grid_cursor"
      || snapType === "events_cursor"
      || snapType === "events_grid_cursor"
    )
  ) {
    candidates.push(Math.max(0, options.cursorTime));
  }

  if (
    options.eventTimes?.length
    && (
      snapType === "events"
      || snapType === "events_cursor"
      || snapType === "events_grid_cursor"
      || snapType === "shuffle"
    )
  ) {
    candidates.push(...options.eventTimes.map((time) => Math.max(0, time)));
  }

  return Math.max(0, nearestCandidate(options.time, candidates));
}

/**
 * Snaps a time value to the nearest grid point.
 */
export function snapToGrid(
  time: number,
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize,
  options: GridResolutionOptions = {},
): number {
  return snapToInterval(time, calculateGridInterval(tempo, timeSignature, gridSize, options));
}

/**
 * Snaps a time value to the previous grid point (floor).
 */
export function snapToGridFloor(
  time: number,
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize,
  options: GridResolutionOptions = {},
): number {
  return snapToInterval(time, calculateGridInterval(tempo, timeSignature, gridSize, options), "floor");
}

/**
 * Snaps a time value to the next grid point (ceil).
 */
export function snapToGridCeil(
  time: number,
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize,
  options: GridResolutionOptions = {},
): number {
  return snapToInterval(time, calculateGridInterval(tempo, timeSignature, gridSize, options), "ceil");
}

