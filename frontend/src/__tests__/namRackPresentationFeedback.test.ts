import { describe, expect, it } from "vitest";

import {
  resolveNAMEconomyQualityWarning,
  resolveNAMGainStagingWarning,
  resolveNAMModelIdentityWarning,
} from "../utils/namRackPresentationFeedback";

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
