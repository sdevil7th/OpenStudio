import { snapToGrid, type GridSize } from "./snapToGrid";

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
  snapEnabled: boolean;
  ctrlBypass?: boolean;
}

export function getRulerClickSnapTime({
  time,
  pixelsPerSecond,
  tempo,
  timeSignature,
  gridSize,
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

  const gridSnapped = snapToGrid(time, tempo, timeSignature, gridSize);
  const gridSnapDistPx = Math.abs(gridSnapped - time) * pixelsPerSecond;
  return gridSnapDistPx <= RULER_CLICK_SNAP_PX ? gridSnapped : time;
}
