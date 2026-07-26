export type NAMHeaderPresetTarget =
  | { kind: "factory"; id: string; name: string }
  | { kind: "user"; name: string };

export type NAMHeaderPresetNavigation = {
  previous?: NAMHeaderPresetTarget;
  next?: NAMHeaderPresetTarget;
};

type FactoryPresetIdentity = {
  id: string;
  name: string;
};

type UserPresetIdentity = {
  name: string;
};

type HeaderPresetNavigationOptions = {
  factoryPresets: readonly FactoryPresetIdentity[];
  userPresets: readonly UserPresetIdentity[];
  activeFactoryId: string;
  activeUserPresetName?: string;
};

function wrappedPair<T>(items: readonly T[], activeIndex: number): { previous?: T; next?: T } {
  if (items.length < 2 || activeIndex < 0 || activeIndex >= items.length) return {};
  return {
    previous: items[(activeIndex - 1 + items.length) % items.length],
    next: items[(activeIndex + 1) % items.length],
  };
}

export function resolveNAMHeaderPresetNavigation(
  options: HeaderPresetNavigationOptions,
): NAMHeaderPresetNavigation {
  const activeUserPresetName = options.activeUserPresetName?.trim() ?? "";
  if (activeUserPresetName) {
    const activeIndex = options.userPresets.findIndex(
      (entry) => entry.name.localeCompare(activeUserPresetName, undefined, { sensitivity: "base" }) === 0,
    );
    const pair = wrappedPair(options.userPresets, activeIndex);
    return {
      previous: pair.previous ? { kind: "user", name: pair.previous.name } : undefined,
      next: pair.next ? { kind: "user", name: pair.next.name } : undefined,
    };
  }

  const activeIndex = options.factoryPresets.findIndex((entry) => entry.id === options.activeFactoryId);
  const pair = wrappedPair(options.factoryPresets, activeIndex >= 0 ? activeIndex : 0);
  return {
    previous: pair.previous
      ? { kind: "factory", id: pair.previous.id, name: pair.previous.name }
      : undefined,
    next: pair.next
      ? { kind: "factory", id: pair.next.id, name: pair.next.name }
      : undefined,
  };
}

export function buildNAMModulePresetCommitValues(
  targetValues: Record<string, number>,
  activePreview?: { applied?: boolean; previousValues: Record<string, number> } | null,
): Record<string, number> {
  return activePreview?.applied
    ? { ...activePreview.previousValues, ...targetValues }
    : { ...targetValues };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numericValues(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(asRecord(value))) {
    const number = Number(rawValue);
    if (Number.isFinite(number)) result[key] = number;
  }
  return result;
}

function resourceRestoreState(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const result: Record<string, unknown> = {};
  const resources = [
    ["pedalModelPath", "clearPedalModel"],
    ["ampModelPath", "clearAmpModel"],
    ["cabIRPath", "clearCabIR"],
  ] as const;

  for (const [pathKey, clearKey] of resources) {
    const path = typeof source[pathKey] === "string" ? source[pathKey].trim() : "";
    if (path) result[pathKey] = path;
    else result[clearKey] = true;
  }
  if (result.pedalModelPath && typeof source.pedalDeclaredCaptureType === "string") {
    result.pedalDeclaredCaptureType = source.pedalDeclaredCaptureType.trim() || "unknown";
  }
  if (result.ampModelPath && typeof source.ampDeclaredCaptureType === "string") {
    result.ampDeclaredCaptureType = source.ampDeclaredCaptureType.trim() || "unknown";
  }
  if (typeof source.cabRequestedEnabled === "boolean") {
    result.cabRequestedEnabled = source.cabRequestedEnabled;
  }
  return result;
}

export type NAMRackRollbackPatch = {
  values: Record<string, number>;
  modelState: Record<string, unknown>;
  uiState: Record<string, unknown>;
};

export function buildNAMRackRollbackPatch(state: unknown): NAMRackRollbackPatch | null {
  const source = asRecord(state);
  if (Object.keys(source).length === 0) return null;
  return {
    values: numericValues(source.values),
    modelState: resourceRestoreState(source.modelState),
    uiState: { ...asRecord(source.uiState) },
  };
}
