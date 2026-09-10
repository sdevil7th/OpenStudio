import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { waitForPluginEditor } from "../utils/pluginActivity";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("plugin editor readiness", () => {
  it("keeps waiting after an accepted open request until the matching window is ready", async () => {
    vi.useFakeTimers();
    const query = vi.spyOn(nativeBridge, "getPluginEditorReadiness").mockResolvedValueOnce("opening").mockResolvedValueOnce("opening").mockResolvedValue("ready");
    const target = { sessionId: "monitor-rack" };
    let finished = false;
    const pending = waitForPluginEditor(target).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(query).toHaveBeenLastCalledWith(target);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports a failed frontend boot", async () => {
    vi.spyOn(nativeBridge, "getPluginEditorReadiness").mockResolvedValue("failed");
    await expect(waitForPluginEditor({ scope: "monitoring_fx", fxIndex: 0 })).rejects.toThrow("failed to start");
  });
  it.each([false, true])("times out instead of leaving a permanent loader (unresponsive bridge: %s)", async unresponsive => {
    vi.useFakeTimers();
    vi.spyOn(nativeBridge, "getPluginEditorReadiness").mockImplementation(() => unresponsive ? new Promise(() => {}) : Promise.resolve("opening"));
    const result = expect(waitForPluginEditor({ scope: "track_fx", trackId: "a", fxIndex: 2 }, 500)).rejects.toThrow("has not appeared yet");
    await vi.advanceTimersByTimeAsync(600);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
