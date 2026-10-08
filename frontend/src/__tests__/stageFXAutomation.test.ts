import type { FXStageSlotState } from "../services/fxStageState";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { useDAWStore, type AutomationLane } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import { editFXStage } from "../utils/stageFXHistory";
import { advanceProjectEpoch } from "../utils/projectLifetime";
const initial = useDAWStore.getState();
const settle = async () => { for (let index = 0; index < 50; ++index) await Promise.resolve(); };
const lane: AutomationLane = { id: "stage", param: "builtin_master_instance_fingerprint:gainDb", label: "Master Gain: Gain",
  points: [{ id: "p", time: 1, value: .25 }], visible: true, mode: "read", readEnabled: true, armed: false };
beforeEach(() => {
  commandManager.clear(); useDAWStore.setState({ ...initial, masterAutomationLanes: [lane], masterAutomationReadEnabled: true });
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial); });
describe("stable stage envelope identity", () => {
  it("keeps envelopes on reorder, prunes removal and restores the same UUID with undo", async () => {
    let stage = [fxSlot({ automationKey: "instance" }), fxSlot({ automationKey: "other" })];
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(stage));
    const restore = vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, state) => { stage = structuredClone(state); return true; });
    await editFXStage("master", "Reorder", async () => { stage.reverse(); return true; });
    expect(useDAWStore.getState().masterAutomationLanes).toEqual([lane]);
    await editFXStage("master", "Remove", async () => { stage = stage.filter(slot => slot.automationKey !== "instance"); return true; });
    expect(useDAWStore.getState().masterAutomationLanes).toEqual([]);
    useDAWStore.getState().undo(); await settle();
    expect(restore).toHaveBeenCalledWith("master", [fxSlot({ automationKey: "other" }), fxSlot({ automationKey: "instance" })]);
    expect(useDAWStore.getState().masterAutomationLanes).toEqual([lane]);
    useDAWStore.getState().redo(); await settle();
    expect(useDAWStore.getState().masterAutomationLanes).toEqual([]);
  });
  it("retains envelopes and history when the native mutation is rejected", async () => {
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValue([fxSlot({ automationKey: "instance" })]);
    expect(await editFXStage("master", "Rejected", async () => false)).toBe(false);
    expect(useDAWStore.getState().masterAutomationLanes).toEqual([lane]);
    expect(commandManager.canUndo()).toBe(false);
  });

  it.each([false, true])("rebinds restored SDK identity before Read, with changedMeaning=%s", async changedMeaning => {
    const param = "plugin_master_instance_fingerprint:0", updated = "plugin_master_instance_fingerprint:7";
    const saved = { ...lane, param, metadata: { name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-v1" } };
    let stage = [fxSlot({ automationKey: "instance", pluginPath: "vendor.vst3" })];
    useDAWStore.setState({ masterAutomationLanes: [saved] });
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(stage));
    const restore = vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, state) => { stage = structuredClone(state); return true; });
    vi.spyOn(nativeBridge, "getMasterFX").mockImplementation(async () => stage.map((slot, index) => ({ ...slot, index, name: "Vendor" })));
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 7, name: "Gain", hostParamId: "sdk-gain", meaningSignature: changedMeaning ? "gain-v2" : "gain-v1", value: .5, text: "", automationId: updated }]);
    await editFXStage("master", "Remove", async () => { stage = []; return true; });
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().masterAutomationLanes).toHaveLength(1));
    const restored = useDAWStore.getState().masterAutomationLanes[0];
    expect(restored.points).toEqual(saved.points);
    expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("master", param, []);
    expect(vi.mocked(nativeBridge.setAutomationPoints).mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
    if (changedMeaning) {
      expect(restored.unavailableParameter?.param).toBe(param);
      expect(nativeBridge.setAutomationPoints).not.toHaveBeenCalledWith("master", updated, [{ time: 1, value: .25 }]);
    } else {
      await vi.waitFor(() => expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("master", updated, [{ time: 1, value: .25 }]));
      expect(restored.param).toBe(updated);
    }
  });

  it("rolls back an incompatible Safe undo and retains the current stage", async () => {
    const param = "plugin_master_instance_fingerprint:0";
    let stage = [fxSlot({ automationKey: "instance", pluginPath: "vendor.vst3" })];
    useDAWStore.setState({ masterAutomationLanes: [], masterAutomationSafeParams: [param], masterAutomationSafeParameters: [{ param, metadata: { name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-v1" } }] });
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(stage));
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, state) => { stage = structuredClone(state); return true; });
    vi.spyOn(nativeBridge, "getMasterFX").mockImplementation(async () => stage.map((slot, index) => ({ ...slot, index, name: "Vendor" })));
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 7, name: "Different", hostParamId: "sdk-gain", meaningSignature: "different", value: .5, text: "", automationId: param.replace(/:0$/, ":7") }]);
    const toast = vi.spyOn(useDAWStore.getState(), "showToast");
    await editFXStage("master", "Remove", async () => { stage = []; return true; });
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("Automation Safe"), "error"));
    expect(stage).toEqual([]);
    expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([]);
  });

  it.each(["reject", "throw"])("blocks Save when incompatible Safe undo cannot roll back: %s", async failure => {
    const param = "plugin_master_instance_fingerprint:0";
    let stage = [fxSlot({ automationKey: "instance", pluginPath: "vendor.vst3" })];
    useDAWStore.setState({ masterAutomationLanes: [], masterAutomationSafeParams: [param], masterAutomationSafeParameters: [{ param, metadata: { name: "Gain", hostParamId: "sdk-gain", meaningSignature: "gain-v1" } }] });
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(stage));
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, slots) => {
      if (!slots.length) {
        if (failure === "throw") throw new Error("Disconnected");
        return false;
      }
      stage = structuredClone(slots);
      return true;
    });
    vi.spyOn(nativeBridge, "getMasterFX").mockImplementation(async () => stage.map((slot, index) => ({ ...slot, index, name: "Vendor" })));
    vi.spyOn(nativeBridge, "getPluginParameters").mockResolvedValue([{ index: 7, name: "Different", hostParamId: "sdk-gain", meaningSignature: "different", value: .5, text: "", automationId: param.replace(/:0$/, ":7") }]);
    await editFXStage("master", "Remove", async () => { stage = []; return true; });
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(useDAWStore.getState().projectRestoreError).toContain("FX undo rollback failed"));
    const write = vi.spyOn(nativeBridge, "saveProjectToFile");
    expect(await useDAWStore.getState().saveProject()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([false, true])("resolves current SDK bindings after rollback; incompatibleProtection=%s", async incompatibleProtection => {
    const historical = "plugin_master_historical_fingerprint:0";
    const current = "plugin_master_current_fingerprint:0", rebound = "plugin_master_current_fingerprint:9";
    const metadata = { name: "Gain", hostParamId: "current-sdk", meaningSignature: "current-v1" };
    const currentLane = { ...lane, param: current, metadata };
    let stage = [fxSlot({ automationKey: "historical", pluginPath: "old.vst3" }), fxSlot({ automationKey: "current", pluginPath: "current.vst3" })];
    let replacements = 0;
    useDAWStore.setState({ masterAutomationLanes: [currentLane], masterAutomationSafeParams: [historical, current], masterAutomationSafeParameters: [
      { param: historical, metadata: { name: "Historical", hostParamId: "old-sdk", meaningSignature: "old-v1" } }, { param: current, metadata },
    ] });
    vi.spyOn(nativeBridge, "getFXStageState").mockImplementation(async () => structuredClone(stage));
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, slots) => { ++replacements; stage = structuredClone(slots); return true; });
    vi.spyOn(nativeBridge, "getMasterFX").mockImplementation(async () => stage.map((slot, index) => ({ ...slot, index, name: "Vendor" })));
    vi.spyOn(nativeBridge, "getPluginParameters").mockImplementation(async (_track, index) => {
      if (stage[index]?.automationKey === "historical") return [{ index: 0, name: "Changed", hostParamId: "old-sdk", meaningSignature: "old-v2", value: .5, text: "", automationId: historical }];
      return [{ index: 9, ...metadata, meaningSignature: replacements >= 2 && incompatibleProtection ? "current-v2" : "current-v1", value: .5, text: "", automationId: rebound }];
    });
    const toast = vi.spyOn(useDAWStore.getState(), "showToast");
    await editFXStage("master", "Remove historical", async () => { stage = stage.slice(1); return true; });
    vi.mocked(nativeBridge.setAutomationPoints).mockClear();
    useDAWStore.getState().undo();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("Automation Safe"), "error"));
    expect(stage.map(slot => slot.automationKey)).toEqual(["current"]);
    expect(nativeBridge.setAutomationPoints).not.toHaveBeenCalledWith("master", current, [{ time: 1, value: .25 }]);
    if (incompatibleProtection) {
      expect(useDAWStore.getState().projectRestoreError).toContain("FX undo rollback failed");
      expect(nativeBridge.setAutomationPoints).not.toHaveBeenCalledWith("master", rebound, [{ time: 1, value: .25 }]);
      const write = vi.spyOn(nativeBridge, "saveProjectToFile");
      expect(await useDAWStore.getState().saveProject()).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } else {
      expect(useDAWStore.getState().masterAutomationLanes[0].param).toBe(rebound);
      expect(useDAWStore.getState().masterAutomationSafeParams).toEqual([rebound]);
      expect(useDAWStore.getState().masterAutomationSafeParameters?.[0].param).toBe(rebound);
      expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("master", rebound, [{ time: 1, value: .25 }]);
      expect(useDAWStore.getState().projectRestoreError).toBeFalsy();
    }
  });
});

function fxSlot(values: Partial<FXStageSlotState> & Pick<FXStageSlotState, "automationKey">): FXStageSlotState {
  return { name: "Vendor", type: "plugin", pluginPath: "vendor.vst3", pluginFormat: "VST3", state: "opaque", bypassed: false, forceFloat: false, ...values };
}

describe("initial FX mutation rollback", () => {
  it.each([[], null])("does not mutate a replacement project after a delayed initial snapshot: %s", async snapshot => {
    let resolve!: (value: FXStageSlotState[] | null) => void;
    vi.spyOn(nativeBridge, "getFXStageState").mockReturnValue(new Promise(done => { resolve = done; }));
    const mutate = vi.fn().mockResolvedValue(true);
    const editing = editFXStage("master", "Add", mutate);
    await vi.waitFor(() => expect(nativeBridge.getFXStageState).toHaveBeenCalled());
    advanceProjectEpoch();
    resolve(snapshot);
    expect(await editing).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(commandManager.canUndo()).toBe(false);
  });

  it("does not apply an old snapshot or history to a replacement project", async () => {
    let resolve!: (value: FXStageSlotState[]) => void;
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const editing = editFXStage("master", "Add", async () => true);
    await vi.waitFor(() => expect(nativeBridge.getFXStageState).toHaveBeenCalledTimes(2));
    advanceProjectEpoch();
    useDAWStore.setState({ masterAutomationLanes: [lane], masterFxCount: 7, isModified: false });
    resolve([]);
    expect(await editing).toBe(false);
    expect(useDAWStore.getState()).toMatchObject({ masterAutomationLanes: [lane], masterFxCount: 7, isModified: false });
    expect(commandManager.canUndo()).toBe(false);
  });

  it("keeps another stage's missing-FX recovery data when rolling back", async () => {
    const monitor = [fxSlot({ automationKey: "other-chain" })];
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Snapshot failed"));
    vi.spyOn(nativeBridge, "setFXStageState").mockResolvedValue(true);
    expect(await editFXStage("master", "Add", async () => {
      useDAWStore.setState({ unavailableFXStages: { monitor }, isModified: true });
      return true;
    })).toBe(false);
    expect(useDAWStore.getState().unavailableFXStages).toEqual({ monitor });
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it.each(["master", "monitor"] as const)("restores %s after its post-mutation snapshot rejects", async chain => {
    let stage = [fxSlot({ automationKey: "instance" })];
    const before = structuredClone(stage);
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValueOnce(before).mockRejectedValueOnce(new Error("Snapshot disconnected"));
    const restore = vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async (_chain, slots) => { stage = structuredClone(slots); return true; });
    const modified = useDAWStore.getState().isModified;
    expect(await editFXStage(chain, "Add", async () => { stage.push(fxSlot({ automationKey: "added" })); return true; })).toBe(false);
    expect(restore).toHaveBeenCalledWith(chain, before);
    expect(stage).toEqual(before);
    expect(commandManager.canUndo()).toBe(false);
    expect(useDAWStore.getState().projectRestoreError).toBeFalsy();
    expect(useDAWStore.getState().isModified).toBe(modified);
  });

  it.each(["reject", "throw"])("blocks saving when initial rollback cannot restore the chain: %s", async failure => {
    vi.spyOn(nativeBridge, "getFXStageState").mockResolvedValueOnce([fxSlot({ automationKey: "instance" })]).mockResolvedValueOnce(null);
    vi.spyOn(nativeBridge, "setFXStageState").mockImplementation(async () => {
      if (failure === "throw") throw new Error("Rollback disconnected");
      return false;
    });
    expect(await editFXStage("master", "Remove", async () => true)).toBe(false);
    expect(useDAWStore.getState().projectRestoreError).toContain("FX change rollback failed");
    expect(commandManager.canUndo()).toBe(false);
  });
});
