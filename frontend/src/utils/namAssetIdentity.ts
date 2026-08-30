import type { NAMInstalledModel, NAMProjectAssetTarget } from "../services/NativeBridge";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function normalizeNAMAssetChecksum(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase().replace(/^sha256[:=]/, "").trim();
  return SHA256_HEX.test(normalized) ? normalized : "";
}

export function stableNAMAssetId(asset: Partial<NAMInstalledModel & NAMProjectAssetTarget>): string {
  const checksum = normalizeNAMAssetChecksum(asset.fileSha256 ?? asset.checksum);
  if (checksum) return `sha256:${checksum}`;

  const provider = String(asset.sourceProvider || asset.source || "tone3000").trim().toLowerCase();
  const modelId = Number(asset.modelId || 0);
  if (modelId > 0) return `${provider || "tone3000"}:model:${modelId}`;

  const toneId = Number(asset.toneId || 0);
  const architecture = String(asset.architecture ?? "").trim().toLowerCase();
  if (toneId > 0 && architecture) return `${provider || "tone3000"}:tone:${toneId}:arch:${architecture}`;
  return "";
}

export function withStableNAMAssetIdentity<T extends Record<string, unknown>>(asset: T): T & {
  assetId?: string;
  checksum?: string;
} {
  const checksum = normalizeNAMAssetChecksum(asset.fileSha256 ?? asset.checksum);
  const assetId = stableNAMAssetId({ ...asset, checksum } as Partial<NAMInstalledModel & NAMProjectAssetTarget>);
  return {
    ...asset,
    ...(checksum ? { checksum } : {}),
    ...(assetId ? { assetId } : {}),
  };
}

export function NAMAssetIdentityKeys(asset: Partial<NAMInstalledModel & NAMProjectAssetTarget>): string[] {
  const keys: string[] = [];
  const assetId = String(asset.assetId || stableNAMAssetId(asset)).trim().toLowerCase();
  if (assetId) keys.push(assetId);

  const checksum = normalizeNAMAssetChecksum(asset.fileSha256 ?? asset.checksum);
  if (checksum && !keys.includes(`sha256:${checksum}`)) keys.push(`sha256:${checksum}`);

  const modelId = Number(asset.modelId || 0);
  if (modelId > 0) keys.push(`model:${modelId}`);

  const toneId = Number(asset.toneId || 0);
  const architecture = String(asset.architecture ?? "").trim().toLowerCase();
  if (toneId > 0 && architecture) keys.push(`tone:${toneId}:arch:${architecture}`);
  return [...new Set(keys)];
}

export function findNAMAssetByIdentity<T extends Partial<NAMInstalledModel>>(
  records: readonly T[],
  asset: Partial<NAMInstalledModel & NAMProjectAssetTarget>,
): T | undefined {
  const wantedChecksum = normalizeNAMAssetChecksum(asset.fileSha256 ?? asset.checksum);
  if (wantedChecksum) {
    return records.find((record) =>
      normalizeNAMAssetChecksum(record.fileSha256 ?? record.checksum) === wantedChecksum);
  }

  const wanted = new Set(NAMAssetIdentityKeys(asset));
  if (wanted.size === 0) return undefined;
  return records.find((record) => NAMAssetIdentityKeys(record).some((key) => wanted.has(key)));
}
