export type NAMInstrumentProfile = 0 | 1;

export type NAMInstrumentProfileTag = "guitar" | "bass" | "all";

export const NAM_INSTRUMENT_PROFILE_GUITAR = 0 as const;
export const NAM_INSTRUMENT_PROFILE_BASS = 1 as const;

export const NAM_INSTRUMENT_PROFILE_OPTIONS: ReadonlyArray<{
  value: NAMInstrumentProfile;
  label: "Guitar" | "Bass";
}> = [
  { value: NAM_INSTRUMENT_PROFILE_GUITAR, label: "Guitar" },
  { value: NAM_INSTRUMENT_PROFILE_BASS, label: "Bass" },
];

export type NAMPreEqBandParamId =
  | "preEq120Db"
  | "preEq250Db"
  | "preEq500Db"
  | "preEq1kDb"
  | "preEq2k5Db"
  | "preEq5kDb"
  | "preEq8kDb"
  | "preEq12kDb";

export type NAMPreEqBandPresentation = Readonly<{
  paramId: NAMPreEqBandParamId;
  frequencyHz: number;
  faceplateLabel: string;
  accessibleLabel: string;
}>;

const NAM_PRE_EQ_PARAM_IDS: readonly NAMPreEqBandParamId[] = [
  "preEq120Db",
  "preEq250Db",
  "preEq500Db",
  "preEq1kDb",
  "preEq2k5Db",
  "preEq5kDb",
  "preEq8kDb",
  "preEq12kDb",
];

function preEqBand(
  paramId: NAMPreEqBandParamId,
  frequencyHz: number,
  faceplateLabel: string,
  accessibleLabel: string,
): NAMPreEqBandPresentation {
  return { paramId, frequencyHz, faceplateLabel, accessibleLabel };
}

/**
 * The parameter IDs remain the original Guitar-band IDs for preset and
 * automation compatibility. Instrument Profile changes only their effective
 * center frequencies and the labels presented to the user.
 */
const NAM_PRE_EQ_BANDS_BY_PROFILE: Readonly<
  Record<NAMInstrumentProfile, readonly NAMPreEqBandPresentation[]>
> = {
  [NAM_INSTRUMENT_PROFILE_GUITAR]: [
    preEqBand(NAM_PRE_EQ_PARAM_IDS[0], 120, "120", "120 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[1], 250, "250", "250 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[2], 500, "500", "500 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[3], 1000, "1K", "1 kHz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[4], 2500, "2.5K", "2.5 kHz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[5], 5000, "5K", "5 kHz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[6], 8000, "8K", "8 kHz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[7], 12000, "12K", "12 kHz"),
  ],
  [NAM_INSTRUMENT_PROFILE_BASS]: [
    preEqBand(NAM_PRE_EQ_PARAM_IDS[0], 50, "50", "50 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[1], 120, "120", "120 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[2], 250, "250", "250 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[3], 500, "500", "500 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[4], 800, "800", "800 Hz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[5], 1600, "1.6K", "1.6 kHz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[6], 4500, "4.5K", "4.5 kHz"),
    preEqBand(NAM_PRE_EQ_PARAM_IDS[7], 10000, "10K", "10 kHz"),
  ],
};

export function namPreEqBandsForProfile(
  profile: unknown,
): readonly NAMPreEqBandPresentation[] {
  return NAM_PRE_EQ_BANDS_BY_PROFILE[normalizeNAMInstrumentProfile(profile)];
}

export function namPreEqBandLabelsForProfile(
  profile: unknown,
): Readonly<Record<NAMPreEqBandParamId, string>> {
  return Object.fromEntries(
    namPreEqBandsForProfile(profile).map(({ paramId, accessibleLabel }) => [
      paramId,
      accessibleLabel,
    ]),
  ) as Record<NAMPreEqBandParamId, string>;
}

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

export function namInstrumentProfileTagIsCompatible(
  tag: NAMInstrumentProfileTag | undefined,
  profile: unknown,
): boolean {
  if (!tag || tag === "all") return true;
  return normalizeNAMInstrumentProfile(profile) === NAM_INSTRUMENT_PROFILE_BASS
    ? tag === "bass"
    : tag === "guitar";
}

/**
 * A stored preset's migrated DSP payload is the profile authority. Sidecar
 * metadata is editable library decoration and can lag behind a migrated or
 * imported preset, so it must never decide whether that preset is visible.
 */
export function namStoredPresetMatchesInstrumentProfile(
  preset: {
    instrumentProfile?: "guitar" | "bass";
    metadata?: { instrumentProfile?: "guitar" | "bass" };
  },
  profile: unknown,
): boolean {
  return namInstrumentProfileTagIsCompatible(preset.instrumentProfile, profile);
}

export function shouldClearNAMFactoryPresetIdentityOnProfileChange(
  activePresetTag: NAMInstrumentProfileTag | undefined,
  currentProfile: unknown,
  nextProfile: unknown,
): boolean {
  const current = normalizeNAMInstrumentProfile(currentProfile);
  const next = normalizeNAMInstrumentProfile(nextProfile);
  return current !== next
    && !namInstrumentProfileTagIsCompatible(activePresetTag, next);
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

const NAM_INSTRUMENT_METADATA_KEYS = [
  "instrument",
  "instrument_type",
  "instrumentType",
  "instruments",
  "target_instrument",
  "targetInstrument",
] as const;

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanMetadataLabel(value: unknown): string {
  return String(value ?? "").trim().replace(/[_-]+/g, " ");
}

function metadataLabelsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(metadataLabelsFromValue);
  if (typeof value === "string" || typeof value === "number") {
    const label = cleanMetadataLabel(value);
    return label ? [label] : [];
  }

  const object = metadataRecord(value);
  if (!object) return [];
  for (const key of ["name", "title", "label", "display_name", "displayName", "slug"] as const) {
    const label = cleanMetadataLabel(object[key]);
    if (label) return [label];
  }
  return [];
}

/** Reads the inconsistent instrument fields emitted by catalog and sidecar data. */
export function namInstrumentLabelsFromMetadataSources(
  sources: readonly unknown[],
): string[] {
  const labels = new Set<string>();
  for (const source of sources) {
    const object = metadataRecord(source);
    if (!object) continue;
    for (const key of NAM_INSTRUMENT_METADATA_KEYS) {
      for (const label of metadataLabelsFromValue(object[key])) labels.add(label);
    }
  }
  return [...labels].sort((left, right) => left.localeCompare(
    right,
    undefined,
    { sensitivity: "base" },
  ));
}

export function namInstalledCaptureInstrumentLabels(record: unknown): string[] {
  const source = metadataRecord(record);
  if (!source) return [];
  return namInstrumentLabelsFromMetadataSources([
    source,
    source.latestMetadata,
    source.lastSeenMetadata,
  ]);
}

/**
 * Applies discovery compatibility without making cross-instrument use
 * destructive. Active items always remain visible and are pinned first.
 */
export function filterAndPinNAMInstrumentItems<T>(
  items: readonly T[],
  profile: unknown,
  labelsForItem: (item: T) => readonly string[],
  isActive: (item: T) => boolean = () => false,
): T[] {
  const active: T[] = [];
  const compatible: T[] = [];
  for (const item of items) {
    if (isActive(item)) {
      active.push(item);
    } else if (namInstrumentLabelsAreCompatible(labelsForItem(item), profile)) {
      compatible.push(item);
    }
  }
  return [...active, ...compatible];
}
