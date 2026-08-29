import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeBridge } from "../services/NativeBridge";

const bridgeInternals = nativeBridge as unknown as { isNative: boolean };
const originalWindow = (globalThis as { window?: unknown }).window;

describe("NAM native capability fallbacks", () => {
  beforeEach(() => {
    bridgeInternals.isNative = true;
    (globalThis as { window?: unknown }).window = { __JUCE__: { backend: {} } };
  });

  afterEach(() => {
    bridgeInternals.isNative = false;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("reports missing endpoints as unsupported inside a native host", async () => {
    await expect(nativeBridge.getNAMRackOversamplingFactor()).rejects.toThrow("does not support");
    await expect(nativeBridge.setNAMRackOversamplingFactor(8)).resolves.toBe(false);
    await expect(nativeBridge.setNAMTunerActive("track-a", true, "subscriber-a")).resolves.toBe(false);
    await expect(nativeBridge.setTrackInputMonitoring("track-a", true)).resolves.toBe(false);
  });

  it("retains deterministic mocks for frontend-only development", async () => {
    bridgeInternals.isNative = false;
    await expect(nativeBridge.setNAMRackOversamplingFactor(8)).resolves.toBe(true);
    await expect(nativeBridge.getNAMRackOversamplingFactor()).resolves.toBe(8);
    await expect(nativeBridge.setNAMTunerActive("track-a", true, "subscriber-a")).resolves.toBe(true);
    await expect(nativeBridge.setTrackInputMonitoring("track-a", true)).resolves.toBe(true);
  });
});
