import { describe, expect, it } from "vitest";
import {
  findNAMAssetByIdentity,
  NAMAssetIdentityKeys,
  normalizeNAMAssetChecksum,
  stableNAMAssetId,
  withStableNAMAssetIdentity,
} from "../utils/namAssetIdentity";

const HASH = "a".repeat(64);

describe("portable NAM asset identity", () => {
  it("normalizes supported SHA-256 spellings and rejects malformed values", () => {
    expect(normalizeNAMAssetChecksum(`SHA256:${HASH.toUpperCase()}`)).toBe(HASH);
    expect(normalizeNAMAssetChecksum(`sha256=${HASH}`)).toBe(HASH);
    expect(normalizeNAMAssetChecksum("abc")).toBe("");
  });

  it("prefers file content identity over provider identifiers", () => {
    expect(stableNAMAssetId({ checksum: HASH, modelId: 42 })).toBe(`sha256:${HASH}`);
    expect(stableNAMAssetId({ sourceProvider: "TONE3000", modelId: 42 })).toBe("tone3000:model:42");
  });

  it("finds a moved library record by checksum without relying on its path", () => {
    const records = [
      { localPath: "D:/NAM/new-version.nam", checksum: "c".repeat(64), modelId: 42 },
      { localPath: "D:/NAM/moved.nam", checksum: HASH, modelId: 42 },
      { localPath: "D:/NAM/other.nam", checksum: "b".repeat(64), modelId: 99 },
    ];
    expect(findNAMAssetByIdentity(records, {
      path: "C:/old/capture.nam",
      checksum: HASH,
    } as any)?.localPath).toBe("D:/NAM/moved.nam");
  });

  it("persists a canonical asset id and non-duplicated lookup keys", () => {
    const identified = withStableNAMAssetIdentity({ checksum: `sha256:${HASH}`, modelId: 7 });
    expect(identified.assetId).toBe(`sha256:${HASH}`);
    expect(NAMAssetIdentityKeys(identified)).toEqual([`sha256:${HASH}`, "model:7"]);
  });
});
