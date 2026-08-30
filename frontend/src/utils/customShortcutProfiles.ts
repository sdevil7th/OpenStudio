import {
  normalizeShortcutBinding,
  normalizeShortcutBindings,
  shortcutBindingEventSignature,
  type ShortcutPlatform,
} from "./platform";
import {
  isKeyboardShortcutProfileId,
  type KeyboardShortcutProfileId,
} from "./shortcutProfiles";

export const CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION = 2 as const;
export const CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY = "openstudio.keyboardProfiles.v2";
export const LEGACY_CUSTOM_SHORTCUTS_STORAGE_KEY = "s13_customShortcuts";

export const CUSTOM_SHORTCUT_TARGETS = [
  "common",
  "macos",
  "windows",
  "linux",
  "other",
] as const;

export type CustomShortcutTarget = typeof CUSTOM_SHORTCUT_TARGETS[number];

/**
 * Every present property owns the complete binding list for that target.
 * An empty list is therefore an intentional unbind, while a missing property
 * falls through to `common`, then the selected built-in profile/factory map.
 */
export type CustomShortcutPlatformBindings = Partial<
  Record<CustomShortcutTarget, readonly string[]>
>;

/** String/array variants are accepted so old state snapshots and tests remain readable. */
export type CustomShortcutBindingValue =
  | string
  | readonly string[]
  | CustomShortcutPlatformBindings;

export type CustomShortcutMap = Record<string, CustomShortcutBindingValue>;

export interface CustomKeyboardShortcutProfile {
  id: string;
  name: string;
  baseProfileId: KeyboardShortcutProfileId;
  bindings: CustomShortcutMap;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedCustomKeyboardProfiles {
  schemaVersion: typeof CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION;
  activeProfileId: string | null;
  profiles: readonly CustomKeyboardShortcutProfile[];
}

export interface ImportedCustomKeyboardProfileEnvelope {
  schemaVersion: typeof CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION;
  type: "openstudio-keyboard-profile";
  profile: CustomKeyboardShortcutProfile;
}

export type CustomKeyboardProfileImportResult =
  | { success: true; profile: CustomKeyboardShortcutProfile }
  | { success: false; error: string };

const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_CUSTOM_KEYBOARD_PROFILES = 100;
export const MAX_CUSTOM_SHORTCUT_ACTIONS_PER_PROFILE = 1000;
export const MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET = 12;
const MAX_BINDING_LENGTH = 128;
const MAX_IMPORT_BYTES = 1_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function createCustomKeyboardProfileId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return `custom-${randomUUID()}`;
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeCustomProfileName(value: unknown, fallback = "Custom Shortcuts"): string {
  if (typeof value !== "string") return fallback;
  const name = value.trim().replace(/\s+/g, " ").slice(0, MAX_PROFILE_NAME_LENGTH);
  return name || fallback;
}

function normalizeBindingList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET) return null;
  if (value.some((binding) => typeof binding !== "string" || binding.length > MAX_BINDING_LENGTH)) {
    return null;
  }
  const normalizedValues = value.map((binding) => normalizeShortcutBinding(binding));
  if (normalizedValues.some((binding) => binding === null)) return null;
  const normalized = [...new Set(normalizedValues as string[])];
  for (const binding of normalized) {
    const reachable = (["macos", "windows", "linux", "other"] as const)
      .some((platform) => shortcutBindingEventSignature(binding, platform) !== null);
    if (!reachable) return null;
  }
  return normalized;
}

export function normalizeCustomShortcutValue(
  value: unknown,
): CustomShortcutPlatformBindings | null {
  if (typeof value === "string") {
    if (value === "") return { common: [] };
    const list = normalizeBindingList([value]);
    return list ? { common: list } : null;
  }
  if (Array.isArray(value)) {
    const list = normalizeBindingList(value);
    return list ? { common: list } : null;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !(CUSTOM_SHORTCUT_TARGETS as readonly string[]).includes(key))) {
    return null;
  }
  const normalized: CustomShortcutPlatformBindings = {};
  for (const target of CUSTOM_SHORTCUT_TARGETS) {
    if (!hasOwn(value, target)) continue;
    const list = normalizeBindingList(value[target]);
    if (!list) return null;
    normalized[target] = list;
  }
  return normalized;
}

export function normalizeCustomShortcutMap(
  value: unknown,
  knownActionIds?: ReadonlySet<string>,
): CustomShortcutMap | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_SHORTCUT_ACTIONS_PER_PROFILE) return null;
  const normalized: CustomShortcutMap = {};
  for (const [actionId, binding] of entries) {
    if (!ACTION_ID_PATTERN.test(actionId)) return null;
    if (knownActionIds && !knownActionIds.has(actionId)) return null;
    const normalizedBinding = normalizeCustomShortcutValue(binding);
    if (!normalizedBinding) return null;
    normalized[actionId] = normalizedBinding;
  }
  return normalized;
}

export function getCustomShortcutTargetBindings(
  value: CustomShortcutBindingValue | undefined,
  target: CustomShortcutTarget,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" || Array.isArray(value)) {
    return target === "common" ? normalizeShortcutBindings(value) : undefined;
  }
  const platformBindings = value as CustomShortcutPlatformBindings;
  return hasOwn(platformBindings, target)
    ? normalizeShortcutBindings(platformBindings[target])
    : undefined;
}

export function resolveCustomShortcutBindings(
  customShortcuts: CustomShortcutMap,
  actionId: string,
  platform: ShortcutPlatform,
): readonly string[] | undefined {
  const value = customShortcuts[actionId];
  if (value === undefined) return undefined;
  if (typeof value === "string" || Array.isArray(value)) {
    return normalizeShortcutBindings(value);
  }
  const platformBindings = value as CustomShortcutPlatformBindings;
  if (hasOwn(platformBindings, platform)) {
    return normalizeShortcutBindings(platformBindings[platform]);
  }
  if (hasOwn(platformBindings, "common")) {
    return normalizeShortcutBindings(platformBindings.common);
  }
  return undefined;
}

export function hasCustomShortcutOverride(
  customShortcuts: CustomShortcutMap,
  actionId: string,
  platform?: ShortcutPlatform,
): boolean {
  if (!hasOwn(customShortcuts, actionId)) return false;
  return platform === undefined
    || resolveCustomShortcutBindings(customShortcuts, actionId, platform) !== undefined;
}

export function setCustomShortcutTargetBindings(
  customShortcuts: CustomShortcutMap,
  actionId: string,
  target: CustomShortcutTarget,
  bindings: readonly string[],
): CustomShortcutMap {
  const current = normalizeCustomShortcutValue(customShortcuts[actionId]) ?? {};
  return {
    ...customShortcuts,
    [actionId]: {
      ...current,
      [target]: normalizeShortcutBindings(bindings),
    },
  };
}

export function removeCustomShortcutTarget(
  customShortcuts: CustomShortcutMap,
  actionId: string,
  target?: CustomShortcutTarget,
): CustomShortcutMap {
  if (!hasOwn(customShortcuts, actionId)) return customShortcuts;
  const updated = { ...customShortcuts };
  if (!target) {
    delete updated[actionId];
    return updated;
  }
  const current = normalizeCustomShortcutValue(updated[actionId]);
  if (!current) {
    delete updated[actionId];
    return updated;
  }
  const next = { ...current };
  delete next[target];
  if (Object.keys(next).length === 0) delete updated[actionId];
  else updated[actionId] = next;
  return updated;
}

function normalizeProfile(
  value: unknown,
  knownActionIds?: ReadonlySet<string>,
): CustomKeyboardShortcutProfile | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !PROFILE_ID_PATTERN.test(value.id)) return null;
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > MAX_PROFILE_NAME_LENGTH) return null;
  if (!isKeyboardShortcutProfileId(value.baseProfileId)) return null;
  const bindings = normalizeCustomShortcutMap(value.bindings, knownActionIds);
  if (!bindings) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    ? value.createdAt
    : Date.now();
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
    ? value.updatedAt
    : createdAt;
  return {
    id: value.id,
    name: normalizeCustomProfileName(value.name),
    baseProfileId: value.baseProfileId,
    bindings,
    createdAt,
    updatedAt,
  };
}

export function parsePersistedCustomKeyboardProfiles(
  raw: unknown,
): PersistedCustomKeyboardProfiles | null {
  if (!isPlainObject(raw)
    || raw.schemaVersion !== CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION
    || !Array.isArray(raw.profiles)
    || raw.profiles.length > MAX_CUSTOM_KEYBOARD_PROFILES) {
    return null;
  }
  const profiles: CustomKeyboardShortcutProfile[] = [];
  const ids = new Set<string>();
  for (const value of raw.profiles) {
    const profile = normalizeProfile(value);
    if (!profile || ids.has(profile.id)) return null;
    ids.add(profile.id);
    profiles.push(profile);
  }
  const activeProfileId = typeof raw.activeProfileId === "string" && ids.has(raw.activeProfileId)
    ? raw.activeProfileId
    : null;
  return {
    schemaVersion: CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
    activeProfileId,
    profiles,
  };
}

export function migrateLegacyCustomShortcuts(
  legacy: unknown,
  baseProfileId: KeyboardShortcutProfileId,
  now = Date.now(),
): PersistedCustomKeyboardProfiles {
  const bindings: CustomShortcutMap = {};
  if (isPlainObject(legacy)) {
    for (const [actionId, value] of Object.entries(legacy).slice(0, MAX_CUSTOM_SHORTCUT_ACTIONS_PER_PROFILE)) {
      if (!ACTION_ID_PATTERN.test(actionId)) continue;
      const normalized = normalizeCustomShortcutValue(value);
      if (normalized) bindings[actionId] = normalized;
    }
  }
  if (Object.keys(bindings).length === 0) {
    return {
      schemaVersion: CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
      activeProfileId: null,
      profiles: [],
    };
  }
  const profile: CustomKeyboardShortcutProfile = {
    id: "custom-migrated-shortcuts",
    name: "My Shortcuts",
    baseProfileId,
    bindings,
    createdAt: now,
    updatedAt: now,
  };
  return {
    schemaVersion: CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
    activeProfileId: profile.id,
    profiles: [profile],
  };
}

export function exportCustomKeyboardProfile(
  profile: CustomKeyboardShortcutProfile,
): string {
  const normalized = normalizeProfile(profile);
  if (!normalized) throw new Error("Cannot export an invalid keyboard profile.");
  return JSON.stringify({
    schemaVersion: CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
    type: "openstudio-keyboard-profile",
    profile: normalized,
  } satisfies ImportedCustomKeyboardProfileEnvelope, null, 2);
}

export function parseImportedCustomKeyboardProfile(
  serialized: string,
  knownActionIds?: ReadonlySet<string>,
): CustomKeyboardProfileImportResult {
  if (typeof serialized !== "string" || serialized.length === 0) {
    return { success: false, error: "The selected file is empty." };
  }
  if (serialized.length > MAX_IMPORT_BYTES) {
    return { success: false, error: "The selected profile is larger than 1 MB." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return { success: false, error: "The selected file is not valid JSON." };
  }
  if (!isPlainObject(raw)
    || raw.schemaVersion !== CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION
    || raw.type !== "openstudio-keyboard-profile") {
    return { success: false, error: "This is not an OpenStudio keyboard profile version 2 file." };
  }
  const profile = normalizeProfile(raw.profile, knownActionIds);
  if (!profile) {
    return { success: false, error: "The profile contains an invalid name, base profile, action, or shortcut." };
  }
  return {
    success: true,
    profile: {
      ...profile,
      id: createCustomKeyboardProfileId(),
      name: normalizeCustomProfileName(profile.name),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}
