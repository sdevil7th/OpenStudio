export type NAMRackAmpCaptureCandidate = {
  localPath: string;
  name?: string;
  toneTitle?: string;
  creator?: string;
  gearType?: string;
  favorite?: boolean;
  missing?: boolean;
  installedAt?: string;
  updatedAt?: string;
  lastUsed?: number;
};

export type NAMRackRankedAmpCapture = NAMRackAmpCaptureCandidate & {
  active: boolean;
  presetUsageCount: number;
};

export function normalizeNAMRackCapturePath(path: string | undefined): string {
  return String(path ?? "").trim().replace(/\\/g, "/").toLocaleLowerCase();
}

function captureTitle(capture: NAMRackAmpCaptureCandidate): string {
  const pathName = capture.localPath.split(/[\\/]/).pop() ?? "";
  return capture.toneTitle?.trim()
    || capture.name?.trim()
    || pathName.replace(/\.nam$/i, "")
    || "Installed Amp Capture";
}

function captureDate(capture: NAMRackAmpCaptureCandidate): number {
  return capture.lastUsed
    || Date.parse(capture.updatedAt ?? capture.installedAt ?? "")
    || 0;
}

export function rankNAMRackAmpCaptures(
  captures: readonly NAMRackAmpCaptureCandidate[],
  presetAmpPaths: readonly (string | undefined)[],
  activeAmpPath: string | undefined,
): NAMRackRankedAmpCapture[] {
  const usageByPath = new Map<string, number>();
  for (const path of presetAmpPaths) {
    const normalizedPath = normalizeNAMRackCapturePath(path);
    if (!normalizedPath) continue;
    usageByPath.set(normalizedPath, (usageByPath.get(normalizedPath) ?? 0) + 1);
  }

  const normalizedActivePath = normalizeNAMRackCapturePath(activeAmpPath);
  return captures
    .filter((capture) => {
      if (!capture.localPath.trim()) return false;
      const gearType = String(capture.gearType ?? "").toLocaleLowerCase();
      return gearType.length === 0 || gearType.includes("amp") || gearType.includes("rig");
    })
    .map((capture) => {
      const normalizedPath = normalizeNAMRackCapturePath(capture.localPath);
      return {
        ...capture,
        active: Boolean(normalizedActivePath && normalizedPath === normalizedActivePath),
        presetUsageCount: usageByPath.get(normalizedPath) ?? 0,
      };
    })
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.presetUsageCount !== right.presetUsageCount) {
        return right.presetUsageCount - left.presetUsageCount;
      }
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      const dateDifference = captureDate(right) - captureDate(left);
      if (dateDifference !== 0) return dateDifference;
      return captureTitle(left).localeCompare(captureTitle(right), undefined, { sensitivity: "base" });
    });
}

export type NAMRackRankedCabIR = NAMRackAmpCaptureCandidate & {
  active: boolean;
};

export function rankNAMRackCabIRs(
  assets: readonly NAMRackAmpCaptureCandidate[],
  activeIRPath: string | undefined,
): NAMRackRankedCabIR[] {
  const assetsByPath = new Map<string, NAMRackAmpCaptureCandidate>();
  for (const asset of assets) {
    const normalizedPath = normalizeNAMRackCapturePath(asset.localPath);
    if (!normalizedPath) continue;
    const gearType = String(asset.gearType ?? "").toLocaleLowerCase();
    const looksLikeIR = gearType.includes("ir")
      || gearType.includes("cab")
      || /\.(wav|wave|aif|aiff|flac)$/i.test(asset.localPath);
    if (!looksLikeIR) continue;
    const existing = assetsByPath.get(normalizedPath);
    assetsByPath.set(normalizedPath, {
      ...existing,
      ...asset,
      favorite: Boolean(existing?.favorite || asset.favorite),
      lastUsed: Math.max(existing?.lastUsed ?? 0, asset.lastUsed ?? 0),
    });
  }

  const normalizedActivePath = normalizeNAMRackCapturePath(activeIRPath);
  return [...assetsByPath.entries()]
    .map(([normalizedPath, asset]) => ({
      ...asset,
      active: Boolean(normalizedActivePath && normalizedPath === normalizedActivePath),
    }))
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      const dateDifference = captureDate(right) - captureDate(left);
      if (dateDifference !== 0) return dateDifference;
      return captureTitle(left).localeCompare(captureTitle(right), undefined, { sensitivity: "base" });
    });
}
