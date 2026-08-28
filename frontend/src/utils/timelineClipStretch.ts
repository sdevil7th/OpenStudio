import type { MIDICCEvent, MIDIClip, MIDIEvent } from "../store/useDAWStore";

export type TimelineStretchEdge = "resize-left" | "resize-right";

export interface TimelineStretchGeometryInput {
  kind: TimelineStretchEdge;
  originalStartTime: number;
  originalDuration: number;
  originalOffset: number;
  deltaTime: number;
  minDuration?: number;
  snapTime?: (time: number) => number;
}

export interface TimelineStretchGeometry {
  startTime: number;
  duration: number;
  offset: number;
  timeScale: number;
  playbackRateRatio: number;
}

const EPSILON = 0.000001;

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolves stretch geometry while keeping the opposite edge anchored. Unlike a
 * trim, the source offset scales with the material instead of revealing or
 * hiding source audio.
 */
export function computeTimelineStretchGeometry(
  input: TimelineStretchGeometryInput,
): TimelineStretchGeometry {
  const originalStartTime = Math.max(0, finiteOr(input.originalStartTime, 0));
  const originalDuration = Math.max(EPSILON, finiteOr(input.originalDuration, EPSILON));
  const originalOffset = Math.max(0, finiteOr(input.originalOffset, 0));
  const minimumDuration = Math.max(EPSILON, finiteOr(input.minDuration, 0.01));
  const deltaTime = finiteOr(input.deltaTime, 0);
  const originalEnd = originalStartTime + originalDuration;

  let startTime = originalStartTime;
  let duration = originalDuration;

  if (input.kind === "resize-left") {
    let desiredStart = originalStartTime + deltaTime;
    if (input.snapTime) desiredStart = input.snapTime(desiredStart);
    startTime = Math.max(0, Math.min(originalEnd - minimumDuration, desiredStart));
    duration = Math.max(minimumDuration, originalEnd - startTime);
  } else {
    let desiredEnd = originalEnd + deltaTime;
    if (input.snapTime) desiredEnd = input.snapTime(desiredEnd);
    duration = Math.max(minimumDuration, desiredEnd - originalStartTime);
  }

  const timeScale = duration / originalDuration;
  return {
    startTime,
    duration,
    offset: originalOffset * timeScale,
    timeScale,
    playbackRateRatio: 1 / timeScale,
  };
}

function scaleMIDIEvents(events: MIDIEvent[] | undefined, timeScale: number): MIDIEvent[] {
  return (events || []).map((event) => ({
    ...event,
    timestamp: Math.max(0, event.timestamp * timeScale),
  }));
}

function scaleCCEvents(events: MIDICCEvent[] | undefined, timeScale: number): MIDICCEvent[] | undefined {
  if (!events) return undefined;
  return events.map((event) => ({
    ...event,
    time: Math.max(0, event.time * timeScale),
  }));
}

/** Scales every time-domain field in a MIDI clip as one coherent operation. */
export function createStretchedMIDIClip(
  clip: MIDIClip,
  startTime: number,
  duration: number,
): MIDIClip {
  const safeOriginalDuration = Math.max(EPSILON, finiteOr(clip.duration, EPSILON));
  const safeDuration = Math.max(EPSILON, finiteOr(duration, safeOriginalDuration));
  const timeScale = safeDuration / safeOriginalDuration;
  const scaleOptional = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, value * timeScale)
      : value;

  return {
    ...clip,
    startTime: Math.max(0, finiteOr(startTime, clip.startTime)),
    duration: safeDuration,
    offset: scaleOptional(clip.offset),
    sourceStart: scaleOptional(clip.sourceStart),
    sourceLength: scaleOptional(clip.sourceLength),
    loopOffset: scaleOptional(clip.loopOffset),
    loopLength: scaleOptional(clip.loopLength),
    events: scaleMIDIEvents(clip.events, timeScale),
    ccEvents: scaleCCEvents(clip.ccEvents, timeScale),
    quantizeBackup: clip.quantizeBackup
      ? {
          events: scaleMIDIEvents(clip.quantizeBackup.events, timeScale),
          ccEvents: scaleCCEvents(clip.quantizeBackup.ccEvents, timeScale),
        }
      : undefined,
  };
}

