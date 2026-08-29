type NAMMetadataRecord = Record<string, unknown>;

const IDENTITY_NOISE_TOKENS = new Set([
  "amp",
  "cab",
  "cabinet",
  "capture",
  "full",
  "gear",
  "loaded",
  "model",
  "nam",
  "profile",
  "rig",
  "the",
  "tone",
]);

function asRecord(value: unknown): NAMMetadataRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as NAMMetadataRecord
    : {};
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function candidateMetadataRecords(sources: readonly unknown[]) {
  const records: NAMMetadataRecord[] = [];
  const append = (value: unknown) => {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) records.push(record);
  };

  for (const source of sources) {
    const sourceRecord = asRecord(source);
    append(sourceRecord);
    for (const key of ["metadata", "namMetadata", "modelMetadata", "lastSeenMetadata", "latestMetadata"] as const) {
      const nested = asRecord(sourceRecord[key]);
      append(nested);
      append(nested.metadata);
      append(nested.namMetadata);
    }
  }
  return records;
}

function firstMetadataValue(records: readonly NAMMetadataRecord[], ...keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const text = cleanString(record[key]);
      if (text) return text;
    }
  }
  return "";
}

function normalizedIdentityText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function identityTokens(value: string) {
  return normalizedIdentityText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !IDENTITY_NOISE_TOKENS.has(token));
}

function identitiesAgree(listing: string, embeddedGear: string) {
  const normalizedListing = normalizedIdentityText(listing);
  const normalizedGear = normalizedIdentityText(embeddedGear);
  if (!normalizedListing || !normalizedGear) return true;

  const compactListing = normalizedListing.replace(/\s+/g, "");
  const compactGear = normalizedGear.replace(/\s+/g, "");
  if (
    compactListing.length >= 4
    && compactGear.length >= 4
    && (compactListing.includes(compactGear) || compactGear.includes(compactListing))
  ) {
    return true;
  }

  const listingTokens = identityTokens(listing);
  const gearTokens = new Set(identityTokens(embeddedGear));
  // A shared make, model word, or model number is enough to avoid presenting a
  // warning. This is deliberately conservative: the UI should flag clear
  // contradictions, not second-guess abbreviated capture names.
  return listingTokens.length === 0
    || gearTokens.size === 0
    || listingTokens.some((token) => gearTokens.has(token));
}

export type NAMModelIdentityWarningInput = {
  displayName?: unknown;
  metadataName?: unknown;
  gearMake?: unknown;
  gearModel?: unknown;
  metadataSources?: readonly unknown[];
};

export function resolveNAMModelIdentityWarning({
  displayName,
  metadataName,
  gearMake,
  gearModel,
  metadataSources = [],
}: NAMModelIdentityWarningInput) {
  const records = candidateMetadataRecords(metadataSources);
  const embeddedMake = firstString(
    gearMake,
    firstMetadataValue(records, "gear_make", "gearMake"),
  );
  const embeddedModel = firstString(
    gearModel,
    firstMetadataValue(records, "gear_model", "gearModel"),
  );
  const metadataListing = firstString(
    metadataName,
    firstMetadataValue(records, "name", "model_name", "modelName"),
  );
  const visibleListing = cleanString(displayName);
  if ((!metadataListing && !visibleListing) || (!embeddedMake && !embeddedModel)) return null;

  const makeMatchesModel = embeddedMake
    && embeddedModel
    && normalizedIdentityText(embeddedMake) === normalizedIdentityText(embeddedModel);
  const embeddedGear = makeMatchesModel
    ? embeddedModel
    : [embeddedMake, embeddedModel].filter(Boolean).join(" ");
  const listing = [metadataListing, visibleListing]
    .filter((candidate, index, candidates) => (
      Boolean(candidate) && candidates.indexOf(candidate) === index
    ))
    .find((candidate) => !identitiesAgree(candidate, embeddedGear));
  if (!listing) return null;

  return `Embedded gear metadata identifies ${embeddedGear}; the model label says “${listing}”. Verify this Capture's identity.`;
}

export type NAMGainStagingWarningInput = {
  inputTrimDb?: unknown;
  driveActive?: boolean;
  driveLevelDb?: unknown;
  ampActive?: boolean;
  ampBoostActive?: boolean;
};

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function signedDb(value: number) {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)} dB`;
}

export function resolveNAMGainStagingWarning({
  inputTrimDb,
  driveActive = false,
  driveLevelDb,
  ampActive = false,
  ampBoostActive = false,
}: NAMGainStagingWarningInput) {
  if (!ampActive) return null;

  const inputDb = finiteNumber(inputTrimDb);
  const driveDb = driveActive ? finiteNumber(driveLevelDb) : 0;
  const positiveGainDb = Math.max(0, inputDb) + Math.max(0, driveDb);
  const boostStacked = ampBoostActive;
  const hot = inputDb >= 6
    || (driveActive && driveDb >= 9)
    || positiveGainDb >= 12
    || (boostStacked && driveActive && positiveGainDb >= 6)
    || (boostStacked && inputDb >= 4);
  if (!hot) return null;

  const stages = [`Input ${signedDb(inputDb)}`];
  if (driveActive) stages.push(`Drive Level ${signedDb(driveDb)}`);
  if (boostStacked) stages.push("Tight Boost");
  const correctiveAction = boostStacked
    ? "Reduce Input or Drive Level, or disable Tight Boost"
    : "Reduce Input or Drive Level";
  return `Hot amp input: ${stages.join(", ")} are stacked. ${correctiveAction} if noise or smear appears.`;
}

export type NAMEconomyQualityWarningInput = {
  hasAmpModel?: boolean;
  slimmable?: boolean;
  requestedQualityValue?: unknown;
  activeQualityValue?: unknown;
};

export function resolveNAMEconomyQualityWarning({
  hasAmpModel = false,
  slimmable = false,
  requestedQualityValue,
  activeQualityValue,
}: NAMEconomyQualityWarningInput) {
  if (!hasAmpModel || !slimmable) return null;
  const requested = finiteNumber(requestedQualityValue, 1);
  const active = finiteNumber(activeQualityValue, 1);
  if (requested > 1.0e-6 && active > 1.0e-6) return null;
  return "Amp Quality is Economy. Set Amp Quality to Full for the highest-fidelity model graph.";
}
