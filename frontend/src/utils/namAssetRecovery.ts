import type { BuiltInPluginSchema } from "../services/NativeBridge";

export type NAMRackRecoverableSlot = "amp" | "cab";

export type NAMRackMissingAsset = {
  slot: NAMRackRecoverableSlot;
  slotLabel: string;
  assetLabel: string;
  path: string;
  bypassParamId: "ampEnabled" | "cabEnabled";
  bypassed: boolean;
};

function paramValue(schema: BuiltInPluginSchema, paramId: string, fallback: number) {
  const value = schema.parameters.find((param) => param.id === paramId)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A resource path can remain in a recovered project even when the corresponding
 * DSP resource could not be opened. Keep that distinct from a deliberately
 * empty slot and from a valid resource that is simply bypassed.
 */
export function resolveNAMRackMissingAssets(schema: BuiltInPluginSchema): NAMRackMissingAsset[] {
  const state = schema.modelState;
  if (!state) return [];

  const ampPath = state.ampModelPath?.trim() ?? "";
  const cabPath = state.cabIRPath?.trim() ?? "";
  const missing: NAMRackMissingAsset[] = [];

  if (ampPath && !state.hasAmpModel) {
    missing.push({
      slot: "amp",
      slotLabel: "Amp Capture",
      assetLabel: "NAM amp capture",
      path: ampPath,
      bypassParamId: "ampEnabled",
      bypassed: paramValue(schema, "ampEnabled", 1) < 0.5,
    });
  }

  if (cabPath && !state.hasCabIR && state.cabIRState === "missing") {
    missing.push({
      slot: "cab",
      slotLabel: "Cab / IR",
      assetLabel: "cabinet impulse response",
      path: cabPath,
      bypassParamId: "cabEnabled",
      bypassed: paramValue(schema, "cabEnabled", 0) < 0.5,
    });
  }

  return missing;
}
