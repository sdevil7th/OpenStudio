export const NAM_KNOB_FRAME_COUNT = 121;
export const NAM_KNOB_ATLAS_COLUMNS = 11;
export const NAM_KNOB_FRAME_SIZE = 192;

export type NAMControlAssetId =
  | "knobBlack"
  | "knobMetal"
  | "knobCream";

type NAMControlAssetBase = {
  id: NAMControlAssetId;
  href: string;
  width: number;
  height: number;
  anchor: {
    x: number;
    y: number;
  };
};

export type NAMKnobAtlasAsset = NAMControlAssetBase & {
  kind: "knobAtlas";
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  columns: number;
};

export type NAMControlAsset = NAMKnobAtlasAsset;

const knobAtlas = (id: NAMControlAssetId, href: string): NAMKnobAtlasAsset => ({
  id,
  kind: "knobAtlas",
  href,
  width: NAM_KNOB_FRAME_SIZE * NAM_KNOB_ATLAS_COLUMNS,
  height: NAM_KNOB_FRAME_SIZE * Math.ceil(NAM_KNOB_FRAME_COUNT / NAM_KNOB_ATLAS_COLUMNS),
  frameWidth: NAM_KNOB_FRAME_SIZE,
  frameHeight: NAM_KNOB_FRAME_SIZE,
  frameCount: NAM_KNOB_FRAME_COUNT,
  columns: NAM_KNOB_ATLAS_COLUMNS,
  anchor: { x: 0.5, y: 0.5 },
});

export const NAM_CONTROL_ASSETS = {
  knobBlack: knobAtlas("knobBlack", new URL("../assets/nam/controls/knob-black-atlas.webp", import.meta.url).href),
  knobMetal: knobAtlas("knobMetal", new URL("../assets/nam/controls/knob-metal-atlas.webp", import.meta.url).href),
  knobCream: knobAtlas("knobCream", new URL("../assets/nam/controls/knob-cream-atlas.webp", import.meta.url).href),
} as const satisfies Record<NAMControlAssetId, NAMControlAsset>;

export const NAM_REQUIRED_CONTROL_ASSET_IDS: NAMControlAssetId[] = [
  "knobBlack",
  "knobMetal",
  "knobCream",
];

export function requireNAMControlAsset<T extends NAMControlAssetId>(assetId: T): (typeof NAM_CONTROL_ASSETS)[T] {
  const asset = NAM_CONTROL_ASSETS[assetId];
  if (!asset?.href) {
    throw new Error(`Missing required NAM control asset: ${assetId}`);
  }
  return asset;
}

export function knobFrameIndex(pct: number, frameCount = NAM_KNOB_FRAME_COUNT) {
  const normalized = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0.5;
  return Math.round(normalized * (frameCount - 1));
}

export function knobAtlasFrame(asset: NAMKnobAtlasAsset, frameIndex: number) {
  const safeFrame = Math.min(asset.frameCount - 1, Math.max(0, frameIndex));
  return {
    index: safeFrame,
    column: safeFrame % asset.columns,
    row: Math.floor(safeFrame / asset.columns),
  };
}

export function knobAssetForVariant(variant?: string): NAMKnobAtlasAsset {
  if (variant === "metal" || variant === "white" || variant === "panel") return requireNAMControlAsset("knobMetal");
  if (variant === "warning") return requireNAMControlAsset("knobCream");
  return requireNAMControlAsset("knobBlack");
}
