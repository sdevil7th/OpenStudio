import type { TONE3000ToneOrigin } from "../components/TONE3000Branding";

const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const first = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() || "";

export function tone3000OriginFromRecord(value: unknown): TONE3000ToneOrigin | undefined {
  const record = recordOf(value);
  const metadata = recordOf(record.lastSeenMetadata);
  const provider = first(record.sourceProvider, record.source).toLowerCase();
  const sourceUrl = first(record.sourceUrl, metadata.sourceUrl, metadata.source_url);
  let officialSource = false;
  try { const url = new URL(sourceUrl); officialSource = url.protocol === "https:" && (url.hostname === "www.tone3000.com" || url.hostname === "tone3000.com"); } catch { /* local captures have no provider URL */ }
  if (provider !== "tone3000" && !officialSource) return undefined;
  return {
    toneId: Number(record.toneId || metadata.toneId || metadata.tone_id) || undefined,
    title: first(record.toneTitle, metadata.toneTitle, metadata.tone_title, record.name, record.title) || "TONE3000 tone",
    imageUrl: first(record.imageUrl, metadata.imageUrl, metadata.image_url) || undefined,
    creator: first(record.creator, metadata.creator),
    gear: first(record.gearType, metadata.gearType, metadata.gear),
    format: first(record.format, metadata.format).toLowerCase() === "ir" || /\.(wav|aiff?|flac)$/i.test(first(record.localPath)) ? "IR" : "NAM",
  };
}
