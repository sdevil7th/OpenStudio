import { describe, expect, it } from "vitest";
import {
  resolveAudioPerformanceAdvisory,
  type AudioPerformanceTelemetry,
} from "../utils/audioPerformanceAdvisory";

const base: AudioPerformanceTelemetry = {
  blockSize: 480,
  sampleRate: 48000,
  lastCallbackCounter: 1000,
  audioCallbackDeadlineMissCount: 0,
  audioDeviceXRunCount: 0,
};

describe("audio performance advisory", () => {
  it.each([
    "deadlineMisses",
    "rejectedTrackJobs",
    "cancelledJobs",
    "rejectedBatches",
    "quarantinedBlocks",
  ] as const)("warns after one recent %s even when the outer callback meets its deadline", (counter) => {
    const advisory = resolveAudioPerformanceAdvisory({
      ...base,
      trackExecution: { [counter]: 1, lastFailureCallbackCounter: 999 },
    });

    expect(advisory).toMatchObject({
      source: "openstudio",
      shouldWarn: true,
      deviceXRunCount: 0,
      deadlineStatus: { shouldWarn: false },
      trackExecutionStatus: {
        [counter]: 1,
        hasRecordedFailures: true,
        secondsSinceLastFailure: 0.01,
        shouldWarn: true,
      },
    });
  });

  it("retains distinct lifetime counts after the recent warning expires", () => {
    const advisory = resolveAudioPerformanceAdvisory({
      ...base,
      lastCallbackCounter: 2000,
      trackExecution: {
        deadlineMisses: 2,
        rejectedTrackJobs: 3,
        cancelledJobs: 4,
        rejectedBatches: 1,
        quarantinedBlocks: 5,
        lastFailureCallbackCounter: 999,
      },
    });

    expect(advisory).toMatchObject({
      source: "none",
      shouldWarn: false,
      trackExecutionStatus: {
        deadlineMisses: 2,
        rejectedTrackJobs: 3,
        cancelledJobs: 4,
        rejectedBatches: 1,
        quarantinedBlocks: 5,
        hasRecordedFailures: true,
        secondsSinceLastFailure: 10.01,
        recent: false,
      },
    });
  });

  it("includes the ten-second boundary and clears immediately beyond it", () => {
    const telemetry = {
      ...base,
      lastCallbackCounter: 2000,
      trackExecution: { deadlineMisses: 1, lastFailureCallbackCounter: 1000 },
    };
    expect(resolveAudioPerformanceAdvisory(telemetry).shouldWarn).toBe(true);
    expect(resolveAudioPerformanceAdvisory({
      ...telemetry,
      lastCallbackCounter: 2001,
    }).shouldWarn).toBe(false);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1001])(
    "keeps incomplete or reset callback evidence diagnostic-only (%s)",
    (lastFailureCallbackCounter) => {
      expect(resolveAudioPerformanceAdvisory({
        ...base,
        trackExecution: { deadlineMisses: 1, lastFailureCallbackCounter },
      })).toMatchObject({
        shouldWarn: false,
        trackExecutionStatus: { hasRecordedFailures: true, recent: false },
      });
    },
  );

  it("ignores invalid failure counts and older backends without worker telemetry", () => {
    expect(resolveAudioPerformanceAdvisory(base).shouldWarn).toBe(false);
    expect(resolveAudioPerformanceAdvisory(undefined).shouldWarn).toBe(false);
    expect(resolveAudioPerformanceAdvisory({
      ...base,
      trackExecution: {
        deadlineMisses: Number.NaN,
        cancelledJobs: Number.POSITIVE_INFINITY,
        rejectedTrackJobs: -1,
        lastFailureCallbackCounter: 999,
      },
    }).trackExecutionStatus).toMatchObject({
      hasRecordedFailures: false,
      shouldWarn: false,
    });
  });

  it("keeps device-path xruns separate from recent track execution failures", () => {
    expect(resolveAudioPerformanceAdvisory({
      ...base,
      audioDeviceXRunCount: 2,
    })).toMatchObject({ source: "device", shouldWarn: true });
    expect(resolveAudioPerformanceAdvisory({
      ...base,
      audioDeviceXRunCount: 2,
      trackExecution: { deadlineMisses: 1, lastFailureCallbackCounter: 999 },
    })).toMatchObject({ source: "both", shouldWarn: true });
  });

  it("preserves the existing quiet policy for one idle callback-duration miss", () => {
    expect(resolveAudioPerformanceAdvisory({
      ...base,
      audioCallbackDeadlineMissCount: 1,
      audioCallbackDeadlineMissBurstCount: 1,
      lastAudioCallbackDeadlineMissCounter: 999,
    })).toMatchObject({
      source: "none",
      shouldWarn: false,
      deadlineStatus: { recent: true, shouldWarn: false },
    });
  });
});
