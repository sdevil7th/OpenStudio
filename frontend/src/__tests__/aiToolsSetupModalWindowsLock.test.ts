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
});
