import { describe, expect, it, vi } from "vitest";

import { persistOptimisticNAMRackOrder } from "../utils/namRackOrderPersistence";

describe("NAM Rack post-FX order persistence", () => {
  it("keeps an optimistic order after native persistence succeeds", async () => {
    const applied: string[][] = [];
    const result = await persistOptimisticNAMRackOrder({
      previousOrder: ["eq", "mod", "delay", "reverb"],
      nextOrder: ["delay", "eq", "mod", "reverb"],
      applyOrder: (order) => applied.push(order),
      persistOrder: vi.fn().mockResolvedValue(true),
    });

    expect(result).toEqual({ ok: true });
    expect(applied).toEqual([["delay", "eq", "mod", "reverb"]]);
  });

  it("restores the exact previous order and reports a useful error on false", async () => {
    const applied: string[][] = [];
    const result = await persistOptimisticNAMRackOrder({
      previousOrder: ["eq", "mod", "delay", "reverb"],
      nextOrder: ["reverb", "delay", "mod", "eq"],
      applyOrder: (order) => applied.push(order),
      persistOrder: vi.fn().mockResolvedValue(false),
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("previous order was restored");
    expect(applied).toEqual([
      ["reverb", "delay", "mod", "eq"],
      ["eq", "mod", "delay", "reverb"],
    ]);
  });

  it("rolls back when the bridge rejects", async () => {
    const applied: string[][] = [];
    const result = await persistOptimisticNAMRackOrder({
      previousOrder: ["eq", "mod"],
      nextOrder: ["mod", "eq"],
      applyOrder: (order) => applied.push(order),
      persistOrder: vi.fn().mockRejectedValue(new Error("bridge disconnected")),
    });

    expect(result.ok).toBe(false);
    expect(applied[applied.length - 1]).toEqual(["eq", "mod"]);
  });
});
