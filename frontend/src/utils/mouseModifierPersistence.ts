import {
  canonicalizeMouseModifierCombination,
  isMouseModifierActionForContext,
  isMouseModifierContext,
} from "./mouseModifierResolver";

export const MOUSE_MODIFIER_OVERRIDES_SCHEMA_VERSION = 1;
export const MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY = "openstudio.mouseModifierOverrides.v1";

export type StoredMouseModifierOverrides = Record<string, Record<string, string>>;

interface PersistedMouseModifierOverrides {
  schemaVersion: typeof MOUSE_MODIFIER_OVERRIDES_SCHEMA_VERSION;
  overrides: StoredMouseModifierOverrides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and canonicalize untrusted per-context overrides. Unknown contexts,
 * combinations, and actions reject the whole payload instead of becoming
 * latent bindings that a future release might interpret differently.
 */
export function normalizeMouseModifierOverrides(
  value: unknown,
): StoredMouseModifierOverrides | null {
  if (!isRecord(value)) return null;
  const result: StoredMouseModifierOverrides = {};

  for (const rawContext of Object.keys(value)) {
    if (!isMouseModifierContext(rawContext)) return null;
    const rawMappings = value[rawContext];
    if (!isRecord(rawMappings)) return null;
    const mappings: Record<string, string> = {};

    for (const rawCombination of Object.keys(rawMappings).sort()) {
      const combination = canonicalizeMouseModifierCombination(rawCombination);
      const action = rawMappings[rawCombination];
      if (!combination || !isMouseModifierActionForContext(rawContext, action)) return null;
      if (Object.prototype.hasOwnProperty.call(mappings, combination)) return null;
      mappings[combination] = action;
    }

    if (Object.keys(mappings).length > 0) result[rawContext] = mappings;
  }

  return result;
}

export function parsePersistedMouseModifierOverrides(
  value: unknown,
): PersistedMouseModifierOverrides | null {
  if (!isRecord(value)
    || value.schemaVersion !== MOUSE_MODIFIER_OVERRIDES_SCHEMA_VERSION) {
    return null;
  }
  const overrides = normalizeMouseModifierOverrides(value.overrides);
  return overrides ? { schemaVersion: MOUSE_MODIFIER_OVERRIDES_SCHEMA_VERSION, overrides } : null;
}

export function loadStoredMouseModifierOverrides(
  storage: Pick<Storage, "getItem"> | undefined = (
    typeof localStorage !== "undefined" ? localStorage : undefined
  ),
): StoredMouseModifierOverrides {
  try {
    const raw = storage?.getItem(MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    return parsePersistedMouseModifierOverrides(JSON.parse(raw))?.overrides ?? {};
  } catch {
    return {};
  }
}

export function persistMouseModifierOverrides(
  value: unknown,
  storage: Pick<Storage, "setItem"> | undefined = (
    typeof localStorage !== "undefined" ? localStorage : undefined
  ),
): boolean {
  const overrides = normalizeMouseModifierOverrides(value);
  if (!overrides || !storage) return false;
  try {
    storage.setItem(MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY, JSON.stringify({
      schemaVersion: MOUSE_MODIFIER_OVERRIDES_SCHEMA_VERSION,
      overrides,
    } satisfies PersistedMouseModifierOverrides));
    return true;
  } catch {
    return false;
  }
}

export function withMouseModifierOverride(
  current: unknown,
  context: string,
  modifiers: string,
  action: string,
): StoredMouseModifierOverrides | null {
  if (!isMouseModifierContext(context)) return null;
  const combination = canonicalizeMouseModifierCombination(modifiers);
  if (!combination || !isMouseModifierActionForContext(context, action)) return null;
  const normalized = normalizeMouseModifierOverrides(current);
  if (!normalized) return null;
  return {
    ...normalized,
    [context]: {
      ...normalized[context],
      [combination]: action,
    },
  };
}
