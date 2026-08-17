import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAM_PRESET_SAVE_COPY,
  buildNAMToneSaveDraft,
  makeNAMActivePreview,
  normalizeNAMActivePreview,
  saveDraftToMetadata,
  saveNAMTone,
} from "../components/NAMToneSave";
import { nativeBridge, type BuiltInPluginSchema, type NAMInstalledModel } from "../services/NativeBridge";

const schema: BuiltInPluginSchema = {
  schemaVersion: 1,
  name: "OpenStudio NAM Rack",
  category: "Built-in",
  chain: "input",
  fxIndex: 0,
  parameters: [
    {
      id: "inputTrimDb",
      label: "Input",
      type: "continuous",
      value: 0,
      min: -24,
      max: 24,
      defaultValue: 0,
      unit: "dB",
    },
  ],
  modelState: {
    ampModelPath: "OpenStudio/NAM/previews/classic-crunch-a2.nam",
    pedalModelPath: "",
    cabIRPath: "",
  },
  uiState: {},
};

const address = {
  trackId: "track-1",
  chain: "input" as const,
  fxIndex: 0,
};

describe("NAM tone save metadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("presents the full rack as a NAM Preset", () => {
    expect(NAM_PRESET_SAVE_COPY).toMatchObject({
      title: "Save NAM Preset",
      action: "Save Preset",
      eyebrow: "Complete rack preset",
      nameLabel: "Preset Name",
    });
    expect(NAM_PRESET_SAVE_COPY.description).toContain("Captures, IR");
    expect(NAM_PRESET_SAVE_COPY.description).toContain("effect settings");
  });

  it("builds a draft from active preview metadata before saved/path fallbacks", () => {
    const draft = buildNAMToneSaveDraft({
      schema: {
        ...schema,
        uiState: {
          namSavedTone: {
            title: "Saved fallback",
            creator: "Saved Creator",
          },
        },
      },
      activePreview: {
        schemaVersion: 1,
        slot: "amp",
        title: "Preview Crunch",
        modelName: "Classic Crunch A2",
        creator: "ToneDev",
        localPath: "OpenStudio/NAM/previews/classic-crunch-a2.nam",
      },
    });

    expect(draft.toneName).toBe("Preview Crunch");
    expect(draft.creator).toBe("ToneDev");
  });

  it("deduplicates preset tags case-insensitively when building and saving a draft", () => {
    const draft = buildNAMToneSaveDraft({
      title: "Tag Guard",
      tags: ["amp", "Clean", "AMP", "clean", "cab"],
    });

    expect(draft.tags).toEqual(["AMP", "clean", "cab"]);
    expect(saveDraftToMetadata({
      ...draft,
      tagsText: "amp, Clean, AMP, clean, cab",
    }).tags).toEqual(["AMP", "clean", "cab"]);
  });

  it("round-trips requested Cab intent independently from the effective preview baseline", () => {
    const normalized = normalizeNAMActivePreview({
      slot: "amp",
      localPath: "OpenStudio/NAM/previews/full-rig.nam",
      baseline: {
        pedalModelPath: "",
        ampModelPath: "OpenStudio/NAM/library/amp.nam",
        cabIRPath: "OpenStudio/NAM/library/cab.wav",
        pedalDeclaredCaptureType: "unknown",
        ampDeclaredCaptureType: "full-rig",
        cabEnabled: 0,
        cabRequestedEnabled: true,
        pedalMix: 0,
        ampEnabled: 0,
        ampMix: 0,
      },
    });

    expect(normalized?.baseline).toMatchObject({
      cabEnabled: 0,
      cabRequestedEnabled: true,
      pedalDeclaredCaptureType: "unknown",
      ampDeclaredCaptureType: "full_rig",
      ampEnabled: 0,
      ampMix: 0,
    });
  });

  it("commits preview downloads and persists saved tone identity", async () => {
    const previewRecord: NAMInstalledModel = {
      modelId: 5320302,
      toneId: 53203,
      name: "Classic Crunch A2",
      toneTitle: "Classic Crunch",
      creator: "Scott M.",
      localPath: "OpenStudio/NAM/previews/classic-crunch-a2.nam",
      sourceUrl: "https://www.tone3000.com/tones/53203",
      license: "Free",
      preview: true,
    };
    const committedRecord: NAMInstalledModel = {
      ...previewRecord,
      preview: false,
      localPath: "OpenStudio/NAM/library/classic-crunch-a2.nam",
    };
    const activePreview = makeNAMActivePreview(previewRecord, {
      key: "53203:5320302",
      slot: "amp",
      toneId: 53203,
      modelId: 5320302,
      title: "Classic Crunch",
      modelName: "Classic Crunch A2",
      creator: "Scott M.",
      localPath: previewRecord.localPath,
      previousPath: "",
      source: "catalog",
      previewDownload: true,
      saved: false,
      action: "live-preview",
      sourceUrl: previewRecord.sourceUrl,
      license: previewRecord.license,
    });
    const setState = vi.spyOn(nativeBridge, "setBuiltInPluginState").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setBuiltInPluginParam").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getBuiltInPluginState").mockResolvedValue({
      values: {
        inputTrimDb: 1.5,
        auditionSource: 1,
        reverbEnabled: 1,
        reverbDecaySec: 9.25,
        reverbShimmer: 0.42,
      },
      modelState: {
        ampModelPath: previewRecord.localPath,
        ampModelSize: 0.75,
        pedalModelPath: "OpenStudio/NAM/library/drive.nam",
        pedalModelSize: 0.5,
        cabIRPath: "OpenStudio/IR/library/studio.wav",
        cabRequestedEnabled: true,
      },
      dspState: {
        reverbEngineVersion: 5,
        namEffectsDspVersion: 11,
      },
      uiState: {
        namActivePreview: activePreview,
        namPresetDirty: true,
        namActivePresetName: "Earlier Preset",
        namPresetBaseline: { values: { reverbDecaySec: 2.2 } },
        namRackSlots: {
          order: ["gate", "pedal", "amp", "cab", "delay", "reverb", "mod", "eq"],
        },
      },
    });
    const commit = vi.spyOn(nativeBridge, "commitNAMPreviewTone").mockResolvedValue({
      success: true,
      record: committedRecord,
    });
    const savePreset = vi.spyOn(nativeBridge, "saveBuiltInFXPreset").mockResolvedValue(true);

    const result = await saveNAMTone({
      address,
      schema,
      metadata: {
        toneName: "My Saved Crunch",
        creator: "Session User",
        sourceUrl: previewRecord.sourceUrl,
        license: "Free",
      },
      activePreview,
      selectedRecord: previewRecord,
      slotHint: "amp",
      sourceIds: {
        toneId: 53203,
        modelId: 5320302,
      },
    });

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(commit).toHaveBeenCalledWith(previewRecord, expect.objectContaining({
      toneName: "My Saved Crunch",
      creator: "Session User",
    }), expect.objectContaining({
      dspState: {
        reverbEngineVersion: 5,
        namEffectsDspVersion: 11,
      },
    }));
    expect(result.savedTone?.title).toBe("My Saved Crunch");
    expect(result.savedTone?.captureTitle).toBe("Classic Crunch");
    expect(result.savedTone?.modelName).toBe("Classic Crunch A2");
    expect(result.savedTone?.creator).toBe("Session User");
    expect(result.savedTone?.localPath).toBe(committedRecord.localPath);
    expect(result.savedTone?.toneId).toBe(53203);
    expect(result.savedTone?.modelId).toBe(5320302);
    expect(result.savedTone?.rackState).toMatchObject({
      values: {
        reverbEnabled: 1,
        reverbDecaySec: 9.25,
        reverbShimmer: 0.42,
      },
      modelState: {
        pedalModelPath: "OpenStudio/NAM/library/drive.nam",
        pedalModelSize: 0.5,
        ampModelPath: committedRecord.localPath,
        ampModelSize: 0.75,
        cabIRPath: "OpenStudio/IR/library/studio.wav",
        cabRequestedEnabled: true,
      },
      dspState: {
        reverbEngineVersion: 5,
        namEffectsDspVersion: 11,
      },
      slotOrder: ["gate", "pedal", "amp", "cab", "delay", "reverb", "mod", "eq"],
    });
    expect(result.savedTone?.values).not.toHaveProperty("auditionSource");
    expect(setState).toHaveBeenCalledWith(address, expect.objectContaining({
      modelState: expect.objectContaining({
        ampModelPath: committedRecord.localPath,
        ampDeclaredCaptureType: "unknown",
      }),
      uiState: expect.objectContaining({
        namActivePreview: null,
        namPresetDirty: false,
        namActivePresetName: null,
        namPresetBaseline: null,
        namSavedTone: expect.objectContaining({
          title: "My Saved Crunch",
          localPath: committedRecord.localPath,
        }),
      }),
    }));
    const finalStateWriteOrder = setState.mock.invocationCallOrder[setState.mock.invocationCallOrder.length - 1];
    expect(finalStateWriteOrder).toBeLessThan(savePreset.mock.invocationCallOrder[0]);
  });

  it("persists committed Cab/IR previews into the cab slot", async () => {
    const cabSchema: BuiltInPluginSchema = {
      ...schema,
      modelState: {
        ampModelPath: "OpenStudio/NAM/library/amp.nam",
        pedalModelPath: "",
        cabIRPath: "OpenStudio/NAM/previews/bright-room.wav",
      },
    };
    const previewRecord: NAMInstalledModel = {
      modelId: 7002,
      toneId: 700,
      name: "Bright Room IR",
      toneTitle: "Bright Room",
      creator: "IR Maker",
      gear: "Cab",
      gearType: "Cabinet IR",
      localPath: "OpenStudio/NAM/previews/bright-room.wav",
      preview: true,
    };
    const committedRecord: NAMInstalledModel = {
      ...previewRecord,
      preview: false,
      localPath: "OpenStudio/NAM/library/bright-room.wav",
    };
    const activePreview = makeNAMActivePreview(previewRecord, {
      key: "700:7002",
      slot: "cab",
      toneId: 700,
      modelId: 7002,
      title: "Bright Room",
      modelName: "Bright Room IR",
      creator: "IR Maker",
      localPath: previewRecord.localPath,
      source: "catalog",
      previewDownload: true,
      saved: false,
      action: "live-preview",
    });
    const setState = vi.spyOn(nativeBridge, "setBuiltInPluginState").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getBuiltInPluginState").mockResolvedValue({
      values: {
        inputTrimDb: 0,
        auditionSource: 1,
      },
      modelState: cabSchema.modelState,
      uiState: {
        namActivePreview: activePreview,
      },
    });
    vi.spyOn(nativeBridge, "commitNAMPreviewTone").mockResolvedValue({
      success: true,
      record: committedRecord,
    });
    vi.spyOn(nativeBridge, "saveBuiltInFXPreset").mockResolvedValue(true);

    const result = await saveNAMTone({
      address,
      schema: cabSchema,
      metadata: {
        toneName: "My Cab Tone",
        creator: "Session User",
      },
      activePreview,
      selectedRecord: previewRecord,
      slotHint: "cab",
    });

    expect(result.success).toBe(true);
    expect(result.savedTone?.slot).toBe("cab");
    expect(result.savedTone?.slots.cab).toBe(committedRecord.localPath);
    expect(setState).toHaveBeenCalledWith(address, expect.objectContaining({
      modelState: {
        cabIRPath: committedRecord.localPath,
      },
      uiState: expect.objectContaining({
        namSavedTone: expect.objectContaining({
          slot: "cab",
          localPath: committedRecord.localPath,
        }),
      }),
    }));
  });

  it("saves a full rig without erasing the user's requested external-Cab preference", async () => {
    const fullRigRecord: NAMInstalledModel = {
      modelId: 8102,
      toneId: 810,
      name: "Studio Full Rig",
      toneTitle: "Studio Full Rig",
      creator: "Rig Maker",
      gearType: "full-rig",
      captureType: "full_rig",
      localPath: "OpenStudio/NAM/library/studio-full-rig.nam",
    };
    const activePreview = makeNAMActivePreview(fullRigRecord, {
      key: "810:8102",
      slot: "amp",
      localPath: fullRigRecord.localPath,
      source: "installed",
      saved: false,
      action: "live-preview",
      captureType: "full_rig",
      includesCab: true,
    });
    const currentState = {
      values: {
        inputTrimDb: 0,
        auditionSource: 0,
        cabEnabled: 0,
        ampEnabled: 1,
        ampMix: 1,
      },
      modelState: {
        ampModelPath: fullRigRecord.localPath,
        pedalModelPath: "",
        cabIRPath: "OpenStudio/NAM/library/retained-cab.wav",
        hasAmpModel: true,
        ampIncludesCab: true,
        cabRequestedEnabled: true,
      },
      uiState: {
        namActivePreview: activePreview,
      },
    };
    vi.spyOn(nativeBridge, "getBuiltInPluginState").mockResolvedValue(currentState);
    const setParam = vi.spyOn(nativeBridge, "setBuiltInPluginParam").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setBuiltInPluginState").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "saveBuiltInFXPreset").mockResolvedValue(true);

    const result = await saveNAMTone({
      address,
      schema,
      metadata: {
        toneName: "Full Rig Preset",
        creator: "Session User",
      },
      activePreview,
      selectedRecord: fullRigRecord,
      slotHint: "amp",
    });

    expect(result.success).toBe(true);
    expect(result.savedTone?.modelState.cabRequestedEnabled).toBe(true);
    expect(result.savedTone?.modelState.ampDeclaredCaptureType).toBe("full_rig");
    expect(result.savedTone?.values.cabEnabled).toBe(0);
    expect(setParam).toHaveBeenCalledWith(address, "auditionSource", 0);
    expect(setParam).not.toHaveBeenCalledWith(address, "cabEnabled", expect.any(Number));
  });

  it("reports failure when the native preset cannot be saved for reopen", async () => {
    vi.spyOn(nativeBridge, "getBuiltInPluginState").mockResolvedValue({
      values: {
        inputTrimDb: 0,
        auditionSource: 1,
        pedalMix: 0.35,
      },
      modelState: schema.modelState,
      uiState: {
        namActivePreview: { slot: "amp", saved: false },
      },
    });
    vi.spyOn(nativeBridge, "setBuiltInPluginParam").mockResolvedValue(true);
    const setState = vi.spyOn(nativeBridge, "setBuiltInPluginState").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "saveBuiltInFXPreset").mockResolvedValue(false);

    const result = await saveNAMTone({
      address,
      schema,
      metadata: {
        toneName: "Reopen Guard",
        creator: "Session User",
      },
      selectedRecord: null,
      slotHint: "amp",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Preset could not be saved");
    expect(result.error).toContain("previous rack was restored");
    expect(setState).toHaveBeenLastCalledWith(address, {
      values: {
        inputTrimDb: 0,
        pedalMix: 0.35,
      },
      modelState: {
        clearPedalModel: true,
        ampModelPath: "OpenStudio/NAM/previews/classic-crunch-a2.nam",
        ampModelSize: 1,
        clearCabIR: true,
      },
      uiState: {
        namActivePreview: { slot: "amp", saved: false },
      },
    });
  });
});
