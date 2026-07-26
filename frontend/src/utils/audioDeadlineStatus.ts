export const AUDIO_DEADLINE_RECENT_WINDOW_SECONDS = 10;

export type AudioDeadlineTelemetry = {
  blockSize?: number;
  sampleRate?: number;
  lastCallbackCounter?: number;
  audioCallbackDeadlineMissCount?: number;
  lastAudioCallbackDeadlineMissCounter?: number;
  audioCallbackDeadlineMissBurstCount?: number;
  lastAudioCallbackDeadlineMissProcessMs?: number;
  lastAudioCallbackDeadlineMissWhileRecording?: boolean;
};

export type AudioDeadlineStatus = {
  deviceSessionMissCount: number;
  burstMissCount: number;
  lastMissProcessMs: number;
  secondsSinceLastMiss?: number;
  recent: boolean;
  recording: boolean;
  shouldWarn: boolean;
};

function finiteNonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * Turns monotonic audio-callback telemetry into user-facing health state.
 *
 * The native miss count is diagnostic evidence that OpenStudio processing took
 * longer than one device block. It is not a driver-reported xrun. A banner is
 * therefore limited to a recent burst, except that one recent miss while
 * actively recording is important enough to surface immediately.
 */
export function resolveAudioDeadlineStatus(
  telemetry: AudioDeadlineTelemetry | null | undefined,
  recentWindowSeconds = AUDIO_DEADLINE_RECENT_WINDOW_SECONDS,
): AudioDeadlineStatus {
  const deviceSessionMissCount = Math.trunc(finiteNonNegative(telemetry?.audioCallbackDeadlineMissCount));
  const burstMissCount = Math.trunc(finiteNonNegative(telemetry?.audioCallbackDeadlineMissBurstCount));
  const lastMissProcessMs = finiteNonNegative(telemetry?.lastAudioCallbackDeadlineMissProcessMs);
  const currentCallback = Math.trunc(finiteNonNegative(telemetry?.lastCallbackCounter));
  const lastMissCallback = Math.trunc(finiteNonNegative(telemetry?.lastAudioCallbackDeadlineMissCounter));
  const blockSize = finiteNonNegative(telemetry?.blockSize);
  const sampleRate = finiteNonNegative(telemetry?.sampleRate);
  const recording = Boolean(telemetry?.lastAudioCallbackDeadlineMissWhileRecording);

  const countersAreOrdered =
    currentCallback > 0
    && lastMissCallback > 0
    && currentCallback >= lastMissCallback;
  const blockDurationSeconds = blockSize > 0 && sampleRate > 0
    ? blockSize / sampleRate
    : 0;
  const secondsSinceLastMiss = countersAreOrdered && blockDurationSeconds > 0
    ? (currentCallback - lastMissCallback) * blockDurationSeconds
    : undefined;
  const recent = Boolean(
    deviceSessionMissCount > 0
    && secondsSinceLastMiss !== undefined
    && secondsSinceLastMiss <= Math.max(0, recentWindowSeconds),
  );

  return {
    deviceSessionMissCount,
    burstMissCount,
    lastMissProcessMs,
    secondsSinceLastMiss,
    recent,
    recording,
    shouldWarn: recent && (recording || burstMissCount >= 2),
  };
}
