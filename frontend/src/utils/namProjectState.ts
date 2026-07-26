import { normalizeNAMCaptureType } from "./namCaptureType";

export type NAMProjectAssetSlot = "pedal" | "amp" | "cab";

export interface NAMProjectAssetReference {
  slot: NAMProjectAssetSlot;
  path: string;
  compareSlot?: "A" | "B";
  compareSnapshot?: boolean;
  [key: string]: unknown;
}

export type NAMProjectStateIssuePhase = "remove" | "add" | "restore";

export interface NAMProjectStateIssue {
  phase: NAMProjectStateIssuePhase;
  location: string;
  detail: string;
}

const NAM_PROJECT_ASSET_SLOTS = [
  {
    slot: "pedal" as const,
    pathKey: "pedalModelPath",
    declaredTypeKey: "pedalDeclaredCaptureType",
    effectiveTypeKey: "pedalCaptureType",
  },
  {
    slot: "amp" as const,
    pathKey: "ampModelPath",
    declaredTypeKey: "ampDeclaredCaptureType",
    effectiveTypeKey: "ampCaptureType",
  },
  { slot: "cab" as const, pathKey: "cabIRPath" },
];

export function collectNAMProjectAssetReferences(
  state: unknown,
  baseTarget: Record<string, unknown>,
): NAMProjectAssetReference[] {
  const stateRecord = state && typeof state === "object"
    ? state as Record<string, any>
    : {};
  const modelState = stateRecord.modelState && typeof stateRecord.modelState === "object"
    ? stateRecord.modelState as Record<string, unknown>
    : {};
  const assets: NAMProjectAssetReference[] = [];

  const addAsset = (
    slot: typeof NAM_PROJECT_ASSET_SLOTS[number],
    modelStateRecord: Record<string, unknown>,
    extra: Partial<NAMProjectAssetReference> = {},
  ) => {
    const path = String(modelStateRecord[slot.pathKey] || "").trim();
    if (!path) return;
    const declaredTypeKey = "declaredTypeKey" in slot ? slot.declaredTypeKey : "";
    const effectiveTypeKey = "effectiveTypeKey" in slot ? slot.effectiveTypeKey : "";
    const effectiveCaptureType = normalizeNAMCaptureType(
      effectiveTypeKey ? modelStateRecord[effectiveTypeKey] : "",
    );
    const declaredCaptureType = normalizeNAMCaptureType(
      declaredTypeKey ? modelStateRecord[declaredTypeKey] : "",
    );
    const captureType = effectiveCaptureType !== "unknown"
      ? effectiveCaptureType
      : declaredCaptureType;
    assets.push({
      ...baseTarget,
      slot: slot.slot,
      path,
      ...(captureType !== "unknown" ? { captureType, gearType: captureType } : {}),
      ...extra,
    });
  };

  for (const slot of NAM_PROJECT_ASSET_SLOTS) {
    addAsset(slot, modelState);
  }

  const snapshots = stateRecord.uiState?.namRackCompare?.snapshots;
  for (const compareSlot of ["A", "B"] as const) {
    const snapshotModelState = snapshots?.[compareSlot]?.modelState;
    if (!snapshotModelState || typeof snapshotModelState !== "object") continue;
    for (const slot of NAM_PROJECT_ASSET_SLOTS) {
      addAsset(slot, snapshotModelState, {
        compareSlot,
        compareSnapshot: true,
      });
    }
  }

  return assets;
}

export function summarizeNAMProjectStateIssues(
  issues: NAMProjectStateIssue[],
): string {
  if (issues.length === 0) return "";

  const countLabel = `${issues.length} NAM Rack project-state issue${issues.length === 1 ? "" : "s"}`;
  const details = issues
    .slice(0, 3)
    .map((issue) => `${issue.location}: ${issue.detail}`)
    .join("; ");
  const remainder = issues.length > 3 ? `; plus ${issues.length - 3} more` : "";
  return `Project loaded with ${countLabel}. ${details}${remainder}`;
}
