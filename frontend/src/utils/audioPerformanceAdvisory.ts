import {
  AUDIO_DEADLINE_RECENT_WINDOW_SECONDS,
  resolveAudioDeadlineStatus,
  type AudioDeadlineTelemetry,
  type AudioDeadlineStatus,
} from "./audioDeadlineStatus";
import type { AudioTrackExecutionDiagnostics } from "../services/NativeBridge";

export type AudioPerformanceTelemetry = AudioDeadlineTelemetry & {
  audioDeviceXRunCount?: number;
  trackExecution?: AudioTrackExecutionDiagnostics;
};

export type AudioTrackExecutionStatus = {
  deadlineMisses: number;
  rejectedTrackJobs: number;
  cancelledJobs: number;
  rejectedBatches: number;
  quarantinedBlocks: number;
  hasRecordedFailures: boolean;
  secondsSinceLastFailure?: number;
  recent: boolean;
  shouldWarn: boolean;
};

export const AUDIO_TRACK_EXECUTION_WARNING =
  "Track processing recently missed a deadline or skipped audio. This can cause dropouts even when the callback meter is low.";

export type AudioPerformanceAdvisory = {
  source: "none" | "device" | "openstudio" | "both";
  shouldWarn: boolean;
  deviceXRunCount: number;
  deadlineStatus: AudioDeadlineStatus;
  trackExecutionStatus: AudioTrackExecutionStatus;
};

function resolveTrackExecutionStatus(
  telemetry: AudioPerformanceTelemetry | null | undefined,
): AudioTrackExecutionStatus {
  const execution = telemetry?.trackExecution;
  const counts = {
    deadlineMisses: finiteNonNegativeInteger(execution?.deadlineMisses),
    rejectedTrackJobs: finiteNonNegativeInteger(execution?.rejectedTrackJobs),
    cancelledJobs: finiteNonNegativeInteger(execution?.cancelledJobs),
    rejectedBatches: finiteNonNegativeInteger(execution?.rejectedBatches),
    quarantinedBlocks: finiteNonNegativeInteger(execution?.quarantinedBlocks),
  };
  // These counters overlap and have different units; never add them together.
  const hasRecordedFailures = Object.values(counts).some((count) => count > 0);
  const currentCallback = finiteNonNegativeInteger(telemetry?.lastCallbackCounter);
  const lastFailureCallback = finiteNonNegativeInteger(execution?.lastFailureCallbackCounter);
  const blockSize = finiteNonNegativeInteger(telemetry?.blockSize);
  const sampleRate = finiteNonNegativeInteger(telemetry?.sampleRate);
  const secondsSinceLastFailure = currentCallback >= lastFailureCallback
    && lastFailureCallback > 0 && blockSize > 0 && sampleRate > 0
    ? (currentCallback - lastFailureCallback) * blockSize / sampleRate
    : undefined;
  const recent = hasRecordedFailures
    && secondsSinceLastFailure !== undefined
    && secondsSinceLastFailure <= AUDIO_DEADLINE_RECENT_WINDOW_SECONDS;

  return { ...counts, hasRecordedFailures, secondsSinceLastFailure, recent, shouldWarn: recent };
}

const finiteNonNegativeInteger = (value: unknown) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? Math.trunc(numericValue)
    : 0;
};

/**
 * Keeps JUCE's audio-device path x-run count separate from OpenStudio's own
 * callback-duration and track-execution telemetry. JUCE's count may include
 * native driver x-runs as well as load-measurer overruns, so it must not be
 * presented as purely driver-reported.
 */
export function resolveAudioPerformanceAdvisory(
  telemetry: AudioPerformanceTelemetry | null | undefined,
): AudioPerformanceAdvisory {
  const deviceXRunCount = finiteNonNegativeInteger(
    telemetry?.audioDeviceXRunCount,
  );
  const deadlineStatus = resolveAudioDeadlineStatus(telemetry);
  const trackExecutionStatus = resolveTrackExecutionStatus(telemetry);
  const devicePathTrouble = deviceXRunCount > 0;
  // Track work can be cancelled to meet the outer callback deadline. Even one
  // recent failed batch needs a warning regardless of the callback duration.
  const openStudioReportedTrouble = deadlineStatus.shouldWarn || trackExecutionStatus.shouldWarn;

  return {
    source: devicePathTrouble && openStudioReportedTrouble
      ? "both"
      : devicePathTrouble
        ? "device"
        : openStudioReportedTrouble
          ? "openstudio"
          : "none",
    shouldWarn: devicePathTrouble || openStudioReportedTrouble,
    deviceXRunCount,
    deadlineStatus,
    trackExecutionStatus,
  };
}
