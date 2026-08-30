import { getShortcutPlatform, type ShortcutPlatform } from "./platform";

type RackMutationPatch = {
  values?: Record<string, number>;
  modelState?: Record<string, unknown>;
};

export type VerifiedNAMRackMutationResult = "verified" | "rejected" | "unverified";

export interface NAMRackMutationBridge {
  setBuiltInPluginState(address: unknown, patch: RackMutationPatch): Promise<boolean>;
  getBuiltInPluginState(address: unknown): Promise<unknown>;
}

const normalizedPath = (value: unknown, platform: ShortcutPlatform) => {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/");
  return platform === "windows" ? normalized.toLowerCase() : normalized;
};

export function doesNAMRackMutationMatchReadback(
  state: unknown,
  patch: RackMutationPatch,
  platform: ShortcutPlatform = getShortcutPlatform(),
): boolean {
  if (!state || typeof state !== "object") return false;
  const stateRecord = state as Record<string, unknown>;
  const values = stateRecord.values && typeof stateRecord.values === "object"
    ? stateRecord.values as Record<string, unknown>
    : {};
  const modelState = stateRecord.modelState && typeof stateRecord.modelState === "object"
    ? stateRecord.modelState as Record<string, unknown>
    : {};

  for (const [id, expected] of Object.entries(patch.values ?? {})) {
    const actual = Number(values[id]);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) >= 0.01) return false;
  }

  const clearChecks = [
    ["clearPedalModel", "pedalModelPath", "hasPedalModel"],
    ["clearAmpModel", "ampModelPath", "hasAmpModel"],
    ["clearCabIR", "cabIRPath", "hasCabIR"],
  ] as const;
  for (const [clearKey, pathKey, presentKey] of clearChecks) {
    if (patch.modelState?.[clearKey] !== true) continue;
    if (normalizedPath(modelState[pathKey], platform) || Boolean(modelState[presentKey])) return false;
  }

  for (const [id, expected] of Object.entries(patch.modelState ?? {})) {
    if (id.startsWith("clear")) continue;
    const actual = modelState[id];
    if (id.endsWith("Path")) {
      if (normalizedPath(actual, platform) !== normalizedPath(expected, platform)) return false;
    } else if (typeof expected === "number") {
      if (!Number.isFinite(Number(actual)) || Math.abs(Number(actual) - expected) >= 0.0001) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

export async function applyVerifiedNAMRackMutation(
  bridge: NAMRackMutationBridge,
  address: unknown,
  patch: RackMutationPatch,
): Promise<VerifiedNAMRackMutationResult> {
  const accepted = await bridge.setBuiltInPluginState(address, patch);
  if (!accepted) return "rejected";
  const readback = await bridge.getBuiltInPluginState(address);
  return doesNAMRackMutationMatchReadback(readback, patch) ? "verified" : "unverified";
}
