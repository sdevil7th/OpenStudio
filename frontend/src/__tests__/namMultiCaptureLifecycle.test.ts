// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { captureTypeForToneModel } from "../utils/namCaptureType";

const explorerSource = readFileSync(
  new URL("../components/NAMExplorer.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
const designPortSource = readFileSync(
  new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
const rackPanelSource = readFileSync(
  new URL("../components/NAMRackPanel.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");

describe("NAM multi-capture lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { search: "?mockPlugin=nam&mockNAMScenario=empty-rack" },
      setTimeout,
    });
  });

  it("hydrates the deterministic pack with four exact child identities", async () => {
    const detail = await nativeBridge.getTONE3000ToneDetail(67139, "a2");
    expect(detail.success).toBe(true);
    expect(detail.tone?.title).toBe("Headbangers Ball Amp Pack IR/RAW");
    expect(detail.models?.map((model) => model.model_id)).toEqual([
      6713901,
      6713902,
      6713903,
      6713904,
    ]);
    expect(detail.models?.map((model) => captureTypeForToneModel(detail.tone!, model))).toEqual([
      "amp",
      "amp_cab",
      "amp",
      "amp_cab",
    ]);
  });

  it("keeps preview and durable paths distinct for every selected child", async () => {
    const detail = await nativeBridge.getTONE3000ToneDetail(67139, "a2");
    const rawModel = detail.models![0];
    const irModel = detail.models![1];
    const rawPreview = await nativeBridge.installNAMModel(rawModel, { mode: "preview" });
    const irPreview = await nativeBridge.installNAMModel(irModel, { mode: "preview" });

    expect(rawPreview.record?.modelId).toBe(6713901);
    expect(irPreview.record?.modelId).toBe(6713902);
    expect(rawPreview.record?.localPath).not.toBe(irPreview.record?.localPath);
    expect(rawPreview.record?.localPath.replace(/\\/g, "/")).toContain("/previews/tone-67139/");

    const committed = await nativeBridge.commitNAMPreviewTone(irPreview.record!, {
      toneName: detail.tone!.title!,
    });
    expect(committed.success).toBe(true);
    expect(committed.record?.modelId).toBe(6713902);
    expect(committed.record?.preview).toBe(false);
    expect(committed.record?.localPath.replace(/\\/g, "/")).toContain("/library/tone-67139/");
    expect(committed.record?.localPath).not.toBe(irPreview.record?.localPath);
  });

  it("replaces RAW with cab-embedded, bypasses, re-enables, and clears without stale identity", async () => {
    const address = { chain: "track" as const, trackId: "nam-multi-capture-lifecycle", fxIndex: 0 };
    const detail = await nativeBridge.getTONE3000ToneDetail(67139, "a2");
    const raw = await nativeBridge.installNAMModel(detail.models![0], { mode: "preview" });
    const embedded = await nativeBridge.installNAMModel(detail.models![1], { mode: "preview" });

    await expect(nativeBridge.setBuiltInPluginState(address, {
      modelState: {
        ampModelPath: raw.record!.localPath,
        ampModelSize: 1,
        ampDeclaredCaptureType: "amp",
        cabRequestedEnabled: true,
      },
      values: { ampEnabled: 1, ampMix: 1, cabEnabled: 1 },
    })).resolves.toBe(true);
    let state = await nativeBridge.getBuiltInPluginState(address);
    expect(state.modelState).toMatchObject({
      ampModelPath: raw.record!.localPath,
      ampCaptureType: "amp",
      ampIncludesCab: false,
      ampModelSize: 1,
    });
    expect(state.values?.cabEnabled).toBe(1);

    await expect(nativeBridge.setBuiltInPluginState(address, {
      modelState: {
        ampModelPath: embedded.record!.localPath,
        ampModelSize: 1,
        ampDeclaredCaptureType: "amp_cab",
        cabRequestedEnabled: true,
      },
      values: { ampEnabled: 1, ampMix: 1 },
    })).resolves.toBe(true);
    state = await nativeBridge.getBuiltInPluginState(address);
    expect(state.modelState).toMatchObject({
      ampModelPath: embedded.record!.localPath,
      ampCaptureType: "amp_cab",
      ampIncludesCab: true,
      cabRequestedEnabled: true,
    });
    expect(state.values?.cabEnabled).toBe(0);

    await expect(nativeBridge.setBuiltInPluginParam(address, "ampEnabled", 0)).resolves.toBe(true);
    expect((await nativeBridge.getBuiltInPluginState(address)).values?.ampEnabled).toBe(0);
    await expect(nativeBridge.setBuiltInPluginParam(address, "ampEnabled", 1)).resolves.toBe(true);
    expect((await nativeBridge.getBuiltInPluginState(address)).values?.ampEnabled).toBe(1);

    await expect(nativeBridge.setBuiltInPluginState(address, {
      modelState: { clearAmpModel: true },
    })).resolves.toBe(true);
    state = await nativeBridge.getBuiltInPluginState(address);
    expect(state.modelState).toMatchObject({
      ampModelPath: "",
      hasAmpModel: false,
      ampCaptureType: "unknown",
      ampIncludesCab: false,
    });
  });

  it("requires an explicit child and exposes the picker on desktop and compact source-flow surfaces", () => {
    expect(explorerSource).toContain("namToneRequiresExplicitCapture(tone) && !rowHasExplicitSelection");
    expect(explorerSource).toContain("isExplicitNAMCatalogCaptureSelection(selectedKey, row.key, tone, model)");
    expect(explorerSource).toContain("namCatalogCaptureSelectionKey(tone, model)");
    expect(explorerSource).toContain("activePreview.key,\n          selected.catalogRow.key");
    expect(explorerSource).toContain("Choose a specific capture in this pack before auditioning");
    expect(explorerSource).toContain("Choose a specific capture in this pack before using it");
    expect(explorerSource).toContain("if (models.length > 1)");
    expect(explorerSource).toContain('mode === "preview" && catalogAuditionIsActive(catalogRow)');
    expect(explorerSource).toContain('mode === "preview" && installedAuditionIsActive(installedRecord)');
    expect(explorerSource).not.toContain("models.find((candidate) => preferredTargetForToneModel(tone, candidate) === requestedTarget)");
    expect(designPortSource).toContain("className=\"tone-compact-capture-picker\"");
    expect((designPortSource.match(/<NAMToneCapturePicker/g) ?? [])).toHaveLength(2);
    expect(designPortSource).toContain('emit("select-capture"');
    expect(designPortSource).toContain('emit("preview"');
    expect(designPortSource).toContain('emit("use-selection"');
    expect(designPortSource).toContain('data-rack-action="unload-amp-capture"');
    expect(rackPanelSource).toContain("const clearAmpCapture = async");
    expect(rackPanelSource).toContain("modelState: { clearAmpModel: true }");
  });
});
