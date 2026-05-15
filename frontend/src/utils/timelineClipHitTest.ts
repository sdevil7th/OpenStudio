import {
  getTimelineRowMetrics,
  type AudioClip,
  type MIDIClip,
  type Track,
} from "../store/useDAWStore";

export interface TimelineClipHit {
  clipId: string;
  trackId: string;
  trackIndex: number;
  kind: "audio" | "midi";
  edge: "left" | "right" | "body";
  x: number;
  y: number;
  width: number;
  height: number;
  clip: AudioClip | MIDIClip;
}

interface BuildTimelineClipHitMapArgs {
  tracks: Track[];
  trackYs: number[];
  trackHeight: number;
  pixelsPerSecond: number;
  scrollX: number;
}

export function buildTimelineClipHitMap({
  tracks,
  trackYs,
  trackHeight,
  pixelsPerSecond,
  scrollX,
}: BuildTimelineClipHitMapArgs): TimelineClipHit[] {
  const hits: TimelineClipHit[] = [];

  tracks.forEach((track, trackIndex) => {
    const rowMetrics = getTimelineRowMetrics(track, trackHeight);
    const y = (trackYs[trackIndex] ?? 0) + rowMetrics.clipInsetY;
    const height = rowMetrics.clipHeight;

    for (const clip of track.clips) {
      hits.push({
        clipId: clip.id,
        trackId: track.id,
        trackIndex,
        kind: "audio",
        edge: "body",
        x: clip.startTime * pixelsPerSecond - scrollX,
        y,
        width: Math.max(0, clip.duration * pixelsPerSecond),
        height,
        clip,
      });
    }

    for (const clip of track.midiClips) {
      hits.push({
        clipId: clip.id,
        trackId: track.id,
        trackIndex,
        kind: "midi",
        edge: "body",
        x: clip.startTime * pixelsPerSecond - scrollX,
        y,
        width: Math.max(0, clip.duration * pixelsPerSecond),
        height,
        clip,
      });
    }
  });

  return hits;
}

export function findTimelineClipHit(
  hits: TimelineClipHit[],
  stageX: number,
  stageY: number,
  edgeThreshold = 8,
): TimelineClipHit | null {
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index];
    if (
      stageX >= hit.x
      && stageX <= hit.x + hit.width
      && stageY >= hit.y
      && stageY <= hit.y + hit.height
    ) {
      const relativeX = stageX - hit.x;
      return {
        ...hit,
        edge: relativeX < edgeThreshold
          ? "left"
          : relativeX > hit.width - edgeThreshold
            ? "right"
            : "body",
      };
    }
  }

  return null;
}
