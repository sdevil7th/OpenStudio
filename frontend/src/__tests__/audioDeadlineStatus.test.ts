import { describe, expect, it } from "vitest";
import { resolveAudioDeadlineStatus } from "../utils/audioDeadlineStatus";

const base = {
  blockSize: 480,
  sampleRate: 48000,
  lastCallbackCounter: 1000,
  lastAudioCallbackDeadlineMissWhileRecording: false,
};

describe("audio deadline warning state", () => {
  it("stays quiet without deadline misses", () => {
    expect(resolveAudioDeadlineStatus(base)).toMatchObject({
      recent: false,
      recording: false,
      shouldWarn: false,
    });
  });

  it("keeps one recent idle miss in diagnostics without raising the banner", () => {
    expect(resolveAudioDeadlineStatus({
      ...base,
      audioCallbackDeadlineMissCount: 1,
      audioCallbackDeadlineMissBurstCount: 1,
      lastAudioCallbackDeadlineMissCounter: 999,
      lastAudioCallbackDeadlineMissProcessMs: 10.4,
    })).toMatchObject({
      recent: true,
      burstMissCount: 1,
      lastMissProcessMs: 10.4,
      shouldWarn: false,
    });
  });

  it("warns for a recent repeated idle burst", () => {
    expect(resolveAudioDeadlineStatus({
      ...base,
      audioCallbackDeadlineMissCount: 3,
      audioCallbackDeadlineMissBurstCount: 3,
      lastAudioCallbackDeadlineMissCounter: 995,
    })).toMatchObject({
      recent: true,
      burstMissCount: 3,
      shouldWarn: true,
    });
  });

  it("warns after one recent miss while actively recording", () => {
    expect(resolveAudioDeadlineStatus({
      ...base,
      lastAudioCallbackDeadlineMissWhileRecording: true,
      audioCallbackDeadlineMissCount: 1,
      audioCallbackDeadlineMissBurstCount: 1,
      lastAudioCallbackDeadlineMissCounter: 999,
    })).toMatchObject({
      recent: true,
      recording: true,
      shouldWarn: true,
    });
  });

  it("automatically clears an old burst while retaining its session count", () => {
    const status = resolveAudioDeadlineStatus({
      ...base,
      lastCallbackCounter: 2000,
      audioCallbackDeadlineMissCount: 4,
      audioCallbackDeadlineMissBurstCount: 4,
      lastAudioCallbackDeadlineMissCounter: 1,
    });

    expect(status.deviceSessionMissCount).toBe(4);
    expect(status.recent).toBe(false);
    expect(status.shouldWarn).toBe(false);
  });

  it("fails quiet for incomplete or reset telemetry", () => {
    expect(resolveAudioDeadlineStatus({
      ...base,
      audioCallbackDeadlineMissCount: 2,
      audioCallbackDeadlineMissBurstCount: 2,
      lastAudioCallbackDeadlineMissCounter: 1001,
    }).shouldWarn).toBe(false);
    expect(resolveAudioDeadlineStatus({
      audioCallbackDeadlineMissCount: 2,
      audioCallbackDeadlineMissBurstCount: 2,
    }).shouldWarn).toBe(false);
  });
});
