import { describe, expect, it } from "vitest";
import {
  type AssistantActionPlan,
  planRequiresConfirmation,
  validateAssistantActionPlan,
} from "../assistant/actionSchema";

describe("assistant action schema", () => {
  it("requires confirmation for every non-empty plan", () => {
    const plan: AssistantActionPlan = {
      id: "plan_test",
      title: "Check status",
      intent: "Read local runtime status.",
      expectedImpact: "No project data is changed.",
      requiresConfirmation: false,
      actions: [
        {
          id: "act_status",
          kind: "ai.getRuntimeStatus",
          risk: "read",
          params: {},
        },
      ],
    };

    expect(planRequiresConfirmation(plan)).toBe(true);
  });

  it("accepts registered OpenStudio action execution plans", () => {
    const result = validateAssistantActionPlan({
      id: "plan_action",
      title: "Open mixer",
      intent: "Run an existing OpenStudio action.",
      expectedImpact: "Runs the selected registered action after confirmation.",
      requiresConfirmation: true,
      actions: [
        {
          id: "act_registered",
          kind: "app.executeRegisteredAction",
          risk: "ui",
          params: { actionId: "view.toggleMixer" },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects plugin add plans that do not identify the target track", () => {
    const result = validateAssistantActionPlan({
      id: "plan_plugin",
      title: "Add EQ",
      intent: "Add a plugin to a track.",
      expectedImpact: "Mutates an FX chain.",
      requiresConfirmation: true,
      actions: [
        {
          id: "act_plugin",
          kind: "plugin.add",
          risk: "project",
          params: {
            target: "track",
            pluginId: "builtin.eq",
            pluginType: "builtin",
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("plugin.add requires trackId");
  });

  it("rejects selected-clip placeholders before execution", () => {
    const result = validateAssistantActionPlan({
      id: "plan_clip",
      title: "Analyze clip",
      intent: "Open context generation.",
      expectedImpact: "Needs a real selected clip.",
      requiresConfirmation: true,
      actions: [
        {
          id: "act_clip",
          kind: "ai.openContextGeneration",
          risk: "ui",
          params: {
            trackId: "selectedTrackId",
            clipId: "selectedClipId",
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
  });
});
