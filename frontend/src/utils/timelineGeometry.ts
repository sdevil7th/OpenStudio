export interface TimelineGeometry {
  pixelsPerSecond: number;
  scrollX: number;
}

export interface MidiSourceTimelineGeometry extends TimelineGeometry {
  clipStartTime: number;
}

export function projectTimeToX(time: number, geometry: TimelineGeometry): number {
  return time * geometry.pixelsPerSecond - geometry.scrollX;
}

export function xToProjectTime(x: number, geometry: TimelineGeometry): number {
  return (x + geometry.scrollX) / geometry.pixelsPerSecond;
}

export function midiSourceTimeToProjectX(sourceTime: number, geometry: MidiSourceTimelineGeometry): number {
  return projectTimeToX(geometry.clipStartTime + sourceTime, geometry);
}

export function projectXToMidiSourceTime(x: number, geometry: MidiSourceTimelineGeometry): number {
  return Math.max(0, xToProjectTime(x, geometry) - geometry.clipStartTime);
}

export interface PianoRollRulerGeometry extends TimelineGeometry {
  snapSeconds: number;
  snapEnabled?: boolean;
  bypassSnap?: boolean;
}

export function pianoRollRulerTimeFromX(x: number, geometry: PianoRollRulerGeometry): number {
  const rawTime = Math.max(0, xToProjectTime(x, geometry));
  if (!geometry.snapEnabled || geometry.bypassSnap) {
    return rawTime;
  }

  const snap = Math.max(0.0001, geometry.snapSeconds);
  return Math.max(0, Math.round(rawTime / snap) * snap);
}
