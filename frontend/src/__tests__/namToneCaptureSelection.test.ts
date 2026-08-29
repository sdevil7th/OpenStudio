import { describe, expect, it } from "vitest";
import type { NAMCatalogTone } from "../services/NativeBridge";
import { captureTypeForToneModel } from "../utils/namCaptureType";
import {
  collapseNAMCatalogRowsToTonePacks,
  isExplicitNAMCatalogCaptureSelection,
  namCatalogCaptureSelectionKey,
  namToneCaptureOptions,
  namToneDeclaredCaptureCount,
  namToneRequiresExplicitCapture,
  sameNAMCatalogModelIdentity,
  selectedNAMCatalogIdentity,
} from "../utils/namToneCaptureSelection";

const pack: NAMCatalogTone = {
  id: 67139,
  title: "Headbangers Ball Amp Pack IR/RAW",
  gear: "amp",
  a2_models_count: 3,
  models: [
    {
      id: 6713901,
      tone_id: 67139,
      name: "HB 01 RAW",
      architecture_version: 2,
      model_url: "https://example.invalid/hb-01-raw.nam",
    },
    {
      id: 6713902,
      tone_id: 67139,
      name: "HB 01 IR",
      architecture_version: 2,
      model_url: "https://example.invalid/hb-01-ir.nam",
    },
    {
      id: 6713902,
      tone_id: 67139,
      name: "Duplicate identity",
      architecture_version: 2,
      model_url: "https://example.invalid/duplicate.nam",
    },
  ],
};

describe("NAM tone pack capture selection", () => {
  it("deduplicates child captures while preserving exact durable identity", () => {
    const options = namToneCaptureOptions(pack);
    expect(options.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "67139:6713901", name: "HB 01 RAW" },
      { id: "67139:6713902", name: "HB 01 IR" },
    ]);
    expect(options.map(({ architecture }) => architecture)).toEqual(["A2", "A2"]);
  });

  it("requires explicit selection for a multi-capture pack", () => {
    expect(namToneDeclaredCaptureCount(pack)).toBe(2);
    expect(namToneRequiresExplicitCapture(pack)).toBe(true);
    expect(namToneRequiresExplicitCapture({ ...pack, models: [pack.models![0]], a2_models_count: 1 })).toBe(false);
  });

  it("gives URL-only captures distinct durable selection identities", () => {
    const urlOnlyPack: NAMCatalogTone = {
      id: 88001,
      title: "URL-only pack",
      models: [
        { name: "Clean", model_url: "https://example.invalid/captures/clean.nam" },
        { name: "Lead", model_url: "https://example.invalid/captures/lead.nam" },
      ],
    };
    const options = namToneCaptureOptions(urlOnlyPack);

    expect(options.map(({ id }) => id)).toEqual([
      "88001:url:https%3A%2F%2Fexample.invalid%2Fcaptures%2Fclean.nam",
      "88001:url:https%3A%2F%2Fexample.invalid%2Fcaptures%2Flead.nam",
    ]);
    expect(new Set(options.map(({ id }) => id)).size).toBe(2);
    expect(sameNAMCatalogModelIdentity(options[1].model, {
      modelUrl: "HTTPS://EXAMPLE.INVALID/CAPTURES/LEAD.NAM",
    })).toBe(true);

    const leadRowKey = "88001:0:latest:0:1";
    expect(isExplicitNAMCatalogCaptureSelection(
      options[1].id,
      leadRowKey,
      urlOnlyPack,
      options[1].model,
    )).toBe(true);
    expect(isExplicitNAMCatalogCaptureSelection(
      leadRowKey,
      leadRowKey,
      urlOnlyPack,
      options[1].model,
    )).toBe(true);
    expect(isExplicitNAMCatalogCaptureSelection(
      "88001:0",
      leadRowKey,
      urlOnlyPack,
      options[1].model,
    )).toBe(false);
    expect(namCatalogCaptureSelectionKey(urlOnlyPack, options[1].model)).toBe(options[1].id);
  });

  it("uses child RAW/IR labels ahead of broad parent gear metadata", () => {
    expect(captureTypeForToneModel(pack, pack.models![0])).toBe("amp");
    expect(captureTypeForToneModel(pack, pack.models![1])).toBe("amp_cab");
    expect(captureTypeForToneModel(pack, {
      ...pack.models![1],
      metadata: { gear_type: "amp" },
    })).toBe("amp");
  });

  it("collapses hydrated children to one pack row without losing order", () => {
    const rows = [
      { key: "67139:6713901", tone: pack },
      { key: "67139:6713902", tone: pack },
      { key: "88:1", tone: { id: 88, title: "Other" } },
    ];
    expect(collapseNAMCatalogRowsToTonePacks(rows).map(({ key }) => key)).toEqual([
      "67139:6713901",
      "88:1",
    ]);
  });

  it("parses stable tone/model selection keys and treats pack-only selection as non-explicit", () => {
    expect(selectedNAMCatalogIdentity("67139:6713902:latest:0:1")).toEqual({ toneId: 67139, modelId: 6713902 });
    expect(selectedNAMCatalogIdentity("67139:0")).toEqual({ toneId: 67139, modelId: 0 });
    expect(selectedNAMCatalogIdentity("")).toEqual({ toneId: 0, modelId: 0 });
  });
});
