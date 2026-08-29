import { describe, expect, it, vi } from "vitest";
import {
  createNAMPreviewMonitorLease,
  markTrackMonitorUserMutation,
} from "../utils/trackMonitorOwnership";

function monitorHarness(trackId: string, initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
  const setTransient = vi.fn(async (_trackId: string, next: boolean) => {
    enabled = next;
    return true;
  });
  const lease = createNAMPreviewMonitorLease({
    read: (candidate) => candidate === trackId ? enabled : undefined,
    setTransient,
  });
  return {
    lease,
    setTransient,
    read: () => enabled,
    set: (next: boolean) => { enabled = next; },
  };
}

describe("NAM preview track-monitor ownership", () => {
  it("temporarily enables an off track once across capture switches and restores it on Stop", async () => {
    const harness = monitorHarness("monitor-stop", false);

    await expect(harness.lease.ensureEnabled("monitor-stop")).resolves.toBe(true);
    await expect(harness.lease.ensureEnabled("monitor-stop")).resolves.toBe(true);
    expect(harness.read()).toBe(true);
    expect(harness.setTransient).toHaveBeenCalledTimes(1);

    await expect(harness.lease.release()).resolves.toBe(true);
    expect(harness.read()).toBe(false);
    expect(harness.setTransient).toHaveBeenLastCalledWith("monitor-stop", false);
  });

  it("does not claim or disable monitoring that was already on", async () => {
    const harness = monitorHarness("monitor-existing", true);

    await expect(harness.lease.ensureEnabled("monitor-existing")).resolves.toBe(true);
    await expect(harness.lease.release()).resolves.toBe(true);
    expect(harness.setTransient).not.toHaveBeenCalled();
    expect(harness.read()).toBe(true);
  });

  it("never restores over an explicit user monitor change during audition", async () => {
    const harness = monitorHarness("monitor-user-owned", false);
    await harness.lease.ensureEnabled("monitor-user-owned");

    markTrackMonitorUserMutation("monitor-user-owned");
    harness.set(false);
    await expect(harness.lease.ensureEnabled("monitor-user-owned")).resolves.toBe(false);
    markTrackMonitorUserMutation("monitor-user-owned");
    harness.set(true);

    await expect(harness.lease.release()).resolves.toBe(true);
    expect(harness.read()).toBe(true);
    expect(harness.setTransient).toHaveBeenCalledTimes(1);
  });

  it("relinquishes a raced enable to the user and propagates native failures", async () => {
    let enabled = false;
    let finish: ((value: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const setTransient = vi.fn(async () => pending);
    const lease = createNAMPreviewMonitorLease({
      read: () => enabled,
      setTransient,
    });

    const enabling = lease.ensureEnabled("monitor-race");
    markTrackMonitorUserMutation("monitor-race");
    enabled = true;
    finish?.(true);
    await expect(enabling).resolves.toBe(true);
    await expect(lease.release()).resolves.toBe(true);
    expect(setTransient).toHaveBeenCalledTimes(1);

    const failed = createNAMPreviewMonitorLease({
      read: () => false,
      setTransient: async () => false,
    });
    await expect(failed.ensureEnabled("monitor-false")).resolves.toBe(false);
    await expect(failed.release()).resolves.toBe(true);

    const rejected = createNAMPreviewMonitorLease({
      read: () => false,
      setTransient: async () => { throw new Error("bridge unavailable"); },
    });
    await expect(rejected.ensureEnabled("monitor-reject")).rejects.toThrow("bridge unavailable");
    await expect(rejected.release()).resolves.toBe(true);
  });
});
