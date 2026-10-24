import { describe, expect, it } from "vitest";

import {
  observeNAMOutputProtection,
  resolveNAMOutputProtectionCounter,
  namOutputProtectionMessage,
  resolveNAMEconomyQualityWarning,
  resolveNAMGainStagingWarning,
  resolveNAMModelIdentityWarning,
} from "../utils/namRackPresentationFeedback";

describe("NAM output protection history", () => {
  it("uses a modern final-output zero without relabelling upstream model reductions", () => {
    expect(resolveNAMOutputProtectionCounter({ rackOutputSafetyGuardHitCount: 0,
      pedalNAMOutputSafetyGuardHitCount: 40, ampNAMOutputSafetyGuardHitCount: 50 })).toEqual({ frames: 0, boundary: "output" });
    expect(resolveNAMOutputProtectionCounter({ rackOutputSafetyGuardHitCount: 12,
      pedalNAMOutputSafetyGuardHitCount: 40 })).toEqual({ frames: 12, boundary: "output" });
  });

  it("uses honest model-stage guidance only when the final counter is absent", () => {
    const counter = resolveNAMOutputProtectionCounter({ pedalNAMOutputSafetyGuardHitCount: 40, ampNAMOutputSafetyGuardHitCount: 50 });
    expect(counter).toEqual({ frames: 90, boundary: "models" });
    const baseline = observeNAMOutputProtection(null, "rack", counter.frames, 100, 1000, counter.boundary);
    const recent = observeNAMOutputProtection(baseline, "rack", 91, 101, 1100, counter.boundary);
    for (const [observation, now] of [[baseline, 1000], [recent, 1100]] as const) {
      expect(namOutputProtectionMessage(observation, now)).toContain("NAM model peaks");
      expect(namOutputProtectionMessage(observation, now)).toContain("Lower Input or the Level feeding the model");
      expect(namOutputProtectionMessage(observation, now)).not.toContain("Lower Output");
    }
    // Switching telemetry generations is a new baseline, not an event.
    const modern = observeNAMOutputProtection(recent, "rack", 100, 102, 1200, "output");
    expect(modern.recentUntilMs).toBe(0);
  });

  it("does not call an existing lifetime count current activity when an editor opens", () => {
    const observation = observeNAMOutputProtection(null, "rack-A", 18911, 20000, 1000);
    expect(observation.recentUntilMs).toBe(0);
    expect(namOutputProtectionMessage(observation, 1000)).toBe("Earlier output peaks were reduced. Lower Output if this happens again.");
  });

  it("warns only for observed increments, then becomes history without another telemetry update", () => {
    const baseline = observeNAMOutputProtection(null, "rack-A", 0, 100, 1000);
    const active = observeNAMOutputProtection(baseline, "rack-A", 10, 101, 1100);
    expect(namOutputProtectionMessage(active, 1100)).toBe("Output peaks reduced recently. Lower Output to avoid extra compression on loud notes.");
    const unchanged = observeNAMOutputProtection(active, "rack-A", 10, 200, 3000);
    expect(unchanged.recentUntilMs).toBe(4100);
    expect(namOutputProtectionMessage(unchanged, 4101)).toContain("Earlier");
    const repeated = observeNAMOutputProtection(unchanged, "rack-A", 11, 201, 4000);
    expect(repeated.recentUntilMs).toBe(7000);
  });

  it("resets recent activity on rack changes, counter decreases and native preparation", () => {
    const baseline = observeNAMOutputProtection(null, "rack-A", 10, 100, 0);
    const active = observeNAMOutputProtection(baseline, "rack-A", 20, 101, 100);
    for (const [rack, frames, blocks] of [["rack-B", 21, 102], ["rack-A", 5, 102], ["rack-A", 20, 1]] as const) {
      const reset = observeNAMOutputProtection(active, rack, frames, blocks, 200);
      expect(reset.recentUntilMs).toBe(0);
      expect(namOutputProtectionMessage(reset, 200)).toContain("Earlier");
    }
    expect(namOutputProtectionMessage(observeNAMOutputProtection(active, "rack-A", 0, 0, 200), 200)).toBeNull();
  });

  it("ignores invalid counts rather than creating an invalid warning", () => {
    for (const count of [NaN, Infinity, -1])
      expect(namOutputProtectionMessage(observeNAMOutputProtection(null, "rack", count, 0, 0), 0)).toBeNull();
  });
});

describe("NAM Rack presentation feedback", () => {
  it("flags a clear contradiction between the NAM label and embedded gear metadata", () => {
    expect(resolveNAMModelIdentityWarning({
      displayName: "Peavey 5150",
      metadataName: "Peavey 5150",
      gearMake: "Victory V30 The Countess",
      gearModel: "Victory V30 The Countess",
    })).toBe(
      "Embedded gear metadata identifies Victory V30 The Countess; the model label says “Peavey 5150”. Verify this Capture's identity.",
    );
  });

  it("reads nested preview metadata and stays quiet for matching or missing identity", () => {
    expect(resolveNAMModelIdentityWarning({
      displayName: "Countess V30 full rig",
      metadataSources: [{ namMetadata: { gear_make: "Victory", gear_model: "V30 The Countess" } }],
    })).toBeNull();
    expect(resolveNAMModelIdentityWarning({ displayName: "Peavey 5150" })).toBeNull();
  });

  it("treats a shared model number as an abbreviated match", () => {
    expect(resolveNAMModelIdentityWarning({
      metadataName: "5150 Lead",
      gearMake: "Peavey",
      gearModel: "5150",
    })).toBeNull();
  });

  it("still catches a conflicting visible listing when the internal NAM name matches", () => {
    expect(resolveNAMModelIdentityWarning({
      displayName: "Peavey 5150",
      metadataName: "Victory V30 The Countess",
      gearMake: "Victory",
      gearModel: "V30 The Countess",
    })).toContain('model label says “Peavey 5150”');
  });

  it("warns for the selected Victory preset's stacked Input, Drive Level, and Tight Boost", () => {
    expect(resolveNAMGainStagingWarning({
      inputTrimDb: 1.92,
      driveActive: true,
      driveLevelDb: 6,
      ampActive: true,
      ampBoostActive: true,
    })).toContain("Input +1.9 dB, Drive Level +6.0 dB, Tight Boost");
  });

  it("does not count bypassed stages or warn for neutral gain staging", () => {
    expect(resolveNAMGainStagingWarning({
      inputTrimDb: 1.92,
      driveActive: false,
      driveLevelDb: 12,
      ampActive: true,
      ampBoostActive: false,
    })).toBeNull();
    expect(resolveNAMGainStagingWarning({
      inputTrimDb: 12,
      driveActive: true,
      driveLevelDb: 12,
      ampActive: false,
      ampBoostActive: true,
    })).toBeNull();
  });

  it("does not suggest disabling Tight Boost when Tight Boost is already off", () => {
    const warning = resolveNAMGainStagingWarning({
      inputTrimDb: 7,
      driveActive: false,
      ampActive: true,
      ampBoostActive: false,
    });
    expect(warning).toContain("Reduce Input or Drive Level if noise or smear appears");
    expect(warning).not.toContain("disable Tight Boost");
  });

  it("provides compact guidance only for a loaded slimmable Economy amp", () => {
    expect(resolveNAMEconomyQualityWarning({
      hasAmpModel: true,
      slimmable: true,
      requestedQualityValue: 0,
      activeQualityValue: 0,
    })).toBe("Amp Quality is Economy. Set Amp Quality to Full for the highest-fidelity model graph.");
    expect(resolveNAMEconomyQualityWarning({
      hasAmpModel: true,
      slimmable: true,
      requestedQualityValue: 1,
      activeQualityValue: 1,
    })).toBeNull();
  });
});
