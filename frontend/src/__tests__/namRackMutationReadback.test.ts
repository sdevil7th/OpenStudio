import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  applyVerifiedNAMRackMutation,
  doesNAMRackMutationMatchReadback,
} from "../utils/namRackMutationReadback";

describe("NAM Rack mutation readback", () => {
  it("verifies scalar updates and normalized resource paths", () => {
    expect(doesNAMRackMutationMatchReadback({
      values: { cabEnabled: 1, ampMix: 0.5 },
      modelState: { cabIRPath: "C:/IRs/Studio.wav", hasCabIR: true },
    }, {
      values: { cabEnabled: 1, ampMix: 0.5 },
      modelState: { cabIRPath: "c:\\irs\\studio.wav" },
    }, "windows")).toBe(true);
  });

  it("preserves case-sensitive resource identity on macOS and Linux", () => {
    const state = {
      modelState: { cabIRPath: "/IR/A.wav", hasCabIR: true },
    };
    const patch = { modelState: { cabIRPath: "/IR/a.wav" } };

    expect(doesNAMRackMutationMatchReadback(state, patch, "linux")).toBe(false);
    expect(doesNAMRackMutationMatchReadback(state, patch, "macos")).toBe(false);
  });

  it("rejects false-positive writes and verifies explicit clears", () => {
    expect(doesNAMRackMutationMatchReadback({
      values: { cabEnabled: 0.5 },
      modelState: { cabIRPath: "C:/IRs/old.wav", hasCabIR: true },
    }, {
      values: { cabEnabled: 0 },
      modelState: { clearCabIR: true },
    })).toBe(false);

    expect(doesNAMRackMutationMatchReadback({
      values: { cabEnabled: 0 },
      modelState: { cabIRPath: "", hasCabIR: false },
    }, {
      values: { cabEnabled: 0 },
      modelState: { clearCabIR: true },
    })).toBe(true);
  });

  it("reports rejected, unverified, verified, and rejected-promise bridge paths", async () => {
    const patch = { values: { cabEnabled: 0 }, modelState: { clearCabIR: true } };
    const bridge = {
      setBuiltInPluginState: vi.fn(async () => false),
      getBuiltInPluginState: vi.fn(async () => ({
        values: { cabEnabled: 0 },
        modelState: { cabIRPath: "", hasCabIR: false },
      })),
    };

    await expect(applyVerifiedNAMRackMutation(bridge, {}, patch)).resolves.toBe("rejected");
    expect(bridge.getBuiltInPluginState).not.toHaveBeenCalled();

    bridge.setBuiltInPluginState.mockResolvedValueOnce(true);
    bridge.getBuiltInPluginState.mockResolvedValueOnce({
      values: { cabEnabled: 1 },
      modelState: { cabIRPath: "old.wav", hasCabIR: true },
    });
    await expect(applyVerifiedNAMRackMutation(bridge, {}, patch)).resolves.toBe("unverified");

    bridge.setBuiltInPluginState.mockResolvedValueOnce(true);
    bridge.getBuiltInPluginState.mockResolvedValueOnce({
      values: { cabEnabled: 0 },
      modelState: { cabIRPath: "", hasCabIR: false },
    });
    await expect(applyVerifiedNAMRackMutation(bridge, {}, patch)).resolves.toBe("verified");

    bridge.setBuiltInPluginState.mockRejectedValueOnce(new Error("native bridge failed"));
    await expect(applyVerifiedNAMRackMutation(bridge, {}, patch)).rejects.toThrow("native bridge failed");
  });
});
