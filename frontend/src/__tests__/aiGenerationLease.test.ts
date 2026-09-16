import { describe, expect, it } from "vitest";
import { AIGenerationLease } from "../utils/aiGenerationLease";

describe("AI generation reply ownership", () => {
  it("rejects replies from a cancelled request after another generation starts", () => {
    const lease = new AIGenerationLease();
    const old = lease.begin();
    lease.bind(old, "old");
    lease.invalidate();
    const current = lease.begin();
    lease.bind(current, "current");
    expect(lease.accepts(old, "old")).toBe(false);
    expect(lease.accepts(current, "old")).toBe(false);
    expect(lease.accepts(current, "current")).toBe(true);
    lease.bind(old, "old");
    expect(lease.accepts(current, "current")).toBe(true);
  });
  it("invalidates a pending start on unmount and permits unversioned mock progress", () => {
    const lease = new AIGenerationLease();
    const current = lease.begin();
    expect(lease.accepts(current)).toBe(true);
    lease.invalidate();
    expect(lease.accepts(current)).toBe(false);
  });
});
