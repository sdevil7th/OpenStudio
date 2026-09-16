import { describe, expect, it, vi } from "vitest";
import { projectNativeQueue } from "../utils/projectNativeQueue";
import { advanceProjectEpoch, getProjectEpoch } from "../utils/projectLifetime";

describe("project native history queue", () => {
  it("orders rapid execute/undo/redo and continues after a rejected operation", async () => {
    const report = vi.fn();
    const enqueue = projectNativeQueue(getProjectEpoch(), report);
    const calls: string[] = [];
    const add = enqueue(async () => { await Promise.resolve(); calls.push("add"); });
    const undo = enqueue(async () => { calls.push("remove"); throw new Error("device changed"); });
    const redo = enqueue(async () => { calls.push("add"); });
    await add; await expect(undo).rejects.toThrow(); await redo;
    expect(calls).toEqual(["add", "remove", "add"]);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it("never recreates queued tracks in a replacement project", async () => {
    const enqueue = projectNativeQueue(getProjectEpoch(), vi.fn());
    const write = vi.fn();
    const pending = enqueue(write);
    advanceProjectEpoch();
    await pending;
    expect(write).not.toHaveBeenCalled();
  });
});
