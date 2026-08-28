import type { NAMCatalogModel, NAMCatalogTone } from "../services/NativeBridge";
import {
  captureIncludesCab,
  captureTypeForToneModel,
  type NAMCaptureType,
} from "./namCaptureType";

export type NAMToneCaptureOption = {
  id: string;
  toneId: number;
  modelId: number;
  name: string;
  architecture: string;
  captureType: NAMCaptureType;
  includesCab: boolean;
  downloadable: boolean;
  model: NAMCatalogModel;
};

export function namCatalogToneId(tone: NAMCatalogTone): number {
  return Number(tone.id ?? tone.toneId ?? 0) || 0;
}

export function namCatalogModelId(model: NAMCatalogModel): number {
  return Number(model.id ?? model.model_id ?? 0) || 0;
}

export function namCatalogModelDownloadUrl(model: NAMCatalogModel): string {
  return String(model.model_url ?? model.modelUrl ?? "").trim();
}

export function namCatalogCaptureSelectionKey(
  tone: NAMCatalogTone,
  model: NAMCatalogModel,
): string {
  const toneId = namCatalogToneId(tone);
  const modelId = namCatalogModelId(model);
  if (modelId > 0) return `${toneId}:${modelId}`;

  const downloadUrl = namCatalogModelDownloadUrl(model).toLowerCase();
  return downloadUrl
    ? `${toneId}:url:${encodeURIComponent(downloadUrl)}`
    : `${toneId}:0`;
}

export function sameNAMCatalogModelIdentity(
  left: NAMCatalogModel,
  right: NAMCatalogModel,
): boolean {
  if (left === right) return true;

  const leftId = namCatalogModelId(left);
  const rightId = namCatalogModelId(right);
  if (leftId > 0 || rightId > 0) return leftId > 0 && leftId === rightId;

  const leftUrl = namCatalogModelDownloadUrl(left).toLowerCase();
  const rightUrl = namCatalogModelDownloadUrl(right).toLowerCase();
  return Boolean(leftUrl && leftUrl === rightUrl);
}

export function isExplicitNAMCatalogCaptureSelection(
  selectedKey: string,
  rowKey: string,
  tone: NAMCatalogTone,
  model: NAMCatalogModel,
): boolean {
  const captureKey = namCatalogCaptureSelectionKey(tone, model);
  const packSentinel = `${namCatalogToneId(tone)}:0`;
  return captureKey !== packSentinel
    && (selectedKey === rowKey || selectedKey === captureKey);
}

export function namCatalogModelName(model: NAMCatalogModel, fallback = "NAM Capture"): string {
  return String(model.name ?? model.title ?? fallback).trim() || fallback;
}

function architectureLabel(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "2" || normalized === "a2" || normalized === "v2") return "A2";
  if (normalized === "1" || normalized === "a1" || normalized === "v1") return "A1";
  return normalized ? normalized.toUpperCase() : "NAM";
}

export function namToneCaptureOptions(tone: NAMCatalogTone): NAMToneCaptureOption[] {
  const toneId = namCatalogToneId(tone);
  const seen = new Set<string>();
  const options: NAMToneCaptureOption[] = [];

  for (const model of tone.models ?? []) {
    const modelId = namCatalogModelId(model);
    const downloadUrl = namCatalogModelDownloadUrl(model);
    const identity = modelId > 0 ? `model:${modelId}` : `url:${downloadUrl.toLowerCase()}`;
    if ((!modelId && !downloadUrl) || seen.has(identity)) continue;
    seen.add(identity);
    const captureType = captureTypeForToneModel(tone, model);
    options.push({
      id: namCatalogCaptureSelectionKey(tone, model),
      toneId,
      modelId,
      name: namCatalogModelName(model),
      architecture: architectureLabel(model.architecture_version ?? model.architecture ?? tone.architecture),
      captureType,
      includesCab: captureIncludesCab(captureType),
      downloadable: Boolean(downloadUrl),
      model,
    });
  }

  return options;
}

export function namToneDeclaredCaptureCount(tone: NAMCatalogTone): number {
  const hydratedCount = namToneCaptureOptions(tone).length;
  if (hydratedCount > 0) return hydratedCount;
  const a1Count = Math.max(0, Number(tone.a1_models_count ?? 0) || 0);
  const a2Count = Math.max(0, Number(tone.a2_models_count ?? 0) || 0);
  return a1Count + a2Count;
}

export function namToneRequiresExplicitCapture(tone: NAMCatalogTone): boolean {
  return namToneDeclaredCaptureCount(tone) > 1;
}

export function selectedNAMCatalogIdentity(selectedKey: string): { toneId: number; modelId: number } {
  const [tonePart = "", modelPart = ""] = selectedKey.split(":");
  const toneId = Number.parseInt(tonePart, 10);
  const modelId = Number.parseInt(modelPart, 10);
  return {
    toneId: Number.isFinite(toneId) ? toneId : 0,
    modelId: Number.isFinite(modelId) ? modelId : 0,
  };
}

export function collapseNAMCatalogRowsToTonePacks<TRow extends { tone: NAMCatalogTone }>(rows: TRow[]): TRow[] {
  const seenToneIds = new Set<number>();
  const packs: TRow[] = [];
  for (const row of rows) {
    const toneId = namCatalogToneId(row.tone);
    if (seenToneIds.has(toneId)) continue;
    seenToneIds.add(toneId);
    packs.push(row);
  }
  return packs;
}
