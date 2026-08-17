export type NAMInstrumentProfile = 0 | 1;

export const NAM_INSTRUMENT_PROFILE_GUITAR = 0 as const;
export const NAM_INSTRUMENT_PROFILE_BASS = 1 as const;

export const NAM_INSTRUMENT_PROFILE_OPTIONS: ReadonlyArray<{
  value: NAMInstrumentProfile;
  label: "Guitar" | "Bass";
}> = [
  { value: NAM_INSTRUMENT_PROFILE_GUITAR, label: "Guitar" },
  { value: NAM_INSTRUMENT_PROFILE_BASS, label: "Bass" },
];

/**
 * The rack ships in Guitar mode. Legacy presets and malformed automation
 * values therefore resolve deterministically to Guitar rather than inheriting
 * whichever profile happened to be active in the receiving rack.
 */
export function normalizeNAMInstrumentProfile(value: unknown): NAMInstrumentProfile {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0.5 && numeric <= 1
    ? NAM_INSTRUMENT_PROFILE_BASS
    : NAM_INSTRUMENT_PROFILE_GUITAR;
}

export function labelForNAMInstrumentProfile(value: unknown): "Guitar" | "Bass" {
  return normalizeNAMInstrumentProfile(value) === NAM_INSTRUMENT_PROFILE_BASS
    ? "Bass"
    : "Guitar";
}

/**
 * TONE3000 metadata is not normalized and many older records have no
 * instrument field. Keep untagged records discoverable, while excluding a
 * record only when it is explicitly tagged for the opposite instrument.
 */
export function namInstrumentLabelsAreCompatible(
  labels: readonly string[],
  profile: unknown,
): boolean {
  if (labels.length === 0) return true;
  let explicitlyGuitar = false;
  let explicitlyBass = false;
  for (const label of labels) {
    const normalized = String(label).trim().toLocaleLowerCase();
    if (
      /guitar\s*(?:\/|&|and)\s*bass/.test(normalized)
      || /bass\s*(?:\/|&|and)\s*guitar/.test(normalized)
    ) {
      return true;
    }
    const hasBass = normalized.includes("bass");
    const hasGuitar = normalized.includes("guitar") && !/\bbass\s+guitar\b/.test(normalized);
    explicitlyGuitar ||= hasGuitar;
    explicitlyBass ||= hasBass;
  }
  if (!explicitlyGuitar && !explicitlyBass) return true;
  return normalizeNAMInstrumentProfile(profile) === NAM_INSTRUMENT_PROFILE_BASS
    ? explicitlyBass
    : explicitlyGuitar;
}
