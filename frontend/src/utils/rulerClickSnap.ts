import {
  snapTimeByType,
  type GridSize,
  type QuantizePreset,
  type SnapType,
} from "./snapToGrid";

export const RULER_CLICK_SNAP_PX = 10;

interface TimeSignature {
  numerator: number;
  denominator: number;
}

interface GetRulerClickSnapTimeParams {
  time: number;
  pixelsPerSecond: number;
  tempo: number;
  timeSignature: TimeSignature;
  gridSize: GridSize;
  snapType?: SnapType;
  quantizePreset?: QuantizePreset | null;
  quantizeGridSize?: GridSize;
  cursorTime?: number | null;
  eventTimes?: readonly number[];
  snapEnabled: boolean;
  ctrlBypass?: boolean;
}

export function getRulerClickSnapTime({
  time,
  pixelsPerSecond,
  tempo,
  timeSignature,
  gridSize,
  snapType = "grid",
  quantizePreset,
  quantizeGridSize,
  cursorTime,
  eventTimes,
  snapEnabled,
  ctrlBypass = false,
}: GetRulerClickSnapTimeParams): number {
  // Beat snap is always preferred for ruler clicks because it is navigation-oriented.
  const secondsPerBeat = 60 / tempo;
  const beatSnapped = Math.round(time / secondsPerBeat) * secondsPerBeat;
  const beatSnapDistPx = Math.abs(beatSnapped - time) * pixelsPerSecond;
  if (beatSnapDistPx <= RULER_CLICK_SNAP_PX) {
    return beatSnapped;
  }

  if (!snapEnabled || ctrlBypass) {
    return time;
  }

  const gridSnapped = snapTimeByType({
    time,
    tempo,
    timeSignature,
    gridSize,
    snapType,
    quantizePreset,
    quantizeGridSize,
    pixelsPerSecond,
    cursorTime: cursorTime ?? undefined,
    eventTimes,
  });
  const gridSnapDistPx = Math.abs(gridSnapped - time) * pixelsPerSecond;
  return gridSnapDistPx <= RULER_CLICK_SNAP_PX ? gridSnapped : time;
}
