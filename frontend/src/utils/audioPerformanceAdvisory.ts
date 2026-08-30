import {
  resolveAudioDeadlineStatus,
  type AudioDeadlineTelemetry,
  type AudioDeadlineStatus,
} from "./audioDeadlineStatus";

export type AudioPerformanceTelemetry = AudioDeadlineTelemetry & {
  audioDeviceXRunCount?: number;
};

export type AudioPerformanceAdvisory = {
  source: "none" | "device" | "openstudio" | "both";
  shouldWarn: boolean;
  deviceXRunCount: number;
  deadlineStatus: AudioDeadlineStatus;
};

const finiteNonNegativeInteger = (value: unknown) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? Math.trunc(numericValue)
    : 0;
};

/**
 * Keeps JUCE's audio-device path x-run count separate from OpenStudio's own
 * callback-duration telemetry. JUCE's count may include native driver x-runs
 * as well as load-measurer overruns, so it must not be presented as purely
 * driver-reported.
 */
export function resolveAudioPerformanceAdvisory(
  telemetry: AudioPerformanceTelemetry | null | undefined,
): AudioPerformanceAdvisory {
  const deviceXRunCount = finiteNonNegativeInteger(
    telemetry?.audioDeviceXRunCount,
  );
  const deadlineStatus = resolveAudioDeadlineStatus(telemetry);
  const devicePathTrouble = deviceXRunCount > 0;
  const openStudioReportedTrouble = deadlineStatus.shouldWarn;

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
  };
}
