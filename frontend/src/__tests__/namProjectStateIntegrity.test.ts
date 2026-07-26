import { describe, expect, it } from "vitest";
import projectActionsSource from "../store/actions/project.ts?raw";
import audioEngineHeaderSource from "../../../Source/AudioEngine.h?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";
import {
  collectNAMProjectAssetReferences,
  summarizeNAMProjectStateIssues,
} from "../utils/namProjectState";

describe("NAM project-state integrity", () => {
  it("discovers direct and A/B resources for a master NAM rack address", () => {
    const assets = collectNAMProjectAssetReferences({
      modelState: {
        pedalModelPath: "D:/NAM/drive.nam",
        pedalDeclaredCaptureType: "pedal",
        ampModelPath: "D:/NAM/amp.nam",
        ampDeclaredCaptureType: "full_rig",
        ampCaptureType: "amp_cab",
        cabIRPath: "D:/IR/cab.wav",
      },
      uiState: {
        namRackCompare: {
          snapshots: {
            A: { modelState: { ampModelPath: "D:/NAM/a.nam" } },
            B: { modelState: { cabIRPath: "D:/IR/b.wav" } },
          },
        },
      },
    }, {
      trackId: "",
      trackName: "Master",
      chain: "master",
      fxIndex: 2,
      pluginName: "OpenStudio NAM Rack",
    });

    expect(assets).toHaveLength(5);
    expect(assets).toContainEqual(expect.objectContaining({
      chain: "master",
      fxIndex: 2,
      slot: "amp",
      path: "D:/NAM/amp.nam",
      captureType: "amp_cab",
      gearType: "amp_cab",
    }));
    expect(assets).toContainEqual(expect.objectContaining({
      chain: "master",
      compareSlot: "A",
      compareSnapshot: true,
      slot: "amp",
      path: "D:/NAM/a.nam",
    }));
    expect(assets).toContainEqual(expect.objectContaining({
      chain: "master",
      compareSlot: "B",
      compareSnapshot: true,
      slot: "cab",
      path: "D:/IR/b.wav",
    }));
  });

  it("builds a bounded, user-visible summary for rejected NAM restores", () => {
    const summary = summarizeNAMProjectStateIssues([
      { phase: "restore", location: "Guitar / Track FX 1", detail: "saved NAM state was rejected" },
      { phase: "remove", location: "Master FX NAM Rack", detail: "native removal failed" },
      { phase: "add", location: "Bus / Input FX 2", detail: "NAM Rack could not be added" },
      { phase: "restore", location: "Master / FX 3", detail: "saved NAM state was rejected" },
    ]);

    expect(summary).toContain("4 NAM Rack project-state issues");
    expect(summary).toContain("Guitar / Track FX 1");
    expect(summary).toContain("plus 1 more");
    expect(summary).not.toContain("Master / FX 3");
  });

  it("wires master asset discovery and checks every NAM restore result", () => {
    expect(projectActionsSource).toContain('trackName: "Master"');
    expect(projectActionsSource).toContain('chain: "master"');
    expect(projectActionsSource).toContain("rawNAMAssets.push(...collectNAMAssetsFromPluginState");
    expect(projectActionsSource.match(/if \(isNAMRack && !stateResult\)/g)).toHaveLength(3);
    expect(projectActionsSource).toContain("summarizeNAMProjectStateIssues(namProjectStateIssues)");
    expect(projectActionsSource).toContain("Project loaded with ${missingNAMAssets.length} missing NAM resource file");
  });

  it("returns native removal truth instead of unconditional bridge success", () => {
    expect(audioEngineHeaderSource).toContain("bool removeTrackInputFX");
    expect(audioEngineHeaderSource).toContain("bool removeTrackFX");
    expect(audioEngineHeaderSource).toContain("bool removeMasterFX");
    expect(mainComponentSource).toContain("completion(audioEngine.removeTrackInputFX");
    expect(mainComponentSource).toContain("completion(audioEngine.removeTrackFX");
    expect(mainComponentSource).toContain("completion(audioEngine.removeMasterFX");
  });
});
