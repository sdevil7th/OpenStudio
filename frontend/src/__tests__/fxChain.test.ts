import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import {
  getFXChainSlots,
  notifyFXChainChanged,
  subscribeToFXChainChanged,
  waitForFXChainLength,
  waitForInstrumentPlugin,
} from "../utils/fxChain";

describe("fxChain helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the requested chain through the bridge", async () => {
    const getTrackFXSpy = vi
      .spyOn(nativeBridge, "getTrackFX")
      .mockResolvedValue([{ index: 0, name: "Compressor" }]);

    await expect(getFXChainSlots("track-1", "track")).resolves.toEqual([
      { index: 0, name: "Compressor" },
    ]);
    expect(getTrackFXSpy).toHaveBeenCalledWith("track-1");
  });

  it("waits for the chain length to grow before returning", async () => {
    const getTrackFXSpy = vi
      .spyOn(nativeBridge, "getTrackFX")
      .mockResolvedValueOnce([{ index: 0, name: "EQ" }])
      .mockResolvedValueOnce([{ index: 0, name: "EQ" }])
      .mockResolvedValueOnce([
        { index: 0, name: "EQ" },
        { index: 1, name: "ARA Plugin" },
      ]);

    const slots = await waitForFXChainLength("track-1", "track", 2, {
      attempts: 3,
      delayMs: 0,
    });

    expect(slots).toHaveLength(2);
    expect(slots[1]?.name).toBe("ARA Plugin");
    expect(getTrackFXSpy).toHaveBeenCalledTimes(3);
  });

  it("notifies subscribers when a chain changes", () => {
    const previousWindow = globalThis.window;
    globalThis.window = new EventTarget() as Window & typeof globalThis;

    const listener = vi.fn();
    const unsubscribe = subscribeToFXChainChanged(listener);

    notifyFXChainChanged({ trackId: "track-1", chainType: "track" });

    expect(listener).toHaveBeenCalledWith({
      trackId: "track-1",
      chainType: "track",
    });

    unsubscribe();
    globalThis.window = previousWindow;
  });

  it("waits for the expected instrument plugin to appear", async () => {
    const readInstrumentPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("other-plugin")
      .mockResolvedValueOnce("expected-plugin");

    await expect(
      waitForInstrumentPlugin(
        "track-1",
        "expected-plugin",
        readInstrumentPlugin,
        { attempts: 3, delayMs: 0 },
      ),
    ).resolves.toBe("expected-plugin");

    expect(readInstrumentPlugin).toHaveBeenCalledTimes(3);
    expect(readInstrumentPlugin).toHaveBeenNthCalledWith(1, "track-1");
  });
});
