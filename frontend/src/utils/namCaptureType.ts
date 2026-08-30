import type { NAMCatalogModel, NAMCatalogTone, NAMInstalledModel } from "../services/NativeBridge";

export type NAMCaptureType =
  | "amp"
  | "pedal"
  | "pedal_amp"
  | "amp_cab"
  | "amp_pedal_cab"
  | "preamp"
  | "studio"
  | "full_rig"
  | "unknown";

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "name" in value) {
    return typeof (value as { name?: unknown }).name === "string"
      ? String((value as { name?: unknown }).name).trim()
      : "";
  }
  return "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeNAMCaptureType(value: unknown): NAMCaptureType {
  const label = text(value).toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
  if (label === "amp" || label === "pedal" || label === "pedal_amp"
    || label === "amp_cab" || label === "amp_pedal_cab"
    || label === "preamp" || label === "studio") return label;
  if (label === "full_rig" || label === "fullrig" || label === "rig") return "full_rig";
  if (/\bfull[_ ]?rig\b/.test(label)) return "full_rig";
  return "unknown";
}

function firstCaptureType(...values: unknown[]): NAMCaptureType {
  for (const value of values) {
    const captureType = normalizeNAMCaptureType(value);
    if (captureType !== "unknown") return captureType;
  }
  return "unknown";
}

function captureTypeFromModelLabel(...values: unknown[]): NAMCaptureType {
  const label = values.map(text).filter(Boolean).join(" ").toLowerCase();
  if (!label) return "unknown";
  if (/\b(?:amp[ _-]?cab|cab(?:inet)? embedded|with cab|ir included|full[ _-]?rig)\b/.test(label)) {
    return /\bfull[ _-]?rig\b/.test(label) ? "full_rig" : "amp_cab";
  }
  if (/\b(?:ir|raw\s*\+\s*ir)\b/.test(label)) return "amp_cab";
  if (/\braw\b/.test(label)) return "amp";
  return "unknown";
}

export function captureTypeForToneModel(tone: NAMCatalogTone, model: NAMCatalogModel): NAMCaptureType {
  const modelMetadata = record(model.metadata);
  const toneMetadata = record(tone.metadata);
  const modelExplicit = firstCaptureType(
    modelMetadata.gear_type,
    modelMetadata.gearType,
    model.captureType,
    model.gear_type,
    model.gearType,
    model.gear,
  );
  if (modelExplicit !== "unknown") return modelExplicit;

  // A pack may contain both RAW and cab-embedded child captures while the
  // parent tone is broadly labelled "amp". Child naming is therefore more
  // specific than pack-level metadata, but never overrides child metadata.
  const modelLabelType = captureTypeFromModelLabel(model.name, model.title);
  if (modelLabelType !== "unknown") return modelLabelType;

  const toneExplicit = firstCaptureType(
    toneMetadata.gear_type,
    toneMetadata.gearType,
    tone.captureType,
    tone.gearType,
    tone.gear,
  );
  if (toneExplicit !== "unknown") return toneExplicit;
  return firstCaptureType(tone.title, tone.name, tone.description);
}

export function captureTypeForInstalled(model: NAMInstalledModel): NAMCaptureType {
  const localMetadata = record(model.namMetadata);
  const lastSeen = record(model.lastSeenMetadata);
  const lastSeenMetadata = record(lastSeen.metadata);
  const latest = record(model.latestMetadata);
  const latestMetadata = record(latest.metadata);
  return firstCaptureType(
    localMetadata.gear_type,
    localMetadata.gearType,
    model.captureType,
    model.gear_type,
    model.gearType,
    model.gear,
    lastSeenMetadata.gear_type,
    lastSeenMetadata.gearType,
    lastSeen.gear_type,
    lastSeen.gearType,
    lastSeen.gear,
    latestMetadata.gear_type,
    latestMetadata.gearType,
    latest.gear_type,
    latest.gearType,
    latest.gear,
    model.name,
    model.toneTitle,
  );
}

export function captureIncludesCab(captureType: NAMCaptureType): boolean {
  return captureType === "amp_cab" || captureType === "amp_pedal_cab" || captureType === "full_rig";
}

export function targetSlotForCapture(captureType: NAMCaptureType): "pedal" | "amp" {
  return captureType === "pedal" ? "pedal" : "amp";
}
