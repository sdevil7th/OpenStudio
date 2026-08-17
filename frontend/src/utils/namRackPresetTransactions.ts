import {
  NAM_RETIRED_AUDITION_STATE_KEYS,
  NAM_RETIRED_COMPRESSOR_STATE_KEYS,
  NAM_RETIRED_INPUT_ROUTING_STATE_KEYS,
  NAM_RETIRED_LASER_STATE_KEYS,
  NAM_RETIRED_PRECISION_DRIVE_STATE_KEYS,
  NAM_RETIRED_REVERB_V2_STATE_KEYS,
  pruneRetiredNAMRackInputRoutingState,
  sanitizeNAMRackDspState,
} from "./namPortableState";
import { normalizeNAMInstrumentProfile } from "./namInstrumentProfile";

export type NAMHeaderPresetTarget =
  | { kind: "factory"; id: string; name: string }
  | { kind: "user"; name: string };

export type NAMModelQualityOption = {
  value: number;
  label: string;
};

export type NAMHeaderPresetNavigation = {
  previous?: NAMHeaderPresetTarget;
  next?: NAMHeaderPresetTarget;
};

export type NAMHeaderPresetArrowResult = "loaded" | "load-failed" | "library-opened";

/**
 * Shared click contract for every visual NAM Rack header. A missing target is
 * an intentional library-entry action, never a silent no-op.
 */
export async function runNAMHeaderPresetArrowAction(
  target: NAMHeaderPresetTarget | undefined,
  handlers: {
    loadTarget: (target: NAMHeaderPresetTarget) => Promise<boolean>;
    openLibrary: () => void;
  },
): Promise<NAMHeaderPresetArrowResult> {
  if (!target) {
    handlers.openLibrary();
    return "library-opened";
  }
  return await handlers.loadTarget(target) ? "loaded" : "load-failed";
}

export function shouldClearNAMPresetIdentityForUnsavedAmpTransition(options: {
  previouslyHadAmpModel: boolean;
  hasAmpModel: boolean;
  schemaActiveUserPresetName?: string;
  schemaActiveFactoryPresetId?: string;
}): boolean {
  return !options.previouslyHadAmpModel
    && options.hasAmpModel
    && !options.schemaActiveUserPresetName?.trim()
    && !options.schemaActiveFactoryPresetId?.trim();
}

export type NAMUserPresetLibraryMetadata = {
  favorite?: boolean;
  folder?: string;
  tags?: readonly string[];
  notes?: string;
  lastUsed?: number;
};

export type NAMUserPresetFilterCounts = {
  all: number;
  favorites: number;
  recent: number;
};

export type NAMUserPresetEmptyState = {
  message: string;
  showAll: boolean;
};

export const NAM_UNFILED_PRESET_COLLECTION_ID = "unfiled";
const NAM_RESERVED_PRESET_COLLECTION_NAMES = new Set([
  "all",
  "favorites",
  "recent",
  NAM_UNFILED_PRESET_COLLECTION_ID,
]);

export function isNAMReservedPresetCollectionName(value: unknown): boolean {
  return NAM_RESERVED_PRESET_COLLECTION_NAMES.has(String(value ?? "").trim().toLocaleLowerCase());
}

export function normalizeNAMUserPresetFolder(value: unknown): string {
  const folder = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 42);
  return isNAMReservedPresetCollectionName(folder) ? "" : folder;
}

export type NAMPresetSessionCache<T> = {
  peek: (now?: number) => T | undefined;
  load: (
    loader: () => Promise<T>,
    options?: { force?: boolean; now?: number },
  ) => Promise<T>;
  invalidate: () => void;
};

export class NAMPresetSessionInvalidatedError extends Error {
  constructor() {
    super("Preset discovery result was invalidated by a newer library mutation");
    this.name = "NAMPresetSessionInvalidatedError";
  }
}

export async function drainNAMPresetWriteQueue(
  waitForUiStateWrites: () => Promise<unknown>,
  flushParameterWrites: () => Promise<boolean>,
): Promise<boolean> {
  try {
    await waitForUiStateWrites();
    return await flushParameterWrites();
  } catch {
    return false;
  }
}

/**
 * Keeps local preset discovery cheap for the current renderer session without
 * writing the discovered file list to persistent storage. Invalidating bumps a
 * generation so a request that started before a preset mutation cannot publish
 * stale results over the forced post-mutation refresh.
 */
export function createNAMPresetSessionCache<T>(ttlMs: number): NAMPresetSessionCache<T> {
  const safeTtlMs = Math.max(0, ttlMs);
  let generation = 0;
  let cached: { value: T; loadedAt: number } | undefined;
  let inFlight: { generation: number; promise: Promise<T> } | undefined;

  const peek = (now = Date.now()): T | undefined => {
    if (!cached) return undefined;
    const ageMs = now - cached.loadedAt;
    return ageMs >= 0 && ageMs < safeTtlMs ? cached.value : undefined;
  };

  const load = (
    loader: () => Promise<T>,
    options: { force?: boolean; now?: number } = {},
  ): Promise<T> => {
    const now = options.now ?? Date.now();
    if (!options.force) {
      const fresh = peek(now);
      if (fresh !== undefined) return Promise.resolve(fresh);
    }
    if (inFlight?.generation === generation) return inFlight.promise;

    const requestGeneration = generation;
    let request: Promise<T>;
    request = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (generation !== requestGeneration) throw new NAMPresetSessionInvalidatedError();
        cached = { value, loadedAt: now };
        return value;
      })
      .finally(() => {
        if (inFlight?.promise === request) inFlight = undefined;
      });
    inFlight = { generation: requestGeneration, promise: request };
    return request;
  };

  return {
    peek,
    load,
    invalidate: () => {
      generation += 1;
      cached = undefined;
    },
  };
}

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
  /**
   * Allows an unsaved/new rack to enter preset navigation without pretending
   * that one of the factory templates is already active. Saved user presets
   * are preferred because they carry the complete rack resources; factory
   * templates are only the fallback and may still be rejected by the caller
   * when the rack has no Amp Capture.
   */
  allowInactiveEntry?: boolean;
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
  if (activeIndex < 0) {
    if (!options.allowInactiveEntry) return {};
    if (options.userPresets.length > 0) {
      const first = options.userPresets[0];
      const last = options.userPresets[options.userPresets.length - 1];
      return {
        previous: last ? { kind: "user", name: last.name } : undefined,
        next: first ? { kind: "user", name: first.name } : undefined,
      };
    }
    const first = options.factoryPresets[0];
    const last = options.factoryPresets[options.factoryPresets.length - 1];
    return {
      previous: last ? { kind: "factory", id: last.id, name: last.name } : undefined,
      next: first ? { kind: "factory", id: first.id, name: first.name } : undefined,
    };
  }
  const pair = wrappedPair(options.factoryPresets, activeIndex);
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

export type NAMRackCompareReadbackTarget = {
  values: Readonly<Record<string, number>>;
  modelState?: Readonly<Record<string, unknown>>;
  dspState?: Readonly<Record<string, unknown>>;
  postFxOrder?: readonly string[];
};

/**
 * Verifies only state explicitly carried by a Compare snapshot. Legacy
 * snapshots can omit hidden DSP selectors or resource intent; omitted fields
 * must remain neutral instead of being inferred from the current schema.
 */
export function verifyNAMRackCompareReadback(
  target: NAMRackCompareReadbackTarget,
  readback: unknown,
  actualPostFxOrder?: readonly string[],
): boolean {
  const state = asRecord(readback);
  const actualValues = asRecord(state.values);
  for (const [id, expected] of Object.entries(target.values)) {
    const actual = actualValues[id];
    if (
      typeof actual !== "number"
      || !Number.isFinite(actual)
      || Math.abs(actual - expected) > 0.0001
    ) {
      return false;
    }
  }

  const expectedModel = asRecord(target.modelState);
  const actualModel = asRecord(state.modelState);
  for (const [pathKey, clearKey] of [
    ["pedalModelPath", "clearPedalModel"],
    ["ampModelPath", "clearAmpModel"],
    ["cabIRPath", "clearCabIR"],
  ] as const) {
    const expectedPath = typeof expectedModel[pathKey] === "string"
      ? expectedModel[pathKey].trim()
      : "";
    const actualPath = typeof actualModel[pathKey] === "string"
      ? actualModel[pathKey].trim()
      : "";
    if (expectedPath) {
      if (actualPath !== expectedPath) return false;
    } else if (expectedModel[clearKey] === true && actualPath) {
      return false;
    }
  }

  for (const key of ["pedalDeclaredCaptureType", "ampDeclaredCaptureType"] as const) {
    const expected = expectedModel[key];
    if (typeof expected === "string" && expected.trim()) {
      if (String(actualModel[key] ?? "").trim() !== expected.trim()) return false;
    }
  }
  for (const key of ["pedalModelSize", "ampModelSize"] as const) {
    const expected = expectedModel[key];
    if (typeof expected !== "number" || !Number.isFinite(expected)) continue;
    const actual = actualModel[key];
    if (
      typeof actual !== "number"
      || !Number.isFinite(actual)
      || Math.abs(actual - expected) > 0.0001
    ) {
      return false;
    }
  }
  if (
    typeof expectedModel.cabRequestedEnabled === "boolean"
    && actualModel.cabRequestedEnabled !== expectedModel.cabRequestedEnabled
  ) {
    return false;
  }

  if (target.dspState) {
    const expectedDsp = sanitizeNAMRackDspState(target.dspState);
    const actualDsp = sanitizeNAMRackDspState(state.dspState);
    for (const [key, expected] of Object.entries(expectedDsp)) {
      if (actualDsp[key] !== expected) return false;
    }
  }

  if (target.postFxOrder) {
    if (!actualPostFxOrder || target.postFxOrder.length !== actualPostFxOrder.length) return false;
    if (target.postFxOrder.some((moduleId, index) => moduleId !== actualPostFxOrder[index])) return false;
  }
  return true;
}

function normalizedNAMModelSize(value: unknown, fallback = 1): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function normalizedNAMModelSizeBreakpoints(value: readonly number[] | undefined): number[] {
  const sorted = (value ?? [])
    .filter((entry) => Number.isFinite(entry) && entry > 0 && entry < 1)
    .map((entry) => Math.max(0, Math.min(1, entry)))
    .sort((left, right) => left - right);
  return sorted.filter((entry, index) => index === 0 || Math.abs(entry - sorted[index - 1]) > 1.0e-6);
}

export function buildNAMModelQualityOptions(
  breakpoints: readonly number[] | undefined,
): NAMModelQualityOption[] {
  const thresholds = normalizedNAMModelSizeBreakpoints(breakpoints);
  const values = thresholds.length === 0
    ? [0, 1]
    : [
      0,
      ...thresholds.slice(1).map((threshold, index) => (
        0.5 * (thresholds[index] + threshold)
      )),
      1,
    ];

  return values.map((value, index) => {
    if (index === 0) return { value, label: "Economy" };
    if (index === values.length - 1) return { value, label: "Full" };
    const balancedCount = values.length - 2;
    return {
      value,
      label: balancedCount === 1 ? "Balanced" : `Balanced ${index}`,
    };
  });
}

export function resolveNAMModelQualityOptionValue(
  requestedSize: unknown,
  breakpoints: readonly number[] | undefined,
): number {
  const thresholds = normalizedNAMModelSizeBreakpoints(breakpoints);
  const options = buildNAMModelQualityOptions(thresholds);
  const size = normalizedNAMModelSize(requestedSize);
  const tierIndex = thresholds.findIndex((threshold) => size < threshold);
  return options[tierIndex < 0 ? options.length - 1 : tierIndex]?.value ?? 1;
}

export function migrateNAMRackModelQualityState(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const root = state as Record<string, unknown>;
  if (!root.modelState || typeof root.modelState !== "object" || Array.isArray(root.modelState)) {
    return state;
  }

  const modelState = root.modelState as Record<string, unknown>;
  const values = asRecord(root.values);
  let legacySize: number | undefined;
  if (typeof values.namModelSize === "number" && Number.isFinite(values.namModelSize)) {
    legacySize = normalizedNAMModelSize(values.namModelSize);
  } else if (Array.isArray(root.parameters)) {
    const legacyParam = root.parameters
      .map(asRecord)
      .find((parameter) => parameter.id === "namModelSize");
    if (typeof legacyParam?.value === "number" && Number.isFinite(legacyParam.value)) {
      legacySize = normalizedNAMModelSize(legacyParam.value);
    }
  }

  const nextModelState = { ...modelState };
  let changed = false;
  for (const [pathKey, sizeKey] of [
    ["pedalModelPath", "pedalModelSize"],
    ["ampModelPath", "ampModelSize"],
  ] as const) {
    if (typeof modelState[pathKey] !== "string" || !modelState[pathKey].trim()) continue;
    const normalizedSize = normalizedNAMModelSize(modelState[sizeKey], legacySize ?? 1);
    if (modelState[sizeKey] !== normalizedSize) {
      nextModelState[sizeKey] = normalizedSize;
      changed = true;
    }
  }

  return changed ? { ...root, modelState: nextModelState } : state;
}

export const CURRENT_NAM_EFFECTS_DSP_VERSION = 11 as const;
export const CURRENT_NAM_REVERB_ENGINE_VERSION = 5 as const;

export const NAM_REVERB_VOICE_LABELS = ["Studio", "Plate", "Hall", "Room"] as const;

export function normalizeNAMReverbVoice(value: unknown): 0 | 1 | 2 | 3 {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(3, Math.max(0, Math.round(numeric))) as 0 | 1 | 2 | 3;
}

// A complete preset is a self-contained snapshot of the one DSP graph shipped
// by the unreleased NAM Rack. Keep every version-sensitive module represented
// so an old or accidentally incomplete snapshot cannot inherit latent values
// from whichever rack instance happens to receive it.
const CURRENT_NAM_RACK_COMPONENT_DEFAULTS: Readonly<Record<string, number>> = {
  instrumentProfile: 0,
  eqLevelDb: 0,
  compressorEnabled: 0,
  compressorAttackMs: 21.9,
  compressorReleaseMs: 149.1,
  compressorToneDb: 0,
  compressorSidechainHPF: 1,
  compressorMix: 0.65,
  compressorVolumeDb: 0,
  compressorComp: 0.35,
  tapeEchoEnabled: 0,
  tapeEchoMix: 0.28,
  tapeEchoTimeMs: 360,
  tapeEchoFeedback: 0.28,
  tapeEchoMod: 0.18,
  tapeEchoTone: 0.58,
  octaverEnabled: 0,
  octaverDownMix: 0.32,
  octaverUpMix: 0.18,
  octaverDirectMix: 1,
  precisionDriveEnabled: 0,
  precisionDriveVolumeDb: 9,
  precisionDriveBright: 0.55,
  precisionDriveAttack: 0.5,
  precisionDriveGate: 0,
  precisionDriveDrive: 0.35,
  chaosEnabled: 0,
  chaosMode: 0,
  chaosWeight: 0.5,
  chaosDrive: 0.62,
  chaosTone: 0.55,
  chaosGate: 0.22,
  chaosMix: 1,
  chaosLevelDb: 0,
  cabRoomEnabled: 0,
  cabRoomAmount: 0.22,
  cabRoomWidth: 0.65,
  cabDoublerEnabled: 0,
  cabDoublerMix: 0.12,
  cabDoublerSpread: 0.65,
  chorusMix: 0.3,
  chorusRateHz: 0.75,
  chorusDepth: 0.32,
  chorusCharacter: 1,
  modulatorMode: 0,
  modulatorFeedback: 0.1,
  modulatorAutoRandom: 0,
  modulatorAutoSpeed: 0.35,
  modulatorEnabled: 0,
  modulatorPedalMode: 1,
  modulatorPedalPosition: 0.5,
  delayMix: 0.22,
  delayTimeMs: 360,
  delayFeedback: 0.22,
  delayMod: 0.18,
  delayDucker: 0.12,
  delayMode: 1,
  delayPingPong: 1,
  delayTempoSync: 0,
  delayEnabled: 0,
  reverbVoice: 0,
  reverbMix: 0.28,
  reverbDecaySec: 2.2,
  reverbTone: 0.62,
  reverbPreDelayMs: 18,
  reverbLowCutHz: 120,
  reverbShimmer: 0,
  reverbEnabled: 0,
};

const RETIRED_NAM_RACK_VALUE_KEYS = [
  ...NAM_RETIRED_LASER_STATE_KEYS,
  ...NAM_RETIRED_REVERB_V2_STATE_KEYS,
  ...NAM_RETIRED_PRECISION_DRIVE_STATE_KEYS,
  ...NAM_RETIRED_COMPRESSOR_STATE_KEYS,
  ...NAM_RETIRED_AUDITION_STATE_KEYS,
  ...NAM_RETIRED_INPUT_ROUTING_STATE_KEYS,
] as const;

function normalizedLegacyCompressorDetail(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0.55;
}

function legacyCompressorAttackMs(detail: number) {
  // V6 Punch timing: nominal 2..30 ms, then the style's 1.5x attack factor.
  return 1.5 * (2 + (1 - detail) * 28);
}

function legacyCompressorReleaseMs(detail: number) {
  // V6 Punch timing: nominal 70..330 ms, then the style's 0.7x release factor.
  return 0.7 * (70 + detail * 260);
}

function clampNAMDelayValue(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

function normalizeNAMDelayToggle(value: unknown, fallback: 0 | 1): 0 | 1 {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? (numeric >= 0.5 ? 1 : 0) : fallback;
}

export const NAM_DELAY_MODE_LABELS = ["Digital", "Tape", "Analog", "Multi", "Dual"] as const;

export function normalizeNAMDelayMode(value: unknown, maxMode: 2 | 4 = 4): 0 | 1 | 2 | 3 | 4 {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(maxMode, Math.max(0, Math.round(numeric))) as 0 | 1 | 2 | 3 | 4;
}

function sanitizeNAMDelayPresetValues(
  values: Record<string, number>,
  sourceEffectsVersion: number | undefined,
) {
  values.delayMix = clampNAMDelayValue(values.delayMix, 0, 1, 0.22);
  values.delayTimeMs = clampNAMDelayValue(values.delayTimeMs, 1, 2000, 360);
  values.delayFeedback = clampNAMDelayValue(values.delayFeedback, 0, 0.85, 0.22);
  values.delayMod = clampNAMDelayValue(values.delayMod, 0, 1, 0.18);
  values.delayDucker = clampNAMDelayValue(values.delayDucker, 0, 1, 0.12);
  values.delayMode = Number.isInteger(sourceEffectsVersion)
      && sourceEffectsVersion! >= 10
      && sourceEffectsVersion! <= CURRENT_NAM_EFFECTS_DSP_VERSION
    ? normalizeNAMDelayMode(values.delayMode, 4)
    : Number.isInteger(sourceEffectsVersion) && sourceEffectsVersion! >= 1 && sourceEffectsVersion! <= 9
      ? normalizeNAMDelayMode(values.delayMode, 2)
      : 1;
  values.delayPingPong = normalizeNAMDelayToggle(values.delayPingPong, 1);
  values.delayTempoSync = normalizeNAMDelayToggle(values.delayTempoSync, 0);
  values.delayEnabled = normalizeNAMDelayToggle(values.delayEnabled, 0);
}

function hasCurrentNAMDelayPresetValues(values: Record<string, unknown>) {
  return clampNAMDelayValue(values.delayMix, 0, 1, 0.22) === values.delayMix
    && clampNAMDelayValue(values.delayTimeMs, 1, 2000, 360) === values.delayTimeMs
    && clampNAMDelayValue(values.delayFeedback, 0, 0.85, 0.22) === values.delayFeedback
    && clampNAMDelayValue(values.delayMod, 0, 1, 0.18) === values.delayMod
    && clampNAMDelayValue(values.delayDucker, 0, 1, 0.12) === values.delayDucker
    && normalizeNAMDelayMode(values.delayMode, 4) === values.delayMode
    && normalizeNAMDelayToggle(values.delayPingPong, 1) === values.delayPingPong
    && normalizeNAMDelayToggle(values.delayTempoSync, 0) === values.delayTempoSync
    && normalizeNAMDelayToggle(values.delayEnabled, 0) === values.delayEnabled;
}

/**
 * Canonicalizes complete tone/preset bundles to the only shipped native DSP.
 * Generic parameter patches remain sparse unless the caller explicitly marks
 * the object as a complete preset.
 */
export function migrateLegacyNAMRackPresetDspState(
  state: unknown,
  options: { completePreset?: boolean; sourceEffectsVersion?: number } = {},
): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const root = state as Record<string, unknown>;
  const dspState = asRecord(root.dspState);
  const values = numericValues(root.values);
  const completePreset = options.completePreset === true;

  if (!completePreset) {
    if (!Object.prototype.hasOwnProperty.call(root, "dspState")) return state;
    return {
      ...root,
      dspState: {
        ...dspState,
        reverbEngineVersion: CURRENT_NAM_REVERB_ENGINE_VERSION,
        namEffectsDspVersion: CURRENT_NAM_EFFECTS_DSP_VERSION,
      },
    };
  }

  const ownRawEffectsVersion = Number(dspState.namEffectsDspVersion);
  const rawEffectsVersion = Number.isFinite(ownRawEffectsVersion)
    ? ownRawEffectsVersion
    : options.sourceEffectsVersion;
  const instrumentProfileRecognized = Number.isInteger(rawEffectsVersion)
    && rawEffectsVersion! >= 8
    && rawEffectsVersion! <= CURRENT_NAM_EFFECTS_DSP_VERSION;
  const reverbVoiceRecognized = Number.isInteger(rawEffectsVersion)
    && rawEffectsVersion! >= 9
    && rawEffectsVersion! <= CURRENT_NAM_EFFECTS_DSP_VERSION;
  const requiresV8Migration = !instrumentProfileRecognized;
  const hasLegacyCompressorDetail = Object.prototype.hasOwnProperty.call(values, "compressorDetail");
  const hasCompressorAttack = Object.prototype.hasOwnProperty.call(values, "compressorAttackMs");
  const hasCompressorRelease = Object.prototype.hasOwnProperty.call(values, "compressorReleaseMs");
  const hasCabRoomEnabled = Object.prototype.hasOwnProperty.call(values, "cabRoomEnabled");
  const hasCabDoublerEnabled = Object.prototype.hasOwnProperty.call(values, "cabDoublerEnabled");
  const legacyCabRoomAmount = values.cabRoomAmount ?? 0;
  const legacyCabDoublerMix = values.cabDoublerMix ?? 0;
  const legacyCompressorDetail = normalizedLegacyCompressorDetail(values.compressorDetail);
  const legacyDistortionMode = (values.precisionDriveMode ?? 0) >= 0.5;
  const hasDedicatedDistortionState = [
    "chaosMode", "chaosDrive", "chaosTone", "chaosGate", "chaosLevelDb",
  ].some((id) => Object.prototype.hasOwnProperty.call(values, id));
  const originalPrecisionVolume = Object.prototype.hasOwnProperty.call(
    values, "precisionDriveVolumeDb",
  ) ? values.precisionDriveVolumeDb : 0;
  const migratedValues = { ...CURRENT_NAM_RACK_COMPONENT_DEFAULTS, ...values };
  // Instrument Profile first shipped with V8. Any earlier/unknown marker must
  // ignore a colliding legacy value and migrate deterministically to Guitar.
  migratedValues.instrumentProfile = requiresV8Migration
    ? 0
    : normalizeNAMInstrumentProfile(values.instrumentProfile);
  // Reverb Voice first ships with V9.  Every older/missing marker describes
  // the sound that is now named STUDIO, so ignore any colliding legacy key.
  migratedValues.reverbVoice = reverbVoiceRecognized
    ? normalizeNAMReverbVoice(values.reverbVoice)
    : 0;
  // V9 is the first complete-preset contract that validates the entire public
  // Delay schema. Keep every saved, baseline, and A/B snapshot inside the
  // exact native ranges and canonicalize selector/toggle state.
  sanitizeNAMDelayPresetValues(migratedValues, rawEffectsVersion);
  // Room and Doubler previously used zero Amount/Mix as their bypass state.
  // Derive power only when a complete legacy snapshot lacks the new flag;
  // an explicit disabled flag must retain its non-zero stored setting.
  if (!hasCabRoomEnabled) {
    migratedValues.cabRoomEnabled = legacyCabRoomAmount > 1.0e-4 ? 1 : 0;
  }
  if (!hasCabDoublerEnabled) {
    migratedValues.cabDoublerEnabled = legacyCabDoublerMix > 1.0e-4 ? 1 : 0;
  }
  if (requiresV8Migration || hasLegacyCompressorDetail) {
    if (!hasCompressorAttack) {
      migratedValues.compressorAttackMs = legacyCompressorAttackMs(legacyCompressorDetail);
    }
    if (!hasCompressorRelease) {
      migratedValues.compressorReleaseMs = legacyCompressorReleaseMs(legacyCompressorDetail);
    }
  }
  if (legacyDistortionMode && !hasDedicatedDistortionState) {
    migratedValues.chaosEnabled = values.precisionDriveEnabled ?? 0;
    migratedValues.chaosMode = 0;
    migratedValues.chaosDrive = values.precisionDriveDrive ?? 0.35;
    migratedValues.chaosTone = values.precisionDriveBright ?? 0.55;
    migratedValues.chaosMix = 1;
    migratedValues.chaosLevelDb = originalPrecisionVolume;
    migratedValues.precisionDriveEnabled = 0;
  }
  for (const retiredKey of RETIRED_NAM_RACK_VALUE_KEYS) {
    delete migratedValues[retiredKey];
  }
  if (
    requiresV8Migration
    && Math.abs(originalPrecisionVolume) <= 1.0e-6
  ) {
    migratedValues.precisionDriveVolumeDb = 9;
  }

  const migratedRoot: Record<string, unknown> = {
    ...root,
    values: migratedValues,
    dspState: {
      ...dspState,
      reverbEngineVersion: CURRENT_NAM_REVERB_ENGINE_VERSION,
      namEffectsDspVersion: CURRENT_NAM_EFFECTS_DSP_VERSION,
    },
  };

  // A complete native preset can carry latent rack snapshots inside uiState.
  // Canonicalize those complete snapshots too so A/B recall cannot reactivate
  // retired controls after the top-level rack has migrated.
  if (root.uiState && typeof root.uiState === "object" && !Array.isArray(root.uiState)) {
    const uiState = { ...root.uiState as Record<string, unknown> };
    const migrateSnapshot = (value: unknown) => (
      value && typeof value === "object" && !Array.isArray(value)
        ? migrateLegacyNAMRackPresetDspState(value, {
            completePreset: true,
            sourceEffectsVersion: rawEffectsVersion,
          })
        : value
    );
    if (Object.prototype.hasOwnProperty.call(uiState, "namPresetBaseline")) {
      uiState.namPresetBaseline = migrateSnapshot(uiState.namPresetBaseline);
    }
    if (
      uiState.namRackCompare
      && typeof uiState.namRackCompare === "object"
      && !Array.isArray(uiState.namRackCompare)
    ) {
      const compare = { ...uiState.namRackCompare as Record<string, unknown> };
      if (compare.snapshots && typeof compare.snapshots === "object" && !Array.isArray(compare.snapshots)) {
        const snapshots = { ...compare.snapshots as Record<string, unknown> };
        for (const slot of ["A", "B"] as const) {
          if (Object.prototype.hasOwnProperty.call(snapshots, slot)) {
            snapshots[slot] = migrateSnapshot(snapshots[slot]);
          }
        }
        compare.snapshots = snapshots;
      }
      uiState.namRackCompare = compare;
    }
    migratedRoot.uiState = uiState;
  }

  return migratedRoot;
}

/** True only for a complete native readback from the current rack schema. */
export function isCurrentNAMRackPresetState(state: unknown): boolean {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const root = state as Record<string, unknown>;
  const dspState = asRecord(root.dspState);
  if (
    dspState.namEffectsDspVersion !== CURRENT_NAM_EFFECTS_DSP_VERSION
    || dspState.reverbEngineVersion !== CURRENT_NAM_REVERB_ENGINE_VERSION
  ) {
    return false;
  }

  const values = asRecord(root.values);
  return normalizeNAMInstrumentProfile(values.instrumentProfile) === values.instrumentProfile
    && normalizeNAMReverbVoice(values.reverbVoice) === values.reverbVoice
    && hasCurrentNAMDelayPresetValues(values)
    && Object.keys(CURRENT_NAM_RACK_COMPONENT_DEFAULTS)
    .every((id) => typeof values[id] === "number" && Number.isFinite(values[id]))
    && RETIRED_NAM_RACK_VALUE_KEYS.every(
      (id) => !Object.prototype.hasOwnProperty.call(values, id),
    );
}

export function countNAMUserPresetFilters<T extends { name: string }>(
  presets: readonly T[],
  metadata: Readonly<Record<string, NAMUserPresetLibraryMetadata>>,
): NAMUserPresetFilterCounts {
  let favorites = 0;
  let recent = 0;
  for (const preset of presets) {
    const entryMetadata = metadata[preset.name];
    if (entryMetadata?.favorite) ++favorites;
    if (entryMetadata?.lastUsed) ++recent;
  }
  return { all: presets.length, favorites, recent };
}

export function getNAMUserPresetEmptyState(
  totalPresetCount: number,
  visiblePresetCount: number,
  activeFilter: string,
  search: string,
): NAMUserPresetEmptyState | undefined {
  if (visiblePresetCount > 0) return undefined;
  if (totalPresetCount === 0) {
    return { message: "No saved presets yet", showAll: false };
  }

  const hasSearch = search.trim().length > 0;
  return {
    message: hasSearch
      ? "No user presets match the current search or filter"
      : "No user presets match the selected filter",
    showAll: activeFilter !== "all" || hasSearch,
  };
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
  if (result.pedalModelPath) {
    result.pedalModelSize = normalizedNAMModelSize(source.pedalModelSize);
  }
  if (result.ampModelPath && typeof source.ampDeclaredCaptureType === "string") {
    result.ampDeclaredCaptureType = source.ampDeclaredCaptureType.trim() || "unknown";
  }
  if (result.ampModelPath) {
    result.ampModelSize = normalizedNAMModelSize(source.ampModelSize);
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
  dspState?: Record<string, unknown>;
};

export function buildNAMRackRollbackPatch(state: unknown): NAMRackRollbackPatch | null {
  const source = asRecord(pruneRetiredNAMRackInputRoutingState(state));
  if (Object.keys(source).length === 0) return null;
  const values = numericValues(source.values);
  delete values.auditionSource;
  const patch: NAMRackRollbackPatch = {
    values,
    modelState: resourceRestoreState(source.modelState),
    uiState: { ...asRecord(source.uiState) },
  };
  const dspState = sanitizeNAMRackDspState(source.dspState);
  if (Object.keys(dspState).length > 0) patch.dspState = dspState;
  return patch;
}
