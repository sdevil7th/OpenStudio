// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildNAMModulePresetCommitValues,
  buildNAMRackRollbackPatch,
  resolveNAMHeaderPresetNavigation,
} from "../utils/namRackPresetTransactions";

describe("NAM Rack preset transactions", () => {
  it("restores all prior module-preview values before committing the selected module", () => {
    expect(buildNAMModulePresetCommitValues(
      { delayMix: 0.42, delayTimeMs: 375 },
      {
        applied: true,
        previousValues: {
          reverbMix: 0.18,
          reverbDecaySec: 2.2,
          delayMix: 0.1,
        },
      },
    )).toEqual({
      reverbMix: 0.18,
      reverbDecaySec: 2.2,
      delayMix: 0.42,
      delayTimeMs: 375,
    });
  });

  it("does not add unrelated values when no temporary module preview exists", () => {
    expect(buildNAMModulePresetCommitValues(
      { reverbMix: 0.3 },
      { applied: false, previousValues: { delayMix: 0.1 } },
    )).toEqual({ reverbMix: 0.3 });
  });

  it("navigates within user presets when a user preset is active", () => {
    const result = resolveNAMHeaderPresetNavigation({
      factoryPresets: [
        { id: "clean", name: "Clean Template" },
        { id: "lead", name: "Lead Template" },
      ],
      userPresets: [
        { name: "Bass Tight" },
        { name: "My Crunch" },
        { name: "Wide Clean" },
      ],
      activeFactoryId: "clean",
      activeUserPresetName: "my crunch",
    });

    expect(result).toEqual({
      previous: { kind: "user", name: "Bass Tight" },
      next: { kind: "user", name: "Wide Clean" },
    });
  });

  it("disables truthful user navigation while the active user preset is unavailable", () => {
    expect(resolveNAMHeaderPresetNavigation({
      factoryPresets: [
        { id: "clean", name: "Clean Template" },
        { id: "lead", name: "Lead Template" },
      ],
      userPresets: [],
      activeFactoryId: "clean",
      activeUserPresetName: "Saved Session Tone",
    })).toEqual({});
  });

  it("wraps factory template navigation when no user preset is active", () => {
    expect(resolveNAMHeaderPresetNavigation({
      factoryPresets: [
        { id: "clean", name: "Clean Template" },
        { id: "lead", name: "Lead Template" },
        { id: "ambient", name: "Ambient Template" },
      ],
      userPresets: [{ name: "User Tone" }],
      activeFactoryId: "clean",
    })).toEqual({
      previous: { kind: "factory", id: "ambient", name: "Ambient Template" },
      next: { kind: "factory", id: "lead", name: "Lead Template" },
    });
  });

  it("builds an exact mutable rollback patch without replaying read-only model flags", () => {
    expect(buildNAMRackRollbackPatch({
      values: {
        auditionSource: 1,
        pedalMix: 0.37,
        ignored: "not-a-number",
      },
      modelState: {
        pedalModelPath: " C:/NAM/Pedal.nam ",
        pedalDeclaredCaptureType: "pedal",
        ampModelPath: "C:/NAM/Amp.nam",
        ampDeclaredCaptureType: "full_rig",
        cabIRPath: "",
        hasAmpModel: true,
        ampIncludesCab: false,
        cabRequestedEnabled: true,
      },
      uiState: {
        namActivePreview: { slot: "amp" },
        namPresetDirty: true,
      },
    })).toEqual({
      values: {
        auditionSource: 1,
        pedalMix: 0.37,
      },
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        pedalDeclaredCaptureType: "pedal",
        ampModelPath: "C:/NAM/Amp.nam",
        ampDeclaredCaptureType: "full_rig",
        clearCabIR: true,
        cabRequestedEnabled: true,
      },
      uiState: {
        namActivePreview: { slot: "amp" },
        namPresetDirty: true,
      },
    });
  });

  it("keeps Panel remove/import wiring tied to the transactional helpers", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const removeStart = panelSource.indexOf("const removeSlotModule");
    const removeEnd = panelSource.indexOf("const applyPreset", removeStart);
    const importStart = panelSource.indexOf("const importUserPreset");
    const importEnd = panelSource.indexOf("const rememberIRPath", importStart);

    expect(panelSource.slice(removeStart, removeEnd)).toContain("values.precisionDriveEnabled = 0");
    expect(panelSource.slice(importStart, importEnd)).toContain("buildNAMRackRollbackPatch");
    expect(panelSource.slice(importStart, importEnd)).toContain("rollbackImport");
    expect(panelSource.slice(importStart, importEnd)).toContain("The previous rack was restored.");
  });

  it("keeps the requested external-cab preference in A/B snapshots", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(panelSource).toContain("modelSnapshot.cabRequestedEnabled = modelState.cabRequestedEnabled");
    expect(panelSource).toContain("currentCabRequest !== savedCabRequest");
    expect(panelSource).toContain("modelState.cabRequestedEnabled = values.cabEnabled >= 0.5");
  });

  it("restores an active module preview before previewing or applying another module preset", () => {
    const explorerSource = readFileSync(
      new URL("../components/NAMExplorer.tsx", import.meta.url),
      "utf8",
    );
    const applyStart = explorerSource.indexOf("const applyOpenStudioFXPreset");
    const applyEnd = explorerSource.indexOf("const revertOpenStudioFXPreset", applyStart);
    const applySource = explorerSource.slice(applyStart, applyEnd);

    expect(applySource).toContain(
      "values: buildNAMModulePresetCommitValues(presetPatch.values, fxPreview)",
    );
    expect(applySource).toContain(": publishedPresetPatch");
  });
});
