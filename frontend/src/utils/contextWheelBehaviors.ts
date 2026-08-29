import type { WheelDeltaAccumulator } from "./wheelDeltaAccumulator";

export interface AnchoredVerticalZoomInput {
  itemHeight: number;
  scrollOffset: number;
  pointerOffset: number;
  amount: number;
  minItemHeight: number;
  maxItemHeight: number;
  maxScrollOffset: number;
  sensitivity?: number;
}

export interface AnchoredVerticalZoomResult {
  itemHeight: number;
  scrollOffset: number;
}

export interface TimelineVerticalScaleView {
  verticalOffset: number;
  spectrogramDbFloor: number;
  spectrogramScale: number;
}

export interface SpectrogramBandGeometry {
  bandIndex: number;
  y: number;
  height: number;
}

export const DEFAULT_TIMELINE_VERTICAL_SCALE_VIEW: TimelineVerticalScaleView = {
  verticalOffset: 0,
  spectrogramDbFloor: -60,
  spectrogramScale: 1,
};

export const TIMELINE_SCROLL_PADDING_SECONDS = 300;

export interface WheelResizeInput {
  currentSize: number;
  amount: number;
  minSize: number;
  maxSize: number;
  sensitivity?: number;
}

export interface WheelEditBurstController<T> {
  touch: (target: T) => void;
  commit: () => void;
  cancel: () => void;
  dispose: () => void;
  getActiveTarget: () => T | null;
}

export interface WheelEditBurstOptions<T> {
  idleMs: number;
  getKey: (target: T) => string;
  onBegin: (target: T) => void;
  onCommit: (target: T) => void;
}

export interface TimelineExtentClip {
  startTime: number;
  duration: number;
}

export interface TimelineExtentTrack {
  clips: readonly TimelineExtentClip[];
  midiClips: readonly TimelineExtentClip[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Returns the furthest visible audio/MIDI or active-recording endpoint. */
export function getTimelineVisibleContentEnd(
  tracks: readonly TimelineExtentTrack[],
  activeRecordingEnd?: number | null,
): number {
  let end = 0;
  for (const track of tracks) {
    for (const clip of [...track.clips, ...track.midiClips]) {
      if (!Number.isFinite(clip.startTime) || !Number.isFinite(clip.duration)) continue;
      end = Math.max(end, clip.startTime + Math.max(0, clip.duration));
    }
  }
  if (typeof activeRecordingEnd === "number" && Number.isFinite(activeRecordingEnd)) {
    end = Math.max(end, activeRecordingEnd);
  }
  return Math.max(0, end);
}

export interface TimelineZoomView {
  pixelsPerSecond: number;
  scrollX: number;
}

/** Fit the complete project extent into the currently visible Timeline width. */
export function getTimelineProjectFitView(
  tracks: readonly TimelineExtentTrack[],
  activeRecordingEnd: number | null | undefined,
  viewportWidth: number,
  minPixelsPerSecond = 1,
  maxPixelsPerSecond = 1000,
): TimelineZoomView | null {
  const extent = getTimelineVisibleContentEnd(tracks, activeRecordingEnd);
  const safeWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const minZoom = Number.isFinite(minPixelsPerSecond) ? Math.max(0.000001, minPixelsPerSecond) : 1;
  const maxZoom = Number.isFinite(maxPixelsPerSecond)
    ? Math.max(minZoom, maxPixelsPerSecond)
    : Math.max(minZoom, 1000);
  if (extent <= 0.000001 || safeWidth <= 0) return null;
  return {
    pixelsPerSecond: clamp(safeWidth / extent, minZoom, maxZoom),
    scrollX: 0,
  };
}

/** Fit a finite time range with a small margin and center it in the Timeline. */
export function getTimelineRangeFitView(
  startTime: number,
  endTime: number,
  viewportWidth: number,
  minPixelsPerSecond = 1,
  maxPixelsPerSecond = 1000,
  occupancy = 0.8,
): TimelineZoomView | null {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  const start = Math.min(startTime, endTime);
  const end = Math.max(startTime, endTime);
  const duration = end - start;
  const safeWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const safeOccupancy = Number.isFinite(occupancy) ? clamp(occupancy, 0.01, 1) : 0.8;
  const minZoom = Number.isFinite(minPixelsPerSecond) ? Math.max(0.000001, minPixelsPerSecond) : 1;
  const maxZoom = Number.isFinite(maxPixelsPerSecond)
    ? Math.max(minZoom, maxPixelsPerSecond)
    : Math.max(minZoom, 1000);
  if (duration <= 0.000001 || safeWidth <= 0) return null;
  const pixelsPerSecond = clamp((safeWidth * safeOccupancy) / duration, minZoom, maxZoom);
  const margin = (safeWidth - duration * pixelsPerSecond) / 2;
  return {
    pixelsPerSecond,
    scrollX: Math.max(0, start * pixelsPerSecond - Math.max(0, margin)),
  };
}

/**
 * Uses the same audio/MIDI/recording extent as the Timeline renderer and adds
 * its five-minute editing tail. Ruler and content scrolling share this clamp.
 */
export function getTimelineHorizontalScrollMax(
  tracks: readonly TimelineExtentTrack[],
  activeRecordingEnd: number | null | undefined,
  pixelsPerSecond: number,
  viewportWidth: number,
): number {
  const safeZoom = Math.max(0, Number.isFinite(pixelsPerSecond) ? pixelsPerSecond : 0);
  const safeWidth = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  return Math.max(
    0,
    (getTimelineVisibleContentEnd(tracks, activeRecordingEnd) + TIMELINE_SCROLL_PADDING_SECONDS)
      * safeZoom
      - safeWidth,
  );
}

/** Exact hit-test for Audacity's rendered waveform/spectrogram scale strip. */
export function getTimelineVerticalScaleSubtarget({
  stageX,
  scaleStripWidth,
  trackType,
  spectralView,
}: {
  stageX: number;
  scaleStripWidth: number;
  trackType: string | undefined;
  spectralView: boolean | undefined;
}): "waveform_scale" | "spectrogram_scale" | undefined {
  if (
    trackType !== "audio"
    || !Number.isFinite(stageX)
    || stageX < 0
    || stageX >= Math.max(0, scaleStripWidth)
  ) {
    return undefined;
  }
  return spectralView ? "spectrogram_scale" : "waveform_scale";
}

/**
 * Keeps all three independent Audacity scale-strip controls in one view model
 * so zoom never resets pan or the logarithmic lower dB limit (and vice versa).
 */
export function updateTimelineVerticalScaleView(
  view: TimelineVerticalScaleView,
  operation: "zoom" | "pan" | "db-floor",
  amount: number,
): TimelineVerticalScaleView {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  if (operation === "zoom") {
    return {
      ...view,
      spectrogramScale: computeWheelResizedSize({
        currentSize: view.spectrogramScale,
        amount: safeAmount,
        minSize: 0.25,
        maxSize: 8,
      }),
    };
  }
  if (operation === "pan") {
    return {
      ...view,
      verticalOffset: clamp(view.verticalOffset + safeAmount * 0.002, -1, 1),
    };
  }
  return {
    ...view,
    spectrogramDbFloor: clamp(view.spectrogramDbFloor + safeAmount * 0.05, -120, -20),
  };
}

/**
 * Derives clipped frequency-band rectangles from the per-track scale and pan.
 * A larger scale spreads bands away from the centre; pan translates the view.
 */
export function computeSpectrogramBandGeometry({
  height,
  bandCount,
  scale,
  verticalOffset,
}: {
  height: number;
  bandCount: number;
  scale: number;
  verticalOffset: number;
}): SpectrogramBandGeometry[] {
  const safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  const safeBandCount = Math.max(1, Math.floor(Number.isFinite(bandCount) ? bandCount : 1));
  const safeScale = clamp(Number.isFinite(scale) ? scale : 1, 0.25, 8);
  const safeOffset = clamp(Number.isFinite(verticalOffset) ? verticalOffset : 0, -1, 1);
  const baseBandHeight = safeHeight / safeBandCount;
  const scaledBandHeight = baseBandHeight * safeScale;
  const panPixels = safeOffset * safeHeight * 0.25;

  return Array.from({ length: safeBandCount }, (_, bandIndex) => {
    const baseCenter = safeHeight - (bandIndex + 0.5) * baseBandHeight;
    const scaledCenter = safeHeight / 2
      + (baseCenter - safeHeight / 2) * safeScale
      + panPixels;
    const rawTop = scaledCenter - scaledBandHeight / 2;
    const visibleTop = clamp(rawTop, 0, safeHeight);
    const visibleBottom = clamp(rawTop + scaledBandHeight, 0, safeHeight);
    return {
      bandIndex,
      y: visibleTop,
      height: Math.max(0, visibleBottom - visibleTop),
    };
  });
}

/** Selects the vertical pointer coordinate from the exact MIDI zoom target. */
export function getMidiNoteHeightZoomPointerOffset({
  target,
  stagePointerOffset,
  keyboardPointerOffset,
  gridHeight,
}: {
  target: "grid" | "keyboard" | "note";
  stagePointerOffset?: number;
  keyboardPointerOffset?: number;
  gridHeight: number;
}): number {
  const safeGridHeight = Math.max(0, Number.isFinite(gridHeight) ? gridHeight : 0);
  const requestedOffset = target === "keyboard"
    ? keyboardPointerOffset
    : stagePointerOffset;
  const fallback = safeGridHeight / 2;
  return clamp(
    typeof requestedOffset === "number" && Number.isFinite(requestedOffset)
      ? requestedOffset
      : fallback,
    0,
    safeGridHeight,
  );
}

/**
 * Resizes fixed-height vertical rows without moving the row under the pointer.
 * This is shared by Pro Tools/Ableton-style MIDI note-height wheel zoom.
 */
export function computeAnchoredVerticalWheelZoom({
  itemHeight,
  scrollOffset,
  pointerOffset,
  amount,
  minItemHeight,
  maxItemHeight,
  maxScrollOffset,
  sensitivity = 0.0015,
}: AnchoredVerticalZoomInput): AnchoredVerticalZoomResult {
  const safeItemHeight = clamp(
    Number.isFinite(itemHeight) ? itemHeight : minItemHeight,
    minItemHeight,
    maxItemHeight,
  );
  const safePointerOffset = Math.max(0, Number.isFinite(pointerOffset) ? pointerOffset : 0);
  const safeScrollOffset = Math.max(0, Number.isFinite(scrollOffset) ? scrollOffset : 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const rowAtPointer = (safeScrollOffset + safePointerOffset) / safeItemHeight;
  const nextItemHeight = clamp(
    safeItemHeight * Math.exp(-safeAmount * sensitivity),
    minItemHeight,
    maxItemHeight,
  );
  const nextScrollOffset = clamp(
    rowAtPointer * nextItemHeight - safePointerOffset,
    0,
    Math.max(0, maxScrollOffset),
  );

  return { itemHeight: nextItemHeight, scrollOffset: nextScrollOffset };
}

/** Exponential wheel resizing used for a hovered automation lane. */
export function computeWheelResizedSize({
  currentSize,
  amount,
  minSize,
  maxSize,
  sensitivity = 0.0015,
}: WheelResizeInput): number {
  const safeCurrentSize = clamp(
    Number.isFinite(currentSize) ? currentSize : minSize,
    minSize,
    maxSize,
  );
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return clamp(
    safeCurrentSize * Math.exp(-safeAmount * sensitivity),
    minSize,
    maxSize,
  );
}

/**
 * Groups a sequence of wheel events into one begin/live/commit transaction.
 * Switching targets commits the old target, and disposal commits pending work.
 */
export function createWheelEditBurstController<T>({
  idleMs,
  getKey,
  onBegin,
  onCommit,
}: WheelEditBurstOptions<T>): WheelEditBurstController<T> {
  let activeTarget: T | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = () => {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const commit = () => {
    clearIdleTimer();
    const target = activeTarget;
    activeTarget = null;
    if (target) onCommit(target);
  };

  const cancel = () => {
    clearIdleTimer();
    activeTarget = null;
  };

  const touch = (target: T) => {
    if (activeTarget && getKey(activeTarget) !== getKey(target)) commit();
    if (!activeTarget) {
      activeTarget = target;
      onBegin(target);
    }
    clearIdleTimer();
    idleTimer = setTimeout(commit, Math.max(0, idleMs));
  };

  return {
    touch,
    commit,
    cancel,
    dispose: commit,
    getActiveTarget: () => activeTarget,
  };
}

/** One signed step per 100px wheel notch, preserving fractional packet weight. */
export function getWheelStepCount(amount: number): number {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  return (amount < 0 ? 1 : -1) * (Math.abs(amount) / 100);
}

/** Target-isolated variant for discrete context controls and edit surfaces. */
export function getAccumulatedWheelStepCount(
  accumulator: WheelDeltaAccumulator,
  targetKey: string,
  amount: number,
): number {
  return getWheelStepCount(accumulator.consume(targetKey, amount));
}

/** Negative wheel delta moves earlier/up; positive moves later/down. */
export function getWheelNudgeDirection(amount: number): -1 | 0 | 1 {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  return amount < 0 ? -1 : 1;
}

/**
 * Discrete nudge/reorder helper. Use an accumulator with `quantum: 100` so a
 * stream of tiny packets produces one action only after one complete notch.
 */
export function getAccumulatedWheelNudgeDirection(
  accumulator: WheelDeltaAccumulator,
  targetKey: string,
  amount: number,
): -1 | 0 | 1 {
  return getWheelNudgeDirection(accumulator.consume(targetKey, amount));
}
