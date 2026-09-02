import type { RenderSource } from "../store/useDAWStore";

export interface RenderWildcardContext {
  projectName?: string;
  trackName?: string;
  index?: number;
  regionName?: string;
}

export function resolveRenderWildcards(
  template: string,
  context: RenderWildcardContext,
  now = new Date(),
): string {
  let result = template;
  result = result.replace(/\$project/g, context.projectName || "untitled");
  result = result.replace(/\$track/g, context.trackName || "");
  result = result.replace(/\$region/g, context.regionName || "");
  result = result.replace(/\$date/g, now.toISOString().slice(0, 10));
  result = result.replace(/\$time/g, now.toTimeString().slice(0, 8).replace(/:/g, "-"));
  result = result.replace(
    /\$index/g,
    context.index !== undefined ? String(context.index).padStart(2, "0") : "",
  );
  return result.replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export interface RenderOutputCountInput {
  source: RenderSource;
  trackCount: number;
  selectedTrackCount: number;
  razorEditCount: number;
  rangeCount: number;
}

export function countRenderOutputs({
  source,
  trackCount,
  selectedTrackCount,
  razorEditCount,
  rangeCount,
}: RenderOutputCountInput): number {
  const safeRangeCount = Math.max(1, rangeCount);
  if (source === "stems") return (trackCount + 1) * safeRangeCount;
  if (source === "selected_tracks") return Math.max(1, selectedTrackCount) * safeRangeCount;
  if (source === "razor") return Math.max(1, razorEditCount);
  return safeRangeCount;
}

/** Reserve a case-insensitive output path within one render batch. */
export function reserveUniqueRenderPath(
  desiredPath: string,
  suffix: string,
  reservedPaths: Set<string>,
): string {
  const key = desiredPath.toLowerCase();
  if (!reservedPaths.has(key)) {
    reservedPaths.add(key);
    return desiredPath;
  }

  const lastSeparator = Math.max(desiredPath.lastIndexOf("/"), desiredPath.lastIndexOf("\\"));
  const extensionIndex = desiredPath.lastIndexOf(".");
  const hasExtension = extensionIndex > lastSeparator;
  const stem = hasExtension ? desiredPath.slice(0, extensionIndex) : desiredPath;
  const extension = hasExtension ? desiredPath.slice(extensionIndex) : "";
  const safeSuffix = suffix.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "render";

  let index = 1;
  let candidate = `${stem}-${safeSuffix}${extension}`;
  while (reservedPaths.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${stem}-${safeSuffix}-${index}${extension}`;
  }
  reservedPaths.add(candidate.toLowerCase());
  return candidate;
}
