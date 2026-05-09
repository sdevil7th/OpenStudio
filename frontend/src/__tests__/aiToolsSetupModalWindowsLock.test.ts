import { describe, expect, it } from "vitest";
import modalSource from "../components/AiToolsSetupModal.tsx?raw";

describe("AI tools setup modal Windows lock guidance", () => {
  it("keeps the runtime lock failure reasons and recovery copy in the modal", () => {
    expect(modalSource).toContain("runtime_locked_rebuild_failed");
    expect(modalSource).toContain("runtime_rebuild_remove_failed");
    expect(modalSource).toContain("runtime-only rebuild");
    expect(modalSource).toContain("Retry keeps the downloaded stem models and ACE-Step checkpoints in place.");
    expect(modalSource).toContain("Reset AI Tools");
  });

  it("shows the core music analyzer separately from the Qwen planner", () => {
    expect(modalSource).toContain("Qwen planner runtime");
    expect(modalSource).toContain("Core music analyzer runtime");
    expect(modalSource).toContain("single_verified_profile");
    expect(modalSource).toContain("MiDashengLM");
    expect(modalSource).toContain("Apache-2.0");
  });
});
