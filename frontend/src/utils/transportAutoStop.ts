import type { Track, TransportState } from "../store/useDAWStore";

const EPSILON_SECONDS = 0.000001;

export type TrackWithArrangementClips = Pick<Track, "clips" | "midiClips">;

export interface PlaybackContentBounds {
  hasContent: boolean;
  latestEndTime: number;
  loopHasContent: boolean;
}

export type AutoStopReason = "empty" | "silent-loop" | "end-of-content";

export interface AutoStopPlaybackDecision {
  shouldStop: boolean;
  reason: AutoStopReason | null;
  stopTime: number | null;
  bounds: PlaybackContentBounds;
}

type TransportAutoStopState = Pick<
  TransportState,
  "isPlaying" | "isRecording" | "currentTime" | "loopEnabled" | "loopStart" | "loopEnd"
>;

interface LoopRange {
  loopEnabled?: boolean;
  loopStart?: number;
  loopEnd?: number;
}

interface ShouldAutoStopPlaybackOptions {
  tracks: readonly TrackWithArrangementClips[];
  transport: TransportAutoStopState;
  metronomeEnabled: boolean;
  nextTime: number;
}

function isFiniteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidLoopRange(range?: LoopRange): boolean {
  return Boolean(
    range?.loopEnabled
      && isFiniteTime(range.loopStart)
      && isFiniteTime(range.loopEnd)
      && range.loopEnd > range.loopStart + EPSILON_SECONDS,
  );
}

function clipOverlapsRange(startTime: number, endTime: number, rangeStart: number, rangeEnd: number) {
  return startTime < rangeEnd - EPSILON_SECONDS && endTime > rangeStart + EPSILON_SECONDS;
}

function getValidClipEnd(clip: { startTime: number; duration: number }) {
  const startTime = clip.startTime;
  const duration = clip.duration;
  if (!isFiniteTime(startTime) || !isFiniteTime(duration) || duration <= EPSILON_SECONDS) {
    return null;
  }

  const endTime = startTime + duration;
  if (!isFiniteTime(endTime) || endTime <= startTime + EPSILON_SECONDS) {
    return null;
  }

  return endTime;
}

export function getPlaybackContentBounds(
  tracks: readonly TrackWithArrangementClips[],
  loopRange?: LoopRange,
): PlaybackContentBounds {
  const validLoop = hasValidLoopRange(loopRange);
  const loopStart = validLoop ? loopRange!.loopStart! : 0;
  const loopEnd = validLoop ? loopRange!.loopEnd! : 0;
  let hasContent = false;
  let latestEndTime = 0;
  let loopHasContent = false;

  for (const track of tracks) {
    for (const clip of track.clips ?? []) {
      const endTime = getValidClipEnd(clip);
      if (endTime === null) {
        continue;
      }

      hasContent = true;
      latestEndTime = Math.max(latestEndTime, endTime);

      if (validLoop && clipOverlapsRange(clip.startTime, endTime, loopStart, loopEnd)) {
        loopHasContent = true;
      }
    }

    for (const clip of track.midiClips ?? []) {
      const endTime = getValidClipEnd(clip);
      if (endTime === null) {
        continue;
      }

      hasContent = true;
      latestEndTime = Math.max(latestEndTime, endTime);

      if (validLoop && clipOverlapsRange(clip.startTime, endTime, loopStart, loopEnd)) {
        loopHasContent = true;
      }
    }
  }

  return { hasContent, latestEndTime, loopHasContent };
}

export function shouldAutoStopPlayback({
  tracks,
  transport,
  metronomeEnabled,
  nextTime,
}: ShouldAutoStopPlaybackOptions): AutoStopPlaybackDecision {
  const bounds = getPlaybackContentBounds(tracks, transport);
  const keepPlaying = (reason: AutoStopReason | null = null): AutoStopPlaybackDecision => ({
    shouldStop: false,
    reason,
    stopTime: null,
    bounds,
  });

  if (!transport.isPlaying || transport.isRecording || metronomeEnabled || !isFiniteTime(nextTime)) {
    return keepPlaying();
  }

  if (!bounds.hasContent) {
    return {
      shouldStop: true,
      reason: "empty",
      stopTime: isFiniteTime(transport.currentTime) ? transport.currentTime : null,
      bounds,
    };
  }

  if (hasValidLoopRange(transport)) {
    if (!bounds.loopHasContent) {
      return {
        shouldStop: true,
        reason: "silent-loop",
        stopTime: isFiniteTime(transport.currentTime) ? transport.currentTime : null,
        bounds,
      };
    }

    return keepPlaying();
  }

  if (nextTime >= bounds.latestEndTime - EPSILON_SECONDS) {
    const crossingEndFromBefore = isFiniteTime(transport.currentTime)
      && transport.currentTime < bounds.latestEndTime;
    return {
      shouldStop: true,
      reason: "end-of-content",
      stopTime: crossingEndFromBefore ? bounds.latestEndTime : transport.currentTime,
      bounds,
    };
  }

  return keepPlaying();
}
