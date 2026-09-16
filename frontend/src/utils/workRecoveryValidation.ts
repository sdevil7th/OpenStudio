import type { WorkRecoveryEntry } from "../services/NativeBridge";

/** Journals survive old builds and interrupted writes. Never render raw fields. */
export function normalizeWorkRecovery(value: unknown): WorkRecoveryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: WorkRecoveryEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 1000)) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !item.id || item.id.length > 256 || seen.has(item.id)
      || (item.kind !== "recording" && item.kind !== "ai")) continue;
    const entry: WorkRecoveryEntry = { id: item.id, kind: item.kind,
      status: typeof item.status === "string" ? item.status.slice(0, 128) : "interrupted" };
    for (const field of ["path", "trackId", "projectId", "projectPath", "projectName", "error", "repairedPath",
      "outputFile", "modelId", "workflowId", "sourceClipId", "sourceIdentity"] as const) {
      if (typeof item[field] === "string" && item[field].length <= 32768) entry[field] = item[field];
    }
    for (const field of ["updatedAt", "startTime", "sampleRate", "channels", "duration", "droppedSamples",
      "ignoredTailBytes", "extensionDuration"] as const) {
      if (typeof item[field] === "number" && Number.isFinite(item[field]) && item[field] >= 0) entry[field] = item[field];
    }
    if (item.params && typeof item.params === "object" && !Array.isArray(item.params)) entry.params = item.params;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}
