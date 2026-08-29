import type { SnapType } from "./snapToGrid";
import type { TimelineClipGestureKind } from "./timelineClipGestures";

export type TimelineClipEdgeKind = "start" | "end";

export interface TimelineClipSnapShape {
  clipId: string;
  trackIndex: number;
  startTime: number;
  duration: number;
}

export interface TimelineClipSnapTrack {
  clips: readonly TimelineClipSnapShapeSource[];
  midiClips: readonly TimelineClipSnapShapeSource[];
}

interface TimelineClipSnapShapeSource {
  id: string;
  startTime: number;
  duration: number;
}

export interface TimelineClipEdgeSnapViewport {
  startTime: number;
  endTime: number;
  visibleTrackIndices: readonly number[];
}

export interface TimelineClipEdgeSnapMatch {
  movingClipId: string;
  movingEdge: TimelineClipEdgeKind;
  targetClipId: string;
  targetEdge: TimelineClipEdgeKind;
  targetTime: number;
  correctionTime: number;
  distancePx: number;
}

export interface TimelineClipEdgeSnapResult {
  deltaTime: number;
  match: TimelineClipEdgeSnapMatch | null;
}

export interface ResolveTimelineClipEdgeSnapOptions {
  movingClips: readonly TimelineClipSnapShape[];
  stationaryClips: readonly TimelineClipSnapShape[];
  rawDeltaTime: number;
  trackDelta: number;
  viewport: TimelineClipEdgeSnapViewport;
  pixelsPerSecond: number;
  thresholdPx?: number;
  excludeMovingClipIds?: boolean;
}

export const TIMELINE_CLIP_EDGE_SNAP_THRESHOLD_PX = 10;

const EVENT_CAPABLE_SNAP_TYPES = new Set<SnapType>([
  "events",
  "events_cursor",
  "events_grid_cursor",
  "shuffle",
]);

export function isTimelineClipEdgeSnapMode(snapType: SnapType): boolean {
  return EVENT_CAPABLE_SNAP_TYPES.has(snapType);
}

export function canApplyTimelineHorizontalSnap(
  axisLockRequested: boolean,
  axisLock: "x" | "y" | null | undefined,
): boolean {
  return !axisLockRequested || axisLock === "x";
}

export function shouldBypassTimelineDragSnap(
  modifierHeld: boolean,
  copyOnDrag: boolean,
): boolean {
  return modifierHeld && !copyOnDrag;
}

export function shouldStartTimelineCopyDrag(
  modifierHeld: boolean,
  dragType: TimelineClipGestureKind,
  clipLocked: boolean,
): boolean {
  return modifierHeld && dragType === "move" && !clipLocked;
}

export function snapshotTimelineClipGeometry(
  tracks: readonly TimelineClipSnapTrack[],
): TimelineClipSnapShape[] {
  const snapshot: TimelineClipSnapShape[] = [];
  tracks.forEach((track, trackIndex) => {
    for (const clip of [...track.clips, ...track.midiClips]) {
      snapshot.push({
        clipId: clip.id,
        trackIndex,
        startTime: clip.startTime,
        duration: clip.duration,
      });
    }
  });
  return snapshot;
}

const TIME_EPSILON = 0.0000001;

interface EdgeCandidate {
  clipId: string;
  edge: TimelineClipEdgeKind;
  time: number;
}

function edgeRank(edge: TimelineClipEdgeKind): number {
  return edge === "start" ? 0 : 1;
}

function compareEdges(a: EdgeCandidate, b: EdgeCandidate): number {
  if (Math.abs(a.time - b.time) > TIME_EPSILON) return a.time - b.time;
  const clipOrder = a.clipId.localeCompare(b.clipId);
  if (clipOrder !== 0) return clipOrder;
  return edgeRank(a.edge) - edgeRank(b.edge);
}

function isTimeVisible(time: number, startTime: number, endTime: number): boolean {
  return time >= startTime - TIME_EPSILON && time <= endTime + TIME_EPSILON;
}

function appendVisibleEdges(
  output: EdgeCandidate[],
  shape: TimelineClipSnapShape,
  startTime: number,
  viewportStart: number,
  viewportEnd: number,
): void {
  const endTime = startTime + Math.max(0, shape.duration);
  if (isTimeVisible(startTime, viewportStart, viewportEnd)) {
    output.push({ clipId: shape.clipId, edge: "start", time: startTime });
  }
  if (isTimeVisible(endTime, viewportStart, viewportEnd)) {
    output.push({ clipId: shape.clipId, edge: "end", time: endTime });
  }
}

export function clampTimelineClipGroupDelta(
  movingClips: readonly Pick<TimelineClipSnapShape, "startTime">[],
  requestedDeltaTime: number,
): number {
  if (movingClips.length === 0) return requestedDeltaTime;
  const earliestStart = Math.min(...movingClips.map((clip) => clip.startTime));
  return Math.max(-Math.max(0, earliestStart), requestedDeltaTime);
}

function compareMatches(a: TimelineClipEdgeSnapMatch, b: TimelineClipEdgeSnapMatch): number {
  if (Math.abs(a.distancePx - b.distancePx) > TIME_EPSILON) {
    return a.distancePx - b.distancePx;
  }
  if (Math.abs(a.targetTime - b.targetTime) > TIME_EPSILON) {
    return a.targetTime - b.targetTime;
  }
  const movingClipOrder = a.movingClipId.localeCompare(b.movingClipId);
  if (movingClipOrder !== 0) return movingClipOrder;
  const movingEdgeOrder = edgeRank(a.movingEdge) - edgeRank(b.movingEdge);
  if (movingEdgeOrder !== 0) return movingEdgeOrder;
  const targetClipOrder = a.targetClipId.localeCompare(b.targetClipId);
  if (targetClipOrder !== 0) return targetClipOrder;
  return edgeRank(a.targetEdge) - edgeRank(b.targetEdge);
}

/**
 * Resolves magnetic clip-edge snapping for a translated clip or clip group.
 *
 * Visibility is edge-specific: an intersecting clip does not participate when
 * the particular start/end edge is outside the horizontal viewport. Track
 * visibility is supplied by the timeline so vertically scrolled-out rows are
 * excluded too.
 */
export function resolveTimelineClipEdgeSnap(
  options: ResolveTimelineClipEdgeSnapOptions,
): TimelineClipEdgeSnapResult {
  const pixelsPerSecond = Math.max(TIME_EPSILON, options.pixelsPerSecond);
  const thresholdPx = Math.max(0, options.thresholdPx ?? TIMELINE_CLIP_EDGE_SNAP_THRESHOLD_PX);
  const rawDeltaTime = clampTimelineClipGroupDelta(options.movingClips, options.rawDeltaTime);
  if (options.movingClips.length === 0 || options.stationaryClips.length === 0) {
    return { deltaTime: rawDeltaTime, match: null };
  }

  const visibleTracks = new Set(options.viewport.visibleTrackIndices);
  const movingIds = new Set(options.movingClips.map((clip) => clip.clipId));
  const movingEdges: EdgeCandidate[] = [];
  const targetEdges: EdgeCandidate[] = [];

  for (const clip of options.movingClips) {
    if (!visibleTracks.has(clip.trackIndex + options.trackDelta)) continue;
    appendVisibleEdges(
      movingEdges,
      clip,
      clip.startTime + rawDeltaTime,
      options.viewport.startTime,
      options.viewport.endTime,
    );
  }

  for (const clip of options.stationaryClips) {
    if ((options.excludeMovingClipIds ?? true) && movingIds.has(clip.clipId)) continue;
    if (!visibleTracks.has(clip.trackIndex)) continue;
    appendVisibleEdges(
      targetEdges,
      clip,
      clip.startTime,
      options.viewport.startTime,
      options.viewport.endTime,
    );
  }

  movingEdges.sort(compareEdges);
  targetEdges.sort(compareEdges);

  let bestMatch: TimelineClipEdgeSnapMatch | null = null;
  for (const moving of movingEdges) {
    for (const target of targetEdges) {
      const correctionTime = target.time - moving.time;
      const distancePx = Math.abs(correctionTime) * pixelsPerSecond;
      if (distancePx > thresholdPx + TIME_EPSILON) continue;

      const candidateDelta = rawDeltaTime + correctionTime;
      if (options.movingClips.some((clip) => clip.startTime + candidateDelta < -TIME_EPSILON)) {
        continue;
      }

      const candidate: TimelineClipEdgeSnapMatch = {
        movingClipId: moving.clipId,
        movingEdge: moving.edge,
        targetClipId: target.clipId,
        targetEdge: target.edge,
        targetTime: target.time,
        correctionTime,
        distancePx,
      };
      if (!bestMatch || compareMatches(candidate, bestMatch) < 0) {
        bestMatch = candidate;
      }
    }
  }

  return bestMatch
    ? { deltaTime: rawDeltaTime + bestMatch.correctionTime, match: bestMatch }
    : { deltaTime: rawDeltaTime, match: null };
}
