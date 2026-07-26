import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundNAMCatalogRowsForDisplay,
  classifyNAMSourceCategory,
  mergeTONE3000TonePages,
  modelArchitecture,
  resolveNAMCatalogSelection,
  tone3000LivePageSizing,
} from "../components/NAMExplorer";
import { nativeBridge } from "../services/NativeBridge";

describe("TONE3000 dev NAM search mock", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: {
        search: "?mockPlugin=nam",
      },
    });
  });

  it("respects sort, page, page_size, totals, and total pages", async () => {
    const firstPage = await nativeBridge.searchTONE3000NAM({
      page: 1,
      page_size: 2,
      sort: "downloads-all-time",
      gears: "amp_amp-cab",
      architecture: "all",
    });
    const secondPage = await nativeBridge.searchTONE3000NAM({
      page: 2,
      page_size: 2,
      sort: "downloads-all-time",
      gears: "amp_amp-cab",
      architecture: "all",
    });

    expect(firstPage.success).toBe(true);
    expect(firstPage.page).toBe(1);
    expect(firstPage.page_size).toBe(2);
    expect(firstPage.total).toBe(72);
    expect(firstPage.total_pages).toBe(36);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_page).toBe(2);
    expect(firstPage.tones?.map((tone) => tone.title)).toEqual([
      "Crisp Twin Clean A2",
      "Jazz Chorus Glass",
    ]);
    expect(secondPage.page).toBe(2);
    expect(secondPage.tones?.map((tone) => tone.title)).toEqual([
      "Edge Clean Breakup",
      "High Gain Modern",
    ]);
  });

  it("models preview-to-library promotion with a new durable path", async () => {
    const preview = await nativeBridge.installNAMModel({
      id: 5320302,
      model_id: 5320302,
      tone_id: 53203,
      name: "Classic Crunch A2",
      model_url: "https://example.invalid/classic-crunch-a2.nam",
    }, { mode: "preview" });

    expect(preview.record?.preview).toBe(true);
    expect(preview.record?.localPath.replace(/\\/g, "/")).toContain("/previews/");

    const committed = await nativeBridge.commitNAMPreviewTone(preview.record!, {
      toneName: "Classic Crunch",
    });

    expect(committed.success).toBe(true);
    expect(committed.record?.preview).toBe(false);
    expect(committed.record?.localPath.replace(/\\/g, "/")).toContain("/library/tone-53203/");
    expect(committed.record?.localPath).not.toBe(preview.record?.localPath);
  });

  it("keeps each UI surface inside a bounded live-search page budget", () => {
    expect(tone3000LivePageSizing("rail", "all")).toEqual({
      targetPageSize: 4,
      apiPageSize: 2,
    });
    expect(tone3000LivePageSizing("source-flow", "all")).toEqual({
      targetPageSize: 12,
      apiPageSize: 6,
    });
    expect(tone3000LivePageSizing("full", "all")).toEqual({
      targetPageSize: 24,
      apiPageSize: 12,
    });
    expect(tone3000LivePageSizing("full", "a2")).toEqual({
      targetPageSize: 24,
      apiPageSize: 24,
    });
  });

  it("bounds the initial saved-catalog DOM per surface without truncating live append results", () => {
    const rows = Array.from({ length: 72 }, (_, index) => `tone-${index + 1}`);

    expect(boundNAMCatalogRowsForDisplay(rows, "rail", "cache", "latest")).toHaveLength(4);
    expect(boundNAMCatalogRowsForDisplay(rows, "source-flow", "cache", "latest")).toHaveLength(12);
    expect(boundNAMCatalogRowsForDisplay(rows, "full", "cache", "latest")).toHaveLength(24);
    expect(boundNAMCatalogRowsForDisplay(rows, "full", "live", "latest")).toBe(rows);
    expect(boundNAMCatalogRowsForDisplay(rows, "source-flow", "cache", "installed")).toBe(rows);
    expect(boundNAMCatalogRowsForDisplay(rows, "source-flow", "cache", "favorites")).toBe(rows);
  });

  it("deduplicates appended server pages by stable tone identity", () => {
    const first = [
      { id: 100, title: "First" },
      { id: 101, title: "Second" },
    ];
    const second = [
      { id: 101, title: "Second duplicate from another architecture page" },
      { id: 102, title: "Third" },
    ];

    expect(mergeTONE3000TonePages(first, second, true).map((tone) => tone.id)).toEqual([100, 101, 102]);
    expect(mergeTONE3000TonePages(first, second, false).map((tone) => tone.id)).toEqual([101, 102]);
  });

  it("returns a compact newest page that matches the rack rail browse shape", async () => {
    const payload = await nativeBridge.searchTONE3000NAM({
      page: 1,
      page_size: 4,
      sort: "newest",
      gears: "amp_amp-cab",
      architecture: "all",
    });

    expect(payload.success).toBe(true);
    expect(payload.page).toBe(1);
    expect(payload.page_size).toBe(4);
    expect(payload.total).toBe(72);
    expect(payload.total_pages).toBe(18);
    expect(payload.tones?.map((tone) => tone.title)).toEqual([
      "Ambient Glow",
      "Classic Crunch",
      "High Gain Modern",
      "Blues Breaker",
    ]);
  });

  it("preserves A2 identity on summary-only search rows", async () => {
    const payload = await nativeBridge.searchTONE3000NAM({
      page: 1,
      page_size: 4,
      sort: "newest",
      gears: "amp_amp-cab",
      architecture: "a2",
      includeModels: false,
    });

    expect(payload.success).toBe(true);
    expect(payload.total).toBeGreaterThan(0);
    expect(payload.tones?.length).toBeGreaterThan(0);
    for (const tone of payload.tones ?? []) {
      expect(tone.models).toBeUndefined();
      expect(tone.searchArchitecture).toBe("2");
      expect(modelArchitecture(tone, {})).toBe("A2");
    }
  });

  it("separates cabinet IR rows from space IR source material", async () => {
    const payload = await nativeBridge.searchTONE3000NAM({
      query: "ir",
      page: 1,
      page_size: 20,
      sort: "name-az",
      gears: "ir",
      architecture: "all",
    });

    expect(payload.success).toBe(true);
    const categories = new Set((payload.tones ?? []).map((tone) => classifyNAMSourceCategory(tone.gear, tone.character, tone.description)));
    expect(categories.has("cabinet-ir")).toBe(true);
    expect(categories.has("space-ir")).toBe(true);
  });

  it("supports the production cabinet IR request without NAM format conflicts", async () => {
    const payload = await nativeBridge.searchTONE3000NAM({
      page: 1,
      page_size: 20,
      sort: "trending",
      gears: "cab",
      format: "ir",
      architecture: "",
      includeModels: false,
    });

    expect(payload.success).toBe(true);
    expect(payload.total).toBeGreaterThan(0);
    expect(payload.tones?.length).toBeGreaterThan(0);
    for (const tone of payload.tones ?? []) {
      expect(tone.models).toBeUndefined();
      expect(tone.platform).toBe("ir");
      expect(classifyNAMSourceCategory(tone.gear, tone.character, tone.description)).toBe("cabinet-ir");
    }
  });

  it("hydrates an IR tone without applying a NAM architecture filter", async () => {
    const detail = await nativeBridge.getTONE3000ToneDetail(53109, "");

    expect(detail.success).toBe(true);
    expect(detail.models).toHaveLength(1);
    expect(detail.models?.[0]?.model_url).toMatch(/\.wav$/);
  });

  it("keeps mock cabinet IR installs as audio files", async () => {
    const payload = await nativeBridge.searchTONE3000NAM({
      query: "cabinet",
      page: 1,
      page_size: 5,
      sort: "name-az",
      gears: "ir",
      architecture: "all",
    });
    const cabinetModel = payload.tones?.flatMap((tone) => tone.models ?? [])
      .find((model) => classifyNAMSourceCategory(model.gear_type, model.name, model.model_url) === "cabinet-ir");

    expect(cabinetModel).toBeTruthy();
    const result = await nativeBridge.installNAMModel(cabinetModel!, { mode: "preview" });

    expect(result.success).toBe(true);
    expect(result.record?.localPath).toMatch(/\.wav$/);
    expect(result.record?.gearType).toBe("cabinet-ir");
  });

  it("hydrates tone detail with architecture-filtered models", async () => {
    const detail = await nativeBridge.getTONE3000ToneDetail(53101, "a2");

    expect(detail.success).toBe(true);
    expect(detail.tone?.title).toBe("Crisp Twin Clean A2");
    expect(detail.models).toHaveLength(1);
    expect(detail.models?.[0]?.model_url).toContain("crisp-twin-clean-a2.nam");
    expect(detail.models?.[0]?.inputCalibrationDb).toBe(-12);
    expect(detail.models?.[0]?.normalization).toMatchObject({
      mode: "A2 calibrated",
      targetLufs: -18,
    });
  });

  it("keeps a summary-only tone selected when hydration replaces its placeholder model key", () => {
    const hydratedRows = [
      {
        key: "53101:5310102:trending:0:0",
        tone: { id: 53101, title: "Crisp Twin Clean A2" },
        model: { id: 5310102, name: "Crisp Twin Clean A2" },
      },
      {
        key: "53102:5310202:trending:1:0",
        tone: { id: 53102, title: "Other tone" },
        model: { id: 5310202, name: "Other model" },
      },
    ];

    expect(resolveNAMCatalogSelection(
      hydratedRows,
      "53101:0:trending:0:0",
      hydratedRows[1],
    )?.key).toBe("53101:5310102:trending:0:0");

    const multiModelRows = [
      hydratedRows[0],
      {
        key: "53101:5310103:trending:0:1",
        tone: hydratedRows[0].tone,
        model: { id: 5310103, name: "Chosen full rig" },
      },
    ];
    expect(resolveNAMCatalogSelection(
      multiModelRows,
      "53101:5310103",
      multiModelRows[0],
    )?.key).toBe("53101:5310103:trending:0:1");
  });

  it("returns not found for missing mock tone details", async () => {
    const detail = await nativeBridge.getTONE3000ToneDetail(999999, "all");

    expect(detail.success).toBe(false);
    expect(detail.statusCode).toBe(404);
  });

  it("preserves install metadata and supports preview rack load", async () => {
    const detail = await nativeBridge.getTONE3000ToneDetail(53101, "a2");
    const model = detail.models?.[0];
    expect(model).toBeTruthy();

    const result = await nativeBridge.installNAMModel({
      ...model!,
      toneTitle: detail.tone?.title,
      creator: detail.tone?.creator,
      gearType: detail.tone?.gear,
      license: "Free",
    }, { mode: "preview" });

    expect(result.success).toBe(true);
    expect(result.record?.preview).toBe(true);
    expect(result.record?.toneTitle).toBe("Crisp Twin Clean A2");
    expect(result.record?.creator).toBe("OpenStudio QA");
    expect(result.record?.sourceProvider).toBe("tone3000");
    expect(result.record?.lastSeenMetadata?.inputCalibrationDb).toBe(-12);

    await expect(nativeBridge.loadNAMModelIntoRack({
      chain: "track",
      trackId: "track-1",
      fxIndex: 0,
    }, "amp", result.record!.localPath)).resolves.toBe(true);
  });
});
