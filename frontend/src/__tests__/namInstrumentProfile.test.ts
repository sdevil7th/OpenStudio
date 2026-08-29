// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NAMExplorer } from "../components/NAMExplorer";
import {
  namCatalogSession,
  namInstalledLibrarySession,
  resetNAMExplorerSessionForTests,
} from "../services/namExplorerSession";
import type { BuiltInPluginSchema, NAMCatalogTone, NAMInstalledModel } from "../services/NativeBridge";
import {
  filterAndPinNAMInstrumentItems,
  labelForNAMInstrumentProfile,
  namInstalledCaptureInstrumentLabels,
  namInstrumentLabelsAreCompatible,
  namInstrumentProfileTagIsCompatible,
  namStoredPresetMatchesInstrumentProfile,
  namPreEqBandLabelsForProfile,
  namPreEqBandsForProfile,
  normalizeNAMInstrumentProfile,
  shouldClearNAMFactoryPresetIdentityOnProfileChange,
} from "../utils/namInstrumentProfile";
import {
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
  namInstrumentProfileMetadataFromRackState,
} from "../utils/namRackPresetTransactions";

describe("NAM Rack instrument profile", () => {
  beforeEach(() => {
    resetNAMExplorerSessionForTests();
  });

  afterEach(() => {
    resetNAMExplorerSessionForTests();
  });

  it("defaults missing and malformed values to Guitar and keeps the enum binary", () => {
    expect(normalizeNAMInstrumentProfile(undefined)).toBe(0);
    expect(normalizeNAMInstrumentProfile(Number.NaN)).toBe(0);
    expect(normalizeNAMInstrumentProfile(-5)).toBe(0);
    expect(normalizeNAMInstrumentProfile(0.49)).toBe(0);
    expect(normalizeNAMInstrumentProfile(0.5)).toBe(1);
    expect(normalizeNAMInstrumentProfile(7)).toBe(0);
    expect(labelForNAMInstrumentProfile(0)).toBe("Guitar");
    expect(labelForNAMInstrumentProfile(1)).toBe("Bass");
  });

  it("keeps untagged/shared captures discoverable and hides only explicit opposite-instrument metadata", () => {
    expect(namInstrumentLabelsAreCompatible([], 0)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Electric Guitar"], 0)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Electric Guitar"], 1)).toBe(false);
    expect(namInstrumentLabelsAreCompatible(["Bass Guitar"], 0)).toBe(false);
    expect(namInstrumentLabelsAreCompatible(["Bass Guitar"], 1)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Keys"], 1)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Guitar and Bass"], 0)).toBe(true);
    expect(namInstrumentLabelsAreCompatible(["Guitar and Bass"], 1)).toBe(true);
    expect(namInstrumentProfileTagIsCompatible("guitar", 0)).toBe(true);
    expect(namInstrumentProfileTagIsCompatible("guitar", 1)).toBe(false);
    expect(namInstrumentProfileTagIsCompatible("all", 1)).toBe(true);
  });

  it("clears only a factory identity that becomes incompatible after a real profile change", () => {
    expect(shouldClearNAMFactoryPresetIdentityOnProfileChange("guitar", 0, 1)).toBe(true);
    expect(shouldClearNAMFactoryPresetIdentityOnProfileChange("bass", 1, 0)).toBe(true);
    expect(shouldClearNAMFactoryPresetIdentityOnProfileChange("all", 0, 1)).toBe(false);
    expect(shouldClearNAMFactoryPresetIdentityOnProfileChange("guitar", 0, 0)).toBe(false);
    expect(shouldClearNAMFactoryPresetIdentityOnProfileChange(undefined, 0, 1)).toBe(false);
  });

  it("reads installed instrument metadata and pins an active cross-instrument capture", () => {
    const activeGuitar = {
      id: "active-guitar",
      instrument: "Electric Guitar",
    };
    const items = [
      { id: "bass", latestMetadata: { target_instrument: { name: "Bass Guitar" } } },
      { id: "other-guitar", lastSeenMetadata: { instruments: ["Electric Guitar"] } },
      { id: "shared" },
      activeGuitar,
    ];

    expect(namInstalledCaptureInstrumentLabels(items[0])).toEqual(["Bass Guitar"]);
    expect(filterAndPinNAMInstrumentItems(
      items,
      1,
      namInstalledCaptureInstrumentLabels,
      (item) => item === activeGuitar,
    ).map(({ id }) => id)).toEqual([
      "active-guitar",
      "bass",
      "shared",
    ]);
  });

  it("uses migrated rack values, not sidecar metadata, as the preset profile authority", () => {
    expect(namInstrumentProfileMetadataFromRackState({
      values: { instrumentProfile: 1 },
    })).toBe("bass");
    expect(namInstrumentProfileMetadataFromRackState({
      values: { instrumentProfile: 0 },
    })).toBe("guitar");
    expect(namInstrumentProfileMetadataFromRackState({
      values: { instrumentProfile: 99 },
    })).toBe("guitar");
  });

  it("keeps canonical Bass presets visible when a stale sidecar says Guitar", () => {
    const preset = {
      instrumentProfile: "bass" as const,
      metadata: { instrumentProfile: "guitar" as const },
    };
    expect(namStoredPresetMatchesInstrumentProfile(preset, 1)).toBe(true);
    expect(namStoredPresetMatchesInstrumentProfile(preset, 0)).toBe(false);
  });

  it("keeps canonical Guitar presets visible when a stale sidecar says Bass", () => {
    const preset = {
      instrumentProfile: "guitar" as const,
      metadata: { instrumentProfile: "bass" as const },
    };
    expect(namStoredPresetMatchesInstrumentProfile(preset, 0)).toBe(true);
    expect(namStoredPresetMatchesInstrumentProfile(preset, 1)).toBe(false);
  });

  it("maps the stable EQ Boost IDs to profile-specific centers and user-facing labels", () => {
    const guitarBands = namPreEqBandsForProfile(0);
    const bassBands = namPreEqBandsForProfile(1);

    expect(guitarBands.map(({ paramId }) => paramId)).toEqual(
      bassBands.map(({ paramId }) => paramId),
    );
    expect(guitarBands.map(({ frequencyHz }) => frequencyHz)).toEqual([
      120, 250, 500, 1000, 2500, 5000, 8000, 12000,
    ]);
    expect(bassBands.map(({ frequencyHz }) => frequencyHz)).toEqual([
      50, 120, 250, 500, 800, 1600, 4500, 10000,
    ]);
    expect(guitarBands.map(({ faceplateLabel }) => faceplateLabel)).toEqual([
      "120", "250", "500", "1K", "2.5K", "5K", "8K", "12K",
    ]);
    expect(bassBands.map(({ faceplateLabel }) => faceplateLabel)).toEqual([
      "50", "120", "250", "500", "800", "1.6K", "4.5K", "10K",
    ]);
    expect(namPreEqBandLabelsForProfile(1)).toMatchObject({
      preEq120Db: "50 Hz",
      preEq250Db: "120 Hz",
      preEq500Db: "250 Hz",
      preEq1kDb: "500 Hz",
      preEq2k5Db: "800 Hz",
      preEq5kDb: "1.6 kHz",
      preEq8kDb: "4.5 kHz",
      preEq12kDb: "10 kHz",
    });
  });

  it("migrates legacy complete presets and every latent comparison snapshot to Guitar", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {},
      dspState: { namEffectsDspVersion: 7, reverbEngineVersion: 4 },
      uiState: {
        namPresetBaseline: { values: {}, dspState: {} },
        namRackCompare: {
          snapshots: {
            A: { values: {}, dspState: {} },
            B: { values: { instrumentProfile: 1 }, dspState: { namEffectsDspVersion: 8 } },
          },
        },
      },
    }, { completePreset: true }) as any;

    expect(migrated.values.instrumentProfile).toBe(0);
    expect(migrated.uiState.namPresetBaseline.values.instrumentProfile).toBe(0);
    expect(migrated.uiState.namRackCompare.snapshots.A.values.instrumentProfile).toBe(0);
    expect(migrated.uiState.namRackCompare.snapshots.B.values.instrumentProfile).toBe(1);
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);

    const { instrumentProfile: _removed, ...incompleteValues } = migrated.values;
    expect(isCurrentNAMRackPresetState({ ...migrated, values: incompleteValues })).toBe(false);

    const malformed = migrateLegacyNAMRackPresetDspState({
      values: { instrumentProfile: 9 },
      dspState: { namEffectsDspVersion: 8, reverbEngineVersion: 4 },
    }, { completePreset: true }) as any;
    expect(malformed.values.instrumentProfile).toBe(0);

    const preV8Collision = migrateLegacyNAMRackPresetDspState({
      values: { instrumentProfile: 1 },
      dspState: { namEffectsDspVersion: 7, reverbEngineVersion: 4 },
    }, { completePreset: true }) as any;
    expect(preV8Collision.values.instrumentProfile).toBe(0);
  });

  it("plumbs the saved enum through boot/mock schemas, all Explorer surfaces, and the header card", () => {
    const bridge = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const boot = readFileSync(new URL("../components/BuiltInPluginPanel.tsx", import.meta.url), "utf8");
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");

    expect(bridge).toContain('param("instrumentProfile", "Instrument", 0, 0, 1, "", "global", "enum", false)');
    expect(boot).toContain('makeFallbackParam("instrumentProfile", "Instrument", 0, 0, 1');
    expect(panel.match(/instrumentProfile=\{instrumentProfile\}/g)).toHaveLength(2);
    expect(panel).toMatch(/utilityControls=\{\{\s*instrumentProfile,/);
    expect(panel).toContain('id: "bass-clean-foundation"');
    expect(panel).toContain('id: "bass-grit-parallel"');
    expect(panel).toContain("designPortCompatibleInstalledCaptures");
    expect(panel).toContain("namInstalledCaptureInstrumentLabels");
    expect(panel).toContain('instrumentLabels.join(" / ")');
    expect(panel).toContain("clearIncompatibleFactoryIdentity");
    expect(panel).toContain("instrumentProfile: namInstrumentProfileMetadataFromRackState(loadedState)");
    expect(panel).toContain("instrumentProfile: namInstrumentProfileMetadataFromRackState(importedState)");
    expect(panel.match(/namStoredPresetMatchesInstrumentProfile\(entry, instrumentProfile\)/g)).toHaveLength(2);
    expect(bridge).toContain('instrumentProfile?: "guitar" | "bass"');
    expect(panel).not.toContain("const savedProfile = presetMetadata[entry.name]?.instrumentProfile");
    expect(design).toContain('useBoundDesignParam("instrumentProfile")');
  });

  it("keeps active opposite-tagged Explorer captures visible before profile filtering", () => {
    const explorer = readFileSync(new URL("../components/NAMExplorer.tsx", import.meta.url), "utf8");
    expect(explorer.match(/filterAndPinNAMInstrumentItems\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(explorer).toContain("installedRecordIsActive");
    expect(explorer).toContain("activeCapturePaths");
    expect(explorer).toContain("captureOptionsForInstrumentProfile");
    expect(explorer).toContain("catalogModelsForInstrumentProfile");
    expect(explorer).not.toContain("if (!namInstrumentLabelsAreCompatible(instrumentLabels, instrumentProfile)) return false;");
  });

  it("pins active opposite-profile catalog rows by either stable model ID or URL-only identity", () => {
    const urlOnlyModelUrl = "https://tone3000.example/models/url-only-active.nam";
    const catalog: NAMCatalogTone[] = [
      {
        id: 10,
        title: "URL-only active guitar capture",
        sortBucket: "trending",
        models: [{ id: 0, name: "URL capture", model_url: urlOnlyModelUrl, instrument: "Electric Guitar" }],
      },
      {
        id: 11,
        title: "ID active guitar capture",
        sortBucket: "trending",
        models: [{ id: 101, name: "ID capture", model_url: "https://tone3000.example/models/id-active.nam", instrument: "Electric Guitar" }],
      },
      {
        id: 12,
        title: "Inactive guitar capture",
        sortBucket: "trending",
        models: [{ id: 102, name: "Inactive capture", model_url: "https://tone3000.example/models/inactive.nam", instrument: "Electric Guitar" }],
      },
      {
        id: 20,
        title: "Compatible bass capture",
        sortBucket: "trending",
        models: [{ id: 201, name: "Bass capture", model_url: "https://tone3000.example/models/bass.nam", instrument: "Bass Guitar" }],
      },
    ];
    const installed: NAMInstalledModel[] = [
      {
        modelId: 0,
        toneId: 10,
        modelUrl: urlOnlyModelUrl.toUpperCase(),
        localPath: "C:\\NAM\\url-only-active.nam",
      },
      {
        modelId: 101,
        toneId: 11,
        modelUrl: "https://tone3000.example/models/id-active.nam",
        localPath: "C:\\NAM\\id-active.nam",
      },
    ];
    namCatalogSession.set({ tones: catalog, generatedAt: "", source: "test" });
    namInstalledLibrarySession.set({ installed });

    const schema: BuiltInPluginSchema = {
      schemaVersion: 1,
      name: "NAM Rack",
      category: "NAM",
      chain: "track",
      fxIndex: 0,
      parameters: [],
      modelState: {
        ampModelPath: "c:/nam/URL-ONLY-ACTIVE.nam",
        pedalModelPath: "c:/nam/id-active.nam",
      },
    };
    const markup = renderToStaticMarkup(createElement(NAMExplorer, {
      address: { trackId: "track-1", chain: "track", fxIndex: 0 },
      schema,
      onRefreshRack: () => schema,
      instrumentProfile: 1,
    }));

    expect(markup).toContain("URL-only active guitar capture");
    expect(markup).toContain("ID active guitar capture");
    expect(markup).toContain("Compatible bass capture");
    expect(markup).not.toContain("Inactive guitar capture");
  });

  it("routes the effective EQ Boost centers through DSP, live switching, stage labels, and accessibility", () => {
    const dsp = readFileSync(new URL("../../../Source/BuiltInEffects2.cpp", import.meta.url), "utf8");
    const engine = readFileSync(new URL("../../../Source/AudioEngine.cpp", import.meta.url), "utf8");
    const panel = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");

    expect(dsp).toContain("kNAMRackPreEqFrequenciesByProfile");
    expect(dsp).toMatch(/50\.0f, 120\.0f, 250\.0f, 500\.0f,[\s\S]*800\.0f, 1600\.0f, 4500\.0f, 10000\.0f/);
    expect(dsp).toContain("profile != lastPreEqInstrumentProfile");
    expect(engine).toContain("ProfileResponseStage::preEq");
    expect(engine).toMatch(/processDualOctaverStage\(block\);\s*liveRack\.processPreEQ\(block\);/);
    expect(panel.match(/namPreEqBandLabelsForProfile\(instrumentProfile\)/g)?.length).toBe(1);
    expect(design).toContain("namPreEqBandsForProfile(instrumentProfile?.value)");
    expect(design).toContain("semanticLabel={`${band.accessibleLabel} EQ Boost`}");
  });
});
