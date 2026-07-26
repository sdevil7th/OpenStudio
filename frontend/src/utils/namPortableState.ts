export const NAM_NON_PORTABLE_STATE_KEYS = new Set([
  "calibrationReferenceDbu",
  "auditionSource",
  "laserTrigger",
]);

export function isNAMNonPortableStateKey(key: string): boolean {
  return NAM_NON_PORTABLE_STATE_KEYS.has(key);
}

export function omitNAMNonPortableState(key: string, value: unknown): unknown {
  return isNAMNonPortableStateKey(key) ? undefined : value;
}
