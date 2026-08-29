import { describe, expect, it } from "vitest";
import {
  namRackTelemetryIntervalMs,
  shouldRefreshNAMRackDiagnostics,
} from "../utils/namRackTelemetryCadence";

describe("NAM Rack telemetry cadence", () => {
  it("publishes one 5 Hz combined update while the tuner is closed", () => {
    expect(namRackTelemetryIntervalMs(false)).toBe(200);
    expect([0, 1, 2, 3].map((tick) => shouldRefreshNAMRackDiagnostics(false, tick)))
      .toEqual([true, true, true, true]);
  });

  it("keeps tuner pitch at 10 Hz without transferring full diagnostics above 5 Hz", () => {
    expect(namRackTelemetryIntervalMs(true)).toBe(100);
    expect([0, 1, 2, 3, 4, 5].map((tick) => shouldRefreshNAMRackDiagnostics(true, tick)))
      .toEqual([true, false, true, false, true, false]);
  });
});
