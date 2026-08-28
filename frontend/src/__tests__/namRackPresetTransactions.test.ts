// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildNAMModelQualityOptions,
  buildNAMModulePresetCommitValues,
  buildNAMRackRollbackPatch,
  countNAMUserPresetFilters,
  createNAMPresetSessionCache,
  deriveNAMRackPresetDirtyState,
  drainNAMPresetWriteQueue,
  getNAMUserPresetEmptyState,
  isNAMReservedPresetCollectionName,
  migrateLegacyNAMRackPresetDspState,
  migrateNAMRackModelQualityState,
  NAM_RACK_DEFAULT_POST_FX_ORDER,
  NAM_UNFILED_PRESET_COLLECTION_ID,
  NAMPresetSessionInvalidatedError,
  normalizeNAMRackSnapshotCaptureTypes,
  normalizeNAMUserPresetFolder,
  resolveNAMModelQualityOptionValue,
  resolveNAMHeaderPresetNavigation,
  runNAMHeaderPresetArrowAction,
  shouldSynchronizeNAMRackPresetDirtyMarker,
  shouldClearNAMPresetIdentityForUnsavedAmpTransition,
  verifyNAMRackCompareReadback,
} from "../utils/namRackPresetTransactions";

describe("NAM Rack preset transactions", () => {
  it("does not dirty a loaded preset with native capture-type sentinels for empty slots", () => {
    expect(normalizeNAMRackSnapshotCaptureTypes({
      pedalModelPath: "",
      pedalDeclaredCaptureType: "unknown",
      ampModelPath: " C:/NAM/Bass.nam ",
      ampDeclaredCaptureType: " full_rig ",
    })).toEqual({
      ampDeclaredCaptureType: "full_rig",
    });

    expect(normalizeNAMRackSnapshotCaptureTypes({
      ampModelPath: "",
      ampDeclaredCaptureType: "amp_cab",
    })).toEqual({});
  });

  it("drains pending UI persistence before flushing coalesced parameter writes", async () => {
    const events: string[] = [];
    let releaseUiWrite!: () => void;
    const uiWrite = new Promise<void>((resolve) => {
      releaseUiWrite = resolve;
    });
    const flush = async () => {
      events.push("parameters-flushed");
      return true;
    };

    const drain = drainNAMPresetWriteQueue(async () => {
      await uiWrite;
      events.push("ui-state-drained");
    }, flush);
    await Promise.resolve();
    expect(events).toEqual([]);

    releaseUiWrite();
    await expect(drain).resolves.toBe(true);
    expect(events).toEqual(["ui-state-drained", "parameters-flushed"]);
  });

  it("aborts a preset transaction when either pending-write stage fails", async () => {
    await expect(drainNAMPresetWriteQueue(
      async () => undefined,
      async () => false,
    )).resolves.toBe(false);
    await expect(drainNAMPresetWriteQueue(
      async () => { throw new Error("UI persistence failed"); },
      async () => true,
    )).resolves.toBe(false);
  });

  it("reuses a fresh session-only preset catalog and refreshes after the TTL", async () => {
    const cache = createNAMPresetSessionCache<string[]>(100);
    let calls = 0;
    const load = () => Promise.resolve([`catalog-${++calls}`]);

    await expect(cache.load(load, { now: 1_000 })).resolves.toEqual(["catalog-1"]);
    await expect(cache.load(load, { now: 1_099 })).resolves.toEqual(["catalog-1"]);
    await expect(cache.load(load, { now: 1_100 })).resolves.toEqual(["catalog-2"]);
    await expect(cache.load(load, { force: true, now: 1_101 })).resolves.toEqual(["catalog-3"]);
    expect(calls).toBe(3);
  });

  it("deduplicates current-generation discovery and rejects stale publication after invalidation", async () => {
    const cache = createNAMPresetSessionCache<string[]>(1_000);
    const resolvers: Array<(value: string[]) => void> = [];
    let calls = 0;
    const load = () => new Promise<string[]>((resolve) => {
      calls += 1;
      resolvers.push(resolve);
    });

    const first = cache.load(load, { now: 10 });
    const duplicate = cache.load(load, { now: 10 });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(duplicate).toBe(first);

    cache.invalidate();
    const afterMutation = cache.load(load, { force: true, now: 11 });
    await Promise.resolve();
    expect(calls).toBe(2);

    resolvers[0](["stale"]);
    resolvers[1](["fresh"]);
    await expect(first).rejects.toBeInstanceOf(NAMPresetSessionInvalidatedError);
    await expect(afterMutation).resolves.toEqual(["fresh"]);
    expect(cache.peek(11)).toEqual(["fresh"]);
  });

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

  it("uses each verified user-preset commit for the following navigation step", async () => {
    const userPresets = [
      { name: "Alpha" },
      { name: "Bravo" },
      { name: "Charlie" },
    ];
    let activeUserPresetName = "Alpha";
    const loaded: string[] = [];

    const loadNext = async () => {
      const target = resolveNAMHeaderPresetNavigation({
        factoryPresets: [],
        userPresets,
        activeFactoryId: "",
        activeUserPresetName,
      }).next;
      expect(target?.kind).toBe("user");
      if (target?.kind !== "user") return;
      await Promise.resolve();
      loaded.push(target.name);
      activeUserPresetName = target.name;
    };

    await loadNext();
    await loadNext();
    await loadNext();

    expect(loaded).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  it("counts legacy presets even when they have no Recent metadata", () => {
    const presets = [
      { name: "high gain!" },
      { name: "Mesa High gain!" },
    ];

    expect(countNAMUserPresetFilters(presets, {})).toEqual({
      all: 2,
      favorites: 0,
      recent: 0,
    });
    expect(countNAMUserPresetFilters(presets, {
      "Mesa High gain!": { favorite: true, lastUsed: 42 },
    })).toEqual({
      all: 2,
      favorites: 1,
      recent: 1,
    });
  });

  it("distinguishes an empty library from an active filter with no matches", () => {
    expect(getNAMUserPresetEmptyState(0, 0, "all", "")).toEqual({
      message: "No saved presets yet",
      showAll: false,
    });
    expect(getNAMUserPresetEmptyState(2, 0, "recent", "")).toEqual({
      message: "No user presets match the selected filter",
      showAll: true,
    });
    expect(getNAMUserPresetEmptyState(2, 0, "all", "mesa")).toEqual({
      message: "No user presets match the current search or filter",
      showAll: true,
    });
    expect(getNAMUserPresetEmptyState(2, 1, "recent", "")).toBeUndefined();
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

  it("does not navigate relative to an invisible assumed factory preset", () => {
    expect(resolveNAMHeaderPresetNavigation({
      factoryPresets: [
        { id: "clean", name: "Clean Template" },
        { id: "lead", name: "Lead Template" },
      ],
      userPresets: [],
      activeFactoryId: "",
      activeUserPresetName: "",
    })).toEqual({});
  });

  it("enters saved full-rig navigation from the exact empty-rack state", async () => {
    const navigation = resolveNAMHeaderPresetNavigation({
      factoryPresets: [
        { id: "clean", name: "Current Capture Clean" },
        { id: "lead", name: "Current Capture Lead" },
      ],
      userPresets: [
        { name: "Alpha Saved Rig" },
        { name: "Zulu Saved Rig" },
      ],
      activeFactoryId: "",
      activeUserPresetName: "",
      allowInactiveEntry: true,
    });

    expect(navigation).toEqual({
      previous: { kind: "user", name: "Zulu Saved Rig" },
      next: { kind: "user", name: "Alpha Saved Rig" },
    });

    let activePresetName = "";
    let libraryOpened = false;
    const result = await runNAMHeaderPresetArrowAction(navigation.next, {
      loadTarget: async (target) => {
        expect(target).toEqual({ kind: "user", name: "Alpha Saved Rig" });
        activePresetName = target.kind === "user" ? target.name : "";
        return true;
      },
      openLibrary: () => { libraryOpened = true; },
    });

    expect(result).toBe("loaded");
    expect(activePresetName).toBe("Alpha Saved Rig");
    expect(libraryOpened).toBe(false);
  });

  it("can enter one saved rig from empty, then disables cycling its one-item collection", async () => {
    const options = {
      factoryPresets: [{ id: "clean", name: "Current Capture Clean" }],
      userPresets: [{ name: "Only Saved Rig" }],
      activeFactoryId: "",
      allowInactiveEntry: true,
    } as const;

    const entryNavigation = resolveNAMHeaderPresetNavigation({
      ...options,
      activeUserPresetName: "",
    });
    expect(entryNavigation).toEqual({
      previous: { kind: "user", name: "Only Saved Rig" },
      next: { kind: "user", name: "Only Saved Rig" },
    });
    let activeUserPresetName = "";
    await expect(runNAMHeaderPresetArrowAction(entryNavigation.next, {
      loadTarget: async (target) => {
        activeUserPresetName = target.kind === "user" ? target.name : "";
        return Boolean(activeUserPresetName);
      },
      openLibrary: () => undefined,
    })).resolves.toBe("loaded");
    expect(activeUserPresetName).toBe("Only Saved Rig");
    expect(resolveNAMHeaderPresetNavigation({
      ...options,
      activeUserPresetName,
    })).toEqual({});
  });

  it("preserves the verified identity across empty-rack resource restore, then advances from Alpha to Bravo", async () => {
    const userPresets = [
      { name: "Alpha" },
      { name: "Bravo" },
      { name: "Charlie" },
    ];
    expect(shouldClearNAMPresetIdentityForUnsavedAmpTransition({
      previouslyHadAmpModel: false,
      hasAmpModel: true,
      schemaActiveUserPresetName: "Alpha",
      schemaActiveFactoryPresetId: "",
    })).toBe(false);
    expect(shouldClearNAMPresetIdentityForUnsavedAmpTransition({
      previouslyHadAmpModel: false,
      hasAmpModel: true,
      schemaActiveUserPresetName: "",
      schemaActiveFactoryPresetId: "",
    })).toBe(true);

    let activeUserPresetName = "Alpha";
    const next = resolveNAMHeaderPresetNavigation({
      factoryPresets: [],
      userPresets,
      activeFactoryId: "",
      activeUserPresetName,
      allowInactiveEntry: true,
    }).next;
    const result = await runNAMHeaderPresetArrowAction(next, {
      loadTarget: async (target) => {
        if (target.kind !== "user") return false;
        activeUserPresetName = target.name;
        return true;
      },
      openLibrary: () => undefined,
    });

    expect(result).toBe("loaded");
    expect(activeUserPresetName).toBe("Bravo");
  });

  it("opens the preset chooser instead of leaving an empty-rack arrow dead", async () => {
    const navigation = resolveNAMHeaderPresetNavigation({
      factoryPresets: [
        { id: "clean", name: "Current Capture Clean" },
        { id: "lead", name: "Current Capture Lead" },
      ],
      userPresets: [],
      activeFactoryId: "",
      activeUserPresetName: "",
      allowInactiveEntry: true,
    });

    // NAMRackPanel rejects these factory-only targets while there is no Amp
    // Capture because they contain settings, not the required NAM resource.
    const noLoadableTarget = navigation.next?.kind === "factory" ? undefined : navigation.next;
    let libraryOpened = false;
    let loadCalls = 0;
    const result = await runNAMHeaderPresetArrowAction(noLoadableTarget, {
      loadTarget: async () => {
        loadCalls += 1;
        return true;
      },
      openLibrary: () => { libraryOpened = true; },
    });

    expect(result).toBe("library-opened");
    expect(libraryOpened).toBe(true);
    expect(loadCalls).toBe(0);
  });

  it("uses values between NAM slim breakpoints instead of ambiguous threshold values", () => {
    expect(buildNAMModelQualityOptions([0.75, 0.25, 0.5, 0.5])).toEqual([
      { value: 0, label: "Economy" },
      { value: 0.375, label: "Balanced 1" },
      { value: 0.625, label: "Balanced 2" },
      { value: 1, label: "Full" },
    ]);
    expect(buildNAMModelQualityOptions([0.5])).toEqual([
      { value: 0, label: "Economy" },
      { value: 1, label: "Full" },
    ]);
  });

  it("maps exact NAM slim breakpoints to the higher tier used by the core", () => {
    expect(resolveNAMModelQualityOptionValue(0.49, [0.5])).toBe(0);
    expect(resolveNAMModelQualityOptionValue(0.5, [0.5])).toBe(1);
    expect(resolveNAMModelQualityOptionValue(0.51, [0.5])).toBe(1);
  });

  it("derives edited state from an authoritative preset baseline instead of a stale marker", () => {
    expect(deriveNAMRackPresetDirtyState({
      activePresetKind: "user",
      hasBaseline: true,
      differsFromBaseline: true,
      persistedDirty: false,
    })).toBe(true);
    expect(deriveNAMRackPresetDirtyState({
      activePresetKind: "factory",
      hasBaseline: true,
      differsFromBaseline: false,
      legacyFactoryDiffers: true,
      persistedDirty: true,
    })).toBe(false);
    expect(deriveNAMRackPresetDirtyState({
      activePresetKind: "user",
      hasBaseline: false,
      differsFromBaseline: true,
      persistedDirty: false,
    })).toBe(false);

    expect(shouldSynchronizeNAMRackPresetDirtyMarker({
      activePresetKind: "user",
      hasBaseline: true,
      derivedDirty: true,
      persistedDirty: false,
    })).toBe(true);
    expect(shouldSynchronizeNAMRackPresetDirtyMarker({
      activePresetKind: "user",
      hasBaseline: false,
      derivedDirty: true,
      persistedDirty: false,
    })).toBe(false);
  });

  it("migrates unsized legacy captures to Full and retires the legacy global size", () => {
    const legacyWithoutQuality = {
      values: { ampMix: 1 },
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        ampModelPath: "C:/NAM/Amp.nam",
      },
    };
    expect(migrateNAMRackModelQualityState(legacyWithoutQuality)).toEqual({
      values: { ampMix: 1 },
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        pedalModelSize: 1,
        ampModelPath: "C:/NAM/Amp.nam",
        ampModelSize: 1,
      },
    });

    expect(migrateNAMRackModelQualityState({
      values: { ampMix: 1, namModelSize: 0.37 },
      parameters: [
        { id: "ampMix", value: 1 },
        { id: "namModelSize", value: 0.25 },
      ],
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        pedalModelSize: Number.NaN,
        ampModelPath: "C:/NAM/Amp.nam",
      },
    })).toEqual({
      values: { ampMix: 1 },
      parameters: [{ id: "ampMix", value: 1 }],
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        pedalModelSize: 0.37,
        ampModelPath: "C:/NAM/Amp.nam",
        ampModelSize: 0.37,
      },
    });

    expect(migrateNAMRackModelQualityState({
      values: { ampMix: 1, namModelSize: 0.2 },
      parameters: [{ id: "namModelSize", value: 0.2 }],
    })).toEqual({
      values: { ampMix: 1 },
      parameters: [],
    });
  });

  it("canonicalizes a legacy Compare quality selector before strict readback verification", () => {
    const migrated = migrateLegacyNAMRackPresetDspState(
      migrateNAMRackModelQualityState({
        values: { ampMix: 1, namModelSize: 0.37 },
        modelState: { ampModelPath: "C:/NAM/Amp.nam" },
      }),
      { completePreset: true },
    ) as Record<string, any>;

    expect(migrated.values).not.toHaveProperty("namModelSize");
    expect(migrated.modelState.ampModelSize).toBe(0.37);
    expect(verifyNAMRackCompareReadback({
      values: migrated.values,
      modelState: migrated.modelState,
      dspState: migrated.dspState,
    }, {
      values: migrated.values,
      modelState: {
        ampModelPath: "C:/NAM/Amp.nam",
        ampModelSize: 0.37,
      },
      dspState: migrated.dspState,
    })).toBe(true);
  });

  it("migrates complete preset bundles to the one current rack DSP", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { reverbDecaySec: 10 },
      modelState: { ampModelPath: "C:/NAM/Amp.nam" },
    }, { completePreset: true }) as Record<string, any>;
    expect(migrated).toMatchObject({
      values: {
        reverbDecaySec: 10,
        precisionDriveVolumeDb: 9,
        chaosMode: 0,
        chaosWeight: 0.5,
      },
      modelState: { ampModelPath: "C:/NAM/Amp.nam" },
      dspState: { reverbEngineVersion: 5, namEffectsDspVersion: 19 },
    });

    const legacyV9 = {
      values: { reverbVoice: 2, reverbDecaySec: 10 },
      dspState: { reverbEngineVersion: 5, namEffectsDspVersion: 9 },
    };
    const currentOnce = migrateLegacyNAMRackPresetDspState(legacyV9, { completePreset: true });
    expect(migrateLegacyNAMRackPresetDspState(currentOnce, { completePreset: true })).toEqual(currentOnce);

    expect(migrateLegacyNAMRackPresetDspState({
      values: {},
      dspState: { reverbEngineVersion: 4 },
    }, { completePreset: true })).toMatchObject({
      values: { precisionDriveVolumeDb: 9, chaosMode: 0, chaosWeight: 0.5 },
      dspState: { reverbEngineVersion: 5, namEffectsDspVersion: 19 },
    });
  });

  it("reserves built-in collection names and gives empty folders an explicit Unfiled collection", () => {
    expect(NAM_UNFILED_PRESET_COLLECTION_ID).toBe("unfiled");
    expect(["all", "Favorites", " recent ", "UNFILED"].every(
      (name) => isNAMReservedPresetCollectionName(name),
    )).toBe(true);
    expect(normalizeNAMUserPresetFolder("Favorites")).toBe("");
    expect(normalizeNAMUserPresetFolder("  Session / Leads  ")).toBe("Session Leads");
  });

  it("builds an exact mutable rollback patch without replaying read-only model flags", () => {
    expect(buildNAMRackRollbackPatch({
      values: {
        auditionSource: 1,
        inputMode: 2,
        tapeEchoEnabled: 1,
        tapeEchoMix: 0.63,
        tapeEchoTimeMs: 480,
        tapeEchoFeedback: 0.44,
        tapeEchoMod: 0.21,
        tapeEchoTone: 0.58,
        delayEnabled: 1,
        delayMix: 0.27,
        delayTimeMs: 640,
        delayMode: 1,
        pedalMix: 0.37,
        ignored: "not-a-number",
      },
      modelState: {
        pedalModelPath: " C:/NAM/Pedal.nam ",
        pedalModelSize: -0.2,
        pedalDeclaredCaptureType: "pedal",
        ampModelPath: "C:/NAM/Amp.nam",
        ampModelSize: 0.62,
        ampDeclaredCaptureType: "full_rig",
        cabIRPath: "",
        hasAmpModel: true,
        ampIncludesCab: false,
        cabRequestedEnabled: true,
      },
      uiState: {
        namActivePreview: { slot: "amp" },
        namPresetDirty: true,
        namPresetBaseline: {
          values: { inputMode: 0, ampMix: 0.8 },
        },
      },
      dspState: {
        reverbEngineVersion: 3,
        namEffectsDspVersion: 2,
        unknownEngineVersion: 99,
      },
    })).toEqual({
      values: {
        delayEnabled: 1,
        delayMix: 0.27,
        delayTimeMs: 640,
        delayMode: 1,
        pedalMix: 0.37,
      },
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        pedalModelSize: 0,
        pedalDeclaredCaptureType: "pedal",
        ampModelPath: "C:/NAM/Amp.nam",
        ampModelSize: 0.62,
        ampDeclaredCaptureType: "full_rig",
        clearCabIR: true,
        cabRequestedEnabled: true,
      },
      uiState: {
        namActivePreview: { slot: "amp" },
        namPresetDirty: true,
        namPresetBaseline: {
          values: { ampMix: 0.8 },
        },
      },
      dspState: {
        reverbEngineVersion: 5,
        namEffectsDspVersion: 19,
      },
    });
  });

  it("requires complete Compare readback for every explicitly recalled state domain", () => {
    const target = {
      values: { ampMix: 0.75, delayEnabled: 0 },
      modelState: {
        pedalModelPath: "C:/NAM/Drive.nam",
        pedalModelSize: 0.5,
        clearAmpModel: true,
        cabRequestedEnabled: false,
      },
      dspState: { reverbEngineVersion: 5, namEffectsDspVersion: 15 },
      postFxOrder: ["eq", "delay", "mod", "reverb"],
    };
    const readback = {
      values: { ampMix: 0.75, delayEnabled: 0 },
      modelState: {
        pedalModelPath: "C:/NAM/Drive.nam",
        pedalModelSize: 0.5,
        ampModelPath: "",
        cabRequestedEnabled: false,
      },
      dspState: { reverbEngineVersion: 5, namEffectsDspVersion: 15 },
    };

    expect(verifyNAMRackCompareReadback(
      target,
      readback,
      ["eq", "delay", "mod", "reverb"],
    )).toBe(true);
    expect(verifyNAMRackCompareReadback(
      target,
      { ...readback, values: { ampMix: 0.75 } },
      target.postFxOrder,
    )).toBe(false);
    expect(verifyNAMRackCompareReadback(
      target,
      { ...readback, modelState: { ...readback.modelState, ampModelPath: "C:/NAM/Wrong.nam" } },
      target.postFxOrder,
    )).toBe(false);
    expect(verifyNAMRackCompareReadback(
      target,
      { ...readback, dspState: { reverbEngineVersion: 4, namEffectsDspVersion: 2 } },
      target.postFxOrder,
    )).toBe(true);
    expect(verifyNAMRackCompareReadback(target, readback, ["eq", "mod", "delay", "reverb"])).toBe(false);

    expect(verifyNAMRackCompareReadback(
      { ...target, postFxOrder: [...NAM_RACK_DEFAULT_POST_FX_ORDER] },
      readback,
      undefined,
    )).toBe(true);
    expect(verifyNAMRackCompareReadback(
      target,
      readback,
      undefined,
    )).toBe(false);

    expect(verifyNAMRackCompareReadback(
      { values: { ampMix: 0.75 }, modelState: {} },
      { values: { ampMix: 0.75 }, modelState: {}, dspState: {} },
    )).toBe(true);
  });

  it("does not invent model quality while preparing rollback state", () => {
    expect(buildNAMRackRollbackPatch({
      values: {},
      modelState: {
        pedalModelPath: "C:/NAM/Pedal.nam",
        ampModelPath: "C:/NAM/Amp.nam",
      },
    })?.modelState).toEqual({
      pedalModelPath: "C:/NAM/Pedal.nam",
      ampModelPath: "C:/NAM/Amp.nam",
      clearCabIR: true,
    });
  });

  it("keeps Panel remove/import wiring tied to the transactional helpers", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const removeStart = panelSource.indexOf("const removeSlotModule");
    const removeEnd = panelSource.indexOf("const applyPreset", removeStart);
    const applyStart = removeEnd;
    const applyEnd = panelSource.indexOf("const saveUserPreset", applyStart);
    const importStart = panelSource.indexOf("const importUserPreset");
    const importEnd = panelSource.indexOf("const rememberIRPath", importStart);

    expect(panelSource.slice(removeStart, removeEnd)).toContain("values.precisionDriveEnabled = 0");
    expect(panelSource.slice(removeStart, removeEnd)).toContain("values.chaosEnabled = 0");
    expect(panelSource.slice(removeStart, removeEnd)).toContain("nextModelState.clearPedalModel = true");
    expect(panelSource).toContain("const triplePreampStackActive = precisionDriveActive && chaosActive && pedalActive");
    expect(panelSource).toContain("their Levels stack");
    expect(panelSource.slice(applyStart, applyEnd)).toContain("reverbEngineVersion: CURRENT_NAM_REVERB_ENGINE_VERSION");
    expect(panelSource.slice(applyStart, applyEnd)).toContain("namEffectsDspVersion: CURRENT_NAM_EFFECTS_DSP_VERSION");
    expect(panelSource).toContain("state: sanitizeNAMRackPortableDspState(state)");
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

  it("keeps NAM model quality as per-slot model state instead of an automatable parameter", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(panelSource).toContain('modelState: { [sizeKey]: Math.max(0, Math.min(1, requestedSize)) }');
    expect(panelSource).toContain("modelSnapshot.pedalModelSize");
    expect(panelSource).toContain("modelSnapshot.ampModelSize");
    expect(panelSource).toContain("if (Number.isFinite(modelState?.pedalModelSize))");
    expect(panelSource).toContain("if (Number.isFinite(modelState?.ampModelSize))");
    expect(panelSource).not.toContain('paramById(params, "namModelSize")');
  });

  it("keeps Full quality explicit to new model loads and preserves recall sizes", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const explorerSource = readFileSync(
      new URL("../components/NAMExplorer.tsx", import.meta.url),
      "utf8",
    );
    const bridgeSource = readFileSync(
      new URL("../services/NativeBridge.ts", import.meta.url),
      "utf8",
    );

    expect(panelSource).toContain('{ modelSize: NAM_FULL_MODEL_SIZE }');
    expect(explorerSource).toContain("ampModelSize: NAM_FULL_MODEL_SIZE");
    expect(explorerSource).toContain("pedalModelSize: NAM_FULL_MODEL_SIZE");
    expect(explorerSource).toContain("snapshot.ampModelSize === undefined");
    expect(explorerSource).toContain("snapshot.pedalModelSize === undefined");
    expect(bridgeSource).toContain("requestedModelSize");
    expect(bridgeSource).toContain("ampModelSize: requestedModelSize");
    expect(bridgeSource).toContain("pedalModelSize: requestedModelSize");
  });

  it("stores and synchronizes factory and user dirty state from complete readback baselines", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const dirtyStart = panelSource.indexOf("const persistedPresetDirty");
    const dirtyEnd = panelSource.indexOf("const currentCompareDirty", dirtyStart);
    const dirtySource = panelSource.slice(dirtyStart, dirtyEnd);
    const factoryStart = panelSource.indexOf("const applyPreset = async");
    const factoryEnd = panelSource.indexOf("const currentRackToneSlot", factoryStart);
    const factorySource = panelSource.slice(factoryStart, factoryEnd);

    expect(dirtySource).toContain("deriveNAMRackPresetDirtyState({");
    expect(dirtySource).toContain("differsFromBaseline: snapshotDiffers(currentSnapshot, activePresetBaseline)");
    expect(dirtySource).not.toContain("snapshotDiffers(currentSnapshot, activePresetBaseline) ||");
    expect(panelSource).toContain("shouldSynchronizeNAMRackPresetDirtyMarker({");
    expect(panelSource).toContain('{ namPresetDirty: isPresetDirty }');
    expect(factorySource).toContain("const loadedBaseline = presetBaselineFromState(loadedState)");
    expect(factorySource).toContain("baseline: loadedBaseline");
    expect(factorySource).toContain("verifyNAMRackCompareReadback(\n                loadedBaseline,");
  });

  it("drains parameter writes and publishes a native readback baseline before showing a saved preset as clean", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const headerSaveStart = panelSource.indexOf("const saveRackTone");
    const headerSaveEnd = panelSource.indexOf("const loadUserPreset", headerSaveStart);
    const headerSave = panelSource.slice(headerSaveStart, headerSaveEnd);

    expect(headerSave).toContain('drainPendingWritesForPresetTransaction("Preset save")');
    expect(headerSave.indexOf('drainPendingWritesForPresetTransaction("Preset save")')).toBeLessThan(
      headerSave.indexOf("saveNAMTone({"),
    );
    expect(headerSave).toContain("const savedBaseline = await capturePresetBaseline()");
    expect(headerSave).not.toContain("savedBaseline ?? currentSnapshot");
    expect(headerSave.indexOf("await onRefreshRack()")).toBeLessThan(
      headerSave.indexOf("setSaveToneOpen(false)"),
    );

    expect(panelSource).not.toContain("const saveUserPreset");
    expect(panelSource).toContain("<NAMPresetManagerModal");
    expect(panelSource).toContain("setPresetManagerOpen(false);\n          openSaveToneModal();");
  });

  it("commits one truthful active preset identity before closing and re-enabling navigation", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const factoryStart = panelSource.indexOf("const applyPreset = async");
    const factoryEnd = panelSource.indexOf("const currentRackToneSlot", factoryStart);
    const factoryLoad = panelSource.slice(factoryStart, factoryEnd);
    const userStart = panelSource.indexOf("const loadUserPreset = async");
    const userEnd = panelSource.indexOf("const applyHeaderPresetTarget", userStart);
    const userLoad = panelSource.slice(userStart, userEnd);
    const headerStart = userEnd;
    const headerEnd = panelSource.indexOf("const headerPresetTargetLabel", headerStart);
    const headerNavigation = panelSource.slice(headerStart, headerEnd);

    expect(panelSource).toContain("type NAMActivePresetIdentity =");
    expect(panelSource).not.toContain("setActiveUserPresetName");
    expect(panelSource).not.toContain("setPresetId");
    expect(panelSource).toContain("schema.uiState?.namActiveFactoryPresetId");
    expect(factoryLoad).toContain("factoryId: nextPreset.id");
    expect(factoryLoad.indexOf("drainPendingWritesForPresetTransaction")).toBeLessThan(
      factoryLoad.indexOf("readNAMRackPresetStateWithRetry("),
    );
    expect(factoryLoad).toContain("verifiedFactoryId !== nextPreset.id");
    expect(factoryLoad).toContain('publishActivePresetIdentity({ kind: "factory", id: nextPreset.id })');
    expect(factoryLoad.indexOf("await onRefreshRack()")).toBeLessThan(
      factoryLoad.indexOf('publishActivePresetIdentity({ kind: "factory", id: nextPreset.id })'),
    );
    expect(factoryLoad.indexOf("await onRefreshRack()")).toBeLessThan(
      factoryLoad.indexOf("setPresetManagerOpen(false)"),
    );
    expect(userLoad).toContain("const verifiedState = identityUpdated");
    expect(userLoad.indexOf("drainPendingWritesForPresetTransaction")).toBeLessThan(
      userLoad.indexOf("readNAMRackPresetStateWithRetry("),
    );
    expect(userLoad).toContain("const loadedBaseline = presetBaselineFromState(loadedState)");
    expect(userLoad).not.toContain("loadedBaseline ?? currentSnapshot");
    expect(userLoad).toContain('publishActivePresetIdentity({ kind: "user", name: presetName })');
    expect(userLoad.indexOf("await onRefreshRack()")).toBeLessThan(
      userLoad.indexOf("setPresetManagerOpen(false)"),
    );
    expect(headerNavigation).toContain("presetNavigationPendingRef.current");
    expect(headerNavigation).toContain("activePresetIdentityRef.current");
    expect(headerNavigation).toContain("sameNAMActivePresetIdentity(currentIdentity, targetIdentity)");
    expect(headerNavigation).toContain("runNAMHeaderPresetArrowAction(target");
    expect(headerNavigation).toContain("setPresetManagerOpen(true)");
    expect(panelSource).toContain("allowInactiveEntry: true");
    expect(panelSource).toContain('if (!target || target.kind === "user") return target');
    expect(panelSource).toContain("return targetPreset?.requiresAmpModel ? undefined : target");
    expect(panelSource).toContain('onPreviousPreset={!presetBusy && !presetManagerBusy && headerPreviousPresetAvailable\n                  ? () => void activateHeaderPresetDirection("previous")');
    expect(panelSource).toContain('onNextPreset={!presetBusy && !presetManagerBusy && headerNextPresetAvailable\n                  ? () => void activateHeaderPresetDirection("next")');
    expect(panelSource).toContain("headerPresetNavigation.previous || !activePresetIdentity");
    expect(panelSource).toContain("headerPresetNavigation.next || !activePresetIdentity");
    expect(panelSource).toContain("shouldClearNAMPresetIdentityForUnsavedAmpTransition({");
    expect(panelSource).toContain("schemaActiveUserPresetName,");
    expect(panelSource).toContain("schemaActiveFactoryPresetId,");
    expect(panelSource).toContain('setPresetStatus(`No other ${activePresetIdentityRef.current.kind === "user" ? "user preset" : "template"} is available`)');
    expect(panelSource).toContain('`${direction} unavailable: no other ${activePresetIdentity.kind === "user" ? "user preset" : "template"} available`');
    expect(panelSource).toContain('`${direction} preset: open Preset Library`');
    expect(panelSource).toContain("const reapplyActivePreset = async");
    expect(panelSource).toContain("onClick={() => void reapplyActivePreset()}");
    expect(panelSource).toContain('User: {activeUserPresetName}');
    expect(panelSource).toContain("presetStatus && !presetManagerOpen");
    expect(panelSource).toContain('data-qa="nam-preset-previous"');
    expect(panelSource).toContain('data-qa="nam-preset-next"');
    const managerSource = readFileSync(
      new URL("../components/NAMPresetManagerModal.tsx", import.meta.url),
      "utf8",
    );
    expect(managerSource).toContain('aria-current={entry.active ? "true" : undefined}');
    expect(managerSource).toContain('data-qa="nam-preset-load-selected"');
  });

  it("rolls back a changed rack when post-load verification fails", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const factoryStart = panelSource.indexOf("const applyPreset = async");
    const factoryEnd = panelSource.indexOf("const currentRackToneSlot", factoryStart);
    const factoryLoad = panelSource.slice(factoryStart, factoryEnd);
    const userStart = panelSource.indexOf("const loadUserPreset = async");
    const userEnd = panelSource.indexOf("const applyHeaderPresetTarget", userStart);
    const userLoad = panelSource.slice(userStart, userEnd);

    for (const loadSource of [factoryLoad, userLoad]) {
      expect(loadSource).toContain("const rackStateBeforeLoad = await readNAMRackPresetStateWithRetry(");
      expect(loadSource).not.toContain("const rackStateBeforeLoad = await nativeBridge.getBuiltInPluginState(address)");
      expect(loadSource).toContain("rollbackPatch = buildNAMRackRollbackPatch(rackStateBeforeLoad)");
      expect(loadSource).toContain("await recoverUnverifiedPresetMutation(");
      expect(loadSource.indexOf("buildNAMRackRollbackPatch(rackStateBeforeLoad)")).toBeLessThan(
        loadSource.indexOf("rackMutated = true"),
      );
    }
    expect(panelSource).toContain("The previous rack was restored.");
    expect(panelSource).toContain("publishActivePresetIdentity(null)");
    expect(panelSource).toContain("No preset is marked active.");
  });

  it("keeps preset discovery in a TTL session cache with explicit and mutation refreshes", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const managerSource = readFileSync(
      new URL("../components/NAMPresetManagerModal.tsx", import.meta.url),
      "utf8",
    );

    expect(panelSource).toContain("createNAMPresetSessionCache<UserRackPreset[]>");
    expect(panelSource).toContain("namUserPresetLibrarySession.peek() ?? []");
    expect(panelSource).toContain("namUserPresetLibrarySession.load(async () =>");
    expect(panelSource).toContain("namUserPresetLibrarySession.invalidate()");
    expect(panelSource).toContain("refreshUserPresetsAfterMutation()");
    expect(panelSource).toContain('const managerFactoryPresets = presetFolderFilter === "all"');
    expect(panelSource).toContain("presetFilterCounts.all + profileFactoryPresets.length");
    expect(managerSource).toContain('data-qa="nam-preset-refresh"');
    expect(managerSource).toContain("onRefresh: () => void | Promise<void>");
  });

  it("uses native button semantics and locks the preset manager during transactions", () => {
    const managerSource = readFileSync(
      new URL("../components/NAMPresetManagerModal.tsx", import.meta.url),
      "utf8",
    );
    const modalSource = readFileSync(
      new URL("../components/ui/Modal/Modal.tsx", import.meta.url),
      "utf8",
    );
    const managerCss = readFileSync(
      new URL("../components/NAMPresetManagerModal.css", import.meta.url),
      "utf8",
    );
    expect(managerSource).not.toContain('role="listbox"');
    expect(managerSource).not.toContain('role="option"');
    expect(managerSource).toContain("aria-pressed={selected}");
    expect(managerSource).toContain("aria-disabled={entry.disabled || undefined}");
    expect(managerSource).toContain("actionPendingRef.current");
    expect(managerSource).toContain("const locked = busy || actionPending");
    expect(managerSource).toContain("closeOnEscape={!locked}");
    expect(managerSource).toContain("closeOnOverlayClick={!locked}");
    expect(managerSource).toContain('id="nam-preset-manager-dialog"');
    expect(managerSource).toContain("autoFocus");
    expect(managerSource).toContain("aria-busy={locked || undefined}");
    expect(managerSource).toContain('type="search"');
    expect(managerSource).toContain("disabled={locked}");
    expect(managerSource).toContain("<MenuItems");
    expect(managerSource).toContain('anchor={{ to: "bottom end", gap: 4, padding: 8 }}');
    expect(managerSource).toContain("portal");
    expect(managerCss).toContain(".nam-preset-library-action-menu");
    expect(managerCss).toContain("z-index: 10020");
    expect(modalSource).toContain('className="fixed inset-0 z-[10000]"');
    expect(modalSource).toContain('className="fixed inset-0 flex items-center justify-center p-4"');
  });

  it("serializes, verifies, and rolls back Compare recall as one transaction", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const recallStart = panelSource.indexOf("const recallCompareSlot");
    const recallEnd = panelSource.indexOf("const rememberValues", recallStart);
    const recallSource = panelSource.slice(recallStart, recallEnd);

    expect(recallSource).toContain("presetTransactionPendingRef.current = true");
    expect(recallSource).toContain("drainPendingWritesForPresetTransaction");
    expect(recallSource).toContain("getBuiltInPluginState(address)");
    expect(recallSource).toContain("authoritativeCurrentSnapshot = presetBaselineFromState(authoritativeState)");
    expect(recallSource).toContain("rollbackCoversValues");
    expect(recallSource).toContain("rollbackCoversDsp");
    expect(recallSource).toContain("mutationAttempted = true");
    expect(recallSource).toContain("if (!ok) throw new Error(failureReason)");
    expect(recallSource).toContain("...(target.dspState ? { dspState: target.dspState } : {})");
    expect(recallSource).toContain("verifyNAMRackCompareReadback(target, verifiedState, verifiedPostFxOrder)");
    expect(recallSource).toContain("sameNAMPresetIdentityStatus");
    expect(recallSource).toContain("setBuiltInPluginState(address, rollbackPatch)");
    expect(recallSource).toContain("The previous rack was restored");
    expect(recallSource).not.toContain("current Preset was retained");
    expect(recallSource).toContain("presetTransactionPendingRef.current = false");
    expect(panelSource).toContain("dspState: stateRecord.dspState");
    expect(panelSource).toContain("disabled={presetBusy || presetManagerBusy}");
  });

  it("reports direct installed-model mutation and refresh failures without rejected event promises", () => {
    const explorerSource = readFileSync(
      new URL("../components/NAMExplorer.tsx", import.meta.url),
      "utf8",
    );
    for (const [startMarker, endMarker] of [
      ["const reinstallInstalled", "const updateInstalled"],
      ["const updateInstalled", "const toggleInstalledFavorite"],
      ["const toggleInstalledFavorite", "const removeInstalled"],
      ["const removeInstalled", "const snapshotValues"],
    ] as const) {
      const start = explorerSource.indexOf(startMarker);
      const end = explorerSource.indexOf(endMarker, start);
      const actionSource = explorerSource.slice(start, end);
      expect(actionSource).toContain("try {");
      expect(actionSource).toContain("beginInstalledLibraryMutation(");
      expect(actionSource).toContain("mutationCompleted = true");
      expect(actionSource).toContain("await refreshInstalledLibraryAfterMutation()");
      expect(actionSource).toContain("catch (error)");
      expect(actionSource).toContain("Retry Refresh");
      expect(actionSource).toContain("finally {");
      expect(actionSource).toContain("finishInstalledLibraryMutation(owner, key");
    }

    const designPortSource = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );
    expect(explorerSource).toContain("const installedLibraryMutationOwnerRef = useRef<number | null>(null)");
    expect(explorerSource).toContain("isNAMRackTransactionBusy(rackTransactionKey)");
    expect(explorerSource).toContain("installedLibraryMutationOwnerRef.current !== owner");
    expect(explorerSource).toContain("rackTransactionBusy || installedLibraryMutationPending || saveToneBusy");
    expect(explorerSource).toContain("disabled={rackActionsBusy || busyLibraryKey === installedKey(removeCandidate)}");
    expect(designPortSource).toContain("disabled={config.busy}");
  });

  it("renders and filters Unfiled separately from reserved built-in collections", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(panelSource).toContain("presetFolderFilter === NAM_UNFILED_PRESET_COLLECTION_ID && !folder");
    expect(panelSource).toContain('label: "Unfiled"');
    expect(panelSource).toContain("isNAMReservedPresetCollectionName(result)");
    expect(panelSource).toContain("is a built-in collection name");
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
