/**
 * Snap to Grid Utility
 * Snaps time values to musical grid based on tempo and time signature
 */

export type GridSize = "bar" | "half_bar" | "quarter_bar" | "eighth_bar" | "beat" | "half_beat" | "quarter_beat" | "second" | "minute";

interface TimeSignature {
  numerator: number;
  denominator: number;
}

/**
 * Calculates the grid interval in seconds based on tempo and grid size
 */
export function calculateGridInterval(
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize
): number {
  // Calculate seconds per beat (quarter note)
  const secondsPerBeat = 60 / tempo;

  // Calculate seconds per bar
  const beatsPerBar = timeSignature.numerator;
  const secondsPerBar = secondsPerBeat * beatsPerBar;

  switch (gridSize) {
    case "bar":
      return secondsPerBar;
    case "half_bar":
      return secondsPerBar / 2;
    case "quarter_bar":
      return secondsPerBar / 4;
    case "eighth_bar":
      return secondsPerBar / 8;
    case "beat":
      return secondsPerBeat;
    case "half_beat":
      return secondsPerBeat / 2;
    case "quarter_beat":
      return secondsPerBeat / 4;
    case "second":
      return 1;
    case "minute":
      return 60;
    default:
      return secondsPerBeat;
  }
}

/**
 * Snaps a time value to the nearest grid point
 *
 * @param time - Time in seconds to snap
 * @param tempo - BPM (beats per minute)
 * @param timeSignature - Time signature (e.g., 4/4)
 * @param gridSize - Grid size to snap to
 * @returns Snapped time in seconds
 */
export function snapToGrid(
  time: number,
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize
): number {
  const gridInterval = calculateGridInterval(tempo, timeSignature, gridSize);

  // Round to nearest grid point
  const snappedTime = Math.round(time / gridInterval) * gridInterval;

  // Ensure we don't snap to negative values
  return Math.max(0, snappedTime);
}

/**
 * Snaps a time value to the previous grid point (floor)
 */
export function snapToGridFloor(
  time: number,
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize
): number {
  const gridInterval = calculateGridInterval(tempo, timeSignature, gridSize);
  const snappedTime = Math.floor(time / gridInterval) * gridInterval;
  return Math.max(0, snappedTime);
}

/**
 * Snaps a time value to the next grid point (ceil)
 */
export function snapToGridCeil(
  time: number,
  tempo: number,
  timeSignature: TimeSignature,
  gridSize: GridSize
): number {
  const gridInterval = calculateGridInterval(tempo, timeSignature, gridSize);
  const snappedTime = Math.ceil(time / gridInterval) * gridInterval;
  return Math.max(0, snappedTime);
}

