import { describe, expect, it } from "vitest";
import assistantPanelSource from "../components/AssistantPanel.tsx?raw";
import actionExecutionSource from "../assistant/executeAssistantActions.ts?raw";

describe("assistant panel chat controls", () => {
  it("exposes expected copy, resend, edit, clear, and setup controls", () => {
    expect(assistantPanelSource).toContain("Copy message");
    expect(assistantPanelSource).toContain("Copy conversation");
    expect(assistantPanelSource).toContain("Clear chat");
    expect(assistantPanelSource).toContain("Edit and resend");
    expect(assistantPanelSource).toContain("Resend message now");
    expect(assistantPanelSource).toContain("Open AI Tools Setup");
  });

  it("shows planner/analyzer split status and OpenStudio branding", () => {
    const stalePlaceholder = ["Ask", "Studio13"].join(" ");
    const staleRuntimeLine = ["Local Qwen runtime", "pending"].join(" ");

    expect(assistantPanelSource).toContain("Qwen planner:");
    expect(assistantPanelSource).toContain("Core music analyzer:");
    expect(assistantPanelSource).toContain("Ask OpenStudio...");
    expect(assistantPanelSource).not.toContain(stalePlaceholder);
    expect(assistantPanelSource).not.toContain(staleRuntimeLine);
  });

  it("reports setup as pending instead of generically completed", () => {
    expect(actionExecutionSource).toContain("Setup is still pending");
    expect(actionExecutionSource).toContain("core music analyzer");
    expect(actionExecutionSource).toContain("refreshAiToolsStatus(true)");
  });
});
