import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";

const bridgeInternals = nativeBridge as unknown as { isNative: boolean };
const originalWindow = (globalThis as { window?: unknown }).window;

describe("native capability fallbacks", () => {
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

  it("does not claim a preset was saved when the native JSON writer is unavailable", async () => {
    await expect(nativeBridge.saveJsonDocumentToFile("C:/preset.ospreset", '{"name":"Pitch"}')).resolves.toBe(false);
  });

  it("forwards preset JSON to its dedicated endpoint and preserves failures", async () => {
    const saveJsonDocumentToFile = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("disk unavailable"));
    const saveProjectToFile = vi.fn();
    (globalThis as { window?: unknown }).window = { __JUCE__: { backend: { saveJsonDocumentToFile, saveProjectToFile } } };
    const path = "C:/preset.ospreset", json = '{"name":"Pitch","scaleMask":2741,"signalPath":1}';
    await expect(nativeBridge.saveJsonDocumentToFile(path, json)).resolves.toBe(true);
    expect(saveJsonDocumentToFile).toHaveBeenLastCalledWith(path, json);
    await expect(nativeBridge.saveJsonDocumentToFile(path, json)).resolves.toBe(false);
    await expect(nativeBridge.saveJsonDocumentToFile(path, json)).rejects.toThrow("disk unavailable");
    expect(saveProjectToFile).not.toHaveBeenCalled();
  });

  it("does not report a mock script success when the native Lua engine is unavailable", async () => {
    await expect(nativeBridge.executeScript("print('test')")).resolves.toMatchObject({ result: "", error: expect.stringContaining("unavailable") });
    await expect(nativeBridge.loadScriptFile("/missing/test.lua")).resolves.toMatchObject({ result: "", error: expect.stringContaining("unavailable") });
  });
});
