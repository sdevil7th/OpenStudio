const EXTENSION_PATTERN = /\.(nam|wav|aif|aiff|flac|json)$/i;
const NAM_PREFIX_PATTERN = /^(?:tone-\d+-)?(?:model-\d+-)?(?:\d{2,4}-)?/i;
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
const UPPERCASE_WORDS = new Set(["a1", "a2", "di", "eq", "fx", "ir", "nam"]);

export function namFileName(path: string | undefined | null) {
  const trimmed = String(path ?? "").trim();
  if (!trimmed) return "";
  const clean = trimmed.split(/[?#]/)[0] ?? trimmed;
  return clean.split(/[\\/]/).pop() || clean;
}

function titleWord(word: string, index: number) {
  const lower = word.toLowerCase();
  if (!word) return "";
  if (UPPERCASE_WORDS.has(lower)) return lower.toUpperCase();
  if (/^[a-z]*\d+[a-z0-9/+-]*$/i.test(word)) return word.toUpperCase();
  if (/^[A-Z0-9/+-]+$/.test(word) && /[A-Z]/.test(word)) return word;
  if (index > 0 && SMALL_WORDS.has(lower)) return lower;
  if (word.includes("'")) {
    return word
      .split("'")
      .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part)
      .join("'");
  }
  return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}

export function namDisplayNameFromPath(path: string | undefined | null) {
  const file = namFileName(path);
  if (!file) return "";

  const stem = file
    .replace(EXTENSION_PATTERN, "")
    .replace(NAM_PREFIX_PATTERN, "")
    .replace(/\b(\d{1,2})\s*o\s*clock\b/gi, "$1 O'Clock")
    .replace(/[_\-.]+/g, " ")
    .replace(/\b(\d{1,2})\s*o\s*clock\b/gi, "$1 O'Clock")
    .replace(/\b(JCM|DSL|AC|JP|EVH)\s+(\d+)\b/gi, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  if (!stem) return file.replace(EXTENSION_PATTERN, "");
  return stem.split(" ").map(titleWord).join(" ");
}

export function firstNAMDisplayName(...values: Array<string | undefined | null>) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

export function asNAMRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function firstNAMString(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

export function firstNAMNumber(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function normalizedNAMLocalPath(value: unknown) {
  return firstNAMString(value)
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

export function namLocalPathsMatch(left: unknown, right: unknown) {
  const normalizedLeft = normalizedNAMLocalPath(left);
  const normalizedRight = normalizedNAMLocalPath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export type NAMToneIdentityInput = {
  activePreview?: unknown;
  savedTone?: unknown;
  installedRecord?: unknown;
  catalogTone?: unknown;
  catalogModel?: unknown;
  localPath?: unknown;
  titleFallback?: unknown;
  modelNameFallback?: unknown;
  creatorFallback?: unknown;
};

export type NAMToneIdentity = {
  title: string;
  modelName: string;
  creator: string;
  localPath: string;
  sourceUrl: string;
  license: string;
  toneId: number;
  modelId: number;
};

export function resolveNAMToneIdentity(input: NAMToneIdentityInput): NAMToneIdentity {
  const activePreview = asNAMRecord(input.activePreview);
  const savedToneCandidate = asNAMRecord(input.savedTone);
  // Runtime callers pass the backend modelState path as `localPath`. Once that
  // authoritative path is present, never let metadata from a different saved
  // tone describe the model that is actually producing audio.
  const hasAuthoritativeLocalPath = Object.prototype.hasOwnProperty.call(input, "localPath");
  const savedTone = !hasAuthoritativeLocalPath
    || namLocalPathsMatch(savedToneCandidate.localPath, input.localPath)
    ? savedToneCandidate
    : {};
  const savedMetadata = asNAMRecord(savedTone.metadata);
  const installedRecord = asNAMRecord(input.installedRecord);
  const latestMetadata = asNAMRecord(installedRecord.latestMetadata);
  const lastSeenMetadata = asNAMRecord(installedRecord.lastSeenMetadata);
  const catalogTone = asNAMRecord(input.catalogTone);
  const catalogModel = asNAMRecord(input.catalogModel);
  const user = asNAMRecord(catalogTone.user);
  const localPath = firstNAMString(
    activePreview.localPath,
    savedTone.localPath,
    installedRecord.localPath,
    input.localPath,
  );
  const modelUrl = firstNAMString(
    catalogModel.model_url,
    catalogModel.modelUrl,
    installedRecord.modelUrl,
    latestMetadata.model_url,
    latestMetadata.modelUrl,
    lastSeenMetadata.model_url,
    lastSeenMetadata.modelUrl,
  );
  const parsedName = namDisplayNameFromPath(localPath || modelUrl);
  const title = firstNAMString(
    activePreview.title,
    savedTone.captureTitle,
    installedRecord.toneTitle,
    catalogTone.title,
    catalogTone.toneTitle,
    catalogTone.tone_title,
    catalogTone.name,
    catalogModel.toneTitle,
    catalogModel.tone_title,
    latestMetadata.title,
    latestMetadata.toneTitle,
    latestMetadata.name,
    lastSeenMetadata.title,
    lastSeenMetadata.toneTitle,
    lastSeenMetadata.name,
    input.titleFallback,
    installedRecord.name,
    catalogModel.title,
    catalogModel.name,
    savedTone.modelName,
    parsedName,
    savedMetadata.toneName,
    savedTone.title,
  );
  const modelName = firstNAMString(
    activePreview.modelName,
    savedTone.modelName,
    installedRecord.name,
    catalogModel.title,
    catalogModel.name,
    latestMetadata.name,
    lastSeenMetadata.name,
    input.modelNameFallback,
    parsedName,
    title,
  );
  const creator = firstNAMString(
    activePreview.creator,
    savedMetadata.creator,
    savedTone.creator,
    installedRecord.creator,
    catalogTone.creator,
    catalogModel.creator,
    catalogModel.creator_name,
    user.username,
    latestMetadata.creator,
    latestMetadata.creator_name,
    lastSeenMetadata.creator,
    lastSeenMetadata.creator_name,
    input.creatorFallback,
  );

  return {
    title,
    modelName,
    creator,
    localPath,
    sourceUrl: firstNAMString(
      activePreview.sourceUrl,
      savedMetadata.sourceUrl,
      savedTone.sourceUrl,
      installedRecord.sourceUrl,
      catalogTone.url,
      catalogTone.sourceUrl,
      catalogTone.source_url,
      catalogModel.sourceUrl,
      catalogModel.source_url,
      latestMetadata.sourceUrl,
      latestMetadata.source_url,
      lastSeenMetadata.sourceUrl,
      lastSeenMetadata.source_url,
    ),
    license: firstNAMString(
      activePreview.license,
      savedMetadata.license,
      savedTone.license,
      installedRecord.license,
      catalogTone.license,
      catalogModel.license,
      catalogModel.license_name,
      latestMetadata.license,
      latestMetadata.license_name,
      lastSeenMetadata.license,
      lastSeenMetadata.license_name,
    ),
    toneId: firstNAMNumber(
      activePreview.toneId,
      savedTone.toneId,
      installedRecord.toneId,
      catalogTone.id,
      catalogTone.toneId,
      catalogModel.tone_id,
      catalogModel.toneId,
    ),
    modelId: firstNAMNumber(
      activePreview.modelId,
      savedTone.modelId,
      installedRecord.modelId,
      catalogModel.id,
      catalogModel.model_id,
    ),
  };
}

export function namHardwareDisplayName(value: string | undefined | null, fallback = "") {
  const base = firstNAMDisplayName(value, fallback).trim();
  if (!base) return "";
  return base
    .replace(/\s+\bA[12]\b$/i, "")
    .replace(/\bClean\s+Twin\s+Style\b/i, "Clean Twin-style")
    .replace(/\bStudio\s+2X12\s+Open\s+IR\b/i, "2x12 Blackface")
    .replace(/\s+/g, " ")
    .trim();
}
