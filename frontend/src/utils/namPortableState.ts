export const NAM_RETIRED_LASER_STATE_KEYS = new Set([
  "laserEnabled",
  "laserMode",
  "laserMix",
  "laserSpeedHz",
  "laserSensitivity",
  "laserEnvelopeMode",
  "laserTrigger",
]);

export const NAM_RETIRED_REVERB_V2_STATE_KEYS = new Set([
  "reverbCharacter",
  "reverbWidth",
  "reverbDucking",
  "reverbBassDecay",
  "reverbMovement",
  "reverbEarlyLate",
  "reverbDiffusion",
  "reverbShimmerRegen",
  "reverbFreeze",
]);

export const NAM_RETIRED_PRECISION_DRIVE_STATE_KEYS = new Set([
  "precisionDriveMode",
]);

export const NAM_RETIRED_COMPRESSOR_STATE_KEYS = new Set([
  "compressorDetail",
]);

export const NAM_RETIRED_AUDITION_STATE_KEYS = new Set([
  "auditionSource",
]);

// Input topology belongs to the DAW track route. Older NAM Rack snapshots
// carried a user-selectable mode that could silently disagree with that route;
// never persist or automate it now that routing is automatic.
export const NAM_RETIRED_INPUT_ROUTING_STATE_KEYS = new Set([
  "inputMode",
]);

/**
 * Removes the retired rack-local routing selector at every nesting depth.
 * This is intentionally narrower than the portable-state replacer because
 * dev runtime state may still carry non-portable controls such as the
 * internal audition source while a preview is active.
 */
export function pruneRetiredNAMRackInputRoutingState<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneRetiredNAMRackInputRoutingState(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !NAM_RETIRED_INPUT_ROUTING_STATE_KEYS.has(key))
        .map(([key, entry]) => [key, pruneRetiredNAMRackInputRoutingState(entry)]),
    ) as T;
  }
  return value;
}

export const NAM_NON_PORTABLE_STATE_KEYS = new Set([
  "calibrationReferenceDbu",
  ...NAM_RETIRED_AUDITION_STATE_KEYS,
  ...NAM_RETIRED_INPUT_ROUTING_STATE_KEYS,
  ...NAM_RETIRED_LASER_STATE_KEYS,
  ...NAM_RETIRED_REVERB_V2_STATE_KEYS,
  ...NAM_RETIRED_PRECISION_DRIVE_STATE_KEYS,
  ...NAM_RETIRED_COMPRESSOR_STATE_KEYS,
]);

export type NAMEffectsDspVersion = 11;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeNAMEffectsDspVersion(value: unknown): NAMEffectsDspVersion | undefined {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 && version <= 11
    ? 11
    : undefined;
}

/**
 * Whitelists the portable DSP-engine selectors understood by NAM Rack. Unknown
 * or out-of-range selectors must not be replayed into another rack instance.
 */
export function sanitizeNAMRackDspState(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const result: Record<string, number> = {};
  const reverbEngineVersion = Number(source.reverbEngineVersion);
  if (Number.isInteger(reverbEngineVersion) && reverbEngineVersion >= 1 && reverbEngineVersion <= 5) {
    result.reverbEngineVersion = 5;
  }
  const namEffectsDspVersion = normalizeNAMEffectsDspVersion(source.namEffectsDspVersion);
  if (namEffectsDspVersion !== undefined) {
    result.namEffectsDspVersion = namEffectsDspVersion;
  }
  return result;
}

/**
 * Sanitizes a complete portable rack state without inventing a DSP selector on
 * generic partial patches that did not provide one.
 */
export function sanitizeNAMRackPortableDspState(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const source = state as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, "dspState")) return state;
  const { dspState: _discardedDspState, ...rest } = source;
  const dspState = sanitizeNAMRackDspState(source.dspState);
  return Object.keys(dspState).length > 0 ? { ...rest, dspState } : rest;
}

export function isNAMNonPortableStateKey(key: string): boolean {
  return NAM_NON_PORTABLE_STATE_KEYS.has(key);
}

export function omitNAMNonPortableState(key: string, value: unknown): unknown {
  return isNAMNonPortableStateKey(key) ? undefined : value;
}

export function isRetiredNAMRackAutomationParamId(paramId: unknown): boolean {
  const match = /^builtin_(?:input|track)_\d+_([A-Za-z0-9]+)$/.exec(String(paramId ?? ""));
  return Boolean(
    match?.[1]
      && (
        NAM_RETIRED_LASER_STATE_KEYS.has(match[1])
        || NAM_RETIRED_REVERB_V2_STATE_KEYS.has(match[1])
        || NAM_RETIRED_PRECISION_DRIVE_STATE_KEYS.has(match[1])
        || NAM_RETIRED_COMPRESSOR_STATE_KEYS.has(match[1])
        || NAM_RETIRED_AUDITION_STATE_KEYS.has(match[1])
        || NAM_RETIRED_INPUT_ROUTING_STATE_KEYS.has(match[1])
      ),
  );
}
