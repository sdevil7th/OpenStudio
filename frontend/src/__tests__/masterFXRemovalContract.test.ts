import { describe, expect, it } from "vitest";
import audioEngineHeaderSource from "../../../Source/AudioEngine.h?raw";
import audioEngineSource from "../../../Source/AudioEngine.cpp?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";
import nativeBridgeSource from "../services/NativeBridge.ts?raw";
import automationActionsSource from "../store/actions/automation.ts?raw";
import fxChainPanelSource from "../components/FXChainPanel.tsx?raw";

describe("master FX removal contracts", () => {
  it("publishes a state-synchronized master-stage reorder through the C++ bridge", () => {
    expect(audioEngineHeaderSource).toContain("bool reorderMasterFX(int fromIndex, int toIndex);");
    const functionStart = audioEngineSource.indexOf(
      "bool AudioEngine::reorderMasterFX(int fromIndex, int toIndex)",
    );
    const nextFunction = audioEngineSource.indexOf(
      "void AudioEngine::openMasterFXEditor",
      functionStart,
    );
    expect(functionStart).toBeGreaterThan(-1);
    expect(nextFunction).toBeGreaterThan(functionStart);
    const reorderBody = audioEngineSource.slice(functionStart, nextFunction);
    expect(reorderBody).toContain("specCopy = desiredMasterStageSpec;");
    expect(reorderBody).toContain("syncStageSpecStateFromActive(specCopy, activeStage);");
    expect(reorderBody).toContain("specCopy.slots.erase");
    expect(reorderBody).toContain("specCopy.slots.insert");
    expect(reorderBody).toContain("publishMasterStageSpec(specCopy)");

    expect(mainComponentSource).toContain('.withNativeFunction ("reorderMasterFX"');
    expect(mainComponentSource).toContain("completion(audioEngine.reorderMasterFX((int)args[0], (int)args[1]))");
  });

  it("keeps the TypeScript bridge and undo restore contract complete", () => {
    expect(nativeBridgeSource).toContain("reorderMasterFX?: (fromIndex: number, toIndex: number) => Promise<boolean>;");
    expect(nativeBridgeSource).toContain("async reorderMasterFX(fromIndex: number, toIndex: number): Promise<boolean>");
    expect(nativeBridgeSource).toContain("window.__JUCE__.backend.reorderMasterFX(fromIndex, toIndex)");

    expect(automationActionsSource).toContain("removeMasterFXWithUndo: async (fxIndex: number)");
    expect(automationActionsSource).toContain("getMasterPluginState(fxIndex)");
    expect(automationActionsSource).toContain("addMasterBuiltInFX(pluginReference)");
    expect(automationActionsSource).toContain("addMasterS13FX(pluginReference)");
    expect(automationActionsSource).toContain("addMasterFX(pluginReference)");
    expect(automationActionsSource).toContain("setMasterPluginState(appendedIndex, savedState)");
    expect(automationActionsSource).toContain("setMasterFXPrecisionOverride(");
    expect(automationActionsSource).toContain("reorderMasterFX(appendedIndex, fxIndex)");
  });

  it("routes selected master-slot removal through the undo-aware store action", () => {
    expect(fxChainPanelSource).toContain("removeMasterFXWithUndo: s.removeMasterFXWithUndo");
    expect(fxChainPanelSource).toContain("success = await removeMasterFXWithUndo(fxIndex)");
    expect(fxChainPanelSource).not.toContain("await nativeBridge.removeMasterFX(fxIndex)");
    expect(fxChainPanelSource).not.toContain('if (chainType === "master") return "claimed_noop"');
  });
});
